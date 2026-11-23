# .agents · LOG · 派发台账

> 状态: draft · 归属: scribe · 更新: 2026-11-22 · 里程碑: M1

登记"谁在做什么、写到哪、依赖谁、交了什么、落在哪个 commit"。**task 即登记，回报后在同一行补交付与 commit**，不另开一行。写域以派发时的 `write_scopes` 为准，事后扩域必须回拆解阶段重画。

「owner」列带「（推断）」= 仓库内无该次派发记录，由 commit 内容与文件归属推断，不作为验收依据；不带者来自 BOARD 快照、提案任务表或 commit 署名。不确定的 commit 写 `—`。

| 时间 | task | owner | 写域 | 依赖 | 交付 | commit | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-21 | M0-A 愿景 / 总体架构 / 内核规格 / 术语表 | architect | `docs/VISION.md`、`docs/ARCHITECTURE.md`、`docs/CORE.md`、`docs/GLOSSARY.md` | — | 4 份文档 178 / 348 / 286 / 172 行 | `7404ad1` | completed |
| 2026-11-21 | M0-B 插件协议 / 资源模型 / 数据模型 | architect | `docs/PLUGIN-PROTOCOL.md`、`docs/RESOURCE-MODEL.md`、`docs/DATA-MODEL.md` | — | 3 份文档 350 / 205 / 268 行；帧 = 4B 长度 + JSON | `7404ad1` | completed |
| 2026-11-21 | M0-C 前端架构 / 安全模型 / 8 篇 ADR | architect | `docs/FRONTEND.md`、`docs/SECURITY.md`、`docs/DECISIONS/` | — | 2 份文档 253 / 216 行 + ADR 0001–0008（无重号） | `7404ad1` | completed |
| 2026-11-21 | M0-D 路线图 / 执行计划 / M0 清单 | lead | `docs/ROADMAP.md`、`docs/PLAN.md`、`docs/MILESTONE-M0.md` | — | 3 份文档 191 / 227 / 169 行 | `7404ad1` | completed |
| 2026-11-21 | M0-E AGENTS.md + agent 管理架构 | scribe | `AGENTS.md`、`README.md`、`.agents/` | — | 体系文档 6 份 + 模板 4 份；`docs-check` 6 pass / 0 fail | `7404ad1` | completed |
| 2026-11-21 | M0-F 仓库骨架 / 门禁脚本 | implementer | `.gitignore`、`.editorconfig`、`Makefile`、`scripts/` | — | `APP ?= kored` / `BIN ?= ./bin/kored`；`docs-check.sh` + `canonical-check.sh` | `7404ad1` | completed |
| 2026-11-21 | M0-G 独立验收 + 首提交 | verifier | `.agents/verify/` | M0-A…F | R1–R5 报告（`m0-consistency-r5.md` 99 行）+ 59 文件首提交 | `7404ad1` | completed |
| 2026-11-21 | M0 首提交执行 | kore-implementer-commit(1) | 精确 `git add` 59 个文件 | M0-G APPROVE | 59 文件 / 8,193 insertions，排除 proposals / reviews 3 件 | `7404ad1` | completed |
| 2026-11-21 约 22:51 | M1 提案 + 双评审（前置于 M1 开工） | kore-architect-m1（提案）/ kore-red-team-2（v1 对标验尸） | `.agents/proposals/`、`.agents/reviews/` | M0-G | `0001-m1-walking-skeleton.md` 300 行 + 验尸 163 / 183 行 | `7e4602c` | completed |
| 2026-11-21 | M1 规划件提交 | kore-implementer-commit(2) | 同上 4 文件（BOARD 状态同步） | 双评审落盘 | 4 文件 / 653 insertions | `7e4602c` | completed |
| 2026-11-21 约 23:0x | M1-01/M1-02 帧编解码 + 信封类型 | kore-impl-pluginapi | `pkg/pluginapi/` | M1-01 提案 | 9 文件 / 687 insertions；8 MiB 边界、超限零分配、半包测试 | `c31d13f` | completed |
| 2026-11-21 约 23:03 | 协议口径补丁（信封字段 / 帧层边界） | kore-architect-m1（推断） | `docs/PLUGIN-PROTOCOL.md`、`docs/DECISIONS/0007`、`proposals/0001` | `c31d13f` 实现反馈 | 3 文件 / +12 −11；明确 `id` 归 bus、`timeout_ms<=0` 取 15000 | `90c5936` | completed |
| 2026-11-21 约 23:1x | 根 module 骨架 + platform 五接口 + envprobe + 最小 httpapi | kore-impl-core | `go.mod`、`cmd/kored/`、`internal/core/{envprobe,httpapi}`、`internal/platform/` | `c31d13f` | 20 文件 / 1,762 insertions；交叉编译桩通过 | `82ba3c5` | completed |
| 2026-11-21 约 23:4x | 资源锚点注释修正 + version 复用 `pluginapi.Protocol` | kore-impl-runtime（推断） | `cmd/kored/main.go`、`cmd/kored/serve.go` | `82ba3c5`、ADR-0015 | 2 文件 / +16 −12 | `6fdaedd` | completed |
| 2026-11-21 23:47–11-22 00:06 | M1 内存基线独立测量（GOGC 三档 × 60 点） | kore-verifier-mem | `.agents/verify/m1-memory-baseline.md` | `6fdaedd` | 135 行报告；发现 `SetGCPercent(-1)` 关闭 GC 的 P0 | — | completed |
| 2026-11-22 | GC 副作用 P0 修复 + G-21 落地 | kore-impl-runtime（推断） | `cmd/kored/serve.go`、`cmd/kored/serve_test.go` | `m1-memory-baseline` §5 | 2 文件 / +193 −23；修复后 VmRSS 中位数 7,688 KiB、300 次 healthz 触发 1,374 次 GC | `02d0154` | completed |
| 2026-11-21 约 23:0x | M1-04 store：bbolt 打开 / 6 bucket / schema v1 | kore-impl-storage | `internal/core/store/` | M1-04 提案 | `store.go`、`tx.go` 已落盘，**未提交** | — | in_progress |
| 2026-11-22 约 00:2x | M1-03 config：默认 + YAML + 校验 + SIGHUP | —（派发记录缺失） | `internal/core/config/` | M1-03 提案 | 7 个文件已落盘，**未提交** | — | in_progress |
| 2026-11-22 约 00:2x | M1-10 registry：12 字段 + `lifecycle` 解析 | —（派发记录缺失） | `internal/core/registry/` | M1-10 提案 | `manifest.go` 已落盘，**未提交** | — | in_progress |
| 2026-11-22 约 00:2x | 建立判断台账 + 回填 M0/M1 | kore-scribe-log | `.agents/LOG/`、`.agents/README.md`、`.agents/BOARD.md`、`.agents/WORKFLOW.md` | M0/M1 既有产物 | 5 份台账文件 + 3 处索引 / 工作流补丁 | — | in_progress |

| 2026-11-22 | M1-07 daemon 装配 + HTTP 端点（walking skeleton） | kore-impl-integration | `cmd/kored/serve*.go`、`internal/core/httpapi/` | config / store / registry / supervisor / bus / installer 六模块 | serve 拆 9 文件 + httpapi 6 文件 + 6 项测试 + 手工 E2E（install→enable→invoke→kill -9→disable） | —（待提交） | in_progress |
| 2026-11-22 | 大小写审计与 `case-check` | kore-case-audit | `scripts/case-check.sh`、docs 大小写修正 | 模块改名 | 5 项校验 4 pass / 1 warn（旧仓库名规则命中 ADR / 台账必要引用）；已接入 `make check` 第 9 段 | —（待提交） | completed |
| 2026-11-22 | 模块路径改名 `kore-project` → `pengtang1024` | kore-rename-module | `go.mod`、`go.sum`、`pkg/pluginapi/go.mod`、`scripts/dep-check.sh`、`docs/**`、`cmd/`、`internal/`、`../kore-plugin-echo` | ADR-0017 | 文档 77 文件 / 163 处 + 代码 import 全量改；残留 3 处为历史/假设名（`scripts/case-check.sh` 1、`docs/OPEN-SOURCE.md` 2） | —（待提交，HEAD 仍为旧路径） | completed |
| 2026-11-22 | 开源六件套 + G-26 | kore-oss-assets | `LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`、`.github/workflows/ci.yml`、`docs/OPEN-SOURCE.md` | ADR-0017 | 六件齐 + MIT；`make oss-check` 8 pass / 0 fail | —（待提交） | completed |
| 2026-11-22 | 只读探测：GitHub 归属与提交身份 | kore-gh-probe / kore-git-identity | 只读，无写域 | — | `gh auth status`（pengtang1024）→ ADR-0017 选项对比；`git log --format='%ae'` 11 条同邮箱 | —（只读，无产出） | completed |
| 2026-11-23 | Round 4 收口：PLUGIN-MATURITY 按代码事实重判（6 个 L0 → L1.5 + monitor 修正 + db-mysql L2）+ CS-R4-01 登记 + AGENTS 压到 132 行 | update-maturity-r4 | `docs/PLUGIN-MATURITY.md`、`.agents/BOARD.md`、`AGENTS.md`、`.agents/LOG/DISPATCH.md` | lead 派发（Round 4 六插件 + 主壳两能力） | `PLUGIN-MATURITY` 178 行 / `BOARD` 179 行 / `AGENTS` 132 行 + 本台账 1 行；24 仓版本比对 22 一致 / 2 待重签；业务方法 127 | 本次提交 | completed |

| 2026-11-23 | Round 5 · 四插件发版复核（redis 0.4.0 / logs 0.3.0 / container 0.3.0 / ssh-guard 0.2.0） | kore-rel-redis / kore-rel-logs / kore-rel-container / kore-rel-sshguard | 各插件仓（只读复核 + dist 重建） | 各仓 v0.x tag 已存在 | 四仓全 PASS、零漂移：tag 干净树 `make dist` sha == 工作树 dist sha，release 资产 `curl -L` 200 + sha 一致；logs 另补 `method_capabilities` 与 0.4.0 能力（见下行） | `8b5cb45` + `a19cd8b`（logs 0.4.0）；其余仓 `—` | completed |
| 2026-11-23 | Round 5 · process 0.2.0 → 0.2.1（保护名单 + renice + capability） | kore-rel-process | `../kore-plugin-process` | logs 复核同批 | 保护名单 + `renice` + 方法级 capability；0.2.0 已推、0.2.1 本地固化 | `67e99fd` / `aebabbf` | completed |
| 2026-11-23 | Round 5 · cron 0.4.0 → 0.4.1（启停 + 固化） | kore-impl-cron | `../kore-plugin-cron` | process 同批 | `enable` / `disable` 落地 + 0.4.1 固化；8 方法 / 方法级 capability | `81e84d8` / `d661d68` | completed |
| 2026-11-23 | R5-1 提权验证（真 root 通道 + 修 --pipe） | kore-verify-privilege | `.agents/verify/`、`../kore-plugin-*` root action 调用侧 | P0 降权 | 真 root 通道端到端 + 修 `--pipe` 输出丢失；ADR-0018 记录 | `f7bd150` | completed（降权后未复验，见 BOARD §9） |
| 2026-11-23 | **P0 插件降权**（kore-`<id>` 降权 + 降级矩阵） | kore-impl-demotion | `kore` 降权路径（16 文件） | R5-1 | `kore-<id>` 前缀降权落盘 + 降级矩阵；**事故：共享 index 竞态把 16 文件卷进 `6ceeba8`（消息为"移除 ipset"）** | `6ceeba8` + `f7bd150` | completed（事故已复盘，见 JOURNAL Round 5 §1） |
| 2026-11-23 | R5-2 形状表 + waf（rootpolicy 769 行 + ADR-0022 + 删 sed 入口） | kore-impl-waf | `kore` rootpolicy / ADR-0022 / `../kore-plugin-waf` | P0 降权 | rootpolicy 形状表 769 行 + ADR-0022 + 移除 sed 入口 | `f086312` / `6ceeba8` / `2db5f92` | completed |
| 2026-11-23 | SDK v0.1.2 / v0.1.3（rootaction 进 tag + pluginapitest） | kore-impl-sdk | `pkg/pluginapi/` | R5-2 形状表 | `rootaction` 进 tag（v0.1.2）+ 清单统一自检入口 `pluginapitest`（v0.1.3）+ SDK 文档同步 | `50d3681` / `1e0c10a` | completed |
| 2026-11-23 | 索引第 32 / 33 次重签（12 条版本 + 私钥销毁） | kore-impl-release-r5 | `kore-plugins/index/`、`kore-plugins/scripts/`、`kore/internal/core/market/verify.go` | 各插件仓发版 | 第 32 次签 6 条后收到追加清单，私钥已 shred → 作废换第 33 把；12 条版本入索引 + `versions.lock` + 预设同步 | `b4f688b`（`kore-plugins`，第 33 次，已双推）/ `8566d43`（`kore` 新公钥） | completed（第 34 次待做，见 BOARD §9） |
| 2026-11-23 | Round 5 · 插件能力补全 ×N（container / redis / ssl / logs / integrity / db-postgres / file / monitor / terminal / site / ssh-guard） | 各 agent（kore-impl-* / kore-rel-*） | 各插件仓 | 各仓既有能力 | 方法级 `method_capabilities` + §2 缺口（下载 / 增量跟踪 / 切割 / 聚合等）逐仓补齐；版本见 CS-20261123-04 | 各仓 commit（见各仓 `RELEASE-EVIDENCE.md` / CHANGELOG） | in_progress（推送待批次收口） |
| 2026-11-23 | Round 5 · 文档重判（PLUGIN-MATURITY 按代码事实） | kore-architect-maturity | `docs/PLUGIN-MATURITY.md` | 各仓能力事实 | 方法数 / capability 覆盖率 / 下划线命名约束 / 视图数按代码同步（L0 0 / L1 0 / L1.5 18 / L2 5） | `1cec22b` | completed |
| 2026-11-23 | Round 5 · 台账收口（DISPATCH / BOARD / JOURNAL） | kore-scribe-round5 | `.agents/LOG/DISPATCH.md`、`.agents/BOARD.md`、`.agents/JOURNAL.md` | 上述各轨 | 11 条派发汇总 + `CS-20261123-04` + 5 条教训 + 6 项遗留 | 本次提交 | in_progress |

| 2026-11-23 | 26 仓 GitHub 迁移到 `kore-pl` 组织（`gh api transfer`，transfer 遇 422 按 60s 退避） | verify-privilege | GitHub 组织设置（非文件写域） | 迁移前 26 仓 main 已推 | 26/26 仓 owner 变为 `kore-pl`，tag/release 随仓迁移，旧 URL 302 | — | confirmed |
| 2026-11-23 | 在 Gitea（`gitea.iouf.cn/kore-pl`）建 26 仓并首次推送（三端拓扑：origin=Gitea / github / gitee） | verify-privilege | Gitea 组织与 26 仓（非文件写域） | 26 仓迁移完成 | 26 仓远端齐备、`git ls-remote` 三端一致 | — | confirmed |
| 2026-11-23 | 8 仓 production 升级（`container` 0.4.1 / `db-postgres` 0.3.1 / `dns` 0.3.1 / `integrity` 0.3.2 / `runtime-node` 0.2.3 / `runtime-python` 0.2.3 / `ssh-guard` 0.2.3 / `waf` 0.3.1）——`rel-container` 3 个 / `impl-backup` 2 个 / `impl-file` 2 个 + `release-r5` 1 个 | 各仓 owner（见备注） | 各插件仓 `info.json` / `CHANGELOG.md` / `tests/fault/` | 各仓功能补全完成 | 8 仓 `depth_level: production` + `tests/fault/` 实跑 + dist 可复现 | 各仓 CHANGELOG / `RELEASE-EVIDENCE.md` | confirmed |
| 2026-11-23 | 索引第 35 次重签（8 条新版本 + 新公钥 `8c1578e`） | verify-privilege（接手） | `kore-plugins/index/`、`kore-plugins/scripts/`、`kore/internal/core/market/verify.go` | 8 仓 dist 就绪 | 第 35 把签名 + 8 条索引 + 三端已推（`kore` @ `8c1578e`、`kore-plugins` @ `f586c0e`） | `8c1578e` / `f586c0e` | confirmed |
| 2026-11-23 | process 视图 P0（主壳前端适配 `process` 0.2.1） | container-view | `web/process.js`、`web/shell.js` | process 0.2.1 方法就绪 | 视图接线 + 双端截图，commit `c43aed6` | `c43aed6` | confirmed |
| 2026-11-23 | Issues 体系（Gitea 权威源）：`kore` 5 个 + 插件仓 3 个，标签 8 个 | architect | `.agents/BOARD.md` §9.1、Gitea issue | 无 | 8 issue 建成并回填 BOARD；GitHub 8 个加迁移标注 | `9118249` + 本批 | confirmed |
| 2026-11-23 | 文档 GitHub URL 迁移（仓库地址 → `kore-pl`，module 路径保持 `pengtang1024`） | architect（`8c3265e`）+ release-r5 | `docs/`、`.agents/`、`README.md`、`AGENTS.md` | 迁移完成 | 13 文件提交；136 个 `.go` import 误改已回退，`go build`/`go vet` exit 0 | `8c3265e` / `2e17105` / `3876009` / `9118249` | confirmed |

| 2026-11-23 | Round 7 · 零侵入阶段 B（kore uninstall 卸载链：unit/userdel/结构化账本） | implementer（零侵入 B 轨） | `internal/core/installer/`、`cmd/kored/`、`.agents/verify/` | 零侵入 A（ADR-0023） | 卸载链 + 结构化账本 + 验收证据；`593d224` + `1e1ad76` | `593d224` / `1e1ad76` | confirmed（三端已推） |
| 2026-11-23 | Round 7 · WAF 视图（第 18 个视图）+ R5-2 基线口径更正 | implementer（WAF 轨） | `web/waf.js`、`web/shell.js`、`web/i18n/`、`docs/verify` | 视图框架 | WAF 视图接线 + 基线口径更正（原 sha 是权限错误文本）；`60307af` + `30a7f89` | `60307af` / `30a7f89` | confirmed（三端已推） |
| 2026-11-23 | Round 7 · file 视图补搜索/回收站/改名/复制 | implementer（file 视图轨） | `web/files.js`、`web/shell.js` | file 插件 0.3.0 | 四项操作接线 + 双端验收；`a960749` | `a960749` | confirmed（三端已推） |
| 2026-11-23 | Round 7 · 降权 P0 双修（独立通道 socket + 安装 mode 归一） | kore-verify-privilege（接手） | `internal/core/privilege/`、`internal/core/installer/` | 降权基线（`6ceeba8`） | `kore-channel.sock` 0660 `root:kore` + 四关校验；安装文件 mode 归一；`2310226` | `2310226` | confirmed（三端已推） |
| 2026-11-23 | Round 7 · 推送收口（三端） | release-r5 / scribe | `kore` 三端（origin=gitea → github → gitee） | 上述四轨 | 三端推送回读一致、`make check` 13 段、主实例重启复核 healthz/商店全绿、三端一致性 0/78；本批台账提交 | 本次提交 | confirmed |


## 未回收与待补

1. **`internal/core/config` / `registry` 的派发记录缺失**：文件已落盘（2026-11-22 00:2x），但会话内没有对应的 `team_task_*` 或派发消息可引；owner 列留 `—`，等 lead 补登记后再回填。
2. **`90c5936` 的 owner 为推断**：commit 署名不区分角色；按改动文件（协议正文 + ADR + 提案）推断为 `kore-architect-m1`。
3. **`6fdaedd` / `02d0154` 的 owner 为推断**：两笔均只改 `cmd/kored/`，与 `kore-impl-runtime` 写域一致，但无派发记录。
4. **M1 各 implementer 任务的 `blocked_by`**：以 `proposals/0001` §3 任务表的依赖列为准（如 M1-02 ← M1-01、M1-12 ← M1-09/10/21），本表不重复展开。
5. **`case-check` 规则 3 与 ADR / 台账的必要引用冲突**：`Kore-Project` 作为"被否决的组织名"必须被点名，规则却按旧仓库名告警（当前 1 warn）；待 owner 决定"加豁免标注"还是"允许 WARN 长期存在"，**不靠改写历史消警**。
