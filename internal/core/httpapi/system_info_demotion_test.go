package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
)

// demotionBackend 复用 versionBackend，仅覆盖 Demotion 回报「非 root 未降权」。
type demotionBackend struct{ versionBackend }

// Demotion 回报非 root 内核的显式未降权结论。
func (demotionBackend) Demotion() DemotionInfo {
	return DemotionInfo{
		Enabled:   false,
		KernelUID: 1000,
		Reason:    "未生效：kored 以 uid=1000 运行（非 root），插件与内核同 uid",
	}
}

// TestSystemInfoDemotionVisible 验证 /system/info 暴露插件降权状态：
// 未降权时 enabled=false 且带原因，用户不必翻启动日志才能知道插件没隔离。
func TestSystemInfoDemotionVisible(t *testing.T) {
	s := newTestServer()
	s.opts.Backend = demotionBackend{}
	recorder := serve(t, s, http.MethodGet, "/api/v1/system/info")
	if recorder.Code != http.StatusOK {
		t.Fatalf("系统信息状态码 = %d，期望 200", recorder.Code)
	}
	var body struct {
		Demotion struct {
			Enabled   bool   `json:"enabled"`
			KernelUID int    `json:"kernel_uid"`
			Reason    string `json:"reason"`
		} `json:"demotion"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if body.Demotion.Enabled {
		t.Fatalf("非 root 内核不应暴露 enabled=true: %+v", body.Demotion)
	}
	if body.Demotion.KernelUID != 1000 {
		t.Fatalf("kernel_uid=%d，期望 1000", body.Demotion.KernelUID)
	}
	if body.Demotion.Reason == "" {
		t.Fatal("未降权必须给原因，禁止静默：reason 为空")
	}
}

// demotionAbsentBackend 复用 versionBackend 且不实现 DemotionReporter。
type demotionAbsentBackend struct{ versionBackend }

// TestSystemInfoDemotionAbsentNotFaked 验证装配层未回报时不假装已降权。
func TestSystemInfoDemotionAbsentNotFaked(t *testing.T) {
	s := newTestServer()
	s.opts.Backend = demotionAbsentBackend{}
	recorder := serve(t, s, http.MethodGet, "/api/v1/system/info")
	var body struct {
		Demotion struct {
			Enabled bool   `json:"enabled"`
			Reason  string `json:"reason"`
		} `json:"demotion"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if body.Demotion.Enabled || body.Demotion.Reason == "" {
		t.Fatalf("未回报降权状态时必须 enabled=false 且给原因，实际 %+v", body.Demotion)
	}
}
