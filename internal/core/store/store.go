// Package store 封装 kore 的单文件 bbolt 持久层。
//
// 只提供打开/关闭、8 个固定 bucket、schema 版本检查与事务透传；
// 不做业务语义、不做 SQL、不做跨 bucket 长事务。
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

// 持久层常量。
const (
	// DBName 是状态库文件名。
	DBName = "state.db"
	// SchemaVersion 是当前内核支持的 schema 版本。
	SchemaVersion = 1
	// MaxValueSize 是单值上限 1 MiB；大对象是设计错误。
	MaxValueSize = 1 << 20
	// lockTimeout 是拿不到文件锁的等待上限（CORE §2.2：Timeout=1s）。
	lockTimeout = time.Second
	// longTxWarn 是长事务告警阈值。
	longTxWarn = 500 * time.Millisecond
	// pidFileName 记录锁持有者 pid，供二次启动回显。
	pidFileName = "state.lock"
	// schemaKey 是 meta bucket 里的 schema 版本键。
	schemaKey = "schema_version"
)

// 9 个固定 bucket（键结构见 docs/DATA-MODEL.md §5）。
//
// scheduler_tasks / scheduler_runs 是 ADR-0019 的追加 bucket；alerts 是告警中心
// 的追加 bucket（顶层 `alerts` + 嵌套子桶 `events`，alerts.go）：均为 additive
// 变更，旧二进制忽略新 bucket，schema 版本不变。
const (
	bucketMeta           = "meta"
	bucketPlugins        = "plugins"
	bucketPluginState    = "plugin_state"
	bucketTasks          = "tasks"
	bucketSessions       = "sessions"
	bucketAudit          = "audit"
	bucketSchedulerTasks = "scheduler_tasks"
	bucketSchedulerRuns  = "scheduler_runs"
	bucketAlerts         = "alerts"
)

// bucketNames 是建库时必须齐备的 bucket 列表。
var bucketNames = []string{
	bucketMeta, bucketPlugins, bucketPluginState,
	bucketTasks, bucketSessions, bucketAudit,
	bucketSchedulerTasks, bucketSchedulerRuns, bucketAlerts,
}

// Store 是已打开的状态库句柄；Close 幂等。
type Store struct {
	db        *bolt.DB
	path      string
	closeOnce sync.Once
	closeErr  error
	// now 是时间源；Open 时固定为 time.Now，测试可替换（去重窗口/键序测试用）。
	now func() time.Time
}

// Open 创建状态目录并打开状态库，建齐 9 个 bucket（含 alerts 的嵌套 events）后校验 schema。
func Open(stateDir string, logger *slog.Logger) (*Store, error) {
	if stateDir == "" {
		return nil, fmt.Errorf("%w: 路径为空", ErrStateDir)
	}
	_, statErr := os.Stat(stateDir)
	created := errors.Is(statErr, os.ErrNotExist)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("%w: 创建 %s: %v", ErrStateDir, stateDir, err)
	}
	if created {
		if err := os.Chmod(stateDir, 0o700); err != nil {
			return nil, fmt.Errorf("%w: 设置 %s 权限: %v", ErrStateDir, stateDir, err)
		}
	}
	path := filepath.Join(stateDir, DBName)
	// 锁用 bbolt 内置 flock（内部即 LOCK_EX|LOCK_NB + Timeout 重试），不在 internal/core 直接调
	// syscall 的 Flock（G-16 要求平台 API 收口在 internal/platform）；拿不到锁返回 ErrTimeout。
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: lockTimeout})
	if err != nil {
		return nil, openError(stateDir, path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("%w: 收紧 %s 权限: %v", ErrStateDir, path, err)
	}
	s := &Store{db: db, path: path, now: time.Now}
	if err := s.prepare(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := writePID(stateDir); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("%w: 写锁持有者记录: %v", ErrStateDir, err)
	}
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("状态库已打开", "path", path, "schema_version", SchemaVersion)
	return s, nil
}

// openError 把 bbolt 打开失败分类为锁冲突 / 权限 / 损坏。
func openError(stateDir, path string, err error) error {
	switch {
	case errors.Is(err, bolt.ErrTimeout):
		return &LockedError{Path: path, PID: readPID(stateDir)}
	case errors.Is(err, os.ErrPermission):
		return fmt.Errorf("%w: %v", ErrStateDir, err)
	default:
		return fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
}

// prepare 建齐 bucket 并校验 schema；高于内核版本直接拒绝。
func (s *Store) prepare() error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		for _, name := range bucketNames {
			if _, err := tx.CreateBucketIfNotExists([]byte(name)); err != nil {
				return err
			}
		}
		// alerts 的嵌套子桶 events（additive：旧库升级时自动补建，schema 不变）。
		alerts := tx.Bucket([]byte(bucketAlerts))
		if alerts == nil {
			return fmt.Errorf("%w: %s 缺失", ErrBucket, bucketAlerts)
		}
		if _, err := alerts.CreateBucketIfNotExists([]byte(bucketAlertEvents)); err != nil {
			return err
		}
		meta := tx.Bucket([]byte(bucketMeta))
		raw := meta.Get([]byte(schemaKey))
		if raw == nil {
			return meta.Put([]byte(schemaKey), schemaJSON(SchemaVersion))
		}
		var doc struct {
			SchemaVersion int `json:"schema_version"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return fmt.Errorf("%w: meta.%s 无法解析: %v", ErrCorrupt, schemaKey, err)
		}
		if doc.SchemaVersion > SchemaVersion {
			return fmt.Errorf("%w: 状态库 schema=%d，内核支持=%d", ErrSchemaTooNew, doc.SchemaVersion, SchemaVersion)
		}
		if doc.SchemaVersion < 1 {
			return fmt.Errorf("%w: meta.%s=%d 非法", ErrCorrupt, schemaKey, doc.SchemaVersion)
		}
		return nil
	})
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrSchemaTooNew) || errors.Is(err, ErrCorrupt) {
		return err
	}
	return fmt.Errorf("%w: %v", ErrCorrupt, err)
}

// schemaJSON 生成 meta.schema_version 的 JSON 值。
func schemaJSON(version int) []byte {
	data, _ := json.Marshal(struct {
		SchemaVersion int `json:"schema_version"`
	}{SchemaVersion: version})
	return data
}

// Close 关闭状态库；重复调用返回首次结果。
func (s *Store) Close() error {
	s.closeOnce.Do(func() {
		if s.db != nil {
			s.closeErr = s.db.Close()
		}
	})
	return s.closeErr
}

// BucketNames 返回 9 个固定 bucket 的副本。
func BucketNames() []string {
	out := make([]string, len(bucketNames))
	copy(out, bucketNames)
	return out
}

// writePID 把当前进程号写入锁持有者记录（0600）。
func writePID(stateDir string) error {
	path := filepath.Join(stateDir, pidFileName)
	content := strconv.Itoa(os.Getpid()) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// readPID 读取锁持有者记录；读不到或非法时返回 0，不猜。
func readPID(stateDir string) int {
	data, err := os.ReadFile(filepath.Join(stateDir, pidFileName))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}
