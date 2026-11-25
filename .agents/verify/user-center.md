# 账户与安全中心（user-center）交付报告

- 卡片：user-center｜agent：`feat-user-center`｜日期：2026-11-25
- 写域：`web/user-center.js`（新增）、`web/app.js`（注册 2 处）、`web/i18n/{zh-CN,en-US}.js`、
  `Makefile`（WEB_SRC_FILES）、`web/embed.go`、`internal/core/auth/{session,security,passwordmeta}.go`、
  `internal/core/httpapi/{handlers_sessions.go(新增),handlers_sessions_test.go(新增),handlers_auth.go,
  handlers_password.go,middleware.go,server.go}`、`internal/core/auth/usercenter_test.go`（新增）、
  `docs/{CORE,SECURITY,DATA-MODEL}.md`（对应小节）、本文件与双端截图。
- 未触碰：`web/shell.js`、`web/onboarding.js`、`web/settings.js`、`web/config-panel.js`、`web/security.js`、
  `web/audit.js`、其他插件仓、运行态资产（G-29）。

## 1. 审计结论（只补缺口，不重做）

| 能力 | 审计前事实 | 本轮处置 |
| --- | --- | --- |
| 2FA / 恢复码 / IP 白名单 / API token | `auth/security.go` + `httpapi/handlers_security.go` 已完整（开启/关闭/校验/吊销） | **保持语义不动**，只新增只读 `TOTPStatus()`（多返回剩余恢复码数）供总览使用 |
| 口令 | 只有 PBKDF2 哈希，**无强度、无上次修改时间**；改口令端点已存在 | 新增 `auth/passwordmeta.go`：改口令成功时用明文算一次强度（0-4）并落标量元信息；启动时检测到口令被 CLI 改过则记"改过、强度未知"，**不伪造强度** |
| 会话 | `sessions` 只存 `<expiry> <created>`，**无来源 IP / UA / 最后活跃**，因此无法列会话、无法踢单个 | 值扩成 5 段（后 3 段为元信息，兼容两种旧格式）；新增 `Touch`（5 分钟节流）、`ListSessions`、`RevokeByID`、`RevokeOthers`；登录时记录 IP/UA |
| 登录记录 | 审计流里**已有** `login.success` / `login.failed`（含脱敏网段、UA、失败原因） | 不另建登录表，新增 `GET /security/login-records` 把审计流派生为记录 + 异常标记 |
| 主动踢下线 | 只有 `RevokeAll`（全踢、连自己） | 新增「踢单个」「一键全踢（保留当前）」；**踢当前会话被拒**并提示用登出 |

## 2. 新增端点（`registerSecurityCenterRoutes`，不写 `routes()`，避免并行写域冲突）

| 端点 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/v1/security/overview` | 有效会话 | 口令强度/上次修改/存储参数、2FA 状态+恢复码剩余、token 数+最近使用、白名单开关+条数、活跃会话数+当前 id、最近登录+24h 失败数+异常原因 |
| `GET /api/v1/security/sessions` | 有效会话 | 会话列表；**只回 `id` 前缀（16 hex）**，不回明文 token、不回完整 hash |
| `DELETE /api/v1/security/sessions/{id}` | `system:admin` | 踢单个；幂等（已消失回 `revoked=false`）；踢当前会话 → 400 + 「请用退出登录」 |
| `POST /api/v1/security/sessions/revoke-others` | `system:admin` | 一键全踢，保留当前会话，返回踢掉数量 |
| `GET /api/v1/security/login-records` | `system:read`（复用 `authorizeAuditRead`） | `limit` ≤200、`days` ≤90，越界 400；异常标记 `new_network` / `fail_burst`（同网段 ≥3 次失败）/ `rate_limited` |

**假警报修正**：首登（历史为空）不算「新网段」；只有此前已有过其它网段成功登录才标记，避免全新实例一登录就报红。

## 3. 用户可见行为（`web/user-center.js`，挂在「设置」hub 第二个 tab「账户与安全」）

1. 六张状态卡：管理员口令（强度/上次修改/存储方式，带「改口令」）、两步验证（恢复码剩余）、API 令牌、登录白名单、活跃登录、最近登录（异常红字）。
2. 快捷动作行：改口令（本页内联弹层，实时强度条 + 三次校验）、开启/关闭两步验证、生成令牌、管理白名单、退出登录（后四项经 `window.__koreSettingsTab='security' + KoreShell.navigate('settings/settings')` 跳到既有 security.js，不重复实现）。
3. 会话表：登录时间 / 来源 / 设备（UA 摘要）/ 最后活跃 / 到期时间 / 操作；当前会话打「当前」标并禁止踢；非当前行「踢下线」；右上「一键全踢（保留当前）」。
4. 登录记录表：时间 / 来源网段 / 结果 / 原因（人话：口令错误、两步验证码错误、来源网络不在允许列表…）/ 设备 / 异常标签。
5. 空状态与错误态都带下一步按钮（G-33 A5）；零轮询（只在进入与点「刷新」时取数）；写请求一律带 CSRF 双提交。
6. **真机点击验证抓到一个真 bug 并已修**：DELETE 请求没有 body，最初只在「有 body」时才加 `X-Kore-CSRF`
   头 → 点「踢下线」一律 401 CSRF 校验失败。修复后点击实测：会话行 3 → 2、`DELETE /api/v1/security/sessions/{id} -> 200`。

## 4. 证据（命令 + 退出码）

```
# 编译与测试（GOCACHE 落工作区，因本机 ~/.cache 与 go mod cache 只读；
# TMPDIR 必须用短路径 /tmp/kt——工作区路径做 TMPDIR 会让 UDS socket 路径超过 108 字节，
# 现成的 bus/supervisor 用例会以 "bind: invalid argument" 假失败，与本卡无关）
cd kore && GOCACHE=<ws>/.gocache GOTMPDIR=<ws>/.tmp go build ./internal/...        → exit=0
cd kore && ... go test -timeout 200s ./internal/core/auth/ ./internal/core/httpapi/
  ok github.com/pengtang1024/kore/internal/core/auth      1.626s
  ok github.com/pengtang1024/kore/internal/core/httpapi   6.312s                    → exit=0
新增用例：auth/usercenter_test.go 6 个（元信息往返 / Touch 节流 / 列表+按 id 吊销+全踢保留当前 /
  旧格式兼容 / 强度评分 / 口令元信息）；
  httpapi/handlers_sessions_test.go 4 个（登录拿 cookie 走真实中间件链：会话列表与三种踢法、
  总览字段、登录记录异常标记与参数校验、审计未装配回 501）                            → exit=0

node --check web/user-center.js                                                       → exit=0
bash scripts/frontend-check.sh
  首屏合计（gzip -9）: 81689 字节 / 预算 307200（余量 225511）
  i18n 增量（gzip -9）: 2940 字节 / 预算 3072（余量 132）                             → exit=0
cd kore && GOCACHE=<ws>/.gocache GOTMPDIR=/tmp/kt TMPDIR=/tmp/kt go test -timeout 300s ./...
  （全仓 16 包）全部 ok，0 个 --- FAIL                                              → exit=0
bash scripts/docs-check.sh: 5 pass / 1 warn（SECURITY.md 行数，存量）/ 0 fail         → exit=0
bash scripts/usability-check.sh：无 user-center 相关新增项（A5/A6/A7 均未命中本页）     → exit=1（存量为 waf/search 既有 FAIL，与本卡无关）

# 隔离实例 + Playwright 真机点击（非 mock，同一实例同一份真实数据）
[INFO] 点击“踢下线”：行 3 -> 2；DELETE /api/v1/security/sessions/{id} -> 200
[OK] 踢下线生效
[OK] 改口令弹层已打开，强度提示：新口令强度：很强
[OK] Esc 关闭弹层
  （安全端点请求：GET /security/overview 200 · GET /security/sessions 200 ·
    GET /security/login-records 200 · DELETE /security/sessions/{id} 200）        → exit=0
bash scripts/secret-check.sh: 0 FAIL / 22 处匹配（占位写法均合规）                     → exit=0
```

## 5. G-28 双端证据

| 文件 | 实测宽高 | 说明 |
| --- | --- | --- |
| `.agents/verify/screenshots/user-center-desktop-02.png` | 1440×1438（fullPage） | 六卡 + 快捷动作 + 会话表（3 处登录，当前会话已标记）+ 登录记录（3 条失败带「同网段多次失败」标） |
| `.agents/verify/screenshots/user-center-mobile-02.png` | 390×844 | 会话区：表格已变卡片式（标签+值两列），触摸目标 ≥44px；与桌面不是同一张图缩放 |

隔离实例取证：`/tmp/kore-uc-shot`（config/state/run/log 全落 /tmp，独立端口，测完即删）；
真实数据由 curl 造：3 次成功登录（Chrome/iPhone/curl）+ 3 次失败登录（错口令），非 mock。

### 产品定位自评（三问）

1. **本页解决什么用户问题**：把「我的管理账号现在安全吗」一次答完——以前口令强度/上次改了什么
   完全看不到，2FA、token、白名单散在设置页三个区块，登录历史要去操作审计里自己筛，别的设备
   登录了也没法踢；现在一页看全并且能当场处置（改口令、踢下线）。
2. **与宝塔 / 1Panel 差距**：宝塔/1Panel 有「登录日志 + 在线会话」但同样不显示口令强度与上次修改时间；
   本页把这两项也做了（强度在改口令时评估并持久化，旧口令如实标「未评估」而不是编一个分数），
   并且「一键全踢但保留当前」比竞品的"全部退出"更安全（不会把正在操作的自己踢掉）。
   差距仍在：没有按地区/设备指纹判断异地登录（审计只存脱敏网段），没有登录失败锁定策略的图形化配置。
3. **当前"可用"还是"占位"**：**可用**。五个端点全部真实读写（不是 501 占位），前端六个区块都有真实数据，
   踢下线/全踢/改口令真生效；未评估项（口令强度、恢复码剩余 0）都如实说明原因而不是伪造。

## 6. 已知限制（如实标注）

- 登录记录来源是**脱敏网段**（`192.168.1.x`，审计既有口径），因此「新网段」不等于「新 IP」；界面文案写「网段」。
- 会话元信息（IP/UA/最后活跃）**只展示、不参与鉴权**：不绑定指纹、不因 IP 变化拦截会话（与 docs/SECURITY §3.3 一致）。
- 口令强度只在「面板改口令」时评估；CLI 改口令后只能知道"改过"，强度显示未评估（不伪造）。
- 「上次修改时间」对升级前的老实例是未知；命令行改过的记的是**检测时刻**，前端文案已说明。
- 恢复码剩余数只读展示；重新生成恢复码仍走 security.js（未改既有实现）。

## 7. G-29 声明

本轮**未改动主实例运行态配置与资产**：验证全程使用独立 `--config` + /tmp 的 state/run/log；
截图与测试用的临时脚本/二进制/日志（`.tmp/uc-shot.sh`、`.tmp/uc-shot.mjs`、`.tmp/kored-user-center`、
`.tmp/*.log`、`/tmp/kore-uc-shot`）交付前已删除。
