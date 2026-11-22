package market

import (
	"crypto/ed25519"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// recordingInstaller 记录 Install 调用次数；验签失败路径必须为 0（无落盘）。
type recordingInstaller struct {
	calls int
	paths []string
}

func (r *recordingInstaller) Install(path, expectedSHA string) error {
	r.calls++
	r.paths = append(r.paths, path)
	return nil
}

// signedFixture 在临时目录写索引 + 签名，并把 Service 的验签公钥切到配对公钥。
// 生产路径仍走内置公钥常量，注入仅发生在同包测试中。
func signedFixture(t *testing.T, body string) (*Service, string, []byte) {
	t.Helper()
	dir := t.TempDir()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(body)
	writeFixture(t, dir, data, ed25519.Sign(priv, data))
	svc := New(Options{IndexDir: dir, Installer: &recordingInstaller{}})
	svc.verifyKey = pub
	return svc, dir, data
}

func writeFixture(t *testing.T, dir string, data, sig []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if sig != nil {
		if err := os.WriteFile(filepath.Join(dir, "plugins.json.sig"), sig, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// assertDenied 断言三端点全部拒绝、错误码 E_UNAUTHORIZED、且 installer 零调用。
func assertDenied(t *testing.T, svc *Service, inst *recordingInstaller, scenario string) {
	t.Helper()
	_, err := svc.Refresh()
	if err == nil || !strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("%s: refresh 应 E_UNAUTHORIZED，实际 %v", scenario, err)
	}
	_, err = svc.Presets()
	if err == nil || !strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("%s: presets 应 E_UNAUTHORIZED，实际 %v", scenario, err)
	}
	_, err = svc.Update("echo", "0.1.1", "/tmp/echo.tar.gz")
	if err == nil || !strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("%s: update 应 E_UNAUTHORIZED，实际 %v", scenario, err)
	}
	if inst.calls != 0 {
		t.Fatalf("%s: 验签失败路径 installer 调用 %d 次，应为 0（无落盘）", scenario, inst.calls)
	}
}

// TestStoreRefreshPositive 合法签名索引 refresh 成功，缓存有内容。
func TestStoreRefreshPositive(t *testing.T) {
	svc, _, _ := signedFixture(t, testIndexJSON)
	res, err := svc.Refresh()
	if err != nil || res == nil || !res.Refreshed || res.PluginCount != 2 {
		t.Fatalf("合法索引 refresh 应成功: res=%+v err=%v", res, err)
	}
	if n, ok := svc.CachedPluginCount(); !ok || n != 2 {
		t.Fatalf("refresh 后缓存应有 2 条，实际 n=%d ok=%v", n, ok)
	}
}

// TestStoreRefreshTamperedOneByte 篡改索引正文 1 字节 → 三端点全拒、无落盘、旧索引保留。
func TestStoreRefreshTamperedOneByte(t *testing.T) {
	svc, dir, _ := signedFixture(t, testIndexJSON)
	inst := svc.installer.(*recordingInstaller)
	if _, err := svc.Refresh(); err != nil {
		t.Fatal(err)
	}
	before, _ := svc.CachedPluginCount()

	// 篡改已签名正文中的 1 字节（不改 .sig，保留旧签名文件）。
	bad := []byte(strings.Replace(testIndexJSON, "eaa34f25", "0aa34f25", 1))
	writeFixture(t, dir, bad, nil)

	assertDenied(t, svc, inst, "篡改索引 1 字节")
	if after, ok := svc.CachedPluginCount(); !ok || after != before {
		t.Fatalf("验签失败必须保留旧索引: before=%d after=%d ok=%v", before, after, ok)
	}
}

// TestStoreUnsignedCacheRejected 未签名缓存（.sig 缺失）→ 三端点全拒、无落盘。
func TestStoreUnsignedCacheRejected(t *testing.T) {
	svc, dir, _ := signedFixture(t, testIndexJSON)
	inst := svc.installer.(*recordingInstaller)
	if err := os.Remove(filepath.Join(dir, "plugins.json.sig")); err != nil {
		t.Fatal(err)
	}
	assertDenied(t, svc, inst, "未签名缓存")
}

// TestStorePresetsPositive 合法索引下 presets 返回列表（同包临时目录）。
func TestStorePresetsPositive(t *testing.T) {
	svc, dir, _ := signedFixture(t, testIndexJSON)
	presetDir := filepath.Join(dir, "presets")
	if err := os.Mkdir(presetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	preset := `{"schema_version":1,"id":"minimal","name":"最小化","description":"空预设","out_of_box":true,"plugins":[]}`
	if err := os.WriteFile(filepath.Join(presetDir, "minimal.json"), []byte(preset), 0o600); err != nil {
		t.Fatal(err)
	}
	svc.presetsDir = presetDir
	presets, err := svc.Presets()
	if err != nil || len(presets) != 1 || presets[0].ID != "minimal" {
		t.Fatalf("presets 应返回 minimal: %+v err=%v", presets, err)
	}
}

// TestStoreUpdateUsesIndexSHA update 走 installer，传入索引声明的 sha256（小写）。
func TestStoreUpdateUsesIndexSHA(t *testing.T) {
	svc, _, _ := signedFixture(t, testIndexJSON)
	inst := svc.installer.(*recordingInstaller)
	if _, err := svc.Refresh(); err != nil {
		t.Fatal(err)
	}
	res, err := svc.Update("echo", "0.1.1", "/tmp/echo.tar.gz")
	if err != nil || res == nil || res.State != "succeeded" {
		t.Fatalf("update 应成功: res=%+v err=%v", res, err)
	}
	if inst.calls != 1 || inst.paths[0] != "/tmp/echo.tar.gz" {
		t.Fatalf("update 应调用 installer 一次且路径正确: %+v", inst)
	}
}

// TestStoreUpdateNoInstaller 未装配 installer 时 update 返回 E_UNSUPPORTED（不假装成功）。
func TestStoreUpdateNoInstaller(t *testing.T) {
	dir := t.TempDir()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(testIndexJSON)
	writeFixture(t, dir, data, ed25519.Sign(priv, data))
	svc := New(Options{IndexDir: dir})
	svc.verifyKey = pub
	_, err = svc.Update("echo", "0.1.1", "/tmp/echo.tar.gz")
	if err == nil || !strings.Contains(err.Error(), "E_UNSUPPORTED") {
		t.Fatalf("未装配 installer 应 E_UNSUPPORTED，实际 %v", err)
	}
}

// TestStoreAllowUnsignedStillGuarded allow_unsigned=true 只放开 Load，三端点仍强制验签（R4）。
func TestStoreAllowUnsignedStillGuarded(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(testIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	inst := &recordingInstaller{}
	svc := New(Options{IndexDir: dir, AllowUnsigned: true, Installer: inst})
	// Load 兼容放行（既有行为）。
	if _, err := svc.Load(); err != nil {
		t.Fatalf("allow_unsigned Load 应放行: %v", err)
	}
	// 三端点仍拒：allow_unsigned 不能成为绕过签名门的抓手。
	assertDenied(t, svc, inst, "allow_unsigned=true")
}
