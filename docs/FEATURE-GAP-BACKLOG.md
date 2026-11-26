> 状态: draft · 归属: gap-backlog · 更新: 2026-11-26 · 里程碑: M5
> 依据: task-120「全量竞品对标核实报告」的结论（报告本身未落盘，本文件由执行者按本地 file:line 逐条回读重建）
> 性质: 纯文档工作底稿（doc-first）；只规划不实现，不改代码、不联网、不重新部署

# FEATURE-GAP-BACKLOG — 全量竞品对标差距与分期补齐底稿

用户裁决：**「全部形成文档，然后逐步进行」**。本文件把 task-120 的核实结论固化成可逐项推进的工作底稿：先定证据纪律（§1），再列真实差距 C1–C15（§2）与 kore 领先项 D1–D9（§3），给出四期路线（§4），最后写明诚实边界（§5）。后续每完成一项，把新证据回写本文件对应条目，不另建平行清单。

## 1. 证据纪律

竞品侧材料的可信度不同，不能把 draft 矩阵、常识描述或自评当作原文实测；本地材料内部还有冲突，冲突项一律不判定。

| 级别 | 来源与证据 | 使用边界 |
| --- | --- | --- |
| 【原文级】BA | `.agents/verify/benchmark-auth-design.md`（日期 `benchmark-auth-design.md:4`；性质与证据分级见 `:3`、`:6`） | 竞品侧**唯一**原文级材料，含安装脚本原文与官方文档引用；但 `:6` 明确「未在真机安装运行，因此所有运行时行为均不标为已实测」 |
| 【矩】draft 矩阵 | `docs/FEATURE-PARITY.md:1`（`状态: draft`，更新 2026-11-21）；多用户口径见 `:24`、`:48` | 覆盖口径（22 域 / 14 生产级 + 8 基础级 / 6 不做，`:12`）是规划，不是实测结果 |
| 【常】常识描述 | `docs/PLUGIN-MATURITY.md:14`「宝塔面板 / 1Panel 专业版**公开功能**的常识描述；无法确认的项标『待核实』，不臆造」 | 只作常识参照，不据此判定竞品「有/无」的细节 |
| 【自】自评 | `.agents/verify/security-suite-g28.md`「产品定位自评（三问）」；`docs/PLUGIN-MATURITY.md` 各行的自评列 | **自评不判领先、不判落后**，只记 kore 自己的判断 |

标记法：本文每条结论标注【硬证据】（代码 / 实测报告的 `file:line`）、【自评】（kore 自己的判断或 UI 观察报告）、【刻意不做】（G-11 / ADR 明定的非目标）。三类标记不可互相替代。

本地冲突与取舍（三条，逐条留痕）：

1. **1Panel 多用户冲突，不判定**：BA 原文 `benchmark-auth-design.md:26` 引官方「1Panel supports one user per host」（单用户），draft 矩阵 `docs/FEATURE-PARITY.md:24`、`:48` 记「有（团队）」。两者矛盾，本文**不据此推出任何多用户相关的差距或领先**。
2. **PARITY-GAP 已过时，以 PLUGIN-MATURITY 为准**：`docs/PARITY-GAP.md:1` 更新于 2026-11-22，且 `:10` 自述「已实现只认代码事实」；`docs/PLUGIN-MATURITY.md:1` 更新于 2026-11-24（正文含 11-25 记录）。凡两者冲突（例如 PARITY-GAP 记「未开始」而 PM 记「已补」），以较新的 `PLUGIN-MATURITY.md` 为当前口径。
3. **`feedback/` 目录不存在**：实测 `ls feedback` 返回 `No such file or directory`，task-120 数据源中的该路径无法取证，本文不引用其中的任何内容。

## 2. 真实差距 C1–C15（按用户价值降序）

### C1 — WAF 新增规则提交 502 回滚 【硬证据】

- 证据：`.agents/verify/waf-rules-ui.md:65`「UI 侧可用（代码已闭环），但后端在 0.4.1 + nft 1.1.6 上 `chain` 回读为空 → 新增规则实际不可用……提交必失败（502 回滚）」；同因见 `:43`、`:46`。
- 补齐前提：**需真机回归**——修 `nft -j list chain` 的 comment 解析，再验「写入 → 回读非空 → 命中拦截」闭环；仅改前端无效。

### C2 — ACME 真机签发未验证 【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:77`（`ssl` 0.8.0 L2，20 方法含 `acme.*` / `acme.builtin.*`；ADR-0020 本机无客户端故真机签发未验证）、`:157`（「结案骨架部分；强制 HTTPS 下发与真机签发待补验」）。
- 补齐前提：**需真机与可控域名**（真实 ACME 客户端 + 80/443 回连），先补验再判定是否属功能缺口。

### C3 — 异地备份不做 【刻意不做】

- 证据：`docs/PLUGIN-MATURITY.md:78`（`backup` 0.5.2 L2，本地打包 + 标准 S3 兼容对象存储）、`:155`（「异地按 G-11 不做」）；`docs/FEATURE-PARITY.md:43`（对象存储走标准 S3 协议、不绑厂商）。竞品「含云存储」为【常】级参照。
- 补齐前提：**需用户单独确认解除 G-11 并先立 ADR**；未确认前不排期（见 §4 第 4 期）。

### C4 — WAF 规则编辑器 / CC 防护缺失 【自评】

- 证据：`.agents/verify/waf-view.md:115`（竞品有图形化规则编辑、CC 阈值、UA/IP 黑白名单、URL 白名单、按站点开关；本页只有状态 / 模式 / 封禁 / 规则只读，「规则内容不可在前端编辑」，改规则要走 `root_actions` 声明）。
- 补齐前提：**需插件发布范围扩展**（规则编辑纳入 `root_actions`）+ 前端规则编排设计；先出 ADR 再动代码。

### C5 — DNS zone 托管缺失 【自评】

- 证据：`.agents/verify/dns-view.md:48-49`（竞品是可编辑权威管理台，含区域增删、A/CNAME/MX/TXT/SRV 增删改、zone 导入、生效检测；本页仅状态探测 / 即时查询 / 区域与记录只读，`record.add/update/delete` 需先配 TSIG，未做成表单）。
- 补齐前提：**需 TSIG 配置 + 写路径表单化**；不把只读查看误报为托管能力。

### C6 — 容器向导 / compose 编排不做 【刻意不做】

- 证据：`docs/PLUGIN-MATURITY.md:88`（`container` 0.6.0 L2，13 方法为 list/inspect/logs/start/stop/restart/stats/images/pull/rmi/update/health/exec，非编排）；`docs/PLUGIN-MATURITY.md:145`（明确不做容器编排）；`docs/FEATURE-PARITY.md:47`（模板是「脚本 + 变量表单」，不是容器编排）。
- 补齐前提：**需用户单独确认解除 G-11 并先立 ADR**；现有 `exec` 方法不等于 compose 向导。

### C7 — DB 库表结构 / ER 浏览缺失 【硬证据】

- 证据：`docs/DECISIONS/0050-db-and-runtime-aggregation.md:207`「D7 数据编辑（关系型行级）❌ 无（只有 SQL 控制台）；对标宝塔/1Panel 有表数据编辑，P2（先做 D2 再谈）」；同表 `:202` 记两关系型插件均无 `tables` 方法。
- 补齐前提：**需 ADR 与依赖 sequencing**——先做 D2 表浏览器（`DECISIONS/0050:202`），再谈 D7；不可跳过依赖直接上编辑器。

### C8 — 文件前端未接后端能力 【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:71`（`file` 0.3.2 L2，23 方法含 search / trash / rename / copy / uploadChunk / readRange / writeRange；「前端未接 search/trash/rename/copy/uploadChunk（`web/files.js` 仅见 `readRange`）」）。
- 补齐前提：**需前端接线**；后端能力已在，禁止把「已有方法」写成「功能已可用」。

### C9 — 监控长期历史缺失 【硬证据】

- 证据：`.agents/verify/monitor-history.md:24`（竞品有天/周粒度长期历史、可配阈值并推送微信/邮件、按容器拆分；本页历史仅进程内存滚动，60 点 × 60s ≈ 1 小时、重启清零，阈值前端写死 90%，无持久化配置、无通知渠道、无天/周视图）。
- 补齐前提：**需历史持久化 + 阈值配置 + 通知渠道**三件套；`docs/PLUGIN-MATURITY.md:79` 的环形缓冲不是长期历史。

### C10 — UI i18n 仅中英骨架 【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:131`（「仅中文 + 英文可选骨架」；G-11 收窄为不做全量框架，ADR-0021；导航/通用/设置已迁移，页面内部文案待迁移）；`docs/FEATURE-PARITY.md:98`（i18n 全量框架不做）。
- 补齐前提：**需新 ADR 推翻 ADR-0021 / G-11 禁区**；七语言文档层（D7）不能计作 UI i18n 已完成（见 §3 D7）。

### C11 — 多因子刻意不做 【刻意不做】

- 证据：`benchmark-auth-design.md:28`（kore 登录只收 `{password}`，竞品可选 MFA/Passkey/复杂度/过期等）、`:62`（明确「不引入 2FA / Passkey / 密码过期 / 密码复杂度 / 设备与 UA 验证」，理由为单人运维边缘场景 + 资源预算与薄壳纪律冲突）。
- 时点提示：BA 日期为 2026-11-23；`.agents/verify/security-suite-g28.md` 记后续 G-28 已落 2FA/TOTP 与恢复码。本条按 task-120 的【刻意不做】口径保留，复核时须先对齐时点差异再决定是否仍算差距。
- 补齐前提：**需用户单独确认并先立 ADR**；不得凭 BA 的旧时点直接判定「已实现」或「彻底不做」（见 §4 第 4 期）。

### C12 — SSH 加固最后一步未落地 【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:91`（`ssh-guard` 0.4.0 L2；「`sshd_config` 写路径依赖 ADR-0028（未实施，挂 v1.1）」，`ban.add`/`ban.remove` 仍走 root-action）。
- 补齐前提：**需 ADR-0028 实施 + root-action 白名单不扩大**；`suggest` 建议不能替代写路径。

### C13 — 运行时扩展管理缺 【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:85`（Node「扩展管理仍缺」，无常驻 supervisor，本仓 dist 未重建/未入索引，商店仍旧版）、`:86`（PHP「扩展安装仍缺」，同类 dist 问题）。
- 补齐前提：**需扩展安装/管理能力 + dist 重建并入索引**；先确认商店版本同步，否则前端看不到新能力。

### C14 — 一键部署停留在 L1.5 【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:89`（`app-deploy` 0.4.0 **L1.5**，8 方法；模板 4→9 并补 start/stop/logs、端口自动检测与资源占用；「索引仍 0.3.3，待重签」）。
- 补齐前提：**需索引重签与前端可达性复验**；L1.5 是成熟度分级，不是「生产级」结论。

### C15 — 自升级验收 核心 PASS + 4 FAIL 已修复并本机复验 【硬证据 · 已收口】

- 原证据：`.agents/verify/self-update-mvp.md`（原 `verdict: PARTIAL`，核心链路 PASS 但 `make check` 4 段 FAIL + 退出码口径偏差）。
- **收口证据（task-124，用户裁决「用本机来测试和正式使用」）**：`.agents/verify/selfupdate-final-gate.md` —— `git archive HEAD`（85e18f8）短路径隔离树真跑 `make check` **21 段全绿、exit=0、末行 `[OK] 门禁全部通过`**；原 4 段 FAIL 逐段复核为绿（thin-shell 词表豁免 / oss prune / site EROFS Skip / race 16 仓真跑全绿），非环境例外接受。首轮另发现并修复 HEAD 文档缺陷（本文件 §5#4「48 MiB」未标红线触发 canonical-check），次轮全绿，两轮命令与退出码如实留痕见该报告 §3。
- **退出码口径裁决**：按代码实际 `exitEnv=6`（`cmd/kored/main.go:26`，`exitState=3` 才是 3），任务卡旧写 3 为笔误；不回派改码。
- 状态：**核心 PASS，已收口**；verdict 由 PARTIAL 更新，证据落在 `.agents/verify/selfupdate-final-gate.md`，不再是未证项。

## 3. kore 领先项 D1–D9（有原文或代码实证）

只列有证据的项。竞品侧无同口径资料的项明确标「kore 有实证、非相对领先」，不冒充对标结论。

**D1 — 单二进制、零侵入** 【硬证据】
`CHANGELOG.md:10`（release 瘦包只挂 `kored` 静态二进制 + `checksums.txt`，不含截图/运行态数据）；`.agents/verify/v1-budget-measure.md:16`（单二进制 9.99 MiB，≤25 MiB 达标）；`.agents/verify/zero-intrusion-b.md:8`（uninstall 清理 systemd unit 与 `kore-<id>` 用户，退出码矩阵实测，`make zero-intrusion-check` 11 pass）。

**D2 — 轻量常驻 RSS，达标但如实记 WARN** 【硬证据】
`.agents/verify/v1-budget-measure.md:17`（空载 VmRSS 中位 13.18 MiB，红线 16,384 KiB 达标，**超 8,192 KiB 目标，WARN 记趋势不阻断**）；同文件 `:20-23`（空闲 CPU 0ms/60s、线程 16≤20、fd 14≤64、出站连接 0）。不把「达标」说成「达到 8 MiB 目标」，满载未测见 §5。

**D3 — 明文初始口令零落盘** 【原文级】
`benchmark-auth-design.md:25`（宝塔安装脚本把明文写入 `default.pl` 并 `chmod 600`，`bt default` 可再查）；`:60`（kore 策略「不把明文初始口令落盘、不支持再次回显明文」，只存哈希）；`:87`（明确列为 kore 两处领先之一，比宝塔严）。

**D4 — 改凭据全局吊销会话** 【硬证据】
`benchmark-auth-design.md:33`（竞品重置命令口径）、`:87`（「改凭据全局吊销会话，比两家都强」）；`docs/SECURITY.md:91`（bbolt `sessions` 保留键 `password-fingerprint` 存 `sha256(admin_password_hash)`，启动时比对决定是否全局吊销）。

**D5 — Cookie 属性可核对** 【原文级】
`benchmark-auth-design.md:30`（kore `kore_session` 为 `HttpOnly; SameSite=Strict; Path=/; Max-Age`，`Secure` 由 `auth.cookie_secure=auto` 决定；竞品 1Panel `HttpOnly` 存在但 `Secure`/`SameSite` 取值未确认，宝塔未确认）。领先点是**可核对**，不是宣称竞品更弱。

**D6 — 方法级 capability，只读不落库** 【硬证据】
`docs/PLUGIN-MATURITY.md:164`（`method_capabilities` 覆盖 23/24，`echo` 验证件不计，实测 `grep -l` 得 23）；`.agents/verify/r5-12-method-capability.md:11-17`（6 个只读方法 HTTP 200、审计增量 0；判定「收益已证」，措辞为「完全不落库」而非「按 `system:read` 落库」）。

**D7 — 七语言零日语，仅文档层** 【硬证据】
`CHANGELOG.md:8`（七语言 zh/en/es/fr/de/ru/pt 的 `DETAIL` 文档与 `locale/*.json`、README 语言切换与 star 提示、六语言 SECURITY 译文；无日语文件、无死链，JSON 与 docs-check 通过）；本地实测 `locale/` 仅 `zh/en/es/fr/de/ru/pt` 七个 JSON、无 `ja.json`。**这是文档/本地化资产层，不冒充 UI i18n 领先**；UI 侧仍是 C10 的骨架差距。

**D8 — SSH 签名 tag 发布链** 【硬证据｜非相对领先】
`.agents/verify/a3-merge-verify.md:35-41`（多个插件 tag 为 `Good "git" signature (ED25519 ...)`、`exit=0`， peeled sha 与归档 sha 一致）。**竞品侧无同口径资料，仅记 kore 有实证，非相对领先。**

**D9 — ed25519 索引签名与篡改检测** 【硬证据｜非相对领先】
`.agents/verify/resign-47.md:89`（原仓 `validate-index.sh` exit 0，内置公钥验签通过）、`:90`（`/tmp` 篡改副本 `ssh-guard.size_bytes += 1` 后 exit 1，验签失败）。**竞品侧无同口径资料，仅记 kore 有实证，非相对领先。**

**未列入项**：Wiki 六页 156/156 覆盖——全仓检索精确串 `156/156` 零命中（命中的 `1563494` 等为构建号，不是覆盖率），无证据，不列入领先项。

## 4. 分期推进路线（doc-first，只规划不实现）

顺序：安全核心 → 生态深度 → 体验/国际化 → 刻意不做项复核。每期先满足前置条件，再用可验证判据收口；任一期前置未满足就停在该期，不越期开工。

### 第 1 期 · 安全核心：C1、C2、C12、C15

- 前置条件：C1/C2 **需真机**（nft 环境、ACME 客户端 + 可控域名）；C12 **需 ADR-0028 落地**（`docs/PLUGIN-MATURITY.md:91`）；C15 **已收口**（task-124 本机复跑 21 段全绿 + exit=6 口径裁决，`.agents/verify/selfupdate-final-gate.md`）。
- 可验证判据：
  - C1：真机新增规则写入 → 回读非空 → 命中拦截，全程无 502；`waf-rules-ui.md:65` 的「半可用」结论有新 verify 报告替换。
  - C2：至少一次真实签发 + 到期续期成功，证据落到 `.agents/verify/` 报告并更新 `PLUGIN-MATURITY.md:157`。
  - C12：`sshd_config` 写路径按 ADR-0028 实施且可审计，root-action 白名单不扩大，回归 `security-suite-g28.md` 既有行为。
  - C15：4 段 FAIL 逐段给出归因与处置（回派或环境例外），退出码口径统一；PARTIAL → 明确 PASS 或明确例外，不粉饰。**已达成：4 段全修复并本机复验全绿，退出码按 exitEnv=6，PARTIAL → 核心 PASS（task-124，`.agents/verify/selfupdate-final-gate.md`）。**

### 第 2 期 · 生态深度：C4、C5、C7、C8、C9、C13、C14

- 前置条件：C4 需插件发布范围（`root_actions` 规则编辑）+ 前端编排设计；C5 需 TSIG 配置与写表单；C7 需先做 D2 表浏览器并出 ADR（`docs/DECISIONS/0050-db-and-runtime-aggregation.md:202`、`:207`）；C8 **需前端接线**（`web/files.js`，`docs/PLUGIN-MATURITY.md:71`）；C9 需历史持久化 + 阈值配置 + 通知渠道；C13/C14 需 dist 重建入索引与索引重签（`docs/PLUGIN-MATURITY.md:85-86`、`:89`）。
- 可验证判据：每项同时满足「后端能力可用 + 前端可达 + 隔离实例/真机复验」三件套，并落一份带 `file:line` 或截图的 verify 报告；缺任一件不得标「已补齐」。

### 第 3 期 · 体验与国际化：C10

- 前置条件：**需新 ADR 推翻 ADR-0021 与 G-11 的 i18n 全量框架禁区**（`docs/PLUGIN-MATURITY.md:131`、`docs/FEATURE-PARITY.md:98`）；D7 的七语言文档层不可充作 UI i18n 已领先。
- 可验证判据：导航/通用/设置之外的主流程页面内部文案完成迁移，七语言 locale 与 UI 同步且仍无日语；`bash scripts/docs-check.sh` 保持 exit 0；差距条目 C10 按新证据改写或保留。

### 第 4 期 · 刻意不做项复核：C3、C6、C11（需用户单独确认才动）

- 三项均属 G-11 明确不做：C3 异地备份（`docs/PLUGIN-MATURITY.md:155`）、C6 容器编排（`:145`、`docs/FEATURE-PARITY.md:47`）、C11 多因子（`benchmark-auth-design.md:28`、`:62`）。
- 前置条件：**用户单独确认**是唯一启动条件；C11 还需先对齐 BA（2026-11-23）与 G-28 已落 2FA 的时点差异。
- 可验证判据：未获确认前，三项不进里程碑、不排期、不写实现代码；确认后先立 ADR，再按普通差距重新评估。本期的产物是「确认记录 + ADR」，不是功能代码。

## 5. 诚实边界

本文件是**基于本地已有材料的核实，不是联网实时竞品测评**。竞品能力来自 BA 原文（明示未真机安装）、FEATURE-PARITY draft 矩阵与 PLUGIN-MATURITY 的常识描述，可能过时；kore 能力来自本地代码 / `file:line` 与 verify 报告。原有 7 类未证项，第 7 类（自升级 4 段 FAIL）已由 task-124 本机复跑取证收口，余 6 类未证项逐条列证据，不脑补结论：

1. **WAF 后端链**：`.agents/verify/waf-rules-ui.md:43`、`:46`、`:65`——`chain` 恒空、`rule.add` 写后回读不到，根因指向 comment 解析，链路未闭环。
2. **真 nft**：同上，失败口径仅限本机 nft 1.1.6 + 插件 0.4.1；其他 nft 版本与发行版未测。
3. **SSL 真机签发**：`docs/PLUGIN-MATURITY.md:77`、`:157`——本机无 ACME 客户端，签发与续期未真机验证。
4. **满载资源**：`.agents/verify/v1-budget-measure.md:18`、`:19`、`:106`——空载 0 常驻插件，「单插件 ≤24 MiB（目标）/ 合计 ≤48 MiB（红线）/ 同时常驻 ≤3」只验证了下界。
5. **跨平台采集**：`docs/FEATURE-PARITY.md:38`——Linux 真机验证过，macOS / Windows 仅交叉编译 + fixture 单测，真机未验证。
6. **goroutine**：`.agents/verify/v1-budget-measure.md:21`——只测线程数 16（代理指标），goroutine 未测。
7. **自升级 4 段 FAIL 归因 —— 已证并收口（task-124）**：原 `.agents/verify/self-update-mvp.md` 记 PARTIAL（基线漂移 / 工作区污染 / 2×环境假阴性）；现由 `.agents/verify/selfupdate-final-gate.md` 给出本机隔离树复跑证据——21 段全绿 exit=0、4 段逐段复验为绿、退出码按 `exitEnv=6` 裁决，不再是未证项。

其他边界：1Panel 多用户冲突不判定（§1）；PARITY-GAP 旧口径以 PM 为准（§1）；`feedback/` 目录不存在、未引用（§1）；Wiki 156/156 零命中、不列入（§3）。

**门禁记录（如实标注）**：本文件落盘前 `bash scripts/docs-check.sh` 基线为 5 pass / 1 warn / 0 fail（exit 0）；该 WARN 的 10 份行数越界均为既有文档（含两份已逐条登记豁免），**非本次引入**。本文件行数落在 docs 期望的 100–400 区间内，未新增行数 WARN。
