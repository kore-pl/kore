# backup.restore 端到端 DR 闭环报告独立验收（task-322 / G-09）

> 元信息：2026-11-28 · 验收者 `backup-dr-verifier`（G-09，独立 verifier，非 backup-dr 实现/执行者）· 写域仅本报告。
> 被验对象：commit `21e62c17173cb5254e2472b86bee26e3848455be`（`.agents/verify/backup-dr-live.md`，163 行）。
> 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore`；全程只读复跑，未改代码、未启服务、未 push、未联网业务、未碰 `.kore-local-*` / 宿主。
>
> **总评：PASS**。阶段一缺口属实；restore 实现路径读码核对成立；45 断言数字自洽、抽算成立；中途 4 FAIL 归因 harness 口径（非产品缺陷）有源码支撑；清理回读全部成立；commit 单文件 163 行 + DCO + 未 push + 他人 dirty 原样 + secret-check 0 FAIL。

## 验证口径（诚实边界）

DR harness 是 `python3 - <<'PYEOF'` 内联执行、用完即删，**未落盘脚本、未落盘原始断言日志**（报告 §2.1/§4 自述）。本 verifier 依 G-09 独立复跑纪律，**不复用执行者结论、不重跑会起服务的 harness**（硬纪律：不启服务）。因此断言层采用三类只读证据交叉坐实：①数字自洽抽算（字节和/条目数/断言计数）；②源码路径回读（错误码、字段、能力、两级确认）；③收尾残留态回读（端口/临时目录/host sha/git/secret-check）。**"逐字节守恒"由报告内 pre/post manifest 断言 + 本轮抽算佐证，非本 verifier 重新造包再跑一遍**——如实标注，不冒充重新执行过 DR 演练。

---

## ① 阶段一：缺口属实 + 实现路径存在

**grep 缺口**（命令 `grep -rn "backup\.restore\|backup restore\|restore.*backup\|恢复备份\|从备份恢复" .agents/verify/ --include=*.md`，exit=0）逐条核对：

- `.agents/verify/upload-restore-live.md:69-75` 原文回读：restore 对象是 `backup.upload` **导入的外来包**（`id=imported-…`），恢复到全新 `$ISO/restored`，`:70` 回读 `b'alpha\n'`、`:75` 明确「两级确认是前端 UI 门禁，本次按既有 e2e 口径真机 invoke 复用 restore，未重验前端二次点击」。**无 backup.create 产物、无毁状态、无重启、无逐字节 sha 前后清单**——DR 闭环缺口属实。
- 其余命中均为非闭环：`integrity-verify.md:24,52`（integrity 插件基线恢复）、`pg-backup.md:45`（db-postgres pg_dump/restore）、`race-pattern-audit.md:69`（静态竞态审计）、`local-update-plan.md:96`（回退计划非执行）、`backup-download-live.md:48`（download 链）等。结论与报告 §1.1 一致。

**restore.go 读码**（`kore-plugin-backup/internal/backupop/restore.go`，374 行）：

- `:29-60` `callRestore`：decode→ValidateID→ResolveTargetDir(白名单)→NormalizeRestoreFilter→`exec.Restore`→`classify`；`Failed` nil 归一为 `[]string{}`。
- `:64-128` `realFS.Restore`：注释明示「全有或全无地恢复：先解到目标同文件系统临时目录，确认全部条目可解后 rename；任何条目失败删 staging、目标不留半包」；`committed` 标志 + `defer RemoveAll(staging)`（:80-85）实现原子提交，:118 rename、:121 `committed=true`。
- `:130-150` `checkRestoreTarget`：不存在 OK；非目录 → E_CONFLICT；`os.ReadDir` 非空 → `E_CONFLICT`「target_dir 已存在且非空，拒绝半恢复覆盖」（:147）。
- `:92-100` `gzip.NewReader` 失败 → `E_INVALID`「备份包不是合法 gzip」（:96）；`:173-179` `tar.Next()` 非 EOF 错误 → `E_INVALID`「备份包损坏，无法恢复」（:178）。与报告 §1.2/§2.4 原文逐字一致。
- 空 target 必填错误另有源：`validate.go:141` `invalid("target_dir 不能为空")` → 400 E_INVALID，与报告 §2.4 行一致。

**info.json 权限**：`kore-plugin-backup/info.json` `:12 method_capabilities` 含 `"backup.restore": "system:admin"`（:17），`:9-11 capabilities` 含 `system:admin`，`:44-49 methods` 数组含 `backup.restore`（:49）。报告 §1.2 权限声明成立。

**web 两级确认**：`kore/web/backups.js`（`git status --short -- web/backups.js` 空=HEAD 干净）：`:8` 注释「恢复/删除/清理与任务删除一律走页面内二次确认面板（不用 window.confirm）」；`:923` 行内恢复按钮 → `openConfirm('restore', b)`（一级）；`:1013-1027` 面板「恢复确认」/「二次确认 · 页面内」/ id/size/sha/警告「非空目标会被插件拒绝（E_CONFLICT）」/ 目标目录输入 +「确认恢复」提交（二级）；`:1037-1054` `doRestore` → `invoke('backup.restore',{id,target_dir})`。报告 §1.3 诚实口径（协议层无 confirm、UI 门禁本轮未重跑浏览器点击）与代码一致。

## ② 45 断言数字自洽 + 抽算

**抽算（本轮实算）**：

- 6 文件大小和 `22+21+61+46+256+1036 = 1442` == 报告 `uncompressed_bytes=1442`（§2.3①/②）—— **MATCH**。
- tar 成员枚举 `site, site/assets, site/assets/app.css, site/index.html, config, config/app.conf, audit, audit/audit-snapshot.json, plugin-state, plugin-state/dr-state.json, payload.bin` = **11** == 报告 `entries=11` / `restored_entries=11` / `archive_is_valid_targz entries=11` —— **MATCH**。
- 守恒对象集合：pre/post manifest 同为 6 文件（含 256B 二进制 `payload.bin` 与 1036B 审计快照），mode/size/sha 全等；审计 sha `01e17d5a…` 前后一致且 `total=3`。数字无自相矛盾。
- 断言计数分解：前置/隔离 10 + 前置链 5 + 主链 24 + 边界 6 = **45**，与报告 `[SUMMARY] TOTAL=45 PASS=45 FAIL=0` 一致（重叠项 `host_8787_untouched` 跨组出现属同断言复述，计数口径自洽）。

**闭环链**：healthz/login/install/enable → 造 6 文件逐字节清单 → create(1536B/11 条目/verify ok) → 边界(空 target 400 / 非空 409 sentinel 未覆盖) → 停实例 + rename appstate 模拟灾难 → 重启 healthz200 → restore(restored_entries=11, failed=[]) → manifest 逐字节一致 + audit sha 一致 total=3 → GET audit?since 200 total>0 → 损坏包 400 不留半恢复 → 8787 前后 200。报告 §2.2-2.4 每一步均给 HTTP/原文/断言名，链完整无缺口。

## ③ 中途 4 FAIL 归因（harness 口径，非产品缺陷）

报告 §3 原文：4 FAIL（`audit_readable_before_disaster` / `audit_pre_count_positive` / `audit_endpoint_200_after_restore` / `audit_records_present_after_restore`）均为 `400 E_INVALID 缺少必填参数 since`。

源码支撑（本轮回读）：

- `kore/internal/core/httpapi/handlers_audit.go:112-116`：`since` 必填（`values.Get("since")==""` → `"缺少必填参数 since（RFC3339；全量导出已禁止）"`），与报告原文逐字一致 → 首轮漏传 since 属 harness 请求错误。
- 同文件 `:44-51`：`auditListBody` 字段为 `records`(`json:"records"`) / `count` / `total`(`json:"total"`) → 首轮按 `items`/`events` 解析取到 0 属 harness 字段误读。
- 修正（`?since=...&limit=100` + 读 `records`/`total`）后 45/45 全绿，且修前主链已全 PASS。归因 **harness 口径错误、非 backup 插件或内核缺陷**成立。

## ④ 隔离清理回读（本轮只读探针）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 55251 无监听 | `ss -ltn \| grep ':55251\b'` | `NO_LISTENER_55251` ✅ |
| 隔离树已删 | `[ -e /tmp/kore-dr-iso-55251 ]` / `[ -e /tmp/kore-dr-build ]` | 两者 `GONE` ✅ |
| harness 残留 | `find . -maxdepth 3 -name '*harness*' -o -name 'dr-*.py'` | 仅命中 tracked 项目文件 `cmd/kored/serve_harness_test.go`（`git ls-files` 确认非 DR 残留）；`/tmp/dr-*.py` 与 `kore-dr*` 无 ✅ |
| 8787 健康 | `curl -s -o - -w HTTP http://127.0.0.1:8787/-/healthz` | `HTTP=200` `{"status":"ok"}` ✅ |
| 宿主 bin/kored 未变 | `sha256sum bin/kored` | `3de48562e5c72692…baa648`，前缀 `3de48562` 与报告 §2.1 一致 ✅ |

（本轮未启/停任何服务，仅 `curl` GET 与 `ss` 只读探针；8787 为已运行主实例，前后 200。）

## ⑤ git / secret-check

- `git show --stat 21e62c1`：精确 **1 文件** `.agents/verify/backup-dr-live.md`，**163 insertions**；`git show 21e62c1:... | wc -l` = 163；工作树 blob hash `660e2338…` == commit blob `660e2338…`（未被并发改动）。
- DCO：`git show -s --format=%B` 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`；提交头 `[agent:backup-dr] docs(verify): ...` 合规。
- 未 push：`origin/github/gitee main` 跟踪 ref 均为 `8471d6e`（非 21e62c1）；`git merge-base --is-ancestor 21e62c1 <remote>` 三端均 exit=1（不含该提交）。HEAD=21e62c1，父 a07a73f。`git worktree list` 仅主树。
- 他人 dirty 原样：`M scripts/usability-pending.txt` + `?? .agents/.agents/`、`?? .agents/verify/{e2e-*,local-update-plan,release-batch-*,release-inject-verify,run-user-model}.md`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`、`?? .gocache-kore-014/`、`?? data/`、`?? dist/` —— 未 add/commit 任何他人文件。
- `make secret-check` → exit 0、`0 FAIL / 31 匹配（占位/正则合规）`；唯一 WARN 在 `.agents/verify/backup-download-verification.md:125`（`ADMIN_PASSWORD` 正则模式片段，既存非本次引入、非 DR 报告）。DR 报告自身 grep 口令相关行仅 `:67/:145` 的占位描述，无明文。

## 结论

五项复核全部成立，未发现守恒破坏或证据矛盾；DR 演练报告内部证据自洽、实现路径与源码一致、清理与提交合规。**G-09 独立验收总评：PASS**（断言层为数字自洽 + 源码/残留态交叉坐实，非重新跑起服 harness；此边界已如上标注）。无需回派缺陷卡。
