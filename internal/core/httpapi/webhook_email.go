package httpapi

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// 邮件通道：标准库 net/smtp + crypto/tls，不引入第三方 SMTP SDK（G-02）。
//
//   - 加密方式三选一：starttls（默认 587）/ ssl 隐式 TLS（465）/ none 明文（25，仅本机中继；
//     此时若填了账号，net/smtp 会拒绝在明文连接上发口令，属预期行为）；
//   - 口令只在进程内存，日志 / 历史里只出现 smtp host:port 与服务器返回码（G-30）；
//   - 连接、握手、认证、投递全部套同一个 channelSMTPTimeout 截止时间，不会挂死；
//   - 失败最多重试 emailMaxAttempts 次（认证类错误重试没有意义，但保持有界、简单）。

const emailMaxAttempts = 2

// sendChannelEmail 投递一封告警邮件；返回（HTTP 码恒 0，尝试次数，错误）。
func sendChannelEmail(st *channelStored, p webhookPayload) (int, int, error) {
	if st.view.Email == nil {
		return 0, 1, fmt.Errorf("邮件通道配置缺失")
	}
	cfg := st.view.Email
	subject := "[Kore] " + p.Title
	body := buildEmailBody(p)
	msg := buildEmailMessage(cfg.From, cfg.Recipients, subject, body)
	var lastErr error
	for attempt := 1; attempt <= emailMaxAttempts; attempt++ {
		lastErr = smtpSendOnce(cfg, st.secret, msg)
		if lastErr == nil {
			return 0, attempt, nil
		}
		if attempt < emailMaxAttempts {
			timer := time.NewTimer(time.Duration(channelRetryBaseMs*attempt) * time.Millisecond)
			<-timer.C
			timer.Stop()
		}
	}
	return 0, emailMaxAttempts, lastErr
}

// buildEmailBody 是邮件正文（纯文本，中文直出；UTF-8 + base64 传输）。
func buildEmailBody(p webhookPayload) string {
	lines := []string{
		"Kore 告警通知",
		"",
		"标题：" + p.Title,
		"级别：" + imSeverityLabel(p.Severity) + "（" + p.Severity + "）",
		"来源：" + p.Source,
		"时间：" + p.Time,
		"",
	}
	if p.Detail != "" {
		lines = append(lines, "详情：", p.Detail, "")
	}
	if p.Test {
		lines = append(lines, "这是一条测试消息：收到说明通道配置可用。", "")
	}
	lines = append(lines, "—— 由 Kore 按你的配置发送；可在「通知通道」页关闭。")
	return strings.Join(lines, "\n")
}

// buildEmailMessage 生成 RFC 5322 报文（Subject 用 RFC 2047 编码，正文 base64 换行）。
func buildEmailMessage(from string, recipients []string, subject, body string) []byte {
	var b bytes.Buffer
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + strings.Join(recipients, ", ") + "\r\n")
	b.WriteString("Subject: " + mime.BEncoding.Encode("UTF-8", subject) + "\r\n")
	b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	encoded := base64.StdEncoding.EncodeToString([]byte(body))
	for len(encoded) > 76 {
		b.WriteString(encoded[:76] + "\r\n")
		encoded = encoded[76:]
	}
	b.WriteString(encoded + "\r\n")
	return b.Bytes()
}

// smtpSendOnce 建立一次连接并完成投递（整段受 channelSMTPTimeout 截止时间约束）。
// 错误信息只带阶段与服务器返回原文（不含口令），便于在「投递记录」里看到失败原因。
func smtpSendOnce(cfg *ChannelEmail, password string, msg []byte) error {
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	dialer := &net.Dialer{Timeout: channelSMTPTimeout}
	var conn net.Conn
	var err error
	if cfg.TLS == smtpTLSImplicit {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName: cfg.Host, MinVersion: tls.VersionTLS12,
		})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("连接邮件服务器 %s 失败：%v", addr, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(channelSMTPTimeout))
	c, err := smtp.NewClient(conn, cfg.Host)
	if err != nil {
		return fmt.Errorf("邮件服务器握手失败：%v", err)
	}
	defer c.Close()
	if cfg.TLS == smtpTLSStartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("邮件服务器不支持 STARTTLS，请把加密方式改成 SSL")
		}
		if err := c.StartTLS(&tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("STARTTLS 握手失败：%v", err)
		}
	}
	if cfg.User != "" {
		if ok, _ := c.Extension("AUTH"); !ok {
			return fmt.Errorf("邮件服务器不支持账号认证，请检查账号配置或改用不需要认证的中继")
		}
		if err := c.Auth(smtp.PlainAuth("", cfg.User, password, cfg.Host)); err != nil {
			return fmt.Errorf("邮件账号认证失败：%v", err)
		}
	}
	if err := c.Mail(cfg.From); err != nil {
		return fmt.Errorf("发件人被服务器拒绝：%v", err)
	}
	for _, rcpt := range cfg.Recipients {
		if err := c.Rcpt(rcpt); err != nil {
			return fmt.Errorf("收件人 %s 被服务器拒绝：%v", rcpt, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("服务器拒绝接收邮件内容：%v", err)
	}
	if _, err := w.Write(msg); err != nil {
		_ = w.Close()
		return fmt.Errorf("发送邮件内容失败：%v", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("发送邮件内容失败：%v", err)
	}
	_ = c.Quit()
	return nil
}
