# Round 6 · scheduler 真机验收（ADR-0019）

> 日期: 2026-11-23 · 执行者: r6-scheduler（implementer）· 待 verifier 独立复跑

隔离实例：`/tmp/kore-r6`（`--config /tmp/kore-r6/config.yaml`，`server.addr=127.0.0.1:18849`，state/run/log 全落 `/tmp`）。**未改动主实例（8787）的运行态配置**，未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`。

## 1. 环境与安装

```bash
CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /tmp/kore-r6/kored ./cmd/kored   # exit 0
/tmp/kore-r6/kored install --config /tmp/kore-r6/config.yaml \
  --package /home/pt/Work/GolandProjects/kore-plugin-echo/dist/echo-0.1.2.tar.gz        # "installed echo 0.1.2" exit 0
curl -s http://127.0.0.1:18849/-/healthz                                               # {"status":"ok"}
```

登录走 `POST /api/v1/auth/login`（会话 cookie + `X-Kore-CSRF` 双提交；口令不入档，此处不复写）。

## 2. 创建任务

```bash
POST /api/v1/scheduler/tasks
{"name":"r6-ping","plugin":"echo","method":"echo.ping","params":{},"schedule":"*/1 * * * *","timeout_s":30}
# {"id":"tsk-f03d5cc34b55548a",...,"enabled":true,"next_run_at":"2026-11-23T10:02:00+08:00"}
POST /api/v1/scheduler/tasks
{"name":"r6-disabled","plugin":"echo","method":"echo.ping","schedule":"*/1 * * * *","enabled":false}
# {"id":"tsk-d9f687b8a9fd33da",...,"enabled":false}
```

## 3. 到点执行（90s 窗口）

```bash
# 创建于 10:01:48；10:05:39 读列表
GET /api/v1/scheduler/tasks
tsk-f03d5cc34b55548a r6-ping enabled=True  last_run_at=2026-11-23T10:05:01.77+08:00 last_result=ok next=10:06:00
tsk-d9f687b8a9fd33da r6-disabled enabled=False last_run_at=None last_result=None next=10:02:00
```

结论：启用的分钟级任务在窗口内真实执行（`echo.ping` 返回 ok）并推进 `next_run_at`；禁用任务 3 分钟以上从未执行（**禁用 → 不再执行**）。

## 4. 停机错过不补跑（真机复核）

重启前任务 `next_run_at=10:02` 已过；重启后：

```bash
tsk-f03d5cc34b55548a missed_count=1 last_result=missed next=2026-11-23T10:05:00+08:00
日志: {"msg":"定时任务错过，不补跑"}
```

未补跑（10:02 那次没有执行），记录 `missed` 并从 now 重算下次时间。

## 5. 手动执行 / 删除 / 失败口径

```bash
POST /api/v1/scheduler/tasks/tsk-f03d5cc34b55548a/run
# {"status":"ok","dur_ms":0,...}（不改 next_run_at）
DELETE /api/v1/scheduler/tasks/<id> ; DELETE .../<id2>   # {"deleted":true} 两次
GET /api/v1/scheduler/tasks                               # {"tasks":[]}
GET /api/v1/scheduler/tasks（无 cookie）                  # 401
POST .../tasks {"schedule":"* * * *"}                     # 400 {"code":"E_INVALID","message":"...5 段...实际 4 段"}
```

## 6. cert_renew 迁移为内置任务

配置 `cert_renew.enabled=true, interval=1h` 后重启：

```json
{"id":"builtin-cert-renew","name":"证书续期检查","plugin":"kore","method":"cert.renew_due",
 "interval_s":3600,"enabled":true,"next_run_at":"2026-11-23T11:06:12+08:00"}
```

原独立 ticker 不再创建；关闭 `cert_renew.enabled` 时该任务被禁用（单测 `TestSyncCertRenewTask`）。

## 7. 真机暴露并修复的两个缺陷（诚实披露）

| # | 现象 | 根因 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| 1 | 端点回 501「调度器未装配」 | `httpapi.Options` 加了 `Scheduler` 字段，但 `cmd/kored/serve_boot.go` 的 `startHTTP` 没注入 `svc.sched` | 补注入一行 | 真机重测通过 |
| 2 | 任务创建后永远不执行（`next_run_at` 不动） | `Service.Add` 把 HTTP 请求 `ctx` 传给长驻调度循环，响应写完即取消 → ticker 秒退 | 调度循环改用服务级 `baseCtx`，生命周期只跟随 `Stop()` | 单测 `TestLoopSurvivesRequestContext` |

## 8. 未覆盖 / 边界

- 52 周后跨年的 `2 月 29 日` 只在单测覆盖（真机不等待）。
- 无任务时 ticker 停止由单测 `TestLoopStopsWhenNoEnabledTasks` 证（`/system/info` 不暴露 goroutine 数，真机无直接观测点）。
- `cert.renew_due` 事件广播未落地（bus 事件投递面缺失），内置任务当前只记录到点执行（`published=false`）——已在 ADR-0019「技术债」与 DATA-MODEL 披露。
- 端点无「启停任务」路由（任务书写的是 4 条路由），禁用需创建时 `enabled=false` 或删除重建。
