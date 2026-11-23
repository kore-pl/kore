package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeSelfUpdater 在 auditTestBackend 之上实现 SelfUpdater（不碰真实二进制）。
type fakeSelfUpdater struct {
	auditTestBackend
	status    SelfUpdateStatus
	startErr  error
	rollErr   error
	lastStart SelfUpdateRequest
	jobs      map[string]SelfUpdateJob
}

func (f *fakeSelfUpdater) UpgradeStatus(context.Context) (SelfUpdateStatus, error) {
	return f.status, nil
}

func (f *fakeSelfUpdater) StartUpgrade(_ context.Context, _ string, req SelfUpdateRequest) (SelfUpdateJob, error) {
	f.lastStart = req
	if f.startErr != nil {
		return SelfUpdateJob{}, f.startErr
	}
	job := SelfUpdateJob{ID: "job-1", Kind: "upgrade", State: "running", Message: "正在校验"}
	if f.jobs == nil {
		f.jobs = map[string]SelfUpdateJob{}
	}
	f.jobs[job.ID] = job
	return job, nil
}

func (f *fakeSelfUpdater) StartRollback(context.Context, string, SelfUpdateRollbackRequest) (SelfUpdateJob, error) {
	if f.rollErr != nil {
		return SelfUpdateJob{}, f.rollErr
	}
	return SelfUpdateJob{ID: "job-rb", Kind: "rollback", State: "running"}, nil
}

func (f *fakeSelfUpdater) UpgradeJob(id string) (SelfUpdateJob, bool) {
	job, ok := f.jobs[id]
	return job, ok
}

// upgradeServer 构造装配 fakeSelfUpdater 的 Server（auth==nil：只测契约与映射）。
func upgradeServer(up *fakeSelfUpdater) *Server {
	return New(Options{Version: "0.1.0-test", Backend: up}, nil)
}

// upgradeRequest 发起一次 JSON 请求。
func upgradeRequest(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// TestUpgradeStatusContract 校验状态端点字段显式、可回滚信息与错误提示。
func TestUpgradeStatusContract(t *testing.T) {
	up := &fakeSelfUpdater{status: SelfUpdateStatus{
		Current:    SelfUpdateBinary{Path: "/opt/kore/kored", SHA256: strings.Repeat("a", 64)},
		Previous:   &SelfUpdateBinary{Path: "/opt/kore/kored.prev", SHA256: strings.Repeat("b", 64)},
		CanUpgrade: true, CanRollback: true,
		Marker: &SelfUpdateMarker{State: "pending", ToSHA256: strings.Repeat("b", 64)},
	}}
	rec := upgradeRequest(t, upgradeServer(up), http.MethodGet, "/api/v1/system/upgrade", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200: %s", rec.Code, rec.Body.String())
	}
	var body SelfUpdateStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if !body.CanUpgrade || !body.CanRollback || body.Previous == nil || body.Marker == nil {
		t.Fatalf("状态字段不完整: %+v", body)
	}
}

// TestUpgradeRequiresConfirm 校验二次确认门：缺 confirm 直接 400 且不发起。
func TestUpgradeRequiresConfirm(t *testing.T) {
	up := &fakeSelfUpdater{}
	rec := upgradeRequest(t, upgradeServer(up), http.MethodPost, "/api/v1/system/upgrade",
		`{"source_path":"/tmp/kored","sha256":"`+strings.Repeat("a", 64)+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d，期望 400: %s", rec.Code, rec.Body.String())
	}
	if up.lastStart.SourcePath != "" {
		t.Fatalf("缺 confirm 时不应调用 StartUpgrade")
	}
}

// TestUpgradeAcceptedAndJob 校验 202 + job 查询链路。
func TestUpgradeAcceptedAndJob(t *testing.T) {
	up := &fakeSelfUpdater{}
	s := upgradeServer(up)
	body := `{"source_path":"/tmp/kored","sha256":"` + strings.Repeat("a", 64) + `","confirm":true}`
	rec := upgradeRequest(t, s, http.MethodPost, "/api/v1/system/upgrade", body)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("状态码 = %d，期望 202: %s", rec.Code, rec.Body.String())
	}
	var job SelfUpdateJob
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil || job.ID == "" {
		t.Fatalf("响应缺少 job id: %v %s", err, rec.Body.String())
	}
	if up.lastStart.SourcePath != "/tmp/kored" || !up.lastStart.Confirm {
		t.Fatalf("请求未透传: %+v", up.lastStart)
	}
	rec = upgradeRequest(t, s, http.MethodGet, "/api/v1/system/upgrade/jobs/"+job.ID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("job 查询状态码 = %d，期望 200", rec.Code)
	}
	rec = upgradeRequest(t, s, http.MethodGet, "/api/v1/system/upgrade/jobs/unknown", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知 job 状态码 = %d，期望 404", rec.Code)
	}
}

// TestUpgradeErrorMapping 校验四类关键错误映射（来源/校验/非 root/审计）。
func TestUpgradeErrorMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code int
		body string
	}{
		{"来源非法", errors.Join(ErrUpgradeSource, errors.New("URL 拒绝")), http.StatusBadRequest, "E_INVALID"},
		{"校验失败", ErrUpgradeChecksum, http.StatusConflict, "E_CONFLICT"},
		{"非 root", ErrUpgradeNeedRoot, http.StatusForbidden, "E_NEED_ROOT"},
		{"审计失败", ErrUpgradeAudit, http.StatusServiceUnavailable, "E_INTERNAL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := &fakeSelfUpdater{startErr: tc.err}
			rec := upgradeRequest(t, upgradeServer(up), http.MethodPost, "/api/v1/system/upgrade",
				`{"source_path":"/tmp/kored","sha256":"`+strings.Repeat("a", 64)+`","confirm":true}`)
			if rec.Code != tc.code {
				t.Fatalf("状态码 = %d，期望 %d: %s", rec.Code, tc.code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.body) {
				t.Fatalf("响应缺少错误码 %s: %s", tc.body, rec.Body.String())
			}
		})
	}
}

// TestUpgradeUnknownFieldRejected 校验 G-24：未知字段不被静默接受。
func TestUpgradeUnknownFieldRejected(t *testing.T) {
	up := &fakeSelfUpdater{}
	rec := upgradeRequest(t, upgradeServer(up), http.MethodPost, "/api/v1/system/upgrade",
		`{"source_path":"/tmp/kored","sha256":"`+strings.Repeat("a", 64)+`","confirm":true,"url":"https://x"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("未知字段状态码 = %d，期望 400", rec.Code)
	}
}

// TestUpgradeUnsupportedBackend 校验未装配时回 501，而不是假装成功。
func TestUpgradeUnsupportedBackend(t *testing.T) {
	s := New(Options{Version: "0.1.0-test", Backend: auditTestBackend{}}, nil)
	rec := upgradeRequest(t, s, http.MethodGet, "/api/v1/system/upgrade", "")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("状态码 = %d，期望 501", rec.Code)
	}
}
