# .agents · 交接规范（Handoff）

> 状态: active · 归属: scribe · 更新: 2026-11-24 · 里程碑: M0–M5

任何人或 AI 在本仓库中断后接手（换模型、换会话、换人、隔天回来），只读仓库文件就必须回答四问：
**要做什么、怎么干、干到哪了、为什么这么定**。这份规范定义这四问分别由哪些文件回答，以及
"什么才算落过文件"。

### 0.0 本轮 R6+R7 交付快照（2026-11-24 12:45）

> 本节记录 R6（12 路）+ R7（4 路 + 1 独立 verifier）两批并行交付的收口状态，供只读本文件的人接手。
> 事实口径：commit / sha / 版本全部照任务卡抄录。~~所有 commit 本地已提交、未 push；tag / release 未建。~~
> **2026-11-24 更新：用户已授权，统一发布已完成——7 仓代码 + 5 个 annotated tag 已 push origin / github / gitee 三端，
> GitHub release 5/5 已建、断链 5/5 修复，独立 verifier `r7-relverify` PASS，详见 §0.0.5。
> 仅 Gitea(origin) / Gitee release 因 token 缺失未建（§0.0.3 第 5 条）。**
> 上述"未 push / 未建"为 12:45 快照当时的状态，删划线保留作历史，不再代表当前事实。
> 下方 §0（10:20 快照）及更早内容为历史证据，保留不动。本轮写域只有本文件。

#### 0.0.1 本批总览

- **规模**：R6 12 路 + R7 4 路 + 1 独立 verifier（`r7-shots-verify`）全部收口。
- **目标**：把"简陋"往成熟产品推进，三条主线——**并发竞态修复**（旁路锁 / 唯一临时名 / O_EXCL / errno 人话）、
  **三个用户可见 UI 组件**（onboarding / theme / shortcuts + 主壳接线 + G-28 双端截图）、**发版链重签**（dns 发版 + 第 52 把索引重签）。
- **收口边界**：代码与本地提交已完成；~~远端 push / tag / release 全部挂账待用户授权（见 0.0.3）。~~
  **2026-11-24 已授权并完成统一发布：push / tag 零失败、GitHub release 5/5 已建 + 断链 5/5 修复（见 §0.0.5）；
  仅 Gitea / Gitee release 因缺 token 挂账（见 0.0.3 第 5 条）。**

#### 0.0.2 成果清单（按类别，每条带 commit）

**A. 并发 / 竞态修复 5 项**

| 项 | commit | 版本 / 状态 |
| --- | --- | --- |
| app-deploy 快照同秒占名 | `303fe3a` | v0.3.3 |
| logs 导出 O_EXCL | `221e064` | v0.5.4 |
| site 锁内定向回滚 | `f95325b` | 发版因 ADR-0052 在途，停在自洽点（未 bump/dist） |
| dns 旁路 flock + 唯一名 | `f32b3d9` | 发版 `e2324e9`（v0.5.2） |
| file + backup errno 人话 | `326e803` / `c31fd32` | file v0.3.5 / backup v0.5.1 |

**B. UI 组件 3 项 + 接线 + 截图**

| 项 | commit | 说明 |
| --- | --- | --- |
| onboarding 组件 | `fc05b18` | 用户可见组件 |
| theme 组件 | `14ab8e5` | 用户可见组件 |
| shortcuts 组件 | `f5dc584` | 用户可见组件 |
| 主壳接线 | `e135820` | 三组件接入主壳 |
| G-28 双端截图 | `2c89b60` | PC + 手机双端 |
| 截图 md5 校准 | `6f085ba` | 独立 verifier `r7-shots-verify` **PASS 5/5** |
| R8 G-28 截图批次1 | `873409c` | 4 场景 × 双端 8 张（PC 1440×900 + 手机 390×844）+ 自评三问，`file`/md5 实测全过（`r8-ui-shots-batch1.md`） |
| R8 G-28 截图批次2 | `204be96` | 4 场景 × 双端 8 张（PC 1440×900 + 手机 390×844）+ 自评三问，`file`/md5 实测全过（`r8-ui-shots-batch2.md`） |

**C. 审计与事故 4 项**

| 项 | commit | 说明 |
| --- | --- | --- |
| 24 仓竞态审计报告 | `434bb47` | 主报告 |
| dns 口径修订 | `3493b87` | 审计报告 dns 口径修订 |
| rotate 反证 | `390c9fa` | 审计报告 rotate 反证 |
| 提交事故独立核查裁决(B) | — | 独立核查结论 B（核查结论，无独立代码 commit） |
| history 修补 | `12cc45a` | 临时索引补回 filewrite 三文件 |
| site 跨 agent 写域冲突自救 | — | 写域冲突自救（无独立代码 commit） |

**D. 发版链**

- **dns 发版** `e2324e9`：v0.5.2 / sha `fce690…baa` / size `2973707`。
- **第 52 把索引重签** `a91dd01`：5 仓入索引——app-deploy 0.3.3、file 0.3.5、logs 0.5.4、backup 0.5.1、dns 0.5.2；
  `validate-index` 正例 exit 0 + 篡改反例 exit 1；公钥 `3e461a07` 无需轮换。
- ~~**所有 commit 均本地未 push。**~~（12:45 快照状态）
  **2026-11-24 统一发布已完成：7 仓代码 + 5 个 annotated tag 已 push origin / github / gitee 三端，
  peeled sha 逐端一致（详见 §0.0.5）。**

#### 0.0.3 挂账（未闭环，按证据，供下一轮）

1. ~~**发布授权（最优先）**：本批 6+ 插件仓 + 索引仓全部本地 commit、未 push、tag/release 未建；
   索引 `download_url` 在 release 落地前用户点下载会 404。push/tag/release 是远端不可逆操作，
   按用户常设纪律需**用户明确授权**。dns tag `v0.5.2` **必须显式钉 `e2324e9`（不钉 HEAD）**。
   本轮 lead 已向用户抛出该决策，**待用户回复**。~~
   **→ 已闭环（2026-11-24）**：用户已明确授权，统一发布全部落地——push + tag 三端零失败零 WARN、
   GitHub release 5/5 已建 + 断链 5/5 修复、独立 verifier `r7-relverify` PASS。
   事实与证据见 **§0.0.5 统一发布执行结果（2026-11-24）**（dns tag 已显式钉 `e2324e9^{}`，非 HEAD）。
2. **索引 DRIFT（r14-docaudit 复核收口）——仅剩 site 一处**：
   - ~~`db-mysql` repo=0.5.2 vs 索引=0.4.1 / `ssl` repo=0.7.1 vs 索引=0.6.0~~
     → **DRIFT 已消**：索引仓 `37a0f6d`（第 53 把重签，`[agent:r8-resign]`）已收录 db-mysql 0.5.2 +
     ssl 0.7.1，两仓 repo 与索引一致。
   - `site` repo=0.8.1 vs 索引=0.4.4：外部 ADR-0052 vhost-write 在途、带半成品，索引仓刻意保持 0.4.4 未误收；
     工作区仍 `MM apply.go`（argv / writes_host 未收敛）。**唯一剩余 DRIFT，待 ADR-0052 收敛后单独成批入索引。**
3. **发版缺口**：site 回滚修复未 bump/dist（`info.json` 属外部 ADR-0052 写域，r6-site 一个字节未碰）。
   【历史快照，保留】~~多仓历史遗留未跟踪发版证据文件（非本轮产物、未提交，去留未定）。~~
   → **已闭环（2026-11-24，裁决 B，r13-reevidence）**：`RELEASE-EVIDENCE.md` 归属——多仓 `.gitignore` 追加
   忽略规则（主仓 `05b0fcf`），本地证据文件**保留不删、不入库**；三选项否决依据落 `.agents/LOG/DECISIONS.md:152`
   （`42ca098`），共 **23 仓落地**。
4. **提交事故留痕**：`434bb47` + `fc05b18` 两次 add→commit 两步卷入 filewrite 三文件暂存态，
   `12cc45a` 临时索引补回（`434bb47`/`fc05b18` 仍是 HEAD 祖先、**历史未改写**）；
   根因是共享工作区两步 commit 竞态。纪律：一律 **pathspec 一步到位**或 **GIT_INDEX_FILE 临时索引**。
5. **Gitea(origin) / Gitee release 未建（human gate，需用户提供凭据；已从 P0 降为中优先级）**：
   2026-11-24 用户已授权发布、两端代码 + tag 均已 push，**但 release 未建**——
   token env（`GITEA_TOKEN` / `GITEE_TOKEN` 等）全部 UNSET、`gh` 仅登录 github.com、
   无 `gitea` / `gitee` CLI、`gitee-release-prune.sh --dry-run` 报 `GITEE_TOKEN` 未设置 EXIT=1。
   **未硬造 token、未读凭据明文**（G-30）。待用户提供 `GITEA_TOKEN` / `GITEE_TOKEN` 后：
   ①补建两端 release 挂 dist 资产；②跑 Gitee prune `--dry-run`（**只留最新 5**，
   GitHub 无对应 release 的版本永不删，例外逐条登记在脚本 `PRUNE_EXCEPTIONS`）。
   证据与细节见 §0.0.5 第 4 条。

 6. **主壳内存超 G-03 硬红线——用户裁决延至上线前优化，非 P0（2026-11-24 用户明确决策）**：
    告警「严重 / 主壳内存超红线 / ×25 次 / 14:15:33」：**当前实测 17.6 MiB > G-03 硬红线 16.0 MiB**。
    **用户裁决：不用这么严格，最后产品上线再优化就行 → 当前不严格处理、延至产品上线前优化、
    不阻塞本轮功能推进**（原话见本节，属用户明确的优先级决策；**下一个人不要误判为 P0 救火**）。
    诚实边界：**未做归因分析、未做内存采样、未做优化、未重启服务**——本条只做判断留痕（G-23），
    不触碰运行态与代码。复审条件：**产品上线前必须回归 G-03 16.0 MiB 硬红线**（`make budget-check`
    / `make mem` 实测达标后方可上线）。裁决台账见 `.agents/LOG/DECISIONS.md`。
 7. ~~**`web/terminal.js` 无主在途实现（原 owner 待确认）**~~ **→ 已收敛（2026-11-24，commit `a7409cf`）**：
    【历史快照，保留】r8-terminalui 开工自检发现该文件有他人**未提交**的在途实现，约 **417 insertions / 84 deletions**
    ——VT 引擎重写（备用屏 / 256 色 / 光标定位、复制、全屏、F1–F12 / Alt / Ctrl 键位、软键盘、2000 行回看），
    其中含**字号调节半成品**（`S.fs` / `applyFont` / `A−A+`，**无 localStorage 持久化**），**多标签未做**。
    近期 `git log` 找不到对应提交，归属为前序 agent 未提交实现、原 owner 待确认。
    **【最终态】已由 `a7409cf`（`[agent:r8-terminalui] feat(web/terminal): 终端页增量支持多标签与字号持久化`）
    收敛：+640/−192，用 GIT_INDEX_FILE 临时索引只提自己 hunk、commit message 注明吸收来源（文件 / 行 /
    原 owner），多标签 + 字号 localStorage 持久化已落地；`git status --short web/terminal.js` 干净，
    **无主在途已消除**（§0.0.6 第 3/5 项同步更新）。
 8. **i18n 结构性现状（r8-i18nui 自检证据推翻 R8-5 任务卡前提，不必派迁移卡）**：
    **骨架完整**——真源码 `web/i18n/en-US.js`（任务卡写的 `i18n-en-US.js` 是 dist 名）；`en-US` 与 `zh-CN`
    各 **68 key**、双向 `comm` 差集空（无合法缺项）。**但页面视图未接 `tr()`**——`sites` / `files` / `db` /
    `ssl` / `backups` 五个高频视图 `tr()` 调用全 **0**，中文硬编码分别 **447 / 513 / 589 / 335 / 357** 处
    （合计 2000+），页面根本没接 i18n，此时加 key 反而让回退链露键名。`frontend-check` 卡的是
    `i18n.js` + `zh-CN` 的 gzip（2922 / 3072），`en-US` 懒加载不进首屏。
    **定性**：这是 **ADR-0021 承认的阶段性取舍、不构成 G-11 违规**；页面内部文案迁移需**另立卡**，
    且必须**同时改 `zh-CN` + `en-US` + 视图 `tr()`**（会撞 helpui 的 `shell.js` / progressui 的 `backups.js`
    在途），**不在本轮范围**。详细证据 r8-i18nui 落 `.agents/verify/i18n-structure-finding.md`（引用路径，
    以该文件落地版为准）。
 9. **i18n 决策更新（2026-11-24，用户新指令覆盖第 8 条旧定性）**：用户明确「i18n 要做，但是只做本地化」
    —— 第 8 条「另立卡 / 不在本轮范围」的定性作废。**本轮改为**：用现有 `tr()` 语言包机制把高频页面文案
    真正翻成英文并生效，**不建 / 不改 i18n 框架**（守 G-11 / ADR-0021），**只做本地化**。由 r8-i18nui 执行，
    写域 `web/i18n/en-US.js`（真源码）+ 2–3 个高频视图样板，避开在途写域；**硬约束**：`zh-CN` 首屏 gzip
    增量 ≤3072（余量仅 150 字节）、中文态零裸键、英文态文案真生效。**第 8 条的结构发现证据保留有效**，
    本条只覆盖其「不在本轮范围」的处置定性（决策演进留痕，原文不删改）。
    **决策已补录 `DECISIONS.md:148`（commit `25462fe`，`[agent:r9-decision]`）——G-23 留痕闭环。**

 10. **在途三文件（r9-docssync 发现）——已收敛闭环（commit `321c34d`，r14-docaudit 复核）**：
     - `web/monitor-cards.js`（G-32 图表构件）——已 tracked 入库。
     - `.agents/verify/db-runtime-architecture-audit.md`（验收报告）——已 tracked 入库。
     - `docs/DECISIONS/0050-db-and-runtime-aggregation.md`（ADR-0050 accepted）——已 tracked 入库。
     三文件已由 `321c34d`（`[agent:r10-a1close]`）收敛提交；实测 `git ls-files` 三者齐备、
     `git status --short` 三者干净（详见 §0.0.7「A1 收敛」）。
     【历史快照，保留】~~当时三项均为未提交产物，注「待定」；本轮 scribe 写域只含 HANDOFF.md，不代填完成。~~

#### 0.0.4 下一轮建议（≤5 条，按优先级，每条含可执行动作 + 验收）

| # | 优先级 | 可执行动作 | 验收 |
| --- | --- | --- | --- |
| ~~①~~ | ~~P0~~ **已闭环** | ~~用户授权后统一 push/tag/release，dns tag `v0.5.2` 显式钉 `e2324e9`~~ → **已完成（2026-11-24）**，详见 §0.0.5 | 三端 push/tag 齐备、GitHub release 5/5、断链 5/5 修复，独立 verifier `r7-relverify` PASS；Gitea / Gitee release 待凭据（0.0.3 第 5 条） |
| ② | ~~P1~~ **部分闭环** | ~~三处 DRIFT~~ → db-mysql / ssl 已由索引仓 `37a0f6d`（第 53 把重签）收录、DRIFT 已消；仅剩 site 0.8.1 一处（外部 ADR-0052 在途） | 两仓 repo 与索引一致（已验证）；site 索引保持 0.4.4 未误收，待 ADR-0052 收敛后单独成批 |
| ③ | P1 | site 回滚修复发版（待 ADR-0052 写域释放，工作区仍 `MM apply.go`） | 写域释放后 bump + dist + 入索引，dist sha 与索引一致 |
| ④ | ~~P2~~ **已闭环（42ca098）** | `RELEASE-EVIDENCE.md` 归属裁决 → 裁决 B（加 `.gitignore` 忽略、本地证据保留不入库），主仓 `05b0fcf` + 台账 `42ca098`，23 仓落地 | 已验证：`.gitignore` 含忽略规则、DECISIONS.md:152 载三选项否决依据 |
| ⑤ | P2 | 主实例 8787 生产态抽查（G-29）：主实例已 R10 重建（PID `1753674` / exe sha `9d9fe444…`，见 §0.0.7）；登录态复核仍 BLOCKED（无管理员口令） | `curl -s localhost:8787/api/v1/system/info` 的 `paths.index_dir` 正确、商店版本 == 索引版本、三组件生产态可见；登录态项待口令交付 |

#### 0.0.5 统一发布执行结果（2026-11-24）

> 用户已明确授权统一发布（2026-11-24）。本节照各执行 owner 交付报告 + 独立 verifier PASS 抄录，均已回读验收。
> 事实口径：commit / tag / sha / HTTP 状态全部来自 r7-push / r7-release / r7-relverify 交付报告，不臆造。

**1. 发布授权已完成**：用户 2026-11-24 明确授权统一发布；§0.0.3 第 1 条 P0 挂账闭环。

**2. push + tag 全部完成、零失败零 WARN（r7-push）**：

| 仓 | 代码 push（origin/github/gitee 三端） | tag |
| --- | --- | --- |
| kore 主仓 | 已 push 三端 | 本批无版本 bump、未打 tag，只 push 代码 |
| kore-plugins 索引仓 | 已 push 三端 | 本批无版本 bump、未打 tag，只 push 代码 |
| kore-plugin-app-deploy | 已 push 三端 | `v0.3.3` → peeled `303fe3af` |
| kore-plugin-file | 已 push 三端 | `v0.3.5` → peeled `326e803b` |
| kore-plugin-logs | 已 push 三端 | `v0.5.4` → peeled `221e064c` |
| kore-plugin-backup | 已 push 三端 | `v0.5.1` → peeled `c31fd324` |
| kore-plugin-dns | 已 push 三端 | `v0.5.2` → peeled `e2324e9c`（**显式钉 `e2324e9`，非 HEAD**） |

- 7 仓代码 + 5 个 annotated tag 已 push origin / github / gitee 三端，**零失败零 WARN**；
  peeled sha 逐端一致（上表）。主仓与索引仓本批无版本 bump、未打 tag，只 push 代码。

**3. GitHub release 5/5 已建 + 断链 5/5 修复（r7-release；独立 verifier `r7-relverify` PASS）**：

| 插件仓 | 版本 | 索引 `download_url` 校验 |
| --- | --- | --- |
| app-deploy | v0.3.3 | curl HTTP=200 · sha256 `3253c1a7…` 逐字匹配 |
| file | v0.3.5 | curl HTTP=200 · sha256 `db8388f0…` 逐字匹配 |
| logs | v0.5.4 | curl HTTP=200 · sha256 `34301a77…` 逐字匹配 |
| backup | v0.5.1 | curl HTTP=200 · sha256 `bc202ac6…` 逐字匹配 |
| dns | v0.5.2 | curl HTTP=200 · sha256 `fce69085…` 逐字匹配 |

- 5 个插件仓 GitHub release 挂 dist 资产；索引 `download_url` 逐个 curl HTTP=200 + sha256 逐字匹配，
  **断链 5/5 修复**，商店下载已可用（原 §0.0.3 "download_url 会 404" 已消除）。

**4. Gitea(origin) / Gitee release 未建（human gate，仍挂账，见 §0.0.3 第 5 条）**：
token env（`GITEA_TOKEN` / `GITEE_TOKEN` 等）全 UNSET、`gh` 仅登录 github.com、
无 `gitea` / `gitee` CLI、`gitee-release-prune.sh --dry-run` 报 `GITEE_TOKEN` 未设置 EXIT=1。
未硬造 token、未读凭据明文。待用户提供 `GITEA_TOKEN` / `GITEE_TOKEN` 后补建两端 release + 跑 Gitee
prune `--dry-run`（只留最新 5，GitHub 无对应 release 的版本永不删，例外在脚本 `PRUNE_EXCEPTIONS`）。

**5. 发布窗口纪律已守**：kore 主仓 2M+2?? 在途文件、5 插件仓 `?? RELEASE-EVIDENCE.md`
全程未 add / 未 commit / 未碰；**零文件改动**（写域仅本文件，push/release 未夹带任何在途或证据文件）。

#### 0.0.6 第 2 轮 R8 交付快照（2026-11-24 15:00）

> 本节记录第 2 轮 R8（运行态激活 + 商店态收口 + 8 张 UI 功能卡 + 本地化全链）的交付状态，供只读本文件的人接手。
> 事实口径：commit / sha / size / 版本号已用 `git log` / `git show` / 索引文件逐项核实（核实时间 2026-11-24 14:59）；
> 运行态细节（PID / 九条复核 / 版本）来自 r8-restart owner 交付报告与任务卡（本写域未新建证据文件，遵循"只写本文件"）。
> **本轮所有 commit 均为本地提交、未 push**（延续多提交少推送纪律）。下方 §0.0.1–§0.0.5 及更早内容为历史，保留不动。

**0. 总览——用户喊"简陋"的三层滞后**

第 2 轮针对用户"界面简陋"的反馈，定位并解决三层滞后：
- **运行态旧**：R6/R7 已把三个 UI 组件编进源码，但主实例 8787 一直是旧二进制（三组件从未真正编进运行镜像 / 资源 404）——本轮重建 + 重启激活（R8-0）。
- **商店态旧**：索引里 `db-mysql` / `ssl` 版本滞后（0.4.1 / 0.6.0），仓库里已是 0.5.2 / 0.7.1——本轮发版链收口 + 第 53 把重签入索引（R8-B1+B2）。
- **前端真缺口**：后端已有方法但前端没接（SSL 强制 HTTPS / 全局搜索 / 审计 CSV 等）——本轮 8 张 UI 功能卡逐一接线。
- **用户裁决（G-23 留痕）**：①内存红线 17.6 MiB > 16 MiB **延至上线前优化**、不阻塞本轮（§0.0.3 第 6 条 + DECISIONS）；②i18n **只做本地化、不做全量框架**，并按页面拆分推进（§0.0.3 第 9 条覆盖第 8 条旧定性）。

**1. 运行态生效（R8-0 / r8-restart）——已核实**

- `make build` + 重启主实例 8787：PID **636777 → 1332165**（R8-0 时点），version **0.1.1**。
- **【R8 时点快照，保留】三组件资源 404 → 200，九条运行态复核全 PASS**——此结论**仅在 13:58 构建时点成立**，
  后续 commit 后又滞后，完整时间线见下方「运行态时间线（r9-docssync 核查 + r9-restart 重建）」。
- 备份双保险：`/tmp` + `bin/` 冗余备份；**禁改历史**（无 amend/reset/rebase）。
- **G-29 声明：R8 本轮未改主配置 / state / ssl**（复核口径：`paths.index_dir` 指向 `kore-plugins/index`，商店版本 == 索引版本）。

 **运行态时间线（r9-docssync 核查 + r9-restart 重建——R9 时点快照（当前最终态见 §0.0.7，PID 1753674），根治「源码有 commit」错当「运行态已生效」）**：
 - **R8-0（13:58）**：三组件 404 → 200，九条复核全 PASS——但此时 dist 停在 **13:14**、二进制停在 **13:58**。
 - **滞后窗口（14:24 后）**：本轮 **15 个 UI / 本地化 commit**（`091c251` / `956ce99` / `a7409cf` /
   `ee1d606` / `64ae7d8` / `e3e13c0` / `300156e` 等）均在 13:58 构建之后落地，**未编入 13:58 构建**；
   主实例运行态特征 **0 命中**。
 - **R9 重建重启（15:18，r9-restart）**：`make build` 重建 `bin/kored`（sha256 `721a748d9d56b0ca…`，
   `stat` 15:18:46）+ 重启主实例 8787，新 **PID 1533701**（`ps` 实测存活），**15 commit 全部生效**。
 - **新增四项特征命中**：help **0→6** / ssl **0→2** / search **0→2** / 本地化 tr **0→26**（旧二进制全 0）。
 - 独立 verifier r9-runverify 复核 **VERDICT: PASS**：四项特征真 UI（help 0→6 / ssl 0→2 / search 0→2 / 本地化 tr 0→26 命中，逐条用命中行上下文排除注释假象）+ 新 PID 1533701 / exe sha==bin sha 721a748d… / version 0.1.1 / 三组件 200 / cgroup 合规 / auth 401 / validate-index exit 0，零 FAIL——15 commit 真正在用户面板生效，坐实。

**2. 商店态收口（R8-B1 + B2）——已核实（git log / 索引文件逐项比对）**

- `db-mysql` **0.5.2**（sha 前缀 `cc172d7f` = `cc172d7f7b51d2e79d1008f653c517a5dbac25416dfb2704b4694207fb6ec8c4`，size **1581024**）、
  `ssl` **0.7.1**（sha 前缀 `8c8c3acf` = `8c8c3acf4888586961daaddb34f86961ab4b9d5a071ae0dc0497cad2439428ec`，size **3177637**）。
- 发版链全绿：annotated tag 三端（origin/github/gitee）push + GitHub release + 资产可下载（curl 200 / sha 逐字匹配，核到索引 `download_url`）。
- **第 53 把重签**：索引仓 `kore-plugins` commit **`37a0f6d`**（`[agent:r8-resign] index: 第53把重签，收录 db-mysql 0.5.2 + ssl 0.7.1 + 重签 + 重建 market`），
  改 `index/plugins.json` + `.sig` + `versions.lock.json` + `market/plugins.js` + 6 个 preset；公钥 **`3e461a07` 不变**（未轮换）。
- `site` **0.8.1 外部 ADR-0052 在途仍排除**，索引保持 **0.4.4**（未误收）。
- 登录态字面复核 **BLOCKED**（无管理员口令，human gate）；隔离实例实测**商店随磁盘索引走、无需再重启**。

**3. 八张 UI 功能卡（全部本地 commit，未 push）**

| 卡 | commit | 说明 |
| --- | --- | --- |
| SSL 强制 HTTPS 接线 | `23cca2c` | status/enforce/unenforce 三方法接线 |
| 全局搜索真实数据源 | `0c7fa93` / `9ffbf18` | 初版接入站点 + 文件；后升级为**跨 11 源命令面板**（数据库/容器/进程/端口/日志 + 原站点/文件/页面/插件/商店/操作），逐源降级、Ctrl/Cmd+K 前缀限定 |
| DNS 去黑话 | `a2f811c` | 用户文案去内部术语、补「怎么办」提示 |
| 审计 CSV | `cd11a7b` + `ea8d198` | CSV 导出（BOM + RFC4180）+ 空结果清除筛选下一步 |
| 帮助入口 + 404 | `091c251` | 顶栏帮助入口 + 未知路由友好 404 页 |
| 备份部署进度 | `f02e81d` | 长任务实时进度反馈 |
| 终端多标签 | `a7409cf` | 多标签 + 字号持久化；**已收敛（+640/−192）**：他人 ~420 行在途 VT 实现（备用屏/256 色/键位/回看）已由本卡吸收，commit message 注明来源、临时索引只提自己 hunk；`git status web/terminal.js` 干净、无主在途已消除 |

**4. 本地化全链（用户明确"i18n 要做，只做本地化"）**

- 三视图 key：**sites 30**（`956ce99`）/ **db 92**（`ee1d606`）/ **files 152**（`64ae7d8`），合计 **274 key**。
- key 清单：manifest commit **`e3e13c0`**（`.agents/verify/i18n-key-manifest.md`，**304 行**，已核实）。
- en-US 收口：commit **`300156e`**（`[agent:r8-i18n-pack] feat(i18n): en-US 收口写入三视图 274 条英译`），
  语言包 **342 key = 68 原有 + 274 新增**；三态真框架切换 **36/36 PASS**；首屏 **75940/2922 未涨**；**zh-CN 零改动**。
- 效果：用户切英文后 sites/db/files 三页真显示英文（不建框架、守 G-11 / ADR-0021）。

**5. 挂账与用户裁决（§0.0.3 已有正文，此处仅索引，不重复展开）**

| # | 挂账 | 索引 |
| --- | --- | --- |
| ① | 内存 17.6 MiB > 16 MiB，用户裁决延至上线前优化 | §0.0.3 第 6 条 + `.agents/LOG/DECISIONS.md` |
| ② | `web/terminal.js` ~420 行无主在途 VT 实现 → **已由 `a7409cf` 收敛、无主在途已消除** | §0.0.3 第 7 条（最终态） |
| ③ | i18n 决策更新（只做本地化，覆盖 #8 旧定性） | §0.0.3 第 9 条 |
| ④ | Gitea/Gitee release 缺 token（human gate；GitHub `download_url` 不受影响） | §0.0.3 第 5 条 + §0.0.5 第 4 条 |
| ⑤ | 登录态商店字面值复核待口令（BLOCKED，不触发重启） | 本卡第 2 项 |
| ⑥ | site 0.8.1 外部 ADR-0052 在途 | 本卡第 2 项 + §0.0.3 第 2/3 条 |

**6. G-28 双端截图**

- ~~两批（r8-shots1 / r8-shots2）计划拍 **16 张** PC + 手机截图 + 产品定位自评。~~
- **状态：两批已交付并回读 PASS**——`873409c`（batch1）/ `204be96`（batch2），
  **16 张双端截图**（8×PC 1440×900 + 8×手机 390×844）+ 产品定位自评三问齐备；
  `file` 实测宽高全合规、md5 全异（8/8 distinct）；自评原文与已证明/未证明两栏见
  `.agents/verify/r8-ui-shots-batch1.md` / `r8-ui-shots-batch2.md`（截图 owner 已另落报告，本卡只索引不代填）。

**7. 下一轮建议（≤5 条，按优先级）**

| # | 优先级 | 可执行动作 | 验收 |
| --- | --- | --- | --- |
| ① | ~~P1~~ **已闭环（第6轮 2026-11-24）** | r11-push 一批推完 origin/github/gitee 三端，三端 main 全对齐 `80f6c48` | 三端 `git ls-remote` 实测 main 全为 `80f6c48b447a34ea77cd76bbf9fefba92df8c68d`；本地 HEAD 已前进至 `42ca098`、`git branch -vv` 显示领先三端 4 笔（af88838/247044f/05b0fcf/42ca098，攒批未 push）；第 6 轮 push 已闭环结论不变 |
| ② | ~~P1~~ **已闭环（同上两笔 commit）** | G-28 截图收口验收：`873409c` / `204be96` 两批已交付并回读 PASS | 16 张双端截图 + 自评三问齐备，`file`/`identify` 校验宽高、md5 全异——全部命中 |
| ③ | P2 | site 外部 ADR-0052 收敛后单独成批入索引 | 索引 site 版本与仓库一致，重签 + 公钥不变 |
| ④ | ~~P2~~ **已闭环（42ca098）** | `RELEASE-EVIDENCE.md` 归属裁决 → 裁决 B（加忽略、保留不入库），主仓 `05b0fcf` + 台账 `42ca098`，23 仓落地（见 §0.0.3 第 3 条） |
| ⑤ | ~~P3~~ **已闭环（第5轮最终态）** | R10 最终重建重启（r10-runverify 独立 PASS）：现运行 **PID `1753674`** / exe sha `9d9fe444eed83b1b714f9b75ecb5f9184550a1f6cae1cedc7a9cfcc60d26728e` / version 0.1.1；本批 11 卡成果（图表 / 白话 / 断点续传 / 改口令 / 本地化 850key）全部生效；改口令端点未登录 POST 实测 401（非 501） | `ps` 实测 PID 1753674 存活、`readlink /proc/1753674/exe` → `bin/kored`、`sha256sum` == 上列 sha；r10-runverify 独立 PASS |

### 0.0.7 第 6/7 轮交付快照（2026-11-24）

> 本节一次同步交接文件落后于真实状态的收口事实，供只读本文件的人接手。
> 事实口径：commit / sha / 远端 main / 运行态 PID 全部用 `git log` / `git ls-remote` / `ps` / `sha256sum` 实测复核（复核时间 2026-11-24 16:2x）；
> §0.0.1–§0.0.6 及更早内容为历史，全部保留不动。本轮写域只有本文件。

**1. 第 6 轮——攒批 push 三端对齐（已闭环）**：r11-push 一批推完 origin / github / gitee 三端，
三端 `main` 全为 `80f6c48b447a34ea77cd76bbf9fefba92df8c68d`，零失败零 WARN，未重复推 gitea(ssh)。
**push 后本地继续攒批未推**（R17 终验复核：`git rev-list --count origin/main..HEAD` = **13**，本地 HEAD=`bcaac10`、**领先 13** 笔
（含 R15 三能力卡 + R16 布局修复 + 截图/文档），远端 origin / github / gitee `main` 仍停在 `80f6c48`）——
延续「多提交少推送」纪律，第 6 轮 push 已闭环结论不变。（原「4 笔」为第 6 轮时点快照，R12–R16 又增 9 笔。）
（实测：`git ls-remote origin|github|gitee refs/heads/main` 三行同 sha；详见 §0.0.6「下一轮建议①」已闭环标注。）

**2. 第 5 轮——R10 最终态（运行态 + 成果）**：
- **8 张功能卡 commit**：图表 `0c4d1f9`(进程)/`b685155`(日志)、白话 `699cf4f`/`2b68649`/`d33eb6b`、
  断点续传 `06811ae`、改口令交互 `c8dcb9e` + 后端端点 `80f6c48`、i18n 接线 `e2cf84c`。
- **本地化**：四高频视图 key 清单 `8485281`；en-US 两批 `b1bce5e`(redis/search 269) + `fc83056`(sshguard/runtimes 239)，
  合计 **508 key 新增、en-US 850 key 收口**。
- **G-28 截图两批**：`9f8665c` + `e9227e6`（各 4 场景双端 + 自评）。
- **文档收尾**：`49fd736`(ADR-0050 台账 + 审计 §3 证据) + `fd3d244`(白话化缺口表)。
- **A1 收敛**：`321c34d`（三文件在途挂账：monitor-cards G-32 图表 / ADR-0050 / 审计文档）。
- **运行态最终 PID `1944697`**：exe sha = bin sha = `5afa5b20084007cd97b494870bb14f7b8e0c2dd24d32ef19101970fade07a66c`、
  version 0.1.1（R16 布局修复后 16:58 重建，新能力已编入运行态）；r17-finalverify 终验复核 `ps -p 1944697` 存活、
  `readlink /proc/1944697/exe` → `bin/kored`、`sha256sum` exe==bin==上列 sha、`./bin/kored version`=0.1.1；
  改口令端点未登录 POST 实测 **401（非 501）**。（原 PID 1753674 / sha 9d9fe444… 为 R10 时点快照。）

**3. 剩余挂账（三项 human gate，非本轮可闭环）**：
- ① Gitea / Gitee release 缺 token（`GITEA_TOKEN` / `GITEE_TOKEN` 未设，见 §0.0.3 第 5 条 + §0.0.5 第 4 条）；
- ② 管理员登录口令未交付，登录态商店字面复核 BLOCKED（见 §0.0.6「挂账⑤」）；
- ③ site 0.8.x 外部 ADR-0052 在途，索引保持 0.4.4 未误收（见 §0.0.3 第 2/3 条 + §0.0.6「挂账⑥」）。

### 0.0.8 R17 端到端终验快照（2026-11-24，r17-finalverify）

> 本节记录 r17-finalverify 两路终验（全导航静态走查 + `make check` 全门禁）结论，供接手人一眼看到「功能达标 / 交付未闭环」的分界。
> 事实口径：运行态 PID/sha/领先数由本文件写入时 `ps` / `sha256sum` / `git rev-list` 实测复核；其余为终验原始结论，未逐项在本轮重跑。
> §0.0.1–§0.0.7 及更早内容为历史，全部保留不动。本轮写域只有本文件。

1. **全导航静态走查**：未发现空白页 / 假入口 / 占位文案。真机逐项点击因**无管理员口令未做**，如实标注为未验证（不记 PASS）。
2. **门禁**：`make check` **21/21 段全绿、零真 FAIL**；全仓 `-race` 17 包 + 嵌套 module `pkg/pluginapi` 2 包**零 DATA RACE**；交叉编译五目标 exit 0。
3. **体积**：前端首屏 **76182 / 307200** B（≤300 KiB 预算内）；i18n **2922 / 3072** key。
4. **运行态**：PID **1944697** / sha **5afa5b20…**（exe==bin，16:58 重建）；能力特征全在——850 key / `backup.presets` / `process.ports` / `container.images` / 改口令 401。
5. **资源**：VmRSS ≈ **17.8 MiB**（用户裁决延至上线前处理、**不判失败**）；CPU 0 ms、出站 0。
6. **仓库卫生**：`git worktree list` 仅主工作树；`git status --short` 干净。
7. **结论**：**功能 / 代码层面达标、可交付**；交付闭环仍剩 **3 项 human gate**——① push 13 笔攒批待授权；② Gitea / Gitee release token；③ 管理员口令。三项均非 agent 可自行闭环，不提前宣称已解决。

### 0.0.9 第 11 轮交付快照（2026-11-24 17:58，R18 审计 + R19 十卡 + 运行态重建 + G-28 双端截图）

> 本节记录第 11 轮四件事的最终态：R18 全仓能力普查、R19 十张能力卡的本地提交、主实例运行态重建、G-28 双端截图两批次，供接手人一眼看到「已落地 / 仍挂账」的分界。
> 事实口径：**commit sha 用 `git show --no-patch`、运行态 PID 用 `ps`、exe sha 用 `sha256sum`、领先数用 `git rev-list --left-right --count`、远端 HEAD 用 `git ls-remote` 实测复核**（2026-11-24 17:58）；R18 审计计数与截图 `file` / md5 结论为各轮原始证据，本轮文档同步未重跑，来源见文内。
> §0.0.1–§0.0.8 及更早内容为历史，全部保留不动。本轮写域只有本文件。

**1. R18 全仓能力普查（后端有方法、前端零调用）**

- 6 路并行审计覆盖剩余 **19 个插件仓**（前轮已审仓不重复），方法论统一：动态拼接还原调用链 + backend dispatch 真有方法才算缺口 + L3/占位不建卡。
- 找出 **20+「后端有方法、前端零调用」真缺口**；**反向缺口（前端有入口、后端无方法）全 0**。
- 这批普查是 R19 十卡的选题来源；逐仓计数属审计原始结论，本轮未静态复核。

**2. R19 十张能力卡（全部本地 commit、未 push）**

- 判断型 2 张：
  - **dns 写路径 = 不改**——ADR-0051 已否决 reload、TSIG/root 前置未成熟，属有意取舍，不建卡。
  - **ssl 内置 ACME = 补齐**——ADR-0020 与实现漂移，commit `3107f36`（前端接入 status / issue / auto 默认路线）。
- 修复型 8 张：
  - PG 6 写方法：`db-l2.js` `0758d0e`（建库/删库/用户/授权/改密 6 方法）+ 保留字修复 `84c24f1`（角色列表别名 `user` → `role_name`）+ 入口放行 `db.js` `43c3d88`（新建数据库/用户与授权）。
  - 防火墙一键开关 + SSH 锁自己 fail-closed：`e19acbe`。
  - Python venv / pip 四方法：`8a7fc1c`（venv.create/list + pip.install/list）。
  - 日志清理 / 保留策略 / 占用统计：`c10edfb`。
  - 从模板部署：`appdeploy.js` `80a7221`（补齐部署与移除入口）。
  - 站点 PHP-FPM 三方法：`1abf853`（补全伪静态断链）。
- 以上 11 个 sha（含判断型 1 个）本轮逐一 `git show --no-patch` 核实存在、subject 与用途一致。

**3. 运行态（主实例重建，G-29 共享资产不改配置）**

- 重建重启后 PID **2128919**（`ps -p 2128919` 实测在跑，`kored serve --config .kore-local.yaml`）；exe sha **2700d8656695566965fea843889e4e86bc7b54915d11696aa2bdb14a5c26cbd5**（`sha256sum bin/kored` 实测，exe == bin）。旧 PID **1944697** / sha **5afa5b20…** 已退（§0.0.8 终态，本轮 `ps` 确认不再运行）。
- 本批 8 项特征运行态全命中、前轮不回退：**850 key / 改口令 401 / help-trigger 6**；改口令端点 **401 非 501**（鉴权生效、非占位）。特征结论由 lead 终验回读，本轮文档同步未重跑真机点击。
- 远端三端 `main` 实测同 sha `80f6c48`（origin / github / gitee）；本地 `git rev-list --left-right --count origin/main...HEAD` = **0 25**（本地领先 25 笔，均本地提交、未 push）。`git worktree list` 仅主工作树。

**4. G-28 双端截图（两批次共 16 张真实浏览器截图）**

- 批次1 commit `9f22475`：`pg-write` / `firewall-switch` / `python-venv` / `log-clean` 四场景 × 双端 8 张；批次2 commit `e8bd36d`：`ssl-acme` / `app-template` / `site-php` / `plugins-health` 四场景 × 双端 8 张。
- `file` 实测尺寸合规（PC 1440×900 / 手机 390×844）、`md5sum` 各批 8 张全异（distinct=8）、降级态如实标注（防火墙非 root 只读降级、SSL 无域名「账户未注册」、日志无源空态）。证据报告：`.agents/verify/r19-ui-shots-batch1.md` / `r19-ui-shots-batch2.md`。
- 批次2 曾遇 store install / enable 返回 **CSRF 401**，读源码补 `X-Kore-CSRF` 头（值取自 `kore_csrf` cookie）自愈，未隐瞒、未伪造成功态。
- 批次1 耗时约 **13 分钟**（为拍真实已连接态真起 PostgreSQL 16 容器做 recon），全量交付未打折。全程走 `git archive` + 独立构建 + 隔离实例（配置/state/run/log 落 `/tmp`），**主实例 8787 零改动**（G-29），G-30 `secret-check` 0 FAIL。

**5. 下一轮挂账（按优先级，非 agent 可自行闭环，不提前宣称已解决）**

| # | 事项 | 状态 / 依据 |
| --- | --- | --- |
| ① | 攒批 push | 本地领先 **25** 笔（实测），远端三端仍停 `80f6c48`；按「多提交少推送」攒一批推，需授权 |
| ② | Gitea / Gitee release token | `GITEA_TOKEN` / `GITEE_TOKEN` 未设，human gate（§0.0.3 第 5 条 + §0.0.5 第 4 条） |
| ③ | 管理员登录口令 | 未交付，登录态真机复核 BLOCKED（§0.0.6 挂账⑤） |
| ④ | site 0.8.1 外部 ADR-0052 在途 | 索引保持 0.4.4 未误收（§0.0.3 第 2/3 条） |
| ⑤ | 内存 17.8 MiB | 用户裁决延至上线前优化，**不判失败**（§0.0.8 第 5 条） |

### 0.0.10 战略转向与第 12 轮快照（2026-11-24 18:12，r20 E2E + r21-strategy）

> 本节记录用户明确战略转向、四方向依赖路线、第 12 轮 E2E 结论与下一轮启动建议，供接手人不再重复「零散补洞」。事实口径：**索引版本 / PARITY 结论 / deploy 与 system 报告数字本轮用 `grep` + `read` 复核**；r21-strategy 路线与 content 双版本口径为会话产出、未单独落报告文件，来源如实标注。§0.0.1–§0.0.9 及更早内容为历史，全部保留不动。本轮写域只有本文件。

**1. 用户战略转向决策（2026-11-24，G-23 判断留痕）**

- **决策**：选定四大方向（全选）——①黄金用户旅程（从装上到 `curl 200` 端到端）②产品定位与差异化（零侵占薄壳，可演示可度量）③生产可用体系（功能都有 → 敢上生产）④插件生态与扩展（SDK + 市场 + 第三方可扩展）。
- **被否决选项**：继续「前端没接小洞」式零散补卡（R18/R19 那种逐仓找缺口、逐个接线）。
- **否决依据**：用户原话批评前 11 轮「一个小破问题一直在改，大方向一点没动」——补洞只堵点、不动方向，ROI 低且形不成可演示的端到端闭环。
- **执行口径（从此生效）**：停止零散补卡，围绕四方向拆任务；每条任务卡必须回答「落在哪个方向、推进哪条依赖链」。

**2. 四方向路线决策（r21-strategy 产出；会话产出，未单独落报告文件）**

- **依赖顺序**：③生产可用（地基，无依赖）→ ①黄金旅程（主路径，依赖 ③）→ ②差异化 + ④生态（放大器，待 ①③ 有可演示底座后再放大）。
- **关键发现（四条，本轮已复核或标注来源）**：
  - **黄金旅程最后一步「真实 `curl 200`」从未取证**：e2e-deploy 报告只返回 `access_url: http://127.0.0.1:18090/`，没有对该 URL 真发 `curl` 并记 200 + body（来源 `.agents/verify/e2e-deploy-write.md` §2 第 3a 行 + §6「未证明」）。
  - **site 索引 0.4.4 缺 PHP 三方法**：`strings` 命中 0；`setPHP` / `getPHP` / `unsetPHP` 在 site 仓 `65e3293`（v0.6.0）才引入，索引强制匹配版本致调用 400 / `E_NOTFOUND`（索引 `0.4.4` 本轮 `grep plugins.json` 复核确认；site 侧来源为 r20-e2e-content 横向交流，见 deploy 报告 §6）。
  - **内存 17.8 MiB 超红线是差异化软肋**：主壳空载红线 16 MiB（G-03 / ADR-0016），17.8 已超；用户裁决**延至上线前**优化，不判失败（§0.0.8 第 5 条 / §0.0.9 挂账⑤）。
  - **`docs/PARITY-GAP.md`「达标 0」结论已过期**：文档头写「更新于 HEAD `e2043da`、里程碑 M4」，当前 HEAD `bc9b237`；其「22 能力域达标数 0 / v1.0 gate 九类取证完整 0 类」（原文 :107–111）**不可对外引用**，须重算后再用（本轮 `grep` 复核）。

**3. 第 12 轮 E2E 结果（r20 系列）**

| 轨道 | 结论 | 关键证据 |
| --- | --- | --- |
| deploy（真机，报告已落盘） | **全绿，零 FAIL** | 隔离实例 18884 + Docker v29.7.2；`templates` `count=4`（nginx-static / wordpress / redis / postgres）→ `deploy {template:"nginx-static"}` 真起容器 `f3a94fd2329bf…`（DeployResult `deployed:true`）→ `list` 出现 1 → `remove {name,confirm:true}` `removed:true` → `list` 归零；不存在名字回 404 `E_NOTFOUND`；清理三重确认（API remove + trap + 手工复核），容器/卷/实例/脚本零残留；8787 主实例零改动。证据 `.agents/verify/e2e-deploy-write.md` |
| content（双版本口径；会话产出，未单独落报告） | site 0.4.4 缺三方法坐实；0.6.0 首次实现版真跑三方法 | 索引 `site@0.4.4` dist 不含 `setPHP` / `getPHP` / `unsetPHP`（`strings` 命中 0），索引强制匹配致 400；site 仓 `65e3293`（v0.6.0）三方法首次实现并真跑通。来源：r20-e2e-content 会话回报 + deploy 报告 §6 横向标注；本轮无独立报告文件，不计「已验真机」 |
| system（真机，报告已落盘） | **无 FAIL**：PASS×11 / 降级态正确×2 / 环境阻塞×1 | 防火墙 `status` 非 root 降级 `available=false` + `E_NEED_ROOT` + hint；`enable` / `disable` 的 `dry_run=true` 真返 argv 且不执行，`dry_run=false` 非 root 回 403 `E_NEED_ROOT`；真开关需 root，本机 uid1000 + `no_new_privs` 不可测（环境阻塞，未碰宿主防火墙）。日志 `sources → usage → retention.get/set 往返 → clean dry_run → confirm 真清（移回收区非 rm）→ clean.restore 撤销 → 文件原位恢复` 全链路真跑通；缺 CSRF 401、缺 confirm 400 安全门实测。证据 `.agents/verify/e2e-system-write.md` |
| db（r20-e2edb） | **进行中**（未回报 / 无报告落盘） | 本轮 `git status --short` 仅见 deploy / system 两份新增报告，db 轨道尚无回报；不提前宣称通过 |

**4. 下一轮启动建议（按路线 ③→① 的依赖）**

- **并行启动两项，均不需用户凭据、主实例零改动（G-29）**：
  - ①**黄金旅程五步链真实 `curl 200` E2E**：补齐黄金旅程缺失的最后一步——对 deploy 返回的 `access_url` 真发 `curl`，取证 HTTP 200 + body 非空 + 结束后清理；走隔离实例，8787 只读。
  - ④**SDK 八条命令自检（零依赖）**：`pkg/pluginapi` 公开 SDK 的八条命令自证，纯本地、不连主实例、不需凭据。
- **两条写域不相交（G-08）**：①落 `.agents/verify/e2e-golden-curl.md`，④落 `.agents/verify/sdk-selfcheck.md`，互不改对方文件；主实例运行态一律不碰。

### 0.0.11 R24 交付快照（2026-11-24，r24-docsync 归档）

> 本节按用户三点诉求 + 两项用户反馈收敛本轮 R24 落地事实，所有 commit 号经 `git log` 逐条复核（5 个插件契约在各自插件仓，非本仓）。§0.0.1–§0.0.10 及更早历史全部保留不动；本轮写域仅本文件与根 `AGENTS.md`（G-32 判据数同步）。

**1. 用户三点诉求与落地**

- **①告警中心手机布局**：标题竖排 / 按钮挤压修复 `dd449ac`（`[agent:r24-alertlayout]`）；PC + 手机双端截图自证（`.agents/verify/screenshots/alerts-layout-fixed-{desktop,mobile}-1124.png`），报告 `.agents/verify/alerts-layout-fix.md`。
- **②「商店每个软件都要有设置页」**：入口两卡——商店已装卡片 `a8e8e49`（`store.js`，含 G-28 双端截图）；已装插件列表每行 `e03178a` + 截图验收 `1d1dff9`（`app.js`）。两处**复用现成 config-panel**，不另造面板；无契约时友好降级空态 `7a65bfa` + 截图验收 `318e9c9`（`web/config-panel`，空态 / 失败态文案）。
- **③5 插件补 `config.get/set` 契约**（均在各自插件仓，显式 schema + 热生效 + dist 两打 sha 一致 + 版本 bump）：cron `e2bf184` / ssl `e46010b` / firewall `381a8ed` / container `f5dd1a6` / monitor `e6eaa09`。

**2. 图表 tip + 下标**（用户反馈「tip 被遮挡」+「没有下标」）

- `3d206fa`（`[agent:r24-charttip]`）：全站盘点 8 类图，真风险仅拓扑 1 处已修——tip 挂 `document.body` + `position:fixed` + z-index 80 + 手机 tap 面板；监控 / 进程视图补 X 轴时间刻度与 Y 轴数值刻度（带单位）。同步在 [FRONTEND](../docs/FRONTEND.md) §13 落**第 12 条判据**（条文 `:373`「十二条细则」、判据行 `:388`），根 `AGENTS.md` G-32 已由「十一条」同步为「十二条」。证据 `.agents/verify/r24-chart-tip.md`。

**3. 顶栏状态图标化**（用户早要求「图标 + 颜色 + tip」）

- `c85f3ef`（`[agent:r24-topstatus]`）：健康检查 / 系统信息改心电脉冲 / 信息图标 + 四态色（**真实数据映射**，非占位）+ tip 挂 body、z-index 90；PC + 手机双端截图，报告 `.agents/verify/r24-top-status.md`。G-03 首屏 **79797 ≤ 307200** 字节（余量 227403，报告 `:29/:70`）。

**4. A3 文案回归闭环**

- monitor `e6eaa09` 自修 `process_sort` 的 `invalid` 文案；全量 usability 静态复核 **FAIL=0**（`.agents/verify/usability-audit-2026-11-24.md` `:205`，lead 只读复核确认）。

**5. 挂账（按证据，勿当已完成）**

- 本轮均为**本地 commit、未 push**；5 插件契约的 `dist` 重打产物未入索引，需攒批裁决后再同步 `versions.lock.json`。
- `push` 仍待用户明确授权（本地多提交、少推送口径）；Gitea / Gitee token 与管理员口令仍为 **human gate**，本轮未触碰、未落明文（G-30）。

## 0. 当前交接快照（2026-11-24 10:20）

> 本节是「今天真实状态」的增量快照，§1–§7 的规范与卡片模板不变。
> 每条附命令 / `file:line` / commit；查不到的写「未确认」，不写推测。
> 上一版快照为 2026-11-24 04:10（`994ba74`）；本版按 10:09 的 HEAD **`3c53395`** 重新核实全节。
> 本版写域只有本文件；`make check` 整条 aggregate 用**当前工作树**实跑：**exit 0（19/19）**，日志
> `/tmp/make-check-handoff3.log`。口径说明：HEAD 的 `make check` 是 **18 段**（`git show HEAD:Makefile`
> 第 392 行「聚合门禁（18 段）」）；工作树有他人在途的第 19 段「全仓 `-race`」（`Makefile` + 未跟踪的
> `scripts/race-full-check.sh`，`AGENTS.md` 已同步为 19 段），**本轮 1–18 段全部通过**，第 19 段也通过
> （17 包 / 53s / 零 DATA RACE）。

### A. 四问当前答案

1. **要做什么**：M5 收口前的 v1.0 Linux GA 准备——22 能力域由 24 个插件仓提供，内核保持薄壳调度。
   今天（2026-11-24）截至 10:09 共 **83** 个提交（`git log --since="2026-11-24 00:00" --oneline | wc -l` → `83`；
   11-23 全天 `359`），04:10 之后增量 **18** 个（`--since="2026-11-24 04:10"`），当前 HEAD **`3c53395`**
   （`git log -1 --format="%h %ad %s"` → 2026-11-24 10:09:13）。04:10 之后集中在四条线：
   **门禁补强**（`make check` 18 段 + 在途第 19 段全仓 `-race`；G-20 判据①②真执行；`store-check` 两项补强）、
   **深度等级收口**（15 个 production 判据①②全满足，`scripts/boundary-pending.txt` 清空）、
   **并发丢数据 6 处真 bug 修复**（site / logs×2 / file / app-deploy / cmd/kored）、
   **Gitee release prune 全量执行**（26 仓 dry-run / 真删 11 仓 / echo 例外跳过）。
2. **怎么干 / 事实约束**（八条硬边界，动手前先对齐）：
   - **面板必须有登录页**：kore 自有 Web 登录——`POST /api/v1/auth/login`，凭据 = `auth.admin_password_hash`，
     **单管理员、无用户名、非 PAM / 非系统账号**。依据 `docs/DECISIONS/0043-login-gate-vs-passwordless-ops.md`
     头部 **`状态: accepted`**；实现 `a68c4b1`；登录视图 `web/app.js:347-430`（`input.type='password'`，`:367`）。
   - **「免密」只指登录之后的操作**（含 root 特权动作）不再要口令，**不是「不登录」**。
     ADR-0043 §0 用户原话：「面板必须要有登录页面，我是说操作必须免密，也就是 root 权限」。
   - **运行期不得出现本机系统账号密码**（`sudo` / `polkit` / `askpass` 一律禁止）；**只有「壳子安装」一次允许
     sudo**，此后替换自身二进制、重启 / 删除自身 unit 都不再提权。依据 `docs/DECISIONS/0042-privilege-without-prompt.md`
     头部 **`状态: accepted`**；`93d63c7`（`kored upgrade` 非 root 直接 exit 6，不弹口令）。
   - **面板以系统级 root 服务运行**（ADR-0042），特权动作不经 polkit 判定（`e1980a3`，polkit 降为降级路径）。
     但本机**当前主实例是非 root 降级形态**（uid 1000 + `kored-local.service`，见 B.5）——
     不得把降级形态当成等价形态；ADR-0042 的落地缺口见 B.6-2。
   - **插件 UI = 主壳懒加载视图**（ADR-0040 `accepted`，2026-11-23 增补裁决取代裁决40）；**独立 origin iframe +
     postMessage 桥未实现、v1.0 前不补**。`web/app.js:1128-1352` 仍留旧 iframe 渲染代码（`frame.src` 指向
     不存在的 `/plugin-assets/<id>@<ver>/index.html`），服务端无该路由（`grep -rn "plugin-assets" internal/` 仅
     `httpapi/middleware.go:103` 一处注释）。插件 UI 承载面是 `web/<id>.js` 懒加载视图。
   - **`kore_csrf` 非 HttpOnly**（双提交要求前端可读）：`internal/core/httpapi/handlers_auth.go:104`、
     `csrf_local.go:64`（`HttpOnly: false, SameSite=Strict, Path=/`），回归断言 `csrf_login_test.go:74`
     （`kore_session` 必须 HttpOnly、`kore_csrf` 必须非 HttpOnly）。
   - **插件升级后置动作走 `post_upgrade` 声明**：`info.json` 可选字段 `post_upgrade`，值为完整方法名
     `<id>.<method>`（域必须等于本插件 id）；内核**只校验形态与自身域**，把字符串**原样交 `bus.Call`**
     （15s 上限），**不知道具体业务**。`desired=enabled` 的升级重载成功后立即执行；`disabled` 升级只落
     `plugin_state.post_upgrade_pending`，下次 `Enable` 补跑；失败 WARN + 告警、不回滚安装。依据
     `docs/DECISIONS/0048-post-upgrade-hook.md:1`（`状态: accepted`）、`docs/PLUGIN-PROTOCOL.md:75,420`；
     实现 `internal/core/registry/validate.go:169-186` + `cmd/kored/serve_runtime.go:339`（`postUpgradeTimeout`
     见 `:37`，15s）。**离线 CLI 升级同样落 `post_upgrade_pending`**（`520420c`）：`kored install --package`
     在 serve 停着、不经过 `reloadOne` 时，由安装器在落库时写标记（值 = 新版本），下次 serve 启动
     `consumePostUpgrade` 补跑一次并清空；禁用态插件留到下次启用。首次安装 / 同版本重装 / 未声明钩子
     都不写。测试 `cmd/kored/serve_offline_upgrade_test.go:18`（改前 FAIL）。
   - **`-race` 是硬判据，不再是"可选优化"**：`make check` 第 18 段只对 `./tests/boundary/` 加 `-race`
     （`c6dbce3`，`scripts/race-gate-check.sh`），本轮实测「有边界用例 **15** 仓 · `-race` 真跑通过 **15** 仓」。
     但 kore 本仓没有 `tests/boundary/` → 本仓 `make race` 恒 `[SKIP]`，等于**内核代码在 race detector 面零覆盖**；
     所以工作树在途的第 19 段用 `GOWORK=off CGO_ENABLED=1 go test -race -count=1 ./...` 补位（`scripts/race-full-check.sh`，
     实测 17 包 / 53s / 零 DATA RACE）。判据来源是 `bd3ac83`：`cmd/kored` 升级链路两处**真实数据竞争**
     （结果审计先于终态发布 / launch 返回锁外快照）在普通 `go test ./...` 下全绿、断言全过，**只有 `-race` 能抓**——
     没有这段，同类竞争下次照样合入。
3. **干到哪了**：见 B 节（发版索引 / 插件能力 / 主壳 / 今日门禁与能力 / 运行态 / 挂账）。
4. **为什么这么定**：
   - **登录门与免密分层** —— ADR-0043（accepted）：ADR-0041 把「操作免密」实现成「本机通道免登录」，
     真机后果是面板没有登录页、未登录也能操作全部管理 API；ADR-0041 现为 `superseded-in-part`（`9b5d4dc`）。
   - **root 提权零交互** —— ADR-0042（accepted）：kored 以系统级 root 服务运行，运行期不做授权判定。
   - **插件 UI 不补分发链** —— ADR-0040（accepted）：24 仓 dist 里 `web/` 命中 0、补链约 3–5 人日，v1.0 前不补。
   - **升级后置动作走声明、不走协议保留方法** —— ADR-0048（accepted）：A 方案（协议保留
     `kore.post_upgrade`、升级时全量唤醒插件）否决，B 方案（cron 由 lazy 改 resident 永久占槽）否决，
     采 C（清单可选字段 + 内核按声明 `bus.Call`）。内核只读声明、不写业务，守住 G-01；`post_upgrade`
     属加字段演进（可选、有默认值），不升 `kore.plugin.v2`、不升主版本。**离线 CLI 也落标记**的理由：
     安装器是唯一同时知道「旧版本→新版本」与「新清单声明了钩子」的地方；不写标记，serve 停着升级后
     crontab 会一直跑旧版本，直到用户手工打开计划页。
   - **`-race` 升硬判据** —— 普通 `go test` 绿不代表没有竞争：`bd3ac83` 修的两处竞争在普通测试下
     全绿、断言全过，只有 race detector 抓得到。第 18 段守插件仓并发边界面（15 仓真跑），
     第 19 段（在途）守内核本仓全仓；两段都不允许「缺 cgo 就跳过」。
   - **15 个 production 判据①②全满足** —— 判据不是「声明了就算」：`f7e9cb3` 补齐 G-20 两条判据、
     `f6ef74c` 把判据① 从目录静态核对改为 `go test` 真跑、`d6670d3` 清空 `boundary-pending.txt`
     让 15 条全部转硬判据。实测「判据①②全满足 15 条 · 判据① 真跑 PASS 15 / 不通过 0」。
   - **Gitee release 全量 prune** —— 机制 2026-11-23 就建好，一直没执行；本轮 26 仓 `--dry-run` 后
     真删 11 仓各 1 个版本（护栏①②每仓 ✓），`echo v0.1.0` 因 GitHub 无对应 release 按例外保留。
     证据 `.agents/verify/gitee-prune-2026-11-24.md`（`8011a53`）。
   - **8 条 `depth_level` 判 `basic`、不迁就索引** —— 判据是 `docs/PLUGIN-CATALOG.md:90` 升级要求
     **①边界用例 + ②故障注入两条都满足**；8 仓故障注入 8/8 PASS，但均缺 `tests/boundary/`（①不满足），
     所以仓库 `production` 是过度声明、索引 `basic` 才对。裁决 `.agents/verify/depth-level-decision.md`
     （`957a26d`），8 仓发版 + 第 51 把重签（`b12a6f8`），清单清零 → **ADR-0045 §4.4 的 M5 阻断项已解除**。
   - **cron 唤醒路径撤回承诺** —— ADR-0046（`proposed`，决策 B2）：不新增 `kored invoke` 免登录通道，
     收敛到内核 scheduler，文档按 `d696723` 改正。
   - **方法名字符集放宽** —— ADR-0047（accepted）：`methodActionPattern` 接受下划线（`verify_file` 不重命名），
     连字符仍不接受。

### B. 今天的实际状态

#### B.1 发版与索引

唯一事实源：`../kore-plugins/index/plugins.json`（实测 **24** 条）；索引仓 HEAD **`339efa7`**
「monitor 0.3.1 入索引并重签（pluginapi v0.1.1→v0.1.3，dist 86fed8f2）」
（`git -C ../kore-plugins log -1 --format="%h %ad %s"`，2026-11-24 09:11:38）。第 51 把证据
`.agents/verify/resign-51.md`（`b12a6f8`）；公钥未变，第 16 段双端一致 `3e461a07…`。
**索引落后 3 个插件仓**：site **0.4.4**（`dd1f565`）/ file **0.3.3**（`40d3feb`）/ app-deploy **0.3.2**（`463f14f`）
已 bump 并打出 dist，但 `plugins.json` / `versions.lock.json` 仍停在上一个版本（逐仓比对 info.json.version
→ 3 条 DRIFT；`ls dist/` 已有新包）。**商店当前拿不到这三处并发修复** → 下一轮第 52 把重签。

| 插件 @ 索引版本 | 插件 @ 索引版本 |
| --- | --- |
| echo **0.1.5** | site 0.4.3（仓 0.4.4 未收录） |
| file 0.3.2（仓 0.3.3 未收录） | ssl 0.6.0 |
| integrity **0.5.1** | cron **0.7.0** |
| ssh-guard 0.3.1 | monitor **0.3.1** |
| logs **0.5.2** | dns **0.4.2** |
| runtime-php 0.2.2 | runtime-node **0.2.5** |
| runtime-python **0.3.2** | db-mysql 0.4.1 |
| db-postgres **0.3.4** | redis 0.6.0 |
| backup 0.4.2 | firewall 0.2.6 |
| waf **0.4.5** | container **0.5.5** |
| app-deploy 0.3.1（仓 0.3.2 未收录） | terminal 0.2.1 |
| process 0.3.0 | discover 0.3.1 |

索引 `depth_level`：`basic` **9** 条（8 条裁决仓 `echo` / `integrity` / `dns` / `runtime-node` /
`runtime-python` / `db-postgres` / `waf` / `container` + `ssh-guard`），`production` **15** 条
（`PLUGIN-CATALOG` §6.1 的 12 产品级 + `terminal` / `process` / `discover`）；15 条今晚全部满足 G-20 判据①②。

#### B.2 插件能力（以各仓 `CHANGELOG.md` 为准）

| 能力 | 版本 | 证据（仓 / 行） |
| --- | --- | --- |
| **`site` 清单读-改-写跨进程锁**（8 实例并发建站不再丢站点；锁固定在旁路 `.lock`，读者靠 rename 原子可见性） | **0.4.4** | `kore-plugin-site/CHANGELOG.md:5`；`dd1f565` |
| **`logs` retention / download 并发串行化 + 唯一临时名**（4 来源并发只落 2/4 → 4/4；`os.CreateTemp` + fsync + rename） | **0.5.2** | `kore-plugin-logs/CHANGELOG.md:8`；`abe74b7` |
| **`file` rename / move / copy TOCTOU 收口**（`renameat2(RENAME_NOREPLACE)`，并发抢同一目标恰好一胜一 `E_CONFLICT`） | **0.3.3** | `kore-plugin-file/CHANGELOG.md:3`；`40d3feb` |
| **`app-deploy` deployments / jobs 旁路 flock**（8 并发 deploy 从 1 条恢复到恰好 8 条） | **0.3.2** | `kore-plugin-app-deploy/CHANGELOG.md:3`；`463f14f` |
| **`kored` 升级链路两处真实竞争**（结果审计先于终态发布 / launch 返回锁内快照，`-race` 抓出） | 内核 | `cmd/kored/`；`bd3ac83` |
| `container.exec`（固定 argv、非 root 默认、超时夹取 30s、输出截断 256 KiB；`docker.sock` 无权访问由 `E_UNSUPPORTED` 改 `E_NEED_ROOT`） | 0.5.5 | `kore-plugin-container/CHANGELOG.md:3-8` |
| `process.history/trend/watchdog.suggest`（60 点环形缓冲、插件内零 ticker） | 0.3.0 | `kore-plugin-process/CHANGELOG.md:12` |
| `ssh-guard.suggest`（只读 `system:read`，`dry_run` 恒 true；`depth_level` 按事实为 basic） | 0.3.1 | `kore-plugin-ssh-guard/CHANGELOG.md:5-9` |
| `runtime-python` venv / pip（4 方法 + kill 后重试）；`depth_level` 回落 basic | 0.3.2 | `kore-plugin-runtime-python/CHANGELOG.md:7` |
| `redis.rename` / `move` / `copy`（默认 nx 防覆盖，>8 MiB 需 confirm） | 0.6.0 | `kore-plugin-redis/CHANGELOG.md:5` |
| `ssl.https.enforce`（期望状态下发 + 审计） | 0.6.0 | `kore-plugin-ssl/CHANGELOG.md:12` |
| `waf` 规则 CRUD（nft 1.1.x 写后回读失败三层兜底）；`depth_level` 回落 basic | 0.4.5 | `kore-plugin-waf/CHANGELOG.md:1-8` |
| `logs.retention.get/set`（`retention.json` 0600 原子写；补 `tests/fault/clean_test.go`） | 0.5.1 | `kore-plugin-logs/CHANGELOG.md:8-12` |
| `cron.templates` + **稳定二进制路径 `current/bin/<id>`** + `cron.migrate`（`system:admin`，幂等）+ 启动期存量迁移 + `cron.list.binary_status` | **0.7.0** | `kore-plugin-cron/CHANGELOG.md:3-9`；`6efaaa3` |
| `integrity` 结构化变更 + `severity`；`depth_level` 回落 basic | 0.5.1 | `kore-plugin-integrity/CHANGELOG.md:13` |
| `app-deploy.upload/upgrade/jobs`（逐条目穿越护栏 + 暂存后 rename） | 0.3.1 | `kore-plugin-app-deploy/CHANGELOG.md:5` |
| `firewall.enable/disable`（走 ADR-0018 root-action，argv 固定） | 0.2.6 | `kore-plugin-firewall/CHANGELOG.md:7` |
| `backup.verify`（6 项 checks，只读 `system:read`） | 0.4.2 | `kore-plugin-backup/CHANGELOG.md:5` |
| `dns` 写路径（快照 → 原子 UPDATE → 直连校验 → journal，失败回滚）+ **`dns.reload` 按 `{zone?}` 下传（engine 不再当 zone）**；`depth_level` 回落 basic | **0.4.2** | `kore-plugin-dns/CHANGELOG.md:1-16`；`ee2f2ad` |
| 8 仓 `depth_level` 回落 basic（仅元数据 + 版本，无运行时行为变更） | echo 0.1.5 / integrity 0.5.1 / dns 0.4.2 / runtime-node 0.2.5 / runtime-python 0.3.2 / db-postgres 0.3.4 / waf 0.4.5 / container 0.5.5 | 各仓 `CHANGELOG.md` 头部；`.agents/verify/resign-51.md` |

#### B.3 主壳（口径分开写，勿混）

| 指标 | 值 | 命令 / 出处 |
| --- | --- | --- |
| `lazyView(` 调用点数 | **16** | `grep -c "lazyView('" web/shell.js` → `16` |
| `web/*.js` 文件数 | **34** | `ls web/*.js \| wc -l` → `34` |
| 导航项 | **24** | `web/shell.js` NAV_GROUPS 四组 id 合计（ops 5 + biz 5 + res 4 + platform 10） |
| `web/dist` 文件数 | **38** | `ls web/dist \| wc -l` → `38`（其中 `.js` 36 = 34 模块 + 2 语言包） |
| 首屏 gzip | **65,213 B / 307,200 B** | `bash scripts/frontend-check.sh` 口径；`make check` 第 10 段重写后 mtime 10:1x |
| i18n 增量 gzip | **2,909 B / 3,072 B** | 同上（余量 163 B，贴线） |

最新视图：服务发现 `discover`（代码 `0cd5dab`，G-28 双端截图 `caa582e`）。
**工作区不是干净的**：本轮开工时已有 11 项他人在途改动（`M AGENTS.md` / `M Makefile` / `M .agents/QUALITY-GATES.md` /
`M .github/workflows/ci.yml` / `M scripts/*.sh` / `?? scripts/race-full-check.sh` / `?? docs/RUNBOOK-INSTALL.md` 等），
本版**只写 `.agents/HANDOFF.md`**，提交只用精确路径一步到位，不碰他人改动。
**注意索引也可能是脏的**：10:21 实测 `git status` 里出现 `D  scripts/race-full-check.sh`（staged 删除）
与 `?? scripts/race-full-check.sh`（同名未跟踪）并存，`Makefile:482` 又确实在调它——这是他人临时索引的
中间态。**不要 `git add -A` / 裸 `git commit`**，只 `git commit -m … -- .agents/HANDOFF.md` 这种精确路径。

#### B.4 今天落地的门禁与能力（全部给 commit）

**B.4.1 今晚新增 / 强化门禁（7 条 + 1 条在途）**

| 门禁 | commit | 关键点 / 证据 |
| --- | --- | --- |
| **canonical-check 规则 2 改「值断言」** | `0679bf6` | `scripts/canonical-check.sh:114-174`：从「拦 `GOGC=200` 字面量」改成「从 ADR-0015 解析期望值、从代码常量解析实际值，两者必须相等」。实测 `规则2 运行时默认 GOGC=50 / GOMEMLIMIT=6 / GOMAXPROCS=8 == ADR-0015 规定值`；Makefile 契约行 `GOGC=50` / `GOMEMLIMIT=6MiB` 同源校验。旧规则拦不到「注释写 100、代码实为 50」——`:119` 有记录 |
| **第 17 段交叉编译扩到全仓 `go build ./...`** | `890a6f5`（段本身 `6bd09ee`） | `Makefile:106-127`：`make cross` 五目标**全仓** `go build ./...`（不只 `cmd/kored` 闭包）+ kored 五产物。实测「全仓五目标可编译 · 交叉产物 5 个 · 1669ms」；`cross-vet` 只做 `_test.go` 跨平台类型检查，是信息入口、不入第 17 段 |
| **第 18 段 race 门禁** | `c6dbce3` | `Makefile:479` + `scripts/race-gate-check.sh:20-95`：`-race` **只跑** `./tests/boundary/`，逐仓核对 Makefile `race` 目标 / check 独立段 / ci.yml 显式跑，再 `make race` 真跑。实测「有边界用例 **15** 仓 · `-race` 真跑通过 **15** 仓」，全绿 |
| **G-20 判据①② 两条都真执行** | `f7e9cb3`（补两条判据）+ `f6ef74c`（判据① 真跑） | `scripts/presets-check.sh:414-610`：判据② `tests/fault/` 硬判据（`:560-565`）；判据① `tests/boundary/` 目录/用例/并发/四类静态核对（`:567-581`）**之后 `GOWORK=off go test ./tests/boundary/ -count=1` 真跑**（`:503-532,583-592`）。实测「静态核对通过 15 仓 → go test PASS 15 / 不通过 0 · 累计 11.6s」 |
| **`store-check` 第 6 项 `DIST_SHA_DIFF` 缺件可见** | `4c516e6` + `ef59908`（修误带他人改动） | `scripts/store-check.sh:146-149,318-362,418`：守卫改判「索引可达 + 有本仓 id」，**不再以 dist/ 存在为前提**；索引当前版本本地无 dist → 逐条 `[SKIP] … 本地无 dist，未比对`，汇总分账「151 一致 / 0 缺件跳过 / 12 索引未收录跳过」。缺件不 WARN 不 FAIL（dist 是构建产物），但**不再静默**=「0 warn 不再同时代表全部一致和全部没查」 |
| **`store-check` 第 7 项 `README_VERSION_DRIFT` 扩到全文 + 行号** | `d9ffea7`（原行级 `af9e701`） | `scripts/store-check.sh:33-44,365-410`：README **全文逐行**扫所有 `dist/<id>-<ver>.tar.gz`（代码块 / 正文都算），带 `(line N)` 输出；只比 `<id> == info.json.id` 的引用，解析不出就 SKIP 不硬猜 |
| **`boundary-pending.txt` 已清空，15 个 production 全转硬判据** | `d6670d3`（增量清 5 条 `155c008`） | `scripts/boundary-pending.txt` 只剩注释（0 个 id）；`presets-check` 实测「production 声明核对 15 条 · 判据①②全满足 15 条」。清单外新增 production 缺判据即 FAIL |
| **（在途，未提交）第 19 段全仓 `-race`** | 未提交 | `scripts/race-full-check.sh` + `Makefile:482`：`GOWORK=off CGO_ENABLED=1 go test -race -count=1 ./...` 固定面必绿，缺 cgo 直接 FAIL 不降级。本轮实跑「17 个包 / 53s / 零 DATA RACE」；`AGENTS.md` / `QUALITY-GATES.md` 已同步 19 段，属他人写域 |

**B.4.2 关键能力与真 bug 修复（本轮新增 / 更新）**

| 能力 / 修复 | commit | 关键点 / 证据 |
| --- | --- | --- |
| **并发丢数据①：`site` manifest** | `dd1f565`（site 仓） | 清单 RMW 无互斥 → 8 实例并发建站只剩 1–2 条；create/delete 的「读清单→落 vhost→写回」整段进 flock 临界区，锁在旁路 `kore-site-manifest.json.lock`（清单 rename 后 inode 更替，锁挂清单会失效）。回归 `TestBoundaryConcurrencyManifestNoLostUpdate` |
| **并发丢数据②：`logs` retention** | `abe74b7`（logs 仓） | 固定临时名 `retention.json.tmp` 让 4 来源并发只落 2/4；state 目录级 flock（跨进程 5s）+ `os.CreateTemp` 唯一名 + fsync + rename。回归 `TestBoundaryConcurrentRetentionSet`（4/4） |
| **并发丢数据③：`logs` download** | `abe74b7`（同笔） | 导出落盘同样改唯一临时名（固定 `.tmp` 同类问题） |
| **并发丢数据④：`file` rename TOCTOU** | `40d3feb`（file 仓） | `overwrite=false` 的 Lstat 与 `os.Rename` 之间无原子性，171/300 轮复现「都成功、一方被静默覆盖」；落名改 `renameat2(RENAME_NOREPLACE)`，跨设备回退与 `copy` 同收口。0.3.2→0.3.3 |
| **并发丢数据⑤：`app-deploy` deployments/jobs** | `463f14f`（app-deploy 仓） | `deployments.json` / `artifact-jobs.json` RMW 加旁路 flock（同一把锁管两文件），8 并发 deploy 从 1 条恢复到 8 条；锁不包 `docker run`，同名并发锁内重读回 `E_CONFLICT` 并回滚容器 |
| **并发丢数据⑥：`cmd/kored` 升级 job** | `bd3ac83` | 两处真实竞争：结果审计先于终态发布 / launch 返回锁外快照；`-race` 抓出、普通 `go test` 全绿 |
| **`post_upgrade` 声明式后置动作** | `b71a900` | `info.json` 可选 `<id>.<method>`；内核只校验形态与自身域、字符串原样交 `bus.Call`（15s），不认识业务（ADR-0048）；`cmd/kored/serve_runtime.go` + `docs/DECISIONS/0048-post-upgrade-hook.md` |
| **禁用态升级的 `post_upgrade` 补跑** | `67d80c1` | `desired=disabled` 升级只落 `plugin_state.post_upgrade_pending`，下次 `Enable` 成功后补跑一次并清空（`cmd/kored/serve_daemon_actions.go`） |
| **installer 保留 `post_upgrade_pending`** | `a3dbdbb` | `plugin_state` 从整段覆盖改为读改写，保留未知字段，避免升级/重装时把待补跑标记抹掉（`internal/core/installer/record.go`） |
| **离线 CLI 升级落 `post_upgrade_pending`** | `520420c` | serve 停着 `kored install --package` 时安装器写标记；下次 serve 启动 `consumePostUpgrade` 补跑；首次安装/同版本重装/未声明不写；CLI 输出打印「待补跑」（`cmd/kored/serve_offline_upgrade_test.go:18`） |
| **bus 超时后迟到帧毒化下一次调用** | `8c50d21` | 超时后重同步迟到响应帧，避免下一次调用误报 `E_INVALID`；新增内部/外部两组测试（`internal/core/bus/call.go`） |
| **oneshot 超时后进程不回收、令牌不归还** | `1a326af` | 超时回收进程 + 归还串行令牌（`internal/core/supervisor/oneshot.go`；`bus/call.go` 同步） |
| **cron 钉死旧版本 / 升级后静默跑旧二进制** | `6efaaa3`（cron 仓） | 稳定路径 `current/bin/<id>` + `cron.migrate` + 启动期 `MigrateStaleBinaries` + `binary_status`（`kore-plugin-cron/internal/croncore/stablepath.go:207`、`main.go:53`） |
| **`dns.reload` 把 `engine` 当 `zone`** | `ee2f2ad`（dns 仓） | 按 `{zone?}` 契约下传，`{"engine":"bind9"}` 不再变成 `rndc reload bind9`；未声明字段（含 engine）→ `E_INVALID` + `detail.allowed=zone`（`kore-plugin-dns/internal/dnsop/call.go`） |
| **运行态激活 4 个内核修复** | `e746228` | `make build` + `systemctl --user restart kored-local`；新 pid `809422` 的 exe sha == 新 `bin/kored`（`6c4b503e…`），healthz 200 / 未登录 401 / `kore_csrf` 非 HttpOnly；证据 `.agents/verify/restart-activate.md` |
| **登录门恢复**（UDS / loopback 不再免登录） | `a68c4b1` | `withAuth` 删除本机通道跳过分支，`/api/v1/*` 一律会话校验；契约测试反向收紧 |
| **首启一次性口令** | `3aa7b5c` | 首启自动生成管理员口令：TTY 打印一次，非 TTY 只给 CLI 指引（不落盘明文） |
| **会话 7d + 滑动 + 30d 绝对** | `0cae448` / `72bb463` / `51dde8e` | `internal/core/auth/session.go:26-29`、`:92`/`:128`/`:166`、`:188` |
| **升级端点装配修复** | `db7cf31` | 补 4 个一行转发 + 编译期断言 `var _ httpapi.SelfUpdater = (*daemon)(nil)`（`cmd/kored/serve_upgrade.go:402`） |
| **`kored upgrade` 自升级 / 卸载免 sudo** | `93d63c7` | `--bin` 只收本地文件 + 必填 `--sha256`；原子替换；非 root exit 6；卸载先 disable/删 unit → userdel → purge → 删自身二进制 → 最后 `--no-block` 停自己 |
| **插件卸载 API** | `6142694` | `DELETE /api/v1/plugins/{id}`：停进程 + 删 dist + 移除记录 + 审计（fail-closed）；幂等 200 + `already_absent` |
| **CSRF 本机补发** | `d553cd1` | `withLocalCSRF`：仅 loopback/UDS + 幂等方法 + 无 `kore_csrf` 时下发；只发令牌不放行请求 |
| **`discover` 视图 / 商店卸载 UI** | `0cd5dab` + `caa582e` / `542f7ae` | 第 16 个懒加载视图；商店与已装插件页接 `DELETE`（二次确认 + 六种结果人话 + 降级） |
| **插件降权显式化 / 权限授予记录层 / 审计保留期清理** | `a514a90` / `2ccbf0c`+`310cc2d` / `8d09b58` | `supervisor/demote.go:20-36` 非 root 必给 `Reason`；`installer/grant.go` 记录 `granted_capabilities`；`scheduler/auditclean.go` 默认 90 天、单次 ≤1000 条 |
| **cron 稳定路径（内核侧）/ 方法名字符集放宽** | `cc1472f` / `512f1a2` | installer 维护 `current -> <version>` 相对链接（`installer/layout.go:17-22`）；`registry/validate.go:66` 与 `infocheck.go:56` 逐字一致，下划线合法、连字符非法 |

**WARN 现状（实跑快照；工作区正被他人并发修改，数字会变）**：10:19 的 19/19 实跑里
`docs-check: 5 pass / 1 warn`（3 份行数越界：`docs/PLUGIN-PROTOCOL.md:480` / `docs/RUNBOOK.md:557` /
`docs/SIGNING-KEY-SOP.md:88`）、`case-check: 27 pass / 1 warn`（4 个 `github.com/Microsoft/...` 历史 URL 的
owner 段大写）。之后复核时两处都曾降为 0 WARN（2 份登记豁免 / `case-check: 28 pass`），再跑
`docs/SECURITY.md:405` 又越界 1 份——**在途改动仍在动，WARN 数只能以当次实跑为准，不作判据**。

已闭环（旧挂账移除）：`docs/DECISIONS/0028-controlled-file-write.md` 头部为 `accepted`；
ADR-0041 为 `superseded-in-part`（`9b5d4dc`）；`web/.cache/` 已进 `.gitignore:13-15`；
**8 条 `depth_level` 待裁决清零**（`957a26d` + `b12a6f8`，原 B.6-4 已闭环移除）；
**Gitee「只保留最新 5 个」已执行**（`8011a53`，26 仓 dry-run / 11 仓真删 / echo 例外）；
**README 代码块版本号已纳入门禁**（`d9ffea7` 扩到全文 + 行号，原 B.6-8 移除）；
**cron 离线 CLI 迁移缺口已补**（`520420c`，原 B.6-6 移除）；**判据① 待裁决清单已清空**（`d6670d3`）。

#### B.5 运行态（只报告，不杀进程、不改主配置；10:20 复核，与 04:05 一致）

| 对象 | 事实 |
| --- | --- |
| 主实例 pid / 启动 | **`809422`**（未重启），`2026-11-24 03:34:03`，uid **1000（非 root）** |
| `/proc/809422/exe` | → `/home/pt/Work/GolandProjects/kore/bin/kored`（无 `(deleted)`），sha256 **`6c4b503ea6aa72a1af2e95617c85fd90e869fe57dd5fcc845633f760605e69ba`** |
| `bin/kored` | 同 sha **`6c4b503e…`**，**10,510,498 B**，mtime `2026-11-24 03:33` → 运行中与磁盘一致（SHA_MATCH=YES） |
| **运行镜像不含 `bd3ac83`** | `bin/kored` mtime 03:33 < 提交 10:00；`cmd/kored` 的升级竞争修复**只有源码与 `-race` 证据，没进运行态**。要用：`make build` + `systemctl --user restart kored-local`，重启后复核 exe sha |
| 运行身份 / cgroup | **uid 1000**；`user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service`（systemd `--user`） |
| `GET /-/healthz` | **200** `{"status":"ok"}` |
| 未登录 `GET /api/v1/system/info` | **401** `{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}` → 登录门生效 |
| `strings /proc/809422/exe \| grep -c post_upgrade` | **4**（`post_upgrade` 代码在镜像内，离线 CLI 补跑那笔 04:17 也不在） |
| `GET /` / `kore_csrf` | **200** 登录页（`<title>Kore · 控制台</title>` + 「登录」）；`kore_csrf` 非 HttpOnly（`.agents/verify/restart-activate.md` §4） |
| `paths.index_dir` / 商店版本 | **未确认**：被登录门挡住（无管理员口令），本轮未为取证改主配置 |
| systemd 系统 unit | **未安装**：`systemctl status kore` → `Unit kore.service could not be found.`；`/etc/systemd/system/kore.service` 不存在 |
| 插件系统用户 | `getent passwd \| grep -c "^kore-"` → **0** |

**结论**：主实例仍是 03:33 的二进制（含 4 个内核修复与 `post_upgrade`），**今晚 04:17 之后的
`520420c` / `bd3ac83` 都不在运行镜像里**；形态仍是 **uid 1000 的 `kored-local.service` 降级**。
系统级 root 部署与插件降权仍只有代码，见 B.6-1/2/3。

#### B.6 已知挂账（未闭环，按证据；已修项已从清单移除）

1. **升级 / 卸载的真实 systemd 重启链路未实测**：`93d63c7` 的替换 → `systemctl --no-block restart` →
   serve 入口 finalize `pending`→`success` 只有代码 + 单测；本机非 root，`kored upgrade` 直接 `exit 6`，
   验不到正路径。`.agents/verify/kore-upgrade-drill.md` 是**隔离实例换二进制**演练，不是命令 + 系统 unit 重启。
2. **系统级 root 服务未真装**：ADR-0042 `accepted`，但 `systemctl status kore` → Unit not found、
   `/etc/systemd/system/kore.service` 不存在，主实例实际是 `user.slice/.../kored-local.service` + uid 1000。
   **accepted ≠ 已部署**。
3. **插件未真正降权**：`kore-*` 用户数 **0**；非 root 内核下 `Demotion.Enabled=false` 并给 `Reason`
   （`internal/core/supervisor/demote.go:20-36`），插件进程与内核同 uid → OS 层隔离为零。
4. **`tasks` bucket 保留期未实现（承诺已撤销）**：`docs/DATA-MODEL.md:166`、`:327` 明确「预留 bucket，
   当前无写入方 → 不定义保留窗口（不承诺天数）」。审计保留期已落地，**只剩 tasks**。
5. **无 UA / IP 指纹绑定；CSRF 纯双提交**：`grep -rn "UserAgent\|RemoteAddr" internal/core/auth/` 零命中；
   会话只凭 `kore_session` cookie；CSRF 只比对 cookie + 同名请求头（`internal/core/httpapi/middleware.go:110-145`）。
6. **`app-deploy` upgrade 快照目录竞态（P2）**：`kore-plugin-app-deploy/internal/apop/artifact.go:682-696`
   快照目录 `<state>/snapshots/<name>/<UTC 秒>`，状态锁只护 JSON 记录、不护快照目录；同一应用同一秒两次
   upgrade 会撞同一快照路径（`MkdirAll` 不报错、`copyTree` 相互覆盖）。披露 commit `463f14f`。
7. **`logs` `uniqueExportPath` check-then-act（P3）**：`kore-plugin-logs/internal/logic/download.go:354-368`
   先 `Lstat` 判不存在再返回路径，`:91-95` 用 `writeFilePrivate` 落盘（非 `O_EXCL`）；同秒并发导出
   同名时后写覆盖前写。披露 commit `abe74b7`。
8. **`file` P3 诊断信息缺 errno**：披露于 `699db82` 轮次，仓内未落独立证据 → 具体错误消息位置**未确认**。
9. **`backup` P3 错误消息不提权限**：披露于 `07e9ac5` 轮次，仓内未落独立证据 → 具体消息**未确认**。
10. **`site` `apply.go` 回滚快照跨锁**：`kore-plugin-site/apply.go:43-47,96-100` 在调用
    `withManifestLock`（`vhost.go:59`）**之前**拍 conf/manifest 快照；回滚用的是锁外旧快照，
    并发写者可能被回滚覆盖。披露 commit `dd1f565`。

以下旧挂账本轮未动、仍有效：**插件 UI 分发链未实现**（ADR-0040 裁决 v1.0 前不补，`web/app.js:1131`
仍指向不存在的 `/plugin-assets/...`）；**能力声明的运行期强制为零**（无 seccomp / namespace，
`grep -rn "seccomp\|Resource.Apply" internal/ pkg/` 零命中）；**waf 0.4.5 整链真机证据未落本仓**
（最新 e2e 为 0.4.4）；**`echo` 的 3 个 fault 缺口未补**（`ping` / `slow` / `timeout`，
`.agents/verify/fault-method-audit.md:13`）。

### C. 下一轮建议（≤5 条，按优先级）

| # | 动作 | 为什么（优先级理由） | 验收 |
| --- | --- | --- | --- |
| 1 | **第 52 把重签：把 site 0.4.4 / file 0.3.3 / app-deploy 0.3.2 收进索引**（`plugins.json` + `versions.lock.json` + sig），并核对 dist sha | 唯一「已修但用户拿不到」的缺口：三处并发修复都已发版打 dist，商店仍发旧版；P1 安全修复（file TOCTOU）在旧版里 | 索引 24 条版本 == 各仓 `info.json.version`；`store-check` 的 `DIST_SHA_DIFF` 0 漂移；商店端版本逐条等于索引 |
| 2 | 在**真 root + 真 systemd 系统 unit** 装一次机，跑通 `kored upgrade --bin <本地文件> --sha256 <值>` → `--no-block restart` → finalize `pending`→`success`，再跑一次自卸载 | 挂账 1+2；ADR-0042 是提权设计地基，现在**零真机正路径证据**；沙箱非 root 直接 `exit 6` | `journalctl -u kore` 有 Started/Stopped；`/proc/<newpid>/exe` sha == 入参；pending→success 可读；卸载后 unit 不存在 |
| 3 | 重建并重启主实例，把 `520420c` + `bd3ac83` 带进运行镜像；登录一次读 `system/info`，复核 `paths.index_dir` == `kore-plugins/index` 与版本一致 | 门禁全绿但运行态还是 03:33 的旧二进制；G-29 要求「验数据不验配置」，而索引路径从未取到 | 重启后 `/proc/<pid>/exe` sha == 新 `bin/kored`；`paths.index_dir` 字面相等；商店版本 == 索引 |
| 4 | 在 root 内核下验证插件降权：`demotion.enabled=true` + 插件进程 uid == `kore-<id>` + 失败回滚 | 挂账 3 只有代码；产品定位「插件低权运行」当前不可验证 | `ps -o uid= -p <plugin pid>` 为 `kore-<id>`；`getent passwd` 有对应账户；kill 后回滚不残留 |
| 5 | 收 4 个并发残留（都带锁边界）：app-deploy 快照目录唯一名 / logs 导出 `O_EXCL` / site 回滚快照进锁 / file&backup 的 P3 错误消息 | 今晚修的是「丢数据 P1」，剩下的是同代码路径的 P2/P3；趁热改成本最低，留着下次还会以「偶发」出现 | 各仓 `tests/boundary` 加「同秒并发」用例先 FAIL 后 PASS；`-race` 全绿 |

### D. 本轮「未确认」清单

- **`store-check:343` NameError 的独立修复 commit**：仓内无任何 commit message / 文档记录该崩溃；当前
  `scripts/store-check.sh:149` 已初始化 `dist_unrecorded`、`:342` 自增，崩溃现场与修复动作**未确认到 sha**
  （推断随 `4c516e6` 的 dist 缺件可见改动一并落地，不作定论）。
- **file / backup 两笔 P3 的具体位置**：`699db82` / `07e9ac5` 的 commit message 与仓内文件均未记
  「errno / 权限提示」细节，**未确认**到 `file:line`。
- 主实例 `paths.index_dir` / 商店版本：`GET /api/v1/system/info` → `401`（登录门生效的副作用），未登录侧取不到；
  本轮**没有**为取值改口令或改主配置。
- `kored upgrade` 正路径（替换 + `--no-block restart` + finalize）与卸载：本机非 root，`exit 6`，**未实测**。
- root 形态下插件降权的实际 uid / 系统用户：`kore-*` 用户数 0，**只有代码路径**。
- **第 19 段全仓 `-race` 的最终落地形态**：本轮实跑通过（17 包 / 53s），但 `Makefile` / `scripts/race-full-check.sh` /
  `AGENTS.md` 都还在工作树（他人在途），**是否原样提交、段号是否定为 19 段未确认**。
- waf 0.4.5 端到端行为：本仓无 0.4.5 e2e 报告（最新为 0.4.4）。
- 24 个插件仓 `CHANGELOG` 条目与 git tag 的逐仓 sha 对应：本轮只核索引版本、`info.json.version` 与 CHANGELOG 头部，未逐仓 `git rev-parse`。

## 1. 总原则：文件之外无事实

一句话：**会话里说过、但没落进仓库文件的结论，视为不存在。**

- 聊天记录不可检索、不可复现、不会随仓库分发，不能作为任务依据。
- 任何判断、进度、验收结论只要影响后续动作，都必须在同一检查点内写进对应文件（G-23 判断留痕）。
- 文件之间出现矛盾时，以本规范 §2 指定的"唯一事实源"为准，其余文件必须当轮改正，不许两套并行。
- 交接不是"写一段总结给下一个人"，而是"让下一个只读文件的人不需要你再解释"。

## 2. 四问与回答它们的文件

| 问题 | 唯一事实源 | 辅助文件 |
| --- | --- | --- |
| 要做什么、凭什么叫完成 | [BOARD.md](BOARD.md)（任务行的 `subject` / `scope` / `status` / `blocked_by` / `evidence` / `revision`；跨仓库登记在「变更集登记区」） | `docs/` 对应领域文档与 ADR |
| 怎么干（流程、门禁、角色） | [WORKFLOW.md](WORKFLOW.md)（Kore Loop 七阶段与阶段收口）· [QUALITY-GATES.md](QUALITY-GATES.md)（G1–G19 / G-28–G-30 的命令与执行者）· [ROLES.md](ROLES.md)（6 个角色、写域、不可兼任） | 根 [AGENTS.md](../AGENTS.md) 的硬门禁表 |
| 干到哪了（进展与证据） | [BOARD.md](BOARD.md) 的任务状态 + [LOG/DISPATCH.md](LOG/DISPATCH.md)（派发与回填）+ [verify/](verify/)（验收报告与截图） | [JOURNAL.md](JOURNAL.md) 的里程碑记录；`LOG/sessions/` 的会话摘要 |
| 为什么这么定 | [LOG/DECISIONS.md](LOG/DECISIONS.md)（多选一决策，**含被否决的选项与依据**） | [JOURNAL.md](JOURNAL.md) 复盘；`docs/DECISIONS/` 的 ADR 原文 |

补充映射：

- **流程如何落地**：[LOG/README.md](LOG/README.md) 解释 DECISIONS / DISPATCH / sessions 三者分工。
  "状态看 BOARD、判断看 DECISIONS、派发看 DISPATCH、教训看 JOURNAL"——四者不互相替代。
- **产物长什么样**：[templates/](templates/) 提供任务卡、验收报告、评审单骨架；新写文件先套模板。
- **不可逆选择**：架构 / 协议 / 预算 / 范围类决定必须进 `docs/DECISIONS/` 的 ADR，
  并在 [LOG/DECISIONS.md](LOG/DECISIONS.md) 记一行索引与被否方案。

## 3. 硬约束

以下每条都以"第三方只读文件能否复现"为判据，违反即交接失败。

1. **判断必须落文件**：多选一决定（架构 / 协议 / 预算 / 范围 / 门禁）写进
   [LOG/DECISIONS.md](LOG/DECISIONS.md)，写清被否决选项及否决依据；只写在会话里不算数。
2. **完成判定必须可复现**：声称"完成"必须给出 `命令原文 + 退出码 + 关键输出`（G-07）。
   没有输出的"应该没问题"不成立；接口 200、DOM 断言、设计稿都不能替代规定证据（G-28 对 UI 要求双端截图）。
3. **证据冻结**：[verify/](verify/) 下的报告与截图是历史证据，不改写、不删减；
   发现错误只能新增报告并注明"取代某份"，旧文件保持原样。明文凭据一律 `***`（G-30）。
4. **未证明必须单列**：证据报告必须有"已证明 / 未证明"两栏，未验证项不得写成已通过。
   单测覆盖不等于真机验证，前者只能写在"已证明"的对应粒度里。
5. **写域不重叠**：同一层并行任务的 `scope` 不得相交（G-08）；不改别人写域内的文件，
   确需扩大写域先回到拆解阶段重画，不在执行中偷偷扩。
6. **运行态资产不手改**：`.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、运行中的 `bin/kored`
   属运行态（G-29）。测试要不同配置 / 索引 / 状态，必须起隔离实例（独立 `--config`，state / run / log 落 `/tmp`）。
7. **跨仓库要登记变更集**：一次改动跨多个仓库，必须在 [BOARD.md](BOARD.md) 登记 `CS-<YYYYMMDD>-<序号>`，
   写清各仓库 commit / tag 与合并顺序（G-15），否则不算完成。
8. **交接必须自包含**：交接卡片（§4）里的"下一步"是可直接执行的动作（命令或明确的文件改动），
   不是"继续优化"这类无法验收的描述。

## 4. 交接卡片（模板）

每笔任务在 [BOARD.md](BOARD.md) 行内或任务卡里附一张卡片，六格缺一不可：

| 字段 | 填写要求 |
| --- | --- |
| 目标 | 一句话、动词开头，与 BOARD `subject` 逐字一致 |
| 写域 | 允许改动的文件 / 目录前缀，逗号分隔；跨仓库写仓库名 |
| 验收命令 | 可复制执行，注明期望退出码与关键输出特征 |
| 当前状态 | BOARD `id` + `status` + `revision`；最后一笔 commit 短 sha |
| 下一步 | 单条动作（一条命令或一处文件改动），做完即可进入下一状态 |
| 已知坑 | 失败过的尝试、不得重试的路径、外部依赖（如 root / systemd / 索引重签） |

卡片示例（只写事实，不写鼓励语）：

```text
目标: 修复 CORE §2.13 提权 argv 与代码不一致
写域: docs/CORE.md, internal/core/privilege/, .agents/verify/
验收: make check（期望 exit 0）; go test -timeout 200s ./internal/core/privilege/（期望 ok）
状态: M5-PRIV status=completed revision=3 · commit=eb08d41
下一步: 无；若发现 PLUGIN-PROTOCOL 漂移，同笔补文档并重跑 make docs-check
已知坑: sandbox 内 sudo 被 NoNewPrivs 拒绝，真 root 验证须在 systemd user unit 内执行
```

## 5. 接手后的动作清单

按顺序做，不要跳步：

1. 读 [../AGENTS.md](../AGENTS.md) 的"读前必知"与硬门禁表，建立红线概念。
2. 读 `docs/VISION.md` 与 `docs/ARCHITECTURE.md`，确认做什么、不做什么。
3. 读 [WORKFLOW.md](WORKFLOW.md)、[QUALITY-GATES.md](QUALITY-GATES.md)、[ROLES.md](ROLES.md)。
4. 打开 [BOARD.md](BOARD.md)，只看当前里程碑的 `in_progress` / `blocked` 行；`completed` 行只在需要追溯时看。
5. 读 [LOG/DISPATCH.md](LOG/DISPATCH.md) 最近若干行，确认最后派发与回填；读 `LOG/sessions/` 最近一份会话摘要。
6. 跑 `git log --oneline -10` 与 `git status --short`，核对 BOARD 最后一笔 commit 是否在历史里、
   工作区是否有他人未提交改动（有则先弄清归属，不覆盖）。
7. 跑 `make check` 建立基线；源码就绪后加跑 `make vet` 与 `make test`。
8. 确认没有"改到一半"的痕迹：临时 worktree / 分支（`make wt-check`）、被改动的运行态配置、
   半成品证据文件。发现即先记录再处理，不静默清理。

## 6. 交付前自检

交接或声明完成之前逐项核对：

- [ ] 任务行 `status` / `revision` / `evidence` 已回填，`evidence` 含命令、退出码、关键输出。
- [ ] 影响后续动作的判断已进 [LOG/DECISIONS.md](LOG/DECISIONS.md)（含被否决选项）。
- [ ] 派发与回填已进 [LOG/DISPATCH.md](LOG/DISPATCH.md) 同一行，未另开重复行。
- [ ] 证据文件在 [verify/](verify/) 且链接可达（`make docs-check` 会校验相对链接）。
- [ ] 未证明项已单列，未被写成已通过。
- [ ] 运行态资产未被顺手改动；临时实例与临时文件已清理。
- [ ] 文档与代码一致（路径 / 协议 / 预算数字 / 角色名，G-06），无"文档说 A、代码做 B"。
- [ ] 工作区只剩本轮该留的改动；他人未提交改动、旧轮证据与截图原样保留并说明原因。

## 7. 反模式

| 反模式 | 后果 | 正确做法 |
| --- | --- | --- |
| 结论只留在会话里 | 换会话即失忆，同一问题反复讨论 | 当轮写进 DECISIONS / BOARD / 证据文件 |
| 用"应该没问题"代替命令输出 | 完成判定不可复现，回归无人知晓 | 贴命令 + 退出码 + 关键输出 |
| 证据报告只写成功路径 | 未验证项被误当已通过 | "已证明 / 未证明"两栏并列 |
| 直接改主实例配置做测试 | 主实例读到旧数据，线上行为漂移 | 起隔离实例，主配置不动 |
| 跨写域顺手改别人文件 | 与并行任务冲突，回滚代价高 | 回到拆解阶段重画 `scope` |
| 改动攒到最后一起提交 | 中途失败无法回退到自洽点 | 一处自洽即提交 |
| 交接只写"已完成 80%" | 下一个人不知道剩下 20% 是什么 | 写清下一步的单条可执行动作 |

本规范不新增 G 编号门禁：它约束的是"记录与交接"的写法，执行判据仍以上表引用的
[QUALITY-GATES.md](QUALITY-GATES.md) 与根 [AGENTS.md](../AGENTS.md) 为准。
