package store

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	bolt "go.etcd.io/bbolt"
)

// 告警中心持久层（web/alerts.js 的历史源；docs/DATA-MODEL.md §5 alerts bucket）。
//
// 顶层 bucket `alerts` 内嵌套子桶 `events`：键 = `%020d-%06d`（unix 纳秒 + 序号，
// 与 audit 同编码，字典序 = 时间序），id 即键；ts 不落库、由键派生（与 audit「时间
// 由键承载」同口径）。写入时做三件事：合法性校验 → 同 title+source 5 分钟去重合并
// （count+1，改写为最新时刻，seen 归 false）→ 超过 500 条裁掉最旧。
// 全部在同一写事务内完成，无后台 goroutine / ticker（G-19）。

const (
	// bucketAlertEvents 是 alerts（顶层，store.go 固定 bucket）内的事件子桶。
	bucketAlertEvents = "events"

	// AlertMaxRecords 是保留上限：按时间倒序只留最近 500 条，写入时裁剪。
	AlertMaxRecords = 500
	// alertMergeWindowNs 是同 title+source 的去重窗口（5 分钟）。
	alertMergeWindowNs = int64(5 * time.Minute)
	// alertTitleMaxRunes 是 title 字符上限（按 rune 计）。
	alertTitleMaxRunes = 200
	// alertDetailMaxRunes 是 detail 字符上限（按 rune 计）。
	alertDetailMaxRunes = 512
)

// 告警严重级取值。
const (
	// AlertSeverityCritical 表示严重（安全拒绝 / 红线击穿）。
	AlertSeverityCritical = "critical"
	// AlertSeverityWarning 表示警告（接近红线 / 反复异常）。
	AlertSeverityWarning = "warning"
	// AlertSeverityInfo 表示提示。
	AlertSeverityInfo = "info"
)

// 告警来源取值（内核各检查点；见 docs/DATA-MODEL.md §5）。
const (
	// AlertSourceAudit 来源 = 操作审计（login.failed / capability.denied / root.action 拒绝）。
	AlertSourceAudit = "audit"
	// AlertSourcePlugin 来源 = 插件（state=failed / restarts>3）。
	AlertSourcePlugin = "plugin"
	// AlertSourceResource 来源 = 资源红线（RSS / goroutine）。
	AlertSourceResource = "resource"
	// AlertSourceSlot 来源 = 常驻槽位（resident 达硬上限）。
	AlertSourceSlot = "slot"
)

// AlertRecord 是一条告警。Key/TsNs 只在查询结果里回填（存储值不含键），
// Key 即对外 id（`%020d-%06d`），TsNs 由键的纳秒段派生。
type AlertRecord struct {
	Key      string `json:"-"`
	TsNs     int64  `json:"-"`
	Severity string `json:"severity"`
	Source   string `json:"source"`
	Title    string `json:"title"`
	Detail   string `json:"detail,omitempty"`
	Seen     bool   `json:"seen"`
	Count    int    `json:"count"`
}

// alertEvents 在写/读事务内取 alerts 下的 events 子桶；未建即报错，不隐式创建。
func alertEvents(tx *Tx) (*bolt.Bucket, error) {
	top, err := tx.bucket(bucketAlerts)
	if err != nil {
		return nil, err
	}
	events := top.Bucket([]byte(bucketAlertEvents))
	if events == nil {
		return nil, fmt.Errorf("%w: %s/%s", ErrBucket, bucketAlerts, bucketAlertEvents)
	}
	return events, nil
}

// PutAlert 记录一条告警：校验 → 5 分钟窗口内同 title+source 合并（count+1、
// 时刻改写为本次、seen 归 false——新发生重新计未读）→ 新建 → 裁剪到 500 条。
// 返回合并或新建后的记录（Key/TsNs 已回填），供端点直接回显。
func (s *Store) PutAlert(severity, source, title, detail string) (AlertRecord, error) {
	return s.PutAlertCounted(severity, source, title, detail, 1)
}

// PutAlertCounted 一次写事务累加 n 次告警计数（n≥1；n=1 与 PutAlert 等价）。
// deny 突发合并用它在窗口触发点一次落库 n 次拒绝，替代 n 次「读改写 + fsync」
// 写事务（方案候选②）。一个小事务内完成合并 + 裁剪，不引入 goroutine/ticker
// （G-19），count 守恒由调用方（DenyBurstTracker）保证。
func (s *Store) PutAlertCounted(severity, source, title, detail string, n int) (AlertRecord, error) {
	if n < 1 {
		return AlertRecord{}, fmt.Errorf("%w: 告警累加次数 %d 必须 ≥1", ErrAuditInvalid, n)
	}
	if err := validateAlert(severity, source, title, detail); err != nil {
		return AlertRecord{}, err
	}
	var out AlertRecord
	err := s.Update(func(tx *Tx) error {
		events, err := alertEvents(tx)
		if err != nil {
			return err
		}
		now := s.now()
		merged, err := mergeAlertCounted(events, now, n, severity, source, title, detail)
		if err != nil {
			return err
		}
		out = merged
		return trimAlerts(events, AlertMaxRecords)
	})
	if err != nil {
		return AlertRecord{}, err
	}
	return out, nil
}

// mergeAlert 在窗口内找同 title+source 记录：命中则删旧键、按当前时刻重写
// （count+1、seen=false、detail 取最新）；未命中则新建（count=1，seen=false）。
func mergeAlert(events *bolt.Bucket, now time.Time, severity, source, title, detail string) (AlertRecord, error) {
	return mergeAlertCounted(events, now, 1, severity, source, title, detail)
}

// mergeAlertCounted 与 mergeAlert 同语义，命中时 count+=n、未命中时 count=n；
// 整个合并仍在一个写事务内完成，写事务数不随 n 增长。
func mergeAlertCounted(events *bolt.Bucket, now time.Time, n int, severity, source, title, detail string) (AlertRecord, error) {
	ns := now.UnixNano()
	c := events.Cursor()
	for k, v := c.Last(); k != nil; k, v = c.Prev() {
		kts, _, ok := parseAuditKey(string(k))
		if !ok {
			continue // 损坏键不参与合并，也不中断扫描
		}
		if ns-kts >= alertMergeWindowNs {
			break // 键序即时间序：越过窗口即可停扫
		}
		var rec AlertRecord
		if err := json.Unmarshal(v, &rec); err != nil {
			slog.Warn("告警记录损坏，跳过合并", "key", string(k), "err", err)
			continue
		}
		if rec.Source != source || rec.Title != title {
			continue
		}
		if err := events.Delete(k); err != nil {
			return AlertRecord{}, err
		}
		rec.Count += n
		rec.Seen = false
		rec.Detail = detail
		return writeAlert(events, rec, now)
	}
	return writeAlert(events, AlertRecord{
		Severity: severity, Source: source, Title: title, Detail: detail, Seen: false, Count: n,
	}, now)
}

// writeAlert 序列化并以当前时刻键写入；Key/TsNs 回填到返回值。
func writeAlert(events *bolt.Bucket, rec AlertRecord, now time.Time) (AlertRecord, error) {
	value, err := json.Marshal(rec)
	if err != nil {
		return AlertRecord{}, fmt.Errorf("序列化告警记录失败: %w", err)
	}
	if len(value) > MaxValueSize {
		return AlertRecord{}, fmt.Errorf("%w: alerts/events %d 字节", ErrValueTooLarge, len(value))
	}
	key := nextAuditKey(events, now)
	if err := events.Put([]byte(key), value); err != nil {
		return AlertRecord{}, err
	}
	ts, _, _ := parseAuditKey(key)
	rec.Key, rec.TsNs = key, ts
	return rec, nil
}

// trimAlerts 把事件桶裁剪到 max 条：显式数一遍键（不用 Stats().KeyN——实测写
// 事务内该值与真实键数不符，会少删或把桶删空），再按时间序从最旧开始删超量。
func trimAlerts(events *bolt.Bucket, max int) error {
	n := 0
	c := events.Cursor()
	for k, _ := c.First(); k != nil; k, _ = c.Next() {
		n++
	}
	for excess := n - max; excess > 0; excess-- {
		k, _ := events.Cursor().First()
		if k == nil {
			return nil
		}
		if err := events.Delete(k); err != nil {
			return err
		}
	}
	return nil
}

// validateAlert 按 DATA-MODEL §5 校验：severity/source 取值受控，
// title 1..200 字符、detail ≤512 字符（长度按 rune 计）。
func validateAlert(severity, source, title, detail string) error {
	switch severity {
	case AlertSeverityCritical, AlertSeverityWarning, AlertSeverityInfo:
	default:
		return fmt.Errorf("%w: severity=%q 不在 critical/warning/info 内", ErrAuditInvalid, severity)
	}
	switch source {
	case AlertSourceAudit, AlertSourcePlugin, AlertSourceResource, AlertSourceSlot:
	default:
		return fmt.Errorf("%w: source=%q 不在 audit/plugin/resource/slot 内", ErrAuditInvalid, source)
	}
	if n := len([]rune(title)); n == 0 || n > alertTitleMaxRunes {
		return fmt.Errorf("%w: title 长度 %d 不在 1..%d 内", ErrAuditInvalid, n, alertTitleMaxRunes)
	}
	if len([]rune(detail)) > alertDetailMaxRunes {
		return fmt.Errorf("%w: detail 超过 %d 字符", ErrAuditInvalid, alertDetailMaxRunes)
	}
	return nil
}

// AlertFilter 是 ListAlerts 的查询条件；Severity 空表示不限，Limit<=0 表示不限。
type AlertFilter struct {
	Severity string
	Limit    int
}

// ListAlerts 按时间倒序（最新在前）列出告警，第二个返回值是全库未读总数
// （不计 severity 过滤——铃铛红点需要全局未读数）。单条损坏记录 WARN 跳过。
func (s *Store) ListAlerts(f AlertFilter) ([]AlertRecord, int, error) {
	out := make([]AlertRecord, 0)
	unread := 0
	err := s.View(func(tx *Tx) error {
		events, err := alertEvents(tx)
		if err != nil {
			return err
		}
		c := events.Cursor()
		for k, v := c.Last(); k != nil; k, v = c.Prev() {
			var rec AlertRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				slog.Warn("告警记录损坏，跳过", "key", string(k), "err", err)
				continue
			}
			if !rec.Seen {
				unread++
			}
			if f.Severity != "" && rec.Severity != f.Severity {
				continue
			}
			if f.Limit > 0 && len(out) >= f.Limit {
				continue
			}
			ts, _, _ := parseAuditKey(string(k))
			rec.Key, rec.TsNs = string(k), ts
			out = append(out, rec)
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return out, unread, nil
}

// MarkAlertSeen 把一条告警标记为已读；键不存在返回 ErrNotFound（不伪装成功）。
func (s *Store) MarkAlertSeen(id string) error {
	return s.Update(func(tx *Tx) error {
		events, err := alertEvents(tx)
		if err != nil {
			return err
		}
		raw := events.Get([]byte(id))
		if raw == nil {
			return fmt.Errorf("%w: alerts/events/%s", ErrNotFound, id)
		}
		var rec AlertRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			return fmt.Errorf("%w: alerts/events/%s 值损坏: %v", ErrCorrupt, id, err)
		}
		rec.Seen = true
		value, err := json.Marshal(rec)
		if err != nil {
			return fmt.Errorf("序列化告警记录失败: %w", err)
		}
		return events.Put([]byte(id), value)
	})
}
