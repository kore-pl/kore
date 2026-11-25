package httpapi

// ADR-0057 T4 真接口链路测试：公开验证码端点 + 挑战态 + 一次性校验 + 阶梯延时 + 成功清零。
import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
)

const t4Password = "correct-horse-battery"

func t4Server(t *testing.T) (*Server, *auth.CaptchaStore) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "state"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hash, err := auth.HashPassword(t4Password)
	if err != nil {
		t.Fatal(err)
	}
	mgr := auth.NewManager(st, hash, time.Hour, false)
	caps := auth.NewCaptchaStore()
	srv := New(Options{Auth: mgr, LoginLimiter: auth.NewLoginLimiter(1, time.Minute, 5*time.Minute), Captchas: caps}, nil)
	return srv, caps
}

func postT4Login(t *testing.T, srv *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body)))
	return rec
}

func loginBody(username, password, id, answer string) string {
	b, _ := json.Marshal(map[string]string{
		"username": username, "password": password, "captcha_id": id, "captcha_answer": answer,
	})
	return string(b)
}

func issueT4Captcha(t *testing.T, srv *Server) (string, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/captcha", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("captcha endpoint = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body captchaBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ID == "" || !strings.HasPrefix(body.Image, "data:image/png;base64,") {
		t.Fatalf("captcha body missing fields: %+v", body)
	}
	var a, b int
	if _, err := fmt.Sscanf(body.TextQuestion, "%d + %d = ?", &a, &b); err != nil {
		t.Fatal(err)
	}
	return body.ID, fmt.Sprintf("%d", a+b)
}

func TestT4CaptchaEndpointPublic(t *testing.T) {
	srv, _ := t4Server(t)
	id, _ := issueT4Captcha(t, srv)
	if len(id) != 32 {
		t.Fatalf("captcha_id = %q, want 32 hex chars", id)
	}
}

func TestT4TriggerCaptchaAndClearOnSuccess(t *testing.T) {
	srv, caps := t4Server(t)
	first := postT4Login(t, srv, loginBody("admin", "wrong", "", ""))
	if first.Code != http.StatusUnauthorized || !strings.Contains(first.Body.String(), "请输入右侧验证码") {
		t.Fatalf("first wrong = %d %s", first.Code, first.Body.String())
	}
	if !caps.Required() {
		t.Fatal("captcha.required should be true after first wrong password")
	}
	missing := postT4Login(t, srv, loginBody("admin", "wrong", "", ""))
	if missing.Code != http.StatusPreconditionRequired || !strings.Contains(missing.Body.String(), codeCaptchaRequired) {
		t.Fatalf("missing captcha = %d %s", missing.Code, missing.Body.String())
	}
	id, _ := issueT4Captcha(t, srv)
	wrong := postT4Login(t, srv, loginBody("admin", "wrong", id, "ZZZZZ"))
	if wrong.Code != http.StatusUnauthorized || !strings.Contains(wrong.Body.String(), codeCaptchaInvalid) {
		t.Fatalf("wrong captcha = %d %s", wrong.Code, wrong.Body.String())
	}
	id, answer := issueT4Captcha(t, srv)
	ok := postT4Login(t, srv, loginBody("admin", t4Password, id, answer))
	if ok.Code != http.StatusOK {
		t.Fatalf("correct login = %d %s", ok.Code, ok.Body.String())
	}
	if caps.Required() {
		t.Fatal("captcha.required should be cleared after success")
	}
	if rec := postT4Login(t, srv, loginBody("admin", t4Password, "", "")); rec.Code != http.StatusOK {
		t.Fatalf("login after clear = %d %s", rec.Code, rec.Body.String())
	}
}

func TestT4AccountCheckDoesNotTouchBucket(t *testing.T) {
	srv, caps := t4Server(t)
	for i := 0; i < 3; i++ {
		rec := postT4Login(t, srv, loginBody("root", "whatever", "", ""))
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "账号或口令错误") {
			t.Fatalf("wrong username = %d %s", rec.Code, rec.Body.String())
		}
	}
	if caps.Required() {
		t.Fatal("wrong username must not trigger captcha")
	}
	if rec := postT4Login(t, srv, loginBody("admin", t4Password, "", "")); rec.Code != http.StatusOK {
		t.Fatalf("correct login after wrong usernames = %d %s", rec.Code, rec.Body.String())
	}
}

func TestT4RateLimitNumbers(t *testing.T) {
	want := []time.Duration{0, 1, 2, 4, 8, 16, 30, 30}
	for i, w := range want {
		if got := auth.PenaltyFor(1, i+1); got != w*time.Second {
			t.Fatalf("strike %d delay = %v, want %v", i+1, got, w*time.Second)
		}
	}
}

func TestT4AuditIDPrefix(t *testing.T) {
	id := "abcdef0123456789"
	if got := captchaIDPrefix(id); got != "abcdef01" || got == id {
		t.Fatalf("captcha audit prefix = %q", got)
	}
}
