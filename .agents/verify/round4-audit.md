# Round 4 · 登录与方法调用审计 · 真机验证

> 状态: verified · 归属: verifier · 更新: 2026-11-23 · 里程碑: M3

本报告只记录可复跑的事实；口令一律以 `***` 占位，审计库与响应中均不含明文口令。

## 0. 隔离环境（G-29）

| 项 | 值 |
| --- | --- |
| 实例地址 | `127.0.0.1:18857`（**不是** 8787 主实例） |
| 二进制 | `/tmp/kore-audit-e2e/kored`（本轮源码 `go build` 产物） |
| 配置 / 状态 / 运行 / 日志 | `/tmp/kore-audit-e2e/{config.yaml,state,run,log}`（全部独立） |
| 已装插件 | `echo` 0.1.2（`capabilities=[system:read]`）、`db-mysql` 0.3.0（`capabilities=[system:admin]`） |
| 主实例影响 | **未改配置、未重启**：8787 `/-/healthz` = 200，PID 1435231 不变 |
| 环境降级 | cgroup 委派不可写、系统用户不存在 → socket 属主降级为当前用户（仅测试实例） |

## 1. 登录审计

| 步骤 | HTTP | 结果 |
| --- | --- | --- |
| 正确口令登录 | 200 | `{"authenticated":true,...}` |
| 错误口令 ×3 | 401 / 401 / 401 | `E_UNAUTHORIZED` |

`GET /api/v1/audit?since=1970-01-01T00:00:00Z` 聚合：

```text
total=4  {"login.failed":3,"login.success":1}
```

- `login.success`：`result=ok`、`subject=admin`、`detail={ip:127.0.0.x, user_agent:curl/8.18.0, session_id_prefix:0-CVGDcB}`（前缀 8 字符）。
- `login.failed`：`result=denied`、`detail={ip:127.0.0.x, user_agent:curl/8.18.0, reason:wrong_password}`。
- 口令泄漏检查：对整份审计响应 `grep -c '<口令>'` = **0**。

## 2. 方法调用审计（写 vs 只读）

| 调用 | 方法能力类 | HTTP | 审计增量 |
| --- | --- | --- | --- |
| `echo.echo`（插件只声明 `system:read`） | 只读类 | 200 | **+0** |
| `db-mysql.config.get`（插件声明 `system:admin`） | 写/管理类 | 200 | **+1** |
| `db-mysql.auditProbe`（未启用插件时的写类调用） | 写/管理类 | 409 `E_CONFLICT` | +1（`result=error`） |

写审计样例：

```text
{"action":"invoke.db-mysql.db-mysql.config.get","result":"ok","detail":[{"key":"duration_ms","value":"15"}]}
{"action":"invoke.db-mysql.db-mysql.auditProbe","result":"error","detail":[{"key":"duration_ms","value":"0"},{"key":"error_code","value":"E_CONFLICT"}]}
```

**只读不写审计反证**：成功调用 `echo.echo` 前后审计总数从 `8 → 8`（delta=0），审计库中没有 `invoke.echo.*`。

## 3. 审计量控制（100 只读 + 10 写）

```text
baseline=8
after 100 reads: count=8  delta=0
after 10 writes: count=18 write_delta=10 total_invoke_delta=10
```

结论：100 次只读 + 10 次写只增加 **10 条**，不是 110；只读路径完全不落审计库。

## 4. 突发合并（同一方法 1s 内 >10 次）

窗口前 `count=18`，连打 12 次 `db-mysql.config.get` 后：

```text
count=29  delta=11   # 10 条逐条 invoke.* + 1 条 invoke.burst
invoke.burst={"result":"ok","detail":[{"key":"count","value":"11"},{"key":"method","value":"db-mysql.config.get"},{"key":"window_ms","value":"1000"}]}
```

## 5. 查询可读（任务 C）

- `action=login.failed` 过滤：`count=3`。
- `at` 由键纳秒派生且非空：`at=2026-11-22T23:42:50.649522469Z`；全量 1000 条内 `at==""` 的记录数 = 0。
- 前端 `web/audit.js` 的动作下拉从响应 `records[].action` 去重聚合（约第 63 行），新增动作自动出现，无需改前端。

## 6. 关键口径（必须知道）

capability 是**插件级**而非方法级：`db-mysql` 只声明 `system:admin`，所以它的 `instances`（语义上的只读方法）在授权与审计口径里都属于 admin 类、会被审计。因此“只读不写审计”的反证用声明 `system:read` 的 `echo`，而不是 `db-mysql.instances`；若要让 `instances` 不审计，需要插件能力模型支持方法级声明（当前协议不支持，内核也不得维护业务词表，G-01）。

## 7. 门禁

| 命令 | 退出码 |
| --- | --- |
| `go test -timeout 200s ./...` | 0（全部包 ok） |
| `make check` | 0（11 段全过） |
| `make docs-check` | 0（5 pass / 1 warn / 0 fail） |
