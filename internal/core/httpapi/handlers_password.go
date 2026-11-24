package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// changePasswordRequest 是 POST /api/v1/auth/password 的显式请求体（snake_case，
// 与 web/settings.js 逐字对齐）。两个字段只活在内存里：不写日志、不落审计、
// 不回显、不拼进错误消息（G-30）。
type changePasswordRequest struct {
	// CurrentPassword 是当前明文口令，仅用于 Verify。
	CurrentPassword string `json:"current_password"`
	// NewPassword 是新明文口令，校验长度与"不等于旧口令"后即派生哈希。
	NewPassword string `json:"new_password"`
}

// handleChangePassword 在线修改单管理员口令。
//
// 中间件链已保证到达此处的是：有效会话（withAuth）+ 双提交 CSRF（withCSRF，
// password 不在豁免清单）。单管理员自己改自己，无 RBAC（G-11）。
//
// 失败闭环顺序（fail-secure）：先吊销全部会话 → 再持久化配置 → 最后切换内存哈希。
// 这样任何持久层失败都不会留下"新口令已生效、旧会话还活着"的中间态：最坏是
// 会话被踢下线、口令仍是旧的，用户用旧口令重新登录即可，不存在越权窗口。
//
// G-30：明文口令不进日志/审计/响应/错误消息；所有失败文案固定，绝不回显输入。
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前实例未启用鉴权，无法在线改口令", "")
		return
	}
	if s.passwordWriter == nil {
		// 装配层未提供写回通道时绝不伪造成功：内存改了、重启就丢。
		slog.Error("改口令失败：未装配配置写回通道")
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL,
			"口令写入通道未就绪，请稍后重试或使用命令行修改", "")
		return
	}

	var req changePasswordRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体非法，请检查后重试", "")
		return
	}
	// 人话校验：先规则、后凭据。新口令太短或与旧口令相同都不是"当前口令错"，
	// 分开回 400，避免用户拿旧口令反复试（G-30：文案固定，不回显任何输入）。
	if len(req.NewPassword) < passwordMinLen {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"新口令至少需要 "+strconv.Itoa(passwordMinLen)+" 个字符，请设置更长的口令", "")
		return
	}
	if req.NewPassword == req.CurrentPassword {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"新口令不能与当前口令相同，请换一个", "")
		return
	}

	verified, err := s.auth.Verify(req.CurrentPassword)
	if err != nil || !verified {
		// 固定文案：既不区分"哈希非法"与"口令错"，也不回显输入片段。
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "当前口令不正确", "")
		return
	}

	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		// HashPassword 的错误只含随机源/派生信息，不含明文；仍只记日志不回显。
		slog.Error("改口令失败：派生哈希出错", "err", err)
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL,
			"口令处理失败，请稍后重试", "")
		return
	}

	// ① 先吊销全部会话（含当前会话），失败即中止、不写配置。
	if _, err := s.auth.RevokeAll(); err != nil {
		slog.Error("改口令失败：吊销旧会话出错", "err", err)
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL,
			"无法让旧会话失效，口令未修改，请稍后重试", "")
		return
	}
	// ② 持久化哈希；失败时内存哈希未切、配置未变，用户用旧口令重新登录即可。
	if err := s.passwordWriter(hash); err != nil {
		slog.Error("改口令失败：写入配置出错", "err", err)
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL,
			"口令写入配置失败，请稍后重试或使用命令行修改", "")
		return
	}
	// ③ 切换内存校验基准（原子替换，之后的新登录用新口令）。
	s.auth.SetPasswordHash(hash)

	// 清会话 cookie 与 CSRF cookie：前端仍会幂等调 logout，这里再清一次兜底。
	s.auth.ClearCookie(w, r)
	secure, _ := sessionCookieAttrs(w)
	writeCSRFCookie(w, "", secure, -1)

	writeJSON(w, http.StatusOK, sessionBody{Authenticated: false})
}
