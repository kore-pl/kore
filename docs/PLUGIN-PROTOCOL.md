# 插件协议（kore.plugin.v1）

> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

本文件是 kore 插件协议的**唯一来源**：帧格式、握手、方法、事件、错误码、超时、心跳与热升级时序以本文为准。架构与实现（`pkg/pluginapi/`、`internal/core/bus/`、`internal/core/supervisor/`）与本文冲突时，先改本文（走 `docs/DECISIONS/` 的 ADR），再改代码。资源侧参数见 [RESOURCE-MODEL.md](./RESOURCE-MODEL.md)，持久化字段见 [DATA-MODEL.md](./DATA-MODEL.md)。

## 1. 设计目标与不目标

### 1.1 目标

1. **进程隔离下的最小契约**：插件是独立进程，只依赖 UDS + 4 字节长度前缀 + JSON，不引入 RPC 框架；内核与插件可各自升级、各自被替换。
2. **可手工调试**：任何一帧都能用 20 行脚本构造并打印；字段自描述，抓包即可读，不需要 `.proto` 描述文件与代码生成（M3 引入 protobuf 时保留 JSON 回退）。
3. **可演进**：加字段只允许可选、加事件只增不改、删改字段必须升主版本；主版本不匹配时拒绝加载，不做猜测兼容。
4. **资源与故障可控**：单帧上限 8 MiB、单次调用默认 15s、心跳 10s 三级判死，内核可单方面终止任何不响应的插件进程。

### 1.2 不目标

1. 不做传输层多路复用与流式帧：MVP 只有一问一答 + 单向事件；SSE 在 HTTP 层（`/api/v1/events`），不进入插件协议。
2. 不做插件间直连：插件 A 不得连接插件 B 的 socket，跨插件调用一律经内核 bus 转发并做 capabilities 校验。
3. 不承诺跨主机通信：只监听 UDS；任何 TCP 暴露都不属于本协议，可选 HTTP 监听只服务主壳前端与 CLI。
4. 不做协议层加密与令牌：安全边界由 socket 文件权限（0600）+ 独立系统用户 + capabilities 授权构成，不引入 mTLS/账号体系。

## 2. 插件包布局

### 2.1 来源与产物

插件包由**独立仓库** `kore-plugin-<id>` 的 `make dist` 生成，经该仓库的 GitHub Release 发布；`kore` 仓库不含任何插件源码（R1/R8）。每个 release 固定三类产物：`<id>-<version>.tar.gz`（包体，命名与 info.json 的 id/version 一致）、同名 `.sha256`（`sha256sum -c` 校验，安装强制比对）、可选 `signature`（Ed25519 base64，M4 起强制，见 §2.3）。

包内结构固定：`info.json` + `bin/<id>`（0755 静态二进制）+ 可选 `web/`（标准 ES module，入口 `web/index.js`）与 `signature`，不含源码。

`kore-plugin-<id>` 仓库自带 `Makefile`（R7），`make dist` 固定三件事：`CGO_ENABLED=0` + `GOOS/GOARCH` 交叉编译出 `bin/<id>`、按上面的结构打 `tar.gz`、`sha256sum > <id>-<version>.tar.gz.sha256`。仓库固定含 `main.go`（仅 import `github.com/pengtang1024/kore/pkg/pluginapi`）、`info.json`、可选 `web/`、`Makefile`（`build`/`dist`/`clean`）、`CHANGELOG.md`。

### 2.2 解包与命名规则

| 规则 | 值 | 违反处置 |
| --- | --- | --- |
| id | `^[a-z][a-z0-9-]{0,30}[a-z0-9]$`（2–32 字符、小写、不以 `-` 开头/结尾、不含 `--`，避免 socket/目录/日志文件名拼接后连续连字符歧义），与包名/info.json 一致 | 拒绝安装，`E_INVALID` |
| version | 语义化版本 `MAJOR.MINOR.PATCH`，与包名一致 | 拒绝安装，`E_INVALID` |
| 条目 | 相对路径，无 `/` 开头、`..`、符号链接/设备文件/硬链接；解压总量 ≤ **128 MiB**、条目 ≤ **2000**、单文件 ≤ **64 MiB**（防 zip-bomb），安装到 `/var/lib/kore/plugins/<id>/<version>/`（保留当前 + 上一版本） | 拒绝安装，`E_INVALID` |


### 2.3 校验和与 signature

安装时对 `.tar.gz` 全文件算 SHA-256，与 release 的 `.sha256` 比对，并写入 bbolt `plugins` bucket 的 `package_sha256`；升级请求必须携带同一值，不一致返回 `E_CONFLICT`。`signature` 为 base64 Ed25519，签名对象是**清单摘要**（包内除 signature 外文件按路径字典序拼接 `<path>\0<sha256(file)>\n` 后取 SHA-256）。MVP（M0–M2）由 `plugins.allow_unsigned: true` 允许无签名安装并记 `signed:false`；M4 起 `allow_unsigned:false` 时无签名包一律 `E_UNAUTHORIZED`。

## 3. info.json

### 3.1 字段表

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| id | string | 是 | — | 见 §2.2 正则；与包名一致 |
| name | string | 是 | — | 1–64 字符，展示名，中文允许 |
| version | string | 是 | — | 语义化版本，与包名一致 |
| protocol | string | 是 | — | MVP 只接受 `kore.plugin.v1` |
| requires_kore | string | 是 | — | 语义化区间，如 `">=0.1.0 <0.2.0"`（R3）；kore 加载时对照自身版本，不满足 → 拒绝加载并回 `E_UNSUPPORTED` |
| lifecycle | string | 否 | `lazy` | `resident` \| `lazy`（默认，G-14）\| `oneshot`（原 `type` 字段名废弃）；缺省即 lazy，显式 resident 才常驻 |
| idle_timeout_s | int | 否 | `60` | 仅 `lifecycle=lazy` 生效，范围 60–1800；其它 lifecycle 传值忽略并 WARN |
| entry | string | 是 | — | 相对包根的可执行路径，固定 `bin/<id>` |
| capabilities | string[] | 是 | — | 两层：6 个特权能力 + 插件自有 `<id>:<action>`（见 §3.1.2）；**非空：至少 1 项、上限 16 项** |
| resources.memory_mb | int | 是 | — | 4–12（常驻与活跃 lazy 上限 12，见 RESOURCE-MODEL） |
| resources.cpu_quota | string | 是 | — | `"10%"`–`"100%"`，映射 `cpu.max` |
| resources.pids_max | int | 是 | — | 16–512 |
| triggers | string[] | 是 | — | 元素 `<type>:<name>`，`type` ∈ `event` \| `schedule` \| `invoke`；`event` 的 `name` 匹配 `^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$`；`invoke` 允许单段动词或任意段点分名 `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$`（如 `invoke:restart`、`invoke:site.restart`）；`schedule` M1 只校验非空（M2 解析表达式）；缺 `:`、类型不在枚举、name 非法 → `E_INVALID`；空数组合法 |
| depends_on | string[] | 否 | `[]` | 依赖的插件 id；安装时拓扑排序，缺失依赖拒绝安装；循环依赖直接拒绝并回 `E_INVALID`（`detail.cycle` 给环路径） |
| conflicts | string[] | 否 | `[]` | 冲突插件 id；与已装插件冲突时拒绝安装，回 `E_CONFLICT` |
| scenario_tags | string[] | 否 | `[]` | 枚举固定 5 值 `web`/`data`/`ops`/`sec`/`app`（**能力族标签，不等于 preset 名**）；空数组合法（不进商店分类），非空时每值必须在枚举内；写成 `dev`/`minimal`/`full` 等 preset 名 → `E_INVALID` |
| size_bytes | int | 否 | `0` | 由 `make dist` 打包时回填；仓库内可为 `0`；安装后为实际占用字节数（商店展示与磁盘预检），须 ≥ 0 |
| store_visibility | string | 否 | `public` | `public` \| `hidden`（内部依赖插件不出现在商店列表） |
| protocol_minor | int | 否 | 0 | 见 §13 |
| web | `{entry: string}` | 否 | 无 | `entry` 固定 `web/index.js`；无前端时省略 |

> 口径说明：`idle_timeout_s` 默认 60s 为 M2 实现口径（更早释放空闲 lazy 进程，贴合资源零侵占锚点）；配置可设 60–1800，需 300s 语义时显式配置。

- `requires_kore` 区间语义（R3）：MVP 只支持 `">=X.Y.Z <A.B.C"` 与 `">=X.Y.Z"` 两种写法；不支持 `^`/`~`/`||`；解析器用标准库自实现，不引第三方库（G-02）。
- 匹配规则：按 semver 比较 kore 版本；kore 版本含预发布号（如 `0.2.0-rc.1`）时拒绝匹配（MVP 不认 pre-release）。
- 失败行为：不匹配 → 拒绝安装/加载并回 `E_UNSUPPORTED`，`message` 同时带 kore 版本、`requires_kore`、`<id>@<version>`。
- `scenario_tags` 与 preset 是两套机制：tag 是能力族标签（5 值固定），**preset 按 `kore-plugins/presets/<id>.json` 的插件 id 列表装配，不按 tag 匹配**；tag 只作商店分类/搜索与预设编辑器筛选提示。
- 与 `protocol` 的关系：`protocol` 是协议主版本、`requires_kore` 是内核版本区间，两者都要过；`protocol` 不变而 `requires_kore` 收窄是合法发布。REPOS 版本矩阵（0.2.x → `">=0.1.0 <0.3.0"`、1.0.x → `">=0.1.0 <2.0.0"`）符合上述规则。
- **必填口径（与代码逐字对齐）**：**9 个必填** = `id` `name` `version` `protocol` `entry` `capabilities` `resources` `requires_kore` `triggers`；**3 个可选** = `lifecycle`（缺省 `lazy`，G-14）、`scenario_tags`（缺省 `[]`）、`size_bytes`（缺省 `0`，`make dist` 回填）；依据 `internal/core/registry/manifest.go` 的 `requiredKeys`。

### 3.1.1 依赖解析（安装时）

1. 读取 `depends_on` 构建 DAG（节点 = 插件 id，边 = 依赖 → 被依赖），同时把 `conflicts` 与已装集合求交，有交集即拒绝并回 `E_CONFLICT`。
2. 检测环：DFS 三色标记，发现回边立即拒绝并回 `E_INVALID`，`detail.cycle` 给出环路径（如 `a → b → a`）。
3. 按拓扑序安装（同层按 id 字典序稳定排序）；依赖缺失回 `E_NOTFOUND`，版本不满足 `requires_kore`/`depends_on` 版本区间回 `E_UNSUPPORTED`。
4. 任一步失败按 SCENARIOS.md 的回滚策略处理已装部分；协议侧只提供钩子——`kore.hello` 成功前不标记 `installed`，失败时内核删除刚装目录并恢复 `plugin_state`。

### 3.1.2 capabilities 模型（两层）

**特权能力**（内核唯一白名单，6 个、固定不可扩展）：`system:read` `system:admin` `net:read` `net:write` `proc:read` `proc:write`，对宿主有实际影响，由内核集中校验授权；**插件自有能力** `<plugin-id>:<action>`，域必须等于声明它的插件 id（`site` 可声明 `site:read`，`db-mysql` 不得声明 `site:write`）。

**校验顺序**：语法 `^[a-z][a-z0-9-]{0,30}:[a-z][a-z0-9-]{0,30}$`，非法 → `E_INVALID`；域 ∈ 特权集 → 允许；否则域必须 == `info.json.id`，不等 → `E_INVALID`（message 说明原因）；**必须非空（≥1 项）且 ≤16 项**，空数组、重复项或超限 → `E_INVALID`。**校验点三处**（与 SECURITY §5 一致）：安装校验声明、启用写 `granted_capabilities`、调用时 bus 方法级校验。

**设计理由**：内核不得维护业务域名词表——只认识 6 个宿主级特权能力 + 通用语法，其余归插件自治；新增插件永远不需要改内核。

### 3.2 resident 示例（site）

```json
{
  "id": "site", "name": "站点管理", "version": "0.1.0",
  "protocol": "kore.plugin.v1", "requires_kore": ">=0.1.0 <0.2.0", "lifecycle": "resident",
  "entry": "bin/site",
  "capabilities": ["site:read", "site:write", "net:read"],
  "resources": { "memory_mb": 10, "cpu_quota": "50%", "pids_max": 128 },
  "triggers": ["invoke:site.list"],
  "depends_on": [], "conflicts": [], "scenario_tags": ["web"], "size_bytes": 31457280, "store_visibility": "public",
  "description": "静态站点与反向代理配置管理",
  "web": { "entry": "web/index.js" }
}
```

### 3.3 oneshot 示例（backup）

```json
{
  "id": "backup", "name": "备份执行器", "version": "0.1.0",
  "protocol": "kore.plugin.v1", "requires_kore": ">=0.1.0 <0.2.0", "lifecycle": "oneshot",
  "entry": "bin/backup",
  "capabilities": ["system:read", "backup:run"],
  "resources": { "memory_mb": 8, "cpu_quota": "100%", "pids_max": 256 },
  "triggers": ["invoke:backup.run", "schedule:daily@03:00"],
  "depends_on": [], "conflicts": [], "scenario_tags": ["data", "ops"], "size_bytes": 20971520,
  "description": "按计划执行一次性备份任务，执行完退出"
}
```

## 4. 帧格式

### 4.1 布局

```text
+-----------------------------+--------------------------------+
| length (4B BE unsigned u32) | JSON payload (length 字节)     |
+-----------------------------+--------------------------------+
```

一帧 = 4 字节大端无符号长度 + 该长度的 UTF-8 JSON 载荷，**没有任何额外帧头字节**；`length = len(payload)`，不含长度字段自身 4 字节。所有帧的载荷都是一个完整 JSON 对象（无 BOM、无尾随字节），帧类型写在 JSON 的 `type` 字段里，而不是帧头。

### 4.2 类型枚举

| type 值（JSON 字符串） | 方向 | 含义 |
| --- | --- | --- |
| `request` | 双向 | 方法调用请求，见 §7.2 envelope |
| `response` | 双向 | 方法调用响应：`{type,id,req_id,result}` 或 `{type,id,req_id,error}`（回显请求 `req_id`） |
| `event` | 插件→内核 | 单向事件，见 §8 envelope |
| `ping` / `pong` | 双向 | 传输层探活与应答：`{"type":"ping","ts":<unix 纳秒>}`，pong 原样回填 ts |

`ping`/`pong` 同样必须是 JSON 对象，不存在「空载荷」形式；`ping/pong` 是传输层探活，`kore.ping` 是应用层方法（内核 bus 发起、插件返回自身状态），两者不可互相替代。

### 4.3 上限与超限处理

- 上限：`length ≤ 8,388,608` 字节（8 MiB，指整个 JSON 载荷），不存在「扣掉帧头」的口径；`encoding=json` 会话下帧载荷最小 **2 字节**（`{}` 才合法），`0`/`1` 字节直接拒绝，M3 protobuf 会话按连接编码放宽；接收侧读满 4 字节后先判断，超限**不读 payload** 并立即 `close(conn)`、WARN `frame_oversize`，该次调用回 `E_INVALID`（400）；单帧须 15s 内读完，否则按失联处理（§11）。发送侧编码前检查，超限不写字节直接返回 `E_INVALID`。

## 5. kore.hello 握手

插件进程启动后 2s 内必须 `connect` 到 `/run/kore/plugins/<id>.sock` 并发送第一帧，首帧必须是 `kore.hello` 请求；否则内核关闭连接、杀进程、状态置 `failed`。

请求：

```json
{"type":"request","id":"01JC8Q2F9K3M4N5P6Q7R8S9T0V","method":"kore.hello","params":{
  "plugin_id":"site","version":"0.1.0","protocol":"kore.plugin.v1","requires_kore":">=0.1.0 <0.2.0",
  "pid":12345,"capabilities":["site:read","site:write"],
  "started_at":"2026-11-21T20:40:15.123+08:00"}}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| plugin_id | string | 是 | 必须与内核登记 id 一致，否则 `E_UNAUTHORIZED` |
| version | string | 是 | 插件版本，与 info.json 一致 |
| protocol | string | 是 | 固定 `kore.plugin.v1` |
| requires_kore | string | 是 | 与 info.json 一致；对照内核版本校验区间 |
| pid | int | 是 | 插件进程 pid，内核用 `SO_PEERCRED` 交叉校验 |
| capabilities | string[] | 是 | 必须 ⊆ info.json 声明，超集拒绝 |
| started_at | string | 是 | RFC 3339 带毫秒与时区 |

响应（内核→插件）：

```json
{"type":"response","id":"01JC8Q2F9K3M4N5P6Q7R8S9T0V","result":{
  "ok":true,"kernel_version":"0.1.0","protocol":"kore.plugin.v1",
  "protocol_minor":0,"encoding":"json","session_id":"s-01JC8Q2G...","heartbeat_interval_s":10,
  "methods":[{"name":"site.list","idempotent":true,"timeout_ms":15000}]}}
```

- `methods` 为可选能力表：只有在此声明 `idempotent: true` 的业务方法才允许内核自动重试（§10）；`encoding` 声明本连接编码（MVP 恒为 `json`，M3 可为 `protobuf`）。协商顺序固定：`requires_kore` 可解析 → kore 版本落在区间内 → `protocol` 主版本匹配 → 平台身份校验（peercred 或 HMAC，§17）→ `capabilities` ⊆ `info.json` 声明 → 登记路由；任一步失败回 `E_UNSUPPORTED` / `E_UNAUTHORIZED` 并 SIGKILL 不进入 ready（防 kore 降级）。握手超时 2s，超时或出错杀进程置 `failed`，`session_id` 每次启动唯一、重启后旧 session 作废。

## 6. 生命周期状态机

状态集合与 ARCHITECTURE.md §7 同名：`installed`、`enabled`、`starting`、`ready`、`degraded`、`stopping`、`stopped`、`failed`；升级不新增状态——新进程走 enabled→starting→ready、旧进程走 ready→stopping（§12），registry 的 `upgrade_in_progress` 标记不参与状态机。

| 从 | 到 | 触发者 | 动作 | 超时 | 失败去向 |
| --- | --- | --- | --- | --- | --- |
| installed | enabled | 运维 `POST /plugins/{id}/enable` | 校验 info.json、capabilities 声明合法（§3.1.2）、签名策略，写 `plugin_state.desired=enabled` | — | 保持 installed |
| enabled | starting | supervisor（enable / autostart / 退避重启） | 建 cgroup、以 `kore-<id>` 拉起 `bin/<id>`、主壳创建 socket | 进程创建 3s | failed |
| starting | ready | supervisor | 2s 内收到合法 `kore.hello`，登记 bus 路由 | hello ≤ 2s | failed（SIGKILL，10 分钟内不自动重试） |
| ready | degraded | supervisor | ping 连续 3 次超时（10s 周期、单次 2s）→ 暂停新调用路由（503 + `E_UPSTREAM`），继续探测 | 30s | — |
| degraded | ready | supervisor | 任一次 ping 成功，恢复路由、计数清零 | 2s | 保持 degraded |
| degraded | starting | supervisor | 60s（6 次）无任何响应 → 退避重启 1/2/4/8/16/32/60s | 60s | 10 分钟内 5 次超限 → failed |
| ready/degraded | stopping | supervisor（disable / stop / upgrade / 关机） | 停止路由，发 `kore.shutdown`，等在途调用结束 | 优雅 5s | SIGKILL 后 stopped（记 `killed=true`） |
| stopping | stopped | supervisor | 进程退出（0 或 SIGKILL），清 socket、cgroup、run.json | 5s + 1s | failed |
| stopped | starting | supervisor（enable） | 清退避计数后重新拉起 | — | failed |
| failed | starting | 运维显式 `POST /plugins/{id}/enable` / 重装 | 清除 `failed_reason` 与退避计数 | — | 保持 failed |

规则：`failed` 不自动重试，避免崩溃循环耗尽宿主；重启上限 5 次 / 10 分钟，超限即 `failed` 并在 `/system/info` 暴露 `last_error`；运维卸载从 `installed` 直达 `stopped`（删包与状态，无进程可停）。lazy 额外路径：`idle`（进程不存在）→（唤醒）`starting` → `ready` →（`idle_timeout_s` 到）`draining` → `stopped(idle)`，对外展示 lazy-idle 且不计入常驻进程数；唤醒源 = 业务方法调用 / 事件订阅命中 / 显式 `POST /api/v1/plugins/{id}/enable`。

冷启动约束：插件 init 阶段不得建立网络/数据库连接、不得扫描大目录；从 exec 到 `kore.hello` 完成 p95 ≤ 300ms，超时判启动失败（SIGKILL + `failed`），lazy 唤醒同样适用。

## 7. 方法表

### 7.1 必选方法

| 方法 | 方向 | 参数 | 返回 | 超时 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| kore.hello | 插件→内核 | §5 请求字段 | §5 响应字段 | 2s | 否（重连必须重新握手） |
| kore.ping | 内核→插件 | `{}` | `{status:"ready",uptime_s,goroutines,rss_kb}` | 2s | 是 |
| kore.shutdown | 内核→插件 | `{reason,grace_ms}`（默认 `grace_ms=5000`） | `{ok:true}` | 5s 等待进程退出，超时 SIGKILL | 否；重复调用直接返回 `ok` |
| kore.reload | 内核→插件 | `{reason:"config",config_digest}` | `{ok:true,config_digest}` | 10s | 是（同入参可安全重放） |

`kore.reload` 只重读插件自身配置，不允许更换版本、不允许改 capabilities；失败时插件必须保持旧配置继续服务（不允许半加载状态）。协议面口径为「**4 个必选方法 + 1 条必选事件通道**」：方法 = hello/ping/shutdown/reload，事件通道 = `kore.event`（`type` 固定 `event`，是帧类型而非方法）。

### 7.2 业务调用 envelope

```json
{"type":"request","id":"01JC8Q3A7B8C9D0E1F2G3H4J5K","req_id":"r-01JC8Q3A","method":"site.list",
 "params":{"domain":"example.com"},"timeout_ms":15000}
```

- `id`：连接内请求标识，32 位小写 hex（16 字节随机），内核生成、插件原样回填，同一连接并发按 id 匹配且不得复用；**编解码层不解析 `id` 语义（只搬运），生成与校验归 `bus`**——M3 protobuf 复用同一入口时不做语义解析。`method`：`<plugin>.<verb>`，`<plugin>` 必须等于自身 id，跨插件名 `E_NOTFOUND`，`kore.*` 业务入口一律 400 `E_INVALID`。
- `req_id`：**跨进程追踪标识**（HTTP 侧生成并透传，如 `r-01JC8Q3A`）：请求帧必带，响应帧必须原样回显；`id` 只用于连接内匹配，两者不得混用或互相替代。
- Response 固定字段：`type`、`id`、`req_id`（**必填回显，必须与请求一致**）、`result` 或 `error` 二选一；缺 `req_id` 视为协议违规，调用方按 `E_INVALID` 处理。
- `params`：JSON 对象，缺省为 `{}`；业务字段由插件定义，必须可向后兼容（加可选字段）。`timeout_ms`：缺省或 `<= 0` 一律视为**未设置**、取默认 15000；有效范围 1000–120000，越界按边界夹取（下限 1000、上限 120000），由调用方在截断处打 WARN（SDK 本身不写日志）。统一入口：HTTP `POST /api/v1/invoke/{plugin}/{method}`，body 即 `params`；内核组装 envelope 后转发，响应解包为 `{result}` 或 `{error}`。

## 8. 事件类型

插件→内核只有一条事件通道 `kore.event`（单向，`type` 固定为 `event`，不是独立方法）：内核不 ack；`seq` 每连接单调递增（重连从 0 重置），内核按 `ts` 落盘、不保证跨插件全局有序；发送失败或队列满时丢弃并累加 `event_dropped`，**不得阻塞业务调用**。envelope：

```json
{"type":"event","event":"plugin.log","seq":42,"ts":"2026-11-21T20:40:15.123+08:00","data":{...}}
```

- 信封固定字段：`seq`（uint64，每连接单调递增、从 1 开始，用于去重与断点续传，重连归零）、`ts`（RFC3339 字符串，事件产生时间）、`data`（字段由 §8 事件表逐项定义，未登记事件拒绝）。

| 事件 | 方向 | data 字段 | 用途 |
| --- | --- | --- | --- |
| plugin.log | 插件→内核 | `level`(debug/info/warn/error)、`msg`、`fields`(map<string,string>，≤16 键，值 ≤1 KiB) | 写入 `/var/log/kore/plugins/<id>.log`，前缀 `[plugin:<id>]` |
| plugin.health | 插件→内核 | `state`、`rss_kb`、`goroutines`、`last_error` | 供 `/system/info` 与前端展示，不写 bbolt |
| plugin.state | 内核→插件 | `from`、`to`、`reason` | 通知插件自身状态变化（如 disable 前的 stopping） |
| system.event | 内核→插件 | `kind`、`subject`、`detail` | 内核级广播（如证书续期完成、配置重载），订阅由插件在 hello 的 `methods` 外声明 `events: []` |



## 9. 错误码

错误体统一为 `{"code":"E_*","message":"人类可读","detail":{}}`，`detail` 允许为空对象。

| code | HTTP 映射 | 含义 | 调用方处置 |
| --- | --- | --- | --- |
| E_INVALID | 400 | 参数/帧格式非法，含超限帧、非法 JSON | 修参数后重试；不可重试同一请求 |
| E_UNAUTHORIZED | 401 | 未登录、session 失效、capability 不足、签名/来源不符 | 重新登录或申请授权；不重试 |
| E_NOTFOUND | 404 | 插件/方法/资源不存在 | 校正 id/method；不重试 |
| E_CONFLICT | 409 | 状态冲突：升级中/未 ready/重复操作、包 sha256 不符、重复安装 | 重新读取当前状态后决定 |
| E_UPSTREAM | 502 | 仅插件进程无响应/崩溃、连接中断、握手失败 | 可重试（幂等方法）或提示插件不可用 |
| E_INTERNAL | 500 | 内核自身错误（bbolt 写失败、序列化失败） | 不重试，上报并查内核日志 |
| E_UNSUPPORTED | 501 | 协议主版本不符、能力未实现、平台不支持 cgroup | 升级内核或插件；不重试 |
| E_RATELIMIT | 429 | 触发限流（登录、oneshot 并发队列满） | 按 `Retry-After` 退避后重试 |

路由层因插件 `degraded` 主动拒绝时返回 503 + `E_UPSTREAM`（`detail.retry_after_s`）：502 表示调用已发出后失败，503 表示未发出即拒绝，调用方按同一 code 处理。

## 10. 超时与重试

| 场景 | 超时 | 重试 |
| --- | --- | --- |
| 业务调用默认 | 15000ms（envelope 可覆盖，上限 120000ms） | 仅幂等方法，最多 2 次，退避 1s / 3s |
| kore.hello / kore.reload | 2s / 10s | hello 不重试、失败即 failed；reload 幂等，最多 1 次 |
| kore.ping | 2s | 由心跳循环驱动（§11），不算业务重试 |
| kore.shutdown | 5s 优雅期 | 不重试，超时 SIGKILL |
| 单帧读取 | 15s | 不重试，按失联处理 |

重试判定：只有「请求未送达」（`ECONNREFUSED`、写前失败）或方法在 §7 / hello `methods` 中声明幂等时才重试；请求已写出后一律不重试，避免重复执行。重试必须复用同一 `id`，插件可据此去重。HTTP 端到端预算 30s（见 ARCHITECTURE §5.1）包含 bus 15s 调用与路由/序列化开销，两者不是同一指标。

## 11. 心跳与失联判定

- 周期：内核每 10s 向 ready/degraded 插件发一次 `kore.ping`，超时 2s；连续 3 次失败（约 30s）→ 状态 `degraded`，日志 WARN，`/system/info` 可见，仍继续以 10s 周期探测。
- 60s 内无任何成功响应 → 判定失联，supervisor 杀进程并按 §6 走 `starting` 重启；重启上限 5 次 / 10 分钟，超限 → `failed`，不再自动拉起，需人工 enable。oneshot 插件不参与心跳（进程生命周期即调用生命周期），只有执行中超时（§RESOURCE-MODEL §5）。

## 12. 热升级时序

1. `POST /api/v1/plugins/{id}/upgrade`，body `{version, package_sha256}`；升级中/未 ready/重复升级等状态冲突回 409 `E_CONFLICT`，进程崩溃或无响应回 502 `E_UPSTREAM`；校验包 sha256 与签名策略，不符 `E_CONFLICT` / `E_UNAUTHORIZED`；解包到 `/var/lib/kore/plugins/<id>/<new_version>/`，校验 info.json 的 id/version/protocol/requires_kore，失败删目录、旧进程不动并回 `E_INVALID`。
2. 以同一 `kore-<id>` 用户、同一 cgroup 拉起新进程，使用临时 socket `/run/kore/plugins/<id>.next.sock`，等待 `kore.hello`（2s）。起不来或握手失败：SIGKILL 新进程、清理临时 socket 与目录，旧进程不动，回 `E_UPSTREAM`。
3. 切换 bus 路由到新 socket（registry 单写锁内一次替换），尝试 `kore.ping` 确认可用（2s）。失败：路由回切旧 socket，SIGKILL 新进程，回 `E_UPSTREAM`。
4. 向旧进程发 `kore.shutdown{reason:"upgrade",grace_ms:5000}`，等其退出（超时 SIGKILL）；旧 socket 删除、临时 socket 重命名为正式路径、状态 `ready`、记升级审计；删除更早版本目录，保留当前与上一版本并写 `plugin_state.last_upgrade_at`。

回滚兜底：第 3 步之后若新进程在 60s 内心跳失败且重启超限，回滚到上一版本一次（重新走 2–5 步拉起旧版本），仍失败则 `failed` 并暴露错误。升级全过程不允许两个进程同时监听正式 socket，避免请求乱序。

## 13. 版本协商

- `protocol` 字符串只承载主版本：MVP 仅 `kore.plugin.v1`。主版本不匹配（`kore.plugin.v2`）→ 拒绝加载，`E_UNSUPPORTED`，不尝试兼容；协议包 `pkg/pluginapi` 的破坏性改动 = kore 主版本 + ADR + 插件索引标不兼容（R2）。
- 次版本用 `protocol_minor`（int，默认 0）表达：内核 hello 响应返回自身 `protocol_minor`；插件可在 hello 请求 `require_minor` 要求更高次版本，内核不足回 `E_UNSUPPORTED`；未显式要求时按最低公共能力运行，内核忽略未知字段/事件、插件容忍缺失可选字段（读默认值）。
- 编码协商：M3 双编码由 `kore.hello` 的 `encoding` 字段（`json` | `protobuf`）做**会话级**协商；协商成功后该连接后续帧换编码，帧结构不变（仍是 4 字节长度 + 载荷），不设全局编码位。

## 14. 安全约束

- socket 权限：`/run/kore/kore.sock` 与运行目录 0700/0600、属主为主壳运行用户；插件 socket 由主壳（root）创建后 `chown kore-<id>`、0600，仅该插件可读写。内核 `accept` 后用内核凭据（Linux `SO_PEERCRED`、macOS `LOCAL_PEERCRED`、Windows HMAC 见 §17）校验 uid/pid，不符即关闭连接并记审计。capabilities 校验点三处（§3.1.2：安装声明 / 启用授予 / 调用校验）；**supervisor** 另在拉起前按能力收紧用户组、可写目录、cgroup 与出网，运行时与方法级两关都过才放行，缺一即 `E_UNAUTHORIZED`；协议不携带用户凭据、插件不得外报，`net:write` 仅表示允许出网、不表示允许上传遥测。

## 15. 插件 SDK 最小接口

Go 侧（`pkg/pluginapi`，import `github.com/pengtang1024/kore/pkg/pluginapi`；插件仓库只允许依赖该公开包，禁止 import `kore/internal/*`——Go 的 internal 规则在编译期直接拒绝）：

```go
type Handler interface {
	Hello(ctx context.Context, req HelloRequest) (HelloResponse, error)
	Ping(ctx context.Context) (PingResponse, error)
	Shutdown(ctx context.Context, req ShutdownRequest) error
	Reload(ctx context.Context, req ReloadRequest) (ReloadResponse, error)
	Handle(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error)
}
```

echo 插件骨架（约 30 行，`kore-plugin-echo/main.go` 为 M1 验证件）：

```go
func main() {
    h := &echo{}; conn, err := pluginapi.Dial(os.Getenv("KORE_PLUGIN_SOCK")); if err != nil { log.Fatal(err) } // echo.sock
    defer conn.Close(); if err := pluginapi.Handshake(conn, h, "echo", "0.1.0"); err != nil { log.Fatal(err) }
    pluginapi.Serve(conn, h) // 阻塞，读帧→分发→写 response；kore.shutdown 后返回
}
type echo struct{}
func (e *echo) Handle(ctx context.Context, method string, p json.RawMessage) (json.RawMessage, error) {
    if method != "echo.echo" { return nil, pluginapi.ErrNotFound }
    return p, nil // 原样回显 params
}
func (e *echo) Ping(context.Context) (pluginapi.PingResponse, error) { return pluginapi.PingResponse{Status: "ready"}, nil }
```

## 16. 演进规则

1. 加字段必须可选且有默认值；删字段、改语义/类型/枚举含义 → 升主版本（`kore.plugin.v2`），旧版本并存一个 M 周期后下线，各仓库独立 tag、插件不强制跟随 kore（R4）。
2. 事件只增不改：已有事件字段只能追加可选字段，新事件用新 `event` 名；新方法只增（未注册返回 `E_NOTFOUND`），错误码只增且必须给 HTTP 映射与调用方处置；编码只在 `kore.hello.encoding` 内会话级协商，破坏性变更必须先在 `docs/DECISIONS/` 留 ADR。

## 17. 跨平台传输与身份校验

**传输统一 AF_UNIX**：Linux/macOS 用原生 Unix socket；Windows 10 1809+ 由 Go 标准库 `net.Listen("unix", path)` 支持，socket 固定放 `%ProgramData%\kore\run\kore.sock`，**不引 `go-winio`**。Windows < 10 1809 → 拒绝启动，退出码 6（与 RESOURCE-MODEL §3.9 一致）。

**平台身份校验三态（握手顺序中位于 `protocol` 之后、`capabilities` 之前）**：
- Linux/macOS：`accept` 后用内核凭据（Linux `SO_PEERCRED`、macOS `LOCAL_PEERCRED`）取 uid/pid，必须等于登记的 `kore-<id>` uid 与 hello 的 pid，否则关闭连接并写审计。
- Windows：无 peercred，hello **必须**携带 `auth` 字段：`{"plugin_id":"site","nonce":"<32B base64url>","hmac":"<base64>"}`；`hmac = HMAC-SHA256(KORE_PLUGIN_TOKEN, plugin_id|nonce|pid|started_at)`（UTF-8、`|` 分隔、无空格）。token 由主壳 spawn 时经环境变量 `KORE_PLUGIN_TOKEN` 下发，每插件每版本独立、进程启动后不落盘；校验失败关闭连接并写审计。

**插件进程环境变量（唯一名，禁止别名）**：`KORE_PLUGIN_ID`（插件 id）、`KORE_PLUGIN_SOCK`（自身 socket 路径）、`KORE_PLUGIN_TOKEN`（Windows HMAC 密钥；Linux/macOS 也注入但仅用于审计关联）、`KORE_STATE_DIR`、`KORE_LOG_DIR`；旧别名一律删除、禁止再用，插件读到未知变量必须忽略而非报错。

**Windows 同用户残余风险**：Windows 无独立系统用户等价物，同用户进程理论上可读主壳内存；但插件只经 UDS 与主壳通信（无 TCP、无共享内存、无环境变量泄漏 token）、token 进程内不落盘、`%ProgramData%\kore\run\` 的 ACL 仅 SYSTEM/Administrators/服务账户可写。已能读主壳内存的进程早已越过边界，故该残余风险可接受，并在 ADR 记录 M3 复核条件（引入 AppContainer 或独立服务账户时重评）。
