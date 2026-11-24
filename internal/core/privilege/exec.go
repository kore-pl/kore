package privilege

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/pengtang1024/kore/internal/platform"
)

// Runner 是提权命令的执行抽象：真实实现用 os/exec **直接拉起**子进程（不经 shell），
// 测试注入 fake 以校验 argv 固定、超时与输出上限。
//
// 与 systemd-run 时代的区别（ADR-0049）：
//   - 返回的是**被调命令的真实退出码**，不是中间层（systemd-run）的退出码；
//   - 超时 / 取消时由实现自己回收整棵进程树（新进程组 + kill(-pgid)），
//     不再需要上层再调 KillUnit。
type Runner interface {
	// Run 执行一次命令；stdout/stderr 写入给定文件；返回被调命令的真实退出码。
	// 返回非 nil error 表示命令没跑起来（或超时 / 取消，此时退出码无意义）。
	Run(ctx context.Context, argv []string, stdoutPath, stderrPath string) (int, error)
}

// execRunner 是真实执行器：os/exec 直接执行，不经 shell。
type execRunner struct{}

// Run 直接执行 argv，输出落给定文件；超时 / 取消时 kill 整个进程组。
//
// 保留下来的四条不变量（ADR-0049 P2 / §4.2）：
//  1. `LC_ALL=C`：输出与报错口径稳定，审计可按英文关键字检索；
//  2. 不经 shell：argv 就是 exec 的 argv，元字符没有解释器；
//  3. 输出写文件、单流上限由上层 readOutputs 截断到 1 MiB；
//  4. 超时 / 取消 → `kill(-pgid, SIGKILL)`，父与所有后代一起回收。
func (execRunner) Run(ctx context.Context, argv []string, stdoutPath, stderrPath string) (int, error) {
	if len(argv) == 0 {
		return -1, errors.New("argv 为空")
	}
	stdout, err := os.OpenFile(stdoutPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return -1, fmt.Errorf("打开 stdout 文件失败：%w", err)
	}
	defer func() { _ = stdout.Close() }()
	stderr, err := os.OpenFile(stderrPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return -1, fmt.Errorf("打开 stderr 文件失败：%w", err)
	}
	defer func() { _ = stderr.Close() }()

	command := exec.Command(argv[0], argv[1:]...)
	command.Stdout, command.Stderr = stdout, stderr
	command.Env = append(os.Environ(), "LC_ALL=C")
	// 新进程组：没有它，超时 kill 只能杀直接子进程，fork 出来的后代继续跑。
	// 非 Unix 平台这里返回 ErrUnsupported —— 显式拒绝执行，不静默退化。
	if err := platform.PrepareProcessGroup(command); err != nil {
		return -1, fmt.Errorf("无法建立独立进程组，拒绝执行特权动作：%w", err)
	}
	if err := command.Start(); err != nil {
		return -1, fmt.Errorf("启动命令 %q 失败：%w", argv[0], err)
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = platform.KillProcessGroup(command)
		case <-done:
		}
	}()
	waitErr := command.Wait()
	close(done)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return -1, ctxErr
	}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			// 真实退出码：命令自己 `exit 42` 就是 42（systemd-run 时代这里拿不到）。
			return exitErr.ExitCode(), nil
		}
		return -1, fmt.Errorf("执行命令 %q 失败：%w", argv[0], waitErr)
	}
	return 0, nil
}

// systemdRuntimeDir 是 systemd 引导标记路径。
//
// 只用于**诊断**（DetectSystemd），不参与提权准入；测试改写它以模拟「无 systemd
// 宿主」，证明执行路径不依赖它。
var systemdRuntimeDir = "/run/systemd/system"

// DetectRoot 报告当前进程是否 root。
func DetectRoot() bool { return os.Geteuid() == 0 }

// DetectSystemd 报告宿主是否以 systemd 引导（**诊断信息，不再参与准入判定**）。
//
// ADR-0049：特权动作由内核直接 exec，`systemd-run` / `systemctl` 不再是前置条件，
// 因此本函数不再决定动作能否执行。保留它只为环境报告与回归测试——测试把
// systemdRuntimeDir 指到不存在的路径，断言「探测为 false 时动作仍能执行」。
func DetectSystemd() (bool, string) {
	if _, err := os.Stat(systemdRuntimeDir); err != nil {
		return false, systemdRuntimeDir + " 不存在（系统未以 systemd 引导；不影响直接执行）"
	}
	return true, ""
}
