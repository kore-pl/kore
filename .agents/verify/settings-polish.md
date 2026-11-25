# 设置页整合（settings-polish）验收报告

日期：2026-11-25 · agent：feat-settings-polish · 写域：`web/settings.js`、`web/config-panel.js`（纯前端，不改后端、不引依赖）

## 0. 依据

- 易用性四原则④「小白能看懂」：配置项要有中文标签 + 一行帮助（`AGENTS.md` 读前必知 7；`docs/USABILITY.md` §4）。
- 统一配置面板契约：每字段 `label` + 一行 `help`、保存后明确反馈（`docs/PLUGIN-CONFIG.md` §156 段）。
- 危险操作二次确认 + 双端截图证据（`.agents/QUALITY-GATES.md` G-28）。
- 手机适配硬约束：触摸目标 ≥44px（`AGENTS.md` 读前必知 6 末段）。

## 1. 改了什么（用户可见）

### web/settings.js（常规设置 tab 重排，四个 tab 与挂载契约不变）
- 六组分类：账户与安全 / 站点与域名 / 数据与备份 / 通知与告警 / 系统与网络 / 关于（`web/settings.js:406` GROUPS）。
  每组 = 一句「这组管什么」+ 一句「什么时候需要改」+ 项数；组内 switch 芯片可跳转。
- 组内搜索：按标签 / 帮助 / 默认值 / 分组名过滤，实时出「匹配到 N 项（共 M 项）」；无命中给换词建议 + 一键清空（`settings.js:468`、`:506`）。
- 每个配置项 = 中文标签 + 一行帮助 + `默认：…` 提示（`settings.js:146` cfgItem）；高级项折叠进「高级设置（N 项，点开查看）」，默认收起、可展开。
- 危险操作统一确认层：先列后果，再要求输入指定文字才可执行（升级输「升级」、回滚输「回滚」），未输入时确认键禁用（`settings.js:595` openDangerConfirm）。
- 改口令弹层先列后果（所有会话失效 / 旧口令立即作废 / 不回显不写浏览器存储）——当前口令本身即确认凭据，不再叠一道输入。
- 内核不可升级时给白话「怎么办」，原始原因单独一行供排障（`settings.js:736`）。
- 语言切换成功后就地提示「已切换为…，立即生效并已记住选择」。
- 跨页设置只给「去配置」入口（网站 / DNS / 证书 / 站点迁移 / 备份 / 快照 / 迁移 / 漂移 / 告警规则 / 日志告警 / 通知通道），不在本页重复造表单。
- 导出 `window.KoreSettings.confirmDanger`，供清空日志 / 卸载插件 / 删除站点等视图复用同一套确认层（本轮不改它们的文件）。
- 资源预算表两个数值列补 `data-label`（列名取自与表头同源的 `BUDGET_COLS`）：<640px 时 `style.css` 用 `td::before{content:attr(data-label)}` 复原列名，此前 label 为空 → 手机每行只剩数值且白占 84px（由 feat-mobile-polish 实测上报，转交本卡修复）。

### web/config-panel.js（插件统一配置面板，`KoreShell.openConfig` 契约不变）
- 每字段下方 `默认：X`，与默认不同时标「（当前已改，保存后生效）」并转警示色（`web/config-panel.js:199` renderField）。
- schema 标 `advanced: true` 的字段折叠进「高级设置（N 项，点开查看）」（`config-panel.js:396`）；未标记的插件行为不变。
- 字段 ≥6 个时出现搜索框（标签 / 帮助过滤），命中自动展开高级折叠（`config-panel.js:409`）。
- 有未保存改动时点关闭 / Esc 先拦一次，说明「关闭后改动会丢失」并给「继续编辑 / 放弃修改并关闭」（`config-panel.js:307`）。
- 保存反馈带本次实际改动项数（如「已保存，本次修改 2 项，立即生效」），内容没变则写「（内容未变）」（`config-panel.js:477`）。

## 2. 验收命令与结果（隔离实例 + 真机点击）

构建口径：他人后端在途改动会让工作树编译失败，故按仓库既有做法用 `git archive HEAD` 干净树 + 只覆盖本卡两个前端文件构建 `kored`；隔离实例 `127.0.0.1:<随机端口>`，state/run/log 全落 `/tmp`，跑完即删（未改主实例 8787 的任何运行态资产）。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check web/settings.js` / `web/config-panel.js` | exit 0 |
| 首屏预算 | `make frontend` | 首屏 gzip 83,182 B / 307,200 B，exit 0（settings.js 懒加载、不计入首屏；数字含并行轨道的首屏改动） |
| 明文凭据 | `make secret-check` | exit 0 |
| Go 门禁 | 干净 HEAD 树 + 本卡前端：`go vet ./...` / `go test -timeout 200s ./...` | 均 exit 0（web 包无测试文件） |
| 真机交互 | playwright + 真实隔离实例，25 条断言 | `[DONE] 全部断言通过`，NODE_EXIT=0 |

关键断言（原文）：六个分组顺序 `account,sites,data,notify,system,about`；配置项 38 项、其中高级折叠 8 项；搜索「备份」→「匹配到 8 项（共 38 项）」且非命中项隐藏；高级项默认折叠、点开展开且也有默认值；改口令弹层含「全部失效 / 旧口令立即作废」；危险确认按钮在初始与只输入「升」时禁用、输入「升级」后启用；Esc 可关闭；手机触摸目标 分组芯片 44px / 高级折叠 44px / 操作按钮 44px；配置面板默认值提示 `默认：8080（当前使用默认值）` / `默认：30（当前已改，保存后生效）`；有未保存改动时关闭被拦下且「继续编辑」后面板仍在。

## 3. G-28 双端截图（PNG 实测宽高）

| 截图 | 实测 |
| --- | --- |
| `.agents/verify/screenshots/settings-groups-desktop-01.png` | 1440×4980（full-page） |
| `.agents/verify/screenshots/settings-groups-mobile-01.png` | 390×844 |
| `.agents/verify/screenshots/settings-search-desktop-01.png` | 1440×900（搜索「备份」过滤态） |
| `.agents/verify/screenshots/settings-danger-desktop-01.png` | 1440×900（危险确认，已输入「升级」） |
| `.agents/verify/screenshots/settings-config-panel-desktop-01.png` | 1440×900（默认值提示 + 高级折叠 + 搜索 + 未保存拦截） |
| `.agents/verify/screenshots/settings-budget-mobile-01.png` | 390×844（资源预算表小屏列名复原：硬红线 / 目标逐行可见） |

## 4. 产品定位自评（G-28 三问）

- **解决什么用户问题**：设置页原先是一排技术表格，用户不知道「这项该不该改、默认是什么、改坏了怎么办」。现在按「账户 / 站点 / 数据 / 通知 / 系统 / 关于」分类，每项有默认值与「什么时候需要改」，搜索直达；不可逆动作必须看后果并输入确认文字。
- **与宝塔 / 1Panel 的差距**：宝塔设置项平铺、危险操作多为一次 confirm；1Panel 有分组但缺默认值提示与组内搜索。本页在「分类 + 搜索 + 默认值 + 输入确认文字」四点上都补齐，且跨页设置只给入口不复制表单，避免同一件事两处配置漂移。
- **当前状态**：常规设置 tab 与插件配置面板为「可用」；站点 / 数据 / 通知三组为入口导航（表单仍在各自页面，非占位空壳——每项都写明什么时候去、去哪个页面）。

## 5. 边界与后续

- 未改后端、未改 `web/shell.js`、`web/app.js`、`web/i18n/*`、`web/audit.js`、`web/security.js`。
- `web/logs.js` 的日志切割仍用 `window.confirm`（不在本卡写域）；`store.js`（输插件名）/ `sites.js` / `backups.js` 已有各自的页面内二次确认。已导出 `KoreSettings.confirmDanger` 供其后续统一复用。
- 主实例运行态：本轮**未改动**主实例配置与 state；隔离实例端口已释放、`/tmp` 目录已删。
