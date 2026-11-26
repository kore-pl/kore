# C13 PHP 证据修复独立复核（G-09 / task-145）

> 2026-11-26 · verifier `c13-php-fix-verifier`（非 c13-php-fix、非 c13-php-ext）· 只读复跑，不改任何生产/测试代码、不真装扩展、不联网、不执行主流程 CLI、不碰 `.kore-local-*`。
>
> 复核对象：php 仓 commit `9ae508708709919e815c3d7eac7c32cf9a2d1797`、kore 仓 commit `76545ffb61bcddcf2b2018ed3c9c7b1350c02b3f`。
>
> 目标：确认 task-143（commit a38c1ae，总评 BLOCKED）的两项缺口已消——① production 四类 fault × 三方法 **4/12 非全覆盖** + CHANGELOG「全覆盖」表述过强；② 自评桌面视口 sha 前缀笔误 `591a6f4c…`（实测 `b6f5005b…`）。

**总评：PASS** —— task-143 两项 BLOCKED 均已消，六项复核全 PASS。

| # | 复核项 | 结论 |
| --- | --- | --- |
| ①a | fault kinds(4)×methods(3) 双层循环、12 组合独立 subtest、每格 triple 断言 | PASS |
| ①b | 实跑 12 subtest 全 PASS + `go test ./...` 5 包全绿 + 生产代码未改 + dist sha 未变 + CHANGELOG 表述属实 | PASS |
| ② | selfeval sha 前缀订正为 `b6f5005b…`、实测 sha256sum 一致、旧前缀归零 | PASS |
| ③ | 两 commit 精确路径 + DCO + 未 push + worktree 仅主树 + 他人 dirty 原样 | PASS |

---

## ① fault 12 组合全覆盖

### ①a 代码结构（`kore-plugin-runtime-php/internal/phpop/ext_test.go:224-261`）

`TestExtFaultInjection` 已由原来的扁平 4 case 表改为 **双层循环**：

- `kinds` 4 项（`:225-234`）：`FaultKill`→`E_UPSTREAM`/`"信号 9"`、`FaultTimeout`→`E_UPSTREAM`/`"超时"`、`FaultDisk`→`E_INTERNAL`/`"磁盘满"`、`FaultCgroup`→`E_UNSUPPORTED`/`"cgroup"`。
- `methods` 3 项（`:235-242`）：`runtime-php.ext.install` / `.list` / `.remove`，各带合法 params。
- `for _, k := range kinds { for _, m := range methods { k, m := k, m; t.Run(string(k.kind)+"-"+m.method, ...) } }`（`:243-260`）= **4×3 = 12 个独立 subtest**，且用 `k, m := k, m` 做了闭包变量捕获修正。
- 每格（`:248-257`）断言三件事，**防假通过**：
  1. `perr == nil` → Fatal「未返回错误」；
  2. `result != nil` → Fatal「出错时不应带结果」；
  3. `perr.Code != k.wantCode || !strings.Contains(perr.Message, k.wantHint)` → Fatal（错误码 + 类别关键词）。
- 另有 `TestExtFaultSanity`（`:264-276`）证明无故障时三方法正常返回（非「永远失败」），与 fault 矩阵互补。

### ①b 实跑证据

**环境说明**：默认 `GOCACHE=/home/pt/.cache/go-build` 为只读（首跑报 `open .../go-build/...: read-only file system` / `FAIL [setup failed]`，exit=1）。按只读纪律**不改动该缓存**，改用单次 bash 调用内的临时可写 `GOCACHE=$(mktemp -d)`，全程 `GOPROXY=off`（依赖 `pluginapi v0.1.3` 已在 module cache 中，无需联网），跑完即 `rm -rf` 删除，工作区零残留。以下两条为最终有效执行。

**命令 1（12 subtest 全 PASS）**：
```
cd kore-plugin-runtime-php && CACHE=$(mktemp -d) && \
  GOPROXY=off GOCACHE="$CACHE" go test -count=1 -run '^TestExtFaultInjection$' -v ./internal/phpop
```
输出（完整 12 条 subtest）：
```
=== RUN   TestExtFaultInjection
=== RUN   TestExtFaultInjection/kill-runtime-php.ext.install
=== RUN   TestExtFaultInjection/kill-runtime-php.ext.list
=== RUN   TestExtFaultInjection/kill-runtime-php.ext.remove
=== RUN   TestExtFaultInjection/timeout-runtime-php.ext.install
=== RUN   TestExtFaultInjection/timeout-runtime-php.ext.list
=== RUN   TestExtFaultInjection/timeout-runtime-php.ext.remove
=== RUN   TestExtFaultInjection/disk-runtime-php.ext.install
=== RUN   TestExtFaultInjection/disk-runtime-php.ext.list
=== RUN   TestExtFaultInjection/disk-runtime-php.ext.remove
=== RUN   TestExtFaultInjection/cgroup-runtime-php.ext.install
=== RUN   TestExtFaultInjection/cgroup-runtime-php.ext.list
=== RUN   TestExtFaultInjection/cgroup-runtime-php.ext.remove
--- PASS: TestExtFaultInjection (0.00s)
    --- PASS: .../kill-runtime-php.ext.install (0.00s)
    --- PASS: .../kill-runtime-php.ext.list (0.00s)
    --- PASS: .../kill-runtime-php.ext.remove (0.00s)
    --- PASS: .../timeout-runtime-php.ext.install (0.00s)
    --- PASS: .../timeout-runtime-php.ext.list (0.00s)
    --- PASS: .../timeout-runtime-php.ext.remove (0.00s)
    --- PASS: .../disk-runtime-php.ext.install (0.00s)
    --- PASS: .../disk-runtime-php.ext.list (0.00s)
    --- PASS: .../disk-runtime-php.ext.remove (0.00s)
    --- PASS: .../cgroup-runtime-php.ext.install (0.00s)
    --- PASS: .../cgroup-runtime-php.ext.list (0.00s)
    --- PASS: .../cgroup-runtime-php.ext.remove (0.00s)
PASS
ok  	github.com/pengtang1024/kore-plugin-runtime-php/internal/phpop	0.005s
```
**12/12 subtest PASS，EXIT_CODE=0。**

**命令 2（5 包全绿）**：
```
cd kore-plugin-runtime-php && CACHE=$(mktemp -d) && \
  GOPROXY=off GOCACHE="$CACHE" go test -count=1 ./...
```
```
ok  	github.com/pengtang1024/kore-plugin-runtime-php	0.011s
ok  	github.com/pengtang1024/kore-plugin-runtime-php/internal/phpop	0.621s
ok  	github.com/pengtang1024/kore-plugin-runtime-php/tests/boundary	3.000s
ok  	github.com/pengtang1024/kore-plugin-runtime-php/tests/e2e	2.952s
ok  	github.com/pengtang1024/kore-plugin-runtime-php/tests/fault	0.007s
```
**5 包全 ok（含 tests/fault），EXIT_CODE=0。**

### ①c 生产代码未改 + dist sha 未变 + CHANGELOG 表述

- `git diff-tree --no-commit-id --name-only -r 9ae5087` → 仅 `internal/phpop/ext_test.go`；`git diff --numstat 9ae5087^..9ae5087` → `31 22 internal/phpop/ext_test.go`。`grep -v '_test.go$'` 后无输出 → **生产代码零改动**。
- dist 实测：`sha256sum dist/runtime-php-0.4.0.tar.gz` = `8e500b28cae4da6e08a5e47160a4f0ba17c734173438026b95b9582de4015a6e`；`sha256sum -c runtime-php-0.4.0.tar.gz.sha256`（从 `dist/` 内）→ `runtime-php-0.4.0.tar.gz: OK`（exit 0）；`kore-plugins/index/plugins.json:176` `"sha256": "8e500b28…"` 一致 → **dist sha 未变**。
- CHANGELOG `kore-plugin-runtime-php/CHANGELOG.md:7`：v0.4.0 条目明写「production 等级的四类故障（kill/timeout/disk/cgroup）× 三方法 fault 注入全覆盖，附无故障 sanity 防假通过」；经 ①a/①b 实测，**「全覆盖」表述现属实**（12/12 组合有独立 subtest + triple 断言）。

→ task-143 §①b BLOCKED（4/12 非全覆盖 + CHANGELOG 过强）**已消**。

---

## ② sha 前缀笔误订正

- `kore/.agents/verify/ui-c13-php-ext-selfeval.md:18` 原文：`四张图 sha256 各不相同（桌面视口 \`b6f5005b…\` / …）` → **已改为实测前缀**。
- 实测 `sha256sum .agents/verify/screenshots/ui-c13-php-ext-desktop-viewport.png` = `b6f5005b8a79ec356a5e784e3eefcc1c6bb996e410923ee76ade65a4643bfd97` → **前缀 `b6f5005b` 与自评完全一致**。
- 四图 sha 互异（佐证「非同图缩放」结论为真）：desktop-viewport `b6f5005b…` / desktop `befef373…` / mobile-viewport `a2625eb6…` / mobile `bfbfae90…`。
- 旧错前缀 `591a6f4c`：`grep -c '591a6f4c' .agents/verify/ui-c13-php-ext-selfeval.md` → **0**（原报告称该串在仓库中仅出现于此句，现已归零）。
- commit `76545ff` diff 为 **1 行替换**（1+/1-），正是把 `591a6f4c…` → `b6f5005b…`，无其他改动。

→ task-143 §⑤ 次要笔误**已消**。

---

## ③ git 纪律

| 项 | php `9ae5087` | kore `76545ff` |
| --- | --- | --- |
| 精确路径 | `internal/phpop/ext_test.go`（唯一文件，31+/22-） | `.agents/verify/ui-c13-php-ext-selfeval.md`（唯一文件，1+/1-） |
| DCO | `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` | `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` |
| 提交前缀 | `[agent:c13-php-fix] test(phpop): ...` | `[agent:c13-php-fix] docs(verify): ...` |
| 未 push | `origin/github/gitee main` = `9c9d677…`，均**不含** `9ae5087`（`merge-base --is-ancestor` exit=1） | `origin/github/gitee main` = `64e43f3…`，均**不含** `76545ff`（exit=1） |
| worktree | 仅主树 `/home/pt/Work/GolandProjects/kore-pl/kore-plugin-runtime-php [main]` | 仅主树 `/home/pt/Work/GolandProjects/kore-pl/kore [main]` |
| 他人 dirty | `?? internal/phpop/zeroparam_test.go` 原样保留、未提交 | `M scripts/usability-pending.txt` + 11 条 `??`（.agents/verify/*、data/、dist/ 等）原样保留、未提交 |

两 commit 均为各自仓 `main` HEAD，无 force/reset/rebase 痕迹；本 verifier 未 git add/commit 任何生产或测试文件。

---

## 收尾

- 隔离 GOCACHE（`/tmp` 临时目录）已在同一 bash 调用内删除；工作区无本复核残留（仅新增本报告）。
- 全程 `GOPROXY=off`，无联网；未 push；未执行主流程 CLI；未碰 `.kore-local-*`；未真装扩展。
- **总评：PASS**。task-143 两项 BLOCKED（production fault 4/12 非全覆盖 + CHANGELOG 过强表述；自评 sha 前缀笔误）均已消，可结案。
