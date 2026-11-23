> 元信息: 2026-11-23T10:47+08:00 · 执行者 r7-backup-schedule（子 agent）· backup 0.3.0 + web 定时备份 · 真机 8787 + 真 chromium（CDP）· 报告 ≤80 行

# backup 保留策略与定时备份（接 scheduler）

## 0 交付面

- 插件 0.3.0：新增 `backup.retention {keep, dry_run?}` 与 `backup.stats`；`backup.list` 增 `managed`。
  保留规则：按创建时间倒序留最近 `keep`（1..100）；最新一份恒不删；只删带 `.meta.json`（id 匹配）
  且 `.sha256` 与 meta 一致的**本插件创建**包，外来包进 `protected[]`。
- 前端 `web/backups.js`：定时备份区块（每天 3 点 / 每 6 小时 / 每周日 2 点 / 自定义 cron，保留默认 7，
  路径可填）、任务表（暂停/恢复/删除）、列表上方「共 N 份，最早 X，最晚 Y，占用 Z」、
  保留策略区块（先 `dry_run` 预览、再确认清理）。
- `backup.schedule.set` 按任务书不做：插件不依赖内核 API，前端直接调 `POST /api/v1/scheduler/tasks`。

## 1 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| 插件 `make check` | 0 | gofmt clean · vet · 4 个包测试 ok |
| 插件 `make dist` ×2 | 0 / 0 | sha256=`201c424e…a90c` 两次一致；包内 size_bytes=1524286 / 实际 1524287 |
| `git archive HEAD` → 干净树 `make dist` | 0 | 同 sha256 `201c424e…a90c`（位级可复现） |
| `node --check web/backups.js` | 0 | 语法通过 |
| `make frontend` | 0 | 28 文件；首屏 gzip 46553 B / 307200 B |
| `make docs-check` | 0 | 5 pass / 1 warn（既有行数越界） |
| `make check` | 0 | 11 段全绿；secret 0 FAIL |

## 2 真机（8787，PID 2825708，backup 0.3.0）

| # | 动作 | 实测 |
| --- | --- | --- |
| 1 | `backup.stats`（5 份） | `total_count=5 total_bytes=1625 oldest=02:34:39Z newest=02:34:43Z by_name=[{r7-auto,5,1625}]` |
| 2 | `retention {"keep":2,"dry_run":true}` | `kept=2 deleted=3（…023441Z/…023440Z/…023439Z）freed_bytes=975 dry_run=true`；磁盘仍 5 个包 |
| 3 | `retention {"keep":2}` | 同上 3 份真删，`freed_bytes=975`；目录只剩 `…023442Z` / `…023443Z` 两份 |
| 4 | 外来包保护 | 手写 `manual-20260101T000000Z.tar.gz` → `deleted=[] protected=[manual…「非本插件创建，已跳过」] kept=3` |
| 5 | 定时任务保存（UI 真点） | 2 条：`备份 · 自动创建`(backup.create, `0 3 * * *`) + `备份 · 保留 7 份`(backup.retention, `1 3 * * *`, keep=7) |
| 6 | 立即执行 create 任务 | `run.status=ok dur_ms=13`；刷新后「上次结果=成功」，并真实产出 auto 备份 |
| 7 | UI 删除两条任务 | 行数 2→0；`GET /api/v1/scheduler/tasks` 中 plugin=backup 为 `[]` |

真删返回：`{"kept":2,"deleted":[{"id":"r7-auto-20261123T023441Z","name":"r7-auto","created_at":"2026-11-23T02:34:41Z","size_bytes":325},{"id":"…440Z",…},{"id":"…439Z",…}],"freed_bytes":975,"dry_run":false,"protected":[]}`

## 3 截图（G-28，`file` 实测）

| 桌面 1440 宽 full-page | 手机 390 宽 |
| --- | --- |
| `bk-schedule-desktop.png` 1440×2113 | `bk-schedule-mobile.png` 390×2661（scrollWidth=390，无横向溢出） |
| `bk-retention-desktop.png` 1440×2285 | —（同页手机截图已含保留区块） |

自评三问：①解决「不想手动点备份、又怕备份堆满磁盘」——一次配频率与份数，之后自动打包并清理；
②宝塔/1Panel 的保留策略多藏在计划任务里，本页把频率/份数/当前占用/将删清单放在一屏，清理默认先预览；
③**可用**（非占位）：dry_run→真删→任务创建→立即执行→删除全链路真机闭环。

## 4 与任务书的偏差（显式披露）

1. 任务书示例 `params={"name":"auto"}`：`backup.create` 强制要求 `paths` 非空（`create.go:29`），照抄会每次
   `E_INVALID`。已改为面板内填写路径并写入 `params.paths`；截图机为 `/tmp/r7-ret-src`（本机无 `/var/www`）。
2. 「暂停」：内核只有 list/create/run/delete，无原地启停端点；实现为「先建 `enabled=false` 副本、成功后再删旧
   任务」，失败保留原任务，页面注明。过期条件：内核提供 PATCH/enabled 端点后改原地更新。
3. 保留任务排在备份后 1 分钟（`0 3`→`1 3`），避免同刻并发时先清理后打包。

## 5 运行态与风险（G-29 / 发版）

- 8787 起停：`kill` 旧 PID → `setsid nohup ./bin/kored serve --config … >> .kore-local-log/stdout.log 2>&1 &`
  → `sleep 5` → healthz 200；继承原有 `KORE_*` 环境变量；未改 `.kore-local.yaml`、未动 `index_dir`。
- 插件升级：kored 停止时 `bin/kored install --config … --package dist/backup-0.3.0.tar.gz`（exit 0）→ 重启后
  `/api/v1/plugins` 的 backup=0.3.0。
- 测试数据已清理：9 份备份（含原有 `r2-*`）中的 8 份测试数据删除，目录回到原有 `r2-*` 1 份；定时任务 0 条；`/tmp` 一次性脚本与临时目录已删。
- 未 push / 未 tag / 未发 release（按纪律只本地 commit）。**待重签**：`kore-plugins/index/versions.lock.json`
  追加 backup 0.3.0 与 sha `201c424e…`，重签 `plugins.json`，同步 `presets/*.json` 版本区间；重签后商店才见 0.3.0。

## 6 commit

- `kore-plugin-backup`：`9c7d58c` `feat(backup,web): 保留策略与定时备份（接 scheduler）`
- `kore`：`982a6e1` 同名提交（`web/backups.js` + docs 两行 + 3 张截图）
