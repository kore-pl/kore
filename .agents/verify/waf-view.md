> 元信息: 2026-11-23T17:00+08:00 · 执行者 kore-impl-waf（implementer）· 主壳第 18 个视图 `web/waf.js`（约 640 行，含运行期注入样式）· 隔离实例 `/tmp/kore-wafv`（18875 非 root + 18877 未用）与 `/tmp/kore-wafv/state2`（18876 未装插件）· 宿主动过 `table inet kore_waf`（已删除并逐字复核）· 真机 chromium-1248 CDP 双端截图 · 报告 ≤110 行

# WAF 视图收口验收（构建 + 隔离实例真机 + G-28 双端截图）

## 0. 结论

四处接线一致；`make frontend` / `make build` / `go vet` / `go test` / `make check` 全绿；
隔离实例真机跑通「低权插件 → root-action 通道 → nft」全链路（封禁 2 条 + 4 条防护规则 + observe/enforce 双向切换 + 回读校验），
四张桌面 + 一张手机截图全部来自真实数据，`available=false` / 无 root / 插件未装三种降级都给了「怎么办」。
**挖出 2 个 P0 级集成缺口**（见 §5）并如实记录；前端自身修了 3 个实测缺陷（见 §6）。

## 1. 接线核对（四处一致 + 服务端交叉验证）

| 处 | 改动 | 复核证据 |
| --- | --- | --- |
| `web/shell.js` | `ICONS.waf`（盾牌 + 三道筛条）、平台组 ids 加 `waf`、`hasWaf` 探测 + 兜底 `lazyView('KoreWaf','/assets/waf.js','nav.waf','Web 防火墙')` | `git diff web/shell.js` 只有这 6 处；`grep -c KoreWaf web/dist/shell.js` = 1；截图左栏「平台 · Web 防火墙」高亮 |
| `web/embed.go` | 注释「三十三个文件」+ 精确路径清单 + `//go:embed … dist/waf.js …` | `grep -c "dist/waf.js" web/embed.go` = 2（清单 + embed 行）；`make build` 通过即证明 dist 存在 |
| `Makefile` | `WEB_SRC_FILES` 加 `waf.js`；注释与 echo 32→33 文件、17→18 视图 | `make frontend` 输出「33 文件…18 视图模块」 |
| `web/i18n/*.js` | `nav.waf`：`Web 防火墙` / `Web Firewall` | `grep -c nav.waf web/dist/i18n-*.js` = 1 / 1 |
| 服务端 | 隔离实例 `GET /assets/waf.js` | HTTP 200（页面真的从二进制里取到模块） |

## 2. 8 个方法与 UI 落点

| 方法 | 页面位置 | 行为 |
| --- | --- | --- |
| `waf.status` | 面板「运行状态」 | 引擎平面（引擎/版本/规则数）+ 数据面（模式/封禁数/规则数/表·链）；进页自动查，无数据前不画假 0 |
| `waf.toggle` | 面板「防护模式」三张卡 | 只记录不拦截 / 直接拦截 / 关闭防护；关闭必须二次确认（`confirm:true`）；结果按 `applied`+`verified` 两字段如实显示 |
| `waf.bans` | 面板「封禁名单」 | 表格：IP / 所属集合（IPv4·IPv6 封禁）/ 剩余时间（天/小时/分钟，永久单列）/ 行内「解封」 |
| `waf.ban` | 面板「添加封禁」 | IP + 时长预设（1 小时/1 天/7 天/永久）+ 原因（≤200 字符，前端先查格式，不合法不发请求） |
| `waf.unban` | 封禁行内按钮 | 二次确认由后端幂等保证（`removed=false` 也当成功）；成功后刷新名单/状态/规则 |
| `waf.rules` | 面板「防护规则（只读）」 | 中文用途（封禁名单 IPv4/IPv6 / 扫描限速 / 并发上限）+ 原 nft 表达式 + 动作 + 命中包数/字节数 |
| `waf.logs` | 面板「最近拦截记录」 | 时间 / 来源 IP / 请求路径 / 命中规则 / 结果；无日志时说明「装好引擎后这里会显示」 |
| `waf.config.get/set` | 「插件设置」按钮 | 走内核通用配置面板（`KoreShell.openConfig`），保存后自动刷新本页 |

调用形态全部是 `POST /api/v1/invoke/waf/waf.<action>`（带域前缀，docs/FRONTEND §业务方法调用形态），CSRF 走 `kore_csrf` 双提交头。

## 3. 降级 UI（三态，全部真机截图）

| 状态 | 触发 | 页面表现 |
| --- | --- | --- |
| 引擎未装（`available=false` + `E_UNSUPPORTED`） | 本机无 modsecurity/naxsi/coraza/crowdsec | 黄底卡「HTTP 层规则没有引擎在管（**不影响 IP 封禁**）」+ 为什么 + 两条安装命令；后端长 hint 折叠进「查看后端原始提示」 |
| 无 root / 无提权通道（`backend.reason` 含 `E_NEED_ROOT`） | kored 以普通用户启动 | 第二张黄底卡「这一步需要 root 权限…」+ 折叠的 `sudo systemctl restart kore` + RUNBOOK 链接；**三张模式卡与封禁表单整体禁用**，表单下方写明「按状态卡片里的说明重启后即可编辑」 |
| 插件未安装（`E_NOTFOUND`） | 全新实例 | 只留一张「还没有安装 WAF 插件…」+「去软件商店安装」按钮（跳 `#/store`），其余五块面板整体隐藏——不铺 4 条相同 404 红条 |

写操作的权限门控不是猜的：`backend.reason` 出现 `E_NEED_ROOT`（或 `waf.bans` 返回该码）即锁定全部写入口，
避免「能填、点提交才报错」；锁定时按钮带 title 说明原因。

## 4. 隔离实例真机验证（G-29）

- **主实例 8787 零写入**：本轮对 8787 只做过一次只读 `GET /-/healthz`（返回 ok），未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`；全部验证在 `/tmp/kore-wafv`（独立 config + state/run/log）。
- **起两个实例**：18875（先用普通用户，后用 root transient unit `kore-wafv-root` 经 `sudo -n` 起服，验证低权插件走通道）、18876（全新 state，验证未安装空态）。两者 index 均指向 `kore-plugins/index`（验签通过）。
- **装插件（离线）**：`POST /store/install {"id":"waf","version":"0.3.1","package_path":"…/kore-plugin-waf/dist/waf-0.3.1.tar.gz"}` → `state:succeeded, reload:reloaded`（本地包 sha `fbaba380…f2b4` 与已签索引逐字一致，未联网）。
- **真数据**（全部来自本机真实 nft，无一处编造）：
  - `waf.status`：`backend.present=true, mode=enforce, banned_count=2, rules_count=4, table=kore_waf, chain=input`
  - `waf.toggle observe`：`applied=true, verified=true, rules=4, verdicts=[observe]`；`enforce`：同上、`verdicts=[drop]`
  - `waf.toggle off`（不带 confirm）：**`E_UNAUTHORIZED`** + hint「确认关闭请带 confirm=true」
  - `waf.ban 203.0.113.7 ttl=3600`：`banned=true, set=banned4`；`waf.ban 2001:db8::7`：`banned=true, set=banned6`；`waf.bans` = 2 条
  - 宿主 `nft list table inet kore_waf`：4 条 drop 规则（saddr @banned4 / @banned6 / SYN 限速 meter / `ct count over 200`）+ 两个集合的元素与超时
- **收尾**：`nft delete table inet kore_waf` exit 0、`userdel kore-waf` exit 0、`/tmp/kore-wafv` 整目录删除、18875/18876 无监听、无残留 kored。
- **宿主基线逐字复核**：`iptables -S` 前后 sha `d1d740e3…` 一致、`ufw status verbose` 前后 sha `1e37bdb1…` 一致（全程未执行任何 ufw 写命令）；
  `nft list ruleset` 把 `counter packets/bytes` 归一同值后，`during` vs `after` 的**唯一差异就是 kore_waf 表**（27 行，全在该表内）；
  `after` 里 `kore` 命中 0 次、`getent passwd | grep '^kore-'` = 0。

## 5. 挖出的两个 P0（降权支，需修）

1. **插件拿不到内核 socket**：kored 以 root 启动并对插件降权后，插件进程以 `kore-waf`(uid 994) 运行，
   但 `/tmp/kore-wafv/run/kore.sock` 是 `srw------- root root` → 插件调 root-action 直接
   `dial unix …: connect: permission denied`，整个提权通道对插件不可用。
   本轮在隔离实例 `chmod 0666` 才跑通「低权插件 → 通道 → nft」。**修法建议**：socket 设为 `0660 root:kore-<id>`（按插件 chown/chmod 或 ACL），
   或内核按 `SO_PEERCRED` 放行插件 uid（ADR-0018 的降权要求里应包含这条）。
2. **插件数据目录权限**：root kored 安装出的 `state/plugins/waf/0.3.1/info.json` 是 `root` 所有 `0600`，
   同一份 state 换普通用户 kored 启动就读不到（日志 `读取插件清单…permission denied` → 插件被判「未安装」）。
   本轮 `chmod -R a+rX` 作测试 workaround，正式修法应让插件目录属主为 `kore-<id>` 或 0644 可读。

> 这两条属于降权实现（`internal/core/supervisor/` + `internal/platform/`），不在本视图写域，仅报告事实与建议。

## 6. 前端自身修掉的实测缺陷

1. **模式按钮永久灰**：`setLocked()` 只改 `S.locked` 不重画模式卡，状态回来后表单解锁但三张模式卡仍 disabled（首轮截图抓到）。
   修：`setLocked()` 末尾重画 `paintModes()`。
2. **空态样式丢失**：`emptyBlock()` 里 `add(el('div','waf-empty'), span)` 返回的是**子节点**，容器没进 DOM → 空态没有卡片样式。
   修：先 createElement 再 append。
3. **未安装时四条 404 红条**：插件未装时 status/bans/rules/logs 各画一条错误 → 改成识别 `E_NOTFOUND` 后隐藏其余面板、只留一张「怎么装」。
另有：后端 hint 折叠成 `<details>`（否则状态卡被长安装说明撑满）、规则摘要前面加中文用途、`添加封禁` 的面板副标题缩短（390px 下不再把标题挤成两行）。

## 7. G-28 双端截图（`file` 实测宽高）

| 文件 | `file` 实际宽高 | sha256 前 16 | 证据点 |
| --- | --- | --- | --- |
| `waf-view-desktop-01.png` | **1440 x 1760**（full-page） | `1b35d974743593a3` | 真数据：封禁 2（IPv4 45 分钟后到期 / IPv6 永久）、4 条规则（中文用途 + nft 原文）、模式高亮「直接拦截」、引擎卡说明、左栏「平台 · Web 防火墙」高亮 |
| `waf-view-desktop-02.png` | **1440 x 900** | `ef50a61c4d4c6f33` | 「关闭防护」二次确认条：黄底说明 + 「确认关闭防护」/「取消」（未确认不会调后端） |
| `waf-view-desktop-03.png` | **1440 x 1578**（full-page） | `60c94a93aac65a8f` | 无 root 降级：两张黄底卡 + 模式卡/表单全部禁用 + 名单区一句「需要 root 权限…」 |
| `waf-view-desktop-04.png` | **1440 x 900** | `989fdafa820dbf5a` | 插件未装：单张空态卡 + 「去软件商店安装」，其余面板隐藏 |
| `waf-view-mobile-01.png` | **390 x 844 视口 / 390 x 3187 full-page** | `c8ef2560413d8ee5` | 卡片式表格（`data-label` 还原列名）、触摸目标 **12/12 ≥44px**、横向溢出 **0**、模式卡纵向堆叠、底部 tab 为固定元素（full-page 抓帧落在视口底，非布局错误） |

> 截图方法：chromium-1248 headless + 手写 CDP（`Emulation.setDeviceMetricsOverride` + `captureBeyondViewport`），与本仓近期报告同法；cookie 由 curl 登录后注入（口令为一次性随机值，只存 `/tmp` 0600 文件，已随目录删除，不落档）。
> 侧栏在 01/03/04 里滚到了当前项（否则 20 项导航的高亮落在折叠区外）；这是**截图取景**，不是页面自动滚动。

## 8. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/waf.js` | **0** | 无输出 |
| `make frontend` | **0** | 33 文件 / 18 视图模块；首屏 gzip **59,539 ≤ 307,200 B**；i18n 增量 **2,813 ≤ 3,072 B** |
| `make build` | **0** | `[OK] 构建完成: ./bin/kored` |
| `go vet ./...` | **0** | 无输出 |
| `go test -count=1 -timeout 200s ./...` | **0** | 15 个包全 ok |
| `make check` | **0** | 「门禁全部通过」 |
| `git diff web/shell.js` | — | 只有 `waf` 相关 6 处，无他人改动 |

## 9. 产品定位自评（G-28 三问原文）

**① 本页解决什么用户问题**：运维者最常遇到的两类「被打」——扫描器/暴力破解刷端口、某个 IP 疯狂建连——以前只能 SSH 上去敲 `nft`/`ufw` 手写规则，或者花钱买带 WAF 的面板。本页把两件事收进一个视图：**看一眼**（引擎有没有在管、有没有 IP 被封、规则命中多少包）和**动一下**（切观察/拦截、封一个 IP、解封）。关键取舍是把「引擎层（URL/参数规则）」与「网络层（IP 封禁/限速/并发）」分开讲清楚，避免用户以为「装了 WAF 插件就自动防 SQL 注入」——本页明确写出「需要 URL/参数拦截请另装 ModSecurity/Naxsi」并给安装命令。

**② 与宝塔/1Panel 同类功能的差距**：差距在「规则编排」而不是「可见性」。它们有：图形化 WAF 规则编辑（自定义 CC 防护阈值、UA/IP 黑白名单、URL 白名单、SQL/XSS 规则开关）、攻击报表与趋势图、CC 防护的按站点配置、与站点绑定的一键开关。本页只有：真实 nft 数据面的状态/模式/封禁/规则只读 + 封禁解封，**规则内容不可在前端编辑**（改规则要走 root_actions 声明，属插件发布范围）；没有攻击趋势图、没有按站点维度、没有 UA 规则（nft 解析不了 HTTP 头）。对齐的部分：真实后端（不是 mock）、模式可切且回读校验、封禁带时长预设、双端响应式——这四件是日常运维真正会点的。

**③ 当前是「可用」还是「占位」**：**可用（非占位）**。隔离实例里以真实数据跑通：插件 0.3.1 装好 → 通道下发 4 条规则 → 封禁 v4/v6 各一条 → observe/enforce 双向切换均 `applied+verified` → 关闭防护被后端 `E_UNAUTHORIZED` 拒绝（前端也强制二次确认）→ 宿主 nft 表内容逐条可见；三种降级态都在真机截图里。明确没做的是「规则编辑器」「攻击报表」「按站点维度」，属能力域边界而非半成品。

## 10. 已知缺口 / 未验证

1. **R5-2 报告的宿主基线口径已更正**（本批同步修）：上一份 `.agents/verify/r5-2-waf-nft.md` §6.3 里那三个 `nft/iptables/ufw` 基线 sha 实际是**权限错误文本的 sha**——当时的快照脚本缺 `sudo`，`nft list ruleset` 失败后把错误写进了文件。结论（netns 隔离、宿主未变）仍然成立，但基线数值无效；本次用 `sudo -n` 重新采集并对 `counter` 归一同值后复核，证据见 §4。
2. 未覆盖「引擎日志有真实拦截记录」的页面状态：本机没有任何 WAF 引擎，`waf.logs` 只能验证空态文案。
3. 未验证「同时有多个 IP 被封 + 长列表分页」：`waf.bans` 当前无分页（一次返回全部），页面按 1000 上限显示；列表很长时的滚动/性能未压测。
4. 未在 390px 宽度下验证「封禁原因」含超长文本的换行边界（输入限 200 字符，表格列会换行但未截图取证）。
