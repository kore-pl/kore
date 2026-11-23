// Package scheduler 提供内核唯一的周期执行机制（ADR-0019）。
//
// 边界：只做"到点调用 {plugin, method, params}"，不认识任何业务语义；
// 表达式解析、下次时间计算、任务持久化、错过补跑与并发互斥都在本包内，
// 不引第三方调度库（G-02）。
package scheduler

import (
	"fmt"
	"strconv"
	"strings"
)

// 5 段表达式的字段下界/上界（分 时 日 月 周）。
const (
	minuteLow, minuteHigh   = 0, 59
	hourLow, hourHigh       = 0, 23
	dayLow, dayHigh         = 1, 31
	monthLow, monthHigh     = 1, 12
	weekdayLow, weekdayHigh = 0, 7 // 0 与 7 都是周日
)

// maxScanDays 是"下次执行时间"的搜索上限（覆盖 2 月 29 日的最大间隔 8 年）。
const maxScanDays = 366*8 + 2

// field 是一段解析结果：允许值集合 + 是否为通配（决定"日/周"的与或语义）。
type field struct {
	values map[int]bool
	star   bool
}

// Expression 是一份解析后的 5 段表达式。
//
// 段序：分 时 日 月 周。支持 `*`、`n`、`a-b`、`a,b`、`*/n`、`a-b/n`、`a/n`，
// 不支持名称（MON/JAN）与秒级字段——秒级任务不在 v1 范围（ADR-0019）。
type Expression struct {
	raw     string
	minute  field
	hour    field
	day     field
	month   field
	weekday field
}

// Expr 返回表达式的原始文本（供回显与日志，不参与计算）。
func (s *Expression) Expr() string { return s.raw }

// Parse 解析 5 段表达式；任何非法段都返回带段名的错误（不静默跳过）。
func Parse(expr string) (*Expression, error) {
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return nil, fmt.Errorf("%w: 表达式必须是 5 段（分 时 日 月 周），实际 %d 段", ErrInvalid, len(parts))
	}
	minute, err := parseField(parts[0], minuteLow, minuteHigh)
	if err != nil {
		return nil, fmt.Errorf("%w: 分钟段 %q", err, parts[0])
	}
	hour, err := parseField(parts[1], hourLow, hourHigh)
	if err != nil {
		return nil, fmt.Errorf("%w: 小时段 %q", err, parts[1])
	}
	day, err := parseField(parts[2], dayLow, dayHigh)
	if err != nil {
		return nil, fmt.Errorf("%w: 日段 %q", err, parts[2])
	}
	month, err := parseField(parts[3], monthLow, monthHigh)
	if err != nil {
		return nil, fmt.Errorf("%w: 月段 %q", err, parts[3])
	}
	weekday, err := parseField(parts[4], weekdayLow, weekdayHigh)
	if err != nil {
		return nil, fmt.Errorf("%w: 周段 %q", err, parts[4])
	}
	// 7 与 0 等价（周日），统一折叠成 0，避免 dayMatch 里出现两个分支。
	if weekday.values[7] {
		delete(weekday.values, 7)
		weekday.values[0] = true
	}
	return &Expression{
		raw: strings.Join(parts, " "), minute: minute, hour: hour,
		day: day, month: month, weekday: weekday,
	}, nil
}

// parseField 解析单段：逗号分隔的多个元素，逐元素展开后合并。
func parseField(raw string, low, high int) (field, error) {
	out := field{values: map[int]bool{}, star: raw == "*"}
	for _, element := range strings.Split(raw, ",") {
		if element == "" {
			return field{}, fmt.Errorf("%w: 空元素", ErrInvalid)
		}
		if err := expandElement(element, low, high, out.values); err != nil {
			return field{}, err
		}
	}
	if len(out.values) == 0 {
		return field{}, fmt.Errorf("%w: 段为空", ErrInvalid)
	}
	return out, nil
}

// expandElement 把单个元素（*、*/n、a、a-b、a-b/n、a/n）展开进集合。
func expandElement(element string, low, high int, values map[int]bool) error {
	base, stepText, hasStep := strings.Cut(element, "/")
	step := 1
	if hasStep {
		parsed, err := strconv.Atoi(stepText)
		if err != nil || parsed <= 0 {
			return fmt.Errorf("%w: 步长 %q 非法（必须为正整数）", ErrInvalid, stepText)
		}
		step = parsed
	}
	if base == "*" {
		for v := low; v <= high; v += step {
			values[v] = true
		}
		return nil
	}
	startText, endText, isRange := strings.Cut(base, "-")
	start, err := strconv.Atoi(startText)
	if err != nil {
		return fmt.Errorf("%w: %q 不是数字", ErrInvalid, startText)
	}
	end := start
	if isRange {
		end, err = strconv.Atoi(endText)
		if err != nil {
			return fmt.Errorf("%w: %q 不是数字", ErrInvalid, endText)
		}
	}
	if start < low || start > high || end < low || end > high {
		return fmt.Errorf("%w: 取值 %d-%d 超出范围 %d-%d", ErrInvalid, start, end, low, high)
	}
	if start > end {
		return fmt.Errorf("%w: 区间起点 %d 大于终点 %d", ErrInvalid, start, end)
	}
	stepN := 1
	if hasStep {
		stepN = step
	}
	for v := start; v <= end; v += stepN {
		values[v] = true
	}
	return nil
}
