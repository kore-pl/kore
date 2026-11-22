> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M3

# 提案：0003 · M3 Local Proof & Audit（本机加固 / 证据补齐 / audit 可观测）

## 1. 目标与非目标

**目标**：把 [JOURNAL M2 复盘 §5](../JOURNAL.md)「M2 没有证明的事」逐条变成**可复跑证据**，并补齐 audit 可观测性——主线定为「本机加固 + 证据补齐」，不追新能力，追的是把 M2 纸面口径坐实成命令 + 退出码 + 关键输出（G-07）。

具体对齐三条已登记事实：

- **宿主 nginx 共存 fixture**：M2 未单列该项命令输出，[0002 §5](0002-m2-sites-and-market.md) E2E-3 / R6 要求「`nginx -t` 退出 0 且原 vhost `sha256sum` 前后一致」，本轮记为未验证 → M3-A 补。
- **冷启动 p95**：M2 只证明 6 个功能用例 PASS，未做连打 20 次的 p95 压测报告，不得宣称 SLO 达标 → M3-B 补证据（软 SLO，超阈值不判 FAIL，但必须留记录）。
- **audit 写入 / store 剩余端点**：M1-09 audit 落盘遗留 + M2-B 只实现 7 个 store 端点中的 4 个 → M3-C / M3-D 补。

**非目标**：

- **多平台实机测试排 P2**：依 [裁决 35「兼容性与当前机器稳定性的优先级」](../LOG/DECISIONS.md)（当前机器优先、多平台为降级目标），任何改动先保证当前机器（本机 Linux amd64）门禁全绿、行为可复现；Windows / macOS / arm64 实机为降级目标，不为它们牺牲本机稳定性，故本里程碑不投入实机测试。
- **不做 M4 包签名**：插件包级 ed25519 签名属 M4（[JOURNAL §5](../JOURNAL.md) 与 [索引签名时机裁决](../LOG/DECISIONS.md)——索引级已前移到 M2）；M3 只消费已有索引级签名链，不引入包签名，也不把「索引验签通过」说成「包签名链路完整」。
- **不内置 / 不捆绑 web server**（用户新增架构红线）：web 服务器由 site 插件按需对接宿主已安装的实现（nginx / caddy / httpd 等，nginx 仅为可选之一），必须可选、可替换、跟随插件；**不装 site 插件就完全没有该能力**。**内置 web server 或捆绑任何 web server 二进制 = 违反「kore 是管理者、不给服务器增加原生负担」的定位与「资源零侵占」，直接退回；M3 更不得借「共存集成」之名把 nginx 塞进内核或插件发布物。**

## 2. 四条轨道（M3-A ~ M3-D）

| 轨道 | 一句话目标 | 一句话验收命令 |
| --- | --- | --- |
| **M3-A site 插件按需对接多种 web server** | 从"宿主 nginx 共存集成"改写为：`site` 插件**按需对接宿主已安装的多种 web server**（nginx / caddy / httpd 等，nginx 仅为可选之一），只写独立 `conf.d` vhost 片段 + include，不改主配置、不抢 `default_server`；内核与插件均不捆绑任何 web server 二进制，不装 site 插件就完全没有该能力，补上 R6 未证明项。 | `bash tests/fixtures/nginx-coexist.sh`（fixture 内：install 前 `sha256sum` 原 vhost → install → `nginx -t` 退 0 → 再 `sha256sum` 比对一致 → 逆序回滚），退出码 0 且输出含 `nginx: configuration file ... test is successful` 与 `sha256 MATCH`。 |
| **M3-B lazy 冷启 p95 压测** | 用真实数据记录 lazy 冷启动 p95 ≤300 ms，超阈值也照实记录实测值（软 SLO，不判 FAIL，但必须产出报告并入 G-19 证据）。 | `bash tests/fixtures/lazy-coldstart-p95.sh`（连打 20 次 exec→hello、采集耗时、输出 p50/p95/max 到 `.agents/verify/m3-lazy-p95.md`），退出码 0 且报告含实测 p95 数值与是否 ≤300 ms 的判定行。 |
| **M3-C audit 写入** | 把 `plugins.enable` / `plugins.disable` / `plugins.crash` / `plugins.restart` 四类事件落进 audit bucket，事件化持久化——写完即可查，不依赖下一次请求对账。 | `go test -timeout 200s -run TestAuditEventPersistence ./internal/core/audit/...`（触发四类事件后直接读 bucket 断言 4 条事件齐、且落盘发生在任何后续请求之前），退出码 0 且四类事件各 1 条 PASS。 |
| **M3-D store 剩余 3 端点** | 补齐 `refresh` / `presets` / `update` 三个 `/api/v1/store/*` 端点（[CORE.md](../../docs/CORE.md) §2.13 七端点口径，M2-B 只交付 4 个），返回统一响应包络且不破坏签名校验。 | `go test -timeout 200s -run 'TestStore_(Refresh\|Presets\|Update)' ./internal/core/httpapi/...` 且 `make store-check`，两者退出码 0、三端点返回 `{code,message,data}` 且未签名索引仍默认拒。 |

## 3. 风险 4 条

| # | 风险 | 触发信号 | 缓解与验收抓手 |
| --- | --- | --- | --- |
| R1 | **宿主 nginx 环境依赖**：本机可能没有 nginx 或没有「已有站点」宿主，fixture 跑不起来，R6 仍是未证明。 | `command -v nginx` 为空；容器内无 `sites-enabled/default`；`nginx -t` 因环境缺件报 `[emerg]` 而非配置冲突。 | 本机有 nginx 则用真实宿主；否则用容器 / 模拟 fixture（含一条 `default_server`）复现，并在 `.agents/verify/m3-nginx-coexist.md` 标注「容器/模拟，非真实宿主」——**标注环境不等于证明真实宿主**，真实宿主覆盖仍记 P2 残余风险，不冒充已验证。 |
| R2 | **压测噪声**：同机其它进程 / GC 抖动 / 冷页缓存让 p95 虚高，把软 SLO 记录成 FAIL 或反过来被偶发低值美化。 | 20 次样本 max 与 p50 差 >3 倍；重复两轮 p95 漂移 >100 ms；后台有编译 / 采样任务在跑。 | 固定采样窗口、记录 HEAD 与生效值（对齐 [内存证据协议裁决](../LOG/DECISIONS.md)），连打轮次写入报告；p95 >300 ms 只记 WARN + 实测值，不判 FAIL、不删样本，噪声来源在报告里明示。 |
| R3 | **audit 写放大影响空闲 CPU**：四类事件同步落盘拉高空闲 CPU / I/O，破 G-19「空闲 60 s ≤60 ms」与「出站 0」红线。 | `make idle` CPU 时间逼近 60 ms；audit bucket fsync 出现在空闲窗口；事件写入触发后台 goroutine 常驻。 | 事件化持久化走「写时落盘、无轮询」，禁止为 audit 起 ticker / 周期 flush（G-19 零命中）；audit 只在事件发生时同步写、不设定时批处理；`make idle` 与 `make budget-check` 收口核对 CPU / goroutine / fd。 |
| R4 | **store 端点与签名索引一致性**：新增 `refresh` / `presets` / `update` 绕过索引签名与 sha256 校验，或缓存读到未签名索引，复现 M2 的信任空窗。 | `refresh` 拉近未签名索引被接受；`update` 装包 sha256 不符仍落盘；`allow_unsigned=true` 出现在默认配置。 | 三端点复用 [索引签名时机裁决](../LOG/DECISIONS.md) 的索引级验签 + 包 sha256 校验，未签名默认拒、`allow_unsigned` 禁入默认配置；`make store-check` + 验签正反例随 M3-D 同批复跑，命中即回滚冻结。 |

## 4. 验收出口（M3 完成定义）

四条轨道各自的可复跑命令全绿，且贴出「命令 + 退出码 + 关键输出」（G-07）：

1. M3-A：`bash tests/fixtures/nginx-coexist.sh` 退出 0，`nginx -t` 退 0、原 vhost `sha256sum` 前后一致；环境为容器/模拟时在证据文件标注。
2. M3-B：`bash tests/fixtures/lazy-coldstart-p95.sh` 退出 0，`.agents/verify/m3-lazy-p95.md` 含 20 次实测 p50/p95/max 与 ≤300 ms 判定行；超阈值只记 WARN、不判 FAIL。
3. M3-C：`go test -timeout 200s -run TestAuditEventPersistence ./internal/core/audit/...` 退出 0，四类事件各 1 条 PASS、无请求对账依赖。
4. M3-D：`go test -timeout 200s -run 'TestStore_(Refresh|Presets|Update)' ./internal/core/httpapi/...` 与 `make store-check` 均退出 0，三端点包络统一、签名校验未被绕过。
5. **零原生 web server（架构红线）**：`grep -rn "nginx" internal/ cmd/` 必须零命中（内核零原生 web server 证据，现状已满足）；site 插件发布物中不得捆绑 nginx / caddy / httpd 任何 web server 二进制——web 能力只随插件按需对接、可选可替换，不装 site 插件即无此能力。

**收口门禁**：`make docs-check` 通过；`make check` **10/10** 全绿；`make idle` / `make budget-check` 核对空闲 CPU / 常驻预算未因 audit 与端点回归；本机（Linux amd64）行为可复现——同一命令二次运行结果一致。任一项不满足即不判 M3 完成，不降尺子、不把 WARN 冒充 PASS。

## 5. P2 延期项（本里程碑不投入，依裁决 35 本机优先）

| 项 | 延期理由 | 预计归位 |
| --- | --- | --- |
| Windows / macOS 实机测试 | 多平台为降级目标，不为兼容性牺牲本机稳定性；M2 仅交叉编译，实机语义仍是纸面。 | 本机门禁稳定后按 Tier B 降级矩阵排期 |
| arm64 门禁 | 同上，架构矩阵让位本机 amd64 证据闭环；交叉编译可保留冒烟，但不设为本机验收前置。 | 与多平台实机同批 |
| `oneshot` 运行期支持 | [JOURNAL §5](../JOURNAL.md) 列为 M3 前置，但本里程碑聚焦「本机加固 + 证据补齐」，oneshot 属新能力、与证据主线无关。 | M3 证据闭环后单独排期 |
| bus 多路复用 | M1-12 遗留（并发订阅与有序投递），属能力增强，不阻塞本机可复现性。 | 同上 |
| 心跳退避 | M1-13 遗留（重连指数退避 + 孤儿核对），属运行时增强，且 G-19 要求出站 0、无轮询。 | 同上 |
| 包签名（M4） | 插件包级 ed25519，索引级签名已在 M2 前移；按既定 M4 排期，不提前到 M3。 | M4 |
