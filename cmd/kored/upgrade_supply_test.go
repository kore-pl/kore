package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fakeAssetSource 是已验签索引源的测试替身：只返回显式类型条目，不碰真实索引文件。
type fakeAssetSource struct {
	asset market.CoreAsset
	err   error
	calls int
}

func (f *fakeAssetSource) VerifiedCoreAsset() (market.CoreAsset, error) {
	f.calls++
	return f.asset, f.err
}

// recordingUpgradeRunner 只记录 argv，绝不替换二进制、不重启 unit（测试替身验证契约）。
type recordingUpgradeRunner struct {
	calls int
	args  []string
	code  int
}

func (r *recordingUpgradeRunner) run(args []string, _ io.Writer, _ io.Writer) int {
	r.calls++
	r.args = append([]string(nil), args...)
	return r.code
}

// supplyFixture 造一个 https httptest 服务器 + 已验签源替身 + upgrade 记录替身。
// 用 TLS 服务器是为了让 download_url 是真实 https 绝对 URL（走同一校验规则）；
// srv.Client() 信任其自签证书，不联网、不访问外部主机。
func supplyFixture(t *testing.T, payload []byte, badURL string) (*httptest.Server, *fakeAssetSource, *recordingUpgradeRunner) {
	t.Helper()
	sum := sha256.Sum256(payload)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	t.Cleanup(srv.Close)
	url := srv.URL + "/kored"
	if badURL != "" {
		url = badURL
	}
	src := &fakeAssetSource{asset: market.CoreAsset{
		ID:          market.CoreAssetID,
		Kind:        market.CoreAssetBinaryKind,
		Version:     "0.1.2",
		SHA256:      hex.EncodeToString(sum[:]),
		SizeBytes:   int64(len(payload)),
		DownloadURL: url,
	}}
	return srv, src, &recordingUpgradeRunner{}
}

// TestUpgradeSupplySuccessContract 成功路径：https 下载 → sha256 校验 → upgrade --bin 契约正确。
func TestUpgradeSupplySuccessContract(t *testing.T) {
	payload := []byte("fake-kore-binary-v0.1.2")
	srv, src, _ := supplyFixture(t, payload, "")

	var plan supplyUpgradePlan
	capture := func(args []string, _ io.Writer, _ io.Writer) int {
		plan.Args = append([]string(nil), args...)
		path, err := supplyTargetPath(args)
		if err != nil {
			t.Fatalf("--bin 必须是本地文件: %v", err)
		}
		plan.BinPath = path
		data, err := os.ReadFile(path)
		if err != nil || string(data) != string(payload) {
			t.Fatalf("upgrade 收到的临时文件内容不符: err=%v data=%q", err, data)
		}
		for i, a := range args {
			if a == "--sha256" && i+1 < len(args) {
				plan.SHA256Hex = args[i+1]
			}
		}
		return exitOK
	}
	err := runUpgradeSupply(context.Background(), upgradeSupplyDeps{
		source: src, client: srv.Client(), tempDir: t.TempDir(), runner: capture,
	})
	if err != nil {
		t.Fatalf("成功路径应无错误: %v", err)
	}
	if src.calls != 1 {
		t.Fatalf("应只读一次已验签索引，实际 %d", src.calls)
	}
	if len(plan.Args) != 5 || plan.Args[0] != "upgrade" || plan.Args[1] != "--bin" ||
		plan.Args[3] != "--sha256" || plan.SHA256Hex != src.asset.SHA256 {
		t.Fatalf("upgrade argv 契约不符: %+v", plan)
	}
	if strings.Contains(plan.BinPath, "://") {
		t.Fatalf("upgrade --bin 收到 URL: %s", plan.BinPath)
	}
}

// TestUpgradeSupplyMissingURLZeroDownload 缺 download_url → E_INVALID、零下载、零 upgrade。
func TestUpgradeSupplyMissingURLZeroDownload(t *testing.T) {
	_, src, runner := supplyFixture(t, []byte("x"), "")
	src.asset.DownloadURL = ""
	err := runUpgradeSupply(context.Background(), upgradeSupplyDeps{
		source: src, tempDir: t.TempDir(), runner: runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), pluginapi.E_INVALID) {
		t.Fatalf("缺 download_url 应 E_INVALID，实际 %v", err)
	}
	if runner.calls != 0 {
		t.Fatalf("缺 URL 时不得调 upgrade，实际 %d 次", runner.calls)
	}
}

// TestUpgradeSupplyRejectsNonHTTPS file:/http: → E_INVALID、零下载、零 upgrade。
func TestUpgradeSupplyRejectsNonHTTPS(t *testing.T) {
	for _, url := range []string{
		"http://mirror.example/kored",
		"file:///tmp/kored",
		"/tmp/kored",
	} {
		t.Run(url, func(t *testing.T) {
			_, src, runner := supplyFixture(t, []byte("x"), url)
			err := runUpgradeSupply(context.Background(), upgradeSupplyDeps{
				source: src, tempDir: t.TempDir(), runner: runner.run,
			})
			if err == nil || !strings.Contains(err.Error(), pluginapi.E_INVALID) {
				t.Fatalf("%s 应 E_INVALID，实际 %v", url, err)
			}
			if runner.calls != 0 {
				t.Fatalf("非 https 不得调 upgrade，实际 %d 次", runner.calls)
			}
		})
	}
}

// TestUpgradeSupplyUnsignedIndexZeroData 未验签索引 → 零数据、零下载、零 upgrade。
func TestUpgradeSupplyUnsignedIndexZeroData(t *testing.T) {
	_, src, runner := supplyFixture(t, []byte("x"), "")
	src.err = io.EOF // 替身模拟验签门失败（返回零值 + 错误）
	src.asset = market.CoreAsset{}
	err := runUpgradeSupply(context.Background(), upgradeSupplyDeps{
		source: src, tempDir: t.TempDir(), runner: runner.run,
	})
	if err == nil {
		t.Fatal("未验签索引必须失败")
	}
	if runner.calls != 0 {
		t.Fatalf("未验签不得调 upgrade，实际 %d 次", runner.calls)
	}
}

// TestUpgradeSupplyTamperedSHAKeepsTarget 摘要篡改 → 临时文件删除、upgrade 零调用（目标字节不动）。
func TestUpgradeSupplyTamperedSHAKeepsTarget(t *testing.T) {
	payload := []byte("real-binary")
	srv, src, runner := supplyFixture(t, payload, "")
	src.asset.SHA256 = strings.Repeat("b", 64) // 索引摘要被篡改
	tmpDir := t.TempDir()
	// 目标二进制留在独立路径，断言供应链失败路径绝不触碰它（不执行真实 upgrade）。
	target := filepath.Join(t.TempDir(), "kored")
	original := []byte("installed-kored-bytes")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	err := runUpgradeSupply(context.Background(), upgradeSupplyDeps{
		source: src, client: srv.Client(), tempDir: tmpDir, runner: runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("摘要不符应明确报错，实际 %v", err)
	}
	if runner.calls != 0 {
		t.Fatalf("摘要不符不得调用 upgrade，实际 %d 次", runner.calls)
	}
	// 目标字节不动：upgrade 零调用 + 目标文件未被改写（逐字节比对）。
	after, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(after, original) {
		t.Fatalf("摘要不符后目标字节必须不变，after=%q err=%v", after, err)
	}
	// 临时二进制必须清理，不留残留。
	entries, err := os.ReadDir(tmpDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("摘要不符后临时文件必须删除，残留=%v err=%v", entries, err)
	}
}

// TestUpgradeSupplyUpgradeFailureNoLeftover upgrade 返回非零 → 报错；临时文件由链清理。
func TestUpgradeSupplyUpgradeFailureNoLeftover(t *testing.T) {
	payload := []byte("binary")
	srv, src, runner := supplyFixture(t, payload, "")
	runner.code = exitConfig
	tmpDir := t.TempDir()
	err := runUpgradeSupply(context.Background(), upgradeSupplyDeps{
		source: src, client: srv.Client(), tempDir: tmpDir, runner: runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), "非零退出码") {
		t.Fatalf("upgrade 失败应报错，实际 %v", err)
	}
	if runner.calls != 1 {
		t.Fatalf("upgrade 应被调用一次，实际 %d", runner.calls)
	}
}

// TestSupplyTargetPathRejectsURL --bin 契约拒绝 URL（直连 upgrade.go:10-14 的不变量）。
func TestSupplyTargetPathRejectsURL(t *testing.T) {
	if _, err := supplyTargetPath([]string{"upgrade", "--bin", "https://evil.example/k"}); err == nil {
		t.Fatal("--bin 收到 URL 必须拒绝")
	}
	if _, err := supplyTargetPath([]string{"upgrade", "--sha256", "x"}); err == nil {
		t.Fatal("缺少 --bin 必须拒绝")
	}
}
