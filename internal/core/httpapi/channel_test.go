package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// channelTestTransport 是通道单测的传输替身：PeerCred 返回注入凭据，不建真 socket。
type channelTestTransport struct {
	cred platform.Cred
	err  error
}

// Listen 不应被通道处理器调用。
func (channelTestTransport) Listen(string) (net.Listener, error) {
	return nil, errors.New("not used")
}

// Dial 不应被通道处理器调用。
func (channelTestTransport) Dial(string) (net.Conn, error) { return nil, errors.New("not used") }

// PeerCred 返回注入的对端凭据。
func (f channelTestTransport) PeerCred(net.Conn) (platform.Cred, error) {
	return f.cred, f.err
}

// channelTestBackend 只实现 RootAction 查询（其余方法由嵌入的 nil 接口占位）。
type channelTestBackend struct {
	Backend
	action pluginapi.RootAction
}

// RootAction 返回预置动作。
func (b channelTestBackend) RootAction(context.Context, string, string) (pluginapi.RootAction, bool, error) {
	return b.action, true, nil
}

// channelTestPrivilege 是提权执行器替身：只记录是否被调用。
type channelTestPrivilege struct {
	called bool
}

// Execute 记录调用并返回成功结果。
func (p *channelTestPrivilege) Execute(context.Context, privilege.Request) (privilege.Result, error) {
	p.called = true
	return privilege.Result{Executed: true, ExitCode: 0, Unit: "kore-root-test"}, nil
}

// Confirm 返回一次性令牌表。
func (p *channelTestPrivilege) Confirm() *privilege.ConfirmStore {
	return privilege.NewConfirmStore(time.Minute)
}

// newChannelTestServer 造一个只启用通道所需的 Server（不启会话鉴权）。
func newChannelTestServer(t *testing.T, transport channelTestTransport, peerUID, peerPID int) (*Server, *channelTestPrivilege) {
	t.Helper()
	exec := &channelTestPrivilege{}
	srv := New(Options{
		Backend:   channelTestBackend{action: pluginapi.RootAction{ID: "ufw-status", Argv: []string{"ufw", "status"}}},
		Privilege: exec,
		PluginAuth: func(token string) (string, []string, bool) {
			if token != "good-token" {
				return "", nil, false
			}
			return "firewall", []string{"system:admin"}, true
		},
		PluginPeer: func(string) (int, int, bool) { return peerUID, peerPID, true },
	}, transport)
	return srv, exec
}

// channelRequest 构造一次通道请求（注入连接的 context 值）。
func channelRequest(t *testing.T, method, path, token string, conn net.Conn) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(`{"action_id":"ufw-status"}`))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req.WithContext(context.WithValue(req.Context(), channelConnKey{}, conn))
}

// TestChannelRejectsNonRootActionPath 验证通道只开放 root-action：其它管理/查询端点一律 404。
func TestChannelRejectsNonRootActionPath(t *testing.T) {
	srv, _ := newChannelTestServer(t, channelTestTransport{}, os.Getuid(), os.Getpid())
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/plugins"},
		{http.MethodGet, "/api/v1/system/info"},
		{http.MethodPost, "/api/v1/plugins/firewall/root-action/ufw-status/confirm-token"},
		{http.MethodPost, "/api/v1/plugins/firewall/enable"},
		{http.MethodPost, "/api/v1/plugins/firewall/root-action/extra"},
	} {
		rec := httptest.NewRecorder()
		srv.channelHandler().ServeHTTP(rec, channelRequest(t, tc.method, tc.path, "good-token", client))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s 应 404，实际 %d", tc.method, tc.path, rec.Code)
		}
	}
}

// TestChannelRequiresBearer 验证通道不认会话 cookie：没有插件 bearer 一律 401。
func TestChannelRequiresBearer(t *testing.T) {
	srv, exec := newChannelTestServer(t, channelTestTransport{}, os.Getuid(), os.Getpid())
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	req := channelRequest(t, http.MethodPost, "/api/v1/plugins/firewall/root-action", "", client)
	req.AddCookie(&http.Cookie{Name: "kore_session", Value: "admin-session"})
	rec := httptest.NewRecorder()
	srv.channelHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 bearer 应 401，实际 %d", rec.Code)
	}
	if exec.called {
		t.Fatal("未通过身份校验时不得执行提权")
	}
}

// TestChannelPeerCredMustMatch 验证 SO_PEERCRED 双校验：uid 或 pid 不符即拒绝。
func TestChannelPeerCredMustMatch(t *testing.T) {
	cases := []struct {
		name string
		cred platform.Cred
	}{
		{"uid 不符", platform.Cred{PID: int32(os.Getpid()), UID: uint32(os.Getuid() + 1)}},
		{"pid 不符", platform.Cred{PID: int32(os.Getpid() + 1), UID: uint32(os.Getuid())}},
		{"凭据不可用", platform.Cred{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			transport := channelTestTransport{cred: tc.cred}
			if tc.name == "凭据不可用" {
				transport.err = errors.New("peercred unavailable")
			}
			srv, exec := newChannelTestServer(t, transport, os.Getuid(), os.Getpid())
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			rec := httptest.NewRecorder()
			srv.channelHandler().ServeHTTP(rec, channelRequest(t, http.MethodPost,
				"/api/v1/plugins/firewall/root-action", "good-token", client))
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("应 401，实际 %d", rec.Code)
			}
			if exec.called {
				t.Fatal("凭据不符时不得执行提权")
			}
		})
	}
}

// TestChannelTokenMustMatchPath 验证 bearer 所属插件必须等于路径里的插件 id。
func TestChannelTokenMustMatchPath(t *testing.T) {
	srv := New(Options{
		Backend: channelTestBackend{},
		PluginAuth: func(token string) (string, []string, bool) {
			return "other-plugin", []string{"system:admin"}, token == "good-token"
		},
		PluginPeer: func(string) (int, int, bool) { return os.Getuid(), os.Getpid(), true },
	}, channelTestTransport{cred: platform.Cred{PID: int32(os.Getpid()), UID: uint32(os.Getuid())}})
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	rec := httptest.NewRecorder()
	srv.channelHandler().ServeHTTP(rec, channelRequest(t, http.MethodPost,
		"/api/v1/plugins/firewall/root-action", "good-token", client))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("token 与路径插件不一致应 401，实际 %d", rec.Code)
	}
}

// TestChannelSuccessReachesRootAction 验证 uid+pid 双校验通过后复用 root-action 执行器。
func TestChannelSuccessReachesRootAction(t *testing.T) {
	transport := channelTestTransport{cred: platform.Cred{PID: int32(os.Getpid()), UID: uint32(os.Getuid())}}
	srv, exec := newChannelTestServer(t, transport, os.Getuid(), os.Getpid())
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	rec := httptest.NewRecorder()
	srv.channelHandler().ServeHTTP(rec, channelRequest(t, http.MethodPost,
		"/api/v1/plugins/firewall/root-action", "good-token", client))
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d body=%s", rec.Code, rec.Body.String())
	}
	if !exec.called {
		t.Fatal("校验通过后应调用提权执行器")
	}
	if !strings.Contains(rec.Body.String(), `"executed":true`) {
		t.Fatalf("响应应透传执行结果: %s", rec.Body.String())
	}
}
