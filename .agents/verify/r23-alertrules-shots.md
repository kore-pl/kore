# R23 G-28 双端截图 · 告警规则可视化配置页

日期：2026-11-24 19:30–19:38（Asia/Shanghai）｜Owner：`r23-alertrules`（🔵 美团味）｜接线 HEAD：`3fcf520`（r23-integration 统一接线）

> ▎[🔵 美团味] 做难而正确的事，过程透明、结果说话。截图来自接线后 HEAD 的隔离实例真实浏览器 + 真实登录表单 + 真实点击导航，非同图缩放、非设计稿、非 DOM 断言冒充。首轮桌面图被首次登录的新手引导弹窗遮挡、手机图标题被裁，均如实重拍覆盖为无遮挡版本，不把半截证据当终点。

## 0. 结论先行

告警规则页 G-28 双端证据齐备：**PC 1440×900 + 手机 390×844 各 1 张真实截图**，`file` 实测尺寸合规、md5 全异（distinct=2）、DOM 内容目视确认页面主体真实渲染（标题 / 新建表单 / 空态按钮 / 监控 hub 高亮）。G-29 声明：主实例 8787（PID 2396602）全程未重启、未改配置、未覆盖静态资源，主配置 mtime 仍为 2026-11-23 04:59（未变），healthz 200。临时脚本、口令、隔离实例全部收尾清理，零残留；`make secret-check` 0 FAIL。**证据齐，声明完成。**

## 1. 隔离实例（G-29：主实例 8787 零改动）

接线信号：r23-integration 报新 HEAD `3fcf520`，`git show --stat` 只含 Makefile / web/app.js / web/embed.go / web/shell.js 四文件；已只读核验该 HEAD 的 SHELL_VIEWS 注册：`web/app.js:2184` → `'alert-rules': ['KoreAlertRules','/assets/alert-rules.js','nav.alertRules','告警规则']`，挂载 `web/app.js:2234` monitor hub 的 views 数组内。路由 id = `monitor/alert-rules`（一级菜单 A6 上限，不新增）。

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse HEAD
输出: 3fcf520a59b0694132eebe76b3d7154739c62536
$ UI_SHOT_BUILD_SOURCE=head bash scripts/ui-shot.sh --scene alert-rules \
    --route monitor/alert-rules --desktop --mobile --port 18892 \
    --expect-text '告警规则' --settle 1500
输出:
[INFO] kored: /tmp/kore-ui-shot-cache/kored-head-3fcf520a59b0
[INFO] 隔离实例: pid=2475774 port=18892
[OK] desktop 1440x900 116936B .../alert-rules-desktop-01.png
[OK] mobile 390x844 80851B .../alert-rules-mobile-01.png
[DONE] scene=alert-rules route=monitor/alert-rules
退出码: 0
```

工具 `scripts/ui-shot.sh` 现成成熟：`git archive HEAD` → 独立构建 → config/state/run/log 全落 /tmp → 独立端口 18892（避让 certlife 18890 / slowlog 18891）→ healthz 就绪 → 写已知口令哈希 → API 登录拿 cookie → 路由存在性校验（`KoreShell.current()==='monitor/alert-rules'`）→ 双端截图 → `identify` 实测 → trap 自动停实例删临时目录。

**重拍说明（首轮证据不达标，如实重做）**：首轮桌面图被首次登录的「欢迎使用 Kore」新手引导弹窗遮挡、手机图 guided 关掉后残留滚动导致标题被裁。因共享脚本不可改，复制脚本到 /tmp 注入「真实点击『以后再看』关引导 + `window.scrollTo(0,0)`」后重拍，二进制来源仍是 HEAD 归档（同一 kored head-3fcf520），路由/登录/点击全真；临时脚本在同一次 bash 调用内 `rm -f` 删除，零残留。

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' .kore-local.yaml
输出: 2026-11-23 04:59:58.799907899 +0800 1677   # 主配置 mtime 未变
$ pgrep -af 'kored.*serve'
输出: 2396602 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml（主实例未重启）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ ss -ltn | grep ':18892 '
输出: 无（隔离实例已由 trap 清理）
$ ls /tmp/ui-shot-alert-rules-*
输出: 无残留
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主 state/run/socket，未重建主 `bin/kored`，未重启 8787，未使用任何共享桌面浏览器窗口。全部证据来自隔离实例 + headless playwright 自拍。

## 2. 截图清单与 file 实测

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`。PC 用 1440×900 viewport、fullPage；手机用 390×844 viewport（deviceScaleFactor=1，视口精确截图）。

```text
$ file alert-rules-desktop-01.png alert-rules-mobile-01.png
alert-rules-desktop-01.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
alert-rules-mobile-01.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0

$ md5sum alert-rules-desktop-01.png alert-rules-mobile-01.png
8a82c84857f6c044a2d0009e51b38ef1  alert-rules-desktop-01.png
44019a9cbc69ff6b876cbb86f1db7106  alert-rules-mobile-01.png
退出码: 0；2 张 md5 去重计数 = 2（全不同）
```

蓝军自检「同图缩放冒充双端 / 设计稿替代 / 拍到旧界面」：**全部证伪**。md5 全异 + `file` 实测尺寸不同 + 目视确认手机端导航收进「更多」抽屉、表单纵向堆叠，与 PC 横排布局明显不同；全部来自真浏览器渲染，登录走真实表单、导航走真实点击；隔离二进制独立构建自接线后 HEAD `3fcf520`，工具在截图前断言 `KoreShell.current() === 'monitor/alert-rules'`，拍到的正是接线后的新视图。

## 3. 交互真实性与页面内容（真实点击 + 目视 DOM）

```text
[desktop] 真表单登录 → 真点一级导航「监控」→ 真点子 tab「告警规则」
  → 真实点击「以后再看」关掉首次登录引导弹窗（不遮主体）
  → 目视：左侧导航高亮「监控」；顶部子 tab 条含「监控 / 系统体检 / 运行报告 / 服务拓扑 / 日志 / 进程 /
           告警规则(激活) / 故障演练 / 日志告警」
  → 标题「告警规则」+ 副标题「在这里告诉 Kore 该盯什么、盯多紧。规则保存在这台机器上；测试触发会真的往
     「告警中心」写一条告警，方便你马上验证。」+「重新加载」按钮
  → 「新建告警规则」面板：说明文案 + 规则名称输入框(占位「例如：CPU 持续偏高」)
     + 监控项下拉(当前「CPU 使用率」) + 阈值输入(90) + 中文帮助文案(建议 80–90、范围 1–100%)
     +「添加规则」按钮
  →「我的告警规则（0 条）」空态：「还没有告警规则」+「配一条规则，Kore 就能在资源超过阈值时往告警中心
     写一条提醒——不用再记硬编码的数字。」+「创建第一条告警规则」按钮

[mobile 390×844] 同内容；顶部导航收进「更多」抽屉、子 tab 横向可滚、表单与列表纵向堆叠，
  标题/副标题/表单/空态入口真实渲染，滚动归顶后无裁切
```

隔离实例为全新 state，`localStorage` 无历史规则——**如实拍空态 + 创建入口**，未伪造规则数据。

## 4. 产品定位自评三问（G-28 原文）

**问 1：本页解决什么用户问题？** 过去告警中心只展示服务端埋点，监控页阈值写死在 `monitor.js`（cpu/memory/disk 90%），用户无法自建规则。本页让用户可视化配置「CPU / 内存 / 磁盘 / 负载 超过阈值 → 产生站内告警」：规则增删改查、启停、测试触发（真写 `POST /api/v1/alerts` 到告警中心可核对），把"看硬编码阈值"变成"自己配规则"。中文标签 + 每行帮助 + 范围校验 + 人话错误 + 空态引导，小白照着就能配。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的告警多为插件或通知通道配置，阈值告警散在监控项里，配置入口不统一。Kore 把四类阈值收敛成一张可视化规则表 + 测试触发闭环，方向清晰。差距：①规则自动评估（周期采 metrics 比阈值 → 触发告警）尚未接入 scheduler 内置任务，当前规则存本机 localStorage、测试触发是真写告警但不自动评估——这是范围边界，不是占位；②规则不跨设备同步（单管理员、G-11 不做多用户 RBAC）；③监控项固定四类，暂不支持自定义指标或持续时间条件（如"连续 5 分钟超阈值"）。

**问 3：当前"可用"还是"占位"？** **可用（配置管理闭环真实，自动评估待接线）。** 判据：隔离实例真浏览器确认标题、完整表单（下拉+阈值+帮助+校验）、空态入口、监控 hub 挂载全部真实渲染；规则 CRUD / 启停 / 删除二次确认 / 测试触发的代码路径已实现并经 node 级纯函数自测（validate 6/6 + normalize 收口全过）+ `node --check` exit 0。诚实标注：本批只拍了空态（隔离实例无历史规则），写操作交互（真建一条规则 / 测试触发真写告警）未在截图流程中执行（保护隔离状态、避免污染）；规则自动评估未接入调度侧，属明确的后续范围。

## 5. 已证明 / 未证明

| 项 | 已证明（本次真机证据） | 未证明（如实列出） |
| --- | --- | --- |
| 双端截图 | PC 1440×900 / 手机 390×844 各 1 张，`file` 实测合规、md5 全异、目视无遮挡 | 未在主实例 8787 取证（共享运行态资产，不碰） |
| 挂载与路由 | HEAD 3fcf520 的 app.js:2184 注册 + 2234 挂 monitor；工具断言 `KoreShell.current()==='monitor/alert-rules'` 通过；真点导航进入 | — |
| 页面内容 | 标题 / 副标题 / 新建表单（三字段+帮助+按钮）/ 空态入口真实渲染，桌面+手机双端目视 | — |
| 规则写操作 | 代码路径实现 + node 级纯函数自测 + `node --check` exit 0 | 未在截图流程真建规则 / 真点测试触发（保护隔离状态，写操作为未证明） |
| 自动评估 | 测试触发复用 `POST /api/v1/alerts` 真写告警（源码契约已核） | 周期采 metrics 比阈值 → 自动触发尚未接入 scheduler，属后续范围 |
| G-29/G-30 | 主配置 mtime 未变、8787 未重启、healthz 200；临时口令/脚本/实例零残留；`make secret-check` 0 FAIL | — |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测两张尺寸；目视 DOM 原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 2 张 PNG + 本报告；未改任何源码 / Makefile / embed / 运行态资产。
- **G-28**：PC + 手机 + 自评三问 + 已证明/未证明 + md5 全异 + 尺寸实测，逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核）；全部证据来自隔离实例。
- **G-30**：报告无任何明文口令；`make secret-check` → `0 FAIL / 22 处匹配`，退出码 0。
- **临时脚本**：两次重拍的 /tmp 脚本均在同一 bash 调用内删除，`ls /tmp/ui-shot-alert-rules-*` 无残留。
