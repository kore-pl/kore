package pluginapi

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// MaxFrameSize 是单帧载荷的协议硬上限：8 MiB（8,388,608 字节）。
// 口径是「整帧 JSON 载荷」，不含 4 字节长度前缀本身，也不存在「扣掉帧头」的算法。
const MaxFrameSize = 8 << 20

// minFrameSize 是最短合法载荷长度：每个载荷都必须是完整 JSON 对象，最短为 "{}"。
// 该判定按 JSON 会话口径；M3 引入 protobuf 会话后若出现合法短载荷，必须按连接编码放宽。
const minFrameSize = 2

// 帧编解码哨兵错误，供调用方用 errors.Is 区分失败类型。
var (
	// ErrFrameTooLarge 表示长度前缀超出上限：读侧在分配载荷缓冲前返回，写侧在写出任何字节前返回。
	ErrFrameTooLarge = errors.New("pluginapi: 帧载荷超过 8 MiB 上限")
	// ErrEmptyPayload 表示长度前缀为 0 的空载荷帧；协议要求载荷是完整 JSON 对象，不存在空载荷形式。
	ErrEmptyPayload = errors.New("pluginapi: 帧载荷为空")
	// ErrPayloadTooShort 表示长度前缀为 1：不足以构成最短 JSON 对象 "{}"。
	ErrPayloadTooShort = errors.New("pluginapi: 帧载荷不足 2 字节，无法构成 JSON 对象")
	// ErrShortFrame 表示帧未读完连接就中断（读长度前缀或读载荷时遇到 EOF）；
	// 帧边界上的正常关闭返回 io.EOF，不返回本错误。
	ErrShortFrame = errors.New("pluginapi: 帧不完整（连接提前结束）")
)

// ReadFrame 从 r 读取一帧并返回载荷字节，不做 JSON 解析（M3 protobuf 复用同一入口）。
//
// 线格式为 [4 字节大端长度][该长度的载荷]，没有额外帧头字节。max 是调用方接受的上限：
// max <= 0 或 max > MaxFrameSize 时按协议上限 MaxFrameSize 处理（协议上限不可放宽）。
//
// 读侧先只读 4 字节栈缓冲的长度前缀并立即校验，超限、空载荷或过短时在分配载荷缓冲之前
// 就返回错误，因此超长帧既不分配大块内存、也不读取载荷。半包（载荷分片到达）与
// 粘包（一次到达多帧）分别由 io.ReadFull 与「每次只读一帧」的调用方式处理。
//
// 返回 ErrFrameTooLarge / ErrEmptyPayload / ErrPayloadTooShort / ErrShortFrame 时该连接已不可
// 继续使用（超限帧的载荷未读走、截断帧字节数不齐），调用方应按协议关闭连接；io.EOF 表示
// 对端在帧边界上正常关闭。
func ReadFrame(r io.Reader, max int) ([]byte, error) {
	if max <= 0 || max > MaxFrameSize {
		max = MaxFrameSize
	}
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		if err == io.EOF {
			return nil, io.EOF // 帧边界上的干净关闭
		}
		return nil, fmt.Errorf("%w: %w", ErrShortFrame, err)
	}
	n := binary.BigEndian.Uint32(hdr[:])
	switch {
	case n == 0:
		return nil, ErrEmptyPayload
	case n < minFrameSize:
		return nil, ErrPayloadTooShort
	case int(n) > max:
		return nil, ErrFrameTooLarge
	}
	// 走到这里说明 n 已过 0/1/上限三重校验（n <= max <= MaxFrameSize），此时才分配载荷缓冲。
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrShortFrame, err)
	}
	return payload, nil
}

// WriteFrame 把 payload 作为一帧写入 w：先校验长度，空载荷或超限时一个字节都不写。
//
// 长度前缀与载荷拼进同一个缓冲区后一次 Write 写出，避免两帧的 4 字节头交错；
// 调用方仍需按连接串行化写入（例如每连接一把互斥锁）。
func WriteFrame(w io.Writer, payload []byte) error {
	switch {
	case len(payload) == 0:
		return ErrEmptyPayload
	case len(payload) < minFrameSize:
		return ErrPayloadTooShort
	case len(payload) > MaxFrameSize:
		return ErrFrameTooLarge
	}
	buf := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(buf[:4], uint32(len(payload)))
	copy(buf[4:], payload)
	n, err := w.Write(buf)
	if err != nil {
		return fmt.Errorf("pluginapi: 写帧失败: %w", err)
	}
	if n != len(buf) {
		return fmt.Errorf("%w: 只写出 %d/%d 字节", io.ErrShortWrite, n, len(buf))
	}
	return nil
}

// WriteJSON 先 json.Marshal 再按帧写出：序列化后超限直接返回错误，绝不写入半帧。
func WriteJSON(w io.Writer, v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("pluginapi: 序列化帧载荷失败: %w", err)
	}
	return WriteFrame(w, payload)
}
