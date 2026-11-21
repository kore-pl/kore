# 贡献指南（CONTRIBUTING）

感谢参与 kore。动手前请先读 [AGENTS.md](AGENTS.md)（协作与硬门禁）与 [docs/OPEN-SOURCE.md](docs/OPEN-SOURCE.md)（开源化政策，MIT）。

## 1. 开发环境

- **Go 1.26+**（`go.mod` 已声明 `go 1.26`）；构建统一 `CGO_ENABLED=0`。
- `make build`：构建 `bin/kored`（`-trimpath -buildvcs=false -s -w`）。
- `make check`：聚合门禁，必须全绿。当前为 **9 段**（docs-check / 依赖白名单 / 薄壳边界 / 跨仓库边界 / 口径唯一性 / 台账 / worktree 卫生 / `oss-check` / **`case-check`**）。
  - 第 9 段 `case-check`：大小写一致性——module 路径全小写且无 `!` 转义、无同目录大小写冲突、插件 `id` 小写、文档 GitHub URL 的 owner 段小写。
- 单测 / 静态检查：`make vet`、`make test`。
- 资源类改动额外跑 `make mem`；里程碑收口再跑 `make idle` / `make budget-check`（需要真实进程，不在 CI 跑）。

## 2. 多仓库结构与本地联调

kore 是**多仓库项目**，依赖单向，内核不 import 任何插件：

| 仓库 | 定位 | module |
| --- | --- | --- |
| `kore` | 内核 + `pkg/pluginapi` + 主壳前端 + 文档 | `github.com/pengtang1024/kore` |
| `kore-plugins` | 纯静态索引与预设 | `github.com/pengtang1024/kore-plugins` |
| `kore-plugin-<id>` | 每个插件一仓，只依赖 `pkg/pluginapi` | `github.com/pengtang1024/kore-plugin-<id>` |

本地联调用 `go.work`，**不要把跨仓 `replace => ../` 提交进仓库**：

```bash
# 在并列目录的父级执行
go work init ./kore ./kore-plugin-echo
go work use ./kore-plugins
go work sync
```

## 3. 提交规范

- 格式：`type(scope): 中文描述`，type ∈ `feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore` / `build`。
- scope 用模块名，如 `core/supervisor`、`docs`、`agents`。
- **精确 `git add <file>`，禁止 `git add .` / `git add -A`**；提交前 `git status --short` 人工核对。
- 不提交未验证改动；门禁没过就报告阻塞，不"先提交再说"。
- 一个自洽的检查点就提交，不攒到最后。

## 4. PR 要求

1. 先 `make check` **9/9 绿**（含 `oss-check`、`case-check`），把关键输出贴进 PR 模板。
2. 插件 PR 必须带 `info.json`、`Makefile` 的 `dist` 目标、`CHANGELOG.md` 三件套。
3. 改协议或数据格式（`pkg/pluginapi`、`info.json`、索引、预设 schema）**必须附 ADR**，写清兼容性与版本影响。
4. 一个 PR 只做一件事；无关重构拆开提。
5. 评审意见用证据回应（命令 + 输出），不空口争论。

## 5. 门禁清单（G-01 ~ G-27 摘要）

完整定义见 [AGENTS.md](AGENTS.md) §2 与 [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md)。

| 编号 | 摘要 |
| --- | --- |
| G-01 | 薄壳：`internal/core` 只做规则，不写业务、不 import 插件 |
| G-02 | 依赖白名单：第三方直接依赖 ≤3；同仓 module 必须 `replace => ./` |
| G-03 | 资源预算：主壳 ≤16 MiB 红线（目标 8），插件单 ≤24 / 合计 ≤48 MiB |
| G-04 | 进程隔离：插件独立进程 + 独立 socket，禁止同进程动态库 |
| G-05 | 无中间件：禁 Redis / NATS / MQ / 容器运行时 |
| G-06 | 文档同步：路径 / 协议 / 预算 / 角色名一处改、全处改 |
| G-07 | 证据验收：命令 + 退出码 + 关键输出，禁止"应该没问题" |
| G-08 | 写域不相交：并行任务 `write_scopes` 不重叠 |
| G-09 | 角色不可兼任：implementer ≠ verifier |
| G-10 | 无联网 / 无遥测：无账号、无隐藏上报、无功能封锁 |
| G-11 | 非目标保护：6 项明确不做（RBAC / 集群 / 模板市场等） |
| G-12 | 提交纪律：精确 `git add`，禁 `add .` |
| G-13 | 仓库边界：插件代码 / 前端 / 索引不进 `kore` |
| G-14 | 协议兼容：`info.json` 声明 `requires_kore`，破坏性改动升主版本 + ADR |
| G-15 | 跨仓库变更集：在 BOARD 登记仓库 / commit / 顺序 |
| G-16 | 兼容性基线：`CGO_ENABLED=0`、`GOAMD64=v1`、`GOARM64=v8.0`、`-buildvcs=false` |
| G-17 | 插件仓三件套：`info.json` + `Makefile dist` + `CHANGELOG.md` |
| G-18 | 预设一致性：id / 版本区间可解析，资源不超预算 |
| G-19 | 空闲行为：60s CPU ≤60ms、goroutine ≤20、fd ≤64、禁止轮询 |
| G-20 | 深度等级：`production` / `basic` 必须声明并在商店展示 |
| G-21 | 无副作用诊断：禁 `SetGCPercent(-1)` / `SetMemoryLimit(-1)` |
| G-22 | 优化顺序：设计层 → 架构层 → 代码层，调参须记 ADR |
| G-23 | 判断留痕：`DECISIONS.md` / `DISPATCH.md` 台账 |
| G-24 | 无 any / object 逃逸：对外 schema 禁 `any` / `object` / `map[string]any` |
| G-25 | worktree 卫生：无残留 worktree 与 `wt-*` / `tmp-*` 分支 |
| G-26 | 开源资产完整：`LICENSE`(MIT) / `CONTRIBUTING` / `CODE_OF_CONDUCT` / `SECURITY` / `CHANGELOG` / CI 齐备 |
| G-27 | 大小写一致性：module 全小写无 `!` 转义、无同目录大小写冲突、插件 id 小写、文档 URL owner 小写 |

> G-26 / G-27 分别由 `make oss-check` 与 `make case-check` 守护。

## 6. 如何新增插件

1. **建仓**：新建 `kore-plugin-<id>` 独立仓库，module 为 `github.com/pengtang1024/kore-plugin-<id>`，只依赖 `kore/pkg/pluginapi`。
2. **填 `info.json`**：至少含 `depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore` / `depth_level` / `lifecycle`；同时补 `Makefile` 的 `dist` 与 `CHANGELOG.md`。
3. **发索引 PR**：向 `kore-plugins` 提交 `index/plugins.json` 条目与对应预设更新，跑通该仓校验脚本后提 PR。

## 7. 安全披露

发现漏洞**不要开公开 issue**，按 [SECURITY.md](SECURITY.md) 走邮件披露（72h 确认、90 天协调披露）。本文件不重复流程细节。

## 8. 行为准则

参与即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
