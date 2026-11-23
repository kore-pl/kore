> 元信息: 2026-11-23T17:38+08:00 · 执行者 kore-impl-container-view（implementer）· 只截图不改代码（代码 = `8f84933`，kore-impl-monitor 已定稿）· 隔离实例 `127.0.0.1:18877`（`--config /tmp/kore-mon/config.yaml`，state/run/log 全在 `/tmp/kore-mon`）· 插件 monitor **0.3.0**（本地包 sha `db747aad1dc5` 与已验签索引一致，离线安装）· 主实例 8787 零写入 · 报告 ≤70 行

# monitor 历史曲线 / 阈值高亮 / 进程 TOP 的 G-28 双端截图

## 0. 结论

双端截图齐（`file` 实测 1440×2447 full-page + 390×844），三个证据点全部真机渲染：历史曲线 SVG（3 条 polyline、4 个采样点）、阈值高亮行（真实 CPU 96.69%→99.4% 超 90% 阈值触发）、进程 Top10 表（10 行真实数据）。浏览器 Runtime 异常 0；压测用的22 个 CPU 进程按 PID 全部回收。

## 1. 截图证据（`file` 实测 + 色标帧校验 attempt=1）

| 文件 | `file` 实际宽高 | sha256 前16 | 覆盖内容 |
| --- | --- | --- | --- |
| `monitor-history-desktop-01.png` | **1440 x 2447**（full-page） | `801bf6a5bd369df9` | ①历史曲线 `.mon-chart` SVG：3 条 polyline（`mon-line-cpu/mem/disk`）+ 网格线，aria-label「CPU/内存/磁盘历史曲线（最近 4 个采样点）」，图注「最近 4 点 · 间隔 60s」；②阈值告警行 `.mon-alert`（左侧黄色高亮条）「警告 · CPU 99.4% / 阈值 90%…先用 monitor.processes {sort:cpu} 查看占用最高的进程…」；③进程 Top10 表 10 行 + 底注「共 834 个进程 · 单次采样 200 ms · CPU% 按单核归一」 |
| `monitor-history-mobile-01.png` | **390 x 844** | `be1cf00de5375c40` | 手机端同页：卡片式堆叠、**横向溢出 0**、按钮 ≥44px |

DOM 断言（拍摄前回读，存 `/tmp/kore-mon/shots.json` 已随实例删除，关键值抄录于上表）：`chart.polylines=3 / points=4`、`alerts=[{critical:false, text:警告 · CPU99.4%…}]`、`proc_rows=10`、`page_errors_total=0`、`console_errors_total=5`（favicon 404 + 首帧 401 + 隔离实例未装 site/ssl/discover 的概览探测 404，均为预期）。

**数据怎么来的（无编造）**：历史点由插件按 `interval_s=60` 自然累积（截图前后台每 62s 调一次 `monitor.system` 暖到 4 点）；阈值行是**真压出来的**——22 个 `yes` 进程把 24 核打到 96.69%，前端按固定 `THRESHOLDS={90,90,90}` 调用即命中，拍完立刻按 PID `kill` 回收；Top10 来自 `monitor.processes {limit:10, sort:cpu}` 的真实采样（首行 dsh-desktop-nex 149.2%、`yes` 77.7%×…）。

## 2. 产品定位自评（G-28 三问）

**① 本页解决什么问题**：系统出问题时最怕「只看得到现在」——CPU 刚才飙过没有、磁盘是慢慢涨还是一夜爆满，没有曲线就只能靠猜。本页把最近一段的 CPU/内存/磁盘走势画成一条 SVG 曲线（随每次刷新累积、不额外造方法），超阈值的项直接在告警行里用人话写清「超了多少、下一步查哪个进程」，再配 Top10 直接给出嫌疑人，三步内从「发现异常」到「定位到进程」。

**② 与宝塔/1Panel 的差距**：它们有长期历史库（Grafana 级别的天/周粒度、可回放）、告警可配阈值并推送到微信/邮件、还能按容器维度拆分。本页历史只随插件进程内存滚动（容量 60 点 × 60s ≈ 1 小时，重启即清零），**阈值是前端写死的 90%、无持久化配置、无通知渠道**，也没有天/周视图。做到位的是「零配置就有曲线和告警行」，缺的是「存得住、喊得出」。

**③ 当前是「可用」还是「占位」**：**可用（非占位）**——曲线/告警/Top10 全是真数据真渲染，双端截图 + Runtime 异常 0；但按上面的差距，它是「够用的值班一眼看」而非「可追溯的监控系统」。如实声明的两条实现边界（lead 指定）：**历史曲线读的是 `monitor.system` 返回的 `history` 字段，没有独立的 history 方法**；**阈值随每次调用下发（前端常量 `THRESHOLDS`），无服务端持久化配置**，改阈值要改前端代码。

## 3. G-29 / 提交

**本轮未改动主实例运行态配置**（`.kore-local.yaml`/`.kore-local-state`/`.kore-local-run` 零写入，8787 仅 `ss` 只读探测）；隔离实例 `/tmp/kore-mon` 验证完即删。索引为已验签 `kore-plugins/index`，本地包 sha 与索引一致走离线 `package_path` 安装，未开 `allow_unsigned`。提交：`docs(verify): monitor 历史曲线 G-28 双端截图`（本报告 + 2 张截图，不 push、不碰任何代码）。
