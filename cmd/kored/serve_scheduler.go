package main

import (
	"context"
	"encoding/json"
	"log/slog"
)

// startScheduler 启动调度器：恢复任务、迁移 cert_renew 内置任务、按需起单 ticker。
func (s *service) startScheduler() error {
	if s.sched == nil {
		return nil
	}
	return s.sched.Start(context.Background())
}

// stopScheduler 停掉 ticker 并等待调度循环退出（先于停 HTTP/插件，避免新的在途调用）。
func (s *service) stopScheduler() {
	if s.sched != nil {
		s.sched.Stop()
	}
}

// builtinTask 是 scheduler 的内置任务处理器（装配层只处理 cert.renew_due；
// audit.clean 由 scheduler 直接执行，因为需要状态库句柄，见 DATA-MODEL §11）。
//
// 诚实披露（ADR-0019 技术债）：bus 的事件投递面尚未落地，这里只记录"到点执行"，
// 返回 published=false；不伪造"已广播给插件"。
func (s *service) builtinTask(_ context.Context, method string, _ json.RawMessage) (json.RawMessage, error) {
	slog.Info("内置定时任务到点", "method", method, "published", false,
		"note", "事件投递面未落地，仅记录到点执行")
	return json.RawMessage(`{"event":"cert.renew_due","published":false}`), nil
}
