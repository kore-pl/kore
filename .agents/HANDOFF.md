# .agents · 交接规范（Handoff）

> 状态: active · 归属: scribe · 更新: 2026-11-24 · 里程碑: M0–M5

任何人或 AI 在本仓库中断后接手（换模型、换会话、换人、隔天回来），只读仓库文件就必须回答四问：
**要做什么、怎么干、干到哪了、为什么这么定**。这份规范定义这四问分别由哪些文件回答，以及
"什么才算落过文件"。

## 0. 当前交接快照（2026-11-24 01:40）

> 本节是「今天真实状态」的增量快照，§1–§7 的规范与卡片模板不变。
> 每条附命令 / `file:line` / commit；查不到的写「未确认」，不写推测。
> 上一版快照为 2026-11-23 23:30（`ec883d4`）；本版只写此后**重新核实过**或**已发生变化**的事实，未变部分沿用并标注口径。
> 本轮写域只有本文件；`make check` **未作为单条聚合命令执行**——17 段逐段实测：第 10 段用
> `bash scripts/frontend-check.sh` 复核既有 `web/dist`（未跑 `make frontend` 重建，避免改动运行中实例所服务的静态产物），
> 第 2 段拆成 `scripts/dep-check.sh` + Makefile 参数 grep 执行，其余各段与 Makefile 中命令 / 脚本一致。

### A. 四问当前答案

1. **要做什么**：M5 收口前的 v1.0 Linux GA 准备——22 能力域由 24 个插件仓提供，内核保持薄壳调度。
   今天（2026-11-24）截至 01:38 共 **37** 个提交（`git log --since="2026-11-24 00:00" --oneline | wc -l` → `37`；
   11-23 全天 `359`），23:30 之后的增量 **52** 个（`--since="2026-11-23 23:30"`），当前 HEAD **`e172fde`**
   （`git log -1 --format="%h %ad %s"` → 2026-11-24 01:32:42）。今天最后一段集中在三条线：
   **门禁补强**（`make check` 第 17 段交叉编译 / `depth_level` 一致性 / `DIST_SHA_DIFF` / Gitee prune 判序）、
   **权限与降权显式化**（插件降权显式化 / 授予记录层 / 审计保留期清理）、**cron 稳定路径 + 方法名字符集**。
2. **怎么干 / 事实约束**（六条硬边界，动手前先对齐）：
   - **面板必须有登录页**：kore 自有 Web 登录——`POST /api/v1/auth/login`，凭据 = `auth.admin_password_hash`，
     **单管理员、无用户名、非 PAM / 非系统账号**。依据 `docs/DECISIONS/0043-login-gate-vs-passwordless-ops.md`
     头部 **`状态: accepted`**；实现 `a68c4b1`；登录视图 `web/app.js:347-430`（`input.type='password'`，`:367`）。
   - **「免密」只指登录之后的操作**（含 root 特权动作）不再要口令，**不是「不登录」**。
     ADR-0043 §0 用户原话：「面板必须要有登录页面，我是说操作必须免密，也就是 root 权限」。
   - **运行期不得出现本机系统账号密码**（`sudo` / `polkit` / `askpass` 一律禁止）；**只有「壳子安装」一次允许
     sudo**，此后替换自身二进制、重启 / 删除自身 unit 都不再提权。依据 `docs/DECISIONS/0042-privilege-without-prompt.md`
     头部 **`状态: accepted`**；`93d63c7`（`kored upgrade` 非 root 直接 exit 6，不弹口令）。
   - **面板以系统级 root 服务运行**（ADR-0042），特权动作不经 polkit 判定（`e1980a3`，polkit 降为降级路径）。
     但本机**当前主实例是非 root 降级形态**（uid 1000 + `kored-local.service`，见 B.5）——
     不得把降级形态当成等价形态；ADR-0042 的落地缺口见 B.6-2。
   - **插件 UI = 主壳懒加载视图**（ADR-0040 `accepted`，2026-11-23 增补裁决取代裁决40）；**独立 origin iframe +
     postMessage 桥未实现、v1.0 前不补**。`web/app.js:1128-1352` 仍留旧 iframe 渲染代码（`frame.src` 指向
     不存在的 `/plugin-assets/<id>@<ver>/index.html`），服务端无该路由（`grep -rn "plugin-assets" internal/` 仅
     `httpapi/middleware.go:103` 一处注释）。插件 UI 承载面是 `web/<id>.js` 懒加载视图。
   - **`kore_csrf` 非 HttpOnly**（双提交要求前端可读）：`internal/core/httpapi/handlers_auth.go:104`、
     `csrf_local.go:64`（`HttpOnly: false, SameSite=Strict, Path=/`），回归断言 `csrf_login_test.go:74`
     （`kore_session` 必须 HttpOnly、`kore_csrf` 必须非 HttpOnly）。
3. **干到哪了**：见 B 节（发版索引 / 插件能力 / 主壳 / 今日能力与门禁 / 运行态 / 挂账）。
4. **为什么这么定**：
   - **登录门与免密分层** —— ADR-0043（accepted）：ADR-0041 把「操作免密」实现成「本机通道免登录」，
     真机后果是面板没有登录页、未登录也能操作全部管理 API；ADR-0041 现为 `superseded-in-part`（`9b5d4dc`）。
   - **root 提权零交互** —— ADR-0042（accepted）：kored 以系统级 root 服务运行，运行期不做授权判定。
   - **插件 UI 不补分发链** —— ADR-0040（accepted）：24 仓 dist 里 `web/` 命中 0、补链约 3–5 人日，v1.0 前不补。
   - **深度等级以 12/8 为准、随发版收敛** —— ADR-0045（accepted，`docs/PLUGIN-CATALOG.md` §6.1 为 12 生产级 / 8 基础级）。
   - **cron 唤醒路径撤回承诺** —— ADR-0046（`proposed`，决策 B2）：不新增 `kored invoke` 免登录通道，
     收敛到内核 scheduler，文档按 `d696723` 改正。
   - **方法名字符集放宽** —— ADR-0047（accepted）：`methodActionPattern` 接受下划线（`verify_file` 不重命名），
     连字符仍不接受。

### B. 今天的实际状态

#### B.1 发版与索引

唯一事实源：`../kore-plugins/index/plugins.json`（实测 **24** 条）；索引仓 HEAD **`7fa4ca3`**
「第 48 把重签 — app-deploy 0.3.1 / terminal 0.2.1」（`git -C ../kore-plugins log -1 --format="%h %s"`）。
第 48 把证据 `.agents/verify/resign-48.md`（`9b372d2`，明确「未 make build / 未重启 kored」）；公钥未变，
第 16 段双端一致（`3e461a07…`）。

| 插件 @ 索引版本 | 插件 @ 索引版本 |
| --- | --- |
| echo 0.1.4 | site 0.4.3 |
| file 0.3.2 | ssl 0.6.0 |
| integrity 0.4.0 | cron 0.5.0 |
| ssh-guard 0.3.1 | monitor 0.3.0 |
| logs 0.5.1 | dns 0.4.0 |
| runtime-php 0.2.2 | runtime-node 0.2.4 |
| runtime-python 0.3.1 | db-mysql 0.4.1 |
| db-postgres 0.3.3 | redis 0.6.0 |
| backup 0.4.2 | firewall 0.2.6 |
| waf 0.4.4 | container 0.5.4 |
| app-deploy **0.3.1** | terminal **0.2.1** |
| process 0.3.0 | discover 0.3.1 |

#### B.2 插件能力（以各仓 `CHANGELOG.md` 为准）

| 能力 | 版本 | 证据（仓 / 行） |
| --- | --- | --- |
| `container.exec`（固定 argv、非 root 默认、超时夹取 30s、输出截断 256 KiB；`docker.sock` 无权访问由 `E_UNSUPPORTED` 改 `E_NEED_ROOT`） | 0.5.4 | `kore-plugin-container/CHANGELOG.md:3-8` |
| `process.history/trend/watchdog.suggest`（60 点环形缓冲、插件内零 ticker） | 0.3.0 | `kore-plugin-process/CHANGELOG.md:12` |
| `ssh-guard.suggest`（只读 `system:read`，`dry_run` 恒 true；0.3.1 按事实把 `depth_level` 降为 basic） | 0.3.1 | `kore-plugin-ssh-guard/CHANGELOG.md:5-9` |
| `runtime-python` venv / pip（4 方法 + kill 后重试） | 0.3.1 | `kore-plugin-runtime-python/CHANGELOG.md:7` |
| `redis.rename` / `move` / `copy`（默认 nx 防覆盖，>8 MiB 需 confirm） | 0.6.0 | `kore-plugin-redis/CHANGELOG.md:5` |
| `ssl.https.enforce`（期望状态下发 + 审计） | 0.6.0 | `kore-plugin-ssl/CHANGELOG.md:12` |
| `waf` 规则 CRUD（nft 1.1.x 写后回读失败三层兜底；0.4.4 修 `rules.chain` 恒 `null`） | 0.4.4 | `kore-plugin-waf/CHANGELOG.md:1-8` |
| `logs.retention.get/set`（`retention.json` 0600 原子写；补 `tests/fault/clean_test.go`） | 0.5.1 | `kore-plugin-logs/CHANGELOG.md:8-12` |
| `cron.templates`（4 模板，只读不写 crontab） | 0.5.0 | `kore-plugin-cron/CHANGELOG.md:5` |
| `integrity` 结构化变更 + `severity` | 0.4.0 | `kore-plugin-integrity/CHANGELOG.md:13` |
| `app-deploy.upload/upgrade/jobs`（逐条目穿越护栏 + 暂存后 rename） | 0.3.0 | `kore-plugin-app-deploy/CHANGELOG.md:5` |
| `firewall.enable/disable`（走 ADR-0018 root-action，argv 固定） | 0.2.6 | `kore-plugin-firewall/CHANGELOG.md:7` |
| `backup.verify`（6 项 checks，只读 `system:read`） | 0.4.2 | `kore-plugin-backup/CHANGELOG.md:5` |
| `dns` 写路径（快照 → 原子 UPDATE → 直连校验 → journal，失败回滚） | 0.4.0 | `kore-plugin-dns/CHANGELOG.md:55` |
| app-deploy / terminal 补 G-20 故障注入（仅测试与版本，无运行时行为变更） | 0.3.1 / 0.2.1 | 两仓 `CHANGELOG.md` 头部 |

注：索引 `depth_level` 与仓库不一致 8 条（B.6-4），商店按索引显示（`basic`）。

#### B.3 主壳（口径分开写，勿混）

| 指标 | 值 | 命令 / 出处 |
| --- | --- | --- |
| `lazyView(` 调用点数 | **16** | `grep -c "lazyView('" web/shell.js` → `16` |
| `web/*.js` 文件数 | **34** | `ls web/*.js \| wc -l` → `34` |
| 导航项 | **24** | `web/shell.js` NAV_GROUPS 四组 id 合计（ops 5 + biz 5 + res 4 + platform 10） |
| `web/dist` 文件数 | **38** | `ls web/dist \| wc -l` → `38`（其中 `.js` 36 = 34 模块 + 2 语言包） |
| 首屏 gzip | **65,213 B / 307,200 B** | `bash scripts/frontend-check.sh`（对既有 dist；dist mtime 01:32） |
| i18n 增量 gzip | **2,909 B / 3,072 B** | 同上（余量 163 B，贴线） |

注：`Makefile:162` 的 echo 硬编码「37 文件」，`ls web/dist \| wc -l` 实测 **38** —— 一行文案漂移，不影响门禁。

最新视图：服务发现 `discover`（代码 `0cd5dab`，G-28 双端截图 `caa582e`）。
工作区**干净**：`git status --short | wc -l` → `0`。

#### B.4 今天落地的门禁与能力（全部给 commit）

**B.4.1 新增门禁 / 检查（4 条）**

| 门禁 | commit | 关键点 / 证据 |
| --- | --- | --- |
| **第 17 段交叉编译（G-16 真编译）** | `6bd09ee` | `Makefile:350,424-425`：复用 `make cross` 五目标真编译（含 G-16 明文的 windows/amd64 + darwin/arm64），失败贴首个编译错误并阻断。历史缺口正是「只 grep 目标名字、从不编译」。本轮实测 exit 0 / **244 ms**（热缓存） |
| **`presets-check` 的 `depth_level` 一致性 + `out_of_box`** | `45685a2` | `scripts/presets-check.sh:326-377`（索引↔仓库；清单内 WARN、新增不一致 FAIL、陈旧条目 WARN）+ `:470-483`（`out_of_box=true` 不得引用非 production）。清单 `scripts/depth-level-pending.txt` 8 行 |
| **`store-check` 的 `DIST_SHA_DIFF`** | `c569e12`（实现）+ `e172fde`（文档口径同步） | `scripts/store-check.sh:21-30,307-315`：本地 `dist/<id>-<ver>.tar.gz` sha 与索引账本比对，输出 `DIST_SHA_DIFF <id> <ver> index=… dist=…`，**WARN 不阻断**；比对**全部版本**而非只比当前版本（防 0.2.3 野产物在 bump 后漏检）。本轮 `store-check: 24 pass, 0 fail, 0 warn`——本地 161 个 dist 包中，索引账本可对照的全部一致，0 条 `DIST_SHA_DIFF`（索引未记录该版本 / dist 不存在的按设计静默跳过） |
| **`gitee-release-prune.sh` 改按 tag 语义版本判序 + 两道护栏** | `22962bc` | 按 `sort -V` 判序，**不用 `created_at` / release id**（事故 `33088d9`：integrity v0.4.0 版本第 2 新却被误删）；护栏 ① 删除后剩余 == `--keep` ② 被删版本全部严格小于保留集最小版本；同版本多前缀歧义→整仓跳过不删（`scripts/gitee-release-prune.sh:5-22`） |

**B.4.2 关键能力（13 条）**

| 能力 | commit | 关键点 / 证据 |
| --- | --- | --- |
| **登录门恢复**（UDS / loopback 不再免登录） | `a68c4b1` | `withAuth` 删除本机通道跳过分支，`/api/v1/*` 一律会话校验；契约测试反向收紧（`TestLocalChannelsRequireSession` 等） |
| **首启一次性口令** | `3aa7b5c` | 首启自动生成管理员口令：**TTY 打印一次**，非 TTY 只给 CLI 指引（不落盘明文）；`cmd/kored/admin_password.go` |
| **会话 7d + 滑动 + 30d 绝对** | `0cae448` / `72bb463` / `51dde8e` | `internal/core/auth/session.go:26-29`：`DefaultTTL=7d`、`AbsoluteTTL=30d`；`:92`/`:128`/`:166` 夹取绝对上限；`:188` 滑动阈值 `min(24h, ttl/2)` |
| **升级端点装配修复（含编译期断言）** | `db7cf31` | 装配层只写 `daemon.selfUpdate` 无读者 → 升级三端点全 501；补 4 个一行转发 + `var _ httpapi.SelfUpdater = (*daemon)(nil)`（`cmd/kored/serve_upgrade.go:402`）；装配级测试 `TestSelfUpdateEndpointsWiredThroughDaemon` |
| **`kored upgrade` 自升级** | `93d63c7` | `--bin` 只收本地文件 + 必填 `--sha256`；原子替换（tmp → fsync → `.prev` 硬链 → rename → fsync dir）；非 root **exit 6**；`systemctl --no-block restart`（同步 restart 会 SIGTERM 自己） |
| **卸载免 sudo** | `93d63c7` | 先 `disable`+删 unit → `userdel` → purge → 删自身二进制 → **最后** `--no-block` 停自己 |
| **插件卸载 API** | `6142694` | `DELETE /api/v1/plugins/{id}`：停进程 + 删 dist + 移除记录 + 审计（fail-closed）；幂等 200 + `already_absent`（`handlers_plugins_uninstall.go:38,48`） |
| **CSRF 本机补发** | `d553cd1` | `withLocalCSRF`：仅 loopback/UDS + 幂等方法 + 无 `kore_csrf` 时下发；只发令牌不放行请求（`withAuth` 在外层） |
| **`discover` 视图** | `0cd5dab` + `caa582e` | 第 16 个懒加载视图；证据 `.agents/verify/discover-view.md` |
| **商店卸载 UI** | `542f7ae` | 商店与已装插件页接 `DELETE`：二次确认 + 六种结果人话 + 降级 |
| **插件降权显式化** | `a514a90` | `internal/core/supervisor/demote.go:20-36` 新增 `Demotion{Enabled,KernelUID,Reason}`：非 root 必给 `Reason`，不再以「零值 Account」冒充已降权；`/system/info` 暴露 `demotion` 三字段 |
| **权限授予记录层** | `2ccbf0c`（+ `310cc2d` 拆出误带改动） | `internal/core/installer/grant.go`：`granted_capabilities` 写入路径落地（`install:auto` / `upgrade:auto` / `enable:<subject>` / `legacy:backfill`），升级新增能力**记录并告警**、不阻断；`record.go:41-43` 字段 |
| **审计保留期清理** | `8d09b58` | 内置 scheduler 任务 `internal/core/scheduler/auditclean.go`（`retention_seconds` + 单次 ≤1000 条、0 表示不注册）；默认 90 天 `internal/core/config/types.go:188`，校验区间 24h–365d `config/validate.go:159` |
| **cron 稳定路径 + 存量迁移** | `cc1472f`（内核）+ `kore-plugin-cron` `6efaaa3` | installer 维护 `<pluginRoot>/<id>/current -> <version>` 相对链接（`installer/layout.go:17-22`）；插件写 crontab 用 `current/bin/<id>`，`MigrateStaleBinaries` 改写存量条目（`croncore/stablepath.go:207`，`main.go:53`）；`cron.list` 给 `binary_status/binary_note` 让失败可见 |
| **方法名字符集放宽（ADR-0047）** | `512f1a2` | 内核 `internal/core/registry/validate.go:66` 与 SDK `pkg/pluginapi/pluginapitest/infocheck.go:56` **逐字一致**：`^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$`（下划线合法、连字符仍非法）；`docs/PLUGIN-PROTOCOL.md:148-149` 同步 |

补充：`c901e28` 把 `E_NEED_ROOT` 改为系统服务口径 + 前端按 code 分流；`2fc7494` 落 5 仓故障注入方法级审计
（42 个真缺口，含 echo 3 个）；`96d41dd` 把 installer 日志里的业务域词 `cron` 去掉（恢复第 3 段薄壳门禁）；
`3765708` 修三处「文档描述不存在的校验」漂移；`9b372d2` 第 48 把重签证据。

已闭环（旧挂账移除）：`docs/DECISIONS/0028-controlled-file-write.md` 头部为 `accepted`；
ADR-0041 为 `superseded-in-part`（`9b5d4dc`）；`web/.cache/` 已进 `.gitignore:13-15`。

#### B.5 运行态（只报告，不杀进程、不改主配置；01:38 实测）

| 对象 | 事实 |
| --- | --- |
| 主实例 pid / 启动 | **`1387457`**，`2026-11-23 23:24:57`（`ps -o lstart= -p 1387457`） |
| `/proc/1387457/exe` | → `/home/pt/Work/GolandProjects/kore/bin/kored`（无 `(deleted)`），sha256 **`979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997`** |
| `bin/kored` | 同 sha **`97926026…`**，**10,420,386 B**，mtime `2026-11-23 23:21:52` → 运行中与磁盘一致（SHA_MATCH=YES） |
| 运行身份 / cgroup | **uid 1000（非 root）**；`user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service`（systemd `--user`） |
| `GET /-/healthz` | **200** `{"status":"ok"}` |
| 未登录 `GET /api/v1/system/info` | **401** `{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}` → 登录门生效 |
| 未登录 `GET /api/v1/system/upgrade` / `GET /api/v1/audit` | 均 **401**（不是 501 / 200） |
| `GET /` 与登录动作 | **200**（HTML 壳，`#app` 启动占位）；`POST /api/v1/auth/login` 错口令 → **401** `{"code":"E_UNAUTHORIZED","message":"口令错误"}`；登录表单由 `web/app.js:347-430` 渲染 |
| `paths.index_dir` / 商店版本 | **未确认**：被登录门挡住（无管理员口令），本轮未为取证改主配置 |
| systemd 系统 unit | **未安装**：`systemctl status kore` → `Unit kore.service could not be found.`；`/etc/systemd/system/kore.service` 不存在 |
| 插件系统用户 | `getent passwd \| grep -c "^kore-"` → **0** |

**结论**：主实例形态与上一版一致（exe == 磁盘 sha、登录门生效、升级端点 401），但**二进制构建于 23:21:52**，
早于 23:30 之后的全部提交（降权显式化 / 授予记录 / 审计清理 / cron current 链接 / 方法名下划线）——
**这些能力要等下一次 `make build` + 重启才进运行实例**，当前 8787 上验不到。

#### B.6 已知挂账（未闭环，按证据）

1. **升级 / 卸载的真实 systemd 重启链路未实测**：`93d63c7` 的替换 → `systemctl --no-block restart` →
   serve 入口 finalize `pending`→`success` 只有代码 + 单测；本机非 root，`kored upgrade` 直接 `exit 6`，
   验不到正路径。`.agents/verify/kore-upgrade-drill.md` 是**隔离实例换二进制**演练，不是 `kored upgrade`
   命令 + 系统 unit 重启。
2. **系统级 root 服务未真装**：ADR-0042 `accepted`，但 `systemctl status kore` → Unit not found、
   主实例实际是 `user.slice/.../kored-local.service` + uid 1000。**accepted ≠ 已部署**。
3. **插件未真正降权**：`kore-*` 用户数 **0**；非 root 内核下 `Demotion.Enabled=false` 并给 `Reason`
   （`demote.go:20-36`），插件进程与内核同 uid → OS 层隔离为零。root 形态下的 `kore-<id>` 切换只有代码路径。
4. **8 条 `depth_level` 待裁决**（ADR-0045 accepted）：`scripts/depth-level-pending.txt` =
   `container` / `db-postgres` / `dns` / `echo` / `integrity` / `runtime-node` / `runtime-python` / `waf`
   （索引 `basic` vs 仓库 `production`）。ADR-0045 §4.4：**M5 收口时未清零则里程碑不得收口**；
   清零只允许「发版 + 改 `info.json` + 删清单行」，不许改索引迁就仓库 / 只删清单 / 放宽判据。
5. **`tasks` bucket 保留期未实现（承诺已撤销）**：`docs/DATA-MODEL.md:166`、`:327` 明确「预留 bucket，
   当前无写入方 → 不定义保留窗口（不承诺天数）」。审计保留期已落地（B.4.2），**只剩 tasks**。
6. **无 UA / IP 指纹绑定**：`internal/core/auth/` 无 `UserAgent` / `RemoteAddr` 引用；会话只凭 `kore_session`
   cookie。**CSRF 是纯双提交、无会话绑定**（`middleware.go:110-145`；`kore_csrf` 非 HttpOnly，同站脚本可读）。
7. **`echo` 的 3 个 fault 缺口未补（P2）**：`ping` / `slow` / `timeout` 零触及
   （`.agents/verify/fault-method-audit.md:126-148`；全书 42 缺口 = dns 8 / ssl 8 / integrity 5 / site 18 / echo 3）。
8. **cron 存量迁移只在插件被调用时触发**：cron `lifecycle=lazy`（`kore-plugin-cron/info.json:6`），
   `MigrateStaleBinaries` 在插件进程 `main.go:53` 启动时跑——**lazy 未启动则旧 crontab 条目继续跑旧版本**，
   直到下一次 `cron.*` 调用或手动重装。
9. **`kored invoke` 决定不实现（ADR-0046 B2，`proposed`）**：内核无对外非交互调用入口，这是设计选择不是缺口；
   `d696723` 已按 B2 撤回「宿主条目唤醒插件」承诺并改写文档。
10. **插件 UI 分发链未实现**：ADR-0040 裁决 v1.0 前不补；`web/app.js:1131` 的旧 iframe 路径仍指向不存在的
    `/plugin-assets/...`（死代码，服务端无路由）。
11. **能力声明的运行期强制仍为零**：授予记录层已落地（B.4.2），但插件进程自身行为（读文件 / 联网 / exec /
    写 `/etc`）无 seccomp / namespace 强制；`grep -rn "seccomp\|Resource.Apply" internal/ pkg/` 零命中。
    完整盘点 `.agents/verify/perm-system-feasibility.md` §1.1–§1.4（该文件为冻结证据，结论口径已变化处按本行）。
12. **waf 0.4.4 整链真机证据未落本仓**：本仓最新 WAF e2e 仍是 `waf-e2e-043.md`（0.4.3）；0.4.4 的两条修复
    只有插件仓 CHANGELOG 记述 → **未确认**。
13. **Gitee release 只保留最新 5 个**（GitHub 全量）：`scripts/gitee-release-prune.sh` 已修判序 + 双护栏，
    但仍需人工 `--dry-run` 后再真删。

### C. 下一轮建议（≤5 条，按优先级）

| # | 动作 | 为什么（优先级理由） | 验收 |
| --- | --- | --- | --- |
| 1 | 在**真 root + 真 systemd 系统 unit** 装一次机，跑通 `kored upgrade --bin <本地文件> --sha256 <值>` → `--no-block restart` → 新进程 finalize `pending`→`success`，再跑一次自卸载 | 同时收挂账 1+2；ADR-0042 是提权设计地基，现在**零真机正路径证据**；沙箱非 root 直接 `exit 6` | `journalctl -u kore` 有 Started/Stopped；`/proc/<newpid>/exe` sha == 入参；pending→success 可读；卸载后 unit 不存在 |
| 2 | 登录一次后读 `GET /api/v1/system/info`，复核 `paths.index_dir` == `kore-plugins/index` 且商店版本 == 索引 24 条（`7fa4ca3`） | 唯一没取到的验收项；G-29 明确「回切后验数据不验配置」 | `paths.index_dir` 字面相等；商店 24 条版本与索引逐条一致 |
| 3 | 收敛 8 条 `depth_level`：8 仓发版 bump `info.json` → 改索引 → 删 `depth-level-pending.txt` 对应行 | ADR-0045 §4.4 是 **M5 收口硬判据**，带账不得收口；现在 8 条 WARN 是 `presets-check` 唯一的存量噪音 | `bash scripts/presets-check.sh` → 8 warn 归零；`wc -l scripts/depth-level-pending.txt` 只剩注释 |
| 4 | 在 root 内核下验证插件降权：`system/info.demotion.enabled=true` + 插件进程 uid == `kore-<id>` + 失败回滚路径 | 挂账 3 只有代码；产品定位「插件低权运行」当前不可验证 | `ps -o uid= -p <plugin pid>` 为 `kore-<id>`；`getent passwd` 有对应账户；kill 后回滚不残留 |
| 5 | 把 cron 存量迁移从「插件启动」前移到内核升级后主动执行一次（或 installer 升级后唤醒 cron） | 挂账 8：lazy 不启动则旧 crontab 继续跑旧版本，`current` 链接只能救新写入的条目 | 升级 cron 后**不调用** `cron.*`，`crontab -l` 中该插件行已指向 `.../current/bin/cron` |

### D. 本轮「未确认」清单

- 主实例 `paths.index_dir` / 商店版本：`GET /api/v1/system/info` → `401`（登录门生效的副作用），未登录侧取不到；
  本轮**没有**为取值改口令或改主配置。
- `kored upgrade` 正路径（替换 + `--no-block restart` + finalize）与卸载：本机非 root，`exit 6`，**未实测**。
- root 形态下插件降权的实际 uid / 系统用户：`kore-*` 用户数 0，**只有代码路径**。
- 主实例重启后新能力是否按预期生效（降权显式化 / 授予记录 / 审计清理 / current 链接 / 方法名下划线）：
  二进制构建于 23:21:52，**未重启、未复测**。
- waf 0.4.4 端到端行为：本仓无 0.4.4 e2e 报告。
- 24 个插件仓 `CHANGELOG` 条目与 git tag 的逐仓 sha 对应：本轮只核索引版本与 CHANGELOG 条目，未逐仓 `git rev-parse`。
- `docs/FRONTEND.md` §13 十条判据的最新表述：属 `docs-scribe` 写域，本侧未改、未复核原文。
- 另一会话 `docs-scribe` 当前是否仍活动：无进程级 / 会话级证据，**不作结论**。

## 1. 总原则：文件之外无事实

一句话：**会话里说过、但没落进仓库文件的结论，视为不存在。**

- 聊天记录不可检索、不可复现、不会随仓库分发，不能作为任务依据。
- 任何判断、进度、验收结论只要影响后续动作，都必须在同一检查点内写进对应文件（G-23 判断留痕）。
- 文件之间出现矛盾时，以本规范 §2 指定的"唯一事实源"为准，其余文件必须当轮改正，不许两套并行。
- 交接不是"写一段总结给下一个人"，而是"让下一个只读文件的人不需要你再解释"。

## 2. 四问与回答它们的文件

| 问题 | 唯一事实源 | 辅助文件 |
| --- | --- | --- |
| 要做什么、凭什么叫完成 | [BOARD.md](BOARD.md)（任务行的 `subject` / `scope` / `status` / `blocked_by` / `evidence` / `revision`；跨仓库登记在「变更集登记区」） | `docs/` 对应领域文档与 ADR |
| 怎么干（流程、门禁、角色） | [WORKFLOW.md](WORKFLOW.md)（Kore Loop 七阶段与阶段收口）· [QUALITY-GATES.md](QUALITY-GATES.md)（G1–G19 / G-28–G-30 的命令与执行者）· [ROLES.md](ROLES.md)（6 个角色、写域、不可兼任） | 根 [AGENTS.md](../AGENTS.md) 的硬门禁表 |
| 干到哪了（进展与证据） | [BOARD.md](BOARD.md) 的任务状态 + [LOG/DISPATCH.md](LOG/DISPATCH.md)（派发与回填）+ [verify/](verify/)（验收报告与截图） | [JOURNAL.md](JOURNAL.md) 的里程碑记录；`LOG/sessions/` 的会话摘要 |
| 为什么这么定 | [LOG/DECISIONS.md](LOG/DECISIONS.md)（多选一决策，**含被否决的选项与依据**） | [JOURNAL.md](JOURNAL.md) 复盘；`docs/DECISIONS/` 的 ADR 原文 |

补充映射：

- **流程如何落地**：[LOG/README.md](LOG/README.md) 解释 DECISIONS / DISPATCH / sessions 三者分工。
  "状态看 BOARD、判断看 DECISIONS、派发看 DISPATCH、教训看 JOURNAL"——四者不互相替代。
- **产物长什么样**：[templates/](templates/) 提供任务卡、验收报告、评审单骨架；新写文件先套模板。
- **不可逆选择**：架构 / 协议 / 预算 / 范围类决定必须进 `docs/DECISIONS/` 的 ADR，
  并在 [LOG/DECISIONS.md](LOG/DECISIONS.md) 记一行索引与被否方案。

## 3. 硬约束

以下每条都以"第三方只读文件能否复现"为判据，违反即交接失败。

1. **判断必须落文件**：多选一决定（架构 / 协议 / 预算 / 范围 / 门禁）写进
   [LOG/DECISIONS.md](LOG/DECISIONS.md)，写清被否决选项及否决依据；只写在会话里不算数。
2. **完成判定必须可复现**：声称"完成"必须给出 `命令原文 + 退出码 + 关键输出`（G-07）。
   没有输出的"应该没问题"不成立；接口 200、DOM 断言、设计稿都不能替代规定证据（G-28 对 UI 要求双端截图）。
3. **证据冻结**：[verify/](verify/) 下的报告与截图是历史证据，不改写、不删减；
   发现错误只能新增报告并注明"取代某份"，旧文件保持原样。明文凭据一律 `***`（G-30）。
4. **未证明必须单列**：证据报告必须有"已证明 / 未证明"两栏，未验证项不得写成已通过。
   单测覆盖不等于真机验证，前者只能写在"已证明"的对应粒度里。
5. **写域不重叠**：同一层并行任务的 `scope` 不得相交（G-08）；不改别人写域内的文件，
   确需扩大写域先回到拆解阶段重画，不在执行中偷偷扩。
6. **运行态资产不手改**：`.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、运行中的 `bin/kored`
   属运行态（G-29）。测试要不同配置 / 索引 / 状态，必须起隔离实例（独立 `--config`，state / run / log 落 `/tmp`）。
7. **跨仓库要登记变更集**：一次改动跨多个仓库，必须在 [BOARD.md](BOARD.md) 登记 `CS-<YYYYMMDD>-<序号>`，
   写清各仓库 commit / tag 与合并顺序（G-15），否则不算完成。
8. **交接必须自包含**：交接卡片（§4）里的"下一步"是可直接执行的动作（命令或明确的文件改动），
   不是"继续优化"这类无法验收的描述。

## 4. 交接卡片（模板）

每笔任务在 [BOARD.md](BOARD.md) 行内或任务卡里附一张卡片，六格缺一不可：

| 字段 | 填写要求 |
| --- | --- |
| 目标 | 一句话、动词开头，与 BOARD `subject` 逐字一致 |
| 写域 | 允许改动的文件 / 目录前缀，逗号分隔；跨仓库写仓库名 |
| 验收命令 | 可复制执行，注明期望退出码与关键输出特征 |
| 当前状态 | BOARD `id` + `status` + `revision`；最后一笔 commit 短 sha |
| 下一步 | 单条动作（一条命令或一处文件改动），做完即可进入下一状态 |
| 已知坑 | 失败过的尝试、不得重试的路径、外部依赖（如 root / systemd / 索引重签） |

卡片示例（只写事实，不写鼓励语）：

```text
目标: 修复 CORE §2.13 提权 argv 与代码不一致
写域: docs/CORE.md, internal/core/privilege/, .agents/verify/
验收: make check（期望 exit 0）; go test -timeout 200s ./internal/core/privilege/（期望 ok）
状态: M5-PRIV status=completed revision=3 · commit=eb08d41
下一步: 无；若发现 PLUGIN-PROTOCOL 漂移，同笔补文档并重跑 make docs-check
已知坑: sandbox 内 sudo 被 NoNewPrivs 拒绝，真 root 验证须在 systemd user unit 内执行
```

## 5. 接手后的动作清单

按顺序做，不要跳步：

1. 读 [../AGENTS.md](../AGENTS.md) 的"读前必知"与硬门禁表，建立红线概念。
2. 读 `docs/VISION.md` 与 `docs/ARCHITECTURE.md`，确认做什么、不做什么。
3. 读 [WORKFLOW.md](WORKFLOW.md)、[QUALITY-GATES.md](QUALITY-GATES.md)、[ROLES.md](ROLES.md)。
4. 打开 [BOARD.md](BOARD.md)，只看当前里程碑的 `in_progress` / `blocked` 行；`completed` 行只在需要追溯时看。
5. 读 [LOG/DISPATCH.md](LOG/DISPATCH.md) 最近若干行，确认最后派发与回填；读 `LOG/sessions/` 最近一份会话摘要。
6. 跑 `git log --oneline -10` 与 `git status --short`，核对 BOARD 最后一笔 commit 是否在历史里、
   工作区是否有他人未提交改动（有则先弄清归属，不覆盖）。
7. 跑 `make check` 建立基线；源码就绪后加跑 `make vet` 与 `make test`。
8. 确认没有"改到一半"的痕迹：临时 worktree / 分支（`make wt-check`）、被改动的运行态配置、
   半成品证据文件。发现即先记录再处理，不静默清理。

## 6. 交付前自检

交接或声明完成之前逐项核对：

- [ ] 任务行 `status` / `revision` / `evidence` 已回填，`evidence` 含命令、退出码、关键输出。
- [ ] 影响后续动作的判断已进 [LOG/DECISIONS.md](LOG/DECISIONS.md)（含被否决选项）。
- [ ] 派发与回填已进 [LOG/DISPATCH.md](LOG/DISPATCH.md) 同一行，未另开重复行。
- [ ] 证据文件在 [verify/](verify/) 且链接可达（`make docs-check` 会校验相对链接）。
- [ ] 未证明项已单列，未被写成已通过。
- [ ] 运行态资产未被顺手改动；临时实例与临时文件已清理。
- [ ] 文档与代码一致（路径 / 协议 / 预算数字 / 角色名，G-06），无"文档说 A、代码做 B"。
- [ ] 工作区只剩本轮该留的改动；他人未提交改动、旧轮证据与截图原样保留并说明原因。

## 7. 反模式

| 反模式 | 后果 | 正确做法 |
| --- | --- | --- |
| 结论只留在会话里 | 换会话即失忆，同一问题反复讨论 | 当轮写进 DECISIONS / BOARD / 证据文件 |
| 用"应该没问题"代替命令输出 | 完成判定不可复现，回归无人知晓 | 贴命令 + 退出码 + 关键输出 |
| 证据报告只写成功路径 | 未验证项被误当已通过 | "已证明 / 未证明"两栏并列 |
| 直接改主实例配置做测试 | 主实例读到旧数据，线上行为漂移 | 起隔离实例，主配置不动 |
| 跨写域顺手改别人文件 | 与并行任务冲突，回滚代价高 | 回到拆解阶段重画 `scope` |
| 改动攒到最后一起提交 | 中途失败无法回退到自洽点 | 一处自洽即提交 |
| 交接只写"已完成 80%" | 下一个人不知道剩下 20% 是什么 | 写清下一步的单条可执行动作 |

本规范不新增 G 编号门禁：它约束的是"记录与交接"的写法，执行判据仍以上表引用的
[QUALITY-GATES.md](QUALITY-GATES.md) 与根 [AGENTS.md](../AGENTS.md) 为准。
