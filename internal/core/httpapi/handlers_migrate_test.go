package httpapi

import (
	"reflect"
	"strings"
	"testing"
)

// forbiddenExportWords 是 G-30 凭据红线在导出 schema 中的关键词黑名单。
var forbiddenExportWords = []string{"password", "token", "secret", "credential", "admin_password_hash"}

// assertNoCredentialFields 递归检查实际导出结构体的 json tag 与 Go 字段名，
// 杜绝未来有人往 payload 里加凭据字段（对真实 struct 反射，而非硬编码清单自证）。
func assertNoCredentialFields(t *testing.T, v interface{}, seen map[uintptr]bool) {
	t.Helper()
	rv := reflect.ValueOf(v)
	rt := rv.Type()
	if rt.Kind() == reflect.Ptr {
		if rv.IsNil() {
			return
		}
		if seen[rv.Pointer()] {
			return
		}
		seen[rv.Pointer()] = true
		rv, rt = rv.Elem(), rt.Elem()
	}
	if rt.Kind() != reflect.Struct {
		return
	}
	for i := 0; i < rt.NumField(); i++ {
		f := rt.Field(i)
		name := strings.ToLower(f.Name)
		tag := strings.ToLower(f.Tag.Get("json"))
		for _, word := range forbiddenExportWords {
			if strings.Contains(name, word) || strings.Contains(tag, word) {
				t.Fatalf("导出 schema 字段 %s 含凭据词 %q（tag=%s，G-30 禁止）", f.Name, word, tag)
			}
		}
		if f.Type.Kind() == reflect.Struct || (f.Type.Kind() == reflect.Ptr && f.Type.Elem().Kind() == reflect.Struct) {
			assertNoCredentialFields(t, reflect.New(f.Type).Interface(), seen)
		}
	}
}

// TestMigrateExportSchemaRedaction 校验导出结构的字段名与 json tag 均不含凭据（G-30）。
func TestMigrateExportSchemaRedaction(t *testing.T) {
	assertNoCredentialFields(t, migrateManifest{}, map[uintptr]bool{})
}

// TestValidateMigrateFormatAndVersion 覆盖导入校验的可读失败原因：格式 / schema / 摘要 / 版本。
func TestValidateMigrateFormatAndVersion(t *testing.T) {
	payload := migratePayload{Config: migrateConfig{Profile: "portable"}, Plugins: []migratePlugin{}}
	sha, err := manifestSHA(payload)
	if err != nil {
		t.Fatal(err)
	}
	good := migrateManifest{Format: migrateFormat, SchemaVersion: migrateSchemaVersion,
		KoreVersion: "0.1.1", SHA256: sha, Payload: payload}

	// 正例：同主版本 + 摘要一致 → 兼容。
	if p, ok := validateMigrate(good, "0.1.1"); !ok || !p.Compatible || !p.SHAOK {
		t.Fatalf("合法文件应通过：%+v ok=%t", p, ok)
	}

	// 格式不符 → 可读原因。
	bad := good
	bad.Format = "other-format"
	if p, ok := validateMigrate(bad, "0.1.1"); ok || !strings.Contains(p.Reason, "不是 Kore") {
		t.Fatalf("格式错误应拒绝并给可读原因：%+v ok=%t", p, ok)
	}

	// schema 版本不兼容 → 原因含具体版本。
	bad = good
	bad.SchemaVersion = 99
	if p, ok := validateMigrate(bad, "0.1.1"); ok || !strings.Contains(p.Reason, "版本不兼容") {
		t.Fatalf("schema 不匹配应拒绝：%+v ok=%t", p, ok)
	}

	// 摘要不匹配 → 明确提示可能损坏。
	bad = good
	bad.SHA256 = strings.Repeat("0", 64)
	if p, ok := validateMigrate(bad, "0.1.1"); ok || !strings.Contains(p.Reason, "校验值不匹配") {
		t.Fatalf("摘要不匹配应拒绝：%+v ok=%t", p, ok)
	}

	// 跨主版本 → 拒绝，不猜测兼容。
	bad = good
	bad.KoreVersion = "9.0.0"
	if p, ok := validateMigrate(bad, "0.1.1"); ok || !strings.Contains(p.Reason, "跨主版本") {
		t.Fatalf("跨主版本应拒绝：%+v ok=%t", p, ok)
	}
}

// TestConfigToMigrateDropsSecrets 证明 nil 配置快照只产出零值允许字段，不带出任何配置值。
func TestConfigToMigrateDropsSecrets(t *testing.T) {
	got := configToMigrate(nil)
	if got.SessionTTLSeconds != 0 || got.AuthInitialized {
		t.Fatalf("nil 快照应产生零值视图：%+v", got)
	}
	if got.ServerAddr != "" || got.Profile != "" {
		t.Fatalf("nil 快照不应带出任何配置值：%+v", got)
	}
}
