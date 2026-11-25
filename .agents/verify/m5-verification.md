# M5 独立验收报告（G-09 · m5-verifier）

- 验收对象：实现 `3a1169d` / merge `883a342`（功能验收；任务卡注明 red-team 反例「误删 / 绕过账本」由独立 red-team 任务负责，不在本报告范围）。
- 角色：`m5-verifier`，与 implementer `m5-impl` 不同人（G-09）；未复用实现者结论，全部命令自行复跑。
- 纪律：只读复跑；唯一写物 = 本报告；不 push、不联网、不执行 install/serve/upgrade 主流程、不碰真实运行态；隔离 GOCACHE 与临时目录用完已删；失败如实报告。
- 时间：2026-11-26（Asia/Shanghai）。

## 结论（PASS / FAIL 一句）

**PASS — M5「本地更新状态文件 + changes.jsonl 账本可回滚」在仓库当前 HEAD 上独立复跑通过：`go test ./cmd/kored/...`（9.223s）、`make zero-intrusion-check`（17 pass / 0 fail）、`make secret-check`、`make docs-check`、`go vet` 全部 exit 0；`gofmt -l` 对 M5 文件与整个 `cmd/kored` 包为空；7 类断言覆盖面（原子写 / 0600+uid / 单一文件 / 账本先行 / fail-closed / 显式 schema+DisallowUnknownFields / 幂等 file.remove 回滚）逐条读码+用例核对到位；G-25 仅主树、G-29 真实运行态哈希前后一致、git 顺序 `3a1169d → 883a342` 正确，无阻断项。**

## 1. 环境与基线

| 项 | 值 |
| --- | --- |
| 工作目录 | `/home/pt/Work/GolandProjects/kore-pl/kore` |
| go version | `go version go1.26.8 linux/amd64` |
| GOWORK | `off`（所有复跑显式导出） |
| GOCACHE（本次复跑） | `/home/pt/Work/GolandProjects/kore-pl/.tmp/m5-verify-gocache`（工作区外 kore 根的 `.tmp/`，复跑后已删） |
| 脚本内建缓存 | `scripts/zero-intrusion-check.sh` 自带 `GOCACHE=$ROOT/.gocache-m5`（脚本执行后已删） |
| 复跑时 HEAD | 首轮 `ee2e1de6451d0bb7ce4d4eceab3b79965046d7a3`；复跑期间并发落地 `1ade712`（m4-verifier 验收报告），已复核 `3a1169d`、`883a342` 仍是当前 HEAD 祖先，M5 代码未被覆盖 |
| 默认 GOCACHE | `/home/pt/.cache/go-build`（存在但本次未使用，见硬纪律；隔离缓存均为工作区内临时目录） |

## 2. 复跑命令 + 退出码 + 关键输出

### 2.1 `go test cmd/kored`（任务卡 1）

```
$ cd <repo> && GOCACHE=<workspace>/.tmp/m5-verify-gocache GOWORK=off \
    go test -count=1 -timeout 200s ./cmd/kored/...
ok  	github.com/pengtang1024/kore/cmd/kored	9.223s
exit code: 0
```

verbose 复跑（确认 M5 用例非空跑；夹具用例未设环境变量时按设计 SKIP，已在 2.2 由门禁实跑）：

```
=== RUN   TestZeroIntrusionFixture        --- SKIP（KORE_ZI_STATE_DIR 未设置：门禁专用夹具，符合设计）
=== RUN   TestUpdateStatePathRejectsOutOfWhitelist      --- PASS
=== RUN   TestWriteUpdateStateAtomicLedgerAndMode       --- PASS
=== RUN   TestWriteUpdateStateOverwriteRegistersBeforeWrite --- PASS
=== RUN   TestWriteUpdateStateFailClosedOnBadLedger     --- PASS
=== RUN   TestWriteUpdateStateRejectsUnknownPhaseAndCredentialField --- PASS
=== RUN   TestReadUpdateStateRejectsUnknownPhase        --- PASS
=== RUN   TestPurgeUpdateStateRemovesFileAndLedgerEntryStays --- PASS
=== RUN   TestExecutePurgeOpFromLedger                   --- PASS
PASS / ok / exit code: 0
```

### 2.2 `make zero-intrusion-check`（任务卡 2）

```
$ GOCACHE=<workspace>/.tmp/m5-verify-gocache GOWORK=off make zero-intrusion-check
[RUN ] zero-intrusion-check（ADR-0023）
[INFO] 隔离安装根：/home/.../kore/.zero-intrusion-tmp.VZZ0CJ（不设 KORE_HOME / --config，验证 portable 默认推导）
[PASS] 构建隔离二进制（<install>/bin/kored）
[PASS] 隔离实例就绪，socket 落在安装目录内：.../.zero-intrusion-tmp.VZZ0CJ/run/kore.sock
[PASS] UDS /-/healthz = 200
[PASS] portable 目录已创建：<install>/data
[PASS] portable 目录已创建：<install>/run
[PASS] portable 目录已创建：<install>/logs
[PASS] 状态库落在 <install>/data/state.db
[PASS] 隔离实例写入状态文件（隔离目录 .../.zero-intrusion-tmp.VZZ0CJ/zi-state，不碰真实 <install>/data）
[PASS] 状态文件权限 0600（实际 600）
[PASS] 全系统仅一个更新状态文件（实际 1 个）
[PASS] 账本含该状态文件的 file.remove 条目（有状态文件 ⟹ 可回滚）
[PASS] 账本权限 0600
[PASS] 按账本回滚后状态文件不存在（uninstall --purge 语义）
[PASS] 系统路径零新增（/etc/kore、/var/lib/kore、/var/log/kore、/run/kore）
[PASS] 未新建 kore-* 系统用户（portable 非 root 实例不应建）
[PASS] 未新建 kore-* 系统组
[PASS] 未新建 kore systemd unit
[INFO] 运行前已存在的 kore-* 用户/组与 kore.service unit（ADR-0023 §3.5 豁免 #1/#2，允许存在）
zero-intrusion-check: 17 pass, 2 info, 0 fail
结果: 门禁通过（零侵入：安装目录外零新增；豁免项仅作说明）
exit code: 0
```

隔离性核对（读 `scripts/zero-intrusion-check.sh`）：隔离根用 `mktemp -d "$ROOT/.zero-intrusion-tmp.XXXXXX"`；不设 `KORE_HOME`、不传 `--config`，`kored serve` 走可执行文件位置推导的 portable 默认路径；夹具 `KORE_ZI_STATE_DIR` 指向 `$TMP/zi-state`；删除目标从账本 `args` 解析且校验等于 `$STATE_FILE` 后才 `rm -f`，只删隔离目录内文件；退出时 `trap cleanup` 删除整个临时根。**未碰真实 `<install>/data`，未碰任何 `.kore-local-*`。**

### 2.3 `make secret-check` + `make docs-check`（任务卡 3）

```
$ make secret-check
[RUN ] secret-check
secret-check: 0 FAIL / 23 处匹配（占位写法均合规）
exit code: 0

$ make docs-check
[RUN ] docs-check
[INFO] 文档计数: 124 份 · 证据计数: 301 份
[PASS] 必需文件齐全：16 项 + docs/DECISIONS 52 篇
[PASS] 全部 124 份文档元信息合规
[PASS] 检查 1275 条相对链接，全部可达
[PASS] 占位词密度合规（全部 ≤ 2 次）
[WARN] 行数越界 9 份（WARN，不阻断；均为既有 docs/CORE.md / DETAIL.* / SECURITY.md，非 M5 新增文档）
[PASS] 关键口径覆盖达标
docs-check: 5 pass, 1 warn, 0 fail
结果: 门禁通过（1 WARN 不阻断）
exit code: 0
```

M5 文档增量核对（`git diff fb7c82f 883a342 -- docs/DATA-MODEL.md docs/RUNBOOK-INSTALL.md`）：`DATA-MODEL.md` §9.2 给出 `update-state.json` 字段表（全 string）、0600/当前 uid、原子写、账本先行 fail-closed、`DisallowUnknownFields` 无凭据字段、白名单 `file.remove` 回滚与 U3 三类禁止；`RUNBOOK-INSTALL.md` §6 给出 `uninstall --yes --purge` 与手工回滚命令（含 `chmod 600` 与「状态文件消失 + 账本无幽灵条目」断言）。schema 与回滚说明均在位。

### 2.4 `go vet` + `gofmt`（任务卡 4）

```
$ GOCACHE=<isolated> GOWORK=off go vet ./cmd/kored/...
exit code: 0（无输出）

$ gofmt -l cmd/kored/selfupdate_state.go cmd/kored/selfupdate_state_test.go
<empty>   exit code: 0
$ gofmt -l cmd/kored/*.go
<empty>   exit code: 0
$ gofmt -l $(git ls-files '*.go')
internal/core/auth/auth_test.go, internal/core/auth/session.go, internal/core/auth/username_test.go,
internal/core/config/types.go, internal/core/httpapi/{handlers_password*,handlers_security*,
handlers_sessions*,handlers_site_import*,selfupdate_local_test.go,server.go}（共 14 份）
说明：这 14 份均为仓库既有未格式化文件，全部不在 M5 diff（fb7c82f..883a342）内，也不在 cmd/kored 包内——非 M5 引入，不阻断本次验收。
```

### 2.5 git / G-25 / G-29（任务卡 5）

```
$ git show --no-patch --format='%H %P %s' 3a1169d
3a1169df368ab87623dc3eac859bb0fbfeee427e fb7c82ff434129b351252b09824bed0f3deb5e82
  [agent:m5-impl] feat(cmd/kored): M5 本地更新状态文件与账本可回滚
$ git show --no-patch --format='%H %P %s' 883a342
883a342978071d90092503ea41eef7fc1de17cec fb7c82ff434129b351252b09824bed0f3deb5e82 3a1169df368ab87623dc3eac859bb0fbfeee427e
  [agent:m5-impl] merge: M5 本地状态文件（wt-m5 → main）
$ git merge-base --is-ancestor 3a1169d 883a342 && echo '3a1169d IS ancestor of 883a342'
3a1169d IS ancestor of 883a342
→ 顺序正确：实现 3a1169d 先、merge 883a342 后（merge 第二父即实现提交）；当前 HEAD 仍包含两者。

$ git worktree list
/home/pt/Work/GolandProjects/kore-pl/kore 1ade712 [main]
$ git branch --list 'wt-*' 'tmp-*'
<empty>
→ G-25 通过：仅主工作树，无 wt-m5 残留、无临时分支。

G-29 真实运行态哈希（复跑前 == 复跑后）：
  .kore-local.yaml    sha256 9d5de744fb685f4f569b6819b4c3e122e98f99e591db09fb68afda4ba43bd56e
  bin/kored           sha256 7f768e4e0919e42662d1946a7e13467cf6a7cd55e011b88cd1288e72477203fc
  .kore-local-{state,run,log} 全文件哈希摘要 fe3b638ada9dca160d3c27f0943539c610bf7f67e7631fc8474c837c01aef706
→ 三组哈希前后完全一致；本轮未改动主实例运行态配置、未重启 8787、未执行任何 CLI install/serve/upgrade 主流程。
→ git status --porcelain 前后一致：除本验收报告外，只有既有 `M scripts/usability-pending.txt` 与既有未跟踪证据/产物
  （.agents/verify/e2e-*, data/, dist/, .gocache-m5/ 等为他人产物，未由本轮提交）。
```

## 3. 断言覆盖面结论（读码 + 用例双向核对）

| # | 判据 | 代码证据（`cmd/kored/selfupdate_state.go`，除注明） | 用例/门禁证据 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 原子写：临时文件 + fsync + rename + 目录 fsync | L147 `os.CreateTemp(dir, ".update-state-*")`；L161 `Chmod(0600)`；L164 写；L167 `tmp.Sync()`；L173 `os.Rename`；L179–182 `os.Open(dir)` + `dh.Sync()`；失败路径 `defer` 清理临时文件（L152–158） | `TestWriteUpdateStateAtomicLedgerAndMode` 断言目录内无 `.update-state-*` 残留；fsync 调用属代码级核对（文件元数据层无稳定断言手段） | 覆盖 |
| 2 | 0600 + 当前 uid | L147 `CreateTemp` 在同目录创建（天然继承 kored 进程 uid：root 服务即 root，portable 即当前用户）；L161 显式 `Chmod(0o600)` 固化不受 umask 影响 | 单测断言状态文件与账本权限均为 `0600`；门禁实测 `MODE=600` | 覆盖（mode 有断言，uid 由 CreateTemp 语义保证，无独立 uid 断言） |
| 3 | 全系统仅一个文件 | L26 固定文件名 `update-state.json`；L65–87 `updateStatePath` 拒绝空/相对/`..`/根/清单外系统目录，且不提供路径注入；grep 显示生产代码无第二写入点 | 门禁断言隔离状态目录内 `update-state*` 计数 == 1；单测断言 `Base(path)` 等于唯一文件名 | 覆盖（以固定文件名 + 无第二写点保证系统级唯一性；门禁计数限于隔离状态目录） |
| 4 | 创建/覆写前先 appendChange（`purge_op=file.remove`） | L106–117 `recordUpdateStateChange` 用 `changeEntry{PurgeOp: &purgeOp{Kind: purgeKindFileRemove, Args: []string{path}}, Reversible: true}`；L133–135 在任何目录创建/写盘之前调用；`changes.go` L82–113 保证 append-only + 0600 + fsync | `TestWriteUpdateStateOverwriteRegistersBeforeWrite` 断言两次写入 → 2 条账本记录且均为 `file.remove`；`TestWriteUpdateStateAtomicLedgerAndMode` 断言账本条目 target 指向实际文件且账本 0600；门禁 grep 账本含 `file.remove` + `update-state.json` | 覆盖 |
| 5 | 登记失败 fail-closed 不写盘 | L133–135：账本登记出错即 `return`，目标文件零字节未动；L130 校验失败也在登记前 return | `TestWriteUpdateStateFailClosedOnBadLedger` 把账本路径占为目录 → 写状态文件报错且目标文件不存在；`TestWriteUpdateStateRejectsUnknownPhaseAndCredentialField` 断言校验失败不产生账本条目 | 覆盖 |
| 6 | 显式 schema + `DisallowUnknownFields` 拒凭据字段 | L40–49 `updateState` 8 个 string 字段（无 object/any/`map[string]any`）；L91–102 phase 白名单 + target_version 必填；L197–198 `dec.DisallowUnknownFields()` | `TestWriteUpdateStateRejectsUnknownPhaseAndCredentialField` 手工写含 `"password"` 字段样本 → 严格读取必须失败；`TestReadUpdateStateRejectsUnknownPhase` 拒绝未知 phase；`make secret-check` 0 FAIL 佐证无明文凭据落文档/证据 | 覆盖 |
| 7 | 白名单 `file.remove` 幂等回滚 | L211–216 `purgeUpdateState` → `executePurgeOp`；`changes.go` L154–167 白名单 switch + `validatePurgePath` + `os.IsNotExist` 视为成功（幂等），未知 kind 拒绝 | `TestPurgeUpdateStateRemovesFileAndLedgerEntryStays` 连续两次 purge 成功且账本条目保留；`TestExecutePurgeOpFromLedger` 模拟 `uninstall --purge` 逐条执行账本 `PurgeOp` 后文件消失；门禁从账本解析 target 后删除并断言文件不存在 | 覆盖 |

U3 三类排除（读 `git diff fb7c82f 883a342` 全部 5 个文件 + 关键字扫描）：diff 中唯一出现 `kore.service` 的位置是测试夹具 `Unit` 元数据字符串（`selfupdate_state_test.go:32`），**没有**新建 systemd unit / 系统用户 / 常驻任务落盘；`systemctl`/`useradd`/`groupadd`/`crontab` 无新增调用；`zero-intrusion-check.sh` 实测「未新建 kore-* 用户/组」「未新建 kore systemd unit」均 PASS。U3 排除成立。

## 4. 硬纪律自检

| 要求 | 实际 |
| --- | --- |
| 只读复跑、唯一可写 = 本报告 | 是；除本报告未新增/修改任何仓库文件（既有他人未提交改动未动） |
| 不 push / 不联网 / 不执行 CLI 主流程 | 是；无网络命令；未执行 install/serve/upgrade 主流程（门禁脚本内部起隔离实例属其判据本体，非主实例） |
| 不碰真实运行态 | 是；G-29 三组哈希前后一致 |
| 隔离临时目录用完删 | 是；`.tmp/m5-verify-gocache`、`.gocache-m5` 均已删；脚本 `.zero-intrusion-tmp.*` 由 trap 自动清理，复核无残留 |
| 失败如实报告 | 是；`gofmt -l` 全仓 14 份既有未格式化文件、docs-check 1 WARN、夹具用例常规 SKIP 均如实披露，均非 M5 阻断项 |
| 提交 | 精确 `git add .agents/verify/m5-verification.md` + `git commit -s -m '[agent:m5-verifier] docs(verify): ...' -- <同一路径>`；不 push |

## 5. 一句话结论

**PASS — M5 功能验收在 G-09 独立复跑下全绿，断言覆盖面完整，G-25/G-29/U3/G-30/G-06 均无阻断项；red-team 反例由独立任务负责，不在本功能验收范围。**
