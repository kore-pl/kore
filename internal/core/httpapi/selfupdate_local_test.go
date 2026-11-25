package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/platform"
)

// ---- 测试替身：连接 / 传输 / 审计 ----

// localUpdateAddr 让 net.Pipe 包装连接看起来是 UDS（LocalAddr.Network()=="unix"）。
type localUpdateAddr struct{}

func (localUpdateAddr) Network() string { return "unix" }
func (localUpdateAddr) String() string  { return "@selfupdate-test" }

// localUpdateTestConn 把普通连接包装成"看起来是 UDS"的连接（isUnixConn 走 LocalAddr 判定）。
type localUpdateTestConn struct {
	net.Conn
	isUnix bool
}

func (c localUpdateTestConn) LocalAddr() net.Addr {
	if c.isUnix {
		return localUpdateAddr{}
	}
	return c.Conn.LocalAddr()
}

// localUpdateTestTransport 返回注入的 peercred（可模拟合法 uid / 伪造 uid / 取不到）。
type localUpdateTestTransport struct {
	cred platform.Cred
	err  error
}

func (localUpdateTestTransport) Listen(string) (net.Listener, error) {
	return nil, errors.New("not used")
}
func (localUpdateTestTransport) Dial(string) (net.Conn, error) {
	return nil, errors.New("not used")
}
func (t localUpdateTestTransport) PeerCred(net.Conn) (platform.Cred, error) {
	return t.cred, t.err
}

// localUpdateAuditRecorder 记录专用端点的审计事件，可注入写失败（fail-closed 验证）。
type localUpdateAuditRecorder struct {
	events []AuditEvent
	err    error
}

func (r *localUpdateAuditRecorder) Record(ev AuditEvent) error {
	if r.err != nil {
		return r.err
	}
	r.events = append(r.events, ev)
	return nil
}

// ---- 测试构造 ----

func localUpdateCred(uid int32) platform.Cred {
	return platform.Cred{PID: int32(os.Getpid()), UID: uint32(uid), GID: 0}
}

// newLocalUpdateTestServer 构造专用端点服务器：后端是 fakeSelfUpdater（可断言是否被调用），
// 审计走可注入 recorder，能力 resolver 默认只授予单一专用能力。
func newLocalUpdateTestServer(t *testing.T, transport platform.Transport, recorder *localUpdateAuditRecorder) (*Server, *fakeSelfUpdater) {
	t.Helper()
	up := &fakeSelfUpdater{}
	srv := New(Options{
		Version:                      "0.1.0-test",
		Backend:                      up,
		Auth:                         auth.NewManager(nil, "", 0, false), // 专用端点不过 withAuth；仅为结构完整
		SelfUpdateSocket:             filepathForTest(t),
		SelfUpdateAuditRecorder:      recorder,
		SelfUpdateCapabilityResolver: func(int32) []string { return []string{selfUpdateCapability} },
	}, transport)
	return srv, up
}

func filepathForTest(t *testing.T) string {
	t.Helper()
	return t.TempDir() + "/kore-selfupdate.sock"
}

// localUpdateRequest 构造带连接对象的专用端点请求（POST + JSON body）。
func localUpdateRequest(t *testing.T, isUnix bool, body string) *http.Request {
	t.Helper()
	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	req := httptest.NewRequest(http.MethodPost, localUpdatePath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	conn := localUpdateTestConn{Conn: server, isUnix: isUnix}
	return req.WithContext(context.WithValue(req.Context(), selfUpdateConnKey{}, conn))
}

const localUpdateValidBody = `{"source_path":"/tmp/kored","sha256":"` + sha256ForTest + `","version":"0.1.2","confirm":true}`

const sha256ForTest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// ---- 正反例 ----

// TestLocalUpdateHappyPath 验证合法 UDS + 可信 uid + 单一专用能力 + confirm → 202 + job，
// 并写一条 system.self_update 审计（result=ok）。
func TestLocalUpdateHappyPath(t *testing.T) {
	recorder := &localUpdateAuditRecorder{}
	srv, up := newLocalUpdateTestServer(t, localUpdateTestTransport{cred: localUpdateCred(int32(os.Getuid()))}, recorder)
	rec := httptest.NewRecorder()
	srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, localUpdateValidBody))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("状态码 = %d，期望 202: %s", rec.Code, rec.Body.String())
	}
	if up.lastStart.SourcePath != "/tmp/kored" || !up.lastStart.Confirm {
		t.Fatalf("请求未透传共享 Updater: %+v", up.lastStart)
	}
	if len(recorder.events) != 1 || recorder.events[0].Action != auditActionSelfUpdate || recorder.events[0].Result != auditResultOK {
		t.Fatalf("审计事件不符: %+v", recorder.events)
	}
}

// TestLocalUpdateRejectsNonUnixConn 验证 loopback TCP / 非 UDS 连接冒用专用端点 → 401，
// 且共享 Updater 未被调用（连接来源是第一道门）。
func TestLocalUpdateRejectsNonUnixConn(t *testing.T) {
	recorder := &localUpdateAuditRecorder{}
	srv, up := newLocalUpdateTestServer(t, localUpdateTestTransport{cred: localUpdateCred(0)}, recorder)
	rec := httptest.NewRecorder()
	srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, false, localUpdateValidBody))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("非 UDS 应 401，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if up.lastStart.SourcePath != "" {
		t.Fatal("非 UDS 不得调用共享 Updater")
	}
}

// TestLocalUpdatePeerCredMustBeTrusted 验证 SO_PEERCRED 身份门：
// 合法 uid（self / root）放行；伪造 uid（既非 0 也非 self）→ 403；
// 取不到凭据 → 401。任一失败都不得调用共享 Updater。
func TestLocalUpdatePeerCredMustBeTrusted(t *testing.T) {
	cases := []struct {
		name       string
		transport  platform.Transport
		wantStatus int
		wantCall   bool
	}{
		{"合法 uid(self)", localUpdateTestTransport{cred: localUpdateCred(int32(os.Getuid()))}, http.StatusAccepted, true},
		{"合法 uid(root)", localUpdateTestTransport{cred: localUpdateCred(0)}, http.StatusAccepted, true},
		{"伪造 uid", localUpdateTestTransport{cred: localUpdateCred(int32(os.Getuid()) + 1)}, http.StatusForbidden, false},
		{"凭据不可用", localUpdateTestTransport{err: errors.New("peercred unavailable")}, http.StatusUnauthorized, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &localUpdateAuditRecorder{}
			srv, up := newLocalUpdateTestServer(t, tc.transport, recorder)
			rec := httptest.NewRecorder()
			srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, localUpdateValidBody))
			if rec.Code != tc.wantStatus {
				t.Fatalf("状态码 = %d，期望 %d: %s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if (up.lastStart.SourcePath != "") != tc.wantCall {
				t.Fatalf("共享 Updater 调用状态不符: want=%v got=%v", tc.wantCall, up.lastStart.SourcePath)
			}
		})
	}
}

// TestLocalUpdateCapabilityIsolation 验证专用能力隔离（CVE-2025-54424 教训）：
// 会话的 6 项 admin 能力不能自动授予专用通道； resolver 返回 admin 全权 / 多项能力
// 时一律拒绝，只有恰好一项 system:self_update 才放行。
func TestLocalUpdateCapabilityIsolation(t *testing.T) {
	// 会话能力集永不包含专用能力（双向隔离的第一半）。
	if hasCapability(adminCapabilities, selfUpdateCapability) {
		t.Fatal("专用能力不得并入会话的 6 项 admin 能力集")
	}
	if isPublicPath(localUpdatePath) {
		t.Fatal("专用端点不得进入公开门白名单")
	}

	cases := []struct {
		name       string
		granted    []string
		wantStatus int
	}{
		{"单一专用能力", []string{selfUpdateCapability}, http.StatusAccepted},
		{"会话 admin 全权", append([]string{}, adminCapabilities...), http.StatusForbidden},
		{"专用能力混 admin", []string{selfUpdateCapability, "system:admin"}, http.StatusForbidden},
		{"空能力集", []string{}, http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &localUpdateAuditRecorder{}
			transport := localUpdateTestTransport{cred: localUpdateCred(int32(os.Getuid()))}
			up := &fakeSelfUpdater{}
			srv := New(Options{
				Version:                      "0.1.0-test",
				Backend:                      up,
				SelfUpdateSocket:             filepathForTest(t),
				SelfUpdateAuditRecorder:      recorder,
				SelfUpdateCapabilityResolver: func(int32) []string { return tc.granted },
			}, transport)
			rec := httptest.NewRecorder()
			srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, localUpdateValidBody))
			if rec.Code != tc.wantStatus {
				t.Fatalf("状态码 = %d，期望 %d: %s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus == http.StatusForbidden && up.lastStart.SourcePath != "" {
				t.Fatal("能力校验失败不得调用共享 Updater")
			}
		})
	}
}

// TestLocalUpdateAuditNoCredentials 验证审计无凭据字段：detail 只含 channel /
// capability / target_version，subject 只含 uid，不含口令 / token / 源路径 / sha 原文。
func TestLocalUpdateAuditNoCredentials(t *testing.T) {
	recorder := &localUpdateAuditRecorder{}
	srv, _ := newLocalUpdateTestServer(t, localUpdateTestTransport{cred: localUpdateCred(int32(os.Getuid()))}, recorder)
	rec := httptest.NewRecorder()
	srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, localUpdateValidBody))
	if len(recorder.events) != 1 {
		t.Fatalf("审计事件数 = %d，期望 1", len(recorder.events))
	}
	ev := recorder.events[0]
	if len(ev.Detail) != 3 || ev.Detail["channel"] != localUpdateChannel ||
		ev.Detail["capability"] != selfUpdateCapability || ev.Detail["target_version"] != "0.1.2" {
		t.Fatalf("审计 detail 字段不符: %+v", ev.Detail)
	}
	if !strings.HasPrefix(ev.Subject, "uid:") || ev.Subject != "uid:"+strconv.Itoa(os.Getuid()) {
		t.Fatalf("审计 subject 不符: %s", ev.Subject)
	}
	// 凭据字段零出现（按值核对，不用字符串包含避免误判 uid 数字）。
	for key := range ev.Detail {
		for _, forbidden := range []string{"password", "secret", "token", "confirm", "source_path", "sha256"} {
			if strings.EqualFold(key, forbidden) {
				t.Fatalf("审计 detail 出现禁字段 %q", key)
			}
		}
	}
}

// TestLocalUpdateAuditFailClosed 验证 ADR-0058 §3.1.5：审计写不进 → 503 且更新未执行。
func TestLocalUpdateAuditFailClosed(t *testing.T) {
	recorder := &localUpdateAuditRecorder{err: errors.New("audit storage unavailable")}
	srv, up := newLocalUpdateTestServer(t, localUpdateTestTransport{cred: localUpdateCred(0)}, recorder)
	rec := httptest.NewRecorder()
	srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, localUpdateValidBody))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("审计失败应 503，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if up.lastStart.SourcePath != "" {
		t.Fatal("审计写失败时不得执行更新")
	}
}

// TestLocalUpdateRequiresConfirm 验证高危二次确认：缺 confirm → 400，不调用 Updater。
func TestLocalUpdateRequiresConfirm(t *testing.T) {
	recorder := &localUpdateAuditRecorder{}
	srv, up := newLocalUpdateTestServer(t, localUpdateTestTransport{cred: localUpdateCred(0)}, recorder)
	body := `{"source_path":"/tmp/kored","sha256":"` + sha256ForTest + `"}`
	rec := httptest.NewRecorder()
	srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("缺 confirm 应 400，实际 %d", rec.Code)
	}
	if up.lastStart.SourcePath != "" || len(recorder.events) != 0 {
		t.Fatal("缺 confirm 不得执行更新或写成功审计")
	}
}

// TestLocalUpdateUnwiredAudit 验证未注入审计出口时回 503（fail-closed，不裸奔）。
func TestLocalUpdateUnwiredAudit(t *testing.T) {
	up := &fakeSelfUpdater{}
	srv := New(Options{Version: "0.1.0-test", Backend: up, SelfUpdateSocket: filepathForTest(t)},
		localUpdateTestTransport{cred: localUpdateCred(0)})
	rec := httptest.NewRecorder()
	srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, localUpdateValidBody))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("审计出口未装配应 503，实际 %d", rec.Code)
	}
	if up.lastStart.SourcePath != "" {
		t.Fatal("审计出口未装配不得执行更新")
	}
}

// TestPublicGateUnchangedOverUDS 是 ADR-0058 §3.1 / ADR-0043 的核心回归：
// 专用更新端点上线后，公开门零变化——未登录经真实 UDS 访问
// POST /api/v1/store/install 仍返回 401（不是 200/403/501）。
// 用真实 curl --unix-socket 发起，与验收命令同形。
func TestPublicGateUnchangedOverUDS(t *testing.T) {
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skipf("curl 不可用: %v", err)
	}
	// 隔离实例：独立 state / socket，全落 t.TempDir（G-29：不碰主实例运行态）。
	dir := t.TempDir()
	logger := newTestLoggerForLocalUpdate()
	db, err := store.Open(filepath.Join(dir, "state"), logger)
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	sock := filepath.Join(dir, "kore.sock")
	srv := New(Options{
		Version:      "0.1.0-test",
		SocketPath:   sock,
		Auth:         auth.NewManager(db, hashForLocalTest(t), time.Hour, false),
		Backend:      auditTestBackend{},
		Market:       nil, // store/install 未装配 → 但鉴权在前，未登录应 401
	}, localTestTransport{})
	if err := srv.Start(); err != nil {
		t.Fatalf("启动隔离 UDS 失败: %v", err)
	}
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	curlArgs := []string{"--unix-socket", sock, "-i", "-sS", "-X", "POST",
		"-H", "Content-Type: application/json", "-d", `{"id":"echo","version":"0.1.0"}`,
		"http://localhost/api/v1/store/install"}
	t.Logf("验收命令: curl %s", strings.Join(curlArgs, " "))
	out, err := exec.Command("curl", curlArgs...).CombinedOutput()
	if err != nil {
		t.Fatalf("curl UDS 失败: %v, out=%s", err, string(out))
	}
	// 取状态行（HTTP/1.1 401 ...）。
	firstLine := strings.SplitN(string(out), "\r\n", 2)[0]
	t.Logf("curl 输出首行: %s", firstLine)
	if !strings.Contains(firstLine, " 401") {
		t.Fatalf("未登录 UDS store/install 应 401，实际: %s", firstLine)
	}
}

// newTestLoggerForLocalUpdate 返回丢弃日志的 slog.Logger（隔离实例状态库需要）。
func newTestLoggerForLocalUpdate() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestLocalUpdateRejectsLoopbackTCP 验证 loopback TCP 冒用专用端点被拒（401）：
// 真实 httptest.NewServer（回环 TCP）不注入 UDS ConnContext，专用处理器拿不到
// 连接对象 → 第一道门即拒绝（连接来源不是 UDS）。
func TestLocalUpdateRejectsLoopbackTCP(t *testing.T) {
	recorder := &localUpdateAuditRecorder{}
	srv, up := newLocalUpdateTestServer(t, localUpdateTestTransport{cred: localUpdateCred(0)}, recorder)
	ts := httptest.NewServer(srv.selfUpdateHandlerForTest())
	t.Cleanup(ts.Close)
	resp, err := ts.Client().Post(ts.URL+localUpdatePath, "application/json", strings.NewReader(localUpdateValidBody))
	if err != nil {
		t.Fatalf("loopback 请求失败: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("loopback TCP 冒用专用端点应 401，实际 %d", resp.StatusCode)
	}
	if up.lastStart.SourcePath != "" {
		t.Fatal("loopback TCP 不得调用共享 Updater")
	}
}

// TestLocalUpdateUnwiredBackend 验证后端未装配时回 501（不假装成功、不写 ok 审计）。
func TestLocalUpdateUnwiredBackend(t *testing.T) {
	recorder := &localUpdateAuditRecorder{}
	srv := New(Options{
		Version:                 "0.1.0-test",
		SelfUpdateSocket:        filepathForTest(t),
		SelfUpdateAuditRecorder: recorder,
	}, localUpdateTestTransport{cred: localUpdateCred(0)})
	rec := httptest.NewRecorder()
	srv.selfUpdateHandlerForTest().ServeHTTP(rec, localUpdateRequest(t, true, localUpdateValidBody))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("后端未装配应 501，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if len(recorder.events) != 0 {
		t.Fatal("后端未装配不应写 ok 审计")
	}
}
