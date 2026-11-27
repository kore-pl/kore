# Python 扩展管理 · UI 自评（G-28）

> 2026-11-28 · 执行者 `pyext-impl`（task-290）· 隔离实例（独立 config/state/run/log 落 `.agents/verify/.tmp-pyext-shot`，独立端口，非 8787；捕获后停实例、删临时目录与临时二进制）· 插件从本地 `dist/runtime-python-0.5.0.tar.gz` 经 `store/install` + `enable` 装入隔离实例（不是主实例）· playwright 1.65.1 headless Chromium · 页面错误数 0。

## 0. 交付概览

Python tab 内新增「扩展管理」分区（复用现成 `extPanel`，不是新的一级控件 / hub / tab）：输入包名 → 点「安装扩展」→ 列表显示已装隔离扩展 → 点「移除」。后端 `ext.install/list/remove` 把包装进 `<state>/global/py_ext`（`python3 -m pip install --target` 固定 argv），不写宿主 site-packages、不设 PYTHONPATH；remove 因 pip uninstall 无 `--target` 走隔离目录内受控文件删除。`EXT_CFG['runtime-python']` 只加文案配置，无新增 CSS / 一级控件；英文串进懒加载 `en-US.js`，中文走 `tr()` 原地回退。

## 1. 截图证据（G-28 双端四图）

| 文件 | identify -format | 观察 |
| --- | --- | --- |
| `ui-py-ext-desktop-viewport.png` | 1440x900 | PC 视口：网站 hub → 运行环境 → Python tab，版本列表（检测到 3.14.4）/ 进程守护 / 虚拟环境可见。 |
| `ui-py-ext-desktop.png` | 1440x1725 | PC 全页：**扩展管理**面板完整可见——副标题「装到插件隔离目录，不碰宿主 site-packages；仅允许字母数字 . _ - 与 ==版本」，输入框 placeholder `requests==2.31.0 flask`，空态「还没有隔离扩展。填好上方包名后点「安装扩展」，包只写进插件状态目录。」 |
| `ui-py-ext-mobile-viewport.png` | 390x844 | 手机精确视口：顶栏图标 + 底部 tab 条，运行环境 tab 高亮。 |
| `ui-py-ext-mobile.png` | 390x844 | 手机端滚动到**扩展管理**面板：标题 / 副标题 / 输入框 / 安装按钮 / 空态文案单列呈现，无横向溢出，触摸目标 ≥44px。 |

四张图 sha256 各不相同（桌面视口 `af563638…` / 桌面全页 `6cde4e63…` / 手机视口 `9cf56ba4…` / 手机面板态 `0ffe4fb9…`），非同图缩放冒充。截图时隔离实例已装并 enable 插件 0.5.0，浏览器真登录 + CSRF 走真实 UI；同一实例上 API 断言 `ext.list → {"prefix":"/var/lib/kore/runtime-python/global/py_ext","packages":[],"count":0,...}` exit 0。

## 2. 自评三问

**问 1：本页解决什么用户问题？**
此前 Python 运行时只能"看版本 / 扫项目 / 建 venv"，想给运行时补几个通用工具包得让用户自己敲 `pip install --user` 或改宿主 site-packages——污染宿主、不可回滚、还要求用户懂命令行。现在在同一个「运行环境」页的 Python tab 里直接填包名即可装进插件隔离目录：看得见（列表）、装得上（`--target` 隔离前缀）、卸得掉（行内「移除」），全程不碰宿主 Python 环境。错误提示给「怎么办」（包名格式 / 超时 / 刷新），空状态给下一步指引，符合易用性四原则。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 有 Python 项目管理 / pip 包管理界面，能切版本、装依赖，但普遍依赖宿主全局环境或常驻进程。本实现走更克制路线：扩展只进插件状态目录、不改宿主 site-packages、不新增 root_action。差距：①包名白名单刻意窄（字母数字 . _ - 与可选 `==版本`，不收 extras / git URL / 镜像源配置）；②没有依赖树可视化 / 版本冲突提示，本次只做装 / 列 / 卸三件事；③移除是隔离目录内受控文件删除而非包管理器卸载（pip uninstall 无 `--target`），不做依赖解析；④需调用方自行把 py_ext 加入 PYTHONPATH，本插件不改宿主环境。这些属有意边界（产品内 runtime 三件套对称补齐，非原文级竞品对标），后续如要补需单独裁决。

**问 3：当前是"可用"还是"占位"？**
**可用（机制层面）。** 判据：①UI 路径——隔离实例真实浏览器登录后 Python tab 渲染出「扩展管理」面板，双端截图肉眼可见输入框 / 按钮 / 空态，页面错误 0；②API 路径——同一隔离实例装 enable 插件后 `ext.list` 返回真实空态（`prefix=<state>/global/py_ext`，count=0，hint 有下一步），后端 `go test -count=1 ./...` + `make check` exit 0（固定 argv / 注入 / 软链逃逸 / 超时 / 截断 / METADATA 解析 / 受控删除 containment 单测全绿）；③前端门禁——`node --check web/runtimes.js` exit 0、`make frontend` 首屏 91092 B ≤ 300 KiB、`usability-check` 无新增 FAIL（存量 1 条 waf e2e 失败系本机 `unshare` 不允许，与本改动无关）。**诚实边界**：真机联网 `pip install`（真从 PyPI 下载）不在本卡验证范围（禁联网业务），P3 真机另卡；本卡不声称真机通过。

## 3. 诚实边界

- 截图里的扩展列表为空态——真装包验证用假执行面单测断言代替（argv / containment / PEP503 归一），未在浏览器里展示"已装包"状态。
- 未改动主实例 8787 的 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`；截图用独立实例，收工已停并删净临时目录与临时二进制。
- 前端主壳 i18n 只有 zh-CN / en-US 两套（非七套）；英文串进懒加载 `en-US.js`（不占首屏预算），七语言指插件自身 `locale/*.json` 与 `DETAIL*.md`。
