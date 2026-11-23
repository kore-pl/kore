# 反向反查：kore 拥有 root 等价权限后，root 对自身的管理能力是否仍成立

> 类型：安全反查（只读）· 日期：2026-11-23 · 执行：root-manageability（独立于实现方）
> 关联：[ADR-0018 提权模型](../../docs/DECISIONS/0018-privilege-model.md)（插件低权 + root 动作经内核代理）、`docs/SECURITY.md` §2/§6/§11
> 结论先行：**四项管理能力里，两项归零、一项只剩"事后取证"、一项只剩"终止进程"。** 详见 §5 表与 §6 定性。

## 0. 取证边界（先说清楚哪些是实测、哪些是引用）

本机实测环境：

```text
Ubuntu 26.04.1 LTS · Linux 7.0.0-44-generic x86_64 · systemd 259 · sudo-rs（/usr/bin/sudo.ws）
uid=1000(pt) gid=1000(pt) groups=...,27(sudo),973(docker)
NoNewPrivs: 1 · CapEff: 0000000000000000 · CapBnd: 000001ffffffffff
LSM: lockdown,capability,landlock,yama,apparmor,bpf,ima,evm（无 SELinux）
auditd: inactive / not-found（auditctl、ausearch 均未安装）
/etc/systemd/system/kore.service: 不存在（本轮无真实 kore 实例）
```

方法三条腿：① 只读探测（`/proc`、`/sys`、`/etc` 元数据、`systemctl show`）；② `/tmp` 内最小可逆实验（临时 sudoers 文件 + `visudo -c -f`、`unshare -Ur`、`loginuid` 自写、`setpriv`/`setcap` 拒绝路径）；③ 手册与内核 ABI 原文（`capabilities(7)`、`capget(2)`、`landlock(7)`、`sudoers-rs(5)`、`systemd.exec(5)`、`/usr/include/linux/audit.h`、`/usr/include/linux/prctl.h`）。

**没有做也不会做的事**：`sudo` 提权、改真实 `/etc/sudoers`、改真实用户、装/启 auditd、改/重启任何服务、创建临时系统用户（需 root，且会污染 `/etc/passwd`）。任务卡要求"不要 sudo"，本机 `NoNewPrivs=1` 也让 sudo 直接不可用（见 §3.6 实测），这本身构成一条证据。

---

## 1. 子问题一：root 能否限制 kore

**结论：在"kore 拥有 root 能做的所有事"这个前提下，不能。** 限制与"root 等价"在 Linux DAC 模型里互斥，不是配置技巧问题。

### 1.1 `sudoers NOPASSWD: ALL`：kore 能改、能删、能扩大自己的授权

机制链：

1. `/etc/sudoers` 是 `0440 root:root`、`/etc/sudoers.d` 是 `0755 root:root`。写入它需要 `euid=0` 或 `CAP_DAC_OVERRIDE`——这两样正是"root 等价"的内容。
2. `NOPASSWD: ALL` 的语义是"允许以任意 runas 执行任意命令"。sudo-rs 手册原文：*"A user specification determines which commands a user may run (and as what user) ... By default, commands are run as root"*（`sudoers-rs(5)`，User_Spec 段）。
3. 因此 `sudo visudo -f /etc/sudoers.d/kore`、`sudo tee /etc/sudoers.d/x`、`sudo sh -c '...'`、`sudo -i` 全在授权内 → kore 可追加 `kore ALL=(ALL:ALL) NOPASSWD: ALL`、可删掉限制自己的那一行、可拿到交互 root shell。

实测（`/tmp` 临时文件，已随脚本删除）：

```text
kore ALL=(ALL:ALL) NOPASSWD: ALL                          -> parsed OK
kore ALL=(root) NOPASSWD: /usr/bin/systemctl restart ...   -> parsed OK
kore ALL=(ALL) NOPASSWD ALL                                -> visudo: invalid sudoers file
```

`visudo -c -f` 只拦**语法**（第三个用例），不拦**语义**（前两个都合法）；它是防手滑的门禁，不是权限边界。

**"允许一切、但禁止改 sudoers"能不能写出来？不能。** 理由有三层，且第三层是决定性的：

- sudoers 匹配的是**命令**（路径 + 参数），不是**写入目标**；你无法表达"任何命令，但不得写 `/etc/sudoers`"。
- 即便用 `!` 排除 `visudo`、`tee`、`vi`，`python3 -c`、`perl -i`、`sed -i`、`dd`、`install`、`cp` 任一个都能写文件——命令枚举不可穷尽。
- sudo-rs 手册 `SECURITY NOTES` 自己写明：*"It is generally not effective to 'subtract' commands from ALL using the '!' operator."*（`sudoers-rs(5)`）

### 1.2 capability 授权：运行期**不能**收回，只能终止

- capability 是 **per-thread 凭据**，在 `execve(2)` 时确定。`capabilities(7)` 对 bounding set 的定义原文：*"a mechanism that can be used to limit the capabilities that are gained during execve(2)"* —— 即它是**exec 期**属性。
- `capset(2)` 只能改**调用线程自己**：手册标题即 *"set/get capabilities of thread(s)"*，且 `hdrp->pid` 只允许特定值（`capget(2)` DESCRIPTION 末段）。
- `/proc/<pid>/status` 是 `0444` 只读（实测 `mode=444 owner=pt:pt`），`/proc/<pid>/attr/` 只承载 LSM 标签，**没有任何"外部修改他人 cred"的接口**。
- 所以 root 对运行中的 kore 只有两个选择：**kill / 重启**（或 ptrace 注入内存——那已经放弃了"用权限模型管理"的叙事，且同样需要 kore 没有 `CAP_SYS_PTRACE` 反制）。"不重启就收回 capability"**不可能**。
- 反向同样不对称：root 也不能给运行中进程**加** cap，只能改文件 cap 或 unit 后重新 exec。

实测（非 root 视角，证明这条路径本身需要 root）：

```text
setpriv --reuid=0 --regid=0 --clear-groups id   -> setresuid 失败: 不允许的操作
setcap cap_dac_override+ep /tmp/pua-setcap-test -> unable to set CAP_SETFCAP effective capability: Operation not permitted
```

### 1.3 `systemd` 的 `User=` / `CapabilityBoundingSet=`：变更需要 root + reload + 重启；kore 能阻止

实测 unit 语义：

```text
systemctl show cron.service -p FragmentPath -p User -p CapabilityBoundingSet -p KillMode
FragmentPath=/usr/lib/systemd/system/cron.service
User=                                # 空 = root
CapabilityBoundingSet=cap_chown ... cap_checkpoint_restore   # 默认全量
KillMode=process
```

- `CapabilityBoundingSet=` 的定义是 *"Controls which capabilities to include in the capability bounding set **for the executed process**"*（`systemd.exec(5)`）——exec 期属性，运行期改不了。
- 变更流程固定三步：写 unit 文件（root，`/etc/systemd/system` 为 `root:root 0755`）→ `systemctl daemon-reload` → 重启 unit（root/polkit）。`/run/systemd/private` 实测为 `srwx------ root:root`，只有 root 能对话。
- **但 kore 若 root 等价，这三步它全能做，而且能反制**：
  - 改写 unit 把 `User=` / `CapabilityBoundingSet=` 改回去；
  - 绕过 unit 直接 `systemd-run` 起一个不带任何限制的 transient scope；
  - 把自己移出该 unit 的 cgroup（cgroup v2；实测非 root 写 `/sys/fs/cgroup/cgroup.procs` 返回 `权限不够`，root 等价者可写），从而在 `systemctl stop` / `KillMode=` 之后**继续存活**。
- 结论：unit 级限制只有在"root 单方面施加、kore 改不动"时才成立；root 等价恰好否定了这个前提。

### 1.4 唯一真正非零的限制：启动期一次性、不可逆、且封死逃逸通道

- `NoNewPrivileges=1`：本会话实测，`sudo` 直接报 *"The 'no new privileges' flag is set, which prevents sudo from running as root."*。它阻断 setuid/file-cap 提权，**但不降低已有 euid 0**——对已经 root 等价的进程毫无约束。
- `seccomp`：只能加严、不能卸载，但只过滤系统调用，不认路径。
- `Landlock`：`landlock(7)` 原文 *"Every new thread ... inherits Landlock domain restrictions from its parent"*，只能收紧、不可放宽。它可以在 kore 启动前把"写 `/etc/sudoers`、`/etc/passwd`、`/etc/shadow`"路径级封死，**即使 euid 0 也 EACCES**。
- **代价与漏洞**：这类约束必须满足"kore 拿不到逃逸能力"——不能让它连 systemd/dbus 起新进程、不能让它 `mount`、不能让它重启用新 domain。也就是说，它要求 kore **不是** root 等价（至少缺 `CAP_SYS_ADMIN`/`CAP_MAC_ADMIN`/`CAP_SYS_MODULE`/可写 systemd socket）。一旦给了"root 能做的所有事"，这层就自相矛盾。

> 一句话：限制能力在 DAC 维度是 **0**；非零边界只来自 LSM/seccomp/Landlock 这类"启动期施加、进程不可逆"的机制，而它们与"root 等价授权"不能共存。

---

## 2. 子问题二：root 能否审计 kore

**结论：有条件能——能记录、能在 sudo/登录路径上还原发起者；但不能防篡改。** 审计是"事后取证"，不是"边界"。

### 2.1 字段语义（`auid` 是唯一跨提权存活的归因锚点）

| 字段 | 语义 | 能否被发起者伪造 | 归因用途 |
| --- | --- | --- | --- |
| `auid`（= loginuid） | 登录会话 uid，登录时由 `pam_loginuid` 写入，跨 `setuid`/`sudo` **保留**；`4294967295` = 未设置 | 非 `CAP_AUDIT_CONTROL` **不可改写**（实测见下） | **主锚点**：euid=0 时还原"谁发起的" |
| `uid` | 系统调用时的 real uid（sudo 后 = 0） | 由内核写 | 辅助 |
| `euid` | effective uid（sudo 后 = 0） | 由内核写 | 判定"是否以 root 执行" |
| `suid` | saved set-uid | 由内核写 | 辅助 |
| `comm` | task 名 | **可被 `prctl(PR_SET_NAME)` 改写**（`/usr/include/linux/prctl.h:56`） | **不可作归因依据** |
| `exe` | 可执行文件路径 | 可被 exec 改变；二进制删除后带 `(deleted)` | 中等可信 |
| `subj` | LSM 上下文（AppArmor label） | 需 LSM 策略才能改 | **服务型进程最可靠** |
| `key` | 规则标签 | 规则侧 | 分类 |

字段常量真源（实测 `/usr/include/linux/audit.h`）：`AUDIT_UID=1`、`AUDIT_EUID=2`、`AUDIT_SUID=3`、`AUDIT_LOGINUID=9`、`AUDIT_SESSIONID=25`、`AUDIT_EXE=112`。注意：**不存在 `AUDIT_AUID` 常量**——`auid` 就是 `loginuid` 的审计字段名。

loginuid 只写一次、之后非 `CAP_AUDIT_CONTROL` 不可改，本机实测：

```text
current loginuid=1000
写自己（同值 1000）  -> I/O error
写 0                 -> I/O error
```

（本机 auditd 未启用，内核返回 EIO；语义结论不变：已设置的 loginuid 不能被非特权进程改写。）

### 2.2 具体 audit 规则（可直接落 `/etc/audit/rules.d/50-kore.rules`）

```bash
# ---- 1) root 授权面：任何写入/属性变更都记 ----
# 注意：-w 目录不递归，/etc/pam.d 与 /etc/sudoers.d 需逐个文件另加规则
-w /etc/sudoers              -p wa -k authz_change
-w /etc/sudoers.d            -p wa -k authz_change
-w /etc/passwd               -p wa -k identity_change
-w /etc/shadow               -p wa -k identity_change
-w /etc/group                -p wa -k identity_change
-w /etc/gshadow              -p wa -k identity_change
-w /etc/pam.d/common-auth    -p wa -k pam_change
-w /etc/pam.d/sshd           -p wa -k pam_change
-w /etc/ssh/sshd_config      -p wa -k sshd_change
-w /root/.ssh                -p wa -k root_key_change
-w /etc/systemd/system       -p wa -k unit_change
-w /etc/audit/rules.d        -p wa -k audit_tamper
-w /etc/audit/auditd.conf    -p wa -k audit_tamper

# ---- 2) sudo 中转还原：euid=0 但由登录会话发起 ----
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=4294967295 -k root_exec_by_user
-a always,exit -F arch=b32 -S execve -F euid=0 -F auid>=1000 -F auid!=4294967295 -k root_exec_by_user

# ---- 3) 服务身份（systemd 启动、无 loginuid）执行的特权进程 ----
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid=4294967295 -k root_exec_service

# ---- 4) 凭据/capability 相关系统调用 ----
-a always,exit -F arch=b64 -S capset  -k cap_change
-a always,exit -F arch=b64 -S prctl   -F a0=24 -k cap_bset_drop     # PR_CAPBSET_DROP
-a always,exit -F arch=b64 -S prctl   -F a0=38 -k nnp_set           # PR_SET_NO_NEW_PRIVS

# ---- 5) 锁死：只可加、不可减，需重启才能解除 ----
-e 2
```

`/etc/audit/auditd.conf` 另需：`loginuid_immutable = yes`。

**用法（不要只看 `comm`）**：

- 交互/sudo 路径：`ausearch -k root_exec_by_user -i`，按 `auid` 分组，`auid` 即发起者；再与 sudo 自身日志交叉验证。
- 服务路径（auid 未设置）：按 `subj`（AppArmor label）或 unit 名归因；这也是为什么 **kore 的每个 root 动作都应该有一个具名 unit**（ADR-0018 的 `kore-root-<plugin>-<action>-<rand>`），unit 名本身就是审计字段。
- `-F auid!=4294967295` 是"排除未设置"的常用写法；新版 auditctl 也接受 `auid=unset`。

### 2.3 sudo 中转的还原证据（本机真实日志格式）

```text
sudo: pam_unix(sudo:session): session opened for user pt(uid=1000) by (uid=0)
sudo: root :  PWD=/ ; USER=pt ; COMMAND=/usr/bin/env ... rustdesk --server
```

格式即 `sudo: <发起者> : PWD=... ; USER=<目标> ; COMMAND=...`，**发起者与目标都落盘**；kore→root 的场景会记成 `sudo: kore : ... USER=root ; COMMAND=...`。journal 侧另有 `_SYSTEMD_UNIT` / `_COMM` / `_PID`（但 root 进程的 `_UID` 恒为 0，单看 journal 无法区分发起者）。

### 2.4 为什么审计不构成边界

- `capabilities(7)` 对 `CAP_AUDIT_CONTROL` 的定义原文：*"Enable and disable kernel auditing; change auditing filter rules; retrieve auditing status and filtering rules."* → root 等价者可 `auditctl -D` 删规则、停 auditd、改 `/etc/audit/rules.d`。
- 日志是本地文件，可截断；`-e 2` 的"不可变"只到下次重启，而 `CAP_SYS_BOOT` 可重启，规则文件又可被改。
- 唯一有意义的形态：**外送 + 远端只追加 + 带外时钟/完整性**（`audisp-remote`/TLS 或独立 syslog 主机），并接受"这是取证，不是阻止"。
- 更强的做法是**结构性审计**：所有 root 动作经 broker，unit 名/`subj` 自带发起者与动作。给 kore 一个通用 root shell，等于把结构性审计降级为"事后猜进程"。

### 2.5 未实测

`auditd` 未安装（`auditctl`/`ausearch` MISSING），规则未真实加载；上文规则按 `audit.h` ABI 与上游 `audit.rules(7)` 语义编写，**未在本机验证触发**。本机内核 headers 无 `Documentation/audit/`（实测），`auditctl(8)`/`audit.rules(7)` man 页也未安装。

---

## 3. 子问题三：root 能否撤销 kore

**结论：只能"终止"，不能"原地降权"；且撤销动作可被 kore 自保反制，最终边界是 `SIGKILL` / 断电 / 带外恢复。**

### 3.1 逐项看撤销手段

| 撤销手段 | 对运行中 kore 的效果 | 生效条件 | kore 能否反制 |
| --- | --- | --- | --- |
| 删 sudoers 条目 | **只影响下一次** `sudo`（sudo 每次重新解析 sudoers）；已有 root shell / 已 euid 0 进程不受影响 | 立即 | 重建条目（它自己就是 root） |
| 清空 capability | **无效**。运行中进程的 cred 不可外部修改（§1.2） | 需改文件 cap/unit 后**重启** | 重新 `setcap` 给自己（`CAP_SETFCAP`） |
| 改 unit `User=` | 无效，直到 `daemon-reload` + 重启 | root 写文件 + reload + restart | 改回 unit / 起 transient unit / 移出 cgroup |
| `systemctl stop` | 发 SIGTERM；`KillMode=process` 只杀主进程 | root/polkit | 忽略 SIGTERM、双 fork、移出 cgroup 存活 |
| `systemctl kill -s SIGKILL` | 有效（cgroup 内） | root | 已在 cgroup 外/新 unit 的副本存活 |
| 断电 / 重装 | 有效 | 物理/带外 | 无 |

### 3.2 运行期"原地降权"为什么不可能

- cred 是内核 per-task 结构，只有**自己**能通过 `setuid`/`capset`/`prctl` 改；外部只能 `ptrace` 改内存（需 `CAP_SYS_PTRACE`，且 kore 也能反向 ptrace/反调试），或**终止**。
- 实测支撑：`/proc/<pid>/status` 为 `0444`；`capset` 只作用于调用线程；`setpriv --reuid=0` 返回 `不允许的操作`；非 root 写 `cgroup.procs` 被拒。
- 因此"撤销"在工程上 = **停止进程 + 轮换它可能接触过的全部凭据 + 从可信状态重建**，不是改一行配置。

### 3.3 kore 的自保清单（机制上都成立）

- 重建 sudoers 条目 / 重新给自己 `setcap`；
- `systemd-run` 起新 unit、写 `/etc/cron*`、`at`、`udev` 规则、root 的 `.bashrc`、PAM 配置；
- 双 fork + `setsid` + 移出 unit cgroup（cgroup v2 可写 `cgroup.procs`）；
- 改 PAM/sshd，让 root **下一次登录**反而受它控制；
- 加载内核模块 / eBPF（`CAP_SYS_MODULE` / `CAP_BPF`）；
- 直接 `reboot`（`CAP_SYS_BOOT`）——重启后规则/配置由它写过的文件决定。

> 结论：只要 kore 还活着且 root 等价，"撤销它的权限"就是一句空话；root 的真实手段只有"杀 + 重建信任"。

---

## 4. 子问题四：root 的策略会否被 kore 绕过

**结论：能。** 这正是用户担忧的核心：**被管理者拥有管理者的权限，管理者就失去了边界。**

### 4.1 root 的认证/授权资产，kore 等价者可写

实测权限（非 root 视角全部 denied）：

| 文件 | mode / owner | 非 root 可写 | root 等价者可写 | 被改写后的后果 |
| --- | --- | --- | --- | --- |
| `/etc/passwd` | `644 root:root` | 否 | **是** | 加 uid 0 账户、改 root shell |
| `/etc/shadow` | `640 root:shadow` | 否 | **是** | 改 root 密码哈希、锁死 root |
| `/etc/group` `/etc/gshadow` | `644` / `640` | 否 | **是** | 提权到特权组（docker/sudo） |
| `/etc/sudoers` `/etc/sudoers.d` | `440` / `755 root:root` | 否 | **是** | 永久授权 / 删除限制 |
| `/etc/pam.d/*` | `644 root:root` | 否 | **是** | 登录/su/sshd 注入后门 |
| `/etc/ssh/sshd_config` | `644 root:root` | 否 | **是** | `PermitRootLogin`、`AuthorizedKeysCommand` |
| `/root`、`/root/.ssh` | `700 root:root` | 否 | **是** | 读 root 私钥、写 `authorized_keys` |
| setuid-root 二进制 | `/usr/bin/{sudo.ws,su,passwd,pkexec,mount,...}` | 否 | **是** | 替换为后门（实测存在这些 setuid 位） |

再加上 `/etc/systemd/system/*.service`、`/etc/cron*`、`/etc/ld.so.preload`、`/etc/apt/apt.conf.d`、内核模块/eBPF——**root 的"身份"与"授权"本身就是磁盘上 kore 可写的数据**。

### 4.2 能做什么（按危害排序）

1. **直接接管**：`sudo -i` / `su -`（若 root 无密码或已知）→ 已经是 root。
2. **持久化 root**：加 uid 0 账户、写 root 的 `authorized_keys`、改 PAM、装 systemd unit。
3. **锁死 root**：改 `/etc/shadow` 的 root 哈希 + `PermitRootLogin no` + 改 PAM → root 只能从控制台进；这就是"反过来控制 root"。
4. **清除痕迹**：停 auditd、删规则、清日志（§2.4）。
5. **替换信任根**：换 setuid 二进制、改 `ld.so.preload`、签自己的内核模块。

### 4.3 root 还剩什么反制

只有**不依赖 in-band 权限**的手段：控制台/救援模式、可重建镜像、Secure Boot + 内核 lockdown、IMA 评估、把 kore 关在它无法加载/卸载的 LSM 域里、带外审计与网络隔离。这些都不是"授权 root 等价"的一部分，而是**在它之外另建一层**。

机制层面的根因：**Linux 的 DAC 是平坦的 uid 0，不是层级。** 没有"super-root"；`root` 与"root 等价的 kore"是同一个 uid 0 的两份副本，彼此对称。所谓"root 管理 kore"，成立的前提是 root **严格强于** kore——`CAP_*` 全量或 `sudo ALL` 恰好取消了这个前提。

> 顺带：`docs/DECISIONS/0018-privilege-model.md` 已把 `docker` 组记为"等价 root 的既成授权"——本条反查的结论对 `docker` 组、`NOPASSWD: ALL`、全量 capability 一视同仁。

---

## 5. 四项管理能力还剩多少

> 百分比是**主观标尺**，用于横向比较，不是测量值；判据在该行"依据"列。

| 管理能力 | 还剩多少 | 依据（机制） | 恢复非零的前提 |
| --- | --- | --- | --- |
| **限制** | **0%**（运行期）；启动期一次性约束可 >0 | DAC 对称；capability 是 exec 期 cred，`capset` 只能改自己；unit 可被 kore 改写/绕过；sudoers 匹配命令而非写入目标，无法"ALL 减 sudoers" | LSM/seccomp/Landlock 在启动前施加 + 封死 systemd/dbus/mount 逃逸 + kore 不持有 `CAP_SYS_ADMIN`/`CAP_MAC_ADMIN`/`CAP_SYS_MODULE`（此时它已不是 root 等价） |
| **审计** | **≈50%**：能记录、能还原发起者，不能防篡改 | `auid` 跨 sudo 保留且非 `CAP_AUDIT_CONTROL` 不可改；sudo 日志含发起者+目标+命令；但 `CAP_AUDIT_CONTROL` 可停/改/删，日志可截断 | 审计外送 + 远端只追加 + `-e 2` + `loginuid_immutable` + 结构性 broker（具名 unit/`subj`）；仍只是取证 |
| **撤销** | **≈30%**：只能终止，不能原地降权 | 运行期 cred 不可外部修改；删 sudoers/清 cap 只影响下一次；`SIGKILL`/断电有效但 kore 可移出 cgroup、双 fork、重建 | 杀进程 + 轮换全部凭据 + 从可信镜像重建；撤销必须按"已失守"执行 |
| **不被绕过** | **0%** | `/etc/passwd`、`/etc/shadow`、`/etc/sudoers`、PAM、sshd、`/root`、setuid 二进制全部可被 root 等价者写 | 只读根 + IMA/签名 + 强制 LSM + 带外恢复；与"root 等价"不共存 |

---

## 6. 一句话定性

> **「root 等价授权」不可接受作为稳态；它只能作为有明确退出日期的过渡态，且必须按"root 已经被接管"来运营。**

可接受的前提（**必须同时满足，缺一不可**）：

1. **有时限与退出路径**：写明截止日，迁移到 ADR-0018 的"broker + 最小 capability"；到期未迁 = 事故。
2. **审计外送、不可本地清除**：远端只追加 + `-e 2` + `loginuid_immutable`；并承认 kore 仍可停本地 auditd，所以只能"检测"不能"阻止"。
3. **带外恢复能力**：控制台/救援模式、可重建镜像、密钥托管，且定期演练"root 被 kore 锁死后如何恢复"。
4. **收窄人的入口**：kore 账号 `nologin`、无密码、无 SSH key，唯一入口是受控 API——这只降低"人"的入口，不降低"代码执行"的风险。
5. **破坏性动作人工双确认 + 限速 + 熔断**，并明确记录"该动作等价于 root"。
6. **威胁模型诚实**：把 kore 及其全部插件当作"已 root"；插件不得与内核同权（ADR-0018 已如此定，不要在"root 等价"方案里退回插件同权）。
7. **失守预案**：一旦 kore 出现代码执行，按"host 已失守"处理——杀进程、轮换所有凭据、重装/重建，而不是"改配置收回权限"。

反过来：如果目标只是"让需要 root 的插件能用"，**ADR-0018 的 broker 路径（固定 argv 的 `root_actions` + 具名 transient unit + 逐条确认 + fail-closed 审计）在四项能力上都严格优于 root 等价**——它保留了限制（argv 白名单）、审计（unit 名 + 结构化事件）、撤销（不重启内核即可停用动作）、不被绕过（插件永不持有 root）。

---

## 7. 未实测项及原因（不得当成已通过）

| 项 | 状态 | 原因 / 替代证据 |
| --- | --- | --- |
| 真 root 侧动作（sudo 提权、改 sudoers、改用户） | **未实测** | 任务禁 sudo；且本机 `NoNewPrivs=1` 使 sudo 直接失败（实测报错原文见 §1.4） |
| auditd 规则加载与触发 | **未实测** | `auditd` 未安装（`auditctl`/`ausearch` MISSING）；只按 `/usr/include/linux/audit.h` 与上游 `audit.rules(7)` 语义给出规则 |
| capability 授予/收回 | **未实测** | `setcap` 需 `CAP_SETFCAP`，实测被拒；收回语义用 `capget(2)`/`capabilities(7)` 原文 + `/proc` 只读实测支撑 |
| systemd unit 变更 / `daemon-reload` | **未实测** | 需 root 且会改服务状态；用 `systemctl show` 只读输出 + `systemd.exec(5)` 原文支撑 |
| AppArmor 对 euid 0 的约束 | **未实测** | 需 root 加载 profile；仅引用 `capabilities(7)` 的 `CAP_MAC_ADMIN` 定义（"Allow MAC configuration or state changes"） |
| 真实 kore 实例上的行为 | **未实测** | 本机无 `kore.service`（`systemctl` 查无此 unit），无可运行的 kored |
| 创建临时系统用户 | **未做** | 需 root，且会污染 `/etc/passwd`；与"只读 + /tmp 最小实验"约束冲突 |
| `auditctl(8)`/`audit.rules(7)` 本地 man | **缺失** | 本机未装 audit 用户态包；内核 headers 也无 `Documentation/audit/`（实测） |

---

## 附录 A：只读探针脚本（已运行、已删除）

> 下面是与实测同源的脚本（清理了输出格式）。它**只读**：不写 `/etc`、不 sudo、不启停服务、不创建用户；临时文件仅落在 `/tmp` 并在退出时删除。实测时脚本位于 `/tmp/kore-root-manageability-probe.sh`，运行后已 `rm`。

```bash
#!/bin/bash
set -u
sec(){ echo; echo "########## $* ##########"; }

sec "A 身份 / 强制边界"
id; uname -r
grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp)' /proc/self/status
sudo -n true 2>&1 | head -2          # 预期被 NNP 拒绝，不构成提权

sec "B sudoers 权限与语法门禁（只写 /tmp 临时文件）"
ls -ld /etc/sudoers /etc/sudoers.d; stat -c '%n mode=%a owner=%U:%G' /etc/sudoers
[ -w /etc/sudoers ] && echo WRITABLE || echo "not-writable-as-$(id -un)"
D=$(mktemp -d /tmp/pua-sudo.XXXXXX)
printf 'kore ALL=(ALL:ALL) NOPASSWD: ALL\n' > "$D/all.sudoers"
printf 'kore ALL=(ALL) NOPASSWD ALL\n'        > "$D/broken.sudoers"
visudo -c -f "$D/all.sudoers"     # parsed OK：语法合法
visudo -c -f "$D/broken.sudoers"  # invalid：只拦语法
rm -rf "$D"

sec "C capability 不可外部改 + 非 root 不能自提权"
sleep 30 & P=$!; sleep 0.2
stat -c '%n mode=%a' "/proc/$P/status"; grep -E '^(Uid|Cap)' "/proc/$P/status"; kill $P
setpriv --reuid=0 --regid=0 --clear-groups id 2>&1
cp /bin/true /tmp/pua-setcap-test && setcap cap_dac_override+ep /tmp/pua-setcap-test 2>&1; getcap /tmp/pua-setcap-test; rm -f /tmp/pua-setcap-test

sec "D user namespace 的 uid0 ≠ 宿主 root"
unshare -Ur sh -c 'id -u; grep CapEff /proc/self/status; cat /proc/self/uid_map;
  head -1 /etc/sudoers; echo x >> /etc/sudoers' 2>&1 | tail -6

sec "E loginuid 只写一次（audit auid 的来源）"
echo "loginuid=$(cat /proc/self/loginuid)"
sh -c 'echo 0 > /proc/self/loginuid' 2>&1; echo "set-to-0 rc=$?"

sec "F systemd / cgroup 边界"
systemctl show cron.service -p User -p CapabilityBoundingSet -p KillMode
ls -l /run/systemd/private /run/dbus/system_bus_socket
stat -fc %T /sys/fs/cgroup
echo $$ > /sys/fs/cgroup/cgroup.procs 2>&1; echo "move-cgroup rc=$?"   # 非 root 预期失败

sec "G root 认证资产的可写性"
for f in /etc/passwd /etc/shadow /etc/sudoers /etc/pam.d/common-auth /etc/ssh/sshd_config /root; do
  [ -e "$f" ] && printf '%-28s %s\n' "$f" "$( [ -w "$f" ] && echo WRITABLE || echo denied )"
done
find /usr/bin /usr/sbin -maxdepth 1 -perm -4000 -type f 2>/dev/null | head
```

运行方式：`bash /tmp/kore-root-manageability-probe.sh`；结束后删除该文件即可（它不产生其他持久副作用）。
