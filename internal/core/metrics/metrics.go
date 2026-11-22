// Package metrics 在请求路径上惰性采集宿主资源快照：零后台 goroutine、零周期定时器。
// 每次 Collect 现读 /proc；CPU 百分比用两次调用的 /proc/stat 差值算，基线懒缓存。
package metrics

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pengtang1024/kore/internal/platform"
)

// ErrUnsupported 表示当前构建目标没有资源采样实现（Tier B 降级，不静默）。
var ErrUnsupported = errors.New("metrics: 当前平台未提供资源采样")

// 进程启动时刻（包初始化），用于进程 uptime。
var processStart = time.Now()

// Snapshot 是一次资源采样的只读结果，字段与 HTTP 契约一一对应。
type Snapshot struct {
	CPUPercent   float64
	RSSKiB       uint64
	DiskUsedKiB  uint64
	DiskTotalKiB uint64
	Load1        float64
	Goroutines   int
	FDs          int
	UptimeSec    uint64
	TakenAt      time.Time
}

// Collector 持有 CPU 基线；并发请求由 mutex 串行化。
type Collector struct {
	stateDir string
	mu       sync.Mutex
	last     cpuTimes
	hasLast  bool
}

// New 构造采样器；stateDir 用于磁盘容量采样，空值退回当前目录。
func New(stateDir string) *Collector {
	if stateDir == "" {
		stateDir = "."
	}
	return &Collector{stateDir: stateDir}
}

// Collect 现场采集一次快照；首次调用 CPUPercent 为 0 并缓存基线。
func (c *Collector) Collect() (Snapshot, error) {
	if runtime.GOOS != "linux" {
		return Snapshot{}, fmt.Errorf("%w: %s 平台仅提供 Tier B 降级", ErrUnsupported, runtime.GOOS)
	}
	snap := Snapshot{TakenAt: time.Now(), Goroutines: runtime.NumGoroutine()}
	cpu, err := c.cpuPercent()
	if err != nil {
		return Snapshot{}, err
	}
	snap.CPUPercent = cpu
	if snap.RSSKiB, err = readRSSKiB(); err != nil {
		return Snapshot{}, err
	}
	if snap.DiskUsedKiB, snap.DiskTotalKiB, err = platform.DiskUsage(c.stateDir); err != nil {
		return Snapshot{}, err
	}
	if snap.Load1, err = readLoad1(); err != nil {
		return Snapshot{}, err
	}
	if snap.FDs, err = countFDs(); err != nil {
		return Snapshot{}, err
	}
	snap.UptimeSec = uint64(time.Since(processStart).Seconds())
	return snap, nil
}

// cpuTimes 是 /proc/stat 聚合行的累计 jiffies。
type cpuTimes struct{ busy, total uint64 }

// cpuPercent 用两次调用的差值算整机 CPU 占用（0–100）。
func (c *Collector) cpuPercent() (float64, error) {
	now, err := readCPUTimes()
	if err != nil {
		return 0, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.hasLast {
		c.last, c.hasLast = now, true
		return 0, nil
	}
	prev := c.last
	c.last = now
	if now.total <= prev.total || now.busy < prev.busy {
		return 0, nil
	}
	return float64(now.busy-prev.busy) / float64(now.total-prev.total) * 100, nil
}

// readCPUTimes 解析 /proc/stat 聚合行；只取前 8 字段，guest 已含在 user/nice 中。
func readCPUTimes() (cpuTimes, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, fmt.Errorf("读取 /proc/stat: %w", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		if len(fields) < 4 {
			return cpuTimes{}, fmt.Errorf("/proc/stat cpu 行字段不足: %q", line)
		}
		var vals [8]uint64
		for i := 0; i < len(vals) && i < len(fields); i++ {
			v, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				return cpuTimes{}, fmt.Errorf("解析 /proc/stat 字段 %q: %w", fields[i], err)
			}
			vals[i] = v
		}
		var total uint64
		for _, v := range vals {
			total += v
		}
		return cpuTimes{busy: total - vals[3] - vals[4], total: total}, nil
	}
	return cpuTimes{}, errors.New("/proc/stat 缺少 cpu 行")
}

// readRSSKiB 读 /proc/self/status 的 VmRSS。
func readRSSKiB() (uint64, error) {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, fmt.Errorf("读取 /proc/self/status: %w", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		kib, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("解析 VmRSS: %w", err)
		}
		return kib, nil
	}
	return 0, errors.New("/proc/self/status 缺少 VmRSS")
}

// readLoad1 读 /proc/loadavg 首字段。
func readLoad1() (float64, error) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, fmt.Errorf("读取 /proc/loadavg: %w", err)
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, errors.New("/proc/loadavg 为空")
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("解析 load1 %q: %w", fields[0], err)
	}
	return v, nil
}

func countFDs() (int, error) {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return 0, fmt.Errorf("读取 /proc/self/fd: %w", err)
	}
	return len(entries), nil
}
