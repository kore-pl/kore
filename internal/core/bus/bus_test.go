package bus_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/kore-project/kore/internal/core/bus"
	"github.com/kore-project/kore/pkg/pluginapi"
)

// fakeProvider 返回固定连接；err 非空时模拟 supervisor 的拒绝（未 enable 等）。
type fakeProvider struct {
	conn net.Conn
	err  error
}

// Ensure 实现 bus.Provider。
func (p fakeProvider) Ensure(context.Context, string) (net.Conn, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.conn, nil
}

// newBus 构造一个指向固定连接、2s 超时的 Bus。
func newBus(t *testing.T, conn net.Conn) *bus.Bus {
	t.Helper()
	instance, err := bus.New(fakeProvider{conn: conn}, bus.Options{CallTimeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}
	return instance
}

// codeOf 取协议错误码；非协议错误直接失败。
func codeOf(t *testing.T, err error) string {
	t.Helper()
	var protocolErr *pluginapi.Error
	if !errors.As(err, &protocolErr) {
		t.Fatalf("错误不是 *pluginapi.Error: %v", err)
	}
	return protocolErr.Code
}

// TestReqIDPassthrough 是 req_id 透传用例：请求带 req_id，插件原样回显同一值。
func TestReqIDPassthrough(t *testing.T) {
	client, plugin := net.Pipe()
	defer func() { _ = client.Close() }()
	defer func() { _ = plugin.Close() }()
	observed := make(chan string, 1)
	go func() {
		payload, err := pluginapi.ReadFrame(plugin, pluginapi.MaxFrameSize)
		if err != nil {
			observed <- "读请求失败: " + err.Error()
			return
		}
		env, err := pluginapi.DecodeFrame(payload)
		if err != nil {
			observed <- "解码失败: " + err.Error()
			return
		}
		request, ok := env.(*pluginapi.Request)
		if !ok {
			observed <- "首帧不是 request"
			return
		}
		observed <- request.ReqID
		response := &pluginapi.Response{
			Type:   pluginapi.TypeResponse,
			ID:     request.ID,
			ReqID:  request.ReqID,
			Result: json.RawMessage(`{"echo":true}`),
		}
		_ = pluginapi.WriteJSON(plugin, response)
	}()

	reply, err := newBus(t, client).Call(context.Background(), "echo", "echo.echo",
		json.RawMessage(`{"n":1}`), "r-test-42")
	if err != nil {
		t.Fatalf("调用应成功: %v", err)
	}
	if got := <-observed; got != "r-test-42" {
		t.Fatalf("请求帧应带 req_id=r-test-42，实际 %q", got)
	}
	if reply.ReqID != "r-test-42" {
		t.Fatalf("响应应回显 req_id=r-test-42，实际 %q", reply.ReqID)
	}
	if string(reply.Result) != `{"echo":true}` {
		t.Fatalf("result 应原样返回，实际 %s", reply.Result)
	}
}

// TestNotEnabled 验证「装但未 enable」的错误码由 supervisor 透传给调用方。
func TestNotEnabled(t *testing.T) {
	providerErr := &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "插件 echo 未安装或未 enable"}
	instance, err := bus.New(fakeProvider{err: providerErr}, bus.Options{})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}
	_, callErr := instance.Call(context.Background(), "echo", "echo.echo", nil, "r-1")
	if codeOf(t, callErr) != pluginapi.E_NOTFOUND {
		t.Fatalf("应返回 E_NOTFOUND，实际 %v", callErr)
	}
}

// TestOversizeFrameDropsConnection 验证超限帧断连并返回 E_INVALID。
func TestOversizeFrameDropsConnection(t *testing.T) {
	client, plugin := net.Pipe()
	defer func() { _ = client.Close() }()
	defer func() { _ = plugin.Close() }()
	dropped := make(chan bool, 1)
	go func() {
		if _, err := pluginapi.ReadFrame(plugin, pluginapi.MaxFrameSize); err != nil {
			dropped <- false
			return
		}
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], uint32(pluginapi.MaxFrameSize+1))
		if _, err := plugin.Write(header[:]); err != nil {
			dropped <- false
			return
		}
		time.Sleep(20 * time.Millisecond)
		_, err := plugin.Write([]byte("x"))
		dropped <- err != nil
	}()

	_, err := newBus(t, client).Call(context.Background(), "echo", "echo.echo", nil, "r-oversize")
	if codeOf(t, err) != pluginapi.E_INVALID {
		t.Fatalf("超限帧应返回 E_INVALID，实际 %v", err)
	}
	if !<-dropped {
		t.Fatalf("超限帧应断开连接（对端再写应失败）")
	}
}
