# backup.restore 端到端灾备（DR）闭环真机验证报告（task-321）

> 元信息：2026-11-28T12:59+08:00 · 执行者 `backup-dr`（真机验证 worker，非实现者）· 写域仅本报告。
> 对象：`kore@a07a73f`（当前 HEAD，隔离临时编译二进制 sha256 `bbea8c12c16541aea7c18400ec83515342f97b6a843eba0a1a51af8a5dde04cd`）、
> `kore-plugin-backup@` 本地 dist `backup-0.6.0.tar.gz`（sha256 `a5043d36d951c53f8bbff167cf300fd865793243bc315d955a18f41b743acbe4`，与 `kore-plugins/index/plugins.json#backup@0.6.0` 逐字符一致）。
> 未改生产代码 / 未 bump / 未发版 / 未 push / 未联网业务 / 未碰 8787 与 `.kore-local-*`、未覆盖宿主 `bin/kored`。
>
> **总评：阶段一缺口属实（既有报告只验了导入包恢复到新目录，从未验 create→毁状态→restore→重启→逐字节核对的 DR 闭环）；阶段二 45/45 断言 PASS，0 FAIL。真机未暴露生产缺陷。**

---

## 1. 阶段一：只读核实（先做，不臆断）

全部为只读命令；`exit=0` 表示命令正常结束 / 命中。

### 1.1 全 `.agents/verify/*.md` 搜 backup.restore 真机证据

`grep -rn "backup\.restore\|backup restore\|restore.*backup\|恢复备份\|从备份恢复" .agents/verify/ --include=*.md`（`exit=0`，12 命中）逐条核对：

| 报告 | 原文要点 | 是否 DR 闭环 |
| --- | --- | --- |
| `.agents/verify/upload-restore-live.md:69` | `restore_200 PASS`：`backup.restore {"id":"imported-…","target_dir":"$ISO/restored"}` → `restored_entries:2`；`:70` 回读 `b'alpha\n'` 与造包一致；`:75`「两级确认是前端 UI 门禁，本次按既有 e2e 口径用真机 invoke 复用 restore」 | **否**：对象是**导入的外来包**（`backup.upload` 造的），恢复到全新 `$ISO/restored`，没有 `backup.create` 产物、没有先毁状态、没有重启实例、没有逐字节 sha 清单前后比对 |
| 同上 `:152` | 「本次只验证 upload→list/verify/restore，未验证 `backup.download`，两链路证据分开」 | 否，明确自述只验该链 |
| `.agents/verify/backup-download-live.md:48` | 引用上面 `:152` 的「未验证 download」边界 | 否，download 链 |
| `.agents/verify/backup-verify-ui.md` / `backup-050-release.md` / `backup-schedule.md` / `backup-redis-ui.md` / `ui-ssl-backup.md` | UI / 发布 / 定时 / 空态类，无 restore 真机闭环 | 否 |
| `.agents/verify/integrity-verify.md:24,52` | 是 `integrity` 插件「恢复到此版本」（恢复基线记录，不是备份插件） | 否，非 backup 插件 |
| `.agents/verify/pg-backup.md:45` | 是 `db-postgres` 的 pg_dump/restore | 否，非 backup 插件 |
| `.agents/verify/fix-db-invoke.md:22` / `race-pattern-audit.md:69` | 方法分发修补 / restore check-then-act 竞态审计（静态） | 否，非真机 DR |
| `.agents/verify/local-update-plan.md:96` | 升级回退计划提到「恢复备份 + 重启」 | 否，计划非执行 |

**结论**：无任何既有报告含 create→destroy state→restore→restart→逐字节 sha 核对的端到端 DR 闭环。该证据缺口属实（用户持续目标 round50 口径）。既有 `upload-restore-live.md` 只证明「导入包能恢复到空目录」，不证明「自己造的备份能救回被毁的运行状态」。

### 1.2 restore 实现路径存在（读源码，`read` 退出码 0）

| 项 | 事实 | 文件:行 |
| --- | --- | --- |
| 执行面 | `callRestore` 校验 id / target_dir 白名单 / paths 过滤 → `realFS.Restore` 全有或全无（临时目录解包 → rename），任何条目失败删 staging、目标不留半包 | `kore-plugin-backup/internal/backupop/restore.go:29-60`、`:64-128` |
| 非空目标拒绝 | `checkRestoreTarget`：`target_dir` 不存在或空目录才允许；非空返回 `E_CONFLICT`「target_dir 已存在且非空，拒绝半恢复覆盖」 | `restore.go:130-150` |
| 损坏包拒绝 | `gzip.NewReader` 失败 → `E_INVALID`「备份包不是合法 gzip」；`tar.Next()` 失败 → `E_INVALID`「备份包损坏，无法恢复」 | `restore.go:92-100`、`:173-179` |
| 安全校验 | 拒绝绝对路径 / `..` 段 / 超 4096 字节 / 设备 / FIFO / 硬链接 / 符号链接逃逸 / >2 GiB 条目；丢弃 setuid/setgid | `restore.go:265-275`、`:292-353` |
| 方法分发 | `Call` switch `case "restore": return callRestore(...)`；`businessVerb` 白名单含 `restore`（兼容裸动词 `restore`） | `kore-plugin-backup/internal/backupop/call.go:35-36`、`:65-68` |
| 权限声明 | `info.json` `method_capabilities["backup.restore"]="system:admin"`；`methods` 数组含 `backup.restore`；capabilities 含 `system:admin` | `kore-plugin-backup/info.json`（`read` 全文 exit=0）；`grep` 命中 exit=0 |

### 1.3 前端恢复两级确认存在

`kore/web/backups.js`（`read`/`grep` 退出码 0，文件在 HEAD、`git status --short -- web/backups.js` 空）：

- `:923` 行内「恢复」按钮 → `openConfirm('restore', b)`（**第一级**）。
- `:973-977` `openConfirm` 置 `S.confirm` 并渲染确认面板；`:1012-1027` 面板标题「恢复确认」、标记「二次确认 · 页面内」、展示 id/name/created_at/size/entries/sha256、警告「目标目录必须不存在，或存在且为空目录；非空目标会被插件拒绝（E_CONFLICT），不会覆盖已有文件」、目标目录输入框 + 「确认恢复」提交按钮（**第二级**）。
- `:1037-1054` `doRestore` 读 target，`invoke('backup.restore',{id,target_dir})`，失败在面板内显示。
- 头部注释 `:8`：「恢复/删除/清理与任务删除一律走页面内二次确认面板（不用 window.confirm）」。

诚实口径：`backup.restore` 协议层**无 confirm 参数**；「两级确认」是前端 `bak-confirm` 面板 UI 门禁（G-28 双端截图既有覆盖）。本轮按既有 e2e 口径用真机 invoke 复用 restore，未重验浏览器点击；本报告把「错确认拒绝」落到协议层可测的形态（空 target_dir → 400 E_INVALID），不冒充前端点击验证。

---

## 2. 阶段二：隔离真机 DR 演练（阶段一确认缺口后执行）

### 2.1 隔离边界与运行形态

| 项 | 事实 | 命令 + 退出码 / 断言 |
| --- | --- | --- |
| 端口 | 仅 `127.0.0.1:55251`（非 8787） | harness `connect_ex` 开局空闲；收尾 `ss -ltn \| grep ':55251\b'` → `NO_LISTENER_55251`；`[PASS] port_free_after_cleanup` |
| 独立目录 | config/state/run/log/index/backups/appstate/build 全落 `/tmp/kore-dr-iso-55251/` | harness `shutil.rmtree` + 分目录创建；收尾 `ls -ld` → `No such file or directory`（exit=2 即已不存在）；`[PASS] iso_tree_removed` |
| 配置 | `server.addr=127.0.0.1:55251`；`paths.state_dir/run_dir/log_dir/index_dir` 全指隔离树子目录；index 为 `kore-plugins/index` 已签名快照副本（离线） | harness 写 `$ISO/config/config.yaml`；隔离 healthz 200 |
| 临时二进制 | 当前 HEAD `a07a73f` 用 `go build -trimpath -buildvcs=false -ldflags '-s -w'` 编到 `$ISO/kored`，**不覆盖宿主 `bin/kored`** | `[PASS] head_temp_build_exit0 :: exit=0`；`[PASS] temp_bin_not_host`；sha256 `bbea8c12…de04cd`（与宿主 `bin/kored` 的 `3de48562…a648` 不同）；`GOPROXY=off`、writable GOMODCACHE，全程不联网 |
| 凭据 | 随机口令只写 0600 文件 `$ISO/.pw`，经 stdin 喂给 `kored admin-password --set --stdin --config`；argv / 报告 / 响应原文均无明文 | `[PASS] pw_file_0600`（`0o600`）；`[PASS] admin_password_set_exit0 :: exit=0`；报告内仅占位（G-30） |
| 插件环境 | `KORE_BACKUP_DIR=$ISO/backups`、`KORE_BACKUP_ALLOW_ROOTS=$ISO`、`KORE_STATE_DIR=$ISO/state`，仅注入隔离 kored 进程（lazy 插件子进程继承） | harness `env.update(...)`；create/list/verify/restore 全 200 |
| 未碰禁区 | 未读写/重启/kill 8787；未碰 `.kore-local-*` / 宿主 / 外网；未装包到系统路径 | 收尾 `curl 127.0.0.1:8787/-/healthz` → `HTTP=200`（前后一致）；`[PASS] host_8787_untouched` |
| 主壳日志 | isolated kored pid 正常 spawn、`/-/healthz` `{"status":"ok"}` | `[PASS] kored_spawned pid=67`；`[PASS] isolated_healthz_200_start/after_disaster` |

运行形态：`bash` 每次调用独立沙箱、进程不跨调用存活，故起服→登录→装插件→造状态→断言→灾难→重启→恢复→断言→停服→清理全部写在**同一内联 Python harness（`python3 - <<'PYEOF'`，不落盘脚本文件）、同一次 bash 调用**内完成；用户明令一次性脚本用完即删，本报告无 harness 脚本残留。最终 harness 退出码 `DR_HARNESS_EXIT=0`，末行 `[SUMMARY] TOTAL=45 PASS=45 FAIL=0`。

统一调用形态（每次 invoke 独立 HTTP 请求，kored 内部 lazy 唤醒插件并经 UDS 转发）：
```
POST /api/v1/invoke/backup/<method>  (Cookie: kore_session + kore_csrf; X-Kore-CSRF: <token>; JSON body)
```

### 2.2 前置（healthz / login / install / enable）

| 步骤 | 退出码(HTTP) | 响应原文要点 |
| --- | --- | --- |
| `GET /-/healthz` | 200 | `{"status":"ok"}` |
| `POST /api/v1/auth/login` | 200 | `{"authenticated":true,"expires_at":"2026-11-28T16:59:25Z"}` |
| `POST /api/v1/store/install {"id":"backup","version":"0.6.0","package_path":"<dist 绝对路径>"}` | 200 | `{"id":"backup-0.6.0","state":"succeeded","message":"安装完成","reload":"reloaded"}` |
| `POST /api/v1/plugins/backup/enable {}` | 200 | `{"id":"backup","enabled":true,"granted_capabilities":["system:admin"],"method_capabilities":{"backup.restore":"system:admin",...}}` |

`[PASS] login_200 / session_csrf_headers_set / install_backup_succeeded / enable_backup_ok / dist_sha_equals_index`。

### 2.3 主链：造状态 → 逐字节 sha 清单 → create → 毁状态 → restore → 重启 → 逐字节核对（PASS）

**① 初始状态**（`$ISO/appstate/`，6 个文件）：`site/index.html`（22B）、`site/assets/app.css`（21B）、`config/app.conf`（61B）、`plugin-state/dr-state.json`（46B）、`payload.bin`（256B，`bytes(range(256))`）、`audit/audit-snapshot.json`（1036B，`GET /api/v1/audit?since=2000-01-01T00:00:00Z&limit=100` 的真实响应原文，`total=3 records=3`）。
harness `manifest()` 逐文件记 `{mode(含权限位), size, sha256}`：`[PASS] initial_state_has_files :: files=6`；`[PASS] audit_records_present_before_disaster :: total=3 records=3`。
前态 sha 清单（`sha256` 前 16 字符）：`site/index.html=78643a522b57d958…`、`site/assets/app.css=8ce1b94dd255b6a9…`、`config/app.conf=9cd194ea0f4615d0…`、`plugin-state/dr-state.json=1d48e5cf6abe7f60…`、`payload.bin=40aff2e9d2d8922e…`、`audit/audit-snapshot.json=01e17d5a5b1ea12b…`（全文见 harness `PRE_MANIFEST` 输出）。

**② `backup.create`**（真 tar.gz）：`{"name":"dr-live","paths":[appstate/site, appstate/config, appstate/audit, appstate/plugin-state, appstate/payload.bin]}` →
`200 {"id":"dr-live-20261128T045925Z","size_bytes":1536,"uncompressed_bytes":1442,"entries":11,"sha256":"15d4de8f5133e7d97ac94885a32a364dcbbeeff27295d3afd14db99693c3a166","skipped":[],"warnings":[]}`。
`[PASS] backup_create_200 / create_has_id_sha / tar_gz_exists_on_disk / archive_sha_matches_create`（harness 自算 sha 与声明一致）、`[PASS] archive_is_valid_targz :: entries=11`（`tarfile.open(...,'r:gz')` 成功，成员 `site, site/assets, site/assets/app.css, site/index.html, config, config/app.conf, audit, audit/audit-snapshot.json, plugin-state, plugin-state/dr-state.json, payload.bin`）、`[PASS] archive_contains_audit_snapshot`、`[PASS] backup_verify_ok_before_disaster`（`ok=true`）。备份包落在 `$ISO/backups/`，**在随后被毁的 `appstate/` 之外**。

**③ 模拟灾难**：`proc.terminate()` + `wait(timeout=15)` → `[PASS] graceful_stop`；`os.rename($ISO/appstate, $ISO/appstate.destroyed)` → `[PASS] state_dir_renamed_disaster`；`[PASS] backup_survives_disaster`（包仍在 `$ISO/backups/`）。

**④ 恢复到空目录**：重启实例（`[PASS] kored_restart_spawned`、`[PASS] isolated_healthz_200_after_disaster`、`[PASS] relogin_after_disaster`），再 `backup.restore {"id":"dr-live-20261128T045925Z","target_dir":"$ISO/appstate"}` →
`200 {"id":"dr-live-20261128T045925Z","restored_entries":11,"target_dir":"$ISO/appstate","failed":[],"duration_ms":0}`。
`[PASS] restore_200 / restore_entries_positive / restore_target_empty_then_filled`。

**⑤ 断言逐字节一致 + 审计在**：harness 重算 `manifest($ISO/appstate)`，`[PASS] restored_manifest_byte_identical :: pre=6 post=6`（每个文件的 mode/size/sha256 全等，含 `payload.bin` 的 256 字节二进制）；`[PASS] audit_file_restored_byte_exact`（`audit/audit-snapshot.json` sha `01e17d5a…` 与灾难前一致）、`[PASS] restored_audit_has_real_records / restored_audit_total_positive :: total=3`（恢复出的是**真审计记录**非空 JSON，不是空壳）；`[PASS] audit_endpoint_200_after_restore / live_audit_records_after_restore`（恢复后 `GET /api/v1/audit?since=…` 仍 200 且 `total>0`）。

**结论**：create→毁状态→restore→重启→逐字节核对闭环成立。`backup.restore` 能把 `backup.create` 产物恢复到空目录，服务能起来，恢复文件与灾难前逐字节一致（含二进制与审计快照）。

### 2.4 边界拒绝（PASS，6 条）

| 场景 | HTTP + RAW 原文 | 断言 |
| --- | --- | --- |
| 错确认：空 `target_dir` | 400 `{"code":"E_INVALID","message":"target_dir 不能为空","detail":""}` | `wrong_confirm_empty_target_rejected` |
| 恢复到非空目录 | 409 `{"code":"E_CONFLICT","message":"target_dir 已存在且非空，拒绝半恢复覆盖","detail":""}` | `nonempty_target_rejected_E_CONFLICT` |
| 非空目录未被覆盖 | 预置 sentinel 内容仍为 `DO-NOT-OVERWRITE\n` | `nonempty_target_not_overwritten` |
| 损坏备份包 | 第二个 `backup.create` 造包后把 tar.gz 覆写为 `b'NOT-A-VALID-GZIP-ARCHIVE'*4`，restore → 400 `{"code":"E_INVALID","message":"备份包不是合法 gzip","detail":""}` | `corrupt_archive_restore_rejected` |
| 损坏包不留半恢复目标 | `$ISO/corrupt-target` 不存在（staging 被清理，未 rename） | `corrupt_target_not_created` |
| 主实例 8787 不受影响 | `GET /-/healthz` → 200 | `host_8787_untouched` |

诚实口径：「错确认」在协议层只能测空 target_dir 这种必填参数错误；前端「点恢复→再点确认恢复」的两级 UI 点击本轮未用浏览器重验（见 §1.3），不把协议层拒绝冒充 UI 门禁验证。

---

## 3. 中途失败记录（均为 harness 口径，非产品缺陷；已修正后全绿）

首轮 DR 演练 43 条中 4 条 FAIL：`audit_readable_before_disaster` / `audit_pre_count_positive` / `audit_endpoint_200_after_restore` / `audit_records_present_after_restore`，原文均为
`400 {"code":"E_INVALID","message":"缺少必填参数 since（RFC3339；全量导出已禁止）","detail":""}`。
根因：`GET /api/v1/audit` 的 `since` 是必填（`internal/core/httpapi/handlers_audit.go:112-116`），harness 首轮漏传；且审计响应字段是 `records`/`total`（`:44-51`），首轮按 `items`/`events` 解析取到 0。
修正：查询加 `?since=2000-01-01T00:00:00Z&limit=100`，解析改读 `records`/`total`；重跑后 45/45 全绿。这 4 条是**验证 harness 口径错误**，不是 backup 插件或内核缺陷；修前主链（create→毁状态→restore→重启→逐字节 manifest 一致）已全 PASS。

---

## 4. 清理与回读（命令 + 退出码 + 原文）

```
ls -ld /tmp/kore-dr-iso-55251 /tmp/kore-dr-build  → exit=2（两者均 No such file or directory）
ss -ltn | grep ':55251\b'                          → NO_LISTENER_55251
curl 127.0.0.1:8787/-/healthz                      → HTTP=200（主实例未受影响）
kore git status --short                            → 除他人既有 dirty（scripts/usability-pending.txt 等）外无本报告之外新增
kore-plugin-backup git status --short              → 空（本轮未改插件仓）
find . -maxdepth 2 -name '*harness*' -o -name 'dr-*.py' → 空（无一次性脚本残留）
```

隔离 kored 已 `terminate()` + `wait()` 停止；口令文件、cookie、日志、state/run/index、造包、临时二进制随隔离树一并删除。harness 以 `python3 - <<'PYEOF'` 内联执行，未在工作区落盘任何脚本。

他人 dirty（`M scripts/usability-pending.txt` 及既有 `?? .agents/verify/*.md` / `?? data/` / `?? dist/` / `?? .agents/.agents/` / `?? .agents/verify/screenshots/adp-debug-desktop-01.png`）全程原样未动、未 add/commit。

---

## 5. 诚实边界（不夸大）

- **单机单实例隔离，非 8787**：仅 1 个隔离 kored（`127.0.0.1:55251`）+ 1 个本地 backup 插件 0.6.0；临时二进制从当前 HEAD 编译，**未覆盖宿主 `bin/kored`**、未碰 `.kore-local-*`。无集群 / 多机（G-11 不做）。
- **模拟灾难 = 改名隔离 state，非真实硬件故障**：用「停实例 + `os.rename($ISO/appstate → $ISO/appstate.destroyed)`」模拟状态丢失；未做磁盘损坏 / 断电 / 真实硬件故障注入，不宣称覆盖这些场景。备份包刻意放在被毁目录之外（真实 DR 里备份应在异地；异地 / S3 按 G-11 不做）。
- **无竞品同口径对照**：本轮只验我方 `backup.create`→`backup.restore` 闭环，未下载 / 安装 / 运行任何竞品，不判「超越 / 领先」。
- **未覆盖**：前端浏览器两级点击（协议层空 target 拒绝已测；UI 门禁由 G-28 既有双端截图覆盖，本轮未重跑浏览器）、非管理员 403（单管理员模式 + G-11 不做多用户，无真机可创建非管理员用户）、真实异步长任务 / 多块 >4 MiB 包、并发 restore 抢同一 target（静态竞态见 `race-pattern-audit.md:69`，本轮未复现）、真实 8787 生产库恢复。
- **真机未暴露生产缺陷**：45/45 PASS，无需另派 file:line 缺陷卡。

---

## 6. 提交

唯一提交文件为本报告 `kore/.agents/verify/backup-dr-live.md`，精确 `git add` + `git commit -s`，提交头 `[agent:backup-dr] docs(verify): ...`；未 push、未联网业务、未改生产代码 / 未 bump / 未发版。verifier 另派独立复跑。
