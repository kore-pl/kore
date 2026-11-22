# 主壳前端信息架构整改（ui-rework）

> 状态: 已完成（本地提交，未 push）｜里程碑: M0–M5 ｜日期: 2026-11-22

## 结论

开发进度 / 接口契约 / 文档章节不再直出产品界面。五页经桌面 1440×900 与手机 390×844 实测：
界面文本零 `/api/v1` 路径、零 `docs/*.md §` 引用、零 E_* 错误码；同一页技术说明最多一处。
验证在隔离副本（`/tmp` 工作区副本 + `make build` + 127.0.0.1:18898）完成，未触碰 lead 的 8787 实例。

## P0 逐条对账

| # | 整改项 | 落地方式 | 证据 |
| --- | --- | --- | --- |
| 1 | 移除 API 路径展示 | `panel(title, meta, rows)` 收窄为 `panel(title, rows)`；系统信息、插件概览、插件表、监控插件表、设置账户/安全中的端点行全部移除 | `rework-desktop-*.png`；全页文本扫描零命中 |
| 2 | 技术待办收口 | 统一 `.tag.tag-muted`（灰底小标签）：`待支持` 用于修改口令 / 批量安装 / 卸载；详情只进 `title`。监控整页只保留底部一个 `<details>技术说明</details>`，四张卡不再各自重复契约 | `rework-desktop-monitor.png`、`rework-desktop-monitor-technote.png` |
| 3 | 移除文档引用 | 设置页改为用户语言：认证主体、CSRF 校验、Cookie 只读、会话自动续期；`docs/CORE.md §2.3` / `DATA-MODEL.md §3` / `SECURITY §4` 全删 | `rework-desktop-settings.png` |
| 4 | 商店包路径输入框 | 页面顶部输入框删除；安装默认走索引下载，后端要求本地包时在该卡片内展开路径收集，另有「离线安装」小入口 | `rework-desktop-store.png`、`rework-desktop-store-inline.png` |
| 5 | 空状态引导 | 概览零插件：“还没有安装插件 + 去软件商店”；已装插件页：“暂无已安装插件，去软件商店安装”；监控无采样：“等待采样…”，并自动适配 `cpu_pct/rss_kib/disk_used_kib/disk_total_kib/load1/goroutines/fds` | `rework-desktop-overview.png`、`rework-desktop-plugins.png`、`rework-desktop-monitor.png`（真实指标）、`...-monitor-idle.png`（模拟 404） |
| 6 | 顶栏去重 | 壳内顶栏只留右侧健康/系统信息/退出；品牌仅在侧栏出现一次。无壳降级页仍保留品牌 | 所有 `rework-*` 截图 |
| 7 | 图标改内联 SVG | `shell.js` 内置 5 组 path（20×20、currentColor、stroke-width 1.5、fill none），`createElementNS` 生成，无 emoji/无外链/无图标库 | 桌面与手机截图导航图标 |
| 8 | 商店卡片降噪 | 信息收敛为图标 + 名称 + 版本 + 深度徽章 + 一句话场景；删除 lifecycle/体积重复行；安装按钮改为底部右对齐中等按钮，新增「离线安装」ghost 按钮 | `rework-desktop-store.png`、`rework-mobile-store.png` |

## 追加整改（独立审查 A / B）

| # | 整改项 | 落地方式 | 证据 |
| --- | --- | --- | --- |
| A | 移动端“设置”被藏住 | 640px 以下改为**底部 tab bar**：5 项均分、图标+文字、57px 高、激活项顶部色条；内容区预留 56px + 安全区，滚到底最后一个动作不被遮挡 | `rework-mobile-*.png`、`rework-mobile-overview-bottom.png`；实测 nav rect 390×57，dom scrollHeight 889 > 844 |
| B | 商店安装模型 | 安装默认 `{"id","version","download":true}`；进度按请求耗时显示 下载中→校验中→安装中；失败显示服务端原因（含校验失败 detail）；后端返回 `package_path` 必填时优雅降级为卡片内离线输入 | `rework-desktop-store-installing.png`（下载中）、`rework-desktop-store-inline.png`（降级） |

## P1 逐条对账

| # | 整改项 | 落地方式 |
| --- | --- | --- |
| 9 | 监控空卡片高度 | `.monitor-card.is-idle` 收紧 padding/gap、不画空折线；实测 92px（有数据卡约 185px，减半） |
| 10 | 运行参数全“—” | 删除五行空表，改成一句“当前版本未暴露运行参数”；保留有用的预算表 |
| 11 | 错误态中文口语 | `describeError` / `errText` 只返回 `message`（无 message 时“操作未完成”），不再拼 `E_*`/`HTTP`；设置/监控错误文案同步口语化 |

## 门禁与验证

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/{app,shell,store,monitor,settings}.js` | 0 ×5 | 5 个 JS 全部 OK |
| `make frontend` | 0 | 首屏 26,557 B gzip（预算 307,200 B，余量 280,643 B；index 645 + style 8,576 + app 13,919 + shell 3,417） |
| `make docs-check` | 0 | 6 pass / 0 warn / 0 fail |
| `make check` | 0 | 10/10 全通过（含 frontend 阻断段） |
| `bash scripts/thin-shell-check.sh` | 0 | 4 pass / 0 fail（扫描 92 个 .go） |

首屏对比：HEAD 四件套 24,929 B → 整改后 26,557 B（+1,628 B，+6.5%），仍远低于 300 KiB。
隔离实例验证后已 kill 18898 并删除 `/tmp/kore-ui/instance`；无 worktree、无遗留临时脚本入库。

## 截图清单（`.agents/verify/screenshots/`）

- 整改后桌面五页：`rework-desktop-overview.png` / `-store` / `-plugins` / `-monitor` / `-settings`
- 整改后手机五页：`rework-mobile-overview.png` / `-store` / `-plugins` / `-monitor` / `-settings`
- 状态专项：`rework-desktop-store-installing.png`、`rework-desktop-store-inline.png`、`rework-desktop-monitor-idle.png`、`rework-desktop-monitor-technote.png`、`rework-mobile-overview-bottom.png`
- 整改前桌面五页：`rework-before-desktop-{overview,store,plugins,monitor,settings}.png`

## 前后对比要点

1. 概览：`/api/v1/system/info`、`GET /api/v1/plugins` 与两行顶栏品牌消失；零插件从四行 0 表变成“去软件商店”入口。
2. 商店：顶部常驻包路径输入消失；卡片从“按需 · 1.2 MB + 全宽按钮”变成一句话场景 + 右对齐中等按钮；下载进度与离线降级有明确状态。
3. 监控：四张卡重复的契约文本消失，改为一次折叠技术说明；无数据卡高度减半，有数据自动显示真实 CPU/内存/磁盘/负载/goroutine/fd。
4. 设置：文档章节与端点行消失，空参数表收敛为一句说明；技术待办只剩灰标签 + hover 详情。
5. 手机：从“设置被裁到屏外且无提示”变为五项固定底部 tab bar，五页均可直达。

## 未完成 / 遗留

- 安装进度阶段是前端按耗时估算（后端当前无分阶段事件）；后端若提供 job 阶段字段，可直接改为事件驱动。
- 商店卡片内容图标仍为 emoji（本次仅要求导航图标改 SVG）；如后续统一图标体系可再替换为内联 SVG。
- 本次不改 Go 代码；`download:true` 的真实下载链路由后端 agent 落地，前端已按该契约适配并保留 `package_path` 降级。
- 提交哈希：`__COMMIT_HASH__`（本地提交，未 push）。
