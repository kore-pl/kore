package market

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// coreAssetIndexJSON 生成一份含内核资产条目的已签名索引正文（plugins 为空）。
func coreAssetIndexJSON(url, sha string) string {
	return `{"schema_version":1,"plugins":[],"core_asset":{
  "id":"` + CoreAssetID + `","kind":"` + CoreAssetBinaryKind + `",
  "version":"0.1.2","sha256":"` + sha + `","size_bytes":16,"download_url":"` + url + `"
}}`
}

// signedCoreAssetService 用配对密钥签索引，验签公钥注入同包 Service（生产仍走内置常量）。
func signedCoreAssetService(t *testing.T, body string) (*Service, string) {
	t.Helper()
	svc, dir, _ := signedFixture(t, body)
	return svc, dir
}

// TestVerifiedCoreAssetSuccess 已验签索引里的内核资产条目逐字段显式解析。
func TestVerifiedCoreAssetSuccess(t *testing.T) {
	sha := strings.Repeat("a", 64)
	url := "https://mirror.example/kored-0.1.2"
	svc, _ := signedCoreAssetService(t, coreAssetIndexJSON(url, sha))

	asset, err := svc.VerifiedCoreAsset()
	if err != nil {
		t.Fatalf("已验签条目应解析成功: %v", err)
	}
	if asset.ID != CoreAssetID || asset.Kind != CoreAssetBinaryKind ||
		asset.Version != "0.1.2" || asset.SHA256 != sha || asset.SizeBytes != 16 ||
		asset.DownloadURL != url {
		t.Fatalf("条目逐字段不符: %+v", asset)
	}
}

// TestVerifiedCoreAssetUnsignedZeroData 未验签 / 验签失败索引零数据（fail-closed）。
func TestVerifiedCoreAssetUnsignedZeroData(t *testing.T) {
	sha := strings.Repeat("a", 64)
	body := coreAssetIndexJSON("https://mirror.example/kored-0.1.2", sha)
	svc, dir := signedCoreAssetService(t, body)

	// 篡改正文、保留旧签名：验签必失败，allowUnsigned 也不得放行本入口。
	tampered := coreAssetIndexJSON("https://evil.example/kored-0.1.2", sha)
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	svc.allowUnsigned = true // 即便显式放行，内核资产入口仍 fail-closed
	asset, err := svc.VerifiedCoreAsset()
	if err == nil || !strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("验签失败应 E_UNAUTHORIZED，实际 %v", err)
	}
	if asset != (CoreAsset{}) {
		t.Fatalf("验签失败必须零数据，实际 %+v", asset)
	}
}

// TestVerifiedCoreAssetMissingSignatureZeroData 缺签名文件默认拒绝（未验签索引零数据）。
func TestVerifiedCoreAssetMissingSignatureZeroData(t *testing.T) {
	dir := t.TempDir()
	body := coreAssetIndexJSON("https://mirror.example/kored-0.1.2", strings.Repeat("a", 64))
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	asset, err := New(Options{IndexDir: dir}).VerifiedCoreAsset()
	if err == nil || !strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("未签名应 E_UNAUTHORIZED，实际 %v", err)
	}
	if asset != (CoreAsset{}) {
		t.Fatalf("未签名必须零数据，实际 %+v", asset)
	}
}

// TestValidateCoreAssetURLRejects 非 https / 缺 URL 一律 E_INVALID（零下载由命令行侧保证）。
func TestValidateCoreAssetURLRejects(t *testing.T) {
	cases := []struct{ name, url string }{
		{"缺失", ""},
		{"http", "http://mirror.example/kored"},
		{"file", "file:///tmp/kored"},
		{"相对路径", "/tmp/kored"},
		{"缺主机", "https:///kored"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateCoreAssetURL(tc.url)
			var perr *pluginapi.Error
			if !errors.As(err, &perr) || perr.Code != pluginapi.E_INVALID {
				t.Fatalf("%q 应 E_INVALID，实际 %v", tc.url, err)
			}
		})
	}
}

// TestVerifiedCoreAssetRejectsBadFields 缺标识 / 错摘要 / 错 size_bytes 在加载期即拒。
func TestVerifiedCoreAssetRejectsBadFields(t *testing.T) {
	cases := []struct{ name, body string }{
		{"错标识", strings.Replace(coreAssetIndexJSON("https://m.example/k", strings.Repeat("a", 64)),
			CoreAssetID, "plugin", 1)},
		{"大写摘要", coreAssetIndexJSON("https://m.example/k", strings.Repeat("A", 64))},
		{"size_bytes 非正数", strings.Replace(coreAssetIndexJSON("https://m.example/k", strings.Repeat("a", 64)),
			`"size_bytes":16`, `"size_bytes":0`, 1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := signedCoreAssetService(t, tc.body)
			if _, err := svc.VerifiedCoreAsset(); err == nil ||
				!strings.Contains(err.Error(), pluginapi.E_INVALID) {
				t.Fatalf("%s 应 E_INVALID，实际 %v", tc.name, err)
			}
		})
	}
}
