package httpapi

import "net/http"

// InstallState 是 httpapi 对安装一次性标记的只读视图（显式标量，本包不 import store）。
// 由 cmd/kored 装配层用适配器把 store.Store 映射过来（G-01 薄壳边界）。
type InstallState struct {
	InstallGeneration string
	OnboardingDone    bool
	ShouldAutoOpen    bool
}

// InstallStateProvider 是 httpapi 依赖的最小只读 + 完成记录接口。
// GetInstallState 只读；MarkOnboardingDone 幂等写"已完成"（不是未鉴权写端点，
// 走 withAuth 会话校验）。装配层把 store.Store 适配为本接口。
type InstallStateProvider interface {
	GetInstallState() (InstallState, error)
	MarkOnboardingDone() error
}

// InstallStateView 是公开的"本次安装是否需要自动显示新手引导"只读视图。
// 只暴露不可伪造的标量布尔与安装代次字符串，不含任何内部信息；前端登录前即可读取。
type InstallStateView struct {
	// InstallGeneration 是安装代次（RFC3339）；空串表示尚未打标记。
	InstallGeneration string `json:"install_generation"`
	// OnboardingDone 表示该安装代次的引导已完成 / 已跳过。
	OnboardingDone bool `json:"onboarding_done"`
	// ShouldAutoOpen 为 true 仅当"安装那一次"且尚未完成。
	ShouldAutoOpen bool `json:"should_auto_open"`
}

// onboardingBody 是统一 {code,message,data} 响应形状（与本仓其它端点一致）。
type onboardingBody struct {
	Code    string           `json:"code"`
	Message string           `json:"message"`
	Data    InstallStateView `json:"data"`
}

// handleInstallState 未登录可读：返回本次安装是否需要自动弹引导。
func (s *Server) handleInstallState(w http.ResponseWriter, _ *http.Request) {
	st := s.installState()
	writeJSON(w, http.StatusOK, onboardingBody{
		Code: "ok", Message: "ok",
		Data: InstallStateView{
			InstallGeneration: st.InstallGeneration,
			OnboardingDone:    st.OnboardingDone,
			ShouldAutoOpen:    st.ShouldAutoOpen,
		},
	})
}

// handleOnboardingDone 记录"该安装代次的引导已完成 / 已跳过"：幂等、需登录。
// 没有装配 InstallState 时回 501 E_UNSUPPORTED，不假装成功。
func (s *Server) handleOnboardingDone(w http.ResponseWriter, _ *http.Request) {
	if s.opts.InstallState == nil {
		writeError(w, http.StatusNotImplemented, "E_UNSUPPORTED", "引导状态未装配", "")
		return
	}
	if err := s.opts.InstallState.MarkOnboardingDone(); err != nil {
		writeError(w, http.StatusInternalServerError, "E_STORE", "记录引导完成状态失败", err.Error())
		return
	}
	st := s.installState()
	writeJSON(w, http.StatusOK, onboardingBody{Code: "ok", Message: "ok", Data: InstallStateView{
		InstallGeneration: st.InstallGeneration, OnboardingDone: st.OnboardingDone, ShouldAutoOpen: st.ShouldAutoOpen,
	}})
}

// installState 安全取状态：未装配或读取失败时返回"不自动弹"的稳定默认，绝不误触发引导。
func (s *Server) installState() InstallState {
	if s.opts.InstallState == nil {
		return InstallState{}
	}
	st, err := s.opts.InstallState.GetInstallState()
	if err != nil {
		return InstallState{}
	}
	return st
}
