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
	"strings"

	"github.com/pengtang1024/kore/internal/core/auth"
	coreconfig "github.com/pengtang1024/kore/internal/core/config"
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
	if err := writeAdminPasswordHash(path, hash); err != nil {
		fmt.Fprintf(stderr, "写入配置失败: %v\n", err)
		return exitConfig
	}
	if plain != "" {
		fmt.Fprintf(stdout, "\n管理员口令（只显示这一次，请立即保存）：%s\n", plain)
	}
	fmt.Fprintf(stdout, "已将口令哈希写入 %s（权限 0600）\n", path)
	fmt.Fprintln(stdout, "提示：哈希写入后需**重启 kored** 才生效（运行中的进程只在启动时读取口令哈希；SIGHUP 热更只更新配置快照）；重启会踢掉旧会话；忘记口令可再执行 `kored admin-password --set` 重置。")
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

// firstRunBootstrap 在缺管理员口令时生成一次性初始凭据（对齐宝塔 / 1Panel 的安装期凭据模型）。
//
// 口径（ADR-0043：面板必须有登录页，登录后所有操作免密）：
//   - 哈希为空 = 从未初始化。此时生成 24 字符随机口令，PBKDF2 哈希**原子写回
//     serve 自己解析的那个配置文件**（0600），并把 auth.initialized 置 true；
//     内存快照同步更新，因此**本次启动即可登录**，不需要二次重启。
//   - 明文只在 stderr 是终端时打印一次；配置、state、日志里只有哈希。
//     journald 会长期留存输出，所以非 TTY 不生成、不打明文。
//   - 非 TTY（systemd / 重定向）只给不含秘密的 CLI 指引：用户在自己终端执行
//     `kored admin-password --generate`，由该命令打印一次。
//   - 已有哈希的实例：直接返回，一行不打、一个字节不写（升级行为不变）。
//
// 无用户名：kore 是单管理员（G-11 不做多用户 RBAC），登录体只有口令。宝塔 /
// 1Panel 的用户名属于其账号体系；这里补用户名既不增加安全性（用户名不是秘密，
// 限速已覆盖爆破），又会破坏既有 `{password}` 登录契约与前端登录页，故按最小
// 改动只保留口令。
func firstRunBootstrap(cfg *config, stderr io.Writer) {
	if cfg == nil || cfg.snapshot == nil {
		return
	}
	if strings.TrimSpace(cfg.snapshot.Auth.AdminPasswordHash) != "" {
		return
	}
	path := cfg.snapshot.Source
	if path == "" {
		// 理论上不会发生（loadConfig 总会带 Source）：没有落点就不生成，
		// 更不能打印一个无法保存的凭据。
		fmt.Fprintln(stderr, "提示：尚未设置管理员口令，且未解析到配置文件路径；请执行 `kored admin-password --generate --config <path>` 后重启。")
		return
	}
	if !firstRunTerminal() {
		fmt.Fprintln(stderr, "提示：本实例尚未设置管理员口令。当前输出不是终端（systemd/journald 或重定向），")
		fmt.Fprintln(stderr, "为避免一次性口令被日志长期留存，kored 不在这里自动生成。请在自己的终端执行一次：")
		fmt.Fprintf(stderr, "  kored admin-password --generate --config %s\n", path)
		fmt.Fprintln(stderr, "该命令把哈希写入同一个配置文件，并只显示一次初始口令；然后重启 kored 登录。")
		return
	}

	plain, err := generateAdminPassword(adminPasswordLength)
	if err != nil {
		fmt.Fprintf(stderr, "首启凭据生成失败（随机源不可用）: %v；请手动执行 `kored admin-password --generate --config %s`\n", err, path)
		return
	}
	hash, err := auth.HashPassword(plain)
	if err != nil {
		fmt.Fprintf(stderr, "首启凭据生成失败（哈希失败）: %v；请手动执行 `kored admin-password --generate --config %s`\n", err, path)
		return
	}
	if err := writeAdminBootstrapHash(path, hash); err != nil {
		// 写不进去就不打印明文：打印了也登不上，反而把一次性口令留在终端。
		fmt.Fprintf(stderr, "首启凭据写入配置失败: %v\n请手动执行 `kored admin-password --generate --config %s`（同样只显示一次）。\n", err, path)
		return
	}
	cfg.snapshot.Auth.AdminPasswordHash = hash
	cfg.snapshot.Auth.Initialized = true

	if cfg.Addr != "" {
		fmt.Fprintf(stderr, "\n面板地址: http://%s/\n", cfg.Addr)
	}
	fmt.Fprintln(stderr, "================ Kore 首启凭据（只显示这一次）================")
	fmt.Fprintf(stderr, "管理员口令: %s\n", plain)
	fmt.Fprintln(stderr, "登录方式: 打开面板 → 输入上面的口令（单管理员，无用户名）；登录后所有操作免密。")
	fmt.Fprintf(stderr, "已写入 %s：只存 PBKDF2 哈希，权限 0600；重启或再次启动都不会再显示这个口令。\n", path)
	fmt.Fprintf(stderr, "再次查看: 口令只存哈希、无法再取；需要轮换请执行 kored admin-password --set --config %s（CLI 重置，不走 Web 找回、不发邮件；改凭据会吊销所有会话）\n", path)
	fmt.Fprintln(stderr, "==============================================================")
}

// writeAdminBootstrapHash 把哈希与 auth.initialized=true 一次原子写入配置文件。
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
