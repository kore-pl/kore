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
	path := coreconfig.ResolvePath(opts.config)
	if err := writeAdminPasswordHash(path, hash); err != nil {
		fmt.Fprintf(stderr, "写入配置失败: %v\n", err)
		return exitConfig
	}
	if plain != "" {
		fmt.Fprintf(stdout, "\n管理员口令（只显示这一次，请立即保存）：%s\n", plain)
	}
	fmt.Fprintf(stdout, "已将口令哈希写入 %s（权限 0600）\n", path)
	fmt.Fprintln(stdout, "提示：重启 kored 后生效；忘记口令可再执行 `kored admin-password --set` 重置。")
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

// firstRunAuthGuide 在缺管理员口令时给出可操作提示：
// stdin 是 TTY 就直接引导交互设置；非 TTY 只提示、不阻塞（systemd 场景）。
func firstRunAuthGuide(cfg *config, stderr io.Writer) {
	if cfg == nil || cfg.snapshot == nil {
		return
	}
	if strings.TrimSpace(cfg.snapshot.Auth.AdminPasswordHash) != "" {
		return
	}
	if !adminTTY() {
		fmt.Fprintln(stderr, "提示：还没有管理员口令，面板将无法登录（非交互环境不阻塞启动）。")
		fmt.Fprintln(stderr, "  执行 `kored admin-password --generate` 生成一个，或 `kored admin-password --set` 自己设置；")
		fmt.Fprintln(stderr, "  systemd / 容器部署请先离线设置口令，再重启 kored。")
		return
	}
	fmt.Fprintln(stderr, "还没有管理员口令，面板无法登录。现在设置一个（直接回车跳过，稍后用 `kored admin-password --generate`）。")
	plain, ok := promptNewPassword(stderr)
	if !ok {
		return
	}
	hash, err := auth.HashPassword(plain)
	if err != nil {
		fmt.Fprintf(stderr, "生成口令哈希失败: %v\n", err)
		return
	}
	path := cfg.snapshot.Source
	if strings.TrimSpace(path) == "" {
		path = coreconfig.ResolvePath(cfg.opts.config)
	}
	if err := writeAdminPasswordHash(path, hash); err != nil {
		fmt.Fprintf(stderr, "写入配置失败: %v\n", err)
		return
	}
	cfg.reload()
	fmt.Fprintf(stderr, "已写入 %s（权限 0600），本次启动即用新口令登录。\n", path)
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
//
// 走行级就地改写而不是 yaml 反序列化再序列化：配置文件里的注释与键顺序是
// 用户的，重排一次就等于偷偷改了他的文件。
func upsertAdminHash(doc, hash string) string {
	entry := adminPasswordConfigKey + ": " + quoteYAML(hash)
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
			if strings.HasPrefix(strings.TrimSpace(lines[k]), adminPasswordConfigKey+":") {
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
