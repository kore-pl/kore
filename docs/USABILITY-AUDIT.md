> 状态: active · 归属: implementer · 更新: 2026-11-23 · 里程碑: M0

# USABILITY-AUDIT — 本轮 6 个新界面的可用性审计

**结论：共 16 条 —— P0 2 条 / P1 8 条 / P2 6 条。** 最严重的是「计划任务」页把两套调度（crontab / 内核 scheduler）与内部组件名直接摊给用户，且 root 权限失败只给结论、不给可点的修法；其余多为内部术语与手机触摸目标 <44px。DNS 视图、文件回收站、终端重连是本轮做得最好的三处（空态带下一步、错误给了白话映射、危险操作有勾选式二次确认）。

> 只读审计：本轮**未改任何代码、未改 [USABILITY.md](./USABILITY.md)**；修复另行派发。证据均为 `web/*.js` / `web/style.css` 的 `file:line + 原文`。

## 1. 审计范围与方法

| 视图 | 入口模块 | 本轮状态 |
| --- | --- | --- |
| DNS 解析 | `web/dns.js` | 新增 |
| SSH 防护 | **无独立模块**，合并在 `web/firewall.js`（`updateSSH` / `sshWarn`） | 新增能力，无独立视图 |
| 设置页·凭据 tab | `web/credentials.js` | 新增 |
| 监控（历史曲线 + 告警 + 进程 TOP） | `web/monitor.js` / `monitor-cards.js` / `charts.js` | 大改 |
| 终端（断线重连 + 历史） | `web/terminal.js` | 大改 |
| 计划任务（cron 启停） | `web/tasks.js` | 大改 |
| 文件（批量 + 回收站） | `web/files.js` / `files-l2.js` | 大改 |

判据取 [USABILITY.md](./USABILITY.md) §1–§4：预设优先 / 自动发现 / 点击 ≤3 / 空态给下一步 / 错误给「怎么办」/ 禁用内部术语（实例、生命周期、capability、revision、槽位）。扫描命令：

```bash
grep -rnE 'E_[A-Z_]{3,}' web/*.js
grep -rn '暂无数据\|暂无记录\|没有数据' web/*.js
grep -rnE "(实例|生命周期|capability|revision|槽位|namespace)" web/*.js
grep -rnE 'confirm\(|askConfirm|purgeConfirm' web/*.js
grep -nE 'min-height: *(2[0-9]|3[0-9]|4[0-3])px|height: *(2[0-9]|3[0-9]|4[0-3])px' web/style.css
```

## 2. 分视图结果

| 视图 | 空态有下一步 | 错误给怎么办 | 内部术语 | 危险操作确认 | 点击 ≤3 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| DNS | ✅ `dns.js:94` `emptyBlock(text, actionLabel, action)`，`:323` 带「打开 DNS 设置」 | ✅ `dns.js:75` E_NEED_ROOT →「按状态卡片说明重启后重试」 | ⚠️ `dns.js:124` 出现 `ADR-0018` | n/a（只读） | ✅ 查记录 1 步 | 通过（1 处 P2） |
| SSH 防护（防火墙内） | ⚠️ 无独立空态；`firewall.js:138` 有启用前提醒 | ✅ `firewall.js:132` 给出启用命令与风险 | ✅ | ✅ 停用有确认文案 | ✅ | 基本通过（视图归属 P2） |
| 凭据 tab | ⚠️ `credentials.js:230` 只写「先在上方新建一条」，无按钮 | ✅ `credentials.js:31` E_NEED_GRANT →「先在下方授权」 | ✅ | ✅ `credentials.js:169` 自带 confirmDialog；撤销/删除均走它 | ✅ | 1 处 P2 |
| 监控 / 告警 / TOP | ✅ `monitor.js` 有回退说明 | ⚠️ `alerts.js:23` 告警标题直接出现 `capability.denied` | ❌ `alerts.js:191`「常驻槽位已满」 | n/a | ✅ | P1 ×2 |
| 终端 | ✅ `terminal.js` 重连/恢复路径 | ⚠️ `terminal.js:344` 兜底 `err.message` 可能带码 | ✅ | ✅ 大段粘贴有确认 `:668` | ✅ | P1 ×1 |
| 计划任务 | ⚠️ `tasks.js:445` 空态只有说明文字 | ❌ `tasks.js:148`「（kored 需以 root 运行）」；`:424` 只在状态里提 RUNBOOK | ❌ `tasks.js:642`「crontab / 内核调度器」；`:156` 插件任务解释 | ✅ `tasks.js:324/343` confirmBox | ❌ 新增需先懂 cron 表达式 + 选对类型 | **P0 ×2** |
| 文件批量/回收站 | ✅ `files.js:829` purgeTrash 走 purgeConfirm | ✅ 勾选「不可恢复」才可提交 `files.js:795` | ✅ | ✅ `files.js:796` purgeConfirm | ✅ | 通过 |

### 2.1 计数口径

- **P0**：不修就无法完成该页的核心任务（或错误态无法自救），且没有绕路。
- **P1**：能完成，但需要用户理解内部概念/术语，或手机端命中区不达标。
- **P2**：文案与入口打磨，不阻碍完成。
- 同一条问题若跨文件重复出现，在清单里合并为一条，并在正文列出全部 `file:line`（便于一次性修完）。

## 3. 问题清单（按严重度）

### P0（2 条，阻断日常操作）

**P0-1 计划任务页把「两套调度 + 内部组件名」直接摊给小白，核心任务（每天定时备份）无法一次完成**
- `web/tasks.js:642`：`'管理当前用户的 crontab（shell / http）；插件任务交给内核调度器执行。每次写入前插件都会备份原内容。'`
- `web/tasks.js:156`：`'插件任务由内核调度器执行：cron 插件只生成任务描述，随后直接创建 /api/v1/scheduler/tasks，不写 crontab。'`
- `web/tasks.js:448`：空态 `'还没有计划任务，用上方表单新增一条'`——没有「每天备份一次」这类预设入口，新增必须自己写 cron 表达式。
- 违反：原则 1（无预设）、原则 3（先懂两套调度再选类型）、原则 4（crontab / 内核调度器 / API 路径）。
- 建议：加三个预设卡（每天备份 / 每周清理 / 每小时健康检查），表达式与类型自动填；高级模式才暴露 cron 语法；把「插件任务」改叫「由系统执行的任务」。

**P0-2 权限失败只给结论，不给可点的修法；`kored` 直接出现在用户文案里**
- `web/tasks.js:148`：`'当前无法读取系统计划任务：' + S.lockReason + '。需要 root 权限（kored 需以 root 运行）。 '`
- `web/tasks.js:424`：`(perm ? '（按 RUNBOOK §5 以 root 启动 kored 后重试）' : '')`
- 违反：原则 4（错误提示给「怎么办」；不得裸露内部术语）。
- 建议：统一错误组件给「复制命令」按钮（`sudo systemctl restart kore`）+ 一句白话原因；隐藏 `kored`/RUNBOOK 字面量到 `title` 或折叠区。

### P1（8 条，明显困惑）

1. `web/app.js:536`：`tr.appendChild(cell('生命周期', plugin.lifecycle))`；`:807` 表头 `'生命周期'` —— 内部术语，应为「运行方式」。
2. `web/db.js:615`：`var instWrap = add(formHost, el('label', null, '实例'))`；`:319` `'PostgreSQL 实例未配置或不可达'`；`:752` `'实例详情'` —— 应为「数据库连接」。
3. `web/alerts.js:23`（同 `app.js:1411`）：`'capability.denied': '能力校验被拒绝'` —— alert 联查键直接进 UI，用户看到 `capability.denied`。
4. `web/alerts.js:191`（同 `app.js:1543`）：`'常驻槽位已满（' + resident + ' / ' + MAX_SLOTS + '）'` —— 「槽位」未定义术语。
5. `web/tasks.js:642`、`:156`：`crontab` / `内核调度器` / `/api/v1/scheduler/tasks` —— P0-1 的术语面，独立计一条便于修复跟踪。
6. `web/dns.js:124`：`'kored 以普通用户身份启动时读不到，kore 的设计是让内核代理 root 动作（ADR-0018）。'` —— ADR 编号与「内核代理」属于实现细节，用户只需要「怎么让它读到」。
7. `web/terminal.js:344`：`'创建会话失败：' + err.message` —— E_* 未覆盖分支会把后端原文（含错误码/英文）透出；`E_RATELIMIT` 分支已做对（`:344` 前半），兜底分支应对齐。
8. `web/style.css:1701` `.term-ops .btn { min-height: 32px; ... }` 与 `:1889` `.proc-sort { min-height: 24px; }`、`:2173` `.redis-ks-chip { min-height: 20px; }` —— 手机触摸目标 <44px（全局 `--kore-touch: 44px` 已定义，见 `:52`，但这些局部规则把它覆盖了）。

### P2（6 条，打磨）

1. `web/credentials.js:230`：`'还没有凭据。先在上方新建一条，再授权给需要它的插件。'` —— 空态无按钮，只能靠用户自己回到表单。
2. `web/audit.js:151`：`'暂无审计记录'` + `:152` 说明，无「去操作一次」按钮；不在 6 个新界面内，顺手记录。
3. `web/tasks.js:529`：`'正在读取系统 cron 日志…'` 之后若为空，`:544` 只有 `panel-empty`，无「重试」按钮。
4. SSH 防护没有独立视图/导航项，只在防火墙页内；用户按「SSH 防护」找不到入口（建议并入防火墙页标题或加锚点）。
5. `web/firewall.js:217`：`'预览模式，确认后执行删除；SSH 放行规则会被后端拒绝。'` —— 「后端」是内部词，改「系统会拒绝」。
6. `web/dns.js:271`：`'读不到区域文件（需要 root 权限）。按上方状态卡里的说明以 root 重启 kored 后刷新本页。'` —— 同 P1-6 的术语面，重复出现在空态。

## 4. 建议修复顺序（先修这 5 条）

1. **P0-1 计划任务预设卡**（每天备份 / 每周清理 / 每小时健康检查）——最高频场景，一次点击替代手写 cron。
2. **P0-2 统一「需要 root」错误组件**（白话原因 + 复制命令 + 折叠 RUNBOOK）——同一模式会复用到 DNS、防火墙、日志，先做一次。
3. **P1-3/P1-4 告警术语**（`capability.denied` →「权限不足被拒绝」；「槽位」→「常驻名额」并给一句解释）——告警是用户第一眼看到的页面。
4. **P1-1/P1-2 两张表与表单的旧术语**（生命周期→运行方式、实例→数据库连接）——纯文案替换，风险最低、收益面最大。
5. **P1-8 手机触摸目标**（`.term-ops .btn`、`.proc-sort`、`.redis-ks-chip` 统一 `min-height: var(--kore-touch)`）——一条 CSS 规则覆盖多处，验收有硬判据（≥44px）。

## 5. 本轮做对的地方（避免修复时回退）

- `web/dns.js:75-79`：`failureText` 对 `E_NEED_ROOT` / `E_NOTFOUND` / `E_NO_ENGINE` / `E_INVALID` 全部翻译成白话并给下一步；`E_NO_ENGINE` 还带「装上 BIND9 或 dnsmasq」。
- `web/terminal.js:344`：`E_RATELIMIT` →「会话数已达上限（最多 N 个）：先在上方恢复或关闭一个已有会话」，是「错误码→出路」的正面样板。
- `web/files.js:795-832`：彻底删除必须勾选「不可恢复」才能提交（`purgeConfirm`），且清空回收站与单条删除共用同一入口。
- `web/app.js:196-199`：已有统一空态组件 `emptyState(text, actionLabel, action)`，新页面应优先复用而不是各写各的。

## 6. 边界

- 本审计基于源码文案与样式，未跑真实浏览器/手机截图；触摸目标按 CSS 静态判定，实际命中区可能被 padding 放大。
- 「SSH 防护」「cron」在任务卡里写作独立视图，实际分别落在 `firewall.js` 与 `tasks.js`；若产品上要求独立入口，属信息架构问题，另派。
- 未覆盖 6 个界面之外的旧页面（数据库 Redis 等仅记录已发现的术语），全量清理见 [USABILITY.md](./USABILITY.md) §5 欠账表。
