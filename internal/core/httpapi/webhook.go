package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 通知通道（webhook）：用户显式配置的**出站推送**，不是内置遥测（G-10）。
//
// 设计约束：
//   - 出站只由告警事件触发（recordAlert → dispatchAlert 的短命 goroutine），
//     没有 ticker / AfterFunc / 常驻 goroutine（G-19）；空闲出站恒 0；
//   - URL 与密钥只来自管理 API 的用户提交，源码无硬编码出站地址；
//   - 日志只记 URL 的 scheme+host 与状态码，不记完整 URL / header / body（G-30）；
//   - 配置存在进程内存，重启即清空（非持久化，UI 明示；M3 可接 bbolt）；
//   - 重试有限（最多 webhookMaxAttempts 次，间隔递增且总时长 <1s），不无限重试。
//
// 显式 schema（G-24）：事件类型受控词表与告警 source 同源，不使用 object/any。

const (
	webhookPath            = "/api/v1/webhook"
	webhookMaxTargets      = 16
	webhookMaxAttempts     = 3
	webhookRetryBaseMs     = 100
	webhookTimeout         = 3 * time.Second
	webhookMaxURLRunes     = 2048
	webhookMaxSecretRunes  = 256
	webhookMaxHistoryItems = 200
	webhookMaxPayloadBytes = 8 << 10
)

// webhookEvents 是可选事件类型（受控词表，与 AlertView.Source 同源）。
var webhookEvents = map[string]bool{
	alertSourceAudit: true, alertSourcePlugin: true,
	alertSourceResource: true, alertSourceSlot: true,
}

// WebhookTarget 是用户配置的一条出站通道（对外显式字段，G-24）。
// URL/Secret 对外只读返回掩码，不回传明文（G-30）。
type WebhookTarget struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	SecretSet bool     `json:"secret_set"`
	Enabled   bool     `json:"enabled"`
}

// webhookStored 是内部存储态：Secret 明文只在进程内存，绝不进日志/JSON。
type webhookStored struct {
	WebhookTarget
	Secret string
}

// webhookDelivery 是一次投递结果（站内可查；不含 URL/密钥明文）。
type webhookDelivery struct {
	ID        string `json:"id"`
	TargetID  string `json:"target_id"`
	Event     string `json:"event"`
	Attempts  int    `json:"attempts"`
	Status    string `json:"status"` // ok / failed
	HTTPCode  int    `json:"http_code,omitempty"`
	Err       string `json:"err,omitempty"`
	At        string `json:"at"`
	TargetRef string `json:"target_ref"` // scheme://host，脱敏
}

// webhookListBody / webhookHistoryBody 是列表响应（显式字段）。
type webhookListBody struct {
	Targets []WebhookTarget   `json:"targets"`
	History []webhookDelivery `json:"history"`
}

// webhookWriteBody 是配置写请求体（显式字段，G-24）。
type webhookWriteBody struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Secret string   `json:"secret,omitempty"`
}

// webhookTestBody 是测试按钮请求体：可选事件名，不传用 info 测试事件。
type webhookTestBody struct {
	Event string `json:"event,omitempty"`
}

// webhookRegistry 是内存态配置与投递历史；互斥保护，零常驻 goroutine。
type webhookRegistry struct {
	mu      sync.RWMutex
	targets map[string]*webhookStored
	order   []string
	history []webhookDelivery
	seq     atomic.Uint64
}

func newWebhookRegistry() *webhookRegistry {
	return &webhookRegistry{targets: make(map[string]*webhookStored)}
}

// add 校验显式 schema 后写入；返回对外视图（URL 掩码）。
func (reg *webhookRegistry) add(in webhookWriteBody) (WebhookTarget, error) {
	cleanURL, hostRef, err := validateWebhookURL(in.URL)
	if err != nil {
		return WebhookTarget{}, err
	}
	events, err := validateWebhookEvents(in.Events)
	if err != nil {
		return WebhookTarget{}, err
	}
	if len([]rune(in.Secret)) > webhookMaxSecretRunes {
		return WebhookTarget{}, fmt.Errorf("secret 超过 %d 字符", webhookMaxSecretRunes)
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.targets) >= webhookMaxTargets {
		return WebhookTarget{}, fmt.Errorf("最多配置 %d 条通知通道", webhookMaxTargets)
	}
	id := fmt.Sprintf("wh-%d", reg.seq.Add(1))
	st := &webhookStored{
		WebhookTarget: WebhookTarget{
			ID: id, URL: cleanURL, Events: events, SecretSet: in.Secret != "", Enabled: true,
		},
		Secret: in.Secret,
	}
	reg.targets[id] = st
	reg.order = append(reg.order, id)
	_ = hostRef // hostRef 仅用于日志，不在存储中重复保存
	view := st.WebhookTarget
	view.Events = append([]string(nil), events...)
	return view, nil
}

func (reg *webhookRegistry) remove(id string) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if _, ok := reg.targets[id]; !ok {
		return false
	}
	delete(reg.targets, id)
	for i, v := range reg.order {
		if v == id {
			reg.order = append(reg.order[:i], reg.order[i+1:]...)
			break
		}
	}
	return true
}

func (reg *webhookRegistry) list() webhookListBody {
	reg.mu.RLock()
	defer reg.mu.RUnlock()
	out := webhookListBody{
		Targets: make([]WebhookTarget, 0, len(reg.order)),
		History: make([]webhookDelivery, 0, len(reg.history)),
	}
	for _, id := range reg.order {
		st := reg.targets[id]
		if st == nil {
			continue
		}
		v := st.WebhookTarget
		v.Events = append([]string(nil), st.Events...)
		out.Targets = append(out.Targets, v)
	}
	out.History = append(out.History, reg.history...)
	return out
}

func (reg *webhookRegistry) record(d webhookDelivery) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.history = append(reg.history, d)
	if len(reg.history) > webhookMaxHistoryItems {
		reg.history = append([]webhookDelivery(nil), reg.history[len(reg.history)-webhookMaxHistoryItems:]...)
	}
}

// validateWebhookURL 只接受 http/https 绝对 URL；拒绝空 host、凭据内嵌、控制字符。
// 返回规范化 URL 与脱敏 hostRef（scheme://host），明文 URL 不进任何日志。
func validateWebhookURL(raw string) (string, string, error) {
	if len([]rune(raw)) == 0 || len([]rune(raw)) > webhookMaxURLRunes {
		return "", "", fmt.Errorf("URL 长度须在 1..%d 字符", webhookMaxURLRunes)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", fmt.Errorf("URL 格式无效")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", "", fmt.Errorf("URL 只支持 http:// 或 https://")
	}
	if u.Host == "" || u.User != nil || strings.ContainsAny(raw, "\r\n\t ") {
		return "", "", fmt.Errorf("URL 不得含凭据、空白或空主机名")
	}
	return u.String(), u.Scheme + "://" + u.Host, nil
}

func validateWebhookEvents(events []string) ([]string, error) {
	if len(events) == 0 || len(events) > len(webhookEvents) {
		return nil, fmt.Errorf("请至少选择一种事件类型")
	}
	out := make([]string, 0, len(events))
	seen := make(map[string]bool, len(events))
	for _, e := range events {
		if !webhookEvents[e] {
			return nil, fmt.Errorf("事件类型须为 audit/plugin/resource/slot")
		}
		if !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	sort.Strings(out)
	return out, nil
}

// webhookEventMatches 判断一条通道是否订阅了某事件。
func webhookEventMatches(events []string, event string) bool {
	for _, e := range events {
		if e == event {
			return true
		}
	}
	return false
}

// webhookPayload 是出站 JSON（显式字段；不含目标 URL/密钥）。
type webhookPayload struct {
	Source string `json:"source"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Time   string `json:"time"`
	Test   bool   `json:"test"`
}

// dispatchAlert 由 recordAlert 在告警落库后调用：只为订阅该事件的通道投递。
// 投递在**短命 goroutine**里同步完成（无 ticker/AfterFunc/常驻协程），
// 单次包含有限重试；错误记入内存历史并打脱敏 WARN（G-30）。
func (reg *webhookRegistry) dispatchAlert(event, title, detail string) {
	if reg == nil {
		return
	}
	reg.mu.RLock()
	targets := make([]*webhookStored, 0)
	for _, id := range reg.order {
		st := reg.targets[id]
		if st != nil && st.Enabled && webhookEventMatches(st.Events, event) {
			targets = append(targets, st)
		}
	}
	reg.mu.RUnlock()
	for _, st := range targets {
		go reg.deliver(st, event, title, detail, false)
	}
}

// deliver 做一次投递（含有限重试）；被 dispatchAlert 与测试端点共用。
func (reg *webhookRegistry) deliver(st *webhookStored, event, title, detail string, isTest bool) {
	payload := webhookPayload{
		Source: event, Title: title, Detail: detail,
		Time: time.Now().UTC().Format(time.RFC3339Nano), Test: isTest,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if len(body) > webhookMaxPayloadBytes {
		body = body[:webhookMaxPayloadBytes]
	}
	// hostRef 仅用于日志与历史（scheme://host），绝不记完整 URL 或 header。
	_, hostRef, _ := validateWebhookURL(st.URL)
	status, code, attempts, lastErr := reg.postWithRetry(st, body)
	statusText := "ok"
	if status != "ok" {
		statusText = "failed"
		slog.Warn("通知通道投递失败", "target", st.ID, "host", hostRef,
			"event", event, "attempts", attempts, "code", code, "err", lastErr)
	}
	msg := ""
	if lastErr != nil {
		msg = lastErr.Error()
	}
	reg.record(webhookDelivery{
		ID: fmt.Sprintf("d-%d", reg.seq.Add(1)), TargetID: st.ID, Event: event,
		Attempts: attempts, Status: statusText, HTTPCode: code,
		Err: msg, At: time.Now().UTC().Format(time.RFC3339Nano), TargetRef: hostRef,
	})
}

// postWithRetry 最多 webhookMaxAttempts 次；每次请求级 context 均 defer cancel，
// 重试等待用 time.NewTimer + defer Stop（G-19：无常驻定时器）。
func (reg *webhookRegistry) postWithRetry(st *webhookStored, body []byte) (string, int, int, error) {
	var lastErr error
	var code int
	for attempt := 1; attempt <= webhookMaxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), webhookTimeout)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, st.URL, bytes.NewReader(body))
		if err != nil {
			cancel()
			lastErr = fmt.Errorf("构造请求失败")
			break
		}
		req.Header.Set("Content-Type", "application/json")
		if st.Secret != "" {
			// 密钥经 header 传出，绝不写日志；名字固定，不拼接用户输入。
			req.Header.Set("X-Kore-Webhook-Token", st.Secret)
		}
		resp, err := webhookHTTPClient.Do(req)
		if err == nil {
			code = resp.StatusCode
			drain := make([]byte, 64)
			_, _ = resp.Body.Read(drain)
			_ = resp.Body.Close()
			cancel()
			if code >= 200 && code < 300 {
				return "ok", code, attempt, nil
			}
			lastErr = fmt.Errorf("上游返回 HTTP %d", code)
		} else {
			cancel()
			lastErr = err
		}
		if attempt < webhookMaxAttempts {
			timer := time.NewTimer(time.Duration(webhookRetryBaseMs*attempt) * time.Millisecond)
			<-timer.C
			timer.Stop()
		}
	}
	return "failed", code, webhookMaxAttempts, lastErr
}

// webhookHTTPClient 是专用短超时客户端；不跟随重定向（防 SSRF 跳转到内网地址）。
var webhookHTTPClient = &http.Client{
	Timeout: webhookTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}
