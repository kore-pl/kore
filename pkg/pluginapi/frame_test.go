package pluginapi_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// encodeFrameHeader 返回只含 4 字节大端长度前缀的假帧头，用于构造异常输入。
func encodeFrameHeader(n uint32) []byte {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], n)
	return hdr[:]
}

// chunkReader 每次最多交出 max 字节，模拟载荷分片到达（半包）。
type chunkReader struct {
	r   io.Reader
	max int
}

func (c chunkReader) Read(p []byte) (int, error) {
	if len(p) > c.max {
		p = p[:c.max]
	}
	return c.r.Read(p)
}

// countingReader 记录被读取的总字节数，用于证明超限帧没有被读取载荷。
type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

// TestRoundTrip 覆盖 Request/Response（含 error）/Event/Ping/Pong 的
// marshal→write→read→unmarshal 全程，逐字段断言相等，同时校验长度前缀语义。
func TestRoundTrip(t *testing.T) {
	id := strings.Repeat("a", 32)
	cases := []struct {
		name string
		msg  any
	}{
		{"request", &pluginapi.Request{
			Type: pluginapi.TypeRequest, ID: id, ReqID: "r-01JC8Q3A", Method: "site.list",
			Params: json.RawMessage(`{"domain":"example.com"}`), TimeoutMS: 15000,
		}},
		{"response-result", &pluginapi.Response{
			Type: pluginapi.TypeResponse, ID: id, ReqID: "r-01JC8Q3B",
			Result: json.RawMessage(`{"ok":true}`),
		}},
		{"response-error", &pluginapi.Response{
			Type: pluginapi.TypeResponse, ID: id, ReqID: "r-01JC8Q3C",
			Error: &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "参数非法", Detail: json.RawMessage(`{"field":"domain"}`)},
		}},
		{"event", &pluginapi.Event{
			Type: pluginapi.TypeEvent, Event: "plugin.log", Seq: 42,
			TS: "2026-11-21T20:40:15.123+08:00", Data: json.RawMessage(`{"level":"info","msg":"ready"}`),
		}},
		{"ping", &pluginapi.Ping{Type: pluginapi.TypePing, TS: 1763728815123456789}},
		{"pong", &pluginapi.Pong{Type: pluginapi.TypePong, TS: 1763728815123456789}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { assertRoundTrip(t, tc.msg) })
	}
}

// assertRoundTrip 校验单条消息的 marshal→write→read→unmarshal 全等与长度前缀语义。
func assertRoundTrip(t *testing.T, msg any) {
	t.Helper()
	var buf bytes.Buffer
	if err := pluginapi.WriteJSON(&buf, msg); err != nil {
		t.Fatalf("WriteJSON 失败: %v", err)
	}
	raw := append([]byte(nil), buf.Bytes()...)
	if len(raw) < 5 {
		t.Fatalf("帧长 %d 字节，不足最小帧", len(raw))
	}
	if got, want := binary.BigEndian.Uint32(raw[:4]), uint32(len(raw)-4); got != want {
		t.Fatalf("长度前缀 = %d，实际载荷 = %d", got, want)
	}
	payload, err := pluginapi.ReadFrame(&buf, 0)
	if err != nil {
		t.Fatalf("ReadFrame 失败: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("读完一帧后残留 %d 字节", buf.Len())
	}
	if !bytes.Equal(payload, raw[4:]) {
		t.Fatalf("载荷字节被改写: %q", payload)
	}
	got, err := pluginapi.DecodeFrame(payload)
	if err != nil {
		t.Fatalf("DecodeFrame 失败: %v", err)
	}
	if !reflect.DeepEqual(got, msg) {
		t.Fatalf("往返不相等:\n want %#v\n got  %#v", msg, got)
	}
}

// TestReadFrameChunked 把同一帧按 1/2/3 字节切片喂给 Reader，必须逐字节拼回原载荷。
func TestReadFrameChunked(t *testing.T) {
	payload := []byte(`{"type":"request","id":"` + strings.Repeat("d", 32) +
		`","method":"echo.echo","params":{"msg":"你好，kore"}}`)
	frame := append(encodeFrameHeader(uint32(len(payload))), payload...)
	for _, size := range []int{1, 2, 3} {
		for i := 0; i < 200; i++ {
			got, err := pluginapi.ReadFrame(chunkReader{r: bytes.NewReader(frame), max: size}, 0)
			if err != nil {
				t.Fatalf("分片 %d 字节第 %d 轮读取失败: %v", size, i, err)
			}
			if !bytes.Equal(got, payload) {
				t.Fatalf("分片 %d 字节第 %d 轮载荷不一致: %q", size, i, got)
			}
		}
	}
}

// TestReadFrameTwoFramesInOneBuffer 一个缓冲区里放两帧，连续两次 ReadFrame 各得其一，第三次读到干净 EOF。
func TestReadFrameTwoFramesInOneBuffer(t *testing.T) {
	want := [][]byte{[]byte(`{"type":"ping","ts":1}`), []byte(`{"type":"pong","ts":1}`)}
	buf := bytes.NewReader(append(append(encodeFrameHeader(uint32(len(want[0]))), want[0]...),
		append(encodeFrameHeader(uint32(len(want[1]))), want[1]...)...))
	for i := range want {
		got, err := pluginapi.ReadFrame(buf, 0)
		if err != nil {
			t.Fatalf("第 %d 帧读取失败: %v", i+1, err)
		}
		if !bytes.Equal(got, want[i]) {
			t.Fatalf("第 %d 帧 = %q，want %q", i+1, got, want[i])
		}
	}
	if _, err := pluginapi.ReadFrame(buf, 0); !errors.Is(err, io.EOF) {
		t.Fatalf("帧边界关闭应返回 io.EOF，实际: %v", err)
	}
}

// TestReadFrameEmptyAndTooShort 覆盖长度前缀 0（空载荷）与 1（不足最短 JSON 对象），并确认 2 字节可读。
func TestReadFrameEmptyAndTooShort(t *testing.T) {
	if _, err := pluginapi.ReadFrame(bytes.NewReader(encodeFrameHeader(0)), 0); !errors.Is(err, pluginapi.ErrEmptyPayload) {
		t.Fatalf("长度 0 应返回 ErrEmptyPayload，实际: %v", err)
	}
	if _, err := pluginapi.ReadFrame(bytes.NewReader(encodeFrameHeader(1)), 0); !errors.Is(err, pluginapi.ErrPayloadTooShort) {
		t.Fatalf("长度 1 应返回 ErrPayloadTooShort，实际: %v", err)
	}
	payload, err := pluginapi.ReadFrame(bytes.NewReader(append(encodeFrameHeader(2), '{', '}')), 0)
	if err != nil || string(payload) != "{}" {
		t.Fatalf("长度 2 应可读，payload=%q err=%v", payload, err)
	}
}

// TestReadFrameEOFAndShort 区分干净 EOF、帧头截断、载荷截断三种结束方式。
func TestReadFrameEOFAndShort(t *testing.T) {
	if _, err := pluginapi.ReadFrame(bytes.NewReader(nil), 0); !errors.Is(err, io.EOF) {
		t.Fatalf("空流应返回 io.EOF，实际: %v", err)
	}
	if _, err := pluginapi.ReadFrame(bytes.NewReader(encodeFrameHeader(10)[:2]), 0); !errors.Is(err, pluginapi.ErrShortFrame) {
		t.Fatalf("帧头截断应返回 ErrShortFrame，实际: %v", err)
	} else if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("帧头截断应保留 io.ErrUnexpectedEOF，实际: %v", err)
	}
	short := append(encodeFrameHeader(10), []byte("abc")...)
	if _, err := pluginapi.ReadFrame(bytes.NewReader(short), 0); !errors.Is(err, pluginapi.ErrShortFrame) {
		t.Fatalf("载荷截断应返回 ErrShortFrame，实际: %v", err)
	}
}
