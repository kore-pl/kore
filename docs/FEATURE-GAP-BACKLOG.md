> 状态: draft · 归属: gap-backlog · 更新: 2026-11-26 · 里程碑: M5 · 收口: task-131 triage / task-134 文档回写
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

### C1 — WAF 新增规则提交 502 回滚 【硬证据 · 本机真机验证 PASS】

- 原证据：`.agents/verify/waf-rules-ui.md:65`「UI 侧可用（代码已闭环），但后端在 0.4.1 + nft 1.1.6 上 `chain` 回读为空 → 新增规则实际不可用……提交必失败（502 回滚）」；同因见 `:43`、`:46`。
- **本机验证证据（task-126）**：`.agents/verify/waf-ruleadd-live.md` —— `waf` 0.5.3（含 0.4.3 nft 1.1.x comment 解析修复 + 0.4.4 expr 反解 + 0.4.5 e2e harness）在 `dsh-root` 私有 user+net namespace + 真 nftables 1.1.6 下真跑：`waf.rule.add → 独立 nft -j 回读 chain handle → waf.rule.remove` 闭环全 PASS（报告 §3.3 命令 + nft 原文回读，§4 判定表 8 项全 PASS）。chain 非空、builtin 徽标正确、handle 一致（插件返回 11 == 独立 nft 回读 11）、删除真删数据面且幂等；旧 0.4.1 式 `E_UPSTREAM`（HTTP 502）回滚**未复现**。
- **验证形态边界**：用「真插件二进制 + 真协议帧 + 按 `info.json` 声明执行真 nft 的假内核 root-action 通道」，覆盖 `rule.*` 协议/数据面闭环，非 kored + 8787 实例；kored 前端徽标渲染与浏览器交互属 UI 层，另卡（见 §5）。
- **附带观察（后续小项，与本闭环无关）**：上游 `TestRuleAddToggleRemoveAgainstRealNft` 末步「内置规则 toggle off/on」会调 `rebuildChain()`（`internal/wafop/rulecalls.go:194-245`）从 registry 重放已登记自定义规则，使已 `remove` 的 `block-e2e` 复活；如实留痕供后续评估，本轮不改生产代码。
- 状态：**本机真机验证 PASS**（数据面闭环），原「502 回滚」结论不再复现。

### C2 — ACME 真机签发未验证 【硬证据 · 离线 mock 已验，真机仍挂起】

- 原证据：`docs/PLUGIN-MATURITY.md:77`（`ssl` 0.8.0 L2，20 方法含 `acme.*` / `acme.builtin.*`；ADR-0020 本机无客户端故真机签发未验证）、`:157`（「结案骨架部分；强制 HTTPS 下发与真机签发待补验」）。该「仍骨架」口径在 **mock 链路层面已过时**，见下条证据（PM 原文未在本文件写域内，保持原样，仅在此说明口径差异）。
- **本机离线证据（task-125）**：`.agents/verify/acme-offline-evidence.md` —— `ssl` 0.8.1 内置 ACME 客户端 + `acmetest` mock CA（RFC 8555 最小子集，两级 CA，仅 `_test.go` 引用、不进生产二进制）在本机 **零外网**（`GOPROXY=off`、`go test -count=1`）下**全链路 192 条用例 PASS、0 FAIL**：签发闭环（`TestIssueEndToEnd` / `TestACMEIssueEndToEnd`）、自动续期 due/skip、续期失败保留旧证书、失败签发不落盘、EAB（含 missing/accepted/wrong-key）、bad-nonce 重试、零参数一键签发、失败注入路径等均覆盖（报告 §2 命令 + 退出码 0，§3 重点用例清单）。
- **未证边界**：**真机外部 CA 签发**（Let's Encrypt 等生产 CA）未做、不算完成——需用户明确授权联网 + 可控域名 + HTTP-01 可达性；证书可信链、真实 CA 风控/限流、DNS 解析与防火墙放行均未真机验证。
- 状态：**离线 mock 全链路已验证，真机外部 CA 签发仍挂起**。PM:77/157「仍骨架/部分补」口径据本期结果在 mock 层面已过时，真机层面仍成立；PM 原文不在本文件写域，未改。

### C3 — 异地备份不做 【刻意不做】

- 证据：`docs/PLUGIN-MATURITY.md:78`（`backup` 0.5.2 L2，本地打包 + 标准 S3 兼容对象存储）、`:155`（「异地按 G-11 不做」）；`docs/FEATURE-PARITY.md:43`（对象存储走标准 S3 协议、不绑厂商）。竞品「含云存储」为【常】级参照。
- 补齐前提：**需用户单独确认解除 G-11 并先立 ADR**；未确认前不排期（见 §4 第 4 期）。

### C4 — WAF 规则编辑器已落地；CC/UA/HTTP 层规则真缺 【硬证据 · 部分已补】

- 原缺口前提（已过时）：`.agents/verify/waf-view.md:115`「规则内容不可在前端编辑，改规则要走 `root_actions` 声明」。
- **代码实证（task-131 triage）**：规则编辑器已落地——`web/waf.js:687-789` 定义受控匹配器 `MATCHERS` + 规则模板 `RULE_PRESETS`，`web/waf.js:1103-1146` 新增规则表单（规则名 / 匹配条件 / 匹配值 / 动作 + 模板预设），后端 `rule.add`/`rule.remove`/`rule.toggle` 已接；`.agents/verify/waf-rules-level.md:11` 记防护等级（宽松/标准/严格）+ 命中分析 + 模式确认。原「编辑器缺失」是文档漂移，已收口。
- **收敛后的真缺**：CC 防护、UA/IP 黑白名单、URL 白名单属 **HTTP 层规则**——`web/waf.js:1138-1140` 明确注明「按 URL 路径 / User-Agent 拦截属于 HTTP 层规则，需要宿主装 ModSecurity / Naxsi 并启用其规则文件；kore 只写自己 `kore_waf` 表里的网络层规则，不改宿主 nginx / Apache 配置」。kore 现有 nft 数据面不含这层。
- 补齐前提：**需新 ADR**——宿主 web server 规则文件集成越过 ADR-0023 零侵入边界，先立 ADR 再评估；**本轮不派实现卡**（受 G-11 / ADR-0023 保护）。

### C5 — DNS 记录写表单已落地；zone 增删/DNSSEC 刻意不做 【硬证据 · 部分已补 + 刻意不做】

- 原缺口前提（已过时）：`.agents/verify/dns-view.md:48-49`「本页仅只读，`record.add/update/delete` 需先配 TSIG，未做成表单」。
- **代码实证（task-131 triage）**：记录写表单已落地——`.agents/verify/dns-feature-write-ui.md:13` 记 `web/dns.js` 新增「增删记录」面板（区域 / 记录名 / 类型 / 值 / 旧值前置 / TTL、增改删下拉、二次确认、写后刷新，G-28 双端截图齐），后端 `record.add/update/delete` + `addRecord/updateRecord/deleteRecord`/`reload` 七入口已接（插件 `dns` 0.5.3，HEAD 方法面 11 条）。原「写路径未表单化」是文档漂移，已收口。
- **刻意不做（非缺口）**：zone 创建 / 删除、DNSSEC、zone 导入由 **ADR-0051**（`docs/DECISIONS/0051-dns-root-boundary.md:15`、`:33`）明确裁决不做——zone 生命周期是「改 named.conf 语义」的部署期动作，RFC 2136 只做记录级 CRUD，扩 `rndc` 形状表属「argv 受控、语义不受控」，且 ADR-0028 已裁决不写宿主文件。竞品「可编辑权威管理台」在 kore 口径下只有记录级可编辑，zone 生命周期由用户一次性命令完成。
- 补齐前提：记录级已闭环；zone 增删/DNSSEC 若要面板化，**需用户裁决推翻 ADR-0051 并先立新 ADR**，否则不排期、不派实现卡（见 §4 第 4 期）。

### C6 — 容器向导 / compose 编排不做 【刻意不做】

- 证据：`docs/PLUGIN-MATURITY.md:88`（`container` 0.6.0 L2，13 方法为 list/inspect/logs/start/stop/restart/stats/images/pull/rmi/update/health/exec，非编排）；`docs/PLUGIN-MATURITY.md:145`（明确不做容器编排）；`docs/FEATURE-PARITY.md:47`（模板是「脚本 + 变量表单」，不是容器编排）。
- 补齐前提：**需用户单独确认解除 G-11 并先立 ADR**；现有 `exec` 方法不等于 compose 向导。

### C7 — DB 库表结构 / ER 浏览缺失 【硬证据】

- 证据：`docs/DECISIONS/0050-db-and-runtime-aggregation.md:207`「D7 数据编辑（关系型行级）❌ 无（只有 SQL 控制台）；对标宝塔/1Panel 有表数据编辑，P2（先做 D2 再谈）」；同表 `:202` 记两关系型插件均无 `tables` 方法。
- 补齐前提：**需 ADR 与依赖 sequencing**——先做 D2 表浏览器（`DECISIONS/0050:202`），再谈 D7；不可跳过依赖直接上编辑器。

### C8 — 文件前端未接后端能力 【已证伪 / 已接线 PASS】

- 原缺口前提（已推翻）：`docs/PLUGIN-MATURITY.md:71` 旧文「前端未接 search/trash/rename/copy/uploadChunk（`web/files.js` 仅见 `readRange`）」。
- 证伪证据：① 前端接线事实见 `.agents/verify/files-l2.md`（G-28 双端截图齐；该文件旧行号 `web/files.js:295/300/748` rename、`:303`+`web/files-l2.js:318` copy、`:470` search、`:626/644` trash.restore、`:711` trash.purge 经 11-26 UI 重构已漂移，**以当前 HEAD 真实调用点为准**：`web/files.js:700` search、`:779,799` trash.list、`:881,896` trash.restore、`:948,951` trash.purge、`:988` rename，`web/files-l2.js:142` uploadChunk、`:149,203,233` uploadStatus、`:455,467` copy）；② 后端五项经隔离 kored 实例真实 `POST /api/v1/invoke/file/<method>` 逐条断言 **全 PASS（13 条可核对断言 / 0 FAIL，HTTP 200 不另计）**，见 `.agents/verify/c8-file-invoke-live.md`（`file@0.3.6` 包 sha 与索引一致、127.0.0.1:18887 隔离实例、KORE_FILE_ROOT 指测试目录、未碰 8787/.kore-local-*）。
- 结论：C8 已从「硬证据缺口」转为 **已证伪 / 已接线 PASS**；按用户「用本机测试和正式使用」口径，先隔离实测坐实再改文档，不再派无效实现卡。前端双击改名/目录选择器复制/按内容搜索/回收站三动作/断点续传均有真实 UI 落点与后端可达证据。

### C9 — 监控历史落盘 + 阈值可配已补；真缺=通知渠道 / 天周视图 【硬证据 · 部分已补】

- 原缺口前提（部分已过时）：`.agents/verify/monitor-history.md:24`「历史 60 点 × 60s ≈ 1 小时、重启清零，阈值前端写死 90%，无持久化配置」。
- **代码实证（task-131 triage）**：① 历史已落盘——`kore-plugin-monitor/internal/monitor/history.go:12-15` 记 60 点环形缓冲以 0600 落盘到 `<KORE_STATE_DIR>/history.json`、重启接续（零 ticker）；② 阈值后端可配——`kore-plugin-monitor/config.go:34-38`（`KORE_MONITOR_CPU_THRESHOLD` / `*_MEMORY_*` / `*_DISK_*`）+ `config.get/set`；③ 前端未读配置曾是唯一无 ADR 门槛的真缺，**已由 task-133 修复**（commit `06a6b9d`，`web/monitor.js:241-257` 启动读 `monitor.config.get`、设置面板写回 `config.set`，失败保留默认值不白屏）。环形缓冲不是长期历史，故「历史持久化」口径按落盘接续理解，非无限期留存。
- **收敛后的真缺**：通知渠道（微信 / 邮件推送）与天 / 周粒度长期历史视图——属新能力，无现有 ADR 覆盖；**需用户裁决是否立 ADR 再排期**（见 §4 第 2 期、§5）。本轮不再派前端阈值卡（已落地）。

### C10 — UI i18n 仅中英骨架（真缺，受 ADR-0021 / G-11 保护）【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:131`（「仅中文 + 英文可选骨架」；G-11 收窄为不做全量框架，ADR-0021；导航/通用/设置已迁移，页面内部文案待迁移）；`docs/FEATURE-PARITY.md:98`（i18n 全量框架不做）。
- **代码实证（task-131 triage，非文档漂移）**：`web/i18n.js:6` 的 `SUPPORTED` 仅 `['zh-CN','en-US']` 两个，`web/i18n/` 目录仅 `zh-CN.js` / `en-US.js` 两个文件；运行时切换不覆盖其余五种文档层语言。这是真缺，不是报告滞后，`locale/*.json` 七语言只证明文档层（§3 D7），不能充作 UI i18n。
- 补齐前提：**需新 ADR 推翻 ADR-0021 / G-11 禁区**；未获推翻前不派实现卡、不排期。七语言文档层（D7）不能计作 UI i18n 已完成。

### C11 — 多因子刻意不做 【刻意不做】

- 证据：`benchmark-auth-design.md:28`（kore 登录只收 `{password}`，竞品可选 MFA/Passkey/复杂度/过期等）、`:62`（明确「不引入 2FA / Passkey / 密码过期 / 密码复杂度 / 设备与 UA 验证」，理由为单人运维边缘场景 + 资源预算与薄壳纪律冲突）。
- 时点提示：BA 日期为 2026-11-23；`.agents/verify/security-suite-g28.md` 记后续 G-28 已落 2FA/TOTP 与恢复码。本条按 task-120 的【刻意不做】口径保留，复核时须先对齐时点差异再决定是否仍算差距。
- 补齐前提：**需用户单独确认并先立 ADR**；不得凭 BA 的旧时点直接判定「已实现」或「彻底不做」（见 §4 第 4 期）。

### C12 — SSH 加固最后一步未落地 【硬证据】

- 证据：`docs/PLUGIN-MATURITY.md:91`（`ssh-guard` 0.4.0 L2；「`sshd_config` 写路径依赖 ADR-0028（未实施，挂 v1.1）」，`ban.add`/`ban.remove` 仍走 root-action）。
- 补齐前提：**需 ADR-0028 实施 + root-action 白名单不扩大**；`suggest` 建议不能替代写路径。

### C13 — 运行时扩展管理缺（dist/索引已同步，真缺=运行时扩展方法）【硬证据】

- 原证据（部分已过时）：`docs/PLUGIN-MATURITY.md:85`（Node「扩展管理仍缺」，本仓 dist 未重建/未入索引、商店仍旧版）、`:86`（PHP「扩展安装仍缺」，同类 dist 问题）。
- **代码实证（task-131 triage）**：「dist 未重建 / 未入索引 / 商店旧版」已不成立——索引与 HEAD 版本已同步（`runtime-node` 0.3.2 / `runtime-php` 0.3.2，24 仓版本全部对齐索引）。真缺收敛为**运行时扩展 install/list/remove 方法**：`kore-plugin-runtime-node/internal/*/call.go` 方法面仅 versions/info/projects/doctor/paths/use + guard.*，无 `ext.*`；PHP 同理（`internal/phpop/` 只有 `extensionChecks` 只读探测）。无常驻 supervisor 属已知设计边界（setsid + 状态落盘，可被 cron 驱动）。
- 补齐前提：**需新增扩展安装/管理方法 + 前端接线**，属新能力；是否纳入 v1 需用户裁决（无 ADR 覆盖，见 §4 第 2 期）。dist/索引不再作为前置门槛。

### C14 — 一键部署 L1.5（索引已同步；建库/写 vhost 刻意不做）【硬证据】

- 原证据（部分已过时）：`docs/PLUGIN-MATURITY.md:89`（`app-deploy` 0.4.0 L1.5、8 方法、「索引仍 0.3.3，待重签」）。
- **代码实证（task-131 triage）**：`app-deploy` HEAD 0.4.2，**11 业务方法**（templates/deploy/deployFromArtifact/list/remove/upload/upgrade/jobs + 0.4.0 的 start/stop/logs；method_capabilities 11 条），索引已同步 0.4.2——「索引待重签」是文档漂移，已收口。L1.5 是因无 G-28 双端截图压住不升的成熟度分级，不是「生产级」结论，也不是代码缺失。
- **刻意不做（非缺口）**：建库、写 vhost/reload 按 **G-13 仓库边界**（插件不得写宿主 nginx 配置、跨插件边界）刻意不做，`deployFromArtifact` 只回 `site_hint`/`databases` 提示。
- 补齐前提：索引重签已非前置；若要升 L2 需补 G-28 双端截图；建库/vhost 若要纳入需用户裁决推翻 G-13 边界并先立 ADR，否则不排期。

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

**本期三路证据已全部 PASS 并回写（C1 / C2 / C15 三项闭环；各自的未证边界见 §5，不夸大）**：C1 本机真机数据面闭环 PASS（task-126，`waf-ruleadd-live.md`）、C2 离线 mock 全链路 PASS（task-125，`acme-offline-evidence.md`；真机签发仍挂起）、C15 本机复跑 21 段全绿 PASS（task-124，`selfupdate-final-gate.md`）。C12 技术门槛已具备，但真写宿主 `/etc/ssh` 待用户单独授权（见下）。

- 前置条件：C1 **已由本机私有 netns + 真 nft 满足**（task-126）；C2 离线 mock 已满足、**真机部分仍需授权联网 + 可控域名**；C12 **本机 dsh-root 实测有完整 root + CAP_NET_ADMIN + `/etc/ssh` 可写（task-123），技术门槛已具备**——但 ADR-0028 落地与**真写宿主 `/etc/ssh` 需用户单独授权回滚方案后才动**；C15 **已收口**（task-124 本机复跑 21 段全绿 + exit=6 口径裁决，`.agents/verify/selfupdate-final-gate.md`）。
- 可验证判据（闭环状态据本期证据更新）：
  - C1：**已达成（数据面）** —— 真机 `waf.rule.add → 独立 nft 回读 handle → rule.remove` 全 PASS、502 未复现，证据 `.agents/verify/waf-ruleadd-live.md`；kored 前端徽标与浏览器交互属 UI 层另卡，toggle 复活留后续小项。
  - C2：**离线部分已达成** —— 内置 ACME + mock CA 192 测试 PASS，证据 `.agents/verify/acme-offline-evidence.md`；**真机至少一次真实签发 + 到期续期仍未达成**（需授权联网 + 可控域名），`PLUGIN-MATURITY.md:157` 的 PM 原文不在本文件写域、未改，仅在此同步口径。
  - C12：**未闭环（等待授权，非技术阻塞）** —— 技术门槛已具备（task-123）；`sshd_config` 写路径按 ADR-0028 实施且可审计、root-action 白名单不扩大、回归 `security-suite-g28.md` 既有行为仍为收口判据；真写宿主 `/etc/ssh` 须先取得用户单独授权并备好回滚方案。
  - C15：**已达成** —— 4 段 FAIL 全修复并本机复验全绿，退出码按 exitEnv=6，PARTIAL → 核心 PASS（task-124，`.agents/verify/selfupdate-final-gate.md`）。

### 第 2 期 · 生态深度：C4、C5、C7、C8、C9、C13、C14（task-131 triage 后重排）

- **本期 triage 结论先行**：4 项文档漂移已收口——C4 规则编辑器（已落地，见 `web/waf.js:687-789/1103-1146`）、C5 记录写表单（已落地，见 `dns-feature-write-ui.md:13`）、C8 前端接线（已证伪/已接线 PASS）、C13/C14 的 dist/索引表述（已同步，24 仓版本全对齐索引）；这些不再派实现卡。真缺项按门槛分类：
  - **ADR / 用户裁决前置（不派实现卡）**：C4-CC/UA/HTTP 层规则（需新 ADR 覆盖宿主 ModSecurity/Naxsi 集成，越过 ADR-0023 零侵入）、C5-zone 增删/DNSSEC（ADR-0051 明确不做，需用户裁决推翻）、C13 运行时扩展 install/list/remove（新能力，需裁决是否入 v1）、C14 建库/写 vhost（G-13 跨插件边界刻意不做，需裁决推翻）、C9 通知渠道/天周视图（新能力，需裁决立项）。
  - **后续实现卡（无 ADR 门槛）**：C7 DB 表浏览器/ER（先做 D2 再谈 D7，`docs/DECISIONS/0050-db-and-runtime-aggregation.md:202`、`:207`）；C14 升 L2 需补 G-28 双端截图（非代码缺失）。C9 前端阈值卡已由 task-133 落地（commit `06a6b9d`），不再派卡。
- 前置条件：凡标「ADR / 用户裁决前置」的项，未取得裁决前不进里程碑、不派卡；C7 需先做 D2 表浏览器并出 ADR。
- 可验证判据：新能力一旦获批，每项同时满足「后端能力可用 + 前端可达 + 隔离实例/真机复验」三件套，并落一份带 `file:line` 或截图的 verify 报告；缺任一件不得标「已补齐」。

### 第 3 期 · 体验与国际化：C10（真缺，ADR 前置）

- 前置条件：**需新 ADR 推翻 ADR-0021 与 G-11 的 i18n 全量框架禁区**（`docs/PLUGIN-MATURITY.md:131`、`docs/FEATURE-PARITY.md:98`）；triage 已核实 `web/i18n.js:6` 的 SUPPORTED 仅 2 语言、`web/i18n/` 仅 2 文件，是真缺而非文档漂移，未获新 ADR 前**不派实现卡**。D7 的七语言文档层不可充作 UI i18n 已领先。
- 可验证判据：新 ADR 获批后，导航/通用/设置之外的主流程页面内部文案完成迁移，`web/i18n.js` 的 SUPPORTED 与 `web/i18n/` 文件数覆盖七语言且仍无日语；`bash scripts/docs-check.sh` 保持 exit 0；差距条目 C10 按新证据改写或保留。

### 第 4 期 · 刻意不做项复核：C3、C6、C11（需用户单独确认才动）

- 三项均属 G-11 明确不做：C3 异地备份（`docs/PLUGIN-MATURITY.md:155`）、C6 容器编排（`:145`、`docs/FEATURE-PARITY.md:47`）、C11 多因子（`benchmark-auth-design.md:28`、`:62`）。**triage 新增同期裁决项**：C5-zone 增删/DNSSEC（ADR-0051）、C14 建库/写 vhost（G-13）同属「刻意不做」，并入本期复核，不派实现卡（见 §2 C5/C14、§4 第 2 期）。
- 前置条件：**用户单独确认**是唯一启动条件；C11 还需先对齐 BA（2026-11-23）与 G-28 已落 2FA 的时点差异。
- 可验证判据：未获确认前，三项不进里程碑、不排期、不写实现代码；确认后先立 ADR，再按普通差距重新评估。本期的产物是「确认记录 + ADR」，不是功能代码。

## 5. 诚实边界

本文件是**基于本地已有材料的核实，不是联网实时竞品测评**。竞品能力来自 BA 原文（明示未真机安装）、FEATURE-PARITY draft 矩阵与 PLUGIN-MATURITY 的常识描述，可能过时；kore 能力来自本地代码 / `file:line` 与 verify 报告。原有 7 类未证项，本期（C1/C2/C15 三路）取证后：第 1 类 WAF 后端链、第 7 类自升级 4 段 FAIL 已证并收口，第 2/3 类部分收窄（本机 nft 与离线 ACME 已证，真机边界仍在），余项逐条列证据；已证的不夸大、未证的仍如实挂起，不脑补结论：

1. **WAF 后端链 —— 已证并收口（task-126）**：原 `.agents/verify/waf-rules-ui.md:43`、`:46`、`:65` 记 `chain` 恒空、`rule.add` 写后回读不到（502 回滚）；现由 `.agents/verify/waf-ruleadd-live.md` 在 `dsh-root` 私有 netns + 真 nft 1.1.6 下取证——0.5.3 的 `rule.add → 独立 nft 回读 handle → rule.remove` 全 PASS、502 未复现。**边界**：证明的是数据面闭环（真二进制 + 真协议帧 + 按声明执行真 nft），非 kored 前端徽标渲染与浏览器交互；「删除自定义规则 + 后续启停内置规则」会触发 `rebuildChain()` 使规则复活，留后续小项（见 §2 C1）。
2. **真 nft —— 本机环境已证，跨版本/发行版仍未测（task-126）**：原失败口径仅限本机 nft 1.1.6 + 插件 0.4.1；本期在**同一本机 nft 1.1.6 + 私有 netns** 下用插件 0.5.3 真跑通过（`.agents/verify/waf-ruleadd-live.md` §3 命令 + nft 原文回读）。**仍未证**：其他 nft 版本与发行版、宿主真实 netns（本次为 `unshare -rn` 私有 netns，宿主表零接触）、真实 80/443 拦截命中流量。
3. **SSL 真机签发 —— 离线已证，真机仍挂起（task-125）**：`docs/PLUGIN-MATURITY.md:77`、`:157` 的「本机无 ACME 客户端、真机签发未验证」中「本机无客户端」口径已过时——`ssl` 0.8.1 内置 ACME 客户端 + `acmetest` mock CA 离线全链路 192 测试 PASS（`.agents/verify/acme-offline-evidence.md`，签发/续期/失败保留旧证书/EAB/bad-nonce）。**仍未证**：真机外部 CA（Let's Encrypt 等）签发与到期续期，需用户授权联网 + 可控域名 + HTTP-01 可达性；证书可信链、CA 风控/限流、DNS 解析与防火墙放行均未真机验证。PM 原文不在本文件写域、未改，仅在此同步口径。
4. **满载资源**：`.agents/verify/v1-budget-measure.md:18`、`:19`、`:106`——空载 0 常驻插件，「单插件 ≤24 MiB（目标）/ 合计 ≤48 MiB（红线）/ 同时常驻 ≤3」只验证了下界。
5. **跨平台采集**：`docs/FEATURE-PARITY.md:38`——Linux 真机验证过，macOS / Windows 仅交叉编译 + fixture 单测，真机未验证。
6. **goroutine**：`.agents/verify/v1-budget-measure.md:21`——只测线程数 16（代理指标），goroutine 未测。
7. **自升级 4 段 FAIL 归因 —— 已证伪并收口（task-124）**：原 `.agents/verify/self-update-mvp.md` 记 PARTIAL（基线漂移 / 工作区污染 / 2×环境假阴性）；现由 `.agents/verify/selfupdate-final-gate.md` 给出本机隔离树复跑证据——21 段全绿 exit=0、4 段逐段复验为绿（非环境例外接受）、退出码按 `exitEnv=6` 裁决，原「4 段 FAIL」已证伪，不再是未证项。

8. **task-131 triage 的文档漂移收口（本期）**：C1/C2/C15 之外，第二/三期 7 项复核结论已落 §2/§4——**4 项文档漂移已收口**（C4 规则编辑器落地、C5 记录写表单落地、C8 前端接线已证伪、C13/C14 dist/索引同步表述）；**真缺项已按门槛标注前置**（C4-CC/UA/HTTP 层需新 ADR 覆盖宿主集成、C5-zone/DNSSEC 与 C14 建库/vhost 属刻意不做需用户裁决推翻 ADR-0051/G-13、C9 通知渠道/天周视图与 C13 运行时扩展方法属新能力需裁决、C10 受 ADR-0021/G-11 保护需新 ADR）。C9 前端阈值部分已由 task-133 落地（commit `06a6b9d`）；C7 是后续实现卡（先 D2 再 D7）。所有真缺项在获得 ADR/裁决前不派实现卡，避免再次派无效卡。
9. **索引与版本也已同步（triage 实证）**：24 个插件仓 `info.json.version` 与 `../kore-plugins/index/plugins.json` 逐仓一致（含 `waf` 0.5.3、`app-deploy` 0.4.2、`runtime-node/php` 0.3.2），故 §2 C13/C14 与 PM 表内旧「索引仍 X 待重签」表述按本期结论统一收口，不再视为前置门槛。

其他边界：1Panel 多用户冲突不判定（§1）；PARITY-GAP 旧口径以 PM 为准（§1）；`feedback/` 目录不存在、未引用（§1）；Wiki 156/156 零命中、不列入（§3）。

**门禁记录（如实标注）**：本文件落盘前 `bash scripts/docs-check.sh` 基线为 5 pass / 1 warn / 0 fail（exit 0）；该 WARN 的 10 份行数越界均为既有文档（含两份已逐条登记豁免），**非本次引入**。本文件行数落在 docs 期望的 100–400 区间内，未新增行数 WARN。
