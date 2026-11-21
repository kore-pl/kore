package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// Snapshot 返回插件运行时视图；未登记返回 false。
func (m *Manager) Snapshot(id string) (View, bool) {
	inst, ok := m.lookup(id)
	if !ok {
		return View{}, false
	}
	return inst.snapshot(), true
}

// View 是插件运行时视图（供 /system/info 与前端展示）。
type View struct {
	// ID 插件 id。
	ID string
	// State 当前运行状态。
	State State
	// PID 插件进程号；无进程时为 0。
	PID int
	// Restarts 启动失败累计次数（M1 只计数，不做退避）。
	Restarts int
	// LastError 最近一次失败原文。
	LastError string
	// Socket 插件 UDS 路径。
	Socket string
	// StartedAt 最近一次冷启动开始时间。
	StartedAt time.Time
}

// errf 构造带协议错误码的统一错误体。
func errf(code, format string, args ...any) *pluginapi.Error {
	return &pluginapi.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// waitChan 等 channel 关闭或超时；超时返回 false，nil channel 视为已结束。
func waitChan(ctx context.Context, ch <-chan struct{}, timeout time.Duration) bool {
	if ch == nil {
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ch:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// isProcessDone 判断 kill 失败是否只是「进程已退出」。
func isProcessDone(err error) bool {
	return err == nil || errors.Is(err, os.ErrProcessDone)
}
