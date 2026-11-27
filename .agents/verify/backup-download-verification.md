# backup.download 真机验证独立验收报告（task-285 / G-09）

> 元信息：2026-11-28T07:05+08:00 · 验收者 `backup-download-verifier`（独立 verifier，非 `backup-download-live`）· 唯一写域 = 本报告。
> 受验对象：`kore@9c2728d`（报告 commit，156 行，单文件 + DCO，未 push）、报告正文 `.agents/verify/backup-download-live.md`。
> **总评：PASS**。阶段一逐条 file:line 全部属实；阶段二 37 断言数字自洽、抽算复算一致；诚实边界如实、清理回读全绿、git 元数据合规。未发现不自洽数字或不成立证据，无需报 BLOCKED。
>
> 硬纪律遵守：全程只读复核（不改生产代码、不启/停服务、不碰 `.kore-local-*`、不联网、不 push）；唯一写入为本报告；`8787` 仅做只读 GET healthz。

---

## 1. 受验报告与 commit 基线

| 项 | 命令 / 方式 | 退出码 / 关键输出 | 判定 |
| --- | --- | --- | --- |
| HEAD == 受验 commit | `git -C kore rev-parse HEAD` | `9c2728da81c7bce21b36d2dac45764c7664b0088` | ✓ |
| commit 提交信息 | `git show -s --format=%B 9c2728d` | `[agent:backup-download-live] docs(verify): backup.download 隔离真机验证 37/37 PASS …` | ✓ |
| DCO 签署 | `git show -s --format=%B 9c2728d \| grep -i signed-off-by` | `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` | ✓ |
| 精确单文件 | `git diff-tree --no-commit-id --name-status -r 9c2728d` | `A  .agents/verify/backup-download-live.md`（仅 1 行） | ✓ |
| 报告行数 == 156 | `git show 9c2728d:.agents/verify/backup-download-live.md \| wc -l` | `156` | ✓ |
| 未 push | `git rev-parse origin/main github/main gitee/main` | 三端均 `151f543`（落后本地，`9c2728d` 不在任何远端 main） | ✓ |
| `git branch -a --contains 9c2728d` | — | 仅 `* main`（本地） | ✓ |

---

## 2. 阶段一逐条 file:line 核实（全部属实）

### 2.1 backup 仓基线
`git -C kore-plugin-backup rev-parse HEAD` → `9622eafb088ba39056b51f008b2597ccbea43f03`（报告声明 `9622eaf…` ✓）；`git status --short` 空（干净）✓；`git worktree list` 仅 1 行（主树）✓。

### 2.2 download.go:60/95/22/140-148/154（读全文 186 行，逐条吻合）
- `:22` `MaxDownloadChunk int64 = 4 << 20`（=4194304）✓
- `:60` `func callDownload(...)` ✓；`:69-71` offset<0 → `invalid("offset 不能为负数")` ✓；`:78-80` `limit > MaxDownloadChunk` → `invalid("limit 必须在 1–4194304 字节之间（不传按 4 MiB）")` ✓
- `:95` `func (realFS) Download(spec DownloadSpec) (DownloadData, error)` ✓；`:104` `assertInsideBackupDir` ✓；`:117` `Inline: spec.Limit > 0` ✓；`:120` `EOF: true` ✓；`:126-128` limit==0 仅返回元信息 ✓；`:129-131` `offset > info.Size()` → `invalid("offset 超过备份包大小")` ✓
- `:140` `io.ReadAll(io.LimitReader(file, spec.Limit))` ✓；`:144-147` `next=offset+len(chunk)` / `ChunkBytes` / `NextOffset` / `EOF=next>=info.Size()` ✓；`:148` `base64.StdEncoding.EncodeToString(chunk)` ✓
- `:154` `func assertInsideBackupDir(...)` ✓（`:167-175` 符号链接 EvalSymlinks + 越界拒绝）
- 独立补核：`resolveArchive` 的 `os.Lstat` + `!IsRegular → "备份包不是常规文件"` 在 `metadata.go:105-108`；`"备份 id 含非法字符"` 在 `validate.go:53`；`"备份不存在"/E_NOTFOUND` 在 `metadata.go:116`。报告 §2.4 各边界 RAW 与代码逐字对得上 ✓

### 2.3 call.go:45-46 / :66-67
`read` 全文 178 行：`:45-46` `case "download": return callDownload(params, opts, exec)` ✓；`:66-67` `businessVerb` 白名单含 `download` ✓。

### 2.4 info.json:22 / :54
`read` 全文 62 行：`:22` `"backup.download": "system:read"` ✓；`:54` methods 数组含 `backup.download` ✓。

### 2.5 web/backups.js:696-711 / :917
`:696` `function downloadBackup(b)` ✓；`:700` `invoke('backup.download',{id,inline:true,offset})` ✓；`:701-704` 收 `data_base64` + 按 `next_offset` 递归（串行拼接，服务端不维护块序号 — 与报告诚实口径一致）✓；`:706-711` `atob` → `Uint8Array` → `Blob([bytes],{type:d.content_type||'application/gzip'})` → `<a download>` ✓；`:917` `button(ops,'下载','btn-ghost',function(){downloadBackup(b);})` ✓。
HEAD 一致性：`git hash-object web/backups.js` == `git rev-parse HEAD:web/backups.js` == `59565f3d4f95e269ba9db22cac35e16505d85d19`；`git status --short -- web/backups.js` 空 ✓

### 2.6 backup-redis-ui.md:39/40/50 未验表述
`git show HEAD:.agents/verify/backup-redis-ui.md | nl -ba | sed -n '38,52p'`：
- `:39`「下载按钮是每条备份记录的行内动作，本轮 0 份备份故不可见」✓
- `:40`「不能据此宣称『下载链路已验证可用』」✓
- `:50`「无真实备份产物：0 份备份，『下载』为行内按钮故不可见」✓

### 2.7 既有 verify 报告无声称 download 已真机验（独立全量 grep）
- `upload-restore-live.md:152`「未验证 `backup.download`，两链路证据分开」✓；`:153` 未覆盖项含 `download` ✓
- `upload-restore-live-verification.md:83`「download 链路证据缺口 → 明确写不借本次背书」✓
- `parity-evidence-r27.md:5/:50/:102`「下载未实机验证属证据缺口」✓（三处逐行核对）
- `docs/FEATURE-GAP-BACKLOG.md:58`「下载链路未实机验证属证据缺口、非功能缺口」✓
- 独立 grep `grep -rln 'backup\.download\|下载链路\|下载.*真机' .agents/verify/*.md`：命中 10 个文件；逐一核查命中行，除受验报告自身外，**无任何既有报告声称 `backup.download` 已真机验证**（其余命中为索引包下载 / 文件域上传下载 / 发布资产下载等其它链路）。缺口属实 ✓

**阶段一结论：报告 §1 的四条核实全部成立，无夸大。**

---

## 3. 阶段二 37 断言自洽复核（抽算 / 复算，全部一致）

> 声明：受验 harness 为一次性内联 Python（不落盘），我无法也不被允许重跑隔离实例；本节按「报告给出的原始数字 + 代码契约 + 可复算算式」做独立自洽核验。

### 3.1 元信息抽算（实际 SHA 复算）
| 受验声明 | 独立复算命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| `bin/kored` sha256 `5ffc2337…f62322` | `sha256sum kore/bin/kored` | `5ffc2337e958e222a8da686d1bed3d724e9dec97af4a3fc3f9b474f7e4f62322` | ✓ |
| dist `backup-0.6.0.tar.gz` sha `a5043d36…acbe4`，与索引逐字符一致 | `sha256sum kore-plugin-backup/dist/backup-0.6.0.tar.gz` + `grep -n a5043d36 kore-plugins/index/plugins.json` | dist=`a5043d36d951c53f8bbff167cf300fd865793243bc315d955a18f41b743acbe4`；index:278 同值 | ✓ |
| create sha `e4d77eb1…906ff`（64 位十六进制） | 长度校验 | 64 字符，格式合法 | ✓ |
| 源包落盘 `a.txt = alpha\n`（6 字节） | `len(b'alpha\n')` | 6 | ✓ |

### 3.2 主链分块与重组算术（Python 复算）
- `limit=64` 强制 5 块：`offsets=[0,64,128,192,256]`，`chunks=[64,64,64,64,19]`；
- `next_offset = off+chunk` → `[64,128,192,256,275]`，**逐段连续**（`nexts[i]==offs[i+1]`，i=0..3）✓
- 末块 `19 B`（275−4×64=19）✓；`sum(chunks)=275 == size_bytes=275` ✓；末块 `next_offset=275==size` → EOF=true ✓
- 重组：`atob(chunks.join(''))` 得 275 B，`tarfile.open('r:gz')` 成员 `['src','src/site','src/site/a.txt']`，`a.txt == b'alpha\n'` — 报告断言与源数据自洽 ✓
- 元信息（inline 缺省）：代码 `spec.Limit=0 → Inline=false / EOF=true / data_base64 空`，报告 `download_metadata_ok` 断言一致 ✓；`content_type=application/gzip` 对应 `download.go:181-185` 的 gzip 分支 ✓
- `verify ok/sha_match` 与 code path（`backup.verify`）契约一致 ✓

### 3.3 37 总数分解（无重复计数）
- 前置 4：`login_200 / csrf_cookie_set / install_backup_succeeded / enable_backup_ok`
- 隔离/启动 4：`port_55181_free_at_start / admin_password_set_exit0 / kored_spawned / isolated_healthz_200`
- 主链 19（报告 §2.3 明示 19 条；表内 13 行，`chunk0..4_meta` 展开为 5、`create` 行展开为 2、`verify` 行展开为 ok+sha_match 2，合计恰 19）✓
- 边界 10（报告 §2.4 明示 10 条：错误 id / `../etc` / limit 超 / offset 负 / offset 超 size / 符号链接逃逸 / 错序 / 缺块 / 8787 健康 / 端口+隔离树清理）✓
- **4 + 4 + 19 + 10 = 37**，与报告 `[SUMMARY] TOTAL=37 PASS=37 FAIL=0` 自洽 ✓（§2.1 表中 `port_free_after / iso_tree_removed / main_8787_still_healthy` 在 §2.4 已计入边界 10，不重复计数）

### 3.4 边界错误码/消息与代码映射（逐条对得上）
| 场景 | 报告 RAW | 代码出处 | 判定 |
| --- | --- | --- | --- |
| 错误 id | `E_NOTFOUND/备份不存在` | `metadata.go:116` + `call.go:106-107` | ✓ |
| `../etc` | `E_INVALID/备份 id 含非法字符` | `validate.go:53` | ✓ |
| limit 8388608 | `E_INVALID/limit 必须在 1–4194304…` | `download.go:78-80` | ✓ |
| offset −1 | `E_INVALID/offset 不能为负数` | `download.go:69-71` | ✓ |
| offset > size | `E_INVALID/offset 超过备份包大小` | `download.go:129-131` | ✓ |
| 符号链接逃逸 | `E_INVALID/备份包不是常规文件` | `metadata.go:105-108`（Lstat 非常规）+ `download.go:154/167-175`（越界保护） | ✓ |
| 错序 / 缺块 → sha 不符 | 未宣称服务端拒绝 | 与 §3.5 诚实口径一致 | ✓ |

---

## 4. 诚实边界（如实）

报告 §4 与 §2.4 尾段的口径逐条核对，均如实、无夸大：
- **无状态按 offset 读**：§2.4 尾段明写「服务端不维护会话内块序号，乱序/缺块在协议层不会被逐块拒绝；前端 `backups.js:698-704` 按 next_offset 串行拼接才保证顺序；不宣称服务端有块序号校验」——与 `download.go:95-150` 纯 `offset/limit` + `os.Open/Seek/LimitReader` 实现一致 ✓
- **单机单实例隔离非 8787**：仅 `127.0.0.1:55181` + 1 个本地 backup 0.6.0；无集群（G-11 不做）✓
- **本地下载闭环非异地/S3**：明确 S3/异地按 G-11 不做、本轮不涉及 ✓
- **无竞品同口径对照**：未下载/运行竞品，不判超越/领先 ✓
- **未覆盖项如实**：>4 MiB 实体大包（用 limit=64 强制多块）、并发、断点续传（协议无此语义）、前端两级点击（复用既有 G-28/e2e，不重验浏览器点击）、非管理员 403（单管理员模式无真机非管理员用户）✓

---

## 5. 隔离清理与运行时只读回读

| 项 | 独立复核命令 / 方式 | 结果 | 判定 |
| --- | --- | --- | --- |
| 端口 55181 无监听 | `ss -ltn \| grep ':55181'` | `NO_LISTENER_55181` | ✓ |
| 隔离树已删 | `ls -ld /tmp/kore-dl-iso-55181` | `No such file or directory`（exit=2，确已不存在） | ✓ |
| 8787 主实例健康（前后） | `curl -sS -m 5 http://127.0.0.1:8787/-/healthz` | `{"status":"ok"}` HTTP=200 | ✓ |
| 无隔离 kored 进程残留 | `ps aux \| grep '[k]ored.*kore-dl-iso'` | 仅匹配到本次检查命令自身（沙箱 shell 命令行含该字符串），无真实隔离 kored | ✓ |
| git 无临时资产 / 他人 dirty 原样 | `git status --short` | 仅既有 dirty：`M scripts/usability-pending.txt`、`?? .agents/verify/e2e-*.md`、`?? .agents/verify/*.md`、`?? .agents/.agents/`、`?? data/`、`?? dist/`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png` — 与受验报告 §3 基线一致，未新增 harness 脚本 | ✓ |
| 明文凭据（G-30） | `grep -nE 'ADMIN_PASSWORD=\|MYSQL_PWD=\|"password"\|"token"\|…' backup-download-live.md` | 仅命中 `:66/:67` 的「0600/stdin/占位」描述，无明文口令 | ✓ |
| worktree 仅主树 | `git -C kore worktree list` / `git -C kore-plugin-backup worktree list` | 各 1 行（主树） | ✓ |

---

## 6. 验收结论

| 维度 | 判定 |
| --- | --- |
| ① 阶段一 file:line 逐条属实 | PASS（download.go/call.go/info.json/backups.js/backup-redis-ui.md/既有报告全命中，无声称已验） |
| ② 37 断言数字自洽 | PASS（4+4+19+10=37；分块/偏移/重组/SHA 复算一致；边界错误码逐条对码） |
| ③ 诚实边界如实 | PASS（无状态读口径、隔离非 8787、非异地/S3、无竞品对照、未覆盖项全披露） |
| ④ 隔离清理回读 | PASS（端口/目录/进程/8787/git/凭据全绿） |
| ⑤ git 9c2728d 合规 | PASS（精确单文件 + DCO、未 push、worktree 仅主树、他人 dirty 原样） |

**总评：PASS。** 受验报告证据成立、数字自洽、诚实边界到位，无需另派缺陷修复卡。`backup.download` 本地下载闭环真机证据缺口已由该报告补齐，与 backlog §2 C3「属证据缺口非功能缺口」的定性一致。

> 能力边界声明：本验收为只读证据复核，未重跑隔离实例（G-09 verifier 不启服务）；复核结论基于代码契约、原始报告数字与独立可复算算式，不冒充二次真机执行。
