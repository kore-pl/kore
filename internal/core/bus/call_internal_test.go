package bus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fixedProvider 是内部测试用的最小 Provider：始终返回同一个连接。
type fixedProvider struct{ conn net.Conn }

// Ensure 实现 Provider。
func (p fixedProvider) Ensure(context.Context, string) (net.Conn, error) { return p.conn, nil }

// TestStaleResponseCapDiscardsConnection 断言「一直读到垃圾帧」的上限：
// 连续 maxStaleResponses+1 个无法关联到本次请求的响应帧后弃连接并返回 E_INVALID，
// 不在垃圾帧上无限消耗调用预算。
func TestStaleResponseCapDiscardsConnection(t *testing.T) {
	client, plugin := net.Pipe()
	t.Cleanup(func() {
		_ = client.Close()
		_ = plugin.Close()
	})
	instance, err := New(fixedProvider{conn: client}, Options{CallTimeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		payload, err := pluginapi.ReadFrame(plugin, pluginapi.MaxFrameSize)
		if err != nil {
			done <- err
			return
		}
		if _, err := pluginapi.DecodeFrame(payload); err != nil {
			done <- err
			return
		}
		for i := 0; i <= maxStaleResponses; i++ {
			response := &pluginapi.Response{
				Type:   pluginapi.TypeResponse,
				ID:     fmt.Sprintf("stale-%d", i),
				ReqID:  "r-other",
				Result: json.RawMessage(`{"late":true}`),
			}
			if err := pluginapi.WriteJSON(plugin, response); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()

	_, callErr := instance.Call(context.Background(), "echo", "echo.echo", nil, "r-cap")
	var protocolErr *pluginapi.Error
	if !errors.As(callErr, &protocolErr) || protocolErr.Code != pluginapi.E_INVALID {
		t.Fatalf("连续垃圾帧应返回 E_INVALID，实际 %v", callErr)
	}
	if !strings.Contains(callErr.Error(), "无法关联") {
		t.Fatalf("错误应说明无法关联到本次请求，实际 %v", callErr)
	}
	if err := <-done; err != nil {
		t.Fatalf("插件脚本失败: %v", err)
	}
	// 连接已被弃用：同一个（已关闭的）连接再次调用必须失败，而不是继续读垃圾帧。
	if _, callErr := instance.Call(context.Background(), "echo", "echo.echo", nil, "r-cap-2"); !errors.As(callErr, &protocolErr) || protocolErr.Code != pluginapi.E_UPSTREAM {
		t.Fatalf("弃连接后的调用应返回 E_UPSTREAM，实际 %v", callErr)
	}
}
