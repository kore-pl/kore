> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: accepted（2026-11-23 lead 裁决）· 关联: ../REPOS.md、0017-repo-ownership-and-module-path.md、../RUNBOOK.md、../PLUGIN-MATURITY.md

# ADR-0024: 仓库拓扑与 Gitea 权威源

## 0. 结论（四条）

| # | 决策 | 一句话 |
| --- | --- | --- |
| A | **仓库位置** | GitHub 从个人账号 `pengtang1024` 迁到组织 **`kore-pl`**（26 仓，tag/release 随仓迁移，旧地址 302） |
| B | **权威源** | 自建 **Gitea `gitea.iouf.cn/kore-pl`** 为唯一权威源；GitHub / gitee 为镜像推送目标 |
| C | **module 路径** | **保持不变**：`github.com/pengtang1024/kore`（仓库地址与 module 路径是两件事，不得混写） |
| D | **Issues/PR** | 只在 Gitea 更新；GitHub 上的 8 个 issue 保留为公开镜像并加迁移标注 |

## 1. 决策 A：仓库迁移到 `kore-pl` 组织

**背景**：项目早期使用个人账号 `pengtang1024`（ADR-0017 决策 C 明确记录"未来仍可迁组织"）。M5 阶段仓库数达 26 个，权限、审计与协作都要求组织级归属。

**结论**：26 个仓库（`kore`、`kore-plugins`、24 个 `kore-plugin-*`）全部迁入 GitHub 组织 **`kore-pl`**；tag 与 release 随仓迁移，旧地址 `github.com/pengtang1024/*` 由 GitHub 302 重定向。

**被否决**：

- 保留个人账号：组织级权限/审计缺失，26 仓手工授权不可维护；
- 只迁核心仓、插件仓留个人：拓扑分裂，`require` 与文档要写两套 owner；
- 迁移同时改 module 路径：见决策 C，成本不可接受。

**后果**：所有**仓库地址**必须写 `github.com/kore-pl/...`；**module 路径**不动（决策 C）；迁移事实记录于 [ADR-0017](./0017-repo-ownership-and-module-path.md)「迁移记录」。

**复审条件**：组织权限模型变更、或需要多组织拆分时重审。

## 2. 决策 B：自建 Gitea 作为唯一权威源

**现状**：`https://gitea.iouf.cn/kore-pl`（Gitea 1.27.3，自建，无 API 限流）。

**拓扑（三端分工）**：

| remote | 指向 | 用途 | 推送频率 |
| --- | --- | --- | --- |
| `origin` | `gitea.iouf.cn/kore-pl/<repo>` | **权威源**：日常提交、PR、issue、tag | 每个检查点 |
| `github` | `github.com/kore-pl/<repo>` | 公开镜像（社区可见） | 每阶段 / 发布时 |
| `gitee` | `gitee.com/<owner>/<repo>` | 国内镜像 | 每阶段 / 发布时 |

**理由**：GitHub 的 secondary rate limit 严重拖慢多仓操作——26 仓 `transfer` 遇 422、必须 60s 退避重试，一次全量迁移要排队数十分钟；CI 与批量 tag 同样受限。自建 Gitea 无限流、响应稳定，且 issue/PR 与代码同源。

**被否决**：

- 继续只用 GitHub：限流无解，26 仓批量操作不可控；
- 只迁 gitee：Gitee 用户基数与生态弱，不能作为主源；
- 三端等权（都当权威）：issue/PR 会漂移，token 与冲突处理成本翻倍。

**后果**：

1. **单一权威源**意味着 Gitea 是单点故障 → 必须定期 `git clone --mirror` 到 GitHub（推送即备份），并演练恢复；
2. 开发者流程以 Gitea 为准（PR / issue / review），GitHub 仅镜像；
3. CI 优先跑在 Gitea Actions 或本地门禁（`make check`），GitHub Actions 保留为镜像侧抽查。

**复审条件**：Gitea 可用性/容量不足、公网暴露策略变化、或镜像恢复演练失败。

## 3. 决策 C：module 路径保持 `github.com/pengtang1024/kore`

**关键区分**（文档必须分开写，不允许混用）：

| 概念 | 值 | 出现位置 |
| --- | --- | --- |
| **仓库地址** | `github.com/kore-pl/kore` | 链接、clone、issue、release |
| **Go module 路径** | `github.com/pengtang1024/kore` | `go.mod`、import、`require`、`replace`、SDK tag |

**理由**：改 module 路径是**破坏性变更**——已发布的 SDK `v0.1.0`–`v0.1.3` 的 import 全部失效，24 个插件仓的 `require` 与 `replace` 全部要改，且需要重发全部 SDK 版本并保留旧 tag 的兼容窗口。Go 允许 module 路径与仓库位置不同，**收益只是"看起来一致"**，成本远大于收益。

**被否决**：

- 立即改 module 路径：成本高、收益低，且当前无功能收益；
- 改 module 但保留旧 import 兼容层：Go 没有 module 别名机制，只能在代码里加转发包，污染 SDK 面。

**后果**：文档模板统一为「module 实际值 + 仓库地址新组织」；新贡献者可能困惑，故 [AGENTS.md](../../AGENTS.md) 与 [REPOS.md](../REPOS.md) 首屏即写清两条。

**复审条件**：v1.0 发布前若认为必要，**单独立 ADR**（新 tag 线、弃用窗口、24 仓批量迁移与重发方案、回滚判据），不得夹带在其他改动里。

## 4. 决策 D：Issues / PR 在 Gitea

**双层结构**：

- **集中层**：`kore-pl/kore` 的 issue = 跨仓 / 内核 / 协议类任务；
- **分散层**：各 `kore-plugin-*` 仓的 issue = 该仓自身能力缺口。

**与台账的关系**：`.agents/BOARD.md` 仍是**权威台账**（G-15 / G-23）；Gitea Issues 是公开镜像 + 可认领队列，建 issue 后回填编号，双向可查。

**GitHub 侧**：8 个已有 issue 保留不关闭，逐条加注释说明"已切换 Gitea 权威源，后续更新看 Gitea"。

**被否决**：GitHub + Gitea 双写（必然漂移）；只用 GitHub（限流）。

**后果**：issue 编号以 Gitea 为准；`gh issue list` 仅用于镜像核对。

## 5. 影响面

| 对象 | 变化 |
| --- | --- |
| 文档 | 仓库地址统一 `kore-pl`；module 声明保持 `pengtang1024`；新增本 ADR 与 ADR-0017 迁移记录 |
| 脚本 / 门禁 | 除 `case-check` 的历史名豁免外，不依赖 owner；`dep-check` 判据必须是 module 实际前缀 |
| CI / 流程 | 日常推 Gitea；阶段推 GitHub + gitee；issue/PR 在 Gitea |
| 发布链 | tag 推送三端；索引与签名同批（见 ADR-0023 阶段经验） |

## 6. 复审条件汇总

1. Gitea 不可用 / 容量不足 / 恢复演练失败 → 重审权威源；
2. v1.0 前若 module 路径必须迁 → 单独立 ADR；
3. 组织权限或仓库数量变化 → 重审决策 A；
4. GitHub 限流解除且社区要求回归 → 重审决策 B。
