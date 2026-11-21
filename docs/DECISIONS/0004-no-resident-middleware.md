> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: architect · 关联: [SECURITY](../SECURITY.md) · [ADR-0005](./0005-yaml-config-bbolt-state.md)

# ADR-0004: 不引入任何常驻中间件（DB/MQ/缓存/网关）

## 背景

kore 的定位是"资源零侵占、完全归属使用者"的薄壳：部署应当是一个二进制 + 一个配置文件，卸载不留残余。常驻中间件意味着额外的进程、端口、账号、备份策略与 CVE 跟进，每一项都与"零侵占"和"主壳 RSS ≤ 8 MiB"冲突。红线②与红线④已明确禁止中间件与容器化底座。

## 决策

kore 运行期**不依赖任何常驻中间件**：无独立数据库进程、无 MQ、无缓存服务、无反向代理网关。

- 状态：进程内 bbolt 单文件（见 [ADR-0005](./0005-yaml-config-bbolt-state.md)）。
- 事件：`internal/core/bus` 内存发布订阅 + 进程内 channel；跨进程只有 UDS 上的 `kore.event` 单向帧。
- 任务：元数据落 bbolt `tasks` bucket、任务工作目录落 `/var/lib/kore/tasks/<task_id>/`，由主壳 goroutine 轮询执行，不引调度中间件。
- 缓存：无独立缓存层；热点数据用进程内 map + 显式失效，上限受主壳预算约束。
- 静态资源：`//go:embed` 由 `net/http` 直接托管，不引 Nginx。
- 隔离：直接使用宿主 systemd + cgroup v2 + 文件系统权限。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| 无中间件（选） | 单二进制部署、无额外端口与账号、无额外攻击面、无版本升级负担 | 无现成 pub/sub 持久化、无 SQL 查询、无分布式能力 | 选它：与五锚点③④逐条对齐 |
| Redis | 缓存 + 轻队列 + pub/sub 一体 | 常驻进程、内存另计、需密码与持久化配置 | 红线②禁止；且主壳空载 8 MiB 预算不含外部进程 |
| NATS | 消息模型干净、跨机能力 | 常驻进程、端口、集群配置 | 同上；MVP 无跨机需求 |
| SQLite | 单文件 + SQL | 需 CGO 或纯 Go 驱动（引入依赖）、与 bbolt 功能重叠 | 依赖白名单只允许 bbolt；双写者模型复杂 |
| Postgres | 强一致、复杂查询 | 常驻服务、账号、备份、连接池 | 严重超出单机极简定位 |
| 自建文件队列（目录 + 锁） | 零依赖 | 原子性、崩溃恢复、并发控制全靠手写 | bbolt 事务已覆盖，重复造轮子 |

## 后果

**正面**：部署 = 复制二进制 + 写配置 + 起 systemd unit；卸载 = 停服务删目录；无监听端口（除可选回环 HTTP）；无中间件 CVE 跟进；资源账本只有主壳 + 插件两项，可精确核算。

**负面**：没有跨进程持久化队列，事件在进程重启时丢失（审计类事件写 bbolt 后才算落地）；没有 SQL，复杂报表只能遍历；没有缓存服务，多实例间不共享状态（本项目本就单实例）。

**技术债**：oneshot 任务的可靠重试需要自建租约（`tasks` bucket 的 `lease_until` 字段 + 启动扫描）；bus 的内存队列需设上限并在满时丢弃低优先级事件（否则成为内存泄漏点）。

### 什么时候会后悔（诚实评估）

1. **需要多实例/集群共享状态**：kore 单机定位下这不成立；一旦成立，bbolt 单写者 + 内存 bus 立刻变成阻塞项，届时不是"加个 Redis"而是重新评估定位（属非目标，需回 VISION 评审）。
2. **事件吞吐 > 10k msg/s 或需要重放**：内存 bus 会丢事件，需持久化日志；届时优先考虑 bbolt 追加表 + 游标，而不是引入 MQ。
3. **需要跨机任务调度**：oneshot 的租约模型只在单机成立。
4. **数据量 > 1 GiB**：bbolt 打开与压缩成本上升，需要分库或归档策略。
5. **需要复杂查询报表**：遍历 + 内存聚合在 10 万行以上会明显变慢。

以上五条出现任意两条，本 ADR 应被重开，而不是"就地加个中间件"。

## 验证方式

```bash
ss -lntp | grep -E ':(6379|4222|5432|3306|11211)\b' || echo "无中间件端口"
ps -eo comm= | grep -xE 'redis-server|nats-server|postgres|mysqld' || echo "无中间件进程"
go list -m all | grep -E 'redis|nats|sqlite|postgres|pgx' || echo "依赖干净"
systemctl list-units --type=service --state=running | grep -c kore   # 仅 kore 自身 unit
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
```

## 复审条件

出现以下任一信号即重开：需要多实例或集群（先回 VISION 判定是否越界）；事件吞吐或重放需求超出内存 bus 能力；任务表出现跨机调度；bbolt 单文件 > 1 GiB 或打开耗时 > 500 ms；出现必须依赖某中间件才能满足的对外协议（如必须消费 Kafka 主题）。
