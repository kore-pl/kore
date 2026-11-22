# meta: kind=verification task=oneshot date=2026-11-22 owner=oneshot-verify verdict=PASS repo=kore

## 验证目标与口径
独立 verifier 复验 oneshot 实现，不复用 implementer 结论、不写临时脚本、不跑 loop。
只读源码：oneshot.go（帧侦测+finishOneshot）、manager.go（Start 短路+Ensure 分流）、
registry/validate.go（RuntimeSupported）。所有结论以实际命令退出码与输出为准。

## 证据一：定向测试 7 PASS（无缓存真跑）
命令：`go test -count=1 -run 'TestOneShot|TestLifecycle' -v ./internal/core/registry/ ./internal/core/supervisor/`
退出码 **0**。
```
registry:   TestOneShotCatalogEnable PASS; TestLifecycleRuntimeSupported PASS
supervisor: TestOneShotEnableNoProcess PASS; TestOneShotInvokeStarts PASS
            TestOneShotProcessGoneAfterInvoke PASS; TestOneShotSecondInvokeRespawns PASS
            TestOneShotDoesNotAffectLazyResident PASS
```
合计 7/7 PASS。首轮 `go test -run ...`（未加 -count=1）亦 7 PASS 但带 `(cached)`，
故补强制无缓存复跑，排除缓存假绿。

## 证据二：全量测试 + make check（10 段）
`go test -timeout 200s ./...` 退出码 **0**，12 包全 ok（cmd/kored、core/*、platform）。
`make check` 退出码 **0**，10/10 段全绿：docs-check / 依赖白名单 / 薄壳边界 / repo-check /
canonical-check / log-check / wt-check / oss-check / case-check / frontend 首屏；0 fail。

## 证据三：六项代码核对
1. **enable 后无进程（非 mock）**：`Start` 对 oneshot 走短路 return nil（manager.go:77-83），
   不调 `start()`。`TestOneShotEnableNoProcess` 断言 StateStopped/PID=0、socket 不存在。
   插件二进制由 `go build` 真编译（helpers_test.go:38），非 mock。PASS。
2. **invoke 完成进程真退出**：`invokeOnce` 读 response 帧后，`oneshotConn.observe`
   解析到 `*pluginapi.Response` → `once.Do(finish)` → 异步 `m.Stop`。
   `TestOneShotProcessGoneAfterInvoke` 用 `/proc/<pid>` 判活（lifecycle_test.go:133-139），
   断言 `/proc` 消失 + StateStopped + PID=0 + socket 清理。PASS（真 /proc 证据）。
3. **二次 invoke 重新拉起（不同 PID）**：`TestOneShotSecondInvokeRespawns` 断言
   after.PID>0 && after.PID!=before.PID && /proc 存活（oneshot_test.go:83-85），
   完成后再次 /proc 消失。PASS。
4. **串行令牌容量 1（并发安全）**：`instance.oneshotIdle` 为 `make(chan struct{},1)`
   预填 1（instance.go:75-76）；`ensureOneshot` 起始 `<-inst.oneshotIdle` 取令牌
   （oneshot.go:19），`finishOneshot` 归还（oneshot.go:59），错误路径全部归还
   （oneshot.go:26/35/42）。并发 invoke 第二路阻塞至令牌归还，上限=1。PASS。
5. **零 NewTicker/AfterFunc**：全仓 grep 仅 `handlers_audit_test.go` 的禁用清单字符串
   与 supervisor 两处请求级 `time.NewTimer`（view.go:50 / idle.go:12，均 defer Stop，
   符合 G-19）。生产包 `time.NewTicker`/`time.AfterFunc`/`time.Tick(` **零命中**。PASS。
6. **bus/ 零改动**：`git diff --name-only` 与 `git status --short` 均无 `internal/core/bus/`
   路径；改动集中在 registry/ + supervisor/。PASS。

## 证据四：反向核（帧侦测去掉测试是否会红）
判断：**会红，证据强度充分**。依据（不改代码，逻辑推演）：
- `oneshotConn` 回收触发有两条：`observe` 读帧命中 response，及 `Close` 里 `once.Do(finish)`。
- `invokeOnce`（oneshot_helpers_test.go:97-120）只写 request + 读一帧 response，
  **全程不调用 `conn.Close()`**；真实 bus 路径亦由帧边界感知，不依赖调用方 Close。
- 去掉帧侦测后仅剩 Close 路径，而测试与 bus 都不触发 Close → 进程不回收：
  `TestOneShotProcessGoneAfterInvoke` 的 `waitStopped`（3s）超时失败；
  `TestOneShotSecondInvokeRespawns` 因令牌未归还，第二次 `Ensure` 永久阻塞至超时。
- 三个核心测试（ProcessGoneAfterInvoke / SecondInvokeRespawns / DoesNotAffectLazyResident）
  直接锚定"调用完成即回收"，帧侦测被移除必然转红——测试对实现有真实约束力，非空跑。

## VERDICT
**PASS**。7/7 定向测试、全量 12 包、make check 10/10 段全绿；六项代码核对全部成立，
其中进程退出用 `/proc` 真证据、插件用真二进制；帧侦测去除的反向核判定测试会红，
证据链闭环。无功能缺陷，无阻断项。

## 分级
- 阻断：无。
- 记录：首轮定向测试带 `(cached)`，已用 `-count=1` 强制复跑消除；非缺陷，仅记过程。
- 风险：异步回收（`finishOneshot` 起 goroutine）使"帧读到→进程消失"存在毫秒级窗口，
  测试用 `waitStopped`（≤3s）吸收，符合设计（bus 回复与回收并行），不构成问题。

报告行数：68（实测 wc -l；满足 ≤80 行要求）
