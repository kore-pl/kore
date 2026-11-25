> 状态: draft · 归属: wave1 · 更新: 2026-11-25 · 里程碑: M5

# Kore

Kore 是一个只做调度的薄壳内核：插件生命周期、权限校验、消息路由与资源隔离由内核定义规则，具体运维能力由 18–22 个独立插件仓提供。默认无账号、无联网校验、无遥测，配置全明文。首个发布版本是 0.1.1（0.1.0 从未发布）。

语言：[简体中文](DETAIL.md) · [English](DETAIL.en.md) · [Español](DETAIL.es.md) · [Français](DETAIL.fr.md) · [Deutsch](DETAIL.de.md) · [Русский](DETAIL.ru.md) · [Português](DETAIL.pt.md)

## 它做什么

- **薄壳调度**：内核不含运维业务，`internal/core` 里出现插件 import 命中数 = 0；插件独立进程、按需拉起、用完即退。
- **五锚点**：形态（常驻 1 进程、默认 0 定时器）、架构（内核只定规则）、资源（硬红线 ≤16 MiB 空载）、开放（出网客户端 0、遥测 0）、体验（首屏 ≤300 KiB gzip）。
- **多仓库**：本仓只放内核、公开 SDK `pkg/pluginapi`、主壳前端与协作中枢；插件住在 `kore-plugin-<id>` 仓，只依赖公开 SDK。
- **平台分级**：Linux 为 Tier A 全功能；Windows 10 1809+ / macOS 12+ 为 Tier B（隔离降级）；低于下限以退出码 6 结束。
- **零遥测**：无账号、无联网校验、无隐藏上报，配置明文。

## 快速开始

```bash
make docs-check    # 文档门禁：元信息、相对链接、占位词、行数
make help          # 全部 make 目标与 M0 现状

# M1 起可用：产出 bin/kored 并启动主壳
make build && ./bin/kored
```

首次使用请先读仓库根的 `QUICKSTART.md`（构建 → 最小配置 → 启动 → 首次登录）；多仓库联调用 `go work init kore kore-plugin-echo`，`go.work` 不提交。

## 安全与边界

漏洞披露走 [SECURITY.md](../SECURITY.md)（72 小时确认 / 90 天协调披露），不要开公开 issue；安全设计（威胁模型、鉴权、CSRF、能力校验、隔离）见 [docs/SECURITY.md](SECURITY.md)。发现隐藏出网、未声明上报或绕过权限校验按高危处理，直接邮件披露。

## 文档导航

- [docs/VISION.md](VISION.md) — 定位、五锚点、非目标与成功判据。
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 组件图、进程模型、插件状态机、故障域。
- [docs/CORE.md](CORE.md) — 内核模块的职责、输入输出、失败模式与端点清单。
- [docs/PLUGIN-PROTOCOL.md](PLUGIN-PROTOCOL.md) — UDS + 4B 长度前缀 + JSON、方法表、错误码、生命周期。
- [docs/RESOURCE-MODEL.md](RESOURCE-MODEL.md) — 预算表、cgroup v2 落地、度量口径。
- [docs/README.md](README.md) — 文档总览，按「我想做什么」组织。

## 更多文档

完整说明见 [README.md](../README.md)。
安全披露流程见 [SECURITY.md](../SECURITY.md)，安全设计见 [docs/SECURITY.md](SECURITY.md)。
版本变更记录见 [CHANGELOG.md](../CHANGELOG.md)。
贡献方式见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 常见问题

**问：需要注册账号才能用吗？**
不需要。没有账号、没有联网校验、没有隐藏上报；配置是明文的，看得懂也改得动。

**问：插件装在哪个仓库？**
插件住在各自的 `kore-plugin-<id>` 仓，本仓库只放内核与公开 SDK。

**问：我该先读哪份文档？**
先看 `QUICKSTART.md`（构建到登录），再按 `docs/README.md` 的「我想做什么」索引找专题文档。
