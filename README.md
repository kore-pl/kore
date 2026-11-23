# Kore

[![CI](https://github.com/kore-pl/kore/actions/workflows/ci.yml/badge.svg)](https://github.com/kore-pl/kore/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev/)

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

**一句话定位**：Kore 是极简内核驱动、插件定义能力、资源零侵占、完全归属使用者的服务器运维基础底座——一个只做调度的薄壳内核，而不是一个功能面面俱到的大面板。

## 机制上的差异

| 维度 | 传统运维面板 | Kore |
| --- | --- | --- |
| 功能承载 | 功能全部塞进同一进程，一处异常全站陪葬 | 每个插件是独立进程，按需拉起、用完即退，崩溃不互相传染 |
| 资源姿态 | 常驻全家桶 + 内置中间件，空闲也占几百 MB | 内核个位数 MB；低频功能零常驻；默认零后台定时器 |
| 归属方式 | 账号体系 + 联网校验 + 隐式上报，用户拿不到完整控制权 | 无账号、无联网校验、无隐藏上报、无审核；代码开源、配置明文 |

## 仓库清单

Kore 是**多仓库项目**：内核一仓、插件中心一仓、每个插件一仓。本仓库（`kore`）只放内核、公开协议 SDK、主壳前端与协作中枢。

| 仓库 | 定位 | module 路径 | 状态 |
| --- | --- | --- | --- |
| [`kore`](.) | 内核 + `pkg/pluginapi` 公开 SDK + 主壳前端 + `docs/` + `.agents/`（唯一协作中枢） | `github.com/kore-pl/kore` | M0 已建 |
| `kore-plugins` | 纯静态索引（`index/plugins.json` + 校验脚本），不审核、不代管包、无账号 | `github.com/kore-pl/kore-plugins` | M1 计划 |
| `kore-plugin-echo` | 示例插件仓库：`main.go` / `info.json` / `web/` / `Makefile` / `CHANGELOG.md` | `github.com/kore-pl/kore-plugin-echo` | M1 计划 |
| `kore-plugin-site` | 站点类插件仓库 | `github.com/kore-pl/kore-plugin-site` | M2 计划 |
| `kore-plugin-backup` | 备份类插件仓库 | `github.com/kore-pl/kore-plugin-backup` | M2 计划 |

插件只依赖 `kore/pkg/pluginapi`；`kore` 不 import 任何插件仓库（依赖单向，见 [AGENTS.md](AGENTS.md) G-13）。

## 镜像仓库

**三端分工（[ADR-0024](docs/DECISIONS/0024-repo-topology-and-gitea.md) 决策 B/D）**：`origin` = 自建 Gitea **权威源**，日常提交 / PR / issue / tag 以它为准；GitHub 为**公开镜像**（CI badge 宿主，已有 8 个 issue 保留为公开镜像）；Gitee 为**国内镜像**。镜像只做代码与发行物的可用性同步，不在镜像上开发。

| 平台 | 地址 | 说明 |
| --- | --- | --- |
| Gitea（权威源，`origin`） | <https://gitea.iouf.cn/kore-pl/kore> | 日常提交、PR、issue、tag 的唯一权威源 |
| GitHub（公开镜像） | <https://github.com/kore-pl/kore> | 镜像 + CI badge 宿主、release 基线；release 全量保留 |
| Gitee（国内镜像） | <https://gitee.com/pengtang1024/kore> | 同步 `main` 与 tag；release 只保留最新 5 个 |

26 个仓库（内核 + 插件中心 + 24 个插件仓）同一策略；推送约定、失败处理与清理脚本见 [docs/GITEE-MIRROR.md](docs/GITEE-MIRROR.md)，拓扑决策见 [ADR-0024](docs/DECISIONS/0024-repo-topology-and-gitea.md)。

## 能力来源

内核不含任何运维业务：功能由 **18–22 个插件仓库**提供，每个插件独立仓库、独立版本线、独立 CI，可以只装需要的那些。
首次安装可选 **8 类场景预设**一键成型——预设 embed 在二进制里，可刷新到新版本，离线环境下也有目录兜底；装完之后由软件商店自管：装什么、卸什么、升不升，用户说了算，没有审核队列、没有账号。

**和宝塔 / 1Panel 的关系**（不贬低竞品，只说取舍）：Kore 覆盖 **22 项能力域——12 项生产级 / 8 项基础级（边界用例延 v1.1）/ 6 项明确不做**。**明示不做，比含糊对标更可信**：不做的 6 项是多用户 RBAC、集群 / 多机、模板市场、厂商云存储深度集成、拖拽建站、多语言（i18n）。

**现状**：v1.0 = **Linux GA**；macOS 12+ / Windows 10 1809+ 为 **preview**（可用，隔离与限额降级，见上文「支持的平台」）。

| 维度 | Kore | 同类面板（宝塔 / 1Panel 等） |
| --- | --- | --- |
| 更轻 | 内核只做调度，空载 RSS ≤ 8 MiB，单静态二进制 | 面板与功能通常由同一套发行包承载 |
| 更开放 | 无账号、无联网校验、无隐藏上报，配置全明文 | 以各自产品形态与授权策略为准 |
| 插件独立仓库 | 一个插件一个仓库、一条版本线、一套 CI，可单独替换或干脆不用 | 多以插件市场 / 内置模块形式分发 |

选哪个取决于你要什么：要开箱即用的全家桶，成熟面板更省事；要小而可控、能自己改，看 Kore。

## 五锚点

| 锚点 | 含义 | 量化判据 |
| --- | --- | --- |
| ① 形态 | 无存在感的常驻者，功能按需唤起、用完即退 | 内核常驻进程恒为 1 个 `kored`；oneshot 插件空闲进程数 = 0；默认后台定时器数量 = 0；空闲 CPU ≈ 0 |
| ② 架构 | 内核只定规则不做业务，插件可装、可卸、可替换 | `internal/core` 出现插件 import（含历史 `plugins/` 路径）命中数 = 0；内核内业务模块数 = 0 |
| ③ 资源 | 内核与常驻插件都吃得住预算，低频功能不占地 | 主壳空载 RSS ≤ 8 MiB（目标 5–6）；常驻插件单 ≤ 12 MiB、合计 ≤ 24 MiB；oneshot 空闲 RSS = 0；空载 1 进程 + 0~3 常驻插件 |
| ④ 开放 | 代码开源、配置明文、协议开放，无账号无联网校验 | 出网 HTTP 客户端数 = 0；遥测上报点 = 0；`/etc/kore/config.yaml` 全明文 |
| ⑤ 体验 | 效率优先：合理信息密度、最短路径、克制视觉 | 前端首屏 ≤ 300 KiB gzip；默认暗色高密度；高频操作 ≤ 2 次点击 |

## 当前状态

**M0 · 文档与骨架（本次交付）**：`docs/` 文档基线、`.agents/` 协作体系、仓库骨架与门禁脚本落盘；**零业务代码**，`cmd/kored` 与 `internal/**` 要到 M1 才有第一行实现，因此 M0 阶段构建目标不可运行——这是预期状态，不是缺陷。

```
M0 ████████████ 文档 + 骨架（当前状态，待独立验收）
M1 ░░░░░░░░░░░░ Walking Skeleton
M2 ░░░░░░░░░░░░ 插件生态 MVP
M3 ░░░░░░░░░░░░ 生产可用
M4 ░░░░░░░░░░░░ 生态开放
```

## 文档导航

| 文件 | 内容 | 适合谁读 |
| --- | --- | --- |
| [docs/VISION.md](docs/VISION.md) | 定位、五锚点、非目标、成功判据 | 所有人，先读 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 组件图、进程模型、插件状态机、故障域 | architect / implementer |
| [docs/CORE.md](docs/CORE.md) | 九个内核模块 + 4 个支撑小节（共 13 节）的职责、输入输出、失败模式、不做什么；21 个端点（14 业务 + 7 store） | 改内核的人 |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | 术语表：五锚点、插件类型、能力、预算、角色的准确定义 | 所有人，写文档前先对齐用词 |
| [docs/PLUGIN-PROTOCOL.md](docs/PLUGIN-PROTOCOL.md) | UDS + 4B 长度前缀 + JSON、8 MiB 帧上限、方法表、错误码、生命周期 | 写插件 / 写 supervisor |
| [docs/RESOURCE-MODEL.md](docs/RESOURCE-MODEL.md) | 预算表、cgroup v2 落地、度量口径、超预算处置 | 做资源门禁的人 |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | config.yaml schema、bbolt bucket/key、日志轮转、备份恢复 | 改存储 / 部署 |
| [docs/FRONTEND.md](docs/FRONTEND.md) | 主壳路由、插件前端契约、暗色令牌、go:embed 构建 | 前端 |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型、鉴权会话、CSRF、能力校验点、隔离手段 | 安全 / red-team |
| [docs/DECISIONS/](docs/DECISIONS/) | ADR：每个不可逆选择的备选对比、后果与复审条件 | 想改设计前先读 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | M0–M4 目标、交付物、退出条件、依赖图 | 排期 / 验收 |
| [docs/PLAN.md](docs/PLAN.md) | M0 WBS、后续 sprint、DoD 四维、验收命令 | 开工前 |
| [docs/MILESTONE-M0.md](docs/MILESTONE-M0.md) | 本次交付文件级清单与可执行验收标准 | 验收时 |
| [.agents/README.md](.agents/README.md) | agent 体系为什么存在、角色总览、产物地图 | 新加入的 agent |
| [.agents/WORKFLOW.md](.agents/WORKFLOW.md) | Kore Loop 七阶段门禁、讨论协议、状态机 | 每个任务 |
| [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md) | G1–G10 门禁命令与分层 | 交付前 |

## 目录结构

```
cmd/kored/                # 主壳入口：只装配内核，不写业务
internal/core/            # 内核：只定规则，不对外暴露
  httpapi/                # /api/v1 + SSE，鉴权后的唯一 HTTP 入口
  auth/                   # 本地会话签发与校验，无外部账号体系
  registry/               # 插件清单、安装包登记与版本记录
  supervisor/             # 插件进程生命周期、热升级、崩溃回收
  bus/                    # 内核内事件分发，SSE 的数据源
  store/                  # bbolt 键值持久化，唯一状态落盘处
  config/                 # config.yaml 解析、校验与默认值
pkg/pluginapi/            # 公开 SDK：帧格式、方法名、能力白名单、错误码；插件唯一依赖面
web/                      # Vue3 + Vite 前端，dist 经 go:embed 进主壳
docs/                     # 契约与决策文档：先读文档再写代码
docs/DECISIONS/           # ADR：不可逆选择的备选对比与复审条件
.agents/                  # agent 协作中枢：角色、流程、任务板、变更集、门禁、复盘（只存在于本仓库）
.agents/templates/        # 提案 / 任务 / 评审 / 复盘模板，直接复制填写
scripts/                  # 门禁与维护脚本（docs-check 等）
Makefile                  # 唯一入口：make help 看全部目标
```

**本仓库没有 `plugins/` 目录**：插件住在各自的 `kore-plugin-<id>` 仓库，通过 `pkg/pluginapi` + `/run/kore/plugins/<id>.sock` 与内核交互。把插件代码塞进这里会被 G-13 直接打回。

## 快速开始

**M1 起可用**。M0 阶段下面这条命令只是占位：仓库里还没有 `cmd/kored` 源码，`make build` 会打印 `[SKIP] cmd/kored 未就绪` 并以退出码 0 结束——这是骨架的预期行为，不是可运行。

```bash
# M1 起可用：产出 bin/kored 并启动主壳
make build && ./bin/kored
```

M0 阶段真正能跑的是文档门禁：

```bash
make docs-check    # 校验文档头元信息、相对链接可达、占位词不泛滥
make help          # 列出全部 make 目标与 M0 现状
```

### 多仓库本地布局

```bash
~/Work/GolandProjects/
  kore/                # 本仓库（M0 已建）：内核 + pkg/pluginapi + 前端 + docs + .agents
  kore-plugins/        # M1：插件索引
  kore-plugin-echo/    # M1：示例插件仓库
```

跨仓库联调用 Go workspace 编排（`go.work` 是**本机配置，不提交**）：

```bash
cd ~/Work/GolandProjects
go work init kore kore-plugin-echo    # 内部开发时把插件仓库纳入同一 workspace
go work use kore-plugins              # 需要联调索引脚本时再加
```

`go.work` / `go.work.sum` 必须写进 `.gitignore`：workspace 解决"本地同时改两个仓库"，不是交付格式；插件发布仍走各自仓库的 tag。

## 支持的平台

三层分级：Linux 是主线，Windows / macOS 能用但隔离降级，低于下限直接以退出码 6 结束（不做兼容垫片）。

| 层级 | 平台 | 能力 |
| --- | --- | --- |
| **Tier A** | Linux：amd64 / arm64 — Ubuntu 20.04+、Debian 11+、Rocky / RHEL 兼容 8+、Fedora 38+、openSUSE Leap 15.5+、Alpine 3.19+ | 全功能：systemd + cgroup v2 隔离、插件独立用户 `kore-<id>`、socket 权限 + `SO_PEERCRED` 校验、完整资源限额 |
| **Tier B** | Windows 10 1809+、macOS 12+ | 可用，但隔离与限额降级：无 cgroup v2 / 插件独立用户，资源限制与进程隔离强度低于 Linux |
| **不支持** | Windows 7 / 8、macOS 11 及更低、armv7、386 | OS 版本或架构低于下限 → 进程以**退出码 6** 结束，不提供兼容分支 |

- **一个静态二进制**：`CGO_ENABLED=0` + `-buildvcs=false`，不依赖 glibc / musl 运行期；Linux 上 `file bin/kored` 应为 static、无 interpreter。
- **架构基线**：`GOAMD64=v1`（SSE2 起步，不依赖 AVX）、`GOARM64=v8.0`。
- **平台专有 API 隔离**：`internal/core` 不得直接调用 `syscall` / 平台分支，一律收进 `internal/platform`（G-16 / G13 双门禁）。
- **不要求升级内核、不要求关闭 SELinux**：cgroup v2 不可用时降级为只监控；降级矩阵写死"能做什么 / 不能做什么"，**禁止静默降级**。

> **Windows 上插件与主壳同用户运行**，靠 Job Objects 限额 + HMAC 身份校验；隔离强度低于 Linux，生产敏感场景建议用 Linux。

门禁：`make compat-info`（参数 + `file` + `go version -m`）+ Windows / macOS 交叉编译 + `syscall` 隔离检查，三项都进 G13，里程碑层必跑。

## 资源承诺

| 承诺 | 数字 |
| --- | --- |
| 空载进程数 | 1 个主壳（`kored`） |
| 同时常驻插件 | 0–3 个（22 个插件全装也按需唤醒，不常驻） |
| 常驻合计内存 | ≤ 24 MiB（单个 ≤ 12 MiB） |
| 空闲 CPU | ≈ 0（空载 60s CPU 时间 ≤ 60ms，无轮询） |

这是设计约束，不是营销数字：每个里程碑用 `make idle` + `ps` 实测，超了按未完成论处（G-03 / G-19）。

## 开发约定

- **依赖白名单**：主壳直接依赖上限 3 = `yaml.v3` / `bbolt` / `protobuf`（M3 引入）；禁 Web 框架、gRPC、NATS、SQLite、Redis 客户端、容器 SDK。
- **禁常驻中间件**：不引入 Redis / MQ / 容器运行时，隔离直接用 systemd + cgroup v2 + 文件系统。
- **资源门禁**：主壳空载 RSS ≤ 8 MiB、常驻插件单 ≤ 12 MiB / 合计 ≤ 24 MiB、单二进制 ≤ 25 MiB、前端首屏 ≤ 300 KiB gzip、空闲 CPU ≤ 0.1%、空载 goroutine ≤ 20；内存上限靠 `GOMEMLIMIT=6MiB` + `GOGC=100` 守（GOGC 调高只放大堆峰值，不是压上限的工具；实测仍超则降到 `GOGC=50`）。证据口径：`GOGC=100/200` 双跑 × 各 60 点中位数 × `smaps` 拆 `RssAnon` / `RssFile`。
- **前端栈**：Vue3 + Vite + TS + Element Plus（按需）+ UnoCSS + unplugin-icons；composables 不引 Pinia；插件前端是 ES module，用原生 `import()` 动态加载；`web/dist` 经 `go:embed` 进主壳；默认暗色高密度。

## 开源

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Kore 以 **MIT** 协议开源。**版权人**是 [`pengtang1024`](https://github.com/pengtang1024)（自然人），**仓库归属**是 GitHub 组织 [`kore-pl`](https://github.com/kore-pl)——两者是不同概念，Go module 路径仍是 `github.com/pengtang1024/kore`（见 [ADR-0024](docs/DECISIONS/0024-repo-topology-and-gitea.md)）。内核、索引与 24 个插件仓放同一份 `LICENSE`；治理规则（贡献、决策、发版、安全披露）唯一真源见 [docs/OPEN-SOURCE.md](docs/OPEN-SOURCE.md)。

**25 个兄弟仓统一九件套**（24 个插件仓 + `kore-plugins`：`CONTRIBUTING` / `SECURITY` / `CODE_OF_CONDUCT` / `AGENTS` / PR 模板 / issue 模板三件 / `ci.yml` / README 开源段）：唯一真源是 `scripts/plugin-templates/`，幂等同步 `bash scripts/plugin-oss-sync.sh`，跨仓校验 `bash scripts/plugin-oss-check.sh`，并由 `make check` **第 13 段**逐仓复核（口径见 [OPEN-SOURCE.md §3–§4](docs/OPEN-SOURCE.md)）。

- **如何贡献**：[CONTRIBUTING.md](CONTRIBUTING.md)——PR 即按 MIT 授权（inbound = outbound），**不要求 CLA**，签名用 `git commit -s`（DCO）；行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- **安全披露**：[SECURITY.md](SECURITY.md)（披露流程，72 小时确认 / 90 天协调披露）与 [docs/SECURITY.md](docs/SECURITY.md)（安全设计）——**两者不要混**。
- **本项目不收集任何遥测**：无账号、无上报、无隐藏出网；空载 `ss -tnp` 为空。CI 只在主干 / tag / PR 上跑（少触发），与遥测无关——省的是 runner 分钟，不是数据。

## 参与方式

Kore 由 6 个固定角色的 agent 协作推进：lead 拆解与验收、architect 定边界、implementer 实现、verifier 独立复跑门禁、red-team 蓝军攻击、scribe 维护文档与复盘。
所有任务都走 Kore Loop 七阶段：提案 → 双评审 → 拆解 → 实现 → 验证 → 蓝军 → 归档复盘，产物落文件而不是停在对话里。
入口、角色卡与反模式清单见 [.agents/README.md](.agents/README.md)；开工前先读根 [AGENTS.md](AGENTS.md)。
**插件开发请去对应的 `kore-plugin-<id>` 仓库**；本仓库只收内核与协议 SDK，跨仓库改动按变更集登记（见 [.agents/WORKFLOW.md](.agents/WORKFLOW.md)）。

## 原则

- **开源**：代码可见可改，没有闭源黑盒。
- **无厂商锁**：不绑定云服务、不绑定商业控制面，换台机器照样跑。
- **无遥测**：不上报任何使用数据，出网连接为零。
- **配置明文**：YAML 明文，看得懂、改得动、可版本化。

## License / Contributing / Security

- [License](LICENSE) — MIT，版权人 `pengtang1024`
- [Contributing](CONTRIBUTING.md) — 开发环境、提交规范、PR 要求与 G-01 ~ G-25 门禁清单
- [Security](SECURITY.md) — 漏洞披露流程；安全设计见 [docs/SECURITY.md](docs/SECURITY.md)
