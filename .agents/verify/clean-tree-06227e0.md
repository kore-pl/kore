# 干净树独立验收报告 — HEAD 06227e0 `make check` 全绿

- 验收员：clean-tree-verifier（独立 verifier，非 merge-deps / 非实现者）
- 时间：2026-11-26（Asia/Shanghai）
- 任务：task-66（先 claim，revision 1→2，owner=clean-tree-verifier）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl`（kore git 根在其下 `kore/`）
- 写范围：仅本报告 `.agents/verify/clean-tree-06227e0.md`；精确 `git add` + `commit -s`；未 push、未改代码/依赖版本、无 force/reset/rebase、未碰 `.kore-local-*`。

## 结论（先行）

**HEAD 06227e0 代码质量本身全绿**：隔离干净树上 `make check` **exit 0**，末行 `[OK] 门禁全部通过`；21 段逐段结果全部为 PASS/SKIP（WARN 级段内明细不阻断）。核心回归 `go test -count=1 ./internal/core/store/... ./cmd/kored/... ./internal/core/...` **exit 0**（16 包全 ok）。

工作区原先 `make check` exit 2 的两个残留 FAIL（段15 presets、段20 usability）确认为**工作区并发污染**，与 HEAD 无关：
1. 段15：kore-plugins 索引被 index-sync 的 `echo 0.1.7` commit（11:14:32，恰在 make check 运行期）改动 → 干净快照（索引提交态 c5bd36b）下 presets-check `8 pass, 0 warn, 0 fail`、market 段逐字节一致全绿。
2. 段20：`scripts/usability-pending.txt` 是他人 dirty 存量台账 → 干净树天然用 HEAD 版本（已逐字节核对 `git show HEAD:...` 一致），段20 报 56 处 FAIL 但为 **WARN 级**，不阻断 `make check`（Makefile §第20段：`usability_fail -> [WARN]`，不置 `fail`）。**这些 FAIL 是 HEAD 自身插件/视图的历史存量违规（A3 文案/A4 术语），未被掩盖也未被工作区 dirty 干扰**——用 HEAD 版清单如实呈现，符合任务「不掩盖 HEAD 自身违规」的要求；它们不影响阻断级全绿。

另记录一个**隔离环境自身的假性失败**（非 HEAD 问题、非工作区污染）：首次隔离目录路径过深（`/.tmp-ct-verify/kore/...`），零侵入段的自更新 UDS 路径长达 **108 字节**，超过 Linux `sun_path` 107 字节上限，`bind: invalid argument` → 段11 FAIL、`make check` exit 2。换短路径（`.v/kore`，同 socket 96 字节）后段11 PASS、`make check` exit 0。详见「首次运行诊断」。

---

## 一、隔离干净树的构造（可复现）

```bash
WS=/home/pt/Work/GolandProjects/kore-pl
ISO=$WS/.v                       # 短路径，避免 UDS 长度问题
# 1) kore 代码：git archive HEAD（无 .git、无工作区 dirty）
git -C $WS/kore archive 06227e0 | tar -x -C $ISO/kore
# 2) 25 个兄弟仓（kore-plugins + 24 插件）全部取各仓提交态 HEAD（git archive HEAD），排除 dirty
for name in kore-plugins kore-plugin-*; do
  git -C $WS/$name archive HEAD | tar -x -C $ISO/$name
done
# 3) 隔离 Go 缓存（工作区内、可写、用完删）
export GOMODCACHE=$ISO/gomodcache GOCACHE=$ISO/gocache
export GOPROXY=https://goproxy.cn,direct GOWORK=off
# 4) 指向干净快照，排除 index-sync 并发污染
export KORE_PLUGINS_DIR=$ISO/kore-plugins
export USABILITY_PENDING_FILE=$ISO/kore/scripts/usability-pending.txt  # = HEAD 版（天然）
```

- kore 归档 HEAD：`06227e0f43ef8318d1bd8f9e3c30b1382819bdc2`
- kore-plugins 快照 HEAD：`c5bd36be2ec1fcf58322285b754d97cb369a5c53`（含 echo 0.1.7 索引提交态）
- 24 插件仓全部 `git archive HEAD`，各仓 HEAD SHA 见 `$ISO/log/sibling-heads.txt`
- 隔离树 `usability-pending.txt` 与 `git show HEAD:scripts/usability-pending.txt` **逐字节一致**（`cmp` 通过）；与工作区 dirty 版本不同——dirty 版本把 A1 app-deploy/container/cron/db-mysql/... 等 20+ 条移出清单干净树保留 HEAD 登记。
- bbolt 1.5.0 / x/sys 0.45.0 等依赖：默认 GOMODCACHE 缺 1.5.0.zip、x/sys 0.45.0.zip，按用户已授权的 `https://goproxy.cn,direct` 下载进隔离 `$ISO/gomodcache`（仅 go proxy 联网，无其它网络写）。
- 隔离树无 `web/dist`（git archive 不含被 ignore 的产物），由 Makefile `web-dist` 目标本地拷贝源生成（无 npm/无网络），与 `make check` 常规前置一致。

## 二、干净树 `make check`（最终结果：exit 0）

命令（在 `$ISO/kore` 下，带上述环境变量）：

```bash
make check > $ISO/log/make-check.out 2>&1; echo $?   # 输出 0
```

- `START 2026-11-26 11:31:03 +0800` / `END 2026-11-26 11:34:16 +0800`
- `rc=0`（`$ISO/log/make-check.rc`）；末行：**`[OK] 门禁全部通过`**

### 21 段逐段结果（贴末行 [OK]）

| 段 | 项 | 结果（末行） |
|---|---|---|
| 1/21 | docs-check | `结果: 门禁通过（1 WARN 不阻断）`（5 pass, 1 warn, 0 fail） |
| 2/21 | 依赖白名单 + 兼容基线 | `[OK] 兼容基线通过（构建参数已钉死）`；`dep-check: 2 pass, 0 fail`（第三方 2/3：bbolt+yaml） |
| 3/21 | 薄壳边界 | `[OK] 薄壳边界通过`（4 pass, 0 fail，扫描 198 个 .go） |
| 4/21 | repo-check | `repo-check: 5 pass, 0 fail` |
| 5/21 | canonical-check | `canonical-check: 14 pass, 0 warn, 0 fail` |
| 6/21 | log-check | `log-check: 8 pass, 0 warn`（WARN 级） |
| 7/21 | wt-check | `wt-check: 4 pass, 0 warn`（WARN 级） |
| 8/21 | oss-check | `结果: 门禁通过`（8 pass, 0 warn, 0 fail） |
| 9/21 | case-check | `结果: 门禁通过（1 WARN 不阻断）`（27 pass, 1 warn, 0 fail） |
| 10/21 | frontend 首屏体积 | `[OK]`（gzip ≤300 KiB，dist 无 map/.vite/字体） |
| 11/21 | 零侵入门禁 | `结果: 门禁通过（零侵入：安装目录外零新增）`（17 pass, 2 info, 0 fail） |
| 12/21 | secret-check | `secret-check: 0 FAIL / 19 处匹配（占位写法均合规）` |
| 13/21 | 插件仓开源资产 | `[OK]`（25 仓九件套 + .github 模板 + CI） |
| 14/21 | store-check | `store-check: 24 pass, 0 fail, 37 warn`（WARN 级） |
| 15/21 | presets-check | `presets-check: 8 pass, 0 warn, 0 fail`（含判据① go test 真跑；索引↔仓库 depth_level 一致） |
| 16/21 | 公钥单一真源 | `[OK] 两端公钥一致`（3e461a07…） |
| 16 段·market | 索引→市场页派生一致 | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` |
| 17/21 | 交叉编译（五目标真编译） | `[OK] 全仓交叉编译五目标全通过（exit 0，耗时 2994ms）` |
| 18/21 | race 门禁（跨仓边界） | `[OK] race 门禁通过（接线完整 + -race 真跑全绿）`（16 仓边界真跑） |
| 19/21 | 全仓 -race | `[OK] 全仓 -race 通过（17 个包，61s，零 DATA RACE）` |
| 20/21 | usability-check（WARN 级） | `usability-check: 0 pass, 519 warn, 56 fail, 183 unverified`； `[WARN] usability-check 有 57 处新违规（WARN 级不阻断）` —— 不置 `fail` |
| 21/21 | 嵌套 module pkg/pluginapi -race | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，2s，零 DATA RACE）` |
| **末行** | — | **`[OK] 门禁全部通过`** |

### 段20 的 FAIL 说明（不掩盖、不阻断）

干净树段20 的 56 条 `[FAIL]` 全部来自 HEAD 自身插件源码/前端（A3 invalid 文案长度/关键字、A4 用户可见字符串含「实例」等），例如：
- `[FAIL] A4 web/search.js: 第 939 行用户可见字符串含「实例」: 没有配置数据库实例，这个来源暂时没有内容。`
- `[FAIL] A3 db-postgres: internal/pgop/sqlguard.go 文案不合格（<8字或缺请/应/需/例/如）: sql 不得为空（超出登记条数 37，新增违规）`

这些是 HEAD 存量违规，用 HEAD 版 `usability-pending.txt` 如实呈现（未用工作区 dirty 版清单掩盖）；但 Makefile 第20段明确为 **WARN 级**（`usability_fail -> [WARN]` 不置 `fail`），故不构成本次门禁阻断。这与任务描述一致：「不掩盖 HEAD 自身违规也不被工作区 dirty 干扰」——本报告如实列出其存在，同时判定其按现行门禁口径不阻断全绿。

## 三、核心回归 `go test -count=1`（exit 0）

在 `$ISO/kore` 下（先经 `make web-dist` 生成 `web/dist/`，与常规前置一致）：

```bash
go test -count=1 ./internal/core/store/... ./cmd/kored/... ./internal/core/...
# rc=0
```

输出（16 包全 ok）：

```
ok  github.com/pengtang1024/kore/internal/core/store      1.176s
ok  github.com/pengtang1024/kore/cmd/kored                 9.011s
ok  github.com/pengtang1024/kore/internal/core/auth        1.168s
ok  github.com/pengtang1024/kore/internal/core/bus         1.091s
ok  github.com/pengtang1024/kore/internal/core/config      0.007s
ok  github.com/pengtang1024/kore/internal/core/credential  0.005s
ok  github.com/pengtang1024/kore/internal/core/envprobe    0.003s
ok  github.com/pengtang1024/kore/internal/core/filewrite   0.087s
ok  github.com/pengtang1024/kore/internal/core/httpapi     4.888s
ok  github.com/pengtang1024/kore/internal/core/installer   0.058s
ok  github.com/pengtang1024/kore/internal/core/market      0.013s
ok  github.com/pengtang1024/kore/internal/core/metrics     0.205s
ok  github.com/pengtang1024/kore/internal/core/privilege   2.520s
ok  github.com/pengtang1024/kore/internal/core/registry    0.008s
ok  github.com/pengtang1024/kore/internal/core/scheduler   1.060s
ok  github.com/pengtang1024/kore/internal/core/supervisor  8.860s
```

注：首次尝试在该命令前未生成 `web/dist` 时，3 个包因 `web/embed.go` 的 `//go:embed dist/alert-rules.js: no matching files found` setup failed（rc=1）——这是干净树缺 web 产物的已知前置条件（Makefile 已注明），补跑 `make web-dist` 后 rc=0；非 HEAD 代码缺陷。

## 四、首次运行诊断（隔离路径长度假性失败，非 HEAD 问题）

首次隔离目录用 `$WS/.tmp-ct-verify`（路径较深），`make check` exit 2，唯一阻断 FAIL 在段11：

```
[FAIL] 隔离实例未在 10s 内就绪（socket=.../.tmp-ct-verify/kore/.zero-intrusion-tmp.CZ7IYN/run/kore.sock）
serve.log: {"level":"ERROR","msg":"HTTP 监听失败","err":"监听专用更新 socket .../.zero-intrusion-tmp.CZ7IYN/run/kore-selfupdate.sock: bind: invalid argument"}
```

根因：该 `kore-selfupdate.sock` 路径长 **108 字节**，超过 Linux `sun_path` 107 字节上限（实测 `${#path}=108`；工作区原路径仅 93 字节）。这是隔离工具选择的目录深度造成，非 HEAD 代码问题、非工作区污染。改用短路径 `.v/kore`（同 socket 96 字节）后段11 PASS、整体 exit 0。已如实记录，不伪装为一次成功。

## 五、工作区未被改动确认（验收标准③）

验收前后对比（均一致）：

| 项 | 基线 | 最终 | 判定 |
|---|---|---|---|
| HEAD | `06227e0f43ef8318d1bd8f9e3c30b1382819bdc2` | 同 | ✅ 未变 |
| git status | ` M scripts/usability-pending.txt` + 8 个 `?? .agents/verify/*.md` + `?? .agents/verify/screenshots/...` + `?? data/` + `?? dist/` | 同（外加本报告提交） | ✅ 仅原有他人 dirty |
| git worktree list | 仅主树 `kore 06227e0 [main]` | 同 | ✅ 仅主树 |
| refs/remotes/origin/main | `cd6bc9df5381d6f9c4596ff7a8c36109ae52c7e7` | 同 | ✅ 未 push |
| refs/remotes/gitea/main | `812f9fcb6673d5737962566ecc9ee02fb4f1ed4b` | 同 | ✅ |
| refs/remotes/github/main | `f96f00f5d858640033e7618d759636500161c75b` | 同 | ✅ |
| refs/remotes/gitee/main | `cd6bc9df5381d6f9c4596ff7a8c36109ae52c7e7` | 同 | ✅ |

所有验证均在 `$ISO`（工作区内隔离目录）进行，未对主工作区代码/配置做任何写入；唯一写操作为本报告文件。

## 六、交付判定

- 验收标准①（干净树 `make check` exit 0 + 21 段逐段结果 + 末行 `[OK]`）：**PASS**
- 验收标准②（核心 `go test -count=1` 三包 exit 0）：**PASS**
- 验收标准③（HEAD/status/远端/worktree 未变）：**PASS**
- 判定：工作区 make check 失败源于并发污染（index-sync 索引改动 + 他人 dirty 台账），**HEAD 06227e0 代码质量本身全绿**，可作为三端推送的可信全绿证据。
