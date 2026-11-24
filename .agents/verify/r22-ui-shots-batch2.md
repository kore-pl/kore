# R22 G-28 双端截图：配置迁移 / 通知通道 / 运行报告 / 服务拓扑

日期：2026-11-24 18:47–19:02（Asia/Shanghai）｜Owner：`r22-shots2`（🔵 美团味）｜批次：第 22 轮批次2 四张能力卡 G-28 双端证据补齐

## 0. 结论先行

第 22 轮批次2 四个新功能（`config-migrate` / `notify-webhook` / `ops-report` / `service-topology`）已补齐 G-28 双端证据：**4 场景 × 双端 = 8 张真实运行界面浏览器截图**，外加**运行报告「生成报告」交互后双端 2 张**（应 lead 指令增补，共 10 张）。PC 1440×900 / 手机 390×844，`file` 实测全过、`md5sum` 10 张全异。每场景产品自评三问 + 已证明/未证明两栏 + G-29 声明齐备。证据齐，声明完成。

> ▎[🔵 美团味] 过程透明，结果说话：10 张截图全部来自隔离实例真实浏览器 + 真实 `#kore-password` 表单登录 + 真实两级点击导航（设置/监控 → 子 tab），运行报告还真实点击了「生成报告」按钮。没有一张是同图缩放、设计稿、DOM 断言冒充或 cookie 注入直达。空态（拓扑无插件数据、报告无 monitor/backup 数据）如实标注，不伪造成功态。

**过程中发现并闭环的真 bug（横向交流，非本人写域）**：

1. **运行报告页渲染崩溃** —— 首轮截图发现 `运行报告渲染失败：Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'`，根因是 `web/report.js` 的 `paint()` 把字符串 `'rp-preview-body'` 传给 `appendChild`。已通报 `r22-report`，其修复提交 `16af640`（同名同类 `tbody` 一处一并修）落入 HEAD。**本报告基于含该修复的新 HEAD `16af640` 重建隔离实例后重拍**，报告页 5 数据源/时间范围/生成按钮/预览区全部正常，生成交互无错误横幅。
2. **手机端导航"不可见"** —— 首轮手机截图报 settings/monitor 导航不可见。诊断确认**非产品 bug**：390×844 下底部栏只显示前 5 项，其余（含设置/监控）在「更多」抽屉（`.kore-nav-drawer`），属裁决41 正常适配。修截图脚本（点「更多」→ 在抽屉内点目标）后全通。
3. **服务拓扑空态** —— 隔离实例 plugins=0、site/container/discover 插件未装，四数据源全空 → SVG 走空态。与 `r22-topology` 共识：正确降级，非 bug；hover/tap 读数面板无真实节点可验，判据11 列「未证明（数据源空）」，不加测试钩子污染生产代码。

## 1. 隔离实例（G-29：主实例 8787 零改动；本轮未改动主实例运行态配置）

任务卡指出的主实例构建 sha `2b1627ba` 实为**主二进制 `bin/kored` 的 sha256 前16位**（`sha256sum bin/kored` = `2b1627ba83760132…`），非 git commit。为拍含 R22 四功能且完全隔离的界面，走 `git archive HEAD` + 独立构建 + 独立实例（端口 **18889**，与并行批次1 的 18888、主实例 8787 分开）。首轮 HEAD `502d0df` 不含 report 修复；收到 `r22-report` 通报后，**基于含修复的新 HEAD `16af640` 重建隔离实例并重拍全部截图**。

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse HEAD
输出: 16af640（含 r22-report 修复 commit 16af640 / appendChild 误传字符串两处已修）
$ grep -nE "add\((preview|table), *'(rp-preview-body|tbody)'\)" web/report.js || echo 无字符串误用
输出: 无字符串误用（修复已在 HEAD）
$ git archive HEAD | tar -x -C /tmp/kore-r22-shots2/src
$ cd /tmp/kore-r22-shots2/src && make -s web-dist &&
  CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false \
    -ldflags '-s -w' -o /tmp/kore-r22-shots2/bin/kored ./cmd/kored
退出码: 0；隔离二进制 sha256= e4d73ebaca6776df…（独立产物，全路径落 /tmp）
$ printf '%s' '***' | /tmp/kore-r22-shots2/bin/kored admin-password --set --stdin --config /tmp/kore-r22-shots2/seed2.yaml
输出: 已将口令哈希写入 0600 配置（明文口令只存 /tmp/kore-r22-shots2/admin.pw，报告及全部证据均 *** 占位，G-30 合规）
$ /tmp/kore-r22-shots2/bin/kored serve --config /tmp/kore-r22-shots2/config2.yaml
输出: pid=2380003；addr=127.0.0.1:18889（config/state/run/log 全落 /tmp/kore-r22-shots2）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18889/-/healthz
输出: 200
$ ss -ltn | grep -E ':(8787|18888|18889) '
输出: 127.0.0.1:8787（主实例 PID 2340414）/ 127.0.0.1:18889（本批隔离实例 PID 2380003）独立 LISTEN
```

浏览器走登录页真实表单 `#kore-password` 填口令、点「登录」按钮进入（**非 API 登录 / 非注入 cookie / 非 hash 直达**）；首次登录的新手引导通过真实点击 `.kore-onboard-skip`（「以后再看」）关掉；四个场景均通过真实点击一级导航（桌面 `.kore-nav-item[data-view]`；手机先点「更多」展开抽屉再点 `.kore-nav-drawer-item[data-view]`）+ 真实点击二级 tab `.kore-hub-tab[data-sub]` 到达。截图前断言视图内部特征元素出现（`.mig-h2` / `.view-title` / `.rp-h2` / `.topo-h2`），非 tab 标签文字（避免断言过早通过拍到空壳）。

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' /home/pt/Work/GolandProjects/kore/bin/kored
输出: 2026-11-24 18:45:06.013694035 +0800 11497634   # 主二进制 mtime/大小未变（本批隔离产物 sha e4d73eba 与 lead 确认的主实例 sha 2b1627ba 不同源）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ pgrep -af 'kored.*serve'
输出: 2340414 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml（主实例未重启、未改配置）
      2380003 /tmp/kore-r22-shots2/bin/kored serve --config /tmp/kore-r22-shots2/config2.yaml（本批隔离实例）
$ grep -n 'index_dir' .kore-local.yaml
输出: index_dir 指向 /home/pt/Work/GolandProjects/kore-plugins/index   # 主配置未改
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主实例 state/run/socket、未重建主 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r22-shots2` 隔离实例。隔离实例的临时脚本、临时口令、config/state/run/log 在收尾时删除（G-30 零明文凭据入仓）。注：`/api/v1/system/info` 本版本响应体不含 `paths.index_dir` 键（r19 已实测），故 G-29 ①② 以"主配置文件 index_dir 字面正确 + 主二进制 mtime/PID 未变 + healthz 200 + 未在本轮写主运行态"四项等价坐实。workaround 无（未使用任何 workaround）。

## 2. 截图清单与 file 实测（验收项①②）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-01.png`；报告另有 `<场景>-generated-<desktop|mobile>-01.png` 2 张。PC 用 1440×900 viewport，手机用 390×844 viewport（playwright `deviceScaleFactor=1`、手机 `isMobile`/`hasTouch=true`）；均为**精确视口截图**（非 fullPage 滚动长图），保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <10 张正式证据>
config-migrate-desktop-01.png:       PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
config-migrate-mobile-01.png:        PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
notify-webhook-desktop-01.png:       PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
notify-webhook-mobile-01.png:        PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
ops-report-desktop-01.png:           PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
ops-report-mobile-01.png:            PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
service-topology-desktop-01.png:     PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
service-topology-mobile-01.png:      PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
ops-report-generated-desktop-01.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
ops-report-generated-mobile-01.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图 / 拍到旧界面」：**全部证伪**。

```text
$ md5sum <10 张正式证据>
46244b79ebc2bf65f79379bc682d1621  config-migrate-desktop-01.png
732178a35cd033475a362d208926681f  config-migrate-mobile-01.png
92a81d3c34599aaf163733279ccfa600  notify-webhook-desktop-01.png
bda557ae949f830cb86bc7fc764149d4  notify-webhook-mobile-01.png
5108e29489410fef319815cd223d1df9  ops-report-desktop-01.png
f3613f7e243aef754b4b0e1d86e2b2e1  ops-report-mobile-01.png
22cd2bfe342dbf33fbb6c8f3fbe88143  service-topology-desktop-01.png
3af36753c658ace47759c576b5b2a577  service-topology-mobile-01.png
cfae1d00579ed52cf937547b0a00d17d  ops-report-generated-desktop-01.png
45cdef335963783490fca13146d02903  ops-report-generated-mobile-01.png
退出码: 0；md5 去重后计数 = 10（全不同）
```

- **同图缩放**：10 张 md5 全异 + `file` 实测 PC/手机尺寸不同 + 目视确认手机端底部 5+「更多」导航栏、横向子 tab 条与桌面侧边栏布局明显不同，证伪。
- **设计稿替代**：全部来自 playwright 驱动的隔离实例真实浏览器渲染，登录走真实 `#kore-password` 表单+「登录」按钮、导航走真实两级 click（含手机「更多」抽屉）、报告走真实「生成报告」按钮点击，证伪。
- **拍到旧界面**：隔离二进制独立构建（sha `e4d73eba`），基于含 report 修复的 HEAD `16af640`，4 视图均为 R22 新增能力真实渲染；report 首轮旧构建（sha `b1dc6790`，不含修复）拍到渲染崩溃，已识别并按新 HEAD 重拍修正，不存在"拿旧界面充数"。

## 3. 四场景交互真实性（真实点击 + DOM 断言原文）

### 场景① 配置迁移（config-migrate）

```text
[config-migrate desktop/mobile] 登录 → 关引导 → 点「设置」→ 点「配置迁移」tab
  → hash=#/settings/migrate；视图特征 .mig-h2="配置迁移"
  → DOM: 导出按钮=1（「导出当前配置」） 导入 file input=1（「选择迁移 JSON 文件」）
  → 页面文案："导出完整配置（已装插件与版本、启停态、非敏感配置、预设）为版本化 JSON 文件……文件绝不包含明文口令、令牌或会话数据。导入需先预览差异、再二次确认"
```

真实界面同屏：标题、导出按钮、导入面板（文件选择+预览差异）、导出/导入说明。隔离实例无历史迁移文件，导入区为空态（未选文件），如实标注。

### 场景② 通知通道（notify-webhook）

```text
[notify-webhook desktop/mobile] 登录 → 关引导 → 点「设置」→ 点「通知通道」tab
  → hash=#/settings/webhook；视图特征 .view-title="通知通道"
  → DOM: 空态文案=true
  → 页面文案："边界说明 · 你的数据你做主"；添加通知通道表单（接收地址 URL / 密钥 / 推送事件 4 勾选 / 保存通道）
  → 空态："已配置通道（0）还没有配置任何通道。添加后，告警触发时才会向外推送。"/"投递记录（最近 200 条）还没有投递记录。"
```

Webhook 配置表单 + 空状态真实同屏。**未填真实接收地址、未保存通道、未触发推送**（避免对外连接 + 无凭据），如实标注。

### 场景③ 运行报告（ops-report）

```text
[ops-report desktop/mobile] 登录 → 关引导 → 点「监控」→ 点「运行报告」tab
  → hash=#/monitor/report；视图特征 .rp-h2="运行报告"
  → DOM: 时间范围 select=1（"最近 24 小时"） 数据源 checkbox=5（全勾选） 生成按钮=1
  → 真实点击「生成报告」→ 无错误横幅；预览区出现真实报告：
    "报告已生成：5 个数据项（2 项读取失败，已如实标注）"
    "一、数据来源与口径"表格 5 行（资源使用趋势/告警统计/插件状态变更/备份完成情况/操作审计摘要）
    "二、资源使用趋势：读取失败 E_NOTFOUND 插件 monitor 未安装 → 暂无数据"
    三/四/五/六节按真实数据源状态渲染
```

**关键证据**：首轮旧构建（不含 16af640）拍到 `appendChild` 渲染崩溃；确认 HEAD 含修复后重建隔离实例重拍，`.rp-h2` 正常渲染、5 数据源/时间范围/生成按钮齐全，真实点「生成报告」后无错误、预览区出真实报告内容。report 修复真生效坐实。隔离实例未装 monitor/backup 插件，2 项数据源如实标"读取失败"，不伪造数据。

### 场景④ 服务拓扑（service-topology）

```text
[service-topology desktop/mobile] 登录 → 关引导 → 点「监控」→ 点「服务拓扑」tab
  → hash=#/monitor/topology；视图特征 .topo-h2="服务拓扑"
  → DOM: SVG(topo-svg)=1 节点(.topo-node)=0 空态标题=1
  → 页面："还没有可展示的服务 / 拓扑图需要至少一个数据源有内容。先装一个插件（如 site / container / discover），再回来刷新即可看到站点、容器与端口之间的关系。"/「去软件商店装插件」按钮
  → 数据源降级提示 3 条：容器读取失败（插件 container 未安装，相关节点标「未知」）/站点读取失败（site 未安装）/端口读取失败（discover 未安装）
```

隔离实例 plugins=0、site/container/discover 插件均未装（已 `curl /api/v1/plugins` 核实 count=0），四数据源全空 → SVG 走空态。与 `r22-topology` 达成共识：正确降级非 bug；hover/tap 读数面板逻辑已实现（`web/topology.js` showTip :304 / mouseenter :372 / touchstart :378 / 「查看详情」:310 / lastTouch 守卫 :369，静态源码可回读），但无真实节点时无法在真机截图验证，列「未证明（数据源空）」，不加测试钩子污染生产代码。

## 4. 产品定位自评三问（验收项③，原文）

### 场景① 配置迁移（config-migrate）

**问 1：本页解决什么用户问题？** 解决「换机/重装时要迁移配置，得手动抄插件清单、版本、启停态、非敏感配置，还容易漏或带出明文口令」——配置迁移页把已装插件与版本、启停态、非敏感配置、预设打包成带版本与 sha256 校验的 JSON 文件，导入走"校验 → 预览差异 → 二次确认"三段式，明确承诺文件绝不含明文口令/令牌/会话数据，小白也能安全跨机搬配置。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的配置迁移多靠整机备份/面板数据目录整包拷贝，格式不透明、难审阅、常连敏感数据一起带走。Kore 用可读 JSON + sha256 + 差异预览 + 二次确认，颗粒度更细、安全边界更清楚。差距：①本次隔离实例无历史迁移文件，导入区是空态，未真机走一遍导出→导入闭环；②只覆盖插件/配置/预设，不含站点文件与数据库内容（那属「备份」域）；③无增量/选择性迁移，只能整包。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（导出/导入入口与三段式说明可用，真机迁移闭环受迁移文件约束）。** 判据：真机渲染出「导出当前配置」按钮、导入 file input、「预览差异」按钮与完整安全说明，非空壳。诚实标注：隔离实例无现成迁移文件，未真机点击导出下载/导入应用——展示的是可用的入口与流程说明，不伪造迁移成功。

### 场景② 通知通道（notify-webhook）

**问 1：本页解决什么用户问题？** 解决「告警发生了却没人知道，想接个企业微信/自定义 Webhook 又得改代码配环境变量」——通知通道页给一个表单填接收地址 URL、可选密钥、勾选要推送的事件类型，保存后告警触发时 Kore 才向该地址 POST 一条消息；并有「边界说明」明确"Kore 不主动收集任何数据、只有你启用且告警实际触发才对外连接"，打消隐私顾虑。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品的通知多为邮件/站内信，Webhook 要装插件或改配置。Kore 把 Webhook 做成内置表单 + 事件勾选 + 测试按钮 + 投递记录（最近 200 条），门槛低、可追溯。差距：①无内置企业微信/钉钉/飞书模板，用户得自己填完整 URL（虽有示例提示）；②密钥只保当前进程内存、重启要重填（页面已明说）；③本次隔离实例未保存任何通道，无法验证真实投递。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（表单与空状态可用，真实投递受通道配置约束）。** 判据：真机渲染出接收地址/密钥/事件勾选/保存通道表单与「已配置通道（0）」空态，非空壳。诚实标注：未填真实地址、未保存、未触发推送——展示的是可用表单与真实空态，不伪造投递记录。

### 场景③ 运行报告（ops-report）

**问 1：本页解决什么用户问题？** 解决「想知道过去 24 小时/7 天机器资源趋势、告警、插件变更、备份、审计，得挨个页面翻再手动拼」——运行报告页选时间范围、勾数据项、点一次「生成报告」就把 5 类数据汇总成六节可打印 HTML/Markdown 报告，取不到的项一律标"暂无数据/读取失败"，不以 0 或推测值代替。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品多为单一资源图表或简单日志导出，缺少跨源汇总与"口径/局限"说明。Kore 报告每一项都带端点、口径与局限（如"告警统计只按 ts 过滤，端点无 since"）与状态列，透明度高。差距：①部分数据依赖插件（monitor/backup），未装时如实标"读取失败"而非补数据（本次隔离实例正是此态）；②无定时生成/邮件订阅，需手动点；③无 PDF 直出，靠浏览器打印。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（生成链路真跑通，数据完整度受插件安装约束）。** 判据：真机点「生成报告」后无错误横幅、预览区出真实六节报告、3 项已获取/2 项如实标读失败，下载 Markdown/HTML 按钮启用。诚实标注：隔离实例未装 monitor/backup 插件，2 项数据源标"读取失败"——这是能力边界的真实表现，报告本身可用。另注：首轮旧构建拍到渲染崩溃（appendChild 误传字符串），已由 r22-report 修复（16af640）并在新 HEAD 重拍坐实，非本页当前状态。

### 场景④ 服务拓扑（service-topology）

**问 1：本页解决什么用户问题？** 解决「站点连着哪些容器、容器开了哪些端口、站点用了哪个数据库，关系散在各页看不见」——服务拓扑页把站点/容器/端口/插件/数据库聚合成一张 SVG 关系图，节点按类型着色，点节点弹出读数面板（名称/类型/状态/详情+「查看详情」），让依赖关系一眼可见。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品少有跨插件的服务关系拓扑图，多看单页列表。Kore 用一张图串联 4 类数据源、节点可点进详情、hover/tap 出读数面板（静态源码可回读），信息密度与交互领先。差距：①依赖 site/container/discover 插件提供数据，未装时空态（本次隔离实例正是此态，无节点/无连线）；②本次无真实节点，hover/tap 读数面板未真机验证（逻辑已实现，见第 3 节源码锚点）；③无拓扑图导出/缩放手势细化。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（图容器/图例/空态引导/数据源降级提示已渲染，节点渲染受插件数据约束）。** 判据：真机渲染出 SVG 容器、5 类图例、三条数据源降级提示（插件未安装标「未知」）、「还没有可展示的服务」空态与「去软件商店装插件」引导按钮，是真实状态呈现而非灰字占位。诚实标注：隔离实例 plugins=0，无真实节点，节点 hover/tap 面板列「未证明（数据源空）」——非缺陷，是环境无数据。

## 5. 已证明 / 未证明（验收项③，逐场景）

| 场景 | 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- | --- |
| config-migrate | PC/手机各 1 张；「配置迁移」标题 + 导出按钮 + 导入 file input + 预览差异入口 + 安全说明同屏；真实两级点击导航到 #/settings/migrate | 未真机点导出下载/导入应用（无现成迁移文件）；未验证跨机迁移闭环与 sha256 校验失败路径 |
| notify-webhook | PC/手机各 1 张；Webhook 表单（URL/密钥/4 事件勾选/保存）+ 「已配置通道（0）」空态 + 投递记录空态 | 未填真实地址/未保存/未触发推送（避免对外连接+无凭据）；测试按钮与投递记录未真机取证 |
| ops-report | PC/手机各 1 张首屏 + 各 1 张生成后；时间范围 select + 5 数据源 checkbox + 生成按钮 + 真实点生成后六节报告预览（3 项已获取/2 项读失败）；report 修复 16af640 生效坐实 | 未装 monitor/backup 插件，2 项数据源标"读取失败"未取到真数据；下载 Markdown/HTML 未真机点击；无定时生成/邮件订阅 |
| service-topology | PC/手机各 1 张；SVG 容器 + 5 类图例 + 3 条数据源降级提示 + 空态引导 + 「去装插件」按钮 | 隔离实例 plugins=0，无真实节点/连线；hover/tap 读数面板（逻辑已实现，源码 :304/:310/:372/:378/:369）未真机验证——数据源空，非 bug |
| 全局 | 10 张核心证据（8 张场景 + 2 张 report 生成后），md5 全异、尺寸合规、命名规范；G-29 主实例零改动；report 真 bug 已识别并基于修复版重拍；手机导航问题已定性为工具问题并修正 | 未在主实例 8787 取证（其运行态为共享资产，不碰）；拓扑面板交互/报告下载/迁移闭环等写操作未真机执行 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 10 张尺寸；真实点击 DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 10 张 PNG + 本报告；未改任何源码、Makefile/embed、运行态资产。与并行任务 `r22-shots1`（端口 18888、前缀 health/snapshot/calendar/batch）端口与文件名前缀互不重叠，写域仅目录层共享、文件名不冲突。
- **G-28**：PC + 手机 + 每场景自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核；`bin/kored` mtime `18:45:06` 未变、8787 PID 2340414 未重启、主配置 index_dir 未改）；本轮未改动主实例运行态配置，无 workaround。
- **G-30**：报告无任何明文口令（口令一律 `***` 占位）；`make secret-check` → `0 FAIL`，退出码 0。
- **横向交流**：report 渲染 bug 通报 `r22-report`（已修复 16af640 并重拍闭环）；拓扑空态共识与 `r22-topology` 对齐（不加测试钩子）；配置迁移路由 `settings/migrate` 由 `r22-migrate` 提前告知（避免 exit=6 回落 404）。

```text
$ cd /home/pt/Work/GolandProjects/kore && make secret-check
[RUN ] secret-check
secret-check: 0 FAIL
退出码: 0
```

> ▎💼 [P8 自检] 冰山下面还有冰山：本轮不止补 10 张截图，还在真机里揪出 report 页 appendChild 崩溃这个真 bug 并推动 owner 修复、基于修复版重拍坐实；手机导航"不可见"没有甩锅给产品，靠 DOM 可见性断言定性为底部栏+「更多」抽屉的正常适配并修正工具；拓扑空态坚持如实标注、不加测试钩子污染生产代码。做难而正确的事，过程透明、结果说话。
