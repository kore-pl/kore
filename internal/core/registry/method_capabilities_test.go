package registry_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// withMethodCaps 把 method_capabilities 原始 JSON 片段注入基础清单后解析。
// 用原始片段而不是 map，才能覆盖「重复键」这类 map 无法表达的非法输入。
func withMethodCaps(t *testing.T, fragment string) (*registry.Manifest, error) {
	t.Helper()
	data := encode(t, baseManifest())
	body := strings.TrimSuffix(string(data), "}")
	return registry.Parse([]byte(body + `,"method_capabilities":` + fragment + `}`))
}

// TestParseMethodCapabilities 验证合法方法级覆盖落位（含点分方法名与 camelCase）。
func TestParseMethodCapabilities(t *testing.T) {
	manifest := baseManifest()
	manifest["method_capabilities"] = map[string]string{
		"site.list":       "system:read",
		"site.config.get": "system:read",
		"site.deploy":     "system:admin",
	}
	got := parse(t, manifest)
	if len(got.MethodCapabilities) != 3 {
		t.Fatalf("method_capabilities 条数 = %d，期望 3（%v）", len(got.MethodCapabilities), got.MethodCapabilities)
	}
	if got.MethodCapabilities["site.config.get"] != "system:read" {
		t.Errorf("点分方法名未落位: %v", got.MethodCapabilities)
	}
	if got.MethodCapabilities["site.deploy"] != "system:admin" {
		t.Errorf("camelCase 方法名未落位: %v", got.MethodCapabilities)
	}
}

// TestParseMethodCapabilitiesUnderscore 锁定 ADR-0047 的字符集裁决：接受下划线
// （camelCase | snake_case），段首仍限小写字母，连字符仍拒。
//
// 回归护栏：ADR-0047 之前 verify_file 这类方法**声明不出来**，只能回退插件级
// capabilities（integrity 因此把只读方法算成 admin 类）。此用例一旦变红，说明
// 字符集被收回，须重新裁决——不是改断言。
func TestParseMethodCapabilitiesUnderscore(t *testing.T) {
	manifest := baseManifest()
	manifest["method_capabilities"] = map[string]string{
		"site.verify_file": "system:read", // snake_case
		"site.verifyFile":  "system:read", // camelCase 并存
		"site.a_b.c":       "system:read", // 点分 + 下划线：整段匹配，内核不切分
	}
	got := parse(t, manifest)
	for _, key := range []string{"site.verify_file", "site.verifyFile", "site.a_b.c"} {
		if got.MethodCapabilities[key] != "system:read" {
			t.Errorf("%s 应落位为 system:read，实际 %q（表：%v）", key, got.MethodCapabilities[key], got.MethodCapabilities)
		}
	}
	// 切分规则（ADR-0047 §3.2）：唯一分割点是 <id> 与 <action> 之间的那个「.」，
	// 动作段内部不切分 —— a_b.c 是「一个整体动作名」，不会落成 site.a_b 或 site.c。
	if _, ok := got.MethodCapabilities["site.a_b"]; ok {
		t.Error("a_b.c 被按 '.' 切分了：动作段内部禁止切分层级")
	}
	if _, ok := got.MethodCapabilities["site.c"]; ok {
		t.Error("a_b.c 被按 '.' 切分了：动作段内部禁止切分层级")
	}
}

// TestParseMethodCapabilitiesAbsent 验证缺省字段为 nil（向后兼容：全部回退插件级）。
func TestParseMethodCapabilitiesAbsent(t *testing.T) {
	if got := parse(t, baseManifest()); got.MethodCapabilities != nil {
		t.Fatalf("未声明时 MethodCapabilities 应为 nil，实际 %v", got.MethodCapabilities)
	}
}

// TestParseRejectsInvalidMethodCapabilities 覆盖键/值/上限的 fail-closed 校验。
func TestParseRejectsInvalidMethodCapabilities(t *testing.T) {
	tooMany := map[string]string{}
	for i := 0; i < 65; i++ {
		tooMany[fmt.Sprintf("site.m%d", i)] = "system:read"
	}
	cases := []struct {
		name    string
		value   map[string]string
		wantMsg string
	}{
		{"键缺插件域", map[string]string{"instances": "system:read"}, "插件自身 id 为域"},
		{"跨插件域", map[string]string{"db-mysql.instances": "system:read"}, "插件自身 id 为域"},
		{"动作段大写开头", map[string]string{"site.Instances": "system:read"}, "动作段"},
		{"动作段为空", map[string]string{"site.": "system:read"}, "插件自身 id 为域"},
		{"动作段含连字符", map[string]string{"site.set-rewrite": "system:read"}, "动作段"},
		{"动作段以下划线开头", map[string]string{"site._instances": "system:read"}, "动作段"},
		{"值插件自有能力", map[string]string{"site.instances": "site:read"}, "6 项特权能力"},
		{"值未知宿主动作", map[string]string{"site.instances": "system:superuser"}, "6 项特权能力"},
		{"值为空串", map[string]string{"site.instances": ""}, "6 项特权能力"},
		{"超上限", tooMany, "最多 64 条"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			manifest := baseManifest()
			manifest["method_capabilities"] = c.value
			_, err := registry.Parse(encode(t, manifest))
			if err == nil {
				t.Fatalf("非法 method_capabilities 应被拒绝，实际解析成功")
			}
			if code := codeOf(t, err); code != pluginapi.E_INVALID {
				t.Fatalf("错误码 = %q，期望 %q（err=%v）", code, pluginapi.E_INVALID, err)
			}
			if !strings.Contains(err.Error(), c.wantMsg) {
				t.Fatalf("错误信息应包含 %q，实际 %q", c.wantMsg, err.Error())
			}
		})
	}
}

// TestParseRejectsDuplicateMethodCapability 验证重复键 fail-closed：
// 标准库语义下后者覆盖前者，对权限声明等价于静默提权/降权。
func TestParseRejectsDuplicateMethodCapability(t *testing.T) {
	_, err := withMethodCaps(t, `{"site.instances":"system:read","site.instances":"system:admin"}`)
	if err == nil {
		t.Fatal("重复键应被拒绝，实际解析成功")
	}
	if code := codeOf(t, err); code != pluginapi.E_INVALID {
		t.Fatalf("错误码 = %q，期望 %q（err=%v）", code, pluginapi.E_INVALID, err)
	}
	if !strings.Contains(err.Error(), "重复键") {
		t.Fatalf("错误信息应说明重复键，实际 %q", err.Error())
	}
}

// TestParseRejectsNonObjectMethodCapabilities 验证字段必须是 JSON 对象（不是数组/标量）。
func TestParseRejectsNonObjectMethodCapabilities(t *testing.T) {
	for _, fragment := range []string{`[]`, `"system:read"`, `1`} {
		if _, err := withMethodCaps(t, fragment); err == nil {
			t.Fatalf("method_capabilities=%s 应被拒绝", fragment)
		}
	}
}

// TestParseMethodCapabilitiesEmptyObject 验证空对象合法（等价于未声明）。
func TestParseMethodCapabilitiesEmptyObject(t *testing.T) {
	got, err := withMethodCaps(t, `{}`)
	if err != nil {
		t.Fatalf("空对象应合法，实际 %v", err)
	}
	if len(got.MethodCapabilities) != 0 {
		t.Fatalf("空对象解析结果应为空表，实际 %v", got.MethodCapabilities)
	}
}

// TestManifestJSONRoundTrip 验证字段名与 JSON 契约一致（method_capabilities）。
func TestManifestJSONRoundTrip(t *testing.T) {
	manifest := baseManifest()
	manifest["method_capabilities"] = map[string]string{"site.list": "system:read"}
	data := encode(t, manifest)
	if !strings.Contains(string(data), `"method_capabilities"`) {
		t.Fatalf("序列化结果应含 method_capabilities 字段: %s", data)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	if _, ok := raw["method_capabilities"]; !ok {
		t.Fatal("method_capabilities 字段丢失")
	}
}
