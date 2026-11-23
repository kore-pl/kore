package main

import (
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/platform"
)

// uninstallDeps 是卸载链的注入点（测试用假实现，绝不删真实用户 / unit）。
type uninstallDeps struct {
	cleanup    platform.Cleanup
	stdinIsTTY func() bool
	confirm    func(io.Reader, io.Writer) bool
	execPurge  func(purgeOp) error
	loadPaths  func(opts uninstallOptions) (stateDir string, installRoot string, err error)
	removeAll  func(path string) error
	euid       func() int
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
		loadPaths: func(opts uninstallOptions) (string, string, error) {
			snap, _, err := coreconfig.Load(coreconfig.Options{
				FlagPath: opts.config,
				StateDir: opts.stateDir,
				Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			if err != nil {
				return "", "", err
			}
			return snap.Paths.StateDir, coreconfig.InstallRoot(), nil
		},
		removeAll: os.RemoveAll,
		euid:      os.Geteuid,
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

	stateDir, installRoot, err := deps.loadPaths(opts)
	if err != nil {
		fmt.Fprintf(stderr, "uninstall: 解析路径失败: %v\n", err)
		return exitConfig
	}
	unitPath := platform.UnitFileName(opts.unitDir, opts.unitName)
	fmt.Fprintf(stdout, "[INFO] 安装根：%s\n", installRoot)
	fmt.Fprintf(stdout, "[INFO] 状态目录：%s\n", stateDir)
	fmt.Fprintf(stdout, "[INFO] unit：%s（%s）\n", unitPath, keepLabel(opts.keepUnit))
	fmt.Fprintf(stdout, "[INFO] 系统用户前缀：%s（%s）\n", opts.prefix, keepLabel(opts.keepUsers))
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
	// 安全阀 2（再校验权限）：非 root 且要动 systemd / 系统用户 → 拒绝（ADR-0018 / G-16）。
	if !opts.dryRun && deps.euid() != 0 && (!opts.keepUnit || !opts.keepUsers) {
		fmt.Fprintln(stderr, "uninstall: 清理 systemd unit 与 kore-* 用户需要 root：请用 `sudo kored uninstall`，"+
			"或加 --keep-service --keep-users 只清状态目录")
		return exitEnv
	}

	failed := 0

	// 1–4. systemd unit：stop → disable → rm → daemon-reload（幂等）。
	if !opts.keepUnit {
		cleanup, err := deps.cleanup.RemoveServiceUnit(opts.unitName, unitPath, opts.dryRun)
		if err != nil {
			fmt.Fprintf(stderr, "[FAIL] systemd unit 清理失败: %v\n", err)
			failed++
		} else {
			for _, action := range cleanup.Actions {
				fmt.Fprintf(stdout, "[UNIT] %s\n", action)
			}
		}
	} else {
		fmt.Fprintln(stdout, "[UNIT] --keep-service：跳过（unit 仍会留在 /etc/systemd/system）")
	}

	// 5. 系统用户：按 /etc/passwd 前缀扫描，不依赖 state（可能已被删）。
	if !opts.keepUsers {
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
		}
	} else {
		fmt.Fprintln(stdout, "[USER] --keep-users：跳过（kore-* 用户仍留在 /etc/passwd）")
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
			fmt.Fprintf(stdout, "[PURGE] 已删除状态目录：%s\n", stateDir)
		}
	} else {
		fmt.Fprintf(stdout, "[PURGE] 未指定 --purge：状态目录保留（%s）\n", stateDir)
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

	if failed > 0 {
		fmt.Fprintf(stderr, "uninstall: 完成但有 %d 项失败\n", failed)
		return 1
	}
	fmt.Fprintln(stdout, "[OK] uninstall 完成（可重复执行：幂等）")
	return exitOK
}

// keepLabel 把 --keep-* 布尔值转成人话。
func keepLabel(keep bool) string {
	if keep {
		return "保留"
	}
	return "清理"
}
