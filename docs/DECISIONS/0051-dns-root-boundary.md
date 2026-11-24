> 状态: accepted · 归属: architect · 更新: 2026-11-24 · 里程碑: M5
> ADR 状态: accepted · 日期: 2026-11-24 · 决策者: lead · 关联: [0022-root-command-shapes](./0022-root-command-shapes.md)、[0018-privilege-model](./0018-privilege-model.md)、[0028-controlled-file-write](./0028-controlled-file-write.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md) §3.1.3、[dns README](../../../kore-plugin-dns/README.md)

# ADR-0051: DNS 的 root 边界——记录走 RFC 2136，zone 生命周期不扩形状表

## 0. 问题与结论

**要不要为 DNS 管理扩 ADR-0022 的形状表？结论：不扩（方案 A）**，本 ADR 只裁决与给计划，不改代码、不改 `pkg/pluginapi/rootpolicy.go`，也不修订 ADR-0022。

一句话逻辑：

- **记录级操作（增/删/改 A/AAAA/CNAME/MX/TXT/SRV）100% 由 RFC 2136 覆盖，零 root**，dns 插件 0.4.0 起已实现并带生效校验（`kore-plugin-dns/internal/dnsop/recordwrite.go:99`）。
- **zone 创建/删除本质是「改 named.conf 语义」**（区域文件路径、`allow-update`、`allow-transfer`、view、DNSSEC 策略），不是记录操作；它需要 root 或一个专门的特权原语，**RFC 2136 无法替代**。
- 形状表扩 `rndc` 只买到一个「少打一次 `sudo`」的便利；扩到能新建 zone 则必须引入 `rndc addzone` 的**不透明配置串**或**文件写原语**——前者是「argv 受控、语义不受控」，后者 ADR-0028 已单独裁决过，不该塞回命令表。
- 代价必须明说：**v1 面板不提供「新建 zone」按钮**；zone 生命周期由用户按面板生成的一次性命令完成（与 TSIG 密钥配置同属部署前置）。

## 1. 事实核查（先于设计）

> 核查方式：读本仓与 `kore-plugin-dns` 源码（带 `file:line`）+ BIND 9.20 官方文档。**本机没有运行中的 bind9 / `rndc` / `named-checkzone`**（`kore-plugin-dns/RELEASE-EVIDENCE.md:137`），因此「动态更新 → 立即生效」的代码路径有单测与脚本语法解析覆盖，但**没有端到端实机证据**；凡依赖实机的结论在下文标「未确认」。

### 1.1 `nsupdate` 能做什么（RFC 2136 的能力边界）

| 操作 | 能不能 | 依据 |
| --- | --- | --- |
| 增 / 改 / 删记录 | 能，且是三个独立语义 | `nsupdate.go:166-193` 生成 `server` + `zone` + `prereq` + `update add|delete` + `send`；`recordwrite.go:36-43` 三个方法共用一条写链路 |
| 一条消息里原子「先删后加」 | 能 | `nsupdate.go:175-181`：同一个 UPDATE 消息内 `update delete` 后紧跟 `update add` |
| 删除 name/type 的全部值 | 能（value 留空） | `nsupdate.go:182-189`；`recordwrite.go:42-43` 注释与实现一致 |
| **创建新 zone** | **不能** | RFC 2136 的 UPDATE 只作用于服务器**已权威**的区域；zone 必须先出现在 `named.conf`（或 `rndc addzone`）。BIND ARM §6.1 原文：动态更新是「adding, replacing, or deleting records in a primary server」，开闭由 `allow-update` / `update-policy` 控制；插件侧对应证据是失败分类把 `notzone` / `notauth` 映射成可操作错误（`nsupdate.go:257-283`） |
| **删除整个 zone** | **不能** | 同上；删 zone 只有 `rndc delzone` 或改配置后 reload（BIND `rndc(8)`：`delzone`；config 里的 zone 会随 reload/reconfig 回来） |
| 改 NS / SOA / PTR 等区域结构记录 | 插件**不开放** | `nsupdate.go:15-18` 白名单只有 `A/AAAA/CNAME/MX/TXT/SRV`；NS/SOA/PTR「改错会破坏整个区域」 |
| TTL / 多值 RRset | 能 | `nsupdate.go:174` 显式带 TTL；`maxPreviousRecords=10` 限制回滚规模（`nsupdate.go:20-22`） |

结论：**`nsupdate` = 记录级 CRUD，仅此而已；zone 生命周期不在协议里。**

### 1.2 动态更新后需要 `rndc reload` 吗？

**不需要。** 三条独立证据：

1. **官方文档**（BIND 9.20 ARM §6.1，[chapter6.html](https://bind9.readthedocs.io/en/stable/chapter6.html)）：更新立即作用于内存中的区域；服务器只是「occasionally dumps」整份区域回 zone 文件（因为每次更新都落盘太慢），关机/崩溃后靠 **journal（`.jnl`）重放**恢复。手工改动态区域文件才需要 `rndc freeze` / `thaw`（`rndc sync` 只用于「把 journal 同步进文件以便查看」）。
2. **插件行为**：写结果里 `ReloadRequired` 恒为 `false`（`recordwrite.go:76`），生效判定走**直连权威 `dig` 校验**（`recordwrite.go:368` `verifyWrite`；README `README.md:69`「`reload_required` 恒为 `false`」）。
3. **`dns.reload` 的定位**：README 明说它是「给手工改过 zone 文件或想看服务端确认的场景用的」（`README.md:84-85`）；bind9 分支在插件进程里直接跑 `rndc`（`write_engine.go:400-415`），拿不到 `rndc.key` 时返回 `E_NEED_ROOT` + `sudo` 提示。

需要 `rndc` 的真实场景只剩：改 zone 文件、改 `named.conf`、`rndc addzone/delzone` 之后让 named 看见变更（`rndc reconfig` 只加载**新** zone、不重读已有 zone 文件，BIND `rndc(8)` 原文）。**这些都是宿主配置动作，不是记录动作。**

### 1.3 TSIG key 怎么管理？插件能不能读？

- **生成**：`tsig-keygen kore-update > /etc/bind/kore-update.key`（插件 README 给的就是这条，`README.md:65`）。
- **权限**：`nsupdate -k <keyfile>` 以**插件自身用户**读密钥（`nsupdate.go:237-239` 固定 argv `-k <key> -p <port>`）；插件在装配写通道时 `ReadFile` 探测可读性（`recordwrite.go:249`），不可读直接 `E_INVALID` + 「chgrp + 0640，或复制到 `/var/lib/kore`」的 hint（`recordwrite.go:249-253`）。
- **路径白名单**：密钥只允许放在 `/etc/bind`、`/etc/dnsmasq.d`、`/var/lib/bind`、`/etc/dnsmasq.conf`、`/var/lib/kore`（`validate.go:92`、`validate.go:102`）。
- 因此：**密钥不是 root 依赖，而是一次性配置依赖**——`chgrp kore-dns` + `0640`，或放到插件自有目录。root 依赖出现在另一把钥匙上：`rndc.key` 是 named 的**控制通道**密钥，BIND `rndc(8)` 明确「contains shared secrets … should not have general read or write access」，默认只有 root 可读——这才是 `rndc` 必须 root 的原因。

### 1.4 `dns` 插件现在怎么用 RFC 2136？

| 事实 | 证据 |
| --- | --- |
| 11 个方法：`status/zones/records/query/record.add/record.update/record.delete/addRecord/updateRecord/deleteRecord/reload` | `internal/dnsop/call.go:15-17` |
| 写入按引擎分派：bind9 → RFC 2136；dnsmasq → 插件状态目录 hosts 片段；其余 `E_UNSUPPORTED` | `write_engine.go:46-56` |
| 写链路：快照 → journal intent → `nsupdate` → 直连 `dig` 校验 → 失败逆操作回滚 → journal result | `recordwrite.go:47-140` |
| 唯一声明的 root 动作：`resolved-flush-caches`（`/usr/bin/resolvectl flush-caches`，零追加参数） | `root.go:26-38`、`info.json:41-57` |
| 被形状表拒绝的动作（`rndc reload` / `rndc reconfig` / `named-checkzone` / 写 zone 文件）由测试钉住，防止偷偷声明 | `root_action_declaration_test.go:112-141` |

## 2. 「真正需要 root 的最小集合」

| # | 操作 | 需要 root？ | 依据 | 能否避免 | 避免方式 / 避免不了时的形状 |
| --- | --- | --- | --- | --- | --- |
| 1 | 记录增/删/改（已有 zone + TSIG） | **否** | `nsupdate` + TSIG，插件用户身份（`recordwrite.go:99`） | 已避免 | 无需形状；这是 0.4.0 起的既有能力 |
| 2 | 读 TSIG 密钥 | **否**（配置完成后） | `recordwrite.go:249` 以插件用户读 | 可避免 | `chgrp kore-dns` + `0640`，或放 `/var/lib/kore`（`validate.go:92`） |
| 3 | 列 zone / 读记录（解析 `/etc/bind`、`/var/lib/bind`） | **不必然**（取决于文件权限） | `zone.go:24`、`zone.go:192` 路径白名单 + 降级 | 可避免 | 文件 `0644`/目录 `0755`，或改用 `dns.query` 直查；插件已按「不可读 → `E_NEED_ROOT` + hint」披露，不冒充空列表 |
| 4 | **创建 zone** | **是** | zone 必须先进 `named.conf`（或 `rndc addzone`）才权威；UPDATE 对未声明区域返回 NOTZONE | **否**（stock BIND primary） | 一次性人工配置；若将来要面板化，最小形状是 `rndc reconfig`（零参数），见 §5.3 |
| 5 | **删除 zone** | **是** | `rndc delzone` / 改配置 + reload（BIND `rndc(8)`） | **否** | 同 #4；`delzone` 本身带 `-clean` 与视图参数，形状比 `reconfig` 宽，不纳入最小集 |
| 6 | 手工改 zone 文件后 reload | 是 | `rndc.key` 默认 root-only；动态区域本就不该手改（ARM §6.1 要求 freeze/thaw） | **可避免** | 不手改：记录一律走动态更新；`dns.reload` 只作诊断，失败给 `sudo` 命令 |
| 7 | `named-checkzone` 语法检查 | **否**（读插件自有文件时） | 它只是解析器，不需要特权；只有要读 root-only 目录时才受限 | 已避免 | **不应进形状表**（与任务初版假设不同） |
| 8 | 刷 systemd-resolved 缓存 | 是 | 缓存由系统服务持有，普通用户无权限 | 不能避免 | 已有形状 `resolvectl flush-caches`（唯一声明） |

**最小集合 = {zone 创建, zone 删除, 改宿主配置后的 reload}**，全部是**低频、一次性、改宿主配置语义**的动作；高频的记录操作一个都不在里面。

## 3. 裁决：A（不扩表）

### 3.1 理由

1. **能力覆盖率**：面板 DNS 页的日常动作是「看记录、加记录、改记录、删记录」，RFC 2136 全覆盖且零 root；唯一缺口（新建/删除 zone）是部署期动作，频率与「装 bind9、配 allow-update、生成 TSIG」同级。
2. **B（只加 `rndc reload`）买不到能力**：它不解决 zone 创建（`reload` 不加载新配置语义，新增 zone 要 `reconfig`/`addzone`），只把 `dns.reload` 从「要 sudo」变成「面板可点」。而动态更新**根本不需要 reload**（§1.2）——为一次诊断动作新增一条 root 命令、一次 ADR、一次 SDK 版本 + 三个插件仓的 `requires_kore` 收窄，收益与成本倒挂。
3. **C（完整扩表）的前提有两处不成立**：
   - `named-checkzone` 不需要 root（§2 #7），把它写进形状表是**把非特权动作特权化**，反而扩大审计面；
   - `rndc addzone <zone> <config-text>` 的第二个参数是「本应写在 `named.conf` 里的配置文本」（BIND `rndc(8)` 原文），里面有 `file` 路径、`allow-update` ACL、DNSSEC 策略——**形状只能正则一个字符串，无法界定其语义**。ADR-0022 自己写明「形状校验只约束命令怎么被调用，不约束调用后宿主状态」（`0022:59`），`addzone` 正是这句话的最坏形态：一个参数等于一次配置写入。
4. **写文件不必进命令表**：若走 `/var/lib/kore/dns` + 一次性 `include` 的方案，zone 文件由插件**在自己目录里以自身用户写**（零 root），只有 `rndc reconfig` 需要 root。也就是说 C 里「受控写文件」这一半是**多余的**；而 ADR-0028 已裁决过 `tee`/`install` 这类「半个原语」不可取（`0028:64`），不应借 DNS 之名回填。
5. **与既有产品口径一致**：dns 插件 README 已把「新建 zone」列为不支持并给出理由（`README.md:72`）；本裁决不是新增限制，而是确认既有边界并补上可执行的替代路径。

### 3.2 被否决项

| 选项 | 否决原因 |
| --- | --- |
| **B：只加 `rndc reload`（+ 可选 zone）** | 不解决 zone 创建；动态更新不需要 reload；为诊断便利扩大特权面，收益 < 成本（见 §3.1.2） |
| **C：`rndc` + `named-checkzone` + 受控写文件** | `named-checkzone` 非特权；`rndc addzone` 的配置串不可形状化；写文件有更小的替代（插件自有目录）且 ADR-0028 已否决命令表内写入（§3.1.3/4） |
| 加 `systemctl reload named|bind9` | `systemctl` 当前**全只读**（`rootpolicy.go:177-188`），开口等于允许重启任意单元的前奏；且语义比 `rndc reconfig` 更宽（重载整服务） |
| 加 sudoers `NOPASSWD: rndc` | 绕过形状表，等于第二条提权通道（ADR-0018 已列为降级方案） |
| 用 catalog zone（RFC 9432）实现零 root 建 zone | **只对 secondary 成立**：成员 zone 在 secondary 上自动创建，但「removing the member zone from the **primary** server must be done by editing the configuration file or running `rndc delzone`」（BIND ARM §6.8.1）。面板主机通常是 primary，故不构成替代路径；若将来管理 secondary 集群，这是正解 |
| 插件直接写 `/etc/bind` 或 `/var/lib/bind` | 零侵入红线（ADR-0023 §3.5 清单外写入 = 违规）+ 权限模型（插件降权后本就写不进） |
| 保留「以后可能有用」先加进表 | 与 ADR-0022 §58（`ipset` 无消费者即移除）、G-22（设计层优先）直接冲突 |

### 3.3 反方意见（必须记录的产品代价）

- 用户不能在面板里「一键新建 zone」，必须先手工/脚本完成 zone 声明。对「DNS 托管型」用户，这是真实体验缺口。
- 缓解：面板生成**可复制的完整命令块**（zone 声明 + `named-checkzone` + `rndc reload`，字段已填好），把「不知道写哪、怎么写」降为「复制粘贴一次」；这与 TSIG 配置、`allow-update` 配置同属部署前置，口径统一。
- **翻案条件**（写死，避免下次重新论证）：v1.1 若把「面板新建/删除 zone」列为能力域验收项，则**只加一条形状 `rndc reconfig`（零参数、无 Tail）** + `/var/lib/kore/dns` include 约定；不引入 `addzone`/`delzone`/文件写形状。届时按 §5.3 执行并新开 ADR 增补 0022。

## 4. ADR-0022 的设计意图：为什么只有 13 个命令

形状表**不是命令目录，而是「每条 root 语句的形状 + 一个真实消费者」的准入清单**。三条设计意图都能从 0022 自己的否决项读出来：

1. **准入判据是「有消费者 + 语义可界定」，不是「技术上能跑」**：`ipset` 未安装、无消费者 → 移除（`0022:58`）；`nft` 只放 WAF 真正要用的语句并锁 `kore_` 前缀（`0022:31`）；`fail2ban-client` 只为 ssh-guard 已声明的三条开口（`0022:35`）。所以表里出现 DNS 的 `resolvectl`/`unbound-control`/`dig`，是因为**当时 dns 的只读查询与缓存刷新有真实调用方**；`rndc` 当时没有消费者（记录写入已由 RFC 2136 解决），自然不在表内。
2. **「声明」本身是安全决策**：声明 argv 在安装/启用时展示给用户确认，用户看到的是「要执行的完整语句」；审计里也是同一句话。所以写操作必须小到人能读懂——`nft add rule … drop` 能锁死宿主是**被明确接受的残余风险**（`0022:59`），但没人愿意在确认框里看到一段 `named.conf` 片段。
3. **「方便以后扩展」被显式拒绝**：`sed` 收窄方案被否（等价于重写受限编辑器，`0022:45`）；「插件写脚本 + root 跑」被否（脚本内容不受形状约束，`0022:46`）；`sh -c` 被否（回到任意 argv）。**一旦为便利开口，白名单就退化成「我们跑过的命令清单」**——这是 13 个命令真正的含义。

**扩表会不会让形状校验失去意义？** 不会立刻失效（每条仍是逐位 `Literal`/`ArgShape`，未来新增子命令不会自动放行）；但会**稀释准入判据**，并把审计语义从「一条可判读的语句」降为「一段配置串」。对 `rndc` 而言，安全边界不是「有没有形状」，而是「形状能不能表达语义」——`reload [zone]` 能，`addzone <zone> <config-text>` 不能。这也是本 ADR 只接受「零参数命令」作为未来最小形状的原因。

## 5. 实施计划（A）

### 5.1 `dns` 插件（0.5.x，不改形状表、不改内核）

| # | 改动 | 验收 |
| --- | --- | --- |
| 1 | `dns.reload` 文案：bind9 引擎下明确「动态更新不需要 reload，本操作仅用于手工改过 zone 文件后」；失败 hint 保留 `sudo rndc reload [zone]` 原文 | 文案出现在方法说明与错误 hint；无新 root 动作 → `root_action_declaration_test.go:112-141` 不变即通过 |
| 2 | 「新建 zone」引导：`dns.zones` 未发现区域 / `E_NOTFOUND` 时输出可复制的四段命令（`zone` 块含 `allow-update { key "kore-update"; };`、`named-checkzone`、`rndc reload`、`dig` 验证），字段带示例值而非空模板 | 单测断言四段文本存在且 zone 名被填入；不新增方法、不新增入参 |
| 3 | 记录读取降级：zone 文件不可读时，除 `E_NEED_ROOT` + hint 外补两条替代（`chmod 0644` / 把 zone 放到 `/var/lib/kore/dns` 并 `include`） | 单测覆盖 `readable=false` 分支文案 |
| 4 | 文档：README「不支持新建 zone」补替代路径；`CHANGELOG` 记一条 | README 段落与 §5.1.2 命令一致 |

> 明确不做：不声明 `rndc`/`named-checkzone`/写文件动作；不改 `rootpolicy.go`；不引入 `/var/lib/kore/dns` include（属 §5.3 的翻案范围）。

### 5.2 验收口径

- 静态：`go test ./...`（dns 仓）+ `pluginapitest` 的 info.json 自检（`root_action_declaration_test.go` 全绿，且**没有新增** root_actions）。
- 端到端：本机无 bind9，**无法实机验收**；隔离实例验收挂起并标「未确认」，不得用单测冒充端到端（沿用 `RELEASE-EVIDENCE.md:137` 的诚实口径）。

### 5.3 若翻案：最小形状草案（未批准，仅登记）

只加 **`rndc reconfig`**（零参数，`Tail` 空，`MaxStatements: 1`，`writes_host: true`，`target: named.conf` 语义），**不加** `reload`/`addzone`/`delzone`/`freeze`/`thaw`：

- zone 声明与区域文件放 `/var/lib/kore/dns/`（插件自有目录，插件用户写，`0644`；TSIG 密钥单独 `0600` 子目录）；
- bind9 侧一次性 `include "/var/lib/kore/dns/named.conf.d/*.conf";`（部署前置，等同 TSIG 配置）；
- 面板新建 zone = 写声明 + 空区域文件 → `named-checkzone`（插件身份）→ `rndc reconfig` → `dig` 验证；
- 删除 zone：先删声明 → `rndc reconfig`；**`reconfig` 是否移除配置中已删除的 zone 未确认**（BIND `rndc(8)` 只写 "loads new zones"），翻案前必须实机验证，验不过就退回「删声明 + 用户手工 `rndc reload`」。

## 6. 复审条件

1. 产品把「面板新建/删除 zone」列入 v1.1 能力验收项（→ §5.3）；
2. 出现**第二个**需要 `rndc` 的真实消费者（例如 ssl 插件要触发 DNSSEC 重签），届时按形状逐条评估，而不是整包放行；
3. BIND 提供 primary 侧无需 `rndc` 的 zone 生命周期机制（catalog zone 仅 secondary，已排除）；
4. ADR-0028 二期把 `filewrite` 接到 root-action 且白名单扩展到 bind 配置目录——届时重新评估「写声明 + reconfig」是否比 `rndc` 形状更小；
5. 动态更新的端到端实机证据出现，且发现「必须 reload 才生效」的反例（当前所有证据都指向相反结论）。

## 7. 未确认 / 不在本 ADR 范围

- **未确认（环境）**：本机无 bind9，§1.2 的「立即生效」来自官方文档 + 单测 + 直连 `dig` 校验逻辑，**未经真实 bind9 端到端验证**。
- **未确认（语义）**：`rndc reconfig` 对「配置中已删除的 zone」是否移除；`rndc addzone` 的 zone 文件不存在时 named 是否自动创建（两者都只在 §5.3 翻案时才需要）。
- **不在范围**：`dnsmasq` 写片段（ADR-0023 零侵入下只写插件状态目录，生效需用户重启，与 root 无关）；`systemd-resolved` 缓存刷新（已有形状）。
