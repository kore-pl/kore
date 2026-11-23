package installer

import (
	"encoding/json"
	"errors"
	"strings"
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
	// GrantedCapabilities 授予记录（谁授的 / 什么时候 / 授了哪些）。
	// 老库安装的记录没有该字段（nil），由装配层启动时 BackfillGrant 回填。
	GrantedCapabilities *Grant `json:"granted_capabilities,omitempty"`
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
//
// 升级/重装（同 id 已有记录）保留原有 desired 状态：热升级后 reloadOne 依据
// desired=enabled 自动拉起新版本；actual 统一先记 stopped，待重载后回写真实状态。
// 首次安装仍写 desired=disabled。
func (in *Installer) record(manifest *registry.Manifest, sum string) error {
	if in.store == nil {
		return wrap(ErrStore, "状态库句柄为空")
	}
	previous, previousDesired, previousGrant, err := in.previous(manifest.ID)
	if err != nil {
		return err
	}
	grant, changed, added := nextGrant(previousGrant, manifest.Capabilities, manifest.Version, time.Now().UTC())
	if changed && len(added) > 0 {
		// 升级新增能力：默认放行（不阻断升级/启用），但必须留下可核对记录并告警。
		in.logger.Warn("插件升级新增能力，已自动扩展授予并记录待确认项",
			"plugin_id", manifest.ID, "version", manifest.Version,
			"added", strings.Join(added, ","), "grant", describeGrant(grant))
	}
	now := time.Now().UTC().Format(time.RFC3339)
	pluginRaw, err := json.Marshal(pluginRecord{
		ID:           manifest.ID,
		Name:         manifest.Name,
		Version:      manifest.Version,
		Lifecycle:    string(manifest.Lifecycle),
		IdleTimeoutS: manifest.IdleTimeoutS,
		Protocol:     manifest.Protocol,
		RequiresKore: manifest.RequiresKore,
		Capabilities: manifest.Capabilities,
		// 授予记录与 plugins 记录同一事务落库：不会出现"有声明无授予"的中间态。
		GrantedCapabilities: &grant,
		Resources:           manifest.Resources,
		InstalledAt:         now,
		PackageSHA256:       sum,
		Signed:              hasSignature(manifest.Dir),
		Source:              sourceManual,
		DependsOn:           manifest.DependsOn,
		SizeBytes:           manifest.SizeBytes,
		StoreVisibility:     storeVisibility,
		PrevVersion:         previous,
	})
	if err != nil {
		return wrap(ErrStore, "序列化插件记录失败：%v", err)
	}
	desired := stateDesired
	if previousDesired == "enabled" {
		desired = previousDesired
	}
	err = in.store.Update(func(tx *store.Tx) error {
		// 读改写而非整体覆盖：stateRecord 只认识安装器负责的字段，直接覆盖会把
		// 装配层写入的 post_upgrade_pending（禁用态升级的唯一凭据）、restarts 以及
		// 未来版本追加的未知字段一起抹掉——同版本强制重装即可触发，迁移永久丢失。
		existing, getErr := tx.Get(bucketPluginState, manifest.ID)
		if getErr != nil && !errors.Is(getErr, store.ErrNotFound) {
			return getErr
		}
		stateRaw, mergeErr := mergeStateRecord(existing, desired, stateActual, now)
		if mergeErr != nil {
			return mergeErr
		}
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

// PreviousVersion 读取 plugins bucket 里该插件当前记录的版本；未安装返回空串。
//
// 供装配层在安装前快照 previous_version（商店升级响应显示 v旧 → v新）；
// 只读，不依赖 Installer 实例，因此不改变安装器现有的安装/强制安装接口。
func PreviousVersion(p Persister, id string) (string, error) {
	if p == nil || id == "" {
		return "", nil
	}
	var version string
	err := p.View(func(tx *store.Tx) error {
		raw, getErr := tx.Get(bucketPlugins, id)
		if getErr != nil {
			if errors.Is(getErr, store.ErrNotFound) {
				return nil
			}
			return getErr
		}
		var existing pluginRecord
		if unmarshalErr := json.Unmarshal(raw, &existing); unmarshalErr != nil {
			return unmarshalErr
		}
		version = existing.Version
		return nil
	})
	if err != nil {
		return "", wrap(ErrStore, "读取已装版本失败：%v", err)
	}
	return version, nil
}

// mergeStateRecord 在既有 plugin_state 值上只覆盖安装器负责的字段
// （desired / actual / updated_at），其余字段原样保留。
//
// 保留范围包括装配层写入的 post_upgrade_pending / restarts，以及未来版本追加、
// 本包尚不认识的字段——「整体覆盖」会静默丢数据，而这份记录是跨层共用的。
// 解析放在一处收口：只做 JSON 对象级合并，不解释未知字段的语义。
func mergeStateRecord(existing []byte, desired, actual, updatedAt string) ([]byte, error) {
	fields := make(map[string]json.RawMessage)
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &fields); err != nil {
			return nil, err
		}
	}
	if fields == nil {
		fields = make(map[string]json.RawMessage)
	}
	owned := map[string]string{
		"desired":    desired,
		"actual":     actual,
		"updated_at": updatedAt,
	}
	for key, value := range owned {
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		fields[key] = raw
	}
	// 首次安装补上 restarts，保持 DATA-MODEL §5 的记录形状与既有行为一致；
	// 已存在时不重置（重启计数属运行期事实，重装不应清零）。
	if _, ok := fields["restarts"]; !ok {
		fields["restarts"] = json.RawMessage("0")
	}
	return json.Marshal(fields)
}

// previous 读已装版本、期望状态与既有授予记录；不存在返回空值（首次安装）。
func (in *Installer) previous(id string) (version, desired string, grant *Grant, err error) {
	err = in.store.View(func(tx *store.Tx) error {
		raw, getErr := tx.Get(bucketPlugins, id)
		if getErr != nil && !errors.Is(getErr, store.ErrNotFound) {
			return getErr
		}
		if getErr == nil {
			var existing pluginRecord
			if unmarshalErr := json.Unmarshal(raw, &existing); unmarshalErr != nil {
				return unmarshalErr
			}
			version = existing.Version
			grant = existing.GrantedCapabilities
		}
		stateRaw, getStateErr := tx.Get(bucketPluginState, id)
		if getStateErr != nil {
			if errors.Is(getStateErr, store.ErrNotFound) {
				return nil
			}
			return getStateErr
		}
		var state stateRecord
		if unmarshalErr := json.Unmarshal(stateRaw, &state); unmarshalErr != nil {
			return unmarshalErr
		}
		desired = state.Desired
		return nil
	})
	if err != nil {
		return "", "", nil, wrap(ErrStore, "读取已装记录失败：%v", err)
	}
	return version, desired, grant, nil
}
