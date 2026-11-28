//go:build race

package main

// -race 构建下 race runtime 在测试进程启动前已把 netpoll epoll 绑在 fd3，
// closeInheritedFDs 会在子进程关掉它导致 `runtime: netpoll failed` fatal。
// fd 卫生真实路径（生产 main）不是 race 构建，60s 隔离实例 + 非 race go test
// 已覆盖其正确性与网络可用性；race 构建跳过子进程测试并在此说明原因。
const fdHygieneTestSkipReason = "race runtime 预占 netpoll fd，子进程 fd 清理不适用（-race 下由 make check 19/21 段其余用例覆盖）"
