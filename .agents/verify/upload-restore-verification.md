# 上传还原 P1+P2 独立验收报告（G-09 / task-243）

> 角色：独立 verifier `upload-restore-verifier`（非 upload-restore-impl，G-09 角色不兼任）。
> 工作目录：`/home/pt/Work/GolandProjects/kore-pl`；只读复核，未改任何生产代码。
> 复核对象：backup `5c22eba`（v0.6.0）/ kore `2915d80` / plugins `e66b893`。
> 真机端到端留 P3，本报告不声称真机通过。

## 0. 总评：**PASS（带发版前置条件）**

初验（backup 5c22eba）判 FAIL，唯一阻断为 §3.3 的 usability 新增 10 条 A3 FAIL；原 owner 以 backup `a1d2bfc` 修复后，本 verifier 用同款严格受控对照独立复验，**阻断解除**（详见 §8）。其余 5 项原 PASS 结论不受影响。

| 项 | 范围 | 结论 |
|---|---|---|
| ① 后端读码+复跑 | 四阶段 / 4 MiB / S1–S9 / 版本 / dist / 5 包+11 恶意单测 / e2e | **PASS** |
| ② EINVAL 修复正当性 | 干净 HEAD 复现 / 最小改动 / CHANGELOG / 未改 restore | **PASS** |
| ③ 前端 | 1 按钮复用 / node --check / 首屏预算 / usability 无新增 FAIL | **修复后 PASS**（初验 FAIL 10 条，a1d2bfc 后受控对照回 0 FAIL；§3.3+§8） |
| ④ 分支拓扑 | backup FF 0/0 / plugins 存量分叉如实标 / 实现落 main | **PASS** |
| ⑤ G-28 四图 | read_image 实读 / identify 宽高 / 内容真实 / mock 边界 | **PASS** |
| ⑥ 索引+git 纪律 | validate/build-market/store/presets / dist sha 四处 / DCO 未 push / 临时资产 | **PASS**（sha 四处仍自洽，但见下方发版前置条件） |

**发版前置条件（非本次验收阻断，但放行 P3/发版前必须做）**：`a1d2bfc` 改变了二进制内字符串；隔离复验实测从 a1d2bfc 源码重打 `make dist` 得到 **新 sha `a5043d36d951c53f8bbff167cf300fd865793243bc315d955a18f41b743acbe4`（1741526 B）**，而当前 committed dist 与 kore-plugins 索引/账本仍为 `26519393…b49b74e`（对应修复前 5c22eba 源码，含旧短文案）。即**当前归档尚未包含 usability 修复**。须由 lead 按 G-17「同 id@version 只允许一个 sha，改 dist sha 必须 bump」裁决：重打 dist + 同步 index/plugins.json / versions.lock.json / presets / market，或按口径 bump 版本后再打。lead 已明确本轮 `dist 重打` 属放行后续动作，故本卡判 PASS。

---

## 1. 基线事实（命令 + 退出码）

```
git -C kore-plugin-backup rev-parse HEAD  → 5c22eba17262225066d2f1237be2c27c5c68b2e9  (main)
git -C kore rev-parse HEAD                 → 2915d809ce6f897848660bdc073952cad19d7015  (main)
git -C kore-plugins rev-parse HEAD         → e66b893cf28a888f4b2da53c5b1861ab83579f36  (main)
```
三 HEAD 与任务卡预期完全一致，均在 `main`。

提交范围（精确路径 + DCO）：
- backup `5c22eba`：16 文件 +1301/-9，`Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ×1
- kore `2915d80`：6 文件 +158/-1（4 PNG + selfeval + web/backups.js），DCO ×1
- plugins `e66b893`：6 文件 +12/-8，DCO ×1

## 2. ① 后端复核（PASS）

### 2.1 读码逐条（internal/backupop/upload.go，558 行）
- **四阶段**：`callUpload` switch `begin/chunk/commit/abort`（upload.go:136-185）→ `Upload` 分派（:232-243）。`uploadParams`（:42-50）**无 target_dir 字段**；全文仅注释提到「绝不接收 target_dir」，无 `Restore(` 调用（仅 call.go:36 独立 restore 动词），无新建审计出口（审计仍走内核 `capability.denied`）。
- **S1 类型**：`validateUploadFilename` 取 basename、拒路径分隔符，复用 `archiveExt` 仅 `.tar/.tar.gz`（:215-226）。
- **S2 大小**：`MaxUploadBytes=512<<20`、`MaxUploadChunk=4<<20`、`DefaultMaxBytes=2<<30`、`DefaultMaxEntries=1_000_000`；begin 校验 `≤512MiB 且 ≤2GiB`（:146）、chunk 解码后 `≤4MiB`（:169-175）、commit 累计解压字节 `≤maxBytes` 与条目数 `≤maxEntries`（:507-514）。
- **S3 会话 ID**：四阶段均 `ValidateID`（:138/158/178）。
- **S4 越界**：begin `os.Mkdir(staging,0700)` + `assertInsideBackupDir`（含 `filepath.EvalSymlinks` 双端解析，download.go:154-177）；commit `withinPath(dir,final)` 与 `filepath.Dir(final)==dir`。
- **S5 只读安全扫描**：`scanUploadArchive` 逐头复用 `validateRestoreHeader`（restore.go:294-335：拒绝对路径/`..`/NUL/反斜杠/超长 4096/字符块设备/FIFO/硬链接/单条目 2GiB）+ `validateSymlinkTarget`（:338-353：拒绝对目标与逃逸相对目标）+ `withinPath` 二次确认落点；**只累计声明字节与条目数，绝不解出条目**（防解压炸弹）。
- **S6 暂存与移入**：0700 隐藏目录 `.upload-<id>`，`os.Mkdir` create-only（EEXIST→ErrConflict）；commit `os.Link` create-only 移入、EEXIST 不覆盖（:384-389）；失败 defer `RemoveAll(staging)`（:342-347）。
- **S7 TTL**：`UploadTTL=30min`，`checkUploadFresh`（:419-426）+ `SweepStaleUploads`（:524-549）+ 插件启动调用（main.go diff +4）。
- **S8 自算校验**：`hashUploadFile` 流式自算实际字节 sha（:456-468）；sha 不符整包拒绝；**只写 `.sha256`、不写 `.meta.json`**（:391-395），`Managed:false`（:400）。
- **S9 纯入站**：无出站客户端、无新端点（对比 download 对称）。
- 版本 `0.5.3→0.6.0`（minor）+ CHANGELOG/info.json/manifest.json + info `method_capabilities["backup.upload"]="system:admin"` + methods 双清单同步（16 条方法）；capability/methods/fault/boundary/e2e 替身同步。

### 2.2 复跑（沙箱 GOCACHE 只读 → 隔离到临时目录，测试内用完即删）
```
GOPROXY=off GOWORK=off go list ./...                     → exit 0，5 个包
GOPROXY=off GOWORK=off make check                         → exit 0
  gofmt: clean / go vet ./... 0 / go test ./... 5 包全 ok
  race: go test -race ./tests/boundary/... ok (2.558s)
GOPROXY=off GOWORK=off go test -tags e2e -count=1 -timeout 200s ./tests/e2e/... -run TestUploadRestoreE2E -v
  → --- PASS: TestUploadRestoreE2E (0.46s) ; exit 0
  （真插件 UDS：上传合法包→list `managed:false`→verify `sha_match:true`→复用 restore 读回内容；恶意包 commit 被拒且暂存清理）
go test -run TestUploadRejectsMaliciousArchives -v        → exit 0，11/11 子项 PASS：
  parent-traversal / absolute-path / device-char / device-block / fifo / hardlink /
  symlink-escape / symlink-absolute / long-name / zip-bomb-header / plain-tar-traversal
```
**dist**：`sha256sum -c dist/backup-0.6.0.tar.gz.sha256` → `OK`；sha `26519393c5ee8b2b05eeb499d0fff0cb9ce8956e344170ce75315c621b49b74e`；包内 `info.json` version=0.6.0；实际 1741643 B / 声明 1741642 B（Δ=1 ≤2）；tar 内 `info.json / bin/ / bin/backup / SHA256SUMS`。

## 3. ②③ EINVAL 与前端

### 3.1 EINVAL 修复（PASS）
- 独立复现：`python3 os.chown` 探针 → `uid=1000 gid=1000; chown(0,0) errno=22 name=EINVAL; chown(1000,1000) ok; chown(12345,12345) errno=22 EINVAL`。
- 实现者干净树复现（会话 eb9baa30 seq 401/404）：`git -C kore-plugin-backup archive HEAD | tar -x` 于 `.baseline-backup-head`，`TestRestoreRejectsTraversal` 与 `TestBackupLifecycleE2E` 均失败 `E_INTERNAL: 恢复文件属主失败: chown ... invalid argument`，baseline exit=1 —— **非上传引入**。
- pre-fix 代码（917bbfb）`applyOwner` 仅 `errors.Is(err, fs.ErrPermission)`；修复仅 1 行条件改为 `|| errors.Is(err, syscall.EINVAL)` + 3 行注释，**restore.go 在 5c22eba 未改动**；CHANGELOG 0.6.0 有 `fix:` 条目。修复后全套门禁（含 restore 相关测试/e2e）exit 0。

### 3.2 前端读码/构建（PASS）
`web/backups.js` diff 仅新增页头 1 按钮 `bak-upload-btn`（默认 hidden，探测版本 ≥0.6.0 才显示；E_NOTFOUND 隐藏并提示升级）；复用 `bak-confirm` 面板（`paintUploadConfirm` 走 `paintConfirm` 分支）、`ensureProgress/setProgress` 真实分块进度、`paintResult` 的 upload 分支、`invoke`/`loadList`/`loadStats`；主流程 3 点击；新增 2 行 CSS。
```
node --check web/backups.js            → exit 0
make frontend                          → exit 0；首屏 gzip 91092 B ≤ 307200 B（300 KiB）
                                         （伴随 drift WARN：>90000，非 FAIL，如实记录）
```

### 3.3 **usability 新增 FAIL（FAIL —— 阻断项）**
实现者报告「after 11 / 干净基线 10，差 1 为 waf A1 波动、无新增 FAIL」。我用严格受控对照复核，**结论相反**：

对照方法（同一 clean HEAD pending 清单、隔离可写 GOCACHE、`--no-run-tests` 排除 A1 环境噪声；两侧目录布局完全一致——均为临时目录内 23 个兄弟仓 symlink + 1 个真解压 backup 仓）：
```
BASE = git -C kore-plugin-backup archive 917bbfb | tar -x   # pre-upload 干净树
CUR  = git -C kore-plugin-backup archive 5c22eba  | tar -x
USABILITY_PENDING_FILE=<clean HEAD> PLUGIN_REPOS_DIR=<各自> bash scripts/usability-check.sh --no-run-tests
  base → exit 0，A3 backup FAIL=0，A3 backup WARN=82
  cur  → exit 1，A3 backup FAIL=10，A3 backup WARN=82
```
10 条新增 FAIL 全文（`validate.go` 3 条 + `methods.go` 7 条，均为「超出登记条数 82，新增违规」）：
```
拒绝备份系统关键目录（/proc、/sys、/dev、/run） ×1
拒绝恢复到系统关键目录（/proc、/sys、/dev、/run） ×2
params 必须是 JSON 对象 ×2 / params 解析失败: ×1 / values 必须是 JSON 对象 ×2
备份设置非法: ×1 / 配置值非法: ×1
```
完整门禁（可写 GOCACHE，真实工作区）：`bash scripts/usability-check.sh` → exit 1，`0 pass / 502 warn / 11 fail`，11 fail = 上述 10 条 A3 backup + 1 条 `A1 waf ZeroParam`（e2e 波动，waf 未触碰）。
机制：`upload.go` 新增 10 条 A3 违规文案（如 `data_base64 不能为空`、`filename 不能为空`）本身被 `A3 backup 82` 登记为 WARN，但它们占用了 82 条豁免额度，把扫描序在后的 10 条存量违规挤出额度 → 变 FAIL。实现者对照的 BEFORE 仅归档 kore 仓（`.baseline-kore-head`），`PLUGIN_REPOS_DIR` 仍指向真实已改动的插件仓，故 BEFORE 已含这 10 条，误判为存量。

**处置结果**：原 owner 已以 backup `a1d2bfc` 改写这 10 条文案（未动门禁/pending/其它仓），本 verifier 独立复验确认回 0 FAIL（详见 §8）。

## 4. ④ 分支拓扑（PASS）
```
backup: git branch -vv → develop 5c22eba / *main 5c22eba
        main..develop = 0 ; develop..main = 0        （FF 同步完成，分叉 0/0）
kore:   develop 7bf539e / *main 2915d80 ; main..develop=0 ; develop..main=11（实现落 main）
plugins: develop 5d2b957 / *main e66b893
        main..develop = 3（5d2b957 / af559a4 / 621e249，三条 echo 索引合并存量）
        develop..main = 1（e66b893 本次实现）
```
- backup 由 develop=45b28e0（方案文档）→ `git checkout main && git merge --ff-only develop`（实现者报告 exit 0，无冲突/无 force）→ 提交后 main=develop=5c22eba。
- plugins 存量 `main..develop=3` **未 force 收敛**，实现落 main 无新分叉；实现者报告已如实标注「develop 独有 3 条为存量，需 lead 决策」——任务卡要求「如实标 lead 决策」，成立（拓扑事实与任务卡预期一致）。
- 三仓 `git worktree list` 均仅主树 1 行；本地 main 相对缓存的 origin/main 分别领先 2/1/1（未 fetch，基于 remote-tracking ref）→ 未 push。

## 5. ⑤ G-28 四图（PASS）
`file` + `identify` 实测（字节数与 2915d80 diffstat 一致）：
| 文件 | identify | 字节 |
|---|---|---|
| ui-upload-restore-desktop-01-page.png | 1440×900 | 85981 |
| ui-upload-restore-desktop-02-confirm.png | 1440×900 | 89279 |
| ui-upload-restore-mobile-01-page.png | 390×844 | 66672 |
| ui-upload-restore-mobile-02-confirm.png | 390×844 | 75185 |

`read_image` 四图逐张实读（非仅靠 identify）：桌面/手机「01-page」均可见页头「上传备份」按钮；「02-confirm」均可见「导入备份」面板 + 文件选择 + 「确认导入」，文案与 `backups.js` 源码逐字一致（非伪造、非同图缩放）。自评 `ui-upload-restore-selfeval.md` 34 行含三问原文；mock 边界诚实：隔离静态实例、真实 `KoreBackup.render()`，未碰 8787 / `.kore-local-*` / 宿主 DB；真机端到端明确留 P3。

## 6. ⑥ 索引与 git 纪律（PASS）
```
kore-plugins: bash scripts/validate-index.sh     → exit 0
  [OK] schema/必填/id 唯一/sha 格式 24 条；版本单调/同 id@version 唯一 sha；
       预设引用 47 条；market/plugins.js 逐字节一致；ed25519 全量验签通过
kore-plugins: bash scripts/build-market.sh --check → exit 0（market 逐字节一致）
kore: make market-check                           → exit 0
kore: make store-check   → exit 0（24 pass / 0 fail / 37 warn）
kore: make presets-check → 隔离可写 GOCACHE 后 exit 0（8 pass / 0 warn / 0 fail）
                           （未隔离时因共享 GOCACHE 只读 EROFS 误报 16 fail，属沙箱噪声）
```
- **dist sha 四处一致**（就 committed 产物而言）：实测 `sha256sum` = dist `.sha256` = `index/plugins.json#backup@0.6.0` = `index/versions.lock.json#backup@0.6.0` = `26519393…b49b74e`；`plugins.json` size_bytes=1741643 与实测相等；market 与 `presets/full.json`、`presets/db-only.json` 的 backup pin 均为 `0.6.0`。**注意**：该 sha 对应修复前源码；a1d2bfc 后源码已变，重打 dist 得 `a5043d36…`（§0 发版前置条件），四处需同步更新。
- 三仓 commit 精确路径（见 §1）+ DCO，未 push/tag/Release；worktree 仅主树。
- 他人 dirty 原样：kore 的 `M scripts/usability-pending.txt` 与多个 `??`（含 A1 豁免删改）未提交；kore-plugins 的 `.tmp-validate-out.txt`、`dist/` 未提交。
- 临时资产：本次 upload-restore 的基线目录、usability dump、隔离 GOCACHE（`.baseline-*` / `.usability-*` / `.gocache-upload-restore`）均已删净；工作区残留的其它 `.gocache-*`/`.tmp-*` 属其它历史任务资产（日期 11-25/26），非本任务产物，未触碰。

## 7. 纪律与诚实边界
- 全程只读复核；未改任何生产代码；唯一写入为本报告（精确 `git add` + `git commit -s`）。
- 未 push、未联网业务（Go 命令一律 `GOPROXY=off`）、未启主流程 CLI、未碰 `.kore-local-*`。
- 共享 GOCACHE 只读（EROFS）导致的 A1/presets 失败已用隔离可写缓存排除，并如实标注为环境噪声，不冒充代码问题。
- 真机端到端（合法包→restore 成功、恶意/超大/未授权被拒）属 P3，本卡**未验证、不声称通过**。
- 上方 §3.3 的 usability FAIL 为本卡独立复跑发现，证据可复现，未替实现者掩盖；经原 owner 修正后已独立复验解除（§8）。

## 8. 修复复验（backup a1d2bfc，2026-11-27）——**PASS**

原 owner 回派修复：`git -C kore-plugin-backup show --stat a1d2bfc` → `internal/backupop/upload.go | 20 ++++++++++----------`（+10/-10，仅 1 文件），`Signed-off-by` ×1；kore HEAD 仍 959b642（我的报告）、plugins HEAD 仍 e66b893（未动）；`git show HEAD:scripts/usability-pending.txt` 未变、门禁配置未动；`git -C kore-plugin-backup status --porcelain` 空。10 条文案逐条核对均已 ≥8 字且含「请/应/需/例/如」（sha256 ×2 / offset / data_base64 空 / 解码失败 / 单块超限 / phase / filename 空 / filename 路径分隔符 / 扩展名）。

### 8.1 同款严格受控对照（本 verifier 独立执行，与主报告 §3.3 同法）
两侧/三侧临时目录同布局（23 个兄弟仓 symlink + 1 个真 `git archive` 解压 backup 仓，24/24），同一 kore 脚本与 clean HEAD pending 清单，隔离可写 GOCACHE，`--no-run-tests`：
```
pre   archive 917bbfb → exit 0；A3 backup FAIL=0；0 pass/502 warn/0 fail/190 unverified
broken archive 5c22eba → exit 1；A3 backup FAIL=10；0 pass/502 warn/10 fail/191 unverified
post  archive a1d2bfc → exit 0；A3 backup FAIL=0；0 pass/502 warn/0 fail/191 unverified
```
当前真实工作区完整门禁（隔离可写 GOCACHE）：`bash scripts/usability-check.sh` → exit 1，`0 pass/502 warn/1 fail`，唯一 FAIL 为 `A1 waf ZeroParam`（waf 仓未触碰的 e2e 波动），与本次改动无关；**A3 backup FAIL 已归零**。

### 8.2 其余门禁与拓扑（复核）
```
backup gofmt -l .                                  → 空（clean）
backup GOPROXY=off GOWORK=off go test ./...         → exit 0（5 包全 ok）
backup GOPROXY=off GOWORK=off make check            → exit 0（含 boundary race 2.539s）
backup main=develop=a1d2bfc，main..develop=0 / develop..main=0（分叉 0/0，未 push）
```
① 后端逻辑未变（仅文案字符串），② EINVAL、④ 拓扑、⑤ 四图、⑥ 索引门禁结论均不受影响。

### 8.3 发版前置（见 §0）
隔离从 a1d2bfc 源码重打 `make dist` → 新 sha `a5043d36…b49b74e`、1741526 B，与当前 committed dist/index 的 `26519393…` 不同；**当前归档不含本次文案修复**。按 lead 口径，dist 重打 + 索引/账本同步（或版本 bump）属放行 P3/发版前动作，不构成本次验收阻断；交 lead 裁决具体采用同版本换 sha 还是 bump 路径。
