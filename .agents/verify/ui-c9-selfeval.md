# C9 监控阈值接后端配置 · 双端自证（G-28）

> 2026-11-26 · 执行者 `c9-threshold`（task-133）· 隔离实例 `127.0.0.1:18945`（独立 config/state/run/log/bin，非 8787）· monitor 插件 0.5.1 · headless Chromium 1255 · 收工已停实例并删临时脚本/缓存。

## 实现

- `web/monitor.js` 启动时调 `POST /api/v1/invoke/monitor/monitor.config.get`，把 `cpu_threshold / memory_threshold / disk_threshold` 写入模块内 `THRESHOLDS`（原硬编码 90 降为 `DEFAULT_THRESHOLDS` 兜底：插件未装 / config.get 失败时沿用，不白屏）。
- 阈值现在既是告警判定面板文案、图表参照线（`c.ref = THRESHOLDS[...]`），也是下发给 `monitor.system` 的 `thresholds` 参数，三处共用同一份后端真值；`onSaved` 回调重读 config.get 并 `loadAll()`，保存后立刻生效。
- 设置入口只加一个「⚙ 阈值设置」按钮，点开复用 `window.KoreShell.openConfig(S.box, 'monitor', {title:'监控阈值设置'})` → 通用 schema 面板（8 个字段、无需自建表单控件；遵循「加一个控件替换一个」：本页没有删除或新增其它常驻控件，表单由已有通用面板承载，不新增重复实现）。
- 60 点环形历史保持兼容：`monitor.system` 不再硬塞 `history_points`，由后端配置（默认 60、`history.json` 持久化）决定环容量；图注从 `history.capacity` 读「后端保留 N 点（重启接续）」，不再宣称「单序列上限 1000」。

## 双端截图（真实浏览器，非设计稿）

| 文件 | `identify -format '%f %wx%h %b'` | 场景 |
| --- | --- | --- |
| `screenshots/ui-c9-threshold-desktop-viewport.png` | 1440x900 98463B | PC 精确视口：刷新 / 阈值设置两个按钮同排，阈值告警 90/90/90，CPU 曲线参照线 90% |
| `screenshots/ui-c9-threshold-mobile-viewport.png` | 390x844 55865B | 手机精确视口：卡片单列、阈值设置按钮可见、无横向溢出 |
| `screenshots/ui-c9-threshold-desktop.png` | 1440x2620 245718B | PC full-page（含曲线/磁盘/网络/进程） |
| `screenshots/ui-c9-threshold-mobile.png` | 390x3639 223573B | 手机 full-page（同上） |

PC / 手机同一次脚本从隔离实例真实登录、真实切换 `#/monitor` 后截取；`file` 复核均为 `PNG image data, 8-bit/color RGB, non-interlaced`。

## 实测断言（命令 + 退出码）

| 命令 | 退出码 | 关键断言 |
| --- | --- | --- |
| `node --check web/monitor.js` | 0 | 语法通过 |
| `make frontend` | 0 | 首屏 gzip 90,924 B ≤ 307,200 B（300 KiB） |
| `bash scripts/usability-check.sh --no-run-tests` | 0 | 0 FAIL（与基线一致，502 WARN 存量） |
| `node .agents/verify/iso-c9/verify.js` | 0 | 双端：config.get 初始 90/90/90；config.set 63/55/47 → 刷新页面后告警面板显示 `63% / 55% / 47%`；图注无残留 90%；两次循环均 PASS |
| `node .agents/verify/iso-c9/panel.js` | 0 | 点齿轮打开 monitor 通用配置面板（8 字段）；面板把 CPU 阈值改成 41 并保存 → 页面立即显示 41%；未捕获异常 0 |

`verify.js` 关键输出：`ASSERT PASS: config.set 200 saved+applied` / `ASSERT PASS: 刷新后阈值告警面板显示新值 63%/55%/47%`（PC + 手机各一遍）；`panel.js`：`PASS: 面板保存后页面阈值同步显示 41%`。

## 自评三问

**问 1：本页解决什么用户问题？**
监控页此前把阈值写死成 90%，后端插件已有 config.set 可持久化阈值却读不到——用户改了配置页面仍按 90 画参照线、报告警。现在进监控页即读后端已保存的阈值，图表参照线与告警提示一并跟着变；设置入口复用统一面板，用户不必进软件商店找配置项，也不必刷新后猜测是否生效（保存即重读重绘）。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 把阈值与通知通道绑在设置向导里，支持按指标分别设告警级别与推送渠道、并常驻轮询；Kore 沿用 G-19 禁轮询，阈值只在手动刷新 / 设置保存时生效，不提供站内告警推送（通知归告警中心），也不支持按时间窗差异化阈值。优势是零新增表单实现、零常驻进程、零框架：设置只复用已有 schema 面板，后端 0600 原子落盘，阈值与后端告警判定天然同源，不会出现前后端两份真值漂移。

**问 3：当前「可用」还是「占位」？**
**可用。** 判据：双端截图来自隔离实例真实浏览器与真实登录；API 路径（config.set → 刷新 → DOM 新值）与 UI 路径（点齿轮 → 面板保存 → DOM 新值）各自实测 PASS；图表参照线取的是同一份 THRESHOLDS；未捕获异常 0；`make frontend` / `node --check` / `usability-check` 全绿。

## G-29 / 清理

本轮未改动主实例 `8787` 的 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`；全部安装在 18945 独立实例。收尾：停 18945 进程、删除 `.agents/verify/iso-c9/`（含临时 config/state/run/log/bin/gocache/gomodcache 与 3 个一次性脚本）；仅保留上面 4 张交付截图与本文件。
