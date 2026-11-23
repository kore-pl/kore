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
