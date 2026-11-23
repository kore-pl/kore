package main

import (
	"errors"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// alertSinkFromStore 把 store 的告警持久层适配成 httpapi.AlertSink。
// 装配层做类型转换与时间格式化，httpapi 不 import store（G-01）。
type alertSinkFromStore struct {
	db *store.Store
}

// alertView 把存储记录转成对外视图；Ts 由键纳秒段派生（RFC3339Nano，仅响应字段）。
func alertView(rec store.AlertRecord) httpapi.AlertView {
	return httpapi.AlertView{
		ID: rec.Key, Ts: time.Unix(0, rec.TsNs).UTC().Format(time.RFC3339Nano),
		Severity: rec.Severity, Source: rec.Source, Title: rec.Title,
		Detail: rec.Detail, Seen: rec.Seen, Count: rec.Count,
	}
}

func (a alertSinkFromStore) PutAlert(severity, source, title, detail string) (httpapi.AlertView, error) {
	rec, err := a.db.PutAlert(severity, source, title, detail)
	if err != nil {
		return httpapi.AlertView{}, err
	}
	return alertView(rec), nil
}

func (a alertSinkFromStore) ListAlerts(q httpapi.AlertQuery) ([]httpapi.AlertView, int, error) {
	rows, unread, err := a.db.ListAlerts(store.AlertFilter{Severity: q.Severity, Limit: q.Limit})
	if err != nil {
		return nil, 0, err
	}
	out := make([]httpapi.AlertView, 0, len(rows))
	for _, rec := range rows {
		out = append(out, alertView(rec))
	}
	return out, unread, nil
}

func (a alertSinkFromStore) MarkAlertSeen(id string) error {
	if err := a.db.MarkAlertSeen(id); err != nil {
		// 键不存在归一成 404 协议错误（httpapi 不感知 store 错误分类，G-01）。
		if errors.Is(err, store.ErrNotFound) {
			return &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "告警不存在"}
		}
		return err
	}
	return nil
}

// alertSink 装配告警持久层；状态库未装配（测试/骨架）时返回 nil，
// httpapi 端点据此回 501、埋点静默跳过。
func alertSink(db *store.Store) httpapi.AlertSink {
	if db == nil {
		return nil
	}
	return alertSinkFromStore{db: db}
}
