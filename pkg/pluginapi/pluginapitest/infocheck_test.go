package pluginapitest_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi/pluginapitest"
)

// validManifest 是覆盖全部四块声明的合法样例（能力均为特权能力，方法级只收窄）。
const validManifest = `{
  "id": "ufw-tool",
  "capabilities": ["system:admin", "system:read"],
  "method_capabilities": {
    "ufw-tool.status": "system:read",
    "ufw-tool.reload": "system:admin"
  },
  "requires_root": true,
  "root_actions": [
    {"id": "status", "argv": ["ufw", "status", "verbose"], "timeout_s": 10},
    {"id": "reload", "argv": ["nginx", "-s", "reload"], "timeout_s": 20, "description": "重载"}
  ]
}`

// TestValidateInfoJSON 表驱动覆盖自检入口的接受/拒绝口径。
func TestValidateInfoJSON(t *testing.T) {
	// 64 条方法级能力：全部合法；再拼一条即越界。
	sixtyFour := make(map[string]string, pluginapitest.MaxMethodCapabilities)
	for i := 0; i < pluginapitest.MaxMethodCapabilities; i++ {
		sixtyFour[fmt.Sprintf("p.m%d", i)] = "system:read"
	}
	overMethodCaps := make(map[string]string, pluginapitest.MaxMethodCapabilities+1)
	for i := 0; i <= pluginapitest.MaxMethodCapabilities; i++ {
		overMethodCaps[fmt.Sprintf("p.m%d", i)] = "system:read"
	}

	// 17 条能力（上限 16）。
	tooManyCapabilities := make([]string, 0, pluginapitest.MaxCapabilities+1)
	for i := 0; i <= pluginapitest.MaxCapabilities; i++ {
		tooManyCapabilities = append(tooManyCapabilities, fmt.Sprintf("p:cap%d", i))
	}

	// 17 条 root_actions（上限 16）。
	var tooManyActions strings.Builder
	tooManyActions.WriteString(`{"id":"p","capabilities":["system:read"],"root_actions":[`)
	for i := 0; i <= pluginapitest.MaxRootActions; i++ {
		if i > 0 {
			tooManyActions.WriteString(",")
		}
		fmt.Fprintf(&tooManyActions, `{"id":"a%d","argv":["ufw","status"],"timeout_s":10}`, i)
	}
	tooManyActions.WriteString(`],"requires_root":true}`)

	manifestWith := func(mutation string) string {
		return `{"id":"p","capabilities":["system:read"],"method_capabilities":{` + mutation + `}}`
	}

	cases := []struct {
		name    string
		json    string
		wantErr string // 空串表示期望通过
	}{
		{name: "合法完整项", json: validManifest},
		{
			name: "合法最小项（无 root_actions / method_capabilities）",
			json: `{"id":"p","capabilities":["p:read"]}`,
		},
		{
			name: "requires_root=true 但无动作（允许）",
			json: `{"id":"p","capabilities":["system:read"],"requires_root":true}`,
		},
		{
			name: "未知字段忽略（向前兼容）",
			json: `{"id":"p","capabilities":["p:read"],"future_field":{"x":1},"method_capabilities":{}}`,
		},

		// ---- 结构 ----
		{name: "非法 JSON", json: `{"id":`, wantErr: "不是合法 JSON"},
		{name: "缺 id", json: `{"capabilities":["system:read"]}`, wantErr: "缺 id"},

		// ---- capabilities ----
		{name: "capabilities 为空", json: `{"id":"p","capabilities":[]}`, wantErr: "capabilities 不能为空"},
		{name: "capabilities 超过 16 项", json: fmt.Sprintf(
			`{"id":"p","capabilities":[%s]}`, strings.Join(quoteAll(tooManyCapabilities), ",")),
			wantErr: "capabilities 最多 16 项"},
		{name: "capabilities 重复", json: `{"id":"p","capabilities":["p:read","p:read"]}`,
			wantErr: "重复"},
		{name: "capabilities 语法非法", json: `{"id":"p","capabilities":["system"]}`,
			wantErr: "语法非法"},
		{name: "capabilities 域不是自身 id", json: `{"id":"p","capabilities":["other:read"]}`,
			wantErr: "能力域"},
		{name: "capabilities 含未知特权动作", json: `{"id":"p","capabilities":["system:superuser"]}`,
			wantErr: "能力域"},

		// ---- method_capabilities ----
		{name: "method_capabilities 不是对象", json: `{"id":"p","capabilities":["system:read"],"method_capabilities":["x"]}`,
			wantErr: "必须是 JSON 对象"},
		{name: "method_capabilities 键域越权", json: manifestWith(`"other.status":"system:read"`),
			wantErr: "必须以插件自身 id 为域"},
		{name: "method_capabilities 动作段含下划线", json: manifestWith(`"p.Bad_Action":"system:read"`),
			wantErr: "动作段"},
		{name: "method_capabilities 动作段以数字开头", json: manifestWith(`"p.1status":"system:read"`),
			wantErr: "动作段"},
		{name: "method_capabilities 值非特权能力", json: manifestWith(`"p.status":"p:read"`),
			wantErr: "必须是 6 项特权能力"},
		{name: "method_capabilities 同域放大（read→admin）", json: manifestWith(`"p.write":"system:admin"`),
			wantErr: "强于插件级声明"},
		{name: "method_capabilities 跨域放大（system→net）", json: manifestWith(`"p.read":"net:read"`),
			wantErr: "未在插件级 capabilities 中声明"},
		{name: "method_capabilities 收窄通过（协议 §3.1.2.1 示例）", json: `{"id":"p",` +
			`"capabilities":["system:admin"],"method_capabilities":{"p.status":"system:read"}}`},
		{name: "method_capabilities 重复键", json: `{"id":"p","capabilities":["system:read"],` +
			`"method_capabilities":{"p.status":"system:read","p.status":"system:read"}}`,
			wantErr: "重复键"},
		{name: "method_capabilities 值不是字符串", json: `{"id":"p","capabilities":["system:read"],` +
			`"method_capabilities":{"p.status":1}}`, wantErr: "值必须是字符串"},
		{
			name: "method_capabilities 恰好 64 条通过",
			json: manifestMap(map[string]any{
				"id":                  "p",
				"capabilities":        []string{"system:read"},
				"method_capabilities": sixtyFour,
			}),
		},
		{
			name: "method_capabilities 65 条拒绝",
			json: manifestMap(map[string]any{
				"id":                  "p",
				"capabilities":        []string{"system:read"},
				"method_capabilities": overMethodCaps,
			}),
			wantErr: "最多 64 条",
		},

		// ---- root_actions ----
		{name: "root_actions 未声明 requires_root", json: `{"id":"p","capabilities":["system:read"],` +
			`"root_actions":[{"id":"status","argv":["ufw","status"],"timeout_s":10}]}`,
			wantErr: "requires_root:true"},
		{name: "root_actions id 重复", json: `{"id":"p","capabilities":["system:read"],"requires_root":true,` +
			`"root_actions":[{"id":"status","argv":["ufw","status"],"timeout_s":10},` +
			`{"id":"status","argv":["nginx","-t"],"timeout_s":10}]}`,
			wantErr: "重复"},
		{name: "root_actions 超过 16 条", json: tooManyActions.String(), wantErr: "最多 16 条"},
		{name: "root_action id 非法", json: `{"id":"p","capabilities":["system:read"],"requires_root":true,` +
			`"root_actions":[{"id":"Bad_ID","argv":["ufw","status"],"timeout_s":10}]}`,
			wantErr: "必须匹配"},
		{name: "root_action 缺失 timeout_s", json: `{"id":"p","capabilities":["system:read"],"requires_root":true,` +
			`"root_actions":[{"id":"status","argv":["ufw","status"]}]}`,
			wantErr: "timeout_s=0"},
		{name: "root_action argv 形状越界", json: `{"id":"p","capabilities":["system:read"],"requires_root":true,` +
			`"root_actions":[{"id":"flush","argv":["iptables","-F"],"timeout_s":10}]}`,
			wantErr: "不在受控形状内"},
		{name: "root_action 追加参数形状越界（声明层无法表达，此处只锁声明）",
			json: `{"id":"p","capabilities":["system:read"],"requires_root":true,` +
				`"root_actions":[{"id":"allow","argv":["ufw","allow"],"timeout_s":10}]}`},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := pluginapitest.ValidateInfoJSON([]byte(testCase.json))
			if testCase.wantErr == "" {
				if err != nil {
					t.Fatalf("期望通过，实际报错：\n%v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("期望报错包含 %q，实际通过", testCase.wantErr)
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("错误不含 %q：\n%v", testCase.wantErr, err)
			}
		})
	}
}

// TestValidateInfoJSONReportsAllProblems 校验汇总语义：一次返回全部违规项。
func TestValidateInfoJSONReportsAllProblems(t *testing.T) {
	const manifest = `{
	  "id": "p",
	  "capabilities": ["p:read"],
	  "method_capabilities": {"p.write": "system:admin"},
	  "root_actions": [{"id": "Bad_ID", "argv": ["ufw", "status"], "timeout_s": 10}]
	}`
	err := pluginapitest.ValidateInfoJSON([]byte(manifest))
	if err == nil {
		t.Fatal("期望报错")
	}
	for _, want := range []string{
		"requires_root:true",     // root_actions 缺 requires_root
		"未在插件级 capabilities 中声明", // 方法级跨域放大
		"root_actions[0]",        // 单条 schema
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("汇总错误缺 %q：\n%v", want, err)
		}
	}
}

// TestValidateInfoFile 覆盖文件入口与错误前缀。
func TestValidateInfoFile(t *testing.T) {
	dir := t.TempDir()
	validPath := filepath.Join(dir, "info.json")
	if err := os.WriteFile(validPath, []byte(validManifest), 0o600); err != nil {
		t.Fatalf("写临时 info.json: %v", err)
	}
	if err := pluginapitest.ValidateInfoFile(validPath); err != nil {
		t.Fatalf("合法文件应通过：%v", err)
	}

	// CheckInfoJSON 是测试适配器的正向路径（负向会 t.Fatalf，不在此断言）。
	pluginapitest.CheckInfoJSON(t, validPath)

	invalidPath := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(invalidPath, []byte(`{"id":"p"}`), 0o600); err != nil {
		t.Fatalf("写临时 bad.json: %v", err)
	}
	err := pluginapitest.ValidateInfoFile(invalidPath)
	if err == nil {
		t.Fatal("缺 capabilities 应报错")
	}
	if !strings.Contains(err.Error(), invalidPath) {
		t.Fatalf("错误应带文件路径：%v", err)
	}
	if !strings.Contains(err.Error(), "capabilities 不能为空") {
		t.Fatalf("错误应含具体原因：%v", err)
	}

	if err := pluginapitest.ValidateInfoFile(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("不存在的文件应报错")
	}
}

// TestValidateInfoJSONProtocolConstants 锁定协议常量（改值属协议变更）。
func TestValidateInfoJSONProtocolConstants(t *testing.T) {
	if pluginapitest.MaxCapabilities != 16 {
		t.Errorf("MaxCapabilities = %d，want 16", pluginapitest.MaxCapabilities)
	}
	if pluginapitest.MaxMethodCapabilities != 64 {
		t.Errorf("MaxMethodCapabilities = %d，want 64", pluginapitest.MaxMethodCapabilities)
	}
	if pluginapitest.MaxRootActions != 16 {
		t.Errorf("MaxRootActions = %d，want 16", pluginapitest.MaxRootActions)
	}
}

// quoteAll 给字符串列表加 JSON 引号。
func quoteAll(values []string) []string {
	quoted := make([]string, len(values))
	for index, value := range values {
		quoted[index] = `"` + value + `"`
	}
	return quoted
}

// manifestMap 把 map 编码成 info.json 文本；测试数据构造用。
func manifestMap(value map[string]any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}
