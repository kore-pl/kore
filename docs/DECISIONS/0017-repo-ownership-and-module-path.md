> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M1
> ADR 状态: accepted · 日期: 2026-11-22 · 决策者: lead · 关联: ../OPEN-SOURCE.md

# ADR-0017: 仓库归属与 module 路径

## 背景

项目从 M0 起一直以 `github.com/kore-project/kore` 作为 module 路径与"理想组织名"，但**从未验证该组织是否可用**——它只是文档里的一个占位符。

首次准备推送 GitHub 时探测（`gh`，2026-11-22）：

| 探测命令 | 结果 |
| --- | --- |
| `gh api orgs/Kore-Project` | 存在：`{"login":"Kore-Project","created_at":"2020-03-08T21:15:23Z","public_repos":0,"type":"Organization"}` |
| `gh api user/orgs` | `0` —— 当前账户不在任何组织 |
| `gh api orgs/Kore-Project/memberships/pengtang1024` | **404**（且该端点需 `admin:org` scope，当前 token 未授予） |

结论：`Kore-Project` 组织**确实存在但归属他人**（2020 年创建、0 public repos），当前账户 `pengtang1024` **不是成员、无任何管理权限**。"理想组织名"从未属于本项目。

## 选项对比

| 选项 | 结论 | 理由 |
| --- | --- | --- |
| A. 使用 `Kore-Project` 组织 | ❌ 否 | 无权限；需该组织现有 owner 邀请，不可控且可能永远等不到 |
| B. 新建自有组织（如 `kore-io`） | ❌ 否（本轮） | 需用户先建组织；M1 不应阻塞于组织，且建组织后再改 module 路径等于第二次破坏性变更 |
| C. **个人账号 `pengtang1024`** | ✅ 选 | 已登录、全权管理；`kore` 仓库名未被占用；可立即发布；未来仍可迁组织 |
| D. 保留 `kore-project` 路径、暂不发布 | ❌ 否 | module 路径与真实仓库不一致 → `go get` 404，插件仓无法独立构建，M1 直接卡死 |

## 决策

- 仓库归属：**`pengtang1024`（个人账号）**
- 内核 module：`github.com/pengtang1024/kore`
- SDK 子模块：`github.com/pengtang1024/kore/pkg/pluginapi`（子目录 tag `pkg/pluginapi/v0.1.0`）
- 插件仓：`github.com/pengtang1024/kore-plugin-<id>`；索引仓 `github.com/pengtang1024/kore-plugins`

## 影响面（已落地的改动）

| 范围 | 内容 |
| --- | --- |
| Go module | `go.mod`、`pkg/pluginapi/go.mod` 的 module 行与全部 import 路径 |
| 插件仓 | `kore-plugin-echo` 的 `go.mod` 与 import |
| 门禁 | `scripts/dep-check.sh` 同仓 module 前缀白名单改为 `pengtang1024/kore/` |
| 文档 | 77 文件 / 163 处（含 AGENTS.md、README.md、docs/REPOS.md、GLOSSARY.md、ARCHITECTURE.md、VISION.md、ROADMAP.md、MILESTONE-M0.md） |

## 后果与复审条件

- **迁入组织必须新开 ADR**：记录原因、迁移步骤、20+ 插件仓的下游影响、`requires_kore` 是否需要动，并同步所有仓库 `LICENSE` 与文档（见 [OPEN-SOURCE.md](../OPEN-SOURCE.md) §1）。旧 module 路径需保留 `replace` / `go-import` 兼容，或明确声明 breaking change。
- **版权人 = `pengtang1024`**，与根 `LICENSE` 的 `Copyright (c) 2026 pengtang1024` 一致。
- **不支持"两个 module 路径同时长期存在"**：双路径会让插件仓的 `require` 产生分叉，等于把兼容问题永久化。
- 复审触发：用户建立自有组织 / `Kore-Project` 主动邀请 / 插件仓数量超过 20 个需要统一治理时。

## 提交邮箱

M1 的 11 个 commit 作者与提交者邮箱为 `pengtang1024@qq.com`；用户明确选择**保留真实邮箱、不改写历史**。本 ADR 记录该决定，避免后人误判为漏配 `noreply` 地址而"顺手修正"——改写历史会改变所有 commit hash，破坏 `go.sum`、tag 与下游引用。

## 关联

- [ADR-0013](./0013-extreme-resource-frugality.md)（资源极简）、[ADR-0016](./0016-resource-budget-final.md)（预算定案）
- [OPEN-SOURCE.md](../OPEN-SOURCE.md) §1 版权与归属 / §2 多仓库许可一致性
- [REPOS.md](../REPOS.md) 仓库拓扑与 `replace` 规则（`=> ./pkg/pluginapi` 仍必须提交）
