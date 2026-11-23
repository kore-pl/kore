# waf 0.4.3 真机 e2e 复测：rule.add 从恒失败到 200 + verified

- 里程碑 / 阶段：M4（插件成熟度 Round 5）
- 角色：verifier（独立于 implementer）
- 被测：`waf@0.4.3`（commit `259d8ad`，索引仓 `80e2611` 第 46 把已签）
- 环境：隔离实例 `/tmp/kore-wafe2e`，端口 `18873`，索引**只读指向** `/home/pt/Work/GolandProjects/kore-plugins/index`
- 结论：**核心断言（c）通过**——0.4.1 上必失败的 `waf.rule.add` 在 0.4.3 真机返回 200 + `applied:true` + 回读链含新规则；**断言（a）（d）不通过**，根因不在 0.4.3 修复的 parser，而在 `waf.rules` 的 `chain[]` 从未被填充（见 §5）。G-28 双端截图已出，但"内置徽标 + 内置行删除按钮 disabled"因同一根因**无法在 UI 上呈现**。

## 1. 六条断言结果

| # | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| a | `waf.rules` 的 `chain[]` 不再为空（4 条内置） | ❌ **FAIL** | 返回 `"chain":null`；等价数据在 `nft.rules[]`（4 条，`rules_count:4`） |
| b | `waf.toggle enforce` → 200 + applied/verified（4 条内置下发） | ✅ **PASS** | 200，`applied:true`，`verified:true`，4 条规则，5 个 root-action 步骤全 `exit_code:0` |
| c | `waf.rule.add {allow-office, tcp dport 8443, accept}` → 200 + applied + verified | ✅ **PASS（本卡核心）** | 200，`applied:true`，`handle:11`，回读 chain 含 5 条 |
| d | 再 `waf.rules` → `chain[]` 含 4 内置 + 1 自定义，自定义 `builtin=false` | ❌ **FAIL**（按字面） | `chain:null`；`nft.rules[]` 有 5 条（含 `tcp dport == 8443 → accept`），但无 `builtin` 字段；`builtin` 标记只在 `rule.add/remove` 的 `chain[]` 里可见 |
| e | `waf.rule.remove {allow-office}` → 成功 | ✅ **PASS** | 200，`applied:true`，`op:"remove"`，回读 chain 只剩 4 条内置 |
| f | `waf.rule.remove {ban-ipv4}`（内置）→ 400 `E_INVALID` 且 message 含「内置规则只能停用不能删除」 | ✅ **PASS** | 400，`{"code":"E_INVALID","message":"内置规则只能停用不能删除：ban-ipv4（用 rule.toggle enabled=false）"}` |

计：**4 PASS / 2 FAIL**。核心缺陷（rule.add 恒失败）已真机证明修复；(a)(d) 是**另一处未修的契约缺口**，不是 0.4.3 修复失效。

## 2. 环境与前置证据

```text
# 端口空闲
$ ss -ltn | grep 18873
（仅 8787 在监听，18873 无输出）
exit=0

# 隔离配置（全落 /tmp，索引只读）
server.addr = 127.0.0.1:18873
paths.state_dir = /tmp/kore-wafe2e/state
paths.run_dir   = /tmp/kore-wafe2e/run
paths.log_dir   = /tmp/kore-wafe2e/log
paths.index_dir = /home/pt/Work/GolandProjects/kore-plugins/index

# 造口令
$ ./bin/kored admin-password --generate --config /tmp/kore-wafe2e/config.yaml
exit=0
管理员口令（只显示这一次，请立即保存）：<REDACTED>
已将口令哈希写入 /tmp/kore-wafe2e/config.yaml（权限 0600）

# 登录
$ curl -s -c cookie.txt -D headers.txt -X POST .../api/v1/auth/login --data @login.json   # 口令只走 stdin 变量，不落文件
status=200
{"authenticated":true,"expires_at":"2026-11-24T01:41:46Z"}
Set-Cookie: kore_session=<REDACTED>; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict
Set-Cookie: kore_csrf=<REDACTED>; Path=/; Max-Age=43200; SameSite=Strict
```

### 2.1 从商店装 waf 0.4.3（真实 download_url + 验签 + 解包 + 登记）

```text
$ curl -b cookie.txt -X POST .../api/v1/store/install \
    -H 'Content-Type: application/json' -H "X-Kore-CSRF: $CSRF" \
    --data '{"id":"waf","version":"0.4.3","download":true}'
status=200 time=2.065550
{"id":"waf-0.4.3","plugin_id":"waf","version":"0.4.3","state":"succeeded","message":"安装完成","reload":"reloaded"}
```

索引条目（`kore-plugins/index/plugins.json`）：`id=waf version=0.4.3 sha256=b9ac6ff1…2506 download_url=https://github.com/kore-pl/kore-plugin-waf/releases/download/v0.4.3/waf-0.4.3.tar.gz requires_kore=">=0.1.0 <0.2.0"`。
装完 `enable` 返回 200，`version:"0.4.3"`，`requires_root:true`，`granted_capabilities:["system:read","system:admin"]`。

### 2.2 root 通道

- 首次以普通用户（uid 1000）起 kored：`waf.toggle` 返回 403 `E_NEED_ROOT`（插件侧 root-action client 未装配）。
- 本沙箱内 `sudo` 被 `no_new_privs` 拒绝，但 transient unit 可用：
  `systemd-run --uid=0 --collect --wait /usr/sbin/nft list tables` → exit 0，能列出宿主表。
- 因此按仓库既有 root-action 通道，用 `systemd-run --unit=kore-wafe2e-root --collect --uid=0` 起隔离 kored（**未改主实例**），之后 `waf.status.backend={tool:"nft",available:true,channel:true,present:true,mode:"enforce"}`。
- `info.json.root_actions` 14 项，本次用到 `nft-init-table` / `nft-init-set4` / `nft-init-set6` / `nft-init-chain` / `nft-mode-enforce` / `nft-list` / `nft-add-rule` / `nft-delete-rule`。

## 3. 断言原文

### b) `waf.toggle {"mode":"enforce"}` → 200

```json
{"mode":"enforce","previous_mode":"off","applied":true,"verified":true,
 "rules":[
  {"handle":4,"summary":"ip saddr == @banned4 → counter → drop","verdict":"drop","packets":0,"bytes":0,"has_counter":true},
  {"handle":5,"summary":"ip6 saddr == @banned6 → counter → drop","verdict":"drop","packets":0,"bytes":0,"has_counter":true},
  {"handle":8,"summary":"tcp flags in syn → tcp dport == {80, 443} → @kore_syn4 limit over 60/second burst 120 → counter → drop","verdict":"drop","packets":0,"bytes":0,"has_counter":true},
  {"handle":10,"summary":"tcp dport == {80, 443} → ct count over 200 → counter → drop","verdict":"drop","packets":0,"bytes":0,"has_counter":true}],
 "steps":[
  {"action":"nft-init-table","exit_code":0,"ok":true},
  {"action":"nft-init-set4","exit_code":0,"ok":true},
  {"action":"nft-init-set6","exit_code":0,"ok":true},
  {"action":"nft-init-chain","exit_code":0,"ok":true},
  {"action":"nft-mode-enforce","exit_code":0,"ok":true}]}
```

### c) `waf.rule.add {"name":"allow-office","expr":"tcp dport 8443","action":"accept"}` → 200（本卡核心）

```json
{"applied":true,"dry_run":false,"op":"add",
 "rule":{"name":"allow-office","expr":"tcp dport 8443","action":"accept","enabled":true,"builtin":false,"handle":11},
 "chain":[
  {"name":"ban-ipv4","expr":"ip saddr @banned4","action":"drop","enabled":true,"builtin":true,"handle":4},
  {"name":"ban-ipv6","expr":"ip6 saddr @banned6","action":"drop","enabled":true,"builtin":true,"handle":5},
  {"name":"syn-rate","expr":"tcp flags syn tcp dport { 80, 443 } meter kore_syn4","action":"observe","enabled":true,"builtin":true,"handle":8},
  {"name":"conn-rate","expr":"tcp dport { 80, 443 } ct count over 200","action":"observe","enabled":true,"builtin":true,"handle":10},
  {"name":"allow-office","expr":"","action":"accept","enabled":true,"builtin":false,"handle":11}]}
```

对照 0.4.1 的行为：`rule.add` 写入后回读不到规则 → 回滚 → 502 `E_UPSTREAM`，`waf.rules.chain` 长度恒 0。**本次真机 200 + `applied:true` + 回读链含 handle 11，缺陷已修**。

### d) `waf.rules`（混合态）

```json
{"engine":"none","available":false,"error_code":"E_UNSUPPORTED",
 "hint":"未检测到 WAF 引擎。…IP 封禁与基础防护走 kore 自有 nft 数据面（backend），不依赖该引擎",
 "rulesets":[],"total":0,
 "nft":{"table":"kore_waf","chain":"input","present":true,"mode":"enforce","rules_count":5,
  "rules":[
   {"handle":4,"summary":"ip saddr == @banned4 → counter → drop","verdict":"drop"},
   {"handle":5,"summary":"ip6 saddr == @banned6 → counter → drop","verdict":"drop"},
   {"handle":8,"summary":"tcp flags in syn → … → drop","verdict":"drop"},
   {"handle":10,"summary":"tcp dport == {80, 443} → ct count over 200 → counter → drop","verdict":"drop"},
   {"handle":11,"summary":"tcp dport == 8443 → accept","verdict":"accept"}],
  "bans_count":0,"bans":[]},
 "chain":null}
```

数据面确实是「4 内置 + 1 自定义」，但 `chain` 为 `null`（见 §5 根因），`builtin` 标记缺席。

### e) `waf.rule.remove {"name":"allow-office"}` → 200

```json
{"applied":true,"dry_run":false,"op":"remove",
 "rule":{"name":"allow-office","expr":"tcp dport 8443","action":"accept","enabled":false,"builtin":false},
 "chain":[4 条内置，省略]}
```

### f) `waf.rule.remove {"name":"ban-ipv4"}`（内置）→ 400

```json
{"code":"E_INVALID","message":"内置规则只能停用不能删除：ban-ipv4（用 rule.toggle enabled=false）","detail":""}
```

## 4. G-28 双端截图（`file` 实测宽高）

| 截图 | 场景 | 实测 |
| --- | --- | --- |
| `screenshots/waf-rules-desktop-01.png` | Web 防火墙视图 · 规则列表（4 内置 + 1 自定义混合，full-page） | PNG 1440 × 2024 |
| `screenshots/waf-rules-desktop-02.png` | 新增规则表单（匹配器下拉 6 项） | PNG 1440 × 2024 |
| `screenshots/waf-rules-mobile-01.png` | 同上规则列表（390 宽 full-page） | PNG 390 × 3607 |
| `screenshots/waf-rules-mobile-02.png` | 同上新增规则表单 | PNG 390 × 3651 |

采集方式：Playwright 1.65.1 + `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（显式 `executablePath`），PC `1440×900`、手机 `390×844`，均为 `fullPage:true`。DOM 侧同步核对：规则表 5 行（`#4 #5 #8 #10 #12`，末行 `tcp dport == 8443 → accept` / `放行`）；匹配器下拉 6 项 = `来源 IPv4（ip saddr）`、`来源 IPv6（ip6 saddr）`、`TCP 端口（tcp dport）`、`UDP 端口（udp dport）`、`连接状态（ct state）`、`SYN 扫描（tcp flags syn）`。

**产品定位自评（三问）**

1. 本页解决什么用户问题：让管理员在一个界面里看清 kore 自己的 nft 数据面（内置基础防护 + 自定义放行/拦截规则）并做启停与增删，不用记 nft 命令；引擎层（ModSecurity/Naxsi/Coraza/CrowdSec）的规则统计也在同页只读呈现。
2. 与宝塔 / 1Panel 同类功能的差距：宝塔/1Panel 的 WAF 侧重引擎规则库与站点级开关，本页强在**内核自带 nft 数据面**（不依赖宿主 web server）与 root-action 提权审计；差距是引擎规则库缺失时页面大片区域为空（本机 `engine=none`），且列表的"内置/自定义"类型列当前不可用（见 §5）。
3. 当前状态：**部分可用**——数据面下发/回读/删除保护在真机可用；规则列表因 `chain` 缺口只呈现降级样式（无类型徽标、无操作列），内置行"删除按钮 disabled"无法在该渲染下体现。

## 5. 发现（未改任何代码，仅报 file:line）

**P1 · `waf.rules.chain` 恒为 `null`，导致类型列/操作列整列缺失**

- `internal/wafop/types.go:151` 声明 `Chain []ChainRule \`json:"chain"\``（注释：「内置 4 条 + 自定义」）。
- `internal/wafop/rules.go:18-56` 的 `ListRules` 从头到尾**没有给 `Chain` 赋值**（`grep -rn '\.Chain =' internal/wafop/*.go` 仅命中 `rulecalls.go:284`，那是 `RuleChangeResult`）。
- 因此 `waf.rules` 永远返回 `"chain":null`；0.4.3 的链回读修复只在 `waf.rule.add` / `rule.remove` / `rule.toggle` 的结果里生效（`internal/wafop/rulecalls.go:284` + `internal/wafop/ruleadmin.go:230` 的 `nftChainRules`）。
- UI 侧后果：`web/waf.js:661` `S.chain = (data && data.chain) || []` → 空；`web/waf.js:532` 走 `S.rules`（= `nft.rules`）降级分支，该分支没有「类型」列也没有按钮列，`web/waf.js:544`（`chip(builtin ? '内置' : '自定义')`）与 `web/waf.js:552`（`db.disabled = !!r.builtin`）永不执行。
- 复现：任意 0.4.3 实例 `POST /api/v1/invoke/waf/waf.rules` → `chain:null`（本轮 3 次调用均为 `null`）。

**P3 · `rule.add` 回读链里自定义规则 `expr` 为空**

- `c)` 返回的 `chain[]` 中 `allow-office` 为 `"expr":""`（同响应 `rule.expr` 正确为 `tcp dport 8443`）。
- 位置：`internal/wafop/ruleadmin.go:230-330`（`nftChainRules` 解析/回填表达式处）——自定义规则无 comment 前缀时只能靠 token 反解，`accept` 动作的表达式未被还原。影响：若 UI 走 `chain[]` 渲染，"匹配条件"列对自定义规则会显示空。低优先级（当前 UI 走 `nft.rules.summary`，不受影响）。

**说明（非缺陷）**：本机 `engine=none`（无 modsecurity / naxsi / coraza / crowdsec），`waf.rules` 的 `available:false`、`rulesets:[]`、`total:0` 属降级预期；nft 数据面不受影响，故 b/c/e/f 全部可验。

## 6. 未验证项与原因

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 安装验签的**独立**复核（签名文件/公钥比对） | 未独立验证 | 走的是真实 `store/install` 链路且返回 `state:"succeeded"`（安装器内部验签，失败会非 0 且不登记），但本轮未单独抓验签日志/手工验签 |
| 索引「第 46 把、`80e2611`」的可信度 | 未独立复核 | 仅读 `index/plugins.json` 确认 `waf=0.4.3`；未跑签名校验脚本、未查索引仓 git 记录 |
| 主实例 8787 的商店版本对照 | 未验证 | `/api/v1/system/info`、`/api/v1/store/plugins` 均 401（未登录主实例）；按 G-29 只做只读核对（进程命令行 + 配置文件），未登录 |
| 「匹配器下拉 6 项」的展开态截图 | 未达成 | 原生 `<select>` 弹层不在页面渲染树内，CDP 截图取不到；改为截图表单 + DOM 读回 6 项文案（已列于 §4） |
| 内置行删除按钮 `disabled` 的可视证据 | **无法呈现** | 因 `chain:null` 走降级渲染，按钮列整体不存在（§5 P1），非风格问题 |
| 真实恶意流量命中计数 | 未验证 | 超出本卡范围（未构造攻击流量；`packets/bytes` 均为 0 仅代表无流量经过） |

## 7. G-29 声明

**本轮未改动主实例运行态配置。** 全程使用隔离实例（`/tmp/kore-wafe2e`，端口 18873，state/run/log 全落 `/tmp`），未修改 `.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、`bin/kored`；主实例进程 `2798902 /home/pt/Work/GolandProjects/kore/bin/kored serve --config …/.kore-local.yaml` 未重启，验收后仍监听 `127.0.0.1:8787`。

## 8. 清理记录

```text
$ systemctl stop kore-wafe2e-root      # transient unit 已停
$ ss -ltn | grep 18873 → 18873-FREE
$ nft delete table inet kore_waf        # root transient unit，exit 0
$ nft list tables | grep -ci kore → 0（no-kore-table）
$ userdel kore-waf                      # 删 kore-* 临时用户
$ getent passwd | grep '^kore-' → no-kore-user
$ rm -rf /tmp/kore-wafe2e               # root，exit 0
$ ls -d /tmp/kore-wafe2e → No such file or directory
$ systemctl list-units --all 'run-*kore*' | grep -c kore → 0
```

残留检查：`/tmp` 无隔离目录；宿主无 `kore_waf` 表、无 `kore-*` 用户、无 transient unit；主实例 8787 不受影响。
