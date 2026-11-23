# SDK v0.1.3 发布证据（root_actions 形状 + 清单统一自检 · team task-13 续）

> 执行者: kore-impl-sdk（implementer）· 日期: 2026-11-23 · 仓库: `kore` + 24 个插件仓
> 范围: `pkg/pluginapi`（发布物已在 f086312/6ceeba8 由 waf 支提交，本支新增 `pluginapitest`）/ `docs/RELEASE.md` / `docs/PLUGIN-SDK.md` / 24 仓 `go.mod`+`go.sum` / 本证据
> 本文件只记录命令、退出码与关键输出；结论与未过项见文末。

## 0. 先澄清：rootpolicy.go 的归属与现状（不是本支的未提交改动）

```console
$ git log --oneline -3 -- pkg/pluginapi/rootpolicy.go
6ceeba8 feat(pluginapi): 移除未使用的 ipset 特权面（13 命令形状表）   # kore-impl-waf
f086312 feat(pluginapi): root 动作受控命令形状（ADR-0022）——白名单从命令名升级为子命令+参数形状
$ git status --short -- pkg/pluginapi/rootpolicy.go
（空：已提交、工作树干净）
```

- `rootpolicy.go`（769 行）是 `kore-impl-waf` 的 ADR-0022 成果：把「命令名白名单」升级为「命令 + 子命令 + 参数形状」，导出 `ValidateRootArgv` / `ValidateRootAppendedArgv`，`RootCommandAllowlist` 改为由 `RootCommandPolicies` 派生（13 命令，ipset 按裁决移除）。
- 自洽性核对：`cd pkg/pluginapi && GOWORK=off go vet ./... && go test -count=1 ./...` → 两个包全绿（`pluginapi` 93.5% / `pluginapitest` 94.0%）；无 TODO/FIXME/panic 残留；导出面只有 `ArgShape` / `TokenSpec` / `CommandPattern` / `CommandPolicy` / `RootCommandPolicies` / `ValidateRootArgv` / `ValidateRootAppendedArgv`，与 ADR-0022 描述一致。
- **明显缺陷：未发现**（发布前唯一待办是 waf 的 ipset 移除，已由 `6ceeba8` 先于本支 tag 提交；见 §2 tag 树）。

本支新增的是 `pkg/pluginapi/pluginapitest`（统一清单自检入口，见 §1），与 rootpolicy 无重叠。

## 1. 新增 SDK 能力：`pluginapi/pluginapitest`

提交：`1e0c10a feat(pluginapi): 插件清单统一自检入口 pluginapitest（v0.1.3）+ SDK 文档同步`（只含 `pkg/pluginapi/pluginapitest/` + 2 份文档，路径限定提交）。

接口：

| 导出 | 作用 |
| --- | --- |
| `ValidateInfoJSON([]byte) error` | 校验 info.json 三块公开声明；用 `errors.Join` **一次返回全部违规项** |
| `ValidateInfoFile(path string) error` | 读文件后调用上面的函数，错误带路径前缀 |
| `CheckInfoJSON(t testing.TB, path string)` | 测试适配器：失败 `t.Fatalf`，一行接入 |

覆盖项：

- `capabilities`：1–16 项、去重、`<域>:<动作>` 语法、6 项特权能力或插件自身域 `<id>:<action>`；
- `method_capabilities`：≤64 条、**重复键拒绝**（token 级解析，避免 encoding/json 后者覆盖）、键域必须是插件 id、动作段 `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`、值必须是 6 项特权能力、**只收窄不放大**（同域 read < write < admin；跨域视为放大；协议 §3.1.2.1 的 `capabilities=["system:admin"]` + 方法级 `system:read` 合法）；
- `root_actions`：非空必须 `requires_root:true`、≤16 条、id 唯一、每条过 `pluginapi.ValidateRootAction`（含 ADR-0022 命令形状）。

```console
$ cd pkg/pluginapi && gofmt -l .          # 无输出
$ GOWORK=off go vet ./...                 # exit 0
$ GOWORK=off go test -count=1 -cover ./...
ok  github.com/pengtang1024/kore/pkg/pluginapi            0.017s  coverage: 93.5% of statements
ok  github.com/pengtang1024/kore/pkg/pluginapi/pluginapitest  0.005s  coverage: 94.0% of statements
（pluginapitest 35 条 `--- PASS`：4 个测试函数 + 31 个子测试，覆盖合法/最小/未知字段/非法 JSON/缺 id、
 capabilities、method_capabilities（含收窄/放大/重复键）、root_actions、汇总语义、文件入口、协议常量）
```

全仓插件 `info.json` 扫描（只读，用统一入口跑 24 仓）：

```console
$ go run /tmp/infocheck-scan.go   # 临时程序，用完即删
OK   kore-plugin-app-deploy / backup / container / cron / db-mysql / db-postgres / discover /
     dns / echo / file / firewall / monitor / process / redis / runtime-node / runtime-php /
     runtime-python / site / ssh-guard / ssl / terminal / waf        （22 仓）
FAIL kore-plugin-integrity：methods `integrity.baseline` / `integrity.schedule.set` = system:admin，
     但插件级 capabilities 只有 system:read（放大）
FAIL kore-plugin-logs：`logs.config.set` / `logs.rotate` = system:admin，但插件级只有 system:read
```

以上 2 条是**真实不一致**（方法级权限强于启用时用户确认的插件级声明），不属本任务写域，只报告（见 §6）。

## 2. 发布：`pkg/pluginapi/v0.1.3`（annotated）

```console
$ git tag -a pkg/pluginapi/v0.1.3 1e0c10a \
    -m "pluginapi v0.1.3: ADR-0022 受控命令形状（ValidateRootArgv/ValidateRootAppendedArgv，13 命令）与 pluginapitest 统一清单自检入口"
$ echo $?
0

$ git cat-file -t pkg/pluginapi/v0.1.3
tag                                      # annotated
$ git rev-parse pkg/pluginapi/v0.1.3 pkg/pluginapi/v0.1.3^{}
e48cea716edfefb2dc7933e118f71c2cf3008583  # tag 对象
1e0c10a694ba61c7993289cf56b2068dd6206dfa  # → commit

$ git ls-tree -r --name-only pkg/pluginapi/v0.1.3 -- pkg/pluginapi/ | wc -l
18
（含 rootaction.go / rootaction_test.go / rootpolicy.go / rootpolicy_test.go /
  rootpolicy_nft_test.go / pluginapitest/infocheck.go / pluginapitest/infocheck_test.go；
  rootpolicy.go 中 ipset 已移除 —— 与 ADR-0022 裁决一致）

$ git push origin pkg/pluginapi/v0.1.3   # exit 0
 * [new tag]         pkg/pluginapi/v0.1.3 -> pkg/pluginapi/v0.1.3
$ git push gitee pkg/pluginapi/v0.1.3    # exit 0（镜像）
$ git ls-remote --tags origin refs/tags/pkg/pluginapi/v0.1.3
e48cea716edfefb2dc7933e118f71c2cf3008583  refs/tags/pkg/pluginapi/v0.1.3
（gitee 同 sha；exit 0）
```

`kore` main 未推送（按口径由台账统一推；本地领先 origin 22 个提交，含他支提交）。

## 3. 干净目录消费验证（两条路径）

### 3.1 `GOPROXY=direct`

```console
$ cd /tmp && rm -rf sdk-consume-013 && mkdir sdk-consume-013 && cd sdk-consume-013
$ go mod init tmpcheck013
$ GOWORK=off GOPROXY=direct go get github.com/pengtang1024/kore/pkg/pluginapi@v0.1.3
go: downloading github.com/pengtang1024/kore/pkg/pluginapi v0.1.3
go: added github.com/pengtang1024/kore/pkg/pluginapi v0.1.3
（GET_DIRECT_EXIT=0）
$ GOWORK=off GOPROXY=direct go build ./...      # BUILD_DIRECT_EXIT=0
$ GOWORK=off GOPROXY=direct ./tmpcheck013
SHAPE_REJECT_OK: iptables 的语句 "-F" 不在受控形状内（允许：-S | -S <chain-name> | -L | -L <chain-name> | -L -n | -L -n -v | …）
pluginapi v0.1.3 OK: ValidateRootArgv + ValidateRootAppendedArgv + pluginapitest
（RUN_DIRECT_EXIT=0）
$ GOWORK=off go list -m -versions github.com/pengtang1024/kore/pkg/pluginapi
github.com/pengtang1024/kore/pkg/pluginapi v0.1.1 v0.1.2 v0.1.3   （LIST_DIRECT_EXIT=0）
```

`main.go` 覆盖：`ValidateRootArgv(["nft","add table inet kore_waf"])` 通过、`ValidateRootAppendedArgv(["ufw","allow"],["22/tcp"])` 通过、`ValidateRootArgv(["iptables","-F"])` 被拒、`pluginapitest.ValidateInfoJSON(...)` 通过（方法级收窄样例）。

### 3.2 `proxy.golang.org`（全新 module cache，禁用 direct 回退）

```console
$ cd /tmp && rm -rf sdk-consume-013-proxy /tmp/sdk-mc013 && mkdir sdk-consume-013-proxy && cd sdk-consume-013-proxy
$ go mod init tmpcheck013proxy
$ export GOWORK=off GOMODCACHE=/tmp/sdk-mc013 GOPROXY=https://proxy.golang.org
$ go get github.com/pengtang1024/kore/pkg/pluginapi@v0.1.3    # attempt 1 即成功
go: downloading github.com/pengtang1024/kore/pkg/pluginapi v0.1.3
go: added github.com/pengtang1024/kore/pkg/pluginapi v0.1.3     （GET_PROXY_EXIT=0）
$ go build ./...          # BUILD_PROXY_EXIT=0
$ ./tmpcheck013proxy      # RUN_PROXY_EXIT=0（同上两行输出）
$ go list -m -versions ...  → v0.1.1 v0.1.2 v0.1.3              （LIST_PROXY_EXIT=0）
$ cat go.sum
github.com/pengtang1024/kore/pkg/pluginapi v0.1.3 h1:PwOZ0RaGs3iup25hIhsb/XGIp9GywOway/q8CjVS9Yw=
github.com/pengtang1024/kore/pkg/pluginapi v0.1.3/go.mod h1:yg6DLNEISL1kqt4tlppm2xICAaTb42zcsX1MKk8SAvU=
```

验证后 `/tmp/sdk-consume-013`、`/tmp/sdk-consume-013-proxy`、`/tmp/sdk-mc013`、`/tmp/infocheck-scan.go` 均已删除（`ls` 无残留）。

## 4. 全仓 pluginapi 版本收口（24/24 → v0.1.3）

`go get ...@v0.1.3` + `go mod tidy` 后逐仓 `GOWORK=off go build ./...` + `go test -count=1 -timeout 200s ./...`，再精确提交 `go.mod` / `go.sum`（**全部带 pathspec**，未 tag、未 push）：

| 仓库 | commit | 仓库 | commit |
| --- | --- | --- | --- |
| kore-plugin-app-deploy | `d67ceda` | kore-plugin-monitor | `71fd994` |
| kore-plugin-backup | `da0114e` | kore-plugin-process | `26a58e7` |
| kore-plugin-container | `0773424` | kore-plugin-redis | `4d72ec1` |
| kore-plugin-cron | `160c079` | kore-plugin-runtime-node | `bd389d6` |
| kore-plugin-db-mysql | `f8f96a0` | kore-plugin-runtime-php | `250c607` |
| kore-plugin-db-postgres | `f1a8115` | kore-plugin-runtime-python | `86b5c0e` |
| kore-plugin-discover | `0bed728` | kore-plugin-site | `9b78c8d` |
| kore-plugin-dns | `2480b4a` | kore-plugin-ssh-guard | `8fa9950` |
| kore-plugin-echo | `b8ec7e3` | kore-plugin-ssl | `08d6cf3` |
| kore-plugin-file | `a0bfb19` | kore-plugin-terminal | `b0a1d40` |
| kore-plugin-firewall | `b47196b` | kore-plugin-waf | `7fd9694` |
| kore-plugin-integrity | `782d24c` | kore-plugin-logs | `acd750b` |

全部 `chore(deps): pluginapi v0.1.3`，每仓只含 `go.mod` / `go.sum`（`git show --stat` 2 文件）。

过程说明（如实记录）：首轮批量构建时 `dns` BUILD=1、`ssh-guard` TEST=1（`TestBanWriteReadbackUnverified`），二者当时都有他支未提交改动（dns 的 `internal/dnsop/*`、ssh-guard 的 `protection.go` 等）；待其改动继续推进后复跑均转绿，提交前逐仓确认 BUILD=0 / TEST=0。`cron` 首轮升级后被其支回退了 `go.mod`，已在提交前重新升级并复验（BUILD=0 / TEST=0）。

## 5. waf 自检从 skip 转真跑

```console
$ cd ../kore-plugin-waf && grep -n "v0.1.3" go.mod
require github.com/pengtang1024/kore/pkg/pluginapi v0.1.3

$ GOWORK=off go test -count=1 -run 'TestInfoJSONRootActionsSchema|TestInfoJSON' -v ./
=== RUN   TestInfoJSONRootActionsLocalSchema
--- PASS: TestInfoJSONRootActionsLocalSchema (0.00s)
=== RUN   TestInfoJSONRootActionsSchema
--- PASS: TestInfoJSONRootActionsSchema (0.00s)      # 之前是 t.Skipf("需要 pluginapi ≥ v0.1.3")
PASS
ok  github.com/pengtang1024/kore-plugin-waf 0.004s
```

firewall / ssh-guard 的同名自检同样 PASS（`8fa9950` / `b47196b` 对应树）。

## 6. 门禁

```console
$ cd kore && make check          # exit 0
[OK] 门禁全部通过                 # 11/11 段，0 FAIL
$ make docs-check                # exit 0
docs-check: 5 pass, 1 warn, 0 fail
```

## 7. 未过项 / 需 lead 裁决

1. **`integrity` / `logs` 的 method_capabilities 放大**（§1 扫描）：方法级 `system:admin` 强于插件级 `system:read`，启用时用户只确认了 read。按「只报告不修」处理（不在本任务写域；未纳入两仓自检，故它们的 CI 仍绿）。
2. **统一入口尚未接入三仓测试**：firewall/ssh-guard/waf 现有自检是各自读 info.json + `ValidateRootAction`；本支只发布 `pluginapitest` 能力，未改三仓测试（当前指令限定三仓只改 `go.mod`/`go.sum`）。是否统一改一行 `pluginapitest.CheckInfoJSON` 请 lead 定。
3. **kore 根 `go.mod` 仍 `require pluginapi v0.1.1`**（`replace => ./pkg/pluginapi` 保证构建正确；该文件归台账任务，本支未改）。
4. **插件仓均未 push、未 tag**（按口径「多提交少推送」；发版由各仓自己走）。
5. `pkg/pluginapi/pluginapitest` 是否保留为公开 API：属新增能力（v0.1.3 已含），若 lead 认为超出「发布 + 收口」范围，可在 v0.1.4 移除/保持不动；本支认为它对插件作者有直接价值且纯增量。
