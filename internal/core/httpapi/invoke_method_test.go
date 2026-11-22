package httpapi

import "testing"

// TestValidateMethodAllowsCamelCase 验证业务方法名与插件方法注册表同口径：
// 段首小写、段内允许 camelCase；插件声明的 site.bindSSL / site.setRewrite
// 必须能经 POST /api/v1/invoke 到达，否则等于"声明了但调不到"。
func TestValidateMethodAllowsCamelCase(t *testing.T) {
	cases := []struct {
		name   string
		plugin string
		method string
		wantOK bool
	}{
		{"纯小写", "site", "site.list", true},
		{"camelCase 动词", "site", "site.bindSSL", true},
		{"camelCase 动词 2", "site", "site.setRewrite", true},
		{"camelCase 动词 3", "site", "site.getRewrite", true},
		{"file 方法", "file", "file.download", true},
		{"首段大写拒绝", "site", "Site.list", false},
		{"动词首字符大写拒绝", "site", "site.BindSSL", false},
		{"空方法段拒绝", "site", "site.", false},
		{"域与插件不一致拒绝", "site", "other.bindSSL", false},
		{"保留前缀拒绝", "site", "kore.shutdown", false},
		{"空白字符拒绝", "site", "site.bind SSL", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := validateMethod(c.plugin, c.method) == nil
			if got != c.wantOK {
				t.Fatalf("validateMethod(%q, %q) ok=%v，期望 %v", c.plugin, c.method, got, c.wantOK)
			}
		})
	}
}
