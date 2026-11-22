> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M4

# 提案：0004 · M4 Core Hardening（本机缺口坐实 / capability 根因 / site 生产化 / audit 查询）

承接 [M3 提案 §5 P2 延期项](0003-m3-local-proof-and-audit.md)、[PARITY-GAP §2.1 十必补](../../docs/PARITY-GAP.md) 与 [裁决台账](../LOG/DECISIONS.md) 第 35/37/40/42 条：把 M3 标为「未证明 / 挂账」的本机缺口逐条坐实为可复跑证据，并起第一批产品插件骨架。主线按裁决 35「本机优先」——本机 Linux amd64 全绿、行为可复现，再谈多平台。

## 1. 目标与非目标

**目标**：把 M3 挂账的三项本机缺口坐实成「命令 + 退出码 + 关键输出」（G-07）——①服务端 capability 目标操作校验（裁决 40 服务端根因 / 裁决 42 cap 层 RED，M4 第一优先级）；②site 真写 conf.d vhost（R6 共存；M3-A 若 `env_kind≠real` 只记 PARTIAL）；③audit 查询可观测（M3-C 只写不查，补齐审计按时间 / 动作过滤与 CSV 导出）。以此建第一批产品插件骨架：site 生产化 + 可复制到后续插件仓的 dist / 装卸 / 验签范式。

**非目标**：

- **多平台实机（P2 后延）**：依裁决 35，Windows / macOS / arm64 实机为降级目标；本里程碑只保留交叉编译冒烟，不为兼容性牺牲本机稳定性。
- **包级 ed25519 签名可延 M5**：索引级签名已在 M2 前移（公钥内置、未签名默认拒，信任空窗为 0）；包级签名按 [0003 §5](0003-m3-local-proof-and-audit.md) 归 M5，除非 M4-B 出包 / installer 需要才提前（见 M4-D）。
- **不内置 / 不捆绑 web server**（裁决 37）：web 服务器完全跟随 site 插件、按需对接宿主已安装的 nginx / caddy / httpd 等实现，可选可替换；不装 site 插件即无此能力，内核与插件发布物零 web server 二进制。
- **UI 客户端隔离不代替服务端修补**（裁决 40/42）：跨站独立 origin iframe + postMessage 桥只是兜底，服务端 capability 根因必须独立修，不以 UI 隔离冒充越权已修。

## 2. 四条轨道（M4-A ~ M4-D）

| 轨道 | 一句话目标 | 一句话验收命令 |
| --- | --- | --- |
| **M4-A 服务端 capability 校验** | 在管理端点按目标操作做 capability 校验，修 `middleware.go:101-111 authorizeTargetAction` 只查 session+CSRF 的 confused deputy 根因，使 PoC ①「带 session+csrf+site:read 仍 200」变 401。 | `go test -timeout 200s -run TestAuthorizeTargetAction ./internal/core/httpapi/...` 退 0，且 PoC ① 状态码 `200 → 401`。 |
| **M4-B site 插件生产化** | site 从只做参数校验的骨架变为真写独立 conf.d vhost 片段 + include，`nginx -t` 过且原 vhost sha256 前后一致（R6 共存），删站端口释放；web server 仅按需对接、绝不内置（裁决 37）。 | `bash tests/fixtures/site-vhost-e2e.sh`（建站→conf.d 真落→`nginx -t` 退 0→`curl` 200→删站端口释放→原 vhost `sha256 MATCH`），且 `grep -rnE "nginx\|caddy\|httpd" internal/ cmd/` 零命中。 |
| **M4-C audit 查询端点 / CLI** | 在 M3-C 只做写入的基础上补查询端点与 `kored audit --since`，可按时间与动作过滤并导出 CSV，补齐 M3 审计可观测挂账（对齐 G7 审计导出）。 | `go test -timeout 200s -run TestAuditQuery ./internal/core/httpapi/...` 退 0，且 `bin/kored audit --since <ts> --action plugins.enable --csv` 输出含目标事件行。 |
| **M4-D 包级 ed25519 签名** | 包级签名复用索引级同一 ed25519 公钥：若 M4-B 出包 / installer 需要则提前到 M4，使篡改包拒装；否则维持 M5 并留不出包证据。 | `go test -timeout 200s -run TestPackageSignature ./internal/core/market/...` 退 0（篡改 1 字节拒装 + 合法验签过）；若判 M5 则命令标 `N/A（M5）` 并附 M4-B 不出包证据。 |

## 3. 风险 4 条

| # | 风险 | 触发信号 | 缓解与验收抓手 |
| --- | --- | --- | --- |
| R1 | **capability 来源不稳（session subject 语义）**：session 未显式携带 subject / granted capabilities，校验靠约定字符串，换端点又越权。 | PoC ① 修好但另一管理端点仍 200；把 `system:admin` 当 `site:read` 子集；capability 混用业务域名词表。 | capability 仅用 6 个特权能力（`system:`/`net:`/`proc:` read/write）与通用 `<plugin-id>:<action>` 语法，内核不维护业务域名词表（G-01）；session 缺 subject / granted capabilities 即拒（fail-closed）；正反例覆盖「仅授 site:read 不得启 system:admin」与「合法提权仍过」。 |
| R2 | **site 真写配置不可回滚**：写前不备份、重复建站叠加 include / 端口冲突、`nginx -t` 失败残留半截 conf.d、删站不释放端口。 | 原 vhost sha256 前后不一致；重复建站出现重复 vhost；回滚后 conf.d 仍残留。 | 写前 `sha256sum` + 带时间戳备份；幂等由「站点 id → 固定文件名」保证覆盖不叠加；`nginx -t` 失败即逆序回滚（R6：不改主配置、不抢 default_server、原 vhost sha256 MATCH）；删站逆序清理并验端口释放。 |
| R3 | **audit 查询性能**：全表扫描随事件量线性变慢、`--since` 无上限拉全量、查询路径起 ticker 破 G-19、CSV 撑爆内存。 | `--since` 无参仍返回全量；查询 p95 随事件量线性涨；audit 路径出现 `NewTicker` / `AfterFunc`；`make idle` CPU 逼近阈值。 | 按时间戳 + 动作建索引，`--since` 必填且设上限 + 分页（默认 20 / 上限 100）；查询用请求级 `time.NewTimer` + `context.WithTimeout` 并 `defer Stop()`，禁周期定时器；CSV 流式写出；`make idle`（CPU ≤60 ms/60 s、goroutine ≤20）+ `grep -rnE 'NewTicker\|AfterFunc' internal/core/...` 零命中为轨道级 gate。 |
| R4 | **M4-D 与索引签名的密钥兼容窗口**：包级换密钥致索引级公钥与包级不一致，轮换期旧包被误拒或篡改包被接受。 | 索引 `.sig` 验签失败；新旧密钥无切换点；双验窗口里篡改包仍过。 | 包级复用索引级同一 ed25519 公钥（`market/verify.go:16` 与 `validate-index.sh:10` 逐字一致，裁决 33/34），不引入第二套密钥；必须轮换则先在索引签名链公告新公钥、设双验窗口、窗口结束再撤旧，且以 market 正反例（篡改 1 字节拒 / 合法过）证明；未做则明确标 M5，不制造兼容窗口。 |

## 4. 验收出口（M4 完成定义）

四条轨道各自可复跑命令全绿，并贴「命令 + 退出码 + 关键输出」（G-07）：

1. **M4-A**：`go test -timeout 200s -run TestAuthorizeTargetAction ./internal/core/httpapi/...` 退 0，PoC ① `200 → 401`；`grep -rn "plugins/" internal/core` 零命中（G-01 未回退）。
2. **M4-B**：`bash tests/fixtures/site-vhost-e2e.sh` 退 0，`nginx -t` 成功 + 原 vhost `sha256 MATCH` + `curl` 200 + 删站端口释放；`grep -rnE "nginx\|caddy\|httpd" internal/ cmd/` 零命中（零原生 web server）；证据含 `env_kind: real`，否则只记 PARTIAL、不计全绿。
3. **M4-C**：`go test -timeout 200s -run TestAuditQuery ./internal/core/httpapi/...` 退 0 + `bin/kored audit --since <ts> --action plugins.enable --csv` 含目标事件行；`make idle` CPU ≤60 ms/60 s、goroutine ≤20 且 audit 路径 ticker 零命中。
4. **M4-D**：`go test -timeout 200s -run TestPackageSignature ./internal/core/market/...` 退 0；或标 `N/A（M5）` 并附 M4-B 不出包证据（两条路径二选一，不留空）。
5. **收口门禁**：`make docs-check` 通过；`make check` **10/10** 全绿；**干净 clone**：`git archive HEAD | tar -x -C /tmp/kore-m4-clean` 后在该目录复跑 `make docs-check && make check` 同为 10/10、`make wt-check` 无残留 worktree，证明产物自洽、不依赖本地未提交状态（裁决 35：本机 amd64 可复现）。任一项不满足即不判 M4 完成，不降尺子、不把 WARN 冒充 PASS。

## 5. M5 预告（v1.1）

- **19 插件仓铺开**：按 [PARITY-GAP §2.1 G1/G5](../../docs/PARITY-GAP.md) 建齐 20 产品插件中余下 19 仓，逐仓 `make dist` 退 0 + 经商店装 / 卸 / 回滚五步齐全，索引 sha256 与发布物一致；M4 只交 site 骨架范式。
- **全矩阵**：8 个基础级插件升生产级（`tests/fault/` 四类 + G-20 复验），macOS / Windows 由 preview 转 GA 全链路（下载→校验→安装→启动），多平台为降级目标排在最后（裁决 35）。
- **包签名若未做**：M4-D 判 M5 时，此期落包级 ed25519 签名（复用索引公钥 + 双验窗口），使篡改包拒装、合法包验签通过，补齐供应链最后一环。
