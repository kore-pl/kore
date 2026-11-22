package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// maxInvokeBody 是 /invoke 的请求体上限（8 MiB，与协议单帧上限一致）。
	maxInvokeBody = 8 << 20
	// reservedMethodPrefix 是协议保留方法前缀，业务入口禁止调用。
	reservedMethodPrefix = "kore."
)

// methodPattern 是业务方法名语法：单段动词或点分多段（PLUGIN-PROTOCOL §7.2）。
var methodPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$`)

// handleInvoke 把 HTTP body 当作插件方法参数转发给 bus，成功时直接返回业务 result。
//
// 目标操作校验入口见 authorizeTargetAction（M1 只验 session，TODO 裁决40）；
// 细粒度方法 → capability 映射仍归 M4，M1 只校验方法名合法。
func (s *Server) handleInvoke(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
	if s.opts.Backend == nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "后端未装配", "")
		return
	}
	plugin, method := r.PathValue("plugin"), r.PathValue("method")
	if err := validateMethod(plugin, method); err != nil {
		writeFailure(w, err)
		return
	}
	params, err := readParams(w, r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	result, err := s.opts.Backend.Invoke(r.Context(), plugin, method, params, requestIDFrom(r.Context()))
	if err != nil {
		writeFailure(w, err)
		return
	}
	if len(result) == 0 {
		result = json.RawMessage(`{}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result)
}

// validateMethod 校验方法名语法与保留前缀；点分方法的域必须等于路径里的插件 id。
//
// M4 会在此处追加 capability 校验（方法所需能力 ⊆ 已授予能力，裁决40），本阶段不做。
func validateMethod(plugin, method string) error {
	if plugin == "" || !methodPattern.MatchString(method) {
		return errf(pluginapi.E_INVALID, "方法名 %q 不合法", method)
	}
	if strings.HasPrefix(method, reservedMethodPrefix) {
		return errf(pluginapi.E_INVALID, "协议保留方法 %q 不能经业务入口调用", method)
	}
	if domain, _, ok := strings.Cut(method, "."); ok && domain != plugin {
		return errf(pluginapi.E_INVALID, "方法 %q 的域与插件 %q 不一致", method, plugin)
	}
	return nil
}

// readParams 读取并校验 params：空 body / null 归一为 {}，其余必须是 JSON 对象。
func readParams(w http.ResponseWriter, r *http.Request) (json.RawMessage, error) {
	limited := http.MaxBytesReader(w, r.Body, maxInvokeBody)
	data, err := io.ReadAll(limited)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, errf(pluginapi.E_INVALID, "请求体超过 %d 字节上限", maxInvokeBody)
		}
		return nil, errf(pluginapi.E_INVALID, "读取请求体失败：%v", err)
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage(`{}`), nil
	}
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return nil, errf(pluginapi.E_INVALID, "请求体必须是 JSON 对象")
	}
	return json.RawMessage(trimmed), nil
}

// errf 构造带协议错误码的统一错误体。
func errf(code, format string, args ...any) *pluginapi.Error {
	return &pluginapi.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
