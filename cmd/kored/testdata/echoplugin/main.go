// 测试用最小插件：只服务 cmd/kored 的 walking skeleton 端到端用例，不是产品插件。
//
// 协议面：connect → kore.hello → 会话循环；ping 返回 {"pong":true}，
// kore.shutdown 回 ok 后退出。业务方法名接受裸动词与 <id>.<verb> 两种写法。
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 与测试清单固定的协议字段。
const (
	pluginVersion = "0.1.0"
	requiresKore  = ">=0.1.0 <0.2.0"
	helloRequest  = "00000000000000000000000000000002"
)

// helloParams 是 kore.hello 请求参数（PLUGIN-PROTOCOL §5）。
type helloParams struct {
	PluginID     string   `json:"plugin_id"`
	Version      string   `json:"version"`
	Protocol     string   `json:"protocol"`
	RequiresKore string   `json:"requires_kore"`
	PID          int      `json:"pid"`
	Capabilities []string `json:"capabilities"`
	StartedAt    string   `json:"started_at"`
}

// helloResult 只校验 ok。
type helloResult struct {
	OK bool `json:"ok"`
}

// main 是所有错误都走 stderr + exit 1 的入口。
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "echoplugin:", err)
		os.Exit(1)
	}
}

// run 建连、握手并进入会话循环。
func run() error {
	conn, err := net.Dial("unix", os.Getenv("KORE_PLUGIN_SOCK"))
	if err != nil {
		return fmt.Errorf("连接 socket: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if err := handshake(conn); err != nil {
		return err
	}
	return serve(conn)
}

// handshake 发出 kore.hello 并校验响应。
func handshake(conn net.Conn) error {
	params, err := json.Marshal(helloParams{
		PluginID:     os.Getenv("KORE_PLUGIN_ID"),
		Version:      pluginVersion,
		Protocol:     pluginapi.Protocol,
		RequiresKore: requiresKore,
		PID:          os.Getpid(),
		Capabilities: []string{"system:read"},
		StartedAt:    "2026-11-22T00:00:00+08:00",
	})
	if err != nil {
		return err
	}
	request := &pluginapi.Request{
		Type: pluginapi.TypeRequest, ID: helloRequest, ReqID: "r-hello",
		Method: "kore.hello", Params: params,
	}
	if err := pluginapi.WriteJSON(conn, request); err != nil {
		return fmt.Errorf("写 hello: %w", err)
	}
	payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
	if err != nil {
		return fmt.Errorf("读 hello 响应: %w", err)
	}
	envelope, err := pluginapi.DecodeFrame(payload)
	if err != nil {
		return err
	}
	response, ok := envelope.(*pluginapi.Response)
	if !ok {
		return fmt.Errorf("hello 响应类型是 %T，不是 response", envelope)
	}
	if response.Error != nil {
		return fmt.Errorf("hello 被拒绝: %v", response.Error)
	}
	var result helloResult
	if err := json.Unmarshal(response.Result, &result); err != nil || !result.OK {
		return fmt.Errorf("hello 结果非法: %s", response.Result)
	}
	return nil
}

// serve 读帧 → 分发 → 写响应；kore.shutdown 后返回。
func serve(conn net.Conn) error {
	for {
		payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
		if err != nil {
			return nil // 对端关闭即正常退出
		}
		envelope, err := pluginapi.DecodeFrame(payload)
		if err != nil {
			return err
		}
		request, ok := envelope.(*pluginapi.Request)
		if !ok {
			continue
		}
		response := &pluginapi.Response{Type: pluginapi.TypeResponse, ID: request.ID, ReqID: request.ReqID}
		shutdown := false
		switch request.Method {
		case "kore.shutdown":
			response.Result = json.RawMessage(`{"ok":true}`)
			shutdown = true
		case "kore.ping":
			response.Result = json.RawMessage(`{"status":"ready"}`)
		case "ping", "echo.ping":
			response.Result = json.RawMessage(`{"pong":true}`)
		default:
			response.Error = &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "未知方法：" + request.Method}
		}
		if err := pluginapi.WriteJSON(conn, response); err != nil {
			return err
		}
		if shutdown {
			return nil
		}
	}
}
