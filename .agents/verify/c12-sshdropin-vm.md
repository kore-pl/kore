# C12 隔离 VM 验证：ADR-0028 受控写复用于 sshd drop-in（一键应用 + 回滚闭环）

> 类型：隔离验证（真机容器内，非宿主）· 日期：2026-11-28 · 执行：c12-vm（独立于实现方）
> 任务：task-334 · 基线：`kore` HEAD `1ecc03c`（`git archive HEAD` 隔离副本）· 用户新定位：
> “服务器管理软件本身一定是最高权限” + “权限不用问，有风险先本地虚拟机测试” →
> 重评确认 C12 的真缺不是“授权顾虑”而是能力未接线（task-333）。
> **结论先行**：ADR-0028 的受控写**机制本体**（校验/备份/审计 fail-closed/原子替换/属主复核/结构化
> purge_op/changes.jsonl）在隔离 sshd drop-in 上**五项验证全部 PASS**：一键应用、sshd -t exit0、
> 按账本逐字节回滚、失败拒绝不留半写入、容器内改后密钥 SSH 仍可连。
> **但复用不是零改动**：生产协议当前只有 `nginx.conf.d` 一个类别 + nginx 内容策略，
> ssh-guard 0.4.1 也没有 `file_write` 声明；本次用**隔离副本内联补丁**证明可行，
> 不改生产代码。另发现 1 个机制缺陷（回滚丢权限 0644→0600），按纪律报 lead 另派卡。

---

## 0. 取证边界与硬约束（先说清楚没做什么）

| 项 | 本轮口径 |
| --- | --- |
| 宿主 `/etc/ssh` | **只读探针 + 前后 sha 对照**，零写入；宿主无 sshd 进程，未重启任何宿主服务 |
| 隔离环境 | 本机 Docker：`kore-sshguard-test`（`alpine:3.20` 本地镜像，`--network=none`）；sshd 二进制/动态库从宿主只读复制到容器 `/deps`，全部配置/写盘在容器 `/iso/**` |
| 受控写执行 | 真 `kore` 代码（`internal/core/privilege` + `internal/core/filewrite` + `pkg/pluginapi`），从 `git archive HEAD` 隔离副本编译成静态 harness，经 `DirOverride` 指到 `/iso/etc/ssh/sshd_config.d/` |
| **未接线部分的替代** | 协议层缺 `sshd.config.d` 类别和 sshd 内容策略；为验证“复用可行性”，**只在隔离副本**新增 `pkg/pluginapi/sshdconf_harness.go`（指令 allowlist）+ 该类别定义，并在 `ValidateFileWriteContent` 加一个 harness-only case；生产代码零改动 |
| 无联网业务 | 容器 `--network=none`，无 apt/apk 拉包，只用本地已有 `alpine:3.20` 镜像 |
| 8787 / `.kore-local-*` | 未碰（未读未写）；无隔离 kored 实例，只跑受控写执行面 harness |
| 一次性脚本/harness | 全部落在工作区 `.tmp/c12-vm/**`（被 `.gitignore` 忽略），验证结束已删除；容器已 `docker rm -f` |
| 诚实边界 | 容器非真实宿主 sshd；OCK（不锁死自己）靠 `sshd -t` + 容器**密钥 SSH 连通性**旁证，**不是真机长时间验证**；无竞品同口径，不作超越竞品证据 |

**前置只读材料**（全部读过，结论用于判断“机制可直接复用”）：

- `kore/docs/DECISIONS/0028-controlled-file-write.md`：ADR-0028 原文 + 实施记录；白名单含 `/etc/ssh/sshd_config.d/`（:44-49 代码，ADR :75），审计只存哈希（:82-92），二期条件含“真实写盘 e2e”（:189）。
- `kore/internal/core/filewrite/filewrite.go`：受控写入口 `:273`（`Write`）/ `:48`（`declared.go` `WriteDeclared`）；校验 `:152-230`、禁软链 `:233`、备份 `:304-323`（`copyFile :412` 固定 0600）、审计 fail-closed `:325-338`、原子写 `:358-395`、写后属主复核与失败回滚 `:343-353`、路径锁 `:433-469`。
- `kore/internal/core/privilege/filewrite.go`：真实执行面 `:35`（`executeFileWrite`），审计 begin/end `:63-115`，运行时生成 `purge_op` `:181-193`（备份→`file.restore`；新文件→`file.remove`），changes 账本 `:116-128`。
- `kore/cmd/kored/changes.go`：账本追加 `:82-114`（0600/append+fsync）、结构化回滚 `:147-184`（`file.restore` = `os.Rename(备份,目标)`）。
- `kore/pkg/pluginapi/filewrite.go`：类别唯一真源 `:85-96`（当前**只有** `nginx.conf.d`）；内容策略 `:220-258`（当前**只有** `nginx.vhost.v1`，其它 fail-closed）。
- `kore-plugin-ssh-guard/info.json:41-75`：**只有** 3 条 fail2ban 命令型 `root_actions`，**无 `file_write` 声明**；`methods.go:427-508` 的 `ban.add/remove` 走 fail2ban 通道，`status/suggest` 明确“不读不写真实 sshd_config”（`methods.go:91,117-134`）。当前能力 = 审计 + 封禁 + 建议态，不写 sshd。
- `kore/docs/FEATURE-GAP-BACKLOG.md:173-176`（C12 原文证据）+ `:267-275`（技术门槛已具备，真写宿主待授权）。
- `kore/.agents/verify/root-manageability.md:28-96,232-263,280-295`：root 可写证据（`/etc/ssh/sshd_config` 644 root:root，root 等价者可写）+ “root 等价进程无法 in-band 收权/审计不可防篡改/只能 kill+重建”风险论证；`:302-309` 明列本机真 root 未实测。
- `kore/.agents/LOG/DECISIONS.md`：ADR-0028 一期 accepted（实现 commit `a029fae`、端到端未真机验证）、ADR-0052 nginx 纳入受控写等条目。

**ADR-0028 复用结论**：机制本体**可直接复用**——`WriteDeclared` 的 `DirOverride`（`declared.go:34-36,115-125`）与 `Options.AllowedPrefixes`（`filewrite.go:135`）允许把任意绝对目录作为测试目标；备份/审计/原子写/回滚都是通用实现，与 nginx 无关。缺的是**协议层接线**（类别 + 内容策略 + 插件 `file_write` 声明），不是机制本身。

---

## 1. 隔离环境搭建（命令 + 退出码 + 原文）

### 1.1 宿主前置探针（只读）

```text
$ docker version --format '{{.Server.Version}}'
29.7.2                                    rc=0
$ docker images --format ... | grep alpine
alpine:3.20 d9e853e87e55 12.2MB             (本地镜像，未拉网)
$ /usr/sbin/sshd -V
OpenSSH_10.2p1 Ubuntu-2ubuntu3.8, OpenSSL 3.5.5 27 Jan 2026   rc=0
$ id
uid=1000(pt) ...  CapEff: 0000000000000000  NoNewPrivs: 1
$ unshare -Ur id
unshare: 写失败：/proc/self/uid_map: 不允许的操作    rc=1
```

→ 用户命名空间不可用，改用 Docker 容器隔离；宿主 sshd 二进制 + 动态库只读复制进容器（ alpine 镜像本身无 sshd，且禁止联网装包）。

### 1.2 容器与隔离 `/iso` 树

```text
$ docker run -d --name kore-sshguard-test --network=none --entrypoint /bin/sh alpine:3.20 -c 'while :; do sleep 3600; done'
<container-id>                            rc=0
$ # 宿主读文件经 docker cp 复制 sshd/ssh/ssh-keygen + 9 个 openssh helper + 21 个 glibc 依赖到 /deps；
$ # 全部动态库 symlink 解析为真实文件（docker cp 默认保留 symlink，第一次导致 libzstd/libpcre2 缺失，
$ # 用 readlink -f 解析后重拷并 mv 覆盖 symlink 修正）
$ docker exec kore-sshguard-test sh -c 'LD_LIBRARY_PATH=/deps/lib64 /deps/bin/sshd -V'
OpenSSH_10.2p1 Ubuntu-2ubuntu3.8, OpenSSL 3.5.5 27 Jan 2026   rc=0
$ docker exec kore-sshguard-test sh -c 'mkdir -p /iso/etc/ssh/sshd_config.d /iso/run /iso/var/empty /iso/data/changes /iso/data/backups; /deps/bin/ssh-keygen ...'
```

哨兵配置 `/iso/etc/ssh/sshd_config`：

```text
# isolated sshd_config for C12 verification (NOT host /etc/ssh)
Port 2222
HostKey /iso/etc/ssh/ssh_host_ed25519_key
Include /iso/etc/ssh/sshd_config.d/*.conf
PasswordAuthentication yes
MaxAuthTries 6
PermitRootLogin prohibit-password
UsePAM no
```

哨兵 drop-in `/iso/etc/ssh/sshd_config.d/00-sentinel.conf`：`ClientAliveInterval 300`（0644 root:root）。

```text
$ docker exec kore-sshguard-test sh -c '/deps/bin/sshd -t -f /iso/etc/ssh/sshd_config; echo baseline-sshd-t-rc=$?'
baseline-sshd-t-rc=0
$ docker exec kore-sshguard-test sha256sum /iso/etc/ssh/sshd_config /iso/etc/ssh/sshd_config.d/00-sentinel.conf
06cb71dfaf5fe37f95cf0a9870fcbc005387bab9b7bce2070ffdacc8471544dc  /iso/etc/ssh/sshd_config
812a95e354c6c95feba254a383dfdc4d36f88a9fff66a52d0b317efccee23dc9  /iso/etc/ssh/sshd_config.d/00-sentinel.conf
```

隔离 harness 从 `git archive HEAD`（`1ecc03c`）编译：

```text
$ cd kore && git archive HEAD | tar -x -C .tmp/c12-vm/kore-src   rc=0（405 个 .go 文件）
$ # 隔离副本内联补丁（生产零改动）：
$ #   新增 pkg/pluginapi/sshdconf_harness.go：ContentPolicySSHDropinHarness 指令 allowlist
$ #   filewrite.go +2 行：ValidateFileWriteContent switch 增 harness-only case
$ #   新增 cmd/c12vmharness/main.go：复用 privilege.Service.Execute + audit/change sink
$ CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o c12vmharness ./cmd/c12vmharness
build-rc=0, 4788654 bytes, 静态
$ docker cp c12vmharness kore-sshguard-test:/deps/c12vmharness   rc=0
```

宿主 `/etc/ssh` 基线（前后均未变）：

```text
$ sha256sum /etc/ssh/sshd_config
f5f0b40412fd9a84b787d967efbcb576728d398e8d40d0d32c825004a04a4999  /etc/ssh/sshd_config
$ stat -c '%n mode=%a owner=%U:%G' /etc/ssh/sshd_config
/etc/ssh/sshd_config mode=644 owner=nobody:nogroup
$ pgrep -a sshd
(无输出) → 宿主 sshd 进程：none
```

---

## 2. 验证项逐条证据

### ① 一键应用：受控写 drop-in（PASS）

```text
$ docker exec kore-sshguard-test sh -c '/deps/c12vmharness apply kore-ssh-guard-hardening.conf "PasswordAuthentication no
MaxAuthTries 3
PermitRootLogin prohibit-password
"'
RESULT {"executed":true,"exit_code":0,"dur_ms":1,"unit":"kore-root-ssh-guard-sshguard-write-dropin-8f375327","host_change_recorded":true,"file_write":{"path":"/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf","size":75,"mode":420,"sha256":"9c4d99031776772393fb803498a157862d88ed6367e1d0582fb94c41303a518d"}}
AUDIT_EVENTS 0
apply-rc=0
```

`AUDIT_EVENTS 0` 是 harness 内存计数（每次启动新进程）；**磁盘审计 JSONL 有 begin+end 两条**：

```text
$ stat -c 'mode=%a owner=%U:%G size=%s' /iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf
mode=644 owner=root:root size=75
$ cat /iso/data/changes.jsonl
{"plugin":"ssh-guard","action":"sshguard-write-dropin","target":"/iso/etc/ssh/sshd_config.d/","summary":"经受控写向隔离 sshd_config.d 下发加固 drop-in","reversible":true,"purge_op":{"kind":"file.remove","args":["/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf"]}}
$ cat /iso/data/audit.jsonl
{"Actor":"admin","PluginID":"ssh-guard","ActionID":"sshguard-write-dropin","Argv":"file_write kore-ssh-guard-hardening.conf","Unit":"kore-root-...-8f375327","Decision":"allow","Phase":"begin","FileWrite":{"Path":"/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf","SHA256":"9c4d9903...","Size":75,"Mode":420,"CopyPath":""}}
{"Actor":"admin",...,"Phase":"end","ExitCode":0,"FileWrite":{...同一 sha256...}}
```

**断言**：文件落地 ✓ / 0644 root:root ✓ / 审计 begin+end（哈希，无正文）✓ / changes.jsonl 登记 + 运行时 `file.remove` purge_op ✓。新建文件无备份是**正确设计**（回滚=删除）。

### ② 语法校验 `sshd -t`（PASS）

```text
$ docker exec kore-sshguard-test sh -c '/deps/bin/sshd -t -f /iso/etc/ssh/sshd_config; echo sshd-t-rc=$?'
sshd-t-rc=0
$ /deps/bin/sshd -T -f /iso/etc/ssh/sshd_config | grep -E '^(port|passwordauthentication|maxauthtries|permitrootlogin|clientaliveinterval) '
port 2222
maxauthtries 3
clientaliveinterval 300
permitrootlogin prohibit-password
passwordauthentication no
sshd-T-rc=0
```

证明加固片段已生效（`passwordauthentication no` / `maxauthtries 3`）且语法正确、不会因配置错误锁死。

### ③ 回滚：按 changes.jsonl 逐字节还原（PASS，但暴露 1 个权限缺陷）

先二次应用（覆盖写）触发备份与 `file.restore` purge_op：

```text
$ /deps/c12vmharness apply kore-ssh-guard-hardening.conf "PasswordAuthentication no
MaxAuthTries 6
PermitRootLogin yes
"
RESULT {"executed":true,"exit_code":0,"file_write":{"size":61,"sha256":"c6a0dbb3675ad3...","copy_path":"/iso/data/backups/ssh-guard/20261128T105300Z/kore-ssh-guard-hardening.conf"}}
$ cat /iso/data/changes.jsonl | tail -1
{...,"reversible":true,"purge_op":{"kind":"file.restore","args":["/iso/data/backups/ssh-guard/20261128T105300Z/kore-ssh-guard-hardening.conf","/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf"]}}
$ sha256sum /iso/data/backups/ssh-guard/20261128T105300Z/kore-ssh-guard-hardening.conf
9c4d99031776772393fb803498a157862d88ed6367e1d0582fb94c41303a518d  ← 第一次写入的内容
$ stat -c 'mode=%a' /iso/data/backups/ssh-guard/20261128T105300Z/kore-ssh-guard-hardening.conf
mode=600
```

按账本最后一条 `purge_op` 回滚（harness 的 `purge` 模式镜像 `cmd/kored/changes.go:147-184` 的 `validatePurgePath` + `os.Rename`，不执行字符串命令）：

```text
$ /deps/c12vmharness purge
PURGE_OP file.restore [/iso/data/backups/ssh-guard/20261128T105300Z/kore-ssh-guard-hardening.conf /iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf]
PURGE_OK
purge-rc=0
$ sha256sum /iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf
9c4d99031776772393fb803498a157862d88ed6367e1d0582fb94c41303a518d  ← 与备份/第一次写入逐字节一致
$ cat /iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf
PasswordAuthentication no
MaxAuthTries 3
PermitRootLogin prohibit-password
$ /deps/bin/sshd -t -f /iso/etc/ssh/sshd_config; echo sshd-t-rc=$?
sshd-t-rc=0
$ /deps/bin/sshd -T -f /iso/etc/ssh/sshd_config | grep -E '^(passwordauthentication|maxauthtries) '
maxauthtries 3
passwordauthentication no
```

**断言**：drop-in 内容逐字节还原 ✓ / `sshd -t` 仍 exit 0 ✓ / 备份被 `os.Rename` 消费 ✓。
**缺陷（如实记录）**：回滚后 drop-in 的权限是 **0600**，而原文件是 **0644**：

```text
$ stat -c '%n mode=%a owner=%U:%G' /iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf
/iso/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf mode=600 owner=root:root
```

根因（生产代码 `file:line`）：
- `internal/core/filewrite/filewrite.go:412-418` `copyFile` 用 `OpenFile(..., 0o600)`，备份总是 0600，不保留原 mode；
- `cmd/kored/changes.go:169-180` `purgeKindFileRestore` 用 `os.Rename(src, dst)`，直接把备份的 0600 带成目标权限；
- 对照：`internal/core/filewrite/filewrite.go:475-492` 的 `revertWrite`（属主复核失败时的内部回滚）**会**先读备份内容再用 `atomicWrite(target, content, mode)` 恢复声明权限——说明正确语义在包内已有，只是账本回滚链路没复用。

影响：对 sshd drop-in，root 可读 0600，功能不坏；但“逐字节还原”不等于“逐属性还原”，回滚后若再走受控写，`checkNoSymlink`（`filewrite.go:263-264`）会看到目标 mode 0600（在允许集内，能过），不会阻断；属主校验仍 root:root。对其它白名单目录（如 nginx vhost 0644）同样丢 mode。**报 lead 另派卡**，本卡不自行改代码。

### ④ 失败场景拒绝且不留半写入（PASS）

```text
$ /deps/c12vmharness reject "../evil.conf" "MaxAuthTries 3"
REJECT name="../evil.conf" err=E_INVALID: 受控写请求非法：文件名必须是单层名字（不得含路径分隔符/控制字符）："../evil.conf"
$ /deps/c12vmharness reject "evil.conf" "MaxAuthTries 3"
REJECT name="evil.conf" err=E_INVALID: 文件名必须以 "kore-ssh-guard-" 开头（防止覆盖其它插件的片段）
$ /deps/c12vmharness reject "kore-ssh-guard-x.sh" "MaxAuthTries 3"
REJECT name="kore-ssh-guard-x.sh" err=E_INVALID: 文件名必须以 ".conf" 结尾
$ /deps/c12vmharness reject kore-ssh-guard-bad.conf "Include /etc/shadow"
REJECT err=E_INVALID: 第 1 行指令 "Include" 不在 allowlist 内（拒绝）
$ /deps/c12vmharness reject kore-ssh-guard-bad.conf "MaxAuthTries abc"
REJECT err=E_INVALID: 第 1 行 "MaxAuthTries" 参数非法：MaxAuthTries 必须是 1..100 的整数
```

（以上 harness `reject` 模式把“预期被拒”判为 PASS，故命令退出码 0；错误原文即断言依据。）

审计 fail-closed：

```text
$ /deps/c12vmharness apply-fail-audit kore-ssh-guard-auditfail.conf "MaxAuthTries 3"
RESULT executed=false err=E_INTERNAL: 受控写失败：审计写入失败（fail-closed，拒绝写文件）：audit sink down
auditfail-rc=0
$ ls -l /iso/etc/ssh/sshd_config.d/kore-ssh-guard-auditfail.conf
ls: ... No such file or directory     ← 未落盘
```

目标不可写（第二个只读容器 `kore-sshguard-ro`，`--read-only` + `-v ...:/iso-ro/sshd_config.d:ro`；宿主 `touch` 实测 `Read-only file system` rc=1）：

```text
$ docker exec kore-sshguard-ro sh -c 'C12_ISO_DIR=/iso-ro/sshd_config.d/ C12_STATE_DIR=/tmp/c12state /tmp/c12vmharness apply kore-ssh-guard-ro.conf "MaxAuthTries 3"'
RESULT {"executed":false,"exit_code":0,...,"unit":""}
ERR E_INTERNAL: 受控写失败：原子写失败：open /iso-ro/sshd_config.d/.kore-write-2417112273: read-only file system
apply-rc=1
$ ls -la /iso-ro/sshd_config.d/
(只有 00-sentinel.conf，无目标文件、无 .kore-write-* 残留)
```

**断言**：四类拒绝全部在原语/协议层发生，目标目录零半写入、零临时文件 ✓。

### ⑤ 风险旁证：容器内改 sshd 后仍可连（PASS，含诚实边界）

```text
$ # 在容器隔离实例内：adduser tuser + 密钥 authorized_keys（仅容器 /etc/passwd、/home/tuser）
$ /deps/bin/sshd -f /iso/etc/ssh/sshd_config -D -e > /iso/sshd.log 2>&1 &
Server listening on 0.0.0.0 port 2222.
Server listening on :: port 2222.
$ /deps/bin/ssh.real -i /iso/testkey -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes -p 2222 tuser@127.0.0.1 'echo SSH_OK; id -un'
SSH_OK
tuser
ssh-rc=0
$ # 加固配置下密码认证被拒（预期）：
$ /deps/bin/ssh.real -o PreferredAuthentications=password -o PubkeyAuthentication=no -p 2222 tuser@127.0.0.1 ...
Permission denied (publickey,keyboard-interactive).    ssh-rc=255（预期）
```

再验证“运行中改配置→重启进程→仍可连”（更接近真实风险）：

```text
$ /deps/c12vmharness apply kore-ssh-guard-hardening.conf "PasswordAuthentication no
MaxAuthTries 5
PermitRootLogin prohibit-password
"        # 运行中二次应用，rc=0
$ /deps/bin/sshd -t -f /iso/etc/ssh/sshd_config; echo sshd-t-rc=$?
sshd-t-rc=0
$ kill -HUP $(cat /iso/sshd.pid)
$ tail -3 /iso/sshd.log
Received SIGHUP; restarting.
RESTART FAILED: av[0]='/deps/bin/sshd.real', error: No such file or directory.
```

**诚实记录**：SIGHUP 后 sshd 退出，根因是**本 harness 的二进制包装方式**（宿主 glibc ELF 在 musl 容器里靠 `/deps/lib64/ld-linux-x86-64.so.2` 手工加载，sshd re-exec 自身 `av[0]` 时找不到可直接执行的解释器），**不是配置错误、也不是 ADR-0028 机制问题**。改用干净重启复核：

```text
$ /deps/bin/sshd -f /iso/etc/ssh/sshd_config -D -e > /iso/sshd2.log 2>&1 &
pid=759
Server listening on 0.0.0.0 port 2222.
Server listening on :: port 2222.
$ /deps/bin/ssh.real -i /iso/testkey ... -p 2222 tuser@127.0.0.1 'echo RESTART_SSH_OK; id -un'
RESTART_SSH_OK
tuser
ssh-rc=0
```

**断言**：加固后密钥用户仍可连 ✓；密码认证被拒 ✓；OCK 得到 `sshd -t` + 连通性双重旁证 ✓。
**边界**：容器非真实宿主（无 systemd/PAM 真实路径、单用户、短时窗口）；未做真机长时运行、未做多账号/密钥轮换/网络中断场景；无竞品同口径，不据此宣称超越宝塔/1Panel。

---

## 3. 对齐用户新定位的判断（重评 C12）

- task-333 重评（用户新定位）成立：C12 不是“因授权顾虑刻意不做”，而是**能力接线缺口**——root 可写证据已在 `root-manageability.md`，ADR-0028 机制已具备，真写 sshd 的技术链在本验证中闭环。
- 但“服务器管理软件一定是最高权限”不等于“可以直接对宿主 `/etc/ssh` 一键写”：`root-manageability.md:280-295` 的四项管理能力归零/降级论证仍成立；本卡的隔离验证正是“有风险先本地虚拟机测试”的落实。
- C12 闭环仍需（本卡**不做**，报 lead 另派）：
  1. 协议层新增 `sshd.config.d` 类别 + sshd 指令 allowlist 策略（参考本 harness 隔离副本的 `sshdconf_harness.go`，但生产需要完整威胁建模/红队绕过集，不能照搬最小原型）；
  2. ssh-guard `info.json` 增加 `file_write` root_action 声明（`requires_kore` 下界按协议版本门禁收窄）；
  3. 前端一键应用/回滚入口 + G-28 双端截图；
  4. 修 `file.restore` 回滚权限缺陷（§3③）；
  5. 有 root + systemd 的真机短窗口闭环（不是容器）。

## 4. 环境清理回读（命令 + 退出码）

```text
$ docker rm -f kore-sshguard-test kore-sshguard-ro
kore-sshguard-test
kore-sshguard-ro
$ docker ps -a --filter name=kore-sshguard --format '{{.Names}}'
(空) → rc=0
$ rm -rf /home/pt/Work/GolandProjects/kore-pl/.tmp/c12-vm   （git archive 副本 + harness + ro-testdir）
$ ls /home/pt/Work/GolandProjects/kore-pl/.tmp/c12-vm
No such file or directory → rc=2（确认已删）
$ sha256sum /etc/ssh/sshd_config
f5f0b40412fd9a84b787d967efbcb576728d398e8d40d0d32c825004a04a4999  （与基线一致）
$ pgrep -a sshd
(无输出) → 宿主 sshd 进程：none
$ cd kore && git status --short -- .agents/verify/c12-sshdropin-vm.md
?? .agents/verify/c12-sshdropin-vm.md  （唯一写域，生产代码零改动）
```

## 5. 一句话结论

> ADR-0028 受控写机制**可以直接复用**到 sshd drop-in，隔离环境五项验证全 PASS（含按 changes.jsonl 逐字节回滚 + 容器内密钥 SSH 连通性）；缺口在协议/插件接线和一个已定位的回滚权限缺陷（`cmd/kored/changes.go:169-180` + `internal/core/filewrite/filewrite.go:412-418`），均已报 lead 另派卡，本卡不改生产代码、不 push。
