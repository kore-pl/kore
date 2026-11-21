package config

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

// mapping 展开一个 mapping 节点，记录字段行号，并对未知键记 WARN。
func (p *parser) mapping(n *yaml.Node, path string, known []string) (map[string]*yaml.Node, error) {
	if n == nil {
		return nil, nil
	}
	if n.Kind != yaml.MappingNode {
		return nil, p.typeErr(path, "mapping", n)
	}
	out := make(map[string]*yaml.Node, len(n.Content)/2)
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, val := n.Content[i], n.Content[i+1]
		if key.Kind != yaml.ScalarNode {
			return nil, p.typeErr(path, "字符串键", key)
		}
		full := joinKey(path, key.Value)
		if !contains(known, key.Value) {
			p.warnings = append(p.warnings, p.unknownWarning(full, key.Line, known, path))
			continue
		}
		p.lines[full] = key.Line
		out[key.Value] = val
	}
	return out, nil
}

// unknownWarning 生成未知字段告警，并给出同层级最接近的合法键名。
func (p *parser) unknownWarning(full string, line int, known []string, path string) Warning {
	best, bestDist := "", -1
	for _, key := range known {
		candidate := joinKey(path, key)
		dist := levenshtein(full, candidate)
		if bestDist < 0 || dist < bestDist {
			best, bestDist = candidate, dist
		}
	}
	return Warning{
		Source:     p.source,
		Line:       line,
		Key:        full,
		Message:    "未知字段，已忽略",
		Suggestion: best,
	}
}

// joinKey 拼接字段路径。
func joinKey(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}

// contains 判断字符串是否在闭集合内。
func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// typeErr 生成带文件行号的类型错误。
func (p *parser) typeErr(path, want string, n *yaml.Node) error {
	if path == "" {
		path = "配置根"
	}
	line := 0
	if n != nil {
		line = n.Line
	}
	return fmt.Errorf("%s:%d: %s 期望 %s，实际为 %s", p.source, line, path, want, typeName(n))
}

// typeName 返回节点类型的人类可读名称。
func typeName(n *yaml.Node) string {
	if n == nil {
		return "空"
	}
	switch n.Kind {
	case yaml.MappingNode:
		return "mapping"
	case yaml.SequenceNode:
		return "list"
	case yaml.AliasNode:
		return "alias"
	}
	switch n.Tag {
	case "!!str":
		return "string"
	case "!!int":
		return "int"
	case "!!float":
		return "float"
	case "!!bool":
		return "bool"
	case "!!null":
		return "null"
	}
	return n.Tag
}
