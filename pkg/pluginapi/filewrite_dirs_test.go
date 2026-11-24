package pluginapi_test

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// sslVHostFragment 是含证书/私钥指令的合法片段（与 K3 的 declared 用例同形）。
const sslVHostFragment = "server {\n    listen 443 ssl;\n    server_name example.com;\n" +
	"    ssl_certificate /opt/kore/data/ssl/example/fullchain.pem;\n" +
	"    ssl_certificate_key /opt/kore/data/ssl/example/key.pem;\n" +
	"    root /var/www/example;\n}\n"

// authVHostFragment 是含口令文件指令的合法片段。
const authVHostFragment = "server {\n    listen 80;\n    server_name example.com;\n" +
	"    auth_basic \"restricted\";\n" +
	"    auth_basic_user_file /opt/kore/data/auth/htpasswd;\n" +
	"    root /var/www/example;\n}\n"

// TestFileWriteOptionsWithDirsEmptyKeepsDeny 锁定「空即拒绝」：调用 helper 不等于放宽。
//
// 三种空输入（nil / 空切片 / 全部条目非法）都必须让两项白名单保持为空，
// 且证书与口令指令仍被校验器拒绝；同时其它默认策略（站点根、禁止端口）不得被清零。
func TestFileWriteOptionsWithDirsEmptyKeepsDeny(t *testing.T) {
	tests := []struct {
		name string
		cert []string
		auth []string
	}{
		{"nil", nil, nil},
		{"空切片", []string{}, []string{}},
		{"全非法", []string{"relative/ssl/", "/opt/kore/data/../ssl/", "/"}, []string{"", "$dir/auth/"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := pluginapi.FileWriteOptionsWithDirs(tc.cert, tc.auth)
			if len(opts.Nginx.CertPrefixes) != 0 {
				t.Fatalf("证书白名单应为空，实际 %#v", opts.Nginx.CertPrefixes)
			}
			if len(opts.Nginx.AuthFilePrefixes) != 0 {
				t.Fatalf("口令白名单应为空，实际 %#v", opts.Nginx.AuthFilePrefixes)
			}
			// 默认策略不能被 helper 清零：否则不传目录时站点根/反代端口会一起失效。
			if len(opts.Nginx.SiteRootPrefixes) == 0 {
				t.Fatal("helper 不应清空默认站点根白名单")
			}
			if !containsPort(opts.Nginx.ForbiddenProxyPorts, 8787) {
				t.Fatalf("helper 不应清空默认禁止反代端口，实际 %#v", opts.Nginx.ForbiddenProxyPorts)
			}
			assertDenied(t, sslVHostFragment, opts.Nginx, "白名单为空")
			assertDenied(t, authVHostFragment, opts.Nginx, "白名单为空")
		})
	}
}

// TestFileWriteOptionsWithDirsInjectsNormalizedPrefix 覆盖注入正例 + 前缀边界。
func TestFileWriteOptionsWithDirsInjectsNormalizedPrefix(t *testing.T) {
	opts := pluginapi.FileWriteOptionsWithDirs(
		[]string{"/opt/kore/data/ssl"},    // 缺尾斜杠 → 补上
		[]string{"/opt/kore//data/auth/"}, // 重复分隔符 → 规范化
	)
	if want := []string{"/opt/kore/data/ssl/"}; !reflect.DeepEqual(opts.Nginx.CertPrefixes, want) {
		t.Fatalf("证书前缀 = %#v，期望 %#v", opts.Nginx.CertPrefixes, want)
	}
	if want := []string{"/opt/kore/data/auth/"}; !reflect.DeepEqual(opts.Nginx.AuthFilePrefixes, want) {
		t.Fatalf("口令前缀 = %#v，期望 %#v", opts.Nginx.AuthFilePrefixes, want)
	}
	if err := pluginapi.ValidateNginxVHostFragment([]byte(sslVHostFragment), opts.Nginx); err != nil {
		t.Fatalf("注入证书目录后仍被拒：%v", err)
	}
	if err := pluginapi.ValidateNginxVHostFragment([]byte(authVHostFragment), opts.Nginx); err != nil {
		t.Fatalf("注入口令目录后仍被拒：%v", err)
	}
	// 两项白名单互相独立：只注入证书目录时口令指令仍须被拒。
	onlyCert := pluginapi.FileWriteOptionsWithDirs([]string{"/opt/kore/data/ssl/"}, nil)
	assertDenied(t, authVHostFragment, onlyCert.Nginx, "白名单为空")
	// 前缀边界：`/opt/kore/data/ssl-evil/` 不得被 `/opt/kore/data/ssl/` 命中。
	evil := strings.Replace(sslVHostFragment, "/opt/kore/data/ssl/example/", "/opt/kore/data/ssl-evil/example/", 1)
	assertDenied(t, evil, opts.Nginx, "不在允许前缀内")
}

// TestFileWriteOptionsWithDirsDropsInvalidEntries 锁定非法条目的处理：逐条丢弃（不是整体报错）。
func TestFileWriteOptionsWithDirsDropsInvalidEntries(t *testing.T) {
	tests := []struct {
		name string
		dirs []string
		want []string
	}{
		{"合法补尾斜杠", []string{"/opt/kore/data/ssl"}, []string{"/opt/kore/data/ssl/"}},
		{"重复分隔符规范化", []string{"/opt/kore//data/ssl/"}, []string{"/opt/kore/data/ssl/"}},
		{"等价写法去重", []string{"/opt/kore/data/ssl", "/opt/kore/data/ssl/"}, []string{"/opt/kore/data/ssl/"}},
		{"相对路径丢弃", []string{"data/ssl/"}, nil},
		{"含 .. 丢弃", []string{"/opt/kore/data/../ssl/"}, nil},
		{"根目录丢弃", []string{"/"}, nil},
		{"变量丢弃", []string{"/opt/$install/ssl/"}, nil},
		{"反斜杠丢弃", []string{`C:\ssl\`}, nil},
		{"空串丢弃", []string{""}, nil},
		{"控制字符丢弃", []string{"/opt/kore/\x01ssl/"}, nil},
		{"混合时保留合法项", []string{"relative", "/opt/kore/data/ssl/", "/"}, []string{"/opt/kore/data/ssl/"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := pluginapi.FileWriteOptionsWithDirs(tc.dirs, nil)
			if !reflect.DeepEqual(opts.Nginx.CertPrefixes, tc.want) {
				t.Fatalf("证书前缀 = %#v，期望 %#v", opts.Nginx.CertPrefixes, tc.want)
			}
		})
	}
}

// TestFileWriteOptionsWithDirsDoesNotTouchFilesystem 证明本函数是纯词法的：
// 不 stat（目录不存在也照样注入）、不解析符号链接（软链按字面路径注入，不换成目标）。
func TestFileWriteOptionsWithDirsDoesNotTouchFilesystem(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 的符号链接语义不同（需要特权），本用例只在类 Unix 上取值")
	}
	base := t.TempDir()
	target := filepath.Join(base, "real-ssl")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatalf("建真实目录失败：%v", err)
	}
	link := filepath.Join(base, "ssl-link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("当前环境不支持创建符号链接：%v", err)
	}
	missing := filepath.Join(base, "not-created", "ssl")

	opts := pluginapi.FileWriteOptionsWithDirs([]string{link + "/", missing + "/"}, nil)
	want := []string{link + "/", missing + "/"}
	if !reflect.DeepEqual(opts.Nginx.CertPrefixes, want) {
		t.Fatalf("证书前缀 = %#v，期望字面路径 %#v（不应解析软链/不 stat）",
			opts.Nginx.CertPrefixes, want)
	}
}

// TestFileWriteOptionsWithDirsDenyIsWhitelistCaused 是**反例自证**的常驻形式。
//
// 空目录用例的「必须报错」断言如果是因为片段本身非法而恒真，就没有判别力。
// 这里把「总是放行」的等价策略（注入根目录 `/`）显式构造出来：
//   - mutant 必须放行两份片段 → 证明片段本身合法，拒绝只可能来自白名单；
//   - 真实 helper 在空目录下必须拒绝 → 证明它没有退化成 mutant。
//
// 若把 helper 改成「总是放行」（例如直接写 []string{"/"}），
// TestFileWriteOptionsWithDirsEmptyKeepsDeny 与 ...DropsInvalidEntries 会 FAIL；
// 该变异已在交付报告里用临时补丁实跑验证（非仅本用例推断）。
func TestFileWriteOptionsWithDirsDenyIsWhitelistCaused(t *testing.T) {
	mutant := pluginapi.DefaultFileWriteOptions()
	mutant.Nginx.CertPrefixes = []string{"/"}
	mutant.Nginx.AuthFilePrefixes = []string{"/"}
	if err := pluginapi.ValidateNginxVHostFragment([]byte(sslVHostFragment), mutant.Nginx); err != nil {
		t.Fatalf("mutant 应放行合法证书片段（否则无法证明拒绝来自白名单）：%v", err)
	}
	if err := pluginapi.ValidateNginxVHostFragment([]byte(authVHostFragment), mutant.Nginx); err != nil {
		t.Fatalf("mutant 应放行合法口令片段：%v", err)
	}
	real := pluginapi.FileWriteOptionsWithDirs(nil, nil)
	assertDenied(t, sslVHostFragment, real.Nginx, "白名单为空")
	assertDenied(t, authVHostFragment, real.Nginx, "白名单为空")
}

// assertDenied 断言片段被策略拒绝，且错误信息包含 want，避免「因别的语法问题被拒」冒充白名单生效。
func assertDenied(t *testing.T, fragment string, policy pluginapi.NginxPolicy, want string) {
	t.Helper()
	err := pluginapi.ValidateNginxVHostFragment([]byte(fragment), policy)
	if err == nil {
		t.Fatalf("期望被拒（错误应含 %q），实际通过", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("错误信息 %q 不含 %q", err.Error(), want)
	}
}

// containsPort 判断端口是否在列表里。
func containsPort(ports []int, want int) bool {
	for _, port := range ports {
		if port == want {
			return true
		}
	}
	return false
}
