package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/store"
)

// 持久层键名与状态取值（DATA-MODEL §5）。
const (
	bucketPlugins     = "plugins"
	bucketPluginState = "plugin_state"
	desiredEnabled    = "enabled"
	desiredDisabled   = "disabled"
	actualStopped     = "stopped"
)

// persistedState 是 plugin_state bucket 的值；只声明 M1 用到的字段。
type persistedState struct {
	// Desired 期望状态：enabled / disabled。
	Desired string `json:"desired"`
	// Actual 实际状态：ready / starting / failed / stopped。
	Actual string `json:"actual"`
	// Restarts 重启计数。
	Restarts int `json:"restarts"`
	// PostUpgradePending 是「禁用态升级」留下的待补跑标记：值为升级到的版本。
	// 非空表示该版本声明的 post_upgrade 尚未执行，下一次 Enable 成功后补跑并清空
	// （见 daemon.consumePostUpgrade）。首次安装与从未升级的插件恒为空，不会误跑。
	PostUpgradePending string `json:"post_upgrade_pending,omitempty"`
	// UpdatedAt 最近一次写入时间（RFC3339）。
	UpdatedAt string `json:"updated_at"`
}

// defaultState 是状态记录缺失时的兜底值。
func defaultState() persistedState {
	return persistedState{Desired: desiredDisabled, Actual: actualStopped}
}

// pluginRef 是 plugins bucket 里装配层需要的两个字段。
type pluginRef struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Version 当前安装版本。
	Version string `json:"version"`
}

// stateRepo 是 plugin_state 与 plugins bucket 的窄封装（装配层唯一触碰 bbolt 的地方）。
type stateRepo struct {
	db *store.Store
}

// newStateRepo 构造状态仓储。
func newStateRepo(db *store.Store) *stateRepo { return &stateRepo{db: db} }

// load 读取插件持久状态；键不存在时第二返回值为 false。
func (r *stateRepo) load(id string) (persistedState, bool, error) {
	state := defaultState()
	found := false
	err := r.db.View(func(tx *store.Tx) error {
		raw, err := tx.Get(bucketPluginState, id)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		return json.Unmarshal(raw, &state)
	})
	return state, found, err
}

// save 写入插件持久状态并刷新 updated_at。
func (r *stateRepo) save(id string, state persistedState) error {
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return r.db.Update(func(tx *store.Tx) error {
		return tx.Put(bucketPluginState, id, raw)
	})
}

// grant 读取单个插件的授予记录；未写入时第二返回值为 false。
func (r *stateRepo) grant(id string) (installer.Grant, bool, error) {
	return installer.GrantOf(r.db, id)
}

// grants 一次事务读出全部授予记录，供插件列表路径复用（避免 N 次读事务）。
func (r *stateRepo) grants() (map[string]installer.Grant, error) {
	return installer.GrantIndex(r.db)
}

// confirmGrant 处理启用即确认：补齐缺失的授予记录 / 清空升级新增的待确认项，
// 并对实际写入的动作记审计（capability.grant_confirmed，fail-open：审计失败只 WARN）。
func (r *stateRepo) confirmGrant(id, subject string) (installer.Grant, bool, error) {
	grant, changed, err := installer.ConfirmGrant(r.db, id, subject)
	if err != nil {
		return installer.Grant{}, false, err
	}
	if !changed {
		return grant, false, nil
	}
	record := store.AuditRecord{
		Subject: subject, Action: "capability.grant_confirmed", Plugin: id,
		Target: "capabilities", Result: store.AuditResultOK,
		Detail: map[string]string{
			"granted_by":   grant.GrantedBy,
			"version":      grant.Version,
			"capabilities": strings.Join(grant.Capabilities, ","),
		},
	}
	if err := r.db.PutAudit(record); err != nil {
		slog.Warn("授予确认审计写入失败", "plugin_id", id, "err", err)
	}
	return grant, true, nil
}

// installed 读出 plugins bucket 中的全部已装记录（id + version）。
//
// 事务内只做内存解析，坏记录收集到事务外再告警（DATA-MODEL §6：事务内禁止 IO）。
func (r *stateRepo) installed() ([]pluginRef, error) {
	var refs []pluginRef
	var bad []string
	err := r.db.View(func(tx *store.Tx) error {
		return tx.ForEach(bucketPlugins, func(key, value []byte) error {
			var ref pluginRef
			if err := json.Unmarshal(value, &ref); err != nil {
				bad = append(bad, string(key)+"（解析失败）")
				return nil
			}
			if ref.ID == "" {
				ref.ID = string(key)
			}
			if ref.Version == "" {
				bad = append(bad, ref.ID+"（缺 version）")
				return nil
			}
			refs = append(refs, ref)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	for _, id := range bad {
		slog.Warn("plugins 记录不可用，跳过", "plugin_id", id)
	}
	return refs, nil
}

// loadCatalog 按 plugins bucket 的记录从落盘目录加载清单并登记到 registry。
//
// store 是"已安装"的真源；目录里存在但未登记的残留只 WARN 跳过，不擅自接管。
func loadCatalog(catalog *registry.Catalog, repo *stateRepo, root string) error {
	refs, err := repo.installed()
	if err != nil {
		return err
	}
	for _, ref := range refs {
		dir := registry.PluginDir(root, ref.ID, ref.Version)
		manifest, loadErr := registry.Load(dir)
		if loadErr != nil {
			if errors.Is(loadErr, fs.ErrPermission) {
				// 可操作提示：不做静默"未安装"——告诉运维具体路径与修法（非 root 启动
				// 读不到 root 安装的插件目录；修复后无需重装）。
				slog.Error("插件清单无读权限，按未安装跳过（请修正属主或权限后重启）",
					"plugin_id", ref.ID, "version", ref.Version, "dir", dir,
					"hint", "该插件由其他用户安装：chown -R <kored 运行用户> "+dir+" 或 chmod -R a+rX "+dir, "err", loadErr)
			} else {
				slog.Warn("已装插件清单不可用，跳过", "plugin_id", ref.ID, "version", ref.Version, "err", loadErr)
			}
			continue
		}
		if addErr := catalog.Add(manifest); addErr != nil {
			slog.Warn("插件登记失败，跳过", "plugin_id", ref.ID, "err", addErr)
			continue
		}
		// 存量库迁移：本层落地前安装的插件没有授予记录，按已装声明回填一次，
		// 让「声明 = 授予」不再是无记录的隐式等价（幂等，已有记录不覆盖）。
		if _, created, backfillErr := installer.BackfillGrant(repo.db, manifest.ID, manifest.Capabilities, manifest.Version); backfillErr != nil {
			slog.Warn("回填授予记录失败（插件仍可用，记录待下次安装/启用补齐）",
				"plugin_id", manifest.ID, "err", backfillErr)
		} else if created {
			slog.Info("已为存量插件回填授予记录", "plugin_id", manifest.ID,
				"version", manifest.Version, "granted_by", installer.GrantSourceBackfill)
		}
	}
	warnUnregistered(root, refs)
	return nil
}

// warnUnregistered 提示插件根目录下存在但未登记的目录（不回灌、不删除）。
func warnUnregistered(root string, refs []pluginRef) {
	entries, err := os.ReadDir(root)
	if err != nil {
		slog.Warn("扫描插件根目录失败", "dir", root, "err", err)
		return
	}
	registered := make(map[string]struct{}, len(refs))
	for _, ref := range refs {
		registered[ref.ID] = struct{}{}
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if _, ok := registered[entry.Name()]; ok {
			continue
		}
		slog.Warn("插件目录存在但状态库未登记，跳过", "plugin_id", entry.Name(),
			"dir", filepath.Join(root, entry.Name()))
	}
}
