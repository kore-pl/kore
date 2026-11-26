---
title: M5 红队 4 缺陷修复独立复跑验收报告
date: 2026-11-26
owner: m5-fix-verifier
verdict: PASS
---

# M5 红队 4 缺陷修复独立复跑验收报告（task-58）

## 0. 身份与范围（G-09）

- 我是**独立 verifier**（m5-fix-verifier）：既不是 m5-impl（实现者），也不是 m5-redteam（红队），不复用两者结论与测试。
- 目标 commit：`4a21845`（`[agent:m5-impl] fix(cmd/kored): 修复 M5 红队 4 缺陷（D-1~D-4）`），当前 HEAD 即该 commit。
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`。
- 硬纪律遵守：只读复跑；唯一可写文件为本报告；隔离场景全在工作区内临时目录 `kore-pl/.tmp-m5fix-verify/`；不 push / 不联网 / 不执行 install-serve-upgrade 主流程 CLI / 不碰真实 `<install>/data` 与 `.kore-local-*`；GOCACHE 与临时目录用完删除。
- **本轮是否改动过主实例的运行态配置：否。** 唯一的"启动 serve"来自 `scripts/zero-intrusion-check.sh` 自身的隔离实例（独立临时安装根、socket 落 `<install>/run/`），与主实例 8787 无关。

## 1. 读码确认 4 修法落地（全部命中）

| 缺陷 | 修法代码位置（`cmd/kored/selfupdate_state.go`） | 读码证据 |
| --- | --- | --- |
| D-1 孤儿状态 fail-closed | `readUpdateState` L291–325，L317 `ok, err := updateStateLedgerHasRemove(stateDir)`，L318–323 校验失败/无条目返回 error | `updateStateLedgerHasRemove` L406–425 从 L403 的"仅门禁使用"提升为读路径必经校验；注释 L16–17、L288–290 明示语义 |
| D-2 purge 收口 | `validateM5PurgeOp` L334–360：L335 仅认 `purgeKindFileRemove`（拒 `file.restore`）；L347–358 目标须**精确等于** `updateStatePath(stateDir)` 解析值，越界 WARN + error；`purgeStateFileFromLedger` L381–401 逐条先过收口再执行；`executePurgeOp`/`validatePurgePath` 仍为通用原语但不再被 M5 直接裸调 | 注释 L327–333 三条硬约束，L377–380 入口说明 |
| D-3 symlink 拒穿透 | `updateStatePath` L140–168：L157 `evalSymlinksAllowMissing` → L161 解析后复核边界 → L164–166 `resolved != clean` 即拒；`evalSymlinksAllowMissing`/`evalSymlinksDepth` L81–131（含悬空 symlink Readlink 与 16 层深度上限）；`recordUpdateStateChange` L192–195 拒 symlink 账本；`readUpdateState` L297–301 拒 symlink 状态文件 | 注释 L136–137、L97–98 |
| D-4 账本 0600 收紧 | `recordUpdateStateChange` L189–219：L192–198 写前 Chmod 0600 + 拒 symlink，L215–217 写后 Chmod 0600（覆盖 NEW/EXIST 两路径）；`changes.go` 的 `OpenFile` mode 对已存在文件无效，本层补位 | 注释 L187–188 |

结论：四处修法均**真实落地于生产代码**，不是只改测试或注释。

## 2. 独立构造 D1–D4 场景（不复用 m5-impl 测试）

隔离手段：`git archive HEAD | tar -x -C kore-pl/.tmp-m5fix-verify/src`，在副本中只新增我自己的测试文件 `zz_independent_m5fix_test.go`（自带状态样本 `verifierState`，不调用 m5-impl 的 `testUpdateState` 等辅助函数）；`make web-dist` 补 Git 忽略的 embed 产物（仅隔离副本内）；`GOCACHE` 指向工作区内临时目录。

**统一执行命令（隔离副本内）**：

```
cd /home/pt/Work/GolandProjects/kore-pl/.tmp-m5fix-verify/src
make web-dist                                  # exit=0（隔离副本内补 embed 产物）
GOCACHE=<...>/.tmp-m5fix-verify/gocache GOWORK=off \
VERIFIER_SCENARIO_ROOT=<...>/.tmp-m5fix-verify/scenarios \
go test -count=1 -timeout 200s -v ./cmd/kored/ -run 'TestVerifierD[1-4]_'
```

**退出码：0**（`ok github.com/pengtang1024/kore/cmd/kored 0.053s`，4 个测试全 PASS）。逐场景实际行为：

### D1 孤儿状态 fail-closed —— PASS（含正常路径）
- `[NORMAL]` 正常写状态 → `readUpdateState` 返回 `phase=verified target=9.9.9-verifier`，**正常路径仍 PASS**。
- `[D1-a]` 删除 `changes.jsonl` 后 `readUpdateState` **报错**：`更新状态: 账本缺少 .../d1/state/update-state.json 的 file.remove 条目，拒绝读取孤儿状态（D-1）`。
- `[D1-b]` 重建账本但删掉 M5 条目（保留其它条目）后 `readUpdateState` **报错**（同一 D-1 文案）。
- 升级链拒绝：读码确认 `readUpdateState` 唯一生产读写点在本模块（全仓 grep 仅测试文件与自身调用）；该函数 error 即"不可继续"语义（注释 L288–290），调用方据此拒绝而非降级为无状态。当前 M5 阶段无其它生产调用者，故"升级链拒绝"以 error 契约与读码为证，未虚构不存在的上游调用。

### D2 账本篡改越界 purge —— PASS
- `[D2-a]` 把账本 `args` 改成 stateDir 外的隔离 victim 绝对路径 → `purgeStateFileFromLedger` **报错**（`purge 目标 ... 不在允许范围（应为 .../update-state.json，D-2）`），并有 `WARN 拒绝越界 purge 目标`；**victim 字节不变**（逐字节比对原文）。
- `[D2-b]` `kind` 改 `file.restore`（2 参数指向 victim）→ **报错** `拒绝 purge kind "file.restore"（M5 仅允许 file.remove，D-2）` + `WARN 拒绝非白名单 purge kind`；victim 字节不变。
- `[D2-c0]` 空 args → **报错** `file.remove 需要 1 个参数，实际 0`；`[D2-c1]` 相对路径 → **报错** `purge 路径必须是绝对路径`；victim 字节均不变。
- `[D2-legit]` 合法账本条目 → purge 成功，状态文件确实消失（合法路径未被误伤）。

### D3 symlink stateDir 拒穿透 —— PASS
- 用隔离目录内的 sibling 作"清单外"目标（**绝不写真实 `/etc`**）。`linked-state` 为指向 `outside-target` 的 symlink。
- `writeUpdateState(linked-state)` → **报错** `拒绝符号链接 / 路径重定向（.../linked-state → .../outside-target），防止穿透清单外目录（D-3）`。
- 无穿透：`outside-target` 目录内 `update-state.json`、`changes.jsonl` 均不存在，`os.ReadDir` 为空（零写入、零临时文件残留）。
- `[D3-normal]` 真目录写盘 + 读取仍 PASS。

### D4 账本权限收紧 —— PASS
- 预置 `changes.jsonl` 为 `0644`（`stat` 确认 mode=644）→ 写状态后 `stat` mode=**600**（0644 → 0600）。

**4/4 场景全部闭环。**

## 3. 项目门禁复跑（主树，只读）

所有命令在 `/home/pt/Work/GolandProjects/kore-pl/kore`，`GOCACHE=<workspace>/.tmp-m5fix-verify/gocache`、`GOWORK=off`。

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `go test -count=1 -timeout 200s ./cmd/kored/...` | 0 | `ok github.com/pengtang1024/kore/cmd/kored 11.085s` |
| 2 | `go vet ./cmd/kored/...` | 0 | 无输出 |
| 3 | `gofmt -l cmd/kored/selfupdate_state.go cmd/kored/selfupdate_state_test.go` | 0 | 空（全部已格式化） |
| 4 | `make zero-intrusion-check` | 0 | `17 pass, 2 info, 0 fail`；隔离实例；状态文件 0600、仅一个、账本 file.remove、0600、回滚后不存在、系统路径零新增、无新用户/组/unit |
| 5 | `make secret-check` | 0 | `0 FAIL / 23 处匹配（占位写法均合规）` |
| 6 | `make docs-check` | 0 | `5 pass, 1 warn, 0 fail`（行数越界 9 份 WARN 不阻断；1275 条相对链接全可达） |

## 4. Git / worktree 核验

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 4a21845 在 HEAD 祖先 | `git merge-base --is-ancestor 4a21845 HEAD` | exit 0；且 HEAD == `4a21845` |
| 仅改 M5 写域 5 文件 | `git show --format='' --name-only 4a21845` | `selfupdate_state.go` / `selfupdate_state_test.go` / `docs/DATA-MODEL.md` / `docs/RUNBOOK-INSTALL.md` / `scripts/zero-intrusion-check.sh` |
| 未碰 M1–M4 | 上列文件名 grep `httpapi|orchestrator|batch|scheduler|updatecheck|docs/CORE.md|docs/SECURITY.md|AGENTS.md|README.md` | 零命中（NONE） |
| worktree 卫生（G-25） | `git worktree list` / `git branch --list 'wt-*' 'tmp-*'` | 仅主工作树 1 行；无 wt-*/tmp-* 分支 |
| 他人 dirty 原样 | `git status --short` 前后对比 | 一致：仅原有 `M scripts/usability-pending.txt` 与 `.agents/verify/*`、`data/`、`dist/` 等未跟踪项；本报告之外无新增残留 |

## 5. 清理

- 隔离副本 `kore-pl/.tmp-m5fix-verify/`（含 src/scenarios/gocache）、`make web-dist` 产物均随目录一并删除；主树 `web/dist` 为原有 gitignored 产物，未因本轮验证产生新变化。
- 未 push、未联网、未执行主流程 CLI、未改运行态配置。

## 6. 结论

**PASS** —— M5 红队 4 缺陷（D-1 孤儿状态 fail-closed / D-2 purge 范围收口 / D-3 symlink 拒穿透 / D-4 账本 0600 收紧）在 commit 4a21845 中均真实落地，4/4 独立场景闭环，全部项目门禁绿，worktree 洁净。

[agent:m5-fix-verifier]
