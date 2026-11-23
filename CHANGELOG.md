# Changelog

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 未发布

首个 MVP 版本，覆盖 M0（文档与骨架）与 M1（内核骨架 + 首个插件）。

### Added

- **文档基线（M0）**：VISION / ARCHITECTURE / CORE / PLUGIN-PROTOCOL / RESOURCE-MODEL / DATA-MODEL / FRONTEND / SECURITY / ROADMAP / PLAN / GLOSSARY，以及 ADR 决策记录体系。
- **公开 SDK**：`pkg/pluginapi` 作为独立嵌套 module（根 `go.mod` 用 `replace => ./` 指向），插件只依赖该包。
- **内核六模块（M1）**：`config` / `store` / `auth` / `httpapi` / `registry` / `supervisor` 落地；`bus` / `installer` / `market` 由后续里程碑补齐。
- **内核定时任务（ADR-0019）**：新增 `internal/core/scheduler`（单一 ticker，30s 检查）——5 段表达式自写解析（零依赖）、`state.db` 的 `scheduler_tasks` / `scheduler_runs` 任务与执行记录、停机错过不补跑、同任务不并发、单任务超时；`cert_renew` 迁移为内置任务（`cert.renew_due`），G-19 白名单由"仅 `cert_renew`"泛化为"仅 `scheduler`"；新增 4 个 `system:admin` 端点（`GET/POST /api/v1/scheduler/tasks`、`POST .../{id}/run`、`DELETE .../{id}`）。
- **门禁体系**：`make check` 七段聚合门禁（docs-check / 依赖白名单 / 薄壳边界 / 跨仓库边界 / 口径唯一性 / 台账 / worktree 卫生）；本次新增第 8 段 `oss-check`。
- **i18n 骨架（中文为主，英文为辅；ADR-0021）**：新增 `web/i18n.js`（`t()` / `setLocale()` / `onChange()`，零依赖）与 `web/i18n/zh-CN.js`（52 键：18 项导航 + 分组/抽屉 + 通用组件 + 设置页）、`web/i18n/en-US.js`（对应英文，缺项回退中文）；导航标签、分组标题、「更多」抽屉、搜索入口与设置页语言选择器走 `t()`；默认 `zh-CN`、不猜浏览器语言，选择写 `localStorage`，`en-US` 切语言时才懒加载；`make frontend` 新增 i18n 两文件 gzip ≤ 3 KiB 硬校验。G-11 的 i18n 非目标同步收窄为「不做全量框架」，FRONTEND / VISION / USABILITY / PLUGIN-MATURITY 等同轮对齐。
- **门禁扩至 9 段**：新增第 9 段 `case-check`（大小写一致性：module 路径全小写、无同目录大小写冲突、插件 id 小写、文档 URL owner 小写）。
- **首个插件**：`kore-plugin-echo` 独立仓库，验证 `info.json` + `Makefile dist` + `CHANGELOG` 三件套与 pluginapi 调用链。
- **开源资产**：MIT `LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、披露政策 `SECURITY.md`、本 `CHANGELOG.md`、`.github/` CI 与 Issue/PR 模板、`make oss-check`。
- **仓库级开源资产补到 25 个兄弟仓**（24 个插件仓 + `kore-plugins`）：每仓九件套（`CONTRIBUTING` / `SECURITY` / `CODE_OF_CONDUCT` / `AGENTS` / PR 模板 / issue 模板三件 / `ci.yml` / README 开源段）；唯一真源 `scripts/plugin-templates/`（`plugin-repo/` + `index-repo/`），配套 `scripts/plugin-oss-sync.sh`（幂等渲染）与 `scripts/plugin-oss-check.sh`（跨仓校验），并接入 `make check` **第 13 段**作为阻断级门禁。
- **门禁扩至 13 段**：新增第 13 段 `plugin-oss-check`（逐仓校验 25 个兄弟仓九件套存在、README 标记块、`LICENSE` 与 `kore` 逐字一致、`ci.yml` 少触发）；`make check` 现在是 docs / 依赖与兼容基线 / 薄壳 / 跨仓 / 口径 / 台账 / worktree / oss / 大小写 / 首屏 / 零侵入 / 明文凭据 / 插件仓九件套 13 段。

### Changed

- **根文档补到逐插件粒度**：`docs/OPEN-SOURCE.md` 新增「多仓开源资产矩阵」（26 仓 × 10 类资产）、「插件仓开源资产规范（九件套）」、「名称与标识」、「贡献者路径（good first issue / 插件作者 / 维护者）」，并把安全时限统一到根 `SECURITY.md` 的 **72 小时确认 / 90 天协调披露**（删除旧的 48h / 7d / 30d 表述）；`docs/PLUGIN-CATALOG.md` 新增 §15 逐插件开源信息（20 个产品插件 × 仓库 / Issues / Releases / 维护状态 / 验证方式，`echo` 单列为验证件不参与评级）；`docs/REPOS.md` 仓库清单加「开源资产」列并新增规则 **R9 开源资产自包含**，发布流程补每仓 release 资产（`tar.gz` + `.sha256`）与 CI tag 触发说明；`docs/PLUGIN-SDK.md` 新增九件套清单；`docs/README.md`、根 `README.md`、`CONTRIBUTING.md`（10 段 → 13 段）、`AGENTS.md` G-26、`.agents/QUALITY-GATES.md` G19、`.github/PULL_REQUEST_TEMPLATE.md`、`.github/workflows/ci.yml`（job 名 8 → 13 segments）同轮对齐。
- **CI 少触发口径统一**：26 个仓（`kore` + 24 插件仓 + `kore-plugins`）都配 CI，但只在 `push main` / tag / `pull_request` / `workflow_dispatch` 时跑；日常 feature 分支 push 不跑，Gitea 不配 CI。日常反馈以本地 `make check`（13 段）为主，CI 只做合入兜底；`make idle` / `make budget-check` 需要真实进程，仍归本地与里程碑门禁。
- **仓库归属与权威源（ADR-0024）**：文档区分「版权人 `pengtang1024`」与「仓库归属 `kore-pl` 组织」，明确自建 Gitea `gitea.iouf.cn/kore-pl` 为唯一权威源、GitHub / gitee 为镜像，issue / PR 只在 Gitea 更新；module 路径保持 `github.com/pengtang1024/...` 不变。

### Fixed

- **HTTP 业务方法名校验（2026-11-23）**：`validateMethod` 的方法段此前只允许小写，插件按自身命名声明的方法（如 `site.bindSSL` / `site.setRewrite`）经 `POST /api/v1/invoke` 会被 400 拒绝；现放宽为「段首小写、段内允许 camelCase」，与插件方法注册表一致，既有纯小写方法不受影响。
- **SDK 发布链（2026-11-22）**：`pkg/pluginapi/v0.1.0` 打 tag 时 `go.mod` 仍是旧 module 路径（`github.com/kore-project/...`），干净目录无法消费；发布物不可改写（proxy / sumdb 已缓存），改为 `retract v0.1.0` 并发布 `pkg/pluginapi/v0.1.1`，`kore-plugin-echo` 同步升到 `v0.1.1`。

### Security

- 安全漏洞披露流程见根 [SECURITY.md](SECURITY.md)；设计文档见 [docs/SECURITY.md](docs/SECURITY.md)。

[0.1.0]: https://github.com/kore-pl/kore/releases/tag/v0.1.0
