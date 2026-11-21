package supervisor_test

import (
	"context"
	"sync"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// TestColdStartQueueLimit 是冷启动互斥 + 队列上限的反向用例：
// 40 个并发请求打同一未就绪插件 → 1 个执行启动、31 个排队、8 个 E_RATELIMIT。
func TestColdStartQueueLimit(t *testing.T) {
	env := newTestEnv(t, "slow", map[string]string{"hello_delay": "800ms"}, nil)
	const total = 40
	errs := make([]error, total)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for index := 0; index < total; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			_, errs[index] = env.manager.Ensure(context.Background(), "slow")
		}(index)
	}
	close(start)
	wait.Wait()

	rateLimited, succeeded := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			succeeded++
		case codeOf(t, err) == pluginapi.E_RATELIMIT:
			rateLimited++
		default:
			t.Fatalf("出现意外错误: %v", err)
		}
	}
	if rateLimited != total-32 {
		t.Fatalf("队列上限 32 时应有 %d 个 E_RATELIMIT，实际 %d", total-32, rateLimited)
	}
	if succeeded != 32 {
		t.Fatalf("应有 32 个请求被接纳，实际 %d", succeeded)
	}
	view, _ := env.manager.Snapshot("slow")
	if view.State != "ready" {
		t.Fatalf("启动完成后应 ready，实际 %s（%s）", view.State, view.LastError)
	}
}
