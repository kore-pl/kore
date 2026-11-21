// 假插件：supervisor / bus 单测用的最小可执行替身，不是真插件（不进任何插件仓库）。
//
// 行为由 <KORE_STATE_DIR>/fake.conf 控制（key=value 每行一条）：
//
//	hello_delay=2.1s   连接后延迟多久再发 kore.hello（用于制造握手超时）
//	ready_marker=/path 握手成功后写一个标记文件（用于证明进程活到了就绪）
//	pid_file=/path     启动后立即写入自身 pid（用于断言进程确已被 SIGKILL）
//
// 协议面：connect → 首帧 kore.hello → 收到响应 → 进入 serve 循环；
// 业务方法原样回显 params（带 req_id），kore.shutdown 回 ok 后退出。
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 假插件里固定写死的协议字段；版本与 requires_kore 由测试通过环境变量覆盖。
const (
	fakeVersion = "0.1.0"
	// defaultRequiresKore 与测试清单保持一致。
	defaultRequiresKore = ">=0.1.0 <0.2.0"
	// helloRequestID 是握手请求的固定 id（32 位小写 hex）。
	helloRequestID = "00000000000000000000000000000001"
)

// 假插件自身声明的方法能力上限。
var fakeCapabilities = []string{"system:read"}

// main 是所有错误都走 stderr + exit 1 的入口。
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fakeplugin:", err)
		os.Exit(1)
	}
}

// run 按 fake.conf 的配置完成握手并进入 serve 循环。
func run() error {
	settings := loadConfig()
	if pidFile := settings["pid_file"]; pidFile != "" {
		if err := os.WriteFile(pidFile, []byte(fmt.Sprint(os.Getpid())), 0o600); err != nil {
			return fmt.Errorf("写 pid 文件: %w", err)
		}
	}
	if settings["hello_delay"] != "" {
		delay, err := time.ParseDuration(settings["hello_delay"])
		if err != nil {
			return fmt.Errorf("解析 hello_delay: %w", err)
		}
		time.Sleep(delay)
	}
	conn, err := net.Dial("unix", os.Getenv("KORE_PLUGIN_SOCK"))
	if err != nil {
		return fmt.Errorf("连接 socket: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if err := handshake(conn); err != nil {
		return err
	}
	if marker := settings["ready_marker"]; marker != "" {
		if err := os.WriteFile(marker, []byte("ready"), 0o600); err != nil {
			return fmt.Errorf("写就绪标记: %w", err)
		}
	}
	return serve(conn)
}

// handshake 发出 kore.hello 并读完响应帧。
func handshake(conn net.Conn) error {
	params, err := json.Marshal(map[string]any{
		"plugin_id":     os.Getenv("KORE_PLUGIN_ID"),
		"version":       fakeVersion,
		"protocol":      pluginapi.Protocol,
		"requires_kore": defaultRequiresKore,
		"pid":           os.Getpid(),
		"capabilities":  fakeCapabilities,
		"started_at":    time.Now().Format(time.RFC3339Nano),
	})
	if err != nil {
		return err
	}
	request := &pluginapi.Request{
		Type:   pluginapi.TypeRequest,
		ID:     helloRequestID,
		Method: "kore.hello",
		Params: params,
	}
	if err := pluginapi.WriteJSON(conn, request); err != nil {
		return fmt.Errorf("写 hello: %w", err)
	}
	if _, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize); err != nil {
		return fmt.Errorf("读 hello 响应: %w", err)
	}
	return nil
}

// serve 循环读帧：业务方法回显 params，kore.shutdown 回 ok 后退出。
func serve(conn net.Conn) error {
	for {
		payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
		if err != nil {
			return nil // 对端关闭即正常退出
		}
		env, err := pluginapi.DecodeFrame(payload)
		if err != nil {
			return err
		}
		request, ok := env.(*pluginapi.Request)
		if !ok {
			continue
		}
		response := &pluginapi.Response{Type: pluginapi.TypeResponse, ID: request.ID, ReqID: request.ReqID}
		if request.Method == "kore.shutdown" {
			response.Result = json.RawMessage(`{"ok":true}`)
			_ = pluginapi.WriteJSON(conn, response)
			return nil
		}
		echo, err := json.Marshal(map[string]json.RawMessage{"echo": request.Params})
		if err != nil {
			return err
		}
		response.Result = echo
		if err := pluginapi.WriteJSON(conn, response); err != nil {
			return err
		}
	}
}

// loadConfig 读 <KORE_STATE_DIR>/fake.conf；文件不存在时返回空配置。
func loadConfig() map[string]string {
	settings := make(map[string]string)
	data, err := os.ReadFile(filepath.Join(os.Getenv("KORE_STATE_DIR"), "fake.conf"))
	if err != nil {
		return settings
	}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && key != "" {
			settings[key] = value
		}
	}
	return settings
}
