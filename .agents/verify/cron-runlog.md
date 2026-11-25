# 定时任务执行历史 + 就地改计划（cron.runlog / PUT / runs）交付与 G-28 证据

> 状态: done · 归属: feat-cron-runlog · 日期 2026-11-25 · 写域 `kore-plugin-cron`（methods.go / info.json / manifest.json / CHANGELOG / README / methods_test.go）+ `kore`（internal/core/scheduler、internal/core/httpapi/handlers_scheduler.go、web/tasks.js、docs/CORE.md）+ 本报告与 4 张截图 · **未 push、未改 dist/、未入索引、未重签**

## 0. 结论

前一卡（feat-tasks-ux）留下的三个缺口全部补齐，并在隔离实例上真机验证：

1. **插件侧注册 `cron.runlog`**：`croncore.Store.Runlog`（0.4.1 已实现）此前没进 `cronVerb` 白名单、`info.json` 也没声明，主壳调不到。现在 `system:read` 只读方法，返回 `{available, entries[{task_name, started_at, duration_ms, exit_code, output_head, output_bytes, truncated, mode, timed_out}], count, note}`，最新在前，`limit` 缺省 50 / 上限 200。零后台收集器（G-19）。
2. **内核侧补两个端点**：`PUT /api/v1/scheduler/tasks/{id}`（就地改表达式 / 周期 / 超时 / 启停，复用创建路径的校验）与 `GET /api/v1/scheduler/tasks/{id}/runs`（内核自己的 `scheduler_runs` 记录，最新在前，保留口径写进 `note`）。
3. **前端执行历史可见**：新增「执行历史」面板（读 `cron.runlog`）——时间人话、状态含退出码、耗时、关键输出（前 512 字节可展开）、「只看失败」、空态给下一步；任务行「最近执行」优先用定时记录（刷新不丢）并标「定时」；内核任务行给「执行历史」与「改计划」（就地改，内置任务明确禁用并说明原因）。

## 1. 架构判断（为什么内核只加 runs 端点、不加 runlog 代理）

- **G-01 薄壳边界**：crontab 任务的逐次执行日志是**插件业务**（退出码 / 输出摘要是 cron 插件写的），因此前端**直接调插件方法** `cron.runlog`，内核零代理、零业务名词表。
- 内核的 `scheduler_runs` 是**内核自己的调度状态**（它执行 plugin 任务、记录成败与耗时），把它按任务读出来属于"读自己的状态"，不是插件业务，故 `GET /{id}/runs` 放在内核侧成立。
- 因此本次没有把 `cron.runlog` 藏到内核背后做"统一执行历史"——那会让内核认识 cron 语义（G-01 违规），也让备份 / 证书类内核任务的失败排查绕远路。
- `PUT /{id}` 只改**计划字段**：插件与方法不可改（改了就是另一条任务）；`plugin="kore"` 的内置任务拒绝就地修改（启动时由配置回填，改完等于"看起来生效、实际被覆盖"）。

## 2. 改动清单（path:line）

| 位置 | 说明 |
| --- | --- |
| `kore-plugin-cron/methods.go`（cronVerb / verbTimeout / handleCronVerb / parseRunlogParams） | `runlog` 进白名单；10s 预算；`{} ` 合法（A1：零参数只读不报 E_INVALID） |
| `kore-plugin-cron/internal/croncore/runlog.go` | 复用既有实现（未改一行）——本次只是把已实现能力接进协议 |
| `kore-plugin-cron/info.json` / `manifest.json` | version 0.9.0、methods+`cron.runlog`、method_capabilities=`system:read` |
| `kore-plugin-cron/methods_test.go`（`TestRunlogDispatchEncodesResult`） | 无记录 → `available=false`+note（不报错）；真执行一次后按协议读到该条（任务名 / 退出码 / mode / 时间）；limit 归一、非法 since → E_INVALID |
| `kore/internal/core/scheduler/input.go`（UpdateInput.merge） | 指针字段表达"改不改"；schedule 与 interval_s 互斥（同时给回 400） |
| `kore/internal/core/scheduler/scheduler.go`（Update / Runs / normalizeRunLimit） | Update 复用 `CreateInput.normalize`，保留 id/created_at/missed_count/last_*，重算 next_run_at；内置任务拒绝；Runs 只读、最新在前 |
| `kore/internal/core/scheduler/task.go` | `defaultRunLimit = 20` |
| `kore/internal/core/httpapi/handlers_scheduler.go` / `handlers.go` | PUT 与 GET runs 两个 handler + 路由（需 system:admin，越权记 capability.denied） |
| `kore/internal/core/scheduler/scheduler_test.go` | 身份/历史保留 + 表达式重算 + 内置任务拒绝 |
| `kore/internal/core/httpapi/handlers_scheduler_test.go` | 端点级：就地改生效并持久化 / 两字段互斥 400 / 未知 404 / 列表 2 条最新在前 / limit 非法 400 |
| `kore/web/tasks.js` | 执行历史面板 + 行内「定时」状态 + 查看日志接定时记录 + 内核任务「执行历史」/「改计划」弹窗；原「执行日志」改名「系统 cron 日志」以区分 |
| `kore/docs/CORE.md` | 端点清单补 2 条、总数 65→67（58→60 业务）、routes 72→74；scheduler 小节补 PUT / runs 语义 |

## 3. 门禁（命令 + 退出码）

| 项 | 命令 | 退出码 / 关键输出 |
| --- | --- | --- |
| 插件格式 | `cd kore-plugin-cron && gofmt -l .` | **0**：无输出 |
| 插件 vet + 测试 | `cd kore-plugin-cron && go vet ./... && go test -timeout 200s ./...` | **0**：`ok github.com/pengtang1024/kore-plugin-cron 0.077s`、`ok .../internal/croncore 0.363s`、`ok .../tests/{boundary,e2e,fault}` |
| 内核 vet | `cd kore && go vet ./...` | **0**：无输出 |
| 内核测试 | `cd kore && go test -timeout 300s ./...` | **0**：18 包全 ok（httpapi 3.700s、scheduler 1.055s、supervisor 8.841s） |
| 前端语法 | `node --check web/tasks.js` | **0** |
| 首屏预算 | `make web-dist && bash scripts/frontend-check.sh` | **0**：首屏 81528 / 307200 字节（余量 225672）；i18n 2922 / 3072 |
| 明文凭据 | `make secret-check` | **0**：0 FAIL / 22 处占位匹配 |
| 文档 | `bash scripts/docs-check.sh` | **0**：5 pass / 1 warn / 0 fail |
| 跨仓边界 | `make repo-check` | **0**：5 pass / 0 fail |
| 大小写 | `bash scripts/case-check.sh` | **0**：27 pass / 1 warn / 0 fail |
| 薄壳（G-01） | `bash scripts/thin-shell-check.sh` | **1**（**既有失败，与本次无关**）：命中 `handlers_disk.go`（backups/sites）、`handlers_site_import.go`；`git status --short` 证明这两个文件未改（属他卡已合入的代码），本卡文件零命中 |

## 4. 隔离实例真机证据（14 条断言全绿）

口径：`kored install --package` 装本仓新构建的 cron 0.9.0（离线单包路径，不依赖索引与签名）；`git` 工作树的 `make web-dist` 产物编进二进制；独立 `--config`（state/run/log 全在 `kore-pl/.tmp/runlog-e2e`）；cron 走文件后端 `KORE_CRON_FILE`（**不碰真实 crontab**），runlog 落 `state/runlog/runlog.jsonl`。

**真实执行链路**：`cron.add` 生成两条包装命令（每小时自检 `echo kore-sched-ok`；每日备份站点 `echo step1; echo "ERROR: disk full while writing backup"; exit 3`）→ 取出 crontab 里的包装命令按系统 cron 的方式执行两次（成功 / 失败）→ 再 `cron.run` 手动跑一次。`cron.runlog` 实际返回：

```text
[RUNLOG] available=True count=3
   manual    每小时自检     exit 0  2026-11-25T04:08:51Z
   scheduled 每日备份站点   exit 3  2026-11-25T04:08:51Z
   scheduled 每小时自检     exit 0  2026-11-25T04:08:51Z
```

内核侧：建 `plugin=cron/method=cron.runlog` 任务后立即执行两次 → `GET /{id}/runs` 返回 `count=2`；`PUT /{id} {"schedule":"0 4 * * *"}` 后 `next_run_at` 由 `2026-11-25T12:10+08:00` 变为 `2026-11-26T04:00+08:00`。

Playwright（chromium headless，真 DOM）断言（全部 PASS）：

| # | 断言 | 真机回读 |
| --- | --- | --- |
| 1 | 面板标题 | `执行历史` |
| 2 | 3 条记录 | `最近 3 条 / 3` |
| 3 | 最新在前 | 首行 `每小时自检 / 成功 / 1 毫秒 / kore-sched-ok …立即执行` |
| 4 | 失败行给退出码 | `失败（退出码 3）` |
| 5 | 失败行关键输出 | `step1 / ERROR: disk full while writing backup` |
| 6 | 定时执行标记 | 行内有 `定时执行` |
| 7 | 行内最近执行来自定时记录 | `失败（退出码 3） 2 分钟前 定时` |
| 8 | 只看失败 | 只剩 1 行 `每日备份站点`；meta=`最近 3 条（只看失败 1 条）` |
| 9 | 行「查看日志」→ 真实退出码 | `执行失败（退出码 3）`，meta 含 `定时执行` 与 `退出码 3` |
| 10 | 结果面板标注定时 | 提示「这条是定时执行留下的真实记录…」 |
| 11 | 内核任务执行历史 | `最近 2 次执行 / 内核定时任务「执行历史自检」/ 成功 / 0 毫秒` + 保留口径说明 |
| 12 | 就地改计划 | 列表计划 `每天 04:00 0 4 * * * / 2026-11-26 04:00` → `每天 05:00 0 5 * * * / 2026-11-26 05:00` |
| 13 | 桌面无横向溢出 | `scrollWidth=1440` |
| 14 | 手机无横向溢出 | `scrollWidth=390`；`pageerror` 双端 0 条 |

## 5. G-28 双端截图（`identify` 实测，md5 全异）

| 文件 | 实测宽高 | 字节 | md5(前 32) | 覆盖内容 |
| --- | --- | --- | --- | --- |
| `screenshots/tasks-runlog-desktop-01.png` | 1440 × 2685（full-page） | 373538 | `a0779e67f5ec651580a89df1354c5f2c` | 执行历史 3 条（含 `失败（退出码 3）` 红条 + 关键输出 + 折叠区「查看保存的输出」）；任务列表行内 `失败（退出码 3） … 定时`；内核任务 3 行带「执行历史 / 改计划」；最近 2 次执行；系统 cron 日志 |
| `screenshots/tasks-runlog-fail-desktop-02.png` | 1440 × 2681（full-page） | 373370 | `62f98436c5ecf6972b96de2f780761aa` | 点任务行「查看日志」后的结果面板：`执行失败（退出码 3）` + `定时执行` + 关键行（step1 / ERROR）+ 下一步指引 + 重试 / 编辑这条任务 |
| `screenshots/tasks-runlog-mobile-01.png` | 390 × 844（视口） | 59103 | `2699ce3865650cc18ccb25344e204bf2` | 手机执行历史：卡片式 时间/任务/状态/耗时/输出 标签布局，失败行红条 + `失败（退出码 3）` + 折叠区独占整行，无横向滚动 |
| `screenshots/tasks-runlog-mobile-02.png` | 390 × 844（视口） | 72228 | `41b42604aa1beba03988799ceb754f12` | 手机页面顶部（与 01 非同图缩放，4 张 md5 全异） |

**产品定位自评（三问）**

1. **本页解决什么用户问题**：定时任务失败以前只能靠"猜"或翻系统日志——面板只有一行"启动行"，看不到退出码与输出；刷新一次连本页刚跑的结果都丢了。现在「执行历史」直接给每次执行的时间 / 状态 / 退出码 / 关键输出，失败行还能只看失败、点进去看保存的输出；内核任务也能就地改计划，不必删了重建。
2. **与宝塔 / 1Panel 的差距**：宝塔把执行历史、日志、立即执行放在同一行并可改计划。Kore 现在**追平了"历史 + 立即执行 + 就地改计划"三件套**，差距剩下：历史不带保留期配置（插件固定 400 行轮转 / 内核 100 条）、没有分页与导出、不能对历史做"失败通知"（跨插件边界属告警中心）。
3. **当前"可用"还是"占位"**：**可用**。14 条真机断言全绿、双端零 JS 错误、手机无横向溢出；边界如实声明：crontab 任务的定时执行记录依赖 `cron.add` 生成的包装命令（`wrapped=false` 的任务只有立即执行记录，行内已标「无逐任务日志」）；本轮**未装进主实例**（索引仍指 cron 0.7.0，插件 0.9.0 未发布）。

## 6. G-29 运行态写边界

- **未改动主实例运行态**：对 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 零写入，未对 8787 发请求、未重启主实例。
- 隔离实例在 `kore-pl/.tmp/runlog-e2e`（含 config/state/run/log），验证结束已 `rm -rf`；`web/dist` 为 `make web-dist` 产物（已在 `.gitignore`），未提交、未含在本次 commit。
- 临时编排脚本（setup.sh / shot.sh / shot.mjs）随临时目录一并删除，工作区无残留。

## 7. 遗留与后续

- **未做（按卡约束）**：`kore-plugin-cron/dist/` 未打包、`kore-plugins` 索引未收录 0.9.0、未重签——主实例仍显示 cron 0.7.0（`update_available` 侧会提示新版本就绪后按发版流程处理）。
- **G-15 变更集待 lead 登记**：本卡跨两个仓（`kore-plugin-cron` 0.9.0 + `kore`），合并顺序建议先插件后内核（前端调用新方法/新端点在旧内核上会优雅降级：插件 0.7.0 时 `cron.runlog` 返回 E_NOTFOUND，执行历史面板显示"读不出来 + 重试"，不影响既有功能）。
- **既有门禁失败**：`thin-shell-check` 的 1 项 FAIL 命中的是 `handlers_disk.go` / `handlers_site_import.go`（两文件本轮未改），与本次改动无关，未在本卡范围内修。
