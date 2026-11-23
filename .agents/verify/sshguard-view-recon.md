# ssh-guard 视图侦察成果（task-114 只读阶段遗留，供接手者直接开写）

> 日期: 2026-11-23 · 执行: kore-impl-release-r5 · 状态: **只读侦察完成、零代码交付**（`web/sshguard.js` 未创建、`shell.js` 零注册）
> 用途：下一个接手 agent 可跳过侦察直接按 §4 落点开写；所有结构均为实测读取，非转述。

## 1. 后端方法面（`kore-plugin-ssh-guard/methods.go` 实测）

调用形态：`POST /api/v1/invoke/ssh-guard/ssh-guard.<verb>`（域前缀必须带，FRONTEND §46 硬约束）。

| 方法 | 响应结构（实测字段） | 关键事实 |
| --- | --- | --- |
| `status` | `statusAuditResult{status, uptime_s, goroutines, checks[], total, issues, applied, protection{available, engine, version, fail2ban_installed, fail2ban_active, banned_count, failed_24h, log_source, hint}, config_source, note}` | `config_source=none` 时 note 给长说明（非 root 读不了 sshd_config）；**状态卡数据源** |
| `attempts` | `{source, since, until, total, failed, invalid_users, successful_logins, unique_ips, events_without_time, top_ips[]{ip,failed,success,total}, timeline_hourly[]{hour,failed,success}, raw_lines, truncated, note}` | 默认 24h 窗口（`attemptsDefaultTTL`）；**暴力破解统计 + Top N + 判读的数据源**；truncated/note 要如实展示 |
| `bans` | `{available, engine, source, threshold, bans[]{address,reason}, count, applied, note}` | fail2ban active 时读真实 jail；否则从日志推断可疑 IP（threshold=`SuspiciousThreshold`）；**封禁名单的唯一真实数据源** |
| `ban.list` | `{bans:[], count:0, limit, offset, applied:false}` | **恒空桩**——`handleBanList` 硬编码返回空数组，永远没有数据。**不要接它**，名单一律走 `bans` |
| `ban.add` | `{ip, action, applied, exit_code, stdout, stderr, banned, banned_count, ...}` | 参数只有 `{ip, confirm}`——**无时长/TTL 参数**（fail2ban 语义=直到手动解封，**不要做 1小时/1天 假预设**）；`confirm` 是一次性令牌，缺失返回 `confirmRequiredError`（不可回滚动作） |
| `ban.remove` | 同上（action=unbanip） | 恢复性动作，**不需要 confirm 令牌**，直接 `{ip}` 即可 |

**confirm 令牌获取（ban.add 前置）**：内核端点 `GET /api/v1/plugins/ssh-guard/root-action/fail2ban-banip/confirm-token`（`handlers.go:63`，`handleConfirmToken`），管理员会话 + CSRF 头，响应含 `token`，随 `ban.add` 的 `confirm` 字段传入，插件只转发不签发。root_action ids：`fail2ban-status`（只读）/ `fail2ban-banip`（需令牌）/ `fail2ban-unbanip`（不需要）。

**降级三态判据**：
- 插件未装 → `E_NOTFOUND` → 单张「去软件商店安装」空态（dns.js:152 模式）
- 非 root / 无提权通道 → `E_NEED_ROOT`（`needRootCode`）或 `status.protection.hint` → **只读模式横幅 + 写按钮直接隐藏/禁用并说明需要什么**（kored 以 root 启动或配 systemd 提权，RUNBOOK §5），绝不做「点了才报错」
- fail2ban 未装/未激活 → `protection.fail2ban_installed=false` / `engine:"none"` → 名单降级为日志推断（`bans.source != "fail2ban"` 时展示 note），手动封禁区隐藏

## 2. 参照模式（`web/dns.js` 492 行 / `web/waf.js` 695 行实测）

- **文件头注释**：写明调用形态（域前缀方法名）+ 读写方法清单 + 降级情形（dns.js:1-8 模板）
- **IIFE + 严格模式**：`(function(){ 'use strict'; ... window.KoreSshGuard = { render: render }; })();`
- **invoke()**：读 `kore_csrf` cookie → `X-Kore-CSRF` 头 + `credentials:'same-origin'` + 12s AbortController 超时；`err.code`/`err.hint` 从响应体带出（dns.js:40-60）
- **panel()**：`{panel, head, meta}` 三件套——`section.panel > div.panel-head > span.panel-title + span.panel-meta`（dns.js 实现 6 行）
- **表格**：`table.xxx-table` + `thead/tbody`，每格 `td.setAttribute('data-label', '列名')`（dns.js:238-241）
- **样式**：文件内注入 `<style id="kore-xxx-css">`（dns.js:430-431），**不改 style.css**
- **不轮询**：进页各查一次 + 用户触发刷新（G-19）
- **waf.js 的只读降级**：`E_NEED_ROOT` → `setLocked(true)` + 黄底说明 + 写操作整体禁用（waf.js:201-240 有现成文案结构）

## 3. 手机适配（style.css 实测）

- 断点 `@media (max-width: 639px)`：`.plugin-table` 系列**逐行转块**，`td::before { content: attr(data-label) }` 复原列名（style.css:462-490）——新表格用 `plugin-table` 类即可免费获得转卡片，无需新写 CSS
- 触摸目标：`button, .btn { min-height: var(--kore-touch) }` 已全局覆盖（≥44px）；行内操作按钮放 `.cell-ops` 会自动 `flex: 1 1 auto`

## 4. 视图注册 6 处落点（照 dns/waf 现有位置）

| # | 文件 | 位置（实测） | 改什么 |
| --- | --- | --- | --- |
| 1 | `web/shell.js` | ICONS 表 ~L46-56（waf/dns 条目旁） | 加 `sshguard: [...]` 20×20 stroke 图标路径（与盾牌系列区分） |
| 2 | `web/shell.js` | `NAV_GROUPS` L65 `platform` 组 `ids` 数组 | 加 `'sshguard'`（与 firewall/waf/dns 同组） |
| 3 | `web/shell.js` | `mount()` L577-596：`hasXxx` 检测 + `items.push` | 加 `hasSshguard` 检测 + `lazyView('KoreSshguard', '/assets/sshguard.js', 'nav.sshguard', 'SSH 加固')` |
| 4 | `web/embed.go` | `//go:embed dist/...` 清单末尾 + 注释清单 | 加 `dist/sshguard.js`（注释里文件数同步 +1） |
| 5 | `Makefile` | `WEB_SRC_FILES`（L76）+ L72 注释 | 加 `sshguard.js` |
| 6a | `web/i18n/zh-CN.js` | L22-26 nav 键区 | `'nav.sshguard': 'SSH 加固',` |
| 6b | `web/i18n/en-US.js` | 同位置 | `'nav.sshguard': 'SSH Guard',` |

（FRONTEND.md 视图清单同步为第 7 处，G-06：§260「十九个按需视图模块」列表 + §261 视图清单 + §272「第 9–21 个导航项」编号 → 22 项、§266 文件流图。）

## 5. UI 分区建议（任务卡五区 → 数据源映射）

1. **状态卡** ← `status`：引擎/fail2ban 装载与激活/当前封禁数/24h 失败数/日志源/扫描窗口（attempts 的 since-until）
2. **暴力破解统计** ← `attempts`：总数/失败/唯一 IP 汇总卡 + `top_ips` Top N 表 + `timeline_hourly` 简易条形（自研 div，勿引图表库——ADR-0027 为 proposed 驳回态）+ **判读提示**（如 unique_ips≥阈值或 failed 集中单 IP → 「看起来在被扫」人话文案）
3. **封禁名单** ← `bans`（**不用 ban.list**）：IP/来源(reason)/数量表 + 行内解封（`ban.remove`，页面内二次确认，无需令牌）
4. **手动封禁** ← `ban.add`：IP 输入 + 说明「封禁持续到手动解封」（**无时长参数，不做假预设**）→ 先取 confirm 令牌 → 提交；非 root/fail2ban 未装时整区隐藏换只读横幅
5. **空态** ← `E_NOTFOUND` → 商店卡

## 6. 已知坑（写之前必读）

- `ban.list` 是桩，接了永远空表（§1 实测）
- `ban.add` 无 duration 字段，1小时/1天预设是假的（§1 实测）
- confirm 令牌端点是 `GET`（非 POST），路径带 `root-action/fail2ban-banip/confirm-token`
- 首屏六件套不含视图模块（frontend-check 的 FILES 只列 6 个），sshguard.js 按需注入即可
- 图表：ADR-0027 ECharts 已被 lead 驳回（proposed 态），统计条形用自研 SVG/div
