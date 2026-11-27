# 监控连续采样 + 天/周视图 P1+P2 独立验收报告

> 2026-11-27 · G-09 verifier `monitor-history-verifier`（非 implementer `monitor-history-impl`）· 只读复核，不改生产代码、不碰主实例（`.kore-local-*` / 8787）、不联网、不 push、不执行主流程 CLI。
> 对象：monitor `2a3a2c9` / plugins `f16176e` / kore `0b924b4`（task-208）。
> 总评：**PASS**（5/5 复核域全部成立）。

## 结论速览

| 域 | 结论 | 关键证据 |
| --- | --- | --- |
| ① 后端 monitor.sample | **PASS** | 薄包装复用 `exec.System` 无新 Executor 方法；`info.json` capability + 0.6.0；e2e `TestSampleAppends` 真 /proc 三阶段；零 ticker；interval 坑已写 help；dist sha 四处一致；monitor `make check` exit 0 |
| ② 前端 monitor.js/tasks.js | **PASS** | 四档范围 + ts 分桶（≤720 末值）+ 空态；draft 接线；node --check 双 0；make frontend 91092B≤300KiB；make check 21 段 exit 0；分桶纯函数 9/9；UI 减法 + G-32 不破 |
| ③ 索引仓 | **PASS** | validate-index / build-market --check / validate-presets 全 exit 0；monitor 0.6.0 + sha 四处一致 |
| ④ G-28 双端截图 | **PASS** | 四图 identify 宽高一致 + read_image 实读非伪造；范围按钮/四折线/图例/prefill 字段目视确认；自评三问 + mock 边界诚实 |
| ⑤ Git 纪律 + 清理 | **PASS** | 三仓精确路径 + DCO、未 push、worktree 仅主树、他人 dirty 原样；一次性脚本/55117 删净 |

---

## ① 后端复核（kore-plugin-monitor @ 2a3a2c9）

### 1.1 monitor.sample 薄包装（读码）
- `internal/monitor/call.go:31-47`：`case "monitor.sample"` 走 `parseSystemParams(raw)` → `exec.System(ctx, params)` → 编码 `SampleResult`。**复用 `Executor.System`（其中已含 `recordHistory` 落点），未新增 Executor 方法**。
- `internal/monitor/schema.go:23-31`：`SampleResult` 显式字段 `schema/sampled_at/source/appended/history/warnings`，无 `object`/`any`（G-24）。
- `method_capabilities_test.go:22,34-35`：`delegatesTo` 明确标注 `monitor.sample → monitor.system`，期望表新增薄包装条目；`recordingExecutor` 无需新方法 —— 证明接口涟漪为零。

### 1.2 capability + 版本
- `info.json`：`"version": "0.6.0"`；`capabilities=[system:read, system:admin]`；`method_capabilities["monitor.sample"]="system:read"`（只读方法声明只读）。
- `manifest.json`：version 0.6.0、capabilities 与 info.json 握手字段一致（`config.go` 注释 + make dist 前置校验防漂移）。

### 1.3 e2e TestSampleAppends（真 /proc 三阶段）
读 `tests/e2e/e2e_test.go:91-128`：首点真 /proc（schema/source 断言）→ 立刻再调未到间隔不落（appended=false、count 不增）→ `time.Sleep(1100ms)` 跨间隔后落点且 count 增长；`KORE_STATE_DIR=t.TempDir()` 不碰运行态（G-29）。

实跑（隔离 GOCACHE，GOPROXY=off）：
```
$ GOPROXY=off GOWORK=off GOCACHE=<tmp> go test -count=1 -timeout 200s -v -run TestSampleAppends ./tests/e2e/
=== RUN   TestSampleAppends
    e2e_test.go:126: sample 落点序列: 首点 count=1 → 未到间隔 count=1(appended=false) → 跨间隔 count=2(appended=true)
--- PASS: TestSampleAppends (1.70s)
PASS
ok  github.com/pengtang1024/kore-plugin-monitor/tests/e2e  1.709s
EXIT_CODE=0
```

### 1.4 零 ticker 门禁（G-19）
```
$ grep -rn "NewTicker|time.Tick|Ticker" --include="*.go" . | grep -v "_test.go"
(no non-test ticker)
```
`monitor.js/tasks.js` 亦无 `setInterval`（仅 100ms resize 防抖 setTimeout）。周期完全由调用方 scheduler 任务提供。

### 1.5 interval_s ≥ history_interval_s 坑（已体现）
- `config.go:245`：`history_interval_s` 中文 help 明写「若用定时任务周期调用 monitor.sample，请把任务间隔设成不小于本值（两者相同最省），否则多数周期调用不会落点」。
- `internal/monitor/schema.go:25-27` 注释 + 预填 draft `history_interval_s=3600` 与 cron `0 * * * *`（每小时）相等（A 档），前端不制造"采了不落点"。
- e2e 三阶段正是此坑的可执行证明。

### 1.6 monitor make check 实跑
```
$ GOPROXY=off GOWORK=off GOCACHE=<tmp> make check
gofmt: clean
GOWORK=off go vet ./...
GOWORK=off go test -timeout 200s ./...
ok  .../kore-plugin-monitor  0.614s
ok  .../internal/monitor      0.029s
?   .../internal/plugincfg    [no test files]
ok  .../tests/boundary        2.477s
ok  .../tests/e2e             5.475s
ok  .../tests/fault           1.618s
[RUN ] race: CGO_ENABLED=1 go test -race -count=1 -timeout 300s ./tests/boundary/...
ok  .../tests/boundary        4.515s
EXIT_CODE=0
```

### 1.7 dist sha d3c8c154… 四处一致
```
$ sha256sum kore-plugin-monitor/dist/monitor-0.6.0.tar.gz
d3c8c1542540ef1694d64d165e1d70a688c49f8c97923e71f086c93ddd0b738e
$ (cd dist && sha256sum -c monitor-0.6.0.tar.gz.sha256) → monitor-0.6.0.tar.gz: OK
实际字节 1465860（info.json size_bytes=1465861，偏差 Δ1 在 ±2 容差内）
```
四处：`dist/monitor-0.6.0.tar.gz.sha256` = `kore-plugins/index/plugins.json:126` = `kore-plugins/index/versions.lock.json:334` = 包实算 sha，全部 `d3c8c154…b738e`（自评 §4 的第五处为文档引用）；包内 `info.json` version=0.6.0。

## ② 前端复核（kore @ 0b924b4）

### 2.1 读码核对
- `web/monitor.js:43-63`：`MAX_BUCKETS=720`、`RANGE_OPTIONS=[今天/昨天/7天/自定义]`、`SAMPLE_DRAFT`（plugin=monitor / method=monitor.sample / cron `0 * * * *` / params `history_points:720, history_interval_s:3600` / comment）。
- `web/monitor.js:378-457`：`rangeWindow`（本地日界，now 可注入）/ `bucketHistory`（ts 筛选 + 每桶末值，超 720 桶自动放大 bucketMs）；`columns` 为四显式序列键。
- `web/monitor.js:848-933`：`renderHistory` 空态走 `window.KoreUI.emptyBlock({title,text,label:'一键开启连续采样',onClick:goEnableSampling})`，有数据态复用 `chartPanelEl` + 同一批 canvas；`goEnableSampling` 只写 sessionStorage draft + 导航，不建任务、不新增页面。
- `web/tasks.js:1959-1985`：`applyTaskDraft()` 在 `render()` 中调用一次，白名单字段填表、读完即删、不自动提交；状态条提示「核对后点新增任务才会创建，不会自动提交」。
- 分桶纯函数无副作用入口 `window.__koreMonitorChart._bucket/_rangeWindow/_seriesKeys`（monitor.js:1210-1218）。

### 2.2 node --check / 首屏体积
```
$ node --check web/monitor.js        EXIT_CODE=0
$ node --check web/tasks.js          EXIT_CODE=0
$ make frontend
[OK] 首屏体积达标：91092 字节 ≤ 307200 字节（300 KiB），余量 216108 字节
[WARN] 首屏体积漂移（非阻断，基线+5% 提示）
EXIT_CODE=0
```
91092B 与任务卡一致。

### 2.3 make check 21 段复跑（关键：隔离 GOMODCACHE）
首次以只读默认 module cache 跑 exit=2，失败段为 11/17/19（`bbolt v1.5.0` zip 不在只读 cache、无法下载）/ 20（waf A1，见下）。bbolt v1.5.0 由 commit `0ca0b2b` 引入，**早于 HEAD，且 HEAD 未碰 go.mod/go.sum**（`git show --name-only HEAD` 只有 4 png + selfeval + monitor.js + tasks.js）——属环境噪声。改用工作区已有的只读安全副本 `.tmp-acct-gomodcache`（内含 v1.5.0.zip，非本轮生成）作 GOMODCACHE + 隔离 GOCACHE：
```
$ GOPROXY=off GOWORK=off GOCACHE=<tmp> GOMODCACHE=.../.tmp-acct-gomodcache make check
[OK] 门禁全部通过
EXIT_CODE=0
```
21 段 RUN 行齐全（1/21…21/21 + 16 段·market）。第 10 段 frontend、第 15 段 presets、第 16 market、第 17 交叉编译、第 19 全仓 -race、第 21 pkg/pluginapi -race 全绿。

**usability 1 FAIL 归因**：单跑 `usability-check.sh` exit=1，只有 1 个实质 `[FAIL]`：
```
[FAIL] A1 waf: ZeroParam 真跑失败: FAIL .../kore-plugin-waf/tests/e2e
```
另一 `[FAIL] G-33 有新违规` 是汇总行。证据：waf 的 `internal/wafop/zeroparam_test.go` 是**未跟踪他人 dirty**（`git -C ../kore-plugin-waf status --short` → `?? internal/wafop/zeroparam_test.go`），且 `scripts/usability-pending.txt` 的 A1 waf 豁免行被**他人未提交 dirty 删掉**（`git diff -- scripts/usability-pending.txt` 显示删除 `A1 waf` 等行；HEAD^ 里仍有 `A1 waf`）。与本次 0b924b4（仅前端）无关，属存量 + 他人 dirty，符合任务卡「usability 1 FAIL 存量 waf A1 归因核对」预期，make check 该段为 WARN 级不阻断（整体 exit 0）。

### 2.4 分桶纯函数断言（独立 Node，stdin 无临时文件）
加载真实 `web/monitor.js` 到 vm（最小 window 替身），固定 now=2026-11-27 12:00 本地：
```
PASS today window / yesterday window / week window / custom window（含结束日）/ custom 日期反转交换
PASS empty history → 0 buckets（rawCount=0）
PASS dense 30d（43201 点）→ buckets=698 ≤720，自动放大 bucketMs=3720000
PASS 同桶取末值（cpu=[2]）/ week 窗外过滤（rawCount=1）
TOTAL pass=9 fail=0   EXIT_CODE=0
```

### 2.5 UI 减法 + G-32
- `git show HEAD --name-only` 未碰 `shell.js`/`app.js`/`index.html`/i18n —— 不新增一级菜单/页面/实质控件；四个范围按钮 + 两日期框嵌在既有「历史曲线」面板内部（mon-range 在 panel body）。
- G-32：`MAX_POINTS=1000`、实例注册表 `charts`、`__koreMonitorChart.count()/dispose()`、切走 `disposeCharts()`、唯一 resize 100ms 防抖、每点 hover/tap 读数（截图可见图例+轴刻度）；自评 DOM 断言切走 count=0/回来 4 实例。不破。

## ③ 索引仓（kore-plugins @ f16176e）
```
$ bash scripts/validate-index.sh  → [OK] ed25519 验签 + market 逐字节 + schema/唯一 sha   EXIT_CODE=0
$ bash scripts/build-market.sh --check → [OK] market/plugins.js 与索引逐字节一致（24）  EXIT_CODE=0
$ bash scripts/validate-presets.sh → [OK] 8 预设 / 24 插件 / 0 FAIL / 0 WARN            EXIT_CODE=0
```
monitor 0.6.0 一致性：`index/plugins.json`（version 0.6.0 / size 1465861 / sha d3c8c154… / download_url v0.6.0）、`index/versions.lock.json` 第 9 条 `{version:0.6.0, sha:d3c8c154…}`、`presets/full.json` 与 `presets/web-pro.json` 均 pin 0.6.0、`market/plugins.js` version 0.6.0 —— 四处一致。

## ④ G-28 截图硬核验

### 4.1 identify 宽高（实测）
| 文件 | identify | sha256 前 8 | 与自评一致 |
| --- | --- | --- | --- |
| ui-monitor-history-desktop-01.png | 1440x2248 211630B | f0848937 | ✓ |
| ui-monitor-history-mobile-01.png | 390x844 57488B | a7a10fb8 | ✓ |
| ui-monitor-history-desktop-prefill-01.png | 1440x1930 232338B | 0725cf85 | ✓ |
| ui-monitor-history-mobile-prefill-01.png | 390x844 51129B | 6d1179b9 | ✓ |

四图 sha 互不相同，非同图缩放；桌面 full-page（高 >900），手机精确 390×844 视口。

### 4.2 read_image 实读四张（非伪造）
逐张 `read_image` 目视确认：
- **desktop-01**：监控页「历史曲线」面板内一行四按钮「今天/昨天/7天/自定义」+ 两个日期框，「昨天」高亮；CPU/内存/负载/磁盘**四条折线**（带轴刻度 + 红色阈值虚线）+ 图例 `范围 yesterday：原始 2 点 → 显示 2 桶（末值）· 间隔 3600s · 后端保留 720 点`；顶部来源标注 monitor 插件。
- **mobile-01**：单列窄屏，四按钮与两日期框换行自适应、触摸目标可见，「昨天」选中，四色曲线与图例可见，底部 tab 不压关键内容。
- **desktop-prefill-01**：跳 `#/tasks` 后任务表单已填：类型「插件任务」、插件 id `monitor`、方法 `monitor.sample`、参数 `{"history_points":720,"history_interval_s":3600}`、cron `0 * * * *`、备注 `监控连续采样（每小时）`；「内核定时任务」仍只有既有 2 条（审计/日志维护）——**未自动提交/未创建任务**。
- **mobile-prefill-01**：同上字段在 390px 单列满宽显示，textarea 参数换行可见，未提交。

### 4.3 自评三问 + mock 边界诚实性
读 `ui-monitor-history-selfeval.md:69-82`：问1（解决看不到昨天/7天趋势、空态给下一步）/问2（与宝塔/1Panel 差距：720 点环形缓冲、四固定曲线、前端末值分桶、导航+预填不自动建任务——明确边界非隐藏缺口）/问3（可用·受控范围，四条判据）。
**mock 边界**（selfeval §2/§3/问3-4）：`monitor.system` invoke 响应用 mock history（真实列式形状 6 可辨识点），本轮只验前端分桶/范围/空态/预填；真 /proc 采样落点由 Go 单测+e2e 覆盖；**真机连续采样 + 降权 state 写权限断言留 P3**，不冒充通过 —— 诚实。

## ⑤ Git 纪律 + 清理

### 5.1 三仓 commit 精确路径 + DCO
```
kore-plugin-monitor  HEAD=2a3a2c9  [agent:monitor-history-impl] feat(monitor): 新增 monitor.sample…
  files: CHANGELOG.md / config.go / info.json / internal/monitor/{call.go,call_unsupported_test.go,schema.go} /
         manifest.json / method_capabilities_test.go / methods.go / sample_test.go(A) / tests/e2e/e2e_test.go
kore-plugins         HEAD=f16176e  [agent:monitor-history-impl] chore(index): 同步 monitor 0.6.0…
  files: index/plugins.json / index/plugins.json.sig / index/versions.lock.json / market/plugins.js /
         presets/full.json / presets/web-pro.json
kore                 HEAD=0b924b4  [agent:monitor-history-impl] feat(monitor): 历史曲线时间范围/分桶/空态+采样预填…
  files: 4×.agents/verify/screenshots/ui-monitor-history-*.png(A) / .agents/verify/ui-monitor-history-selfeval.md(A) /
         web/monitor.js / web/tasks.js
```
三仓 `git log -1 --format='%(trailers:key=Signed-off-by,valueonly)'` 均为 `pengtang1024 <pengtang1024@qq.com>` —— DCO 齐（`%G?=N` 表示无 GPG 签名，本任务只要求 DCO trailer）。

### 5.2 未 push
`git branch -r --contains HEAD` 三仓均无输出（exit 0）；远端 main ref 仍为旧值：monitor `1427b24`、plugins `ed44e0a`、kore `3a4fae4`（gitea `812f9fc`），本地 HEAD 未入任何远端。

### 5.3 worktree 仅主树 + 他人 dirty 原样
三仓 `git worktree list` 均只有 1 行主树。dirty 与基线一致：
- monitor：`?? zeroparam_test.go`（他人，未提交）
- plugins：`?? .tmp-validate-out.txt`、`?? dist/`（他人，未提交）
- kore：` M scripts/usability-pending.txt` + `?? .agents/.agents/`、`?? .agents/verify/e2e-*.md` 等 12 项（他人，原样）
本轮未新增 dirty（临时 output 文件已删）。

### 5.4 一次性脚本 / 55117 隔离实例删净
```
$ ss -ltnp | grep 55117  → (no listener on 55117)
```
下列均已删除：`kore/.tmp/{monitor_bucket_test.js,monitor_ui_verify.js,monitor_sync_index.py}`、`.agents/verify/.monitorhist-ui/`（隔离 kored/config/state/run/log），以及本 verifier 的 `.agents/verify/.tmp-makecheck{,2}.txt` / `.tmp-usability.txt`。web/dist 与源码 `cmp` IDENTICAL（monitor.js/tasks.js，构建产物 gitignored）。`.kore-local-*` 未改动（mtime 均早于本轮）。

---

## 诚实边界
- 本 verifier 的所有 Go 门禁均在隔离 GOCACHE + 工作区已有 GOMODCACHE 副本下复跑，规避本机只读 module cache；默认 cache 下 exit=2 属环境（缺 bbolt v1.5.0 zip），非产物缺陷，已用 `git show HEAD^`/`git log -- go.mod` 证明与本次改动无关。
- G-28 截图由 implementer 的隔离实例 + mock history 生成，本 verifier 实读图像确认渲染真实、字段值/尺寸/图例非伪造；**真机连续采样仍留 P3**，本轮不替它背书。
- usability waf A1 FAIL 与 plugins `.tmp-validate-out.txt`/dist、kore 诸多他人 dirty 均为存量/他人在途，本 verifier 未改、未提交、原样保留。

**总评：PASS**（监控连续采样 P1 + 前端范围/分桶/预填 P2 的五项验收域全部成立，证据一致可复跑）
