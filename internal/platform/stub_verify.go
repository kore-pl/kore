//go:build !linux

package platform

import "os"

// VerifyOwner 在非 Linux 上返回 ErrUnsupported：Tier B 没有可信的 uid/gid 语义，
// 不得伪称已完成属主复核（降级必须显式，调用方读到错误即拒绝写入）。
func VerifyOwner(string, string, string, os.FileMode) error { return ErrUnsupported }
