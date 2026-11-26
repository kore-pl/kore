# ACME 本机离线 mock 链路验证证据（task-125 / C2）

> 执行者：`c2-acme`（本卡为执行 worker）｜日期：2026-11-26
> 用户裁决（round 4）："用本机来测试和正式使用"。
> 口径：**本机离线 mock CA 全链路已验证**；**真机外部 CA 签发未做、不算完成**（见 §5）。
> 写域：唯一提交文件为本报告；`kore-plugin-ssl` 生产代码未改；`docs/PLUGIN-MATURITY.md` PM:77/157 未改（待 C15/backlog 卡同步）。

## 1. 基线与写域声明

| 项 | 值 |
| --- | --- |
| 被测仓 | `/home/pt/Work/GolandProjects/kore-pl/kore-plugin-ssl`（独立 git 根，HEAD 未改动） |
| 报告提交仓 | `/home/pt/Work/GolandProjects/kore-pl/kore`（`git rev-parse --show-toplevel` 实测） |
| Go 工具链 | `go version go1.26.8 linux/amd64`；`go.mod` 为 `go 1.26` |
| GOCACHE | `/home/pt/Work/GolandProjects/kore-pl/.tmp-c2-acme-gocache`（工作区临时目录；默认 `/home/pt/.cache/go-build` 实测只读，不能用） |
| GOPROXY | `off`（依赖 `github.com/pengtang1024/kore/pkg/pluginapi v0.1.3` 已在模块缓存，无需下载；本轮未联网下载任何依赖） |
| GOFLAGS | `-mod=mod` |
| 他人 dirty | `kore` 仓执行前后均为 ` M scripts/usability-pending.txt`、`?? .agents/verify/*`（他人报告）、`?? data/`、`?? dist/`；未改动，`kore-plugin-ssl` 仓 status 干净 |
| 禁区 | 未碰 `.kore-local-*` / 8787 / install-upgrade；未联网业务操作；未改生产代码、backlog、PM:77/157 |

## 2. 执行命令与退出码

### 2.1 主验证命令（任务卡指定）

```bash
cd /home/pt/Work/GolandProjects/kore-pl/kore-plugin-ssl
export GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.tmp-c2-acme-gocache
export GOPROXY=off
export GOFLAGS=-mod=mod
go test -count=1 -timeout 200s ./internal/acme/... ./internal/certs/...
```

输出（`ok` 行原样）：

```
ok  	github.com/pengtang1024/kore-plugin-ssl/internal/acme	0.056s
?   	github.com/pengtang1024/kore-plugin-ssl/internal/acme/acmetest	[no test files]
ok  	github.com/pengtang1024/kore-plugin-ssl/internal/certs	2.999s
```

**退出码：0**（`acmetest` 是测试专用 mock CA 包，非测试包，`[no test files]` 属正常）。

### 2.2 逐用例证据（`go test -v` 复跑，便于核对重点用例）

```bash
go test -count=1 -timeout 200s -v ./internal/acme/... ./internal/certs/...
```

- **退出码：0**
- `--- PASS:` 计 **192** 条（含子测试）；`--- FAIL:` 计 **0** 条；包级 `ok ... internal/acme 0.064s` / `ok ... internal/certs 2.993s`。

## 3. 重点用例清单（全部 PASS）

| 重点项 | 用例（文件:行） | 结果 |
| --- | --- | --- |
| ACME 签发闭环（内置客户端） | `TestIssueEndToEnd` (`internal/acme/client_external_test.go:54`) | `--- PASS: TestIssueEndToEnd (0.00s)` |
| 签发闭环（内置引擎业务层） | `TestACMEIssueEndToEnd` (`internal/certs/acme_builtin_test.go:191`) | `--- PASS: TestACMEIssueEndToEnd (0.01s)` |
| 自动续期 due/skip | `TestACMEAutoRenewSkipsNotDue` (`:271`) / `TestACMEAutoRenewRenewsDue` (`:299`) | 两条均 `--- PASS` |
| 续期失败保留旧证书 | `TestACMEAutoRenewFailureKeepsOldCert` (`internal/certs/acme_builtin_test.go:335`) | `--- PASS` |
| 失败签发不落盘 | `TestACMEIssueFailureWritesNothing` (`:249`) | `--- PASS` |
| EAB | `TestEABRequired` (`internal/acme/client_external_test.go:160`，含 missing/accepted/wrong-key 三个子用例) + `TestSignEABVector` / `TestEABRejectsBadKey`、`TestACMEAutoLiteSSLRequiresEAB` | 全部 `--- PASS` |
| bad-nonce 重试 | `TestIssueBadNonceRetry` (`internal/acme/client_external_test.go:102`) | `--- PASS` |
| 零参数一键签发 | `TestACMEIssueQuickZeroParamFromSiteContext` / `TestACMEIssueQuickZeroParamSingleSite` (`internal/certs/acme_quick_test.go:42,:112`) | 两条均 `--- PASS` |
| 失败注入路径 | `TestIssueFailurePaths`（challenge-invalid / finalize-rejected / cert-download-fails / rate-limited 四个子用例） | 全部 `--- PASS` |

其余 PASS 用例（JWS 签名/EAB 向量、CSR SAN、precheck/webroot、绑定、导入、list/renew/selfsign/verify、HTTPS 状态等）均由 §2.2 的 192 条 `--- PASS` 覆盖，无跳过、无失败。

## 4. mock CA 链路为何成立（零外网）

`internal/acme/acmetest/ca.go:1-5` 明示本包为"测试专用的本地 ACME 替身（RFC 8555 最小子集）……让内置 ACME 客户端能在'零外网'前提下跑完整链路——签名、nonce、订单、HTTP-01、finalize、下载证书链——并可控地注入各类失败"。测试用两级 CA（root 自签 → intermediate → 叶子），签发链为"叶子 + intermediate"。`acmetest` 仅被 `*_test.go` import，不进生产二进制。

本轮 `GOPROXY=off` 下全部用例通过，证明上述链路在本机离线环境可执行、可重复（`go test -count=1` 禁用缓存）。

## 5. 结论与边界（重要：勿夸大）

- **已验证**：`ssl` 0.8.1 的内置 ACME 客户端 + `acmetest` mock CA 在本机**离线全链路通过**——签发、续期 due/skip、失败保留旧证书、EAB、bad-nonce 重试、零参数签发等 192 条用例 PASS。任务卡关于"PM:77『ACME 仍骨架』已过时"的判断在 **mock 链路层面**成立。
- **未验证 / 不算完成**：**真机外部 CA 签发**（Let's Encrypt 等生产 CA）需要**用户明确授权联网 + 可控域名 + HTTP-01 可达性**，本环境未做，不计入完成口径。证书可信链、真实 CA 风控/限流、DNS 解析与防火墙放行均未在真机验证。
- **口径同步**：`docs/PLUGIN-MATURITY.md` 的 PM:77（第 77 行 "ACME 仍骨架（本机无客户端，真机签发未验证）"）与 PM:157（第 157 行 "部分补（骨架）"，另第 30/142 行同类表述）**本卡不改**；**过时口径待 C15 / backlog 卡（task-124）统一同步**，避免并发冲突。本报告仅作为该同步的证据输入。

## 6. 收尾

- 临时 GOCACHE `/home/pt/Work/GolandProjects/kore-pl/.tmp-c2-acme-gocache` 用完已删除（非工作区交付物）。
- 提交：仅本报告，`kore` 仓 `git add .agents/verify/acme-offline-evidence.md` + `git commit -s`，签名 `[agent:c2-acme]`；**不 push**。
