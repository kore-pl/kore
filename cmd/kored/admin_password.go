package main

import (
	"bufio"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pengtang1024/kore/internal/core/auth"
	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/platform"
)

// adminPasswordConfigKey 是配置文件里的哈希键名（嵌套在顶层 auth: 下）。
const adminPasswordConfigKey = "admin_password_hash"

// adminPasswordLength 是 --generate 生成的口令长度（24 字符，约 142 bit 熵）。
const adminPasswordLength = 24

// 依赖注入点：生产值绑定真实终端与文件系统，测试替换后即可无 TTY 跑全路径。
var (
	// adminTTY 判断当前 stdin 是否交互终端（/dev/null 不算）。
	adminTTY = func() bool { return platform.IsTerminal(os.Stdin.Fd()) }
	// adminPrompt 打印提示并读一行（TTY 上关闭回显）。
	adminPrompt = func(prompt string, out io.Writer) (string, error) {
		fmt.Fprint(out, prompt)
		return readPasswordNoEcho(os.Stdin)
	}
	// adminStdin 是 --stdin 的读取来源。
	adminStdin io.Reader = os.Stdin
	// adminRenameFile 是原子写的最后一步（测试注入失败用）。
	adminRenameFile = os.Rename
	// firstRunTerminal 判断首启凭据能否安全打印到终端（stderr 是 TTY）。
	// 非 TTY（systemd/journald、重定向）不生成、不打印明文：日志长期可读，
	// 明文凭据只允许出现在用户当前终端这一次。
	firstRunTerminal = func() bool { return platform.IsTerminal(os.Stderr.Fd()) }
)

// adminPasswordOptions 是 admin-password 子命令解析后的参数。
type adminPasswordOptions struct {
	// generate 表示生成随机口令。
	generate bool
	// set 表示交互式设置口令。
	set bool
	// hash 是直接写入的 PBKDF2 存储串（兼容手工路径）。
	hash string
	// fromStdin 表示从管道读取 --set 的口令（非 TTY 必需）。
	fromStdin bool
	// config 是配置文件路径（缺省取 KORE_CONFIG / profile 默认）。
	config string
}

// parseAdminPasswordFlags 解析 admin-password 参数。
func parseAdminPasswordFlags(args []string, stderr io.Writer) (adminPasswordOptions, error) {
	fs := flag.NewFlagSet("admin-password", flag.ContinueOnError)
	fs.SetOutput(stderr)
	generate := fs.Bool("generate", false, "生成 24 字符随机口令并写入配置文件（只显示这一次）")
	set := fs.Bool("set", false, "交互式设置口令（读两次，关闭回显）")
	hash := fs.String("hash", "", "直接写入给定的 pbkdf2-sha256 存储串")
	fromStdin := fs.Bool("stdin", false, "配合 --set：从管道读取口令（非 TTY 环境）")
	config := fs.String("config", os.Getenv(coreconfig.EnvConfigPath), "配置文件路径（默认取 KORE_CONFIG）")
	fs.Usage = func() { printAdminPasswordUsage(stderr) }
	if err := fs.Parse(args); err != nil {
		return adminPasswordOptions{}, err
	}
	return adminPasswordOptions{
		generate: *generate, set: *set, hash: *hash,
		fromStdin: *fromStdin, config: *config,
	}, nil
}

// printAdminPasswordUsage 打印子命令用法。
func printAdminPasswordUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored admin-password <--generate | --set [--stdin] | --hash <存储串>> [--config <path>]")
	fmt.Fprintln(w, "  --generate       生成 24 字符随机口令，写入配置文件并打印一次")
	fmt.Fprintln(w, "  --set            交互式读两次口令（关闭回显）；非 TTY 时须配 --stdin")
	fmt.Fprintln(w, "  --stdin          配合 --set：从标准输入读一行口令（CI / 容器）")
	fmt.Fprintln(w, "  --hash <串>      直接写入 pbkdf2-sha256$<iter>$<salt>$<hash>（自动化场景）")
	fmt.Fprintln(w, "  --config <path>  配置文件路径（默认 KORE_CONFIG 或 <install>/config/config.yaml）")
	fmt.Fprintln(w, "口令与哈希不写日志；配置文件权限固定 0600，写入走临时文件 + fsync + rename。")
}

// runAdminPassword 是 admin-password 子命令入口。
func runAdminPassword(args []string, stdout, stderr io.Writer) int {
	opts, err := parseAdminPasswordFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	hash, plain, code := resolveAdminPassword(opts, stdout, stderr)
	if code != exitOK {
		return code
	}
	// 与 serve 共用同一套解析（KORE_CONFIG > --config > profile 默认），再归一为
	// 绝对路径：写哪个文件、打印哪个路径、`serve --config` 读哪个文件必须是同一个。
	path, err := adminPasswordConfigPath(opts.config)
	if err != nil {
		fmt.Fprintf(stderr, "配置路径解析失败: %v\n", err)
		return exitConfig
	}
	// ADR-0055 §5：CLI 重置（--generate/--set/--hash）写新哈希时必须置
	// must_change_password=true，下次登录仍需改密；SIGHUP 同步后旧会话吊销。
	if err := writeAdminCredentialHash(path, hash, true); err != nil {
		fmt.Fprintf(stderr, "写入配置失败: %v\n", err)
		return exitConfig
	}
	if plain != "" {
		fmt.Fprintf(stdout, "\n管理员口令（只显示这一次，请立即保存）：%s\n", plain)
	}
	fmt.Fprintf(stdout, "已将口令哈希写入 %s（权限 0600）\n", path)
	fmt.Fprintln(stdout, "提示：哈希写入后向运行中的 kored 发送 SIGHUP 即生效（自动同步新哈希与 must_change 并吊销旧会话，无需重启）；忘记口令可再执行 `kored admin-password --set` 重置。")
	return exitOK
}

// resolveAdminPassword 按参数得到要写入的哈希与（仅 --generate 的）明文口令。
func resolveAdminPassword(opts adminPasswordOptions, stdout, stderr io.Writer) (string, string, int) {
	selected := 0
	for _, on := range []bool{opts.generate, opts.set, opts.hash != ""} {
		if on {
			selected++
		}
	}
	if selected != 1 {
		fmt.Fprintln(stderr, "必须且只能指定 --generate / --set / --hash 之一。")
		printAdminPasswordUsage(stderr)
		return "", "", exitConfig
	}
	if opts.hash != "" {
		if err := auth.ValidateHash(opts.hash); err != nil {
			fmt.Fprintf(stderr, "给定的哈希不可用: %v\n", err)
			return "", "", exitConfig
		}
		return opts.hash, "", exitOK
	}
	if opts.generate {
		plain, err := generateAdminPassword(adminPasswordLength)
		if err != nil {
			fmt.Fprintf(stderr, "生成随机口令失败: %v\n", err)
			return "", "", exitConfig
		}
		hash, err := auth.HashPassword(plain)
		if err != nil {
			fmt.Fprintf(stderr, "生成口令哈希失败: %v\n", err)
			return "", "", exitConfig
		}
		return hash, plain, exitOK
	}
	plain, ok := readNewPassword(opts, stderr)
	if !ok {
		return "", "", exitConfig
	}
	hash, err := auth.HashPassword(plain)
	if err != nil {
		fmt.Fprintf(stderr, "生成口令哈希失败: %v\n", err)
		return "", "", exitConfig
	}
	return hash, "", exitOK
}

// readNewPassword 读取 --set 的新口令：TTY 读两次，非 TTY 要求 --stdin。
func readNewPassword(opts adminPasswordOptions, stderr io.Writer) (string, bool) {
	if opts.fromStdin {
		plain, err := readPasswordFromStdin()
		if err != nil {
			fmt.Fprintf(stderr, "从标准输入读取口令失败: %v\n", err)
			return "", false
		}
		if plain == "" {
			fmt.Fprintln(stderr, "标准输入里的口令为空，未写入配置。")
			return "", false
		}
		return plain, true
	}
	if !adminTTY() {
		fmt.Fprintln(stderr, "当前标准输入不是终端，无法交互设置口令。")
		fmt.Fprintf(stderr, "请改用管道：`printf '%%s' \"$PW\" | kored admin-password --set --stdin`，\n")
		fmt.Fprintln(stderr, "或执行 `kored admin-password --generate` 让 kored 自己生成一个。")
		return "", false
	}
	return promptNewPassword(stderr)
}

// readPasswordFromStdin 从 --stdin 读取一行口令（去掉行尾换行）。
func readPasswordFromStdin() (string, error) {
	line, err := bufio.NewReader(adminStdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// promptNewPassword 交互式读两次口令并要求一致（不回显）。
func promptNewPassword(stderr io.Writer) (string, bool) {
	first, err := adminPrompt("请输入新的管理员口令（输入时不回显）: ", stderr)
	if err != nil {
		fmt.Fprintf(stderr, "读取口令失败: %v\n", err)
		return "", false
	}
	if strings.TrimSpace(first) == "" {
		fmt.Fprintln(stderr, "口令为空，已跳过设置。")
		return "", false
	}
	second, err := adminPrompt("请再输入一次确认: ", stderr)
	if err != nil {
		fmt.Fprintf(stderr, "读取口令失败: %v\n", err)
		return "", false
	}
	if first != second {
		fmt.Fprintln(stderr, "两次输入不一致，未写入配置；请重试。")
		return "", false
	}
	return first, true
}

// generateAdminPassword 用 crypto/rand 生成 n 字符口令（去掉易混淆的 0/o/1/l/I）。
func generateAdminPassword(n int) (string, error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	out := make([]byte, n)
	max := big.NewInt(int64(len(alphabet)))
	for i := 0; i < n; i++ {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = alphabet[idx.Int64()]
	}
	return string(out), nil
}

// ensureInitialAdminCredential 是 ADR-0055 的统一入口：install --package（打开 state.db
// 前）与 serve bootstrap 共用同一个函数。
//
// 凭据生命周期（2026-11-25 离线升级覆盖共享凭据文件事故修正）：
//   - 首次安装（无哈希、initialized 非 true、本实例凭据文件不存在）→ 生成一次性凭据并落盘；
//   - 更新 / 升级安装（已有哈希、initialized=true 或本实例凭据文件已存在）→ 完全跳过：
//     不改哈希、不写凭据文件、不置 must_change、不打印任何字节。
//
// 生成链路复用既有实现：generateAdminPassword(24) → auth.HashPassword(PBKDF2) →
// writeAdminBootstrapHash（原子 0600，同一次写里把 auth.must_change_password=true 落盘）。
//
// 凭据文件落点绑定本次实例的 state_dir（<state_dir>/initial-admin-credential）：
// 默认 portable profile 的 state_dir 就是 <install>/data，路径与文档一致；自定义
// state_dir 的隔离实例各写各的，绝不覆盖共享 install/data 下那份凭据文件。
//
// 双通道交付（G-30）：
//   - 一次性凭据文件（0600，gitignore，运行态资产，消费后删）——非 TTY 唯一交付载体；
//   - TTY 从当前终端打印一次明文 + 文件路径；非 TTY 绝不打印明文，只打印路径提示。
//
// 方向（待新 ADR 落地）：登录形态改为账号 + 密码，凭据文件将含账号与密码；当前实现
// 仍按既有单管理员口令交付，本函数不自行设计账号字段（G-11 / 等 ADR）。
func ensureInitialAdminCredential(path, stateDir string, stderr io.Writer) {
	if strings.TrimSpace(path) == "" {
		fmt.Fprintln(stderr, "提示：尚未设置管理员口令，且未解析到配置文件路径；请执行 `kored admin-password --generate --config <path>` 后重试。")
		return
	}
	if credentialInitialized(path, stateDir) {
		return // 更新安装：静默跳过，不生成、不覆盖、不打印
	}
	plain, err := generateAdminPassword(adminPasswordLength)
	if err != nil {
		fmt.Fprintf(stderr, "首启凭据生成失败（随机源不可用）: %v\n", err)
		return
	}
	hash, err := auth.HashPassword(plain)
	if err != nil {
		fmt.Fprintf(stderr, "首启凭据生成失败（哈希失败）: %v\n", err)
		return
	}
	if err := writeAdminBootstrapHash(path, hash); err != nil {
		// 写不进去就不打印明文：打印了也登不上，反而把一次性口令留在终端。
		fmt.Fprintf(stderr, "首启凭据写入配置失败: %v\n请手动执行 `kored admin-password --generate --config %s`（同样只显示一次）。\n", err, path)
		return
	}
	credPath, err := writeInitialAdminCredentialFile(stateDir, plain)
	if err != nil {
		fmt.Fprintf(stderr, "初始凭据文件写入失败: %v；请手动执行 `kored admin-password --generate --config %s`。\n", err, path)
		return
	}
	if firstRunTerminal() {
		fmt.Fprintln(stderr, "================ Kore 初始管理员凭据（只显示这一次）================")
		fmt.Fprintf(stderr, "管理员口令: %s\n", plain)
		fmt.Fprintf(stderr, "一次性凭据文件: %s（权限 0600，首次登录改密后自动删除）\n", credPath)
		fmt.Fprintln(stderr, "登录方式: 打开面板 → 输入上面的口令（单管理员，无用户名）；建议登录后设置一个新口令（可选，不强制）。")
		fmt.Fprintln(stderr, "======================================================================")
		return
	}
	// 非 TTY：绝不打印明文，只给路径（ADR-0055 §3 / G-30）。
	fmt.Fprintf(stderr, "初始管理员凭据已生成，请在自己的终端读取：%s（权限 0600）。\n", credPath)
	fmt.Fprintln(stderr, "打开面板输入该口令，建议登录后设置一个新口令（可选，不强制）；改密成功后该文件会自动删除。")
}

// credentialInitialized 判断本实例是否已初始化（= 更新安装，必须完全跳过凭据生成）。
// 三个判据任一为真即视为已初始化：
//  1. auth.admin_password_hash 非空；
//  2. auth.initialized 显式为 true（哈希缺失但已初始化的异常配置也要保护）；
//  3. 本实例凭据文件 <state_dir>/initial-admin-credential 已存在（历史事故里哈希判定
//     落在 --config、凭据文件却落在共享 InstallRoot()/data，导致升级覆盖；文件存在兜底）。
//
// 只读判定，不写任何文件；权威 YAML 解析由 config.Load 承担，这里走行级粗判避免对畸形配置写回。
func credentialInitialized(configPath, stateDir string) bool {
	if data, err := os.ReadFile(configPath); err == nil {
		doc := string(data)
		if hashPresentInConfig(doc) || authInitializedInConfig(doc) {
			return true
		}
	}
	return fileExists(initialAdminCredentialPath(stateDir))
}

// hashPresentInConfig 从原始 YAML 文本粗判是否已有非空 admin_password_hash。
func hashPresentInConfig(doc string) bool {
	return authKeyPresent(doc, "admin_password_hash", func(v string) bool {
		return v != "" && v != "null" && v != "~"
	})
}

// authInitializedInConfig 粗判 auth.initialized 是否为 true。
func authInitializedInConfig(doc string) bool {
	return authKeyPresent(doc, "initialized", func(v string) bool {
		return strings.EqualFold(v, "true")
	})
}

// authKeyPresent 在 YAML 文本里找 key，交给谓词判值；找不到返回 false。
func authKeyPresent(doc, key string, present func(string) bool) bool {
	for _, line := range strings.Split(doc, "\n") {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, key+":") {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(t, key+":"))
		return present(strings.Trim(v, "\"'"))
	}
	return false
}

// firstRunBootstrap 保留旧名字作薄封装（serve.go 不改），委托统一入口。
func firstRunBootstrap(cfg *config, stderr io.Writer) {
	if cfg == nil || cfg.snapshot == nil {
		return
	}
	// 凭据生命周期守门交给统一入口（哈希 / initialized / 凭据文件任一存在即跳过），
	// 不在这里重复判定——避免与 install 路径的判据漂移（离线升级覆盖事故根因）。
	ensureInitialAdminCredential(cfg.snapshot.Source, cfg.snapshot.Paths.StateDir, stderr)
	// 内存快照同步更新，避免本进程仍用旧快照启动鉴权。
	if snap, _, err := coreconfig.Load(coreconfig.Options{FlagPath: cfg.snapshot.Source}); err == nil {
		cfg.snapshot.Auth.AdminPasswordHash = snap.Auth.AdminPasswordHash
		cfg.snapshot.Auth.MustChangePassword = snap.Auth.MustChangePassword
		cfg.snapshot.Auth.Initialized = true
	}
}

// initialAdminCredentialPathFn 是凭据文件路径的注入点（测试可指向 t.TempDir()）。
// 生产落点绑定本次实例的 state_dir：<state_dir>/initial-admin-credential。
// 默认 portable profile 的 state_dir = <install>/data，路径与 ADR-0055 文档一致；
// 自定义 state_dir 的隔离实例各写各的，绝不覆盖共享 install/data 下那份凭据文件。
var initialAdminCredentialPathFn = func(stateDir string) string {
	base := strings.TrimSpace(stateDir)
	if base == "" {
		base = coreconfig.InstallRoot()
	}
	candidate := filepath.Join(base, "initial-admin-credential")
	// 兼容既有实例：state_dir 自定义（如 .kore-local-state）而凭据文件按旧口径落在
	// <install>/data 时，优先认已存在的那份，消费时删对文件、判定时不误判为首次安装。
	legacy := filepath.Join(coreconfig.InstallRoot(), "data", "initial-admin-credential")
	if candidate != legacy && fileExists(legacy) && !fileExists(candidate) {
		return legacy
	}
	return candidate
}

// initialAdminCredentialPath 返回本实例一次性凭据文件的绝对路径（运行态资产）。
func initialAdminCredentialPath(stateDir string) string {
	return initialAdminCredentialPathFn(stateDir)
}

// writeInitialAdminCredentialFile 把明文口令写入 0600 的一次性凭据文件。
func writeInitialAdminCredentialFile(stateDir, plain string) (string, error) {
	path := initialAdminCredentialPath(stateDir)
	if err := atomicWrite0600(path, plain+"\n"); err != nil {
		return "", err
	}
	return path, nil
}

// ConsumeInitialAdminCredential 在首登改密成功后删除一次性凭据文件（消费后删）。
// 文件不存在是幂等成功；删除失败不阻断改密结果。
func ConsumeInitialAdminCredential() {
	path := initialAdminCredentialPath("")
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "警告: 删除一次性凭据文件失败: %v\n", err)
	}
}

// writeAdminBootstrapHash 把哈希、auth.initialized=true 与 auth.must_change_password=true
// 在同一次原子写里落盘（ADR-0055 §2）。
func writeAdminBootstrapHash(path, hash string) error {
	if err := auth.ValidateHash(hash); err != nil {
		return err
	}
	doc, err := readAdminConfigFile(path)
	if err != nil {
		return err
	}
	doc = upsertAdminHash(doc, hash)
	doc = upsertAuthKey(doc, "initialized", "true")
	doc = upsertAuthKey(doc, "must_change_password", "true")
	return atomicWrite0600(path, doc)
}

// adminPasswordConfigPath 按与 serve 相同的语义解析配置文件并归一为绝对路径。
//
// 优先级完全交给 config.ResolvePath（KORE_CONFIG > --config > profile 默认），
// 这里只补 Abs：相对路径必须落到「当前工作目录」下的同一个文件，否则提示里
// 打印的路径和实际写的文件可能不是同一个。
func adminPasswordConfigPath(flagPath string) (string, error) {
	path := coreconfig.ResolvePath(flagPath)
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

// writeAdminPasswordHash 原子写入 auth.admin_password_hash，权限固定 0600。
func writeAdminPasswordHash(path, hash string) error {
	if err := auth.ValidateHash(hash); err != nil {
		return err
	}
	doc, err := readAdminConfigFile(path)
	if err != nil {
		return err
	}
	return atomicWrite0600(path, upsertAdminHash(doc, hash))
}

// readAdminConfigFile 读取现有配置文本；文件不存在按空文档处理。
func readAdminConfigFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// atomicWrite0600 写临时文件 → fsync → rename → fsync 目录；失败不留残片。
func atomicWrite0600(path, content string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建配置目录 %s 失败: %w", dir, err)
	}
	f, err := os.CreateTemp(dir, ".kored-admin-*.tmp")
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmp := f.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return fmt.Errorf("设置临时文件权限失败: %w", err)
	}
	if _, err := f.WriteString(content); err != nil {
		_ = f.Close()
		return fmt.Errorf("写临时文件失败: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("fsync 临时文件失败: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}
	if err := adminRenameFile(tmp, path); err != nil {
		return fmt.Errorf("替换配置文件失败: %w", err)
	}
	renamed = true
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// upsertAdminHash 在 YAML 文本里就地把 auth.admin_password_hash 设为 hash。
func upsertAdminHash(doc, hash string) string {
	return upsertAuthKey(doc, adminPasswordConfigKey, quoteYAML(hash))
}

// upsertAuthKey 在 YAML 文本的 auth: 段内就地把 key 设为 value。
//
// 走行级就地改写而不是 yaml 反序列化再序列化：配置文件里的注释与键顺序是
// 用户的，重排一次就等于偷偷改了他的文件。
func upsertAuthKey(doc, key, value string) string {
	entry := key + ": " + value
	lines := strings.Split(doc, "\n")
	if len(lines) == 1 && strings.TrimSpace(lines[0]) == "" {
		lines = nil
	}
	for i := 0; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != "auth:" {
			continue
		}
		end := len(lines)
		for j := i + 1; j < len(lines); j++ {
			trimmed := strings.TrimSpace(lines[j])
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if !strings.HasPrefix(lines[j], " ") && !strings.HasPrefix(lines[j], "\t") {
				end = j
				break
			}
		}
		indent := "  "
		for j := i + 1; j < end; j++ {
			if line := lines[j]; line != "" && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) {
				indent = line[:len(line)-len(strings.TrimLeft(line, " \t"))]
				break
			}
		}
		for k := i + 1; k < end; k++ {
			if strings.HasPrefix(strings.TrimSpace(lines[k]), key+":") {
				lines[k] = indent + entry
				return strings.Join(lines, "\n")
			}
		}
		pos := i + 1
		for k := i + 1; k < end; k++ {
			if strings.TrimSpace(lines[k]) != "" {
				pos = k + 1
			}
		}
		lines = append(lines, "")
		copy(lines[pos+1:], lines[pos:])
		lines[pos] = indent + entry
		return strings.Join(lines, "\n")
	}
	body := strings.TrimRight(doc, "\n")
	if body == "" {
		return "auth:\n  " + entry + "\n"
	}
	return body + "\n\nauth:\n  " + entry + "\n"
}

// quoteYAML 给哈希加双引号（哈希里只有 base64 与 $，转义规则足够）。
func quoteYAML(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

// passwordWriterFor 构造在线改口令的配置写回回调（注入 httpapi.PasswordWriter）。
//
// 复用 CLI admin-password 的原子写 0600 口径，保证运行中改口令与命令行改口令
// 落在同一个文件、同一套权限。不在这里改 snapshot：SIGHUP reload 会重读该
// 文件拿到新 hash，而 auth.Manager 的内存基准由 handler 的 SetPasswordHash
// 切换——配置、内存、reload 三者自然收敛，不引入手动改指针的竞态。
func passwordWriterFor(cfg config) func(string) error {
	// 首登改密成功后由 httpapi 回调删除一次性凭据文件（G-30 消费后删）。
	httpapi.SetCredentialConsumedHook(ConsumeInitialAdminCredential)
	path := ""
	if cfg.snapshot != nil {
		path = cfg.snapshot.Source
	}
	return func(hash string) error {
		if path == "" {
			return errors.New("未解析到配置文件路径，无法持久化新口令")
		}
		// 在线改密成功必须清 must_change 并落盘（与哈希同一次原子写），
		// 否则 SIGHUP 会把标志重新推回 true，首登永远改不完（ADR-0055 §4）。
		return writeAdminCredentialHash(path, hash, false)
	}
}

// writeAdminCredentialHash 原子写哈希 + initialized=true + must_change_password。
func writeAdminCredentialHash(path, hash string, mustChange bool) error {
	if err := auth.ValidateHash(hash); err != nil {
		return err
	}
	doc, err := readAdminConfigFile(path)
	if err != nil {
		return err
	}
	doc = upsertAdminHash(doc, hash)
	doc = upsertAuthKey(doc, "initialized", "true")
	doc = upsertAuthKey(doc, "must_change_password", strconv.FormatBool(mustChange))
	return atomicWrite0600(path, doc)
}
