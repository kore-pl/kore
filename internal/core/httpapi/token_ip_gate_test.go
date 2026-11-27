package httpapi

// API token 来源绑定门的中间件测试矩阵（DESIGN-TOKEN-IP-BIND §6.2）。
// 只取 TCP 对端、拒绝全部转发头、回环不隐式放行、UDS 走 SO_PEERCRED 且 fail-closed、
// 门在 scope/能力判定之前、审计复用 capability.denied 且不编造能力名。
import (
	"bytes"
	"context"
	"errors"
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

type tokenGateAudit struct {
	subject, plugin, target, capability, reason string
}

type tokenIPTestTransport struct {
	cred platform.Cred
	err  error
}

func (tokenIPTestTransport) Listen(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}
func (tokenIPTestTransport) Dial(path string) (net.Conn, error) { return net.Dial("unix", path) }
func (f tokenIPTestTransport) PeerCred(net.Conn) (platform.Cred, error) {
	return f.cred, f.err
}

// tokenIPTestConn 借嵌入的 nil net.Conn 满足接口，只覆盖 LocalAddr 让 isUnixConn
// 判定为 UDS；SO_PEERCRED 由 tokenIPTestTransport 注入，不建真 socket。
type tokenIPTestConn struct{ net.Conn }

type tokenIPTestUnixAddr struct{}

func (tokenIPTestUnixAddr) Network() string { return "unix" }
func (tokenIPTestUnixAddr) String() string  { return "@" }

func (tokenIPTestConn) LocalAddr() net.Addr { return tokenIPTestUnixAddr{} }

func tokenGateTestServer(t *testing.T, transport platform.Transport, audits *[]tokenGateAudit) (*Server, *auth.Security) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "state"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hash, err := auth.HashPassword("correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	mgr := auth.NewManager(st, hash, time.Hour, false)
	srv := New(Options{Auth: mgr, CapabilityAuditor: func(subject, plugin, target, capability, reason string) {
		if audits != nil {
			*audits = append(*audits, tokenGateAudit{subject, plugin, target, capability, reason})
		}
	}}, transport)
	return srv, mgr.Security()
}

func tokenGateCall(srv *Server, plain, method, path, remote string, headers map[string]string, conn net.Conn) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	if remote != "" {
		req.RemoteAddr = remote
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if conn != nil {
		req = req.WithContext(context.WithValue(req.Context(), connKey{}, &connInfo{conn: conn}))
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func tokenGateAssertDenied(t *testing.T, rec *httptest.ResponseRecorder, audits []tokenGateAudit) {
	t.Helper()
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"E_UNAUTHORIZED"`) ||
		!strings.Contains(rec.Body.String(), "API 令牌不允许从此网络地址使用") {
		t.Fatalf("期望 401 E_UNAUTHORIZED，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if len(audits) != 1 {
		t.Fatalf("期望 1 条拒绝审计，实际 %+v", audits)
	}
	a := audits[0]
	if a.reason != "token_ip_denied" || a.capability != "" || a.plugin != "" || a.target != "" ||
		!strings.HasPrefix(a.subject, "token:") {
		t.Fatalf("审计字段不对: %+v", a)
	}
}

func TestTokenIPGateHitAndDeny(t *testing.T) {
	var audits []tokenGateAudit
	srv, sec := tokenGateTestServer(t, nil, &audits)
	plain, rec0, err := sec.CreateTokenWithCIDRs("ci", "admin", time.Hour, []string{"203.0.113.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	// 命中：放行，进入后续能力判定（system/info 成功）。
	rec := tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", "203.0.113.9:1234", nil, nil)
	if rec.Code == http.StatusUnauthorized {
		t.Fatalf("命中网段应放行，实际 401: %s", rec.Body.String())
	}
	if len(audits) != 0 {
		t.Fatalf("命中不应写拒绝审计: %+v", audits)
	}
	// 未命中：401 + 审计（capability="" / reason=token_ip_denied）。
	audits = nil
	rec = tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", "198.51.100.7:1234", nil, nil)
	tokenGateAssertDenied(t, rec, audits)
	if audits[0].subject != "token:"+rec0.ID {
		t.Fatalf("审计 subject 不对: %q", audits[0].subject)
	}
}

func TestTokenIPGateEmptyBindingCompatible(t *testing.T) {
	srv, sec := tokenGateTestServer(t, nil, nil)
	plain, _, err := sec.CreateToken("ci", "read", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for _, remote := range []string{"198.51.100.7:1234", "127.0.0.1:1234", "@", "malformed"} {
		rec := tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", remote, nil, nil)
		if rec.Code == http.StatusUnauthorized {
			t.Fatalf("无绑定应按现状放行，remote=%q 实际 401: %s", remote, rec.Body.String())
		}
	}
}

func TestTokenIPGateLoopbackNotImplicit(t *testing.T) {
	var audits []tokenGateAudit
	srv, sec := tokenGateTestServer(t, nil, &audits)
	plain, _, err := sec.CreateTokenWithCIDRs("ci", "admin", time.Hour, []string{"203.0.113.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	for _, remote := range []string{"127.0.0.1:1234", "[::1]:1234"} {
		audits = nil
		rec := tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", remote, nil, nil)
		tokenGateAssertDenied(t, rec, audits)
	}
}

func TestTokenIPGateForwardedHeadersIgnored(t *testing.T) {
	var audits []tokenGateAudit
	srv, sec := tokenGateTestServer(t, nil, &audits)
	plain, _, err := sec.CreateTokenWithCIDRs("ci", "admin", time.Hour, []string{"203.0.113.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, remote, header, value string
	}{
		{"远端 + XFF", "198.51.100.7:1234", "X-Forwarded-For", "203.0.113.9"},
		{"回环 + XFF", "127.0.0.1:1234", "X-Forwarded-For", "203.0.113.9"},
		{"远端 + X-Real-IP", "198.51.100.7:1234", "X-Real-IP", "203.0.113.9"},
		{"远端 + Forwarded", "198.51.100.7:1234", "Forwarded", "for=203.0.113.9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			audits = nil
			rec := tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", tc.remote,
				map[string]string{tc.header: tc.value}, nil)
			tokenGateAssertDenied(t, rec, audits)
		})
	}
}

func TestTokenIPGateUDS(t *testing.T) {
	compliant := tokenIPTestTransport{cred: platform.Cred{PID: 1, UID: uint32(os.Getuid()), GID: 0}}
	cases := []struct {
		name      string
		transport platform.Transport
		conn      net.Conn
		remote    string
		allow     bool
	}{
		{"合规 UDS 豁免", compliant, tokenIPTestConn{}, "@", true},
		{"uid 不合规", tokenIPTestTransport{cred: platform.Cred{PID: 1, UID: uint32(os.Getuid() + 1)}}, tokenIPTestConn{}, "@", false},
		{"取不到凭据", tokenIPTestTransport{err: errors.New("no peercred")}, tokenIPTestConn{}, "@", false},
		{"无 conn 且不可解析 RemoteAddr", compliant, nil, "@", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var audits []tokenGateAudit
			srv, sec := tokenGateTestServer(t, tc.transport, &audits)
			plain, _, err := sec.CreateTokenWithCIDRs("ci", "admin", time.Hour, []string{"203.0.113.0/24"})
			if err != nil {
				t.Fatal(err)
			}
			rec := tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", tc.remote, nil, tc.conn)
			if tc.allow {
				if rec.Code == http.StatusUnauthorized || len(audits) != 0 {
					t.Fatalf("合规 UDS 应豁免，实际 %d: %s / audits=%+v", rec.Code, rec.Body.String(), audits)
				}
				return
			}
			tokenGateAssertDenied(t, rec, audits)
		})
	}
}

func TestTokenIPGateMappedAndMalformedPeer(t *testing.T) {
	var audits []tokenGateAudit
	srv, sec := tokenGateTestServer(t, nil, &audits)
	plain, _, err := sec.CreateTokenWithCIDRs("ci", "admin", time.Hour, []string{"127.0.0.1/32"})
	if err != nil {
		t.Fatal(err)
	}
	// IPv4-mapped IPv6 对端归一后命中。
	for _, remote := range []string{"[::ffff:127.0.0.1]:1234", "::ffff:127.0.0.1"} {
		audits = nil
		rec := tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", remote, nil, nil)
		if rec.Code == http.StatusUnauthorized {
			t.Fatalf("映射地址应命中，remote=%q 实际 401: %s", remote, rec.Body.String())
		}
	}
	// 畸形 RemoteAddr：fail-closed。
	audits = nil
	rec := tokenGateCall(srv, plain, http.MethodGet, "/api/v1/system/info", "not-an-addr", nil, nil)
	tokenGateAssertDenied(t, rec, audits)
}

func TestTokenIPGateBeforeScopeCheck(t *testing.T) {
	var audits []tokenGateAudit
	srv, sec := tokenGateTestServer(t, nil, &audits)
	plain, _, err := sec.CreateTokenWithCIDRs("ci", "read", time.Hour, []string{"203.0.113.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	// 绑定不匹配 + read token 写请求：先 401，不是 403。
	rec := tokenGateCall(srv, plain, http.MethodPost, "/api/v1/auth/password", "198.51.100.7:1234", nil, nil)
	tokenGateAssertDenied(t, rec, audits)
}

func TestTokenIPGateNoSessionFallback(t *testing.T) {
	srv, sec := tokenGateTestServer(t, nil, nil)
	// 1ns TTL + RFC3339 秒精度落库 → ExpiresAt 落在当前秒起点，校验时已过期。
	plain, _, err := sec.CreateToken("expired", "admin", time.Nanosecond)
	if err != nil {
		t.Fatal(err)
	}
	// 登录拿有效会话 cookie。
	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		bytes.NewReader([]byte(`{"username":"admin","password":"correct-horse-battery"}`)))
	loginRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(loginRec, login)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("登录失败: %d %s", loginRec.Code, loginRec.Body.String())
	}
	cookies := loginRec.Result().Cookies()
	var session *http.Cookie
	for _, c := range cookies {
		if c.Name == auth.CookieName {
			session = c
		}
	}
	if session == nil {
		t.Fatal("未拿到会话 cookie")
	}
	// 过期 token + 有效会话：不回退会话，仍 401。
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("过期 token 不应回退会话，实际 %d: %s", rec.Code, rec.Body.String())
	}
}
