package httpapi

// 文件名保留说明（不改名）：nopass 指 ADR-0041 时期的「本机通道免密登录」，
// 该机制已被 ADR-0043 删除；本文件现在锁定的恰是它的反面——UDS / loopback /
// 远程未登录一律 401，登录一次后所有操作（含 root 特权动作）免密。
// 保留旧文件名是为了让历史提交与 ADR 证据里的测试名引用仍可追溯，
// 改名会让证据链断在这里。
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/platform"
)

// localTestTransport 是测试用 Transport：PeerCred 固定返回合规的 UDS 对端凭据
// （uid = 本进程 uid，pid 硬编码 1，本机通道判定只比对 uid），让真实 UDS 连接
// 通过 local_access.go 的「uid == socket 属主 / root」检查，从而走通本机通道
// 识别路径（UDS 的 CSRF 令牌引导与 CSRF 豁免都依赖这一步）。
// 该凭据不产生任何身份：ADR-0043 之后 /api/v1/* 一律会话校验，未登录仍 401
// （见 TestLocalChannelsRequireSession）。
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

// loginTokenForTest 走真实登录端点换会话 token（RemoteAddr 设为远程，确保
// 测试拿到的 token 只来自口令校验，不依赖任何本机捷径）。
func loginTokenForTest(t *testing.T, srv *Server) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"username":"admin","password":"`+localTestPassword+`"}`))
	req.RemoteAddr = "203.0.113.9:5555"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("登录应成功，实际 %d %s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.CookieName && c.Value != "" {
			return c.Value
		}
	}
	t.Fatal("登录未下发会话 cookie")
	return ""
}

// TestLocalChannelsRequireSession 是 ADR-0043 的核心回归（更正 ADR-0041
// 「本机免密 = 免登录」的误读）：UDS / loopback / 远程**都必须先登录**，
// 未登录一律 401；同一请求带上有效会话后 200。
func TestLocalChannelsRequireSession(t *testing.T) {
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

	// 未登录：UDS 无 cookie → 401（旧行为是 200，本用例锁定纠正）。
	resp, err := udsClient.Get("http://unix/api/v1/plugins")
	if err != nil {
		t.Fatalf("UDS 请求失败: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("UDS 无 cookie 应 401，实际 %d", resp.StatusCode)
	}

	// 未登录：loopback TCP → 401。
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	resp2, err := ts.Client().Get(ts.URL + "/api/v1/plugins")
	if err != nil {
		t.Fatalf("loopback 请求失败: %v", err)
	}
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("loopback 无 cookie 应 401，实际 %d", resp2.StatusCode)
	}

	token := loginTokenForTest(t, srv)

	// 登录后：UDS 带会话 → 200。
	req, _ := http.NewRequest(http.MethodGet, "http://unix/api/v1/plugins", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	resp3, err := udsClient.Do(req)
	if err != nil {
		t.Fatalf("UDS 带会话请求失败: %v", err)
	}
	_ = resp3.Body.Close()
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("UDS 带会话应 200，实际 %d", resp3.StatusCode)
	}

	// 登录后：loopback 带会话 → 200。
	req2, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/plugins", nil)
	req2.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	resp4, err := ts.Client().Do(req2)
	if err != nil {
		t.Fatalf("loopback 带会话请求失败: %v", err)
	}
	_ = resp4.Body.Close()
	if resp4.StatusCode != http.StatusOK {
		t.Fatalf("loopback 带会话应 200，实际 %d", resp4.StatusCode)
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

// TestLocalCSRFPolicy 覆盖安全边界：loopback 仍强制 CSRF（浏览器就在本机），
// UDS 因浏览器不可达而豁免 CSRF——但 UDS 未登录仍 401，只是原因不是 CSRF。
func TestLocalCSRFPolicy(t *testing.T) {
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
	// UDS POST 无 CSRF / 无会话 → 401，但原因是未登录而不是 CSRF。
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/echo/enable", strings.NewReader("{}"))
	req2.RemoteAddr = "@"
	rec2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("UDS 未登录 POST 应 401，实际 %d", rec2.Code)
	}
	if strings.Contains(rec2.Body.String(), "CSRF") {
		t.Fatalf("UDS POST 不应被 CSRF 拦下: %d %s", rec2.Code, rec2.Body.String())
	}
}

// TestSessionSlideRenewsCookie 覆盖滑动续期的新阈值语义 min(24h, TTL/2)：
// 1h TTL 的阈值是 30m——新签发会话剩余 ~1h，不得每次鉴权都重发 Set-Cookie
// （那等于每个请求写一次 bbolt）；剩余跌破 30m 后才重发，Max-Age 仍按 TTL。
// 旧断言锁定的是"1h < 24h → 每次都续期"，即写放大本身，故按新语义重写。
func TestSessionSlideRenewsCookie(t *testing.T) {
	const ttl = time.Hour
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := New(Options{
		Auth:       auth.NewManager(db, hashForLocalTest(t), ttl, false),
		Backend:    auditTestBackend{},
		Version:    "0.1.0-nopass",
		SocketPath: filepath.Join(t.TempDir(), "kore.sock"),
	}, localTestTransport{})

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"username":"admin","password":"`+localTestPassword+`"}`))
	login.RemoteAddr = "203.0.113.9:5555"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, login)
	if rec.Code != http.StatusOK {
		t.Fatalf("登录应成功，实际 %d %s", rec.Code, rec.Body.String())
	}
	var token string
	var loginCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.CookieName {
			token, loginCookie = c.Value, c
		}
	}
	if token == "" || loginCookie == nil {
		t.Fatal("登录未下发会话 cookie")
	}
	// 登录 cookie 仍按其 TTL 下发，不随阈值改动。
	if loginCookie.MaxAge != int(ttl.Seconds()) {
		t.Fatalf("登录 cookie Max-Age 应为 %d，实际 %d", int(ttl.Seconds()), loginCookie.MaxAge)
	}

	// 带 cookie 的鉴权请求。
	authGet := func() (*httptest.ResponseRecorder, *http.Cookie) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins", nil)
		req.RemoteAddr = "203.0.113.9:5555"
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		r := httptest.NewRecorder()
		srv.Handler().ServeHTTP(r, req)
		var got *http.Cookie
		for _, c := range r.Result().Cookies() {
			if c.Name == auth.CookieName {
				got = c
			}
		}
		return r, got
	}

	// 新会话剩余 ~1h >= 30m 阈值：连续 3 次鉴权都不得重发 Set-Cookie（不写库）。
	for i := 0; i < 3; i++ {
		r, renewed := authGet()
		if r.Code != http.StatusOK {
			t.Fatalf("第 %d 次带 cookie 请求应 200，实际 %d", i, r.Code)
		}
		if renewed != nil {
			t.Fatalf("第 %d 次鉴权剩余未跌破阈值却重发了 Set-Cookie（短 TTL 写放大）", i)
		}
	}

	// 把存储里的 expiry 改到剩余 10m（< 30m 阈值），模拟"已经用了一阵"。
	// 会话仍未过期，故下一次鉴权必须续期并重发 cookie。
	now := time.Now().UTC()
	sum := sha256.Sum256([]byte(token))
	key := hex.EncodeToString(sum[:])
	value := strconv.FormatInt(now.Add(10*time.Minute).UnixNano(), 10) + " " +
		strconv.FormatInt(now.Add(-50*time.Minute).UnixNano(), 10)
	if err := db.Update(func(tx *store.Tx) error { return tx.Put("sessions", key, []byte(value)) }); err != nil {
		t.Fatalf("改写会话失败: %v", err)
	}
	r, renewed := authGet()
	if r.Code != http.StatusOK {
		t.Fatalf("剩余 10m 的会话应仍有效，实际 %d", r.Code)
	}
	if renewed == nil {
		t.Fatal("剩余寿命低于阈值时应重发 Set-Cookie（滑动续期）")
	}
	if renewed.Value != token {
		t.Fatal("续期不得更换 token")
	}
	if renewed.MaxAge != int(ttl.Seconds()) {
		t.Fatalf("续期 cookie Max-Age 应为 %d，实际 %d", int(ttl.Seconds()), renewed.MaxAge)
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
