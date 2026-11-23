> 状态: 实测 · 归属: verifier · 更新: 2026-11-23 · 里程碑: v1.0

# v1.0 资源预算实测（G-03 / G-19）

- 执行者：kore-rel-container（team task-139）｜对象：主实例 `127.0.0.1:8787`（kored pid 608004，**只读采样，未重启、未改配置**）
- 命令与退出码均在下方原文；**未做任何调参**（G-22），未改业务代码；仅新增本文件。
- 结论：**无硬红线超线**。`make idle` 的 1 项 FAIL 是**门禁白名单过期导致的误报**（见 §5），不是资源超线。

## 1. 汇总表（实测 / 红线 / 判定）

| 项 | 实测值 | 红线 | 判定 |
| --- | --- | --- | --- |
| 首屏 6 件套 gzip 合计 | **59,709 B**（58.31 KiB） | ≤300 KiB（307,200 B） | **达标**（余量 247,491 B） |
| 首屏 i18n 增量 gzip | 2,827 B | ≤3 KiB（3,072 B） | **达标**（余量 245 B） |
| 图表产物 gzip（懒加载，不计首屏） | 151,350 B | ≤160 KiB（163,840 B） | **达标** |
| 单二进制 `bin/kored` | **10,477,730 B = 9.99 MiB** | ≤25 MiB（26,214,400 B） | **达标** |
| 主壳空载 VmRSS | 中位数 **13,496 KiB = 13.18 MiB**（min 13,496 / max 13,552） | 红线 16,384 KiB（目标 8,192 KiB） | **达标**（超目标，WARN 记趋势，不阻断） |
| 常驻插件合计 RSS | 0 KiB（主实例空载，无 `kore-plugin-*` 进程） | 红线 49,152 KiB（目标 24,576 KiB） | **达标（空载场景）**；满载未测 |
| 同时常驻插件数 | 0 | ≤3 | **达标（空载场景）**；满载未测 |
| 空闲 CPU（60s 窗口） | **0 ms / 60s** | ≤60 ms（0.1%） | **达标** |
| 线程数 | 16（60s 内 16→16，差 0） | ≤20 | **达标**（goroutine 未测，线程数为代理指标） |
| 打开 fd | 14 | ≤64 | **达标** |
| 出站连接 | 0 | 0 | **达标** |
| goroutine | **未测**：`GET /debug/pprof/` → 404；`GET /api/v1/system/info` → 401（未授权），无可用只读暴露 | ≤20 | **未测** |

## 2. 首屏（`make frontend`，exit 0）

原文关键行：

```text
[INFO] index.html               gzip -9:    831 字节
[INFO] style.css                gzip -9:  18482 字节
[INFO] app.js                   gzip -9:  26158 字节
[INFO] shell.js                 gzip -9:  11411 字节
[INFO] i18n.js                  gzip -9:   1594 字节
[INFO] i18n-zh-CN.js            gzip -9:   1233 字节
[INFO] 首屏合计（gzip -9）: 59709 字节 / 预算 307200 字节（300 KiB）
[OK] 首屏体积达标：59709 字节 ≤ 307200 字节，余量 247491 字节
[INFO] i18n 增量（gzip -9）: 2827 字节 / 预算 3072 字节（3 KiB）· 余量 245 字节 → 达标
[OK] 图表产物体积达标：151350 字节 ≤ 163840 字节（懒加载，不计首屏）
[OK] dist 无 source map / .vite / 全量字体
```

- 产物规模：`web/dist` 37 文件 = 35 静态件 + 2 图表产物（19 视图模块 + 9 按需子模块）。
- 首屏 6 件套明细见上；首屏预算余量约 247 KiB（约 80.5% 未用）。

## 3. 二进制（构建到 /tmp，避免覆盖运行中的 bin/kored）

**G-29 处理**：主实例 kored（pid 608004）正持有 `bin/kored`（10,477,730 B，sha256 `044887a5…3093`）。为不替换运行态资产，用**同一 Makefile 配方**输出到 `/tmp/kored-budget` 测量：

```text
$ make build BIN=/tmp/kored-budget   # exit 0
[OK] 构建完成: /tmp/kored-budget
$ ls -l /tmp/kored-budget
-rwxrwxr-x 1 pt pt 10477730 ... /tmp/kored-budget
$ file /tmp/kored-budget
ELF 64-bit LSB executable, x86-64, ... statically linked, ... stripped
size = 10,477,730 B = 9.99 MiB ≤ 25 MiB → 达标（余量 15.01 MiB）
```

`bin/kored`（运行中旧构建）同为 10,477,730 B；本次构建与磁盘现有二进制同尺寸（同源码状态）。临时二进制已删除。

## 4. 主实例只读采样（pid 608004，未重启/未改配置）

```text
$ ps -o pid=,comm=,rss= -p 608004
608004 kored 13492
$ awk '/^VmRSS:|^Threads:/' /proc/608004/status
VmRSS:	   13492 kB
Threads:	16
$ ls /proc/608004/fd | wc -l
14
$ ss -tnp | grep pid=608004 | grep -v LISTEN | wc -l
0
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/debug/pprof/
404
$ curl -s http://127.0.0.1:8787/api/v1/system/info
{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
```

`make mem`（exit 0）：VmRSS 中位数 13,496 KiB（min 13,496 / max 13,552），RssAnon=4,932–4,988 KiB / RssFile=8,564 KiB；常驻插件 0（≤3）、合计 RSS 0 KiB。**WARN：13,496 KiB > 目标 8,192 KiB，未越红线 16,384 KiB**（按 G-03 记趋势、不返工）。

## 5. `make idle`（exit 2）与 `make budget-check`（exit 2）

```text
[OK] 空闲 CPU: 0 ms/60s（阈值 ≤60 ms）
[OK] 线程数(Threads): 16（≤20）；60s 内 16→16（差 0）
[OK] 打开 fd: 14（≤64）
[OK] 出站连接: 0
[FAIL] 周期性定时器 1 处（Ticker/AfterFunc，cert_renew 除外）
internal/core/scheduler/loop.go:18:	ticker := time.NewTicker(s.tick)
idle: 4 pass, 1 fail, 0 n/a
```

`make budget-check`：**3 pass / 1 warn / 1 fail**，fail 与 idle 同一项（周期性定时器）。

**判定：门禁误报，非资源超线。**
- G-19 原文：「禁止 `time.NewTicker` / `time.AfterFunc` / 周期循环，**唯一例外是 `internal/core/scheduler/`（单实例单 ticker）**」；ADR-0019 同口径。
- 实测唯一命中正是 `internal/core/scheduler/loop.go:18`，即被允许的 scheduler 单实例 ticker。
- `Makefile` 的 idle 目标用 `grep -v cert_renew` 排除，**未把 `internal/core/scheduler/` 加入白名单**（该白名单是历史写法），因此把合法 ticker 判为 FAIL。
- 处置建议（本轮不做，避免改代码）：把 idle 的 grep 过滤条件补为同时排除 `internal/core/scheduler/`；或改用 `grep -rnE ... internal/ cmd/ | grep -v 'internal/core/scheduler/'`。该项修复后 `make idle` / `make budget-check` 应转 5 pass / 全 PASS。**未调参、未改 Makefile。**

## 6. 未测项与边界

1. **goroutine 数未测**：主实例未暴露 pprof（404），管理 API 需授权（401）；用线程数 16（≤20）作为代理指标，但线程数 ≠ goroutine 数，不能据此判定 goroutine 红线达标。
2. **满载场景未测**：主实例空载（0 个常驻插件），因此「单插件 ≤24 MiB、合计 ≤48 MiB、同时常驻 ≤3」只验证了空载下界；需在装 2–3 个常驻插件的隔离实例补测（G-29 要求独立 `--config`）。
3. 采样对象是**共享主实例**（pid 608004），不是 systemd 干净环境启动；fd 14/线程 16 可能含继承自启动 shell 的部分，`make idle` 自身也提示「由当前 shell 直接启动可能继承父进程 fd」。fd 余量充足（14/64），结论不受影响。
4. 首屏与二进制为构建产物实测（同源码状态），未在浏览器实测首屏加载瀑布。

## 7. 结论

- **P0：无。** 硬红线全部达标（首屏、二进制、VmRSS、CPU、线程、fd、出站、空载插件数/RSS）。
- 目标项 1 条 WARN：VmRSS 13.18 MiB vs 目标 8 MiB（红线 16 MiB 内），属 G-03「记趋势、不返工」范围。
- 1 条门禁误报（scheduler ticker），需单独修 Makefile 白名单（非资源问题）。
- 未调参、未改代码、未重启主实例；本文件为唯一改动。

## 8. 后记（并发构建观察，非本轮操作）

本轮唯一构建是 `make build BIN=/tmp/kored-budget`（20:35，10,477,730 B / sha256 `044887a5…3093`），**未写 `bin/kored`**。测量结束后复查发现 `bin/kored` 于 20:38 被**另一并发 agent 重建**为 10,027,170 B / sha256 `da895ad8…d4ad`（仍 ≤25 MiB，不改变本表判定）；运行中的 kored（pid 608004）仍是旧 inode，未重启。此项仅记录并发事实，不作为本任务构建产物。
