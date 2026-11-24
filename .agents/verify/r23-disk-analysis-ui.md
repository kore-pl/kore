# R23 G-28 双端截图 · 磁盘分析页

日期：2026-11-24 19:30–19:35（Asia/Shanghai）｜Owner：`r23-disk`（🔵 美团味）｜对象：接线后 HEAD `3fcf520`（integration 统一接线：files hub 子视图 `disk-analysis`）｜端口 **18893**

> ▎[🔵 美团味] 做难而正确的事。截图必须是真登录、真进「文件管理 → 磁盘分析」tab、真点「开始扫描」后占比环有数据的实图——不是 idle 空壳，不是设计稿，不是同图缩放。两端都是 6 段占比环 + 带单位图例 + 大文件 Top3 + 可清理建议的真实渲染。

## 0. 结论先行

磁盘分析页 G-28 双端证据齐：**PC 1440×900 ×1 + 手机 390×844 ×1**，`identify` 实测宽高精确匹配，两图 `paths=6`（占比环 6 段真实 SVG 渲染）、页面 JS 错误 `errs=0`。产品定位自评三问 + G-29 声明齐备。**证据齐，声明完成。**

## 1. 隔离实例（G-29：主实例 8787 零改动）

按 lead 裁决走 `git archive` 隔离实例，配置/state/run/log 全落 `/tmp`，独立端口 18893；未重启、未改主配置、未覆盖主 `bin/kored`、不用任何共享桌面窗口。

```text
$ git log -1 --format='%h %s'    # 接线后 HEAD
输出: 3fcf520 [agent:r23-integration] feat(web): 统一注册 R23 第二批8个新视图导航与接线
$ git show 3fcf520:web/app.js | grep -n 'disk-analysis'
输出: 2185: 'disk-analysis': ['KoreDiskAnalysis', '/assets/disk-analysis.js', 'nav.diskAnalysis', '磁盘分析']
      2215: { sub: 'disk-analysis' }        # files hub 子视图，注册核验通过（避免 404）
$ git archive 3fcf520 | tar -C /tmp/kore-g28-disk.XXX/src -xf -
$ cd /tmp/kore-g28-disk.XXX/src && make web-dist && \
    CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false \
      -ldflags '-s -w' -o kored ./cmd/kored
退出码: 0（归档源码含接线后的 dist/disk-analysis.js，独立二进制全路径落 /tmp）
$ kored admin-password --set --stdin --config <隔离 seed.yaml>   # 随机口令，报告 *** 占位
$ kored serve --config <隔离 config.yaml>                        # 127.0.0.1:18893
$ curl -fsS http://127.0.0.1:18893/-/healthz → 200
$ POST /api/v1/auth/login → {"authenticated":true}（HttpOnly session + 可读 CSRF 双提交）
```

**蓝军自检「拍到旧界面/空壳」证伪**：截图 DOM 读到本视图独有文案「磁盘分析 / 看看哪个目录在吃磁盘、能清什么」「目录占用 · 日志」「大文件 Top 3」「可安全清理什么」，导航高亮在「文件管理」+ 子 tab「磁盘分析」；且 `.kore-da-ring path` 实测 6 段、`errs=0`。非本视图或非交互后渲染不可能出现这些证据。

## 2. 截图与尺寸实测

| 端 | 文件 | 尺寸（identify 实测） | 字节 | 页面错误 |
| --- | --- | --- | --- | --- |
| PC | `disk-analysis-desktop-01.png` | 1440×900（full-page） | 117883 | 0 |
| 手机 | `disk-analysis-mobile-01.png` | 390×844 | 57956 | 0 |

两图均通过 playwright 真实浏览器：登录 → `#/files/disk-analysis`（等价点击「文件管理 → 磁盘分析」tab）→ 关首次引导遮罩 → 接受 confirm → 点「开始扫描」→ 等 `.kore-da-ring path` 出现（≥2 段断言）→ 截图。交互后 6 段占比环 + 图例带单位 + Top3 + 建议全渲染。

**mock 数据说明（诚实披露）**：隔离实例为最小配置、无真实日志目录大文件，为使占比环/TopN/建议有可读数据、满足 G-28「真实图表实例而非空容器」，用 playwright `page.route` 对 `**/api/v1/system/disk-usage*` 注入一份有 6 目录 + 3 大文件 + 1 建议的桩数据（结构与后端显式 schema 一致：bytes/mod_time/route 等字段齐全）。页面逻辑、SVG 渲染、跳转按钮、响应式布局均为真实代码路径，仅后端数据源为桩。G-28 关注的是 UI 呈现与交互，此处如实标注。

## 3. 产品定位自评三问

1. **本页解决什么用户问题**：monitor 插件只采磁盘总量百分比，用户看不到"哪个目录在吃盘、能清什么"。本页把目录占用（系统/日志/备份/插件/站点/临时）可视化成占比环 + 大文件 TopN + 可清理建议（旧日志/过期备份/临时文件）并给跳转，把"知道盘满了"变成"知道清哪里"。
2. **与宝塔 / 1Panel 同类功能差距**：宝塔「磁盘管理」/ 1Panel 有更深的目录树下钻、文件预览与直接删除；本页当前是**只读分析 + 跳转**：树状列表按顶层目录聚合（≤12 节点）、TopN 10 条、清理建议落到现有日志/备份/文件页，不在本页直接删文件（守 G-31 零侵入 + 危险操作只给跳转）。属于"够用的诊断入口"，深度不及商业面板，但零常驻进程、零侵入、纯增量。
3. **当前"可用"还是"占位"**：**可用**。数据、图表、TopN、建议、跳转、空态/失败态、确认+进度+超时、手机适配均已实现；数据来自真实只读扫描端点（隔离实例截图用桩数据仅为 G-28 呈现）。未做：目录树多级下钻、点击大文件定位（列为后续增强，非占位）。

## 4. G-29 / 收尾声明

- 本轮**未改动主实例运行态**（`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / 主 `bin/kored` 零写入；8787 未重启、未改配置）。
- 隔离实例随脚本 trap 结束：`18893` 端口已释放（ss 复核无监听）、`/tmp/kore-g28-disk.*` 无残留、一次性截图脚本 `.g28-disk-shot.sh` 已删除、`.git/info/exclude` 临时条目已清理。
- 截图存 `.agents/verify/screenshots/disk-analysis-{desktop,mobile}-01.png`，md5 相异（不同端不同图，非同图缩放）。

## 5. 验收命令汇总

```text
node --check web/disk-analysis.js                 → exit 0
GOWORK=off go build ./...                          → exit 0
bash scripts/frontend-check.sh                     → exit 0（首屏 77175 ≤ 307200）
git show --stat 1a618ee                            → 3 files / 794 insertions（模块 commit）
git show --stat 3fcf520                            → 接线四文件（integration）
identify -format '%w %h' disk-analysis-*.png       → 1440 900 / 390 844
playwright 交互截图                                 → paths=6 errs=0（双端）
```
