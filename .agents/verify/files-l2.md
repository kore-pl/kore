> 元信息: 2026-11-23T16:50+08:00 · 执行者 kore-impl-file-web（implementer）· 文件视图 `web/files.js`（~900 行）+ 懒加载 `web/files-l2.js`（370 行）· 隔离实例 `127.0.0.1:18879`（`--config /tmp/kore-file-ui/config.yaml`，state/run/log/root 全在 `/tmp/kore-file-ui`，index 指向 `kore-plugins/index`）· 主实例 8787 本轮**零写入**（仅在开工前对它做过 healthz/system-info 两个只读 GET） · 真机 chromium-1248（Playwright 驱动）双端截图 · 报告 ≤100 行

# 文件视图 L2→L3 前端接线验收（19 方法全接线 + G-28 双端截图）

## 0. 结论

后端 19 个方法**全部有 UI 落点**：本轮补上 `file.rename` / `file.copy` / `file.search` / `file.trash.list` / `file.trash.restore` / `file.trash.purge` 六个方法，
并把 `file.delete` 的**默认进回收站**语义写进确认框与状态文案。真机 chromium 隔离实例实测 5 条主链路全通过
（行内改名、目录选择器复制、按内容搜索、删除进回收站、彻底删除二次确认），`page_errors=0`、手机端横向溢出 0、触摸目标 <44px 计 0。
**未做**：push（按任务卡）；`docs/FRONTEND.md` 的能力描述未同步（不在本轮写域，见 §7）。

## 1. 六个方法的 UI 落点（file:line）

| 方法 | 界面入口 | 调用点 | 交互要点 |
| --- | --- | --- | --- |
| `file.rename` | 行内双击文件名 `web/files.js:295`；操作列「改名」`web/files.js:300`；工具栏「改名」（勾选/点选单条时启用）`web/files.js:801-816` | `web/files.js:748` | **行内改名不弹窗**：Enter 保存 / Esc 取消，只允许同目录单段名字，非法名字（含 `/`、`\`、`..`、`.trash`）就地提示 |
| `file.copy` | 操作列「复制」`web/files.js:303`；工具栏「复制到」`web/files.js:817-826` → 懒加载 `runL2('copy')` | `web/files-l2.js:318`（弹层 `web/files-l2.js:263-330`） | **目录选择器**：弹层内 `file.list` 浏览目录、「上一级」、「进入 xxx/」、「复制到这里」，不手写路径；`覆盖同名目标` 显式勾选 |
| `file.search` | 顶部搜索条 `web/files.js:803-825`（两个预设：按文件名 / 按内容） | `web/files.js:470` | 按文件名支持 `*` 通配，裸词自动包 `*词*`；按内容只搜文本文件；结果行内 `<mark>` 高亮、内容命中给「第 N 行 + 预览」；`truncated` 时提示缩小范围 |
| `file.trash.list` | 面板头「文件 / 回收站（N）」tab `web/files.js:855-858`；进视图自动探测 `web/files.js:546`（limit=1 只取 total） | `web/files.js:566` | 回收站视图列原路径 / 类型 / 大小 / 删除时间 / 操作；非空时状态条提示「回收站有 N 项可恢复」 |
| `file.trash.restore` | 行内「恢复」`web/files.js:626`；工具栏「恢复所选」`web/files.js:586` | `web/files.js:644`（冲突时 `:659` 显式覆盖恢复） | 批量逐项恢复；原路径被占用时先收集冲突，再弹**覆盖恢复确认**（不静默覆盖） |
| `file.trash.purge` | 行内「彻底删除」`web/files.js:629`；「彻底删除所选」`web/files.js:589`；「清空回收站」`web/files.js:592` | `web/files.js:711`（all）/ `:714`（单项）；确认层 `web/files.js:672-727` | **必须二次确认**：弹层标题「彻底删除确认（不可恢复）」+ 文案说明无法找回 + 复选框「我已知晓：彻底删除后无法恢复」，未勾选时提交按钮 `disabled` |

另：`file.batch` 的现有入口（批量删除）保留在 `files-l2.js`，删除文案同步改为「移入回收站、可在回收站恢复」。

## 2. 「删除进回收站」语义怎么体现（四处一致）

1. **确认框**（`web/files.js:138-150`）：「将把 /x 移入回收站，可在本页『回收站』里恢复。彻底删除需要到回收站里再操作一次。」
2. **成功状态**（`web/files.js:143`）：「已移入回收站：/x（可恢复）」，并立即刷新回收站计数。
3. **批量删除**（`web/files-l2.js:246` 附近）：标题「移入回收站确认」、按钮「移入回收站」，成功文案「已移入回收站：N 项（可在『回收站』恢复）」。
4. **回收站视图**：tab 带计数、列表给「恢复 / 彻底删除」两条明确动作，彻底删除才走不可恢复确认——**前端不存在一处能一次点击就永久删除**。

## 3. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/files.js` | **0** | 无输出 |
| `node --check web/files-l2.js` | **0** | 无输出 |
| `make frontend` | **0** | 首屏 gzip **59,539 B ≤ 307,200**；i18n 增量 **2,813 ≤ 3,072** |
| `make build` | **0** | `[OK] 构建完成: ./bin/kored` |
| `make secret-check` | **0** | `0 FAIL / 7 处匹配（占位写法均合规）` |

未跑 `go vet`/`go test`：本轮只改 `web/*.js`（零 Go 逻辑变更），`make build` 已证明 embed 与产物自洽。

## 4. G-28 双端截图（`file` 实测宽高）

| 文件 | `file` 实际宽高 | sha256 前 16 | 证据点 |
| --- | --- | --- | --- |
| `files-l2-search-desktop-01.png` | **1440 x 900**（full-page） | `85e97986e4f1f306` | 按内容搜 `timeout`：5 项命中、`第 2 行` + 高亮预览、tab「文件 / 回收站」、搜索预设按钮（按内容高亮） |
| `files-l2-trash-desktop-01.png` | **1440 x 900**（full-page） | `1d33459782fadcf1` | 回收站视图：tab「回收站（1）」、原路径/类型/大小/删除时间、行内「恢复 / 彻底删除」、目录工具栏已隐藏（`getComputedStyle` 实测 `display:none`） |
| `files-l2-purge-confirm-desktop-01.png` | **1440 x 900** | `4278c1171935d7b5` | 彻底删除确认层：标题含「不可恢复」、复选框未勾选时提交 `disabled=true`（实测） |
| `files-l2-copy-picker-desktop-01.png` | **1440 x 900**（full-page） | `3ba28d936c097224` | 复制到目录选择器：源路径、目标目录 `/projects`、「上一级」「进入 demo-app/」、覆盖同名、`复制到这里` |
| `files-l2-search-mobile-01.png` | **390 x 844** | `d491fd9c5eafd961` | 手机：搜索预设 + 输入 + 结果卡片（`data-label` 列名）；横向溢出 **0 px**、`.files` 内触摸目标 <44px **0 个** |

> 截图方法：chromium-1248 + Playwright 1.65.1（`executablePath` 指向缓存浏览器，零新依赖）；桌面 `fullPage: true`，手机固定 390×844 视口。
> 浏览器 `pageerror` **0**；console 仅 4 条预期 404（隔离实例未装 site/monitor/ssl/discover，各视图首帧探测）。

## 5. 产品定位自评（G-28 三问原文）

**① 本页解决什么用户问题**：运维者不是天天 `ls`，而是「找一份文件、改个名、把误删的捞回来」——以前面板只给「浏览 + 上传下载 + 删除」，删错了只能 SSH 上机翻备份。现在文件页把「搜索（按名字/按内容）、同目录改名、复制到、删除进回收站 + 可恢复/彻底删除」收进一个视图：搜索两个预设不用记语法，改名双击就地完成，误删能在同页捞回，彻底删除必须勾选「不可恢复」才生效。

**② 与宝塔 / 1Panel 同类功能的差距**：它们还有：目录树侧栏/多选拖拽、在线代码编辑器（语法高亮/保存）、压缩包在线预览、文件权限与属主的图形化编辑、跨目录批量复制粘贴、大文件分片上传与断点续传、按内容搜索（grep 全盘 + 正则）。本页已有：名字/内容两种搜索（限定当前目录、内容搜索 ≤1 MiB/文件）、行内改名、目录选择器复制、回收站三动作、批量删除进回收站。**明确没有**：目录树、在线编辑器、断点续传/分片（后端方法也还没有）、正则搜索、跨目录多选移动（有「移动」单条）。

**③ 当前是「可用」还是「占位」**：**可用（非占位）**。六个方法都接了真实后端并在隔离实例真机跑通（改名→列表出现新名、复制→根目录出现副本、内容搜索→5 条真实命中带行号与高亮、删除→回收站计数 1、彻底删除→需勾选且行数 1→0），双端截图与触摸/溢出量测齐全；错误路径给后端原文 + 「怎么办」（如改名含 `/` 提示「只支持同目录改名；换目录请用移动」）。未做的目录树/编辑器/断点续传是能力边界，不是半成品。

## 6. 本轮验证发现并修复的缺陷

1. **P1 回收站复选框勾不上**：`updateSelection()` 无差别把 `.files-checkbox` 按 `data-path` 回写，回收站复选框没有该属性 → 勾选瞬间被重置为 false（Playwright `check()` 直接报「点击后状态未改变」抓到）。修：只在非回收站视图回写（`web/files.js:196-205`（原为无差别回写））。
2. **P2 回收站里仍显示目录工具条与旧搜索词**：切到回收站后「上传/压缩/新建 + 根目录/logs 面包屑 + 上次搜索词」还在，容易误操作。修：`setToolbars()` 用 `style.display` 切换（`.files-toolbar` 自带 `display:flex`，`[hidden]` 会被压掉——与 container 视图同款 P0 教训）；进回收站隐藏、回文件/搜索显示。
3. **P2 切回「文件」tab 保留旧搜索态**：搜索框还留着上次关键词与「清除搜索」消失但输入不空。修：切 tab 时清空搜索态与输入。
4. **P2 工具栏「改名 / 复制到」点不动**：行上没有 `dataset.path`（列表行实际用 `data-entry-path` 属性），工具栏按 `dataset.path` 找不到行 → 点击无反应；且点选文件后未刷新按钮态（首次实测按钮一直 disabled）。修：按 `data-entry-path` 查找 + 选中时补 `updateSelection()`（`web/files.js:801-826`、`:196-205`）。
5. **P2 手机命中行竖排**：窄列里「第 2 行：+ 长预览」被挤成多行。修：`narrowPreview()` 在 <640px 时围绕关键词截 40 字符，行号去掉冒号。

## 7. 已知缺口 / 未做（如实）

1. **未 push**（任务卡明确不 push）；提交只含 `web/files.js web/files-l2.js .agents/verify/files-l2.md` + 5 张截图。
2. **`docs/FRONTEND.md` 未同步**：该文件第 259 行仍把 `files-l2.js` 描述为「上传/下载/压缩/解压/改权限/移动」（未含 copy），视图清单未提搜索/回收站/改名。属 G-06 文档同步范畴，但不在本任务写域（`web/files.js` / `web/files-l2.js`），建议 follow-up 一并补。
3. **改名不支持覆盖**：目标同名时后端回 `E_CONFLICT`，前端提示换名（改名场景覆盖语义弱，未开 `overwrite`）；复制/移动/恢复都有显式覆盖选项。
4. **搜索范围限当前目录**（可进子目录再搜），未做全根递归；内容搜索跳过 >1 MiB 与二进制（后端契约），UI 已说明。
5. **回收站列表上限 200 条**（后端 `limit` 口径），超出只显示最近 200 并提示。
6. **主实例运行态**：本轮未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`，对 8787 只有开工前 `/-/healthz` 与 `/api/v1/system/info` 两个只读 GET（无写请求、无插件调用）；`bin/kored` 由任务要求的 `make build` 重建（构建时无进程持有，Linux rename 语义不影响任何在跑进程）。

## 8. 隔离实例与清理

- 起服：`KORE_FILE_ROOT=/tmp/kore-file-ui/root ./bin/kored serve --config /tmp/kore-file-ui/config.yaml` → `/-/healthz` 200；`paths` 全在 `/tmp/kore-file-ui`，`index_dir=kore-plugins/index`（验签通过）。
- 装插件：`POST /api/v1/store/install {"id":"file","version":"0.3.0","package_path":"…/dist/file-0.3.0.tar.gz"}` → `state:succeeded`；`POST /plugins/file/enable` → `enabled:true`（method_capabilities 19 条随插件下发，实测响应含 `file.trash.*`）。
- 演示数据：`docs/`、`logs/app-2026-11-2*.log`（含 `timeout` 行）、`projects/{notes.md,demo-app}`，全部真实文件。
- 收尾：kored 已停、`/tmp/kore-file-ui` 已删（口令为一次性随机值，只存在于已删除的 0600 文件，**未落档、未进报告**）。
