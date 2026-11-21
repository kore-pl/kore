> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: architect · 关联: [PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md)

# ADR-0002: UDS + 长度前缀 JSON，M3 升 Protobuf（不引 gRPC/NATS）

## 背景

主壳与插件之间是请求-响应 + 单向事件，通道是本机 UDS。约束：单二进制 ≤ 25 MiB、主壳依赖上限 3 个（protobuf 仅在 M3 才允许引入）、红线禁止 gRPC/消息中间件。插件可能是非 Go 语言写的，协议必须可手工构造与调试。

## 决策

- 传输：Unix Domain Socket，`/run/kore/kore.sock`（主壳，`0600 root:root`）与 `/run/kore/plugins/<id>.sock`（插件 socket，由主壳 `chown kore-<id>` 后 `0600`）；`/run/kore` 为 `0700 root:root`。
- 分帧：4 字节大端无符号整数长度前缀 + 该长度的 JSON 载荷；**帧上限 8 MiB**，超限立即断链。
- 协议名 `kore.plugin.v1`；**4 个必选方法**（`kore.hello` / `kore.ping` / `kore.shutdown` / `kore.reload`）**+ 1 条必选事件通道** `kore.event`（单向）；业务方法 `<plugin>.<verb>`。
- 错误体 `{code,message,detail}`，`code` 限定 `E_INVALID,E_UNAUTHORIZED,E_NOTFOUND,E_CONFLICT,E_UPSTREAM,E_INTERNAL,E_UNSUPPORTED,E_RATELIMIT`。
- M3 在同一条连接上以 `kore.hello` 协商 `encoding` 字段（`json` | `protobuf`）切换为 Protobuf，**不引入 gRPC 的 HTTP/2 与 IDL 代码生成链**。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| UDS + 长度前缀 JSON | 零依赖、可 `nc -U` 手测、跨语言、帧边界确定 | 报文体积大、无 schema 强约束、手写 codec | 选它：调试成本最低，M0 就能跑 |
| `net/rpc`（gob） | 标准库自带、调用像本地函数 | gob 仅 Go 友好、无跨语言路径、错误语义弱 | 插件要求语言无关，gob 直接出局 |
| gRPC | 强类型、流式、生态成熟 | HTTP/2 栈 + 代码生成 + 依赖体积 | 违反依赖白名单与 25 MiB 预算 |
| NATS / MQ | 天然 pub/sub、解耦 | 常驻中间件进程 | 红线②明令禁止常驻中间件 |
| HTTP/JSON over UDS | 复用 `net/http`、工具链成熟 | 每帧 header 开销、流式事件需 chunked/SSE 语义 | 事件通道要单向推送，HTTP 语义绕；且帧边界不如长度前缀清晰 |
| 换行分隔 JSON（NDJSON） | 无二进制头、`jq` 可读 | 载荷内换行需转义、大帧读取要缓冲扫描 | 二进制安全性与上限控制都更差 |

## 后果

**正面**：主壳与插件在 M0 只用标准库即可互通；协议帧可被 `printf` 手工构造，排障不依赖工具链；8 MiB 上限给了明确的内存上界，解码前即可拒绝；`kore.event` 单向语义避免了请求-响应通道上的伪推送。

**负面**：无 schema 时字段拼写错误只能在运行期暴露；JSON 编解码在大 payload 上 CPU/分配高于二进制；背压要自己实现（写阻塞时如何处理慢消费者）。

**技术债**：M3 双编码并存期需要版本协商与两套 codec 的等价测试；8 MiB 上限对二进制大对象（如备份包）不友好，届时需分块方法而非抬上限。

## 验证方式

```bash
# 帧编解码往返与上限
go test -timeout 200s ./pkg/pluginapi/...                 # 含 8 MiB 边界、超限断链、半包读取
# 手工构造一帧 kore.ping 并读回
printf '\x00\x00\x00\x16{"method":"kore.ping"}' | nc -U /run/kore/plugins/site.sock
# 依赖与中间件
go list -m all | grep -E 'grpc|nats|protobuf' || echo "M0 无 grpc/nats/protobuf"
ss -xlp | grep -E 'kore\.sock|plugins/.*\.sock'            # socket 存在且权限正确
```

## 复审条件

出现以下任一信号即重开：常态帧 > 2 MiB 或需要 > 8 MiB 的单帧；`pprof` 显示 JSON 编解码占主壳 CPU > 5%；插件数量 > 20 且事件广播出现可观测的扇出延迟；M3 引入 protobuf 后发现双 codec 维护成本超过收益（等价测试长期红）。
