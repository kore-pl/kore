# .agents · 任务板

> 状态: draft · 归属: scribe · 更新: 2026-11-22 · 里程碑: M5

任务板是唯一事实源：谁在做什么、卡在哪、凭什么叫完成，都以本文件为准。对话里的口头约定不算。

## 1. 字段定义

| 字段 | 含义 | 填写规则 |
| --- | --- | --- |
| `id` | 任务编号 | `<里程碑>-<轨道>`，如 `M0-A`、`M1-C2`；同一里程碑内不重复 |
| `subject` | 一句话任务标题 | 动词开头，能独立看懂，不含"相关""优化一下"这类模糊词 |
| `owner` | 责任角色 | 必须是 lead / architect / implementer / verifier / red-team / scribe 之一 |
| `status` | 状态 | `pending` / `in_progress` / `completed` / `blocked` |
| `scope` | 写域 | 允许改动的文件或目录前缀，逗号分隔；跨多个目录时逐个列出 |
| `blocked_by` | 前置任务 | 依赖任务 id 列表，全部 complete 才能开工；无依赖写 `—` |
| `变更集` | 跨仓库变更集编号 | 单仓库任务填 `—`；跨仓库任务填 `CS-<YYYYMMDD>-<序号>`，且「变更集登记区」有对应行 |
| `evidence` | 交付证据 | 命令原文 + 退出码 + 关键输出 3 行；文档任务写文件清单 + 行数 |
| `revision` | 版本号 | 每次状态或字段变更 +1；claim / complete 必须带当前 revision |

## 2. 状态机与合法转移

| 从 | 到 | 条件 | 执行者 |
| --- | --- | --- | --- |
| pending | in_progress | `blocked_by` 全清、`scope` 与同层任务不相交 | owner（claim） |
| in_progress | blocked | 等外部依赖 / 等他人写域释放，写清阻塞原因 | owner |
| blocked | in_progress | 阻塞条件已解除 | owner（claim） |
| in_progress | completed | evidence 齐备且验收通过 | owner 提交 + lead/verifier 确认 |
| completed | pending | reopen：发现回归、证据不足、蓝军问题单未签收 | lead |
| pending | completed | 不允许：没有执行的完成是伪造 | — |
| blocked | completed | 不允许：跳过执行阶段 | — |

非法转移一律打回，并把原因写进任务备注。

## 3. WIP 限制

- `in_progress` 总数 ≤ 5；到上限时先完成或阻塞，不许继续开新任务。
- 同一层并行任务的 `scope` 不得相交；相交即视为冲突，必须串行化（用 `blocked_by` 表达顺序）。
- 一个任务只允许一个 owner；需要两人协作时拆成上下游两个任务。

## 4. 里程碑记录与轨道快照

### 4.1 里程碑记录

里程碑只有在「轨道全部 completed + 独立验收报告 PASS + JOURNAL 复盘段落盘 + 台账齐备 + 变更集无未闭环 P0」五条同时满足时才可置 `completed`（G-07 / G-23 / G-15）。第五条是 2026-11-22 收口时新加的：M1 的验收报告运行时 PASS，但登记后发现发布链 P0（`pkg/pluginapi/v0.1.0` 内容为旧 module 路径），按「发布物不可用即变更集未完成」处理。

| 里程碑 | 名称 | 状态 | 收口日期 | 证据 |
| --- | --- | --- | --- | --- |
| M0 | 文档与骨架 | completed | 2026-11-21 | [verify/m0-consistency-r5.md](verify/m0-consistency-r5.md)（PASS）；[JOURNAL.md](JOURNAL.md) 2026-11-21 两条 M0 复盘 |
| M1 | 行走骨架 | completed | 2026-11-22 | [verify/m1-final-acceptance.md](verify/m1-final-acceptance.md)（运行时 VERDICT PASS）；[JOURNAL.md](JOURNAL.md) 2026-11-22「M1 里程碑复盘」§4.5 / §5；[docs/MILESTONE-M1.md](../docs/MILESTONE-M1.md)。**收口补正（2026-11-22）**：收口时因发布链 P0（`pkg/pluginapi/v0.1.0` tag 内容声明旧 module 路径，`GOWORK=off` 干净 clone 报 `module declares its path as: github.com/kore-project/... but was required as: github.com/kore-pl/...`）临时降为 blocked；处置为 `retract v0.1.0` + 发 `pkg/pluginapi/v0.1.1`，echo 升 v0.1.1 后干净 clone `build` / `dist` 通过，`CS-M1-01` 置 confirmed |
| M2 | 站点插件 / 商店 / 8 预设 / Web 壳 / Lazy 生命周期 | completed | 2026-11-22 | [verify/m2-cross-repo-acceptance.md](verify/m2-cross-repo-acceptance.md)（VERDICT APPROVE，1 项阻断 B1 + 3 记录，阻断当日修复复验）；[JOURNAL.md](JOURNAL.md) 2026-11-22「M2 里程碑复盘」§2/§3；`make check` 10/10；首屏 4151 B；lazy 6 PASS；market 真服务 200/404/501/401；两对 sha 一致；变更集 `CS-M2-01`（见 §5） |
| M3 | 本机加固 / 证据补齐 / audit 可观测 | completed | 2026-11-22 | [JOURNAL.md](JOURNAL.md) 2026-11-22「M3 里程碑复盘」§2/§3/§5；`make check` 10/10；lazy 两轮冷启 p95 2.87 / 3.68 ms（20/20 真冷启）；audit 5 PASS + 事件注入后 idle CPU 0 ms；store 三端点 21 测试全绿；web server 共存 `env_kind=container → PARTIAL`（不冒充 real）；四仓 commit 与新公钥、P0 修复登记于变更集 `CS-M3-01`（见 §5）；**未证明项挂账：真实宿主 / echo audit CLI / subject 语义局限** |
| M4 | 本机加固四轨道（capability 根因 / site 生产化 / audit 查询 / 包签名判定） | completed | 2026-11-22 | [JOURNAL.md](JOURNAL.md) 2026-11-22「M4 里程碑复盘」§2/§3/§5；`make check` 10/10、干净 clone 复验 10/10 + `make wt-check` 无残留；M4-A PoC ① `200 → 401`、12/12 包 + race 全绿；M4-C audit 15 PASS + AUDIT-OPEN 判据 `OK`；M4-B site S-02 真 nginx 容器全量 `nginx -T` diff 空、curl 200、端口释放（`grep -rnE "nginx\|caddy\|httpd" internal/ cmd/` 零命中）；M4-D 包签名判延 M5（`DEFER-TO-M5`）；第五次重签 + 新公钥 `adb9998e…b442a4`、site 新 sha `ff9c2c16…d484` 登记于变更集 `CS-M4-01`（见 §5）；独立复验 APPROVE；**未证明项挂账 M5：真实宿主 `env_kind=real` / 包签名 / audit O(n) 全表扫描 / CSRF 审计持久化挂点** |
| M5 | 生态开放（M5-A 补 19 插件仓功能覆盖 + M5-B 市场页 / SDK / 文档站） | completed（全链 confirmed） | 2026-11-22 | [JOURNAL.md](JOURNAL.md) 2026-11-22「M5 里程碑复盘」§2/§3/§5；`make check` 10/10、`make docs-check` / `make log-check` 全绿；三批 19 仓（8/7/4）全落盘、各仓 sha lead 独立核验 + tar 首条目 `info.json`、生产级四类 fault / 基础级两类、确定性打包四层坑收敛；第八次重签公钥 `2917cf3c…bab`、索引 21 插件、8 预设 0 FAIL/0 WARN；M5-B 市场页 `65f1d85`（21 插件内嵌、零外链、`file://` 可开）、SDK 文档 180 行、文档站 39 条；变更集 `CS-M5-01`（见 §5）。**远端推送挂账**：9 仓受 GitHub secondary rate limit 阻断（request ID `AF3E:0E54…`），15:00 定时任务重试，本地全就绪、发布链待复核后才置 `confirmed`；9 仓远端推送 14:33 全成功、ls-remote 回读全匹配，原限流挂账解除；**未证明项挂账：真实宿主 `env_kind=real` / 包签名 / audit 索引 / CSRF 审计持久化挂点**。tag 裁决见 DECISIONS 第 44 条 |

### 4.2 M0 轨道（7 条，已收口）

快照时间 2026-11-21 21:50（多仓库拓扑修订后）。evidence 中的行数是该时点实测值；文档再改动时由 scribe 在下一次归档刷新。`status` 表示验收事实：A–F 已交付并过 G4；M0-G 依赖已全部解除、正在产出验收报告。`revision` 为本次状态登记的版本（每次状态或字段变更 +1）。**M0 的交付边界只有 `kore` 这一个仓库**：`kore-plugins` 与 `kore-plugin-echo` 属 M1，`kore-plugin-site` / `kore-plugin-backup` 属 M2，均不在本板。

| id | subject | owner | status | scope | blocked_by | 变更集 | evidence | revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0-A | 愿景 / 总体架构 / 内核规格 / 术语表 | architect | completed | `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/CORE.md`, `docs/GLOSSARY.md` | — | — | `wc -l docs/{VISION,ARCHITECTURE,CORE,GLOSSARY}.md` → 退出码 0；178 / 348 / 286 / 172 行 | 3 |
| M0-B | 插件协议 / 资源模型 / 数据模型 | architect | completed | `docs/PLUGIN-PROTOCOL.md`, `docs/RESOURCE-MODEL.md`, `docs/DATA-MODEL.md` | — | — | `wc -l docs/{PLUGIN-PROTOCOL,RESOURCE-MODEL,DATA-MODEL}.md` → 退出码 0；350 / 205 / 268 行；帧 = 4B 长度 + JSON、无额外帧头（ADR-0002 / ADR-0007） | 3 |
| M0-C | 前端架构 / 安全模型 / 8 篇 ADR | architect | completed | `docs/FRONTEND.md`, `docs/SECURITY.md`, `docs/DECISIONS/` | — | — | `wc -l docs/{FRONTEND,SECURITY}.md` + `ls docs/DECISIONS/` → 退出码 0；253 / 216 行；ADR 0001–0008 共 8 篇、无重号（0008 = 多仓库拓扑） | 3 |
| M0-D | 路线图 / 执行计划 / M0 清单 | lead | completed | `docs/ROADMAP.md`, `docs/PLAN.md`, `docs/MILESTONE-M0.md` | — | — | `wc -l docs/{ROADMAP,PLAN,MILESTONE-M0}.md` → 退出码 0；191 / 227 / 169 行 | 2 |
| M0-E | AGENTS.md + agent 管理架构 | scribe | completed | `AGENTS.md`, `README.md`, `.agents/` | — | — | `wc -l AGENTS.md README.md` → 退出码 0；86 / 150 行；`.agents/` 体系文档 6 份 + 模板 4 份；`make docs-check` 退出码 0（6 pass / 0 fail，35 份文档 / 8 篇 ADR） | 4 |
| M0-F | 仓库骨架 / 门禁脚本 | implementer | completed | `.gitignore`, `.editorconfig`, `Makefile`, `scripts/` | — | — | `grep -E '^APP' Makefile; grep -E '^BIN' Makefile` → 退出码 0；`APP ?= kored` / `BIN ?= ./bin/kored`；`bash scripts/docs-check.sh` → 退出码 0（6 pass / 0 fail）；`git rev-list --count HEAD` → 退出码 128（0 commit，HEAD 未出生，符合 M0） | 3 |
| M0-G | 独立验收 + 首提交 | verifier | completed | `.agents/verify/` | M0-A, M0-B, M0-C, M0-D, M0-E, M0-F | — | `make check` 5/5（docs-check 55 份 6 pass / 0 warn / 0 fail；repo-check 5 pass；canonical-check 7 pass）；`git commit 7404ad1`（59 文件 / 8,193 insertions，排除 proposals/reviews 3 件）；`git status --short` 仅剩 M1 未跟踪件；报告 `m0-consistency-r5.md`（99 行） | 3 |

轨道说明：

- M0-A：定"做什么不做什么"，是其余所有文档的上游。
- M0-B：定协议、资源、数据三条硬契约，实现阶段直接照抄。
- M0-C：定前端与安全边界，8 篇 ADR（0001–0008，含多仓库拓扑）承载不可逆选择。
- M0-D：定排期与验收口径，把 M0 拆成可执行 WBS。
- M0-E：定协作规则本身（本文件即其产物之一）。
- M0-F：定仓骨架与门禁脚本，让后续每条命令都有落点。
- M0-G：独立复跑 `make docs-check` + 交叉一致性核对 + 精确提交，**依赖 A–F 全部完成**。

### 4.3 M1 轨道（7 条，已收口）

快照时间 2026-11-22 02:05（M1 收口）。evidence 为收口实测值；M1 的交付边界是 `kore` + `kore-plugin-echo` 两个仓库，索引仓 `kore-plugins` 未在 M1 落地（`index/plugins.json` 仍归 M2）。

| id | subject | owner | status | scope | blocked_by | 变更集 | evidence | revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1-A | 协议与公开 SDK：frame / envelope / timeout + 嵌套 module | implementer | completed | `pkg/pluginapi/` | — | CS-M1-01 | 705 行 / 10 文件；`go test -count=1 ./pkg/pluginapi` ok；重发 tag `pkg/pluginapi/v0.1.1`（`90e9fdd`，含 `retract v0.1.0`；首版 `v0.1.0` 已废弃）；根 `go.mod` `replace => ./pkg/pluginapi` | 2 |
| M1-B | 内核 7/9 模块 + envprobe / platform 支撑包 | implementer | completed | `internal/core/`, `internal/platform/` | — | — | `internal/core` 7,414 行 + `platform` 880 行；`go test -count=1 ./...` 10 包全 ok；auth / market 未做，`routes()` 回 501 | 1 |
| M1-C | `cmd/kored` 装配：`install` / `serve` 子命令 | implementer | completed | `cmd/kored/` | M1-B | — | 20 文件 1,910 行；11 步 E2E（验收报告 §C）全通过 | 1 |
| M1-D | 9 段门禁接线（含 canonical / oss / case） | implementer | completed | `Makefile`, `scripts/` | M1-B | — | `make check` **9/9**：docs 6 / dep 2 / thin-shell 4 / repo 5 / canonical 9 / log 8 / wt 4 / oss 8 / case 5 | 1 |
| M1-E | 开源六件套 + CI 模板 | scribe | completed | `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `.github/workflows/` | — | — | `make oss-check` 8 pass / 0 warn / 0 fail | 1 |
| M1-F | 跨仓库：echo 验证插件 + 首次公开 | implementer | completed | `../kore-plugin-echo` | M1-A | CS-M1-01 | 首版 `make dist` → `echo-0.1.0.tar.gz` 1,258,020 B + `.sha256`；重发 `v0.1.1`（`10cc6eb`，依赖 SDK v0.1.1）→ `echo-0.1.1.tar.gz` 1,258,133 B，干净 clone `GOWORK=off make build` / `make dist` 退出码 0；`git ls-remote` 双仓 main 可达 | 2 |
| M1-G | 独立验收（verifier ≠ implementer） | verifier | completed | `.agents/verify/` | M1-A…F | — | [verify/m1-final-acceptance.md](verify/m1-final-acceptance.md) VERDICT PASS、阻断 0；`make mem MEM_POINTS=60` 中位 9,664 KiB | 1 |

轨道说明：M1-A 冻结协议面（SDK 先于内核发版）；M1-B 是主链，auth / market 的缺席见 [JOURNAL](JOURNAL.md) M1 段第 5 节；M1-C 只做装配不写业务；M1-D 让每条命令都有落点；M1-E 满足 G-26 发布红线；M1-F 证明"插件只依赖公开 SDK"成立；M1-G 由非实现者复跑全部命令。

### 4.4 插件轨道（M1 起启用）

M1 之后 18–22 个插件仓各自一张卡，**一个仓库一个 owner**，与内核轨道分开统计；下面的表头即模板，逐行填：

| 仓库 | 插件 id | owner | 里程碑 | 状态 | evidence |
| --- | --- | --- | --- | --- | --- |
| `kore-plugin-<id>` | `<id>` | implementer（一仓一人） | M1 / M2 | pending | `make dist` 退出码 + 安装/hello/invoke/卸载五步记录 |

规则：同里程碑并行插件仓 ≤ 4；索引（`kore-plugins`）不单独占行，跟随变更集收尾。

## 5. 变更集登记区

跨两个及以上仓库的一次改动登记在这里（格式见 [WORKFLOW.md](WORKFLOW.md) §10）。单仓库任务不占位。

| 变更集 | 目标 | 涉及仓库（tag / commit） | kore 协议影响 | 合并顺序 | 验收方式 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| — | M0 只交付 `kore` 单仓库，暂无变更集 | — | — | — | — | — |
| CS-M1-01 | M1 首次公开发布：kore 内核与 echo 验证插件上线 GitHub public 仓库 | `kore` @ `90e9fdd`（tag `pkg/pluginapi/v0.1.1`；首版 `pkg/pluginapi/v0.1.0` → `3a59b98` 已 retract）；`kore-plugin-echo` @ `10cc6eb`（tag `v0.1.1`；首版 `v0.1.0` → `3422c10`） | 无协议变更（首次发布；module 路径统一为 `github.com/kore-pl/*`） | `kore`（main + SDK tag）→ `kore-plugin-echo`（main + tag） | 本地 `make check` 9/9、`go build`/`go test` 通过；`git ls-remote` 双仓可达。**收口补正**：SDK v0.1.0 因 module 路径缺陷 retract，已发 v0.1.1；echo 升 v0.1.1 并干净 clone 验证通过。`GOWORK=off go get ...@v0.1.1` 退出码 0（`GOPROXY=direct` / `proxy.golang.org` 双路径）；`go list -m -versions` 仅列 v0.1.1；`/tmp` 干净 clone `GOWORK=off make build` / `make dist` 退出码 0 | confirmed |
| CS-M2-01 | M2 五轨收口：site 插件 / 索引仓 market + 签名链 / 8 预设 / web 壳 / lazy 生命周期，含 B1 确定性打包修复与新公钥重签 | `kore` @ `7caa85a`（内核 + 新公钥 `verify.go` + 验收报告）；`kore-plugins` @ `e945aca`（索引 sha 重签 + 8 预设）；`kore-plugin-site` @ `d1690af`（确定性 `dist`）；`kore-plugin-echo` @ `9546a4f`（确定性 `dist`） | 无协议破坏性变更；**新公钥 `faf3a743…1439` 同步内核 `verify.go:16` 与索引 `validate-index.sh:10`，两端 `grep` 逐字相同**；索引 echo/site 两对 sha 与重建包一致 | `kore` 内核先行（新公钥 + market 端点 + verify.go）→ 四仓并行推送（`kore-plugins` 索引重签、`kore-plugin-site` / `kore-plugin-echo` 确定性打包）；新公钥与双 sha 同批发布，禁止新旧混用 | `make check` 10/10 段全绿、首屏 4151 B、lazy 6 PASS、market 真服务 200/404/501/401、验签正反例 3 PASS + 默认拒 2 PASS、8 预设 0 FAIL/0 WARN、两对 sha 一致；详见 [verify/m2-cross-repo-acceptance.md](verify/m2-cross-repo-acceptance.md) 与 [JOURNAL.md](JOURNAL.md) M2 复盘 §2 | completed |
| CS-M3-01 | M3 四轨收口：本机加固 / 证据补齐（web server 共存 PARTIAL、lazy 冷启 p95、audit 写入、store 三端点），含打包第四层 `./` 根条目 P0 修复与索引双 sha 第四次重签 | `kore` @ `399ac9b`（M3-B p95 + M3-D store 三端点）→ `97d07c0`（索引双 sha 第四次重签 + 新公钥轮换）→ `ac82418`（M3-C audit 写入 + 事件持久化测试）；`kore-plugins` @ `0e7c2b9`（索引 sha 重签 + 新公钥同步）；`kore-plugin-echo` @ `2011ea8`、`kore-plugin-site` @ `2a7fa51`（`dist` 去 `./` 根条目 + 重建） | 无协议破坏性变更；**打包侧显式列条目去掉 `./` 根条目（不放宽 installer `safePath`）**；新公钥轮换后内核与索引校验脚本两端同步，索引 echo/site 双 sha 第四次重签 | `kore` 内核先行（B/D 轨道 → 重签 → audit）→ `kore-plugins` 索引重签 → `kore-plugin-echo` / `kore-plugin-site` 去 `./` 重建 dist；新公钥与双 sha 同批发布，禁止新旧混用 | `make check` 10/10、lazy 两轮 p95 2.87 / 3.68 ms（20/20 真冷启）、audit 5 PASS + 事件注入后 idle CPU 0 ms、store 21 测试全绿、web server 共存 `env_kind=container → PARTIAL`、安装复验 echo/site `exit 0` 且 `tar` 首条目 `info.json`；详见 [JOURNAL.md](JOURNAL.md) M3 复盘 §2/§5。**未证明项挂账：真实宿主 `env_kind=real`、echo audit CLI、subject 语义局限** | completed |
| CS-M4-01 | M4 四轨收口：capability 根因修复（PoC 200→401）/ site 生产化真写 vhost（S-02 真 nginx 全量 diff 空）/ audit 查询端点 + CLI（15 测试）/ 包签名判定延 M5，含第五次重签与新公钥 `adb9998e…b442a4` | `kore` @ `99268d9`（M4-A capability 校验）→ `d7af021`（M4-C audit 查询 + CLI）→ `f3b3371`（M4-D 包签名延 M5 判定）→ `c0ab71a`（第五次重签：新公钥同步 `market/verify.go:16`）；`kore-plugins` @ `9d09e56`（第五次重签：site 生产化新 sha + 新签名）；`kore-plugin-site` @ `199942b`（M4-B 生产化 vhost 写入 + 原子回滚） | 无协议破坏性变更；**新公钥 `adb9998e4281118f297ecef2505b81e3b58637ce4e78c4ed1698fa5b61b442a4` 同步内核 `verify.go:16` 与索引 `validate-index.sh:10`，两端 `grep` 逐字相同**；site 新 sha `ff9c2c1698e2e63ecfa7e384f539483224297efff68d85dd9a6c73a0f539d484` = 实包 `sha256sum` = 索引声明，第五次重签 | `kore` 内核先行（A → C → D 判定 → 重签新公钥）→ `kore-plugins` 第五次重签（新 sha + 新签名）→ `kore-plugin-site` M4-B 生产化落地；新公钥与 site 新 sha 同批发布，禁止新旧混用 | `make check` 10/10、干净 clone `make docs-check && make check` 10/10 + `make wt-check` 无残留、PoC ① `200 → 401` + 12/12 包 + race 全绿、audit 15 PASS + AUDIT-OPEN 判据 `OK`、site S-02 真 nginx 容器全量 `nginx -T` diff 空 + curl 200 + 端口释放、包签名 `DEFER-TO-M5` 附证据；详见 [JOURNAL.md](JOURNAL.md) M4 复盘 §2/§5 与 [verify/m4-cap-independent-verification.md](verify/m4-cap-independent-verification.md) / [verify/m4-c-independent-verification.md](verify/m4-c-independent-verification.md) / [verify/m4-d-package-signing-decision.md](verify/m4-d-package-signing-decision.md)。**未证明项挂账 M5：真实宿主 `env_kind=real` / 包签名 / audit O(n) 全表扫描 / CSRF 审计持久化挂点** | completed |
| CS-M5-01 | M5 三批 19 仓 + 三批重签 + M5-B 生态开放收口：三批 19 仓（8/7/4）全落盘、第八次重签新公钥 `2917cf3c…bab`、索引 21 插件（20 产品 + `echo`）、8 预设覆盖 21 插件、市场页 / SDK / 文档站；9 仓远端推送 14:33 全成功 confirmed | `kore` @ `3e7e821`（批1 第六次重签，公钥 `f271723a…`）→ `8795079`（批2 第七次重签）→ `baf57ef`（批3 第八次重签，公钥 `2917cf3c…bab`）→ `081d0c1`（M5-B SDK 文档 + 文档站）；`kore-plugins` @ `4e20ce9`（批1 索引 10 插件）→ `1ad7b6d`（批2 索引 17 插件）→ `d7c51d1`（批3 索引 21 插件）→ `65f1d85`（M5-B 静态市场页）→ `55bdd88`（8 预设扩引用 21 插件）；19 插件仓各一 commit（批1 sha 见 [verify/m5-batch1-sha-evidence.md](verify/m5-batch1-sha-evidence.md)） | 无协议破坏性变更；**新公钥 `2917cf3c5b8d6bea10ed9460702c23cb411d15947072cd5a2869667e22028bab` 同步内核 `verify.go:16` 与索引 `validate-index.sh:10`，双端唯一 + 交集唯一 + 交叉验签存在**；三批一批一签，索引 10 → 17 → 21 插件；`size_bytes` 按索引 sha 对应版本包 `stat`；`firewall` / `waf` / `container` / `app-deploy` 用静态 `manifest.json` 解耦 `go:embed` 自指震荡 | `kore` 内核每批重签先行（新公钥 → 交叉验签）→ 对应批插件仓出包 → `kore-plugins` 索引重签 → 下一批；M5-B 市场页 / 预设扩引用在批3 后收尾；新公钥逐批轮换、禁止跨批混签与新旧混用 | `make check` 10/10、`make docs-check` / `make log-check` 全绿；三批 sha lead 独立核验 + tar 首条目 `info.json`、生产级四类 fault / 基础级两类、确定性打包固定迭代收敛；公钥双端唯一、索引 21 条、8 预设 0 FAIL/0 WARN；市场页 `file://` 可开零外链、SDK 180 行、文档站 39 条；详见 [JOURNAL.md](JOURNAL.md) M5 复盘 §2/§5。**远端推送挂账**：9 仓受 GitHub secondary rate limit 阻断（request ID `AF3E:0E54…`），15:00 定时任务重试，本地全就绪、推完复核再置 `confirmed`；**未证明项挂账：真实宿主 `env_kind=real` / 包签名 / audit 索引 / CSRF 审计持久化挂点** | completed（confirmed） |
| CS-R2-01 | R2 产品补全：以 [PLUGIN-MATURITY.md](../docs/PLUGIN-MATURITY.md) 为唯一依据，把 22 能力域从现状（L0 10 / L1 10 / L2 2 / L3 0）推进到 L2，按该文档 §4 五批执行：主壳通用地板 → 文件域 → 站点+SSL → 10 个 L0 域拉 L1 → 管理与索引收口 | `kore` @ `9684127`（本轮仅落文档：PLUGIN-MATURITY 148 行 + ROADMAP §7.7 + AGENTS 索引）；后续批次按 §4 依赖顺序跨 `kore` 与各插件仓，逐批补行 | 无协议变更 | 本轮单仓文档先行；R2-1..R2-5 依 §4「前置依赖」列推进，R2-2/R2-3 依赖 R2-1 组件，R2-5 依赖 R2-4 的数据通路 | `make docs-check` exit 0（6 pass / 0 warn / 0 fail）；`wc -l docs/PLUGIN-MATURITY.md` = 148 ≤ 200；`wc -l AGENTS.md` = 128 ≤ 132；方法数 74 / 视图数 14 / noop 执行器 10 仓可按 §5 命令复现 | in_progress |
| CS-R2-02 | R2 收口：24 插件仓按代码事实现级别重判（L0 9 / L1 1 / L1.5 10 / L2 3 / L3 0），主壳 16 视图 / 四组导航 / 统一配置面板 / 自动预填；新增 §3.5 七条缺口与 Round 3 五批 | `kore` @ `7b85228`（数据库/Redis 自动检测与一键连接预填）→ `89ba1ea`（Redis/防火墙视图 + 16 导航）→ `53388e9`（文件/网站 L2 页 + camelCase）→ `c42f62f`（PLUGIN-MATURITY 161 行 + ROADMAP §7.7 + AGENTS 索引 + 本行；复现命令修正见本提交）；`file` @ `f1ddbe7`（L2）+`4d79618`；`site` @ `a022db6`（L2）+`0c5c820`（容器 nginx）+`035cedd`；`terminal` @ `a3f8604`；`container` @ `9f432ad`；`db-mysql` @ `8aa5634`；`redis` @ `7d30b00`+`590471d`；`logs` @ `f1ca141`+`41a0e0f`；`backup` @ `bc72ea7`+`2c0da69`；`firewall` @ `b0f71d1`；`ssl` @ `cb4097a`；`process` @ `64c75a2`；`cron` @ `6c35a93`+`dbeae8a`+`8b2f181`；`discover` @ `8292943` | 无协议变更（仅文档与盘点口径；Round 3 代码改动另立变更集） | 文档与盘点单仓先行；Round 3 按 [PLUGIN-MATURITY.md](../docs/PLUGIN-MATURITY.md) §3.4 五批跨仓推进，R3-2 起依赖 R3-1 的进度/告警底座 | `make docs-check` 6 pass / 0 warn / 0 fail；`make check` 10/10；`wc -l docs/PLUGIN-MATURITY.md` = 161 ≤ 220；`wc -l AGENTS.md` = 129 ≤ 132；方法 106 / 视图 16 / noop 7 仓 / config 5 仓可按 §6 命令复现 | completed |
| CS-R2-03 | Round 2 + Round 3 前段跨仓收口：提权通道 v0.x（`requires_root` / `root_actions` / status 经通道）/ privilege 拆分 / 第十六至十九次重签 / 16 项视图导航 / P0 热升级修复 / 数据库与 Redis 自动预填 / ADR-0018；firewall 0.2.2 发版并收口悬空 0.2.2 | `kore` @ `d398ad7`（提权通道 v0.x）→ `05f8036`（privilege 拆分）→ `0242ef6`（第十八次重签公钥 + RELEASE.md）→ `253dc4b`（第十七次公钥）→ `daee8ab`（第十六次公钥）→ `89ba1ea`（Redis/防火墙视图 16 项导航）→ `bf0b264`（P0 热升级修复）→ `7b85228`（数据库/Redis 自动预填）→ `d3cbaf5`（ADR-0018）→ `90e79b9`（第十九次重签公钥 `ced7ceed…4dc864`，firewall 0.2.2）；`kore-plugins` @ `40ba36b`（第十六次重签）→ `0453f99`（第十八次 + versions.lock）→ `d38862c`（第十九次：firewall 0.2.2 入索引 + versions.lock + 预设同步 + 市场页）；24 个插件仓：`app-deploy` @ `fe813f6`（0.1.1）；`backup` @ `d0e798f`（0.2.1）；`container` @ `3c93f0a`（0.2.0）；`cron` @ `98dca18`（0.2.1）；`db-mysql` @ `b17e845`（0.2.0）；`db-postgres` @ `633ab20`（0.1.1）；`discover` @ `f5aa5bb`（0.1.0）；`dns` @ `2b9f2b7`（0.1.1）；`echo` @ `89173ff`（0.1.2）；`file` @ `781e628`（0.2.1）；`firewall` @ `0733c9c`（0.2.2）；`integrity` @ `49e79ea`（0.1.1）；`logs` @ `2a05d48`（0.2.1）；`monitor` @ `db5fdc7`（0.1.1）；`process` @ `b40601f`（0.1.1）；`redis` @ `a4913c2`（0.3.0）；`runtime-node` @ `d05f178`（0.1.1）；`runtime-php` @ `1d1506a`（0.1.1）；`runtime-python` @ `1d29a75`（0.1.1）；`site` @ `e37b48e`（0.2.0）；`ssh-guard` @ `7145ed2`（0.1.1）；`ssl` @ `f2edaa8`（0.2.1）；`terminal` @ `f6cd22b`（0.1.1）；`waf` @ `a6f15cd`（0.1.1） | 无协议破坏性变更；**新公钥 `ced7ceedc52b0159da975ba16c6c103a7dff19f0f56991b0e3b393994b4dc864` 同步内核 `internal/core/market/verify.go` 与索引 `kore-plugins/scripts/validate-index.sh` 两端、`grep` 逐字相同**；firewall 0.2.2 dist sha `b632c8413e3f37960014cfe8c73e7a992370ac76849ab55450eefc1256cbf069`（size_bytes 2807821）在本地两次 dist 与 `git archive HEAD` 干净树复现逐字一致，release 资产 `curl -L` HTTP 200 + 同 sha | 插件仓（各自 bump / dist，firewall 先 push + tag `v0.2.2` + release）→ `kore-plugins`（索引 sha/size/url + versions.lock + 预设 + 第十九次重签 + 市场页）→ `kore`（verify.go 新公钥；因 verify.go 须匹配 kore-plugins 的签名，故最后合） | `make docs-check` exit 0；`make check` 10 段 exit 0；`bash ../kore-plugins/scripts/validate-index.sh` exit 0（24 条 / 版本单调 / id@version 唯一 / 签名正例）+ 篡改反例 exit 1；24 条 release 资产 `curl -L` HTTP 200 且 sha 全等，`BAD_COUNT=0`；隔离实例 `127.0.0.1:18868` `GET /store/plugins` 200 / 24 条、`firewall` 0.2.2、`POST /store/install` 200 `state=succeeded` `reload=reloaded`；版本表：`app-deploy@0.1.1`、`backup@0.2.1`、`container@0.2.0`、`cron@0.2.1`、`db-mysql@0.2.0`、`db-postgres@0.1.1`、`discover@0.1.0`、`dns@0.1.1`、`echo@0.1.2`、`file@0.2.1`、`firewall@0.2.2`、`integrity@0.1.1`、`logs@0.2.1`、`monitor@0.1.1`、`process@0.1.1`、`redis@0.3.0`、`runtime-node@0.1.1`、`runtime-php@0.1.1`、`runtime-python@0.1.1`、`site@0.2.0`、`ssh-guard@0.1.1`、`ssl@0.2.1`、`terminal@0.1.1`、`waf@0.1.1` | completed |
| CS-20261123-01 | P1 事故修复：`monitor` 误声明 `resident` 占满 `MaxSlots=3`，11 个 lazy 插件唤醒全部 429；monitor 改 `lazy` 发版 0.2.1 + 第二十二次重签 + 槽位保护设计债落档 | `kore-plugin-monitor` @ `0610afe`（tag `v0.2.1`，dist sha `fb153e56…16b5`，`lifecycle: resident → lazy`）；`kore-plugins` @ `3473bbb`（第二十二次重签，新公钥 `83383d66…1b38`，monitor 0.2.1 入索引 + versions.lock + 预设同步 + 市场页）；`kore` @ `a459ec3`（新公钥同步 `internal/core/market/verify.go` + RESOURCE-MODEL §2.6 / PLUGIN-MATURITY §3.5 第 9 条设计债） | 无协议破坏性变更；**新公钥 `83383d66931a145600fab1608899b07aef515aa1a8ccf40f85ee4630fccd1b38` 同步内核 `verify.go` 与索引 `validate-index.sh` 两端、`grep` 逐字相同**；monitor 仅改 `info.json.lifecycle`，方法契约不变（`monitor.system` 仍 200） | `kore-plugin-monitor`（bump → dist → push/tag `v0.2.1` → release）→ `kore-plugins`（索引 + 账本 + 预设 + 重签 + 市场页）→ `kore`（新公钥 + 设计债文档）；新公钥与索引签名同批，**重启 kored 前主实例商店 401** | 8787 现场：`POST /plugins/monitor/disable` 后 `supervisor.resident 3→2`，`db-mysql.instances` 429 → 200（file/logs/cron 同批复验可调）；monitor dist 两打 + `git archive HEAD` 干净树复现 sha 一致 `fb153e56…16b5`、size_bytes 1329601；插件仓 `make check` exit 0；`validate-index.sh` 正例 exit 0（24 条 / 基线 24 条 / 47 预设引用）+ 篡改反例 exit 1；24 条 release 资产 `curl -L` HTTP 200 且 sha 全等 `BAD_COUNT=0`；隔离实例 `127.0.0.1:18868`（新公钥二进制）`GET /store/plugins` 200/24 条、`POST /store/install monitor@0.2.1 download=true` 200 `state=succeeded`、`lifecycle=lazy`、空闲 `supervisor.resident=0`、`monitor.system` 200（`source=proc`，CPU 8.37%、61.3 GiB） | completed |
| CS-R4-01 | Round 4 收口：6 个 L0 插件去 noop（`db-postgres` / `app-deploy` / `integrity` / `runtime-node` / `runtime-php` / `runtime-python`）+ `monitor` 真实 `/proc` 采集 + 主壳全局搜索（四源）与操作审计入口；第 24–26 次重签公钥 | `kore` @ `a0193e6`（全局搜索 + 审计入口）→ `e9f938d`（登录与方法调用审计）→ `7534224` / `0b0a798` / `3d67439`（第 24–26 次重签：db-postgres / app-deploy / integrity + runtime-node 0.2.0）；`kore-plugins` @ `c8e4c6c` → `666b5c4` → `d94a3ec`（第 24–26 次重签，索引 24 条）；插件仓：`db-postgres` @ `65c98be`（tag `v0.2.0`，5 个入口）、`app-deploy` @ `7ba02d9`（`v0.2.0`，4 方法）、`integrity` @ `707baf9`（`v0.2.0`，4 方法）、`runtime-node` @ `66d079e`（`v0.2.0`，4 方法）、`runtime-php` @ `c941f5d`（`v0.2.0`，4 方法）、`runtime-python` @ `c5790c9`（`v0.2.0`，4 方法）、`monitor` @ `4487801`（真实 `/proc`，0.2.0；lazy 止血见 `CS-20261123-01`） | 无协议破坏性变更；`db-postgres` 0.2.0 新增配置契约 `config.get/set`（第 6 个 config 仓）；`runtime-php` / `runtime-python` 方法面收敛为 versions / info / projects / doctor（python 移除 `venv.create`）；各仓 `info.json` + `manifest.json` 版本同步 | 插件仓（bump → dist → push/tag → release）→ `kore-plugins`（索引 sha/size/url + versions.lock + 预设 + 重签）→ `kore`（新公钥 + 文档）；`runtime-php` / `runtime-python` 0.2.0 **尚未入索引**，待第二十七次重签 | 24 仓逐仓比对：22 条 `info.json.version == index.version`（两仓 0.2.0 vs 0.1.1）；业务方法实测 **127**（旧文档 106，复现命令见 `docs/PLUGIN-MATURITY.md` §6）；`make docs-check` exit 0、`make check` 11 段 exit 0；审计四类证据见 `.agents/verify/round4-audit.md` | in_progress |
| CS-R4-02 | db-postgres 0.2.1（空态 `hint` 引导）发版入索引 + 第二十八次重签（新公钥 `29746ec6…507ad3`）+ 索引 `discover` 0.2.0 `size_bytes` 校正 | `kore` @ `83adbbe`（空态引导 + 方法名契约文档，含 PG 前端方案 A）→ 本轮 `internal/core/market/verify.go` 新公钥 + 本登记；`kore-plugin-db-postgres` @ `1efdeac`（tag `v0.2.1`，dist sha `a92cc131…b9389`，size_bytes 1523427）；`kore-plugins` @ `feb6b26`（第二十八次重签 + db-postgres 0.2.1 入索引 sha/size/url + versions.lock + db-only/full 预设 + 市场页 + discover size 校正） | 无协议破坏性变更；`db-postgres.instances` 新增可选 `hint`（空态 / 全部不可达时给出可操作引导），调用仍 200、空列表不是错误 | 插件仓（push main → tag `v0.2.1` → release）→ `kore-plugins`（索引 + 账本 + 预设 + 重签 + 市场页）→ `kore`（新公钥 `verify.go` + 本登记）；新公钥与索引同批发布，**重启 kored 前主实例商店 401** | `validate-index.sh` 正例 exit 0（24 条 / 基线 24 / 47 引用 / ed25519 通过）+ 篡改反例 exit 1；24 条 release 资产 `curl -L` 200 + sha + size 全等 `BAD_COUNT=0`；干净 clone `v0.2.1` → `make dist` sha `a92cc131…b9389` 一致；隔离实例 `127.0.0.1:18853` store 200 / 24 条、`db-postgres` 0.2.1、install 200 `succeeded`/`reloaded`、`invoke instances` 200 带 `hint`（`count=0`）；`make check` 11/11、插件仓 `make check` exit 0；详见 [verify/resign-28.md](verify/resign-28.md) | completed |
| CS-20261123-02 | `echo` 验证插件 `lifecycle: resident → lazy` 发版 0.1.3 + 第三十次重签（新公钥 `e9d42c82…6b7e`）：验证工具不该消耗被验证的资源，不占 resident 槽位 | `kore-plugin-echo` @ `9074a7e`（tag `v0.1.3`，dist sha `ed27b786…bb412`，size 1250461，`lifecycle: resident → lazy`）；`kore-plugins` @ `1ea27b6`（第三十次重签，echo 0.1.3 入索引 sha/size/url/lifecycle + versions.lock + full/dev 预设 + 市场页）；`kore` @ `96d5852`（新公钥同步 `internal/core/market/verify.go`）+ 本轮 BOARD 登记与 [verify/resign-30.md](verify/resign-30.md) | 无协议破坏性变更；echo 仅改 `info.json.lifecycle`（resident→lazy），方法契约不变（`echo.ping` 仍 200 `{"pong":true}`） | `kore-plugin-echo`（bump 0.1.3 → dist → push/tag `v0.1.3` → release）→ `kore-plugins`（索引 + 账本 + 预设 + 重签 + 市场页）→ `kore`（新公钥 + 本登记）；新公钥与索引同批，**重启 kored 前主实例商店 401** | 槽位恢复（本任务核心）：隔离实例 18848 `site@0.2.0` + `terminal@0.1.1` 两个 resident（`resident=2/2`、`lazy_slots=1`）下 `echo.ping` **200**（修复前 enable 即 429）；lazy enable 不起进程（`resident=0`）、70s 空闲自退后再次 ping 200；echo dist 两打 + `git archive` + **clone tag `v0.1.3`** 三处 sha 一致 `ed27b7…bb412`；`validate-index.sh` 正例 exit 0（24 条 / 基线 24 / 47 引用）+ 篡改反例 exit 1；24 条资产 `curl -L` 200 + sha + size 全等 `BAD_COUNT=0`；echo 仓 `make check` exit 0、kore `make check` 11/11；详见 [verify/resign-30.md](verify/resign-30.md) | completed |
| CS-20261123-03 | 5 插件同批发版入索引 + 第三十一次重签（新公钥 `1605021f…0751`）：`backup` 0.2.1→0.3.0、`cron` 0.2.1→0.3.0、`dns` 0.1.1→0.2.0、`waf` 0.1.1→0.2.0、`ssl` 0.2.1→0.3.0 | 插件仓：`kore-plugin-backup` @ `9c7d58c`（tag `v0.3.0`，dist sha `201c424e…0a90c`，size 1524287）、`kore-plugin-cron` @ `a27fa27`（tag `v0.3.0`，sha `9104823a…288ee`，size 1512234）、`kore-plugin-dns` @ `b40776c`（tag `v0.2.0`，sha `49d25840…3061b9`，size 1571091）、`kore-plugin-waf` @ `ea2013d`（tag `v0.2.0`，sha `0df14e70…9cd85e`，size 2871268）、`kore-plugin-ssl` @ `3b0084f`（tag `v0.3.0`，sha `6e40c995…7309ac`，size 2465706，包内声明 2465705 Δ1 按实测入索引）；`kore-plugins`（索引 5 条 sha/size/url + versions.lock + 预设 12 处 + 第三十一次重签 + 市场页 + 新公钥 `validate-index.sh`）；`kore`（新公钥 `internal/core/market/verify.go`）+ 本登记与 [verify/resign-31.md](verify/resign-31.md) | 无协议破坏性变更；5 插件均 `lazy` 维持、方法契约不变；`waf` 0.2.0 体积 1.36→2.87 MiB 属新增 rootaction 通道与前端 | 插件仓 ×5（push/tag/release → curl 验证）→ `kore-plugins`（索引 + 账本 + 预设 + 重签 + 市场页）→ `kore`（新公钥 + 本登记）；**主实例 8787 重启前商店 401**，lead 需重启并升级 5 插件 | 四包/五包 dist 实测 sha+size 与报告一致；5 release `curl -L` 200+sha OK；`make presets-check` exit 0（8 预设 / 0 FAIL / 0 WARN）；`validate-index.sh` 正例 exit 0（24 条 / 基线 24 / 47 引用）+ 篡改反例 exit 1；24 条资产 curl `BAD_COUNT=0`；`make build` exit 0 + `strings` 闸门=1；隔离实例 18847：store 200/24 条 mismatch=0、5 插件版本正确、install 5/5 `state=succeeded`；干净树 clone 新 tag `make dist` 5/5 sha==索引；详见 [verify/resign-31.md](verify/resign-31.md) | completed |

| CS-20261123-04 | Round 5 并行收口：方法级 capability（§3.5 #12）+ 插件降权（§3.5 #13）+ 17 仓发版/能力补全 + 索引第 32/33 次重签（第 33 次 `b4f688b` 已双推）；**`kore` 侧 22+ commit 与 24 仓 main 均本地未推，发布链待批次收口** | `kore` @ `f086312`（R5-2 rootpolicy 形状表）→ `6ceeba8`（P0 插件降权，16 文件）→ `50d3681`（SDK v0.1.2 rootaction 进 tag）→ `1e0c10a`（SDK v0.1.3 pluginapitest）→ `8566d43`（新公钥同步 `market/verify.go`）→ `1cec22b`（PLUGIN-MATURITY 按代码事实重判）→ `f7bd150`（ADR-0018：root 执行器移除 `--pipe`）；并行支线 `67e99fd` / `aebabbf`（process 0.2.0 / 0.2.1）、`81e84d8` / `d661d68`（cron 0.4.0 / 0.4.1）、`2db5f92`（waf）；`kore-plugins` @ `b4f688b`（第 33 次重签：12 条版本入索引 + `versions.lock` + 预设同步 + 私钥销毁，**已双推**；第 32 次签 6 条后追加清单致作废）；插件仓 17 个版本：`redis` 0.5.0、`logs` 0.4.0、`container` 0.4.0、`process` 0.2.1、`cron` 0.4.1、`ssh-guard` 0.2.2、`backup` 0.4.0、`site` 0.3.1、`file` 0.3.0、`monitor` 0.3.0、`terminal` 0.2.0、`integrity` 0.3.0、`db-postgres` 0.3.0、`ssl` 0.4.0、`db-mysql` 0.3.1、`waf` 0.3.0、`runtime-php` 0.2.1（各仓 commit 见各仓 `RELEASE-EVIDENCE.md` / CHANGELOG，索引以 `b4f688b` 为准） | 无协议破坏性变更；方法级 `method_capabilities` 成为 24 仓口径（本批新增 logs / container / redis / ssl / integrity / db-postgres / file / monitor / terminal / site / ssh-guard）；**插件降权为 P0 安全修正**（`kore-<id>` 前缀 + 降级矩阵），不改变调用方契约；索引签名与 `kore` 新公钥同批（第 33 次） | 插件仓（bump → dist 两打 → tag 干净树复现 → 本地 commit/tag）→ `kore-plugins`（`versions.lock` + 12 条索引 + 第 33 次重签，已推）→ `kore`（新公钥 `verify.go` + 文档重判）；**推送收口**：24 仓 main + `kore` 22+ commit 待批次推，推送前不置 `confirmed` | 本地验收：`logs` 0.4.0 dist `274ef4c0…3069`（size 1,532,739）两跑一致 + tag 干净树复现一致；各插件仓 `make check` / `go test` 通过（证据见各仓 `RELEASE-EVIDENCE.md`）；`make docs-check` + `make log-check` 退出码见本轮收口提交；**待做**：`validate-index.sh` 正例/反例 + 24 条资产 `curl -L` + 隔离实例商店 12 条新版复核 + 第 34 次重签（waf 0.3.0 等未入索引） | in_progress |
规则：一行内写全「仓库 / tag 或 commit / 协议影响 / 合并顺序 / 验收方式」才允许置 `completed`；缺任一列视为未完成（G-15）。状态含义：`completed` = 变更集内仓库与顺序齐备、本地验收通过；`confirmed` = 已发布且干净 clone / `git ls-remote` 复验通过（里程碑收口口径，2026-11-22 由 verifier 报告与本节证据共同支撑）。

| CS-20261123-05 | 拓扑与发布链收口：GitHub 迁 `kore-pl` 组织 + Gitea 唯一权威源 + 8 仓 production 升级 + 第 35 次重签（8 条新版本）+ process 视图接线 + 文档 URL 迁移（module 路径保持 `pengtang1024`） | `kore` @ `8c1578e`（第 35 把新公钥）→ `c43aed6`（process 视图 0.2.1 适配）→ `8c3265e` / `2e17105` / `3876009`（文档迁移：仓库地址 `kore-pl`、module 声明 `pengtang1024`）→ `9118249`（BOARD §9.1 issue 映射）；`kore-plugins` @ `f586c0e`（第 35 次重签，8 条新版本入索引，三端已推）；插件仓 8 个新版本：`container` 0.4.1、`db-postgres` 0.3.1、`dns` 0.3.1、`integrity` 0.3.2、`runtime-node` 0.2.3、`runtime-python` 0.2.3、`ssh-guard` 0.2.3、`waf` 0.3.1（均 `depth_level: production`，各仓 CHANGELOG / RELEASE-EVIDENCE 为证） | 无协议破坏性变更；module 路径保持 `github.com/pengtang1024/kore`（ADR-0024 决策 C），仓库地址统一 `github.com/kore-pl/*`；8 仓仅升 depth 与补 fault 测试，方法契约不变 | 插件仓（bump → dist 两打 → tag 干净树复现）→ `kore-plugins`（`versions.lock` + 8 条索引 + 第 35 次重签）→ `kore`（新公钥 `8c1578e` + process 视图 `c43aed6` + 文档迁移）；三端推送顺序 origin（Gitea）→ github → gitee | 三端推送完成（`kore` / `kore-plugins` / 8 插件仓）；商店复核全绿（索引 24 条、8 新版可安装、无 401）；`make check` 12 段 exit 0；`go build ./...` / `go vet ./...` exit 0；文档 `make docs-check` exit 0 | confirmed |

## 6. 里程碑裁决记录

M0 / M1 期间产生过分歧、且必须以裁决收口的口径。后续任何任务先读这里，不要再以"某份正文当前这么写"为依据推翻。**M1 的裁决（第 21–30 条）不复制到本表**，以 [LOG/DECISIONS.md](LOG/DECISIONS.md) 为唯一真源；下表 1–11 是 M0 期间直接以 BOARD 收口的口径。

**判断留痕见 [`.agents/LOG/`](LOG/)**：本板只存裁决结论与任务状态；选项、被否决方案与依据在台账，两者冲突时以 ADR + 台账为准（G-23）。

| # | 裁决 | 依据 |
| --- | --- | --- |
| 1 | 二进制 / 进程 / systemd `ExecStart` = `kored`；项目 / 仓库 / Go module = `kore`；systemd unit = `kore.service` | daemon 惯例与 `cmd/kored/` 同源；`Makefile` 已为 `APP ?= kored` / `BIN ?= ./bin/kored`；scribe 反证后 lead 改判 |
| 2 | Kore Loop = 七阶段（第 7 阶段 = 归档复盘） | 项目地基契约原文；`MILESTONE-M0` / `PLAN` 原写 8 步，已按裁决改为七阶段 |
| 3 | 帧格式 = ADR-0002（4B 长度前缀 + JSON，无额外帧头）；M3 的编码协商由 `kore.hello` 会话级完成 | ADR-0002 + ADR-0007；首版"2 字节帧头"说法作废 |
| 4 | 口令哈希 = stdlib `PBKDF2-HMAC-SHA256` / 600k 迭代（放弃 argon2id，以守住依赖白名单） | 主壳直接依赖上限 3；复审条件：公网暴露或多用户场景改为内存硬 KDF 并补 ADR |
| 5 | 升级临时 socket = `<id>.next.sock`；插件 socket 由主壳 `listen` + `chown kore-<id>` + 0600 + `SO_PEERCRED` 校验 | `/run/kore` 为 0700 root:root，插件进程无权自行创建 socket；首版 `.sock.new` 说法作废 |
| 6 | 多仓库拓扑：`kore`（内核 + `pkg/pluginapi` + 前端 + `docs/` + `.agents/`）/ `kore-plugins`（纯静态索引）/ `kore-plugin-<id>`（每插件一仓）；M0 只交付 `kore` | 用户架构级修正（2026-11-21）+ R1–R8 规则；`plugins/` 目录假设作废，`make repo-check` 落地前以 grep 为准 |
| 7 | `pkg/pluginapi` 必须是**公开包**，不得放 `internal/` | 插件在独立仓库，`internal/` 对外不可见；依赖单向：插件 → `kore/pkg/pluginapi`，`kore` 不 import 任何插件 |
| 8 | v1 = M4 完成：对标宝塔 / 1Panel 专业版的能力覆盖面，由 18–22 个插件仓库提供（含 22 插件对标验收） | 用户产品级 scope 变更（2026-11-21）；内核只做调度与商店/预设机制 |
| 9 | 场景预设 = **embed 进二进制** + 可刷新（在线拉取新版本预设）+ 离线目录兜底；首次安装按 8 类场景一键成型 | 零联网校验前提下仍要能"开箱成型"；离线可用不能被在线刷新绑架 |
| 10 | 商店 = 无账号、无评分、无审核：只做索引与校验（`index/plugins.json` + 校验脚本） | 五锚点④开放；审核与评分会引入中心化权力与账号体系 |
| 11 | 包名避让：`internal/core/store` = bbolt 持久化（既有语义），插件商店包命名 `internal/core/market`，对外 HTTP 前缀与 UI 仍叫 `/store` / 商店；**不做全局重命名** | 避免与既有 store 包语义冲突；重命名会波及 12 处引用与全部文档（G-06 成本），收益仅是"名字好看" |

## 7. 完成判定

任务从 `in_progress` 进入 `completed` 前，逐项核对：

1. **evidence 必须含三件**：命令原文、退出码、关键输出 3 行（文档类任务为文件清单 + `wc -l` 行数）。
2. **验收命令必须是任务卡里事先写好的那条**，不许事后换一条更容易过的。
3. **未通过项必须显式列出**：写 N/A 的要给原因（M0 阶段规则见 [QUALITY-GATES.md](QUALITY-GATES.md)）。
4. **蓝军问题单全部签收**：有未签收问题单的任务不得 complete。
5. **写域核对**：改动文件与 `scope` 一致；出现写域外改动即回滚并重派。

无 evidence 不得 complete。lead 验收时看的不是当事人的结论，而是 evidence 能不能复现。

## 8. 粒度规则

- 单个任务 1–2 小时可完成；超过 2 小时必须拆。
- 拆分依据是"能否独立验收"，不是"文件多少"：一个任务对应一条可执行的验收命令。
- 任务标题出现"顺便""相关""完善一下"= 粒度不清，退回重写。
- 文档类任务按"一份文档一个任务"或"一组同源文档一个任务"拆；同一份文档不得由两个任务并行改。

## 9. 已知遗留（M0 / M1 记录级，不阻断提交）

- ~~**M1 · P0（阻断收口）**~~ **已闭环（2026-11-22 收口补正）**：SDK tag `pkg/pluginapi/v0.1.0` 不可被消费——内容声明的 module 路径仍是 `github.com/kore-project/kore/pkg/pluginapi`，干净目录 `GOWORK=off go mod download` 失败；proxy.golang.org 已缓存该 `.mod`，**不可改写 tag**，按 `retract v0.1.0` + 发 `pkg/pluginapi/v0.1.1` + echo 升 `require` 至 v0.1.1（tag `v0.1.1`）处置，干净 clone 复验通过。详见 [JOURNAL.md](JOURNAL.md) M1 段 §4.5 与 [docs/MILESTONE-M1.md](../docs/MILESTONE-M1.md) §5 第 0 项。
- ~~**M2 · 阻断 B1（打包不可复现）**~~ **已闭环（2026-11-22 收口）**：`kore-plugin-site` / `kore-plugin-echo` 的 `dist` 原用 `tar -czf` 未固定 mtime/顺序，跨秒重建 sha 漂移（`site` 在 `59b107ba…`/`f9fae467…`/`8579eb37…` 间跳）；相关仓 `dist` 已改确定性打包（`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner` + `gzip -9n`，build 加 `GOWORK=off`），索引 sha 与签名链重签、新公钥 `faf3a743…1439` 两端同步。复验：两对 sha 一致、验签正反例全过、`make check` 10/10。沉淀规则"能构建 ≠ 能重建出同一个包"见 [JOURNAL.md](JOURNAL.md) M2 复盘 §3；裁决见 [LOG/DECISIONS.md](LOG/DECISIONS.md) 第 34 条。
- **M1 遗留（8 项）**：见 [JOURNAL.md](JOURNAL.md) 2026-11-22 M1 段「结论与 M2 前置」与 [docs/MILESTONE-M1.md](../docs/MILESTONE-M1.md) §5——auth / market 未做、web 壳未交付、退避重启与心跳按 M1-12/13 延期、capability 方法级校验（M1-08）、audit 写入（M1-09）、bus 多路复用、`registry/validate.go` 241 行超 200 行上限、bbolt mmap 计入 RssFile（M4 瘦身）。**其中 auth / market / web 壳已于 M2 交付；余项转 M3。**
- `docs/DECISIONS/0001-go-stdlib-net-http.md:8` 背景句仍含 `GOGC=200`：ADR 为冻结决策记录，`canonical-check` 按设计排除 `docs/DECISIONS/`，不影响现役口径；下次修订该 ADR 时顺手改为"默认 GOGC=100 + GOMEMLIMIT=6MiB"。
- `make idle` 的 SKIP 文案未写"约 65s"（实现为 `sleep 5 + 60` 采样）；M1 起有 `kored` 进程时输出实测，届时补文案。
- C5 口径「22 项能力域：12 项生产级 / 8 项基础级」与 `FEATURE-PARITY:12`「14 项由生产级插件承载」是"插件数 vs 能力域数"两种说法；建议后续在 ROADMAP 该句加"（由 12 个生产级插件承载 14 个域）"限定语。
- **§6.1 文档债已派 doc-61-fix**：6.1 文档口径遗留已派 `doc-61-fix` 单独修 `docs/DATA-MODEL.md`，本里程碑不碰该文件，避免与其写域冲突；完成后由 scribe 复核并回填。
- **UI 方案待用户拍板**：插件 UI 集成四视角讨论（见 [JOURNAL.md](JOURNAL.md)「插件 UI 集成四视角讨论」）三处分歧——隔离强度 / `kore_csrf` 能否改 HttpOnly / asset 路径版本化——用户尚未拍板；未定前不实现同域挂载、不落 ADR，不触发实现。
- ~~**M4 前置三项**~~ **已收口 / 转 M5（2026-11-22）**：①插件包级 ed25519 签名——M4-D 判延 M5（在线分发链已被索引签名 + sha256 覆盖，复用同一公钥零增量，见 `DEFER-TO-M5` 报告），转 M5 落链；②Windows / macOS / arm64 全矩阵实机——依裁决 35 本机优先，M4 仍只做交叉编译，转 M5；③UI 方案——裁决 40/41/42 已拍板（跨站独立 origin iframe + 桥 / 响应式 / PoC 分层），服务端 capability 根因已由 M4-A 修复。三项后续均按带验收命令的任务卡立，不"顺手做了"。
- **M4 · 第五次重签（已闭环）**：M4-B site 生产化出包后索引第五次重签——`kore` @ `c0ab71a` 把新公钥 `adb9998e4281118f297ecef2505b81e3b58637ce4e78c4ed1698fa5b61b442a4` 同步到 `internal/core/market/verify.go:16`，`kore-plugins` @ `9d09e56` 同步 site 新 sha `ff9c2c1698e2e63ecfa7e384f539483224297efff68d85dd9a6c73a0f539d484` 与新签名；两端公钥 `grep` 逐字相同、site 实包 `sha256sum` 与索引声明逐字一致。**重签次数沿革**：M2 确定性打包重签（第 2 次，`7caa85a`/`e945aca`）→ M3 P0 重签（第 3 次，`97d07c0`/`0e7c2b9`）→ M3 去 `./` 第四层重签（第 4 次，同批 `CS-M3-01`）→ M4-B 生产化重签（**第 5 次**，本条）。M4 为当前最新，禁止新旧公钥混用；详见 [JOURNAL.md](JOURNAL.md) M4 复盘 §2/§5、变更集 `CS-M4-01`（§5）。
- **M4 · 未证明项（挂账 M5，不得复述为已证）**：①真实宿主 `env_kind=real`——S-02 只到真 nginx 容器层，全量 `nginx -T` diff 空是容器证据、非宿主实机；②包级 ed25519 签名——M4-D 判 `DEFER-TO-M5`，链路未落地；③audit O(n) 全表扫描——`store/audit.go:155 tx.ForEach` 全 bucket 遍历、未建时间戳 / 动作索引（记录级技术债）；④CSRF 审计持久化挂点——`store.PutAudit` 注入 cmd/kored 装配层未落地，当前仅 slog WARN。四项按裁决 43 挂 M5，立带验收命令的任务卡。
- **M5 · 9 仓远端推送挂账（发布链未 confirmed）**：三批 19 仓本地全就绪、commit 与 sha 已落 `CS-M5-01`，但 9 仓 `git push` 受 GitHub secondary rate limit 阻断（request ID `AF3E:0E54…`）；按"失败停下报原始错误"原则停下，15:00 定时任务重试，结果回填变更集后才置 `confirmed`，不把"本地全就绪"说成"已发布"。详见 [JOURNAL.md](JOURNAL.md) M5 复盘 §2/§5。
- **M5 · 未证明项（挂账，不得复述为已证）**：①真实宿主 `env_kind=real`——M4 起挂账，本机无真实既有站点，web server 共存只到容器层；②包级 ed25519 签名——M4-D 判 `DEFER-TO-M5`，本轮未落链，须另立里程碑；③audit O(n) 全表扫描——时间戳 / 动作索引未建，记录级技术债；④CSRF 审计持久化挂点——`store.PutAudit` 注入 cmd/kored 装配层未落地。四项按裁决 43 延续挂账，进下个里程碑任务卡；`v1.0.0` tag 裁决见 [LOG/DECISIONS.md](LOG/DECISIONS.md) 第 44 条，待 lead/用户拍板。

- **Round 5 · 未做完（2026-11-23，承接 CS-20261123-04）**：
  - **通道 socket**：方案①（`rootaction` 经独立 socket 代理）已裁决、未实现；当前 root action 仍走临时文件 + 轮询（ADR-0018/0022 记录）。
  - **firewall 0.2.4 bump**：HEAD `make dist` sha `9c637faa…` ≠ 索引声明 `353d5626…`，包内容已变未 bump，**索引与实包不一致，禁止按 0.2.3 安装**；须 bump 0.2.4 + 重签。
  - **container `docker.go` hint 与 ADR-0018 冲突**：错误提示写"加入 docker 组"（等于引导用户抬权），降权口径下应改为 root action / 降级提示；未改。
  - **`verify_file` 下划线命名**：动作段正则 `^[a-z][a-zA-Z]*$` 不含下划线，该方法无法进 `method_capabilities`；须改名或放宽协议（放宽需 ADR）。
  - **第 34 次重签未做**：`waf` 0.3.0 与本轮新发版插件尚未入索引（第 33 次只覆盖 12 条），索引同步是滚动量。
  - **R5-1 真 root 端到端未在降权后复验**：`--pipe` 修复与真 root 通道验证发生在降权提交前，降权后未重跑同一命令。

### §9.1 任务队列（Gitea 权威源）

**BOARD 仍是权威台账**（G-15/G-23）；Issues 是**公开镜像 + 可认领队列**，双向可查。GitHub Issues 保留为公开镜像，**后续更新以 Gitea 为准**：

- 集中层（跨仓 / 内核 / 协议）：`https://gitea.iouf.cn/kore-pl/kore/issues`
- 分散层（各插件仓自身缺口）：`https://gitea.iouf.cn/kore-pl/<repo>/issues`

| 遗留项 | Gitea issue |
| --- | --- |
| firewall 0.2.3 之后 tag 漂移，下次发版必须 bump（同类：process / redis / ssl / waf） | kore-pl/kore#1 |
| ~~零侵入阶段 B：`kored uninstall` + `userdel` 清理~~ **已闭环（2026-11-23）**：`593d224` 实现 + `1e1ad76` 验收证据；Gitea #2 已 close（挂账：真机 root 端到端未复验，仅隔离实例验证） | kore-pl/kore#2 ✅ closed |
| ~~主壳前端接线：10 个后端方法无 UI 入口~~ **已闭环（2026-11-23）**：`terminal.*` `12f2210`、`integrity.*` / `cron.*` `69d317d`、`process.renice` `c43aed6`；Gitea #3 已 close（评论含 4 commit 对照表） | kore-pl/kore#3 ✅ closed |
| module 路径是否迁移到 kore-pl（当前决策：不改，需 ADR 才改） | kore-pl/kore#4 |
| 协议约束：下划线命名方法无法进 `method_capabilities`（`verify_file`） | kore-pl/kore#5 |
| echo 补故障注入测试以升 production | kore-pl/kore-plugin-echo#1 |
| container docker socket 错误提示与 ADR-0018 冲突 | kore-pl/kore-plugin-container#1 |
| 硬编码版本断言清理（dns / runtime-node / runtime-python） | kore-pl/kore-plugin-dns#1 |

**状态**：以上均 open、未认领；标签体系（Gitea 仓级）`P0` / `P1` / `P2` / `zero-intrusion` / `frontend` / `protocol` / `capability` / `release-chain`。GitHub 侧 8 个 issue 已加迁移标注（不关闭，保留历史）。
