> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 验收者: verifier（m0-g-verify，独立于 A–F 实现者，未参与任何文档撰写） · 验收时间: 2026-11-21 21:08–21:40 +08:00
> 验收对象: M0 全部交付物 **35 个文件 / 4,404 行**（docs 19 篇 3,098 行，其中 docs/*.md 12 篇 2,743 行 + ADR 7 篇 355 行；.agents 10 份 700 行；scripts 1 份 235 行；根文件 5 份 371 行）。全部命令由 verifier 在本机原样复跑，未复用任何实现者输出。

# M0 独立验收报告（一致性）

## 0. 结论先行

**VERDICT: REVISE** — 机械门禁全绿（第一步 8/8），第二步 10 条中 9 条字面达标、1 条（`admin_hash`）命中即缺陷；交叉一致性核对发现 **6 处与已裁决口径直接冲突（红线 1/2/3/5/6）+ 22 处跨文档不一致**，共 28 条。按裁决口径"任何文档与它们冲突即 FAIL"，本轮不得提交，问题回派 A–E 后重验。

最硬的三条：`docs/ROADMAP.md:11` 把发布物写成"单二进制 `kore`"（红线 1 要求 `kored`）；`docs/GLOSSARY.md:79` 把 Kore Loop 写成 8 段"归档→复盘"（红线 2 要求七阶段）；`docs/DECISIONS/0005-yaml-config-bbolt-state.md:13` 与 `docs/SECURITY.md` 的 bucket 集合是 7/8 个且含 `grants`/`secrets`（红线 6 要求 6 个且无这两项）。

## 1. 第一步：机械门禁（原样复跑）

| # | 命令 | 退出码 | 关键输出（原文摘录） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `make help` | 0 | 列出 kored 0.1.0 与 10 个目标：help/build/vet/test/frontend/mem/docs-check/check/clean/fmt | PASS |
| 2 | `make -n build` | 0 | 含 `-o ./bin/kored ./cmd/kored`，且先判 `[ ! -d "./cmd/kored" ]` 后 `exit 0` | PASS |
| 3 | `make build` | 0 | `[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现` | PASS |
| 4 | `bash -n scripts/docs-check.sh` | 0 | 无输出（语法通过） | PASS |
| 5 | `make docs-check` | 0 | `必需文件齐全：16 项 + docs/DECISIONS 7 篇`；末行 `docs-check: 6 pass, 0 warn, 0 fail` | PASS |
| 6 | `make check` | 0 | 1/3 docs-check 6 pass；2/3、3/3 输出 `[N/A] 源码未就绪`；末行 `[OK] 门禁全部通过` | PASS |
| 7 | `git status --short` | 0 | 8 个未跟踪顶层条目（展开 35 文件，即本次验收对象；落盘两份验收报告后为 37）：`.agents/ .editorconfig .gitignore AGENTS.md Makefile README.md docs/ scripts/` | PASS（符合"HEAD 未出生"） |
| 8 | `git rev-list --count HEAD` | **128** | `fatal: 有歧义的参数 'HEAD'：未知的版本或路径不存在于工作区中` | PASS（预期 128） |

## 2. 第二步：口径 grep

| # | 命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| 1 | `grep -rn "frame_ver\|frame_type\|8,388,606" docs/ .agents/ AGENTS.md README.md` | 3 命中，全部在 `docs/DECISIONS/0007-*.md:8,14,24`：两个"曾设想/被拒"备选 + 一句"不存在扣头后 8,388,606 的口径" | PASS（附注：字面非空，语义均为被拒备选或否定句，无现存口径定义） |
| 2 | `grep -rn "sock\.new" ...` | 3 命中：ADR-0007:35（技术债说明）、JOURNAL:34/56（历史反模式）、BOARD:74（裁决"作废"） | PASS（附注：ADR-0007:35 的"现描述"已过时，见问题 26） |
| 3 | `grep -rni "argon2" docs/` | 3 命中：DATA-MODEL:101（复审条件）、SECURITY:69（复审条件）、CORE:57（"不引入 x/crypto（bcrypt/argon2 破白名单）"禁止句） | PASS（附注：CORE 一处超出"复审条件"范围，属禁止性叙述，不构成违规） |
| 4 | `grep -rn "bin/kore[^d]" docs/ .agents/ AGENTS.md README.md Makefile` | 1 命中：JOURNAL:57（历史反模式原文）；`Makefile:13` 实为 `BIN ?= ./bin/kored` | PASS（附注） |
| 5 | `grep -rn "admin_hash" docs/` | 1 命中：`docs/DECISIONS/0005-*.md:12` "（`admin_hash` 不热重载）" | **不达预期**（应为空）→ 问题 4 |
| 6 | `ls docs/DECISIONS/` | 0001–0007 共 7 篇，无重号、无 `protocol-minor` 旧文件 | PASS |
| 7 | `grep -rn "8 步\|M5\|M6" ...` | 3 命中：ROADMAP:165（禁止新增 M5 之类）、JOURNAL:57 与 BOARD:71（历史裁决叙述） | PASS（附注：均为禁止/历史语境） |
| 8 | `grep -rni "users" docs/ \| grep -i "bucket"` | 4 命中，全部为否定句："MVP 不建 `users` bucket""无 `users`""不建 `users`" | PASS（附注：字面非空，语义与"无 users"一致） |
| 9 | `wc -l AGENTS.md` | 77（≤ 130） | PASS |
| 10 | `grep -c "^## " docs/DECISIONS/*.md` | 7 篇均为 6 节：背景/决策/备选方案对比/后果/验证方式/复审条件 | PASS |

## 3. 第三步：跨文档一致性（逐项）

| # | 口径 | 文档 A ↔ 文档 B ↔ 结论 | 判定 |
| --- | --- | --- | --- |
| 1 | 插件状态机 | `ARCHITECTURE:186-226`（8 状态图 + 转移表）↔ `PLUGIN-PROTOCOL:182`（显式列 8 个）↔ `CORE` 未枚举状态集合（`CORE:76` 只引用 state 字段） => 状态名与数量一致（8 个），CORE 属覆盖不足无冲突 | PASS |
| 2 | 心跳与判死 | `CORE:143`（10s/2s/3 次/60s≈6 次）↔ `ARCHITECTURE:220-222`（3 次 2s、60s≈6 次）↔ `PLUGIN-PROTOCOL:275-276`（10s/2s/3 次/60s） => 三处同值 | PASS |
| 3 | 业务调用超时 | `CORE:84`（15s，envelope 至 120s）↔ `ARCHITECTURE:121`（15000ms，覆盖至 120s）↔ `PLUGIN-PROTOCOL:264`（15000ms，上限 120000ms） => 一致 | PASS |
| 4 | cgroup 路径与写入值 | 路径三处一致 `/sys/fs/cgroup/kore/<id>.slice`；写入值 `RESOURCE-MODEL:59-63`（字节/90%/0/pct×1000/128）↔ `SECURITY:131`（`memory.max=<memory_mb>M`、`pids.max=64`、无 memory.high） => **不一致** | **FAIL**（问题 10） |
| 5 | 日志轮转 | `DATA-MODEL:21,79,175,225`（内核 10 MiB×5、插件 10 MiB×2）↔ `CORE:92`（同值并指向 DATA-MODEL）↔ `SECURITY:175`（引用 DATA-MODEL 为真源，同值） => 一致 | PASS |
| 6 | HTTP 端点清单 | `CORE:62` 13 个 /api/v1 端点（含 enable/disable/upgrade 三动作）↔ `PLAN:24` 13 个 ↔ `AGENTS:76` 13 个 ↔ `MILESTONE:146` 13 个；但 healthz 前缀两套写法（`ARCHITECTURE:86,169`、`ROADMAP:91,95` 为 `/api/v1/-/healthz`；`CORE:27,118,122`、`RESOURCE:203`、`FRONTEND:46`、`SECURITY:100`、`DATA-MODEL:209` 为 `/-/healthz`），且 `SECURITY:90,108-110` 省略 `/api/v1` 前缀 => 数量一致、路径写法不一致 | **FAIL**（问题 17、18） |
| 7 | 角色与阶段 | 六角色：`ROLES:1-102`、`WORKFLOW`、`PLAN:18`、`ROADMAP`、`MILESTONE:83` 全 6 个；`AGENTS.md` 全文只出现 lead/implementer/verifier/red-team，未点名 architect/scribe（问题 23）。七阶段：`AGENTS:52`、`WORKFLOW:5`、`PLAN:154`、`MILESTONE:83`、`README:108`、`.agents/README:45` 一致；`GLOSSARY:79` 写成 8 段"归档→复盘" => **不一致** | **FAIL**（问题 2、23） |
| 8 | 资源数字与标识符 | `8 MiB`（20 文件）、`24 MiB`（12）、`48 MiB`（11）、`25 MiB`（18）、`300 KiB`（12）、`0.1.0`（10）、`kore.plugin.v1`（9）、`/run/kore`（13）、`/var/lib/kore`（12）、`/sys/fs/cgroup/kore`（8）全仓取值一致；`/run/kore` 权限另见问题 6 | PASS（数字本身） |
| 9 | 依赖白名单 | `CORE:12,57,264`、`ARCHITECTURE:65`、`AGENTS:25`、`README:100`、`SECURITY:64` 均为 yaml.v3/bbolt/protobuf(M3) 三项；`grep` 违规依赖命中全部为禁止/验证语境（Makefile:90 是拦截器），无"主壳依赖 x/crypto/gin/sqlite"表述 | PASS |
| 10 | 前端 | `FRONTEND:149-162` 12 个暗色令牌 hex、`FRONTEND:51` 侧栏 220/48px、`FRONTEND:54,172` 表格行高 32px；`SECURITY.md`、`README.md` 未引用任何 hex/像素值（`README:103` 仅"默认暗色高密度"）=> 唯一源无漂移，但也不存在三方数字比对 | PASS（弱一致，附注） |

## 4. 问题清单（28 条，按级别）

| # | 位置 | 事实 | 冲突裁决 / 对照 | 回派 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 1 | `docs/ROADMAP.md:11` | 发布物写"单二进制 `kore`（前端经 go:embed 打进同一二进制）" | 红线 1：二进制/进程 = `kored`；`ARCHITECTURE:13`、`GLOSSARY:31-32`、`README:88` 均为 `kored` | D | P0 |
| 2 | `docs/GLOSSARY.md:79` | Kore Loop 写"提案→双评审→拆解→实现→验证→蓝军→归档→复盘"（8 段） | 红线 2：七阶段，第 7 阶段 = 归档复盘；`AGENTS:52`/`WORKFLOW:5` 为七阶段 | A | P0 |
| 3 | `docs/ARCHITECTURE.md:309` | §11.3 复审条件写"帧头保留 1 字节编码位" | 红线 3：无任何额外帧头，M3 编码由 hello `encoding` 会话级协商；ADR-0007:24-25 明确"被拒" | A | P0 |
| 4 | `docs/DECISIONS/0005-yaml-config-bbolt-state.md:12-13,34` | bucket 固定为 `meta/plugins/grants/sessions/secrets/tasks/audit`（7 个、缺 `plugin_state`）；同文件 :12 用 `admin_hash` 简写；:34 依赖 `secrets` | 红线 6：6 个 = `meta/plugins/plugin_state/tasks/sessions/audit`，无 `users`；字段名须为 `auth.admin_password_hash`（红线 4） | C | P0 |
| 5 | `docs/SECURITY.md:15,17,109,110,159,211` | 资产表与授权表把 `secrets`、`grants` 当作 bbolt bucket，并写入"启用授予写 `grants` bucket" | 红线 6 同款冲突；`CORE:47`、`ARCHITECTURE:318`、`GLOSSARY:145`、`DATA-MODEL:118-127` 均为 6 bucket 且无这两项 | C | P0 |
| 6 | `docs/ROADMAP.md:97` + `docs/CORE.md:220-221` | ROADMAP 风险写"`/run/kore` 0750 且属主 `kore`"；CORE systemd 样例 `RuntimeDirectoryMode=0750` | 红线 5 前提：`/run/kore` 为 **0700 root:root**（`SECURITY:130,141`、`ARCHITECTURE:303`、`PLUGIN-PROTOCOL:301`） | D / A | P0 |
| 7 | `docs/CORE.md:41` ↔ `docs/DATA-MODEL.md:31-53`（+`SECURITY:86`） | 两套配置字段命名：CORE 为 `http.uds_path`/`store.path`/`log.file`/`bus.*`/`supervisor.*`/`cert_renew.*`；DATA-MODEL 为 `server.addr`/`paths.*`/`log.rotate.*`/`resources.defaults.*`/`security.login_rate_limit.*`；SECURITY 另有 `auth.cookie_secure`、`auth.initialized` 未进任一 schema | CORE:34 明言"字段名与默认值即实现契约"；两处无法同时实现 | A / B | P1 |
| 8 | `docs/CORE.md:42` ↔ `docs/DATA-MODEL.md:107,112,114` | 未知字段处置：CORE "stderr 报行号，退出码 2（严格模式，绝不静默忽略）"；DATA-MODEL "允许，记 WARN 后继续启动" | 同一行为的两种互斥契约 | A / B | P1 |
| 9 | `docs/DATA-MODEL.md:153` ↔ `docs/CORE.md:49`、`docs/ARCHITECTURE.md:163` | schema 高于二进制时：DATA-MODEL "退出码 2"，CORE/ARCHITECTURE "退出码 4" | 启动失败码不一致，运维脚本无法判定 | B | P1 |
| 10 | `docs/SECURITY.md:131,197` ↔ `docs/RESOURCE-MODEL.md:59-63,89` | `pids.max=64`（SECURITY）vs 默认 128、允许 16–512（RESOURCE/DATA-MODEL:47）；`memory.max=<memory_mb>M` 非 RESOURCE 的字节口径；SECURITY 缺 `memory.high`（RESOURCE:60 为 max×90%） | 资源模型真源在 RESOURCE-MODEL，SECURITY 自写一套值 | C | P1 |
| 11 | `docs/SECURITY.md:30,90,191` ↔ `docs/CORE.md:55`、`docs/DATA-MODEL.md:51-53` | SECURITY："5 次 / 5 分钟"窗口；CORE："5 次/60 s 每 IP，触发后锁 5 分钟"；DATA-MODEL：`window: 60s` + `lock: 300s` | 窗口语义 5 分钟 vs 60 秒，实现取值不同 | C | P1 |
| 12 | `docs/ARCHITECTURE.md:303`、`docs/DECISIONS/0002-*.md:12` ↔ `docs/SECURITY.md:141` | 主壳 socket 权限写"0660 + kore 组"vs"0600 root:root"；且 `/run/kore` 0700 时组权限无意义 | UDS 文件权限即边界，两处不能同时成立 | A / C | P1 |
| 13 | `docs/ROADMAP.md:18,71`、`docs/PLAN.md:31`、`docs/MILESTONE-M0.md:5,28,165`、`.agents/JOURNAL.md:44` | 均写"6 篇 ADR / `0001-0006`"；实际 `docs/DECISIONS/` 为 7 篇（含 0007，`BOARD:48` 也已写 7 篇） | M0 交付物清单与文件树不符，退出条件"6 篇 ADR 齐全"低于实际 | D / C / E | P1 |
| 14 | `docs/PLUGIN-PROTOCOL.md:202-209` ↔ `GLOSSARY:45`、`ADR-0002:14`、`VISION:95,119`、`ARCHITECTURE:252`、`PLAN:26,57` | 协议"必选方法"表只列 4 个（hello/ping/shutdown/reload）；其余文档与 ADR 均称 5 个（含 `kore.event`） | 数量口径不一，插件契约无法验收 | B | P1 |
| 15 | `docs/CORE.md:68`、`docs/ARCHITECTURE.md:251`、`docs/GLOSSARY.md:38-39` ↔ `SECURITY:114-123`、`PLUGIN-PROTOCOL:67`、`PLAN:30` | 三处写"能力白名单 9 项"，但其后枚举只有 8 项（site/db/net × read/write + system:read + system:admin）；SECURITY/协议/PLAN 均为 8 | 安装校验按 8 还是 9 会直接改变拒绝行为 | A | P1 |
| 16 | `docs/DECISIONS/0001-*.md:12` ↔ `docs/CORE.md:114-120` | ADR 中间件链"recover→request_id→日志→会话→CSRF→限速→业务"；CORE 固定链"req_id→recover→access_log→body_limit→auth→rate_limit→router"（无 CSRF 层、有 body_limit） | 顺序与层集合都不同，CORE:110 称"固定顺序，禁止调换" | C | P1 |
| 17 | `docs/ARCHITECTURE.md:86,169`、`docs/ROADMAP.md:91,95` ↔ `CORE:27,118,122`、`RESOURCE:203`、`FRONTEND:46`、`SECURITY:100`、`DATA-MODEL:209` | 健康检查路径两种写法：`/api/v1/-/healthz` 与 `/-/healthz` | 红线 10 前缀 `/api/v1`；探针脚本按哪个写都会有一半文档不符 | A | P1 |
| 18 | `docs/SECURITY.md:90,108-110` | 端点表写 `POST /auth/login`、`POST /plugins`、`POST /plugins/{id}/enable`、`POST /invoke/{plugin}/{method}`，全部省略 `/api/v1` | 红线 10 + `CORE:62` 端点表口径 | C | P1 |
| 19 | `docs/SECURITY.md:16` ↔ `CORE:130`、`DATA-MODEL:20`、`PLUGIN-PROTOCOL:49` | 插件可执行文件写 `/var/lib/kore/plugins/<id>/bin/<id>`，缺版本目录 | 其余三处为 `<id>/<version>/bin/<id>`（多版本并存与回滚依赖此层） | C | P1 |
| 20 | `docs/ARCHITECTURE.md:266` | ADR 必含项列 5 个（背景/备选方案对比/决策/后果/复审条件），无"验证方式" | 实际 7 篇 ADR 全部 6 节；`MILESTONE`/`PLAN` 亦按 6 节验收 | A | P1 |
| 21 | `.agents/WORKFLOW.md:61` | 里程碑层门禁写"G6（文档同步）/G8/G9/G10" | `QUALITY-GATES:16` 中 G6 = 资源预算实测；文档同步是 G4（:14） | E | P1 |
| 22 | `docs/MILESTONE-M0.md:156` | 称 `make build/vet/test/mem/frontend` 在 M0 "输出 `N/A`" | 实测 `make build` 输出 `[SKIP]`（本报告 §1 第 3 行），且 `MILESTONE:130` 自己写的是 `[SKIP]` | D | P2 |
| 23 | `AGENTS.md`（全文） | 六角色只点名 4 个（lead/implementer/verifier/red-team），未出现 architect、scribe | 红线 9：角色固定 6 个；`AGENTS:70` 又称"6 张角色卡" | E | P2 |
| 24 | `docs/DATA-MODEL.md:137,196,207,210`、`docs/RESOURCE-MODEL.md:99` | 假设存在 `kore db dump` / `kore backup` / `kore restore` / `kore invoke` CLI | 交付口径是"单二进制 `kored`"（`ARCHITECTURE:313`、`GLOSSARY:75`），CLI 未定义归属与形态 | B | P2 |
| 25 | `docs/DECISIONS/0003-*.md:28` | 状态序列写 `installed → starting → ready → stopping → stopped/degraded` | 8 状态机为 installed→enabled→starting→ready→degraded/stopping→stopped/failed，缺 enabled/failed、位置错 | C | P2 |
| 26 | `docs/DECISIONS/0007-*.md:35` | 技术债称"PLUGIN-PROTOCOL §4 现描述 2 字节帧头与 `.sock.new`，需同步" | 该文件 :126 已是"没有任何额外帧头"、:284 已是 `.next.sock`；描述已过时 | C | P2 |
| 27 | `docs/DECISIONS/0001-*.md:8` | "13 个端点（含静态与 healthz）" | CORE 的 13 个是 `/api/v1` 端点，不含 3 条静态前缀；含静态应为 16 | C | P2 |
| 28 | `VISION:102,149`、`FRONTEND:206-207`、`RESOURCE:164` | 首屏 gzip 三种度量：拼接后 gzip / 逐文件 gzip 相加 / 只算 js | 同一 300 KiB 预算有三种算法，验收数字不可比 | A / C | P2 |

## 5. 回派与复验建议

1. **A（architect）**：问题 2、3、6（CORE 侧）、7、8、12、15、17、20、28 —— 建议先按 ADR 收敛"桶/状态/能力/配置字段"四张表，再统一正文引用。
2. **B（协议/资源/数据）**：问题 7、8、9、14、24 —— 配置 schema 需在 CORE 与 DATA-MODEL 之间选一处真源并互相引用（不复制）。
3. **C（前端/安全/ADR）**：问题 4、5、10、11、12、13、16、18、19、25、26、27 —— SECURITY 与 ADR-0005 必须回到红线 6 的 6-bucket 口径（若要新增 bucket，须先补 ADR 并同步全部文档）。
4. **D（路线图/计划）**：问题 1、6（ROADMAP 侧）、13、22。
5. **E（AGENTS/协作体系）**：问题 13（JOURNAL）、21、23。

复验方式：上述任一项修复后，verifier 用本报告 §1/§2 的原命令逐条复跑，并对 §3 的 10 项重新对照行号；`make docs-check` 必须仍为 `6 pass, 0 warn, 0 fail`。**本轮新增的两份验收报告本身也纳入 docs-check 范围，修复提交前需再跑一次确认 31 份文档元信息合规。**

## 6. 结论

机械门禁与 grep 的"字面值"基本达标，但地基契约的**红线段**存在 6 处实质冲突，且配置/协议/能力/桶四张核心表在文档间各写一套。M0 的验收标准是"内容一致"，不是"命令退出 0"，因此：

**VERDICT: REVISE**
