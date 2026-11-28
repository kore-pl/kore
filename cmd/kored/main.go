// Command kored 是 kore 薄壳内核的唯一入口。
//
// 无子命令等价 `kored serve`；子命令用标准库 flag 手写分发（不引 cobra / urfave）。
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// version 由构建参数注入（make build 的 -X main.version=...）。
// 默认值与 Makefile 的 VERSION 必须一致（make version-check 断言）：否则 `go run` 与
// `make build` 报不同版本，插件安装时 requires_kore 判定跟着漂。0.1.1 = 首个含 file_write 的内核版本。
var version = "0.1.5"

// 退出码码表（DATA-MODEL §7 / ARCHITECTURE §6.1），子命令与 serve 共用。
const (
	exitOK     = 0
	exitConfig = 2
	exitState  = 3
	exitStore  = 4
	exitListen = 5
	exitEnv    = 6
)

// main 只负责把退出码交给 shell，逻辑全部在 run 里（便于单测与复盘）。
func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run 分发子命令；未知子命令按配置错误处理（退出码 2）。
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return runServeFinalizingUpgrade(nil, stderr)
	}
	switch args[0] {
	case "serve":
		return runServeFinalizingUpgrade(args[1:], stderr)
	case "version":
		fmt.Fprintf(stdout, "kored %s\n协议 %s\n", version, pluginapi.Protocol)
		return exitOK
	case "install":
		return runInstall(args[1:], stdout, stderr)
	case "audit":
		return runAudit(args[1:], stdout, stderr)
	case "uninstall":
		return runUninstall(args[1:], stdout, stderr)
	case "status":
		return runStatus(args[1:], stdout, stderr)
	case "upgrade":
		return runUpgrade(args[1:], stdout, stderr)
	case "restart":
		return runRestart(args[1:], stdout, stderr)
	case "admin-password":
		return runAdminPassword(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		printUsage(stdout)
		return exitOK
	default:
		fmt.Fprintf(stderr, "kored: 未知子命令 %q\n", args[0])
		printUsage(stderr)
		return exitConfig
	}
}

// runServeFinalizingUpgrade 在 serve 之前把上一次 `kored upgrade` 的 pending 标记闭环。
//
// 为什么放在这里：升级是"旧进程替换二进制 → 提交重启 → 新进程启动"三段式，
// 只有新进程能证明新版本已生效。该调用非阻塞、绝不阻断启动（标记不存在时零副作用）。
func runServeFinalizingUpgrade(args []string, stderr io.Writer) int {
	finalizePendingUpgrade(stderr, defaultUpgradeDeps())
	return runServe(args, stderr)
}

// printUsage 打印子命令清单。
func printUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored <子命令> [参数]")
	fmt.Fprintln(w, "  serve     启动主壳（无子命令时默认）")
	fmt.Fprintln(w, "  version   打印版本与协议版本")
	fmt.Fprintln(w, "  install   安装插件（--package 单包安装；--scenario 场景预设未实现，M2）")
	fmt.Fprintln(w, "  audit     查询审计记录（--since 必填，--action 过滤，--csv 导出）")
	fmt.Fprintln(w, "  uninstall 卸载链：清 systemd unit / kore-* 用户 / 变更账本（ADR-0023；--dry-run 看计划）")
	fmt.Fprintln(w, "  status    打印生效配置 / 状态目录 / 实例 healthz 与 state.db 持有者 pid")
	fmt.Fprintln(w, "  upgrade   自升级 / 回滚（--bin + --sha256 先校验再原子替换；--rollback / --verify）")
	fmt.Fprintln(w, "  restart   自重启（--reason + --yes/--confirm；同 HTTP 入口共用原语与审计）")
	fmt.Fprintln(w, "  admin-password 设置管理员口令（--generate / --set [--stdin] / --hash），原子写配置且权限 0600")
	fmt.Fprintln(w, "  help      打印本帮助")
	fmt.Fprintln(w, "退出码: 0 正常 / 2 配置 / 3 状态目录或锁 / 4 存储或 schema / 5 监听绑定 / 6 环境不满足")
}
