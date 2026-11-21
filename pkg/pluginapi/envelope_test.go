package pluginapi_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// 编译期断言：*Error 实现 error 接口，handler 可直接把协议错误体当 error 返回。
var _ error = (*pluginapi.Error)(nil)

// TestDecodeFrameInvalid 覆盖空载荷、非法 JSON、非对象、缺 type、type 类型错误与未知 type。
func TestDecodeFrameInvalid(t *testing.T) {
	cases := []struct {
		name    string
		payload []byte
		want    error
	}{
		{"空载荷", nil, pluginapi.ErrEmptyPayload},
		{"非法 JSON", []byte("{not json"), pluginapi.ErrInvalidJSON},
		{"非对象", []byte("123"), pluginapi.ErrInvalidJSON},
		{"缺少 type", []byte(`{"id":"x"}`), pluginapi.ErrInvalidJSON},
		{"type 类型错误", []byte(`{"type":5}`), pluginapi.ErrInvalidJSON},
		{"未知 type", []byte(`{"type":"bogus"}`), pluginapi.ErrUnknownType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg, err := pluginapi.DecodeFrame(tc.payload)
			if msg != nil {
				t.Fatalf("非法载荷不应返回消息: %#v", msg)
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v，应可判为 %v", err, tc.want)
			}
		})
	}
}

// TestDecodeFrameIgnoresUnknownFields 按协议演进规则，未识别的可选字段必须被忽略而不是报错。
func TestDecodeFrameIgnoresUnknownFields(t *testing.T) {
	payload := []byte(`{"type":"request","id":"x","method":"echo.echo","future_field":{"a":1}}`)
	msg, err := pluginapi.DecodeFrame(payload)
	if err != nil {
		t.Fatalf("含未知可选字段应可解码: %v", err)
	}
	req, ok := msg.(*pluginapi.Request)
	if !ok {
		t.Fatalf("应解码为 *Request，实际 %T", msg)
	}
	if req.Method != "echo.echo" {
		t.Fatalf("method = %q", req.Method)
	}
}

// TestTimeoutSemantics 固化 timeout_ms 规范：<=0 取默认、越界夹到 1000–120000，字段本身透传不改写。
func TestTimeoutSemantics(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{0, pluginapi.DefaultTimeoutMS},
		{-1, pluginapi.DefaultTimeoutMS},
		{1, pluginapi.MinTimeoutMS},
		{999, pluginapi.MinTimeoutMS},
		{1000, 1000},
		{15000, 15000},
		{120000, 120000},
		{120001, pluginapi.MaxTimeoutMS},
	}
	for _, tc := range cases {
		if got := pluginapi.Timeout(tc.in); got != tc.want {
			t.Fatalf("Timeout(%d) = %d，want %d", tc.in, got, tc.want)
		}
	}

	var buf bytes.Buffer
	req := &pluginapi.Request{Type: pluginapi.TypeRequest, ID: "x", Method: "echo.echo", TimeoutMS: -5}
	if err := pluginapi.WriteJSON(&buf, req); err != nil {
		t.Fatalf("WriteJSON 失败: %v", err)
	}
	payload, err := pluginapi.ReadFrame(&buf, 0)
	if err != nil {
		t.Fatalf("ReadFrame 失败: %v", err)
	}
	msg, err := pluginapi.DecodeFrame(payload)
	if err != nil {
		t.Fatalf("DecodeFrame 失败: %v", err)
	}
	got := msg.(*pluginapi.Request)
	if got.TimeoutMS != -5 {
		t.Fatalf("timeout_ms 应原样透传，实际 %d", got.TimeoutMS)
	}
	if pluginapi.Timeout(got.TimeoutMS) != pluginapi.DefaultTimeoutMS {
		t.Fatalf("<=0 应取默认值 %d", pluginapi.DefaultTimeoutMS)
	}
}
