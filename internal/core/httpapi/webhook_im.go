package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// IM 机器人通道（企业微信 / 钉钉 / 飞书）：三家都是「POST 一个 Webhook 地址 + JSON 体」，
// 差别只在 payload 形状与加签算法；统一用标准库 net/http 发出，不引入任何 SDK。
//
// 加签（用户填了密钥才做）：
//   - 钉钉：sign = base64(HMAC-SHA256(key=secret, data=timestamp+"\n"+secret))，拼在 URL 查询串；
//   - 飞书：sign = base64(HMAC-SHA256(key=timestamp+"\n"+secret, data=""))，放在 body。
// 两家官方文档的算法方向不同，不要「统一」成一个函数。
//
// 密钥只在进程内存，绝不进日志（G-30）；失败原因取网关返回的 errcode/errmsg。

const imContentMaxRunes = 3000

// imSeverityLabel 把级别翻成中文（机器人消息里给人看）。
func imSeverityLabel(severity string) string {
	switch severity {
	case alertSeverityCritical:
		return "严重"
	case alertSeverityWarning:
		return "警告"
	default:
		return "提示"
	}
}

// imBody 是机器人消息正文（纯文本；企业微信 / 钉钉走 markdown，飞书走 text）。
func imBody(p webhookPayload) string {
	head := "【Kore 告警】" + p.Title
	lines := []string{
		head,
		"级别：" + imSeverityLabel(p.Severity) + "（" + p.Severity + "）",
		"来源：" + p.Source,
	}
	if p.Detail != "" {
		lines = append(lines, "详情："+p.Detail)
	}
	lines = append(lines, "时间："+p.Time)
	if p.Test {
		lines = append(lines, "这是一条测试消息：收到说明通道配置可用。")
	}
	return truncateRunes(strings.Join(lines, "\n"), imContentMaxRunes)
}

// 以下三个结构体是三家网关的请求体（显式字段，G-24）。
type imMarkdownContent struct {
	Content string `json:"content"`
}

type imWeComBody struct {
	MsgType  string            `json:"msgtype"`
	Markdown imMarkdownContent `json:"markdown"`
}

type imDingTalkMarkdown struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

type imDingTalkBody struct {
	MsgType  string             `json:"msgtype"`
	Markdown imDingTalkMarkdown `json:"markdown"`
}

type imFeishuText struct {
	Text string `json:"text"`
}

type imFeishuBody struct {
	MsgType   string       `json:"msg_type"`
	Content   imFeishuText `json:"content"`
	Timestamp string       `json:"timestamp,omitempty"`
	Sign      string       `json:"sign,omitempty"`
}

// imResponseBody 兼容三家网关的错误响应形状（errcode / code / StatusCode）。
type imResponseBody struct {
	ErrCode    int    `json:"errcode"`
	Code       int    `json:"code"`
	StatusCode int    `json:"StatusCode"`
	ErrMsg     string `json:"errmsg"`
	Msg        string `json:"msg"`
	StatusMsg  string `json:"StatusMsg"`
}

// signHMACBase64 是两家共用的 HMAC-SHA256 + base64 原语。
func signHMACBase64(key, message string) string {
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(message))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// signDingTalk 按钉钉文档：key=secret、data=timestamp+"\n"+secret。
func signDingTalk(secret string, ts int64) string {
	return signHMACBase64(secret, strconv.FormatInt(ts, 10)+"\n"+secret)
}

// signFeishu 按飞书文档：key=timestamp+"\n"+secret、data 为空。
func signFeishu(secret string, ts int64) string {
	return signHMACBase64(strconv.FormatInt(ts, 10)+"\n"+secret, "")
}

// buildIMRequest 生成一次投递的 URL 与 body（含加签）。
func buildIMRequest(kind, secret, rawURL string, p webhookPayload, at time.Time) (string, []byte, error) {
	ts := at.Unix()
	var body []byte
	var err error
	reqURL := rawURL
	switch kind {
	case imKindWeCom:
		content := "### " + p.Title + "\n> 级别：" + imSeverityLabel(p.Severity) + "\n> 来源：" + p.Source
		if p.Detail != "" {
			content += "\n\n" + p.Detail
		}
		content += "\n\n" + p.Time + " · Kore"
		body, err = json.Marshal(imWeComBody{
			MsgType:  "markdown",
			Markdown: imMarkdownContent{Content: truncateRunes(content, imContentMaxRunes)},
		})
	case imKindDingTalk:
		text := "### " + p.Title + "\n\n"
		if p.Detail != "" {
			text += p.Detail + "\n\n"
		}
		text += "> 级别：" + imSeverityLabel(p.Severity) + "\n\n> 来源：" + p.Source + "\n\n> " +
			p.Time + " · Kore"
		if secret != "" {
			u, perr := url.Parse(rawURL)
			if perr != nil {
				return "", nil, fmt.Errorf("机器人地址无效")
			}
			q := u.Query()
			q.Set("timestamp", strconv.FormatInt(ts, 10))
			q.Set("sign", signDingTalk(secret, ts))
			u.RawQuery = q.Encode()
			reqURL = u.String()
		}
		body, err = json.Marshal(imDingTalkBody{
			MsgType: "markdown",
			Markdown: imDingTalkMarkdown{
				Title: p.Title, Text: truncateRunes(text, imContentMaxRunes),
			},
		})
	case imKindFeishu:
		msg := imBody(p)
		out := imFeishuBody{MsgType: "text", Content: imFeishuText{Text: msg}}
		if secret != "" {
			out.Timestamp = strconv.FormatInt(ts, 10)
			out.Sign = signFeishu(secret, ts)
		}
		body, err = json.Marshal(out)
	default:
		return "", nil, fmt.Errorf("不支持的机器人类型")
	}
	if err != nil {
		return "", nil, fmt.Errorf("构造机器人消息失败")
	}
	return reqURL, body, nil
}

// imResponseError 解析机器人网关的业务错误码（HTTP 200 也可能是失败）。
func imResponseError(raw []byte) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	var body imResponseBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil // 非 JSON 响应交给 HTTP 状态码判定（自建网关可能返回纯文本 ok）
	}
	code := body.ErrCode
	if body.Code != 0 {
		code = body.Code
	}
	if body.StatusCode != 0 {
		code = body.StatusCode
	}
	if code == 0 {
		return nil
	}
	msg := body.ErrMsg
	if msg == "" {
		msg = body.Msg
	}
	if msg == "" {
		msg = body.StatusMsg
	}
	if msg == "" {
		return fmt.Errorf("机器人返回错误码 %d", code)
	}
	return fmt.Errorf("机器人返回错误码 %d：%s", code, truncateRunes(msg, 120))
}
