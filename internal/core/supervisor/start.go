package supervisor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// start 执行一次冷启动：bind socket → exec 插件 → 2s 内完成 hello 握手。
//
// M3-C：从 failed 状态恢复的启动在发生时直接落审计（plugin.retry）；
// 正常首次启动的 plugin.enable 由 Start 层记录，两处不重复。
func (m *Manager) start(ctx context.Context, inst *instance) error {
	recovering := inst.currentState() == StateFailed
	err := m.startOnce(ctx, inst)
	if !recovering {
		return err
	}
	event := AuditEvent{
		Subject: AuditSubjectSystem, Action: AuditRestart, Plugin: inst.manifest.ID,
		Result: AuditResultOK,
		Detail: restartDetail(string(StateFailed), inst.snapshot().Restarts),
	}
	if err != nil {
		event.Result = AuditResultError
		event.Detail = detail("err", err.Error())
	}
	m.record(ctx, event)
	return err
}

// startOnce 是冷启动主体：bind → exec → hello 握手，失败走 failStart 收尾。
func (m *Manager) startOnce(ctx context.Context, inst *instance) error {
	inst.beginStart()
	listener, err := m.listen(inst)
	if err != nil {
		return m.failStart(inst, err)
	}
	inst.attachListener(listener)
	if err := m.spawn(inst); err != nil {
		return m.failStart(inst, err)
	}
	conn, err := m.handshake(ctx, inst)
	if err != nil {
		m.logger.Warn("插件握手失败", "plugin_id", inst.manifest.ID, "err", err)
		return m.failStart(inst, err)
	}
	inst.markReady(conn)
	m.logger.Info("插件就绪", "plugin_id", inst.manifest.ID, "socket", inst.socket)
	return nil
}

// spawn 以当前用户 exec 插件二进制，注入 5 个唯一环境变量（CORE §4.1，禁止别名）。
func (m *Manager) spawn(inst *instance) error {
	stateDir := filepath.Dir(inst.manifest.Dir)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return errf(pluginapi.E_INTERNAL, "创建插件状态目录 %s 失败：%v", stateDir, err)
	}
	writer, err := m.openLog(inst.manifest.ID)
	if err != nil {
		return err
	}
	if closer, ok := writer.(io.Closer); ok {
		defer func() { _ = closer.Close() }() // 子进程已复制 fd，父进程不保留句柄
	}
	token, err := randomToken()
	if err != nil {
		return err
	}
	cmd := exec.Command(filepath.Join(inst.manifest.Dir, inst.manifest.Entry))
	cmd.Dir = stateDir
	cmd.Env = append(os.Environ(), m.pluginEnv(inst, stateDir, token)...)
	cmd.Stdout, cmd.Stderr = writer, writer
	if err := cmd.Start(); err != nil {
		return errf(pluginapi.E_UPSTREAM, "拉起插件 %s 失败：%v", inst.manifest.ID, err)
	}
	inst.attachProcess(cmd)
	go m.reap(inst, cmd, inst.exitedRef())
	return nil
}

// pluginEnv 返回注入插件的 5 个环境变量（唯一名，不设协议/capabilities 变量）。
func (m *Manager) pluginEnv(inst *instance, stateDir, token string) []string {
	return []string{
		"KORE_PLUGIN_ID=" + inst.manifest.ID,
		"KORE_PLUGIN_SOCK=" + inst.socket,
		"KORE_PLUGIN_TOKEN=" + token,
		"KORE_STATE_DIR=" + stateDir,
		"KORE_LOG_DIR=" + m.opts.LogDir,
	}
}

// openLog 打开插件日志文件；LogDir 为空时丢弃输出（前台调试与单测）。
func (m *Manager) openLog(id string) (io.Writer, error) {
	if m.opts.LogDir == "" {
		return io.Discard, nil
	}
	if err := os.MkdirAll(m.opts.LogDir, 0o700); err != nil {
		return nil, errf(pluginapi.E_INTERNAL, "创建插件日志目录 %s 失败：%v", m.opts.LogDir, err)
	}
	path := filepath.Join(m.opts.LogDir, id+".log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, errf(pluginapi.E_INTERNAL, "打开插件日志 %s 失败：%v", path, err)
	}
	return file, nil
}

// reap 回收子进程：关闭连接与监听器，把 ready 状态下的意外退出记为 failed。
func (m *Manager) reap(inst *instance, cmd *exec.Cmd, exited chan struct{}) {
	waitErr := cmd.Wait()
	listener, conn, _ := inst.takeRuntime()
	if conn != nil {
		_ = conn.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
	inst.mu.Lock()
	crashed := inst.state == StateReady
	if crashed {
		inst.state = StateFailed
		inst.lastErr = "插件进程意外退出：" + errorText(waitErr)
	}
	inst.mu.Unlock()
	if crashed {
		m.removeSocket(inst.socket)
		m.logger.Warn("插件进程意外退出", "plugin_id", inst.manifest.ID, "err", waitErr)
		// M3-C：crash 在发生时直接落审计（plugin.crash），不等下次请求对账。
		pid := 0
		if cmd.Process != nil {
			pid = cmd.Process.Pid
		}
		m.record(context.Background(), AuditEvent{
			Subject: AuditSubjectSystem, Action: AuditCrash, Plugin: inst.manifest.ID,
			Result: AuditResultError,
			Detail: detail("err", errorText(waitErr), "pid", strconv.Itoa(pid)),
		})
	}
	close(exited)
}

// failStart 收尾一次失败启动：杀进程 → 等回收 → 关监听器 → 清 socket → 置 failed 并计数。
func (m *Manager) failStart(inst *instance, cause error) error {
	listener, conn, cmd := inst.takeRuntime()
	if conn != nil {
		_ = conn.Close()
	}
	if cmd != nil && cmd.Process != nil {
		if err := cmd.Process.Kill(); !isProcessDone(err) {
			m.logger.Warn("SIGKILL 插件失败", "plugin_id", inst.manifest.ID, "err", err)
		}
		waitChan(context.Background(), inst.exitedRef(), defaultKillWait)
	}
	if listener != nil {
		_ = listener.Close()
	}
	m.removeSocket(inst.socket)
	inst.markFailed(cause)
	return cause
}

// randomToken 生成 32 字节随机 hex token（Tier B hello HMAC 预置，Linux 仅审计关联）。
func randomToken() (string, error) {
	return randomHex(32)
}

// randomHex 生成 n 字节随机数的 hex 串（请求 id 用 16 字节 = 32 位小写 hex）。
func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", errf(pluginapi.E_INTERNAL, "生成随机标识失败：%v", err)
	}
	return hex.EncodeToString(buf), nil
}

// errorText 把 Wait 错误转成可读文本（正常退出记 exit 0）。
func errorText(err error) string {
	if err == nil {
		return "exit 0"
	}
	return fmt.Sprint(err)
}
