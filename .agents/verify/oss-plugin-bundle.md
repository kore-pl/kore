# 验收报告：开源资产补齐（25 仓九件套 + 13 段门禁 + CI 少触发）

> 状态: pass · 归属: verifier · 更新: 2026-11-23 · 里程碑: M5
> 对象: 25 个兄弟仓（24 个 `kore-plugin-*` + `kore-plugins`）的九件套 / CI 少触发收敛提交 + `kore` 根文档收口（task-2～task-7、task-9～task-12）。
> 角色: `oss-verifier`，与全部 implementer（`docs-scribe` / `oss-batch1..4` / `oss-index` / `signing-scribe` / `tpl-author`）不同人，满足 G-09。
> 方法: 不复用任何 implementer 自述；下列每条结论均由本报告 §7 命令原文 + 退出码复跑得到。

## 0. 结论

**VERDICT: APPROVE**（0 阻塞项）。

- `kore` 工作树 `make check` **13/13 全绿 exit 0**（连跑两次，第二次在他人在线 WIP 存在的情况下仍 exit 0）。
- `kore` 干净树（`git archive HEAD`）`make check` **exit 0**：1–12 段全过，第 13 段因 `/tmp` 下无兄弟仓按脚本设计 **`[SKIP] 无兄弟仓`**（非失败，如实记录；已用真实工作树第 13 段 `25 pass / 0 warn / 0 fail` 补证）。
- `bash scripts/plugin-oss-check.sh`：**25 pass / 0 warn / 0 fail, exit 0**。
- 签名分层方案 A 正反向全部符合预期：全量验签 exit 0；`KORE_INDEX_SKIP_SIG=1` exit 0 且打印「已跳过」；非法值 `yes` **exit 1（fail-closed）**；`/tmp` 副本改 1 字节 → 全量 exit 1、skip exit 0；删 `.sig` → skip 模式仍 **exit 1**（不存在「缺签名也放行」）。
- 26 个仓（25 兄弟仓 + 根仓）`ci.yml` 触发一致（push main + tag `v*` + PR + workflow_dispatch），Gitea 侧 **零** workflow。
- 25 仓 README 均有 `<!-- oss:begin -->` 块与 CI badge；`LICENSE` 与 `kore/LICENSE` 逐字一致；模板与渲染产物 `plugin-oss-sync.sh --check` 25/25 changed=0（无手改漂移）。
- 反向检查：25 仓**从未**提交 `RELEASE-EVIDENCE.md`；本轮 25 仓 HEAD 提交均只含九件套 / README；无 `dist`/`bin`/`web/dist` 误入库；根/插件文档已无「插件仓不配 CI」「CI 在 release 流水线签名」旧口径。

不阻塞的已知不一致与 WARN 见 §6（含 2 个历史仓的 `.agents/verify/*` 既有提交、AGENTS §3 `origin=GitHub` 旧表述、docs-check 2 份行数 WARN、字面 `grep '{{'` 的 docker 模板语法命中）。

## 1. 验收范围与方法

| 项 | 口径 |
| --- | --- |
| 范围 | `kore` 根仓 + 25 个兄弟仓（24 `kore-plugin-*` + `kore-plugins`） |
| 权威口径 | 25 仓都配 CI 但少触发；`make check` 13 段；Gitea 权威源，GitHub / gitee 镜像；签名方案 A = 发布方签发 + CI 分层验签 |
| 隔离 | 只读验证用 `git archive HEAD` 到 `/tmp/kore-verify-clean`（测完 `rm -rf`）；签名负例在 `/tmp/kore-plugins-neg` 副本做（测完删除）；未 stash / 未回滚 / 未提交任何他人改动 |
| 写入 | 仅本文件 `.agents/verify/oss-plugin-bundle.md` |

逐仓抽查覆盖 5 个批次（C1 app-deploy/backup/container/cron/db-mysql/db-postgres、C2 discover/dns/echo/file/firewall/integrity、C3 logs/monitor/process/redis/runtime-node/runtime-php、C4 runtime-python/site/ssh-guard/ssl/terminal/waf、D kore-plugins），**12 仓深查**（跨全部 5 批），其余 13 仓做全量扫描项。

工作树并发说明：16:31 首跑时 `git status` 仅未跟踪 `.agents/verify/*`；16:39 复跑时出现他人在线 WIP（`M Makefile`、`M docs/FRONTEND.md`、`M web/embed.go`、`M web/files-l2.js`、`M web/files.js`、`M web/i18n/en-US.js`、`M web/i18n/zh-CN.js`、`M web/shell.js`、`?? web/waf.js`）。按要求**未 stash、未回滚、未提交**；该状态不影响 13 段结果（两次均 exit 0）。

## 2. `kore` 仓门禁（两种树）

### 2.1 工作树（16:31 与 16:39 两次）

```text
命令: cd /home/pt/Work/GolandProjects/kore && make check
退出码: 0（两次均 0）
输出: [RUN ] 1/13 … [RUN ] 13/13 插件仓开源资产
      汇总: 25 pass / 0 warn / 0 fail
      [OK] 门禁全部通过
```

13 段逐段结果（第二次 16:39:37，含他人在线 WIP）：

| 段 | 名称 | 结果 |
| --- | --- | --- |
| 1 | docs-check | 通过（5 pass / 1 warn / 0 fail；WARN=2 份文档行数越界，不阻断） |
| 2 | 依赖白名单 + 兼容基线 | 通过（第三方 2/3：bbolt、yaml.v3；同仓 module `replace => ./pkg/pluginapi`） |
| 3 | 薄壳边界 | 通过（业务词/动作词 0 命中） |
| 4 | repo-check | 通过（5 项） |
| 5 | canonical-check | 通过（旧预算/旧字段/幽灵 id 清零） |
| 6 | log-check | 通过（WARN 级，DECISIONS 50 / DISPATCH 44 条） |
| 7 | wt-check | 通过（工作树 1、无残留分支） |
| 8 | oss-check | 通过 |
| 9 | case-check | 通过（5 项全绿） |
| 10 | frontend 首屏 | 通过（首屏 59416 B ≤ 307200 B；i18n 2801 B ≤ 3072 B） |
| 11 | 零侵入 | 通过（11 pass / 0 fail） |
| 12 | secret-check | 0 FAIL / 7 处匹配（均占位写法） |
| 13 | plugin-oss-check（25 仓） | **25 pass / 0 warn / 0 fail** |

### 2.2 干净树（hermetic，权威证据）

```text
命令: cd /home/pt/Work/GolandProjects/kore && git archive HEAD | tar -x -C /tmp/kore-verify-clean \
      && cd /tmp/kore-verify-clean && make check
退出码: 0
输出: 1–12 段全部通过；13/13 输出「[SKIP] 无兄弟仓」；[OK] 门禁全部通过
备注: /tmp 无 ../kore-plugin-*，13 段按 scripts/plugin-oss-check.sh 设计 SKIP（exit 0），
      非失败；该段权威证据用 §2.1 真实工作树 25 pass 补证。
清理: rm -rf /tmp/kore-verify-clean（已确认目录不存在）
```

### 2.3 25 仓独立校验与文档门禁

```text
命令: bash scripts/plugin-oss-check.sh
退出码: 0
输出: 汇总: 25 pass / 0 warn / 0 fail（逐仓全 PASS，无缺失项）

命令: make docs-check
退出码: 0
输出: docs-check: 5 pass, 1 warn, 0 fail；结果: 门禁通过（1 WARN 不阻断）
      [WARN] 行数越界 2 份：docs/GITEE-MIRROR.md:78、docs/PLUGIN-PROTOCOL.md:452
```

文档站：

```text
命令: bash docs/site/build-index.sh
退出码: 0
输出: 生成 docs/site/docs.js（54 条，分类 6 个）；另有 8 条「未映射文档，归入默认类」WARN（不阻断）

命令: python3 解析 docs/site/docs.js 并逐条判路径存在
退出码: 0
输出: entries 54；missing 0；字段 keys = [title, path, category, status]
备注: 重建后 git diff --stat -- docs/site/ 为空 → 生成物与已提交内容一致，无漂移
```

## 3. 逐仓抽查（12 仓深查 + 13 仓全量扫描）

### 3.1 深查 12 仓

判据：`git log -1 --stat` 最近提交只含九件套 / README（收敛提交允许只改 `ci.yml`/`CONTRIBUTING.md`/`README.md`）；`git status --porcelain` 除既有未跟踪 `RELEASE-EVIDENCE.md` / `.agents/verify/*` 外干净；HEAD == `origin`/`github`/`gitee` 的 `main`；`.github/workflows/ci.yml` + 3 个 issue 模板 YAML 可解析；ci 触发断言通过；README oss 块 + CI badge；`grep '{{'`（排除 `${{`）零占位残留；`LICENSE` sha == `kore/LICENSE`；CONTRIBUTING 写「少触发」且无「不配 CI」；`git log --all` 无 `RELEASE-EVIDENCE.md`。

| 仓库（批次） | HEAD | 三端一致 | 九件套 | ci 触发 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `kore-plugin-app-deploy`（C1） | `be781e3` | origin/github/gitee 均 Y | PASS | push main + tag v* + PR + dispatch | 收敛提交仅 `ci.yml`/`CONTRIBUTING`/`README`（+3/−2，均在 oss 块内）；status 干净 |
| `kore-plugin-backup`（C1） | `0498e91` | 三端 Y | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md` |
| `kore-plugin-container`（C1） | `89906c0` | 三端 Y | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md`；README/CHANGELOG 的 `{{json .}}` 为 docker 模板语法（见 §6-d） |
| `kore-plugin-discover`（C2） | `74a564f` | 三端 Y | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md` |
| `kore-plugin-echo`（C2） | `b4c4301` | 三端 Y | PASS | 同上 | status 全干净；M1 验证件同享九件套 |
| `kore-plugin-logs`（C3） | `47e85c1` | 三端 Y | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md` |
| `kore-plugin-redis`（C3） | `f1761e6` | 三端 Y（首次扫描 gitee 瞬时为空，复扫一致） | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md` |
| `kore-plugin-runtime-python`（C4） | `5396a79` | 三端 Y | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md` |
| `kore-plugin-ssl`（C4） | `ffd6dc3` | 三端 Y | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md` |
| `kore-plugin-site`（C4） | `30ccf8c` | 三端 Y | PASS | 同上 | 未跟踪仅 `RELEASE-EVIDENCE.md`；**历史** tracked `.agents/verify/m3-nginx-coexist.md`（`50c2e7f` 2026-11-22），非本轮引入，见 §6-b |
| `kore-plugin-waf`（C4） | `84651b6` | 三端 Y | PASS | 同上 | README diff 仅 oss 块（替换「不配 CI」为「独立 CI（少触发）」+ badge） |
| `kore-plugins`（D） | `fd18c01` | 三端 Y | PASS | 同上 | HEAD 仅 `AGENTS.md`（1 行）；近 3 提交未改 `index/*`、`presets/*`、`versions.lock.json` |

12 仓 `git log --oneline -3` 均为同一形态：`docs(oss): 统一插件仓开源资产与 CI 少触发口径` ← `chore: 补齐开源资产九件套（…）` ← 各自上一业务/依赖提交（`kore-plugins` 为 `docs(oss): 同步索引 AGENTS 签名口径` ← `docs(oss): 同步索引 PR 模板与签名口径` ← `fix(index): 签名流程改为发布方签发 + CI 分层验签`）。

### 3.2 全 25 仓扫描（含未深查的 13 仓）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| HEAD == origin/github/gitee main | **25/25 全 Y**（第二轮复扫；首轮 redis gitee 瞬时读到空值，10s 后一致） | 逐仓 `git ls-remote <remote> refs/heads/main` |
| ci.yml 触发 = push main + tag `v*` + PR + dispatch | **25/25 + 根仓 = 26/26 True** | python3 + `yaml.safe_load` 断言 |
| `.gitea/workflows/` 不存在 | **26/26 不存在**（仅 `.github/workflows/ci.yml`） | `os.path.exists` + 目录列举 |
| README `<!-- oss:begin -->` + `<!-- oss:end -->` + CI badge | **25/25 齐备**（`badge=0` 计数项为 0） | `grep -c 'actions/workflows/ci.yml/badge.svg'` |
| LICENSE 与 `kore/LICENSE` 逐字一致 | **25/25 sha 相同**（`17f9daf2…ff2394`） | `sha256sum` |
| 模板 == 渲染产物 | **25/25 changed=0, exit 0** | `plugin-oss-sync.sh --check ../kore-plugin-* ../kore-plugins` |
| 占位残留（模板 token `{{ID}}` 等） | **0 命中** | 定向 grep 12 个占位名 |
| 历史上曾提交 `RELEASE-EVIDENCE.md` | **0 仓** | `git log --all --name-only` 扫 25 仓 |
| 误入库 `dist/*.tar.gz` / `bin/*` / `web/dist/*` | **0 命中**（`kore-site` 仅历史 `.agents/verify/*` 一项，见 §6-b） | `git ls-files` 判禁 |
| 其余 13 仓 HEAD | cron `334c3b6`、db-mysql `2657fe7`、db-postgres `3d94b4d`、dns `f7cc094`、file `35040ef`、firewall `3a6ad13`、integrity `584c7ac`、monitor `062c69f`、process `f464aad`、runtime-node `79c7919`、runtime-php `627abcd`、ssh-guard `0a8e2cc`、terminal `16d93d6` | 均为 `docs(oss): 统一插件仓开源资产与 CI 少触发口径`，三端一致 |

## 4. 策略与签名分层（方案 A）

### 4.1 触发策略

- 25 兄弟仓 ci.yml 触发集合完全一致：`push: branches [main], tags ["v*"]` + `pull_request` + `workflow_dispatch`。
- 根仓 `kore/.github/workflows/ci.yml` 为同一集合的**超集**（多 `tags: ['pkg/pluginapi/v*']`，SDK 专用 tag），job 名 `Build + check (13 segments)`，注释与 `13 段`/25 仓口径一致；不构成策略漂移。
- Gitea 侧：26 仓均无 `.gitea/workflows/`（权威源只做代码托管，不跑 CI）。

### 4.2 签名分层（`kore-plugins`）

```text
命令: cd ../kore-plugins && bash scripts/validate-index.sh
退出码: 0
输出: [INFO] 签名校验：开启（ed25519 全量验签）… [OK] ed25519 签名验证通过（内置公钥）

命令: KORE_INDEX_SKIP_SIG=1 bash scripts/validate-index.sh
退出码: 0
输出: [WARN] 签名校验：已跳过（KORE_INDEX_SKIP_SIG=1，仅限 PR schema 校验）… [SKIP] 跳过 ed25519 验签

命令: KORE_INDEX_SKIP_SIG=yes bash scripts/validate-index.sh
退出码: 1
输出: [FAIL] KORE_INDEX_SKIP_SIG 只接受 1（跳过验签）或不设 / 0（默认全量验签），当前值: yes   # fail-closed
```

负例（`/tmp/kore-plugins-neg` 副本，真实仓未动）：

```text
命令: printf '\n' >> index/plugins.json && bash scripts/validate-index.sh
退出码: 1
输出: [FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）

命令: printf '\n' >> index/plugins.json && KORE_INDEX_SKIP_SIG=1 bash scripts/validate-index.sh
退出码: 0
输出: schema / 账本 / 预设全 OK + [SKIP] 跳过 ed25519 验签

命令: rm index/plugins.json.sig && KORE_INDEX_SKIP_SIG=1 bash scripts/validate-index.sh
退出码: 1
输出: [FAIL] 缺少 /tmp/kore-plugins-neg/index/plugins.json.sig   # 缺 .sig 在 skip 模式也 fail-closed
```

CI 分层（`kore-plugins/.github/workflows/ci.yml`，已读全文）：`pull_request` → `KORE_INDEX_SKIP_SIG: "1" make check`；`github.event_name != 'pull_request'` → 全量 `make check`；`permissions: contents: read`；**无任何 `secrets.*` 注入**（26 仓 ci.yml `grep 'secrets\.'` 零命中）。

```text
命令: cd ../kore-plugins && make check                    → 退出码 0（8 预设 / 24 索引插件 / 0 FAIL / 0 WARN，含验签）
命令: KORE_INDEX_SKIP_SIG=1 make check                    → 退出码 0（[SKIP] 跳过 ed25519 验签）
```

模板与渲染一致：`bash scripts/plugin-oss-sync.sh --check ../kore-plugins` → exit 0，`[OK] kore-plugins files=9 changed=0`；全 25 仓同命令 25/25 OK。索引内容未被本批改动：`kore-plugins` 近 3 提交（`fd18c01`/`582972e`/`38a0be2`）`git log --name-only` **未出现** `index/*`、`presets/*`、`versions.lock.json`。

反向文案：

- 索引 PR 模板（模板源与渲染产物逐行一致）已改为「签名由维护者合入时统一重签；贡献者不提供 `.sig`、不修改 `.sig`」「已确认本次 PR 未改 `index/plugins.json.sig`」，**不再要求贡献者重签**。
- `scripts/sign-index.sh` 头注释：「执行者 = 发布方（维护者），在自己的发布机上跑」「绝不进 GitHub / Gitee CI secret（CI 只验签、不签名）」，**无「CI 注入 KORE_INDEX_KEY」表述**。

## 5. 根文档事实

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| `docs/OPEN-SOURCE.md` 有「资产矩阵」「九件套」「名称与标识」「贡献者路径」 | PASS | §3 多仓开源资产矩阵（L62）/ §4 插件仓开源资产规范（九件套，L85）/ §5 名称与标识（L122）/ §6 贡献者路径（L130） |
| 安全时限 72h / 90d | PASS | L72、L92、L189、L208 均为「72 小时内确认 / 默认 90 天」 |
| 无 `48 小时` / `48h` / `30 天` | PASS | `grep -nE '48 小时\|48h\|30 天' docs/OPEN-SOURCE.md` 零命中（exit 1） |
| 不再写「未来迁入组织」 | PASS | `grep -n '迁入组织' docs/OPEN-SOURCE.md` 零命中（exit 1） |
| ADR-0024 对齐：版权人 `pengtang1024` ≠ 归属 `kore-pl` | PASS | L7/L9/L13–L17：「版权人 `pengtang1024`（自然人）」「仓库归属 GitHub 组织 `kore-pl`」「module 路径不变」 |
| `docs/PLUGIN-CATALOG.md` 逐插件开源信息表 ≥20 行、含 Gitea Issues | PASS | §15「开源信息」表 20 个产品插件逐行：id / 仓库 / 许可 / **Issues（Gitea 权威源）** / Releases / 维护状态 / 验证方式；`echo` 单列 |
| `docs/REPOS.md` 有 R9 | PASS | L76「R9 开源资产自包含」；L31 开源资产列口径 |
| `CONTRIBUTING.md` 写 13 段 | PASS | L9「当前为 **13 段**」；L89「13/13 绿（含第 13 段 plugin-oss-check 覆盖 25 个兄弟仓）」 |
| `.github/PULL_REQUEST_TEMPLATE.md` 13 段 | PASS | L16「必须贴 13 段结果（含第 8 段 oss-check 与第 13 段 plugin-oss-check）」；L35 25 仓口径 |
| `AGENTS.md` G-26 含 25 仓 | PASS | L62「**25 个兄弟仓（24 插件 + 索引仓）各自九件套齐备（含 CI 少触发…）**」+ `make check` 第 13 段 |
| `.agents/QUALITY-GATES.md` 无「12 段」 | PASS | `grep -n '12 段\|12/12\|十二段'` 零命中（exit 1） |
| `docs/README.md` PLUGIN-SDK 已归位、DECISIONS 0001–0024 | PASS | L34 PLUGIN-SDK 条目（九件套已写入），L63「编号 0001–0024」 |

## 6. 已知不一致（仅记录，不阻塞）

| # | 项 | 事实与证据 | 判定 |
| --- | --- | --- | --- |
| a | `AGENTS.md` §3「镜像推送」仍写 `origin`（GitHub，主） | AGENTS.md L77；实况 `git remote -v`：`origin`=Gitea、`github`=GitHub、`gitee`=Gitee；ADR-0024 决策 B 明确 Gitea 唯一权威源 | **WARN，不阻塞**（任务明示只记录）。修法：把该行改为「先 `origin`（Gitea，权威源）→ `github` → `gitee`」 |
| b | `kore-plugin-site` / `kore-plugin-process` 有**历史** tracked `.agents/verify/*` | site `.agents/verify/m3-nginx-coexist.md`（`50c2e7f` 2026-11-22「test(site): commit M3-A … evidence」）；process `.agents/verify/release-v0.2.0.md`（`d572c7d` 2026-11-23「test(process): 空 cmdline … 回归用例」）；两者的 HEAD 提交均**未触碰** `.agents/`，非本轮引入 | **WARN，不阻塞**（超出本验收写域，不修他人文件）。建议原 owner 后续单独清理 |
| c | `kore-plugins` 用「CI 少执行 / 手动触发」而非字面「少触发」 | CONTRIBUTING.md L3、README 同义；无「不配 CI」 | **措辞差异，通过**（语义一致，非策略漂移） |
| d | 字面 `grep -rn '{{'`（排除 `${{`）在 2 仓有命中 | app-deploy README L89 `{{.Names}}`；container README/CHANGELOG `{{json .}}`——均为 docker `--format` 的 Go 模板语法，非未渲染占位符；模板占位 token（`{{ID}}`…）全 25 仓零命中；`plugin-oss-check` 的「占位残留」项 25/25 PASS | **WARN，不阻塞**（文档内容，非生成产物残留） |
| e | docs-check 2 份文档行数越界 | `docs/GITEE-MIRROR.md` 78 行、`docs/PLUGIN-PROTOCOL.md` 452 行（期望 100–400） | **WARN，不阻塞**（脚本明确 WARN 级） |
| f | 首轮扫描 `kore-plugin-redis` gitee 读到空 sha | 10 秒后复扫 `gitee=f1761e6` 与本地一致；第二轮全 25 仓扫描 0 mismatch | **瞬时网络/限流，非仓库问题** |
| g | 工作树他人在线 WIP | `M Makefile`、`M docs/FRONTEND.md`、`M web/embed.go`、`M web/files-l2.js`、`M web/files.js`、`M web/i18n/*.js`、`M web/shell.js`、`?? web/waf.js`（16:39 起） | **未 stash / 未回滚 / 未提交**；不影响 13 段（exit 0）；本报告仅精确提交自身文件 |

## 7. 命令 + 退出码清单（复跑原文）

| # | 命令（原文） | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `make check`（工作树 16:31） | 0 | 13/13；`汇总: 25 pass / 0 warn / 0 fail`；`[OK] 门禁全部通过` |
| 2 | `make check`（工作树 16:39:37，含他人 WIP） | 0 | 13/13 同上（10 段首屏 59416 B） |
| 3 | `git archive HEAD \| tar -x -C /tmp/kore-verify-clean && cd /tmp/kore-verify-clean && make check` | 0 | 1–12 段通过；`13/13 … [SKIP] 无兄弟仓`；`[OK] 门禁全部通过` |
| 4 | `bash scripts/plugin-oss-check.sh` | 0 | `汇总: 25 pass / 0 warn / 0 fail` |
| 5 | `make docs-check` | 0 | `5 pass, 1 warn, 0 fail`；2 份行数 WARN |
| 6 | `bash docs/site/build-index.sh` | 0 | `生成 docs/site/docs.js（54 条，分类 6 个）`；8 条未映射 WARN |
| 7 | `python3` 解析 `docs/site/docs.js` + 判路径 | 0 | `entries 54` / `missing 0` |
| 8 | 逐仓 python3（12 仓）：YAML 解析 + 触发断言 + README/LICENSE/占位/stat/远端 | 0 | 12/12 全 True；`placeholder_count` 仅 docker 模板语法 |
| 9 | python3 全 25 仓 + 根仓：触发断言 + `.gitea` 检查 | 0 | 26/26 `trigger_ok=True`；`BAD=[]` |
| 10 | `bash scripts/plugin-oss-sync.sh --check ../kore-plugins` | 0 | `[OK] kore-plugins files=9 changed=0` |
| 11 | `bash scripts/plugin-oss-sync.sh --check ../kore-plugin-* ../kore-plugins` | 0 | 25 条 `[OK]`，无差异 |
| 12 | `bash scripts/validate-index.sh`（kore-plugins） | 0 | 全量 ed25519 验签通过（24 条） |
| 13 | `KORE_INDEX_SKIP_SIG=1 bash scripts/validate-index.sh` | 0 | `[WARN] 签名校验：已跳过` + `[SKIP] 跳过 ed25519 验签` |
| 14 | `KORE_INDEX_SKIP_SIG=yes bash scripts/validate-index.sh` | 1 | `[FAIL] KORE_INDEX_SKIP_SIG 只接受 1…当前值: yes` |
| 15 | `/tmp` 副本 `printf '\n' >> index/plugins.json` + 全量 validate | 1 | `[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）` |
| 16 | 同副本 + `KORE_INDEX_SKIP_SIG=1` validate | 0 | schema/账本/预设 OK + `[SKIP]` |
| 17 | 同副本 `rm index/plugins.json.sig` + skip validate | 1 | `[FAIL] 缺少 …/index/plugins.json.sig` |
| 18 | `make check`（kore-plugins） | 0 | 8 预设 / 24 插件 / 0 FAIL / 0 WARN + 验签通过 |
| 19 | `KORE_INDEX_SKIP_SIG=1 make check`（kore-plugins） | 0 | 同上 + `[SKIP] 跳过 ed25519 验签` |
| 20 | `sha256sum` 比对 25 仓 LICENSE vs `kore/LICENSE` | 0 | `LICENSE_MISMATCH=0`（`17f9daf2…ff2394`） |
| 21 | 25 仓 `git status --porcelain` | 0 | 仅 `?? RELEASE-EVIDENCE.md` / `?? .agents/verify/release-v0.2.1.md` 等既有未跟踪 |
| 22 | 25 仓 `git log --all --name-only` 查 `RELEASE-EVIDENCE.md` | 0 | 零命中（0 仓曾提交） |
| 23 | `grep -rn '插件仓不配 CI'`（kore docs/templates + 25 仓 tracked md/yml） | — | 零命中 |
| 24 | `grep -rn 'CI 注入 KORE_INDEX_KEY\|release 流水线中注入\|流水线签名'` | — | 零命中 |
| 25 | kore `git ls-remote` origin/github/gitee + 25 仓同项 | 0 | 26/26 HEAD 三端一致 |
| 26 | `rm -rf /tmp/kore-verify-clean` / `rm -rf /tmp/kore-plugins-neg` | 0 | 已确认删除（无残留、真实仓未被修改） |

## 8. 运行态声明（G-29）

**本轮未改动主实例运行态配置（否）。** 未触碰 `.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、`bin/kored`，未重启主实例；签名负例全部在 `/tmp/kore-plugins-neg` 副本执行并已删除；未改 `kore-plugins/index/*`、`.sig`、`presets/*`、`versions.lock.json`。

## 9. 提交与推送

本报告单独提交（精确 `git add .agents/verify/oss-plugin-bundle.md`），commit `docs(agents): 开源资产补齐验收报告`，推 `origin`（Gitea）→ `github` → `gitee`，不回滚、不 stash、不夹带任何他人 WIP。
