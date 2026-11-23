# 贡献指南（CONTRIBUTING）

感谢参与 kore。动手前请先读 [AGENTS.md](AGENTS.md)（协作与硬门禁）与 [docs/OPEN-SOURCE.md](docs/OPEN-SOURCE.md)（开源化政策：MIT 许可、逐仓开源资产矩阵、九件套规范、名称与贡献者路径）。

## 1. 开发环境

- **Go 1.26+**（`go.mod` 已声明 `go 1.26`）；构建统一 `CGO_ENABLED=0`。
- `make build`：构建 `bin/kored`（`-trimpath -buildvcs=false -s -w`）。
- `make check`：聚合门禁，必须全绿。当前为 **13 段**（顺序即执行顺序）：
  1. `docs-check`——文档元信息 / 相对链接 / 占位词 / 行数 / 关键口径
  2. 依赖白名单 + 兼容基线（第三方直接依赖 ≤3，`CGO_ENABLED=0` / `GOAMD64=v1` / `GOARM64=v8.0` / `-buildvcs=false`）
  3. 薄壳边界（`internal/core` 只做规则、不写业务、不 import 插件）
  4. `repo-check`——跨仓库边界（本仓无插件代码 / 插件 import / 插件索引）
  5. `canonical-check`——口径唯一性（旧预算 / 旧字段 / 幽灵 id 清零）
  6. `log-check`——判断留痕台账（WARN 级，不阻断）
  7. `wt-check`——worktree 卫生（WARN 级，里程碑收口前必须清空）
  8. `oss-check`——`kore` 本仓根开源资产（MIT `LICENSE` / 根文档 / CI / 协议头，G-26）
  9. `case-check`——大小写一致性（module 全小写无 `!` 转义、无同目录大小写冲突、插件 `id` 小写、文档 URL owner 段小写）
  10. `frontend`——首屏体积 ≤300 KiB gzip（G-03 阻断级）
  11. 零侵入门禁（ADR-0023：安装目录外零新增写入）
  12. `secret-check`——明文凭据扫描（G-30）
  13. `plugin-oss-check`——**25 个兄弟仓九件套**（24 个插件仓 + `kore-plugins`：`CONTRIBUTING` / `SECURITY` / `CODE_OF_CONDUCT` / `AGENTS` / PR 模板 / issue 模板三件 / `ci.yml` / README 开源段）；任一仓缺件或 CI 触发漂移即整段红
- 单测 / 静态检查：`make vet`、`make test`。
- 资源类改动额外跑 `make mem`；里程碑收口再跑 `make idle` / `make budget-check`（需要真实进程，不在 CI 跑）。

## 2. 多仓库结构与本地联调

kore 是**多仓库项目**，依赖单向，内核不 import 任何插件：

| 仓库 | 定位 | module |
| --- | --- | --- |
| `kore` | 内核 + `pkg/pluginapi` + 主壳前端 + 文档 | `github.com/kore-pl/kore` |
| `kore-plugins` | 纯静态索引与预设 | `github.com/kore-pl/kore-plugins` |
| `kore-plugin-<id>` | 每个插件一仓，只依赖 `pkg/pluginapi` | `github.com/kore-pl/kore-plugin-<id>` |

本地联调用 `go.work`，**不要把跨仓 `replace => ../` 提交进仓库**：

```bash
# 在并列目录的父级执行
go work init ./kore ./kore-plugin-echo
go work use ./kore-plugins
go work sync
```

### 2.1 插件仓九件套与模板

**25 个兄弟仓**（24 个 `kore-plugin-<id>` + `kore-plugins`）各自必须带同一套开源资产，唯一真源是 [scripts/plugin-templates/](scripts/plugin-templates/README.md)。**不要直接编辑兄弟仓里的这些文件**——下一次同步会覆盖。

| 文件 | 硬要求 |
| --- | --- |
| `LICENSE` | MIT 全文，与 `kore` 逐字一致（不进模板，各仓各自提交） |
| `CONTRIBUTING.md` | 本仓 `make check` / `make dist` 命令、DCO、安全披露指向根政策 |
| `SECURITY.md` | 与根 `SECURITY.md` 同口径：**72 小时确认 / 90 天协调披露** |
| `CODE_OF_CONDUCT.md` | 与 `kore` 同一文本，举报渠道指向维护者 |
| `AGENTS.md` | **≤20 行**（R5），只写本仓事实 + 指向 `kore` 治理真源 |
| `.github/PULL_REQUEST_TEMPLATE.md` | 留 `make check` 与两次 `make dist` sha 一致的输出位 |
| `.github/ISSUE_TEMPLATE/` 三件 | `bug_report.yml`（版本 / `requires_kore` / 平台 / 复现 / 日志）、`feature_request.yml`、`config.yml`（`blank_issues_enabled: false`） |
| `.github/workflows/ci.yml` | **少触发**：`push main` / tag `v*` / PR / `workflow_dispatch`；Gitea 不配 |
| `README` 开源段 | `<!-- oss:begin -->` … `<!-- oss:end -->` 之间由模板渲染 |

```bash
# 同步（幂等；第二次运行 0 变更）——在 kore 仓根执行
bash scripts/plugin-oss-sync.sh
bash scripts/plugin-oss-sync.sh --dry-run     # 只打印将写哪些文件
bash scripts/plugin-oss-sync.sh --check       # 只报差异，全绿 exit 0

# 跨仓校验（等价于 make check 第 13 段）
bash scripts/plugin-oss-check.sh
```

**新插件仓建仓时**：新建 `kore-plugin-<id>` 仓 → 填 `info.json` / `Makefile`（含 `dist`）/ `CHANGELOG.md` → `bash scripts/plugin-oss-sync.sh ../kore-plugin-<id>` → `bash scripts/plugin-oss-check.sh ../kore-plugin-<id>`，两条都 exit 0 即完成九件套。逐文件职责与硬要求见 [docs/OPEN-SOURCE.md](docs/OPEN-SOURCE.md) §4。

### 2.2 CI 触发口径（少触发）

- **26 个仓都配 CI**（`kore` + 24 个插件仓 + `kore-plugins`），但只在 `push main` / tag / `pull_request` / `workflow_dispatch` 时跑；日常 feature 分支 push 不跑。
- **Gitea 不配 CI**（无 `.gitea/workflows/`、无 woodpecker / drone）；issue / PR 与日常提交在 Gitea（权威源，[ADR-0024](docs/DECISIONS/0024-repo-topology-and-gitea.md)），GitHub / gitee 是镜像。
- **日常反馈用本地 `make check`**，CI 只做"能否拉取 / 能否构建"的合入兜底；`make idle` / `make budget-check` 需要真实进程，CI 不跑。

## 3. 提交规范

- 格式：`type(scope): 中文描述`，type ∈ `feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore` / `build`。
- scope 用模块名，如 `core/supervisor`、`docs`、`agents`。
- **精确 `git add <file>`，禁止 `git add .` / `git add -A`**；提交前 `git status --short` 人工核对。
- **构建缓存与产物不入库**：`web/dist/`、`web/.cache/`（如 `web/.cache/charts/*.js`）、`bin/`、`*.test`、`*-raw.json` 这类生成物一律由 `.gitignore` 拦截，随 `git add .` 混入即回退；发现新的生成物先补忽略规则（`git check-ignore -v <path>` 验证命中）再提交，不要先提交后补规则。
- 不提交未验证改动；门禁没过就报告阻塞，不"先提交再说"。
- 一个自洽的检查点就提交，不攒到最后。

## 4. PR 要求

1. 先 `make check` **13/13 绿**（含第 13 段 `plugin-oss-check` 覆盖 25 个兄弟仓九件套），把关键输出贴进 PR 模板。
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
| G-26 | 开源资产完整：根资产（`LICENSE`(MIT) / `CONTRIBUTING` / `CODE_OF_CONDUCT` / `SECURITY` / `CHANGELOG` / CI）+ 25 个兄弟仓九件套（含 CI 少触发） |
| G-27 | 大小写一致性：module 全小写无 `!` 转义、无同目录大小写冲突、插件 id 小写、文档 URL owner 小写 |

> G-26 由 `make oss-check`（本仓根资产，第 8 段）+ `make check` 第 13 段 `plugin-oss-check`（25 个兄弟仓九件套）共同守护；G-27 由 `make case-check`（第 9 段）守护。

## 6. 如何新增插件

1. **建仓**：新建 `kore-plugin-<id>` 独立仓库，module 为 `github.com/kore-pl/kore-plugin-<id>`，只依赖 `kore/pkg/pluginapi`。
2. **填 `info.json`**：至少含 `depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore` / `depth_level` / `lifecycle`；同时补 `Makefile` 的 `dist` 与 `CHANGELOG.md`。
3. **发索引 PR**：向 `kore-plugins` 提交 `index/plugins.json` 条目与对应预设更新，跑通该仓校验脚本后提 PR。

## 7. 安全披露

发现漏洞**不要开公开 issue**，按 [SECURITY.md](SECURITY.md) 走邮件披露（72h 确认、90 天协调披露）。本文件不重复流程细节。

## 8. 行为准则

参与即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
