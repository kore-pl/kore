package store

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

// 审计结果取值与字段上限（docs/DATA-MODEL.md §9）。
const (
	// AuditResultOK 表示动作成功。
	AuditResultOK = "ok"
	// AuditResultDenied 表示权限/限流拒绝。
	AuditResultDenied = "denied"
	// AuditResultError 表示动作失败。
	AuditResultError = "error"

	// auditDetailMaxKeys / auditDetailMaxKeyLen / auditDetailMaxValLen 是 detail 约束：
	// 键数 ≤16、键 ≤32 字符、值 ≤256 字符（长度按字符计，与文档口径一致）。
	auditDetailMaxKeys   = 16
	auditDetailMaxKeyLen = 32
	auditDetailMaxValLen = 256
	// auditDetailMaxBytes 是 detail 序列化后总长上限 1 KiB。
	auditDetailMaxBytes = 1 << 10
	// maxAuditSeq 是键中序号段的上限（%06d 的 999999）。
	maxAuditSeq = 999_999
)

// AuditRecord 是一条审计记录。字段全为标量或受控 map[string]string（G-24：无 any/object）。
// Key 只在查询结果里回填（存储值不含键），格式 `%020d-%06d`（unix 纳秒 + 序号）。
type AuditRecord struct {
	Key     string            `json:"-"`
	Subject string            `json:"subject"`
	Action  string            `json:"action"`
	Plugin  string            `json:"plugin"`
	Target  string            `json:"target"`
	Result  string            `json:"result"`
	Detail  map[string]string `json:"detail,omitempty"`
}

// PutAudit 追加一条审计记录。键 = 20 位 unix 纳秒 + "-" + 6 位序号，字典序即时间序
// （DATA-MODEL §5）；同纳秒内序号递增，时钟回拨沿用末键纳秒继续编序，保证严格递增。
//
// 用 Store.Update（bbolt Update 写事务），不用 Batch —— bbolt Batch 内部会起
// 批量触发定时器与 goroutine（bbolt db.go:953/958），会破 G-19 与
// 「audit 写入不得起 goroutine/ticker」；也无显式 fsync（bbolt 事务提交自带，
// DATA-MODEL §6.6 NoSync:false），事件路径只多一次小事务。
// detail 受控校验（DATA-MODEL §9）：非法即记 WARN 并拒绝写入，不落库。
func (s *Store) PutAudit(rec AuditRecord) error {
	if err := validateAudit(rec); err != nil {
		slog.Warn("审计记录非法，已拒绝写入", "action", rec.Action, "plugin", rec.Plugin, "err", err)
		return err
	}
	value, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("序列化审计记录失败: %w", err)
	}
	if len(value) > MaxValueSize {
		return fmt.Errorf("%w: audit/%s 为 %d 字节", ErrValueTooLarge, rec.Action, len(value))
	}
	return s.Update(func(tx *Tx) error {
		b, err := tx.bucket(bucketAudit)
		if err != nil {
			return err
		}
		return b.Put([]byte(nextAuditKey(b, time.Now())), value)
	})
}

// validateAudit 按 DATA-MODEL §9 校验：result ∈ ok/denied/error；detail 键 ≤32 字符、
// 值 ≤256 字符、键数 ≤16 且序列化 ≤1 KiB。
func validateAudit(rec AuditRecord) error {
	switch rec.Result {
	case AuditResultOK, AuditResultDenied, AuditResultError:
	default:
		return fmt.Errorf("%w: result=%q 不在 ok/denied/error 内", ErrAuditInvalid, rec.Result)
	}
	if len(rec.Detail) > auditDetailMaxKeys {
		return fmt.Errorf("%w: detail 键数 %d > %d", ErrAuditInvalid, len(rec.Detail), auditDetailMaxKeys)
	}
	for key, value := range rec.Detail {
		if len([]rune(key)) > auditDetailMaxKeyLen {
			return fmt.Errorf("%w: detail 键 %q 超过 %d 字符", ErrAuditInvalid, key, auditDetailMaxKeyLen)
		}
		if len([]rune(value)) > auditDetailMaxValLen {
			return fmt.Errorf("%w: detail[%s] 超过 %d 字符", ErrAuditInvalid, key, auditDetailMaxValLen)
		}
	}
	if rec.Detail != nil {
		raw, err := json.Marshal(rec.Detail)
		if err != nil {
			return fmt.Errorf("%w: detail 序列化失败: %v", ErrAuditInvalid, err)
		}
		if len(raw) > auditDetailMaxBytes {
			return fmt.Errorf("%w: detail 序列化后 %d 字节 > %d", ErrAuditInvalid, len(raw), auditDetailMaxBytes)
		}
	}
	return nil
}

// nextAuditKey 在写事务内生成下一个审计键：读末键定序号，时钟回拨或同纳秒时沿用
// 末键纳秒继续编序，保证同 bucket 内键严格递增（字典序 = 时间序，不依赖进程内计数器）。
func nextAuditKey(b *bolt.Bucket, now time.Time) string {
	ts := now.UnixNano()
	seq := 0
	if last, _ := b.Cursor().Last(); last != nil {
		if lastTS, lastSeq, ok := parseAuditKey(string(last)); ok {
			if ts <= lastTS {
				ts, seq = lastTS, lastSeq+1
			}
		}
	}
	if seq > maxAuditSeq {
		ts, seq = ts+1, 0 // 同一纳秒序号写满：纳秒进一位，仍严格递增
	}
	return fmt.Sprintf("%020d-%06d", ts, seq)
}

// parseAuditKey 解析 `%020d-%06d` 键；任一段非法返回 ok=false（不猜）。
func parseAuditKey(key string) (int64, int, bool) {
	dash := strings.IndexByte(key, '-')
	if dash <= 0 || dash+1 >= len(key) {
		return 0, 0, false
	}
	ts, err := strconv.ParseInt(key[:dash], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	seq, err := strconv.Atoi(key[dash+1:])
	if err != nil || seq < 0 || seq > maxAuditSeq {
		return 0, 0, false
	}
	return ts, seq, true
}

// AuditFilter 是 ListAudit 的查询条件；空字段表示不限，Limit<=0 表示不限。
type AuditFilter struct {
	Subject string
	Action  string
	Plugin  string
	Limit   int
}

// AuditCleanReport 是一次按龄清理的结果（DATA-MODEL §11：单次删除受上限约束）。
type AuditCleanReport struct {
	// Deleted 本次实际删除的条数。
	Deleted int `json:"deleted"`
	// More 为 true 表示仍有早于 Cutoff 的记录未删（被 limit 截断，下次继续）。
	More bool `json:"more"`
	// Cutoff 本次的截止时刻：键中时间戳早于它的记录才删。
	Cutoff time.Time `json:"cutoff"`
}

// CleanAudit 删除键中时间戳早于 cutoff 的审计记录，单次最多删 limit 条。
//
// 键格式 `%020d-%06d` 字典序 = 时间序（DATA-MODEL §5），因此游标升序扫描到
// 第一条不早于 cutoff 的记录即可停止，不遍历全桶。无法解析年龄的坏键**不删**
// （宁可留证据，不猜年龄）。单事务内用 Cursor.Delete 边删边走，不做嵌套事务。
// limit 必须为正：上限是保护，缺省即调用方错误，不静默当成无限。
func (s *Store) CleanAudit(cutoff time.Time, limit int) (AuditCleanReport, error) {
	report := AuditCleanReport{Cutoff: cutoff}
	if limit <= 0 {
		return report, fmt.Errorf("%w: 清理上限 %d 必须为正数", ErrAuditInvalid, limit)
	}
	cutoffNano := cutoff.UnixNano()
	err := s.Update(func(tx *Tx) error {
		b, err := tx.bucket(bucketAudit)
		if err != nil {
			return err
		}
		cursor := b.Cursor()
		for key, _ := cursor.First(); key != nil; key, _ = cursor.Next() {
			ts, _, ok := parseAuditKey(string(key))
			if !ok {
				continue
			}
			if ts >= cutoffNano {
				break
			}
			if report.Deleted >= limit {
				report.More = true
				break
			}
			if err := cursor.Delete(); err != nil {
				return err
			}
			report.Deleted++
		}
		return nil
	})
	if err != nil {
		return AuditCleanReport{Cutoff: cutoff}, fmt.Errorf("按龄清理审计记录失败: %w", err)
	}
	return report, nil
}

// ListAudit 按时间升序（键序）列出审计记录，可按 subject/action/plugin 过滤。
// 只读事务内解析，值在事务末失效前已 copy 到返回切片；Key 一并回填供核对键格式。
// 单条损坏记录只 WARN 跳过，不因一条坏值中断整个查询。
func (s *Store) ListAudit(f AuditFilter) ([]AuditRecord, error) {
	out := make([]AuditRecord, 0)
	err := s.View(func(tx *Tx) error {
		return tx.ForEach(bucketAudit, func(k, v []byte) error {
			var rec AuditRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				slog.Warn("审计记录损坏，跳过", "key", string(k), "err", err)
				return nil
			}
			rec.Key = string(k)
			if f.Subject != "" && rec.Subject != f.Subject {
				return nil
			}
			if f.Action != "" && rec.Action != f.Action {
				return nil
			}
			if f.Plugin != "" && rec.Plugin != f.Plugin {
				return nil
			}
			out = append(out, rec)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}
