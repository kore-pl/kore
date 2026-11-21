> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: lead · 关联: ../PLUGIN-PROTOCOL.md

# ADR-0007: 帧类型放 JSON 信封，编码由 hello 会话级协商

## 背景

同一条 UDS 连接要承载五类帧（request / response / event / ping / pong），并在 M3 从 JSON 切到 protobuf 而不改变连接建立方式。曾有两条更"省字节"的设想：长度前缀后追加 2 字节固定帧头（`frame_ver` + `frame_type`），或把版本与编码压进 1 字节 nibble。两者都会把线格式在 M0 提前固化，并把 8 MiB 上限从"整帧"削成"扣除帧头后的载荷"。

2026-11-21 裁决：帧格式以 [ADR-0002](./0002-uds-length-prefix-json.md) 为准——**4 字节大端长度前缀 + JSON 载荷，不增加任何额外帧头字节**；帧类型放 JSON 信封的 `type` 字段；编码由 `kore.hello` 的 `encoding` 字段做会话级协商。热升级临时 socket 统一为 `/run/kore/plugins/<id>.next.sock`。

## 决策

- 线格式恒为 `[4B BE length][payload]`，`length` = payload 字节数。**帧上限 8 MiB 指整帧载荷**，不存在"扣头后 8,388,606"的口径。
- 帧类型放 JSON 信封：`{"type":"request","id":"...","method":"..."}`；取值 `request`/`response`/`event`/`ping`/`pong`。未知 `type` 回 `E_UNSUPPORTED` 并断开，不做猜测。
- 编码协商：`kore.hello` 请求带 `encoding`（`json` | `protobuf`，缺省 `json`），响应回确认值；协商结果**会话级**生效，成功后该连接所有帧载荷换编码，**帧头结构不变**。未协商或协商失败一律按 JSON 处理。
- **最小载荷随会话编码而异**：`encoding=json` 会话下，合法 JSON 对象至少 `{}` = 2 字节，因此帧载荷 `<2` 直接拒绝（`0` 空载荷、`1` 字节都非法）；`encoding=protobuf` 会话（M3）下最小载荷由 protobuf 语义决定，可能为 1 字节或更小，届时按**连接级编码**放宽该限制，而不是在帧层写死。**帧层不理解语义，只做长度与编码校验**——这也是 `id` 不在编解码层解析的原因。
- `protocol_minor` / `require_minor` 仍是 JSON 信封字段（不是帧头），语义与位置保留在 [PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md) §13，本 ADR 不再单列决定项。
- 热升级：新进程监听 `/run/kore/plugins/<id>.next.sock`，hello 成功后 rename 接管；失败删临时 socket 且旧进程不动。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| 4B 长度 + 2 字节帧头(frame_ver + frame_type) + JSON | 类型与版本一眼可见，不必解析 JSON 即可分流 | 线格式 M0 即固化；8 MiB 语义被削成"载荷减 2 字节"；M3 编码位被迫预埋进帧头 | 被拒：布局提前锁死，且上限口径产生歧义 |
| 4B 长度 + 1 字节 nibble（低 4 位版本 / 高 4 位编码） | 帧头最小，一字节双语义 | 读写都要位运算；可读性差；`nc -U` 排障看不出帧类型 | 被拒：用可观测性换 1 字节，不划算 |
| 4B 长度 + JSON，type 放信封（选） | 零额外字节；可手测；字段可增可忽略 | 每帧多约 10 字节 `type` 开销；解析后才知类型 | 选它：解析成本换取线格式可演进 |
| NDJSON（换行分隔 JSON） | 无二进制头，管道工具友好 | 载荷内换行需转义；上限控制靠扫描而非读长度前缀 | 被拒：二进制安全与上限控制都更差 |

## 后果

**正面**：线格式与 ADR-0002 完全一致，M0 可用 `printf` 手工构造帧；M3 切 protobuf 不触碰帧头与长度语义；帧类型可扩展（新增只需加枚举值，老实现按未知 `type` 明确拒绝）；8 MiB 只有一个口径。

**负面**：每帧多 `type` 字段约 10 字节；必须先解析信封才能分流，无法在解析前按固定头丢弃；载荷非 JSON 时类型不再自描述，只能依赖连接级协商结果。

**技术债**：编码变成连接级状态，断线重连必须重新协商，supervisor 与 bus 都要维护"连接 → encoding"映射并在关闭时清理；JSON 信封的 `type`（传输层）与 `kore.event` 的 `topic`（业务层）语义相邻，文档必须防混用；帧格式与 `.next.sock` 的正文冲突已于 2026-11-21 同步完成（[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md) §4 现为 `4B 长度 + JSON 信封`、§12 为 `.next.sock`）；M3 引入 protobuf 时需补双编码等价测试，且必须覆盖"双编码下最小载荷与空载荷"，防止 JSON 会话的 2 字节假设泄漏到 protobuf 路径。

## 验证方式

```bash
# 线格式：长度前缀等于 payload 字节数，无 2 字节头偏移
printf '\x00\x00\x00\x0f{"type":"ping"}' | nc -U /run/kore/plugins/site.sock   # 应回 pong
# 8 MiB 整帧口径（8,388,608 收 / 8,388,609 断，无 -2 偏移）
go test -timeout 200s ./pkg/pluginapi/... -run TestFrameLimit
# 编码协商：hello 带 protobuf 在 M0 回落 json（或 E_UNSUPPORTED），帧头不变
go test -timeout 200s ./pkg/pluginapi/... -run TestEncodingNegotiation
# 未知 type 拒绝
printf '\x00\x00\x00\x10{"type":"bogus"}' | nc -U /run/kore/plugins/site.sock
```

## 复审条件

出现以下任一信号即重开：M3 需要同连接多编码并存（而非二选一）；帧类型多到 `type` 字段占比不可忽略（> 5% 帧长）；出现"不解析即可按类型分流"的硬需求（如背压时丢 event 保 request）；协议正文与 ADR-0002 的帧格式再次分叉；protobuf 路径出现 JSON 会话 2 字节假设的残留（例如把"空载荷非法"硬编码进编解码层）。
