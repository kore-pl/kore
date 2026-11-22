> 状态: draft · 归属: red-team · 更新: 2026-11-22 · 里程碑: M3
> 方法: 假设 M3 在收口评审被判失败，从死因倒推；只收能被一条命令或判据戳穿的死法。

# 0004 · M3 Local Proof & Audit 事前验尸（pre-mortem）

判定基线：[提案 0003](../proposals/0003-m3-local-proof-and-audit.md) §1 非目标 / §2 四轨道 / §3 风险表 R1–R4 / §4 验收出口，[AGENTS.md](../../AGENTS.md) G-07/G-17/G-19，[M2 验尸](0003-m2-premortem.md) §4 复验口径。提案已声明 R1–R4，本文专挑「风险写了、抓手没落到命令」与「测法和目标口径相矛盾」的死因；命中任一条即 M3 不成立。

**特别核查（web server 不内置）**：提案 §1 非目标第 19 行明确「不内置 / 不捆绑 web server」，列出 nginx / caddy / httpd 跟随可选插件、可替换、不装 site 插件即无能力、捆绑二进制直接退回；§4 验收出口第 5 条把 `grep -rn "nginx" internal/ cmd/` 零命中写成架构红线出口，并禁止 site 插件发布物捆绑三种 server。**按用户给定口径，非目标与验收出口均已写够，不列为修改建议**。仅剩一个非阻塞加固点：验收 grep 只守 nginx，caddy / httpd 无命令行抓手，靠文字约束。

## 1. 四条失败场景

### S-01 M3-A 模拟 fixture 冒充真实宿主（提案 R1 是否真的防住）
- 场景：R1 允许「本机无 nginx 时用容器 / 模拟 fixture + 在证据文件标注」，但 §4.1 的 PASS 条件只看 `nginx-coexist.sh` 退出 0、sha256 MATCH——模拟 fixture 跑绿再标注一行文字即可让 M3-A 计入「四轨全绿」。更隐蔽的死法：fixture 自己 `apt-get install nginx`、自造 `sites-enabled/default`，sha256 比的是自产自销的 vhost，不是宿主已有站点。M2 正是因 R6 未证明拖到 M3，M3 用同样方式再「证明」一次，等于原地打转。
- 触发条件：本机无 nginx / 无已有站点；fixture 内含安装 nginx 或生成 default_server 的步骤；证据文件写「容器 / 模拟」却仍给 M3-A 判 PASS。
- 影响：R6 真实宿主共存仍是未证明项，M3 收口把假证据当完成；宿主已装 nginx 的 VPS 上装 site 打断既有站点的安全事故被掩盖。
- 早期信号：`m3-nginx-coexist.md` 出现「模拟 / 容器」但 verdict 为 PASS；fixture 脚本出现 `apt-get install nginx` 或 `sites-enabled/default`；报告无宿主 nginx 版本与已有 vhost 清单快照。
- 提前发现（一条命令）：`grep -qE '模拟|容器' .agents/verify/m3-nginx-coexist.md && grep -q 'PASS' .agents/verify/m3-nginx-coexist.md && echo FAKE-PASS || echo OK` —— 输出 `FAKE-PASS` 即命中。

### S-02 M3-B 压测噪声 / 冷启口径让 p95 数据不可信
- 场景：目标写的是「lazy 冷启动 p95 ≤300 ms」，测法却是「20 次连打 exec→hello 取 p95」——20 次里只有第 1 次冷，后 19 次命中热页缓存，p95 必然落在热态，测的是热启动不是冷启动。R2 自己列了「重复两轮 p95 漂移 >100 ms」为触发信号，但 §4.2 只要求一轮 20 次报告，R2 的早期信号在验收流程里根本无法被触发；p95 落在噪声低谷即被记成达标。
- 触发条件：单次 20 连打、无重复轮次、无清页缓存；max/p50 >3；报告未记 HEAD 与后台编译 / 采样任务快照。
- 影响：软 SLO 变成「一次好运即达标」的纸面数字，G-19 证据链被污染；真实冷启超时被热态 p95 掩盖，装包首调用超时在用户侧复现。
- 早期信号：报告只有一组 p95；未记录 `git rev-parse HEAD`；max 与 p50 差 >3 倍；两轮重测漂移 >100 ms 却仍判达标。
- 提前发现（一条命令）：`test $(grep -c 'p95' .agents/verify/m3-lazy-p95.md) -ge 2 && grep -q "$(git rev-parse --short HEAD)" .agents/verify/m3-lazy-p95.md && echo OK || echo UNRELIABLE` —— 输出 `UNRELIABLE` 即命中。

### S-03 M3-C audit 同步落盘拖累空闲 CPU（G-19）
- 场景：R3 的缓解是「写时落盘、无轮询、禁 ticker」，但 §4.3 的轨道级验收只有 `go test -run TestAuditEventPersistence`——`make idle` 被放在 §4 末尾收口门禁里带过。两个漏口：① idle 窗口内若无四类事件，测不到写放大；② crash/restart 重启风暴下同步 fsync 串行阻塞 supervisor 事件路径，拖慢插件恢复，这是 CPU 之外冰山下面的冰山，提案只盯「空闲 CPU」。R3 自己列的「goroutine 常驻」触发信号在 §4.3 也无核对项。
- 触发条件：四类事件同步 fsync；60 s idle 窗口内注入事件；crash 连打 50 次；audit 包内出现 `time.NewTicker` / `time.AfterFunc` / 常驻 `go func`。
- 影响：G-19「空闲 60 s ≤60 ms、goroutine ≤20」红线破但仍判 M3-C PASS；事件风暴下插件恢复延迟，可用性回落。
- 早期信号：`make idle` CPU 逼近 60 ms；strace 见 audit bucket fsync 落在空闲窗口；go test 绿但 goroutine >20；crash 连打耗时线性增长。
- 提前发现（一条判据）：事件注入后跑 `make idle` 断言 CPU ≤60 ms、goroutine ≤20，且 `grep -rnE 'NewTicker|AfterFunc' internal/core/audit/ --include='*.go'` 零命中，否则命中本场景。

### S-04 M3-D 新端点绕过签名索引一致性
- 场景：R4 要「三端点复用索引级验签 + 包 sha256、未签名默认拒」，但 §4.4 把 `make store-check` 当成签名抓手——按 AGENTS.md，store-check 是 G-17 插件仓**三件套校验**（info.json / Makefile / CHANGELOG），根本不验索引签名或包 sha256。真正验签的只有 `go test -run 'TestStore_(Refresh|Presets|Update)'`，若其正反例没写全，「未签名仍默认拒」就只是文字承诺；`refresh` 把磁盘未签名索引刷进内存缓存、读侧不验，`presets` 从缓存返回未签名元数据，M2 的信任空窗从新端点重新裂开。
- 触发条件：改索引 1 字节后 refresh 仍接受；update 装 sha256 不符的包仍落盘；`allow_unsigned=true` 进默认配置；presets 端点读未签名缓存。
- 影响：G-10 零信任承诺破；M2 签名链前移的成果被新端点抵消；装到篡改包属安全事故级。
- 早期信号：`make store-check` 绿但手改索引字节后 refresh 仍成功；默认配置出现 `allow_unsigned`；update 落盘包 sha256 与索引不符。
- 提前发现（一条判据）：篡改 `index/plugins.json` 1 字节后依次调 refresh / presets / update，断言三者全拒且无落盘，同时 `grep -rn 'allow_unsigned.*true' internal/ docs/ --include='*.go' --include='*.md'` 零命中（审计测试例外除外），否则命中本场景。

## 2. 对提案的三条可执行修改建议

1. **收紧 M3-A 真实宿主口径**（对应 S-01）：在 §4.1 明文规定「证据文件标注容器 / 模拟时 M3-A 只能记 PARTIAL，不计入『四条轨道全绿』」，真实宿主共存不因模拟 fixture 而判完成；同时要求 fixture 快照宿主 nginx 版本与已有 vhost 清单，禁止脚本自装 nginx / 自造 `default_server`，杜绝自产自销证据。
2. **修正 M3-B 冷启动测法口径**（对应 S-02）：把「20 连打取 p95」改写为「每轮清页缓存 + 独立进程单次冷启，采 ≥20 个冷启样本算 p95」，并要求至少两轮独立采样、记录 HEAD 与后台任务快照；两轮 p95 漂移 >100 ms 判该轮无效需重测，不得以 WARN 放行。§4.2 同步更新。
3. **补齐 M3-C / M3-D 的命令行抓手**（对应 S-03 / S-04）：把「事件注入后的 `make idle`」提升为 M3-C 轨道级验收（CPU ≤60 ms、goroutine ≤20、audit 路径无 ticker）；并在 §4.4 明确 `make store-check` 只验插件仓三件套、**不是签名 gate**，另加「篡改索引 1 字节 → 三端点全拒 → allow_unsigned=true 零命中」正反例 gate。

## 3. VERDICT

**REVISE.** 提案 R1–R4 写全了风险文本，但 §4 验收出口存在三处口径错配：M3-A 允许模拟 fixture 冒充真实宿主判 PASS、M3-B 的 20 连打 p95 测的是热态而非声称的冷启动、M3-D 把只验三件套的 `make store-check` 当签名抓手；M3-C 把 `make idle` 降级到收口门禁，同步写放大与事件风暴无轨道级 gate。web server 不内置约束按用户口径已写够，不是阻塞项。三条建议落地后可由 verifier 复跑上文四条判据复审。

## 4. 复验（2026-11-22，提案 0003 修订后 60 行）

只核本文 §1 四条场景判据 + 加固点是否落实，不新增判据、不改提案。证据文件 `.agents/proposals/0003-m3-local-proof-and-audit.md`（下称 `0003`）。

- **S-01 模拟冒充：PASS** — `0003:34`/`0003:43` 含独立字段 `env_kind: real|container|simulated`（不与 verdict 混写）、`env_kind≠real` 记 PARTIAL 不计四轨全绿、禁自装 nginx / 自造 `default_server`、FAKE-PASS 反向命令输出须为 `OK`。
- **S-02 冷启测法：PASS** — `0003:26`/`0003:35`/`0003:44` 每轮 idle 退出后才计时、20 冷启样本（报告含 `冷启次数=20`）、两轮独立采样、漂移 >100 ms 判无效重测、只有 1 次冷启不算。
- **S-03 audit idle：PASS** — `0003:27`/`0003:36`/`0003:45` `make idle`（CPU ≤60 ms / goroutine ≤20）与 `grep -rnE 'NewTicker|AfterFunc'` 零命中升为轨道级阻塞 gate，明文不得降级到收口。
- **S-04 store 签名：PASS** — `0003:28`/`0003:37`/`0003:46` market 层独立验签正反例、`make store-check` 明示三件套非签名 gate、`grep -rn 'allow_unsigned.*true'` 零命中反向命令。
- **加固点：PASS** — `0003:47` grep 扩为 `grep -rnE "nginx|caddy|httpd" internal/ cmd/`。

**VERDICT: APPROVE** — 四场景判据 + 加固点全部落实，无新增判据，原 REVISE 阻塞项闭环。
