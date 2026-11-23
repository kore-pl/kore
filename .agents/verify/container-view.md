> 元信息: 2026-11-23T13:30+08:00 · 执行者 kore-impl-container-view（implementer，task-1）· 主壳第 17 个视图 `web/container.js`（322 行）· 隔离实例 `127.0.0.1:18870`（`--config /tmp/kore-cv/config.yaml`，state/run/log 全在 `/tmp/kore-cv`，index 指向 `kore-plugins/index` 验签索引）· 主实例 8787 全程无进程未动 · 真机 chromium CDP 双端截图 · 报告 ≤90 行

# 容器视图收口验收（构建 + 隔离实例真机 + G-28 双端截图）

## 0. 结论

四处接线一致、构建门禁全绿、隔离实例真机 25 容器全量真实数据（列表/统计/详情/日志/启停确认全渲染）、Runtime 异常 0、双端截图 `file` 实测 1440×1351(full) / 1440×900 / 1440×900 / 390×844。**半成品里挖出 1 个 P0 + 1 个 P1，已修并复验**：弹层靠 `hidden` 开关而 CSS 是 `display:flex`，`hidden` 被压掉 → 确认层与抽屉常驻、全屏遮罩挡住整页点击（首张截图当场抓到）。**未做**：push、镜像/创建/exec/编排（G-11 非目标）。

## 1. 接线核对（四处一致 + 交叉验证）

| 处 | 改动 | 复核证据 |
| --- | --- | --- |
| `web/shell.js` | 资源组 ids 加 `container`、集装箱图标、兜底 `lazyView('KoreContainer','/assets/container.js','nav.container','容器')` | `grep -c KoreContainer web/dist/shell.js` = **1**；导航四组 + 资源组含容器（截图左栏） |
| `web/embed.go` | 注释「三十二个文件 / 32 精确路径」+ `//go:embed … dist/container.js …` | `grep -c "dist/container.js" web/embed.go` = **2**（注释清单 + embed 行）；`make build` 通过即证明 dist 文件存在 |
| `Makefile` | `WEB_SRC_FILES` 加 `container.js`；注释与 echo 31→32、16→17 视图 | `make frontend` 输出「32 文件…17 视图模块」 |
| `web/i18n/*.js` | `nav.container`：容器 / Containers | `grep -c nav.container web/dist/i18n-zh-CN.js web/dist/i18n-en-US.js` = **1 / 1** |
| 交叉 | 服务端实测 | `curl /assets/container.js` → **HTTP 200, 25426 B**；`curl /assets/shell.js | grep -c KoreContainer` = 1 |

API 契约逐字段核对插件仓（`../kore-plugin-container/internal/containerop/types.go`）：`container.list{all}`→`containers[]`；`logs{id,tail,since}`→`{lines,truncated}`；`stats`→`cpu_percent/memory{usage,percent}`；`inspect`→`image/state.*/health/resources.restart_policy|memory_limit/network.ip|ports/mounts`；`start` 免 confirm、`stop/restart` 必须 `confirm=true`；保护名单 `E_UNAUTHORIZED`。CSRF 与其它视图同口径（非 HttpOnly `kore_csrf` 双提交头 `X-Kore-CSRF`）。

### 挖出并修复的缺陷（本轮）

1. **P0 弹层常驻挡全页**：`.ctr-drawer`/`.kore-modal` 自带 `display:flex`，作者样式压过 `[hidden]{display:none}` → 抽屉与「停止/重启手输容器名」确认层永不隐藏，`.kore-modal` 全屏遮罩盖住整页、所有点击失效（截图 desktop-01 首拍当场抓到）。修：补 `.ctr-drawer[hidden],.ctr-mask[hidden],.ctr-confirm[hidden]{display:none}` + 确认层加 `ctr-confirm` 类；复验 `hidden:true→display:none`、`hidden:false→display:flex`（CDP 实测）。
2. **P1 抽屉状态串用**：`S.drawer` 既存 `<aside>` 节点又存模式串，`openDrawer` 写入模式后 `setDrawer` 对字符串设 `.hidden`，严格模式抛 TypeError（日志/详情抽屉根本打不开）。修：拆 `S.drawerEl`（节点）/ `S.drawer`（模式）。
3. **P1 stats 回填丢失**：整表重建（加载更多/刷新）后已缓存 stats 不回填 → CPU/内存永久 `—`；且 busy 期间新行无人拉。修：重绘逐行回填 + 链尾再补拉一次。
4. **P2** 失败/空态残留计数文案；**P2** 插件未装时 hintFor 落到「Docker 未启动」误导 → 新增「容器插件还没装，去商店装 container」分支。
5. **手机（裁决41）**：操作按钮 26px / 输入框 32px < 44px → media query 提到 `--kore-touch`；表格转卡片行（`data-label`）。实测 390×844 下 **100/100 按钮 ≥44px、横向溢出 0**。

## 2. 构建与门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `make frontend` | **0** | `[OK] 32 文件…17 视图模块`；首屏 gzip **59,416 B ≤ 307,200**；i18n 增量 **2,801 ≤ 3,072** |
| `make build` | **0** | `[OK] 构建完成: ./bin/kored`（CGO_ENABLED=0 + trimpath + s/w） |
| `make docs-check` | **0** | `5 pass, 1 warn, 0 fail`（WARN 为既有行数越界，非本批） |
| `node --check web/container.js` | **0** | 无输出（语法通过） |
| `gofmt -l web/embed.go internal/core/httpapi/server.go` | **0** | 无输出 |
| `make secret-check` | **0** | 见 §6（G-30，提交前跑） |

> 未跑 `make test`/`vet`：本批为前端 JS + 注释 + 文档，无 Go 逻辑改动；Go 侧仅注释行变更，`make build` 已过。

## 3. 隔离实例真机验证（G-29）

**本轮未改动主实例任何运行态配置**：`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` 零写入；主实例 8787 开工时与收工时均无监听进程（`ss -ltn` 空）。全部验证在隔离实例：

- 起服：`./bin/kored serve --config /tmp/kore-cv/config.yaml` → `GET /-/healthz` **200**；`paths` 实测 `{state:/tmp/kore-cv/state, run:/tmp/kore-cv/run, log:/tmp/kore-cv/log, index:/home/pt/Work/GolandProjects/kore-plugins/index}`（**index 指向 kore-plugins/index，验签通过**）。
- 登录：`POST /api/v1/auth/login` → `{"authenticated":true}`；口令为一次性随机值，只存 `/tmp/kore-cv/secret.env`（0600，收尾删除），**不落档**。
- 装插件：`POST /api/v1/store/install {"id":"container","version":"0.3.0","package_path":"…/kore-plugin-container/dist/container-0.3.0.tar.gz"}` → `state:succeeded, reload:reloaded`（本地包 sha 与已签索引逐字一致 `00c37c45…`，未联网）；`POST /plugins/container/enable` → `enabled:true`。
- 真机数据（全部来自本机 docker，无一处编造）：`container.list {all:true}` → **count 25 / running 25**；`stats(common-mysql)` → `cpu_percent 0.36, memory 587412275/65777424138 (0.89%)`；`inspect(kore-nginx)` → `running / 172.17.0.2 / 18084→80/tcp / bind 挂载`；`logs(kore-nginx, tail 5)` → 5 行真实 nginx 日志。
- 浏览器（chromium-1248 headless + 手写 CDP，零新依赖）：进容器视图 → 20 行表格 + **20/20 行 stats 回填**、计数「已显示 20 / 共 25 个容器」；详情抽屉 12 组字段（含端口 3、挂载 1）；日志抽屉 15 行 + since 输入 + 重新拉取；**`page_errors_total = 0`**；console 6 条全部为预期（favicon 404、隔离实例未装 site/monitor/ssl/discover 的 4 面板探测 404、首帧 401）。

## 4. G-28 双端截图（`file` 实测宽高；禁止同图缩放冒充双端）

| 文件 | `file` 实际宽高 | sha256 前 16 | 证据点 |
| --- | --- | --- | --- |
| `container-view-desktop-01.png` | **1440 x 1351**（full-page，宽=1440） | `54ca90cd52fedbe8` | 列表 20 行 / 共 25、CPU+内存条 20 行回填、左栏「资源·容器」高亮、**无抽屉无遮罩**（像素核验：抽屉列 x=890 亮度 std 8.5 vs 抽屉开时 0.8） |
| `container-view-desktop-02.png` | **1440 x 900** | `a53193994c5d6cf4` | 详情抽屉「详情 · common-mysql」：镜像/状态/健康/重启策略 unless-stopped/重启次数/启动时间/IP/端口 3/挂载 1 + 关闭按钮焦点环（蓝像素 366） |
| `container-view-desktop-03.png` | **1440 x 900** | `6792ec620a663624` | 日志抽屉「日志 · common-mysql」：since 输入 + 重新拉取 + MySQL 真实启动日志 15 行 |
| `container-view-mobile-01.png` | **390 x 844** | `faf0e66c6afeb35c` | 卡片式行 + `data-label` 列名、操作按钮 **100/100 ≥44px**、横向溢出 **0**、底部 tab（概览/监控/日志/进程/终端/更多） |

> 每图左上角 **3×3 色标**（红/绿/蓝/品红）是拍摄帧校验标记：headless `captureScreenshot` 会回错帧（实测发生过 01↔03 串位），脚本回读该像素、不匹配强制换帧重拍——本轮 4 张全部 **attempt=1 一次通过**。非 UI 元素、不属伪造。
> 截图方法：chromium-1248 headless + 手写 CDP（`Emulation.setDeviceMetricsOverride` 强制出帧 + `captureBeyondViewport` 全页），与 `.agents/verify/` 近期报告同法。

## 5. 产品定位自评（G-28 三问原文）

**① 本页解决什么用户问题**：机器上跑着一堆 Docker 容器，运维者天天要回答三件事——哪些在跑、谁吃 CPU/内存、出事了日志在哪。以前只能 SSH 上去敲 `docker ps` / `docker stats` / `docker logs`，或另装宝塔/1Panel 的 Docker 管理器。本页把「列表 + 实时统计 + 日志/详情抽屉 + 启停重启」收进主壳一个视图：点行看日志、点行看详情，停止/重启要手输容器名二次确认，保护名单（核心服务容器）整行锁标禁操作，杜绝在面板上误杀核心服务。

**② 与宝塔/1Panel 容器功能的差距**：差距在「面」不在「点」。它们还有：容器创建向导（端口/卷/环境变量表单）、镜像管理（拉取/删除/构建）、容器内终端（exec）、compose 编排、资源限额修改、日志轮转配置；本页只有**已存在容器**的列表 / 日志 / 详情 / 统计 / 启停重启。其中「创建容器」「容器内终端」是面板场景的高频能力，本页明确没有；容器编排属 G-11 六项不做，exec 与镜像管理需先过裁决才能开。对齐的部分：真实 `docker stats` 回填、日志 tail+since、保护名单禁操作、双端响应式，这四件竞品有的日常运维面本页都有。

**③ 当前是「可用」还是「占位」**：**可用（非占位）**。真机 25 个容器列表、20/20 行 CPU/内存回填、inspect 详情（端口/挂载/重启策略/健康）、日志 tail 200 + since、启停重启二次确认，全部真实数据 + 真实浏览器双端验证，Runtime 异常 0；Docker 未装 / 插件未装都给「怎么办」下一步而不是空页或编数据。明确不做的部分（创建/exec/镜像/compose）是能力域边界，不是半成品。

## 6. 门禁与提交

- `make secret-check` → **0**（G-30：本报告无明文口令，口令为 `$KORE_CV_PASSWORD`，值不落档）。
- 提交：`feat(web): 容器管理视图（第 17 个视图）`（sha 由回报给出）；精确 add：`web/container.js web/shell.js web/embed.go web/i18n/zh-CN.js web/i18n/en-US.js Makefile internal/core/httpapi/server.go docs/FRONTEND.md .agents/verify/container-view.md .agents/verify/screenshots/container-view-*`。**未 add** 他人写域（supervisor/platform/pluginapi/privilege/market、AGENTS.md、PLUGIN-MATURITY、r3*/redis*/install-six* 等证据）。
- **G-06 文档同步**：`docs/FRONTEND.md` 同批把 31→32 文件、16→17 视图、导航 18→19 项、`//go:embed` 清单与视图清单补 `container.js`——**超出任务卡枚举的 add 列表，属 G-06 硬门禁要求的同检查点文档同步，特此声明**。
- **运行态写边界声明**：本轮**未改动主实例运行态配置**（`.kore-local.yaml`/`.kore-local-state/`/`.kore-local-run/` 零写入，8787 无进程）；`bin/kored` 由 `make build` 重建（任务卡明确要求跑 `make build`，主实例无进程持有它）；隔离实例 `/tmp/kore-cv` 验证完即删。

## 7. 事故与已知缺口（如实）

1. **共享工作区被 `git reset --hard 8566d43` 清掉未提交 tracked 改动**（reflog `HEAD@{0}: reset: moving to 8566d43`，约 13:21 发现，非本 agent 所为）：本写域 7 个文件（shell.js/Makefile/embed.go/i18n×2/server.go/FRONTEND.md）被清空，已按会话内留存的原始 diff **逐字恢复**，恢复后 `git diff --stat` 与恢复前一致，`make frontend`/`make build` 复跑全绿，隔离实例重启后冒烟（healthz 200 / container.js 200 / container.list 25 条）通过。**同时发现** `docs/CORE.md`、`.agents/verify/screenshots/nav-05-monitor.png`、`nav-06-settings.png` 等开工时处于 modified 的他人文件也回到 HEAD 状态，可能同样被清——已报 lead 由各 owner 核对。
2. 全局搜索 `search.js` 页面清单未加「容器」——但 `runtimes`/`integrity` 同样不在清单（既有缺口，非本批引入），未动他人文件。
3. `docs/PLUGIN-MATURITY.md` §3.3.1 仍写「16 视图」（连 `runtimes`/`integrity` 都没计，既有漂移），且该文件正由 architect 修改中，未动。
4. 未跑 `make test`/`vet`（理由见 §2），未 push（任务卡禁止）。
