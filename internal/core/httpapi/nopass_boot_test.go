package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/platform"
)

// localTestTransport 是测试用 Transport：PeerCred 一律回本进程 uid/pid，
// 使 UDS 免密的"属主即管理员"分支可被测（真实机测由 curl --unix-socket 覆盖）。
type localTestTransport struct{}

func (localTestTransport) Listen(path string) (net.Listener, error) { return net.Listen("unix", path) }
func (localTestTransport) Dial(path string) (net.Conn, error)       { return net.Dial("unix", path) }
func (localTestTransport) PeerCred(net.Conn) (platform.Cred, error) {
	return platform.Cred{PID: int32(1), UID: uint32(uidForTest()), GID: 0}, nil
}

func uidForTest() int { return os.Getuid() }

// newLocalTestServer 装配带真实 auth 的最小服务器（会话/CSRF 中间件齐全）。
func newLocalTestServer(t *testing.T, ttl time.Duration) *Server {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(Options{
		Auth:       auth.NewManager(db, hashForLocalTest(t), ttl, false),
		Backend:    auditTestBackend{},
		Version:    "0.1.0-nopass",
		SocketPath: filepath.Join(t.TempDir(), "kore.sock"),
	}, localTestTransport{})
}

// TestUDSAccessBypassesSessionTCPDoesNot 是 ADR-0041 的核心回归：
// UDS 无 cookie → 200；非 loopback TCP 无 cookie → 401；伪造 XFF 无效。
func TestUDSAccessBypassesSessionTCPDoesNot(t *testing.T) {
	srv := newLocalTestServer(t, time.Hour)
	sock := filepath.Join(t.TempDir(), "kore.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("监听 UDS 失败: %v", err)
	}
	go func() { _ = srv.httpServer.Serve(ln) }()
	t.Cleanup(func() { _ = ln.Close() })

	udsClient := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	resp, err := udsClient.Get("http://unix/api/v1/plugins")
	if err != nil {
		t.Fatalf("UDS 请求失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("UDS 无 cookie 应 200，实际 %d", resp.StatusCode)
	}

	// loopback TCP（httptest 默认 127.0.0.1）→ 200。
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	resp2, err := ts.Client().Get(ts.URL + "/api/v1/plugins")
	if err != nil {
		t.Fatalf("loopback 请求失败: %v", err)
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("loopback 无 cookie 应 200，实际 %d", resp2.StatusCode)
	}

	// 非 loopback TCP → 401；伪造 X-Forwarded-For: 127.0.0.1 同样 401。
	for _, name := range []string{"remote", "forged-xff"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins", nil)
		req.RemoteAddr = "203.0.113.9:5555"
		if name == "forged-xff" {
			req.Header.Set("X-Forwarded-For", "127.0.0.1")
			req.Header.Set("X-Real-IP", "127.0.0.1")
		}
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s 无 cookie 应 401，实际 %d", name, rec.Code)
		}
	}
}

// TestLoopbackKeepsCSRFUDSExempt 覆盖安全边界：loopback 仍强制 CSRF，
// UDS 因浏览器不可达而豁免。
func TestLoopbackKeepsCSRFUDSExempt(t *testing.T) {
	srv := newLocalTestServer(t, time.Hour)
	// loopback POST 无 CSRF → 401 且原因为 CSRF。
	req := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/echo/enable", strings.NewReader("{}"))
	req.RemoteAddr = "127.0.0.1:5555"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("loopback 无 CSRF 应 401，实际 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "CSRF") {
		t.Fatalf("loopback 401 应来自 CSRF 校验，实际 %s", rec.Body.String())
	}
	// UDS POST 无 CSRF / 无 cookie → 不应被 CSRF 拦成 401。
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/echo/enable", strings.NewReader("{}"))
	req2.RemoteAddr = "@"
	rec2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, req2)
	if rec2.Code == http.StatusUnauthorized && strings.Contains(rec2.Body.String(), "CSRF") {
		t.Fatalf("UDS POST 不应被 CSRF 拦下: %d %s", rec2.Code, rec2.Body.String())
	}
}

// hashForLocalTest 生成测试口令哈希；localTestPassword 与之一致。
const localTestPassword = "nopass-test-password"

func hashForLocalTest(t *testing.T) string {
	t.Helper()
	h, err := auth.HashPassword(localTestPassword)
	if err != nil {
		t.Fatalf("生成口令哈希失败: %v", err)
	}
	return h
}
