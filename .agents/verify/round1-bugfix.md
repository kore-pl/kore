# 第一轮真机验收修复报告（3 bug + 4 口径）

**验证环境**：隔离实例 `/tmp/kore-verify`（kored 用工作树构建产物，配置 `state_dir: "./state"` 等相对路径），端口 `18891`，装 file / cron / site 三插件；8787 常驻实例未重启、未改动（PID 2557675）。
**测试数据**：`site.create demo.verify.test`（vhost 落在 `/tmp/kore-verify/nginx/conf.d`）；`crontab -l` 本机真实报 `crontabs/pt/: fopen: 权限不够`。

## Bug 1 · 相对路径配置破坏常驻插件启动（设计层修复）

**修法**：`internal/core/config` 在加载末段新增 `normalizePaths`，对 `paths.state_dir/run_dir/log_dir/index_dir/plugin_dir` 全部 `filepath.Abs + Clean`；覆盖来源（config / `KORE_STATE_DIR` / `KORE_PLUGIN_DIR` / `--state-dir`）同批生效；`~` 前缀明确报错（退出码 2，不静默拼成 `<cwd>/~`）；相对值归一化时逐项 WARN（日志可见），并新增 `GET /api/v1/system/info.paths` 暴露绝对路径。未在 supervisor 加任何补丁。
**测试**：`internal/core/config/paths_test.go`——相对路径→绝对（含派生 plugin_dir）、`~` 明确报错、已绝对路径不被改写；`go test` PASS。
**红转绿（A/B 实测）**：
- 修复前二进制（`git archive HEAD` 构建，18892 同配置）：`POST /plugins/site/enable` → **HTTP 502**，`E_UPSTREAM: fork/exec state/plugins/site/0.1.0/bin/site: no such file or directory`
- 修复后（18891，相对路径配置）：安装 → enable → **HTTP 200 `state=ready`**；`/system/info.paths` 五项全为 `/tmp/kore-verify/...` 绝对路径；插件子进程 `KORE_STATE_DIR` / `KORE_PLUGIN_SOCK` 均为绝对路径。

## Bug 2 · site「未测」与「测挂」混为一谈

**后端**（`kore-plugin-site`）：`siteInfo` / `siteStatusResult` 增加 `test_skipped` / `reload_skipped`，列表另带 `test_output` 失败摘要；`test_ok` 只表示"测过且通过"。
**前端**（`web/sites.js`）：`flag()` 升级三态——通过→绿、`skipped`→灰「未检测（未配置 nginx）」、失败→红「nginx -t 失败」+ 摘要（`title` 放完整输出）。列表与详情一致。
**实测**：列表行 `vhost 存在`（绿，真实事实）+ 两个灰「未检测（未配置 nginx）」，`.chip-fail` 数量 = 0；详情同样灰，无「失败」字样。测试 `TestSiteListReportsSkipped` 覆盖 list/status 的 skipped 语义，插件 `go test ./...` PASS。

## Bug 3 · cron 权限错误直出 500 + 原始错误

**后端**（`kore-plugin-cron`）：新增 `ErrNoPermission` 哨兵；`readCrontab` 先区分 `no crontab`（正常空）与权限类（`permission denied` / `权限不够` / `权限不足` 等中英文），后者 `List` 返回 **成功 + `entries: []` + `warning`**；真 I/O 失败仍 `ErrIO`（`TestListRealIOFailureStillErrors` 守住）。
**前端**（`web/tasks.js`）：灰底提示条 `.task-warn` + 空态「当前环境读不到 crontab」；不再走红色错误。
**实测**：`cron.list` → HTTP 200 `{"entries":[],"count":0,"warning":"当前用户无 crontab 权限（crontab -l 报权限错误）"}`；页面 warning 可见、数据行 0、console error = 0。

## 四条口径

4. **常驻数同源**：概览改为 `system/info.supervisor.resident` 并显示 `N / 上限 3`；监控仍读同字段，卡片注释「上限 3（推荐 ≤2）」。实测同一时刻 API=2，概览=2、监控=`2 /3`（同一来源；monitor.js 由其他 agent 负责，inline `/3` 未改，其 note 已标注上限 3）。
5. **重启计数**：概览主表删除该行；`>0` 时以黄色小字「累计重启 N 次」附在面板底部（`title` 说明历史累计），本次实测 0 故不显示；监控页保留实时口径。
6. **降级告警人话**：`部分隔离能力不可用（cgroup 委派未开启、SELinux 未启用），资源限额将以观测模式运行`；原始两条技术串进 `title`（DOM 断言已校验）。
7. **手机端标签-值同行**：`<640px` `.rows tr` 改 `grid-template-columns: 88px minmax(0,1fr)`；390px 实测 label 宽=88px、`thY == tdY == 118`，不再上下堆叠。

## 双端截图（G-28，DOM 断言前后各一次，sha 全不重复）

| 页面 | 文件 | 尺寸 | sha256 前 12 | 关键断言 |
| --- | --- | --- | --- | --- |
| 概览 | bugfix-dashboard-desktop-01.png | 1440×900 | `ed21161f1a4b` | 常驻/上限3、无重启计数、人话告警+title |
| 概览 | bugfix-dashboard-mobile-01.png | 390×844 | `21a3a61998f1` | 同上 + 88px 同行几何 |
| 网站 | bugfix-sites-desktop-01.png | 1440×900 | `7441af237a0a` | 灰「未检测」×2、失败徽章=0 |
| 网站 | bugfix-sites-mobile-01.png | 390×1052 | `884401f47ed3` | 同上（fullPage） |
| 任务 | bugfix-tasks-desktop-01.png | 1440×900 | `b762c476826c` | 灰提示条、空表、console error=0 |
| 任务 | bugfix-tasks-mobile-01.png | 390×911 | `a672f4f91231` | 同上（fullPage） |

**产品定位自评**：本页解决"常驻守护面板看不出环境限制还是真故障"的问题；对比宝塔/1Panel，kore 用三态徽章与灰提示条把「没测/测挂」「没权限/服务坏」分开，但仍缺站点一键申请证书、任务日志回看；当前状态：**可用**（真实数据 + 双端可用），非占位。

## 门禁

- `go test -timeout 200s ./...`（kore）：**0**
- `kore-plugin-site` `go test ./...`：**0**；`kore-plugin-cron` `go test ./...`：**0**
- `make check` 10/10 段：**0**（首屏 30457 B / 307200 B，余量 276743 B）
- 未改 `web/{shell,store,monitor,files}.js`、未改 `pkg/pluginapi`；无 ticker；新增文件均 ≤200 行；未重启 8787、未 push。
