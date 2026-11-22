package market

import (
	"fmt"
	"regexp"
)

var (
	idPattern     = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// validateIndex 校验索引结构：schema_version、id 唯一、sha256 格式、depth/lifecycle 取值。
func validateIndex(index *Index) error {
	seen := make(map[string]bool, len(index.Plugins))
	for i := range index.Plugins {
		p := &index.Plugins[i]
		if !idPattern.MatchString(p.ID) {
			return protocolError("E_INVALID", fmt.Sprintf("plugins[%d].id 非法: %s", i, p.ID))
		}
		if seen[p.ID] {
			return protocolError("E_INVALID", "索引 id 重复: "+p.ID)
		}
		seen[p.ID] = true
		if !sha256Pattern.MatchString(p.SHA256) {
			return protocolError("E_INVALID", fmt.Sprintf("%s.sha256 非 64 位小写 hex", p.ID))
		}
		if p.DepthLevel != "production" && p.DepthLevel != "basic" {
			return protocolError("E_INVALID", fmt.Sprintf("%s.depth_level 非法", p.ID))
		}
		if p.Lifecycle != "resident" && p.Lifecycle != "lazy" && p.Lifecycle != "oneshot" {
			return protocolError("E_INVALID", fmt.Sprintf("%s.lifecycle 非法", p.ID))
		}
	}
	return nil
}
