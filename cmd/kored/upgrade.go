package main

// kored upgrade：运行期零 sudo 的自升级 / 自回滚。
//
// 前提（ADR-0018 + 一次性安装边界）：安装阶段用一次 sudo 建立 systemd unit 与
// root 身份；此后内核自己就是 root，替换自己的二进制、重启自己的 unit、删除
// 自己的 unit 都不再需要用户提权。因此本命令**不弹口令、不调 sudo、不申请
// polkit**：不是 root 就明确失败，让用户回到"以系统服务运行"这一形态。
//
// 安全边界（为什么不是"下载即覆盖"）：
//  1. 来源必须是**本地文件**，任何 URL 一律拒绝（--bin 不做下载）；
//  2. 必须给 --sha256，先算再比，**校验先于替换**：不一致时目标文件一个字节都不动；
//  3. 替换是"同目录临时文件 + fsync + rename"，rename 是原子覆盖，不存在写一半的二进制；
//  4. 旧二进制保留为 <bin>.prev（硬链优先、拷贝兜底），--rollback 用它回滚。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/store"
)

const (
	// upgradePrevSuffix 是旧二进制的保留后缀：<bin>.prev（可回滚）。
	upgradePrevSuffix = ".prev"
	// upgradeResultName 是升级结果标记文件名，落在状态目录内（不污染系统路径）。
	upgradeResultName = "upgrade-result.json"
	// upgradeDefaultUnit 是系统服务形态的 unit 名（与 install/uninstall 默认一致）。
	upgradeDefaultUnit = "kore.service"
	// sha256HexLen 是十六进制 sha256 的字符数。
	sha256HexLen = 64
)

// 升级结果标记的状态值（显式字符串，不用枚举魔法值）。
const (
	upgradeStatePending     = "pending"
	upgradeStateSuccess     = "success"
	upgradeStateRollingBack = "rollback-pending"
)

// upgradeOptions 是 `kored upgrade` 的参数快照。
type upgradeOptions struct {
	// binPath 是新二进制（--bin，本地文件；拒绝 URL）。
	binPath string
	// sha256Hex 是新二进制的期望 sha256（--sha256，必填）。
	sha256Hex string
	// rollback 表示用 <bin>.prev 回滚（--rollback）。
	rollback bool
	// verify 只做复核：读标记 + 比对磁盘 sha，不替换、不重启（--verify）。
	verify bool
	// dryRun 只校验并打印计划，不替换、不重启（--dry-run）。
	dryRun bool
	// noRestart 只替换不提交重启（--no-restart；手动重启场景）。
	noRestart bool
	// target 是安装目标二进制路径（--target，默认当前可执行文件）。
	target string
	// stateDir 是状态目录（--state-dir，缺省按配置/安装根解析）。
	stateDir string
	// unitName 是 systemd unit 名（--unit-name，默认 kore.service）。
	unitName string
}

// upgradeResult 是落盘的升级标记（G-24：显式字段，不用 map/any）。
type upgradeResult struct {
	// State 是 pending / success / rollback-pending。
	State string `json:"state"`
	// Binary 是被替换的目标二进制绝对路径。
	Binary string `json:"binary"`
	// ExpectedSHA256 是本次校验通过的期望 sha256。
	ExpectedSHA256 string `json:"expected_sha256"`
	// PreviousSHA256 是替换前旧二进制的 sha256（回滚依据）。
	PreviousSHA256 string `json:"previous_sha256"`
	// Version 是写标记的进程自身版本（新进程 finalize 时填）。
	Version string `json:"version"`
	// UpdatedAt 是替换发生时间（RFC3339）。
	UpdatedAt string `json:"updated_at"`
	// VerifiedAt 是新进程确认生效的时间；pending 时为空。
	VerifiedAt string `json:"verified_at,omitempty"`
	// RunPID 是写标记的进程 pid。
	RunPID int `json:"run_pid,omitempty"`
}

// finalizeCleanup 是内核 finalize 成功后的旧版本清理入口（ADR-0059 §3.5 第 3 条）。
// stateDir 是本次 finalize 解析出的状态目录；返回 error 只作 WARN，绝不改升级结果。
// 生产实现见 finalizeCleanupInstalledPlugins；测试用替身验证调用契约，不执行真实 CLI。
type finalizeCleanup func(stateDir string) error

// upgradeDeps 是升级链的注入点（测试用假实现，绝不重启真实 unit）。
type upgradeDeps struct {
	euid       func() int
	executable func() (string, error)
	sha256File func(path string) (string, error)
	restart    func(unit string) error
	stateDir   func(flagStateDir string) (string, error)
	now        func() time.Time
	// finalizeClean 可选：nil 时 finalize 只闭环标记、不清理（绝不阻断启动）。
	finalizeClean finalizeCleanup
}

// defaultUpgradeDeps 返回生产实现。
func defaultUpgradeDeps() upgradeDeps {
	return upgradeDeps{
		euid:          os.Geteuid,
		executable:    os.Executable,
		sha256File:    fileSHA256,
		restart:       privilege.RestartUnitNoBlock,
		stateDir:      resolveUpgradeStateDir,
		now:           time.Now,
		finalizeClean: finalizeCleanupInstalledPlugins,
	}
}

// finalizeCleanupInstalledPlugins 是 finalize 成功后清理的生产实现。
//
// finalize 在 runServe 之前执行（main.go:74），此时尚无 service/state.db 装配，
// 所以这里走"只读配置 + 短开状态库"的窄路径：配置快照经 coreconfig.Load 取得
// （与 resolveUpgradeStateDir 同源，含 backup.*），状态库只在清理窗口内打开，
// 退出前 closeStore 释放 bbolt 独占锁，随后的 runServe 可正常再次 openStore。
// 清理由 M7 已交付的 cleanupAfterInstall 执行（backup 透传 / Confirmed=true /
// CleanupAuditor 落库 / 失败只 WARN 全复用），不新造第二套清理逻辑（G-01/G-02）。
func finalizeCleanupInstalledPlugins(stateDir string) error {
	snap, _, err := coreconfig.Load(coreconfig.Options{
		StateDir: stateDir,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		return fmt.Errorf("内核生效清理：加载 backup 配置失败: %w", err)
	}
	// market.New 不触碰文件系统（懒加载索引）；CleanupAfterInstall 只依赖 logger，
	// 无需验签索引或安装触发器，因此可在本路径安全构造，不必改动装配层文件。
	return finalizeCleanupWith(stateDir, snap, market.New(market.Options{Logger: slog.Default()}))
}

// finalizeCleanupWith 是可测试核心：显式注入配置快照与清理服务替身。
// 对每个已装插件各触发一次 M7 清理；失败由 cleanupAfterInstall 内部只 WARN，
// 本函数只把"配置/状态库不可得"这类前置错误上抛给 finalize 记为 WARN。
func finalizeCleanupWith(stateDir string, snap *coreconfig.Snapshot, marketSvc cleanupService) error {
	if snap == nil || marketSvc == nil {
		return errors.New("内核生效清理：配置快照与清理入口都必填")
	}
	db, err := store.Open(stateDir, slog.Default())
	if err != nil {
		return fmt.Errorf("内核生效清理：打开状态库失败: %w", err)
	}
	defer closeStore(db)

	refs, err := newStateRepo(db).installed()
	if err != nil {
		return fmt.Errorf("内核生效清理：枚举已装插件失败: %w", err)
	}
	root := snap.Paths.PluginDir
	if root == "" {
		root = filepath.Join(stateDir, "plugins")
	}
	cfg := config{StateDir: stateDir, snapshot: snap}
	svc := &service{db: db, pluginRootDir: root, marketSvc: marketSvc}
	for _, ref := range refs {
		// 每个插件独立清理：单个失败只 WARN（cleanupAfterInstall 内），不阻断其余插件。
		cleanupAfterInstall(cfg, svc, ref.ID)
	}
	return nil
}

// runUpgrade 执行 `kored upgrade`。
func runUpgrade(args []string, stdout, stderr io.Writer) int {
	return runUpgradeWith(args, stdout, stderr, defaultUpgradeDeps())
}

// runUpgradeWith 是可测试实现：校验 → 原子替换 → 落标记 → 最后一步提交重启。
func runUpgradeWith(args []string, stdout, stderr io.Writer, deps upgradeDeps) int {
	opts, err := parseUpgradeFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	target, err := resolveUpgradeTarget(deps, opts)
	if err != nil {
		fmt.Fprintf(stderr, "upgrade: %v\n", err)
		return exitConfig
	}
	if opts.verify {
		return runUpgradeVerify(target, opts, stdout, stderr, deps)
	}
	// 权限闸门放在所有写动作之前：不是 root 就明确失败，绝不静默、绝不弹口令。
	if deps.euid() != 0 && !opts.dryRun {
		fmt.Fprintf(stderr, "upgrade: 需以系统服务身份运行（root）才能自升级；一次性安装后不应再需要 sudo。\n"+
			"  当前 euid=%d，目标 %s 与 unit %s 都需要 root 才能替换/重启。\n"+
			"  怎么办：由系统服务内的内核执行（systemctl 管理的 kore.service 进程本身就是 root），\n"+
			"          或在服务端 POST 升级入口；不要用 sudo 手工 cp 覆盖二进制。\n",
			deps.euid(), target, opts.unitName)
		return exitEnv
	}
	if opts.rollback {
		return runUpgradeRollback(target, opts, stdout, stderr, deps)
	}
	return runUpgradeApply(target, opts, stdout, stderr, deps)
}

// runUpgradeApply 是正向升级：校验 sha256 → 原子替换（保留 .prev）→ 落标记 → 提交重启。
func runUpgradeApply(target string, opts upgradeOptions, stdout, stderr io.Writer, deps upgradeDeps) int {
	if err := validateUpgradeSource(opts.binPath); err != nil {
		fmt.Fprintf(stderr, "upgrade: %v\n", err)
		return exitConfig
	}
	want, err := normalizeSHA256(opts.sha256Hex)
	if err != nil {
		fmt.Fprintf(stderr, "upgrade: %v\n", err)
		return exitConfig
	}
	data, err := os.ReadFile(opts.binPath)
	if err != nil {
		fmt.Fprintf(stderr, "upgrade: 读取新二进制失败: %v\n", err)
		return exitConfig
	}
	got := sha256.Sum256(data)
	if hex.EncodeToString(got[:]) != want {
		// 校验先于替换：这里返回后目标文件未被触碰（有测试断言）。
		fmt.Fprintf(stderr, "upgrade: sha256 校验失败，拒绝替换（目标文件未改动）\n"+
			"  期望: %s\n  实际: %s\n  来源: %s\n", want, hex.EncodeToString(got[:]), opts.binPath)
		return exitConfig
	}
	prevSHA, err := deps.sha256File(target)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(stderr, "upgrade: 读取当前二进制 sha256 失败: %v\n", err)
		return exitStore
	}
	prevPath := target + upgradePrevSuffix
	fmt.Fprintf(stdout, "[INFO] 目标二进制：%s\n", target)
	fmt.Fprintf(stdout, "[INFO] 新二进制：%s（sha256 %s 校验通过）\n", opts.binPath, want)
	fmt.Fprintf(stdout, "[INFO] 旧二进制将保留为：%s\n", prevPath)
	if opts.dryRun {
		fmt.Fprintln(stdout, "[DRY-RUN] 只校验不替换：目标文件、.prev、unit 全部未改动")
		return exitOK
	}
	if _, err := replaceBinaryAtomically(target, data); err != nil {
		fmt.Fprintf(stderr, "upgrade: 原子替换失败: %v\n", err)
		return exitStore
	}
	fmt.Fprintf(stdout, "[OK] 已原子替换：%s（rename 覆盖，旧文件保留为 %s）\n", target, prevPath)

	stateDir, dirErr := deps.stateDir(opts.stateDir)
	marker := upgradeResult{
		State:          upgradeStatePending,
		Binary:         target,
		ExpectedSHA256: want,
		PreviousSHA256: prevSHA,
		Version:        version,
		UpdatedAt:      deps.now().Format(time.RFC3339),
		RunPID:         os.Getpid(),
	}
	if dirErr != nil {
		fmt.Fprintf(stderr, "[WARN] 无法解析状态目录（%v）：跳过 upgrade-result 标记；重启后请用 --verify 的人工复核路径\n", dirErr)
	} else if err := writeUpgradeResult(upgradeResultPath(stateDir), marker); err != nil {
		fmt.Fprintf(stderr, "[WARN] 写 upgrade-result 失败（%v）：不影响已完成的替换\n", err)
	} else {
		fmt.Fprintf(stdout, "[INFO] 已落 pending 标记：%s（重启后由新进程改写成 success）\n", upgradeResultPath(stateDir))
	}
	return submitUpgradeRestart(target, opts, stdout, stderr, deps)
}

// runUpgradeRollback 用 <bin>.prev 回滚，并把替换前的当前二进制存回 .prev（可再次切回）。
func runUpgradeRollback(target string, opts upgradeOptions, stdout, stderr io.Writer, deps upgradeDeps) int {
	prevPath := target + upgradePrevSuffix
	prevData, err := os.ReadFile(prevPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(stderr, "upgrade: 回滚失败：%s 不存在（该二进制从未用 kored upgrade 升级过？）\n", prevPath)
		} else {
			fmt.Fprintf(stderr, "upgrade: 读取 %s 失败: %v\n", prevPath, err)
		}
		return exitConfig
	}
	sum := sha256.Sum256(prevData)
	prevSHA := hex.EncodeToString(sum[:])
	if strings.TrimSpace(opts.sha256Hex) != "" {
		want, err := normalizeSHA256(opts.sha256Hex)
		if err != nil {
			fmt.Fprintf(stderr, "upgrade: %v\n", err)
			return exitConfig
		}
		if want != prevSHA {
			fmt.Fprintf(stderr, "upgrade: .prev 的 sha256 与 --sha256 不符，拒绝回滚（目标未改动）\n  期望: %s\n  实际: %s\n", want, prevSHA)
			return exitConfig
		}
	}
	fmt.Fprintf(stdout, "[INFO] 回滚来源：%s（sha256 %s）\n", prevPath, prevSHA)
	fmt.Fprintf(stdout, "[INFO] 目标二进制：%s\n", target)
	if opts.dryRun {
		fmt.Fprintln(stdout, "[DRY-RUN] 只校验不替换：目标文件与 .prev 均未改动")
		return exitOK
	}
	if _, err := replaceBinaryAtomically(target, prevData); err != nil {
		fmt.Fprintf(stderr, "upgrade: 回滚替换失败: %v\n", err)
		return exitStore
	}
	fmt.Fprintf(stdout, "[OK] 已回滚：%s ← %s（替换前的二进制已存回 .prev，可再次 --rollback 切回）\n", target, prevPath)

	if stateDir, dirErr := deps.stateDir(opts.stateDir); dirErr == nil {
		marker := upgradeResult{
			State:          upgradeStateRollingBack,
			Binary:         target,
			ExpectedSHA256: prevSHA,
			Version:        version,
			UpdatedAt:      deps.now().Format(time.RFC3339),
			RunPID:         os.Getpid(),
		}
		if err := writeUpgradeResult(upgradeResultPath(stateDir), marker); err != nil {
			fmt.Fprintf(stderr, "[WARN] 写 upgrade-result 失败（%v）\n", err)
		}
	}
	return submitUpgradeRestart(target, opts, stdout, stderr, deps)
}

// submitUpgradeRestart 是升级链的**最后一步**：落盘全部完成后才提交重启。
//
// 为什么用 `systemctl --no-block`（而不是同步 restart）：
//   - 同步 restart 会等 job 完成，而 job 的第一步就是 SIGTERM 本进程 →
//     本进程再也没机会打印结果，退出码取决于被杀的时序，表现为"升级报错但实际成功"的假失败；
//   - --no-block 把 job 交给 systemd 后立即返回，本进程能先把结论写完再被替换；
//   - 因此 exit 0 的语义是「二进制已替换 + 重启已提交」，**不是**「新版本已生效」；
//     生效证据由新进程写 success 标记 / `kored upgrade --verify` 给出。
func submitUpgradeRestart(target string, opts upgradeOptions, stdout, stderr io.Writer, deps upgradeDeps) int {
	if opts.noRestart {
		fmt.Fprintln(stdout, "[INFO] --no-restart：未提交重启。新二进制不会生效，请自行重启：")
		fmt.Fprintf(stdout, "  systemctl restart %s\n", opts.unitName)
		fmt.Fprintf(stdout, "  或手动拉起：%s serve\n", target)
		return exitOK
	}
	if err := deps.restart(opts.unitName); err != nil {
		fmt.Fprintf(stderr, "upgrade: 二进制已替换（sha256 已校验），但重启未提交: %v\n"+
			"  已完成的：%s 已就位（旧版保留为 %s）\n"+
			"  待完成：重启 %s 让新版本生效，然后运行 `kored upgrade --verify` 复核\n"+
			"  退出码 6 = 环境不满足（无法提交重启），不是「替换失败」\n",
			err, target, target+upgradePrevSuffix, opts.unitName)
		return exitEnv
	}
	fmt.Fprintf(stdout, "[OK] 已提交重启：systemctl --no-block restart %s\n", opts.unitName)
	fmt.Fprintln(stdout, "[INFO] 本进程随重启退出属正常；新版本生效的判据是：")
	fmt.Fprintf(stdout, "  1) 新进程启动时把 %s 从 pending 改成 success（自动）\n", upgradeResultName)
	fmt.Fprintln(stdout, "  2) 或人工复核：kored upgrade --verify")
	fmt.Fprintln(stdout, "退出码 0 = 已替换且已提交重启（不等于新版本已加载，见上两条判据）")
	return exitOK
}

// runUpgradeVerify 只读复核：把 pending 标记与磁盘上的 sha256 对齐成 success。
func runUpgradeVerify(target string, opts upgradeOptions, stdout, stderr io.Writer, deps upgradeDeps) int {
	stateDir, err := deps.stateDir(opts.stateDir)
	if err != nil {
		fmt.Fprintf(stderr, "upgrade: 解析状态目录失败: %v\n", err)
		return exitConfig
	}
	markerPath := upgradeResultPath(stateDir)
	marker, err := readUpgradeResult(markerPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(stdout, "[INFO] 无升级标记（%s）：本实例没执行过 kored upgrade，视为无需复核\n", markerPath)
			return exitOK
		}
		fmt.Fprintf(stderr, "upgrade: 读取 %s 失败: %v\n", markerPath, err)
		return exitStore
	}
	actual, err := deps.sha256File(target)
	if err != nil {
		fmt.Fprintf(stderr, "upgrade: 读取 %s 的 sha256 失败: %v\n", target, err)
		return exitStore
	}
	fmt.Fprintf(stdout, "[INFO] 标记：state=%s expected=%s\n", marker.State, marker.ExpectedSHA256)
	fmt.Fprintf(stdout, "[INFO] 磁盘：%s sha256=%s\n", target, actual)
	if actual != marker.ExpectedSHA256 {
		fmt.Fprintf(stderr, "upgrade: 期望版本尚未生效（磁盘 sha256 与标记不符）；若刚重启，请等新进程起来后再复核\n")
		return exitEnv
	}
	if marker.State == upgradeStateSuccess {
		fmt.Fprintf(stdout, "[OK] 已是 success（verified_at=%s，pid=%d）\n", marker.VerifiedAt, marker.RunPID)
		return exitOK
	}
	marker.State = upgradeStateSuccess
	marker.VerifiedAt = deps.now().Format(time.RFC3339)
	marker.RunPID = os.Getpid()
	marker.Version = version
	if err := writeUpgradeResult(markerPath, marker); err != nil {
		fmt.Fprintf(stderr, "upgrade: 写标记失败: %v\n", err)
		return exitStore
	}
	fmt.Fprintf(stdout, "[OK] 新版本已生效：%s（标记改为 success）\n", target)
	return exitOK
}

// finalizePendingUpgrade 由**新进程**在 serve 启动时调用：把 pending / rollback-pending
// 标记改写成 success（旧进程无法完成这一步，这是设计上的"重启后才闭环"）。
//
// 非阻塞、绝不阻断启动：标记不存在、读不了、写不了都只是安静返回（最多一行 WARN）。
func finalizePendingUpgrade(w io.Writer, deps upgradeDeps) {
	stateDir, err := deps.stateDir("")
	if err != nil {
		return
	}
	markerPath := upgradeResultPath(stateDir)
	marker, err := readUpgradeResult(markerPath)
	if err != nil {
		return
	}
	if marker.State == upgradeStateSuccess {
		return
	}
	target, err := deps.executable()
	if err != nil {
		return
	}
	if resolved, evalErr := filepath.EvalSymlinks(target); evalErr == nil {
		target = resolved
	}
	actual, err := deps.sha256File(target)
	if err != nil || actual != marker.ExpectedSHA256 {
		// 新进程不是期望的二进制：不谎报成功，保留 pending 供 --verify 判断。
		fmt.Fprintf(w, "[WARN] upgrade-result 仍是 %s：运行中的二进制 sha256 与期望不符（%s）\n", marker.State, markerPath)
		return
	}
	marker.State = upgradeStateSuccess
	marker.VerifiedAt = deps.now().Format(time.RFC3339)
	marker.RunPID = os.Getpid()
	marker.Version = version
	if err := writeUpgradeResult(markerPath, marker); err != nil {
		fmt.Fprintf(w, "[WARN] 写 upgrade-result 失败: %v\n", err)
		return
	}
	fmt.Fprintf(w, "[INFO] 升级已生效：%s → sha256 %s（upgrade-result=success）\n", target, actual)

	// 生效确认完成后触发一次旧版本清理（ADR-0059 §3.5 第 3 条：插件 reload 成功 /
	// 内核 finalize 成功）。与插件 reload 路径一致：清理失败只 WARN，绝不把已经
	// 生效的升级改判为失败，也不阻断 serve 启动。标记未写成功或 sha 不符时上面
	// 已 return，零清理（未确认短路）。
	if deps.finalizeClean != nil {
		if err := deps.finalizeClean(stateDir); err != nil {
			fmt.Fprintf(w, "[WARN] 内核生效后旧版本清理不可用: %v\n", err)
		}
	}
}

// parseUpgradeFlags 解析 upgrade 参数。
func parseUpgradeFlags(args []string, stderr io.Writer) (upgradeOptions, error) {
	fs := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var opts upgradeOptions
	fs.StringVar(&opts.binPath, "bin", "", "新二进制本地路径（必填；不接受 URL）")
	fs.StringVar(&opts.sha256Hex, "sha256", "", "新二进制的期望 sha256（必填，64 位十六进制）")
	fs.BoolVar(&opts.rollback, "rollback", false, "用 <bin>.prev 回滚")
	fs.BoolVar(&opts.verify, "verify", false, "只复核：比对标记与磁盘 sha256")
	fs.BoolVar(&opts.dryRun, "dry-run", false, "只校验并打印计划，不替换不重启")
	fs.BoolVar(&opts.noRestart, "no-restart", false, "只替换、不提交重启")
	fs.StringVar(&opts.target, "target", "", "目标二进制（默认当前可执行文件）")
	fs.StringVar(&opts.stateDir, "state-dir", "", "状态目录（缺省按配置解析）")
	fs.StringVar(&opts.unitName, "unit-name", upgradeDefaultUnit, "systemd unit 名")
	fs.Usage = func() { printUpgradeUsage(stderr) }
	if err := fs.Parse(args); err != nil {
		return upgradeOptions{}, err
	}
	if !opts.rollback && !opts.verify && strings.TrimSpace(opts.binPath) == "" {
		fmt.Fprintln(stderr, "upgrade: 必须指定 --bin <新二进制> 或 --rollback / --verify")
		printUpgradeUsage(stderr)
		return upgradeOptions{}, errors.New("missing --bin")
	}
	if opts.rollback && opts.verify {
		fmt.Fprintln(stderr, "upgrade: --rollback 与 --verify 不能同时使用")
		return upgradeOptions{}, errors.New("conflicting flags")
	}
	return opts, nil
}

// resolveUpgradeTarget 解析被替换的目标二进制（--target，缺省当前可执行文件）。
func resolveUpgradeTarget(deps upgradeDeps, opts upgradeOptions) (string, error) {
	target := strings.TrimSpace(opts.target)
	if target == "" {
		exe, err := deps.executable()
		if err != nil {
			return "", fmt.Errorf("解析当前可执行文件失败: %w", err)
		}
		target = exe
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return "", fmt.Errorf("解析目标路径失败: %w", err)
	}
	if resolved, evalErr := filepath.EvalSymlinks(abs); evalErr == nil {
		abs = resolved
	}
	return abs, nil
}

// validateUpgradeSource 拒绝 URL：升级来源只能是本机文件（"不接受任意 URL 直接覆盖"）。
func validateUpgradeSource(path string) error {
	lower := strings.ToLower(strings.TrimSpace(path))
	for _, scheme := range []string{"http://", "https://", "ftp://", "ftps://", "sftp://", "file://", "ssh://"} {
		if strings.HasPrefix(lower, scheme) {
			return fmt.Errorf("拒绝 URL 来源 %q：升级只接受本地文件路径 + --sha256（先校验再替换，不做下载）", path)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("新二进制不可读: %w", err)
	}
	if info.IsDir() {
		return fmt.Errorf("新二进制 %q 是目录，不是文件", path)
	}
	return nil
}

// normalizeSHA256 校验并归一化 --sha256（接受 sha256: 前缀与大小写）。
func normalizeSHA256(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(strings.TrimPrefix(value, "sha256:"), "SHA256:")
	value = strings.ToLower(value)
	if len(value) != sha256HexLen {
		return "", fmt.Errorf("--sha256 必须是 %d 位十六进制（实际 %d 位）：先校验再替换，不接受「跳过校验」", sha256HexLen, len(value))
	}
	if _, err := hex.DecodeString(value); err != nil {
		return "", fmt.Errorf("--sha256 不是合法十六进制: %w", err)
	}
	return value, nil
}

// fileSHA256 计算文件 sha256（返回小写十六进制）。
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// replaceBinaryAtomically 原子替换目标二进制，并把旧文件保留为 <bin>.prev。
//
// 顺序（同目录 → 不跨文件系统 → rename 原子）：
//  1. 写临时文件 <dir>/.kored-upgrade-*，chmod 0755，fsync 落盘；
//  2. 旧文件备份：优先 os.Link（同一 inode → 不产生"目标消失"的窗口），失败退回拷贝；
//  3. os.Rename(tmp, target) 原子覆盖；
//  4. fsync 目录，保证 rename 本身持久化。
func replaceBinaryAtomically(target string, data []byte) (string, error) {
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".kored-upgrade-*")
	if err != nil {
		return "", fmt.Errorf("在 %s 建临时文件失败: %w", dir, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", fmt.Errorf("设置临时文件权限失败: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", fmt.Errorf("写临时文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", fmt.Errorf("fsync 临时文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", fmt.Errorf("关闭临时文件失败: %w", err)
	}
	prevPath := target + upgradePrevSuffix
	if _, err := os.Stat(target); err == nil {
		if err := preservePreviousBinary(target, prevPath); err != nil {
			cleanup()
			return "", err
		}
	}
	if err := os.Rename(tmpName, target); err != nil {
		cleanup()
		return "", fmt.Errorf("rename 覆盖 %s 失败: %w", target, err)
	}
	if dirHandle, err := os.Open(dir); err == nil {
		_ = dirHandle.Sync()
		_ = dirHandle.Close()
	}
	return prevPath, nil
}

// preservePreviousBinary 把旧二进制保留为 prev：硬链优先（同一 inode、零拷贝、无中间窗口），
// 硬链不可用时退回"拷贝到临时文件 + fsync + rename"。
func preservePreviousBinary(target, prevPath string) error {
	if err := os.Remove(prevPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("清理旧备份 %s 失败: %w", prevPath, err)
	}
	if err := os.Link(target, prevPath); err == nil {
		return nil
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return fmt.Errorf("读取旧二进制 %s 失败: %w", target, err)
	}
	info, err := os.Stat(target)
	if err != nil {
		return fmt.Errorf("探测旧二进制 %s 失败: %w", target, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(prevPath), ".kored-prev-*")
	if err != nil {
		return fmt.Errorf("建备份临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("写备份失败: %w", err)
	}
	if err := tmp.Chmod(info.Mode().Perm()); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("设置备份权限失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("fsync 备份失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("关闭备份失败: %w", err)
	}
	if err := os.Rename(tmpName, prevPath); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("落备份 %s 失败: %w", prevPath, err)
	}
	return nil
}

// upgradeResultPath 返回状态目录内的标记文件路径。
func upgradeResultPath(stateDir string) string { return filepath.Join(stateDir, upgradeResultName) }

// readUpgradeResult 读取标记（坏 JSON 直接报错，不猜）。
func readUpgradeResult(path string) (upgradeResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return upgradeResult{}, err
	}
	var out upgradeResult
	if err := json.Unmarshal(data, &out); err != nil {
		return upgradeResult{}, fmt.Errorf("解析 %s 失败: %w", path, err)
	}
	return out, nil
}

// writeUpgradeResult 原子写标记：临时文件 + fsync + rename（半写标记比没有标记更危险）。
func writeUpgradeResult(path string, result upgradeResult) error {
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".upgrade-result-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

// resolveUpgradeStateDir 解析状态目录（只用配置解析，不做任何写操作）。
func resolveUpgradeStateDir(flagStateDir string) (string, error) {
	snap, _, err := coreconfig.Load(coreconfig.Options{
		StateDir: flagStateDir,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		return "", err
	}
	stateDir := snap.Paths.StateDir
	if abs, absErr := filepath.Abs(stateDir); absErr == nil {
		stateDir = abs
	}
	return stateDir, nil
}

// printUpgradeUsage 打印 upgrade 参数说明。
func printUpgradeUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored upgrade --bin <新二进制> --sha256 <hex> [--dry-run] [--no-restart]")
	fmt.Fprintln(w, "      kored upgrade --rollback [--sha256 <hex>]")
	fmt.Fprintln(w, "      kored upgrade --verify")
	fmt.Fprintln(w, "  --bin        新二进制本地路径（必填；拒绝 URL：升级绝不下载）")
	fmt.Fprintln(w, "  --sha256     期望 sha256（必填；先校验再替换，不符则目标文件零改动）")
	fmt.Fprintln(w, "  --rollback   用 <bin>.prev 回滚，并把替换前二进制存回 .prev")
	fmt.Fprintln(w, "  --verify     只读复核：标记 + 磁盘 sha256 → success")
	fmt.Fprintln(w, "  --dry-run    只校验并打印计划，不替换不重启")
	fmt.Fprintln(w, "  --no-restart 只替换，重启由你手动执行")
	fmt.Fprintln(w, "  --target     目标二进制（默认当前可执行文件）")
	fmt.Fprintln(w, "  --state-dir  状态目录（upgrade-result.json 落在这里，不污染系统路径）")
	fmt.Fprintln(w, "  --unit-name  systemd unit 名（默认 kore.service）")
	fmt.Fprintln(w, "前置: 必须以系统服务身份（root）运行；一次性安装后不应再需要 sudo")
	fmt.Fprintln(w, "退出码: 0 已替换且重启已提交 / 2 校验失败 / 6 非 root 或无法提交重启")
}
