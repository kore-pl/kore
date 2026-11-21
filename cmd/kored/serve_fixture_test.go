package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/httpapi"
)

// 测试插件固定版本；与 testdata/echoplugin 的 hello 字段保持一致。
const (
	testVersion      = "0.1.0"
	testRequiresKore = ">=0.1.0 <0.2.0"
)

// pluginSpec 描述一个待安装的测试插件。
type pluginSpec struct {
	// ID 插件 id。
	ID string
	// Lifecycle resident / lazy / oneshot。
	Lifecycle string
}

// harness 是进程内装配的端到端测试环境。
type harness struct {
	t      *testing.T
	svc    *service
	client *http.Client
}

// newHarness 在 t.TempDir() 下安装插件、装配 service 并启动随机 UDS 的 HTTP 服务。
func newHarness(t *testing.T, specs ...pluginSpec) *harness {
	t.Helper()
	stateDir := t.TempDir()
	logger := discardLogger()
	installSpecs(t, stateDir, logger, specs)
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}
	sockDir, sock := newSocket(t)
	server := startServer(t, sock, svc, app)
	h := &harness{t: t, svc: svc, client: newClient(sock)}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = server.Shutdown(ctx)
		cancel()
		svc.StopAll()
		_ = db.Close()
		h.client.CloseIdleConnections()
		removeSocket(sockDir)
	})
	return h
}

// testConfig 构造只依赖临时目录的运行期配置。
func testConfig(stateDir string) config {
	snap := coreconfig.Default()
	snap.Paths.StateDir = stateDir
	snap.Paths.PluginDir = stateDir + "/plugins"
	snap.Paths.RunDir = stateDir + "/run"
	snap.Paths.LogDir = stateDir + "/log"
	snap.Server.Socket = stateDir + "/run/kore.sock"
	return config{
		ConfigDir: stateDir + "/etc", StateDir: stateDir,
		RunDir: snap.Paths.RunDir, LogDir: snap.Paths.LogDir, snapshot: snap,
	}
}

// do 发起一次 UDS HTTP 请求。
func (h *harness) do(method, path string, body []byte, headers map[string]string) (int, []byte, http.Header) {
	h.t.Helper()
	req, err := http.NewRequest(method, "http://kore"+path, bytes.NewReader(body))
	if err != nil {
		h.t.Fatalf("构造请求失败: %v", err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		h.t.Fatalf("请求 %s %s 失败: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatalf("读取响应失败: %v", err)
	}
	return resp.StatusCode, data, resp.Header
}

// waitState 轮询插件列表直到状态命中（仅测试使用；生产侧零轮询）。
func (h *harness) waitState(id string, timeout time.Duration, want ...string) httpapi.PluginStatus {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		code, body, _ := h.do(http.MethodGet, pluginPath("", ""), nil, nil)
		if code == http.StatusOK {
			for _, status := range decodeList(h.t, body) {
				if status.ID != id {
					continue
				}
				for _, target := range want {
					if status.State == target {
						return status
					}
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatalf("插件 %s 未在 %s 内进入状态 %v", id, timeout, want)
	return httpapi.PluginStatus{}
}

// decodeList 解码插件列表响应；测试断言失败即终止。
func decodeList(t *testing.T, body []byte) []httpapi.PluginStatus {
	t.Helper()
	var response struct {
		Plugins []httpapi.PluginStatus `json:"plugins"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("解码插件列表失败: %v（%s）", err, body)
	}
	return response.Plugins
}
