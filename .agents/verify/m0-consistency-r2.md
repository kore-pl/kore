> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 复验对象：r1 报告 **R1-M0-2026-11-21**（`.agents/verify/m0-consistency.md`）的 28 条问题；r1 为冻结证据，本报告不覆盖它。
> 冻结校验：r1 两份文件 mtime 21:17/21:18 未变，sha256 `93dc266a…ff881`（consistency）/ `a346efd7…feb440`（commit-plan）；本报告（R2）全部结论均为 verifier 自行重跑命令、重读行号得出，不引用任何实现者自述。
> **拓扑变更前的中间验收快照（2026-11-21）**：lead 已下指令暂停提交——项目改为多 git 仓库（`kore` 内核 / 插件中心 / 每个插件一个独立仓库），文档中"插件在 kore 仓库 `plugins/` 子目录"的假设待 A–E 重构。本报告的 28 条销账作为切分前基线保留，拓扑相关条目待重构完成后另出 R3。

# M0 独立复验报告 R2（一致性）

## 0. 结论先行

**VERDICT: REVISE（暂停原因：多仓库拓扑变更，文档待重构，见 lead 指令）** — 28 条中 **26 条 CLOSED，2 条 STILL-OPEN**（#14 必选方法口径、#17 探针路径），另发现 **3 条 P1 + 1 条 P2 新增问题**（8 层中间件链在 ARCHITECTURE 残留 7 层、状态目录退出码 3/4 冲突、首启空口令 exit 2 vs 自动生成冲突、FRONTEND 两处端点未带前缀）。

按 lead 的暂停指令，**本轮不提交（与结论是 APPROVE 还是 REVISE 无关）**，`staged=0`、`git log` 无 commit。P0 的 6 条（#1–#6）与追加重点 #12/#21 全部 CLOSED，新增契约（8 层链 / cert_renew / kore_csrf）中 2 项已闭合、1 项部分闭合（见 N1）。

## 1. 机械门禁复跑

| # | 命令 | 退出码 | 关键输出（原文） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `make help` | 0 | 列出 10 个目标：help/build/vet/test/frontend/mem/docs-check/check/clean/fmt | PASS |
| 2 | `make -n build` | 0 | 命中 `-o ./bin/kored ./cmd/kored`（grep 计数 1） | PASS |
| 3 | `make build` | 0 | `[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现` | PASS |
| 4 | `bash -n scripts/docs-check.sh` | 0 | 无输出 | PASS |
| 5 | `make docs-check` | 0 | `全部 31 份文档元信息合规`；末行 `docs-check: 6 pass, 0 warn, 0 fail` | PASS |
| 6 | `make check` | 0 | 2/3、3/3 `[N/A] 源码未就绪`；末行 `[OK] 门禁全部通过` | PASS |
| 7 | `git status --short` | 0 | 8 个未跟踪顶层条目（展开 37 文件 = A–F 35 + r1 报告 2） | PASS |
| 8 | `git rev-list --count HEAD` | **128** | `fatal: 有歧义的参数 'HEAD'` | PASS（仍无提交） |

## 2. 28 条逐条核验

| # | 位置 | r1 事实 | 现在实测（file:line 摘录） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | ROADMAP:11 | 单二进制 `kore` | `ROADMAP:11`：「单二进制 **`kored`**（前端经 go:embed 打进同一二进制）」 | CLOSED |
| 2 | GLOSSARY:79 | Loop 8 段"归档→复盘" | `GLOSSARY:79`：「七阶段固定顺序：提案 → 双评审 → 拆解 → 实现 → 验证 → 蓝军 → **归档复盘**（第 7 阶段=归档复盘）」 | CLOSED |
| 3 | ARCHITECTURE:309 | "帧头保留 1 字节编码位" | `ARCHITECTURE:309-310`：复审条件改为「再评估扩展帧头——届时必须开新 ADR 并同步 ADR-0002/0007。帧结构恒为 `4B 长度 + 载荷`…**帧头不承载任何编码信息**」 | CLOSED |
| 4 | ADR-0005:12-13,34 | 7 bucket 含 grants/secrets、`admin_hash` | `ADR-0005:12`「`auth.admin_password_hash` 不热重载」；`:13`「bucket 固定为 **6 个**：meta/plugins（含 `granted_capabilities`）/plugin_state/tasks/sessions/audit；**不建 users、不单设 grants、不设 secrets**」；`:34` secrets 改 `/var/lib/kore/secrets/<plugin-id>.json` | CLOSED |
| 5 | SECURITY:15,17,109,110,159,211 | `secrets`/`grants` 当 bucket | `SECURITY:15` 插件密钥 → `/var/lib/kore/secrets/<id>.json`（0600 root:root，目录 0700）；`:17` 授予记录 → `plugins` bucket 的 `granted_capabilities` 字段；`:109-110` 写 `plugins.granted_capabilities`；`:159/211` 全部改为文件路径 | CLOSED |
| 6 | ROADMAP:97 + CORE:220-221 | `/run/kore` 0750 且属主 kore | `ROADMAP:97`「`/run/kore` **0700 root:root**」；`CORE:223` `RuntimeDirectoryMode=0700` | CLOSED |
| 7 | CORE:41 vs DATA-MODEL:31-53 | 两套配置字段命名 | `CORE:40-42`：「键名与默认值以 `DATA-MODEL.md` §3 为唯一真源…本文件不复制」；`DATA-MODEL:31`：「本节是 `config.yaml` 键名的唯一真源」；`auth.cookie_secure`（:42）与 `auth.initialized`（:43）均已进 DATA-MODEL | CLOSED |
| 8 | CORE:42 vs DATA-MODEL:107,112,114 | 未知字段 exit 2 vs WARN | `CORE:42`「**未知字段 → WARN + 继续启动**，附拼写建议」；`DATA-MODEL:121`「未知字段 = WARN + 继续启动」、`:125` 同 | CLOSED |
| 9 | DATA-MODEL:153 vs CORE:49 | schema 降级 exit 2 vs 4 | `DATA-MODEL:171`「current > target → 拒绝启动，**退出码 4**」、`:172` 迁移失败 `退出码 4`；`CORE:49` 同 | CLOSED |
| 10 | SECURITY:131,197 vs RESOURCE:59-63 | pids 64、`24M`、缺 memory.high | `SECURITY:131`：只列 `memory.max`/`memory.high`/`memory.swap.max`/`cpu.max`/`pids.max` 五个文件名，并注明「取值与默认值以 RESOURCE-MODEL 为唯一真源，本文件不复制数值」；`RESOURCE:59-63` 保留字节/90%/0/pct×1000/128 | CLOSED |
| 11 | SECURITY:30,90,191 vs CORE:55 | 5 分钟 vs 60s 窗口 | `SECURITY:30/90/191`：「**60s 窗口内 5 次失败锁 300s**，与 CORE/DATA-MODEL 的 `security.login_rate_limit` 同口径」；`CORE:55`「5 次/60 s 每 IP…锁 5 分钟」；`DATA-MODEL:57-59` window 60s / lock 300s | CLOSED |
| 12 | ARCH:303 + ADR-0002:12 vs SECURITY:141 | 主壳 socket 0660 vs 0600 | `ARCHITECTURE:303`「`kore.sock` **0600 root:root**（0700 目录下组权限无意义）」；`ADR-0002:12`「主壳，`0600 root:root`」；`SECURITY:141` 0600 | CLOSED |
| 13 | ROADMAP:18,71 / PLAN:31 / MILESTONE:5,28,165 / JOURNAL:44 | 6 篇 ADR / 0001-0006 | `ROADMAP:18`「`docs/` 12 篇 + **7 篇 ADR**」、`:71` `0001-0007`；`PLAN:31`「七篇 ADR / `0001-0007`」；`MILESTONE:5`「7 篇 ADR」、`:24` 轨道 C 7 篇、`:165` 7 篇齐全；`JOURNAL:44` 7 篇 | CLOSED |
| 14 | PLUGIN-PROTOCOL:202-209 ↔ 其余文档 | 必选方法 4 vs 5 | `PROTOCOL:211` 新口径「**4 个必选方法 + 1 条必选事件通道**…`kore.event` 是帧类型**而非方法**」；但 `GLOSSARY:45` 仍「5 个方法：hello/ping/shutdown/reload/event」、`ADR-0002:14` 把 `kore.event` 列为必选方法、`VISION:95,119`、`ARCHITECTURE:252`、`PLAN:26,57` 仍写「5 个必选方法」 | **STILL-OPEN** |
| 15 | CORE:68 / ARCH:251 / GLOSSARY:38-39 | 白名单 9 项（枚举 8） | `CORE:68`「能力白名单 **8 项**子集（site:read…system:admin）」；`ARCHITECTURE:251`「**8 项**」+ 完整枚举；`GLOSSARY:38-39`「8 项」+ 完整枚举 | CLOSED |
| 16 | ADR-0001:12 vs CORE:114-120 | 中间件链顺序不同 | `ADR-0001:12`「链路顺序以 CORE 为唯一真源，固定为 `req_id → recover → access_log → body_limit → auth → csrf → rate_limit → router`」= `CORE:114-121` 八层 | CLOSED（残留 `ARCHITECTURE:113` → 新增 N1） |
| 17 | ARCH:86,169 / ROADMAP:91,95 ↔ CORE:27 等 | healthz 两种写法 | `ARCHITECTURE:86,169`、`CORE:27,118,119`、`RESOURCE:203`、`FRONTEND:46`、`SECURITY:100`、`ADR-0003:38`、`ADR-0004:57` 均为 `/-/healthz`；**`ROADMAP:91` 仍 `http://localhost/api/v1/-/healthz`、`:95` 仍 `/api/v1/-/healthz`** | **STILL-OPEN** |
| 18 | SECURITY:90,108-110 | 端点省略 `/api/v1` | `SECURITY:90` `POST /api/v1/auth/login`；`:108` `POST /api/v1/plugins`；`:109` `POST /api/v1/plugins/{id}/enable`；`:110` `POST /api/v1/invoke/{plugin}/{method}` | CLOSED（残留 `FRONTEND:50,104` → 新增 N4） |
| 19 | SECURITY:16 | 插件可执行路径缺 `<version>` | `SECURITY:16`「`/var/lib/kore/plugins/<id>/<version>/bin/<id>`」；与 `CORE:131` 一致 | CLOSED |
| 20 | ARCHITECTURE:266 | ADR 必含 5 项 | `ARCHITECTURE:266`「必含 **6 节**：背景 / 决策 / 备选方案对比 / 后果（含失败域）/ 验证方式 / 复审条件」 | CLOSED |
| 21 | WORKFLOW:61 | G6 标成"文档同步" | `WORKFLOW:61`「里程碑层 **G4（文档同步，`make docs-check`）** / G6（资源预算实测）/ G8 / G9 / G10」；与 `QUALITY-GATES:14-16` 一致 | CLOSED |
| 22 | MILESTONE:156 | 称输出 `N/A` | `MILESTONE:156`「输出 `[SKIP]`（`make check` 内的 2/3、3/3 源码检查才是 `[N/A]`）」 | CLOSED |
| 23 | AGENTS.md 全文 | 只出现 4 个角色名 | `AGENTS:51`「角色全集（固定 6 个，不增不删）：lead / architect / implementer / verifier / red-team / scribe」 | CLOSED |
| 24 | DATA-MODEL:137,196,207,210 / RESOURCE:99 | 未定义的 `kore` CLI | `grep "kore db\|kore backup\|kore restore\|kore invoke\|kore audit"` 零命中；仅剩 `DATA-MODEL:117` 的 `cmd/kore-hash`（构建期哈希生成器，非运行期 CLI） | CLOSED（观察：`cmd/kore-hash` 未登记目录布局） |
| 25 | ADR-0003:28 | 状态序列缺 enabled/failed | `ADR-0003:28`「**8 状态**机（`installed → enabled → starting → ready → degraded / stopping → stopped / failed`）」 | CLOSED |
| 26 | ADR-0007:35 | 技术债描述过时 | `ADR-0007:35`「帧格式与 `.next.sock` 的正文冲突**已于 2026-11-21 同步完成**（PLUGIN-PROTOCOL §4 现为 `4B 长度 + JSON 信封`、§12 为 `.next.sock`）」 | CLOSED |
| 27 | ADR-0001:8 | "13 端点（含静态）"计数错 | `ADR-0001:8`「`/api/v1` 业务端点 **13 个**；加 3 条静态前缀与 `/-/healthz`（探针不带业务前缀），共 **17 项路由**」（13+3+1=17 自洽） | CLOSED |
| 28 | VISION:102,149 / FRONTEND:206-207 / RESOURCE:164 | 三种 gzip 口径 | `VISION:102,149`：首屏 = `index.html` + 直接引用 JS/CSS，**逐文件 `gzip -c` 求和**；`FRONTEND:203-207`：「gzip 后字节数之和」两条命令均为逐文件相加；`RESOURCE:155` 同定义、`:164` 明标"仅作总量参考" | CLOSED（残留观察：FRONTEND 未把 index.html 计入，约 1 KiB 级） |

**销账汇总：CLOSED 26 / STILL-OPEN 2（#14、#17）**。

## 3. 十项一致性复核（r1 §3 全重跑）

| # | 结论 |
| --- | --- |
| 1 状态机 | PASS · `ARCHITECTURE:186-226`（8 状态图+转移表）↔ `PLUGIN-PROTOCOL:182`（显式 8 个）↔ `GLOSSARY:53`；`DATA-MODEL:142` 的 5 值枚举是 `plugin_state` 存储视图，非状态机全集 |
| 2 心跳判死 | PASS · `CORE:144`（10 s/2 s/连续 3 次/60 s≈6 次）↔ `ARCHITECTURE:220-222` ↔ `PLUGIN-PROTOCOL:275-276` |
| 3 调用超时 | PASS · `CORE:84` ↔ `ARCHITECTURE:121` ↔ `PLUGIN-PROTOCOL:264`（15 s / 上限 120 s） |
| 4 cgroup | PASS · `RESOURCE:59-63` 五值齐全（字节/90%/0/pct×1000/128）；`SECURITY:131` 改为引用真源、不再自写数字 |
| 5 日志轮转 | PASS · `DATA-MODEL:21,202,252`（10 MiB×5 / 10 MiB×2）↔ `CORE:92` ↔ `SECURITY:175`（引用真源） |
| 6 HTTP 端点 | **FAIL** · 13 个端点数量五处一致（`CORE:62`/`PLAN:24`/`AGENTS:76`/`MILESTONE:146`/`ADR-0001:8`）；但探针路径仍有 2 处 `/api/v1/-/healthz`（`ROADMAP:91,95`） |
| 7 角色与阶段 | PASS · 六角色 `AGENTS:51`/`ROLES`/`WORKFLOW`/`PLAN:18`；七阶段 `GLOSSARY:79`/`WORKFLOW:5`/`PLAN:154`/`MILESTONE:83`/`README:108`/`.agents/README:45` |
| 8 资源数字 | PASS · `8 MiB`(20 文件)/`24 MiB`(12)/`48 MiB`(11)/`25 MiB`(18)/`300 KiB`(12)/`0.1.0`(10)/`kore.plugin.v1`(9)/`/run/kore`(13)/`/var/lib/kore`(12)/`/sys/fs/cgroup/kore`(8) 取值一致 |
| 9 依赖白名单 | PASS · `x/crypto`/`gin-gonic`/`go-sqlite3` 命中全部为禁止/复审/ADR 对比语境；主壳三依赖口径 `CORE:12`/`AGENTS:25`/`README:100` 一致 |
| 10 前端 | PASS · `FRONTEND:151-162` 12 个令牌 hex 与 r1 抽检完全一致、`:51` 侧栏 220/48、`:54,172` 行高 32；SECURITY/README 不复制这些值，无漂移 |

**PASS 抽检（r1 判 PASS 的项，随机 5 条复核防被改坏）**：① 心跳（CORE:144/PROTOCOL:275）；② 日志轮转（DATA-MODEL:202/SECURITY:175）；③ 依赖白名单（`x/crypto|gin-gonic|go-sqlite3` 只出现在禁止语境）；④ 前端令牌（12 个 hex 未变）；⑤ cgroup 路径（`/sys/fs/cgroup/kore/<id>.slice` 仍 10 个文件命中）。五条均未被改坏。

## 4. 新增问题（r1 未列，本轮新发现）

| # | 位置 | 事实 | 冲突对象 | 回派 | 级别 |
| --- | --- | --- | --- | --- | --- |
| N1 | `docs/ARCHITECTURE.md:113` | §5.1 调用链仍写「req_id → recover → access_log → body_limit → auth → rate_limit → router」（**7 层、无 csrf**） | 新契约 8 层：`CORE:114-121`（第 6 层 csrf）、`GLOSSARY:68`、`ADR-0001:12` | A | P1 |
| N2 | `docs/DATA-MODEL.md:129` + `:177-180` | 「路径不可写 / 锁被占用 → 退出码 **3**」 | `ARCHITECTURE:160`「确保 `/var/lib/kore`…无权限 → 退出码 **4**」；`CORE:49` 打不开 → 4 | B | P1 |
| N3 | `docs/CORE.md:56` | 「缺 `auth.admin_password_hash` → 退出码 2…**不接受空口令启动**」 | `DATA-MODEL:40`「空 = 首次启动生成 24 字符随机口令、写回哈希」；`SECURITY:73` 同（首启必须能起来） | A | P1 |
| N4 | `docs/FRONTEND.md:50,104` | `GET /events`、`POST /plugins/{id}/enable` 未带 `/api/v1`（同文件 `:41-44` 全带前缀） | 新契约「业务端点全带 `/api/v1`，仅 `/-/healthz` 例外」 | C | P2 |

观察项（不计入阻塞）：`DATA-MODEL:117` 的 `cmd/kore-hash` 未出现在 `ARCHITECTURE:272-290` 目录布局与交付口径中，M1 需登记；`MILESTONE:158` 称"7 篇 ADR 齐全"与 `:165` 一致，无问题。

## 5. 结论与文档统计

- 机械门禁 8/8 通过；28 条销账 26 CLOSED / 2 STILL-OPEN；新增 4 条问题（3×P1、1×P2）。
- **拓扑无关性（供切仓库使用）**：28 条全部不依赖仓库划分——帧格式、6 bucket、七阶段、`kored`、PBKDF2、探针路径、中间件链、退出码、能力白名单、ADR 数量均与"仓库怎么切"无关。切分为多仓库后这批口径必须原样保持；拓扑重构只需新增「仓库边界 / 插件中心仓库 / 每插件独立仓库」条目，不推翻本表。
- 落盘后全量统计：**39 个文件 / 4,831 行** —— docs/*.md 12 篇 2,772 行 + ADR 7 篇 355 行 + `.agents` 14 份 1,097 行（6 体系 + 4 模板 + R1/R2 四份验收文档）+ scripts 1 份 235 行 + 根文件 5 份 372 行。
- `make docs-check`（R2 两份报告落盘后复跑）：`全部 33 份文档元信息合规`，末行 `docs-check: 6 pass, 0 warn, 0 fail`，退出码 0。
- r1 冻结校验：两份文件 sha256 与落盘时一致（`93dc266a…ff881` / `a346efd7…feb440`），未被本轮改动。

**VERDICT: REVISE（暂停原因：多仓库拓扑变更，文档待重构，见 lead 指令）**（r1 的 #14、#17 未闭合，N1–N3 为 P1 新增冲突；按 lead 暂停指令本轮不提交，`staged=0`、无 commit）
