package httpapi

// 管理入口的 handler/集成测试（DESIGN-TOKEN-IP-BIND §6.2）：创建回显、列表回读、
// 非法 400、PUT 三态与「改完下一次请求即生效」、清空恢复、删除幂等。
import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
)

type tokenCreateBody struct {
	Password     string   `json:"password"`
	Name         string   `json:"name"`
	Scope        string   `json:"scope"`
	AllowedCIDRs []string `json:"allowed_cidrs,omitempty"`
}

type tokenUpdateBody struct {
	Password     string    `json:"password"`
	AllowedCIDRs *[]string `json:"allowed_cidrs,omitempty"`
}

type tokenCreatedResp struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Token        string   `json:"token"`
	Scope        string   `json:"scope"`
	AllowedCIDRs []string `json:"allowed_cidrs"`
}

type tokenListResp struct {
	Tokens []auth.TokenView `json:"tokens"`
}

func tokenAPICall(srv *Server, token, method, path string, body any, remote string) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+token)
	if remote != "" {
		req.RemoteAddr = remote
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func tokenAPIManager(t *testing.T, srv *Server, sec *auth.Security) string {
	t.Helper()
	plain, _, err := sec.CreateToken("mgr", "admin", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return plain
}

func TestTokenCreateCIDRsEchoAndList(t *testing.T) {
	srv, sec := securityTestServer(t)
	mgr := tokenAPIManager(t, srv, sec)
	req := tokenCreateBody{Password: "correct-horse-battery", Name: "ci", Scope: "admin",
		AllowedCIDRs: []string{"203.0.113.0/24", "198.51.100.7"}}
	rec := tokenAPICall(srv, mgr, http.MethodPost, "/api/v1/security/tokens", req, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("创建失败: %d %s", rec.Code, rec.Body.String())
	}
	var created tokenCreatedResp
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	want := []string{"198.51.100.7/32", "203.0.113.0/24"}
	if !reflect.DeepEqual(created.AllowedCIDRs, want) {
		t.Fatalf("创建回显不对: %#v", created.AllowedCIDRs)
	}
	// 列表回显同一份绑定（且不含 token/hash）。
	listRec := tokenAPICall(srv, mgr, http.MethodGet, "/api/v1/security/tokens", nil, "")
	if listRec.Code != http.StatusOK {
		t.Fatalf("列表失败: %d %s", listRec.Code, listRec.Body.String())
	}
	var list tokenListResp
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	// mgr + ci 两条，找到 ci。
	found := false
	for _, v := range list.Tokens {
		if v.ID == created.ID {
			found = true
			if !reflect.DeepEqual(v.AllowedCIDRs, want) {
				t.Fatalf("列表绑定不对: %#v", v.AllowedCIDRs)
			}
		}
	}
	if !found {
		t.Fatalf("列表未包含新 token: %+v", list.Tokens)
	}
	if bytes.Contains(listRec.Body.Bytes(), []byte(created.Token)) {
		t.Fatal("列表不应回显明文 token")
	}
}

func TestTokenCreateInvalidCIDR400(t *testing.T) {
	srv, sec := securityTestServer(t)
	mgr := tokenAPIManager(t, srv, sec)
	for _, cidrs := range [][]string{{"::/0"}, {"not-an-ip"}, {"0.0.0.0/0"}, {"fe80::1%eth0"}} {
		rec := tokenAPICall(srv, mgr, http.MethodPost, "/api/v1/security/tokens",
			tokenCreateBody{Password: "correct-horse-battery", Name: "ci", Scope: "admin", AllowedCIDRs: cidrs}, "")
		if rec.Code != http.StatusBadRequest || !bytes.Contains(rec.Body.Bytes(), []byte(`E_INVALID`)) {
			t.Fatalf("非法 %v 应 400 E_INVALID，实际 %d: %s", cidrs, rec.Code, rec.Body.String())
		}
	}
	listRec := tokenAPICall(srv, mgr, http.MethodGet, "/api/v1/security/tokens", nil, "")
	var list tokenListResp
	_ = json.Unmarshal(listRec.Body.Bytes(), &list)
	if len(list.Tokens) != 1 { // 只有 mgr
		t.Fatalf("非法创建不应落库: %+v", list.Tokens)
	}
}

func TestTokenUpdateThreeStatesAndImmediateEffect(t *testing.T) {
	srv, sec := securityTestServer(t)
	mgr := tokenAPIManager(t, srv, sec)
	created := tokenAPICall(srv, mgr, http.MethodPost, "/api/v1/security/tokens",
		tokenCreateBody{Password: "correct-horse-battery", Name: "bound", Scope: "admin",
			AllowedCIDRs: []string{"203.0.113.0/24"}}, "")
	var body tokenCreatedResp
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	plain, id := body.Token, body.ID
	path := "/api/v1/security/tokens/" + id
	check := func(remote string, wantOK bool, stage string) {
		t.Helper()
		rec := tokenAPICall(srv, plain, http.MethodGet, "/api/v1/system/info", nil, remote)
		if wantOK && rec.Code == http.StatusUnauthorized {
			t.Fatalf("%s: %s 应放行，实际 401", stage, remote)
		}
		if !wantOK && rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: %s 应 401，实际 %d", stage, remote, rec.Code)
		}
	}
	check("203.0.113.9:1234", true, "初始 A")
	check("198.51.100.7:1234", false, "初始 B")

	// 缺省：不改。
	rec := tokenAPICall(srv, mgr, http.MethodPut, path, tokenUpdateBody{Password: "correct-horse-battery"}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("缺省更新失败: %d %s", rec.Code, rec.Body.String())
	}
	check("203.0.113.9:1234", true, "缺省后 A")
	check("198.51.100.7:1234", false, "缺省后 B")

	// 非空替换：下一次请求即时生效。
	replace := []string{"198.51.100.7"}
	rec = tokenAPICall(srv, mgr, http.MethodPut, path,
		tokenUpdateBody{Password: "correct-horse-battery", AllowedCIDRs: &replace}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("替换失败: %d %s", rec.Code, rec.Body.String())
	}
	var view auth.TokenView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(view.AllowedCIDRs, []string{"198.51.100.7/32"}) {
		t.Fatalf("更新响应不对: %#v", view.AllowedCIDRs)
	}
	check("203.0.113.9:1234", false, "替换后 A")
	check("198.51.100.7:1234", true, "替换后 B")

	// 空数组：清除，任意 IP 恢复可用。
	empty := []string{}
	rec = tokenAPICall(srv, mgr, http.MethodPut, path,
		tokenUpdateBody{Password: "correct-horse-battery", AllowedCIDRs: &empty}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("清空失败: %d %s", rec.Code, rec.Body.String())
	}
	check("203.0.113.9:1234", true, "清空后 A")
	check("192.0.2.99:1234", true, "清空后任意 IP")

	// 非法 CIDR 400 + 不改既有（此时无绑定，先绑回 A 再验证）。
	setA := []string{"203.0.113.0/24"}
	_ = tokenAPICall(srv, mgr, http.MethodPut, path,
		tokenUpdateBody{Password: "correct-horse-battery", AllowedCIDRs: &setA}, "")
	bad := []string{"::/0"}
	rec = tokenAPICall(srv, mgr, http.MethodPut, path,
		tokenUpdateBody{Password: "correct-horse-battery", AllowedCIDRs: &bad}, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非法 CIDR 应 400，实际 %d: %s", rec.Code, rec.Body.String())
	}
	check("203.0.113.9:1234", true, "非法更新后 A 仍可用")
	check("198.51.100.7:1234", false, "非法更新后 B 仍拒绝")

	// 错口令 401 / 不存在 id 400。
	rec = tokenAPICall(srv, mgr, http.MethodPut, path,
		tokenUpdateBody{Password: "wrong", AllowedCIDRs: &empty}, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("错口令应 401，实际 %d: %s", rec.Code, rec.Body.String())
	}
	rec = tokenAPICall(srv, mgr, http.MethodPut, "/api/v1/security/tokens/deadbeef",
		tokenUpdateBody{Password: "correct-horse-battery", AllowedCIDRs: &empty}, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("未知 id 应 400，实际 %d: %s", rec.Code, rec.Body.String())
	}

	// 删除仍幂等。
	for i := 0; i < 2; i++ {
		rec = tokenAPICall(srv, mgr, http.MethodDelete, path, nil, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("删除第 %d 次应 200，实际 %d: %s", i+1, rec.Code, rec.Body.String())
		}
	}
	check("203.0.113.9:1234", false, "删除后")
}
