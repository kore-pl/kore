> 状态: accepted · 归属: gate-fix-verifier · 更新: 2026-11-28 · 里程碑: R43
> 任务: task-300 · 性质: 独立验收（G-09，非 gate-fix / 非 implementer）

# 干净 clone 门禁修复独立复核（task-300，commit 80c08bd）

## 0. 总评

**PASS**。独立复跑坐实了 implementer 报告的全部核心断言：三脚本修复未放松真实安全判据，三个 self-test 全绿（5/3/6），同一父树「修前三处 FAIL → 修后单跑全 exit 0」，干净 `file://` clone（短路径 `/tmp/kgc`、仓外缓存、`GOWORK=off GOPROXY=off`）`make check` **exit 0 / `[OK] 门禁全部通过`**（阻断段全绿），深路径 11 段启动失败为 UDS `sun_path` 上限伪影（复算 + 实测双重证实），脏树 `make check` exit 0 无回归，git 边界（精确 4 文件 + DCO + 未 push + 他人 dirty 原样 + 临时资产清理）全部合规。

## 1. git 边界（⑥）

```
HEAD = 80c08bd633fb6dccd2da2e1f8a86c2ecf848ea28
main...origin/main = 3 0        # 领先 3、未 push
git show --stat 80c08bd → 精确 4 文件：
  .agents/verify/clean-clone-gate-fix.md | 89 +
  scripts/docs-check.sh                  | 60 ++++--
  scripts/pubkey-sync-check.sh           | 88 ++++++++-----
  scripts/secret-check.sh                | 76 ++++++++---
提交信息：[agent:gate-fix] fix(scripts): 修复干净 clone 三门禁缺陷（...）
DCO: Signed-off-by: pengtang1024 <pengtang1024@qq.com>  ✓
git worktree list → 仅主工作树 1 行；wt-*/tmp-* 分支 0 个
```

他人 dirty 基线（验收前后逐字 diff 一致，无回归、无夹带）：`M scripts/usability-pending.txt` + 11 项 `??`（`.agents/.agents/`、`.agents/verify/{e2e-*,local-update-plan,release-batch-*,release-inject-verify,run-user-model}.md`、screenshots/adp-debug-desktop-01.png、`data/`、`dist/`）。

临时资产：`.verify-gate-fix/` 不存在；`.zero-intrusion-tmp.*` 残留 0；`/tmp/kgc*` 残留 0；`.git/info/exclude` 未新增 `verify-gate-fix` 行（implementer 原报告声称"已排除"与实况不符——实际是目录已清、根本无需排除；不构成缺陷，如实记录）。

## 2. 三脚本修复读码核对（①，逐条 file:line）

### 2.1 docs-check.sh — 跨仓相对链接 SKIP，本仓内仍硬判
- `scripts/docs-check.sh:15-24` 新增 `cross_repo_link()`：`realpath -m --relative-to="$ROOT"` 解析后，仅当 rel 命中 `../kore-plugins|../kore-plugins/*|../kore-plugin-*` 才 return 0。这是"跳出本仓且首段为兄弟仓名"的窄口径，不受 clone 目录名影响。
- `scripts/docs-check.sh:209-217`：只在该链接 `[ ! -e ]`（目标确实缺失）且 `cross_repo_link` 成立时才计 `LINK_SKIPPED`；否则（含本仓内断链）仍走 `detail "断链"` + `LINK_BROKEN++`。
- `scripts/docs-check.sh:221-225`：FAIL 条件仍是 `LINK_BROKEN > 0`，SKIP 不掺入。
- 对抗分类复核（复刻 15-24 判据）：`docs/DECISIONS → ../../../kore-plugin-dns/README.md` = SKIP(0)；`docs → ../kore-plugin-fake/README.md`、`docs → kore-plugin-notes.md`、`docs/DECISIONS → ../../kore-plugin-dns/README.md`、`docs → ../../outside/kore-plugin-x/README.md` 全 = HARD(1)。**自造仓库内同名目录/文件均不误豁免，安全判据未放松。**

### 2.2 pubkey-sync-check.sh — 缺 validate-index.sh SKIP，公钥不一致仍 FAIL
- `scripts/pubkey-sync-check.sh:30-37` 将检查收进 `run_check()`；`:34-37` 仅在 `[ ! -f "$VALIDATE" ]` 时回 `[SKIP] ... return 0`。`VERIFY` 缺失仍 `:31 fail`（未放宽）。
- `:40-51`：文件存在时逐字抽 `IndexPublicKeyHex`（64 位 hex）与 `PUB_HEX`，任一端缺失 fail，`:46-50` 两端不等仍 `exit 1` + 打印双端公钥。**核心一致性判据原样保留。**
- 注：`:16-17` 把 `VERIFY`/`VALIDATE` 改为 `${VAR:-默认}` 以支持 self-test 注入夹具——这是必要的可测性改动，默认值不变（`KORE_PLUGINS_DIR` 仍默认 `$ROOT/../kore-plugins`）。

### 2.3 secret-check.sh — grep 正则模式 WARN，真实赋值仍 FAIL
- `scripts/secret-check.sh:96-105` 新增 `is_pattern_context()`：必须同一行含 `grep` **且** `-E`/`-nE`/`-En`，**且** captured value 含正则元字符（`| \ [ ] ( ) <…> + ? …`）才 return 0。
- `:127-136`：`is_allowed`（占位）优先；随后 `is_pattern_context` 命中才 WARN + continue；真实赋值落入 `:135-136 FAIL++`。判定主链顺序未变。
- 对抗探针（目录参数，8 例）：`ADMIN_PASSWORD=<placeholder>`、`grep -nE 'ADMIN_PASSWORD=<placeholder>' file.md`（纯值无元字符）、`some grep here ADMIN_PASSWORD=abc|def`（无 -E）、`grep -nE "ADMIN_PASSWORD=<placeholder>"`、`"password": "<placeholder>"`、`admin_password: <placeholder>` **全部 rc=1 FAIL**；仅 `grep -nE 'ADMIN_PASSWORD=pa|ss'`、`grep -E ADMIN_PASSWORD=abc[def` 两类真模式 rc=0 WARN。**探针字面量已脱敏；豁免不泛化，真实凭据零漏放。**

## 3. self-test 独立复跑（②）

```
bash scripts/docs-check.sh --self-test        → rc=0，docs-check self-test: 5 pass, 0 fail
bash scripts/pubkey-sync-check.sh --self-test → rc=0，pubkey-sync-check self-test: 3 pass, 0 fail
bash scripts/secret-check.sh --self-test      → rc=0，secret-check self-test: 6 pass, 0 fail
bash -n scripts/{docs-check,pubkey-sync-check,secret-check}.sh → rc=0
```
数量与 implementer 报告声明（5/3/6）一致，非自述照抄，为独立复跑。

### 修前 FAIL → 修后单跑 exit 0（同一父树 c685a66，本地 `git archive` 干净快照）
取 `80c08bd^` 父树导出到 `/tmp/kgc-pre`（无兄弟仓），先跑原脚本、再 `cp` 入 HEAD 三修复脚本对同一棵树复跑：

| 脚本 | 修前（原脚本） | 修后（同树 + 修复脚本） |
|---|---|---|
| docs-check | rc=1，`[FAIL] 相对链接断链 2 条`（0051 dns README、clean-clone-reproducibility 各 1），4 pass/1 warn/1 fail | rc=0，两条均 `[SKIP] 兄弟仓未检出`，5 pass/1 warn/0 fail |
| secret-check | rc=1，`[FAIL] backup-download-verification.md:125 ADMIN_PASSWORD`，1 FAIL/24 匹配 | rc=0，0 FAIL/24 匹配/1 WARN |
| pubkey-sync | rc=1，`[FAIL] 缺少 .../../kore-plugins/scripts/validate-index.sh` | rc=0，`[SKIP] 缺 validate-index.sh` |

临时快照 `/tmp/kgc-pre` 已删。

## 4. 干净 clone make check（③ 核心）

因本机 `/tmp` **不跨 bash 调用持久**，clone → make check → 清理全部写进同一次 bash 调用（避免上一轮临时 clone 丢失导致误判）：

```
git clone --no-local file:///home/pt/Work/GolandProjects/kore-pl/kore /tmp/kgc
  → rc=0，clone HEAD=80c08bd633fb6dccd2da2e1f8a86c2ecf848ea28
  → 三修复标记均在（cross_repo_link / is_pattern_context / run_check）
cd /tmp/kgc
GOCACHE=/tmp/kgc-gocache GOMODCACHE=<src>/.tmp/gomodcache \
GOWORK=off GOPROXY=off make check → RC=0，elapsed=145s，[OK] 门禁全部通过
```

21 段逐段关键证据（`[RUN ] 1/21` … `[RUN ] 21/21` 全部出现，末尾 `[OK] 门禁全部通过`）：

- **1/21 docs-check**：`docs-check: 5 pass, 1 warn, 0 fail`（兄弟仓链接 SKIP；报告声称的 5 pass 一致）。
- **2/21**：兼容基线 `[OK]`；同仓 module `replace => ./pkg/pluginapi`、第三方依赖 2/3。
- **3/21 薄壳**、**4/21 repo-check**：业务域/动作词 0 命中、插件 import/代码/索引零命中，全 `[OK]`。
- 5/6/7/8/9/10 段：canonical / log / wt / oss / case / frontend（`web/dist` 由 `make web-dist` 从受控源重建，首屏 91092 B ≤ 307200 B）全过。
- **11/21 零侵入**：隔离实例起得来、socket 落安装目录内（短路径消除深路径伪影，详见 §5）。
- **12/21 secret-check**：`0 FAIL / 24 匹配 / 1 WARN`（正则模式豁免）。
- 13/14/15 段：无兄弟仓 → `[SKIP]`（预期，非 FAIL）。
- **16/21 pubkey**：`[SKIP] 缺 validate-index.sh`；16 段·market `[SKIP] 未检出 kore-plugins`；均 exit 0 不阻断。
- **17/21 交叉编译（阻断级）**：`[OK] 全仓五目标可编译`、`[OK] 交叉产物: linux-amd64 · linux-arm64 · windows-amd64.exe · darwin-arm64 · darwin-amd64`、`[OK] 全仓交叉编译五目标全通过（exit 0，17759ms）`——**真编译非文本核对**。
- 18/21：本仓无 tests/boundary → SKIP；跨仓接线 `[OK]`，无兄弟仓由插件仓 CI 兜底。
- **19/21 全仓 -race（阻断级）**：`[OK] 全仓 -race 通过（17 个包，65s，零 DATA RACE）`——**17 包真跑绿**。
- 20/21 usability：`[FAIL] 未找到任何 ../kore-plugin-*/info.json`（缺兄弟仓，WARN 级不阻断）；Makefile 将其降级为 `[WARN]`。
- **21/21 pkg/pluginapi -race（阻断级）**：`[OK] pkg/pluginapi 全量 -race 通过（2 个包，2s，零 DATA RACE）`——**2 包真跑绿**。
- 清理：`rm -rf /tmp/kgc /tmp/kgc-gocache` exit 0，残留 0。

**诚实声明**：20 段含一条 `[FAIL]` 文本（缺兄弟仓的 usability 探测），属 WARN 级、Makefile 判为不阻断，故 `make check` 整体 exit 0 且 `[OK] 门禁全部通过` 成立；"21 段全绿"应理解为**所有阻断段全绿 + 该 WARN 不阻断**，不存在把 FAIL 伪装成 PASS。

## 5. 深路径伪影归因（④）

`scripts/zero-intrusion-check.sh:18,77` 的隔离安装根为 `$ROOT/.zero-intrusion-tmp.XXXXXX`，socket 为 `<TMP>/run/kore.sock`。复算深路径 clone（`.verify-gate-fix/clean-clone2/…`）的 socket 路径长度：

```
深路径 socket = /home/pt/Work/GolandProjects/kore-pl/kore/.verify-gate-fix/clean-clone2/.zero-intrusion-tmp.XXXXXX/run/kore.sock
              = 112 字节  > Linux AF_UNIX sun_path 上限 107 字节（第 108 字节为 NUL）
短路径 socket = /tmp/kgc/.zero-intrusion-tmp.XXXXXX/run/kore.sock = 49 字节 < 107
```

实测验证 `sun_path` 硬上限（python AF_UNIX bind）：`pathlen=100 → OK`、`107 → OK`、`108 → FAIL: AF_UNIX path too long`、`112 → FAIL`。深路径 112 字节必然 `bind: invalid argument`，隔离 kored 起不来 → 11 段 `[FAIL] 隔离实例未在 10s 内就绪`；换短路径 `/tmp/kgc` 后 11/21 PASS（§4 干净 clone 已实测）。

**归因结论**：属**验证路径伪影**，非产品代码缺陷——它只在"clone 被放进超长工作区路径再跑零侵入隔离实例"时触发，生产安装 `/run/kore` 或正常短路径不存在该约束；短路径全绿与长路径失败可由 `sun_path=107` 完全解释，因果关系闭合。

## 6. 脏树 make check（⑤）

在 main 工作区（他人 dirty 原样，见 §1）用同一仓外缓存口径复跑：

```
GOCACHE=/tmp/kgc-dirty-gocache GOMODCACHE=<src>/.tmp/gomodcache \
GOWORK=off GOPROXY=off make check → RC=0，elapsed=411s，[OK] 门禁全部通过
  1/21 docs-check: 5 pass, 1 warn, 0 fail
  11/21 零侵入: 结果: 门禁通过（安装目录外零新增）
  12/21 secret: 0 FAIL / 28 匹配 / 1 WARN
  17/21 交叉编译: [OK] 全仓交叉编译五目标全通过（17363ms）
  18/21: 15 个兄弟插件仓 make race 真跑（app-deploy/backup/cron/db-mysql/discover/echo/file/firewall/logs/monitor/process/redis/runtime-php/site/ssl/terminal）
  19/21: [OK] 全仓 -race 通过（17 包，58s，零 DATA RACE）
  21/21: [OK] pkg/pluginapi 全量 -race 通过（2 包，2s，零 DATA RACE）
  20/21: [WARN] usability 2 处存量违规（waf ZeroParam 真跑 FAIL 等，WARN 级不阻断，非本次引入）
  他人 dirty 基线前后逐字 diff = 无变化；临时缓存已删
```

## 7. 结论与诚实边界

- 未 push / 未联网业务 / 未启主流程 CLI / 未碰 `.kore-local-*` 或 8787；全程只读复跑 + 本报告唯一写域。
- 三个 self-test 的临时夹具均由脚本 `trap rm -rf` 自清；我的 `git archive` 快照与 `/tmp` 探针全部删除。
- 干净 clone 是本地 `file://`，兄弟仓缺失的 SKIP/WARN 属独立 clone 设计预期，非门禁放松。
- **总评：PASS**（六项复核 ①–⑥ 全部成立；"21 段全绿"以 §4 的阻断段全绿 + 20 段 WARN 不阻断口径为准，无夸大）。
