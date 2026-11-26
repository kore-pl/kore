# 完整期最终验收报告 — 干净树 HEAD ad04917 `make check` 21 段

- 验收员：full-phase-gate（独立 verifier，非任何实现者）
- 时间：2026-11-26（Asia/Shanghai）
- 任务：task-88（先 claim，revision 1→2，owner=full-phase-gate）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根在此）
- 写范围：仅本报告 `.agents/verify/full-phase-final-gate.md`；精确 `git add` + `commit -s [agent:full-phase-gate]`；未 push、未改代码/依赖版本、无 force/reset/rebase、未碰 `.kore-local-*`；联网仅限 go proxy 下载依赖。

## 结论（先行）— 总评 FAIL

干净树 HEAD `ad04917` 上 `make check` **rc=2（未全绿）**：**3/21 薄壳边界（thin-shell-check）为阻断级 FAIL**，其余 20 段 PASS/SKIP（WARN 级明细不阻断）。核心回归 `go test -count=1 ./cmd/kored/... ./internal/core/...` **rc=0（16 包全 ok）**。git 纪律三项全 PASS（HEAD/status/远端/worktree 未变，关键 commit 均祖先）。

**唯一阻断 FAIL 是 HEAD 代码问题，不是工作区污染**：M7 接线 commit `960821c`（及更早 `83a42ae`）把 `backup.*` 配置解析写进内核可执行代码，而 `scripts/thin-shell-check.sh` 的精确豁免表（脚本 106–132 行）未覆盖这些文件，导致业务域词 `backup` 词首命中。证据：①隔离树来自纯 `git archive HEAD`，无工作区 dirty；②主工作区同脚本单跑同样 rc=1、同样 `[FAIL]`；③被点名文件与 HEAD blob 逐字节一致；④引入 commit 均为 HEAD 祖先。**在修复前不得对外宣称完整期 make check 全绿。**

---

## 一、隔离干净树构造（参照 task-66 教训）

```
WS=/home/pt/Work/GolandProjects/kore-pl
ISO=$WS/.v                         # 短路径，规避 UDS sun_path >107 字节（task-66 首轮教训）
# 1) kore 代码：git archive HEAD（无 .git、无工作区 dirty）
git -C $WS/kore archive ad04917 | tar -x -C $ISO/kore
# 2) 25 兄弟仓（kore-plugins + 24 插件）各取提交态 HEAD，排除 dirty
for d in kore-plugins kore-plugin-*; do git -C $WS/$d archive HEAD | tar -x -C $ISO/$d; done
# 3) 隔离 Go 缓存（工作区内可写，用完删）；先 goproxy.cn 下载，后 GOPROXY=off
export GOPATH=$ISO/gopath GOMODCACHE=$ISO/gomodcache GOCACHE=$ISO/gocache
export GOPROXY=https://goproxy.cn,direct GOWORK=off GOSUMDB=sum.golang.org   # 下载阶段
export KORE_PLUGINS_DIR=$ISO/kore-plugins
export USABILITY_PENDING_FILE=$ISO/kore/scripts/usability-pending.txt
# 4) 复跑门禁
export GOPROXY=off GOSUMDB=off
cd $ISO/kore && make check
```

- kore 归档 HEAD：`ad049176decdfb44aab3e2556dd2f0f0e25da1eb`
- kore-plugins 快照 HEAD：`92aa146e45f12207c6e96fba122d6dee5431944c`；24 插件仓全 `git archive HEAD`（各仓 SHA 见隔离 log，已随隔离目录删除）
- 隔离树 `scripts/usability-pending.txt` 与 `git show HEAD:scripts/usability-pending.txt` **逐字节一致**（`cmp` 通过）；使用 HEAD 版本，未被工作区 dirty 版掩盖
- 依赖：默认 modcache 缺 bbolt v1.5.0.zip / x/sys v0.45.0.zip，按用户已授权的 `https://goproxy.cn,direct` 下载进隔离 `$ISO/gomodcache`（隔离 GOPATH 使 sumdb 可写；仅 go proxy 联网，无其它网络写）；`go mod download all` 覆盖根 module + 嵌套 pluginapi + 24 插件仓，随后 `GOPROXY=off` 下根/pluginapi/24 插件 `go build ./...` 全过
- 隔离树无 `web/dist`（git archive 不含 ignore 产物），由 Makefile `web-dist` 目标本地拷贝源生成（无 npm/无网络），与常规前置一致
- UDS socket 长度：`.v/kore` 路径下自更新 socket 约 96 字节 < 107，未复现 task-66 的路径长度假性失败

## 二、干净树 `make check`（rc=2）

- 命令（隔离树内，GOPROXY=off）：`make check > $ISO/log/make-check.out 2>&1; echo $?` → **2**
- START 2026-11-26 14:24:37 +0800 / END 2026-11-26 14:28:40 +0800
- 末两行：`[FAIL] 门禁未通过 — 见上方明细` / `make: *** [Makefile:513：check] 错误 1`

### 21 段逐段结果

| 段 | 项 | 结果（末行/汇总） | 判定 |
|---|---|---|---|
| 1/21 | docs-check | `docs-check: 5 pass, 1 warn, 0 fail` | PASS（WARN 不阻断） |
| 2/21 | 依赖白名单 + 兼容基线 | `dep-check: 2 pass, 0 fail`；`[OK] 兼容基线通过（构建参数已钉死）`；第三方 2/3（bbolt+yaml） | PASS |
| **3/21** | **薄壳边界** | **`[FAIL] 可执行代码出现业务域词（词首匹配）`；`thin-shell-check: 3 pass, 1 fail`（扫描 202 个可执行 .go）** | **FAIL（阻断）** |
| 4/21 | repo-check | `repo-check: 5 pass, 0 fail` | PASS |
| 5/21 | canonical-check | `canonical-check: 14 pass, 0 warn, 0 fail` | PASS |
| 6/21 | log-check | `log-check: 8 pass, 0 warn` | PASS（WARN 级） |
| 7/21 | wt-check | `wt-check: 4 pass, 0 warn` | PASS（WARN 级） |
| 8/21 | oss-check | `oss-check: 8 pass, 0 warn, 0 fail` | PASS |
| 9/21 | case-check | `case-check: 27 pass, 1 warn, 0 fail` | PASS（WARN 不阻断） |
| 10/21 | frontend 首屏体积 | `[OK] 首屏体积达标：88511 字节 ≤ 307200 字节`；`[WARN] 首屏体积漂移 > 基线+5%`（趋势，不阻断） | PASS |
| 11/21 | 零侵入门禁 | `结果: 门禁通过（零侵入：安装目录外零新增；豁免项仅作说明）` | PASS |
| 12/21 | secret-check | `secret-check: 0 FAIL / 19 处匹配（占位写法均合规）` | PASS |
| 13/21 | 插件仓开源资产 | `汇总: 25 pass / 0 warn / 0 fail` | PASS |
| 14/21 | store-check | `store-check: 24 pass, 0 fail, 37 warn` | PASS（WARN 级） |
| 15/21 | presets-check | `presets-check: 8 pass, 0 warn, 0 fail` | PASS |
| 16/21 | 公钥单一真源 | `[OK] 两端公钥一致：3e461a07…` | PASS |
| 16 段·market | 索引→市场页派生一致 | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` | PASS |
| 17/21 | 交叉编译（五目标真编译） | `[OK] 全仓交叉编译五目标全通过（exit 0，耗时 18116ms）` | PASS |
| 18/21 | race 门禁（跨仓边界） | `[OK] race 门禁通过（接线完整 + -race 真跑全绿）`（15 仓边界真跑） | PASS |
| 19/21 | 全仓 -race | `[OK] 全仓 -race 通过（17 个包，59s，零 DATA RACE）` | PASS |
| 20/21 | usability-check（WARN 级） | `usability-check: 0 pass, 519 warn, 56 fail, 183 unverified`；`[WARN] usability-check 有 57 处新违规（WARN 级不阻断）` | WARN（不阻断；HEAD 存量违规未掩盖） |
| 21/21 | 嵌套 module pkg/pluginapi -race | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，2s，零 DATA RACE）` | PASS |
| **末行** | — | **`[FAIL] 门禁未通过 — 见上方明细`** | **FAIL** |

## 三、FAIL 段定性与根因（3/21 薄壳边界）

`make check` 输出中该段明细（前 10 条）：

```
[FAIL] 可执行代码出现业务域词（词首匹配）
       ./cmd/kored/serve_boot.go:98:  backup := cfg.snapshot.Backup
       ./cmd/kored/serve_boot.go:108: KeepCount:      backup.KeepCount,
       ./cmd/kored/serve_boot.go:109: MaxDiskBytes:   backup.MaxDiskBytes,
       ./cmd/kored/upgrade.go:140:    return fmt.Errorf("内核生效清理：加载 backup 配置失败: %w", err)
       ./internal/core/config/parse.go:11:  topKeys = []string{..., "backup", ...}
       ./internal/core/config/parse.go:16:  backupKeys = []string{"keep_count", "max_disk_bytes"}
       ./internal/core/config/parse.go:83:  {"backup", func(n *yaml.Node) error { return p.decodeBackup(n, &snap.Backup) }},
       ./internal/core/config/parse_nested.go:135: func (p *parser) decodeBackup(n *yaml.Node, out *Backup) error {
       ./internal/core/config/parse_nested.go:136: m, err := p.mapping(n, "backup", backupKeys)
       ./internal/core/config/parse_nested.go:141: if out.KeepCount, err = p.integer(v, "backup.keep_count"); err != nil {
```

判据（`scripts/thin-shell-check.sh` 第 3 项）：业务域词 `backup|site|monitor|cron|ssl|database|mysql|nginx|docker` 词首匹配必须零命中。脚本已有精确豁免表（`credential_format.go` / `handlers_disk.go` / `webhook*.go` / `siteimport_*` / `restart` 四文件 / `filewrite/` 包），但**未包含上面这批 `backup.*` 配置文件**；fail-closed 设计下命中即 FAIL。

为何判定为 **HEAD 代码问题**（逐条排除工作区污染）：
1. 隔离树来自 `git archive HEAD`，不含任何工作区 dirty；失败在纯提交态复现。
2. 主工作区只读复跑 `bash scripts/thin-shell-check.sh` → rc=1、同样 `[FAIL]`（`thin-shell-check: 3 pass, 1 fail`），与隔离一致。
3. 脚本 `scripts/thin-shell-check.sh` 及被点名 4 个文件 `git diff --quiet HEAD` 均为 0（与 HEAD blob 逐字节一致）。
4. `git log`：`serve_boot.go` 由 `960821c`（M7 接线，HEAD 祖先）引入，`parse_nested.go`/backup 配置源于 `83a42ae`（M7 备份配置，HEAD 祖先）。关键 commit 祖先检查全 OK（见下）。
5. 环境差异（隔离路径/GOPROXY/兄弟仓快照）只可能影响路径类或依赖类检查；本段是纯静态源码 grep，与上述环境无关。

修复方向（供实现方，本 verifier 不改代码）：在 `scripts/thin-shell-check.sh` 精确豁免表补上这批已合入 `backup.*` 配置文件（比照 `filewrite/` Backup 先例，且须走 G-01 红线复核/ADR 留痕），或将 `backup.*` 配置解析改成通用命名并同步文档；改完须重跑全期 `make check` 至 exit 0，方可宣称完整期全绿。

## 四、核心回归 `go test -count=1`（rc=0）

隔离树内（GOPROXY=off，web/dist 已由 make web-dist 生成）：

```
go test -count=1 ./cmd/kored/... ./internal/core/...
rc=0
ok  github.com/pengtang1024/kore/cmd/kored           9.536s
ok  .../internal/core/auth 1.166s  bus 1.089s  config 0.012s  credential 0.005s
ok  .../internal/core/envprobe 0.002s  filewrite 0.086s  httpapi 4.796s  installer 0.048s
ok  .../internal/core/market 0.012s  metrics 0.203s  privilege 2.517s  registry 0.007s
ok  .../internal/core/scheduler 1.058s  store 1.132s  supervisor 8.822s
```

16 包全 ok（命令与退出码见 `$ISO/log/core-regression.out/.rc`，随隔离目录删除后本报告为留存证据）。

## 五、git 纪律复核（验收标准③）

| 项 | 基线 | 最终 | 判定 |
|---|---|---|---|
| HEAD | `ad049176decdfb44aab3e2556dd2f0f0e25da1eb` | 同 | ✅ 未变 |
| git status 哈希 | `0499b1ef…d24a77` | `0499b1ef…d24a77` | ✅ 仅原有他人 dirty（` M scripts/usability-pending.txt` + 8 个 `?? .agents/verify/*` + screenshots + `?? data/` + `?? dist/`；外加本报告提交） |
| worktree list | 仅主树 `kore ad04917 [main]` | 同 | ✅ 仅主树（G-25） |
| `git branch --list 'wt-*' 'tmp-*'` | 空 | 空 | ✅ |
| refs/remotes origin/gitea/gitee/github main | `f27955a…` / `812f9fc…` / `f27955a…` / `f27955a…` | 全同 | ✅ 未 push |

关键 commit 祖先检查（`git merge-base --is-ancestor <c> HEAD`）：`82ffb69`、`f9c979e`、`960821c`、`cae416b`、`dccecd7`、`cdcf3cf`、`ad04917` **全部 ANCESTOR OK**。

所有验证在 `$ISO`（工作区内隔离目录）进行；未对主工作区代码/配置做任何写入；唯一写操作为本报告文件。隔离目录 `.v` 用完已删除。

## 六、交付判定

- 验收标准①（干净树 make check exit 0 + 末行 `[OK] 门禁全部通过`）：**FAIL**（rc=2，3/21 薄壳边界阻断，HEAD 代码问题）
- 验收标准②（核心回归 exit 0）：**PASS**
- 验收标准③（HEAD/status/远端/worktree 未变、关键 commit 祖先）：**PASS**
- **总评：FAIL** — 完整期门禁存在真实阻塞（段3），修复并复跑全绿前不得宣称完整期通过。
