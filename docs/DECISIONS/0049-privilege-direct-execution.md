> 状态: accepted · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [0018-privilege-model](./0018-privilege-model.md)、[0042-privilege-without-prompt](./0042-privilege-without-prompt.md)、[0022-root-command-shapes](./0022-root-command-shapes.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[SECURITY](../SECURITY.md) §15

# ADR-0049: 特权动作由内核直接执行——移除 systemd-run / polkit 提权中间层

## 背景：用户的两条硬性判断（2026-11-24）

> 「kore 要有 root 权限，其他的通过 root 处理不就好了吗」
> 「root 的管理本来也是咱们软件能力的一部分」

这不是「要不要提权」的实现细节，而是产品定位：**kore 就是在替用户管这台机器的 root 操作**，对标宝塔 / 1Panel（都是 root 运行）。由此推导出三条不能混为一谈的东西：

| 概念 | 归属 | 本 ADR 的处理 |
| --- | --- | --- |
| **持有 root**（谁有特权身份） | kore 内核 | 保留：`kore.service` `User=root`（ADR-0042） |
| **申请 root**（插件怎么用特权） | 插件 → 内核 | 保留：root-action 通道 + 参数形状校验 + 审计 |
| **root 动作怎么被执行**（机制） | 内核实现细节 | **本 ADR 改**：由 `systemd-run --uid=0` 改为直接 `exec` |

**一条底线不变**：`kore 有 root` ≠ `插件有 root`。插件必须降到 `kore-<id>`；否则不是「root 管理是产品能力」，是「把 root 分发给每个插件」。

## 一、现状核实（全部带 `file:line`，命令与原始输出见 `.agents/verify/priv-direct-exec-audit.md`）

### 1.1 特权动作当前怎么执行

| 事实 | 位置 |
| --- | --- |
| 提权通道 = `systemd-run` transient unit，`--uid=0` | `internal/core/privilege/systemd.go:37`（argv 构造）、`:23-36`（设计说明） |
| argv 原文：`systemd-run --uid=0 --collect --wait -p StandardOutput=file:<out> -p StandardError=file:<err> --unit=<unit> -- <argv...>` | `internal/core/privilege/systemd.go:36-45`；测试锁定在 `privilege_test.go:359-362` |
| 执行顺序：schema → confirm → `Root()` → `Systemd()` → 审计 begin → Runner.Run → 读输出 → 审计 end | `internal/core/privilege/service.go:77-150` |
| 超时后 `systemctl kill/stop <unit>` | `internal/core/privilege/systemd.go:70-82`（`KillUnit`） |
| 错误提示明写依赖 polkit | `internal/core/privilege/service.go:147`（"检查 systemd / polkit 权限与命令是否存在"） |
| systemd 可用性是**硬前置**：`/run/systemd/system` + `systemd-run` + `systemctl` | `internal/core/privilege/systemd.go:181-195`（`DetectSystemd`）；`service.go:88-93` 返回 `E_NO_SYSTEMD` |
| HTTP 入口 → 执行器 | `internal/core/httpapi/handlers_rootaction.go:44-70` |

### 1.2 插件进程实际用什么 uid 跑

| 事实 | 位置 |
| --- | --- |
| 降权只在**内核 uid==0** 时启用 | `internal/core/supervisor/manager.go:81-86` |
| 非 root 内核 → 显式降级「插件与内核同 uid」，不静默 | `internal/core/supervisor/manager.go:88-95`；`demote.go:60-70`（`demotionOutcome` 带 Reason） |
| 降权落地：`Lookup` → `Ensure` → 数据根 chown → 二进制补 o+rx → `SysProcAttr.Credential` | `internal/core/supervisor/demote.go:56-70`（步骤 1–6）、`:100-120` |
| **现网事实**：`kored` 以 `uid=1000(pt)` 运行 | `ps -o pid,user,uid,comm -C kored` → `809422 pt 1000 kored` |

### 1.3 `kore-<id>` 系统用户创建逻辑**存在**

| 事实 | 位置 |
| --- | --- |
| 前缀 `kore-` | `internal/core/supervisor/demote.go:13` |
| 用户名长度/语法校验（≤32 字节） | `demote.go:100-110` |
| 查不到就 `Ensure` 创建；失败即拒绝启动（**不降级为同 uid**） | `demote.go:112-125` |
| 解析为 `uid<=0` 时拒绝（防「降权到 root」） | `demote.go:127-131` |
| 实现：`useradd` / `adduser`，**固定绝对路径候选**（防 PATH 劫持） | `internal/platform/linux_identity.go:25-30`、`:104-188` |
| 创建后加入内核通道共享组（socket 0660 才能连） | `demote.go:114`；`internal/platform/linux_identity.go:112-128` |

**结论：`kore-*` 用户数 = 0 的根因不是「没实现降权」，而是「内核没以 root 跑」**（`manager.go:88`）。这是形态问题，不是代码缺口。

### 1.4 ADR-0018 与 ADR-0042 是否矛盾

**不矛盾，但 0018 把「机制」和「授权」写在同一句里，容易被误读成「systemd-run 是安全边界」。**

- ADR-0018 §15.1（`:94-95`）：内核 root、插件 `kore-<id>`、root 动作**只能**经 `systemd-run --uid=0` transient unit。
- ADR-0018 `:281`（尾注，0042 之后追加）：落地形态已定为系统级 root 服务，**运行期不经过任何 polkit 授权判定**。
- ADR-0042：安装形态 `User=root`，uid=0 不进入 polkit 判定，故「零运行期授权」。

真实的层次是：**polkit 是授权层**（root 内核下不参与），**systemd-run 是执行机制**（仍在用）。ADR-0018 把两者绑在一起写，才产生「保留 systemd-run 就等于保留授权」的误解。本 ADR 把机制与授权正式拆开。

## 二、这层现在到底提供了什么：逐项核账

判断口径：**它比「root 进程直接 exec」多得到了什么**，且这项能力**当前代码里是否真的用上**。

| 能力 | 当前是否真的用上 | 依据 | 直接执行能否替代 |
| --- | --- | --- | --- |
| 授权（polkit `manage-units`） | **否**：root 内核下 uid=0 不判定（ADR-0042）；非 root 下 `service.go:85` 先返回 `E_NEED_ROOT`，polkit 永远到不了 | `service.go:84-87`、`0042` 背景节 | 不涉及（本来就没在用） |
| cgroup 资源限额（`MemoryMax` / `CPUQuota` / `TasksMax`） | **否**：`BuildSystemdRunArgv` 只设 `StandardOutput` / `StandardError`，**一条限额都没设** | `systemd.go:36-45` | 需要就上 cgroup v2 / `setrlimit`，与 systemd-run 无必然关系 |
| 超时后**整棵进程树**回收 | **是**：`systemctl kill --signal=SIGKILL <unit>` 杀的是 unit cgroup | `systemd.go:70-82` | 可以：`Setpgid=true` + `kill(-pgid, SIGKILL)`（`internal/platform` 收口） |
| unit 名做审计关联（`kore-root-<plugin>-<action>-<rand8>`） | 是（弱价值） | `privilege/audit.go`、`service.go:102` | 审计表已含 plugin/action/argv/exit_code/dur_ms，unit 名只多一个 journal 抓手 |
| **真实退出码透传** | **否**：只透传 `systemd-run` 的退出码 | `systemd.go:58-64` 注释自认 | **直接执行反而修好这个缺陷**（`ProcessState.ExitCode()`） |
| 平台可用性 | **负价值**：无 systemd 即 `E_NO_SYSTEMD`；Tier B（macOS 12+ / Windows 10 1809+）与无 systemd 容器完全不可用 | `systemd.go:181-195`、`pluginapi/errors.go:25` | 直接执行天然可移植（进程组/Job Object 由 `internal/platform` 分支） |
| 每次动作的额外进程与延迟 | 成本：一次 `systemd-run` + transient unit 创建/回收 | — | 去掉即省 |

**判断：在当前实现下，这一层提供的安全 ≈ 0（限额从未启用、授权已被 root 形态绕过），提供的故障 ≥ 1（polkit 死路 + systemd 硬依赖 + 退出码丢失）。按「提供安全还是提供故障」回答：提供故障为主。**

**但必须诚实记录它的真实价值**：`systemd-run` 具备「按动作的 cgroup 限额 + 整棵进程树回收」的能力，只是**从来没被启用**。所以本 ADR 砍的不是「这个能力」，而是「用 polkit + systemd 依赖去换一个没启用的能力」这个组合。要用限额，正确形态是 cgroup v2 直接设置（见复审条件 1）。

## 三、裁决：**A —— 砍掉 systemd-run，kore 以 root 直接执行**

### 依据（按权重）

1. **安全边界在「kore 是 root / 插件不是」，不在「kore 经 systemd-run 执行」。** 一旦调用方 uid=0，systemd-run 只是同一个 uid 的另一个进程；它不构成权限边界。把机制层当安全边界，会让真正的边界（插件降权 + 参数形状 + 审计）被稀释。
2. **现状证据表明这层没在提供保护，却在制造不可用。** 限额未设、授权在 root 形态不参与；而非 root 形态下 `service.go:85` 又把动作挡在 polkit 之前——`waf` 的 `rule.add/remove/toggle` 报 `E_NEED_ROOT` + polkit 拒 `systemd-run`，就是这条死路的实例。**这是功能坏了，不是保护生效。**
3. **去掉后还能修好两个现存缺陷**：真实退出码透传（现在丢失）、非 systemd 环境可用性（Tier B / 容器）。
4. **符合产品定位**：kore 持有 root 是产品能力，执行路径越短越好排查；审计与回滚由内核自己保证，而不是押在宿主 systemd 的配置上。

### 强制前置（不是可选项，缺一不许落地 A）

- **P1 进程树回收**：`exec` 时 `Setpgid=true`，超时 `kill(-pgid, SIGKILL)`；平台分支收在 `internal/platform`（G-16）；Windows 用 Job Object，做不到时**显式降级并写进文档**（禁止静默）。
- **P2 退出码与输出**：透传真实 `ExitCode()`，保留 stdout/stderr 各 1 MiB 截断（`service.go:18`）、`LC_ALL=C`、不经 shell。
- **P3 插件降权先行**：见 §4.2。在 `demotion.enabled=true` 真机验证前，不得把内核切到 root 形态。

### 被否决项

| 选项 | 否决理由 |
| --- | --- |
| **B. 保留 systemd-run，修好 polkit 让 waf 可用** | 对 root 形态无意义：uid=0 不进 polkit 判定（ADR-0042）。对非 root 形态，`service.go:84-87` 先把动作挡回 `E_NEED_ROOT`，polkit 规则永远到不了。修好只是「给降级形态补一条路」，与本次目标（root 是产品能力）无关，且要新增 `/etc/polkit-1/rules.d` 豁免项（ADR-0023 §3.5 需扩），换来一个写宽了没人复核的长期风险。 |
| **C. 分层：简单的直接执行，需要限额的走 systemd-run** | **方向对，但当前不能作为主裁决**：现在**没有任何** action 声明资源限额，分层只会新增「每个 action 选执行器」的配置轴，收益为 0。C 的正确形态是「按需给动作加 cgroup v2 限额」，而不是「保留 systemd-run 当默认执行器」。保留为触发式复审（复审条件 1/2）。 |
| 全 root 含插件（ADR-0018 A'） | 破坏插件隔离，被攻破即整机；与「插件必须降权」底线冲突。 |
| sudoers 白名单 / AmbientCapabilities / setuid helper | 沿用 ADR-0018 结论：参数注入面大 / 只覆盖 capability 类 / 多一个特权二进制。 |

## 四、砍掉什么、保留什么

### 4.1 砍掉

| 砍掉 | 位置 |
| --- | --- |
| `BuildSystemdRunArgv` / `execRunner` / `KillUnit`（systemctl 路径） | `internal/core/privilege/systemd.go:36-82` |
| systemd 作为 root 动作的**硬前置**（`DetectSystemd` → `E_NO_SYSTEMD`） | `internal/core/privilege/service.go:88-93`；`systemd.go:181-195` |
| 提权错误里的 polkit 口径 | `internal/core/privilege/service.go:147` |
| `E_NO_SYSTEMD` 的触发语义（常量保留做协议兼容，不再因缺 systemd 触发） | `pkg/pluginapi/errors.go:25` |
| 对 systemd transient unit 的执行依赖（`systemd` 探测降为 envprobe 信息项） | `internal/core/envprobe/` |

### 4.2 保留（一条都不能少，违反即提权口子）

1. **参数校验（ADR-0022 三级形状）**：声明 argv 逐位匹配 `CommandPattern.Tokens`；追加参数只能落在该 pattern 的 `Tail` 上；绝对路径仅限 `/bin` `/sbin` `/usr/bin` `/usr/sbin` `/usr/local/bin` `/usr/local/sbin` —— `pkg/pluginapi/rootpolicy.go:36-45`、`service.go:155-190`。
2. **capability / 动作校验**：动作必须由插件 `info.json` 声明、安装时用户确认，`ValidateAction` 拒绝非法 id / argv / timeout —— `privilege/privilege.go:13-18`、`pkg/pluginapi/rootpolicy.go`。
3. **内核身份校验**：非 root → `E_NEED_ROOT`，不静默执行 —— `service.go:84-87`。
4. **不可逆动作 confirm 令牌**（一次性、5 分钟、绑 plugin+action）—— `service.go:88-92`、`confirm.go`。
5. **审计 fail-closed**：begin 写不进审计就**不执行**；end 失败只 WARN（动作已发生无法回滚）—— `service.go:104-140`。
6. **输出上限 1 MiB / 流、超时上限、无 shell、`LC_ALL=C`** —— `service.go:18`、`request.go:72`、`systemd.go:52-55`。
7. **插件降权 + 补充组收口**（`Credential` 清空继承组，防 docker 组等价 root）—— `demote.go:56-70`。

### 4.3 安全后果：插件被攻破后能做什么

| 形态 | 插件身份 | 被攻破后能做什么 | 与现在比 |
| --- | --- | --- | --- |
| **现在**（内核非 root，`kore-*`=0） | 与内核同 uid = `pt`，补充组含 `docker` / `sudo` | 读内核 state、直连 `docker.sock`（**已等价 root**，且不经审计）、本进程内伪造 root-action 请求 | 基线 |
| **简化后、降权仍未生效**（内核 root，`kore-*`=0） | **root** | **整机 root**，且绕过参数形状、confirm、审计 | **风险显著变大 —— 禁止进入此形态** |
| **简化后、降权生效**（内核 root，`kore-*`=kore-<id>） | 低权，无特权组 | 只能发 root-action 请求：受 argv 形状 + Tail 约束 + 审计 + 不可逆动作 confirm；拿不到 shell、写不了任意路径 | **风险变小**（现在 docker 组就是未审计的等价 root 后门） |

**一句话：安全后果的符号完全取决于「降权是否先落地」，不取决于砍不砍 systemd-run。** 这也是为什么 P3 是硬前置而不是并行项。

## 五、lead 追加三问的回答

### 5.1 审计链怎么变成产品功能？现有 `changes.jsonl` / `audit` 够不够？

**现状（够做合规，不够做产品）**：

- `root.action` 审计（`privilege/audit.go:13`）记录 actor / plugin / action / argv（脱敏）/ unit / decision / exit_code / dur_ms，落 bbolt（`store.AuditRecord`，`store/audit.go:36-44`），经 `GET /api/v1/audit` 暴露。
- `changes.jsonl`（`cmd/kored/changes.go:30-43`）只记**安装期用户批准的宿主变更**（ts / plugin / action / target / before / after / reversible / `purge_op`），与 root 动作**完全没打通**。

**缺什么（按用户视角）**：

1. **人话摘要**：现在只有 argv 原文，普通用户看不懂「nft add rule … drop」意味着什么 → 每个 action 应带一句中文说明（"封禁 IP x.x.x.x 的入站"）。
2. **影响对象与回滚指引**：root 动作没有 `target` / `rollback`；应复用 `purgeOp` 的结构化回滚（**禁止 shell 字符串**，`changes.go:15-28` 已定这条红线）。
3. **因果链**：begin/end 是两条独立记录，用户看到的是碎片；应能按 `actor+plugin+action+时间窗` 串成一个「这次软件做了什么」。
4. **用户视图**：按插件 / 时间 / 是否可回滚过滤，并给出「撤销」入口。
5. **能力归类**：把动作映射到「它用了哪类权限」（网络 / 文件 / 服务 / 包管理），而不是让用户读 argv。

**建议（下一张卡）**：action 声明 `writes_host: true` 时，执行成功后**必须**追加一条 `changes.jsonl` 条目（带结构化 `purge_op`），审计视图把「人话摘要 + 影响对象 + 回滚入口」三件套渲染出来。**未提供回滚信息的写宿主动作，应降级为需 confirm 的不可逆动作。**

### 5.2 插件降权是这次简化的前置还是并行？

**硬前置。** 理由：本 ADR 移除了一个独立进程（systemd-run）这层「额外一跳」，同时把「kore 直接执行」变成默认。若此时插件仍与内核同 uid，插件被攻破 = root，且**完全绕过**参数形状、confirm 与审计——风险从「docker 组后门（至少是宿主既有授权）」升级为「无审计的 root 分发」。

**验收判据（三条同时成立才算前置完成）**：
1. `ps -o user= -C kored` → `root`
2. 每个运行中插件 `ps -o user= -p <pid>` → `kore-<id>`（`kore-*` 用户数 > 0）
3. `GET /api/v1/system/info` 的 `demotion.enabled` = `true`，`reason` 为肯定句

三条未同时成立前，**不得把内核切到 root 形态**；切了就是拿产品能力换整机风险。

### 5.3 capability 模型要不要升级成「用户可配」？

**不升级为运行期策略编辑器。** 保持「插件声明（`info.json` root_actions）+ 安装时用户确认」，只做两处增强：

- **安装时**：把声明翻译成人类可读的能力清单（"将可以：读写防火墙规则 / 写 nginx 配置并 reload / 安装系统包"），一次确认。
- **运行后**：审计按能力归类统计（哪个插件用了哪类权限、用了多少次）。

理由：① G-11 明确不做多用户 RBAC，策略引擎会把它带回来；② 产品易用性四原则（预设优先、不让用户填细节）；③ **argv 形状校验是内核红线，不能开放给用户改写**——写错就是提权口子，而"可配"的产品语义会被理解成"可改"。可配的边界只到「装不装、开不开某个 action」，不到「改它的执行形状」。

## 六、影响面

| 面 | 内容 |
| --- | --- |
| **代码（下一张卡）** | `internal/core/privilege/systemd.go` → 重写为直接执行（进程组 + 退出码）；`service.go`（去 systemd 前置、改 hint、保留 Root 判定）；`privilege_test.go`（argv 断言改直接 exec + 新增进程组回收用例）；`pkg/pluginapi/errors.go`（`E_NO_SYSTEMD` 常量保留、不再触发）；`internal/platform/linux_signal.go` / `cleanup.go`（进程组 kill 收口）；`internal/core/envprobe/`（systemd 降为信息项） |
| **文档** | `docs/RUNBOOK.md` §5（提权排障口径）、`docs/SECURITY.md` §15（执行机制与授权分离）、`docs/CORE.md`（privilege 模块说明） |
| **受益插件** | `waf`（`rule.add/remove/toggle` 立即可用，不再 `E_NEED_ROOT`+polkit 拒）、`firewall`（ufw/iptables）、`site`（nginx -t / reload）、`dns`、`runtime-php/python/node`（装包）、`backup`（跨用户读） |
| **ADR** | ADR-0018 追加尾注：执行机制由 systemd transient unit 改为内核直接执行（条件见本 ADR）；ADR-0042 追加尾注：`User=root` 前提继续有效，删除对 `systemd-run --uid=0` 的机制依赖；新增本 ADR-0049 |

## 七、未确认项（诚实记录）

1. **未在本机实测 root 形态**：本会话 `NoNewPrivs=1`、`sudo` 被内核阻断、`/etc/systemd/system` 不可写（与 ADR-0042 §实测边界同因），因此「root 内核 + 插件 `kore-<id>` + 直接执行」的端到端链路**未经真机验证**。
2. **`waf` 0.4.4 BLOCKED 的原始报告未在本仓库找到**（`.agents/verify/` 内只有 waf 版本/深度等级类记录），本 ADR 引用任务卡转述；机制侧的死路已由 `service.go:84-87` + `systemd.go:181` 独立证实。
3. **`systemd-run --wait` 退出码语义**依据 `systemd.go:58-64` 的代码注释，未做真机对照实验。

## 八、复审条件（触发即重开）

1. 出现**需要硬资源上限**的特权动作（容器构建、批量装包、长任务）→ 直接加 cgroup v2 限额（`MemoryMax` / `CPUQuota` / `TasksMax`），**不是**回到 `systemd-run`。
2. 出现「直接执行无法回收进程树」的实测（`Setpgid` 失效、动作 daemon 化、跨会话残留）。
3. 平台 / 审计要求特权动作必须落在独立 unit 内（发行版合规）。
4. **插件降权未在 root 形态下验证通过** → 这是**阻断条件**：先降权，再切 root；顺序反了就是整机风险。
5. Tier B（macOS / Windows）需要特权动作：本 ADR 使通道可移植，但进程组/Job Object 的平台分支必须补齐后才允许声明支持。
