package market

// M3 批量编排的只读计算层单测：筛选 / 依赖序 / 幂等 / 环检测 / 验签门。
// 这些用例覆盖任务卡要求的「幂等/排序单测」，且全为内存/临时目录，不联网、不安装。

import (
	"crypto/ed25519"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// batchIndex 三条待更新项：site 依赖 echo（依赖须先于 site），waf 独立。
const batchIndexJSON = `{
  "schema_version": 1,
  "plugins": [
    {"id":"site","name":"Site","version":"0.2.0","depth_level":"production","lifecycle":"resident",
     "size_bytes":100,"sha256":"1111111111111111111111111111111111111111111111111111111111111111",
     "download_url":"https://example.invalid/site-0.2.0.tar.gz","requires_kore":">=0.1.0 <0.2.0",
     "depends_on":["echo"],"conflicts":[],"scenario_tags":["web"]},
    {"id":"waf","name":"Waf","version":"0.3.0","depth_level":"production","lifecycle":"resident",
     "size_bytes":100,"sha256":"2222222222222222222222222222222222222222222222222222222222222222",
     "download_url":"https://example.invalid/waf-0.3.0.tar.gz","requires_kore":">=0.1.0 <0.2.0",
     "depends_on":[],"conflicts":[],"scenario_tags":["ops"]},
    {"id":"echo","name":"Echo","version":"0.1.2","depth_level":"basic","lifecycle":"resident",
     "size_bytes":100,"sha256":"3333333333333333333333333333333333333333333333333333333333333333",
     "download_url":"https://example.invalid/echo-0.1.2.tar.gz","requires_kore":">=0.1.0 <0.2.0",
     "depends_on":[],"conflicts":[],"scenario_tags":["ops"]}
  ]
}`

// TestPendingFromIndexFiltersAndOrders 验证：
//   - 未安装（首次安装）不算待更新；
//   - 版本一致幂等跳过；
//   - 其余按依赖序排列（echo 在 site 之前），同层按 id 升序。
func TestPendingFromIndexFiltersAndOrders(t *testing.T) {
	index, err := parseIndex([]byte(batchIndexJSON))
	if err != nil {
		t.Fatalf("解析测试索引失败: %v", err)
	}
	installed := map[string]string{
		"site": "0.1.9", // 需更新
		"waf":  "0.3.0", // 已是目标版本 → 跳过
		"echo": "0.1.1", // 需更新且是 site 的依赖
		// "new-plugin" 不在索引里，忽略
	}
	got, err := pendingFromIndex(index, installed)
	if err != nil {
		t.Fatalf("计算待更新项失败: %v", err)
	}
	ids := make([]string, 0, len(got))
	for _, p := range got {
		ids = append(ids, p.ID)
	}
	want := []string{"echo", "site"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("待更新项/依赖序不符: got=%v want=%v", ids, want)
	}
	if got[0].PreviousVersion != "0.1.1" || got[0].Version != "0.1.2" {
		t.Fatalf("echo 版本快照不符: %+v", got[0])
	}
	if got[1].DependsOn[0] != "echo" {
		t.Fatalf("site 依赖未透传: %+v", got[1])
	}
}

// TestPendingFromIndexIdempotent 对同一输入重复计算得到完全一致的结果（幂等）。
func TestPendingFromIndexIdempotent(t *testing.T) {
	index, err := parseIndex([]byte(batchIndexJSON))
	if err != nil {
		t.Fatalf("解析测试索引失败: %v", err)
	}
	installed := map[string]string{"site": "0.1.9", "waf": "0.2.0", "echo": "0.1.1"}
	first, err := pendingFromIndex(index, installed)
	if err != nil {
		t.Fatalf("首次计算失败: %v", err)
	}
	second, err := pendingFromIndex(index, installed)
	if err != nil {
		t.Fatalf("重复计算失败: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("重复计算不一致（非幂等）:\nfirst=%+v\nsecond=%+v", first, second)
	}
}

// TestOrderPendingStableOrder 同层（无依赖）按 id 升序，结果确定。
func TestOrderPendingStableOrder(t *testing.T) {
	index, err := parseIndex([]byte(batchIndexJSON))
	if err != nil {
		t.Fatalf("解析测试索引失败: %v", err)
	}
	installed := map[string]string{"waf": "0.1.0", "echo": "0.1.1", "site": "0.1.9"}
	got, err := pendingFromIndex(index, installed)
	if err != nil {
		t.Fatalf("排序失败: %v", err)
	}
	ids := make([]string, 0, len(got))
	for _, p := range got {
		ids = append(ids, p.ID)
	}
	// 拓扑序：初始入队 {echo,waf}（按 id 升序）；echo 出队后 site 依赖解锁，
	// 立即入队并重排队列 → site 先于 waf 出队。依赖恒在被依赖者之前，
	// 且同一步的候选按 id 升序，结果确定（幂等）。
	want := []string{"echo", "site", "waf"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("拓扑排序不符: got=%v want=%v", ids, want)
	}
}

// TestPendingFromIndexCycleRejected 循环依赖返回 E_INVALID（整批规划失败，不进入安装阶段）。
func TestPendingFromIndexCycleRejected(t *testing.T) {
	index := Index{SchemaVersion: 1, Plugins: []Plugin{
		{ID: "a", Version: "0.2.0", SHA256: strings.Repeat("a", 64), DepthLevel: "basic", Lifecycle: "resident", DependsOn: []string{"b"}},
		{ID: "b", Version: "0.2.0", SHA256: strings.Repeat("b", 64), DepthLevel: "basic", Lifecycle: "resident", DependsOn: []string{"a"}},
	}}
	_, err := pendingFromIndex(index, map[string]string{"a": "0.1.0", "b": "0.1.0"})
	if err == nil || !strings.Contains(err.Error(), "循环依赖") {
		t.Fatalf("循环依赖应被拒，实际 %v", err)
	}
}

// TestPendingFromIndexSelfDependencyRejected 自依赖返回 E_INVALID。
func TestPendingFromIndexSelfDependencyRejected(t *testing.T) {
	index := Index{SchemaVersion: 1, Plugins: []Plugin{
		{ID: "a", Version: "0.2.0", SHA256: strings.Repeat("a", 64), DepthLevel: "basic", Lifecycle: "resident", DependsOn: []string{"a"}},
	}}
	_, err := pendingFromIndex(index, map[string]string{"a": "0.1.0"})
	if err == nil || !strings.Contains(err.Error(), "依赖自身") {
		t.Fatalf("自依赖应被拒，实际 %v", err)
	}
}

// TestPendingUpdatesSignedIndex 端到端验证 PendingUpdates 走强制验签门：
// 注入配对公钥签名的索引可读；签名被篡改则拒绝（不返回任何数据）。
func TestPendingUpdatesSignedIndex(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(batchIndexJSON)
	sig := ed25519.Sign(priv, data)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugins.json.sig"), sig, 0o600); err != nil {
		t.Fatal(err)
	}
	svc := New(Options{IndexDir: dir})
	svc.verifyKey = pub

	got, err := svc.PendingUpdates(map[string]string{"echo": "0.1.1"})
	if err != nil {
		t.Fatalf("验签通过后应算出待更新项: %v", err)
	}
	if len(got) != 1 || got[0].ID != "echo" {
		t.Fatalf("待更新项不符: %+v", got)
	}
	if got[0].SHA256 != strings.Repeat("3", 64) || got[0].DownloadURL == "" {
		t.Fatalf("索引字段未透传: %+v", got[0])
	}

	// 篡改正文 → 验签失败 → 整批规划拒绝（零数据）。
	bad := []byte(strings.Replace(batchIndexJSON, "0.1.2", "9.9.9", 1))
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.PendingUpdates(map[string]string{"echo": "0.1.1"}); err == nil {
		t.Fatal("篡改索引必须被验签门拒绝")
	}
}

// TestBuiltinKeyHexStillValid 守卫：本文件没有改动内置公钥常量（防误伤验签信任根）。
func TestBuiltinKeyHexStillValid(t *testing.T) {
	b, err := hex.DecodeString(IndexPublicKeyHex)
	if err != nil || len(b) != ed25519.PublicKeySize {
		t.Fatalf("内置公钥非法: %v len=%d", err, len(b))
	}
}
