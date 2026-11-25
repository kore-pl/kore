> 状态: accepted · 归属: feat-alert-channels（原 r22-webhook）· 更新: 2026-11-25 · 里程碑: R25 · 门禁关联: G-02 / G-10 / G-19 / G-30 / G-23

# ADR-0054：用户显式配置的出站 Webhook 与 G-10 的边界

## 1. 背景

R22 新增「通知通道」模块：用户可在设置页配置 Webhook（URL + 事件类型 + 测试按钮），告警触发时向该 URL 发一条 POST。这是 Kore 之前不存在的能力，属**纯增量**功能。

QUALITY-GATES §G10 判据原文（核对于本 ADR 落盘时）为：对 `internal/core` 扫 `http.Client`、`net.Dial`（UDS 除外）、`telemetry`、`analytics`、`report`、`phone-home`，**命中数 = 0**；修复口径写「删除出网代码；确需联网的功能必须进插件并走能力白名单」。本 ADR 记录一个被接受的例外边界，供里程碑 verifier 逐条核对，不是放宽判据本身。

既存张力（如实披露，不拿它当自动豁免）：`internal/core/installer/installer.go:57,69` 与 `download.go:36` 早已含 `http.Client`（store 包下载，G-10 §12 的用户显式出站入口）。本 ADR 新引入 `internal/core/httpapi/webhook.go:340` 的 `http.Client` 与 `:304` 的 `http.NewRequestWithContext`，同属"用户显式触发的出站"这一类。

## 2. 决策

**用户主动配置并显式启用的出站 Webhook 属于 G-10 允许的"用户显式出站例外"，与内置遥测/自动上报是不同性质，不构成 G-10 违规。** 判据如下（六条同时成立才算例外）：

| # | 判据 | 本实现事实 |
| --- | --- | --- |
| 1 | 出站目标只来自用户配置，源码无硬编码出站地址 | `validateWebhookURL` 只接受管理 API 提交的绝对 URL；仓库内无预置 URL 常量；测试也用内存 httptest 地址 |
| 2 | 用户显式启用，默认无配置 | `webhookRegistry` 初始为空；未配置时出站连接恒 0 |
| 3 | 只由告警事件触发，无周期/后台任务 | `recordAlert` → `dispatchAlert` 事件驱动；零 ticker / AfterFunc / 常驻轮询（G-19）；短命 goroutine 仅在事件发生时创建 |
| 4 | 不做任何内置遥测语义 | 不上传 session、评分、心跳、遥测标识；出站 payload 仅 `{source,title,detail,time,test}`，内容来自告警本身 |
| 5 | 凭据与 URL 不落明文日志 | 日志只记 `scheme://host` 与状态码；URL 查询串/路径、自定义 header/密钥不进日志（G-30） |
| 6 | UI 明确告知边界 | 页面明写「由你配置的外部地址，Kore 不主动收集任何数据；只有你启用且告警触发时才向该地址 POST 一条消息」 |

**明确不是例外的情况**（避免被滥用为万能豁免）：任何自动定时上报、安装后默认开启的云端连接、未在 UI 披露的第三方地址、对配置的隐藏远端拉取——仍按 G-10 原判据零命中处理，必须移入插件并走能力白名单。

## 3. 被否决的选项

1. **把 webhook 出站塞进独立插件仓**（G-10 原文"确需联网的功能必须进插件"）：否决，因为告警埋点全在 `internal/core/httpapi` 的 `recordAlert` 单一路径，跨仓走插件 invoke 会增加一个常驻进程与 UDS 往返，违反 R22 写域约束（本卡不改 cmd/store/插件仓）与 G-19 资源预算；且需配套能力白名单（`net:write`）与 ADR 才能引入，代价远大于内存态短命投递。
2. **只口头声明"这是用户行为不算遥测"，不留文档**：否决，违反 G-23「没落文件的判断不算数」与 HANDOFF 口径，REVISE 时 verifier 按零命中判 FAIL。
3. **从源码移除 `http.Client` 字面量以规避 grep**（如改用 `net.Dial` 手写 HTTP）：否决，是规避门禁的形式主义，`net.Dial` 同样在 G-10 禁用词表内，且手写协议更危险。

## 4. 验证口径（交付证据）

- 配置前：`ss -tnp | grep kored` 出站 = 0（与 r17-finalverify 17:1x 基线一致）。
- 配置后且告警触发：出现到用户 URL 的短连接，属用户主动行为，不是回归 bug；验收报告须显式注记。
- `grep -rnE 'http\.Client|net\.Dial|telemetry|analytics|phone-home' internal/core/httpapi/webhook.go` 的命中，仅对应本 ADR 第 2 节六条判据成立的场景；其余禁用词（`telemetry` / `analytics` / `phone-home`）在本文件零命中。
- 本例外范围仅限本模块（`webhook.go` / `handlers_webhook.go`），不扩散到其它 core 包。

## 5. 扩展：邮件与 IM 机器人（2026-11-25，同属本例外边界）

R22 只有 Webhook 一种通道。R25 补齐竞品清单条目 4（宝塔自定义消息通道 / 1Panel 三端 IM 告警）：
同一份告警可推 **Webhook / 邮件（SMTP）/ 企业微信 / 钉钉 / 飞书群机器人**，并按「来源 + 级别」路由。

### 5.1 实现事实（仍满足 §2 六条例外判据）

| # | §2 判据 | 多通道实现 |
| --- | --- | --- |
| 1 | 出站目标只来自用户配置 | Webhook/机器人 URL、SMTP 主机、收件人均由管理 API 提交；源码无预置地址 |
| 2 | 用户显式启用，默认无配置 | 注册表初始为空；**新通道创建后默认未启用**，必须手动「启用推送」，可随时停用/删除 |
| 3 | 只由告警事件触发 | recordAlert → dispatchAlert 短命 goroutine；无 ticker / AfterFunc / 常驻队列（G-19） |
| 4 | 不做内置遥测 | 无 session/心跳/评分；payload 只有告警字段；SMTP 只发告警邮件 |
| 5 | 凭据不落明文日志 | URL/请求头/口令/SMTP 口令均不进日志；历史只记 scheme://host 或 host:port 与状态码 |
| 6 | UI 明示边界 | 通知通道页写明「Kore 不主动收集数据、未启用时零对外连接」、密钥仅存进程内存 |

补充口径：

- **依赖**：HTTP 用 net/http，SMTP 用 net/smtp + crypto/tls，加签用 crypto/hmac + crypto/sha256 + encoding/base64——全部标准库，未新增第三方依赖（G-02 白名单不变）。
- **加签**：钉钉 sign=base64(HMAC-SHA256(key=secret, data=timestamp+"\n"+secret)) 拼 URL；飞书 sign=base64(HMAC-SHA256(key=timestamp+"\n"+secret, data="")) 放 body；企业微信不需要加签。三家算法方向不同，**不合并成同一函数**。
- **失败判定**：Webhook 以 HTTP 2xx 为准；IM 网关会「HTTP 200 + errcode≠0」，必须解析 errcode / code / StatusCode 判失败并把原因写进投递记录，否则是静默丢消息。
- **重试**：HTTP 最多 3 次、SMTP 最多 2 次，总时长有界；重试不引入常驻 goroutine。
- **凭据不持久化**：通道配置与密钥只存进程内存（重启需重填，UI 明示）。这是有意的取舍——把 SMTP 口令 / 机器人加签密钥落盘需要密钥管理，R25 不引入；持久化必须先解决「密钥加密 + 迁移」再放开。
- **路由**：每条通道可分别订阅事件（audit/plugin/resource/slot）与级别（critical/warning/info），未选级别默认全选（与旧 Webhook 请求体兼容）。

### 5.2 被否决的选项

1. **引入第三方 SMTP / 机器人 SDK 或消息队列**：否决——违反 G-02 依赖白名单与 G-05 无中间件；标准库已覆盖三家机器人与 SMTP。
2. **通道配置（含口令）直接落盘 JSON / bbolt**：否决——明文凭据入库不满足 G-30 精神；在密钥管理落地前，内存态 + UI 明示重启需重填是更安全的默认。
3. **新通道创建即启用**：否决——违背「外发默认关闭」；改为「先测试、再启用」两步，测试消息不受启用态限制（测试是用户显式动作）。
4. **新开一组 /api/v1/channels 端点**：否决——沿用 /api/v1/webhook 前缀并扩展 kind，避免前端与文档双份入口；旧请求体（只有 url/events/secret）仍按 Webhook 解析。

## 6. 复审条件

出现下列任一情形，本 ADR 失效、例外收回：① 增加任何定时/自动出站；② 配置改为默认预置或远程下发；③ payload 开始携带会话/评测量/心跳；④ 日志出现完整 URL 或密钥；⑤ 出站地址能被请求体注入（SSRF）；⑥ 通道配置开始持久化而未先做密钥加密；⑦ 出现批量重发 / 定时摘要等自动出站（含 SMTP 批量投递）。
