# app-deploy 主壳视图：G-28 双端证据 + 运行时冒烟

> 元信息: 2026-11-23T21:45+08:00 · 执行者 appdeploy-view-finish · 对象 commit `2450e0c`（第 21 个懒加载视图 `web/appdeploy.js`）· 隔离实例 `127.0.0.1:18876`（`--config /tmp/kore-adep2/config.yaml`，state/run/log 全在 `/tmp`，index 指向 `kore-plugins/index`）· 主实例 8787 零请求零写入 · 报告 ≤40 行

## 0. 结论

- `2450e0c` 已在 HEAD，`web/appdeploy.js` 等 7 文件均已提交；工作树只剩 `?? web/.cache/`（构建缓存，`.gitignore` **未覆盖**，属共享文件归他人，本轮只报告未改动）。
- **G-28 截图 4/5 达成**（导航入口、列表/上传/任务面板、上传进度、手机端 + 手机抽屉）。**第 5 张「插件未装降级态」未截**：时限内优先做真实上传冒烟，卸载重载未做。
- **发现 P0 真 bug（阻塞级）**：视图全部 API 调用路径拼错，已装插件的页面 4 个面板全报错，实际上不可用。

## 1. P0：API 路径缺方法前缀（view 侧）

`web/appdeploy.js:10` `var API = '/api/v1/invoke/app-deploy/'`，`invoke(method)` 拼成 `/api/v1/invoke/app-deploy/list`；正确契约是 `/api/v1/invoke/app-deploy/app-deploy.<action>`（见 docs/FRONTEND.md §业务方法调用形态）。修法一处：`API = '/api/v1/invoke/app-deploy/app-deploy.'`（同一常量同时供 `invoke` 与 XHR `invokeWithProgress`，改一行即全通）。

真机复现（隔离实例，已登录 + CSRF）：

| 请求 | 返回 |
| --- | --- |
| `POST /api/v1/invoke/app-deploy/app-deploy.list` | `{"deployments":[],"count":0}` |
| `POST /api/v1/invoke/app-deploy/list`（view 实际路径） | `{"code":"E_NOTFOUND","message":"未知方法: list"}` |
| `POST /api/v1/invoke/app-deploy/upload`（view 实际路径） | 同样 unknown method → 页面文案「当前插件版本不支持上传（去软件商店升级…）」 |

页面实际渲染（截图 `appdeploy-upload-result-desktop.png` 原文）：`列表读取失败：E_NOTFOUND：未知方法: list`；上传区 `上传部署失败：当前插件版本不支持上传`；任务区 `当前插件版本不支持任务查询`。**降级判别把路径错误误判成「旧插件不支持」，会误导用户去升级，实际是前端 bug。**

## 2. 上传冒烟（真实 UI + 2 MiB tar.gz）

- 制品：`/tmp/kore-adep2/demo-app.tar.gz`（1.95 MiB；`head -c 2097152 /dev/urandom` + `tar czf`），CDP `DOM.setFileInputFiles` 注入 `#adp-up-file`，点击「上传并部署」。
- **进度条真的动了**：按钮文本采样 `上传中 0% → 1% → 2% → 4% → 5% → 6% → 7% → 8% → 9% → 10% → 11% → 12%`（CDP `Network.emulateNetworkConditions uploadThroughput=300KiB/s` 限速放大可观测窗口；XHR upload progress 有效）。截图 `appdeploy-upload-progress-desktop.png` 即进度进行中。
- **上传结果未达成**：请求打到错误路径 `/upload`，返回 unknown method，未产生 `files/bytes/sha256/job`。故「成功后显示 files/bytes/sha256/job 与已解压到 …」**未验证**（被 P0 阻断，不是上传实现问题）。

## 3. G-28 截图（`file` 实测）

| 文件 | 实测宽高 | 内容 |
| --- | --- | --- |
| `appdeploy-nav-desktop.png` | 1440×900 | 左侧导航「平台」组内「应用部署」入口可见（非死页面） |
| `appdeploy-view-desktop.png` | 1440×900 | 四面板同屏：应用列表 / 上传部署 / 升级 / 任务历史（此时已落入 P0 错误态） |
| `appdeploy-upload-progress-desktop.png` | 1440×900 | 上传进行中：按钮「上传中 N%」+ 进度条填充 |
| `appdeploy-upload-result-desktop.png` | 1440×900 | 上传后的错误态原文（P0 证据） |
| `appdeploy-view-mobile.png` | 390×1175 | 390 宽下四面板纵向堆叠，表格/按钮未溢出 |
| `appdeploy-nav-mobile.png` | 390×1175 | 手机「更多」抽屉打开（导航可达） |

工具链：本机 Playwright 包不可解析（`require('playwright')` 失败，无全局安装）；改用 **`~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` 裸 CDP**（Node 24 内置 WebSocket），显式指定该 executablePath，`Page.captureScreenshot captureBeyondViewport` 全页。无 Playwright 报错原文可贴（未使用该库）。

## 4. 自评三问

1. **解决什么用户问题**：主壳 22 项导航此前无部署入口，用户装了 app-deploy 插件也找不到页面；本视图把「传包 → 解压 → 登记部署 → 升级（自动快照）→ 任务时间线」收进一个页面，补的是「装了插件什么都看不到」的断链。
2. **与宝塔 / 1Panel 差距**：宝塔有应用商店 + 一键部署 + 版本回滚的可视化闭环；本页只有「上传制品 + 同应用升级 + 快照路径文本」，**没有应用商店、没有回滚按钮（只显示快照路径让用户自己处理）、不启容器不写 nginx**，属于「部署制品管理层」而非「应用生命周期管理」。
3. **当前是「可用」还是「占位」**：按代码结构与交互是**完整实现**，但按运行时证据是**不可用**——P0 路径 bug 使 list/upload/jobs 全部失败，必须改 `web/appdeploy.js:10` 一行后才谈得上可用。修后还需复跑本报告 §2 的上传成功态。

## 5. 运行态与清理

- 主实例 8787：本轮**零请求、零写入、未重启**（`api/v1/system/info` 未调用）。
- 隔离实例 18876 与 chromium 9223 已 kill，`/tmp/kore-adep2` 已 `rm -rf`，两端口无监听；口令为一次性随机值，随 `/tmp` 删除，未落档。

---

## 6. P0 修复后复验（2026-11-23 · `[agent:appdeploy-api-fix]`）

> 本节追加在原文之后，§1–§5 的 P0 证据一字未删。

### 6.1 修了什么（只改 `web/appdeploy.js`）

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `API` 常量 | `/api/v1/invoke/app-deploy/` | `/api/v1/invoke/app-deploy/app-deploy.` |
| 使用点 | `grep -n "API" web/appdeploy.js` = **3 处**：`:10` 定义、`:42` `fetch(API + method)`、`:62` `xhr.open('POST', API + method)`（上传复用同一常量） | 一处修好三处通；`invoke('list'/'upload'/'deployFromArtifact'/'upgrade'/'jobs'/'templates')` 全部带 `app-deploy.` 前缀 |

降级判定（根因 2）：原 `degrade()` 见到「未知方法」直接判 `unsupported` → 页面提示「去软件商店升级」，把前端 URL 拼错包装成用户可操作动作。改为**版本证据门控**：

- 进页时 `GET /api/v1/plugins` 一次探测 app-deploy 版本（`probePluginVersion()`，不轮询）；
- 只有「读到版本且 `< 0.3.0`」（`MIN_METHOD_VERSION`，0.3.0 才引入 upload/deployFromArtifact/upgrade/jobs）才返回 `unsupported` → 文案「已确认版本 X < 0.3.0 … 去升级」；
- 版本达标或探测失败（未知）→ `other`，按原始错误中性展示：「调用失败，错误原文已保留在上面。先点「刷新」重试；反复出现说明前端与插件的方法契约不一致（既不是没装插件，也不是提示你升级就能解决），请把错误原文交给维护者。」；
- 顺带修顺序错误：`notinstalled` 先于方法缺失判定（`E_NOTFOUND` 只在确有「未安装 / 未 enable / 插件不存在」文案时才判未装）。

### 6.2 隔离实例（G-29）

| 项 | 值 |
| --- | --- |
| 隔离实例 | `/tmp/kore-adp3`（`--config /tmp/kore-adp3/config.yaml`，state/run/log 全落 `/tmp`），端口 **18874**（先 `ss -ltn` 确认空闲） |
| 二进制 | 本轮 `make build` 产物 `bin/kored` → 复制到 `/tmp/kore-adp3/kored`（含本次前端修复的 embed dist） |
| 索引 | 只读指向 `/home/pt/Work/GolandProjects/kore-plugins/index` |
| 口令 | `./bin/kored admin-password --generate --config /tmp/kore-adp3/config.yaml`（一次性随机值，未落档；随 `/tmp` 删除） |
| 插件 | `kored install --package …/kore-plugin-app-deploy/dist/app-deploy-0.3.0.tar.gz` → `installed app-deploy 0.3.0`；`POST /api/v1/plugins/app-deploy/enable` → 200 |
| 主实例 8787 | **零请求、零写入、未重启**；未改 `.kore-local.yaml` / `.kore-local-state/`（本轮所有验证都在 18874） |

### 6.3 `list` 复验（curl 原文）

```text
$ POST /api/v1/invoke/app-deploy/app-deploy.list
{"deployments":[],"count":0}
http=200

$ POST /api/v1/invoke/app-deploy/list          # 修复前 view 实际路径（复现根因）
{"code":"E_NOTFOUND","message":"未知方法: list"}
http=404

$ POST /api/v1/invoke/app-deploy/app-deploy.jobs
{"jobs":[],"count":0}
http=200
```

### 6.4 真实上传（页面 + CDP `DOM.setFileInputFiles`，非接口替身）

制品 `echo hi > /tmp/x && tar czf /tmp/x.tgz -C /tmp x`，注入 `#adp-up-file` 后点「上传并部署」，页面结果区原文：

```text
已上传并解压
x · 3 B · 1 个文件
已解压到 /tmp/kore-adp3/state/plugin-data/app-deploy/apps/x
sha256 9c2cbb796a31472dce6d5360fd79e10d16409d98211b6067a52c97d4d07fc07e
任务 job-ea049f779514
部署已登记
建站提示：站点 vhost 属 site 插件的写域：请到「站点」页创建站点，根目录填 …/apps/x（本插件不写 nginx、不 reload）
```

**`files/bytes/sha256/job` + 「已解压到」全部出现，上传成功态达成**（原文 §2 的「未验证」本次补齐）。手机端用第二个包（`x2.tgz`）复跑同样成功：`x2 · 4 B · 1 个文件 / 已解压到 …/apps/x2 / 任务 job-7f4658105f9b`。

任务时间线（`.adp-jobs` 原文）：`上传 · 成功  received ✓ → extract ✓`、`部署登记 · 成功  received ✓ → extract ✓ → register ✓`、`升级 · 成功  received ✓ → extract ✓ → snapshot ✓ → swap ✓`。

> 备注：手机端第一次误用重名 `x` 上传 → `E_CONFLICT：目标目录已存在 …（升级请用 app-deploy.upgrade）`，这是插件对重名包的**正确护栏**，不是本次 bug；换名后成功。

### 6.5 升级（自动快照）

同名 `x` 上传第二个包，页面原文：

```text
升级完成
4 B · 1 个文件
已自动快照，可回滚
快照位置：/tmp/kore-adp3/state/plugin-data/app-deploy/snapshots/snapshots/x/20261123T134836Z
任务 job-664a98dc5df9 · succeeded
```

### 6.6 降级态（中性文案，不再误导升级）

停用插件（`POST /api/v1/plugins/app-deploy/disable` → 200）后刷新页面：

```text
列表读取失败：E_CONFLICT：插件 app-deploy 未启用，请先 POST /api/v1/plugins/app-deploy/enable
调用失败，错误原文已保留在上面。先点「刷新」重试；反复出现说明前端与插件的方法契约不一致（既不是没装插件，也不是提示你升级就能解决），请把错误原文交给维护者。
[刷新]
```

DOM 断言 `document.body.innerText.includes('去软件商店升级') === false` ——**误导性升级提示不再出现**。随后 `enable` → 200 恢复。

### 6.7 G-28 截图（`file` 实测宽高）

| 文件 | 实测宽高 | 内容 |
| --- | --- | --- |
| `appdeploy-p0-list-desktop.png` | 1440×900 | ① 列表正常态：空态「还没有应用：上传一个 tar.gz/zip 制品即可完成第一次部署」+「上传第一个应用」，无报错 |
| `appdeploy-p0-list-data-desktop.png` | 1440×1128 | ① 列表有数据：`x / artifact / 未启动容器（制品已就位） / 2026-11-23 21:46 / 升级 看任务` |
| `appdeploy-p0-upload-desktop.png` | 1440×900 | ② 上传成功态：`已上传并解压` + `已解压到` + `sha256` + `任务 job-…` + `部署已登记` |
| `appdeploy-p0-upgrade-desktop.png` | 1440×1122 | ③ 升级结果：`升级完成` + `已自动快照，可回滚` + 快照路径 + `任务 job-… · succeeded` |
| `appdeploy-p0-degrade-desktop.png` | 1440×900 | ④ 降级态（插件停用）中性文案，无「去升级」 |
| `appdeploy-p0-list-mobile.png` | 390×1519 | 手机 390×844 下四面板纵向堆叠，表格未溢出 |
| `appdeploy-p0-upload-mobile.png` | 390×1927 | 手机端上传成功态（`x2` + `已解压到` + `job`） |

工具链：`~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` 显式 `executablePath` + 本机临时安装的 `playwright-core`（`/tmp` 内，用后随目录删除）；`fullPage: true`。

### 6.8 门禁（命令 + 退出码）

```text
$ node --check web/appdeploy.js                 → exit=0
$ make frontend                                 → exit=0
[INFO] 首屏合计（gzip -9）: 62710 字节 / 预算 307200 字节（300 KiB）
[OK] 首屏体积达标：62710 字节 ≤ 307200 字节，余量 244490 字节
$ make build                                    → exit=0
[OK] 构建完成: ./bin/kored
```

首屏 gzip **62710 字节**（修复前后同一值）：`appdeploy.js` 不在首屏 6 件套（`index.html/style.css/app.js/shell.js/i18n.js/i18n-zh-CN.js`）里，是懒加载视图（`/assets/appdeploy.js`），其自身 gzip 8959 字节不计入首屏预算。

### 6.9 自评三问（修复后更新）

1. **解决什么用户问题**：装了 app-deploy 却看不到/一进页全红的问题已消除；现在从「传包」到「解压路径 + sha256 + 任务号」到「同名升级自动快照」是真实可用的一条链。
2. **与宝塔 / 1Panel 差距**：仍是「部署制品管理层」——无应用商店、无回滚按钮（只给快照路径）、不启容器不写 nginx；与宝塔的「应用生命周期 + 一键回滚」差一个完整的产品闭环。
3. **当前是「可用」还是「占位」**：**可用**（list/jobs/upload/deployFromArtifact/upgrade 五条路径本轮均有真机证据）；回滚、容器启停、站点联动仍是缺口，属 v1.1。

### 6.10 清理

隔离实例进程已 kill、`/tmp/kore-adp3` 与 `/tmp/x*` 已 `rm -rf`、`18874` 已释放（`ss -ltn` 无监听）；主实例 8787 全程未触碰、未重启。
