package pluginapi_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// minimalRootAction 是合法最小项：只有必填字段，description / irreversible 取零值。
// 插件作者自检时可以把本函数当作基线，逐项覆盖自己的 root_actions。
func minimalRootAction() pluginapi.RootAction {
	return pluginapi.RootAction{
		ID:       "ufw-status",
		Argv:     []string{"ufw", "status", "verbose"},
		TimeoutS: 10,
	}
}

// TestValidateRootAction 表驱动覆盖 root_actions schema 的接受与拒绝口径。
//
// 这是公开 SDK 的自检入口：插件在自己的测试里读 info.json 的 root_actions，
// 逐条调用 ValidateRootAction 即可在编译期/测试期发现清单漂移。
func TestValidateRootAction(t *testing.T) {
	const descRunes200 = 200

	cases := []struct {
		name    string
		mutate  func(*pluginapi.RootAction)
		wantErr string // 空串表示期望通过
	}{
		// ---- 合法项 ----
		{
			name:   "合法最小项",
			mutate: func(*pluginapi.RootAction) {},
		},
		{
			name: "合法完整项（绝对路径 + 满分 description + irreversible）",
			mutate: func(a *pluginapi.RootAction) {
				a.ID = "fail2ban-banip"
				a.Argv = []string{"/usr/bin/fail2ban-client", "set", "sshd", "banip"}
				a.TimeoutS = 300
				a.Description = strings.Repeat("封", descRunes200) // 200 个 rune，600 字节
				a.Irreversible = true
			},
		},
		{
			name: "description 恰好 200 runes 通过（按 rune 不按 byte）",
			mutate: func(a *pluginapi.RootAction) {
				a.Description = strings.Repeat("墙", 200)
			},
		},
		{
			name: "timeout 下边界 1 通过",
			mutate: func(a *pluginapi.RootAction) {
				a.TimeoutS = pluginapi.MinRootTimeoutS
			},
		},
		{
			name: "timeout 上边界 300 通过",
			mutate: func(a *pluginapi.RootAction) {
				a.TimeoutS = pluginapi.MaxRootTimeoutS
			},
		},
		{
			name: "argv 首项为规范化绝对路径通过",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"/usr/sbin/ufw", "status"}
			},
		},

		// ---- 缺字段 ----
		{
			name:    "缺 id",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "" },
			wantErr: "id=",
		},
		{
			name:    "缺 argv（nil）",
			mutate:  func(a *pluginapi.RootAction) { a.Argv = nil },
			wantErr: "argv 不能为空",
		},
		{
			name:    "缺 argv（空数组）",
			mutate:  func(a *pluginapi.RootAction) { a.Argv = []string{} },
			wantErr: "argv 不能为空",
		},
		{
			name:    "缺 timeout_s（JSON 未给时为 0）",
			mutate:  func(a *pluginapi.RootAction) { a.TimeoutS = 0 },
			wantErr: "timeout_s=0",
		},
		{
			name: "argv 中间项为空",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"systemctl", "", "reload"}
			},
			wantErr: "argv[1] 不能为空",
		},
		{
			name: "argv[0] 为空",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"", "status"}
			},
			wantErr: "argv[0] 不能为空",
		},

		// ---- 超长 description ----
		{
			name: "description 201 runes 拒绝",
			mutate: func(a *pluginapi.RootAction) {
				a.Description = strings.Repeat("墙", 201)
			},
			wantErr: "description 超过 200 个字符",
		},
		{
			name: "description 200 个 ASCII 字符通过（byte 数不放大判断）",
			mutate: func(a *pluginapi.RootAction) {
				a.Description = strings.Repeat("a", 200)
			},
		},

		// ---- 非法 action 名 ----
		{
			name:    "id 含大写",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "Ufw-Status" },
			wantErr: "必须匹配",
		},
		{
			name:    "id 以数字开头",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "1ufw" },
			wantErr: "必须匹配",
		},
		{
			name:    "id 含下划线",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "ufw_status" },
			wantErr: "必须匹配",
		},
		{
			name:    "id 含空格",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "ufw status" },
			wantErr: "必须匹配",
		},
		{
			name:    "id 含点号",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "ufw.status" },
			wantErr: "必须匹配",
		},
		{
			name:    "id 以连字符开头",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "-ufw" },
			wantErr: "必须匹配",
		},
		{
			name:    "id 含中文",
			mutate:  func(a *pluginapi.RootAction) { a.ID = "防火墙" },
			wantErr: "必须匹配",
		},

		// ---- argv 形态与上限 ----
		{
			name: "argv[0] 为未规范化绝对路径（尾斜杠）",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"/usr/sbin/ufw/", "status"}
			},
			wantErr: "不是规范化的绝对路径",
		},
		{
			name: "argv[0] 含 .. 路径穿越",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"/usr/sbin/../bin/ufw", "status"}
			},
			wantErr: "不是规范化的绝对路径",
		},
		{
			name: "argv[0] 为根目录",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"/", "status"}
			},
			wantErr: "不是规范化的绝对路径",
		},
		{
			name: "argv[0] 为相对路径带斜杠",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"bin/ufw", "status"}
			},
			wantErr: "既不是绝对路径也不是命令名",
		},
		{
			name: "argv[0] 不在命令白名单",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"bash", "-c", "id"}
			},
			wantErr: "不在命令白名单内",
		},
		{
			name: "argv 元素含换行（控制字符）",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"systemctl", "reload\nnginx"}
			},
			wantErr: "含 NUL/控制字符",
		},
		{
			name: "argv 元素含 NUL",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"systemctl", "reload\x00nginx"}
			},
			wantErr: "含 NUL/控制字符",
		},
		{
			name: "argv 元素超过 256 runes",
			mutate: func(a *pluginapi.RootAction) {
				a.Argv = []string{"systemctl", strings.Repeat("x", pluginapi.MaxRootArgRunes+1)}
			},
			wantErr: "超过 256 个字符",
		},
		{
			name: "argv 元素数超过上限",
			mutate: func(a *pluginapi.RootAction) {
				argv := make([]string, 0, pluginapi.MaxRootArgs+1)
				argv = append(argv, "systemctl")
				for len(argv) <= pluginapi.MaxRootArgs {
					argv = append(argv, "x")
				}
				a.Argv = argv
			},
			wantErr: "argv 最多 32 个元素",
		},
		{
			name: "argv 总长度超过 4096",
			mutate: func(a *pluginapi.RootAction) {
				// 16 个 256 字符的参数 = 4096，再加 1 即越界；仍受单项 256 上限约束。
				argv := []string{"systemctl"}
				for i := 0; i < 16; i++ {
					argv = append(argv, strings.Repeat("x", 256))
				}
				a.Argv = argv
			},
			wantErr: "argv 总长度超过 4096 个字符",
		},

		// ---- timeout 越界 ----
		{
			name:    "timeout 低于下界",
			mutate:  func(a *pluginapi.RootAction) { a.TimeoutS = -1 },
			wantErr: "超出 1–300",
		},
		{
			name:    "timeout 高于上界",
			mutate:  func(a *pluginapi.RootAction) { a.TimeoutS = 301 },
			wantErr: "超出 1–300",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			action := minimalRootAction()
			tc.mutate(&action)
			err := pluginapi.ValidateRootAction(action)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("ValidateRootAction(%+v) = %v，期望通过", action, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ValidateRootAction(%+v) = nil，期望报错包含 %q", action, tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("错误 = %q，期望包含 %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// TestRootActionIrreversible 锁定 irreversible 的语义边界：
// schema 层只接受该字段（true/false 均可），「必须携带一次性 confirm 令牌」是
// 内核执行层（协议 §3.1.4）的护栏，不由 ValidateRootAction 判断——插件自检
// 不应把 irreversible 误当成 schema 错误。
func TestRootActionIrreversible(t *testing.T) {
	cases := []struct {
		name         string
		irreversible bool
		wantValid    bool
	}{
		{name: "irreversible=false 可执行动作", irreversible: false, wantValid: true},
		{name: "irreversible=true 可执行动作", irreversible: true, wantValid: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			action := minimalRootAction()
			action.Irreversible = tc.irreversible
			if err := pluginapi.ValidateRootAction(action); (err == nil) != tc.wantValid {
				t.Fatalf("irreversible=%v: err=%v，wantValid=%v", tc.irreversible, err, tc.wantValid)
			}
			// JSON 往返必须保留语义（缺省为 false，不因 omitempty 丢成 true）。
			blob, err := json.Marshal(action)
			if err != nil {
				t.Fatalf("json.Marshal: %v", err)
			}
			var decoded pluginapi.RootAction
			if err := json.Unmarshal(blob, &decoded); err != nil {
				t.Fatalf("json.Unmarshal(%s): %v", blob, err)
			}
			if decoded.Irreversible != tc.irreversible {
				t.Fatalf("JSON 往返后 irreversible=%v，期望 %v（%s）", decoded.Irreversible, tc.irreversible, blob)
			}
		})
	}

	// 缺省（不写 irreversible）解码后为 false，这是「默认非不可回滚」的协议口径。
	var defaulted pluginapi.RootAction
	if err := json.Unmarshal([]byte(`{"id":"ufw-status","argv":["ufw","status"],"timeout_s":10}`), &defaulted); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if defaulted.Irreversible {
		t.Fatalf("未声明 irreversible 时应为 false，实际 true")
	}
}

// TestRootActionJSONFields 锁定字段名与未知字段口径：
//   - 字段名是协议的一部分（timeout_s / irreversible），写成驼峰等拼错会落成零值，
//     随后被 ValidateRootAction 拒绝（timeout_s=0），不会静默通过；
//   - 未知字段按 encoding/json 默认行为忽略（向前兼容：后续 SDK 增补字段不会
//     让旧版插件自检直接失败），因此插件自检应把「零值被拒」当作拼写错误的信号。
func TestRootActionJSONFields(t *testing.T) {
	const validJSON = `{"id":"ufw-status","argv":["ufw","status"],"timeout_s":10,
		"description":"只读状态","irreversible":true}`

	var action pluginapi.RootAction
	if err := json.Unmarshal([]byte(validJSON), &action); err != nil {
		t.Fatalf("json.Unmarshal 合法项: %v", err)
	}
	if action.ID != "ufw-status" || len(action.Argv) != 2 || action.TimeoutS != 10 ||
		!action.Irreversible || action.Description != "只读状态" {
		t.Fatalf("字段解码不符：%+v", action)
	}
	if err := pluginapi.ValidateRootAction(action); err != nil {
		t.Fatalf("合法 JSON 项校验失败: %v", err)
	}

	// 未知字段：忽略、不报错，已知字段照常生效。
	var withUnknown pluginapi.RootAction
	if err := json.Unmarshal([]byte(`{"id":"ufw-deny","argv":["ufw","deny"],"timeout_s":10,
		"future_field":{"nested":true},"since":"v0.2.0"}`), &withUnknown); err != nil {
		t.Fatalf("含未知字段的 JSON 不应解码失败: %v", err)
	}
	if err := pluginapi.ValidateRootAction(withUnknown); err != nil {
		t.Fatalf("含未知字段的合法项校验失败: %v", err)
	}

	// 拼错/漏写 timeout_s：零值被 schema 拒绝，避免"看起来解析成功"的静默漂移。
	var typo pluginapi.RootAction
	if err := json.Unmarshal([]byte(`{"id":"ufw-deny","argv":["ufw","deny"],"timeoutSeconds":10}`), &typo); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if typo.TimeoutS != 0 {
		t.Fatalf("未识别的 timeoutSeconds 不应写入 TimeoutS，实际 %d", typo.TimeoutS)
	}
	if err := pluginapi.ValidateRootAction(typo); err == nil {
		t.Fatal("timeout_s 缺失（拼错字段名）应被 ValidateRootAction 拒绝")
	}
}

// TestRootActionsFromInfoJSON 是给插件作者的复用样例：读 info.json 里的
// root_actions 数组，逐条校验；任一条失败即测试失败（附 id 与下标便于定位）。
func TestRootActionsFromInfoJSON(t *testing.T) {
	// 片段取自真实插件清单（firewall / ssh-guard / waf 的组合形态）。
	const infoJSON = `{
	  "requires_root": true,
	  "root_actions": [
	    {"id":"ufw-status","argv":["ufw","status","verbose"],"timeout_s":10},
	    {"id":"fail2ban-banip","argv":["/usr/bin/fail2ban-client","set","sshd","banip"],
	     "timeout_s":10,"description":"封禁 IP","irreversible":true},
	    {"id":"nginx-reload","argv":["nginx","-s","reload"],"timeout_s":20}
	  ]
	}`

	var manifest struct {
		RequiresRoot bool                   `json:"requires_root"`
		RootActions  []pluginapi.RootAction `json:"root_actions"`
	}
	if err := json.Unmarshal([]byte(infoJSON), &manifest); err != nil {
		t.Fatalf("解析 info.json: %v", err)
	}
	if !manifest.RequiresRoot {
		t.Fatal("root_actions 非空时 requires_root 必须为 true")
	}
	if len(manifest.RootActions) == 0 {
		t.Fatal("root_actions 解析为空")
	}
	for i, action := range manifest.RootActions {
		if err := pluginapi.ValidateRootAction(action); err != nil {
			t.Errorf("root_actions[%d] id=%q 校验失败: %v", i, action.ID, err)
		}
	}

	// 反例：清单里混入一条非法项时，逐条校验必须能定位到它。
	bad := pluginapi.RootAction{ID: "Bad_ID", Argv: []string{"ufw"}, TimeoutS: 10}
	if err := pluginapi.ValidateRootAction(bad); err == nil {
		t.Fatal("非法 id 应被拒绝")
	}
}

// TestRootCommandAllowlist 锁定协议常量与文档（PLUGIN-PROTOCOL §3.1.3）一致；
// 增删命令属协议变更，必须走 ADR + 文档同步。
func TestRootCommandAllowlist(t *testing.T) {
	// ADR-0022：白名单从「命令名」升级为「命令 + 子命令 + 参数形状」，nft / ipset
	// 与 dns 组（resolvectl / unbound-control / dig）由此加入；fail2ban-client 是
	// 现有 ssh-guard 0.2.x 声明所必需（形状锁到 status/banip/unbanip）。
	want := []string{"chmod", "chown", "crontab", "dig", "docker", "fail2ban-client",
		"ipset", "iptables", "nginx", "nft", "resolvectl", "systemctl", "ufw", "unbound-control"}
	if len(pluginapi.RootCommandAllowlist) != len(want) {
		t.Fatalf("白名单数量 = %d，期望 %d", len(pluginapi.RootCommandAllowlist), len(want))
	}
	for _, name := range want {
		if _, ok := pluginapi.RootCommandAllowlist[name]; !ok {
			t.Errorf("白名单缺少命令 %q", name)
		}
	}
}
