package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 内核自升级端点（把 `kored upgrade` 暴露给面板，运行期不再需要终端/sudo）。
//
// 契约口径（ADR-0042 + `93d63c7` 的 CLI 语义，本文件只做"暴露通道"）：
//   - 来源必须是**本机绝对路径文件** + 期望 sha256；URL 一律拒绝，服务端不下载；
//   - 校验先于替换：sha256 不符时目标文件一个字节都不动（由 CLI 再校验一次）；
//   - 写操作需 system:admin + CSRF（与其它管理端点同一条中间件链）；
//   - 高危动作必须显式 confirm=true，缺省拒绝；
//   - 长动作返回 202 + job id，进度由客户端按需轮询 job（服务端零 ticker，G-19）；
//   - 发起/结果落审计，发起审计 fail-closed（写不进去就不开始升级）。
const (
	selfUpdatePath       = "/api/v1/system/upgrade"
	selfUpdateJobsPath   = selfUpdatePath + "/jobs"
	selfUpdateRollback   = selfUpdatePath + "/rollback"
	maxUpgradeBody       = 8 << 10
	sha256HexPatternText = `^[0-9a-f]{64}$`
)

var sha256HexPattern = regexp.MustCompile(sha256HexPatternText)

// 自升级错误哨兵：装配层用 %w 包装，HTTP 层用 errors.Is 映射状态码与错误码。
var (
	// ErrUpgradeSource 来源非法（URL / 非绝对路径 / 不可读 / 是目录）。
	ErrUpgradeSource = errors.New("升级来源非法")
	// ErrUpgradeChecksum sha256 不匹配（拒绝替换）。
	ErrUpgradeChecksum = errors.New("sha256 校验失败")
	// ErrUpgradeNeedRoot 运行进程不是 root，无法替换/重启自身。
	ErrUpgradeNeedRoot = errors.New("需要 root 运行身份")
	// ErrUpgradeBusy 已有升级/回滚任务在跑。
	ErrUpgradeBusy = errors.New("已有升级任务在执行")
	// ErrUpgradeAudit 发起审计写入失败（fail-closed，升级未开始）。
	ErrUpgradeAudit = errors.New("升级审计写入失败")
	// ErrUpgradeRestart 二进制已替换但重启未提交。
	ErrUpgradeRestart = errors.New("重启未提交")
)

// SelfUpdateBinary 是一个可升级/回滚的目标二进制视图。
type SelfUpdateBinary struct {
	// Path 绝对路径。
	Path string `json:"path"`
	// SHA256 当前磁盘摘要（小写 hex；读不到时为空）。
	SHA256 string `json:"sha256"`
}

// SelfUpdateMarker 是 upgrade-result.json 的对外视图（state=pending/success/rollback-pending）。
type SelfUpdateMarker struct {
	// State 标记状态。
	State string `json:"state"`
	// FromSHA256 是替换前的旧二进制摘要。
	FromSHA256 string `json:"from_sha256"`
	// ToSHA256 是本次校验通过的新二进制摘要。
	ToSHA256 string `json:"to_sha256"`
	// Version 写标记的进程版本。
	Version string `json:"version"`
	// UpdatedAt 替换发生时间（RFC3339）。
	UpdatedAt string `json:"updated_at"`
	// VerifiedAt 新进程确认生效时间；pending 时为空。
	VerifiedAt string `json:"verified_at,omitempty"`
}

// SelfUpdateStatus 是 GET /api/v1/system/upgrade 的响应体（显式字段，G-24）。
type SelfUpdateStatus struct {
	// Current 当前运行的二进制。
	Current SelfUpdateBinary `json:"current"`
	// Previous 可回滚的 `<bin>.prev`；不存在时 nil。
	Previous *SelfUpdateBinary `json:"previous,omitempty"`
	// Marker 最近一次升级标记（pending/success/rollback-pending）；从未升级过为 nil。
	Marker *SelfUpdateMarker `json:"marker,omitempty"`
	// CanUpgrade 当前进程是否有权限执行升级（root）。
	CanUpgrade bool `json:"can_upgrade"`
	// CanRollback 是否存在 .prev 且具备 root 权限。
	CanRollback bool `json:"can_rollback"`
	// Reason 当 can_upgrade/can_rollback 为 false 时给出可操作原因。
	Reason string `json:"reason,omitempty"`
}

// SelfUpdateRequest 是 POST /api/v1/system/upgrade 的请求体（显式字段，禁 any）。
type SelfUpdateRequest struct {
	// SourcePath 新二进制本机绝对路径（不接受 URL）。
	SourcePath string `json:"source_path"`
	// SHA256 新二进制期望摘要（64 位小写 hex，可带 sha256: 前缀）。
	SHA256 string `json:"sha256"`
	// Confirm 高危二次确认：必须显式为 true。
	Confirm bool `json:"confirm"`
}

// SelfUpdateRollbackRequest 是回滚请求体；confirm 同样必填。
type SelfUpdateRollbackRequest struct {
	// SHA256 可选：给定时必须等于 .prev 的摘要，否则拒绝回滚。
	SHA256 string `json:"sha256,omitempty"`
	// Confirm 高危二次确认：必须显式为 true。
	Confirm bool `json:"confirm"`
}

// SelfUpdateJob 是一次升级/回滚任务的进度视图（内存态，不落库）。
type SelfUpdateJob struct {
	// ID 任务 id（进程内唯一）。
	ID string `json:"id"`
	// Kind upgrade / rollback。
	Kind string `json:"kind"`
	// State queued / running / success / failed。
	State string `json:"state"`
	// Message 面向用户的一句话结果/当前阶段。
	Message string `json:"message"`
	// ErrorCode 失败时的错误码（E_UPGRADE_SOURCE / E_UPGRADE_CHECKSUM /
	// E_NEED_ROOT / E_UPGRADE_RESTART / E_INTERNAL）。
	ErrorCode string `json:"error_code,omitempty"`
	// ExitCode CLI 子命令退出码（0 成功；2 校验失败；6 非 root/重启未提交）。
	ExitCode int `json:"exit_code"`
	// StartedAt / FinishedAt RFC3339；未结束的 FinishedAt 为空。
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at,omitempty"`
	// Output 最近一段 CLI 输出（有界，供面板展示"卡在哪"）。
	Output string `json:"output,omitempty"`
}

// SelfUpdater 是装配层（cmd/kored daemon）可选实现的自升级能力。
//
// 用可选接口而不是扩 Backend：未装配的测试替身不会被强制改造；未实现时端点回 501。
type SelfUpdater interface {
	// UpgradeStatus 只读探测当前版本、可回滚目标与最近一次标记。
	UpgradeStatus(ctx context.Context) (SelfUpdateStatus, error)
	// StartUpgrade 同步完成预检 + 发起审计（fail-closed），随后异步执行替换。
	StartUpgrade(ctx context.Context, actor string, req SelfUpdateRequest) (SelfUpdateJob, error)
	// StartRollback 用 `<bin>.prev` 回滚。
	StartRollback(ctx context.Context, actor string, req SelfUpdateRollbackRequest) (SelfUpdateJob, error)
	// UpgradeJob 查询任务进度；未知 id 第二返回值为 false。
	UpgradeJob(id string) (SelfUpdateJob, bool)
}

// selfUpdater 取装配层的自升级实现；未装配时回 501（不假装成功）。
func (s *Server) selfUpdater(w http.ResponseWriter) (SelfUpdater, bool) {
	if s.opts.Backend == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "后端未装配", "")
		return nil, false
	}
	updater, ok := s.opts.Backend.(SelfUpdater)
	if !ok {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "当前装配不支持内核自升级", "")
		return nil, false
	}
	return updater, true
}

// handleUpgradeStatus 返回当前版本、可回滚目标与最近一次升级标记。
func (s *Server) handleUpgradeStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
	updater, ok := s.selfUpdater(w)
	if !ok {
		return
	}
	status, err := updater.UpgradeStatus(r.Context())
	if err != nil {
		writeUpgradeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// handleUpgradeStart 发起一次自升级：预检 → 审计（fail-closed）→ 202 + job。
//
// 幂等/并发口径：同一进程同时只允许一个升级或回滚任务；已有任务时回 409，
// 不做队列（升级会重启进程，排队没有可执行的语义）。
func (s *Server) handleUpgradeStart(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
	updater, ok := s.selfUpdater(w)
	if !ok {
		return
	}
	var body SelfUpdateRequest
	if perr := readStrictBody(w, r, &body); perr != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, perr.Error(), "")
		return
	}
	if !body.Confirm {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"升级会重启内核，必须显式确认（confirm=true）", "")
		return
	}
	if strings.TrimSpace(body.SourcePath) == "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "source_path 必填（本机绝对路径）", "")
		return
	}
	job, err := updater.StartUpgrade(r.Context(), selfUpdateActor(r), body)
	if err != nil {
		writeUpgradeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

// handleUpgradeRollback 用 `<bin>.prev` 回滚（同样需要 confirm）。
func (s *Server) handleUpgradeRollback(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
	updater, ok := s.selfUpdater(w)
	if !ok {
		return
	}
	var body SelfUpdateRollbackRequest
	if perr := readStrictBody(w, r, &body); perr != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, perr.Error(), "")
		return
	}
	if !body.Confirm {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"回滚会重启内核，必须显式确认（confirm=true）", "")
		return
	}
	job, err := updater.StartRollback(r.Context(), selfUpdateActor(r), body)
	if err != nil {
		writeUpgradeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

// handleUpgradeJob 查询任务进度（客户端按需轮询；服务端不主动推送、不起 ticker）。
func (s *Server) handleUpgradeJob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
	updater, ok := s.selfUpdater(w)
	if !ok {
		return
	}
	job, found := updater.UpgradeJob(r.PathValue("id"))
	if !found {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "升级任务不存在（可能已随重启丢失，请看状态标记）", r.PathValue("id"))
		return
	}
	writeJSON(w, http.StatusOK, job)
}

// readStrictBody 读取并严格解码小请求体（未知字段 / 超限 / 非法 JSON 均报错）。
func readStrictBody(w http.ResponseWriter, r *http.Request, dst any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxUpgradeBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return errors.New("请求体不能为空")
		}
		return errors.New("请求体非法：" + err.Error())
	}
	return nil
}

// selfUpdateActor 是审计主体：单管理员内核固定 admin。ADR-0043 之后本机通道
// （UDS/loopback）不是认证来源，也不存在「中间件保证的信任边界」：withAuth 对
// 全部 /api/v1/* 一律会话校验，本机通道只剩 CSRF 令牌引导与 UDS 的 CSRF 豁免
// 两项非认证用途，都不改变请求主体。
func selfUpdateActor(_ *http.Request) string { return "admin" }

// writeUpgradeFailure 把自升级错误映射成状态码与错误码。
//
// 映射：来源非法 400 / sha 不符 409 / 非 root 403 / 已忙 409 /
// 审计不可用 503（fail-closed，未开始升级）/ 重启未提交 500（二进制已替换）。
func writeUpgradeFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUpgradeSource):
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "升级来源非法", err.Error())
	case errors.Is(err, ErrUpgradeChecksum):
		writeError(w, http.StatusConflict, pluginapi.E_CONFLICT, "sha256 校验失败，已拒绝替换", err.Error())
	case errors.Is(err, ErrUpgradeNeedRoot):
		writeError(w, http.StatusForbidden, pluginapi.E_NEED_ROOT, "当前进程不是 root，无法自升级", err.Error())
	case errors.Is(err, ErrUpgradeBusy):
		writeError(w, http.StatusConflict, pluginapi.E_CONFLICT, "已有升级任务在执行", err.Error())
	case errors.Is(err, ErrUpgradeAudit):
		writeError(w, http.StatusServiceUnavailable, pluginapi.E_INTERNAL, "审计写入失败，升级未开始", err.Error())
	case errors.Is(err, ErrUpgradeRestart):
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "二进制已替换，但重启未提交", err.Error())
	default:
		writeFailure(w, err)
	}
}
