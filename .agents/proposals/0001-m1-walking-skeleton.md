> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M1

# 提案：0001 · M1 Walking Skeleton（Linux 最小闭环 · 三平台分层）

## 0. 背景与证据

- M0 已实质完成，唯一真门禁是 `make docs-check`（[AGENTS.md](../../AGENTS.md) §5）；`make check` 现在 1/4、4/4 真跑，4/4 曾因 `.agents/verify/` 自命中红过一次（AGENTS.md 已记待修，非本提案引入）。
- M1 的目标、交付物、退出条件、"明确不做"已在 [ROADMAP §5.2](../../docs/ROADMAP.md) 写死。本提案**不新增业务范围**，只做三件事：把退出条件拆成可派任务、把三个不确定性的证伪方式写死、把 lead 已裁决的**三平台分层 + 降级矩阵 + 内存口径**落成可执行判据。
- [red-team 预验尸](../reviews/0001-m1-premortem.md) 13 条已逐条应答：F-01→§4.6/§8、F-02/F-03→§4.5、F-04/F-05→§4.2、F-06/F-07→§4.3、F-08/F-09→§4.4、F-10→§4.1、F-11→M1-11、F-12→§4.4、F-13→§4.0；不采纳 3 条见 §4.1（rc 路线）与 §11 D-11（门禁编号、1 KiB 壳页），均附反证。
- 兼容性是 **G-16 门禁**不是建议：`internal/core` 不得直接调平台专有 API，`syscall`/`os/signal` 平台分支必须收在 `internal/platform`。帧/方法/超时/路径数字引用 [PLUGIN-PROTOCOL](../../docs/PLUGIN-PROTOCOL.md)、[CORE](../../docs/CORE.md)、[ARCHITECTURE](../../docs/ARCHITECTURE.md) 原文。

## 0.1 开工前置（裁决已定，按此开工，不再等裁决）

- **replace 两类分治**：同仓库根 `go.mod` `require .../pkg/pluginapi v0.1.0` + `replace => ./pkg/pluginapi` **必须提交**（只对主模块生效、下游忽略，Go 标准做法）；跨仓库 `replace => ../kore/...` **不得提交**，只放顶层 `go.work`。CI 只拦 `=> ../` 与绝对路径，不拦 `=> ./`；M1-02 不阻塞。
- **hello 两层时限**：**2s 硬超时**＝exec→hello 完成，超时 SIGKILL 且计入重启次数；**300ms 是冷启动 p95 SLO**＝发起调用→ready，超出只记「性能不达标」、不算失败。两者不可混用。
- **platform 桩边界**：`!linux` 下只允许 ≤5 行 `New()` 返回 `ErrUnsupported`，禁止更宽的空壳；超 5 行即按 G-01 无用代码处置。
- **启动就绪边界**：kored 进程启动 → `GET /-/healthz` 返回 200 即 ready，**不含**任何插件 ready（插件 lazy、按需拉起）；冷启动耗时另计（p95 ≤300ms SLO），**不与启动就绪混算**。
- **安装两入口共用 installer**：首装 `kored install --scenario <id> [--offline-dir] [--yes]`（面板尚不存在，必须 CLI）；运行期 `POST /api/v1/store/install` + `GET /store/jobs/{id}`；两者共用同一 `installer` 模块（预设解析 / sha256 / 依赖拓扑 / 回滚），CLI 只是 HTTP 的薄包装，不得各写一套。M1 落 `--package` 路径，`--scenario` 与预设同批 M2（ADR-0012）。

## 1. 目标与判据（三个不确定性）

| # | 不确定性 | 证明成功（命令级判据） | 判为失败 | 失败后的处置 |
| --- | --- | --- | --- | --- |
| ① | 单二进制 ≤25 MiB 且空载 RSS ≤8 MiB | `stat -c%s bin/kored` ≤26214400；`GOGC=100`（默认臂）与 `GOGC=200`（对照臂）各采 60 点中位数 ≤8192 KiB；`RssAnon ≤5120` / `RssFile ≤2048`（优先 `smaps_rollup`，缺失回退 `status` 并标注来源；Tier A 下限 4.18 恒有 smaps_rollup）；空载 60s CPU ≤60ms、goroutine ≤20、fd ≤64、出站 0 | 体积超限；任一组中位数 >8192；只有单点采样/只有对照臂一组；空闲项任一超限 | 默认口径 `GOMEMLIMIT=6 MiB` + `GOGC=100`；仍超降 `GOGC=50`；再超砍 embed 与启动全表扫描，**不改阈值** |
| ② | UDS 帧编解码 + supervisor 生命周期能否跑通 | 4 个必选方法全通；`kill -9` 后 ≤5s 新 pid 且 ping 200；半包/粘包/`8388608`/`8388609`/0/1 全绿 | 恢复 >5s；分片用例偶发失败；超长帧后连接或内存残留 | 恢复慢 → 崩溃检测走 `cmd.Wait()` 而非 ping 超时；分片 → `io.ReadFull`；超长 → 先判长度、**判定前只有 4 字节栈缓冲** |
| ③ | 跨仓库依赖能否**只靠 `pkg/pluginapi` 的 tag** 在干净目录成立 | 无同级 kore、无 `go.work`、无 `replace` 时 `go mod download && make dist` 成功；`go list -m all` 只有 `.../pkg/pluginapi`；`git ls-files \| grep -c go.work` = 0 | 依赖 `replace ../kore` 或 `go.work`；或依赖不存在的 tag | 协议包**嵌套 module 独立 tag** `pkg/pluginapi/v0.1.0`（§4.1）：冻结协议 → 发 tag → echo 再依赖；不用 rc |

| 平台（资源判据按平台分期） | M1 | M2 起 |
| --- | --- | --- |
| linux/amd64 | 体积 + RSS + idle 全卡（G-03/G-06/G-14） | 同 M1 |
| linux/arm64 | 仅要求交叉编译通过（资源判据 **M1 不适用**） | QEMU 跑 `make mem`/`make idle`，进里程碑门禁 |

**最容易假通过四坑**：① RSS 把 echo 算进主壳（G6 只认 `kored` 的 pid，空载进程数 = 1 主壳 + 0~3 常驻）；② 就绪用 `sleep 1 && curl` 单点（必须轮询 + 中位，§11 D-2）；③ module cache 让"改 `internal/core` 不影响 echo"天然为真（必须 `go.work` 同源改符号 + `go list -deps` + 干净目录 tag 验收）；④ `kill -9` 只看进程存在（必须 pid 变化 **且** ping 200）。

## 2. 范围

### 2.1 In scope（多一行都算膨胀）

| 仓库 | M1 只做这些 |
| --- | --- |
| `kore` | 根 `go.mod` + `pkg/pluginapi/go.mod`（嵌套 module）；`cmd/kored`（`serve`/`--install`）；`internal/core/{config,envprobe,store,httpapi,auth,supervisor,bus,registry}`；**`internal/platform`（五接口 + Linux 实现）**；`web/` 暗色壳 + `go:embed dist`；`/-/healthz` 与 `/api/v1/{auth/login,auth/logout,self,plugins,system/info,invoke/{plugin}/{method},events}`；插件生命周期（拉起→hello→ping→shutdown/reload→崩溃退避）；`Makefile` 的 build/vet/test/mem/mem-matrix/compat-info/idle/check/repo-check 转真跑；`scripts/{m1-accept,compat-smoke}.sh` |
| `kore-plugin-echo` | `main.go`、`info.json`（含 `requires_kore` + §2.3 四预留字段）、`Makefile`（`build`/`dist` → tar.gz + sha256）、`CHANGELOG.md`、≤20 行 `AGENTS.md` 指针（R5）；go.mod 只 `require .../pkg/pluginapi` |
| `kore-plugins` | 空 `index/plugins.json`、`index/schema.json`（含 §2.3 四字段）、`scripts/validate.sh` |

### 2.2 Out of scope

| 不做 | 归属 | 理由（详见 §10） |
| --- | --- | --- |
| cgroup v2 **强制**（`enforce=true`）/ `kore-<id>` 系统用户 | M3 | M1 只做探测 + 降级 + 只监控（§5） |
| Windows / macOS 运行时实现、服务注册、notarization/Authenticode | M2/M3 | M1 只定义五接口 + Linux 实现（§4.7） |
| 包签名（ed25519） | M4 | 密钥管理不在 M1；`plugins.allow_unsigned=true` 是既定默认 |
| 前端插件加载 / 插件中心 UI / `site` / `backup` | M2 | M1 只有手写壳页；echo 无 `web/`，`import()` 注入无从验证 |
| `POST /plugins` 上传安装 / 商店安装 UI（32 MiB body、zip bomb、异步任务） | M2 | M1 用 `kored install --package`；两入口共用 `installer`（§11 D-6） |
| 热升级、全发行版矩阵、OpenRC unit、SELinux 策略包、日志轮转、备份恢复 | M2/M3 | M1 跑 2 个容器 smoke + 探测单测（§5） |

### 2.3 产品级 scope 预留（v1 对标宝塔/1Panel 专业版：18–22 插件 + 8 预设 + 商店；M1 不实现，但接口必须留对）

- **`info.json` 预留四字段** `depends_on` / `conflicts` / `scenario_tags` / `size_bytes`：M1 只解析并透传（不实现依赖安装、冲突解决、商店筛选）；按 G-17，`kore-plugin-echo` 也必须写全（空数组 + `dist` 回填的 `size_bytes`）。
- **插件落盘固定 `/var/lib/kore/plugins/<id>/<version>/`**（多版本并存）：商店更新要"新旧并存 + 原子切换"，M1 安装即按此布局，**不建 `<id>/current` 软链**（软链让回滚变复杂）。
- **内核不硬编码任何插件 id**：`plugins.autostart` 默认 `[]`，echo 由 `--install` 显式装入；`internal/core` 出现插件名字面量即 G-01 设计事故。8 个场景预设与商店 UI 属 M2（G-18 / ADR-0012），M1 只保证 `index/schema.json` 已含四字段，避免 M2 改协议。

## 3. 任务拆解（1–2h 粒度，owner = implementer 除非另注）

| ID | 任务 | 仓库 | owner | 产出 | 验收方式 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| M1-00 | **口径冻结**：F-13 七处冲突取严，只改唯一真源 | kore | architect + scribe | 小 diff + `CS-20261121-01` 登记 | `grep -rl '保留 30 天\|保留 90 天' docs \| wc -l` = 1；`autostart` 默认 `[]` | — |
| M1-01 | 帧编解码：4B BE + JSON、8 MiB 上限、先判长度不分配 | kore | implementer | `pkg/pluginapi/frame.go` + 测试 | 往返/分片/粘包/`8388608`/`8388609`/0/1 全绿；`grep -rnE 'make\(\[\]byte, *(n\|length\|size)\)' pkg/pluginapi` = 0 | — |
| M1-02 | 嵌套 module 骨架 + 公开 SDK 面 | kore | implementer | `pkg/pluginapi/go.mod`、`{client,server,types}.go` | `go vet` 通过；假 handler 握手；根 `replace => ./pkg/pluginapi` 生效 | M1-01 |
| M1-03 | config：默认 + YAML + 未知键 WARN + 校验错误一次报 + SIGHUP | kore | implementer | `internal/core/config/*.go` | 缺必填→exit 2；未知键→WARN 且继续；坏 YAML→行号 | — |
| M1-04 | store：bbolt 打开 / 6 bucket / schema v1 / 错误分类 | kore | implementer | `internal/core/store/*.go` | 重开库 6 bucket 齐；`schema>1` → `ErrSchemaTooNew` | — |
| M1-05 | auth：PBKDF2、session 落 bbolt、双 cookie 均 `Path=/`、CSRF 常量时间 | kore | implementer | `internal/core/auth/*.go` | 错口令 401；CSRF 缺失 403；`Path=/` 的 `set-cookie` = 2 条 | M1-04 |
| M1-06 | echo 仓脚手架（M1 第一件事）：仓库/go.mod/info.json/CHANGELOG/Makefile | kore-plugin-echo | implementer | 仓库骨架 | `make dist` 出 tar.gz + sha256；`tar -tzf` 只含 info.json/bin/web | — |
| M1-07 | kore-plugins 仓：空索引 + schema + 校验脚本 | kore-plugins | implementer | `index/*`、`scripts/validate.sh` | exit 0；坏 sha256 → 非 0 | — |
| M1-08 | web 壳：暗色 `index.html`（`id="app"`）+ `app.css` + `embed.go` | kore | implementer | `web/dist/*`、`web/embed.go` | `GET /` 200 且含 `id="app"`；dist ≤30 KiB 且无 `.map`/`.vite` | — |
| M1-09 | bus：每插件读写循环、pending map、超时、事件环形缓冲 256 | kore | implementer | `internal/core/bus/*.go` | 超时不串号；断连在途全 `E_UPSTREAM`；100 并发 goroutines ≤20、fd 差 ≤2 | M1-02 |
| M1-10 | registry：12 字段 + §2.3 四预留字段解析 + 安装/启停落库（审计与 IPC 分离事务） | kore | implementer | `internal/core/registry/*.go` | 缺字段/坏区间/降级安装各回对应码；`db.Update` 内无 `bus.` | M1-04, M1-11 |
| M1-24 | lifecycle 三值解析 + `resident` 运行期实现 + 非 `resident` 明确拒绝 | kore | implementer | `registry/lifecycle.go` + 单测 | 三值均能落盘并读回；`lazy`/`oneshot` 的 enable 回 `E_UNSUPPORTED` 且 message 可读（写明 M2 支持） | M1-10 |
| M1-11 | `requires_kore` 解析器（两种写法、拒 pre-release）+ 7 条用例（PLUGIN-PROTOCOL §3.1） | kore | architect + implementer | `registry/semver.go` | `>=0.1.0 <0.2.0` × 5 例 + `>=0.1.0` × 2 例全绿；无 `strings.Compare` | M1-03 |
| M1-12 | supervisor 上半：拉起 / hello 校验 / ping 10s / 退避 1–60s / **starting 也计数** | kore | implementer | `supervisor/start.go` | hello 超时→failed；`exit 1` 替身 60s 内拉起 ≤5 次 | M1-09/10/21 |
| M1-13 | supervisor 下半：`run.json` + 孤儿三步核对 / shutdown→TERM→KILL / socket 残留清理 | kore | implementer | `supervisor/stop.go` | shutdown ≤5s；`kill -9` 主壳后重启 healthz 200、误杀 0 | M1-12 |
| M1-14 | httpapi：8 层中间件链 + 7 端点 + healthz + 错误码映射 | kore | implementer | `httpapi/*.go` | 未登录 401；CSRF 403；未知路由 404；body 超限 413 | M1-03, M1-05 |
| M1-15 | SSE：`GET /events`、`Last-Event-ID` 补发、15s 心跳、64 上限 | kore | implementer | `httpapi/sse.go` | `curl -N` 5s 内见 `event:` 或 `: ping`；断开后 goroutine 回落 | M1-14, M1-09 |
| M1-16 | `cmd/kored` 装配：`serve`/`install` 子命令 + envprobe 前置 + flock + 退出码 2/3/4/5/6 | kore | implementer | `cmd/kored/main.go` | 二次启动 exit 3；只读 state_dir exit 3；伪造 NFS exit 6；`kill -TERM` exit 0 | M1-12/14/21 |
| M1-17 | Makefile 接线：`mem`/`idle`/`budget-check`/`compat-info` 转真跑 + clean-clone/污染检查（PG-01…05） | kore | implementer | `Makefile`、`scripts/` 门禁脚本 | `make budget-check` exit 0（mem+idle+进程数+体积）；`compat-info` 出两次交叉编译 | M1-16 |
| M1-18 | echo `main.go`：Dial/Handshake/Serve + 4 方法 + `echo.ping`→pong + `kore.event` | kore-plugin-echo | implementer | `main.go` | 干净目录 `go mod download && make dist`；装进 kore 后 invoke 返回 pong | M1-02, M1-06 |
| M1-19 | 端到端验收：登录→invoke→kill -9→恢复→RSS 双跑/smaps/形态/空闲 | kore | verifier | `scripts/m1-accept.sh`、`verify/*` | 全流程 exit 0；§8 判据逐项 PASS | M1-17/18/07 |
| M1-20 | 蓝军：超长帧/分片卡死/伪 pid/CSRF/路径穿越/无 systemd | kore | red-team | `proposals/0001-...redteam.md` | 每条可复现，问题单回派 | M1-22 |
| M1-21 | **envprobe**：纯判定层（注入 `Facts`），6 条判定 + capability report + exit 6 | kore | implementer | `internal/core/envprobe/*.go` | 伪造 `Facts` 的 6 条单测；内部零 `syscall`/`os.Statfs` | M1-03 |
| M1-22 | **compat-smoke**：容器内 smoke（启动→healthz→登录→装 echo→invoke→RSS→优雅退出） | kore | implementer | `scripts/compat-smoke.sh` | `--images ubuntu:24.04,alpine:3.19` 2/2 PASS | M1-19/21 |
| M1-23 | **platform 五接口** + 编译期断言 + Linux 实现 + 五接口单测 + `syscall` 收口 | kore | implementer | `internal/platform/*.go` | `GOOS=windows/darwin go build ./...` 通过；`var _ Transport = linuxTransport{}`；`grep -rn 'syscall\.' internal/core \| wc -l` = 0 | M1-21 |

**并行/串行**（WIP ≤5，同波写域不相交）：波 1 = 00/01/03/04/06/07；波 2 = 02/05/09/11/21；波 3 = 10/23/14/08；波 4 = 12/13/15；波 5 = 18/16；波 6 = 17；波 7 = 19→22→20。
**串行主链**：01→02→09→12→13→16→17→19→22；**协议先于插件**：02 冻结 SDK 面 → 打 `pkg/pluginapi/v0.1.0` → 18 用 tag 依赖。**变更集** `CS-20261121-01`：pluginapi tag → echo 跟进 `requires_kore` → 索引更新；kore 正式 tag 在 M1 收尾。；人日：23 条 ≈6.5 人日实现 + 验证/蓝军/7 篇 ADR/文档冻结 ≈4 人日 ≈10.5 人日，低于 ROADMAP 12–18（web 壳手写、不做强制/签名/热升级），差额是缓冲。

## 4. 技术方案要点

### 4.0 M0 遗留口径冻结（M1 第 0 天，一次性小 diff，只改唯一真源）

审计保留取 **90 天**（DATA-MODEL，SECURITY/CORE 改为引用）｜解包上限取 **64 MiB / 1000 条**（PLUGIN-PROTOCOL，回改 CORE 的 128 MiB/2000）｜插件 id 正则取 **`{1,30}`**（SECURITY，回改 PROTOCOL）｜帧信封以 PROTOCOL 为准，**删 CORE 的 `req_id`**｜升级失败统一 **409**（CORE，回改 PROTOCOL 的 502）｜`plugins.autostart` 默认改 **`[]`**｜长事务阈值统一 **500 ms**（CORE，回改 DATA-MODEL）｜`docs-check` 元信息正则改 `里程碑: M[0-4]`｜ADR-0001 的"重开条件 >5 层中间件"按已定 8 层事实改写。

### 4.1 `pkg/pluginapi` 拆嵌套 module + 公开面（M1 冻结；破坏性改动按 R2）

```go
// pkg/pluginapi/go.mod: module github.com/kore-project/kore/pkg/pluginapi
const Protocol = "kore.plugin.v1"
const MaxFrameSize = 8 << 20
type Error struct{ Code, Message string; Detail json.RawMessage }
type Request struct{ Type, ID, Method string; Params json.RawMessage; TimeoutMS int }
type Response struct{ Type, ID string; Result json.RawMessage; Error *Error }
type Event struct{ Type, Event string; Seq uint64; TS string; Data json.RawMessage }
func ReadFrame(r io.Reader, max int) ([]byte, error) // 半包安全，超长先判后退
func WriteFrame(w io.Writer, p []byte) error         // 超长不写任何字节
func EmitEvent(w io.Writer, ev Event) error
func Dial(sock string) (net.Conn, error)
func Handshake(c net.Conn, h Handler, hello HelloRequest) error
func Serve(c net.Conn, h Handler) error
type Handler interface {
	Hello(context.Context, HelloRequest) (HelloResponse, error)
	Ping(context.Context) (PingResponse, error)
	Shutdown(context.Context, ShutdownRequest) error
	Reload(context.Context, ReloadRequest) (ReloadResponse, error)
	Handle(context.Context, string, json.RawMessage) (json.RawMessage, error)
}
```

独立 tag `pkg/pluginapi/v0.1.0`（Go 嵌套 module 子目录 tag 规则）让"协议先发版、插件后依赖"成立，消除 F-10 的 tag 死锁；`requires_kore` 继续**拒绝 pre-release**，不引入 rc 语义（这是对 F-10 预案"先发 `v0.1.0-rc.1`"的不采纳：rc 会污染协议语义，而嵌套 module 已消除死锁）。按 §0.1 落地：根 `go.mod` `require` + `replace => ./pkg/pluginapi` **必须提交**（`replace` 只对主模块生效、下游忽略）。ADR-0011 原写"根 `go.mod` 不 require 它"与 Go 模块语义不符，也与 G-17 允许 `=> ./` 的口径冲突；以 G-17/§0.1 为准，ADR-0011 文本按 G-06 同步修正。SDK 独立 versioning 的代价：破坏性改动要**同时**升 SDK 主版本与 kore 主版本（R13）。

### 4.2 帧编解码（F-04/F-05 的正面回答）

`io.ReadFull(r, hdr[:4])` → `n := binary.BigEndian.Uint32(hdr[:4])` → **立即**判 `n < 2 || n > MaxFrameSize`：不读 payload、不分配、`close(conn)`、WARN `frame_oversize`；判定前只有 4 字节栈缓冲。写：header+payload 拼同一 `[]byte` 单次 `Write` + 每连接互斥锁，否则两 goroutine 的 header 会交错。读循环每帧 `SetReadDeadline(now+15s)`；每插件在途 ≤64，超出 429 `E_RATELIMIT`。`readFrame` 是**唯一**入口，任何地方禁止 `json.NewDecoder(conn)`。

### 4.3 supervisor（F-06/F-07/G-19 的正面回答）

- 每插件一个 actor goroutine + 命令 channel，状态只在 actor 内改、读侧取 snapshot——mutex 保护 8 状态 × 多回调会组合爆炸。
- **退避计数在每次 `exec` 尝试前 +1，无论成败**（只在 ready 后计数会 1s 无限重拉）；稳定 10 分钟清零；10 分钟内 5 次 → `failed`，只能人工 enable。崩溃检测走 `cmd.Wait()` 返回，**不等 ping 超时**（ping 要 30s，判据是 5s）；探活 10s/2s，3 次 → `degraded`（新调用 503 + `E_UPSTREAM`），60s 无响应 → 重启。**hello 时限两层**：2s 硬超时（exec→hello 完成，超时 SIGKILL + 计重启）；300ms 是冷启动 p95 SLO（发起调用→ready），超出只记性能不达标、不判失败。
- 停止：`kore.shutdown` 与 `SIGTERM` 同时发，5s 后 `SIGKILL`，`Setpgid` 杀进程组。socket 残留：bind 前 `Lstat`（拒 symlink）→ unlink 自己 id 的 `*.sock` → bind，绝不碰 `.next.sock`；孤儿判定 = pid 存活 **且** `/proc/<pid>/stat` 第 22 字段相等 **且** `comm` 匹配，任一不符只删 socket。
- **cgroup 写失败不等于启动失败**：每个 cgroup 操作包在 `if cap.CgroupEnforced` 内，失败 → 一次 WARN + `cgroup_enforced=false` + 继续只监控。**除协议要求的 10s `kore.ping` 与退避 timer 外，主壳零定时器、零轮询**（G-19）：状态变化走事件推送，RSS 取 ping 响应的 `rss_kb`，**不设采样器**（30s 轮询会同时踩 G-19 与 8 MiB 预算）。
- M1 **解析并接受** `info.json.lifecycle` 的 `resident|lazy|oneshot` 三值并落盘（G-14 口径，契约先定型），运行期只实现 `resident`：`lazy`/`oneshot` 的 `enable` 回 `E_UNSUPPORTED`，message 固定写明「`lazy`/`oneshot` 由 M2 支持」（明确拒绝，不静默降级）；`resident` 并发 ≤3，第 4 个 `enable` 回 409。注入 env（唯一一套，无别名）：`KORE_PLUGIN_ID` / `KORE_PLUGIN_SOCK` / `KORE_PLUGIN_TOKEN`（每次启动随机 32B hex，Linux 不用它校验，为 Tier B 预置）/ `KORE_STATE_DIR` / `KORE_LOG_DIR` / `KORE_TASK_DIR` / `KORE_PROTOCOL` / `KORE_CAPABILITIES`；删除 `KORE_SOCKET`、`KORE_LOG_FILE`。

### 4.4 config / auth / store / flock（F-08/F-09/F-12 的正面回答）

三层覆盖：默认 → YAML → env（仅 `KORE_CONFIG`、`KORE_STATE_DIR`）。未知键先解到 `yaml.Node` 比对键树 → WARN + 拼写建议（编辑距离 ≤2）→ 继续；类型错/越界/必填缺失 → 收集**全部**错误一次性打 stderr 再 exit 2；SIGHUP 按白名单热替换。
首启口令 `os.Stderr` **直写**（绕开 slog 与镜像逻辑），不回显进 `kore.log`；哈希写回失败即 exit 2 且 `/etc/kore` 必须在 `ReadWritePaths` 内，**绝不复用上次口令**。`kore_session`（`HttpOnly`）与 `kore_csrf`（可读）**都必须显式 `Path=/`**——缺省路径会锁在 `/api/v1/auth`，所有写请求 403；CLI 走 UDS 时按对端 uid 豁免 CSRF 并记 `transport=uds`。
store：`Open(path, 0600, &bbolt.Options{Timeout: 1s})`，单 `Update` 建 6 bucket + `meta.schema_version=1`；schema 高于二进制 → exit 4；**审计/状态写是独立小事务（≤1 ms），`bus.Call` 必须在事务外**，等待表在超时/断连/取消三路都 delete。flock：`LOCK_EX\|LOCK_NB` 失败读 pid + exit 3，**不 unlink**。

### 4.5 embed 与 `web/` 壳（F-02/F-03 的正面回答）

`web/embed.go` 用 `//go:embed dist`（**不用 `all:`**——`all:` 会把 `.vite/`、`.DS_Store`、`*.map` 一起打进来）；`web/dist/index.html`（含 `id="app"`）+ `app.css` 由 M1 手写并**提交**；`make build` 断言产物含 `id="app"`、dist 内 `.map`/`stats.html`/`.vite` 计数为 0；clean clone 的 `go vet ./...` 必须过。这是"缺 dist 怎么构建"的答案：不设 build tag、不留第二条渲染路径。M1 不做 `KORE_WEB_DEV`（无 Vite 可反代），随 M2 引入（ADR-0010）。页面：暗色底 + 登录表单 + `GET /plugins` 列表 + 页脚版本；无框架/npm/CDN，首屏 ≤30 KiB。

### 4.6 内存口径与构建（F-01 的正面回答）

启动时 `debug.SetMemoryLimit(6<<20)`（`GOMEMLIMIT` 已由环境设值时尊重环境，供消融用），`GOGC` 保持默认 **100**。理由：对照臂 `GOGC=200` 让 GC 目标 ≈3× live heap，与 8 MiB 方向**相反**；GOMEMLIMIT 才是软上限，它把 200 的堆目标钳回 6 MiB。兜底 `GOGC=50`（ADR-0013 的资源锚点）。 构建：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$(VERSION)"`（`-buildvcs` 是 build flag，塞进 `-ldflags` 会报 flag 未定义，G-16）；arm64 用 `GOARM64=v8.0`；产物无 INTERP、不链 glibc/musl（Alpine 直接跑，G-16）。

### 4.7 `internal/platform` 五接口（M1 只实现 Linux，但契约先立）

| 接口 | 一句话职责 |
| --- | --- |
| `paths` | 解析并创建运行期落点（FHS vs `%ProgramData%` vs `~/Library`），校验文件系统类型（本地盘/tmpfs/网络盘） |
| `service` | 探测宿主服务环境：init 形态（systemd/OpenRC/无）、cgroup v2 委派、内核与 OS 版本下限 |
| `signals` | 把 `SIGTERM/SIGINT/SIGHUP` 与控制台事件统一成 `Shutdown`/`Reload` 两个通道 |
| `resource` | 限额写入（cgroup v2 / Job Objects）与 RSS 采样（smaps/rusage），不可用时降级为只读观测 |
| `transport` | AF_UNIX 监听/拨号、socket 权限、对端凭据（`SO_PEERCRED` / `LOCAL_PEERCRED` / 无凭据→token） |

为什么 M1 就抽：不抽，M3 会把 UDS、信号、路径、`syscall` 直接写进 `core`，改一个平台要动 supervisor/bus/httpapi 三个包——返工量最大且最容易漏。**过度设计的闸门**：每接口 ≤3 个方法、单实现直调、无注册表/无工厂/无配置驱动选择，`New()` 编译期按 `GOOS` 返回；若 M2 末 `service` 仍只有探测一个方法就并回 `paths`（ADR-0010 复审条件）。M1 不写 Windows/macOS 实现体（§11 D-5 的 `!linux` 三行构造器是唯一例外）。

## 5. 兼容性与降级矩阵

目标：一个静态二进制跑遍 RHEL8→Alpine 3.19（Tier A）；Windows 10 1809+ / macOS 12+ 能用但隔离与限额降级（Tier B）。探测在启动第 2.5 步（config 后、store 前），结果进 capability report 并挂 `/api/v1/system/info`。按 ADR-0009 判定三档：**硬要求缺失 → exit 6**；**软要求缺失 → WARN + 降级**（禁止静默降级）；**通过 → 正常**。

| 能力（Tier A 探测） | 探测方法 | 缺失/不满足时行为 | Tier B · Windows 10 1809+ | Tier B · macOS 12+ |
| --- | --- | --- | --- | --- |
| 内核版本 | `service` 读 `uname` 解析 major.minor，下限 **4.18** | 硬失败 exit 6 | 版本下限另判：<1809 exit 6 | 版本下限另判：<12 exit 6 |
| cgroup v2 unified | `/sys/fs/cgroup/cgroup.controllers` 可读 **且** `/proc/self/cgroup` 首行 `0::/`；不按发行版名猜 | `enforce=false` 只监控，RSS 取 `kore.ping` 的 `rss_kb`（不设采样器），`cgroup_enforced=false` | **降级** Job Objects（内存/CPU/进程数），与 cgroup 语义不等价 | **降级** 仅观测（rusage），不阻断；"预算"只是观测值 |
| init 与委派 | **真实写测试**：临时建 `/sys/fs/cgroup/kore/.probe-<pid>/` 再删，不看 PID 1 名字 | systemd+`Delegate=yes` 正常；OpenRC/无 init → 不建 slice，只监控，`init` 记三态 | SCM（M3） | launchd（M2） |
| 状态目录 FS | `statfs` 的 `f_type`：NFS `0x6969`、SMB/CIFS `0xFF534D42`、FUSE `0x65735546` → 硬拒绝；tmpfs `0x01021994` → 允许但标注非持久 | 网络/用户态 FS **exit 6**（bbolt 会静默损坏）；tmpfs WARN + `state_persistent=false` | 卷类型 API（M3） | `statfs` 可用 |
| 运行身份 / 凭据 | `kore-<id>` 系统用户 + socket 0600 + `SO_PEERCRED` | 建用户失败 → `failed` 并给命令原文 | **无** POSIX 用户隔离；无 `SO_PEERCRED` → hello 可选 `token`（HMAC，M3） | **无** 系统用户；`LOCAL_PEERCRED` 可用 |
| SELinux / AppArmor | `getenforce` / `/sys/fs/selinux/enforce`；AppArmor profiles | 不主动改策略；写失败按 errno 归类，不静默重试 | 无（ACL/Defender 另论） | 无（TCC 另论） |
| 架构/传输 | 编译期 `GOARCH` + 运行期 `runtime.GOARCH`；AF_UNIX | amd64/arm64 一等公民；armv7/386/riscv64 无发布物 | AF_UNIX（Go 标准库，1809+），**不引 `go-winio`** | AF_UNIX 原生 |

**判定三档与出口**：① 硬失败 exit 6 = kernel <4.18 / state_dir 在 NFS·SMB·FUSE / 架构非 amd64·arm64 / Windows <1809 / macOS <12；② 降级可跑 = cgroup v2 缺失、无 systemd、OpenRC、tmpfs、Tier B 隔离与凭据；③ 只报不拦 = SELinux/AppArmor，仅写入失败时给 errno 与命令。**退出码**：2 配置｜3 状态目录或锁｜4 存储或 schema｜5 监听绑定｜**6 环境不满足**。**支持矩阵**（M1 起每发布验证，全量归 M2/M3）：Ubuntu 20.04/22.04/24.04、Debian 11/12、Rocky/Alma/RHEL 8/9、Fedora 38+、openSUSE Leap 15.5+、Alpine 3.19+。**注意**：容器共享宿主内核，镜像再多也测不到 4.18/5.2 分界——分界由 `envprobe` 注入 `Facts` 的单测覆盖，M1 只跑 `ubuntu:24.04` + `alpine:3.19`（静态二进制使 glibc 版本无关，第三个镜像边际信息≈0）。

## 6. 关键取舍

1. **HTTP 路由手写 `net/http.ServeMux`**（ADR-0001）：引 chi 的代价是多一个直接依赖（白名单只剩 2 个名额）+ 路由树常驻分配；代价是 `/plugin-assets/<id>/*` 切分与尾斜杠语义手写（M2 付）。
2. **先 `invoke` 后 SSE**：判据绑在 `POST /invoke/echo/ping`；先做 SSE 的代价是补发/`resync`/64 连接在"插件还拉不起来"时没法验；代价是前两小时事件只能看日志。
3. **提交手写 `web/dist`**：build tag 双路径的代价是两条渲染分支 + CI 两个变体 + dev 分支永不进测试；代价是 M2 引 Vite 后要把 dist 从"提交物"改成"构建产物"。备选"缺 dist 降级 404"被否：`make build` 会绿，失败推迟到运行期。
4. **早拆 `pkg/pluginapi` 嵌套 module + 早抽五接口**（裁决 1 + 三平台分层）：不拆的代价是 tag 死锁逼出 `replace`/`go.work` 假绿（F-10）；不抽的代价是 M3 把 UDS/信号/路径写死进 core，改一个平台动三个包。共同代价是 M1 多约 2h 与"过度设计"风险——用"≤3 方法、单实现直调、无注册表、ADR-0010 复审条件"钉住。安装入口先用 `kored install --package`；运行期 `POST /store/install` 同批 M2，两入口共用 `installer`（§11 D-6）。

## 7. 风险与缓解

| # | 风险 | 触发信号 | 预案 |
| --- | --- | --- | --- |
| R1 | 空载 RSS 超 8 MiB | 任一组 `GOGC=100/200` 中位数 >8192 或 `RssAnon >5120` | ① 确认 `GOMEMLIMIT=6MiB` 生效（`gctrace=1` 看 goal 被钳）；② `RssAnon` 大查实现、`RssFile` 大查启动全表扫描；③ 降 `GOGC=50`；④ 砍 embed 与未引用资源；⑤ 不改阈值，提 ADR |
| R2 | 干净目录 tag 不可解析 | `go mod download` 报 `unknown revision` | ① 冻结 SDK → 推 `pkg/pluginapi/v0.1.0` → echo 再 tidy；② 联调期用顶层 `go.work`（不提交）；③ CI 断言 `go.work` 与跨仓库 `replace` 均为 0；④ `GOWORK=off` 复跑 |
| R3 | `go:embed` 空目录 / 隐藏文件膨胀 | `pattern dist: no matching files`；或 `strings bin/kored \| grep -c '\.map'` ≠ 0 | ① `web/dist/index.html` 提交且含 `id="app"`；② build 断言 dist 非空、`.map`/`.vite`/`stats.html` 为 0；③ 用 `dist` 不用 `all:`；④ CI 不跑 npm |
| R4 | 状态目录误配为网络文件系统 | bbolt 报 `input/output error`；写一半断电后损坏 | ① `statfs` 在 `Open` **之前**拦截 → exit 6；② 验收固定 `/var/lib/kore`；③ tmpfs 允许但 WARN + `state_persistent=false` |
| R5 | 发行版 cgroup 挂载差异（RHEL/Rocky 8 默认 v1、部分 hybrid） | 写 `/sys/fs/cgroup/kore` 报 `ENOENT`/`EROFS`/`EACCES` | ① 只按"`cgroup.controllers` + `0::/`"双条件判 unified；② 不满足即只监控，**绝不因此拒绝启动**；③ `cgroup_enforced=false` 进 `/system/info` |
| R6 | Alpine / 无 systemd 环境 | PID 1 非 systemd、`systemctl` 不存在、`/run` 权限更紧 | ① 不调 `systemctl`，只用真实写测试；② `init` 三态入 report；③ `compat-smoke.sh` 固定跑 alpine；④ 前台 `kored serve` 是受支持形态，不是降级 |
| R7 | SELinux enforcing 拦截写 `/run/kore` | euid=0 仍 `permission denied`；`ausearch -m avc` 有记录 | ① 不自动改策略；② 报 errno + 建议 `chcon -Rt var_run_t /run/kore`；③ 策略包归 M3 |
| R8 | PBKDF2 600k 迭代超延迟预算 | login p95 >400ms（CORE 写恒定 150–250ms） | ① M1 实测记录；② 若超写 ADR 评估迭代数，不改 HTTP 超时；③ 登录限速仍在 |
| R9 | G-19/守卫 6 与协议心跳冲突 | `make gate` 命中 `time.NewTicker`/`NewTimer`；或 30s 采样器被写成常驻 ticker | ① 白名单只放 `internal/core/supervisor` 的 ping/退避（G-19 例外：协议契约，非新增轮询）；② RSS 改取 `kore.ping` 的 `rss_kb`，**不设采样器**；③ 不得放宽到全仓 |
| R10 | `GOAMD64=v1` 被质疑性能 | 评审问"v1 是不是慢" | 只关掉 AVX2/BMI 等向量优化，薄壳无热点；给 echo 往返 p95 口径，真成瓶颈再评估双发行物（M1 不做） |
| R11 | platform 抽象层过度设计 | 接口数/方法数只增不减；`service` 在 M2 仍只有探测 | ① 每接口 ≤3 方法、无注册表/工厂；② ADR-0010 复审条件：M2 末单方法即并回 `paths`；③ 禁止为"将来可能要"加参数 |
| R12 | Tier B 限额语义不可对齐（Windows Job Objects / macOS 仅观测） | 用同一套 `resources.memory_mb` 做跨平台承诺；或在 mac 上用 `make mem` 当门禁 | ① 接口只承诺"尽力限额"，`enforce` 与实测值进 report；② 非 Linux 的 `make mem` 打 `[N/A] 仅观测`；③ 资源判据只在 Tier A 真机卡；④ 文档不写"等价" |；④ SDK 双主版本：破坏性改动同时升 SDK 与 kore 主版本，CI 比对 tag 与 `Protocol` |

## 8. 验收脚本（可复制执行）

```bash
# 在 ~/Work/GolandProjects 下执行；期望值在行尾注释
set -u; cd kore
( cd ../kore-plugin-echo && make dist >/dev/null ); ECHO_PKG=../kore-plugin-echo/dist/echo-0.1.0.tar.gz

# (1) 门禁 + 构建 + 产物形态 + 交叉编译
make check; echo "check_exit=$?"                                     # 0
make build && stat -c%s bin/kored | awk '{print "size="$1,($1<=26214400?"PASS":"FAIL")}'
file bin/kored | grep -qE 'statically linked|static-pie' && echo "static=OK"
readelf -l bin/kored | grep -c INTERP || echo "no_interp=PASS"        # 0
make compat-info    # 打印构建参数（GOAMD64/GOARM64、file）+ Windows/macOS 交叉编译

# (2) RSS 消融：默认臂 GOGC=100 与对照臂 GOGC=200 各 60 点中位数 + smaps 拆分
sudo install -d -m 0700 /run/kore /var/lib/kore /var/log/kore; sudo rm -f /run/kore/kore.{sock,lock}
for g in 100 200; do
  sudo GOMEMLIMIT=6291456 GOGC=$g ./bin/kored serve install --package "$ECHO_PKG" --config ./testdata/e2e.yaml & sleep .3
  P=$(pgrep -x kored); M=$(for i in $(seq 60); do ps -o rss= -p $P; sleep 1; done | sort -n | sed -n 30p)
  echo "GOGC=$g median=$M anon=$(awk '/^RssAnon:/{print $2}' /proc/$P/smaps_rollup) file=$(awk '/^RssFile:/{print $2}' /proc/$P/smaps_rollup)"
  sudo kill $P; sleep 1
done    # 判据：两组 median ≤8192、anon ≤5120、file ≤2048，缺一不算过
make budget-check   # 判据：mem 双跑中位数 + idle（60s CPU ≤60ms/线程 ≤20/fd ≤64/出站 0）+ 进程数 + 体积（G-19/G-03）

# (3) 就绪 + 登录 + CSRF + invoke（默认臂运行命令）
sudo GOMEMLIMIT=6291456 GOGC=100 ./bin/kored serve install --package "$ECHO_PKG" --config ./testdata/e2e.yaml & sleep .3
S=/run/kore/kore.sock; t0=$(date +%s%N)
for i in $(seq 200); do curl -sf --unix-socket $S http://localhost/-/healthz >/dev/null && break; sleep .01; done
echo "ready_ms=$(( ($(date +%s%N)-t0)/1000000 ))"
curl -s -o /dev/null -w 'self_anon=%{http_code}\n' --unix-socket $S http://localhost/api/v1/self
curl -s -c /tmp/kore.jar -o /dev/null -w 'login=%{http_code}\n' -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"m1-e2e-Pa55"}' --unix-socket $S http://localhost/api/v1/auth/login
CSRF=$(awk '$6=="kore_csrf"{print $7}' /tmp/kore.jar)
curl -s -b /tmp/kore.jar -H "X-Kore-CSRF: $CSRF" -d '{}' --unix-socket $S http://localhost/api/v1/invoke/echo/ping

# (4) kill -9 插件 → ≤5s 新 pid + ping 200
OLD=$(pgrep -x echo|head -1); t0=$(date +%s%N); sudo kill -9 "$OLD"
until NEW=$(pgrep -x echo|head -1) && [ -n "${NEW:-}" ] && [ "$NEW" != "$OLD" ] \
  && curl -sf -b /tmp/kore.jar -H "X-Kore-CSRF: $CSRF" -d '{}' --unix-socket $S http://localhost/api/v1/invoke/echo/ping >/dev/null; do
  [ $(( ($(date +%s%N)-t0)/1000000 )) -gt 5000 ] && { echo "recover=FAIL"; break; }; sleep .05; done
echo "recover_ms=$(( ($(date +%s%N)-t0)/1000000 )) new_pid=${NEW:-none}"

# (5) 洁净跨仓库 + syscall 收口 + 容器 smoke
D=$(mktemp -d); git clone -q ../kore-plugin-echo "$D/echo" && cd "$D/echo" && go mod download && make dist
go list -m all | grep -c 'kore/pkg/pluginapi'; git grep -n '^replace' -- go.mod || echo "no_replace=PASS"
cd "$OLDPWD"; git ls-files | grep -cE '^go\.work' || echo "no_gowork=PASS"
grep -rn 'syscall\.' internal/core | wc -l                           # 0
bash scripts/compat-smoke.sh --images ubuntu:24.04,alpine:3.19       # 2/2 PASS
```

**反向验收九条**（进 `make gate`/`make test`，不接受"手工验过"）：

| 用例 | 命令要点 | 期望 |
| --- | --- | --- |
| R-01 帧长度边界 | 合成 4B 头直打 socket：`8388608`/`8388609`/`0`/`1`/`2` | 收 / 拒且 RSS 增 ≤64 KiB / 非法 / 非法 / 最小合法 |
| R-02 分片与合并 | 同帧按 1/2/3 字节切片 200 轮；两帧拼一次 `write` | 零错帧；连续产出 2 个响应 |
| R-03 并发 100 + 超时混合 | 95 正常 + 5 个 `timeout_ms=1000` 打慢方法 | pong=95、超时全 `E_UPSTREAM`、`goroutines ≤20`、fd 差 ≤2 |
| R-04 崩溃循环 | `bin/echo` 换 `#!/bin/sh\nexit 1` | 60s 拉起 ≤5 次、终态 `failed`、healthz 始终 200、主壳 RSS 波动 ≤1 MiB |
| R-05 `kill -9` 主壳 | 建会话 + enable echo → 杀主壳 → 重启 | healthz 200、`pgrep -fc '/plugins/echo/'` = 1、旧 cookie 仍可 `/self` |
| R-06 空 `web/dist` | `rm -rf web/dist && go build ./...` | 与 ADR-0010 裁决一致；若通过必须返回真实 `index.html`（`id="app"`） |
| R-07 只读 state_dir | `KORE_STATE_DIR=/var/lib/kore-ro`（`chmod 500`） | exit 3、stderr 含路径与 `EPERM`、无 panic、无半初始化 DB |
| R-08 无 systemd / OS 过低 | 容器 PID 1 非 systemd；伪造 Windows<1809、macOS<12 的 `Facts` | 前者正常 ready；后者 exit 6 且 message 给出版本与下限 |
| R-10 hello 两层时限 | ① 替身插件延迟 2.1s 再发 hello；② 冷启动连打 20 次取 p95 | ① SIGKILL + 重启计数 +1 + 状态 `failed`；② p95 ≤300ms 记 PASS，>300ms 只记「性能不达标」不判失败 |
| R-09 bbolt 损坏 / 日志只读 | 截断 `kore.db` 前 8 KiB；`/var/log/kore` 改只读 | exit 4 且给 `kore.db.bak` 指引；主壳仍起、healthz 200、WARN 一次 |

## 9. 与 ADR 的对应

**已有 ADR，M1 只落地不改**：0001→§4.6/M1-14；0002→§4.2/M1-01；0003→§4.3/M1-12/13；0005→§4.4/M1-03/04；0006→§4.5（`all:dist` 改 `dist` 按 G-06 修订 ADR-0006）；0007→§4.2 的 `type`；0008→§2/§3；**0009**（Tier 分层/exit 6/静态二进制）→§5/M1-21；**0010**（五接口/AF_UNIX/三态凭据）→§4.7/M1-23；**0011**（pluginapi 嵌套 module + 独立 tag）→§4.1/M1-02；**0012**（预设与商店，embed 快照/零后台出站）→§2.3/M2；**0013**（插件三态 + 常驻 ≤3 + 极致资源）→§4.3/§4.6/M1-12。

**不新建 ADR（裁决 5，避免 ADR 通胀）**：`requires_kore` 语义以 PLUGIN-PROTOCOL §3.1 为唯一真源（7 条用例进单测，不另立 ADR）；embed 的 `all:dist`→`dist` 属 ADR-0006 的文档级修订（G-06 同步）；定时器口径以 G-19 为准——supervisor 的 ping 属协议契约，不算新增轮询。另属 G-06 同步一项：`PLUGIN-PROTOCOL.md:328` 残留的 `KORE_SOCKET` 删除（以 `CORE.md:134` + 裁决 3 的五个唯一名为准）。

## 10. 明确不做的理由

- **cgroup v2 强制** `[M1 不做]`：判据不含超限杀进程；建 slice 要 root + `Delegate=yes` + 发行版差异探测，M1 只有 echo，做了测不出收益却把"能不能起来"卡在权限上。强制路径归 M3。
- **Windows / macOS 运行时实现** `[M1 不做]`：M1 只立契约（五接口 + Linux 实现）。提前写实现体的代价是每个分支都没有 CI 可跑，等于给自己造"看起来支持"的假象；macOS 归 M2、Windows 归 M3。
- **服务注册（systemd unit 安装 / SCM / launchd）** `[M1 不做]`：前台 `kored serve` 已覆盖"无 init 也能跑"；安装器要处理幂等、升级、卸载残留，属 M3 `packaging/`。
- **macOS notarization / Windows Authenticode** `[M1 不做]`：需要证书与签名流水线，且 M1 不出 mac/win 发布物；随 M2/M3 发布链路一起做。
- **全发行版矩阵 / OpenRC unit / 真机 arm64 资源判据 / SELinux 策略包** `[M1 不做]`：容器共享宿主内核，镜像再多也测不到内核分界；QEMU 的 RSS 与计时不具代表性；策略包需要分发载体。分别归 M2 矩阵、M3 真机矩阵、M3 packaging。同理，签名 / 前端插件加载 / site / backup / 热升级 / 日志轮转 / 备份恢复都缺前置链路，M1 加进来只会把预算提前烧掉。

## 11. [待裁决] 汇总（裁决前相关任务不开工）

| ID | 问题 | 裁决 / 建议 | 状态 |
| --- | --- | --- | --- |
| D-1 | `docs-check` 曾硬编码 `里程碑: M0` | 门禁 2/6 已按正则接受 `M0–M4`（`scripts/docs-check.sh:106`） | 已修复 |
| D-2 | "启动到就绪 ≤1s"的边界 | kored 启动 → `GET /-/healthz` 200 即 ready，**不含**插件 ready（lazy 按需拉起）；冷启动另计 p95 ≤300ms SLO，不混算 | 已裁决 |
| D-3 | 未知配置字段 WARN 还是报错 | `CORE.md:42` 已是 WARN + 继续（附拼写建议）、类型/必填/越界才 exit 2；与 ARCHITECTURE 无冲突 | 已关闭 |
| D-4 | G-19"定时器仅 `cert_renew`" vs 协议 10s `kore.ping` | 按 G-19 例外执行：ping 属协议契约、不算新增轮询；删 RSS 采样器；不建 ADR | 已裁决 |
| D-5 | "必须交叉编译" vs "不许写空实现壳子" | `!linux` 只允许 ≤5 行 `New()` 返 `ErrUnsupported`；超 5 行按 G-01 处置 | 已裁决 |
| D-6 | 安装入口 CLI 还是 HTTP | **两者都要、共用 `installer`**：首装 `kored install --scenario <id> [--offline-dir] [--yes]`；运行期 `POST /api/v1/store/install` + `GET /store/jobs/{id}`；CLI 是 HTTP 的薄包装 | 已裁决 |
| D-7 | clean-dir 验收依赖已推送 tag | 联调期 go.work → 收尾 clean-dir 必跑（§0.1） | 已裁决 |
| D-8 | arm64 是否进资源门禁 | 进，但分期：**M1 只 amd64 实测**（arm64 仅交叉编译通过）；**M2 起 QEMU arm64 跑 `make mem`/`make idle`** 作里程碑门禁 | 已裁决 |
| D-9 | 嵌套 module 的 `replace` 能否提交 | 同仓库 `=> ./pkg/pluginapi` **必须提交**；跨仓库 `=> ../` **禁提交**（§0.1） | 已裁决 |
| D-10 | `G-03`/RESOURCE-MODEL 旧 `GOGC=200` 口径 | G-03 已改 `GOMEMLIMIT=6MiB + GOGC=100`；200 仅作对照臂 | 已关闭 |
| D-11 | 红队两条不采纳 | 门禁编号改 `PG-01…PG-05`；壳保留 ≤30 KiB 含登录表单（1 KiB 占位过不了 `id="app"` + 登录） | 记录 |
| D-12 | `kore.hello` 2s vs 冷启动 300ms | 2s 硬超时（SIGKILL + 计重启）+ 300ms p95 SLO（不判失败），两层分测（§4.3 / R-10） | 已裁决 |
