package installer_test

import (
	"errors"
	"testing"

	"github.com/kore-project/kore/internal/core/installer"
)

// TestCheckRequiresKore 覆盖区间语义：下界含、上界不含、只写下界、非法写法。
func TestCheckRequiresKore(t *testing.T) {
	cases := []struct {
		name    string
		expr    string
		kore    string
		wantErr error
	}{
		{"区间内", ">=0.1.0 <0.2.0", "0.1.0", nil},
		{"下界含", ">=0.1.0 <0.2.0", "0.1.0", nil},
		{"上界不含", ">=0.1.0 <0.2.0", "0.2.0", installer.ErrUnsupported},
		{"低于下界", ">=0.1.0 <0.2.0", "0.0.9", installer.ErrUnsupported},
		{"仅下界满足", ">=0.1.0", "1.0.0", nil},
		{"仅下界不满足", ">=0.1.0", "0.0.9", installer.ErrUnsupported},
		{"不支持 ^", "^0.1.0", "0.1.0", installer.ErrInvalid},
		{"不支持 ||", "0.1.0 || 0.2.0", "0.1.0", installer.ErrInvalid},
		{"缺运算符", "0.1.0 <0.2.0", "0.1.0", installer.ErrInvalid},
		{"上界用了 <=", ">=0.1.0 <=0.2.0", "0.1.0", installer.ErrInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := installer.CheckRequiresKore(tc.expr, tc.kore)
			if tc.wantErr == nil && err != nil {
				t.Fatalf("应通过，实际: %v", err)
			}
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("应返回 %v，实际: %v", tc.wantErr, err)
			}
		})
	}
}

// TestCheckRequiresKorePrerelease 验证 kore 含预发布号时一律不参与匹配。
func TestCheckRequiresKorePrerelease(t *testing.T) {
	err := installer.CheckRequiresKore(">=0.1.0 <0.2.0", "0.2.0-rc.1")
	if !errors.Is(err, installer.ErrUnsupported) {
		t.Fatalf("预发布 kore 应返回 ErrUnsupported，实际: %v", err)
	}
}
