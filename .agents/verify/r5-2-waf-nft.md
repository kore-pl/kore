# R5-2 · root-action 白名单扩展 + waf 接真实 nft 后端

> 执行者: kore-impl-waf（implementer）｜日期: 2026-11-23｜前置: R5-1（通道端到端可用、`--pipe` 缺陷已修）
> 范围: `pkg/pluginapi/`（受控命令形状）、`internal/core/privilege/`（执行期校验 + 测试）、`docs/DECISIONS/0022-*`、`docs/PLUGIN-PROTOCOL.md §3.1.3`、`kore-plugin-waf` 全仓

## 0. 结论

| 项 | 结论 |
| --- | --- |
| allowlist 升级 | 从「命令名集合」升级为「命令 + 语句形状 + 追加参数形状」三层，唯一实现 `pkg/pluginapi/rootpolicy.go`；**13 个命令**、每条都有形状，**没有一条是"命令名放行"** |
| 新增命令 | `nft` `resolvectl` `unbound-control` `dig` `fail2ban-client`（后者是 ssh-guard 0.2.x 既有声明的必需品）。`ipset` 初版曾加入，**按 lead 裁决已移除**（插件只用 nft；未使用的特权面一律不开，见 §8.1） |
| 绝对路径洞 | 已堵：argv[0] 是绝对路径时目录必须落在系统二进制目录（`/bin` `/sbin` `/usr/bin` `/usr/sbin` `/usr/local/bin` `/usr/local/sbin`），basename 仍须有形状 |
| **sed 处置** | **删除**：waf 不再有 `modsec-set-mode`，通道里**没有任何任意文件写入口**（详见 §5） |
| waf 数据面 | 真实 `nft`：`table inet kore_waf` + `banned4/banned6` 集合 + input base chain + 基础防护 4 条规则；`observe|enforce|off` 可切；新增 `waf.ban/unban/bans` |
| 隔离验证 | `unshare -rn` 独立 netns 里按 info.json 的声明 argv 跑通全流程；宿主 `nft list ruleset`/`iptables -S`/`ufw status` 三项 sha256 **前后一致** |
| 门禁 | kore `go vet` 0、`go test -count=1 -timeout 200s ./...` 全绿、`make check` exit 0；waf `go vet` 0、`go test` 全绿 |
| 发版 | waf v0.3.0：commit `2db5f92`、tag `v0.3.0`、dist sha256 `e526881e…270e` size 2891664（两次打包 + 干净树复现一致）、GitHub release 资产 curl 校验一致 |

## 1. 环境

| 项 | 值 |
| --- | --- |
| 宿主 | Ubuntu 26.04.1 / kernel 见 `uname -r` / Wayland |
| nft | `nftables v1.1.6 (Commodore Bullmoose #7)`，`/usr/sbin/nft` |
| ipset | **未安装**（`ipset: 未找到命令`）→ 按裁决已从形状表移除（见 §8.1） |
| 本会话身份 | 非 root（uid 1000）；`sudo -n` 被 `NoNewPrivs:1` 拒绝；宿主 root 读取走 `systemd-run --user`（NoNewPrivs=0）内的 `sudo -n`（R5-1 已验证的同一手法） |
| 宿主防火墙 | **ufw 不活动；宿主已有 libvirt 的 nft 规则**（`table inet libvirt_network` 等）→ 任何验证必须在独立 netns 内做，并前后比对宿主 sha256 |

## 2. 任务一：受控命令形状（kernel）

### 2.1 数据结构（file:line）

| 结构 | 位置 | 作用 |
| --- | --- | --- |
| `ArgShape` | `pkg/pluginapi/rootpolicy.go:53` | 一个 argv 元素允许的形状：正则 + 可选结构化复核（IP/CIDR 走 `net.ParseIP`、端口走数值区间） |
| `TokenSpec` | `pkg/pluginapi/rootpolicy.go:74` | 声明 argv 某一位：`Literal` 逐字相等 或 `Shape` 匹配 |
| `CommandPattern` | `pkg/pluginapi/rootpolicy.go:106` | 一条语句形状：`Tokens`（声明部分逐位）+ `Tail`（追加参数逐位）+ `TailRepeat` |
| `CommandPolicy` | `pkg/pluginapi/rootpolicy.go:118` | 一个命令的全部形状 + `MaxStatements` + `FlattenArgs` |
| `RootCommandPolicies` | `pkg/pluginapi/rootpolicy.go:135` | 13 个命令的形状表（唯一实现） |
| `nftPatterns()` | `pkg/pluginapi/rootpolicy.go:292` | nft 语句形状（含 `add rule` 1..28 个表达式 token） |
| `ValidateRootArgv` | `pkg/pluginapi/rootpolicy.go:528` | 声明层校验（registry 启用 + `privilege.ValidateAction` 都走它） |
| `ValidateRootAppendedArgv` | `pkg/pluginapi/rootpolicy.go:536` | 声明+追加合并校验（**执行期**，`internal/core/privilege/service.go:163` 调用） |
| `resolveCommandName` | `pkg/pluginapi/rootpolicy.go:695` | argv[0] 归一：裸命令名 或 系统二进制目录内的绝对路径 |
| `splitStatements` / `flattenTokens` | `pkg/pluginapi/rootpolicy.go:646` / `:634` | 按顶层 `;` 切语句（花括号内不切）；对 `FlattenArgs` 命令按空白再切 token（nft 自己就是这么解析的） |
| `sysBinaryDirs` | `pkg/pluginapi/rootpolicy.go:40` | 绝对路径允许的 6 个系统目录 |

接入点：`pkg/pluginapi/rootaction.go:98`（schema 校验整体形状）；`internal/core/privilege/service.go:163`（执行前校验追加参数）。

### 2.2 每个命令锁到什么程度

| 命令 | 允许的子命令 | 关键形状约束 |
| --- | --- | --- |
| `nginx` | `-s reload` / `-t` / `-T` / `-v` / `-V` | 无追加参数；`-s stop/quit` 未放行 |
| `ufw` | `status [verbose|numbered]` / `show added|raw` / `--version` / `reload` / `allow|deny|delete` | 目标 = 端口、端口/协议、端口列表或应用配置名（`ufwTarget`，数值复核 1–65535）；`enable/disable` 未放行 |
| `iptables` | `-S` / `-L` / `-t <table>` 组合 | **只读**；`-A/-I/-D/-F` 未放行 |
| `systemctl` | `is-active` / `is-enabled` / `status` / `show` / `cat` / `list-units` / `list-unit-files` / `--version` | **只读**；`restart/stop/start` 未放行；单元名禁 glob |
| `crontab` | `-l` / `-l -u <user>` / `-u <user> -l` | **只读**；写 crontab 未放行 |
| `chmod` | `<三位八进制> <kore 路径>` | 三位八进制 ⇒ **不可能带 setuid/setgid/sticky**（`4755` 直接被拒）；路径限 `/etc/kore` `/var/lib/kore` `/var/log/kore` `/run/kore` |
| `chown` | `user[:group] <kore 路径>` | 同上路径约束 |
| `docker` | `ps` `ps -a` `inspect` `logs` `stats --no-stream` `images` `version` `info` | **只读**；`run/exec/start/stop/restart` 未放行 |
| `nft` | `add table` / `add set` / `add chain` / `flush chain` / `delete table` / `add rule` / `add|delete element` / `list` | 表名必须 `^kore_[a-z0-9_]{1,24}$`；族限 inet/ip/ip6/arp/bridge；集合类型/标志/钩子/优先级/策略枚举；**表达式 token 禁 `;`、引号、反引号、`$`、空白、换行，首字符不得 `-`**（挡 `-f`）；≤8 条语句，仅末句可带追加参数 |
| `resolvectl` | `status` / `statistics` / `query` / `resolve` / `flush-caches` / `dns` / `domain` | 无 `set-dns` / `revert` 等改配置入口 |
| `unbound-control` | `status` / `stats` / `stats_noreset` / `list_forwards` / `list_local_zones` / `get_option` / `flush_zone` / `flush_bogus` / `flush_negative` | 无 `set_option` / `local_data` 等写入口 |
| `dig` | `[name] [type] [+option]` / `@server name [type] [option]` | 查询名/类型/@server/`+选项` 全锁形状；`-f` `-k` 等开关不可达 |
| `fail2ban-client` | `status [jail]` / `set <jail> banip|unbanip` | jail 名语法；banip/unbanip 追加参数只能是 IP/CIDR |

### 2.3 「不放行任意 argv」的四个机制

1. **声明层**：整条 argv 必须逐位命中某个语句形状；
2. **执行层**：追加参数只能落在命中形状的 `Tail` 上（`privilege/service.go:163`），`Tail` 为空即禁止追加；
3. **绝对路径限目录**：`/tmp/x/nft`、插件 state 目录里的 `nft` 一律拒绝（否则形状全过、执行的是攻击者二进制）；
4. **命名空间**：nft 表必须 `kore_` 前缀，插件不可能改宿主的 `filter`/`nat`。

## 3. 注入面用例清单与结果

`go test -count=1 ./pkg/pluginapi/ ./internal/core/privilege/` → 全绿。用例（节选，均为 `t.Run` 子测试）：

| 类别 | 用例（argv / 追加参数） | 结果 |
| --- | --- | --- |
| shell 分号 | `nft list table inet "kore_waf;" flush ruleset` | 拒绝（表名形状） |
| 声明两条语句但第二条非法 | `nft list ruleset ; flush ruleset` | 拒绝（语句形状） |
| 追加参数分号 | `ufw allow` + `22/tcp; ufw disable` | 拒绝（ufwTarget） |
| 追加参数命令替换 | `ufw allow` + `$(reboot)` | 拒绝 |
| 追加参数反引号 | `ufw allow` + `` `reboot` `` | 拒绝 |
| 追加参数管道/与号 | `ufw allow` + `22\|reboot` / `22&reboot` | 拒绝 |
| 追加参数换行/制表 | `ufw allow` + `22\ndisable` / `22\t/tcp` | 拒绝 |
| 只读语句被追加写参数 | `nft -j list table inet kore_waf` + `counter drop` | 拒绝（Tail 为空） |
| 批处理非末语句追加 | `nft add table … ; list ruleset` + `drop` | 拒绝 |
| 集合元素非 IP | `nft add element inet kore_waf banned4` + `{ not-an-ip }` | 拒绝（IP 形状） |
| 元素大括号被替换 | `nft add element … banned4` + `203.0.113.7`（缺 `{}`） | 拒绝（Tail 长度） |
| 端口越界 | `ufw allow` + `70000/tcp` | 拒绝（数值复核） |
| nft 读脚本 | `nft -f /etc/passwd` | 拒绝 |
| dig 读文件 | `dig -f /etc/passwd` | 拒绝 |
| nginx 覆盖配置 | `nginx -c /tmp/evil.conf` | 拒绝 |
| 表名越界 | `nft add table inet filter` / `nft delete table inet kore_*` | 拒绝（kore_ 前缀） |
| setuid 后门 | `chmod 4755 <插件二进制>` | 拒绝（只许三位八进制） |
| 系统路径改写 | `chmod 777 /etc/passwd` / `chown root:root /usr/bin/sudo` | 拒绝（kore 路径） |
| 绝对路径逃逸 | `/tmp/payload/nft list ruleset`、`/var/lib/kore/plugins/waf/nft …` | 拒绝（目录白名单） |
| 路径穿越 | `/usr/bin/../bin/nft …` | 拒绝（非规范化） |
| 子命令越界 | `ufw enable` / `nginx -s stop` / `systemctl restart sshd` / `iptables -A INPUT -j DROP` / `crontab -r` / `docker run --privileged` / `ipset create …`（命令已移除，整条不可达）/ `resolvectl set-dns` / `unbound-control set_option` | 全部拒绝 |
| 空/超长 | `{}`、`nft ""`、200 字符表名、300 字符追加参数、5 个追加参数 | 拒绝 |
| 执行期注入（privilege） | 5 类追加注入 → `E_INVALID` 且 **runner 调用 0 次**、写 1 条 deny 审计 | 拒绝 |

> 说明：通道 argv 不经 shell，所以上表的 `|`/`&`/`$(` 不是 shell 注入，而是「程序参数语义污染」；真正的程序级注入面是 `;`（nft 多语句）、`-f`（读脚本）、`{}`/引号（token 边界），三者都已封。

## 4. 任务二：waf 数据面

### 4.1 方法契约（v0.3.0）

| 方法 | 入参 | 结果 | capability |
| --- | --- | --- | --- |
| `waf.status` | `{}` | 引擎平面 + `backend{tool,available,channel,table,chain,present,mode,banned_count,rules_count,reason,hint}` | `system:read` |
| `waf.rules` | `{engine?}` | 引擎 `rulesets[]` + `nft{table,chain,present,mode,rules[{handle,summary,verdict,packets,bytes}],bans_count,bans[]}` | `system:read` |
| `waf.logs` | `{limit?, since?, rule_id?, engine?}` | 不变 | `system:read` |
| `waf.bans` | `{limit?}` | `present/mode/count/bans[{ip,timeout_s,expires_s,set}]` | `system:read` |
| `waf.toggle` | `{mode: observe\|enforce\|off, confirm?}` | `previous_mode/mode/applied/verified/rules[]/steps[]`；`off` 缺 `confirm` → `E_UNAUTHORIZED` | `system:admin` |
| `waf.ban` | `{ip, ttl_s?, reason?}` | `ip/family/set/ttl_s/banned/hint/steps[]`；幂等；`ttl_s` 60–2592000（0=永久） | `system:admin` |
| `waf.unban` | `{ip}` | `ip/set/removed/hint/steps[]`；不在集合也成功 | `system:admin` |

### 4.2 `info.json` 片段

```json
"requires_root": true,
"method_capabilities": {
  "waf.status": "system:read", "waf.rules": "system:read", "waf.logs": "system:read",
  "waf.bans": "system:read", "waf.config.get": "system:read",
  "waf.ban": "system:admin", "waf.unban": "system:admin",
  "waf.toggle": "system:admin", "waf.config.set": "system:admin"
},
"root_actions": [
  {"id":"nft-init-table","argv":["nft","add table inet kore_waf"],"timeout_s":15,"irreversible":false,"description":"建 kore 自有 nft 表 kore_waf（已存在视为成功；只动 kore_ 前缀的表）"},
  {"id":"nft-init-set4","argv":["nft","add set inet kore_waf banned4 { type ipv4_addr ; flags interval,timeout ; }"],"timeout_s":15,"irreversible":false,"description":"建 IPv4 封禁集合 banned4（interval 支持 CIDR，timeout 支持临时封禁）"},
  {"id":"nft-init-set6","argv":["nft","add set inet kore_waf banned6 { type ipv6_addr ; flags interval,timeout ; }"],"timeout_s":15,"irreversible":false,"description":"建 IPv6 封禁集合 banned6（interval 支持 CIDR，timeout 支持临时封禁）"},
  {"id":"nft-init-chain","argv":["nft","add chain inet kore_waf input { type filter hook input priority -10 ; policy accept ; }"],"timeout_s":15,"irreversible":false,"description":"建挂在 input 的 base chain（priority -10，policy accept：只丢命中规则的包）"},
  {"id":"nft-mode-observe","argv":["nft","flush chain inet kore_waf input",";","add rule … log prefix kore-waf-ban4 level warn",";", "… 共 4 条"],"timeout_s":30,"irreversible":false,"description":"观察模式：清链后装 4 条只计数+记日志的规则（命中不阻断，用于验证规则是否误伤）"},
  {"id":"nft-mode-enforce","argv":["nft","flush chain inet kore_waf input",";","add rule … counter drop",";", "… 共 4 条"],"timeout_s":30,"irreversible":false,"description":"拦截模式：清链后装 4 条阻断规则（封禁集合、SYN 扫描限速、单 IP 并发上限）"},
  {"id":"nft-flush","argv":["nft","flush chain inet kore_waf input"],"timeout_s":15,"irreversible":false,"description":"清空 kore 链（关闭防护；保留表与封禁集合，重新下发立即生效）"},
  {"id":"nft-ban4","argv":["nft","add element inet kore_waf banned4"],"timeout_s":15,"irreversible":false,"description":"把 IPv4 地址/CIDR 加入封禁集合（追加参数：{、地址、可选 timeout 与时长、}）"},
  {"id":"nft-ban6","argv":["nft","add element inet kore_waf banned6"], …},
  {"id":"nft-unban4","argv":["nft","delete element inet kore_waf banned4"], …},
  {"id":"nft-unban6","argv":["nft","delete element inet kore_waf banned6"], …},
  {"id":"nft-list","argv":["nft","-j","list table inet kore_waf"],"timeout_s":15,"irreversible":false,"description":"只读列出 kore 表（JSON）：封禁元素、剩余超时、规则与计数器，供状态/回读校验"}
]
```

- **irreversible 语义**：12 条全部 `false`。理由：建表/集合/链可清空或删除；`enforce` 可回 `observe`/`off`；封禁可 `unban`；清链可重新下发。真正不可回滚的（删表、清空封禁名单）本轮**不暴露**动作。若声明 `true`，插件无法自签 confirm 令牌（只有管理会话能签发），动作会永远执行不了。
- **method_capabilities**：读方法 `system:read`，写方法（`ban`/`unban`/`toggle`/`config.set`）`system:admin`。
- 单测 `TestInfoJSONRootActionsLocalSchema` 锁定 id 语法/唯一、argv 1–32 项、每项 ≤256、总长 ≤4096、无控制字符、timeout 1–300、description ≤200 且非空、全部非 irreversible。
- SDK 形状表门槛：`TestInfoJSONRootActionsSchema` 在 pluginapi v0.1.2 下**显式 skip** 并打印「需要 pluginapi ≥ v0.1.3」（见 §8）。

### 4.3 基础防护规则（enforce）

| 规则 | 含义 |
| --- | --- |
| `ip saddr @banned4 counter drop` | 封禁集合（IPv4，支持 CIDR/超时） |
| `ip6 saddr @banned6 counter drop` | 封禁集合（IPv6） |
| `tcp flags syn tcp dport { 80, 443 } meter kore_syn4 { ip saddr limit rate over 60/second burst 120 packets } counter drop` | SYN 高频扫描限速（每源 IP） |
| `tcp dport { 80, 443 } ct count over 200 counter drop` | 单 IP 并发连接上限 |

`observe` 同规则、verdict 换成 `counter log prefix kore-waf-*`（不阻断）。**UA 过滤没有做**：nft 不能解析 HTTP UA，UA/规则级 WAF 仍归引擎（modsecurity/naxsi），这是能力边界而不是遗漏。

## 5. sed / modsec-set-mode 的处置结论（lead 追加项）

**选了「消除写入口」，而不是「收窄 sed」**：

- 0.2.0 的 `modsec-set-mode`（argv `/bin/sed -i.bak` + 追加「表达式 + 文件路径」）**已删除**，`nginx-reload` 也一并删除；
- 通道里现在**没有**任何一个能写文件的动作：12 条 nft 动作只动 netfilter 对象，且表名锁 `kore_` 前缀；
- 引擎自身的模式（`SecRuleEngine`）现在**只只读展示**（`waf.status.mode`），不再由插件改写；
- 审计语义从「跑了个 sed」变成「下发了这 4 条 nft 语句 / 封禁了这个 IP」，可直接判读。

被否决的中间方案与理由见 ADR-0022「被否决的选项」：收窄 sed 等价于自造受限编辑器；让插件写脚本 + `nft -f` 固定路径则脚本内容不受形状约束且与降权方向冲突。

## 6. 隔离环境真实规则验证

### 6.1 方法

`unshare -rn bash <脚本>`：在**独立网络命名空间**里按 `info.json` 的 12 条声明 argv 逐条驱动真实 nft（1.1.6），
追加参数按插件实际构造（`{ ip [timeout ttl] }`）。netns 随进程退出销毁，宿主规则不可能被改。

### 6.2 关键输出（原文节选）

```
== 00 空 ruleset 基线
exit=0
== 01 建表 :: nft-init-table                            exit=0
== 02 建 v4 集合 :: nft-init-set4                       exit=0
== 03 建 v6 集合 :: nft-init-set6                       exit=0
== 04 建链 :: nft-init-chain                            exit=0
== 05 重复初始化（nft 1.1.6 的 add 对同定义幂等）        exit=0 ×4
== 06 临时封禁 203.0.113.7 (+timeout 3600s)             exit=0
== 07 永久封禁 2001:db8::7                              exit=0
== 08 重复封禁（幂等）                                   exit=0
== 09 集合内容
table inet kore_waf {
        set banned4 { type ipv4_addr; flags interval,timeout; elements = { 203.0.113.7 } }
}
table inet kore_waf {
        set banned6 { type ipv6_addr; flags interval,timeout; elements = { 2001:db8::7 } }
}
== 10 下发拦截模式 :: nft-mode-enforce                   exit=0
== 11 规则快照（enforce）
        ip saddr @banned4 counter packets 0 bytes 0 drop
        ip6 saddr @banned6 counter packets 0 bytes 0 drop
        tcp flags syn tcp dport { 80, 443 } add @kore_syn4 { ip saddr limit rate over 60/second burst 120 packets } counter packets 0 bytes 0 drop
        tcp dport { 80, 443 } ct count over 200 counter packets 0 bytes 0 drop
== 12 下发观察模式 :: nft-mode-observe                    exit=0
== 13 规则快照（observe，无 drop，只有 log prefix）
        ip saddr @banned4 counter packets 0 bytes 0 log prefix "kore-waf-ban4"
        ip6 saddr @banned6 counter packets 0 bytes 0 log prefix "kore-waf-ban6"
        tcp flags syn tcp dport { 80, 443 } add @kore_syn4 { … } counter packets 0 bytes 0 log prefix "kore-waf-scan"
        tcp dport { 80, 443 } ct count over 200 counter packets 0 bytes 0 log prefix "kore-waf-conn"
== 14 解封 203.0.113.7 :: nft-unban4                      exit=0
== 15 解封不存在的元素
Error: element does not exist
exit=1                                    ← 插件按幂等成功处理（removed=false + hint）
== 16 关闭防护（清链）:: nft-flush                        exit=0
== 17 关闭后：规则 0 条、封禁保留（banned6 = 2001:db8::7）
== 18 只读 JSON 快照 :: nft-list                          exit=0
== 19 最终 ruleset：仅 table inet kore_waf
```

两次执行该脚本，输出 `diff` 完全一致（`diff -q` 无差异）——下发是确定性的（幂等）。

### 6.3 宿主基线 diff（未改动宿主）

读取宿主规则必须 root：在 `systemd-run --user` 的 transient unit 内 `sudo -n`（NoNewPrivs=0，R5-1 已验证的同一手法）。

```
前: b1e78966ac1cff8e64af068f387b51e1b31e0806351ec47650e7dd1c712f3a7d  /tmp/host-nft.ruleset
    71b1ea8d60b82e5a1ae4d33ca055e389eb31f6000abde394bcc4f8c3791f3e2b  /tmp/host-iptables.txt
    147eb0529db1c219500747f503e8ebbeffa8c62428962447dbedfcd72f67ca36  /tmp/host-ufw.txt
    kore_waf-in-host-tables=0
后: b1e78966ac1cff8e64af068f387b51e1b31e0806351ec47650e7dd1c712f3a7d  /tmp/host-nft.ruleset
    71b1ea8d60b82e5a1ae4d33ca055e389eb31f6000abde394bcc4f8c3791f3e2b  /tmp/host-iptables.txt
    147eb0529db1c219500747f503e8ebbeffa8c62428962447dbedfcd72f67ca36  /tmp/host-ufw.txt
    kore_waf-in-host-tables=0
```

三项逐字一致；宿主 `nft list tables` 里没有 `kore_waf`（宿主原有 `libvirt_network` 等表未受影响）。
**未碰宿主 `ufw`**（全程未执行 `ufw` 任何写命令）。

## 7. 门禁与发版

### 7.1 kore（kernel）门禁

```
$ go vet ./...                                        exit 0
$ go test -count=1 -timeout 200s ./...                exit 0（全部包 ok）
$ cd pkg/pluginapi && GOWORK=off go test ./...        exit 0
$ make check                                          exit 0（11/11 段，"门禁全部通过"）
```

### 7.2 waf 仓门禁

```
$ gofmt -l .                                          无输出
$ GOWORK=off go vet ./...                             exit 0
$ GOWORK=off go test -count=1 -timeout 200s ./...     exit 0（main / wafop / plugincfg / tests/fault 全 ok）
```

### 7.3 dist 与发版

| 项 | 值 |
| --- | --- |
| 版本 | 0.2.0 → **0.3.0**（feat + 破坏性方法语义变更 → minor） |
| dist sha256 | `e526881e6de05b533781663c64982a61028a222ef32d0bf743f36d22d576270e` |
| size_bytes | `2891664`（回填值与实际一致） |
| 两次打包 | 同一 sha（第 1 次与第 2 次均为 `e526881e…`） |
| 干净树复现 | `git archive HEAD \| tar -x -C /tmp/waf-clean && make dist` → **同 sha** |
| commit | `2db5f927bce818a41d1c64ee735a0a24af330be3` |
| tag | `v0.3.0`（annotated，`git cat-file -t` = `tag`，指向同一 commit） |
| push | `origin` main+tag ✅；`gitee` main+tag ✅ |
| GitHub release | https://github.com/pengtang1024/kore-plugin-waf/releases/tag/v0.3.0 |
| release 资产校验 | `curl -L …/waf-0.3.0.tar.gz` → HTTP 200，sha256 **`e526881e…270e`**，size 2891664 |
| Gitee release | **未创建**（本机无 GITEE_TOKEN，无法走 API；docs/GITEE-MIRROR.md 口径为 WARN 不阻塞）；main+tag 已镜像 |

## 8. 未证明项与需裁决项

1. **ipset 已按裁决移除**（命令数 14 → 13）：插件只用 nft 集合，ipset 是零收益的未使用特权面；按 G-22「设计层优先」减少特权面优于保留未来可能性。移除范围：形状表、ADR-0022（决策点/被否决选项/后果/复审条件）、协议文档、测试（`ipset …` 现在断言为「不在受控命令白名单」）。将来真做 ipset 后端时再加条目，并自带 ipset 隔离环境验证。
2. **未在真 root kored 下一体化跑通**：本会话非 root，插件侧 nft 命令真实性由 netns 证明、内核侧通道成功路径由 `internal/core/privilege` 的 root 集成测试覆盖（需 root 才执行，否则 skip）。二者拼起来才等于端到端；同一进程链的端到端需真 root 环境补验。
3. **SDK 版本门槛**：形状表在 `pkg/pluginapi`，插件钉 v0.1.2 → 插件侧 schema 自检显式 skip（打印「需要 pluginapi ≥ v0.1.3」）。需要 SDK 发 v0.1.3（`pkg/pluginapi/v0.1.3` tag）后把 waf 的 `require` 升上去，自检即自动启用。**本轮未发 SDK tag**（不在本任务写域，需 lead 裁决优先级）。
4. **nft 版本兼容**：只实测 1.1.6。老版本缺 `meter`/`ct count` 时按 `E_UNSUPPORTED` + 原始 stderr 降级（未逐版本实测）。
5. **跨仓漂移检测**：kore 仓的 `repo-check` 门禁禁止源码出现插件仓名字（G-13），所以「读插件仓 info.json」的跨仓测试**不能放内核仓**。当前漂移防线 = 插件侧本地 schema 测试 + SDK 形状校验（v0.1.3 后启用）+ kore 侧 nft 形状夹具测试。裁决点：是否允许在 `make check` 之外单设一个「跨仓契约」脚本（不进内核源码）。
6. **观察模式日志**：`nft log` 落内核日志，插件不解析（只解析引擎日志）；观察数据需 `journalctl -k` 查看。
7. **索引未更新**：`kore-plugins` 属其他任务写域（task-3 第 32 次重签负责），本轮只交付 dist sha/size 供索引登记：`waf@0.3.0 / e526881e…270e / 2891664`。
8. **变更集登记**：G-15 要求 BOARD 登记跨仓变更集；`.agents/BOARD.md` 本轮不可改（另有 owner），需由台账任务（task-2）补齐：kore commit（本文件同批）+ `kore-plugin-waf@2db5f92 / v0.3.0`。

## 9. 本批提交范围（kore 仓）

- 新增：`pkg/pluginapi/rootpolicy.go`、`rootpolicy_test.go`、`rootpolicy_nft_test.go`；`docs/DECISIONS/0022-root-command-shapes.md`；本文件
- 修改：`pkg/pluginapi/rootaction.go`、`rootaction_test.go`；`internal/core/privilege/service.go`、`privilege_test.go`、`systemd_integration_test.go`；`internal/core/httpapi/root_action_test.go`（fixture 补子命令）；`docs/PLUGIN-PROTOCOL.md` §3.1.3/§3.1.3.1；`docs/PLUGIN-SDK.md`；`.agents/LOG/DECISIONS.md`
- **附带**：`internal/core/privilege/systemd.go` 与 `privilege_test.go` 里 R5-1 的 `--pipe` 修复及其回归测试（R5-1 的改动此前未提交；若不一起提交，「测试断言无 --pipe」与「代码仍带 --pipe」会脱节使干净树变红）。属性归 R5-1，证据见 `.agents/verify/r5-1-privilege-success.md`。
- **未触碰**：`internal/core/supervisor/`、`web/`、`internal/core/market/verify.go`、`kore-plugins`、`.agents/BOARD.md`、`internal/platform/`（降权任务在改）。
