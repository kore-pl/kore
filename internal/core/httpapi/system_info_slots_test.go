package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// slotStatsBackend 复用 versionBackend 的其余方法，仅覆盖 Stats 返回非零槽位统计。
type slotStatsBackend struct{ versionBackend }

func (slotStatsBackend) Stats(context.Context) (SupervisorStats, error) {
	return SupervisorStats{Resident: 2, ResidentMax: 2, LazySlots: 1}, nil
}

// TestSystemInfoSupervisorSlots 验证 /system/info 的 supervisor 段暴露
// resident_max 与 lazy_slots（前端展示槽位保护状态的数据来源）。
func TestSystemInfoSupervisorSlots(t *testing.T) {
	s := newTestServer()
	s.opts.Backend = slotStatsBackend{}
	recorder := serve(t, s, http.MethodGet, "/api/v1/system/info")
	if recorder.Code != http.StatusOK {
		t.Fatalf("系统信息状态码 = %d，期望 200", recorder.Code)
	}
	var body struct {
		Supervisor struct {
			Resident    int `json:"resident"`
			ResidentMax int `json:"resident_max"`
			LazySlots   int `json:"lazy_slots"`
		} `json:"supervisor"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if body.Supervisor.Resident != 2 || body.Supervisor.ResidentMax != 2 || body.Supervisor.LazySlots != 1 {
		t.Fatalf("supervisor 段不符合预期: %+v", body.Supervisor)
	}
}
