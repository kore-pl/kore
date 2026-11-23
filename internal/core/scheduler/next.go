package scheduler

import "time"

// Next 返回严格晚于 after 的下一个执行时刻；找不到（如 2 月 30 日）返回 false。
//
// 时间语义：按 after 所在时区的本地时间解释表达式。搜索按"天"推进，
// 命中日期后再取当天最早的"时:分"组合，最多扫 8 年以覆盖 2 月 29 日。
func (s *Expression) Next(after time.Time) (time.Time, bool) {
	loc := after.Location()
	start := after.Truncate(time.Minute).Add(time.Minute)
	year, month, day := start.Date()
	cursor := time.Date(year, month, day, 0, 0, 0, 0, loc)
	for i := 0; i <= maxScanDays; i++ {
		if s.dayMatch(cursor) {
			if next, ok := s.firstMoment(cursor, start); ok {
				return next, true
			}
		}
		cursor = cursor.AddDate(0, 0, 1)
	}
	return time.Time{}, false
}

// firstMoment 在给定日期内找不早于 start 的最早执行时刻。
func (s *Expression) firstMoment(day, start time.Time) (time.Time, bool) {
	for hour := 0; hour <= hourHigh; hour++ {
		if !s.hour.values[hour] {
			continue
		}
		for minute := 0; minute <= minuteHigh; minute++ {
			if !s.minute.values[minute] {
				continue
			}
			candidate := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, day.Location())
			if !candidate.Before(start) {
				return candidate, true
			}
		}
	}
	return time.Time{}, false
}

// dayMatch 判定某天是否命中：月必须命中；日与周都受限时取"或"（标准语义）。
func (s *Expression) dayMatch(day time.Time) bool {
	if !s.month.values[int(day.Month())] {
		return false
	}
	dayHit := s.day.values[day.Day()]
	weekdayHit := s.weekday.values[int(day.Weekday())]
	switch {
	case s.day.star && s.weekday.star:
		return true
	case s.day.star:
		return weekdayHit
	case s.weekday.star:
		return dayHit
	default:
		return dayHit || weekdayHit
	}
}
