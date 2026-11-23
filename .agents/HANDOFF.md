# .agents · 交接规范（Handoff）

> 状态: active · 归属: scribe · 更新: 2026-11-23 · 里程碑: M0–M5

任何人或 AI 在本仓库中断后接手（换模型、换会话、换人、隔天回来），只读仓库文件就必须回答四问：
**要做什么、怎么干、干到哪了、为什么这么定**。这份规范定义这四问分别由哪些文件回答，以及
"什么才算落过文件"。

## 0. 当前交接快照（2026-11-23 晚 23:30）

> 本节是「今天真实状态」的增量快照，§1–§7 的规范与卡片模板不变。
> 每条附命令 / `file:line` / commit；查不到的写「未确认」，不写推测。
> 上一版快照为 21:45；本版只写此后**重新核实过**或**已发生变化**的事实，未变的部分沿用并标注口径。

### A. 四问当前答案

1. **要做什么**：M5 收口前的 v1.0 Linux GA 准备——22 能力域由 24 个插件仓提供，内核保持薄壳调度。
   今天（2026-11-23）共 **344** 个提交（`git log --since="2026-11-23 00:00" --oneline | wc -l` → `344`），
   当前 HEAD **`10f3834`**（`git log -1 --format="%h %s"`）。今天最后一段（21:45 之后）集中在三条线：
   **登录门恢复与「操作免密」分层**、**内核自升级 / 卸载免 sudo**、**面板升级端点装配修复**。
2. **怎么干 / 事实约束**（五条硬边界，动手前先对齐）：
   - **面板必须有登录页**：登录是 kore 自己的 Web 登录体系——`POST /api/v1/auth/login`，凭据 =
     `auth.admin_password_hash`，**单管理员、无用户名、非 PAM / 非系统账号**。
     依据 `docs/DECISIONS/0043-login-gate-vs-passwordless-ops.md` 头部 **`状态: accepted`** 与 §1 决策表；
     实现 `a68c4b1`。
   - **「免密」只指登录之后的操作**（含 root 特权动作）不再要口令，**不是「不登录」**。
     ADR-0043 §0 用户原话：「面板必须要有登录页面，我是说操作必须免密，也就是 root 权限」。
   - **运行期不得出现本机系统账号密码**（`sudo` / `polkit` / `askpass` 一律禁止）；
     **只有「壳子安装」一次允许 sudo**，此后替换自身二进制、重启 / 删除自身 unit 都不再提权。
     依据 `docs/DECISIONS/0042-privilege-without-prompt.md` 头部 **`状态: accepted`**；`93d63c7` 提交信息。
   - **面板以系统级 root 服务运行**（ADR-0042），特权动作**不经 polkit 判定**（`e1980a3`，polkit 规则降为降级路径）。
     非 root 形态是 **ADR-0018 的显式降级形态**，必须在文档与验收里标出，不得当成等价形态
     （代码注释原话：`internal/core/supervisor/demote.go:29-31`「返回零值 Account 表示未启用降权」）。
   - **两个 DSH 会话并行在同一 `kore` 工作树**：另一会话 agent 名 `docs-scribe`，拥有 `AGENTS.md` /
     `docs/DECISIONS/0027-*` / `docs/FRONTEND.md` 的**图表规范条款**；本侧不得回滚那三处。
     依据 `.agents/JOURNAL.md:900-901`：这些提交来自用户另一个会话在**同一工作树**并行工作，
     工作区 git 身份统一为 `pengtang1024`，`git show` 的 author 无法区分 agent。
     图表口径：**工程判据为准、ECharts5 首选但非硬指标**，G-32 判「是否满足 `docs/FRONTEND.md` §13
     十条判据」而非「是否用 ECharts」。
3. **干到哪了**：见 B 节（今日落地能力 / 发版索引 / 主壳 / 运行态 / 挂账）。
4. **为什么这么定**：
   - **登录门与免密分层** —— `docs/DECISIONS/0043-login-gate-vs-passwordless-ops.md`（accepted）：
     ADR-0041 把「操作免密」实现成了「本机通道免登录」，真机后果是面板打开**没有登录页**、
     未登录也能操作全部管理 API；ADR-0043 更正为「登录一次，之后所有动作（含 root）免密」。
   - **root 提权零交互** —— `docs/DECISIONS/0042-privilege-without-prompt.md`（accepted）：
     kored 以系统级 root 服务运行，运行期不做授权判定；这样才满足「只有安装一次 sudo」。
   - **插件 UI 不补分发链** —— `docs/DECISIONS/0040-plugin-ui-distribution.md`（accepted，2026-11-23 增补裁决）：
     24 仓 dist 里 `web/` 命中为 0、内核无 `/plugin-assets/` 路由、补链约 3–5 人日，v1.0 前不补；
     插件 UI = 主壳视图。证据 `.agents/verify/plugin-ui-delivery.md`。
   - **升级 / 备份口径** —— `docs/OPERATIONS.md`；**发版窗口冻结 + tag 钉 sha** —— `docs/RELEASE.md` §2.1
     （`kore-plugin-waf v0.4.1` tag 与资产不同树事故的机制化修正）。

### B. 今天的实际状态

#### B.1 发版与索引

唯一事实源：`../kore-plugins/index/plugins.json`（实测 **24** 条，`schema_version` + `plugins[]`）；
索引仓 HEAD **`fbbec78`**「第 47 把重签 — ssh-guard 0.3.1 / container 0.5.4 / waf 0.4.4 / logs 0.5.1」
（`git -C ../kore-plugins log -1 --format="%h %s"`）。21:45 时的第 46 把 `80e2611` 已被本轮覆盖。

| 插件 @ 索引版本 | 插件 @ 索引版本 |
| --- | --- |
| echo 0.1.4 | site 0.4.3 |
| file 0.3.2 | ssl 0.6.0 |
| integrity 0.4.0 | cron 0.5.0 |
| ssh-guard **0.3.1** | monitor 0.3.0 |
| logs **0.5.1** | dns 0.4.0 |
| runtime-php 0.2.2 | runtime-node 0.2.4 |
| runtime-python 0.3.1 | db-mysql 0.4.1 |
| db-postgres 0.3.3 | redis 0.6.0 |
| backup 0.4.2 | firewall 0.2.6 |
| waf **0.4.4** | container **0.5.4** |
| app-deploy 0.3.0 | terminal 0.2.0 |
| process 0.3.0 | discover 0.3.1 |

#### B.2 插件能力（以各仓 `CHANGELOG.md` 为准）

| 能力 | 版本 | 证据（仓 / 行） |
| --- | --- | --- |
| `container.exec`（固定 argv、非 root 默认、超时夹取 30s、输出截断 256 KiB；0.5.4 起 `docker.sock` 无权访问由 `E_UNSUPPORTED` 改 `E_NEED_ROOT`） | 0.5.4 | `kore-plugin-container/CHANGELOG.md:3-8` |
| `process.history/trend/watchdog.suggest`（60 点环形缓冲、插件内零 ticker） | 0.3.0 | `kore-plugin-process/CHANGELOG.md:12` |
| `ssh-guard.suggest`（只读 `system:read`，`dry_run` 恒 true；0.3.1 把 `depth_level` 由 production **按事实降为 basic**，G-20） | 0.3.1 | `kore-plugin-ssh-guard/CHANGELOG.md:5-9` |
| `runtime-python` venv / pip（4 方法 + kill 后重试） | 0.3.1 | `kore-plugin-runtime-python/CHANGELOG.md:7` |
| `redis.rename` / `move` / `copy`（默认 nx 防覆盖，>8 MiB 需 confirm） | 0.6.0 | `kore-plugin-redis/CHANGELOG.md:5` |
| `ssl.https.enforce`（期望状态下发 + 审计） | 0.6.0 | `kore-plugin-ssl/CHANGELOG.md:12` |
| `waf` 规则 CRUD（nft 1.1.x 写后回读失败的三层兜底；0.4.4 修 `rules.chain` 恒 `null` 导致内置徽标 / 删除禁用永不生效） | 0.4.4 | `kore-plugin-waf/CHANGELOG.md:1-8` |
| `logs.retention.get/set`（落 `retention.json` 0600 原子写；0.5.1 补 `tests/fault/clean_test.go` 故障注入） | 0.5.1 | `kore-plugin-logs/CHANGELOG.md:8-12` |
| `cron.templates`（4 模板，只读不写 crontab） | 0.5.0 | `kore-plugin-cron/CHANGELOG.md:5` |
| `integrity` 结构化变更 + `severity` | 0.4.0 | `kore-plugin-integrity/CHANGELOG.md:13` |
| `app-deploy.upload/upgrade/jobs`（逐条目穿越护栏 + 暂存后 rename） | 0.3.0 | `kore-plugin-app-deploy/CHANGELOG.md:5` |
| `firewall.enable/disable`（走 ADR-0018 root-action，argv 固定） | 0.2.6 | `kore-plugin-firewall/CHANGELOG.md:7` |
| `backup.verify`（6 项 checks，只读 `system:read`） | 0.4.2 | `kore-plugin-backup/CHANGELOG.md:5` |
| `dns` 写路径（快照 → 原子 UPDATE → 直连校验 → journal，失败回滚） | 0.4.0 | `kore-plugin-dns/CHANGELOG.md:55`（测试证据行） |

#### B.3 主壳（两个口径分开写，勿混）

| 指标 | 值 | 命令 / 出处 |
| --- | --- | --- |
| `lazyView(` 调用点数 | **16** | `grep -c "lazyView('" web/shell.js` → `16`（23:29 实测；上一版 15，+1 = discover） |
| `web/*.js` 文件数 | **34** | `ls web/*.js \| wc -l` → `34`（上一版 33，+1 = `web/discover.js`，28,844 B） |
| 导航项 | **24** | `web/shell.js:67-71` 四组 id 合计（ops 5 + biz 5 + res 4 + platform **10**，platform 新增 `discover`） |
| 视图模块数（构建口径） | **未确认** | 需 `make frontend` 才出数；本轮写域只允许改本文件，未重建前端产物（上一版实测 21） |
| 首屏 gzip | **未确认** | 同上，未重建；最后一次留存证据 `.agents/verify/appdeploy-view-ui.md:165` → `62710 字节`（预算 307200） |
| i18n 增量 gzip | **未确认** | 同上，未重建；上一版快照记 2,988 B / 3,072 B，本轮未复测 |

最新视图：服务发现 `discover`（代码 `0cd5dab`，G-28 双端截图 `caa582e`）。
工作区**干净**：`git status --short | wc -l` → `0`（上一版记录的 `web/appdeploy.js` / `web/store.js` 未提交改动已被提交，
现在不再需要归因确认）。

#### B.4 今天落地的关键能力（21:45 之后这一段，全部给 commit）

| 能力 | commit | 关键点 / 证据 |
| --- | --- | --- |
| **登录门恢复**（UDS / loopback 不再免登录） | `a68c4b1` | `withAuth` 删除本机通道跳过分支，所有 `/api/v1/*` 一律会话校验；`defaultCapabilityResolver` 只认 `kore_session`；`local_access.go` 收窄为通道识别（只供 CSRF 引导 / UDS 豁免）。依据 ADR-0043。契约测试是**反转**而非放宽：`TestLocalChannelsRequireSession` / `TestLocalCSRFPolicy` / `TestLocalGETBootstrapsCSRF` |
| **首启一次性口令** | `3aa7b5c` | 首次启动自动生成管理员口令：**TTY 下打印一次**，非 TTY 只给 CLI 指引（不落盘明文）。`cmd/kored/admin_password.go` 增改 96 行 |
| **会话 7d + 滑动 + 30d 绝对** | `0cae448`（7d + 滑动）、`72bb463`（阈值改 `min(24h, ttl/2)` 消除短 TTL 写放大）、`51dde8e`（文档同步） | `internal/core/auth/session.go:26-29`：`DefaultTTL = 7 * 24 * time.Hour`、`AbsoluteTTL = 30 * 24 * time.Hour`；`:92`/`:128`/`:166` 三处夹取绝对上限 |
| **升级端点装配修复（含编译期断言）** | `db7cf31` | 装配层只把实现写入 `daemon.selfUpdate` 而**无读者** → `httpapi` 对 `Backend` 类型断言失败 → `GET/POST /system/upgrade`、`jobs/{id}`、`rollback` **全 501**。补 4 个一行转发 + **编译期断言** `var _ httpapi.SelfUpdater = (*daemon)(nil)`（`cmd/kored/serve_upgrade.go:402`）；装配级测试 `TestSelfUpdateEndpointsWiredThroughDaemon`（旧装配下实测失败） |
| **`kored upgrade` 自升级** | `93d63c7` | `--bin` 只收本地文件（拒绝 URL）+ 必填 `--sha256` 先校验再替换；原子替换（tmp → fsync → 硬链 `.prev` → rename → fsync dir）；`--rollback` / `--verify`；非 root 直接拒绝 **exit 6**（不弹口令、不静默）；`systemctl --no-block restart`（同步 restart 会 SIGTERM 自己造成「假失败」） |
| **卸载免 sudo** | `93d63c7` | root 服务自卸载顺序：先 `disable`+删 unit → `userdel` → purge → 删自身二进制 → **最后** `--no-block` 停自己（先停会杀自己导致删一半） |
| **插件卸载 API** | `6142694` | `DELETE /api/v1/plugins/{id}`：停进程 + 删 dist + 移除记录 + 审计；审计 fail-closed；幂等 200 + `already_absent`；路径穿越双层防护 |
| **CSRF 本机补发** | `d553cd1` | `withLocalCSRF`：**仅** loopback/UDS + 幂等方法 + 无 `kore_csrf` 时下发，令牌进程内稳定；远程不下发、跨站伪造 POST 仍 401（`csrf_local_test.go` 覆盖）。注意它**只发令牌不放行请求**（`withAuth` 在 `withCSRF` 内层） |
| **`discover` 视图** | `0cd5dab`（代码）、`caa582e`（G-28 双端截图） | 主壳第 16 个懒加载视图（`web/shell.js:605`），接手并补完中断的半成品；证据 `.agents/verify/discover-view.md` |
| **商店卸载 UI** | `542f7ae` | 商店与已装插件页接 `DELETE` 卸载：二次确认 + 六种结果人话 + 降级 |
| **四个插件新版本已入索引** | 索引仓 `fbbec78`（第 47 把重签） | ssh-guard 0.3.1 / container 0.5.4 / waf 0.4.4 / logs 0.5.1（见 B.1 / B.2） |

已闭环（上一版挂账移除）：`docs/DECISIONS/0028-controlled-file-write.md` 头部现为 **`状态: accepted`**
（一期，2026-11-23，边界与二期条件见文末「实施记录」），不再是 `proposed` 与实现不一致。

#### B.5 运行态（只报告，不杀进程、不改主配置；23:29-23:30 实测）

| 对象 | 事实 |
| --- | --- |
| 主实例 pid | **`1387457`**（`/home/pt/Work/GolandProjects/kore/bin/kored serve --config .../.kore-local.yaml`） |
| 启动时刻 | `2026-11-23 23:24:57`（`ps -o lstart= -p 1387457`）；采样时已运行 4 分钟 |
| `/proc/1387457/exe` | → `/home/pt/Work/GolandProjects/kore/bin/kored`（**无 `(deleted)`**），sha256 **`979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997`** |
| `bin/kored` | 同一 sha256 **`97926026…`**，**10,420,386 B**，mtime `Nov 23 23:21` → **运行中与磁盘一致（SHA_MATCH=YES）** |
| 运行身份 | **uid 1000（非 root）**（`/proc/1387457/status` → `Uid: 1000`；`Name: kored`） |
| cgroup | `user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service`（**systemd `--user` unit，非系统级**） |
| `GET /-/healthz` | **200**，`{"status":"ok"}` |
| 未登录 `GET /api/v1/system/info` | **401** + `{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}` → **登录门已生效** |
| 未登录 `GET /api/v1/system/upgrade` | **401**（不是 501）→ `db7cf31` 装配修复已进二进制 |
| 未登录 `GET /` | **200**（登录页可加载，`input[type=password]` 1 个） |
| `paths.index_dir` | **未验证**：需登录才可读（ADR-0043 后本机不再有免登录旁路）；旁证 `.kore-local.yaml` 未被改动 |
| `/tmp` 隔离实例 | **无残留**：`pgrep -af "kored serve"` 只剩 pid `1387457`（上一版记的 3 个已清） |
| systemd 系统 unit | **未安装**：`systemctl status kore` → `Unit kore.service could not be found.`；`/etc/systemd/system/kore.service` 不存在 |

结论：**主实例已跑在最终形态**（运行 exe 与磁盘同 sha，登录门 / 登录页 / 升级端点 401 三项均在 8787 取证）。
验收原文见 `.agents/verify/final-restart.md`（commit `10f3834`，含双端登录页截图）。唯一没取到的是 `index_dir`（被登录门挡住）。

#### B.6 已知挂账（今天仍未闭环）

1. **升级 / 卸载的真实 systemd 重启链路未实测**：`93d63c7` 的替换 → `systemctl --no-block restart` →
   serve 入口 finalize `pending`→`success` 这条链只有**代码 + 单测**（`cmd/kored/upgrade_test.go` 10 个、
   `privilege/selfmanage_test.go` 3 个），**没有一次真机重启取证**——沙箱非 root，`kored upgrade` 会直接
   `exit 6` 拒绝，验不到正路径。
2. **系统级 root 服务未真装**：ADR-0042 已 `accepted`，但本机 `systemctl status kore` → `Unit kore.service
   could not be found.`、`/etc/systemd/system/kore.service` 不存在；主实例实际跑的是
   `user.slice/.../kored-local.service` + **uid 1000**。ADR-0042 自己写明了这条边界，**别把 accepted 当已部署**。
3. **插件未真正降权**：`getent passwd | grep -c "^kore-"` → **0**；非 root 形态下
   `internal/core/supervisor/demote.go:29-31` 直接返回零值 `Account`，**插件进程与内核同 uid（1000）**，
   OS 层隔离为零。「每插件一个 `kore-<id>` 系统用户」只在 root 内核下才发生。
4. **权限系统：`capabilities` 已声明但无授予记录、无运行期强制**：
   - 声明 + 语法校验齐（`internal/core/registry/validate.go:41-50,124-198`）；
   - **授予记录 `granted_capabilities` 不存在写入路径**（只有 JSON 字段声明与注释），
     而 `docs/SECURITY.md:129` / `docs/PLUGIN-PROTOCOL.md:119` 称「启用时用户确认并写入」——文档说了、代码没做；
   - 插件**进程自身行为**（读文件 / 联网 / exec / 写 `/etc`）零强制：`pkg/pluginapi/` 全目录无 `Capabilit` 字样，
     无 seccomp / namespace，`platform.Resource.Apply` 全仓零调用。
   完整盘点与证据见 `.agents/verify/perm-system-feasibility.md` §1.1–§1.4。
5. **`tasks` / `audit` 的保留期清理代码未实现**：`docs/DATA-MODEL.md:291` 已显式标注「上述自动清理**尚未实现**」
   ——`tasks` bucket 只有建库定义无读写方（`internal/core/store/store.go:49`、`:60`），`audit` 只有
   `ForEach` 读取路径（`internal/core/store/audit.go:155`）、无按龄删除；全仓 `grep -rn "retention" internal/core/`
   （排除测试）**零命中**。文档里那两行的保留窗口是**目标**不是现状。
6. **无 UA / IP 指纹绑定**：会话只凭 `kore_session` cookie，不绑 UA / IP；`User-Agent` 仅用于**审计记录**
   并截断到 100 字符（`internal/core/httpapi/audit_http.go:259`），`RemoteAddr` 只用于通道识别与 IP 脱敏
   （`local_access.go:64-71`、`audit_http.go:231`）。
7. **最小空闲超时 300s 未进配置校验**：`idle_timeout_s` 的校验区间是 **60–1800s**
   （`internal/core/registry/validate.go:27-28`），没有任何 300s 下限；`docs/PLUGIN-PROTOCOL.md:77` 的口径是
   「配置可设 60–1800，需 300s 语义时显式配置」——即 300s 是**建议值**，不是门禁值。
8. **ADR-0041 仍标 `proposed`，但其核心决策已被 ADR-0043（accepted）推翻**：
   `docs/DECISIONS/0041-passwordless-server-admin.md` 头部 `ADR 状态: proposed`，而 ADR-0043 §0/§1 明确
   「ADR-0041 把操作免密实现成免登录，是对需求的误读」。**状态未标 superseded**，读者会以为是待裁决项（G-06）。
9. **插件 UI 分发链未实现**：ADR-0040 裁决 v1.0 前不补；`web/app.js` 的 `frame.src` 仍指向不存在路径。
10. **`kored install --scenario` 只解析不落库**：`cmd/kored/install.go:62-65` 直接回 `E_UNSUPPORTED`
    （「场景预设归 M2，不假装成功」）；`--package` 才是真装路径。
11. **waf 0.4.4 整链真机证据未落本仓**：0.4.4 的两条修复（`rules.chain` 恒 `null`、内置徽标永不生效）
    在插件仓 CHANGELOG 记为由真机 e2e 抓出，但 `.agents/verify/` 里最新 WAF e2e 仍是 `waf-e2e-043.md`（0.4.3）。
    → 0.4.4 的端到端证据**未确认**。
12. **Gitee release 只保留最新 5 个**（GitHub 全量）；超出用 `scripts/gitee-release-prune.sh` 先 `--dry-run`。
13. ~~`web/.cache/` 未被忽略~~ **已闭环**：`.gitignore:13-15` 现有 `web/dist/` 与 `web/.cache/`
    （注释「前端构建缓存…生成物不入库」）。`/tmp` 隔离实例本轮实测**已无残留**（见 B.5），
    但这是**人工清理**的结果，不是机制——后续再起隔离实例仍需人收。

### C. 下一轮建议（≤5 条，按优先级）

| # | 动作 | 为什么（优先级理由） | 验收 |
| --- | --- | --- | --- |
| 1 | 在**真 root + 真 systemd 系统 unit** 环境装一次机，跑通 `kored upgrade --bin <本地文件> --sha256 <值>` → `--no-block restart` → 新进程 finalize `pending`→`success`，再跑一次自卸载 | 同时收挂账 1+2。ADR-0042 是整个提权设计的地基，今天只有代码 + 单测，**零真机正路径证据**；沙箱非 root 直接 `exit 6`，验不到 | `journalctl -u kore` 有 `Started`/`Stopped` 各一次；`/proc/<newpid>/exe` sha == `--sha256` 入参；pending→success 状态可读；`/etc/systemd/system/kore.service` 卸载后不存在 |
| 2 | 登录一次后读 `GET /api/v1/system/info`，复核 `paths.index_dir` == `kore-plugins/index` 且商店版本 == 索引 24 条 | 这是唯一没取到的验收项（被登录门挡住）。G-29 明确「回切后验数据不验配置」，只读 `.kore-local.yaml` 不算复核 | `paths.index_dir` 字面等于 `kore-plugins/index`；商店返回的 24 条版本与 `fbbec78` 索引逐条一致 |
| 3 | 裁决权限语义：**改语义**（拆字段 / 改名）还是**加一层**（保留入站语义 + 新增「插件所需能力」）；裁决后补 `granted_capabilities` 写入路径，或把 `docs/SECURITY.md:129` / `docs/PLUGIN-PROTOCOL.md:119` 的承诺删掉 | 现在文档写「启用时用户确认并写入 `plugins` bucket」，代码里**没有写入路径**——这是 G-06 硬伤；且 20/24 插件声明 `system:admin`，语义反用（它表达的是「调用方要 admin」） | 二选一落地：要么 `granted_capabilities` 有写入 + 有测试，要么文档删承诺；`make docs-check` exit 0 且 `grep granted_capabilities` 与文档口径一致 |
| 4 | 实现 `tasks` / `audit` 的按龄清理（或把 `docs/DATA-MODEL.md` 那两行保留窗口从表格移出，只留「目标」） | 文档已自己标注「尚未实现」，但表格仍列着具体保留天数，读者会当成现状。`tasks` bucket 甚至无读写方 | `grep -rn "retention" internal/core/` 有命中且接上调度；或表格改为「未实现」且无具体天数 |
| 5 | ① `docs/DECISIONS/0041-*` 头部改标 `superseded by 0043`；② 给 waf 0.4.4 补一次整链 e2e（规则 CRUD → nft 回读 → 回滚）落 `.agents/verify/` | ① 0041 仍 `proposed`，但它的核心决策已被 accepted 的 0043 推翻，读者会误以为待裁决；② 0.4.4 修复来自真机 e2e，但本仓最新 WAF 证据仍是 0.4.3，交付无法复现 | ① 0041 头部状态与 0043 引用互指，`make docs-check` exit 0；② 新报告含命令 + 退出码 + nft 规则回读原文 |

### D. 本轮「未确认」清单

- 主实例实际 `paths.index_dir` / 商店版本：`GET /api/v1/system/info` 返回 `401 E_UNAUTHORIZED`（登录门生效的副作用），
  未登录侧取不到；本轮**没有**为取这个值去改口令或改主配置。
- 首屏 gzip / 视图模块数 / i18n 增量：需 `make frontend` 重建 `web/dist` 才出数，而本轮写域只允许 `.agents/HANDOFF.md`
  → **未重建、未复测**；文中数值是上一版留存证据，不是当前值。
- `kored upgrade` 的正路径（替换 + `--no-block restart` + finalize）与 systemd 重启结果：本机非 root，命令直接 `exit 6`，
  **未实测**（见挂账 1）。
- 插件降权在 root 形态下的实际 uid / 系统用户：本机 `kore-*` 用户数为 0，**只有代码路径，无运行证据**。
- waf 0.4.4 的端到端行为：本仓无 0.4.4 的 e2e 报告（最新为 `waf-e2e-043.md`）。
- 各插件 `CHANGELOG.md` 条目与 git tag 的逐仓 sha 对应关系：本轮只核了索引版本与 CHANGELOG 条目，
  未逐仓 `git rev-parse` 对齐 tag。
- `docs/FRONTEND.md` §13 十条判据的最新表述：属 `docs-scribe` 写域，本侧未改、未复核原文。
- 另一会话 `docs-scribe` **当前是否仍在活动**：只能从 `JOURNAL.md:900-901` 的历史与工作区状态（现在干净）推断，
  无进程级 / 会话级证据，**不作结论**。

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
