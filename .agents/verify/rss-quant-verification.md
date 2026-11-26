# RSS 定量报告独立复核（G-09）

> 复核者：rss-quant-verifier（独立 verifier，非 rss-quant；G-09 角色不兼任）｜task-149
> 被复核对象：`.agents/verify/rss-composition-live.md`（commit `9808555b123034a94dddd7891ea8257d7b10c4f5`，126 行）
> 方式：纯只读复算，未重跑采集（一次性脚本已删）、未改生产代码、未调参、未启停服务、未联网、未碰 `.kore-local-*`。
> 复算工具：`python3` 独立重算，未引用报告结论作为输入。

## 总评：**PASS**

【核心】所列全部对账算术、统计/对比算术、结论纪律、git 与清理纪律均成立。另有 2 处**非阻断的支线记账瑕疵**（不影响任何核心数字与结论），如实记录在 §5，供原作者知情，不构成本次 BLOCKED。

---

## 1. 对账算术（全部成立）

### 1.1 smaps 分项之和 = VmRSS 14,204 KiB

`4,576(r-x) + 4,468(r--) + 324(rw-p) + 0(.so) + 28(state.db) + 2,932(heap) + 1,744(其它anon) + 100(裸anon) + 24(stack) + 8(vdso) = 14,204` → **与 VmRSS 14,204 逐 KiB 相等 ✓**

### 1.2 clean/dirty 口径对账

- `Private_Clean 9,316 + Shared_Clean 8 = 9,324` = status `RssFile` 9,324 ✓
- `Private_Dirty 4,880 + Shared_Dirty 0 = 4,880` = status `RssAnon` 4,880 ✓
- 两者之和 `9,324 + 4,880 = 14,204` = `VmRSS` = `smaps_rollup Rss` 14,204 ✓
- 分项回收验证：`Private_Clean = 4,576+4,468+244(rw-p clean)+28 = 9,316` ✓；`Private_Dirty = 80(rw-p dirty)+2,932+1,744+100+24 = 4,880` ✓
- 声明的 status vs smaps 口径差处理（80 KiB rw-p dirty 归 RssAnon）算术自洽 ✓

### 1.3 各占比（KiB / 14,204）

| 项 | KiB | 复算占比 | 报告值 | 一致 |
| --- | ---: | ---: | ---: | --- |
| r-x 文本页 | 4,576 | 32.2163% | 32.22% | ✓ |
| r-- 只读数据页 | 4,468 | 31.4559% | 31.46% | ✓ |
| rw-p | 324 | 2.2810% | 2.28% | ✓ |
| .so | 0 | 0% | 0% | ✓ |
| state.db | 28 | 0.1971% | 0.20% | ✓ |
| heap | 2,932 | 20.6421% | 20.64% | ✓ |
| 其它 anon | 1,744 | 12.2782% | 12.28% | ✓ |
| 裸 anon | 100 | 0.7040% | 0.70% | ✓ |
| stack | 24 | 0.1690% | 0.17% | ✓ |
| vdso | 8 | 0.0563% | 0.06% | ✓ |

占比合计 = 100.0% ✓。PSS 合计 `14,196`（vdso 8 KiB 进程共享摊薄为 0），与 RSS 差 8 KiB，与报告一致 ✓。

---

## 2. 统计 / 对比算术（全部成立）

- 中位数取法：n=60，按分布 `14,204×21 / 14,228×29 / 14,252×10`，第 30、31 位均为 14,228 → 均值 **14,228**，与 `statistics.median` 一致 ✓；分布计数 `21+29+10=60` ✓。
- `14,228 − 8,192 = 6,036` ✓；`6,036 / 8,192 = 73.6816%` → 报告 73.7% ✓。
- `r-x + r-- = 4,576 + 4,468 = 9,044` ✓；`9,044 − 8,192 = 852` ✓。
- 距硬红线 `16,384 − 14,228 = 2,156` ✓；文本页占目标 `4,576/8,192 = 55.86%` → 报告"56%" ✓。
- 11-23 基线（读 `v1-budget-measure.md:81` 原文核对：VmRSS median 13,496 / RssAnon 4,932 / RssFile 8,564 ✓）：
  - VmRSS `14,228 − 13,496 = +732`，`732/13,496 = +5.42%` → 报告 +732/+5.4% ✓；末点 `14,204 − 13,496 = +708` ✓。
  - RssFile `9,324 − 8,564 = +760`，`760/8,564 = +8.87%` → 报告 +760/+8.9% ✓。
  - RssAnon `4,904 − 4,932 = −28`、末点 `4,880 − 4,932 = −52` ✓；Threads `13 − 16 = −3` ✓。
  - 二进制 `13.3 − 10.48 = 2.82 MB` → 报告"+2.8 MB" ✓。
- RssFile 大头三大块：`4,576/9,324 = 49.08%`（文本页）、`4,468/9,324 = 47.92%`（只读数据页）、`280/9,324 = 3.00%`（`244+28+8=280`）✓。

---

## 3. 结论纪律（成立）

- **明确答"RssFile 大头"**：报告 §5 明确给出文本页 4,576（49.1%）vs 只读数据页 4,468（47.9%），结论"几乎各半、文本页略多，只读数据页不是大头但体量相当" ✓。
- **8 MiB 当前不可达**：§6.2 明确判"不可达"，并论证两主二进制 VMA 9,044 KiB 已超 8 MiB 852 KiB，属 `.text+.rodata` 驻留下限 ✓。
- **压缩面归因设计/架构层、G-22 禁调参**：§6.2 列出 a) `.gopclntab` b) embed 外置（破坏 Tier A 承诺需用户裁决）c) Go 运行时常驻 d) 文本页移出内核——逐条标注设计/架构层，明确"不是 GOGC 微调"，并注 G-22 ✓；文首声明未调参 ✓。
- **诚实边界齐全**：空载隔离实例（UDS-only、无插件、无请求）非真实请求态 ✓；未做 pprof（依赖 task-147 零端点）✓；`METRICS_HTTP=401` 未做 RSSKiB 交叉核对 ✓；字段来源标注（VmRSS/RssAnon/RssFile 取自 status，逐 VMA 取自 smaps，smaps_rollup 仅交叉核对 PSS；本机内核 smaps_rollup 无 RssAnon/RssFile）✓；采样时间窗口与 sleep 20s 稳定性说明 ✓。
- **WARN 而非"未完成"**：§6.1 明写"距硬红线尚有 2,156 KiB 余量（G-03 判 WARN 不判未完成）"，与 ADR-0016 / G-03 口径（目标非红线，红线与目标之间记 WARN、不返工）一致 ✓；11-23 基线同口径 WARN ✓。无"未完成"越界表述。

---

## 4. git 与清理纪律（全部成立）

- **9808555 精确单文件**：`git show --name-status` = `A .agents/verify/rss-composition-live.md`，1 file changed / 126 insertions ✓。
- **提交规范**：首行 `[agent:rss-quant]` 前缀 ✓，`Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ✓。
- **未 push**：`git rev-list --left-right --count origin/main...HEAD` = `0 27`（本地领先 27，无落后）；`git branch -r --contains 9808555` 无输出 → 该 commit 不在任何远端分支 ✓。
- **worktree 仅主树**：`git worktree list` 仅主工作树 `/home/.../kore 9808555 [main]`（1 行）；`git branch --list 'wt-*' 'tmp-*'` 空 ✓（G-25）。
- **他人 dirty 原样**：`git status --short` 显示 `M scripts/usability-pending.txt` 及多条 `??`（e2e-*.md、local-update-plan.md、release-batch-*.md、run-user-model.md、screenshots/adp-debug-desktop-01.png、`data/`、`dist/`）——均非本次复核对象，复核前后未改动 ✓。复核前暂存区为空，未夹带他人内容 ✓。
- **一次性脚本/目录删净**：`.tmp-rss-quant-20261126/` 不存在，`ls .tmp-rss-quant-*` 无匹配，`git status --ignored` 无 rss-quant 条目 ✓；`.git/info/exclude:17` 的 `/.tmp-rss-quant-*/` 行保留——属任务卡明确允许保留的正常排除规则 ✓。

---

## 5. 非阻断观察（如实记录，不影响 PASS 判定）

1. **§5 RssAnon 拆分句加总差 80 KiB**：报告第 109 行写"Go heap 2,932 + Go 元数据 1,744 + 裸 anon 100 + 主线程栈 24 = 4,880"，四项实际相加为 **4,800**，差 80 KiB。差额即报告第 72 行已注明的 `rw-p` 中 80 KiB dirty（→RssAnon），该句列举时遗漏此项。RssAnon 总量 4,880 本身经 §1.2 clean/dirty 对账验证**正确**，故属列举不全／句子算术瑕疵，不改任何结论与核心数字。
2. **§4 VMA 数列合计多 1**：第 70–79 行 VMA 数列 `1+1+1+0+1+4+34+1+1+4 = 48`，合计行第 80 行写 47，相差 1（疑 `[vdso]/[vvar]/[vsyscall]` 实际 3 个而非 4 个）。纯属记账栏位 off-by-one，与 RSS/占比算术无关。

两项均为支线描述性栏位／句子的瑕疵，【核心】要求核对的算术与结论全部成立，故总评仍为 PASS。建议原作者后续在原文订正这两处。

---

## 6. 复核证据（命令 + 结果）

- `git show --stat --oneline 9808555` → `1 file changed, 126 insertions(+)`。
- `git show --name-status 9808555` → `A .agents/verify/rss-composition-live.md`；`Signed-off-by` 存在。
- `git status --short --branch` → `## main...origin/main [领先 27]` + 他人 dirty（见 §4）。
- `git worktree list` → 1 行（仅主树）；`git branch --list 'wt-*' 'tmp-*'` → 空。
- `git rev-list --left-right --count origin/main...HEAD` → `0 27`；`git branch -r --contains 9808555` → 空。
- `ls -ld .tmp-rss-quant-20261126` / `ls -ld .tmp-rss-quant-*` → 均 No such file or directory。
- `grep -n tmp-rss-quant .git/info/exclude` → `17:/.tmp-rss-quant-*/`。
- `python3` 独立重算（本报告 §1–§3 全部数值）：所有核心项 True/一致；两项支线瑕疵见 §5。
