package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// mockRestartService 记录 confirm/restart 调用；绝不触碰 systemd 或真实 unit。
type mockRestartService struct {
	issued     []string
	reasons    []string
	restartErr error
	restarted  int
	unit       string
}

func (m *mockRestartService) ConfirmToken(reason string) (string, time.Time, error) {
	m.issued = append(m.issued, reason)
	return "tok-" + reason, time.Now().Add(5 * time.Minute), nil
}
func (m *mockRestartService) Restart(_ context.Context, _, reason, token string) (RestartResponseBody, error) {
	// 模拟装配层行为：confirm 缺失/不绑定 → 401（真正的核销在 cmd/kored/restartWith）。
	if token == "" || !strings.HasPrefix(token, "tok-") {
		return RestartResponseBody{}, &pluginapi.Error{Code: pluginapi.E_UNAUTHORIZED, Message: "confirm 令牌无效"}
	}
	m.restarted++
	m.reasons = append(m.reasons, reason)
	if m.restartErr != nil {
		return RestartResponseBody{}, m.restartErr
	}
	return RestartResponseBody{Committed: true, Unit: m.unit, Mode: "user", Message: "已提交"}, nil
}
func (m *mockRestartService) Unit() string { return m.unit }

func postJSON(t *testing.T, s *Server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func newRestartTestServer(mock *mockRestartService) *Server {
	s := newTestServer()
	s.restartService = mock
	return s
}

// TestRestartConfirmTokenBindsReason GET confirm-token 签发绑定 reason 的令牌。
func TestRestartConfirmTokenBindsReason(t *testing.T) {
	m := &mockRestartService{unit: "kored-local.service"}
	s := newRestartTestServer(m)
	rec := getJSON(t, s, "/api/v1/system/restart/confirm-token?reason=index_dir")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body confirmTokenBodyWithReason
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Action != "system.restart" || body.Reason != "index_dir" || body.Token == "" {
		t.Fatalf("body=%+v", body)
	}
}

// TestSystemRestartNoConfirm 无 confirm 令牌 → E_UNAUTHORIZED（401）+ deny 审计（由 mock 侧实现保证）。
func TestSystemRestartNoConfirm(t *testing.T) {
	m := &mockRestartService{unit: "kored-local.service"}
	s := newRestartTestServer(m)
	rec := postJSON(t, s, "/api/v1/system/restart", `{"reason":"r"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "E_UNAUTHORIZED") {
		t.Fatalf("body=%s", rec.Body.String())
	}
	if m.restarted != 0 {
		t.Fatalf("无 confirm 不得调用原语，restarted=%d", m.restarted)
	}
}

// TestSystemRestartNoUnit 无 unit → E_NO_SELF_RESTART + hint，不谎称成功。
func TestSystemRestartNoUnit(t *testing.T) {
	m := &mockRestartService{unit: "kored-local.service",
		restartErr: &pluginapi.Error{Code: "E_NO_SELF_RESTART", Message: "没有可用的自重启 unit", Detail: []byte(`{"hint":"本实例不是服务运行，无法自重启"}`)}}
	s := newRestartTestServer(m)
	rec := postJSON(t, s, "/api/v1/system/restart", `{"reason":"r","confirm":"tok-r"}`)
	if !strings.Contains(rec.Body.String(), "E_NO_SELF_RESTART") {
		t.Fatalf("body=%s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "本实例不是服务运行") {
		t.Fatalf("hint 缺失: %s", rec.Body.String())
	}
}

// TestSystemRestartAuditFailureNoCommit 审计写不进 → 不提交重启（fail-closed）。
func TestSystemRestartAuditFailureNoCommit(t *testing.T) {
	m := &mockRestartService{unit: "kored-local.service"}
	s := newRestartTestServer(m)
	// 通过 restartErr 模拟审计失败后拒绝提交（HTTP 层只透传错误，不返回 202）。
	m.restartErr = errors.New("audit bucket unavailable")
	rec := postJSON(t, s, "/api/v1/system/restart", `{"reason":"r","confirm":"tok-r"}`)
	if rec.Code == http.StatusAccepted {
		t.Fatalf("审计失败不得返回已提交: %s", rec.Body.String())
	}
}

// getJSON 发起 GET 请求（复用内存 handler）。
func getJSON(t *testing.T, s *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}
