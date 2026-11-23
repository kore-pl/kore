# Round 5 · R5-5 槽位保护（resident 限 2 + lazy 保底 1 槽）验收报告

> 日期: 2026-11-23 · owner: r5-slot-protection · 关联事故: `CS-20261123-01` · 设计依据: [RESOURCE-MODEL.md §2.6](../../docs/RESOURCE-MODEL.md)

## 1. 范围与隔离声明

- 改动：`internal/core/supervisor/{manager,lazy,options,instance}.go`、`internal/core/config/*`、`internal/core/httpapi/types.go`、`cmd/kored/serve_{runtime,daemon_actions}.go`、`internal/core/supervisor/resident_slots_test.go`、`internal/core/config/resident_max_test.go`、`internal/core/httpapi/system_info_slots_test.go` + 文档。
- 真机回归用**隔离实例** `127.0.0.1:18851`：独立 `--config`，state/run/log 全落 `/tmp/kore-slot-18851`，索引仍指向 `kore-plugins/index`。
- **主实例 8787 未重启、未改配置、未改运行态**（`bin/kored` 由 `make build` 更新，主实例继续持有旧 inode；G-29 声明）。回归结束已杀隔离进程并删除 `/tmp/kore-slot-18851`。

## 2. 单元测试（事故回归）

命令：`go test -timeout 200s -run 'TestResident|TestSlotLimits|TestReloadResidentMax|TestSystemInfoSupervisorSlots' -v ./internal/core/supervisor/ ./internal/core/config/ ./internal/core/httpapi/`
退出码：**0**

```text
--- PASS: TestResidentQuotaRejectsThird            # 3 resident → 第 3 个 E_RATELIMIT + 列出当前 resident
--- PASS: TestResidentTwoPlusLazyWakeSucceeds       # 2 resident + 1 lazy 唤醒成功（事故回归）
--- PASS: TestResidentTwoPlusThreeLazyAlternate     # 2 resident + 3 lazy 交替唤醒，无 429
--- PASS: TestResidentMaxOneRejectsSecond           # resident_max=1 → 第 2 个被拒
--- PASS: TestResidentMaxThreeIsProtectionOff       # resident_max=3 → 允许 3 resident，lazy 429（预期）
--- PASS: TestResidentInvokeCannotBypassQuota       # invoke 冷启不能绕过配额
--- PASS: TestResidentAdmissionEvictsLazy           # 满槽启动 resident 驱逐 idle lazy，总数不超 3
--- PASS: TestSlotLimitsClampsResidentMax           # 越界值兜底为 max_slots
--- PASS: TestResidentMaxDefaultsAndParse           # 默认 2；配置可覆盖
--- PASS: TestResidentMaxValidation/{下界1,默认2,放弃保护3,越界0,越界4}
--- PASS: TestReloadResidentMaxRequiresRestart      # 不热更，保留旧值 + 需重启 WARN
--- PASS: TestSystemInfoSupervisorSlots             # /system/info 暴露 resident_max=2 / lazy_slots=1
```

全量：`go test -timeout 200s ./...` 退出码 **0**（14 个包全 ok）。

## 3. 真机回归（隔离实例 18851）

前置：`make build` 退出 0（`kored 0.1.0`，协议 `kore.plugin.v1`）；用 `kored install --package` 依次安装 `site 0.2.0`（resident）、`terminal 0.1.1`（resident）、`monitor 0.2.1`（lazy）、`echo 0.1.2`（resident，用作第 3 个常驻的拒绝对象），4 次安装退出码均 0。

### 3.1 事故场景回归：2 resident + monitor lazy → 200

```text
POST /api/v1/plugins/site/enable      → 200 state=ready pid=2084228
POST /api/v1/plugins/terminal/enable  → 200 state=ready pid=2084253
POST /api/v1/plugins/monitor/enable   → 200 lifecycle=lazy state=stopped（enable 不拉起进程）
POST /api/v1/invoke/monitor/system    → HTTP 200
payload keys: cpu, disks, load, memory, network, sampled_at, schema, source, uptime, warnings
sample: {"schema":"monitor.system.v1","source":"proc","load":{"load1":4.67,...}}
```

进程实测（`pgrep -af /tmp/kore-slot-18851/state/plugins/`）：`site`、`terminal`、`monitor` 三个进程同时在跑 —— **在 2 个 resident 占住配额后，任一 lazy 插件的唤醒不再 429**（事故的直接回归）。

### 3.2 第 3 个 resident 被拒（明确报错 + 当前列表）

```text
POST /api/v1/plugins/echo/enable → HTTP 429
{"code":"E_RATELIMIT","message":"常驻插件已达上限 2（推荐 ≤2）；如需启用请先停用其他常驻插件：site、terminal","detail":""}
```

`GET /api/v1/system/info` 的 `supervisor`：

```json
{"resident": 2, "restarts": 0, "resident_max": 2, "lazy_slots": 1}
```

### 3.3 启动按 desired 恢复：第 3 个只 WARN，不阻断启动

为验证 A4 的启动路径，令 `echo` 的 `desired=enabled`（失败 enable 会保留 desired），重启实例后日志：

```text
level=WARN msg="槽位保护拒绝恢复常驻插件（继续启动其余插件，不阻止内核）" plugin_id="terminal"
err="E_RATELIMIT: 常驻插件已达上限 2（推荐 ≤2）；如需启用请先停用其他常驻插件：echo、site"
```

内核继续启动，`/system/info` 仍为 `resident=2, resident_max=2, lazy_slots=1`，`monitor.system` 仍 **200**。
**残留风险（诚实披露）**：启动恢复按 catalog id 字典序、不按历史运行优先级。存在 3 个历史 `desired=enabled` 的 resident 时，具体被拒的是哪一个取决于 id 排序（本例 `echo` 排在 `site`/`terminal` 前，于是 `terminal` 被拒）。这是既有恢复语义，不在本任务改造范围；默认配置下用户最多只能产生 2 个 desired resident，只有升级前遗留的 3 resident 状态会触发。

### 3.4 收尾基线（disable echo 后重启）

```text
states: site=ready/desired=enabled, terminal=ready/desired=enabled,
        monitor=stopped(lazy)/desired=enabled, echo=stopped/desired=disabled
supervisor: {"resident":2,"restarts":0,"resident_max":2,"lazy_slots":1}
POST /api/v1/invoke/monitor/system → HTTP 200
进程: site + terminal + monitor 三个
```

## 4. 门禁

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `go test -timeout 200s ./...` | 0 | 14 个包全 ok |
| `make docs-check` | 0 | 5 pass / 1 warn / 0 fail（WARN 为 PLUGIN-PROTOCOL/RELEASE 行数，既有） |
| `make check` | 0 | 11/11 段通过 |
| `make secret-check` | 0 | 0 FAIL（证据占位符合规） |

## 5. 诚实披露（保护不是根治）

1. `resources.resident_max=3` 即**显式放弃保护**：3 个 resident 仍可占满槽位，lazy 唤醒仍 429；内核在该配置下启动打 WARN。
2. 该配置**不热更**（SIGHUP 只提示需重启），避免「配置显示 1、运行仍按 2」的漂移。
3. 候选 B（resident 主动驱逐，处理在途请求语义）与候选 C（`max_slots` 可配置，需联合校验 48 MiB 红线）均未实现，保留为后续 ADR 议题。
