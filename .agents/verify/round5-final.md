# Round 5 收尾验收（重建重启 / db-mysql 0.3.1 / 方法级 capability / 双端截图）
> 元信息: 2026-11-23T09:45+08:00 · 执行者 r5-closeout 子 agent · 主实例 `127.0.0.1:8787` · 报告 ≤90 行

## 1. 结论
三内核/前端改动全部进了 8787 二进制；db-mysql 0.3.1 已发版、入索引、第二十九次重签完成；方法级 capability（读不落审计、写落 1 条）、槽位保护、SSE 均真机通过；39 张双端截图零重复。**发现并修复 1 处缺口：概览页原写死「上限 3」，未展示 `resident_max`/`lazy_slots`（commit `1ec0009`）。**

## 2. 任务 1：二进制包含三项改动
| 检查 | 命令/证据 | 结果 |
| --- | --- | --- |
| 提交在 HEAD | `git log --oneline -5` | `bdd7111` / `3586280` / `e90947a` 均在 |
| SSE 事件 | `strings bin/kored \| grep -c 'task.progress'` | **2**（≥1） |
| 槽位常量 | `grep -n defaultResidentMaxSlots internal/core/supervisor/manager.go` | `manager.go:32` = 2 |
| 方法级 capability | `grep -n effectiveInvokeRequirement internal/core/httpapi/invoke_capability.go` | `invoke_capability.go:157` |
| 新公钥编入 | `strings bin/kored \| grep -c 179270c4…7586f` | **1** |

- 重建：`make build` exit 0 → `bin/kored` 9,093,282 B，mtime 09:33（晚于全部 HEAD 提交源码 mtime）。
- 重启：旧 PID 2099761（TERM 优雅退出）→ 新 **PID 2301441**；启动环境含 `KORE_SSL_CERT_DIR`/`KORE_LOGS_SOURCES`/`KORE_BACKUP_DIR`/`KORE_BACKUP_ALLOW_ROOTS` + 从插件配置读出的 `MYSQL_PWD`/`REDISCLI_AUTH`；**未改** `.kore-local.yaml`/state.db/索引（G-29）。
- 重启后：`/-/healthz` **200**；`GET /store/plugins` **200 / 24 条**；`system/info.supervisor` = `{"resident":2,"restarts":0,"resident_max":2,"lazy_slots":1}`。

## 3. 任务 2：db-mysql 0.3.1 + 第二十九次重签
- 包：`dist/db-mysql-0.3.1.tar.gz` sha `91715714…7c1b`、size **1,540,702**，与任务给定逐字一致。
- 发布：`git push origin main` `0ff6e81..dd457c9`；`git tag -a v0.3.1` + push；`gh release create v0.3.1` → https://github.com/pengtang1024/kore-plugin-db-mysql/releases/tag/v0.3.1
- 索引：db-mysql `0.3.0→0.3.1`（sha/size/url）；`versions.lock.json` 追加 0.3.1；`presets/{web-pro,db-only,full}.json` 同步 0.3.1；市场页重建 24 插件 / 3765 B / 无外链。
- **新公钥（第二十九把）** `179270c45541f6297851526e4903094dc814c7299166fb5e03d814563f27586f`；两处逐字相同（`validate-index.sh:PUB_HEX` = `internal/core/market/verify.go:IndexPublicKeyHex`）；私钥只在 `/tmp` 生成并 `shred -u`。
- 正反例：正例 `validate-index.sh` → **exit 0**（24 条 / 基线 24 / 47 条预设引用 / ed25519 通过）；反例追加 1 字节 → **exit 1** `[FAIL] ed25519 签名验证失败`；恢回后 `sha256sum -c` 两行 OK。
- 24 条 release 资产 curl：`TOTAL=24 OK=24 BAD_COUNT=0`（http 200 + size + sha 三验）。
- 隔离实例 18850（config/state/run/log 全在 `/tmp`）：healthz 200 → store **200/24** → db-mysql `0.3.1/1540702` → `POST /store/install` **200** `{"state":"succeeded","reload":"reloaded"}`；已 kill、`/tmp` 已删。
- 提交（safe-commit）：kore-plugins **`3478600`**（8 文件，已 push）；kore **`5d2406f`**（verify.go）。

## 4. 任务 3：主实例升级 + 方法级 capability / 槽位 / SSE
- 重启后（新公钥）store 200/24；`POST /store/install {"id":"db-mysql","version":"0.3.1","download":true,"force":true}` → **200** `已从 v0.3.0 升级到 v0.3.1`（reload=restarted）。
- `GET /api/v1/plugins/db-mysql` → `version=0.3.1`，**`method_capabilities` 13 个方法**（config.get/instances/databases/query/status=read；config.set/createDatabase/dropDatabase/createUser/dropUser/grant/export/import=admin）。
| 验证 | 调用 | 审计（`GET /api/v1/audit?since=…`） |
| --- | --- | --- |
| 读方法免审计 | `db-mysql.instances` ×10 全 200（真实 MySQL 9.7.1） | `invoke.db-mysql.db-mysql.instances` = **0 条** |
| 写方法留痕 | `createDatabase {"name":"kore_mc_test"}` → 200 `{created:true}` | `invoke.db-mysql.db-mysql.createDatabase` = **1 条**（`ok`） |
| 清理 | `dropDatabase {"name":"kore_mc_test","confirm":true}` → 200 `{dropped:true}` | `databases` = 5，`kore_mc_test` 不存在 |

- 槽位：`system/info.supervisor` = **`{"resident":2,"resident_max":2,"lazy_slots":1}`**（site+terminal 常驻 2，lazy 保底 1 槽）。
- SSE：`curl -N -D` `GET /api/v1/events` → **200 + `Content-Type: text/event-stream`**，5 秒超时（exit 28）前收到 `: connected`。

## 5. 任务 4：截图（39 张 = 36 + 3，sha256 两两去重 0 重复）
每张前/后各断言：`.kore-shell` 存在、`#kore-password` 不存在、页内关键文案命中、`scrollWidth == innerWidth`；JS exception = 0。
| # | 页面 | 桌面（1440 宽）/字节 | 手机 390×844/字节 | 判定 |
| --- | --- | --- | --- | --- |
| 01 | dashboard | 1440×900 / 79509 | 52901 | 可用 |
| 02 | monitor | 1440×1568 / 148204 | 52649 | 可用（/proc 真实数据） |
| 03 | logs | 1440×932 / 225733 | 51405 | 可用（syslog+journal） |
| 04 | process | 1440×1085 / 245573 | 66119 | 可用（798 进程） |
| 05 | terminal | 1440×901 / 54195 | 22727 | 可用（真实 shell） |
| 06 | sites | 1440×900 / 105028 | 58733 | 可用（3 站点） |
| 07 | db | 1440×900 / 90685 | 73952 | 可用（MySQL 9.7.1） |
| 08 | redis | 1440×900 / 81731 | 69813 | 可用（Redis 7.4.12） |
| 09 | tasks | 1440×900 / 103602 | 68124 | **受限**（非 root，crontab 只读） |
| 10 | files | 1440×900 / 115735 | 56264 | 可用（6 项） |
| 11 | backup | 1440×900 / 95155 | 52170 | 可用（1 份） |
| 12 | ssl | 1440×1039 / 137317 | 53204 | 可用（2 张证书） |
| 13 | store | 1440×1210 / 173655 | 59907 | 可用（24/2 页） |
| 14 | plugins | 1440×1978 / 264990 | 50364 | 可用（20 已装） |
| 15 | firewall | 1440×931 / 120506 | 72561 | **受限**（非 root，ufw 只读） |
| 16 | settings | 1440×1099 / 165245 | 71691 | 可用（账户/审计/预算） |

| 附加/重点 | 尺寸/字节 | sha12 | 内容 |
| --- | --- | --- | --- |
| `r5-desktop-system.png` | 1440×357 / 39993 | `ebc3fd4d2a75` | 系统信息面板：**常驻插件 2 / 2 · lazy 可用 1**（1440 宽定向裁切） |
| `r5-desktop-alerts.png` | 1440×900 / 121176 | `02e746d9f414` | 铃铛红点 4 + 4 条真实告警（严重·提权被拒 14 次 / 警告×3） |
| `r5-desktop-progress.png` | 1440×900 / 147823 | `71924c04570f` | 「正在下载… 28%」→「重装成功 ✅」（真实 SSE 阶段） |
| `r5-desktop-store-p2.png` | 1440×1210 / 154960 | `0ce2541ad1e1` | 商店第 2 页 |
| `r5-mobile-store-p2.png` | 390×844 / 59898 | `c822da133189` | 手机商店第 2 页 |
| `r5-desktop-nav-search.png` | 1440×900 / 77365 | `077cee3fe3d3` | 全局搜索（Ctrl+K，mysql） |
| `r5-mobile-nav-drawer.png` | 390×844 / 31921 | `c91e6d3dad2e` | 手机「更多」抽屉 |

- 尺寸：桌面 21 张宽度全 **1440**；手机 18 张全 **390×844**；sha256 **39 个唯一，0 重复**。
- 非 JS 错误：firewall 双端各 1 条 network `403`（非 root 下 root-action 被内核拒绝，属权限模型预期降级）。

## 6. 门禁、提交与运行态
- `validate-index.sh` 0；`build-market.sh` 0；`make frontend` 0（首屏 gzip **45,917 B** ≤ 307,200）；`make check` **0（11/11 段全绿，secret-check 0 FAIL）**。
- 提交：kore-plugins `3478600`（已 push）；kore `5d2406f`（verify.go）、`1ec0009`（概览槽位）、本报告 + 39 张截图（紧随其后提交）。
- 运行态：仅重建/重启 `bin/kored`，未改主实例配置、state 与索引；`index_dir` 仍为 `kore-plugins/index`（G-29 复核通过）。

## 7. 最直观的 3 个问题
1. **概览槽位口径滞后（已修）**：`web/app.js` 写死「上限 3」，后端已有 `resident_max`/`lazy_slots` 却不展示；改为「2 / 2 · lazy 可用 1」并提交 `1ec0009`。
2. **非 root 下 firewall / tasks 是「红字受限」**：ufw 与 crontab 都需 root，首屏即红字 + 403 网络日志，非故障但接近失败态，16 页里 2 页只能判受限。
3. **进度阶段在快网几乎不可见**：直连下载 2.8 MB 约 1–2 秒，不降速拍不到阶段；本次用 CDP 限速 350 KB/s 才稳定截到「正在下载… 28%」。
