package main

// 内核自升级的装配层实现：把 `kored upgrade` 的既有语义（sha256 校验 → 原子替换 →
// 保留 .prev → pending 标记 → 提交重启）暴露给 HTTP 面板，不复制、不改写 CLI 逻辑。
//
// 边界：
//   - 本文件只做"暴露通道"：实际替换/回滚仍由 runUpgradeWith 执行（cmd/kored/upgrade.go）；
//   - 预检（root / 绝对路径 / URL 拒绝 / sha256 比对）在 HTTP 返回前完成，错误可映射；
//   - 发起审计 fail-closed：写不进 audit bucket 就不开始替换；
//   - 任务进度只存内存，重启后由 upgrade-result.json + 状态端点给出真相。

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// 升级审计动作名（docs/DATA-MODEL.md §9 扩展）。
	upgradeAuditStart  = "upgrade.start"
	upgradeAuditResult = "upgrade.result"
	// upgradeJobOutputMax 是任务 output 保留的字节上限（面板展示"卡在哪"，不撑内存）。
	upgradeJobOutputMax = 4 << 10
	// upgradeJobStates 是任务状态字符串（显式常量，不用魔法值）。
	upgradeJobQueued  = "queued"
	upgradeJobRunning = "running"
	upgradeJobSuccess = "success"
	upgradeJobFailed  = "failed"
)

// selfUpdater 实现 httpapi.SelfUpdater；由 daemon 持有并暴露给 HTTP 层。
type selfUpdater struct {
	// db 是审计落库句柄（fail-closed 发起审计）。
	db *store.Store
	// version 是当前进程版本（写审计与状态展示用）。
	version string
	// deps 是 CLI 升级链的注入点（测试替换，生产用默认实现）。
	deps upgradeDeps
	// stateFallback 是配置解析失败时的状态目录兜底（cfg.StateDir）。
	stateFallback string
	// audit 是审计写入函数（默认 db.PutAudit；测试替换）。
	audit func(store.AuditRecord) error
	// now 是时间源（测试可替换）。
	now func() time.Time

	mu   sync.Mutex
	jobs map[string]*httpapi.SelfUpdateJob
	seq  int
}

// newSelfUpdater 构造生产实现。
func newSelfUpdater(db *store.Store, app *platform.Platform, cfg config) *selfUpdater {
	up := &selfUpdater{
		db:      db,
		version: version,
		deps:    defaultUpgradeDeps(),
		audit:   db.PutAudit,
		now:     time.Now,
		jobs:    make(map[string]*httpapi.SelfUpdateJob),
	}
	if app != nil {
		up.stateFallback = app.Paths.Dir(platform.DirState)
	} else {
		up.stateFallback = cfg.StateDir
	}
	return up
}

// UpgradeStatus 实现 httpapi.SelfUpdater。
func (u *selfUpdater) UpgradeStatus(context.Context) (httpapi.SelfUpdateStatus, error) {
	target, err := u.targetBinary()
	if err != nil {
		return httpapi.SelfUpdateStatus{}, err
	}
	status := httpapi.SelfUpdateStatus{
		Current: httpapi.SelfUpdateBinary{Path: target},
	}
	if sum, err := u.deps.sha256File(target); err == nil {
		status.Current.SHA256 = sum
	}
	prevPath := target + upgradePrevSuffix
	if sum, err := u.deps.sha256File(prevPath); err == nil {
		status.Previous = &httpapi.SelfUpdateBinary{Path: prevPath, SHA256: sum}
	}
	if stateDir, err := u.stateDir(); err == nil {
		if marker, err := readUpgradeResult(upgradeResultPath(stateDir)); err == nil {
			status.Marker = &httpapi.SelfUpdateMarker{
				State: marker.State, FromSHA256: marker.PreviousSHA256, ToSHA256: marker.ExpectedSHA256,
				Version: marker.Version, UpdatedAt: marker.UpdatedAt, VerifiedAt: marker.VerifiedAt,
			}
		}
	}
	root := u.deps.euid() == 0
	status.CanUpgrade = root
	status.CanRollback = root && status.Previous != nil
	switch {
	case !root:
		status.Reason = "当前进程不是 root：替换自身二进制与重启 systemd unit 都需要系统服务身份（ADR-0042）"
	case status.Previous == nil:
		status.Reason = "尚无 .prev 备份：只会由升级/回滚产生，首次升级后即可回滚"
	}
	return status, nil
}

// StartUpgrade 实现 httpapi.SelfUpdater：预检 → fail-closed 审计 → 异步执行。
func (u *selfUpdater) StartUpgrade(_ context.Context, actor string, req httpapi.SelfUpdateRequest) (httpapi.SelfUpdateJob, error) {
	want, err := u.preflight(req.SourcePath, req.SHA256)
	if err != nil {
		return httpapi.SelfUpdateJob{}, err
	}
	target, err := u.targetBinary()
	if err != nil {
		return httpapi.SelfUpdateJob{}, err
	}
	from := u.fileSHAOrEmpty(target)
	job, err := u.launch(actor, "upgrade", target, from, want,
		[]string{"--bin", strings.TrimSpace(req.SourcePath), "--sha256", want})
	if err != nil {
		return httpapi.SelfUpdateJob{}, err
	}
	return job, nil
}

// StartRollback 实现 httpapi.SelfUpdater：用 `<bin>.prev` 回滚。
func (u *selfUpdater) StartRollback(_ context.Context, actor string, req httpapi.SelfUpdateRollbackRequest) (httpapi.SelfUpdateJob, error) {
	if u.deps.euid() != 0 {
		return httpapi.SelfUpdateJob{}, fmt.Errorf("%w：当前 euid=%d", httpapi.ErrUpgradeNeedRoot, u.deps.euid())
	}
	target, err := u.targetBinary()
	if err != nil {
		return httpapi.SelfUpdateJob{}, err
	}
	prevPath := target + upgradePrevSuffix
	if _, err := os.Stat(prevPath); err != nil {
		return httpapi.SelfUpdateJob{}, fmt.Errorf("%w：%s 不存在（尚未升级过）", httpapi.ErrUpgradeSource, prevPath)
	}
	args := []string{"--rollback"}
	if raw := strings.TrimSpace(req.SHA256); raw != "" {
		want, err := normalizeSHA256(raw)
		if err != nil {
			return httpapi.SelfUpdateJob{}, fmt.Errorf("%w：%v", httpapi.ErrUpgradeSource, err)
		}
		got, err := u.deps.sha256File(prevPath)
		if err != nil {
			return httpapi.SelfUpdateJob{}, fmt.Errorf("%w：读取 .prev 失败: %v", httpapi.ErrUpgradeSource, err)
		}
		if got != want {
			return httpapi.SelfUpdateJob{}, fmt.Errorf("%w：.prev 期望 %s，实际 %s", httpapi.ErrUpgradeChecksum, want, got)
		}
		args = append(args, "--sha256", want)
	}
	from := u.fileSHAOrEmpty(target)
	to := u.fileSHAOrEmpty(prevPath)
	job, err := u.launch(actor, "rollback", target, from, to, args)
	if err != nil {
		return httpapi.SelfUpdateJob{}, err
	}
	return job, nil
}

// UpgradeJob 实现 httpapi.SelfUpdater：返回任务快照。
func (u *selfUpdater) UpgradeJob(id string) (httpapi.SelfUpdateJob, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	job, ok := u.jobs[id]
	if !ok {
		return httpapi.SelfUpdateJob{}, false
	}
	return *job, true
}

// preflight 在发起前完成全部可同步判定的检查，错误直接映射成 4xx。
func (u *selfUpdater) preflight(sourcePath, rawSHA string) (string, error) {
	if u.deps.euid() != 0 {
		return "", fmt.Errorf("%w：当前 euid=%d；请以系统服务（root）运行内核后再从面板升级",
			httpapi.ErrUpgradeNeedRoot, u.deps.euid())
	}
	path := strings.TrimSpace(sourcePath)
	if path == "" {
		return "", fmt.Errorf("%w：source_path 不能为空", httpapi.ErrUpgradeSource)
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w：source_path 必须是本机绝对路径（URL 与相对路径一律拒绝）", httpapi.ErrUpgradeSource)
	}
	if err := validateUpgradeSource(path); err != nil {
		return "", fmt.Errorf("%w：%v", httpapi.ErrUpgradeSource, err)
	}
	want, err := normalizeSHA256(rawSHA)
	if err != nil {
		return "", fmt.Errorf("%w：%v", httpapi.ErrUpgradeSource, err)
	}
	got, err := u.deps.sha256File(path)
	if err != nil {
		return "", fmt.Errorf("%w：读取新二进制失败: %v", httpapi.ErrUpgradeSource, err)
	}
	if got != want {
		return "", fmt.Errorf("%w：期望 %s，实际 %s（目标文件未改动）", httpapi.ErrUpgradeChecksum, want, got)
	}
	return want, nil
}

// launch 登记任务 → fail-closed 审计 → 异步执行 CLI。
//
// 返回值是**锁内快照**：u.jobs 里的 *SelfUpdateJob 由 run goroutine 在 u.mu 下持续改写，
// 返回该指针会让调用方在锁外读一个正在被写的结构体（-race 实测：StartUpgrade 的
// `return *job` 与 run 的 `stored.State = running` 构成真实竞争，可能读到撕裂的 string 头）。
func (u *selfUpdater) launch(actor, kind, target, from, to string, args []string) (httpapi.SelfUpdateJob, error) {
	u.mu.Lock()
	for _, existing := range u.jobs {
		if existing.State == upgradeJobQueued || existing.State == upgradeJobRunning {
			u.mu.Unlock()
			return httpapi.SelfUpdateJob{}, fmt.Errorf("%w：任务 %s 尚未结束", httpapi.ErrUpgradeBusy, existing.ID)
		}
	}
	u.seq++
	id := fmt.Sprintf("%d-%d", u.now().UnixNano(), u.seq)
	job := &httpapi.SelfUpdateJob{
		ID: id, Kind: kind, State: upgradeJobQueued,
		Message: "已受理，正在校验并替换", StartedAt: u.now().Format(time.RFC3339),
	}
	u.jobs[id] = job
	snapshot := *job // 锁内快照：run 与调用方都只拿副本，不再触碰 map 内的结构体
	u.mu.Unlock()

	// 发起审计 fail-closed：写不进审计库就撤销任务、不触碰二进制。
	if err := u.auditStrict(store.AuditRecord{
		Subject: actor, Action: upgradeAuditStart, Target: target, Result: store.AuditResultOK,
		Detail: map[string]string{
			"kind": kind, "from_sha256": from, "to_sha256": to, "version": u.version, "job_id": id,
		},
	}); err != nil {
		u.mu.Lock()
		delete(u.jobs, id)
		u.mu.Unlock()
		return httpapi.SelfUpdateJob{}, fmt.Errorf("%w：%v", httpapi.ErrUpgradeAudit, err)
	}

	go u.run(snapshot, target, from, to, args)
	return snapshot, nil
}

// run 执行 CLI 升级链并回填任务状态与结果审计。
func (u *selfUpdater) run(job httpapi.SelfUpdateJob, target, from, to string, args []string) {
	u.mu.Lock()
	if stored, ok := u.jobs[job.ID]; ok {
		stored.State = upgradeJobRunning
		stored.Message = "正在校验并替换二进制"
	}
	u.mu.Unlock()

	buf := &tailBuffer{max: upgradeJobOutputMax}
	exit := runUpgradeWith(args, buf, buf, u.deps)
	result := store.AuditResultOK
	state := upgradeJobSuccess
	code := ""
	message := "已完成校验与替换，重启已提交；新版本生效以状态标记变为 success 为准"
	switch {
	case exit == exitOK:
		// 成功：pending 标记已落盘，重启由 CLI 提交。
	case exit == exitConfig:
		state, result, code = upgradeJobFailed, store.AuditResultError, "E_UPGRADE_CHECKSUM"
		if strings.Contains(buf.String(), "sha256 校验失败") {
			code = "E_UPGRADE_CHECKSUM"
		} else {
			code = "E_INVALID"
		}
		message = "校验或参数失败，目标文件未改动（详见 output）"
	case exit == exitEnv:
		state, result, code = upgradeJobFailed, store.AuditResultError, "E_NEED_ROOT"
		if strings.Contains(buf.String(), "重启未提交") {
			code = "E_UPGRADE_RESTART"
			message = "二进制已替换，但重启未提交；请检查 systemd 后用状态标记复核"
		} else {
			message = "脚本环境不满足（非 root 或无法提交重启）"
		}
	default:
		state, result, code = upgradeJobFailed, store.AuditResultError, "E_INTERNAL"
		message = "升级链执行失败（详见 output）"
	}

	// 结果审计必须先于终态发布：升级链用 `systemctl --no-block` 提交重启
	// （upgrade.go 的 submitUpgradeRestart），终态一旦可见，本进程随时可能被
	// SIGTERM —— 晚写的结果审计会永久丢失，审计链就断在"已成功"那一刻。
	// 这个顺序同时是可见性契约：读者经 u.mu 看到终态，即蕴含结果审计已尝试；
	// 写失败仍只 WARN（与 HTTP 侧审计出口同口径，审计失败不翻转升级结果）。
	if err := u.audit(store.AuditRecord{
		Subject: "admin", Action: upgradeAuditResult, Target: target, Result: result,
		Detail: map[string]string{
			"kind": job.Kind, "from_sha256": from, "to_sha256": to,
			"exit_code": fmt.Sprintf("%d", exit), "job_id": job.ID, "error_code": code,
		},
	}); err != nil {
		slog.Warn("升级结果审计写入失败", "job", job.ID, "err", err)
	}

	// 终态发布放最后：在此之前的一切（结果审计）都对读到终态的读者可见。
	u.mu.Lock()
	if stored, ok := u.jobs[job.ID]; ok {
		stored.State = state
		stored.ErrorCode = code
		stored.ExitCode = exit
		stored.Message = message
		stored.FinishedAt = u.now().Format(time.RFC3339)
		stored.Output = buf.String()
	}
	u.mu.Unlock()
}

// auditStrict 写发起审计；db 未装配或写失败都返回错误（fail-closed）。
func (u *selfUpdater) auditStrict(rec store.AuditRecord) error {
	if u.audit == nil {
		return errors.New("审计出口未装配")
	}
	return u.audit(rec)
}

// targetBinary 解析当前可执行文件（与 CLI 的 resolveUpgradeTarget 同口径）。
func (u *selfUpdater) targetBinary() (string, error) {
	exe, err := u.deps.executable()
	if err != nil {
		return "", fmt.Errorf("解析当前可执行文件失败: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Abs(exe)
}

// stateDir 解析状态目录（配置优先；失败时用装配期兜底）。
func (u *selfUpdater) stateDir() (string, error) {
	if dir, err := u.deps.stateDir(""); err == nil && dir != "" {
		return dir, nil
	}
	if u.stateFallback != "" {
		return u.stateFallback, nil
	}
	return "", errors.New("状态目录不可用")
}

// fileSHAOrEmpty 读摘要；失败返回空串（审计 detail 允许空值，不阻断升级）。
func (u *selfUpdater) fileSHAOrEmpty(path string) string {
	sum, err := u.deps.sha256File(path)
	if err != nil {
		return ""
	}
	return sum
}

// tailBuffer 只保留最后 max 字节的输出（长日志不撑内存）。
type tailBuffer struct {
	max int
	buf bytes.Buffer
}

// Write 实现 io.Writer。
func (t *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if t.max <= 0 {
		return n, nil
	}
	if len(p) >= t.max {
		t.buf.Reset()
		_, _ = t.buf.Write(p[len(p)-t.max:])
		return n, nil
	}
	if t.buf.Len()+len(p) > t.max {
		raw := t.buf.Bytes()
		keep := append([]byte(nil), raw[len(raw)-(t.max-len(p)):]...)
		t.buf.Reset()
		_, _ = t.buf.Write(keep)
	}
	_, _ = t.buf.Write(p)
	return n, nil
}

// String 返回残留输出。
func (t *tailBuffer) String() string { return t.buf.String() }

// sha256Hex 是测试辅助：计算字节摘要（生产走 fileSHA256）。
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ---- 装配层转发：httpapi.SelfUpdater 的可选接口实现 ----
//
// 为什么是"给 daemon 补四个转发方法"而不是"让 serve_boot 直接把 *selfUpdater 注入 httpapi"：
//   - httpapi.Options.Backend 是**单一**接口值，同时承载插件管理（Plugins/Plugin/Enable/...）；
//     把它换成 *selfUpdater 会让所有插件端点失去后端；组合成 wrapper 又平白多一层包装，
//     且偏离本仓既有的"可选能力接口"模式（PluginUninstaller 同款，见 serve_plugin_uninstall.go）。
//   - 业务语义（校验/原子替换/.prev/回滚/finalize）仍只在 selfUpdater 一处收口，daemon 只做委托，
//     保持"实现与暴露分离"，也不涟漪任何测试替身（Backend 接口不扩方法）。
//
// 曾经的缺陷正是这层缺失：serve_runtime.go 只把实现写进 d.selfUpdate，字段没有读者，
// 于是 HTTP 层对 Backend 的类型断言失败 → 四个端点全部 501。

// 编译期断言：daemon 必须满足 httpapi.SelfUpdater，否则类型断言会在运行期静默失败成 501。
var _ httpapi.SelfUpdater = (*daemon)(nil)

// selfUpdateUnwired 是装配缺失时的显式错误（HTTP 501 + E_UNSUPPORTED，不假装成功）。
func selfUpdateUnwired() error {
	return &pluginapi.Error{
		Code: pluginapi.E_UNSUPPORTED, Message: "当前装配未启用内核自升级",
	}
}

// UpgradeStatus 实现 httpapi.SelfUpdater：转发到装配注入的实现。
func (d *daemon) UpgradeStatus(ctx context.Context) (httpapi.SelfUpdateStatus, error) {
	if d.selfUpdate == nil {
		return httpapi.SelfUpdateStatus{}, selfUpdateUnwired()
	}
	return d.selfUpdate.UpgradeStatus(ctx)
}

// StartUpgrade 实现 httpapi.SelfUpdater：转发到装配注入的实现。
func (d *daemon) StartUpgrade(ctx context.Context, actor string, req httpapi.SelfUpdateRequest) (httpapi.SelfUpdateJob, error) {
	if d.selfUpdate == nil {
		return httpapi.SelfUpdateJob{}, selfUpdateUnwired()
	}
	return d.selfUpdate.StartUpgrade(ctx, actor, req)
}

// StartRollback 实现 httpapi.SelfUpdater：转发到装配注入的实现。
func (d *daemon) StartRollback(ctx context.Context, actor string, req httpapi.SelfUpdateRollbackRequest) (httpapi.SelfUpdateJob, error) {
	if d.selfUpdate == nil {
		return httpapi.SelfUpdateJob{}, selfUpdateUnwired()
	}
	return d.selfUpdate.StartRollback(ctx, actor, req)
}

// UpgradeJob 实现 httpapi.SelfUpdater：转发到装配注入的实现。
//
// 该接口没有 error 返回值，未装配时按"未知任务"处理（HTTP 404）；装配缺失由另外三个
// 端点显式回 E_UNSUPPORTED，不会被这一条掩盖。
func (d *daemon) UpgradeJob(id string) (httpapi.SelfUpdateJob, bool) {
	if d.selfUpdate == nil {
		return httpapi.SelfUpdateJob{}, false
	}
	return d.selfUpdate.UpgradeJob(id)
}
