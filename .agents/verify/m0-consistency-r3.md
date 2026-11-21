> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 复验链：R3 ← R2（`.agents/verify/m0-consistency-r2.md`）← R1（`m0-consistency.md`，编号 **R1-M0-2026-11-21**）；r1/r2 为冻结证据，本报告不修改、不覆盖。
> 验收对象：M0 全部交付物 41 文件 + 本报告 2 份；所有命令与行号由 verifier 自行复跑/重读，不引用任何实现者自述；`.agents/proposals/`、`.agents/reviews/` 属 M1 并行写域，不在本次验收与提交范围。

# M0 独立验收报告 R3（最终轮）

## 0. 结论先行

**VERDICT: REVISE**

按指令三组可核对条目共 **44 条（28 基线 + 6 残留 + 10 拓扑）**：**43 CLOSED / 1 STILL-OPEN**（N3 残留：`CORE:42` 仍写"必填项缺失（如 `auth.admin_password_hash`）→ 退出码 2"，与 `CORE:56`/`DATA-MODEL:42`/`SECURITY:74` 的首启自动生成冲突）。另有 3 条观察项（O1 为 P1：`WORKFLOW:36`/`ROLES:38` 仍把 `plugins/` 列为 implementer 输出目录，与 G-13 冲突）。

按提交门槛（44/44 CLOSED 且 APPROVE），**本轮不提交**：`staged=0`、无 commit。机械门禁全绿（`make check` 4/4、`repo-check` 5 pass 0 fail），拓扑 10 项全部 CLOSED，28 条基线全部 CLOSED。

> 口径说明：lead 指令写"65 条"，但可逐条销账的编号只有 28（r1）+ 6（残留）+ 10（T1–T10）= 44 条；其余 21 条未给出编号，本报告不做无编号销账，如需请补发编号清单。

## 1. 机械门禁（原样复跑）

| # | 命令 | 退出码 | 关键输出 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `make help` | 0 | 11 个目标，含 `repo-check` 与更新后的 `check` 说明 | PASS |
| 2 | `make -n build` | 0 | 命中 `-o ./bin/kored`（计数 1） | PASS |
| 3 | `make build` | 0 | `[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现` | PASS |
| 4 | `bash -n scripts/docs-check.sh` | 0 | 无输出 | PASS |
| 5 | `make docs-check` | 0 | `docs-check: 6 pass, 0 warn, 0 fail` | PASS |
| 6 | `make repo-check` | 0 | 5 行 `[OK]`，末行 `repo-check: 5 pass, 0 fail` | PASS |
| 7 | `make check` | 0 | 1/4 docs-check、2/4 与 3/4 `[N/A]`、4/4 repo-check 5 pass；末行 `[OK] 门禁全部通过` | PASS（**4/4**） |
| 8 | `git status --short` | 0 | 8 个未跟踪顶层条目（展开 41 文件） | PASS |
| 9 | `git rev-list --count HEAD` | **128** | `fatal: 有歧义的参数 'HEAD'`（仍无提交） | PASS（预期 128） |

## 2. 销账

### 2.1 r1 基线 28 条（全部 CLOSED）

| # | 判定 | 证据（file:line） |
| --- | --- | --- |
| 1 | CLOSED | `ROADMAP:14`「`kore` 出单二进制 `kored`」 |
| 2 | CLOSED | `GLOSSARY:86` 七阶段固定顺序（第 7 阶段=归档复盘） |
| 3 | CLOSED | `ARCHITECTURE:328` 复审条件改为"再评估扩展帧头须开新 ADR；帧头不承载任何编码信息" |
| 4 | CLOSED | `ADR-0005:13` 6 bucket（含 `granted_capabilities` 字段，无 grants/secrets）；`:12` `auth.admin_password_hash` |
| 5 | CLOSED | `SECURITY` 全文无 `grants`/`secrets` bucket（grep 空）；密钥改 `/var/lib/kore/secrets/<id>.json`（:15）、授予改 `plugins.granted_capabilities`（:17,110） |
| 6 | CLOSED | `ROADMAP:107`、`CORE:223`（`RuntimeDirectoryMode=0700`）、`SECURITY:131/142` 均 0700 root:root |
| 7 | CLOSED | `CORE:34,40` 与 `DATA-MODEL:33` 均声明 DATA-MODEL §3 为唯一真源，CORE 不复写 |
| 8 | CLOSED | `CORE:42` 与 `DATA-MODEL:123` 均"未知字段 = WARN + 继续启动" |
| 9 | CLOSED | `DATA-MODEL:175,176` schema 降级/迁移失败退出码 4；`CORE:49` 同 |
| 10 | CLOSED | `SECURITY:132` 五个控制文件"取值与默认值以 RESOURCE-MODEL 为唯一真源，本文件不复制数值" |
| 11 | CLOSED | `SECURITY:30,70,91`「60s 窗口 5 次失败锁 300s」= `CORE:55` = `DATA-MODEL:58-60` |
| 12 | CLOSED | `ARCHITECTURE:322` 与 `ADR-0002:12` 主壳 socket 0600 root:root；`SECURITY:142` 同 |
| 13 | CLOSED | `ROADMAP:49,88,94`、`PLAN:32`、`MILESTONE:5,25,168`、`BOARD:49,59`、`JOURNAL:33,44` 均 8 篇 ADR（0001–0008） |
| 14 | CLOSED | `PROTOCOL:219`、`GLOSSARY:50`、`VISION:95,119`、`ARCHITECTURE:270`、`PLAN:27,68`、`ROADMAP:109`、`ADR-0002:14` 统一为「4 个必选方法 + 1 条必选事件通道」 |
| 15 | CLOSED | `CORE:68`、`GLOSSARY:42-43`、`PLAN:31` 均 8 项能力；`ARCHITECTURE` 枚举同为 8 项 |
| 16 | CLOSED | `ADR-0001:12` 链 = `CORE:114-121` 八层（含 csrf） |
| 17 | CLOSED | 全部 `/-/healthz`：`ROADMAP:107` `http://localhost/-/healthz`（原 `/api/v1/-/healthz` 已消除，grep 0 命中） |
| 18 | CLOSED | `SECURITY:90,109-112` 端点全带 `/api/v1` |
| 19 | CLOSED | `SECURITY:16` 与 `CORE:131` 均为 `/var/lib/kore/plugins/<id>/<version>/bin/<id>` |
| 20 | CLOSED | `ARCHITECTURE:284` 必含 6 节（含验证方式） |
| 21 | CLOSED | `WORKFLOW:61` G4（文档同步）/G6（资源预算）/G8/G9/G10 与 `QUALITY-GATES` 一致 |
| 22 | CLOSED | `MILESTONE:159` 明确 `[SKIP]`，`make check` 子项才是 `[N/A]` |
| 23 | CLOSED | `AGENTS:58` 六角色全集 |
| 24 | CLOSED | 旧 `kore db/backup/restore/invoke/audit` 零命中；现有 `kored db dump`（`DATA-MODEL:159`）见观察 O3 |
| 25 | CLOSED | `ADR-0003:28` 8 状态机（含 enabled/failed） |
| 26 | CLOSED | `ADR-0007:35` 已写"正文冲突已于 2026-11-21 同步完成" |
| 27 | CLOSED | `ADR-0001:8` 13 业务端点 + 3 静态 + `/-/healthz` = 17 项路由 |
| 28 | CLOSED | `VISION:102,149` 首屏 = index.html + 直接引用 JS/CSS，逐文件 gzip 求和；`FRONTEND:203-207` 同法 |

### 2.2 残留 6 条

| 项 | 判定 | 证据 |
| --- | --- | --- |
| #14 必选方法 | CLOSED | 全仓统一「4 方法 + 1 事件通道」：`PROTOCOL:219`、`GLOSSARY:50`、`ADR-0002:14`、`VISION:95,119`、`ARCHITECTURE:270`、`PLAN:27,68`、`ROADMAP:109`（"5 个必选方法/5 个方法" grep 0 命中） |
| #17 探针路径 | CLOSED | `ROADMAP:107` 已改 `/-/healthz`；全仓 `api/v1/-/healthz` 0 命中 |
| N1 8 层链 | CLOSED | `ARCHITECTURE:129` 已含 `csrf`（第 6 层），与 `CORE:114-121`、`GLOSSARY:75`、`ADR-0001:12` 完全一致 |
| N2 退出码 | CLOSED | `ARCHITECTURE:176` 无权限 → 3，`DATA-MODEL:131` 路径不可写/锁 → 3，`DATA-MODEL:180-183` 码表 3=状态目录或锁、4=存储或 schema、5=监听 |
| N3 首启口令 | **STILL-OPEN** | `CORE:56` 已改为首启 bootstrap（生成 24 字符、写回哈希、置 initialized、只打印一次），`DATA-MODEL:42`/`SECURITY:74` 同；**但 `CORE:42` 仍写「必填项仍缺失（如 `auth.admin_password_hash`）→ 退出码 2」**，与自动生成冲突 |
| N4 FRONTEND 前缀 | CLOSED | `FRONTEND:50` `GET /api/v1/events`；`:106` `POST /api/v1/plugins/{id}/enable`；无前缀形式 0 命中 |

### 2.3 拓扑类 T1–T10（全部 CLOSED）

| 项 | 判定 | 证据 |
| --- | --- | --- |
| T1 REPOS.md | CLOSED | `docs/REPOS.md` 172 行：§1 仓库清单、§2 拓扑图、§3 R1–R8、§6 创建清单（M0 仅 kore）、§0 硬约束、§5 版本矩阵 |
| T2 ADR-0008 | CLOSED | `docs/DECISIONS/0008-multi-repo-topology.md` 60 行，6 节齐全；`:2` 决策者=lead；备选含 monorepo（:30）、monorepo+workspace（:31）、submodule（:32）、多仓库（:33） |
| T3 无仓库内插件目录 | CLOSED | `grep "plugins/site\|plugins/backup\|plugins/echo"` 仅命中 `/run/kore/plugins/*.sock` 运行期 socket 与 ADR-0008 的"旧拓扑"叙述；`PLAN:41,136,203`、`ROADMAP:32,93`、`MILESTONE:55` 骨架目录均为 `pkg/pluginapi` 且明写"不得有 `plugins/`"。残留表述见 O1 |
| T4 pkg/pluginapi | CLOSED | `internal/pluginapi` 仅出现在 `Makefile:83-85` 的禁用检查器自身；文档/代码口径 19 个文件命中 `pkg/pluginapi`（`ARCHITECTURE:66-69`、`CORE:271-272`、`PLAN:69` 等） |
| T5 requires_kore | CLOSED | `PLUGIN-PROTOCOL:78`（字段表）、`:89`（区间语法仅两种）、`:91-92`（失败/与 protocol 关系）、`:171`（hello 表）、`:186`（协商顺序）、`:289`（升级校验）；`DATA-MODEL:143`（plugins bucket 字段）、`:151`（索引 schema）；`REPOS:109-116`（版本矩阵） |
| T6 索引非信任源 | CLOSED | `SECURITY:35`「索引只是发现渠道，不是信任源」、`:166`「kore 自行计算 `plugins.package_sha256`，不采信包内或索引声明」；`DATA-MODEL:151` 索引 schema 归 `kore-plugins` 的 `index/schema.json` |
| T7 插件前端不 embed | CLOSED | `FRONTEND:80,240` 明写 `go:embed` 只含主壳、插件资产来自 `/var/lib/kore/plugins/<id>/<version>/web/`；`SECURITY:167` 同 |
| T8 门禁/BOARD | CLOSED | `AGENTS` 86 行（≤130）含 G-13/G-14/G-15（:40-42）；`QUALITY-GATES:21-22` 含 G11/G12；`BOARD:17,45,65-71` 含变更集字段与登记区 |
| T9 M0 边界 | CLOSED | `ROADMAP:49,84`、`PLAN:5,19`、`MILESTONE:83`、`BOARD:71,86` 均写"只交付 `kore`" |
| T10 ADR 8 篇 | CLOSED | `ls docs/DECISIONS/` = 0001–0008 无重号；8 篇各 6 个二级标题（`grep -c '^## '` 全为 6） |

### 2.4 观察项（非 65 条内，但需在提交前修）

| 项 | 位置 | 事实 | 级别 | 回派 |
| --- | --- | --- | --- | --- |
| O1 | `.agents/WORKFLOW.md:36`、`.agents/ROLES.md:38` | implementer「产出/输出文件」仍列 `plugins/`（`cmd/ internal/ plugins/ web/`），与 G-13「插件代码不得进入 kore 仓库」矛盾 | P1 | E |
| O2 | `ROADMAP:119`、`GLOSSARY:106` | 散文缩写仍写 `GET /events`、`POST /auth/login → GET /plugins → POST /invoke/...`，未带 `/api/v1`（同文件其它位置全带） | P2 | D / A |
| O3 | `DATA-MODEL:159` | 引入 `kored db dump` 子命令，但 `CORE`/`ARCHITECTURE` 未登记该子命令与入口口径 | P2 | B |

## 3. 门禁有效性抽验（反向，证明不是"永远绿"）

在 `/tmp/kore-r3-negtest`（`cp -a` 工作区副本）造 `plugins/foo/main.go`：

```text
[FAIL] plugins/ 下发现插件代码（*.go）——插件属于 kore-plugin-<id> 独立仓库
plugins/foo/main.go
[OK] 无任何 kore-plugin- 源码导入
[OK] 无旧 SDK 路径 internal/pluginapi（统一 pkg/pluginapi）
[OK] 无插件索引 index/plugins.json（属 kore-plugins 仓库）
[OK] 无 submodule 化插件（.gitmodules 无 kore-plugin-）
repo-check: 4 pass, 1 fail
make: *** [Makefile:66：repo-check] 错误 1
EXIT=2
```

删除 `plugins/` 后复跑：`repo-check: 5 pass, 0 fail`，`EXIT=0`。副本已 `rm -rf`，工作区无任何临时文件（`ls` 复查无 `negtest|*.go` 残留）。

## 4. 一致性复核（r1 §3 十项全重跑）

| # | 结论 |
| --- | --- |
| 1 状态机 | PASS · `ARCHITECTURE` 8 状态 ↔ `PLUGIN-PROTOCOL:182` 8 状态 ↔ `ADR-0003:28`；`DATA-MODEL:142` 为存储视图 |
| 2 心跳 | PASS · `CORE:144` ↔ `ARCHITECTURE`（60s≈6 次）↔ `PLUGIN-PROTOCOL:275-276`（10s/2s/3 次/60s） |
| 3 超时 | PASS · `CORE:84` ↔ `ARCHITECTURE:137` ↔ `PLUGIN-PROTOCOL:264`（15s / 120s） |
| 4 cgroup | PASS · `RESOURCE:59-63` 五值；`SECURITY:132` 引用真源不复制 |
| 5 日志轮转 | PASS · `DATA-MODEL:21,202,252` ↔ `CORE:92` ↔ `SECURITY:175`（10 MiB×5 / ×2） |
| 6 端点 | PASS · `CORE:62` 13 端点 ↔ `PLAN:24` ↔ `AGENTS` ↔ `MILESTONE:149` ↔ `ADR-0001:8`（13+3+1=17 路由）；探针单一写法 `/-/healthz`；O2 为散文缩写观察项 |
| 7 角色与阶段 | PASS · 六角色 `AGENTS:58`；七阶段 `GLOSSARY:86`/`WORKFLOW:5`/`PLAN`/`MILESTONE`/`README` |
| 8 资源数字 | PASS · 8/24/48/25 MiB、300 KiB、0.1.0、`kore.plugin.v1`、`/run/kore`、`/var/lib/kore`、`/sys/fs/cgroup/kore` 全仓取值一致 |
| 9 依赖白名单 | PASS · `x/crypto`/`gin`/`sqlite` 仅禁止/复审语境；主壳三依赖口径一致 |
| 10 前端 | PASS · `FRONTEND` 12 令牌/侧栏 220/48/行高 32 未变；SECURITY/README 不复制 |

## 5. 统计与结论

- 文件：**43 个 / 5,580 行** —— docs/*.md 13 篇 + ADR 8 篇 + `.agents` 16 份（6 体系 + 4 模板 + 6 份验收文档）+ scripts 1 + 根 5；`make docs-check` 复跑：`全部 37 份文档元信息合规`，`docs-check: 6 pass, 0 warn, 0 fail`，rc=0。
- 冻结证据：r1/r2 四份验收文档 sha256 与落盘时一致（`93dc266a…ff881` / `a346efd7…feb440` / `8e778d9d…cd247` / `bbc98990…0f457`），本轮未修改。
- 销账：**43 CLOSED / 1 STILL-OPEN**（N3 残留）+ 3 观察项（O1 P1、O2/O3 P2）。
- 机械门禁 9/9 通过，`make check` 4/4，反向抽验证明 `repo-check` 真会红。
- 结论：**VERDICT: REVISE**（N3 一行修复 + O1 两行修复后即可 APPROVE 并提交；O2/O3 可同批清理）
