# waf 0.4.4 真机 e2e：商店装 0.4.4 通过、`chain` 由 `null` 转 `[]`；UI 徽标/删除禁用**仍无法执行**（root 通道阻断）

- 里程碑 / 阶段：M4（插件成熟度 Round 5）
- 角色：verifier（独立于 implementer，本轮**未改任何代码**）
- 被测：`waf@0.4.4`（插件 commit `34bceef`；索引仓 `fbbec78` 第 47 把）
- 环境：隔离实例 `/tmp/kore-wafe2e044`，端口 `18874`，索引**只读指向** `/home/pt/Work/GolandProjects/kore-plugins/index`
- 结论：**安装链与 `chain` 契约修复通过**——真实 `download_url` 下载件 sha256 与索引一致、商店安装 200、enable 200、`waf.rules.chain` 由 0.4.3 的 `null` 变为 `[]`。但 **`chain[]` 非空 / 内置徽标 / 内置行删除按钮 disabled 三项均未达成**：本机 kored 以普通用户运行且 root-action 通道（`systemd-run --uid=0`）被 polkit 以"需要交互认证"拒绝，nft 数据面无法读写，`chain` 只能为空数组。按任务约束**不伪造**，以下逐项标注。

## 1. 断言结果

| # | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 从商店装 `waf 0.4.4`（真实 `download_url` + 验签）并 enable | ✅ **PASS** | 下载件 `artifact_sha256 == index sha256`（`9db9250…c405`）；`store/install` 200 `state:"succeeded"`；`enable` 200，`version:"0.4.4"`，`enabled:true` |
| 2 | `waf.rules.chain[]` **非空**，内置 4 条 `builtin=true` | ⛔ **BLOCKED（非 PASS）** | `chain` 实测 `[]`（len 0）；nft 后端 `present:false, channel:false`，原因「缺少 root-action 通道，无法读写规则」。相对 0.4.3 的 `null`，**空值契约已修**（`[]` 而非 `null`），但**非空内容未验证** |
| 3 | 自定义规则 → `builtin=false` + `expr` 非空 | ⛔ **BLOCKED** | 依赖断言 2 的 root 通道；`waf.toggle` 已先行 403 `E_NEED_ROOT` |
| 4 | UI：内置徽标渲染 + 内置行删除按钮 `disabled` | ⛔ **未执行（渲染分支不可达）** | 因 `chain:[]`，`web/waf.js:532` 走空态分支：DOM 实测 `tables:0 / chipCount:0 / deleteButtons:0 / emptyState:true`；`web/waf.js:544`（内置徽标）与 `:552`（`db.disabled = !!r.builtin`）**仍未执行** |
| 5 | 双端截图（PC 1440×900 + 手机 390×844，`file` 复核） | ✅ **PASS** | `waf044-rules-desktop-01.png` PNG **1440 × 1866**；`waf044-rules-mobile-01.png` PNG **390 × 2798** |

计：**2 PASS / 2 BLOCKED / 1 未执行**。核心 UI 断言本轮**没有**拿到正向证据。

## 2. 环境与前置

```text
# 端口先确认空闲（仅 8787 在听）
$ ss -ltn | grep ':18874 '      → 无输出（PORT 18874 FREE）

# 隔离配置（全落 /tmp，索引只读）
server.addr      = 127.0.0.1:18874
paths.state_dir  = /tmp/kore-wafe2e044/state
paths.run_dir    = /tmp/kore-wafe2e044/run
paths.log_dir    = /tmp/kore-wafe2e044/log
paths.index_dir  = /home/pt/Work/GolandProjects/kore-plugins/index

# 口令
$ ./bin/kored admin-password --generate --config /tmp/kore-wafe2e044/config.yaml
exit=0  管理员口令（只显示这一次，请立即保存）：<REDACTED>

# 登录门：未登录一律 401，登录后才可打接口
$ curl -s -o /dev/null -w '%{http_code}' .../api/v1/system/info        → 401
$ curl -s -c cookie.txt -D headers.txt -X POST .../api/v1/auth/login \
       -H 'Content-Type: application/json' --data @login.json          → 200
{"authenticated":true,"expires_at":"2026-11-24T03:46:36Z"}
Set-Cookie: kore_session=<REDACTED>; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict
Set-Cookie: kore_csrf=<REDACTED>; Path=/; Max-Age=43200; SameSite=Strict
# 后续写请求均带 -b cookie.txt + -H "X-Kore-CSRF: $CSRF"（cookie 与头双提交）
```

实例启动方式：普通用户（uid 1000）`setsid nohup ./bin/kored serve --config /tmp/kore-wafe2e044/config.yaml`。
**root 通道尝试失败**（详见 §5），因此 nft 数据面不可用。

## 3. 商店安装 waf 0.4.4（真实下载 + 哈希独立复核）

索引条目（`kore-plugins/index/plugins.json:306-312`）：

```text
id=waf version=0.4.4 sha256=9db925059bd1fac3982c4e3a115ce646c4097c4f779d8f0e573a58e1fe3cc405
download_url=https://github.com/kore-pl/kore-plugin-waf/releases/download/v0.4.4/waf-0.4.4.tar.gz
requires_kore=">=0.1.0 <0.2.0"
```

**独立复核**（不依赖安装器）：`curl -sL <download_url> | sha256sum` → `9db925059bd1fac3982c4e3a115ce646c4097c4f779d8f0e573a58e1fe3cc405`，与索引 `sha256` **逐字节一致**。

```text
$ curl -b cookie.txt -X POST .../api/v1/store/install \
    -H 'Content-Type: application/json' -H "X-Kore-CSRF: $CSRF" \
    --data '{"id":"waf","version":"0.4.4","download":true}'
status=200 time=7.337907
{"id":"waf-0.4.4","plugin_id":"waf","version":"0.4.4","state":"succeeded","message":"安装完成","reload":"reloaded"}

$ curl -b cookie.txt -X POST .../api/v1/plugins/waf/enable -H "X-Kore-CSRF: $CSRF"
status=200
{"id":"waf","version":"0.4.4","lifecycle":"lazy","depth_level":"production","state":"stopped",
 "desired":"enabled","enabled":true,"granted_capabilities":["system:read","system:admin"],
 "requires_root":true,"root_actions":[14 项，含 nft-init-table/nft-mode-enforce/nft-list/nft-add-rule…]}
```

装到版本：**0.4.4**（`latest_version:0.4.4`，`update_available:false`）。

## 4. 接口实测（登录后）

### 4.1 `waf.status`

```json
{"engine":"none","available":false,
 "backend":{"tool":"nft","available":true,"channel":false,"table":"kore_waf","chain":"input",
  "present":false,"mode":"off","banned_count":0,"rules_count":0,
  "reason":"缺少 root-action 通道，无法读写规则",
  "hint":"需 root 权限：请用 sudo/systemd 启动 kored（或在 systemd unit 里配置提权），由内核经 ADR-0018 的 root-action 通道执行 nft 动作（当前：nft）"}}
```

`channel:false` 是 `chain` 为空的直接原因；`engine:none` 属本机未装 ModSecurity/Naxsi/Coraza/CrowdSec 的降级预期。

### 4.2 `waf.rules`（本轮核心观测）

```json
{"engine":"none","available":false,"error_code":"E_UNSUPPORTED","rulesets":[],"total":0,
 "nft":{"table":"kore_waf","chain":"input","present":false,"mode":"off",
  "rules_count":0,"rules":[],"bans_count":0,"bans":[]},
 "chain":[]}
```

- `chain` 类型 **list、长度 0**（0.4.3 是 `null`）→ `internal/wafop/rules.go:26` 的 `result.Chain = readChain(...)` 已执行，但 `:76` 在 `root == nil` 时返回 `[]ChainRule{}`。
- 同一响应里 `nft.rules[]` 也为空、`present:false`（表根本不存在：无权限建表）。

### 4.3 root 通道探针

```text
$ POST /api/v1/invoke/waf/waf.toggle {"mode":"enforce"}    → 403
{"code":"E_NEED_ROOT","message":"nft 数据面需要 root 权限，但插件没有可用的 root-action 通道（…）"}
```

## 5. root 通道为何拿不到（穷尽记录，未伪造）

| 路径 | 结果 |
| --- | --- |
| `sudo -n -l` | `sudo: The "no new privileges" flag is set, which prevents sudo from running as root` |
| `systemd-run --uid=0 --collect /bin/true` | `Failed to start transient service unit: Access denied as the requested operation requires interactive authentication. However, interactive authentication has not been enabled by the calling program.` |
| `systemd-run --no-ask-password --uid=0` | 同上（polkit 无交互认证通道；`/etc/polkit-1/rules.d/` 为空） |
| `capsh --print` | `Current: cap_wake_alarm=i`、`no-new-privs=1`、`Ambient set =`（无 `cap_net_admin`，且 no-new-privs 阻止 exec 时获得） |
| `getcap /usr/sbin/nft` | 无 file capability |
| 宿主 suid 助手 / kore root helper | 无（`/usr/local/bin` 无 kore*；`/usr/local /opt` 下 suid 仅浏览器 sandbox） |
| `kore.service` | `inactive`（无 root 常驻 kored 可借用） |
| `unshare -rn` 内 nft | 可用（`uid=0`、`nft list tables` exit 0），但那是**私有 netns**；且以 ns-root 起 kored 会走 `internal/core/supervisor/demote.go` 的 useradd 降权，userns 内无法写 `/etc/passwd` → fail-closed，插件起不来 |
| `docker` / `lxd` 组提权 | **主动未使用**：会写宿主 netns 的 `kore_waf` 表，违反"主实例 8787 零写入"风险约束 |

结论：**本沙箱内 root-action 通道不可得**。按任务约束"拿不到就只做只读部分并明确标注"，不构造替代数据、不伪造 `chain`。

## 6. UI 层实测（Playwright）

采集方式：Playwright **1.49.1**（`/home/pt/.npm/_npx/f0a362733743bae2/node_modules`）+ `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（显式 `executablePath`），PC `1440×900`、手机 `390×844`，`fullPage:true`。

```text
# 登录门（真实 UI）
loginGate = {"hasPasswordInput":true,"inputType":"password","submitText":"登录","sub":"控制台 · 单管理员登录"}
# 登录 → 切 #/waf → 等视图就绪，DOM 断言
desktop = {"tables":0,"tableClasses":[],"tableHeads":[],"chipCount":0,
           "builtinChipCount":0,"customChipCount":0,"deleteButtons":[],
           "disabledDeleteCount":0,"emptyState":true,"loading":false,
           "rulesHostText":"当前没有装载任何规则。切到「只记录不拦截」或「直接拦截」后会装载 4 条内置基础规则。"}
mobile  = {"tables":0,"chipCount":0,"deleteButtons":[],"emptyState":true,"viewport":390}
apiChain = {"status":200,"chain":[]}    # 页面自身发出的 waf.rules 响应
```

页面网络侧失败项（已逐条确认非本轮缺陷）：登录前 `GET system/info 401`（登录门预期）、`monitor/site/ssl/discover` 各 404（隔离实例未装这些插件）、`POST waf.bans 403`（同 root 通道原因，与 `channel:false` 一致）。

| 截图 | 场景 | `file` 实测 |
| --- | --- | --- |
| `screenshots/waf044-rules-desktop-01.png` | Web 防火墙 · 防护规则（空态，full-page） | PNG **1440 × 1866** |
| `screenshots/waf044-rules-mobile-01.png` | 同上（390 宽 full-page） | PNG **390 × 2798** |

**判定：UI 断言 3 未执行。** 因为没有 `chain[]`，`web/waf.js:532` 的 `if (S.chain.length)` 为假，浏览器走 `:559` 的空态；`:536` 的六列表头（含「类型」）、`:544` 的内置徽标、`:552` 的删除按钮 `disabled` 全部不在 DOM 中。截图证明的是**当前真实可见状态**，不是"徽标渲染通过"。

## 7. 发现（未改任何代码，仅报 `file:line`）

**P2 · 索引里 waf 0.4.4 的 `depth_level` 与插件自声明不一致**

- `kore-plugins/index/plugins.json:309` → `"depth_level": "basic"`（0.4.4 条目）
- `kore-plugin-waf/info.json:7` → `"depth_level": "production"`
- 后果：商店按索引展示为「基础级」，而插件与 `GET /api/v1/plugins`（`depth_level:"production"`）自我声明为生产级；G-20 要求商店必须展示等级，两源不一致会让"是否生产级"取决于看哪一端。建议索引侧按 `info.json` 重签（或确认降级理由后改插件声明）。

**P3 · UI 层收益本轮不可达（承接 0.4.3 的同一处空白）**

- `internal/wafop/rules.go:26` 已填 `Chain`，`:76` 在无 root 通道时返回空数组；`web/waf.js:544` / `:552` 的内置徽标与删除禁用逻辑**依赖 chain 非空**，因此非 root 环境永远走不到。
- 这不是 0.4.4 的回归，而是**验证环境前置条件**：UI 正向验收必须在能拿到 root-action 通道的宿主上做（`sudo kored` / systemd unit `User=root` / 有 polkit 交互认证的会话）。

## 8. 自评三问

1. **本页解决什么用户问题**：让管理员在一个界面里看清 kore 自有 nft 数据面的规则（内置基础防护 + 自定义放行/拦截）并做启停/增删，不必记 nft 命令；引擎层规则统计同页只读呈现。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔/1Panel 的 WAF 以引擎规则库 + 站点开关为主；本页强在**内核自带 nft 数据面**（不依赖宿主 web server）和 root-action 提权审计。差距是：无引擎时页面区域偏空；更关键的是**非 root 部署下规则列表只能显示空态**，内置/自定义的类型区分与删除保护在真实界面上完全不可见——按本轮证据，这一差距仍未闭环。
3. **当前"可用"还是"占位"**：**部分可用 / 关键视图未闭环**。安装、登录、视图加载、空态文案在真机可用；规则列表的「类型」列、内置徽标、内置行删除禁用三项**本轮未获验证**（root 通道缺失），不能记为完成。

## 9. 未验证项与原因

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `chain[]` 非空 + 4 条 `builtin=true` | 未验证 | root-action 通道被 polkit 拒绝，nft 只读也需 `cap_net_admin`（§5） |
| 自定义规则 `builtin=false` + `expr` 非空 | 未验证 | 同上；且 `rule.add` 本身需 `system:admin` + root 通道 |
| UI 内置徽标 / 删除按钮 `disabled` 的**正向**渲染 | 未验证 | `chain:[]` → 渲染分支不可达（§6），源码位置 `web/waf.js:532/544/552` |
| 内置行删除按钮的真实交互（点击被拦） | 未验证 | 同上（按钮未渲染） |
| 宿主 `input` 钩子上真实 nft 表的下发/回读 | 未验证 | 无 root 通道；未在任何 netns/容器里构造替代数据 |
| 真实恶意流量命中计数 | 未验证 | 超出本卡范围，且数据面未启用 |
| 主实例 8787 商店版本对照 | 未验证 | 按 G-29 只读核对（未登录主实例、未改其配置），仅确认进程仍在监听 8787 |

## 10. G-29 声明

**本轮未改动主实例运行态配置。** 全程隔离实例（`/tmp/kore-wafe2e044`，端口 18874，state/run/log 全落 `/tmp`），未修改 `.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、`bin/kored`；主实例进程（`kored serve --config …/.kore-local.yaml`，uid 1000）**未重启**，验收前后均监听 `127.0.0.1:8787`。本轮未在宿主创建 `kore_waf` nft 表（无权限，`present:false`）。

## 11. 清理记录

```text
$ kill <isolated kored pid>            # 仅隔离实例
$ ss -ltn | grep ':18874 '             → 无输出（PORT FREE）
$ rm -rf /tmp/kore-wafe2e044 /tmp/waf044-shot.js /tmp/waf044-net.js
$ ls -d /tmp/kore-wafe2e044            → No such file or directory
$ getent passwd | grep '^kore-'        → 无输出（无 kore-* 临时用户）
$ nft list tables 2>/dev/null | grep -c kore → 0（本来就没建成）
```
