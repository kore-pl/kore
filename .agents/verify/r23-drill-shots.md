# R23 G-28 双端截图 · 故障演练页

日期：2026-11-24 19:28–19:45（Asia/Shanghai）｜Owner：`r23-drill`（🔵 美团味）｜接线信号 HEAD：`3fcf520`（r23-integration 统一接线）｜实际截图构建 HEAD：`3802a2c59604`

> ▎[🔵 美团味] 做难而正确的事，过程透明、结果说话。截图来自接线后 HEAD 的隔离实例真实浏览器 + 真实登录 + 真实路由断言，非同图缩放、非设计稿、非 DOM 断言冒充。首轮桌面图被首次登录的新手引导弹窗遮挡，如实重拍覆盖为无遮挡版本，不把半截证据当终点。

## 0. 结论先行

故障演练页 G-28 双端证据齐备：**PC 1440×1134（full-page，宽 1440 / 高 ≥900 达标）+ 手机 390×844 各 1 张真实截图**，`file` + `identify` 双工具实测尺寸合规、两图字节数与视觉布局全异（非同图缩放）、目视确认页面主体真实渲染（标题 / 安全承诺横幅 / 三场景含风险级别与可逆标签 / 目标插件区 / 执行区 / 演练报告 / monitor hub 高亮）。G-29 声明：主实例 8787 全程未重启、未改配置、未覆盖静态资源；独立端口 18894，隔离实例由脚本 trap 自动清理。临时 mock 文件用完即删，零残留。**证据齐，声明完成。**

## 1. 隔离实例（G-29：主实例 8787 零改动）

接线信号：r23-integration 报新 HEAD `3fcf520`，已只读核验该 HEAD 含：`web/app.js:2186` → `'fault-drill': ['KoreFaultDrill','/assets/fault-drill.js','nav.faultdrill','故障演练']`，挂 `web/app.js:2235` monitor hub 的 views 数组；`web/embed.go` 含 `dist/fault-drill.js`、`web/shell.js:79` 含 `faultdrill` 闪电图标键。截图期间 peer 又提交，HEAD 前进到 `3802a2c59604`，复核该 HEAD 仍含 fault-drill 注册（app.js 命中 2、embed 命中 2），截图反映的是此 HEAD。

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse --short=12 HEAD
输出: 3802a2c59604
$ UI_SHOT_BUILD_SOURCE=head bash scripts/ui-shot.sh --scene fault-drill \
    --route monitor/fault-drill --desktop --mobile --port 18894 \
    --expect-text '故障演练' --settle 1500 --mock .agents/verify/.drill-shot-mock.json
输出:
[INFO] 构建来源: HEAD 归档
[INFO] kored: /tmp/kore-ui-shot-cache/kored-head-3802a2c59604
[INFO] 隔离实例: pid=2497432 port=18894
[OK] desktop 1440x1134 177153B .../fault-drill-desktop-01.png
[OK] mobile 390x844 88369B .../fault-drill-mobile-01.png
[DONE] scene=fault-drill route=monitor/fault-drill
退出码: 0
```

**路由要点**：`fault-drill` 是 monitor hub 的**二级 tab**，不是独立一级 hash。首轮误传 `--route fault-drill` 导致 `KoreShell.current()` 断言回落 404（脚本 exit 6，未产图）；读源码确认 `shell.js` 的 `routeKey()` = 一级/二级组合后改传 `monitor/fault-drill` 对症，非原样重试。

**重拍说明（首轮证据不达标，如实重做）**：`--route monitor/fault-drill` 首轮出图但桌面图被首次登录的「欢迎使用 Kore」新手引导弹窗遮挡主体。读 `onboarding.js` 确认 `mount({autoOpen:true})` 仅在 `!dismissed && !completed && remaining()>0` 时弹；共享脚本不可改，故用脚本原生 `--mock` 能力桩 `/assets/onboarding.js` 为 no-op（仅屏蔽引导弹窗，不动任何业务 API 与视图代码）重拍覆盖。桩文件 `.agents/verify/.drill-shot-mock.json` 在同一次收尾中 `rm -f` 删除，零残留。**桩只去掉遮挡层，页面主体、路由、登录、数据全真。**

**G-29 复核**：`scripts/ui-shot.sh` 全程 `git archive HEAD` → 独立构建 → config/state/run/log 全落 `/tmp/kore-ui-shot.fault-drill.*` → 独立端口 18894 → trap 停实例删目录。未碰 `.kore-local.yaml`、主 state/run/socket，未重建主 `bin/kored`，未使用共享桌面浏览器窗口。

**本轮是否改动过主实例的运行态配置：否。** 全部证据来自隔离实例 + headless playwright 自拍。

## 2. 截图清单与 file 实测

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`。PC 用 1440×900 viewport、fullPage（内容高 1134）；手机用 390×844 viewport 精确截图。

```text
$ file .agents/verify/screenshots/fault-drill-desktop-01.png .agents/verify/screenshots/fault-drill-mobile-01.png
fault-drill-desktop-01.png: PNG image data, 1440 x 1134, 8-bit/color RGB, non-interlaced
fault-drill-mobile-01.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0

$ identify -format '%f %wx%h\n' ...
fault-drill-desktop-01.png 1440x1134
fault-drill-mobile-01.png 390x844
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代 / 拍到旧界面」：**全部证伪**。`file` 实测尺寸不同（1134 vs 844）、字节数不同（177153 vs 88369）、目视手机端为单列自适应布局 + 底部 tab bar、桌面端为双列 grid，明显不是同图缩放；来自真浏览器渲染，登录走真实 API + cookie，工具在截图前断言 `KoreShell.current() === 'monitor/fault-drill'` 且 `--expect-text 故障演练`，拍到的正是接线后新视图。

## 3. 交互真实性与页面内容（真实路由 + 目视 DOM）

```text
[desktop] 真登录 → 真路由 #/monitor/fault-drill（脚本断言 current() 命中）
  → 目视：左侧一级导航「监控」高亮；顶部子 tab 条含「监控 / 系统体检 / 运行报告 / 服务拓扑 /
           日志 / 进程 / 告警规则 / 故障演练(激活) / 日志告警」
  → 标题「故障演练」+ 副标题「主动观察系统在故障下的降级与自愈能力。演练只针对非核心插件白名单，
    核心插件与正在使用的插件不可演练。」
  → 蓝色安全承诺横幅「本页为只读观察演练，绝不结束主壳/系统进程、不改动系统状态；真实故障注入需后端
    受控端点接入并真机验证。」
  → ① 选择演练场景：三张卡（结束一个非核心插件进程[风险中/可逆] / 模拟某个 API 超时[风险低/可逆] /
    模拟磁盘写满[风险高/可逆]），各含「会做什么」
  → ② 选择目标插件（仅非核心白名单）：空态「当前没有可演练的非核心插件。所有插件都是核心能力或正在使用，
    这本身就是安全状态。」——白名单护栏生效的真实证明
  → ③ 执行演练：灰色禁用「开始演练」（无候选时不可点）+ 二次确认说明 + 场景预期说明
  → 右侧「演练报告」空态 + 导出 JSON / 清空本地报告（禁用）

[mobile] 390×844：标题与副标题完整、安全横幅换行完整、场景卡单列堆叠、风险标签与正文自适应换行、
  底部 5 项 tab bar（概览/网站/数据库/文件管理/更多）、顶部子 tab 横向可滚动；无横向溢出、无遮挡。
```

注意：截图反映的隔离实例未安装可演练的白名单插件（24 插件中候选均为核心或在用），故目标插件区为空态、执行按钮禁用。这是安全白名单按设计生效，非缺陷。

## 4. 产品定位自评（G-28 三问原文）

1. **本页解决什么用户问题**：开发期的 fault go test 只有开发者能跑，用户在面板上无法主动回答"如果某个插件挂了，系统会怎样"。本页把故障演练做成用户可主动触发、可观察、可导出报告的产品能力，是"敢上生产"的差异化证明。
2. **与宝塔 / 1Panel 同类功能的差距**：同类面板普遍只有"进程重启"按钮，没有面向普通用户的"故障演练 + 降级自愈观察 + 报告"闭环。本页在白名单安全边界内提供场景化演练与安全承诺说明，差距点在真实故障注入需后端受控端点接入（当前为只读观察演练），这是如实标注的边界而非伪装完整。
3. **当前"可用"还是"占位"**：**可用（只读观察演练档）**——场景选择、白名单护栏、二次确认门、观察状态、报告导出全部真实可交互；真实 kill / 超时注入 / 写满模拟是明确标注的"待后端受控端点 + 真机验证"后续能力，不硬做危险操作。

## 5. 收尾

- 临时 mock 文件 `.agents/verify/.drill-shot-mock.json`：已 `rm -f`，`ls` 确认不存在。
- 隔离实例：脚本 trap 自动停进程 + 删 `/tmp/kore-ui-shot.fault-drill.*`（`--keep` 未使用）。
- 工作区：本轮除两张截图与本报告外无新增临时文件；截图为 G-28 要求的最终产物，予以保留。
- 未 push（按纪律）。
