# 监控页自研 Canvas 图表验收（task-5）

> 2026-11-23 21:07 · HEAD 7ca8a72 · verifier 独立复跑（未复用 monitor-canvas 结论）· 写域 `.agents/verify/**`

**结论：PASS-with-gaps**——G-28 双端截图（真实 chromium + 真实 monitor 插件数据）完成；文档 HEAD 严格 5 条全过；短窗口 1 轮无单调增长、切走归零。Gap：监控页固有 3 图实例（非 12）；手机 full-page 中固定底栏出现在视口位置（截图机制，非 UI 缺陷）。

## 一、G-28 双端（真实浏览器渲染）

方法：干净 `git archive 6fbccad` 构建 kored，隔离实例 `127.0.0.1:18802`（state 为 `.kore-local-state` 的只读副本，运行于 /tmp，未改主实例）；自建 PBKDF2 登录口令（仅 /tmp 0600）；chromium-1248 headless + 手写 CDP。数据源为从主 state 复制的 monitor 0.3.0 插件真实 `history`（3 点/60s），未造假。

- 桌面：`screenshots/monitor-canvas-desktop-chart.png`，**file/identify = 1440×2763**（视口 1440×900，full-page）
- 手机：`screenshots/monitor-canvas-mobile-chart.png`，**390×3171**（视口 390×844，full-page）；另 `monitor-canvas-mobile-viewport.png` **390×844**
- 同一状态：同一页面会话先桌面后切视口；3 canvas（CPU/内存/负载），history 3 点。console 仅 1×401（登录前）+1×404（favicon，已核）。

## 二、判据 grep（`web/monitor.js`）

`polyline`=0；`lttbSample`=2；`devicePixelRatio`=2；`RESIZE_DEBOUNCE_MS`=100；`dispose`=8；`__koreMonitorChart`=3；`MAX_POINTS`=1000 + 尾部截断；`import .*charts` / `charts-echarts`=0。

## 三、文档 HEAD 严格口径（HEAD 7ca8a72）

docs-check exit **0**（5 pass/1 warn/0 fail）；`越权决策回滚`=**0**；`已就绪` FRONTEND=**0**、ADR=**0**；`自研 Canvas`=**3**；`G-32`=**1**。

## 四、短窗口性能（1 轮 60s，5 点视图，按 lead 收口口径）

heap：1.377→1.227→1.383→1.192→1.267 MB（**非单调**）；count 全程 **3**；切走 count **3→0**、canvas **0**；峰值 2.249 MB→切走 1.333 MB（**-40.7%**）。12 实例满载未测（本页固有 3 图实例，卡允许降级并注明）。

## 五、门禁

`timeout 180 make frontend`=**0**（首屏 60,866 B / 300 KiB）；`bash scripts/frontend-check.sh`=**0**；`timeout 300 make build`=**0**，`bin/kored`=**10,080,418 B**（≤26,214,400）。均在干净 archive 6fbccad 执行，避开工作区他轨在途改动。

## 六、未测 / 取消 / 自评

- 未测：12 实例满载、3 轮、longtask、build/archive 复跑（lead 收口取消）；主实例 8787 截图（无授权口令；改用隔离实例 + 真实插件数据）。
- 并发：运行期观察到 `M web/app.js`、`M web/style.css`、`M web/sshguard.js` 等他轨在途项，未 checkout/stash/提交；收口时 HEAD 7ca8a72 工作区干净。
- 自评三问：解决「一屏看主机健康 + 历史曲线」；vs 宝塔/1Panel 缺时间窗选择、告警配置/通知、长期存储与导出；当前**可用（基础版）**，非占位。
