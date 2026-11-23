package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 零侵入 profile（ADR-0023）。
//
// 两种安装形态：
//   - portable（默认）：全部状态在安装目录内——<install>/config、<install>/data、
//     <install>/run、<install>/logs。删掉 <install> 即等于卸载。
//   - fhs：传统的 /etc/kore + /var/lib/kore + /run/kore + /var/log/kore，供发行版打包；
//     属于"非零侵入模式"，卸载需 `kore uninstall` 或包管理器。
const (
	// ProfilePortable 是自包含安装形态（默认）。
	ProfilePortable = "portable"
	// ProfileFHS 是系统路径安装形态（发行版打包 / 系统级服务）。
	ProfileFHS = "fhs"
	// EnvProfile 是覆盖 profile 的环境变量名（优先级最高）。
	EnvProfile = "KORE_PROFILE"
	// EnvHome 是显式指定安装根目录的环境变量名（优先级高于可执行文件推导）。
	EnvHome = "KORE_HOME"
)

// installRootInfo 是一次安装根目录推导的结果。
type installRootInfo struct {
	// root 是 portable profile 的安装根目录。
	root string
	// systemBinary 表示可执行文件落在系统二进制目录（/usr/bin 等），
	// portable 会把数据写进 /usr/...，因此此时自动退回 fhs。
	systemBinary bool
	// reason 供日志/告警说明推导依据。
	reason string
}

// InstallRoot 返回 portable profile 的安装根目录。
func InstallRoot() string { return installRoot().root }

// installRoot 推导安装根目录，优先级：
//
//  1. KORE_HOME（显式覆盖，运维/服务脚本应设置它）；
//  2. os.Executable() 的可执行文件路径：符号链接先解析；
//     - 目录名是 bin → 取父目录（<install>/bin/kored → <install>）；
//     - 否则取可执行文件所在目录（go run / 单文件部署）；
//  3. 取不到可执行文件时退回当前工作目录（并标注原因）。
func installRoot() installRootInfo {
	if v := strings.TrimSpace(os.Getenv(EnvHome)); v != "" {
		if abs, err := filepath.Abs(v); err == nil {
			return installRootInfo{root: filepath.Clean(abs), reason: EnvHome}
		}
		return installRootInfo{root: filepath.Clean(v), reason: EnvHome}
	}
	exe, err := os.Executable()
	if err != nil {
		if cwd, cwdErr := os.Getwd(); cwdErr == nil {
			return installRootInfo{root: filepath.Clean(cwd), reason: "cwd（可执行文件路径不可得）"}
		}
		return installRootInfo{root: ".", reason: "相对路径（可执行文件与 cwd 都不可得）"}
	}
	if resolved, symErr := filepath.EvalSymlinks(exe); symErr == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)
	if isSystemBinDir(dir) {
		return installRootInfo{root: dir, systemBinary: true, reason: "可执行文件在系统目录 " + dir}
	}
	if filepath.Base(dir) == "bin" {
		return installRootInfo{root: filepath.Dir(dir), reason: "<install>/bin/<exe>"}
	}
	return installRootInfo{root: dir, reason: "可执行文件所在目录"}
}

// isSystemBinDir 判断目录是否属于系统二进制目录（写数据进去等于侵入）。
func isSystemBinDir(dir string) bool {
	switch dir {
	case "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin":
		return true
	}
	return strings.HasPrefix(dir, "/usr/")
}

// normalizeProfile 把配置值归一为合法 profile；空或非法返回空串。
func normalizeProfile(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case ProfilePortable:
		return ProfilePortable
	case ProfileFHS:
		return ProfileFHS
	}
	return ""
}

// profileFromEnv 读取 KORE_PROFILE（合法值才生效）。
func profileFromEnv() string { return normalizeProfile(os.Getenv(EnvProfile)) }

// resolveProfile 解析生效 profile：KORE_PROFILE > 可执行文件位置推导 > portable。
func resolveProfile() string {
	if v := profileFromEnv(); v != "" {
		return v
	}
	if info := installRoot(); info.systemBinary {
		return ProfileFHS
	}
	return ProfilePortable
}

// defaultLayout 返回某个 profile 下的目录与 socket 默认值。
func defaultLayout(profile string) (Paths, string) {
	if profile == ProfileFHS {
		return Paths{
			StateDir: "/var/lib/kore",
			LogDir:   "/var/log/kore",
			RunDir:   "/run/kore",
			IndexDir: "/var/lib/kore/index",
		}, "/run/kore/kore.sock"
	}
	root := InstallRoot()
	runDir := filepath.Join(root, "run")
	return Paths{
		StateDir: filepath.Join(root, "data"),
		LogDir:   filepath.Join(root, "logs"),
		RunDir:   runDir,
		IndexDir: filepath.Join(root, "data", "index"),
	}, filepath.Join(runDir, "kore.sock")
}

// applyProfileDefaults 在 profile 变化后，只重算"配置文件里没显式写"的字段。
//
// 显式配置永远优先（用户写死 /var/lib/kore 就继续用它），profile 只负责默认值。
func applyProfileDefaults(s *Snapshot, lines map[string]int) {
	paths, socket := defaultLayout(s.Profile)
	setPath := func(key string, dst *string, value string) {
		if _, explicit := lines[key]; explicit {
			return
		}
		*dst = value
	}
	setPath("paths.state_dir", &s.Paths.StateDir, paths.StateDir)
	setPath("paths.log_dir", &s.Paths.LogDir, paths.LogDir)
	setPath("paths.run_dir", &s.Paths.RunDir, paths.RunDir)
	setPath("paths.index_dir", &s.Paths.IndexDir, paths.IndexDir)
	if _, explicit := lines["server.socket"]; !explicit {
		s.Server.Socket = socket
	}
}

// reconcileProfile 处理"配置文件里的 profile"与"默认值推导用的 profile"不一致的情况。
//
// 优先级：KORE_PROFILE > 配置文件 profile > 可执行文件位置推导。
func reconcileProfile(s *Snapshot, lines map[string]int, initial string) []Warning {
	var warnings []Warning
	if env := profileFromEnv(); env != "" {
		if s.Profile != env {
			warnings = append(warnings, Warning{
				Source:  s.Source,
				Key:     "profile",
				Message: "被环境变量 " + EnvProfile + " 覆盖为 " + env,
			})
			s.Profile = env
			applyProfileDefaults(s, lines)
		}
		return warnings
	}
	if s.Profile != initial {
		warnings = append(warnings, Warning{
			Source:  s.Source,
			Key:     "profile",
			Message: "由配置文件设为 " + s.Profile + "；未显式设置的路径按该 profile 取默认值",
		})
		applyProfileDefaults(s, lines)
	}
	return warnings
}

// profileWarnings 生成与零侵入相关的启动告警（fhs 提示 + 旧路径迁移提示）。
//
// 迁移提示只提示、绝不自动搬数据：自动迁移会在用户不知情时移动状态库。
func profileWarnings(s *Snapshot, opts Options, usedDefaultConfig bool) []Warning {
	var warnings []Warning
	if s.Profile == ProfileFHS {
		warnings = append(warnings, Warning{
			Source: s.Source,
			Key:    "profile",
			Message: "fhs profile 为**非零侵入模式**：删除安装目录不会清理 /etc/kore、/var/lib/kore、" +
				"/var/log/kore、/run/kore；卸载请用 `kore uninstall` 或包管理器",
		})
	}
	if s.Profile != ProfilePortable {
		return warnings
	}
	// 旧配置：portable 默认不再读 /etc/kore/config.yaml；存在时给可操作的迁移提示。
	if usedDefaultConfig && os.Getenv(EnvConfigPath) == "" && opts.FlagPath == "" {
		if fileExists(legacyConfigPath) {
			warnings = append(warnings, Warning{
				Source: legacyConfigPath,
				Key:    "profile",
				Message: "检测到旧配置 " + legacyConfigPath + "，portable 默认不再读取它；" +
					"继续用旧配置请设 " + EnvProfile + "=fhs，或把它复制到 " + DefaultConfigPath(),
			})
		}
	}
	// 旧状态：有旧 state.db 且新状态目录还没有数据 → 提示迁移命令，不自动搬。
	if os.Getenv(EnvStateDir) == "" && opts.StateDir == "" && fileExists(filepath.Join(legacyStateDir, "state.db")) {
		if !fileExists(filepath.Join(s.Paths.StateDir, "state.db")) {
			warnings = append(warnings, Warning{
				Source: s.Paths.StateDir,
				Key:    "paths.state_dir",
				Message: fmt.Sprintf("检测到旧状态目录 %s 且有 state.db，当前 profile=portable 使用 %s；不会自动迁移。"+
					"迁移：停止 kored 后 `mv %s/* %s/`（或设 %s=fhs 继续用旧路径）",
					legacyStateDir, s.Paths.StateDir, legacyStateDir, s.Paths.StateDir, EnvProfile),
			})
		}
	}
	return warnings
}

// 旧（fhs）布局常量：仅用于迁移提示，不再作为默认值来源。
const (
	legacyConfigPath = "/etc/kore/config.yaml"
	legacyStateDir   = "/var/lib/kore"
)

// fileExists 判断路径是否存在（不区分文件/目录）。
func fileExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}
