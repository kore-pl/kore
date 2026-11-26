package main

// 内核供应链入口（ADR-0025 §9 / ADR-0059 §3.2）：从**已验签**索引取内核资产
// 条目 → 校验 https 绝对 URL → 下载到临时文件 → sha256 先校验 → 交
// `kored upgrade --bin <本地文件> --sha256 <hex>`。market 只提供索引与 URL
// 校验规则，下载器只出站一次并流式算摘要；真正的替换/重启仍由 upgrade 完成，
// 本文件不自建第二条安装链路（G-01/G-13），也不执行真实 upgrade。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// upgradeSupplyMaxBytes 是内核二进制下载上限（64 MiB，与插件包上限同口径）。
	upgradeSupplyMaxBytes int64 = 64 << 20
	// upgradeSupplyTimeout 是单次下载的客户端总超时。
	upgradeSupplyTimeout = 60 * time.Second
)

// verifiedAssetSource 是"从已验签索引取内核资产条目"的最小能力。
// 生产用 *market.Service.VerifiedCoreAsset；测试替身只能返回显式类型条目。
type verifiedAssetSource interface {
	VerifiedCoreAsset() (market.CoreAsset, error)
}

// upgradeRunner 是"执行 kored upgrade --bin --sha256"的调用契约。
// 生产用 runUpgrade；测试替身只记录 argv，绝不替换二进制或重启 unit。
type upgradeRunner func(args []string, stdout, stderr io.Writer) int

// upgradeSupplyDeps 是整条下载链的可注入依赖（测试替身验证契约，不执行真实 upgrade）。
type upgradeSupplyDeps struct {
	source verifiedAssetSource
	client *http.Client
	runner upgradeRunner
	// tempDir 为空则用 os.MkdirTemp("", ...)；测试用 t.TempDir() 隔离落点。
	tempDir string
}

// supplyUpgradePlan 把已验签条目转成 upgrade 的 argv 契约（测试可直接断言）。
// --bin 必为本地文件路径、--sha256 必为 64 位小写 hex，且不带 URL。
type supplyUpgradePlan struct {
	BinPath   string
	SHA256Hex string
	Args      []string
}

// runUpgradeSupply 执行内核二进制自更新供应链。
//
// 顺序（任一步失败都零下载或零替换）：
//  1. 从已验签索引取条目（未验签 → 零数据、零下载）；
//  2. 校验 download_url 是 https 绝对 URL（缺/file:/http: → E_INVALID、零下载）；
//  3. 下载到工作区临时文件（边下边算 sha256，超限/中断即清理）；
//  4. 摘要与索引逐字比对，不一致则删除临时文件、绝不调用 upgrade（目标字节不动）；
//  5. 以临时文件路径 + 摘要调 upgrade --bin ... --sha256 ...（测试替身验证契约）。
func runUpgradeSupply(ctx context.Context, deps upgradeSupplyDeps) error {
	if deps.source == nil || deps.runner == nil {
		return errors.New("供应链依赖不完整：索引源与 upgrade 执行器都必填")
	}
	asset, err := deps.source.VerifiedCoreAsset()
	if err != nil {
		return fmt.Errorf("读取已验签内核资产失败: %w", err) // 验签门：零下载
	}
	// 索引侧已校验 https；下载侧复核同一规则（复用 market 校验器，无旁路）。
	if err := market.ValidateCoreAssetURL(asset.DownloadURL); err != nil {
		return err
	}
	want := strings.ToLower(asset.SHA256)

	client := deps.client
	if client == nil {
		client = &http.Client{Timeout: upgradeSupplyTimeout}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.DownloadURL, nil)
	if err != nil {
		return fmt.Errorf("构造内核资产下载请求失败: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("下载内核资产失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载内核资产失败: HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > upgradeSupplyMaxBytes {
		return fmt.Errorf("内核资产声明大小 %d 超过上限 %d", resp.ContentLength, upgradeSupplyMaxBytes)
	}

	dir := deps.tempDir
	if dir == "" {
		dir = "" // os.MkdirTemp 用系统临时目录
	}
	tmp, err := os.CreateTemp(dir, "kore-core-*")
	if err != nil {
		return fmt.Errorf("建立内核资产临时文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpPath) // 失败、摘要不符或升级失败都不留残留
		}
	}()

	hasher := sha256.New()
	// LimitReader 多放 1 字节：服务端谎报或不给长度也能在第 max+1 字节中止。
	written, err := io.Copy(io.MultiWriter(tmp, hasher),
		io.LimitReader(resp.Body, upgradeSupplyMaxBytes+1))
	if err != nil {
		return fmt.Errorf("下载内核资产中断: %w", err)
	}
	if written > upgradeSupplyMaxBytes {
		return fmt.Errorf("内核资产超过上限 %d 字节，已中止", upgradeSupplyMaxBytes)
	}
	if written != asset.SizeBytes {
		return fmt.Errorf("内核资产大小与索引不符：索引 %d，实际 %d", asset.SizeBytes, written)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("内核资产临时文件 fsync 失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭内核资产临时文件失败: %w", err)
	}
	got := hex.EncodeToString(hasher.Sum(nil))
	if got != want {
		// 校验先于替换：摘要不符时临时文件删除、upgrade 零调用（目标字节不动）。
		return fmt.Errorf("%s: 内核资产 sha256 不符：索引 %s，实际 %s",
			pluginapi.E_INVALID, want, got)
	}

	plan := supplyUpgradePlan{
		BinPath:   tmpPath,
		SHA256Hex: want,
		Args:      []string{"upgrade", "--bin", tmpPath, "--sha256", want},
	}
	if code := deps.runner(plan.Args, io.Discard, io.Discard); code != exitOK {
		return fmt.Errorf("kored upgrade 返回非零退出码 %d", code)
	}
	ok = true // upgrade 成功：临时二进制已被原子替换链消费，交由其清理语义处理
	return nil
}

// supplyTargetPath 从 upgrade argv 中取出 --bin 后的本地文件路径（契约校验用）。
func supplyTargetPath(args []string) (string, error) {
	for i, arg := range args {
		if arg == "--bin" && i+1 < len(args) {
			path := args[i+1]
			if path == "" || strings.Contains(path, "://") {
				return "", fmt.Errorf("upgrade --bin 必须是本地文件路径，实际 %q", path)
			}
			return filepath.Clean(path), nil
		}
	}
	return "", errors.New("upgrade argv 缺少 --bin <本地文件>")
}
