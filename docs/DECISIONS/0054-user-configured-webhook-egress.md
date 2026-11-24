> 状态: accepted · 归属: r22-webhook · 更新: 2026-11-24 · 里程碑: R22 · 门禁关联: G-10 / G-19 / G-30 / G-23

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

## 5. 复审条件

出现下列任一情形，本 ADR 失效、例外收回：① 增加任何定时/自动出站；② 配置改为默认预置或远程下发；③ payload 开始携带会话/评测量/心跳；④ 日志出现完整 URL 或密钥；⑤ 出站地址能被请求体注入（SSRF）。
