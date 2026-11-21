> 状态: draft · 归属: red-team · 更新: 2026-11-21 · 里程碑: M1
> 门禁登记: 里程碑: M0 ·（docs-check 2/6 只接受 M0 字面量，见 scripts/docs-check.sh:94/105；本文件在 M0 门禁周期内提交，缺陷记于 F-13 与 §5 G-17）

# 0001 · M1 事前验尸（pre-mortem）

假设 M1 已经在收尾复盘会上被判失败。本文从"死因"倒推，只写能被一条命令证实的死法：空话、原则、鼓励一律不收。
判定基线是 [ROADMAP.md](../../docs/ROADMAP.md) §5.2 的退出条件 E1–E6；任一条件无法用命令复现即算失败。攻击面锁定 M1 要证伪的三个不确定性：

| 编号 | 不确定性 | 对应退出条件 | 一句话判据 |
| --- | --- | --- | --- |
| U1 | Go 主壳能否空载 ≤8 MiB | E1 | 60 s 中位数 ≤ 8192 KiB |
| U2 | 插件仓库能否只靠 `pkg/pluginapi` 的 tag 独立构建并被加载 | E3/E4/E5 | 干净 clone 里 `make dist` + hello 成功 |
| U3 | 单二进制 + embed 前端形态是否成立 | E1 体积段 | `bin/kored` ≤ 26214400 B 且 UI 真能出 |

不在本文范围：具体实现方案、代码风格、进度排期。本文只产出可被 implementer 当验收清单用的失败条目。
运行期检查统一以 root 在测试机执行，最小配置 `KORE_CONFIG=/tmp/kore-test.yaml`（`paths.state_dir: /tmp/kore-state`，`server.addr: ""`）；未注明 `sudo` 的命令默认已在 root shell 内。

## 1. 失败场景清单

### F-01 GOGC=200 与 8 MiB 预算结构性互斥，RSS 门禁从 Sprint 3 第一天就红
- 触发条件：`GOGC=200` 让下一次 GC 目标 ≈ 3× live heap。空载 live heap 由 runtime 元数据（约 1.5–2 MiB）、bbolt mmap 已触页（约 64–256 KiB）、HTTP 连接缓冲、embed 目录表构成，实测常在 2.5–3.5 MiB → GC 目标 7.5–10.5 MiB，`ps` 中位数落在 8.5–11 MiB。而 [RESOURCE-MODEL.md](../../docs/RESOURCE-MODEL.md):120 写的是"堆峰值下降"，方向与 GOGC 语义相反。
- 早期信号：Sprint 3 第一次 `make mem` 采到 8600–11000 KiB；`GODEBUG=gctrace=1` 显示 `gc 12 @… 8.2+… MB goal` 而 live 只有 3 MB。
- 影响：E1（RSS ≤ 8192 KiB）失守 → M1 整体不成立；随后必然出现"调大预算"的提议，踩 RESOURCE-MODEL §9 反模式 14。
- 预案：先做 GOGC ∈ {100,150,200} × `GOMEMLIMIT=6MiB` 四组消融，各采 60 点中位数；若 100 也超，用 `/proc/<pid>/smaps_rollup` 拆 `RssAnon`（真堆）与 `RssFile`（embed/bbolt 文件页）——`RssAnon > 5 MiB` 才是实现问题，`RssFile > 2 MiB` 是启动路径全表扫描问题。降级方案：主壳默认 `GOGC=100`，把 200 降级为可选配置并回改 RESOURCE-MODEL（走 ADR）。
- 检查方式：`for g in 100 200; do GOGC=$g KORE_CONFIG=/tmp/kore-test.yaml ./bin/kored & sleep 60; p=$(pidof kored); for i in $(seq 60); do ps -o rss= -p $p; sleep 1; done | sort -n | sed -n 30p; kill $p; sleep 1; done`

### F-02 embed 把 sourcemap、`all:` 隐藏文件与构建缓存一起打进二进制，25 MiB 预算被"看不见的文件"吃掉
- 触发条件：[FRONTEND.md](../../docs/FRONTEND.md):236 用 `//go:embed all:dist`；`all:` 前缀会把 `.` 与 `_` 开头的文件一并收进来（`.vite/`、`.DS_Store`、`_headers`）。只要有人为排障打开 `build.sourcemap`（产物 `assets/*.js.map`，单文件常 200 KiB–1.5 MiB）或 `build.manifest`（Vite 落在 `dist/.vite/manifest.json`），它们就静默进二进制；接了体积分析插件还会有 `stats.html`。
- 早期信号：`du -b bin/kored` 在 M1 第一版就 12–19 MiB 且无解释；`strings bin/kored | grep -c '\.map'` 非 0；`find web/dist -name '*.map'` 有输出。
- 影响：E1 体积段余量被吃掉，M2 前端一加页面立刻破 25 MiB；sourcemap 进发布物等于把源码结构一起发出去（SECURITY §10 的供应链面）。
- 预案：构建期硬断言 dist 内禁止 `.map`/`stats.html`/`.vite`（`vite build --sourcemap false`）；embed 改为 `//go:embed dist`（不用 `all:`）或显式列 `dist/index.html dist/assets`；真超预算时先砍 embed 里未被 index.html 引用的资源，再砍预压缩未命中的大文件（应当只剩 `.gz`）。
- 检查方式：`find web/dist \( -name '*.map' -o -name 'stats.html' -o -name '.vite' \) | wc -l` 必须 0，且 `du -b bin/kored` ≤ 26214400。

### F-03 全新 clone 后 `go vet` / `go test` 编译期直接失败（embed 目录不存在），CI 从第 1 天就是红的
- 触发条件：`//go:embed` 所在包在 `web/dist` 不存在或为空时是**编译期错误**（`pattern all:dist: no matching files found`），而 `.gitignore`:13 忽略了 `web/dist/`。CI 与任何 fresh clone 跑 `go vet ./...`、`go test ./...` 都失败；本地因为残留 dist 而绿——"我这里能过"的经典形态。更坏的走法是有人提交 `web/dist/.gitkeep` 让编译通过，产出 UI 404 的二进制却被判 E1 通过。
- 早期信号：第一个干净 checkout 的 CI 红在 `go vet`；`git ls-files web/dist | wc -l` 为 0 而 `go build ./...` 本地通过。
- 影响：G1/G2/G3 三条门禁同时红，M1 无法合并；若靠占位文件绕过，E1 的"二进制可用"变成假绿，U3 的证伪结果不可信。
- 预案：二选一并写 ADR：① 仓库内提交一个 ≤1 KiB 的 `web/dist/index.html` 占位（含 `id="app"` 标记），`make frontend` 覆盖，`make build` 断言产物里该标记存在；② 用 build tag 拆 `embed_prod.go`（`//go:build !nofrontend`，真 embed）与 `embed_dev.go`（`//go:build nofrontend`，返回明确 503 + 构建提示），CI 的 vet/test 用 `-tags nofrontend`。禁止静默回退。
- 检查方式：`d=$(mktemp -d) && git archive HEAD | tar -x -C "$d" && (cd "$d" && go vet ./... ; echo "clean_clone_vet=$?")`；再跑 `KORE_CONFIG=/tmp/kore-test.yaml ./bin/kored & sleep 2; curl -s --unix-socket /run/kore/kore.sock http://localhost/ -o /tmp/ui.html -w '%{http_code}\n'; grep -c 'id="app"' /tmp/ui.html`

### F-04 超长帧被绕过：先 `make([]byte, n)` 后判断长度，一个 4 GiB 长度头就能打爆主壳
- 触发条件：解码器写成"读 4 字节 → 按 n 分配 → 再校验上限"，或直接用 `json.NewDecoder(conn).Decode(&v)` 完全绕过长度帧（粘包时把两帧当一个 JSON 读）。[SECURITY.md](../../docs/SECURITY.md):155 与 [CORE.md](../../docs/CORE.md):84 都要求"超限不读 payload、不分配"，但这两句是设计承诺，不是编译器能保证的事。
- 早期信号：单测里 `8388609` 与 `0xFFFFFFFF` 两个用例让测试进程 RSS 上 GB 或被 OOM killer 杀；`go test -fuzz` 10 分钟内出现 `runtime: out of memory`。
- 影响：E4（协议 4 方法 + 1 事件）只在"善意插件"下成立；ARCHITECTURE §8 的故障域承诺（单插件不能拖垮主壳）直接失效，且这是可被任意已装插件触发的远程 OOM。
- 预案：读满 4 字节 → 立即判 `n < 2 || n > 8388608` → 关连接并记 `frame_oversize`，判定前只允许 4 字节栈上缓冲；编码侧先算 payload 长度再写长度前缀；解码器只暴露 `readFrame(io.Reader)` 单一入口，禁止别处直接 `json.Decode(conn)`。
- 检查方式：`grep -rnE 'make\(\[\]byte, *(n|length|size)\)' pkg/pluginapi internal/core/bus | wc -l` 必须 0；`go test -run 'TestFrameOversize|TestFrameZeroLen' -v ./pkg/pluginapi` 必须过。

### F-05 半包 / 粘包处理错：`conn.Read` 单次返回就当初帧，症状是 1–3% 的随机 400
- 触发条件：`conn.Read(hdr)` 没循环；payload 用 `Read` 循环但没校验累计字节 == length；或插件一次 `write` 两帧时解码器只消费第一帧剩下的字节。UDS 上 `SOCK_STREAM` 语义与 TCP 相同，短读是常态不是异常。
- 早期信号：并发 100 次 invoke 里随机 1–3 条返回 `E_INVALID`，重跑就好；`strace -f -e trace=read -p <pid>` 能看到 read 返回 2。
- 影响：E4 在 CI 上时红时绿，最容易被判成"环境抖动"放过；随后所有超时/重试逻辑建立在一个会随机错帧的传输层上。
- 预案：两段式 `io.ReadFull`；`readFrame` 单测覆盖 1/2/3 字节分片、两帧合一包、帧尾半包；连接层一旦出现短读以外的错误立即整连接重建，不做"跳过坏帧继续读"。
- 检查方式：`go test -run 'TestFramePartial|TestFrameCoalesced' -count=200 ./pkg/pluginapi`；再加 `TestPingBurst`（同一 socket 上流水线发 100 个 ping，断言收满 100 个 pong）`go test -run TestPingBurst -count=100 ./internal/core/bus`。

### F-06 拉起即崩 → 重启风暴；根因之一是环境变量名在文档里就有两个版本
- 触发条件：退避计数只在 `ready` 之后累加，`starting` 阶段失败（exec 失败、`KORE_STATE_DIR` 无权限、插件读错 socket 变量）不计数 → 1 s 间隔无限重拉，60 次/分钟。而 [CORE.md](../../docs/CORE.md):134 注入的是 `KORE_PLUGIN_SOCK`，[PLUGIN-PROTOCOL.md](../../docs/PLUGIN-PROTOCOL.md):328 的 echo 示例读的是 `KORE_SOCKET` → echo 直接 `log.Fatal`，正好落进上面那条风暴。
- 早期信号：`journalctl -u kore | grep -c 'plugin.start'` 在 60 s 内 > 5；`ps -eo stat= | grep -c Z` 增长；`failed` 状态永远不出现（因为计数没到）。
- 影响：E4 完全失败（echo 从未 ready），CPU 被 1 s 重启循环吃掉，主壳 p95 ≤50 ms（ROADMAP §6）一起失守。
- 预案：计数在每次 `exec` 尝试前 +1，无论成败；`failed` 后只能人工 enable；两个变量名二选一并回改另一份文档（G-06 要求同检查点同步），echo 示例按最终名重写。
- 检查方式：`grep -rn 'KORE_SOCKET\|KORE_PLUGIN_SOCK' docs/ pkg/ | cut -d: -f1 | sort -u | wc -l` 必须 1；把测试副本插件换成 `#!/bin/sh\nexit 1` 后起 kore，`timeout 60 journalctl -u kore -f -o cat | grep -c starting` ≤ 5。

### F-07 socket 残留与 pid 复用：`kill -9` 一次主壳，重启后 exit 5；或孤儿清理误杀无关进程
- 触发条件：主壳被 `kill -9` 后 `/run/kore/plugins/echo.sock` 文件仍在，下次 bind 直接 `EADDRINUSE`（ARCHITECTURE §6.1 步骤 8 → 退出码 5）；反向错误是"无论谁持有的旧 socket 都 unlink"，把仍在运行的旧插件变成聋子。孤儿清理只比 pid 不比 `/proc/<pid>/stat` 第 22 字段 start_time（CORE §4.6 明确要求三项都匹配），pid 被系统复用后 `SIGTERM` 打到无关进程。
- 早期信号：`kill -9` 后重启出现 `exit code 5`；`ss -xlp | grep -c 'echo.sock'` 出现 2 个 inode；`grep -c 'start_time' internal/core/supervisor` 为 0。
- 影响：E2（healthz 200）在"重启一次"之后就不成立；误杀属于安全事故级别（可能是宿主业务进程）。
- 预案：bind 前 `Lstat`（拒 symlink）→ unlink → bind；只处理自己 id 的 `*.sock`，绝不碰 `.next.sock`；孤儿判定必须 pid 存活 + start_time 相等 + `/proc/<pid>/comm` 匹配，任一不匹配只删 socket 不动进程；systemd 加 `RuntimeDirectoryPreserve=no`。
- 检查方式：`kill -9 $(pgrep -x kored); sleep 1; ls -l /run/kore/plugins/ ; KORE_CONFIG=/tmp/kore-test.yaml ./bin/kored; echo "restart_exit=$?"` 必须 0；再手写 `run.json` 指向 `pid=1,start_time=0` 启动后 `pgrep -af '/plugins/' | wc -l` 必须 0 且 `kill -0 1` 仍成功。

### F-08 首启口令只会被打印一次，但它要么进了日志、要么谁都看不到、要么根本写不回配置
- 触发条件：三条要求互相打架——CORE:56 要求口令"只打印到 stderr/tty 一次"；CORE:89 要求 logger"启动期同时镜像 stderr"进 `kore.log`；SECURITY:177 禁止记录口令。systemd 下 stderr 默认进 journal，用户按文档去"看 stderr"其实看不到。另有致命分支：首启要把哈希写回 `/etc/kore/config.yaml`，而 CORE §7 的 `ReadWritePaths`（CORE:231）不含 `/etc/kore` + `ProtectSystem=strict` → 写回失败 → 退出码 2，或每次启动重新生成口令、上一次的口令当场作废。
- 早期信号：`grep -c "$PW" /var/log/kore/kore.log` ≠ 0；两次启动后 `grep -c 'auth.admin_initialized' /var/log/kore/kore.log` = 2；`stat -c %Y /etc/kore/config.yaml` 每次启动都变。
- 影响：E2 的前半段（未登录 401）能过，但"人能登录"这个隐含前提断了，E4 无法执行；同时踩安全红线（凭据进日志）。
- 预案：口令走 `os.Stderr` 直写（绕开 slog 与镜像逻辑，只对 raw fd 2 生效）；写回失败即退出码 2 并把 `/etc/kore` 加入 `ReadWritePaths`；文档写明"首启口令在 `journalctl -u kore -n 20`"，并给一条 `kored auth reset` 的恢复路径。
- 检查方式：首启后 `PW=$(journalctl -u kore -o cat | grep -oE '[A-HJ-NP-Z2-9]{24}' | head -1); echo "$PW"; grep -c "$PW" /var/log/kore/kore.log` 必须 0。

### F-09 `kore_csrf` 不设 Path → 缺省路径被锁在 `/api/v1/auth`，所有写请求 403，连 `kored invoke` 也 401
- 触发条件：[CORE.md](../../docs/CORE.md):54 明确写"不设 Path 限制"。RFC 6265 缺省 Path 取请求 URI 的目录部分 → 在 `POST /api/v1/auth/login` 下发时默认 `Path=/api/v1/auth`，浏览器只在 `/api/v1/auth/*` 回传；前端在 `/` 读 `document.cookie` 拿不到它 → 每个非 GET 都缺 `X-Kore-CSRF` → 403（SECURITY:98-99 三层 CSRF）。第二处：`kored invoke`（RESOURCE-MODEL §5.2 走同一 UDS）没有 Origin、没有 CSRF cookie，而 CSRF 只豁免 GET 与 login → CLI 永远 401。
- 早期信号：登录成功后 `/plugins` 页任何写操作 403；DevTools 里 cookie Path 显示 `/api/v1/auth`；`curl -c jar ... login` 后请求 `/api/v1/plugins` 时 Cookie 头里没有 `kore_csrf`。
- 影响：E4 的"安装 echo 包 → enable → invoke"全链在 POST 处断掉；症状像鉴权 bug，平均浪费 1–2 天。
- 预案：两个 cookie 都显式 `Path=/`；`kored invoke` 走 UDS 时按 `SO_PEERCRED` uid=0 豁免 CSRF 并在审计里记 `transport=uds`；把"登录 → 写操作"做成一条集成测试，不给手工回归留空间。
- 检查方式：`curl -si -X POST --unix-socket /run/kore/kore.sock http://localhost/api/v1/auth/login -d '{"username":"admin","password":"'"$PW"'"}' | grep -i '^set-cookie' | grep -c 'Path=/'` 必须 2。

### F-10 跨仓库 tag 依赖在 M1 期间是死锁：echo 要 `require kore v0.1.0`，而 v0.1.0 是 M1 结束时才打的 tag
- 触发条件：ROADMAP §1 规定 M1 → `v0.1.0`；REPOS:101 要求插件用 tag 依赖；但 M1 进行中该 tag 不存在 → echo 的 `go mod tidy` 直接 `unknown revision v0.1.0`。唯一出路 `replace` 与 `go.work` 都被明令禁止提交（REPOS:103-105、ROADMAP §5.2）。于是最常见的"解决办法"是提交 `replace ../kore`，本地全绿、CI 与用户全红。
- 早期信号：Sprint 1 第一天 echo 仓库 `go mod download` 报 `unknown revision`；随后 `git grep -n '^replace ' -- '*go.mod'` 出现命中。
- 影响：E3 与 E5 无法在"无 replace"前提下执行；靠 replace 通过的那次验收是假绿，U2（跨仓库依赖）这个核心不确定性等于没被证伪。
- 预案：先打 `v0.1.0-rc.1` 供 echo 依赖，M1 收尾打正式 `v0.1.0`；但 PLUGIN-PROTOCOL:90 明确拒绝 pre-release 匹配，二者冲突必须当场裁决（要么 `requires_kore` 接受 rc，要么 tag 策略改"先发 0.1.0 再回填 echo"）——写进 ADR，不许口头约定。
- 检查方式：`git ls-files | grep -cE '^go\.work(\.sum)?$'` 必须 0；`git grep -n '^replace github.com/kore-project/kore' -- '*go.mod' | wc -l` 必须 0；干净目录 `d=$(mktemp -d) && git clone <echo-remote> "$d/echo" && (cd "$d/echo" && go mod download && echo download_ok)`。

### F-11 `requires_kore` 解析器写错 → 所有插件被判 `E_UNSUPPORTED`，或反过来谁都能装
- 触发条件：G-02 禁第三方 semver，只能手写区间比较。典型错误：把 `">=0.1.0 <0.2.0"` 按字符串比较（`"0.10.0" < "0.2.0"` 为真）、漏掉 `<` 上界导致 0.3.0 也放行、把 pre-release 当正式版、解析失败静默当成"满足"。PLUGIN-PROTOCOL §3.1 只给两种合法写法，但没给用例表。
- 早期信号：`go test ./internal/core/registry -run RequiresKore -v` 只有 1–2 个用例；`grep -nE 'strings\.(Compare|HasPrefix)' internal/core/registry` 出现在版本比较处；echo 安装返回 `E_UNSUPPORTED` 但 message 里区间"看着是对的"。
- 影响：E4 失败；G-14 协议兼容门禁变成摆设；M2 起每个插件都可能被误判，且反向漏判会让不兼容插件装进来。
- 预案：固定用例表 7 条（`>=0.1.0 <0.2.0` vs `0.1.0 / 0.1.9 / 0.2.0 / 0.2.0-rc.1 / 0.0.9`，`>=0.1.0` vs `0.1.0 / 0.0.9`），逐段转 int 比较；解析失败=不满足；pre-release 策略与 F-10 的裁决保持一致。
- 检查方式：`go test -run TestRequiresKore -v ./internal/core/registry`；`grep -rnE 'strings\.(Compare|HasPrefix)\(' internal/core/registry/*.go | grep -c version` 必须 0。

### F-12 并发与长事务：一次 invoke 把审计写进 15 s 事务，goroutine 与 fd 一起涨
- 触发条件：DATA-MODEL §6.4 禁止事务内 IPC，但实现常把"写审计 + 调 bus"包进一个 `db.Update`；单写者串行（DATA-MODEL §6.1）→ 一次 15 s invoke 卡住登录、状态迁移、心跳写。另一侧：每次 invoke 起一个 `go func` 等响应，超时后只 return 不删 map 项；SSE 连接断开后 goroutine 停在 `Flush` 上不退出（RESOURCE-MODEL §9 反模式 9）。
- 早期信号：并发 invoke 时 `curl /api/v1/system/info` 的 `goroutines` 只增不减；`ls /proc/<pid>/fd | wc -l` 单调上升；日志出现 `tx_duration_ms=15000`，而两个文档给的长事务阈值不一致（CORE:49 是 >500 ms，DATA-MODEL §6.4 是 >200 ms），实现只会取一个。
- 影响：E1 的启动/延迟段（ROADMAP §6：p95 ≤50 ms）与 §7 的空闲 goroutine ≤20 同时失守；长事务还会把 bbolt 的 1 s 打开超时拖成启动失败。
- 预案：审计与状态写拆成独立小事务（目标 ≤1 ms），`bus.Call` 必须在事务外；等待表在超时/断连/取消三条路径上都必须 delete；SSE 每连接带 `context` + 30 s 写超时 + 断开即回收；两个长事务阈值统一到 DATA-MODEL 一处并回改 CORE。
- 检查方式：`grep -rn 'db\.Update' internal/ -A8 | grep -cE 'bus\.|supervisor\.'` 必须 0；跑 100 并发 invoke 后 `curl -s --unix-socket /run/kore/kore.sock http://localhost/api/v1/system/info | grep -o '"goroutines":[0-9]*'` 数值 ≤ 20。

### F-13 M0 遗留口径在 M1 第一天打架：实现者与 verifier 各引一份文档，互相打回
- 触发条件：M0 的口径矛盾在写第一行代码时同时生效，下面这条清单就是全部证据、不凑数——审计保留 30 天（SECURITY:175）vs 90 天（DATA-MODEL:147）；解包上限 1000 条/64 MiB（PLUGIN-PROTOCOL:61）vs 2000 条/128 MiB（CORE:70）；插件 id 正则 `{1,31}`（PLUGIN-PROTOCOL:59）vs `{1,30}`（SECURITY:149）；帧信封是否含 `req_id`（CORE:82 有，PLUGIN-PROTOCOL:224 无）；升级失败 409（CORE:159）vs 502 `E_UPSTREAM`（PLUGIN-PROTOCOL:291）；ADR-0001:44 的重开条件写着"需要 > 5 层中间件"，而 GLOSSARY:75 与 CORE §3 已定死 8 层；`plugins.autostart` 默认 `["site"]`（DATA-MODEL:58）而 M1 根本没有 site 插件；以及 docs-check 元信息硬编码 `里程碑: M0`（scripts/docs-check.sh:105），任何 M1 文档天生红。
- 早期信号：M1 第一周出现"按 CORE 写的被按 PROTOCOL 的人打回"；首启日志就有 `plugin site not found` 的 ERROR；`make docs-check` 在有人新建 M1 文档后立刻失败。
- 影响：每条矛盾至少吃掉一次返工 + 一次 G-06 文档同步；`autostart: ["site"]` 会让 E1 的"启动到就绪 ≤1s"变成"启动即 ERROR 噪音"；docs-check 会让 M1 的文档交付全部被判违规。
- 预案：M1 开工首日做一次"口径冻结"提交，逐条裁决并只改唯一真源（产物是一次小 diff，不是新文档）：数字取严（90 天、64 MiB、1000 条、`{1,30}`）；信封以 PLUGIN-PROTOCOL 为准并从 CORE 删 `req_id`；`autostart` 默认改 `[]`；docs-check 的元信息正则改为 `里程碑: M[0-4]` 并要求与文件自报一致；命中"被自己定的重开条件"的 ADR-0001 要么改条件、要么改设计，不能两条都留着。
- 检查方式：`grep -rl '保留 30 天\|保留 90 天' docs/ | wc -l` 必须 1（只允许 DATA-MODEL 这一处真源，SECURITY/CORE 改为引用）；`grep -rl '128 MiB' docs/ | wc -l` 必须 1；`grep -n 'autostart' docs/DATA-MODEL.md` 默认值必须是 `[]`。

## 2. 反向验收设计

开发者不会主动测的八条用例，全部要进 `make test` 或 `make gate`，不接受"手工验过"。

- **R-01 帧长度边界**：`8388608` 必须收、`8388609` 必须拒且 RSS 增长 ≤ 64 KiB、`0/1/2` 分别按"非法/非法/最小合法"处理；用合成 4 字节头直接打 socket，不经过客户端库。
- **R-02 分片投喂**：同一帧按 1/2/3 字节切片写入，`200` 轮内必须零错帧；再把两帧拼成一次 write，解码器必须连续产出 2 个响应。
- **R-03 并发 100 次 invoke + 超时混合**：95 次正常 + 5 次 `timeout_ms=1000` 打慢方法；断言 pong 计数 = 95、超时全 `E_UPSTREAM`、结束后 `goroutines ≤ 20`、`/proc/<pid>/fd` 前后差 ≤ 2。
- **R-04 插件崩溃循环**：把测试副本 `bin/echo` 换成 `exit 1`；断言 60 s 内拉起 ≤5 次、最终 `failed`、期间 `/-/healthz` 始终 200、主壳 RSS 中位数波动 ≤1 MiB。
- **R-05 `kill -9` 主壳后状态恢复**：先建立会话与启用 echo → `kill -9 kored` → 重启；断言 healthz 200、旧的 echo 进程被回收（`pgrep -fc '/plugins/echo/'` = 1，不是 2）、原 cookie 仍能访问 `/self`（会话在 bbolt 里）。
- **R-06 空 `web/dist` 构建**：`rm -rf web/dist && go build ./...` 的结果必须与 ADR 裁决一致；若通过，二进制必须能返回真实 `index.html`（`curl` 断言 `id="app"`），不允许"能起但 UI 404"。
- **R-07 只读状态目录启动**：`KORE_STATE_DIR=/var/lib/kore-ro`（`chmod 500`）；断言退出码 3、stderr 含路径与 `EPERM`、无 panic 栈、无半初始化 DB 文件残留。
- **R-08 bbolt 损坏与只读日志**：截断 `kore.db` 前 8 KiB 启动，断言退出码 4 且 message 给出 `kore.db.bak` 恢复指引；再把 `/var/log/kore` 改只读，断言主壳仍起、`/-/healthz` 200、写日志降级为 stderr 一次 WARN。

## 3. 如果只能砍三个功能

砍的顺序必须保护 U1/U2/U3，而不是保护交付物清单好看。每次砍都要 ADR（ROADMAP §9）。

1. **先砍前端壳（保留 embed 机制）**：把 Vue 3 + Vite + 路由 + SSE 面板全部推到 M2，只留一个 ≤1 KiB 的静态 `index.html` 进 embed。保留：`//go:embed` 链路、`/` 与 `/assets` 托管、二进制体积断言——U3 只需证明"前端能进二进制且体积可控"，不需要证明"面板好用"。这样 F-02/F-03 直接降级为 1 小时工作量。
2. **再砍 `kore-plugins` 的索引逻辑（保留空索引 + 校验脚本）**：M1 只交付 `index/plugins.json` 的 schema 与 sha256 格式校验脚本，不做条目读取、不做兼容过滤。保留：G-14 的 `requires_kore` 校验（它在 kore 侧，和索引无关）——U2 的兼容契约不依赖索引仓库。
3. **最后砍非必选协议能力（保留 4 必选方法 + `kore.event`）**：`kore.reload` 先实现为"读一次配置、成功返回 ok"的 no-op，热升级、SSE、`Last-Event-ID` 补发全部推迟。保留：hello/ping/shutdown 与事件通道的真实往返——U2 的证伪只需要这条最小链路。

不可砍底线（砍了就证明 M1 白做）：echo 独立仓库 + tag 依赖、`/-/healthz`、60 s RSS 采样脚本、`//go:embed` 的最小证明。

## 4. 对 architect 提案的预判

我还没看到提案，以下三条是按文档推断的最可能被低估项，以及我会要求补什么。

- **被低估 1：启动路径的延迟初始化**。提案大概率写"启动 ≤1s"，但不会写"启动后 60 s 内 RSS 不得增长"。实际上 bbolt 打开、registry 全量加载、embed 目录枚举都在启动路径上，一旦其中一处做全表扫描，RSS 第一秒就被锁死在不可回落的水平（F-01 的 `RssFile` 分支）。要求补：启动 5 阶段（config → store → registry → supervisor → httpapi）各自的 `/proc/self/smaps_rollup` 快照与门限，合计 ≤8 MiB 且任一阶段增量 >2 MiB 需给解释。
- **被低估 2：跨仓库的 tag 时序**。提案会把 kore 与 echo 当两条并行轨，默认 tag 已存在；实际是串行依赖（协议包先合入 → 打 tag → echo 才能 tidy → echo 才能 dist → kore 才能装）。要求补：变更集顺序图 + 谁打 tag + rc 策略 + `requires_kore` 是否接受 pre-release 的明文裁决（F-10 的死锁点）。
- **被低估 3：主壳崩了以后插件怎么办**。提案会写"插件崩不影响主壳"，这是单向的；反向（主壳 `kill -9` 后 resident 插件成孤儿、socket 残留、重启时 pid 复用）通常无人负责，而它同时决定 E2 与安全事故边界。要求补：`kill -9` 主壳、插件死循环 100% CPU 两组故障注入用例 + 观测判据（孤儿数、socket inode 数、主壳 p95 抖动）。

## 5. 门禁增强提议

现有 G1–G12 覆盖不到下面五类事故，建议 M1 起并入 `make check`（QUALITY-GATES §5 要求写明"防的是哪类事故"）。

- **G-13 帧上限不分配**：`grep -rnE 'make\(\[\]byte, *(n|length|size)\)' pkg/pluginapi internal/core/bus | wc -l` = 0 且 `go test -run TestFrameOversize ./pkg/pluginapi` 通过。防 F-04（远程 OOM）。
- **G-14 定时器与 goroutine 双白名单**：`grep -rn 'time.NewTicker\|time.NewTimer\|time.AfterFunc' internal/ | grep -v cert_renew | wc -l` = 0；空闲 `goroutines ≤ 20`、`fd` 60 s 内在 ±2 内。防 F-12（空转与泄漏）。
- **G-15 内存消融矩阵**：新增 `make mem-matrix`，对 GOGC ∈ {100,200} 各采 60 点中位数并打印 `RssAnon/RssFile` 拆分，任一组超 8192 KiB 即 fail。防 F-01（单点采样 + GOGC 方向错误）。
- **G-16 干净 clone 可构建**：CI 加 `clean-clone` job：`git archive HEAD | tar -x -C $(mktemp -d)` 后跑 `go vet ./...`、`go test ./...`、`make build`，必须与本地行为一致；同时断言 `git ls-files web/dist | wc -l` 与 ADR 裁决一致。防 F-03（本地绿、CI 红）。
- **G-17 跨仓库污染与文档唯一性**：`git ls-files | grep -cE '^go\.work(\.sum)?$'` = 0；`git grep -n '^replace github.com/kore-project/kore' -- '*go.mod'` = 0；`go list -deps ./cmd/kored | grep -c 'kore-plugin-'` = 0；关键数字唯一性（保留天数、解包上限、id 正则、socket 变量名各只允许 1 处真源），并把 docs-check 元信息正则改为 `里程碑: M[0-4]` 且与文件自报一致。防 F-10/F-13。

## 6. 回报

**最致命的 3 条失败场景**

1. **F-10**：echo 只能用 `require kore v0.1.0`，而这个 tag 是 M1 收尾才打的——不提交 `replace`/`go.work` 就装不上，提交了就假绿，U2 从未被真正证伪。
2. **F-06**：`KORE_PLUGIN_SOCK` 与 `KORE_SOCKET` 两个名字并存，echo 起不来，叠加"starting 阶段不计重启次数"→ 1 s 重启风暴，E4 与主壳延迟一起失守。
3. **F-01**：`GOGC=200` 在语义上抬高峰值堆，与 8 MiB 门禁方向相反；照文档实现，Sprint 3 第一次采样就会落在 8.5–11 MiB。

**我会拒绝放行 M1 的 2 条判据**

1. **内存证据判据**：若 RSS 结论只有一次采样、或只测了 GOGC=200、或没有 `RssAnon/RssFile` 拆分 —— 拒绝。必须给：GOGC 100/200 双跑 × 60 点中位数 × smaps 拆分，三者齐全且 ≤8192 KiB。
2. **跨仓库洁净判据**：若 echo 的构建依赖 `replace`、`go.work` 或一个尚不存在的 tag —— 拒绝。必须给：干净目录（无同级 kore 检出）里 `go mod download && make dist` 成功、`go list -m all` 只含 `github.com/kore-project/kore`、kore 侧 `git ls-files | grep -c go.work` = 0。
