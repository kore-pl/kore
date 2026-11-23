package installer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// pluginIDPattern 是插件 id 白名单（与 G-27 / info.json 同一条正则）。
//
// 安全意义：id 会拼进文件系统路径，必须保证它不含路径分隔符与 `..`。
// 该正则只允许小写字母 / 数字 / 连字符且必须以字母开头，天然排除 `/` `\` `.`，
// 因此 `../../etc`、`foo/bar`、`..%2f..`（解码后）一律不匹配。
var pluginIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// auditActionUninstall 是插件卸载的审计动作名（DATA-MODEL §9 新增动作）。
const auditActionUninstall = "plugin.uninstall"

// UninstallResult 是一次卸载的结果。
type UninstallResult struct {
	// ID 是被卸载的插件 id。
	ID string
	// AlreadyAbsent 为 true 表示调用前该插件就不存在（幂等命中，未做任何变更）。
	AlreadyAbsent bool
	// Stopped 表示卸载前该插件进程处于运行态、已被优雅停止。
	Stopped bool
	// Dir 是被删除的插件目录（<pluginRoot>/<id>）；AlreadyAbsent 时为空。
	Dir string
}

// StopFunc 说明：Uninstall 遇到运行中的插件时必须先停进程（idempotent），
// supervisor.Manager.Stop 直接满足；装配层注入，installer 不 import supervisor。
type StopFunc func(ctx context.Context, id string) error

// AuditFunc 写一条卸载审计；实现方写 store（fail-closed）。
//
// 未注入时 Uninstall 视为"审计通道未装配"并继续（CLI 本地包安装路径）；
// 装配层（kored）必须注入，从而对 HTTP 卸载做到 fail-closed。
type AuditFunc func(ctx context.Context, rec store.AuditRecord) error

// ValidatePluginID 校验插件 id：不匹配即返回 ErrInvalid。
//
// 除正则外再显式拒绝分隔符与 `.`/`..`（正则已覆盖，这里做纵深防御，
// 让"有人放宽正则"时穿越仍被挡住）。
func ValidatePluginID(id string) error {
	if id == "" {
		return wrap(ErrInvalid, "插件 id 为空")
	}
	if strings.ContainsAny(id, `/\`) || id == "." || id == ".." || strings.Contains(id, "..") {
		return wrap(ErrInvalid, "插件 id %q 含路径分隔符或 ..，拒绝执行", id)
	}
	if !pluginIDPattern.MatchString(id) {
		return wrap(ErrInvalid, "插件 id %q 不匹配 %s", id, pluginIDPattern.String())
	}
	return nil
}

// Uninstall 卸载插件：先停进程 → 原子摘除目录 → 删注册表记录 → 写审计。
//
// 顺序与回滚口径（"不留半删状态"）：
//  1. 校验 id（不匹配即拒绝，防路径穿越）；
//  2. 判定存在性：store 无记录且目录不存在 → AlreadyAbsent，零变更返回；
//  3. 停进程：失败即原样返回，目录与记录都不动（插件仍可继续运行）；
//  4. 目录原子改名到隔离区（同文件系统 rename，失败即中止，未删任何东西）；
//  5. 一个写事务里删除 plugins / plugin_state 两条记录（先快照原始字节）；
//  6. 写审计；审计失败把记录与目录**全部还原**后返回 ErrAudit（fail-closed）；
//  7. 审计成功后删除隔离目录（不可回滚步骤放在最后）。
func (in *Installer) Uninstall(ctx context.Context, id string) (*UninstallResult, error) {
	if err := ValidatePluginID(id); err != nil {
		return nil, err
	}
	if in.store == nil {
		return nil, wrap(ErrStore, "状态库句柄为空")
	}
	dir := filepath.Join(in.pluginRoot, id)
	exists, err := in.exists(id, dir)
	if err != nil {
		return nil, err
	}
	if !exists {
		return &UninstallResult{ID: id, AlreadyAbsent: true}, nil
	}
	stopped, err := in.stop(ctx, id)
	if err != nil {
		return nil, wrap(ErrStop, "停止插件进程失败，已保持原状：%v", err)
	}
	quarantine, err := quarantineDir(dir)
	if err != nil {
		return nil, err
	}
	snapshot, err := in.snapshotRecords(id)
	if err != nil {
		// 目录未必被改名：quarantineDir 成功才会带出路径，这里只在搬动后失败。
		_ = restoreDir(quarantine, dir)
		return nil, err
	}
	if err := in.dropRecords(id); err != nil {
		_ = restoreDir(quarantine, dir)
		return nil, err
	}
	if auditErr := in.audit(ctx, id, dir); auditErr != nil {
		// fail-closed：审计写不进去就回到调用前状态（记录 + 目录）。
		restoreRecordsErr := in.restoreRecords(id, snapshot)
		dirErr := restoreDir(quarantine, dir)
		if restoreRecordsErr != nil || dirErr != nil {
			in.logger.Error("审计失败后还原卸载状态失败", "plugin_id", id,
				"records_err", restoreRecordsErr, "dir_err", dirErr)
			return nil, wrap(ErrAudit, "审计写入失败且还原未完整完成：%v（还原错误：%v / %v）",
				auditErr, restoreRecordsErr, dirErr)
		}
		return nil, wrap(ErrAudit, "审计写入失败，已还原卸载前状态：%v", auditErr)
	}
	if err := os.RemoveAll(quarantine); err != nil {
		// 审计已成功、记录已删：目录残留隔离区不影响一致性，记 WARN 由运维清理。
		in.logger.Warn("清理卸载隔离目录失败", "dir", quarantine, "err", err)
	}
	return &UninstallResult{ID: id, Stopped: stopped, Dir: dir}, nil
}

// exists 判定插件是否"已安装"：store 有记录或目录存在任一成立即视为存在。
func (in *Installer) exists(id, dir string) (bool, error) {
	_, statErr := os.Stat(dir)
	dirExists := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return false, wrap(ErrStateDir, "检查插件目录失败：%v", statErr)
	}
	var recorded bool
	err := in.store.View(func(tx *store.Tx) error {
		_, getErr := tx.Get(bucketPlugins, id)
		if getErr == nil {
			recorded = true
			return nil
		}
		if errors.Is(getErr, store.ErrNotFound) {
			return nil
		}
		return getErr
	})
	if err != nil {
		return false, wrap(ErrStore, "读取插件记录失败：%v", err)
	}
	return dirExists || recorded, nil
}

// stop 调用注入的停止器；未注入视为"无需停进程"。返回是否真的发生了停止。
func (in *Installer) stop(ctx context.Context, id string) (bool, error) {
	if in.stopPlugin == nil {
		return false, nil
	}
	if err := in.stopPlugin(ctx, id); err != nil {
		return false, err
	}
	return true, nil
}

// quarantineDir 把插件目录原子改名到同级的隔离路径并返回该路径。
//
// 目录不存在视为成功（只有记录没有目录的半装态也能卸载）。
func quarantineDir(dir string) (string, error) {
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", wrap(ErrStateDir, "检查插件目录失败：%v", err)
	}
	target := dir + ".uninstalling-" + time.Now().UTC().Format("20060102150405.000000000")
	if err := os.Rename(dir, target); err != nil {
		return "", wrap(ErrStateDir, "摘除插件目录失败（已保持原状）：%v", err)
	}
	return target, nil
}

// restoreDir 把隔离目录改回原名；quarantine 为空表示本来就没有目录。
func restoreDir(quarantine, dir string) error {
	if quarantine == "" {
		return nil
	}
	if err := os.Rename(quarantine, dir); err != nil {
		return err
	}
	return nil
}

// recordSnapshot 是卸载前的记录快照，用于审计失败时还原。
type recordSnapshot struct {
	plugin []byte
	state  []byte
}

// snapshotRecords 读出 plugins / plugin_state 原始值（不存在记为 nil）。
func (in *Installer) snapshotRecords(id string) (recordSnapshot, error) {
	var snap recordSnapshot
	err := in.store.View(func(tx *store.Tx) error {
		pluginRaw, pluginErr := tx.Get(bucketPlugins, id)
		if pluginErr != nil && !errors.Is(pluginErr, store.ErrNotFound) {
			return pluginErr
		}
		stateRaw, stateErr := tx.Get(bucketPluginState, id)
		if stateErr != nil && !errors.Is(stateErr, store.ErrNotFound) {
			return stateErr
		}
		snap.plugin, snap.state = pluginRaw, stateRaw
		return nil
	})
	if err != nil {
		return recordSnapshot{}, wrap(ErrStore, "读取卸载前记录失败：%v", err)
	}
	return snap, nil
}

// dropRecords 在一个写事务里删除两条记录；记录本就不存在不算错误。
func (in *Installer) dropRecords(id string) error {
	err := in.store.Update(func(tx *store.Tx) error {
		if err := tx.Delete(bucketPlugins, id); err != nil {
			return err
		}
		return tx.Delete(bucketPluginState, id)
	})
	if err != nil {
		return wrap(ErrStore, "删除插件记录失败：%v", err)
	}
	return nil
}

// restoreRecords 按快照还原两条记录（只还原原本存在的）。
func (in *Installer) restoreRecords(id string, snap recordSnapshot) error {
	if snap.plugin == nil && snap.state == nil {
		return nil
	}
	err := in.store.Update(func(tx *store.Tx) error {
		if snap.plugin != nil {
			if err := tx.Put(bucketPlugins, id, snap.plugin); err != nil {
				return err
			}
		}
		if snap.state != nil {
			if err := tx.Put(bucketPluginState, id, snap.state); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return wrap(ErrStore, "还原插件记录失败：%v", err)
	}
	return nil
}

// audit 写卸载审计；未注入审计通道视为跳过（装配层必须注入，见 AuditFunc）。
func (in *Installer) audit(ctx context.Context, id, dir string) error {
	if in.auditFn == nil {
		return nil
	}
	return in.auditFn(ctx, store.AuditRecord{
		Subject: "admin",
		Action:  auditActionUninstall,
		Plugin:  id,
		Result:  store.AuditResultOK,
		Detail:  map[string]string{"dist_dir": dir},
	})
}
