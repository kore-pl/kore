package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// reqIDKey 是请求 id 在 context 中的私有键。
type reqIDKey struct{}

// reqIDPattern 限制外部传入的 X-Request-ID 形态；不合法时内核重新生成。
var reqIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// withRequestID 读取或生成 request id，写入响应头与 context，供 invoke 透传给 bus。
//
// 中间件链完整版（recover/access_log/body_limit/auth/csrf/rate_limit）归 M1-14；
// M1 只落地 req_id —— 没有它，跨进程日志无法串起来。
func (s *Server) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !reqIDPattern.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), reqIDKey{}, id)))
	})
}

// newRequestID 生成 r-<16 hex> 的请求 id。
func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "r-0000000000000000"
	}
	return "r-" + hex.EncodeToString(buf)
}

// requestIDFrom 取 context 中的请求 id；缺失时返回空串（bus 会自行生成）。
func requestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(reqIDKey{}).(string)
	return id
}

// statusFor 把协议错误码映射为 HTTP 状态码（PLUGIN-PROTOCOL §9）。
func statusFor(code string) int {
	switch code {
	case pluginapi.E_INVALID:
		return http.StatusBadRequest
	case pluginapi.E_UNAUTHORIZED:
		return http.StatusUnauthorized
	case pluginapi.E_NOTFOUND:
		return http.StatusNotFound
	case pluginapi.E_CONFLICT:
		return http.StatusConflict
	case pluginapi.E_UPSTREAM:
		return http.StatusBadGateway
	case pluginapi.E_UNSUPPORTED:
		return http.StatusNotImplemented
	case pluginapi.E_RATELIMIT:
		return http.StatusTooManyRequests
	default:
		return http.StatusInternalServerError
	}
}

// writeFailure 把内核错误统一写成 {code,message,detail}；非协议错误按 E_INTERNAL 处理。
func writeFailure(w http.ResponseWriter, err error) {
	var protocolErr *pluginapi.Error
	if !errors.As(err, &protocolErr) {
		slog.Error("HTTP handler 内部错误", "err", err)
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "内核内部错误", err.Error())
		return
	}
	writeError(w, statusFor(protocolErr.Code), protocolErr.Code, protocolErr.Message, string(protocolErr.Detail))
}
