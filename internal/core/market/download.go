package market

import (
	"context"
	"errors"
	"strings"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// URLInstaller 是"按索引 download_url 下载并安装"所需的最小能力，由装配层与本地包安装
// 用同一个对象实现（cmd/kored 的 marketInstaller）。
//
// market 只负责"从已验签索引取 URL 与 sha256 并触发"；下载、大小限制、摘要校验、
// 解包落位全部在 installer，内核不存在第二条安装链路。
type URLInstaller interface {
	// InstallFromURL 下载 url 指向的包，sha256 与 wantSHA256 一致才安装。
	InstallFromURL(ctx context.Context, id, version, url, wantSHA256 string) error
}

// ForceURLInstaller 是按索引下载的强制重装能力（同 id 同版本覆盖安装）。
// 与 ForceInstaller 同源：装配层先停用插件、备份旧目录、恢复期望态。
type ForceURLInstaller interface {
	// InstallFromURLForce 下载并强制覆盖安装，语义同 InstallFromURL。
	InstallFromURLForce(ctx context.Context, id, version, url, wantSHA256 string) error
}

// InstallDownload 按 id@version 从索引 download_url 下载安装。
//
// 安全边界（docs/SECURITY.md §12.1，防 SSRF）：URL 只从 readTrusted 返回的索引条目里取，
// 请求体没有任何字段能把地址传进来。没有摘要就没有信任链：缺 sha256 的条目在加载期就被
// validateIndex 拒掉，installer 还会再校验摘要形态与内容一致性；协议只允许 https，也由 installer 判定。
func (s *Service) InstallDownload(ctx context.Context, id, version string) (*InstallJob, error) {
	return s.installDownload(ctx, id, version, false)
}

// InstallDownloadForce 按索引下载并强制覆盖安装（修复/重装）。
func (s *Service) InstallDownloadForce(ctx context.Context, id, version string) (*InstallJob, error) {
	return s.installDownload(ctx, id, version, true)
}

// installDownload 是下载安装的唯一实现；force 只切换安装器能力，不跳过任何校验。
func (s *Service) installDownload(ctx context.Context, id, version string, force bool) (*InstallJob, error) {
	index, err := s.readTrusted()
	if err != nil {
		return nil, err
	}
	found, err := findEntry(index, id, version)
	if err != nil {
		return nil, err
	}
	// sha256 的存在性与格式由 parseIndex→validateIndex 在加载期强制（缺摘要的条目根本进不来），
	// installer 侧还会再校验一次形态；这里只补 validateIndex 未覆盖的 download_url 缺失。
	if strings.TrimSpace(found.DownloadURL) == "" {
		return nil, protocolError(pluginapi.E_INVALID, "索引未声明 download_url", id)
	}
	sha := strings.ToLower(found.SHA256)
	if force {
		downloader, ok := s.installer.(ForceURLInstaller)
		if !ok {
			return nil, protocolError(pluginapi.E_UNSUPPORTED, "安装后端不支持强制重装", id)
		}
		if err := downloader.InstallFromURLForce(ctx, found.ID, found.Version,
			found.DownloadURL, sha); err != nil {
			return nil, installError(err)
		}
	} else {
		downloader, ok := s.installer.(URLInstaller)
		if !ok {
			return nil, protocolError(pluginapi.E_UNSUPPORTED, "安装后端不支持下载安装", id)
		}
		if err := downloader.InstallFromURL(ctx, found.ID, found.Version,
			found.DownloadURL, sha); err != nil {
			return nil, installError(err)
		}
	}
	return &InstallJob{
		ID: id + "-" + version, PluginID: id, Version: version,
		State: "succeeded", Message: "安装完成",
	}, nil
}

// installError 把 installer 的错误分类映射成对外错误码：
// 上游下载失败或摘要与索引声明不符 → E_UPSTREAM（502，可重试或换源）；
// 已装同版本 → E_CONFLICT（409，提示用 force=true 重装）；
// 其余校验失败 → E_INVALID（400，请求或包本身不合法）。
func installError(err error) *pluginapi.Error {
	switch {
	case errors.Is(err, installer.ErrUpstream):
		return protocolError(pluginapi.E_UPSTREAM, "包下载或摘要校验失败", err.Error())
	case errors.Is(err, installer.ErrConflict):
		return protocolError(pluginapi.E_CONFLICT, "该版本已安装；重装请带 force=true", err.Error())
	case errors.Is(err, installer.ErrChecksum):
		return protocolError(pluginapi.E_INVALID, "包 sha256 校验失败", err.Error())
	default:
		return protocolError(pluginapi.E_INVALID, "安装失败", err.Error())
	}
}
