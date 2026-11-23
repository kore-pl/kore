# 全仓 dist / 索引一致性巡检（task-92，只读）

> 日期: 2026-11-23 · 执行: kore-impl-release-r5 · 任务: task-92（claim rev 2 → complete）· 只读巡检，未改索引 / 未改插件仓 / 未 push

## 1. 方法（可复现）

对签名索引 `kore-plugins/index/plugins.json` 的 24 条逐一取：
- ① 索引 `version` + `sha256`
- ② `git rev-parse "v<version>^{commit}"`（tag 指向的 commit）
- ③ **tag 干净树 dist**：`git archive v<version> | tar -x -C /tmp/audit92-XXXXXX` → 临时目录内 `make dist` → `sha256sum dist/*.tar.gz`（绝不在工作树打；临时目录用后即 `rm -rf`）
- ④ `git rev-list --count v<version>..HEAD`（HEAD 领先 tag 的提交数）

三类结论：**一致**（tag 处 dist == 索引 且 HEAD 未领先）/ **需 bump**（tag 处 dist == 索引但 HEAD 已领先，下次发版必须 bump，禁止用 HEAD 重打同版本）/ **不一致（危险）**（索引 sha 与 tag 产物不符）。

## 2. 逐仓结果（24 行）

| id | 索引 version | 索引 sha 前12 | tag 处 dist sha 前12 | 结论 | HEAD 领先 | 建议动作 |
| --- | --- | --- | --- | --- | --- | --- |
| echo | 0.1.4 | eaf2d1287478 | eaf2d1287478 | 一致 | 0 | 无需动作 |
| site | 0.4.2 | a467c9dec113 | a467c9dec113 | 需 bump | 1 | 下次发版 bump 版本，勿用 HEAD 重打 0.4.2 |
| file | 0.3.2 | e4079c3c9382 | e4079c3c9382 | 一致 | 0 | 无需动作 |
| ssl | 0.5.0 | 565009c6d869 | 565009c6d869 | 需 bump | 3 | 下次发版 bump 版本 |
| integrity | 0.3.2 | e6cf549b5d9b | e6cf549b5d9b | 需 bump | 3 | 下次发版 bump 版本 |
| cron | 0.4.1 | 1991002071ce | 1991002071ce | 需 bump | 2 | 下次发版 bump 版本 |
| ssh-guard | 0.2.3 | 50a4035ce151 | 50a4035ce151 | 需 bump | 2 | 下次发版 bump 版本 |
| monitor | 0.3.0 | db747aad1dc5 | db747aad1dc5 | 需 bump | 3 | 下次发版 bump 版本 |
| logs | 0.4.1 | 2e540c366679 | 2e540c366679 | 需 bump | 3 | 下次发版 bump 版本 |
| dns | 0.3.2 | a2953453c0e7 | a2953453c0e7 | 一致 | 0 | 无需动作 |
| runtime-php | 0.2.2 | 11fc63366f0e | 11fc63366f0e | 需 bump | 2 | 下次发版 bump 版本 |
| runtime-node | 0.2.4 | 2033f3ed8519 | 2033f3ed8519 | 一致 | 0 | 无需动作 |
| runtime-python | 0.2.4 | 8565c6e0d210 | 8565c6e0d210 | 一致 | 0 | 无需动作 |
| db-mysql | 0.3.2 | 3ad89d6bcf42 | 3ad89d6bcf42 | 需 bump | 1 | 下次发版 bump 版本 |
| db-postgres | 0.3.1 | 6321caaa3ec5 | 6321caaa3ec5 | 需 bump | 3 | 下次发版 bump 版本 |
| redis | 0.5.0 | d4749ff189cd | d4749ff189cd | 需 bump | 3 | **task-67 上报的同款**：HEAD（f1761e6 OSS 批次）重打 dist 会变 `0455ae5e…`，与索引 `d4749ff1…` 冲突 → 下次发版必须 bump，禁止用 HEAD 重打 0.5.0 |
| backup | 0.4.0 | 5b30ba8a96a4 | 5b30ba8a96a4 | 需 bump | 4 | 下次发版 bump 版本 |
| firewall | 0.2.4 | 983468d4c2ab | 983468d4c2ab | 需 bump | 3 | 下次发版 bump 版本（issue #1 同类风险仓，HEAD 重打前必须 bump） |
| waf | 0.3.1 | fbaba38049ff | fbaba38049ff | 需 bump | 2 | 下次发版 bump 版本 |
| container | 0.4.1 | 7054307e476a | 7054307e476a | 需 bump | 2 | 下次发版 bump 版本 |
| app-deploy | 0.2.0 | 56ee94417068 | 56ee94417068 | 需 bump | 5 | 下次发版 bump 版本 |
| terminal | 0.2.0 | d72e4567533e | d72e4567533e | 需 bump | 3 | 下次发版 bump 版本 |
| process | 0.2.1 | 27510bc5040f | 27510bc5040f | 需 bump | 5 | 下次发版 bump 版本 |
| discover | 0.3.0 | 6dda26217a29 | 6dda26217a29 | 需 bump | 2 | 下次发版 bump 版本 |

## 3. 汇总计数

| 结论 | 条数 |
| --- | --- |
| **不一致（危险，索引 sha ≠ tag 产物）** | **0** |
| tag 处 dist == 索引，但 HEAD 已领先（下次发版必须 bump） | **19** |
| 一致（tag 处 dist == 索引 且 HEAD 未领先） | **5**（echo / file / dns / runtime-node / runtime-python） |
| 合计 | 24 |

**危险条目清单：无（0 条）。** 24 仓全部通过「索引 sha == tag 干净树 dist」硬校验——即**当前签名索引与所有已发布 tag 产物自洽，不存在「同 id@version 两个 sha」的现存违例**。

## 4. 风险说明（19 条「需 bump」的含义）

这 19 仓的 **tag 处产物与索引一致**（现状安全），但 **HEAD 已领先 tag**——HEAD 上的源码/依赖改动会让 `make dist` 产出不同 sha。这正是 task-67 上报的 redis 模式：

- **现存风险 = 0**（没有任何仓的索引 sha 与 tag 产物不符）
- **潜在风险 = 19**（若有人图省事用工作树 HEAD 重打 dist 并覆盖同版本发布，就会制造「同 id@version 两个 sha」，违反 RELEASE.md §0 硬约束与 firewall issue #1 判据）

**统一处置建议（不改任何文件，仅建议）**：
1. 19 仓下次发版**一律 bump 版本**（patch +1 起），禁止用 HEAD 产物覆盖已发布版本的资产
2. 发版流程固定「`git archive <tag>` 干净树打 dist 核 sha」为发布物唯一来源（RELEASE.md §2.3 已有此要求）
3. redis 额外注意：task-67 已实测 HEAD 重打 = `0455ae5e…` ≠ 索引 `d4749ff1…`，**在 bump 之前不得对 redis 做任何同版本重发**
4. 领先数最高的 app-deploy / process（各 5 提交）建议优先排期发版，减少漂移窗口

## 5. 过程纪律

- 只读：未改 `kore-plugins/index/*`、未改任何 `kore-plugin-*` 仓、未 push、未在工作树打 dist
- 临时目录：全部 `mktemp -d /tmp/audit92-XXXXXX`，逐仓 `rm -rf`，巡检后 `ls /tmp/audit92-*` 确认清零
- 退出码：巡检脚本整体正常完成（24/24 仓取到 tag commit，无 NO_TAG / NO_REPO）
