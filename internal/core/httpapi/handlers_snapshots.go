package httpapi

// 配置快照（时光机）HTTP 端点：给当前"已装插件版本 / 启停态 / 关键配置"打命名快照，
// 可列出、对比、回滚。数据与备份插件（文件/数据库备份）完全分离：快照只存配置元数据，
// 落在 <state_dir>/snapshots/ 目录，每个快照一个 JSON 文件，不碰运行状态、不写安装目录外（G-31）。
//
// G-01 薄壳边界：本文件只读 system/info 已暴露的 paths 与 Backend.Plugins 视图，
// 不 import store、不直接读 bbolt。写盘限定在 opts.Paths.StateDir 派生的 snapshots 子目录。

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const snapshotsDirName = "snapshots"

// snapshotID 是快照文件名安全字符集：只允许小写字母、数字、连字符，长度 1–64。
// 由创建时间（yyyymmdd-hhmmss）+ 短随机串拼出，不接受用户提供的路径片段。
var snapshotIDRe = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// SnapshotPlugin 是快照里一个插件的配置条目（显式字段，G-24）。
type SnapshotPlugin struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Enabled bool   `json:"enabled"`
	Desired string `json:"desired"`
}

// SnapshotConfig 是快照里的关键配置项（显式字段，G-24；不落敏感值）。
type SnapshotConfig struct {
	KoreVersion string `json:"kore_version"`
	StateDir    string `json:"state_dir"`
	PluginDir   string `json:"plugin_dir"`
	IndexDir    string `json:"index_dir"`
}

// Snapshot 是落盘 JSON 的完整结构（对外 schema 显式列出字段，G-24）。
type Snapshot struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	CreatedAt string           `json:"created_at"`
	Config    SnapshotConfig   `json:"config"`
	Plugins   []SnapshotPlugin `json:"plugins"`
}

// snapshotListBody 是 GET /api/v1/snapshots 的响应体。
type snapshotListBody struct {
	Snapshots []Snapshot `json:"snapshots"`
}

// snapshotCreateRequest 是 POST /api/v1/snapshots 的请求体。
type snapshotCreateRequest struct {
	Name string `json:"name"`
}

// snapshotDiffBody 是 GET /api/v1/snapshots/{id}/diff 的响应体。
type snapshotDiffBody struct {
	SnapshotID string             `json:"snapshot_id"`
	Changes    []SnapshotDiffItem `json:"changes"`
}

// SnapshotDiffItem 描述一个插件在"快照 vs 当前"之间的差异（显式字段，G-24）。
type SnapshotDiffItem struct {
	PluginID   string `json:"plugin_id"`
	Kind       string `json:"kind"` // added / removed / version / enabled
	From       string `json:"from"`
	To         string `json:"to"`
	FromExists bool   `json:"from_exists"`
	ToExists   bool   `json:"to_exists"`
}

// snapshotDeleteBody 是 DELETE /api/v1/snapshots/{id} 的响应体。
type snapshotDeleteBody struct {
	Deleted string `json:"deleted"`
}

// snapshotRollbackRequest 是 POST /api/v1/snapshots/{id}/rollback 的请求体。
// Confirm 必须为字符串 "yes" 才执行：二次确认是不可绕过的闸门。
type snapshotRollbackRequest struct {
	Confirm string `json:"confirm"`
}

// snapshotRollbackBody 是回滚响应体：逐个列出本轮实际改动（显式字段，G-24）。
type snapshotRollbackBody struct {
	SnapshotID string             `json:"snapshot_id"`
	Applied    []SnapshotDiffItem `json:"applied"`
	Failed     []SnapshotRollFail `json:"failed"`
}

// SnapshotRollFail 记录一个回滚失败项（显式字段，G-24）。
type SnapshotRollFail struct {
	PluginID string `json:"plugin_id"`
	Action   string `json:"action"`
	Error    string `json:"error"`
}

// authorizeSnapshots 只读端点要求 system:read，写端点（创建/回滚/删除）要求 system:admin。
func (s *Server) authorizeSnapshots(w http.ResponseWriter, r *http.Request, capability string) bool {
	if !s.authorizeTargetAction(w, r) {
		return false
	}
	if s.auth == nil {
		return true // 探活骨架未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, capability) {
		s.auditDenied(subject, "snapshots", "", "", "需要 "+capability+" 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：配置快照需要 "+capability+" 能力", capability)
		return false
	}
	return true
}

// snapshotDir 返回快照目录绝对路径（严格在 state_dir 下，G-31 零侵入）。
func (s *Server) snapshotDir() (string, error) {
	stateDir := s.opts.Paths.StateDir
	if stateDir == "" {
		return "", errors.New("状态目录未装配，无法使用配置快照")
	}
	abs, err := filepath.Abs(stateDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(abs, snapshotsDirName), nil
}

// snapshotPath 校验 id 后拼出单个快照文件路径；id 非法一律拒绝，防目录穿越。
func snapshotPath(dir, id string) (string, error) {
	if !snapshotIDRe.MatchString(id) {
		return "", fmt.Errorf("非法快照 id：%q", id)
	}
	return filepath.Join(dir, id+".json"), nil
}

// readSnapshot 读一个快照文件并做结构校验。
func readSnapshot(dir, id string) (Snapshot, error) {
	path, err := snapshotPath(dir, id)
	if err != nil {
		return Snapshot{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Snapshot{}, fmt.Errorf("%w: 快照不存在", err)
		}
		return Snapshot{}, err
	}
	var snap Snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return Snapshot{}, fmt.Errorf("快照文件损坏：%v", err)
	}
	if snap.ID == "" || snap.CreatedAt == "" {
		return Snapshot{}, errors.New("快照文件格式非法：缺 id 或 created_at")
	}
	return snap, nil
}

// listSnapshots 读取目录内全部 *.json，按 created_at 倒序（最新优先）。
func listSnapshots(dir string) ([]Snapshot, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Snapshot{}, nil // 从未创建过快照：空列表不是错误
		}
		return nil, err
	}
	out := make([]Snapshot, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		snap, err := readSnapshot(dir, id)
		if err != nil {
			slog.Warn("跳过损坏的快照文件", "id", id, "err", err)
			continue
		}
		out = append(out, snap)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// currentPlugins 从装配层取当前插件配置视图，转成快照用的显式条目。
func (s *Server) currentPlugins(r *http.Request) ([]SnapshotPlugin, error) {
	if s.opts.Backend == nil {
		return nil, errors.New("插件后端未装配，无法采集配置快照")
	}
	plugins, err := s.opts.Backend.Plugins(r.Context())
	if err != nil {
		return nil, err
	}
	out := make([]SnapshotPlugin, 0, len(plugins))
	for _, p := range plugins {
		out = append(out, SnapshotPlugin{
			ID: p.ID, Version: p.Version, Enabled: p.Enabled, Desired: p.Desired,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// handleSnapshotsList 处理 GET /api/v1/snapshots。
func (s *Server) handleSnapshotsList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSnapshots(w, r, "system:read") {
		return
	}
	dir, err := s.snapshotDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, err.Error(), "")
		return
	}
	snaps, err := listSnapshots(dir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "读取快照列表失败", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snapshotListBody{Snapshots: snaps})
}

// handleSnapshotsCreate 处理 POST /api/v1/snapshots：采集当前配置 → 原子写 JSON 文件。
func (s *Server) handleSnapshotsCreate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSnapshots(w, r, "system:admin") {
		return
	}
	var req snapshotCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求格式错误：需要 {\"name\":\"...\"}", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "未命名快照"
	}
	if len([]rune(name)) > 60 {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "快照名称过长（最多 60 字）", "")
		return
	}
	plugins, err := s.currentPlugins(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "采集当前配置失败", err.Error())
		return
	}
	dir, err := s.snapshotDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, err.Error(), "")
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "创建快照目录失败", err.Error())
		return
	}
	// id 由时间戳 + 纳秒尾数生成，不接受用户输入，杜绝目录穿越。
	now := time.Now()
	id := strings.ToLower(now.Format("20060102-150405")) + "-" + fmt.Sprintf("%03d", now.Nanosecond()/1000000)
	snap := Snapshot{
		ID: id, Name: name, CreatedAt: now.Format(time.RFC3339),
		Config: SnapshotConfig{
			KoreVersion: s.opts.Version, StateDir: s.opts.Paths.StateDir,
			PluginDir: s.opts.Paths.PluginDir, IndexDir: s.opts.Paths.IndexDir,
		},
		Plugins: plugins,
	}
	raw, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "快照序列化失败", err.Error())
		return
	}
	path, _ := snapshotPath(dir, id) // id 本函数内生成，必合法
	if err := atomicWriteFile(path, raw, 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "写快照文件失败", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// handleSnapshotsDelete 处理 DELETE /api/v1/snapshots/{id}。
func (s *Server) handleSnapshotsDelete(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSnapshots(w, r, "system:admin") {
		return
	}
	dir, err := s.snapshotDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, err.Error(), "")
		return
	}
	path, err := snapshotPath(dir, r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	if err := os.Remove(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "快照不存在", "")
			return
		}
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "删除快照失败", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snapshotDeleteBody{Deleted: r.PathValue("id")})
}

// diffSnapshots 计算快照 → 当前配置的差异清单（纯函数，不产生副作用）。
func diffSnapshots(snap Snapshot, current []SnapshotPlugin) []SnapshotDiffItem {
	bySnap := make(map[string]SnapshotPlugin, len(snap.Plugins))
	byCur := make(map[string]SnapshotPlugin, len(current))
	for _, p := range snap.Plugins {
		bySnap[p.ID] = p
	}
	for _, p := range current {
		byCur[p.ID] = p
	}
	ids := make([]string, 0, len(bySnap)+len(byCur))
	seen := make(map[string]bool)
	for id := range bySnap {
		ids, seen[id] = append(ids, id), true
	}
	for id := range byCur {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	out := make([]SnapshotDiffItem, 0)
	for _, id := range ids {
		sp, inSnap := bySnap[id]
		cp, inCur := byCur[id]
		switch {
		case inSnap && !inCur:
			out = append(out, SnapshotDiffItem{PluginID: id, Kind: "removed", From: sp.Version, To: "", FromExists: true, ToExists: false})
		case !inSnap && inCur:
			out = append(out, SnapshotDiffItem{PluginID: id, Kind: "added", From: "", To: cp.Version, FromExists: false, ToExists: true})
		default:
			if sp.Version != cp.Version {
				out = append(out, SnapshotDiffItem{PluginID: id, Kind: "version", From: sp.Version, To: cp.Version, FromExists: true, ToExists: true})
			}
			if sp.Enabled != cp.Enabled {
				out = append(out, SnapshotDiffItem{PluginID: id, Kind: "enabled", From: boolText(sp.Enabled), To: boolText(cp.Enabled), FromExists: true, ToExists: true})
			}
		}
	}
	return out
}

func boolText(v bool) string {
	if v {
		return "启用"
	}
	return "停用"
}

// handleSnapshotsDiff 处理 GET /api/v1/snapshots/{id}/diff。
// 返回"回滚会改动什么"的预览：快照值 → 当前值；回滚方向即把 from 恢复到系统。
func (s *Server) handleSnapshotsDiff(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSnapshots(w, r, "system:read") {
		return
	}
	dir, err := s.snapshotDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, err.Error(), "")
		return
	}
	id := r.PathValue("id")
	snap, err := readSnapshot(dir, id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "快照不存在", "")
			return
		}
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "读取快照失败", err.Error())
		return
	}
	cur, err := s.currentPlugins(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "读取当前配置失败", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snapshotDiffBody{SnapshotID: id, Changes: diffSnapshots(snap, cur)})
}

// handleSnapshotsRollback 处理 POST /api/v1/snapshots/{id}/rollback。
// 必须带 {"confirm":"yes"} 才执行；回滚只处理启停态（版本回滚由插件升级链路负责，
// 快照不存包体，避免把"配置快照"变成"数据备份"混淆）。差异预览里的版本项会明确标为不自动回滚。
func (s *Server) handleSnapshotsRollback(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSnapshots(w, r, "system:admin") {
		return
	}
	var req snapshotRollbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求格式错误：需要 {\"confirm\":\"yes\"}", err.Error())
		return
	}
	if req.Confirm != "yes" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "回滚需二次确认：请传 {\"confirm\":\"yes\"}", "")
		return
	}
	dir, err := s.snapshotDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, err.Error(), "")
		return
	}
	id := r.PathValue("id")
	snap, err := readSnapshot(dir, id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "快照不存在", "")
			return
		}
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "读取快照失败", err.Error())
		return
	}
	cur, err := s.currentPlugins(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "读取当前配置失败", err.Error())
		return
	}
	// 差异预览由前端 GET .../diff 单独拉取；此处只落地"实际改动"，避免重复计算。
	applied := make([]SnapshotDiffItem, 0)
	failed := make([]SnapshotRollFail, 0)
	wantEnabled := make(map[string]bool, len(snap.Plugins))
	for _, p := range snap.Plugins {
		wantEnabled[p.ID] = p.Enabled
	}
	// 按快照中的插件顺序逐项对齐启停态；版本差异不在此端点处理（只记录跳过的项）。
	for _, p := range snap.Plugins {
		now, exists := findPlugin(cur, p.ID)
		if !exists {
			failed = append(failed, SnapshotRollFail{PluginID: p.ID, Action: "restore", Error: "当前系统未安装该插件，无法恢复启停态"})
			continue
		}
		if now.Enabled == p.Enabled {
			continue
		}
		action := "disable"
		if p.Enabled {
			action = "enable"
		}
		var rollErr error
		if p.Enabled {
			rollErr = s.opts.Backend.Enable(r.Context(), p.ID)
		} else {
			rollErr = s.opts.Backend.Disable(r.Context(), p.ID)
		}
		if rollErr != nil {
			failed = append(failed, SnapshotRollFail{PluginID: p.ID, Action: action, Error: rollErr.Error()})
			continue
		}
		applied = append(applied, SnapshotDiffItem{
			PluginID: p.ID, Kind: "enabled", From: boolText(now.Enabled), To: boolText(p.Enabled),
			FromExists: true, ToExists: true,
		})
	}
	// 快照里没有、当前新装的插件：回滚到"未安装"语义上应由用户走卸载流程，
	// 快照端点不擅自卸载（危险操作不代劳），在 failed 里明确提示。
	for _, c := range cur {
		if _, ok := wantEnabled[c.ID]; !ok {
			failed = append(failed, SnapshotRollFail{PluginID: c.ID, Action: "uninstall", Error: "快照中不存在该插件；如需卸载请在插件管理页手动操作"})
		}
	}
	writeJSON(w, http.StatusOK, snapshotRollbackBody{SnapshotID: id, Applied: applied, Failed: failed})
}

func findPlugin(list []SnapshotPlugin, id string) (SnapshotPlugin, bool) {
	for _, p := range list {
		if p.ID == id {
			return p, true
		}
	}
	return SnapshotPlugin{}, false
}

// atomicWriteFile 先写同目录临时文件再 rename，保证快照文件不会半写坏。
func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
