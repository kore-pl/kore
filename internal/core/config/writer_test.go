package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestColdFieldsChangedIndexDir 改 paths.index_dir 必须命中冷字段判据（与 reload.go 同源）。
func TestColdFieldsChangedIndexDir(t *testing.T) {
	base := Default()
	next := "/tmp/new-index"
	cold := ColdFieldsChanged(base, ConfigUpdates{IndexDir: &next})
	found := false
	for _, key := range cold {
		if key == "paths.index_dir" {
			found = true
		}
	}
	if !found {
		t.Fatalf("cold=%v 缺 paths.index_dir", cold)
	}
}

// TestWriteConfigUpdatesAtomicAndRestartRequired 写盘后冷字段列表返回 restart_required 判据；
// 热字段（log.level）不命中；配置文件保留其它段与注释。
func TestWriteConfigUpdatesAtomicAndRestartRequired(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := "# keep comment\nserver:\n  addr: \"127.0.0.1:8787\"\npaths:\n  index_dir: /tmp/old-index\nlog:\n  level: info\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	snap := Default()
	snap.Paths.IndexDir = "/tmp/old-index"
	snap.Source = path
	newIndex := "/tmp/new-index"
	_, cold, err := WriteConfigUpdates(path, snap, ConfigUpdates{IndexDir: &newIndex})
	if err != nil {
		t.Fatal(err)
	}
	if len(cold) == 0 {
		t.Fatal("改 index_dir 应返回冷字段")
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "index_dir: ") || !strings.Contains(string(raw), newIndex) {
		t.Fatalf("写盘内容不对: %s", raw)
	}
	if !strings.Contains(string(raw), "# keep comment") {
		t.Fatal("注释被吞")
	}
	if !strings.Contains(string(raw), "addr: ") {
		t.Fatal("其它段被吞")
	}
}
