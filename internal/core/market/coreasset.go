package market

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 内核资产条目的专属标识与类型（ADR-0025 §9.2；G-24 显式常量，不用动态类型兜底）。
const (
	// CoreAssetID 是内核二进制资产在已验签索引里的固定标识。
	CoreAssetID = "kore-core"
	// CoreAssetBinaryKind 是内核二进制资产的固定类型值。
	CoreAssetBinaryKind = "kore-binary"
)

// CoreAsset 是已验签索引里的内核二进制资产条目。
//
// 对外 schema 逐字段显式列类型（ADR-0025 §9.2 / G-24）：禁动态类型与
// object 兜底，也不使用原始 JSON 承载这些字段。它与插件条目同属
// 同一份已签名索引，只是"下载后交给谁"不同：插件交 store/install，内核交
// kored upgrade --bin（命令行侧见 cmd/kored/upgrade_supply.go）。
type CoreAsset struct {
	// ID 内核资产专属标识（固定 CoreAssetID）。
	ID string `json:"id"`
	// Kind 资产类型（固定 CoreAssetBinaryKind）。
	Kind string `json:"kind"`
	// Version 目标内核版本。
	Version string `json:"version"`
	// SHA256 包摘要（64 位小写 hex）。
	SHA256 string `json:"sha256"`
	// SizeBytes 包字节数（正数，下载上限）。
	SizeBytes int64 `json:"size_bytes"`
	// DownloadURL 发布物地址（必须是 https 绝对 URL）。
	DownloadURL string `json:"download_url"`
}

// coreAssetIndex 是内核资产验签解析的窄视图：只取 core_asset 键，不解析 plugins。
// 与 Index 共用同一份已签名索引文件；字段全部显式类型，无动态类型或原始 JSON。
type coreAssetIndex struct {
	// SchemaVersion 必须是 1。
	SchemaVersion int `json:"schema_version"`
	// CoreAsset 内核二进制资产条目。
	CoreAsset CoreAsset `json:"core_asset"`
}

// ValidateCoreAssetURL 校验内核资产的 download_url 必须是 https 绝对 URL。
//
// 省略、file: / http: 等非 https scheme 一律 E_INVALID（ADR-0025 §9.3），与
// installer.requireHTTPSURL 同口径；本函数被 market 与 cmd/kored 下载链共用，
// 不存在"索引侧校验、下载侧跳过"的旁路。
func ValidateCoreAssetURL(rawURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return protocolError(pluginapi.E_INVALID, "内核资产 download_url 非法: "+err.Error())
	}
	if !parsed.IsAbs() || parsed.Scheme != "https" || parsed.Host == "" {
		return protocolError(pluginapi.E_INVALID,
			fmt.Sprintf("内核资产 download_url 必须是 https 绝对 URL，实际 %q", rawURL))
	}
	return nil
}

// validateCoreAsset 校验条目形态：标识/类型、版本、摘要、字节数、下载 URL。
// 任何一项非法都在加载期拒绝，绝不进入下载链。
func validateCoreAsset(asset CoreAsset) error {
	if asset.ID != CoreAssetID || asset.Kind != CoreAssetBinaryKind {
		return protocolError(pluginapi.E_INVALID,
			fmt.Sprintf("内核资产标识/类型不符（期望 %s/%s）", CoreAssetID, CoreAssetBinaryKind))
	}
	if strings.TrimSpace(asset.Version) == "" {
		return protocolError(pluginapi.E_INVALID, "内核资产 version 为空")
	}
	if !sha256Pattern.MatchString(asset.SHA256) {
		return protocolError(pluginapi.E_INVALID, "内核资产 sha256 非 64 位小写 hex")
	}
	if asset.SizeBytes <= 0 {
		return protocolError(pluginapi.E_INVALID, "内核资产 size_bytes 必须为正数")
	}
	return ValidateCoreAssetURL(asset.DownloadURL)
}

// VerifiedCoreAsset 从**已验签**索引里读取内核资产条目。
//
// 信任门与 readVerified 同源：现场重读 + 内置公钥验签（生产）/同包测试注入配对公钥，
// 验签失败一律返回零值 + 错误。store.allow_unsigned 显式放行**不适用于本入口**——
// ADR-0025 §9.4：未验签索引不得作为下载来源，换公钥失败按 fail-closed 处理，
// 绝不降级成"用未签名索引继续"（零数据、零下载）。
func (s *Service) VerifiedCoreAsset() (CoreAsset, error) {
	data, sig, err := readIndexFiles(s.indexDir)
	if err != nil {
		return CoreAsset{}, protocolError(pluginapi.E_UPSTREAM, "读取本地索引失败", err.Error())
	}
	if err := s.verify(data, sig); err != nil {
		return CoreAsset{}, err // 签名缺失/篡改/验签失败：零数据，绝不降级
	}
	var view coreAssetIndex
	if err := json.Unmarshal(data, &view); err != nil {
		return CoreAsset{}, protocolError(pluginapi.E_INVALID, "索引 JSON 非法", err.Error())
	}
	if view.SchemaVersion != 1 {
		return CoreAsset{}, protocolError(pluginapi.E_INVALID,
			fmt.Sprintf("不支持的 schema_version=%d", view.SchemaVersion))
	}
	if err := validateCoreAsset(view.CoreAsset); err != nil {
		return CoreAsset{}, err
	}
	return view.CoreAsset, nil
}
