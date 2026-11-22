package market

import (
	"crypto/ed25519"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testIndexJSON 与 kore-plugins/index/plugins.json 同形。
const testIndexJSON = `{
  "schema_version": 1,
  "plugins": [
    {"id":"echo","name":"Echo","version":"0.1.1","depth_level":"basic","lifecycle":"resident",
     "size_bytes":1258133,"sha256":"eaa34f251e18b9c3f4a186c420d62bec9f31a37c61963514c4b856160ef4219c",
     "download_url":"file:///tmp/echo.tar.gz","requires_kore":">=0.1.0 <0.2.0",
     "depends_on":[],"conflicts":[],"scenario_tags":["ops"]},
    {"id":"site","name":"Site","version":"0.1.0","depth_level":"production","lifecycle":"resident",
     "size_bytes":1363615,"sha256":"59b107badc27ce1285631dc2c2989db41da5a702130c26bffc1b840b3801520f",
     "download_url":"file:///tmp/site.tar.gz","requires_kore":">=0.1.0 <0.2.0",
     "depends_on":[],"conflicts":[],"scenario_tags":["web"]}
  ]
}`

// TestVerifyPositive 正确签名验过（正反两例的正例）。
func TestVerifyPositive(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(testIndexJSON)
	if err := verifyWithKey(pub, data, ed25519.Sign(priv, data)); err != nil {
		t.Fatalf("正确签名应验过: %v", err)
	}
}

// TestVerifyNegativeTampered 签名改 1 字节必失败（正反两例的反例）。
func TestVerifyNegativeTampered(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(testIndexJSON)
	sig := ed25519.Sign(priv, data)
	sig[0] ^= 0x01
	if err := verifyWithKey(pub, data, sig); err == nil {
		t.Fatal("签名被篡改必须失败")
	}
}

// TestVerifyNegativeDataTampered 索引正文改 1 字节必失败（sha256 值被改动的场景）。
func TestVerifyNegativeDataTampered(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(testIndexJSON)
	sig := ed25519.Sign(priv, data)
	bad := []byte(strings.Replace(testIndexJSON, "eaa34f25", "0aa34f25", 1))
	if err := verifyWithKey(pub, bad, sig); err == nil {
		t.Fatal("索引正文被改动必须失败")
	}
}

// TestLoadUnsignedRejected 未签名索引默认 E_UNAUTHORIZED（R2/S-01）。
func TestLoadUnsignedRejected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(testIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := New(Options{IndexDir: dir}).Load()
	if err == nil || !strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("未签名索引必须 E_UNAUTHORIZED，实际 %v", err)
	}
}

// TestLoadUnsignedAllowed 显式 allow_unsigned=true 才放行未签名索引（审计开关）。
func TestLoadUnsignedAllowed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(testIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	index, err := New(Options{IndexDir: dir, AllowUnsigned: true}).Load()
	if err != nil {
		t.Fatalf("allow_unsigned=true 应放行: %v", err)
	}
	if len(index.Plugins) != 2 || index.Plugins[0].ID != "echo" || index.Plugins[1].ID != "site" {
		t.Fatalf("索引排序/内容不符: %+v", index.Plugins)
	}
}

// TestValidateIndexDuplicateID id 重复必须失败。
func TestValidateIndexDuplicateID(t *testing.T) {
	idx := Index{SchemaVersion: 1, Plugins: []Plugin{
		{ID: "echo", SHA256: strings.Repeat("a", 64), DepthLevel: "basic", Lifecycle: "resident"},
		{ID: "echo", SHA256: strings.Repeat("b", 64), DepthLevel: "basic", Lifecycle: "resident"},
	}}
	if err := validateIndex(&idx); err == nil {
		t.Fatal("重复 id 必须失败")
	}
}

// TestBuiltinKeyHex 内置公钥必须是 32 字节合法 hex。
func TestBuiltinKeyHex(t *testing.T) {
	b, err := hex.DecodeString(IndexPublicKeyHex)
	if err != nil || len(b) != ed25519.PublicKeySize {
		t.Fatalf("内置公钥非法: %v len=%d", err, len(b))
	}
}
