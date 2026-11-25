# M5 红队对抗验证报告（G-09 · m5-redteam）

- 攻击对象：M5「本地状态文件 `update-state.json` + `changes.jsonl` 账本可回滚」，实现提交 `3a1169d`、验收 `e228047`（本轮 HEAD）。
- 角色：`m5-redteam`，与 implementer `m5-impl` / verifier `m5-verifier` 均不同人（G-09）。
- 纪律：只读对抗；不改生产代码、不 commit 生产改动、不 push、不联网、不执行 install/serve/upgrade 主流程 CLI；不碰真实 `<install>/data` 与 `.kore-local-*`；唯一可写 = 本报告；隔离 GOCACHE / 临时目录用完已删。
- 时间：2026-11-26（Asia/Shanghai）。

## 结论（一句）

**发现 4 个缺陷（1×P2、3×P3/P2-P3），不是无绕过 PASS。** 核心不可绕过项（账本登记 fail-closed、无第二写点、凭据字段大小写变体全拒、字符串路径穿越全拒、状态文件 0600 无暴露窗口）均确实成立；但「有状态文件 ⟹ 有可回滚账本条目」只在首次写入路径成立，**删除账本后读路径无 fail-closed/告警（D-1）**；**账本 `purge_op` 的路径参数无范围约束，篡改后可删/改名任意绝对路径（D-2）**；**路径边界校验不解析 symlink（D-3）**；**已存在的账本文件权限过松时不被收紧到 0600（D-4）**。四项均给出可复现路径，已回派 lead 交 m5-impl 裁决/修复。

## 1. 测试环境与隔离方法

| 项 | 值 |
| --- | --- |
| 工作目录 | `/home/pt/Work/GolandProjects/kore-pl/kore` |
| 被测代码 | HEAD `e228047`，M5 生产文件 `cmd/kored/{selfupdate_state,changes,uninstall}.go`（`git status` 对三者为空，未改） |
| 隔离副本 | `.tmp/m5-redteam/repo`（`git archive HEAD | tar -x`，另从工作树补 `web/dist` 65 个 embed 产物使 `cmd/kored` 可编译）；该目录被 `.gitignore:19 .tmp/` 忽略 |
| 攻击手段 | 在隔离副本内新增 `cmd/kored/zz_redteam_test.go`（仅测试文件，调本包未导出函数），构造恶意输入/误用场景；**生产副本零改动** |
| GOCACHE | `.tmp/m5-redteam/gocache`（隔离；用完删） |
| 命令统一前缀 | `GOWORK=off GOCACHE=<workspace>/.tmp/m5-redteam/gocache go test -count=1 -timeout 200s -v -run 'TestRedTeam' ./cmd/kored/` |
| 运行日志 | `.tmp/m5-redteam/redteam-run1.log`、`redteam-run2.log`（用完删；关键输出已抄进本报告） |
| go version | `go version go1.26.8 linux/amd64` |

隔离副本先跑基线证明测试床有效：

```
$ cd .tmp/m5-redteam/repo && GOWORK=off GOCACHE=.../gocache go test -count=1 -timeout 200s ./cmd/kored/...
ok  github.com/pengtang1024/kore/cmd/kored  9.982s
exit code: 0
```

主对抗套件（16 个 Test + 11 个 credential 子用例）：

```
$ cd .tmp/m5-redteam/repo && GOWORK=off GOCACHE=.../gocache \
    go test -count=1 -timeout 200s -v -run 'TestRedTeam' ./cmd/kored/
PASS  ok  github.com/pengtang1024/kore/cmd/kored  0.015s
exit code: 0
```

> 说明：Go 测试整体 EXIT 0 表示「对抗脚本全部执行完毕」，不代表「无不安全行为」——不安全行为由各用例 `t.Logf` 原样记录，逐场景判定在下面给出。所有 `t.Errorf`（硬断言失败）均为 0，即被测实现**没有违反它自己代码里已断言的那部分契约**；缺陷来自设计声明与实现行为之间的差距。

## 2. 逐场景：命令 + 退出码 + 实际行为 + 结论

### 场景 1 · 绕过登记写盘

**S1-a 账本出口不可写 → fail-closed**
构造：`os.Mkdir(changesPath(state), 0700)` 占住账本路径，调 `writeUpdateState(state, testUpdateState())`。
```
[REDTEAM S1] fail_closed: writeUpdateState 返回 err=更新状态: 账本登记失败，拒绝写状态文件: changes: 打开账本失败: .../changes.jsonl: is a directory
[REDTEAM S1] target_absent: 状态文件不存在，fail-closed 成立
--- PASS: TestRedTeam_S1_FailClosedOnBadLedger
```
退出码：测试 0；被测函数返回非 nil error，目标文件零字节未动。
**结论：与设计一致（契约 1：登记失败即拒绝写盘）。**

**S1-b 是否存在第二写点 / 可 bypass 的导出函数**
构造：扫描隔离副本内全部生产 `.go`（排除 `_test.go`），统计 `os.WriteFile` / `os.Create` / `CreateTemp` / `os.Rename` 命中 `update-state` 的行；另核对 4 个入口函数全为小写（未导出）。
```
[REDTEAM S1] writer_candidate: selfupdate_state.go: tmp, err := os.CreateTemp(dir, ".update-state-*")
[REDTEAM S1] writer_count: 生产 .go 中写 update-state 的位置数=1（期望 1：writeUpdateState 的 CreateTemp/Rename）
--- PASS: TestRedTeam_S1_SecondWritePoint
```
退出码：0。
**结论：与设计一致（唯一写点，无第二套、无导出 bypass 面）。**

**S1-c 完全绕过模块 API（直接 `os.WriteFile`）后的读路径**
构造：不调 `writeUpdateState`，直接写合法 JSON 到 `<state>/update-state.json`，再调 `readUpdateState` 与 `updateStateLedgerHasRemove`。
```
[REDTEAM S1] read_without_ledger: 无账本时 readUpdateState err=<nil> state={Phase:pending TargetVersion:0.2.0 ...}
[REDTEAM S1] ledger_probe: updateStateLedgerHasRemove=false err=<nil>
--- PASS: TestRedTeam_S1_DirectWriteStateNoLedger
```
退出码：0。
实际行为：旁路写入的状态文件被当作合法状态读取；账本探针虽返回 false，但**生产代码中 `updateStateLedgerHasRemove` 只有定义、无任何调用者**（`grep` 核验：`selfupdate_state.go:221` 为唯一命中，仅门禁用），读路径不 fail-closed。
**结论：缺陷 D-1（与场景 3 同源，见下）。**

### 场景 2 · 账本篡改：漏删 / 误删

**S2-a 删掉账本中指向状态文件的条目**
构造：正常写一次 → 从 `changes.jsonl` 过滤掉含 `update-state.json` 的行 → 真实 `runUninstallWith([]string{"--yes","--purge"}, ...)`（注入假依赖，`removeAll=os.RemoveAll`，`euid=1000` 跳过宿主清理）。
```
[REDTEAM S2] tampered_ledger: 删条目后账本剩 0 条
[REDTEAM S2] real_uninstall_exit: runUninstallWith --purge 退出码=6
[REDTEAM S2] real_uninstall_executed: 账本被删条目后实际执行 purge 条数=0
[REDTEAM S2] no_warn: uninstall 未就账本条目被删发出任何告警（静默少执行 purge）
--- PASS: TestRedTeam_S2_RealUninstallPurgeOnTamperedLedger
```
退出码：命令 0；uninstall 返回 6（非 root 部分完成，符合其设计）。
实际行为：`--purge` 执行的 purge 数为 0，但 `removeAll(stateDir)` 随后删除整个状态目录，状态文件随目录消失（portable 默认 `<state>/update-state.json` 位于 stateDir 内）。
**结论：不对称——「漏执行 purge」成立，但「状态文件残留」在默认路径被 `removeAll` 兜底，故不算漏删残留；未告警属于 D-1 的同类缺口。**

**S2-b 把 `file.remove` 改成其他 kind**
构造：把账本条目的 `"kind":"file.remove"` 替换为 `"shell.exec"` / `"file.restore"`（后者把 args 改成 `["<src>","<victim>"]`），逐条 `executePurgeOp`。
```
[REDTEAM S2] tampered_shell.exec: executePurgeOp err=未知 purge kind "shell.exec"（仅支持 file.remove / file.restore）
[REDTEAM S2] tampered_file.restore: executePurgeOp err=<nil>
[REDTEAM S2] restore_effect: victim 存在=true src 存在=false
--- PASS: TestRedTeam_S2_TamperPurgeOpToOtherKind
```
退出码：0。
实际行为：未知 kind 被拒（好）；但改成 `file.restore` 后 purge 真的把任意 `src` 改名覆盖 `victim`（`os.Rename`），原 `src` 消失、`victim` 被覆盖。
**结论：缺陷 D-2 的一部分——账本篡改可造成"误删/误覆盖他人文件"，kind 白名单不足以约束范围。**

**S2-c 把 `file.remove` 的 args 改成 stateDir 外的绝对路径**
构造：在另一个临时目录造 `outside-victim.txt`，把账本条目的 `args` 改成该绝对路径，`validatePurgePath` + `executePurgeOp`。
```
[REDTEAM S2] validate_outside: validatePurgePath(outside) err=<nil>
[REDTEAM S2] purge_outside: executePurgeOp err=<nil>
S2 观察：账本篡改可让 purge 删除 stateDir 之外、任意规范绝对路径上的文件（validatePurgePath 只挡 / 与 ..）
--- PASS: TestRedTeam_S2_TamperedPathDeletesOutsideStateDir
```
退出码：0。实际行为：清单外文件被删除。
**结论：缺陷 D-2（核心）。`validatePurgePath` 只校验绝对/非根/无 `..`，不校验"是否属于本状态目录/本账本登记的目标"，篡改账本即可把 `uninstall --purge` 变成任意绝对路径删除器。**

### 场景 3 · 误删回滚材料成孤儿

**S3-a 删除账本后读状态文件**
构造：正常写一次 → `os.Remove(changesPath(state))` → `readUpdateState` + `updateStateLedgerHasRemove`。
```
[REDTEAM S3] before_delete: 删除账本前 ledgerHasRemove=true
[REDTEAM S3] after_delete_read: 删账本后 readUpdateState err=<nil> state={Phase:pending TargetVersion:0.2.0 PreviousVersion:0.1.1 ...}
S3 观察：账本被删后，状态文件仍可被读取为合法状态——无 fail-closed、无告警，成为孤儿状态文件
[REDTEAM S3] after_delete_probe: 删账本后 ledgerHasRemove=false（该探针不被读/写路径调用）
--- PASS: TestRedTeam_S3_DeleteLedgerThenReadState
```
退出码：0。实际行为：`readUpdateState` 仅做 schema + phase 校验，不检查账本对应条目；孤儿状态文件被静默接受。
**结论：缺陷 D-1。设计文档 `DATA-MODEL.md` §9.2 声称"有状态文件 ⟹ 有可回滚账本条目"，但该不变式只在写入时刻由 `writeUpdateState` 保证，读/运行期不复核、不告警。**

**S3-b 删除 `.prev` 回滚材料**
构造：正常写状态 → 在同目录造 `kored.prev` 再删 → 读状态。
```
[REDTEAM S3] prev_deleted: 删 .prev 后 readUpdateState err=<nil> phase=pending
S3 观察：M5 状态文件不引用 .prev，删 .prev 不影响其读取；M5 层无 .prev 一致性告警（.prev 属 upgrade.go 职责）
--- PASS: TestRedTeam_S3_DeletePrevMaterial
```
退出码：0。
**结论：与设计一致（`.prev` 归 `upgrade.go`；M5 状态文件不持有其引用）。但组合 S3-a+S3-b（账本与 `.prev` 同失）后状态文件仍自称 `pending` 且无任何回滚能力，进一步放大 D-1。**

### 场景 4 · 凭据注入（含大小写变体）

构造：直接在 `<state>/update-state.json` 写入带未知字段的 JSON（值统一用脱敏占位 `***`，不落明文凭据），逐一喂给 `readUpdateState`。

```
=== RUN TestRedTeam_S4_CredentialFieldVariants
[REDTEAM S4] password:  ... json: unknown field "password"
[REDTEAM S4] Password:  ... json: unknown field "Password"
[REDTEAM S4] PASSWORD:  ... json: unknown field "PASSWORD"
[REDTEAM S4] secret:    ... json: unknown field "secret"
[REDTEAM S4] Secret:    ... json: unknown field "Secret"
[REDTEAM S4] SECRET:    ... json: unknown field "SECRET"
[REDTEAM S4] token:     ... json: unknown field "token"
[REDTEAM S4] Token:     ... json: unknown field "Token"
[REDTEAM S4] TOKEN:     ... json: unknown field "TOKEN"
[REDTEAM S4] passwd:    ... json: unknown field "passwd"
[REDTEAM S4] api_key:   ... json: unknown field "api_key"
--- PASS（11/11 子用例全部拒绝）
[REDTEAM S4] known_case_variant: {"Phase","Target_Version"} readUpdateState err=<nil>
--- PASS: TestRedTeam_S4_CaseVariantOfKnownField
```
退出码：0（测试）；未知字段子用例均得到非 nil error。
实际行为：`DisallowUnknownFields` 对 11 种凭据键（含三种大小写变体）全部拒绝；已知字段的大小写变体（`Phase` / `Target_Version`）因 `encoding/json` 大小写不敏感匹配被接受，但没有引入新键、无凭据风险。
**结论：与设计一致（G-30 凭据边界成立）。**

### 场景 5 · 路径穿越 / symlink

**S5-a 字符串路径穿越与清单外目录**
构造：10 个输入喂 `updateStatePath`。
```
relative/data            → err=状态目录必须是绝对路径
/                        → err=拒绝根状态目录
/opt/kore/data/../etc    → err=必须规范化（不得含 .. 或重复分隔符）
/opt/kore//data          → err=必须规范化（不得含 .. 或重复分隔符）
/etc/kore /var/lib/kore /var/log/kore /run/kore /usr/lib/systemd/system → err=拒绝清单外系统路径
/opt/kore/data           → /opt/kore/data/update-state.json, err=<nil>
--- PASS: TestRedTeam_S5_PathTraversalAndBoundary
```
退出码：0。**结论：与设计一致（字符串层面穿越/清单外系统目录全拒）。**

**S5-b symlink stateDir 穿透**
构造：在隔离临时目录建 `real-state/` 与指向它的 `link-state` symlink，`writeUpdateState(link-state, ...)`。
```
[REDTEAM S5] symlink_path: updateStatePath(symlink)=".../link-state/update-state.json" err=<nil>
S5 观察：符号链接 stateDir 使写盘穿透到被链接目录；updateStatePath 的字符串边界校验不解析 symlink
[REDTEAM S5] written_path: writeUpdateState 返回 path=.../link-state/update-state.json
--- PASS: TestRedTeam_S5_SymlinkStateDir
```
退出码：0。实际行为：`real-state/update-state.json` 真实生成，账本登记的 target 是 symlink 路径而非解析后路径。
**结论：缺陷 D-3。**

**S5-c symlink 指向清单外目录**
构造：在隔离临时目录建 `link-to-etc -> /etc/kore`（**只建链接，未写盘、未创建 `/etc/kore`**），仅调 `updateStatePath`。
```
[REDTEAM S5] symlink_to_forbidden: updateStatePath(".../link-to-etc")=".../link-to-etc/update-state.json" err=<nil>（未写盘）
S5 观察：symlink 指向 /etc/kore 时字符串校验放行；若调用方信任该路径，写盘将落到清单外系统目录（边界校验可被 symlink 绕过）
--- PASS: TestRedTeam_S5_SymlinkToForbiddenDir
```
退出码：0。
**结论：D-3 的证明。`updateStatePath` 不做 `EvalSymlinks` / 不让解析后路径仍落在白名单内，设计声称的"清单外路径封禁"可被符号链接绕过（本轮严守纪律未对真实 `/etc` 写盘）。**

### 场景 6 · 0600 权限竞态

**S6-a umask=000 下的最终权限与临时文件窗口**
构造：`syscall.Umask(0)` → 后台 goroutine 以 50µs 轮询目录里的 `.update-state-*` → `writeUpdateState` → 核对最终权限。
```
[REDTEAM S6] final_mode: umask=000 下状态文件权限=0600（期望 0600）
[REDTEAM S6] temp_observations: rename 前临时文件观测 0 次：map[]
[REDTEAM S6] createtemp_default: umask=000 下 CreateTemp 默认 mode=0600
--- PASS: TestRedTeam_S6_ModeUnderUmask000 / TestRedTeam_S6_CreateTempDefaultMode
```
退出码：0。实际行为：`CreateTemp` 在 umask=000 下默认就是 0600，且代码显式 `Chmod(0600)`；轮询未观察到任何非 0600 的临时文件窗口（写盘太快，0 次采样；由 CreateTemp 默认 0600 的独立断言补足证据）。
**结论：与设计一致（无 0644 暴露窗口）。**

**S6-b 已存在的账本文件权限过松**
构造：先 `os.WriteFile(ledger, "", 0644)` 预置账本，再 `writeUpdateState`，核对账本权限。
```
[REDTEAM S6] preexisting_ledger_mode: 预置 0644 账本在一次追加后权限=0644（设计声称账本 0600）
S6 观察：账本已存在时 OpenFile 不收紧权限，预置的 0644 会持续暴露账本内容（凭据边界/权限竞态缺口）
--- PASS: TestRedTeam_S6_PreexistingLedgerLooseMode
```
退出码：0。实际行为：`appendChange` 用 `os.OpenFile(..., O_APPEND|O_CREATE|O_WRONLY, 0600)`，mode 参数对已存在文件无效，`0644` 保持不变。
**结论：缺陷 D-4。**

## 3. 缺陷清单（回派 lead → m5-impl 裁决/修复）

| ID | 严重度 | 现象 | 复现（最小） | 影响 | 期望 | 建议验收 |
| --- | --- | --- | --- | --- | --- | --- |
| **D-1** | P2 | 删账本/旁路写状态后，`readUpdateState` 静默接受孤儿状态文件，无 fail-closed、无告警；`updateStateLedgerHasRemove` 生产代码零调用 | 写一次状态 → `rm <state>/changes.jsonl` → 调 `readUpdateState` 仍返回 nil error | 设计不变式「有状态文件 ⟹ 可回滚」只在写入时刻成立；误删回滚材料后系统仍把状态当真，无法回滚 | 读路径 fail-closed 或至少 WARN；或明确在文档声明读与账本解耦并由门禁兜底 | M5 加用例：删账本后读必须报错/告警；`grep` 确认读路径调用账本探针 |
| **D-2** | P2 | 账本 `purge_op` 的 `args` 无范围约束：改成 stateDir 外绝对路径即删任意文件；改成 `file.restore` 可改名覆盖任意文件 | 篡改 `changes.jsonl` 的 `args` / `kind` → `uninstall --purge`（或 `executePurgeOp`）真实执行 | 账本可逆性机制被反过来当任意删除/覆盖原语；与设计"回滚只按登记的范围执行"不符 | `executePurgeOp` 增加"目标必须在登记范围内"约束；M5 的 `kore` 来源条目应仅允许 `file.remove` 且 target 必须等于 `updateStatePath(stateDir)` | 反例用例：篡改后的外路径/restore 必须被拒 |
| **D-3** | P2-P3 | `updateStatePath` 只做字符串 Clean/前缀判断，不解析 symlink；symlink 可把写盘导向清单外目录 | 建 `link -> /etc/kore`（本轮未写盘）→ `updateStatePath(link)` 放行；在隔离目录实测 symlink 穿透写盘成功 | "清单外路径封禁"可被绕过；属 G-31 零侵入边界风险 | `EvalSymlinks` 后复核解析路径仍在白名单；或对 stateDir 拒绝 symlink 分量 | 反例用例：symlink 指向清单外目录时 `writeUpdateState` 必须拒绝 |
| **D-4** | P3 | 账本文件预置为 0644 后，`appendChange` 不收紧权限，0600 契约失效 | `os.WriteFile(changesPath(state),"",0644)` → `writeUpdateState` → 账本仍 0644 | 账本含变更目标路径，松散权限造成信息暴露窗口 | 对已存在的账本显式 `Chmod(0600)`（或 O_NOFOLLOW + stat 校验） | 用例：预置 0644 后追加一次，权限必须回到 0600 |

> 严重度口径：D-1/D-2/D-3 均要求攻击者已具备对状态目录/账本的文件写权限（即已越过一层边界），故不评 P1；但它们直接推翻了 M5 声明的"可回滚 + 零侵入"两条核心不变式，必须修或显式改文档收窄声明。D-4 是纵深加固项。

## 4. 硬纪律自检

| 要求 | 实际 |
| --- | --- |
| 只读对抗、不改生产代码 | 是；`git status --short cmd/kored/selfupdate_state.go cmd/kored/changes.go cmd/kored/uninstall.go` 为空；HEAD 仍 `e228047` |
| 唯一可写 = 本报告 | 是；所有攻击测试写在 `.tmp/m5-redteam/repo`（git-ignored 隔离副本），生产仓库未新增/修改其他文件 |
| 不碰真实 `<install>/data` / `.kore-local-*` | 是；所有路径来自 `t.TempDir()` / 隔离副本；S5-c 只建指向 `/etc/kore` 的符号链接，未写盘、未创建该目录 |
| 不执行主流程 CLI / 不联网 / 不 push | 是；只跑 `go test` 与只读 `grep`/`git status`；无 install/serve/upgrade 主流程调用 |
| 临时目录/GOCACHE 用完删 | 是；`.tmp/m5-redteam/`（含 repo、gocache、两份日志）在本报告提交前删除 |
| 明文凭据（G-30） | 是；报告内凭据字段值一律 `***` 占位，未写出任何凭据键的真实取值（`make secret-check` 对本报告复核 exit 0） |
| 提交 | 精确 `git add .agents/verify/m5-redteam.md` + `git commit -s -m '[agent:m5-redteam] docs(verify): M5 红队对抗发现 4 缺陷' -- .agents/verify/m5-redteam.md`；不 push |

## 5. 一句话结论

**4 个缺陷（D-1 孤儿状态无 fail-closed / D-2 账本 purge 路径无范围约束 / D-3 symlink 绕过路径边界 / D-4 账本 0600 不收紧），已按问题单回派 lead 交 m5-impl；除这四项外，M5 声明的 fail-closed、无第二写点、凭据边界、字符串路径穿越、0600 原子写窗口均无绕过。**
