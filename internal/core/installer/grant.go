package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// 授予来源（granted_by）取值。字符串常量直出 API 与审计，前端无需再映射。
const (
	// GrantSourceInstall 首次安装按 info.json 声明自动授予（默认放行，不阻塞安装）。
	GrantSourceInstall = "install:auto"
	// GrantSourceUpgrade 升级版本声明新增能力时自动扩展授予（记录新增项并告警，不阻断）。
	GrantSourceUpgrade = "upgrade:auto"
	// GrantSourceEnablePrefix 显式启用动作确认授予，后缀是管理员 subject。
	GrantSourceEnablePrefix = "enable:"
	// GrantSourceBackfill 存量库迁移：缺少授予记录的插件按已装声明回填。
	GrantSourceBackfill = "legacy:backfill"
)

// Grant 是 plugins bucket 的 granted_capabilities 值（DATA-MODEL §5）。
//
// 显式字段（G-24：不出现 object/any），回答三件事：谁授的（GrantedBy）、
// 什么时候（GrantedAt）、授了哪些（Capabilities）。
//
// 语义是「默认放行 + 显式声明才收紧」：安装/升级都按 info.json 声明自动授予，
// 不做第二套授权开关；差异只体现在记录与告警上，24 个插件仓无需同窗口改动。
type Grant struct {
	// Capabilities 已授予能力集（安装期声明按序去重后保存）。
	Capabilities []string `json:"capabilities"`
	// GrantedBy 授予来源：install:auto / upgrade:auto / enable:<subject> / legacy:backfill。
	GrantedBy string `json:"granted_by"`
	// GrantedAt 授予时间（RFC3339 UTC）。
	GrantedAt string `json:"granted_at"`
	// Version 授予发生时的已装版本。
	Version string `json:"version"`
	// DeclarationSHA256 授予对应声明集的指纹（排序后 join 再 sha256），用于漂移核对。
	DeclarationSHA256 string `json:"declaration_sha256"`
	// AddedCapabilities 最近一次升级自动扩展的新增能力；非空表示「权限扩大、
	// 尚未被管理员显式启用确认」，面板与审计据此提示。启用确认后清空。
	AddedCapabilities []string `json:"added_capabilities,omitempty"`
}

// newGrant 组装一条授予记录；added 为空时不写该字段。
func newGrant(capabilities []string, grantedBy, version string, now time.Time, added []string) Grant {
	return Grant{
		Capabilities:      capabilities,
		GrantedBy:         grantedBy,
		GrantedAt:         now.UTC().Format(time.RFC3339),
		Version:           version,
		DeclarationSHA256: declarationFingerprint(capabilities),
		AddedCapabilities: added,
	}
}

// nextGrant 计算本次落库应写入的授予记录。
//
// 规则（只做字符串集合比较，不解释业务域）：
//   - 首次安装（previous=nil）→ 按声明授予，来源 install:auto；
//   - 声明集未新增能力 → 原记录原样保留（不刷新时间，保留真实授予时点）；
//   - 声明集新增能力（升级）→ 扩展授予，来源 upgrade:auto，记录新增项。
//
// 返回 changed=false 时调用方不应重写记录，避免每次重装都漂移 granted_at。
func nextGrant(previous *Grant, declared []string, version string, now time.Time) (grant Grant, changed bool, added []string) {
	capabilities := uniqueCapabilities(declared)
	if previous == nil {
		return newGrant(capabilities, GrantSourceInstall, version, now, nil), true, nil
	}
	added = minusCapabilities(capabilities, previous.Capabilities)
	if len(added) == 0 {
		return *previous, false, nil
	}
	return newGrant(capabilities, GrantSourceUpgrade, version, now, added), true, added
}

// GrantOf 读取 plugins bucket 中该插件的授予记录；未写入时第二返回值为 false。
//
// 只读事务，不在读路径写库；存量库的回填由 BackfillGrant 在装配层启动时完成。
func GrantOf(p Persister, id string) (Grant, bool, error) {
	if p == nil || id == "" {
		return Grant{}, false, nil
	}
	var grant Grant
	found := false
	err := p.View(func(tx *store.Tx) error {
		raw, err := tx.Get(bucketPlugins, id)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		var record pluginRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		if record.GrantedCapabilities == nil {
			return nil
		}
		grant, found = *record.GrantedCapabilities, true
		return nil
	})
	if err != nil {
		return Grant{}, false, wrap(ErrStore, "读取插件 %s 授予记录失败：%v", id, err)
	}
	return grant, found, nil
}

// GrantIndex 一次事务读出全部授予记录（插件列表路径用，避免 N 次读事务）。
//
// 坏记录跳过并 WARN（与 stateRepo.installed 同口径：一条坏记录不该打挂列表）。
func GrantIndex(p Persister) (map[string]Grant, error) {
	if p == nil {
		return nil, nil
	}
	grants := make(map[string]Grant)
	var bad []string
	err := p.View(func(tx *store.Tx) error {
		return tx.ForEach(bucketPlugins, func(key, value []byte) error {
			var record pluginRecord
			if err := json.Unmarshal(value, &record); err != nil {
				bad = append(bad, string(key)+"（解析失败）")
				return nil
			}
			if record.GrantedCapabilities == nil {
				return nil
			}
			id := record.ID
			if id == "" {
				id = string(key)
			}
			grants[id] = *record.GrantedCapabilities
			return nil
		})
	})
	if err != nil {
		return nil, wrap(ErrStore, "读取授予记录失败：%v", err)
	}
	for _, id := range bad {
		slog.Warn("授予记录不可用，跳过", "plugin_id", id)
	}
	return grants, nil
}

// BackfillGrant 为存量库（本层落地前安装的插件）回填授予记录。
//
// 迁移语义：按 plugins 记录里的已装声明授予，来源 legacy:backfill，保留明确
// 的谁/何时/哪些；已有记录不覆盖（幂等）。返回 created=true 表示本次写入。
func BackfillGrant(p Persister, id string, declared []string, version string) (Grant, bool, error) {
	if p == nil || id == "" {
		return Grant{}, false, nil
	}
	var grant Grant
	created := false
	now := time.Now().UTC()
	err := p.Update(func(tx *store.Tx) error {
		raw, err := tx.Get(bucketPlugins, id)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		var record pluginRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		if record.GrantedCapabilities != nil {
			grant = *record.GrantedCapabilities
			return nil
		}
		grant = newGrant(uniqueCapabilities(declared), GrantSourceBackfill, version, now, nil)
		record.GrantedCapabilities = &grant
		encoded, err := json.Marshal(record)
		if err != nil {
			return err
		}
		if err := tx.Put(bucketPlugins, id, encoded); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		return Grant{}, false, wrap(ErrStore, "回填插件 %s 授予记录失败：%v", id, err)
	}
	return grant, created, nil
}

// ConfirmGrant 由显式启用动作确认授予（SECURITY §5.1「启用授予」）。
//
// 两种情形才写库，其余幂等不写（避免每次启用都漂移授予时点）：
//   - 授予记录缺失（存量库未回填）→ 按已装声明补写，来源 enable:<subject>；
//   - 存在未确认的升级新增能力 → 来源改为 enable:<subject>、刷新时间、清空待确认项。
//
// 返回 changed=true 表示本次确实写入（调用方据此写审计）。
func ConfirmGrant(p Persister, id, subject string) (Grant, bool, error) {
	if p == nil || id == "" {
		return Grant{}, false, nil
	}
	if subject == "" {
		subject = "admin" // 单管理员模式：会话 subject 固定 admin；兜底不写空来源
	}
	grantedBy := GrantSourceEnablePrefix + subject
	var grant Grant
	changed := false
	now := time.Now().UTC()
	err := p.Update(func(tx *store.Tx) error {
		raw, err := tx.Get(bucketPlugins, id)
		if err != nil {
			return err
		}
		var record pluginRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		if record.GrantedCapabilities == nil {
			grant = newGrant(uniqueCapabilities(record.Capabilities), grantedBy, record.Version, now, nil)
			record.GrantedCapabilities = &grant
			changed = true
		} else {
			grant = *record.GrantedCapabilities
			if len(grant.AddedCapabilities) == 0 {
				return nil
			}
			grant.GrantedBy = grantedBy
			grant.GrantedAt = now.Format(time.RFC3339)
			grant.AddedCapabilities = nil
			record.GrantedCapabilities = &grant
			changed = true
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return tx.Put(bucketPlugins, id, encoded)
	})
	if err != nil {
		return Grant{}, false, wrap(ErrStore, "确认插件 %s 授予记录失败：%v", id, err)
	}
	return grant, changed, nil
}

// uniqueCapabilities 按声明顺序去重（空项跳过），不排序以保留插件自己的展示顺序。
func uniqueCapabilities(declared []string) []string {
	out := make([]string, 0, len(declared))
	seen := make(map[string]struct{}, len(declared))
	for _, capability := range declared {
		value := strings.TrimSpace(capability)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

// minusCapabilities 返回在 a 中但不在 b 中的项（顺序同 a）。
func minusCapabilities(a, b []string) []string {
	inB := make(map[string]struct{}, len(b))
	for _, value := range b {
		inB[value] = struct{}{}
	}
	var missing []string
	for _, value := range a {
		if _, ok := inB[value]; !ok {
			missing = append(missing, value)
		}
	}
	return missing
}

// declarationFingerprint 对排序后的能力集取 sha256，跨版本漂移一眼可查。
func declarationFingerprint(capabilities []string) string {
	sorted := append([]string(nil), capabilities...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return hex.EncodeToString(sum[:])
}

// describeGrant 给日志/审计用的简短描述（能力数 + 来源 + 版本）。
func describeGrant(grant Grant) string {
	return fmt.Sprintf("granted_by=%s version=%s capabilities=%d added=%s",
		grant.GrantedBy, grant.Version, len(grant.Capabilities), strings.Join(grant.AddedCapabilities, ","))
}
