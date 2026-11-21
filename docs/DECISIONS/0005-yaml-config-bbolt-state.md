> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: architect · 关联: [SECURITY](../SECURITY.md) · [ADR-0004](./0004-no-resident-middleware.md)

# ADR-0005: 配置 YAML + 状态 bbolt，不引 SQLite/Postgres

## 背景

kore 需要两类数据：**人要读写、要版本化的配置**（监听地址、口令哈希、插件策略、开关）与**程序读写的运行状态**（插件台账、能力授予、会话、审计、任务）。要求：单文件可备份、无外部进程、`CGO_ENABLED=0` 可静态编译、依赖白名单内。

## 决策

- **配置**：单一 YAML 文件 `/etc/kore/config.yaml`（env `KORE_CONFIG` 覆盖），权限 `0600 root:root`，解析用 `gopkg.in/yaml.v3`；变更走"校验 → 写临时文件 → `rename` 原子替换"，热重载只重读非安全关键字段（`auth.admin_password_hash` 不热重载）。
- **状态**：`go.etcd.io/bbolt` 单文件 `/var/lib/kore/kore.db`，权限 `0600`；bucket 固定为 **6 个**：`meta`（schema 版本）、`plugins`（含 `granted_capabilities` 字段）、`plugin_state`、`tasks`、`sessions`、`audit`；不建 `users`、不单设 `grants`、不设 `secrets`。
- **迁移**：`meta.schema_version` 整数；启动时逐版本执行迁移函数，只前进不回退；迁移前 `kore.db.bak-<version>` 备份一份。
- 写路径统一经 `internal/core/store`，禁止在业务处直接开事务；只读路径用 `View`，写路径用 `Update` 且保持短事务（不做网络/进程 IO）。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| YAML + bbolt（选） | YAML 人可读可版本化；bbolt 纯 Go、单文件、B+ 树事务、无 CGO | 无 SQL、单写者、迁移手写 | 选它：依赖白名单内且满足单机单进程 |
| SQLite | SQL 查询、生态成熟、文件单库 | `mattn/go-sqlite3` 需 CGO（破坏静态编译），纯 Go 驱动另引依赖 | 依赖白名单不允许；CGO 会把 25 MiB 单二进制与跨平台构建搞复杂 |
| Postgres | 强一致、并发、复杂查询 | 常驻服务 + 账号 + 备份 | 违反红线②；单机极简定位下是过度设计 |
| 纯文件目录（每实体一个 JSON） | 可 `ls`、可手改、可 git | 原子性靠 rename、索引靠扫描、并发靠锁 | 会话/审计/任务需要范围扫描与事务，文件方案在 10 万条时退化 |
| BoltDB 旧库（boltdb/bolt） | 同 bbolt 前身 | 已归档、无维护、无 Go 1.18+ 适配 | 用维护中的 fork `bbolt` |
| JSON 配置代替 YAML | 标准库直接支持，零依赖 | 无注释、无多行字符串、手写体验差 | 配置需要注释与可读性，YAML 是白名单内唯一选择 |

## 后果

**正面**：配置可 diff、可回滚、可被配置管理工具纳管；状态单文件，备份 = `cp kore.db`；`CGO_ENABLED=0` 静态编译成立；bbolt 的 `Update` 保证多 bucket 写入原子，插件安装"写 `plugins` 台账（含 `granted_capabilities`）+ 写 `audit`"可在一个事务里完成。

**负面**：bbolt 单写事务串行，长事务会阻塞所有写（必须短小）；没有查询语言，按插件/时间范围检索要建二级索引 bucket 或全遍历；YAML 解析对缩进敏感，配置错误要靠启动期校验拦下并给出字段级错误。

**技术债**：需要维护 schema 迁移链与备份清理；插件 secret 不进状态库，M0–M2 明文存 `/var/lib/kore/secrets/<plugin-id>.json`（`0600 root:root`，目录 `0700`），M4 换主密钥信封加密时需要按文件迁移并保留格式版本字段（见 [SECURITY](../SECURITY.md) 第 9 节）；审计表增长需要定期裁剪（30 天或 10 万条）并考虑压缩。

## 验证方式

```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tmp/kored ./cmd/kored   # 无 CGO 依赖
go list -m all | grep -E 'sqlite|postgres|pgx|mysql' || echo "无 SQL 驱动"
file /var/lib/kore/kore.db                                                    # "data"，非 SQLite 头
stat -c '%a %U:%G' /etc/kore/config.yaml /var/lib/kore/kore.db                # 600 root:root
# schema 迁移幂等：连续启动两次，版本不变
./kored --check-config && ./kored --check-config
```

## 复审条件

出现以下任一信号即重开：需要跨进程并发写同一份状态（插件直连 DB——当前明确禁止）；数据量 > 1 GiB 或打开耗时 > 500 ms；审计/任务检索需要复杂聚合且遍历延迟 > 200 ms；M4 加密迁移导致格式无法向前兼容；出现必须 SQL 才能满足的对外导出格式。
