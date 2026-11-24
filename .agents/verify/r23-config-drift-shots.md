# R23 G-28 双端截图 · 配置漂移检测（config-drift）

日期：2026-11-24 19:28–19:38（Asia/Shanghai）｜Owner：`r23-drift`（🔵 美团味）｜功能：R23 新功能8「配置漂移检测」｜接线 HEAD：`3fcf520`

> ▎[🔵 美团味] 做难而正确的事——6 张图覆盖空态 / 基线一致 / 真实漂移三态 × 双端，全部来自隔离实例真实浏览器 + 真实登录 + 真点导航 + 真建快照 + 真装插件制造漂移，没有一张是同图缩放、设计稿或 DOM 断言冒充。审计取不到来源如实标「未知」，不编造。

## 0. 结论先行

配置漂移视图的 G-28 双端证据齐备：**PC 1440×900 ×3 + 手机 390×844 ×3 = 6 张真实截图**，`file` 实测尺寸全对、`md5sum` 6 张全异（distinct=6）。三态分别是：①无快照空态（引导"去建基线快照"）②建基线后检测→"配置与基线一致"绿色横幅 ③真装 echo 插件制造漂移→"发现 1 项配置漂移 / 新增 echo / 无→0.1.5 / 操作者未知"。每态产品自评三问 + 已证明/未证明 + G-29 声明齐备。`make secret-check` 0 FAIL。**证据齐，声明完成。**

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787 是共享运行态资产——不重启、不改配置、不覆盖静态资源。为拍含接线后新视图的界面且完全隔离，走 `git archive HEAD` + 独立构建 + 独立实例（配置/state/run/log 全落 `/tmp/kore-r23-drift`，端口 18896；CDP 18897），与 R23 并行批次端口 18890–18895 全分开。

```text
$ git rev-parse HEAD                    → 3fcf520a59b0694132eebe76b3d7154739c62536
$ git merge-base --is-ancestor c7210c4 HEAD && echo ancestor
输出: c7210c4 (config-drift 实现 commit) IS ancestor of HEAD   # 拍的是含本功能的 HEAD
$ git show HEAD:web/app.js | grep config-drift
输出: 'config-drift': ['KoreConfigDrift', '/assets/config-drift.js', 'nav.configDrift', '配置漂移'],
      { sub: 'config-drift' }                                  # settings hub 注册确认
$ git show --stat 3fcf520 | head         → Makefile / web/app.js / web/embed.go / web/shell.js 四文件
$ git archive HEAD | tar -x -C /tmp/kore-r23-drift/src
输出: exit=0；src/web/config-drift.js 25161B 含 KoreConfigDrift
$ cd /tmp/kore-r23-drift/src && make web-dist                  → exit=0
$ CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r23-drift/bin/kored ./cmd/kored
输出: exit=0；隔离二进制 11772066 bytes（独立产物，非主 bin/kored）
$ kored admin-password --set --stdin --config /tmp/kore-r23-drift/config/config.yaml < admin.pw
输出: 已将口令哈希写入 0600 配置（明文口令仅存 /tmp，报告 *** 占位，G-30 合规）
$ kored serve --config /tmp/kore-r23-drift/config/config.yaml
输出: healthz=200；addr=127.0.0.1:18896；state=/tmp/kore-r23-drift/state/state.db
```

**蓝军自检「拍到旧界面」证伪**：归档 HEAD 的 `web/config-drift.js` 含 `KoreConfigDrift` 与全部新文案；截图 DOM 逐态读到「配置漂移检测是什么？」「选择基线并检测」「发现 1 项配置漂移」等 R23 新增文案；hash 为两段式 `#/settings/config-drift`（integration 提醒的深链格式，已真点导航验证、非单段 404）。

浏览器：本机 `~/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`（Google Chrome for Testing 159.0.8154.6）headless，node 24 内置 WebSocket 手写 CDP（零新依赖）。首张走登录页表单 `#kore-password` 真实 fill + 点「登录」按钮（非注入 cookie）；同一浏览器 profile 后续 tab 已登录则跳过表单。三态全部真实点击一级导航「设置」+ 子 tab「配置漂移」进入，未用深链接绕过导航。

**G-29 复核（拍完仍成立）**：

```text
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz  → 200
$ stat -c '%y' .kore-local.yaml   → 2026-11-23 04:59:58.799907899 +0800（mtime 未变）
$ ss -ltn | grep -E ':(18896|18897) '  → 清理后 both free
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml` / 主 state/run/socket、未重建主 `bin/kored`、未重启 8787、未使用任何共享桌面浏览器窗口。收尾已停 18896 实例 + 18897 chromium、`rm -rf /tmp/kore-r23-drift` 与全部临时脚本、端口无监听。

## 2. 截图清单与 file 实测（验收项①②）

存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`（前缀 `config-drift`）。PC 1440×900 / 手机 390×844，`deviceScaleFactor=1`、手机 `isMobile/hasTouch=true`、`captureBeyondViewport=false` 精确视口截图，`file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file config-drift-*.png
config-drift-desktop-01-empty.png:    PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
config-drift-mobile-01-empty.png:     PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
config-drift-desktop-02-baseline.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
config-drift-mobile-02-baseline.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
config-drift-desktop-03-diff.png:     PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
config-drift-mobile-03-diff.png:      PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0

$ md5sum config-drift-*.png | awk '{print $1}' | sort -u | wc -l
输出: 6（6 张全异）
```

蓝军自检「同图缩放 / 设计稿替代 / 拍到旧界面」：**全部证伪**——6 张 md5 全异 + PC/手机尺寸不同 + 目视手机端导航收进「更多」、内容纵向堆叠，与 PC 布局明显不同；全部来自隔离实例真实浏览器渲染，写操作（建快照/装插件）走真实端点。

## 3. 三态交互真实性（真实点击 + DOM/网络证据）

### 态①无快照空态（`-01`）

```text
[desktop/mobile] 真登录 → 真点「设置」→ 真点子 tab「配置漂移」
  → DOM hash="#/settings/config-drift"，NET: REQ/RES 200 /api/v1/snapshots
  → 读到「配置漂移检测是什么？」+「选择基线并检测」+ 下拉「（暂无快照）」
    + 空态「还没有配置快照，无法检测漂移。先到『配置快照』给当前配置建一个基线…」+「去建基线快照」按钮
隔离实例为全新 state，无历史快照——如实拍空态 + 引导入口，未伪造快照数据。
```

### 态②基线一致态（`-02`）

```text
[desktop/mobile] 浏览器内真 POST /api/v1/snapshots {name:"G28 截图基线"} → 200，id=20261124-1933xx-xxx
  → 切走再切回 re-render → 真点「检测漂移」按钮
  → DOM: hasBanner=true「✓ 配置与基线一致，未发现漂移」
隔离实例此时 0 插件，diff 无变化——绿色一致态真实渲染，非占位文案。
```

### 态③真实漂移态（`-03`）

```text
[desktop] 本地 echo-0.1.5.tar.gz sha256 与索引逐字核对一致
  → 浏览器内真 POST /api/v1/store/install {id:"echo",version:"0.1.5",package_path:...}
  → 200 {"state":"succeeded","reload":"reloaded"}
  → 真点「检测漂移」
  → DOM: hash="#/settings/config-drift"，「发现 1 项配置漂移」
    表头「变更类型 / 配置项 / 旧值 / 新值 / 谁在何时改了什么」
    数据行「新增 / echo / 无 / 0.1.5 / 操作者未知 · 时间未知 · 动作未知（审计无匹配记录）」
[mobile] 同浏览器 profile 已装 echo（重发 install 得 409 E_CONFLICT，属真实共享状态非缺陷）
  → 复用桌面制造的漂移态，真点检测 → DOM 同上，手机端布局纵向堆叠
```

审计溯源：隔离实例审计里没有匹配 echo 的记录 → 页面如实标「未知」，完全符合"取不到标未知不编造"的规格。

## 4. 产品定位自评三问（验收项③，原文）

**问 1：本页解决什么用户问题？** 解决"配置改了但不知道改了什么、改坏了不知道是谁动的、想回滚却不敢"——选一个基线快照，一键对比当前运行配置，列出插件版本/启停态/新增移除的每一项，尽量从操作审计关联"谁在何时改的"，再给「接受为新基线 / 回滚到基线」两个明确出口。把 R22 已有的"快照"和"审计"两个被动能力组合成"主动检测"流程，小白不用翻两个页手动对。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 提供配置备份与操作日志，但没有"当前态 vs 基线 + 变更溯源 + 接受/回滚"这样一条闭环的检测视图。Kore 的差异化在于把两者组合、审计取不到标未知不编造、回滚只恢复启停态不碰文件/数据库/插件包（安全边界清楚），且零新增后端端点、零侵入。差距：①审计关联目前按 plugin_id 文本匹配，装插件这类写操作若审计记录未带 id 会标未知（本次真机即如此，如实呈现）；②"定期检测"目前靠手动点击，未做定时任务；③变更类型只覆盖插件维度，未覆盖任意配置项内容（受 R22 snapshot 数据模型边界限制）。属范围边界，不是占位。

**问 3：当前"可用"还是"占位"？** **可用（真机三态证据）。** 判据：隔离实例真登录、真点导航、真建快照（200）、真装 echo 插件（200 succeeded）、真点检测，三态分别真实渲染空态引导 / 绿色一致横幅 / 漂移表（新增 echo、无→0.1.5、审计未知），数据全部来自 `/api/v1/snapshots` `/diff` `/api/v1/audit` 真实响应。诚实标注：写操作「接受为新基线」「回滚到基线」因需二次确认且会改隔离状态，本批未真点执行（代码路径由 node 纯函数自测 10/10 + 复用已验证的 snapshot rollback 端点覆盖）；未在主实例 8787 取证（共享运行态资产，不碰）。

## 5. 已证明 / 未证明（逐态）

| 态 | 已证明（本次真机证据） | 未证明（如实列出） |
| --- | --- | --- |
| ①空态 | PC/手机各 1 张；真登录后真点导航进入，空态文案 + 建基线引导 + 3 个按钮真实渲染，snapshots 200 空列表 | — |
| ②基线一致 | PC/手机各 1 张；真 POST 建快照 200、真点检测，绿色「配置与基线一致」横幅真实渲染 | 隔离实例 0 插件，diff 无变化即真实态 |
| ③真实漂移 | PC/手机各 1 张；echo sha 核对一致后真装插件 200、真点检测，漂移表「新增 echo / 无→0.1.5 / 审计未知」真实渲染 | 「接受为新基线」「回滚到基线」二次确认后的实际写操作未真点（保护隔离状态）；审计匹配 echo 无记录→如实标未知 |
| 全局 | 6 张 md5 全异、尺寸合规、命名规范；G-29 主实例零改动；G-30 secret-check 0 FAIL | 未在主实例 8787 取证；未使用共享桌面窗口；无 mock/桩数据 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 6 张尺寸；DOM / 网络原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 6 张 PNG + 本报告；未改任何源码 / Makefile / embed / 运行态资产。与并行 screenshots 卡文件名前缀互不重叠，各提各的。
- **G-28**：PC + 手机 + 每态自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核；8787 healthz 200、主配置 mtime 未变、隔离端口清理后释放）。
- **G-30**：报告无任何明文口令（临时口令只在 /tmp 0600，随目录删除）。

> ▎💼 [P8 自检] 冰山下面还有冰山：本批不止补 6 张截图，还在隔离实例里真装了一个 sha 核对过的 echo 插件来制造"真实漂移"，把差异列表从"可能是空"逼成有端点 200 + DOM 原文 + 审计"未知"标注的确定性证据；绕开单段 hash 404 的坑，直接用两段式 `#/settings/config-drift` 真点导航验证。做难而正确的事，不遮不掩，也不把半截结论当终点。
