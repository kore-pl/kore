# 干净 clone 可复现性报告独立复核（G-09 / task-298）

> 状态: verified · 归属: clean-clone-verifier · 更新: 2026-11-28 · 复核对象: commit `7a19416`（234 行，父提交 `bb07f58`）
> 硬纪律: 只读复核；不改生产代码、不启服务、不碰 `.kore-local-*`、不碰主实例、不联网业务；唯一写域＝本文件。
> 方法: 逐条读源码 + 只读运行 `bash scripts/docs-check.sh` / `bash scripts/secret-check.sh` + git 元数据核对；**未**在全新 clone 中重跑 `make build` / `make check`（沙箱宿主 Go 缓存只读，且任务限定只读复核），因此构建结论以「证据链自洽 + 当前二进制事实」为准，边界见 §6。

## 0. 总评

**PASS（核心结论成立）**：报告关于「干净树能独立复现构建」的结论成立；3 个缺陷均为**真实代码问题**，不是环境噪声（1 个既存、2 个 clean-only）。另有 2 处**非阻断的表述瑕疵**（§5.2、§5.3），不改变任何结论，但建议 lead 知悉。

| 复核项 | 判定 |
|---|---|
| ① 构建证据链 | 成立（代码路径 + 当前二进制事实自洽；未全新 clone 重跑，见 §6） |
| ②a P1 跨仓相对链接 | **真缺陷 / clean-only** — 确认 |
| ②b P1 pubkey-sync 硬 FAIL vs market SKIP | **真缺陷 / clean-only** — 确认，改 SKIP 建议合理 |
| ②c P2 secret-check 误报 | **真缺陷 / 既存非 clean-only** — 确认 |
| ③ 门禁分段 | 逐段表准确；汇总行「17 段 PASS」口径含糊（§5.2），非核心证据失效 |
| ④ 诚实边界 | 基本如实；1 处报告自身内联链接的细节需知悉（§5.3） |
| ⑤ git 纪律 | 单文件 234 行 + DCO + 未 push + 他人 dirty 原样 + 临时资产删净 — 全部确认 |

## 1. ①构建证据复核

| 报告断言 | 独立核对（只读） | 结论 |
|---|---|---|
| clone 源 HEAD = `bb07f58` | `git rev-parse 7a19416^` = `bb07f58cf92fd83b69f280febf0c197a5054a115` ✓ | 成立（报告正建于该父提交之上） |
| 干净树 status 空 / 无 web/dist、bin/kored、.kore-local-\* | `git ls-tree -r --name-only HEAD` 中匹配 `^(web/dist/|bin/kored|\.kore-local)` 计数 = **0**；`.gitignore:6 /bin/`、`:13 web/dist/` 确为忽略项 ✓ | 成立（提交态不含生成物） |
| `make build` exit 0、go:embed 自愈 | `Makefile:90 web-dist:` 为纯本地 cp（无 npm/网络）；`Makefile:99 build: web-dist` 把前置绑定进 build；`Makefile:77-78` 注释明确记录「干净检出直接 go build 因 //go:embed 失败」并给出自愈设计 ✓ | 代码机制成立 |
| `kored version` = 0.1.3 | `Makefile:29 VERSION ?= 0.1.3`；只读实跑当前二进制 `./bin/kored version` → `kored 0.1.3` / `协议 kore.plugin.v1`，exit 0 ✓ | 成立 |
| 二进制 13,451,426 字节，与脏工作区字节级一致 | `stat -c %s bin/kored` = **13451426**；sha256 = `870b54f6…65261` ✓ | 当前脏树事实与报告数字一致 |
| 依赖走仓外可写缓存 + goproxy | 报告 §3/§5.4/§6.3 明示 run1/run2 只读缓存失败、run3 用 `/tmp/kore43-cache3` + `https://goproxy.cn,direct` 全绿；目录已删（§5 ⑤项核对） ✓ | 陈述自洽（未独立复跑，见 §6） |

**小结**：build 的可复现性由「web-dist 前置 → embed 有文件 → 单一 VERSION 注入 → 字节一致」四环证据支撑，链路闭合，结论成立。

## 2. ②a [P1] 跨仓相对链接断链 — 真缺陷 / clean-only

- `docs/DECISIONS/0051-dns-root-boundary.md:2` 原文确含一条相对链接（锚文本 dns README，目标为 kore-plugin-dns 仓的 README，向上三级）（已读）✓
- `scripts/docs-check.sh:161-168`：白名单只放行 `http://*`/`https://*`/`mailto:*`/`tel:*`/`data:*`/`file:*`/`/*`；相对链接一律进入 `:165 if [ ! -e "${dir}/${target}" ]` 判可达。无跨仓豁免 ✓
- 路径解析：`docs/DECISIONS/../../../kore-plugin-dns/README.md` 落到 `kore-pl/` 同级。当前脏树该兄弟仓存在（`kore-plugin-dns/README.md` 27068 字节，已读确认）→ 可达；clone 到 `/tmp/kore-clean-clone-43` 时目标落 `/tmp/kore-plugin-dns/README.md` → 不存在 → FAIL ✓
- 只读实跑当前脏树 `bash scripts/docs-check.sh` → exit 0，`docs-check: 5 pass, 1 warn, 0 fail`，相对链接段 `检查 1336 条相对链接，全部可达` ✓ —— 脏树 PASS、干净树 FAIL 的对照成立。
- 报告把判定逻辑标为 `scripts/docs-check.sh:166`，实际条件在 `:165`、`:166` 是 detail 打印、`:167` 是 `LINK_BROKEN++`（同一 3 行块内，轻微行号 imprecision，不影响缺陷真实性）。

**判定：真代码问题（clean-only）。** 改为 GitHub 绝对 URL 或给 docs-check 加跨仓豁免均可行（http/https 已被 `:162` 白名单放行，方案成立）。

## 3. ②b [P1] pubkey-sync-check 硬 FAIL vs market-check SKIP — 真缺陷 / clean-only

- `scripts/pubkey-sync-check.sh:9` 默认 `KORE_PLUGINS_DIR=$ROOT/../kore-plugins`；`:16 [ -f "$VALIDATE" ] || fail "缺少 $VALIDATE（可用 KORE_PLUGINS_DIR 指向索引仓）"` → `fail()` 在 `:13` 为 `exit 1`，硬失败 ✓
- 对照 `Makefile:502-504 market-check`：`if [ ! -d "$(KORE_PLUGINS_DIR)" ]; then echo "[SKIP] …不阻断独立 clone…"; exit 0; fi` ✓ —— 同一「缺索引仓」场景，一个 SKIP exit 0、一个 FAIL exit 1，口径客观不一致。
- 同向旁证：`scripts/plugin-oss-check.sh:44-45`、`scripts/store-check.sh:96-97`、`scripts/presets-check.sh:196-197` 均在无兄弟仓时 `[SKIP] exit 0`；报告把 13/14/15/18/market 列为预期 SKIP 与这些代码一致。
- 脏树侧 `kore-plugins/scripts/validate-index.sh` 存在（10604 字节，已读确认）→ 该段脏树 PASS ✓，clean-only 对照成立。
- ADR-0025（docs/DECISIONS/0025-index-signing-redesign.md）要求两端公钥逐字一致；「文件存在但公钥不一致」仍需 FAIL，只有「脚本缺失」应比照 SKIP。报告建议（缺文件 SKIP exit 0、存在但不一致 FAIL）与项目既定 SKIP-on-missing-sibling 惯例一致。

**判定：真代码问题（clean-only）；改 SKIP 的建议合理**，且保留了真正的安全判据（不一致仍 FAIL）。

## 4. ②c [P2] secret-check 误报 — 真缺陷 / 既存非 clean-only

- `.agents/verify/backup-download-verification.md` 在 HEAD 中被跟踪（blob `f2f6361…`）→ 脏树/干净树同在 ✓；`:125` 实读为证据表格里的一条 `grep -nE` 命令文本，里面把凭据键名拼成一段交替正则（键名后用等号接转义竖线与引号模式）—— 是一段 grep 搜索模式，不是口令 ✓
- `scripts/secret-check.sh:35 ENV_RE` 命中该键名；`:41-51 is_allowed()` 只放行 `***`/`[REDACTED]`/`...`/`…`/`$*`/`<*`/纯星号， captured value 以反斜杠开头 → 不被豁免 → `:75 FAIL++` ✓ —— 误报机理与报告描述一致。
- 只读实跑当前脏树 `bash scripts/secret-check.sh` → exit 1，`[FAIL] …/backup-download-verification.md:125 ADMIN_PASSWORD 疑似明文凭据`，`secret-check: 1 FAIL / 28 处匹配` ✓ —— 既存缺陷，非 clean-only。
- 匹配数差异说明：报告干净树记「22 处匹配」，本次脏树记「28 处」—— 脏树多出若干未跟踪证据文件（e2e-\*.md 等），符合预期，不是矛盾。
- 报告建议的占位写法（`<pattern>` 形式）经 `is_allowed()` 的 `<*` 分支确认为可豁免 ✓。

**判定：真缺陷（grep 模式字串被当成凭据的误报），既存、非 clean-only。**

## 5. ③门禁分段与 ④诚实边界

### 5.1 分段表逐行核对

报告 §4 表（`:127-148`）与 `Makefile:513-608` 的 `check` 配方逐段一致：1 docs-check、2 依赖/兼容基线、3 薄壳、4 repo、5 canonical、6 log、7 wt、8 oss、9 case、10 frontend、11 零侵入、12 secret、13 plugin-oss、14 store、15 presets、16 pubkey + market 子步、17 cross-build、18 race-gate、19 race-full、20 usability、21 pluginapi-race。`fail=1` 由 FAIL 段置位，`Makefile:607` `exit 1` → make 报 exit 2，机制自洽 ✓。

真编译段（17 五目标全仓 build、19 全仓 -race、21 pkg/pluginapi -race）在报告中均记 exit 0；`Makefile:588-589/594-595/604-605` 均把它们作为阻断级 `if ! …; then fail=1`，故若 FAIL 则 make check 不可能只在 1/12/16 三段红 —— 与「仅 3 段 FAIL」自洽 ✓。13/14/15/18/market SKIP 的代码证据见 §3 旁证与 `scripts/race-gate-check.sh:205`。

### 5.2 汇总行口径瑕疵（非阻断，建议修正）

报告 `:150` 写「17 段 PASS（含 WARN 级）、4 段 SKIP/N-A、3 段 FAIL」，三数相加 = 24 > 21 段，且把 SKIP 重复计入「PASS」。按 §4 表精确分类应为：

- **13 段 PASS**（2/3/4/5/6/7/8/9/10/11/17/19/21，其中 6/7/9/10 为 PASS 带 WARN）
- **1 段 WARN 不阻断**（20/21 usability）
- **4 段 SKIP**（13/14/15/18；market 是 16 段内子步骤，非独立段）
- **3 段 FAIL**（1/12/16）

若作者原意是「17 = 13 PASS + 4 SKIP 的非 FAIL 段」，则应改写为「13 段 PASS + 4 段 SKIP + 3 段 FAIL + 1 段 WARN」以消除歧义。**此瑕疵不改变任何门禁结论**（exit 2、3 个 FAIL 段均与明细一致），故不判 BLOCKED，仅记录。

### 5.3 报告自身内联链接的细节（非阻断，建议知悉）

报告 `:180` 在行内反引号里写了一条 markdown 相对链接（锚文本 dns README，目标为 kore-plugin-dns README）。`scripts/docs-check.sh:55-60 links_of()` 只跳过围栏代码块、不跳过行内反引号，实测该模式会被 `grep -oE` 抽出。后果：

- 当前脏树：兄弟仓存在 → 该链接可达；只读实跑 docs-check 为 1336 条链接全通过 ✓，报告「脏树 PASS」成立。
- 若对 **HEAD=7a19416 的干净 clone** 重跑 docs-check，同一断链会被计为 **2 条**（0051:2 + 报告:180），而报告 §5.3 记的是「断链 1 条」——因为该次干净树 run 的真实 HEAD 是 `bb07f58`（报告尚未提交）。当时数字正确；但后续 clone 该数字会变。
- 这不新增 FAIL 段（docs-check 本已 FAIL），也不影响 3 缺陷判定；仅属「报告本身不新增门禁 FAIL」的边界细节：脏树不新增 FAIL ✓，干净树不新增 FAIL 段但会多 1 条断链明细。

### 5.4 诚实边界逐条

- 「本地 file:// clone ≠ GitHub 远端」：报告 §6.1 明示 ✓ 如实。
- 「兄弟仓缺失 SKIP 属预期、1/21 与 16/21 硬 FAIL 才是缺陷」：报告 §5.3/§6.2 明确区分 ✓ 如实。
- 「run1/run2 只读缓存 FAIL 属环境、run3 仓外缓存 + goproxy 全绿」：报告 §5.4/§6.3 明示且标注为环境类 ✓ 自洽（本次未独立复跑，见 §6）。
- 「报告本身不新增门禁 FAIL」：见 §5.3，脏树成立；干净树不新增 FAIL 段 ✓。
- 「未启服务、未碰 .kore-local-\* / 8787 / 宿主安装」：报告 §6.4 明示 ✓。

## 6. ⑤git 与清理纪律

| 检查 | 结果 |
|---|---|
| `git show --stat 7a19416` | 1 file changed, **234 insertions(+)**，仅 `.agents/verify/clean-clone-reproducibility.md` ✓ |
| DCO | commit message 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ✓ |
| 未 push | `git status -sb` = `## main...origin/main [领先 1]`；遍历 origin/github/gitee 远端分支均无 7a19416 ✓ |
| 他人 dirty 原样 | 当前 `git status --short` 仍含 `M scripts/usability-pending.txt` 与 `?? .agents/.agents/`、`?? .agents/verify/e2e-*.md`、`?? data/`、`?? dist/`、`?? .agents/verify/screenshots/…` —— 与报告 §5 基线一致，未被动过 ✓ |
| 临时资产删净 | `/tmp/kore-clean-clone-43`、`/tmp/kore43-cache3` 均不存在；`.agents/verify/.clean-clone-43-run*.log` 不存在 ✓ |
| 提交原子性 | 报告文件当前无未提交 diff（`git status --short` 对该路径为空）✓ |

## 7. 复核边界与限制（诚实声明）

1. 本次为**只读 verifier**：未从零重跑 `make build` / `make check`。构建结论基于 Makefile 代码路径、VERSION 常量、当前二进制字节数/version 输出与报告证据链的交叉印证；「字节级一致」中的「干净 clone 侧 13,451,426」无法在本次独立复现，只能确认脏树侧数字与报告一致。
2. 宿主 Go 缓存只读、goproxy 可用性属环境前提，按任务授权不在本次触碰；run1/run2/run3 的 exit code 未在本次独立复跑。
3. 未联网、未启服务、未改任何运行态资产；`/tmp` 中间输出不跨 shell 持久，相关只读结果均在同一 bash 调用内回读。

## 8. 结论

报告 commit `7a19416` 的**核心结论成立且 3 缺陷判定准确**：

- ① 干净树独立构建：成立（证据链自洽；限制见 §7.1）
- ②a P1 跨仓相对链接：**真代码缺陷 / clean-only**
- ②b P1 pubkey-sync 硬 FAIL：**真代码缺陷 / clean-only**，改 SKIP 建议合理
- ②c P2 secret-check 误报：**真代码缺陷 / 既存非 clean-only**

总评 **PASS**；§5.2、§5.3 两处非阻断瑕疵建议 lead 在派修复卡时一并澄清。
