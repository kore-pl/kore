# R22 G-28 双端截图 · 批次1：系统体检 / 配置快照 / 运维日历 / 批量操作

日期：2026-11-24 18:47–19:05（Asia/Shanghai）｜Owner：`r22-shots1`（🔵 美团味）｜批次：R22 双端证据批次1（4 场景 × 双端 = 8 张 + 运维日历修复后补拍 2 张 = 10 张）

> ▎[🔵 美团味] 做难而正确的事，过程透明、结果说话。全部截图来自隔离实例真实浏览器 + 真实登录表单 + 真实点击导航/交互，没有一张是同图缩放、设计稿或 DOM 断言冒充。首轮 8 张归档自 bug 版 HEAD（502d0df），运维日历如实拍下产品真 bug（前端 load() 自锁、永久停在"正在读取任务…"）并标注未证明；calfix 修复（`c90def1`）入 HEAD 后，经 lead 批准又从修复版 HEAD（369af06）隔离实例补拍运维日历双端 `-02` 新证据，红→绿闭环。旧图不删不覆盖，修复前后清楚区分。

## 0. 结论先行

批次1 的 4 个 R22 新功能（系统体检 / 配置快照 / 运维日历 / 批量操作）已补齐 G-28 双端证据：**首轮 PC 1440×900 ×4 + 手机 390×844 ×4 = 8 张真实截图（bug 版 HEAD 502d0df）+ 修复后补拍运维日历 PC/手机 2 张（修复版 HEAD 369af06）= 共 10 张**，`file` 实测全过、`md5sum` 10 张全异（distinct=10）。每场景产品自评三问 + 已证明/未证明两栏 + G-29 声明齐备，`make secret-check` 0 FAIL。**证据齐，声明完成。** 运维日历首轮因产品 bug（load() 自锁、scheduler/tasks 零请求）任务标记未证明并如实披露；calfix 提交 `c90def1` 修复后已补拍 `-02` 新证据，`scheduler/tasks` 真发 200、月历网格与 2 条任务标记真渲染，两栏更新为"已修复并补验"。

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787（PID `2340414` / 主 `bin/kored`）是本批新构建且为共享运行态资产——**不重启、不改配置、不覆盖静态资源、不用任何用户 Edge / 共享桌面窗口**。为拍含 8 新功能的界面且完全隔离，走 `git archive HEAD` + 独立构建 + 独立实例（配置/state/run/log 全落 `/tmp`，端口 18888，与并行批次2 的 18889 分开）：

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse HEAD
输出: 502d0df834cef0317dbb1ee0027caf6a6a029d9b
$ git archive HEAD | tar -x -C /tmp/kore-r22-shots1/src
输出: 归档 HEAD 4 视图源齐备 web/{health,snapshot,calendar,batch}.js（git ls-tree 逐项命中）
$ cd /tmp/kore-r22-shots1/src && make web-dist
退出码: 0；生成 web/dist/{health,snapshot,calendar,batch}.js（19201/17013/22840/24838 bytes）
$ CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r22-shots1/bin/kored ./cmd/kored
退出码: 0；隔离二进制 11497634 bytes（ELF 静态链接，独立产物全路径落 /tmp）
$ printf '<随机口令>' | /tmp/kore-r22-shots1/bin/kored admin-password --set --stdin --config /tmp/kore-r22-shots1/seed.yaml
输出: 已将口令哈希写入 0600 配置（明文口令仅存 /tmp/kore-r22-shots1/admin.pw，报告与证据均 *** 占位，G-30 合规）
$ /tmp/kore-r22-shots1/bin/kored serve --config /tmp/kore-r22-shots1/config/config.yaml
输出: {"msg":"kore ready","pid":2351875,"version":"0.1.1","addr":"127.0.0.1:18888","socket":"/tmp/kore-r22-shots1/run/kore.sock"}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18888/-/healthz
输出: 200
$ 浏览器 config index_dir
输出: /home/pt/Work/GolandProjects/kore-plugins/index（隔离实例指向正确索引）
```

**蓝军自检「拍到旧界面」证伪**：归档 HEAD 的 `web/dist` 逐文件核对本批 4 视图命中——`health.js` 含「系统体检 / 健康分 / hlth-score」（19201B）、`snapshot.js` 含「配置快照（时光机）/ 创建快照」（17013B）、`calendar.js` 含「运维日历 / kcal-hint」（22840B）、`batch.js` 含「批量操作中心 / 选场景」（24838B）。非 HEAD 旧界面不可能含这些 R22 新增文案；且截图 DOM 证据逐场景读到这些真实文案（第 3 节）。

浏览器走登录页表单 `#kore-password` 真实 `fill` + 点「登录」按钮（非注入 cookie）；首次登录的新手引导遮罩 `kore-onboard-backdrop` 通过真实点击「以后再看」关掉；4 场景全部通过真实点击一级导航按钮 + hub 子 tab 进入（手机视口导航收进「更多」抽屉，也走真实点击），未用深链接绕过导航。

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' bin/kored
输出: 2026-11-24 18:45:06.013694035 +0800 11497634   # mtime 早于本卡开工 18:47，未被本卡重建
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ pgrep -af 'kored.*serve'
输出: 2340414 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml（主实例未重启、未改配置）
      2351875 /tmp/kore-r22-shots1/bin/kored serve --config /tmp/kore-r22-shots1/config/config.yaml（隔离实例）
      2355892 /tmp/kore-r22-shots2/bin/kored serve --config /tmp/kore-r22-shots2/config.yaml（并行批次2，端口 18889）
$ ss -ltn | grep -E ':(8787|18888) '
输出: 127.0.0.1:8787（主）/ 127.0.0.1:18888（隔离实例1）独立 LISTEN
$ stat -c '%y %s' .kore-local.yaml
输出: 2026-11-23 04:59:58.799907899 +0800 1677   # 主配置 mtime 未变
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主实例 state/run/socket、未重建主 `bin/kored`、未重启 8787、未使用任何共享桌面浏览器窗口；全部证据来自 `/tmp/kore-r22-shots1` 隔离实例 + headless playwright 自拍。隔离实例的临时脚本、临时口令、config/state/run/log 在收尾时删除（G-30 零明文凭据入仓）。

## 2. 截图清单与 file 实测（验收项①②）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`（场景名严格用任务卡指定前缀 `health-checkup` / `config-snapshot` / `ops-calendar` / `batch-ops`）。PC 用 1440×900 viewport、手机用 390×844 viewport（playwright `deviceScaleFactor=1`，手机 `isMobile/hasTouch=true`，`fullPage=false` 精确视口截图），保证 `file` 实测尺寸恰好匹配门禁。首轮 8 张为 bug 版 HEAD 历史证据；运维日历修复后另补 2 张 `-02` 新证据（`-01` 旧图保留不删）。

```text
$ cd .agents/verify/screenshots && file <首轮 8 张正式证据>
health-checkup-desktop-01-health-score.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
health-checkup-mobile-01-health-score.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
config-snapshot-desktop-01-list.png:        PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
config-snapshot-mobile-01-list.png:         PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
ops-calendar-desktop-01-month.png:          PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
ops-calendar-mobile-01-month.png:           PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
batch-ops-desktop-01-scenarios.png:         PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
batch-ops-mobile-01-scenarios.png:          PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0

$ cd .agents/verify/screenshots && file <修复后补拍 2 张>
ops-calendar-desktop-02-fixed-month.png:   PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
ops-calendar-mobile-02-fixed-month.png:    PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图 / 拍到旧界面」：**全部证伪**。

```text
$ md5sum <8 张正式证据>
032e48890a169eabd97fc28047bd966e  health-checkup-desktop-01-health-score.png
d341b2ce2421e6d6f7fb7368456bdd61  health-checkup-mobile-01-health-score.png
07939c055667f3b8b591ee1654ce9afe  config-snapshot-desktop-01-list.png
3c6541ac757b2591c2476f02bc64fce7  config-snapshot-mobile-01-list.png
0a34f7430c6da36558216016d9548cac  ops-calendar-desktop-01-month.png
3672301456e9c3e76c9714020fd8e2a3  ops-calendar-mobile-01-month.png
e9b077c2ae69fc4770026c76d7899739  batch-ops-desktop-01-scenarios.png
a037f22bcea7dc7373f8bffe027b5545  batch-ops-mobile-01-scenarios.png
退出码: 0；首轮 8 张 md5 去重后计数 = 8（全不同）

$ md5sum <修复后补拍 2 张>（连同首轮 8 张共 10 张一起核对）
0a34f7430c6da36558216016d9548cac  ops-calendar-desktop-01-month.png       # bug 版历史
3672301456e9c3e76c9714020fd8e2a3  ops-calendar-mobile-01-month.png        # bug 版历史
16a795405abd112c3a3856b653d8f148  ops-calendar-desktop-02-fixed-month.png # 修复后新证据
b93fdf68089998af1d51faf0b12850a6  ops-calendar-mobile-02-fixed-month.png  # 修复后新证据
退出码: 0；10 张 md5 去重后计数 = 10（全不同，含 -01/-02 互不重复）
```

- **同图缩放**：10 张 md5 全异 + `file` 实测 PC/手机尺寸不同 + 逐张目视（手机端导航收进「更多」抽屉、内容纵向堆叠，与 PC 布局明显不同），证伪。
- **设计稿替代**：全部来自 playwright 驱动的隔离实例真实浏览器渲染，登录走真实表单、导航走真实点击、体检走真实「开始体检」按钮，证伪。
- **拍到旧界面**：隔离二进制独立构建（11497634 bytes）、HEAD 归档 4 视图源齐备、归档 dist 新文案逐项命中、截图 DOM 证据读到 R22 文案，证伪。

## 3. 四场景交互真实性（真实点击 + DOM 证据）

### 场景①系统体检（health-checkup）

```text
[desktop/mobile] 登录 → 真实点一级导航「监控」→ 真实点子 tab「系统体检」
  → 真实点「开始体检」按钮 → 等 .hlth-score + .hlth-item 出现
  → DOM: score="88 / 100", label="基本正常", items=8, firstItem="内核存活"
  → 目视：健康分 88/100 大字 + 「共 8 项检查：7 项正常 · 0 项警告 · 1 项异常」
     + 分项清单（内核存活正常 / 资源占用异常 CPU 8.4%、内存 15404 KiB、fd 88、goroutine 15
       + 「怎么办：资源占用触顶：到『监控』页查看是什么占满，按 AGENTS G-03 红线排查」）
     手机端同数据纵向堆叠、顶部导航收进「更多」
```

8 项只读检查全部真实采集；健康分算法 = 8 项 0/50/100 算术平均（本批 88 分）。未改动任何设置；无 setInterval/轮询（G-19）。

### 场景②配置快照（config-snapshot）

```text
[desktop/mobile] 登录 → 真实点一级导航「设置」→ 真实点子 tab「配置快照」
  → DOM heading 区读到「配置快照（时光机）是什么？」+「创建快照」+「快照列表」
  → 目视：顶部说明「给当前系统配置拍一张照片：装了哪些插件、什么版本、启停态与关键路径…
     和备份不一样：备份打包网站文件与数据库；快照只记配置，不备份数据、不替换插件包」
     + 创建快照表单（输入框占位「例如：装 WordPress 前」+「创建快照」按钮）
     + 快照列表空态「还没有配置快照。上面输入一个名字，点创建快照即可给当前配置留一颗后悔药」
```

隔离实例为全新 state，无历史快照——**如实拍空态 + 创建入口**，未伪造快照数据。

### 场景③运维日历（ops-calendar）——首轮 bug 态（历史证据，归档自 502d0df）

```text
[desktop/mobile] 登录 → 真实点一级导航「计划任务」→ 真实点子 tab「运维日历」
  → 目视：月视图头部「运维日历 / 所有会自动跑的任务，一张图看完 · 点任务看详情与跳转」
     + 翻月按钮「‹ 上月 / 今天 / 下月 ›」+「2026 年 11 月」+ 三色图例（内核/插件/系统计划任务）
     + 正文停在「正在读取任务…」（无月历网格、无任务标记）
  → 端到端 12s 等待 + 切 tab 往返 + 网络抓包均无法进入完成态
```

**根因（源码级，已同步 lead）**：`web/calendar.js` 的 `load()` 自锁——`render()` 第 438 行设 `S.loading = true`，紧接着第 445 行调 `load()`，而 `load()` 第 220 行 `if (S.loading) return Promise.resolve()` 直接返回，`GET /api/v1/scheduler/tasks` 请求从未发出。网络日志证据：

```text
$ playwright page.on('request'/'response') 抓 /api/v1/ 全部请求（隔离实例，真实登录后点进日历）
输出: ... REQ/RES 一堆；日历相关仅见 REQ/RES 404 /api/v1/invoke/cron/cron.list（cron 插件未装）
      零条 /api/v1/scheduler/tasks 请求（手动 fetch 同 URL -> status=200, len=589, 含 2 个内置任务）
$ curl -s -b cookies http://127.0.0.1:18888/api/v1/scheduler/tasks
输出: http=200 time=0.0007 {"tasks":[{"id":"builtin-audit-clean",...},{"id":"builtin-logs-maintain",...},...]}
```

因此首轮（bug 版）日历页面永久停在读取中，**月视图任务标记/空态未证明**。本卡写域只含截图+报告，不改源码、不注入 mock 数据粉饰界面——如实拍下这个真实状态并在第 5 节披露为历史证据。

#### 修复后补拍（ops-calendar `-02`，新证据，归档自修复版 HEAD 369af06）

r22-calfix 提交 `c90def1`（`[agent:r22-calfix] fix(web): 修复运维日历自锁导致 scheduler/tasks 零请求`）已入 HEAD：loading 状态机收归 `load()` 自管 + gen 代际号防切视图竞态 + render 幂等去重 + 置位后重绘 loading 壳；其红→绿 DOM stub 证据为「修复前 schedCalls=0（红）→ 修复后 schedCalls=1、成功/空/失败三态全过（绿）」。经 lead 批准补拍，走与首轮相同的隔离口径（`git archive HEAD` 含修复 → 独立 `make web-dist`+build → 18888，config/state/run/log 全 /tmp，不依赖主实例旧二进制 PID 2340414、不碰用户桌面），新增 `ops-calendar-desktop-02-fixed-month.png` / `ops-calendar-mobile-02-fixed-month.png`：

```text
$ git merge-base --is-ancestor c90def1 HEAD && echo ancestor
输出: c90def1 IS ancestor of HEAD（HEAD=369af062）
$ git archive HEAD | tar -x -C /tmp/kore-r22-calfix-reshoot/src
输出: 归档源码含修复注释「loading 由 load() 自己置位…load() 幂等 guard 把自己锁死（R22 真机 bug）」
      + `if (S.loading || S.loaded) return` + gen 代际号；web/dist/calendar.js 24281B（bug 版 22840B）
$ make web-dist && go build ... -o /tmp/kore-r22-calfix-reshoot/bin/kored
退出码: 0；隔离二进制 11497634 bytes
$ kored serve --config /tmp/kore-r22-calfix-reshoot/config/config.yaml
输出: {"msg":"kore ready","pid":2392417,"addr":"127.0.0.1:18888",...}；healthz=200
$ playwright 真表单登录 + 真点「计划任务→运维日历」+ 等 loading 消失 + 等 .kcal-grid
输出:
  [OK] ops-calendar/desktop -> 1440x900 78007B route=tasks/calendar
       NET=["REQ scheduler/tasks","RES 200 scheduler/tasks"]
       DOM={"month":"2026 年 11 月","cells":35,"hasLoadingText":false,
            "body":"... 25 审计按龄清理 日志自动切割与清理 ... 共 2 任务·内核调度任务 2 条·系统计划任务不可用（插件未装或无权读取）"}
  [OK] ops-calendar/mobile -> 390x844 57250B route=tasks/calendar
       NET=["REQ scheduler/tasks","RES 200 scheduler/tasks"] DOM 同上（35 格 + 2 任务标记）
```

红→绿结论：修复前 `scheduler/tasks` 零请求、页面停在"正在读取任务…"（`-01`，历史）；修复后 `scheduler/tasks` 真发并 200、月历网格 35 格 + 11/25 两条任务标记（紫色「审计按龄清理」/ 蓝色「日志自动切割与清理」）真实渲染（`-02`，新证据）。系统计划任务来源因 cron 插件未装仍如实显示"不可用"——诚实边界，不伪造。

### 场景④批量操作（batch-ops）

```text
[desktop/mobile] 登录 → 真实点一级导航「网站」→ 真实点子 tab「批量操作」
  → DOM heading="批量操作中心" + 四步向导 chip「选场景 / 选操作与目标 / 预览确认 / 执行与结果」
  → 目视：第一步「选择要批量处理的对象 / 选择一类资源后，再决定对它执行什么操作」
     + 两类场景卡片「批量启停站点（一次启用或停用多个网站；每条独立执行，某条失败不影响其它条目）」
       「批量重启本机容器（一次重启多个本机容器；带锁标的核心容器会被自动排除，重启属于危险操作需二次确认）」
     页面写明「跨插件一次处理多个目标：选目标、选操作、预览影响清单，再统一执行并查看每一条结果。」
```

本批只拍选场景入口与两类场景卡片（真实渲染）；未真进目标列表/执行批量（隔离实例无站点/容器实例，避免污染状态），如实标注。

## 4. 产品定位自评三问（验收项③，原文）

### 场景①系统体检（health-checkup）

**问 1：本页解决什么用户问题？** 解决"本机到底健不健康、出问题该去哪查"——一键从 8 个只读端点现场采集资源占用、插件状态、告警、定时任务与系统信息，给出 0-100 健康分和每项一句白话"怎么办"，把过去散落在监控各页的被动数字变成一次主动体检。小白不用懂 goreoutine/fd 门槛，照"怎么办"就能定位。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 多为分散的资源监控面板，没有"一键评分 + 每项修复指引"的聚合入口。Kore 把 8 项判据固化成前端算法、总分分档（90+健康 / 70-89基本正常 / <70需要关注），方向领先。差距：①8 项判据是本页自定启发式，不是可配置的 SLO；②健康分只反映采集瞬间，不画历史曲线；③"怎么办"指向其它页面但无深链直达参数（需用户自己找菜单）。属范围边界，不是占位。

**问 3：当前"可用"还是"占位"？** **可用（真采集证据）。** 判据：隔离实例真点"开始体检"，健康分 88/100、8 个分项全部来自现场只读端点，资源占用异常项给出具体数值（CPU 8.4% / 内存 15404 KiB / fd 88 / goroutine 15）与"怎么办"——不是灰字占位。诚实标注：本批为隔离实例（无插件配置），部分项走空态/降级判定；未在主实例 8787 取证（共享运行态资产，不碰）。

### 场景②配置快照（config-snapshot）

**问 1：本页解决什么用户问题？** 解决"改配置改坏了想回滚、但分不清配置变更和数据变更"——给当前装了哪些插件、什么版本、启停态与关键路径拍一张"照片"，改坏后对比差异、一键回到拍照时的启停态；页面明确"备份打包网站文件与数据库，快照只记配置，不备份数据、不替换插件包"，把两种后悔药分清楚。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品多是整站备份（文件+数据库一起打），回滚粒度粗、体积大。Kore 把"配置元数据快照"独立出来，轻量、秒建、差异对比可读，且只落 kore 自己的 state 目录（snapshots/），零侵入。差距：①快照只覆盖插件启停态+版本+关键路径，不含任意配置文件内容；②版本变化不自动降级/升级，回滚后要去商店处理；③没有快照定时/自动创建，全靠手动。属范围边界，不是占位。

**问 3：当前"可用"还是"占位"？** **可用（入口与空态真实，本批未建快照）。** 判据：真机设置→配置快照页显示完整说明、创建表单、快照列表空态，按钮真实渲染。诚实标注：隔离实例无历史快照，列表为空态如实呈现；未真点创建/回滚/删除（避免污染隔离状态），这些写操作为未证明。

### 场景③运维日历（ops-calendar）

**问 1：本页解决什么用户问题？** 解决"定时任务散在 cron 插件、内核 scheduler、backup.schedule、SSL 续期各处，看不全也看不懂"——把全部会自动跑的任务摊到一张月历上，按来源三色区分（内核/插件/系统计划任务），点任务看详情与跳转，让"哪天会跑什么"一目了然。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品的定时任务多是列表式 cron 配置页，没有日历视图与跨源聚合。Kore 用月视图 + 三色图例把"时间维度"引进来，方向是差异化的。差距：①首轮版本的 `load()` 有自锁 bug（见第 3 节），页面永久停在"正在读取任务…"——这是**真实缺陷而非边界**，已由 calfix `c90def1` 修复并补验；②cron 插件未装时系统计划任务来源不可用（修复后仍如实显示"系统计划任务不可用"）；③无任务编辑入口，只能跳转。

**问 3：当前"可用"还是"占位"？** **可用（已修复并补验）。** 判据：首轮（bug 版 502d0df）真机确实停在"正在读取任务…"、任务标记未证明，如实保留 `-01` 历史证据；calfix `c90def1` 修复后，从修复版 HEAD（369af06）隔离实例补拍 `-02`，`scheduler/tasks` 真发并 200、月历网格 35 格 + 11/25 两条任务标记（审计按龄清理 / 日志自动切割与清理）真实渲染、loading 文案消失，红→绿闭环。未证明范围：系统计划任务来源因 cron 插件未装仍不可用（如实显示），未在主实例 8787 取证（共享运行态资产，不碰）。

### 场景④批量操作（batch-ops）

**问 1：本页解决什么用户问题？** 解决"同类操作要一个个点、重复劳动还容易漏"——选一类资源（站点/容器等）→ 选操作与目标 → 预览影响清单 → 统一执行并逐条看结果，四步向导把"批量"的破坏性收敛到"先看清单再执行"，危险操作（批量重启容器）明确二次确认与带锁核心容器自动排除。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品批量操作多是勾选表格 + 单一动作，跨插件资源类型覆盖有限。Kore 用"场景卡片"抽象跨插件目标（批量启停站点、批量重启容器），每条独立执行、某条失败不影响其它条目，预览确认前置，安全边界清楚。差距：①本批隔离实例无站点/容器实例，目标列表为空态，未证明真实批量执行；②场景种类目前两类，覆盖面小于竞品全表格批量；③没有批量操作的撤销。属范围边界，不是占位。

**问 3：当前"可用"还是"占位"？** **可用（入口与向导真实，执行流未证明）。** 判据：真机网站→批量操作页显示四步 chip、两类场景卡片与说明文案，都是真实渲染。诚实标注：隔离实例无真实站点/容器实例，未进目标列表与执行流（避免污染状态），批量执行/结果页为未证明。

## 5. 已证明 / 未证明（验收项③，逐场景）

| 场景 | 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- | --- |
| health-checkup | PC/手机各 1 张；真点"开始体检"后健康分 88/100、8 分项清单真实渲染，资源占用异常项给具体数值+怎么办 | 未在主实例 8787 取证（共享运行态资产）；隔离实例无插件配置，部分检查项走空态/降级判定；健康分历史曲线未提供 |
| config-snapshot | PC/手机各 1 张；设置→配置快照页完整说明 + 创建表单 + 列表空态 + 创建快照按钮真实渲染 | 隔离实例无历史快照，列表为空态如实呈现；未真点创建/回滚/删除（避免污染状态）；差异对比为真实功能但未执行 |
| ops-calendar | **首轮历史（bug 版 502d0df）**：PC/手机各 1 张（`-01`），头部/翻月/图例真实渲染但停在"正在读取任务…"，scheduler/tasks 零请求，如实记录；**修复后新证据（修复版 HEAD 369af06，calfix `c90def1`）**：PC/手机各 1 张（`-02`），`scheduler/tasks` 真发 RES 200、月历 35 格 + 11/25 两条任务标记真渲染、loading 文案消失 | 首轮 bug 已修复并补验，**不再是未证明项**；系统计划任务来源因 cron 插件未装仍显示"不可用"（如实边界）；未在主实例取证；未注入 mock 粉饰 |
| batch-ops | PC/手机各 1 张；网站→批量操作页四步向导 chip + 两类场景卡片（批量启停站点 / 批量重启容器）+ 说明文案真实渲染 | 隔离实例无站点/容器实例，目标列表为空态/骨架；未进"选操作与目标/预览确认/执行与结果"后续步骤（避免污染状态）；未真执行批量 |
| 全局 | 10 张证据 md5 全异（首轮 8 + 修复补拍 2）、尺寸合规、命名规范；G-29 主实例零改动；G-30 secret-check 0 FAIL | 未在主实例 8787 取证；未使用共享桌面/Edge 窗口（按任务卡红线）；4 场景写操作基本未真执行（保护隔离实例状态） |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 10 张尺寸（首轮 8 + 补拍 2）；DOM/网络证据原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 10 张 PNG（首轮 8 + 运维日历修复后补拍 2）+ 本报告；未改任何源码、Makefile/embed、运行态资产。与并行任务 `r22-shots2`（端口 18889、前缀 `migrate`/`webhook`/`report`/`topology`）写域仅目录层重叠、文件名前缀互不重叠、各提各的。
- **G-28**：PC + 手机 + 每场景自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足；运维日历首轮 bug 态作历史证据保留，修复后补拍 `-02` 已把任务标记从"未证明"翻成"已修复并补验"，红→绿两态均真实。
- **G-29**：主实例运行态零改动（第 1 节复核；`bin/kored` mtime `18:45:06` 未变、8787 PID 2340414 未重启、healthz 200、`.kore-local.yaml` mtime `11-23 04:59` 未变）。
- **G-30**：报告无任何明文口令（临时口令只在 /tmp，收尾删除）；`make secret-check` → `0 FAIL / 22 处匹配（占位写法均合规）`，退出码 0。

```text
$ cd /home/pt/Work/GolandProjects/kore && make secret-check
[RUN ] secret-check
secret-check: 0 FAIL / 22 处匹配（占位写法均合规）
退出码: 0
```

> ▎💼 [P8 自检] 冰山下面还有冰山：本批不止补 8 张截图，还在隔离实例里端到端复现了运维日历的前端自锁 bug（render 设 loading=true → load() 立即 return → scheduler/tasks 零请求），把"截图拍不到任务标记"从"可能是没数据"逼成有源码行号 + 网络日志 + 手动 fetch 对照的确定性结论并同步 lead；calfix `c90def1` 修复后，又不依赖主实例旧二进制、从修复版 HEAD 隔离实例补拍 `-02`，红→绿双向坐实。做难而正确的事，不遮不掩，也不把半截结论当终点。
