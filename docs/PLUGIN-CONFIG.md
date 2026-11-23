> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M0

# 插件配置契约（PLUGIN-CONFIG）

本文件定义插件「界面可配、保存即生效、不用重启」的统一契约。目标是把 `KORE_*` 环境变量 + 重启内核的配置方式，替换为插件自描述的表单；老用户的环境变量继续生效，不因升级失效。易用性依据见 [USABILITY.md](./USABILITY.md) 原则 2/4，协议底座见 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md)。

## 1. 契约：两个可选方法

每个插件**可选**实现两个业务方法（方法名带插件域，经 `/api/v1/invoke/<id>/<id>.config.*` 调用）：

| 方法 | 入参 | 结果 |
| --- | --- | --- |
| `<id>.config.get` | `{}` | `{"schema":{...},"values":{...},"source":"file\|env\|default"}` |
| `<id>.config.set` | `{"values":{...}}` | `{"saved":true,"applied":true,"restart_required":false,"warnings":[]}` |

`source` 表示当前值的来源：`file` = 插件配置文件，`env` = 环境变量，`default` = 代码默认值。只实现其中一个方法不算完成契约；未实现的方法返回 `E_NOTFOUND`，前端隐藏设置入口。

## 2. schema 与字段类型（显式枚举）

`schema` 固定两字段：`title`（中文标题）与 `fields`（字段数组）。禁止 `object` / `any` 作为字段类型（G-24）。

| type | 含义 | 额外约束 |
| --- | --- | --- |
| `string` | 单行文本 | `placeholder?` |
| `int` | 整数 | `min?` / `max?` |
| `bool` | 开关 | 渲染为 checkbox |
| `select` | 枚举 | `options` 必填且非空 |
| `list` | 同类型标量列表 | `item` ∈ `string|int|bool|select`，**不支持嵌套对象** |

每个字段必填：`key` / `label` / `type` / `default` / `required` / `help`；可选：`options`（select）/ `min` / `max`（int）/ `placeholder` / `sensitive` / `item`（list）。`help` 是一行中文说明，前端必须展示；`label` 用用户语言，不出现 `instance` / `revision` 等内部术语。

`list` 只存标量：需要「多字段条目」时不要发明对象元素，改成一个 `string` 列表并约定 `名称=值` 文本格式（见 §7），或拆成多个并列字段。

示例（logs）：

```json
{
  "schema": {
    "title": "日志来源",
    "fields": [{
      "key": "sources", "label": "日志来源", "type": "list", "item": "string",
      "default": [], "required": false,
      "help": "每项一条 <名称>=<绝对路径>；例：syslog=/var/log/syslog、journal=journal",
      "placeholder": "syslog=/var/log/syslog"
    }]
  },
  "values": {"sources": ["syslog=/var/log/syslog"]},
  "source": "file"
}
```

`default` 与 `values` 的字段类型必须与 `type` 一致；`list` 的默认值必须是数组。

## 3. 存储

- 路径：`<state_dir>/plugins/<id>/config.json`。插件进程拿到的 `KORE_STATE_DIR` 就是 `<state_dir>/plugins/<id>`，因此实现为 `<KORE_STATE_DIR>/config.json`。
- 权限：文件 `0600`，目录沿用插件状态目录 `0700`；配置文件不随插件包升级删除。
- 启动时加载；`config.set` 的顺序固定为 **校验 → 原子写 → 更新内存 → 返回 applied**，任一步失败都不改内存、不写半份文件。
- 原子写：同目录临时文件 → `fsync` → `rename` → 收尾 `fsync` 目录；禁止直接截断目标文件。
- 文件损坏或校验失败时插件启动失败并写 stderr 明因，不静默回退到默认值。

## 4. 优先级

`config.json` > 环境变量 > 代码默认值。目的：老用户已导出的 `KORE_LOGS_SOURCES` / `KORE_BACKUP_*` 继续生效；一旦在界面保存，就以文件为准，避免「环境变量与界面打架」。`config.set` 成功后 `config.get` 的 `source` 必须是 `file`。

## 5. 热生效 vs 需重启

- **能热更的必须 `restart_required=false`**：列表、白名单、目录、阈值这类在每次方法调用时读取的配置，保存后下一次调用立即使用，不重启 kored、不重启插件进程。
- **确实需要重建连接/资源的**（如更换数据库地址、重载 TLS 监听）返回 `restart_required=true`，`applied=false`，并在 `warnings` 里写清原因；前端必须显示醒目提示「需重启 kored 生效」。
- 不允许为了省事把可热更项标成需重启；也不允许把需要重连的项谎报为已生效。

## 6. 敏感字段

- 密码 / Token / 私钥类字段标 `"sensitive": true`。
- `config.get` **不回传原值**：有值时返回 `"***"`，无值时返回空串。
- `config.set` 收到 `"***"` 表示「不修改」，保留已存值；只有收到新明文才覆盖。
- 前端用 `type=password` 渲染，不回显、不写日志、不进审计 detail。

### 6.1 跨插件凭据传递（设计债，v1.0 前必须做）

**问题（2026-11-23 实测）**：插件探测外部服务需要凭据，凭据却存在**另一个插件**的 `config.json` 里，两者互不可见：

- `discover` 要探测 MySQL 服务端版本（`SELECT VERSION()`）与 Redis 服务端版本（`INFO server`），需要 `MYSQL_PWD` / `REDISCLI_AUTH`；
- 这两个密码由 `db-mysql` / `redis` 插件的配置面板写入 `<state_dir>/plugins/{db-mysql,redis}/config.json`（0600、`sensitive`），插件之间不共享配置；
- 内核没有凭据总线：插件进程环境 = kored 进程环境（`internal/core/supervisor/start.go` 继承 `os.Environ`），所以 `discover` 拿不到密码，探测只能降级为 `version_source=client`（客户端 `mysql --version`）或 `unknown`；
- 当前 workaround 是运维在启动 kored 前手工 `export MYSQL_PWD=...` / `export REDISCLI_AUTH=...`——重启即失效、不可审计、不可复制，**不是产品能力**。

**候选方案**：

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A（推荐）** | kored 启动/重启插件时，读该插件 `config.json` 的 `password` 与 `password_env`，把 `password` 机械映射到 `password_env` 指定的环境变量名并注入子进程 | 凭据仍只存插件自己的 0600 文件；插件代码零改动（继续读环境变量）；内核只做「字段 → 环境变量名」的机械映射，不认识业务语义，不违反 G-01 | kored 需要按插件的 `password_env` 声明做注入；改密码后需重启该插件进程才生效（可接受，`restart_required=true` 语义已存在） |
| B | `discover` 直接读 `<state_dir>/plugins/*/config.json` | 不依赖内核改动 | 插件间直接耦合：任何插件都能读别人的密码文件，权限边界消失；0600 对同用户多进程等于共享 |
| C | `discover` 自己的配置面板加「探测凭据」字段 | 实现最简单、职责自洽 | 同一密码存三份（`db-mysql` / `redis` / `discover`），改密必然漂移；用户要重复填写，违反「自动发现、不让人填环境细节」 |

**推荐 A 的边界**：内核只做 `config.password` → `env[password_env]` 的机械映射（`password_env` 缺失则不注入），不维护「MySQL / Redis」名词表、不做凭据轮换、不落日志；`config.get` 仍只回 `"***"`。这样 `discover` 与 `db-mysql` / `redis` 继续只认环境变量，插件契约零改动。

**过期条件**：A 落地并验证（配置面板改密码 → 重启插件 → `discover.services` 的 `version_source=server` 且版本等于服务端实际版本）后，本节降级为历史说明并删除 workaround 描述；在此之前它是**运维手工 workaround**，v1.0 前必须由 A 替代。

## 7. 试点

### 7.1 `kore-plugin-logs`

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `sources` | `list(item=string)` | `[]` | 每项 `<名称>=<绝对路径>` 或 `<名称>=journal`；例：`syslog=/var/log/syslog`、`journal=journal` |

保存后 `logs.sources` / `tail` / `search` / `stats` 下一次调用即用新来源，`restart_required=false`。`KORE_LOGS_SOURCES`（JSON 数组）继续兼容，优先级低于 `config.json`。

### 7.2 `kore-plugin-backup`

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `dir` | `string` | `<state>/backups` | 备份包与 sidecar 落盘目录，必须是绝对路径 |
| `allow_roots` | `list(item=string)` | `["/var/www","/etc/kore"]` | 备份源路径白名单根，每项绝对路径 |

保存后 `backup.create/list/verify/restore/delete/retention/stats` 下一次调用即用新目录与白名单，`restart_required=false`。`KORE_BACKUP_DIR` / `KORE_BACKUP_ALLOW_ROOTS` 继续兼容。

### 7.3 `kore-plugin-db-mysql`

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | `string` | `127.0.0.1` | 默认实例地址 |
| `port` | `int` | `3306` | 默认实例端口 |
| `user` | `string` | `root` | 默认实例用户名 |
| `password` | `string`（`sensitive`） | `""` | 密码，只存本机 0600 文件；`config.get` 只回 `"***"` |
| `password_env` | `string` | `KORE_MYSQL_PASSWORD` | 密码环境变量名；`password` 优先，旧用户继续生效 |
| `databases_include_system` | `bool` | `false` | 库列表默认是否包含系统库 |

配置文件只描述实例名 `default`；`KORE_MYSQL_INSTANCES` / `KORE_MYSQL_CONFIG` 的多实例路径继续保留，二者同时存在时 default 由文件配置覆盖。保存后 `db-mysql.instances/databases/query/status` 下一次调用即用新地址，`restart_required=false`。

### 7.4 `kore-plugin-redis`

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | `string` | `127.0.0.1` | 主实例地址 |
| `port` | `int` | `6379` | 主实例端口 |
| `password` | `string`（`sensitive`） | `""` | 主实例密码，只存本机 0600 文件；`config.get` 只回 `"***"` |
| `password_env` | `string` | `""` | 主实例密码环境变量名；`password` 优先 |
| `instances` | `list(string)` | `[]` | 附加实例，每项 `<名称>=<主机>:<端口>` |
| `password_envs` | `list(string)` | `[]` | 附加实例密码环境变量，每项 `<名称>=<环境变量名>` |

保存后 `redis.instances/info/keys/get/delete` 下一次调用即用新地址，`restart_required=false`；`KORE_REDIS_HOST/PORT/PASSWORD_ENV` 继续兼容。

## 8. 校验与错误

- 必填缺失、类型不符、路径非绝对、列表含空项、枚举越界：返回 `E_INVALID`，`message` 写「哪一项错 + 怎么改」，不写堆栈。
- `config.set` 先做全量校验再落盘；不允许「部分字段写成功」。
- 前端失败时原样展示后端 `message`，不得改写成「保存失败请重试」这类无信息文案。
- 配置读写不得引入联网、遥测或后台轮询（G-10 / G-19）。

## 9. 前端契约

通用面板 `web/config-panel.js` 暴露 `window.KoreConfig.open(container, pluginId, opts)`：按 schema 渲染表单，保存时调 `<id>.config.set`；每个字段展示 `label` + 一行 `help`，敏感字段用 password 输入；保存成功显示「已保存，立即生效」，`restart_required=true` 时显示「需重启 kored 生效」；提供「恢复默认值」按钮（只回填表单，保存后才落盘）。插件页面只负责挂一个「设置」入口，不各自重复实现表单。

## 10. 验收

- `config.get` 在三种来源下 `source` 正确；`config.set` 后同一进程内下一次业务调用即生效（对照插件 PID 不变）。
- `config.json` 权限 `0600`；写失败不产生半份文件；非法值返回 `E_INVALID` 且旧配置仍可用。
- 敏感字段 `config.get` 不回传明文；`config.set` 提交 `"***"` 不覆盖已存值。
- 双端（1440×900 / 390×844）截图证明：设置面板可增删列表项、保存提示与生效结果可见。
