> 状态: final · 归属: verifier(kore-verify-m1-code) · 更新: 2026-11-22 · 里程碑: M1

# M1 内核代码独立验收（目标提交 `aea6b16`）

verifier ≠ implementer（G-09）：全部命令由本人在只读检出中重跑，未复用任何实现者结论。

## 0. 范围与环境差异

- 验收对象：`aea6b16 feat(core): config、store、registry、supervisor、bus 与 installer`（65 文件）。
- 隔离方式：`git worktree add --detach /tmp/kore-verify-m1 aea6b16`（纯验证副本，无编辑）。
- 环境差异（已在结论中扣减）：非 root（uid=1000）且无 `/run/kore`，故所有 serve 用 `--config` 指到
  `/tmp/m1v/{state,log,run,plugins}`；`make idle` 首次测到 fd=77 系父 shell 继承（Electron/leveldb fd），
  后用 `python close_fds=True + start_new_session` 重启（模拟 systemd fd 隔离）复测，fd=8。
  内核 `7.0.0-44-generic`，24 核，`GOMAXPROCS=8`。
- 期间工作区出现未提交**代码**改动（超出交办所述"docs + dag_test.go"），已按提交 / 工作区双口径分别取证。

## A. 机械门禁（全部本人重跑）

| # | 命令 | 退出码 | 关键输出 | 判定 |
|---|---|---|---|---|
| A1 | `gofmt -l .` | 0 | 无输出 | PASS |
| A2 | `go vet ./...` | 0 | 无输出 | PASS |
| A3 | `go test -timeout 200s ./...` | 0 | 10/10 包 `ok`（cmd/kored + 9 internal） | PASS |
| A4 | `go test -race -count=1 ./...` | 0 | 10/10 包 `ok`，`race_exit=0` | PASS |
| A5 | `make build` | 0 | `bin/kored` = **7,262,370 B** ≤ 26,214,400 | PASS |
| A6 | `file bin/kored` | 0 | `ELF 64-bit LSB executable, x86-64, statically linked, stripped` | PASS |
| A7 | `go version -m bin/kored` | 0 | `CGO_ENABLED=0`、`GOAMD64=v1`、`-trimpath=true`、GOOS=linux/GOARCH=amd64 | PASS |
| A8 | `make check` | 0 | 6/6：docs 6 pass · dep 2/3 · 薄壳 OK · repo 5 pass · canonical 9 pass · log 8 pass | PASS |
| A9 | `make canonical-check` | 0 | `9 pass, 0 warn, 0 fail` | PASS |
| A10 | `make compat-info` | 0 | 五目标交叉产物全出（linux/amd64·arm64、windows/amd64、darwin/arm64·amd64） | PASS |
| A11 | `GOOS=windows GOARCH=amd64 go build ./...` / `GOOS=darwin GOARCH=arm64 go build ./...` | 0 / 0 | 无输出 | PASS |

## B. 关键行为复测（自造 fixture，未碰 `/var/lib`、`/run`）

| # | 场景 | 实测 | 判定 |
|---|---|---|---|
| B1 | 坏配置 `server.addr: 0.0.0.0:8787` | **exit 2**；stderr：`bad.yaml:2: server.addr MVP 只允许回环地址 127.0.0.1，实际为 0.0.0.0` | PASS |
| B2 | 两进程抢同一 state_dir | 第二个 **exit 3**；`状态库已被占用: .../state.db（持有者 pid=1131267）`，与 `pgrep -x kored` 一致 | PASS |
| B3 | `state.db` 写 4 KiB 随机字节 | **exit 4**；`状态库损坏: file size too small` | PASS |
| B4 | 改 `log.level: info→debug` + `server.addr` 后 `kill -HUP` | `config.reloaded` `applied:["log.level"]` `ignored:["server.addr"]`；`kill -0` 存活 | PASS |
| B5 | `go test -run TestHelloTimeoutKillsProcess -v ./internal/core/supervisor` | `--- PASS: (2.00s)`；日志 `E_UPSTREAM: 插件 slow 在 2s 内未连接，判定 hello 超时` | PASS |
| B6 | `go test -run 'TestParse\|TestCapab' -v ./internal/core/registry` | 全 PASS（含能力为空/重复/超上限/域非自身等子例） | PASS |
| B6b | 手工包 `foo-0.1.0.tar.gz`，`id=foo` 声明 `bar:read`，交 `kored install` | **exit 2**；`E_INVALID: capability="bar:read" 的能力域 "bar" 必须等于插件 id "foo"` | PASS |
| B7 | 含 `../evil` 条目的 `evil-0.1.0.tar.gz` | **exit 2**；`tar 条目 "../evil" 路径越界`；`plugins/evil` 不存在、`.staging` 空、`/tmp/evil` 未创建；同法合法包 `good` 安装 exit 0 为对照 | PASS |
| B8 | `make mem MEM_POINTS=5` | 中位数 **9,360 KiB**（min=max 9,360）· `RssAnon=2,948` · `RssFile=6,412` · 常驻插件 0；目标 8,192 未达（WARN）、红线 16,384 未越 | PASS(带 WARN) |
| B9 | `make idle` | 首测（脏 fd）：CPU 0 ms、线程 13、fd **77>64** FAIL、出站 0、定时器 FAIL。净环境复测：CPU **0 ms/60s**、线程 **12**、fd **8**、出站 **0**，定时器仍 **1 处未登记** → `idle: 4 pass, 1 fail`，**exit 2** | **FAIL** |

B9 定性：失败项不是"轮询"而是门禁口径与 G-19 冲突——`internal/core/supervisor/view.go:50`
`timer := time.NewTimer(timeout)` 为**请求级**定时器且 `defer timer.Stop()`，G-19 明文允许；
`Makefile:177` 却把 `internal/` 下任意 `NewTimer` 一律判 FAIL。内核空闲行为本身（CPU/线程/fd/出站）全绿。

## C. 代码质量抽检（只读）

| 项 | 命令/方法 | 结果 | 判定 |
|---|---|---|---|
| 单文件 >200 行 | `find internal cmd -name '*.go' \| xargs wc -l \| sort -n \| tail` | `cmd/kored/serve.go` 241、`registry/validate.go` 233、`registry/parse_test.go` 224、`store/store.go` 200 | 记录 |
| 函数 >50 行 | 括号配对脚本统计 267 个函数 | **0 个 >50**；最长 `installer/record.go:75 record` 48 行 | PASS |
| TODO | `grep -rn TODO internal cmd` | 3 处：`installer/manifest.go:13`(M1-07)、`installer/package.go:20`(M1-07)、`installer/signature.go:14`(M4) | 不阻断 M1 |
| G-21 | `grep -rn "SetGCPercent(-1)\|SetMemoryLimit(-1)" --include='*.go' .` | 0 命中 | PASS |
| G-19 轮询 | `grep -rn "time.NewTicker\|time.AfterFunc" internal/` | 0 命中 | PASS |
| G-01 薄壳 | `grep -rn "plugins/" internal/core` | 0 命中（`internal/ cmd/` 全仓亦 0） | PASS |
| G-24 any | `grep -rn "map\[string\]any" internal cmd`（去测试） | 2 处：`supervisor/stop.go:61` 控制载荷、`testdata/fakeplugin` | 记录 |
| G-16 syscall | `grep -rn "syscall\." internal/core` | 0 命中；仅 `internal/platform/*` 使用 | PASS |

## D. 一致性核对（`aea6b16` 口径）

| 项 | 实测 | 判定 |
|---|---|---|
| `cmd/kored/serve.go` 行数 | 241 行 >200；已在 `docs/MILESTONE-M0.md:172` 登记 D-1（拆 signals/runtime_limits，M1 收尾前） | 记录（已登记） |
| `triggers` 类型 | `registry/manifest.go:41-46` 仍是 `type Trigger struct{Type,Name string}`、`:68-69` `Triggers []Trigger`；`docs/PLUGIN-PROTOCOL.md:64` 写 `object[]` 且枚举 `http\|cli\|cron`，代码实际 `event\|schedule\|invoke` | **FAIL（阻断）** |
| `info.json` 必填字段 | 文档必填 14 项 vs 代码 `requiredKeys` 9 键（id,name,version,protocol,entry,capabilities,resources,requires_kore,triggers） | 见下表 |

逐字段对齐（文档"是" vs 代码强制）：

| 字段 | 文档必填 | 代码 | 结论 |
|---|---|---|---|
| id / name / version / protocol / entry / requires_kore / triggers / resources.memory_mb·cpu_quota·pids_max | 是 | 键存在性 + 值域校验 | 一致 |
| lifecycle | 是 | 可省略（缺省 `lazy`，G-14） | **不一致** |
| capabilities | 是 | 强制非空且 ≤16 | aea6b16 文档写"空数组合法"→ **不一致**（HEAD 已改文档，代码不变，现一致） |
| scenario_tags | 是（≥1） | 可选，出现才校验取值 | **不一致** |
| size_bytes | 是 | 可选，出现才校验非负 | **不一致** |

## E. 阻断级 vs 记录级

阻断级（3）：

1. **B-1 `triggers` 定案未落地**：`internal/core/registry/manifest.go:41-46,68-69` @`aea6b16` 仍为 object/struct；`docs/PLUGIN-PROTOCOL.md:64` 的枚举（http|cli|cron）与代码（event|schedule|invoke）互斥，且与"`[]string` + `<type>:<name>`"定案不符。owner: implementer + architect。修改项：提交已存在于工作区的 `manifest.go/validate.go/parse_test.go/installer/archive_test.go/supervisor/helpers_test.go` 与 docs 改动；验收 `grep -c "Triggers \[\]string" == 1` 且 `go test ./...` 10/10。
2. **B-2 `make idle` 恒红**：`Makefile:177` 把请求级 `time.NewTimer` 判为违规，与 G-19 白名单互斥（触发点 `internal/core/supervisor/view.go:50`）。owner: Makefile/scripts（首选：门禁识别 `defer .*Stop()` 的请求级定时器）或 supervisor（改用 `context.WithTimeout`）。验收：净环境 `make idle` 五项全 PASS。
3. **B-3 字段表 3 处不一致**（lifecycle / scenario_tags / size_bytes）：`docs/PLUGIN-PROTOCOL.md` §3.1 vs `manifest.go` `requiredKeys` + `validate.go` 的 `validateExtras`。违反 G-06（代码与文档不一致不得合并）。owner: architect + scribe。

记录级（6）：R-1 `serve.go` 241 行（已登记 D-1）；R-2 `registry/validate.go` 233 行（**未登记**）；
R-3 空载 VmRSS 9,360 KiB 高于目标 8,192（红线内，环境为 24 核）；R-4 TODO×3（M1-07 两处）；
R-5 验收期间工作区未提交代码改动 6 个文件（超出交办声明范围，已在后续提交落盘）；
R-6 `map[string]any` 两处（控制载荷 / testdata，非对外 schema）。

## F. VERDICT

**VERDICT: REVISE**（针对 `aea6b16`；阻断项 1 需提交，2 需修门禁或代码，3 需对齐文档）

HEAD 增量（本人复跑，非采信提交信息）：`1d4e4d0` + `3a59b98` 已把 `triggers` 改为 `[]string` 并同步文档
（`grep "Triggers \[\]string"`=1、`type Trigger struct`=0、`go test ./...` 10/10 `ok`）→ **B-1 已闭环**；
`view.go:50` 的 `time.NewTimer` 与 `Makefile:177` 均未变 → **B-2 仍红**；`requiredKeys` 仍 9 键、文档
lifecycle/scenario_tags/size_bytes 仍标"是" → **B-3 仍存**。故当前 HEAD 口径仍为 REVISE（剩 2 项阻断）。

## G. 清理自证（G-25）

本验收使用临时检出 `/tmp/kore-verify-m1`（detached `aea6b16`），已按 G-25 清理：
`git worktree remove --force` + `git worktree prune`；`git worktree list` 现 **1 行**（仅主工作树），
`git branch --list 'wt-*' 'tmp-*'` 为 0；`/tmp/m1v`、`/tmp/kore-verify-m1`、`/tmp/verify-*.log` 已删除；
`pgrep -x kored` 为空（无残留进程）。
