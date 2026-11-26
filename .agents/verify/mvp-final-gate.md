# 静默自更新 MVP 最终门禁独立验收（task-62）

verifier: final-gate-verifier（独立于 gate-kore / gate-site / M1-M5 implementer）
时间: 2026-11-26（Asia/Shanghai）
工作目录: /home/pt/Work/GolandProjects/kore-pl/kore（git 根，main 分支）
环境: GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.gocache-final-gate（工作区内临时目录，沙箱下默认 ~/.cache/go-build 只读；GOWORK=off）。该临时目录在报告提交后删除。

## 总评

**PASS。** `GOCACHE=<工作区内临时目录> GOWORK=off make check` exit=0，末行 `[OK] 门禁全部通过`；21/21 段无阻断级 FAIL，4 个修复段全部复核通过，核心回归 `go test ./cmd/kored/... ./internal/core/...` exit=0，G-25 仅主树，git 链完整且全部未 push（本地领先如实记录）。存在非阻断的 WARN/SKIP（见逐段表），均按门禁既有口径标注，不阻断本次通过。

## 1. make check 整条复跑（21 段逐段结果）

命令:
```
$ cd /home/pt/Work/GolandProjects/kore-pl/kore
$ GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.gocache-final-gate GOWORK=off make check
make check exit=0；末行 [OK] 门禁全部通过
```
完整输出 1011 行已落临时日志并在提交前随临时目录删除；下列为逐段汇总（pass/fail/warn 取自各段自身汇总行）。

| 段 | 名称 | 结果 | 关键证据 |
|---|---|---|---|
| 1/21 | docs-check | PASS（1 WARN 不阻断） | `docs-check: 5 pass, 1 warn, 0 fail`；WARN=docs/SECURITY.md:511 与 DETAIL.ru.md:58 行数越界 |
| 2/21 | 依赖白名单 + 兼容基线（文本层） | PASS | `dep-check: 2 pass, 0 fail`；`[OK] 兼容基线通过`；第三方 2/3（bbolt、yaml.v3） |
| 3/21 | 薄壳边界（thin-shell） | PASS | `thin-shell-check: 4 pass, 0 fail（198 个可执行 .go）`；红线 1/2/3 复核见 §2 |
| 4/21 | repo-check 跨仓边界 | PASS | `repo-check: 5 pass, 0 fail` |
| 5/21 | canonical-check 口径唯一性 | PASS | `canonical-check: 14 pass, 0 warn, 0 fail` |
| 6/21 | log-check（WARN 级） | PASS | `log-check: 8 pass, 0 warn` |
| 7/21 | wt-check（WARN 级） | PASS | `wt-check: 4 pass, 0 warn`；工作树 1、无 wt-*/tmp-* |
| 8/21 | oss-check | PASS | `oss-check: 8 pass, 0 warn, 0 fail`；工作区有 .tmp/gomodcache（541 个非 MIT 头 .go）仍绿，见 §2 |
| 9/21 | case-check | PASS（1 WARN 不阻断） | `case-check: 27 pass, 1 warn, 0 fail`；WARN=github.com/Microsoft/... URL owner 大写 |
| 10/21 | frontend 首屏体积 | PASS | 首屏 87258 B ≤ 307200 B；i18n 增量 2941 B ≤ 3072 B |
| 11/21 | 零侵入门禁 | PASS | `zero-intrusion-check: 17 pass, 2 info, 0 fail`；安装目录外零新增；kore.service/kore-* 用户为既有豁免 |
| 12/21 | secret-check | PASS | `secret-check: 0 FAIL / 23 处匹配（占位写法均合规）` |
| 13/21 | 插件仓开源资产 | PASS | `汇总: 25 pass / 0 warn / 0 fail` |
| 14/21 | store-check（WARN 级） | PASS | `store-check: 24 pass, 0 fail, 39 warn`；DIST 204 一致/0 缺件；39 warn 均为存量 drift/描述类 |
| 15/21 | presets-check（阻断级） | PASS | `presets-check: 8 pass, 0 warn, 0 fail`；判据①静态通过 15 仓 → go test PASS 15/不通过 0；见 §2 |
| 16/21 | 公钥单一真源 | PASS | 两端公钥逐字节一致（3e461a07...df1c0） |
| 16 段附 | market 索引→市场页派生 | PASS | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）`（kore-plugins 存在，未 SKIP） |
| 17/21 | 交叉编译（阻断级） | PASS | `[OK] 全仓交叉编译五目标全通过（exit 0，17376ms）`；linux×2/windows/darwin×2 |
| 18/21 | race 门禁（跨仓 boundary） | PASS | `[OK] race 门禁通过`；有边界用例 15 仓 -race 真跑全绿；kore 及 9 个无 boundary 仓 SKIP（无目标，非缺陷）；site SKIP 明细见 §2 |
| 19/21 | 全仓 -race（阻断级） | PASS | `[OK] 全仓 -race 通过（17 个包，63s，零 DATA RACE）` |
| 20/21 | usability-check（WARN 级） | PASS（58 WARN 不阻断） | 段内 `[FAIL] G-33 有新违规...` 被宿主按 WARN 级收集：`[WARN] usability-check 有 58 处新违规（WARN 级不阻断...）`；未计入 `fail` 变量，`make check` exit=0。按门禁既有口径如实披露，非阻断；详见 §4 |
| 21/21 | 嵌套 module pkg/pluginapi -race（阻断级） | PASS | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，1s，零 DATA RACE）` |

SKIP 明细（均非阻断、有明确原因）：第 18 段本仓无 tests/boundary；kore-plugin-{container,db-postgres,dns,echo,integrity,runtime-node,runtime-python,ssh-guard,waf} 无 tests/boundary/*_test.go；site 的 EROFS 单测显式 Skip（§2）。
WARN 明细（均非阻断）：第 1/9/14/20 段见上表；第 20 段 58 处为存量 usability-pending.txt 口径下的新违规（WARN 级），未改变判据。

## 2. 四个修复段重点复核

### 段 3：thin-shell（gate-kore 7ea083a）— G-01 红线仍有效
- 基线：`bash scripts/thin-shell-check.sh` 在真实树 exit=0（4 pass/0 fail，198 个可执行 .go）。
- 注入测试（隔离副本到工作区临时目录，复制 **当前 HEAD 的脚本** 后加一个非测试 .go，跑完整个临时树删除，未触碰真实源码）：
  1. `import _ "kore/plugins/firewall"` → exit=1，`[FAIL] 主壳 import 业务插件包（红线 3）` ✓ 拦住
  2. `import "plugin"; plugin.Open` → exit=1，`[FAIL] 发现同进程动态库 plugin 使用（红线 1）` ✓ 拦住
  3. 在已被豁免的 `cmd/kored/credential_format.go` 注入新业务词 `mysql` → exit=1，`[FAIL] 可执行代码出现业务域词` ✓ fail-closed 未被放宽成整文件豁免
- 结论：词表同步只放行了 7ea083a 注明的已合入特性 token（ADR-0057/R23/R22/站点迁移/ADR-0056 精确文件+精确 token），红线本身与 fail-closed 均有效。

### 段 8：oss-check（gate-kore 7ea083a）— 有 .tmp 仍绿
- 工作区现存 `.tmp/gomodcache/`（541 个 .go，样本头为 BSD 而非 MIT，即原 FAIL 根因）。
- `bash scripts/oss-check.sh` 在含 .tmp 的真实工作区 exit=0：`oss-check: 8 pass, 0 warn, 0 fail`；日志明确 `[PASS] 全部入库 *.go 头部未发现非 MIT 协议声明（已排除 gitignored 临时/运行态目录）`。
- 结论：find -prune 排除 `.tmp/.gocache-*/.verify-tmp/.kore-local-*` 等 gitignored 目录后，工作区与干净树口径一致。

### 段 15：presets-check — 全绿
- `presets-check: 8 pass, 0 warn, 0 fail`；8 个预设（db-only/dev/full/gateway/minimal/security/web-lite/web-pro）逐项 OK；常驻 RSS 8 MiB ≤ 红线 48/目标 24；depth_level 24 个插件不一致 0 条；production 15 条判据①②全满足，判据① go test 真跑 15/15 PASS。

### 段 18：race 门禁 / site EROFS Skip（gate-site f39c4bd）
- 段 18 整体 `[OK] race 门禁通过`，site 仓 `make race`（8 个边界测试文件）`ok ... kore-plugin-site/tests/boundary 8.080s` exit=0。
- 独立复跑单测：`GOCACHE=<tmp> GOWORK=off CGO_ENABLED=1 go test -race -count=1 -v -run TestBoundaryNeedRootWhenConfDirRootOwned ./tests/boundary/...` exit=0，输出明确 SKIP + 原因：`/etc 不可写但原因不是权限拒绝（probeErr=open /etc/.kore-site-probe: read-only file system）；只读挂载（EROFS）下插件按设计报 E_INTERNAL 而非 E_NEED_ROOT，此处造不出 EACCES，属环境限制而非产品缺陷，Skip`。
- 读码核对 f39c4bd diff：新增 `errors.Is(probeErr, os.ErrPermission)` 判断，仅非 EACCES 才 Skip；正常 Linux 仍真验证 NEED_ROOT；注释说明该分支另由 `TestNeedRootForConfDirDecision`（可注入 euid/属主）与 `TestNeedRootFromChannel` 覆盖，Skip 不丢覆盖。
- site 在途文件原样未动（f39c4bd 只改 `tests/boundary/needroot_test.go`；工作区仍有 MM apply.go、D+?? rollback.go、D+?? rollback_window_test.go、?? zeroparam_test.go，均为他人改动，本 verifier 未触碰）。

## 3. 核心回归（M1-M5 未退化）

```
$ GOCACHE=<tmp> GOWORK=off go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/...
exit=0；16 个包全 ok（cmd/kored 9.256s、httpapi 4.832s、supervisor 8.823s、scheduler 1.066s、market 0.017s 等）
```

## 4. G-25 / git 完整性 / 未 push

G-25：
```
$ git worktree list
/home/pt/Work/GolandProjects/kore-pl/kore 7ea083a [main]      # 仅主树
.git/worktrees 条目 0；git branch --list 'wt-*' 'tmp-*' 零命中；bash scripts/wt-check.sh exit=0（4 pass, 0 warn）
```

git 链（kore 仓，HEAD=7ea083a11ac6c9acdb74fd6444b00167ef8e9208）：
- 关键 commit 全部为 HEAD 祖先：M1 2f56c2a → M2 da2afea/36c5801 → M3 a5e4af8/19219c0 → M4 8d105bd/ee2e1de → M5 3a1169d/883a342 → 修复 4a21845 → 门禁修复 7ea083a；逐条 `git merge-base --is-ancestor` 均 YES。
- 精确 add + 签名：7ea083a 只含 `scripts/oss-check.sh`、`scripts/thin-shell-check.sh` 两文件，带 `[agent:gate-kore]` + `Signed-off-by`；M1-M5 实现/修复 commit 均带对应 `[agent:*]` 与 `Signed-off-by`。site 仓 f39c4bd 只含 `tests/boundary/needroot_test.go`，带 `[agent:gate-site]` + `Signed-off-by`。
- 未 push（基于本地缓存 remote-tracking ref，未 fetch）：kore 本地领先 origin/github/gitee main 各 26 commit、领先 gitea/main 33 commit；远端领先均 0（无分叉）。site 仓本地领先 origin/github/gitee main 各 1 commit，远端领先 0。均如实记录，**本 verifier 未执行任何 push**。
- 工作区状态（kore）：`M scripts/usability-pending.txt` 与多条 `?? .agents/verify/*`、`?? data/`、`?? dist/` 为他人既有 dirty，本 verifier 未触碰；本报告提交后仅新增 `.agents/verify/mvp-final-gate.md` 一条已跟踪文件。

## 5. 硬纪律遵守情况

只读复跑；唯一写入为本报告（精确 `git add .agents/verify/mvp-final-gate.md` + `git commit -s [agent:final-gate-verifier]`）；未 push、未联网、未执行 install/serve/upgrade、未碰 .kore-local-*；GOCACHE 与注入测试临时目录均在提交后删除；失败如实报告（第 20 段 58 WARN 已如实披露，未伪装为 0）。
