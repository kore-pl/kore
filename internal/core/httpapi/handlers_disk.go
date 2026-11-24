package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 磁盘分析只读端点：GET /api/v1/system/disk-usage?category=<枚举>。
//
// 设计红线（G-01/G-24/G-31/G-19）：
//   - 路径不来自请求参数：category 只是枚举索引，后端映射到配置注入的已知目录，
//     前端无法传任意路径 → 天然免疫目录穿越（无 filepath.Clean(用户输入) 这类模式）。
//   - 全部对外结构为显式 DTO，无 any / object / map[string]any（G-24）。
//   - 只读：仅 os.Lstat / ReadDir / WalkDir，不写、不删、不改任何文件；清理动作只给跳转。
//   - 请求级超时 context.WithTimeout + defer cancel（G-19 允许请求级 timer，不常驻）。
//   - 不 import plugins/**，与 metrics 一样是内核系统可观测能力（G-01）。

const (
	diskUsagePath      = "/api/v1/system/disk-usage"
	diskScanTimeout    = 3 * time.Second // 单次扫描硬上限；超时返回已扫描部分 + truncated
	diskTopFilesLimit  = 10              // TopN 大文件条数
	diskDirNodesLimit  = 12              // SVG 占比环节点上限（G-32 ≤12）；超出归并"其他"
	diskWalkCheckEvery = 256             // 每 N 个条目检查一次 ctx，避免超时失控
	diskOldLogDays     = 7               // 旧日志建议阈值
	diskExpiredBakDays = 30              // 过期备份建议阈值
)

// diskDirUsage 是单个顶层目录的占用（对外显式 DTO）。
type diskDirUsage struct {
	Name  string `json:"name"`  // 目录名（相对 root 的第一段）
	Bytes int64  `json:"bytes"` // 累计字节数
	Files int    `json:"files"` // 文件数
}

// diskBigFile 是一个大文件条目（对外显式 DTO）。
type diskBigFile struct {
	Path    string `json:"path"`     // 相对扫描 root 的路径（不暴露绝对路径）
	Bytes   int64  `json:"bytes"`    // 字节数
	ModTime string `json:"mod_time"` // RFC3339 修改时间
}

// diskCleanAdvice 是一条"可安全清理什么"建议（对外显式 DTO，只读给跳转）。
type diskCleanAdvice struct {
	Kind   string `json:"kind"`   // old_log / expired_backup / temp_file / manual_review
	Title  string `json:"title"`  // 人话标题
	Reason string `json:"reason"` // 为什么可清 / 为何不能直接删
	Route  string `json:"route"`  // 跳转的视图 id；空 = 无自动清理入口
	Bytes  int64  `json:"bytes"`  // 可清理体量估计
}

// diskUsageBody 是成功响应体（对外显式 DTO）。
type diskUsageBody struct {
	Category   string            `json:"category"`
	Root       string            `json:"root"`        // 展示用相对目录名（如 "data/logs"），非绝对路径
	TotalBytes int64             `json:"total_bytes"` // 已扫描文件总字节
	Dirs       []diskDirUsage    `json:"dirs"`        // 顶层目录占用，按字节降序，≤12
	TopFiles   []diskBigFile     `json:"top_files"`   // 大文件 TopN，按字节降序
	Advice     []diskCleanAdvice `json:"advice"`      // 可清理建议
	Scanned    int               `json:"scanned"`     // 已扫描文件数
	Truncated  bool              `json:"truncated"`   // 是否因超时/文件数上限提前结束
	Note       string            `json:"note,omitempty"`
}

// diskCategoryRoot 把 category 枚举映射到配置注入的已知目录。
// 第二个返回值 false 表示该 category 依赖的目录未配置。这是唯一的路径来源：
// 请求里的任何 path / dir 参数都不会被读取，故无目录穿越面。
func (s *Server) diskCategoryRoot(cat string) (string, bool) {
	p := s.opts.Paths
	switch cat {
	case "logs":
		return p.LogDir, p.LogDir != ""
	case "plugins":
		return p.PluginDir, p.PluginDir != ""
	case "backups":
		return filepath.Join(p.StateDir, "backups"), p.StateDir != ""
	case "sites":
		return filepath.Join(p.StateDir, "sites"), p.StateDir != ""
	case "temp":
		return filepath.Join(p.StateDir, "temp"), p.StateDir != ""
	case "system":
		return p.StateDir, p.StateDir != ""
	default:
		return "", false
	}
}

// diskCategoryValid 是 category 枚举白名单（与前端 CATEGORIES 一一对应）。
func diskCategoryValid(cat string) bool {
	switch cat {
	case "logs", "backups", "plugins", "sites", "temp", "system":
		return true
	default:
		return false
	}
}

// authorizeDiskRead 复用系统采样鉴权口径：有效 session + system:read（fail-closed）。
func (s *Server) authorizeDiskRead(w http.ResponseWriter, r *http.Request) bool {
	return s.authorizeMetricsRead(w, r)
}

// handleDiskUsage 处理磁盘分析扫描。只读、有超时、显式 DTO。
func (s *Server) handleDiskUsage(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeDiskRead(w, r) {
		return
	}
	cat := r.URL.Query().Get("category")
	if !diskCategoryValid(cat) {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"类别不合法，请选择：系统分区 / 日志 / 备份 / 插件数据 / 站点目录 / 临时文件", "invalid category")
		return
	}
	root, ok := s.diskCategoryRoot(cat)
	if !ok || root == "" {
		// 目录未配置 → 空态（人话），不是 500。
		writeJSON(w, http.StatusOK, diskUsageBody{
			Category: cat, Root: cat, Dirs: []diskDirUsage{}, TopFiles: []diskBigFile{},
			Advice: []diskCleanAdvice{}, Note: "该目录尚未配置或不存在，暂无占用数据。",
		})
		return
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		writeJSON(w, http.StatusOK, diskUsageBody{
			Category: cat, Root: displayRoot(s.opts.Paths.StateDir, root),
			Dirs: []diskDirUsage{}, TopFiles: []diskBigFile{}, Advice: []diskCleanAdvice{},
			Note: "该目录当前不存在（还没有产生相关内容），无可分析数据。",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), diskScanTimeout)
	defer cancel()

	body := scanDisk(ctx, cat, displayRoot(s.opts.Paths.StateDir, root), root)
	writeJSON(w, http.StatusOK, body)
}

// displayRoot 把绝对路径收敛成相对 state_dir 的展示名，避免把机器绝对路径回显到面板。
func displayRoot(stateDir, root string) string {
	if stateDir != "" {
		if rel, err := filepath.Rel(filepath.Dir(stateDir), root); err == nil && rel != ".." &&
			!filepath.IsAbs(rel) && rel != "." {
			return filepath.ToSlash(rel)
		}
	}
	return filepath.Base(root)
}

// scanDisk 只读遍历 root，汇总顶层目录占用 + 大文件 TopN + 清理建议。
// 符号链接不跟随（WalkDir 默认行为），路径始终在 root 之下。
func scanDisk(ctx context.Context, cat, rootLabel, root string) diskUsageBody {
	body := diskUsageBody{
		Category: cat, Root: rootLabel,
		Dirs: []diskDirUsage{}, TopFiles: []diskBigFile{}, Advice: []diskCleanAdvice{},
	}
	dirAgg := make(map[string]*diskDirUsage)
	files := make([]diskBigFile, 0, 128)
	count := 0
	truncated := false
	now := time.Now()

	err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // 单个条目不可读：跳过，不影响整体（只读容错）
		}
		count++
		if count%diskWalkCheckEvery == 0 {
			if ctx.Err() != nil {
				truncated = true
				return filepath.SkipAll // 超时：保留已扫描数据，提前收口
			}
		}
		if d.IsDir() {
			return nil
		}
		fi, err := d.Info()
		if err != nil || !fi.Mode().IsRegular() {
			return nil // 只统计普通文件，跳过设备/管道/链接
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		size := fi.Size()
		body.TotalBytes += size
		body.Scanned++
		// 顶层目录归并（≤12 节点由 render 阶段处理，后端给全量聚合）
		top := rel
		if i := indexOfSlash(rel); i >= 0 {
			top = rel[:i]
		}
		agg := dirAgg[top]
		if agg == nil {
			agg = &diskDirUsage{Name: top}
			dirAgg[top] = agg
		}
		agg.Bytes += size
		agg.Files++
		files = append(files, diskBigFile{
			Path: rel, Bytes: size, ModTime: fi.ModTime().UTC().Format(time.RFC3339),
		})
		return nil
	})
	if err != nil && ctx.Err() != nil {
		truncated = true
	}

	for _, a := range dirAgg {
		body.Dirs = append(body.Dirs, *a)
	}
	sort.Slice(body.Dirs, func(i, j int) bool { return body.Dirs[i].Bytes > body.Dirs[j].Bytes })
	if len(body.Dirs) > diskDirNodesLimit {
		rest := diskDirUsage{Name: "其他"}
		for _, a := range body.Dirs[diskDirNodesLimit-1:] {
			rest.Bytes += a.Bytes
			rest.Files += a.Files
		}
		body.Dirs = append(body.Dirs[:diskDirNodesLimit-1], rest)
	}

	sort.Slice(files, func(i, j int) bool { return files[i].Bytes > files[j].Bytes })
	n := diskTopFilesLimit
	if len(files) < n {
		n = len(files)
	}
	body.TopFiles = append(body.TopFiles, files[:n]...)
	body.Advice = buildDiskAdvice(cat, body.TopFiles, now, dirAgg)
	body.Truncated = truncated
	if truncated {
		body.Note = "扫描范围较大，已展示先找到的部分；可缩小类别再看。"
	}
	if len(files) == 0 {
		body.Note = "该目录当前没有普通文件，或都不可读。"
	}
	slog.Debug("disk-usage scanned", "category", cat, "files", body.Scanned, "truncated", truncated)
	return body
}

// buildDiskAdvice 按 category + 扫描结果生成只读清理建议（只给跳转，不删任何东西）。
func buildDiskAdvice(cat string, top []diskBigFile, now time.Time, dirAgg map[string]*diskDirUsage) []diskCleanAdvice {
	out := make([]diskCleanAdvice, 0, 3)
	switch cat {
	case "logs":
		var oldBytes int64
		for _, f := range top {
			if t, err := time.Parse(time.RFC3339, f.ModTime); err == nil &&
				now.Sub(t) > time.Duration(diskOldLogDays)*24*time.Hour {
				oldBytes += f.Bytes
			}
		}
		out = append(out, diskCleanAdvice{
			Kind: "old_log", Title: "清理旧日志",
			Reason: "超过 " + itoa(diskOldLogDays) + " 天未修改的日志通常可清理；清理前可先下载留存。",
			Route:  "logs", Bytes: oldBytes,
		})
	case "backups":
		var expired int64
		for _, f := range top {
			if t, err := time.Parse(time.RFC3339, f.ModTime); err == nil &&
				now.Sub(t) > time.Duration(diskExpiredBakDays)*24*time.Hour {
				expired += f.Bytes
			}
		}
		out = append(out, diskCleanAdvice{
			Kind: "expired_backup", Title: "清理过期备份",
			Reason: "超过 " + itoa(diskExpiredBakDays) + " 天的备份建议先确认有更新的可恢复副本，再到备份页处理。",
			Route:  "backup", Bytes: expired,
		})
	case "temp":
		var tmpBytes int64
		for _, f := range top {
			tmpBytes += f.Bytes
		}
		out = append(out, diskCleanAdvice{
			Kind: "temp_file", Title: "到文件管理处理临时文件",
			Reason: "临时文件可能仍被运行中的程序占用，不能一键删除；请在文件管理中确认后处理。",
			Route:  "files", Bytes: tmpBytes,
		})
	case "system", "plugins", "sites":
		out = append(out, diskCleanAdvice{
			Kind: "manual_review", Title: "需人工确认",
			Reason: "该目录多为运行中依赖，直接删除可能导致服务异常；请按上方大文件列表逐项确认。",
			Route:  "", Bytes: 0,
		})
	}
	return out
}

// indexOfSlash 返回第一个 '/' 的下标，-1 表示没有。
func indexOfSlash(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] == '/' {
			return i
		}
	}
	return -1
}

// itoa 是非负小整数转字符串（避免为常量 import strconv 的额外心智负担）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
