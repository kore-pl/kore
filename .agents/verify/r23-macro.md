# R23 · 操作宏（r23-macro）交付证据

> 元信息：2026-11-24 19:09–19:35 +08 · 执行者 r23-macro · 代码 commit `80b8f63`（web/macros.js）· 接线 HEAD `3fcf520`（integration 统一注册）· 隔离实例 127.0.0.1:18895（config/state/run/log 全落 `/tmp/kore-ui-shot.macros.Ud18Tr`，主实例 8787 零触碰）· 本报告 + 双端截图，不 push。

## 目标与写域

- 目标：新增「操作宏」视图——录制用户跨视图的 invoke 序列、命名保存、一键回放、失败策略、执行历史，纯增量新效率工具。
- 写域：`web/macros.js`（唯一代码交付）+ 本报告与 `.agents/verify/screenshots/macros-*.png`。不改 app.js / shell.js / embed.go / Makefile（接线归 r23-integration）。
- 契约：`window.KoreMacros.render(container) → { destroy }`，tasks hub 下懒加载，CSS 内联注入（`kore-macros-css`）。

## 硬验收（5 项）

| 项 | 判据 | 命令 / 来源 | 结果 |
| --- | --- | --- | --- |
| ① grep | 确认无等价宏模块 + 新文件存在 | `grep -rniE '操作宏\|录制\|macro\|回放' web/` | PASS：接线前仅命中 terminal.js「回放窗口」(屏幕重建，非等价)；新文件 `web/macros.js` 落地后 grep>0 |
| ② 语法 | node --check exit 0 | `node --check web/macros.js` | PASS exit 0 |
| ②b 后端 | 纯 localStorage 方案，无后端 | 设计取舍 | N/A（无 go build 需求） |
| ③ 首屏 | frontend-check ≤307200 | `bash scripts/frontend-check.sh` | PASS：首屏 77175 / 307200 字节，余量 230025；macros.js 懒加载不进首屏六件套 |
| ④ G-30 脱敏 | 字段名匹配 + 不落盘 + 回放跳过 | 见下「脱敏证据」 | PASS：正则 + 7/7 行为用例 |
| ⑤ commit | 不 push、首行 agent 前缀、一步到位 pathspec | `git show --stat 80b8f63` | PASS：仅 `web/macros.js`（649 行），无夹带 |

## 脱敏证据（G-30）

- `web/macros.js:110` 正则：`/(pass(word|wd)?|pwd|token|secret|key|apikey|api_key|credential|privatekey|private_key|pem|authorization)/i` —— 覆盖 password/token/secret/key 四类必匹配字段及常见变体。
- `web/macros.js:207-226` `sanitizeParams()`：字段名命中 → 值置 `null`，`redacted=true`；嵌套对象递归脱敏。
- `web/macros.js:581-585` 回放阶段：`step.redacted` 直接跳过并明确提示用户到原页面手动执行——绝不把 `null`/占位符当真值发往 invoke。
- 行为验证（从源码精确抽取正则与函数跑 7 个用例）：`password/token/api_key/private_key/Authorization/嵌套 secret` 全部置 null 且无泄漏；非敏感字段原样保留 → **7/7 PASS**。

## 契约核对（从源码读，非猜测）

- invoke 形态实读 `web/batch.js:114`、`web/sites.js:43`、`web/ssl.js:64`：`POST /api/v1/invoke/<plugin>/<method>` + `X-Kore-CSRF` 双提交，body = JSON(params)。录制走 fetch 拦截、回放复用同一形态，内核零业务（G-13）。
- 方法中文标签映射只覆盖 sites.js/ssl.js 源码里确实存在的 20 个方法；未命中回退原始限定名，不臆造能力。
- 数据形状显式（`kore.macros.v1`）：version/macro(id,name,createdAt,updatedAt,onFail,steps,lastRun)/history 字段与类型逐一列明，无 object/any 逃逸（G-24 精神）。

## 与 r22-batch / 其它 R23 卡的边界（peer 直接裁决）

- r22-batch 已回信确认不重复：batch = 系统硬编码场景注册表（site/container）× 同一操作多目标循环；macro = 用户自定义任意 invoke 步骤序列 × 单次回放。两者正交。
- r23-drift 已回信确认写域不重叠（drift 只读审计溯源，macro 录制/回放不写审计）。

## G-28 产品定位自评（三问）

1. **本页解决什么用户问题**：当前建站点、绑 SSL、设伪静态每个都要跨页手动一步步点，重复流程没有"录下来一键跑"的能力。操作宏让用户按平时习惯操作一遍，系统把跨页 invoke 序列记成宏，命名保存后一键回放，把 N 次重复点击压成 1 次，并可单步失败策略与历史追溯。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔/1Panel 多是固定脚本/计划任务，缺"所见即所得录制用户真实操作序列"的轻工具；本宏补的是"零配置录制 → 回放"这一层。局限：宏存在浏览器 localStorage，不跨设备同步；含口令/令牌的步骤因 G-30 硬约束不自动回放（明确提示手动补），不做凭据代填；与 batch 不重合（上面已裁）。
3. **当前是"可用"还是"占位"**：**可用**（非占位）。录制是真的 fetch 拦截、回放是真的 invoke、CRUD/历史是真的持久化；无 mock、无"敬请期待"。本次双端截图即为隔离实例真登录 + 真导航 `#/tasks/macros` 实拍。

## G-28 双端截图（实拍）

| 端 | 文件 | 尺寸（identify 实测） | 内容核验 |
| --- | --- | --- | --- |
| 桌面 | `.agents/verify/screenshots/macros-desktop-01.png` | 1440×900（72297B） | 左侧「计划任务」高亮、top tab「操作宏」选中、标题/说明/开始录制/空态引导「录第一条宏」清晰可读 |
| 手机 | `.agents/verify/screenshots/macros-mobile-01.png` | 390×844（53558B） | 同内容、底部手机导航正常、触摸目标≥44px、无横向溢出 |

取证方式：官方 `scripts/ui-shot.sh --scene macros --route tasks/macros --desktop --mobile --port 18895 --binary /tmp/kore-macros/kored`（HEAD `3fcf520` 归档构建）首拍成功但被首次使用引导弹窗遮挡 → 不达验收；改用 `--keep` 保留隔离实例与登录 cookie，以一次性 playwright 脚本（`/tmp`，跑完即删）在真登录态注入 onboarding dismissed 状态（等价真人点「知道了」）后重拍，脚本内断言 `.kore-onboard-backdrop` 不存在、路由 `tasks/macros` 已渲染、页面含「操作宏」，双端重拍 exit 0，`identify` 实测宽高达标。两次截图均为真实浏览器实拍，非同图缩放、非 mock。

## 安全与纪律核对

- 无新增后端方法、无新依赖、无外链、无遥测；宏数据只写 localStorage（个人偏好，无需跨端/后端，不触 G-29 state 目录）。
- G-30 硬红线：敏感字段不落盘、不回放；源码证据与行为用例在上。
- G-13 薄壳：录制/回放只在视图层编排现有 invoke，内核零业务。
- 删除宏二次确认（行内确认条），空态给「录第一条宏」引导，手机适配 ≤639px media query + 44px 触摸目标，destroy() 作废在途回放。
- 隔离实例全程独立 config/state/run/log 落 `/tmp`，端口 18895；主实例 8787 零请求零写入；一次性脚本与 /tmp 目录验证完即删。
