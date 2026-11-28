//go:build !race

package main

// fdHygieneTestSkipReason 为空表示当前构建下 fd 卫生子进程测试可执行。
// -race 构建见 fd_hygiene_racetag_race.go：race runtime 的 netpoll 与 fd 清理冲突。
const fdHygieneTestSkipReason = ""
