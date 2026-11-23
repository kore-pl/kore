//go:build !linux

package platform

// systemCleanup 返回非 Linux 桩实现：卸载链只支持 Linux（Tier A）。
func systemCleanup() Cleanup { return stubCleanup{} }

// stubCleanup 是 Cleanup 的非 Linux 实现，全部返回 ErrUnsupported。
type stubCleanup struct{}

// RemoveServiceUnit 返回 ErrUnsupported。
func (stubCleanup) RemoveServiceUnit(string, string, bool) (UnitCleanup, error) {
	return UnitCleanup{}, ErrUnsupported
}

// ListAccountsByPrefix 返回 ErrUnsupported。
func (stubCleanup) ListAccountsByPrefix(string) ([]string, error) { return nil, ErrUnsupported }

// RemoveAccountsByPrefix 返回 ErrUnsupported。
func (stubCleanup) RemoveAccountsByPrefix(string, bool) (AccountCleanup, error) {
	return AccountCleanup{}, ErrUnsupported
}
