> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5 · 实现进度: v1.0 第 3 条（插件降权）已落地
> ADR 状态: accepted · 日期: 2026-11-23 · 决策者: lead · 关联: ../SECURITY.md

# ADR-0018: 提权模型——插件保持低权，root 动作经内核代理执行

## 背景

M5 实测暴露一个结构性缺口：**kore 以启动用户身份运行，插件继承同一身份**；在非 root 环境下，需要宿主权限的插件"装了但用不了"，且不可用时的报错口径不统一。

### 实测事实（2026-11-23，本机 uid=1000）

| 观测 | 命令 | 结果 |
| --- | --- | --- |
| 运行身份 | `id` | `uid=1000(pt)`；补充组含 `27(sudo)`、`973(docker)` |
| 有效能力 | `grep CapEff /proc/self/status` | `0000000000000000`（无任何 capability） |
| 提权被禁 | `grep NoNewPrivs /proc/self/status`；`sudo -n true` | `NoNewPrivs: 1`；`sudo: The "no new privileges" flag is set, which prevents sudo from running as root.` |
| ufw | `ufw status` | `ERROR: 只有 root 用户才能运行此脚本`（英文 locale 为 `You need to be root to run this script`） |
| iptables | `iptables -L -n` | `Permission denied (you must be root)` |
| kored 进程身份 | `ps -o user= -C kored` | `pt`（**非 root**） |
| 插件进程身份 | `internal/core/supervisor/start.go:80` | `cmd.Env = append(os.Environ(), ...)`；未设置 `SysProcAttr.Credential` → 插件继承启动用户 uid/gid 与补充组 |
| 宿主 nginx | `command -v nginx` | 空；M4-B 验证用的真 nginx 只存在于容器内 |
| systemd | `systemctl --version`；`systemd-run --uid=0 --no-ask-password --scope /bin/true` | `systemd 259`；`Access denied as the requested operation requires interactive authentication`（exit 1） |
| docker | `ls -l /var/run/docker.sock` | `root:docker 0660`；当前用户属 `docker` 组 |

结论两条：

1. `firewall` 插件返回 `available=false, error="You need to be root"` **不是插件缺陷，是提权模型缺失**——插件只能如实报告"我没有权限"。
2. **`docker` 组已是等价 root 的既成授权**：不属于本 ADR 的提权机制，但必须计入威胁模型（见"后果"）。

### 哪些插件需要宿主权限（按"需要什么"分类）

| 需要的权限 | 插件 | 具体操作 | 当前实现状态 |
| --- | --- | --- | --- |
| 内核网络能力（root / `CAP_NET_ADMIN`） | firewall | `ufw` / `iptables` 规则读写 | 已真实调用；非 root 返回 `available=false` |
| 文件写入 + 服务控制 | site | 写 nginx 配置 → `nginx -t` → `nginx -s reload`（**仅当 nginx 在宿主**） | 已实现，默认 `nginx` 前缀；宿主无 nginx 时命令不存在 |
| 内核网络 + 配置写入 | waf | iptables / nginx 规则 | 骨架：只做参数校验，未接 ModSecurity / nginx 模块 |
| 系统配置文件写入 | dns | 改 `/etc/resolv.conf` 或控制 dnsmasq / systemd-resolved | 骨架：未实现写入 |
| 容器运行时 socket | container | `docker.sock`（组权限即可，非 uid 0 必需） | 骨架：不连 daemon；本机 docker 组已等价 root |
| 包管理 | runtime-php / runtime-python / runtime-node | `apt` / `dnf` / `apk` 安装 | 骨架：未实现装包 |
| 跨用户文件读 | backup | 读 `/var/www` 等白名单目录下他人属主的文件 | 白名单已实现；能否读取决于文件属主 |

### 哪些插件不需要（保持现状即可）

file（自身权限内）、logs、process（同 uid）、terminal（当前用户 shell）、db-mysql / redis（连库）、ssl（写自己目录，默认 `/etc/kore/ssl`）、backup（白名单目录内且属主可读时）。

**关键区分**：上面"需要 root"其实是四类不同事物——① 内核能力（网络规则）② 文件系统（`/etc`、他人目录）③ 服务控制（`nginx -s reload`）④ 包管理。**只看 capability 的方案（C）只能覆盖 ①**；只看命令白名单的方案（B）只覆盖 ②③④ 中被列举的命令。这是后文对比的前提。

## 备选方案对比

| 方案 | 实现复杂度 | 安全边界 | 运维成本 | 跨发行版兼容 | 与"零侵入" |
| --- | --- | --- | --- | --- | --- |
| A. 全 root 运行 | 低 | 最差：任一插件 / 内核漏洞 = 宿主 root | 低 | 最好 | 冲突 |
| B. sudoers 白名单 | 中 | 命令级；参数注入面大；sudoers 即边界 | 中高（每加命令改配置） | 中（需 sudo；容器常无） | 冲突较少 |
| C. AmbientCapabilities | 低-中 | 只覆盖 capability 类；`CAP_DAC_OVERRIDE` 一旦引入等于广域提权 | 低 | 中（依赖 setcap 与文件系统支持） | 好 |
| D. per-plugin setuid / root helper | 高 | 边界最清晰，但多一个特权二进制 = 多一个 root 攻击面 | 高 | 中（`nosuid` 挂载即失效） | 冲突 |
| E. 内核代理 + systemd transient unit | 中高 | 最好：按插件、按动作、unit 可审计 | 中（需 systemd / polkit） | 差（无 systemd 直接不可用） | 好 |

逐项优缺点（缺点写实，不为推荐方案让路）：

**A. 全 root 运行**（systemd unit `User=root`，插件也 root）
- 优点：最简单；宝塔 / 1Panel 等同类面板的通行做法（用户口径，本机未复验）；所有插件当天可用。
- 缺点：内核或任一插件的一个漏洞就是宿主 root，与"插件是不可信执行体"（[SECURITY](../SECURITY.md) §2）直接冲突；插件之间的隔离只剩进程边界，**uid 边界消失**；与"零侵入 / 完全归属使用者"的定位相悖。
- 交叉解读：本方案要求插件也 root。**另一个极端是"内核 root + 插件降权"**，那不是 A，而是下文决策采用的身份模型。

**B. sudoers 白名单**
- 优点：只授权特定命令，最小权限起点正确；无需自研协议；`visudo -c` 可校验语法。
- 缺点：白名单随插件增长而膨胀，每个新增动作都要改 `/etc/sudoers.d/`，**升级与配置漂移会成为新的事故源**；通配符 `*` 极易写出参数注入；`NOPASSWD` 等于把该命令的 root 权限永久给出；容器与 no-sudo 环境不可用；sudoers 本身是安全边界，写错即断 SSH。
- 适用位置：无 systemd 环境的**显式可选降级**，由运维手写片段，kore 不自动改 sudoers。

**C. systemd AmbientCapabilities**
- 优点：比 sudo 细、内核原生、不需要 sudoers；`CAP_NET_ADMIN` / `CAP_NET_BIND_SERVICE` 能精准覆盖网络与低端口。
- 缺点：**只覆盖 capability 类操作**；写 `/etc/nginx`、`/etc/resolv.conf`、装包、`systemctl reload` 都不在能力模型内；能力随进程继承，子进程同样持有；文件访问最终仍受 DAC 约束，想绕过得加 `CAP_DAC_OVERRIDE`，那等于把整个文件系统交出去。本机实测 `getcap` / `capsh` 存在，但当前 `CapEff=0`，且容器与 `NoNewPrivs` 场景下 `setcap` 可能被禁。
- 适用位置：可选**增强**（例如给 site 授 `CAP_NET_BIND_SERVICE` 绑定 80/443），不作主路径。

**D. per-plugin 提权（setuid 辅助程序 / root helper 二进制）**
- 优点：权限边界最清晰——只有声明了的插件被提权；不依赖 systemd，Alpine 也能用。
- 缺点：多一个**特权二进制**，等于多一个 root 攻击面，还要新增通信协议、生命周期、超时与孤儿进程处理；setuid 程序本身是攻击面（任何内存安全漏洞直接是 root）；打包、升级、签名面同步扩大；`nosuid` 挂载、`noexec` 的 `/tmp`、容器内均可能失效；与"薄壳"定位冲突（多一个常驻特权组件）。
- 适用位置：不采纳。它的收益（粒度）本 ADR 已用 E 拿到，代价却更高。

**E. 混合：内核代理 + systemd transient unit**
- 优点：不引入 setuid 二进制；不提权插件自身；按插件 / 按动作提权；unit 名可含插件与动作，journal 与审计天然可关联；root 授权走 polkit，可被策略约束。
- 缺点（三条实测 / 结构性）：
  1. **依赖 systemd**：Alpine、多数精简容器无 systemd，直接不可用，只能走降级；
  2. **非 root 内核调 `systemd-run --uid=0` 需交互认证或 polkit 规则**——本机实测 `--no-ask-password` 被拒；polkit 侧即便按 `manage-units` 的 unit 参数细化规则，也要 root 预置、随插件动作增长维护，本机未取得该路径的成功证据；
  3. **内核非 root 与插件独立 uid 不可同时成立**：把插件降到 `kore-<id>` 需要 `CAP_SETUID` / `CAP_SETGID`，内核自己非 root 就做不到。也就是说"内核非 root"必然放弃 [SECURITY](../SECURITY.md) §6 的插件 uid 隔离。
- 适用位置：**机制采纳，前提修正**——见决策。

## 决策

**采纳 E 的机制，修正其前提；B 作为无 systemd 环境的显式降级；A / C / D 不采纳。**

具体三条：

1. **身份模型**（不新增特权组件）：Linux GA 下 `kored` 以 root 启动，**插件一律降到 `kore-<id>` 运行**（[ARCHITECTURE](../ARCHITECTURE.md) §3.1 的既有目标）；`kored` 以非 root 启动是**显式降级形态**（开发 / 预览 / 容器），此时插件与内核同 uid，需要 root 的动作只能返回不可用。**不采纳"全 root 运行"**：插件不得与内核同权。
2. **提权通道**：需要 root 的动作**只能**由内核经 `systemd-run --uid=0 --collect`（transient unit，unit 名 `kore-root-<plugin>-<action>-<rand>`）拉起，插件进程自身永不获得 root。内核是唯一代理，**插件不得自行 exec sudo / setuid / 直接写 `/etc`**。
3. **声明与确认**：`info.json` 新增 `requires_root: true` 与 `root_actions: [{id, argv, timeout_s, irreversible}]`（**当前 Manifest 无这两个字段，属协议增补，v0.x 落地**）。`argv` 是**固定数组、不经过 shell**；内核不认识 `ufw` / `nginx` 等业务词，只校验 schema、把清单展示给用户确认、按 id 执行——保持 G-01 薄壳边界（内核不维护业务域名词表）。用户启用插件时**逐条确认** `root_actions`，与 capability 授予同一关卡。

**为什么是 E 而不是 A**：A 的"简单"是把风险从"某个插件用不了"换成"任一插件漏洞即宿主沦陷"，而 kore 的威胁模型明确把插件当不可信执行体；且 A 之下"插件独立 uid / cgroup / peercred"这一整套隔离设计全部作废。

**为什么不是 B 作主路径**：白名单的正确性依赖人工维护，插件每加一个动作就要改系统配置，长期必然漂移；参数注入面也比"固定 argv 数组"大得多。B 只在无 systemd 时作为运维显式选择。

**为什么不是 C 作主路径**：C 覆盖不了 site / dns / runtime 的文件与服务控制需求（见背景四类划分），单靠 capability 会出现"网络能改、配置写不进"的半可用状态，比明确不可用更难排查。

**为什么不是 D**：多一个特权二进制就多一条 root 攻击链与一条发布链，收益与 E 重叠。

## 分阶段落地

**v0.x（本轮之后的首批，纯协议 + 降级，不改提权实现）**

1. 统一降级口径：需要 root 的插件在 `available=false` 时**必须**同时给 `error`（机器码 `E_NEED_ROOT`）与 `hint`（可操作提示）；禁止空错误、禁止返回空列表冒充"没有数据"。
2. `info.json` 增补 `requires_root` / `root_actions`，`requires_kore` 抬升；registry 只做解析与 schema 校验，`argv` 非空、不经 shell、长度与超时上限固定。
3. 启用/升级时展示 `root_actions` 清单并要求确认；未确认即 `E_UNAUTHORIZED`（与 capability 未授予同码）。
4. 审计事件 `root.action` 先落"拒绝"路径：无权限、未确认、无 systemd 均记一条。
5. 验收用例两个：firewall（无 root → `available=false` + `E_NEED_ROOT`）、site（宿主无 nginx → 错误含命令缺失，不吞成成功）。

**v1.0（真提权）**

1. 交付 systemd unit（`deploy/systemd/kore.service`，当前仓库尚无此文件）：`User=root`（或用户显式选择 `User=kore` + `Delegate=yes`，后者需同步重划 `/run/kore`、`/etc/kore`、`/var/lib/kore` 的属主）。
2. 实现 `root_actions` 执行器：`systemd-run --uid=0 --collect --wait -p StandardOutput=file:<tmp> -p StandardError=file:<tmp> --unit=... -- <argv...>`，超时杀 unit，收集 exit code 与 stdout 上限。**已移除 `--pipe`**：`--pipe` 与 `-p StandardOutput=file:` 并存时 systemd 会静默忽略文件属性，unit 的 stdout/stderr 永远为空（R5-1 真机实测；systemd-run 仍退出 0，属静默错误）；等待与退出码透传由 `--wait` 负责，不需要 `--pipe`。
3. **插件独立 uid `kore-<id>`（已落地，2026-11-23）**：root 内核下按需创建系统账户、`exec.Cmd.SysProcAttr.Credential` 降 uid/gid、socket chown + SO_PEERCRED 校验、状态目录属主与父链可穿越。实现选择、被否决方案、降级矩阵与未证明项见本文「实现记录」。
4. 非 systemd 环境：文档给出 B 的 sudoers 片段（运维手写、`visudo -c` 校验、限定 `kore` 用户与精确 argv），或直接 `available=false`。
5. 不可回滚动作的护栏全量生效（见下）。

## 实现记录（2026-11-23，插件降权落地）

### 选定的方案

**平台层 `Identity` / `Access` 接口 + root 内核按需创建 `kore-<id>` + exec 时写 `SysProcAttr.Credential`。**

| 环节 | 实现 | 落点 |
| --- | --- | --- |
| 身份解析/创建 | `Identity.Current / Lookup / Ensure / Apply`；Linux 实现用 `os/user` + 固定 argv 的 `useradd`（回退 Debian `adduser`） | `internal/platform/{platform.go,linux_identity.go,stub_identity.go}` |
| 文件权限 | `Access.Own`（属主 + mode）、`Access.Traversable`（只补 o+x） | 同上 |
| 降权判定 | `New` 读 `Current()`：uid=0 → 降权；非 root / 非 Linux → **显式 WARN 降级**（插件与内核同 uid） | `internal/core/supervisor/{manager.go,options.go}` |
| 启动顺序 | `prepareDemotion`（唯一建用户点）→ `listen`（socket chown 0600）→ `spawn`（Credential + HOME/USER/LOGNAME）→ hello（SO_PEERCRED 校验 pid 与 uid） | `internal/core/supervisor/{demote.go,start.go,socket.go,hello.go}` |
| 失败策略 | 用户建不出来 / chown 失败 / Credential 写入失败 → **本次启动失败**（`E_INTERNAL` + 人话提示），绝不退回同 uid | 同上 |

**用户来源与代价（为什么是按需创建）**

- `kore-<id>` 不存在时，由 root 内核在**该插件第一次启动前**创建：`useradd --system --home-dir /nonexistent --shell <nologin> --user-group <name>`（不传 `-m`，默认不建 home）；工具走固定候选路径（`/usr/sbin`、`/usr/bin`、`/sbin`），**不查 `PATH`**（避免 PATH 注入把 root 交给伪造的 useradd）。无 `useradd` 时回退 Debian `adduser --system …`；同名组已存在时复用其 gid。两者都失败即启动失败。
- 代价：首次启动多一次 `useradd`（本机实测几十毫秒，仍在 2s hello 预算内）；**持久化副作用**是 `/etc/passwd` 与 `/etc/group` 各一条记录（无 home、nologin、不自动删除）；清理命令 `userdel kore-<id>`。
- 只给「真正要跑的插件」建用户：disabled 插件不产生系统账户；不引入常驻组件、不写 `/etc/sysusers.d`。

**目录 / socket 权限模型（与 [SECURITY](../SECURITY.md) §6 一致）**

| 路径 | 属主:组 | mode | 说明 |
| --- | --- | --- | --- |
| `/var/lib/kore`、`/run/kore`（及其 `plugins` 子目录） | root:root | `0701` | 只补 o+x：插件能穿越到自己的目录/socket，但**不能列举** |
| `/var/lib/kore/plugins/<id>`（`KORE_STATE_DIR`） | `kore-<id>:kore-<id>` | `0700` | 插件自己的可写状态目录；**不**为可写放宽到 0777 |
| `<id>/<version>`（版本树：入口二进制与包内文件） | root:root（安装器） | 目录/可执行 `o+rx` | 安装器用 `0700` 落位（`MkdirTemp`），降权后插件属 other 类，必须补 `o+rx` 才能 exec；**属主与写权限不动**，插件改不了自己的二进制 |
| `/run/kore/plugins/<id>.sock` | `kore-<id>` | `0600` | 主壳 listen 后 chown；插件只 connect；hello 阶段校验 `SO_PEERCRED` 的 uid + pid |
| `/run/kore/kore.sock`（管理/通道入口） | root:root | `0600` | 只有 root 可连——与插件 bearer 通道的冲突见下 |

**被否决的方案**

| 方案 | 否决理由 |
| --- | --- |
| 启动时按 registry 批量建全部用户 | 为未启用插件也建账户（状态更多、启动更慢），之后新增插件仍要二次创建；改动面更大 |
| `systemd-sysusers` + `/etc/sysusers.d/kore.conf` | 多一个持久配置文件与重跑步骤，仍依赖外部工具；对无 systemd 环境无收益 |
| 部署脚本/安装包预创建用户 | 与「安装即用、自动发现」冲突；插件 id 在运行期才确定，预创建必然漂移 |
| 全部插件共用一个 `kore-plugin` 用户 | 放弃 per-plugin uid 隔离：socket 的 SO_PEERCRED、进程间 ptrace/kill 边界都退化为同 uid，等于只换了用户名 |
| 直接改写 `/etc/passwd` / `/etc/shadow` | 绕过 NSS 与 `lckpwdf` 锁语义，损坏风险不可接受 |
| 降权失败时回退同 uid，或给插件 sudoers / `CAP_*` | 前者是 G-16 禁止的静默降级；后者等于换皮不换实质（docker 组同样等价 root） |

### 降级矩阵（插件 × 动作 × 低权可用性 × 失效时的正确行为）

| 插件 | 动作 | 低权下可用性 | 失效时的正确行为 | 证据 |
| --- | --- | --- | --- | --- |
| echo | 协议握手 / ping | **可用**（进程 `Uid=993 kore-echo`） | — | 实测 |
| monitor | `/proc`、`/sys` 只读采集 | **可用**（`monitor.system` 200） | 单项不可读时缺省 + 明示，不把整页渲染成 0 | 实测 |
| logs | 读 world-readable 文件 | **可用**（自定义源 tail 200） | `/var/log/syslog`（`0640 root:adm`）→ 权限错误 + hint；不允许空列表冒充"没有日志" | 实测 |
| terminal | PTY + 登录 shell | **可用**，但 shell 身份 = 插件 uid（实测 `id -u`=994、组仅 `kore-terminal`） | 不能 `sudo`/`ufw`/`nft`（实测全部 exit 1）；UI 必须显示会话身份 | 实测 |
| firewall | 读状态、写规则 | 读经 **root-action 通道**可用（admin 会话实测 exit 0）；插件自连通道被 `kore.sock 0600` 阻断 | `available=false` + `E_NEED_ROOT` + hint（实测）；写动作另需 confirm 令牌 | 实测 |
| process | `/proc` 读、kill | 读可用；kill 仅限同 uid 进程（`EPERM`） | `E_NEED_ROOT` + hint，不得静默忽略失败 | 代码审阅（未装） |
| file | 允许根内读写 | 可用（受 DAC 约束） | 越权路径 `E_ACCESS` + hint；写系统目录需声明 `root_actions` | 代码审阅（未装） |
| site | 写 `/etc/nginx` + reload | **不可用**（DAC 拒绝） | `E_ACCESS`/`E_NEED_ROOT` + hint；要么为 site 声明 `root_actions`，要么改用插件自有 nginx 前缀 | 代码审阅（未装） |
| container | `docker.sock` | **不可用**（不在 `docker` 组，实测 `docker ps` exit 1） | `E_NEED_ROOT` + hint；**禁止**把插件加进 docker 组（等价 root） | 实测（插件 shell） |
| waf / dns / runtime-* | 改系统配置 / 装包 | **不可用** | `E_NEED_ROOT` + hint，待各自声明 `root_actions` | 设计推演（未验证） |

> 判据：**失效必须是结构化、可操作、可审计的**；不允许为了"都能用"放宽成 0777、加 sudoers 或授 `CAP_SYS_ADMIN`。

### 插件侧通道的已知阻断（已裁决，待下一轮实现）

[SECURITY](../SECURITY.md) §7 规定内核 UDS `/run/kore/kore.sock` 为 `root:root 0600`、"只有 root 可直连"；而本文「调用方边界」又要求插件用 `KORE_PLUGIN_TOKEN` bearer 调通道——**降权后这两条自相矛盾**。实测：

- 默认 `0600`：`kore-firewall` 连内核 socket 得 `connect: permission denied`，`firewall.status` 退化为 `E_NEED_ROOT`（显式、非静默）；
- 隔离实例里把该 socket 临时 `chmod 0666` 后，同一调用 `available=true`、`exit_code=0`（随后立即回滚 `0600`），证明**代码路径可用，唯一阻断点是 socket 权限**。

**裁决（2026-11-23，lead）**：采用**独立通道 socket**——独立路径（如 `/run/kore/root/` 下）+ `0660 root:kore` + 组内各 `kore-<id>` + `SO_PEERCRED` 同时校验 uid（必须等于该插件 `kore-<id>`）与 pid（必须是 supervisor 记录的子进程）。否决：②放宽 `kore.sock` 到 `0660`（所有 kore 组进程可连管理面，爆炸半径过大）；③只由管理会话发起（插件自主 root 动作彻底不可用，waf/dns 自动响应报废）。**本轮只固化降权，通道实现留待下一轮**，届时补本节的三方案对比与 socket 细节。

### 未证明项（不得当成已通过）

1. macOS / Windows（Tier B）降权：非 Linux 平台只有 `ErrUnsupported` 桩，插件仍是同用户运行；`SECURITY §6.3` 的"macOS 独立 uid"仍是目标而非实测。
2. 无 `useradd`/`adduser` 的发行版（部分 Alpine/busybox）上按需建用户：仅实现固定候选路径 + 回退，**未实测**。
3. SELinux / AppArmor enforcing 下 `Credential` + `chown` 全链路：未在 enforcing 宿主实测。
4. 「版本树补 o+rx」会让版本目录成为**世界可读**；当前包内只有二进制与 `info.json`，可接受。**触发条件**：若未来包内含证书/密钥等敏感文件，必须改为按包属主可读（`0700 kore-<id>` 或安装期按清单 chown），见 [SECURITY](../SECURITY.md) §15.4。
5. 插件对自己状态目录（`0700 kore-<id>`）里的版本子目录有写权限（父目录属主是插件），可自行破坏/替换自己的版本目录——只影响自身可用性，不构成提权；未做防篡改。
6. 主实例与非 root 部署的切换：先以 root 跑过（目录已 chown 给 `kore-<id>`）再以非 root 跑，插件会因目录不可进入而启动失败；本轮只保证错误可见，未做自动回切。
7. 独立通道 socket（已裁决方案①）本轮未实现，插件经 `KORE_KERNEL_SOCK` 自连仍不可用（显式 `E_NEED_ROOT`）。

## 降级行为（硬要求）

非 root / 无 systemd / 被 polkit 拒绝时，插件**必须**返回结构化不可用，禁止静默失败：

| 字段 | 要求 |
| --- | --- |
| `available` | `false` |
| `error` | 机器可读码 `E_NEED_ROOT`（无 systemd 另给 `E_NO_SYSTEMD`），不得留空 |
| `hint` | 可操作中文提示，必须包含两条路径之一：「需 root 权限：请用 sudo 启动 kored」或「为插件配置 systemd 提权（见 docs/RUNBOOK.md）」 |

禁止清单：返回 `ok` 但什么都没做；`error` 为空；把权限错误映射成 `E_INVALID`（会被当成参数问题）；返回空规则列表让 UI 显示"0 条规则"；在日志里只打一行 WARN 就继续。UI 侧：不可用必须是**禁用 + 原因**，不得渲染成"无数据"。

## 审计要求

每条提权动作（含被拒绝的）写 `root.action`：`ts`、`actor`（会话 id / 来源 IP hash）、`plugin_id`、`action_id`、`argv`（敏感参数以 `***` 脱敏）、`unit`、`decision`（`allow` / `deny`）、`deny_reason`、`exit_code`、`dur_ms`。落 bbolt `audit` bucket 与 `/var/log/kore/`，保留期同 [SECURITY](../SECURITY.md) §11（30 天或 10 万条）。

**fail-closed**：审计写入失败时**动作不执行**并返回 `E_INTERNAL`——不允许"日志没写进去但命令跑了"。审计字段白名单沿用 §11，不新增自由文本字段。

## 不可回滚操作护栏

需额外护栏的动作（`root_actions[].irreversible: true`）：防火墙规则变更、IP / 路由变更、服务 `restart` / `reload`、包卸载或降级、删除备份、容器 `stop` / `rm`。

1. **二次确认**：执行前必须带一次性 `confirm` 令牌（UI 二次确认 / CLI `--yes`），令牌与 `plugin_id + action_id` 绑定、单次有效；缺失即 `E_UNAUTHORIZED` 并记 `root.action` 的 `deny`。
2. **预演优先**：动作支持 dry-run 时必须先跑预演并把差异展示给用户，再执行。
3. **断连保护**：防火墙 / IP 类动作要求声明回滚命令与超时自动回滚（v1.0 实现；v0.x 至少要求提示"该操作可能断开 SSH"）。
4. **一次一确认**：不得批量静默执行同类动作；并发提权请求排队，不合并。

## 后果

**正面**：root 面收敛为"内核 + 声明过的 `root_actions`"，插件永远拿不到 root；"装了但用不了"变成可解释、可操作、可审计的状态；与"零侵入 / 完全归属使用者"一致；为后续收窄内核权限留出接口。

**负面 / 已知代价**：协议新增字段（`requires_kore` 抬升，插件需重发版）；systemd 依赖使 Alpine 类环境只能降级；启用时逐条确认增加操作步骤（与易用性四原则的"步骤尽量少"存在张力，需在 UI 侧用预设默认勾选缓解）；**v0.x 之前需要 root 的插件仍然不可用**，本 ADR 不改善当下可用性，只定义口径。

**记录在案的漂移（2026-11-23 已收敛）**：此前文档写"主壳 root 运行、插件 `kore-<id>`"而实测同 uid（`start.go:80` 未设 Credential）。本轮已实现插件降权并以真 root 隔离实例证明（`.agents/verify/r5-plugin-demotion.md`），[SECURITY](../SECURITY.md) §6 / §15 同步为"已实现 + 降级矩阵 + 未证明项"。
**仍存漂移（不掩盖）**：①独立通道 socket 已裁决但未实现（见「插件侧通道的已知阻断」），插件自连通道当前不可用；②[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md)「运行目录 0700/0600」的表述未包含降权所需的 o+x 父链（该文件本轮有其他轨道的未提交改动，未在写域内，需由对应 owner 同步）；③cgroup 落盘仍未实现（与本 ADR 无关，另轨）。

**另一条既成授权**：本机 `docker` 组成员可读写 `docker.sock`（`root:docker 0660`），等价 root。它不属于本 ADR 的提权机制，但**必须**在威胁模型里显式列出——否则"插件低权"只是名义上的。container 插件在无 docker 组时是否必须降级，属 v0.x 插件侧任务。

## 验证方式

```bash
make docs-check                 # 文档门禁
make check                      # 10 段聚合门禁
wc -l AGENTS.md                 # ≤132

# 复现"非 root 不可用"（应全部失败，且错误可读）
id -u; grep -E 'CapEff|NoNewPrivs' /proc/self/status
ufw status; iptables -L -n
sudo -n true
systemd-run --uid=0 --no-ask-password --scope /bin/true
ps -o user= -C kored
grep -n 'cmd.Env' internal/core/supervisor/start.go   # 第 80 行，无 Credential
```

v0.x 实现后的验收：firewall 在非 root 下 `available=false` + `E_NEED_ROOT`；site 在无 nginx 宿主上错误含命令缺失；`root.action` 在拒绝路径有审计条目。

## 复审条件

1. 出现内核或 systemd 提权类 CVE 影响本机制 → 立即复审并评估关闭 `root_actions`。
2. 要求把无 systemd 发行版（Alpine）列为**一等支持** → 重新评估 B / D，不能只靠"降级为不可用"打发。
3. `kored` 非 root 部署成为默认（用户级安装）→ 插件 uid 隔离与提权同时失效，必须新开 ADR 重划权限模型，不得在本 ADR 上打补丁。
4. 插件数量增长导致 `root_actions` 确认疲劳（用户开始无脑点确认）→ 引入预设级或分组确认，并重评"逐条确认"是否仍有效。
5. 包签名链路落地后 → 把"签名 + 声明清单"作为提权的前置条件之一。

## 关联

- [SECURITY.md](../SECURITY.md) §2 信任边界 / §6 插件隔离 / §11 审计 / §14 加固路线
- [ARCHITECTURE.md](../ARCHITECTURE.md) §3.1 进程模型（"主壳 root、插件低权"目标）
- [PLUGIN-PROTOCOL.md](../PLUGIN-PROTOCOL.md) §3.1 `info.json` 字段（`requires_root` / `root_actions` 增补落点）
- [ADR-0013](./0013-extreme-resource-frugality.md)（薄壳 / 零额外常驻组件）
- [ADR-0016](./0016-resource-budget-final.md)（预算红线：提权执行器不得引入常驻进程）
