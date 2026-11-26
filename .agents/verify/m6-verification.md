# M6 独立验收报告（G-09 / task-75）

- 验收人：`m6-verifier`（独立于实现者 `m6-impl`，符合 G-09）
- 被验收对象：实现 `2446212`、merge `82ffb69`（M6 内核供应链入口）
- 验收时间：2026-11-26 13:06–13:13 Asia/Shanghai
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）
- 结论：**PASS**（1 项环境偏差：因本地缓存缺依赖，从已配置 goproxy.cn 下载构建依赖到工作区临时 GOMODCACHE，已获 lead 批准；详见 §0）

## 0. 环境偏差与联网披露（如实报告）

task-75 原口径要求「GOCACHE/GOMODCACHE 设工作区内可写临时目录」且「不联网（httptest 本地）」。实测发现：

- 默认 GOMODCACHE `/home/pt/go/pkg/mod` 为只读（`touch` 报 `Read-only file system`），且缺 `go.etcd.io/bbolt v1.5.0` / `golang.org/x/sys v0.45.0` 的 zip（仅 `.mod`/`.info`）；
- 工作区既有 `.tmp/gomodcache`、`.wt-m7/.gomodcache-m7` 等所有本地缓存均无这两版 zip；`GOPROXY=off` 直接编译失败：
  ```
  go: downloading go.etcd.io/bbolt v1.5.0
  internal/core/store/alerts.go:9:2: open /home/pt/go/pkg/mod/cache/download/go.etcd.io/bbolt/@v/v1.5.0.lock: read-only file system
  FAIL ... [setup failed]   (exit 1)
  ```
- 经汇报，lead 批准按 task-66 clean-tree verifier 先例（用户已授权 go proxy 下载依赖），仅从已配置的 goproxy.cn 拉取缺失构建依赖到工作区临时缓存。**未碰 git 远端、未 push、未执行 CLI、未访问任何业务网络**；测试内部仍全部走本地 httptest TLS。

获准后的下载命令与结果：

```
cd /home/pt/Work/GolandProjects/kore-pl/kore
mkdir -p .verify-m6-cache/gomodcache .verify-m6-cache/gocache
GOCACHE=$PWD/.verify-m6-cache/gocache GOMODCACHE=$PWD/.verify-m6-cache/gomodcache \
  GOWORK=off go mod download go.etcd.io/bbolt golang.org/x/sys gopkg.in/yaml.v3
# exit 0
```
回读：`go.etcd.io/bbolt@v1.5.0`、`golang.org/x/sys@v0.45.0`、`gopkg.in/yaml.v3@v3.0.1` 均落在 `.verify-m6-cache/gomodcache/`（退出码 0）。此后所有测试/gate 均在 `GOPROXY` 未再触发下载的情况下完成，临时缓存目录在报告提交前删除。

## 1. 测试复跑（task-75 §1）

精确命令（工作区临时缓存 + `GOWORK=off`）：

```
GOCACHE=$PWD/.verify-m6-cache/gocache GOMODCACHE=$PWD/.verify-m6-cache/gomodcache \
  GOWORK=off go test -count=1 -timeout 200s ./internal/core/market/... ./cmd/kored/...
```

在 M6 merge `82ffb69` 时结果（exit 0）：

```
ok  github.com/pengtang1024/kore/internal/core/market  0.012s
ok  github.com/pengtang1024/kore/cmd/kored             9.223s
```

验收期间并发发生 M7 合入（HEAD `82ffb69` → `83a42ae` → `f9c979e`），故在**当前 HEAD `f9c979e2fc99a9f777f54ff0c881c07a63b72afa`** 原样复跑同一命令（exit 0）：

```
ok  github.com/pengtang1024/kore/internal/core/market  0.009s
ok  github.com/pengtang1024/kore/cmd/kored             9.529s
```

`-v` 模式逐用例核对（exit 0），M6 相关 12 个测试 + 全部分支子用例全 PASS：

market 包：`TestVerifiedCoreAssetSuccess`、`TestVerifiedCoreAssetUnsignedZeroData`、`TestVerifiedCoreAssetMissingSignatureZeroData`、`TestValidateCoreAssetURLRejects`（缺失/http/file/相对路径/缺主机 5 子用例）、`TestVerifiedCoreAssetRejectsBadFields`（错标识/大写摘要/size_bytes 非正数 3 子用例）。
cmd/kored 包：`TestUpgradeSupplySuccessContract`、`TestUpgradeSupplyMissingURLZeroDownload`、`TestUpgradeSupplyRejectsNonHTTPS`（http/file/相对路径 3 子用例）、`TestUpgradeSupplyUnsignedIndexZeroData`、`TestUpgradeSupplyTamperedSHAKeepsTarget`、`TestUpgradeSupplyUpgradeFailureNoLeftover`、`TestSupplyTargetPathRejectsURL`。

## 2. 断言覆盖面读码核对（task-75 §1）

逐条核对代码与断言，确认「绿」不是断言缺失造成（读码证据给 file:line）：

| 验收点 | 实现 | 断言 | 判定 |
| --- | --- | --- | --- |
| 缺 `download_url` → E_INVALID、零下载、零 upgrade | `upgrade_supply.go:77-79` 复用 `market.ValidateCoreAssetURL`；`coreasset.go:55-65` 空 URL → E_INVALID | `coreasset_test.go:84-99`（缺失子用例）；`upgrade_supply_test.go:112-125` `runner.calls==0` | PASS |
| `file:` / `http:` / 相对路径拒绝 | `coreasset.go:60` 强制 `IsAbs && Scheme=="https" && Host!=""` | `coreasset_test.go:84-99`（http/file/相对路径/缺主机）；`upgrade_supply_test.go:127-147`（3 子用例 + `runner.calls==0`） | PASS |
| 篡改 sha → 临时文件删 + upgrade 零调用 + 目标字节不变 | `upgrade_supply.go:138-143` 摘要先校验后交 runner；`:111-117` defer 非 ok 清理临时文件 | `upgrade_supply_test.go:165-196`：篡改 `SHA256`，断言报错含 `sha256`、`runner.calls==0`、独立目标文件逐字节不变、`os.ReadDir(tmpDir)` 零残留 | PASS |
| 未验签/验签失败 → 零数据，且 `allow_unsigned` 不放行 | `coreasset.go:92-99` 直接调 `s.verify`（非 `readTrusted`，不读 `allowUnsigned`）；`market.go:88-93` 验签门 | `coreasset_test.go:45-64`：篡改正文留旧签名 + `svc.allowUnsigned=true`，断言 E_UNAUTHORIZED + `asset == CoreAsset{}`；`:66-80` 缺签名文件同样零数据。`upgrade_supply_test.go:149-163` 替身模拟验签失败 → `runner.calls==0` | PASS |
| 条目逐字段显式类型（G-24） | `coreasset.go:26-48` `CoreAsset` / `coreAssetIndex` 全字段显式 `string`/`int64`/`int`，无 `any`/`map[string]any`/`json.RawMessage` | `coreasset_test.go:28-43` 逐字段断言 ID/Kind/Version/SHA256/SizeBytes/DownloadURL | PASS |
| 成功路径：httptest TLS 下载 → sha256 → `upgrade --bin` argv 契约 | `upgrade_supply.go:86-154`：https 请求 → 流式 sha256 → 大小比对 → argv `{"upgrade","--bin",tmpPath,"--sha256",want}`；`:157-169` `supplyTargetPath` 拒绝 URL | `upgrade_supply_test.go:45-68` `httptest.NewTLSServer` 本地 https + 配对哈希替身；`:70-110` 断言 `--bin` 为本地文件、临时文件字节==payload、`--sha256`==索引摘要、argv 恰 5 项且顺序正确、无 `://`、只读索引一次、无真实 upgrade | PASS |

补充：`upgrade_supply_test.go:198-213` 还覆盖 upgrade 非零返回→报错；`:215-223` 覆盖 `--bin` 收到 URL / 缺 `--bin` 被拒（直连 `upgrade.go:10-14` 不变量）。所有 runner/source 均为测试替身（`:20-43`），无真实替换二进制或重启 unit。

## 3. vet 与门禁 grep（task-75 §2）

```
GOCACHE=... GOMODCACHE=... GOWORK=off make vet
# [OK] go vet 通过   exit 0        （82ffb69 与当前 f9c979e 各跑一次，均 exit 0）
```

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| G-24 | `grep -rn 'map[string]any\|json.RawMessage' internal/core/market/coreasset.go cmd/kored/upgrade_supply.go` | exit 1（零命中 PASS） |
| G-24 扩展 | `grep -rn '\bany\b\|类型：object' <同上两文件>` | exit 1（零命中 PASS） |
| G-01 | `grep -rn '"kore/plugins/' internal/core` | exit 1（零命中 PASS） |
| G-01 扩展 | `grep -rn '^\s*"github.com/pengtang1024/kore-plugin\|^\s*"kore/plugins/' internal/core --include='*.go' \| grep -v _test.go` | exit 1（无真实插件包 import PASS；宽口径 `plugins/` 命中均为既有注释/HTTP 路由字符串） |
| 运行态调用 | `grep -rn '\.kore-local\|exec\.Command\|os/exec\|syscall\.Exec\|systemctl\|runUpgrade(' <M6 两生产文件>` | exit 1（零命中 PASS） |

`.kore-local-*`（`.kore-local.yaml` mtime 2026-11-25 20:15:44、`.kore-local-state/` 2026-11-23 20:08:29、`.kore-local-run/` 2026-11-25 21:30:17、`.kore-local-index/` 2026-11-23 14:56:31、`.kore-local-log/` 2026-11-23 09:29:06）全程未改。未执行 install/serve/upgrade 主流程或任何 kored CLI。

## 4. Git 核对（task-75 §3）

```
git log --oneline -4
  f9c979e [agent:m7-impl] merge: M7 备份清理（wt-m7 → main）   ← 当前 HEAD（并发合入）
  83a42ae [agent:m7-impl] feat(core/market,config): 备份份数/磁盘上限配置 + stale 自动清理
  82ffb69 [agent:m6-impl] merge: M6 内核供应链入口（wt-m6 → main）
  2446212 [agent:m6-impl] feat(core/market): 内核供应链入口（验签索引→https→sha256→upgrade --bin）
```

- 顺序：`2446212^ = f27955a`（M6 实现基于 clean-tree 验收报告）；`82ffb69` 双亲 `f27955a` + `2446212`；`git merge-base --is-ancestor 2446212 82ffb69` exit 0 → 实现在 merge 之前、merge 唯一合并 M6 分支，顺序正确。
- 写域：`git diff --name-only 82ffb69^1 82ffb69` 恰好 5 文件：`cmd/kored/upgrade_supply.go`、`cmd/kored/upgrade_supply_test.go`、`docs/SECURITY.md`、`internal/core/market/coreasset.go`、`internal/core/market/coreasset_test.go` —— 与 task-71 写域一致；`grep -E 'batch\.go|cleanup\.go|config\.go|stale|types\.go'` 零命中（exit 1），未碰 M3 `batch.go` / M7 文件。
- M7 并发合入后：`git diff --name-only 82ffb69 HEAD` 只列 `internal/core/config/*` 与 `internal/core/market/{cleanup.go,cleanup_test.go,types.go}`（M7 写域）；5 个 M6 文件 blob hash 在 `82ffb69` 与 `f9c979e` 逐一相同（`SAME`，如 `coreasset.go fc328c2a…`、`upgrade_supply.go bc54c876…`），M6 内容未被 M7 改动；当前 HEAD 上测试与 vet 已按 §1/§3 复跑全绿。
- worktree（G-25）：验收初 `git worktree list` = 主树 + `.wt-m7`（M7 在途，task-75 明示允许）；M7 合入后复跑仅主树 1 行 `f9c979e [main]`，`git branch --list 'wt-*' 'tmp-*'` 空 → 无残留临时 worktree/分支。
- `git status --short`：仅他人 dirty（`scripts/usability-pending.txt` M；`data/`、`dist/` 及多份 `.agents/verify/*.md`、`screenshots/` untracked；并发的 `docs/DESIGN-REDUCTION.md` untracked）。本验收只新增本报告，未提交/覆盖他人文件、未 push。

## 5. 总评

**M6 独立验收 PASS。** 复跑测试全绿、断言覆盖面逐条核实（非「仅看绿」）、vet 与 G-24/G-01 门禁零命中、commit 顺序与写域正确、无真实 upgrade/CLI 调用、未碰 `.kore-local-*`、未 push。唯一偏差是 §0 披露的 go proxy 依赖下载（已获 lead 批准、仅限构建依赖、临时缓存用完删除）。
