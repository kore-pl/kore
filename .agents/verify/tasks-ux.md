# 计划任务页易用性（空态 / 失败可见可操作 / 结果可读）交付与 G-28 证据

> 状态: done · 归属: feat-tasks-ux · 日期 2026-11-25 · 写域 `web/tasks.js`（唯一代码交付）+ 本报告 + 5 张截图 · 依据卡 tasks-ux（竞品清单条目11 + USABILITY A5 / P0-1、P2-3）· **未 push**

## 0. 结论

计划任务页的三个缺口按卡补齐，全部**真机点击 + 真后端**验证（隔离实例 18931，cron 插件 0.7.0 真实安装启用）：

1. **空状态给下一步**：没有任何任务时不再只显示一句"暂无"，改为「用预设创建第一个任务（点击即自动填好第一张预设，共 2 步）/ 手动填写 / 重试读取 / 去软件商店」四类明确入口；读取失败与权限受限各有对应按钮（不再裸错误码）。
2. **失败可见且可操作**：任务行显著标记（左侧红条 + 文字 chip，双通道不靠颜色单通道）——crontab 任务用插件 `binary_status` 预判「到点会失败」并给**一键修复路径**，本页「立即执行」的退出码按任务留痕为行内状态；内核定时任务用后端 `last_result`（ok/failed/timeout/skipped/missed）判定最近执行失败；每行给「重试 / 查看日志 / 编辑」入口。
3. **执行结果可读**：成功 / 失败（退出码）/ 超时 / 跳过给明确文案 + 颜色 + 一句「下一步怎么办」；时间全部人话（刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM）；日志**只显示关键行**（报错类行 + 首 2 尾 3 行），其余折叠进「查看完整输出」并如实写「另有 N 行已折叠」。

**缺口如实报告（不在本卡写域）**：crontab 任务的**定时执行历史**仍读不到——插件里 `Store.Runlog` 已实现（`kore-plugin-cron/internal/croncore/runlog.go:174`）但**未注册为动词**（`methods.go:104-107` 的 `cronVerb` 白名单无 `runlog`，`info.json` methods 也未声明），主壳无法调用。因此本页不伪造"定时执行历史"，行内状态只标「本页最近一次执行」并用 title 声明刷新后清空。需一张后端卡把 `cron.runlog` 接进 dispatch + info.json，前端再接列表（改 `kore-plugin-cron` 属他人写域，本卡按约束未动一行）。

## 1. 改动依据（path:line，全部在 `web/tasks.js`）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 空状态 + 下一步 | `web/tasks.js:888` `paintEmptyList` | 无任务 / 读取失败 / 环境受限三态各有按钮；按钮统一 44px 触摸高 |
| 空态一键套预设 | `web/tasks.js:866` `primeFirstPreset` | 点「用预设创建第一个任务」= 直接填好第一张预设（不是只滚动），1 击 + 保存 = 2 步 |
| 行级失败标记 + 列 | `web/tasks.js:918` `paintRunCell` / `:954` `paintList` | 新增「最近执行」列；异常行 `inset 3px` 红条 + chip；备注并入命令列让出列宽 |
| 会失败预判 + 一键修复 | `web/tasks.js:729` `entryRisk` / `:843` `fixPaths` | 用 `binary_status`(stale/missing) 判「到点会失败」，修复走已有 `cron.migrate`（写前备份） |
| 只看异常 | `web/tasks.js:1058` `paintFilterBtn` | 无异常时不显示空开关；过滤后为空给「显示全部任务」 |
| 执行结果与日志 | `web/tasks.js:505` `paintResult` | 结论（成功/失败/超时/跳过）+ 颜色 + 怎么办；关键行 `pre` + `details` 折叠全量；底部「重试 / 编辑这条任务」 |
| 关键行提取 | `web/tasks.js:654` `keyLines` | 命中 `KEY_LINE_RE`（错误/权限/超时等）的行 ≤6 条 + 首 2 尾 3；单行 >240 字截断；回传被折叠行数 |
| 人话时间 | `web/tasks.js:625` `humanTime` | 刚刚 / N 分钟前 / 今天 / 昨天 / N 天前 / 完整日期（本地时区；解析失败原样显示不猜） |
| 内核定时任务可见 | `web/tasks.js:1148` `loadSched` / `:1203` `paintSched` | 本页建的 plugin 任务此前"建完就消失"，现按 `GET /api/v1/scheduler/tasks` 列出下一步执行 + 最近结果 |
| 内核任务重试/删除 | `web/tasks.js:1299` `runSchedTask` / `:1334` `removeSchedTask` | `POST /scheduler/tasks/{id}/run`、`DELETE /scheduler/tasks/{id}`（均为既有端点） |
| 结果判定 | `web/tasks.js:718` `runVerdict` | 成功 / 失败（退出码 N）/ 超时（60 秒）/ 没能执行 四态统一 |
| 日志空态补按钮 | `web/tasks.js:1083` `paintLogs`（按钮在 `:1108`） | 补齐审计 P2-3「空态块本身无按钮」：无日志源给「重新检测日志源」，无记录给「刷新日志」 |

后端字段审计结论：**未新增任何后端字段调用**——`cron.list.binary_status`、`cron.run` 的退出码/输出、`cron.migrate`、`/api/v1/scheduler/tasks` 的 `last_result`/`next_run_at` 全部是既有能力。

## 2. 真机点击证据（隔离实例 18931 · 真登录 · 真装 cron 0.7.0）

隔离口径：`git archive HEAD` 源码 + 本次 `web/tasks.js` → `make web-dist` → `CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build`；独立 `--config`，config/state/run/log 全落 `/tmp`；cron 用插件自带 `KORE_CRON_FILE` 文件后端（不碰真实 crontab）+ `KORE_CRON_LOG_FILE` 造 2 条真实格式日志行。点击链路与断言（Playwright chromium headless，真 DOM）：

| 步骤 | 断言（真机回读原文） | 结果 |
| --- | --- | --- |
| ① 空态 | 文本含「还没有任何定时任务 / 下一步 / 2 步」；按钮= `["用预设创建第一个任务","手动填写"]` | PASS |
| ② 空态主按钮建任务 | 点击后 `时间表达式=0 3 * * *`（第一张预设已填）；改命令为会失败的命令后点「新增任务」→ 列表 1 行 | PASS |
| ③ 立即执行 | 结论=`执行失败（退出码 2）`；关键行=`["step 1 ok","step 2 ok","step 30 ok","ERROR: disk full while writing backup"]`；提示「共 31 行输出…另有 27 行已折叠」；折叠区 `查看完整输出` 存在 | PASS |
| ④ 行内失败可见 | 最近执行 chip=`失败（退出码 2）`；行操作=`["停用","编辑","重试","查看日志","删除"]`（失败行「立即执行」自动变「重试」） | PASS |
| ⑤ 查看日志入口 | 点「查看日志」→ 执行结果面板 `visible=true`（同一份关键行，不重新执行） | PASS |
| ⑥ 重试 | 点「重试」→ 确认后真再跑一次，结论仍 `执行失败（退出码 2）`（不假装成功） | PASS |
| ⑦ 编辑后重试成功 | 「编辑」改命令为 `echo kore-retry-ok` → 保存 → 执行：结论 `执行成功（退出码 0）`，chip=`成功` | PASS |
| ⑧ 内核定时任务区 | meta=`共 2 条`；首行「审计按龄清理 / kore.audit.clean / 每 6 小时 / 今天 17:52 / 还没执行过 / 立即执行 查看日志 删除」 | PASS |
| ⑨ 执行日志人话时间 | 2 行；首行=`今天 02:00  root  110  echo kore-hourly-ok` | PASS |
| ⑩ 无横向溢出 / 无 JS 错 | 桌面 `docScrollW=1440`（=视口）、手机 `docScrollW=390`（=视口）；`pageerror` 双端均 0 条 | PASS |

## 3. G-28 双端截图（`file`/`identify` 实测，md5 全异）

| 文件 | 实测宽高 | 字节 | md5(前16) | 覆盖内容 |
| --- | --- | --- | --- | --- |
| `screenshots/tasks-ux-empty-desktop-01.png` | 1440 × 1637（full-page） | 229076 | `0987bbb646c3cbed` | 空态两句人话 + 两个 44px 按钮；内核定时任务 2 行；执行日志人话时间 |
| `screenshots/tasks-ux-empty-mobile-01.png` | 390 × 844（视口） | 71672 | `f58ef0cce55df3ac` | 手机首屏空态：按钮上下堆叠、无横向滚动 |
| `screenshots/tasks-ux-fail-desktop-01.png` | 1440 × 2146（full-page） | 298019 | `089b5ff641742695` | 失败行红条 + `失败（退出码 2）` + 重试/查看日志；结果面板结论+4 行关键行+`另有 27 行已折叠`+折叠区 |
| `screenshots/tasks-ux-fail-mobile-01.png` | 390 × 844（视口） | 67066 | `4f923c0f1b0a7e07` | 手机卡片式失败行：红条、chip、按钮 ≥44px、命令与备注不挤成竖排 |
| `screenshots/tasks-ux-retry-ok-desktop-01.png` | 1440 × 1990（full-page） | 265415 | `5deadf91a29573f6` | 编辑成成功命令后重试：结论 `执行成功（退出码 0）` + chip `成功` |

双端非同图缩放：桌面为 full-page（1637/2146/1990 高、侧栏与全页布局），手机为 390×844 视口、卡片式堆叠；md5 全异。

**产品定位自评（三问）**

1. **本页解决什么用户问题**：小白建第一条定时任务的路径是"先懂 cron 语法"——空页只有一句"暂无数据"；任务失败后只能看到一行退出码，还得自己翻系统日志；定时任务与内核插件任务又是两套心智模型（plugin 任务建完在本页消失）。现在：空态一键套预设 → 2 步建成；失败任务在列表里第一眼可见并可直接重试/看关键日志/编辑；内核任务在本页可见可重试。
2. **与宝塔 / 1Panel 的差距**：本页从"功能追平"推进到"失败闭环"——宝塔把执行历史、日志、立即执行放同一行；Kore 现在做到了失败行内状态 + 关键行日志 + 重试，**但仍差"定时执行的完整历史时间线"**（缺口见 §0：`cron.runlog` 后端已实现未暴露，需要插件仓一张卡）；另外内核任务不支持就地编辑（需删后重建），宝塔类面板可直接改计划——这是后端缺 PUT 端点，前端如实标注而不假装可编辑。
3. **当前"可用"还是"占位"**：**可用**。九项断言全部真机真后端通过，页面无 JS 错误、手机无横向溢出；边界如实声明：行内「最近执行」只覆盖本页发起的立即执行（刷新清空，chip title 已标注），定时执行历史等后端 runlog 暴露后补。

## 4. 门禁（命令 + 退出码）

| 项 | 命令 | 退出码 / 关键输出 |
| --- | --- | --- |
| 语法 | `node --check web/tasks.js` | **0** |
| 首屏预算 | `make web-dist && bash scripts/frontend-check.sh` | **0**：首屏 81528 / 307200 字节（余量 225672）；i18n 2922 / 3072 |
| 明文凭据 | `make secret-check` | **0**：0 FAIL / 22 处匹配（占位写法合规） |
| 编译 | `go vet ./...` | **0** |
| 单测 | `go test -timeout 200s ./...` | **0**（全包 ok，含 httpapi 3.7s / supervisor 8.9s） |
| 隔离实例 | 见 §2（构建 exit=0、healthz 200、install `state=succeeded reload=reloaded`、Playwright `flow exit=0`） | **0** |

## 5. G-29 运行态写边界

- **未改动主实例运行态**：对 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / 主 `bin/kored` 全程零写入，未对 8787 发任何请求、未重启主实例；本轮只起停隔离实例 18931（脚本 trap 内已停进程并 `rm -rf /tmp/kore-tasksux`）。
- 隔离实例装了 cron 0.7.0 到自己的 `/tmp/.../state/plugins`，crontab 走 `KORE_CRON_FILE` 文件后端，**未触碰本机真实 crontab**（本机当前用户无 crontab 权限）。
- 临时资产：编排脚本全部在 `/tmp/kore-tasksux` 内即用即删，工作区未留脚本/缓存；`web/dist` 为 `make web-dist` 产物且已在 `.gitignore`，未被提交。

## 6. 横向与后续

- 与 `feat-backup-path-detect`（`web/backups.js`）/ `feat-site-migrate`（migrate 相关）写域无交集；`app.js` / `sites.js` / `store.js` / `site-edit.js` 有他人在途改动，本次**一行未碰**（提交前 `git status` 核对）。
- 后续建议（按收益排序）：① 插件仓注册 `cron.runlog`（`croncore/runlog.go:174` 已有 Query 实现）+ 前端在任务行接"最近 5 次执行"，这是本页唯一还缺的一环；② 内核 `/scheduler/tasks` 补 PUT（就地改计划）与 `GET /{id}/runs`（执行历史）；③ `cron.list` 若加 `last_run`/`last_exit` 字段，行内状态可跨刷新保留。
