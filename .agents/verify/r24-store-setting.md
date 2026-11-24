# R24 G-28 双端截图 · 软件商店已装插件「设置」入口

日期：2026-11-24 19:35–19:48（Asia/Shanghai）｜Owner：`r24-storesetting`（🔵 美团味）｜基线 HEAD：`6b197e4`

> ▎[🔵 美团味] 做难而正确的事，过程透明、结果说话。用户要的是「每个软件都有设置页」——复用统一配置面板，不给 24 个插件写 24 个重复页面。截图来自隔离实例真实浏览器 + 真登录 + **真点击「设置」按钮弹出配置面板**，非同图缩放、非设计稿、非 DOM 断言冒充。未装插件无设置按钮、已装插件有——双端目视确认，不拿静态检查当硬证据。

## 0. 结论先行

软件商店已装插件卡片「设置」入口 G-28 双端证据齐备：**PC 1440×900 + 手机 390×844 各 2 张真实截图**（卡片按钮态 + 真点击后的配置面板态，共 4 张），`file` 实测尺寸合规、md5 全异（distinct=4）。真点击断言：`settingBtns=1 uninstalledSettingBtns=0`（仅已装卡片有按钮），面板标题「日志查看分析插件 设置」（opts.title 生效），手机按钮高 **44px**（裁决41 触摸目标达标）。G-29 声明：主实例 8787 全程未重启、未改配置，主配置 mtime 仍为 2026-11-23 04:59（未变），healthz 200。临时脚本/二进制/mock/隔离目录全部清理，端口 18899 零残留。证据齐，声明完成。

## 1. 实现与写域

- 改动：`web/store.js` 的 `renderCard(p)` 已装分支（`if (ins)`，:350-388）开头加「设置」按钮：
  - 按钮类 `btn btn-ghost store-btn-setting`，`type=button`，文案白话「设置」（A4 零内部术语）。
  - 点击调 `window.KoreShell.openConfig(S.container, p.id, { title: (p.name||p.id)+' 设置' })`——host 用视图根容器 `S.container`（:942 在 render() 赋值），避免面板 `insertBefore(children[1])` 插进卡片网格打乱布局。
  - 触摸目标：复用既有 `.store-ops .btn { min-height: var(--kore-touch) }`（style.css:1192），390px 下实测按钮高 44px，写域不碰 CSS。
  - 不重复判断「有无配置契约」——空态由 r24-cfgempty 在面板内闭环（已横向对齐，无双份逻辑）。
- **写域**：仅 `web/store.js`（+ 本卡截图与报告）。未改 app.js / embed.go / Makefile / shell.js / config-panel.js / 后端。app.js 对应改动由 r24-appsetting 并行处理，写域不交叠。

## 2. 静态验证（命令 + 退出码 + 输出）

```text
$ node --check web/store.js
输出: （无输出）
退出码: 0

$ bash scripts/frontend-check.sh
输出:
[OK] dist 无 source map / .vite / 全量字体
[INFO] 首屏合计（gzip -9）: 77763 字节 / 预算 307200 字节（300 KiB）
[OK] 首屏体积达标：77763 字节 ≤ 307200 字节，余量 229437 字节
[INFO] i18n 增量（gzip -9）: 2922 字节 / 预算 3072 字节
[OK] i18n 增量达标：2922 字节 ≤ 3072 字节，余量 150 字节
退出码: 0
```

首屏未增长：store.js 是按需注入视图模块，不计首屏六件套；本次改动只加卡片按钮，不触碰首屏资源。

## 3. 隔离实例与 G-29（主实例运行态零改动）

```text
$ git archive HEAD | tar -x -C <tmp>/src && cp web/store.js <tmp>/src/web/store.js
  # 受控来源：HEAD 归档 + 仅叠加本改动（避开其他 agent 在途改动），独立 make web-dist + go build

$ bash <tmp>/ui-shot.sh --scene plugin-setting-store --route store --desktop --mobile \
    --port 18899 --binary <tmp>/kored --mock <tmp>/mock.json \
    --expect-text '日志查看分析插件' --settle 1500
输出:
[INFO] 隔离实例: pid=2536190 port=18899
[INFO] settingBtns=1 uninstalledSettingBtns=0 btnW=52.015625 btnH=32 panelTitle=日志查看分析插件 设置   # desktop
[INFO] settingBtns=1 uninstalledSettingBtns=0 btnW=72.671875 btnH=44    panelTitle=日志查看分析插件 设置   # mobile
[OK] desktop 1440x900 95066B .../plugin-setting-store-desktop-01.png
[OK] mobile 390x844 50957B .../plugin-setting-store-mobile-01.png
[DONE] scene=plugin-setting-store route=store
退出码: 0
```

工具口径：复制 `scripts/ui-shot.sh` 并仅在其 Playwright 截图段注入「真点击 `.store-btn-setting` → 等待 `.cfg-panel` → 断言字段加载 → 再拍面板态」逻辑；其 git archive → 独立构建 → config/state/run/log 全落 /tmp → 独立端口 18899（避开 18890–18898）→ healthz 就绪 → 真实登录表单拿 cookie → 路由存在性校验（`KoreShell.current()==='store'`）→ 双端截图 → trap 自动停实例删临时目录，均保持原样。

**mock 数据如实声明**：隔离实例全新 state 默认无已装插件，无法自然渲染「已装卡片」。用工具原生 `--mock` 桩三段只读/配置响应：
1. `GET /api/v1/store/plugins` → 两条索引条目（logs 生产级已装 + echo 基础级未装，作对照）；
2. `GET /api/v1/plugins` → 已装 logs 一条（带 enabled/desired，驱动已装分支）；
3. `POST /api/v1/invoke/logs/logs.config.get` → 真实 logs 插件同形 schema（list 字段 + 帮助文案，取自 `../kore-plugin-logs/config.go` 真值）。

**mock 只提供数据，不伪造交互**：「设置」按钮是真实 DOM（`<tmp>/src/web/dist/store.js` 已校验含 store-btn-setting），点击走真实 `window.KoreShell.openConfig` → 真实 `KoreConfig.open` 渲染，面板与卡片布局全真。未装 echo 卡片是 mock 数据的一部分，其「无设置按钮」是真实渲染结果，非手工隐藏。

**G-29 复核（拍完仍成立）**：

```text
$ ss -ltn | grep ':18899 '                → 无残留监听（隔离实例已由 trap 清理）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz  → 200
$ stat -c '%y %s' .kore-local.yaml         → 2026-11-23 04:59:58.799907899 +0800 1677（未变）
$ ls /tmp/r24store.*                      → 无残留（临时目录/脚本/二进制/mock 同批清理）
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主 state/run/socket，未重建主 `bin/kored`，未重启 8787，未使用任何共享桌面浏览器窗口。全部证据来自独立归档构建 + 独立实例的 headless playwright 自拍。

## 4. 截图清单与 file/md5 实测

全部存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`；PC 1440×900 fullPage，手机 390×844 视口精确截图（deviceScaleFactor=1）。`01` = 卡片按钮态，`02-panel` = 真点击后配置面板态。

```text
$ file plugin-setting-store-*.png
plugin-setting-store-desktop-01.png:       PNG image data, 1440 x 900,  8-bit/color RGB, non-interlaced
plugin-setting-store-desktop-02-panel.png: PNG image data, 1440 x 1149, 8-bit/color RGB, non-interlaced
plugin-setting-store-mobile-01.png:        PNG image data, 390 x 844,  8-bit/color RGB, non-interlaced
plugin-setting-store-mobile-02-panel.png:  PNG image data, 390 x 844,  8-bit/color RGB, non-interlaced
退出码: 0

$ md5sum plugin-setting-store-*.png
635d4d7926425fbb4fad2ecaf047a2ee  plugin-setting-store-desktop-01.png
6132b0e3333ff0f9438d8f2347356b06  plugin-setting-store-desktop-02-panel.png
f2eba0a8449e815452bc122cd2688dc7  plugin-setting-store-mobile-01.png
7220391cb34080112c9bff64ebba9b41  plugin-setting-store-mobile-02-panel.png
退出码: 0；4 张 md5 去重计数 = 4（全不同）
```

蓝军自检「同图缩放冒充双端 / 设计稿替代 / 拍到旧界面」：**全部证伪**。md5 全异 + `file` 实测宽高不同（desktop 卡片态 900 高 vs 面板态 1149 高，因面板展开 fullPage 变长）+ 目视确认手机端导航收进底部 tab、卡片单列、操作条等宽堆叠，与 PC 三/四列横排明显不同；构建源已 grep 校验含 store-btn-setting，拍到的正是新代码。

## 5. 交互真实性与页面内容（真登录 + 真点击 + 目视）

```text
[desktop 01] 真表单登录 → 路由 #/store → 断言 KoreShell.current()==='store'
  → 目视：左侧「软件商店」高亮；顶部子 tab「软件商店 / 插件管理」；统计「共 2 个插件 · 已安装 1 个」
  → 已装「日志查看分析插件」卡片：徽章「生产级/已安装/已是最新」+ 操作条
      【设置 | 卸载(红) | 重装 | 停用】——四按钮并存，设置按钮为中性灰 btn-ghost
  → 未装「Echo 验证插件」卡片：只有【离线安装 | 安装】，无「设置」按钮
  → 实测 settingBtns=1、uninstalledSettingBtns=0（断言通过）

[desktop 02-panel] 真点已装卡片的「设置」按钮
  → 弹出配置面板：标题「日志查看分析插件 设置」+ 提示「保存后立即生效，无需重启」+ 关闭 ×
  → 字段「日志来源」+ 值「syslog=/var/log/syslog」+ 帮助文案 +「＋添加一项」+【保存|恢复默认值】
  → 面板挂在视图根容器（卡片网格之后），未插进卡片内部，布局无错乱

[mobile 01] 同内容；卡片单列、操作条四按钮等宽撑满（设置/卸载/重装/停用）、触摸目标 btnH=44px；
  Echo 未装卡片无设置按钮；底部导航收进「更多」
[mobile 02-panel] 真点「设置」→ 同款面板在 390px 下纵向堆叠，标题折行（窄屏正常），字段/帮助/按钮真实可见
```

隔离实例为 mock 数据（2 条），**未伪造安装动作**；本卡验证对象是「已装卡片是否显示设置入口 + 点击是否弹出统一面板」，mock 提供已装态数据属必要的测试夹具，已在第 3 节如实声明。

## 6. 产品定位自评三问（G-28 原文）

**问 1：本页解决什么用户问题？** 用户原话「软件商店的每一个软件都应该支持自己的设置页面」。过去商店已装卡片只有卸载/升级/启停，装了插件却找不到改配置的地方；DNS 视图虽有设置入口，但商店里没有统一口径。本改动让**每张已装插件卡片**都有「设置」按钮，点开复用同一个 `config-panel.js` 动态表单（按插件 info/schema 渲染、走 config.get/set、保存即生效），未装卡片不显示（没配置可设）。中文标签 + 一行帮助 + 保存提示，小白照着就能配。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的插件设置多为每插件独立页面，入口分散、重复实现表单。Kore 的优势是统一配置契约（PLUGIN-CONFIG）+ 单一面板（`KoreConfig.open`）：新增插件只要实现 config.get/set 两个方法，商店入口自动可用，零重复 UI。差距：①当前只有实现了 config 契约的插件点开才有真实字段，未实现的点开进入 r24-cfgempty 负责的「暂无可配置项」空态（本卡不重复判断）；②保存后的热生效程度取决于各插件 config.set 的 `restart_required` 返回，不由入口卡保证。

**问 3：当前"可用"还是"占位"？** **可用。** 判据：隔离实例真浏览器确认已装卡片设置按钮真实渲染、未装卡片无按钮、真点击进入真实配置面板且字段/帮助/按钮齐全（desktop + mobile 双端双态四图），`node --check` 与 `frontend-check` 全过。诚实标注：截图用 mock 提供「已装态」与 schema 数据（隔离实例全新 state 无真实安装），未在主实例对真实已装插件做点击验证（G-29 保护共享运行态资产）；安装动作本身、config.set 保存落盘不在本卡验证范围。

## 7. 已证明 / 未证明（两栏）

| 项 | 已证明（本次真机证据） | 未证明（如实列出） |
| --- | --- | --- |
| 双端截图 | PC 1440×900 / 手机 390×844 各 2 张（卡片态 + 面板态），`file` 实测合规、md5 全异、目视无遮挡 | 未在主实例 8787 取证（共享运行态资产，不碰） |
| 已装显示/未装隐藏 | 真点击断言 `settingBtns=1 uninstalledSettingBtns=0`；双端目视已装 logs 有按钮、未装 echo 无按钮 | — |
| 点击弹面板 | 真点「设置」→ `.cfg-panel` 出现、标题 opts.title 生效、字段/帮助/保存按钮齐全（四图） | 未验证保存落盘 / config.set 返回处理（面板自身职责） |
| 触摸目标 | 手机端按钮实测 btnH=44px（裁决41）；样式复用既有 `.store-ops .btn` | — |
| 不破坏现有按钮 | 卡片态目视【设置\|卸载\|重装\|停用】四按钮并存，未装卡【离线安装\|安装】照常 | 未逐一真点卸载/升级/启停（本次只验设置入口） |
| 静态门禁 | `node --check` exit 0；`frontend-check` 首屏 77763 ≤ 307200 exit 0 | — |
| G-29/G-30 | 主配置 mtime 未变、8787 未重启、healthz 200、18899 零残留；临时文件零残留；报告无明文口令 | — |

## 8. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file`/`md5sum` 实测四图；目视 DOM 原文照录。
- **G-12 写域**：代码仅 `web/store.js`；新增 4 张 PNG + 本报告；未改任何他人文件 / 运行态资产。
- **G-28**：双端 + 产品三问 + 已证明/未证明两栏 + md5 全异 + 尺寸实测，逐条满足。
- **G-29**：主实例运行态零改动（第 3 节复核）；全部证据来自隔离实例。
- **G-30**：报告无任何明文口令（登录口令为随机值且仅存在于已删除的临时目录）。
- **G-33 A4**：按钮文案「设置」、面板标题「X 设置」均为白话，无 instance/revision 等内部术语。
- **临时清理**：`/tmp/r24store.*` 临时目录（含二进制/mock/脚本副本）在同一次 bash 调用内 `rm -rf`，`ls` 确认无残留；隔离实例由 trap 停止。
