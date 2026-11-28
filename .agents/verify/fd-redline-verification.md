# fd 硬红线修复独立验收（task-354 · G-09）

> owner: fd-redline-verifier（非 fd-redline）｜日期: 2026-11-29 00:45–01:22 +08:00
> 被验收对象: commit `024abf26cf843972e6f677a0e9383254803f3d41`（10 文件，kored 0.1.7）
> 性质: 只读独立复跑（不改生产代码、不启主流程 CLI、不 push、不联网、不碰 `.kore-local-*` / 8787 / 宿主）
> **总评: PASS** — 归因成立、收敛到 fd 9（≤64）、功能无回归、红线口径未擅改、git 纪律齐全。

---

## 0. 前置：被验收 commit 与仓库基线

```
$ git rev-parse HEAD                     → 024abf26cf843972e6f677a0e9383254803f3d41
$ git branch --show-current              → main
$ git show --name-status --format='' 024abf2
  M  CHANGELOG.md
  M  Makefile
  M  README.md
  A  cmd/kored/fd_hygiene_linux.go
  A  cmd/kored/fd_hygiene_racetag.go
  A  cmd/kored/fd_hygiene_racetag_race.go
  A  cmd/kored/fd_hygiene_stub.go
  A  cmd/kored/fd_hygiene_test.go
  M  cmd/kored/main.go
  M  docs/CORE.md
  → 精确 10 文件，211 insertions / 4 deletions
$ git log -1 --format='%B' 024abf2 | grep Signed-off-by
  Signed-off-by: pengtang1024 <pengtang1024@qq.com>    ← DCO 齐全
$ for r in origin github gitee; do git rev-parse $r/main; done
  三端 main 均 212f979（HEAD 024abf2 不在其中）→ 未 push
$ git branch -a --contains 024abf2 → * main（仅本地 main）
$ git worktree list → 仅主树
$ git status --short → 验收前后一致：M scripts/usability-pending.txt + 若干他人 untracked
  （.agents/.agents/、e2e-*.md、.gocache-kore-014/015/016/、data/、dist/ 等）原样未碰
$ pgrep -a kored → NONE（无残留进程）
$ ls -ld .tmp/fd-redline → GONE（实现者临时资产已删净）
```
PASS。

---

## 1. 归因真实性（重点）：成立，无反例

### 1.1 代码路径坐实（读码）

| 项 | 证据 | 判定 |
| --- | --- | --- |
| 进程入口最早调用 | `cmd/kored/main.go` 的 `func main()` 首行即 `closeInheritedFDs()`，随后才 `os.Exit(run(...))` | 早于 netpoll / bbolt / HTTP 装配 |
| Linux 实现 | `fd_hygiene_linux.go`（`//go:build linux`）读 `/proc/self/fd`，只 close fd≥3，跳过 0/1/2；`syscall.Close` 成功才计数；procfs 不可读返回 0 不阻断；幂等 | 语义与「关继承 fd、留标准流」一致 |
| 非 Linux 降级 | `fd_hygiene_stub.go`（`//go:build !linux`）`closeInheritedFDs()/countOpenFDs()` 均 no-op（-1），注释明写不引入平台专有 syscall | G-16 成立；cross-build 五目标全绿实证 |
| race 兼容 | `fd_hygiene_racetag.go`（!race）skip reason=""；`fd_hygiene_racetag_race.go`（race）给出 skip 原因常量；测试首行按常量 `t.Skip` | 只跳过测试进程用例，不改生产路径 |
| 不放 runServe 的理由 | 实现者提供 verbatim 复现：把调用放 `runServe` 开头时 `go test ./cmd/kored` 触发 `runtime: epollwait on fd 3 failed with 9` / `fatal error: runtime: netpoll failed`（栈：`setRuntimeLimits` → `runServe` → `TestRunServeConfigErrorExit2`）；移到 `main` 后 go test 恢复 exit 0。测试二进制走 `_testmain.go` 不进 `main()` | 理由成立；非臆测 |

### 1.2 独立复算：受控 execve 继承 A/B（本 verifier 亲自跑）

实现者脚本已删，我不依赖其自述，自行构造决定性实验：
- 从父提交 `2a1ddde`（未修复）用 `git archive` 导出隔离源码（**不改工作树**），补入 gitignored 的 `web/dist` 副本（从工作树只读复制到仓外隔离目录）后编译 `kored-orig`（`kored 0.1.6`）；
- 从 HEAD 工作树编译 `kored-fixed`（`kored 0.1.7`）；
- 用 Python `subprocess.Popen(..., close_fds=True, pass_fds=[40 根管道])` 强制 40 个继承 fd 跨 `execve`，两个二进制各起一次隔离实例（非 8787 端口、独立 config/state/run/log/index，仓外临时目录）：

```
BINARY=kored-orig  PID=7  COUNT=49 HEALTHZ=200 INHERITED_SURVIVED=40
  breakdown: sockets=3 state.db=1 eventpoll=1 eventfd=1 inherited_pipes=40
BINARY=kored-fixed PID=20 COUNT=9  HEALTHZ=200 INHERITED_SURVIVED=2
  breakdown: sockets=3 state.db=1 eventpoll=1 eventfd=1 inherited_pipes=0
```

判读：未修复二进制把 40 个父进程 fd 全部继承下来（9 + 40 = 49）；修复二进制在同一污染下只保留自己的 9 个（继承项归零），且 healthz 仍 200。**这直接坐实「额外 fd 是 execve 继承、不是 kored 自己打开」**，并证明 close 不伤监听/网络。

另一次无 pass_fds 的 A/B（close_fds=True 与 False 各两组）：4 次全部 COUNT=9、sockets=3/epoll=1/eventfd=1/regular=4、healthz 200（当前 bash 调用上下文的父 fd 表本身较干净，Python spawn 也会清 non-inheritable fd，故未放大到 79；不作为归因主证据，仅作一致性旁证）。

### 1.3 实现者证据逐项核对（verbatim 原文 + 与我实测交叉印证）

| 证据 | 实现者原文要点 | 我的交叉核验 |
| --- | --- | --- |
| 干净 fd 表启动（未改二进制、close_fds=True 等价 systemd） | `COUNT=9`；0/1/2 + state.db + eventpoll + eventfd + 3 socket（1 TCP + 主 UDS + 自更新 UDS）；`epoll=1/eventfd=1/regular_file=4/socket=3`；VmRSS 14452 kB；healthz200/首页200/info401 | 与我独立 A/B 的 4 次 COUNT=9 组成逐项一致 |
| 父 bash 与 kored fd 集合逐项比对 | 未改二进制被污染 harness `COUNT=79`；父 bash FDS=73/75；公共目标按 readlink 逐项吻合：`/opt/DSH NEXT/resources/app.asar`、v8_context_snapshot、chromium pak、`/dev/shm/.org.chromium.Chromium.* (deleted)`、GPUCache/DawnWebGPUCache/DawnGraphiteCache、leveldb LOG/LOCK/MANIFEST/bdic、`/dev/dri/renderD128`、D-Bus/abstract UDS socket inode、eventpoll/eventfd/inotify/sync_file/pipe；harness 产物 distinct target 39 条 | 我在本会话直接 `ls -l /proc/self/fd` 得到 75 项、父 bash 74 项，类别与上述逐项吻合（app.asar×3、Chromium shm×14+、GPUCache/leveldb、socket、eventpoll/eventfd/inotify/sync_file）；无反例 |
| socket inode 归属 | `/proc/net/tcp` 只有 TCP 18931 属 kored；`/proc/net/unix` 只有主 UDS + 自更新 UDS 两个 `00000002` 项属 kored；其余 socket inode 均为 harness D-Bus/abstract UDS | 我的受控 A/B 里 kored 自身 socket=3 恒为 3，未随继承项增加，一致 |
| close 安全性实验（独立 `go run`） | `FD_BEFORE=74` → close 71 个 → `FD_AFTER_CLOSE=4` → `NET_LISTEN_OK 127.0.0.1:39193`、roundtrip `<nil>` → `FD_AFTER_NET=9`（自动补回 epoll/eventfd/socket） | 与我的受控 A/B（healthz200 + 修复后重新建立自身 9 fd）一致 |
| fd 卫生单测 | `FD_HYGIENE_OK before=79 closed=75 after=4`、`STDOUT_OK` | 我独立复跑非 race 单测得到完全相同输出（见 §3） |

### 1.4 反例检索结论

逐项检查是否存在「kored 自身泄漏」的替代解释：修复后 60s 稳定 fd=9 且组成为必需的监听/状态/事件循环 fd；受控继承 A/B 中只有继承项变化、自身 fd 恒为 9；干净表启动未改二进制也为 9。**未发现任何反例**；归因「kored 自身只开 9 个，其余约 70 个是 execve 继承的父进程 fd（app.asar/Chromium shm/GPUCache/leveldb/D-Bus UDS）」成立。

归因判定：**PASS（成立）**。

---

## 2. 收敛数据复算

### 2.1 数字自洽

- 修复前 COUNT=79 分类：`socket_total=12`、`anon_inode_total=12`（epoll 5 + eventfd 4 + inotify 1 + sync_file 2）、`pipe_total=2`、`regular_file_total=53`（含 harness 产物 39+）。合计 12+12+2+53 = 79 ✔。
- 修复后 COUNT=9 分类：`socket=3`（主 UDS + 自更新 UDS + TCP LISTEN）、`epoll=1`、`eventfd=1`、`regular_file=4`（0/1/2 + state.db）。合计 3+1+1+4 = 9 ✔。
- 收敛 79−9=70：实现者给出的分类差（socket 12→3 差 9、anon_inode 12→2 差 10、pipe 2→0、普通文件 53→4 差 49）合计 70 ✔（其消息中「68+2 舍入项」措辞不严谨，但逐项列表与总数自洽；我的受控 A/B 以整数 40 管道复现 49→9，无舍入问题）。
- 同一污染 harness：修复前/后采样均为 `close_fds=False` 的同一 harness；修复后 final 实例 60s 后仍 fd=9，无回升 → 稳定 ✔。

### 2.2 隔离实例与端点回归（我独立实测，非复用报告数字）

仓外临时实例（非 8787，端口 18941，独立 config/state/run/log/index，凭据 0600 且只经 stdin）：

```
SETPW_RC=0
HEALTHZ=200 {"status":"ok"}
ROOT=200 bytes=1551
INFO_UNAUTH=401
LOGIN=200 {"authenticated":true,...}
INFO_AUTHED=200 bytes=1087
FD_AFTER_60S=9
VMRSS=14828 kB（≈14.5 MiB，< 16 MiB 硬红线）
HEALTHZ_FINAL=200
```

实现者报告的 18931 实例 `FD_COUNT_AFTER_60S=9 / HEALTHZ=200 / ROOT=200 bytes=1551 / INFO_UNAUTH=401 / LOGIN=200 / INFO_AUTHED=200 / VmRSS 14748 kB` 与我独立实测同口径一致（VmRSS 14.5–14.7 MiB 波动属正常）。**收敛到 ≤64 成立、功能无回归**。

---

## 3. 门禁复跑（全部独立执行，命令 + 退出码）

> 环境：默认 GOCACHE 只读，故 `GOCACHE=<仓外可写目录>`、`GOMODCACHE=<工作区已缓存 .tmp/gomodcache>`（含 bbolt 1.5.0 / xsys 0.45.0）；`GOPROXY=off GOWORK=off`，全程无联网。

| 门禁 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 全仓测试 | `go test -count=1 -timeout 200s ./...` | **0** | 18 包：17 ok + web [no test files]；`go list ./... \| wc -l` = 18 ✔ |
| fd 单测（非 race） | `go test -count=1 -v -run TestCloseInheritedFDsSubprocess ./cmd/kored/` | **0** | `FD_HYGIENE_OK before=79 closed=75 after=4` / `STDOUT_OK` / PASS（真跑未跳过） |
| fd 单测（-race） | `go test -race -count=1 -v -run ...` | **0** | `--- SKIP` + 明确 reason（race runtime 预占 netpoll fd）；生产路径由 60s 实例与非 race 单测覆盖，跳过有据 |
| 全量门禁 | `make check` | **0** | 21/21 段全部 `[RUN]`；末行 `[OK] 门禁全部通过`；段 18 race 16 仓真跑全绿、段 19 全仓 -race 绿、段 21 pluginapi -race 绿（2 包零 DATA RACE）、段 17 交叉编译绿。段 20 usability 的 `A1 waf ZeroParam 真跑 FAIL` + `G-33 有新违规` 均标注 **WARN 级不阻断**，归因他人 dirty `scripts/usability-pending.txt`（删 17 条 A1 豁免）与存量 waf，非本次引入（git status 证实该文件 M，且我未改） |
| 交叉编译 | `make cross-build` | **0** | 五目标 linux/amd64、linux/arm64、windows/amd64、darwin/arm64、darwin/amd64 全通过（windows/darwin 证明非 Linux stub 可编译，G-16） |
| 版本约束 | `make version-check` | **0** | 内核 VERSION=0.1.7 覆盖 24 插件全部落在 `requires_kore` 上界 <0.2.0 内，不阻断 |

补充：实现者提及「首轮 -race 下 fd 单测 netpoll fatal，后加 race build tag 跳过」——我独立在 -race 下复跑确认为 SKIP 而非 FAIL，且非 race 下真跑 PASS，处理符合工程口径（测试进程 netpoll 已初始化，不能代表生产 main 路径）。

---

## 4. 红线口径与版本同步（未擅改）

```
$ git show --name-only --format='' 024abf2 | grep -E 'AGENTS|0016|RESOURCE-MODEL'
  → 零命中（commit 未碰任何红线口径文件）
$ sed -n '39p' AGENTS.md     → G-03 ... fd ≤ 64 ...（原样）
$ sed -n '25p' docs/DECISIONS/0016-resource-budget-final.md
  → | goroutine / fd / 出站 | ≤ 20 / ≤ 64 / 0 | — |（目标列仍为「—」，无目标档）
$ sed -n '36p' docs/RESOURCE-MODEL.md
  → | 空载 fd | 常驻 | ≤ 64 | 12–32 | 6 | ls /proc/<pid>/fd | wc -l |（单 PID 口径原样）
```
红线三处数值与口径**未被改动**。版本 0.1.6→0.1.7 四处一致：`Makefile:29 VERSION`、`cmd/kored/main.go:17 var version`、`docs/CORE.md:13 版本基线`、`README.md:146 当前版本`；`CHANGELOG.md:6` 有 `[0.1.7] - 2026-11-29` 完整条目（含归因、修复、验证、不 push 说明）。PASS。

---

## 5. 结论与边界

**总评 PASS。** 四项核心判据全部成立：
1. 归因成立：受控 execve 继承 A/B（40 继承 fd：未修 49 / 已修 9）+ 干净表启动 9fd + 父子 fd 集合逐项吻合 + /proc socket 归属，无反例；
2. 收敛达标：79→9（同一污染 harness、60s 稳定），9 ≤ 64 硬红线，主壳单 PID 口径；
3. 功能无回归：healthz/首页/login/authed system-info 全 200，go test/make check/cross-build/version-check 全 exit 0；
4. 红线未擅改、版本与 CHANGELOG 同步、git 精确 10 文件 + DCO、未 push、他人 dirty 原样、临时资产与进程清零、单 worktree。

诚实边界：
- 本验收未连外网、未启主流程 CLI、未碰 `.kore-local-*` / 8787 / 宿主；所有实例均为仓外隔离临时目录 + 非 8787 端口，采样后已清理。
- 实现者原始脚本/日志已按其纪律删除，本报告 §1.2/§2.2 的数字来自本 verifier 的独立复算，§1.3 的实现者原文为其消息 verbatim 转述并经交叉印证；未把任何未复跑的数字冒充实测。
- make check 段 20 的 2 处新违规为 WARN 级存量（他人 dirty），不是本次引入；本验收未修改 `scripts/usability-pending.txt`。
- 报告内临时 harness 与缓存位于 kore git 根之外的会话工作区缓存目录，验收收尾删除，不进入任何 git 提交。
