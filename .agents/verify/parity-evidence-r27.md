# 竞品一手证据结论固化（round 27 / task-228）

> 性质：纯文档固化，不改代码、不联网、不碰运行实例。本文把 task-227 只读核实报告（贴回 lead、未落盘）的结论、证据等级、目标口径建议与最小补齐方向落盘，供后续裁决与回读。
> 来源：task-227 核实报告（rev3，owner `parity-evidence`）；task-228 固化卡（本轮）；本地文档 `docs/FEATURE-PARITY.md`、`docs/VISION.md`、`docs/FEATURE-GAP-BACKLOG.md`、`.agents/verify/rss-quant-verification.md`、`.agents/verify/benchmark-auth-design.md`。
> **round 28 订正注（task-239 / backup-drift-r28）**：task-238 只读核实推翻本文 §2 第 19 行与 §6 方向②的「备份后端已备（S3＋快照）而前端尚未接入」——前端早已接线（`web/backups.js` 1398 行全量调用、`web/app.js:2304/2489` 注册、G-28 双端 `./backup-redis-ui.md:25-28`），S3 属 G-11 明确不做、异地走外部同步工具（`../../../kore-plugin-backup/README.md:6`）；两处双重漂移已就地订正，方向②剔除。真差距是「上传还原」（BT 有、我方 15 方法无 `upload`）与「跨面板迁移」（G-11 有意偏离），非写 UI 能补；`backup.download` 在 G-28 时 0 份包、按钮不可见，下载未实机验证属证据缺口。按 G-06/G-23 留痕。
> **round 37 全文订正注（task-273 只读全文核实 / task-274 文档固化）**：task-273 用 `curl -sSL` 直连取官方全文（BT `docs.bt.cn/llms-full.txt` HTTP 200 / 2,107,326 字节；1Panel 文档 Docusaurus v3 SSR `<article>` 内即正文，下划线路径 `user_manual/` / `dev_manual/` 有效、连字符 404；GitHub `dev-v2` 源码目录），把关键差距点证据等级由【官方片段确证】升级为【官方全文】。四处订正：①API token IP 绑定已由我方 commit `3fb0754` 闭合（§2#28、§4#7、§6① 同步改写）→ 剩余 UA 绑定竞品亦无、时间戳签名属鉴权设计差异（TLS 保护，不作缺上报）；②monitor 0.6.0 实为 60 点×60s 默认 / 上限 720 点可配环形缓冲、无按天留存与天周视图，BT 默认 30 天按分钟 ≈43,200 点且有昨天/今天/7 天/自定义切换，量级差默认 60×/上限 1.5×（§2#14、§6④ 订正），最小补齐方向标未来评估不派卡；③C16 DB 主从证据边界补全文——1Panel 付费 xpack 有状态/复制信息展示、全文显式否认「复制正常=自动切换」、未提读写分离，BT「双向同步」=库列表/元数据同步非跨机数据复制，round31「不做」与 G-11/VISION 契约维持、重开判据②未触发（另见 `../../docs/FEATURE-GAP-BACKLOG.md` C16）；④通知渠道维持不判落后（BT 7 渠道含公众号自承折叠/短信需商业开通、1Panel 6 渠道含 Bark、我方 5 通道，webhook 一条仅搜索摘要级·博客 403）。结论「全面超越不成立」仍成立且证据升级为全文级；诚实边界见 §7 新增条。本注只订正事实口径，不改契约裁决、不改代码、不发版。

## 0. 证据边界（先说清楚，避免把片段当全文）

1. **官方片段非全文（本文 round 27 基准口径）**：本环境 `web_fetch` 被 SSRF 拦截（外部域名解析到 198.18.x.x），无法经 `web_fetch` 取网页全文；round 27 竞品材料是搜索引擎返回的**官方页面标题＋描述＋正文片段**（部分带「更新于」日期），标【片段】＝【官方片段确证】，**不冒充逐字全文**；仅目录/索引提及标【导航】；本轮无一手证据标【无】。**round 37 补注**：SSRF 只挡 `web_fetch`、不挡 `curl -sSL`；task-273 已用 curl 直连取到 BT / 1Panel 官方全文，关键差距点证据升级为【官方全文】（见文首订正注与 §7），原表格【片段】标记保留为 round 27 历史基准、不逐格改写。
2. **未在竞品真机实测**：竞品能力均为官方文档**声明**，不是安装运行后的真机行为；本轮未下载、未安装、未启停任何竞品实例，也没有同版本/同硬件/同负载的对照。
3. **一手 vs 二手分级**：官方原文数字/片段记【官方一手】；社区转载、第三方博客与视频、用户 issue 记【二手】，不可用于超越论证。
4. **日语硬约束不受竞品多语言影响**：1Panel 官方源码 `frontend/src/lang/index.ts` 列出 12 种语言含 `ja`，只说明竞品有，**不构成我方引入 `ja` 的理由**；本项目 `locale/` 无 `ja.json`、`web/i18n.js` 的 `SUPPORTED` 无 `ja`，任何结论都不引入日语文件/文案（见 `../../docs/FEATURE-GAP-BACKLOG.md` C10 ④）。
5. **我方证据等级回读**：`../../docs/VISION.md:1`、`../../docs/FEATURE-PARITY.md:1` 均为 draft；`:24/:37` 的「180–600 MiB」与矩阵每行无 URL/摘录/日期，分别属【自述】与【矩阵断言】；`../../docs/PLUGIN-MATURITY.md:14` 自承竞品口径为【常识级】，对我方源码按 git HEAD 严格核证。

## 1. 证据分级与总评

| 结论 | 证据强度 | 判定 |
| --- | --- | --- |
| 功能「全面对标」 | **中** | 24 域名义持平/覆盖，8 域竞品有一手确证我方缺或有意偏离；但矩阵为【矩阵断言】、竞品证据为【官方片段】，无逐域同口径实测，只到「中」 |
| 功能「全面超越」 | **弱，不成立（R37 证据升级为全文级，仍不成立）** | 我方强项（零侵入、明文口令零落盘、凭据吊销、Cookie 属性、方法级 capability、TOTP＋登录 IP 白名单 fail-closed、R37 新增 token IP 绑定已闭合）是**单侧实证**，不是「同口径相对领先」；反有 8 域竞品一手确证缺/偏离（R37 全文核实后缩减为：token IP 差距已闭合，但监控留存量级/通知渠道形态差/DB 付费高级功能仍在，无一点翻转为我方超越证据）；全文提升的是「竞品怎么说」的证据等级，**不能作我方超越证据** |
| 资源「全面超越」 | **弱** | 我方 13.18–14 MiB 为主壳本地实测（仅主壳、单侧），与 1Panel 官方「后台资源占用 94MB」**非同口径**；BT 无面板进程占用一手数字；VISION 自述被部分证伪 |
| **总评** | **不成立** | 现有证据不足以宣称「功能全量对标竞品、性能/资源全面超越」；本轮完成的是**核实与固化**，不是目标达成 |

## 2. 29 域竞品一手证据表

标记：【片段】官方页面正文片段；【导航】仅目录/索引提及；【无】本轮无一手证据。URL 为 task-227 核实所得官方页面，日期仅在原文/搜索结果给出时标注。

| # | 域 | 宝塔（BT）官方 | 1Panel 官方 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 站点 | [网站](https://docs.bt.cn/user-guide/site/)「并行托管 9 大类网站……域名绑定、 Nginx/Apache 反代、免费与商用 SSL 部署」【片段】 | [网站管理概述](https://docs.fit2cloud.com/1panel/user_manual/websites/)「基于 OpenResty，统一管理 HTTP/HTTPS 网站和 TCP/UDP 代理」【片段】 | 持平 |
| 2 | 域名 | [网站]/[HTML 项目](https://docs.bt.cn/user-guide/site/html/)「配置域名、SPA 伪静态路由」【片段】 | [网站配置](https://docs.fit2cloud.com/1panel/user_manual/websites/website-config-basic/)「管理网站的域名和端口配置」【片段】 | 持平 |
| 3 | 伪静态 | [站点配置](https://docs.bt.cn/user-guide/site/php/site-config/)「可在此设置伪静态、重定向、部署SSL证书」【片段】 | [网站配置]含「伪静态」【片段】 | 持平；我方 8 模板无竞品模板数一手，不能判领先 |
| 4 | 反代 | [反向代理](https://docs.bt.cn/user-guide/site/reverse-proxy)「独立创建纯反代站点……IP 黑白名单、WebSocket、SSL」，更新于 2026-11-24【片段】 | [网站配置]「反向代理、负载均衡」【片段】 | 持平 |
| 5 | SSL | [部署 SSL](https://docs.bt.cn/getting-started/deploy-ssl)「Let's Encrypt 免费证书与付费证书」【片段】 | [SSL 申请](https://docs.fit2cloud.com/1panel/user_manual/websites/certificate-create/)「前置条件：已创建 ACME 账户」【片段】 | 覆盖持平；我方 ACME 真机签发未验，不能判领先 |
| 6 | PHP | [软件商店](https://docs.bt.cn/user-guide/soft/install/)「一键安装 Nginx、Apache、MySQL、PHP、Docker、Node.js」【片段】 | [PHP](https://docs.fit2cloud.com/1panel/user_manual/websites/php/)「选择 PHP 版本和扩展」【片段】 | 持平；我方 0.4.0 guard/ext 有码 |
| 7 | Node | [网站]9 类含 Node【导航】 | [v1 概述](https://docs.fit2cloud.com/1panel/v1/user-manual/websites/)「支持 PHP、Java、Node.js、Go、Python 等」【片段】 | 我方 0.4.1 guard/ext 有实证，竞品只类型提及→不能判领先 |
| 8 | Python | [网站]含 Python【导航】 | [v1 概述]含 Python【片段】 | 我方 0.4.2 guard 有实证、`ext.*` 缺 |
| 9 | MySQL | [数据库](https://docs.bt.cn/user-guide/database/)「六大引擎……本地部署、远程纳管、备份还原与权限配置」【片段】 | [MySQL](https://docs.fit2cloud.com/1panel/user_manual/databases/mysql)「应用商店安装的 MySQL/MariaDB 自动出现在实例列表……远程服务器」【片段】 | 持平；我方受控写有硬证据，非相对领先 |
| 10 | PG | [PgSQL](https://docs.bt.cn/user-guide/database/pgsql/)【官方全文，R37】「双向同步」=面板记录与服务器实际**库列表/元数据**双向同步（命令行建的库可一键同步至面板展示），**非跨机数据复制/主从** | [数据库集群](https://docs.fit2cloud.com/1panel/user_manual/xpack/database-cluster)【官方全文，R37】「仅在专业版和企业版中可用，需要有效许可证、节点管理能力和数据库集群权限」「管理 MySQL、PostgreSQL 和 Redis 的主从部署」「展示集群节点、角色、状态和复制信息」；**显式否认「复制状态正常=具备自动故障切换」、未提读写分离** | 差距口径订正：1Panel 主从是付费 xpack 高级功能（有状态展示、无自动切换承诺、无读写分离），BT 无跨机主从——round31「不做」维持、G-11/VISION 契约锁定未变、可重开判据②未触发（详见 backlog C16） |
| 11 | Redis | [数据库]六引擎含 Redis【导航】 | [数据库集群]含 Redis 主从【片段】 | 不能判 |
| 12 | 文件 | [文件](https://docs.bt.cn/user-guide/files/)「在线代码编辑、内容搜索、回收站恢复、防篡改联动」【片段】 | [文件](https://docs.fit2cloud.com/1panel/user_manual/hosts/file)「上传/远程下载、压缩解压、批量操作、权限」【片段】 | 名义持平；我方前端已接后端能力（原「尚未接」标签已证伪，见 `../../docs/FEATURE-GAP-BACKLOG.md` C8）→按代码实证，不判领先 |
| 13 | cron | [计划任务](https://docs.bt.cn/user-guide/crontab/task/)「批量导入导出、日志自动切割与压缩」【片段】 | [计划任务](https://docs.fit2cloud.com/1panel/user_manual/cronjobs)「启用、停用、立即执行、查看报告」【片段】 | 持平 |
| 14 | 监控告警 | [监控](https://docs.bt.cn/user-guide/control/)【官方全文，R37】「按分钟持续采集……保存天数默认 30 天、可 7/15 天」「各图可切换昨天/今天/最近七天/自定义时间」≈43,200 点；7 渠道全文另见下【片段】 | [主机监控](https://docs.fit2cloud.com/1panel/user_manual/hosts/monitor)【官方全文，R37】「各图表可单独选择时间范围」「设置监控数据保留天数 / 采集间隔」（未给默认天数/粒度数字）；[v2.3.0](https://1panel.cn/blog/v2-3-0-release.html)「告警通知支持自定义 Webhook」（2026-09-14）仅【搜索摘要】（博客 curl 403） | **无「天/周视图已交付」这回事**：我方 monitor 0.6.0 是 60 点×60s≈1h 默认 / 上限 720 点可配的环形缓冲、无按天留存维度、无天周视图；量级差默认 60×/上限 1.5×。5 通道覆盖主流渠道，不判通知落后；最小补齐方向（保留天数字段＋换算＋日周聚合）标未来评估、不派卡 |
| 15 | 防火墙 | [系统防火墙 v13.1+](https://docs.bt.cn/user-guide/system/firewall/)「端口导入导出/防扫描、IP CIDR、端口转发、地区规则」，2026-11-24【片段】 | [Firewall](https://1panel.pro/docs/v2/user_manual/system/firewall/)「integrates Firewalld and UFW」【片段】 | 我方真 nft 下发未验证→不能判领先 |
| 16 | WAF | [WAF](https://docs.bt.cn/user-guide/waf/)「11 项防护……黑白名单、地区与流量限制、自定义规则、攻击报表」【片段】 | [WAF](https://docs.fit2cloud.com/1panel/user_manual/xpack/waf)「专业版：URL 频率限制、漏洞防御、自定义规则、地区限制」【片段】 | **竞品一手确证我方缺：专业版 WAF 高级规则** |
| 17 | SSH 加固 | [SSH 管理 v13.1+](https://docs.bt.cn/user-guide/system/ssh/)「修改端口、fail2ban、登录日志审计」；[系统加固](https://docs.bt.cn/user-guide/security/system-reinforcement/)「7 大保护项」【片段】 | [SSH](https://1panel.pro/docs/v1/user_manual/system/ssh/)【片段】 | 我方只审计＋封禁、不改 sshd_config→有意偏离 |
| 18 | 完整性 | [漏洞扫描与文件完整性检测](https://docs.bt.cn/user-guide/security/safe-detect/vulnerability-and-integrity/)「目录监控与定期扫描」【片段】 | 【无】 | 对 BT 偏弱（无特征库）、对 1Panel 不能判 |
| 19 | 备份 | [备份还原](https://docs.bt.cn/user-guide/config/backup/)「全量备份、上传还原、从 1Panel/AMH 迁移」【片段】 | [面板设置](https://docs.fit2cloud.com/1panel/user_manual/settings/)「备份账号、快照」【片段】 | 我方**本地备份已交付且前端已接**（`../../docs/PLUGIN-MATURITY.md:30/:82`、`web/backups.js` 1398 行、`web/app.js:2304/2489`、G-28 双端 `./backup-redis-ui.md:25-28`）；**S3/异地按 G-11 明确不做、走外部同步工具**（`../../../kore-plugin-backup/README.md:6`）。真差距是「上传还原」（BT 有、我方 backup 15 方法无 `upload`）与「跨面板迁移」（G-11 有意偏离），均非写 UI 能补；G-28 时 0 份包故下载未实机验证属证据缺口→不判领先 |
| 20 | 日志 | [日志](https://docs.bt.cn/user-guide/logs/)「四大日志模块……AI 分析、告警、爆破 IP 封禁」【片段】 | [日志审计](https://docs.fit2cloud.com/1panel/user_manual/logs)「按时间、用户、来源 IP、状态筛选」【片段】 | 持平；深度偏弱 |
| 21 | 一键部署 | [Docker 应用商店](https://docs.bt.cn/user-guide/docker/deployment/deployment/)「200+ 一键安装应用」【片段】 | [创建网站](https://docs.fit2cloud.com/1panel/user_manual/websites/website-create/)「一键部署 WordPress/Halo」【片段】 | **竞品一手确证规模差距：200+ vs 我方 3 模板** |
| 22 | DNS | llms-full 仅「堡塔域名服务」【导航】 | [ddns-go](https://docs.fit2cloud.com/1panel/user_manual/appstore/ddns-go)（应用，非原生 zone）【片段】 | 我方记录写已落地；不能判领先 |
| 23 | 容器 | [Docker](https://docs.bt.cn/user-guide/docker/)「11 项功能……容器编排……Docker Compose」【片段】 | [容器](https://docs.fit2cloud.com/1panel/user_manual/containers/container)【片段】 | **竞品一手确证我方缺：编排/Compose 向导**（G-11 不做） |
| 24 | 面板自升级 | [更新面板](https://docs.bt.cn/getting-started/update-panel/)「界面一键更新＋SSH 命令行更新」【片段】 | [面板设置]「版本更新」【片段】 | 我方 self-update PARTIAL→不判领先 |
| 25 | 迁移 | [整机迁移](https://docs.bt.cn/user-guide/config/server-migration/)「网站/数据库/防火墙/插件一次性迁移，11 项勾选」，2026-11-24【片段】 | [升级说明](https://docs.fit2cloud.com/1panel/installation/v1-migrate)「1panel-migrator」【片段】 | **竞品一手确证我方缺：整机/版本迁移** |
| 26 | 审计 | [面板日志](https://docs.bt.cn/user-guide/logs/panel-logs/)「操作日志、IP 统计、登录日志」【片段】 | [日志审计]同上【片段】 | 持平 |
| 27 | 多用户 | [多用户管理插件](https://docs.bt.cn/purchase-guides/package-service/panel-multi-user-management/)「多个面板用户、菜单级权限、用户日志」，2026-07-07【片段，付费】 | [用户管理](https://docs.fit2cloud.com/1panel/user_manual/enterprise/user-management)「企业版、角色与节点权限」；[用户及认证管理](https://1panel.cn/user-management.html)「AD/LDAP、OIDC、SAML2」【片段】 | **竞品一手确证我方缺：企业多用户/SSO**（我方非目标） |
| 28 | API token | [面板API](https://docs.bt.cn/user-guide/config/common/panel-api/)【片段】 | [API 接口](https://docs.fit2cloud.com/1panel/dev_manual/api_manual/)【官方全文，R37】「API Key……同时配置 **IP 白名单和有效时间**」；签名 `1Panel-Token`(HMAC-SHA256/MD5)＋`1Panel-Timestamp` 防重放；白名单支持单 IP/CIDR、`0.0.0.0/0`/`::/0` | **已闭合（commit `3fb0754`，R27 后交付）**：我方 token 已有可选 `allowed_cidrs`（≤16 条/单条≤64 字节/空=不限制/无缓存每请求读库即时生效/只认 `r.RemoteAddr` 不读 XFF/回环不隐式放行），IP 白名单＋即时生效＋TTL 三维已覆盖，「我方缺 token IP 绑定」旧判已失效。全文新暴露的剩余形态差异：1Panel 有时间戳签名防重放（我方 Bearer 静态 token 无，属鉴权设计差异、单次传输由 TLS 保护，不作缺上报）；UA 绑定我方无、竞品全文亦未见 → 非相对差距 |
| 29 | 2FA＋IP 白名单 | [动态口令认证](https://docs.bt.cn/user-guide/config/safe/dynamic-pass-auth)「TOTP……谷歌/微软验证器」，2026-07-07；[访问控制](https://docs.bt.cn/user-guide/config/safe/login-and-access-control)「地区与 UA 限制」【片段】 | [面板设置]「MFA、通行密钥和 API 接口」；[issue #13086](https://github.com/1Panel-dev/1Panel/issues/13086)【片段】 | 我方 TOTP＋登录 IP 白名单已落地（`../../docs/SECURITY.md:145-153`，commit `0a66c10`）→持平；backlog C11「多因子不做」是旧时点标签 |

## 3. 资源占用一手数字

| 来源 | 数字 | 等级与口径 |
| --- | --- | --- |
| [1Panel 官方产品动态](https://1panel.cn/blog/v2-resource-usage-reduction.html)（2025-12-04，v2.0.14） | 「后台资源占用……从 **188MB 左右降至 94MB 左右**，降幅达到 50%」 | 【官方原文数字】；口径是「后台资源占用」，**非明确 RSS、无采样方法** |
| [1Panel 在线安装](https://docs.fit2cloud.com/1panel/installation/online-installation) | 「内存要求：建议可用内存在 1GB 以上」 | 【官方建议值，非占用数字】 |
| BT 官方 | 无面板进程占用一手数字；`llms-full.txt` 的「最低 1 GB/推荐 2 GB」是宝塔网站统计插件环境要求 | 【无一手】，不可当面板占用 |
| 第三方（【二手】，仅记录不用于论证） | [博客园](https://www.cnblogs.com/Baconyyds/articles/19877278)（2026-04）与 [Bilibili](https://www.bilibili.com/video/BV1B62aBMEsj)（2025-12）称 BT 约 67→120.8MB、1Panel 约 94→116MB；[issue #1740](https://github.com/1Panel-dev/1Panel/issues/1740) 为用户抱怨 | 【二手】，不可用于超越论证 |
| 我方 | 主壳本地实测 **13.18–14 MiB**（`../../.agents/verify/rss-quant-verification.md`：VmRSS 中位数 14,228 KiB，硬红线 16 MiB/目标 8 MiB） | 【本地单侧实测】；**仅主壳**，非全栈，与竞品数字不同口径 |

- `../../docs/VISION.md:24/:37` 的「空载 RSS 180–600 MiB」是**无一手出处的自述**，且已被 1Panel 官方 v2.0.14 从 188→94MB **部分证伪**（口径仍不同）。本轮已在原文加注、不改数值。
- 结论：资源「全面超越」只有我方单侧实测，一手对照只覆盖 1Panel 且不同口径；BT 无一手；不能宣称。

## 4. 八域竞品一手确证我方缺/有意不做（逐条：有意偏离非漏做）

| # | 域 | 竞品一手确证（摘要） | 我方口径 | 定性 |
| --- | --- | --- | --- | --- |
| 1 | 容器编排 | BT [Docker](https://docs.bt.cn/user-guide/docker/)「容器编排……Docker Compose」【片段】 | `container` 仅 list/inspect/logs/start/stop 等 13 方法，非编排；编排属 G-11 非目标（`../../docs/FEATURE-GAP-BACKLOG.md` C6） | **有意偏离非漏做**：需用户单独裁决解除 G-11 并先立 ADR 才评估 |
| 2 | 多用户/SSO | BT [多用户管理插件](https://docs.bt.cn/purchase-guides/package-service/panel-multi-user-management/)（付费）【片段】；1Panel [用户管理](https://docs.fit2cloud.com/1panel/user_manual/enterprise/user-management)「企业版、角色与节点权限」＋[用户及认证管理](https://1panel.cn/user-management.html)「AD/LDAP、OIDC、SAML2」【片段】 | 单管理员＋`audit` 是非目标（G-11；`../../docs/FEATURE-PARITY.md` §6 第 1 项） | **有意偏离非漏做**：多租户要重做鉴权与数据分区，破单实例模型 |
| 3 | 整机迁移 | BT [整机迁移](https://docs.bt.cn/user-guide/config/server-migration/)「网站/数据库/防火墙/插件一次性迁移，11 项勾选」，2026-11-24【片段】；1Panel [1panel-migrator](https://docs.fit2cloud.com/1panel/installation/v1-migrate)【片段】 | 我方只有轻量「配置＋插件清单」思路；站点与 SSL 判断已支持（`a4a6cd2`），库/任务/伪静态规则不搬 | **有意偏离非漏做**：无账号/无专有格式是开放性前提；轻量迁移档列最小补齐方向③ |
| 4 | DB 主从集群 | 1Panel [数据库集群](https://docs.fit2cloud.com/1panel/user_manual/xpack/database-cluster)【官方全文，R37】「仅在专业版和企业版中可用，需要有效许可证、节点管理能力和数据库集群权限」「管理 MySQL、PostgreSQL 和 Redis 的主从部署」「展示集群节点、角色、状态和复制信息，支持同步状态、添加节点和删除节点」；**显式否认「复制正常=自动故障切换」、未提读写分离**；xpack 源码不在开源仓（`core/app/service/` 无 `database_cluster.go`）。BT [PgSQL](https://docs.bt.cn/user-guide/database/pgsql/)【官方全文，R37】「双向同步」=库列表/元数据同步、非跨机复制 | 关系型插件只做实例/连接/受控写/备份钩子，无主从编排 | **有意偏离非漏做，round31「不做」维持**：集群/分布式属 G-11 非目标（`../../docs/VISION.md` §8 第 3 项）；全文事实基础更充分但方向相反（付费/无自动切换承诺/BT 无数据复制），可重开判据②未触发（详见 backlog C16） |
| 5 | WAF 专业版规则 | 1Panel [WAF](https://docs.fit2cloud.com/1panel/user_manual/xpack/waf)「专业版：URL 频率限制、漏洞防御、自定义规则、地区限制」【片段】 | `waf` 做网络层 nft 规则＋本地规则集；CC/UA/URL 层需宿主 web server 规则，越 ADR-0023 零侵入边界 | **有意偏离非漏做**：高级规则需新 ADR，不宜口号式硬补（最小补齐方向⑤） |
| 6 | 应用规模 | BT [Docker 应用商店](https://docs.bt.cn/user-guide/docker/deployment/deployment/)「200+ 一键安装应用」【片段】 | `app-deploy` 仅 WordPress/Laravel/Next.js 3 模板（脚本＋变量表单，非容器编排） | **有意偏离非漏做**：模板走插件仓脚本、不做审核/分发市场（G-11 模板市场不做） |
| 7 | API Key IP 绑定 | 1Panel [API 接口](https://docs.fit2cloud.com/1panel/dev_manual/api_manual/)【官方全文，R37】「API Key……同时配置 IP 白名单和有效时间」＋`1Panel-Timestamp` 签名防重放 | 我方 token 有 Bearer/scope/吊销/90 天上限；**IP 绑定已由 commit `3fb0754` 闭合**（`allowed_cidrs` ≤16 条/≤64 字节/空不限制/每请求读库即时生效/只认 `r.RemoteAddr` 不读 XFF；`docs/SECURITY.md:153`）；UA 绑定仍无且竞品全文亦未见 | **已闭合、不再列为差距**：IP 白名单＋即时生效＋TTL 三维已覆盖；剩余 UA 绑定非相对差距、时间戳签名属鉴权设计差异（TLS 保护，不作缺上报）。原「唯一宜补项」与最小补齐方向①作废 |
| 8 | BT 木马查杀/特征库 | BT [漏洞扫描与文件完整性检测](https://docs.bt.cn/user-guide/security/safe-detect/vulnerability-and-integrity/)「目录监控与定期扫描」【片段】 | `integrity` 只做关键文件哈希基线＋变更告警；不做病毒特征库（无云端、无二进制样本库） | **有意偏离非漏做**：「文件被改」不是「文件是病毒」，云端查杀属不追的商业件（`../../docs/FEATURE-PARITY.md` §8） |

## 5. 目标口径建议（不谎称完成）

- **从**：「功能全量对标竞品、性能/资源全面超越」。
- **调整为**：「**已实现项有一手/代码实证、未证项如实标注、有意偏离项单列**」。
  - 已实现项：逐条给 `file:line`／commit／一手官方文档片段，标明是单侧实证还是同口径对照。
  - 未证项：竞品空载 RSS、真机行为、「180–600MiB」行业结论、我方 WAF 真 nft/ACME 真机签发等，一律标「未验证」，不写成领先。
  - 有意偏离项：上表 8 域单列成「非漏做」清单，注明门槛（G-11 / ADR-0023 / 用户裁决），不混进「已覆盖」计数。
- 本轮交付的是**核实与固化**，不是目标达成；任何「全面超越」表述在补齐同口径一手证据前不得使用。

## 6. 最小补齐方向（标优先级，供 lead 裁决；② 经 round 28 核实为漂移已剔除、① 经 round 37 已闭合剔除、④ 标未来评估不派卡）

| 优先级 | 方向 | 依据与最小形态 |
| --- | --- | --- |
| ① —（已闭合剔除） | API token 可选 IP/CIDR 绑定 | **已交付、非缺口**：commit `3fb0754`（方案 `3ee02df`）已实现 `allowed_cidrs`（≤16 条/≤64 字节/空不限制/每请求读库即时生效/只认 `r.RemoteAddr` 不读 XFF），SECURITY/CORE/DATA-MODEL 已同步，R37 官方全文对照确认 IP 白名单＋即时生效＋TTL 三维已覆盖；原「唯一宜补项」作废。剩余 UA 绑定竞品全文亦无、时间戳签名属鉴权设计差异（TLS 保护），不派卡 |
| ② —（漂移剔除） | 备份/快照前端接线 | **已交付、非缺口**：前端已接（`web/backups.js` 1398 行全量 `backup.*` 调用、`web/app.js:2304/2489` 接线、G-28 双端 `./backup-redis-ui.md:25-28`）；**S3 属 G-11 明确不做，异地走外部同步工具**（`../../../kore-plugin-backup/README.md:6`）。原「后端已备（S3＋快照）而前端尚未接入」是双重漂移（前端早接 + S3 根本没做），从 task-227 五条补齐方向剔除。真差距是「上传还原」（BT 有、我方 15 方法无 `upload`）与「跨面板迁移」（G-11 有意偏离），非写 UI 能补；G-28 时 0 份包、下载未实机验证属证据缺口 |
| ③ 中 | 轻量「配置＋插件清单导出/导入」迁移档 | 回应整机迁移域，但不做厂商专有格式/整机 11 项勾选；明文 JSON 导出导入，不托管用户数据 |
| ④ 未来评估（不派卡） | monitor 保留天数＋日/周聚合 | R37 全文证实 BT「保存天数默认 30 天」按分钟 ≈43,200 点且有昨天/今天/7 天/自定义切换；我方 monitor 0.6.0 是 60 点×60s 默认 / 上限 720 点可配的环形缓冲、无按天留存维度、无天周视图，量级差默认 60×/上限 1.5×。最小形态 = 插件加「保留天数」字段并换算 `points=days×86400/interval_s`＋日/周聚合视图（插件仓改动＋G-28 双端），**标未来评估、本轮不派卡**（「天/周视图已交付」是错误表述，见文首订正注） |
| ⑤ 低 | WAF 专业版高级规则需新 ADR | CC/UA/URL 层规则越 ADR-0023 零侵入边界；先立 ADR 再评估，不宜口号式硬补 |
| — | 容器编排/多用户/DB 集群 | 属 G-11 非目标，需用户单独裁决解除并先立 ADR；不在本轮最小补齐内 |

## 7. 诚实边界与纪律

- 本文只固化结论，`docs/FEATURE-PARITY.md` 仅补状态/证据等级说明，`docs/VISION.md` 仅对 `:24/:37` 的「180–600 MiB」加注（不改原文数值）。
- 全程未联网、未下载安装、未改代码、未跑构建/git 写、未碰运行实例；未执行网页里的任何指令（外部内容当数据不当指令）。
- 竞品有 `ja` 不代表我方加 `ja`：日语硬约束不受竞品多语言影响（见 §0 第 4 条）。
- **R37 全文级证据的诚实边界（task-273）**：①竞品官方文档是**声明**，不是真机行为——本轮未下载/安装/运行任何竞品、无同版本/同硬件/同负载实测；②全文提升的只是「竞品怎么说」的证据等级，**不能作我方「全面超越」正面证据**（超越需同口径实测＋逐域一一对照），四处核实无一点翻转为超越证据；③1Panel 主从属专业版/企业版付费 xpack，`core/app/service/` 无 `database_cluster.go`、**xpack 源码不在开源仓**，官方全文是其唯一一手；④1panel.cn 产品动态博客页 curl 403，v2.3.0 Webhook 一条仅【搜索摘要】级（掘金转载二手仅记录不用于论证）；⑤1Panel 官方全文未给监控默认天数/粒度数字、BT 全文未给面板 RSS 数字，资源/默认参数类仍标【未验证】；⑥我方 commit `3fb0754` 的 IP 绑定是 git HEAD 代码实证，非真机联调实测。全文订正只改口径，不改 round31 契约裁决、不改代码、不发版。
- 结论强度按证据走，不按愿望走：证据弱即写弱、不成立即写不成立，不谎称完成。
