package installer_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/kore-project/kore/internal/core/installer"
)

// TestInstallRejectsTraversal 覆盖验收用例 3：tar 穿越（相对/绝对）拒绝且无残留。
func TestInstallRejectsTraversal(t *testing.T) {
	cases := map[string]string{
		"相对穿越": "../evil",
		"绝对路径": "/tmp/evil",
		"嵌套穿越": "web/../../evil",
	}
	for name, entryName := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, installer.Limits{})
			entries := append(validEntries(t, nil), fileEntry(entryName, "evil"))
			pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", entries)
			if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrInvalid) {
				t.Fatalf("穿越条目 %q 应返回 ErrInvalid，实际: %v", entryName, err)
			}
			f.assertNoResidue(t, "site", "0.1.0")
		})
	}
}

// TestInstallRejectsSymlink 验证符号链接条目一律拒绝（不跟随、不落盘）。
func TestInstallRejectsSymlink(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	entries := append(validEntries(t, nil), symlinkEntry("bin/evil", "/etc/passwd"))
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", entries)
	if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrInvalid) {
		t.Fatalf("符号链接应被拒绝，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
}

// TestInstallRejectsLimits 覆盖验收用例 4：文件数/解包总量/单文件超限均拒绝。
func TestInstallRejectsLimits(t *testing.T) {
	valid := validEntries(t, nil)
	cases := []struct {
		name    string
		limits  installer.Limits
		entries []tarEntry
	}{
		{"文件数超限", installer.Limits{MaxFiles: 2}, valid},
		{"解包总量超限", installer.Limits{MaxExtractBytes: 50}, valid},
		{"单文件超限", installer.Limits{MaxFileBytes: 32}, valid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, tc.limits)
			pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", tc.entries)
			if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrInvalid) {
				t.Fatalf("%s 应返回 ErrInvalid，实际: %v", tc.name, err)
			}
			f.assertNoResidue(t, "site", "0.1.0")
		})
	}
}

// TestInstallRejectsRequiresKore 覆盖验收用例 5：内核区间不满足返回 ErrUnsupported。
func TestInstallRejectsRequiresKore(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	entries := validEntries(t, map[string]any{"requires_kore": ">=9.0.0 <10.0.0"})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", entries)
	if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrUnsupported) {
		t.Fatalf("区间不满足应返回 ErrUnsupported，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
	f.requireNoKey(t, "plugins", "site")
}

// TestInstallRejectsSHA256SUMSMismatch 验证包内 SHA256SUMS 与文件实际哈希不符时拒绝。
func TestInstallRejectsSHA256SUMSMismatch(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	sums := strings.Repeat("0", 64) + "  bin/site\n"
	entries := append(validEntries(t, nil), fileEntry("SHA256SUMS", sums))
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", entries)
	if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrChecksum) {
		t.Fatalf("SHA256SUMS 不符应返回 ErrChecksum，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
}

// TestInstallRejectsNameMismatch 验证 info.json 的 id/version 必须与包名一致。
func TestInstallRejectsNameMismatch(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	entries := validEntries(t, map[string]any{"id": "other", "entry": "bin/other", "capabilities": []string{"other:read"}})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", entries)
	if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrInvalid) {
		t.Fatalf("id 与包名不一致应返回 ErrInvalid，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
}
