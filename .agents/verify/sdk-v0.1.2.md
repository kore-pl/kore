# SDK v0.1.2 发布证据（SDK 发布链 P0 · team task-13）

> 执行者: kore-impl-sdk（implementer）· 日期: 2026-11-23 · 仓库: `kore` + 3 插件仓
> 范围: `pkg/pluginapi` / `docs/RELEASE.md` / `docs/PLUGIN-PROTOCOL.md` / `docs/PLUGIN-SDK.md` / 三插件仓 `go.mod`+自检测试
> 本文件只记录命令、退出码与关键输出；结论与未过项见文末。

## 1. 复核：v0.1.1 是否真的缺 rootaction.go

```console
$ git ls-tree -r --name-only pkg/pluginapi/v0.1.1 -- pkg/pluginapi/
pkg/pluginapi/doc.go
pkg/pluginapi/envelope.go
pkg/pluginapi/envelope_test.go
pkg/pluginapi/errors.go
pkg/pluginapi/frame.go
pkg/pluginapi/frame_limit_test.go
pkg/pluginapi/frame_test.go
pkg/pluginapi/go.mod
pkg/pluginapi/protocol.go
pkg/pluginapi/protocol_test.go
pkg/pluginapi/timeout.go
（无 rootaction.go；exit 0，11 个文件）

$ git ls-tree -r --name-only HEAD -- pkg/pluginapi/ | grep rootaction
pkg/pluginapi/rootaction.go
（exit 0；工作树同样存在，且已提交：git ls-files --stage 显示 100644 c2035c18…）

$ git log --oneline --all -- pkg/pluginapi/rootaction.go
d398ad7 feat(core/privilege): 实现 ADR-0018 提权通道 v0.x（root_actions + systemd-run + 审计 fail-closed）
（唯一提交；晚于 v0.1.1 tag 点 e2c9cc0 → 从未发布）

$ git status --short -- pkg/pluginapi/
（空：rootaction.go 无未提交改动；rootaction_test.go 发版前不存在，本任务新增）

$ git cat-file -t pkg/pluginapi/v0.1.0 ; git cat-file -t pkg/pluginapi/v0.1.1
tag
tag
（两个历史 SDK tag 本身已是 annotated）
```

**结论**：现象成立。`rootaction.go`（`RootAction` + `ValidateRootAction`，142 行）于 `d398ad7` 合入 main，但 v0.1.1 的 tree 不含该文件，且没有 `rootaction_test.go`——插件无法用公开 SDK 在测试期校验 `root_actions`。

对照：插件仓 tag 类型确为混用（既成事实，仅作 §5 口径依据）：

```console
$ for p in kore-plugin-firewall kore-plugin-ssh-guard kore-plugin-waf; do
    git -C ../$p for-each-ref refs/tags --format='%(refname:short) %(objecttype)'; done
firewall:  v0.1.0 commit / v0.2.0 commit / v0.2.1 tag / v0.2.2 commit / v0.2.3 tag
ssh-guard: v0.1.0 commit / v0.1.1 tag / v0.2.0 commit
waf:       v0.1.0 commit / v0.1.1 tag / v0.2.0 commit
```

## 2. 新增测试与本地结果

新增 `pkg/pluginapi/rootaction_test.go`（418 行，外部测试包 `pluginapi_test`，只经公开 API）。

覆盖用例（表驱动 + 子测试）：

- 合法最小项 / 合法完整项（绝对路径 + 200 runes description + irreversible）
- 缺字段：id 空、argv nil、argv 空数组、timeout_s 缺省(0)、argv 中间项空、argv[0] 空
- 超长 description：201 runes 拒绝、200 runes 通过（中文 rune vs byte 证明按 rune 计数）
- 非法 action 名：大写、数字开头、下划线、空格、点号、连字符开头、中文
- irreversible 语义：true/false 均可通过 schema；JSON 往返保留；缺省为 false（confirm 令牌属内核执行层，不由 schema 拒绝）
- 未知字段：encoding/json 忽略未知字段（向前兼容）；拼错 `timeoutSeconds` 落零值后被 schema 拒绝
- argv 形态与上限：尾斜杠/`..`/根目录/相对路径/非白名单命令/换行/NUL/单项 256/总长 4096/元素数 32
- timeout 边界 1/300 与越界 0/301
- info.json 片段整体自检样例（3 条 root_actions 逐条校验 + 非法项定位）
- 命令白名单与文档一致（8 个命令）

```console
$ cd pkg/pluginapi && GOWORK=off go vet ./... ; echo $?
0
$ GOWORK=off go test -count=1 -cover ./...
ok  	github.com/pengtang1024/kore/pkg/pluginapi	0.013s	coverage: 92.1% of statements
$ GOWORK=off go test -count=1 -run 'RootAction|RootCommand' -v ./... | grep -c -- '--- PASS'
40
（40 条 `--- PASS` 行：4 个测试函数 + 36 个子测试，0 FAIL；gofmt -l 无输出）
```

提交（kore main）：`d0af181 test(pluginapi): root_actions schema 表驱动测试（SDK 自检可复用）`。

## 3. 发版：`pkg/pluginapi/v0.1.2`

```console
$ git tag -a pkg/pluginapi/v0.1.2 50d3681 \
    -m "pluginapi v0.1.2: 公开 RootAction / ValidateRootAction（ADR-0018 root_actions schema），补表驱动测试"
$ echo $?
0

$ git cat-file -t pkg/pluginapi/v0.1.2
tag                                  # annotated（轻量 tag 此处是 commit）

$ git rev-parse pkg/pluginapi/v0.1.2
b54ab12a3fddcd450ca58ce2212844c4bb6ef977      # tag 对象
$ git rev-parse pkg/pluginapi/v0.1.2^{}
50d36818445ca06c4938522b1a2502fdf6f11f2d      # 指向 commit

$ git cat-file -p pkg/pluginapi/v0.1.2
object 50d36818445ca06c4938522b1a2502fdf6f11f2d
type commit
tag pkg/pluginapi/v0.1.2
tagger pengtang1024 <pengtang1024@qq.com> 1795408571 +0800

pluginapi v0.1.2: 公开 RootAction / ValidateRootAction（ADR-0018 root_actions schema），补表驱动测试

$ git ls-tree -r --name-only pkg/pluginapi/v0.1.2 -- pkg/pluginapi/
doc.go envelope.go envelope_test.go errors.go frame.go frame_limit_test.go frame_test.go
go.mod protocol.go protocol_test.go rootaction.go rootaction_test.go timeout.go
（13 个文件；含 rootaction.go + rootaction_test.go）

$ git push origin pkg/pluginapi/v0.1.2   # exit 0
 * [new tag]         pkg/pluginapi/v0.1.2 -> pkg/pluginapi/v0.1.2
$ git push gitee pkg/pluginapi/v0.1.2    # exit 0（镜像）
 * [new tag]         pkg/pluginapi/v0.1.2 -> pkg/pluginapi/v0.1.2

$ git ls-remote --tags origin 'refs/tags/pkg/pluginapi/*'
b54ab12a3fddcd450ca58ce2212844c4bb6ef977  refs/tags/pkg/pluginapi/v0.1.2
50d36818445ca06c4938522b1a2502fdf6f11f2d  refs/tags/pkg/pluginapi/v0.1.2^{}
（gitee 同样两条；exit 0）
```

分支说明：kore main 由台账任务统一推送（本地 main 领先 origin 14 个提交，含其他 agent 的提交）；本任务只推 tag。tag 引用的 commit 已随 tag 推到两端。

## 4. 干净目录消费验证（CS-M1 教训：不能只靠工作树）

### 4.1 `GOPROXY=direct`

```console
$ cd /tmp && rm -rf sdk-consume && mkdir sdk-consume && cd sdk-consume
$ go mod init tmpcheck
go: creating new go.mod: module tmpcheck
$ GOWORK=off GOPROXY=direct go get github.com/pengtang1024/kore/pkg/pluginapi@v0.1.2
go: downloading github.com/pengtang1024/kore/pkg/pluginapi v0.1.2
go: added github.com/pengtang1024/kore/pkg/pluginapi v0.1.2
（GET_DIRECT_EXIT=0）

$ GOWORK=off go list -m -versions github.com/pengtang1024/kore/pkg/pluginapi
github.com/pengtang1024/kore/pkg/pluginapi v0.1.1 v0.1.2
（LIST_DIRECT_EXIT=0）

$ GOWORK=off GOPROXY=direct go build ./...
（BUILD_DIRECT_EXIT=0）
$ GOWORK=off GOPROXY=direct ./tmpcheck
REJECT_OK: id="Bad_ID" 必须匹配 ^[a-z][a-z0-9-]*$
RootAction OK: ufw-status
（RUN_EXIT=0）

$ cat go.mod
module tmpcheck
go 1.26.8
require github.com/pengtang1024/kore/pkg/pluginapi v0.1.2 // indirect
```

`main.go` 内容（引用本版新增 API）：构造 `pluginapi.RootAction{ID:"ufw-status", Argv:["ufw","status","verbose"], TimeoutS:10}` → `ValidateRootAction` 返回 nil；再以 `id="Bad_ID"` 反例断言被拒绝。

### 4.2 `proxy.golang.org`（全新 module cache，禁用 direct 回退）

```console
$ cd /tmp && rm -rf sdk-consume-proxy /tmp/sdk-mc-proxy && mkdir sdk-consume-proxy && cd sdk-consume-proxy
$ go mod init tmpcheckproxy
$ export GOWORK=off GOMODCACHE=/tmp/sdk-mc-proxy GOPROXY=https://proxy.golang.org
$ go get github.com/pengtang1024/kore/pkg/pluginapi@v0.1.2     # attempt 1
go: downloading github.com/pengtang1024/kore/pkg/pluginapi v0.1.2
go: added github.com/pengtang1024/kore/pkg/pluginapi v0.1.2
（GET_PROXY_EXIT=0，首次即命中，无需重试）

$ go list -m -versions github.com/pengtang1024/kore/pkg/pluginapi
github.com/pengtang1024/kore/pkg/pluginapi v0.1.1 v0.1.2
（LIST_PROXY_EXIT=0）

$ go build ./...              # BUILD_PROXY_EXIT=0
$ ./tmpcheckproxy
REJECT_OK: id="Bad_ID" 必须匹配 ^[a-z][a-z0-9-]*$
RootAction OK: ufw-status     # RUN_PROXY_EXIT=0

$ cat go.sum
github.com/pengtang1024/kore/pkg/pluginapi v0.1.2 h1:AaRO58Zll5DJbLowvA1kotXM6zHIs6y993MJZJr8WfI=
github.com/pengtang1024/kore/pkg/pluginapi v0.1.2/go.mod h1:yg6DLNEISL1kqt4tlppm2xICAaTb42zcsX1MKk8SAvU=
```

两条路径均 exit 0；`/tmp/sdk-consume`、`/tmp/sdk-consume-proxy`、`/tmp/sdk-mc-proxy` 验证后已删除。

## 5. 三个插件仓：`pluginapi v0.1.1 → v0.1.2` + schema 自检测试

每仓新增 `rootactions_schema_test.go`（51 行，`package main`）：读 `info.json` → 解析 `requires_root` 与 `root_actions` → 断言 `root_actions` 非空时 `requires_root=true` → 查重 id → 逐条 `pluginapi.ValidateRootAction`，任一失败即测试失败。未使用任何 `replace`（G-17）。

```console
$ GOWORK=off go get github.com/pengtang1024/kore/pkg/pluginapi@v0.1.2   # 三仓均 exit 0
go: upgraded github.com/pengtang1024/kore/pkg/pluginapi v0.1.1 => v0.1.2
$ GOWORK=off go mod tidy                                                # 三仓均 exit 0
（go.sum 只剩 v0.1.2 两条）

$ GOWORK=off go build ./...        # firewall 0 / ssh-guard 0 / waf 0
$ GOWORK=off go vet ./...          # 三仓均 0
$ GOWORK=off go test -count=1 -timeout 200s ./...
kore-plugin-firewall:  ok 主包 · ok internal/fwop · ok tests/e2e · ok tests/fault        （exit 0）
kore-plugin-ssh-guard: ok 主包 · ok tests/fault                                          （exit 0）
kore-plugin-waf:       ok 主包 · ok internal/plugincfg · ok internal/wafop · ok tests/fault（exit 0）

$ GOWORK=off go test -count=1 -run TestInfoJSONRootActionsSchema -v ./
--- PASS: TestInfoJSONRootActionsSchema (0.00s)   # firewall  / exit 0
--- PASS: TestInfoJSONRootActionsSchema (0.00s)   # ssh-guard / exit 0
--- PASS: TestInfoJSONRootActionsSchema (0.00s)   # waf       / exit 0
（三仓 root_actions 分别为 5 / 3 / 2 条，全部通过 SDK 校验）
```

提交与推送（均只含 `go.mod` / `go.sum` / `rootactions_schema_test.go`，未 tag）：

| 仓库 | commit | 推送 origin | 推送 gitee |
| --- | --- | --- | --- |
| kore-plugin-firewall | `3325ce7 chore(deps): pluginapi v0.1.2（root_actions schema 自检）` | exit 0（9b41607..3325ce7） | exit 0 |
| kore-plugin-ssh-guard | `cab46f7 chore(deps): pluginapi v0.1.2（root_actions schema 自检）` | exit 0（ce39aab..cab46f7） | exit 0 |
| kore-plugin-waf | `edf5934 chore(deps): pluginapi v0.1.2（root_actions schema 自检）` | exit 0（ea2013d..edf5934） | exit 0 |

写域核对（ssh-guard 另一支 agent 的改动未纳入本提交）：提交后 `git status --short` 仍显示 `M protection.go`、`?? rootaction_client.go`、`?? RELEASE-EVIDENCE.md`、`?? _design-notes-0.2.1.md`——均为他人工作，本任务未触碰。

## 6. 文档同步（G-06）

```console
$ git show --stat --oneline 50d3681
50d3681 docs: SDK 发版流程与 tag 类型口径，补 v0.1.2 root_actions 自检说明
 docs/PLUGIN-PROTOCOL.md |  2 ++
 docs/PLUGIN-SDK.md      |  8 +++---
 docs/RELEASE.md         | 67 ++++++++++++++++++++++++++++++++++++++++++++++---
 3 files changed, 71 insertions(+), 6 deletions(-)
```

- `docs/RELEASE.md`：新增 §4「SDK（pkg/pluginapi）发版流程」（触发条件 / tag 点内容核对 / 测试 / annotated tag / push / §4.3 干净目录消费验证含 v0.1.0 retract 教训 / §4.4 插件侧消费口径）与 §5「tag 类型口径」（历史轻量 tag 保留不动、新 tag 一律 annotated、发布后 `for-each-ref` 自查）；§2.5 明确 annotated 并指向 §5。
- `docs/PLUGIN-PROTOCOL.md` §3.1.3：补「SDK 自检（`pkg/pluginapi` v0.1.2 起）」段，要求插件在测试中逐条 `ValidateRootAction`，禁止手写 schema 与跨仓 `replace`。
- `docs/PLUGIN-SDK.md`：`require ... v0.1.1` → `v0.1.2`（2 处）、补 `requires_root` / `root_actions` 自检说明与协议链接。
- 其他引用 SDK 版本的文档核对：`grep -rn "pkg/pluginapi v0.1.1"` 仅 `.agents/` 历史台账（JOURNAL / BOARD / LOG / proposals，属历史记录不回写）；`docs/` 内已无 v0.1.1 依赖声明。

## 7. 门禁

```console
$ bash scripts/docs-check.sh
docs-check: 5 pass, 1 warn, 0 fail
结果: 门禁通过（1 WARN 不阻断）        # exit 0
（WARN 为 docs/GITEE-MIRROR.md:78 与 docs/PLUGIN-PROTOCOL.md:439 行数越界，均非本次引入、不阻断）

$ make check
[OK] 门禁全部通过                       # exit 0（11/11 段；完整日志见本次会话）
```

注：同一 `make check` 首次执行 exit 2（tail 截断，未捕获失败段）；当时另一支 agent 正在增删 `.agents/verify/` 证据文件（证据计数 86→87），docs-check 的相对链接检查处于并发写入窗口。随后独立复跑 `scripts/docs-check.sh` 与 `make check` 均 exit 0，且失败重跑前未改动本任务文件——判为并发窗口抖动，非本任务产物缺陷。

## 8. 未过项 / 需 lead 裁决

1. **kore main 未推送**：按任务口径分支推送归台账任务；本地 main 领先 origin 14 个提交（含他人在途提交），tag 已单独推两端。
2. **三插件仓未 tag**：按任务要求「版本随各自下一版发」；`go.mod` 已指向 v0.1.2，下次发版时 CHANGELOG/info.json 一并 bump。
3. **ssh-guard 的 `fail2ban-status` 调用点**：复核时另一支 agent 已在 `protection.go` 中接入该动作（`rootActionFail2banStatus`），`info.json` 未改动；本任务只报告，未修。
4. **waf `modsec-set-mode` 的 `argv[0]=/bin/sed`**：绝对路径形态合法（schema 允许规范化绝对路径），但 `/bin/sed` 不在命令名白名单中——符合协议（白名单约束的是命令名形态），若 lead 希望 sed 进入白名单需另走协议变更（ADR + 文档 + SDK 版本）。仅报告。
5. **`make check` 首跑 exit 2**：见 §7 注，并发证据文件写入窗口；二次运行 11/11 全绿。
