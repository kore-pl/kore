> 状态: final · 归属: verifier · 更新: 2026-11-22 · 里程碑: M3-C
> 验收者: verifier（m3-c-audit-3，独立复跑，未复用实现者 m3-c-audit-2 的输出；G-09 implementer≠verifier）
> 验收对象: M3-C 审计落盘（9 改 + 9 新，git status 核对无误：9 M + 9 ??）
> VERDICT: **APPROVE** —— 四条验收命令全部独立复跑通过，无阻断项。

# M3-C 审计落盘 · 独立验收报告

## 1. 验收命令与证据（全部 verifier 本机原样复跑）

### ① `go test -timeout 200s -run 'TestAudit' -v ./internal/core/store/ ./internal/core/supervisor/`
退出码 **0**，5 PASS：
- store：`TestAuditEventPersistence` PASS、`TestAuditRejectedByControlledDetail` PASS、`TestAuditPutAndListRoundTrip` PASS、`TestAuditStormFiftyWrites` PASS（50 连写前 25 条 4.07ms / 后 25 条 4.00ms，无劣化）
- supervisor：`TestAuditLifecycleEvents` PASS

### ② `make idle`（真实 kored + 四类事件注入后采样 65s）
退出码 **0**，`idle: 5 pass, 0 fail, 0 n/a`：
| 指标 | 实测 | 阈值 | 结果 |
| --- | --- | --- | --- |
| 空闲 CPU | 0 ms/60s | ≤60 ms | OK |
| 线程数(/proc/status) | 15（15→15 稳定） | ≤20 | OK |
| 打开 fd | 7 | ≤64 | OK |
| 出站连接 | 0 | 0 | OK |
| 周期定时器 | 零命中 | 零命中 | OK |

启动方式：`python3` + `close_fds=True` + `start_new_session=True` + 最小 env（PATH only），单 kored 进程；未继承宿主 ~70 fd（该坑已规避）。

### ③ grep 三口径（周期性定时器零命中）
- 审计 9 文件 `grep -rnE 'NewTicker|AfterFunc'`：退出码 1（零命中）
- 全内核 `grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/`：退出码 1（零命中）
- store+supervisor 排除注释行后扫描：零命中

### ④ `make check`
退出码 **0**，10/10 段全绿：docs-check 6 pass、dep 2 pass、thin-shell 4 pass（业务词/动作词各 0 命中）、repo-check 5 pass、canonical 9 pass、log/wt/oss/case 全 pass、frontend 首屏 4151 B ≤ 300 KiB。

## 2. 端到端真机证据（verifier 自建，非复用实现者输出）

按配方隔离 `/tmp/kore-m3c-verify`，装 echo-0.1.0，PBKDF2 登录，经 UDS 注入四类事件：
- enable（state=ready）→ `kill -9` echo（crash）→ invoke ping（`{"pong":true}`，触发 retry）→ disable（state=stopped）
- state.db 审计键：`grep -aoE '[0-9]{20}-[0-9]{6}' | sort -u` → **恰好 4 行且升序**
- action：`grep -aoE 'plugin\.(enable|disable|crash|retry)' | sort -u` → **plugin.crash / plugin.disable / plugin.enable / plugin.retry 各 1**
- 原始键命中 8 次 = bbolt COW 旧页残留，唯一键 4 即记录数（口径正确）

无请求对账：事件在 Start/reap/Stop 发生时直接写库（`audit_events_test.go` 全程无 HTTP，PASS）。

## 3. 独立核查两处专项

- **bbolt Batch 禁用依据属实**：`$(go env GOMODCACHE)/go.etcd.io/bbolt@v1.3.11/db.go` 953 行 `db.batch.timer = time.AfterFunc(db.MaxBatchDelay, db.batch.trigger)`、958 行 `go db.batch.trigger()` —— Batch 确实内部起定时器+goroutine，G-19 禁用成立；实现用 `store.Update`（bbolt 单事务）正确。
- **plugin.retry 命名认可**：薄壳门禁整词扫描 `create|restart|deploy` 为 0 命中（make check 3/10 实证），`plugin.retry` 语义等价且已在 `docs/DATA-MODEL.md` §9 留痕（"restart 整词禁入可执行代码，取语义等价词"），处置合规。

## 4. 边界核查

`TestAuditRejectedByControlledDetail` 已 PASS：result 仅 ok/denied/error；detail 键 ≤16、键 ≤32 字符、值 ≤256 字符（按 `len([]rune)` 字符计）、序列化 ≤1 KiB；非法拒收不落库（落库条数=合法写入数）。G-24 无 any/object 逃逸。

## 5. 问题定级与销账

| 项 | 级别 | 状态 | 证据 / 归属 |
| --- | --- | --- | --- |
| G-06：DATA-MODEL §6.3 原写"审计走 Batch"与 §9 及实现冲突 | 记录（已修复） | **CLOSED** | owner 已改 line 192 为"禁用 Batch + 依据"，verifier 回读确认，make check 复跑 10/10 |
| DATA-MODEL §6.1 `chan writeOp` 单写者与现实现（store 直接 db.Update，bbolt 自带写锁）不符 | 记录（非本轨） | **OPEN·既有债** | M1 期遗留，不在 M3-C 写域；上报 lead/architect，不阻断本轨验收 |

## 6. 清理证明

- 停止验证 kored（`pkill -x kored`）后 `pgrep -x kored` 无输出；临时 `/tmp/kore-m3c-verify`、`/tmp/verify_*.txt` 已删除；verifier 不提交、不 git add/commit。
- 本轨仅新增本报告 1 个文件，未改任何代码/文档。
