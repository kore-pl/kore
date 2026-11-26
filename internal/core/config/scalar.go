package config

import (
	"fmt"
	"time"

	"gopkg.in/yaml.v3"
)

// str 读取标量字符串；null 视为空串。
func (p *parser) str(n *yaml.Node, path string) (string, error) {
	if n == nil {
		return "", nil
	}
	if n.Kind != yaml.ScalarNode || (n.Tag != "!!str" && n.Tag != "!!null") {
		return "", p.typeErr(path, "string", n)
	}
	return n.Value, nil
}

// boolean 读取布尔标量；带引号的 "true" 视为类型错误。
func (p *parser) boolean(n *yaml.Node, path string) (bool, error) {
	if n == nil {
		return false, nil
	}
	if n.Kind != yaml.ScalarNode || n.Tag != "!!bool" {
		return false, p.typeErr(path, "bool", n)
	}
	var value bool
	if err := n.Decode(&value); err != nil {
		return false, fmt.Errorf("%s:%d: %s: %v", p.source, n.Line, path, err)
	}
	return value, nil
}

// integer 读取整数标量。
func (p *parser) integer(n *yaml.Node, path string) (int, error) {
	if n == nil {
		return 0, nil
	}
	if n.Kind != yaml.ScalarNode || n.Tag != "!!int" {
		return 0, p.typeErr(path, "int", n)
	}
	var value int
	if err := n.Decode(&value); err != nil {
		return 0, fmt.Errorf("%s:%d: %s: %v", p.source, n.Line, path, err)
	}
	return value, nil
}

// integer64 读取 int64 整数标量（用于 backup.max_disk_bytes 这类字节数）。
func (p *parser) integer64(n *yaml.Node, path string) (int64, error) {
	if n == nil {
		return 0, nil
	}
	if n.Kind != yaml.ScalarNode || n.Tag != "!!int" {
		return 0, p.typeErr(path, "int64", n)
	}
	var value int64
	if err := n.Decode(&value); err != nil {
		return 0, fmt.Errorf("%s:%d: %s: %v", p.source, n.Line, path, err)
	}
	return value, nil
}

// duration 读取 Go duration 串（如 "12h"）；整数按类型错误处理。
func (p *parser) duration(n *yaml.Node, path string) (time.Duration, error) {
	if n == nil {
		return 0, nil
	}
	if n.Kind != yaml.ScalarNode || n.Tag != "!!str" {
		return 0, p.typeErr(path, `duration（如 "12h"）`, n)
	}
	value, err := time.ParseDuration(n.Value)
	if err != nil {
		return 0, fmt.Errorf("%s:%d: %s 不是合法 duration（%q）", p.source, n.Line, path, n.Value)
	}
	return value, nil
}

// strings 读取字符串数组。
func (p *parser) strings(n *yaml.Node, path string) ([]string, error) {
	if n == nil {
		return nil, nil
	}
	if n.Kind != yaml.SequenceNode {
		return nil, p.typeErr(path, "string 列表", n)
	}
	out := make([]string, 0, len(n.Content))
	for _, item := range n.Content {
		if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
			return nil, p.typeErr(path, "string 列表元素", item)
		}
		out = append(out, item.Value)
	}
	return out, nil
}
