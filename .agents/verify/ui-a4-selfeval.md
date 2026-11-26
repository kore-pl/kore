> 元信息: 2026-11-26 · 执行者 ui-a4 · G-28 双端证据 · A4「实例」术语清理（task-96）

# A4 用户文案白话化自评（全局搜索 · 数据库空来源）

## 0. 改动
`web/search.js:939`：`没有配置数据库实例，这个来源暂时没有内容。` → `还没有添加数据库连接，这个来源暂时没有内容。`
依据 `docs/USABILITY.md` §4.1 术语对照表「实例 / instance → 数据库连接」逐字选词，未臆造、未改逻辑、未改其它字符串。`capability.denied` 三处（`alerts.js:23/158`、`app.js:1238`）核实为**审计 action 标识符**（比较条件 `r.action === action` / 字典 key），展示文案已是「权限不足被拒绝」，改 key 会破坏审计匹配逻辑并新增 A4 风险，故保留不动（`usability-pending.txt` 既有 A4 豁免行保留）。

## 1. 门禁
| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `bash scripts/usability-check.sh`（改前基线） | 1 | A4 FAIL=1（`search.js:939`）、A4 WARN=3（capability.denied 存量）；总 FAIL=74（A1 18 + A3 55 + A4 1） |
| `bash scripts/usability-check.sh`（改后） | 1 | **A4 FAIL=0**、A4 WARN=3 不变；总 FAIL=73（A1 18 + A3 55 + G-33 汇总 1） |
| `node --check web/search.js` | 0 | 语法正确 |
| `make frontend` | 0 | 首屏 gzip 81528B ≤ 307200B；search.js 懒加载、不进首屏预算 |

- 说明：任务卡预期「总 FAIL 56→55」按当时工作树基线为 74→73；差额 18 条为本沙箱 go build cache 只读导致的 A1 环境噪声（`read-only file system`，与本次改动无关），55 条 A3 为他人并发新增违规（`wafop/validate.go`），均不在本卡写域。A4 自身严格 1→0。

## 2. G-28 双端证据（隔离实例 + Playwright/Edge/CDP）
- 隔离实例：`bin/kored`（从工作树现编，含本次改动）、独立 config/state/run/log 落 `/home/pt/Work/GolandProjects/kore-pl/.tmp/ui-a4-verify/`、端口 **18947**（非 8787）；G-29 声明：**本轮未读写主实例** `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`；实例用完已停、临时目录已删。
- 浏览器：`Playwright + Microsoft Edge（msedge channel, headless）`，经 CDP 驱动，本地访问隔离实例，无联网、无真实 install/upgrade。
- 触发方式：`Ctrl+K` 打开全局搜索 → 输入 `db:` → 浏览器本地 mock `POST /api/v1/invoke/db-mysql|db-postgres/*` 返回 `{"instances":[],"databases":[],"rows":[]}`，构造「数据库来源为空」（`src.db.st='ok'` + `hadInstance=false`）；DOM 实测 note 文本 = `还没有添加数据库连接，这个来源暂时没有内容。`；两个视口 `pageerror` 均为 0、`bodyScrollWidth == viewport.width`（无横向溢出）。

| 文件 | `identify` 实测 | 视口 | 内容 |
| --- | --- | --- | --- |
| `.agents/verify/screenshots/ui-a4-dbempty-desktop-01.png` | **1440×1387**（full-page，视口 1440×900） | PC | 搜索面板 680px 宽；`db:` 作用域下三条 note，末条为目标白话文案 |
| `.agents/verify/screenshots/ui-a4-dbempty-mobile-01.png` | **390×2434**（full-page，视口 390×844） | 手机 | 搜索面板 374px 宽（未溢出 390），同款文案，触控目标 ≥44px |

`file` 两份均为 `PNG image data, 8-bit/color RGB, non-interlaced`；非同图缩放冒充，来自两个独立 context/viewport 的真实渲染。

## 3. 自评三问
1. **解决什么用户问题**：小白在搜索框里搜 `db:` 时，原提示「没有配置数据库实例」里的「实例」是内部术语，用户看不懂「实例」和自己要添加的「数据库连接」有什么关系。改为「还没有添加数据库连接」后，一句话说明现状（还没加）+ 下一步对象（数据库连接），符合 USABILITY 原则 4「小白能看懂」，与数据库页已有的「一键连接 / 数据库连接」措辞保持一致。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔与 1Panel 的全局搜索对「空来源」多只给「暂无数据」或不提示；本实现逐来源给出带下一步对象的白话空态，并明确「这个来源暂时没有内容」而非假装搜到结果。差距：这里仍只说明状态、未给一键跳转按钮（USABILITY 原则 4 对空状态「给下一步按钮」的更高要求）；数据库添加入口需用户自行到「数据库」页操作，本轮的收窄目标是消除内部术语，不扩写交互。
3. **当前可用还是占位**：**可用**。文案已在真实浏览器（隔离实例 + Edge）双端渲染并截图核对，A4 FAIL 已归零；该 note 只在「数据库插件已装、instances 为空」时出现，本轮用浏览器本地 mock 构造该状态（不执行真实 install/upgrade），真实插件下的端到端路径不在本卡验证范围。

## 4. 边界与未做
- 未碰 M1-M9 代码、未碰其它 web 文件、未碰 `.kore-local-*`，未联网、未 push。
- `capability.denied` 三处保留（理由见 §0），A4 清单条目不移除（仍为存量 WARN 豁免）。
- 提交：`[agent:ui-a4] fix(web/search): A4 数据库空来源提示去「实例」内部术语`；精确 add，只含 `web/search.js` + 两份截图 + 本文件。
