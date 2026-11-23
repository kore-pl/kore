> 元信息: 2026-11-23T20:35+08:00 · 执行者 kore-impl-file · G-28 批次 E（file 批量 / 回收站 / 手机「⋯」菜单）· 隔离实例 127.0.0.1:18891（`--config /tmp/kore-file-batch/config.yaml`，state/run/log/root 全在 /tmp，portable）· file 0.3.2（本地 `dist/file-0.3.2.tar.gz`）· chromium-1248 + Playwright

# file 批量 / 回收站 / 手机菜单 —— G-28 双端证据

## 0. 结论

`5a27882` 起的批量删除/批量移动（`file.batch`）、结果分组弹层、回收站三动作与手机「⋯」菜单在真机 chromium 隔离实例上逐条跑通：多选 2 项 → 批量删除得到 **1 成功 + 1 失败** 并分组展示明细；回收站 2 项、彻底删除需勾选二次确认；手机 390×844 下菜单 5 项**每项 44px**、页面横向溢出 0、`pageerror` 0。
**验证中发现并修复 1 个 UI 缺陷**：菜单原本绝对定位在表格容器内，被 `.files-list-host{overflow-x:auto}` 裁剪 → 点「⋯」菜单不显示；改为 `position:fixed` 并按按钮矩形定位（单独提交 `fix(web)`）。

## 1. 方法接线（本轮验证对象，file:line）

| 方法 | 落点 |
| --- | --- |
| `file.batch`（delete） | `web/files-l2.js:364`，成功/失败分组回填 `ui.msg` + 状态条 |
| `file.batch`（move） | `web/files.js:146`（工具栏「批量移动」→ 目标目录弹层） |
| `file.trash.list` | `web/files.js:684`（tab 列表）/ `:664`（进入视图自动发现计数） |
| `file.trash.restore` | `web/files.js:762`（冲突 `:777` 覆盖恢复确认） |
| `file.trash.purge` | `web/files.js:829`（all）/ `:832`（单项），确认层要求勾选「不可恢复」 |
| 手机「⋯」菜单 | `web/files.js:334` 起，`min-height:44px`，`aria-expanded` 同步 |

## 2. 截图证据（`file` 实测宽高）

| 文件 | `file` 实际宽高 | sha256 前 16 | 内容 |
| --- | --- | --- | --- |
| `file-batch-list-desktop-01.png` | **1440 x 900**（full-page） | `3030d04b782ab5bb` | /projects 列表：勾选 notes.md + demo-app（2 项），工具栏「批量移动」「批量删除」均可用 |
| `file-batch-result-desktop-01.png` | **1440 x 900** | `15b1715dc1a61482` | 批量删除结果分组：`成功 1 项：/projects/notes.md；失败 1 项：/projects/demo-app：目录非空，recursive=true 可递归删除`；状态条「成功 1 项 / 失败 1 项（失败项未进回收站）」 |
| `file-batch-trash-desktop-01.png` | **1440 x 900**（full-page） | `d740d69ccb175dad` | 回收站（2 项）：原路径 / 类型 / 大小 / 删除时间 + 行内「恢复」「彻底删除」+ 工具栏「恢复所选 / 彻底删除所选 / 清空回收站」 |
| `file-batch-purge-desktop-01.png` | **1440 x 900** | `8fea27431fcb92a3` | 「彻底删除确认（不可恢复）」二次确认：未勾选时提交按钮 `disabled=true`（实测） |
| `file-batch-menu-mobile-01.png` | **390 x 844** | `b937586816786f04` | 手机 390×844：行操作收进「⋯」，展开菜单（改名/复制到…/权限/移动/删除），5 项高度实测 `[44,44,44,44,44]`，横向溢出 0 |

> 浏览器 `pageerror` 0；console 无意外错误。实例隔离：仅 18891，未读写主实例 8787 的配置/state。

## 3. 产品自评三问（G-28 原文）

**① 本页解决什么用户问题**：批量整理文件时，用户需要「一次勾多个 → 一次删除/移动 → 清楚知道哪几个成功、哪几个失败为什么失败」；手机端按钮太多塞不下、容易点错。现在批量走 `file.batch` 一条请求，弹层按成功/失败分组给明细（失败项保持原样可重试），手机把 7 个行操作收进「⋯」菜单且每项 44px，删错了还能从回收站按原路径恢复。

**② 与宝塔 / 1Panel 同类功能差距**：它们有拖拽多选、目录树、批量重命名/批量压缩/批量权限、显示真实进度条与可取消任务、失败项一键重试；本页已有复选框多选（含全选）、批量删除（进回收站）与批量移动、成功/失败分组明细、回收站恢复/彻底删除、手机「⋯」菜单。**明确没有**：拖拽框选、批量重命名/批量改权限、批量任务进度与取消、失败项一键重试（需重新勾选）。

**③ 当前是「可用」还是「占位」**：**可用**。五个动作都在隔离实例真机跑通并留双端截图：多选可用、批量删除真实产出 1 成功 1 失败且失败原因人话、回收站列表字段齐全、彻底删除必须二次确认、手机菜单 44px 且无横向溢出。未做的拖拽/进度条是能力边界，不是半成品。

## 4. 运行态与清理（G-29）

- 隔离实例：18891，`--config /tmp/kore-file-batch/config.yaml`，state/run/log/root 全部 `/tmp/kore-file-batch`，安装包走本地 `dist/file-0.3.2.tar.gz`；测试后停服并删除 `/tmp/kore-file-batch`。
- 主实例 8787：**零写入**（未重启、未读写 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`、未调用其 API）。
- `make frontend && make build` 重写了 `bin/kored`（前端修复需重新 embed）；在跑的 8787 进程持有旧 inode，不受影响，未主动重启。
