package filewrite

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// validVHost 是一份通过 nginx.vhost.v1 的最小片段（listen + server_name + root）。
const validVHost = "server {\n    listen 80;\n    server_name example.com;\n    root /var/www/example;\n}\n"

// sslVHost 是含证书指令的片段，用于证书白名单注入/缺省拒绝用例。
const sslVHost = "server {\n    listen 443 ssl;\n    server_name example.com;\n" +
	"    ssl_certificate /opt/kore/data/ssl/example/fullchain.pem;\n" +
	"    ssl_certificate_key /opt/kore/data/ssl/example/key.pem;\n" +
	"    root /var/www/example;\n}\n"

// declaredEnv 造一个临时类别目录并返回声明、目录、审计收集器。
func declaredEnv(t *testing.T) (pluginapi.RootAction, string, *[]AuditEvent) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时类别目录失败：%v", err)
	}
	decl := pluginapi.RootAction{
		ID: "site.write-vhost", WritesHost: true,
		Target:      pluginapi.FileWritePrefixClasses["nginx.conf.d"].Dir,
		Description: "写站点 nginx 片段",
		FileWrite: &pluginapi.FileWrite{
			PrefixClass:   "nginx.conf.d",
			Mode:          pluginapi.FileWriteModeRoot0644,
			ContentPolicy: pluginapi.ContentPolicyNginxVHost,
		},
	}
	events := &[]AuditEvent{}
	return decl, dir, events
}

// okOwnerCheck 是属主复核的测试替身（生产注入 internal/platform.VerifyOwner）。
func okOwnerCheck(seen *[]string) func(path string, mode os.FileMode) error {
	return func(path string, mode os.FileMode) error {
		if seen != nil {
			*seen = append(*seen, path)
		}
		return nil
	}
}

// TestAllowedPrefixesContainsDeclaredClass 断言默认白名单从协议类别派生（K3 硬约束 #2）。
func TestAllowedPrefixesContainsDeclaredClass(t *testing.T) {
	class := pluginapi.FileWritePrefixClasses["nginx.conf.d"]
	found := false
	for _, prefix := range AllowedPrefixes {
		if prefix == class.Dir {
			found = true
		}
	}
	if !found {
		t.Fatalf("AllowedPrefixes 缺少协议类别目录 %q：%v", class.Dir, AllowedPrefixes)
	}
}

// TestWriteDeclaredLegal 覆盖「声明 → 落到类别目录 → 属主复核 → 审计」正例。
func TestWriteDeclaredLegal(t *testing.T) {
	decl, dir, events := declaredEnv(t)
	var checked []string
	result, perr := WriteDeclared(DeclaredOptions{
		PluginID: "site", Actor: "admin", Action: decl,
		Name: "kore-site-x.conf", Content: []byte(validVHost),
		CopyRoot: filepath.Join(t.TempDir(), "backups"),
		Auditor:  okAuditor(events), Policy: pluginapi.DefaultFileWriteOptions(),
		DirOverride: dir, OwnerCheck: okOwnerCheck(&checked),
	})
	if perr != nil {
		t.Fatalf("合法声明写失败：%v", perr)
	}
	want := dir + "kore-site-x.conf"
	if result.Path != want {
		t.Fatalf("落盘路径 = %q，期望 %q", result.Path, want)
	}
	if result.Mode != 0o644 {
		t.Fatalf("权限 = %#o，期望 0644", result.Mode)
	}
	got, err := os.ReadFile(want)
	if err != nil || string(got) != validVHost {
		t.Fatalf("落盘内容不符：%q %v", got, err)
	}
	if len(checked) != 1 || checked[0] != want {
		t.Fatalf("属主复核未按落盘路径执行：%v", checked)
	}
	if len(*events) != 1 || (*events)[0].SHA256 != result.SHA256 {
		t.Fatalf("审计事件缺失或哈希不符：%+v", *events)
	}
}

// TestWriteDeclaredRejectsBadName 覆盖文件名强制 `kore-<plugin>-*.conf`（K3 硬约束 #2）。
func TestWriteDeclaredRejectsBadName(t *testing.T) {
	decl, dir, events := declaredEnv(t)
	cases := []struct{ name, why string }{
		{"kore-other-x.conf", "别的插件前缀（横向覆盖）"},
		{"site-x.conf", "缺少 kore-<plugin>- 前缀"},
		{"kore-site-.conf", "缺少中间标识"},
		{"kore-site-x.sh", "非 .conf 后缀"},
		{"kore-site-../x.conf", "路径穿越"},
	}
	for _, tc := range cases {
		t.Run(tc.why, func(t *testing.T) {
			_, perr := WriteDeclared(DeclaredOptions{
				PluginID: "site", Action: decl, Name: tc.name, Content: []byte(validVHost),
				CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: okAuditor(events),
				Policy: pluginapi.DefaultFileWriteOptions(), DirOverride: dir,
				OwnerCheck: okOwnerCheck(nil),
			})
			if perr == nil || perr.Code != CodeDeniedPath {
				t.Fatalf("%s 应 E_DENIED_PATH，实际 %+v", tc.name, perr)
			}
		})
	}
	if _, err := os.Stat(dir + "kore-site-x.conf"); err == nil {
		t.Fatalf("拒绝用例不应落盘任何文件")
	}
}

// TestWriteDeclaredRejectsOversize 覆盖内容超 256 KiB（解码后按协议硬顶判）。
func TestWriteDeclaredRejectsOversize(t *testing.T) {
	decl, dir, events := declaredEnv(t)
	oversize := make([]byte, pluginapi.MaxFileWriteContentBytes+1)
	for index := range oversize {
		oversize[index] = 'a'
	}
	_, perr := WriteDeclared(DeclaredOptions{
		PluginID: "site", Action: decl, Name: "kore-site-big.conf", Content: oversize,
		CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: okAuditor(events),
		Policy: pluginapi.DefaultFileWriteOptions(), DirOverride: dir,
		OwnerCheck: okOwnerCheck(nil),
	})
	if perr == nil || perr.Code != CodeTooLarge {
		t.Fatalf("超限正文应 E_TOO_LARGE，实际 %+v", perr)
	}
}

// TestWriteDeclaredRejectsDeniedDirective 覆盖内容策略拒绝（K2 校验器生效）。
func TestWriteDeclaredRejectsDeniedDirective(t *testing.T) {
	decl, dir, events := declaredEnv(t)
	content := "server {\n    listen 80;\n    access_log /tmp/kore.log;\n}\n"
	_, perr := WriteDeclared(DeclaredOptions{
		PluginID: "site", Action: decl, Name: "kore-site-bad.conf", Content: []byte(content),
		CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: okAuditor(events),
		Policy: pluginapi.DefaultFileWriteOptions(), DirOverride: dir,
		OwnerCheck: okOwnerCheck(nil),
	})
	if perr == nil || perr.Code != CodeBadContent {
		t.Fatalf("禁用指令应 E_BAD_CONTENT，实际 %+v", perr)
	}
	if !strings.Contains(perr.Message, "access_log") {
		t.Fatalf("拒绝信息应指出具体指令：%s", perr.Message)
	}
}

// TestWriteDeclaredCertWhitelistInjection 覆盖证书白名单：缺省为空即拒绝，注入后放行。
func TestWriteDeclaredCertWhitelistInjection(t *testing.T) {
	decl, dir, events := declaredEnv(t)
	base := DeclaredOptions{
		PluginID: "site", Action: decl, Name: "kore-site-ssl.conf", Content: []byte(sslVHost),
		CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: okAuditor(events),
		DirOverride: dir, OwnerCheck: okOwnerCheck(nil),
	}
	// 缺省（不注入）→ 拒绝，且错误必须说明白名单为空（不猜安装路径）。
	base.Policy = pluginapi.DefaultFileWriteOptions()
	if _, perr := WriteDeclared(base); perr == nil || perr.Code != CodeBadContent {
		t.Fatalf("证书白名单为空应拒绝，实际 %+v", perr)
	} else if !strings.Contains(perr.Message, "白名单为空") {
		t.Fatalf("错误信息应说明证书白名单为空：%s", perr.Message)
	}
	// 运行时注入 → 放行。
	policy := pluginapi.DefaultFileWriteOptions()
	policy.Nginx.CertPrefixes = []string{"/opt/kore/data/ssl/"}
	base.Policy = policy
	if _, perr := WriteDeclared(base); perr != nil {
		t.Fatalf("注入证书目录后应放行：%v", perr)
	}
}

// TestWriteDeclaredOwnerMismatchRollsBack 是**反例自证**：属主复核失败必须拒绝并回滚。
//
// 如果实现里删掉属主复核这一步，本用例会看到「写入成功」而 FAIL——这正是 K3 硬约束 #2
// 要防的（去掉校验 → 用例 FAIL）。
func TestWriteDeclaredOwnerMismatchRollsBack(t *testing.T) {
	decl, dir, events := declaredEnv(t)
	target := dir + "kore-site-owner.conf"
	if err := os.WriteFile(target, []byte("old\n"), 0o644); err != nil {
		t.Fatalf("预置旧文件失败：%v", err)
	}
	failCheck := func(string, os.FileMode) error { return os.ErrPermission }
	_, perr := WriteDeclared(DeclaredOptions{
		PluginID: "site", Action: decl, Name: "kore-site-owner.conf", Content: []byte(validVHost),
		CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: okAuditor(events),
		Policy: pluginapi.DefaultFileWriteOptions(), DirOverride: dir, OwnerCheck: failCheck,
	})
	if perr == nil || perr.Code != CodeOwnerDenied {
		t.Fatalf("属主复核失败应 E_OWNER_MISMATCH，实际 %+v", perr)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "old\n" {
		t.Fatalf("复核失败后必须回滚到旧内容：%q %v", got, err)
	}

	// 新文件（无备份）→ 复核失败必须把文件删掉，不能留半成品。
	newName := "kore-site-fresh.conf"
	_, perr = WriteDeclared(DeclaredOptions{
		PluginID: "site", Action: decl, Name: newName, Content: []byte(validVHost),
		CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: okAuditor(events),
		Policy: pluginapi.DefaultFileWriteOptions(), DirOverride: dir, OwnerCheck: failCheck,
	})
	if perr == nil || perr.Code != CodeOwnerDenied {
		t.Fatalf("新文件的属主复核失败应 E_OWNER_MISMATCH，实际 %+v", perr)
	}
	if _, err := os.Stat(dir + newName); !os.IsNotExist(err) {
		t.Fatalf("复核失败的新文件必须删除，实际 err=%v", err)
	}

	// 未装配属主复核 → fail-closed（不允许「忘了注入校验」静默放行）。
	_, perr = WriteDeclared(DeclaredOptions{
		PluginID: "site", Action: decl, Name: newName, Content: []byte(validVHost),
		CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: okAuditor(events),
		Policy: pluginapi.DefaultFileWriteOptions(), DirOverride: dir,
	})
	if perr == nil || perr.Code != CodeOwnerDenied {
		t.Fatalf("未装配属主复核应 fail-closed，实际 %+v", perr)
	}
}

// TestWriteDeclaredPathLock 覆盖按路径锁：同一文件的并发写不得交错进入写入临界区。
func TestWriteDeclaredPathLock(t *testing.T) {
	decl, dir, _ := declaredEnv(t)
	var inFlight int32
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	sawConcurrent := int32(0)
	checker := func(string, os.FileMode) error {
		if atomic.AddInt32(&inFlight, 1) > 1 {
			atomic.StoreInt32(&sawConcurrent, 1)
		}
		entered <- struct{}{}
		<-release
		atomic.AddInt32(&inFlight, -1)
		return nil
	}
	write := func() {
		_, perr := WriteDeclared(DeclaredOptions{
			PluginID: "site", Action: decl, Name: "kore-site-lock.conf", Content: []byte(validVHost),
			CopyRoot: filepath.Join(t.TempDir(), "backups"), Auditor: func(AuditEvent) error { return nil },
			Policy: pluginapi.DefaultFileWriteOptions(), DirOverride: dir, OwnerCheck: checker,
		})
		if perr != nil {
			t.Errorf("并发写失败：%v", perr)
		}
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); write() }()
	<-entered // 第一个已进入复核（临界区内）
	wg.Add(1)
	go func() { defer wg.Done(); write() }()
	// 给第二个 goroutine 足够时间尝试进入；若锁缺失它会立刻进入复核并置 sawConcurrent。
	time.Sleep(80 * time.Millisecond)
	if atomic.LoadInt32(&sawConcurrent) == 1 {
		t.Fatalf("同一路径的两次写进入了同一临界区（缺按路径锁）")
	}
	close(release)
	wg.Wait()
}
