# C12 P3 生产代码隔离 VM 复验报告（task-344 / agent c12-prod-vm）

> 2026-11-28 · 执行：`c12-prod-vm`（真机验证 worker；独立于 P1/P2 实现与 P2 verifier）· 任务 `task-344`（已先 claim 再执行）。
> 复核对象：三仓当前 HEAD（P2 验收 `3aea81e` 之后的生产代码，零内联补丁）：
> - `kore` = `3aea81e57618dd3a448a4d1785a6e15b92d33b71`（main）
> - `kore-plugin-ssh-guard` = `604321ddbc81e2627817fb9adb84c88b384034af`（develop）
> - `kore-plugins` = `6f64259d75e4795e6a3d2f4a75a8e51add782ef0`（main）
> 协议 `pkg/pluginapi v0.4.0` tag peel = `4aafdfe9d8d35167b1b83ba8733e838c24fa52c5`；插件 `dist/ssh-guard-0.5.0.tar.gz` sha `c380cb6c…`（离线重建 hash 与 `go.sum` 逐字一致）。
> 唯一写域 = 本报告 `.agents/verify/c12-prod-vm.md`；不改生产代码、不 bump、不发版、不 push / tag / Release。
> **结论：PASS（六项范本全 PASS，0 新增 FAIL）。**

## 0. 结论速览（照 c13-node-ext-verification 六项范本）

| # | 验收项 | 结论 | 关键证据（命令 + 退出码 + 原文见对应小节） |
|---|---|---|---|
| ① | 后端方法/类目/deny 清单/白名单/零新依赖/root_action 形状（读码 + 单测） | PASS | `renderSuggestConfig` 复用 + `handleApply/Rollback`；`sshd.config.d` 类目 + `sshd.dropin.v1`；18 条显式 deny + 3 前缀族 + 10 条 allowlist；`go.mod` 仅 pluginapi；`TestRootActionsDeclared` 双向一致；pluginapi 单测 exit 0 |
| ② | 门禁 pluginapi + ssh-guard + kore `make check` exit 0（既有 WARN 归因、0 新增 FAIL） | PASS | pluginapi `go test -race ./...` exit 0（2 包）；ssh-guard `make check` exit 0；kore `make check` exit 0（21/21 `[OK] 门禁全部通过`）；usability WARN 已归因，0 新增 FAIL |
| ③ | 隔离断言：真生产代码重跑 C12 五场景（应用/sshd -t/sshd -T/账本逐字节且逐属性回滚/四类拒绝+fail-closed/容器密钥 SSH 连通） | PASS | Docker `alpine:3.20 --network=none` 容器 `kore-sshguard-prod`；harness 从 `git archive HEAD:3aea81e` 编译、直接 import 生产包（零内联补丁）；五场景全部断言成立，含 task-337 mode 守恒 0644 |
| ④ | 索引/版本：`validate-index` exit 0 + 0.4.1→0.5.0 bump 理由 + 六处 sha 一致 | PASS | `validate-index` exit 0（24 条全量验签）；dist 实测/`.sha256`/`index/plugins.json`/`versions.lock.json`/2 presets/market 六处 sha `c380cb6c…` 同值；bump 符合 RELEASE §1「改 dist sha 必 bump」 |
| ⑤ | G-28 双端截图实读 + 三问原文 | PASS | `identify` 实读 1440×2874 / 390×4033，sha 各异；`read_image` 亲看双端同一确认框全要素；复用 P2 `sshguard-dropin-selfeval.md` 三问原文 |
| ⑥ | git：精确 commit + DCO + 未 push + 单 worktree + 他人 dirty 原样 | PASS | 三仓 HEAD 全 `Signed-off-by` + `[agent:c12-p2*]` 前缀；`branch -r --contains` 空（未 push）；`tag --points-at` 空；各 1 worktree；他人 dirty 未触碰 |

---

## 1. ① 后端读码 + 单测核对（PASS）

### 1.1 方法与类目声明（生产代码当前 HEAD）
- **后端方法**：`kore-plugin-ssh-guard/methods.go:69-72` 派 `apply-hardening → handleApplyHardening`、`rollback-hardening → handleRollbackHardening`（`:88` 加入写类方法集）；`info.json:20-21` 声明 `ssh-guard.apply-hardening` / `ssh-guard.rollback-hardening` 均 `system:admin`，`banwrite_test.go:73 TestMethodCapabilitiesMatchMethods` 双向一致。
- **一键应用复用 suggest 渲染**：`hardening.go:93-146 handleApplyHardening` 调 `renderSuggestConfig(p)`（`suggest.go:98`）拿正文，经 `guardFileWrite(rootActionSSHDWrite, dropInFileName, content)` 写；`rootActionClient.WriteFile`（`rootaction_client.go:152-158`）请求体只含文件名 + 正文，目录不在请求里。单测 `hardening_test.go:51 TestApplyReusesSuggestRenderAndWritesDropIn` 断言 `call.content == suggest.config_text` 逐字节同源且含 `PasswordAuthentication no`/`MaxAuthTries 3`。
- **回滚账本校验**：`hardening.go:154-210 handleRollbackHardening` 读 `<state>/changes.jsonl`，筛 `plugin=ssh-guard && action=sshd-dropin-write`，校验 `Reversible`+`PurgeOp`；`validateLedgerPurgeOp`（`:243-277`）kind 白名单/绝对路径/目录归属 fail-closed；再经内核 `sshd-dropin-delete` 受控删除（删前强制备份 + 账本 `file.restore`），不执行 shell。`TestRollbackReadsLedgerAndCallsControlledDelete` / `TestRollbackFailClosed` / `TestLedgerPurgeOpValidation` 覆盖。

### 1.2 协议类目 + deny 清单 + 白名单（唯一真源）
- **类目**：`kore/pkg/pluginapi/filewrite.go:85-112 FileWritePrefixClasses` 唯一真源含 `sshd.config.d`（`Dir=/etc/ssh/sshd_config.d/`、`Suffix=.conf`、`Mode=0644`、`ContentPolicy=sshd.dropin.v1`、`MaxBytes=MaxFileWriteContentBytes`、`Owner=root:root`、`PluginNamePrefix=true`）。
- **内容策略分派**：`filewrite.go:271-274 ValidateFileWriteContent` 的 switch 有 `case ContentPolicySSHDropin → ValidateSSHDropinFragment`，其它 policy fail-closed。
- **deny 清单**：`sshdconf.go:64-82 DeniedSSHDDirectives` **18 条**显式拒绝（`Include`/`Match`/`AuthorizedKeys*`/`AuthorizedPrincipals*`/`HostKey`/`Port`/`ListenAddress`/`Subsystem`/`ForceCommand`/`Allow*Forwarding`/`PermitTunnel`/`PermitListen`/`PermitOpen` 等逐条带理由）；`sshdconf.go:85-91 deniedSSHDPatterns` **3 条**前缀族（`AuthorizedKeys`/`AuthorizedPrincipals`/`HostKey`）防枚举漏变体；`validateSSHDDenied` 大小写不敏感。
- **allowlist**：`sshdconf.go:167-179 sshdLeafRules` **10 条** allowlist 指令（枚举/整数范围/三段 `MaxStartups` 逐项校验），默认全拒。`ValidateSSHDropinFragment`（`:188-246`）拒行内 `#`、引号/续行/`%`/`${}`/`;`/`{}`、控制字符、超长 token、指令数越界。
- **单测覆盖**（`kore/pkg/pluginapi/sshdconf_test.go`）：`TestSSHDPositiveC12Fragment` / `TestDeniedSSHDDirectivesEachRejected` / `TestDeniedSSHDDirectiveFamiliesRejected` / `TestSSHDDirectiveCaseVariantsRejected` / `TestSSHDAllowlistBoundary` / `TestSSHDUnknownDirectiveRejected` / `TestSSHDConstructRejects` / `TestSSHDContentShapeRejects` / `TestSSHDDropinProtocolClass` / `TestSSHDContentPolicyDispatch` / `TestNginxVHostRegressionStillGreen`。
  ```
  $ cd kore/pkg/pluginapi && GOCACHE=<iso> go test -count=1 -timeout 200s ./...   → exit 0
  ok  github.com/pengtang1024/kore/pkg/pluginapi          0.044s
  ok  github.com/pengtang1024/kore/pkg/pluginapi/pluginapitest 0.004s
  ```
- **零新依赖**：`kore-plugin-ssh-guard/go.mod` 仅 `require github.com/pengtang1024/kore/pkg/pluginapi v0.4.0`（无第三方）；`go list -deps -f '{{if not .Standard}}{{.ImportPath}}{{end}}' ./...` 非标准库只出现 `pluginapi` + 本模块（无 `kore/internal/*`、无新依赖）。`sshdconf.go` import 仅 `fmt`/`strconv`/`strings`/`unicode/utf8`。

### 1.3 root_action 形状 + 声明双向一致
`info.json:77-96` 两条新 root_action 与 P1 类目逐字段匹配：
| 字段 | `sshd-dropin-write` 声明 | 类目/协议 | 一致 |
| --- | --- | --- | --- |
| prefix_class | `sshd.config.d` | 类目键 | ✓ |
| mode | `0644` | `FileWriteModeRoot0644` | ✓ |
| content_policy | `sshd.dropin.v1` | `ContentPolicySSHDropin` + 有实现分支 | ✓ |
| max_bytes | `65536` | ≤ 类目上限 262144（自我收紧，合法） | ✓ |
| writes_host / target | `true` / `/etc/ssh/sshd_config.d/` | 受控写必 true / `class.Dir` 逐字 | ✓ |
| purge_op | 无（运行时生成） | 协议禁止静态 purge_op | ✓ |
`sshd-dropin-delete`：`file_delete.prefix_class=sshd.config.d`、`writes_host=true`、`target` 逐字、无静态 purge_op。`declaration_test.go:28 TestRootActionsDeclared` 断言 info.json 5 条 id ↔ 代码 5 常量双向集合相等，并对 write/delete 调 `pluginapi.ValidateRootAction` + 逐字段锁定。
  ```
  $ cd kore-plugin-ssh-guard && GOCACHE=<iso> make check   → exit 0（见 §2）
  ```

---

## 2. ② 门禁复核（PASS）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cd kore/pkg/pluginapi && GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout 600s ./...`（隔离 GOCACHE/GOMODCACHE） | **0** | `ok .../pluginapi 1.121s` + `ok .../pluginapitest 1.016s`，零 DATA RACE |
| `cd kore-plugin-ssh-guard && GOPROXY=file://<iso-proxy> GOWORK=off GOCACHE/GOMODCACHE=<iso> make check` | **0** | `gofmt: clean` / `go vet ./...` OK / `go test` 两包 ok（`tests/fault` 3.587s）/ race 段 SKIP（无 boundary） |
| `cd kore && GOPROXY=off GOSUMDB=off GOWORK=off GOCACHE=<iso> GOMODCACHE=<iso> make check` | **0** | 21/21 段齐全；末行 `[OK] 门禁全部通过`；14/21 store-check `24 pass, 0 fail, 37 warn`；17/21 五目标交叉编译 exit 0；18/21 跨仓 race 16 仓全绿；19/21 全仓 -race exit 0；20/21 WARN 级；21/21 pluginapi -race exit 0 |
| `bash scripts/validate-index.sh`（kore-plugins） | **0** | 24 条全量验签 + ed25519 + market 逐字节一致（见 §4） |

> **离线依赖说明**：本机默认 GOCACHE 只读且 `pluginapi v0.4.0` 未预缓存、禁止联网。为按原口径真跑，从 `pkg/pluginapi/v0.4.0` tag `git archive` 构造本地离线 file proxy，`go mod download` 实测 `Sum=h1:1M02oDq4jwKO/XojtHhj5/3jKFJupAZdDO7ix7EFZkg=`、`GoModSum=h1:yg6DLNEISL1kqt4tlppm2xICAaTb42zcsX1MKk8SAvU=`，与 ssh-guard `go.sum` **逐字一致** → 依赖解析到的就是含 sshd 类目的真 v0.4.0 源码。该 proxy 只用于门禁复跑，不改任何仓内文件。
>
> **既有 WARN 归因（0 新增 FAIL）**：
> - `make check` 的 20/21 usability-check 段在**他人 dirty 工作树**（`M scripts/usability-pending.txt`，被外部 agent 移除了 17 条存量豁免，含 `A1 waf`）口径下报 `0 pass, 503 warn, 1 fail`，唯一 FAIL 是 `A1 waf: ZeroParam 真跑失败 tests/e2e FAIL`（WARN 级不阻断，段末明示 `[WARN] usability-check 有 2 处新违规（WARN 级不阻断）`）。该 FAIL **不是 C12/P3 引入**：`A1 waf` 在 HEAD 版 pending 中仍是存量豁免，P3 未改 waf 一行代码。
> - 用 HEAD 版 pending + 隔离可写 GOCACHE 复跑：
>   ```
>   $ USABILITY_PENDING_FILE=<HEAD版> GOCACHE=<iso> bash scripts/usability-check.sh → exit 0
>   usability-check: 0 pass, 504 warn, 0 fail, 194 unverified
>   ```
>   0 FAIL 坐实；dirty 口径下的 1 FAIL 归因于他人 dirty 清单删条目 + 环境层，非新增。其余 WARN（A1 ssh-guard 的 `GOPROXY=off` module lookup 噪声、A2/A3/A4 存量豁免、A1 runtime-node/php/python 清单卫生）均与 P2 报告 §2.3 同口径。本轮 `make check` 阻断段全部 exit 0，**0 新增 FAIL**。

---

## 3. ③ 隔离 VM 真生产代码五场景断言（PASS）

### 3.1 隔离环境与「真生产代码」口径
- **容器**：本机 Docker `alpine:3.20`（本地镜像，`--network=none`），容器名 `kore-sshguard-prod`。宿主 sshd 二进制/openssh helper/glibc 依赖只读复制进容器 `/deps`（wrapper 经 `ld-linux-x86-64.so.2 --library-path` 加载），**全部配置与写盘在容器 `/iso/**`**；不联网装包。
- **真生产代码（非内联补丁）**：`git archive HEAD(3aea81e)` 导出 407 个 `.go` 文件到隔离目录（关键文件 sha 逐一比对与工作区一致：`cmd/kored/changes.go=2914090b…`、`cmd/kored/filewrite.go=e265a670…`、`internal/core/privilege/filewrite.go=ec4c9fd9…`、`pkg/pluginapi/sshdconf.go=8179706a…`）。harness `cmd/c12prodvm/main.go` 直接 `import` 生产包 `internal/core/privilege`、`internal/core/filewrite`、`internal/platform`、`pkg/pluginapi`，并**逐字节复制生产 `cmd/kored/changes.go`**（sha 同上）作为账本 recorder/purge 实现；**没有 C12 时的 harness-only allowlist / 内联 switch case**（那些能力已在 P1 转正进生产 `sshdconf.go`/`filewrite.go`）。harness 只做三件装配：审计 adapter（文件 JSONL，fail-closed）、`DirOverride` 指到 `/iso/etc/ssh/sshd_config.d/`、按 prefix_class 装配 FileWrite/FileDelete Options。编译：
  ```
  $ cd <iso-src> && CGO_ENABLED=0 GOPROXY=off GOWORK=off go build -trimpath -o c12prodvm ./cmd/c12prodvm  → exit 0
  ELF 64-bit static, 5046832 B, sha cf7b027be241ed072ac11b51c3bb254b33c1fc8209d4baef373dc1d9da5523b0
  $ docker cp c12prodvm kore-sshguard-prod:/deps/c12prodvm   → exit 0
  ```
  隔离哨兵主配置 `/iso/etc/ssh/sshd_config`（`Include /iso/etc/ssh/sshd_config.d/*.conf`、`PasswordAuthentication yes`、`MaxAuthTries 6`、`PermitRootLogin prohibit-password`、`UsePAM no`），sentinel drop-in `00-sentinel.conf`（0644 root:root）。基线：
  ```
  $ /deps/bin/sshd -t -f /iso/etc/ssh/sshd_config   → baseline-sshd-t-rc=0
  $ /deps/bin/sshd -T -f /iso/etc/ssh/sshd_config | grep -E '^(passwordauthentication|maxauthtries) '
  passwordauthentication yes
  maxauthtries 6
  ```
- **隔离边界自检**：宿主 `/etc/ssh/sshd_config` sha `f5f0b404…`（前后一致）、`pgrep -a sshd` 无输出（宿主 sshd 未启）、8787 `/-/healthz` = `{"status":"ok"}`（主实例未受影响）、未碰 `.kore-local-*`；应用≠reload（harness 只写 drop-in，从不 reload sshd）。

### 3.2 场景① 一键应用（PASS）
```
$ C12_STATE_DIR=/iso/data C12_ISO_DIR=/iso/etc/ssh/sshd_config.d/ C12_AUDIT_FILE=/iso/data/audit.jsonl \
  /deps/c12prodvm apply kore-ssh-guard-hardening.conf "PasswordAuthentication no\nMaxAuthTries 3\nPermitRootLogin prohibit-password\n"
RESULT {"executed":true,"exit_code":0,...,"host_change_recorded":true,"file_write":{"path":"/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf","size":75,"mode":420,"sha256":"9c4d99031776772393fb803498a157862d88ed6367e1d0582fb94c41303a518d"}}
apply-rc=0
$ stat -c '%n mode=%a owner=%U:%G size=%s' <drop-in>   → mode=644 owner=root:root size=75
$ cat /iso/data/changes.jsonl
{"ts":"...","summary":"sshd-dropin-write","plugin":"ssh-guard","action":"sshd-dropin-write","target":"/etc/ssh/sshd_config.d/","reversible":true,"purge_op":{"kind":"file.remove","args":["/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf"]}}
$ cat /iso/data/audit.jsonl   → 2 条：Phase=begin（ExitCode:-1, sha=9c4d9903…）+ Phase=end（ExitCode:0, 同 sha）；无正文，只元数据
```
**断言**：真实 root-action `file_write` 经生产 `privilege.Service.Execute → executeFileWrite → filewrite.WriteDeclared` 落盘 ✓；0644 root:root ✓；审计 begin/end ✓；changes 账本 + 运行时 `file.remove` purge_op ✓（新建文件无备份=回滚=删除，正确设计）。`root` 判定走生产 `os.Geteuid()==0`（容器内真 root），非 fake。

### 3.3 场景② `sshd -t` / `sshd -T`（PASS）
```
$ /deps/bin/sshd -t -f /iso/etc/ssh/sshd_config                 → sshd-t-rc=0
$ /deps/bin/sshd -T -f /iso/etc/ssh/sshd_config | grep -E '^(port|passwordauthentication|maxauthtries|permitrootlogin|clientaliveinterval) '
port 2222
maxauthtries 3
clientaliveinterval 300
permitrootlogin prohibit-password
passwordauthentication no                                       → sshd-T-rc=0
```
**断言**：加固片段语法正确（不会锁死）✓；`passwordauthentication no` / `maxauthtries 3` 生效 ✓。仅 `-t`/`-T` 旁证，不等于真机长时间加载（见诚实边界）。

### 3.4 场景③ 按账本逐字节且逐属性回滚（PASS，含 task-337 mode 守恒）
先二次应用（覆盖写 → 触发备份与 `file.restore`）：
```
$ /deps/c12prodvm apply kore-ssh-guard-hardening.conf "PasswordAuthentication no\nMaxAuthTries 6\nPermitRootLogin yes\n"
RESULT {"executed":true,...,"file_write":{"size":61,"sha256":"c6a0dbb3675ad3...","copy_path":"/iso/data/backups/ssh-guard/20261128T122852Z/kore-ssh-guard-hardening.conf"}}
$ tail -1 /iso/data/changes.jsonl
{...,"purge_op":{"kind":"file.restore","args":["/iso/data/backups/ssh-guard/20261128T122852Z/kore-ssh-guard-hardening.conf","/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf"]}}
$ stat -c 'mode=%a owner=%U:%G' <backup>   → mode=644 owner=root:root   ← task-337：备份保留源 mode
$ sha256sum <backup>                       → 9c4d9903…（第一次写入内容）
```
按账本最后一条 `purge_op` 回滚（生产 `cmd/kored/changes.go readChanges + executePurgeOp` → `filewrite.Restore` → `revertWrite/atomicWrite`，不执行字符串命令）：
```
$ /deps/c12prodvm purge
PURGE_OP file.restore /iso/data/backups/ssh-guard/20261128T122852Z/kore-ssh-guard-hardening.conf /iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf
PURGE_OK                                        → purge-rc=0
$ sha256sum <drop-in>   → 9c4d99031776772393fb803498a157862d88ed6367e1d0582fb94c41303a518d（与备份/第一次写入逐字节一致）
$ cat <drop-in>         → PasswordAuthentication no / MaxAuthTries 3 / PermitRootLogin prohibit-password
$ stat -c '%n mode=%a owner=%U:%G size=%s' <drop-in>  → mode=644 owner=root:root size=75   ← mode 守恒
$ /deps/bin/sshd -t -f /iso/etc/ssh/sshd_config       → sshd-t-rc=0
$ /deps/bin/sshd -T ... | grep -E '^(passwordauthentication|maxauthtries) '  → maxauthtries 3 / passwordauthentication no
```
**断言**：内容逐字节还原 ✓；**属性逐属性还原 mode 0644 root:root ✓**；`sshd -t/-T` 仍绿 ✓。**C12 报告的回滚 mode 缺陷（0600）在生产代码已修**：`cmd/kored/changes.go:180-185` 改用 `filewrite.Restore(dst, src)`（不再裸 `os.Rename`），`internal/core/filewrite/filewrite.go:412-418 copyFile` 备份时 `Chmod(源 mode)`、`:517+ Restore` 读备份 mode 经 `atomicWrite` 还原；`git merge-base --is-ancestor 1ff4230 HEAD → YES`（task-337 已合入）。本轮实测 0644 坐实修复。

### 3.5 场景④ 四类拒绝 + 审计 fail-closed 零半写入（PASS）
```
$ /deps/c12prodvm reject "../evil.conf" "MaxAuthTries 3"
REJECT err=E_INVALID: 文件名必须是单层名字（不得含路径分隔符/控制字符）  → rc=0（预期被拒即 PASS）
$ /deps/c12prodvm reject "evil.conf" "MaxAuthTries 3"
REJECT err=E_INVALID: 文件名必须以 "kore-ssh-guard-" 开头（防横向覆盖）      → rc=0
$ /deps/c12prodvm reject "kore-ssh-guard-x.sh" "MaxAuthTries 3"
REJECT err=E_INVALID: 文件名必须以 ".conf" 结尾                            → rc=0
$ /deps/c12prodvm reject "kore-ssh-guard-bad.conf" "Include /etc/shadow"
REJECT err=E_INVALID: 指令 Include 无条件拒绝——可把任意 root 可读文件拉进配置绕过 allowlist → rc=0
$ ... "AuthorizedKeysCommand /bin/sh"
REJECT err=E_INVALID: 指令 AuthorizedKeysCommand 无条件拒绝——root sshd 以命令输出当公钥，等于任意命令执行 → rc=0
$ ... "MaxAuthTries abc"
REJECT err=E_INVALID: MaxAuthTries 参数非法：参数必须是 1..100 的十进制整数（当前 "abc"） → rc=0
$ ... "MaxAuthTries 999"
REJECT err=E_INVALID: MaxAuthTries 参数非法：参数必须在 1..100 之间（当前 999） → rc=0
$ /deps/c12prodvm auditfail kore-ssh-guard-auditfail.conf "MaxAuthTries 3"
RESULT executed=false err=E_INTERNAL: 受控写失败：审计写入失败（fail-closed，拒绝写文件）：audit sink down  → exec-rc=1
$ ls /iso/etc/ssh/sshd_config.d/kore-ssh-guard-auditfail.conf  → No such file（未落盘）
$ ls /iso/etc/ssh/sshd_config.d/.kore-write-*                  → No such file（无临时残留）
```
**断言**：四类拒绝（路径穿越 / 前缀归属 / allowlist 指令 / 参数越界）全部在生产原语+协议层拦截 ✓；审计 fail-closed 不写文件 ✓；目标目录零半写入、零临时文件 ✓。

### 3.6 场景⑤ 容器内密钥 SSH 连通性（PASS，含诚实边界）
在加固配置下（当前 drop-in = `PasswordAuthentication no / MaxAuthTries 3 / PermitRootLogin prohibit-password`）启动隔离 sshd：
```
$ /deps/bin/sshd -f /iso/etc/ssh/sshd_config -D -e > /iso/sshd.log   （容器后台）
Server listening on 0.0.0.0 port 2222. / Server listening on :: port 2222.
$ /deps/bin/ssh -i /iso/testkey -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes -p 2222 tuser@127.0.0.1 'echo SSH_OK; id -un'
SSH_OK
tuser                                                                → ssh-key-rc=0
$ /deps/bin/ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no ... tuser@127.0.0.1
Permission denied (publickey,keyboard-interactive).                   → 密码认证被拒（预期）
```
**断言**：加固后密钥用户仍可连 ✓；密码认证被拒 ✓；OCK 得到 `sshd -t`（§3.3）+ 连通性双重旁证 ✓。
> 过程诚实记录：首次登录遇 `User tuser not allowed because account is locked`（busybox `adduser -D` 默认锁口令），解锁容器本地 `/etc/shadow` 后成功；sshd re-exec 需 `/usr/lib/openssh/sshd-session`，用 loader wrapper 补齐后监听正常。两者均为容器环境装配问题，**非配置错误、非 ADR-0028/C12 机制问题**。
- **额外旁证（插件声明的 delete 回滚链路）**：真实 `sshd-dropin-delete` root_action 也经生产 `executeFileDelete → filewrite.DeleteDeclared` 受控删除成功：文件消失、删前强制备份 mode=644 root:root sha=9c4d9903…、账本 `file.restore(备份,原路径)`、`sshd -t` exit 0。覆盖 P2 新增 file_delete 的生产执行面。

### 3.7 诚实边界（逐条写明，不作超越证据）
- 容器非真实宿主 sshd：**无 systemd / 无真实 PAM 路径 / 单用户 / 短时窗口**；OCK 靠 `sshd -t`/`sshd -T` + 容器内短时密钥连通性旁证，**不是真机长时间运行验证**。
- 未做真机多账号/密钥轮换/网络中断/SIGHUP 长时场景；未真机写宿主 `/etc/ssh`（宿主 sha 前后一致、无 sshd 进程）。
- 无竞品同口径验证，**不据此宣称超越宝塔 / 1Panel**。

---

## 4. ④ 索引 / 版本一致性（PASS）

```
$ cd kore-plugins && bash scripts/validate-index.sh              → exit 0
[OK] schema / 必填字段 / id 唯一 / sha256 格式通过（24 条）
[OK] 版本单调递增 / 同 id@version 唯一 sha 校验通过（基线 24 条）
[OK] 预设引用可解析（47 条）/ market/plugins.js 逐字节一致（24 插件）/ ed25519 签名验证通过
```
- **六处 sha 一致（均为 `c380cb6c3a9c86b13c50438c7fd62b80391df3da531e703805002f54f38f2ccb`）**：① dist 实测 `sha256sum dist/ssh-guard-0.5.0.tar.gz`；② dist sidecar `.sha256`；③ `kore-plugins/index/plugins.json:110`（size_bytes=2880509 == `stat` 实测 2880509）；④ `index/versions.lock.json:300`（ssh-guard 0.5.0 账本）；⑤ `presets/full.json:40` + `presets/security.json:10` pin 0.5.0；⑥ `market/plugins.js` ssh-guard version 0.5.0（由索引派生，`build-market --check` 一致）。`info.json.size_bytes=2880507` 与实测差 2，属 RELEASE §1.3 自指估算正常容差，不作判定依据。
- **0.4.1 → 0.5.0 bump 理由成立**：`kore/docs/RELEASE.md:18` 明列「任何改变 dist 包 sha 的改动必须 bump」；P2 新增 `apply-hardening`/`rollback-hardening` 方法 + `file_write`/`file_delete` 声明 + Go 源码（hardening.go +310 行）+ `go.mod` pluginapi v0.4.1→v0.4.0 依赖变更 + `info.json`/`manifest.json` 改动 → dist sha 从 0.4.1 的 `8d1c5c77…` 变为 0.5.0 的 `c380cb6c…`，按 §0「同一 id@version 只允许一个 sha」必须 **minor bump 到 0.5.0**（feat 新能力，minor 而非 patch）。0.4.1 账本 sha 保留未覆盖。`CHANGELOG.md:6-12` 已记 0.5.0 条目；顺序正确（先 bump 再打包再同步索引）。

---

## 5. ⑤ G-28 双端截图实读 + 三问（PASS）

- **identify 真实宽高 + sha（两图各异，非同图缩放）**：
  - `sshguard-dropin-desktop-01.png` = PNG **1440×2874**，8-bit sRGB，405784 B，sha `9ffbd3c6…`
  - `sshguard-dropin-mobile-01.png` = PNG **390×4033**，8-bit sRGB，363969 B，sha `aee7a9cc…`
- **read_image 实读（本轮 verifier 亲看，非采信自述）**：
  - 桌面图可见「安全 → 网络边界 → SSH 防护」页，「确认一键应用加固？」模态框：`将写入文件：/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf`、`权限：0644 root:root`、三条 diff（`PasswordAuthentication yes→no` / `PermitRootLogin prohibit-password→no` / `MaxAuthTries 6→3`）、两条风险+回滚、两条黄底警示（应用不 reload / 保留密钥会话）、勾选项 + 取消/确认；页下 dry-run 预览与落地/验证命令同屏。
  - 手机图窄屏单列呈现同一确认框，diff/风险/警示/勾选/按钮完整可读，底部 tab 不遮挡关键内容；与桌面图内容同源但布局不同，确认非伪造。
- **三问原文**（复用 P2 `.agents/verify/sshguard-dropin-selfeval.md §2`，本轮逐字回读）：问1「本页解决什么用户问题」——把「生成建议→手工复制命令下发」收敛为同页勾选→只读预览→一键应用（受控写只写 drop-in、不 reload）→一键回滚（账本结构化撤销），确认框一次讲清文件/diff/风险/回滚/重载提示/密钥会话，符合易用性四原则；问2「与宝塔/1Panel 差距」——有意更克制（不自动 reload、只写 drop-in 不改主配置/端口/防火墙、10 条固定 allowlist、无历史/diff 视图/多主机），属轻量面板定位与 ADR-0060 裁决边界，不作超越竞品证据；问3「可用还是占位」——判「可用（受控范围）」，三条判据（UI 真浏览器双端截图 `PAGE_ERRORS=[]` / API 方法 Go 单测真跑 / `make check` 全绿 + `node --check` + 首屏 91092 B），并诚实标注「真机写宿主属 P3 VM 复验范围，本轮 UI 证据不含真机写宿主」——而该 P3 范围已由本报告 §3 真生产代码隔离 VM 闭环坐实。

---

## 6. ⑥ git 纪律（PASS）

| 仓库 | HEAD | DCO Signed-off-by | 远端含 HEAD | tag@HEAD | worktree | 他人 dirty |
| --- | --- | --- | --- | --- | --- | --- |
| kore | `3aea81e` | ✓ pengtang1024 | 空（未 push，ahead 10） | 空 | 1（仅主） | `M scripts/usability-pending.txt` + 多个 `??` 原样 |
| kore-plugin-ssh-guard | `604321d` | ✓ pengtang1024 | 空（develop 无 upstream） | 空 | 1 | `?? zeroparam_test.go` 原样 |
| kore-plugins | `6f64259` | ✓ pengtang1024 | 空（未 push，ahead 1） | 空 | 1 | `?? .tmp-validate-out.txt` / `?? dist/` 原样 |

- 三 HEAD commit 首行带 `[agent:c12-p2*]` 前缀、`git log -1 --format='%b'` 均含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`；`git branch -r --contains HEAD` 三仓空 → 未 push；`git tag --points-at HEAD` 三仓空 → 未打 tag / 无 Release。
- 精确路径：kore `3aea81e` 仅 `.agents/verify/c12-p2-verification.md`；ssh-guard `604321d` 11 文件（CHANGELOG/info/manifest/go.mod/go.sum/hardening.go+test/declaration_test/banwrite_test/methods/rootaction_client）；plugins `6f64259` 6 文件（index/plugins.json + .sig + versions.lock + market + 2 presets）。无 `git add .` 痕迹。
- 三仓 `git worktree list` 各仅 1 行、`git branch --list 'wt-*' 'tmp-*'` 空。**他人 dirty 全程未触碰、未提交**；本 worker 唯一写域为本报告。
- task-337 mode 修复 `1ff4230` 为 kore HEAD 祖先（`git merge-base --is-ancestor 1ff4230 HEAD → YES`），非本 worker 新增提交。

---

## 7. 清理回读 / 边界自检（命令 + 退出码）

```
$ docker rm -f kore-sshguard-prod                       → 容器已删
$ docker ps -a --filter name=kore-sshguard-prod --format '{{.Names}}'  → 空（rc=0）
$ rm -rf <workspace>/.tmp/c12-prod-vm                   → harness/archive/proxy/gocache/日志全部删除
$ ls <workspace>/.tmp/c12-prod-vm                       → No such file or directory（确认已删）
$ sha256sum /etc/ssh/sshd_config                        → f5f0b404…（与基线一致，宿主零写入）
$ pgrep -a sshd                                         → 无输出（宿主 sshd 未启/未重启）
$ curl -s http://127.0.0.1:8787/-/healthz               → {"status":"ok"}（主实例未受影响）
$ cd kore && git status --short -- .agents/verify/c12-prod-vm.md
?? .agents/verify/c12-prod-vm.md                        → 唯一写域
```
- 一次性 harness / 离线 proxy / 隔离源码 / 容器全部用完即删（用户明令）；不写宿主 `/etc/ssh`、不重启宿主 sshd、不碰 `8787`/`.kore-local-*`、不联网业务（仅本地 `alpine:3.20` 镜像）。
- 审计/凭据边界：凭据（SSH testkey）0600 只存在于容器 `/iso/**`，不进 argv、不进本报告、不进任何提交；报告无明文口令/密钥（G-30 口径）。

## 8. 总评与遗留

**六项全 PASS、0 新增 FAIL。** C12 P3 的核心命题——「用真生产代码（非内联补丁）在隔离 VM 重跑闭环」——成立：一键应用/回滚/`sshd -t`/`sshd -T`/逐字节且逐属性回滚（mode 0644 守恒）/四类拒绝 fail-closed/容器密钥 SSH 连通全部实测通过；P2 遗留的回滚 mode 缺陷已在生产代码修复并由本轮实测坐实。无缺陷需另派卡。

诚实边界复述：容器非真机（无 systemd/PAM 长时）、OCK 靠 `sshd -t/-T` + 短时连通性旁证非真机长时间、无竞品同口径不作超越证据。发版由 lead 统一收敛三仓版本与推送；本 worker 未 push / 未 tag / 未发版。

—— `c12-prod-vm`（task-344，真机验证 worker；写域仅本报告）
