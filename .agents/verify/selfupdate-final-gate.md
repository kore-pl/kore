# C15 自升级验收 · 本机复跑最终门禁报告（task-124）

- 验收员：c15-gate（执行 worker；独立于自升级实现者与 m8-verifier）
- 时间：2026-11-26（Asia/Shanghai）
- 任务：task-124（先 claim，revision 1→2，owner=c15-gate）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根在此）
- 写域：`.agents/verify/self-update-mvp.md`、`.agents/verify/selfupdate-final-gate.md`、`docs/FEATURE-GAP-BACKLOG.md`；精确 `git add` + `commit -s [agent:c15-gate]`，**不 push**。
- 用户裁决（round 4）：**「用本机来测试和正式使用」**——真跑门禁再收口，不只改文档。
- HEAD 漂移如实记录：任务卡基准 HEAD=`85e18f8`（本次 `git archive` 与 21 段复跑均基于此）；复跑期间同仓另有 worker 落了两份纯证据文档提交（`7759b0f` C2 ACME 证据、`89a5666` C1 WAF 证据，各自只含 `.agents/verify/{acme-offline-evidence,waf-ruleadd-live}.md`，不碰代码 / 门禁脚本 / 本任务三文件）。将这两份证据并入隔离树后复跑 `secret-check` / `docs-check` 仍 exit=0，最终文件集无门禁冲突。

## 结论（先行）

**核心 PASS；本机隔离树 `make check` 21 段全绿（exit=0，末行 `[OK] 门禁全部通过`）。** 原 C15 的 4 段 FAIL（thin-shell 基线漂移 / oss 工作区污染 / presets EROFS 假阴性 / race 同因）已逐段复核为绿色；退出码口径按代码实际值 **`exitEnv=6`**（`cmd/kored/main.go:26`），任务卡旧写 3 不成立（`exitState=3` 才是 3）。

**如实留痕**：首轮（未修 backlog 前）`make check` **exit=2**，唯一阻断 FAIL 是**新发现的 HEAD 文档缺陷**——`docs/FEATURE-GAP-BACKLOG.md:175`（HEAD commit 85e18f8 引入）把「48 MiB」写在不带「红线」的行上，触发 canonical-check 规则 1（ADR-0016 口径）。该行在本任务写域内，按语义修正为「合计 ≤48 MiB（红线）」后，次轮全绿。**首轮不是环境噪声，是真实缺陷并已修复**；两轮命令、退出码与末行均在 §3 如实记录。

## 1. 隔离树构造（工作区内短路径，规避 UDS 108 字节假 FAIL）

```
WS=/home/pt/Work/GolandProjects/kore-pl
ISO=$WS/.v15                          # 短路径；自更新 UDS socket 实测 83 字节 < 107
git -C $WS/kore archive HEAD | tar -x -C $ISO/kore          # HEAD=85e18f8d77c9cca43f557203c1bfb15b32bb0b77
for d in kore-plugins kore-plugin-*; do                     # 25 个兄弟仓各取提交态 HEAD
  git -C $WS/$d archive HEAD | tar -x -C $ISO/$d
done
export GOPATH=$ISO/gopath GOMODCACHE=$ISO/gomodcache GOCACHE=$ISO/gocache
export GOPROXY=https://goproxy.cn,direct GOSUMDB=sum.golang.org GOWORK=off   # 下载阶段
export KORE_PLUGINS_DIR=$ISO/kore-plugins
export USABILITY_PENDING_FILE=$ISO/kore/scripts/usability-pending.txt
go mod download all            # 根 module + pkg/pluginapi + 25 兄弟仓，exit=0
# 缺 bbolt v1.5.0 / x/sys v0.45.0 / yaml.v3 v3.0.1 按已授权 goproxy 下载进隔离 modcache
export GOPROXY=off GOSUMDB=off                              # 复跑阶段
cd $ISO/kore && make web-dist && make check                 # web/dist 由 Makefile 本地拷贝生成，无 npm/网络
```

- kore 归档 HEAD：`85e18f8d77c9cca43f557203c1bfb15b32bb0b77`；兄弟仓全 `git archive HEAD`（排除他人 dirty；site HEAD=`f39c4bd` 即 EROFS Skip 修复提交）。
- 短路径隔离：`.v15/kore` 下自更新 socket 约 **83 字节**（原先长路径 108 字节触发段 11 假 FAIL），未复现路径长度假阴性。
- 主工作区 dirty 原样未动：` M scripts/usability-pending.txt`、多条 `?? .agents/verify/*`、`?? data/`、`?? dist/`；兄弟仓（含 site 的 `MM apply.go` 等在途改动）只读 archive，未触碰。
- 联网仅限已授权 goproxy 下载构建依赖；复跑全程 `GOPROXY=off`；未碰 `.kore-local-*` / 8787；未 push。
- 离线前置：`go mod verify` = `all modules verified`；`go build ./...`（根 + pkg/pluginapi）= exit 0。

## 2. 修复记录（唯一非 C15 阻断项）

| 项 | 首轮 | 处置 | 次轮 |
| --- | --- | --- | --- |
| `docs/FEATURE-GAP-BACKLOG.md:175`（HEAD 85e18f8 引入） | canonical-check 规则 1 FAIL：`48 MiB 有 1 行未与「红线」同行` | 改为「单插件 ≤24 MiB（目标）/ 合计 ≤48 MiB（红线）/ 同时常驻 ≤3」，与 ADR-0016 / G-03 口径一致；主工作区与隔离树同步 | `canonical-check: 14 pass, 0 warn, 0 fail`，exit=0 |

该修复同时是本任务写域内的 backlog 收口改动，非回他人文件、非绕过门禁。

## 3. 两轮 `make check` 命令 + 退出码 + 末行（如实）

| 轮次 | 命令 | 退出码 | 末两行 |
| --- | --- | --- | --- |
| 首轮（修 backlog 前） | `cd $ISO/kore && GOPROXY=off GOSUMDB=off GOWORK=off GOCACHE=$ISO/gocache GOMODCACHE=$ISO/gomodcache KORE_PLUGINS_DIR=$ISO/kore-plugins USABILITY_PENDING_FILE=$ISO/kore/scripts/usability-pending.txt make check` | **2** | `[FAIL] 门禁未通过 — 见上方明细` / `make: *** [Makefile:513：check] 错误 1` |
| 次轮（修 backlog 后） | 同上命令 | **0** | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，1s，零 DATA RACE）` / **`[OK] 门禁全部通过`** |
| 终轮（三份文档全部定稿后再次确认） | 同上命令 | **0** | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，2s，零 DATA RACE）` / **`[OK] 门禁全部通过`** |

- 首轮时间：START 19:14:43 +0800 / END 19:18:38 +0800；次轮：START 19:20:56 +0800 / END 19:23:49 +0800；终轮：START 19:26:39 +0800 / END 19:29:30 +0800。
- 次轮/终轮完整输出各 1012 行；`grep '\[FAIL\]'` 均零命中。终轮在 verdict、backlog C15/§5、本报告全部落盘后复跑，确认最终文件集仍全绿。

## 4. 次轮（全绿）21 段逐段结果

| 段 | 项 | 结果（汇总末行） | 判定 |
|---|---|---|---|
| 1/21 | docs-check | `docs-check: 5 pass, 1 warn, 0 fail` | PASS（1 WARN 不阻断） |
| 2/21 | 依赖白名单 + 兼容基线 | `dep-check: 2 pass, 0 fail`；`[OK] 兼容基线通过`；第三方 2/3（bbolt+yaml） | PASS |
| 3/21 | 薄壳边界 thin-shell | `thin-shell-check: 4 pass, 0 fail（扫描 202 个可执行 .go 文件）` | PASS（原 FAIL#1 已修） |
| 4/21 | repo-check 跨仓边界 | `repo-check: 5 pass, 0 fail` | PASS |
| 5/21 | canonical-check 口径唯一性 | `canonical-check: 14 pass, 0 warn, 0 fail` | PASS（本轮修复段） |
| 6/21 | log-check（WARN 级） | `log-check: 8 pass, 0 warn` | PASS |
| 7/21 | wt-check（WARN 级） | `wt-check: 4 pass, 0 warn` | PASS |
| 8/21 | oss-check | `oss-check: 8 pass, 0 warn, 0 fail`；`结果: 门禁通过` | PASS（原 FAIL#2 已修） |
| 9/21 | case-check | `case-check: 27 pass, 1 warn, 0 fail` | PASS（1 WARN 不阻断） |
| 10/21 | frontend 首屏体积 | `[OK] 首屏体积达标：90924 字节 ≤ 307200 字节` | PASS（体积漂移 WARN 不阻断） |
| 11/21 | 零侵入门禁 | `zero-intrusion-check: 17 pass, 2 info, 0 fail`；`结果: 门禁通过` | PASS（短路径生效） |
| 12/21 | secret-check | `secret-check: 0 FAIL / 19 处匹配（占位写法均合规）` | PASS |
| 13/21 | 插件仓开源资产 | `汇总: 25 pass / 0 warn / 0 fail` | PASS |
| 14/21 | store-check（WARN 级） | `store-check: 24 pass, 0 fail, 37 warn` | PASS（WARN 不阻断） |
| 15/21 | presets-check（阻断级） | `presets-check: 8 pass, 0 warn, 0 fail` | PASS（原 FAIL#3 已修） |
| 16/21 | 公钥单一真源 | `[OK] 两端公钥一致：verify.go:16:3e461a07…df1c0` | PASS |
| 16 段附 | market 索引→市场页派生 | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` | PASS（未 SKIP） |
| 17/21 | 交叉编译（五目标真编译） | `[OK] 全仓交叉编译五目标全通过（exit 0，耗时 3543ms）` | PASS |
| 18/21 | race 门禁（跨仓 boundary） | `[OK] race 门禁通过（接线完整 + -race 真跑全绿）`；有边界用例 16 仓全过 | PASS（原 FAIL#4 已修，含 site EROFS Skip） |
| 19/21 | 全仓 -race | `[OK] 全仓 -race 通过（17 个包，59s，零 DATA RACE）` | PASS |
| 20/21 | usability-check（WARN 级） | `usability-check: 0 pass, 519 warn, 0 fail, 183 unverified` | WARN（WARN 级不阻断，判据未放宽） |
| 21/21 | 嵌套 module pkg/pluginapi -race | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，1s，零 DATA RACE）` | PASS |
| **末行** | — | **`[OK] 门禁全部通过`** | **PASS** |

## 5. 原 4 段 FAIL 逐段复核（与 self-update-mvp.md §5.3 对照）

| 原 FAIL | 旧归因 | 本次隔离树结果 | 定性 |
| --- | --- | --- | --- |
| 3 thin-shell | thin-shell 词表未同步已合入特性 | `4 pass, 0 fail`（202 个 .go） | 已修复（HEAD 含 62eedfa/7ea083a 精确豁免）→ 绿 |
| 8 oss-check | 扫到 gitignored `.tmp/gomodcache` 非 MIT 头 | `8 pass, 0 fail` | 已修复（find -prune 排除 gitignored）→ 绿 |
| 15 presets | `/etc` 只读导致 EACCES 前提不成立 | `8 pass, 0 fail` | 已修复（site EROFS Skip，HEAD=f39c4bd）→ 绿 |
| 18 race | 同 15，`TestBoundaryNeedRootWhenConfDirRootOwned` 假阴性 | `race 门禁通过`，16 仓真跑全绿 | 已修复 → 绿 |

四段均为**已修复并本机复验**，非「环境例外接受」；沙箱只读 `/etc` 下 site 的 EROFS 分支按代码设计 Skip（非产品缺陷），此口径沿用 mvp-final-gate.md §2 的独立复跑结论。

## 6. 退出码口径裁决：exit=6，不是 3

- `cmd/kored/main.go:26` 明写 `exitEnv = 6`（`exitState = 3` 才是 3）；非 root 自升级闸门返回 `exitEnv`。
- 本机原报告实测 `upgrade` 非 root → `exit=6`，与 `RUNBOOK-INSTALL.md` §6.5.2「6 = 环境不满足」及 usage 一致。
- **裁决**：以代码实际值为准，记 **exitEnv=6**；task-59 卡片旧写「exit=3」为描述笔误，不再沿用；不为了对齐文档回派改码。

## 7. 硬纪律与清理

- 隔离树 `$ISO`（`.v15/`）与隔离缓存 `gopath/gomodcache/gocache` 在提交后删除；临时日志随隔离目录删除，本报告留存逐段证据。
- 精确 `git add` 三份文档 + `git commit -s`（`[agent:c15-gate]`）；未 push、未联网业务操作（仅 goproxy 依赖）、未碰 `.kore-local-*` / 8787、他人 dirty 原样。
- 失败如实报：首轮 exit=2 的 canonical-check 缺陷与修复过程见 §2/§3，不粉饰。

[agent:c15-gate]
