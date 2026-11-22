package installer_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
)

// servePackage 用 TLS 测试服务器假扮下载源，直接回写包字节（不受工作目录影响）。
func servePackage(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/gzip")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// packageURL 返回假下载源的包地址。
func packageURL(srv *httptest.Server, name string) string {
	return srv.URL + "/" + name
}

// assertTmpEmpty 断言 <state_dir>/tmp 下没有残留包文件（目录不存在也视为干净）。
func assertTmpEmpty(t *testing.T, stateDir string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(stateDir, "tmp"))
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatalf("读取下载临时目录失败: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("下载临时目录应无残留，实际: %v", names)
	}
}

// TestInstallFromURLSuccess 覆盖正常路径：下载 → 流式 sha256 校验 → 复用 Install 落位落库。
func TestInstallFromURLSuccess(t *testing.T) {
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	body, err := os.ReadFile(pkg)
	if err != nil {
		t.Fatalf("读取测试包失败: %v", err)
	}
	sum := sha256.Sum256(body)
	srv := servePackage(t, body)
	f := newFixtureWith(t, installer.Limits{}, srv.Client())

	if err := f.inst.InstallFromURL(context.Background(), "site", "0.1.0",
		packageURL(srv, "site-0.1.0.tar.gz"), hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("下载安装应成功: %v", err)
	}
	entry := filepath.Join(f.pluginRoot(), "site", "0.1.0", "bin", "site")
	if info, err := os.Stat(entry); err != nil {
		t.Fatalf("bin/site 未落位: %v", err)
	} else if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("bin/site 缺少执行位: %v", info.Mode())
	}
	record := f.pluginRecord(t, "site")
	if record["version"] != "0.1.0" || record["package_sha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("plugins 记录不符: %v", record)
	}
	assertTmpEmpty(t, f.stateDir)
	assertEmptyDir(t, filepath.Join(f.pluginRoot(), ".staging"))
}

// TestInstallFromURLSHA256Mismatch 覆盖信任链核心：摘要与索引声明不符即拒，且不留目录与临时文件。
func TestInstallFromURLSHA256Mismatch(t *testing.T) {
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	body, err := os.ReadFile(pkg)
	if err != nil {
		t.Fatalf("读取测试包失败: %v", err)
	}
	srv := servePackage(t, body)
	f := newFixtureWith(t, installer.Limits{}, srv.Client())
	declared := strings.Repeat("0", 64)

	err = f.inst.InstallFromURL(context.Background(), "site", "0.1.0",
		packageURL(srv, "site-0.1.0.tar.gz"), declared)
	if err == nil {
		t.Fatal("摘要不符必须拒绝")
	}
	if !errors.Is(err, installer.ErrUpstream) {
		t.Fatalf("摘要不符应归 ErrUpstream（对外 E_UPSTREAM），实际: %v", err)
	}
	if !errors.Is(err, installer.ErrChecksum) {
		t.Fatalf("摘要不符同时应是 ErrChecksum，实际: %v", err)
	}
	if !strings.Contains(err.Error(), "sha256 与索引声明不符") {
		t.Fatalf("应命中摘要比对分支，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
	assertTmpEmpty(t, f.stateDir)
}

// TestInstallFromURLOversize 覆盖超大文件：超限即中止，不落位、不留临时文件。
func TestInstallFromURLOversize(t *testing.T) {
	limits := installer.Limits{MaxPackageBytes: 1024}
	// 不给 Content-Length（分块写），专门验证正文字节的流式上限兜底。
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chunk := []byte(strings.Repeat("x", 512))
		for i := 0; i < 8; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
		}
	}))
	t.Cleanup(srv.Close)
	f := newFixtureWith(t, limits, srv.Client())

	err := f.inst.InstallFromURL(context.Background(), "site", "0.1.0",
		packageURL(srv, "site-0.1.0.tar.gz"), strings.Repeat("a", 64))
	if err == nil || !errors.Is(err, installer.ErrUpstream) {
		t.Fatalf("超限应中止并归 ErrUpstream，实际: %v", err)
	}
	// 断言命中的确实是"正文流式上限"，不是握手/连接类失败。
	if !strings.Contains(err.Error(), "超过上限") {
		t.Fatalf("应命中正文大小上限分支，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
	assertTmpEmpty(t, f.stateDir)
}

// TestInstallFromURLRejectsNonHTTPS 只允许 https：http / file / gopher / 空 scheme 全部拒，且不发请求。
func TestInstallFromURLRejectsNonHTTPS(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(srv.Close)
	cases := map[string]string{
		"http":   srv.URL + "/site-0.1.0.tar.gz",
		"file":   "file:///tmp/site-0.1.0.tar.gz",
		"gopher": "gopher://127.0.0.1:70/1/site-0.1.0.tar.gz",
		"ftp":    "ftp://127.0.0.1/site-0.1.0.tar.gz",
		"nosch":  "//127.0.0.1/site-0.1.0.tar.gz",
	}
	for name, url := range cases {
		f := newFixture(t, installer.Limits{})
		err := f.inst.InstallFromURL(context.Background(), "site", "0.1.0", url, strings.Repeat("a", 64))
		if err == nil || !errors.Is(err, installer.ErrInvalid) {
			t.Fatalf("%s: 非 https 应 ErrInvalid，实际: %v", name, err)
		}
		if hits.Load() != 0 {
			t.Fatalf("%s: 非 https 不得发起请求，实际命中 %d 次", name, hits.Load())
		}
		assertTmpEmpty(t, f.stateDir)
	}
}

// TestInstallFromURLRejectsMissingSHA 索引没给合法 sha256 时不许下载——没有摘要就没有信任链。
func TestInstallFromURLRejectsMissingSHA(t *testing.T) {
	for _, want := range []string{"", "  ", "not-a-hash", strings.Repeat("z", 64)} {
		f := newFixture(t, installer.Limits{})
		err := f.inst.InstallFromURL(context.Background(), "site", "0.1.0",
			"https://127.0.0.1/site-0.1.0.tar.gz", want)
		if err == nil || !errors.Is(err, installer.ErrInvalid) {
			t.Fatalf("sha256=%q 应 ErrInvalid，实际: %v", want, err)
		}
		assertTmpEmpty(t, f.stateDir)
	}
}

// TestInstallFromURLDownloadFailure 下载源 5xx 归 ErrUpstream，且不留临时文件。
func TestInstallFromURLDownloadFailure(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	f := newFixtureWith(t, installer.Limits{}, srv.Client())

	err := f.inst.InstallFromURL(context.Background(), "site", "0.1.0",
		packageURL(srv, "site-0.1.0.tar.gz"), strings.Repeat("a", 64))
	if err == nil || !errors.Is(err, installer.ErrUpstream) {
		t.Fatalf("下载失败应 ErrUpstream，实际: %v", err)
	}
	if !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("应命中 HTTP 状态分支，实际: %v", err)
	}
	assertTmpEmpty(t, f.stateDir)
	f.assertNoResidue(t, "site", "0.1.0")
}

// TestInstallFromURLPackageIDMismatch 摘要通过但包内 id 与请求不符：Install 拒绝，临时文件仍被清理。
func TestInstallFromURLPackageIDMismatch(t *testing.T) {
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	body, err := os.ReadFile(pkg)
	if err != nil {
		t.Fatalf("读取测试包失败: %v", err)
	}
	sum := sha256.Sum256(body)
	srv := servePackage(t, body)
	f := newFixtureWith(t, installer.Limits{}, srv.Client())

	// 请求 echo，实际下到的是 site 包：摘要是对的，但 id 与包名/清单不一致必须拒。
	err = f.inst.InstallFromURL(context.Background(), "echo", "0.1.0",
		packageURL(srv, "echo-0.1.0.tar.gz"), hex.EncodeToString(sum[:]))
	if err == nil || !errors.Is(err, installer.ErrInvalid) {
		t.Fatalf("id 不符应 ErrInvalid，实际: %v", err)
	}
	assertTmpEmpty(t, f.stateDir)
	f.assertNoResidue(t, "echo", "0.1.0")
}

// TestInstallFromURLRejectsBadRef 非法 id/version 在拼路径前就被拒（防目录穿越）。
func TestInstallFromURLRejectsBadRef(t *testing.T) {
	cases := []struct{ id, version string }{
		{"../etc", "0.1.0"},
		{"site", "0.1"},
		{"Site", "0.1.0"},
		{"site", "0.1.0/../../x"},
	}
	for _, tc := range cases {
		f := newFixture(t, installer.Limits{})
		err := f.inst.InstallFromURL(context.Background(), tc.id, tc.version,
			"https://127.0.0.1/site-0.1.0.tar.gz", strings.Repeat("a", 64))
		if err == nil || !errors.Is(err, installer.ErrInvalid) {
			t.Fatalf("id=%q version=%q 应 ErrInvalid，实际: %v", tc.id, tc.version, err)
		}
	}
}
