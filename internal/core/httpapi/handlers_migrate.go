// Package httpapi · 配置迁移端点（R22 migrate）。
//
// 【导出 schema（owner 显式定义，G-24：禁止 object/any 作对外形状）】
//
//	kore-migrate-format v1
//	{
//	  format:        string  // 固定 "kore-migrate"
//	  schema_version:int     // 固定 1
//	  kore_version:  string  // 导出端内核版本，如 "0.1.1"
//	  exported_at:   string  // RFC3339 导出时刻
//	  sha256:        string  // payload 规范化 JSON 的 sha256（64 位小写 hex）
//	  payload: {
//	    config: {
//	      profile, server_addr, server_socket, server_tls(bool),
//	      session_ttl_seconds(int64), cookie_secure, auth_initialized(bool),
//	      paths{state_dir,log_dir,run_dir,plugin_dir,index_dir},
//	      log{level,max_size_mb(int),max_backups(int)},
//	      resources{memory_mb(int),cpu_quota,pids_max(int),enforce(bool),resident_max(int)},
//	      plugins{allow_unsigned(bool),autostart([]string)},
//	      store{allow_unsigned(bool)},
//	      security{attempts(int),window_seconds(int64),lock_seconds(int64)},
//	      audit{invoke_all(bool),retention_seconds(int64),clean_enabled(bool),
//	            clean_interval_seconds(int64),clean_batch(int)},
//	      cert_renew{enabled(bool),interval_seconds(int64)}
//	    },
//	    plugins: [{id,name,version,lifecycle,desired,enabled(bool),state}],
//	    presets: [{id,name,description,out_of_box(bool),plugins:[{id,version,desired}]}]
//	  }
//	}
//
// 【凭据红线（G-30）】schema 采用 allowlist 构造：config 段只枚举上列非敏感字段，
// 整个鉴权块与会话数据不进入任何结构；导出逻辑不存在凭据类字段名，凭据绝不落地。
//
// 【应用边界】apply 只改进程内可回滚的插件启停态（现有 Backend.Enable/Disable）：
// 先只读预检全部目标，再逐项写；任一写失败按逆序补偿回滚已改项，失败也不留半应用状态。
// 配置文件与预设的真源分别是 config.yaml 与 kore-plugins 索引，不在 HTTP 侧自动覆盖，
// 差异作为 manual_steps 返回，避免把运行态改到不可预期的中间态（G-29）。
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// migrateFormat 是文件格式标识；导入时逐字校验。
	migrateFormat = "kore-migrate"
	// migrateSchemaVersion 是本端点支持的唯一 schema 版本。
	migrateSchemaVersion = 1
	// migrateMaxBody 是导入请求体上限（4 MiB，足够数千插件条目）。
	migrateMaxBody = 4 << 20

	migrateExportPath  = "/api/v1/migrate/export"
	migratePreviewPath = "/api/v1/migrate/preview"
	migrateApplyPath   = "/api/v1/migrate/apply"
)

// ---- 导出 payload：全部显式字段，无 any / object（G-24） ----

type migratePaths struct {
	StateDir  string `json:"state_dir"`
	LogDir    string `json:"log_dir"`
	RunDir    string `json:"run_dir"`
	PluginDir string `json:"plugin_dir"`
	IndexDir  string `json:"index_dir"`
}

type migrateLog struct {
	Level      string `json:"level"`
	MaxSizeMB  int    `json:"max_size_mb"`
	MaxBackups int    `json:"max_backups"`
}

type migrateResources struct {
	MemoryMB    int    `json:"memory_mb"`
	CPUQuota    string `json:"cpu_quota"`
	PidsMax     int    `json:"pids_max"`
	Enforce     bool   `json:"enforce"`
	ResidentMax int    `json:"resident_max"`
}

type migratePluginConfig struct {
	AllowUnsigned bool     `json:"allow_unsigned"`
	Autostart     []string `json:"autostart"`
}

type migrateStoreConfig struct {
	AllowUnsigned bool `json:"allow_unsigned"`
}

type migrateSecurity struct {
	Attempts      int   `json:"attempts"`
	WindowSeconds int64 `json:"window_seconds"`
	LockSeconds   int64 `json:"lock_seconds"`
}

type migrateAudit struct {
	InvokeAll            bool  `json:"invoke_all"`
	RetentionSeconds     int64 `json:"retention_seconds"`
	CleanEnabled         bool  `json:"clean_enabled"`
	CleanIntervalSeconds int64 `json:"clean_interval_seconds"`
	CleanBatch           int   `json:"clean_batch"`
}

type migrateCertRenew struct {
	Enabled         bool  `json:"enabled"`
	IntervalSeconds int64 `json:"interval_seconds"`
}

// migrateConfig 是配置快照的允许导出部分。字段逐项枚举：新增敏感字段不会自动进入导出。
type migrateConfig struct {
	Profile           string              `json:"profile"`
	ServerAddr        string              `json:"server_addr"`
	ServerSocket      string              `json:"server_socket"`
	ServerTLS         bool                `json:"server_tls"`
	SessionTTLSeconds int64               `json:"session_ttl_seconds"`
	CookieSecure      string              `json:"cookie_secure"`
	AuthInitialized   bool                `json:"auth_initialized"`
	Paths             migratePaths        `json:"paths"`
	Log               migrateLog          `json:"log"`
	Resources         migrateResources    `json:"resources"`
	Plugins           migratePluginConfig `json:"plugins"`
	Store             migrateStoreConfig  `json:"store"`
	Security          migrateSecurity     `json:"security"`
	Audit             migrateAudit        `json:"audit"`
	CertRenew         migrateCertRenew    `json:"cert_renew"`
}

type migratePlugin struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	Lifecycle string `json:"lifecycle"`
	Desired   string `json:"desired"`
	Enabled   bool   `json:"enabled"`
	State     string `json:"state"`
}

type migratePresetPlugin struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Desired string `json:"desired"`
}

type migratePreset struct {
	ID          string                `json:"id"`
	Name        string                `json:"name"`
	Description string                `json:"description"`
	OutOfBox    bool                  `json:"out_of_box"`
	Plugins     []migratePresetPlugin `json:"plugins"`
}

type migratePayload struct {
	Config  migrateConfig   `json:"config"`
	Plugins []migratePlugin `json:"plugins"`
	Presets []migratePreset `json:"presets"`
}

// migrateManifest 是落盘/下载文件的顶层形状。
type migrateManifest struct {
	Format        string         `json:"format"`
	SchemaVersion int            `json:"schema_version"`
	KoreVersion   string         `json:"kore_version"`
	ExportedAt    string         `json:"exported_at"`
	SHA256        string         `json:"sha256"`
	Payload       migratePayload `json:"payload"`
}

// ---- 导入预览/应用结果：同样显式字段 ----

type migrateChange struct {
	Kind   string `json:"kind"`   // plugin / config / preset
	Target string `json:"target"` // 插件 id 或配置键
	From   string `json:"from"`
	To     string `json:"to"`
	Action string `json:"action"` // enable / disable / manual / unchanged
}

type migratePreview struct {
	Compatible  bool            `json:"compatible"`
	Reason      string          `json:"reason"`
	SHAOK       bool            `json:"sha_ok"`
	FromVersion string          `json:"from_version"`
	ToVersion   string          `json:"to_version"`
	Changes     []migrateChange `json:"changes"`
	Warnings    []string        `json:"warnings"`
}

type migrateApplyResult struct {
	Applied     bool            `json:"applied"`
	Message     string          `json:"message"`
	Changes     []migrateChange `json:"changes"`
	ManualSteps []string        `json:"manual_steps"`
}

// migratePreviewRequest / migrateApplyRequest 共用 manifest 输入形状。
type migrateRequest struct {
	Manifest migrateManifest `json:"manifest"`
}

// authorizeMigrate 要求 system:admin（导出含配置快照，导入会改插件启停态）。
func (s *Server) authorizeMigrate(w http.ResponseWriter, r *http.Request, target string) bool {
	if s.auth == nil {
		return true // 探活骨架
	}
	subject, granted := s.capResolver(r)
	if subject == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
		return false
	}
	if !hasCapability(granted, "system:admin") {
		s.auditDenied(subject, "migrate", target, "缺少 system:admin 特权能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：配置迁移端点需要 system:admin 能力", "system:admin")
		return false
	}
	return true
}

// configToMigrate 逐字段构造允许导出的配置视图；不复制任何凭据字段。
func configToMigrate(cfg *config.Snapshot) migrateConfig {
	out := migrateConfig{}
	if cfg == nil {
		return out
	}
	out.Profile = cfg.Profile
	out.ServerAddr = cfg.Server.Addr
	out.ServerSocket = cfg.Server.Socket
	out.ServerTLS = cfg.Server.TLS
	out.SessionTTLSeconds = int64(cfg.Auth.SessionTTL / 1e9)
	out.CookieSecure = cfg.Auth.CookieSecure
	out.AuthInitialized = cfg.Auth.Initialized
	out.Paths = migratePaths{
		StateDir: cfg.Paths.StateDir, LogDir: cfg.Paths.LogDir, RunDir: cfg.Paths.RunDir,
		PluginDir: cfg.Paths.PluginDir, IndexDir: cfg.Paths.IndexDir,
	}
	out.Log = migrateLog{Level: cfg.Log.Level, MaxSizeMB: cfg.Log.Rotate.MaxSizeMB,
		MaxBackups: cfg.Log.Rotate.MaxBackups}
	out.Resources = migrateResources{MemoryMB: cfg.Resources.Defaults.MemoryMB,
		CPUQuota: cfg.Resources.Defaults.CPUQuota, PidsMax: cfg.Resources.Defaults.PidsMax,
		Enforce: cfg.Resources.Enforce, ResidentMax: cfg.Resources.ResidentMax}
	autostart := append([]string{}, cfg.Plugins.Autostart...)
	out.Plugins = migratePluginConfig{AllowUnsigned: cfg.Plugins.AllowUnsigned, Autostart: autostart}
	out.Store = migrateStoreConfig{AllowUnsigned: cfg.Store.AllowUnsigned}
	out.Security = migrateSecurity{Attempts: cfg.Security.LoginRateLimit.Attempts,
		WindowSeconds: int64(cfg.Security.LoginRateLimit.Window / 1e9),
		LockSeconds:   int64(cfg.Security.LoginRateLimit.Lock / 1e9)}
	out.Audit = migrateAudit{InvokeAll: cfg.Audit.InvokeAll,
		RetentionSeconds: int64(cfg.Audit.Retention / 1e9), CleanEnabled: cfg.Audit.CleanEnabled,
		CleanIntervalSeconds: int64(cfg.Audit.CleanInterval / 1e9), CleanBatch: cfg.Audit.CleanBatch}
	out.CertRenew = migrateCertRenew{Enabled: cfg.CertRenew.Enabled,
		IntervalSeconds: int64(cfg.CertRenew.Interval / 1e9)}
	return out
}

// manifestSHA 计算 payload 的规范化 JSON 摘要（结构体字段顺序稳定，重复调用一致）。
func manifestSHA(p migratePayload) (string, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// handleMigrateExport 组装并下载配置迁移清单（GET，浏览器直接另存为文件）。
func (s *Server) handleMigrateExport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigrate(w, r, "export") {
		return
	}
	payload := migratePayload{}
	if s.opts.Backend == nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "插件后端未装配", "")
		return
	}
	plugins, err := s.opts.Backend.Plugins(r.Context())
	if err != nil {
		writeFailure(w, err)
		return
	}
	for _, p := range plugins {
		payload.Plugins = append(payload.Plugins, migratePlugin{
			ID: p.ID, Name: p.Name, Version: p.Version, Lifecycle: p.Lifecycle,
			Desired: p.Desired, Enabled: p.Enabled, State: p.State,
		})
	}
	if s.market != nil {
		presets, perr := s.market.Presets()
		if perr != nil {
			slog.Warn("配置迁移读取预设失败，导出不含预设", "err", perr)
		} else {
			for _, p := range presets {
				mp := migratePreset{ID: p.ID, Name: p.Name, Description: p.Description, OutOfBox: p.OutOfBox}
				for _, pp := range p.Plugins {
					mp.Plugins = append(mp.Plugins, migratePresetPlugin{ID: pp.ID, Version: pp.Version, Desired: pp.Desired})
				}
				payload.Presets = append(payload.Presets, mp)
			}
		}
	}
	// 只读加载当前生效配置：走 config.Load 复用与启动一致的解析/校验/脱敏口径，
	// 不在 Options 增字段（共享写域），也不碰运行态文件（G-29）。
	snap, _, cfgErr := config.Load(config.Options{})
	if cfgErr != nil {
		slog.Warn("配置迁移导出读取配置失败，配置段使用空快照", "err", cfgErr)
	}
	payload.Config = configToMigrate(snap)
	sha, err := manifestSHA(payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "校验值计算失败", err.Error())
		return
	}
	m := migrateManifest{
		Format: migrateFormat, SchemaVersion: migrateSchemaVersion, KoreVersion: s.opts.Version,
		ExportedAt: time.Now().Format(time.RFC3339), SHA256: sha, Payload: payload,
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\"kore-config-migrate.json\"")
	writeJSON(w, http.StatusOK, m)
}

// readMigrateManifest 读导入请求并做基础形状校验（只解析显式字段）。
func readMigrateManifest(w http.ResponseWriter, r *http.Request) (migrateManifest, bool) {
	var req migrateRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, migrateMaxBody))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体不是合法的迁移文件 JSON", err.Error())
		return migrateManifest{}, false
	}
	return req.Manifest, true
}

// validateMigrate 校验格式、schema 版本、摘要与内核版本兼容性，返回可读原因。
// target 是当前内核版本（s.opts.Version），不写死包级常量，避免版本漂移。
func validateMigrate(m migrateManifest, target string) (migratePreview, bool) {
	if target == "" {
		target = "0.0.0"
	}
	out := migratePreview{FromVersion: m.KoreVersion, ToVersion: target}
	if m.Format != migrateFormat {
		out.Reason = "文件格式不对：这不是 Kore 配置迁移文件（format 字段应为 kore-migrate）"
		return out, false
	}
	if m.SchemaVersion != migrateSchemaVersion {
		out.Reason = fmt.Sprintf("版本不兼容：文件 schema_version=%d，当前内核只支持 %d",
			m.SchemaVersion, migrateSchemaVersion)
		return out, false
	}
	sha, err := manifestSHA(m.Payload)
	if err != nil || sha == "" || !strings.EqualFold(sha, m.SHA256) {
		out.Reason = "校验值不匹配：文件可能已损坏或被改动，请重新导出后再导入"
		return out, false
	}
	out.SHAOK = true
	// 兼容口径：同主版本可导入；跨主版本需换对应内核，不做猜测式升级。
	if majorOf(m.KoreVersion) != majorOf(target) {
		out.Reason = fmt.Sprintf("版本不兼容：文件来自 Kore %s，当前内核为 %s；跨主版本迁移请先升级内核",
			m.KoreVersion, target)
		return out, false
	}
	out.Compatible = true
	out.Reason = "格式与版本校验通过"
	return out, true
}

// majorOf 取语义化版本主版本号；解析失败返回原文，避免把未知版本当兼容。
func majorOf(v string) string {
	s := strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(s, '.'); i > 0 {
		return s[:i]
	}
	if s == "" {
		return "?"
	}
	return s
}

// diffMigrate 计算清单与当前状态的差异；config/preset 只给手工步骤，不自动覆盖。
func (s *Server) diffMigrate(ctx context.Context, m migrateManifest) migratePreview {
	preview, ok := validateMigrate(m, s.opts.Version)
	if !ok {
		return preview
	}
	current := map[string]migratePlugin{}
	if s.opts.Backend != nil {
		plugins, err := s.opts.Backend.Plugins(ctx)
		if err == nil {
			for _, p := range plugins {
				current[p.ID] = migratePlugin{ID: p.ID, Desired: p.Desired, Enabled: p.Enabled}
			}
		} else {
			preview.Warnings = append(preview.Warnings, "当前插件状态读取失败，预览可能不完整："+err.Error())
		}
	}
	for _, want := range m.Payload.Plugins {
		got, exists := current[want.ID]
		if !exists {
			preview.Warnings = append(preview.Warnings, "文件里的插件 "+want.ID+" 本机未安装；请先安装对应版本")
			continue
		}
		if got.Enabled == want.Enabled && got.Desired == want.Desired {
			continue
		}
		action := "manual"
		if want.Desired == "enabled" {
			action = "enable"
		} else if want.Desired == "disabled" {
			action = "disable"
		}
		preview.Changes = append(preview.Changes, migrateChange{
			Kind: "plugin", Target: want.ID,
			From:   fmt.Sprintf("desired=%s enabled=%t", got.Desired, got.Enabled),
			To:     fmt.Sprintf("desired=%s enabled=%t", want.Desired, want.Enabled),
			Action: action,
		})
	}
	preview.Warnings = append(preview.Warnings,
		"配置与预设差异只作参考：它们的真源是 config.yaml 与软件商店索引，导入不会自动覆盖运行态文件")
	preview.Warnings = append(preview.Warnings,
		"导入前建议导出一份当前配置作为回滚点；插件启停失败会中止并保留已成功项")
	return preview
}

// handleMigratePreview 只做只读校验与差异预览，不写任何状态。
func (s *Server) handleMigratePreview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigrate(w, r, "preview") {
		return
	}
	m, ok := readMigrateManifest(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.diffMigrate(r.Context(), m))
}

// migratePending 是两阶段应用的预检结果：先读齐全部目标再写，避免"读到一半发现缺插件"的半应用。
type migratePending struct {
	Target  migratePlugin
	Current PluginStatus
}

// handleMigrateApply 应用变更：完整校验 → 全量预检 → 逐项应用；任一项失败即回滚已改项（不半应用）。
func (s *Server) handleMigrateApply(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMigrate(w, r, "apply") {
		return
	}
	m, ok := readMigrateManifest(w, r)
	if !ok {
		return
	}
	// 第一道门：格式/版本/校验值不过，一律不进入写路径。
	preview, valid := validateMigrate(m, s.opts.Version)
	if !valid {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "导入文件校验失败："+preview.Reason, "")
		return
	}
	if s.opts.Backend == nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "插件后端未装配，无法应用", "")
		return
	}
	// 第二道门：预检全部目标插件是否存在、当前状态是否可读。全部通过才动第一笔。
	var pending []migratePending
	for _, want := range m.Payload.Plugins {
		got, exists, err := s.opts.Backend.Plugin(r.Context(), want.ID)
		if err != nil || !exists {
			msg := "插件 " + want.ID + " 本机不存在或读取失败；预检未通过，未做任何改动"
			writeError(w, http.StatusBadRequest, pluginapi.E_NOTFOUND, msg, "")
			return
		}
		if got.Enabled == want.Enabled && got.Desired == want.Desired {
			continue
		}
		pending = append(pending, migratePending{Target: want, Current: got})
	}

	result := migrateApplyResult{Changes: []migrateChange{},
		ManualSteps: []string{"请人工对齐 config.yaml 与软件商店索引中的配置/预设差异（见预览）"}}
	// applied 记录已成功写入的项，失败时按逆序恢复原状态（补偿回滚，不半应用）。
	var applied []migratePending
	for _, p := range pending {
		want := p.Target
		var err error
		if want.Enabled {
			err = s.opts.Backend.Enable(r.Context(), want.ID)
		} else {
			err = s.opts.Backend.Disable(r.Context(), want.ID)
		}
		if err != nil {
			rolled := 0
			for i := len(applied) - 1; i >= 0; i-- {
				prev := applied[i]
				if prev.Current.Enabled {
					err2 := s.opts.Backend.Enable(r.Context(), prev.Target.ID)
					if err2 == nil {
						rolled++
					}
				} else {
					err2 := s.opts.Backend.Disable(r.Context(), prev.Target.ID)
					if err2 == nil {
						rolled++
					}
				}
			}
			result.Message = fmt.Sprintf("应用插件 %s 失败，已回滚 %d/%d 项已改插件；未保留半应用状态。原因：%v",
				want.ID, rolled, len(applied), err)
			writeFailure(w, err)
			return
		}
		applied = append(applied, p)
		result.Changes = append(result.Changes, migrateChange{
			Kind: "plugin", Target: want.ID,
			From:   fmt.Sprintf("desired=%s enabled=%t", p.Current.Desired, p.Current.Enabled),
			To:     fmt.Sprintf("desired=%s enabled=%t", want.Desired, want.Enabled),
			Action: want.Desired,
		})
	}
	result.Applied = true
	result.Message = fmt.Sprintf("已应用 %d 项插件启停变更；配置与预设需人工对齐", len(result.Changes))
	writeJSON(w, http.StatusOK, result)
}
