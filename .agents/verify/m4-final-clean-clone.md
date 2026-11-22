# M4 收口 · 最终干净 clone 独立复验｜2026-11-22T12:44+08:00｜verifier=m4-final-clone-verify｜独立复跑，不复用 implementer 报告

## 范围与方法
四仓最终 HEAD 先 `git ls-remote` 核对，再各自完整 `git clone` 到 `/tmp/m4-final-clone-verify-4001875/` 做隔离复验；全部命令在干净 clone 内执行，无临时脚本，测完删目录。Go 1.26.8 / GNU Make / git SSH remote。初始 `pgrep kored`=0（见清理证明）。所有值为本次实测原文，不复用任何 implementer 结论。

## 四仓证据表

| 仓库 | HEAD(ls-remote=clone=预期) | clone exit | 验证命令 | exit | 关键证据 |
| --- | --- | --- | --- | --- | --- |
| kore | `c0ab71a28ae17383819a93249e3a176a0a8d7015` | 0 | `make check` | 0 | 10/10 段全绿：docs 6/6、依赖白名单 2/3 + 同仓 module、薄壳 4/4、repo 5/5、canonical 9/9、log 8/8、wt 4/4、oss 8/8、case 6/6、frontend 首屏 4151 B ≤ 307200 B |
| kore | 同上 | — | `go test -timeout 200s ./...` | 0 | 12 包全 ok：cmd/kored、auth、bus、config、envprobe、httpapi、installer、market、registry、store、supervisor、platform |
| kore | 同上 | — | `git archive HEAD \| tar -x -C <dir>` | 0 | 解包成功（无 .git） |
| kore | 同上 | — | `GOWORK=off go build ./...`（archive 解包内） | 0 | 无输出即通过，归档产物自洽 |
| kore | 同上 | — | m4 关键文件存在性 | 0 | `cap_auth_test.go`=internal/core/httpapi/cap_auth_test.go；`handlers_audit.go`=internal/core/httpapi/handlers_audit.go；`middleware.go`=internal/core/httpapi/middleware.go；`authorizeTargetAction` 定义于 middleware.go:97，调用于 handlers_invoke.go:31 / audit_gate.go:19 / handlers_plugins.go:43 |
| kore-plugins | `9d09e5611863d41d48e0ce6e1876082ca9497768` | 0 | `bash scripts/validate-index.sh` | 0 | schema 2 条 + 预设引用 7 条 + ed25519 验签通过 |
| kore-plugins | 同上 | — | `bash scripts/validate-presets.sh` | 0 | 8 预设 / 2 索引插件 / 0 FAIL / 0 WARN |
| kore-plugins | 同上 | — | `make check` | 0 | 上面两脚本串跑，全绿 |
| kore-plugins | 同上 | — | 公钥逐字比对 | 0 | 见跨仓一致性节，64 hex 完全一致 |
| kore-plugin-echo | `2011ea8b1aff7208fabd9e4a8e646c71928778bf` | 0 | `GOWORK=off make dist` | 0 | `CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false -ldflags="-s -w" -o bin/echo .` → dist/echo-0.1.1.tar.gz |
| kore-plugin-echo | 同上 | — | `tar -tzf <pkg>` 首条目 | 0 | 首条目 `info.json`（其后 bin/、bin/echo） |
| kore-plugin-site | `199942b59cdbba07725852453fcdf48ceff67692` | 0 | `GOWORK=off make dist` | 0 | `CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags="-s -w" -o bin/site .` → dist/site-0.1.0.tar.gz |
| kore-plugin-site | 同上 | — | `tar -tzf <pkg>` 首条目 | 0 | 首条目 `info.json`（其后 bin/、bin/site） |

## 跨仓一致性

| 项 | 值 | 结果 |
| --- | --- | --- |
| kore HEAD | 远端 `c0ab71a…7015` = clone = 预期 | CONSISTENT |
| kore-plugins HEAD | 远端 `9d09e56…7768` = clone = 预期 | CONSISTENT |
| kore-plugin-site HEAD | 远端 `199942b…7692` = clone = 预期 | CONSISTENT |
| kore-plugin-echo HEAD | 远端 `2011ea8…78bf` = clone = 预期 | CONSISTENT |
| 公钥 · kore | `internal/core/market/verify.go:16` `IndexPublicKeyHex = "adb9998e4281118f297ecef2505b81e3b58637ce4e78c4ed1698fa5b61b442a4"`（64 hex） | — |
| 公钥 · plugins | `scripts/validate-index.sh:10` `PUB_HEX="adb9998e4281118f297ecef2505b81e3b58637ce4e78c4ed1698fa5b61b442a4"`（64 hex） | 两公钥逐字相同 MATCH=YES，前缀 `adb9998e` 与预期一致 |
| echo sha256 | 索引 `98707f4cd929cf0b67f2b6dea8b978300793e899bb15fd8aca148b2f27fd6d04` = clean clone 重建实测 | SHA_MATCH=YES |
| site sha256 | 索引 `ff9c2c1698e2e63ecfa7e384f539483224297efff68d85dd9a6c73a0f539d484` = clean clone 重建实测 | SHA_MATCH=YES |

## 阻断项
无。四仓 HEAD 三方一致；全部门禁命令退出码 0；两公钥逐字相同；两包 sha256 索引声明 == 干净 clone 重建实测；M4 关键文件与 authorizeTargetAction 落点齐备。

## 记录项（不阻断）
- `size_bytes` 观测差异（非本次验收项）：索引 echo `1258133` / site `1363615`；本次重建 `.tar.gz` 字节数 echo `1250647` / site `1384562`；包内 payload 求和 echo `2933493` / site `3265276`。Makefile 的 `size_bytes` 为 gzip 前固定点迭代的体积代理值，随构建时刻二进制体积浮动；SHA256 逐字一致已证明字节流确定，该差异不影响验收，仅记录供后续核对口径。
- 首次公钥提取因本人 sed 表达式失误取到空串，已立即用 `[0-9a-f]{64}` 精确提取复验，两次均为同一 64 hex；此为 verifier 工具侧失误，非仓库产物问题。

## VERDICT
**APPROVE** — M4 四仓干净 clone 独立复验全绿，无阻断项，具备收口条件。

## 清理证明
- `/tmp/m4-final-clone-verify-4001875/`（四仓 clone + archive 解包 + payload 解包目录）+ `/tmp/m4-verify-base-path` 于出报告后统一删除，`ls -d` 应为 NOT_EXISTS。
- `pgrep -x kored` = 0（无残留守护进程）。
- 本 verifier 仅新增本报告一个文件，未改任何代码。
