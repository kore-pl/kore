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
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// maxInvokeBody 是 /invoke 的请求体上限（8 MiB，与协议单帧上限一致）。
	maxInvokeBody = 8 << 20
	// reservedMethodPrefix 是协议保留方法前缀，业务入口禁止调用。
	reservedMethodPrefix = "kore."
)

// methodPattern 是业务方法名语法：单段动词或点分多段（PLUGIN-PROTOCOL §7.2）。
// 段首必须小写；段内允许字母（含大写，camelCase）、数字、下划线与连字符——
// 插件按自身命名声明 site.bindSSL / site.setRewrite 这类方法，入口必须与
// 插件方法注册表同口径，否则声明了却调不到。
var methodPattern = regexp.MustCompile(`^[a-z][A-Za-z0-9_-]*(\.[a-z][A-Za-z0-9_-]*)*$`)

// handleInvoke 把 HTTP body 当作插件方法参数转发给 bus，成功时直接返回业务 result。
//
// 目标操作校验见 authorizeInvoke：会话有效性 + 按目标插件声明的能力做调用校验
// （内核只认 system:/net:/proc: 前缀与 read/write/admin 动作分级，不维护业务词表）。
func (s *Server) handleInvoke(w http.ResponseWriter, r *http.Request) {
	auth, ok := s.authorizeInvoke(w, r)
	if !ok {
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
	start := time.Now()
	result, err := s.opts.Backend.Invoke(r.Context(), plugin, method, params, requestIDFrom(r.Context()))
	// 审计口径与授权口径一致：needAdmin（写/管理类）才落 invoke.*，只读默认不审计；
	// audit.invoke_all=true 时全量审计；同一方法 1s 内超阈值合并成 invoke.burst。
	s.recordInvokeAudit(plugin, method, auth, time.Since(start), err)
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
// capability 校验不在方法名层做：内核不维护「方法 → 业务能力」映射表（G-01），
// 只按目标插件声明的宿主前缀在 authorizeInvoke 里做调用校验。
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
