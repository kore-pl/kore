package market

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Installer 是 market 触发安装所需的最小能力，由装配层用闭包适配 installer.New。
// market 只触发安装并传入索引声明的 sha256；下载安装所需的能力见 URLInstaller。
type Installer interface {
	// Install 校验并原子安装本地 tar.gz 包；expectedSHA 来自索引，由安装器自算比对。
	Install(path, expectedSHA string) error
}

// ForceInstaller 是本地包的强制重装能力（同 id 同版本已安装时允许覆盖）。
// 由装配层实现：先停用插件 → 备份旧目录 → 安装 → 恢复期望态；market 只透传语义。
type ForceInstaller interface {
	// InstallForce 强制重装本地包；id 用于停用/恢复对应插件。
	InstallForce(id, path, expectedSHA string) error
}

// Options 是 Service 构造参数。
type Options struct {
	// IndexDir 是本地索引目录。
	IndexDir string
	// PresetsDir 是 kore-plugins/presets 预设目录；空表示未装配（presets 返回空列表）。
	PresetsDir string
	// AllowUnsigned 仅显式配置 true 才允许未签名/验签失败索引。
	AllowUnsigned bool
	// Installer 是安装触发器；nil 表示 install/update 端点返回 E_UNSUPPORTED。
	Installer Installer
	// Logger 是 WARN 审计目标；nil 用 slog.Default()。
	Logger *slog.Logger
}

// Service 是 market 模块：索引读取/验签/查询/安装触发。
type Service struct {
	indexDir      string
	presetsDir    string
	allowUnsigned bool
	installer     Installer
	logger        *slog.Logger

	// verifyKey 仅供同包测试注入配对公钥做验签正反例；生产恒为 nil，
	// 信任根固定走 verifySignature 里的内置公钥常量（G-10，外部无注入面）。
	verifyKey []byte

	mu     sync.Mutex
	cached *Index // 最近一次 refresh 成功的已验签索引快照；验签失败绝不覆盖
}

// New 构造 Service；不触碰文件系统（懒加载索引）。
func New(opts Options) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	if opts.AllowUnsigned {
		logger.Warn("审计：索引签名校验被显式放行（信任空窗，仅允许显式审计配置）", "key", "store.allow_unsigned")
	}
	return &Service{
		indexDir: opts.IndexDir, presetsDir: opts.PresetsDir,
		allowUnsigned: opts.AllowUnsigned, installer: opts.Installer, logger: logger,
	}
}

// verify 用信任根验签：生产固定内置公钥；仅同包测试注入 verifyKey。
func (s *Service) verify(data, sig []byte) error {
	if s.verifyKey != nil {
		return verifyWithKey(s.verifyKey, data, sig)
	}
	return verifySignature(data, sig)
}

// parseIndex 解析并校验已验签的索引正文；排序后返回。
func parseIndex(data []byte) (Index, error) {
	var index Index
	if err := json.Unmarshal(data, &index); err != nil {
		return Index{}, protocolError("E_INVALID", "索引 JSON 非法", err.Error())
	}
	if index.SchemaVersion != 1 {
		return Index{}, protocolError("E_INVALID", fmt.Sprintf("不支持的 schema_version=%d", index.SchemaVersion))
	}
	if err := validateIndex(&index); err != nil {
		return Index{}, err
	}
	sort.Slice(index.Plugins, func(i, j int) bool { return index.Plugins[i].ID < index.Plugins[j].ID })
	return index, nil
}

// Load 读取并（默认）验签索引，返回按 id 升序的条目。
// 每次现场重读磁盘，不读写缓存——保留现有端点行为。
func (s *Service) Load() (Index, error) {
	return s.readTrusted()
}

// readTrusted 是索引信任门的唯一实现：现场重读 + 验签通过才返回条目。
//
// 验签失败时只有 store.allow_unsigned 显式放行才降级（WARN 审计），默认拒绝。
// 列表、预设、安装/更新、下载安装全部共用这一道门——不存在"某个入口不验签"的旁路。
func (s *Service) readTrusted() (Index, error) {
	data, sig, err := readIndexFiles(s.indexDir)
	if err != nil {
		return Index{}, protocolError("E_UPSTREAM", "读取本地索引失败", err.Error())
	}
	if err := s.verify(data, sig); err != nil {
		if !s.allowUnsigned {
			return Index{}, err
		}
		s.logger.Warn("审计：接受未验签索引", "index_dir", s.indexDir, "key", "store.allow_unsigned")
	}
	return parseIndex(data)
}

// readVerified 是三端点的强制验签门：现场重读 + 验签失败即拒，不返回任何数据。
// allowUnsigned 只影响 Load 的兼容读取；本门不看缓存、不读缓存，拒绝时绝不触碰缓存。
func (s *Service) readVerified() (Index, error) {
	data, sig, err := readIndexFiles(s.indexDir)
	if err != nil {
		return Index{}, protocolError("E_UPSTREAM", "读取本地索引失败", err.Error())
	}
	if err := s.verify(data, sig); err != nil {
		return Index{}, err // 签名缺失/篡改/验签失败：一律拒，绝不落缓存
	}
	return parseIndex(data)
}

// Refresh 重读索引并验签；验签通过才更新缓存，失败保留旧索引（R4）。
func (s *Service) Refresh() (*RefreshResult, error) {
	index, err := s.readVerified()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	snapshot := index
	s.cached = &snapshot
	s.mu.Unlock()
	return &RefreshResult{
		Refreshed: true, PluginCount: len(index.Plugins), Message: "索引已刷新并通过验签",
	}, nil
}

// CachedPluginCount 返回当前已验签缓存的插件条数；缓存为空返回 0 与 false。
// 仅用于测试断言"验签失败保留旧索引"与运维可观测，不参与端点决策。
func (s *Service) CachedPluginCount() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached == nil {
		return 0, false
	}
	return len(s.cached.Plugins), true
}

// Presets 返回 kore-plugins/presets 的预设元数据列表。
// 先过强制验签门：索引被篡改/未签名时直接拒，不读磁盘预设、不读缓存（R4）。
func (s *Service) Presets() ([]Preset, error) {
	if _, err := s.readVerified(); err != nil {
		return nil, err
	}
	if s.presetsDir == "" {
		return []Preset{}, nil
	}
	entries, err := os.ReadDir(s.presetsDir)
	if err != nil {
		return nil, protocolError("E_UPSTREAM", "读取预设目录失败", err.Error())
	}
	presets := make([]Preset, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.presetsDir, entry.Name()))
		if err != nil {
			return nil, protocolError("E_UPSTREAM", "读取预设失败", err.Error())
		}
		var preset Preset
		if err := json.Unmarshal(data, &preset); err != nil {
			return nil, protocolError("E_INVALID", "预设 JSON 非法", err.Error())
		}
		if !idPattern.MatchString(preset.ID) {
			return nil, protocolError("E_INVALID", fmt.Sprintf("预设 id 非法: %s", preset.ID))
		}
		presets = append(presets, preset)
	}
	sort.Slice(presets, func(i, j int) bool { return presets[i].ID < presets[j].ID })
	return presets, nil
}

// Update 走现有 installer 安装新版本（索引级验签 + 包 sha256 双门，R4）。
// 先过强制验签门，再从本份已验签索引取 sha256 交给 installer 自算比对，
// 摘要不符由 installer 拒绝且不落盘；market 不重复实现包校验。
func (s *Service) Update(id, version, packagePath string) (*UpdateResult, error) {
	index, err := s.readVerified()
	if err != nil {
		return nil, err
	}
	job, err := installFrom(index, s.installer, id, version, packagePath, false)
	if err != nil {
		return nil, err
	}
	return &UpdateResult{ID: job.PluginID, Version: job.Version, State: job.State, Message: job.Message}, nil
}

// Plugin 按 id 查单条；不存在返回 nil。
func (s *Service) Plugin(id string) (*Plugin, error) {
	index, err := s.Load()
	if err != nil {
		return nil, err
	}
	for i := range index.Plugins {
		if index.Plugins[i].ID == id {
			return &index.Plugins[i], nil
		}
	}
	return nil, nil
}

// Install 触发本地包安装：按 id/version 查索引拿 sha256，交给 installer。
func (s *Service) Install(id, version, packagePath string) (*InstallJob, error) {
	index, err := s.Load()
	if err != nil {
		return nil, err
	}
	return installFrom(index, s.installer, id, version, packagePath, false)
}

// InstallForce 以强制模式安装本地包：允许覆盖已装同版本（修复/重装）。
//
// force 不是跳过校验：索引 sha256、包内 SHA256SUMS、info.json 校验全部照旧执行，
// 只是允许目标版本目录已存在（装配层负责先停用插件并备份旧目录）。
func (s *Service) InstallForce(id, version, packagePath string) (*InstallJob, error) {
	index, err := s.Load()
	if err != nil {
		return nil, err
	}
	return installFrom(index, s.installer, id, version, packagePath, true)
}

// installFrom 从给定的已验签索引取条目并交给 installer；供 Install/InstallForce 共用。
func installFrom(index Index, installer Installer, id, version, packagePath string, force bool) (*InstallJob, error) {
	found, err := findEntry(index, id, version)
	if err != nil {
		return nil, err
	}
	if installer == nil {
		return nil, protocolError("E_UNSUPPORTED", "安装后端未装配")
	}
	expected := strings.ToLower(found.SHA256)
	if force {
		forced, ok := installer.(ForceInstaller)
		if !ok {
			return nil, protocolError("E_UNSUPPORTED", "安装后端不支持强制重装")
		}
		if err := forced.InstallForce(id, packagePath, expected); err != nil {
			return nil, installError(err)
		}
	} else if err := installer.Install(packagePath, expected); err != nil {
		return nil, installError(err)
	}
	return &InstallJob{ID: id + "-" + version, PluginID: id, Version: version, State: "succeeded", Message: "安装完成"}, nil
}

// findEntry 在已验签索引中定位 id@版本：未收录 → E_NOTFOUND，版本不符 → E_INVALID。
// 本地包安装与下载安装共用同一套定位口径，避免两条路径对"版本"的判定漂移。
func findEntry(index Index, id, version string) (*Plugin, error) {
	for i := range index.Plugins {
		if index.Plugins[i].ID != id {
			continue
		}
		if index.Plugins[i].Version != version {
			return nil, protocolError("E_INVALID", fmt.Sprintf("索引版本为 %s，请求 %s",
				index.Plugins[i].Version, version))
		}
		return &index.Plugins[i], nil
	}
	return nil, protocolError("E_NOTFOUND", "索引中不存在插件", id)
}
