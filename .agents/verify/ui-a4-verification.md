> 元信息: 2026-11-26 · 执行者 ui-a4-verifier（独立 verifier，非 ui-a4）· G-09 / task-97 · 复跑对象 commit b9ad7d74b3218310b5b449a68dd0c460d1bdd976

# A4 清理独立验收：术语修复 + 双端截图复核

## 结论：**PASS**（A4 自身 1→0；G-28 双端截图真读非伪造；git 边界干净）

复跑口径：只读独立复跑，不复用实现者结论；除本验收报告外未改任何文件。**未 push、未联网、未执行主流程 install/serve/upgrade、未读写主实例运行态**（G-29 声明见 §6）。

---

## 1. 基线与提交边界

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `git rev-parse HEAD` | 0 | `b9ad7d74b3218310b5b449a68dd0c460d1bdd976` |
| `git show --stat --oneline b9ad7d7` | 0 | 精确 4 文件：2 PNG + `ui-a4-selfeval.md` + `web/search.js`（1 行改动） |
| `git diff-tree --no-commit-id --name-only -r b9ad7d7` | 0 | 同上 4 路径；`grep -E '\.kore-local\|internal/core\|cmd/kored\|M[1-9]'` → **NONE**（未碰 M1-M9 / 主实例） |

`web/search.js` 唯一改动（b9ad7d7 diff 与工作树 939 行双向核对）：
```
- ... notes.push(tr('search.note.dbEmpty', '没有配置数据库实例，这个来源暂时没有内容。'));
+ ... notes.push(tr('search.note.dbEmpty', '还没有添加数据库连接，这个来源暂时没有内容。'));
```
`p.scope === 'db' && src.db.st === 'ok' && src.db.hadInstance === false` 条件与 `notes.push` 逻辑一字未动；`tr()` 的 key `search.note.dbEmpty` 未变，仅改第 2 参数 fallback 文案。

## 2. 读码核对（三项判断均正确）

1. **术语映射依据**：`docs/USABILITY.md` §4.1（第 58–68 行）术语对照表明确「实例 / instance → 数据库连接」，新文案「数据库连接」逐字命中映射表，非臆造；原则 4（第 53 行）明文禁用「实例」内部术语。✅
2. **`capability.denied` 保留判断正确**：`web/alerts.js:23` 是 `HIGH_RISK` 字典 key，`:158` 是比较条件 `r.action === action`；`web/app.js:1238` 是 `OV_HIGH_RISK` 字典 key。三处均为**审计 action 标识符**，不是给用户看的文案——用户可见文案分别是 `HIGH_RISK[action]` 映射值「权限不足被拒绝」和 OV 对应值「权限不足被拒绝（需要管理员账号；能力由插件声明授予，无逐项授权开关）」。改 key 会破坏 `Object.keys(HIGH_RISK)` 遍历与 `r.action` 匹配，属破坏匹配逻辑；保留不动正确。`web/dist/` 下 3 处为构建产物同源副本。✅
3. **pending 清单 A4 两行未动**：`scripts/usability-pending.txt:68 A4 web/alerts.js 2`、`:69 A4 web/app.js 1` 仍在（`git diff` 中两行零变化）；工作树 `M scripts/usability-pending.txt` 的 diff 全部是他人删除 A1 条目（site/file/cron/db-mysql/... 17 行），与 A4 无关、原样未提交。✅

## 3. 门禁复跑

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/search.js` | 0 | 无输出（语法正确） |
| `make frontend` | 0 | `[OK] 前端静态产物已打包: web/dist（65 文件...）`；首屏合计 gzip-9 **88511 B ≤ 307200 B**（300 KiB），余量 218689 B；`[WARN] 首屏体积漂移` 为非阻断提示（相对脚本历史基线 87341 B）；i18n 增量 2941 ≤ 3072 B |
| `scripts/frontend-check.sh`（直接跑） | 0 | 同上首屏/i18n 判据全 `[OK]` |
| `bash scripts/usability-check.sh`（全量） | 1 | 汇总 `0 pass, 504 warn, 73 fail, 183 unverified`；按分类计 FAIL：**A1=18、A3=55、A4=0**、G-33 汇总行 1；A4 WARN=3（capability.denied 存量豁免，与改前一致） |
| `bash scripts/usability-check.sh --no-run-tests`（HEAD） | 1 | A4 FAIL=**0**、A4 WARN=3 |
| `bash scripts/usability-check.sh --no-run-tests`（干净父树 b9ad7d7^，`USABILITY_WEB_DIR` 指向 `git archive` 解出的父版 web/） | 1 | A4 FAIL=**1**：`[FAIL] A4 web/search.js: 第 939 行用户可见字符串含「实例」: 没有配置数据库实例，这个来源暂时没有内容。`；A4 WARN=3 |

**A4 分类自身严格 1→0，干净 HEAD 对照确认无新增 FAIL。** 总 FAIL=（实现者报 56→55 口径下的）本沙箱 73，差额来自 A1 go-build cache 只读噪声与 A3 他人并发新增（如 `wafop/validate.go`），均不在本卡写域，如实记录为非本改动导致。

备注：任务卡写的 `make frontend-check` 不是 Make target（实测 `make frontend-check` exit=2「没有规则可制作目标」）；该检查实际由 `Makefile:229` 在 `make frontend` 内调用 `bash scripts/frontend-check.sh` 执行，已按脚本本体直接复跑并贴出退出码 0。此为任务卡措辞差异，非交付缺陷。

## 4. G-28 双端截图硬核验（实读，非伪造）

| 项 | 证据 |
| --- | --- |
| 文件存在 | `.agents/verify/screenshots/ui-a4-dbempty-desktop-01.png`（166197 B）、`ui-a4-dbempty-mobile-01.png`（159877 B） |
| `file` | desktop：`PNG image data, 1440 x 1387, 8-bit/color RGB, non-interlaced`；mobile：`PNG image data, 390 x 2434, 8-bit/color RGB, non-interlaced` |
| `identify` | desktop `PNG 1440x1387`、mobile `PNG 390x2434`（各自 full-page；对应视口 1440×900 / 390×844） |
| 真图核验 | `git show b9ad7d7:<path> \| sha256sum` 与工作树 `sha256sum` 一致：desktop `17be40f9...a95a4`、mobile `8499a6c3...12c0e8`——工作树截图即提交内字节，无调包 |
| **`read_image` 实读** | 桌面图：1440×1387 搜索面板内可见 `还没有添加数据库连接，这个来源暂时没有内容。`（搜索框 `db:`、范围=数据库、三条 note 末条为目标文案）；手机图：390×2434 同款白话文案清晰可见，移动端布局独立（顶部导航/卡片重排、面板宽 374 未溢出 390）。两图布局明显不同，非同图缩放冒充，均能看到新文案 |

自评文件 `.agents/verify/ui-a4-selfeval.md` 三问原文已读（第 31–34 行）：①解决「小白不懂『实例』与『数据库连接』关系」的问题，逐字按 §4.1 取词；②对标宝塔/1Panel 差距诚实写明「仍只说明状态、未给一键跳转按钮，本轮收窄目标为消除内部术语」；③自评「**可用**」并注明只在「数据库插件已装、instances 为空」时出现，本轮经隔离实例 + 本地 mock 构造该状态，真实插件端到端不在本卡范围。三问齐全、未自夸为完整功能。

（观察：selfeval §1 记 `make frontend` 首屏 81528 B，与本次独立复跑实测 88511 B 有差异；两次均 ≤307200 B 达标，门禁结论不变，数字差异如实记录。）

## 5. git 终态核查

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `git status --short`（复跑前/后） | 0 | 完全一致：`M scripts/usability-pending.txt`（他人 A1 删除）+ 8 个他人 `?? .agents/verify/*.md` + `?? .agents/verify/screenshots/adp-debug-desktop-01.png` + `?? data/` + `?? dist/`；本次复跑**未新增任何残留**（`make frontend` 产物 web/dist 被 .gitignore 忽略） |
| `git worktree list` | 0 | 仅 1 行：`/home/pt/Work/GolandProjects/kore-pl/kore b9ad7d7 [main]`（仅主树） |
| `git branch --list 'wt-*' 'tmp-*'` | 0 | 空（无临时分支，G-25） |

## 6. G-29 运行态声明

本轮 verifier **未改动任何主实例运行态**：未读写 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`；未执行 install / serve / upgrade；未联网。`git status` 前后 diff 一致（本报告提交前除外）。干净 HEAD 对照使用 `git archive` 解出的临时目录并在**同一次 bash 调用内删除**（`/tmp/u4a-clean-head-<pid>`，已 `rm -rf` 并回显 removed），无遗留临时脚本/目录。

---

**最终判定：PASS。** A4 文案白话化符合 §4.1 术语映射、逻辑零改；`capability.denied` 保留与 pending 两行未动判断正确；node/frontend/usability 四门禁按原文复跑通过且 A4 FAIL 1→0 干净对照无新增；G-28 双端 PNG 真图实读确认含新文案、宽高与视口吻合、非伪造；提交精确 4 文件、他人 dirty 原样、worktree 仅主树。无 BLOCKED 项。
