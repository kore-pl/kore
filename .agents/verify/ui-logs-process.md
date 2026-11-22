# 日志 / 进程两页验收报告（真机 · 双端 · G-28）

> 元信息: 2026-11-22T23:36+08:00 · 执行者 ui-logs-process 子 agent · 隔离实例 18887 · 真实 chromium CDP · 报告 ≤90 行

## 1. 环境与隔离
- 实例 `127.0.0.1:18887`，state/run/log 全在 `/tmp/kore-lp-verify`；**8787 全程未触碰**（PID 2557675，前后 `ps` 存活，RSS 12.7 MiB）。
- 本机无 sudo：用 `unshare -Ur -p --fork --mount-proc` 起独立 user+pid namespace（无网络隔离），pid 1 为命名空间 init。据此 pid 1 可读且 kill 被插件护栏拒绝（宿主上 pt 读不到 `/proc/1/exe`，正常实例会把 pid 1 标 restricted 并禁用按钮，与验收冲突；此隔离方式保持代码口径不特判）。
- 插件：logs 0.2.0（`system:read`）+ process 0.1.0（`proc:read/write`），经本地包 + 临时索引 fixture（sha256 与包一致、`allow_unsigned=true`）安装并 enable，lazy。
- 日志来源：`KORE_LOGS_SOURCES` 登记 `app`（自造 20000 行 / 1823015 B）与 `journal`；进程侧另有 sleep 300 / python sleep 300 / kored / 两插件。

## 2. 实现要点
- `web/logs.js`（288 行）：来源卡（name/file/大小 KB·MB/modified_at/可读徽章/journal 标签）→ 统计条（大小/行数/修改时间，`lines=null` 显示“文件过大，未统计行数”）→ 工具栏（100/200/500/1000 行、关键字回车 tail、搜索走 logs.search、datetime-local→RFC3339 since）→ `<pre>` 全 `textContent`。截断显示“结果已截断（扫描上限 64 MiB）”；空态说明 `KORE_LOGS_SOURCES` 且不露宿主路径；错误保留 `E_*：message` 全文。
- `web/process.js`（319 行）：进程表（pid/名称/用户/状态/RSS/CPU%/命令，命令 `title` 全文）；列头排序 cpu/mem/pid/name 并暴露 `aria-sort`；前端过滤 name/cmdline；首次采样灰字“首次采样无历史基线，CPU 显示为 0”；点行开右侧详情抽屉（State/VmRSS/VmPeak/Threads/exe/cwd/started_at/elapsed_s）；kill 二次确认（pid+名称+命令行）+ TERM/KILL/HUP/INT；进程树缩进展示；restricted 显示灰“受限”并禁用 kill；加载失败显示重试；15s 超时提示。
- 接线：`shell.js` 第 11/12 项（内联 SVG，`lazyView` 懒加载）；`index.html` 未加 script；`embed.go` / `Makefile` / `FRONTEND.md`（10 视图 / 14 文件）/ `QUICKSTART.md` 同步；`style.css` 仅追加两页样式。

## 3. 日志真机证据
| 步骤 | 页面/接口证据 |
| --- | --- |
| 来源列表 | 2 个来源：app `app.log` 1.7 MB / 20,000 行、journal 带 `journal` 标签 + 可读徽章（`logs-desktop-01`） |
| tail 200 | 接口 `count=200`、首行 line=19801、末行 line=20000；页面底部“显示 200 行 · 扫描 64.0 KB” |
| 关键字 | 输入 `ERROR` 回车 → `count=200`，`<pre>` 每行含 ERROR（`logs-desktop-02`） |
| 搜索 | `disk pressure` → `count=20`，行号 997/1994/…/19940，页面“匹配 20 行”（`logs-desktop-03`） |
| 时间起点 | datetime-local `21:05` → 转 RFC3339 `…T13:05:00.000Z` → 51 行（含 21:05:00 行），`显示 51 行` |
| 统计条 | `size_bytes=1823015`、`lines=20000`、modified_at 本地化显示；`logs.stats` 无宿主路径（path=`app/app.log`） |

## 4. 进程真机证据与 kill 流程
- 列表实测 6 条真实 `/proc` 记录（process/logs/kored/python3/sleep/bash），默认 CPU 排序；点 PID 列头 → `aria-sort=ascending`、首行 PID 1；搜索 `kored` 过滤到 1 行（`process-desktop-01`）。
- 详情（sleep PID 2）：状态 S、VmRSS 7.8 MiB、VmPeak 17.2 MiB、线程 1、exe `/usr/bin/sleep`、cwd、启动时间、已运行 10 秒（`process-desktop-02`）；进程树显示 bash→sleep/python3/kored→logs/process 缩进层级（`process-desktop-03`）。
- kill 流程：结束进程 → 二次确认显示 `PID 2（sleep）` + 命令行 `sleep 300` + 信号下拉默认 TERM（`process-desktop-04`）→ 确认后绿色结果条 `signal=TERM · killed=true · still_alive=false · waited_ms=50`（`process-desktop-05`），列表 500ms 后刷新、sleep 行消失。
- 护栏拒绝：对 PID 1（unrestricted，按钮可用）确认结束 → 红色提示条全文 `结束失败：E_INVALID：拒绝操作 pid 1：pid≤1 受保护（init / 内核线程）`（`process-desktop-06`）。
- restricted 分支已实现（灰标签 + kill.disabled）；本隔离实例内所有进程均可读，未自然产生 restricted 行，故无双端截图。

## 5. 双端截图（每张截图前、后均断言：body 含「日志」或「进程」、`#kore-password` 数=0；13 张 sha 两两不同）
| 文件 | 尺寸 | bytes | sha256 前12 | 页内断言 |
| --- | --- | --- | --- | --- |
| logs-desktop-01-sources.png | 1440×900 | 192313 | cdd730728682 | 日志来源 / app / journal / 显示 200 行 |
| logs-desktop-02-keyword.png | 1440×900 | 191622 | 9a848a91ec6d | 显示 200 行 / ERROR |
| logs-desktop-03-search.png | 1440×900 | 168245 | 248f46a684d4 | 匹配 20 行 / 997 / 1994 |
| logs-mobile-01-sources.png | 390×844 | 51100 | c52533fddbb7 | 日志来源 / app / journal |
| logs-mobile-02-search.png | 390×844 | 45121 | 3499ef3927c3 | 匹配 20 行 / 997 |
| process-desktop-01-list.png | 1440×900 | 97465 | d47f578b58d0 | 进程列表 / 首次采样无历史基线 / PID |
| process-desktop-02-detail.png | 1440×900 | 97169 | 5144cb015722 | VmRSS / VmPeak / exe / cwd |
| process-desktop-03-tree.png | 1440×900 | 99850 | d435ebcea0eb | 进程树 / kored / sleep |
| process-desktop-04-kill-confirm.png | 1440×900 | 104736 | 04fc596a515c | 确认结束 PID 2 / sleep 300 / TERM |
| process-desktop-05-kill-result.png | 1440×900 | 97874 | 6ffa94f576b3 | killed=true / still_alive=false / waited_ms= |
| process-desktop-06-kill-denied.png | 1440×900 | 109785 | fa0925440f1c | E_INVALID / 拒绝操作 pid 1 / pid≤1 受保护 |
| process-mobile-01-list.png | 390×844 | 42665 | 5331307facfc | 进程列表 / kored |
| process-mobile-02-detail.png | 390×844 | 26189 | b6fa7923f2c9 | 进程详情 / VmRSS / exe |
- 移动端无整页横向滚动：`scrollWidth/innerWidth = 390/390`（两页）；`.proc-table-host` 计算样式 `overflow-x:auto`（表内滚动），触摸控件 `min-height:44px`。
- console：仅 3 条预期网络错误（登录前 `system/info` 401、无 favicon 404、kill pid1 400），uncaught 0。

## 6. G-28 产品定位自评
- **日志页**：① 不登 SSH 即可按来源看 tail、关键字过滤与全文件搜索，来源白名单不泄露宿主路径。② 与宝塔/1Panel 差距：无实时 follow、下载/导出、高亮、级别/时间可视化筛选，journal 仅 `journalctl short-iso` 全文。③ **可用**（真实文件、真实 200 行、真实行号搜索、空态/错误态齐全），非占位。
- **进程页**：① 浏览器内完成进程盘点、排序过滤、详情/树与受控信号投递，危险操作二次确认并原样展示护栏结论。② 差距：无自动刷新与 CPU/内存历史曲线、无树形折叠/批量操作、无服务管理联动。③ **可用**（真实 `/proc`、真实 kill、pid 1 拒绝、首次采样说明完整），非占位。

## 7. 门禁与清理
- `node --check web/logs.js web/process.js web/shell.js` → 0。
- `make frontend` → 0：首屏 gzip **34,478 B** / 307,200 B（index 683 + style 13,515 + app 14,553 + shell 5,727），dist 14 文件。
- `make docs-check` → 0（6 pass / 0 warn / 0 fail）；`make check` → 0（10/10 段，`[OK] 门禁全部通过`）。
- 清理：18887 已停；命名空间内 sleep/python 随 pid 1 一并回收（`pgrep sleep 300` 无残留）；chromium 与 `/tmp/kore-lp-verify` 删除；8787 未触碰。
- 已知观察（用户口径）：终端页失败观察记观察项，不纳入本任务失败判定；本轮未改 `terminal.js`。
