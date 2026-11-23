package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/credential"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// okAuditor 记录型审计出口；测试里始终成功，便于验证正常路径。
type okAuditor struct{ events []credential.AuditEvent }

// Record 记录事件并返回 nil。
func (a *okAuditor) Record(_ context.Context, ev credential.AuditEvent) error {
	a.events = append(a.events, ev)
	return nil
}

// newCredentialServer 组装带真实凭据库的服务器；auth 为 nil 时按 M0 口径放行。
func newCredentialServer(t *testing.T, withAuth bool) (*Server, *credential.Service) {
	t.Helper()
	svc, err := credential.New(credential.Options{Dir: t.TempDir() + "/credentials", Auditor: &okAuditor{}})
	if err != nil {
		t.Fatalf("credential.New: %v", err)
	}
	opts := Options{Version: "0.1.0-test", Credentials: svc}
	if withAuth {
		db, err := store.Open(t.TempDir()+"/state", slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatalf("store.Open: %v", err)
		}
		t.Cleanup(func() { _ = db.Close() })
		opts.Auth = auth.NewManager(db, auditHash(t), 0, false)
	}
	return New(opts, nil), svc
}

// TestCredentialDeleteEndpoint 验证 DELETE 成功、GET 不再列出、重复删除 404。
func TestCredentialDeleteEndpoint(t *testing.T) {
	srv, svc := newCredentialServer(t, false)
	entry, err := svc.Set(t.Context(), "db-mysql", "db-mysql", "mysqlRoot", "MYSQL_PWD", []byte("s3cret"))
	if err != nil {
		t.Fatalf("Set: %v", err)
	}

	rec := serve(t, srv, http.MethodDelete, "/api/v1/credentials/"+entry.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE 状态码 = %d，期望 200；body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Deleted bool   `json:"deleted"`
		ID      string `json:"id"`
	}
	if err := decodeJSON(rec, &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if !body.Deleted || body.ID != entry.ID {
		t.Fatalf("响应 = %+v，期望 deleted=true id=%s", body, entry.ID)
	}

	listRec := serve(t, srv, http.MethodGet, "/api/v1/credentials")
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET 状态码 = %d", listRec.Code)
	}
	var list struct {
		Credentials []struct {
			ID string `json:"id"`
		} `json:"credentials"`
	}
	if err := decodeJSON(listRec, &list); err != nil {
		t.Fatalf("GET 响应不是 JSON: %v", err)
	}
	for _, item := range list.Credentials {
		if item.ID == entry.ID {
			t.Fatalf("删除后 GET 仍含 %s", entry.ID)
		}
	}

	again := serve(t, srv, http.MethodDelete, "/api/v1/credentials/"+entry.ID)
	if again.Code != http.StatusNotFound {
		t.Fatalf("重复删除状态码 = %d，期望 404", again.Code)
	}
}

// TestCredentialDeleteRequiresAdmin 验证未认证会话被拒（与 audit/grant 同口径：401）。
func TestCredentialDeleteRequiresAdmin(t *testing.T) {
	srv, svc := newCredentialServer(t, true)
	entry, err := svc.Set(t.Context(), "db-mysql", "db-mysql", "mysqlRoot", "MYSQL_PWD", []byte("s3cret"))
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	rec := serve(t, srv, http.MethodDelete, "/api/v1/credentials/"+entry.ID)
	if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
		t.Fatalf("无会话 DELETE 状态码 = %d，期望 401/403；body=%s", rec.Code, rec.Body.String())
	}
	var apiErr struct {
		Code string `json:"code"`
	}
	_ = decodeJSON(rec, &apiErr)
	if apiErr.Code != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("错误码 = %q，期望 %s", apiErr.Code, pluginapi.E_UNAUTHORIZED)
	}
	if _, err := svc.List(t.Context(), "admin", "db-mysql"); err != nil {
		t.Fatalf("被拒后凭据应仍存在: %v", err)
	}
}

// TestCredentialListIncludesTimestamps 验证列表项带 RFC3339 的 createdAt/updatedAt，
// 且任何读响应都不出现 secret 字段或口令值（ADR-0026 §3：secret 永不回显）。
func TestCredentialListIncludesTimestamps(t *testing.T) {
	srv, svc := newCredentialServer(t, false)
	const secretValue = "s3cret-e2e-value"
	entry, err := svc.Set(t.Context(), "db-mysql", "db-mysql", "mysqlRoot", "MYSQL_PWD", []byte(secretValue))
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	rec := serve(t, srv, http.MethodGet, "/api/v1/credentials?owner=db-mysql")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET 状态码 = %d；body=%s", rec.Code, rec.Body.String())
	}
	raw := rec.Body.String()
	if strings.Contains(raw, secretValue) || strings.Contains(raw, `"secret"`) {
		t.Fatalf("读响应泄漏 secret：%s", raw)
	}
	var body struct {
		Credentials []struct {
			ID        string `json:"id"`
			CreatedAt string `json:"createdAt"`
			UpdatedAt string `json:"updatedAt"`
		} `json:"credentials"`
	}
	if err := decodeJSON(rec, &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if len(body.Credentials) != 1 || body.Credentials[0].ID != entry.ID {
		t.Fatalf("列表 = %+v，期望含 %s", body.Credentials, entry.ID)
	}
	for _, field := range []string{body.Credentials[0].CreatedAt, body.Credentials[0].UpdatedAt} {
		if _, err := time.Parse(time.RFC3339, field); err != nil {
			t.Fatalf("时间字段 %q 不是 RFC3339: %v", field, err)
		}
	}
}

// decodeJSON 从响应体解 JSON。
func decodeJSON(rec *httptest.ResponseRecorder, dst any) error {
	return json.Unmarshal(rec.Body.Bytes(), dst)
}
