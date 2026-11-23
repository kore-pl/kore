# 今日任务交付对账（派过 vs 落地）

- **日期**：2026-11-23（晚）
- **对账人**：verifier（gap-audit-tasks）
- **依据**：G-07（证据验收）、G-23（判断留痕）
- **结论口径**：板上 `completed` ≠ 完成；只认「commit / tag / release 资产 / 入库证据」四类可复核物。
- **本次对账未改动任何代码、文档与插件仓；只新建本文件。**

## 0. 取样命令（可复现）

```bash
# 任务板（含分页）：team_task_list limit=100 cursor=0/100 + status=in_progress / status=pending
git log --oneline --since="2026-11-23 00:00" | wc -l        # 285
git status --short                                          # 8 修改 + 大量未跟踪
git diff --stat                                             # 249 insertions(+), 46 deletions(-)
grep -c "^| 2026-11-23" .agents/LOG/DISPATCH.md              # 26
python3 -c "json.load(open('../kore-plugins/index/plugins.json'))"  # 24 条
for d in kore-plugin-*; do git -C $d describe --tags --abbrev=0; git -C $d rev-list --count <tag>..HEAD; done
curl -sI -L https://github.com/kore-pl/kore-plugin-<id>/releases/download/v<ver>/<id>-<ver>.tar.gz
```

## 1. 总量对账

| 指标 | 数值 | 证据 |
| --- | --- | --- |
| 板上任务总数（唯一 id） | **187** | `team_task_list` 两页 100 + 87，去重后 187 |
| `completed` | **178** | 状态过滤 + 全量分页统计 |
| `pending` | **6** | task-147 / 162 / 169 / 171 / 175 / 197 |
| `in_progress` | **3** | task-170 / 196 / 198 |
| 今日 kore 提交 | **285** | `git log --since` |
| 今日 DISPATCH 台账行 | **26** | `grep -c "^| 2026-11-23"` |
| 插件仓 | 24 | `../kore-plugin-*` |
| 索引条目 | 24 | `../kore-plugins/index/plugins.json` |
| 验收报告文件总数 | 159 | `ls .agents/verify/ | wc -l` |

> **关键判断**：187 张卡 vs 26 行台账 vs 285 个提交。**卡数远多于台账**——即存在大量「派了、干了、但 G-23 台账没留痕」的任务；台账不是对账依据，只能当旁证。

## 2. 表格 A · 有问题的任务（正常项不列）

| 任务 id | 主题 | owner | 状态 | 有 commit? | 有证据? | 真实结论 |
| --- | --- | --- | --- | --- | --- | --- |
| task-2 | S · Round 5 台账收口（含「补交 round3-*/install-six 证据」+ 推送） | lead | completed | 部分 | **否（未入库）** | **假完成**。其自述交付物 `round3-closeout.md` / `round3-final.md` / `round3-verified.md` / `install-six.md` 至今仍为 `??` 未跟踪（见 §6）；同一台账行在 `DISPATCH.md:49` 仍写 `in_progress`；推送当时也未做（后由 task-193 追推） |
| task-3 | B · 索引与重签收口（**第 32 把**） | kore-impl-release-r5 | completed | — | `resign-32.md` 存在 | **交付物已作废**。`DISPATCH.md:46`：「第 32 次签 6 条后收到追加清单，私钥已 shred → 作废换第 33 把」。卡片按 completed 结账，但该把签名在权威台账里是**废稿** |
| task-23 | R5-2 验证 · #12 方法级 capability 收益实证 | lead | completed | 无代码（只读验证） | 文件存在但 **untracked** | 交付存在、不进仓。`r5-12-method-capability.md` 未提交，G-07 证据链在仓库层面断开 |
| task-92 | 全仓 dist/索引一致性巡检 | kore-impl-release-r5 | completed | 无代码（只读巡检） | 文件存在但 **untracked** | 同上，`dist-index-consistency.md` 未提交 |
| task-115 | monitor 前端接历史曲线/阈值/进程 TOP | kore-impl-redis2 | completed | `9468f05` feat(web) 自研 Canvas + LTTB | 截图 `monitor-canvas-*.png` **untracked** | 代码落地、证据未入库；且渲染实现后来被 G-32 争议牵连（`8ce44a1` 第三次清理） |
| task-114 | ssh-guard 视图（第 21 个导航视图） | **lead** | completed | `a35097c`（实际作者 `[agent:kore-impl-waf]`） | `sshguard-view.md` 已入库 | 交付成立，但 **owner 记 lead**：派单人自任实现者，G-09（角色不可兼任）在这一批普遍失守（见 §7） |
| task-107 | ssh-guard 真机写路径（被 task-122 引用为「已派发并给出阻塞判断」） | 未知 | **不在板上** | 未确认 | 未确认 | 卡片已被删除或从未建卡；仅能从 task-122 的正文反推到它存在过。**交付无法对账** |

补充（不算「丢工作」，但会误导对账）：task-4~7、29、30、83、85、90、93、94、100、104 等一批「发版收口」卡标 completed，其中多数版本（redis 0.4.0、ssh-guard 0.2.0、logs 0.3.0、container 0.3.0、site 0.4.0、db-mysql 0.3.2/0.4.0…）**已被后续版本覆盖**。属正常迭代，但「completed」的含义是「当时发了」，不是「现在索引里是这个版本」——对账时不能拿旧卡当现状。

## 3. 表格 B · 未完成/被丢掉的工作清单（本次最重要）

> 分三类：**B1 工作已落地但卡片没结（僵尸账，可 complete）**、**B2 真的没做完（需重做/收尾）**、**B3 证据与半成品悬空（需入库或清理）**。

### B1 · 工作其实已落地，卡片状态是假的（6 张）

| 是什么 | 为什么丢 | 现在状态 | 建议动作 |
| --- | --- | --- | --- |
| **task-170** P0 首启登录引导 + `kored admin-password` | 卡在 `in_progress`，但 `e06a2fa`（子命令 + 首启引导）、`a5cd2c1`（配置路径统一）、`d26f6a3`（QUICKSTART 附录 `--hash`）**均已提交** | 可恢复（已完成，只需结卡） | 复核三提交覆盖卡内验收后 `complete`；同时解除 task-171 的 `blocked_by` |
| **task-171** P0 uninstall 退出码 + install 占用提示 + portable dry-run | `pending` 且被 task-170 阻塞，实际 `859f653`「uninstall 退出码不再假成功 + install 占用提示 + portable dry-run」**已提交** | 可恢复（已完成） | 解除依赖 → 复核 exit code 实测证据 → `complete` |
| **task-196** cron templates/batch UI | `in_progress`，实际 `bd7e23a`「计划任务预设卡改为后端模板驱动并接入批量启停」已提交 | 可恢复 | 复核 + `complete` |
| **task-197** backup 校验搬到主壳 `web/backups.js` | `pending`，实际 `7787aa7`「备份校验接入主壳」已提交，且 `backup-verify-*.png` 8 张截图已生成 | 可恢复 | 补 add 截图 + 证据 md → `complete` |
| **task-169** container 执行命令 G-28 双端截图 | `pending`，但 `container-exec-*-desktop/mobile.png` **8 张已存在**（未跟踪） | 可恢复 | 补入库 → `complete` |
| **task-162** docs(RELEASE) SDK 代理可见性门禁 | `pending`，实际 `60161eb`「发版窗口冻结 + tag 钉 sha + 代理可见性/索引延迟反例」已提交 | 可恢复 | 复核 docs/RELEASE.md 内容 → `complete` |

### B2 · 真的没做完 / 被判阻塞后没人接手

| 是什么 | 为什么丢 | 现在状态 | 建议动作 |
| --- | --- | --- | --- |
| **task-198** CLI 静默写第二个 state.db（路径统一 + fail-closed + `kored status`） | `in_progress`；`ad2d73a` 已落一版，但**工作树仍留 3 个未提交文件**：`internal/core/config/config.go`(+29)、`paths.go`(+52)、`paths_test.go`(+61 新增) | **半成品悬空**（可恢复，需判定 ad2d73a 已覆盖还是第二轮） | 由原 owner 决定「提交收尾」或「丢弃回滚」；不得长期留未提交改动 |
| **task-147** `make idle` 定时器门禁误报 | `pending`；`b61c662` 已提交「定时器白名单排除 scheduler 目录」，但 `Makefile` 仍有 **+48/-？未提交改动** | 部分完成 + 新半成品 | 先 `git diff Makefile` 判定未提交部分归属（可能属他人），再决定补提交 |
| **task-175** USABILITY 剩余 5 条 | `pending`；术语修正已有 `d970fa5` / `8898a9a` / `9468f05` 落地，但 5 条清单是否全清**无验收结论** | 部分完成 | 按 `docs/USABILITY.md §5.2` 逐条复核后结卡或补做 |
| **BOARD §9「Round 5 未做完」残留**：①通道 socket 方案①（已裁决未实现）②`container docker.go` hint 与 ADR-0018 冲突（引导「加入 docker 组」= 抬权）③`verify_file` 下划线命名进不了 `method_capabilities` ④R5-1 真 root 端到端**降权后未复验** | 无对应任务卡，挂在 BOARD §9 文字里 | 需重做/待裁决 | 逐条立卡；②是安全口径问题，优先级最高 |
| **长期挂账（跨里程碑）**：包级 ed25519 签名、audit O(n) 全表扫描、CSRF 审计持久化挂点、真实宿主 `env_kind=real` | BOARD 明确「挂 M5 / 不得复述为已证」 | 需重做 | 不属今日丢失，但必须在对账里显式保留，防止被当成已闭环 |
| **task-107**（ssh-guard 真机写路径） | 卡片已从板上消失，仅在 task-122 正文留下「阻塞判断」 | **需重做（无卡可依）** | 从 `docs/PLUGIN-MATURITY §3.5` 重建任务卡；当前降级方案 `ssh-guard.suggest`（0.3.0 已入索引）已覆盖「建议态」，真机下发仍缺 |

### B3 · 证据与半成品悬空（不算功能缺口，但违反 G-07）

| 是什么 | 为什么丢 | 现在状态 | 建议动作 |
| --- | --- | --- | --- |
| **11 份验收 md 未入库**：`2026-11-23-echarts-infra.md`、`2026-11-23-monitor-canvas.md`、`dist-index-consistency.md`、`install-six.md`、`ops-restart-verify.md`、`r5-12-method-capability.md`、`r5-resign33-independent.md`、`round3-closeout.md`、`round3-final.md`、`round3-verified.md`、`round5-global-acceptance.md` | 交付时只写文件未 `git add`（多 agent 并发时被跳过） | 可恢复（文件在盘上） | 单独一次 `docs(verify)` 提交全部补入；**不要与代码混提** |
| **约 150 张 G-28 截图未入库**（`backup-verify-*` / `container-exec-*` / `install-six-*` / `monitor-canvas-*` / `r3c-*` / `r3f-*` / `r3v-*` / `redis-*`） | 同上 | 可恢复 | 与对应 md 同批提交；G-28 要求截图可复核，不入库等于没证据 |
| **kore 工作树 8 个未提交修改**：`Makefile`(48)、`web/appdeploy.js`(67)、`AGENTS.md`(7)、`docs/RUNBOOK.md`(13)、`.agents/QUALITY-GATES.md`(18)、`internal/core/config/` ×3 | 多 agent 中断/交接未收尾 | **归属不明**（高风隖） | 逐文件 `git log -p` 比对判定归属：属已完任务→补提交；属废弃→回滚。**禁止 `git add .` 一把梭** |
| **5 个插件仓 HEAD 领先 tag（改了没发版）** | OSS 资产/文档类补充与验证报告，未触发新版本 | 可恢复 | 属正常「未发版内容」，但**必须知道**：索引锁的是 tag 产物，非 HEAD。下次发版前须 bump，否则造出「同版本两个 sha」（`RELEASE.md §0` 明令禁止） |

> 5 仓明细：`backup` +1（插件 UI 未启用注释）、`monitor` +3（OSS 九件套 + pluginapi v0.1.3）、`runtime-php` +2（OSS 九件套）、`ssl` +1（SSL enforce 验证报告）、`terminal` +3（OSS + pluginapi v0.1.3）。

## 4. 僵尸任务（板上 in_progress 但已无人执行）

| 任务 id | 主题 | owner | 判定依据 | 建议 |
| --- | --- | --- | --- | --- |
| **task-170** | P0 首启登录引导 + admin-password | p0-login | 对应提交 `e06a2fa` / `d26f6a3` / `a5cd2c1` 已在 main；owner 已有后续 `ad2d73a` 类提交 | **complete**（复核后） |
| **task-196** | cron templates/batch UI | kore-impl-cron | `bd7e23a` 已落地同一功能 | **complete**（复核后） |
| **task-198** | CLI 路径统一 + fail-closed | p0-uninstall | `ad2d73a` 已落地，但工作树留有该写域的未提交改动 | **先收尾再 complete**；若判定 ad2d73a 已覆盖则 `delete` 并回滚残留 |

> 三个 `in_progress` **没有一个是真的在跑**（对应提交都已进 main 或已在工作树留下痕迹）。板子状态的滞后本身就是对账噪音源。

## 5. 表格 C · 版本-索引一致性

**结论：24/24 仓 `info.json.version` == 索引 `version`，零不一致。**

| 仓 | info.json | 索引 | tag | HEAD 领先 tag | 判定 |
| --- | --- | --- | --- | --- | --- |
| app-deploy | 0.3.0 | 0.3.0 | v0.3.0 | 0 | 一致 |
| backup | 0.4.2 | 0.4.2 | v0.4.2 | **+1** | 版本一致，HEAD 有未发版内容 |
| container | 0.5.2 | 0.5.2 | v0.5.2 | 0 | 一致 |
| cron | 0.5.0 | 0.5.0 | v0.5.0 | 0 | 一致 |
| db-mysql | 0.4.1 | 0.4.1 | v0.4.1 | 0 | 一致 |
| db-postgres | 0.3.3 | 0.3.3 | v0.3.3 | 0 | 一致 |
| discover | 0.3.1 | 0.3.1 | v0.3.1 | 0 | 一致 |
| dns | 0.4.0 | 0.4.0 | v0.4.0 | 0 | 一致 |
| echo | 0.1.4 | 0.1.4 | v0.1.4 | 0 | 一致 |
| file | 0.3.2 | 0.3.2 | v0.3.2 | 0 | 一致 |
| firewall | 0.2.6 | 0.2.6 | v0.2.6 | 0 | 一致 |
| integrity | 0.4.0 | 0.4.0 | v0.4.0 | 0 | 一致 |
| logs | 0.5.0 | 0.5.0 | v0.5.0 | 0 | 一致 |
| monitor | 0.3.0 | 0.3.0 | v0.3.0 | **+3** | 版本一致，HEAD 有未发版内容 |
| process | 0.3.0 | 0.3.0 | v0.3.0 | 0 | 一致 |
| redis | 0.6.0 | 0.6.0 | v0.6.0 | 0 | 一致 |
| runtime-node | 0.2.4 | 0.2.4 | v0.2.4 | 0 | 一致 |
| runtime-php | 0.2.2 | 0.2.2 | v0.2.2 | **+2** | 版本一致，HEAD 有未发版内容 |
| runtime-python | 0.3.1 | 0.3.1 | v0.3.1 | 0 | 一致 |
| site | 0.4.3 | 0.4.3 | v0.4.3 | 0 | 一致 |
| ssh-guard | 0.3.0 | 0.3.0 | v0.3.0 | 0 | 一致 |
| ssl | 0.6.0 | 0.6.0 | v0.6.0 | **+1** | 版本一致，HEAD 有未发版内容 |
| terminal | 0.2.0 | 0.2.0 | v0.2.0 | **+3** | 版本一致，HEAD 有未发版内容 |
| waf | 0.4.3 | 0.4.3 | v0.4.3 | 0 | 一致 |

### 5.1 「发了版但没入索引」/「入索引但资产 404」抽查

- **发版未入索引：0 条**（24 仓 `info.json.version` 全部命中索引，逐个比对得出，不是抽样）。
- **索引资产 404 抽查（3 条，只抽可疑）**：

| 仓@版本 | 命令 | HTTP | content-length | 索引 size_bytes | 判定 |
| --- | --- | --- | --- | --- | --- |
| process@0.3.0 | `curl -sI -L .../v0.3.0/process-0.3.0.tar.gz` | **200** | 1468449 | 1468449 | 一致 |
| container@0.5.2 | 同上 | **200** | 1529718 | 1529718 | 一致 |
| waf@0.4.3 | 同上 | **200** | 2933388 | 2933388 | 一致 |

> 未做 24×N 全量 curl（任务明确要求只抽可疑）。**索引 sha256 与 tag 干净树 `make dist` 的逐字比对本次未做**——属 task-92 的已交付项（`dist-index-consistency.md`），但该文件未入库，见 B3。

## 6. 未确认项（查不到就说查不到）

| 项 | 缺什么证据 | 备注 |
| --- | --- | --- |
| **task-107 的实际交付** | 卡片不存在，只有 task-122 正文的间接引用 | 无法确认它是被删除、被合并还是从未建卡 |
| **kore 工作树 8 个未提交改动的归属** | 无 agent 署名、无 commit | 需 `git log -p` 逐文件比对才能定人；本次只做只读清单，不判定 |
| **`ssl` 仓 `70cd7cc` 验证报告的自述「未验证项挂账」具体是哪几项** | 未读该报告原文（时间窗） | 若 `ssl.https.enforce` 有未验证分支，属功能风险，非交付丢失 |
| **task-2 声称的「kore main push origin+gitee」当时是否执行** | push 无本地记录（只有 reflog / 远端回执） | `task-193` 的存在反证当时积压未推，但未取远端回执 |
| **索引 24 条 sha256 与各 tag 干净树 dist 的逐条一致性** | 需 24 次 `git archive | make dist` | 本次按「只抽可疑」执行，未全跑 |

## 7. 过程性发现（不属丢工作，但影响后续对账可信度）

1. **owner 大量记为 `lead`**：task-12/14~31/114 等多张实现类卡的 owner 是 lead，而 lead 的角色定义是「只编排不落地」。G-09（implementer ≠ verifier）在这批卡上无法成立——自派、自做、自结账。
2. **台账覆盖不足**：187 张卡 vs 26 行 DISPATCH。G-23 要求「任何派发必须写入 DISPATCH」，当前缺口约 86%。
3. **卡片状态与仓库状态脱钩**：6 张 `pending` + 3 张 `in_progress` 中，**至少 6 张的实际工作已在 main**。板子现在是「回忆」而不是「事实」。
4. **证据文件默认不入库**：`.agents/verify/` 下大量 md/截图停留在 untracked。G-07 要求证据可复核，未入库即不可复核。

## 8. 建议动作（按优先级，均需另行派发）

| 优先级 | 动作 | 理由 |
| --- | --- | --- |
| P0 | 清理 kore 工作树 8 个未提交修改（逐文件判归属：补提交或回滚） | 归属不明的改动是下一次并发冲突与「G-12 混入」的直接源头（本日已有 `fbfa2f3` 前科） |
| P0 | 11 份 md + ~150 张截图一次性 `docs(verify)` 入库 | 否则今日所有 G-28 / 验证工作的可复核性为零 |
| P1 | 结掉 task-170/171/196/197/169/162 六张假僵尸卡 | 板上状态失真会持续误导后续派发 |
| P1 | task-198 半成品二选一（收尾提交 / 回滚） | 悬空未提交代码风险最高 |
| P1 | 给 BOARD §9 四条残留（通道 socket / docker.go hint / verify_file 命名 / 降权后 root 复验）各立一张卡 | 目前只存在于段落文字，无人认领 |
| P2 | 5 个 HEAD 领先 tag 的仓在下一次发版前显式 bump | 防「同版本两个 sha」 |
| P2 | 重建 task-107 卡（ssh-guard 真机写路径），或明确写「v1.0 不做，仅 suggest」 | 消除无主需求 |

---

**对账结论一句话**：今天**没有大面积「派了没人干」**——187 张卡里 178 张标 completed，且插件仓版本与索引 24/24 一致；真正丢的是 **①证据未入库（11 md + ~150 截图）②kore 工作树 8 个归属不明的未提交改动 ③6 张已完成却仍挂 pending/in_progress 的假僵尸卡 ④BOARD §9 四条无主残留**。**板上 `completed` 不能当交付证明，只有 commit/tag/资产/入库证据能。**
