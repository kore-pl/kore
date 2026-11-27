# backup.download 真机验证报告（task-284）

> 元信息：2026-11-28T06:57+08:00 · 执行者 `backup-download-live`（真机验证 worker）· 写域仅本报告。
> 对象：`kore@826fffd`（工作区 `bin/kored` sha256 `5ffc2337e958e222a8da686d1bed3d724e9dec97af4a3fc3f9b474f7e4f62322`）、
> `kore-plugin-backup@9622eaf`（本地 dist `backup-0.6.0.tar.gz` sha256 `a5043d36d951c53f8bbff167cf300fd865793243bc315d955a18f41b743acbe4`，与 `kore-plugins/index/plugins.json#backup@0.6.0` 逐字符一致）。
> 未改生产代码 / 未 bump / 未 push / 未联网业务 / 未装包 / 未碰 8787 与 `.kore-local-*`。
>
> **总评：阶段一缺口属实（代码在 HEAD、前端入口在、既有报告明确未验）；阶段二 37/37 断言 PASS，0 FAIL。真机未暴露生产缺陷。**
> 本地 `backup.create` 造的真 tar.gz 经 `backup.download` 分块 base64 拉取、本地重组，逐字节与源包一致、sha256 与 `create` 声明一致、`backup.verify` 全绿。

---

## 1. 阶段一：只读核实（先做，不臆断）

四条核实全部在执行前完成，均为只读命令；退出码 0 表示命令正常结束（文件存在 / 命中）。

### ① download 代码仍在 HEAD

| 核实项 | 事实 | 命令 + 退出码 |
| --- | --- | --- |
| 执行面实现 | `kore-plugin-backup/internal/backupop/download.go:60` `callDownload`；`:95` `Download`；`:22` `MaxDownloadChunk=4<<20`；`:140-148` `io.LimitReader` + `base64.StdEncoding`；`:154` `assertInsideBackupDir` | `read` 全文 186 行；`git status --short -- internal/backupop/download.go` 空、`exit=0`；`git ls-tree -r --name-only HEAD \| grep -F internal/backupop/download.go` 命中、`exit=0` |
| 方法分发 | `kore-plugin-backup/internal/backupop/call.go:45-46` `case "download": return callDownload(...)`；`:66-67` `businessVerb` 白名单含 `download` | `read` 全文 178 行，`exit=0` |
| info.json 声明 | `kore-plugin-backup/info.json:22` `"backup.download": "system:read"`；`:54` methods 数组含 `backup.download` | `read` 全文 62 行；`grep -rn backup.download` 命中，`exit=0` |
| 仓库状态 | backup 仓 worktree 干净（`git status --short` 空，`exit=0`），HEAD=`9622eafb...`，故上述文件即 HEAD 内容 | `git rev-parse HEAD` → `9622eafb088ba39056b51f008b2597ccbea43f03`，`exit=0` |

### ② 前端下载入口在

| 核实项 | 事实 | 命令 + 退出码 |
| --- | --- | --- |
| 分块下载函数 | `kore/web/backups.js:696` `function downloadBackup(b)`；`:700` `invoke('backup.download',{id, inline:true, offset})`；`:701-704` 收 `data_base64` + 按 `next_offset` 递归；`:706-711` `atob` → `Blob` → `<a download>` | `grep -n download web/backups.js` 6 命中、`exit=0`；`read 690-729`，`exit=0` |
| 行内按钮 | `kore/web/backups.js:917` `button(ops,'下载','btn-ghost',function(){downloadBackup(b);})` | `read 910-923`，`exit=0` |
| 文件在 HEAD | `git status --short -- web/backups.js` 空；`git hash-object` == `git rev-parse HEAD:web/backups.js` == `59565f3d...` | `exit=0` |

### ③ 未实机验证表述属实

`kore/.agents/verify/backup-redis-ui.md`（HEAD 内容，`git status --short` 空、`exit=0`）：

- `:39`「**下载按钮是每条备份记录的行内动作**，本轮 0 份备份故不可见」
- `:40`「没有真实备份产物，『下载』入口与作业进度未在截图中体现，**不能据此宣称『下载链路已验证可用』**」
- `:50`「无真实备份产物：0 份备份，『下载』为行内按钮故不可见；作业进度（jobs）为空态」

`read` 30-54 行、`exit=0`。表述与代码/前端一致，缺口属实。

### ④ 既有真机报告确认下载链路从未真机验证

| 报告 | 原文 | 命令 + 退出码 |
| --- | --- | --- |
| `kore/.agents/verify/upload-restore-live.md:152` | 「download 链路的证据缺口不借本次背书：本次只验证 upload→list/verify/restore，**未验证 `backup.download`**，两链路证据分开」 | `sed -n 145,158p`，`exit=0` |
| 同上 `:153` | 未覆盖项含「…并发上传、**download**」 | 同上 |
| `kore/.agents/verify/upload-restore-live-verification.md:83` | 「download 链路证据缺口 → 明确写『不借本次背书、两链路证据分开』。✓」 | `grep -n download`，`exit=0` |
| `kore/.agents/verify/parity-evidence-r27.md:5/:50/:102` | 「`backup.download` 在 G-28 时 0 份包、按钮不可见，**下载未实机验证属证据缺口**」 | `grep -n download`，`exit=0` |
| backlog `kore/docs/FEATURE-GAP-BACKLOG.md:58` | 「下载链路未实机验证属证据缺口、非功能缺口（`backup-redis-ui.md:39-40,50`），不得据此宣称下载已验证」 | `sed -n 55,60p`，`exit=0` |

全 `.agents/verify/*.md` 逐一 grep「download 链路.*真机\|下载.*逐字节\|download.*sha256」等，**无任何既有报告声称 `backup.download` 已真机验证**（命中的是索引包下载、文件域上传下载、发布资产下载等其它链路）。结论：缺口属实，代码未移除，值得补验。

---

## 2. 阶段二：隔离真机验证（阶段一确认缺口后执行）

### 2.1 隔离边界与运行形态

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 端口 | 仅 `127.0.0.1:55181`（非 8787） | 开局 `connect_ex=111`（空闲）→ `[PASS] port_55181_free_at_start`；收尾 `NO_LISTENER_55181` → `[PASS] port_55181_free_after_stop` |
| 独立目录 | config/state/run/log/index/backups/src/restored 全落 `/tmp/kore-dl-iso-55181/` | harness `fresh_iso()` 建目录；收尾 `ls` → `No such file or directory`（`exit=2` 即已不存在）→ `[PASS] iso_tree_removed` |
| 配置 | `server.addr=127.0.0.1:55181`；`paths.state_dir/run_dir/log_dir/index_dir` 全指隔离树子目录；index 为 `kore-plugins/index` 已签名快照副本（离线） | `write_cfg()` 写入 `$ISO/config/config.yaml`（0600 由 admin-password 写）；isolated healthz 200 |
| 凭据 | 随机口令只写 0600 文件 `$ISO/.pw`，经 stdin 喂给 `kored admin-password --set --stdin --config`；argv/报告无明文 | `[PASS] admin_password_set_exit0 :: exit=0`；报告内仅占位（G-30） |
| 插件环境 | `KORE_BACKUP_DIR=$ISO/backups`、`KORE_BACKUP_ALLOW_ROOTS=$ISO`、`KORE_STATE_DIR=$ISO/state`，仅注入隔离 kored 进程（子进程继承） | harness `env.update(...)`；create/list/download/verify 全 200 |
| 未碰禁区 | 未读写/重启/kill 8787；未碰 `.kore-local-*` / 宿主 / 外网；未装包 | `[PASS] main_8787_still_healthy :: status=200`（前后一致） |
| 主壳日志 | isolated kored pid 正常 spawn、`/-/healthz` `{"status":"ok"}` | `[PASS] kored_spawned pid=9`；`[PASS] isolated_healthz_200 waited=0.5s` |

运行形态：`bash` 每次调用是独立沙箱、进程不跨调用存活，故起服→登录→装插件→造包→断言→停服→清理写在**同一份内联 Python harness（heredoc，不落盘为文件）、同一次 bash 调用**内完成；harness 无临时脚本文件残留（用户明令一次性脚本用完删净），隔离树 `/tmp/kore-dl-iso-55181` 由 harness `finally` 中 `shutil.rmtree` 删除并回读确认。
共享 GOMODCACHE 只读且禁联网，隔离实例复用工作区已构建 `bin/kored`（当前 HEAD，sha256 `5ffc2337...`），隔离性由 config/state/run/port 保证，不靠重编。

统一调用形态（每次 invoke 独立 HTTP 请求，kored 内部按 lazy 生命周期唤醒插件并经 UDS 转发）：
```
POST /api/v1/invoke/backup/<method>  (Cookie: kore_session + kore_csrf; X-Kore-CSRF: <token>; JSON body)
```
harness 退出码：`python3 - <<'PYEOF' ... PYEOF` → **`HARNESS_EXIT=0`**，末行 `[SUMMARY] TOTAL=37 PASS=37 FAIL=0`。

### 2.2 前置（healthz / login / install / enable）

| 步骤 | 退出码(HTTP) | 响应原文 |
| --- | --- | --- |
| `GET /-/healthz` | 200 | `{"status":"ok"}` |
| `POST /api/v1/auth/login` | 200 | `{"authenticated":true,"expires_at":"2026-12-04T23:03:22Z"}` |
| `POST /api/v1/store/install {"id":"backup","version":"0.6.0","package_path":"<dist 绝对路径>"}` | 200 | `{"id":"backup-0.6.0","plugin_id":"backup","version":"0.6.0","state":"succeeded","message":"安装完成","reload":"reloaded"}` |
| `POST /api/v1/plugins/backup/enable {}` | 200 | `{"id":"backup","lifecycle":"lazy","desired":"enabled","enabled":true,...}` |

`[PASS] login_200 / csrf_cookie_set / install_backup_succeeded / enable_backup_ok`。

### 2.3 主链：造包 → list → download 分块 → 重组 → sha256 → verify（PASS，19 条）

自造真备份：`backup.create {"name":"dl-snap","paths":["$ISO/src"]}`，源目录 `src/site/a.txt` 内容 `alpha\n`（6 字节）。
产物：`id=dl-snap-20261127T230322Z`，`path=$ISO/backups/dl-snap-20261127T230322Z.tar.gz`，`size_bytes=275`，
`sha256=e4d77eb1ab56007409be2464155f7ff55fbbca7091489a774600d411bfe906ff`（harness 自算比对，不信任声明）。

| 断言 | HTTP | 关键证据 |
| --- | --- | --- |
| `backup_create_200` / `create_has_sha_and_path` | 200 | `id` 非空、`size_bytes=275>0`、`sha256` 与 `path` 均在 |
| `list_has_package` | 200 | `backup.list` `count=1`、唯一条目 `id` 与 `sha256` 均匹配 |
| `download_metadata_ok`（`inline` 缺省） | 200 | `inline=false`、`eof=true`、`sha256==create.sha256`、`size_bytes==create.size_bytes`、`path==create.path`、`data_base64` 空 |
| `download_content_type_gzip` | 200 | `content_type=application/gzip`（`download.go:181-185`） |
| `chunk0..4_meta`（`limit=64` 强制 5 块） | 200×5 | `off=0→64→128→192→256`，`chunk=64/64/64/64/19`，`next_offset=off+chunk`，`inline=true` 全 PASS |
| `chunked_eof_next_equals_size` | 200 | 末块 `eof=true`、`next_offset=275==size_bytes` |
| `multiple_chunks_exercised` | — | `chunks=5`（真多块，非单块凑数） |
| `downloaded_byte_identical_to_source_backup` | — | 重组 275 B == 源包 275 B，**逐字节一致** |
| `downloaded_sha_equals_create_sha` | — | 重组 sha `e4d77eb1…906ff` == `create.sha256` |
| `downloaded_file_on_disk_sha` | — | 落盘 `$ISO/downloaded-<id>.tar.gz` 后重读 sha 仍一致 |
| `downloaded_valid_targz` | — | `tarfile.open(r:gz)` 成功，成员 `['src','src/site','src/site/a.txt']` |
| `downloaded_contains_original_data` | — | 解出 `a.txt` == `b'alpha\n'`，即下载文件就是原备份内容 |
| `verify_ok_sha_match` | 200 | `backup.verify {"id":…}` → `ok=true`、`sha_match=true`，checks `exists/size/sha256/size_recorded/readable/entries` 全 `ok=true` |

**结论**：`backup.download` 返回的分块能完整拼回 `backup.create` 产出的那个 tar.gz，字节与 sha 双一致，`backup.verify` 通过 —— 下载链路真机闭环成立。

### 2.4 边界拒绝（PASS，10 条）

| 场景 | HTTP | RAW 原文 | 断言 |
| --- | --- | --- | --- |
| 错误备份 id | 404 | `{"code":"E_NOTFOUND","message":"备份不存在","detail":""}` | `wrong_id_rejected_404_notfound` |
| id 路径穿越 `../etc` | 400 | `{"code":"E_INVALID","message":"备份 id 含非法字符","detail":""}` | `traversal_id_rejected_400_invalid` |
| 单块 limit 超 4 MiB（8388608） | 400 | `{"code":"E_INVALID","message":"limit 必须在 1–4194304 字节之间（不传按 4 MiB）","detail":""}` | `oversized_limit_rejected_400` |
| offset 负数 | 400 | `{"code":"E_INVALID","message":"offset 不能为负数","detail":""}` | `negative_offset_rejected_400` |
| offset 超包大小 | 400 | `{"code":"E_INVALID","message":"offset 超过备份包大小","detail":""}` | `offset_beyond_size_rejected_400` |
| 备份目录内符号链接指向外部 | 400 | `{"code":"E_INVALID","message":"备份包不是常规文件","detail":""}`（`download.go:100-106` Lstat + `:154` 越界保护） | `symlink_escape_rejected_400` |
| 分块顺序错（反转拼接） | — | 反转后 sha ≠ `create.sha256` | `wrong_chunk_order_sha_mismatch` |
| 缺失块（仅首块） | — | 首块 64 B < 275 B，sha ≠ `create.sha256` | `missing_chunk_sha_mismatch` |
| 主实例 8787 未受影响 | 200 | `GET /-/healthz` 前后均 200 | `main_8787_still_healthy` |
| 端口/隔离树清理 | — | 见 §3 | `port_55181_free_after_stop` / `iso_tree_removed` |

**诚实口径**：`backup.download` 是**无状态 offset/limit 读文件**（`download.go:95-150`），服务端不维护"会话内块序号"，因此"乱序/缺失块"在协议层不会被逐块拒绝——前端 `backups.js:698-704` 按 `next_offset` 串行拼接才保证顺序。真机据此验证的是「错序/缺块拼出的字节 sha 与原包不符，不会被误当作有效备份」，**不宣称服务端有块序号校验**（那属于 upload 的分块语义，不是 download）。这是实现事实，不是缺陷。

---

## 3. 清理回读（命令 + 退出码 + 原文）

| 项 | 命令 | 退出码 / 原文 |
| --- | --- | --- |
| 隔离树删除 | harness `finally` 中 `shutil.rmtree('/tmp/kore-dl-iso-55181', ignore_errors=True)`；事后 `ls -ld /tmp/kore-dl-iso-55181` | `exit=2`，原文 `No such file or directory`（确已不存在）→ `[PASS] iso_tree_removed` |
| 端口释放 | `socket.connect_ex(('127.0.0.1',55181))` | `111`（ECONNREFUSED）→ `[PASS] port_55181_free_after_stop`；`ss -ltn \| grep ':55181\b'` → `NO_LISTENER_55181` |
| 隔离进程退出 | harness `proc.terminate()` + `wait(timeout=10)` | 正常返回，无残留 kored（pgrep 对 `--config /tmp/kore-dl` 无真实命中，仅匹配到本次检查命令自身） |
| 一次性脚本 | harness 以 `python3 - <<'PYEOF'` 内联执行，**未在工作区落盘任何脚本文件** | `git status --short` 未见新增 harness 脚本 |
| 凭据 | `$ISO/.pw`（0600）随隔离树删除；未在 argv / 报告 / 响应原文中出现明文 | 报告内全为占位（G-30） |
| 生产代码 / 版本 | 未改任何生产代码，未 bump，未发版，未 push | `git status --short` 除本报告与既有他人 dirty 外无新增 |

他人 dirty（`M scripts/usability-pending.txt` 及既有 `?? .agents/verify/*.md` / `?? data/` / `?? dist/` / `?? .agents/.agents/` / `?? .agents/verify/screenshots/adp-debug-desktop-01.png`）全程原样未动、未 add/commit。

---

## 4. 诚实边界（不夸大）

- **单机单实例隔离**：仅 1 个隔离 kored（`127.0.0.1:55181`）+ 1 个本地 backup 插件 0.6.0；无集群/多机（G-11 不做）。
- **本地下载闭环，非异地/S3**：验证的是 `backup.create` 产物经 `backup.download` 本地取回的完整闭环；S3/异地存储按 G-11 明确不做，本轮不涉及（G-11 不做）。
- **无竞品同口径对照**：本轮只验我方 download 链路，未下载/安装/运行任何竞品，不判"超越/领先"。
- **未覆盖**：多块 >4 MiB 默认大包（本轮用 `limit=64` 强制 5 块验证分块机制，未造 >4 MiB 实体包）、并发下载、断点续传（协议无此语义）、前端两级点击（G-28 双端截图已覆盖按钮渲染，本轮按既有 e2e 口径用真机 invoke 复用 download，未重验浏览器点击）、非管理员 403（单管理员模式 + G-11 不做多用户，无真机可创建非管理员用户）。
- **真机未暴露生产缺陷**：37/37 PASS，无 file:line 缺陷需另派。
