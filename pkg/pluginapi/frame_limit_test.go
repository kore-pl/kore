package pluginapi_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// TestFrameSizeBoundary 覆盖 8 MiB 整帧口径：8388608 收、8388609 断，无「扣掉帧头 -2」偏移。
func TestFrameSizeBoundary(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), pluginapi.MaxFrameSize)
	var buf bytes.Buffer
	if err := pluginapi.WriteFrame(&buf, payload); err != nil {
		t.Fatalf("MaxFrameSize 应可写出: %v", err)
	}
	if got, want := buf.Len(), 4+pluginapi.MaxFrameSize; got != want {
		t.Fatalf("写侧帧长 = %d，want %d", got, want)
	}
	got, err := pluginapi.ReadFrame(&buf, 0)
	if err != nil {
		t.Fatalf("MaxFrameSize 应可读入: %v", err)
	}
	if len(got) != pluginapi.MaxFrameSize {
		t.Fatalf("读入载荷 %d 字节，want %d", len(got), pluginapi.MaxFrameSize)
	}

	oversize := bytes.Repeat([]byte("x"), pluginapi.MaxFrameSize+1)
	var out bytes.Buffer
	if err := pluginapi.WriteFrame(&out, oversize); !errors.Is(err, pluginapi.ErrFrameTooLarge) {
		t.Fatalf("写侧超限应返回 ErrFrameTooLarge，实际: %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("写侧超限后仍写出 %d 字节", out.Len())
	}

	hdr := encodeFrameHeader(pluginapi.MaxFrameSize + 1)
	if _, err := pluginapi.ReadFrame(bytes.NewReader(hdr), 0); !errors.Is(err, pluginapi.ErrFrameTooLarge) {
		t.Fatalf("读侧超限应返回 ErrFrameTooLarge，实际: %v", err)
	}
	// 调用方传入更大的 max 也不能放宽协议上限。
	if _, err := pluginapi.ReadFrame(bytes.NewReader(hdr), 1<<30); !errors.Is(err, pluginapi.ErrFrameTooLarge) {
		t.Fatalf("max 不得放宽协议上限，实际: %v", err)
	}
}

// TestReadFrameOversizeNoBigAlloc 证明超限帧在分配载荷缓冲前就被拒绝：
// 只读了 4 字节帧头、错误可判、且没有载荷缓冲级别的大分配。
func TestReadFrameOversizeNoBigAlloc(t *testing.T) {
	hdr := encodeFrameHeader(pluginapi.MaxFrameSize + 1)
	src := bytes.NewReader(hdr)
	var lastErr error
	allocs := testing.AllocsPerRun(100, func() {
		src.Reset(hdr)
		_, lastErr = pluginapi.ReadFrame(src, 0)
	})
	if !errors.Is(lastErr, pluginapi.ErrFrameTooLarge) {
		t.Fatalf("应返回 ErrFrameTooLarge，实际: %v", lastErr)
	}
	// 唯一可能的小分配是 4 字节帧头数组逃逸进 io.ReadFull；绝不应出现 8 MiB 级缓冲分配。
	if allocs > 1 {
		t.Fatalf("超限路径分配 %.0f 次，应为 0（或仅 4 字节帧头逃逸的 1 次）", allocs)
	}
	cr := &countingReader{r: bytes.NewReader(append(hdr, bytes.Repeat([]byte("x"), 64)...))}
	if _, err := pluginapi.ReadFrame(cr, 0); !errors.Is(err, pluginapi.ErrFrameTooLarge) {
		t.Fatalf("应返回 ErrFrameTooLarge，实际: %v", err)
	}
	if cr.n != 4 {
		t.Fatalf("超限帧只应读取 4 字节帧头，实际读取 %d 字节", cr.n)
	}
}

// TestWriteJSONMarshalError 序列化失败时不得写出任何字节。
func TestWriteJSONMarshalError(t *testing.T) {
	var buf bytes.Buffer
	if err := pluginapi.WriteJSON(&buf, make(chan int)); err == nil {
		t.Fatal("不可序列化值应返回错误")
	}
	if buf.Len() != 0 {
		t.Fatalf("序列化失败后仍写出 %d 字节", buf.Len())
	}
}
