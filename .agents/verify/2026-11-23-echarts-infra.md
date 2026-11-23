# 验收报告：文档 + 图表判据（infra 已被并发回退）

> 快照：2026-11-23 20:46:54 +0800 · HEAD `2667101`（验证期间 HEAD 连续变动，见 §4）
> 角色：独立 verifier（G-09；未复用 charts-infra / docs-scribe 结论）· 写域仅 `.agents/verify/**`
> 范围：文档轨 + 基建轨。monitor 页（task-3）用户裁决 HOLD，**G-28 顺延，原因 task-3 HOLD**；`web/charts*` 基建被并发会话回退，按 lead 2026-11-23 20:4x 口径记「已不具备验证对象」，不判实现轨 FAIL。

## 一、跑了什么（命令 + 退出码 + 关键输出）

门禁在 **pin 住的 HEAD 干净副本**上复跑，避免工作区在途改动污染结论：

```bash
rm -rf /tmp/kore-verify-cb9731c && mkdir -p /tmp/kore-verify-cb9731c
git archive cb9731c | tar -x -C /tmp/kore-verify-cb9731c   # cb9731c→2667101 仅 docs 差异
```

| # | 命令（cwd=/tmp/kore-verify-cb9731c） | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `timeout 120 bash scripts/docs-check.sh` | **0** | `docs-check: 5 pass, 1 warn, 0 fail` / 91 份文档 / 695 条链接可达 |
| 2 | `timeout 120 make charts` | **2** | `make: *** 没有规则可制作目标"charts"。 停止。`（`grep -c charts Makefile`=0） |
| 3 | `timeout 180 make frontend` | **0** | 35 文件；首屏合计 **59,709 B** / 307,200 B（300 KiB）；余量 247,491 B |
| 4 | `timeout 120 bash scripts/frontend-check.sh` | **0** | 首屏 59,709 B；i18n 增量 2,827 B / 3,072 B；**无图表卡口**（`grep -n "163840"` 零命中） |
| 5 | `timeout 300 make build` | **0** | `[OK] 构建完成: ./bin/kored`；未因缺 charts 文件失败 |
| 6 | `ls -l bin/kored` / `stat -c %s` | 0 | **10,027,170 B**（9.56 MiB）≤ 红线 26,214,400 B |
| 7 | `git show HEAD:web/charts.js` | **128** | `fatal: 路径 'web/charts.js' 不在 'HEAD' 中` |

> 说明：1/3/4/5 先在 `94f13c4` 副本跑出同一组数字；`git diff --stat 94f13c4..cb9731c` 仅 `.agents/WORKFLOW.md` + `AGENTS.md` 两处 docs 变更，web/Makefile/scripts 未变，故数字对 `cb9731c` 有效。2667101 只改台账，不影响构建。

## 二、结果（逐项 PASS/FAIL + 数字）

### 2.1 文档一致性与判据（对 HEAD `2667101`，非工作区）

| 检查 | 期望 | 实际 | 判定 |
| --- | --- | --- | --- |
| `grep -c "G-32" AGENTS.md` | 1 | **1** | PASS |
| `grep -c "ADR 状态: accepted" docs/DECISIONS/0027-…md` | 1 | **1** | PASS |
| `grep -c "自研 SVG" docs/FRONTEND.md` | 0 | **0** | PASS（旧标题已消失） |
| `grep -c "首选 ECharts5，非唯一" docs/FRONTEND.md` | ≥1 | **1**（§13 定调） | PASS |
| `grep -c "自研 Canvas" docs/FRONTEND.md` | ≥1 | **3** | PASS |
| `grep -n "越权决策回滚" .agents/LOG/DECISIONS.md` | 0 命中 | **1 命中（L82）** | **FAIL** |
| 文档声明 vs HEAD 代码（G-06） | 不宣称不存在的能力 | §13 L352 / ADR L27 称 infra「已就绪」；HEAD 无 `web/charts.js` 等 | **FAIL** |

**FAIL-1（措辞级，owner: docs-scribe）**
```
.agents/LOG/DECISIONS.md:82:| 2026-11-23 | ADR-0027「ECharts accepted」与 AGENTS G-32 是否越权（并发会话误判的纠正） | … ②撤销误判：… | ②：删除「越权决策回滚」与「第二次回归」两条错误记录；…
```
命中不是「仍保留错误裁决」，而是纠错记录里引用了要删除的标题。按 lead 明确判据（零命中）仍记 FAIL。
最小复现：`grep -n "越权决策回滚" .agents/LOG/DECISIONS.md` → 期望空。
最小修法：把该引用改为转述（如「删除两条不实记录」），保留纠错证据与理由。

**FAIL-2（G-06 文档-代码不一致，owner: docs-scribe；若由 charts-infra 重新落地亦可消除）**
```
docs/FRONTEND.md:352: … ECharts 基础设施（web/charts.js / web/charts/echarts-entry.js / scripts/build-charts.sh / make charts）已就绪但当前无页面消费者（见 ADR-0027）。
docs/DECISIONS/0027-…:27: 首选方案的基础设施已落地并经验收——… 提交 cc47bac（… 二进制 +471040 → 10477730 B…）。该实现已就绪，但当前无页面消费者…
```
HEAD `2667101`：`git cat-file -e HEAD:web/charts.js` → 128；`Makefile` 无 `charts` 目标；`frontend-check.sh` 无 163840 卡口。ADR 同句自带「若 cc47bac 被回退，以 git log 实际状态为准」的兜底，但 §13 无此限定，且「已就绪」与 HEAD 事实直接冲突。
最小复现：`git show HEAD:docs/FRONTEND.md | sed -n '352p'; git cat-file -e HEAD:web/charts.js`。
最小修法：在 §13 该句后补「截至 HEAD 已被并发回退，以 `git log -- web/charts.js` 为准；重新落地前不宣称就绪」；或由 charts-infra 恢复 `cc47bac` 后本项自动转 PASS。

### 2.2 基建轨（N/A：被并发回退，非本轨 defect）

| 对象 | HEAD 事实 | 判定 |
| --- | --- | --- |
| `make charts` | 无该目标，exit 2 | N/A（预期） |
| `web/charts.js` / `web/charts/echarts-entry.js` / `scripts/build-charts.sh` | 均不在 HEAD | N/A |
| `web/dist/charts-echarts.js` / `web/dist/charts.js` | 不存在（`make frontend` 后 35 文件，无 charts*） | N/A |
| `scripts/frontend-check.sh` 图表阈值 163840 | 不存在 | N/A |
| 规范 grep（排除 node_modules / web/dist / .cache） | 8 项均 0 命中；bare `import … from 'echarts'` 0 命中 | N/A（空集，不作为实现合规证据） |

**参考数据（非 HEAD 证据，不可在 HEAD 复现）**：来自被回退提交 `cc47bac` 的构建缓存 `web/.cache/charts/`（20:32 时间戳），仅作趋势参考，**不计 PASS**：

| 产物 | 原始字节 | `gzip -9` 字节 |
| --- | --- | --- |
| `charts-echarts.js` | 443,910 | **149,053** |
| `charts.js` | 4,526 | **2,297** |
| 合计 | — | **151,350 ≤ 163,840**（阈值见 `cc47bac:scripts/frontend-check.sh:78`） |

树摇判断：全量 `web/node_modules/echarts/dist/echarts.min.js` = 1,034,102 B raw / **334,372 B gzip-9**；缓存产物中仅 `type="line"`（3 次）与 `registerChartView`（2 次），`type="bar"|"pie"|"scatter"|"gauge"|"radar"` 均为 0 → **按需树摇成立**（约为全量 gzip 的 45%）。
静态/接口层断言（对象 `cc47bac:web/charts.js`，非 HEAD）：`MAX_INSTANCES`、`E_CHART_LIMIT`、`RESIZE_DEBOUNCE_MS`（=100）、`disposeAll`、`count()`、`sampling: 'lttb'`、`animation: false`、`lazyUpdate` 均存在；导出 `loadEcharts / createLineChart / disposeChart / disposeAll / count()` 与 §13 契约表一致。**但该对象已被回退，不能作为本轮 PASS 依据。**

### 2.3 体积与预算

- `bin/kored` = **10,027,170 B（9.56 MiB）** ≤ 26,214,400 B → **PASS**；`make build` 未因缺 charts 失败 → 回退干净。
- 对 lead 口径的更正：**9.99 MiB（10,477,730 B）是含 charts embed 的 `cc47bac` 尺寸**；干净回退后的 HEAD 构建是 9.56 MiB。
- ADR 数字自洽性（WARN，owner docs-scribe）：ADR 写「+471040 → 10477730」，但按实测基数 10,027,170 + 471,040 = **10,498,210**；且含 charts 的实测差为 450,560 B（10,477,730 − 10,027,170）。两种口径都 < 红线，不影响达标判断，但来源需复核。

### 2.4 性能 / G-28（未测，不判 FAIL）

- 短窗口性能：**未测**。原因：① HEAD 无 `web/charts.js`（infra 被回退，无验证对象）；② 本机无 headless Chromium（`command -v chromium chromium-browser google-chrome` 为空）；③ `web/monitor.js` 正由 monitor-canvas 改（20:46:54 工作区 `+321/−88`），监控页实测顺延到 monitor 轨交付后补。
- **G-28 双端截图：顺延，原因 task-3 HOLD**（用户裁决监控页保留自研 Canvas，不切 ECharts）。不以接口/DOM 断言冒充 UI 证据。

## 三、结论

**BLOCKED**（可验项 9 PASS / 2 FAIL / 2 N/A；不判整体 PASS，也不把并发回退记为实现轨 FAIL）

- 通过：四道必验命令（docs-check 0、make frontend 0、frontend-check 0、make build 0）；首屏 59,709 B；二进制 10,027,170 B；G-32 / ADR accepted / §13 新口径 / 自研 Canvas 四项文档判据。
- FAIL：① `.agents/LOG/DECISIONS.md:82` 仍含「越权决策回滚」字面（docs-scribe）；② §13/ADR 宣称 infra「已就绪」而 HEAD 不存在（docs-scribe；或 charts-infra 重新落地后消除）。
- N/A：`make charts` 与图表体积/树摇/接口断言（并发回退，非 defect）；短窗口性能与 G-28（task-3 HOLD）。
- 解除阻塞：① docs-scribe 清字面命中并修正「已就绪」表述；② lead/用户裁决后由 charts-infra 用追加 revert 反做 `c9a5336` 恢复 `cc47bac` 基建（或明确放弃并同步删文档承诺）；③ monitor 轨交付后补短窗口性能 + 双端截图。

## 四、并发 churn（P1，单列，不计入三轨 PASS/FAIL）

同一工作区两会话互回退，是本轮最大风险：

| 提交 | 时间 | 性质 |
| --- | --- | --- |
| `d7b8e7b` | 20:27 | 文档轨写入 ADR-0027 accepted / G-32 / §13 ECharts 判据 |
| `ec94dd8` | 20:31 | 另一会话 revert d7b8e7b（恢复自研 SVG） |
| `edc14b6` | 20:26 | 另一会话回滚 ADR-0027（→proposed）、移除 G-32 |
| `cc47bac` | 20:36 | charts-infra 落地基建（本次 task-2 对象） |
| `c9a5336` / `da5b88f` | 20:37 | 另一会话 `git revert` 掉 cc47bac 与 §13 校准提交 |
| `8ce44a1` | 20:39 | 另一会话「第三次清理」，清 G-32 / ADR accepted |
| `ed0a930` | 20:45 | docs-scribe 恢复 G-32 |
| `c09446b` | 20:43 | §13 改为「工程判据优先，ECharts 首选非唯一」 |
| `2667101` | 20:46 | 台账第 62 条记录「ECharts 三次清理根因是并发会话」 |

- `git reflog` 显示 `df8c01a` 为 `commit (amend)`（20:39:22）——与新增的 AGENTS §3「禁改写历史」条款冲突，属 P1 风险。
- 结论建议：**指定唯一裁决者 + 冻结写域**；基建恢复一律走追加 `git revert`（反做 `c9a5336`），禁止 amend/reset。

**工作区在途、非本 verifier 来源的改动**（未 checkout / stash / 提交）：
- 20:46:54：`M web/monitor.js`（+321/−88，monitor-canvas 的 Canvas+LTTB 改造）。
- 验证期间还观察到 `Makefile` / `web/embed.go` / `web/i18n/*` / `web/shell.js` 曾为 M，随后由 `a35097c`（ssh-guard 视图）等提交；来源不明者不代管。

**运行态声明（G-29）**：本轮未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`。工作区曾在 20:39–20:40 执行过 `make frontend`（重建 `web/dist`）与 `make build`（覆盖 `bin/kored`，10,027,170 B），此后复跑全部改用 `/tmp/kore-verify-*` 的 `git archive` 干净副本，未再写工作区运行态。

## 五、原始输出摘录

```
$ bash scripts/docs-check.sh
docs-check: 5 pass, 1 warn, 0 fail
结果: 门禁通过（1 WARN 不阻断）

$ make charts
make: *** 没有规则可制作目标“charts”。 停止。   [exit 2]

$ make frontend
[OK] 前端静态产物已打包: web/dist（35 文件…）
[INFO] 首屏合计（gzip -9）: 59709 字节 / 预算 307200 字节（300 KiB）

$ bash scripts/frontend-check.sh
[OK] 首屏体积达标：59709 字节 ≤ 307200 字节，余量 247491 字节

$ make build && ls -l bin/kored
[OK] 构建完成: ./bin/kored
-rwxrwxr-x 1 pt pt 10027170 Nov 23 20:45 bin/kored

$ gzip -9c web/.cache/charts/charts-echarts.js | wc -c     # 非 HEAD 参考
149053
$ gzip -9c web/node_modules/echarts/dist/echarts.min.js | wc -c
334372
```

## 六、复跑（第二遍窄复跑：仅两处 FAIL + 连带断言）

> 原 §三 BLOCKED 保留存档；本节为 lead 派回 docs-scribe 修复后的窄复跑结果与更新结论。
> 快照：2026-11-23 20:51:08 +0800 · HEAD `9468f05`。**修复当前在工作区未提交**（`M .agents/LOG/DECISIONS.md`、`M docs/FRONTEND.md`、`M docs/DECISIONS/0027-…md`，3 文件各 1 行替换）；HEAD 仍是旧措辞，故同时给「工作区口径」与「HEAD 口径」两列。

| # | 命令 / 断言 | 工作区（修复后） | HEAD `9468f05` | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `bash scripts/docs-check.sh` | **exit 0**，5 pass / 1 warn / 0 fail | 同左（docs-check 读工作区） | PASS |
| 2 | `grep -n "越权决策回滚" .agents/LOG/DECISIONS.md` | **0 命中**（L82 改为「删除两条不实记录（一条把 ADR accepted 与 G-32 误判为越权回滚…）」） | 1 命中（旧文本，未提交） | **PASS（工作区）** / 待提交 |
| 3 | `grep -n "已就绪" docs/FRONTEND.md docs/DECISIONS/0027-…md` | **0 命中**（§13 改「曾随 cc47bac 落地并通过门禁，但截至 HEAD 已被并发回退…以实际状态为准」；ADR 改「该实现当前已不在 HEAD（被 c9a5336 整体回退）」） | 2 命中（旧文本，未提交） | **PASS（工作区）** / 待提交 |

**4. 三条 infra 陈述 vs 事实（逐条对照）**

| 文档陈述（工作区） | 事实核对 | 结论 |
| --- | --- | --- |
| §13：「ECharts 基础设施…曾随 `cc47bac` 落地并通过门禁，但截至 HEAD 已被并发回退」 | `git log --oneline -3 -- web/charts.js` → `c9a5336`(Revert) / `cc47bac`(add)；`ls web/charts.js` → 不存在；`git log --oneline -5` → `9468f05` / `91709a2` / `2667101` / `a35097c` / `cb9731c`（无 charts 恢复提交） | 属实 |
| §13：「当前无页面消费者」 | `grep -c "echarts\|charts.js" web/monitor.js` = **0**；`grep -c "lttb\|LTTB" web/monitor.js` = **4**（HEAD 已含 monitor-canvas 的 Canvas+LTTB 改造） | 属实 |
| ADR：「该实现当前已不在 HEAD（被并发会话 `c9a5336` 整体回退）」 | `git show --stat c9a5336` 删除 `web/charts.js` / `web/charts/echarts-entry.js` / `scripts/build-charts.sh` / `web/embed.go` 条目等；`git cat-file -e HEAD:web/charts.js` → 128 | 属实 |

**5. `make build` 连带确认**（干净 `git archive 9468f05`，避免工作区在途 app.js/style.css 干扰）：
```
MAKE_BUILD_EXIT=0
[OK] 构建完成: ./bin/kored
10076322   # 10,076,322 B ≈ 9.61 MiB，≤ 26,214,400 B
```
与首轮 10,027,170 B 的 +49,152 B 来自 HEAD 前进（`91709a2` cron 预设、`9468f05` monitor Canvas+LTTB 改变了被 embed 的 web 资产），**不是 charts embed 回归**；HEAD 仍无任何 charts 依赖，`make charts` 依旧「没有规则可制作目标」（exit 2）。工作区 `bin/kored` 现为 10,080,418 B（charts-infra 20:49 观察，含未提交 app.js/style.css），不作为本轮证据。

**6. charts-infra 反馈的两条更正（已并入本报告）**
- 体积拆分更正：+450,560 B = 两产物原始字节 448,436（443,910+4,526）+ embed 索引开销 2,124；旧「+471,040 → 10,477,730」的基数是 20:19 旧快照，不成立。ADR 工作区版本已删除该数字、改为实测口径。
- 反做风险（charts-infra 实测）：`git revert --no-commit c9a5336` 在 `web/embed.go` 冲突（其后新增 ssh-guard/credentials 视图），已 abort 且无残留；重新落地须**手工重放** cc47bac 的 9 个文件 + 在当前 embed 清单追加两行，不得 amend/reset。本报告 §三「解除阻塞」中「用追加 revert 反做 c9a5336」据此更正为「手工重放」。

**复跑后结论（仅这两项）：PASS（工作区口径）** —— 两处 FAIL 均已按事实措辞修复，docs-check 仍 exit 0，三条 infra 陈述与 HEAD 事实一致，build 无 charts 依赖。HEAD `9468f05` 因修复尚未提交仍含旧措辞（越权=1 / 已就绪=2），**待 docs-scribe 提交后 HEAD 严格口径即时转 PASS**；建议尽快提交，避免并发 churn 覆盖未提交修复。

**整体结论（更新）：文档轨 PASS（复跑通过）；基建轨 N/A（被并发回退）；性能与 G-28 顺延（task-3 HOLD / monitor 轨已交付 Canvas+LTTB，短窗口实测待补）。** §四 P1 并发 churn 与 amend 风险原文保留，上报 lead/用户。
