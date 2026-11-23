package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
)

// statusProbeTimeout 是 healthz 探测上限：只回答"在不在"，不阻塞用户。
const statusProbeTimeout = 2 * time.Second

// runStatus 打印"正在运行的 Kore 到底用哪个配置 / 哪个状态库"，让 CLI 能抄对 --config。
//
// 与 install 不同，status 是只读诊断：配置文件不存在不算错误，如实打印"不存在"。
func runStatus(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configPath, stateDir string
	fs.StringVar(&configPath, "config", "", "配置文件路径（缺省按 profile 解析）")
	fs.StringVar(&stateDir, "state-dir", "", "状态目录（覆盖配置）")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}
	targets, err := resolveCLITargets(configPath, stateDir, true)
	if err != nil {
		fmt.Fprintf(stderr, "status: %v\n", err)
		return exitConfig
	}
	printCLITargets(stdout, targets)
	fmt.Fprintf(stdout, "profile: %s\n", targets.Profile)
	snap, _, err := coreconfig.Load(coreconfig.Options{
		FlagPath: configPath, StateDir: stateDir,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		fmt.Fprintf(stderr, "status: 配置错误: %v\n", err)
		return exitConfig
	}
	where, reachable, detail := probeHealthz(snap.Server.Addr, snap.Server.Socket)
	pid := readStatePID(targets.StateDir)
	switch {
	case reachable && pid > 0:
		fmt.Fprintf(stdout, "实例: 运行中（healthz 200 @ %s，state.db 持有者 pid=%d）\n", where, pid)
	case reachable:
		fmt.Fprintf(stdout, "实例: 运行中（healthz 200 @ %s；state.db 持有者 pid 未知）\n", where)
	default:
		fmt.Fprintf(stdout, "实例: 未运行（%s 探测失败：%s）\n", where, detail)
		fmt.Fprintln(stdout, "  提示: 启动实例与执行 CLI 必须使用同一个 --config，否则会各算一个默认状态库")
	}
	return exitOK
}

// probeHealthz 探测 /-/healthz：优先 TCP（配置了 server.addr），否则走 UDS。
func probeHealthz(addr, socket string) (where string, reachable bool, detail string) {
	client := &http.Client{Timeout: statusProbeTimeout}
	url := "http://" + addr + "/-/healthz"
	if addr == "" {
		if socket == "" {
			return "（未配置监听地址）", false, "server.addr 与 server.socket 均为空"
		}
		url = "http://kore/-/healthz"
		where = "unix:" + socket
		client.Transport = &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
		}
	} else {
		where = "http://" + addr
	}
	resp, err := client.Get(url)
	if err != nil {
		return where, false, err.Error()
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return where, false, fmt.Sprintf("healthz 返回 %d", resp.StatusCode)
	}
	return where, true, ""
}
