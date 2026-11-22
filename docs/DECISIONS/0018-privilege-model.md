> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
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
2. 实现 `root_actions` 执行器：`systemd-run --uid=0 --collect --pipe --unit=... -- <argv...>`，超时杀 unit，收集 exit code 与 stdout 上限。
3. 插件独立 uid `kore-<id>` 落地（当前未实现，见 [SECURITY](../SECURITY.md) §6 与本文"后果"的漂移记录）。
4. 非 systemd 环境：文档给出 B 的 sudoers 片段（运维手写、`visudo -c` 校验、限定 `kore` 用户与精确 argv），或直接 `available=false`。
5. 不可回滚动作的护栏全量生效（见下）。

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

**记录在案的漂移（不掩盖）**：文档 [SECURITY](../SECURITY.md) §2 与 [ARCHITECTURE](../ARCHITECTURE.md) 写"主壳 root 运行、插件 `kore-<id>`"，实测 kored 与插件均为 uid 1000 同身份（`start.go:80`）；`kore-<id>` 用户创建与 cgroup 落盘尚未实现。本 ADR 把"目标形态 / 当前降级形态"分开写清，落地时按 G-06 同步两份文档，不把文档描述当已实现。

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
