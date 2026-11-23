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
- **门禁扩至 9 段**：新增第 9 段 `case-check`（大小写一致性：module 路径全小写、无同目录大小写冲突、插件 id 小写、文档 URL owner 小写）。
- **首个插件**：`kore-plugin-echo` 独立仓库，验证 `info.json` + `Makefile dist` + `CHANGELOG` 三件套与 pluginapi 调用链。
- **开源资产**：MIT `LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、披露政策 `SECURITY.md`、本 `CHANGELOG.md`、`.github/` CI 与 Issue/PR 模板、`make oss-check`。

### Fixed

- **HTTP 业务方法名校验（2026-11-23）**：`validateMethod` 的方法段此前只允许小写，插件按自身命名声明的方法（如 `site.bindSSL` / `site.setRewrite`）经 `POST /api/v1/invoke` 会被 400 拒绝；现放宽为「段首小写、段内允许 camelCase」，与插件方法注册表一致，既有纯小写方法不受影响。
- **SDK 发布链（2026-11-22）**：`pkg/pluginapi/v0.1.0` 打 tag 时 `go.mod` 仍是旧 module 路径（`github.com/kore-project/...`），干净目录无法消费；发布物不可改写（proxy / sumdb 已缓存），改为 `retract v0.1.0` 并发布 `pkg/pluginapi/v0.1.1`，`kore-plugin-echo` 同步升到 `v0.1.1`。

### Security

- 安全漏洞披露流程见根 [SECURITY.md](SECURITY.md)；设计文档见 [docs/SECURITY.md](docs/SECURITY.md)。

[0.1.0]: https://github.com/pengtang1024/kore/releases/tag/v0.1.0
