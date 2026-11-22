> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M4

# 提案：0004 · M4 Core Hardening（本机缺口坐实 / capability 根因 / site 生产化 / audit 查询）

承接 [M3 提案 §5 P2 延期项](0003-m3-local-proof-and-audit.md)、[PARITY-GAP §2.1 十必补](../../docs/PARITY-GAP.md) 与 [裁决台账](../LOG/DECISIONS.md) 第 35/37/40/42 条：把 M3 标为「未证明 / 挂账」的本机缺口逐条坐实为可复跑证据，并起第一批产品插件骨架。主线按裁决 35「本机优先」——本机 Linux amd64 全绿、行为可复现，再谈多平台。

## 1. 目标与非目标

**目标**：把 M3 挂账的三项本机缺口坐实成「命令 + 退出码 + 关键输出」（G-07）——①服务端 capability 目标操作校验（裁决 40 服务端根因 / 裁决 42 cap 层 RED，M4 第一优先级）；②site 真写 conf.d vhost（R6 共存；M3-A 若 `env_kind≠real` 只记 PARTIAL）；③audit 查询可观测（M3-C 只写不查，补齐审计按时间 / 动作过滤与 CSV 导出）。以此建第一批产品插件骨架：site 生产化 + 可复制到后续插件仓的 dist / 装卸 / 验签范式。

**先决定义：subject 来源与能力绑定（M4-A 的地基，不许含糊）**：

- **subject 只能来自服务端已验签的 session**：即 bbolt `sessions` bucket 中以 `sha256(kore_session cookie token)` 为 key 的记录，其 value 的 `subject` 字段（`admin`，[DATA-MODEL §sessions](../../docs/DATA-MODEL.md)）由登录时服务端签发。请求头 / body 里的 `subject`、`X-Kore-Subject`、query 参数一律**忽略**，不参与鉴权、不参与能力解析。
- **subject → granted_capabilities 绑定只在服务端解析**：单管理员 subject `admin` 绑定 `system:admin`（覆盖 `system:`/`net:`/`proc:` read+write 六个特权能力）；插件 subject 绑定 `plugins` bucket 中该插件启用时写入的 `granted_capabilities`。管理端点只认「session subject 经服务端绑定解析出的能力集」，不认客户端自报；跨站独立 origin iframe 的插件桥（裁决 40）永不开放管理 API。
- **fail-closed 三类**：token 不在 `sessions` / 已过期 / `subject` 缺失 → 401；伪造 subject 头但 session 无对应能力 → 401/403；仅授 `site:read` 访问需 `system:write` 的端点 → 401/403。三者都是轨道级 gate。

**非目标**：

- **多平台实机（P2 后延）**：依裁决 35，Windows / macOS / arm64 实机为降级目标；本里程碑只保留交叉编译冒烟，不为兼容性牺牲本机稳定性。
- **包级 ed25519 签名可延 M5**：索引级签名已在 M2 前移（公钥内置、未签名默认拒，信任空窗为 0）；包级签名按 [0003 §5](0003-m3-local-proof-and-audit.md) 归 M5，除非 M4-B 出包 / installer 需要才提前（见 M4-D）。
- **不内置 / 不捆绑 web server**（裁决 37）：web 服务器完全跟随 site 插件、按需对接宿主已安装的 nginx / caddy / httpd 等实现，可选可替换；不装 site 插件即无此能力，内核与插件发布物零 web server 二进制。
- **UI 客户端隔离不代替服务端修补**（裁决 40/42）：跨站独立 origin iframe + postMessage 桥只是兜底，服务端 capability 根因必须独立修，不以 UI 隔离冒充越权已修。

## 2. 四条轨道（M4-A ~ M4-D）

| 轨道 | 一句话目标 | 一句话验收命令 |
| --- | --- | --- |
| **M4-A 服务端 capability 校验** | 全管理端点按目标操作校验 capability，subject 仅取已验签 session、能力由服务端绑定解析，修 `middleware.go:101-111 authorizeTargetAction` 的 confused deputy 根因，使 PoC ①「带 session+csrf+site:read 仍 200」变 401。 | `go test -timeout 200s -run 'TestAuthorizeTargetAction\|TestForgedSubjectRejected' ./internal/core/httpapi/...` 退 0 + 端点矩阵全绿（§4.0）+ PoC ① `200 → 401`。 |
| **M4-B site 插件生产化** | site 从只做参数校验的骨架变为真写独立 conf.d vhost 片段 + include，`nginx -t` 过且 e2e 前后 `nginx -T` 全量 diff 为空（R6 共存），删站端口释放、conf.d 无残留；web server 仅按需对接、绝不内置（裁决 37）。 | `bash tests/fixtures/site-vhost-e2e.sh` 退 0 + `nginx -T` 全量 server/listen/include diff 为空 + `curl` 200 + 删站端口释放，且 `grep -rnE "nginx\|caddy\|httpd" internal/ cmd/` 零命中。 |
| **M4-C audit 查询端点 / CLI** | 在 M3-C 只做写入的基础上补查询端点与 `kored audit --since`，查询自身走 `authorizeTargetAction`、`--since` 必填设上限，可按时间 / 动作过滤并导出 CSV，补齐 M3 审计可观测挂账。 | `go test -timeout 200s -run TestAuditQuery ./internal/core/httpapi/...` 退 0 + `bin/kored audit --since <ts> --action plugins.enable --csv` 含目标事件行 + 无 `--since` 被拒。 |
| **M4-D 包级 ed25519 签名** | 包级签名复用索引级同一 ed25519 公钥并做交叉验签：若 M4-B 出包 / installer 需要则提前到 M4，使篡改包拒装；否则维持 M5 并留不出包证据。 | `go test -timeout 200s -run 'TestPackageSignature\|TestIndexVerifyCrossCheck' ./internal/core/market/...` 退 0；若判 M5 则命令标 `N/A（M5）` 并附 M4-B 不出包证据。 |

## 3. 风险 4 条

| # | 风险 | 触发信号 | 缓解与验收抓手（含命令级判据） |
| --- | --- | --- | --- |
| R1 | **capability 来源不稳（session subject 语义）**：subject 若可自报，伪造头即绕权；只测一个端点，audit / market / store 各自 handler 未统一校验仍越权。 | PoC ① 修好但另一管理端点仍 200；伪造 `X-Kore-Subject: admin` 仍 200；把 `system:admin` 当 `site:read` 子集；capability 混用业务域名词表。 | subject 仅取 `sessions[sha256(token)].subject`，请求头 / body 自报一律忽略；能力由服务端 subject 绑定解析（§1）；fail-closed 三类为轨道级 gate；**全端点矩阵（§4.0）每个端点 ≥1 正例 + ≥1 反例，反例不足 2 处即 FAKE-PASS**；判据：`n=$(grep -rhoE '(401\|403)' internal/core/httpapi/*_test.go 2>/dev/null | wc -l); test "$n" -ge 2 && go test -timeout 200s -run TestAuthorizeTargetAction ./internal/core/httpapi/... >/dev/null 2>&1 && echo OK || echo FAKE-PASS`，输出须 `OK`。 |
| R2 | **site 真写配置不可回滚**：写前不备份、重复建站叠加 include / 端口冲突、`nginx -t` 失败残留半截 conf.d、删站只删自己文件不核对全量配置与端口。 | 原 vhost sha256 前后不一致；`nginx -T` 前后 server/include/listen diff 非空；重复建站出现重复 vhost；删站后 `ss -tlnp` 仍见目标端口。 | 写前 `sha256sum` + 带时间戳备份；幂等由「站点 id → 固定文件名」保证覆盖不叠加；`nginx -t` 失败即逆序回滚（R6：不改主配置、不抢 default_server）；删站逆序清理并验端口释放。判据：`nginx -T 2>/dev/null | grep -E 'server_name\|listen\|include' | sort > /tmp/kore-b; bash tests/fixtures/site-vhost-e2e.sh >/dev/null 2>&1 && nginx -T 2>/dev/null | grep -E 'server_name\|listen\|include' | sort > /tmp/kore-a; diff -q /tmp/kore-b /tmp/kore-a >/dev/null && echo OK || echo DIRTY-ROLLBACK`，输出须 `OK`（`DIRTY-ROLLBACK` 即全量配置未回基线）。 |
| R3 | **audit 查询自身成越权 / DoS 面**：审计含操作者 / 动作 / 时间，查询端点若只挂 session+CSRF 不走 `authorizeTargetAction`，任意 session 可拉全量；CSV 无上限导出放大 DoS；同时全表扫描、无上限 `--since`、ticker 破 G-19。 | `TestAuditQuery` 只有正常查询无 401/403 反例；audit handler 未调 `authorizeTargetAction`；`kored audit --csv` 无 `--since` 仍成功；audit 路径出现 `NewTicker` / `AfterFunc`。 | 查询端点走 `authorizeTargetAction`（能力 `system:read`）；`--since` 必填 + 上限 + 分页（默认 20 / 上限 100），CSV 流式写出；按时间戳 + 动作建索引；请求级 `time.NewTimer` + `context.WithTimeout` 并 `defer Stop()`，禁周期定时器。判据：`grep -q 'authorizeTargetAction' internal/core/httpapi/audit*.go 2>/dev/null && bin/kored audit --csv 2>&1 | grep -qiE 'required\|limit\|上限' && echo OK || echo AUDIT-OPEN`，输出须 `OK`；另 `make idle` CPU ≤60 ms/60 s、goroutine ≤20 且 audit 路径 ticker 零命中。 |
| R4 | **M4-D 与索引签名的密钥兼容窗口**：包级换密钥致包公钥 ≠ 索引验签公钥，合法包全链拒签或篡改包被接受；「逐字一致 + 自签自验」测不出错配。 | 索引 `.sig` 验签失败；合法包拒装率上升；轮换只改一边常量；双验窗口里篡改包仍过且无切换点记录。 | 包级复用索引级同一 ed25519 公钥（`market/verify.go:16` 与 `validate-index.sh:10`，裁决 33/34），不引入第二套密钥；**必须补 `TestIndexVerifyCrossCheck`：用索引验签公钥交叉验包签名**，公钥逐字一致不作为充分证据；轮换先公告新公钥、设双验窗口、窗口结束再撤旧。判据：`idx=$(grep -oE '[0-9a-fA-F]{40,}' scripts/validate-index.sh | head -1); grep -qF "$idx" internal/core/market/verify.go && grep -qr 'TestIndexVerifyCrossCheck' internal/core/market/ && go test -timeout 200s -run 'TestPackageSignature\|TestIndexVerifyCrossCheck' ./internal/core/market/... >/dev/null 2>&1 && echo OK || echo KEY-MISMATCH`，输出须 `OK`。 |

## 4. 验收出口（M4 完成定义）

四条轨道各自可复跑命令全绿，并贴「命令 + 退出码 + 关键输出」（G-07）。

**4.0 端点矩阵 gate（M4-A 与 M4-C 共用，先过硬门槛）**：基于 [CORE §2.9 路由清单](../../docs/CORE.md) 的 13 业务 + 7 store 端点，加 M4-C 新增 audit 查询，共 21 个。每行必须有 ≥1 正例（200）+ ≥1 反例（401/403），缺任一类即 `FAKE-PASS`，不许只测 PoC ① 一个 handler；`system:write` 不得被 `system:read` 或 `site:read` 满足。

| 端点 | 所需 capability | 正例（200） | 反例（401/403） |
| --- | --- | --- | --- |
| `POST /api/v1/auth/login` | 无（口令校验） | 正确口令 | 错口令 |
| `POST /api/v1/auth/logout` | session subject | 有效 session | 无 / 过期 session |
| `GET /api/v1/self` | session subject | 有效 session | 伪造 subject 头 |
| `GET /api/v1/plugins` | `system:read` | admin | `site:read` |
| `POST /api/v1/plugins` | `system:write` | admin | `system:read` |
| `DELETE /api/v1/plugins/{id}` | `system:write` | admin | `site:read` |
| `POST /api/v1/plugins/{id}/enable` | `system:write` | admin | `site:read` |
| `POST /api/v1/plugins/{id}/disable` | `system:write` | admin | `site:read` |
| `POST /api/v1/plugins/{id}/upgrade` | `system:write` | admin | `site:read` |
| `POST /api/v1/invoke/{plugin}/{method}` | `<plugin-id>:<action>` | 已授该能力 | 未授该能力 |
| `GET /api/v1/events` | `system:read` | admin | `site:read` |
| `GET /api/v1/system/info` | `system:read` | admin | `site:read` |
| `GET /-/healthz` | 无（公开探针，明示豁免） | 200 | 不适用 |
| `GET /api/v1/store/plugins` | `system:read` | admin | `site:read` |
| `POST /api/v1/store/refresh` | `system:write` | admin | `system:read` |
| `GET /api/v1/store/presets` | `system:read` | admin | `site:read` |
| `POST /api/v1/store/install` | `system:write` | admin | `system:read` |
| `POST /api/v1/store/update` | `system:write` | admin | `system:read` |
| `DELETE /api/v1/store/plugins/{id}` | `system:write` | admin | `site:read` |
| `GET /api/v1/store/jobs/{job_id}` | `system:read` | admin | `site:read` |
| `GET /api/v1/audit`（M4-C 新增） | `system:read` + `--since` 必填上限制 | admin 带 `--since` | `site:read` / 无 `--since` |

1. **M4-A**：`go test -timeout 200s -run 'TestAuthorizeTargetAction|TestForgedSubjectRejected' ./internal/core/httpapi/...` 退 0，PoC ① `200 → 401`；§4.0 矩阵 21 端点正反例齐全；R1 判据输出 `OK`（`grep` 计数 ≥2 且单测过）且伪造 `X-Kore-Subject: admin` 被拒；`grep -rn "plugins/" internal/core` 零命中（G-01 未回退）。
2. **M4-B**：`bash tests/fixtures/site-vhost-e2e.sh` 退 0，`nginx -t` 成功 + `curl` 200 + 删站端口释放 + conf.d 无残留；R2 判据 `nginx -T` 全量 diff 输出 `OK`（单文件 sha MATCH 不充分）；`grep -rnE "nginx\|caddy\|httpd" internal/ cmd/` 零命中（零原生 web server）；证据含 `env_kind: real`，干净 fixture / 无真实既有站点只记 PARTIAL、不计全绿。
3. **M4-C**：`go test -timeout 200s -run TestAuditQuery ./internal/core/httpapi/...` 退 0 + `bin/kored audit --since <ts> --action plugins.enable --csv` 含目标事件行；R3 判据输出 `OK`（handler 走 `authorizeTargetAction`、无 `--since` 被拒）+ 越权反例 401/403；`make idle` CPU ≤60 ms/60 s、goroutine ≤20 且 audit 路径 ticker 零命中。
4. **M4-D**：`go test -timeout 200s -run 'TestPackageSignature|TestIndexVerifyCrossCheck' ./internal/core/market/...` 退 0 + R4 判据输出 `OK`（公钥交叉验签、无 `KEY-MISMATCH`）；或标 `N/A（M5）` 并附 M4-B 不出包证据（两条路径二选一，不留空）。
5. **收口门禁**：`make docs-check` 通过；`make check` **10/10** 全绿；**干净 clone**：`git archive HEAD | tar -x -C /tmp/kore-m4-clean` 后在该目录复跑 `make docs-check && make check` 同为 10/10、`make wt-check` 无残留 worktree，证明产物自洽、不依赖本地未提交状态（裁决 35：本机 amd64 可复现）。任一项不满足即不判 M4 完成，不降尺子、不把 WARN 冒充 PASS。

## 5. M5 预告（v1.1）

- **19 插件仓铺开**：按 [PARITY-GAP §2.1 G1/G5](../../docs/PARITY-GAP.md) 建齐 20 产品插件中余下 19 仓，逐仓 `make dist` 退 0 + 经商店装 / 卸 / 回滚五步齐全，索引 sha256 与发布物一致；M4 只交 site 骨架范式。
- **全矩阵**：8 个基础级插件升生产级（`tests/fault/` 四类 + G-20 复验），macOS / Windows 由 preview 转 GA 全链路（下载→校验→安装→启动），多平台为降级目标排在最后（裁决 35）。
- **包签名若未做**：M4-D 判 M5 时，此期落包级 ed25519 签名（复用索引公钥 + 双验窗口 + 交叉验签测试），使篡改包拒装、合法包验签通过，补齐供应链最后一环。
