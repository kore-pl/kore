package installer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 下载参数（SECURITY §12.1：包下载是内核唯一的显式出站口，且只认已验签索引给出的地址）。
const (
	// downloadTimeout 是单次下载的墙钟上限：连接、TLS 握手与正文读取合计不超过 60 s。
	downloadTimeout = 60 * time.Second
	// downloadTLSHandshakeTimeout 是 TLS 握手单独上限，慢握手不能吃满整个下载预算。
	downloadTLSHandshakeTimeout = 10 * time.Second
	// downloadHeaderTimeout 是"发出请求 → 收到响应头"的上限，防半开连接挂住安装。
	downloadHeaderTimeout = 30 * time.Second
	// downloadDirName 是下载临时目录名，位于 <state_dir>/tmp。
	downloadDirName = "tmp"
	// downloadDirPrefix 是每次下载独占的子目录前缀（包文件名必须是 <id>-<version>.tar.gz，
	// 因此唯一性交给外层目录，包名保持协议形态）。
	downloadDirPrefix = "pkg-"
)

// defaultDownloadClient 是内置下载客户端：固定超时 + 禁用 keep-alive。
//
// 禁 keep-alive 是 G-19 要求：安装结束后不留空闲连接与后台读协程，
// 空载出站连接数保持 0、goroutine 不因一次安装常驻。
var defaultDownloadClient = &http.Client{
	Timeout: downloadTimeout,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   downloadTLSHandshakeTimeout,
		ResponseHeaderTimeout: downloadHeaderTimeout,
	},
}

// InstallFromURL 从索引声明的 download_url 下载并安装单个插件包。
//
// 信任链（docs/SECURITY.md §12.1）：URL 只来自调用方已验签的索引，不接受请求体传入的任意地址；
// wantSHA256 必须是索引声明值，缺失即拒绝——摘要校验是硬门槛，任何情况下都不跳过。
// 下载与哈希在同一趟流式完成（不整包读入内存），大小受 Limits.MaxPackageBytes 约束（默认 64 MiB）。
//
// 无论成功失败，下载临时目录都在 defer 中整体删除；安装失败时 Install 内部还会清理 staging，
// 因此失败安装不会在 state_dir 留半包或半装态。
func (in *Installer) InstallFromURL(ctx context.Context, id, version, rawURL, wantSHA256 string) error {
	ref, err := checkRef(id, version)
	if err != nil {
		return err
	}
	want, ok := parseSHA256Hex(wantSHA256)
	if !ok {
		return wrap(ErrInvalid, "索引未声明合法 sha256，拒绝下载安装")
	}
	if err := requireHTTPSURL(rawURL); err != nil {
		return err
	}
	dir, err := in.newDownloadDir()
	if err != nil {
		return err
	}
	defer func() {
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			in.logger.Warn("清理下载临时目录失败", "dir", dir, "err", cleanupErr)
		}
	}()
	path := filepath.Join(dir, ref.ID+"-"+ref.Version+packageSuffix)
	actual, err := in.download(ctx, rawURL, path, func(percent int) {
		in.report(ref, "download", percent, "正在下载插件包…")
	})
	if err != nil {
		return err
	}
	if actual != want {
		// 同时带 ErrChecksum（语义：摘要不符）与 ErrUpstream（对外错误码：E_UPSTREAM）：
		// 这是上游内容与索引声明不一致，不是调用方请求非法。
		return fmt.Errorf("%w: %w: 下载包 sha256 与索引声明不符：声明 %s，实际 %s",
			ErrUpstream, ErrChecksum, want, actual)
	}
	_, err = in.Install(path)
	return err
}

// checkRef 先于任何路径拼接校验 id/version 形态。
//
// 两者会拼进临时包文件名，若放任 `../` 之类输入，filepath.Join 之后 Base 语义会截断到目标目录外，
// 因此这里用与包名解析同一套规则（id 正则 + MAJOR.MINOR.PATCH）做前置门。
func checkRef(id, version string) (pkgRef, error) {
	if !packageNamePattern.MatchString(id) {
		return pkgRef{}, wrap(ErrInvalid, "插件 id=%q 不合法", id)
	}
	if _, err := parseSemver(version); err != nil {
		return pkgRef{}, wrap(ErrInvalid, "版本 %q 不合法：%v", version, err)
	}
	return pkgRef{ID: id, Version: version}, nil
}

// requireHTTPSURL 只放行 https：http/file/gopher/data 等一律拒（防 SSRF 与本地文件读取）。
func requireHTTPSURL(rawURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return wrap(ErrInvalid, "索引 download_url 非法：%v", err)
	}
	if parsed.Scheme != "https" {
		return wrap(ErrInvalid, "索引 download_url 必须是 https，实际 scheme=%q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return wrap(ErrInvalid, "索引 download_url 缺少主机")
	}
	return nil
}

// newDownloadDir 在 <state_dir>/tmp 下建本次下载独占的临时目录（0700）。
func (in *Installer) newDownloadDir() (string, error) {
	root := filepath.Join(in.stateDir, downloadDirName)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", wrap(ErrStateDir, "建立下载目录失败：%v", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return "", wrap(ErrStateDir, "设置下载目录权限失败：%v", err)
	}
	dir, err := os.MkdirTemp(root, downloadDirPrefix)
	if err != nil {
		return "", wrap(ErrStateDir, "建立下载临时目录失败：%v", err)
	}
	return dir, nil
}

// download 把 rawURL 拉到 path，同时流式计算 sha256；返回小写 hex 摘要。
//
// 上限判定两层：Content-Length 超限即拒（不浪费流量），正文用 LimitReader 多放 1 字节兜底
// ——服务端谎报或不给长度时也能在第 limit+1 字节处中止，磁盘不会被写爆。
func (in *Installer) download(ctx context.Context, rawURL, path string, report func(percent int)) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", wrap(ErrInvalid, "构造下载请求失败：%v", err)
	}
	resp, err := in.client.Do(req)
	if err != nil {
		return "", wrap(ErrUpstream, "下载包失败：%v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", wrap(ErrUpstream, "下载包失败：HTTP %d", resp.StatusCode)
	}
	limit := in.limits.MaxPackageBytes
	if resp.ContentLength > limit {
		return "", wrap(ErrUpstream, "下载包声明大小 %d 字节超过上限 %d", resp.ContentLength, limit)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", wrap(ErrStateDir, "建立临时包文件失败：%v", err)
	}
	defer func() { _ = file.Close() }()
	hasher := sha256.New()
	var body io.Reader = io.LimitReader(resp.Body, limit+1)
	if report != nil && resp.ContentLength > 0 {
		body = &progressReader{r: body, total: resp.ContentLength, report: report}
	}
	if report != nil {
		report(3)
	}
	written, err := io.Copy(io.MultiWriter(file, hasher), body)
	if err != nil {
		return "", wrap(ErrUpstream, "下载包中断：%v", err)
	}
	if written > limit {
		return "", wrap(ErrUpstream, "下载包超过上限 %d 字节，已中止", limit)
	}
	if err := file.Close(); err != nil {
		return "", wrap(ErrStateDir, "写入临时包文件失败：%v", err)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// progressReader 把下载进度折算进 3–40% 区间（每跨 4% 回调一次，避免刷屏）。
//
// 只在服务端给出 Content-Length 时启用；总长未知时由上层保留 3% 与 40% 两个锚点。
type progressReader struct {
	r      io.Reader
	total  int64
	read   int64
	last   int
	report func(percent int)
}

// Read 读取一段并上报折算后的总体进度。
func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.read += int64(n)
	if p.total > 0 {
		percent := 3 + int(p.read*37/p.total)
		if percent > 40 {
			percent = 40
		}
		if percent >= p.last+4 {
			p.last = percent
			p.report(percent)
		}
	}
	return n, err
}
