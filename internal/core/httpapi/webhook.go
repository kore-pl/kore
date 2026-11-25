package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 通知通道（webhook / 邮件 / IM 机器人）：用户显式配置的**出站推送**，不是内置遥测（G-10）。
//
// 设计约束：
//   - 出站只由告警事件触发（recordAlert → dispatchAlert 的短命 goroutine），
//     没有 ticker / AfterFunc / 常驻 goroutine（G-19）；空闲出站恒 0；
//   - URL / 密钥 / SMTP 口令只来自管理 API 的用户提交，源码无硬编码出站地址；
//   - 日志只记 scheme://host 与状态码，不记完整 URL / header / body / 口令（G-30）；
//   - 配置存在进程内存，重启即清空（非持久化，UI 明示；M3 可接 bbolt）；
//   - 新建通道默认**未启用**，必须先测试再手动启用（外发默认关闭、可随时关闭）；
//   - 重试有限（最多 channelMaxAttempts 次，间隔递增且总时长 <1s），不无限重试。
//
// 显式 schema（G-24）：事件类型 / 级别 / 通道类型均为受控词表，不使用 object/any。

const (
	webhookPath             = "/api/v1/webhook"
	channelMaxTargets       = 16
	channelMaxAttempts      = 3
	channelRetryBaseMs      = 100
	channelHTTPTimeout      = 3 * time.Second
	channelSMTPTimeout      = 8 * time.Second
	channelMaxURLRunes      = 2048
	channelMaxSecretRunes   = 256
	channelMaxHistoryItems  = 200
	channelMaxPayloadBytes  = 8 << 10
	channelMaxNameRunes     = 64
	channelMaxHeaders       = 8
	channelMaxHeaderRunes   = 64
	channelMaxHeaderVRunes  = 512
	channelMaxTemplateRunes = 2048
	channelMaxRecipients    = 10
	channelMaxMailRunes     = 254
	channelMaxHostRunes     = 253
	channelMaxUserRunes     = 128
	channelMaxPasswordRunes = 256
)

// 通道类型（受控词表）。
const (
	channelKindWebhook = "webhook"
	channelKindEmail   = "email"
	channelKindIM      = "im"
)

// IM 机器人类型（受控词表）。
const (
	imKindWeCom    = "wecom"
	imKindDingTalk = "dingtalk"
	imKindFeishu   = "feishu"
)

// SMTP 加密方式（受控词表）。
const (
	smtpTLSStartTLS = "starttls"
	smtpTLSImplicit = "ssl"
	smtpTLSNone     = "none"
)

// webhookEvents 是可选事件类型（受控词表，与 AlertView.Source 同源）。
var webhookEvents = map[string]bool{
	alertSourceAudit: true, alertSourcePlugin: true,
	alertSourceResource: true, alertSourceSlot: true,
}

// channelSeverities 是可选告警级别（与 AlertView.Severity 同源）。
var channelSeverities = map[string]bool{
	alertSeverityCritical: true, alertSeverityWarning: true, alertSeverityInfo: true,
}

// channelIMKinds 是可选 IM 机器人类型。
var channelIMKinds = map[string]bool{
	imKindWeCom: true, imKindDingTalk: true, imKindFeishu: true,
}

// channelHeaderDeny 是不可由用户自定义的请求头（逐跳头 / 会破坏请求本身）。
var channelHeaderDeny = map[string]bool{
	"host": true, "content-length": true, "transfer-encoding": true,
	"connection": true, "upgrade": true, "te": true, "trailer": true,
}

// ChannelHeader 是一条自定义请求头（webhook 通道；显式字段，G-24）。
type ChannelHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// ChannelEmail 是邮件通道的对外配置（口令只回 password_set，绝不回明文）。
type ChannelEmail struct {
	Host        string   `json:"host"`
	Port        int      `json:"port"`
	TLS         string   `json:"tls"`
	User        string   `json:"user,omitempty"`
	From        string   `json:"from"`
	Recipients  []string `json:"recipients"`
	PasswordSet bool     `json:"password_set"`
}

// ChannelIM 是 IM 机器人通道的对外配置（加签密钥只回 secret_set）。
type ChannelIM struct {
	Kind      string `json:"kind"`
	SecretSet bool   `json:"secret_set"`
}

// ChannelTarget 是一条用户配置的出站通道（对外显式字段，G-24）。
// 密钥 / 口令只回对应的 set 布尔，不回传明文（G-30）。
type ChannelTarget struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	Name       string          `json:"name"`
	Enabled    bool            `json:"enabled"`
	Events     []string        `json:"events"`
	Severities []string        `json:"severities"`
	URL        string          `json:"url,omitempty"`
	Headers    []ChannelHeader `json:"headers,omitempty"`
	Template   string          `json:"template,omitempty"`
	SecretSet  bool            `json:"secret_set"`
	Email      *ChannelEmail   `json:"email,omitempty"`
	IM         *ChannelIM      `json:"im,omitempty"`
}

// channelStored 是内部存储态：明文密钥只在进程内存，绝不进日志/JSON。
type channelStored struct {
	view   ChannelTarget
	secret string // webhook 请求头密钥 / IM 加签密钥 / SMTP 口令
}

// channelDelivery 是一次投递结果（站内可查；不含 URL/密钥明文）。
type channelDelivery struct {
	ID        string `json:"id"`
	TargetID  string `json:"target_id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Event     string `json:"event"`
	Severity  string `json:"severity"`
	Attempts  int    `json:"attempts"`
	Status    string `json:"status"`
	HTTPCode  int    `json:"http_code,omitempty"`
	Err       string `json:"err,omitempty"`
	At        string `json:"at"`
	TargetRef string `json:"target_ref"`
}

// webhookListBody 是列表响应（显式字段）。
type webhookListBody struct {
	Targets []ChannelTarget   `json:"targets"`
	History []channelDelivery `json:"history"`
}

// channelEmailWrite 是邮件通道的写请求体（含口令明文，只经请求体传入）。
type channelEmailWrite struct {
	Host       string   `json:"host"`
	Port       int      `json:"port"`
	TLS        string   `json:"tls"`
	User       string   `json:"user"`
	Password   string   `json:"password"`
	From       string   `json:"from"`
	Recipients []string `json:"recipients"`
}

// webhookWriteBody 是配置写请求体（显式字段，G-24）。
// Kind 缺省按 webhook 处理，兼容旧版「只有 URL + 事件 + 密钥」的请求。
type webhookWriteBody struct {
	Kind       string             `json:"kind"`
	Name       string             `json:"name"`
	Events     []string           `json:"events"`
	Severities []string           `json:"severities"`
	URL        string             `json:"url"`
	Secret     string             `json:"secret"`
	Headers    []ChannelHeader    `json:"headers"`
	Template   string             `json:"template"`
	IMKind     string             `json:"im_kind"`
	Email      *channelEmailWrite `json:"email"`
}

// webhookUpdateBody 是启停请求体（显式字段）。
type webhookUpdateBody struct {
	Enabled bool `json:"enabled"`
}

// webhookTestBody 是测试按钮请求体：可选事件名，不传用 info 测试事件。
type webhookTestBody struct {
	Event string `json:"event,omitempty"`
}

// webhookPayload 是出站 JSON 的默认模板（显式字段；不含目标 URL/密钥）。
// 用户配置了 template 时按模板渲染，字段名可自定。
type webhookPayload struct {
	Source   string `json:"source"`
	Severity string `json:"severity"`
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Time     string `json:"time"`
	Test     bool   `json:"test"`
}

// channelKindLabel 返回通道类型的中文名（默认名称 / 历史展示用）。
func channelKindLabel(kind, imKind string) string {
	switch kind {
	case channelKindEmail:
		return "邮件"
	case channelKindIM:
		switch imKind {
		case imKindWeCom:
			return "企业微信机器人"
		case imKindDingTalk:
			return "钉钉机器人"
		case imKindFeishu:
			return "飞书机器人"
		}
		return "IM 机器人"
	default:
		return "Webhook"
	}
}

// webhookRegistry 是内存态配置与投递历史；互斥保护，零常驻 goroutine。
type webhookRegistry struct {
	mu      sync.RWMutex
	targets map[string]*channelStored
	order   []string
	history []channelDelivery
	seq     atomic.Uint64
}

func newWebhookRegistry() *webhookRegistry {
	return &webhookRegistry{targets: make(map[string]*channelStored)}
}

// add 校验显式 schema 后写入；返回对外视图（密钥 / 口令只回 set 标记）。
// 新建通道默认未启用：先测试再启用，外发默认关闭。
func (reg *webhookRegistry) add(in webhookWriteBody) (ChannelTarget, error) {
	kind := strings.TrimSpace(in.Kind)
	if kind == "" {
		kind = channelKindWebhook
	}
	if kind != channelKindWebhook && kind != channelKindEmail && kind != channelKindIM {
		return ChannelTarget{}, fmt.Errorf("通道类型须为 webhook / email / im")
	}
	name := strings.TrimSpace(in.Name)
	if len([]rune(name)) > channelMaxNameRunes {
		return ChannelTarget{}, fmt.Errorf("名称最长 %d 个字符", channelMaxNameRunes)
	}
	if hasControlChars(name) {
		return ChannelTarget{}, fmt.Errorf("名称不能包含换行或控制字符")
	}
	events, err := validateWebhookEvents(in.Events)
	if err != nil {
		return ChannelTarget{}, err
	}
	severities, err := validateChannelSeverities(in.Severities)
	if err != nil {
		return ChannelTarget{}, err
	}
	st := &channelStored{view: ChannelTarget{
		Kind: kind, Name: name, Events: events, Severities: severities, Enabled: false,
	}}
	switch kind {
	case channelKindWebhook:
		cleanURL, _, err := validateWebhookURL(in.URL)
		if err != nil {
			return ChannelTarget{}, err
		}
		headers, err := validateChannelHeaders(in.Headers)
		if err != nil {
			return ChannelTarget{}, err
		}
		template, err := validateChannelTemplate(in.Template)
		if err != nil {
			return ChannelTarget{}, err
		}
		if len([]rune(in.Secret)) > channelMaxSecretRunes {
			return ChannelTarget{}, fmt.Errorf("密钥最长 %d 个字符", channelMaxSecretRunes)
		}
		st.view.URL = cleanURL
		st.view.Headers = headers
		st.view.Template = template
		st.view.SecretSet = in.Secret != ""
		st.secret = in.Secret
	case channelKindEmail:
		email, password, err := validateChannelEmail(in.Email)
		if err != nil {
			return ChannelTarget{}, err
		}
		st.view.Email = email
		st.view.SecretSet = password != ""
		st.secret = password
	case channelKindIM:
		cleanURL, _, err := validateWebhookURL(in.URL)
		if err != nil {
			return ChannelTarget{}, err
		}
		imKind := strings.TrimSpace(in.IMKind)
		if imKind == "" {
			return ChannelTarget{}, fmt.Errorf("请选择机器人类型：企业微信 / 钉钉 / 飞书")
		}
		if !channelIMKinds[imKind] {
			return ChannelTarget{}, fmt.Errorf("机器人类型须为 wecom / dingtalk / feishu")
		}
		if len([]rune(in.Secret)) > channelMaxSecretRunes {
			return ChannelTarget{}, fmt.Errorf("加签密钥最长 %d 个字符", channelMaxSecretRunes)
		}
		st.view.URL = cleanURL
		st.view.IM = &ChannelIM{Kind: imKind, SecretSet: in.Secret != ""}
		st.secret = in.Secret
	}
	if st.view.Name == "" {
		imKind := ""
		if st.view.IM != nil {
			imKind = st.view.IM.Kind
		}
		st.view.Name = channelKindLabel(kind, imKind)
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.targets) >= channelMaxTargets {
		return ChannelTarget{}, fmt.Errorf("最多配置 %d 条通知通道", channelMaxTargets)
	}
	id := fmt.Sprintf("ch-%d", reg.seq.Add(1))
	st.view.ID = id
	reg.targets[id] = st
	reg.order = append(reg.order, id)
	return cloneChannelTarget(st.view), nil
}

// updateEnabled 启停一条通道；返回更新后的视图。
func (reg *webhookRegistry) updateEnabled(id string, enabled bool) (ChannelTarget, bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	st := reg.targets[id]
	if st == nil {
		return ChannelTarget{}, false
	}
	st.view.Enabled = enabled
	return cloneChannelTarget(st.view), true
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
		Targets: make([]ChannelTarget, 0, len(reg.order)),
		History: make([]channelDelivery, 0, len(reg.history)),
	}
	for _, id := range reg.order {
		st := reg.targets[id]
		if st == nil {
			continue
		}
		out.Targets = append(out.Targets, cloneChannelTarget(st.view))
	}
	out.History = append(out.History, reg.history...)
	return out
}

// get 返回一条通道的副本（测试端点用）。
func (reg *webhookRegistry) get(id string) (*channelStored, bool) {
	reg.mu.RLock()
	defer reg.mu.RUnlock()
	st := reg.targets[id]
	if st == nil {
		return nil, false
	}
	return &channelStored{view: cloneChannelTarget(st.view), secret: st.secret}, true
}

// cloneChannelTarget 深拷贝切片/指针字段，避免调用方与存储态共享可变内存。
func cloneChannelTarget(v ChannelTarget) ChannelTarget {
	v.Events = append([]string(nil), v.Events...)
	v.Severities = append([]string(nil), v.Severities...)
	v.Headers = append([]ChannelHeader(nil), v.Headers...)
	if v.Email != nil {
		email := *v.Email
		email.Recipients = append([]string(nil), v.Email.Recipients...)
		v.Email = &email
	}
	if v.IM != nil {
		im := *v.IM
		v.IM = &im
	}
	return v
}

func (reg *webhookRegistry) record(d channelDelivery) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.history = append(reg.history, d)
	if len(reg.history) > channelMaxHistoryItems {
		reg.history = append([]channelDelivery(nil), reg.history[len(reg.history)-channelMaxHistoryItems:]...)
	}
}

// validateWebhookURL 只接受 http/https 绝对 URL；拒绝空 host、凭据内嵌、控制字符。
// 返回规范化 URL 与脱敏 hostRef（scheme://host），明文 URL 不进任何日志。
func validateWebhookURL(raw string) (string, string, error) {
	if len([]rune(raw)) == 0 || len([]rune(raw)) > channelMaxURLRunes {
		return "", "", fmt.Errorf("URL 长度须在 1..%d 字符", channelMaxURLRunes)
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
		return nil, fmt.Errorf("请至少选择一种要推送的告警")
	}
	out := make([]string, 0, len(events))
	seen := make(map[string]bool, len(events))
	for _, e := range events {
		if !webhookEvents[e] {
			return nil, fmt.Errorf("告警类型须为 audit/plugin/resource/slot")
		}
		if !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	sort.Strings(out)
	return out, nil
}

// validateChannelSeverities 校验级别；未指定时默认推全部级别（兼容旧请求体）。
func validateChannelSeverities(severities []string) ([]string, error) {
	if len(severities) == 0 {
		return []string{alertSeverityCritical, alertSeverityInfo, alertSeverityWarning}, nil
	}
	if len(severities) > len(channelSeverities) {
		return nil, fmt.Errorf("告警级别最多 %d 项", len(channelSeverities))
	}
	out := make([]string, 0, len(severities))
	seen := make(map[string]bool, len(severities))
	for _, s := range severities {
		if !channelSeverities[s] {
			return nil, fmt.Errorf("告警级别须为 critical/warning/info")
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out, nil
}

func validateChannelHeaders(headers []ChannelHeader) ([]ChannelHeader, error) {
	if len(headers) > channelMaxHeaders {
		return nil, fmt.Errorf("自定义请求头最多 %d 条", channelMaxHeaders)
	}
	out := make([]ChannelHeader, 0, len(headers))
	seen := make(map[string]bool, len(headers))
	for _, h := range headers {
		name := strings.TrimSpace(h.Name)
		if name == "" {
			continue
		}
		if len(name) > channelMaxHeaderRunes || !isHTTPHeaderName(name) {
			return nil, fmt.Errorf("请求头名称无效（只允许字母、数字与 -_ 等符号）")
		}
		lower := strings.ToLower(name)
		if channelHeaderDeny[lower] {
			return nil, fmt.Errorf("请求头 %s 不允许自定义", name)
		}
		value := h.Value
		if len([]rune(value)) > channelMaxHeaderVRunes {
			return nil, fmt.Errorf("请求头 %s 的值过长（上限 %d 字符）", name, channelMaxHeaderVRunes)
		}
		if strings.ContainsAny(value, "\r\n") {
			return nil, fmt.Errorf("请求头 %s 的值不能包含换行", name)
		}
		if seen[lower] {
			return nil, fmt.Errorf("请求头 %s 重复", name)
		}
		seen[lower] = true
		out = append(out, ChannelHeader{Name: name, Value: value})
	}
	return out, nil
}

// isHTTPHeaderName 校验 RFC 7230 token（tchar）。
func isHTTPHeaderName(name string) bool {
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.', r == '!', r == '#', r == '$', r == '%',
			r == '&', r == '\'', r == '*', r == '+', r == '^', r == '`', r == '|', r == '~':
		default:
			return false
		}
	}
	return name != ""
}

// validateChannelTemplate 校验 JSON 模板：长度有界，占位符受控词表，替换后必须是合法 JSON。
func validateChannelTemplate(template string) (string, error) {
	template = strings.TrimSpace(template)
	if template == "" {
		return "", nil
	}
	if len([]rune(template)) > channelMaxTemplateRunes {
		return "", fmt.Errorf("JSON 模板最长 %d 个字符", channelMaxTemplateRunes)
	}
	sample := webhookPayload{
		Source: alertSourceAudit, Severity: alertSeverityCritical, Title: "示例标题",
		Detail: "示例详情", Time: time.Now().UTC().Format(time.RFC3339Nano), Test: true,
	}
	rendered, err := renderChannelTemplate(template, sample)
	if err != nil {
		return "", err
	}
	if !json.Valid(rendered) {
		return "", fmt.Errorf("JSON 模板替换后不是合法 JSON，请把占位符放在双引号内")
	}
	return template, nil
}

// renderChannelTemplate 把 {{source}} 等占位符替换成 JSON 字符串内容（已转义）。
// 只支持受控占位符；出现未知占位符直接报错，避免用户以为会生效。
func renderChannelTemplate(template string, p webhookPayload) ([]byte, error) {
	values := map[string]string{
		"source":   p.Source,
		"severity": p.Severity,
		"title":    p.Title,
		"detail":   p.Detail,
		"time":     p.Time,
		"test":     fmt.Sprintf("%t", p.Test),
	}
	out := template
	for key, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("模板占位符转义失败")
		}
		escaped := string(encoded)
		escaped = escaped[1 : len(escaped)-1] // 去掉外层引号：占位符应放在模板的双引号内
		out = strings.ReplaceAll(out, "{{"+key+"}}", escaped)
	}
	// 剩下任何 {{...}} 都视为未知占位符（避免"写了但没生效"的静默失败）。
	if idx := strings.Index(out, "{{"); idx >= 0 {
		return nil, fmt.Errorf("模板里有不支持的占位符，只支持 {{source}}/{{severity}}/{{title}}/{{detail}}/{{time}}/{{test}}")
	}
	return []byte(out), nil
}

// validateChannelEmail 校验 SMTP 配置并补齐默认端口/加密方式。
func validateChannelEmail(in *channelEmailWrite) (*ChannelEmail, string, error) {
	if in == nil {
		return nil, "", fmt.Errorf("邮件通道需要填写 SMTP 服务器信息")
	}
	host := strings.TrimSpace(in.Host)
	if host == "" || len([]rune(host)) > channelMaxHostRunes {
		return nil, "", fmt.Errorf("SMTP 服务器地址不能为空且最长 %d 个字符", channelMaxHostRunes)
	}
	if strings.ContainsAny(host, " \r\n\t/:") {
		return nil, "", fmt.Errorf("SMTP 服务器地址只填主机名或 IP，不要带协议和路径")
	}
	tlsMode := strings.TrimSpace(in.TLS)
	if tlsMode == "" {
		tlsMode = smtpTLSStartTLS
	}
	if tlsMode != smtpTLSStartTLS && tlsMode != smtpTLSImplicit && tlsMode != smtpTLSNone {
		return nil, "", fmt.Errorf("加密方式须为 starttls / ssl / none")
	}
	port := in.Port
	if port == 0 {
		switch tlsMode {
		case smtpTLSImplicit:
			port = 465
		case smtpTLSNone:
			port = 25
		default:
			port = 587
		}
	}
	if port < 1 || port > 65535 {
		return nil, "", fmt.Errorf("SMTP 端口须在 1..65535")
	}
	user := strings.TrimSpace(in.User)
	if len([]rune(user)) > channelMaxUserRunes {
		return nil, "", fmt.Errorf("SMTP 账号最长 %d 个字符", channelMaxUserRunes)
	}
	password := in.Password
	if len([]rune(password)) > channelMaxPasswordRunes {
		return nil, "", fmt.Errorf("SMTP 口令最长 %d 个字符", channelMaxPasswordRunes)
	}
	if user != "" && password == "" {
		return nil, "", fmt.Errorf("填了 SMTP 账号就必须填口令（不需要认证时请把账号留空）")
	}
	if user == "" && password != "" {
		return nil, "", fmt.Errorf("填了口令就必须填 SMTP 账号")
	}
	from := strings.TrimSpace(in.From)
	if from == "" {
		from = user
	}
	if err := validateMailAddress(from); err != nil {
		return nil, "", fmt.Errorf("发件人地址无效：请填写完整邮箱地址")
	}
	recipients := make([]string, 0, len(in.Recipients))
	seen := make(map[string]bool, len(in.Recipients))
	for _, raw := range in.Recipients {
		addr := strings.TrimSpace(raw)
		if addr == "" {
			continue
		}
		if err := validateMailAddress(addr); err != nil {
			return nil, "", fmt.Errorf("收件人 %s 不是有效邮箱地址", addr)
		}
		if seen[addr] {
			continue
		}
		seen[addr] = true
		recipients = append(recipients, addr)
	}
	if len(recipients) == 0 {
		return nil, "", fmt.Errorf("请至少填一个收件人邮箱")
	}
	if len(recipients) > channelMaxRecipients {
		return nil, "", fmt.Errorf("收件人最多 %d 个", channelMaxRecipients)
	}
	return &ChannelEmail{
		Host: host, Port: port, TLS: tlsMode, User: user, From: from,
		Recipients: recipients, PasswordSet: password != "",
	}, password, nil
}

// validateMailAddress 做最小可用校验：单个 @、无空白/控制字符、长度有界。
func validateMailAddress(addr string) error {
	if addr == "" || len(addr) > channelMaxMailRunes {
		return fmt.Errorf("长度无效")
	}
	if strings.ContainsAny(addr, " \r\n\t<>") {
		return fmt.Errorf("含非法字符")
	}
	at := strings.LastIndex(addr, "@")
	if at <= 0 || at == len(addr)-1 || strings.Count(addr, "@") != 1 {
		return fmt.Errorf("缺少 @ 或格式无效")
	}
	return nil
}

func hasControlChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
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

// channelSeverityMatches 判断一条通道是否订阅了某级别。
func channelSeverityMatches(severities []string, severity string) bool {
	for _, s := range severities {
		if s == severity {
			return true
		}
	}
	return false
}

// dispatchAlert 由 recordAlert 在告警落库后调用：只为启用且订阅该级别/来源的通道投递。
// 投递在**短命 goroutine**里同步完成（无 ticker/AfterFunc/常驻协程），
// 单次包含有限重试；错误记入内存历史并打脱敏 WARN（G-30）。
func (reg *webhookRegistry) dispatchAlert(severity, event, title, detail string) {
	if reg == nil {
		return
	}
	reg.mu.RLock()
	targets := make([]*channelStored, 0)
	for _, id := range reg.order {
		st := reg.targets[id]
		if st == nil || !st.view.Enabled {
			continue
		}
		if !webhookEventMatches(st.view.Events, event) {
			continue
		}
		if !channelSeverityMatches(st.view.Severities, severity) {
			continue
		}
		targets = append(targets, st)
	}
	reg.mu.RUnlock()
	for _, st := range targets {
		go reg.deliver(st, event, severity, title, detail, false)
	}
}

// deliver 做一次投递（含有限重试）；被 dispatchAlert 与测试端点共用。
func (reg *webhookRegistry) deliver(st *channelStored, event, severity, title, detail string, isTest bool) {
	at := time.Now().UTC()
	payload := webhookPayload{
		Source: event, Severity: severity, Title: title, Detail: detail,
		Time: at.Format(time.RFC3339Nano), Test: isTest,
	}
	status, code, attempts, lastErr := reg.send(st, payload, at)
	statusText := "ok"
	msg := ""
	if status != "ok" {
		statusText = "failed"
		if lastErr != nil {
			msg = truncateRunes(sanitizeChannelError(lastErr.Error(), st), 240)
		}
		slog.Warn("通知通道投递失败", "target", st.view.ID, "kind", st.view.Kind,
			"ref", channelTargetRef(st), "event", event, "severity", severity,
			"attempts", attempts, "code", code, "err", msg)
	}
	reg.record(channelDelivery{
		ID: fmt.Sprintf("d-%d", reg.seq.Add(1)), TargetID: st.view.ID, Name: st.view.Name,
		Kind: st.view.Kind, Event: event, Severity: severity,
		Attempts: attempts, Status: statusText, HTTPCode: code,
		Err: msg, At: at.Format(time.RFC3339Nano), TargetRef: channelTargetRef(st),
	})
}

// send 按通道类型投递一次（含有限重试）。
func (reg *webhookRegistry) send(st *channelStored, payload webhookPayload, at time.Time) (string, int, int, error) {
	switch st.view.Kind {
	case channelKindEmail:
		code, attempts, err := sendChannelEmail(st, payload)
		if err != nil {
			return "failed", code, attempts, err
		}
		return "ok", code, attempts, nil
	case channelKindIM:
		reqURL, body, err := buildIMRequest(st.view.IM.Kind, st.secret, st.view.URL, payload, at)
		if err != nil {
			return "failed", 0, 1, err
		}
		return reg.postWithRetry(st, reqURL, nil, body, true)
	default:
		var body []byte
		var err error
		if st.view.Template != "" {
			body, err = renderChannelTemplate(st.view.Template, payload)
			if err != nil {
				return "failed", 0, 1, err
			}
		} else {
			body, err = json.Marshal(payload)
			if err != nil {
				return "failed", 0, 1, err
			}
		}
		if len(body) > channelMaxPayloadBytes {
			body = body[:channelMaxPayloadBytes]
		}
		return reg.postWithRetry(st, st.view.URL, st.view.Headers, body, false)
	}
}

// postWithRetry 最多 channelMaxAttempts 次；每次请求级 context 均 defer cancel，
// 重试等待用 time.NewTimer + defer Stop（G-19：无常驻定时器）。
// checkIMErr 为 true 时把 2xx 响应体里的 errcode/code 也算进结果（IM 网关常见 200 + 业务错误码）。
func (reg *webhookRegistry) postWithRetry(st *channelStored, reqURL string, headers []ChannelHeader, body []byte, checkIMErr bool) (string, int, int, error) {
	var lastErr error
	var code int
	for attempt := 1; attempt <= channelMaxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), channelHTTPTimeout)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
		if err != nil {
			cancel()
			lastErr = fmt.Errorf("构造请求失败")
			break
		}
		req.Header.Set("Content-Type", "application/json")
		for _, h := range headers {
			req.Header.Set(h.Name, h.Value)
		}
		if st.secret != "" && st.view.Kind == channelKindWebhook {
			// 密钥经 header 传出，绝不写日志；名字固定，不拼接用户输入。
			req.Header.Set("X-Kore-Webhook-Token", st.secret)
		}
		resp, err := channelHTTPClient.Do(req)
		if err == nil {
			code = resp.StatusCode
			respBody := make([]byte, 4<<10)
			n, _ := resp.Body.Read(respBody)
			_ = resp.Body.Close()
			cancel()
			if code >= 200 && code < 300 {
				if checkIMErr {
					if bizErr := imResponseError(respBody[:n]); bizErr != nil {
						lastErr = bizErr
					} else {
						return "ok", code, attempt, nil
					}
				} else {
					return "ok", code, attempt, nil
				}
			} else {
				lastErr = fmt.Errorf("上游返回 HTTP %d", code)
			}
		} else {
			cancel()
			lastErr = err
		}
		if attempt < channelMaxAttempts {
			timer := time.NewTimer(time.Duration(channelRetryBaseMs*attempt) * time.Millisecond)
			<-timer.C
			timer.Stop()
		}
	}
	return "failed", code, channelMaxAttempts, lastErr
}

// channelTargetRef 返回脱敏的对端标识：HTTP 通道用 scheme://host，邮件用 host:port。
func channelTargetRef(st *channelStored) string {
	if st.view.Kind == channelKindEmail && st.view.Email != nil {
		return fmt.Sprintf("%s:%d", st.view.Email.Host, st.view.Email.Port)
	}
	if _, hostRef, err := validateWebhookURL(st.view.URL); err == nil {
		return hostRef
	}
	return "—"
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "…"
}

// channelURLPattern 匹配错误信息里出现的完整 URL（含查询串/加签参数）。
var channelURLPattern = regexp.MustCompile(`https?://[^s"']+`)

// sanitizeChannelError 把错误文本里的完整 URL 换成脱敏的 scheme://host，
// 避免把带密钥的查询串（如机器人 access_token / sign）写进日志与投递记录（G-30）。
func sanitizeChannelError(msg string, st *channelStored) string {
	ref := channelTargetRef(st)
	if st.view.URL != "" {
		msg = strings.ReplaceAll(msg, st.view.URL, ref)
	}
	return channelURLPattern.ReplaceAllStringFunc(msg, func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return "…"
		}
		return u.Scheme + "://" + u.Host
	})
}

// channelHTTPClient 是专用短超时客户端；不跟随重定向（防 SSRF 跳转到内网地址）。
var channelHTTPClient = &http.Client{
	Timeout: channelHTTPTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}
