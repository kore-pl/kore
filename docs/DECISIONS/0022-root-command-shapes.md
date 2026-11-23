> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: accepted · 日期: 2026-11-23 · 决策者: lead · 关联: 0018-privilege-model.md、../PLUGIN-PROTOCOL.md §3.1.3、../SECURITY.md §15

# ADR-0022: root 动作的受控命令形状——把「命令名白名单」升级为「子命令 + 参数形状」

## 背景

ADR-0018 的提权通道（`systemd-run --uid=0` 执行插件声明的固定 argv）在 R5-1 已端到端跑通：`ufw-status` / `ufw-allow` / `ufw-deny` / `ufw-delete` / `iptables -S` 全部 200 + exit 0，审计 begin/end 齐备，回滚后与基线逐字一致。

但白名单本身只校验 **argv[0] 是不是已知命令名**，留下三个真实缺口：

| 缺口 | 事实 | 后果 |
| --- | --- | --- |
| 子命令不限 | `ufw` 在表里 ⇒ `ufw disable` 也放行；`nginx` 在表里 ⇒ `nginx -s stop` 也放行 | 一次动作就能关掉宿主的防火墙 / Web 服务 |
| 参数形状不限 | `nft add rule … counter drop`、`chmod 4755 <路径>` 都是「白名单命令 + 危险参数」 | 锁死宿主网络、把插件二进制变成 setuid 后门 |
| **绝对路径直通** | `validateArgv0` 对绝对路径只做「规范化、非根」检查，**不要求命令在表内** | 插件把自己写的可执行文件放进 `/tmp` 或 state 目录，声明 `/tmp/x/nft`：形状全部通过，实际执行的是攻击者的二进制 |

R5-1 之后要接的真实后端（waf 的 `nft` / `ipset`、dns 的 `resolvectl` / `unbound-control` / `dig`）全都要经这条通道，所以必须先补边界，而不是先把命令塞进白名单。同一轮里还发现一个已上线的具体反例：`kore-plugin-waf@0.2.0` 的 `modsec-set-mode` 声明 `["/bin/sed","-i.bak"]` + 追加「表达式 + 文件路径」——`sed` 不在白名单（靠绝对路径直通进来），语义上等于**以 root 写任意文件**，审计只能记「跑了个 sed」，看不出改了什么。

## 决策

1. **白名单单位从「命令名」改成「语句形状」**：`pluginapi.RootCommandPolicies`（`pkg/pluginapi/rootpolicy.go`）为每个命令列出允许的语句形状，每条形状 = 逐位 `Literal` 或 `ArgShape`（正则 + 可选结构化复核）。不在形状表里的 argv 一律 `E_INVALID`。
2. **两层校验**：
   - 声明 argv（来自 `info.json`，启用时用户确认）→ `ValidateRootArgv`，逐位匹配某个语句形状；
   - 运行时追加参数（插件进程给出，视为不可信）→ `ValidateRootAppendedArgv`，只能落在该动作命中形状的 `Tail` 上，长度也要对上；`Tail` 为空表示**该动作禁止任何追加参数**。
   - 内核在 **schema 校验点（registry / privilege.ValidateAction）与执行点（privilege.Execute）都校验**：声明合法 ≠ 声明+追加合法（`nft list …` + `counter drop` 就能把只读动作变成写规则）。
3. **绝对路径必须落在系统二进制目录**（`/bin`、`/sbin`、`/usr/bin`、`/usr/sbin`、`/usr/local/bin`、`/usr/local/sbin`），且 basename 必须在形状表内。插件自有目录、`/tmp`、相对路径一律拒绝。
4. **一条 nft 动作可含多条语句，但只有最后一句能带追加参数**：独立 `;` 元素切分语句（花括号内的 `;` 属于集合/链定义，不切分），≤8 句。这样批处理（建表 + 建集合 + 建链、清链 + 装规则）不会被追加参数改写成第二个动作。
5. **写操作只保留有真实消费者且语义可界定的子集**：
   - `ufw`：`status*` / `show added|raw` / `--version` / `reload` 只读或幂等；`allow` / `deny` / `delete` 的目标只能是端口、端口/协议、端口列表或应用配置名；
   - `nft`：表名必须 `kore_` 前缀（kore 自有命名空间），集合/链名限定语法，表达式 token 禁 `;`、引号、反引号、`$`、空白、换行，首字符不得是 `-`（挡掉 `-f <脚本>`）；
   - `ipset`：集合名必须 `kore_` 前缀，只允许 `create` / `add` / `del` / `test` / `list` / `destroy` 的固定形状；
   - `iptables` / `systemctl` / `docker` / `crontab`：**只读**（`-S`/`-L`、`is-active`/`status`/`show`/`cat`、`ps`/`inspect`/`logs`/`stats`、`-l`）——写规则、重启单元、`docker run|exec`、写 crontab 等于通用提权或 DoS，等有真实消费者时再按形状补齐并更新本 ADR；
   - `chmod` / `chown`：只允许三位八进制（**挡住 setuid/setgid/sticky 位**，`4755` 是四位，直接拒绝）且路径限定 `/etc/kore`、`/var/lib/kore`、`/var/log/kore`、`/run/kore`；
   - `resolvectl` / `unbound-control` / `dig`：只读查询 + 缓存刷新（`flush-caches` / `flush_zone` / `flush_bogus`），不提供 `set-dns`、`set_option`、`-f` 等改配置或读文件的入口；
   - `fail2ban-client`：只为 ssh-guard 0.2.x 已声明的三条动作开口，锁到 `status` / `set <jail> banip|unbanip` + IP 形状。
6. **协议向后兼容**：`RootCommandAllowlist` 保留为从形状表派生的只读视图（命令名集合），现有调用方与文档引用不破。
7. **`sed` 不再可用**：`/bin/sed` 既不在形状表内，绝对路径直通也已封堵。waf 的模式切换改为 nft 规则重装（观察 / 拦截两种规则集），不再有「任意表达式 + 任意文件」的写入口——见 `kore-plugin-waf@0.3.0` 的 `nft-*` 动作。

## 被否决的选项

| 选项 | 否决原因 |
| --- | --- |
| 维持「命令名白名单」 | 上表三个缺口全部成立；`ufw disable` / `nginx -s stop` 是现成的单动作 DoS |
| 只堵绝对路径直通，形状留给插件自查 | 插件的自查不是安全边界（插件进程本身可能已被攻破）；内核必须自己判 |
| 把 `sed` 收窄后用（固定文件 + 特定键替换） | 收窄仍要维护「sed 表达式 ⊆ 合法替换」的正则，等价于重写一个受限编辑器；直接去掉写入口更小、更可审计（审计里不再出现看不懂的表达式） |
| 让插件写脚本文件、动作只跑 `nft -f <固定路径>` | 脚本内容不受内核形状约束，审计只记「读了一个文件」；且**插件写文件本身就需要写权限**（降权后更不可行，见 ADR-0018 实现计划第 3 条） |
| 保留 `chmod 4755` 之类的「有需要再用」 | 四位八进制的最小合法用途也要 setuid，等于把提权通道变成后门工厂 |
| 用 shell 包装脚本（`sh -c`）承载批处理 | 等于放行任意 argv，回到 ADR-0018 明确否决的形态 |
| 靠 sudoers `NOPASSWD` 降级替代形状校验 | 那是另一条提权路径（ADR-0018 已列为降级方案，不是本 ADR 的替代） |

## 后果

- **破坏性**：任何使用未在形状表内的命令、或未受控子命令/参数的第三方插件，会在**安装/启用时**收到 `E_INVALID`（而不是运行期静默）。`requires_kore` 需要按发布节奏收窄；本仓内置插件（firewall 0.2.3、ssh-guard 0.2.1、waf 0.3.0）已逐条对齐。
- **SDK 滞后**：形状表在 `pkg/pluginapi`。插件要用公开 SDK 做 schema 自检，需要 `pkg/pluginapi` 发布含本 ADR 的版本（v0.1.3+）；在此之前，插件侧自检遇到「命令不在白名单」应显式 skip 并注明需要的内核/SDK 版本，不得手写一份宽松 schema。
- **审计可读性提升**：审计里的 argv 就是「要执行的完整语句」（nft 批处理可见规则原文），不再出现 `sed -i <表达式>` 这种不可判读的写操作。
- **后续扩展成本**：新增命令/子命令要改形状表 + 协议文档 + 本 ADR 的表格，属于安全边界变更，必须走 ADR。`nft add rule` 的表达式仍是「单 token 字符集」级约束（允许 `|`、`&`、`{}` 是因为 nft 表达式需要且 argv 不经 shell），**规则文本的安全门是「启用插件时用户确认清单」**，这一点必须写进插件上架评审。
- **未覆盖**：形状校验只约束「命令怎么被调用」，不约束「调用后宿主状态」——`nft add rule … drop` 仍能锁死宿主（这是 WAF 的正当能力，也是风险）。隔离验证与回滚要求见 `.agents/verify/r5-2-waf-nft.md`。

## 复审条件

- 出现需要写操作的第 4 个命令（例如 `systemctl restart` 的真实消费者），或需要放宽 `kore_` 命名空间；
- `nft` 表达式 token 形状被绕过（例如 nft 新版本引入新的读文件/执行语法）；
- 插件 SDK 提供等价（更严格）的声明期校验能力，可把形状表下移到 SDK 单点实现；
- 降权（ADR-0018 实现计划第 3 条）落地后，插件不再以 root 运行——届时仍需本 ADR 的形状表（通道的另一端仍是 uid=0）。
