package pluginapi_test

import (
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// validFileWrite 返回一条合法的 file_write 声明（测试基线）。
func validFileWrite() pluginapi.FileWrite {
	return pluginapi.FileWrite{
		PrefixClass:   "nginx.conf.d",
		Mode:          pluginapi.FileWriteModeRoot0644,
		ContentPolicy: pluginapi.ContentPolicyNginxVHost,
	}
}

// TestValidateRootActionFileWrite 锁定 file_write 声明的 schema 边界（ADR-0052）。
func TestValidateRootActionFileWrite(t *testing.T) {
	base := func() pluginapi.RootAction {
		decl := validFileWrite()
		return pluginapi.RootAction{
			ID: "nginx-vhost", FileWrite: &decl, WritesHost: true,
			Target: "/etc/nginx/conf.d/", Description: "写 nginx 站点片段",
		}
	}
	tests := []struct {
		name    string
		mutate  func(*pluginapi.RootAction)
		wantErr string
	}{
		{"合法声明", func(*pluginapi.RootAction) {}, ""},
		{"缺 prefix_class", func(a *pluginapi.RootAction) { a.FileWrite.PrefixClass = "" }, "prefix_class"},
		{"未知 prefix_class", func(a *pluginapi.RootAction) { a.FileWrite.PrefixClass = "nginx.sites-enabled" }, "prefix_class"},
		{"mode 十进制 644", func(a *pluginapi.RootAction) { a.FileWrite.Mode = "644" }, "mode"},
		{"mode 0600", func(a *pluginapi.RootAction) { a.FileWrite.Mode = "0600" }, "mode"},
		{"content_policy 不匹配类别", func(a *pluginapi.RootAction) {
			a.FileWrite.ContentPolicy = "nginx.vhost.v2"
		}, "content_policy"},
		{"max_bytes 放大", func(a *pluginapi.RootAction) {
			a.FileWrite.MaxBytes = pluginapi.MaxFileWriteContentBytes + 1
		}, "max_bytes"},
		{"max_bytes 为负", func(a *pluginapi.RootAction) { a.FileWrite.MaxBytes = -1 }, "max_bytes"},
		{"max_bytes 收紧合法", func(a *pluginapi.RootAction) { a.FileWrite.MaxBytes = 64 << 10 }, ""},
		// 两种动作形状互斥：写文件动作带 argv 会让审计/confirm 口径分叉。
		{"file_write 带 argv", func(a *pluginapi.RootAction) { a.Argv = []string{"nginx", "-t"} }, "不得声明 argv"},
		{"file_write 未声明 writes_host", func(a *pluginapi.RootAction) { a.WritesHost = false }, "writes_host"},
		{"target 不是类别目录", func(a *pluginapi.RootAction) { a.Target = "/etc/nginx/conf.d/x.conf" }, "target"},
		{"timeout_s 非零且越界", func(a *pluginapi.RootAction) { a.TimeoutS = 999 }, "timeout_s"},
		{"timeout_s 省略合法", func(a *pluginapi.RootAction) { a.TimeoutS = 0 }, ""},
		{"timeout_s 在区间内", func(a *pluginapi.RootAction) { a.TimeoutS = 30 }, ""},
		{"purge_op file.restore 合法", func(a *pluginapi.RootAction) {
			a.PurgeOp = &pluginapi.PurgeOp{Kind: pluginapi.PurgeKindFileRestore, Args: []string{"/tmp/bak", "/etc/nginx/conf.d/kore-site-a.conf"}}
		}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			action := base()
			tc.mutate(&action)
			err := pluginapi.ValidateRootAction(action)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("期望通过，实际报错：%v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("期望报错包含 %q，实际通过", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("错误信息 %q 不含 %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// TestValidateRootActionExecStaysStrict 确认原有 exec 动作的 schema 未被放松。
func TestValidateRootActionExecStaysStrict(t *testing.T) {
	action := pluginapi.RootAction{ID: "nginx-test", Argv: []string{"nginx", "-t"}, TimeoutS: 10}
	if err := pluginapi.ValidateRootAction(action); err != nil {
		t.Fatalf("合法 exec 动作被拒：%v", err)
	}
	empty := pluginapi.RootAction{ID: "nginx-test", TimeoutS: 10}
	if err := pluginapi.ValidateRootAction(empty); err == nil || !strings.Contains(err.Error(), "argv 不能为空") {
		t.Fatalf("空 argv 的 exec 动作应被拒，实际 err=%v", err)
	}
}

// TestValidateFileWriteName 锁定请求文件名：单层、后缀、插件归属前缀。
func TestValidateFileWriteName(t *testing.T) {
	decl := validFileWrite()
	tests := []struct {
		name    string
		file    string
		wantErr string
	}{
		{"合法 site vhost", "kore-site-example.com.conf", ""},
		{"合法下划线域名", "kore-site-_default.conf", ""},
		{"空文件名", "", "不能为空"},
		{"含路径分隔符", "kore-site-a/../../passwd.conf", "单层"},
		{"含反斜杠", "kore-site-a\\passwd.conf", "单层"},
		{"含 ..", "kore-site-a..conf", ".."},
		{"后缀错误", "kore-site-a.sh", "结尾"},
		{"缺插件归属前缀", "other-plugin-a.conf", "开头"},
		{"只有前缀与后缀", "kore-site-.conf", "中间标识"},
		{"非法字符", "kore-site-a b.conf", "非法字符"},
		{"超长", "kore-site-" + strings.Repeat("a", 200) + ".conf", "超过"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := pluginapi.ValidateFileWriteName("site", &decl, tc.file)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("期望通过，实际报错：%v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("期望报错包含 %q，实际通过", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("错误信息 %q 不含 %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// TestFileWritePath 锁定最终路径的唯一拼法：目录来自类别、名字来自请求。
func TestFileWritePath(t *testing.T) {
	decl := validFileWrite()
	full, err := pluginapi.FileWritePath("site", &decl, "kore-site-example.com.conf")
	if err != nil {
		t.Fatalf("合法路径被拒：%v", err)
	}
	if want := "/etc/nginx/conf.d/kore-site-example.com.conf"; full != want {
		t.Fatalf("路径 = %q，期望 %q", full, want)
	}
	// 跨插件覆盖：site 不能写别的插件前缀。
	if _, err := pluginapi.FileWritePath("site", &decl, "kore-waf-example.conf"); err == nil {
		t.Fatal("跨插件的文件名应被拒绝")
	}
}

// TestValidateFileWriteContentLimits 锁定正文层的大小/编码/控制字符边界。
func TestValidateFileWriteContentLimits(t *testing.T) {
	decl := validFileWrite()
	valid := []byte("server {\n    listen 80;\n}\n")
	opts := pluginapi.DefaultFileWriteOptions()
	if err := pluginapi.ValidateFileWriteContent(&decl, valid, opts); err != nil {
		t.Fatalf("合法片段被拒：%v", err)
	}
	tests := []struct {
		name    string
		content []byte
		wantErr string
	}{
		{"空正文", nil, "不能为空"},
		{"NUL", []byte("server {}\x00"), "NUL"},
		{"BEL 控制字符", []byte("server {\x07\n}\n"), "控制字符"},
		{"非法 UTF-8", []byte{0x73, 0x65, 0xff, 0xfe}, "UTF-8"},
		{"超协议硬顶", make([]byte, pluginapi.MaxFileWriteContentBytes+1), "上限"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := pluginapi.ValidateFileWriteContent(&decl, tc.content, opts)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("期望报错包含 %q，实际 err=%v", tc.wantErr, err)
			}
		})
	}
}

// TestValidateFileWriteRequest 覆盖执行期单一入口：没有声明不能写、文件名与正文都要过。
func TestValidateFileWriteRequest(t *testing.T) {
	decl := validFileWrite()
	action := pluginapi.RootAction{ID: "nginx-vhost", FileWrite: &decl, WritesHost: true, Target: "/etc/nginx/conf.d/"}
	opts := pluginapi.DefaultFileWriteOptions()
	content := []byte("server {\n    listen 80;\n    server_name a.example.com;\n    root /var/www/a.example.com;\n}\n")
	if err := pluginapi.ValidateFileWriteRequest("site", action, "kore-site-a.example.com.conf", content, opts); err != nil {
		t.Fatalf("合法请求被拒：%v", err)
	}
	noDecl := pluginapi.RootAction{ID: "nginx-vhost"}
	if err := pluginapi.ValidateFileWriteRequest("site", noDecl, "kore-site-a.conf", content, opts); err == nil {
		t.Fatal("没有 file_write 声明的动作不应能写文件")
	}
	if err := pluginapi.ValidateFileWriteRequest("site", action, "kore-site-a.conf", []byte("server {\n access_log /etc/shadow;\n}\n"), opts); err == nil {
		t.Fatal("含 access_log 的正文应被拒")
	}
}
