package store

import (
	"strconv"
	"testing"
	"time"
)

// TestAuditPutAndListRoundTrip 写完即可查：PutAudit 后立刻 ListAudit 可见，
// 键为 %020d-%06d 且递增，字段原样回读——全程无 HTTP 请求、无对账参与。
func TestAuditPutAndListRoundTrip(t *testing.T) {
	s := openAuditStore(t)
	want := []AuditRecord{
		{Subject: "admin", Action: "plugin.enable", Plugin: "echo", Target: "ready",
			Result: AuditResultOK, Detail: map[string]string{"state": "ready"}},
		{Subject: "system", Action: "plugin.crash", Plugin: "echo",
			Result: AuditResultError, Detail: map[string]string{"err": "signal: killed", "pid": "4242"}},
		{Subject: "admin", Action: "plugin.disable", Plugin: "echo", Target: "stopped",
			Result: AuditResultOK},
	}
	for i, rec := range want {
		if err := s.PutAudit(rec); err != nil {
			t.Fatalf("PutAudit #%d 应成功，实际: %v", i, err)
		}
	}
	got, err := s.ListAudit(AuditFilter{})
	if err != nil {
		t.Fatalf("ListAudit 失败: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("应查到 %d 条，实际 %d 条", len(want), len(got))
	}
	keys := make([]string, 0, len(got))
	for i, rec := range got {
		keys = append(keys, rec.Key)
		if rec.Subject != want[i].Subject || rec.Action != want[i].Action ||
			rec.Plugin != want[i].Plugin || rec.Target != want[i].Target ||
			rec.Result != want[i].Result {
			t.Errorf("第 %d 条字段回读不符: got=%+v want=%+v", i, rec, want[i])
		}
		if len(rec.Detail) != len(want[i].Detail) {
			t.Errorf("第 %d 条 detail 数量不符: got=%v want=%v", i, rec.Detail, want[i].Detail)
		} else {
			for k, v := range want[i].Detail {
				if rec.Detail[k] != v {
					t.Errorf("第 %d 条 detail[%s]=%q，期望 %q", i, k, rec.Detail[k], v)
				}
			}
		}
	}
	assertAuditKeys(t, keys)
	// 过滤查询：只取 crash。
	only, err := s.ListAudit(AuditFilter{Action: "plugin.crash"})
	if err != nil || len(only) != 1 || only[0].Subject != "system" {
		t.Fatalf("按 action 过滤应只返回 1 条 crash，实际 %d 条 err=%v", len(only), err)
	}
}

// TestAuditStormFiftyWrites crash 连打 50 次：单次写耗时不得随次数线性增长
// （R3 触发信号），且 50 条全部落库可查。
func TestAuditStormFiftyWrites(t *testing.T) {
	s := openAuditStore(t)
	const writes = 50
	durs := make([]time.Duration, 0, writes)
	for i := 0; i < writes; i++ {
		start := time.Now()
		err := s.PutAudit(AuditRecord{
			Subject: "system", Action: "plugin.crash", Plugin: "echo",
			Result: AuditResultError,
			Detail: map[string]string{"seq": strconv.Itoa(i)},
		})
		if err != nil {
			t.Fatalf("第 %d 次写入失败: %v", i, err)
		}
		durs = append(durs, time.Since(start))
	}
	got, err := s.ListAudit(AuditFilter{Action: "plugin.crash"})
	if err != nil || len(got) != writes {
		t.Fatalf("应查到 %d 条 crash，实际 %d 条 err=%v", writes, len(got), err)
	}
	var first, second time.Duration
	for i, d := range durs {
		if i < writes/2 {
			first += d
		} else {
			second += d
		}
	}
	first /= writes / 2
	second /= writes - writes/2
	var total time.Duration
	for _, d := range durs {
		total += d
	}
	t.Logf("50 连写平均耗时：前 25 条 %v，后 25 条 %v，总耗时 %v", first, second, total)
	// 后半均值不得超前半 3 倍再加 5ms 容差；线性增长（每条递增）会显著越界。
	if second > first*3+5*time.Millisecond {
		t.Errorf("单次写耗时随次数增长：后半均值 %v > 前半均值 %v×3+5ms（R3 线性增长命中）", second, first)
	}
	keys := make([]string, 0, len(got))
	for _, rec := range got {
		keys = append(keys, rec.Key)
	}
	assertAuditKeys(t, keys)
}
