> 状态: final · 归属: verifier · 更新: 2026-11-22 · 里程碑: M1
> 验收对象: HEAD `2616374`（M1 最终验收） · 验收者: kore-verify-m1-final（独立于 implementer；全部命令本轮自跑，未复用任何实现者日志/结论）
> 环境: Linux x86_64 · go1.26.8 · uid=1000 非 root · 干净判定：验收开始时 `git status --short` 为空

# M1 最终验收（2616374）

## VERDICT: **PASS**

无阻断级问题；4 条记录级观察（见 §F），均不改变本次结论。

> **HEAD 漂移声明**：派发目标是 `2616374`；验收期间（01:48:20）并发追加了 `1deb086`（仅 `.agents/BOARD.md` +1 行，登记跨仓库变更集），无代码/文档门禁口径变化。A/B/C/D 的证据产生于 `2616374` 工作树；`make check` 亦在 `1deb086` 上复跑通过（下方 A 组末行）。

## A. 机械门禁

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `git status --short` | 0 | 空（验收开始时） |
| 2 | `git log --oneline -3` | 0 | `2616374` / `481b156` / `3a59b98` |
| 3 | `gofmt -l .` | 0 | 无输出 |
| 4 | `go vet ./...` | 0 | 无输出 |
| 5 | `go test -timeout 200s ./...` | 0 | 10 个包全部 `ok`（cmd/kored + 9 个 internal 包） |
| 6 | `go test -race -count=1 ./...` | 0 | 10 个包全部 `ok`（含 supervisor 3.99s / kored 10.94s） |
| 7 | `make build` | 0 | `[OK] 构建完成: ./bin/kored`，7,573,666 B |
| 8 | `make check` | 0 | 9/9 段全绿，`0 fail 0 warn`，末行 `[OK] 门禁全部通过` |
| 9 | `make canonical-check` | 0 | 9 pass, 0 warn, 0 fail |
| 10 | `make docs-check` | 0 | 6 pass, 0 warn, 0 fail（55 文档 + 12 证据，260 链接可达） |
| 11 | `make oss-check` | 0 | 8 pass, 0 warn, 0 fail |
| 12 | `make case-check` | 0 | 5 pass, 0 warn, 0 fail |
| 13 | `file bin/kored` | 0 | ELF 64-bit LSB, x86-64, statically linked, stripped |
| 14 | `go version -m bin/kored` | 0 | go1.26.8；`path github.com/pengtang1024/kore/cmd/kored`；`mod github.com/pengtang1024/kore`；pluginapi `=> ./pkg/pluginapi`；`CGO_ENABLED=0` / `GOARCH=amd64` / `GOOS=linux` / `GOAMD64=v1` / `-trimpath=true` |
| 15 | `GOOS=windows GOARCH=amd64 go build ./...` | 0 | 交叉编译通过 |
| 16 | `GOOS=darwin GOARCH=arm64 go build ./...` | 0 | 交叉编译通过 |
| 17 | `make check`（当前 HEAD `1deb086` 复跑） | 0 | 9 段全绿，同上，确认文档级追加不破坏门禁 |

依赖白名单核对：`go.mod` 第三方直接依赖 2 = `go.etcd.io/bbolt` + `gopkg.in/yaml.v3`（`golang.org/x/sys` 为 indirect），同仓 `pluginapi` 不计配额且 `replace => ./`，符合 G-02。

## B. 每个提交可构建（bisect 友好）

| 提交 | 命令 | 结果 |
| --- | --- | --- |
| `481b156` | `git archive → /tmp/vc` + `go build ./...` | `build=0` |
| `3a59b98` | 同上 | `build=0` |
| `1d4e4d0` | 同上 | `build=0` |

三个 `HEAD^` 前序提交均可独立构建；临时检出 `/tmp/vc` 已删除。

## C. 端到端手工复跑（全新状态）

环境适配：非 root 无法创建 `/run/kore`（默认 RunDir），故 serve 用 `KORE_CONFIG=/tmp/kore-v-XXXX/config.yaml` 把 `run_dir`/`log_dir` 指向临时目录，并同时设 `KORE_STATE_DIR`（与派发口径的差异仅此一处，属主机权限约束，非产品缺陷）。

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | `cd ../kore-plugin-echo && make dist` | exit 0，产出 `dist/echo-0.1.0.tar.gz`（1,258,020 B）+ `.sha256` |
| 2 | `./bin/kored install --package .../echo-0.1.0.tar.gz` | exit 0，输出 `installed echo 0.1.0` |
| 3 | `KORE_STATE_DIR=... ./bin/kored serve`（setsid + `env -i`） | 日志 `kore ready`，pid 1601564，socket `/tmp/kore-v-BQBdTU/run/kore.sock` |
| 4 | `curl --unix-socket .../-/healthz` | `{"status":"ok"}` |
| 5 | `POST /api/v1/plugins/echo/enable` | 200，`state=ready`，`pid=1602171`，`restarts=0` |
| 6 | `POST /api/v1/invoke/echo/ping` | `{"pong":true}`，响应头 `X-Request-Id: r-90a2b904655b984f` |
| 7 | `kill -9 1602171` → `sleep 1` → `GET /api/v1/plugins` | `state=failed`，`restarts=1`，`pid=0`（符合“failed 不自动重试”） |
| 8 | `POST /api/v1/plugins/echo/disable` | 200，`state=stopped`，`enabled=false`；`pgrep -x echo` 为空 |
| 9 | `POST /api/v1/plugins/ghost/enable` | 404，`{"code":"E_NOTFOUND","message":"插件 ghost 未安装"}` |
| 10 | 未 enable 时 `POST /api/v1/invoke/echo/ping` | 409，`{"code":"E_CONFLICT","message":"插件 echo 未启用…"}` |
| 11 | `kill -TERM <kored pid>` → 包装脚本捕获退出码 | `kored_exit_code=0`；`pgrep -x kored`/`echo` 均为空；`kore.sock` 与 `plugins/*.sock` 已清理 |

## D. 资源门禁（干净 fd 环境）

| 项 | 命令 | 退出码 | 实测 |
| --- | --- | --- | --- |
| 内存 | `make mem MEM_POINTS=5` | 0 | 主壳 VmRSS 中位数 **9,492 KiB**（min=max=9,492；RssAnon 2,928 / RssFile 6,564）；常驻插件 0 ≤ 3；合计 0 KiB |
| 内存判定 | 同上 | 0 | `[WARN] 主壳 VmRSS 9,492 KiB 超出目标 8,192 KiB、未越红线 16,384 KiB（记趋势，不阻断）`；硬红线通过 |
| 空闲 | `make idle` | 0 | **5 pass / 0 fail / 0 n/a**：CPU 0 ms/60s（≤60）· Threads 13（≤20）· fd **7**（≤64）· 出站 0 · Ticker/AfterFunc 零命中 |
| 空闲稳定性 | 同上 | 0 | Threads 13 → 13（差 0） |

采样说明：首次 `make idle` 因 `setsid` 仍继承 DSH Electron 的 60+ 个 fd（DawnGraphiteCache/app.asar 等）得到 76 fd 误报；改用 Python `close_fds=True` 从干净 fd 集启动后为 7 fd，上表为干净环境实测值（进程自身 fd = 0/1/2 + state.db + epoll + eventfd + UDS）。

## E. 一致性抽检

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 门禁编号 | `grep -o 'G-[0-9][0-9]' AGENTS.md \| sort -u \| tail -3` | `G-25` `G-26` `G-27`（到 G-27，连续） |
| 9 段描述 | `grep -rn "9 段\|9/9" CONTRIBUTING.md` | 命中第 9/10/43 行，明确写 **9 段**（含 `oss-check`、`case-check`） |
| 旧 8 段残留 | `grep -rn "8 段\|8/8" CONTRIBUTING.md .github/` | 零命中 |
| triggers 类型 | `grep -n "Triggers" internal/core/registry/manifest.go` | L62 `Triggers []string` |
| 9 必填 | `grep -n "requiredKeys" -A6 internal/core/registry/manifest.go` | L85–88：id/name/version/protocol/entry/capabilities/resources/requires_kore/triggers = **9 项**；3 可选（lifecycle/scenario_tags/size_bytes）与 `docs/PLUGIN-PROTOCOL.md:78` 逐字一致 |
| `map[string]any` | `grep -rn "map\[string\]any" --include='*.go' internal/ cmd/ \| grep -v _test.go \| grep -v testdata` | 零命中（G-24） |
| 周期定时器 | `grep -rn "time.NewTicker\|time.AfterFunc" internal/ cmd/` | 零命中（G-19） |

## F. 阻断 / 记录分级

**阻断级：无。**

记录级（不阻断，留痕跟踪）：

1. 主壳 VmRSS 9,492 KiB > 目标 8,192 KiB（红线 16,384 未越）——按 G-03“目标不判未完成”，记趋势；建议 M4 集中瘦身时复核（RssFile 6,564 KiB 占大头，先查页缓存/映射）。
2. 端到端 serve 用 `KORE_CONFIG` 覆盖 `run_dir`/`log_dir`（非 root 无法建 `/run/kore`）；生产 systemd 下应按默认 `/run/kore` 复测一次 fd/权限。
3. 空载采样对环境 fd 继承敏感；本次已用 `close_fds=True` 复测干净值（7 fd），建议 `make idle` 文档补一句“必须用 systemd 或 close_fds 启动测量”。
4. 本机 `cgroup delegation=false`，启动日志有“限额不生效 / SELinux 未强制 / kore-echo 用户不存在→socket 属主降级”三条环境 WARN；属宿主环境降级，非仓库缺陷，M1 验收不据此判失败。

## G. G-25 清理证明

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 工作树 | `git worktree list` | 仅 `/home/pt/Work/GolandProjects/kore`（1 行；当前 `1deb086 [main]`） |
| 临时分支 | `git branch --list 'wt-*' 'tmp-*'` | 空 |
| 临时目录 | `rm -rf /tmp/kore-v-* /tmp/vc` 后 `ls -d /tmp/kore-v-* /tmp/vc` | `no_kore_tmp_left` |
| 残留进程 | `pgrep -x kored` / `pgrep -x echo` | 均为空 |
| 工作区 | `git status --short` | 报告落盘前为空；落盘后仅 `?? .agents/verify/m1-final-acceptance.md`（本轮唯一写入） |

## H. 结论

M1 最终验收在 `2616374` 上 **PASS**：A/B/C/D/E 五组证据全部通过，上一轮两处阻断（`make idle` 定时器口径、9 必填/3 可选文档对齐）已闭环；无 file:line 阻断项需回派 owner。当前 HEAD `1deb086` 为纯台账追加，复跑 `make check` 仍 9/9 全绿。
