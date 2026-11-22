# 第三方插件 SDK 接入指南（30 分钟跑通 hello）

> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M5

面向第三方插件作者：只依赖公开 SDK `github.com/pengtang1024/kore/pkg/pluginapi`（v0.1.1），不碰内核 `internal/*`，30 分钟完成「建仓→连 UDS→握手→会话循环」。协议唯一真源是 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md)：帧格式 §4、握手 §5、清单 §3.1、错误码 §9；参考实现是同级 `kore-plugin-echo` 仓。冲突时以协议文档为准。

## 1. 30 分钟 quickstart

六步顺序执行；假设新仓 `kore-plugin-hello` 与内核 `kore` 同级，内核已启动并创建 socket。

### step 1 · 建仓与 go.mod（3 分钟）
只 `require` 这一个依赖（§6）；**不要用 v0.1.0**——它已 `retract`，tag 内容声明旧 module 路径，干净目录解析必失败。
```bash
mkdir kore-plugin-hello && cd kore-plugin-hello && git init
cat > go.mod <<'EOF'
module github.com/pengtang1024/kore-plugin-hello
go 1.26
require github.com/pengtang1024/kore/pkg/pluginapi v0.1.1
EOF
go mod download
```

### step 2 · go.work 本地联调（2 分钟）
`go.work` 只用于本地联调、**不提交**（跨仓 `replace`/`go.work` 属 G-17 禁止提交范畴）；打包与发布一律 `GOWORK=off`（§4、§6）。
```bash
cat > go.work <<'EOF'
go 1.26
use (
    .
    ../kore/pkg/pluginapi
)
EOF
```

### step 3 · main.go 连 UDS（5 分钟）
socket 固定为内核下发的 `KORE_PLUGIN_SOCK`（Linux 下形如 `/run/kore/plugins/<id>.sock`），不要自行拼路径；stdout 留给协议，日志走 stderr。
```go
func main() {
    sock := os.Getenv("KORE_PLUGIN_SOCK")
    if sock == "" { log.Fatal("缺少 KORE_PLUGIN_SOCK") }
    conn, err := net.Dial("unix", sock)
    if err != nil { log.Fatal(err) }
    defer conn.Close()
    if err := handshake(conn); err != nil { log.Fatal(err) }
    serve(conn) // 收到 kore.shutdown 后返回
}
```

### step 4 · 发 kore.hello（8 分钟）
首帧必须是 `kore.hello`，字段逐项见 §2；完整实现可抄 echo 仓 `handshake.go`。
```go
id, _ := cryptoRandomHex16() // 32 位小写 hex，连接内唯一
params, _ := json.Marshal(helloParams{
    PluginID: "hello", Version: "0.1.0", Protocol: pluginapi.Protocol,
    RequiresKore: ">=0.1.0 <0.2.0", PID: os.Getpid(),
    Capabilities: []string{"hello:ping"}, StartedAt: time.Now().Format(time.RFC3339Nano),
})
_ = conn.SetDeadline(time.Now().Add(2 * time.Second)) // 握手预算 2s
req := &pluginapi.Request{Type: pluginapi.TypeRequest, ID: id,
    ReqID: "r-" + id[:8], Method: "kore.hello", Params: params}
if err := pluginapi.WriteJSON(conn, req); err != nil { return err }
```
帧 = 4 字节大端长度 + JSON 载荷，`WriteJSON` 已封装。

### step 5 · 读响应校验（5 分钟）
三项必校：帧类型 `response`、`id` 原样回显、`result.ok=true` 且主版本一致——防内核降级兼容。
```go
payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
if err != nil { return err }
env, err := pluginapi.DecodeFrame(payload)
if err != nil { return err }
res, ok := env.(*pluginapi.Response)
if !ok || res.ID != id || res.Error != nil { return errors.New("hello 响应非法") }
var result struct{ OK bool `json:"ok"`; Protocol string `json:"protocol"` }
_ = json.Unmarshal(res.Result, &result)
if !result.OK || (result.Protocol != "" && result.Protocol != pluginapi.Protocol) {
    return errors.New("内核握手拒绝或协议降级")
}
_ = conn.SetDeadline(time.Time{}) // 清掉握手超时
```

### step 6 · 会话循环 ping（7 分钟）
`ping/pong` 是传输层探活（10s 周期），与业务方法 `kore.ping` 不同；回 `pong` 必须原样回填 `ts`。
```go
for {
    payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
    if err == io.EOF { return nil }
    if err != nil { return err }
    env, err := pluginapi.DecodeFrame(payload)
    if err != nil { return err }
    switch v := env.(type) {
    case *pluginapi.Ping:
        _ = pluginapi.WriteJSON(conn, &pluginapi.Pong{Type: pluginapi.TypePong, TS: v.TS})
    case *pluginapi.Request:
        reply(conn, v) // kore.ping/shutdown/reload 必选，其余查自有路由
    }
}
```

## 2. hello 握手字段表

以 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md) §5 为准；`id`/`token` 是 echo 参考实现附加的别名（内核忽略未知字段，不破坏 §5）。

| 字段 | 来源 | 校验规则（§5） |
| --- | --- | --- |
| `plugin_id` | `KORE_PLUGIN_ID`，缺省取清单 `id` | 必填；与内核登记 id 一致，否则 `E_UNAUTHORIZED` |
| `id` | echo 别名，值同 `plugin_id` | 非 §5 字段，内核忽略；仅为兼容旧模板保留 |
| `version` | 内嵌清单 `version` | 必填；与安装期 `info.json` 一致 |
| `protocol` | `pluginapi.Protocol` 常量 | 必填；固定 `kore.plugin.v1`，主版本不符 `E_UNSUPPORTED` |
| `requires_kore` | 内嵌清单 `requires_kore` | 必填；与 `info.json` 一致，内核版本须落在区间内 |
| `pid` | `os.Getpid()` | 必填；内核用 `SO_PEERCRED` 交叉校验，不符即拒 |
| `capabilities` | 内嵌清单 `capabilities` | 必填；必须 ⊆ `info.json` 声明，超集拒绝 |
| `started_at` | `time.Now().Format(time.RFC3339Nano)` | 必填；RFC 3339 带毫秒与时区 |
| `token` | `KORE_PLUGIN_TOKEN` | Windows HMAC 身份校验用（§17）；Linux/macOS 仅审计关联 |

协商顺序固定：区间可解析 → 内核版本落区间 → `protocol` 主版本匹配 → 平台身份校验 → `capabilities` ⊆ 声明 → 登记路由；任一步失败回 `E_UNSUPPORTED`/`E_UNAUTHORIZED` 并 SIGKILL，不进入 ready。握手超时 2s，超时或出错置 `failed`。

## 3. info.json 12 字段

9 必填 + 3 可选的口径来自 `internal/core/registry/manifest.go` 的 `requiredKeys` 与协议 §3.1；其余字段（`depends_on`/`conflicts`/`web` 等）属扩展，见 §3.1。**9 必填**（缺一即 `E_INVALID`）：

| 字段 | 类型 | 含义与约束 |
| --- | --- | --- |
| `id` | string | 2–32 小写字母/数字/连字符，不以 `-` 开头/结尾、无 `--`，与包名一致 |
| `name` | string | 1–64 字符展示名，允许中文 |
| `version` | string | 语义化 `MAJOR.MINOR.PATCH`，与包名一致 |
| `protocol` | string | 只接受 `kore.plugin.v1` |
| `entry` | string | 包内可执行相对路径，固定 `bin/<id>` |
| `capabilities` | string[] | 非空：≥1 且 ≤16 项；6 个特权能力或 `<id>:<action>`（§3.1.2） |
| `resources` | object | `memory_mb` 4–12、`cpu_quota` `"10%"`–`"100%"`、`pids_max` 16–512 |
| `requires_kore` | string | 区间如 `">=0.1.0 <0.2.0"`；不支持 `^`/`~`/`||` |
| `triggers` | string[] | 元素 `<type>:<name>`，`type` ∈ event/schedule/invoke；空数组合法 |

**3 可选**：

| 字段 | 类型 | 缺省 | 含义与约束 |
| --- | --- | --- | --- |
| `lifecycle` | string | `lazy` | `resident`/`lazy`/`oneshot`；显式 `resident` 才常驻 |
| `scenario_tags` | string[] | `[]` | 枚举仅 `web`/`data`/`ops`/`sec`/`app`，写成 preset 名即 `E_INVALID` |
| `size_bytes` | int | `0` | `make dist` 打包时回填；仓库内可为 0，须 ≥0 |

## 4. 包格式与 dist

`make dist` 产出 `<id>-<version>.tar.gz` 与同名 `.sha256`。包内条目固定三类、**无 `./` 根条目**（第四层坑：含 `./` 会被安装器 `safePath` 拒装），顺序固定 `info.json` → `bin/<id>`（0755 静态二进制）→ 可选 `web/` → `SHA256SUMS`（前两者的 sha256sum）：
```bash
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -cf - -C dist/stage info.json bin web SHA256SUMS | gzip -9n > dist/hello-0.1.1.tar.gz
```
`--sort=name` 固定条目序、`--mtime=@0` 固定时间戳、`--owner/group=0 --numeric-owner` 固定属主、`gzip -9n` 去掉 gzip 头时间戳——缺一即跨秒重建 sha 漂移。

**`go:embed` 源必须与 `size_bytes` 元数据解耦**：不要 `//go:embed info.json`——打包脚本会回填 `size_bytes`，使二进制随清单自指震荡、sha 不可复现。正确做法是提交一份独立的静态 `manifest.json`（只含 `id`/`version`/`protocol`/`requires_kore`/`capabilities` 等握手字段，永不含 `size_bytes`），`//go:embed manifest.json`；该范式在 firewall/waf/container/app-deploy 四仓实证通过。发布链须做**冷构建 + 跨秒连续两次 `make dist` + `GOWORK=off`** 三路径验证，两次 sha 逐字相同才算可信。

## 5. net.Pipe 测试契约

用 `net.Pipe` 做协议往返测试时，**每个写请求必须配对读一次响应帧**，尤其是 `kore.shutdown`——`net.Pipe` 无缓冲，只写不读会永久阻塞在写侧，表现为死锁而非断言失败。这条契约是 [JOURNAL.md](../.agents/JOURNAL.md)「规则固化：net.Pipe 测试契约」节明文的：M5 批1 的 logs 仓漏读 `invoke` 应答、dns 仓漏读 `kore.shutdown` 应答，照抄 site 模板各踩一次死锁，两次都靠 RCA 补读响应帧解决；批2 起已在任务卡写死"每个 shutdown 请求必须配对读响应帧"。共享模板的隐含契约必须显式化——新写的测试在 `WriteJSON` 旁边就写下对应的 `ReadFrame`，不要等死锁后再补。

## 6. 常见 Pitfalls

| 坑 | 现象 | 规避 |
| --- | --- | --- |
| 未用 `GOWORK=off` 构建 | 本地 `go.work` 把 `pluginapi` 编成 `(devel)`，与按 tag 构建的发布物 sha 不同 | 构建/`dist` 统一加 `GOWORK=off`；发布前干净 clone 复验 |
| 环境变量用错名/别名 | 连不上 socket 或身份校验失败 | 只用 `KORE_PLUGIN_ID`/`KORE_PLUGIN_SOCK`/`KORE_PLUGIN_TOKEN`/`KORE_STATE_DIR`/`KORE_LOG_DIR`；未知变量忽略而非报错 |
| lazy 与 resident 混淆 | lazy 插件 enable 后无进程，误判启动失败 | lazy 首次 invoke 才冷启、空闲 `idle_timeout_s` 后真退出；显式 `resident` 才常驻；`oneshot` 运行期仍 `E_UNSUPPORTED` |
| 生产级缺故障注入 | 升生产级被拒（G-20） | 补 `tests/fault/` 四类：kill -9、超时、磁盘满、cgroup 超限，各 1 例并进 CI |
| 依赖越界 | 构建期直接失败或门禁拒绝 | 只依赖 `pluginapi`；禁 import `kore/internal/*`（Go internal 规则编译期拒绝），禁 Web 框架/gRPC/NATS/Redis 客户端 |

## 7. 验收清单（30 分钟自检 8 条）

在插件仓根目录依次执行，全部退出码 0 才算跑通：
```bash
gofmt -l .                                          # 1. 无输出
go vet ./...                                        # 2. EXIT 0
go test -timeout 200s ./...                         # 3. EXIT 0
GOWORK=off go build ./...                           # 4. 冷构建 EXIT 0
make dist                                           # 5. 出 tar.gz + .sha256
tar -tzf dist/hello-0.1.1.tar.gz | head -n 1        # 6. 首条目必须 info.json（不能 ./）
sha256sum dist/hello-0.1.1.tar.gz; make dist; sha256sum dist/hello-0.1.1.tar.gz  # 7. 两次 sha 逐字相同
go test -run TestHello -v ./...                     # 8. hello 往返 EXIT 0
```
第 8 条可在 echo 仓握手测试基础上改：用 `net.Pipe` 造一对连接，客户端发 `kore.hello`、服务端回 `{"type":"response","id":<同值>,"result":{"ok":true,"protocol":"kore.plugin.v1"}}`，客户端校验三项通过——记得每个写请求配对读一次响应（§5）。八条全绿即达成「第三方按文档 30 分钟跑通 hello」。
