> 状态: 交付 · 归属: implementer(privilege-critical-path) · 更新: 2026-11-24 · 里程碑: M5 · 关联: ADR-0018 / 0042 / 0049 / 0023、`docs/SECURITY.md` §6/§15

# 特权链路阻塞清单 + 一次 sudo 安装器

**目标（唯一 P0）**：`kored 以 root 运行 → 插件降到 kore-<id> → 特权动作真的执行 → 审计落账` 端到端可用。
**本卡不修代码**：只交阻塞清单、逐插件表、无 root 可修清单、安装脚本与自检判据。脚本：`scripts/install-root-once.sh`。

## 0. 先说结论（按阻断力度排序）

| # | 结论 | 证据 |
| --- | --- | --- |
| P0-1 | **现在跑的不是系统 root 实例**：`ps -o pid,user,uid -C kored` → `809422 pt 1000`（另有一个 `192705 pt 1000` 并发实例）。降权/通道/审计全部因此不启用 | 命令实测；`supervisor/manager.go:80` 只在 `current.UID==0` 时 `Enabled=true` |
| P0-2 | **24 个插件只有 3 个声明了 root_actions**（firewall 7 / ssh-guard 3 / waf 14，共 24 条）；其余 21 个没有任何特权通道。一旦降权生效，它们不会「更好」，会**更坏**：以前靠 uid=1000 的 `docker`/`sudo` 组偷偷可用的能力全部消失 | 逐仓 `info.json` 实测；`ps` 的 pt 组含 `27(sudo),973(docker)` |
| P0-3 | **主安装路径没有把「root 是可验证前提」写死**：`make install` 走的 `scripts/install-service.sh` 不写 `User=`（systemd 隐式 root，但无显式断言、无自检）；仓库文档默认的前台 `kored serve` 则是非 root —— 形态二选一，没有任何东西阻止非 root 实例顶上来 | `Makefile:488-495`、`scripts/install-service.sh:31`、`docs/RUNBOOK-INSTALL.md` §6.1 |
| P0-4 | **降权会清空补充组**（正确且必须），所以任何依赖 `docker`/`journal`/`adm` 组的插件动作在降权后必失败；而它们多数没有 root_action 兜底（见 §2） | `internal/platform/linux_identity.go:205-218`（只写主组 + 通道组） |
| P0-5 | 特权执行仍是 `systemd-run` 且 systemd 是硬前置；ADR-0049 已裁决砍掉，**代码未落地前，非 systemd 环境与 Tier B 依然不可用** | `privilege/service.go:96-99`、`privilege/systemd.go:181-195`；ADR-0049 §4.1 |

## 1. 六维阻塞清单（现状 / 需要什么 / 谁能做）

| 维度 | 现状（file:line） | 需要什么 | 谁能做 |
| --- | --- | --- | --- |
| **1 安装形态** | 现网 `kored` = uid 1000；两个并发非 root 实例。`make install` 的 unit 无显式 `User=`；仓库默认文档教用户前台 `kored serve` | 系统 unit 显式 `User=root` + 装前检测/停止非 root 实例 + 装后自检 `MainPID.uid==0`；安装根必须是 `/opt/kore`（二进制在 `/usr/*` 会自动退 fhs） | **本卡脚本已覆盖**（`scripts/install-root-once.sh`）；`install-service.sh` 加 `User=root` 属另一张卡（无需 root 即可改） |
| **2 插件降权** | 逻辑完整：`manager.go:80` 判 uid、`demote.go:56-160` Ensure/chown/o+rx/Credential。但 `kore-*` 用户数 = 0（内核非 root，路径根本没走到） | ① kored root；② `useradd`/`adduser` 可用；③ 系统组 `kore`；④ 通道 socket `root:kore 0660`；⑤ 插件状态目录 chown；⑥ **补充组必须清空**（防 docker 组等价 root） | ①②③ 安装脚本；④ 内核启动逻辑（已有，`serve_runtime.go:95-101`）；⑤⑥ 代码已有；真机验证需 root |
| **3 特权执行** | `service.go:91` 非 root → `E_NEED_ROOT`；`:96` 无 systemd → `E_NO_SYSTEMD`；执行器 = `systemd-run --uid=0`。ADR-0049 已裁决改直接 exec（P1 进程组 / P2 退出码 / P3 降权先行） | ADR-0049 代码落地（`privilege-direct-exec` 卡在途）；落地前 root 形态 + systemd 可跑，但**不得**在降权未验证时切 root | 代码卡（另一 agent 在途）；本卡只给前置条件与验证命令 |
| **4 插件声明** | 仅 firewall / ssh-guard / waf 有 `root_actions`；21 个插件 0 条。`requires_root=true` 也只有这 3 个 | 为真正需要特权的插件补声明（形状受 ADR-0022 约束，不是随便加命令行）：site(nginx)、dns(rndc/zone)、container/app-deploy(docker.sock)、backup(chown)、runtime-*(数据根)、logs(journal)、process(特权 renice/kill) | 各插件仓（逐仓卡）；内核侧只需 `ValidateAction`，无需改 |
| **5 审计** | root.action 的 begin 先落账、写不进就不执行（`privilege/audit.go:70-80`、`service.go:106-115`）——**代码级 fail-closed 成立**。但：`changes.jsonl` 与 root 动作未打通（ADR-0049 §5.1）；安装期变更原脚本一条不记 | ① 安装期变更进 `changes.jsonl`（本卡脚本已做）；② root 动作成功写宿主变更 + 回滚（下一张卡）；③ 真机验证 begin/end 两条记录 | ①② 代码/脚本；③ 需 root + 已启用插件 |
| **6 逐插件卡点** | 见 §2 | 见 §2 | 插件仓 + 内核声明 |

## 2. 逐插件阻塞表（24 仓，按 `info.json` + 代码实测）

判据：`声明` = `root_actions` 条数；`降权后` = 以 `kore-<id>`（仅主组 + kore 组）运行时的结果；`谁能做` = 代码/声明/需 root 验证。

| 插件 | 声明 | 特权依赖（证据） | 降权后现状 | 谁能做 |
| --- | --- | --- | --- | --- |
| waf | 14 | nftables（`nft add/delete`，info.json） | 唯一「声明齐全」的写规则插件；root 内核 + 通道即可用 | 需 root 真机验证（`nft-list` 只读动作可作 E2E 探针） |
| firewall | 7 | ufw / iptables（info.json；`ufw-allow/deny/delete/enable/disable`） | 同上；`ufw-status`/`iptables -S` 可只读验证 | 需 root 真机验证 |
| ssh-guard | 3 | fail2ban-client（info.json；`/usr/bin/fail2ban-client`） | 同上；`fail2ban-status` 可只读验证 | 需 root 真机验证 |
| site | 0 | 写 `/etc/nginx/conf.d` + `nginx -t` / `nginx -s reload`（`site/configapi.go:67`、`nginx.go:18-22`） | **硬卡**：目录不可写、reload 要 root 信号；无 root_action | 插件仓补声明（`nginx -t` / `-s reload` 两动作）+ 站点配置写入路径改到插件数据根 |
| dns | 0 | 读 `/etc/bind`/`/var/lib/bind`、写 zone、`rndc reload`（`dnsop/validate.go:69`、`call.go:124-133`） | **硬卡**：rndc.key / zone 文件 root-only；`dns.reload` 直接 `E_NEED_ROOT` | 插件仓补声明（`rndc reload`）+ zone 写入走内核受控写 |
| container | 0 | `docker.sock`（`containerop/docker.go:278-288`） | **硬卡**：socket `root:docker 0660`，降权后无 docker 组 → `E_NEED_ROOT` | 不能加 docker 组（等价 root）；需内核 root-action 包装或 docker API 代理（设计卡） |
| app-deploy | 0 | `docker.sock`（`apop/docker.go:314`） | 同上（容器模板全卡） | 同上 |
| backup | 0 | 跨用户读 + `Chown` 恢复属主（`backupop/owner_unix.go:20-40`） | **静默降级**：`fs.ErrPermission` 直接 `return nil` 跳过属主恢复——违反「绝不静默降级」 | 插件仓改为显式 warning/错误；root_action 仅用于跨用户读 |
| runtime-php | 0 | 数据根 `/var/lib/kore/php`；装包只给 hint（`phpop/types.go:29`） | 数据根不在插件可写范围 → 写失败；**装包本来就没实现**（只提示 apt） | 插件仓把 root 改到 `<state>/plugin-data/<id>`；装包要单独设计 |
| runtime-node | 0 | 数据根 `/var/lib/kore/node`（`config.go:62`） | 同上 | 同上 |
| runtime-python | 0 | 数据根 `/var/lib/kore/runtime-python`（`config.go:62`） | 同上 | 同上 |
| logs | 0 | `journalctl`（`logic/journal.go:16-24`） | 降权后读不到 system journal（需要 `systemd-journal`/`adm` 组） | 插件仓补 root_action（`journalctl` 只读）或显式降级提示 |
| process | 0 | 读他人 `/proc`、renice/kill（`procfs/ports.go:311`、boundary 用例期望 `E_NEED_ROOT`） | 非本用户进程不可见/不可操作 → 大量功能退化（已有 `E_NEED_ROOT` 分支，不是崩溃） | 插件仓补只读 root_action（`ss`/`/proc` 采样）或接受低权视图 |
| db-mysql | 0 | `/var/lib/kore/db-mysql` 数据根；unix socket peer 认证（`mysqlop/config.go:124`） | 数据根不可写；socket 认证按 uid 可能被拒 | 插件仓改数据根；socket 场景提示改 TCP |
| db-postgres | 0 | 同上（`pgop/config.go:125`） | 同上 | 同上 |
| redis | 0 | 配置/数据路径由用户配；`SHUTDOWN` 显式拒绝（`redisop/whitelist.go:50`） | 连 TCP 不受影响；读写 `redis.conf`/`dump.rdb` 会失败 | 插件仓（配置路径校验 + 提示） |
| ssl | 0 | 证书落盘目录（默认旧 `/etc/kore/ssl`，`certs/paths.go:53`） | 降权后不能写 `/etc/kore/ssl`；需 `KORE_SSL_CERT_DIR` 指向插件可写目录 | 插件仓默认改 `<state>/ssl` + 安装时迁移提示 |
| cron | 0 | 执行命令、`/var/lib/kore` 运行日志（`croncore/runlog.go:77`） | 任务以 `kore-cron` 执行（不是 root）——这是**语义变化**，要显式告知用户 | 产品/插件仓：UI 标明执行身份 |
| file | 0 | 任意路径读写 | 受文件系统权限限制（只能碰 kore-file 可访问的路径） | 插件仓：越权显式 `E_NEED_ROOT`，别报「文件不存在」 |
| terminal | 0 | 起 shell | shell 变成 `kore-terminal`（低权），管理类命令会失败 | 产品决策：终端是否该走 root_action（不建议）或明确标注低权终端 |
| monitor | 0 | 读 `/proc` 全局统计 | 基本可用（`/proc/stat` 等世界可读） | 无需动作 |
| integrity | 0 | 读 `/etc`、`/bin`、`/boot` 做基线（`integrity/changes.go:18`） | 多数世界可读；`/etc/shadow` 等会失败 | 插件仓：不可读项显式跳过并报告 |
| discover | 0 | 探测 `/etc/nginx`、`docker.sock`（`probe/catalog.go:55`） | 只读探测多数可用；`docker.sock` 不可用 → 容器能力探测为 false | 无需动作（显式 false 即可） |
| echo | 0 | 无 | 无影响 | 无需动作 |

**汇总**：声明齐全 3 / 硬卡需补声明或设计 8（site、dns、container、app-deploy、backup、runtime×3）/ 语义变化 5（logs、process、cron、file、terminal）/ 基本无影响 8。

## 3. 「不需要 root 就能修」的清单（本卡不修，列清给下一批卡）

| # | 问题 | 位置 | 修法 | uid 1000 可测 |
| --- | --- | --- | --- | --- |
| N1 | `make install` 的 unit 不显式 `User=root` | `scripts/install-service.sh:31` | 加 `User=root` + 装后断言 | 可（`systemctl show` 需 root 读 unit？unit 文件本身可读，`--dry-run` 可测） |
| N2 | 非 root 实例可顶替系统服务，无检测 | 安装链 | 安装前 `pgrep -x kored` + uid 检查（本卡脚本已实现，可回填 `make install`） | 可 |
| N3 | 插件数据根写死 `/var/lib/kore/*` | runtime-php/node/python、backup、cron、db-* | 默认改 `<state>/plugin-data/<id>`（安装根内） | 可（隔离实例 + 临时 state） |
| N4 | backup 属主恢复静默跳过 | `backupop/owner_unix.go:20-40` | `ErrPermission` → 记 warning 并计入结果 | 可（用非 root 文件做用例） |
| N5 | site/dns 无 root_action 声明 | 两插件仓 `info.json` | 按 ADR-0022 形状补 `nginx -t`、`nginx -s reload`、`rndc reload` | 可（schema 测试 + 非 root 下断言 `E_NEED_ROOT`） |
| N6 | process/logs 已有 `E_NEED_ROOT` 但 hint 指向「sudo 启动 kored」，与新形态不一致 | 两插件仓 | hint 改「以系统服务形态运行 kore」 | 可 |
| N7 | `changes.jsonl` 与 root 动作未打通 | `privilege/service.go`（下一卡：direct-exec 负责人） | 成功动作按 ADR-0049 §5.1 写结构化 purge_op | 可（单测） |
| N8 | `/system/info` 的 demotion 只在有会话时可读，运维脚本无法免密自查 | `httpapi/middleware.go:27` | 不改鉴权；用 `kored` CLI 补 `status --json` 输出 demotion（或本卡脚本的 S1-S8 替代） | 可 |

## 4. 一次 sudo 安装器：`scripts/install-root-once.sh`

```bash
# 只输一次口令；幂等；装完自动自检（PASS/FAIL/SKIP 逐项）
sudo scripts/install-root-once.sh --bin ./bin/kored --stop-user-instance
# 只读自检
scripts/install-root-once.sh --verify
# 端到端（真跑一次只读 root 动作 + 查审计）
sudo scripts/install-root-once.sh --verify --password-file /root/.kore-admin --e2e-plugin waf --e2e-action nft-list
# 回滚（按 changes.jsonl）
sudo scripts/install-root-once.sh --rollback
# 零变更预演
scripts/install-root-once.sh --dry-run --bin ./bin/kored --stop-user-instance
```

**契约**

- 宿主写入只有 ADR-0023 §3.5 豁免项：`/etc/systemd/system/kore.service` + enable 软链、`/opt/kore/bin/kored`、系统组 `kore`；**不开** fhs 路径（安装根在 `/usr/*` 会被直接拒绝）。
- 幂等：unit 内容相同不重写、二进制 sha 相同不复制、组存在不重建、服务已 active 且无变更不重启。
- 回滚：每条变更追加到 `/opt/kore/data/changes.jsonl`（与 `cmd/kored/changes.go` 同 schema）；`--rollback` 只回放 `file.remove` / `file.restore` 两类结构化 `purge_op`，组/用户/服务状态**明确打印人工步骤**，不假装可回滚；状态目录与 `kore-*` 用户默认保留。
- 不静默：非 root 实例在跑 → `[FAIL]` + 两条可执行命令；缺 `useradd`/`systemctl`/systemd → 前置 FAIL；自检 FAIL → 安装退出 1，并打印每项「修：」。
- 不打印凭据：口令只从 0600 文件读入内存，经 stdin 进 curl 请求体，不进 argv、不回显。

## 5. 端到端自检项与 PASS/FAIL 判据

| 项 | 判据（PASS） | FAIL 时怎么修 |
| --- | --- | --- |
| S1 unit | 文件存在且 `ExecStart=/opt/kore/bin/kored serve` | 重跑安装 |
| S2 显式 root | `systemctl show -p User` == `root` | 改 unit `User=root` → daemon-reload → restart |
| S3 active | `systemctl is-active` == active | `journalctl -u kore -n 50` |
| S4 主进程 uid | `MainPID` 的 `ps -o uid=` == 0 | 查 unit / 是否有第二个实例 |
| S5 通道组 | `getent group kore` 存在 | `groupadd --system kore` + restart |
| S6 通道 socket | `/opt/kore/run/kore-channel.sock` 存在且 `root:kore 0660` | 重启；仍无则查 `serve_runtime.go:95-101` |
| S7 降权用户 | 存在 `kore-*` 用户；有插件进程时其属主必须是 `kore-*` | 查 `journalctl | grep 降权`、`useradd` 是否可用 |
| S8 审计 | `KORE_STATE_DIR=... kored audit --action root.action` 能读出记录 | 查 `data/state.db` 属主/可写 |
| S9 零侵入 | `/var/lib/kore`、`/etc/kore`、`/run/kore`、`/var/log/kore` 都不存在 | 人工确认历史安装后清理 |
| S11a demotion | `/api/v1/system/info` 的 `demotion.enabled` == true | 先修 S2/S4 |
| S11b 特权动作 | POST `/{plugin}/root-action` 返回 200，或错误不是 `E_NEED_ROOT`/`E_NO_SYSTEMD`（业务失败算通道已通） | 修 S4/S6 |
| S11c 审计写入 | `kored audit` 能查到本次 `plugin=<id>` 的 root.action | 查 fail-closed 落账与 state.db |

**当前实测（本机，非 root，2026-11-24）**：`--verify` → `PASS 2 / FAIL 6 / SKIP 2`，exit 1；`--dry-run` → exit 0 全计划打印。这就是「先证明检测是真的会红」，不是空口自检。

## 6. 未验证项（诚实记录）

1. 本卡**没有 root**，S2/S4/S6/S7/S8/S11 的 PASS 分支全部未真机验证；只验证了 FAIL/SKIP 分支。
2. ADR-0049 的直接 exec 由 `privilege-direct-exec` 在途落地；落地后本文件 §1 维度 3 的 `service.go:96-99` 行号会失效，判据以「是否存在 `E_NO_SYSTEMD` 触发」为准。
3. 逐插件表的「降权后现状」是按代码路径 + 文件权限模型推断，除 waf/firewall/ssh-guard 的声明外，**没有在 root+kore-<id> 形态下逐插件跑过**。
4. `--e2e` 依赖已启用的插件与可用管理员口令；未提供时脚本输出 `[SKIP]`，不伪装 PASS。
