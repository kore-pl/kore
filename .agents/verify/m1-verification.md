# M1 独立验收报告（commit 2f56c2a · ADR-0058 UDS-only 专用自更新端点）

> 时间：2026-11-26（Asia/Shanghai）｜复核者：`m1-verifier`（独立 verifier，G-09：与 implementer `m1-impl` 不同人，不复用其结论，按 QUALITY-GATES 原文独立复跑）
> 工作区：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）｜目标 commit：`2f56c2ac59b0bbfe8e64d998814f3757056f7f26`
> 纪律：全程只读复跑；不改代码、不 push、不执行 install/serve/upgrade、不碰 `.kore-local-*` 运行态；隔离 state/socket 全落工作区内临时目录 `/home/pt/Work/GolandProjects/kore-pl/.verify-m1-tmp/`，用完删除；唯一写入仓库的文件为本报告。
> 断言覆盖面口径：不只 `go test` 看绿，逐条直接读 `selfupdate_local_test.go` 源码核对断言，且用**独立 harness（自建 fake，不复用 m1-impl 的测试替身）从 commit 的 `git archive` 起真实隔离实例跑 curl** 交叉验证（行为真值）。

## VERDICT：PASS

所有复跑项达标：`go vet` exit 0；`go test httpapi` exit 0（全包通过，含 11 条本地专项 + 子用例全绿）；鉴权正反例断言覆盖面逐条核对到位（10 项判据真有断言，且被独立 curl 行为复核一致）；薄壳 grep 零命中；`make repo-check/docs-check/secret-check` 全 exit 0；审计结构无凭据字段（代码 + 测试 + 独立 curl 实测三证）。

## 0. 基线与独立性说明

```
$ git rev-parse HEAD
2f56c2ac59b0bbfe8e64d998814f3757056f7f26
$ git cat-file -t 2f56c2a -> commit
$ git merge-base --is-ancestor 2f56c2a HEAD -> YES（HEAD 即 2f56c2a，无 M2 merge 干扰）
$ git log -1 --oneline
2f56c2a [agent:m1-impl] feat(httpapi): ADR-0058 UDS-only 专用自更新端点
```
- 环境注意：本沙箱 `$HOME/.cache/go-build`（默认 `GOCACHE`）为只读文件系统；`go vet`/`go test` 首次直跑报 `open .../read-only file system`。**改设 `GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.verify-m1-tmp/gocache`（隔离、工作区内、非 git 树）后复跑通过**——这是环境限制，不是被测代码缺陷；两次命令原文与退出码均在下文留痕。
- 独立实例做法：`git archive 2f56c2a | tar -x -C <tmp>/src` 取纯净快照，在快照内自建 `verifyharness`（自写 fake backend / transport / audit recorder，均非 m1-impl 的 test helper），`make web-dist` 满足 embed，导出独立二进制；所有 socket / state.db 落 `<tmp>/case-*/`。**未触碰主树 `.kore-local-*`**（`.kore-local.yaml` mtime 仍为 Nov 25 20:15，`.kore-local-run/` socket 仍为 Nov 25 21:30，未改）。

## 1. go vet（`./cmd/kored/...` + `./internal/core/httpapi/...`）

```
# 第一次（暴露环境只读问题，非代码缺陷）：
$ GOWORK=off go vet ./cmd/kored/... ./internal/core/httpapi/...
pattern ./cmd/kored/...: open /home/pt/.cache/go-build/...: read-only file system
pattern ./internal/core/httpapi/...: open /home/pt/.cache/go-build/...: read-only file system
EXIT_CODE=1

# 重定向 GOCACHE 后（判据本体）：
$ GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.verify-m1-tmp/gocache GOWORK=off \
  go vet ./cmd/kored/... ./internal/core/httpapi/...
（无输出）
EXIT_CODE=0
```
结论：PASS（exit 0，零 vet 报告）。

## 2. go test httpapi（`go test -count=1 -timeout 200s -v ./internal/core/httpapi/...`）

```
$ GOCACHE=.../gocache GOWORK=off go test -count=1 -timeout 200s -v ./internal/core/httpapi/...
...
--- PASS: TestLocalUpdateHappyPath (0.00s)
--- PASS: TestLocalUpdateRejectsNonUnixConn (0.00s)
--- PASS: TestLocalUpdatePeerCredMustBeTrusted (0.00s)
    --- PASS: .../合法_uid(self)  --- PASS: .../合法_uid(root)
    --- PASS: .../伪造_uid        --- PASS: .../凭据不可用
--- PASS: TestLocalUpdateCapabilityIsolation (0.00s)
    --- PASS: .../单一专用能力    --- PASS: .../会话_admin_全权
    --- PASS: .../专用能力混_admin --- PASS: .../空能力集
--- PASS: TestLocalUpdateAuditNoCredentials (0.00s)
--- PASS: TestLocalUpdateAuditFailClosed (0.00s)
--- PASS: TestLocalUpdateRequiresConfirm (0.00s)
--- PASS: TestLocalUpdateUnwiredAudit (0.00s)
--- PASS: TestPublicGateUnchangedOverUDS (0.07s)
    selfupdate_local_test.go:340: curl 输出首行: HTTP/1.1 401 Unauthorized
--- PASS: TestLocalUpdateRejectsLoopbackTCP (0.00s)
--- PASS: TestLocalUpdateUnwiredBackend (0.00s)
...
PASS
ok  github.com/pengtang1024/kore/internal/core/httpapi  4.876s
EXIT_CODE=0
```
结论：PASS（exit 0；全包通过，无 FAIL / 无 SKIP 影响判据）。

## 3. 断言覆盖面核对（逐条读 selfupdate_local_test.go，不只看绿）

任务卡列 10 项判据，落在本文件 11 个顶层测试 + 各子用例中。逐条核对（文件行号为本 commit 原文）：

| # | 判据 | 测试（行） | 断言原文要点 | 覆盖 |
|---|---|---|---|---|
| 1 | 合法 uid(202) | `TestLocalUpdateHappyPath` L121-135；`TestLocalUpdatePeerCredMustBeTrusted/合法 uid(self,root)` L162-163 | `rec.Code != http.StatusAccepted` → Fatal；`up.lastStart.SourcePath/Confirm` 校验透传；root(uid=0) 与 self `os.Getuid()` 双例 | ✅ |
| 2 | 伪造 uid(403) | `TestLocalUpdatePeerCredMustBeTrusted/伪造 uid` L164 | `wantStatus=403`；`wantCall=false` 断言 `up.lastStart.SourcePath==""`（Updater 未调用） | ✅ |
| 3 | 凭据不可用(401) | `TestLocalUpdatePeerCredMustBeTrusted/凭据不可用` L165 | `wantStatus=401`；`wantCall=false` | ✅ |
| 4 | loopback TCP(401 且 Updater 未调用) | `TestLocalUpdateRejectsNonUnixConn` L139-150（net.Pipe 包装非 UDS）+ `TestLocalUpdateRejectsLoopbackTCP` L354-370（真实 `httptest.NewServer`） | `resp.StatusCode != 401` → Fatal；`up.lastStart.SourcePath != ""` → Fatal（Updater 未调用）。两条独立路径均覆盖 | ✅ |
| 5 | 会话 admin 混能力(403) | `TestLocalUpdateCapabilityIsolation/会话 admin 全权`、`/专用能力混 admin` L201-202 | resolver 返回 6 项 admin / `self_update+system:admin` → `wantStatus=403`；403 时 `up.lastStart.SourcePath != ""` → Fatal | ✅ |
| 6 | 空能力集(403) | `TestLocalUpdateCapabilityIsolation/空能力集` L203 | resolver 返回 `[]string{}` → `wantStatus=403` | ✅ |
| 7 | 审计无凭据 | `TestLocalUpdateAuditNoCredentials` L231-255 | `len(ev.Detail)!=3` 或 `channel/capability/target_version` 值不符 → Fatal；`ev.Subject == "uid:"+os.Getuid()` → Fatal；遍历 Detail key 与 `password/secret/token/confirm/source_path/sha256` 做 EqualFold 比对，命中 → Fatal | ✅ |
| 8 | 审计写失败(503 且无调用) | `TestLocalUpdateAuditFailClosed` L258-269 | recorder 注入 error → `rec.Code != 503` Fatal；`up.lastStart.SourcePath != ""` Fatal | ✅ |
| 9 | 后端未装配(501) | `TestLocalUpdateUnwiredBackend` L373-388 | `rec.Code != 501` Fatal；`len(recorder.events)!=0` Fatal（不写 ok 审计） | ✅ |
| 10 | 缺 confirm(400) | `TestLocalUpdateRequiresConfirm` L272-284 | body 去掉 confirm → `rec.Code != 400` Fatal；`up.lastStart.SourcePath != "" || len(recorder.events)!=0` Fatal | ✅ |
| 附 | 未注入审计出口(503) | `TestLocalUpdateUnwiredAudit` L287-299 | `rec.Code != 503` Fatal；Updater 未调用 | ✅ |
| 附 | 公开门经真实 UDS 未登录 401 | `TestPublicGateUnchangedOverUDS` L305-344 | 真实 `curl --unix-socket` 起隔离实例访问 `store/install`，取状态行断言含 ` 401` | ✅ |

**覆盖面结论**：任务卡要求的 10 项判据**全部有真实断言**（不是空壳测试），且断言同时约束「状态码」与「Updater 是否被调用 / 审计是否写入」——正反例双向都封死；额外覆盖 root uid 放行、未注入审计出口 503、单一能力正向放行、`system:self_update` 不并入 admin 能力集（L188）与不进公开白名单（L191）。绿不是假绿。

## 4. 独立 curl 正反例（自建 harness + 隔离实例，实测行为真值）

自建 harness（`verifyharness/main.go`，独立 fake：`verifierBackend` / `verifierTransport` / `verifierAudit`，不用 m1-impl 测试替身），每个 case 一个 `<tmp>/case-*` 目录（独立 state.db + 主 socket + 专用 socket），命令形如 `curl --unix-socket <sock> -i -sS -X POST -H 'Content-Type: application/json' -d <body> <url>`。结果汇总（完整状态行与 STATS/AUDIT 见本报告附录及 `<tmp>/curl-results.txt`，临时目录收尾时删除，故正文留痕）：

| case | socket | uid / mode | 期望 | 实测状态行 | Updater 调用 | 审计 |
|---|---|---|---|---|---|---|
| 未登录 store/install | 主 | — | 401 | `HTTP/1.1 401 Unauthorized` | 0 | 0 |
| self-update 打主 socket | 主 | — | 非专用入口 | `HTTP/1.1 401 Unauthorized` | 0 | 0 |
| 合法 uid(self=1000) | 专用 | 1000/normal | 202 | `HTTP/1.1 202 Accepted` | **1** | ok×1 |
| 合法 uid(root=0) | 专用 | 0/normal | 202 | `HTTP/1.1 202 Accepted` | **1** | ok×1 |
| 伪造 uid(1001) | 专用 | 1001/normal | 403 | `HTTP/1.1 403 Forbidden` | **0** | denied×1 |
| 凭据不可用 | 专用 | no-peercred | 401 | `HTTP/1.1 401 Unauthorized` | 0 | denied×1 |
| 会话 admin 全权能力 | 专用 | cap-admin | 403 | `HTTP/1.1 403 Forbidden` | 0 | denied×1 |
| 专用+admin 混能力 | 专用 | cap-mixed | 403 | `HTTP/1.1 403 Forbidden` | 0 | denied×1 |
| 空能力集 | 专用 | cap-empty | 403 | `HTTP/1.1 403 Forbidden` | 0 | denied×1 |
| 缺 confirm | 专用 | normal | 400 | `HTTP/1.1 400 Bad Request` | 0 | 0 |
| 审计写失败 | 专用 | audit-fail | 503 | `HTTP/1.1 503 Service Unavailable` | **0** | 0 |
| 审计出口未装配 | 专用 | no-audit | 503 | `HTTP/1.1 503 Service Unavailable` | 0 | 0 |
| 后端未装配 | 专用 | no-backend | 501 | `HTTP/1.1 501 Not Implemented` | 0 | 0 |
| loopback TCP 冒用 | TCP:18777 | 1000/normal | 401 | `HTTP/1.1 401 Unauthorized` | **0** | 0 |

关键正例审计原文（合法 uid，验证 detail 恰为 3 字段且无凭据字段）：
```
AUDIT[0]={"Subject":"uid:1000","Action":"system.self_update","Plugin":"","Target":"0.1.2",
          "Result":"ok","Detail":{"capability":"system:self_update","channel":"unix","target_version":"0.1.2"}}
```
结论：PASS。所有正反例状态码与断言覆盖面完全吻合；审计 ok 事件写且只写 3 个非敏感 detail 字段。

## 5. 薄壳 / 仓库边界 / 文档 / 凭据门禁

```
$ grep -rn '"kore/plugins/' internal/core
（无输出）
GREP_EXIT=1   # grep 语义：1 = 零命中，符合判据
# 对照：宽口径 grep -rn 'plugins/' internal/core 命中均属既有 /api/v1/plugins/ 路由、
# <state>/plugins/<id> 注释、kore-plugins/index 引用（非 "kore/plugins/" import），不误判。

$ make repo-check
[OK] 无插件代码目录（plugins/ 下无 *.go）
[OK] 无任何 kore-plugin- 源码导入
[OK] 无旧 SDK 路径（统一 pkg/pluginapi）
[OK] 无插件索引 index/plugins.json（属 kore-plugins 仓库）
[OK] 无 submodule 化插件（.gitmodules 无 kore-plugin-）
repo-check: 5 pass, 0 fail
EXIT_CODE=0

$ make docs-check
[PASS] 必需文件齐全：16 项 + docs/DECISIONS 52 篇
[PASS] 全部 124 份文档元信息合规
[PASS] 检查 1275 条相对链接，全部可达
[PASS] 占位词密度合规（全部 ≤ 2 次）
[WARN] 行数越界 9 份（WARN，不阻断）
[PASS] 关键口径 '8 MiB' / 'kore.plugin.v1' / '/run/kore' 覆盖达标
docs-check: 5 pass, 1 warn, 0 fail
结果: 门禁通过（1 WARN 不阻断）
EXIT_CODE=0

$ make secret-check
[RUN ] secret-check
secret-check: 0 FAIL / 23 处匹配（占位写法均合规）
EXIT_CODE=0
```
端点一致性手工核对（任务卡指定三处 + 实现文档）：
```
$ grep -n '72 个端点' AGENTS.md -> L152（HTTP API 72 个端点：65 业务 + 7 store）
$ grep -n '72 个端点' README.md -> L105（docs/CORE.md 表：72 个端点）
$ grep -n '共 \*\*72 个端点' docs/CORE.md -> L64（含 ADR-0058 UDS-only system/self-update 1 条）
docs/SECURITY.md：ADR-0058 安全设计段存在（commit diff +16 行），无独立端点计数口径
旧值 71 在四文件零命中（git show 2f56c2a diff 显示 71→72 已同步）
```
结论：PASS。薄壳零命中、三门禁 exit 0；端点 72 口径在 AGENTS.md / README.md / docs/CORE.md 三处一致。

## 6. 审计结构无凭据字段（代码 + 测试 + 独立实测三证）

1. **代码**：`AuditEvent` 结构（`internal/core/httpapi/audit_http.go:52-65`）只有 `Subject/Action/Plugin/Target/Result/Detail(map[string]string)` 六字段，无 Password/Token/Secret/Credential 字段；`selfupdate_local.go:180-195` `auditLocalUpdate` 构造 Detail 恰好 3 个键 `channel`/`capability`/`target_version`，`serve_boot.go` 适配器只做字段直传不注入凭据；注释（L17-19）明确"绝不记口令、token 或任何凭据字段"。
2. **测试**：`TestLocalUpdateAuditNoCredentials`（L231-255）断言 Detail 恰 3 键且值精确，Subject 严格等于 `uid:<os.Getuid()>`，并对禁字段列表逐键 EqualFold 拒绝。
3. **独立 curl 实测**（本报告 §4）：合法 uid 的 `AUDIT[0]` JSON 实串显示 Detail 仅 `capability`/`channel`/`target_version` 三键、无 source_path/sha256/password/token，Result=ok。

结论：PASS（三证一致）。

## 7. 纪律声明

- 本轮**未改动任何主实例运行态**：`.kore-local.yaml`（mtime Nov 25 20:15）、`.kore-local-run/`（socket Nov 25 21:30）均未触碰；未执行 install / serve / upgrade；未 push。
- 所有隔离 state.db / socket / harness 二进制 / 脚本 / 结果文件均在 `/home/pt/Work/GolandProjects/kore-pl/.verify-m1-tmp/`（工作区内、git 树外），验收完成后**整目录删除**。
- 报告提交仅精确 `git add .agents/verify/m1-verification.md` + `git commit -s -- <路径>`，提交信息首行带 `[agent:m1-verifier]`；不 add 任何他人未提交文件。
- 如主树出现 M2 worker 的 merge commit：本轮以当前 HEAD 为准复核（HEAD 仍为 2f56c2a，无冲突；若后续 HEAD 变动，本报告结论仅适用于 commit 2f56c2a 的代码快照）。

## 结论

**PASS** — 断言覆盖面结论：任务卡 10 项判据全部有真实断言且经独立 curl 行为复核一致，非"测试绿但断言没跟上"的假绿；M1 验收达标。
