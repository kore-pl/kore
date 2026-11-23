package scheduler

import (
	"strings"
	"testing"
	"time"
)

// mustParse 解析表达式，失败即终止用例。
func mustParse(t *testing.T, expr string) *Expression {
	t.Helper()
	schedule, err := Parse(expr)
	if err != nil {
		t.Fatalf("解析 %q 失败: %v", expr, err)
	}
	return schedule
}

// TestParseValid 覆盖任务书要求的五类合法表达式与字段语义。
func TestParseValid(t *testing.T) {
	cases := []struct {
		expr  string
		after time.Time
		want  time.Time
	}{
		// 每 5 分钟：从 00:02 到 00:05。
		{"*/5 * * * *", time.Date(2026, 1, 1, 0, 2, 0, 0, time.UTC), time.Date(2026, 1, 1, 0, 5, 0, 0, time.UTC)},
		// 每天 3 点：当天已过 → 次日。
		{"0 3 * * *", time.Date(2026, 11, 23, 9, 46, 0, 0, time.UTC), time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC)},
		// 每月 1 日 0 点：跨月。
		{"0 0 1 * *", time.Date(2026, 11, 23, 9, 46, 0, 0, time.UTC), time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)},
		// 工作日 02:30：周五 03:00 之后 → 下周一。
		{"30 2 * * 1-5", time.Date(2026, 11, 27, 3, 0, 0, 0, time.UTC), time.Date(2026, 11, 30, 2, 30, 0, 0, time.UTC)},
		// 跨年：12 月 31 日 23:59。
		{"59 23 31 12 *", time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC), time.Date(2026, 12, 31, 23, 59, 0, 0, time.UTC)},
		// 闰年 2 月 29 日。
		{"0 0 29 2 *", time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), time.Date(2028, 2, 29, 0, 0, 0, 0, time.UTC)},
		// 周日可写 7（等价 0）。
		{"0 0 * * 7", time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC), time.Date(2026, 11, 29, 0, 0, 0, 0, time.UTC)},
		// 列表 + 区间 + 步长混用。
		{"0,15,30-40/5 * * * *", time.Date(2026, 1, 1, 0, 15, 30, 0, time.UTC), time.Date(2026, 1, 1, 0, 30, 0, 0, time.UTC)},
	}
	for _, tc := range cases {
		got, ok := mustParse(t, tc.expr).Next(tc.after)
		if !ok {
			t.Errorf("%q 找不到下次执行时间", tc.expr)
			continue
		}
		if !got.Equal(tc.want) {
			t.Errorf("%q: 期望 %s，实际 %s", tc.expr, tc.want, got)
		}
	}
}

// TestParseRejectsInvalid 覆盖非法表达式必须被拒绝（不静默降级）。
func TestParseRejectsInvalid(t *testing.T) {
	bad := []string{
		"* * * *",      // 段数不足
		"* * * * * *",  // 段数过多
		"60 * * * *",   // 分钟越界
		"* 24 * * *",   // 小时越界
		"0 0 32 * *",   // 日越界
		"0 0 * 13 *",   // 月越界
		"0 0 * * 8",    // 周越界
		"*/0 * * * *",  // 步长为零
		"*/x * * * *",  // 步长非数字
		"a * * * *",    // 非数字
		"5-3 * * * *",  // 区间倒置
		"1,,2 * * * *", // 空元素
		"0 0 L * *",    // 不支持名称
		"0 0 * * * *",  // 秒级字段不支持
	}
	for _, expr := range bad {
		if _, err := Parse(expr); err == nil {
			t.Errorf("%q 应被拒绝", expr)
		} else if !strings.Contains(err.Error(), "定时任务参数非法") {
			t.Errorf("%q 的错误应归类 ErrInvalid，实际: %v", expr, err)
		}
	}
}

// TestNextRunDomDowOr 验证"日"与"周"都受限时取或（标准语义）。
func TestNextRunDomDowOr(t *testing.T) {
	// 2026-11-24 是周二；"每月 1 日或每周一" 的下一次应为 11-30（周一），不是 12-01。
	schedule := mustParse(t, "0 0 1 * 1")
	got, ok := schedule.Next(time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC))
	if !ok {
		t.Fatal("找不到下次执行时间")
	}
	want := time.Date(2026, 11, 30, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("期望 %s，实际 %s", want, got)
	}
}

// TestNextRunImpossible 验证永不成立的日期返回 false（不返回零值时间）。
func TestNextRunImpossible(t *testing.T) {
	if _, ok := mustParse(t, "0 0 30 2 *").Next(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)); ok {
		t.Fatal("2 月 30 日不应有下次执行时间")
	}
}

// TestIntervalNextRun 验证 interval 型任务按秒推进。
func TestIntervalNextRun(t *testing.T) {
	task := Task{IntervalS: 90}
	after := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got, err := task.nextRun(after)
	if err != nil {
		t.Fatalf("计算失败: %v", err)
	}
	if want := after.Add(90 * time.Second); !got.Equal(want) {
		t.Fatalf("期望 %s，实际 %s", want, got)
	}
}
