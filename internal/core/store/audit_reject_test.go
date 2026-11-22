package store

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

// TestAuditRejectedByControlledDetail 受控校验（DATA-MODEL §9）：result 非法、
// 键 >32 字符、值 >256 字符、键数 >16、detail 总长 >1 KiB 一律拒绝且不落库；
// 边界值（恰好 32/256/16 且总长 ≤1 KiB）合法可写。
func TestAuditRejectedByControlledDetail(t *testing.T) {
	s := openAuditStore(t)
	longKey := strings.Repeat("k", 33)
	longVal := strings.Repeat("v", 257)
	overflow := map[string]string{}
	for i := 0; i < auditDetailMaxKeys; i++ {
		overflow[fmt.Sprintf("k%02d", i)] = strings.Repeat("x", 200) // 合法键值，但总长 >1 KiB
	}
	tooMany := map[string]string{}
	for i := 0; i <= auditDetailMaxKeys; i++ {
		tooMany[strconv.Itoa(i)] = "v"
	}
	cases := []struct {
		name    string
		rec     AuditRecord
		wantErr bool
	}{
		{"result 非法", AuditRecord{Subject: "admin", Action: "plugin.enable", Result: "failed"}, true},
		{"detail 键超长", AuditRecord{Subject: "admin", Action: "plugin.enable", Result: AuditResultOK,
			Detail: map[string]string{longKey: "v"}}, true},
		{"detail 值超长", AuditRecord{Subject: "system", Action: "plugin.crash", Result: AuditResultError,
			Detail: map[string]string{"err": longVal}}, true},
		{"detail 键数超限", AuditRecord{Subject: "admin", Action: "plugin.enable", Result: AuditResultOK,
			Detail: tooMany}, true},
		{"detail 总长超 1KiB", AuditRecord{Subject: "admin", Action: "plugin.enable", Result: AuditResultOK,
			Detail: overflow}, true},
		{"边界合法：键 32 字符值 256 字符", AuditRecord{Subject: "admin", Action: "plugin.enable",
			Result: AuditResultOK, Detail: map[string]string{strings.Repeat("k", 32): strings.Repeat("v", 256)}}, false},
		{"边界合法：16 个短键值", AuditRecord{Subject: "admin", Action: "plugin.disable",
			Result: AuditResultOK, Detail: tooManyWithoutOne(tooMany)}, false},
	}
	accepted := 0
	for _, tc := range cases {
		err := s.PutAudit(tc.rec)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: 应被拒绝，实际写入成功", tc.name)
				continue
			}
			if !strings.Contains(err.Error(), ErrAuditInvalid.Error()) {
				t.Errorf("%s: 错误应为 ErrAuditInvalid，实际 %v", tc.name, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: 应写入成功，实际被拒: %v", tc.name, err)
			continue
		}
		accepted++
	}
	got, err := s.ListAudit(AuditFilter{})
	if err != nil {
		t.Fatalf("ListAudit 失败: %v", err)
	}
	if len(got) != accepted {
		t.Fatalf("落库条数应等于合法写入数 %d，实际 %d（被拒记录不得落库）", accepted, len(got))
	}
}

// tooManyWithoutOne 截掉一个键，得到 16 个短键值（总长 ≤1 KiB）。
func tooManyWithoutOne(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		out[k] = v[:1]
	}
	delete(out, strconv.Itoa(auditDetailMaxKeys))
	return out
}
