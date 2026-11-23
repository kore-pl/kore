> 元信息: 2026-11-23T10:05+08:00 · 执行者 r6-runtime-ui · 统一「运行环境」页（Node/PHP/Python）· 真机 8787 + 双端截图 · 报告 ≤70 行

# 运行环境页（`web/runtimes.js`）验收

## 1. 实现

- `web/runtimes.js`（**313 行**，零框架 / 零 CDN / 无外链）：Node.js / PHP / Python 三 tab 同页切换，只重绘本页、不换 hash、不重载文档；版本行点击就地展开单版本详情。
- 调用形态：`POST /api/v1/invoke/runtime-<lang>/runtime-<lang>.{versions,info,projects,doctor}`（完整限定名；四个方法全部只读，页面无写入请求）。
- 每 tab 的扫描根目录写 `localStorage['kore.runtimes.root.<tab>']`，输入框预设 `/var/www`、`/opt`、`/home`。
- 导航：`shell.js` 业务组新增「运行环境」；与 integrity 那路并行改动按**行级插入**合并，最终导航 **18 项**（运维 5 / 业务 5 / 资源 3 / 平台 5）。
- `Makefile` / `web/embed.go` / `docs/FRONTEND.md` 已同步（最终计数 28 文件 / 16 视图模块 / 18 项导航，与 integrity 那路统一 bump）。

## 2. 三 tab 真机数据（8787，`bin/kored` 10:02 重启，PID 2461308）

| tab | 真实结果 |
| --- | --- |
| Node.js | 检测到 1 个 Node，默认 24.21.0；npm 11.19.0 / V8 13.6.233.17-node.53 / OpenSSL 3.5.8 / 全局包 7 |
| PHP | 未检测到 PHP（空态 + `apt install php-cli` / `phpenv install` / php.net 指引）；doctor 4 fail + 1 warn，fail 行显示「修复命令：apt install php-cli」 |
| Python | 检测到 1 个 Python，默认 3.14.4；pip 25.1.1 / site-packages `/usr/local/lib/python3.14/dist-packages` / 已装包 103 / venv 可用 |

- 项目扫描：`/home/pt/kore-rt-demo`（package.json + package-lock.json）→ 1 项，依赖数 2、锁文件「有」；同目录 pyproject.toml 被 Python tab 扫到（依赖数 2、venv「有」）。
- doctor：Node 4 项（3 pass + `NODE_ENV` warn，warn 行显示 `export NODE_ENV=production`）；PHP 5 项（4 fail + 1 warn），fail 的修复命令可见。
- USABILITY：tab 切换后 `window.__rtMarker` 仍存活（no_reload=true，navigation entries=1）；`localStorage` 根目录回读一致；console error 0、uncaught 0。

## 3. 截图（8 张，`identify` 实测）

| 文件 | 尺寸 | 场景 |
| --- | --- | --- |
| `rt-node-desktop.png` | 1440x1054 | Node 版本详情 + 项目扫描 + doctor |
| `rt-node-mobile.png` | 390x844 | 同上（手机） |
| `rt-php-empty-desktop.png` | 1440x901 | PHP 空态 + 安装指引 + 4 fail 修复命令 |
| `rt-php-empty-mobile.png` | 390x844 | 同上（手机） |
| `rt-python-desktop.png` | 1440x1127 | Python 3.14.4 + pip 25.1.1 + 103 包 |
| `rt-python-mobile.png` | 390x844 | 同上（手机） |
| `rt-doctor-desktop.png` | 1440x1054 | Node 检查项（warn + 修复命令） |
| `rt-doctor-mobile.png` | 390x844 | 检查项列表（手机） |

- sha256 前 12 位：node `97c0ba308750` / `8fe5d18e6c5e`、php `9fb2bf4c34f0` / `39e80db02cb2`、python `63ac287b32ec` / `319c1f5ed2a9`、doctor `bae6f7d220fd` / `f2f947a38881`；8 张两两不同。
- 桌面为 1440 宽 full-page，手机为 390×844 viewport；未用同图缩放冒充双端。
- **G-28 自评**：①本页解决「三种运行时已安装但前端零入口」——装机后一页看清版本、单版本详情、项目依赖与体检，不用回终端敲命令；②与宝塔 / 1Panel 差距：覆盖了它们「运行时版本 + 项目依赖」主干，缺安装 / 切换默认版本 / 扩展管理与建站联动，当前是**可用**而非占位；③下一步：运行时安装与默认切换、PHP 扩展安装、项目依赖一键安装。

## 4. 导航冲突处理

- 与 `r6-integrity-ui` 撞同一批共享文件（`web/shell.js`、`Makefile`、`web/embed.go`、`docs/FRONTEND.md`）。约定：两边只做最小行级插入、不整文件重写；最终 `shell.js` 同时含 runtimes 与 integrity 接线，计数在 integrity 那笔统一 bump 到 28 / 16 / 18。
- 本提交内容：`web/runtimes.js` + 本报告 + 8 张截图；共享文件接线随 integrity 提交（见回报中的后续 hash）。

## 5. 首屏与门禁

- 首屏 gzip（`make frontend`，最终树）：index 683 + style.css 16997 + app.js 18718 + shell.js 9842 = **46240 B ≤ 307200 B（300 KiB）**，余量 260960 B；dist 无 map / .vite / 全量字体。
- `node --check web/runtimes.js` exit 0；`make frontend` exit 0；`make docs-check` exit 0（5 pass / 1 warn）；`make check` exit 0（11 段全过）。
- 真机：`make build` 后同配置重启 8787（`GET /-/healthz` 200、`GET /assets/runtimes.js` 200）；**未改** `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`，`system/info.paths.index_dir` 仍等于配置的 `kore-plugins/index`。本轮运行态动作只有重建 `bin/kored` + 重启主实例，以加载新嵌入前端。
- 测试项目 `/home/pt/kore-rt-demo` 已在截图后删除；登录口令未写入本报告。

## 6. 复盘

- 弯路：登录后只改 hash 的导航不会重载文档，页面停在登录页；改为带 query 的完整加载后复现——验证脚本必须区分 hash 路由与文档加载。
- 沉淀：插件业务方法一律完整限定名；doctor 的 detail 原样展示并用正则提取修复命令，不替插件编造结论。
