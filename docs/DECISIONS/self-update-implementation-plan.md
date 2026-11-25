> 状态: proposed（实现任务图，供 lead 审阅后派发；本卡只写文档，不建 team_task、不改代码）· 归属: designer（task-41）· 更新: 2026-11-26 · 里程碑: R26 · 门禁关联: G-06 / G-07 / G-08 / G-09 / G-12 / G-19 / G-23 / G-29 / G-31
> ADR 状态: proposed · 关联: [草案 §6.2](./self-update-design-draft.md)、[ADR-0058](./0058-local-update-caller-identity.md)（U1）、[ADR-0059](./0059-silent-update-trigger-and-supply-chain.md)（U2/U4/U6）、[ADR-0023 §3.5 修订提案](./adr-0023-amendment-selfupdate.md)（U3，待 accept）、[ADR-0056](./0056-self-restart.md)（U5 本地边界）、[角色卡](../../.agents/ROLES.md) §3/§4/§8
> 纪律: implementer ≠ verifier（G-09 / ROLES §8）；red-team ≠ implementer；写域同层不相交（G-08）；验收靠命令 + 退出码 + 关键输出（G-07）；不 push、不执行 install/serve/upgrade；品牌 Kore/kore。

# 静默自更新实现任务图（MVP / 完整两期）

## 0. 本图的使用方式

1. 这是**文档版任务图**，供 lead 审阅后按 `.agents/WORKFLOW.md` 建 `team_task_*` 派发；本卡不建任务、不改代码、不跑实现门禁。
2. 每个任务给出：目标 / 写域 / 依赖 / 角色 / 验收命令 + 退出码 + 关键输出 / ADR 前置门槛。
3. **ADR 门槛**：标注「需先 accept」的任务在该 ADR 正式 accepted 之前不得开工；ADR-0058 / 0059 已 accepted（2026-11-26），ADR-0023 §3.5 提案仍 **proposed**，U5 的实际安装那一次仍须**执行时单独确认**（不可逆操作不预先代授权）。
4. 同层任务写域互不相交；同一任务内 implementer 与 verifier 必须是不同 agent（G-09）；验收命令由 verifier 独立复跑、贴原文，不复用 implementer 输出。
5. 品牌：产品显示 **Kore**，代码内部标识（路径 / 配置键 / 能力名 / cookie / 变量）一律 `kore` 小写。

## 1. 依赖总览（DAG）

```
ADR-0058 accepted ✓ ─┬─→ M1 本机专用端点（UDS + peercred + 专用能力）
                     └─→ M2 进程内编排服务（共享内核，不重复逻辑）
ADR-0059 accepted ✓ ─┬─→ M3 批量编排器（复用 reloadOne）
                     ├─→ M4 scheduler update.check 内置任务（默认禁用）
                     └─→ M7 备份/磁盘配置 + stale 自动清理
ADR-0023 §3.5 提案 [需用户 accept] ─→ M5 本地更新状态文件 + changes.jsonl 登记  ← 唯一带 ADR 门槛的任务
U5 设计口径已授权 / 实际安装当次确认 ─→ M8 形态 A 全闭环演练（安装动作单独确认）
ADR-0019 append 修订 ─→ M4（任务登记，先追加修订段再实现内置任务）
ADR-0025 append 修订 ─→ M6（内核资产索引字段，先追加修订段再实现供应链入口）

MVP = M1 + M2 + M3 + M5(部分，受 ADR 门槛) + M8(设计口径；安装当次确认)
完整期 = M4 + M6 + M7 + M9（离线 B 路径 + 双形态演练 + 红队反例）
```

## 2. MVP 期任务清单

### M1 · 本机专用更新端点（U1=A）

- **目标**：UDS-only 更新入口；`SO_PEERCRED` uid ∈ {0, kored uid}；单一专用能力；公开门零变化（ADR-0058 §3.1）。
- **写域**：`internal/core/httpapi/`（鉴权 / 端点注册 / 审计事件）、`cmd/kored/serve*.go`（装配）、`docs/CORE.md`（端点计数 + 端点表）、`docs/SECURITY.md`（身份边界段）。
- **依赖**：ADR-0058 accepted ✓；不依赖 M5。
- **角色**：implementer 实现 + 自测；verifier 独立复跑（不同 agent）。
- **验收命令 / 退出码 / 关键输出**：
  - `go test -timeout 200s ./internal/core/httpapi/...` → exit 0；鉴权正反例全过。
  - `curl --unix-socket <isolated-run>/kore.sock -i http://localhost/api/v1/store/install`（未登录）→ 401；公开门契约不回退。
  - 伪造 uid / loopback TCP 冒用专用端点 → 401/403；审计 `system.self_update` 无凭据字段。
  - `make docs-check` → exit 0（端点计数同步）。
- **复用原语**：`local_access.go:75-93` 的 peercred 判据、`middleware.go:26-72` 的公开门。

### M2 · 进程内更新编排服务（U1=B）

- **目标**：kored 内部服务，直接调 installer / upgrade 原语；与 M1 共用同一编排结果结构、审计与 fail-closed 语义（ADR-0058 §3.2）。
- **写域**：`cmd/kored/`（新编排模块）、`internal/core/`（仅规则 / 接口，不写插件业务，G-01）。
- **依赖**：M1（共用契约）；ADR-0058 accepted ✓。
- **角色**：implementer ≠ verifier。
- **验收**：
  - `go test -timeout 200s ./cmd/kored/... ./internal/core/...` → exit 0。
  - 编排 Happy path 输出 `phase=committed`、同一结果结构与 M1 一致（对比测试）。
  - `make vet` → exit 0；`grep -rn "plugins/" internal/core` → 零命中（G-01/G-13）。

### M3 · 批量更新编排器（U2=A）

- **目标**：读索引算待更新项 → 按依赖序逐条调单条 store/install → 复用 `reloadOne`（`cmd/kored/serve_runtime.go:262`）→ 汇总 + 失败分诊；单条失败不整批回滚。
- **写域**：`cmd/kored/`（编排器）、`internal/core/market/`（只读索引读取 / 待更新项计算）、`docs/CORE.md`（若新增内部端点才改；本任务不新增对外 schema）。
- **依赖**：M2；`--scenario` 的离线 B 路径归 M9，不进本任务。
- **角色**：implementer ≠ verifier。
- **验收**：
  - `go test -timeout 200s ./cmd/kored/... ./internal/core/market/...` → exit 0。
  - 隔离实例一次触发 N 个插件 → 全部 200；`GET /plugins` 立即新版本、无需重启内核；启用态与升级前一致；注入一条失败 → 其余项仍成功、失败项可单条重试。
  - **禁止**改 `store/install` 对外 schema（G-24，U2-C 留完整期）。

### M5 · 本地更新状态文件 + changes.jsonl（U3，**需先 accept ADR-0023 §3.5 提案**）

- **目标**：一个安装目录外状态文件的原子写 + 逐项账本登记 + 可回滚；仅在提案 accepted 后开工（ADR-0023 提案 §1/§3.1）。
- **写域**：`cmd/kored/`（状态文件读写 + `file.remove` purge_op）、`scripts/zero-intrusion-check.sh`（snap 增该路径断言）、`docs/DATA-MODEL.md` / `docs/RUNBOOK-INSTALL.md`（schema / 回滚说明）。
- **依赖**：**ADR-0023 §3.5 修订提案 accepted**（硬门槛）；M2（编排结果写入）。
- **角色**：implementer ≠ verifier；red-team 另派（不得是 implementer）做误删 / 绕过账本反例。
- **验收**：
  - `go test -timeout 200s ./cmd/kored/...` → exit 0（原子写 + 账本登记正反例）。
  - `make zero-intrusion-check` → exit 0；有状态文件时账本有 `file.remove` 条目；卸载后文件不存在。
  - `make secret-check` → exit 0；状态文件样本无凭据字段。
  - **若提案未 accept**：本任务整体 BLOCKED，不得用「先写 `<install>/data/` 再说」绕过（ADR-0023 §3.5 原文仍生效）。

### M8 · 形态 A 全闭环演练（U5，设计口径已授权 / 安装当次确认）

- **目标**：root systemd 服务（`kore.service`，ADR-0042 目标形态）下走完插件热更新 + 内核 upgrade + 自重启 + finalize；portable 形态内核升级 fail-closed 白话提示。
- **写域**：仅验收报告 `.agents/verify/self-update-mvp.md` + 必要的文档同步（**不改代码**；如需代码修复回派 M1–M3）。
- **依赖**：M1 + M2 + M3 + M5（若提案未 accept，M5 状态文件项跳过并显式标注 BLOCKED）；**实际安装 root 服务须执行时单独确认，本图不代授权**。
- **角色**：verifier 主导演练（独立于 M1–M3 implementer）；root 安装动作由 lead 向用户当次取得确认后再派。
- **验收**：
  - `make check` → exit 0（21 段门禁）；`make idle` → exit 0（出站 0 / CPU / fd / goroutine 达标）。
  - 内核 happy path：`upgrade` → `.prev` 存在 → 重启后 marker pending→success；错 sha 时目标字节不变。
  - portable：`upgrade` 非 root → exit=3（exitEnv）且白话 hint，不假成功（`upgrade.go:137`）。
  - 报告贴命令 + 退出码 + 关键输出（G-07）；root 安装若未获当次确认，该项标 **NOT EXECUTED** 而非 PASS。

## 3. 完整期任务清单

### M4 · scheduler 更新检查内置任务（U4，默认关闭）

- **目标**：唯一 ticker 上注册 `update.check` 内置任务；默认禁用；`IsOffline` 短路无报错；验签失败带 `requires_restart:true`（ADR-0059 §3.1）。
- **写域**：`internal/core/scheduler/`（任务注册）、`cmd/kored/`（装配）、`docs/DECISIONS/0019-scheduler.md`（**append 修订段**，不改正文）、`docs/CORE.md`（scheduler 任务表）。
- **依赖**：ADR-0019 append 修订先落盘（G-06/G-23）；M2；**U4 默认关闭口径**（`update.source.enabled=false` 默认值）。
- **角色**：implementer ≠ verifier。
- **验收**：
  - `go test -timeout 200s ./internal/core/scheduler/...` → exit 0；`make idle` → exit 0（未开启时出站 0、定时器白名单零新增）。
  - 关闭 + 断网 → 任务短路、零报错、零出站；开启 + 篡改签名 → 拒绝且 detail 含 `requires_restart:true`。
  - `grep -rn "time.NewTicker\|time.AfterFunc" internal/core` 仅 scheduler 命中（G-19）。

### M6 · 内核供应链入口（已验签索引 → https → sha256）

- **目标**：消费 ADR-0025 验签索引里的内核资产条目；https 绝对 URL + sha256 校验先于替换；落本地临时文件后交 `upgrade --bin`（拒绝 URL，`upgrade.go:10-14`）。
- **写域**：`internal/core/market/`（索引字段显式化，G-24）、`cmd/kored/upgrade*.go` 的调用侧（不碰 accepted 语义）、`docs/DECISIONS/0025-index-signing-redesign.md`（**append 修订段**）、`docs/SECURITY.md`。
- **依赖**：ADR-0025 append 修订先落盘；M4；M5（状态文件记录 sha / phase；若 M5 BLOCKED，则退化为内存 + `.prev` 并显式披露）。
- **角色**：implementer ≠ verifier；red-team 另派（篡改索引 / 资产 / 公钥轮换反例）。
- **验收**：
  - `go test -timeout 200s ./internal/core/market/... ./cmd/kored/...` → exit 0。
  - 缺 `download_url` → E_INVALID、零下载（`download_test.go:109-118` 先例）；file: / http: → 拒绝（`download_test.go:125` 先例）；篡改 sha → 目标字节不变。
  - 换公钥 → rebuild + 重启后新公钥生效（ADR-0025 §7）；全流程零 git push / tag / CI 触发。

### M7 · 备份份数与磁盘上限（U6）

- **目标**：`backup.keep_count`（默认 2）+ `backup.max_disk_bytes`（按 G-03 预算比例保守默认）可配置；`stale_versions` 超限自动清理，保底 1 份可回滚；清理写审计。
- **写域**：`internal/core/config/`（配置键）、`internal/core/market/`（stale 语义改：`types.go:104-106` 现状「不自动删」）、前端文案（若涉及 UI 则按 G-28 补双端截图）、`docs/DATA-MODEL.md` / `docs/USABILITY.md`。
- **依赖**：M3；M5（审计写状态文件，若 BLOCKED 则用既有审计通道并披露）。
- **角色**：implementer ≠ verifier。
- **验收**：
  - `go test -timeout 200s ./internal/core/market/... ./internal/core/config/...` → exit 0。
  - 装 4 个旧版本 + `keep_count=2` → 清理后恰好保留 2 份 + `.prev` 可回滚；审计含删除清单；`make budget-check` → exit 0。
  - 若改 UI：`make frontend` → exit 0，G-28 双端截图（1440×900 + 390×844）+ 自评三问齐全。

### M9 · 离线 B 路径与双形态收口

- **目标**：`--scenario` 真批量作离线 / 演练补充（不进静默主链）；形态 A / B 端到端演练；fail-closed 提示；G-10 符合性双基线核对。
- **写域**：`cmd/kored/install.go`（`install.go:61-72` 的 `E_UNSUPPORTED` 补齐）、验收报告 `.agents/verify/self-update-full.md`。
- **依赖**：M3 + M4 + M6 + M7 + M8。
- **角色**：implementer 补 CLI；verifier 独立演练；red-team 另派（身份绕过 / G-10 隐藏出站 / 误删回滚材料）。
- **验收**：
  - `make check` → exit 0；`make idle` → exit 0；`make secret-check` → exit 0；`make zero-intrusion-check` → exit 0。
  - 基线 A（更新源关闭 + 断网）：`ss -tnp | grep kored` 出站 0；基线 B（用户显式开启）：只到用户配置源的短连接，无遥测字段（ADR-0054 §4 口径）。
  - `--scenario` 离线批量成功后如实提示 CLI 停服限制（`store.go:95-100`）；报告标注形态限制不是缺陷。

## 4. 派发时的写域矩阵（G-08：同层不相交）

| 任务 | 主写域 | 与谁同层并行 | 冲突规避 |
| --- | --- | --- | --- |
| M1 | `httpapi/` + `serve*.go` + CORE/SECURITY | M4（scheduler） | 不同包；若同改 `docs/CORE.md` 由 lead 串行收口 |
| M2 | `cmd/kored/` 编排模块 | M6（market/upgrade） | 同 `cmd/kored/` 目录时按文件独占派发，禁止互相写对方文件 |
| M3 | `cmd/kored/` 编排器 + market 只读 | M7（market 配置） | market 同包按文件拆分；接口新增方法视为同一写域（AGENTS §4），串行 |
| M5 | `cmd/kored/` 状态文件 + zero-intrusion 脚本 | M6 / M7 | 状态文件 API 若被 M6/M7 调用，先落接口契约再并行 |
| M4 | `internal/core/scheduler/` + ADR-0019 append | M6（ADR-0025 append） | 两个 ADR append 段互不相交 |
| M6 | `internal/core/market/` + upgrade 调用侧 | M7 | 同 market 包按文件独占 |
| M7 | `config/` + market stale + 前端 | M9 | 前端 UI 与 G-28 截图同任务内闭环 |
| M8 / M9 | 验收报告（`.agents/verify/`） | 无代码写域 | 若发现缺陷，回派原 implementer，verifier 不改代码 |

## 5. 硬门槛清单（开工前核对）

| 门槛 | 当前状态 | 影响任务 |
| --- | --- | --- |
| ADR-0058 accepted | ✅ 2026-11-26 | M1 / M2 |
| ADR-0059 accepted | ✅ 2026-11-26 | M3 / M4 / M6 / M7 |
| ADR-0023 §3.5 修订提案 accepted | ❌ proposed（待用户） | **M5 不得开工**；M5 未做时 M6/M7 的审计写退化为既有通道并披露 |
| ADR-0019 append 修订段落盘 | ❌ 待实现卡 | M4 不得注册内置任务 |
| ADR-0025 append 修订段落盘 | ❌ 待实现卡 | M6 不得改索引字段语义 |
| U5 实际安装 root 服务当次确认 | ❌ 未取得 | M8 的安装动作标 NOT EXECUTED，不代授权 |
| 公开会话门不回退（ADR-0043） | ✅ 贯穿 | 所有任务：任何 UDS/loopback 免登录改动即 BLOCKED |
| G-10 默认离线 + 无遥测（ADR-0059 §3.3） | ✅ 贯穿 | M4 / M6 / M9：默认开启或隐藏上报即 BLOCKED |

## 6. 角色与证据纪律（G-07 / G-09）

1. 每个任务单独建 `team_task_*`，`owner` = implementer；验收时另派 verifier（新 agent，名字不得与 implementer 相同），verifier 按本图命令原文复跑，贴「命令 + 退出码 + 关键输出」。
2. impl 自测通过 ≠ 验收通过；verifier 不得复用 impl 输出，不得改被验收代码，不得新增 / 放宽门禁（ROLES §4）。
3. red-team 另派，不等于 implementer：M5（账本绕过 / 误删）、M6（索引 / 资产 / 公钥篡改）、M9（身份伪造 / 隐藏出站）必须有反例报告。
4. 同仓并行纪律：M2/M3/M5/M6 都在 `cmd/kored/`，涉及公共接口新增方法或测试替身时视为同一写域，串行派发并预留涟漪预算（AGENTS §4）。
5. 本图自身是文档，不进入实现门禁；实现卡的每条验收标准按 G-07 逐条留痕，缺命令 / 退出码 / 输出即不得 complete。

## 7. 复审条件

1. U3 提案被拒 → M5 重设为「仅在 `<install>/data/` 内」方案并另开 ADR，本图相关任务全部重画依赖。
2. U2-C（批量 API schema）提上日程 → 新增独立 ADR + G-24 复核任务，不得塞进 M3。
3. G-03 预算或 G-10 判据变更 → 重估 M7 默认值与 M4/M6 的出站例外边界。
4. 若 implementer 与 verifier 被迫由同一 agent 承担 → 该次验收作废，按 G-09 重派 verifier。
