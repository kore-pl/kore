# 上传还原 P3 真机验证报告（task-245）

> 元信息：2026-11-28T00:09+08:00 · 执行者 `upload-restore-live`（真机验证 worker，非 P1/P2 实现者）· 写域仅本报告。
> 对象：`kore@ab28afa`（隔离 kored 复用工作区 `bin/kored`，sha256 `162a67bde189780ad7690ce8afeefb128071b57685bc58d68f79f773a6dc48bf`）、
> `kore-plugin-backup@5ce05a6`（v0.6.0，dist `backup-0.6.0.tar.gz` sha256 `a5043d36d951c53f8bbff167cf300fd865793243bc315d955a18f41b743acbe4`，与 `kore-plugins/index/plugins.json#backup@0.6.0` 逐字符一致）。
> 未改生产代码 / 未 bump / 未 push / 未执行 install-upgrade 到主实例 / 未联网业务。
>
> **总评：61/61 断言 PASS，0 FAIL。真机未暴露生产缺陷。** 合法包经真实 `POST /api/v1/invoke/backup/*` 走完 begin→chunk→commit，
> list/verify/restore 回读一致；10 类恶意归档在 commit 阶段被拒且暂存清理；越权/超大/超限块/乱序/错 id/缺块被拒；
> abort 与 TTL（模拟到期）清理通过。中途 3 次失败均为**验证 harness 自身口径问题**（见 §6），已修正后全绿，不是产品缺陷。

---

## 1. 隔离边界（开局与全程，命令 + 退出码）

| 项 | 事实 | 命令 + 退出码 |
| --- | --- | --- |
| 端口 | 仅 `127.0.0.1:55141`（非 8787） | `ss -ltn \| grep ':55141\b'` → 开局 `PORT_FREE`（无命中）；收尾 `55141 NO_LISTENER` |
| 独立目录 | config/state/run/log/index/backups/src 全落 `kore/.ul-iso/` | `mkdir -p $ISO/{state,run,log,index,backups,src,gocache}` → exit 0 |
| 配置 | `server.addr=127.0.0.1:55141`；`paths.state_dir/run_dir/log_dir/index_dir` 均指 `$ISO` 子目录；index 为 `kore-plugins/index` 已签名快照副本 | `admin-password --set --stdin --config $ISO/config.yaml < $ISO/.pw` → `ADMINPW_EXIT=0` |
| 凭据 | 随机口令只写 0600 文件 `$ISO/.pw`，仅在 harness 进程内存使用；argv/报告/CURL 展示均为 `***` | `stat -c '%a' $ISO/.pw` = 600；报告无明文（G-30） |
| 插件环境 | `KORE_BACKUP_DIR=$ISO/backups`、`KORE_BACKUP_ALLOW_ROOTS=$ISO`（含 src/backups/restored）、`KORE_STATE_DIR=$ISO/state`，仅注入隔离 kored 进程 | 均由 kored 继承给 lazy 插件子进程 |
| 未碰禁区 | 未读写/重启/kill 8787；未碰 `.kore-local-*` / 宿主 / 外网；未执行真实 install/upgrade 到系统路径 | 收尾 `curl http://127.0.0.1:8787/-/healthz` → `HTTP=200`（前后一致） |
| 主壳日志 | `kore ready pid=... addr=127.0.0.1:55141 socket=$ISO/run/kore.sock`；`插件就绪 plugin_id=backup socket=$ISO/run/plugins/backup.sock` | `$ISO/kored.log` 原文，随隔离树删除 |

运行形态：因每次 bash 调用是独立沙箱、进程不跨调用存活，全部步骤（起服→登录→装插件→断言→停服→清理）写在**同一份 harness 脚本、同一次 bash 调用**内完成；脚本与隔离树用完即删（§8）。
因共享 GOMODCACHE 只读且缺 bbolt v1.5.0 zip，`GOPROXY=off` 无法在隔离空缓存重编 kored（实测 `module lookup disabled by GOPROXY=off`），
故隔离实例复用工作区已构建的 `bin/kored`（来自当前 HEAD `ab28afa`），并记录其 sha256；隔离性由 config/state/run/port 保证，不靠重编。

统一调用形态（每次 invoke 独立 HTTP 请求，kored 内部按 lazy 生命周期唤醒插件并经 UDS 转发）：
```
curl -s -X POST -b $COOKIE -H 'X-Kore-CSRF: $CSRF' -H 'Content-Type: application/json' \
  -d '<params>' http://127.0.0.1:55141/api/v1/invoke/backup/<method>
```
harness 退出码：`python3 .ul-harness.py` → **exit 0**，末行 `[SUMMARY] TOTAL=61 PASS=61 FAIL=0`。

---

## 2. 前置：healthz / login / install / enable（全部 200）

| 步骤 | 命令 | 退出码(HTTP) | 响应原文 |
| --- | --- | --- | --- |
| healthz | `GET /-/healthz` | 200 | `{"status":"ok"}` |
| login | `POST /api/v1/auth/login {"username":"admin","password":"***"}` | 200 | `{"authenticated":true,"expires_at":"2026-11-28T04:09:23Z"}` |
| session | `GET /api/v1/auth/session` | 200 | `{"authenticated":true,"expires_at":"2026-11-28T04:09:23Z"}` |
| install | `POST /api/v1/store/install {"id":"backup","version":"0.6.0","package_path":"<dist 绝对路径>"}` | 200 | `{"id":"backup-0.6.0","plugin_id":"backup","version":"0.6.0","state":"succeeded","message":"安装完成","reload":"reloaded"}` |
| enable | `POST /api/v1/plugins/backup/enable {}` | 200 | `{"id":"backup",...,"lifecycle":"lazy","state":"stopped","desired":"enabled","enabled":true,"granted_capabilities":["system:admin"],"granted_by":"install:auto",...,"method_capabilities":{"backup.upload":"system:admin",...}}` |

断言：`healthz_200 / login_200 / session_authenticated / install_succeeded / enable_ok` 全 PASS。

---

## 3. 断言① 合法路径（PASS，14 条）

自造合法 `tar.gz`：目录 `site/`（mode 0755）+ 普通文件 `site/a.txt`（内容 `alpha\n`，6 字节），共 138 字节，
`sha256=b470ea9886a9415276ccc889b88c129532cdcc413e7a4d16b6657689f0a30856`（harness 自算，不信任声明）。

四阶段（begin/chunk/commit，base64 分块；本次文件小，单块 offset=0）：

| 阶段 | HTTP | 响应原文 |
| --- | --- | --- |
| `backup.upload` begin | 200 | `{"upload_id":"u-good","chunk_bytes":4194304,"expires_at":"2026-11-27T16:39:23Z","hint":"按 4 MiB 分块调用 phase=chunk；全部传完再调用 phase=commit 导入，导入不会自动恢复"}` |
| chunk | 200 | `{"upload_id":"u-good","offset":0,"next_offset":138,"received_bytes":138}` |
| commit | 200 | `{"id":"imported-20261127T160923Z","filename":"imported-20261127T160923Z.tar.gz","size_bytes":138,"sha256":"b470ea98…30856","entries":2,"compression":"gzip","managed":false,"duration_ms":1,"hint":"导入完成；到备份列表点「恢复」并二次确认才会写入目标目录"}` |

- `good_commit_shape PASS`：`id` 非空、`entries=2`、`managed=false`。
- `list_has_new_package PASS`（`backup.list` 200）：`{"backups":[{"id":"imported-20261127T160923Z",...,"sha256":"b470ea98…","compression":"gzip","corrupted":false,"managed":false}],"count":1,...}` —— 新包可见且标 `managed:false`。
- `verify_sha_match PASS`（`backup.verify` 200）：`{"id":"imported-20261127T160923Z","ok":true,"checks":[{"name":"exists","ok":true,...},{"name":"size","ok":true,...},{"name":"sha256","ok":true,"detail":"sha256 与记录一致"},{"name":"readable","ok":true,"detail":"压缩包可完整读取（2 个条目）"}],...,"entries":2,"uncompressed_bytes":6,...}`。
- `restore_200 PASS`（`backup.restore {"id":"imported-…","target_dir":"$ISO/restored"}`）：`{"id":"imported-20261127T160923Z","restored_entries":2,"target_dir":"$ISO/restored","failed":[],"duration_ms":0}`。
- `restore_content_identical PASS`：回读 `readback=b'alpha\n'`，与造包内容逐字节一致（等价 `cmp -s $ISO/restored/site/a.txt <(printf 'alpha\n')` exit 0）；实测 `find $ISO/restored -type f` → `restored/site/a.txt 6 bytes`。
- `sha256_sidecar_valid PASS`：sidecar 原文 `b470ea9886a9415276ccc889b88c129532cdcc413e7a4d16b6657689f0a30856  imported-20261127T160923Z.tar.gz`，与自算 sha256 相同（等价 `sha256sum -c` OK）。
- `Managed=false 不被 retention 误删 PASS`：先 `backup.create` 造一个受控 managed 包 `managed-old-20261127T160923Z`（200，带 `.tar.gz.meta.json`），把它的 meta `created_at` 回拨 2 小时；再 `backup.retention {"keep":1}`（200）→
  `{"kept":1,"deleted":[{"id":"managed-old-20261127T160923Z","name":"managed-old","created_at":"2026-11-27T14:09:23Z","size_bytes":192}],"freed_bytes":192,"dry_run":false,"protected":[]}`；
  断言 `managed_false_survives_retention PASS`（`test -f $ISO/backups/imported-…tar.gz` 为真）、`older_managed_deleted PASS`（旧 managed 包确被删）。证明 retention 只删 Managed=true，`managed:false` 的外来包被跳过。
- 两级确认边界（诚实）：`backup.restore` 协议层**无 confirm 参数**；"两级确认"是前端 `bak-confirm` 面板的 UI 门禁（P2 已由 G-28 双端截图证据覆盖），本次按既有 e2e 口径用真机 invoke 复用 restore，未重验前端二次点击。

---

## 4. 断言② 恶意归档拒绝（PASS，30 条：10 类 × commit 拒绝/暂存清理/无落包）

每类均先 begin + chunk 成功（HTTP 200），再 commit 被拒（HTTP 400 / `E_INVALID`），随后断言暂存目录 `.upload-<id>` 不存在、备份目录无该名包。
下表为 commit 阶段原始响应（逐条可回读）：

| 恶意类型 | upload_id | commit HTTP + RAW 原文 |
| --- | --- | --- |
| 绝对路径成员 `/etc/kore-evil.txt` | `m-abs` | 400 `{"code":"E_INVALID","message":"归档条目使用绝对路径，整包拒绝","detail":""}` |
| `../` 逃逸成员 | `m-trav` | 400 `{"code":"E_INVALID","message":"归档条目含 .. 段，整包拒绝","detail":""}` |
| 符号链接绝对目标 `/etc/passwd` | `m-symabs` | 400 `{"code":"E_INVALID","message":"符号链接目标为绝对路径，整包拒绝","detail":""}` |
| 符号链接相对逃逸 `../../outside` | `m-symesc` | 400 `{"code":"E_INVALID","message":"符号链接目标越出恢复目录，整包拒绝","detail":""}` |
| 字符设备 | `m-chardev` | 400 `{"code":"E_INVALID","message":"归档包含字符/块设备条目，整包拒绝","detail":""}` |
| 块设备 | `m-blkdev` | 400 `{"code":"E_INVALID","message":"归档包含字符/块设备条目，整包拒绝","detail":""}` |
| FIFO | `m-fifo` | 400 `{"code":"E_INVALID","message":"归档包含不支持的条目类型，整包拒绝","detail":""}` |
| 硬链接 | `m-hardlink` | 400 `{"code":"E_INVALID","message":"归档包含不支持的条目类型，整包拒绝","detail":""}` |
| 超长链接名（5000 字符） | `m-longname` | 400 `{"code":"E_INVALID","message":"归档条目路径超过 4096 字节上限","detail":""}` |
| 解压炸弹（头声明 3 GiB，无实体数据） | `m-zipbomb` | 400 `{"code":"E_INVALID","message":"归档条目大小超过 2 GiB 上限","detail":""}` |

每类三条断言均为 PASS：`mal_<type>_commit_rejected` / `mal_<type>_staging_cleaned` / `mal_<type>_no_backup_file`。
关键：**拒绝发生在 commit 的安全扫描阶段**（begin/chunk 均 200），与 `scanUploadArchive` 复用 `validateRestoreHeader` + `withinPath` 的实现一致（upload.go:470-519）。

---

## 5. 断言③ 边界拒绝（PASS，10 条）

| 场景 | 命令要点 | HTTP + RAW 原文 | 断言 |
| --- | --- | --- | --- |
| 未授权（仅 CSRF、无会话） | `POST /invoke/backup/backup.upload` begin，带 `kore_csrf` 但不带 `kore_session` | 401 `{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}` | `unauthorized_401_E_UNAUTHORIZED PASS` |
| 完全无 cookie | 同上，空 cookie | 401 `{"code":"E_UNAUTHORIZED","message":"CSRF 校验失败","detail":""}` | `unauthorized_nocookie_401 PASS` |
| 超大 >512 MiB | begin `size_bytes=536870913` | 400 `{"code":"E_INVALID","message":"文件大小必须在 1–536870912 字节之间（上限 512 MiB）","detail":""}` | `oversized_512mib_rejected PASS` |
| 单块 >4 MiB | begin 后 chunk `4 MiB+1` 字节 base64 | 400 `{"code":"E_INVALID","message":"单块超过 4 MiB 上限，请按 4 MiB 重新分块","detail":""}` | `chunk_gt_4mib_rejected PASS`；随后 abort 200 |
| 乱序 offset | begin 后 chunk `offset=10`（应为 0） | 409 `{"code":"E_CONFLICT","message":"分块 offset 必须等于已接收字节数，拒绝重叠或回退","detail":""}` | `out_of_order_rejected PASS`；随后 abort 200 |
| 错误 upload_id | 从未 begin 的 `u-wid-never` 发 chunk | 404 `{"code":"E_NOTFOUND","message":"上传会话不存在或已清理","detail":""}` | `wrong_upload_id_rejected PASS` |
| 缺失块直接 commit | begin `size_bytes=100` 后直接 commit | 400 `{"code":"E_INVALID","message":"上传未完成：已接收字节数与声明大小不一致","detail":""}` | `missing_chunk_rejected PASS` + `missing_chunk_staging_cleaned PASS` |

> 超大用**头声明模拟**（不真造 512 MiB）：begin 阶段即被 `upload.go:146` 的 512 MiB 上限拒绝，无需稀疏文件；解压炸弹同样用 tar 头声明模拟（§4）。
> "非 system:admin 用户"的 403 路径：`backup.upload` 的 method_capability 确为 `system:admin`（§2 enable 原文），代码在
> `kore/internal/core/httpapi/invoke_capability.go:137-143` 对能力不足返回 403 `E_UNAUTHORIZED`。但当前为**单管理员模式**——
> 有效会话一律获得 6 项全权（`invoke_capability.go:104-106`），且 G-11 明确不做多用户 RBAC，真机无可创建的非管理员用户。
> 故 **403 路径由代码背书、未真机触发**；真机已触发的是 401 未授权路径。诚实标注，不冒充"非管理员真机验证"。

---

## 6. 断言④ TTL / 清理（PASS，5 条）

- 显式 abort：begin `u-abort` → 200 `{"upload_id":"u-abort","chunk_bytes":4194304,...}`；`phase=abort` → 200 `{"upload_id":"u-abort","aborted":true}`；
  `abort_staging_cleaned PASS`（`.upload-u-abort` 不存在）。
- TTL 到期：`UploadTTL=30*time.Minute` 为编译期常量（`upload.go:32`），**不可配置**。
  真机做法：begin `u-ttl` + chunk 完成后，把 `$ISO/backups/.upload-u-ttl/.upload.json` 的 `created_at` 回拨 2 小时（模拟到期），再 commit →
  400 `{"code":"E_INVALID","message":"上传会话已超过 30 分钟，已清理，请重新上传","detail":""}`，`ttl_staging_cleaned PASS`。
- SweepStaleUploads：手工造一个 `created_at` 回拨 2 小时的 `.upload-u-sweepold/`，随后正常 begin `u-sweep`（200）→
  `stale_swept_on_begin PASS`（陈旧暂存被 begin 触发的 sweep 清理），再 abort 清理。

**诚实边界**：未真实等待 30 分钟——TTL 常量不可配，真机以"回拨状态文件时间戳"验证拒绝与清理分支；真实 30min 自然到期由单测覆盖（`upload_test.go` / `SweepStaleUploads`）。不把模拟到期说成真等 30 分钟。

---

## 7. 中途失败记录（均为 harness 口径，非产品缺陷；已修正后全绿）

1. 首轮故意用假口令 `***` 走了一次 login，触发 ADR-0057 验证码态，随后真登录返回 428 `E_CAPTCHA_REQUIRED` → 全链 401。
   修正：去掉假登录，真口令只从 0600 文件读入。非缺陷。
2. 未授权用例首轮空 cookie 命中 CSRF 门在前（401 "CSRF 校验失败"），与预期的鉴权门 401 "未授权"不同。
   修正：造"仅带 `kore_csrf`、无会话"客户端越过 CSRF 门，真机拿到 401 "未授权"；两种 401 均记录。非缺陷。
3. 造包把目录 `site/` 的 mode 设成 0644（无执行位），restore 忠实应用后目录不可遍历，回读失败；
   以及把 managed sidecar 写成 `<id>.meta.json` 而非真实的 `<id>.tar.gz.meta.json`，导致回拨未生效。
   修正：目录改 0755、sidecar 名改正、允许根含 restored。修正后 61/61 全绿。三处均为**造包/用例口径错误**，非生产代码缺陷。
   另有一次隔离树残留 0644 目录导致 `rm -rf` 权限不足、目标目录非空触发 409；收尾用 `chmod -R u+rwx` 后删除，已回读确认。

---

## 8. 隔离诚实边界（不夸大）

- **BT 的"从 1Panel/AMH 迁移"属 G-11 有意偏离，本次不含**；不把上传功能说成等价厂商迁移。
- **download 链路的证据缺口不借本次背书**：本次只验证 upload→list/verify→restore，未验证 `backup.download`，两链路证据分开。
- 本结论为**上述 61 条断言范围内的真机通过**，不等于"全场景覆盖"：未覆盖真实 30min 自然到期、非管理员 403、前端两级点击、多块 >4 MiB 分片、并发上传、download。
- 未改生产代码、未 bump、未发版；真机未暴露生产缺陷，故无 file:line 缺陷单需另派。

---

## 9. 清理与回读（命令 + 退出码 + 原文）

```
rm -rf .ul-iso                         → exit 0
rm .ul-harness.py                      → exit 0
回读：.ul-iso / .ul-harness.py / .ul-probe   → 三者 ABSENT
回读：ss -ltn | grep ':55141\b'        → 55141 NO_LISTENER
回读：curl 127.0.0.1:8787/-/healthz    → HTTP=200（主实例未受影响）
回读：ps -ef | grep '.ul-iso/(kored|bin/backup)' → NO_ISO_PROCESS
回读：git status --short（临时资产）    → NO_TEMP_GIT_ENTRIES
```
隔离 kored 已 `kill` + `wait` 停止（`STOPPED`）；口令文件、cookie、日志、state/run/index、造包与 harness 脚本随隔离树一并删除。

---

## 10. 提交

唯一提交文件为本报告：`kore/.agents/verify/upload-restore-live.md`，精确 `git add` + `git commit -s`，
提交头 `[agent:upload-restore-live] docs(verify): ...`；未 push、未联网业务、未执行 install-upgrade。
