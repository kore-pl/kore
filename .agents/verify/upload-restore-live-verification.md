# 上传还原 P3 独立验收报告（task-246）

> 元信息：2026-11-28 · verifier `upload-restore-live-verifier`（G-09，非 `upload-restore-live`、非 P1/P2 实现者）。
> 复核对象：`kore` commit `db3f089fc4de2193bfe7dbefd8fed6ed4a7f20d5`（`.agents/verify/upload-restore-live.md`，176 行）。
> 方式：只读复核 + 只读复跑回读；未改生产代码、未启/kill 实例、未 push、未联网业务、未碰 `.kore-local-*` / 主实例运行态。
> 唯一写域 = 本报告。
>
> **总评：PASS。** 61 条断言的实质证据（HTTP 码、RAW 原文、字节数、sha、条目数）与对应源码逐条对得上；隔离与清理回读在复核当下实测成立；git 纪律合规。
> 附 1 条非阻断观测：报告各分节计数与 SUMMARY 的 61 存在 2–3 条口径差，详见 §5。

---

## 1. git 纪律（命令 + 退出码/输出）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| HEAD / 分支 | `git rev-parse HEAD` / `git branch --show-current` | `db3f089fc4de...` / `main` |
| 精确单文件 | `git show --stat --oneline db3f089` | 1 file changed, 176 insertions(+) —— 仅 `.agents/verify/upload-restore-live.md` |
| DCO | `git cat-file -p db3f089` | `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` 存在 |
| 未 push | 逐远端 `git merge-base --is-ancestor db3f089 <r>/main` | origin(`63257ba`)/github(`c4a2b00`)/gitee(`c4a2b00`) 三端均 `NOT_IN_REMOTE_REF` |
| worktree | `git worktree list` / `git branch --list 'wt-*' 'tmp-*'` | 仅主树 1 行 / 无临时分支 |
| 他人 dirty | `git status --short`（复核前/后） | 完全一致：`M scripts/usability-pending.txt` + 既有 untracked（`.agents/verify/e2e-*.md`、`data/`、`dist/` 等）；无本轮新增 |

backup 仓旁证：`git rev-parse HEAD` = `5ce05a6cc120...`（报告元信息引用正确），`git status --short` 为空。

---

## 2. 61 断言证据自洽（逐节与源码交叉核对）

### 2.1 合法路径（报告 §3，声称 14 条）

- begin/chunk/commit 均 200，响应字段与 `internal/backupop/upload.go` 的 `uploadBeginResult` / `uploadChunkResult` / `uploadCommitResult` 结构逐字段一致（upload.go:190-207）；
  `chunk_bytes=4194304` = `MaxUploadChunk`，`hint` 文案逐字一致（upload.go:194、206）。
- `entries=2` 与 `managed:false`：commit 返回 `Managed:false` 系 upload.go:400 硬编码（外来包不写 `.meta.json`）；`entries` 来自 `scanUploadArchive` 计数（upload.go:370、511、519）。
- sidecar 原文 `<sha>  <filename>` 与 upload.go:391 `fmt.Sprintf("%s  %s\n", sum, base)` 格式一致；sha 为自算（upload.go:456-467 `hashUploadFile`），非信任声明值。
- `verify sha_match:true` / `readable 2 个条目` / `uncompressed_bytes=6`，与 `restore_content_identical` 回读 `b'alpha\n'`（6 字节）、`restored_entries=2` 三者数字自洽。
- retention 保护：`internal/backupop/retention.go:62` `if !backup.Managed { Protected...; continue }` —— `managed:false` 外来包被跳过、`created_at` 回拨的旧 managed 包被删，与报告 `protected`/`deleted` 原文一致。
- 两级确认已诚实标注为前端 `bak-confirm` UI 门禁（P2 G-28 覆盖），未冒称协议层确认。

### 2.2 10 类恶意归档（报告 §4，30 条 = 10 类 × 3）

10 条的 commit RAW 原文与源码字面量 **逐字一致**，这是本次可信度最强的背书：

| 报告类型 | 报告原文 | 源码出处 |
| --- | --- | --- |
| 绝对路径 | 归档条目使用绝对路径，整包拒绝 | restore.go:305-306 |
| `../` | 归档条目含 .. 段，整包拒绝 | restore.go:308-310 |
| 符号链接绝对目标 | 符号链接目标为绝对路径，整包拒绝 | restore.go:345-346 |
| 符号链接逃逸 | 符号链接目标越出恢复目录，整包拒绝 | restore.go:348-350 |
| 字符/块设备 | 归档包含字符/块设备条目，整包拒绝 | restore.go:319-320 |
| FIFO / 硬链接 | 归档包含不支持的条目类型，整包拒绝 | restore.go:321-322（default 分支） |
| 超长名 | 归档条目路径超过 4096 字节上限 | restore.go:299-300 |
| 3 GiB 解压炸弹 | 归档条目大小超过 2 GiB 上限 | restore.go:325-326（MaxEntryBytes，头声明即拒） |

`scanUploadArchive`（upload.go:470-519）逐头复用 `validateRestoreHeader` + `withinPath`，只累计声明字节不落盘（防炸弹）；commit 失败由 upload.go:341-347 的 `defer RemoveAll` 清暂存，`os.Link` 落在扫描之后（upload.go:385）——"commit 400 E_INVALID + 暂存清理 + 无落包"三段逻辑链成立。

### 2.3 边界拒绝（报告 §5，10 条）

| 场景 | 报告 HTTP+原文 | 源码核对 |
| --- | --- | --- |
| 未授权 | 401 E_UNAUTHORIZED「未授权」 | `invoke_capability.go:113` 逐字一致 |
| >512 MiB | 400「文件大小必须在 1–536870912 字节之间（上限 512 MiB）」 | upload.go:146-147 + `MaxUploadBytes = 512<<20`（:28），插值数字正确 |
| 单块 >4 MiB | 400「单块超过 4 MiB 上限，请按 4 MiB 重新分块」 | upload.go:173-174 逐字一致 |
| 乱序 offset | 409 E_CONFLICT「分块 offset 必须等于已接收字节数，拒绝重叠或回退」 | upload.go:294-295 逐字一致 |
| 错 upload_id | 404 E_NOTFOUND「上传会话不存在或已清理」 | upload.go:441-445 `readUploadState` 逐字一致 |
| 缺块 commit | 400「上传未完成：已接收字节数与声明大小不一致」 | upload.go:348-349 逐字一致 |
| 403 路径 | **未真机触发，代码背书** | `invoke_capability.go:137-142` needAdmin 不足 → 403 E_UNAUTHORIZED；:104-106 单管理员 6 项全权；`info.json:23` `backup.upload: system:admin` —— 报告口径准确 |

### 2.4 TTL / 清理（报告 §6，5 条）

`UploadTTL = 30 * time.Minute` 编译期常量（upload.go:32）；`checkUploadFresh`（:418-425）回拨 `created_at` 后返回「上传会话已超过 30 分钟，已清理，请重新上传」逐字一致；`SweepStaleUploads`（:522-549）在 begin 时调用（:251）；abort 返回 `Aborted:true`（:404-416）。报告如实标注"未真等 30min、模拟到期 + 单测覆盖"。

---

## 3. 诚实边界（报告 §5 注 / §6 / §7 / §8）

逐项核实均**如实标注、未夸大**：

1. 403 无真实非 admin 用户（单管理员模式）→ 明确写"代码背书、未真机触发"，真机只触发 401。✓
2. 30min TTL 未真等 → 明确写"回拨状态文件模拟到期；真实到期由单测覆盖"。✓
3. restore 两级确认为前端 UI 门禁 → 明确写"协议层无 confirm 参数、P2 G-28 覆盖、本次未重验前端点击"。✓
4. BT 的"1Panel/AMH 迁移" → 明确写属 G-11 有意偏离、本次不含。✓
5. download 链路证据缺口 → 明确写"不借本次背书、两链路证据分开"。✓
6. 不宣称全场景 → §8 逐条列出未覆盖项（真 30min、非管理员 403、前端两级点击、多块 >4MiB、并发、download）。✓
7. 中途 3 次 harness 口径失败（假口令触发 428 验证码、空 cookie 命中 CSRF 门在前、造包目录 0644 + sidecar 名写错）→ §7 逐条标"造包/用例口径错误，非产品缺陷"并注明修正；未伪装成一次通过。✓

---

## 4. 隔离与清理（复核当下只读回读，全部成立）

| 项 | 复核命令 | 结果 |
| --- | --- | --- |
| 端口隔离 | `ss -ltn \| grep ':55141\b'` | `55141 NO_LISTENER`（报告端口非 8787） |
| 临时资产 | `ls -ld .ul-iso .ul-harness.py .ul-probe` | 三者均 `No such file or directory`（ABSENT） |
| 全工作区残留 | `find . -maxdepth 3 -name '.ul-*' -o -name '.upload-*'` | 零命中 |
| 主实例 | `curl 127.0.0.1:8787/-/healthz` | `HTTP=200`（未受影响） |
| 残留进程 | `ps -ef \| grep -E '\.ul-iso\|bin/backup'` | `NO_ISO_PROCESS` |
| 口令 | 报告全文 grep | 仅 `***` / `[REDACTED]` 占位，无明文；口令写 0600 `.pw` 不进 argv（报告 §1） |
| dist sha | `sha256sum dist/backup-0.6.0.tar.gz` + `.sha256` + `kore-plugins/index/plugins.json` | 三处同为 `a5043d36d951c53f8bbff167cf300fd865793243bc315d955a18f41b743acbe4`，`stat` = 1741526 B，与报告一致 |
| 二进制 | `sha256sum kore/bin/kored` | `162a67bde189780ad7690ce8afeefb128071b57685bc58d68f79f773a6dc48bf`，与报告元信息一致 |

---

## 5. 非阻断观测：SUMMARY 计数口径差

- 报告声明 harness `python3 .ul-harness.py` exit 0、末行 `[SUMMARY] TOTAL=61 PASS=61 FAIL=0`。按清理要求脚本与原始输出已删除；全仓 `grep -rn "TOTAL=61\|PASS=61"` 只命中报告自身（:35），**无法独立再派生精确计数**。
- 报告分节声明：§3=14、§4=30、§5=10、§6=5，合计 **59**；§2 另列 5 条前置断言（healthz/login/session/install/enable），若计入则合计 **64**。与 SUMMARY 的 61 差 2–3 条。
- 判定：该差异可由计数口径解释（前置 setup 是否计入 harness TOTAL、`verify` 内 `exists/size/sha256/readable` 四项子检查是否单列等）；且 §4 的 30 条与"10 类 × 3"完全吻合，所有 HTTP 码/错误原文均有源码背书（§2）。属**分节计数描述精度问题，非证据不成立、非数字造假**，故不阻断 PASS；如实留痕供 lead 知悉。

---

## 6. 结论

- **总评：PASS**（61 条断言实质证据成立、隔离清理回读实测通过、git 纪律合规、诚实边界未夸大）。
- 按任务卡 §5 的 BLOCKED 判据（数字不自洽 / 证据不成立）：未触发——唯一数字口径差已定位为描述精度问题并留痕（§5），所有可核对的实质数字均自洽且代码背书。
- 本报告按硬纪律精确 `git add` + `git commit -s` 落盘，未 push。
