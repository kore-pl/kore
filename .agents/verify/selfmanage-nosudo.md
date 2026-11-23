# 升级 / 卸载免 sudo（一次性安装后运行期零提权）· 验收证据

> 元信息: 2026-11-23T22:1x+08:00 · 执行者 selfmanage-nosudo 子 agent · git 基线 `95d7eb0` · 未 push

## 0. 前提与约束

用户绝对约束：「**只有壳子安装一次 sudo，以后再也不允许有类似的东西。**」前提是部署模型切到「kore 以内核系统级 root 服务运行」：安装期一次性 sudo 建立 unit 与 root 身份，之后内核自己是 root，替换自己二进制 / 重启与删除自己 unit 都不再需要用户提权。

## 1. 开工前的现状事实（`file:line` + 原文）

| # | 问题 | 事实 | 证据 |
| --- | --- | --- | --- |
| 1 | 现在有 `kored upgrade` 吗？ | **没有**。子命令分发里只有 serve/version/install/audit/uninstall/status/admin-password；全仓 `grep -rn "upgrade"` 命中的都是**插件**升级（market/installer），不是内核二进制升级 | `cmd/kored/main.go:37-60`；`cmd/kored/serve_runtime.go:231` 注释只是提到"未来的 upgrade/repair" |
| 2 | 升级要改哪些文件、要不要 sudo？ | 只能人工 `cp` 新二进制到 `<install>/bin/kored`（portable）或 `/usr/local/bin/kored`（fhs），再 `systemctl restart`。**必须 sudo**：目标目录属 root，且 unit 操作需要 root；RUNBOOK 里也只有"make build → 重启 kored"的人工流程（§1 步骤 4/6）。state.db 不需要迁移（升级只换二进制，schema 迁移由进程内的 store 负责） | `docs/RUNBOOK.md:55-106`（步骤 4/5/6）；`docs/RUNBOOK.md:246-267`（unit 装在 `/etc/systemd/system`）；`cmd/kored/main.go:37-60` 无 upgrade |
| 3 | `kored uninstall` 非 root 什么行为？root 能直接完成吗？ | 非 root 且未给两个 `--keep-*`：**部分完成**（宿主侧跳过、本地照清）→ 摘要 + **退出码 6**，文案提示 `sudo kored uninstall --yes`。root 下 `RemoveServiceUnit` 先 `systemctl stop` 再删——**但它就是服务自己，会把自己杀掉**，且**从不删除二进制**（只打印"rm -rf \<installRoot\>"让用户手工做） | `cmd/kored/uninstall.go:157-166`（partial 判定）、`:299-316`（摘要 + `return exitEnv`）；`internal/platform/linux_cleanup.go:39-80`（stop → disable → rm → daemon-reload）；`cmd/kored/uninstall.go:286-290`（手工步骤） |
| 4 | unit 路径与名字 | 默认 `kore.service`，目录 `/etc/systemd/system`；portable 开发实例是 `kored-local`（用户级）。**两个名字不能混**：`kore.service` 是 fhs/系统服务形态 | `cmd/kored/uninstall.go:105-106`（`--unit-name` 默认 `kore.service`、`--unit-dir` 默认 `/etc/systemd/system`）；`cmd/kored/install.go:136-138`（`kored-local` 是用户级） |

## 2. 实现位置

| 能力 | 位置 |
| --- | --- |
| 子命令注册 + serve 入口 finalize 钩子 | `cmd/kored/main.go:35-39`（serve 走 `runServeFinalizingUpgrade`）、`:51-52`（`case "upgrade"`）、`:65-72` |
| 校验（URL 拒绝 / sha256 / 先校验后替换） | `cmd/kored/upgrade.go`：`validateUpgradeSource` / `normalizeSHA256` / `runUpgradeApply` |
| 原子替换 + `.prev` | `cmd/kored/upgrade.go`：`replaceBinaryAtomically`（tmp→fsync→link 备份→rename→fsync dir）、`backupBinary` |
| 重启提交（`--no-block`） | `cmd/kored/upgrade.go:submitUpgradeRestart`；systemd 原语在 `internal/core/privilege/systemd.go`：`BuildRestartArgv` / `RestartUnitNoBlock` / `StopUnitNoBlock` / `DisableAndRemoveUnit` / `UnitMainPID` |
| 回滚 | `cmd/kored/upgrade.go:runUpgradeRollback`（`.prev` → 目标，替换前二进制存回 `.prev`，可再切回） |
| 生效闭环 | 新进程 `finalizePendingUpgrade`（main.go serve 入口调用）；人工 `kored upgrade --verify` |
| 卸载自卸载 | `cmd/kored/uninstall.go`：自卸载判定、`DisableAndRemoveUnit` 分支、二进制删除、最后 `StopUnitNoBlock` |

## 3. 单测（真跑）

```text
$ go vet ./cmd/kored ./internal/core/privilege ; echo EXIT=$?
EXIT=0

$ go test -timeout 200s ./cmd/kored -run 'Upgrade|Finalize' -v
--- PASS: TestUpgradeRejectsSHA256Mismatch
--- PASS: TestUpgradeAtomicReplaceKeepsPrev
--- PASS: TestUpgradeNonRootRefuses
--- PASS: TestUpgradeRejectsURLSource
--- PASS: TestUpgradeDryRunNoMutation
--- PASS: TestUpgradeRollbackUsesPrev
--- PASS: TestUpgradeRollbackMissingPrev
--- PASS: TestUpgradeVerifyFinalizesMarker
--- PASS: TestFinalizePendingUpgradeByNewProcess
--- PASS: TestUpgradeResultIsExplicitJSON
ok  github.com/pengtang1024/kore/cmd/kored

$ go test -timeout 200s ./internal/core/privilege -run 'Restart|SelfCtl' -v
--- PASS: TestBuildRestartArgvNoBlock
--- PASS: TestSelfCtlCandidatesAbsolute
--- PASS: TestRunSelfCtlWithoutSystemctl
```

覆盖的断言：sha256 不符 → 退出 2 且**目标零改动 / 无 `.prev` / 不重启**；正确 sha → 新文件就位 + `.prev` = 旧内容 + 权限 755 + 标记 pending + 重启恰好调用一次；非 root → 退出 6 + 原文文案 + 零改动；URL → 拒绝；dry-run → 零变更；回滚 → 目标回到 `.prev` 且 `.prev` 变成刚被替换的版本（可再切回）；`--verify` → pending 改 success；新进程 finalize → success 且二次调用幂等。

## 4. 实测：`/tmp` 假安装根（`unshare -r` 取临时 root）

**不碰真实 `/usr/local/bin/kored`、不碰真实 unit**；`/tmp/kore-selfmg` 内含 `bin/kored`（old）、`data/`（状态目录）、`kore.service`（mock unit）。

```text
old: 5267aeb7dd7cbb4f72aba71e8c7de87b55b94e51b6f2ea1911719938f331a6eb  size=10404105
new: 69b6037d311e6bbca514c473c7842da29d63c326a8deeadf3f9fe06f12a6276b  size=10404105

# 1) 真实 euid=1000 拒绝
$ /tmp/kore-selfmg/bin/kored upgrade --bin .../kored-new --sha256 <new> --target .../bin/kored --state-dir .../data
EXIT=6
upgrade: 需以系统服务身份运行（root）才能自升级；一次性安装后不应再需要 sudo。
  当前 euid=1000，目标 /tmp/kore-selfmg/bin/kored 与 unit kore.service 都需要 root 才能替换/重启。
目标 sha 仍是 old ✅

# 2) unshare -r（临时 root）原子替换
$ unshare -r .../bin/kored upgrade --bin .../kored-new --sha256 <new> --target .../bin/kored --state-dir .../data --no-restart
EXIT=0
[OK] 已原子替换：/tmp/kore-selfmg/bin/kored（rename 覆盖，旧文件保留为 /tmp/kore-selfmg/bin/kored.prev）
[INFO] 已落 pending 标记：/tmp/kore-selfmg/data/upgrade-result.json

ASSERT 新文件就位: PASS   target sha = 69b6037d…（= new）
ASSERT .prev=旧二进制: PASS   .prev sha = 5267aeb7…（= old）
mode=755 size=10404105

# 3) 标记 pending（原文）
{ "state": "pending", "binary": "/tmp/kore-selfmg/bin/kored",
  "expected_sha256": "69b6037d…", "previous_sha256": "5267aeb7…",
  "version": "0.0.9-old", "updated_at": "2026-11-23T22:11:29+08:00", "run_pid": 112115 }

# 4) 新进程 --verify 闭环
$ unshare -r .../bin/kored upgrade --verify --target .../bin/kored --state-dir .../data
EXIT=0
[OK] 新版本已生效：/tmp/kore-selfmg/bin/kored（标记改为 success）
state=success verified_at=2026-11-23T22:11:29+08:00 version=0.1.0-new

# 5) --rollback
$ unshare -r .../bin/kored upgrade --rollback --target .../bin/kored --state-dir .../data --no-restart
EXIT=0
ASSERT 回滚生效: PASS   target sha = 5267aeb7…（回到 old）
回滚后 .prev sha = 69b6037d…（= new，可再切回）

# 6) sha 不符（64 个 0）
EXIT=2
upgrade: sha256 校验失败，拒绝替换（目标文件未改动）
拒绝后 target sha = 5267aeb7…（仍 = old）✅

# 7) 重启提交失败分支（真实 systemctl，unit 名不存在，零副作用）
$ unshare -r .../bin/kored upgrade --bin ... --sha256 <new> --unit-name kore-selfmg-nonexistent.service
EXIT=6
upgrade: 二进制已替换（sha256 已校验），但重启未提交: systemctl --no-block restart … 失败
  已完成的：…/bin/kored 已就位（旧版保留为 …/kored.prev）
  退出码 6 = 环境不满足（无法提交重启），不是「替换失败」
```

## 5. 未验证项（如实记录）

1. **真机 `systemctl restart kore.service` 成功路径未验**：本机 `kore.service` 为 inactive，`unshare -r` 内连不上 system bus（实测正是失败分支）。运行期"新进程把 pending 改 success"的钩子已由单测覆盖，但**没有在真实 systemd 服务上跑过一次完整三段式**。
   可执行验证步骤：装好 unit 的 machost 上 → `kored upgrade --bin <new> --sha256 <hex>` → `systemctl is-active kore` = active → `cat <state>/upgrade-result.json` 的 `state` 应为 `success`、`version` 应为新版本 → `kored version` 显示新版本。
2. **卸载自卸载路径未真机跑**（会真的删 unit/二进制/用户，本轮不做破坏性实测）：单测层未新增（`uninstall_test.go` 不在本次写域），仅代码审查 + 既有 20 个卸载单测仍全绿。
3. **硬链备份不可用的回退分支**（`os.Link` 失败 → 拷贝）未构造真实失败场景，只走读代码路径。

## 6. 运行态影响

本轮**未改动主实例运行态**：`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` 零写入；8787 未探测、未重启；真实 `/usr/local/bin/kored` 与 `/etc/systemd/system/kore.service` 未被触碰（实测全在 `/tmp/kore-selfmg`）。`/tmp/kore-selfmg` 验证后已删除。
