[agent:audit-cap-verifier]

# 审计 capability 字段独立验收报告（G-09 / task-93）

> 时间：2026-11-26 15:17–15:21（Asia/Shanghai）｜复核者：`audit-cap-verifier`（独立 verifier，非 `audit-cap-impl`，只读复跑，不复用实现者自述）
> 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`｜目标 commit：`d3b1b28`（HEAD，main 主树）
> 纪律：唯一可写文件＝本报告；未 push、未执行 kored CLI、未碰 `.kore-local-*`；临时 Go 隔离缓存目录 `.verify-tmp/`（含其 `.git/info/exclude` 项）用完已删；下载缺失依赖已按授权精确披露（见 §3）；他人 dirty 文件原样未动。

## VERDICT：PASS（一项提交说明文案计数偏差，非阻断，见 §6）

实现与验收标准一致：29 路径精确、未碰 web/；5 参签名涟漪全替身更新；仅 invoke 2 出口传真值、其余 16 处 auditDenied 埋点填空串；14 类生产审计出口只有 #1 capability.denied 落真值、其余 13 类空串不编造；4 处展示链路与 DATA-MODEL §5/§9、CORE §2.4 同步；隔离环境 `GOPROXY=off` 下 go test 三包 exit 0；make vet / docs-check / cross-vet exit 0；G-24 / G-01 零新增命中。

## 1. 读码核对（G-24 显式字段 / 5 参签名 / 出口填值）

### 1.1 AuditRecord.Capability（store）
- `internal/core/store/audit.go`：`Capability string \`json:"capability,omitempty"\``；注释明确 G-24 显式 string、仅 capability.denied 填真值、其余空串、旧记录 `json.Unmarshal` 缺省空串、不升 schema 版本。字段为全标量/受控 map 的一部分，无 any/object。
- 旧记录兼容断言：`internal/core/store/audit_test.go:TestAuditCapabilityCompatibility` 三段——有值落 `"capability":"system:admin"`；空值 omitempty 不落库；旧 JSON（无该字段）反序列化读空串。实测 PASS（见 §3）。

### 1.2 CapabilityAuditor 5 参签名涟漪
- `server.go`：`type CapabilityAuditor func(subject, plugin, target, capability, reason string)`；注释写明 capability 真值来源与"非 invoke 传空串、不得编造"。
- `middleware.go`：`auditDenied(subject, plugin, target, capability, reason)`，内部 `s.capAuditor(subject, plugin, target, capability, reason)` 5 参透传 + WARN 日志增 `capability` 键；`noteDeniedAlert` 仍走原 4 参语义（reason），未被签名涟漪误伤。
- `cmd/kored/serve_audit.go`：`capabilityAuditorFromStore.Audit(subject, plugin, target, capability, reason string)` 5 参实现，结构化写入 `AuditRecord.Capability` + `detail.reason`；`serve_boot.go:194` 装配注入同一方法值。
- 全仓 `git grep` 核对：4 参旧签名 `auditDenied(a,b,c,d)` 零命中（正则过滤函数定义后）；18 处生产调用全部 5 参。

### 1.3 invoke 2 出口真值 / 其余空串
- 真值 2 处（`internal/core/httpapi/invoke_capability.go`）：
  - `:132` `auditDenied(subject, plugin, method, requirement.name, ...)` 宿主未知动作 → 未知名（如 `system:superuser`）；
  - `:139` `auditDenied(subject, plugin, method, requirement.name, ...)` 缺 admin → 生效能力（如 `system:admin` / `net:write`）。
- 空串 16 处（grep `auditDenied(..., "", reason)`，逐文件）：handlers_metrics、middleware（管理路径）、handlers_restart×2、handlers_logalerts、handlers_scheduler、handlers_alerts、handlers_sessions、audit_gate、handlers_credentials、handlers_webhook、handlers_snapshots、server.go×2（root-action）、handlers_migrate、channel。
- 断言对应：`invoke_capability_test.go` 两处替身均 5 参且断言 capability=`system:admin` / `system:superuser`；`method_capability_test.go`、`cap_auth_test.go` 替身均 5 参，前者断言真值、后者断言空串（非 invoke 拒绝路径）；`serve_capability_audit_test.go` 落库断言 `rec.Capability=="system:admin"`。实测全 PASS。
- 生产侧 `Capability:` 赋值仅 3 处：唯一写库真值 `serve_audit.go:78`（capability.denied），另两处为展示链路透传（见 1.4）。无其它出口构造能力名。

### 1.4 14 类出口填值表与提交说明一致
提交说明列 14 类生产出口，判定"只有 #1 capability.denied 有真值来源，其余 13 类无结构化能力出口一律空串/不编造"。逐项核对代码：`storeAuditor.Record`（supervisor 生命周期）、`rootActionAuditor.Record`、`credentialAuditor.Record`、`httpAuditRecorderFromStore.Record`（invoke.*/login.*）等均不设置 Capability（零值空串 → omitempty 不落库）；`self_update` 仍把 `system:self_update` 写 detail.capability 不改口径；清理/grant/restart/upgrade/uninstall/auditclean 均无能力字段来源。判定成立。

### 1.5 4 处展示链路
- `handlers_audit.go`：`auditRecordDTO.Capability string \`json:"capability,omitempty"\`` + `AuditRecordView.Capability` + `toAuditDTO` 透传；
- `cmd/kored/audit.go`：`auditListerFromStore.ListAudit` 把 `rec.Capability` 写入 View；CSV 表头 8 列含 `capability`、文本列同序，空值输出空位；
- `internal/core/httpapi/audit_e2e_test.go`：注入记录带 `Capability:"system:admin"`，断言 200 响应含 `"capability":"system:admin"`；
- `handlers_audit_test.go`：查询 DTO 断言 capability 透传。四处齐备，实测 PASS。

### 1.6 文档同步
- `docs/DATA-MODEL.md` §5 audit bucket 行新增 `capability?` 与 omitempty/旧记录兼容口径；§9 字段表新增 `capability` 行（显式 string、真值来源、禁止编造）；查询段补 CSV 8 列/空位兼容；
- `docs/CORE.md` §2.4 `GET /audit` 条补"每条记录含可选 capability，capability.denied 为真值、其余缺省不返回、旧记录读空串兼容"；
- `make docs-check` 1290 条相对链接全可达、5 pass 1 warn 0 fail（warn 为既存文档行数越界，非本提交引入的失败）。

## 2. Git 纪律
- `git show --name-status d3b1b28`：精确 **29 路径**（cmd/kored 4、docs 2、internal/core/httpapi 21、internal/core/store 2），全部 M，无新增/删除；`path count = 29`。
- `web/` 零命中（G-28 不触发）；`.kore-local-*` 零命中；未改 M1–M9 功能语义（diff 仅 capability 字段/签名/展示/文档）。
- `git worktree list`：仅 `/home/pt/Work/GolandProjects/kore-pl/kore d3b1b28 [main]` 主树，无额外 worktree。
- 他人 dirty 原样：任务开始时 `M scripts/usability-pending.txt` + 多个 `?? .agents/verify/*.md` / `?? data/` / `?? dist/`；全程未 add/commit 任何他人文件。我的依赖下载曾使 `go.sum` 变脏，已 `git checkout -- go.sum` 恢复 HEAD 原状；临时 `.verify-tmp/` 与对应 `.git/info/exclude` 条目均已清理。提交后 `git status --short` 与开始时一致（除本报告）。

## 3. 隔离环境验证（GOPROXY=off）
沙箱默认 `GOCACHE`/`GOMODCACHE` 为只读 FS，首跑 setup failed；按任务授权在隔离可写目录建立缓存。**精确披露**：缺失依赖 `go.etcd.io/bbolt v1.5.0` 的 zip 及传递依赖，经配置的 `GOPROXY=https://goproxy.cn,direct`、`GOSUMDB=off` 下载到工作区 `.verify-tmp/gomodcache`（一次性，已删）；所有验证命令（含 make 三目标）均显式 `GOPROXY=off GOWORK=off`。go1.26.8。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `GOPROXY=off GOWORK=off go test -count=1 -timeout 200s ./internal/core/store/... ./internal/core/httpapi/... ./cmd/kored/...` | 0 | store ok 1.192s / httpapi ok 4.822s / cmd/kored ok 9.933s |
| 上述 8 个具名断言测试 `-run ... -v`（GOPROXY=off） | 0 | 8/8 `--- PASS`（store 1、httpapi 6、cmd/kored 1） |
| `make vet`（GOPROXY=off） | 0 | `[OK] go vet 通过` |
| `make docs-check` | 0 | 5 pass / 1 warn / 0 fail（既存行数越界 WARN，不阻断） |
| `make cross-vet`（GOPROXY=off） | 0 | windows/amd64 + darwin/arm64 go vet 含 _test.go 通过 |
| `bash scripts/thin-shell-check.sh`（G-01 脚本门禁） | 0 | 4 pass / 0 fail，业务域词 0 命中（扫描 202 文件） |

具名断言明细（全部 PASS）：
- store：`TestAuditCapabilityCompatibility`（显式 string、omitempty、旧记录空串）；
- httpapi：`TestAuditQueryEndToEnd`（端到端响应含结构化 capability）、`TestCapabilityDeniedWritesAudit`（非 invoke 替身 capability 空串）、`TestAuditQueryNormal`（DTO 透传）、`TestInvokeCapabilityDeniedWithoutAdmin`（真值 system:admin）、`TestInvokeCapabilityUnsupportedHostAction`（真值 system:superuser）、`TestInvokeMethodCapabilityFallbackToPluginLevel`（回退真值 system:admin）；
- cmd/kored：`TestCapabilityAuditWritesDenied`（落库 capability=system:admin + 不编造）。

## 4. G-24 / G-01 复跑
- G-24：新增行（diff `+` 行）中 `map[string]any` / `any` / `类型：object` **零命中**；全仓现存 `decodeJSONBody(target any)` 为父提交既有（已核对 `git show d3b1b28^` 同处存在），非本次引入。提交主体 `AuditRecord.Capability` 为显式 string，符合 G-24。
- G-01：`scripts/thin-shell-check.sh` 4 pass 0 fail（无同进程动态库、无 `kore/plugins` 业务包 import、业务域词/动作词 0 命中）；新增 Go 行中无 `plugins/` 业务 import。capability 是规则标识字符串，不构成业务域名词表。

## 5. 路由与语义边界
diff 未新增/删除路由，未改鉴权判定、`hasCapability` 语义、supervisor/credential/privilege/self-update 行为；仅审计写入结构化字段与展示面扩展，M1–M9 功能语义零改。

## 6. 偏差（非阻断）
提交说明末段写"httpapi 内 16 处 auditDenied 拒绝埋点中，仅 2 处 invoke 路径传真值……其余 14 处传空串"，与实测计数不符：生产调用共 **18** 处（2 真 + **16** 空），与 task-93 表述"其余 16 处填空串"一致。属提交说明文案的算术笔误，代码行为正确、断言与文档口径一致，不影响验收；建议后续如有相邻改动顺手订正该数字，本次只读复跑不改他人提交。

## 7. 结论
task-93 全部复跑项达标，VERDICT = PASS。唯一可写物＝本报告；未 push、未执行 CLI、未碰运行态目录；临时目录与 git exclude 副作用已还原。
