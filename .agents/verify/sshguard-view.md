> 元信息: 2026-11-23T21:05+08:00 · 执行者 kore-impl-waf · 对象 `web/sshguard.js`（提交 a35097c，第 20 个懒加载视图）· 隔离实例 `/tmp/kore-sgv`（端口 **18892**）· 真机 chromium-1248 CDP · 报告 ≤70 行

# SSH 防护视图 G-28 双端证据

## 0. 结论

页面在真机渲染正常，**推断态与只读态都截到了**：状态卡显示「只读模式 · 防护源：仅 sshd 日志（无自动封禁）」，
fail2ban 未安装、当前封禁 0、24 小时失败 27 次；暴力破解统计给出 Top IP（14 / 9 / 4 次，占比 52% / 33% / 15%）+ 一句判读 + 自研 SVG 小时柱；
封禁名单是**日志推断的可疑 IP**，黄底卡明写「这些 IP 并没有被真正封禁」、3 个解封按钮全部禁用、手动封禁整区禁用并说明缺什么。
手机端 12 个可交互元素全部 ≥44px、无横向溢出。
**边界（必须一起读）**：本机没有 fail2ban、kored 以普通用户运行、也没有提权通道 → **封禁写路径未做真机验证**；
`ban.add` 的一次性令牌流程只验证到「GET 令牌 200 → ban.add 被 403 `E_NEED_ROOT` 拒绝」，没有真的封过任何 IP。

## 1. 隔离实例与数据（G-29 声明）

- 独立 `--config /tmp/kore-sgv/config.yaml`，state/run/log 全在 `/tmp/kore-sgv/`，端口 18892（18882–18891 已用过）。
- 装本地 `ssh-guard-0.2.3.tar.gz`（sha256 `50a4035ce1511da3…` 与已签索引同值，离线）。**不是 0.3.0**：索引只收录到 0.2.3，0.3.0 未发版/未进已签索引，离线安装会验签失败；0.2.3 已含 `status/attempts/bans/ban.add/ban.remove` 全套，视图与它对齐。
- 攻击数据用插件自己的 `config.set` 指到一个 `/tmp` 内的 sshd 日志**夹具**（`log_path=/tmp/kore-sgv/auth.log`，`suspicious_threshold=2`），不是伪造接口返回：
  27 条失败记录集中在 3 个 IP（203.0.113.7×14、198.51.100.23×9、192.0.2.55×4）。
- **主实例 8787 零写入**：本轮未改 `.kore-local.yaml` / 主 state / 主 run，未重启主实例；所有操作在 18892。

## 2. 真实 API 行为（截图即此状态）

| 调用 | 结果 |
| --- | --- |
| `status` | `protection{fail2ban_installed:false, fail2ban_active:false, engine:"sshd", log_source:"auth"}` + note（读不到 sshd_config，需注入文本） |
| `attempts` | `failed:27, unique_ips:3, top_ips:[{ip:203.0.113.7,failed:14},{198.51.100.23,9},{192.0.2.55,4}], timeline_hourly` 19 桶 |
| `bans` | `count:3, source:"auth"`，3 条原因「近 1 小时内失败 N 次 ≥ 阈值 2（从 sshd 日志推断）」——**不是真封禁** |
| `GET …/root-action/fail2ban-banip/confirm-token` | **200**，返回 `{token, plugin_id, action_id, expires_at}`（令牌流程通） |
| `ban.add {ip,confirm}`（带令牌） | **403 `E_NEED_ROOT`**：「内核未注入 root-action 通道，未执行任何命令」 |
| `ban.remove` | 未调用（没有真封禁可解） |

## 3. 截图（`file` 实测宽高）

| 文件 | 实际宽高 | sha256 前 16 | 画面 |
| --- | --- | --- | --- |
| `sshguard-view-desktop-01.png` | **1440 x 1765**（full-page） | `8271f29a8d69959e` | 全页：状态卡（只读模式 / fail2ban 未安装 / 日志来源 auth / 当前封禁 0 / 24h 失败 27）+ 统计（Top IP 14/9/4 带占比条 + 判读「失败分散在 3 个 IP：量不大，先观察」+ SVG 小时柱）+ 封禁名单（3 条推断 IP）+ 手动封禁（禁用） |
| `sshguard-view-desktop-02.png` | **1440 x 900**（视口，定位到名单区） | `48d9665a4a7f3f65` | **推断态特写**：黄底「下面是『可疑 IP』而不是封禁名单」「这些 IP 并没有被真正封禁」、3 个「解封」按钮灰掉、手封区「封禁这个 IP」灰掉并写明需要 fail2ban + root |
| `sshguard-view-mobile-01.png` | **390 x 844 视口 / 390 x 3184 full-page** | `ab59186655276799` | 手机端：`plugin-table` 逐行转卡片（data-label 复原列名）、12/12 可交互元素 ≥44px、`scrollWidth == innerWidth` |

> 截图方法：chromium-1248 headless + 手写 CDP（`Emulation.setDeviceMetricsOverride` + `captureBeyondViewport`）；cookie 由 curl 登录后注入（一次性随机口令，仅 `/tmp` 0600，已随目录删除）。
> 手机图里底部 tab 条出现在页面中部，是固定底栏在 full-page 抓帧中的位置（视口底 844px），不是布局错误。

## 4. 产品定位自评（G-28 三问）

**① 本页解决什么用户问题**：面对「有人在爆破 SSH」时，运维要在两个动作间快速判断——**先看**（有多少失败、来自几个 IP、是不是集中在一个来源、是不是分布式撞库）和**再动**（封掉它）。
本页把 `attempts` 的聚合结果翻成一句人话判读，并在没有 fail2ban 时老实说「这些只是可疑 IP，没真封」，避免用户以为已经防住了。

**② 与宝塔 / 1Panel 同类功能差距**：它们通常把「fail2ban 安装配置 + 封禁时长 + 白名单 + 通知」做成一整套，有的还给按小时的攻击曲线和地图。
本页只有：状态探测、Top IP 聚合与判读、真实封禁名单（fail2ban 在运行时）、手动封禁/解封、自研 SVG 小时柱；
没有：封禁时长策略（后端就没有该参数）、IP 白名单、邮件/短信通知、攻击地图、按服务区分 jail。差距主要在「策略编排」，不在可见性。

**③ 当前是「可用」还是「占位」**：**半可用**。只读侧真机可用（真实日志 → 聚合 → 判读 → 推断名单，全部有数据）；写侧**未验证**——
本机无 fail2ban、无 root 提权通道，`ban.add` 只走到「令牌拿到、执行被 `E_NEED_ROOT` 拒绝」。页面的只读降级是真实的，不是占位；
但「点一下真的封掉一个 IP」这件事没有证据。

## 5. 清理与门禁

```
$ curl -s 127.0.0.1:18892/-/healthz           # 截图时 → {"status":"ok"}
$ kill <kored pid>; rm -rf /tmp/kore-sgv
$ ss -ltn | grep 18892                         # 收尾后 → 无输出
```

- 视图侧本轮还修了一个实测 bug：`attempts.top_ips` 的真实字段是 `{ip,failed,success,total}`，首版误用 `address/count`，导致表格出现 `undefined` 与 `NaN%`（截图第一轮抓到），已按侦察笔记改回 `ip/failed` 并重拍。
- 门禁：`node --check web/sshguard.js` **0**；`make frontend` **0**（35 文件 / 20 视图模块，首屏 gzip **60,866 B ≤ 307,200 B**）；`make build` **0**。
- 未验证项：真实 fail2ban 下的封禁/解封与回读确认（需要宿主装 fail2ban 并以 root 起 kored）；`ban.add` 成功路径的 `verified` 字段表现。
