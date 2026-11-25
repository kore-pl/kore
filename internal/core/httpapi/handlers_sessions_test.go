package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
)

// loginWithCookies 走真实登录端点拿会话与 CSRF cookie（写操作要用双提交头）。
func loginWithCookies(t *testing.T, srv *Server) (session, csrfc *http.Cookie) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username":"admin","password": "correct-horse-battery"})
	req := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "203.0.113.7:5555"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("登录失败 %d: %s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case auth.CookieName:
			session = c
		case csrfCookieName:
			csrfc = c
		}
	}
	if session == nil || csrfc == nil {
		t.Fatalf("登录未下发会话或 CSRF cookie: session=%v csrf=%v", session, csrfc)
	}
	return session, csrfc
}

// withCookies 给请求带上会话 cookie；写请求再带 CSRF 双提交头。
func withCookies(req *http.Request, session, csrf *http.Cookie) *http.Request {
	req.AddCookie(session)
	if csrf != nil {
		req.AddCookie(csrf)
		req.Header.Set(csrfHeaderName, csrf.Value)
	}
	return req
}

// TestSecuritySessionsListAndRevoke 覆盖会话列表 / 踢单个 / 拒绝踢当前 / 一键全踢。
func TestSecuritySessionsListAndRevoke(t *testing.T) {
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
	srv := New(Options{Auth: mgr}, nil)

	session, csrf := loginWithCookies(t, srv)

	// 再签发两个"其它设备"的会话（带来源 IP/UA）。
	for _, ip := range []string{"198.51.100.2", "198.51.100.3"} {
		if _, _, err := mgr.IssueWithMeta(auth.SessionMeta{IP: ip, UserAgent: "TestBrowser/1.0"}); err != nil {
			t.Fatalf("签发会话失败: %v", err)
		}
	}

	// 列表：3 个会话，当前会话被标记，来源 IP 有值。
	req := withCookies(httptest.NewRequest("GET", sessionsPath, nil), session, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("会话列表应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var list sessionListBody
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("解析会话列表失败: %v", err)
	}
	if list.Count != 3 {
		t.Fatalf("应有 3 个会话，实际 %d", list.Count)
	}
	current := 0
	var otherID string
	for _, s := range list.Sessions {
		if s.Current {
			current++
			if s.IP == "" {
				t.Fatal("当前会话应带来源 IP")
			}
			continue
		}
		otherID = s.ID
		if s.UserAgent == "" {
			t.Fatal("会话应带 UA 摘要")
		}
	}
	if current != 1 {
		t.Fatalf("应恰好一个会话标记为当前，实际 %d", current)
	}

	// 踢其它会话：200 + revoked=true。
	req = withCookies(httptest.NewRequest("DELETE", sessionsPath+"/"+otherID, nil), session, csrf)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("踢下线应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}

	// 踢当前会话：必须被拒（提示用退出登录）。
	req = withCookies(httptest.NewRequest("GET", sessionsPath, nil), session, nil)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	var currentID string
	for _, s := range list.Sessions {
		if s.Current {
			currentID = s.ID
		}
	}
	req = withCookies(httptest.NewRequest("DELETE", sessionsPath+"/"+currentID, nil), session, csrf)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("踢当前会话应 400，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("退出登录")) {
		t.Fatalf("拒绝文案应告诉用户用退出登录: %s", rec.Body.String())
	}

	// 一键全踢：此时只剩当前会话，revoked=0；再补一个后应能踢掉。
	body, _ := json.Marshal(struct{}{})
	req = withCookies(httptest.NewRequest("POST", sessionRevokeOthersPath, bytes.NewReader(body)), session, csrf)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("一键全踢应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if _, _, err := mgr.IssueWithMeta(auth.SessionMeta{IP: "192.0.2.44"}); err != nil {
		t.Fatalf("签发会话失败: %v", err)
	}
	req = withCookies(httptest.NewRequest("POST", sessionRevokeOthersPath, bytes.NewReader(body)), session, csrf)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	var revoked sessionsRevokedBody
	if err := json.Unmarshal(rec.Body.Bytes(), &revoked); err != nil {
		t.Fatalf("解析一键全踢响应失败: %v", err)
	}
	if revoked.Revoked != 1 {
		t.Fatalf("应踢掉 1 个其它会话，实际 %d", revoked.Revoked)
	}
	if sessions, _ := mgr.ListSessions(); len(sessions) != 1 {
		t.Fatalf("一键全踢后应只剩当前会话，实际 %d", len(sessions))
	}
}

// TestSecurityOverviewBody 覆盖账户状态总览的字段与语义。
func TestSecurityOverviewBody(t *testing.T) {
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
	srv := New(Options{Auth: mgr}, nil)
	session, _ := loginWithCookies(t, srv)

	req := withCookies(httptest.NewRequest("GET", securityOverviewPath, nil), session, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("总览应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var body securityOverviewBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析总览失败: %v", err)
	}
	if body.Password.Score != auth.PasswordScoreUnknown || body.Password.Label != "未评估" {
		t.Fatalf("新实例口令应未评估: %+v", body.Password)
	}
	if body.Password.MinLength != passwordMinLen {
		t.Fatalf("口令最小长度应为 %d，实际 %d", passwordMinLen, body.Password.MinLength)
	}
	if body.TwoFactor.Enabled || body.TwoFactor.RecoveryCodesLeft != 0 {
		t.Fatalf("两步验证默认应关闭: %+v", body.TwoFactor)
	}
	if body.Tokens.Count != 0 || body.IPAllow.Enabled {
		t.Fatalf("token / 白名单默认应为空: %+v %+v", body.Tokens, body.IPAllow)
	}
	if body.Sessions.Active != 1 || body.Sessions.CurrentID == "" {
		t.Fatalf("应恰好 1 个活跃会话并给出当前 id: %+v", body.Sessions)
	}
}

// fakeAuditLister 是测试用审计查询后端（按 action / since 过滤，支持升降序与 limit）。
type fakeAuditLister struct{ rows []AuditRecordView }

func (f fakeAuditLister) ListAudit(q AuditQuery) (AuditPage, error) {
	var out []AuditRecordView
	for _, row := range f.rows {
		if q.Action != "" && row.Action != q.Action {
			continue
		}
		if !q.Since.IsZero() {
			at, err := time.Parse(time.RFC3339Nano, auditAt(row.Key))
			if err != nil || at.Before(q.Since) {
				continue
			}
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		if q.Desc {
			return out[i].Key > out[j].Key
		}
		return out[i].Key < out[j].Key
	})
	total := len(out)
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return AuditPage{Records: out, Total: total}, nil
}

// auditRow 造一条审计记录；seq 只用于同一纳秒内的排序稳定。
func auditRow(at time.Time, seq int, action, result string, detail map[string]string) AuditRecordView {
	return AuditRecordView{
		Key:    fmt.Sprintf("%020d-%06d", at.UnixNano(), seq),
		Action: action, Result: result, Detail: detail,
	}
}

// TestLoginRecordsFlags 覆盖登录记录的合并排序与异常标记口径。
func TestLoginRecordsFlags(t *testing.T) {
	now := time.Now().UTC()
	rows := []AuditRecordView{
		auditRow(now.Add(-3*time.Hour), 0, auditActionLoginSuccess, auditResultOK,
			map[string]string{"ip": "203.0.113.x", "user_agent": "UA-old"}),
		auditRow(now.Add(-2*time.Hour), 1, auditActionLoginFailed, auditResultDenied,
			map[string]string{"ip": "198.51.100.x", "reason": "wrong_password", "user_agent": "UA-a"}),
		auditRow(now.Add(-110*time.Minute), 2, auditActionLoginFailed, auditResultDenied,
			map[string]string{"ip": "198.51.100.x", "reason": "wrong_password", "user_agent": "UA-a"}),
		auditRow(now.Add(-100*time.Minute), 3, auditActionLoginFailed, auditResultDenied,
			map[string]string{"ip": "198.51.100.x", "reason": "rate_limited", "user_agent": "UA-a"}),
		auditRow(now.Add(-time.Hour), 4, auditActionLoginSuccess, auditResultOK,
			map[string]string{"ip": "203.0.113.x", "user_agent": "UA-new"}),
		auditRow(now.Add(-30*time.Minute), 5, auditActionLoginSuccess, auditResultOK,
			map[string]string{"ip": "192.0.2.x", "user_agent": "UA-other"}),
	}
	lister := fakeAuditLister{rows: rows}
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
	srv := New(Options{Auth: auth.NewManager(st, hash, time.Hour, false), AuditLister: lister}, nil)
	session, _ := loginWithCookies(t, srv)

	req := withCookies(httptest.NewRequest("GET", loginRecordsPath+"?limit=20&days=7", nil), session, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("登录记录应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var body loginRecordsBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析登录记录失败: %v", err)
	}
	if !body.IPMasked {
		t.Fatal("应声明 IP 为脱敏网段")
	}
	if body.Count != len(rows) {
		t.Fatalf("应有 %d 条记录，实际 %d", len(rows), body.Count)
	}
	if body.Records[0].At <= body.Records[len(body.Records)-1].At {
		t.Fatal("记录应按时间倒序（最新优先）")
	}
	var sawNewNetwork, sawBurst, sawRate bool
	for _, r := range body.Records {
		if r.Result == "ok" {
			if r.Reason != "登录成功" {
				t.Fatalf("成功记录的原因应为「登录成功」，实际 %q", r.Reason)
			}
		}
		for _, f := range r.Flags {
			switch f {
			case "new_network":
				sawNewNetwork = true
			case "fail_burst":
				sawBurst = true
			case "rate_limited":
				sawRate = true
			}
		}
	}
	if !sawNewNetwork {
		t.Fatal("192.0.2.x 是 30 天内首次出现的网段，应标 new_network")
	}
	if !sawBurst {
		t.Fatal("同网段 3 次失败应标 fail_burst")
	}
	if !sawRate {
		t.Fatal("触发失败延迟的记录应标 rate_limited")
	}

	// 参数校验：超上限 / 非法值一律 400。
	req = withCookies(httptest.NewRequest("GET", loginRecordsPath+"?limit=9999", nil), session, nil)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("limit 超上限应 400，实际 %d", rec.Code)
	}
	req = withCookies(httptest.NewRequest("GET", loginRecordsPath+"?days=abc", nil), session, nil)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("days 非法应 400，实际 %d", rec.Code)
	}
}

// TestLoginRecordsWithoutAuditBackend 审计未装配时如实回 501，不伪造空列表。
func TestLoginRecordsWithoutAuditBackend(t *testing.T) {
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
	srv := New(Options{Auth: auth.NewManager(st, hash, time.Hour, false)}, nil)
	session, _ := loginWithCookies(t, srv)
	req := withCookies(httptest.NewRequest("GET", loginRecordsPath, nil), session, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("未装配审计后端应 501，实际 %d: %s", rec.Code, rec.Body.String())
	}
}
