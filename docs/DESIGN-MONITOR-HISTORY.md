> 状态: draft · 归属: monitor-history-design · 更新: 2026-11-27 · 里程碑: M5
> 定位: task-205 doc-first 方案（round 21，lead 已裁决重开并做，无需新 ADR）；供审阅后再进入实现。
> 边界: 本文只做方案，不改代码 / 不落实现 / 不改 backlog / 不碰运行实例。所有结论给出 `file:line` 或命令实证，未验证项明确标注。

# DESIGN-MONITOR-HISTORY — 监控连续采样 + 天/周历史视图（doc-first）

## 0. 一句话结论

复用现成接缝即可闭环：插件加一个**薄包装方法** `monitor.sample`（内部调已有 `Executor.System`，采集与 `recordHistory` 都现成），周期由**用户自建 scheduler 任务**提供（零内核代码、默认不注册）；前端在现有自研 Canvas 折线上加时间范围控件与 ts 分桶，不新页面、不破 G-32。版本按 feat→minor（0.5.1→0.6.0）走完整发版涟漪。三个真实卡点：① scheduler `interval_s` 与 `history_interval_s` 必须匹配，否则点被间隔门槛丢弃；② 单一环形缓冲无法同时给"30 天跨度"和"分钟粒度今天"，默认值需按口径选档并做成可配置；③ `history.json` 落在 `<KORE_STATE_DIR>` 根，降权 `kore-monitor` 的写权限**必须真机验证**（未验证，不能假设）。

## 1. 目标与范围

- 目标：把 monitor 的"手动刷新才追加一个历史点"升级为"可选连续采样"，并给前端昨天 / 今天 / 7 天 / 自定义四档时间范围视图，对标宝塔 / 1Panel 的天周历史（task-203 原文级证据）。
- 写域：仅本文。实现期跨两个仓：`kore-plugin-monitor`（后端采样 + 版本/dist）、`kore/web/monitor.js`（前端视图）、`kore-plugins`（索引 / 版本账本 / 预设 / 市场页重签）。
- 不做：DB 行编辑（维持不做，另卡回写 backlog）；不新增 ADR（ADR-0019 的"内核调度 + 插件实现"任务模型已覆盖）；不引入新依赖 / 新图表库 / 新页面；不默认开启任何周期任务。

## 2. 现状分析（代码实证）

| 事实 | 证据 | 含义 |
| --- | --- | --- |
| 采集逻辑已含 `recordHistory` | `kore-plugin-monitor/internal/monitor/collector.go:57-80`（Linux，`System` 在 `:76` 调 `recordHistory`）与 `shell.go:155-200`（macOS/Windows，`:196` 调） | 新增 `monitor.sample` 只是薄包装，不重写采集 |
| 历史环读写已完整 | `internal/monitor/history.go:16-25` 常量（默认 60 点 × 60s，上限 720 × 3600s）、`:72-109` 间隔门槛追加、`:111-118` 环形覆盖、`:166-201` 0600 同目录临时文件 + `rename` 原子写 | 数据模型与原子写无需重构 |
| 方法分发点 | `methods.go:24-79` dispatch、`methods.go:82-90` normalizeMethod、`internal/monitor/call.go:20-63` Call 分支、`config.go:374-394` configDefaultsFor | 加方法需同步这四处，缺一即 E_NOTFOUND 或配置不生效 |
| 声明一致性门禁 | `method_capabilities_test.go:29-34` implementedMethods 期望表、`:43-63` recordingExecutor 替身、`g19_test.go:11-53` 零 ticker 静态扫描 | 加方法必然撞测试替身与期望表（AGENTS §4 同仓并行纪律：视作同一写域） |
| 周期只来自内核单 ticker | `kore/internal/core/scheduler/loop.go:8-28`（单 goroutine + 单 ticker）、`scheduler.go:162-185`（Add 才 `startLoop`）、`:301-335`（Start 注册内置任务） | 插件内禁 ticker（G-19），周期必须走 scheduler |
| 用户可自建插件任务 | `handlers_scheduler.go:15` 端点 `/api/v1/scheduler/tasks`；`input.go:85-133` normalize 校验 plugin 正则且 `plugin=="kore"` 保留名拒绝（`:96`）；`task.go:42-44` interval 下限 30s | `plugin=monitor/method=monitor.sample` 是合法真插件任务，零内核代码 |
| 内置任务先例 | `maintaintask.go:8-78`（`builtin-logs-maintain`，插件任务、默认启用、负值禁用）；`scheduler.go:56-59/150-152`（Options 开关） | (b) 形态可行但要改内核 + G-23 留痕 |
| 默认零 ticker 的精确口径 | ADR-0019 §默认零后台定时器：`stopIfIdle`（`loop.go:54-67`）在无启用任务时停 ticker；但 `logs.maintain` 默认启用、`audit.clean` 默认开启（ADR-0044） | 现状默认已有 ticker；本方案的守门是"**不因监控新增默认启用的周期任务**"，而非宣称全局零 ticker |
| 前端折线已合规 | `kore/web/monitor.js:43` MAX_POINTS=1000、`:354-383` LTTB、`:462-521` 增量绘制 + hover 准线、`:591-614` tap 绑定、`:742-760` 100ms 单 resize 监听、`:1013-1016` `__koreMonitorChart` 断言钩子；`docs/FRONTEND.md:363` 已认定为合规实证 | G-32 判据已有实现，本次只增数据筛选/分桶，不动绘制内核 |
| 空态 helper 现成 | `web/app.js:2780` `window.KoreUI.emptyBlock({title,text,label,onClick})`；`monitor.js:770/872` 已用两次 | G-33 A5 复用同一 helper，不新造组件 |

## 3. 方案设计

### 3.1 采样闭环（①）

**新方法的精确契约**（薄包装，零新增采集逻辑）：

- `method`: `monitor.sample`（全名），`normalizeMethod` 加 `sample` 分支，`Call` 加 `case "monitor.sample"`。
- 入参：`{"history_points":int,"history_interval_s":int}`，均可选；由 `configDefaultsFor` 注入 `cfg.values`（与 `monitor.system` 同口径）。`params.withDefaults()` 兜底。
- 出参（显式结构，遵守 G-24 无 `any`/`object`）：
  `{"schema":"monitor.sample.v1","sampled_at":"RFC3339Nano","source":"proc|sysctl/ps|powershell/wmi","appended":bool,"history":HistoryResult,"warnings":[]}`。
- 实现：`exec := monitor.NewExecutor()` → `exec.System(ctx, params)`（已含 `recordHistory`）→ 取 `result.History` / `SampledAt` / `Source` / `Warnings` 组包返回。**不新增 `Executor` 接口方法**：那会穿过所有实现与测试替身（AGENTS §4 涟漪），而复用 `System` 只多跑一次磁盘/网络表格采集（单次 <1s，e2e 已有 `TestSystemReal` 断言），设计层优先于代码层（G-22）。

**info.json / 清单声明**：

- `method_capabilities` 增 `"monitor.sample": "system:read"`（只读本地指标 + 写自身 state，无特权动作）；插件级 `capabilities` 不变（已含 system:read/admin）。
- `manifest.json` 内嵌握手字段只含 `capabilities`/`version` 等（`:24-30`），`method_capabilities` 不在内嵌清单内，故 manifest 只 bump version。
- 版本：feat → **minor，0.5.1 → 0.6.0**（info.json + manifest.json 同步）；`size_bytes` 随 `make dist` 实测回填。

**两种启用形态对比（多选一，G-23：本文即留痕，被否决项写明依据）**：

| 维度 | (a) 用户自建 scheduler 任务【推荐】 | (b) 内核默认关闭 builtin 装配 |
| --- | --- | --- |
| 内核改动 | 零（现成 `POST /api/v1/scheduler/tasks`，`plugin=monitor`、`method=monitor.sample`、`interval_s≥30`、`enabled=true`） | 改 `scheduler.Options` 加 `MonitorSampleInterval`、`syncMonitorSampleTask()`、`Start()` 注册、`cmd/kored/serve_runtime.go` 装配（仿 `maintaintask.go:38-78` + `update.check` 默认关闭口径） |
| 默认行为 | 不建任务即无采样周期，历史仍按现状在每次手动 `monitor.system` 时按间隔追加一个点 | `MonitorSampleInterval<0/0` 不注册；显式配置才注册，默认同样不采样 |
| G-19 守门 | `Add` 才 `startLoop`（`scheduler.go:181`）；无启用任务 `stopIfIdle` 停 ticker；插件零 ticker（`g19_test.go` 静态扫描零命中） | 同左，但需新增内核配置面与 ADR-0044 式审计；tick 周期仍复用单 ticker，不新增定时源 |
| G-10 无外发 | 只本地读 `/proc` + 写 state，无网络；不改变现有出站 0 | 同左 |
| 用户可控性 | 任务可见 / 可改周期 / 可停用 / 有 `scheduler_runs` 执行记录（`handlers_scheduler.go:129-156`） | 配置项改完需重启，任务被 `Update` 拒绝（内置任务身份，`scheduler.go:202-209`） |
| 代价 | 用户需显式建一次任务（UI 上引导给出一键按钮或文案，不新页面） | 多文件内核改动 + G-23 台账 + 发版面扩大，仅为省用户一次配置 |

**裁决：选 (a)，(b) 否决**。依据：接缝全现成、零内核代码、默认关闭与 user-enabled 天然满足 G-10/G-19 与"零侵入"（G-31）；(b) 的价值只是免一次配置，却要扩大内核改动面并新增默认关闭开关的配置/审计负担，收益不抵成本。**默认行为：不注册任何 monitor 周期任务；用户显式创建任务后才连续采样；不建任务时监控页行为与今天完全一致。** 若将来产品要求"装完自动采样"，按 (b) 重开 G-23 决策并补 ADR（默认开启周期任务要重审 G-19 白名单，参照 ADR-0019 §修订 5）。

**关键约束（必须写进实现卡与真机验收）**：scheduler `interval_s` 最小 30s（`task.go:42`），而 `recordHistory` 仅在 `sample.TSUnixMS - last >= interval_s*1000` 时追加（`history.go:99`）。因此 **task `interval_s` 必须 ≥ `monitor.history_interval_s`**（相等最省）；若 task 30s 一跳而 `history_interval_s=3600`，只有每小时那一次真正落点。建议在用户引导文案里把两者同时设成同值，并在 `monitor.sample` 结果里回带 `history.interval_s` 供前端核对。

### 3.2 数据模型（②）

**落点口径澄清（P3 真机复验后订正，2026-11-27）**：本文说的“state 根”在 `history.json` 落点上指 **state 根下的插件独占子目录** `<state>/plugins/monitor/history.json`，不是 `<state>/history.json`。内核启动把 `KORE_STATE_DIR` 注入为 `filepath.Dir(inst.manifest.Dir)`（`internal/core/supervisor/start.go:83,169`，即插件版本目录的父目录 = `<state>/plugins/monitor`），插件侧 `historyPath()` 再 `filepath.Join(c.stateDir, "history.json")`（`kore-plugin-monitor/internal/monitor/history.go:63-68`）。该目录正是降权时 `handOverStateDir` 交给 `kore-monitor`（0700）的插件状态目录（`demote.go:79`、`handover.go:38`），不是与内核共享的 state 根。P3 隔离实例实测落点见 `.agents/verify/monitor-history-live.md` §4。

**容量/间隔覆盖 30 天的算式**：`MaxHistoryPoints(720) × MaxHistoryInterval(3600s) = 2,592,000s = 30 天`（理论上限，恰好覆盖竞品口径）。当前默认 `60 × 60s = 1h`，覆盖仅 1 小时——这是"看不到昨天"的根因。

**默认配置建议（做成可配置，不写死单一答案）**：

| 档 | history_points | history_interval_s | 覆盖跨度 | 粒度 | 适用 |
| --- | --- | --- | --- | --- | --- |
| A · 30 天全跨度（建议设为连续采样后的默认目标） | 720 | 3600 | 30 天 | 1h/点 | 对标竞品 30 天、7 天视图；"今天"只有 24 点但足够画折线 |
| B · 近 2.5 天细粒度 | 720 | 300 | 2.5 天 | 5min/点 | 关注昨天/今天的细节；7 天视图尾部会被裁 |
| 现状（保持不变） | 60 | 60 | 1h | 1min/点 | 手动刷新场景 |

实现取向：**代码默认值先不动**（避免破坏现有回归与"刷新即见"体验），把 A 档作为 `config.set` / 预设 / 定时任务引导文案的推荐值；前端时间范围控件在跨度不足时给出"当前保留 N 天，调大历史间隔可看更久"的提示并直达设置（G-33 A5 下一步）。`MinHistoryPoints=2` / `Max=720` / `MinInterval=1` / `Max=3600` 的校验边界不变（`config.go:193-198`、`params.go:70-81`）。

**原子写与大文件**：`saveHistoryFile`（`history.go:166-201`）已是"同目录临时文件 → `Chmod(0600)` → `rename`"，保持不动；720 点 × 5 数值字段 ≈ 90 KiB（估算，未实测），远低于协议 8 MiB 帧上限。每次 `recordHistory` 全量读改写是 O(n)，720 点下 30s 一次无压力；**不做增量写 / 分片 / 后端预聚合**：点数硬上限 720，简单原子写比复杂分片更可靠（G-22 设计层已穷尽）。`historyMu`（`:28`）串行化并发调用，保留。

**降权插件 state 写权限实机验证计划（未验证，必须做）**：内核启动注入 `KORE_STATE_DIR`（`internal/core/supervisor/start.go:163-169`），降权时 `handOverStateDir` 移交"插件自己的"落点（`demote.go:147`、`handover.go:38`）；但 `historyPath()` 返回的是 `filepath.Join(c.stateDir, "history.json")`（`history.go:63-68`）——**落在插件独占的 `<state>/plugins/monitor/`（`KORE_STATE_DIR`），不是 `KORE_PLUGIN_DATA` 子目录，也不是与内核共享的 state 根**。风险：root 内核 + 降权 `kore-monitor` 时，仍需真机确认该已移交目录对 `kore-monitor` 可写，否则 `recordHistory` 只写 warning（`:103-107`）而静默无历史。P3 非 root 路径实测已落盘且 0600（见 `.agents/verify/monitor-history-live.md` §4），降权路径不冒充已验。验证步骤（隔离实例，G-29 不碰 8787 主实例）：

1. 起隔离 `kored --config /tmp/<id>/kore.yaml`，state/run/log 全落 /tmp，内核 root 且开启降权；装 monitor 并确认 `Demoted=true`。
2. `stat -c '%U %a' <state>/plugins/monitor` 与 `<state>/plugin-data/monitor`；调 `monitor.sample` 后 `stat <state>/plugins/monitor/history.json`，确认属主 `kore-monitor`、权限 0600。
3. 若 `history.json` 未生成且结果 `warnings` 含"保存历史曲线失败"，判 FAIL，修复方向：把 history 落点改到 `KORE_PLUGIN_DATA`（已属主 kore-<id>、0700，`start.go:128-158`）而非当前 `<state>/plugins/monitor` 落点，并同步 `state_dir.go` / 文档。
4. 未降权（非 root 内核）路径同验一次，确认 0600 + 可写。
5. 结论写入 `.agents/verify/` 证据文件（命令 + 退出码 + stat 原文），不凭推测判定。

### 3.3 前端 monitor.js（③）

**复用、不重建**：在 `web/monitor.js` 的 `chartPanel`（`:762-791`）内加一行时间范围控件（4 个按钮：昨天 / 今天 / 7 天 / 自定义；自定义用两个 `<input type="date">`，触摸目标 ≥44px），挂到 `S` 状态对象；点击只改 `S.range` 并重算数据，**不重建 canvas、不新增 `charts` 实例**——`buildCharts` / `disposeCharts` / `window.__koreMonitorChart` 全部保持原样，G-32 的"实例 ≤12 / 切走 count=0 / 单图 ≤1000 点 / LTTB / hover-tap 读数"判据不破。UI 减法：不加页面、不加侧栏入口、复用本页同一个"历史曲线"面板与图例、主流程仍是"进入页 → 选范围 → 读数"。

**ts 分桶（在 `updateCharts` 之前的新纯函数）**：

1. 取 `history.timestamps`（ms，单调递增）与各列数组，按 `S.range` 算窗口 `[start,end]`（今天=本地 00:00 至现在；昨天=前一日 00:00–24:00；7 天=7×24h；自定义=两个日期端点）。
2. 窗口内按 `bucketMs` 分桶（建议：昨天/今天 5min、7 天 1h、自定义按跨度自动选 `max(60s, span/720)`），每桶取**末值**（保留原始采样值、不造伪均值）与**桶首时间戳**；桶数硬上限 720（与后端容量一致）。
3. 分桶后的列式数组交 `updateCharts` → `setChartData`；`setChartData` 内既有 `MAX_POINTS=1000` 尾截与 `lttbSample` 保持不变（双保险）。
4. 图例文案（`legendText`）追加"范围：昨天 · 原始 N 点 → 显示 M 桶"，让用户知道看到了什么。

**空态（G-33 A5）**：某范围无点或仅 1 点时，复用 `window.KoreUI.emptyBlock` 给差异化文案与下一步——无采样任务时："还没有这个时间段的采样数据，点这里去「定时任务」建一条 monitor.sample 任务开启连续采样"（按钮跳 `#/tasks`）；有任务但范围内空："该时间段没有采样点，可以切换范围或立即刷新"。不白屏、不造零值折线。`win` 切换时 `S.gen` 递增使在途请求失效（`stale(gen)` 现成，`:133`），避免范围错配。

**G-28 双端证据（实现期必交，本方案只列入验收）**：1440×900 full-page 桌面截图 + 390×844 手机截图，存 `.agents/verify/screenshots/`，命名 `monitor-history-desktop-*.png` / `monitor-history-mobile-*.png`；附自评三问原文（解决什么用户问题 / 与宝塔 1Panel 同类功能的差距 / 当前"可用"还是"占位"）。缺任一项不得声明前端完成。判定型：手机端 tap 读数面板可见、时间范围按钮可点（不遮挡）、图表有 X/Y 轴刻度（FRONTEND §13 第 12 条）。

**自检三问**：好处=看到跨天趋势而非只有 1 小时；对症=直接补 task-203 原文级差距；副作用=新增前端状态与请求参数，但绘制内核与实例生命周期不动，风险集中在分桶正确性与空态文案。

### 3.4 门禁涟漪（④）

| 项 | 动作 | 判据 |
| --- | --- | --- |
| 版本 bump | `info.json` + `manifest.json` 0.5.1→0.6.0（feat→minor）；`CHANGELOG.md` 加条目 | `method_capabilities_test.go:115-118` 版本一致断言绿 |
| dist | `make dist` 重打 0.6.0 两打，干净树复现 sha 一致；回填 `size_bytes` | dist sha 与索引账本一致（`docs/RELEASE.md` §2） |
| 索引 / 锁 / 预设 / 市场页 | `kore-plugins/index/plugins.json` 更新 version/sha256/size_bytes/download_url；`versions.lock.json` 追加 0.6.0；`presets/web-pro.json`、`presets/full.json` 固定版本同步；`bash scripts/build-market.sh` 重建 `market/plugins.js`；`bash scripts/validate-index.sh` 重签并正/反例 | `make check` 第 16 段 market byte 级一致 + `make presets-check` 绿；已修 G-29 索引回切事故口径 |
| 内核门禁 | `make check`（21 段）全绿；`make frontend` 首屏 gzip 不变；`docs-check` exit 0（既有行数 WARN 如实保留） | 命令 + 退出码贴证据 |
| 插件门禁 | `make check`（gofmt→vet→test）、`make build`、`go test -race ./...`；`g19_test.go` 零 ticker 扫描零命中 | 全绿 |
| 测试替身 / 期望表 | `method_capabilities_test.go` implementedMethods 加 `{"monitor.sample", "{}"}`，recordingExecutor 加 `Sample`，e2e 加 `TestSampleAppends`（连续调用跨间隔断言点数增长）；`config_contract_test.go` / `zeroparam_test.go` 覆盖 sample 零参路径 | 新增方法声明 vs 实现双向断言绿（kore AGENTS §4：同写域串行做，预算 ≥20 分钟防涟漪红） |
| 依赖 | 预计**无新依赖**（仅标准库 + `kore/pkg/pluginapi`）；若确有新增，按已授权 goproxy 披露并过 G-2 白名单 | `go list -m all` 比对，第三方 ≤3 |

## 4. 影响范围（实现期文件清单，本卡不落）

- `kore-plugin-monitor/`：`info.json`、`manifest.json`、`methods.go`、`internal/monitor/call.go`、`config.go`（configDefaultsFor）、`method_capabilities_test.go`、`tests/e2e/e2e_test.go`、`CHANGELOG.md`、`dist/`。
- `kore/`：`web/monitor.js`（仅此一个前端源；`web/dist/monitor.js` 由构建产出，不手改）、`docs/RELEASE.md`（若口径变更；本次预计不改）。
- `kore-plugins/`：`index/plugins.json`、`index/versions.lock.json`、`presets/*.json`、`market/plugins.js`。
- G-23 台账：本方案对 (a)/(b) 的取舍即留痕，实现卡派发时补 `.agents/LOG/DISPATCH.md`。

## 5. 分期与判据（⑤）

### P1 · 后端采样（可独立提交检查点）

- 交付：`monitor.sample` + info/manifest bump + 测试替身/e2e 同步（§3.1/§3.4）。
- 判据：① `go test ./...` / `make check` 绿；② 连续调 `monitor.sample` N 次，当 `ts-last >= history_interval_s*1000` 时 `appended=true` 且 `history.count` 增长，未到间隔时不增长（`history.go:99`）；③ `g19_test.go` 扫描零 ticker；④ `ss -tnp` 出站 0；⑤ `info.json` 的 sample 声明与 Call 分支双向一致。

### P2 · 前端视图（可独立提交检查点）

- 交付：`web/monitor.js` 时间范围控件 + 分桶 + 空态（§3.3）；`make frontend` 产物同步。
- 判据：① 四档范围切换后曲线点数/时间轴与窗口一致，自定义端点生效；② 无点范围出空态且有下一步按钮；③ `window.__koreMonitorChart.count()` 在切走视图后归零、连续刷新不增长；④ 手机 390×844 tap 出带单位读数；⑤ G-28 双端截图 + 自评三问落盘；⑥ `make frontend` 首屏 gzip 不超 300 KiB。

### P3 · 真机复验（隔离实例，G-29）

- 环境：`kored --config /tmp/<id>/kore.yaml`，state/run/log 全落 /tmp，**不改 8787 主实例配置**；验后声明"本轮未改主实例运行态配置"。
- 造数据：先 `monitor.config.set` 把 `history_interval_s` 调小（如 1s，边界 `MinHistoryInterval=1`）快速造 N 个点，再 set 回目标档；注意改 interval 只改 `file.IntervalS` 元数据，历史点保留（`history.go:84-85`）。或按目标间隔真实等待（更慢但更真）。
- 断言清单（每条贴命令 + 退出码 + 输出）：
  1. `history.json` 点数随采样单调增长，容量到 720 后环形覆盖（旧点被丢）；
  2. 四档时间范围切换显示正确（点数/轴刻度与 §3.3 分桶一致），空态正常；
  3. **默认关闭**：新建隔离实例不建 monitor 任务时，无 monitor 采样发生（`scheduler_runs` 无该任务记录 / 日志无 sample 调用）；按 (a) 建任务后 ticker 仍只有 scheduler 一个；
  4. `ss -tnp` 出站连接 0（G-10）；
  5. 降权 state 写权限按 §3.2 五步验证（PASS 才算闭环，FAIL 则回退到 `KORE_PLUGIN_DATA` 落点重做 P1）。
- 责任：verifier 独立于 implementer（G-09），复跑上述判据并出 `.agents/verify/` 报告。

## 6. 测试策略

- 单元：`parse/validate` 边界（sample 零参、非法 history_points/interval）、薄包装出参 schema、`appended` 门槛（等于/小于/大于 interval）、环形覆盖、损坏文件重建（复用 `history_test.go` 现成覆盖）。
- 集成：`method_capabilities_test` 声明↔实现双向；`config_contract_test` 配置注入到 sample；e2e 真实 /proc 连续采样点数增长。
- 前端：无框架手写函数（分桶纯函数）可用 Node 断言脚本临时验证后删除（用户纪律：不留一次性脚本）；G-28 截图 + G-32 钩子断言；G-33 A5 空态文案。
- 真机：§5 P3 全部条目。

## 7. 风险与回退

| 风险 | 后果 | 回退 / 缓解 |
| --- | --- | --- |
| interval 不匹配（task < history_interval_s） | 采了但落盘点数不涨，用户以为坏 | 引导文案同步设值；sample 结果回带 interval_s 供核对；真机断言 #1 覆盖 |
| 降权后插件独占 state 子目录 `<state>/plugins/monitor/` 无写权限 | 历史静默丢失（只有 warning） | §3.2 验证计划；FAIL 则历史落点迁 `KORE_PLUGIN_DATA`，重跑 P1/P3 |
| 30 天跨度与细粒度不可兼得 | 7 天/今天视图粒度粗 | 两档可配置 + 前端提示；不写死单一默认（live-games 式口径：分支都实现、默认取保守值） |
| 720 点全量读改写 | 高频下写放大 | 硬上限 720；task interval ≥30s；不做增量写（G-22 设计层已穷尽） |
| 新增方法撞测试涟漪 | 4 替身 + 期望表变红 | 按 AGENTS §4 串行实现、≥20 分钟预算；同写域不并行派发 |
| 索引/市场页漂移 | 商店显示旧版本（G-29 事故） | RELEASE §2.4 同提交重建 market + validate-index byte 比对 |
| 用户误解"装完自动采样" | 以为坏了 | 空态明确给"去定时任务建 monitor.sample"下一步；默认行为在本文与 wiki FAQ 同步 |

## 8. 待确认的开放项

1. 连续采样默认档选 A（30 天，1h 粒度）还是 B（2.5 天，5min 粒度）——本文建议 A 为目标、代码默认不变、用户可切；若 lead 要"装完即 A"需另裁决并改默认常量（会触发回归更新）。
2. 是否顺带给用户一个"一键开启采样"入口（放在定时任务页或监控页空态按钮，仅导航 + 预填参数、不新增页面）——倾向放在空态按钮，实现量极小；若 lead 认为仍属 UI 加法可砍。
3. 归档状态与采纳结论由审阅回填；本文不替 lead 拍板。
