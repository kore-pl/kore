# UI P1 独立验收报告（G-09 / task-115）

> Verifier：`ui-p1-verifier`（独立于 implementer `ui-p1`，G-09 角色不兼任）｜2026-11-26
> 被测提交：`482b3eb561de0fdff43268b1d3feed750a41deac`（父 `3131fdf52ce8c79fd69039bb61bb7e14b69b7eef`）
> 口径：只读复跑；唯一写域为本报告（精确 commit，不 push、不联网、不碰主实例运行态）。
> **总评：PASS**（唯一未绿项 `usability-check.sh` exit 1 为父提交同款存量 go-cache 只读噪声，非本轮新增）。

## 0. 基线与写域声明

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 工作目录 | `cd .../kore-pl/kore && git rev-parse --show-toplevel` | `/home/pt/Work/GolandProjects/kore-pl/kore` |
| HEAD | `git rev-parse HEAD` | `482b3eb…`（= 被测提交，未 CHECKOUT 任何 worktree） |
| 分支 | `git branch --show-current` | `main` |
| 他人 dirty 原样 | `git status --short`（前/后各一次） | 前后一致：` M scripts/usability-pending.txt`、`?? .agents/verify/e2e-*.md` 等 8 份他人报告、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`、`?? data/`、`?? dist/` 均未改动 |
| G-29 运行态 | 只做只读 git/编译/脚本检查；未启动/重启 kored，未读写 `.kore-local*` / `bin/kored` | 本轮未改动主实例运行态 |

## 1. commit 482b3eb 文件级核对

`git diff-tree --no-commit-id --name-status -r 482b3eb` + `wc -l`：**精确 11 文件**，与任务卡一致：

- 8 张 PNG：`ui-p1-{desktop,mobile}-0{1,2}-{dashboard,monitor}-{full,viewport}.png`（A）
- `.agents/verify/ui-p1-selfeval.md`（A，+82）
- `docs/DESIGN-REDUCTION.md`（M，+45，仅追加 §9，不改 §1–§8）
- `web/app.js`（M，+236/−122）

未包含 `scripts/usability-check.sh`、`scripts/usability-pending.txt`、`web/plugins-view.js`（A6 脚本函数体零改动已由 `git diff --quiet 3131fdf 482b3eb -- scripts/usability-check.sh` exit 0 独立确认；pending 清单不在 commit 内）。

## 2. 读码 / DOM 核对

### 2.1 首页 21 → 焦点 1 + 快捷 3 + 待办（web/app.js #kore-overview）

- `OV_TODO_MAX = 3`（app.js:1243，原 8）；`OV_ACTIONS` 三项（app.js:1644–1648：新建网站 / 查日志 / 打开终端，原 4 项「部署应用」合并进新建网站 hint，深链 `sites/appdeploy` 保留）。
- `paintOvHero()`（1666–1747）：主分数 + 结论 + 主按钮构成焦点 1；7 项 chip 收进 `<details class="ov-hero-details">`（「查看 7 项明细」），异常项（fail/warn）仍在焦点层 `.ov-hero-trouble` 直接可见——信息未删、只降权重。
- `paintOvTodos()`（1749–1798）：最多 3 条 + 「查看全部」按钮 → `openAlertCenter` 抽屉（:1757–1760），超额显示「还有 N 项」。
- `renderDashboardView()` / `buildOverviewInto()`（:2258、:2232 附近）：原 KPI 卡 `#kore-ov-metrics`、`#kore-ov-status`、`#kore-ov-alerts`、`buildOvSysDetails()` 四段挂载/重绘代码整段删除，换为 §2.2 注释；`loadOverview()` 仍保留 `ovFetchSystem` / `ovLoadServices` 拉取（供健康分与待办阈值共用），只不再挂 KPI 卡。

自评报告 DOM 实测（隔离实例）：`#kore-overview` 根 5 子节点（head / hero / actions / todos / note），`.ov-action`=3、`.ov-todo`=2（≤3）、`.ov-hero-details .ov-check`=7、`.ov-card`=0、`.ov-status`=0、`.ov-alert-panel`=0、`.ov-sysinfo`=0。与代码结构一致。

### 2.2 KPI 下沉监控 hub

截图实读（见 §4）显示监控 hub「监控」分区可见 CPU / 负载 / 磁盘 / 运行时 / VmRSS 基础指标 + 「安装 monitor 插件可获得更多详情 / E_NOTFOUND 插件未安装」降级说明；服务计数归 sites、插件计数归 store、最近告警归告警中心、系统信息在设置页已有同数据源——首页 KPI 5 卡确已下沉，非删除。

### 2.3 tab 31 → 20、单 hub ≤5、17 项映射、不删功能不新建 hub

- 脚本独立计数（usability-check 实际输出，HEAD）：**8 hub / 20 tab**，逐 hub sites 3 / db 2 / files 2 / store 2 / monitor 4 / tasks 1 / security 3 / settings 3，最大 monitor 4 ≤5；全站 20 ≤20。父提交同脚本计数：**7 hub / 31 tab**（monitor 9、settings 6、sites 6 → 2 处 WARN + total WARN）。点数 31→20 实测成立。
- 17 项映射（DESIGN-REDUCTION §2.1 表，97–113 行）逐项落地：`sectionView()`（:2394–2470）+ `sections()`（:2383）做 tab 内分区（故意不写 `sub:`，避免被 A6 计成一级 tab）；「批量」改为站点选择态工具条（sites.js 既有能力）；`LEGACY_SUB`（:2352–2362，21 条）保留全部旧 sub 的路由归宿；`SHELL_VIEWS` 新增 sites / monitor 登记（:2300–2301）供分区按 sub 解析；无 `id:` 一级项增删，未新建 hub —— HUB_DEFS 仍是原 8 功能 hub + dashboard（终端由 `shellView('terminal')` 按 sub 解析，形式变化但一级项未动）。
- 完全独立的哈希重定向模拟（`node -e` 从 app.js 提取 LEGACY_SUB 并按 `hashchange` 处理器同逻辑计算，exit 0）4/4 正确：
  - `#/monitor/fault-drill` → `#/monitor/alert?section=fault-drill`
  - `#/settings/snapshot` → `#/settings/governance?section=snapshot`
  - `#/sites/site-migrate` → `#/sites/sites?section=site-migrate`
  - `#/security/dns` → `#/security/network?section=dns`

## 3. 门禁复跑（命令 + 退出码）

| # | 命令 | 退出码 | 关键输出 / 判定 |
| --- | --- | --- | --- |
| 1 | `node --check web/app.js` | **0** | 无输出（语法通过） |
| 2 | `bash scripts/usability-check.sh --self-test` | **0** | 正例 PASS / 四反例（A2/A3/A4/A6）均被拦下 / tab 超推荐值仍 INFO/WARN 且 exit 0；末行 `[OK] self-test 全部通过` |
| 3 | `bash scripts/usability-check.sh`（HEAD 实际） | **1** | `0 pass, 506 warn, 18 fail, 183 unverified`；18 FAIL 全为 A1 ZeroParam 真跑失败，报错 `open /home/pt/.cache/go-build/…: read-only file system`（go-build 缓存只读，存量环境噪声）；tab 提示全 INFO、无 WARN；`8 hub / 20 tab` |
| 4 | 父提交同脚本（`git archive 3131fdf` 解到临时目录 + `PLUGIN_REPOS_DIR`/`USABILITY_PENDING_FILE` 指真实路径，跑完删临时目录） | **1** | 父：`0 pass, 506 warn, 18 fail, 183 unverified`，`7 hub / 31 tab`；monitor 9 / total 31 两条 WARN。FAIL 插件名逐条 diff：parent 18 与 HEAD 18 **完全相同**（`FAIL_SET_IDENTICAL exit=0`），无新增 FAIL、exit code 未变 |
| 5 | `make frontend` | **0** | 首屏 gzip 合计 **90,924 B ≤ 307,200 B（300 KiB）**，余量 216,276 B；有 `>基线+5% / 绝对线 90,000` 的 WARN（app.js +5,763 B 主要来自 P1 逻辑，脚本基线快照未更新，已按方案登记 P2，不阻断）；`make frontend` 会重建被 gitignore 的 `web/dist/`，非写域文件未入库 |
| 6 | `go test -timeout 200s ./cmd/kored/...`（默认 env） | **1** | 环境噪声：`/home/pt/.cache/go-build/…: read-only file system`（与 #3 同根因）；非代码失败 |
| 6b | `GOCACHE=…/.gocache-final-gate GOMODCACHE=…/.tmp-acct-gomodcache GOFLAGS=-mod=mod go test -timeout 200s ./cmd/kored/...`（可写缓存） | **0** | `ok github.com/pengtang1024/kore/cmd/kored 9.485s` |

说明：`go test` 默认缓存只读与 usability A1 的 18 FAIL 同源，用可写缓存后 cmd/kored 真绿，故判为存量环境噪声而非实现缺陷；A6 函数体与脚本原文零改动，tab 计数只提示未进 FAIL 集合。

## 4. G-28 双端截图硬核验

### 4.1 文件真实宽高（`file` + `identify -format '%wx%h %[colorspace] %b'`）

| 文件 | `file` | `identify` | 自评登记 |
| --- | --- | --- | --- |
| desktop-01-dashboard-full / viewport | PNG 1440×900 RGB 各 86,674 B | 1440×900 sRGB | 1440×900 ✅ |
| desktop-02-monitor-full / viewport | PNG 1440×900 RGB 各 110,458 B | 1440×900 sRGB | 1440×900 ✅ |
| mobile-01-dashboard-full | PNG 390×897 | 390×897 sRGB | 390×897 ✅ |
| mobile-01-dashboard-viewport | PNG 390×844 | 390×844 sRGB | 390×844 ✅ |
| mobile-02-monitor-full | PNG 390×1387 | 390×1387 sRGB | 390×1387 ✅ |
| mobile-02-monitor-viewport | PNG 390×844 | 390×844 sRGB | 390×844 ✅ |

sha256：桌面 dashboard full/viewport 同哈希（页面高度恰为 900，full-page 与视口同帧，非伪造）；桌面 monitor 同哈希同理；手机 4 张各不同哈希；PC 与手机、dashboard 与 monitor 互不相同。`G-28` PC 1440×900 / 手机 390×844 viewport 满足。

### 4.2 `read_image` 实读（4 张，非仅靠尺寸/元数据）

| 图 | 实读所见（要点） |
| --- | --- |
| desktop-01-dashboard-viewport | 新布局：焦点卡（73 分 / 注意 / 有 1 项建议处理 / 去处理·服务）、异常 chip「服务 告警 1」+「查看 7 项明细」折叠；快捷恰 3 个（新建网站/查日志/打开终端）；待办 2 条 + 查看全部；**无 KPI 卡、无最近告警面板、无服务/插件计数面板** |
| mobile-01-dashboard-viewport | 真手机排版（390×844、横向顶栏 4 控件、底部 tab 条 更多），同样焦点 1 + 快捷 3（两列+单列自适应）+ 待办 2；非桌面缩放 |
| desktop-02-monitor-viewport | 监控 hub 4 tab（监控/日志/进程/告警）+ 二级分区 5（监控/系统体检/运行报告/服务拓扑/磁盘分析）；真实基础指标 CPU 21.2% / 负载 14.01 / 磁盘 549.5 / VmRSS 17.8 MiB + 降级说明「安装 monitor 插件可获得更多详情」，KPI 下沉可见 |
| mobile-02-monitor-viewport | 真手机排版，同样 4 tab + 5 分区，数据不同（CPU 36.3% / 负载 13.05 / 18:13:02，桌面为 18:12:56），证明是两次真实浏览器渲染而非同图复制 |

结论：**新布局可见、双端非同图缩放、非伪造**。

### 4.3 自评三问原文核对

`.agents/verify/ui-p1-selfeval.md` 54–82 行含「自评三问（原文）」：问 1 解决首页 21 块平铺 + tab 放不下，答焦点/快捷/待办与 17 项映射；问 2 对比宝塔 / 1Panel 的动线变化与差距（多 1 次点击、插件行 5 按钮 P2）；问 3 判「可用」并列判据（双端真实浏览器登录、DOM 实测、旧 hash 4 例、A6 未动、make frontend/go test exit 0）。三问齐备且内容具体，非模板占位。

## 5. git 收尾态

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 未 push | `git branch -a --contains 482b3eb` + `git for-each-ref refs/remotes \| while ... merge-base --is-ancestor` | 仅本地 main 含该提交；四个 remote（gitea/gitee/github/origin）任一远端引用均**不含** 482b3eb（无 PUSHED 行）→ 未 push |
| worktree 仅主树 | `git worktree list` | 1 行：`/home/pt/Work/GolandProjects/kore-pl/kore 482b3eb [main]` |
| 无临时分支 | `git branch --list 'wt-*' 'tmp-*'` | 空 |
| 他人 dirty 未碰 | 前后 `git status --short` 对比 | 一致（本报告自身为新增，提交后消失） |

## 6. 结论

- 读码/DOM：首页 21→焦点 1 + 快捷 3 + 待办 ≤3、KPI 下沉监控、tab 31→20 单 hub 最大 4、17 项映射全落地、旧 hash 4/4 正确、不删功能不新建 hub —— **PASS**。
- 门禁：node --check 0、self-test 0、usability 实际 1（父亦 1，18 A1 go-cache 只读噪声、FAIL 集完全一致、tab 只提示、脚本零改动）、make frontend 0 首屏 90,924 B ≤300 KiB、go test cmd/kored 可写缓存下 0 —— **PASS**。
- G-28：8 张 PNG 齐全、尺寸与自评一致、4 张实读确认新布局真实且双端非同图、自评三问原文 —— **PASS**。
- git：精确 11 文件、他人 dirty 原样、未 push、worktree 仅主树 —— **PASS**。
- **总评 PASS**。唯一观察项：首屏 gzip 体积漂移 WARN（90,924 B > 绝对线 90,000 B，仍远低于 300 KiB 预算）与 usability 18 A1 存量噪声，均非本轮新增、已在 selfeval §9.3 登记后续期，不构成 BLOCKED。

---

署名：`ui-p1-verifier`（G-09，非 ui-p1）· commit 标记 `[agent:ui-p1-verifier]` · 不 push。
