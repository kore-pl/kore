package httpapi

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/store"
)

// 本文件是 UI 集成决策的可复现越权 PoC，只产证据、不改产品代码。
//
// 证据锚点：
//   - docs/SECURITY.md:99  —— kore_csrf 非 HttpOnly，插件 JS 可读
//   - docs/SECURITY.md:110-112 —— 能力只校验 invoke 帧，enable 端点只做"用户确认"
//   - internal/core/httpapi/middleware.go:24-25 —— 仅 /api/v1 查 session
//
// 攻击者模型：仅授 site:read 的插件 JS，与主壳同 origin，能读 kore_csrf、
// 浏览器自动带 session cookie；构造 POST /api/v1/plugins/{system:admin 插件}/enable。
// 三条请求：① 全量（session+csrf+site:read）；② 去 csrf；③ 去 session。
//
// 说明：当前 M1 代码 CSRF 中间件与 invoke 能力校验尚未落地（middleware.go:56-57、
// handlers_invoke.go:28/59 注释指向 M1-14/M1-08），文档描述的是目标设计。
// PoC 照实记录三条状态码，不预设结论。

const (
	pocPassword = "poc-password"
	pocCSRF     = "0123456789abcdef0123456789abcdef" // 插件可读的非 HttpOnly token
	pocAdminID  = "system-admin"                     // 目标 system:admin 插件 id
)

// pocMakeHash 生成测试用 pbkdf2-sha256 口令哈希。
func pocMakeHash(t *testing.T) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key, err := pbkdf2.Key(sha256.New, pocPassword, salt, 1000, 32)
	if err != nil {
		t.Fatalf("派生测试哈希失败: %v", err)
	}
	return "pbkdf2-sha256$1000$" + base64.StdEncoding.EncodeToString(salt) + "$" +
		base64.StdEncoding.EncodeToString(key)
}

// pocBackend 是最小 Backend：记录 Enable 调用，回读插件视图。
// 只读 UNAUTHORIZED 错误由 handler 代码路径产生，本后端不做任何能力校验。
type pocBackend struct {
	enabled   map[string]bool
	enableLog []string
}

func (b *pocBackend) Plugins(_ context.Context) ([]PluginStatus, error) { return nil, nil }

func (b *pocBackend) Plugin(_ context.Context, id string) (PluginStatus, bool, error) {
	if !b.enabled[id] {
		return PluginStatus{}, false, nil
	}
	return PluginStatus{ID: id, State: "ready", Desired: "enabled", Enabled: true}, true, nil
}

func (b *pocBackend) Enable(_ context.Context, id string) error {
	b.enableLog = append(b.enableLog, id)
	b.enabled[id] = true
	return nil
}

func (b *pocBackend) Disable(_ context.Context, id string) error {
	b.enabled[id] = false
	return nil
}

func (b *pocBackend) Invoke(_ context.Context, _, _ string, _ json.RawMessage, _ string) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

func (b *pocBackend) Stats(_ context.Context) (SupervisorStats, error) { return SupervisorStats{}, nil }

// pocRequest 发一条真实 HTTP 请求（httptest.NewServer），返回状态码与响应体。
func pocRequest(t *testing.T, ts *httptest.Server, sessionCookie, csrf string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/plugins/"+pocAdminID+"/enable", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if sessionCookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: sessionCookie})
	}
	if csrf != "" {
		// 插件可读的非 HttpOnly cookie + 同名 header（双提交 token）
		req.AddCookie(&http.Cookie{Name: "kore_csrf", Value: csrf})
		req.Header.Set("X-Kore-CSRF", csrf)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("发送请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	return resp.StatusCode, string(body)
}

// TestUIConfusedDeputy 是可复现 PoC：三条请求的状态码即为证据。
// 本测试不 assert 漏洞成立/不成立，只打印真实结果并校验"鉴权层"是否工作。
func TestUIConfusedDeputy(t *testing.T) {
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开测试状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	mgr := auth.NewManager(db, pocMakeHash(t), 0, false)
	backend := &pocBackend{enabled: make(map[string]bool)}
	srv := New(Options{
		Version:  "0.1.0-poc",
		Report:   envprobe.Report{OS: "linux", Arch: "amd64", Kernel: "6.8.0", CgroupMode: "v2", FSType: "ext4"},
		Backend:  backend,
		Auth:     mgr,
	}, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 登录拿真实 session cookie（与浏览器同构）。
	loginRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(loginRec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"password":"`+pocPassword+`"}`)))
	var sessionCookie string
	for _, c := range loginRec.Result().Cookies() {
		if c.Name == auth.CookieName {
			sessionCookie = c.Value
		}
	}
	if sessionCookie == "" {
		t.Fatalf("登录未下发会话 cookie（状态码 %d，body=%s）", loginRec.Code, loginRec.Body.String())
	}

	// ① site:read 插件身份 + 有效 session + 可读 csrf → 越权 enable 管理插件
	s1, b1 := pocRequest(t, ts, sessionCookie, pocCSRF)
	// ② 去掉 csrf → 对照（按目标设计应 401）
	s2, b2 := pocRequest(t, ts, sessionCookie, "")
	// ③ 带 csrf 但去掉 session → 对照（鉴权层应 401）
	s3, b3 := pocRequest(t, ts, "", pocCSRF)

	verdict := "GREEN（漏洞不成立：enable 被拒）"
	if s1 >= 200 && s1 < 300 {
		verdict = "RED（漏洞成立：仅 site:read 成功启用 system:admin 插件）"
	}
	t.Logf("===== UI CONFUSED-DEPUTY PoC =====")
	t.Logf("攻击者能力: site:read；目标插件: %s (system:admin)", pocAdminID)
	t.Logf("① session+csrf+site:read → HTTP %d | body=%s", s1, strings.TrimSpace(b1))
	t.Logf("② 去 csrf            → HTTP %d | body=%s", s2, strings.TrimSpace(b2))
	t.Logf("③ 去 session          → HTTP %d | body=%s", s3, strings.TrimSpace(b3))
	t.Logf("Enable 调用记录: %v", backend.enableLog)
	t.Logf("结论: %s", verdict)

	// 只断言鉴权层：无 session 必须 401（这证明漏洞在能力层而非鉴权失效）。
	if s3 != http.StatusUnauthorized {
		t.Errorf("对照③ 无 session 应 401，实际 %d（鉴权层异常，需调查）", s3)
	}
	// ① 与 ② 的结果照实输出，不做通过/失败断言——RED/GREEN 由报告记录。
}
