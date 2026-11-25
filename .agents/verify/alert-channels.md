# 告警外发 · 多通道（Webhook / 邮件 / IM）验收报告

日期：2026-11-25（Asia/Shanghai）｜Owner：feat-alert-channels｜卡：alert-channels（竞品清单条目 4，P1）

## 1. 结论先行

宝塔「自定义消息通道」与 1Panel「三端 IM 告警」在 Kore 落地为**通知通道多路外发**：
同一条告警可按「来源 + 级别」推到 Webhook（自定义请求头 / JSON 模板）、邮件（SMTP）、
企业微信 / 钉钉 / 飞书群机器人（钉钉、飞书支持加签）。全部标准库实现（net/http、net/smtp、
crypto/tls、crypto/hmac），未新增依赖；新建通道默认未启用，先测试再启用；密钥与口令只存进程内存。

隔离实例真机点击 + 真实 HTTP 接收端 + 真实内核告警触发全链路通过（见 §4），G-28 双端截图见 §5。

## 2. 依据（竞品条目 + 改动前后 path:line）

| 事实 | 改动前 | 改动后 |
| --- | --- | --- |
| 渠道种类 | 只有 webhook：internal/core/httpapi/webhook.go:18「通知通道（webhook）」、:31 webhookPath | 三类：webhook / email / im，webhook.go:51 kind 常量；webhook_email.go；webhook_im.go |
| 邮件 | 无 | webhook_email.go:1 标准库 net/smtp；SMTP 主机/端口/账号/口令/发件人/收件人/加密方式 |
| IM | 无 | webhook_im.go:1 企业微信 / 钉钉 / 飞书；钉钉与飞书各自算法加签（signDingTalk / signFeishu） |
| 路由 | 只按来源事件（webhook.go:225 webhookEventMatches） | 来源 + 级别（alerts.go:89 dispatchAlert(severity, source, …)；webhook.go dispatchAlert 双过滤） |
| 启停 | 无写端点，创建即 enabled=true | 新建默认未启用；PATCH /api/v1/webhook/{id} 启停（handlers_webhook.go） |
| Webhook 自定义 | 仅 URL + 固定密钥头 + 固定 payload | 自定义请求头（≤8，禁 Host 等）+ JSON 模板占位符校验（webhook.go validateChannelHeaders / renderChannelTemplate） |
| UI | web/webhook.js:1 单 Webhook 表单 | 多通道表单 + 已配置通道启停/测试 + 投递记录失败原因；入口在「设置 → 通知通道」（settings/webhook） |
| 告警面板入口 | 无外发入口 | web/alerts.js 顶栏「通知渠道」+ 空态「配置外部通知」按钮 |

## 3. 关键实现约束

- G-02：零新增依赖（go.mod 未变）；HTTP / SMTP / 加签全标准库。
- G-10：出站目标只来自用户配置；默认零通道、零出站；无遥测语义（ADR-0054 §5 已补录六条判据复核）。
- G-19：零 ticker / AfterFunc / 常驻队列；仅在告警触发时起短命 goroutine，HTTP 最多 3 次、SMTP 最多 2 次有界重试。
- G-30：口令/密钥不回显（只回 *_set）；日志与投递记录只记 scheme://host 或 host:port；错误信息里的完整 URL 先脱敏（sanitizeChannelError，单测覆盖带查询串密钥的场景）。
- IM 失败判定：HTTP 200 + errcode≠0 也判失败并记录网关原文（避免静默丢消息）。
- G-24：对外结构体全部定形，无 object / any / map[string]any。

## 4. 用户可见行为（隔离实例：config/state/run/log 全落 /tmp，端口 18897，主实例 8787 零改动）

构建与启动：

    $ CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/.../kored ./cmd/kored
    退出码 0
    $ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18897/-/healthz
    200

真实浏览器（Playwright，真实登录 cookie）打开「设置 → 通知通道」并点击：

    ROUTE_OK settings/webhook
    CLICK test real channel OK            # 点「发送测试」→ 通知条出现「测试消息已发出」
    CLICK test unreachable channel OK     # 同一按钮在不可达通道上得到真实失败原因
    CLICK enable channel OK               # 点「启用推送」→ 状态变「已启用」
    FAILED_LOGIN_STATUSES=401,401,401     # 用页面内 fetch 触发 3 次真实登录失败（内核告警埋点）
    HISTORY=webhook:webhook_test:info:ok | webhook:webhook_test:info:failed | webhook:audit:critical:ok
    FAIL_REASON=Post "http://127.0.0.1:9": dial tcp 127.0.0.1:9: connect: connection refused
    UI_VERIFY=PASS

本地 HTTP 接收端（127.0.0.1:18898）收到的真实报文：

    hook_deliveries=2
    deliver test=True  source=webhook_test severity=info     title=通知通道测试事件
    deliver test=False source=audit        severity=critical title=登录连续失败 3 次，疑似暴力破解
    token_header_ok=True   # 自定义请求头（X-Kore-Webhook-Token / X-Env）按配置送达

即：**测试消息**与**真实内核告警（登录暴力破解埋点）**都按「来源 audit + 级别 critical」路由到启用通道；
未启用的通道不出站；失败原因可在「投递记录」看到，且完整 URL 已脱敏为 scheme://host。

## 5. G-28 双端截图与自评

    $ file .agents/verify/screenshots/alert-channels-desktop-1125.png ...
    alert-channels-desktop-1125.png: PNG image data, 1440 x 1959, 8-bit/color RGB, non-interlaced
    alert-channels-mobile-1125.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced

自评三问：

1. **本页解决什么用户问题**：告警只停在站内铃铛、值班人看不到 → 把同一批告警按来源/级别推到自己的 Webhook、邮箱或 IM 群；能测试、能启停、能看到失败原因。
2. **与宝塔 / 1Panel 差距**：宝塔是「自定义消息通道（Webhook/邮件/微信等）」，1Panel 是三端 IM + 邮件。本页已覆盖 webhook（含自定义头与 JSON 模板）、邮件（STARTTLS/SSL/明文）、企业微信/钉钉/飞书（含加签），并多一个「按级别路由 + 失败原因可见」；差距仅在「通道配置重启后需重填」（内存态，UI 已明示）与短信/电话（非目标）。
3. **当前状态**：**可用**（真实点击 + 真实投递，非占位）。唯一已知限制：配置与密钥不持久化，重启需重填；这是为避免明文凭据落盘的有意取舍（ADR-0054 §5.2）。

## 6. 门禁

    $ go test ./... -count=1 -timeout 600s           → exit 0（根 module 全绿）
    $ node --check web/webhook.js && node --check web/alerts.js → exit 0
    $ make secret-check                              → exit 0（0 FAIL / 22 处占位合规）
    $ make frontend                                  → 首屏 80910 / 307200 字节（gzip -9）
    $ make docs-check                                → 5 pass / 1 warn / 0 fail

## 7. 运行态与仓库卫生

- G-29：**本轮未改动主实例运行态**（未碰 .kore-local.yaml / 主 state / 主 bin/kored / 8787）；全部验证在 /tmp 隔离实例，收尾已删除临时目录、临时口令与接收端脚本（工作区零残留）。
- 写域：internal/core/httpapi（alerts/webhook 相关）、web/webhook.js、web/webhook.css、web/alerts.js，以及随 G-06 同步的 docs（CORE / ADR-0054 / FEATURE-PARITY）与 CHANGELOG。
- git status 见交付说明；未提交他人修改（web/firewall.js、web/monitor.js、scripts/usability-pending.txt 属其他卡，未触碰）。

## 8. 一句话

补了「Webhook/邮件/企业微信/钉钉/飞书 多通道告警外发 + 来源/级别路由 + 测试与失败原因」；证据齐（真机点击、真实接收端报文、双端截图、门禁全绿）。
