> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: accepted（2026-11-23 lead 裁决）· 实现进度: 阶段 A（portable 默认）+ B（卸载链 `kore uninstall`）+ E（`make zero-intrusion-check`）已落地 · 关联: ../ARCHITECTURE.md、0018-privilege-model.md、0022-root-command-shapes.md、../RUNBOOK.md、../SECURITY.md

# ADR-0023: 零侵入设计规范——删掉安装目录即等于卸载

## 0. 判据（用户原话）

> **0 浸入**，咱们的所有内容都应该是 0 侵入的，除了必须的比如自启动，理论上只有壳子会有一些必须侵入的。**保证删除目录可以删除所有 Kore 相关功能。**

**可执行判据**：`rm -rf <install>` 后，宿主回到安装前的状态。任何需要"额外一步清理"的东西，都必须列进 §3.5 豁免清单并给出清理命令；清单之外出现写入 = 违规。

## 1. 背景：现状侵入点（2026-11-23 实测）

| 层 | 侵入 | 证据（file:line） | 性质 |
| --- | --- | --- | --- |
| 内核默认路径 | `/etc/kore/config.yaml`、`/run/kore/kore.sock`、`/var/lib/kore`（state/plugins/index）、`/var/log/kore` | `internal/core/config/types.go:158-167`、`config/config.go:18`、`types.go:179-183` | **默认值侵入**；四条路径各自可用 `paths.*` / `--config` / `--state-dir` 覆盖 |
| 内核建目录 | 启动 `MkdirAll` state / run / log 目录 | `cmd/kored/serve_runtime.go:68,73`、`supervisor/start.go:132` | 跟随上面的默认值 |
| 系统用户 | root 内核降权时 `useradd --system kore-<id>`，永久写 `/etc/passwd` + `/etc/group`（无删除路径） | `internal/platform/linux_identity.go:75-107`、`supervisor/demote.go:29-54`（`pluginUserPrefix="kore-"` :13-14） | **永久侵入**，ADR-0018 安全成果 |
| 自启动 | `/etc/systemd/system/kore.service` + `enable` 软链（文档指引手工安装） | `docs/RUNBOOK.md:130-158` | **唯一被用户豁免的侵入** |
| root 动作 | `systemd-run --uid=0 --collect` transient unit（瞬时，无持久文件） | `internal/core/privilege/systemd.go:95-140` | 非持久，**不算侵入** |
| 插件 root 动作 | `firewall` 5 条 / `waf` 12 条 / `ssh-guard` 3 条，命令 = `ufw` / `iptables` / `nft` / `fail2ban-client` | `pkg/pluginapi/rootpolicy.go:135-248`；各仓 `info.json` | **用户批准后改宿主**，见 §3.4 |
| 插件默认目录 | `site` 宿主 conf.d `/etc/nginx/conf.d`；`ssl` 证书 `/etc/kore/ssl`；`app-deploy` `/var/lib/kore/app-deploy` | `kore-plugin-site/settings.go:30`、`kore-plugin-ssl/internal/certs/types.go:27`、`kore-plugin-app-deploy/internal/apop/types.go:22` | 默认值侵入 |
| 插件自管状态 | 插件配置/数据走 `KORE_STATE_DIR`（内核注入） | `kore-plugin-site/settings.go:72-74` 等 | 随 state 目录，**天然零侵入** |

**关键实测**：本机正在运行的开发实例已经把全部状态放进仓库目录（`.kore-local-state/`、`.kore-local-run/`），`ls /etc/kore /var/lib/kore /var/log/kore /run/kore` 全为空、`getent passwd | grep '^kore-'` 为空 —— 说明**"安装目录内自包含"今天就能跑**，只是默认值没这么选。

## 2. 决策：三圈模型

| 圈 | 范围 | 判据 | 现状 |
| --- | --- | --- | --- |
| **A 核心状态（必须零侵入）** | 配置 / state / socket / 日志 / 插件 / 索引 / 备份 / 证书 | 全部在 `<install>` 内；`rm -rf` 即消失 | 默认值需改（§3.1），代码已支持 |
| **B 豁免集成（必须侵入，但可清理）** | systemd unit + `kore-<id>` 系统用户 | 列进 §3.5，`kore uninstall` 一键清；不装自启动 = 零 | unit 已有文档、清理缺失；用户已有、清理缺失 |
| **C 用户授权变更（不是"Kore 残留"）** | 插件按用户指令改宿主：nginx vhost、ufw/nft 规则、crontab、DB/Redis 数据、docker 资源 | 有 append-only 变更清单 + `uninstall` 提示回滚；不算安装残留 | 清单能力**尚未实现**（本次先立规范） |

一句话：**Kore 自身零侵入；系统集成最小化且可清理；用户主动施加的宿主变更留账、可回滚、不算侵入。**

## 3. 六问

### 3.1 路径：默认值放哪

**决策**：
1. 新增 `profile` 概念：**默认 `portable`** —— `<install>/config/config.yaml`、`<install>/data`（state，含 plugins/index）、`<install>/run/kore.sock`、`<install>/logs`。
2. 保留 **`fhs`** profile（现默认值 `/etc/kore` + `/var/lib/kore` + `/run/kore` + `/var/log/kore`）给发行版打包（deb/rpm）与"系统级服务"用户；此时卸载由包管理器负责（`apt purge` ≈ `rm -rf` + 清理），属"用户显式选择的非零侵入模式"。
3. 四条路径继续可配（`paths.config_dir/state_dir/run_dir/log_dir`，已有 `--config` / `--state-dir`），**可配置不是免责**：默认必须零侵入。

**理由**：判据是"删除目录 = 卸载"，默认值不满足时每个用户都要先读文档改配置，等于规范没落地。FHS 的价值（多用户共享、备份策略、包管理器）只在"系统级安装"场景成立，用 profile 表达即可。

**被否决**：
- （否决）保持 FHS 默认 + 文档教用户改 → 默认违反判据，且与"删除目录即卸载"体验相反。
- （否决）只支持安装目录内、不留 FHS → 发行版打包无法接受（策略强制路径），且 root 内核 + systemd 场景下 `/var/lib` 才是运维预期。

**/run 与 tmpfs 的取舍**：socket 默认放 `<install>/run`（自包含、`rm -rf` 即清）；不放 `/run/kore` 的理由正是判据——`/run` 虽是 tmpfs，`rm -rf <install>` 之后 `/run/kore` 仍在，直到重启。需要在 tmpfs 的场景（只读/网络盘安装、长路径超 UDS 108 字节上限）用 `paths.run_dir=/run/kore` 显式选择，并在文档写明"该配置会留下一个重启即清的目录"。

**配置文件的写入**：内核**不生成**默认 config.yaml（只读，缺失走内置默认 + WARN，`cmd/kored/config.go:38-55`），所以 config 目录本身不是侵入——只有用户显式创建文件时才存在。

### 3.2 系统用户（关键取舍）

**决策：保留 per-plugin uid `kore-<id>`（方案 A），但必须"可清理 + 少创建"，并登记为豁免 #2。**

| 方案 | 零侵入 | 安全性 | 可行性 | 结论 |
| --- | --- | --- | --- | --- |
| **A 保留 useradd + `kore uninstall` 清理** | 否（`/etc/passwd` 留名，卸载时 `userdel` 清） | 强：插件间 uid 隔离、socket `SO_PEERCRED` 校验、文件属主隔离 | 已验证（ADR-0018 实现记录） | **采用** |
| B user namespace（`CLONE_NEWUSER`） | 是（不写 `/etc/passwd`） | 中：root 内核下 userns 映射语义复杂，隔离靠命名空间而非 uid | 需 `/etc/subuid`+`/etc/subgid`（**新的 /etc 侵入**）；socket `SO_PEERCRED` 在 userns 下报的是宿主 cred，hello 校验要重写；`systemd-run` 与 userns 组合未验证；Tier A 含 RHEL8（4.18，无特权 userns 默认关闭） | **否决为默认**，列为 v1.x 评估项 |
| C 放弃 per-plugin uid（单用户 + cgroup/fs 隔离） | 是 | 弱：插件与内核同 uid、可读彼此 state、可 ptrace | 与 ADR-0018 已落地成果冲突 | **否决** |

**为什么 B 现在不做**：它把"一个永久用户名"换成"两个永久 subuid/subgid 条目 + 一套未验证的凭据语义"，零侵入账面上更差；而 userns 在 root 内核下并不能替代"插件彼此不可读"的文件系统隔离（要配 idmapped mount，Tier A 内核覆盖不全）。取舍写在明处：**A 是"可清理的侵入"，B 是"未验证的零侵入"，v1.0 选可验证的那个。**

**配套强制项（缺一不可，否则 A 不成立）**：
1. `kore uninstall` / `make uninstall` 必须：停服务 → 删 unit + `daemon-reload` → 对每个 `kore-<id>` 执行 `userdel`（组同删）→ 按 `changes.jsonl` 提示回滚 → 最后提示 `rm -rf <install>`。
2. **按需创建**：只在插件首次以 root 内核启动时 `useradd`；lazy 插件未启用不建；已存在则复用（现状）。
3. **名字可枚举**：统一前缀 `kore-`，卸载时按前缀扫描，不依赖 state 里的插件清单（state 可能已被删）。

### 3.3 systemd 自启动（唯一被豁免的常规侵入）

**决策**：
1. 只允许 **一个 unit 文件** `/etc/systemd/system/kore.service` 与其 `enable` 软链（`multi-user.target.wants/`）；由 `kore install-service` 生成、`kore uninstall` 删除（含 `daemon-reload`）。
2. **不用 `systemd-run --user` 替代**：user unit 需要用户会话/lingering，无法在未登录时开机起；且 root 动作通道要求 kored 以 root 运行（ADR-0018）。
3. 豁免边界：**只此一个 unit**。禁止写 `/etc/systemd/system/*.d/` drop-in、禁止持久化 transient unit（`--collect` 已保证自清）、禁止写 `/usr/lib/systemd/`。
4. 不装自启动 = 零侵入（前台 `kored serve` 模式），文档要给出这条"最干净"的用法。

**被否决**：把 unit 放进 `<install>` 再 symlink 到 `/etc/systemd/system` —— symlink 本身也是 `/etc` 写入，收益为零；`systemd-run --user` —— 见上。

### 3.4 插件对系统的修改（最难的一条）

**决策：B + C 组合，且 C 优先。**

- **C（优先，自管目录）**：站点根默认 `<install>/sites/<domain>`、备份 `<install>/data/backups`、证书 `<install>/data/ssl`、应用数据 `<install>/data/apps`；只有"必须改宿主"时才碰系统路径。判据：能用自管目录表达的能力，一律不提供写宿主路径的默认值。
- **B（必须改宿主时，留账）**：所有改宿主的动作（nginx vhost、ufw/nft 规则、crontab 行、fail2ban 封禁、docker 资源、DB/Redis 数据）都经 root action / 插件执行，并写 **append-only 变更清单** `<install>/data/changes.jsonl`：

```json
{"ts":"2026-11-23T13:40:00+08:00","plugin":"site","action":"vhost.write","target":"/etc/nginx/conf.d/kore-example.conf","before":"absent","after":"sha256:…","reversible":true,"purge":"rm -f /etc/nginx/conf.d/kore-example.conf && nginx -t && nginx -s reload"}
```

  - 内核在 root action 执行前后各记一条（`begin` / `end`，复用 `root.action` 审计的字段），插件侧动作由插件调用新增的 `changes.record` 接口（**协议增量，需 ADR 补充；本期先定规范**）。
  - `kore uninstall` 打印"以下 N 项系统变更由你批准过"，逐条给 `purge` 命令，`--purge` 才执行；**默认不自动回滚**（用户可能仍想保留站点）。
- **兜底**：插件可选实现 `purge` 方法（卸载时调用），不是强制——清单 + 命令已足以人工回滚。

**为什么不是"插件卸载必须回滚"**：站点被用户用了三个月，卸载面板时自动删 vhost 是灾难；零侵入约束的是"Kore 自身残留"，不是"用户用 Kore 做过的事"。所以**清单**是正确抽象：可审计、可回滚、默认不动。

**被否决**：
- （否决）每个插件强制实现 `purge` 并自动执行 → 误删风险高于收益，且第三方插件无法强制。
- （否决）插件只允许写自管目录、永不改系统 → nginx vhost / 防火墙 / crontab 是这些能力域的本体，做不到。

### 3.5 豁免清单（极短，新增需改本 ADR）

| # | 侵入 | 位置 | 清理 | 边界 |
| --- | --- | --- | --- | --- |
| 1 | systemd unit + enable 软链 | `/etc/systemd/system/kore.service`、`multi-user.target.wants/kore.service` | `kore uninstall`（停服务 + 删文件 + `daemon-reload`） | 只此一个 unit；不装自启动则为零 |
| 2 | 插件系统用户 | `/etc/passwd`、`/etc/group` 的 `kore-<id>` | `kore uninstall` 按前缀 `userdel` | 仅 root 内核 + 首次启用时创建 |
| 3 | 用户批准的宿主变更 | nginx conf.d、ufw/nft 规则、crontab、fail2ban、docker 资源、DB/Redis 数据 | `uninstall` 按 `changes.jsonl` 提示回滚 | 必须有清单条目；默认不自动回滚 |
| 4 | 显式安装的二进制（可选） | `/usr/local/bin/kored` | `make uninstall` / 用户自行删除 | 默认"解压即用"，不写系统目录 |

**清单外一切写入 = 违规**：包括但不限于 `/etc/kore`、`/var/lib/kore`、`/var/log/kore`、`/run/kore`（portable 默认下）、`/etc/nginx/nginx.conf`、`/etc/resolv.conf`、`/etc/hosts`、`/etc/cron.d`、`/etc/sudoers*`、`/usr/lib/systemd/*`。

### 3.6 验收判据（可执行）

```bash
# 0) 记录基线（安装前 / 使用后各跑一次）
snap() { getent passwd | grep '^kore-' ; systemctl list-unit-files | grep -i '^kore' ;
         ls -d /etc/kore /var/lib/kore /var/log/kore /run/kore 2>/dev/null ;
         pgrep -x kored ; ss -lx | grep kore ; }
# 1) 卸载（portable profile）
kore uninstall --purge      # 停服务、删 unit、userdel kore-*、按 changes.jsonl 回滚
rm -rf /opt/kore            # <install>
# 2) 断言（全部必须"无输出 / 退出 1"）
! test -e /etc/kore && ! test -e /var/lib/kore && ! test -e /var/log/kore && ! test -e /run/kore
! getent passwd | grep -q '^kore-'
! getent group  | grep -q '^kore-'
! systemctl list-unit-files | grep -qi '^kore'
! pgrep -x kored
! ss -lx | grep -q kore
# 3) 用户变更已回滚（有则应为 0）
ls /etc/nginx/conf.d 2>/dev/null | grep -c '^kore-'
ufw status numbered 2>/dev/null | grep -c 'kore'
crontab -l 2>/dev/null | grep -c 'KORE-'
nft list tables 2>/dev/null | grep -c 'kore_waf'
# 4) 一次性全量判据（脚本化后进 make zero-intrusion-check）
[ -z "$(snap)" ] && echo "ZERO-INTRUSION PASS"
```

**判据边界**：第 3 组是"用户变更"，只有用户选了 `--purge` 才要求为 0；否则允许非 0，但必须能在 `changes.jsonl` 里逐条对上。

## 4. 全量侵入点审计（kore + 24 插件仓，grep 实测）

扫描口径：`grep -rnoE '"/etc/…|"/var/…|"/run/…|"/usr/…|"/opt/…"'` + 系统命令表（`nginx|ufw|iptables|nft|crontab|systemctl|docker|dig|resolvectl|fail2ban-client|certbot|acme.sh|journalctl|mysql|psql|useradd`），排除 `_test.go`。

| 仓 / 模块 | 侵入位置（file:line） | 类型 | 豁免 | 处置建议 |
| --- | --- | --- | --- | --- |
| `kore` 内核 | `config/types.go:158-167`、`config/config.go:18` | 默认路径（/etc、/var/lib、/var/log、/run） | 否 | **改 portable 默认** + 保留 fhs profile |
| `kore` 内核 | `serve_runtime.go:68,73`、`supervisor/start.go:132` | 建 state/run/log 目录 | 否 | 目录跟随 profile |
| `kore` 内核 | `platform/linux_identity.go:75-107`、`supervisor/demote.go:29-54` | 建 `kore-<id>` 用户/组 | **#2** | 保留；补 `uninstall` 的 `userdel`；按需创建 |
| `kore` 内核 | `privilege/systemd.go:95-140` | `systemd-run --collect` 瞬时 unit | 否（自清） | 无需改；文档写明"瞬时" |
| `kore` 内核 | `RUNBOOK.md:130-158` | `/etc/systemd/system/kore.service` | **#1** | `kore install-service/uninstall` 成对提供 |
| `kore` 内核 | 仓库无 `install` 目标（Makefile） | 二进制安装到 `/usr/local/bin` 由用户手工 | **#4** | 默认"解压即用"；提供 `make install/uninstall` |
| `site` | `settings.go:30`、`configapi.go:66-72`；写 `/etc/nginx/conf.d/*.conf` | 写宿主配置 + `nginx -t/-s reload` | **#3** | 清单登记 + `purge`；默认 vhost 目录保持可配，站点根改 `<install>/sites` |
| `firewall` | `fwop/runner.go:124-125`；`info.json` 5 条 root_actions | ufw/iptables 规则 | **#3** | 清单 + `ufw delete` 回滚命令 |
| `waf` | `wafop/nft.go:170-195`；`info.json` 12 条 root_actions | `table inet kore_waf` + 集合/规则 | **#3** | 清单 + `nft delete table inet kore_waf` |
| `cron` | `croncore/crontab.go:17` | 用户 crontab（`/var/spool/cron/…`） | **#3** | 清单；写前备份已在 state（保留） |
| `ssh-guard` | `protection.go:19`；`info.json` 3 条 root_actions | fail2ban 封禁（当前只声明未执行） | **#3** | 执行前必须 confirm + 清单 |
| `app-deploy` | `apop/types.go:22`；模板 bind 挂载 `/var/www/html` 等 | docker 容器/网络/卷 + 宿主目录挂载 | **#3** | 卷落 `<install>/data/apps`；清单 + `remove` 回滚 |
| `container` | `containerop/*`（docker CLI） | 镜像 pull/rmi、容器启停 | **#3** | 清单；`rmi` 回滚 |
| `db-mysql` | `mysqlop/client_admin.go` 等（`mysql`/`mysqldump`） | 建库/用户/授权/导入导出 | **#3** | 清单（DB 数据不可由 `rm -rf` 回滚，卸载时必须显式确认） |
| `db-postgres` | `pgop/*`（`psql`） | 建库/用户/授权/改密 | **#3** | 同上 |
| `redis` | `redisop/*`（RESP） | set/delete/expire/bgsave（实例数据） | **#3** | 清单 |
| `ssl` | `certs/types.go:27`（默认 `/etc/kore/ssl`）；`certs/acme.go:37-38`（certbot/acme.sh） | 证书落盘 + 外部 ACME 客户端写 `/etc/letsencrypt` | 默认值：否；外部客户端：**#3** | 默认目录改 `<install>/data/ssl`；ACME 写外部路径须清单 |
| `backup` | `config.go:312-326`（默认 `<state>/backups`）；读 `/var/www` | 自管目录写入 + 宿主只读 | 否 | 无外溢；`<install>/data/backups` 随 profile |
| `file` | `fileop/*`（配置根内写、`chmod`） | 用户指定根内的文件操作 | 否（用户选根） | 文档写明"根由用户选，默认 state 内" |
| `integrity` | `paths.go:22`（`/usr/bin`、`/var/www` 只读扫描） | 只读 | 否 | 无 |
| `discover` | `probe/catalog.go:101-149`（读 `/etc/mysql`、`/usr/bin`） | 只读探测 | 否 | 无 |
| `logs` | `logic/journal.go:16`（journalctl）、读 `/var/log/*` | 只读 | 否 | 无 |
| `monitor` | `collector*.go`（`/proc`、`/sys`） | 只读 | 否 | 无 |
| `dns` | `dnsop/engine.go:177-267`、`types.go:254-257`（读 `/etc/bind`、`/etc/dnsmasq*`）；v0.2.0 无写入 | 只读（写路径未实现） | 否 | 未来写入必须走 **#3** + reload 回滚 |
| `runtime-node` / `runtime-php` / `runtime-python` | `runtime.go:20-30` 等（读 `/usr/bin`、`/opt`、`/etc/alternatives`） | 只读探测 | 否 | 无 |
| `terminal` | `internal/terminal/pty_linux.go:41`（宿主 shell） | 用户操作的命令执行 | 否（用户操作） | 与零侵入无关；边界靠插件 uid/cgroup |
| `echo` | — | 无 | — | 无 |

## 5. 被否决方案汇总

| 方案 | 否决理由 |
| --- | --- |
| 保持 FHS 默认、靠文档教用户改配置 | 默认违反判据；"删除目录即卸载"变成"读完文档才行" |
| 只支持安装目录内、无 FHS profile | 发行版打包不接受；root + systemd 生产场景 `/var/lib` 才是运维预期 |
| socket 默认 `/run/kore` | `rm -rf` 后仍残留到重启；tmpfs 优势用显式配置表达 |
| user namespace 替代 per-plugin uid | 引入 `/etc/subuid`+`/etc/subgid`（新的 /etc 写入）；`SO_PEERCRED` 语义要重写；`systemd-run` 组合未验证；Tier A（RHEL8）无特权 userns |
| 放弃 per-plugin uid（单用户） | 与 ADR-0018 安全成果冲突，插件间可互读 state |
| 插件卸载强制自动回滚 | 误删用户资产风险 > 收益；第三方插件无法强制 |
| 插件只允许写自管目录、永不改系统 | nginx/防火墙/crontab 是能力本体 |

## 6. 后果

**正面**：`rm -rf` 语义可验证；升级/迁移 = 搬目录；测试环境不再污染宿主（本机 dev 实例已验证）；发行版与便携两种形态有明确边界。

**负面**：默认路径变化是**破坏性变更**（需迁移脚本/首启检测旧路径并 WARN）；fhs 用户与 portable 用户行为分叉，文档与排障要按 profile 写；插件默认目录（site conf.d / ssl 证书 / app-deploy 根）改动面较广。

**风险**：`kore uninstall` 误删（`userdel` 前须核对前缀 + 交互确认；`--yes` 才非交互）；`changes.jsonl` 被篡改导致回滚错目标（append-only + 0600 + 只按 `purge` 字段执行、不执行任意命令）。

## 7. 实施计划与工作量分级

| 级 | 内容 | 判定 | 估算 |
| --- | --- | --- | --- |
| **A 配置/默认值（小）** | `profile=portable\|fhs` + 四路径默认改 + 首启旧路径检测 WARN + 文档 | 不重构，只改默认与校验 | 1–2 人日 |
| **B 卸载链（中）** | `kore uninstall`（停服务/删 unit/`userdel kore-*`/提示回滚）+ `make install/uninstall` + `changes.jsonl` 写入（内核侧 root action begin/end） | 新增命令 + 少量重构 | 3–5 人日 |
| **C 插件改造（中，按仓）** | `site`（站点根 + vhost 清单）、`ssl`（证书目录）、`app-deploy`（数据根）、`firewall`/`waf`/`cron`/`ssh-guard`（清单 + 回滚命令）、`db-*`/`redis`（变更确认） | 逐仓改默认 + 接 `changes.record` | 每仓 0.5–2 人日，合计 8–12 人日 |
| **D userns（大，评估项）** | `CLONE_NEWUSER` 替代 useradd | 需要新 ADR + 平台矩阵验证 | 5–10 人日，**本期不做** |
| **E 验收（中）** | `make zero-intrusion-check`（§3.6 脚本化，隔离实例 + 真机双跑） | 新门禁 | 2–3 人日 |

**建议顺序**：A → E（先有判据）→ B → C；D 单独立项。

## 8. 复审条件

1. 发行版打包需求出现（`fhs` profile 成为主路径）→ 复审"默认"定义；
2. `userns` 在 Tier A 全矩阵（RHEL8/Alpine/Debian）验证通过 → 复审 §3.2；
3. 出现清单外写入的第三方插件 → 复审 §3.5 是否需收紧为"内核拒绝"（而非文档约束）；
4. v1.0 发布前 → 用 §3.6 对**全新机器**跑一次，作为发布门禁。

## 9. 实现记录（阶段 A + E，2026-11-23）

lead 裁决后先落地"默认值 + 判据"，阶段 B（uninstall / changes.jsonl）与 C（插件目录改造）仍待排期。

| 项 | 实现 | 证据 |
| --- | --- | --- |
| profile 字段 | `Snapshot.Profile` + 配置文件顶层 `profile`；`KORE_PROFILE`（最高）> 配置 > 可执行文件推导 | `internal/core/config/{types.go,profile.go,parse.go}`；非法值退出码 2（不静默降级） |
| `<install>` 推导 | `KORE_HOME` > `os.Executable()`（符号链接解析后：`.../bin/<exe>` → 父目录；否则所在目录；落在 `/usr/bin` 等系统目录 → 自动退回 fhs） | `internal/core/config/profile.go`；理由见 §3.1：可执行文件位置是"用户实际把 Kore 放哪"的唯一可靠信号，`KORE_HOME` 给运维显式覆盖 |
| portable 默认 | `config` / `data`（state+plugins+index）/ `run`（socket）/ `logs` 全部 `<install>` 内；配置默认 `<install>/config/config.yaml` | `defaultsFor` / `defaultLayout` / `DefaultConfigPath` |
| fhs 告警 | 选 fhs 启动打 WARN（"非零侵入模式，删目录不清理系统路径"） | `profileWarnings`；`docs/CORE.md` §2.1 |
| 旧路径迁移提示 | 检测旧配置/旧 `state.db` 且新路径为空 → 只打可操作 WARN，**不自动迁移** | `profileWarnings`；`docs/RUNBOOK.md` §6.3 |
| 门禁 | `make zero-intrusion-check`（隔离安装根、不设 `KORE_HOME`/`--config`）：系统路径零新增 / portable 目录与 socket 在内 / 未新建 `kore-*` 用户与 unit；既有用户、unit 单列为豁免项 | `scripts/zero-intrusion-check.sh`；接入 `make check` 11/12 段 |
| 文档 | CORE §2.1（profile 与环境变量 5 个）、RUNBOOK §6（安装/卸载/迁移/门禁）、ARCHITECTURE §2.2、AGENTS G-31 | 本 ADR + 上述文件 |

**首跑结果（2026-11-23，本机）**：隔离根 `/tmp/kore-zero-intrusion.XXXX`，11 PASS / 0 INFO / 0 FAIL——`<install>/data|run|logs` 齐备、socket 在 `<install>/run/kore.sock`、`/-/healthz` 200、`/etc/kore` `/var/lib/kore` `/var/log/kore` `/run/kore` 零新增、无新用户/组/unit。

**已知遗留（阶段 B/C）**：`kore uninstall` 尚未提供（豁免 #1/#2 的清理目前靠 RUNBOOK 命令）；`changes.jsonl` 未落地（插件宿主变更无清单）；`site` / `ssl` / `app-deploy` 的默认目录仍偏系统路径；`cmd/kored` 里 `index_dir` 空值兜底仍写 `/var/lib/kore/index`（不在本阶段写域，随 B 收口）。

## 10. 卸载链实现记录（阶段 B，2026-11-23）

**已落地**：`kored uninstall`（`cmd/kored/uninstall.go`）+ 平台能力（`internal/platform/{cleanup.go,linux_cleanup.go,stub_cleanup.go}`）+ 结构化账本（`cmd/kored/changes.go`）+ `make install/uninstall` + RUNBOOK §6.2。

执行序（不可变，`runUninstallWith` 内按序调用）：

```
1. systemctl stop kore.service（Active 才停）
2. systemctl disable kore.service
3. rm /etc/systemd/system/kore.service
4. systemctl daemon-reload        ← 不能省，否则 systemctl 仍认旧 unit
5. 按 /etc/passwd 前缀 userdel -r 所有 kore-*
6. 打印 <state>/changes.jsonl 清单（默认不执行回滚）
7. --purge：执行白名单 purge_op + 删状态目录
8. 打印仍需手工处理项（安装目录、未回滚的宿主变更）
```

**关键约束与实现**：

| 约束 | 实现 |
| --- | --- |
| 用户扫描不依赖 state | `linux_cleanup.go` 直接读 `/etc/passwd` 前缀匹配，`passwdPath` 可注入仅用于测试 |
| 删除前再校验名字 | 复用 `validateAccountName`（与 useradd 同一正则），不合法即 `Failed` 不拼 argv |
| `-r` 安全 | 插件 home 建为 `/nonexistent`；`-r` 只删 home，不会碰真实数据目录 |
| 幂等 | unit 缺失 → 跳过；"does not exist" → 视为成功；账本/state 缺失 → 空清单 |
| 安全阀 | 非 root 且动 unit/用户 → 退出 6；非 TTY 且无 `--yes` → 零变更退出 2 |
| G-16 | `systemctl`/`userdel` 只在 `internal/platform` 调，固定候选路径不查 PATH |
| 账本不用 shell 字符串 | `purge_op{kind,args}`，kind 白名单 `file.remove` / `file.restore`，未知 kind 拒绝；路径必须绝对且非 `/` |

**测试**：`cmd/kored/uninstall_test.go`（注入假 `platform.Cleanup` + 假 `execPurge` + 临时 state）、`cmd/kored/changes_test.go`（账本 0600、结构化 op、坏行、拒绝 shell 字符串）、`internal/platform/linux_cleanup_test.go`（临时 `/etc/passwd` + 假 `userdel`/`systemctl` 可执行文件）。**测试从不触碰真实系统用户**。

**未实现（下一阶段）**：`kore uninstall`（安装脚本形态）尚未提供——当前由 `make install` 写 unit；账本写入点仍在阶段 C（`privilege` 的 root.action 收口后自动记账）；`file.restore` 需要备份文件先由插件写入。
