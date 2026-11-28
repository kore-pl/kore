> 状态: accepted · 归属: c12-p1（task-339，P1 实现；方案 ssh-guard 仓 `docs/DESIGN-SSH-DROPIN.md` edf5844 已 lead 审阅采纳）· 更新: 2026-11-28 · 里程碑: R51
> ADR 状态: accepted（C12 方案 §3.3「应用 ≠ reload」裁决已由 lead 审阅采纳）· 关联: [0028-controlled-file-write](./0028-controlled-file-write.md)（§9 修订）、[0052-nginx-vhost-controlled-write](./0052-nginx-vhost-controlled-write.md)（同构先例）、[0023-zero-intrusion](./0023-zero-intrusion.md)、[0018-privilege-model](./0018-privilege-model.md)、[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md) §3.1.3.2
> 纪律: 本 ADR 只登记协议类目 + 内容策略 + P1 边界；插件声明 / 前端 / 隔离 VM 复验属后续 P2/P3，不在本 ADR 宣称完成。宿主 `/etc/ssh` 零写入。

# ADR-0060：sshd drop-in 走受控文件写 + `sshd.dropin.v1` 纯文本 allowlist

## 1. 背景与问题陈述

ADR-0028 的受控写机制本体（`WriteDeclared` + 备份 / 审计 fail-closed / 原子替换 / `changes.jsonl` 结构化回滚）已在 C12 隔离验证（`b16a575`，`.agents/verify/c12-sshdropin-vm.md` 五项全 PASS）中证明可直接复用于 sshd drop-in。缺口不在机制，在**协议/插件接线**：P1 之前 `pluginapi.FileWritePrefixClasses` 只有 `nginx.conf.d`，`ValidateFileWriteContent` 只实现 `nginx.vhost.v1`，其它策略 fail-closed。

ssh-guard 插件目前只给「加固建议」（`dry_run` 恒 true），用户要求把建议转成一键应用。直接把文本交给插件写 `/etc/ssh/sshd_config.d/*.conf` 不可接受：片段由 **root sshd** 解析，一条 `Include` 就能把任意 root 可读文件拉进配置，`AuthorizedKeysCommand` 让 root sshd 以命令输出当公钥（任意命令执行），`HostKey` 可加载任意密钥文件——被攻破的插件等于拿到 root 配置执行面。

## 2. 选项对比（多选一，含被否决项）

| 选项 | 做法 | 优点 | 代价 / 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **A. 扩受控写类目 + 纯文本 allowlist（本 ADR）** | 新增 `sshd.config.d` 类目 + `sshd.dropin.v1` 校验器（放 `pkg/pluginapi`，与 `nginxconf.go` 同层），路径防护全复用通用层 | 不新开提权端点；审计 / 备份 / 回滚 / 属主校验全复用已验机制；allowlist 可在写盘前纯文本判定，不依赖 sshd 可执行文件 | allowlist 是安全关键代码，解析差一即绕过；需 fuzz + 红队绕过集；主配置 Include 位置差异需写后 `sshd -T` 复核 | **采纳** |
| B. 目录授权（给插件用户写权限） | 登记 ADR-0023 §3.5 豁免，让插件直接写 drop-in | 改动最小 | 等价于把 root sshd 的配置面交给插件，无内容门；nginx 同类方案（ADR-0052 §2 B）已实测可提权；sshd 的 `AuthorizedKeysCommand` 危害同构 | **否决** |
| C. 新开 `file-write` 端点 / 把内容放 `args` | 独立提权端点；或正文塞进固定 argv | 不需要改协议 | 绕过 confirm / 审计 / 变更账本；`args` 禁换行、总长 4096，装不下多行片段（ADR-0052 §2 A2/A3 已否决） | **否决** |
| D. 把 `sshd -t` 当安全校验 | 写前只跑 `sshd -t -f <staging>`，通过即写 | 不用写 allowlist | `-t` 只校验语法、不校验安全性，root 身份下还会真实打开 HostKey 等文件（先执行后判断）；与 ADR-0052 对 `nginx -t` 的硬否证同构 | **否决**（`-t` 仅作语法/锁死门，见 §4） |
| E. 应用即 reload（写后 `systemctl reload/restart sshd`） | 一键应用同时重载 sshd 让配置立即生效 | 立即生效 | `reload`/`restart` 不在 `RootCommandPolicies`（ADR-0022）；C12 §2⑤ SIGHUP 失败已示警运行中重读风险；重载后回滚需逆转一次进程重启，锁死风险高 | **否决**（见 §3.3 裁决） |

## 3. 裁决细则

### 3.1 类目（数据驱动，零新路径校验代码）

`pluginapi.FileWritePrefixClasses` 增 `sshd.config.d`：`Dir=/etc/ssh/sshd_config.d/`（**带尾斜杠**，只在内核定义一次）、`Suffix=.conf`、`Mode=FileWriteModeRoot0644`、`Owner=root:root`、`PluginNamePrefix=true`、`ContentPolicy=sshd.dropin.v1`、`MaxBytes=MaxFileWriteContentBytes`（256 KiB 默认，插件声明可自我收紧到 64 KiB）。`FileWriteOptions` 增 `SSHD SSHDPolicy`（零值 = 默认策略）。`ValidateFileWriteContent` 的 switch 增一个 case，公共前置（大小 / UTF-8 / NUL / 控制字）一行不改。

路径逃逸防护**逐层复用**：`ValidateFileWriteName`（单层 / `..` / 路径分隔符 / 控制字 / 128 字符 / 后缀 / 插件前缀）+ `FileWritePath` 的 `path.Clean` 复核 + 内核 `internal/core/filewrite` 的逐级 `Lstat` 禁软链 + `O_NOFOLLOW` + 属主复核。新增类目**没有引入任何新路径校验代码**。`target` 必须逐字等于 `/etc/ssh/sshd_config.d/`，保证 `changes.jsonl` 的人话影响对象与真实写盘对象一致。

### 3.2 内容策略 `sshd.dropin.v1`（默认全拒）

解析器形状（逐条可测，实现在 `pkg/pluginapi/sshdconf.go`，只用 stdlib）：

| 层次 | 规则 |
| --- | --- |
| 结构 | 逐行 `Directive value...`；只接受行首指令 + 空白分隔参数 + **整行** `#` 注释；行内 `#`、行尾 `\` 续行、`%` 变量、`${}`、引号、`;`、`{}` 一律拒 |
| allowlist（10 条，默认全拒） | `PasswordAuthentication`/`PubkeyAuthentication`/`KbdInteractiveAuthentication` = `yes`/`no`；`PermitRootLogin` = `yes`/`prohibit-password`/`forced-commands-only`/`no`；`PermitEmptyPasswords` **只 `no`**；`MaxAuthTries` 1..100；`ClientAliveInterval` 0..3600；`ClientAliveCountMax` 0..10；`LoginGraceTime` 1..600；`MaxStartups` `start:rate:full` 三段各 1..1000 |
| 显式 deny（18 条 + 3 族，带理由） | `Include`、`Match`、`AuthorizedKeys*`（文件/命令/命令用户）、`AuthorizedPrincipals*`（文件/命令/命令用户）、`HostKey*`、`Port`、`ListenAddress`、`Subsystem`、`ForceCommand`、`AllowTcpForwarding`、`AllowStreamLocalForwarding`、`PermitTunnel`、`PermitListen`、`PermitOpen`；不在 allowlist 的其它指令默认全拒 |
| 上限 | 参数个数每规则精确锁定（≤4）、单 token ≤1024 字符、单片段指令数 ≤128（可用 `SSHDPolicy.MaxDirectives` 收紧）；参数只接受 ASCII 十进制整数（拒 `+`/`-`/前导空白），避免与 sshd 解析差一 |

**显式 deny 清单是协议数据**（`pluginapi.DeniedSSHDDirectives`），供错误文案 / 红队 / 单测 / 文档同源：每条都在 allowlist 之外本来也会被拒，单列是为了「错误信息可解释 + 用例可逐条断言 + 文档实现不漂移」。

### 3.3 应用 ≠ reload（lead 已审阅采纳）

一键应用**只写 drop-in，不 reload/restart sshd**。drop-in 在 sshd 下次启动 / 重载时生效，由运维在确认密钥会话可用后自行 reload。好处：写操作与进程重启解耦、当前会话零中断、回滚只是删/还原文件而不需要逆转一次进程重启。若未来要求「应用即生效」，须另开 ADR 评估 reload 命令形状 + confirm + 失败回滚（不在本 ADR 范围）。

### 3.4 内容安全门 vs 语法门（各自职责）

- **内容安全门 = allowlist（写盘前纯文本）**：挡 `Include`/`AuthorizedKeysCommand`/`HostKey` 等 root 执行面；
- **`sshd -t` = 语法/锁死门**（P2/P3 写前 staging 一次 + 写后对真实配置复核一次）：只证明「配置可解析、sshd 起得来」，**不证明安全**；
- **写后 `sshd -T` 复核生效值**：挡「主配置 Include 位置靠后导致 drop-in 被覆盖、加固静默失效」。

## 4. 残余风险（必须披露，不宣称消灭）

1. **锁死自己**：allowlist 内 `PasswordAuthentication no` + `PermitRootLogin no` 有把管理员关在外面的业务后果；由「保留密钥登录 + 一键回滚 + 隔离 VM 先验 + 应用≠reload」承担，不由 allowlist 消除。
2. **解析差一**：引号 / 续行 / 注释 / `Match` / `Include` 的解析差一就是绕过；本 ADR 的拒绝集逐条覆盖 + 后续 fuzz / 红队绕过集 + 写后 `sshd -T` 生效值复核共同兜底，但**不宣称 zero risk**。
3. **发行版差异**：主配置须在某处 `Include sshd_config.d/*.conf`；RHEL/SUSE/自定义布局未逐个取证，无 include 的发行版应给明确「不支持」而非假装成功（写后复核负责发现）。
4. **回滚 mode 守恒**：依赖 task-337 修 `changes.jsonl` 回滚丢 mode 的缺陷；未合入前不得宣称「逐属性回滚」。
5. **SELinux/AppArmor / 真机长时窗口**：不作安全论据；容器隔离验证非真机，无 systemd/PAM 长时证据。

## 5. P1 交付与门禁

- 代码：`pkg/pluginapi/filewrite.go`（类目 / `ContentPolicySSHDropin` / `FileWriteOptions.SSHD` / switch case）、新 `sshdconf.go` + `sshdconf_test.go`（零新依赖，stdlib only）；`cmd/` 与 `internal/core` 不出现 sshd 业务词（G-01）。
- 文档：本 ADR + ADR-0028 §9 append-only 修订 + PLUGIN-PROTOCOL §3.1.3.2 类目策略行 + G-23 台账。
- 版本：`pluginapi` feat → minor，tag `v0.3.0` → `v0.4.0`（只本地签 tag，不 push）。
- 门禁：`cd pkg/pluginapi && go test -race ./...` 绿；`make pluginapi-race` exit 0；`go list -m all` 零新依赖；`grep` 新生产文件无 `any`/`map[string]any`（G-24）；`bash scripts/docs-check.sh` exit 0。

## 6. 复审条件

- 新增 allowlist 指令 / 放宽参数范围 / 引入 reload 命令形状 / 改路径类目 → 必须新开 ADR 复审，不得静默改代码；
- P3 隔离 VM 生产代码闭环复验必须六项全 PASS，否则 P2 不得宣称「可一键应用」；
- 若发现 allowlist 解析与 sshd 实际解析存在差一（红队/fuzz 命中），立即 fail-closed 撤回相关指令并重审。
