> 状态: draft · 归属: scribe · 更新: 2026-11-22 · 里程碑: M1

# M1 里程碑 · 行走骨架（能装 / 能跑 / 能停）

一句话：M1 把 M0 的纸面契约变成**一个可安装、可启动、可调用、可停止**的 Linux 二进制，以及一个只依赖公开 SDK 的验证插件。运行时结论 **PASS**、发布链 **P0 未闭环**（见 §5 第 0 项），证据见 [.agents/verify/m1-final-acceptance.md](../.agents/verify/m1-final-acceptance.md)（独立 verifier，全部命令本轮自跑）与 [.agents/JOURNAL.md](../.agents/JOURNAL.md) 的 2026-11-22 M1 复盘段。

## 1. 交付物清单（文件级）

### 1.1 内核模块（9 个中落地 7 个）

| 模块 | 路径 | 行 / 文件 | 职责 |
| --- | --- | --- | --- |
| config | `internal/core/config/` | 1,573 / 12 | 默认 → YAML → env 三层覆盖、未知键 WARN、SIGHUP 白名单热更 |
| store | `internal/core/store/` | 552 / 5 | bbolt 打开、6 个 bucket、schema v1、错误分类 |
| httpapi | `internal/core/httpapi/` | 597 / 7 | 标准库 `net/http` 手写路由、`/-/healthz`、system/info、插件启停与 invoke |
| registry | `internal/core/registry/` | 1,038 / 7 | `info.json` 9 必填 + 3 可选解析、`requires_kore` 区间、依赖 DAG |
| supervisor | `internal/core/supervisor/` | 1,399 / 12 | 拉起 / hello / ping / 停止 / 并发闸门（退避重启归 M1-12） |
| bus | `internal/core/bus/` | 379 / 3 | 每插件读写循环、pending map、超时、事件环形缓冲 |
| installer | `internal/core/installer/` | 1,423 / 16 | tar.gz 校验与原子安装、路径穿越拒绝、落盘布局 |

支撑包：`internal/core/envprobe/`（302 / 4，纯判定层 6 条 + capability report）与 `internal/platform/`（880 / 8，五接口 Linux 实现 + `!linux` 桩）。

**未交付（如实记录）**：`internal/core/auth/`（登录 / session / 双 cookie / CSRF / PBKDF2）与 `internal/core/market/`（商店安装）没有实现；`/api/v1/auth/*`、`/api/v1/store/*`、`/api/v1/events` 在 `httpapi/routes()` 显式回 `501 E_UNSUPPORTED`，不用 404 假装路由不存在。

### 1.2 公开 SDK

- `pkg/pluginapi/go.mod` — 独立 module `github.com/pengtang1024/kore/pkg/pluginapi`（可独立打 tag，插件不依赖内核源码树）
- `pkg/pluginapi/{protocol,frame,envelope,errors,timeout,doc}.go` + 4 个测试文件（705 行 / 10 文件）

### 1.3 主程序 `cmd/kored`（1,910 行 / 20 文件）

- `main.go` — 子命令分发与退出码 2/3/4/5/6
- `install.go` — `kored install --package <tgz>`
- `serve.go` + `serve_{boot,daemon,plugins,runtime,signals,shutdown,limits}.go` — `kored serve --config <path> --state-dir <dir>`

### 1.4 门禁（`make check` 9 段）

| 段 | 脚本 |
| --- | --- |
| 1 docs-check · 2 依赖白名单 + 兼容基线 | `docs-check.sh` · `dep-check.sh` + Makefile 内联断言 |
| 3 薄壳边界 · 4 跨仓库边界 | `thin-shell-check.sh` · Makefile `repo-check` |
| 5 口径唯一性 · 6 判断留痕台账 | `canonical-check.sh` · `log-check.sh` |
| 7 worktree 卫生 · 8 开源资产 | `wt-check.sh` · `oss-check.sh` |
| 9 大小写一致性 | `case-check.sh` |

`Makefile` 另有 build / cross / compat-info / vet / test / mem / idle / budget-check / frontend / clean / fmt 目标。

### 1.5 开源六件套

- `LICENSE`（MIT）、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`、`.github/workflows/ci.yml`

### 1.6 跨仓库

- `kore-plugin-echo` @ `v0.1.0`（`3422c10`）：`make dist` 产出 `echo-0.1.0.tar.gz`（1,258,020 B）+ `.sha256`
- 变更集 `CS-M1-01` 登记于 [.agents/BOARD.md](../.agents/BOARD.md) §5；索引仓 `kore-plugins` 不在 M1 交付范围

## 2. 可执行验收标准（逐条命令 + 期望）

| # | 命令 | 期望 |
| --- | --- | --- |
| 1 | `gofmt -l .` | 无输出，退出码 0 |
| 2 | `go vet ./...` | 无输出，退出码 0 |
| 3 | `go test -timeout 200s ./...` | 10 个包全部 `ok`（cmd/kored + 9 个 internal 包） |
| 4 | `go test -race -count=1 ./...` | 10 个包全部 `ok`，无 data race |
| 5 | `make build` | `[OK] 构建完成: ./bin/kored`，产物体积 ≤ 25 MiB |
| 6 | `make check` | 9/9 段全绿（docs 6 / dep 2 / thin-shell 4 / repo 5 / canonical 9 / log 8 / wt 4 / oss 8 / case 5），末行 `[OK] 门禁全部通过` |
| 7 | `make idle` | 5 pass / 0 fail：CPU ≤60 ms/60 s、Threads ≤20、fd ≤64、出站 0、Ticker/AfterFunc 零命中 |
| 8 | `make mem MEM_POINTS=60` | 主壳 VmRSS 中位数 ≤ 16,384 KiB（红线）；> 8,192 只记 WARN |
| 9 | `GOOS=windows GOARCH=amd64 go build ./...` / `GOOS=darwin GOARCH=arm64 go build ./...` | 均退出码 0（Tier B 交叉编译冒烟） |
| 10 | `make budget-check` | mem + idle + 进程数 + 二进制体积四项聚合，退出码 0 |
| 11 | `git clone ../kore-plugin-echo /tmp/x && cd /tmp/x && GOWORK=off go mod download && make dist` | 退出码 0（当前 **FAIL**：v0.1.0 tag 内容声明旧 module 路径，见 §5 第 0 项） |

端到端 11 步（`kore-plugin-echo` 装 → 起 → healthz → enable → invoke → `kill -9` → failed → disable → 404/409 → SIGTERM 退出 0）原文与关键输出见 [验收报告 §C](../.agents/verify/m1-final-acceptance.md)。

## 3. 关键指标（2026-11-22 实测，HEAD `1deb086`）

| 指标 | 实测 | 预算 / 阈值 | 判定 |
| --- | --- | --- | --- |
| 主壳空载 VmRSS | 中位 **9,664** / min 9,664 / max 9,744 / p95 9,744 KiB（60 点） | 目标 8,192 · 红线 16,384 | WARN（未越红线） |
| RSS 拆分 | RssAnon 3,040 · RssFile 6,624 KiB（源 `/proc/<pid>/status`） | 仅诊断，无绝对上限 | 记录 |
| 二进制体积 | 7,573,666 B（sha256 `cfb635f5…731572`） | ≤ 25 MiB | PASS |
| 空闲 CPU | 10 ms / 60 s | ≤ 60 ms | PASS |
| 线程数 | 13（`/proc/<pid>/status`，G-19 判据口径） | ≤ 20 | PASS |
| goroutine | 20（`SIGQUIT` 栈计数；无 pprof 端点，非门禁口径） | 参考 ≤ 20 | 边界，记趋势 |
| 打开 fd | 7 | ≤ 64 | PASS |
| 出站连接 | 0 | 0 | PASS |
| 生效锚点 | GOGC=50 · GOMEMLIMIT=6,291,456 · GOMAXPROCS=8（启动日志「资源锚点」；`/gc/gogc:percent` 由 `TestRuntimeLimitsKeepGCEnabled` 断言） | ADR-0015 默认档 | PASS |

## 4. 与 M0 的差异

| 维度 | M0 | M1 |
| --- | --- | --- |
| 代码量 | 0 行业务代码 | 11,047 行 Go（全仓含测试与夹具），7/9 内核模块 + SDK + CLI |
| 构建 | `make build` SKIP（无 `cmd/kored`） | 产出 `bin/kored`，静态、stripped、7.57 MB |
| 门禁 | 4 段，其中 2 段 N/A | 9 段全真跑，9/9 通过 |
| 运行形态 | 无进程 | `kored serve` + UDS + 插件 `enable/invoke/disable` 全链跑通 |
| 资源证据 | 无（记 N/A） | 60 点 VmRSS + RssAnon/RssFile + idle 五项 + 生效锚点 |
| 跨仓库 | 单仓 | `kore` + `kore-plugin-echo`，SDK 独立 module 与 tag |
| 外部可见性 | 本地仓库 | GitHub public + MIT + CI + 六件套 |

## 5. 明确延期项

0. **P0 · SDK tag 不可用（阻断收口）**：`pkg/pluginapi/v0.1.0`（tag `3a59b98`）的 `go.mod` 仍声明 `github.com/kore-project/kore/pkg/pluginapi`，干净 clone 报 `module declares its path as ... but was required as ...`；proxy.golang.org 已缓存该 `.mod`，**改写 tag 会让所有消费者校验和永久失败**。处置：在 `2616374`/`fc66a99` 切 `pkg/pluginapi/v0.1.1` + 在 `go.mod` 里 `retract v0.1.0`，echo 升 `require`，删本地 `go.work` 后 `GOWORK=off` 干净 clone 复验；复验通过前 M1 不置 completed（BOARD 已同步降级）。
1. `internal/core/auth`（PBKDF2 / session / 双 `Path=/` cookie / CSRF）与 `market`（`POST /api/v1/store/install`、`GET /store/jobs/{id}`）——M1 回 501，属 M1-05/M1-13 未完成。
2. web 壳（`web/dist/index.html` + `id="app"`，≤30 KiB）：仓库当前无 `web/`，随 M2 前端一起做。
3. 退避重启 / 心跳探测 / `run.json` 孤儿核对：supervisor 目前只累计 `restarts`，不做退避（`manager.go:8` 明示归 M1-12/13）。
4. capability 方法级细粒度校验（只校验"有没有声明"）、audit 写入（store 无 audit 接口）、bus 多路复用收口。
5. `internal/core/registry/validate.go` 241 行超单文件 200 行上限，未登记技术债（M0 遗留 D-1 的同类项，`serve.go` 已拆分闭环）。
6. bbolt mmap 页计入 `RssFile`（6,624 KiB 主体），归 M4 设计层瘦身；M1 不调阈值。

完整清单与教训见 [.agents/JOURNAL.md](../.agents/JOURNAL.md) 2026-11-22 M1 段的「遗留与技术债」。
