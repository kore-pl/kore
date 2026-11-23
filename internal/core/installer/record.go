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
	// postUpgradePendingField 是 plugin_state 里「升级后置动作待补跑」的字段名
	// （装配层 daemon.consumePostUpgrade 消费，记录形状见 DATA-MODEL §5）。
	postUpgradePendingField = "post_upgrade_pending"
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
//
// 返回值是本次落下的「升级后置动作待补跑」版本（空表示没写标记）。只有安装器同时
// 知道「旧版本 → 新版本」与「新清单声明了 post_upgrade」，所以离线 CLI 升级
// （serve 停止、不经过 reloadOne，没有第二条热重载入口）只能在这里留下补跑凭据：
// 不写就再没有任何进程知道这个版本的动作还没跑，下次 serve 启动只会拉起新二进制，
// crontab 一类旧外部引用无人迁移。在线商店安装同样经过本函数，但 reloadOne 会在
// 拉起后直接执行或清理该标记，不会重复跑。
func (in *Installer) record(manifest *registry.Manifest, sum string) (string, error) {
	if in.store == nil {
		return "", wrap(ErrStore, "状态库句柄为空")
	}
	previous, previousDesired, previousGrant, err := in.previous(manifest.ID)
	if err != nil {
		return "", err
	}
	pending := postUpgradePending(previous, manifest)
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
		return "", wrap(ErrStore, "序列化插件记录失败：%v", err)
	}
	desired := stateDesired
	if previousDesired == "enabled" {
		desired = previousDesired
	}
	err = in.store.Update(func(tx *store.Tx) error {
		// 读改写而非整体覆盖：stateRecord 只认识安装器负责的字段，直接覆盖会把
		// 装配层/安装器写入的 post_upgrade_pending（升级迁移的唯一凭据）、restarts
		// 以及未来版本追加的未知字段一起抹掉——同版本强制重装即可触发，迁移永久丢失。
		existing, getErr := tx.Get(bucketPluginState, manifest.ID)
		if getErr != nil && !errors.Is(getErr, store.ErrNotFound) {
			return getErr
		}
		stateRaw, mergeErr := mergeStateRecord(existing, desired, stateActual, now, pending)
		if mergeErr != nil {
			return mergeErr
		}
		if err := tx.Put(bucketPlugins, manifest.ID, pluginRaw); err != nil {
			return err
		}
		return tx.Put(bucketPluginState, manifest.ID, stateRaw)
	})
	if err != nil {
		return "", wrap(ErrStore, "写入插件记录失败：%v", err)
	}
	return pending, nil
}

// postUpgradePending 判定本次安装是否必须记「升级后置动作待补跑」标记，返回待跑版本。
//
// 只有「从某个旧版本升上来」且新清单声明了 post_upgrade 才记：
//   - 首次安装（previous 为空）不是升级，不写（否则启用即误跑迁移）；
//   - 同版本强制重装不是升级，不写——也不能清掉既有标记；
//   - 未声明 post_upgrade 的插件没有动作可跑，不写。
//
// 判据只用安装器已经知道的三个事实（旧版本、新版本、新清单声明），不引入
// 「上次钩子版本」这类新持久字段：消费方是既有 post_upgrade_pending 机制。
func postUpgradePending(previous string, manifest *registry.Manifest) string {
	if previous == "" || previous == manifest.Version || manifest.PostUpgrade == "" {
		return ""
	}
	return manifest.Version
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
// （desired / actual / updated_at，以及非空时的 post_upgrade_pending），其余字段原样保留。
//
// 保留范围包括装配层写入的 post_upgrade_pending / restarts，以及未来版本追加、
// 本包尚不认识的字段——「整体覆盖」会静默丢数据，而这份记录是跨层共用的。
// 解析放在一处收口：只做 JSON 对象级合并，不解释未知字段的语义。
//
// pending 为空时**不覆盖**既有标记：同版本强制重装不是升级，清掉标记等于让
// 已经推迟的迁移永久丢失（a3dbdbb 修过的 P0）。
func mergeStateRecord(existing []byte, desired, actual, updatedAt, pending string) ([]byte, error) {
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
	if pending != "" {
		raw, err := json.Marshal(pending)
		if err != nil {
			return nil, err
		}
		fields[postUpgradePendingField] = raw
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
