package market

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
)

// Installer 是 market 触发安装所需的最小能力，由装配层用闭包适配 installer.New。
// market 只触发安装并传入索引声明的 sha256，不下载包（M2-B 第二批）。
type Installer interface {
	// Install 校验并原子安装本地 tar.gz 包；expectedSHA 来自索引，由安装器自算比对。
	Install(path, expectedSHA string) error
}

// Options 是 Service 构造参数。
type Options struct {
	// IndexDir 是本地索引目录。
	IndexDir string
	// AllowUnsigned 仅显式配置 true 才允许未签名/验签失败索引。
	AllowUnsigned bool
	// Installer 是安装触发器；nil 表示 install 端点返回 E_UNSUPPORTED。
	Installer Installer
	// Logger 是 WARN 审计目标；nil 用 slog.Default()。
	Logger *slog.Logger
}

// Service 是 market 模块：索引读取/验签/查询/安装触发。
type Service struct {
	indexDir      string
	allowUnsigned bool
	installer     Installer
	logger        *slog.Logger
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
		indexDir: opts.IndexDir, allowUnsigned: opts.AllowUnsigned,
		installer: opts.Installer, logger: logger,
	}
}

// Load 读取并（默认）验签索引，返回按 id 升序的条目。
func (s *Service) Load() (Index, error) {
	data, sig, err := readIndexFiles(s.indexDir)
	if err != nil {
		return Index{}, protocolError("E_UPSTREAM", "读取本地索引失败", err.Error())
	}
	if err := verifySignature(data, sig); err != nil {
		if !s.allowUnsigned {
			return Index{}, err
		}
		s.logger.Warn("审计：接受未验签索引", "index_dir", s.indexDir, "key", "store.allow_unsigned")
	}
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
	p, err := s.Plugin(id)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, protocolError("E_NOTFOUND", "索引中不存在插件", id)
	}
	if p.Version != version {
		return nil, protocolError("E_INVALID", fmt.Sprintf("索引版本为 %s，请求 %s", p.Version, version))
	}
	if s.installer == nil {
		return nil, protocolError("E_UNSUPPORTED", "安装后端未装配")
	}
	if err := s.installer.Install(packagePath, strings.ToLower(p.SHA256)); err != nil {
		return nil, protocolError("E_INVALID", "安装失败", err.Error())
	}
	return &InstallJob{ID: id + "-" + version, PluginID: id, Version: version, State: "succeeded", Message: "安装完成"}, nil
}
