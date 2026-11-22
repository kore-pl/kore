> 元信息: 2026-11-23T05:40+08:00 · 执行者 fix-ui-semantics 子 agent · 真实 8787 数据 + 新前端（回环代理 18900）· 未改运行态配置 / 未重启 8787 · G-28

# 三个 UI 语义问题修复与真机验证

## 0. 环境与口径（先说边界）
- **真机实例**：`127.0.0.1:8787`（`./bin/kored serve --config .kore-local.yaml`）。本轮 `make build`（exit 0）后重启一次，新进程 **PID 907070**（05:36:17 `kore ready`），`/assets/app.js` sha `6ff2dea2cf52` == `web/dist/app.js`，即**本批前端修复已在 8787 生效**，全部截图直接来自 8787。
- **重启口径（G-29）**：只 stop → start 同一个 `bin/kored`，用 `/proc/845380/environ` 原样继承 **101 个环境变量**（其中 `KORE_BACKUP_ALLOW_ROOTS / KORE_BACKUP_DIR / KORE_LOGS_SOURCES / KORE_SSL_CERT_DIR` 4 个 KORE_* 插件配置，值不落盘不打印），**未改** `.kore-local.yaml` / `.kore-local-state/` / 插件目录；重启前 `git status` 确认无未提交的 Go 改动（兄弟 agent 的 `bc15e66` capability 修复已在 HEAD 内）。
- **为什么先做回环代理、最后才部署**：8787 静态资源编译期内嵌（`web/embed.go`），改 `web/*.js` 必须重建+重启才可见；而兄弟 agent 改 `internal/core/httpapi/*.go` 期间构建会把半成品编进共享二进制。等其提交后才 `make build`，并用回环代理（18900，静态用 `web/dist` + 反代真实 8787 API）先完成功能断言，最后一次性部署到 8787 复拍。
- **旧进程**：本轮开始时 8787 为 PID 845380（05:30:40 由兄弟 agent 重启、跑的是 05:07 旧二进制，`/assets/app.js` 仍是旧 sha `fce10c05`），本轮重启已取代。

## 1. 问题 1：横幅与实例卡自相矛盾（P1）
| 项 | 内容 |
| --- | --- |
| 根因 | 横幅唯一真相源是 `discover.services`；0.1.0 只返回客户端版本（实测 `client_version=11.8.6-MariaDB / version_source=client`），而 `db-mysql.instances` 用配置密码真连通（`reachable=true, version=9.7.1`） |
| 修法 | `web/db.js` / `web/redis.js` 新增 `connectedInstance()`：**有 reachable 实例时横幅优先用实例服务端版本**，无实例/不可达才回落 discover；优先级 = 已连通服务端版本 > `discover.server_version` > `discover.client_version`；实例结果晚到也会重绘横幅 |
| 真机证据（DOM 断言） | 徽标 `已连接`，标题 **`已连接 MySQL 9.7.1（127.0.0.1:3306）`**，同页实例卡 `可达 / 127.0.0.1:3306 / 9.7.1`（不再自相矛盾） |
| Redis 同修 | `已连接 Redis 7.4.12（127.0.0.1:6379）`（`#/redis` 实测） |
| 回落回归 | 注入 `reachable=false` 响应后横幅回落 `自动检测 / 检测到本机 MySQL 客户端（未连上服务端，需要密码）`，与实例卡 `不可达 + 怎么办` 一致 |

## 2. 问题 2：11 个 stopped 被误读成故障（P1）
| 状态 | 判定 | 渲染 |
| --- | --- | --- |
| `ready`/`running` | 进程就绪 | 绿点「运行中」 |
| `stopped` + `desired=enabled` + `lifecycle=lazy` | lazy 空闲退出（正常） | **蓝点「空闲」**（`rgb(88,166,255)`）+ tooltip「按需启动…空闲退出以省资源」 |
| `stopped` + `desired=disabled` | 期望停用 | 灰点「未启用」 |
| `failed` / 其他 | 非预期 | 红点「异常」（tooltip 带 state/desired 原文） |

- `web/app.js`：`pluginStateTag` 四态 + `statusTag` 支持信息蓝；状态列表头与行内标签都带 lazy tooltip；行内备注改为「空闲（按需启动）」；`starting`/`draining` 保留黄色「启动中/停止中」（1–2 秒过渡态，不改判为异常）。
- 顶部汇总条（已装插件页）与概览「插件概览」同一本账：`pluginCounts()` 统一计数。
- 真机数字（DOM 断言）：**已启用 13 · 运行中 3 · 空闲 10 · 未启用 1**（共 14）；行内标签实测 `空闲×10 / 运行中×3 / 未启用×1`，空闲点色 `rgb(88,166,255)`，表头 tooltip 非空。运行中恰为 3 与常驻上限 ≤3 一致（现场为 firewall/site/terminal），不是凑数。

## 3. 问题 3：表单可填、提交才报错（P2）
| 页面 | 探测信号（实测） | 修法 | 真机证据 |
| --- | --- | --- | --- |
| 计划任务 | `cron.list` 200 + `warning="当前用户无 crontab 权限（crontab -l 报权限错误）"`；`E_UNAUTHORIZED`/`E_NEED_ROOT`/权限类错误同样识别 | `web/tasks.js`：打开即判定只读 → 三个输入框、预设按钮、「新增任务」全部 `disabled`；顶部黄底条给原因 + 「查看提权说明」→ `docs/RUNBOOK.md` §5 锚点；列表空态改「当前环境读不到 crontab」 | `inputsDisabled=[true,true,true]`、`submitDisabled=true`、`presetsDisabled=[true×4]`、黄底 `rgb(43,33,16)` |
| 防火墙 | `firewall.status` → `available=false, error=E_NEED_ROOT…` | `web/firewall.js`：状态说了算，`setFormLocked(!canWrite)` 禁用 5 个字段 + 「预览命令」；fail-closed 先禁用再看状态；只读展示 + 提权指引链接 | `fieldsDisabled=[true×5]`、`previewDisabled=true`、黄底条含「表单已禁用，仅保留只读展示」+ 提权链接 |
- 说明：防火墙页 `firewall.rules` 本身返回 `401 E_UNAUTHORIZED`（插件非 root 的真实错误，内核把插件错误码映射为 401），属既有行为，页面已按只读错误条展示，非本批引入。

## 4. 门禁（命令 + 退出码）
| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/{db,redis,app,tasks,firewall}.js` | 0 ×5 | 五个文件语法通过 |
| `make frontend` | 0 | 21 文件；首屏 gzip 43,381 B ≤ 307,200 B |
| `make docs-check` | 0 | 5 pass / 1 WARN（RELEASE.md 行数，既有）/ 0 fail |
| `make check` | 0 | 10/10 段全绿，`[OK] 门禁全部通过` |

## 5. 双端截图（8 张，sha256 两两去重：0 重复）
| 文件 | 尺寸 | 字节 | sha12 | 关键内容 |
| --- | --- | --- | --- | --- |
| [sem-db-banner-desktop.png](screenshots/sem-db-banner-desktop.png) | 1440x912 | 121166 | 20db128ef023 | 已连接 MySQL 9.7.1（127.0.0.1:3306）+ 可达 9.7.1 |
| [sem-db-banner-mobile.png](screenshots/sem-db-banner-mobile.png) | 390x844 | 65387 | 7a1ce5b0d093 | 同上，无横向溢出（docW=390） |
| [sem-plugins-state-desktop.png](screenshots/sem-plugins-state-desktop.png) | 1440x1480 | 196287 | aab2b98323df | 14 行全量 + 汇总条 13/3/10/1 |
| [sem-plugins-state-mobile.png](screenshots/sem-plugins-state-mobile.png) | 390x844 | 47183 | 03251655a847 | 汇总条 + 蓝点「空闲」 |
| [sem-tasks-disabled-desktop.png](screenshots/sem-tasks-disabled-desktop.png) | 1440x900 | 100922 | 601a9efe5414 | 黄底说明 + 禁用表单 + 提权链接 |
| [sem-tasks-disabled-mobile.png](screenshots/sem-tasks-disabled-mobile.png) | 390x844 | 71089 | 906a28210b6c | 同上 |
| [sem-firewall-disabled-desktop.png](screenshots/sem-firewall-disabled-desktop.png) | 1440x927 | 139498 | c94f7e896fce | 提权指引 + 禁用字段 + 禁用「预览命令」 |
| [sem-firewall-disabled-mobile.png](screenshots/sem-firewall-disabled-mobile.png) | 390x844 | 82442 | 0da6548fcc2f | 同上 |

## 6. G-28 产品定位自评
| 页面 | 解决什么用户问题 | 与宝塔/1Panel 差距 | 状态 |
| --- | --- | --- | --- |
| 数据库 | 「我到底连上没有、服务端是哪个版本」一眼可判，不再被旧探测结果误导 | 宝塔有库表编辑/导入导出、1Panel 有慢查询面板；本页仅只读 SQL + 版本/状态 | 可用 |
| 已装插件 | 区分「空闲省资源」与「真故障」，避免 11 个黄点制造虚假告警 | 宝塔插件页只有启停；本页多了 lazy 语义与版本升级入口 | 可用 |
| 计划任务/防火墙 | 非 root 下不让人白填表单，直接给提权路径 | 宝塔/1Panel 以 root 常驻无此态；本页把它做成显式只读降级 | 可用（只读降级态） |

清理：一次性代理 `/tmp/kore-ui-proxy.py`、CDP 驱动 `/tmp/kore-shots.js`、探测脚本与 chromium profile 均在验证后删除，工作区只保留本报告与 8 张截图。
