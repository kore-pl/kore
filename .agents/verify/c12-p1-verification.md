> 状态: accepted · 归属: c12-p1-verifier（G-09 独立 verifier，非 implementer c12-p1）· 更新: 2026-11-28 · 里程碑: R51
> 结论: **PASS**（拒绝集覆盖完整，无绕过成立）· 受验: commit `4aafdfe` · 任务: task-341

# C12 P1 独立验收报告：sshd 协议类目 + `sshd.dropin.v1` allowlist + ADR-0060 + tag 签名

## 0. 身份与纪律

- 本轮为 G-09 独立复核，verifier = `c12-p1-verifier`，与实现者 `c12-p1` 不是同一角色；先 claim task-341（revision 1→2）再开工。
- 全程只读复核：未改生产代码、未启主流程 CLI、未联网业务、未碰宿主 `/etc/ssh`、未碰 `.kore-local-*`。唯一写入 = 本报告。
- 复跑 Go 命令用工作区**仓外**隔离缓存 `GOCACHE=<workspace>/.verify-gocache-c12p1`、`GOPROXY=off`、`GOWORK=off`（证明零网络依赖）；默认 `/home/pt/.cache/go-build` 在本沙箱只读（`open ...: read-only file system`），故避开。所有自建临时目录/文件在报告落盘后删除。

## 1. 总评

**PASS。** 五项复核范围全部成立：①读码确认 sshd 类目/策略/switch 同构复用、allowlist 默认全拒 + 显式 deny + 字符拒 + 参数上限、stdlib 零新依赖；②拒绝集独立复跑 `-race` 绿，Verbose 逐条核对所有覆盖维度真实执行；③门禁 `make pluginapi-race` / `go list -m all` / G-24 grep / `docs-check` 全绿；④ADR-0060 新编号正确、ADR-0028 §9 append-only 只增不改、PLUGIN-PROTOCOL 增 sshd 行、G-23 留痕、tag `pkg/pluginapi/v0.4.0` Good 签名 peeled==4aafdfe 未 push；⑤commit 精确 7 文件 +DCO 未 push，与并发 `ledger-mode-fix(1ff4230)` 共享文件各带自己 hunk 未覆盖，他人 dirty 原样，worktree 仅主树。**任一拒绝集不全或绕过成立即应 BLOCKED——本轮未发现此类情形。**

## 2. 读码核对（范围①）

### 2.1 `pkg/pluginapi/filewrite.go`（commit diff，+23/-3）

| 判据 | 实证 |
| --- | --- |
| `sshd.config.d` 类目 | `FileWritePrefixClasses` 新增条目：`Dir="/etc/ssh/sshd_config.d/"`（**带尾斜杠**）、`Suffix=".conf"`、`Mode=FileWriteModeRoot0644`、`Owner="root:root"`、`PluginNamePrefix=true`、`ContentPolicy=ContentPolicySSHDropin`、`MaxBytes=MaxFileWriteContentBytes`（256 KiB） |
| `FileWriteOptions.SSHD` | 新增 `SSHD SSHDPolicy` 字段；`DefaultFileWriteOptions()` 同步注入 `SSHD: DefaultSSHDPolicy()` |
| `ValidateFileWriteContent` switch | 新增 `case ContentPolicySSHDropin: return ValidateSSHDropinFragment(content, opts.SSHD)`；default 仍 fail-closed |
| 零新路径校验代码 | 该类目只是 map 数据；文件名/路径逃逸由 `ValidateFileWriteName` / `FileWritePath`（`path.Clean` 复核）/ 内核逐级 `Lstat` 禁软链 + 属主复核通用层承接，未新增一处校验实现 |
| 常量 | `ContentPolicySSHDropin = "sshd.dropin.v1"` |

### 2.2 `pkg/pluginapi/sshdconf.go`（新文件 276 行，stdlib only）

- imports 仅 `fmt`/`strconv`/`strings`/`unicode/utf8`——**零第三方依赖**（`go.mod` 无 require、`go.sum` 不存在、`go list -m all` 只有本 module）。
- `SSHDPolicy{MaxDirectives}`：零值 = 默认（128 条，fail-closed 语义不变），可收紧。
- **allowlist 10 条默认全拒**（`sshdLeafRules` 唯一真源）：`PasswordAuthentication`/`PubkeyAuthentication`/`KbdInteractiveAuthentication` = `yes`/`no`；`PermitRootLogin` = `yes`/`prohibit-password`/`forced-commands-only`/`no`；`PermitEmptyPasswords` 只 `no`；`MaxAuthTries` 1..100；`ClientAliveInterval` 0..3600；`ClientAliveCountMax` 0..10；`LoginGraceTime` 1..600；`MaxStartups` 三段各 1..1000（含三段结构校验）。指令名大小写敏感（只放行规范写法）。
- **显式 deny 18 条 + 3 族**（`DeniedSSHDDirectives` / `deniedSSHDPatterns`，逐条带理由）：Include、Match、AuthorizedKeys{File,Command,CommandUser}、AuthorizedPrincipals{File,Command,CommandUser}、HostKey、Port、ListenAddress、Subsystem、ForceCommand、AllowTcpForwarding、AllowStreamLocalForwarding、PermitTunnel、PermitListen、PermitOpen；族前缀 `AuthorizedKeys` / `AuthorizedPrincipals` / `HostKey`（`validateSSHDDenied` 用 `EqualFold` + `HasPrefix(ToLower)` → 大小写绕过无效）。
- **字符拒绝**：行内 `#`、`\` 续行、双/单引号、`%`、`${}`、`;`、`{}` 一律拒（`strings.ContainsAny(line, "\"'\\%;${}")`），整行 `#` 注释与空行放行；控制字符（NUL/DEL/非 `\t` 的 <0x20）拒；非 UTF-8 拒。
- **参数形状**：`sshdParseDecimal` 只收 ASCII 0-9（Atoi 前先逐字节校验，拒 `+`/`-`）；每规则精确参数个数；`maxSSHDArgs=4`、`maxSSHDTokenRunes=1024`、`defaultSSHDMaxDirectives=128`；至少 1 条 allowlist 指令。
- `splitSSHDFields` 只按 ASCII 空格/制表符切分（不用 `strings.Fields` 的 Unicode 空白，避免词法差一）。
- 残余风险如实披露（ADR §4 / 文件头注释）：锁死业务后果、解析差一、发行版 Include 差异、`sshd -t` 非安全门、真机长时窗口未验——未宣称消灭。

## 3. 拒绝集独立复跑（范围②）

### 3.1 绿

- `cd pkg/pluginapi && GOCACHE=<隔离> GOPROXY=off GOWORK=off go test -race -count=1 ./...` → **exit 0**：`ok .../pluginapi 1.122s`、`ok .../pluginapitest 1.023s`，零 DATA RACE。
- `make pluginapi-race`（隔离 GOCACHE + GOPROXY=off）→ **exit 0**：`[OK] pkg/pluginapi 全量 -race 通过（2 个包，1s，零 DATA RACE）`。

### 3.2 Verbose 断言覆盖面（非只看绿）

Verbose 输出 `PASS` 行 546 条（整 module 含存量用例），`FAIL` 0。SSH 相关共 **11 个顶层测试函数 + 97 个表驱动子测试 = 108 个用例**（> 任务卡口径 104，覆盖维度只增不减；如实记录实际计数差异，不构成缺陷）。逐维度核对：

| 任务卡要求维度 | 实证（verbatim 子测试计数） |
| --- | --- |
| 18 deny 指令逐条 | `TestDeniedSSHDDirectivesEachRejected` **18 subtests PASS**；逐条断言 err 非空 + 含「无条件拒绝」+ 点名指令名（非只检查 err != nil） |
| 3 族 | `TestDeniedSSHDDirectiveFamiliesRejected` **3 subtests PASS**（AuthorizedKeysFooBar / AuthorizedPrincipalsFooBar / HostKeyAgent） |
| 4 大小写绕过 | `TestSSHDDirectiveCaseVariantsRejected` **4 subtests PASS**（include / MATCH / authorizedkeyscommand / passwordauthentication 全被拒） |
| 每类参数越界 | `TestSSHDAllowlistBoundary` **46 subtests PASS**：10 条 allowlist 指令逐条含合法边界 + 越界（枚举非法/大小写/空/多参；整数 0/上界+1/abc/-1/+1；MaxStartups 两段/四段/非数字/空段/段越界） |
| 11 构造 | `TestSSHDConstructRejects` **11 subtests PASS**（行内注释/行尾注释/反斜杠续行×2/双引号/单引号/%/${}/;/{} /制表符续行） |
| 7 文件名越界 | `TestSSHDDropinProtocolClass` **7 bad-name subtests PASS**（`../evil.conf`、`/etc/passwd`、`evil.conf`、他插件前缀、`.sh`、缺中间标识、129 字符超长） |
| 正例三指令片段 | `TestSSHDPositiveC12Fragment` PASS（协议层直接校验 + 端到端 `ValidateFileWriteRequest` 双通过） |
| nginx.vhost.v1 回归 | `TestNginxVHostRegressionStillGreen` PASS（正例 PHP/伪静态形态通过、反例 `access_log /etc/shadow` 被拒） |
| 内容形状/上限 | `TestSSHDContentShapeRejects` **8 subtests PASS**（空/仅注释/仅空行/注释混排/128 上限/129 越界/收紧到 1/超长 token 1025 + NUL 单独断言） |
| 协议类目 | `TestSSHDDropinProtocolClass` 解析含 target 逐字相等、`FileWritePath` 正确拼接、content_policy 错配拒、max_bytes 放大拒 |
| fail-closed 分派 | `TestSSHDContentPolicyDispatch` PASS（合法过、`sshd.dropin.v2` 未知策略拒、含 Include 正文拒） |

### 3.3 独立对抗绕过复跑（verifier 自建，scratch 仓外副本，不碰生产）

15 条自建绕过探针（`TestVerifierBypassProbe`，scratch 目录复制生产 .go 后追加测试）：前导空格/制表符 Include、InClUdE/MaTcH/HOSTKEYAGENT 大小写、`AuthorizedKeysXYZ`/`HOSTKEYAGENT` 族变体、`PERMITROOTLOGIN` allowlist 大小写、Unicode NBSP 分隔、CR 结尾、MaxStartups 超大数溢出、`+5` 参数、双空格后注入 Include token、`forcecommand`/`SUBSYSTEM` 大小写、`%` 注释构造、换行注入 Include —— **15/15 全部被拒，正例对照通过，exit 0**。未发现任何绕过成立。

## 4. 门禁（范围③）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| pluginapi race | `make pluginapi-race`（隔离 GOCACHE，GOPROXY=off） | **exit 0**，2 包零 DATA RACE |
| 零新依赖 | `cd pkg/pluginapi && go list -m all` | **exit 0**，输出仅 `github.com/pengtang1024/kore/pkg/pluginapi`（无 require、无 go.sum、仅 stdlib） |
| G-24 | `grep -nE '\bany\b\|map\[string\]any\|json\.RawMessage' sshdconf.go filewrite.go` | **ZERO MATCHES**（无 any / map[string]any / RawMessage） |
| G-01 | 4aafdfe 未改 `cmd/` `internal/`；sshd 业务词在 cmd/internal 的命中全部来自并发 1ff4230，与本 commit 无关 | 一致 |
| docs-check | `bash scripts/docs-check.sh` | **exit 0**，5 pass / 1 warn / 0 fail（11 份存量行数 WARN 非本次引入） |
| diff 完整性 | `git diff-tree --check 4aafdfe^ 4aafdfe` | **exit 0**，无空白错误 |

## 5. 文档与 tag（范围④）

- **ADR 新编号 0060**：`docs/DECISIONS/0060-sshd-dropin-controlled-write.md`（73 行，状态 accepted，元信息合规）；0059 已被 `0059-silent-update-trigger-and-supply-chain.md` 占用，编号连续无冲突。
- **ADR-0028 append-only**：4aafdfe 对 `docs/DECISIONS/0028-controlled-file-write.md` 只有 1 个 hunk `@@ -218,3 +218,17 @@` —— 在文末**追加 §9**，§1–§8 原文零改动（行数 220→234，纯 +14 行）。HEAD 当前文件同时含并发 1ff4230 的 §2.1 hunk 与本次 §9，两者互不覆盖。
- **PLUGIN-PROTOCOL**：`docs/PLUGIN-PROTOCOL.md` 增 sshd 类目行（`| sshd.config.d（ADR-0060）| /etc/ssh/sshd_config.d/ | .conf/0644/root:root | kore-<plugin>- | sshd.dropin.v1 | 256 KiB |`）+ sshd 策略段（结构/allowlist 10/deny 18+3/上限/应用≠reload）。
- **G-23 留痕**：`.agents/LOG/DECISIONS.md` 追加 1 行 C12 多选一裁决（A 选；B/C/D/E 否决含依据；复审条件），本轮 idempotent。
- **tag 签名**：`git tag -v pkg/pluginapi/v0.4.0` → `Good "git" signature for pengtang1024@qq.com with ED25519 key SHA256:rmD48/4QMXSKhsVWi85ks7TMYDXTwSVInMW2ioP3r/I`；tag object type=`tag`（annotated）；`git rev-parse pkg/pluginapi/v0.4.0^{}` == `4aafdfe9d8d35167b1b83ba8733e838c24fa52c5`。tagger 声明 feat→minor v0.3.0→v0.4.0。
- **未 push（只读本地 ref 判定）**：`git branch -r --contains 4aafdfe` 空、remote-tracking refs 无 4aafdfe、远端 tag refs 无 v0.4.0；本地仅 main 与 tag 指向。

## 6. Git 卫生（范围⑤）

- `4aafdfe` 精确 **7 文件 / +713 / -5**：`.agents/LOG/DECISIONS.md`(+2)、`docs/DECISIONS/0028-controlled-file-write.md`(+14)、`docs/DECISIONS/0060-sshd-dropin-controlled-write.md`(+73)、`docs/PLUGIN-PROTOCOL.md`(+16/-2)、`pkg/pluginapi/filewrite.go`(+23/-3)、`pkg/pluginapi/sshdconf.go`(+276)、`pkg/pluginapi/sshdconf_test.go`(+309)。DCO：`Signed-off-by: pengtang1024 <pengtang1024@qq.com>`。
- **共享文件 hunk 未覆盖**：4aafdfe 与并发 1ff4230 共享 `docs/DECISIONS/0028-controlled-file-write.md` 与 `docs/PLUGIN-PROTOCOL.md`。4aafdfe 是 1ff4230 的直接子提交（父 = 1ff4230）；HEAD 两文件实证同时含两侧改动：0028 含 1ff4230 的 §2.1（第 148 行「回滚逐属性还原修订」）+ 4aafdfe 的 §9（第 222 行）；PLUGIN-PROTOCOL 含 1ff4230 的「按备份携带的原 mode 原子写回目标」（第 275 行）+ 4aafdfe 的 sshd 类目行（第 207 行）。各自 hunk 保留、未相互覆盖。
- **worktree 仅主树**：`git worktree list` 单行 `/home/pt/Work/GolandProjects/kore-pl/kore 4aafdfe [main]`。
- **他人 dirty 原样**：开工前后 `git status --porcelain` 一致（基线：`M scripts/usability-pending.txt`；untracked `.agents/.agents/`、`.agents/verify/e2e-*.md` 等、`data/`、`dist/`、`.gocache-kore-014/`、`.gocache-kore-015/`）。其中 `.gocache-kore-014`(mtime 11:41)/`015`(16:32) 早于 c12-p1 提交（19:16），属他人缓存，未触碰；本 commit 未遗留临时 GOCACHE 在 kore 仓内。本 verifier 自建的仓外临时目录/文件在报告落盘后删除。
- **未 push**：见 §5；未 force/reset/rebase/amend。

## 7. 诚实边界

- Verbose 计数为 108（11 顶层函数 + 97 子测试），任务卡写「104」——计数口径差异如实登记，覆盖维度经逐条核对均齐全且只多不少，不构成 BLOCKED。
- 本轮为只读复核：`go test -race` / `make pluginapi-race` 在本沙箱用仓外隔离 GOCACHE 复跑（默认 GOCACHE 只读环境限制），已声明；未跑完整 `make check`（超出本卡范围，本卡门禁按任务卡 3 项 + docs-check 执行）。
- 未执行真实 file_write / 未碰宿主 `/etc/ssh`（sshd drop-in 真实写盘属 C12 VM/P3 后续，不在 P1 协议层验收范围）；未连外网（GOPROXY=off）。
- tag「未 push」结论基于本地 remote-tracking ref（`git branch -r` / `for-each-ref refs/remotes`），未联网 fetch；若远端在此期间被他方推送，本只读判定不覆盖该变化。

## 8. 结论

**PASS**——协议层 sshd 类目与 `sshd.dropin.v1` allowlist 只读复核成立，拒绝集覆盖完整（18 deny 逐条 + 3 族 + 4 大小写 + 10 指令参数越界 + 11 构造 + 7 文件名 + 正例 + nginx 回归 + 15 条独立绕过探针全拦），无绕过成立；门禁、文档、tag 签名、git 卫生全部合规。无 BLOCKED 项。
