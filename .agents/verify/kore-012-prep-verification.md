# kore 0.1.2 发版准备独立验收（G-09 / task-235）

> 复核对象：`f6372ac`（bump 主提交）→ `3375309`（本报告首版）→ **`6c15fa5`（补修 3 份文档现值声明，HEAD=main）**
> 复核人：`kore-012-verifier`（独立 verifier，非 `kore-012-prep`）
> 时间：2026-11-27 22:20–22:45 +08:00（首轮 + 补修后复验，复验见 §7）
> 纪律：只读复跑；不 push / 不联网 / 不执行主流程 CLI / 不碰 `.kore-local-*` / 不碰运行实例。
> 唯一写入 = 本报告（精确 `git add` + `commit -s`）。

## 0. 总评：**PASS（放行打 tag；建议 peeled commit = `6c15fa5`）**

| 项 | 结论 |
| --- | --- |
| ① bump 正确性 | **PASS**（首轮的 1 项阻断已由 `6c15fa5` 补修并独立复验，见 §1.3 / §7） |
| ② CHANGELOG 诚实性 | PASS |
| ③ dist 校验 | PASS（含 2 项如实披露） |
| ④ 门禁复跑 | PASS（全部 exit 0） |
| ⑤ git 完整性 | PASS |

首轮唯一阻断项（3 份活文档仍把 0.1.1 写成当前/MVP 版本）已由原 owner 按 lead 裁决补修：`6c15fa5` 精确改 `docs/REPOS.md:131` / `docs/VISION.md:13` / `docs/ARCHITECTURE.md:13` 为 0.1.2，并保留「0.1.1 = 首个含 file_write / file_delete」历史断言；本 verifier 已独立重跑 grep、全部门禁与 git 检查，证据见 §7。**结论由 BLOCKED 翻转为 PASS，打 tag 关口放行。**

---

## 1. ① bump 正确性

### 1.1 点名的三处改动：正确

| 位置 | 改动前 | 改动后（实测） |
| --- | --- | --- |
| `Makefile:29` | `VERSION   ?= 0.1.1` | `VERSION   ?= 0.1.2` |
| `cmd/kored/main.go:17` | `var version = "0.1.1"` | `var version = "0.1.2"` |
| `docs/CORE.md:13` | `版本基线 | MVP 0.1.1（…）` | `版本基线 | 当前 MVP 版本 0.1.2（首个含 file_write 受控写的内核版本是 0.1.1；Makefile 的 VERSION 是唯一真源）；…` |

`CORE.md:13` 的改法把「当前版本」与「历史基线」拆开写，语义正确，未抹掉 0.1.1 的历史断言。

### 1.2 全仓 grep 结论（`grep -rn '0\.1\.[12]'`，共 133 命中）

- **应保留的 0.1.1 历史断言全部保留**：`Makefile:27-28`、`cmd/kored/main.go:16`、`CHANGELOG.md` 的 `[0.1.1]` 历史段与 `:24`、各语言 `DETAIL*.md:5`（首个发布版本 0.1.1）、`REPOS.md:133-136`、`ARCHITECTURE/VISION` 的「0.1.1 = 首个含 file_write」括注、ADR/verify 记录。✓
- **README.md 无显式版本号**（`grep -nE '0\.1\.[0-9]|v0\.1\.' README.md` 零命中）——未造版本。✓
- **测试夹具 / 历史发布记录里的 0.1.1、0.1.2**：`cmd/kored/*_test.go`、`internal/core/{httpapi,market}/*_test.go`、`docs/PLUGIN-SDK.md`、`docs/MILESTONE-M1.md`、`docs/PLUGIN-PROTOCOL.md`（SDK v0.1.2/v0.1.3）、`.agents/verify/*` 等均为他人历史/测试语境，保留正确。✓

### 1.3 首轮阻断项（3 处「当前版本」漏 bump）——已由 `6c15fa5` 补修

| 文件:行 | 首轮原文（节选，修复前） | 修复后实测（`6c15fa5`） |
| --- | --- | --- |
| `docs/REPOS.md:131` | `**当前内核版本 = \`0.1.1\`**` | `**当前内核版本 = \`0.1.2\`**`；同段「0.1.1 是首个含 file_write / file_delete 的内核版本」从句原样保留 |
| `docs/VISION.md:13` | `版本基线 | MVP 0.1.1（…）` | `版本基线 | 当前 MVP 0.1.2（…；0.1.1 = 首个含 file_write…）` |
| `docs/ARCHITECTURE.md:13` | `版本基线 | MVP 0.1.1（…）` | `版本基线 | 当前 MVP 0.1.2（…；0.1.1 = 首个含 file_write…）` |

**判据是项目自己的先例**：`git show --name-only --format="" f8eb0cb`（上次 0.1.0→0.1.1 bump）改动 7 个文件：
`CHANGELOG.md`、`Makefile`、`cmd/kored/main.go`、`docs/ARCHITECTURE.md`、`docs/CORE.md`、`docs/REPOS.md`、`docs/VISION.md`——即三份文档当时都随版本声明同步更新。`f6372ac` 只动了其中 `CORE.md`，留下三处 0.1.1 与 0.1.2 并存；`6c15fa5` 已补齐同批三份，与先例一致。现值模式在全仓源码/活文档零残留（复验命令与输出见 §7.1）。

---

## 2. ② CHANGELOG 诚实性：PASS

`CHANGELOG.md` 顶部新增 `## [0.1.2] - 2026-11-27`，五项要求逐条核对：

| 要求 | 实测 |
| --- | --- |
| feat 按 semver 应 minor 0.2.0 | `:8` 明文「本次是 **feat**，按 semver 应为 **minor 0.2.0**」 |
| 24 仓 requires_kore 上界 <0.2.0 | `:9` 写「48/48 行零例外」。实测 24 仓 `info.json` + `manifest.json` 共 48 行：46×`>=0.1.0 <0.2.0` + 2×`>=0.1.1 <0.2.0`，48/48 上界均 `<0.2.0` ✓ |
| version-check 阻断 / E_UNSUPPORTED | `:9-10` 明文写出阻断后果 |
| 生态兼容折中 patch 0.1.2、不隐瞒张力 | `:10-11`「经生态兼容折中，**以 patch 0.1.2 发布**」「兼容性约束压过 semver 的例外，不是'本次没有新功能'」✓ |
| allowed_cidrs 向后兼容旧 token 不限制 | `:15-16`「缺省 / 为空时行为与旧 token 完全一致——**向后兼容，旧 token 不限制来源**」；与 `docs/CORE.md`「空/缺省 = 不限制」一致 ✓ |
| 新增 PUT /security/tokens/{id}、端点 72→73 | `:17-19` 明文；实测 `internal/core/httpapi/handlers.go:120` 已注册 `s.mux.HandleFunc("PUT "+tokenItemPath, s.handleTokenUpdate)`，实现在 `handlers_security.go:285`；`docs/CORE.md:64/:411` 端点总数 73（66 业务 + 7 store）✓ |

历史 `[0.1.1]` 段未改写，无「把新增当成没有功能」的粉饰。

---

## 3. ③ dist 校验：PASS（含如实披露）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 字节数 | `stat -c%s dist/kore-0.1.2.tar.gz` | `5126401`（= 5,126,401 B）✓ |
| sha256 | `sha256sum dist/kore-0.1.2.tar.gz` | `ac6496e6e2a06e084a5e35e1a50f0c63299f33fbc06810631fdb12ffc09d6a6a` ✓ |
| sha 文件自检 | `cd dist && sha256sum -c kore-0.1.2.tar.gz.sha256` | `kore-0.1.2.tar.gz: OK`，rc=0 |
| 包内容 | `tar -tzf` | `kore-0.1.2/{checksums.txt,kored}`（瘦包，符合发布资产口径） |
| 包内自检 | 解包后 `cd … && sha256sum -c checksums.txt` | `kored: OK`，rc=0（`162a67bd…48bf  kored`） |
| 二进制版本 | `<tmp>/kore-0.1.2/kored version` | `kored 0.1.2` / `协议 kore.plugin.v1`，rc=0 |
| 临时资产 | `mktemp -d` 解包，`rm -rf` 后 `ls -d $TMP` | rc=0，路径不存在；无残留 |

**如实披露（两点）**：
1. kore 仓 `Makefile` **没有 `dist` target**（`grep -n '^dist\|dist:' Makefile` 仅命中 `:90 web-dist`），该 tar.gz 是按插件仓 `make dist` 口径**手工复刻**的，不是 `make dist` 产物；复刻结果经上述 sha/自检/version 四重校验为真。
2. `dist/` **未被 `.gitignore` 忽略**（`.gitignore:13` 只有 `web/dist/`），靠精确 `git add` 避免入库：实测 `git ls-files dist/ | wc -l` = **0**，`git diff -- .gitignore` 为空（未改 `.gitignore`），`git status` 中 `?? dist/` 为他人/既有未跟踪资产，本次未夹带。

---

## 4. ④ 门禁复跑（命令 + 退出码）

> 环境说明：默认 `GOCACHE=/home/pt/.cache/go-build` 与 `GOMODCACHE=/home/pt/go/pkg/mod` 为只读 FS。首次 `GOCACHE=<tmp> go test ./...` 以 `open …bbolt/@v/v1.5.0.lock: read-only file system` 失败（纯环境噪声，非代码问题，rc=1，如实记录）。最终有效执行使用**仓外已有可写缓存副本** `/home/pt/Work/GolandProjects/kore-pl/.tmp-acct-gomodcache`（仅读取复制，未改原目录）+ 单次调用内临时 `GOCACHE`，`GOPROXY=off GOWORK=off` 全程离线，**零联网**；退出码如下。

| 门禁 | 命令 | 退出码 | 关键结果 |
| --- | --- | --- | --- |
| version-check | `make version-check` | **0** | `内核 VERSION=0.1.2 覆盖 24 个插件，全部落在 requires_kore 区间内`；site 标 `← file_write ← file_delete` |
| docs-check | `make docs-check` | **0** | `docs-check: 5 pass, 1 warn, 0 fail`（WARN = 11 份文档行数越界，非本次引入、不阻断） |
| secret-check | `make secret-check` | **0** | `secret-check: 0 FAIL / 24 处匹配（占位写法均合规）` |
| go test | `GOCACHE=<tmp> GOMODCACHE=<隔离副本> GOWORK=off GOPROXY=off go test -timeout 200s ./...` | **0** | 17 包全 `ok`（`cmd/kored` 9.409s、`httpapi` 6.730s、`supervisor` 8.913s…），`web` 无测试文件 |
| make check | `GOCACHE=<tmp> GOMODCACHE=<隔离副本> GOWORK=off GOPROXY=off make check` | **0** | 末段 `[RUN ] 21/21 嵌套 module pkg/pluginapi 全量 -race`（2 包、零 DATA RACE），末尾 `[OK] 门禁全部通过` |

**usability WARN 未夹带**：`make check` 第 20 段的 `scripts/usability-check.sh` 为 WARN 级（脚本单跑 `usability-check: 0 pass, 502 warn, 1 fail, 190 unverified`；Makefile 段内 `[WARN] usability-check 有 2 处新违规 … WARN 级不阻断`）。WARN 内容涉及 `scripts/usability-pending.txt` 的存量豁免与「清单条目已不再违规，请移除」（runtime-node / runtime-php / runtime-python / ssh-guard），该文件在 `git status` 中是**他人 `M` dirty**，本次只读读取、未改、未提交，也未带入本报告结论之外。

**临时资产**：`mktemp` 的 GOCACHE/GOMODCACHE 副本在调用结束时 `rm -rf` 曾打印大量 `权限不够`（Go 模块目录/文件只读位，属用户提示的 Go 只读模块 rm 告警）；但下一次独立 shell 检查 `/tmp/kore012*` → `(none)`，工作区 `git status` 与开工前逐行一致，**零残留**。

---

## 5. ⑤ git 完整性：PASS

| 检查 | 命令 / 证据 | 结果 |
| --- | --- | --- |
| 精确 4 文件 | `git show --name-status --format="" f6372ac` | `M CHANGELOG.md` / `M Makefile` / `M cmd/kored/main.go` / `M docs/CORE.md`，无第五文件 |
| 补修精确 3 文件 | `git show --stat --format=fuller 6c15fa5` / `--name-status` | `M docs/ARCHITECTURE.md` / `M docs/REPOS.md` / `M docs/VISION.md`，3 insertions / 3 deletions，无第四文件 |
| DCO | `git log -1 --format=%B f6372ac` / `git log -1 --format=%B 6c15fa5` | 两者均含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ✓ |
| 未 push | `git branch -vv` | `main 6c15fa5 [origin/main: 领先 8]`——8 个提交未推（含 f6372ac / 3375309 / 6c15fa5），无 tag/release ✓ |
| worktree | `git worktree list` | 仅 `/home/pt/Work/GolandProjects/kore-pl/kore 6c15fa5 [main]` 主树 ✓ |
| 他人 dirty 原样 | 开工前/门禁后 `git status --short` 逐行对比 | 完全一致：`M scripts/usability-pending.txt` + 12 项既有 untracked（`.agents/.agents/`、`e2e-*.md`、`local-update-plan.md`、`release-batch-*.md`、`run-user-model.md`、截图、`data/`、`dist/`）；本次未改其中任何一个 |
| .gitignore 未入库 | `git diff -- .gitignore` / `git ls-files dist/` | diff 空 / 0 文件 ✓ |
| 未碰运行实例 / `.kore-local-*` | 命令清单 | 全部为读、shell 门禁与临时解包；无 serve/install/restart、无 `.kore-local-*` 读写 ✓ |

---

## 6. 结论

- ①/②/③/④/⑤ **全部通过**，证据与退出码如上及 §7。
- 首轮唯一阻断项已由 `6c15fa5` 按 lead 裁决补修，并经本 verifier 独立复验（§7）：三处现值声明为 0.1.2、历史断言保留、全仓现值模式零残留、全门禁 exit 0、dist 与 git 状态未受影响。
- **总评 PASS：放行打 `v0.1.2` tag。** 建议 tag 指向的 peeled commit 为 **`6c15fa5`**（HEAD=main）；本报告未 push、未打 tag、未建 Release，由 lead / 实施者按既定口径执行。

---

## 7. 补修后独立复验（`6c15fa5`，2026-11-27 22:37–22:45）

### 7.1 三处现值 + 全仓 grep

- `sed -n '131p' docs/REPOS.md` → `**当前内核版本 = \`0.1.2\`**`；同段下一句「0.1.1 是首个含 file_write／file_delete 的内核版本」保留。
- `sed -n '13p' docs/VISION.md` / `docs/ARCHITECTURE.md` → 均为 `版本基线 | 当前 MVP 0.1.2（…；0.1.1 = 首个含 file_write 受控写的内核版本…）`。
- 现值模式 `当前(内核)?版本…0.1.1|版本基线…0.1.1|MVP 0.1.1|VERSION ?= 0.1.1|var version = "0.1.1"|内核版本 = \`0.1.1\`` 全仓（排除 node_modules）：源码/活文档**零命中**；仅命中本报告对修复前值的引用、以及 `CHANGELOG.md:24` 的历史沿革注（「0.1.1 仍是首个含 file_write…」），均非现值声明。✓
- 保留的历史断言复核：`REPOS.md:131-136`、`Makefile:27-28/423-479`、`main.go:16`、`CHANGELOG.md` `[0.1.1]` 段与 `:24`、DETAIL 七语言「首个发布版本 0.1.1」、SDK v0.1.1 事故记录、ADR/verify/测试夹具，均未改。✓
- `git diff --check f6372ac..HEAD` → exit **0**。

### 7.2 门禁复跑（命令 + 退出码）

| 门禁 | 命令 | 退出码 |
| --- | --- | --- |
| docs-check | `make docs-check` | **0**（5 pass / 1 warn 行数越界 / 0 fail） |
| version-check | `make version-check` | **0**（0.1.2 覆盖 24 仓全 OK） |
| secret-check | `make secret-check` | **0**（0 FAIL / 24 合规占位） |
| go test | `GOCACHE=<tmp> GOMODCACHE=<仓外隔离副本> GOWORK=off GOPROXY=off go test -timeout 200s ./...` | **0**（17 包全 ok） |
| make check | 同一隔离环境下 `make check` | **0**（21 段全过） |

> 仍为离线（`GOPROXY=off`），复用仓外已有可写缓存副本，未联网；临时缓存退出后 `/tmp/kore012*` 为空，工作区无残留。

### 7.3 dist 与 git 状态

- `stat -c%s dist/kore-0.1.2.tar.gz` = **5126401**；`sha256sum` = `ac6496e6e2a06e084a5e35e1a50f0c63299f33fbc06810631fdb12ffc09d6a6a`；`cd dist && sha256sum -c kore-0.1.2.tar.gz.sha256` → `OK`，rc=0。纯文档补修未影响发布物，原 sha 仍有效。
- `git ls-files dist/ | wc -l` = **0**；`git diff -- .gitignore` 为空。
- `git log -1 --oneline` = `6c15fa5`；`git branch -vv` = `main 6c15fa5 [origin/main: 领先 8]`（未 push / 未 tag / 未建 Release）；`git worktree list` 仅主树。
- `git status --short` 与首轮逐行一致（`M scripts/usability-pending.txt` + 12 项既有 untracked），他人 dirty 原样未夹带。
