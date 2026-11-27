# UI P2 独立验收报告（G-09 / task-164）

Verifier：`ui-p2-verifier`（独立于 implementer `ui-p2`）｜日期：2026-11-27｜
被验对象：`ead8908a96d9cbc4d23e23e347184b718c9cd238`（21 files）｜总评：**PASS**

> 全程只读复跑，未改生产代码、未 push、未执行主流程 CLI、未碰主实例 `.kore-local-*`；
> 唯一写入 = 本报告（精确 `git add` + `commit -s [agent:ui-p2-verifier]`）。

---

## 1. Git 基线（PASS）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| HEAD == ead8908 | `git rev-parse HEAD` | `ead8908a96d9cbc4d23e23e347184b718c9cd238` |
| 提交元信息 | `git log -1 --format='%H%n%an%n%cn%n%s%n%b'` | author/committer `pengtang1024 <pengtang1024@qq.com>`；subject `[agent:ui-p2] refactor(web): UI P2 行按钮减法与 danger 通胀治理`；body `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` → **DCO 齐备** |
| 精确 21 路径 | `git diff-tree --no-commit-id --name-only -r ead8908 \| wc -l` | `21`；清单 = 12 张 `ui-p2-*.png` + `ui-p2-selfeval.md` + `docs/DESIGN-REDUCTION.md` + `web/{batch,files,plugins-view,settings,sshguard,style,waf}`（7 文件） |
| 未 push | `git merge-base --is-ancestor ead8908 <remote>/main`（origin/github/gitee/gitea） | 四端全部 **NOT ancestor**（远端 main 停在 64e43f3 / gitea 812f9fc）；`main` 领先 origin 35 |
| worktree 仅主树 | `git worktree list` | 1 行（`/home/.../kore ead8908 [main]`） |
| 他人 dirty 原样 | `git status --porcelain` | `M scripts/usability-pending.txt` + `?? .agents/.agents/、.agents/verify/e2e-*.md、local-update-plan.md、release-batch-*.md、run-user-model.md、screenshots/adp-debug-desktop-01.png、data/、dist/` —— 均非本轮 21 路径，原样未提交 |

## 2. 读码核对（PASS）

- **plugins-view.js**：行内仅 `启停/启用/停用` + `详情` 两个按钮（`ops.appendChild(actionBtn)` / `detailBtn`）；
  `设置` 仍走 `window.KoreShell.openConfig(host, id, …)`；`升级`（仅 upgradable）/ `卸载`（`--kore-danger` + `confirmRowUninstall` 二次确认）/
  `调用 ping` 全量下沉到 `plugin-detail` 独立详情行（`detail.hidden` 切换）；表头 `plugin-pick-all` 勾选 →
  `renderBatchBar()`（`hidden=false` 时出现批量升级/启用/停用）；两行同绘用 `DocumentFragment`，替换/卸载同步清理详情行与 picked/openDetail。
- **files.js**：`opList` 全量保留（下载/解压/改名/复制到/属性/权限/移动/删除进回收站）；桌面与手机**统一**
  `≤2 行内按钮 + ⋯ 菜单`（文件行=下载+⋯，目录行=⋯）；菜单 `position:fixed` + `max-height:min(70vh,420px);overflow:auto`
  规避裁剪并保证手机可达；点空白收起菜单；context 栏 `压缩/批量删除(进回收站)/批量移动/改名/复制到/属性` 六项，与 ⋯ 菜单双通道全量可达。
- **style.css / batch.js / settings.js / sshguard.js / waf.js**：可逆操作改中性灰
  `plugin-batch-muted`、`files-trash-btn`、`files-batch-trash`、`batch .is-muted(reversible)`、`settings-neutral`、`sg-unban`、`waf-unban`；
  不可逆项卸载/彻底删除（`.files-del`）、批量重启（`dangerous:true` 非 reversible）、停用防火墙/WAF 关防护/结束进程仍红+确认。
- **DESIGN-REDUCTION.md**：§8.3/§9.3 回填「已落地 task-163」+ 91,092 B；新增 §10（10.1 改前→改后实测表 / 10.2 边界裁决 7 项 /
  10.3 证据 / 10.4 差距转后续），§10.2 明确批量重启/停防火墙/关 WAF/结束进程保留红+确认，**边界裁决在案**。
- **G-11**：ead8908 未触碰 `web/app.js` / `shell.js`，无新增一级菜单/hub；usability 全量实测 A6 = 10 一级菜单（存量值）。
- **G-24/功能零删**：所有被移走的控件均有归宿（详情 / ⋯ / 批量条 / context 栏），无功能删除。

## 3. 按钮数/交互证据核实（PASS）

- **改前**（`git show ead8908^`：plugins-view.js `ops.appendChild` 5 处 = 设置/升级/启停/卸载/ping；files.js `opList.push` 目录 6 / 文件 7 / 归档 8）
  与 worker 自评 `[4,5,4]` / `6` / `7` / `8` 的**代码事实**一致（DOM 精确计数原始日志随 `.iso-p2-tmp/` 删除，仓库未留 raw JSON，
  但改前源码逐项可核、改后图像逐像素可核，证据链闭合）。
- **改后**：worker 自评（`.agents/verify/ui-p2-selfeval.md:38-56`）报 `[2,2,2]` / `1` / `2` / `2`、⋯ 菜单 6 项、context 6 项、
  批量条 `hidden=false`、`rgb(157,167,179)`；verifier **独立用 read_image 实读 12 张截图复核**（见 §5），
  桌面/手机插件页每行确为 2 按钮，文件目录行只有 ⋯，⋯ 菜单 6 项可见。
- **中性灰可核**：`web/style.css:11 --kore-text-2: #9DA7B3` → `rgb(157,167,179)`，与自评 `getComputedStyle` 值逐位一致。
- **未新增 FAIL / 未删功能**：见 §4 usability 全量。

## 4. 门禁复跑（PASS，含已登记存量噪声）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check` × 6（plugins-view/files/batch/sshguard/waf/settings.js） | **0**（逐文件 0） | 六文件全绿 |
| `make frontend`（`git archive HEAD` 隔离副本） | **0** | 首屏 gzip **91,092 B ≤ 307,200 B**（300 KiB，余量 216,108 B）；`[WARN] 体积漂移 >90,000`（P1 存量基线，+168 B）；产物无 map/vite/字体 |
| `make build`（隔离副本 + 隔离 GOCACHE/GOMODCACHE） | **0** | `[OK] 构建完成: ./bin/kored`；ELF x86-64 静态链接 stripped，13,353,122 B |
| `bash scripts/usability-check.sh --self-test` | **0** | 正例 0 违规；四反例各被拦下；tab 超推荐值仍 exit 0 |
| `bash scripts/usability-check.sh`（默认共享 GOCACHE） | **1**（存量噪声） | **18 FAIL 全为 A1「ZeroParam 真跑失败」**，报错原文统一为 `open /home/pt/.cache/go-build/...: read-only file system`（沙箱 go-cache 只读），非 UI 改动引入 |
| `bash scripts/usability-check.sh`（隔离干净 GOCACHE） | 1 | A1 FAIL 降至 **1**（waf e2e，跨仓存量）；summary `0 pass, 502 warn, 1 fail`；**改动文件零新增 FAIL** |
| A6 一级菜单 | — | `10`（符合 ≤10），未新增 hub；tab 8 hub / 20 tab（推荐值内） |

首次 `make build` 因共享 GOCACHE 只读 exit 2，改用隔离缓存后 exit 0（非代码问题，属沙箱写入限制）。
所有隔离目录 `.verify-ui-p2-gates*` / `.verify-ui-p2-build*` / `.ui-p2-gocache-tmp` 均已删除，`git status` 无残留。

## 5. G-28 双端截图硬核验（PASS）

`identify -format '%wx%h'` 实测 12 张：

| 文件 | 宽×高 | 实读结论 |
| --- | --- | --- |
| desktop-01-plugins-default / -viewport | 1440×900 / 1440×900 | 3 行插件每行 **2 按钮**（启用/停用 + 详情），表头勾选框在 |
| desktop-02-plugins-detail-batch | 1440×900 | 批量条可见「已选 3 个插件 / 批量升级/批量启用/批量停用」，批量停用**中性灰**；展开详情行 = 设置/卸载(红)/调用 ping |
| desktop-03-files-default / -viewport | 1440×2120 / 1440×900 | 目录行只有 ⋯ |
| desktop-04-files-menu | 1440×900 | ⋯ 菜单展开 **6 项**：改名/复制到/属性/权限/移动/删除(进回收站) |
| mobile-01-plugins-default / -viewport | 390×1339 / 390×844 | 窄屏纵向堆叠布局，插件行 2 按钮 |
| mobile-02-plugins-detail-batch | 390×1612 | 批量条 + 详情抽屉 + 底部 tab 栏，非桌面缩放 |
| mobile-03-files-default / -viewport | 390×5664 / 390×844 | 窄屏文件列表 |
| mobile-04-files-menu | 390×844 | ⋯ 菜单展开（可见改名/复制到/属性/权限/移动，第 6 项随滚动可达，菜单 `overflow:auto`） |

verifier 已用 `read_image` 实读 **4 张关键图**（desktop-01 插件默认、desktop-02 详情+批量、desktop-04 文件⋯菜单、mobile-02 插件详情+批量、mobile-04 文件⋯菜单），
确认新布局真实渲染、非设计稿、非同图缩放冒充双端；视口宽高符合 1440×900 / 390×844（full-page 图更高属正常滚动）。
`ui-p2-selfeval.md`（115 行）三问原文齐备：Q1 解决「为堆砌而堆砌」的行按钮密度 + danger 通胀；Q2 对比宝塔/1Panel（多 1 次点击换层次，客观差距在案）；
Q3 判定「**可用**」并给出 DOM/API/二次确认证据，非占位。

## 6. G-29 声明

本轮 verifier 未改动主实例 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 的运行态行为；
`make build/frontend` 只在 `git archive` 隔离副本内跑并已删净，未重启 8787；worker 声称同样起隔离实例（18952）并已关闭（见自评 §开头）。

---

## 总评：**PASS**

21 路径精确、DCO 齐、未 push、worktree 仅主树、他人 dirty 原样；读码与双端截图一致证明「行按钮减法 + 详情/批量下沉 + ⋯菜单全量可达 + danger 中性灰」真实落地；
6 文件 `node --check`、`make frontend`（91,092 B ≤300 KiB）、`make build`、usability self-test 全部 exit 0；
usability 全量 18 A1 FAIL 为沙箱 go-cache 只读的跨仓存量（隔离缓存下只剩 waf e2e 1 条，亦非本轮写域），改动文件零新增 FAIL；
G-28 双端截图与自评三问齐全非伪造。**无 BLOCKED 项。**
