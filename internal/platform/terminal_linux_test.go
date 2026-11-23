//go:build linux

package platform

import (
	"os"
	"testing"
)

// TestIsTerminalRejectsPipeAndDevNull 验证管道与 /dev/null 不被误判为 TTY。
func TestIsTerminalRejectsPipeAndDevNull(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("建管道失败: %v", err)
	}
	defer r.Close()
	defer w.Close()
	if IsTerminal(r.Fd()) {
		t.Fatal("管道不应判定为终端")
	}
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("打开 /dev/null 失败: %v", err)
	}
	defer devNull.Close()
	if IsTerminal(devNull.Fd()) {
		t.Fatal("/dev/null 不应判定为终端（ModeCharDevice 陷阱）")
	}
}
