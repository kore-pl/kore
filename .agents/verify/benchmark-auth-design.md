# 对标研究：宝塔面板 / 1Panel 的「安装期凭据 · 登录会话 · 权限模型 · 忘记密码」

> 性质：只读对标研究，**不改代码、不安装、不起服务、不用 sudo**。
> 日期：2026-11-23 ｜ 被测版本：宝塔面板安装脚本（download.bt.cn/install/install_panel.sh，实时抓取）、1Panel **v2.5.1**（官方发行包 `1panel-v2.5.1-linux-amd64.tar.gz` 内的 `install.sh` / `1pctl` / `1panel-core.service`）
> 证据分级：`官方文档` / `安装脚本原文` / `二进制字符串` / `未确认`（**未在真机安装运行，因此所有"运行时行为"均不标为已实测**）

## 0. 取证方式与可信度说明

| 项 | 内容 |
| --- | --- |
| 宝塔证据源 | `https://docs.bt.cn/.../index.md`（官方 Markdown 源）+ `install_panel.sh` + `install/src/bt7.init`（`bt` 命令与 `bt default` 的实现脚本） |
| 1Panel 证据源 | 官方英文文档站 `https://1panel.pro/docs/v2/...` + 官方发行包内的 `install.sh`、`1pctl`、`1panel-core.service`、`1panel-core` |
| 取证障碍（如实记录） | 本机 DNS 把 `docs.bt.cn` / `1panel.cn` 解析到 `198.18.x.x`（fake-IP），`web_fetch` 判为内网地址直接拒；改用 shell `curl` 直连，1Panel 中文站返回 403，故 1Panel 侧以 `1panel.pro` 英文站 + 发行包原文为准 |
| kore 现状来源 | `docs/DECISIONS/0041-passwordless-server-admin.md`、`0042-privilege-without-prompt.md`、`docs/SECURITY.md`。**本次未复跑代码**；且 ADR-0041 §1.1 已自述"文档与实现存在偏差"，下表 kore 列按 ADR 记载标注，不当成已验证事实 |

> 关键前提：**kore 的现状是「本机免密 + 口令只用于远程」**（ADR-0041，用户产品级否决："需要我输入密码的设计肯定是不行的"）。下文"照抄/偏离"均以此为前提，不是把两家产品的口令模型整体搬过来。

---

## 1. 对照表

| 维度 | 宝塔面板（BT Panel） | 1Panel v2.5.1 | kore 现状（ADR/文档记载） | kore 应对齐做法 | 是否必须偏离及原因 |
| --- | --- | --- | --- | --- | --- |
| **1. 安装期凭据产生** | 随机生成，**不询问用户**：`password=$(cat /dev/urandom \| head -n 16 \| md5sum \| head -c 8)`（6 位 hex，8 字符）。仅 `-p/--password`、`-u/--user`、`--safe-path` 参数或 `PANEL_PASSWORD`/`PANEL_USER`/`SAFE_PATH` 环境变量可覆盖。安装过程只问 `(y/n)` 确认路径，**从不交互输入口令**（`安装脚本原文`） | 随机生成 10 字符，**交互式给默认值**：`DEFAULT_PASSWORD=$(… md5sum \| head -c 10)`；`设置面板密码 (<默认值>):` 后静默读取、逐字符回显 `*`，直接回车即接受随机值；非交互可用 `PANEL_PASSWORD` / `--password`（`安装脚本原文`） | `kored admin-password --generate/--set` 写 `auth.admin_password_hash`（PBKDF2 600k）；首启哈希为空时**只打印一行提示**，不读终端、不拦启动（`文档记载`） | 保留"**零交互、随机生成、绝不阻塞启动**"这条硬习语；`--generate` 的输出即"安装输出原文"，格式对齐两家（地址 + 凭据 + 一句"如何再次查看"） | **部分偏离**。照抄"随机 + 零交互 + 不阻塞安装"；偏离"把口令当默认登录入口"——kore 本机默认免密，口令只是远程访问的可选闸门 |
| **2. 打印位置 / 是否只显示一次** | 安装末尾统一打印：`面板地址（含安全入口）/ username / password`。同时明文写入 `/www/server/panel/default.pl` 并 `chmod 600`。`bt default` 可再查，但脚本明写：**"注意：初始密码仅在首次登录面板前能正确获取，其它时间请通过 bt 5 命令修改密码"**（`安装脚本原文`+`官方文档`） | 安装末尾打印：`外网/内网地址 + 安全入口 / PANEL_USER / PANEL_PASSWORD`；`install.log` 里的口令随后被替换成 `**********`；`1pctl` 里的 `ORIGINAL_PASSWORD` 也被 sed 改成掩码。**可随时** `1pctl user-info` 再取（`安装脚本原文`+`官方文档`） | 明文口令**只打印一次、永不进日志**；服务端只存哈希（`文档记载`） | 对齐"**一次性打印 + 日志与磁盘不留明文**"；`/system` 或首启提示里给一句等价于 `bt default` 的"如何再次查看"，避免用户装完就丢 | **必须偏离"落盘明文"**。宝塔 `default.pl` 明文 + `bt default` 再现，等于把口令长期放在磁盘上；1Panel 掩码做得比宝塔好，kore 应比两家都严——只存哈希 |
| **3. 用户名模型 / 单管理员** | 单面板账号，用户名可改（`bt 6` / 面板设置），安装时由 `tools.py` 生成/读取；**无多用户概念**（`官方文档`） | **明确单用户**："1Panel supports one user per host"；用户名安装期随机 10 字符，可 `1pctl update username`（`官方文档`+`安装脚本原文`） | 单管理员、**无用户名**（仅口令），且 G-11 明确"不做多用户 RBAC"（`文档记载`） | 照抄"**单管理员 + 可改凭据 + 无角色体系**"，并像 1Panel 一样**显式写进文档**（"每主机一个管理员"），省掉后续反复讨论 | **部分偏离**：不引入用户名。kore 单管理员下加用户名字段只增加登录表单字段与校验分支，无安全收益（口令即身份）；与 G-11 一致 |
| **4. 安全入口（隐藏路径）** | 有，且是主要防线之一：安装时 `auth_path=$(… md5sum \| head -c 8)`，写 `/www/server/panel/data/admin_path.pl`，访问 `http://IP:8888/<8位随机>`；`bt 28` 可改，`rm admin_path.pl` 可关（官方明确"关闭会使面板登录地址直接暴露，存在安全风险"）（`安装脚本原文`+`官方文档`） | 有：`Security Entrance`「Only allow login via a custom path」，安装期默认随机 10 字符，`1pctl reset entrance` 关闭（`官方文档`+`安装脚本原文`） | **没有**安全入口，路由固定 `/login`、`/api/v1/*`；防线是 UDS 0600 / 回环绑定 / CSRF / 限速（`文档记载`） | 只需要一条：**把"默认不暴露在公网"写死并可见**（默认 `127.0.0.1` 或 UDS + 远程访问需显式开启），等价收益、成本更低 | **必须偏离**。①安全入口是"靠路径不可猜"的隐蔽性防护，对已认证 API 无意义；②kore 默认不监听公网，隐蔽性收益≈0；③薄壳要为此改静态路由与文档，违反"少一个概念"的资源纪律 |
| **5. 登录表单字段** | 用户名 + 密码；另可叠加：BasicAuth（`bt 23`）、动态口令 2FA（`bt 24`）、访问设备验证（`bt 29`）、UA 验证（`bt 30`）、IP+UA 验证（`bt 11`）、PassKey（`官方文档`） | 用户名 + 密码；可选 MFA(TOTP)、Passkey、密码复杂度、密码过期天数、Allowed IPs、域名绑定（`官方文档`） | `POST /api/v1/auth/login` 只收 `{password}`；失败限速 60s/5 次锁 300s（`文档记载`） | 照抄"**登录成功 → 签发会话；失败 → 限速 + 审计**"这条主干；审计字段对齐两家（IP/UA/结果） | **必须偏离"多因子/多字段"家族**。kore 本机免密已消除登录面；再叠 2FA/Passkey/设备指纹只服务"远程单管理员"这一边缘场景，收益远低于复杂度，且 2FA 需要时钟/密钥存储 |
| **6. 会话有效期 / 续期** | **未确认**。官方文档与 `install_panel.sh`/`bt7.init` 均无会话 TTL、续期、Cookie 属性的任何说明 | 有明确设置项：`Session Timeout`「Auto-logout after **inactivity**（**minimum 300 seconds**）」→ 语义是**空闲超时**（滑动）；`session_timeout` 字段存在于二进制；`HttpOnly` 与 `SameSite=*` 字符串在二进制中存在但**无法归属到会话 Cookie**（`官方文档`+`二进制字符串`；具体属性 `未确认`） | 文档写 168h(7d) 滑动 + 30d 绝对上限、`HttpOnly`+`SameSite=Strict`；代码事实按 ADR-0041 是 **12h 固定、不续期、value 只有 expiry**（文档与实现不一致）（`文档记载`） | 对齐 **1Panel 的语义**：`空闲超时 + 绝对上限`，并给出可配置项与最小值；同时**先修 G-06 文档/代码偏差**（要么实现滑动，要么文档改成固定） | **对齐而非偏离**。唯一要偏离的是"**不得出现无上限的滑动**"——必须有绝对上限（kore 文档已有 30d，保留） |
| **7. Cookie 属性** | **未确认**（无公开文档；面板为闭源 Python 打包） | `HttpOnly` 存在；`Secure`/`SameSite` 具体取值 **未确认**（二进制含 `SameSite=Lax/None/Strict` 多值，属依赖库通用字符串） | `kore_session`：`HttpOnly; SameSite=Strict; Path=/; Max-Age`；`Secure` 由 `auth.cookie_secure=auto` 决定（回环/TLS 才置）；另有 `kore_csrf` 非 HttpOnly 双提交（`文档记载`） | 保持现状即可，这是 kore 比两家都**更可核对**的地方（属性在文档里逐条写明）；补齐"同站 XSS 可绕过双提交"的残余风险说明 | **不偏离**。这是 kore 已有优势，无需照抄任何东西 |
| **8. 面板运行身份** | **root**。`/etc/init.d/bt`（`bt7.init`）直接 `$panel_path/BT-Panel` 启动，无 `su`/降权；安装与 `bt` 命令均要求 root（官方 FAQ：**"若无权限执行宝塔命令 bt，需要先切换到 root 用户"**）；另建 `www` 用户仅供站点/PHP 使用（`安装脚本原文`+`官方文档`；真机 `ps` 未验证） | **root**。`1panel-core.service` 的 `[Service]` **不含 `User=`** → systemd 默认 root；安装脚本 `if [[ $EUID -ne 0 ]]` 强制 root（`安装脚本原文`） | ADR-0042 决策 B：`kore.service`（`User=root`）系统级运行；插件降权为 `kore-<id>` 独立进程（accepted）（`文档记载`） | 照抄"**面板本体以系统身份常驻 + 业务负载降权**"这个二分结构；并在安装期显式声明运行身份（`ps -o user= -C kored` 可核对） | **不偏离（结构一致）**。偏离点只在"降权对象"：宝塔降到 `www` 给站点，kore 降到 `kore-<id>` 给插件 |
| **9. 为什么系统操作不用再输密码** | 因为面板进程**就是 root**：无 sudo、无 polkit、无二次授权。`bt` CLI 亦然（`安装脚本原文`+`官方文档`） | 同上：root 常驻 + docker/系统调用直通；无 polkit 交互（`安装脚本原文`） | 同构：ADR-0042 明确"root 动作由 root 内核经 `systemd-run --uid=0` 发起，**不进入 polkit 判定**"；polkit 规则仅作降级路径 A（`文档记载`） | 照抄"**装完即可用，永远不弹本机口令框**"这一体验基准；把它写成可验证判据（`journalctl` 无 `polkitd ... FAILED to authenticate`） | **不偏离（且已达成）**。这条是 kore 与两家最大的共识点，应固化为验收项 |
| **10. 忘记密码 / 重置命令** | `bt 5`（改密码）、`bt 6`（改用户名）；Web 面板改账号/密码后**自动退出登录**（官方明确）。`bt 10` 清登录限制、`bt 13` 取消 IP 限制、`bt 24` 关 2FA（`官方文档`） | `1pctl update password` / `update username` / `update port`；被锁死时 `1pctl reset entrance/https/ips/mfa/domain`（`官方文档`） | `kored admin-password --generate/--set`；会话表另有 `password-fingerprint`，改口令后**全局吊销**（`文档记载`） | 照抄"**单条 CLI 子命令 + 子命令带 `--help` 分组**"（`1pctl update <field>` 形态），并保持"改凭据必吊销全部会话" | **部分偏离**：不设"重置后需要重启进程"这类隐式要求；吊销即时生效（kore 有 fingerprint 机制，比两家的"退出登录"更强） |
| **11. 绑定与访问控制** | 端口 `8888`（可改，建议 8888–65535）；IP 白名单（`bt 13`）、域名绑定（`bt 12`）、地区限制（`bt 19`）、IP+UA（`bt 11`）、设备验证（`bt 29`）；80/443 直连面板开关（`bt 32`）（`官方文档`） | `Listen Address`、`Allowed IPs`、`Domain Binding`、`Security Entrance`、`Unauthorized Response`（`官方文档`） | 默认 UDS（`0700` 目录 / socket `0600`）或 `127.0.0.1`；远程需显式配置（`文档记载`） | 照抄"**监听地址白名单 + 未授权响应可配**"两项；`Unauthorized Response` 对防指纹扫描有实际价值，成本极低 | **必须偏离"80/443 直连面板"与"改端口要同步放行防火墙"**：kore 不内置 web server（裁决37），且改宿主防火墙违反零侵入（G-31） |
| **12. TLS 来源** | 面板**默认开启 SSL，默认使用宝塔自签证书**；可换成自有域名证书；文档教用户把自签根证书装进系统信任（`官方文档`） | `Panel SSL`：**Enforce HTTPS**（是否默认自签 `未确认`；文档只写强制 HTTPS）（`官方文档`） | ADR-0020 走 ACME；本机回环场景 `auth.cookie_secure=auto`（`文档记载`） | 照抄"**默认安全 + 可换自有证书 + 提供下载根证书的引导**"；kore 用 ACME，比自签更进一步 | **不偏离**；但需在文档里明确"回环免密 + 非回环必须 TLS"，避免宝塔式"自签默认 + 浏览器告警"体验 |
| **13. 卸载 / 升级** | 升级：面板内一键更新或 `bt 34`；卸载：`wget bt-uninstall.sh && bash bt-uninstall.sh`，交互选 1（仅面板）/2（连环境），**破坏性操作需 root**（`官方文档`） | 升级：面板右下角 **Check for Updates**（在线升级）；卸载 `1pctl uninstall`；安装/操作均要求 root（`官方文档`+`安装脚本原文`） | `kored install/uninstall/upgrade` 子命令；systemd unit + enable 软链（ADR-0023 §3.5 豁免 #1）（`文档记载`） | 照抄"**升级在主界面一键 + CLI 兜底**"双通道；卸载给"只删本体 / 连数据一起删"两级确认（宝塔的两级用户选择值得照抄） | **部分偏离**：kore 卸载不得像宝塔那样清环境（无法也不该动宿主已装服务），只能动安装根内资产（零侵入 G-31） |

---

## 2. kore 应当直接照抄的 8 条（明确、可执行）

| # | 照抄内容 | 依据 / 出处 | 落到 kore 的具体动作 |
| --- | --- | --- | --- |
| 1 | **安装零交互 + 随机生成凭据 + 不阻塞启动** | `安装脚本原文`（宝塔 `PANEL_PASSWORD` 覆盖；1Panel `install.sh` 默认值回车即用） | 保持 `admin-password --generate` 为默认路径；**永不**在首启读 stdin |
| 2 | **装完打印一段"凭据卡片"**：访问地址 + 凭据 + 一句如何再次查看 | `安装脚本原文`+`官方文档`（宝塔打印"面板地址/username/password"；1Panel 打印内外网地址 + 用户 + 口令） | `kored install` 末尾对齐为三段：访问方式（UDS/TCP）、凭据状态（本机免密 / 远程未启用）、`kored admin-password --help` 提示 |
| 3 | **磁盘与日志不留明文口令** | `安装脚本原文`（1Panel 把 `install.log` 与 `1pctl` 里的口令 sed 成 `**********`） | 已有（只存 PBKDF2 哈希）；补一条门禁断言：日志中口令字段恒为掩码 |
| 4 | **单管理员模型并显式写进文档** | `官方文档`（1Panel："supports one user per host"；宝塔单面板账号） | 在 `docs/SECURITY.md` 用一句话钉死"单管理员、无用户名、无角色"，与 G-11 同口径 |
| 5 | **面板本体系统级常驻 + 业务负载降权** | `安装脚本原文`（宝塔 root 面板 + `www` 站点用户；1Panel unit 无 `User=`） | 已是 ADR-0042 形态；补齐"`ps -o user= -C kored` = root"为验收项 |
| 6 | **系统操作零二次授权（无 sudo/polkit 弹框）** | `安装脚本原文`+`官方文档`（两家均 root 直通） | 固化为验收：`journalctl` 无 `polkitd ... FAILED to authenticate`（ADR-0042 已有同款判据） |
| 7 | **忘记密码 = 单条 CLI 子命令，改凭据即吊销会话** | `官方文档`（`bt 5/6`、`1pctl update password`；宝塔 Web 改密后自动退出登录） | CLI 形态对齐 `1pctl update <field>` 分组（`username/password/port` 式），保留现有 fingerprint 全局吊销 |
| 8 | **空闲超时 + 绝对上限的会话语义（含最小值约束）** | `官方文档`（1Panel：`Session Timeout`，inactivity，min 300s） | 把 ADR-0041 §1.1 的文档/代码偏差收口：实现"空闲续期 + 30d 绝对上限"，并把"最小 300s"写进配置校验 |

## 3. kore 必须偏离的 6 条（含理由）

| # | 偏离对象 | 理由 | 依据 |
| --- | --- | --- | --- |
| 1 | **不做"默认需要输入口令登录"** | 用户产品级否决（"需要我输入密码的设计肯定是不行的"）；kore 本机 UDS 已是 Unix 权限边界 | ADR-0041 §0.1；两家产品均以口令为唯一入口，这是 kore 的**定位差异**，不是缺陷 |
| 2 | **不把明文初始口令落盘、不支持"再次回显明文"** | 宝塔 `default.pl` 明文 + `bt default` 再现 = 长期磁盘凭据；kore 只存哈希，丢失就重置 | `安装脚本原文`（`echo "$password" > …/default.pl`）对比 kore PBKDF2 哈希模型 |
| 3 | **不做安全入口（随机路径）作为登录防线** | 隐蔽性防护对已认证 API 无效；kore 默认不监听公网，收益≈0；薄壳为此增加静态路由与文档负担 | `官方文档`（两家均有）对比 kore 默认回环/UDS |
| 4 | **不引入 2FA / Passkey / 密码过期 / 密码复杂度 / 设备与 UA 验证** | 这些只服务"远程单管理员"边缘场景；需要时钟、密钥存储、额外字段校验，与资源预算和薄壳纪律冲突 | `官方文档`（宝塔 bt 23/24/29/30；1Panel MFA/Passkey/Password Expiration） |
| 5 | **不内置 web server、不允许 80/443 直连面板、不改宿主防火墙** | 裁决37（Web 服务器跟随站点插件）+ G-31 零侵入：改端口时同步放行防火墙是宿主机写入 | `官方文档`（宝塔 `bt 32` 开 80/443、改端口需放行；1Panel 提示 `netstat` 查占用） |
| 6 | **卸载只动安装根内资产，不清理宿主环境** | 宝塔卸载可选"连环境一起清"（会删 nginx/mysql/php）；kore 的插件与宿主服务归属使用者，内核无权代删 | `官方文档`（bt-uninstall.sh 选项 2）+ ADR-0023 零侵入 |

---

## 4. 未确认项（**没有查到就不编**）

| # | 未确认问题 | 已尝试的证据源 | 结论 |
| --- | --- | --- | --- |
| 1 | 宝塔面板**会话 TTL / 是否滑动 / 绝对上限** | docs.bt.cn 全站索引（`llms.txt` / `user-guide/config/*`）、`install_panel.sh`、`bt7.init` 全文 grep `session/cookie/有效期` 均无命中；面板为闭源 Python 打包，无法读源码 | **未确认** |
| 2 | 宝塔 `bt 5`（CLI 重置密码）后**已有会话是否立即失效** | 官方文档只写 Web 界面改密"会自动退出登录"，CLI 路径无说明 | **未确认**（仅 Web UI 路径有 `官方文档`） |
| 3 | 宝塔面板 Cookie 的 `HttpOnly / Secure / SameSite` 实际取值 | 无官方文档；闭源 | **未确认** |
| 4 | 1Panel 会话 Cookie 的 `SameSite` / `Secure` 具体取值 | 二进制含 `HttpOnly` 与 `SameSite=Lax/None/Strict` 多值（依赖库通用串），无法归属到会话 Cookie；不安装无法抓包 | **未确认**（仅 `HttpOnly` 存在可证） |
| 5 | 1Panel `1pctl update password` 后**是否吊销已有会话 / 是否重启服务** | 文档只列命令；`1pctl` 脚本对 `update` 是透传给 `1panel` 二进制，未在真机验证副作用 | **未确认** |
| 6 | 1Panel 面板 SSL 证书**默认是否自签** | `user_manual/settings` 只写 "Panel SSL: Enforce HTTPS"；未找到证书来源说明 | **未确认**（宝塔侧为 `官方文档` 明确的"默认自签"） |
| 7 | 宝塔面板进程实际运行身份（root）**真机 `ps` 佐证** | 仅从 `bt7.init`（直接 exec `BT-Panel`、无 `su`）+ 安装/CLI 要求 root 推断；按约束未安装故未 `ps` | **安装脚本原文推断**（非实测） |
| 8 | 宝塔面板是否**允许多个管理员账号** | 官方文档只描述单一"面板账号"的修改流程，无"新增账号/多用户"入口；但无明文声明 | 强推断为单账号，**声明层面未确认** |

---

## 5. 对 kore 的三条结论（一句话版）

1. **两家的"标准做法"在 kore 这里只有一半可搬**：可搬的是"零交互安装 + 一次性凭据卡片 + 系统级 root 常驻 + 单条 CLI 重置 + 空闲超时会话"；不可搬的是"口令为唯一入口"与"安全入口/多因子"这套以口令为中心的加固栈。
2. **kore 现状最需要动的不是"加功能"，而是"补偏差"**：会话 TTL 的文档（7d 滑动）与代码（12h 固定）不一致，这是 G-06 意义上的欠账；对标 1Panel 的"空闲超时 + 最小 300s"正好给了收口口径。
3. **kore 在这条链路上已有两处领先**：明文口令完全不落盘（比宝塔严）、改凭据全局吊销会话（比两家都强）。这两点应写进对标表并作为回归保护，而不是继续向外看。

---

## 附：本次引用的原始证据位置

| 证据 | 位置 |
| --- | --- |
| 宝塔安装脚本（凭据生成/落盘/打印） | `install_panel.sh`：`password=$(cat /dev/urandom \| head -n 16 \| md5sum \| head -c 8)`；`echo "${password}" > ${setup_path}/server/panel/default.pl`；`chmod 600`；打印块 `====================面板账户登录信息====================` |
| 宝塔 `bt default` 与"仅首次"提示 | `install/src/bt7.init`：`BT-Panel default info!` 分支，含 `注意：初始密码仅在首次登录面板前能正确获取，其它时间请通过 bt 5 命令修改密码` |
| 宝塔命令表 / 安全入口 / 卸载 | `https://docs.bt.cn/getting-started/bt-command-line-tool/`、`/faq/`、`/user-guide/config/common/panel-ssl/`、`/getting-started/uninstall-panel/` |
| 1Panel 安装脚本（随机 + 交互默认值 + 掩码） | `1panel-v2.5.1-linux-amd64/install.sh`：`DEFAULT_ENTRANCE/USERNAME/PASSWORD=$(… md5sum \| head -c 10)`；`sed -i -e "s#ORIGINAL_PASSWORD=.*#ORIGINAL_PASSWORD=${PASSWORD_MASK}#g" /usr/local/bin/1pctl`；`LOG_FILE` 中口令被替换为掩码 |
| 1Panel 运行身份 | `1panel-core.service`：`ExecStart=/usr/bin/1panel-core`，`[Service]` 段**无 `User=`** |
| 1Panel 会话/设置/CLI | `https://1panel.pro/docs/v2/user_manual/settings/`（Session Timeout min 300s、单用户、Allowed IPs、Domain Binding、Panel SSL）；`https://1panel.pro/docs/v2/installation/cli/`（`user-info`、`reset entrance/mfa/domain/https/ips`、`update username/password/port`） |
