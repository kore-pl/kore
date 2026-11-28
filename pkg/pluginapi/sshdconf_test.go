package pluginapi_test

import (
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// sshdDecl 返回一条合法的 sshd drop-in file_write 声明（C12 / ADR-0060）。
func sshdDecl() pluginapi.FileWrite {
	return pluginapi.FileWrite{
		PrefixClass:   "sshd.config.d",
		Mode:          pluginapi.FileWriteModeRoot0644,
		ContentPolicy: pluginapi.ContentPolicySSHDropin,
	}
}

// c12Fragment 是 C12 harness 一键应用验证过的三指令片段（.agents/verify/c12-sshdropin-vm.md §2①）。
const c12Fragment = "PasswordAuthentication no\nMaxAuthTries 3\nPermitRootLogin prohibit-password\n"

// TestSSHDPositiveC12Fragment 锁定 C12 harness 正例：三指令片段在协议层必须通过。
func TestSSHDPositiveC12Fragment(t *testing.T) {
	if err := pluginapi.ValidateSSHDropinFragment([]byte(c12Fragment), pluginapi.DefaultSSHDPolicy()); err != nil {
		t.Fatalf("C12 三指令片段应通过：%v", err)
	}
	decl := sshdDecl()
	opts := pluginapi.DefaultFileWriteOptions()
	if err := pluginapi.ValidateFileWriteRequest("ssh-guard", pluginapi.RootAction{ID: "sshd-dropin-write", FileWrite: &decl}, "kore-ssh-guard-hardening.conf", []byte(c12Fragment), opts); err != nil {
		t.Fatalf("C12 端到端请求应通过：%v", err)
	}
}

// TestDeniedSSHDDirectivesEachRejected 逐条断言显式拒绝清单：清单与实现同源，
// 文档/测试新增一条即自动覆盖。
func TestDeniedSSHDDirectivesEachRejected(t *testing.T) {
	if len(pluginapi.DeniedSSHDDirectives) == 0 {
		t.Fatal("拒绝清单为空")
	}
	for _, denied := range pluginapi.DeniedSSHDDirectives {
		denied := denied
		t.Run(denied.Name, func(t *testing.T) {
			err := pluginapi.ValidateSSHDropinFragment([]byte(denied.Name+" something\n"), pluginapi.DefaultSSHDPolicy())
			if err == nil {
				t.Fatalf("禁用指令 %s 未被拒绝", denied.Name)
			}
			if !strings.Contains(err.Error(), "无条件拒绝") {
				t.Fatalf("拒绝理由应显式（含「无条件拒绝」），实际：%v", err)
			}
			if !strings.Contains(err.Error(), denied.Name) {
				t.Fatalf("错误信息应点名指令 %s，实际：%v", denied.Name, err)
			}
		})
	}
}

// TestDeniedSSHDDirectiveFamiliesRejected 覆盖按前缀拒绝的指令族（枚举漏不掉的变体）。
func TestDeniedSSHDDirectiveFamiliesRejected(t *testing.T) {
	families := []string{
		"AuthorizedKeysFooBar", "AuthorizedPrincipalsFooBar", "HostKeyAgent",
	}
	for _, name := range families {
		name := name
		t.Run(name, func(t *testing.T) {
			err := pluginapi.ValidateSSHDropinFragment([]byte(name+" value\n"), pluginapi.DefaultSSHDPolicy())
			if err == nil || !strings.Contains(err.Error(), "无条件拒绝") {
				t.Fatalf("指令族成员 %s 未被显式拒绝：%v", name, err)
			}
		})
	}
}

// TestSSHDDirectiveCaseVariantsRejected 大小写变体不能绕过拒绝/allowlist。
func TestSSHDDirectiveCaseVariantsRejected(t *testing.T) {
	tests := []string{
		"include /etc/passwd\n",
		"MATCH all\n",
		"authorizedkeyscommand whoami\n",
		"passwordauthentication no\n",
	}
	for _, content := range tests {
		content := content
		t.Run(strings.TrimSpace(content), func(t *testing.T) {
			if err := pluginapi.ValidateSSHDropinFragment([]byte(content), pluginapi.DefaultSSHDPolicy()); err == nil {
				t.Fatalf("大小写变体被放行：%q", content)
			}
		})
	}
}

// TestSSHDAllowlistBoundary 每条 allowlist 指令的合法边界与越界参数。
func TestSSHDAllowlistBoundary(t *testing.T) {
	tests := []struct {
		name    string
		content string
		wantErr bool
	}{
		// 精确枚举（只放行规范写法）
		{"PasswordAuthentication yes", "PasswordAuthentication yes\n", false},
		{"PasswordAuthentication no", "PasswordAuthentication no\n", false},
		{"PasswordAuthentication maybe", "PasswordAuthentication maybe\n", true},
		{"PasswordAuthentication YES", "PasswordAuthentication YES\n", true},
		{"PasswordAuthentication 空参数", "PasswordAuthentication\n", true},
		{"PasswordAuthentication 多参数", "PasswordAuthentication no no\n", true},
		{"PermitRootLogin prohibit-password", "PermitRootLogin prohibit-password\n", false},
		{"PermitRootLogin forced-commands-only", "PermitRootLogin forced-commands-only\n", false},
		{"PermitRootLogin yes", "PermitRootLogin yes\n", false},
		{"PermitRootLogin no", "PermitRootLogin no\n", false},
		{"PermitRootLogin 越界枚举", "PermitRootLogin forced-command-only\n", true},
		{"PubkeyAuthentication yes", "PubkeyAuthentication yes\n", false},
		{"PubkeyAuthentication 越界枚举", "PubkeyAuthentication true\n", true},
		{"KbdInteractiveAuthentication no", "KbdInteractiveAuthentication no\n", false},
		{"KbdInteractiveAuthentication 越界枚举", "KbdInteractiveAuthentication 1\n", true},
		{"PermitEmptyPasswords no", "PermitEmptyPasswords no\n", false},
		{"PermitEmptyPasswords yes 越界", "PermitEmptyPasswords yes\n", true},
		// 整数范围
		{"MaxAuthTries 1 下界", "MaxAuthTries 1\n", false},
		{"MaxAuthTries 100 上界", "MaxAuthTries 100\n", false},
		{"MaxAuthTries 0 越界", "MaxAuthTries 0\n", true},
		{"MaxAuthTries 101 越界", "MaxAuthTries 101\n", true},
		{"MaxAuthTries abc", "MaxAuthTries abc\n", true},
		{"MaxAuthTries -1", "MaxAuthTries -1\n", true},
		{"MaxAuthTries +1", "MaxAuthTries +1\n", true},
		{"ClientAliveInterval 0 下界", "ClientAliveInterval 0\n", false},
		{"ClientAliveInterval 3600 上界", "ClientAliveInterval 3600\n", false},
		{"ClientAliveInterval -1 越界", "ClientAliveInterval -1\n", true},
		{"ClientAliveInterval 3601 越界", "ClientAliveInterval 3601\n", true},
		{"ClientAliveCountMax 0 下界", "ClientAliveCountMax 0\n", false},
		{"ClientAliveCountMax 10 上界", "ClientAliveCountMax 10\n", false},
		{"ClientAliveCountMax -1 越界", "ClientAliveCountMax -1\n", true},
		{"ClientAliveCountMax 11 越界", "ClientAliveCountMax 11\n", true},
		{"LoginGraceTime 1 下界", "LoginGraceTime 1\n", false},
		{"LoginGraceTime 600 上界", "LoginGraceTime 600\n", false},
		{"LoginGraceTime 0 越界", "LoginGraceTime 0\n", true},
		{"LoginGraceTime 601 越界", "LoginGraceTime 601\n", true},
		// MaxStartups 三段
		{"MaxStartups 10:30:100", "MaxStartups 10:30:100\n", false},
		{"MaxStartups 1:1:1 下界", "MaxStartups 1:1:1\n", false},
		{"MaxStartups 1000:1000:1000 上界", "MaxStartups 1000:1000:1000\n", false},
		{"MaxStartups start=0 越界", "MaxStartups 0:30:100\n", true},
		{"MaxStartups rate=0 越界", "MaxStartups 10:0:100\n", true},
		{"MaxStartups full=1001 越界", "MaxStartups 10:30:1001\n", true},
		{"MaxStartups 两段", "MaxStartups 10:30\n", true},
		{"MaxStartups 四段", "MaxStartups 10:30:100:1\n", true},
		{"MaxStartups 非数字", "MaxStartups 10:x:100\n", true},
		{"MaxStartups 空段", "MaxStartups 10::100\n", true},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := pluginapi.ValidateSSHDropinFragment([]byte(tc.content), pluginapi.DefaultSSHDPolicy())
			if tc.wantErr && err == nil {
				t.Fatalf("期望拒绝，实际通过：%q", tc.content)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("期望通过，实际报错：%q → %v", tc.content, err)
			}
		})
	}
}

// TestSSHDUnknownDirectiveRejected 默认全拒：白名单之外任意指令必须拒绝。
func TestSSHDUnknownDirectiveRejected(t *testing.T) {
	content := "PermitRootLogin no\nSomethingElse value\n"
	err := pluginapi.ValidateSSHDropinFragment([]byte(content), pluginapi.DefaultSSHDPolicy())
	if err == nil || !strings.Contains(err.Error(), "不在 allowlist") {
		t.Fatalf("白名单外指令应默认拒绝：%v", err)
	}
}

// TestSSHDConstructRejects 引号 / 续行 / 行内注释 / 变量展开 / 分号 / 花括号构造。
// 这些字符会让「校验器看到的」与「root sshd 解析的」不一致，必须逐类拒。
func TestSSHDConstructRejects(t *testing.T) {
	tests := []struct {
		name    string
		content string
	}{
		{"行内注释", "MaxAuthTries 3 # comment\n"},
		{"行尾注释构造", "PasswordAuthentication no#x\n"},
		{"反斜杠续行", "PasswordAuthentication no \\\nMaxAuthTries 3\n"},
		{"反斜杠在末尾", "MaxAuthTries 3\\\n"},
		{"双引号参数", "MaxAuthTries \"3\"\n"},
		{"单引号指令", "'MaxAuthTries' 3\n"},
		{"百分号变量", "MaxAuthTries %d\n"},
		{"dollar 花括号", "MaxAuthTries ${x}\n"},
		{"分号", "MaxAuthTries 3; PermitRootLogin no\n"},
		{"花括号", "MaxAuthTries {3}\n"},
		{"制表符续行构造", "MaxAuthTries\t3\t# inline\n"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if err := pluginapi.ValidateSSHDropinFragment([]byte(tc.content), pluginapi.DefaultSSHDPolicy()); err == nil {
				t.Fatalf("危险构造被放行：%q", tc.content)
			}
		})
	}
}

// TestSSHDContentShapeRejects 空片段 / 仅注释 / 指令数上限 / token 长度上限 / NUL。
func TestSSHDContentShapeRejects(t *testing.T) {
	tests := []struct {
		name    string
		content string
		policy  pluginapi.SSHDPolicy
		wantErr string
	}{
		{"空片段", "", pluginapi.DefaultSSHDPolicy(), "至少需要一个"},
		{"仅注释", "# nothing here\n", pluginapi.DefaultSSHDPolicy(), "至少需要一个"},
		{"仅空行", "\n\n", pluginapi.DefaultSSHDPolicy(), "至少需要一个"},
		{"注释与正例混排", "# hardening\n" + c12Fragment, pluginapi.DefaultSSHDPolicy(), ""},
		{"指令数上限", strings.Repeat("MaxAuthTries 3\n", pluginapi.DefaultSSHDPolicy().MaxDirectives), pluginapi.DefaultSSHDPolicy(), ""},
		{"指令数越界", strings.Repeat("MaxAuthTries 3\n", pluginapi.DefaultSSHDPolicy().MaxDirectives+1), pluginapi.DefaultSSHDPolicy(), "指令数超过"},
		{"收紧指令数", "MaxAuthTries 3\n", pluginapi.SSHDPolicy{MaxDirectives: 1}, ""},
		{"超长 token", "MaxAuthTries " + strings.Repeat("1", 1025) + "\n", pluginapi.DefaultSSHDPolicy(), "token 超过"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := pluginapi.ValidateSSHDropinFragment([]byte(tc.content), tc.policy)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("期望通过，实际报错：%v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("期望报错包含 %q，实际：%v", tc.wantErr, err)
			}
		})
	}
	if err := pluginapi.ValidateSSHDropinFragment([]byte("MaxAuthTries 3\x00\n"), pluginapi.DefaultSSHDPolicy()); err == nil {
		t.Fatal("NUL 应被拒绝")
	}
}

// TestSSHDDropinProtocolClass 锁定 sshd.config.d 类目：目录 / 后缀 / 属主 / target / 路径逃逸。
func TestSSHDDropinProtocolClass(t *testing.T) {
	decl := sshdDecl()
	action := pluginapi.RootAction{
		ID: "sshd-dropin-write", FileWrite: &decl,
		WritesHost: true, Target: "/etc/ssh/sshd_config.d/", Description: "写 sshd drop-in 片段",
	}
	if err := pluginapi.ValidateRootAction(action); err != nil {
		t.Fatalf("合法声明被拒：%v", err)
	}
	if err := pluginapi.ValidateFileWriteTarget(&decl, "/etc/ssh/sshd_config.d/x.conf"); err == nil {
		t.Fatal("target 必须是类别目录")
	}
	got, err := pluginapi.FileWritePath("ssh-guard", &decl, "kore-ssh-guard-hardening.conf")
	if err != nil || got != "/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf" {
		t.Fatalf("路径拼接错误：got=%q err=%v", got, err)
	}
	// 文件名越界：目录穿越 / 绝对路径 / 其它插件前缀 / 非 .conf / 缺中间标识 / 超长。
	badNames := []string{
		"../evil.conf", "/etc/passwd", "evil.conf", "kore-site-hardening.conf",
		"kore-ssh-guard-x.sh", "kore-ssh-guard-.conf", strings.Repeat("a", 129) + ".conf",
	}
	for _, name := range badNames {
		name := name
		t.Run("bad-name:"+name, func(t *testing.T) {
			if _, err := pluginapi.FileWritePath("ssh-guard", &decl, name); err == nil {
				t.Fatalf("非法文件名被放行：%q", name)
			}
		})
	}
	// 声明错配：content_policy 与其它类别互换直接拒，不静默取类别值。
	mismatch := decl
	mismatch.ContentPolicy = pluginapi.ContentPolicyNginxVHost
	if err := pluginapi.ValidateFileWrite(&mismatch); err == nil {
		t.Fatal("content_policy 与类别不一致应被拒")
	}
	oversize := decl
	oversize.MaxBytes = pluginapi.MaxFileWriteContentBytes + 1
	if err := pluginapi.ValidateFileWrite(&oversize); err == nil {
		t.Fatal("max_bytes 放大应被拒")
	}
}

// TestSSHDContentPolicyDispatch 通过统一入口验证 fail-closed 分派：
// 合法内容过、正文含 deny 指令被拒、未知策略仍拒。
func TestSSHDContentPolicyDispatch(t *testing.T) {
	decl := sshdDecl()
	opts := pluginapi.DefaultFileWriteOptions()
	if err := pluginapi.ValidateFileWriteContent(&decl, []byte(c12Fragment), opts); err != nil {
		t.Fatalf("合法 sshd 正文应通过：%v", err)
	}
	bad := decl
	bad.ContentPolicy = "sshd.dropin.v2"
	if err := pluginapi.ValidateFileWriteContent(&bad, []byte(c12Fragment), opts); err == nil {
		t.Fatal("未知策略应 fail-closed")
	}
	if err := pluginapi.ValidateFileWriteContent(&decl, []byte("Include /etc/passwd\n"), opts); err == nil {
		t.Fatal("含 Include 的正文应被拒")
	}
}

// TestNginxVHostRegressionStillGreen 回归验证：新增 sshd 类目/策略不影响 nginx.vhost.v1。
func TestNginxVHostRegressionStillGreen(t *testing.T) {
	decl := pluginapi.FileWrite{PrefixClass: "nginx.conf.d", Mode: pluginapi.FileWriteModeRoot0644, ContentPolicy: pluginapi.ContentPolicyNginxVHost}
	valid := "server { listen 80; server_name a.example.com; root /var/www/a.example.com; }\n"
	opts := pluginapi.DefaultFileWriteOptions()
	if err := pluginapi.ValidateFileWriteRequest("site", pluginapi.RootAction{ID: "nginx-vhost", FileWrite: &decl}, "kore-site-a.conf", []byte(valid), opts); err != nil {
		t.Fatalf("nginx 正例回归失败：%v", err)
	}
	if err := pluginapi.ValidateFileWriteRequest("site", pluginapi.RootAction{ID: "nginx-vhost", FileWrite: &decl}, "kore-site-a.conf", []byte("server { access_log /etc/shadow; }\n"), opts); err == nil {
		t.Fatal("nginx 反例回归失败：access_log 应被拒")
	}
}
