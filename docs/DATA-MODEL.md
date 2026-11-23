# 数据模型（配置 · 状态 · 日志）

> 状态: draft · 归属: architect · 更新: 2026-11-24 · 里程碑: M0

kore 只有三类持久数据：**明文配置**、**单文件 bbolt 状态**、**文件日志**。不引入任何数据库服务进程。本文件是字段与落盘格式的唯一来源；协议字段见 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md)，预算与度量见 [RESOURCE-MODEL.md](./RESOURCE-MODEL.md)。

## 1. 存储原则

1. **无独立 DB**：状态只存 `/var/lib/kore/state.db`（bbolt），不引入 SQLite/Postgres/Redis，不为存储多起一个进程。
2. **明文可审计**：配置是 YAML 文本，可 diff、可 grep、可手改；bbolt 里的 value 是 JSON 文本，用 bbolt CLI 离线读出（`bbolt get state.db <bucket> <key>`，须先停 `kored`，见 §10）；`kored db dump` 子命令**未实现**，别照敲。
3. **单文件可备份**：bbolt 具备 `Tx.CopyFile` 边写边拷的一致快照能力，但当前**无 CLI 入口**——运维按 §10 停机 `cp -a` 备份；备份 = `state.db` + `config.yaml` + 插件包，三个路径即可重建。
4. **写入有唯一入口**：写事务统一经 `Store.Update` 透传到 bbolt `db.Update` 单事务，由 bbolt 内置文件锁（`LOCK_EX|LOCK_NB` + `Timeout`）保证单写者与进程间互斥；无 writer goroutine、无 chan 队列（详见 §6.1）。

## 2. 分层表

| 层 | 路径 | 形态 | 生命周期 | 备份 |
| --- | --- | --- | --- | --- |
| 配置 | `/etc/kore/config.yaml`（env `KORE_CONFIG` 可覆盖） | YAML 文本，0600 | 长期，人工维护 | 每次备份必带 |
| 状态 | `/var/lib/kore/state.db` | bbolt 单文件，0600 | 长期，schema 迁移 | 停机 `cp -a`（见 §10） |
| 插件 | `/var/lib/kore/plugins/<id>/<version>/`（`bin/<id>` + `web/`） | 目录 + 二进制 | 长期，保留当前与上一版本 | 打包含 sha256 |
| 日志 | `/var/log/kore/kore.log`、`/var/log/kore/plugins/<id>.log` | 文本，10 MiB 轮转 | 滚动保留 5 份/2 份 | 不备份（可重建） |
| 任务产物 | `/var/lib/kore/tasks/<plugin>/<ts>.json` | 每次执行的 stdout/stderr 与结果摘要 | 短期，保留 7 天 | 不备份（可重建） |
| 商店缓存 | `/var/lib/kore/store/index.json` | JSON 索引缓存，0600 | 短期，过期即删 | 不备份（可重建） |
| 临时 | `/run/kore/`（socket、pid、`plugins/<id>.json` 运行态） | socket/pid/运行态 JSON | 进程生命周期，重启重建 | 不备份 |

路径解析优先级：环境变量 > CLI > 配置文件 > 上述默认值。`KORE_CONFIG` 覆盖配置路径本身；`KORE_STATE_DIR` 覆盖 `paths.state_dir`；`KORE_PLUGIN_DIR` 覆盖 `paths.plugin_dir`。**派生规则**：`paths.state_dir` = `KORE_STATE_DIR` > `--state-dir` > 配置 `paths.state_dir` > `/var/lib/kore`；`paths.plugin_dir` = `KORE_PLUGIN_DIR` > 配置 `paths.plugin_dir` > **`<state_dir>/plugins`（未显式设置时派生）**——只设 `KORE_STATE_DIR=/tmp/x` 时，状态库为 `/tmp/x/state.db`、插件目录自动为 `/tmp/x/plugins`（M1 修复：此前写死，与 `state_dir` 脱节）。env 覆盖时启动日志记 WARN 说明生效来源。

多版本并存：每个 `<id>/<version>/` 是独立目录，升级保留当前 + 上一版本；回滚 = 把 registry 指向上一版本目录并以该目录 `bin/<id>` 重启进程，删除目录即释放磁盘。插件包由 `kore-plugin-<id>` 仓库 `make dist` 产出，本仓库只解包与登记，不构建插件。商店缓存不是真源：真源在 `kore-plugins` 的 `index/plugins.json`，`/var/lib/kore/store/index.json` 只是离线可看的副本，丢失或过期即可直接删除，下次显式刷新重建。

CLI 形态：运维子命令全部由单二进制 `kored` 提供，用标准库 `flag` 手写分发，不引入 cobra/urfave 等 CLI 框架（依赖白名单 G-02）。**已实现**（`kored help` 为唯一权威清单）：`serve`（默认）/ `version` / `install` / `uninstall` / `status` / `upgrade` / `audit` / `admin-password`。**未实现**：`kored db dump` / `kored backup` / `kored restore` / `kored invoke <plugin> <method>`——备份恢复按 §10 的停机手工流程执行，`db` 系列上线前不可执行；`invoke` 已由 ADR-0046 裁决**不再计划**（没有对外 CLI 唤醒入口，定时唤醒走内核 scheduler）。

## 3. config.yaml

本节是 `config.yaml` 键名的唯一真源；CORE 与其它文档只引用键路径，不复写字段表。

### 3.1 schema 字段表

| 字段 | 类型 | 默认 | 约束 |
| --- | --- | --- | --- |
| `server.addr` | string | `""` | 空 = 不监听 HTTP；非空必须是 `host:port`，MVP 只接受 `127.0.0.1:<port>` |
| `server.socket` | string | `/run/kore/kore.sock` | 主壳 UDS 路径，父目录启动时创建（0700） |
| `server.tls` | bool | `false` | MVP 固定 off；置 true 启动拒绝并提示走反向代理 |
| `auth.admin_password_hash` | string | `""` | 空 = 首次启动生成 24 字符随机口令、写回哈希并置 `auth.initialized=true`；非空必须是 §3.3 的 PBKDF2 存储串 |
| `auth.session_ttl` | duration | `168h`（7 天） | 1m–720h；未显式配置时 168h。**滑动续期阈值 = `min(24h, ttl/2)`**（7 天→24h、12h→6h、1h→30m）：仅当剩余寿命低于阈值才把 `expires_at` 推到 `now+ttl` 并重发 cookie（相邻续期至少间隔 `ttl/2`，避免每次鉴权写盘）；**绝对上限 30 天**（`created+30d`，续期不得越过）；改后需重启内核生效（SIGHUP 不热更）；**不做 300s 下限**（下限只是 GUI 滑块的 UX 护栏，手写 YAML 不需要；短 TTL 不降低安全性，只会让配置者更频繁重登——裁决见 `.agents/LOG/DECISIONS.md`） |
| `auth.cookie_secure` | string | `auto` | `auto` \| `true` \| `false`；`auto` = TLS 或回环 Host 时给会话 cookie 加 `Secure`，否则不加并 WARN |
| `auth.initialized` | bool | `false` | 首次生成口令后由内核置 `true`；`true` 时启动不再打印临时口令。重置 = 人工置 `false` 并清空 `auth.admin_password_hash`；`initialized=true` 但哈希为空视为不一致，拒绝启动 |
| `paths.state_dir` | string | `/var/lib/kore` | 必须可写；含 `state.db`、`plugins/`、`tasks/` |
| `paths.log_dir` | string | `/var/log/kore` | 必须可写；含插件日志子目录 |
| `paths.run_dir` | string | `/run/kore` | 0700；socket 落此处 |
| `paths.plugin_dir` | string | `<state_dir>/plugins`（**未显式设置时派生**，默认即 `/var/lib/kore/plugins`） | 解包目标；`KORE_PLUGIN_DIR` 可覆盖 |
| `paths.index_dir` | string | `/var/lib/kore/index` | 索引仓路径（`plugins.json` + `plugins.json.sig`）；必须可写，空值拒绝启动 |
| `log.level` | string | `info` | `debug` \| `info` \| `warn` \| `error` |
| `log.rotate.max_size_mb` | int | `10` | 1–100；单文件轮转阈值 |
| `log.rotate.max_backups` | int | `5` | 1–20；保留份数 |
| `resources.defaults.memory_mb` | int | `12` | 4–12；info.json 缺省时使用 |
| `resources.defaults.cpu_quota` | string | `"50%"` | `"10%"`–`"100%"` |
| `resources.defaults.pids_max` | int | `128` | 16–512 |
| `resources.enforce` | bool | `true` | false = 监控模式，不写 cgroup 限额 |
| `resources.resident_max` | int | `2` | 1–3；resident 插件独占上限，3 = 放弃槽位保护（lazy 无保底槽）；需重启生效；必须 ≤ max_slots(3) |
| `plugins.allow_unsigned` | bool | `true` | MVP true；M4 起默认 false |
| `plugins.autostart` | string[] | `[]` | 元素必须是已安装插件 id；启动时按序拉起。默认不硬编码任何插件：`site` 由 M2 安装流程显式写入 |
| `store.allow_unsigned` | bool | `false`（零值，**不在 `Default()` 中设置**） | 仅显式配置；为 `true` 时允许未签名/验签失败的索引（M2 索引级 ed25519 签名）；与 `plugins.allow_unsigned`（插件包签名，M4）完全独立，勿混用 |
| `security.login_rate_limit.attempts` | int | `5` | 1–20；窗口内失败次数 |
| `security.login_rate_limit.window` | duration | `60s` | 10s–1h |
| `security.login_rate_limit.lock` | duration | `300s` | 30s–24h；触发后锁定 IP 时长 |
| `audit.invoke_all` | bool | `false` | false = 只审计按插件 capabilities 需要 admin 的写/管理类 invoke（只读类不审计，防日志爆炸）；true = 审计全部 invoke（调试用）；SIGHUP 可热更 |
| `audit.retention` | duration | `"2160h"`（90 天） | 24h–8760h；审计记录保留期，早于 `now - retention` 的记录由内置清理任务删除（§11）；需重启生效 |
| `audit.clean_enabled` | bool | `true` | false = 不注册按龄清理内置任务（回到"审计无界增长"状态）；需重启生效 |
| `audit.clean_interval` | duration | `"6h"` | 30s–168h；清理周期（调度器内置任务 `interval_s`）；需重启生效 |
| `audit.clean_batch` | int | `1000` | 1–10000；单次清理删除上限，超出部分留到下个周期（防一次长事务）；需重启生效 |
| `cert_renew.enabled` | bool | `false` | 唯一允许的常驻定时器开关；关闭时内核不创建任何 ticker |
| `cert_renew.interval` | duration | `"6h"` | 仅 `enabled=true` 时生效；范围 1h–24h；非法值 → 退出码 2 |

`store.*` 与包签名的边界：`store.allow_unsigned` 管的是**索引仓签名**（`index/plugins.json.sig`，M2 的 ed25519 验签），零值 `false` 即默认拒绝未签名/验签失败的索引；它由 Go 结构体零值兜底，**刻意不在 `Default()` 中显式设置**，只允许显式配置并写 WARN 审计。它与 `plugins.allow_unsigned`（**插件包签名**，M4）是两个完全独立的开关，作用对象、里程碑与默认值都不同，不得互相替代或混写。

`cert_renew.*` 的设计约束（ADR-0019 起迁移为 `scheduler` 的内置任务）：默认 `enabled: false`，严格守住「默认零后台定时器」资源锚点；关闭时对应的内置任务被禁用，无任何启用任务时内核不创建 ticker。内核**不做 ACME、不联网**，到点只标记 `cert.renew_due` 并写执行记录，实际续期由插件完成（内核只定规则不做业务）。**诚实披露**：bus 的事件投递面尚未落地，内置任务当前只记录到点执行、不广播事件。唯一周期源是 `internal/core/scheduler/` 的单 ticker，代码层门禁见 CORE 的 `grep time.NewTicker` 检查。

`audit.*` 保留策略（ADR-0044）：`audit.retention` 默认 `2160h`（90 天），清理由 scheduler 内置任务 `builtin-audit-clean`（`plugin=kore`、`method=audit.clean`、`interval_s=audit.clean_interval`、`params={retention_seconds,batch}`）执行——复用既有单 ticker，**不新增任何定时器**。与 `cert_renew` 的差别是**默认开启**：审计无界增长是真实运维问题，所以默认配置下调度器会常驻一个 ticker（仍是单实例单 ticker，ADR-0019）；要严格零 ticker 可设 `audit.clean_enabled: false`，代价是审计重新无界增长。四项 `audit.*` 清理参数需重启生效（SIGHUP 报 ignored），因为内置任务在 `scheduler.New` 时装配。

### 3.2 完整示例（含注释）

```yaml
# /etc/kore/config.yaml — kore 0.1.0（M0）
server:
  addr: "127.0.0.1:8787"        # 空字符串 = 只开 UDS；MVP 只允许回环地址
  socket: "/run/kore/kore.sock" # 主壳入口，权限 0600
  tls: false                    # MVP 固定 off，由反向代理终结 TLS

auth:
  # PBKDF2-HMAC-SHA256：600000 次迭代、16B salt、32B key，原始 base64（无填充）
  admin_password_hash: "pbkdf2-sha256$600000$c2FsdHNhbHRzYWx0c2FsdA$0V9k..."
  session_ttl: "168h"           # 显式示例；省略时默认 168h（7 天）。滑动阈值 min(24h, ttl/2)，绝对上限 30 天
  cookie_secure: "auto"         # auto|true|false：TLS 或回环时自动加 Secure
  initialized: false            # 首次生成口令后内核置 true，二次启动不再打印

paths:
  state_dir: "/var/lib/kore"          # state.db / plugins / tasks
  log_dir: "/var/log/kore"            # kore.log / plugins/<id>.log
  run_dir: "/run/kore"                # kore.sock / plugins/<id>.sock
  plugin_dir: "/var/lib/kore/plugins"  # 省略时派生为 <state_dir>/plugins
  index_dir: "/var/lib/kore/index"    # 索引仓路径：plugins.json + plugins.json.sig

log:
  level: "info"                 # debug|info|warn|error
  rotate:
    max_size_mb: 10             # 单文件 10 MiB 触发轮转
    max_backups: 5              # kore.log 保留 5 份，总上限 50 MiB

resources:
  defaults:                     # info.json 未声明时的兜底值
    memory_mb: 12
    cpu_quota: "50%"
    pids_max: 128
  enforce: true                 # false = 只监控不阻断（无 cgroup 时自动降级）
  resident_max: 2               # resident 独占上限（1–3；2 = lazy 至少保留 1 槽；3 = 放弃保护，需重启生效）

plugins:
  allow_unsigned: true          # 插件包签名（M4）：MVP 允许无签名；M4 起默认 false
  autostart: []                 # 启动即拉起的常驻插件 id 列表；默认空，由安装流程显式写入

store:                          # 软件商店：索引仓签名（M2），与 plugins.allow_unsigned 完全独立
  allow_unsigned: false         # 默认零值 false，不在 Default() 中设置；true = 允许未签名/验签失败的索引，需显式配置并写 WARN 审计

security:
  login_rate_limit:
    attempts: 5                 # 60s 内 5 次失败即锁定
    window: "60s"
    lock: "300s"                # 锁定 5 分钟

audit:
  invoke_all: false             # 默认只审计需要 admin 的写/管理类 invoke；true = 全量审计（调试用，SIGHUP 热更）

cert_renew:                     # 迁移为 scheduler 内置任务，默认关（ADR-0019）
  enabled: false                # false = 内核不创建任何 ticker
  interval: "6h"                # 仅 enabled=true 生效；范围 1h–24h
```

### 3.3 PBKDF2-HMAC-SHA256 参数

算法固定 **PBKDF2-HMAC-SHA256，600,000 次迭代，salt 16 字节，派生 key 32 字节**；实现用 Go 1.24+ 标准库 `crypto/pbkdf2`（零新增依赖、无 CGO，满足 G-02 依赖白名单）。存储格式写死为 `pbkdf2-sha256$600000$<base64(salt)>$<base64(hash)>`（base64 为无填充 RawStdEncoding，存储串不带 PHC 前缀）。生成命令：`go run ./cmd/kore-hash`（M1 提供）。登录校验用 `crypto/subtle.ConstantTimeCompare` 比较派生 key，不允许降级为 md5/sha256。**复审条件**：若未来默认暴露公网或引入多用户，改用内存硬哈希（Argon2id 系列）并开 ADR 放宽依赖白名单（允许 `golang.org/x/crypto`）。

## 4. 校验规则

处置三分法（固定，不再逐项解释）：**未知字段 = WARN + 继续启动（附拼写建议）**；**类型错误 / 必填缺失 / 取值越界 = 拒绝启动，退出码 2**。

| 情况 | 处置 | 输出 |
| --- | --- | --- |
| 未知字段 | 允许，记 WARN 后继续启动 | `config.yaml:41: 未知字段 plugins.foo，已忽略` |
| 类型错误 | 拒绝启动，退出码 2，打印文件:行号 | `config.yaml:31: auth.session_ttl 期望 duration（如 "12h"），实际为 int` |
| 必填缺失 / 状态不一致 | 拒绝启动，退出码 2 | `config.yaml: auth.initialized=true 但 auth.admin_password_hash 为空` |
| 取值越界 | 拒绝启动，退出码 2 | `config.yaml:22: server.addr 必须是 127.0.0.1:<port>` |
| 路径不可写 / 锁被占用 | 拒绝启动，退出码 3 | `paths.state_dir=/var/lib/kore 不可写（EPERM）` |
| 未知字段但拼写接近已知字段 | 仍只 WARN，附建议 | `... 是否想写 plugins.autostart？` |

实现：用 `yaml.v3` 的 `yaml.Node` 解析，逐节点校验类型并取 `Node.Line` 给出行号；未知字段通过白名单比对，不用 `KnownFields(true)`（它会直接报错，无法只 WARN）。配置类失败退出码 2（完整启动失败码表见 §7），日志同时写 stderr 与 `kore.log`。

## 5. bbolt 设计

数据库：`/var/lib/kore/state.db`，`bbolt.Open(path, 0600, &bbolt.Options{Timeout: 1*time.Second, NoSync: false})`；**锁用 bbolt 内置 flock（`LOCK_EX|LOCK_NB` + `Timeout=1s`），另写 `state.lock` 记录 pid；`internal/core` 不直接调 `syscall`（G-16：平台专有 `syscall` 收在 `internal/platform`）**；page size 4096。键为 UTF-8 字符串（时间序靠可排序编码），值为 JSON 对象（UTF-8，无缩进）；单值上限 1 MiB，超限视为设计错误。MVP 不建 `users` bucket（单管理员来自 config）；`tasks` bucket 只存索引，原始输出落 `/var/lib/kore/tasks/`（保留 7 天），两处口径共同构成任务记录。

| bucket | key 编码 | value 编码 / JSON schema | 清理策略 |
| --- | --- | --- | --- |
| `meta` | 固定字符串：`schema_version` `installed_at` `kore_version` `last_backup_at` `preset_snapshot_version` `store_last_refresh_at` | `{"schema_version":1}` / `{"ts":"..."}` / `{"version":"0.1.0"}` / `{"preset_snapshot_version":"2026-11-21.1"}` / `{"ts":"..."}`（上次显式刷新时间，不是出站心跳） | 永不清理 |
| `plugins` | 插件 id（如 `site`） | `{id,name,version,lifecycle:"resident"\|"lazy"\|"oneshot",idle_timeout_s,protocol,requires_kore,capabilities[],granted_capabilities{granted_by,granted_at,version,declaration_sha256,capabilities[],added_capabilities[]},triggers[],resources{memory_mb,cpu_quota,pids_max},installed_at,package_sha256,signed,source:"store"\|"local"\|"embedded"\|"manual",scenario_id,depends_on[],size_bytes,store_visibility,prev_version}` | 卸载即删；保留 `prev_version` 供回滚；索引仓库用同一 `requires_kore` 做兼容过滤；`scenario_id` 记录首次安装来源预设，手动安装为空 |
| `plugin_state` | 插件 id | `{desired:"enabled"\|"disabled",actual:"ready"\|"degraded"\|"failed"\|"stopped"\|"idle",restarts,restart_window_start,last_error,last_active_at,last_upgrade_at,post_upgrade_pending?,updated_at}`——`post_upgrade_pending` 是**追加可选字段**（缺省即无标记，旧二进制忽略、不升 schema 版本）：值为「禁用态升级到的版本」，表示该版本的 `post_upgrade` 尚未执行，下一次 `Enable` 成功后补跑一次并清空；首次安装/同版本重装不写 | 卸载即删 |
| `tasks` | ULID 26 字符（时间序） | `{id,plugin_id,method,trigger:"event"\|"schedule"\|"invoke",status:"queued"\|"running"\|"ok"\|"failed"\|"timeout",started_at,finished_at,dur_ms,error_code,req_id}` | 预留 bucket：**当前无写入方**，因此不定义保留窗口（原「30 天」承诺随写入方落地时再定义，见 §11） |
| `sessions` | `sha256(token)` 的 64 位小写 hex（token = 登录时生成的 32 字节随机 base64url，仅返回浏览器一次）；另有保留键 `password-fingerprint`（值为 `sha256(admin_password_hash)` 的 hex） | 非 JSON：`"<expiryUnixNano> <createdUnixNano>"`（空格分隔的十进制纳秒；旧格式只有单个 expiry，读取时按当前 TTL 反推 created）。`expires_at` = 签发/续期时 `now + session_ttl`，且不超过 `created + 30d`；仅当剩余寿命 < `min(24h, ttl/2)` 才在鉴权时写回并重发 cookie | 读时判定过期（`Validate` 拒绝）；删除发生在登出 / 吊销 / 改口令，无后台清理任务 |
| `audit` | `%020d-%06d`（unix 纳秒, 序号），字典序 = 时间序 | `{subject,action,plugin,target,result:"ok"\|"denied"\|"error",detail{}}` | 保留 `audit.retention`（默认 90 天）；由 scheduler 内置任务 `builtin-audit-clean` 按龄删除（周期 `audit.clean_interval`、单次 ≤`audit.clean_batch`，见 §11） |
| `scheduler_tasks` | 任务 id（`tsk-<16 hex>`；内置任务 `builtin-cert-renew` / `builtin-audit-clean`） | `{id,name,plugin,method,params,schedule,interval_s,enabled,timeout_s,next_run_at,last_run_at,last_result,missed_count,created_at}`（`schedule` 为 5 段 cron 表达式）（ADR-0019；`params` 是插件方法参数原始 JSON，属 G-24 受控例外） | 删除任务即删；`builtin-cert-renew` 随 `cert_renew.enabled` 启停，`builtin-audit-clean` 随 `audit.clean_enabled` 启停 |
| `scheduler_runs` | `%020d-<task-id>-%06d`（unix 纳秒 + 序号），字典序 = 时间序 | `{task_id,started_at,finished_at,status:"ok"\|"failed"\|"timeout"\|"skipped"\|"missed",error,dur_ms}` | 保留最近 100 条（写入时裁剪） |
| `alerts`（嵌套子桶 `events`） | `%020d-%06d`（unix 纳秒 + 序号，与 `audit` 同编码），字典序 = 时间序；键即对外 `id` | `{id,ts,severity:"critical"\|"warning"\|"info",source:"audit"\|"plugin"\|"resource"\|"slot",title,detail,seen,count}`——`id`/`ts` 由键派生不落库（与 `audit`「时间由键承载」同口径）；`count` 为同 `title+source` 5 分钟窗口内的合并次数（合并即删旧键按当前时刻重写，`seen` 归 false——新发生重新计未读）；校验方 `store.PutAlert`：severity/source 取值受控、title 1..200 字符、detail ≤512 字符（按 rune 计），非法拒绝写入不落库 | 保留最近 500 条（写入时裁剪）；同 `title+source` 5 分钟内去重合并 `count+1` |

**`granted_capabilities`（授予记录，`plugins` bucket 的内嵌对象）**：字段 `granted_by` / `granted_at` / `version` / `declaration_sha256` / `capabilities[]` / `added_capabilities[]`，回答「谁授的、什么时候、授了哪些」。写入时机：① 安装——按 `info.json` 声明自动授予（`granted_by=install:auto`）；② 升级——声明新增能力时自动扩展并记 `upgrade:auto` + `added_capabilities[]`（WARN + 审计 `capability.grant_extended`，**不阻断升级/启用**）；③ 启用——补齐缺失记录或确认新增项（`enable:<subject>`，审计 `capability.grant_confirmed`）。存量库无该字段的插件在启动时按已装声明回填（`legacy:backfill`）。**默认放行**：记录缺失或声明未变时按声明授予，24 个插件仓无需同窗口改动；收紧只通过显式声明完成，语义见 [SECURITY](./SECURITY.md) §5.1。

**`triggers`（`info.json` 与 `plugins` bucket 同名字段）**：**`[]string`**，每项格式 **`<type>:<name>`**（**前缀即类型**；不是对象数组，也不是无前缀裸名）：

```json
"triggers": ["event:cert.renew_due", "schedule:daily@03:00", "invoke:echo.reload", "invoke:reload"]
```

| `type` 前缀 | 语义 | `name` 约束 |
| --- | --- | --- |
| `event:` | 订阅 kore 事件（`kore.event.type`） | `^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$`（如 `cert.renew_due`） |
| `invoke:` | 外部调用触发（HTTP / CLI），指向方法名 | `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$`（**单段或多段均可**：`invoke:reload` 与 `invoke:echo.reload` 都合法） |
| `schedule:` | 宿主调度器（**M2 生效**） | M1 仅校验非空且不含 `:` 之外的控制字符，不解析调度表达式 |

**两处正则差异的原因**：`event:` 必须两段——事件名天然是 `<域>.<事件>`（如 `cert.renew_due`），单段无法区分域；`invoke:` 指向插件方法名，单段（`invoke:reload`）与多段（`invoke:echo.reload`）都自然，故放宽为「单段或多段」。

**空数组合法**（= 不订阅任何触发）。任一项非法——缺 `:` 前缀、前缀不在 `event`/`schedule`/`invoke` 内、`name` 不匹配上表规则、项非字符串——→ 安装失败 `E_INVALID`（registry 校验，见 [CORE.md](./CORE.md) §2.5）。`triggers` 只决定插件被哪些外部源唤醒，**不改变 `lifecycle`**（生命周期是安装形态，触发是唤醒来源）。

lazy 插件的 `actual:"idle"` 与 `last_active_at` 必须落盘：主壳重启后按 `last_active_at` 恢复「最久未用先降级」的配额判定，不允许重启后把全部 lazy 一次性拉起。

sessions 只存 token 的 SHA-256 与时间戳（另有口令指纹键，见 §5）：DB 文件泄露时攻击者拿到的是哈希，不能直接复用会话；token 明文只出现在登录响应里，服务端不落盘。

索引仓库 `index/plugins.json` 的 schema 由 `kore-plugins` 仓库的 `index/schema.json` 定义，kore 只读 `id/version/requires_kore/sha256` 四个字段，不复制其字段表；本文件的 `requires_kore` 语义与之保持一致。

索引条目的 `capabilities` 字段是**信息性字段**：内核 `market.Plugin` 不消费它，`GET /store/plugins` 回包里也不含该字段；插件真实能力一律以包内 `info.json` 的 `capabilities` 为准（安装期由 registry 校验，运行期由 supervisor 握手核对）。

示例（`tasks`）：

```json
{"id":"01JC8Q3A7B8C9D0E1F2G3H4J5K","plugin_id":"backup","method":"backup.run","trigger":"http","status":"ok","started_at":"2026-11-21T20:40:15.123+08:00","finished_at":"2026-11-21T20:41:02.456+08:00","dur_ms":47333,"error_code":"","req_id":"r-01JC8Q3A"}
```

UI 与 API 不直接暴露 bbolt：`GET /plugins`、`GET /system/info` 由内核读 bucket 后组装响应；排障读 bucket 只能离线：停 `kored` 后 `bbolt keys state.db tasks` / `bbolt get state.db tasks <key>` 查看（bbolt 写锁由运行中的 `kored` 持有，读写/只读打开都无法并存，必须停服）；`kored db dump` 子命令**未实现**。

## 6. 事务与并发规则

1. **单写者**：写操作走 bbolt 的 `db.Update` 单事务，由 `Store.Update` 透传；单写者与进程间互斥由 bbolt 内置文件锁（`LOCK_EX|LOCK_NB` + `Timeout`，`bolt.Open` 设 `Timeout=1s`）保证，**无应用层 writer goroutine、无 `chan writeOp` 队列**，任何调用方都可经 `Store.Update` 发起写事务。本口径于 M3 收口按实现校正；旧 `chan writeOp` 口径为 M1 早期设计、未实现，不作为约束。
2. **读用 View**：读路径一律 `db.View`，只读事务内不调用任何会写库的函数。
3. **小写入走 `Update`，禁用 `Batch`**：审计与任务状态的小写入在事件/请求路径上走 `db.Update` 同步提交（写时落盘，M3-C）；**不使用 `db.Batch`**——bbolt Batch 内部会起 `time.AfterFunc` 定时器与 goroutine（bbolt `db.go:953/958`），与 G-19 及「audit 写入不起 goroutine/ticker」的硬约束冲突，原「≤200 条 / 100ms 合批 flush」口径作废（恢复须先解掉该约束并留 ADR）。
4. **长事务禁 IPC**：`Update`/`View` 事务内禁止 IPC、HTTP、文件 IO、等待插件响应；事务内只做内存计算与 tx 读写字。单个写事务耗时 > 200ms 记 WARN 并附 op 名。
5. **锁顺序**：registry 内存锁 → bbolt 事务；不允许反向嵌套（bbolt 回调里再取 registry 锁）。
6. **崩溃一致性**：`NoSync:false` 保留 fsync 语义；bbolt 单文件事务原子，无需 WAL 之外的补偿。

## 7. 版本与迁移

- `meta.schema_version` 为整数，M0 = `1`；每次结构变更 +1。
- 迁移函数注册为有序列表 `migrations[]`，只允许**新增**（1→2、2→3），不允许修改已发布迁移；启动时若 `current < target` 按序执行，每步前后写日志。
- 迁移前自动备份：`Tx.CopyFile` 到 `state.db.bak-<ts>`，保留最近 3 份。
- 降级不支持：发现 `current > target`（用旧内核启动新库）→ 拒绝启动，**退出码 4**，提示「数据库 schema 高于当前内核，请升级内核或恢复备份」。
- 迁移失败：回滚到备份文件（改名替换），**退出码 4**，不半迁移启动。

启动失败码表（固定，运维脚本按此判定）：

| 退出码 | 含义 | 典型原因 |
| --- | --- | --- |
| 2 | 配置错误 | YAML 类型错误、必填缺失、取值越界、参数非法 |
| 3 | 状态目录或锁 | 目录不可写、`/run/kore/kore.lock` 被占用 |
| 4 | 存储或 schema | bbolt 打不开/损坏、schema 高于内核、迁移失败 |
| 5 | 监听绑定 | UDS 路径或 `server.addr` 端口被占用、无权限 bind |
| 6 | 环境不满足 | 架构不符（非 linux/amd64/arm64）、Linux 内核 < 4.18、状态目录位于 NFS/SMB（`flock` 不可靠）、Windows < 10 1809；cgroup 缺失/受限**不在此列**，只降级监控 |

## 8. 日志

格式：单行文本，固定前缀 + key=value，便于 grep 与 awk：

```text
2026-11-21T20:40:15.123+08:00 INFO  core/httpapi  req_id=r-01JC8Q3A msg="plugin.enable" plugin=site result=ok dur_ms=12
```

| 位置 | 值 |
| --- | --- |
| 时间 | RFC 3339 带毫秒与本地时区 |
| 级别 | `DEBUG` / `INFO` / `WARN` / `ERROR`，固定 5 字符宽 |
| 组件 | `core/<pkg>` 或 `plugin:<id>`，固定 14 字符宽 |
| req_id | 每次 HTTP/CLI 请求生成，贯穿调用链；无请求时为 `-` |
| msg | 双引号包裹的事件名或短描述，禁止换行 |
| 字段 | `k=v`，值含空格时加双引号；禁止记录密码、session id、hash 原文 |

级别：`debug` 仅本地排障；`info` 记录生命周期与变更；`warn` 记录降级、重试、超预算；`error` 记录内核自身失败（写库失败、插件崩溃）。插件日志统一经事件 `plugin.log` 写入 `/var/log/kore/plugins/<id>.log`，行首组件固定 `plugin:<id>`。级别过滤在写入侧完成，`debug` 关闭时不产生字符串格式化开销。

轮转：自实现，不引第三方库、不起后台 goroutine——每次写入前检查 `size + len(line) > max_size_mb × 1048576`，满足则同步重命名链 `kore.log → kore.log.1 → ... → kore.log.4`，删除第 6 份（`max_backups=5` 指保留 5 个文件，总上限 50 MiB）。插件日志同一实现，默认 `10 MiB × 2`（每插件上限 20 MiB）。轮转在持锁的写路径内完成，单次重命名 < 1ms。

## 9. 审计日志

审计是 bbolt `audit` bucket，独立于运行日志，记录不可由普通操作删除。**M3-C 起写入事件化**：`plugin.enable` / `plugin.disable` / `plugin.crash` / `plugin.retry` 四类 supervisor 生命周期事件与 `root.action` 提权事件在**发生时直接写入**（经装配层注入的 `Auditor` 单方法接口 → `store.PutAudit`），不依赖下一次请求对账。字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `subject` | string | `admin`（管理动作，如 enable / disable）、`system`（自动事件，如 crash / restart、证书续期）或调用方 subject（`capability.denied`） |
| `action` | string | `login.success` `login.failed` `plugin.install` `plugin.enable` `plugin.disable` `plugin.upgrade` `plugin.uninstall` `plugin.uninstall_purge` `plugin.crash` `plugin.retry` `root.action` `capability.denied` `invoke.<plugin>.<method>` `invoke.burst` `config.reload` `upgrade.start` `upgrade.result` `backup`（`plugin.retry` = 失败后重新拉起，即提案四事件中的 restart；薄壳门禁禁止 `restart` 整词进可执行代码，取语义等价词并留痕） |
| `plugin` | string | 涉及插件时填写，否则空 |
| `target` | string | 动作目标（如 `invoke` 时的 `<plugin>.<verb>`、状态值），否则空 |
| `result` | string | `ok` / `denied`（权限/限流拒绝）/ `error` |
| `detail` | `map[string]string`（**受控例外**：仅允许标量字符串值，禁止嵌套） | 附加信息（如 `{"from":"failed","restarts":"2"}`），≤ 1 KiB；**校验方：`store.PutAudit`**（写入前校验键 ≤32 字符、值 ≤256 字符、键数 ≤16、序列化 ≤1 KiB，长度按字符计；非法即记 WARN 并拒绝写入，不落库） |

时间与顺序由**键**承载（`%020d-%06d`：unix 纳秒 + 同纳秒序号，时钟回拨沿用末键纳秒继续编序，保证字典序严格递增 = 时间序），故不设独立 `at` 字段；`req_id`（请求关联）不在当前写入面——四类事件没有请求上下文，HTTP 侧审计（`login` / `invoke` 等）接入时再追加该字段（向后兼容：旧记录缺字段读为空）。查询遇单条损坏记录只 WARN 跳过，不中断整个查询。

**HTTP 侧审计（登录 / 方法调用）**：`login.success`（result=ok，detail=`{ip,user_agent,session_id_prefix}`）与 `login.failed`（result=denied，detail=`{ip,user_agent,reason}`，reason ∈ `wrong_password` / `rate_limited` / `no_session`）在登录处理器内成功与失败各写一条；IP 只保留前 3 段（`192.168.1.x`）、UA 截断 100 字符、会话只留前 8 字符前缀，**任何形式的口令都不进审计**。invoke 审计口径与授权口径一致——按**最终生效能力**判定：先查方法级 `method_capabilities[<id>.<method>]`，未命中回退插件级 `capabilities`；只有 `write`/`admin` 类方法才落 `invoke.<plugin>.<method>`，只读类（方法级或插件级解析为 `*:read`）默认不审计；`audit.invoke_all=true` 时全量审计（调试用）。方法级能力使同一插件内「只读方法不审计、写方法审计」成为可能，内核仍只比较能力字符串、不维护业务方法表（G-01）。同一方法 1 秒内调用超过 10 次时，前 10 次逐条、第 11 次起合并为一条 `invoke.burst`（detail=`{method,count,window_ms}`）并抑制本窗口后续记录，避免刷爆审计库。

查询：`GET /api/v1/audit?since=<RFC3339>&limit=50&action=<动作>&order=desc`（`since` 必填、`limit` ≤1000、`order` 默认 `asc`）；HTTP 响应的 `at` 由键的纳秒段派生（RFC3339Nano，仅响应字段、不落库、不改存储结构），供前端展示时间与「最新优先」。CLI 用 `kored audit --since 2026-11-24T00:00:00+08:00 [--action <动作>] [--limit N] [--csv]` 读 bbolt 输出（**`--since` 必须是 RFC3339 时间戳**，`--since 24h` 这类相对写法会被拒并返回退出码 2）；前端列表见 `web/audit.js`。**保留策略**：`audit.retention`（默认 90 天）内的记录保留，超期记录由 scheduler 内置任务 `builtin-audit-clean` 按龄删除（周期 `audit.clean_interval` 默认 6h、单次上限 `audit.clean_batch` 默认 1000；`audit.clean_enabled=false` 可关，见 §11）。清理本身写一条 `audit.clean` 审计。

## 10. 备份与恢复

> **当前未实现**：`kored backup` / `kored restore` / `kored db dump` **都没有对应子命令**（唯一权威清单是 `kored help`）；下面是**停机手工流程**，可直接照敲，M2 由 backup 能力接管。离线核对需要 bbolt CLI，它不随 `kored` 分发，按 `go.mod` 的版本自行安装：`go install go.etcd.io/bbolt/cmd/bbolt@v1.3.11`。

备份内容（离线停机备份，一次一组）：

1. `state.db`：停服后 `cp -a`——bbolt 独占文件锁，运行中直接拷可能拿到撕裂文件；在线一致快照（`Tx.CopyFile`）当前**只有 bbolt API、无 CLI 入口**。
2. `config.yaml`：原样复制（含 0600 权限）。
3. 插件包：`/var/lib/kore/plugins/` 打包为 `plugins.tar.gz`。
4. 校验清单：`created_at` / `kore_version` / `schema_version` / 每文件 `sha256` 与 `size`——当前无自动生成器，用 `sha256sum` 清单替代。

```bash
# 停机备份（路径以 `kored status` 打印的 state_dir 为准）
systemctl stop kore.service
ts=$(date +%Y%m%dT%H%M%S); out="/var/backups/kore/$ts"; mkdir -p "$out"
cp -a /var/lib/kore/state.db "$out/state.db"
cp -a /etc/kore/config.yaml "$out/config.yaml"
tar -czf "$out/plugins.tar.gz" -C /var/lib/kore plugins
( cd "$out" && sha256sum state.db config.yaml plugins.tar.gz > SHA256SUMS )
systemctl start kore.service
```

恢复流程（停机执行）：

```bash
systemctl stop kore.service
ts=20260101T000000                        # 换成实际备份目录名（第 2 步 $out 的后缀）
cp -a /var/lib/kore/state.db "/var/lib/kore/state.db.pre-restore.$(date +%Y%m%dT%H%M%S)"   # 恢复前先快照
cd "/var/backups/kore/$ts" && sha256sum -c SHA256SUMS                                     # 失败即中止
bbolt get state.db meta schema_version                                                    # 值形如 {"schema_version":1}
cp -a state.db /var/lib/kore/state.db
cp -a config.yaml /etc/kore/config.yaml
tar -xzf plugins.tar.gz -C /var/lib/kore
systemctl start kore.service
curl -fsS http://127.0.0.1:8787/-/healthz    # 期望 {"status":"ok"}
```

校验：恢复前逐文件比对 sha256；恢复后启动日志 `状态库已打开 ... schema_version=<n>` 必须 ≤ 当前内核声明，高于即拒绝启动（退出码 4，见 §7），此时回滚到恢复前的快照；任一失败回滚。RPO 目标 24 小时（需运维按上述流程每日执行 + 升级前执行），RTO 目标 10 分钟（单机、单文件、无外部依赖）。

## 11. 生命周期清理

**实现方式（ADR-0044）**：审计按龄清理由 scheduler 的内置任务 `builtin-audit-clean`（`plugin=kore`、`method=audit.clean`）执行，**复用既有单 ticker**（`internal/core/scheduler/`，30s 检查、到点执行），不新增 ticker / goroutine / 周期循环（G-19）。任务参数随任务落库：`params={"retention_seconds":…,"batch":…}`，来源 `audit.retention` / `audit.clean_batch`，周期来源 `audit.clean_interval`（默认 6h）；参数未变时重启不推迟 `next_run_at`（否则频繁重启的机器永远等不到第一次清理）。

**取舍如实记录**：原设计意图是「启动时 + 写路径惰性触发、零后台定时器」。改为 scheduler 内置任务后，默认配置（`audit.clean_enabled: true`）下调度器会常驻一个 ticker——这是为解决审计无界增长刻意接受的代价，仍在 ADR-0019 的单 ticker 白名单内；要严格零 ticker 可设 `audit.clean_enabled: false`（代价是审计重新无界增长）。

**单次上限与失败隔离**：单次最多删 `audit.clean_batch` 条（默认 1000，硬顶 10000）；未删完时结果 `more=true`，下个周期继续，避免一次长事务。删除只走 `Store.CleanAudit` 的单个写事务（游标升序，遇到第一条未过期记录即停）；键无法解析出年龄的坏键**不删**（不猜）。清理失败（参数非法 / 事务失败）只落一条 `failed` 的 `scheduler_runs` 记录 + WARN 日志，不阻塞调度、不影响其他任务；读取路径（`GET /api/v1/audit`、`kored audit`）不受影响。

**可观测**：每次清理写一条审计 `action=audit.clean`（`subject=system`、`target=audit`、`result=ok|error`，detail=`{deleted,more,batch,retention_seconds[,error]}`）+ 一条 INFO 日志（deleted / more / retention_seconds / batch / cutoff）。审计写入失败只 WARN，不反向破坏清理。

**bbolt 文件膨胀（明确结论）**：删键**不会缩小** `state.db`。bbolt 把删除的页放回 freelist 供后续写入复用，因此稳态下文件大小会**停在高水位**而不是随清理下降；突发写入把文件撑大后，即使审计被裁到 90 天，文件也不会自动退回小尺寸。本项目**不做在线 compaction**：bbolt 压缩要求独占文件（关闭当前句柄 → 换文件 → 重开），在运行中的守护进程里做会引入「压缩窗口内写入丢失 / 句柄换错」风险，收益不抵风险。要真缩文件走离线运维：停 `kored` → `bbolt compact -o state.db.new state.db` → `bbolt check` 校验 → 原子替换 → 启动。当前**没有** `kored db compact` 子命令（`kored db` 系列尚未实现，勿按旧文照敲）。结论：清理的作用是**把增长封顶**，不是「让文件变小」；容量按高水位 + 90 天审计量估算。

| 数据 | 规则 | 触发点 |
| --- | --- | --- |
| `tasks` | 预留 bucket，无写入方 → **不定义保留窗口**（不承诺天数） | 无（写入方落地时再定义规则） |
| `sessions` | 过期不主动删除，仅读时判定失效（`expires_at < now` 或越过 `created+30d` 均拒绝）；删除只发生在登出 / 吊销 / 改口令 | 读时（无启动清扫、无惰性清理） |
| `audit` | 保留 `audit.retention`（默认 90 天）：删除键中时间戳早于 `now - retention` 的记录，单次 ≤ `audit.clean_batch`（默认 1000） | scheduler 内置任务 `builtin-audit-clean`（每 `audit.clean_interval`，默认 6h；`audit.clean_enabled=false` 时禁用） |
| 旧插件版本 | 保留当前 + 上一版本 | 升级成功后同步清理 |
| 插件日志 | 轮转 10 MiB × 2 | 写入路径 |
| bbolt 空闲页 | 删键只释放页、不缩文件，稳态停在高水位；不做在线 compaction，缩文件需停服用 bbolt CLI 离线压缩（见上） | 手动 |

卸载语义：卸载插件默认**保留** `/var/lib/kore/plugins/<id>/` 下的数据目录；只有 `--purge` 才删除，且必须二次确认（HTTP 带 `?confirm=<id>`、CLI 交互输入 id）并写审计 `plugin.uninstall_purge`；删除后不可恢复，备份不自动包含该目录。

## 12. 为什么不用 SQLite / Postgres

| 维度 | bbolt（选用） | SQLite | Postgres |
| --- | --- | --- | --- |
| 启动开销 | 单文件 mmap，无进程、无连接池，空载 RSS 增量 < 1 MiB | 需 cgo（或纯 Go 分支），连接与 page cache 数百 KiB 起 | 独立服务进程，常驻数十 MB，连接池额外开销 |
| 依赖 | 单 Go 库，纯 Go，无 CGO | 默认 cgo，交叉编译与静态构建成本高 | 需安装服务、初始化、账号、端口 |
| 并发模型 | 单写多读，事务串行；kore 的写频率 < 100 次/秒，足够 | 单写多读，WAL 模式可用 | MVCC 多写，能力过剩 |
| 运维 | 复制文件即备份 | 需 `.backup`/WAL checkpoint 注意点 | 需备份工具、vacuum、版本升级 |
| 适用 | 键值 + 少量前缀扫描 | 需要 SQL 查询与关系约束 | 多客户端、远程访问 |
| kore 的取舍 | 写少读多、单机、单进程，bbolt 刚好 | 引入 SQL 与 cgo，收益为零 | 违反「不引常驻中间件」红线 |

结论：数据规模（插件数 < 100、任务 < 10 万、审计 < 100 万）与并发（单写者）都在 bbolt 舒适区；需要 SQL 的场景属于插件自己的数据，由插件自管，不进内核库。
