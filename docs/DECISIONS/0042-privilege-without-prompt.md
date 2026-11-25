> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5 · 关联: [0018-privilege-model](./0018-privilege-model.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[SECURITY](../SECURITY.md) §15、[RUNBOOK](../RUNBOOK.md) §5

# ADR-0042: root 提权零交互——kored 以系统级 root 服务运行（不做运行期授权判定）

## 背景：用户的硬性裁决

> 「root 管理本来也是这个软件的功能的一部分，不应该有任何一次输入账号密码确认。」
> 「除了我们的账号密码，任何时候都不应该有本机账号密码的输入，这是绝对的，没有任何商量的余地。」

在此之前，ADR-0018 只解决了「谁来执行」——root 动作经内核代理、`systemd-run --uid=0` 拉起 transient unit；**没解决「谁来授权」**。默认 polkit 策略下 `org.freedesktop.systemd1.manage-units` 为 `auth_admin`，于是：

| 观测（2026-11-23 本机，命令原文） | 结果 |
| --- | --- |
| `systemctl --user status kored-local` | transient unit，`Main PID 2798902 (kored)`，运行用户 **pt（非 root）** |
| `systemd-run --uid=0 --pipe true` | `Failed to start transient service unit: Access denied`，exit 1 |
| `journalctl -b \| grep polkit` | `polkitd: FAILED to authenticate to gain authorization for action org.freedesktop.systemd1.manage-units ... (owned by unix-user:pt)` |
| `pkaction --action-id org.freedesktop.systemd1.manage-units --verbose` | `implicit active: auth_admin_keep`（每次操作都要授权） |
| `ls /etc/systemd/system/kore.service` | 不存在（系统级 unit 从未在本机安装） |
| `scripts/install-service.sh` | 已经会写 `/etc/systemd/system/kore.service`，但**未声明 `User=`**（systemd 默认 root） |
| `docs/RUNBOOK.md` §5.1 | **早已**给出 `User=root` 的 unit 示例，并写明「以 root 启动 kored 后，transient unit 由已授权的 systemd 直接拉起，不需要交互」 |

**关键认知**：ADR-0018 §15.1 的设计前提就是「kored 以 root 启动、插件降到 `kore-<id>`」。本机当前以 pt 跑的是**降级形态**（内核 WARN「插件降权未生效」）。所以本 ADR 不是新架构，而是**把已经写进 ADR-0018 / RUNBOOK 的设计真正作为默认安装形态落地**，同时终结「普通用户 + 每次授权」这条路线。

## 两个候选（本次只在这两个之间选）

| 维度 | A. 普通用户 kored + polkit 免密规则 | **B. 系统级 root 服务（kore.service，User=root）** |
| --- | --- | --- |
| 运行期是否还有授权判定 | **有**：每次 root 动作仍过一次 `manage-units` authorization check，只是规则返回 YES 不弹框 | **没有**：uid=0 不进入 polkit 判定，动作由已授权的 systemd 直接执行 |
| 是否还会出现口令输入 | 规则生效时不弹；规则缺失/被覆盖时**立即退回弹框** | 任何情况下都不会出现本机口令输入 |
| 新增安装目录外写入 | `/etc/polkit-1/rules.d/49-kore.rules`（**需新增 ADR-0023 豁免项**） | `/etc/systemd/system/kore.service` + enable 软链（**ADR-0023 §3.5 豁免 #1，已有**） |
| 新增静默提权面 | 有：规则等价于「该用户可免密以任意 uid 起 `kore-root-*` 单元」；规则被改宽无人复核即长期风险 | 无新增规则；提权面 = 「kored 是 root 服务」这一条，天然可见（`ps -o user= -C kored`） |
| 与同类产品体验 | 不如 dockerd：等同「每次 docker 命令都弹一次授权」 | 与 dockerd 一致：`dockerd` 以 root 跑，所以 `docker run` 从不要口令 |
| 与 G-04 插件隔离 | 不受影响 | 不受影响：插件仍是独立低权进程 `kore-<id>` + 独立 socket，只是内核有权限 |
| 与 ADR-0018 原意 | 偏离（把授权外包给 polkit 规则） | **一致**（内核代理特权动作，插件低权） |
| 主要代价 | 规则写宽即静默全放行；语义上仍保留授权层 | root 进程面变大；state/日志属主随 root 变化，需要一次性迁移 |

**决策：选 B。** 理由按权重：

1. **用户约束是「绝对没有本机口令输入」，不是「不要弹框」。** A 只是把弹框改成静默判定，结构上仍保留「每次操作要过一道授权」；一旦规则文件丢失、被发行版更新覆盖、或被 `pkaction` 策略变更影响，用户会**再次**看到口令框——这违反「绝对的、没有商量余地」。B 在结构上消除了这个判定与这条失败路径。
2. **B 少一个安全面。** A 的规则是一个「写宽了没人发现」的长期风险；B 没有规则文件需要维护，提权事实只有一条且随时可查（kored 的运行身份）。
3. **B 不新增零侵入豁免。** A 必须改 ADR-0023 §3.5（新增第 5 项）；B 只写豁免 #1 已有的 `/etc/systemd/system/kore.service`，状态 / socket / 日志仍全部在安装根内。
4. **B 与既有设计一致，迁移成本低于"再造一套授权"。** RUNBOOK §5.1 与 ADR-0018 §15.1 本来就要求 root 内核；当前普通用户实例是降级形态。

被否决的 A 不是"不可行"，而是**不满足本次约束的语义**；它保留为**降级路径**（仅当用户坚持普通用户运行、或环境不允许 root 服务时，见 `scripts/install-polkit-rule.sh` 与 SECURITY §15.5「降级路径 A」）。

被否决的其他选项（沿用 ADR-0018 结论，不重复论证）：全 root 运行含插件（A'，破坏插件隔离）、sudoers 白名单（每加命令改配置、参数注入面大）、AmbientCapabilities（只覆盖 capability 类）、per-plugin setuid helper（多一个特权二进制）。

## 方案 B 的后果（写实，不粉饰）

### 正面

- **运行期零授权、零口令**：`systemd-run --uid=0` 由 root 内核发起，systemd 对 uid=0 不查 polkit，动作直接执行；`journalctl` 里不再出现 `polkitd ... FAILED to authenticate`。
- **插件降权真正生效**：root 内核按 ADR-0018 §15.1 为每个插件创建/使用 `kore-<id>`，`Credential` 降权 + 补充组收口；当前普通用户实例里"插件与内核同 uid"的降级消失。
- **审计链路不变**：`root.action`（begin/end、`unit`、`exit_code`、`dur_ms`）与 transient unit 名 `kore-root-<plugin>-<action>-<rand8>` 照旧，root 下反而多了真实的 uid 边界可核对。
- **与 dockerd 同构**：用户感知是「装了 kore，root 功能直接可用」，不需要理解 polkit。

### 代价与必须一起改的东西

1. **root 进程面**：kored 被攻破 = 宿主 root。缓解：薄壳（依赖白名单 3 个）、插件独立进程低权、管理面鉴权 + CSRF、审计 fail-closed 均不变；不引入新的特权二进制。
2. **目录属主迁移**：原用户实例的 state / run / log 是 `pt` 属主；root 服务写同一目录会产出 root 属主文件，用户后续无法直接读写。迁移要求（RUNBOOK 增补）：停用户实例 → `chown -R root:root <install>/data <install>/run <install>/logs`（或改用安装根内的新目录）→ 装系统服务。**state 目录若在安装根之外**（portable 配置指向仓库/家目录），按 ADR-0023 §3.5 #3「用户批准的宿主变更」写入 `data/changes.jsonl` 后才可迁移。
3. **两个实例不能并存**：用户级 `kored-local` 与系统级 `kore` 抢同一 state.db / socket。安装脚本检测到用户级实例在跑即 `[BLOCKED]`（exit 4），由运维显式 `systemctl --user disable --now kored-local` 后再装；`--force` 只跳过检查、不代停。
4. **配置路径**：系统服务以 root 运行，默认配置解析走 `KORE_CONFIG > --config > profile 默认`；二进制在 `/usr/local/bin` 时会落到 `fhs` profile 并打 WARN。安装脚本把 `KORE_HOME` 与 `--config`（若存在）显式写进 unit，避免依赖推导。
5. **日志位置**：不使用 `LogsDirectory=/var/log/kore`（ADR-0023 清单外写入），日志留在安装根内 + journald 收集 stdout/stderr。
6. **无 systemd / 不允许 root 服务的环境**：B 不可用，退回 A（polkit）或每次授权的默认策略；能力缺失必须显式，禁止静默降级。

## 实现（本 ADR 附带的一次性落地件）

| 产物 | 作用 |
| --- | --- |
| `scripts/install.sh` | 幂等安装/卸载系统级 root unit；`--dry-run` 零变更预览；检测用户级实例冲突；只写 `/etc/systemd/system/kore.service`（豁免 #1） |
| `scripts/install-polkit-rule.sh` | **降级路径 A** 的安装器（保留，不在默认安装链里调用） |
| `docs/SECURITY.md` §15.5 | 两方案的边界、审计、撤销、与 G-11 的关系 |
| `docs/RUNBOOK.md` §5.1 | 系统级 unit 示例（已有，落地后与脚本生成的 unit 对齐） |

**实测边界（诚实记录）**：本会话 `NoNewPrivs=1`，`sudo` 被内核阻断（`sudo: The "no new privileges" flag is set`），`/etc/systemd/system` 不可写 → **系统服务真装与"root 下特权动作零交互"未在本机实测**，仅完成 `--dry-run`、`bash -n`、unit 渲染核对与用户级实例检测。真机验证命令：

```bash
sudo bash scripts/install.sh --install-root /opt/kore
systemctl show -p User --value kore        # 期望 root
ps -o user= -C kored                       # 期望 root
curl -sS --unix-socket /opt/kore/run/kore.sock -b <cookie> \
  -X POST http://kore/api/v1/plugins/firewall/root-action \
  -d '{"action_id":"ufw-status"}' | jq '{executed,exit_code,unit}'
journalctl -u polkit --since -5min | grep -c manage-units   # 期望 0
```

## 复审条件（触发即重开本 ADR）

1. 发行版 / 上层策略禁止 `User=root` 的 system service（如某些托管环境）。
2. kored 需要在无 root 的用户会话里运行（portable / 无 systemd）——此时按降级路径 A，且必须显式提示"本机授权由 polkit 规则承担"。
3. 出现"root 进程被利用"的安全事件或审计要求内核必须非 root（如强制 capability 拆分）。
4. systemd / polkit 对 uid=0 的隐式放行语义发生变化（升级后 `journalctl -u polkit` 出现 `manage-units` 判定即视为失效信号）。
5. 若未来引入"按动作的能力拆分（capability 化内核）"，需重新评估是否仍需整进程 root。

## 实施记录（2026-11-23，accepted）

> 本节为**追加记录**：上方「背景 / 两个候选 / 方案 B 的后果 / 实现 / 复审条件 1–5」原文一字未改。状态由 `proposed` 转 `accepted` 的依据是 lead 2026-11-23 裁决——**方案 B（系统级 root 服务）为默认安装形态**，方案 A（polkit 规则）保留为「用户坚持用普通用户跑」时的降级路径。

### 1. 落地件清单（均已提交，实现 commit `e1980a3`）

| 产物 | 状态 | 核对事实 |
| --- | --- | --- |
| `scripts/install.sh` | 已落地（225 行） | 幂等（渲染结果与既有 unit `cmp` 一致即不写、打印「幂等」）；`--dry-run` 零变更预览并打印完整 unit；`--remove` 停服务 + 删 unit + `daemon-reload`（幂等）；**用户级实例冲突检测**（`systemctl --user is-active kored-local` 命中 → `[BLOCKED]` exit 4，`--force` 只跳过检查、不代停）；非 root 真装/卸载 `exit 3` 并打印需执行的 `sudo` 命令 |
| `scripts/install-polkit-rule.sh` | 已落地，**降级路径 A**，不在默认安装链里调用 | 规则功能自检 **13/13 PASS**（假 polkit 沙箱，PASS/FAIL 逐条打印；证据 `.agents/verify/root-nopass-polkit.md`）；`--dry-run` / `--check` 非 root 只读，`--remove` 幂等，polkitd 监听目录自动重载 |
| `docs/SECURITY.md` §15.5 | 已落地 | 写清「为什么不需要口令」的机制链、方案 A 的等价提权面与 5 条收紧条件、A 的豁免归属（ADR-0023 §3.5 需新增第 5 项）、撤销路径与「与 G-11 多用户 RBAC 无关」的边界 |
| `docs/RUNBOOK.md` §5.1 | 本次对齐 | unit 示例改为与本脚本生成结果一致（见第 2 节），并修正 §5.2 的 socket 路径为安装根内 `<install>/run/kore.sock` |
| `e1980a3` | 实现提交 | `[agent:root-nopass-polkit] feat(privilege): 系统级 root 服务实现提权零交互（ADR-0042，polkit 规则降为降级路径）`——4 文件 / +831 行：本 ADR、两个安装器、验收报告 |

### 2. unit 模板的关键字段（取自 `scripts/install.sh` 的 `render_unit()` 实际值，非文档推测）

| 字段 | 实际值 | 为什么是它 |
| --- | --- | --- |
| `User=` | `root` | 本 ADR 的核心一行：内核以 uid=0 运行，特权动作由内核代表调用方发起 |
| `NoNewPrivileges=` | `false` | 内核本身要执行特权动作，禁止提权会让 `systemd-run --uid=0` 失效；插件侧低权靠 supervisor 写 `SysProcAttr.Credential` 降 uid（ADR-0018 §15.1），不靠这一项 |
| `KillMode=` | `mixed` | `stop` 时先只对主进程发 TERM，让内核有机会回收插件子进程，超时才杀整个 cgroup；用 `control-group` 会与插件的收尾逻辑抢时序 |
| `Restart=` | `on-failure` | 崩溃 / 非零退出自动拉起；正常 `systemctl stop` 不重启，保留运维意图（`RestartSec=2`、`TimeoutStartSec=30`、`TimeoutStopSec=15` 随之固定） |
| `LimitNOFILE=` | `65536` | 管理面 UDS + 每插件 socket + 提权通道并发连接的 fd 余量（`Delegate=yes` + `UMask=0022` 同时输出） |

其余随脚本输出的字段：`Type=simple`、`Environment=KORE_HOME=$INSTALL_ROOT`、`ExecStart=$BIN serve [--config …]`、`[Unit] After/Wants=network-online.target`、`[Install] WantedBy=multi-user.target`。

**为什么不含 `RuntimeDirectory=` / `StateDirectory=` / `LogsDirectory=`（G-31 零侵入）**：这三项分别会写 `/run/kore`、`/var/lib/kore`、`/var/log/kore`，而 ADR-0023 §3.5 把这三个路径**逐字列为「清单外一切写入 = 违规」**；G-31 之下本安装形态允许的安装目录外写入只有豁免 #1 的 `/etc/systemd/system/kore.service` + enable 软链。因此状态 / socket / 日志全部留在 `KORE_HOME`（`<install>`）内，stdout/stderr 由 journald 收集（与上文「方案 B 的后果」第 5 条一致）。确有需要时按 ADR-0023 §3.5 #3 登记为「用户批准的宿主变更」（写 `<install>/data/changes.jsonl`、可回滚），不得直接加进 unit。

### 3. 为什么运行期不需要口令（一条链路）

`kored` 以 `User=root` 运行（uid=0）→ 特权动作由内核调 `systemd-run --uid=0` → **systemd 对 uid=0 直接放行、不进入 polkit 判定** → 该调用不产生 `org.freedesktop.systemd1.manage-units` 的 authorization check → **运行期没有「授权判定」这一步，所以不存在口令输入**。这是结构性消除，不是「把弹框关掉」：方案 A 下每次操作仍有一次 authorization check，规则返回 YES 才不弹。

### 4. accepted 的边界（显式，不得省略）

**accepted 的范围 = 默认安装形态已确定 + 落地脚本与单元模板已就绪 + 静态校验通过；不等于产线已验证。**

未实测项（诚实记录，不得当成已通过）：

- **真装系统服务未执行**、**root 特权动作零交互未观测**：本沙箱 `NoNewPrivs=1`（`sudo: The "no new privileges" flag is set`）、`/etc/systemd/system` 不可写，`sudo` 被内核阻断。
- 已完成的只是静态 / 只读校验：`--dry-run` 的 unit 逐字段核对、`bash -n` 语法检查、用户级实例检测分支、polkit 规则 13/13 假沙箱断言。

**闭环命令（在有 root 的真实环境按序执行一次即可闭环）**：

```bash
sudo bash scripts/install.sh --install-root /opt/kore   # 期望 exit 0，打印 [OK] 已写入 /etc/systemd/system/kore.service
systemctl show -p User --value kore                                    # 期望输出 root
journalctl -u polkit --since -5min | grep -c manage-units              # 期望 0
```

第三条判据的含义：装上 root 服务并跑过一次 root 动作后，polkit 日志里**不应**出现新的 `manage-units` 判定；出现即说明「uid=0 不进入 polkit」这一前提在本机不成立（同时触发下文复审条件 6 的第 4 项）。

### 5. 复审条件（在上文 1–5 之外追加第 6 条）

**追加注记（2026-11-24，ADR-0049）**：本 ADR 的 `User=root` 前提继续有效；其中「经 `systemd-run --uid=0` 执行」的机制描述**已失效**——root 动作改由内核直接 `exec`（新进程组 + 真实退出码），运行期不仅不判定 polkit，也不再依赖 systemd 运行时。§5 第 6 条（改回普通用户运行的复审条件）保留，但降级路径 A（polkit 规则）不再是唯一手段，需按 ADR-0049 复审条件 3 重新裁决。

6. **若将来要把服务改回普通用户运行**（portable / 无 systemd / 托管环境），必须**同时**满足三项：① 启用降级路径 A（`scripts/install-polkit-rule.sh`）；② 在 **ADR-0023 §3.5 新增第 5 项豁免**（`/etc/polkit-1/rules.d/49-kore.rules`）；③ 在文档与 UI 显式提示「本机授权由 polkit 规则承担」。只做其中一项即退回「运行期可能再次出现本机口令输入」的状态，违反用户绝对约束。
