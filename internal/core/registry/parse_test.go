package registry_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// baseManifest 返回一份 9 个必填字段齐全的 resident 清单。
func baseManifest() map[string]any {
	return map[string]any{
		"id":           "site",
		"name":         "站点管理",
		"version":      "0.1.0",
		"protocol":     pluginapi.Protocol,
		"lifecycle":    "resident",
		"entry":        "bin/site",
		"capabilities": []string{"site:read", "site:write"},
		"resources": map[string]any{
			"memory_mb": 10, "cpu_quota": "50%", "pids_max": 128,
		},
		"requires_kore": ">=0.1.0 <0.2.0",
		"triggers":      []string{},
	}
}

// encode 把清单序列化成 info.json 字节。
func encode(t *testing.T, manifest map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("序列化清单失败: %v", err)
	}
	return data
}

// parse 解析清单并要求成功。
func parse(t *testing.T, manifest map[string]any) *registry.Manifest {
	t.Helper()
	got, err := registry.Parse(encode(t, manifest))
	if err != nil {
		t.Fatalf("解析应成功，实际失败: %v", err)
	}
	return got
}

// codeOf 取协议错误码；非协议错误返回空串。
func codeOf(t *testing.T, err error) string {
	t.Helper()
	var protocolErr *pluginapi.Error
	if !errors.As(err, &protocolErr) {
		t.Fatalf("错误不是 *pluginapi.Error: %v", err)
	}
	return protocolErr.Code
}

// TestParseValidManifest 验证 9 个必填字段齐全时解析成功且字段落位。
func TestParseValidManifest(t *testing.T) {
	manifest := parse(t, baseManifest())
	if manifest.ID != "site" || manifest.Version != "0.1.0" {
		t.Fatalf("字段解析错误: %+v", manifest)
	}
	if manifest.Lifecycle != registry.LifecycleResident {
		t.Fatalf("lifecycle 应为 resident，实际 %s", manifest.Lifecycle)
	}
	if manifest.Resources.MemoryMB != 10 || manifest.Resources.PidsMax != 128 {
		t.Fatalf("resources 解析错误: %+v", manifest.Resources)
	}
	if manifest.Dir != "" {
		t.Fatalf("Parse 不应填写 Dir，实际 %q", manifest.Dir)
	}
}

// TestParseDefaultsLifecycleLazy 验证 lifecycle 缺省为 lazy（G-14 三值解析）。
func TestParseDefaultsLifecycleLazy(t *testing.T) {
	manifest := baseManifest()
	delete(manifest, "lifecycle")
	if got := parse(t, manifest); got.Lifecycle != registry.LifecycleLazy {
		t.Fatalf("缺省 lifecycle 应为 lazy，实际 %s", got.Lifecycle)
	}
}

// rejectCases 是逐字段校验的失败用例表。
var rejectCases = []struct {
	name    string
	mutate  func(map[string]any)
	want    string
	message string
}{
	{"缺 id", func(m map[string]any) { delete(m, "id") }, pluginapi.E_INVALID, "id"},
	{"id 大写", func(m map[string]any) { m["id"] = "Site" }, pluginapi.E_INVALID, "id"},
	{"id 连续连字符", func(m map[string]any) { m["id"] = "a--b"; m["entry"] = "bin/a--b" }, pluginapi.E_INVALID, "--"},
	{"缺 name", func(m map[string]any) { delete(m, "name") }, pluginapi.E_INVALID, "name"},
	{"name 过长", func(m map[string]any) { m["name"] = strings.Repeat("长", 65) }, pluginapi.E_INVALID, "name"},
	{"版本非三段", func(m map[string]any) { m["version"] = "1.0" }, pluginapi.E_INVALID, "version"},
	{"缺 protocol", func(m map[string]any) { delete(m, "protocol") }, pluginapi.E_INVALID, "protocol"},
	{"protocol 主版本不符", func(m map[string]any) { m["protocol"] = "kore.plugin.v2" }, pluginapi.E_UNSUPPORTED, "protocol"},
	{"lifecycle 非法", func(m map[string]any) { m["lifecycle"] = "always" }, pluginapi.E_INVALID, "lifecycle"},
	{"entry 非固定形态", func(m map[string]any) { m["entry"] = "bin/other" }, pluginapi.E_INVALID, "entry"},
	{"缺 capabilities", func(m map[string]any) { delete(m, "capabilities") }, pluginapi.E_INVALID, "capabilities"},
	{"能力域非自身", func(m map[string]any) { m["capabilities"] = []string{"mysql:write"} }, pluginapi.E_INVALID, "mysql:write"},
	{"特权域动作非法", func(m map[string]any) { m["capabilities"] = []string{"system:root"} }, pluginapi.E_INVALID, "system:root"},
	{"能力为空", func(m map[string]any) { m["capabilities"] = []string{} }, pluginapi.E_INVALID, "capabilities"},
	{"能力重复", func(m map[string]any) { m["capabilities"] = []string{"site:read", "site:read"} }, pluginapi.E_INVALID, "重复"},
	{"能力超上限", func(m map[string]any) { m["capabilities"] = manyCapabilities(17) }, pluginapi.E_INVALID, "16"},
	{"能力语法非法", func(m map[string]any) { m["capabilities"] = []string{"site_read"} }, pluginapi.E_INVALID, "语法"},
	{"缺 resources", func(m map[string]any) { delete(m, "resources") }, pluginapi.E_INVALID, "resources"},
	{"memory_mb 越界", func(m map[string]any) { m["resources"].(map[string]any)["memory_mb"] = 13 }, pluginapi.E_INVALID, "memory_mb"},
	{"cpu_quota 越界", func(m map[string]any) { m["resources"].(map[string]any)["cpu_quota"] = "5%" }, pluginapi.E_INVALID, "cpu_quota"},
	{"pids_max 越界", func(m map[string]any) { m["resources"].(map[string]any)["pids_max"] = 8 }, pluginapi.E_INVALID, "pids_max"},
	{"缺 requires_kore", func(m map[string]any) { delete(m, "requires_kore") }, pluginapi.E_INVALID, "requires_kore"},
	{"缺 triggers", func(m map[string]any) { delete(m, "triggers") }, pluginapi.E_INVALID, "triggers"},
	{"trigger 缺类型前缀", func(m map[string]any) { m["triggers"] = []string{"cert.renew_due"} }, pluginapi.E_INVALID, "triggers"},
	{"trigger 类型非法", func(m map[string]any) { m["triggers"] = []string{"http:x.y"} }, pluginapi.E_INVALID, "triggers"},
	{"trigger event name 非法", func(m map[string]any) { m["triggers"] = []string{"event:Cert.renew"} }, pluginapi.E_INVALID, "triggers"},
	{"trigger event 缺事件段", func(m map[string]any) { m["triggers"] = []string{"event:cert"} }, pluginapi.E_INVALID, "triggers"},
	{"trigger 空 name", func(m map[string]any) { m["triggers"] = []string{"event:"} }, pluginapi.E_INVALID, "triggers"},
	{"trigger invoke name 非法", func(m map[string]any) { m["triggers"] = []string{"invoke:Restart"} }, pluginapi.E_INVALID, "triggers"},
	{"依赖 id 非法", func(m map[string]any) { m["depends_on"] = []string{"Bad"} }, pluginapi.E_INVALID, "depends_on"},
	{"场景标签非法", func(m map[string]any) { m["scenario_tags"] = []string{"k8s"} }, pluginapi.E_INVALID, "scenario_tags"},
	{"深度等级非法", func(m map[string]any) { m["depth_level"] = "gold" }, pluginapi.E_INVALID, "depth_level"},
	{"体积为负", func(m map[string]any) { m["size_bytes"] = -1 }, pluginapi.E_INVALID, "size_bytes"},
	{"空闲超时越界", func(m map[string]any) { m["idle_timeout_s"] = 10 }, pluginapi.E_INVALID, "idle_timeout_s"},
}

// TestParseRejects 逐字段验证校验规则与错误码。
func TestParseRejects(t *testing.T) {
	for _, testCase := range rejectCases {
		t.Run(testCase.name, func(t *testing.T) {
			manifest := baseManifest()
			testCase.mutate(manifest)
			_, err := registry.Parse(encode(t, manifest))
			if err == nil {
				t.Fatalf("应失败但解析成功")
			}
			if code := codeOf(t, err); code != testCase.want {
				t.Fatalf("错误码应为 %s，实际 %s（%v）", testCase.want, code, err)
			}
			if !strings.Contains(err.Error(), testCase.message) {
				t.Fatalf("message 应包含 %q，实际 %q", testCase.message, err.Error())
			}
		})
	}
}

// TestParseRejectsBrokenJSON 验证非 JSON 载荷。
func TestParseRejectsBrokenJSON(t *testing.T) {
	if _, err := registry.Parse([]byte("not json")); codeOf(t, err) != pluginapi.E_INVALID {
		t.Fatalf("坏 JSON 应返回 E_INVALID，实际 %v", err)
	}
}

// TestRuntimeSupported 验证 M2 运行期支持 resident/lazy，oneshot 仍不支持（M3）。
func TestRuntimeSupported(t *testing.T) {
	oneshot := baseManifest()
	oneshot["lifecycle"] = "oneshot"
	err := parse(t, oneshot).RuntimeSupported()
	if codeOf(t, err) != pluginapi.E_UNSUPPORTED {
		t.Fatalf("oneshot 应返回 E_UNSUPPORTED，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "M3") {
		t.Fatalf("oneshot 的 message 应写明 M3 支持，实际 %q", err.Error())
	}
	lazy := baseManifest()
	lazy["lifecycle"] = "lazy"
	if err := parse(t, lazy).RuntimeSupported(); err != nil {
		t.Fatalf("lazy 在 M2 应受支持，实际 %v", err)
	}
	if err := parse(t, baseManifest()).RuntimeSupported(); err != nil {
		t.Fatalf("resident 应受支持，实际 %v", err)
	}
}

// TestParseCapabilities 覆盖两类合法能力：特权能力与插件自有能力（域 == 插件 id）。
func TestParseCapabilities(t *testing.T) {
	manifest := baseManifest()
	manifest["capabilities"] = []string{"system:read", "net:write", "site:read"}
	got := parse(t, manifest)
	if len(got.Capabilities) != 3 {
		t.Fatalf("三类合法能力应全部保留，实际 %v", got.Capabilities)
	}
	// 自有能力域 != 插件 id 时必须失败（id 换成 echo 后 site:read 不再合法）。
	other := baseManifest()
	other["id"] = "echo"
	other["entry"] = "bin/echo"
	other["capabilities"] = []string{"site:read"}
	_, err := registry.Parse(encode(t, other))
	if codeOf(t, err) != pluginapi.E_INVALID || !strings.Contains(err.Error(), "echo") {
		t.Fatalf("自有能力域应等于插件 id，实际 %v", err)
	}
}

// manyCapabilities 生成 n 条语法合法但超量的能力声明。
func manyCapabilities(n int) []string {
	items := make([]string, 0, n)
	for i := 0; i < n; i++ {
		items = append(items, "site:action-"+string(rune('a'+i)))
	}
	return items
}

// TestParseTriggers 覆盖 triggers 必填口径：字符串数组，元素 "<type>:<name>"。
func TestParseTriggers(t *testing.T) {
	empty := baseManifest()
	empty["triggers"] = []string{}
	if got := parse(t, empty); len(got.Triggers) != 0 {
		t.Fatalf("空 triggers 应解析为空切片，实际 %v", got.Triggers)
	}

	filled := baseManifest()
	filled["triggers"] = []string{
		"event:cert.renew_due",
		"schedule:daily@03:00",
		"invoke:restart",
		"invoke:site.restart",
	}
	got := parse(t, filled)
	if len(got.Triggers) != 4 {
		t.Fatalf("合法 triggers 应全部保留，实际 %v", got.Triggers)
	}
	if got.Triggers[0] != "event:cert.renew_due" {
		t.Fatalf("trigger 应原样保留，实际 %q", got.Triggers[0])
	}
}
