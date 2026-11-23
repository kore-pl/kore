package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/platform"
)

// uninstallPaths 是一次卸载解析出的路径与生效 profile（ADR-0023：portable / fhs）。
type uninstallPaths struct {
	// stateDir 是状态目录（--purge 的删除目标）。
	stateDir string
	// installRoot 是 portable 安装根（手工删除提示用）。
	installRoot string
	// profile 是本次生效的零侵入 profile，决定是否真的存在 systemd unit / kore-* 用户。
	profile string
	// configPath 是本次生效配置文件的绝对路径（打印对齐用；空表示测试假实现未提供）。
	configPath string
}

// uninstallDeps 是卸载链的注入点（测试用假实现，绝不删真实用户 / unit）。
type uninstallDeps struct {
	cleanup    platform.Cleanup
	stdinIsTTY func() bool
	confirm    func(io.Reader, io.Writer) bool
	execPurge  func(purgeOp) error
	loadPaths  func(opts uninstallOptions) (uninstallPaths, error)
	removeAll  func(path string) error
	euid       func() int
	// isSelfService 判断"要清理的这个 unit 的主进程是不是我自己"（自卸载判定）。
	isSelfService func(unitName string) bool
	// selfRemoveUnit 为自卸载删 unit 文件但**不停自己**（disable → rm → daemon-reload）。
	selfRemoveUnit func(unitName, unitPath string) ([]string, error)
	// stopSelf 是自卸载的最后一步：--no-block 停自己（异步，不会中途杀掉正在卸载的进程）。
	stopSelf func(unitName string) error
	// binaryPath 返回当前可执行文件（root 下卸载时直接删掉它，不留手工步骤）。
	binaryPath func() (string, error)
	// removeFile 删除单个文件（注入点：测试绝不对真实二进制下手）。
	removeFile func(path string) error
}

// uninstallOptions 是 `kored uninstall` 的参数快照。
type uninstallOptions struct {
	dryRun    bool
	purge     bool
	yes       bool
	keepUnit  bool
	keepUsers bool
	unitName  string
	unitDir   string
	prefix    string
	config    string
	stateDir  string
}

// defaultUninstallDeps 返回生产实现。
func defaultUninstallDeps() uninstallDeps {
	return uninstallDeps{
		cleanup:    platform.NewCleanup(),
		stdinIsTTY: func() bool { return platform.IsTerminal(os.Stdin.Fd()) },
		confirm: func(in io.Reader, out io.Writer) bool {
			fmt.Fprint(out, "确认执行以上删除操作？[y/N] ")
			var answer string
			fmt.Fscanln(in, &answer)
			return answer == "y" || answer == "Y" || answer == "yes"
		},
		execPurge: executePurgeOp,
		loadPaths: func(opts uninstallOptions) (uninstallPaths, error) {
			snap, _, err := coreconfig.Load(coreconfig.Options{
				FlagPath: opts.config,
				StateDir: opts.stateDir,
				Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			if err != nil {
				return uninstallPaths{}, err
			}
			configPath := coreconfig.ResolvePath(opts.config)
			if abs, absErr := filepath.Abs(configPath); absErr == nil {
				configPath = abs
			}
			return uninstallPaths{
				stateDir:    snap.Paths.StateDir,
				installRoot: coreconfig.InstallRoot(),
				profile:     snap.Profile,
				configPath:  configPath,
			}, nil
		},
		removeAll: os.RemoveAll,
		euid:      os.Geteuid,
		isSelfService: func(unitName string) bool {
			pid, err := privilege.UnitMainPID(unitName)
			return err == nil && pid > 0 && pid == os.Getpid()
		},
		selfRemoveUnit: privilege.DisableAndRemoveUnit,
		stopSelf:       privilege.StopUnitNoBlock,
		binaryPath:     os.Executable,
		removeFile:     os.Remove,
	}
}

// runUninstall 执行 `kored uninstall`。
func runUninstall(args []string, stdout, stderr io.Writer) int {
	return runUninstallWith(args, stdout, stderr, defaultUninstallDeps())
}

// runUninstallWith 是可测试实现。
func runUninstallWith(args []string, stdout, stderr io.Writer, deps uninstallDeps) int {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var opts uninstallOptions
	fs.BoolVar(&opts.dryRun, "dry-run", false, "只打印将执行的动作，不做任何变更")
	fs.BoolVar(&opts.purge, "purge", false, "删除状态目录，并执行账本里可回滚的结构化 purge_op（需 --yes）")
	fs.BoolVar(&opts.yes, "yes", false, "非交互确认（CI / 脚本必须显式给）")
	fs.BoolVar(&opts.keepUnit, "keep-service", false, "保留 systemd unit（只清用户与状态）")
	fs.BoolVar(&opts.keepUsers, "keep-users", false, "保留 kore-* 系统用户")
	fs.StringVar(&opts.unitName, "unit-name", "kore.service", "systemd unit 名")
	fs.StringVar(&opts.unitDir, "unit-dir", "/etc/systemd/system", "systemd unit 目录")
	fs.StringVar(&opts.prefix, "user-prefix", "kore-", "要清理的系统用户前缀")
	fs.StringVar(&opts.config, "config", "", "配置文件路径（缺省按 profile 解析）")
	fs.StringVar(&opts.stateDir, "state-dir", "", "状态目录（覆盖配置）")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	paths, err := deps.loadPaths(opts)
	if err != nil {
		fmt.Fprintf(stderr, "uninstall: 解析路径失败: %v\n", err)
		return exitConfig
	}
	stateDir, installRoot := paths.stateDir, paths.installRoot
	portable := paths.profile == coreconfig.ProfilePortable
	unitPath := platform.UnitFileName(opts.unitDir, opts.unitName)
	// 与 install / status 同一行格式：卸载前先让"配置 + 状态目录"可见，避免删错库。
	if paths.configPath != "" {
		printCLITargets(stdout, cliTargets{
			ConfigPath:   paths.configPath,
			StateDir:     stateDir,
			Profile:      paths.profile,
			ConfigExists: fileExists(paths.configPath),
		})
	}
	fmt.Fprintf(stdout, "[INFO] 安装根：%s\n", installRoot)
	fmt.Fprintf(stdout, "[INFO] 状态目录：%s\n", stateDir)
	fmt.Fprintf(stdout, "[INFO] profile：%s\n", paths.profile)
	if portable {
		// portable 不创建 unit / 系统用户（ADR-0023）：列 /etc/systemd/system/... 只会误导。
		fmt.Fprintln(stdout, "[INFO] unit：不适用（portable 模式：不会创建 systemd unit，也不创建 kore-* 用户）")
	} else {
		fmt.Fprintf(stdout, "[INFO] unit：%s（%s）\n", unitPath, keepLabel(opts.keepUnit))
		fmt.Fprintf(stdout, "[INFO] 系统用户前缀：%s（%s）\n", opts.prefix, keepLabel(opts.keepUsers))
	}
	if opts.dryRun {
		fmt.Fprintln(stdout, "[DRY-RUN] 以下仅为计划，不做任何变更")
	}

	// 安全阀 1（先确认意图）：破坏性执行必须有 --yes 或交互确认；非 TTY 且无 --yes → 零变更退出 2。
	if !opts.dryRun && !opts.yes {
		if deps.stdinIsTTY() {
			if !deps.confirm(os.Stdin, stdout) {
				fmt.Fprintln(stdout, "已取消（未做任何变更）")
				return exitOK
			}
		} else {
			fmt.Fprintln(stderr, "uninstall: 非交互环境拒绝执行破坏性清理；确认后加 --yes（或先 --dry-run 看计划）")
			return exitConfig
		}
	}
	// 安全阀 2（再校验权限）：非 root 且要动 systemd / 系统用户 → 不中止，改为"部分完成"：
	// 宿主侧跳过、安装目录内能清的照清，最后仍以 6 退出（绝不返回 0 谎报成功）。
	// 只有显式 --keep-service --keep-users（声明"宿主侧我自己处理"）才允许非 root 全绿。
	needRoot := !opts.keepUnit || !opts.keepUsers
	partial := false
	if !opts.dryRun && needRoot && deps.euid() != 0 {
		partial = true
		fmt.Fprintln(stderr, "uninstall: 当前不是 root：清理 systemd unit 与 kore-* 用户需要 root，"+
			"本次跳过这两步、继续清理安装目录内可清理的内容；补做请用 `sudo kored uninstall`")
	}
	// 自卸载判定（模型切到 root 服务后的常态）：当前进程就是 unit 的 MainPID。
	// 此时 **不能** 让 platform.Cleanup 先 `systemctl stop`——那会把正在卸载的自己杀掉，
	// 卸载变成"删一半"。改为：先 disable + 删 unit + daemon-reload，文件全删完最后再停自己。
	selfService := !opts.dryRun && !opts.keepUnit && !partial && deps.euid() == 0 &&
		deps.isSelfService != nil && deps.isSelfService(opts.unitName)
	if selfService {
		fmt.Fprintf(stdout, "[INFO] 自卸载模式：本进程就是 %s 的 MainPID，unit 清理改为「先删文件、最后 --no-block 停自己」\n", opts.unitName)
	}
	var done, skippedRoot []string
	failed := 0

	// 1–4. systemd unit：stop → disable → rm → daemon-reload（幂等）。
	switch {
	case opts.keepUnit:
		fmt.Fprintln(stdout, "[UNIT] --keep-service：跳过（unit 仍会留在 /etc/systemd/system）")
	case partial:
		skippedRoot = append(skippedRoot, "systemd unit 清理（"+unitPath+"）")
		fmt.Fprintf(stdout, "[SKIP] systemd unit：需要 root，本次跳过（补做：sudo kored uninstall --yes）\n")
	case selfService && deps.selfRemoveUnit != nil:
		actions, err := deps.selfRemoveUnit(opts.unitName, unitPath)
		for _, action := range actions {
			fmt.Fprintf(stdout, "[UNIT] %s\n", action)
		}
		if err != nil {
			fmt.Fprintf(stderr, "[FAIL] 自卸载 unit 清理失败: %v\n", err)
			failed++
		} else {
			done = append(done, "systemd unit 已清理（自卸载：停止动作留到最后）")
		}
	default:
		cleanup, err := deps.cleanup.RemoveServiceUnit(opts.unitName, unitPath, opts.dryRun)
		if err != nil {
			fmt.Fprintf(stderr, "[FAIL] systemd unit 清理失败: %v\n", err)
			failed++
		} else {
			for _, action := range cleanup.Actions {
				fmt.Fprintf(stdout, "[UNIT] %s\n", action)
			}
			done = append(done, "systemd unit 已清理")
		}
	}

	// 5. 系统用户：按 /etc/passwd 前缀扫描，不依赖 state（可能已被删）。
	switch {
	case opts.keepUsers:
		fmt.Fprintln(stdout, "[USER] --keep-users：跳过（kore-* 用户仍留在 /etc/passwd）")
	case partial:
		skippedRoot = append(skippedRoot, "kore-* 用户清理（前缀 "+opts.prefix+"）")
		fmt.Fprintln(stdout, "[SKIP] kore-* 用户：需要 root，本次跳过（补做：sudo kored uninstall --yes）")
	default:
		accounts, err := deps.cleanup.RemoveAccountsByPrefix(opts.prefix, opts.dryRun)
		if err != nil {
			fmt.Fprintf(stderr, "[FAIL] kore-* 用户清理失败: %v\n", err)
			failed++
		} else {
			fmt.Fprintf(stdout, "[USER] 命中 %d 个账户：%v\n", len(accounts.Matched), accounts.Matched)
			for _, name := range accounts.Removed {
				fmt.Fprintf(stdout, "[USER] userdel -r %s\n", name)
			}
			for _, name := range accounts.Failed {
				fmt.Fprintf(stderr, "[FAIL] userdel %s 失败（见上方 stderr）\n", name)
				failed++
			}
			done = append(done, fmt.Sprintf("kore-* 用户已清理（%d 个）", len(accounts.Removed)))
		}
	}

	// 6. 账本：只列清单，默认不执行回滚。
	entries, skipped, err := readChanges(changesPath(stateDir))
	if err != nil {
		fmt.Fprintf(stderr, "[WARN] 读取变更账本失败: %v\n", err)
	} else {
		fmt.Fprintf(stdout, "[CHANGES] %s：%d 条记录（坏行 %d）\n", changesPath(stateDir), len(entries), skipped)
		for i, entry := range entries {
			fmt.Fprintf(stdout, "[CHANGES] %d) %s %s.%s → %s（可回滚=%t）\n",
				i+1, entry.TS, entry.Plugin, entry.Action, entry.Target, entry.Reversible)
			if entry.PurgeOp != nil {
				fmt.Fprintf(stdout, "           回滚：%s\n", purgeOpString(*entry.PurgeOp))
			}
		}
		if len(entries) > 0 {
			fmt.Fprintln(stdout, "[CHANGES] 默认**不自动回滚**（用户主动施加的系统变更）；确认回滚请用 --purge --yes")
		}
	}

	// 7. --purge：执行结构化 purge_op + 删状态目录。
	purged := 0
	stateRemoved := false
	if opts.purge {
		for _, entry := range entries {
			if !entry.Reversible || entry.PurgeOp == nil {
				continue
			}
			if opts.dryRun {
				fmt.Fprintf(stdout, "[DRY-RUN] 将执行 purge: %s\n", purgeOpString(*entry.PurgeOp))
				continue
			}
			if err := deps.execPurge(*entry.PurgeOp); err != nil {
				fmt.Fprintf(stderr, "[FAIL] purge 失败（%s）：%v\n", entry.Target, err)
				failed++
				continue
			}
			purged++
			fmt.Fprintf(stdout, "[PURGE] 已回滚：%s\n", entry.Target)
		}
		if stateDir == "" || stateDir == "/" {
			fmt.Fprintln(stderr, "[FAIL] 拒绝删除可疑状态目录："+stateDir)
			failed++
		} else if opts.dryRun {
			fmt.Fprintf(stdout, "[DRY-RUN] 将删除状态目录：%s\n", stateDir)
		} else if err := deps.removeAll(stateDir); err != nil {
			fmt.Fprintf(stderr, "[FAIL] 删除状态目录失败: %v\n", err)
			failed++
		} else {
			stateRemoved = true
			fmt.Fprintf(stdout, "[PURGE] 已删除状态目录：%s\n", stateDir)
		}
	} else {
		fmt.Fprintf(stdout, "[PURGE] 未指定 --purge：状态目录保留（%s）\n", stateDir)
	}

	// 7.5 二进制：root 下直接删自己（Linux 下运行中的 inode 仍可执行，删完不影响本进程收尾）。
	if !opts.dryRun && deps.euid() == 0 && deps.binaryPath != nil && deps.removeFile != nil {
		if exe, err := deps.binaryPath(); err != nil {
			fmt.Fprintf(stderr, "[WARN] 解析当前可执行文件失败，跳过二进制删除: %v\n", err)
		} else {
			if resolved, evalErr := filepath.EvalSymlinks(exe); evalErr == nil {
				exe = resolved
			}
			if err := deps.removeFile(exe); err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(stderr, "[FAIL] 删除二进制 %s 失败: %v\n", exe, err)
				failed++
			} else {
				fmt.Fprintf(stdout, "[BIN] rm %s\n", exe)
				done = append(done, "二进制已删除："+exe)
			}
		}
	}

	// 局部进度：供"部分完成"摘要逐条说明已做 / 跳过。
	if len(entries) > 0 {
		done = append(done, fmt.Sprintf("变更账本已列出（%d 条）", len(entries)))
	}
	if purged > 0 {
		done = append(done, fmt.Sprintf("已回滚 %d 个结构化 purge_op", purged))
	}
	switch {
	case stateRemoved:
		done = append(done, "状态目录已删除："+stateDir)
	case opts.purge:
		done = append(done, "状态目录删除失败或被拒："+stateDir)
	default:
		done = append(done, "状态目录保留（未指定 --purge）："+stateDir)
	}

	// 8. 剩余手工步骤。
	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, "还需要你手动处理：")
	fmt.Fprintf(stdout, "  1) 删除安装目录（可选；删掉后 Kore 自身状态已不在系统任何路径）：rm -rf %s\n", installRoot)
	if len(entries) > 0 {
		fmt.Fprintf(stdout, "  2) 宿主变更账本有 %d 条记录：带 --purge --yes 可回滚；否则按上面列出的操作手工处理\n", len(entries))
	}
	if opts.keepUnit {
		fmt.Fprintln(stdout, "  3) 你选择了 --keep-service：/etc/systemd/system/kore.service 仍在")
	}
	if opts.keepUsers {
		fmt.Fprintln(stdout, "  4) 你选择了 --keep-users：kore-* 用户仍在 /etc/passwd")
	}

	// 9. 部分完成（宿主侧因权限跳过）：明确摘要 + 补做方式，但**不返回 0**。
	if partial {
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "[摘要] 卸载部分完成：宿主侧（systemd unit / kore-* 用户）因权限跳过，本次未全部完成")
		fmt.Fprintf(stdout, "  已做：%s\n", strings.Join(done, "、"))
		fmt.Fprintf(stdout, "  因权限跳过：%s\n", strings.Join(skippedRoot, "、"))
		if failed > 0 {
			fmt.Fprintf(stdout, "  另有 %d 项失败（见上方 [FAIL]）\n", failed)
		}
		hint := "sudo kored uninstall --yes"
		if !opts.purge {
			hint += " --purge（要连状态目录一起删时加）"
		}
		fmt.Fprintf(stdout, "  怎么补做（拿到 root 后重跑，幂等）：%s\n", hint)
		fmt.Fprintln(stdout, "  只想清安装目录、宿主侧自己处理：kored uninstall --yes --keep-service --keep-users（该写法返回 0）")
		fmt.Fprintln(stdout, "  说明：以系统服务运行时不需要本步骤——内核自己就是 root，直接自卸载（无需 sudo）；")
		fmt.Fprintln(stdout, "        当前为非 root 裸跑，请改用服务自卸载：由运行中的 kore.service 执行 `kored uninstall --yes [--purge]`")
		fmt.Fprintln(stdout, "退出码 6 = 环境不满足（权限不足），脚本/CI 不得当作成功")
		return exitEnv
	}

	if failed > 0 {
		fmt.Fprintf(stderr, "uninstall: 完成但有 %d 项失败\n", failed)
		return 1
	}
	fmt.Fprintln(stdout, "[OK] uninstall 完成（可重复执行：幂等）")
	// 10. 自卸载的**最后一步**：文件全部处理完，才异步停掉自己。
	// 顺序不可颠倒：先停自己会让后面的删 unit / 删二进制 / purge 全部做不成。
	if selfService && deps.stopSelf != nil {
		fmt.Fprintf(stdout, "[UNIT] 提交停止：systemctl --no-block stop %s（本进程随后由 systemd 结束，输出已全部写完）\n", opts.unitName)
		if err := deps.stopSelf(opts.unitName); err != nil {
			fmt.Fprintf(stderr, "[FAIL] 提交停止失败: %v（文件已清理完成，可手工 systemctl stop %s）\n", err, opts.unitName)
			return 1
		}
	}
	return exitOK
}

// keepLabel 把 --keep-* 布尔值转成人话。
func keepLabel(keep bool) string {
	if keep {
		return "保留"
	}
	return "清理"
}
