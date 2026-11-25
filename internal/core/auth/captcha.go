package auth

// 本地图形验证码：stdlib 生成 PNG + 进程内存 challenge（sha256 / TTL / 一次性）。
// 零第三方依赖、零字体文件、零网络请求（G-02 / G-10）；无后台 goroutine / ticker（G-19）。
// 答案明文只在本文件内的短暂局部变量存在，落进内存状态的就是 sha256 摘要。

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// CaptchaChars 是图形验证码字符数。
	CaptchaChars = 5
	// CaptchaTTL 是 challenge 的有效期：2 分钟。
	CaptchaTTL = 2 * time.Minute
	// CaptchaIssueWindow / CaptchaIssueLimit 是验证码端点的轻量全局限流。
	CaptchaIssueWindow = time.Minute
	CaptchaIssueLimit  = 10
	// captchaIDBytes 是 challenge id 的随机字节数（hex 32 字符）。
	captchaIDBytes = 16
	// captchaImageWidth / captchaImageHeight 是 PNG 画布尺寸。
	captchaImageWidth  = 140
	captchaImageHeight = 44
	// captchaScale 是 5×7 点阵字形的放大倍数。
	captchaScale = 4
	// captchaNoiseDots / captchaNoiseLines 是干扰强度。
	captchaNoiseDots  = 110
	captchaNoiseLines = 3
)

// captchaAlphabet 去掉了 0/O、1/l/I 等易混淆字符。
const captchaAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

// CaptchaVerifyResult 是验证码校验结果，显式枚举（G-24）。
type CaptchaVerifyResult int

const (
	// CaptchaMissing 表示缺 id / 答案，或未签发过的 id。
	CaptchaMissing CaptchaVerifyResult = iota
	// CaptchaExpired 表示 challenge 已过期。
	CaptchaExpired
	// CaptchaInvalid 表示答案不符（challenge 已一次性消费）。
	CaptchaInvalid
	// CaptchaOK 表示答案正确（challenge 已一次性消费）。
	CaptchaOK
)

// ErrCaptchaRateLimited 表示验证码端点超出轻量限流（10 次/分钟）。
var ErrCaptchaRateLimited = errors.New("验证码请求过于频繁")

// CaptchaChallenge 是 GET /api/v1/auth/captcha 的公开响应视图：绝不含答案。
type CaptchaChallenge struct {
	// ID 是 challenge 标识，登录时原样回传。
	ID string
	// Image 是 data:image/png;base64,... 形式的图形验证码。
	Image string
	// TextQuestion 是同一 challenge 的文本加法替代（无图形能力场景用）。
	TextQuestion string
	// ExpiresIn 是剩余有效秒数。
	ExpiresIn int
}

// captchaEntry 是内存里的 challenge 状态：只存摘要，不存明文答案。
type captchaEntry struct {
	imageHash [32]byte
	textHash  [32]byte
	expiresAt time.Time
}

// CaptchaStore 持有 challenge 表与"是否需要验证码"的全局标记。
//
// 标记一次性置位（首次口令错误），只有登录成功或 CLI 重置凭据清零；
// 静默超时只清延时等级（LoginLimiter.lockout），不清本标记（fail-secure）。
type CaptchaStore struct {
	mu         sync.Mutex
	challenges map[string]*captchaEntry
	required   bool
	issued     []time.Time
	now        func() time.Time
}

// NewCaptchaStore 构造空的 challenge 状态；生产与测试同构。
func NewCaptchaStore() *CaptchaStore {
	return &CaptchaStore{challenges: make(map[string]*captchaEntry), now: time.Now}
}

// Required 报告当前是否处于"必须过验证码"的挑战态。
func (s *CaptchaStore) Required() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.required
}

// Require 置挑战态（首次口令错误时调用，幂等）。
func (s *CaptchaStore) Require() {
	s.mu.Lock()
	s.required = true
	s.mu.Unlock()
}

// Clear 清挑战态与全部未消费 challenge（仅登录成功 / CLI 重置凭据调用）。
func (s *CaptchaStore) Clear() {
	s.mu.Lock()
	s.required = false
	s.challenges = make(map[string]*captchaEntry)
	s.mu.Unlock()
}

// Issue 生成一个新 challenge：图形 5 字符 + 同 challenge 的文本加法题。
// 超出 10 次/分钟返回 ErrCaptchaRateLimited。
func (s *CaptchaStore) Issue() (CaptchaChallenge, error) {
	chars := make([]byte, CaptchaChars)
	if _, err := rand.Read(chars); err != nil {
		return CaptchaChallenge{}, err
	}
	for i := range chars {
		chars[i] = captchaAlphabet[int(chars[i])%len(captchaAlphabet)]
	}
	idBuf := make([]byte, captchaIDBytes)
	if _, err := rand.Read(idBuf); err != nil {
		return CaptchaChallenge{}, err
	}
	a, b := 1+int(chars[0]%9), 1+int(chars[1]%9)
	question := strconv.Itoa(a) + " + " + strconv.Itoa(b) + " = ?"
	answer := strconv.Itoa(a + b)
	id := hexEncode(idBuf)
	imageHash := sha256.Sum256([]byte(strings.ToUpper(string(chars))))
	textHash := sha256.Sum256([]byte(answer))
	pngBytes, err := renderCaptchaPNG(string(chars))
	if err != nil {
		return CaptchaChallenge{}, err
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	if len(s.issued) >= CaptchaIssueLimit {
		return CaptchaChallenge{}, ErrCaptchaRateLimited
	}
	s.issued = append(s.issued, now)
	s.challenges[id] = &captchaEntry{imageHash: imageHash, textHash: textHash, expiresAt: now.Add(CaptchaTTL)}
	return CaptchaChallenge{
		ID: id, Image: "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes),
		TextQuestion: question, ExpiresIn: int(CaptchaTTL / time.Second),
	}, nil
}

// Verify 校验一次答案：无论对错都立即删除 challenge（一次性）。
// 图形答案与文本加法题答案都接受，二者走同一个 challenge id。
func (s *CaptchaStore) Verify(id, answer string) CaptchaVerifyResult {
	id = strings.TrimSpace(id)
	answer = strings.TrimSpace(answer)
	if id == "" || answer == "" {
		return CaptchaMissing
	}
	s.mu.Lock()
	entry, ok := s.challenges[id]
	if ok {
		delete(s.challenges, id) // 一次性：校验后立即删除，对错都是
	}
	s.mu.Unlock()
	if !ok {
		return CaptchaMissing
	}
	if !s.now().Before(entry.expiresAt) {
		return CaptchaExpired
	}
	candidate := sha256.Sum256([]byte(strings.ToUpper(answer)))
	if subtle.ConstantTimeCompare(candidate[:], entry.imageHash[:]) == 1 ||
		subtle.ConstantTimeCompare(candidate[:], entry.textHash[:]) == 1 {
		return CaptchaOK
	}
	return CaptchaInvalid
}

// pruneLocked 惰性清理过期 challenge 与滑出窗口的签发记录（调用方持锁；零 goroutine）。
func (s *CaptchaStore) pruneLocked(now time.Time) {
	cutoff := now.Add(-CaptchaIssueWindow)
	kept := s.issued[:0]
	for _, t := range s.issued {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	s.issued = kept
	for id, entry := range s.challenges {
		if !now.Before(entry.expiresAt) {
			delete(s.challenges, id)
		}
	}
}

// hexEncode 是小工具：避免为 16 字节 id 再引入一个包级 helper。
func hexEncode(b []byte) string {
	const digits = "0123456789abcdef"
	var out strings.Builder
	out.Grow(len(b) * 2)
	for _, v := range b {
		out.WriteByte(digits[v>>4])
		out.WriteByte(digits[v&0x0f])
	}
	return out.String()
}

// renderCaptchaPNG 用内嵌 5×7 点阵字形画验证码 PNG，附随机噪点与干扰线。
func renderCaptchaPNG(text string) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, captchaImageWidth, captchaImageHeight))
	bg := color.RGBA{R: 246, G: 248, B: 252, A: 255}
	for y := 0; y < captchaImageHeight; y++ {
		for x := 0; x < captchaImageWidth; x++ {
			img.Set(x, y, bg)
		}
	}
	noise := make([]byte, captchaNoiseDots*3+captchaNoiseLines*4)
	if _, err := rand.Read(noise); err != nil {
		return nil, err
	}
	for i := 0; i < captchaNoiseDots; i++ {
		x := int(noise[i*3]) % captchaImageWidth
		y := int(noise[i*3+1]) % captchaImageHeight
		shade := uint8(170 + int(noise[i*3+2])%70)
		img.Set(x, y, color.RGBA{R: shade, G: shade, B: shade, A: 255})
	}
	for i := 0; i < captchaNoiseLines; i++ {
		base := captchaNoiseDots*3 + i*4
		x0, y0 := int(noise[base])%captchaImageWidth, int(noise[base+1])%captchaImageHeight
		x1, y1 := int(noise[base+2])%captchaImageWidth, int(noise[base+3])%captchaImageHeight
		steps := captchaImageWidth
		for k := 0; k <= steps; k++ {
			x := x0 + (x1-x0)*k/steps
			y := y0 + (y1-y0)*k/steps
			img.Set(x, y, color.RGBA{R: 205, G: 210, B: 220, A: 255})
		}
	}
	cellW := 6 * captchaScale
	left := (captchaImageWidth - len(text)*cellW + captchaScale) / 2
	top := (captchaImageHeight - 7*captchaScale) / 2
	for i := 0; i < len(text) && i < CaptchaChars; i++ {
		rows := glyph(text[i])
		for row, bits := range rows {
			for col := 0; col < 5; col++ {
				if bits&(1<<uint(4-col)) == 0 {
					continue
				}
				fx := left + i*cellW + col*captchaScale
				fy := top + row*captchaScale
				for dy := 0; dy < captchaScale; dy++ {
					for dx := 0; dx < captchaScale; dx++ {
						img.Set(fx+dx, fy+dy, color.RGBA{R: 28, G: 42, B: 70, A: 255})
					}
				}
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// glyph 返回 '0'-'9' / 'A'-'Z' 的 5×7 点阵字形（每行低 5 位有效，bit4 为最左列）。
func glyph(c byte) [7]byte {
	switch {
	case c >= '0' && c <= '9':
		return digitGlyphs[c-'0']
	case c >= 'A' && c <= 'Z':
		return letterGlyphs[c-'A']
	default:
		return [7]byte{}
	}
}

var digitGlyphs = [10][7]byte{
	{0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E}, // 0
	{0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E}, // 1
	{0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F}, // 2
	{0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E}, // 3
	{0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02}, // 4
	{0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E}, // 5
	{0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E}, // 6
	{0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08}, // 7
	{0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E}, // 8
	{0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C}, // 9
}

var letterGlyphs = [26][7]byte{
	{0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11}, // A
	{0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E}, // B
	{0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E}, // C
	{0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C}, // D
	{0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F}, // E
	{0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10}, // F
	{0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F}, // G
	{0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11}, // H
	{0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E}, // I
	{0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C}, // J
	{0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11}, // K
	{0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F}, // L
	{0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11}, // M
	{0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11}, // N
	{0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E}, // O
	{0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10}, // P
	{0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D}, // Q
	{0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11}, // R
	{0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E}, // S
	{0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04}, // T
	{0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E}, // U
	{0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04}, // V
	{0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11}, // W
	{0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11}, // X
	{0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04}, // Y
	{0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F}, // Z
}
