> 元信息: 2026-11-23T11:15+08:00 · 执行者 r7-cron-real（implementer）· kore-plugin-cron 0.3.0 · 隔离实例 `127.0.0.1:18849`（state/run/log 全在 `/tmp/kore-cron-verify`）· 真实 crontab 未改动 · 报告 ≤120 行

# cron 0.3.0 验收：任务类型 / 执行日志 / 立即执行

## 0. 结论

三个能力全部落地并通过隔离实例真实验证：① `cron.add` 三类型（shell / http 落 crontab，plugin 只生成内核 scheduler 建议）② `cron.logs` 真实读本机 `journalctl -u cron` 与 `/var/log/syslog` ③ `cron.run` 只执行 crontab 已注册命令（伪造命令被拒）、60s 超时按进程组杀。插件 `make check` / `make build` / `make dist` 退出码 0，两次打包与 `git archive` 干净树复现 sha 逐字一致 `9104823a…28ee`。**未做**：索引重签 / 安装到主实例（见 §8 待重签清单）；G-15 变更集待 lead 登记。

## 1. 三种任务类型（真实 API 输出）

| type | 入参 | 落点 | 隔离实例实测 |
| --- | --- | --- | --- |
| `shell`（缺省） | `command` | 系统 crontab | `{"type":"shell","entry":{"index":0,"type":"shell","schedule":"0 3 * * *","command":"echo hello",…},"backup_path":"/tmp/kore-cron-verify/backup/…"}` |
| `http` | `url` / `method?` / `headers?` / `body?` | 系统 crontab（固定 argv curl） | 生成 `curl -sS -m 30 -o /dev/null -X POST -H 'X-Token: abc' --data-raw '{"ok":true}' 'https://example.com/health'`，`type=http` |
| `plugin` | `plugin` / `method` / `params` | **不落 crontab** | 返回 `scheduler_task` + `endpoint:"/api/v1/scheduler/tasks"`；随后 POST 创建成功 `tsk-846a7df25e2da2a6` |

- plugin 边界证据：crud 文件只有 2 条任务（shell + http），plugin 任务不在其中——`cron` 插件没写 crontab。
- http 边界：url 仅 http/https、method 白名单、url/headers/body 拒绝换行/回车/NUL/控制字符（`checkNoControl`），可变参数全部单引号转义（含 `'\''`）；单测覆盖 ftp / 换行 / NUL / TRACE / 非法 header。
- 命令生成确定性：同 headers 不同 map 顺序 20 次生成逐字一致（单测）。
- 兼容性：老调用方只给 `schedule+command`（无 `type`）按 shell 处理，原有 4 方法行为不变（0.2.x e2e 用例全绿）。

## 2. 执行日志（本机真实结果）

两次真实读取，两个源都验证过（同一隔离实例，仅切换 `KORE_CRON_DISABLE_JOURNAL`）：

| 源 | 命令侧 | 结果（原文截断） |
| --- | --- | --- |
| `journalctl -u cron` | 默认 | `{"available":true,"source":"journalctl -u cron",…,"count":5}`，含 `(root) CMD (cd / && run-parts --report /etc/cron.hourly)` |
| `/var/log/syslog` | `KORE_CRON_DISABLE_JOURNAL=1` 后重启 | `{"available":true,"source":"/var/log/syslog",…,"count":3}`，条目 `{time:"2026-11-23T10:17:01+08:00",user:"root",command:"cd / && run-parts …",pid:2634626}` |

- 解析：经典 syslog（无年份，按当前年推断 + 跨年回退）与 `journalctl -o short-iso`（带年份/偏移）双格式；`pam_unix` 会话行、`(CRON) info` 行跳过。
- 返回 `entries` 最新在前，`limit` 默认 50 / 上限 200；`name` 先匹配 crontab 备注/命令再过滤日志行。
- `note` 原文：`系统 cron 只记录任务启动行（CMD）；如需完整执行输出，请把任务命令重定向到日志文件（例如 >> /var/log/myjob.log 2>&1）`。
- **诚实边界**：没有任何日志源时 `available=false` + `source:"none"` + 原因列表 + 补救方式（单测 `TestLogsUnavailableIsHonest` 断言，不把"读不到"伪装成"没执行"）。

## 3. `cron.run` 安全边界

| 检查 | 实测/单测 |
| --- | --- |
| 只接受 `index` / `name` 定位符 | `{"command":"echo pwned"}` → `{"code":"E_INVALID","message":"index 或 name 必填"}` |
| 同时伪造 command 时只跑 crontab 命令 | `{"index":0,"command":"echo pwned"}` → `output:"hello\n"`, `command:"echo hello"` |
| 未知 name | `{"code":"E_NOTFOUND","message":"没有匹配 name=no-such 的任务（只按已注册任务的备注或命令匹配）…"}` |
| 同名多条 | `ErrInvalidParam`，要求改用 index（单测） |
| 60s 超时 + 进程组杀 | 150ms 单测实测 0.15s 返回，`timed_out:true`，保留已产生输出（`sleep 5` 不漏等） |
| 并发 | 第二次触发 `E_CONFLICT`（`ErrBusy`，单测） |
| 输出上限 | 64 KiB（`limitedBuffer` 单测） |
| 能力门 | `info.json.method_capabilities["cron.run"]="system:admin"`；`GET /api/v1/plugins/cron` 回读一致（list/logs=`system:read`） |

执行方式与系统 cron 一致：`/bin/sh -c "<该条命令>"`；安全边界是"命令来源只有 crontab 解析结果"，入参无法注入执行目标。

## 4. 前端改动（`web/tasks.js` + `web/style.css` 的两处 hunk）

- 任务类型下拉（shell/http/plugin）+ 三组字段按类型切换；http 组含 URL/方法/请求头（每行 `名称: 值`）/请求体；plugin 组含插件 id/方法/参数 JSON。
- plugin 提交链路：`cron.add(type=plugin)` → 拿 `scheduler_task` → 前端 `POST /api/v1/scheduler/tasks`；成功后提示"已创建内核定时任务…；cron 插件未写入 crontab"。
- 列表新增「类型」徽标（shell/http）、每行「立即执行」（确认框 → 同步执行 → 结果面板：退出码/耗时/输出）。
- 新增「执行日志」面板：来源/条数/note/表格，`available=false` 用黄底说明条而非错误色；「刷新日志」按钮。
- 只读锁：无权限时禁用类型选择、表单与立即执行，保留日志只读；http 任务「编辑」禁用并提示删除重建（`cron.replace` 只收 schedule+command）。

## 5. 双端截图（G-28）

| 文件 | 尺寸 | sha256 | 内容 |
| --- | --- | --- | --- |
| `screenshots/cron-types-desktop.png` | 1440×900 | `bc2c4b4e…1cb8` | 类型下拉=插件任务 + 插件字段 + "已创建内核定时任务 tsk-846a…" 状态 |
| `screenshots/cron-types-mobile.png` | 390×844 | `f446f6f8…8724` | 手机端类型选择与插件字段（单列堆叠） |
| `screenshots/cron-logs-desktop.png` | 1440×900 | `95e7ec71…5c77` | 执行日志：`日志源：journalctl -u cron · 50 条` + 真实 CRON 行 |
| `screenshots/cron-run-desktop.png` | 1440×900 | `dd87918c…7ac5` | shell/http 两行 + 立即执行结果：退出码 0 / 耗时 0 ms / 输出 `hello` + 日志区 |

真实浏览器（chromium-1248 headless + CDP）操作，非 mock：页面加载真实 18849 实例、UI 提交 plugin 任务、点击「立即执行」并确认；`Runtime.exceptionThrown` = 0。

**产品定位自评（三问）**：
1. 解决什么问题：让"系统定时任务"可看懂、可排查、可立即验证——类型化降低手写 curl 的门槛，日志/立即执行回答"到底跑没跑、跑成什么样"。
2. 与宝塔 / 1Panel 差距：宝塔有计划任务与执行日志、1Panel 有 cron 管理；本页已有三类型 + 真实日志 + 立即执行，但**没有**按任务分组的执行历史、失败告警、保留策略与"上次执行结果"列（日志依赖系统源，非插件自建记录）。
3. 当前状态：**可用**（真实 crontab 增删改 + 真实日志读取 + 真实同步执行），非占位；plugin 类型为"建任务"入口，执行与历史归内核 scheduler 页。

## 6. 版本与可复现 sha

- 版本：`0.2.1 → 0.3.0`（feat → minor），`info.json` / `manifest.json` 同步；`info.json` 新增 `method_capabilities`（6 方法）。
- `size_bytes=1512236`（包内声明），实际包体 1512234（偏差 2，Makefile 阈值内）。
- sha256：`9104823a39fbab2f19e9c1313a01ef41fb782a8e329abae29ac42ee80de828ee`
- 两次 `make dist` 一致；`git archive HEAD` 到 `/tmp/cron-clean` 后 `make dist` 两次仍为该 sha（干净树复现）。
- commit：插件 `a27fa27`（kore-plugin-cron）；前端与验收证据随本报告同提交（kore，本地未 push）。

## 7. 门禁退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `make check`（gofmt / vet / test） | 0 | `gofmt: clean`；4 包测试全绿（含 e2e 真实进程、四类 fault） |
| `make build` | 0 | `bin/cron`（CGO=0 + trimpath + `-s -w`） |
| `make dist` ×2 | 0 / 0 | 同 sha `9104823a…28ee` |
| `make frontend`（kore） | 0 | 首屏 51241 B / 300 KiB；i18n 增量 2787 B / 3 KiB |
| `make docs-check`（kore） | 0 | `5 pass, 1 warn, 0 fail`（WARN 非本次改动） |
| `make secret-check`（kore） | 0 | `0 FAIL / 7 处匹配（占位写法均合规）` |
| `node --check web/tasks.js` | 0 | 语法通过 |

## 8. 隔离与并发披露 / 待重签清单

- **主实例未动**：8787 的运行态配置 / state / `bin/kored` 均未修改；本报告所有实测在 `/tmp/kore-cron-verify`（独立 config + state/run/log）。
- **真实 crontab 未被碰**：插件进程以 `KORE_CRON_FILE=/tmp/kore-cron-verify/crontab.txt` 启动，`crontabfile.go` 在该模式下完全不走 `crontab` 命令；本机 `crontab -l` 当前返回 `crontabs/pt/: fopen: 权限不够`（原本就无 crontab），与临时文件内容不同。
- **并发写披露**：`web/style.css` 同时被另一 agent 的 SSL 到期/ACME 样式修改；本次提交只含 cron 任务样式两处 hunk（1504 追加块 + 1024px 网格行），`web/tasks.js` 全部为本次改动；`web/embed.go` / `shell.js` / `settings.js` / `index.html` 等 i18n 改动未纳入本次提交。
- **待重签清单（不 push，等 lead）**：
  1. `kore-plugins/index/plugins.json`：`cron` 版本 0.2.1 → 0.3.0、`sha256=9104823a…`、`size_bytes=1512236`、`url` 指向 `cron-0.3.0.tar.gz`；
  2. `index/versions.lock.json` 同步；如 `presets/*.json` 引用 cron 版本区间需同步；
  3. 索引重签（下一轮）后主实例商店才可安装 0.3.0；安装/启用后需重启 kored 使新前端产物生效（`web/dist` 已重打，本次未重建主 `bin/kored`）；
  4. 发布动作（push + tag `v0.3.0` + release）待 lead 指令。
