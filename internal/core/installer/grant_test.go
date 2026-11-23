package installer_test

import (
	"encoding/json"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
)

// installVersion 安装指定版本/能力集的测试包。
func installVersion(t *testing.T, f *fixture, version string, capabilities []string) {
	t.Helper()
	pkg := writePackage(t, t.TempDir(), "site-"+version+".tar.gz",
		validEntries(t, map[string]any{"version": version, "capabilities": capabilities}))
	if _, err := f.inst.Install(pkg); err != nil {
		t.Fatalf("安装 %s 失败: %v", version, err)
	}
}

// grantOf 读取授予记录并断言存在。
func grantOf(t *testing.T, f *fixture) installer.Grant {
	t.Helper()
	grant, found, err := installer.GrantOf(f.store, "site")
	if err != nil {
		t.Fatalf("读取授予记录失败: %v", err)
	}
	if !found {
		t.Fatal("安装后应存在授予记录")
	}
	return grant
}

// TestInstallWritesGrantRecord 覆盖首次安装：授予记录回答谁授的/什么时候/授了哪些。
func TestInstallWritesGrantRecord(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	installVersion(t, f, "0.1.0", []string{"site:read", "system:read"})

	grant := grantOf(t, f)
	if grant.GrantedBy != installer.GrantSourceInstall {
		t.Fatalf("granted_by = %q，期望 %q", grant.GrantedBy, installer.GrantSourceInstall)
	}
	if grant.GrantedAt == "" || grant.Version != "0.1.0" {
		t.Fatalf("授予时间/版本未落库: %+v", grant)
	}
	if len(grant.Capabilities) != 2 || grant.Capabilities[0] != "site:read" || grant.Capabilities[1] != "system:read" {
		t.Fatalf("capabilities = %v，期望按声明顺序保存", grant.Capabilities)
	}
	if grant.DeclarationSHA256 == "" {
		t.Fatal("声明指纹未落库")
	}
	if len(grant.AddedCapabilities) != 0 {
		t.Fatalf("首次安装不应有待确认新增项: %v", grant.AddedCapabilities)
	}

	// 存储值本身必须是显式对象（G-24：不是字符串、不是 any），字段名即契约。
	raw := f.pluginRecord(t, "site")
	value, ok := raw["granted_capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("plugins 记录的 granted_capabilities 不是对象: %#v", raw["granted_capabilities"])
	}
	if value["granted_by"] != installer.GrantSourceInstall {
		t.Fatalf("落库 granted_by = %v，期望 %q", value["granted_by"], installer.GrantSourceInstall)
	}
}

// TestUpgradeAddedCapabilityRecordsPending 覆盖升级新增能力：自动扩展并记录待确认项（不静默）。
func TestUpgradeAddedCapabilityRecordsPending(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	installVersion(t, f, "0.1.0", []string{"site:read"})
	first := grantOf(t, f)

	installVersion(t, f, "0.2.0", []string{"site:read", "net:read"})
	grant := grantOf(t, f)
	if grant.GrantedBy != installer.GrantSourceUpgrade {
		t.Fatalf("升级授予来源 = %q，期望 %q", grant.GrantedBy, installer.GrantSourceUpgrade)
	}
	if grant.Version != "0.2.0" || len(grant.Capabilities) != 2 {
		t.Fatalf("升级后授予记录未扩展: %+v", grant)
	}
	if len(grant.AddedCapabilities) != 1 || grant.AddedCapabilities[0] != "net:read" {
		t.Fatalf("新增能力记录 = %v，期望 [net:read]", grant.AddedCapabilities)
	}
	if grant.GrantedAt == first.GrantedAt && grant.DeclarationSHA256 == first.DeclarationSHA256 {
		t.Fatal("新增能力后授予时间与声明指纹都应刷新")
	}
}

// TestUpgradeWithoutNewCapabilityKeepsGrant 覆盖声明未变的升级：不重写授予记录（保留真实时点）。
func TestUpgradeWithoutNewCapabilityKeepsGrant(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	installVersion(t, f, "0.1.0", []string{"site:read"})
	first := grantOf(t, f)

	installVersion(t, f, "0.2.0", []string{"site:read"})
	grant := grantOf(t, f)
	if grant.GrantedAt != first.GrantedAt || grant.GrantedBy != first.GrantedBy {
		t.Fatalf("声明未变不应刷新授予记录: first=%+v now=%+v", first, grant)
	}
	if len(grant.AddedCapabilities) != 0 {
		t.Fatalf("无新增能力却记录了待确认项: %v", grant.AddedCapabilities)
	}
}

// TestBackfillGrantForLegacyRecord 覆盖存量库迁移：缺授予记录时按已装声明回填，幂等。
func TestBackfillGrantForLegacyRecord(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	installVersion(t, f, "0.1.0", []string{"system:read"})

	// 模拟本层落地前写入的记录：去掉 granted_capabilities 字段。
	raw := f.pluginRecord(t, "site")
	delete(raw, "granted_capabilities")
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("序列化旧记录失败: %v", err)
	}
	if err := f.store.Update(func(tx *store.Tx) error { return tx.Put("plugins", "site", encoded) }); err != nil {
		t.Fatalf("写回旧记录失败: %v", err)
	}

	grant, created, err := installer.BackfillGrant(f.store, "site", []string{"system:read"}, "0.1.0")
	if err != nil {
		t.Fatalf("回填失败: %v", err)
	}
	if !created || grant.GrantedBy != installer.GrantSourceBackfill {
		t.Fatalf("回填结果不符: created=%v grant=%+v", created, grant)
	}
	if _, again, err := installer.BackfillGrant(f.store, "site", []string{"system:read"}, "0.1.0"); err != nil || again {
		t.Fatalf("回填应幂等: created=%v err=%v", again, err)
	}
}

// TestConfirmGrantClearsPending 覆盖启用即确认：清空升级新增的待确认项并记录操作者。
func TestConfirmGrantClearsPending(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	installVersion(t, f, "0.1.0", []string{"site:read"})
	installVersion(t, f, "0.2.0", []string{"site:read", "proc:read"})

	grant, changed, err := installer.ConfirmGrant(f.store, "site", "admin")
	if err != nil {
		t.Fatalf("确认授予失败: %v", err)
	}
	if !changed || grant.GrantedBy != installer.GrantSourceEnablePrefix+"admin" {
		t.Fatalf("确认结果不符: changed=%v grant=%+v", changed, grant)
	}
	if len(grant.AddedCapabilities) != 0 {
		t.Fatalf("确认后待确认项应清空: %v", grant.AddedCapabilities)
	}
	if _, again, err := installer.ConfirmGrant(f.store, "site", "admin"); err != nil || again {
		t.Fatalf("重复确认应幂等: changed=%v err=%v", again, err)
	}
}
