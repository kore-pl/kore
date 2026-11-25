package auth

// 本文件记录"管理员口令的强度评估与上次修改时间"，供「账户与安全中心」的
// 账户状态总览展示。口令明文永不落库：强度只在改口令成功的那一刻用明文算一次，
// 存储的只有 {修改时刻, 分数, 标签} 三个标量（G-30：不含任何口令片段）。
//
// 读侧口径（诚实优先）：
//   - 从未在本面板改过口令（含用 CLI 设的初始口令）→ ChangedAt 为空、Score=-1，
//     前端显示「未评估」并提供「现在评估一次（改口令）」入口，绝不伪造一个强度。
//   - 旧版本升级上来的实例：首次启动只落指纹、不补 ChangedAt（无法知道真实时刻）。
//   - 通过 CLI 改口令后重启：ReconcilePasswordFingerprint 检测到指纹变化，
//     记 ChangedAt=检测时刻 且 Score=-1（未知），前端显示「命令行修改，强度未评估」。
import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// passwordMetaKey 是口令元信息在 meta bucket 内的键（与 security.* 命名空间一致）。
const passwordMetaKey = "security.password"

// 口令强度分数语义（0-4）：分数越高越长/越杂；-1 表示未评估。
const (
	// PasswordScoreUnknown 表示没有可评估的明文（口令由 CLI 设置或升级前遗留）。
	PasswordScoreUnknown = -1
	// PasswordScoreMax 是分数上限。
	PasswordScoreMax = 4
	// passwordMetaLabelUnknown 是"未评估"的固定文案。
	passwordMetaLabelUnknown = "未评估"
)

// passwordMeta 是落库的口令元信息（显式字段，无 any/object，G-24）。
type passwordMeta struct {
	// ChangedAt 是最后观察到口令变更的时刻（RFC3339 UTC）。
	ChangedAt string
	// Score 是 0-4 的强度分；-1 表示未评估。
	Score int
	// Label 是分数的中文标签（弱 / 较弱 / 一般 / 强 / 很强 / 未评估）。
	Label string
	// Source 是变更来源：ui（面板改口令）/ cli（启动时检测到命令行改过）/ unknown。
	Source string
}

// PasswordMetaView 是对外视图（G-24 显式字段）。
type PasswordMetaView struct {
	// ChangedAt 是上次修改时刻（RFC3339；空串表示未知）。
	ChangedAt string
	// Score 是 0-4 的强度分；-1 表示未评估。
	Score int
	// Label 是中文标签。
	Label string
	// Source 是变更来源（ui / cli / unknown）。
	Source string
	// HashAlgorithm 是存储哈希算法名（只读陈述，口令本身不可读回）。
	HashAlgorithm string
	// HashIterations 是 PBKDF2 迭代次数。
	HashIterations int
}

// commonPasswords 是明显弱口令的短清单（只做"一看就是弱口令"的兜底，不做字典）。
var commonPasswords = map[string]struct{}{
	"password": {}, "passw0rd": {}, "12345678": {}, "123456789": {}, "1234567890": {},
	"admin": {}, "admin123": {}, "administrator": {}, "qwerty123": {}, "iloveyou": {},
	"kore": {}, "koreadmin": {}, "changeme": {}, "letmein": {}, "welcome": {},
}

// letterClass / digitClass / symbolClass 用于统计字符种类。
var (
	letterClass = regexp.MustCompile("[A-Za-z]")
	digitClass  = regexp.MustCompile("[0-9]")
	symbolClass = regexp.MustCompile("[^A-Za-z0-9]")
)

// PasswordStrength 评估明文口令强度：返回 0-4 分与中文标签。
//
// 判据（单一真源，前端提示与后端落库共用同一套口径）：
//   - 明显弱口令（常见口令 / 全部同一字符 / 少于 10 位）→ 0 弱；
//   - 基础分：长度 ≥10、≥14、≥18 各得 1 分；
//   - 字符种类（小写 / 大写 / 数字 / 符号）≥3 得 1 分；
//   - 总分封顶 4；0=弱 1=较弱 2=一般 3=强 4=很强。
//
// 只做"够不够用"的判断，不做密码库比对，不引入依赖（G-02）。
func PasswordStrength(plain string) (int, string) {
	plain = strings.TrimSpace(plain)
	if plain == "" {
		return PasswordScoreUnknown, passwordMetaLabelUnknown
	}
	if len([]rune(plain)) < 10 {
		return 0, "弱"
	}
	lower := strings.ToLower(plain)
	if _, weak := commonPasswords[lower]; weak {
		return 0, "弱"
	}
	if strings.Count(lower, string(lower[0])) == len(lower) {
		return 0, "弱" // 全是同一个字符，如 aaaaa...
	}
	score := 0
	n := len([]rune(plain))
	if n >= 10 {
		score++
	}
	if n >= 14 {
		score++
	}
	if n >= 18 {
		score++
	}
	classes := 0
	if letterClass.MatchString(plain) {
		classes++
	}
	if strings.ToLower(plain) != plain {
		classes++
	}
	if digitClass.MatchString(plain) {
		classes++
	}
	if symbolClass.MatchString(plain) {
		classes++
	}
	if classes >= 3 {
		score++
	}
	if score > PasswordScoreMax {
		score = PasswordScoreMax
	}
	return score, passwordStrengthLabel(score)
}

// passwordStrengthLabel 把分数映射成中文标签。
func passwordStrengthLabel(score int) string {
	switch score {
	case 0:
		return "弱"
	case 1:
		return "较弱"
	case 2:
		return "一般"
	case 3:
		return "强"
	case 4:
		return "很强"
	default:
		return passwordMetaLabelUnknown
	}
}

// PasswordMeta 读取口令元信息（含存储算法与迭代次数）。未记录时返回"未评估"。
func (sec *Security) PasswordMeta() (PasswordMetaView, error) {
	view := PasswordMetaView{
		Score: PasswordScoreUnknown, Label: passwordMetaLabelUnknown, Source: "unknown",
		HashAlgorithm: HashAlgorithm, HashIterations: HashIterations,
	}
	if sec == nil {
		return view, ErrSecurityUnavailable
	}
	var meta passwordMeta
	if err := sec.loadKey(passwordMetaKey, &meta); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return view, nil
		}
		return view, err
	}
	if meta.ChangedAt != "" {
		view.ChangedAt = meta.ChangedAt
	}
	if meta.Score >= 0 && meta.Score <= PasswordScoreMax {
		view.Score = meta.Score
		view.Label = passwordStrengthLabel(meta.Score)
	}
	if meta.Source != "" {
		view.Source = meta.Source
	}
	return view, nil
}

// RecordPasswordChange 在面板改口令成功后记录修改时刻与强度评估。
// 只写标量元信息，明文与哈希都不落库（哈希由配置层负责）。
func (sec *Security) RecordPasswordChange(plain string) error {
	if sec == nil {
		return ErrSecurityUnavailable
	}
	score, label := PasswordStrength(plain)
	return sec.putPasswordMeta(passwordMeta{
		ChangedAt: nowRFC3339(), Score: score, Label: label, Source: "ui",
	})
}

// NotePasswordChangedExternally 在启动时检测到口令指纹变化（命令行改过）后记录
// "改过、但强度未知"。ChangedAt 是检测时刻而不是真实修改时刻，前端文案必须
// 说明这是检测时间，不能伪装成精确时间。
func (sec *Security) NotePasswordChangedExternally(at time.Time) error {
	if sec == nil {
		return ErrSecurityUnavailable
	}
	return sec.putPasswordMeta(passwordMeta{
		ChangedAt: at.UTC().Format(time.RFC3339), Score: PasswordScoreUnknown,
		Label: passwordMetaLabelUnknown, Source: "cli",
	})
}

// putPasswordMeta 持久化口令元信息。
func (sec *Security) putPasswordMeta(meta passwordMeta) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	if err := sec.store.Update(func(tx *store.Tx) error {
		return tx.Put(securityBucket, passwordMetaKey, data)
	}); err != nil {
		return fmt.Errorf("记录口令元信息失败: %w", err)
	}
	return nil
}
