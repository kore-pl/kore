# R24 · 已装插件列表每行「设置」入口（r24-appsetting）交付与 G-28 证据

> 日期 2026-11-24 19:35–19:47（Asia/Shanghai）｜Owner `r24-appsetting`（🔵 美团味）｜代码检查点 `e03178a`（HEAD，含入口）｜隔离实例 **18900**（18898 被 alertlayout 占用，按预案避让；`--config /tmp/kore-r24-appsetting/config.yaml`，state/run/log 全落 `/tmp`）｜写域 `web/app.js`（唯一代码交付）+ 本报告 + 8 张截图｜**未 push**。

## 0. 结论

用户要的「软件商店每一个软件都应该支持自己的设置页面」——复用现成统一配置面板，零新建视图。已装列表每行「操作」列新增「设置」按钮，点击调 `window.KoreShell.openConfig(host, plugin.id, {title})`，面板由 `KoreConfig.open` 按 schema 动态渲染。硬验收 6 项全绿，G-28 双端共 8 张截图（4 状态 × 2 端）齐，均为隔离实例真登录 + 真点击的浏览器实拍、非 mock 业务数据。产品定位：**可用入口 + 面板统一兜底**（echo 无 config 契约，面板显示真实降级文案；带契约插件装上即渲染真实表单）。

## 1. 需求→方案→缺口→实现（顶层设计一条线）

| 环节 | 事实 | 来源 |
| --- | --- | --- |
| 用户原话 | "软件商店 的每一个软件都应该支持自己的设置页面" | 任务卡 |
| 调研 A 案定论 | 统一入口 `openConfig` → `KoreConfig.open` 按 schema 渲染，不新建视图 | `web/shell.js:1123-1137`、`web/config-panel.js:178`、`docs/PLUGIN-CONFIG.md` §9 |
| 缺口 | 已装列表行 `pluginRow` 的 ops td 有启用/停用/升级/卸载/ping，但**无设置按钮** | `web/app.js:708-760`（改前） |
| 实现 | ops td 加「设置」按钮，中文白话、复用 `.btn`；点击实时取 `kore-plugins-panel` 作 host 调 openConfig | commit `e03178a`（`web/app.js:711-722`，12 行） |

**host 取法裁决（owner 定）**：用 `document.getElementById('kore-plugins-panel')` 实时查询，**不**给 pluginRow 透传 box。理由：`pluginRow` 有两处调用——建行 `web/app.js:1105` 与启停后状态刷新 `replaceRow` 重建行 `web/app.js:954`；透传 box 会在重建路径断链。实时查询一处覆盖两场景，且与既有范式 `web/app.js:972/991` 完全一致。`config-panel.js:200` 的 `host.insertBefore(panel, host.children[1] || null)` 需要确凿容器，`section#kore-plugins-panel` 的结构是 `head(:0) → summary/table(:1)`，面板正好插在标题下方、列表上方——截图已实证 `index=1`、`firstChildClass=panel-head`。

## 2. 硬验收（6 项，命令 + 退出码 + 关键输出）

| 项 | 判据 | 命令 / 来源 | 结果 |
| --- | --- | --- | --- |
| ① 语法 | `node --check` exit 0 | `node --check web/app.js` | **PASS exit 0** |
| ② 按钮 + 调用 | ops td 有设置按钮、调 openConfig、中文白话、复用样式 | `git show e03178a -- web/app.js` | PASS：`plugin-setting-btn`（`btn` 类）、文案「设置」、`openConfig(host, id, {title})` 三要素齐 |
| ③ 不破坏现有 | 启用/停用/升级/卸载/ping 与 R23 接线（SHELL_VIEWS/HUB_DEFS）零改动 | `git show --stat e03178a` | PASS：仅 `web/app.js` +12 行，diff hunk 只在 ops td 顶部；`SHELL_VIEWS`(:2154) / `HUB_DEFS`(:2197) 零命中改动 |
| ④ usability | `usability-check.sh` exit 0 / 0 new FAIL，A6 一级菜单仍 10、A4/A5 无新增违规 | `bash scripts/usability-check.sh` | **PASS exit 0 / FAIL=0**（改前 baseline 亦 exit 0 / FAIL=0，差值 0） |
| ⑤ 首屏 | `frontend-check.sh` 首屏 ≤307200 | `bash scripts/frontend-check.sh` | **PASS exit 0**：首屏 **77763 / 307200** 字节（余量 229437）；i18n 增量 2922/3072 |
| ⑥ 双端截图 | G-28 PC 1440×900 + 手机 390×844，真实点击弹面板，`file` 实测 + md5 全异 | 见 §3 | **PASS**：8 张、md5 8/8 全异 |

## 3. G-28 截图证据（隔离实例 18900，真登录 + 真导航 + 真点击）

拍法：HEAD 归档 `git archive HEAD | tar -x -C /tmp/kore-r24-appsetting/src` → 归档内 `make -s web-dist` + `CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false -ldflags '-s -w' -o kored ./cmd/kored`（exit 0）→ 隔离 `kored serve --config <tmp>/config.yaml`（state/run/log 全 `/tmp`）→ `admin-password` 写已知口令 → `POST /api/v1/auth/login` 真登录拿 cookie → playwright 1.65.1 / chromium headless shell 1255 注入 cookie → hash `#/store/plugins` 直达（插件管理是 store hub 第二个 tab，非独立一级路由）→ 断言 `.plugin-row` 与 `.plugin-setting-btn` 数量相等、按钮文案「设置」→ 拍列表态 → **真实 click 第一个设置按钮** → 断言 `#kore-plugins-panel .cfg-panel` 出现且 `index=1` → 拍面板态。禁止空壳：任一断言失败即不产出图片。

插件来源：`POST /api/v1/store/install` 离线装 `echo 0.1.5`（本地 dist sha `0a2153dd…` 与签名索引逐字节一致，过校验），`reload=reloaded`。禁用态与启用态各拍一组。

| 文件 | `file` 实测 | 内容 |
| --- | --- | --- |
| `plugin-setting-list-desktop-01.png` | **1440 × 900** | 软件商店 → 插件管理 tab；echo 行「操作」列首位「设置」按钮；中文白话、复用 btn；汇总/表格完整 |
| `plugin-setting-list-desktop-02-config-open.png` | **1440 × 900** | 真点击后统一配置面板弹出：`Echo 验证插件 设置` 标题 + 关闭 × +「保存后立即生效，无需重启」，插在标题下方列表上方（index=1）；禁用态真实报错「请先 POST /api/v1/plugins/echo/enable」 |
| `plugin-setting-list-desktop-03-enabled.png` | **1440 × 900** | 启用 echo 后列表态：设置按钮仍在（证明状态刷新后入口不丢） |
| `plugin-setting-list-desktop-04-enabled-config.png` | **1440 × 900** | 启用态点击设置：面板弹出、位置正确 |
| `plugin-setting-list-mobile-01.png` | **390 × 844** | 手机列表：表格转卡片式，设置/启用/卸载同排，触摸目标 ≥44px（`.btn` 移动端 `min-height: var(--kore-touch)`，style.css:467），无横向溢出 |
| `plugin-setting-list-mobile-02-config-open.png` | **390 × 844** | 手机点击后配置面板插入标题下方，错误文案给人话 + 下一步动作 |
| `plugin-setting-list-mobile-03-enabled.png` | **390 × 844** | 手机启用后列表态 |
| `plugin-setting-list-mobile-04-enabled-config.png` | **390 × 844** | 手机启用态配置面板；echo 无契约时 `E_NOTFOUND` 真实降级 |

**md5（8/8 全异，非同图缩放）**：

```
26035ce71ae47816835e0e9a507b0500  plugin-setting-list-desktop-01.png
83577530df08577c05245a081eabde2b  plugin-setting-list-desktop-02-config-open.png
841b553e804e436b9bf663f4979ca0c2  plugin-setting-list-desktop-03-enabled.png
0d684de738ecf04a57d41a5890ce3c2d  plugin-setting-list-desktop-04-enabled-config.png
94569f00664f9339733add6674fc5537  plugin-setting-list-mobile-01.png
2ecfc6e1efb025e145166caad74d0601  plugin-setting-list-mobile-02-config-open.png
752af0c3b67d92aade766ce0e4003f5d  plugin-setting-list-mobile-03-enabled.png
9bb0301d1bb6cb20b11be5115b6c08c4  plugin-setting-list-mobile-04-enabled-config.png
```

**空态/降级如实说明**：本隔离实例只装了 echo（`depth_level=basic`、无 `config.get/set` 契约），因此面板显示的是**真实降级**——禁用态 `E_CONFLICT`（提示先启用），启用态 `E_NOTFOUND: echo.config.get`。这是内核/插件的真实响应，不是 mock、不是占位图；且空态/错误文案的「怎么办 + 关闭/去商店/重试」由并行任务 r24-cfgempty 在 `config-panel.js` 统一兜底，**本入口卡按共识不做有无契约探测/拦截**，避免两处文案漂移。带 `config.get/set` 契约的插件（如 backup/container）装上即可渲染真实表单，本卡无需改动。

## 4. G-28 产品定位自评（三问）

1. **本页解决什么用户问题**：用户装了一堆插件，过去每台插件的配置要分别找入口（有的藏在插件自己的页面、有的只能改环境变量重启）。现在「软件商店 → 插件管理」每一行都有统一的「设置」，点开就是那台插件的可配置项，保存即生效——一个入口管所有插件，不用记哪个插件的设置藏在哪。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔/1Panel 的插件设置多为各插件自绘页面，风格与字段散、无统一契约。Kore 这版的优势是**一个统一面板 + schema 动态渲染**（PLUGIN-CONFIG 契约），入口与表单零重复。差距/边界：①依赖插件实现 `config.get/set` 才有真实表单，未实现的走统一空态（本次 echo 即此情况）；②本轮只验证入口与面板挂载，带契约插件的真实表单增删/保存由 r24-cfgempty 与配置面板自身门禁覆盖；③无跨插件批量配置（不是本卡范围）。
3. **当前是「可用」还是「占位」**：**可用入口**。设置按钮、openConfig 调用、面板按插件 id 动态打开、插入位置、双端布局均为真实逻辑、无 mock；echo 无契约导致的空态是真实降级而非占位，装上带契约插件即完整可用。

## 5. 两栏布局与 G-29 声明

- **两栏**：左 sidebar 一级导航（软件商店高亮）+ 右主内容区（插件管理 tab + 面板）；桌面 1440 下 ops 按钮横排、手机 390 下表格转卡片、配置面板全宽纵向堆叠，均无横向溢出（截图实证）。
- **G-29 运行态写边界**：本轮**未改动主实例运行态配置**——对 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / 主 `bin/kored` 全程零写入，未重启 8787；只起停隔离 unit（端口 18900，独立 config/state/run/log 全 `/tmp`）。隔离实例 `kored` 在取证结束后 kill；一次性脚本（`/tmp/kore-r24-appsetting/shot*.mjs`、`shot*.json`）、`/tmp` 归档目录与构建产物全部删除。端口避让：18898 已被 alertlayout 占用，按任务卡预案切 18900，未冲突。workaround 无（未用替身/mock）；无过期条件。

## 6. 横向交流 / 提交

- 与 `r24-cfgempty`（config-panel 空态）已 `send_message` 对齐：入口只调 openConfig、不做契约探测，空态文案由面板统一兜底，无接口冲突。
- 与 `r24-alertlayout` 端口避让：18898 被占 → 本卡用 18900，已按预案处理，未打扰 peer。
- 提交：代码 `e03178a`（`[agent:r24-appsetting]`，仅 web/app.js +12 行）；本报告 + 8 张截图随本轮增量提交。**均未 push**。
