# G-33 A5 收口：4 视图空状态 + 下一步按钮

- 任务：`empty-state-6views`（G-33 A5，6 条 FAIL）
- 基线提交：`e809dcd`（门禁判定失败）；工作树 HEAD 收口前 `397b172`
- 交付：`web/files.js` `web/monitor.js` `web/settings.js` `web/store.js`（+ 6 张 G-28 截图 + 本报告）
- **未改**：`web/style.css`（首屏件，逐字节等于 HEAD）、`scripts/usability-check.sh`（判据未放宽）、后端任何文件、运行态配置

## 1. 写域核实

```
$ git status --short web/
 M web/files.js M web/monitor.js M web/settings.js M web/store.js   ← 本任务
 M web/monitor-cards.js  M web/terminal.js                          ← 他人占用（未触碰）
```

`store.js` 在 `c88809d`（nav-consolidate）后已落账，开工时 HEAD == 工作树。
`9547814 [error-empty-state-unify]` 只改了 `process/backups/firewall/appdeploy/redis/db*`，
**从未覆盖这 4 个视图**——「空态全页统一」对这 6 条并未闭合（A 类，非门禁误判、非未提交）。

## 2. 6 处现状 → 设计

| # | 位置 | 空态触发场景 | 改前 | 改后（标题 / 说明 / 按钮） |
| --- | --- | --- | --- | --- |
| 1 | `files.js` 目录列表 | 空目录（无文件、无子目录） | 一行冷文字「这个目录还是空的，可用上方按钮…」，无按钮 | 这个目录是空的 / 可上传或新建文件夹 / **[上传文件]**（滚动工具条到视野后弹选择框）+ **[新建文件夹]**（命名弹层） |
| 2 | `files.js` 搜索结果 | 关键词无匹配 | 一行字，无出路 | 没有找到匹配项 / 换关键词或切换搜索方式 / **[清空搜索]** |
| 3 | `files.js` 回收站 | 回收站为空 | 一行字 + 一排全禁用按钮 | 回收站是空的 / 删除先入这里随时可恢复 / **[返回文件列表]**（并把禁用操作条整段去掉） |
| 4 | `monitor.js` 历史曲线 | 采样点 < 2（刚启动/刚装插件） | `mon-empty-note` 纯文字 | 监控数据还在收集中 / 还差 N 个点，默认 60s 一点 / **[立即刷新]** |
| 5 | `monitor.js` 插件详情 | 未装 monitor 插件（内核降级态） | 一段 muted 文字 | 还没有安装监控插件 / 上面是内核基础指标，磁盘网络温度需插件 / **[去软件商店安装]**（navigate store） |
| 6 | `settings.js` 运行参数 | 内核信息未读到（未登录/网络抖动） | 一排「—」，像真实值 | 还没有读取到内核信息 / 说明接口与重试 / **[重新读取设置]**（重拉会话+系统信息后重绘本页） |
| 7 | `store.js` 插件网格 | 索引空 / 已装空 / 筛选无匹配 | `<p>` 一行「没有匹配的插件」 | 索引空：商店索引里还没有插件 → **[重新读取索引]**；已装空：还没有安装任何插件 → **[去全部插件里挑一个]**；筛选空：没有找到匹配的插件 → **[清空筛选]**（并滚回结果区） |

实现统一复用主壳公共文案契约 `window.KoreUI.emptyBlock`（`app.js:2424`，三件套 = 标题 + 说明 + 下一步按钮，
与 `appdeploy.js:351` / `backups.js:456` / `process.js:114` 同一入口）；`files.js` 目录空态需要**两个并列 CTA**
（`emptyBlock` 只支持一个），按 `integrity.js:148/190` 同款结构手拼，未新增第二套样式。
各视图补一个视图级修饰类（`mon-empty-state` / `settings-empty-state` / `store-empty-state`），G-33 A5 依此识别，不做全局 CSS 改动。

## 3. 门禁

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/{files,monitor,settings,store}.js` | 0 ×4 | 语法通过 |
| `bash scripts/usability-check.sh --no-run-tests` | 0 | `0 pass, 523 warn, 0 fail, 162 unverified`（改前 6 fail，6 条 A5 FAIL 全部消失） |
| `make frontend` | 0 | 首屏 gzip **70,419 B** ≤ 307,200 B；`[OK] 首屏体积达标`；i18n 增量 2,922 B ≤ 3,072 B |
| `git diff --stat HEAD -- web/style.css` | — | 空（首屏件零改动；4 个视图均为懒加载模块，首屏 `d(size)/d(视图数)=0`） |

## 4. G-28 双端截图

桩服务渲染真实视图代码（一次性脚本放 `/dev/shm`，验证后即删；未改主实例、未动运行态配置）：

| 文件 | 尺寸 | 字节 | 内容 |
| --- | --- | --- | --- |
| `screenshots/empty-store-desktop-01.png` | 1440x900 | 76,119 | 「商店索引里还没有插件」+ [重新读取索引] |
| `screenshots/empty-store-mobile-01.png` | 390x844 | 61,895 | 同上（无横向溢出） |
| `screenshots/empty-files-mobile-01.png` | 390x844 | 61,029 | 「这个目录是空的」+ [上传文件]/[新建文件夹] |
| `screenshots/empty-files-desktop-01.png` | 1440x900 | 85,714 | 同上 |
| `screenshots/empty-monitor-desktop-01.png` | 1440x900 | 94,398 | 「还没有安装监控插件」+ [去软件商店安装] |
| `screenshots/empty-monitor-mobile-01.png` | 390x844 | 50,778 | 同上 |

## 5. 产品定位自评（G-28 三问）

| 页面 | 解决什么用户问题 | 与宝塔 / 1Panel 差距 | 状态 |
| --- | --- | --- | --- |
| 文件管理 | 空目录不再让人「以为坏了/没权限」，直接给上传与建文件夹两条路 | 宝塔空目录只是一行提示，无 CTA；本页把下一步做成一等公民 | 可用 |
| 系统监控 | 未装插件时明说「这半页数据从哪来」，并能一键去装 | 1Panel 缺插件时整页空表格；本页保留内核基础指标 + 明确去处 | 可用（降级态） |
| 软件商店 | 索引为空与「筛选没匹配」分开说，避免把索引故障误读成「没有这个插件」 | 宝塔/1Panel 商店空态只写「暂无数据」 | 可用 |
| 设置 | 内核信息读不到时不再甩一排破折号，给重试 | 两家均为纯表单页，无此降级表达 | 可用 |

## 6. 已知遗留

- `empty-state-title` 在 `style.css` 无独立字号/字重规则（与既有 `app.js`/`backups.js` 空态同源，本次不新增首屏 CSS）。
- `web/monitor-cards.js`、`web/terminal.js`、`web/usability.yaml` 为他人改动，本任务未触碰；开工时 `usability.yaml` 工作树与 HEAD 均为 52 行（截断已不存在）。
