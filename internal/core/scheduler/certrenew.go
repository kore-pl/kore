package scheduler

import (
	"encoding/json"
	"errors"
)

// syncCertRenewTask 把配置 cert_renew 映射为内置任务（ADR-0019 的迁移点）。
func (s *Service) syncCertRenewTask() error {
	task, err := s.loadTask(builtinCertRenewID)
	missing := errors.Is(err, ErrNotFound)
	if err != nil && !missing {
		return err
	}
	if !s.certEnabled {
		if missing || !task.Enabled {
			return nil
		}
		task.Enabled = false
		return s.saveTask(task)
	}
	interval := int(s.certInterval.Seconds())
	if interval < minIntervalS {
		interval = minIntervalS
	}
	if missing {
		task = Task{ID: builtinCertRenewID, Name: "证书续期检查", Plugin: BuiltinPlugin,
			Method: CertRenewMethod, Params: json.RawMessage(`{}`), TimeoutS: 60, CreatedAt: s.now()}
	}
	task.IntervalS, task.Schedule, task.Enabled = interval, "", true
	next, err := task.nextRun(s.now())
	if err != nil {
		return err
	}
	task.NextRunAt = next
	return s.saveTask(task)
}
