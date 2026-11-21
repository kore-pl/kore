//go:build !linux

package platform

// New 在非 Linux 平台返回 ErrUnsupported（Tier B 实现归 M2/M3，M1 只要求交叉编译通过）。
func New(Config) (*Platform, error) { return nil, ErrUnsupported }
