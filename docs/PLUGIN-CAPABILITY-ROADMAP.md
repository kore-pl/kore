# 插件能力上限：受控命令形状缺口盘点（形状表 roadmap）

> 状态: verified · 归属: verifier · 更新: 2026-11-23 · 里程碑: M5
> 结论：现有 13 个受控命令的**形状表缺口共 16 条**——A 类（扩形状可解决）8 条、B 类（需新原语，见 [ADR-0028](DECISIONS/0028-controlled-file-write.md)）3 条、C 类（不该做，永远退化成建议态）5 条；另有 3 条今日已补/已覆盖（nft 运行时 add rule / delete rule handle、nginx reload）。P0 全部集中在 ssh-guard 的「sshd 配置落盘 + 校验 + 生效」链路。

本文只做盘点：**不写实现、不改 `pkg/pluginapi/rootpolicy.go`、不动插件仓、不做重签**。形状表是 [ADR-0022](DECISIONS/0022-root-command-shapes.md) 的唯一实现；受控文件写的取舍见 [ADR-0028](DECISIONS/0028-controlled-file-write.md)（proposed）。

## 0. 为什么这是一堵墙

root-action 通道以 uid=0 执行 argv（[ADR-0018](DECISIONS/0018-privilege-model.md)），argv 不经 shell，所以约束面是**程序自己的语义**而不是 shell 元字符。`rootpolicy.go` 把「命令名白名单」升级成「命令 + 子命令 + 参数形状」三层：声明 argv 逐位匹配 `Tokens`，运行时追加参数逐位匹配 `Tail`，**`Tail` 为空 = 该动作禁止任何追加参数**。插件一旦要的命令/子命令/参数不在表里，唯一合法出路就是退化成「生成文本让用户手抄」——这正是 ssh-guard 现在的形态（`../kore-plugin-ssh-guard/suggest.go:12-20`）。

## 1. 现有 13 个受控命令的形状能力边界

| 命令 | 允许的子命令 / 语句 | 有 Tail？ | 能表达运行时参数？ | 主要缺失 |
| --- | --- | --- | --- | --- |
| `nginx` | `-s reload` / `-t` / `-T` / `-v` / `-V` | 无 | 否（动作全固定） | 无（停服是 C 类，刻意不做） |
| `ufw` | `status [verbose\|numbered]` / `show added\|raw` / `--version` / `reload` / `enable` / `disable` / `allow\|deny\|delete <target>` | **有**（target，可重复） | 端口 / 端口列表 / 应用配置名 | `delete <规则号>` 与「端口号」同形，语义冲突 |
| `iptables` | `-S` / `-L`（含 `-t <table>`、`-n -v`） | 无 | 否 | 写规则（C 类）；`-w` 之类参数未开口 |
| `systemctl` | `is-active` / `is-enabled` / `status` / `show` / `cat` / `list-*` / `--version` | 无 | 否 | **没有 reload/restart 白名单单元**（sshd 生效路径直接卡住） |
| `crontab` | `-l [-u <user>]` | 无 | 否 | 写入（C 类） |
| `chmod` | `<三位八进制> <kore 路径>` | 无 | 否 | 只能 kore 自有目录；宿主配置文件归 B 类 |
| `chown` | `<用户[:组]> <kore 路径>` | 无 | 否 | 同上 |
| `docker` | `ps [-a]` / `inspect` / `logs` / `stats --no-stream` / `images` / `version` / `info` | 无 | 否 | 生命周期（start/stop/restart）未开口；`exec/run` 是 C 类 |
| `nft` | `add/delete table`、`add set`、`add chain`、`flush chain`、`add/delete element`、`list *`、`-j`/`-a` 列表、**`add rule`（固定头 + 追加表达式，≤28 token）**、**`delete rule … handle <n>`** | **有**（表达式 / handle） | 是（单语句内） | 非 `kore_` 前缀表、`flush ruleset`（C 类） |
| `resolvectl` | `status` / `statistics` / `query` / `resolve` / `flush-caches` / `dns|domain <iface>`（只读） | 无 | 否 | 设置链路 DNS（写入）未开口 |
| `unbound-control` | `status` / `stats*` / `list_*` / `get_option` / `flush_*` | 无 | 否 | `local_zone` / `forward_add`（写）未开口 |
| `dig` | `<name> [type] [+opts]`、`@server` | 无 | 否 | `-f` 批量（C 类） |
| `fail2ban-client` | `status [jail]` / `set <jail> banip|unbanip <ip>` | **有**（IP/CIDR） | 是 | `reload`、`get <jail> <opt>` 未开口 |

判定要点：**只有 3 条命令开了 Tail**（ufw / nft / fail2ban-client）。凡「动作固定但需要运行时拼参数」的场景，只要命令不在上述集合里，就必然退化成 hint。

## 2. 缺口清单（16 条）

证据列只给 file:line；「类」= A 扩形状 / B 新原语 / C 不该做。

| # | 插件 | 缺口（想要的能力） | 证据 | 类 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| G1 | ssh-guard | 写 `/etc/ssh/sshd_config.d/kore.conf` drop-in | `../kore-plugin-ssh-guard/suggest.go:20`、`:140` | **B**（ADR-0028） | **P0** |
| G2 | ssh-guard | `sshd -t` 校验配置 | `../kore-plugin-ssh-guard/suggest.go:103`、`:14-15`；`rootpolicy.go` 无 `sshd` 键 | **A** | **P0** |
| G3 | ssh-guard | `systemctl reload ssh`（发行版差异 ssh/sshd） | `../kore-plugin-ssh-guard/logsource.go:118-121`；`rootpolicy.go` systemctl 仅只读 | **A** | **P0** |
| G4 | dns | `rndc reload [zone]` | `../kore-plugin-dns/internal/dnsop/write_engine.go:374-392`（现降级为 E_NEED_ROOT + 手抄 `sudo rndc reload`） | **A** | P1 |
| G5 | dns | 用 TSIG 密钥文件跑 `nsupdate -k` | `../kore-plugin-dns/internal/dnsop/nsupdate.go:235`、`config.go:46`、`validate.go:90-94` | **B**（[ADR-0026](DECISIONS/0026-credential-transport.md) 凭据传递，非形状） | P1 |
| G6 | firewall | `ufw delete <规则号>`（`numbered` 列表里的序号） | `rootpolicy.go` `shapeUFWTarget`（纯数字按端口校验，序号被当端口） | **A** | P2 |
| G7 | container | `docker start/stop/restart <ref>` | `rootpolicy.go` docker 段注释「start/stop/restart 待有真实消费者」 | **A** | P1 |
| G8 | ssh-guard | `fail2ban-client reload` / `get <jail> <opt>` | `rootpolicy.go` fail2ban 段只有 status/banip/unbanip | **A** | P2 |
| G9 | dns | `resolvectl dns <iface> <server>` 设置链路 DNS | `rootpolicy.go` resolvectl 仅只读 + flush | **A** | P2 |
| G10 | dns | `unbound-control local_zone` / `forward_add` 写入 | `rootpolicy.go` unbound 段仅只读 + flush | **A** | P2 |
| G11 | 通用 | 写其它宿主配置（nginx vhost、systemd drop-in…） | 与 [ADR-0023](DECISIONS/0023-zero-intrusion.md) 冲突；同属受控文件写原语 | **B**（ADR-0028） | P2 |
| G12 | firewall | `ufw limit` / `ufw route` | 无消费者（现在 allow/deny/delete 够用） | **C** | P2 |
| G13 | dns | `dnsmasq` 重启生效（非 reload） | `write_engine.go:374` 注释：插件绝不启停宿主服务 | **C** | P2 |
| G14 | site | 容器内 `docker exec nginx -s reload` | `../kore-plugin-site` 走插件自身 docker 权限；`exec` 在形状表里刻意不开口 | **C** | — |
| G15 | 通用 | 任意 `systemctl stop/restart`、`crontab` 写入、`iptables` 写 | `rootpolicy.go` 各段注释已明确不外露 | **C** | — |
| G16 | 通用 | `nft` 非 `kore_` 前缀表 / `flush ruleset` / `nft -f` | `rootpolicy.go` `shapeKoreNftTable` 强制前缀；注释明确不外露 | **C** | — |

**已补 / 已覆盖（不计入 16 条）**：① `nft add rule`（固定头 + 追加表达式 token，单语句）；② `nft delete rule … handle`——两条均已在 `nftPatterns()` 内落地（waf 侧只差改用 Tail）；③ `nginx -s reload` 覆盖 ssl 证书换发后的生效动作。

## 3. A / B / C 分布

| 类 | 条数 | 条目 |
| --- | --- | --- |
| **A 扩形状可解决** | 8 | G2 `sshd -t`、G3 `systemctl reload` 白名单单元、G4 `rndc reload`、G6 `ufw delete <序号>`、G7 `docker` 生命周期、G8 `fail2ban reload/get`、G9 `resolvectl dns` 写、G10 `unbound` 本地区告示写 |
| **B 需新原语** | 3 | G1 sshd drop-in（受控文件写，ADR-0028）、G5 TSIG 密钥传递（ADR-0026）、G11 其它宿主配置写（同 G1 原语） |
| **C 不该做** | 5 | G12 ufw limit/route、G13 dnsmasq 重启、G14 docker exec、G15 任意 unit/定时任务/iptables 写、G16 nft 越表与脚本模式 |

**P0（3 条，全在 ssh-guard）**：G1 写 drop-in（B）、G2 `sshd -t`（A）、G3 `systemctl reload ssh`（A）——三条是一条链路，缺任一条 SSH 加固都只能手抄。配套契约：**先校验成功才允许 reload**（插件按顺序调用两次，内核不做跨动作事务；在 ADR-0022 增补里记为调用方契约）。

## 4. 建议的扩形状顺序

1. **nft 运行时规则收尾（已完成）**：形状已开，waf 侧只差改用 Tail；先把已有原语用满，避免「形状开了插件不用」。
2. **sshd -t + systemctl reload 白名单单元（G2/G3，A 类，P0）**：ADR-0022 增补两条形状——`sshd -t`（无 Tail）与 `systemctl reload <白名单单元>`（单元名走 `shapeUnitName`，白名单 `ssh|sshd|nginx`）。
3. **受控文件写原语（G1，B 类，P0）**：等 [ADR-0028](DECISIONS/0028-controlled-file-write.md) 裁决；若通过，第一份白名单只放 `/etc/ssh/sshd_config.d/`，且必须带「备份 + 原子替换 + 内容形状（ssh 指令白名单）+ 变更台账」四件套。
4. **rndc reload（G4，A 类，P1）**：DNS 动态更新本身立即生效，reload 只在 zone 文件直改场景需要，故排 P1。
5. **docker 生命周期（G7，A 类，P1）**：容器插件已有真实消费者，补 `start/stop/restart` + 复用 `shapeContainerRef`。
6. **P2 批量**：ufw 规则序号（G6）、fail2ban reload/get（G8）、resolvectl/unbound 写入（G9/G10）——无当前消费者，等真实需求再开，避免形状表膨胀。

**形状表扩充的硬约束**（照抄 ADR-0022 口径，不重复设计）：每加一条命令/子命令都要同步 `docs/PLUGIN-PROTOCOL.md` §3.1.3 并新增/增补 ADR；`Tail` 一旦非空即成为攻破插件后的可达面，必须逐位 `ArgShape` 且长度上限明确。

## 5. 与既有 ADR 的关系（只引用，不重复设计）

| ADR | 与本盘点相关的部分 |
| --- | --- |
| [0018](DECISIONS/0018-privilege-model.md) | 提权通道与降级硬要求（`E_NEED_ROOT` + hint 的合法性来源） |
| [0022](DECISIONS/0022-root-command-shapes.md) | 形状表唯一实现；本文所有 A 类都是它的增补候选 |
| [0023](DECISIONS/0023-zero-intrusion.md) | G11 的判据：安装目录外写入必须先改 ADR |
| [0026](DECISIONS/0026-credential-transport.md) | G5（TSIG 密钥）走凭据通道，不走形状 |
| [0028](DECISIONS/0028-controlled-file-write.md) | G1/G11 的唯一候选原语；proposed，未裁决前不写实现 |

## 6. 复现命令（只读）

```bash
cd /home/pt/Work/GolandProjects/kore
# 13 个受控命令与形状
grep -n '^\t"' pkg/pluginapi/rootpolicy.go | head -20
# 各仓 root_actions 声明
for d in ../kore-plugin-*; do python3 -c "import json;d=json.load(open('$d/info.json'));print(d['id'],len(d.get('root_actions') or []))"; done
# 退化点（手抄提示）
grep -rn '手抄\|手工下发\|suggest' ../kore-plugin-ssh-guard/*.go | grep -v _test
# rndc 降级
grep -n 'rndc' ../kore-plugin-dns/internal/dnsop/write_engine.go
```
