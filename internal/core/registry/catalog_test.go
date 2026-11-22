package registry_test

import (
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// newCatalogWith 建一个已登记并 enable 指定清单的登记表。
func newCatalogWith(t *testing.T, manifest *registry.Manifest) *registry.Catalog {
	t.Helper()
	catalog := registry.NewCatalog()
	if err := catalog.Add(manifest); err != nil {
		t.Fatalf("登记清单失败: %v", err)
	}
	return catalog
}

// TestCatalogAddDuplicate 同 id 重复登记返回 E_CONFLICT。
func TestCatalogAddDuplicate(t *testing.T) {
	catalog := newCatalogWith(t, parse(t, baseManifest()))
	err := catalog.Add(parse(t, baseManifest()))
	if codeOf(t, err) != pluginapi.E_CONFLICT {
		t.Fatalf("重复登记应返回 E_CONFLICT，实际 %v", err)
	}
}

// TestCatalogEnableResident 验证 resident 插件 enable 后状态与 Enabled 同时翻转。
func TestCatalogEnableResident(t *testing.T) {
	catalog := newCatalogWith(t, parse(t, baseManifest()))
	if catalog.Enabled("site") {
		t.Fatalf("新登记插件不应处于 enabled")
	}
	if err := catalog.Enable("site"); err != nil {
		t.Fatalf("resident 插件 enable 应成功: %v", err)
	}
	if state, ok := catalog.State("site"); !ok || state != registry.StateEnabled {
		t.Fatalf("enable 后状态应为 enabled，实际 %v/%v", state, ok)
	}
	if !catalog.Enabled("site") {
		t.Fatalf("enable 后 Enabled 应为 true")
	}
}

// TestCatalogEnableLazy 验证 M2：lazy 插件 enable 成功（只标记期望态，不拉起进程）。
func TestCatalogEnableLazy(t *testing.T) {
	manifest := baseManifest()
	manifest["lifecycle"] = "lazy"
	catalog := newCatalogWith(t, parse(t, manifest))
	if err := catalog.Enable("site"); err != nil {
		t.Fatalf("lazy 插件 enable 应成功: %v", err)
	}
	if state, ok := catalog.State("site"); !ok || state != registry.StateEnabled {
		t.Fatalf("lazy enable 后状态应为 enabled，实际 %v/%v", state, ok)
	}
	if !catalog.Enabled("site") {
		t.Fatalf("lazy enable 后 Enabled 应为 true")
	}
}

// TestOneShotCatalogEnable oneshot 运行期受支持：enable 成功并置为期望态。
func TestOneShotCatalogEnable(t *testing.T) {
	manifest := baseManifest()
	manifest["lifecycle"] = "oneshot"
	catalog := newCatalogWith(t, parse(t, manifest))
	if err := catalog.Enable("site"); err != nil {
		t.Fatalf("oneshot enable 应成功，实际 %v", err)
	}
	if !catalog.Enabled("site") {
		t.Fatalf("oneshot enable 后 Enabled 应为 true")
	}
}

// TestCatalogEnableUnknown E_NOTFOUND。
func TestCatalogEnableUnknown(t *testing.T) {
	catalog := registry.NewCatalog()
	err := catalog.Enable("ghost")
	if codeOf(t, err) != pluginapi.E_NOTFOUND {
		t.Fatalf("未安装插件 enable 应返回 E_NOTFOUND，实际 %v", err)
	}
}

// TestCatalogAddCycle 验证 depends_on 成环被拒且环路径可读。
func TestCatalogAddCycle(t *testing.T) {
	first := baseManifest()
	first["id"] = "alpha"
	first["entry"] = "bin/alpha"
	first["capabilities"] = []string{"alpha:read"}
	first["depends_on"] = []string{"beta"}
	catalog := newCatalogWith(t, parse(t, first))

	second := baseManifest()
	second["id"] = "beta"
	second["entry"] = "bin/beta"
	second["capabilities"] = []string{"beta:read"}
	second["depends_on"] = []string{"alpha"}
	err := catalog.Add(parse(t, second))
	if codeOf(t, err) != pluginapi.E_INVALID {
		t.Fatalf("成环应返回 E_INVALID，实际 %v", err)
	}
	if !containsAll(err.Error(), "alpha", "beta", "→") {
		t.Fatalf("message 应含环路径，实际 %q", err.Error())
	}
	if _, ok := catalog.Manifest("beta"); ok {
		t.Fatalf("成环的清单不得登记")
	}
}

// TestCatalogListSorted 验证 List 按 id 字典序返回。
func TestCatalogListSorted(t *testing.T) {
	catalog := registry.NewCatalog()
	for _, id := range []string{"zeta", "alpha"} {
		manifest := baseManifest()
		manifest["id"] = id
		manifest["entry"] = "bin/" + id
		manifest["capabilities"] = []string{id + ":read"}
		if err := catalog.Add(parse(t, manifest)); err != nil {
			t.Fatalf("登记 %s 失败: %v", id, err)
		}
	}
	views := catalog.List()
	if len(views) != 2 || views[0].ID != "alpha" || views[1].ID != "zeta" {
		t.Fatalf("List 顺序错误: %+v", views)
	}
}

// containsAll 判断文本是否同时包含所有子串。
func containsAll(text string, parts ...string) bool {
	for _, part := range parts {
		if !strings.Contains(text, part) {
			return false
		}
	}
	return true
}
