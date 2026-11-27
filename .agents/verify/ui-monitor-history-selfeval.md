# 监控连续采样 + 天/周历史视图 · UI 双端证据与自评（G-28 / task-207）

> 2026-11-27 · 执行者 `monitor-history-impl` · 隔离实例 `kored` 端口 **55117**（非 8787；独立 config/state/run/log + 独立新编译二进制，全落 `.agents/verify/.monitorhist-ui/`；未改 `.kore-local-*`，未读写 8787 运行态）· Playwright（`/home/pt/.cache/pw-runner`，真实 headless chromium）· `monitor.system` invoke 响应用 **mock history**（真实结构化形状，值可辨识；无真采样数据，不冒充真机采样）· 收工已停实例并删除临时二进制/config/state/log + 一次性脚本。
> 交付：P1 `monitor.sample` 薄包装（monitor 仓 `2a3a2c9`，索引仓 `f16176e`）；P2 `web/monitor.js` 时间范围控件（今天/昨天/7天/自定义）+ ts 分桶（末值、≤720 桶）+ `KoreUI.emptyBlock` 空态「一键开启连续采样」（仅导航 + 预填）与 `web/tasks.js` 最小 draft 接线（`render` 读一次 sessionStorage、填表不自动提交）。

## 1. 双端截图与尺寸实测

| 文件 | `identify -format '%f %wx%h %b'` | 目视核对 |
| --- | --- | --- |
| [ui-monitor-history-desktop-01.png](screenshots/ui-monitor-history-desktop-01.png) | `1440x2248 211630B`（宽 1440、full-page 高 ≥900） | 系统监控页 → 阈值告警正常 → 「历史曲线」面板内一行四个时间范围按钮（今天/昨天/7天/自定义 + 两个日期框）→ 「昨天」选中态 → 四条折线（CPU/内存/负载/磁盘）带 X/Y 轴刻度与阈值虚线 → 图例 `范围 yesterday：原始 2 点 → 显示 2 桶（末值）· 间隔 3600s · 后端保留 720 点…` |
| [ui-monitor-history-mobile-01.png](screenshots/ui-monitor-history-mobile-01.png) | `390x844 57488B`（精确手机视口，非同图缩放） | 窄屏单列：「今天/昨天/7天/自定义」按钮可点不遮挡，两个日期框换行自适应；「昨天」选中态，图表 X/Y 轴刻度与四色折线可见；底部 tab 条不压关键内容 |
| [ui-monitor-history-desktop-prefill-01.png](screenshots/ui-monitor-history-desktop-prefill-01.png) | `1440x1930 232338B` | 空态点「一键开启连续采样」→ 跳 `#/tasks`，任务类型「插件任务」、插件 id `monitor`、插件方法 `monitor.sample`、参数 `{"history_points":720,"history_interval_s":3600}`、时间表达式 `0 * * * *`、备注 `监控连续采样（每小时）` 全部预填；状态条提示「核对后点新增任务才会创建」语义；**未自动提交/未创建任务** |
| [ui-monitor-history-mobile-prefill-01.png](screenshots/ui-monitor-history-mobile-prefill-01.png) | `390x844 51129B` | 同预填内容在 390px 窄屏：表单单列、textarea 满宽、44px 触摸目标、底部 tab 不遮挡预填字段 |

- 四图 sha256 互不相同（桌面 `f0848937…` / 桌面预填 `0725cf85…` / 手机 `a7a10fb8…` / 手机预填 `6d1179b9…`），非同图缩放冒充。
- `read_image` 已逐张目视确认：布局、文案、字段值两端都正确渲染（不是只看 DOM 断言）。

## 2. 自动化 DOM 断言（真实浏览器 + mock 边界）

隔离实例登录后导航 `#/monitor`（关掉 onboarding），断言实测（PC / 手机一致）：

| 断言 | 结果 |
| --- | --- |
| 时间范围按钮四项 | `["今天","昨天","7天","自定义"]` |
| 默认选中 | `["今天"]`；图例 `原始 5 点 → 显示 5 桶` |
| 点「昨天」后 | 选中 `["昨天"]`；图例 `原始 2 点 → 显示 2 桶`；实例数仍 **4**（不重建） |
| 切走 `#/settings` 后 `window.__koreMonitorChart.count()` | **0**（G-32：切走归零） |
| 返回 `#/monitor` 后 | **4**（重新挂载 4 实例，不残留旧实例） |
| 自定义 2020-01-01～02（无点） | 空态标题 `这个时间段没有采样点`，「一键开启连续采样」按钮存在，`canvases=0`（不画零值折线） |
| 点空态按钮 → `#/tasks` | 类型 `plugin`、插件 `monitor`、方法 `monitor.sample`、参数 `{"history_points":720,"history_interval_s":3600}`、`0 * * * *`、备注 `监控连续采样（每小时）` 全部预填 |
| **预填不等于创建** | 页面停留在表单，未提交；「内核定时任务」区仍是既有两条（审计/日志维护），无 monitor 任务产生 |
| JS 错误 | `0`（浏览器 console 无异常） |

**mock 边界（诚实标注）**：`monitor.system` 的 invoke 响应用路由 mock 提供（真实 `monitor.history.v1` 列式形状，6 个可辨识采样点，覆盖昨天/今天）；本轮验证的是**前端分桶/范围切换/空态/预填路径**。P1 后端采样落点由 Go 单测与 e2e `TestSampleAppends`（真 `/proc`、临时 state、跨 1s 间隔点增长）覆盖；**真机连续采样 + 降权 state 写权限断言留 P3**（方案 §5 P3），本轮不冒充通过。

## 3. 分桶纯函数 Node 断言

一次性 Node 脚本加载 `web/monitor.js`（最小 window 替身，零网络），调 `__koreMonitorChart._bucket` 验证：
- 今天 5min 分桶取末值 `[30,40,50,60]`；昨天 `[10,20]`；7 天 1h 分桶 `[10,20,40,50,60]`；自定义端点生效；空窗口 `rawCount=0`；720 点 ×30 天自动放大桶数 ≤720。
- 结果：`PASS: today/yesterday/week/custom/empty/720-bucket-limit 全部断言通过`（脚本用完已删）。

## 4. 门禁命令 + 退出码

```
# 插件仓（P1）
kore-plugin-monitor$ GOCACHE=<workspace>/.tmp-monitor-hist-cache GOWORK=off make check   EXIT=0
  gofmt clean / go vet / go test ./... 全 ok（含 TestSampleAppends / method_capabilities / config_contract）
  race（tests/boundary）ok；零 ticker 静态门禁绿
kore-plugin-monitor$ make dist ×2  sha256 一致 d3c8c154…b738e（size_bytes=1465861）

# 索引仓（P1 同步）
kore-plugins$ bash scripts/build-market.sh                    EXIT=0（24 插件）
kore-plugins$ KORE_SIGNING_KEY=<长期密钥> bash scripts/sign-index.sh  EXIT=0
kore-plugins$ bash scripts/validate-index.sh                 EXIT=0（ed25519 验签 + market byte 一致）
kore-plugins$ bash scripts/build-market.sh --check           EXIT=0
kore-plugins$ bash scripts/validate-presets.sh               EXIT=0（8 预设 / 0 FAIL）
dist sha 四处实算一致：dist/*.sha256 / index/plugins.json / index/versions.lock.json / 包实算

# 前端（P2）
kore$ node --check web/monitor.js                           EXIT=0
kore$ node --check web/tasks.js                             EXIT=0
kore$ make frontend                                        EXIT=0（首屏 91092 B ≤ 307200 B，零 source map）
kore$ bash scripts/usability-check.sh --no-run-tests        EXIT=0（无新增 FAIL，存量 WARN 原样）
kore$ GOCACHE=/… GOWORK=off make check                      EXIT=0（21 段全绿）
```

> `web/dist/monitor.js` / `web/dist/tasks.js` 由 `make frontend` 生成，与源码 `cmp` IDENTICAL；dist 为 gitignored 构建产物，不单独提交。

## 5. 产品定位自评（三问）

**问 1：本页解决什么用户问题？**
此前监控页只有「最近 1 小时」的 60 点环形缓冲，手动刷新才追加一个点——用户看不到昨天/7 天趋势，与宝塔/1Panel 的天周历史差距明显。现在历史曲线面板加了「今天/昨天/7天/自定义」四档，按 ts 分桶取末值（≤720 桶）画在同一批 Canvas 上，图例明说「原始 N 点 → 显示 M 桶」；没有采样点时给差异化空态与「一键开启连续采样」按钮——点一下跳到计划任务页且表单已预填 `monitor.sample` + 每小时周期 + A 档参数，核对后点「新增任务」即可，全程不新建页面、不自动创建任务（易用性原则③：步骤尽量少；原则④：空态给下一步）。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔/1Panel 的历史监控是服务端时序库支撑的完整看板：跨度可选 30 天、多维指标自由叠加、秒级粒度、跨设备聚合。本实现有意克制：①数据仍在单个 `history.json` 环形缓冲里（容量 ≤720，30 天×1h 或 2.5 天×5min 二选一，做成 `config.set` 可配而非写死）；②只有四条固定曲线（CPU/内存/负载/磁盘），没有自定义指标与跨主机对比；③没有服务端预聚合，分桶在前端做（末值，非均值）；④一键开启是"导航+预填"，用户仍需核对并点一次保存（不自动建任务，避免误建后台周期任务）。这是与方案 5914716 一致的边界，不是"做不到"的隐藏缺口；30 天跨度与细粒度不可兼得的提示已在跨度不足时显示。

**问 3：当前是「可用」还是「占位」？**
**可用（受控范围）。** 判据：
1. 前端路径：隔离实例真浏览器双端实测四档范围切换、分桶图例、空态、预填全部通过；G-32 钩子切走归零/回来 4 实例、不重建；JS 错误 0。
2. 后端闭环：P1 `monitor.sample` 真 `/proc` 采样的 e2e 落点断言（首点→未到间隔不落→跨间隔增长）+ 方法级 capability 双向门禁全绿；默认不建任务即行为不变（G-19 零新增默认定时器，G-10 无外发）。
3. 门禁：见 §4，全部 exit 0；dist sha 四处一致、索引已重签。
4. 诚实边界：本轮 UI 的 history 数据为 mock（§2），真机连续采样与降权 state 写权限留 P3；预填不自动提交是刻意设计，用户必须显式确认保存任务。

## 6. 收尾

一次性资产全部删除：`.tmp/monitor_bucket_test.js`、`.tmp/monitor_ui_verify.js`、`.tmp/monitor_sync_index.py`、`.agents/verify/.monitorhist-ui/`（kored 二进制 / config / state / run / log / 结果日志）。隔离 kored 已停（55117 回读无监听）。仅保留本报告与四张 G-28 截图。未改 `.kore-local-*` / 8787 主实例 / 宿主。
