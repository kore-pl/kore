//go:build linux

package platform

import (
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// linuxSignals 是 Signals 的 Linux 实现。
type linuxSignals struct {
	shutdown chan struct{}
	reload   chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
}

// newLinuxSignals 注册 SIGTERM / SIGINT / SIGHUP 并把它们归一化到两个通道。
func newLinuxSignals() *linuxSignals {
	s := &linuxSignals{
		shutdown: make(chan struct{}),
		reload:   make(chan struct{}, 1),
		stop:     make(chan struct{}),
	}
	raw := make(chan os.Signal, 4)
	signal.Notify(raw, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		defer signal.Stop(raw)
		for {
			select {
			case sig := <-raw:
				if sig == syscall.SIGHUP {
					select {
					case s.reload <- struct{}{}:
					default:
					}
					continue
				}
				close(s.shutdown)
				return
			case <-s.stop:
				return
			}
		}
	}()
	return s
}

// Shutdown 在停止信号到达后关闭。
func (s *linuxSignals) Shutdown() <-chan struct{} { return s.shutdown }

// Reload 在 SIGHUP 到达后投递一次。
func (s *linuxSignals) Reload() <-chan struct{} { return s.reload }

// Stop 停止信号监听并释放注册。
func (s *linuxSignals) Stop() {
	s.stopOnce.Do(func() { close(s.stop) })
}
