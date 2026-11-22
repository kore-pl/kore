package market

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
)

// fakeURLInstaller 同时满足 Installer 与 URLInstaller：记录下载安装的入参。
type fakeURLInstaller struct {
	calls  int
	gotID  string
	gotVer string
	gotURL string
	gotSHA string
	err    error
}

// Install 是本地包安装入口；下载测试不走这里，调用即记错。
func (f *fakeURLInstaller) Install(path, expectedSHA string) error {
	return errors.New("下载测试不应走本地包安装")
}

// InstallFromURL 记录入参并返回预设错误。
func (f *fakeURLInstaller) InstallFromURL(_ context.Context, id, version, url, wantSHA256 string) error {
	f.calls++
	f.gotID, f.gotVer, f.gotURL, f.gotSHA = id, version, url, wantSHA256
	return f.err
}

// downloadIndex 生成一条带 https download_url 的索引；sha 由调用方给。
func downloadIndex(sha, url string) string {
	return `{"schema_version":1,"plugins":[
 {"id":"echo","name":"Echo","version":"0.1.1","depth_level":"basic","lifecycle":"resident",
  "size_bytes":1,"sha256":"` + sha + `","download_url":"` + url + `",
  "requires_kore":">=0.1.0 <0.2.0","depends_on":[],"conflicts":[],"scenario_tags":[]}
]}`
}

// newDownloadService 用测试密钥签一份下载索引，并把 installer 换成可观测的假实现。
func newDownloadService(t *testing.T, body string) (*Service, *fakeURLInstaller) {
	t.Helper()
	svc, _, _ := signedFixture(t, body)
	fake := &fakeURLInstaller{}
	svc.installer = fake
	return svc, fake
}

// TestInstallDownloadSuccess 下载路径把索引里的 download_url 与小写 sha256 原样交给安装器。
func TestInstallDownloadSuccess(t *testing.T) {
	sha := strings.Repeat("A", 64) // 索引大写也应归一化成小写再比对
	url := "https://mirror.example/echo-0.1.1.tar.gz"
	svc, fake := newDownloadService(t, downloadIndex(strings.ToLower(sha), url))

	job, err := svc.InstallDownload(context.Background(), "echo", "0.1.1")
	if err != nil {
		t.Fatalf("下载安装应成功: %v", err)
	}
	if job.State != "succeeded" || job.PluginID != "echo" || job.Version != "0.1.1" {
		t.Fatalf("任务视图不符: %+v", job)
	}
	if fake.calls != 1 || fake.gotURL != url || fake.gotSHA != strings.ToLower(sha) {
		t.Fatalf("安装器入参不符: calls=%d url=%q sha=%q", fake.calls, fake.gotURL, fake.gotSHA)
	}
}

// TestInstallDownloadRequiresVerifiedIndex 索引被篡改（签名不再匹配）时，默认配置下拒绝且绝不下载。
func TestInstallDownloadRequiresVerifiedIndex(t *testing.T) {
	svc, dir, _ := signedFixture(t, downloadIndex(strings.Repeat("a", 64), "https://mirror.example/echo-0.1.1.tar.gz"))
	fake := &fakeURLInstaller{}
	svc.installer = fake
	// 只改索引本体、保留旧签名：验签必失败。
	tampered := downloadIndex(strings.Repeat("b", 64), "https://evil.example/echo-0.1.1.tar.gz")
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := svc.InstallDownload(context.Background(), "echo", "0.1.1")
	if err == nil || !strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("篡改索引应 E_UNAUTHORIZED，实际: %v", err)
	}
	if fake.calls != 0 {
		t.Fatalf("验签失败时不得触发下载，实际调用 %d 次", fake.calls)
	}
}

// TestInstallDownloadRejectsMissingSHA 索引条目缺 sha256 时，加载期即拒——绝不进入下载。
func TestInstallDownloadRejectsMissingSHA(t *testing.T) {
	svc, fake := newDownloadService(t, downloadIndex("", "https://mirror.example/echo-0.1.1.tar.gz"))

	_, err := svc.InstallDownload(context.Background(), "echo", "0.1.1")
	if err == nil || !strings.Contains(err.Error(), "E_INVALID") {
		t.Fatalf("缺 sha256 应 E_INVALID，实际: %v", err)
	}
	if strings.Contains(err.Error(), "E_UNAUTHORIZED") {
		t.Fatalf("缺 sha256 属于索引结构非法，不应报成验签失败: %v", err)
	}
	if fake.calls != 0 {
		t.Fatalf("缺 sha256 不得触发下载，实际调用 %d 次", fake.calls)
	}
}

// TestInstallDownloadRejectsMissingURL 索引条目没有 download_url 时直接拒，不猜地址。
func TestInstallDownloadRejectsMissingURL(t *testing.T) {
	svc, fake := newDownloadService(t, downloadIndex(strings.Repeat("a", 64), ""))

	_, err := svc.InstallDownload(context.Background(), "echo", "0.1.1")
	if err == nil || !strings.Contains(err.Error(), "E_INVALID") {
		t.Fatalf("缺 download_url 应 E_INVALID，实际: %v", err)
	}
	if fake.calls != 0 {
		t.Fatalf("缺 download_url 不得触发下载，实际调用 %d 次", fake.calls)
	}
}

// TestInstallDownloadRejectsNonHTTPS 非 https 由 installer 拒绝，market 映射为 400 E_INVALID。
func TestInstallDownloadRejectsNonHTTPS(t *testing.T) {
	svc, fake := newDownloadService(t, downloadIndex(strings.Repeat("a", 64), "http://mirror.example/echo-0.1.1.tar.gz"))
	fake.err = fmt.Errorf("%w: 索引 download_url 必须是 https", installer.ErrInvalid)

	_, err := svc.InstallDownload(context.Background(), "echo", "0.1.1")
	if err == nil || !strings.Contains(err.Error(), "E_INVALID") {
		t.Fatalf("非 https 应 E_INVALID，实际: %v", err)
	}
}

// TestInstallDownloadMapsUpstreamError 摘要不符/下载失败归 E_UPSTREAM（502），不是 400。
func TestInstallDownloadMapsUpstreamError(t *testing.T) {
	svc, fake := newDownloadService(t, downloadIndex(strings.Repeat("a", 64), "https://mirror.example/echo-0.1.1.tar.gz"))
	fake.err = fmt.Errorf("%w: %w: 下载包 sha256 与索引声明不符", installer.ErrUpstream, installer.ErrChecksum)

	_, err := svc.InstallDownload(context.Background(), "echo", "0.1.1")
	if err == nil || !strings.Contains(err.Error(), "E_UPSTREAM") {
		t.Fatalf("摘要不符应映射 E_UPSTREAM，实际: %v", err)
	}
}

// TestInstallDownloadRequiresURLInstaller 安装后端只实现本地包安装时明确 501，不假装成功。
func TestInstallDownloadRequiresURLInstaller(t *testing.T) {
	svc, _, _ := signedFixture(t, downloadIndex(strings.Repeat("a", 64), "https://mirror.example/echo-0.1.1.tar.gz"))

	_, err := svc.InstallDownload(context.Background(), "echo", "0.1.1")
	if err == nil || !strings.Contains(err.Error(), "E_UNSUPPORTED") {
		t.Fatalf("后端不支持下载安装应 E_UNSUPPORTED，实际: %v", err)
	}
}

// TestInstallDownloadRejectsBadTarget 未知 id / 版本不符沿用索引定位口径。
func TestInstallDownloadRejectsBadTarget(t *testing.T) {
	svc, _ := newDownloadService(t, downloadIndex(strings.Repeat("a", 64), "https://mirror.example/echo-0.1.1.tar.gz"))
	if _, err := svc.InstallDownload(context.Background(), "nope", "0.1.1"); err == nil ||
		!strings.Contains(err.Error(), "E_NOTFOUND") {
		t.Fatalf("未知 id 应 E_NOTFOUND，实际: %v", err)
	}
	if _, err := svc.InstallDownload(context.Background(), "echo", "0.9.9"); err == nil ||
		!strings.Contains(err.Error(), "E_INVALID") {
		t.Fatalf("版本不符应 E_INVALID，实际: %v", err)
	}
}
