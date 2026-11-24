# 插件独立用户权限设计 · 四层状态核实（2026-11-24）

> 核实口径：**只核实，不改代码、不安装、不重启、不改 `.kore-local.yaml`**。
> 每条结论给 `file:line` 或命令输出；推演项显式标「未实测 / 未确认」。
> 核实时间：2026-11-24 11:52–11:56 (+08:00)。

## 0. 结论摘要

| 层 | 状态 | 一句话 |
| --- | --- | --- |
| ① 设计 | ✅ 一致 | ADR-0018/0042/0049 身份模型一致：内核 root、插件 `kore-<id>`；0049 只换执行机制，不动授权模型 |
| ② 代码 | ✅ 完整 | 前缀 / Lookup→Ensure / uid<=0 拒绝 / useradd 绝对路径 / Credential 清组 逐条落地，单测通过 |
| ③ 生效条件 | ⏳ 判据存在但不满足 | 仅 `kernel uid==0` 启用（`manager.go:80-86`）；当前 uid=1000 → 显式降级并 WARN |
| ④ 实际运行态 | ❌ 未生效 | `kore-*` = 0；插件进程 uid=1000、补充组含 `27(sudo)` / `973(docker)` |

**一句话判断：「插件低权」现在不成立。当前成立的是「插件与内核同权」——插件直接继承启动用户的全部补充组，其中 docker 组已等价 root 且不经审计。**

---

## 1. ① 设计层：ADR-0018 / 0042 / 0049

### 1.1 三份 ADR 的分工

| ADR | 决定什么 | 关键原文 | 与另两份的关系 |
| --- | --- | --- | --- |
| [ADR-0018](../../docs/DECISIONS/0018-privilege-model.md) | **身份模型 + 提权通道**：内核 root、插件降到 `kore-<id>`、root 动作只经内核代理 | `:94` 「Linux GA 下 `kored` 以 root 启动，**插件一律降到 `kore-<id>` 运行**」；`:95` 提权只能由内核拉起，插件不得自行 sudo/setuid | 基线。第 `:281` 尾注已声明机制被 0049 取代 |
| [ADR-0042](../../docs/DECISIONS/0042-privilege-without-prompt.md) | **安装形态**：系统级 root 服务，运行期零授权判定 | `:26` 方案 B「系统级 root 服务（`kore.service`，`User=root`）」；`:52-53` root 下不查 polkit、插件降权真正生效 | 把 0018 的前提落成默认安装形态，不改身份模型 |
| [ADR-0049](../../docs/DECISIONS/0049-privilege-direct-execution.md) | **执行机制**：砍掉 `systemd-run`，内核直接 `exec` | `:18` 「一条底线不变：**kore 有 root ≠ 插件有 root**。插件必须降到 `kore-<id>`」；`:84` 裁决 A 直接执行 | 只换机制；`:97` 明写 P3 插件降权是硬前置：「`demotion.enabled=true` 真机验证前，不得把内核切到 root 形态」 |

### 1.2 一致性判定

| 议题 | 0018 | 0042 | 0049 | 一致？ |
| --- | --- | --- | --- | --- |
| 内核身份 | root | root（`User=root`） | root（前提） | ✅ |
| 插件身份 | `kore-<id>` | 同 | 同（底线） | ✅ |
| 非 root 内核 | 显式降级、同 uid、`E_NEED_ROOT`（`:94`） | 降级路径 A（polkit）保留 | 降级形态仍存在 | ✅ |
| root 动作执行 | `systemd-run --uid=0` | 未涉及 | 直接 `exec`（取代） | ✅（0018 尾注已同步） |
| root 动作授权 | polkit 参与（历史表述） | root 下不判定 | 授权层不参与 | ✅（0042 澄清） |

**设计层结论：三者一致，无互相矛盾。** 唯一瑕疵是 ADR-0018 `:169-177` 降级矩阵把 `uid=993/994`、`docker ps exit 1` 标成「实测」，但本机现网 `kore-*` = 0（见 §4），说明那是 root 形态沙箱/容器的实测记录、文档未标注环境。**本卡不改文档，仅作为文档改进项提出。**

---

## 2. ② 代码层：逐条 `file:line`

| 断言 | 证据 | 结论 |
| --- | --- | --- |
| 用户前缀 `kore-` | [`demote.go:14`](../../internal/core/supervisor/demote.go) `const pluginUserPrefix = "kore-"` | ✅ |
| 用户名长度上限 32 | `demote.go:17` + `:85-90`（超长拒绝启动） | ✅ |
| `Lookup` 先查 | `demote.go:91` `m.identity.Lookup(name)` | ✅ |
| 查不到 → `Ensure` 创建 | `demote.go:97-106` `m.identity.Ensure(name, []string{m.opts.ChannelGroup})` | ✅ |
| 创建失败拒绝启动（不回退同 uid） | `demote.go:99-105` 返回 `E_INTERNAL` + 可操作提示 | ✅ |
| `uid<=0` 拒绝 | `demote.go:107-111` `if acct.UID <= 0 { ... 拒绝以 root 运行插件 }` | ✅ |
| 状态目录 `0700` + chown，不许放宽 0777 | `demote.go:145-152`；`linux_identity.go:261-271` `Own` | ✅ |
| 版本树补 `o+rx`（递归、不跟随符号链接） | `demote.go:155-160` + `:191-232` | ✅ |
| 父链目录补 `o+x`（可穿越不可列举） | `demote.go:164-177`（状态根 / 插件根 / run 根 / run 目录） | ✅ |
| `useradd` 走固定绝对路径（不查 PATH） | [`linux_identity.go:29-31`](../../internal/platform/linux_identity.go) `useraddCandidates = {"/usr/sbin/useradd","/usr/bin/useradd","/sbin/useradd"}`；`firstExisting` `:402` | ✅ |
| `useradd` argv | `linux_identity.go:154-156`：`--system --no-create-home --home-dir /nonexistent --shell <nologin>` + name | ✅ |
| nologin 候选 | `linux_identity.go:22-23` `/usr/sbin/nologin` → `/sbin/nologin` → `/bin/false` | ✅ |
| 同名组已存在时复用 gid | `linux_identity.go:138-148` | ✅ |
| `Credential` 清空继承组 | `linux_identity.go:205-228`：root 且目标 uid≠0 时 `Credential.Groups = [gid] + acct.Groups`（去重、跳过 `<=0`），覆盖 root 的 docker/sudo | ✅ |
| 非 root 场景 `NoSetGroups` | `linux_identity.go:223-228`（自身降权 setgroups 会 EPERM） | ✅ |
| 调用点：bind/exec 之前 | [`start.go:47`](../../internal/core/supervisor/start.go) `prepareDemotion`；`start.go:111` `identity.Apply(cmd, acct)` | ✅ |

**单测证据（只读运行，未改代码）：**

```text
$ GOWORK=off go test ./internal/core/supervisor/ -run 'Demot|Demotion' -count=1
ok  	github.com/pengtang1024/kore/internal/core/supervisor	0.184s
exit=0
```

**代码层结论：✅ 完整，无缺口。** 残余风险（P2，非缺陷）：`Lookup` 命中的**已存在**用户，其补充组按 `/etc/group` 原样继承、未做白名单校验——管理员手工把 `kore-site` 加进 `docker` 组时降权会被绕过。代码只保证「自己创建的账户」组是干净的。

---

## 3. ③ 生效条件：`manager.go:74-96` 精确逻辑

判定在 `New()`（进程启动时）**只做一次**，运行期无重新评估、无热切换：

| 分支 | 条件 | 结果 | 日志 | 行号 |
| --- | --- | --- | --- | --- |
| 1 | `Identity.Current()` 报错（非 Linux / 读不到身份） | `Enabled=false`，Reason 写明 Tier B 降级 | **WARN** `无法读取进程身份，插件降权不可用（显式降级为同用户运行）` | `manager.go:75-79` |
| 2 | `current.UID == 0` | `Enabled=true`，插件将以 `kore-<id>` 运行 | **INFO** `插件进程降权已启用：插件将以 kore-<id> 运行` | `manager.go:80-86` |
| 3 | 其他 uid（非 root） | `Enabled=false`，Reason 给出「以 root 启动才会降权」+ 可操作提示 | **WARN** `kored 非 root：插件降权未生效（插件与内核同 uid）；需要 root 的动作只能走 root-action 通道` | `manager.go:87-95` |

补充口径：

- **降级有没有警告日志？有。** 三类分支各自 WARN/INFO，现网实测命中分支 3（见 §4 日志）。
- **降权准备失败的形态**：`prepareDemotion` 任一步失败即返回错误、拒绝启动，**不允许静默回退同 uid**（`demote.go:49-58` 步骤 1–6 + `:75-177` 各错误分支）；`demote.go:66-74` 只为「未启用降权」给出显式 Reason，不伪造成功。
- **生效前提汇总**：`kored` 以 uid=0 启动 + `useradd/adduser` 可用 + 状态目录可 chown + run 目录可穿越 + 入口是普通文件。任一不满足 → 拒绝降权启动（而不是降级）。

**生效条件层结论：⏳ 判据清晰且已实现，但当前环境不满足（uid=1000）。要求生效必须重启为 root 形态 —— 属运行态变更，本卡禁做。**

---

## 4. ④ 实际运行态（2026-11-24 11:53 实测）

```text
$ ps -o pid,user,uid,comm -C kored
    PID USER       UID COMMAND
 636777 pt        1000 kored          # 主实例 .kore-local.yaml
 654472 pt        1000 kored          # /tmp/kore-chart-tooltip 隔离实例

$ awk -F: '/^kore-/' /etc/passwd | wc -l
0
$ awk -F: '/^kore-/' /etc/group | wc -l
0
```

插件进程（主实例子进程，均为 uid 1000）：

| pid | 插件 | uid | `/proc/<pid>/status` Groups |
| --- | --- | --- | --- |
| 637345 | site 0.4.3 | 1000 | `4 24 27 30 46 100 111 114 970 973 991 994 1000` |
| 637377 | terminal 0.2.1 | 1000 | 同上 |

```text
$ id
uid=1000(pt) gid=1000(pt) groups=...,27(sudo),...,973(docker),...

$ ls -l .kore-local-run/
srw------- 1 pt pt 0 Nov 24 10:28 kore.sock      # 只有主 socket；无 kore-channel.sock
```

```text
$ grep "降权" .kore-local-log/kored.log | tail -1
{"level":"WARN","msg":"kored 非 root：插件降权未生效（插件与内核同 uid）；
 需要 root 的动作只能走 root-action 通道","uid":1000,"time":"2026-11-23T18:16:55+08:00"}
```

`/var/lib/kore`、`/run/kore`、`/etc/kore` 均不存在 → 当前是 portable 形态，state 落在仓库内 `.kore-local-state/`。

**运行态结论：❌ 未生效。插件没有独立用户，与内核同 uid、同补充组；root-action 通道 socket 也因内核非 root 未创建。**

---

## 5. 「docker 组 = root 等价」实测判断

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 当前用户是否在 docker 组 | `getent group docker` / `id` | `docker:x:973:pt`；`id` 含 `973(docker)` |
| 插件进程是否继承该组 | `grep Groups /proc/637345/status` | 含 `973`（还有 `27(sudo)`） |
| socket 权限 | `ls -l /var/run/docker.sock` | `srw-rw---- root:docker 0660` |
| **能否真的操作 socket** | `docker ps --format ...`（与插件同 uid/组） | **exit=0**，列出 5 个容器（mysql/nginx/live-*） |
| 是否有审计埋点 | `grep -rn "docker.sock\|/var/run/docker" internal/ cmd/ pkg/` | **仅 1 条注释**：`internal/platform/linux_identity.go:195`；无任何审计/拦截代码 |

**结论：成立，且比设计文档写得更严重 ——**

1. 插件进程**现在就在** `docker` 组里，能直接读 `docker.sock`（0660 root:docker，组可读写）；
2. 这个能力**完全不经过 kore**：不经过 root-action 通道、不产生 `root.action` 审计、不写 `changes.jsonl`。`changes.jsonl` 只记安装期用户批准的宿主变更（ADR-0049 `:147`），与运行期动作没打通；
3. 等价性：docker 组可 `docker run -v /:/host --privileged`，即宿主 root。ADR-0018 `:28` 已承认「docker 组已是等价 root 的既成授权」，ADR-0049 `:134` 把它列为当前基线风险。

**因此「插件低权」这句话现在不成立。** 准确的表述是：**插件当前与内核同权（uid=1000 + docker/sudo 组），只是恰好内核本身也不是 root。** 真正的隔离要等 §6 的 root 形态落地。

---

## 6. 装上 root 之后会变成什么（推演，本卡未实测）

### 6.1 `scripts/install-root-once.sh` 实际做什么

文件 559 行，提交 `1c9c7b1`。主流程（`:498-517`）：

```text
preflight → stop_user_instances → install_binary → ensure_group(groupadd --system kore)
→ install_unit(User=root) → enable_start → 写 changes.jsonl 账本 → self_check
```

关键事实：

- **不创建 `kore-<id>`**：脚本只建共享组 `kore`（`:194-201`）；插件系统用户由 `kored` 在**该插件首次启动前**按需 `Ensure`（ADR-0018 `:140`）。
- preflight 硬前置：`useradd` 或 `adduser` 缺失直接报错退出（`:146-147`）。
- S10 对既有数据目录**只 WARN、不 chown**（`:426-431`）。
- 回滚保留 `kore-*` 用户与数据目录，只删 unit / 二进制 / 空组（`:529-552`）。

### 6.2 S1–S11c 自检项与 PASS 判据

| 编号 | 检查 | PASS 判据 | 行号 |
| --- | --- | --- | --- |
| S1 | unit 就位 | `/etc/systemd/system/kore.service` 存在 且 `ExecStart=<BIN_DST> serve` | `:324-330` |
| S2 | 显式 root | `systemctl show -p User --value kore` == `root` | `:332-338` |
| S3 | 服务运行 | `systemctl is-active --quiet kore` | `:340-346` |
| S4 | 主进程 uid=0 | `MainPID` 有效 且 `ps -o uid= -p <pid>` == `0` | `:348-359` |
| S5 | 通道组存在 | `getent group kore` 命中 | `:361-364` |
| S6 | 通道 socket | `-S <run>/kore-channel.sock` 且 `root:kore 0660` | `:366-379` |
| S7 | 插件降权生效 | `getent passwd` 有 `kore-*`；**S7b** 运行中插件进程属主为 `kore-*`；无插件进程则 SKIP（有插件进程但无 `kore-*` → FAIL） | `:381-396` |
| S8 | 审计链 | `state.db` 存在，`kored audit --action root.action` 可读；有记录 PASS，无记录 SKIP | `:398-418` |
| S9 | 零侵入 | `/var/lib/kore` `/etc/kore` `/run/kore` `/var/log/kore` 都不存在 | `:420-424` |
| S10 | 状态目录权限 | `<install>/data` 为 `root:700` | `:426-431` |
| S11 | 端到端（需 `--password-file`，否则整段 SKIP） | 见下 | `:433-437` |
| S11a | 降权上报 | `GET /system/info` 含 `"demotion":{"enabled":true}` | `:465-471` |
| S11b | 特权通道 | `POST /plugins/<p>/root-action` 返回 200，或至少不是 `E_NEED_ROOT`/`E_NO_SYSTEMD` | `:473-486` |
| S11c | 审计闭环 | `kored audit --action root.action` 输出含本次 `plugin` | `:488-494` |

汇总口径（`:439-444`）：`FAIL` 必须为 0；有 SKIP 时脚本明写「已闭环部分通过，另有未验证项（不是全绿，别当成全绿）」。

### 6.3 装完后逐项状态预测

| 维度 | 现在 | 装 root 后 | 依据 |
| --- | --- | --- | --- |
| `kored` uid | 1000 (pt) | 0 (root) | `install_unit` 写 `User=root`；S2/S4 |
| systemd unit | 无（用户级实例） | `/etc/systemd/system/kore.service` 启用 | `:498-517` |
| `kore-*` 用户 | 0 | **按需创建**：每插件一个 `kore-<id>`（`--system`、无 home、nologin、独立主组 + `kore` 组） | `demote.go:97-106`、`linux_identity.go:154-156` |
| 插件进程 uid | 1000 (pt) | `kore-<id>` 的系统 uid（具体值由 `/etc/login.defs` 的 `SYS_UID_MIN` 决定，**未确认**） | `demote.go:107-111`、`linux_identity.go:205-222` |
| 插件补充组 | 4/24/27/30/46/100/111/114/970/973/991/994/1000 | **仅** `kore-<id>` 主组 + `kore` 通道组 | `linux_identity.go:206-222` |
| 通道 socket | 无（`kore.sock` 0600 pt） | 新增 `kore-channel.sock` `root:kore 0660` | ADR-0018 `:190`、脚本 `:94` |
| `/system/info` demotion | `enabled=false` + 原因 | `enabled=true` | `manager.go:80-86`、S11a |
| 插件数据目录 | `pt:pt`（如 `site/config.json` = `pt:pt 0600`） | **只有顶层目录** chown 成 `kore-<id>:kore-<id> 0700` | `demote.go:145-152`（非递归） |
| 版本树/二进制 | `pt:pt 755` | 属主不变，补 `o+rx`（递归） | `demote.go:191-232` |

### 6.4 装完后立刻不可用的插件（按现有证据）

| 插件 | 依赖 | 装后行为 | 依据 |
| --- | --- | --- | --- |
| **container** | `docker.sock`（0660 root:docker） | **立刻不可用**：新身份不在 docker 组 → `connect: permission denied` → `E_NEED_ROOT` | §5 实测现状 + ADR-0018 `:177`（「禁止把插件加进 docker 组」） |
| **site** | 读 `/etc/nginx`、`nginx -t/-s reload`（root master） | 直读/直写不可用；只能走已声明的 `root_actions`：`nginx-test` / `nginx-reload` / `nginx-dump`（需通道 socket + 用户批准） | `kore-plugin-site/info.json` root_actions；ADR-0018 `:176` |
| **dns** | bind9 引擎需 `rndc`（读 root-only `rndc.key`）；resolved 引擎需 `resolvectl` | `rndc` 路径 → `E_NEED_ROOT`；`resolved-flush-caches` 走已声明 root_action | `kore-plugin-dns/info.json:43-50`；`tests/fault/methods_coverage_test.go:394-408` |
| **terminal** | PTY + 登录 shell | 仍可用，但 shell 身份 = `kore-terminal`，不能 `sudo`/`ufw`/`nft` | ADR-0018 `:172`（实测记录，本机未复验） |
| **firewall / process / file / logs / app-deploy** | 读写宿主路径 / kill 他进程 | 读基本可用；写/跨 uid 操作 → `E_NEED_ROOT` + hint；`0640 root:adm` 文件报权限错误 | ADR-0018 `:170-175`、`:180` |

### 6.5 文件权限：最容易被忽略的坑（有实测数据）

现状（`.kore-local-state/plugins/site`，实测）：

```text
pt:pt 755  .kore-local-state/plugins/site
pt:pt 600  .kore-local-state/plugins/site/config.json
pt:pt 755  .kore-local-state/plugins/site/0.4.3/bin/site
```

问题：`demote.go:145` 只对 `stateDir` **顶层**执行 `os.Chown`，`Own` 是单层调用（`linux_identity.go:261-271`），**不递归**。装 root 后 `kore-site` 能进目录（顶层已 chown），但读不到 `config.json`（`0600 pt`）→ 启动即失败或丢配置。版本树因为 `ensureTreeAccessible` 递归补 `o+rx` 反而没问题。

**必须手工递归 chown，或接受「首次启动后插件读不到旧配置」。**

---

## 7. 装 root 之前必须先做完的前置条件

| 优先级 | 前置条件 | 为什么 | 证据 |
| --- | --- | --- | --- |
| P0-1 | 备份 `.kore-local-state/`（含 `state.db`）与当前配置 | state.db 记审计/任务；属主会变 root | ADR-0042 `:60` |
| P0-2 | 停用户级实例，并确认无其他实例持有同一 data | 端口/socket/state 争用；脚本会 `stop_user_instances` 但先自查 | `:498-517`、`:289` |
| P0-3 | 规划 `<install>/data`、`run`、`logs` 属主迁移（`chown -R root:root`）或接受 root 属主后用户不可直读 | root 服务写同一目录会产生 root 文件 | ADR-0042 `:60` |
| P0-4 | 装后逐插件 `sudo chown -R kore-<id>:kore-<id> <state>/plugins/<id>` | 顶层 chown 不递归，旧配置是 `pt:pt 0600`，插件读不到 | `demote.go:145`、`linux_identity.go:261-271`、§6.5 实测 |
| P0-5 | 确认 `useradd`/`adduser` 可用 | preflight 硬前置，缺失直接失败 | `:146-147` |
| P0-6 | 确认无 `kore` 组冲突（脚本会 `groupadd --system kore`） | 组已存在时走复用/失败分支 | `:194-201` |
| P0-7 | 准备 `0600` 口令文件供 S11 | 不给 `--password-file` 则 S11a/b/c 全 SKIP，验收不闭环（脚本 exit 7） | `:433-437`、`:439-444` |
| P1-1 | 先确认 `site` / `dns` / `firewall` 的 `root_actions` 已声明且用户已批准 | 插件降权后唯一特权通道；未声明即功能不可用 | 各 `info.json`；ADR-0018 `:95` |
| P1-2 | 记录回滚路径：`<install>/data/changes.jsonl` 账本 + `userdel kore-<id>` + `groupdel kore` | 回滚只删 unit/二进制/空组，用户与数据保留 | `:529-552` |
| P1-3 | 装完**至少启用一个插件**再 `--verify` | 否则 S7/S7b 只能 SKIP，降权等于没验证 | `:381-396` |
| P1-4 | 装前明确「container 插件会立刻不可用」并接受 | docker 组被收口是设计目标，不是回归 | §5、ADR-0018 `:177` |

---

## 8. 与本卡「已知事实」的偏差（复验结论）

| 已知事实 | 复验结果 |
| --- | --- |
| `ps -C kored` → `809422 pt 1000 kored` | **已过期**：该 pid 不存在。现在主实例 `636777`，另有一个 `/tmp/kore-chart-tooltip` 隔离实例 `654472`，均 uid=1000 |
| `kore-*` 系统用户数 = 0 | ✅ 一致（passwd 0 条、group 0 条） |
| 插件补充组含 `docker` / `sudo` | ✅ 一致（插件进程 `/proc/*/status` 含 27、973） |
| 降权只在 `current.UID == 0` 时启用 | ✅ 一致（`manager.go:80-86`） |
| `demote.go` 完整实现 | ✅ 一致（§2 逐条 + 单测 ok） |
| `scripts/install-root-once.sh` 存在（`1c9c7b1`） | ✅ 一致，559 行 |
| 「`dns` 需要 `rndc`」 | ⚠️ **部分不准**：当前 dns 0.5.1 的 `root_actions` 只有 `resolved-flush-caches`（`/usr/bin/resolvectl`）；`rndc` 只出现在 bind9 引擎的测试路径，属引擎分支而非默认声明 |
| ADR-0018 `:169-177` 标「实测 `uid=993/994`」 | ⚠️ **与现网矛盾**：本机 `kore-*`=0。该记录应是 root 形态沙箱实测，文档未标环境 |

---

## 9. 未确认项（本卡禁装，不猜）

1. **root 形态真机效果全部未实测**：`kore-<id>` 的实际 uid 数值、S2/S4/S6/S7/S11 是否全绿、`/system/info` 是否真返回 `demotion.enabled=true`。
2. **`site` 在 `kore-site` 身份下经通道写 nginx 是否能成功**（`nginx-test`/`reload` 已声明，但通道 + 用户批准链路未在真机跑通）。
3. **`terminal` 在 nologin shell 下的实际交互**：ADR-0018 `:172` 称实测可用，本机未复验。
4. **降权后插件对 `/proc`、其他插件 socket 的可见性**：不属本卡范围，未核实。

---

## 10. 证据命令附录（可复跑）

```bash
# 运行态
ps -o pid,user,uid,comm -C kored
awk -F: '/^kore-/{print}' /etc/passwd; awk -F: '/^kore-/{print}' /etc/group
grep -E '^Uid|^Gid|^Groups' /proc/637345/status
ls -l .kore-local-run/

# docker 组等价性
getent group docker; ls -l /var/run/docker.sock; docker ps --format '{{.ID}} {{.Image}}'
grep -rn "docker.sock\|/var/run/docker" internal/ cmd/ pkg/

# 降权代码与条件
sed -n '74,96p' internal/core/supervisor/manager.go
sed -n '84,111p;145,177p' internal/core/supervisor/demote.go
sed -n '197,232p' internal/platform/linux_identity.go

# 单测
GOWORK=off go test ./internal/core/supervisor/ -run 'Demot|Demotion' -count=1
```

> 本报告只读核实，未改 `bin/kored`、未重启、未改 `.kore-local.yaml`、未安装；写域仅本文件。
