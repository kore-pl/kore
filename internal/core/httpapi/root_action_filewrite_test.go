package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// noopPrivilegeAuditor 是测试用审计出口（不落库）。
type noopPrivilegeAuditor struct{}

func (noopPrivilegeAuditor) Record(context.Context, privilege.Event) error { return nil }

// noopChangeRecorder 是测试用变更账本出口。
type noopChangeRecorder struct{}

func (noopChangeRecorder) RecordHostChange(context.Context, privilege.HostChange) error { return nil }

// newFileWriteServer 启动一个 root=true、受控写落临时目录的测试服务器（真实 HTTP 栈）。
func newFileWriteServer(t *testing.T, action pluginapi.RootAction, dir string) (*httptest.Server, string, string) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	priv := privilege.New(privilege.Options{
		Auditor: noopPrivilegeAuditor{}, ChangeRecorder: noopChangeRecorder{},
		TempDir: t.TempDir(),
		Root:    func() bool { return true },
		FileWrite: &privilege.FileWriteOptions{
			CopyRoot:     filepath.Join(t.TempDir(), "backups"),
			Policy:       pluginapi.DefaultFileWriteOptions(),
			DirOverrides: map[string]string{"nginx.conf.d": dir},
			OwnerCheck:   func(string, os.FileMode) error { return nil },
		},
	})
	srv := New(Options{
		Version: "0.1.0-filewrite", Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend:   rootActionBackend{action: action},
		Auth:      auth.NewManager(db, auditHash(t), 0, false),
		Privilege: priv,
	}, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"audit-password"}`)))
	var session, csrf string
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case auth.CookieName:
			session = c.Value
		case csrfCookieName:
			csrf = c.Value
		}
	}
	if session == "" || csrf == "" {
		t.Fatalf("登录应同时下发 session 与 csrf cookie（状态 %d）", rec.Code)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, session, csrf
}

// fileWriteHTTPAction 构造 file_write 动作（与 privilege 测试同形）。
func fileWriteHTTPAction() pluginapi.RootAction {
	return pluginapi.RootAction{
		ID: "nginx-write-vhost", WritesHost: true,
		Target:      pluginapi.FileWritePrefixClasses["nginx.conf.d"].Dir,
		Description: "写站点 nginx 片段",
		PurgeOp: &pluginapi.PurgeOp{
			Kind: pluginapi.PurgeKindFileRemove,
			Args: []string{"/etc/nginx/conf.d/kore-firewall-x.conf"},
		},
		FileWrite: &pluginapi.FileWrite{
			PrefixClass:   "nginx.conf.d",
			Mode:          pluginapi.FileWriteModeRoot0644,
			ContentPolicy: pluginapi.ContentPolicyNginxVHost,
		},
	}
}

// TestRootActionBodyLimitRaised 断言 body 上限按 ADR-0052 提到 ≥2 MiB（K3 硬约束 #1）。
func TestRootActionBodyLimitRaised(t *testing.T) {
	if maxRootActionBody < 2<<20 {
		t.Fatalf("maxRootActionBody = %d，必须 ≥2 MiB（256 KiB 正文最坏 JSON 转义 ×6 + 余量）", maxRootActionBody)
	}
}

// TestRootActionDecodedContentSize 断言解码后正文仍按 256 KiB 判：
// 300 KiB 正文能过 HTTP body 上限，但必须被协议硬顶拒绝（不是 413/body too large）。
func TestRootActionDecodedContentSize(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	ts, session, csrf := newFileWriteServer(t, fileWriteHTTPAction(), dir)
	content := strings.Repeat("a", 300*1024)
	body := `{"action_id":"nginx-write-vhost","args":["kore-firewall-x.conf"],"content":"` + content + `"}`
	status, raw := doRootAction(t, ts, session, csrf, body)
	if status != http.StatusBadRequest {
		t.Fatalf("超协议硬顶正文应 400，实际 %d body=%.200s", status, raw)
	}
	var got struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if got.Code != pluginapi.E_INVALID || !strings.Contains(got.Message, "超过") {
		t.Fatalf("应为 E_INVALID + 正文超限说明，实际 %+v", got)
	}
	if strings.Contains(got.Message, "request body too large") {
		t.Fatalf("300 KiB 正文不应撞 HTTP body 上限（说明上限没提升）：%s", got.Message)
	}
}

// TestRootActionBodyTooLarge 断言超过 2 MiB 的请求体被 HTTP 层拒绝。
func TestRootActionBodyTooLarge(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	ts, session, csrf := newFileWriteServer(t, fileWriteHTTPAction(), dir)
	content := strings.Repeat("a", 2*1024*1024+64*1024)
	body := `{"action_id":"nginx-write-vhost","args":["kore-firewall-x.conf"],"content":"` + content + `"}`
	status, raw := doRootAction(t, ts, session, csrf, body)
	if status != http.StatusBadRequest {
		t.Fatalf("超 body 上限应 400，实际 %d", status)
	}
	var got struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v body=%.200s", err, raw)
	}
	if !strings.Contains(got.Message, "request body too large") && !strings.Contains(got.Message, "请求体") {
		t.Fatalf("应为请求体超限错误，实际 %+v", got)
	}
}

// TestRootActionContentOnlyForFileWrite 断言 exec 动作携带 content 被显式拒绝（不静默丢弃）。
func TestRootActionContentOnlyForFileWrite(t *testing.T) {
	action := pluginapi.RootAction{ID: "nginx-test", Argv: []string{"/usr/sbin/nginx", "-t"}, TimeoutS: 10}
	ts, session, csrf := newFileWriteServer(t, action, filepath.Join(t.TempDir(), "conf.d")+"/")
	status, raw := doRootAction(t, ts, session, csrf, `{"action_id":"nginx-test","content":"x"}`)
	if status != http.StatusBadRequest {
		t.Fatalf("exec 动作带 content 应 400，实际 %d body=%.200s", status, raw)
	}
	var got struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if got.Code != pluginapi.E_INVALID || !strings.Contains(got.Message, "file_write") {
		t.Fatalf("应为 E_INVALID + content 仅用于 file_write，实际 %+v", got)
	}
}
