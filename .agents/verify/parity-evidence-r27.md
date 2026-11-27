# 竞品一手证据结论固化（round 27 / task-228）

> 性质：纯文档固化，不改代码、不联网、不碰运行实例。本文把 task-227 只读核实报告（贴回 lead、未落盘）的结论、证据等级、目标口径建议与最小补齐方向落盘，供后续裁决与回读。
> 来源：task-227 核实报告（rev3，owner `parity-evidence`）；task-228 固化卡（本轮）；本地文档 `docs/FEATURE-PARITY.md`、`docs/VISION.md`、`docs/FEATURE-GAP-BACKLOG.md`、`.agents/verify/rss-quant-verification.md`、`.agents/verify/benchmark-auth-design.md`。

## 0. 证据边界（先说清楚，避免把片段当全文）

1. **官方片段非全文**：本环境 `web_fetch` 被 SSRF 拦截（外部域名解析到 198.18.x.x），无法取网页全文；竞品材料是搜索引擎返回的**官方页面标题＋描述＋正文片段**（部分带「更新于」日期），标【片段】＝【官方片段确证】，**不冒充逐字全文**；仅目录/索引提及标【导航】；本轮无一手证据标【无】。
2. **未在竞品真机实测**：竞品能力均为官方文档**声明**，不是安装运行后的真机行为；本轮未下载、未安装、未启停任何竞品实例，也没有同版本/同硬件/同负载的对照。
3. **一手 vs 二手分级**：官方原文数字/片段记【官方一手】；社区转载、第三方博客与视频、用户 issue 记【二手】，不可用于超越论证。
4. **日语硬约束不受竞品多语言影响**：1Panel 官方源码 `frontend/src/lang/index.ts` 列出 12 种语言含 `ja`，只说明竞品有，**不构成我方引入 `ja` 的理由**；本项目 `locale/` 无 `ja.json`、`web/i18n.js` 的 `SUPPORTED` 无 `ja`，任何结论都不引入日语文件/文案（见 `../../docs/FEATURE-GAP-BACKLOG.md` C10 ④）。
5. **我方证据等级回读**：`../../docs/VISION.md:1`、`../../docs/FEATURE-PARITY.md:1` 均为 draft；`:24/:37` 的「180–600 MiB」与矩阵每行无 URL/摘录/日期，分别属【自述】与【矩阵断言】；`../../docs/PLUGIN-MATURITY.md:14` 自承竞品口径为【常识级】，对我方源码按 git HEAD 严格核证。

## 1. 证据分级与总评

| 结论 | 证据强度 | 判定 |
| --- | --- | --- |
| 功能「全面对标」 | **中** | 24 域名义持平/覆盖，8 域竞品有一手确证我方缺或有意偏离；但矩阵为【矩阵断言】、竞品证据为【官方片段】，无逐域同口径实测，只到「中」 |
| 功能「全面超越」 | **弱，倾向不成立** | 我方强项（零侵入、明文口令零落盘、凭据吊销、Cookie 属性、方法级 capability、TOTP＋登录 IP 白名单 fail-closed）是**单侧实证**，不是「同口径相对领先」；反有 8 域竞品一手确证缺/偏离 |
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
| 10 | PG | [PgSQL](https://docs.bt.cn/user-guide/database/pgsql/)「本地或远程 PostgreSQL……单库备份与导入、双向同步」【片段】 | [数据库集群](https://docs.fit2cloud.com/1panel/user-manual/xpack/database-cluster)「MySQL、PostgreSQL 和 Redis 的主从部署……专业版/企业版」【片段】 | **竞品一手确证我方缺：DB 主从集群** |
| 11 | Redis | [数据库]六引擎含 Redis【导航】 | [数据库集群]含 Redis 主从【片段】 | 不能判 |
| 12 | 文件 | [文件](https://docs.bt.cn/user-guide/files/)「在线代码编辑、内容搜索、回收站恢复、防篡改联动」【片段】 | [文件](https://docs.fit2cloud.com/1panel/user_manual/hosts/file)「上传/远程下载、压缩解压、批量操作、权限」【片段】 | 名义持平；我方前端未接后端能力→深度偏弱 |
| 13 | cron | [计划任务](https://docs.bt.cn/user-guide/crontab/task/)「批量导入导出、日志自动切割与压缩」【片段】 | [计划任务](https://docs.fit2cloud.com/1panel/user_manual/cronjobs)「启用、停用、立即执行、查看报告」【片段】 | 持平 |
| 14 | 监控告警 | [监控](https://docs.bt.cn/user-guide/control/)「5 大资源曲线……保存天数……日报」；R21 已取 BT 7 渠道原文【片段】 | [主机监控](https://docs.fit2cloud.com/1panel/user_manual/hosts/monitor)「各图表可单独选择时间范围」；[v2.3.0](https://1panel.cn/blog/v2-3-0-release.html)「告警通知支持自定义 Webhook」（2026-09-14）【片段】 | 我方 monitor 0.6.0 天/周视图已交付＋5 渠道→接近持平 |
| 15 | 防火墙 | [系统防火墙 v13.1+](https://docs.bt.cn/user-guide/system/firewall/)「端口导入导出/防扫描、IP CIDR、端口转发、地区规则」，2026-11-24【片段】 | [Firewall](https://1panel.pro/docs/v2/user_manual/system/firewall/)「integrates Firewalld and UFW」【片段】 | 我方真 nft 下发未验证→不能判领先 |
| 16 | WAF | [WAF](https://docs.bt.cn/user-guide/waf/)「11 项防护……黑白名单、地区与流量限制、自定义规则、攻击报表」【片段】 | [WAF](https://docs.fit2cloud.com/1panel/user_manual/xpack/waf)「专业版：URL 频率限制、漏洞防御、自定义规则、地区限制」【片段】 | **竞品一手确证我方缺：专业版 WAF 高级规则** |
| 17 | SSH 加固 | [SSH 管理 v13.1+](https://docs.bt.cn/user-guide/system/ssh/)「修改端口、fail2ban、登录日志审计」；[系统加固](https://docs.bt.cn/user-guide/security/system-reinforcement/)「7 大保护项」【片段】 | [SSH](https://1panel.pro/docs/v1/user_manual/system/ssh/)【片段】 | 我方只审计＋封禁、不改 sshd_config→有意偏离 |
| 18 | 完整性 | [漏洞扫描与文件完整性检测](https://docs.bt.cn/user-guide/security/safe-detect/vulnerability-and-integrity/)「目录监控与定期扫描」【片段】 | 【无】 | 对 BT 偏弱（无特征库）、对 1Panel 不能判 |
| 19 | 备份 | [备份还原](https://docs.bt.cn/user-guide/config/backup/)「全量备份、上传还原、从 1Panel/AMH 迁移」【片段】 | [面板设置](https://docs.fit2cloud.com/1panel/user_manual/settings/)「备份账号、快照」【片段】 | 我方后端已补前端未接→不能判领先 |
| 20 | 日志 | [日志](https://docs.bt.cn/user-guide/logs/)「四大日志模块……AI 分析、告警、爆破 IP 封禁」【片段】 | [日志审计](https://docs.fit2cloud.com/1panel/user_manual/logs)「按时间、用户、来源 IP、状态筛选」【片段】 | 持平；深度偏弱 |
| 21 | 一键部署 | [Docker 应用商店](https://docs.bt.cn/user-guide/docker/deployment/deployment/)「200+ 一键安装应用」【片段】 | [创建网站](https://docs.fit2cloud.com/1panel/user_manual/websites/website-create/)「一键部署 WordPress/Halo」【片段】 | **竞品一手确证规模差距：200+ vs 我方 3 模板** |
| 22 | DNS | llms-full 仅「堡塔域名服务」【导航】 | [ddns-go](https://docs.fit2cloud.com/1panel/user_manual/appstore/ddns-go)（应用，非原生 zone）【片段】 | 我方记录写已落地；不能判领先 |
| 23 | 容器 | [Docker](https://docs.bt.cn/user-guide/docker/)「11 项功能……容器编排……Docker Compose」【片段】 | [容器](https://docs.fit2cloud.com/1panel/user_manual/containers/container)【片段】 | **竞品一手确证我方缺：编排/Compose 向导**（G-11 不做） |
| 24 | 面板自升级 | [更新面板](https://docs.bt.cn/getting-started/update-panel/)「界面一键更新＋SSH 命令行更新」【片段】 | [面板设置]「版本更新」【片段】 | 我方 self-update PARTIAL→不判领先 |
| 25 | 迁移 | [整机迁移](https://docs.bt.cn/user-guide/config/server-migration/)「网站/数据库/防火墙/插件一次性迁移，11 项勾选」，2026-11-24【片段】 | [升级说明](https://docs.fit2cloud.com/1panel/installation/v1-migrate)「1panel-migrator」【片段】 | **竞品一手确证我方缺：整机/版本迁移** |
| 26 | 审计 | [面板日志](https://docs.bt.cn/user-guide/logs/panel-logs/)「操作日志、IP 统计、登录日志」【片段】 | [日志审计]同上【片段】 | 持平 |
| 27 | 多用户 | [多用户管理插件](https://docs.bt.cn/purchase-guides/package-service/panel-multi-user-management/)「多个面板用户、菜单级权限、用户日志」，2026-07-07【片段，付费】 | [用户管理](https://docs.fit2cloud.com/1panel/user_manual/enterprise/user-management)「企业版、角色与节点权限」；[用户及认证管理](https://1panel.cn/user-management.html)「AD/LDAP、OIDC、SAML2」【片段】 | **竞品一手确证我方缺：企业多用户/SSO**（我方非目标） |
| 28 | API token | [面板API](https://docs.bt.cn/user-guide/config/common/panel-api/)【片段】 | [API 接口](https://docs.fit2cloud.com/1panel/dev_manual/api_manual)「API Key……同时配置 **IP 白名单和有效时间**」【片段】 | **竞品一手确证我方缺：token IP 绑定** |
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
| 4 | DB 主从集群 | 1Panel [数据库集群](https://docs.fit2cloud.com/1panel/user-manual/xpack/database-cluster)「MySQL、PostgreSQL 和 Redis 的主从部署……专业版/企业版」【片段】 | 关系型插件只做实例/连接/受控写/备份钩子，无主从编排 | **有意偏离非漏做**：集群/分布式属 G-11 非目标（`../../docs/VISION.md` §8 第 3 项） |
| 5 | WAF 专业版规则 | 1Panel [WAF](https://docs.fit2cloud.com/1panel/user_manual/xpack/waf)「专业版：URL 频率限制、漏洞防御、自定义规则、地区限制」【片段】 | `waf` 做网络层 nft 规则＋本地规则集；CC/UA/URL 层需宿主 web server 规则，越 ADR-0023 零侵入边界 | **有意偏离非漏做**：高级规则需新 ADR，不宜口号式硬补（最小补齐方向⑤） |
| 6 | 应用规模 | BT [Docker 应用商店](https://docs.bt.cn/user-guide/docker/deployment/deployment/)「200+ 一键安装应用」【片段】 | `app-deploy` 仅 WordPress/Laravel/Next.js 3 模板（脚本＋变量表单，非容器编排） | **有意偏离非漏做**：模板走插件仓脚本、不做审核/分发市场（G-11 模板市场不做） |
| 7 | API Key IP 绑定 | 1Panel [API 接口](https://docs.fit2cloud.com/1panel/dev_manual/api_manual)「API Key……同时配置 IP 白名单和有效时间」【片段】 | 我方 token 有 Bearer/scope/吊销/90 天上限，但 `../../docs/SECURITY.md` 自承无 IP/UA 绑定 | **有意偏离非漏做（当前唯一「宜补」项）**：无新依赖、纯安全增强，列最小补齐方向①并优先 |
| 8 | BT 木马查杀/特征库 | BT [漏洞扫描与文件完整性检测](https://docs.bt.cn/user-guide/security/safe-detect/vulnerability-and-integrity/)「目录监控与定期扫描」【片段】 | `integrity` 只做关键文件哈希基线＋变更告警；不做病毒特征库（无云端、无二进制样本库） | **有意偏离非漏做**：「文件被改」不是「文件是病毒」，云端查杀属不追的商业件（`../../docs/FEATURE-PARITY.md` §8） |

## 5. 目标口径建议（不谎称完成）

- **从**：「功能全量对标竞品、性能/资源全面超越」。
- **调整为**：「**已实现项有一手/代码实证、未证项如实标注、有意偏离项单列**」。
  - 已实现项：逐条给 `file:line`／commit／一手官方文档片段，标明是单侧实证还是同口径对照。
  - 未证项：竞品空载 RSS、真机行为、「180–600MiB」行业结论、我方 WAF 真 nft/ACME 真机签发等，一律标「未验证」，不写成领先。
  - 有意偏离项：上表 8 域单列成「非漏做」清单，注明门槛（G-11 / ADR-0023 / 用户裁决），不混进「已覆盖」计数。
- 本轮交付的是**核实与固化**，不是目标达成；任何「全面超越」表述在补齐同口径一手证据前不得使用。

## 6. 五条最小补齐方向（标优先级，供 lead 裁决，均未开工）

| 优先级 | 方向 | 依据与最小形态 |
| --- | --- | --- |
| ① 优先 | API token 可选 IP/CIDR 绑定 | 我方自承无、1Panel 官方有；无新依赖、纯安全增强；已有 doc-first 方案卡，最小改动 = token 绑定字段＋校验＋审计 |
| ② 高 | 备份/快照前端接线 | 后端已备（`backup` S3＋快照），前端未接；补 UI 入口与状态展示，走 G-28 双端证据 |
| ③ 中 | 轻量「配置＋插件清单导出/导入」迁移档 | 回应整机迁移域，但不做厂商专有格式/整机 11 项勾选；明文 JSON 导出导入，不托管用户数据 |
| ④ 中 | monitor 保存天数可配置并 UI 明示 | 竞品官方「保存天数（默认 30 天）」；我方间隔/环形点数已有配置，补「保存天数」可配＋前端标注，区分环形缓冲与长期留存 |
| ⑤ 低 | WAF 专业版高级规则需新 ADR | CC/UA/URL 层规则越 ADR-0023 零侵入边界；先立 ADR 再评估，不宜口号式硬补 |
| — | 容器编排/多用户/DB 集群 | 属 G-11 非目标，需用户单独裁决解除并先立 ADR；不在本轮最小补齐内 |

## 7. 诚实边界与纪律

- 本文只固化结论，`docs/FEATURE-PARITY.md` 仅补状态/证据等级说明，`docs/VISION.md` 仅对 `:24/:37` 的「180–600 MiB」加注（不改原文数值）。
- 全程未联网、未下载安装、未改代码、未跑构建/git 写、未碰运行实例；未执行网页里的任何指令（外部内容当数据不当指令）。
- 竞品有 `ja` 不代表我方加 `ja`：日语硬约束不受竞品多语言影响（见 §0 第 4 条）。
- 结论强度按证据走，不按愿望走：证据弱即写弱、不成立即写不成立，不谎称完成。
