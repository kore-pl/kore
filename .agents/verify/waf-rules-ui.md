> 元信息: 2026-11-23T21:30+08:00 · 执行者 kore-impl-waf · 对象 `web/waf.js` · 隔离实例 `/tmp/kore-wafr`（端口 **18889**，root kored）· 真机 chromium-1248 CDP · 报告 ≤80 行

# waf 规则 CRUD 的 UI 闭环核对 + G-28 双端证据

## 0. 结论（先给结论，再说缺口）

**① 现状核对**：`grep -n "rule.add\|rule.remove\|rule.toggle\|builtin" web/waf.js` 改动前**零命中**——规则区只有只读 nft 表（# / 规则内容 / 动作 / 命中包数 / 字节数），没有任何增删/启停入口。**UI 未闭环，本轮补齐。**
**② 本轮新增**（只改 `web/waf.js`，后端一行未动）：
- 规则表优先渲染 `waf.rules.chain[]`：规则名 / 匹配条件 / 动作 / **类型徽标（内置 / 自定义）** / 状态 / 操作；
  内置行**只有「停用/启用」**，删除按钮 `disabled` + `title="内置规则只能停用不能删除"`；自定义行可删可启停。
- 「新增规则」面板：**匹配器下拉**（6 项：`ip saddr` / `ip6 saddr` / `tcp dport` / `udp dport` / `ct state` / `tcp flags syn`）、
  值输入框按匹配器给提示（IPv4/CIDR、IPv6/CIDR、端口列表、state 枚举、`tcp flags syn` 自动禁用值输入）、**动作只有 drop/accept**；
  没有任何「自定义表达式」输入框。前端先校验规则名与必填值，再调 `waf.rule.add {name, expr, action}`。
- 错误翻人话：白名单外 → 「这个匹配条件暂不支持…可用的是 6 种」；内置删除 → 「内置规则只能停用不能删除」；
  `E_INVALID` → 原样给出后端原因；其余走既有 `failureText`。
- 无 root 通道时整块表单与行内操作禁用并说明（与状态卡的限权口径一致）。

**③ 但截图只拿到一部分**：隔离实例里后端 `waf.rules.chain` **恒为空**（见 §3），所以「内置+自定义混合列表」「内置删除被禁」这两种依赖 chain 渲染的画面**没能截到**；
现在截到的是「规则回退表（6 条）+ 新增规则表单（下拉）」与手机端。**不把回退表说成混合列表。**

## 1. 真实契约（按代码核对，未假装）

| 方法 | 入参 | 关键约束 |
| --- | --- | --- |
| `waf.rules` | `{}` | 额外返回 `chain[]{name,expr,action,enabled,builtin,handle}`（`internal/wafop/types.go:150`） |
| `waf.rule.add` | `{name, expr, action}` | `expr` 必须命中 `CompileRuleExpr` 白名单（`ruleadmin.go:102`）；`action` 只 drop/accept；内置名重复 → E_INVALID |
| `waf.rule.remove` | `{name}` | 内置规则 → **E_INVALID「内置规则只能停用不能删除」**（`rulecalls.go:107`） |
| `waf.rule.toggle` | `{name, enabled}` | 内置走 `toggleBuiltin`；自定义 enable 需本进程 registry 里有该规则（`rulecalls.go:89`） |

## 2. 实测（root 隔离实例 18889，waf **0.4.1**）

装的是 **0.4.1**（已签索引收录 `201635abc29baaaa…`；0.4.2 尚未进索引，离线装会验签失败）。0.4.1 已含 rule.add/remove/toggle。

| 调用 | 结果 |
| --- | --- |
| `waf.toggle {mode:enforce}` | 200，`applied=true, verified=true`，下发 4 条内置规则（nft 表真实存在） |
| `waf.rule.add {name:allow-office, expr:"tcp dport 8443", action:"accept"}` | **502 `E_UPSTREAM`：写后回读不到规则 allow-office；已回滚该规则** |
| `waf.rule.remove {name:ban-ipv4}`（内置） | **400 `E_INVALID`：内置规则只能停用不能删除：ban-ipv4（用 rule.toggle enabled=false）** |
| `waf.rules` | 200，`nft.rules` 6 条，但 **`chain` 长度 0** |

## 3. 阻断点（必须上报，不能算 UI 通过）

`chain` 恒空 + `rule.add` 报「写后回读不到规则」指向同一处：**插件对 `nft -j list chain` 的 comment 解析在本机 nft 1.1.6 上没匹配上**——
宿主 `nft list chain inet kore_waf input` 明明有 6 条（含我插入的 `comment "kore-rule-allow-office"`），插件回读却认为一条都没有。
后果：
1. `rule.add` 永远走到「回读失败 → 回滚」，**新增规则功能在 0.4.1 + nft 1.1.6 上不可用**；
2. UI 的 chain 渲染分支（内置/自定义徽标、内置删除禁用）拿不到数据，只能回退成只读表。
这是**后端问题（`internal/wafop/ruleadmin.go` 的 nft JSON 解析），不是 UI 问题**；建议在 waf 仓修好后重跑本卡截图（届时 chain 才有数据）。

## 4. 截图（`file` 实测宽高）

| 文件 | 实际宽高 | sha256 前 16 | 画面 |
| --- | --- | --- | --- |
| `waf-rules-desktop-01.png` | **1440 x 2080**（full-page） | `77da51b467f7ee00` | 状态卡（直接拦截 / 封禁 2 / 规则 6）+ **防护规则回退表（6 条：4 内置 + 2 条 tcp dport 8443 → accept）** + **新增规则表单（匹配器下拉、值提示、动作 drop/accept）** + 拦截日志空态 |
| `waf-rules-desktop-02.png` | **1440 x 900**（视口特写） | `6ec7cdd8b0c39f13` | 规则表 + 新增规则表单特写：下拉显示「来源 IPv4（ip saddr）」、值提示「IPv4 或网段，如 203.0.113.7 / 203.0.113.0/24」、动作「拦截（drop）」 |
| `waf-rules-mobile-01.png` | **390 x 844 视口 / 390 x 3785 full-page** | `cf1de77e267096d1` | 手机端：`plugin-table` 转卡片、15/15 可交互元素 ≥44px、无横向溢出 |

> 图形口径：本页无图表；未引入任何第三方图表库（ADR-0027 口径为工程判据）。
> 隔离实例：独立 config/state/run/log 全在 `/tmp/kore-wafr`，root transient unit 起服并 `chmod 0666` 内核 socket（降权插件连不上 socket 的已知问题，契据 R5-2 视图收口记录）。

## 5. 产品定位自评（G-28 三问）

**① 本页解决什么用户问题**：原先「规则」只是看的——要加一条「只放行 8443」或临时停掉 SYN 限速，必须 SSH 上去敲 nft。补齐后：内置规则一键停用/启用（不乱删），自定义规则用下拉+值提示直接加，删错可删；错误码翻成「这个匹配条件暂不支持，可用的是…」。
**② 与宝塔 / 1Panel 差距**：它们给的是「规则编辑器 + 命中报表 + 按站点开关」。本页只有受控匹配器 + 动作 + 启停/删除，没有自由表达式（后端也不收）、没有命中趋势图、没有按站点维度；但内置/自定义区分、只可停用的保护、白名单下拉，已经覆盖日常「加一条放行/封一条 IP 段」。
**③ 可用还是占位**：**UI 侧可用（代码已闭环），但后端在 0.4.1 + nft 1.1.6 上 `chain` 回读为空 → 新增规则实际不可用**。所以本页当前是「半可用」：内置规则启停/删除保护逻辑正确但拿不到数据、新增表单正确但提交必失败（502 回滚）。修好后端解析即可闭环。

## 6. 门禁

`node --check web/waf.js` **0**；`make frontend` **0**（35 文件 / 20 视图，首屏 gzip **60,926 ≤ 307,200 B**）；`make build` **0**。
