package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// upgradeFixture 是一套"假安装根"：目标二进制 + 状态目录 + 注入的假 root/假重启。
type upgradeFixture struct {
	dir       string
	target    string
	stateDir  string
	restarts  []string
	restartOK bool
	now       time.Time
}

// newUpgradeFixture 造隔离环境（t.TempDir），绝不指向真实的 /usr/local/bin/kored。
func newUpgradeFixture(t *testing.T) *upgradeFixture {
	t.Helper()
	dir := t.TempDir()
	f := &upgradeFixture{
		dir:       dir,
		target:    filepath.Join(dir, "kored"),
		stateDir:  filepath.Join(dir, "data"),
		restartOK: true,
		now:       time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC),
	}
	if err := os.WriteFile(f.target, []byte("old-binary"), 0o755); err != nil {
		t.Fatalf("准备目标二进制: %v", err)
	}
	if err := os.MkdirAll(f.stateDir, 0o700); err != nil {
		t.Fatalf("准备状态目录: %v", err)
	}
	return f
}

// deps 返回 fake root 的依赖集合。
func (f *upgradeFixture) deps(euid int) upgradeDeps {
	return upgradeDeps{
		euid:       func() int { return euid },
		executable: func() (string, error) { return f.target, nil },
		sha256File: fileSHA256,
		restart: func(unit string) error {
			f.restarts = append(f.restarts, unit)
			if !f.restartOK {
				return os.ErrPermission
			}
			return nil
		},
		stateDir: func(string) (string, error) { return f.stateDir, nil },
		now:      func() time.Time { return f.now },
	}
}

// newBinary 造一个"新二进制"文件并返回路径与 sha256。
func (f *upgradeFixture) newBinary(t *testing.T, name, content string) (string, string) {
	t.Helper()
	path := filepath.Join(f.dir, name)
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("准备新二进制: %v", err)
	}
	sum := sha256.Sum256([]byte(content))
	return path, hex.EncodeToString(sum[:])
}

// readFile 读文件内容（失败即测试失败）。
func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s: %v", path, err)
	}
	return string(data)
}

// TestUpgradeRejectsSHA256Mismatch 校验失败必须拒绝替换：目标文件零改动、不产生 .prev、不重启。
func TestUpgradeRejectsSHA256Mismatch(t *testing.T) {
	f := newUpgradeFixture(t)
	binPath, _ := f.newBinary(t, "kored-new", "new-binary")
	wrong := strings.Repeat("0", 64)
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--bin", binPath, "--sha256", wrong, "--target", f.target, "--state-dir", f.stateDir,
	}, &out, &errOut, f.deps(0))
	if code != exitConfig {
		t.Fatalf("退出码 = %d，期望 %d；stderr=%s", code, exitConfig, errOut.String())
	}
	if got := readFile(t, f.target); got != "old-binary" {
		t.Fatalf("校验失败却改动了目标文件: %q", got)
	}
	if _, err := os.Stat(f.target + upgradePrevSuffix); !os.IsNotExist(err) {
		t.Fatalf("校验失败却产生了 .prev")
	}
	if len(f.restarts) != 0 {
		t.Fatalf("校验失败却提交了重启: %v", f.restarts)
	}
	if !strings.Contains(errOut.String(), "sha256 校验失败") {
		t.Fatalf("缺少明确拒绝文案: %s", errOut.String())
	}
}

// TestUpgradeAtomicReplaceKeepsPrev 正确 sha256 时：新文件就位、.prev 保留旧内容、权限 0755、提交重启、落 pending 标记。
func TestUpgradeAtomicReplaceKeepsPrev(t *testing.T) {
	f := newUpgradeFixture(t)
	binPath, sum := f.newBinary(t, "kored-new", "new-binary-v2")
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--bin", binPath, "--sha256", sum, "--target", f.target, "--state-dir", f.stateDir,
	}, &out, &errOut, f.deps(0))
	if code != exitOK {
		t.Fatalf("退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	if got := readFile(t, f.target); got != "new-binary-v2" {
		t.Fatalf("目标未替换为新二进制: %q", got)
	}
	prevPath := f.target + upgradePrevSuffix
	if got := readFile(t, prevPath); got != "old-binary" {
		t.Fatalf(".prev 未保留旧二进制: %q", got)
	}
	info, err := os.Stat(f.target)
	if err != nil {
		t.Fatalf("stat 目标: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o755 {
		t.Fatalf("目标权限 = %o，期望 755", perm)
	}
	if len(f.restarts) != 1 || f.restarts[0] != upgradeDefaultUnit {
		t.Fatalf("重启调用 = %v，期望 [%s]", f.restarts, upgradeDefaultUnit)
	}
	marker, err := readUpgradeResult(upgradeResultPath(f.stateDir))
	if err != nil {
		t.Fatalf("读标记: %v", err)
	}
	if marker.State != upgradeStatePending || marker.ExpectedSHA256 != sum {
		t.Fatalf("标记 = %+v，期望 pending + 期望 sha", marker)
	}
}

// TestUpgradeNonRootRefuses 非 root 必须明确拒绝（不静默、不弹口令），且目标零改动。
func TestUpgradeNonRootRefuses(t *testing.T) {
	f := newUpgradeFixture(t)
	binPath, sum := f.newBinary(t, "kored-new", "new-binary")
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--bin", binPath, "--sha256", sum, "--target", f.target, "--state-dir", f.stateDir,
	}, &out, &errOut, f.deps(1000))
	if code != exitEnv {
		t.Fatalf("退出码 = %d，期望 %d（环境不满足）", code, exitEnv)
	}
	if !strings.Contains(errOut.String(), "需以系统服务身份运行（root）才能自升级；一次性安装后不应再需要 sudo") {
		t.Fatalf("缺少明确拒绝文案: %s", errOut.String())
	}
	if !strings.Contains(errOut.String(), "euid=1000") {
		t.Fatalf("未说明当前 euid: %s", errOut.String())
	}
	if got := readFile(t, f.target); got != "old-binary" {
		t.Fatalf("非 root 却改动了目标文件: %q", got)
	}
	if len(f.restarts) != 0 {
		t.Fatalf("非 root 却提交了重启: %v", f.restarts)
	}
}

// TestUpgradeRejectsURLSource 拒绝 URL 来源（升级绝不下载）。
func TestUpgradeRejectsURLSource(t *testing.T) {
	f := newUpgradeFixture(t)
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--bin", "https://example.com/kored", "--sha256", strings.Repeat("a", 64),
		"--target", f.target, "--state-dir", f.stateDir,
	}, &out, &errOut, f.deps(0))
	if code != exitConfig {
		t.Fatalf("退出码 = %d，期望 %d", code, exitConfig)
	}
	if !strings.Contains(errOut.String(), "拒绝 URL 来源") {
		t.Fatalf("缺少拒绝 URL 文案: %s", errOut.String())
	}
}

// TestUpgradeDryRunNoMutation dry-run：只校验，不替换、不重启、不落标记。
func TestUpgradeDryRunNoMutation(t *testing.T) {
	f := newUpgradeFixture(t)
	binPath, sum := f.newBinary(t, "kored-new", "new-binary")
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--bin", binPath, "--sha256", sum, "--target", f.target, "--state-dir", f.stateDir, "--dry-run",
	}, &out, &errOut, f.deps(0))
	if code != exitOK {
		t.Fatalf("退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	if got := readFile(t, f.target); got != "old-binary" {
		t.Fatalf("dry-run 改动了目标: %q", got)
	}
	if len(f.restarts) != 0 {
		t.Fatalf("dry-run 提交了重启: %v", f.restarts)
	}
	if _, err := os.Stat(upgradeResultPath(f.stateDir)); !os.IsNotExist(err) {
		t.Fatalf("dry-run 落了标记")
	}
}

// TestUpgradeRollbackUsesPrev --rollback 用 .prev 覆盖目标，并把替换前二进制存回 .prev。
func TestUpgradeRollbackUsesPrev(t *testing.T) {
	f := newUpgradeFixture(t)
	if err := os.WriteFile(f.target, []byte("broken-v2"), 0o755); err != nil {
		t.Fatalf("准备 v2: %v", err)
	}
	if err := os.WriteFile(f.target+upgradePrevSuffix, []byte("good-v1"), 0o755); err != nil {
		t.Fatalf("准备 .prev: %v", err)
	}
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--rollback", "--target", f.target, "--state-dir", f.stateDir,
	}, &out, &errOut, f.deps(0))
	if code != exitOK {
		t.Fatalf("退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	if got := readFile(t, f.target); got != "good-v1" {
		t.Fatalf("回滚后目标 = %q，期望 good-v1", got)
	}
	if got := readFile(t, f.target+upgradePrevSuffix); got != "broken-v2" {
		t.Fatalf("回滚后 .prev = %q，期望 broken-v2（可再次切回）", got)
	}
	if len(f.restarts) != 1 {
		t.Fatalf("回滚应提交一次重启，实际 %v", f.restarts)
	}
	marker, err := readUpgradeResult(upgradeResultPath(f.stateDir))
	if err != nil {
		t.Fatalf("读标记: %v", err)
	}
	if marker.State != upgradeStateRollingBack {
		t.Fatalf("标记 state = %q，期望 %q", marker.State, upgradeStateRollingBack)
	}
}

// TestUpgradeRollbackMissingPrev 没有 .prev 时明确失败且不改目标。
func TestUpgradeRollbackMissingPrev(t *testing.T) {
	f := newUpgradeFixture(t)
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--rollback", "--target", f.target, "--state-dir", f.stateDir,
	}, &out, &errOut, f.deps(0))
	if code != exitConfig {
		t.Fatalf("退出码 = %d，期望 %d", code, exitConfig)
	}
	if !strings.Contains(errOut.String(), "不存在") {
		t.Fatalf("缺少 .prev 缺失文案: %s", errOut.String())
	}
	if got := readFile(t, f.target); got != "old-binary" {
		t.Fatalf("缺少 .prev 却改动了目标: %q", got)
	}
}

// TestUpgradeVerifyFinalizesMarker --verify 把 pending 对齐成 success（旧进程无法验证是正常的）。
func TestUpgradeVerifyFinalizesMarker(t *testing.T) {
	f := newUpgradeFixture(t)
	if err := os.WriteFile(f.target, []byte("new-binary-v2"), 0o755); err != nil {
		t.Fatalf("准备目标: %v", err)
	}
	sum := sha256.Sum256([]byte("new-binary-v2"))
	expected := hex.EncodeToString(sum[:])
	marker := upgradeResult{
		State:          upgradeStatePending,
		Binary:         f.target,
		ExpectedSHA256: expected,
		UpdatedAt:      f.now.Format(time.RFC3339),
	}
	if err := writeUpgradeResult(upgradeResultPath(f.stateDir), marker); err != nil {
		t.Fatalf("写 pending 标记: %v", err)
	}
	var out, errOut bytes.Buffer
	code := runUpgradeWith([]string{
		"--verify", "--target", f.target, "--state-dir", f.stateDir,
	}, &out, &errOut, f.deps(1000))
	if code != exitOK {
		t.Fatalf("退出码 = %d，期望 0（verify 只读不需要 root）；stderr=%s", code, errOut.String())
	}
	got, err := readUpgradeResult(upgradeResultPath(f.stateDir))
	if err != nil {
		t.Fatalf("读标记: %v", err)
	}
	if got.State != upgradeStateSuccess || got.VerifiedAt == "" {
		t.Fatalf("标记未闭环: %+v", got)
	}
}

// TestFinalizePendingUpgradeByNewProcess 新进程启动时把 pending 改写成 success（重启后闭环）。
func TestFinalizePendingUpgradeByNewProcess(t *testing.T) {
	f := newUpgradeFixture(t)
	sum := sha256.Sum256([]byte("old-binary")) // f.target 的内容
	marker := upgradeResult{
		State:          upgradeStatePending,
		Binary:         f.target,
		ExpectedSHA256: hex.EncodeToString(sum[:]),
		UpdatedAt:      f.now.Format(time.RFC3339),
	}
	if err := writeUpgradeResult(upgradeResultPath(f.stateDir), marker); err != nil {
		t.Fatalf("写 pending 标记: %v", err)
	}
	var w bytes.Buffer
	finalizePendingUpgrade(&w, f.deps(0))
	got, err := readUpgradeResult(upgradeResultPath(f.stateDir))
	if err != nil {
		t.Fatalf("读标记: %v", err)
	}
	if got.State != upgradeStateSuccess {
		t.Fatalf("新进程未闭环标记: %+v（输出 %s）", got, w.String())
	}
	if got.RunPID != os.Getpid() {
		t.Fatalf("RunPID = %d，期望 %d", got.RunPID, os.Getpid())
	}
	// 已 success 时必须幂等（不重复改写）。
	before := got.VerifiedAt
	finalizePendingUpgrade(&w, f.deps(0))
	again, err := readUpgradeResult(upgradeResultPath(f.stateDir))
	if err != nil {
		t.Fatalf("二次读标记: %v", err)
	}
	if again.VerifiedAt != before {
		t.Fatalf("success 后不应再次改写: %q → %q", before, again.VerifiedAt)
	}
}

// TestUpgradeResultIsExplicitJSON 标记必须是显式字段（G-24：不得 map/any 逃逸）。
func TestUpgradeResultIsExplicitJSON(t *testing.T) {
	f := newUpgradeFixture(t)
	data := upgradeResult{State: upgradeStatePending, Binary: f.target}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, field := range []string{"state", "binary", "expected_sha256", "previous_sha256", "version", "updated_at"} {
		if !strings.Contains(string(encoded), `"`+field+`"`) {
			t.Fatalf("标记缺字段 %q：%s", field, encoded)
		}
	}
}
