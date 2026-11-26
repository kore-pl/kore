# C9 独立验收报告（G-09 / task-136）

> 2026-11-26 · verifier `c9-verifier`（独立于实现者 `c9-threshold`）· 只读复核 commit `06a6b9d` · 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore` · 总评 **PASS**

## 0. 结论

C9「monitor.js 前端接后端已持久化阈值」五项复核范围（读码 / 门禁 / 隔离断言 / G-28 截图 / git 纪律）全部通过。未发现 BLOCKED 项。以下逐项给命令、退出码与关键证据。

---

## 1. 读码核对（阈值接线）

| 复核项 | 证据（file:line） | 判定 |
| --- | --- | --- |
| 启动调 `monitor.config.get` 替换硬编码 90 | `web/monitor.js:245` `invoke('config.get', {})`；`loadThresholds()` 在 `loadAll()` 第一步被调用（`:890-899`）。默认 90 仅保留在 `DEFAULT_THRESHOLDS`（`:25`），不再直接下发。 | PASS |
| `DEFAULT_THRESHOLDS` 兜底 | `:25-27`；`loadThresholds` 失败回调 `function(){ return THRESHOLDS; }`（`:257`）与"三键齐全才替换"（`:255`）保证插件未装 / 读不到时沿用旧值 / 默认值，不白屏。 | PASS |
| config key 映射正确 | `:247-249` `cpu_threshold / memory_threshold / disk_threshold` → `cpu_percent / memory_percent / disk_percent`，与后端 `../kore-plugin-monitor/config.go:55-57` 字段名一致；做了 `0..100` 范围校验（`:252`）。 | PASS |
| 三处共用后端真值 | ①告警面板 `:776-777`（`THRESHOLDS.cpu_percent / memory_percent / disk_percent`）；②图表参照线 `:613`（`c.ref = THRESHOLDS[c.series.thr]`，SERIES 的 thr 键 `:30-39` 为 `cpu_percent/memory_percent/disk_percent`，与 THRESHOLDS 键一致）；③下发给 `monitor.system` 的 `thresholds`（`:900`）。三处同源 `THRESHOLDS`。 | PASS |
| 设置入口复用 `KoreShell.openConfig`，不新增表单控件 | `:262-272`：只新增一个「⚙ 阈值设置」按钮（`:951-953`），点开调 `window.KoreShell.openConfig(S.box, 'monitor', {title, onSaved})`；`onSaved` 回调重读 config.get + `loadAll()`（`:269`）。表单由内核通用 schema 面板承载，本页无自建 input/select。 | PASS |
| 不传 `history_points` | `:899` 注释 + `:900` 实际调用 `invoke('system', { per_cpu: false, thresholds: THRESHOLDS })` 不含 `history_points`；grep 全文件 `history_points` 只在注释行 `:899` 出现。图注改为读 `history.capacity`（`:678-681`，"后端保留 N 点（重启接续）"），不再宣称"单序列上限 1000"。 | PASS |
| 硬编码 90 残留 | `grep -n '\b90\b' web/monitor.js` 仅命中 `:25` 的 `DEFAULT_THRESHOLDS` 定义一行（兜底常量，符合任务要求）。 | PASS |

---

## 2. 门禁复跑

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --version` | 0 | v24.21.0 |
| `node --check web/monitor.js` | 0 | 无输出（语法通过）。首次误读为 exit=1 系 `&&` 链中无输出的显示假象，单独重跑确认 RC=0。 |
| `make frontend` | 0 | `[OK] 前端静态产物已打包（65 文件）`；`[OK] 首屏体积达标：90924 字节 ≤ 307200 字节（300 KiB）`，余量 216276 B；首屏漂移 WARN（基线快照未更新，非 BLOCKED，亦非本次新增 FAIL）；i18n 增量 2941 ≤ 3072。 |
| `bash scripts/usability-check.sh --no-run-tests` | 0 | `usability-check: 0 pass, 502 warn, 0 fail, 183 unverified`；0 FAIL，与基线一致，无新增 FAIL。 |

说明：以上为本 verifier 在当前共享工作区实测复跑，与实现者自评表数值一致（`make frontend` 首屏 90,924 B / `usability-check` 0 FAIL / 502 WARN）。

---

## 3. 隔离断言复核

复核对象：`.agents/verify/ui-c9-selfeval.md`（实现者 task-133 落盘，commit `06a6b9d` 内唯一文字证据），并核对工作区残留状态。

| 断言 | 证据 | 判定 |
| --- | --- | --- |
| `config.set 63/55/47` → 刷新 DOM 显示新值 | 自评 `:30` / `:33`：`node .agents/verify/iso-c9/verify.js` exit 0，`ASSERT PASS: config.set 200 saved+applied`、`ASSERT PASS: 刷新后阈值告警面板显示新值 63%/55%/47%`（PC + 手机各一遍）。**旁证**：真实截图 `ui-c9-threshold-desktop.png` / `ui-c9-threshold-mobile.png` 中阈值告警面板肉眼可见 `63% / 55% / 47%`（见 §4），与脚本断言互相印证。 | PASS |
| 图注无残留 90% | 自评 `:30` 明记"图注无残留 90%；两次循环均 PASS"；读码侧图注已改为读 `history.capacity`（`:678-681`），源码里不再有"单序列上限 1000"或写死 90 的图注。 | PASS |
| 面板改 CPU=41 立即显示 | 自评 `:31` / `:33`：`node .agents/verify/iso-c9/panel.js` exit 0，`PASS: 面板保存后页面阈值同步显示 41%`；机制上 `onSaved → loadThresholds → loadAll`（`:269`）支持保存即重绘。 | PASS |
| 未捕获异常 0 | 自评 `:31` / `:44` 明记"未捕获异常 0"。 | PASS |
| 隔离实例 18945 非 8787 | 自评 `:3` / `:48`：`127.0.0.1:18945` 独立 config/state/run/log/bin。实测 `ss -ltnp`：仅 `127.0.0.1:8787` 在监听，18945 无监听（进程已停）。 | PASS |
| 临时目录已删 | `ls -la .agents/verify/iso-c9` → `No such file or directory`；全仓 `find` 无 `verify.js` / `panel.js` 残留。 | PASS |
| 未碰 `.kore-local-*` | 实测 `.kore-local.yaml` mtime 2026-11-25 20:15、`.kore-local-run` 2026-11-26 18:26、`.kore-local-state` 2026-11-23 20:08，均早于 C9 改动时段（20:09 截图 / 20:11 commit），未被本轮改写。 | PASS |

诚实边界：`verify.js` / `panel.js` 是一次性脚本，已按用户纪律删除，本 verifier 无法再次执行它们；本节对脚本结论的采信基于（a）实现者贴出的命令+退出码+断言输出，（b）源码机制自洽，（c）真实截图上肉眼可见的 63/55/47 新阈值作为独立旁证。三者一致，未发现矛盾。

---

## 4. G-28 截图硬核验

四张截图均存在于 commit `06a6b9d`，`file` / `identify` 实测宽高与自评表一致：

| 文件 | `identify -format '%f %wx%h %b'` | `read_image` 实读 |
| --- | --- | --- |
| `ui-c9-threshold-desktop-viewport.png` | 1440x900 98463B | 已实读：PC 视口，顶栏搜索/告警/监控图标 + 左侧菜单 + 监控页；刷新与「⚙ 阈值设置」两按钮同排；阈值告警面板显示 `90% / 90% / 90%`（默认兜底场景）；CPU 曲线参照线 90%。 |
| `ui-c9-threshold-mobile-viewport.png` | 390x844 55865B | 已实读：手机精确视口，卡片单列、按钮可见、底部 tab 条、无横向溢出。 |
| `ui-c9-threshold-desktop.png` | 1440x2620 245718B | 已实读：PC full-page，含告警面板 `63% / 55% / 47%`（**新阈值实证**）、磁盘/网络/温度/进程 Top10。 |
| `ui-c9-threshold-mobile.png` | 390x3639 223573B | 已实读：手机 full-page，同样可见 `63% / 55% / 47%` 与单列响应式布局。 |

`sha256sum`：desktop-viewport `9dcde613...`、mobile-viewport `0de78a57...` 不同；两张 full-page 亦不同（CSS 布局/resize 差异明显，非同图缩放冒充）。

G-28 三要素齐备：① PC 截图（1440×900 视口 + full-page）② 手机截图（390×844 视口 + full-page）③ 产品定位自评（`.agents/verify/ui-c9-selfeval.md`，逐字回读，三问原文摘要如下）。

- **问 1（解决什么用户问题）**：把前端硬编码 90 换成后端持久化阈值，进监控页即读已保存值，参照线与告警提示同源；设置复用统一面板，保存即生效。
- **问 2（与宝塔/1Panel 差距）**：Kore 沿 G-19 禁轮询，阈值只在手动刷新/设置保存时生效，无站内推送/时间窗差异化；优势是零新增表单实现、零常驻进程、零框架、前后端一份真值。
- **问 3（可用还是占位）**：**可用**——双端截图来自隔离实例真实浏览器登录，API 路径与 UI 路径各自实测 PASS，未捕获异常 0，三门禁全绿。

判定：截图真实、非伪造、非同图缩放，能看到新阈值（63/55/47），G-28 PASS。

---

## 5. git 纪律核对

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| commit 精确 6 文件 | `git diff-tree --no-commit-id --name-only -r 06a6b9d` | 6 文件：`monitor.js` + 4 张 `ui-c9-threshold-*.png` + `ui-c9-selfeval.md`。无后端/插件/他人 dirty 文件。 |
| HEAD == 06a6b9d | `git rev-parse HEAD` | `06a6b9da4f3c5970d8bba77fc4d1874ebceea446` |
| 未 push | `git branch -r --contains 06a6b9d` | 无任何远端跟踪分支包含该 commit；`git rev-list --count origin/main..HEAD` = 14（本地领先）。 |
| worktree 仅主树 | `git worktree list` | 1 行：`/home/pt/.../kore 06a6b9d [main]` |
| 无临时分支 | `git branch --list 'wt-*' 'tmp-*'` | 无 |
| 他人 dirty 原样 | `git status --short` | 仍为既有 dirty：`M scripts/usability-pending.txt`、`M docs/FEATURE-GAP-BACKLOG.md`（本次验收期间他人新改，非本任务写入）、`?? .agents/verify/*.md`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`、`?? data/`、`?? dist/`。C9 的 6 文件均已提交，工作区无本任务残留（本报告除外，见 §6）。 |
| commit 首行 agent 前缀 | `git log -1 --format='%s'` | `[agent:c9-threshold] feat(web/monitor): 阈值接后端 config.get/set 并复用通用设置面板`，带 `Signed-off-by`。 |

---

## 6. 本报告提交（verifier 自身写域）

本报告是本 verifier 唯一写入文件：`.agents/verify/c9-verification.md`。按硬纪律以精确路径提交（不 push、不联网、不执行主流程 CLI、不碰 `.kore-local-*`），提交信息带 `[agent:c9-verifier]` 与 `Signed-off-by`。其余工作区 dirty 一律不提交、不修改。

---

## 7. 总评

**PASS。** C9（commit `06a6b9d`）读码接线正确、三门禁全绿、隔离断言有真实截图旁证、G-28 双端截图实读为新阈值（63/55/47）且非伪造、git 纪律合规；无 BLOCKED 项。
