package httpapi

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// waitChannelDelivery 等一次投递落历史（投递在短命 goroutine 里，测试轮询等待）。
func waitChannelDelivery(t *testing.T, reg *webhookRegistry, want int) []channelDelivery {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got := reg.list().History
		if len(got) >= want {
			return got
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等待投递记录超时：期望 >=%d 条，实际 %d 条", want, len(reg.list().History))
	return nil
}

// TestChannelValidation 覆盖三类通道的入参校验（错误信息要能指导用户改）。
func TestChannelValidation(t *testing.T) {
	base := webhookWriteBody{
		Kind: channelKindWebhook, Events: []string{alertSourceAudit},
		URL: "https://example.com/hook",
	}
	cases := []struct {
		name string
		edit func(*webhookWriteBody)
		want string
	}{
		{"坏通道类型", func(b *webhookWriteBody) { b.Kind = "sms" }, "通道类型"},
		{"缺 URL", func(b *webhookWriteBody) { b.URL = "" }, "URL"},
		{"非 http URL", func(b *webhookWriteBody) { b.URL = "ftp://example.com/hook" }, "http"},
		{"URL 带凭据", func(b *webhookWriteBody) { b.URL = "https://u:p@example.com/hook" }, "凭据"},
		{"没选事件", func(b *webhookWriteBody) { b.Events = nil }, "至少选择"},
		{"事件类型非法", func(b *webhookWriteBody) { b.Events = []string{"foo"} }, "audit"},
		{"级别非法", func(b *webhookWriteBody) { b.Severities = []string{"fatal"} }, "critical"},
		{"请求头注入换行", func(b *webhookWriteBody) {
			b.Headers = []ChannelHeader{{Name: "X-Test", Value: "a\r\nB: c"}}
		}, "换行"},
		{"请求头名非法", func(b *webhookWriteBody) {
			b.Headers = []ChannelHeader{{Name: "X Test", Value: "v"}}
		}, "请求头名称"},
		{"禁用请求头", func(b *webhookWriteBody) {
			b.Headers = []ChannelHeader{{Name: "Host", Value: "evil"}}
		}, "不允许自定义"},
		{"模板未知占位符", func(b *webhookWriteBody) { b.Template = `{"t":"{{nick}}"}` }, "占位符"},
		{"模板不是 JSON", func(b *webhookWriteBody) { b.Template = `{"t":{{title}}}` }, "合法 JSON"},
		{"邮件缺配置", func(b *webhookWriteBody) { b.Kind = channelKindEmail; b.Email = nil }, "SMTP"},
		{"邮件端口越界", func(b *webhookWriteBody) {
			b.Kind = channelKindEmail
			b.Email = &channelEmailWrite{Host: "smtp.example.com", Port: 70000, From: "a@example.com", Recipients: []string{"b@example.com"}}
		}, "端口"},
		{"邮件账号无口令", func(b *webhookWriteBody) {
			b.Kind = channelKindEmail
			b.Email = &channelEmailWrite{Host: "smtp.example.com", User: "u@example.com", From: "u@example.com", Recipients: []string{"b@example.com"}}
		}, "口令"},
		{"邮件收件人非法", func(b *webhookWriteBody) {
			b.Kind = channelKindEmail
			b.Email = &channelEmailWrite{Host: "smtp.example.com", From: "a@example.com", Recipients: []string{"not-an-email"}}
		}, "收件人"},
		{"IM 缺机器人类型", func(b *webhookWriteBody) { b.Kind = channelKindIM }, "机器人类型"},
		{"IM 类型非法", func(b *webhookWriteBody) { b.Kind = channelKindIM; b.IMKind = "slack" }, "wecom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := base
			body.Events = append([]string(nil), base.Events...)
			tc.edit(&body)
			reg := newWebhookRegistry()
			if _, err := reg.add(body); err == nil {
				t.Fatalf("期望校验失败，实际通过")
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("错误信息 %q 未包含 %q", err.Error(), tc.want)
			}
		})
	}
}

// TestChannelAddDefaults 验证默认值、启用态默认关闭、密钥不回明文。
func TestChannelAddDefaults(t *testing.T) {
	reg := newWebhookRegistry()
	target, err := reg.add(webhookWriteBody{
		Events: []string{alertSourceAudit}, URL: "https://example.com/hook",
		Secret: "s3cr3t-token", Headers: []ChannelHeader{{Name: "X-Env", Value: "prod"}},
	})
	if err != nil {
		t.Fatalf("新增 webhook 失败: %v", err)
	}
	if target.Kind != channelKindWebhook || target.Name != "Webhook" {
		t.Fatalf("默认 kind/name 不符: %+v", target)
	}
	if target.Enabled {
		t.Fatalf("新通道必须默认未启用（外发默认关闭）")
	}
	if len(target.Severities) != 3 {
		t.Fatalf("未指定级别时应默认全部级别，实际 %v", target.Severities)
	}
	if !target.SecretSet {
		t.Fatalf("secret_set 应为 true")
	}
	raw, _ := json.Marshal(reg.list())
	if strings.Contains(string(raw), "s3cr3t-token") {
		t.Fatalf("列表响应泄漏了密钥明文")
	}

	email, err := reg.add(webhookWriteBody{
		Kind: channelKindEmail, Events: []string{alertSourceResource},
		Email: &channelEmailWrite{
			Host: "smtp.example.com", User: "bot@example.com", Password: "mail-pass",
			From: "bot@example.com", Recipients: []string{"ops@example.com"},
		},
	})
	if err != nil {
		t.Fatalf("新增邮件通道失败: %v", err)
	}
	if email.Email == nil || email.Email.Port != 587 || email.Email.TLS != smtpTLSStartTLS {
		t.Fatalf("邮件默认端口/加密方式不符: %+v", email.Email)
	}
	if !email.Email.PasswordSet || !email.SecretSet {
		t.Fatalf("口令应只回 set 标记")
	}
	raw, _ = json.Marshal(reg.list())
	if strings.Contains(string(raw), "mail-pass") {
		t.Fatalf("列表响应泄漏了 SMTP 口令")
	}

	im, err := reg.add(webhookWriteBody{
		Kind: channelKindIM, Events: []string{alertSourcePlugin}, IMKind: imKindFeishu,
		URL: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx", Secret: "sign-key",
	})
	if err != nil {
		t.Fatalf("新增 IM 通道失败: %v", err)
	}
	if im.IM == nil || im.IM.Kind != imKindFeishu || !im.IM.SecretSet {
		t.Fatalf("IM 视图不符: %+v", im.IM)
	}
	if im.Name != "飞书机器人" {
		t.Fatalf("IM 默认名称应为「飞书机器人」，实际 %q", im.Name)
	}
}

// TestChannelRoutingBySeverityAndEnabled 验证「启用 + 来源 + 级别」三重路由。
func TestChannelRoutingBySeverityAndEnabled(t *testing.T) {
	type hit struct {
		token string
		env   string
		body  webhookPayload
	}
	hits := make(chan hit, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p webhookPayload
		_ = json.NewDecoder(r.Body).Decode(&p)
		hits <- hit{token: r.Header.Get("X-Kore-Webhook-Token"), env: r.Header.Get("X-Env"), body: p}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	reg := newWebhookRegistry()
	target, err := reg.add(webhookWriteBody{
		Events: []string{alertSourceAudit}, Severities: []string{alertSeverityCritical},
		URL: srv.URL, Secret: "tok", Headers: []ChannelHeader{{Name: "X-Env", Value: "prod"}},
	})
	if err != nil {
		t.Fatalf("新增通道失败: %v", err)
	}
	if _, ok := reg.updateEnabled(target.ID, true); !ok {
		t.Fatalf("启用通道失败")
	}
	// 来源不符 / 级别不符都不得出站。
	reg.dispatchAlert(alertSeverityCritical, alertSourcePlugin, "x", "")
	reg.dispatchAlert(alertSeverityWarning, alertSourceAudit, "x", "")
	select {
	case h := <-hits:
		t.Fatalf("不该投递却收到了请求: %+v", h)
	case <-time.After(150 * time.Millisecond):
	}
	reg.dispatchAlert(alertSeverityCritical, alertSourceAudit, "权限被拒绝", "subject=admin")
	select {
	case h := <-hits:
		if h.token != "tok" || h.env != "prod" {
			t.Fatalf("自定义请求头/密钥未送达: %+v", h)
		}
		if h.body.Severity != alertSeverityCritical || h.body.Source != alertSourceAudit ||
			h.body.Title != "权限被拒绝" || h.body.Test {
			t.Fatalf("payload 不符: %+v", h.body)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("符合条件的告警未投递")
	}
	history := waitChannelDelivery(t, reg, 1)
	if history[0].Status != "ok" || history[0].Severity != alertSeverityCritical || history[0].Kind != channelKindWebhook {
		t.Fatalf("投递记录不符: %+v", history[0])
	}

	// 停用后不再出站。
	if _, ok := reg.updateEnabled(target.ID, false); !ok {
		t.Fatalf("停用通道失败")
	}
	reg.dispatchAlert(alertSeverityCritical, alertSourceAudit, "停用后", "")
	select {
	case h := <-hits:
		t.Fatalf("停用后仍投递: %+v", h)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestWebhookTemplateJSON 验证 JSON 模板渲染与转义（标题里的引号不能破坏 JSON）。
func TestWebhookTemplateJSON(t *testing.T) {
	bodies := make(chan map[string]string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var got map[string]string
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("模板渲染结果不是合法 JSON: %v", err)
		}
		bodies <- got
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	reg := newWebhookRegistry()
	target, err := reg.add(webhookWriteBody{
		Events: []string{alertSourceAudit}, URL: srv.URL,
		Template: `{"text":"{{title}}","sev":"{{severity}}","at":"{{time}}"}`,
	})
	if err != nil {
		t.Fatalf("新增模板通道失败: %v", err)
	}
	reg.updateEnabled(target.ID, true)
	reg.dispatchAlert(alertSeverityWarning, alertSourceAudit, "引号\"与反斜杠\\", "详情\n换行")
	select {
	case got := <-bodies:
		if got["text"] != "引号\"与反斜杠\\" {
			t.Fatalf("模板 title 转义/还原不符: %q", got["text"])
		}
		if got["sev"] != alertSeverityWarning || got["at"] == "" {
			t.Fatalf("模板其余字段不符: %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("模板通道未投递")
	}
}

// TestChannelErrorSanitized 验证失败原因里的完整 URL（含查询串密钥）被脱敏。
func TestChannelErrorSanitized(t *testing.T) {
	st := &channelStored{view: ChannelTarget{
		Kind: channelKindWebhook, URL: "https://hooks.example.com/robot?key=SECRET-VALUE",
	}}
	got := sanitizeChannelError("Post \"https://hooks.example.com/robot?key=SECRET-VALUE\": dial tcp 10.0.0.1:443: refused", st)
	if strings.Contains(got, "SECRET-VALUE") || strings.Contains(got, "/robot") {
		t.Fatalf("错误信息未脱敏: %s", got)
	}
	if !strings.Contains(got, "https://hooks.example.com") {
		t.Fatalf("脱敏后应保留 scheme://host: %s", got)
	}
}

// TestIMRequestBuild 覆盖三家机器人的 payload 与加签算法差异。
func TestIMRequestBuild(t *testing.T) {
	at := time.Unix(1735689600, 0)
	p := webhookPayload{
		Source: alertSourceResource, Severity: alertSeverityCritical,
		Title: "内存超红线", Detail: "当前 17.2 MiB", Time: at.Format(time.RFC3339Nano),
	}
	t.Run("企业微信", func(t *testing.T) {
		u, body, err := buildIMRequest(imKindWeCom, "", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k", p, at)
		if err != nil {
			t.Fatalf("构造失败: %v", err)
		}
		if u != "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k" {
			t.Fatalf("企业微信 URL 不应改签名: %s", u)
		}
		var got imWeComBody
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("body 非法: %v", err)
		}
		if got.MsgType != "markdown" || !strings.Contains(got.Markdown.Content, "内存超红线") ||
			!strings.Contains(got.Markdown.Content, "严重") {
			t.Fatalf("企业微信 payload 不符: %+v", got)
		}
	})
	t.Run("钉钉无密钥", func(t *testing.T) {
		u, _, err := buildIMRequest(imKindDingTalk, "", "https://oapi.dingtalk.com/robot/send?access_token=t", p, at)
		if err != nil {
			t.Fatalf("构造失败: %v", err)
		}
		if strings.Contains(u, "sign=") {
			t.Fatalf("无密钥时不应加签: %s", u)
		}
	})
	t.Run("钉钉加签", func(t *testing.T) {
		u, body, err := buildIMRequest(imKindDingTalk, "SECabc", "https://oapi.dingtalk.com/robot/send?access_token=t", p, at)
		if err != nil {
			t.Fatalf("构造失败: %v", err)
		}
		if !strings.Contains(u, "timestamp=1735689600") || !strings.Contains(u, "sign=") {
			t.Fatalf("钉钉 URL 未加签: %s", u)
		}
		want := url.QueryEscape(signDingTalk("SECabc", at.Unix()))
		if !strings.Contains(u, "sign="+want) {
			t.Fatalf("钉钉签名不符，URL=%s", u)
		}
		var got imDingTalkBody
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("body 非法: %v", err)
		}
		if got.Markdown.Title != "内存超红线" {
			t.Fatalf("钉钉标题不符: %+v", got.Markdown)
		}
	})
	t.Run("飞书加签", func(t *testing.T) {
		_, body, err := buildIMRequest(imKindFeishu, "feishu-secret", "https://open.feishu.cn/open-apis/bot/v2/hook/x", p, at)
		if err != nil {
			t.Fatalf("构造失败: %v", err)
		}
		var got imFeishuBody
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("body 非法: %v", err)
		}
		if got.MsgType != "text" || got.Timestamp != "1735689600" {
			t.Fatalf("飞书 payload 不符: %+v", got)
		}
		if got.Sign != signFeishu("feishu-secret", at.Unix()) {
			t.Fatalf("飞书签名不符: %s", got.Sign)
		}
		if signDingTalk("s", at.Unix()) == signFeishu("s", at.Unix()) {
			t.Fatalf("钉钉与飞书加签算法不应相同")
		}
	})
}

// TestIMDeliveryDetectsBusinessError 验证 HTTP 200 + errcode!=0 也被判失败（并记录原因）。
func TestIMDeliveryDetectsBusinessError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"errcode":93000,"errmsg":"invalid webhook url"}`))
	}))
	defer srv.Close()
	reg := newWebhookRegistry()
	target, err := reg.add(webhookWriteBody{
		Kind: channelKindIM, IMKind: imKindWeCom, Events: []string{alertSourceAudit}, URL: srv.URL,
	})
	if err != nil {
		t.Fatalf("新增 IM 通道失败: %v", err)
	}
	reg.updateEnabled(target.ID, true)
	reg.dispatchAlert(alertSeverityCritical, alertSourceAudit, "业务失败", "")
	history := waitChannelDelivery(t, reg, 1)
	if history[0].Status != "failed" || !strings.Contains(history[0].Err, "93000") {
		t.Fatalf("业务错误码未判失败: %+v", history[0])
	}
}

// TestEmailMessageBuild 验证邮件报文的 RFC 2047 主题与 base64 正文。
func TestEmailMessageBuild(t *testing.T) {
	body := buildEmailBody(webhookPayload{
		Source: alertSourceAudit, Severity: alertSeverityCritical,
		Title: "登录连续失败", Detail: "连续失败 3 次", Time: "2026-11-25T00:00:00Z",
	})
	msg := buildEmailMessage("bot@example.com", []string{"ops@example.com"}, "[Kore] 登录连续失败", body)
	text := string(msg)
	for _, want := range []string{"From: bot@example.com", "To: ops@example.com", "Subject: =?UTF-8?b?", "Content-Transfer-Encoding: base64"} {
		if !strings.Contains(text, want) {
			t.Fatalf("报文缺少 %q：\n%s", want, text)
		}
	}
	idx := strings.Index(text, "\r\n\r\n")
	if idx < 0 {
		t.Fatalf("报文缺 header/body 分隔")
	}
	encoded := strings.ReplaceAll(text[idx+4:], "\r\n", "")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("正文 base64 解码失败: %v", err)
	}
	if !strings.Contains(string(decoded), "登录连续失败") || !strings.Contains(string(decoded), "连续失败 3 次") {
		t.Fatalf("正文内容不符:\n%s", decoded)
	}
}

// TestEmailDeliveryOverSMTP 用进程内假 SMTP 服务器走完一次真实 net/smtp 投递。
func TestEmailDeliveryOverSMTP(t *testing.T) {
	mails := make(chan string, 1)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		w := bufio.NewWriter(conn)
		reply := func(line string) {
			_, _ = w.WriteString(line + "\r\n")
			_ = w.Flush()
		}
		reply("220 fake ESMTP")
		inData := false
		var data strings.Builder
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if inData {
				if line == "." {
					inData = false
					mails <- data.String()
					reply("250 OK")
					continue
				}
				data.WriteString(line + "\n")
				continue
			}
			switch {
			case strings.HasPrefix(line, "EHLO"), strings.HasPrefix(line, "HELO"):
				_, _ = w.WriteString("250-fake\r\n250-SIZE 1048576\r\n250 8BITMIME\r\n")
				_ = w.Flush()
			case line == "DATA":
				reply("354 go ahead")
				inData = true
			case line == "QUIT":
				reply("221 bye")
				return
			default:
				reply("250 OK")
			}
		}
	}()
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	_, _ = fmt.Sscanf(portStr, "%d", &port)

	st := &channelStored{view: ChannelTarget{
		Kind: channelKindEmail, Name: "邮件", Enabled: true,
		Email: &ChannelEmail{
			Host: host, Port: port, TLS: smtpTLSNone, From: "bot@example.com",
			Recipients: []string{"ops@example.com"},
		},
	}}
	code, attempts, err := sendChannelEmail(st, webhookPayload{
		Source: alertSourceAudit, Severity: alertSeverityWarning,
		Title: "插件反复重启", Detail: "restarts=4", Time: "2026-11-25T00:00:00Z", Test: true,
	})
	if err != nil {
		t.Fatalf("SMTP 投递失败: %v (code=%d attempts=%d)", err, code, attempts)
	}
	select {
	case raw := <-mails:
		if !strings.Contains(raw, "Subject: =?UTF-8?b?") || !strings.Contains(raw, "To: ops@example.com") {
			t.Fatalf("SMTP 收到的报文不符:\n%s", raw)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("假 SMTP 服务器未收到邮件")
	}
}

// TestWebhookEndpoints 走真实 HTTP 栈：新增 → 列表 → 启用 → 测试 → 删除。
func TestWebhookEndpoints(t *testing.T) {
	srv, session, csrf := alertsAuthServer(t, nil, &fakeAlertSink{})
	create := `{"kind":"webhook","url":"https://example.com/hook","events":["audit"],"severities":["critical"],"secret":"tok"}`
	rec := alertsRequest(t, srv, http.MethodPost, "/api/v1/webhook", session, csrf, strings.NewReader(create))
	if rec.Code != http.StatusOK {
		t.Fatalf("新增通道 HTTP %d：%s", rec.Code, rec.Body.String())
	}
	var created struct {
		Target ChannelTarget `json:"target"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if created.Target.ID == "" || created.Target.Enabled || !created.Target.SecretSet {
		t.Fatalf("新增响应不符: %+v", created.Target)
	}
	if strings.Contains(rec.Body.String(), "tok") && strings.Contains(rec.Body.String(), `"secret"`) {
		t.Fatalf("响应泄漏了密钥明文")
	}

	rec = alertsRequest(t, srv, http.MethodGet, "/api/v1/webhook", session, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("列表 HTTP %d：%s", rec.Code, rec.Body.String())
	}
	var listed webhookListBody
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("列表不是 JSON: %v", err)
	}
	if len(listed.Targets) != 1 || listed.Targets[0].ID != created.Target.ID {
		t.Fatalf("列表不符: %+v", listed.Targets)
	}

	rec = alertsRequest(t, srv, http.MethodPatch, "/api/v1/webhook/"+created.Target.ID, session, csrf,
		strings.NewReader(`{"enabled":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("启用 HTTP %d：%s", rec.Code, rec.Body.String())
	}
	var updated webhookUpdateResp
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil || !updated.Target.Enabled {
		t.Fatalf("启用响应不符: %s", rec.Body.String())
	}

	// 测试：未知 id 回 404。
	rec = alertsRequest(t, srv, http.MethodPost, "/api/v1/webhook/nope/test", session, csrf, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知通道测试应回 404，实际 %d", rec.Code)
	}

	rec = alertsRequest(t, srv, http.MethodDelete, "/api/v1/webhook/"+created.Target.ID, session, csrf, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("删除 HTTP %d：%s", rec.Code, rec.Body.String())
	}
	rec = alertsRequest(t, srv, http.MethodGet, "/api/v1/webhook", session, "", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Targets) != 0 {
		t.Fatalf("删除后列表仍非空: %+v", listed.Targets)
	}
}

// TestWebhookEmailChannelEndpoint 验证邮件通道可经 HTTP 新增，且口令不回传。
func TestWebhookEmailChannelEndpoint(t *testing.T) {
	srv, session, csrf := alertsAuthServer(t, nil, &fakeAlertSink{})
	body := `{"kind":"email","events":["resource"],"email":{"host":"smtp.example.com","port":465,"tls":"ssl","user":"bot@example.com","password":"mail-pass","from":"bot@example.com","recipients":["ops@example.com"]}}`
	rec := alertsRequest(t, srv, http.MethodPost, "/api/v1/webhook", session, csrf, strings.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("新增邮件通道 HTTP %d：%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "mail-pass") {
		t.Fatalf("响应泄漏 SMTP 口令")
	}
	var created struct {
		Target ChannelTarget `json:"target"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if created.Target.Kind != channelKindEmail || created.Target.Email == nil ||
		!created.Target.Email.PasswordSet || created.Target.Email.Port != 465 {
		t.Fatalf("邮件视图不符: %+v", created.Target)
	}
}
