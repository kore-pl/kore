package httpapi

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 日志关键字告警（R23 新功能7）：用户配置「日志文本命中关键字则告警」规则。
//
// 与 r23-alertrules 的划界：告警规则视图配的是**监控指标阈值**（CPU/内存/磁盘等采样值），
// 本模块配的是**日志文本关键字**（ERROR/panic/timeout 等文本命中）；数据源是 logs 插件
// 经 logs.tail / logs.search 的请求级读取，内核不读插件日志文件（G-01 薄壳红线）。
//
// G-19 硬约束：本文件零 NewTicker / 零 AfterFunc / 零常驻 goroutine。
// 命中检测只在用户点「立即扫描」时经 POST /api/v1/log-alerts/scan 请求级发生；
// 空闲时既不读日志也不产生任何后台工作，出站恒 0。
//
// 显式 schema（G-24）：对外结构体字段全部定形，无 object / any / map[string]any。

const (
	logAlertsPath            = "/api/v1/log-alerts"
	logAlertsMaxRules        = 64
	logAlertsMaxHits         = 200
	logAlertsMaxKeywordRunes = 128
	logAlertsMaxSourceRunes  = 64
	logAlertsMaxSnippetRunes = 240
	logAlertsMaxScanLines    = 500
	logAlertsMaxScanBytes    = 1 << 20 // 扫描请求体上限 1 MiB（500 行文本足够）
	logAlertsMaxHitsPerScan  = 20      // 单次扫描最多记 20 条命中，防告警风暴
	logAlertsAllSources      = "*"     // 规则来源通配：匹配所有日志来源
)

// LogAlertRule 是一条用户可见规则（对外显式字段，G-24）。
type LogAlertRule struct {
	ID        string `json:"id"`
	Keyword   string `json:"keyword"`   // 匹配关键字（大小写不敏感子串）
	Source    string `json:"source"`    // logs 来源名；"*" 表示所有来源
	Severity  string `json:"severity"`  // critical / warning / info，与告警中心同源
	Enabled   bool   `json:"enabled"`   // 启用态
	HitCount  int    `json:"hit_count"` // 累计命中次数
	CreatedAt string `json:"created_at"`
}

// LogAlertHit 是一条命中历史（片段已脱敏，G-30）。
type LogAlertHit struct {
	ID       string `json:"id"`
	RuleID   string `json:"rule_id"`
	Keyword  string `json:"keyword"`
	Source   string `json:"source"`
	Severity string `json:"severity"`
	LineNo   int    `json:"line_no"`
	Snippet  string `json:"snippet"` // 脱敏后片段，≤240 rune
	At       string `json:"at"`
}

// logAlertLine 是扫描提交的一行文本（显式字段，前端从 logs.tail 拿，不经内核读文件）。
type logAlertLine struct {
	LineNo int    `json:"line_no"`
	Text   string `json:"text"`
}

// logAlertRuleStored 是内部存储态；对外只返回 LogAlertRule 视图。
type logAlertRuleStored struct {
	LogAlertRule
	lowerKeyword string // 预计算小写关键字，扫描时避免重复转换
}

// logAlertListBody 是 GET /api/v1/log-alerts 的响应（显式字段）。
type logAlertListBody struct {
	Rules []LogAlertRule `json:"rules"`
	Hits  []LogAlertHit  `json:"hits"`
	Note  string         `json:"note"`
}

// logAlertWriteBody 是新增/编辑规则的请求体（显式字段，G-24）。
type logAlertWriteBody struct {
	Keyword  string `json:"keyword"`
	Source   string `json:"source"`
	Severity string `json:"severity"`
	Enabled  bool   `json:"enabled"`
}

// logAlertScanBody 是请求级扫描的请求体（显式字段）。
type logAlertScanBody struct {
	Source string         `json:"source"`
	Lines  []logAlertLine `json:"lines"`
}

// logAlertScanResult 是扫描结果（显式字段）。
type logAlertScanResult struct {
	Scanned int           `json:"scanned"`
	Matched int           `json:"matched"`
	Hits    []LogAlertHit `json:"hits"`
	Note    string        `json:"note,omitempty"`
}

// logAlertRegistry 是规则与命中历史的内存态注册表；互斥保护，零常驻 goroutine。
// 与 webhookRegistry 同范式：配置只在进程内存，重启即清空（UI 明示）。
type logAlertRegistry struct {
	mu    sync.RWMutex
	rules map[string]*logAlertRuleStored
	order []string
	hits  []LogAlertHit
	seq   atomic.Uint64
}

func newLogAlertRegistry() *logAlertRegistry {
	return &logAlertRegistry{rules: make(map[string]*logAlertRuleStored)}
}

// validLogAlertSeverity 与告警中心受控词表同源，不新增词。
func validLogAlertSeverity(v string) bool {
	return v == alertSeverityCritical || v == alertSeverityWarning || v == alertSeverityInfo
}

// validateLogAlertWrite 校验显式 schema，返回人话错误（→ HTTP 400 E_INVALID）。
func validateLogAlertWrite(in logAlertWriteBody) (string, error) {
	kw := strings.TrimSpace(in.Keyword)
	if kw == "" {
		return "", fmt.Errorf("关键字不能为空，请输入要匹配的日志文本，例如 ERROR")
	}
	if len([]rune(kw)) > logAlertsMaxKeywordRunes {
		return "", fmt.Errorf("关键字不能超过 %d 个字符", logAlertsMaxKeywordRunes)
	}
	src := strings.TrimSpace(in.Source)
	if src == "" {
		src = logAlertsAllSources
	}
	if len([]rune(src)) > logAlertsMaxSourceRunes {
		return "", fmt.Errorf("来源名称不能超过 %d 个字符", logAlertsMaxSourceRunes)
	}
	if !validLogAlertSeverity(in.Severity) {
		return "", fmt.Errorf("严重级别只能是 critical / warning / info")
	}
	return src, nil
}

// add 校验后新增一条规则；ID 单调递增，重启从 1 开始（内存态，UI 明示）。
func (reg *logAlertRegistry) add(in logAlertWriteBody) (LogAlertRule, error) {
	src, err := validateLogAlertWrite(in)
	if err != nil {
		return LogAlertRule{}, err
	}
	stored := &logAlertRuleStored{
		LogAlertRule: LogAlertRule{
			ID:        "la-" + strconv.FormatUint(reg.seq.Add(1), 10),
			Keyword:   strings.TrimSpace(in.Keyword),
			Source:    src,
			Severity:  in.Severity,
			Enabled:   in.Enabled, // 尊重前端表单的启用态（默认由表单预填 true）
			HitCount:  0,
			CreatedAt: time.Now().UTC().Format(time.RFC3339),
		},
		lowerKeyword: strings.ToLower(strings.TrimSpace(in.Keyword)),
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.rules) >= logAlertsMaxRules {
		return LogAlertRule{}, fmt.Errorf("规则数量已达上限 %d 条，请先删除不用的规则", logAlertsMaxRules)
	}
	reg.rules[stored.ID] = stored
	reg.order = append(reg.order, stored.ID)
	return stored.LogAlertRule, nil
}

// update 全量替换一条规则（含启用/停用）；不存在返回 false。
func (reg *logAlertRegistry) update(id string, in logAlertWriteBody) (LogAlertRule, bool, error) {
	src, err := validateLogAlertWrite(in)
	if err != nil {
		return LogAlertRule{}, false, err
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	old, ok := reg.rules[id]
	if !ok {
		return LogAlertRule{}, false, nil
	}
	stored := &logAlertRuleStored{
		LogAlertRule: LogAlertRule{
			ID:        old.ID,
			Keyword:   strings.TrimSpace(in.Keyword),
			Source:    src,
			Severity:  in.Severity,
			Enabled:   in.Enabled,
			HitCount:  old.HitCount,
			CreatedAt: old.CreatedAt,
		},
		lowerKeyword: strings.ToLower(strings.TrimSpace(in.Keyword)),
	}
	reg.rules[id] = stored
	return stored.LogAlertRule, true, nil
}

// remove 删除一条规则；不存在返回 false。命中历史保留（便于回溯）。
func (reg *logAlertRegistry) remove(id string) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if _, ok := reg.rules[id]; !ok {
		return false
	}
	delete(reg.rules, id)
	for i, v := range reg.order {
		if v == id {
			reg.order = append(reg.order[:i], reg.order[i+1:]...)
			break
		}
	}
	return true
}

// list 返回规则（按创建顺序）与命中历史（最新在前），均为显式视图。
func (reg *logAlertRegistry) list() logAlertListBody {
	reg.mu.RLock()
	defer reg.mu.RUnlock()
	rules := make([]LogAlertRule, 0, len(reg.order))
	for _, id := range reg.order {
		if r := reg.rules[id]; r != nil {
			rules = append(rules, r.LogAlertRule)
		}
	}
	hits := make([]LogAlertHit, 0, len(reg.hits))
	for i := len(reg.hits) - 1; i >= 0; i-- {
		hits = append(hits, reg.hits[i])
	}
	return logAlertListBody{Rules: rules, Hits: hits,
		Note: "规则保存在当前进程内存中，重启后需要重新配置；命中片段已自动脱敏。"}
}

// 脱敏正则：凭据键值 / 邮箱 / IPv4 / 手机号 / 长十六进制串（G-30，不记明文凭据）。
var (
	logAlertSecretKV  = regexp.MustCompile(`(?i)\b(token|password|passwd|pwd|secret|api[_-]?key|authorization)\s*[=:]\s*([^\s,;]+)`)
	logAlertEmail     = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
	logAlertIPv4      = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	logAlertPhone     = regexp.MustCompile(`\b1[3-9]\d{9}\b`)
	logAlertLongToken = regexp.MustCompile(`\b[A-Fa-f0-9]{32,}\b`)
)

// redactLogLine 把一行日志脱敏并截到 maxRunes 以内；片段只用于站内命中历史展示。
func redactLogLine(text string, maxRunes int) string {
	s := logAlertSecretKV.ReplaceAllString(text, "$1=[REDACTED]")
	s = logAlertEmail.ReplaceAllString(s, "[REDACTED]")
	s = logAlertIPv4.ReplaceAllString(s, "[REDACTED]")
	s = logAlertPhone.ReplaceAllString(s, "[REDACTED]")
	s = logAlertLongToken.ReplaceAllString(s, "[REDACTED]")
	r := []rune(s)
	if len(r) > maxRunes {
		return string(r[:maxRunes]) + "…（已截断）"
	}
	return s
}

// scan 对请求级提交的日志行逐条匹配启用的规则，返回命中列表并累计 hit_count。
// 纯同步、无 goroutine、无 ticker（G-19）；发告警由调用方用 s.recordAlert 完成。
func (reg *logAlertRegistry) scan(source string, lines []logAlertLine, now time.Time) logAlertScanResult {
	if len(lines) > logAlertsMaxScanLines {
		lines = lines[:logAlertsMaxScanLines] // 请求级硬上限，防大请求拖慢主壳
	}
	result := logAlertScanResult{Scanned: len(lines), Hits: []LogAlertHit{}}
	seen := make(map[string]bool) // ruleID|lineNo 去重，避免同一次扫描重复计数
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for i := 0; i < len(lines) && len(result.Hits) < logAlertsMaxHitsPerScan; i++ {
		line := lines[i]
		text := strings.ToLower(line.Text)
		for _, id := range reg.order {
			rule := reg.rules[id]
			if rule == nil || !rule.Enabled || seen[id+"|"+strconv.Itoa(line.LineNo)] {
				continue
			}
			if rule.Source != logAlertsAllSources && rule.Source != source {
				continue
			}
			if !strings.Contains(text, rule.lowerKeyword) {
				continue
			}
			seen[id+"|"+strconv.Itoa(line.LineNo)] = true
			rule.HitCount++
			hit := LogAlertHit{
				ID:       "lah-" + strconv.FormatUint(reg.seq.Add(1), 10),
				RuleID:   rule.ID,
				Keyword:  rule.Keyword,
				Source:   source,
				Severity: rule.Severity,
				LineNo:   line.LineNo,
				Snippet:  redactLogLine(line.Text, logAlertsMaxSnippetRunes),
				At:       now.UTC().Format(time.RFC3339Nano),
			}
			reg.hits = append(reg.hits, hit)
			if len(reg.hits) > logAlertsMaxHits {
				reg.hits = append([]LogAlertHit{}, reg.hits[len(reg.hits)-logAlertsMaxHits:]...)
			}
			result.Hits = append(result.Hits, hit)
			if len(result.Hits) >= logAlertsMaxHitsPerScan {
				break
			}
		}
	}
	result.Matched = len(result.Hits)
	return result
}
