> 状态: accepted · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [0019-scheduler](./0019-scheduler.md)、[0016-resource-budget-final](./0016-resource-budget-final.md)、[DATA-MODEL](../DATA-MODEL.md) §11、[CORE](../CORE.md) §2.15

# ADR-0044: 审计记录按龄清理落在 scheduler 内置任务（不新增定时器）

## 0. 问题（文档承诺 vs 代码事实）

`docs/DATA-MODEL.md` 承诺 `audit` 保留 90 天、`tasks` 保留 30 天，但代码零实现：`audit` 只有 `ForEach` 读取路径（`internal/core/store/audit.go`），无按龄删除；`tasks` bucket 只有建库定义、无任何读写方（`internal/core/store/store.go`）。审计日志无限增长是真实运维风险——同日刚定位过「每次鉴权写盘」的写放大问题，日志无界增长是同一类账。

## 1. 决策

1. **`audit` 清理落地为 scheduler 内置任务** `builtin-audit-clean`（`plugin=kore`、`method=audit.clean`、`interval_s` 型），复用 ADR-0019 的**唯一单 ticker**；不新增 `time.NewTicker` / `time.AfterFunc` / 周期 goroutine（G-19）。
2. **参数落任务 `params`**：`{"retention_seconds":…,"batch":…}`，来源配置 `audit.retention`（默认 2160h=90 天）/ `audit.clean_batch`（默认 1000，硬顶 10000）；周期来源 `audit.clean_interval`（默认 6h）；总开关 `audit.clean_enabled`（默认 true）。参数未变时重启**不推迟** `next_run_at`。
3. **默认开启**。审计无界增长是默认路径上的真实问题，默认关闭等于把承诺继续悬空；代价是默认配置下调度器常驻一个 ticker（仍是单实例单 ticker）。要严格零 ticker 可显式关闭，文档写明代价。
4. **单次上限**：一次清理最多删 `clean_batch` 条，未删完时结果 `more=true`，下个周期继续；不一次长事务扫全桶。
5. **可观测**：每次清理写一条 `action=audit.clean` 审计 + 一条 INFO 日志；写审计失败只 WARN。清理失败只落 `failed` 的 `scheduler_runs` 记录 + WARN，不阻塞调度、不影响读路径。
6. **`tasks` 不实现清理，改为撤销承诺**：该 bucket 无写入方，为它实现按龄删除没有意义；文档改为「预留 bucket，无写入方 → 不定义保留窗口」，等写入方落地时再定义规则。
7. **不做在线 compaction**：删键只释放页供复用，文件大小停在高水位。在线压缩需关闭独占句柄再换文件，运行中做有丢写风险；真要缩文件走停服 + bbolt CLI 离线压缩，文档写明运维路径。
8. **清理入口唯一化 + 内置任务身份约束**（P1 修复，`a0cd926`）：删除审计的参数不得来自调用方。`plugin="kore"` 是内核伪插件保留名，**API 不得创建**（`POST /api/v1/scheduler/tasks` 回 400 `E_INVALID`、任务不落库）；`audit.clean` 只允许固定 id `builtin-audit-clean` 执行，其他任务 id 一律拒绝。参数加硬下限 `retention_seconds ≥ 24h`（与 `audit.retention` 配置下限同口径）、`batch` 1–10000——任何一次清理都删不掉最近 24h 的审计，即使任务参数被伪造或残留旧值。被拒绝的清理尝试写 `audit.clean(result=error)`，detail 带被尝试的 `retention_seconds` / `batch`（可解析时）。

## 2. 被否决的选项

| 选项 | 否决理由 |
| --- | --- |
| 新增独立 ticker / 后台 goroutine | 直接违反 G-19 与 ADR-0019（定时器唯一来源是 scheduler） |
| 写路径惰性清理（原 §11 设计意图） | 每 N 次审计写入触发一次删除，把清理成本压到业务写路径；今天刚踩过鉴权写盘放大，不再引入第二类写侧放大 |
| 只在启动时清理 | 长期运行的守护进程永远等不到下一次；且启动期做批量写会把启动时间绑定到积压量 |
| 默认关闭、要求运维显式开启 | 默认路径继续无界增长，等于承诺仍然悬空 |
| 在线 `bolt.Compact` | bbolt 要求独占文件；运行中换文件需要「关库 → 压缩 → 重开」，窗口内写入丢失、句柄错配风险高，收益（缩文件）不抵风险 |
| 给 `tasks` 实现清理 | bucket 无写入方，实现的是死代码；正确做法是撤销承诺而不是写空转逻辑 |

## 3. 后果

- 默认配置下调度器有 1 条启用内置任务，ticker 常驻（30s 检查；内置清理任务每 6h 到点）。空闲成本为一次每秒不足一次的任务表扫描，仍在 G-03 空闲预算内（`make idle` 取证）。
- 审计库增长被封顶在「保留期 × 写入速率 + 高水位」；文件不会因清理变小，容量规划按高水位。
- `audit.retention` / `clean_enabled` / `clean_interval` / `clean_batch` 属冷配置：SIGHUP 只提示 ignored，需重启重建内置任务。
- `GET /scheduler/tasks` 可直接看到内置任务的参数与最近执行结果，排障不需要读代码。
- **留痕是 best-effort，不是 fail-closed**（如实边界）：`audit.clean` 审计写入失败只 WARN，不阻止清理；这条 error 记录本身最终也按保留期被清理，但**同一次清理删不掉它**（记录晚于本次 `cutoff`，且保留期下限 24h）。真正「删不掉」需要归档 / WORM 存储，本轮未做。

## 4. 验证

- `internal/core/store/audit_retention_test.go`：造 3 条过期 + 2 条未过期 → 只删过期；batch=2 分三次收敛且 `more` 正确；第二次执行幂等（deleted=0）；坏键不删；limit≤0 报错且不删任何记录。
- `internal/core/scheduler/auditclean_test.go`：配置映射为内置任务（周期/参数/`next_run_at`）、重启不推迟；经 `execute` 执行只删过期并写 `audit.clean`；清理失败落 `failed` 且读路径仍可用。
- `internal/core/scheduler/auditguard_test.go`：`retention_seconds=1`、非内置任务 id、API 创建 `plugin="kore"` 三类拒绝各有用例，并验证拒绝后旧记录不删、留一条 `audit.clean(result=error)`；去掉对应保护即 FAIL（反例自证）。
- 门禁：`go vet ./...`、`go test ./...`、`make docs-check`、`make idle`（有 `kored` 时真跑）。

## 5. 复审条件

- 审计写入速率显著上升（如 `invoke.burst` 频繁触发）导致 90 天保留超出容量规划 → 调 `audit.retention` 或引入按插件分级保留；
- 引入第二个需要按龄清理的数据源（如 `tasks` 写入方落地）→ 把清理逻辑抽成可配置的通用内置任务族，而不是每条再加一个任务；
- bbolt 提供安全的在线压缩能力 → 重新评估「不做在线 compaction」。
