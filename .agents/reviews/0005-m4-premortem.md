> 状态: draft · 归属: red-team · 更新: 2026-11-22 · 里程碑: M4
> 方法: 假设 M4 在收口评审被判失败，从死因倒推；只收能被一条命令戳穿的死法。

# 0005 · M4 Core Hardening 事前验尸（pre-mortem）

判定基线：[提案 0004](../proposals/0004-m4-core-hardening.md) §1 非目标 / §2 四轨道 / §3 风险表 R1–R4 / §4 验收出口，[AGENTS.md](../../AGENTS.md) G-01/G-07/G-10/G-19，[M3 验尸](0004-m3-premortem.md) §4 复验口径。提案 R1–R4 风险文本已写全，本文专挑「风险写了、能挡假绿的命令没落到验收出口」与「测法和目标口径相矛盾」的死因；命中任一条即 M4 不成立。

**特别核查（session subject 语义）**：提案 R1（提案第 31 行）确实把「session 未显式携带 subject / granted capabilities」列为风险，并给出口头 fail-closed 口径「session 缺 subject / granted capabilities 即拒」。但有两个缺口：①它只挡「缺」不挡「假」——没定义 subject 的来源权威性（服务端签发的 session 可信字段 vs 客户端自报），伪造一个 subject 字段即可绕过；②§4.1 验收命令 `go test -run TestAuthorizeTargetAction` 未把 fail-closed 变成命令级反例 gate，R1 自己列的触发信号「修好一个端点另一端点仍 200」在验收出口无对应检查。按用户口径「只写按目标操作校验却没定 subject 来源 → REVISE」，本项列为阻塞建议（修改建议 1）。

## 1. 四条失败场景

### S-01 M4-A 只修一个端点，另一端点仍越权（提案 R1 已点名）
- 场景：§4.1 只跑 `TestAuthorizeTargetAction` + PoC ① 200→401，只证明 `middleware.authorizeTargetAction` 这一条路径。R1 自己列的触发信号是「PoC ① 修好但另一管理端点仍 200」——audit / market / store 等端点若各有 handler、未统一走校验或传错 cap 参数，仍是 confused deputy；测试只覆盖一个端点，另一个越权照样绿。fail-closed 也只测「缺 subject 被拒」而不测「伪造 subject 被拒」。
- 触发：只加单个单测；新端点直接读 session+CSRF 不校验 targetAction；把 `system:admin` 当 `site:read` 子集放行；capability 混进业务域名词表。
- 影响：R1 根因只修一半，服务端越权仍留在未覆盖端点——裁决 40/42 服务端根因没闭环，UI 隔离一撤就复现越权。
- 早期信号：PoC ① 变 401 但全端点扫描仍有 200；测试只 mock 一个 handler；越权/拒绝反例断言不足 2 处。
- 提前发现（一条判据）：
```bash
n=$(grep -rhoE '(401|403)' internal/core/httpapi/*_test.go 2>/dev/null | wc -l); test "$n" -ge 2 && go test -timeout 200s -run TestAuthorizeTargetAction ./internal/core/httpapi/... >/dev/null 2>&1 && echo OK || echo FAKE-PASS
```
输出 `FAKE-PASS` 即命中（越权/拒绝反例不足两处或单测挂）。

### S-02 M4-B 真写 conf 破坏宿主既有站点且回滚不干净（提案 R2 已点名）
- 场景：§4.2 只看 e2e 退 0 + 原 vhost 单文件 sha256 MATCH + `nginx -t` 过。但单文件 sha 只比一个文件：site 若在 conf.d 写抢占 `default_server`、通配 `server_name _`、include 插到原 server 前，`nginx -t` 照样过、原 vhost 哈希也不变，宿主既有站点流量却被新 vhost 截走。删站后只删自己文件、不核对全量配置与端口，残留 conf.d 在下次 reload 复活。
- 触发：e2e 在无真实既有站点的干净 fixture 上跑；只比单文件 sha；`nginx -T` 未做前后全量 diff；删站后未确认端口释放。
- 影响：宿主 VPS 装 site 打断既有站点（R6 共存破防），回滚不干净留半截 conf.d——安全事故级，与 M3 反复挂账的 R6 同源。
- 早期信号：证据无宿主 nginx 版本与既有 vhost 清单；`nginx -T` 前后 server 块 diff 非预期；删站后 `ss -tlnp` 仍见目标端口。
- 提前发现（一条判据）：
```bash
nginx -T 2>/dev/null | grep -E 'server_name|listen|include' | sort > /tmp/kore-b; bash tests/fixtures/site-vhost-e2e.sh >/dev/null 2>&1 && nginx -T 2>/dev/null | grep -E 'server_name|listen|include' | sort > /tmp/kore-a; diff -q /tmp/kore-b /tmp/kore-a >/dev/null && echo OK || echo DIRTY-ROLLBACK
```
输出 `DIRTY-ROLLBACK` 即命中（e2e 跑完全量配置未回到基线）。

### S-03 M4-C audit 查询端点自身成为越权 / DoS 面
- 场景：M4-C 新增 audit 查询端点 + CLI，R3 只盯「性能」（全表扫描 / --since 无上限 / ticker / CSV 撑内存），把「--since 必填设上限 + 分页」当缓解。但审计日志含操作者 / 动作 / 时间，是敏感数据：查询端点若只挂 session+CSRF、不走 `authorizeTargetAction`，就成了任意有 session 者可拉全量审计的越权面；CSV 无上限导出即 DoS 放大面。§4.3 验收只有 `TestAuditQuery` + CLI 出事件行 + idle，没有任何越权反例或无界查询拒绝检查。
- 触发：audit handler 复用旧鉴权；`--action` / `--since` 可空且无上限；CSV 一次导全量；查询路径起常驻 ticker。
- 影响：audit 从「可观测」变成「敏感泄露 + DoS 面」，与 M4-A 同源——M4-A 修了业务端点，audit 查询端点却成新的 confused deputy 入口。
- 早期信号：`TestAuditQuery` 只有正常查询无 401/403 反例；audit handler 未调用 `authorizeTargetAction`；`kored audit --csv` 无 --since 仍成功。
- 提前发现（一条判据）：
```bash
grep -q 'authorizeTargetAction' internal/core/httpapi/audit*.go 2>/dev/null && bin/kored audit --csv 2>&1 | grep -qiE 'required|limit|上限' && echo OK || echo AUDIT-OPEN
```
输出 `AUDIT-OPEN` 即命中（未走 capability 校验或无界查询未拒）。

### S-04 M4-D 包签名与索引签名密钥混用导致全链拒签（提案 R4 已点名）
- 场景：R4 要求包级复用索引级同一 ed25519 公钥，§4.4 验收是 `TestPackageSignature` + `market/verify.go:16` 与 `validate-index.sh:10` 公钥「逐字一致」。但逐字一致只比文本：若包签名与索引签名用不同私钥生成（公钥值不同却被分别硬编码）、或轮换只改一边常量，就会索引验签过、包验签全拒（合法包装不上），或双验窗口里篡改包被接受。`TestPackageSignature` 若只测「篡改 1 字节拒 + 合法过」，用的是同一套密钥自签自验，发现不了「包公钥 ≠ 索引验签公钥」的错配。
- 触发：包签名脚本与索引签名脚本引用不同私钥；轮换只更新一边常量；测试自签自验无交叉验证。
- 影响：供应链验签链全崩——合法包全链拒签装不上，或篡改包装上（安全事故），G-10 零信任承诺破。
- 早期信号：索引 `.sig` 验签失败；合法包拒装率上升；无双验切换点记录。
- 提前发现（一条判据）：
```bash
idx=$(grep -oE '[0-9a-fA-F]{40,}' scripts/validate-index.sh | head -1); grep -qF "$idx" internal/core/market/verify.go && grep -qr 'TestIndexVerifyCrossCheck' internal/core/market/ && go test -timeout 200s -run 'TestPackageSignature|TestIndexVerifyCrossCheck' ./internal/core/market/... >/dev/null 2>&1 && echo OK || echo KEY-MISMATCH
```
输出 `KEY-MISMATCH` 即命中（公钥常量不一致、无交叉验签测试或测试挂）。

## 2. 对提案的三条可执行修改建议

1. **定义 subject 来源并把 fail-closed 命令级化**（对应 S-01 + 特别核查）：在 §4.1 明文定义 subject = 服务端签发的 session 可信字段、不接受客户端自报；把「缺 subject → 全管理端点 401/403」「伪造 subject → 同样拒」「仅授 site:read 访问另一端点 → 401/403」三类反例升为轨道级 gate，测试须覆盖 ≥2 个不同管理端点的矩阵，不能只测 PoC ①。
2. **收紧 M4-B 回滚判据**（对应 S-02）：把「原 vhost 单文件 sha MATCH」升级为「e2e 前后 `nginx -T` 全量 server/include/listen 配置 diff 为空 + 目标端口释放 + conf.d 无残留」；并规定 e2e 在无真实既有站点的干净 fixture 上只能记 PARTIAL、不计全绿。
3. **补两条命令级 gate**（对应 S-03 / S-04）：§4.3 增「audit 查询端点走 `authorizeTargetAction` + `--since` 必填设上限 + 越权反例 401/无界查询拒绝」；§4.4 增「用索引验签公钥交叉验包签名」的 `TestIndexVerifyCrossCheck`，公钥逐字一致不作为充分证据。

## 3. VERDICT

**REVISE.** 提案 R1–R4 风险文本写全，但 §4 验收出口存在四类「风险写了、能挡假绿的命令没落」的错配：M4-A 只测 PoC ① 单端点、R1 点名的「另一端点仍越权」无端点矩阵 gate；subject 语义只写「缺即拒」未定来源权威性、挡不住伪造；M4-B 单文件 sha 挡不住全量配置被改与回滚残留；M4-C 审计查询端点无越权/无界反例；M4-D 公钥逐字一致与自签自验测不出密钥错配。三条建议落地后可由 verifier 复跑上文四条判据复审。

## 4. 复验（2026-11-22，提案 0004 修订后 82 行）

只核本文 §2 三条建议是否落实，不新增判据、不改提案。证据文件 `.agents/proposals/0004-m4-core-hardening.md`（下称 `0004`）。

- **建议 1 subject 来源与伪造反例：PASS** — `0004:13` subject 仅取 `sessions[sha256(token)].subject`、请求头 / body 自报一律忽略；`0004:14` subject→能力服务端绑定解析；`0004:15` 三类 fail-closed 为轨道级 gate；`0004:28`/`0004:72` `TestForgedSubjectRejected` 进验收命令与出口。
- **建议 2 端点矩阵 gate：PASS** — `0004:46` 定义 21 端点 + 正反例齐全 + FAKE-PASS；`0004:48-70` 矩阵逐行列 capability / 正例 / 反例；`0004:37`/`0004:72` 反例 <2 判 FAKE-PASS、矩阵齐全列出口。
- **建议 3 S-02/03/04 判据双落地：PASS** — S-02 `nginx -T` 全量 diff（`0004:38` 风险段判据 + `0004:73` 出口「单文件 sha 不充分」）；S-03 audit `authorizeTargetAction` + `--since` 必填（`0004:39` + `0004:74` 越权反例 401/403）；S-04 `TestIndexVerifyCrossCheck` 公钥交叉验签（`0004:40` + `0004:75` 出口「无 KEY-MISMATCH」）。

**VERDICT: APPROVE** — 三条建议全部落实，风险段与验收出口双落地，无新增判据，原 REVISE 阻塞项闭环。
