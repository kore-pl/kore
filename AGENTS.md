# kore · Agent 协作入口

kore 是一个**多仓库项目**：内核 + 插件中心 + 每插件一仓。内核是极简调度的薄壳（插件生命周期 / 权限校验 / 消息路由 / 资源隔离），不内置任何运维功能；插件在自己的仓库里定义能力，资源零侵占、完全归属使用者。
**v1 定位**：覆盖 **22 项能力域：12 项生产级 / 8 项基础级（边界用例延 v1.1）/ 6 项明确不做**。**v1.0 = Linux GA，macOS / Windows 为 preview**；能力由 **18–22 个插件仓库**提供，内核只做调度与商店 / 预设机制。
当前里程碑 **M0 · 文档与骨架**（只交付 `kore` 仓库：纯文档 + 空骨架，零业务代码）｜MVP 版本 0.1.0｜`kore-plugins` 与 `kore-plugin-echo` 归 M1，`site` / `backup` 归 M2。

- `kore`（module `github.com/pengtang1024/kore`）：内核 + `pkg/pluginapi` 公开 SDK + 主壳前端 + `docs/` + `.agents/`（**唯一协作中枢**）。
- `kore-plugins`（module `github.com/pengtang1024/kore-plugins`）：纯静态索引 `index/plugins.json` + 校验脚本；不做审核、不代管包、无账号。
- `kore-plugin-<id>`（module `github.com/pengtang1024/kore-plugin-<id>`）：每插件一仓库，含 `main.go` / `info.json` / `web/` / `Makefile` / `CHANGELOG.md`，只依赖 `kore/pkg/pluginapi`。

**读前必知**

1. 这是薄壳调度内核，不是大而全的面板。`internal/core` 里多写一行业务逻辑就是设计事故，不是"顺手优化"。**Web 服务器不内置**：nginx/caddy/httpd 等一律跟随站点插件、可选、多实现；内核与插件都不捆绑任何 web server 二进制，不装站点插件就无此能力（裁决37）。
2. 资源预算分两层：**硬红线** 主壳空载 VmRSS ≤ 16 MiB、单常驻插件 ≤ 24 MiB、常驻合计 ≤ 48 MiB、同时常驻 ≤ 3（推荐 ≤2）；**目标** 主壳 8 MiB / 单插件 12 MiB / 合计 24 MiB——**8 MiB 是目标不是红线**，超红线才判未完成。**它是管理者，不能变成负担**——空载 1 个进程、空闲 CPU ≈0。
3. 交付只认证据：命令原文 + 退出码 + 关键输出。没有输出的"已完成"不成立。
4. 一个静态二进制跑遍 RHEL8 → Alpine 3.19 是 **Tier A**；Windows 10 1809+ / macOS 12+ 为 **Tier B**（能用，隔离与限额降级）。兼容性靠**降级矩阵**，不是要求用户升级系统。**优先级：先保证当前机器正常运行，多平台为降级目标——不为兼容性牺牲本机稳定性（裁决 35）。**
5. **设计优化优先于代码优化**：资源 / 性能 / 复杂度问题先问"能否改设计"（少一个进程、少一个依赖、改生命周期、改触发方式），再问"能否调参"。调参只能作为临时手段，且必须记 ADR 并标注"待设计层解决"。反例：为压 500 KiB 而调 `GOGC`——那不是达标的主要功臣，薄壳 + 依赖白名单 + embed 单二进制才是。
6. **数据形状必须显式**：对外 schema（协议、配置、`info.json`、索引、preset）**禁止 `object` / `any` / `map[string]any` 作为类型**——要么显式列出字段与类型，要么用带类型前缀的标量（如 `"event:cert.renew_due"`）。内部解析可以临时用 `any`，但必须在一处收口并转成具体类型。**不要用 `object` 逃避把结构想清楚。** **插件 UI 走独立 origin iframe + postMessage 桥，不进主壳 realm；`kore_csrf` 为 HttpOnly，管理 API 不对插件桥开放（裁决40）。** **手机适配为硬约束：主壳与插件 iframe UI 均响应式适配手机/平板，viewport + CSS media query，触摸目标≥44px，不引入框架、不放宽首屏预算（裁决41）。**
7. **产品易用性四原则（硬约束）**：①预设优先、自定义兜底（核心任务点击 ≤3，不填高级参数也能成功）②自动发现、不让人填环境细节（首屏可自动填的字段已填好并标「已自动检测」）③操作步骤尽量少（一个任务一次表单，>3 步必须合并成向导）④小白能看懂（错误提示给"怎么办"、配置项有中文标签 + 一行帮助、空状态给下一步按钮、禁用「实例 / 生命周期 / capability / revision」等内部术语）。判据、术语对照与当前违反清单见 [docs/USABILITY.md](docs/USABILITY.md)；新功能提案必须答四问，答不出退回。

## 1. 阅读顺序（七步，不跳步）

1. [docs/VISION.md](docs/VISION.md) — 做什么、不做什么、五锚点原文与成功判据。
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 组件图、进程模型、插件状态机、故障域。
3. 本领域文档：内核 [docs/CORE.md](docs/CORE.md)｜协议 [docs/PLUGIN-PROTOCOL.md](docs/PLUGIN-PROTOCOL.md)｜资源 [docs/RESOURCE-MODEL.md](docs/RESOURCE-MODEL.md)｜数据 [docs/DATA-MODEL.md](docs/DATA-MODEL.md)｜前端 [docs/FRONTEND.md](docs/FRONTEND.md)｜安全 [docs/SECURITY.md](docs/SECURITY.md)｜决策 [docs/DECISIONS/](docs/DECISIONS/)。
4. [.agents/WORKFLOW.md](.agents/WORKFLOW.md) — Kore Loop 七阶段门禁、讨论协议、任务板状态机、上下文交接。
5. [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md) — G1–G19 + G-28/G-29/G-30 门禁命令、执行者、分层与证据格式。
6. **贡献与治理**：[CONTRIBUTING.md](CONTRIBUTING.md)、[docs/OPEN-SOURCE.md](docs/OPEN-SOURCE.md) — 开源化政策（MIT）、PR / Issue 流程与评审要求。
7. **安全披露**：[SECURITY.md](SECURITY.md)（根，披露政策）vs [docs/SECURITY.md](docs/SECURITY.md)（设计）——**两者不要混**。

## 2. 硬门禁（违反任意一条，产物即不成立）

| 编号 | 规则 | 违反后果 | 检查方式 |
| --- | --- | --- | --- |
| G-01 | 薄壳红线：`internal/core` 只做规则不写业务，且禁止 import `plugins/**` | 提交拒绝，改动整段重写 | `grep -rn "plugins/" internal/core` 必须零命中（G7）；**capability 字符串不属于业务逻辑**——内核只认识 6 个特权能力（`system:` / `net:` / `proc:` 各 read/write 类）与通用语法 `<plugin-id>:<action>`，**不得维护业务域名词表**（详见 PLUGIN-PROTOCOL） |
| G-02 | 依赖白名单：主壳**第三方**直接依赖上限 3 = `gopkg.in/yaml.v3` / `go.etcd.io/bbolt` / `google.golang.org/protobuf`（M3 引入）；**同仓嵌套 module**（`github.com/pengtang1024/kore/*`，当前只有 `pkg/pluginapi`）**不计入该配额**，但必须在根 `go.mod` 用 `replace => ./` 指向仓库内路径（禁止 `../` 或绝对路径）。禁 Web 框架、gRPC、NATS、SQLite、Redis 客户端、容器 SDK | 提交拒绝 | `go list -m all` 与白名单逐项比对（G5）；`make check` 2/5 区分两类：第三方计数 ≤3 + 同仓 module 仅允许 `pengtang1024/kore/` 前缀且 `replace => ./` |
| G-03 | 资源预算：**硬红线** 主壳空载 VmRSS ≤ 16 MiB、单常驻插件 ≤ 24 MiB、常驻合计 ≤ 48 MiB、同时常驻 ≤ 3（推荐 ≤2）、单二进制 ≤ 25 MiB、前端首屏 ≤ 300 KiB gzip、空闲 CPU ≤ 0.1%（60s ≤ 60ms）、goroutine ≤ 20、fd ≤ 64、出站 0；**目标（争取，不判未完成）** 主壳 8 MiB / 单插件 12 MiB / 合计 24 MiB。依据 **ADR-0016**（`docs/DECISIONS/0016-resource-budget-final.md`）；除安全事故或用户明确要求外不再调整 | 超硬红线判未完成；红线与目标之间记 WARN + 趋势，不返工，M4 集中瘦身 | `make budget-check`（判红线）+ `make mem MEM_POINTS=60`（里程碑收口）；证据须含生效值与来源标注；GC 判别看 `/gc/gogc:percent`；前端首屏另由 `make frontend`（第 10 段，首屏 ≤300 KiB gzip，G-03 阻断级）守护 |
| G-04 | 进程隔离：插件必须是独立进程 + 独立 socket，禁止同进程动态库插件 | 架构级拒绝 | 评审 `docs/PLUGIN-PROTOCOL.md` 与 supervisor 启动路径 |
| G-05 | 无中间件：不引入 Redis / NATS / MQ / 容器运行时等常驻组件，隔离直接走 systemd + cgroup v2 + 文件系统 | 架构级拒绝 | 依赖白名单 + 进程清单核对 |
| G-06 | 文档同步：改动路径 / 协议 / 预算数字 / 角色名，必须在同一检查点内同步对应文档；代码与文档不一致不得合并 | 合并拒绝 | `make docs-check`（G4）+ 评审逐项对照 |
| G-07 | 证据验收：完成任务必须贴 命令 + 退出码 + 关键输出，禁止"应该没问题" | 任务不得 complete | [.agents/BOARD.md](.agents/BOARD.md) evidence 字段逐项核对 |
| G-08 | 写域不相交：同层并行任务的 `write_scopes` 不得重叠，跨角色不改他人文件 | 冲突任务回滚重派 | 派发前核对 BOARD `scope` 列 |
| G-09 | 角色不可兼任：implementer ≠ verifier，red-team ≠ implementer | 该次验收作废 | BOARD owner 与验收报告署名 |
| G-10 | 无联网 / 无遥测：不强制账号、无联网校验、无隐藏上报、无功能封锁 | 直接回滚 | G10 grep 出网客户端与 telemetry 关键词 |
| G-11 | 非目标保护——**6 项明确不做**：多用户 RBAC、集群 / 多机、模板市场、厂商云存储深度集成、拖拽建站、多语言**全量框架**（i18n；「中文为主 + 英文可选」的 UI 骨架例外，见 [ADR-0021](docs/DECISIONS/0021-i18n.md)）；另不做容器编排、多租户 SaaS、移动 App、重型主题 | 需求退回提案阶段 | 提案评审对照 22 项能力域与 6 项不做清单，命中即退回 |
| G-12 | 提交纪律：精确 `git add <file>`，禁 `git add .`；不提交未验证或与他人未完成改动混在一起的变更 | 提交回退 | 提交前 `git status --short` 人工核对 |
| G-13 | 仓库边界：插件代码 / 插件前端 / 插件索引不得进入 `kore` 仓库；`kore` 不得 import 任何插件仓库 | 提交拒绝，改动迁出到对应插件仓库 | `grep -rn "plugins/" internal/ cmd/` 零命中（G11）+ 仓库内无 `*/main.go` 形态插件 |
| G-14 | 协议兼容：插件 `info.json` 必须声明 `requires_kore`；破坏性协议改动必须 `kore` 主版本递增 + ADR | 合并拒绝 | G12 比对 `requires_kore` 区间与 `kore` VERSION；ADR 编号可查；**lifecycle 解析（M1 起）**：`info.json.lifecycle` 接受 `resident` / `lazy` / `oneshot` 三值并落盘，M1 运行期只支持 `resident`，遇 `lazy` / `oneshot` 返回 `E_UNSUPPORTED`（message 写明"M2 支持"）——"字段接受但未实现"不算缺陷 |
| G-15 | 跨仓库变更集：一次跨仓库改动必须在 `.agents/BOARD.md` 登记为一个变更集（含各仓库 commit/tag 与合并顺序），否则不算完成 | 任务不得 complete | BOARD「变更集」区有对应 id，仓库 / 版本 / 顺序齐备（格式见 WORKFLOW §10） |
| G-16 | 兼容性基线：构建必须 `CGO_ENABLED=0` + `GOAMD64=v1` + `GOARM64=v8.0`；**build flags** = `-trimpath -buildvcs=false`，**link flags** = `-s -w`（`-buildvcs` 是 build flag，塞进 `-ldflags` 会报 `flag provided but not defined`）；**主线 Linux（Tier A）**，Windows 10 1809+ / macOS 12+ 为 **Tier B 降级支持**；`internal/core` **不得直接调用平台专有 API**（`syscall` / `os/signal` 平台分支必须收在 `internal/platform`）；能力缺失必须走降级矩阵、**禁止静默降级**；OS 版本 / 架构低于下限 → **退出码 6** | 构建拒绝（产物不可移植） | `make compat-info` + `GOOS=windows GOARCH=amd64 go build ./...` + `GOOS=darwin GOARCH=arm64 go build ./...`（M1 起生效，M0 记 N/A）+ `grep -rn "syscall\." internal/core` 只允许出现在 `internal/platform` |
| G-17 | 插件仓规范：每个插件仓库必须含 `info.json`（含 `depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore`）、`Makefile` 的 `dist` 目标、`CHANGELOG.md`；缺任一项不得进商店。**`replace` 规则**：同仓库嵌套 module 的 `replace => ./pkg/pluginapi` **允许且必须提交**（Go 标准做法）；跨仓库联调的 `replace => ../kore/...` 或绝对路径 **禁止提交**（只放 `go.work`） | 商店索引拒绝收录；跨仓 `replace` 拒绝合并 | `make store-check` 逐仓校验三件套 + 必填字段；`replace` 只拦 `=> ../` 或绝对路径，**不拦 `=> ./`**；M1 起生效 |
| G-18 | 预设一致性：`kore-plugins/presets/*.json` 引用的插件 id 与版本区间必须能在索引中解析；预设合计资源不得超预算 | 预设不得发布 | `make presets-check`：id / 区间可解析 + 合计常驻 RSS ≤ 48 MiB（红线；目标 ≤ 24 MiB）与二进制体积预算；M2 起生效 |
| G-19 | 空闲行为：空载 60s 内 CPU 时间 ≤ 60ms、goroutine ≤ 20、打开 fd ≤ 64、出站连接 0、定时器仅 `scheduler`（单实例单 ticker，ADR-0019）；**禁止轮询**（主壳不得有定时拉取插件状态的循环，状态变化走事件推送）；lazy 插件必须能真正退出（不得内部起 ticker 续命） | 判为未完成 | `make idle`（可用，约 65s；M0 无进程时 SKIP）+ `/proc/<pid>/stat` utime+stime 差值 + `/proc/<pid>/task` 计数 + `ss -tnp` 空；**定时器白名单**：禁止 `time.NewTicker` / `time.AfterFunc` / 周期循环，唯一例外是 `internal/core/scheduler/`（单实例单 ticker）；允许请求级 `time.NewTimer` / `context.WithTimeout`，但必须 `Stop()`（`defer` 即可）；`scheduler` 是唯一允许的周期来源（`cert_renew` 已迁移为内置任务）；M1 起必跑 |
| G-20 | 深度等级：插件必须在 `info.json` 声明 `depth_level` ∈ {`production`, `basic`}；`basic` 插件不得被预设标为"开箱可用"；商店 UI 必须展示等级；`production` 插件必须过故障注入测试 | 不得进商店 / 不得标生产级 | G15：`grep -r "depth_level" <插件仓>/info.json` 必须存在；对标矩阵里 `basic` 不得标"生产级"；`production` 必须有 `tests/fault/`；M3 起生效 |
| G-21 | 无副作用的诊断代码：日志 / 诊断**不得改变运行时状态**——`debug.SetGCPercent(-1)` / `debug.SetMemoryLimit(-1)` 这类"设置即读取"的 API 一律禁止；读取运行配置只允许 `runtime/metrics` 或"记录自己设置的值" | 视为 **P0**，产物回滚 | G16：`grep -rn "SetGCPercent(-1)" --include='*.go' .` 与 `grep -rn "SetMemoryLimit(-1)" --include='*.go' .` 双零命中；**验证 GC 是否启用请看 `/gc/gogc:percent`**，**不能**用"分配内存看 `NumGC` 增长"——`GOMEMLIMIT` 生效时 GOGC=off 也会触发 GC；M1 起必跑 |
| G-22 | 优化顺序：资源 / 性能类改动必须说明所处层级（设计层 / 架构层 / 代码层）；**只有设计层与架构层已穷尽，才允许纯代码层调参**，且调参必须记 ADR + 标注临时性 | 改动不予合入（先补设计层评估） | 判定型门禁，无需 grep：评审时逐条回答"为什么不能少一个进程 / 一个依赖 / 改生命周期 / 改触发方式"，答不出即退回 |
| G-23 | 判断留痕：任何"多选一"的决定（架构 / 协议 / 预算 / 范围 / 门禁）必须写入 `.agents/LOG/DECISIONS.md`（含**被否决的选项与依据**）；任何派发必须写入 `.agents/LOG/DISPATCH.md`（task / owner / 写域 / 依赖 / 交付 / commit）。里程碑收口时台账缺条目视为该里程碑未收口 | 里程碑不得收口 | 里程碑收口时人工核对；`make check` 不强制（避免为记账阻断日常提交），但 REVISE 时 verifier 会查 |
| G-24 | 无 any / object 逃逸：对外 schema 与对外结构体不得出现 `object` / `any` / `map[string]any`；`json.RawMessage` 仅允许用于"插件方法的参数与结果载荷"（受控例外，M2 起按插件声明的 schema 校验） | 评审退回，不得合入 | `grep -rn "map[string]any" --include='*.go' internal/ cmd/`（排除 `_test.go` 与 `testdata/`）逐个核对是否解析期临时；`grep -rn "类型：object" docs/` 零命中（受控例外行必须写明原因）；判定型部分由评审回答"这个字段为什么不能定形" |
| G-25 | worktree 卫生：不得遗留临时 worktree 与临时分支；里程碑收口时 `git worktree list` 仅主工作树、`git branch --list 'wt-*' 'tmp-*'` 为空 | 该里程碑不得收口（残留会干扰后续检出与 CI） | `make wt-check`（F 落地）或手工 `git worktree list` + `git branch --list` |
| G-26 | 开源资产完整：根必须有 `LICENSE`（MIT）、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`、`.github/workflows/ci.yml`；`LICENSE` 必须含 `MIT License` 与 `Permission is hereby granted`；不得混入非 MIT 协议头 | 不得发布（GitHub 上缺 `LICENSE` = 默认保留所有权利，与项目声明矛盾） | `make oss-check`（第 8 段，阻断级） |
| G-27 | 大小写一致性：module 路径全小写且无 `!` 转义；同一目录内不得存在仅大小写不同的文件 / 目录（Windows / macOS 会静默覆盖）；插件 `info.json` 的 `id` 匹配 `^[a-z][a-z0-9-]*$`；文档中 GitHub URL 的 owner 段全小写 | 阻塞级 FAIL（冲突文件在 Windows / macOS clone 时丢失）；**历史组织名指称（见 ADR-0017）**与 URL owner 大小写为 **WARN 级** | `make case-check`（第 9 段） |
| G-28 | UI 交付双端证据：任何涉及用户界面（页面 / 视图 / 组件 / 样式 / 交互 / 文案）的交付，声明"完成"时必须同时给 ① PC 截图（1440×900 或 1280×800，full-page）② 手机截图（390×844）③ 产品定位自评（本页解决什么用户问题 / 与宝塔、1Panel 同类功能的差距 / 当前"可用"还是"占位"）；截图存 `.agents/verify/screenshots/`，命名 `<场景>-desktop-*.png` / `<场景>-mobile-*.png` | 缺任一项不得声明完成（任务记 BLOCKED，不记 PASS）；拿接口 200 / DOM 断言 / 设计稿替代截图同判 | 验收报告逐项核对：`file` / `identify` 读 PNG 实际宽高 + 自评三问原文；禁止同图缩放冒充双端 |
| G-29 | 运行态写边界：`.kore-local.yaml` / `.kore-local-state/`（state.db / plugins / ssl / backups）/ `.kore-local-run/`（socket）/ `bin/kored` 及任何被运行中 `kored` 持有的文件属**运行态资产**，`git status` 看不出但不能在共享工作区随手改；测试要"不同索引 / 配置 / 状态"必须起**隔离实例**（独立 `--config` + state/run/log 落 `/tmp`）；确需临时改主配置时任务卡写明**何时回切**、完成前回切 + 重启 + 复核，workaround 必须带**过期条件** | 主实例读到旧数据即判未完成（如 2026-11-23：04:53:06 指向 `signed-index` 快照 / 04:53:40 重签完成 / 04:59:59 回切，期间商店把 discover 0.2.0 显示成 0.1.0） | `curl -s localhost:8787/api/v1/system/info` 的 `paths.index_dir` 必须等于配置的 `kore-plugins/index`，且商店版本 == 索引文件版本；验收报告必须声明"本轮是否改动过主实例的运行态配置" |
| G-30 | 明文凭据：`docs/` 与 `.agents/verify/` 不得出现明文口令（`MYSQL_ROOT_PASSWORD=` / `MYSQL_PWD=` / `REDIS_PASSWORD=` / `REDISCLI_AUTH=` / `KORE_MYSQL_PASSWORD=` / `ADMIN_PASSWORD=`，以及 JSON 的 `"password"` / `"secret"` / `"token"`）；占位只允许 `***` / `[REDACTED]` / `$VAR` / `<placeholder>` / `********` / `...` | 明文凭据入库（2026-11-23 `round3-live.md` 把 MySQL root 口令写进验收报告并推送公开仓库） | `make secret-check`（第 11 段，阻断级）；命中后把值换成 `***`，禁止删证据 |

## 3. 提交规范

- 格式：`type(scope): 中文描述`，type ∈ `feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore` / `build`；scope 用模块名（如 `core/supervisor`、`docs`、`agents`）。
- 精确 add：`git add internal/core/bus.go`，禁止 `git add .` / `git add -A`。
- 检查点即提交：一处自洽且过了对应层级门禁（G1/G2/G4）就提交，不攒到任务收尾。
- 不提交未验证改动；门禁没跑或跑挂时，明确报告阻塞原因，不"先提交再说"。
- **插件发版（G-17 延伸）**：`info.json` + `manifest.json` 版本同步 bump，`CHANGELOG.md` 记条目，dist 两打 + 干净树复现一致；索引同步 `versions.lock.json` 与 `presets/*.json`。**同 `id@version` 只允许一个 sha，任何改变 dist sha 的改动必须 bump**（见 [docs/RELEASE.md](docs/RELEASE.md)）。
- **高频交付（裁决36）**：一处自洽且过了对应门禁即提交并 `git push`，不攒到任务收尾；插件仓每次改动后重建 `dist` 并核对 sha 与索引一致，打包产物及时生成用于验证。
- **镜像推送（Gitee）**：推送时 `origin`（GitHub，主）与 `gitee` 双推，**先 origin 后 gitee**；gitee 失败只 WARN、不阻塞主仓。Gitee release **只保留最新 5 个**（GitHub 全量保留），超出用 `scripts/gitee-release-prune.sh` 清理（先 `--dry-run` 再真删）。详见 [docs/GITEE-MIRROR.md](docs/GITEE-MIRROR.md)。

**隔离环境与 worktree**：**隔离验证优先用 `git archive`，需要真实编辑才用 worktree。**

- 只读验证（证明某提交自洽）：`git archive HEAD | tar -x -C /tmp/xxx`，测完删目录；**不留任何 git 状态**。
- 需要编辑 / 提交的隔离：`git worktree add /tmp/wt-<name> -b <branch> [<start-point>]`。
- **清理三件事，缺一不可**：① 改动先合并回主分支（或明确放弃并说明）② `git worktree remove /tmp/wt-<name>` ③ `git branch -d <branch>` + `git worktree prune`。
- **禁止**"验证完直接删 worktree 而不合并"——那等于把改动丢了还看不出来。
- 里程碑收口时 `git worktree list` 必须只有主工作树（1 行）。

## 4. 派发纪律

- lead 只做编排 / 拆解 / 派发 / 验收，**不写代码、不跑执行类命令**；执行类动作派给 implementer 或 verifier。
- verifier 必须独立于 implementer：不复用实现者结论，门禁命令按 [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md) 原文复跑并落验收报告。
- 失败回派**原 owner**，不跨角色改他人文件；确需新增写域时先回到拆解阶段重画 `write_scopes`。
- 派发必须自包含：目标、写域、验收命令、完成判据写进任务卡，缺一项不派。
- 子 agent 开工前必须读本文件；子 agent 不继承父会话上下文，未注入 = 裸奔。
- 角色全集（固定 6 个，不增不删）：lead / architect / implementer / verifier / red-team / scribe；各自使命、写域与禁止项见 [.agents/ROLES.md](.agents/ROLES.md)。

**运行态写边界（G-29）**：以下资产不是代码而是**运行态**——`git status` 看不出（untracked）、不进 diff，但改了就直接改变 8787 上主实例的行为，**不得在共享工作区随意改**：`.kore-local.yaml`（本地运行配置）、`.kore-local-state/`（state.db / plugins / ssl / backups）、`.kore-local-run/`（socket）、`bin/kored`（正在运行的二进制）、以及任何被运行中 `kored` 进程持有的文件。

- **测不同就起隔离实例**：测试需要"不同的索引 / 配置 / 状态"时，必须独立 `--config` + 独立 state/run/log 全落 `/tmp`，**绝不改主配置或主 state**；改主配置是最贵的测试手段，不是最省的。
- **必须临时改主配置时**：任务卡里写明**何时回切**（如索引待重签、当前无法验证），完成任务前把**回切 + 重启 + 复核**三步做完，缺一步不得记 complete。
- **workaround 必须带过期条件**：写清"当 X 发生时这个 workaround 失效"；没有过期条件的临时手段按永久技术债处理。
- **回切后验数据不验配置**：`curl -s localhost:8787/api/v1/system/info` 的 `paths.index_dir` 必须等于配置的 `kore-plugins/index`，且商店返回版本 == 索引文件里的版本；只看"配置文件改回来了"不算复核。
- **事故基线（2026-11-23）**：04:53:06 为测试把 `index_dir` 指向 `signed-index` 快照、04:53:40 另一轮重签完成、04:59:59 回切——期间 8787 把 discover 0.2.0 显示成 0.1.0；这条纪律就是为它补的。

**术语边界（勿漂）**：`kore` = 项目 / 内核仓库 / Go module；`kored` = 守护进程 / 二进制 / `cmd/kored` 入口包；`kore-plugins` = 插件索引仓库；`kore-plugin-<id>` = 单个插件仓库；systemd unit = `kore.service`（`ExecStart=/usr/local/bin/kored`）；Kore Loop = 七阶段（第 7 阶段=归档复盘）。

## 5. 命令速查

| make 目标 | 作用 | M0 现状 |
| --- | --- | --- |
| `make help` | 列出全部目标与说明 | 可用 |
| `make docs-check` | 文档头元信息 + 相对链接可达 + 占位词检查 | 可用（M0 唯一真门禁） |
| `make check` | 聚合门禁（11 段）：docs-check + 明文凭据 + 依赖白名单 + 薄壳边界 + 跨仓库边界 | 可用：真跑 |
| `make secret-check` | 明文凭据扫描（docs/ 与 `.agents/verify/`，G-30） | 可用 |
| `make build` | 构建主壳 `bin/kored`（`CGO_ENABLED=0` + `-trimpath` + `-s -w`） | 可用：产出 `bin/kored` |
| `make build` 后（换公钥） | **必须重启 kored**：公钥编入二进制，旧进程仍用旧公钥验新签名 → 商店全部 401 | 见 [docs/RUNBOOK.md](docs/RUNBOOK.md) §1 七步 |
| `make vet` / `make test` | `go vet ./...` / `go test -timeout 200s ./...` | SKIP：无 `go.mod`，M1 起生效 |
| `make mem` | 采样 RSS + `smaps_rollup`/`status` 拆分，按新证据口径出中位数（G6 入口） | 可用：M0 无进程时 SKIP；有 `kored` 时出实数 |
| `make frontend` | 构建 `web/dist` 并用 gzip 核对首屏体积 | SKIP：无 `web/package.json`，M2 起生效 |
| `make repo-check` | 跨仓库边界检查：无插件代码 / 无插件 import / 无旧 SDK 路径 / 无索引 / 无 submodule | 可用（G11 入口）：**5 pass / 0 fail**，M0 真跑 |
| `make compat-info` | 打印构建参数 + `file` + `go version -m`，并跑 Windows / macOS 交叉编译冒烟（G13 入口） | 可用：参数已钉死；无 `bin/kored` 时对二进制部分 SKIP、交叉编译 `[N/A]`（M0 预期），M1 起出实数 |
| `make store-check` / `make presets-check` | 插件仓三件套校验：`info.json` 必填字段 / `Makefile` 的 `dist` 目标 / `CHANGELOG.md`；8 类场景预设 id 与版本区间可解析、合计不超预算 | 未提供：M1 / M2 落地（G-17、G-18 入口） |
| `make idle` | 空载 60s 取样：CPU 时间 / 线程数 / fd 数 / 出站连接 / 定时器来源（G-19、G14 入口） | 可用：M0 无进程时 SKIP；有 `kored` 时约 65s 采样 |
| `make budget-check` | 资源预算聚合门禁：`mem` + `idle` + 进程数 + 二进制体积（G-03 出口） | 可用：M0 无进程/无产物时 SKIP + N/A（0 pass / 2 skip / 0 fail） |

## 6. 细则索引

- [.agents/README.md](.agents/README.md)（体系与反模式）、[.agents/ROLES.md](.agents/ROLES.md)（6 张角色卡 / 冲突仲裁 / 不可兼任）、[.agents/WORKFLOW.md](.agents/WORKFLOW.md)（Kore Loop 七阶段 / 讨论协议 / 状态机）。
- [.agents/BOARD.md](.agents/BOARD.md) — 任务板字段、状态转移、WIP、变更集登记区、M0 七条轨道快照。
- [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md) — G1–G19 + G-28/G-29/G-30 门禁命令、三层组合、证据格式、M0 跳过规则。
- [.agents/JOURNAL.md](.agents/JOURNAL.md)（复盘模板 / 里程碑记录 / 反模式）与 [.agents/LOG/](.agents/LOG/)（裁决 / 派发 / 会话台账）——依次回答"教训 / 状态 / 判断"。
- [CONTRIBUTING.md](CONTRIBUTING.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、[docs/OPEN-SOURCE.md](docs/OPEN-SOURCE.md)、[.github/](.github/) — 贡献流程 / 行为准则 / MIT 开源政策 / CI 与模板；[SECURITY.md](SECURITY.md)（根，披露政策）与 [docs/SECURITY.md](docs/SECURITY.md)（安全设计）**两者不要混**。
- [docs/DECISIONS/](docs/DECISIONS/) — ADR：每个不可逆选择的备选对比、后果与复审条件；例 [0018-privilege-model.md](docs/DECISIONS/0018-privilege-model.md)：插件保持低权、root 动作经内核代理（systemd transient unit），非 root `available=false` + 可操作提示，提权审计 fail-closed。
- [docs/CORE.md](docs/CORE.md) — **十一个内核模块**（config / store / auth / httpapi / registry / supervisor / bus / installer / market / privilege / scheduler）+ 4 个支撑小节（logger / static / sse / envprobe），合计 §2 共 15 小节；HTTP API **26 个端点**：19 业务 + 7 store，前缀 `/api/v1`（业务含 M4-C 的 `GET /api/v1/audit` 与 ADR-0019 的 4 个 `scheduler/tasks` 端点；`POST /plugins` 与 `GET /events` 为 501 占位）；另有 `GET /-/healthz` 与 2 条静态前缀。
- [docs/MILESTONE-M0.md](docs/MILESTONE-M0.md) — 本次交付文件级清单与可执行验收标准；[docs/PLUGIN-MATURITY.md](docs/PLUGIN-MATURITY.md) — **补全工作的唯一依据**：24 插件仓成熟度分级（L0 / L1 / L1.5 / L2 / L3；本轮按代码事实重判为 L0 0 / L1 0 / L1.5 18 / L2 5）+ 19 视图主壳（含全局搜索四源 / 操作审计 / 告警中心 / 真实长任务进度 / 容器视图待验收）+ §3.5 **14 条**缺口（含 #12 方法级 capability 与 #13 插件降权）+ Round 5 五批任务与依赖 + §0.1 文档声明 vs 代码事实偏差表；动插件前先读对应行。

**里程碑同步规则（判据不得滞后于阶段）**：每新增里程碑，`scripts/docs-check.sh` 的里程碑允许集（元信息校验正则及配套注释/标题/错误文案）必须**同轮放宽**——阶段已进入新里程碑而判据仍停在旧号，等同于门禁失守，该检查点不予合入。
