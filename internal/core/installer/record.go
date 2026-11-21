package installer

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/store"
)

// 落库常量；bucket 名与 DATA-MODEL §5 一致，source 固定 manual（M1 只有本地包安装）。
const (
	bucketPlugins     = "plugins"
	bucketPluginState = "plugin_state"
	stateDesired      = "disabled"
	stateActual       = "stopped"
	sourceManual      = "manual"
	storeVisibility   = "public"
)

// pluginRecord 是 plugins bucket 的值（字段集见 DATA-MODEL §5）。
type pluginRecord struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Name 展示名。
	Name string `json:"name"`
	// Version 当前安装版本。
	Version string `json:"version"`
	// Lifecycle 生命周期（三值原样落盘，运行期是否支持由 registry 判定）。
	Lifecycle string `json:"lifecycle"`
	// IdleTimeoutS lazy 空闲退出秒数；0 表示未声明。
	IdleTimeoutS int `json:"idle_timeout_s,omitempty"`
	// Protocol 协议主版本。
	Protocol string `json:"protocol"`
	// RequiresKore 内核版本区间。
	RequiresKore string `json:"requires_kore"`
	// Capabilities 声明的能力（授权由安装/启用/调用三处分别校验）。
	Capabilities []string `json:"capabilities"`
	// Resources 资源预算。
	Resources registry.Resources `json:"resources"`
	// InstalledAt 安装时间（RFC3339）。
	InstalledAt string `json:"installed_at"`
	// PackageSHA256 安装时自算的包哈希（不采信包内声明）。
	PackageSHA256 string `json:"package_sha256"`
	// Signed 是否带签名文件；M1 只记录存在性，不验签。
	Signed bool `json:"signed"`
	// Source 安装来源：store / local / embedded / manual。
	Source string `json:"source"`
	// ScenarioID 首次安装来源预设；手动安装为空。
	ScenarioID string `json:"scenario_id"`
	// DependsOn 依赖插件 id。
	DependsOn []string `json:"depends_on,omitempty"`
	// SizeBytes 安装后占用字节数（取清单声明）。
	SizeBytes int64 `json:"size_bytes"`
	// StoreVisibility 商店可见性。
	StoreVisibility string `json:"store_visibility"`
	// PrevVersion 上一版本（升级时保留，供回滚）。
	PrevVersion string `json:"prev_version,omitempty"`
}

// stateRecord 是 plugin_state bucket 的值；安装后初始为 disabled/stopped。
type stateRecord struct {
	// Desired 期望状态。
	Desired string `json:"desired"`
	// Actual 实际状态。
	Actual string `json:"actual"`
	// Restarts 重启计数。
	Restarts int `json:"restarts"`
	// UpdatedAt 本次写入时间。
	UpdatedAt string `json:"updated_at"`
}

// record 写入 plugins 与 plugin_state 两条记录；失败返回 ErrStore 供上层回滚目录。
func (in *Installer) record(manifest *registry.Manifest, sum string) error {
	if in.store == nil {
		return wrap(ErrStore, "状态库句柄为空")
	}
	previous, err := in.previousVersion(manifest.ID)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	pluginRaw, err := json.Marshal(pluginRecord{
		ID:              manifest.ID,
		Name:            manifest.Name,
		Version:         manifest.Version,
		Lifecycle:       string(manifest.Lifecycle),
		IdleTimeoutS:    manifest.IdleTimeoutS,
		Protocol:        manifest.Protocol,
		RequiresKore:    manifest.RequiresKore,
		Capabilities:    manifest.Capabilities,
		Resources:       manifest.Resources,
		InstalledAt:     now,
		PackageSHA256:   sum,
		Signed:          hasSignature(manifest.Dir),
		Source:          sourceManual,
		DependsOn:       manifest.DependsOn,
		SizeBytes:       manifest.SizeBytes,
		StoreVisibility: storeVisibility,
		PrevVersion:     previous,
	})
	if err != nil {
		return wrap(ErrStore, "序列化插件记录失败：%v", err)
	}
	stateRaw, err := json.Marshal(stateRecord{
		Desired: stateDesired, Actual: stateActual, UpdatedAt: now,
	})
	if err != nil {
		return wrap(ErrStore, "序列化插件状态失败：%v", err)
	}
	err = in.store.Update(func(tx *store.Tx) error {
		if err := tx.Put(bucketPlugins, manifest.ID, pluginRaw); err != nil {
			return err
		}
		return tx.Put(bucketPluginState, manifest.ID, stateRaw)
	})
	if err != nil {
		return wrap(ErrStore, "写入插件记录失败：%v", err)
	}
	return nil
}

// previousVersion 读已装版本；不存在返回空串（首次安装）。
func (in *Installer) previousVersion(id string) (string, error) {
	var version string
	err := in.store.View(func(tx *store.Tx) error {
		raw, err := tx.Get(bucketPlugins, id)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		var existing pluginRecord
		if err := json.Unmarshal(raw, &existing); err != nil {
			return err
		}
		version = existing.Version
		return nil
	})
	if err != nil {
		return "", wrap(ErrStore, "读取已装记录失败：%v", err)
	}
	return version, nil
}
