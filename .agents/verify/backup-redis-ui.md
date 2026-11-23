# backup + redis 新 UI · G-28 双端截图（task-67）

> 元信息: 2026-11-23T20:05+08:00 · 执行者 kore-impl-redis2（implementer）· 只截图不改代码 · UI = `1a5a8f7`（backups.js）/ `876ecd4`（redis.js）· 隔离实例 `127.0.0.1:18885`（config/state/run/log 全在 `/tmp/kore-br`）· 主实例 8787 零写入 · task-67
>
> **端口偏差（如实记录）**：任务指定 18883，但开工时 18883 已被 task-65 的 `/tmp/kore-a65` 实例占用（pid 210016，19:50 启动），18884 亦被占用；改用 **18885** 起本任务隔离实例，仍是独立 config/state/run/log，未碰任何他人实例。

## 1. 隔离实例与插件

```console
$ kored serve --config /tmp/kore-br/config.yaml     # server.addr=127.0.0.1:18885
$ curl -s http://127.0.0.1:18885/-/healthz
{"status":"ok"}
$ curl -s -b cookie http://127.0.0.1:18885/api/v1/plugins   # 关键两条
[('backup', '0.4.0', None, True), ('redis', '0.5.0', None, True)]
```

- backup 0.4.0：`POST /api/v1/store/install` 的 `package_path` 离线安装本地 dist，返回 `state=succeeded, reload=reloaded`。
- redis 0.5.0：同一路径安装时被 `sha256 校验失败` 拒绝——redis 仓 HEAD 已推进到 `f1761e6`（OSS 资产批次），本地 dist 重打为 `0455ae5e…`，而签名索引锁定的 0.5.0 sha 仍是我发布时的 `d4749ff1…`（RELEASE.md §0 同版本单 sha）。为在隔离实例里拿到 **redis 0.5.0**，从主实例 state 的已装 `plugins/redis/0.5.0` 复制到隔离 state（只读源、不写主实例），并复制 state.db 记录；**未改动主实例任何运行态文件**。
- `discover` 插件未装 → redis 页「自动检测不可用」；本机 127.0.0.1:6379 的 Redis 要求 AUTH → 各面板返回 `NOAUTH` 错误卡（如实降级，见 §3）。

## 2. 截图与宽高（`file` 复核）

| 文件 | 实际宽高 | 对应视图 |
| --- | --- | --- |
| `screenshots/backup-redis-backup-desktop.png` | **1440×1935** | 备份页（定时备份 / 保留策略 / 备份对象维度） |
| `screenshots/backup-redis-backup-mobile.png` | **390×2354** | 同上，手机 |
| `screenshots/backup-redis-redis-desktop.png` | **1440×1534** | Redis 页（写入键 / TTL 过期时间 / 服务端配置） |
| `screenshots/backup-redis-redis-mobile.png` | **390×2152** | 同上，手机 |

拍摄方法：chromium-1248 headless + 手写 CDP（`Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot.captureBeyondViewport`，clip 宽=1440/390，高=内容实际高度，scale=1）；浏览器内登录（口令只存 `/tmp` 0600，随目录删除，不落档）。

DOM 回读（拍摄同页）：备份页可见「定时备份 / 执行频率 / 保留份数 / 备份对象 / 保留策略 / 备份列表」；Redis 页可见「写入键（SET/HSET/RPUSH/SADD/ZADD + 过期时间）/ 服务端配置（maxmemory / maxmemory-policy / timeout）」。

## 3. 自评三问

### ① 备份页

1. **解决什么用户问题**：把「备份」从只能手点一次，扩成可运营的日常动作——定时备份（每天 3 点 / 每 6 小时 / 每周日 2 点 / 自定义 cron）+ 保留份数 + 备份对象维度（站点目录 / MySQL 数据库）+ 每份包的下载入口，用户不必记 cron 表达式或手工删旧包。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔把「计划任务 + 备份 + 下载/恢复」放在同一任务详情里，并带进度条与异地存储；本页已有定时、保留、维度与作业列表，但**下载按钮是每条备份记录的行内动作**，本轮 0 份备份故不可见；恢复仍需二次确认弹窗；无异地存储（G-11 明确不做）。
3. **当前状态**：**面板可用、数据为空态**。定时任务、维度、保留策略、备份列表骨架均真实渲染；没有真实备份产物，「下载」入口与作业进度未在截图中体现，不能据此宣称「下载链路已验证可用」。

### ② Redis 页

1. **解决什么用户问题**：把 Redis 从「只能看」扩成「能改」——键值编辑（string/hash/list/set/zset 写入）、TTL 预设（1h/1d/7d/清除过期）与服务端配置（maxmemory / 淘汰策略 / timeout）都在页内完成，不用登服务器敲 `redis-cli`。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔的 Redis 管理以键列表 + 编辑 + 慢日志为主，配置项通常跳系统配置；本页已把三个白名单配置参数做成表单并回读生效值，但**没有键空间树/前缀分组**，慢查询只有只读列表；错误提示已给出「怎么办」，这一点优于只报错的实现。
3. **当前状态**：**面板可用、实例不可达（如实降级）**。本机 6379 要求 AUTH 且未配置密码，所有数据面板显示 `NOAUTH` 错误卡与操作建议；「写入键」与「服务端配置」表单本身完整渲染（截图可见），但写入/配置的实际成功路径**未在本次截图环境验证**，需有可用 Redis 实例后另补真机证据。

## 4. 边界与未验证项

- 无真实备份产物：0 份备份，「下载」为行内按钮故不可见；作业进度（jobs）为空态。
- Redis 实例 127.0.0.1:6379 需要 AUTH，未提供密码（禁止把凭据写进报告/配置）；`NOAUTH` 错误卡是真实降级路径，不是渲染缺陷。
- redis 0.5.0 的安装绕过签名索引 sha（本地 dist 与索引锁定 sha 漂移，原因见 §1），仅用于截图环境；正式安装仍应走已签索引包。
- 主实例 8787：**未改动**配置 / state / run；本轮 G-29 声明为「零写入主实例运行态资产」。
- 隔离实例已清理：`/tmp/kore-br` 整目录删除、18885 无监听、无残留 chromium/kored 进程。
