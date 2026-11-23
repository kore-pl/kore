# monitor 曲线 + terminal 历史 双端截图（G-28 批次 C）

> 元信息: 2026-11-23T20:34+08:00 · 执行者 kore-impl-monitor 子 agent · 隔离实例 `127.0.0.1:18889`（portable，config/state/run/log 全在 `/tmp/kore-mt-18889`）· 真 chromium 156 headless（CDP 真实点击/输入）· 报告 ≤60 行

## 1. 结论

两视图各 2 张、共 **4 张**双端截图，`file` 复核宽高符合 G-28；无 JS 异常（`window.__jsErrors = []`）。monitor 页 3 条迷你 SVG 曲线、3 条阈值虚线、告警条「全部正常」、进程 TOP10 与「按内存」排序切换均真实出现；terminal 页真实建会话、敲 3 条命令、输入历史面板（搜索 + 填入按钮）出现。**重连态未模拟**：本机无法在不破坏实例的前提下稳定制造断线，故只截常态（按任务约定如实说明）。

## 2. 隔离实例

- 端口 `127.0.0.1:18889`；`profile: portable`，`paths.*` 全落 `/tmp/kore-mt-18889`。
- `kored install --package` 装入 **monitor 0.3.0** + **terminal 0.2.0**，登录后经页面 fetch `POST /plugins/{id}/enable` 均 200。
- 登录走真实表单（隔离实例自建 PBKDF2 口令）；monitor 历史用 `monitor.system {history_interval_s:1}` 真实采样 3 次（200/200/200）后进入视图。

## 3. 监控页证据（DOM 断言）

| 断言 | 实际 |
| --- | --- |
| 迷你曲线 | `.mon-mini` = **3**（CPU/内存/负载），`svg.mon-chart` = 3 |
| 悬停 tooltip | 每曲线逐点 `<title>` 共 **27** 个；静态截图不含浏览器原生 tooltip，悬停值已用 DOM 断言（`<title>` 存在且内容=时间·值） |
| 阈值虚线 | `.mon-threshold` = **3**（每条曲线各一条 90% 虚线） |
| 告警条 | `.mon-alert`=0，绿色「全部正常」chip 存在（默认阈值 90/90/90，本机未超限） |
| 进程 TOP | `.mon-proc-body tbody tr` = **10** |
| 排序切换 | 点「按内存」后 aria：`按 CPU:false,按内存:true` |

## 4. 终端页证据

| 步骤 | 结果 |
| --- | --- |
| 新建会话 | 状态「已连接」，真实 PTY |
| 真实输入 | 通过 CDP 聚焦 `.term-input` 依次敲 `echo alpha` / `echo beta` / `uname -s`，屏幕出现 `alpha` 输出 |
| 历史面板 | 点「输入历史」后 `.term-hist-item` = 6，每条带「填入」按钮（共 6 个），搜索框存在 |
| 历史搜索 | 输入 `alpha` 后过滤为 1 条：`20:33:03 | echo alpha | 填入` |
| 重连态 | **未截图**：未稳定模拟出「正在重连…」；报告如实标注只覆盖常态 |

## 5. 截图证据（逐张 `file` 复核）

| 文件 | 实际宽高 | 字节 | sha256 前 16 |
| --- | --- | --- | --- |
| [monitor-terminal-monitor-desktop.png](screenshots/monitor-terminal-monitor-desktop.png) | **1440 x 2746**（full-page） | 228334 | `63ca53af56cec795` |
| [monitor-terminal-monitor-mobile.png](screenshots/monitor-terminal-monitor-mobile.png) | **390 x 844** | 51336 | `48632fd9b699c845` |
| [monitor-terminal-terminal-desktop.png](screenshots/monitor-terminal-terminal-desktop.png) | **1440 x 902**（full-page） | 84682 | `71fa932db96ded50` |
| [monitor-terminal-terminal-mobile.png](screenshots/monitor-terminal-terminal-mobile.png) | **390 x 844** | 54736 | `656d25bf6626592b` |

- 桌面宽 1440；手机 390×844；scrollWidth=innerWidth（1440/390），无横向溢出；4 张 sha256 互不相同。

## 6. 自评三问

**监控页**
1. 解决什么用户问题：首屏看到 CPU/内存/负载的短期趋势、阈值告警与最耗资源的进程，不用登机器跑 top。
2. 与宝塔/1Panel 差距：宝塔/1Panel 有分钟级长历史与进程下钻；本页历史默认仅 60 点（60s 间隔）且曲线不持久到独立时序库，进程表无单进程详情跳转。
3. 可用还是占位：**可用**——真实 monitor 插件数据 + 3 条曲线 + 阈值虚线 + 告警条 + TOP 排序。

**终端页**
1. 解决什么用户问题：浏览器内直接开会话执行命令，并能搜索/回填最近输入，减少重复输入。
2. 与宝塔/1Panel 差距：缺多标签/分屏、字号与主题、断线自动恢复的可视化验证；本页已有重连代码但本次未截到。
3. 可用还是占位：**可用（常态）**；重连态属于已实现但本轮未取证的部分，报告中明确标注，不冒充已验收。

## 7. 清理与边界

- 已停隔离 kored/chromium、删除 `/tmp/kore-mt-18889`；复核 18889/9240 无监听、无残留进程。
- **主实例 8787 零写入**：未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`；本轮未改任何源码。
- 只提交 `monitor-terminal-*` 截图与本报告，未触碰他人 `credentials-*` / `site-file-*` / `backup-redis-*` / `dns-*` / `firewall-logs-*`。
