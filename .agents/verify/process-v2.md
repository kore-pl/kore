> 元信息: 2026-11-23T15:26+08:00 · 执行者 kore-impl-container-view（implementer）· `web/process.js` 364→478 行 · 隔离实例 `127.0.0.1:18871`（`--config /tmp/kore-p2/config.yaml`，state/run/log 全在 `/tmp/kore-p2`）· 插件 process **0.2.1**（经已验签索引 download 安装）· 主实例 8787 未动 · chromium CDP 双端截图 · 报告 ≤90 行

# process 视图适配 0.2.1 契约（P0：装 0.2.1 就挂）

## 0. 结论

三处契约漂移全部修复 + 新增 renice 能力 + 保护名单锁标，`node --check` / `make frontend` / `make build` 全绿；隔离实例真机 10 项 API 断言全过（含 E_INVALID 回归、E_NEED_ROOT 真触发、renice 0→19 真生效、kill 真杀）；双端 5 张截图色标帧校验 attempt=1。**未改** sites/terminal/integrity/tasks/shell/embed/Makefile/internal。

## 1. 三处必改（file:line，均已真机复验）

| # | 位置 | 修复 | 真机证据 |
| --- | --- | --- | --- |
| 1 | `web/process.js:338` | `process.tree {pid}` → **`{root: pid}`** | `{root:1}` → 子树 count=433/total=798；旧契约 `{pid:1}` 静默返回全系统森林 count=500、roots=[1,2]（错数据不报错，更隐蔽） |
| 2 | `web/process.js:410-411` | kill 补 **`confirm:true` + `name`**；`signal==='KILL'` 另加 **`force:true`**（`web/process.js:410`） | 旧 `{pid,signal}` → `E_INVALID 缺少 confirm:true`；新契约 → `{"schema":"process.kill.v2","killed":true,"still_alive":false}`（真杀 sleep ✓） |
| 3 | `web/process.js:301` | 树渲染去掉 `n.state`（0.2.1 节点只有 pid/ppid/name/depth/children_count）→ 改渲染 **`(N 子)`** | 实拍树 `1978871 kored (1 子)` / ` 2070373 process`；`tree_has_undefined=false`（旧代码会输出 `[undefined]`） |

## 2. renice 实现（预设档位 + 非 root 提示）

- **入口**：详情抽屉「调整优先级」按钮（`web/process.js:262` 禁用条件：`restricted || protected`）→ 内联面板 `paintRenice`（`:347`）。
- **预设优先**（USABILITY ①）：`NICE_PRESETS`（`:20`）三档 **高（nice 0）/ 普通（nice 10）/ 低（nice 19）** 下拉，不给滑动条；旁边**自定义 0–19 数字框兜底**（越界本地拦截 `:388-391`）。后端只收 0..19，负数入口根本不存在。
- **提交**（`doRenice :384`）：`{pid, value, confirm:true, name}`；成功显示 `nice {previous} → {nice}` 并 400ms 后 `load()` 回读。
- **非 root 提示**（`hintFor :91`）：message 已含 `sudo/root/刷新后重试` 时不重复拼接；否则按码补一句——`E_NEED_ROOT→（需要 root：用 sudo 重启 kored 后重试）`、`E_UNAUTHORIZED→保护名单`、`E_NOTFOUND→进程可能已退出`、`E_CONFLICT→PID 已复用`。面板常驻文案：「把数字调小（提权）需要 root…调大（降优先级）随时可用」。
- **真机**：自己的 `sleep` 0→19 → `{"previous":0,"nice":19,"changed":true}`；缺 confirm → `E_INVALID`；value=-5 → `E_INVALID nice 必须在 0..19`；root 进程 ksmd(5)→0 → **`E_NEED_ROOT 调高优先级（nice 5 → 0）需要 root 权限：请用 sudo 启动 kored`**（message 自带 sudo，hintFor 不重复）。

## 3. 保护名单锁标

- **列表行**（`web/process.js:147-151`）：`item.protected` → 名称后 `保护` 徽标（复用 `.tag-muted proc-restricted` 样式），`title`/`aria-label` 带 `protected_reason` 原文。
- **详情抽屉**（`:247-250`）：黄条「保护 + 原因」；**结束进程（`:254`）与调整优先级（`:262`）双禁用** + 各自 title 说明。
- **真机**：`process.list` 过滤 `kore` → `kored保护 / process保护` ×3 徽标；kored 详情 `kill_disabled_protected={kill:true,renice:true}`；对 pid1 调 kill → `E_UNAUTHORIZED 拒绝终止：PID 1（init）…`。

## 4. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/process.js` | **0** | 无输出 |
| `make frontend` | **0** | 首屏 59,416 B ≤ 307,200；i18n 2,801 ≤ 3,072 |
| `make build` | **0** | `[OK] 构建完成: ./bin/kored` |
| `make secret-check` | **0** | `0 FAIL`（本报告无明文口令，口令为 `$KORE_P2_PASSWORD`，值不落档） |

## 5. G-28 双端截图（`file` 实测宽高；左上 3×3 色标=帧校验标记，attempt 全 =1）

| 文件 | `file` 实际宽高 | sha256 前16 | 证据点 |
| --- | --- | --- | --- |
| `process-v2-desktop-01.png` | **1440 x 935**（full-page） | `e27f034506f49962` | 过滤 `kore`：`kored保护`/`process保护` 3 枚锁标 + 普通行混排；页面横向溢出 0 |
| `process-v2-desktop-02.png` | **1440 x 900** | `7b4e1e774ede46f5` | 详情抽屉「优先级 nice 0」行 + **调整优先级面板**：三档预设下拉 + 自定义框 + root 提示 + 确认/取消 |
| `process-v2-desktop-03.png` | **1440 x 900** | `9193fb67b42a894d` | kored 详情（保护黄条）+ **进程树 root 子树** `kored (1 子)/process`，无 `undefined`；kill/renice 双禁用 |
| `process-v2-desktop-04.png` | **1440 x 900** | `24e6bc692a753846` | **结束进程确认框**：PID+名称+命令行 + 「提交时会带上进程名做校验」说明（截图后点取消，未执行） |
| `process-v2-mobile-01.png` | **390 x 844** | `589397c36b6270d6` | 手机列表：横向溢出 **0**、工具栏按钮 **2/2 = 44px** |

浏览器态：`page_errors_total=0`；console 6 条全为预期（favicon 404、首帧 401、隔离实例未装 monitor/site/ssl/discover 的 4 个概览探测 404）。
> 口径说明：本会话 `read_image` 存在「同 sha 供旧图」的显示侧缓存问题，截图内容以**色标像素 + 拍摄前 DOM 断言（shots.json）+ 区域亮度结构**三重程序化证据为准（抽屉开=整页被 `.proc-mask` 压暗、抽屉区亮，与 container 基线图同构）。

## 6. 产品定位自评（G-28 三问）

**① 本页解决什么用户问题**：CPU 被某个进程吃满时，过去只能 SSH 上去 `top` + `kill` + `renice` 三连；本页把「看是谁（列表/详情/树）、降它优先级（三档预设一键）、杀它（二次确认）」收在一个抽屉里，且**装了 0.2.1 后旧页面会直接挂**——本次修的就是这个断链：树参数、结束确认、优先级入口、保护锁标四件套对齐新契约，用户点开就能用。

**② 与宝塔/1Panel 的差距**：它们的进程管理有批量结束、按用户/端口筛选、进程监控曲线与历史；本页只有单进程粒度的列表/详情/树/结束/优先级，没有批量与历史趋势。但本页有两件它们不强调的：**保护名单可视化**（init/内核线程/kore 组件锁标并禁操作，防面板误杀）与**PID 复用防线**（结束/调优先级都带进程名校验 + 手输确认）。

**③ 当前是「可用」还是「占位」**：**可用（非占位）**——10 项真机 API 断言全过（真杀、真 renice、真 E_NEED_ROOT/E_UNAUTHORIZED），双端截图真实渲染，Runtime 异常 0。边界如实声明：`E_NEED_ROOT` 的「调高优先级」路径只能在非 root 下拿到拒绝证据（正向提权需 sudo 起 kored，未实测成功路径）；`force:true`（SIGKILL）只做了参数与错误文案核对，未真按 KILL 键（避免不可恢复操作）。

## 7. G-29 / 环境声明

**本轮未改动主实例运行态配置**（`.kore-local.yaml`/`.kore-local-state`/`.kore-local-run` 零写入，8787 只被 `ss` 只读探测过）；隔离实例 `/tmp/kore-p2` 验证完即删。两处并行环境事实（非本任务引入，如实记录）：① `kore-plugins/index` 工作树当时正处于**第 35 把重签中**（json 新于 sig，验签必败），隔离实例改用 `git archive HEAD` 快照 `/tmp/kore-p2/index`（34 把自洽）+ 验签通过；② 本地 `dist/process-0.2.1.tar.gz`（`d6dbc030…`）与索引声明（`27510bc5…`）**不一致**，故走已验签索引的 `download:true` 安装（sha 由索引给出，GitHub release 200），未绕过校验、未开 `allow_unsigned`。
