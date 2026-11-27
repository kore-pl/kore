package auth

// API token 可选来源绑定的配置/规范化测试（DESIGN-TOKEN-IP-BIND §6.2）。
// 重点两条：①外部输入合法性/上限/归一；②LastUsedAt 整条写回不得抹掉绑定。
import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

func TestNormalizeTokenCIDRs(t *testing.T) {
	cases := []struct {
		name    string
		in      []string
		want    []string
		wantErr bool
	}{
		{name: "nil=不限制", in: nil, want: nil},
		{name: "空表=不限制", in: []string{}, want: nil},
		{name: "IPv4 带主机位归一", in: []string{"192.168.1.5/24"}, want: []string{"192.168.1.0/24"}},
		{name: "IPv6 前缀", in: []string{"2001:db8::1/32"}, want: []string{"2001:db8::/32"}},
		{name: "裸 IPv4 补32", in: []string{"203.0.113.7"}, want: []string{"203.0.113.7/32"}},
		{name: "裸 IPv6 补128", in: []string{"2001:db8::7"}, want: []string{"2001:db8::7/128"}},
		{name: "trim+去重+排序", in: []string{" 203.0.113.7 ", "192.168.1.5/24", "192.168.1.0/24"},
			want: []string{"192.168.1.0/24", "203.0.113.7/32"}},
		{name: "IPv4-mapped 前缀归一", in: []string{"::ffff:192.0.2.1/128"}, want: []string{"192.0.2.1/32"}},
		{name: "IPv4-mapped 裸 IP 归一", in: []string{"::ffff:192.0.2.1"}, want: []string{"192.0.2.1/32"}},
		{name: "非法字符串", in: []string{"not-an-ip"}, wantErr: true},
		{name: "非法掩码", in: []string{"192.0.2.1/33"}, wantErr: true},
		{name: "IPv4 全网段", in: []string{"0.0.0.0/0"}, wantErr: true},
		{name: "IPv6 全网段", in: []string{"::/0"}, wantErr: true},
		{name: "zone 拒绝", in: []string{"fe80::1%eth0"}, wantErr: true},
		{name: "zone 前缀拒绝", in: []string{"fe80::1%eth0/64"}, wantErr: true},
		{name: "空元素拒绝", in: []string{"203.0.113.7", "  "}, wantErr: true},
		{name: "单条 >64 字节", in: []string{strings.Repeat("a", 65)}, wantErr: true},
		{name: "超过 16 条", in: make([]string, 17), wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeTokenCIDRs(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

// 关键陷阱：ValidateToken 的 LastUsedAt 节流会把整条记录重新 json.Marshal 写回，
// 绑定字段必须随记录一起存活，否则一次请求就把绑定静默抹掉。
func TestTokenCIDRSurvivesLastUsedWriteBack(t *testing.T) {
	sec := newTestSecurity(t)
	plain, rec, err := sec.CreateTokenWithCIDRs("ci", "read", time.Hour, []string{"203.0.113.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	key := tokenKeyPrefix + rec.ID
	if err := sec.store.Update(func(tx *store.Tx) error {
		raw, err := tx.Get(securityBucket, key)
		if err != nil {
			return err
		}
		var stored APITokenRecord
		if err := json.Unmarshal(raw, &stored); err != nil {
			return err
		}
		stored.LastUsedAt = "2020-01-01T00:00:00Z" // 强制触发节流写回
		data, err := json.Marshal(stored)
		if err != nil {
			return err
		}
		return tx.Put(securityBucket, key, data)
	}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := sec.ValidateToken(plain)
	if err != nil || !ok {
		t.Fatalf("ValidateToken = %+v,%v,%v", got, ok, err)
	}
	if !reflect.DeepEqual(got.AllowedCIDRs, []string{"203.0.113.0/24"}) {
		t.Fatalf("写回后绑定丢失: %#v", got.AllowedCIDRs)
	}
	var persisted APITokenRecord
	if err := sec.loadKey(key, &persisted); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(persisted.AllowedCIDRs, []string{"203.0.113.0/24"}) {
		t.Fatalf("库中绑定丢失: %#v", persisted.AllowedCIDRs)
	}
}

// 存量 token（JSON 无 allowed_cidrs 字段）读为 nil = 不限制，兼容零改动。
func TestLegacyTokenRecordNoBinding(t *testing.T) {
	sec := newTestSecurity(t)
	plain, rec, err := sec.CreateToken("legacy", "read", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := sec.store.View(func(tx *store.Tx) error {
		var e error
		raw, e = tx.Get(securityBucket, tokenKeyPrefix+rec.ID)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "allowed_cidrs") {
		t.Fatalf("无绑定的旧记录不应写 allowed_cidrs 字段: %s", raw)
	}
	got, ok, err := sec.ValidateToken(plain)
	if err != nil || !ok || got.AllowedCIDRs != nil {
		t.Fatalf("旧记录应按不限制处理: %+v,%v,%v", got, ok, err)
	}
}

// 更新三态：缺省不改 / 清空 / 替换；不存在 id 与非法 CIDR 报错。
func TestUpdateTokenCIDRs(t *testing.T) {
	sec := newTestSecurity(t)
	plain, rec, err := sec.CreateTokenWithCIDRs("ci", "read", time.Hour, []string{"203.0.113.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	// 缺省：不改。
	view, err := sec.UpdateTokenCIDRs(rec.ID, nil)
	if err != nil || !reflect.DeepEqual(view.AllowedCIDRs, []string{"203.0.113.0/24"}) {
		t.Fatalf("缺省不改失败: %+v, %v", view, err)
	}
	// 替换：裸 IP 补 /32。
	set := []string{"198.51.100.7"}
	view, err = sec.UpdateTokenCIDRs(rec.ID, &set)
	if err != nil || !reflect.DeepEqual(view.AllowedCIDRs, []string{"198.51.100.7/32"}) {
		t.Fatalf("替换失败: %+v, %v", view, err)
	}
	got, ok, err := sec.ValidateToken(plain)
	if err != nil || !ok || !reflect.DeepEqual(got.AllowedCIDRs, []string{"198.51.100.7/32"}) {
		t.Fatalf("替换后 ValidateToken 未即时生效: %+v,%v,%v", got, ok, err)
	}
	// 清空：nil = 不限制。
	empty := []string{}
	view, err = sec.UpdateTokenCIDRs(rec.ID, &empty)
	if err != nil || len(view.AllowedCIDRs) != 0 {
		t.Fatalf("清空失败: %+v, %v", view, err)
	}
	got, _, _ = sec.ValidateToken(plain)
	if len(got.AllowedCIDRs) != 0 {
		t.Fatalf("清空后仍绑定: %#v", got.AllowedCIDRs)
	}
	// 不存在 id。
	if _, err := sec.UpdateTokenCIDRs("deadbeef", &set); err == nil {
		t.Fatal("不存在的 id 应报错")
	}
	// 非法 CIDR 不改变既有绑定。
	bad := []string{"::/0"}
	if _, err := sec.UpdateTokenCIDRs(rec.ID, &bad); err == nil {
		t.Fatal("非法 CIDR 应报错")
	}
	got, _, _ = sec.ValidateToken(plain)
	if len(got.AllowedCIDRs) != 0 {
		t.Fatalf("非法更新不应改写记录: %#v", got.AllowedCIDRs)
	}
	// 旧记录合并读取（ListTokens 回显同一字段）。
	views, err := sec.ListTokens()
	if err != nil || len(views) != 1 || len(views[0].AllowedCIDRs) != 0 {
		t.Fatalf("ListTokens = %+v,%v", views, err)
	}
}

// 防止误用 store 路径：UpdateTokenCIDRs 只接受合法 id（与 RevokeToken 同口径）。
func TestUpdateTokenCIDRsRejectsBadID(t *testing.T) {
	sec := newTestSecurity(t)
	for _, id := range []string{"", "../x", "a/b", `a\b`, "a.b"} {
		if _, err := sec.UpdateTokenCIDRs(id, nil); err == nil {
			t.Fatalf("id %q 应被拒绝", id)
		}
	}
}
