# 权限模型分析：kored 用 root 还是 kore 用户

> 元信息: 2026-11-23 · 执行者 priv-model-analysis 子 agent · 性质：**只读架构分析，不改代码/ADR**
> 输入约束：① 只有「壳子安装」一次 sudo，运行期任何操作不得要求本机系统口令；② 定位是薄壳调度内核 + 每插件一仓的低权插件；③ 必须具备 8 类全权管理（装包、任意系统配置写入、防火墙、容器、系统用户/账号、服务、证书、数据库/中间件）。
> 对齐基线：`docs/DECISIONS/0018-privilege-model.md`、`0042-privilege-without-prompt.md`、`internal/core/privilege/*`、`pkg/pluginapi/{rootaction,rootpolicy}.go`、`scripts/install.sh`。
> 只读声明：本会话未起服务、未 sudo、未改任何既有文件；`git status` 里 `internal/core/httpapi/*` 的在途改动与本次分析无关。

## 0. 结论速览

1. **「kore 用户 + root 等价」不是一个独立的安全方案**，它等于 root，只是多了一层 sudo。B 相对 A 的唯一真实收益是「平时非 root」与「每次提权有 sudo 日志」；一旦 kore 被攻破，两者爆炸半径相同。
2. **只要 kore 持有 root 等价能力，root 对 kore 的管理就不是机制保证**：kore 能改 `/etc/sudoers`、自己的 unit、审计规则、root 的 authorized_keys；`chattr +i` 也拦不住（CAP_LINUX_IMMUTABLE 同样在它手里）。root 剩下的控制手段在操作系统信任域之外（控制台、恢复启动、BMC）。
3. 现有 `root_actions` 白名单（`pkg/pluginapi/rootpolicy.go`）目前以**只读动作**为主（iptables/systemctl/docker 只读、nginx 只 reload），**尚不满足「全权管理」**；把装包、任意配置写入、账号管理补进白名单时，白名单会迅速逼近 root——这是「全权」与「严格低权」的固有张力，必须显式承认。
4. **推荐 D（分裂架构）**：kored 主进程降到 `kore` 用户，特权收敛到一个极小的 root helper，只执行「声明过、经形状校验」的动作与插件账号/进程操作。它的代价是多一个特权进程（与薄壳/预算红线冲突）、新 IPC 与插件启动路径改造，以及「全权」只能以枚举能力域表达，不再是通用 root 口子。
5. 若团队接受「kored 被攻破 = 宿主 root」（dockerd / 宝塔同类模型），则 A（现状 ADR-0042）是合理选择，D 属过度设计——**决策的关键输入是「kored 自身被攻破是否在威胁模型内」**，不是「要不要全权」。

## 1. 现状基线（代码事实 + 本机实测）

### 1.1 既有设计的三条硬事实

| # | 事实 | 依据 |
| --- | --- | --- |
| 1 | 插件一律降到 `kore-<id>` 运行，root 动作只能由内核经 `systemd-run --uid=0` 的 transient unit 执行，unit 名 `kore-root-<plugin>-<action>-<rand>` | ADR-0018 §决策 2、`internal/core/privilege/systemd.go:35-43` |
| 2 | 内核默认形态是系统级 root 服务（`User=root`），运行期不做 polkit 授权判定 | ADR-0042、`scripts/install.sh:88-118` |
| 3 | root 动作不是「任意 argv」：`argv[0]` 限系统二进制目录，声明参数必须匹配「命令 + 子命令 + 参数形状」，追加参数只能落在 Tail 形状上 | `pkg/pluginapi/rootpolicy.go:520-600`、`rootpolicy.go:700-725`、`internal/core/privilege/service.go:152-185` |

### 1.2 本机机制证据（2026-11-23，只读命令）

| 观测 | 命令 | 结果 | 含义 |
| --- | --- | --- | --- |
| 运行身份 | `id` | `uid=1000(pt)`，groups 含 `27(sudo)`、`973(docker)` | **docker 组已是 root 等价既成授权**（ADR-0018 §后果已记） |
| 能力集 | `grep -E 'Cap(Eff\|Bnd)' /proc/self/status` | `CapEff=0`；`CapBnd=000001ffffffffff` | 当前进程无有效能力；bounding set 含全部 41 个 cap（`capsh --decode` 实测） |
| setuid 提权被禁 | `sudo -n true` | `sudo: The "no new privileges" flag is set, which prevents sudo from running as root.` exit=1 | NNP 会让 setuid-root 的 exec 不再授予权限（setuid(2)/capabilities(7) 语义） |
| sudo 二进制 | `ls -l /usr/lib/cargo/bin/sudo` | `-rwsr-xr-x root root` | 本机是 sudo-rs；setuid root |
| sudoers 属主 | `ls -l /etc/sudoers /etc/sudoers.d` | `-r--r----- root root`（0440），目录内文件同样 0440 | 只有 root 能写 → 非 root 的 kore 无法自我加权限 |
| unit 目录属主 | `ls -ld /etc/systemd/system` | `drwxr-xr-x root root`；unit 文件 0644 root:root | 非 root 不能改/加 unit |
| 系统服务 loginuid | `cat /proc/{1,619,669,1552}/loginuid` | 全部 `4294967295`（unset） | 系统服务的审计 auid 是 unset，可与登录会话区分 |
| 登录会话 loginuid | `cat /proc/self/loginuid` | `1000` | 登录 shell 的 auid 是用户 uid |
| auditd | `command -v auditctl`；`ls /etc/audit/rules.d` | 均不存在 | 本机**没有**可用的内核审计规则与 auditd；当前「审计」只有 kore 自报的 bbolt `root.action` |
| cgroup | `cat /sys/fs/cgroup/cgroup.controllers` | `cpuset cpu io memory pids …` | cgroup v2 可用，`Delegate=yes` 可下放子树 |
| 系统级 unit | `ls /etc/systemd/system/kore.service` | 不存在 | ADR-0042 的真装与「root 零交互」**至今未在本机实测** |

### 1.3 必须先承认：现状白名单覆盖不了「全权管理」

`RootCommandPolicies` 已登记的命令里，`iptables` / `systemctl` / `docker` / `crontab` 是**只读**；`ufw` 的写动作只允许端口/应用名；`nginx` 只允许 `-t`/`-s reload`；`chmod`/`chown` 路径限定在 kore 自有目录。**装包、任意 `/etc` 写入、系统账号管理、服务 restart、docker run 均不在其中**。也就是说：

- 现方案 A 今天也做不到「全权管理」，它只做到了「插件低权 + 少量受控 root 动作」；
- 把上述能力补进白名单，等于逐步把 root 能力搬进白名单：`apt install` 会执行包 maintainer script（**按设计就是 root 任意代码执行**），`docker run -v /:/host` 等价 root，`systemctl start <任意 unit>` 等价 root；
- 因此「全权」的准确表述应是：**枚举出来的能力域 + 每域的形状/路径约束**，而不是「任意」。

## 2. 选项矩阵

### 2.1 选项定义

| 选项 | 形态 |
| --- | --- |
| **A** | `kored` 以 root 运行（现状 ADR-0042），插件降 `kore-<id>`，root 动作经 transient unit |
| **A′** | A + systemd 沙箱收口：`CapabilityBoundingSet` 最小化、`NoNewPrivileges=yes`、`ProtectSystem=strict` + `ReadWritePaths`、`ProtectHome`、`RestrictSUIDSGID`、`SystemCallFilter=@system-service` |
| **B** | `kored` 以 `kore` 用户运行 + `sudo NOPASSWD: ALL`（或等价完整 capability 集） |
| **C** | `kored` 以 `kore` 用户运行 + 受限能力集（精确 `CapabilityBoundingSet` / sudoers 白名单 / D-Bus 策略） |
| **D** | 分裂：kored 主进程低权（HTTP/鉴权/插件协议/存储全在此），特权收敛到极小 root helper；helper 只执行声明动作 + 插件账号/进程原语 |

### 2.2 同表打分（✅ 满足 / ⚠️ 有条件 / ❌ 不满足）

| 选项 | 全权管理 | 攻击面 / 爆炸半径 | 可审计性（区分 kore vs root） | 可撤销性（root 单方面收紧） | 与既有设计一致性 | 实现 / 运维代价 |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | ✅ uid0 直通 | ❌ kored 被攻破 = 宿主 root；白名单在 kored 内可被绕过 | ⚠️ 只有自报 `root.action`；uid0 的 auid=unset，auditd 可关联但 root 可改审计 | ⚠️ 可改 unit 重启，但运行中的 root kored 能改回/加后门 | ✅ 就是 ADR-0042 现状 | ✅ 最低（0 新组件） |
| **A′** | ✅ transient unit 仍全权（需实验 E2 确认） | ⚠️ 写面收窄，但 uid0 仍可读 root 属主文件、signal root 进程；**白名单仍在 kored 内，攻破即可直接 `systemd-run` 绕过** | ⚠️ 同 A；因写面小，异常更显眼 | ✅ 收口后 kore 改不了自己的 unit/sudoers（`ProtectSystem=strict` + 去掉 CAP_SYS_ADMIN） | ✅ 0042 + 加固字段，不改身份模型 | 低-中（建用户需挪出 kored，见 4.3） |
| **B** | ✅ `sudo ALL` | ❌ 被攻破即 `sudo` 拿 root；相对 A 无实质隔离 | ⚠️ sudo 自带日志（命令/auid/euid），但拿到 root 后可改规则与日志 | ⚠️ 删 sudoers 下次调用生效；已获 root 的会话/持久化后门不受影响 | ❌ ADR-0018 明确否决 sudoers 主路径；ADR-0042 否决运行期授权层 | 中高（sudoers 维护、发行版差异、通配符注入面、容器/Alpine 无 sudo） |
| **C** | ❌ 覆盖不了装包/任意写入/服务/账号；补白名单即退化成 B | ⚠️ 本身低权；但白名单里的 `apt`/`docker run` 等于 root | ✅ 低权进程 + unit/sudo 记录可区分 | ✅ root 改 caps/sudoers 后重启即生效，kore 无写路径 | ⚠️ 方向一致但达不到需求 | 高（每能力枚举、跨发行版、白名单漂移） |
| **D** | ✅（枚举域）：8 类能力做成声明动作；「任意写」须收敛为声明路径前缀 | ✅ kored/插件被攻破只能触发白名单动作；helper 面 = UDS + 固定 argv + 账号原语 | ✅ unit 名 + helper 日志 + `SO_PEERCRED` 可三方对齐；kore 非 root 改不了审计规则 | ✅ 停 helper / 改 unit 即可；kore 无写路径 | ⚠️ 符合 0018「插件低权、内核代理」；**冲突 0042「kored 本身 root」与 0013/0016「不新增常驻组件」** | 高（+1 进程、新 IPC、插件 spawn 改造、预算实测、新 ADR） |

### 2.3 逐项论证（只列决定性的机制）

**A（现状）**：`kored` 是系统里网络面最大的组件（HTTP/UDS/鉴权/插件协议/包解压/状态库），它一旦被攻破，攻击者不需要走 `privilege` 包——直接 `systemd-run --uid=0 -- /bin/sh` 就是 root，因为 uid 0 对 systemd 的 D-Bus 调用本来就放行。**白名单是 kored 自己的代码，不是内核边界**。这正是 A 的核心弱点，也是 A′ 无法修好的部分。

**A′**：`ProtectSystem=strict`（systemd.exec(5)：整个文件系统只读，除 `ReadWritePaths` 与 API 文件系统）、`CapabilityBoundingSet`（capabilities(7)：限制 execve 能获得的能力）、`NoNewPrivileges=yes`（systemd.exec(5)：进程及其子进程永远不能通过 execve 获得新权限，含 setuid 与文件 capability）能把 kored 从「root 等价」压到「受限 root 启动器」。它值得做，但**不能替代 D**：kored 仍是 uid 0、仍有 D-Bus 管理面，白名单仍可被它自己绕过。残余还包括：uid 0 对 root 属主文件走 owner 位（`/etc/shadow` 是 `0640 root:shadow`，owner-read 不需要 CAP_DAC_OVERRIDE），以及同 uid 可向其他 root 进程发 signal（kill(2) 的 uid 匹配规则）。

**B**：`sudo` 是 setuid-root 二进制（本机实测 `-rwsr-xr-x`），`NOPASSWD: ALL` 等于把 root 交给 kore。相对 A 的收益只有两点：平时不持 root（90% 的 bug 路径不直接是 root）、每次提权留 sudo 日志。代价是 sudoers 是新的事故源（ADR-0018 已列：每加动作改配置、通配符注入、容器/Alpine 无 sudo）。**结论：B 是 A 的削弱版，不是替代方案。**

**C**：受限 capability 的前提是「目标操作由 capability 检查」，但本需求里大量操作不是：`useradd` 要写 `/etc/passwd`（root 属主 + DAC）、`apt` 的 maintainer script 需要完整 root、`systemctl` 的 unit 管理走 D-Bus → 非 root 要 polkit 授权（就是会弹口令的那条路径）。此外 `CAP_SETUID` 本身就是 root 等价（可以 `setuid(0)` 回到 root），所以「给 kore 足够能力降插件 uid」与「kore 非 root」不可兼得——这一点比 ADR-0018 原文的表述更强。

**D**：把「决定」与「执行」拆到两个 uid。kored 被攻破后最多向 helper 请求白名单动作；helper 的代码面只有 UDS 协议 + `pkg/pluginapi` 形状校验 + 4 类原语（执行动作、建账号、chown socket、以 `kore-<id>` 起插件）。这是唯一能让「root 对 kore 的管理」重新变成机制保证的形态。

## 3. 直接回答：kore 能做 root 的事，root 还管得住 kore 吗？

**总答：如果 kore 是 root 或 root 等价，管不住——不是「很难」，是「没有机制」。** 分四个子问题：

### 3.1 限制 kore

| 场景 | 结论 | 机制依据 |
| --- | --- | --- |
| A / B（root 等价） | ❌ 不能可靠限制 | `/etc/sudoers` 0440 root:root、`/etc/systemd/system` 0755 root:root，但 kore 就是 root → 可写；`chattr +i` 需要 CAP_LINUX_IMMUTABLE，kore 同样持有；可 `systemctl edit` 自己、加新 unit、改 `/etc/audit`、写 `/root/.ssh/authorized_keys` |
| A′（受限 root） | ✅ 可限制，前提是沙箱字段到位 | `ProtectSystem=strict` 让 kore 的 mount namespace 里 `/etc` 只读；`CapabilityBoundingSet` 去掉 CAP_SYS_ADMIN/CAP_DAC_OVERRIDE 后它无法 remount/绕过 DAC；`RestrictSUIDSGID` 阻止造 setuid 后门；`NoNewPrivileges` 阻止 exec setuid 提权。**只要还留着 CAP_SYS_ADMIN 或能写自己的 unit，限制就能被撤销** |
| C / D（非 root） | ✅ 机制保证 | 上表的 0440 / 0755 对非 root 就是硬边界；kore 无写路径 |

补充：`/etc/shadow` 是 `0640 root:shadow`，uid 0 以 owner 身份可读（不需要 CAP_DAC_OVERRIDE）；`ProtectSystem=strict` 只改可写性、不改可读性。所以 A′ 下 kore 仍可能读走口令哈希与 root 属主配置——这是 uid 0 的固有暴露面，D 才能去掉。

### 3.2 审计 kore（能否区分「kore 发起」与「root 自己发起」）

| 层 | 能否区分 | 依据与缺口 |
| --- | --- | --- |
| 内核 audit（auditd） | ⚠️ 有条件 | execve 记录含 `auid/euid/uid/ppid/comm/exe`；系统服务 loginuid=unset（本机 pid 1/udevd/journald 实测 4294967295），登录会话 auid=1000（实测 `/proc/self/loginuid`）→ 两者可分。**但本机未装 auditd**，且 root 等价的 kore 能 `auditctl -D`、改 `/etc/audit/rules.d`、停 auditd、清日志；只有 `-e 2`（规则锁定到重启）**加**远端转发才谈得上抗篡改（本机无 auditctl，未实测） |
| kore 自报 `root.action` | ❌ 单独不可信 | bbolt 记录由 kored 自己写（`internal/core/privilege/audit.go`，begin fail-closed 只保证「写不进去就不执行」，不保证「不被伪造/删除」）；被攻破的 kore 可以只写它想写的 |
| transient unit | ✅ 强关联 | unit 名 `kore-root-<plugin>-<action>-<rand>`（`unitName`），journal 里 `_SYSTEMD_UNIT`/`_COMM=systemd-run`/ppid 可把动作与 kored 关联；`systemd-run` 由 uid0 发起这件事本身可被审计 |
| D（helper） | ✅ | kore 非 root，改不了 audit 规则；helper 是唯一 root 发起者，动作有 unit 名 + helper 日志 + 调用方 `SO_PEERCRED`（uid/pid）三重证据 |

**结论**：A/B 下「审计」只是事后尽力；D 下才是可采信的第三方证据。

### 3.3 撤销 kore 权限

| 权限形态 | 撤销方式 | 生效边界 | 机制依据 |
| --- | --- | --- | --- |
| sudoers 白名单 | 删行 / `visudo` | 对**下一次** `sudo` 调用生效（sudo 每次调用重新解析策略——本机 sudo-rs 手册未逐字给出该句，标「未逐字确认」） | 已获得的 root shell、已植入的 unit/cron/authorized_keys/setuid 二进制**不会**因删规则消失 |
| capability | 改 unit 的 `CapabilityBoundingSet` + restart | **运行中进程无法被外部改 capability**：`capset(2)` 只作用于调用线程自身；父进程不能收回子进程已有能力 | capabilities(7)：bounding set 自 2.6.25 起是 per-thread，且只能由持有 CAP_SETPCAP 的进程自行 `PR_CAPBSET_DROP` 降低 |
| unit `User=` | 改 unit + `daemon-reload` + `systemctl restart` | 只影响下一次启动；运行中的进程不受影响 | systemd 不会因 unit 文件变更而改已运行进程的 uid |
| 插件账号 `kore-<id>` | `userdel` + 清理目录 | 立即 | 但已写入的文件、组关系需另清 |
| 退出 root 身份 | `setuid(非0)` | **不可逆**（对当前进程） | setuid(2)：特权进程调用 setuid 会同时设置 real/effective/saved；降到非 0 后无法回到 0 |

**关键**：撤销对 A/B 只在「kore 配合」时有效。root 等价进程可以先把自己变成 root（B）、或改回 unit（A），撤销与反撤销是同一把钥匙。D 下 kore 根本没有这把钥匙。

### 3.4 root 自身策略变更不被 kore 绕过

| 变更 | A / B 下能否被 kore 绕过 | D 下 |
| --- | --- | --- |
| 改 sudoers / 加白名单 | 能：kore 就是 root，直接写；`chattr +i` 也能被 `chattr -i` | 不能：kore 非 root，0440 即边界 |
| 改 `kore.service`（换 `User=`、加 `ProtectSystem`） | 能：kore 可写 `/etc/systemd/system`，甚至加自己的 drop-in | 不能：unit 属 root，kore 无写路径；root 改完 restart 生效 |
| 改审计规则 / 删审计日志 | 能：`auditctl -D`、改 `/etc/audit/rules.d`、清日志；`-e 2` 只锁规则不锁日志文件 | 不能改规则；日志篡改面缩小 |
| 改 root 口令 / authorized_keys | 能（root 可写 `/etc/shadow`、`/root`） | 不能 |
| 改内核参数 / 加载模块 | 能（CAP_SYS_ADMIN / CAP_SYS_MODULE） | 不能（kore 无 cap） |
| 用 LSM 再分层（SELinux/AppArmor） | ⚠️ 理论可行、工程上难：Ubuntu 默认 root 服务多为 unconfined；profile 文件本身在 `/etc`，除非对 kore 的 namespace 只读 | 不需要（uid 边界已经够） |

**一句话**：在操作系统内部，**唯一能对 root 等价进程形成硬边界的机制是「不给它 root 等价」**（或 LSM 策略，但那要按发行版单独维护且默认不覆盖 root）。这也是为什么「kore 用户也能做到 root」与「直接用 root」在安全上等价。

## 4. 推荐：D（分裂架构），A′ 只作过渡

### 4.1 目标形态（最小代价版，不新增 unit 文件）

- 仍只有 `/etc/systemd/system/kore.service`（保留 ADR-0023 §3.5 豁免 #1）：`User=root`、`Type=simple`、`ExecStart=kored serve`。
- kored 启动后第一步 fork 出 `kored-privd`（同一二进制、独立子命令、**不 import** httpapi/registry/market，只有 UDS 协议），主进程随后 `setgroups([])` → `setgid(kore)` → `setuid(kore)` 完成不可逆降权（setuid(2) 语义）。
- helper 只做 4 类原语：① 执行经 `pkg/pluginapi` 形状表校验的 `root_actions`（经 `systemd-run --uid=0`）；② 建/删 `kore-<id>`（同样经 transient unit 调 `useradd`，helper 自己不写 `/etc/passwd`）；③ 把 `<install>/run/**` 下的 socket chown 给 `kore-<id>`；④ 以 `kore-<id>` fork/exec 插件（二进制限定 `<install>/plugins/**`、root 属主、uid 限定 `kore-*`）。
- 管理面（HTTP/UDS/鉴权/CSRF/插件协议/state.db）全部留在低权主进程；helper 退出 → 主进程立即退出（fail-closed），交给 `Restart=on-failure`。

### 4.2 为什么不是 A / B / C

- **A**：全权 ✅、代价最低 ✅，但 kored 是最大攻击面，攻破即宿主 root，且 root 对 kore 的管理失去机制保证——正好命中用户的担忧。
- **B**：与 A 同为 root 等价，只是多一层 sudo；安全收益接近于零，运维代价更高。
- **C**：满足不了「装包 / 任意配置 / 服务 / 账号」；补白名单就变成 B；且 `CAP_SETUID` 本身可回到 root，「受限」名不副实。
- **A′**：值得作为过渡（几乎零成本，见 §5 E2），但它只能让 kore「不那么方便地作恶」，不能让 kore「不能作恶」，因为白名单在它自己进程里。

### 4.3 牺牲了什么（诚实清单）

1. **牺牲薄壳纯粹性**：多一个常驻 root 进程。与 ADR-0013/0016「不新增常驻组件」和 G-03「主壳空载 ≤16 MiB」直接冲突，必须实测 helper RSS（Go 进程常见 3–6 MiB，很可能顶破主壳红线）。这是 D 最大的现实阻力。
2. **牺牲实现简单性**：新 UDS 协议、helper 生命周期/超时/孤儿处理、插件 spawn 从 supervisor 移到 helper（`SysProcAttr.Credential` 的调用点迁移）、socket chown 的权限模型；故障域从 1 个变 2 个。
3. **牺牲「任意」语义**：全权变成「枚举能力域 + 形状/路径约束」。装包只能是「从配置的仓库安装」（禁止本地 `.deb`），任意配置写入只能是「插件声明的路径前缀 + 内容上限」，且必须对 `/etc/sudoers*`、`/etc/shadow`、`/etc/passwd`（写入类）、`/etc/systemd/system`、`/root`、`/etc/ssh`、审计配置做硬 denylist——否则那个动作本身就等于 root。
4. **牺牲易用性**：新增动作要发版 + 用户确认，确认疲劳真实存在（ADR-0018 §后果已记）。
5. **残余风险（不可消除，只能披露）**：
   - helper 自身漏洞 = root（虽然面小）；
   - `apt install` 的 maintainer script 按设计就是 root 任意代码执行，白名单只能约束「装哪个包」，不能约束包内脚本；
   - helper 是 uid 0，仍可读 `/etc/shadow`、可向其他 root 进程发 signal（除非再叠 LSM）；
   - 撤销权限不等于清除已植入的持久化，需要人工清理；
   - 插件仍共享组 `kore` 且 socket 属主是 root（ADR-0018 已记的残余取舍），D 不改变这一点。

### 4.4 与既有 ADR 的冲突（需新 ADR，不在本报告修改）

- 推翻 ADR-0042 §决策「kored 以系统级 root 服务运行」中的**身份**部分（授权路径「运行期零口令」保留）。
- 修正 ADR-0018 §15.1「kored 以 root 启动」；同时可以顺手修正其中「内核非 root 与插件独立 uid 不可同时成立」的表述——更准确的原因是 **CAP_SETUID 本身 root 等价**，所以必须由 helper 代做降权。
- 触发 ADR-0023（若 helper 独立成 unit 则新增豁免；同一 unit fork 则不新增）与 ADR-0016/G-03（多一个进程的预算）。
- ADR-0042 的 `NoNewPrivileges=false` 注释需要复核（见 §5 E2）。

## 5. 必须先做实验才能定论的 3 个点

### E1：uid=0 调用 `systemd-run --uid=0` 是否真的不经过 polkit（ADR-0042 的核心前提）

```bash
sudo bash scripts/install.sh --install-root /opt/kore
systemctl show -p User --value kore            # 期望 root
# 通过管理会话触发任一个 root 动作（firewall ufw-status）
journalctl -u polkit --since -5min | grep -c manage-units
journalctl -u polkit --since -5min | tail -20
```

- `manage-units` 计数 **0** → ADR-0042 的前提成立：uid 0 根本不进入授权判定，零口令是结构性保证。
- 计数 **>0 但无口令框、动作成功** → 零口令成立，但「没有授权判定」不成立，ADR-0042 的措辞与 A/D 的论证需要修正（应说「隐式放行」而非「不判定」）。
- 出现 `FAILED to authenticate` / 动作 `Access denied` → 前提不成立，**A/A′/D 的零口令路径都要重开**（只能回到 polkit 规则或安装期预置授权）。

### E2：`NoNewPrivileges=yes` + 最小 `CapabilityBoundingSet` 下，root 动作与插件降权是否仍工作

```bash
sudo systemctl edit kore        # drop-in: NoNewPrivileges=yes
                                # CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_CHOWN CAP_DAC_READ_SEARCH
sudo systemctl restart kore
sudo grep NoNewPrivs /proc/$(pgrep -x kored)/status        # kored 自身期望 1
# 触发一个 root 动作：期望 exit_code=0
# 触发一个插件启动：期望 ps -o user= 显示 kore-<id>
sudo systemd-run --uid=0 --collect --wait /bin/sh -c 'grep NoNewPrivs /proc/self/status'
```

- 动作成功 **且** transient unit 内 `NoNewPrivs=0` **且** 插件降权成功 → ADR-0042 的 `NoNewPrivileges=false` 注释是错的（NNP 不随 pid1 发起的 unit 继承），A′ 可以立刻落地，且 kored 被攻破后不能靠 setuid 再提权。
- 动作失败（systemd-run 被拒） → 注释正确，A′ 只能靠 `ProtectSystem` + caps 收口，不能开 NNP。
- `useradd` 在 `ProtectSystem=strict` 下失败是**预期**：这正好证明建插件用户必须走 transient unit 或安装期预置（D 的设计前提）。

### E3：非 root + 受限 capability 能否零口令起 transient unit（决定 B/C 是否可能）

```bash
sudo useradd -r -M -s /usr/sbin/nologin koreprobe
sudo install -m 0755 /bin/true /tmp/koreprobe
sudo setcap cap_setuid,cap_setgid+ep /tmp/koreprobe
sudo -u koreprobe /tmp/koreprobe && echo "caps ok"
sudo -u koreprobe systemd-run --uid=0 --no-ask-password --scope /bin/true
```

- `Access denied` / polkit 拒绝 → 非 root 无法零口令起 unit；B/C 的「完整能力集」路线不成立（且 `CAP_SETUID` 已可 `setuid(0)`，所谓「受限」是假象）。
- 成功（依赖预先写入的 polkit 规则） → 回到 ADR-0042 已否决的方案 A，需要新增 ADR-0023 豁免与规则维护。

> 仅用于隔离测试机；`setcap cap_setuid+ep` 让任何能执行该文件的用户变成 root，**不要在生产机执行**。

## 6. 未确认项（不得当成已通过）

1. `sudo`/sudo-rs 是否每次调用重新解析 sudoers：经典 sudo 文档如此，本机 sudo-rs 手册未逐字给出 → **未逐字确认**。
2. audit `-e 2`（规则不可变）与远端转发的抗篡改效果：本机无 auditd/auditctl → **未实测**。
3. polkit 对 uid 0 的隐式放行：**未实测**（E1）。
4. AppArmor 能否有效约束 uid 0 的 kore：**未验证**；Ubuntu 默认 root 服务多为 unconfined。
5. `ProtectSystem=strict` 在容器/用户服务下的行为：systemd.exec(5) 明确说用户服务与部分容器里不可用 → 依赖宿主形态。
6. D 的 helper 实际 RSS 与是否顶破 16 MiB 主壳红线：**未测**。
7. `useradd` 在 `ProtectSystem=strict` 下失败：**推断**，需 E2 实测。
8. 真装系统级 unit 与「root 特权动作零交互」：ADR-0042 自己记录为未实测，本会话同样未做（无 sudo、未起服务）。

## 7. 参考

- `docs/DECISIONS/0018-privilege-model.md`（身份模型、root_actions、审计、不可回滚护栏）
- `docs/DECISIONS/0042-privilege-without-prompt.md`（系统级 root 服务、零口令链路、未实测项）
- `docs/DECISIONS/0023-zero-intrusion.md` §3.5（unit 豁免 #1）
- `internal/core/privilege/{service,systemd,audit,confirm}.go`
- `pkg/pluginapi/{rootaction,rootpolicy}.go`（命令 + 子命令 + 参数形状三级约束）
- `scripts/install.sh`（unit 模板：`User=root`、`NoNewPrivileges=false`、`KillMode=mixed`）
- 手册页：capabilities(7)、setuid(2)、systemd.exec(5)、systemd-run(1)、sudoers-rs(5)
- 本机实测命令与结果见 §1.2、§5（均为只读或隔离测试机命令）
