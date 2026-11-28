> 状态: accepted · 归属: gate-fix · 更新: 2026-11-28 · 里程碑: R43
> 任务: task-299 · 性质: 修门禁脚本口径不一致（非新功能）

# 干净 clone 三门禁缺陷修复验证（task-299）

## 0. 一句话结论

三个门禁缺陷全部修复，三个脚本 self-test 全绿；干净 clone（本地 `file://`，短路径）`make check` **exit 0 / 21 段全绿 / `[OK] 门禁全部通过`**；脏树 `make check` **exit 0** 无回归。只改 3 个门禁脚本 + 本验证文档，未碰生产业务代码、插件仓、8787 / `.kore-local-*`。

## 1. 三缺陷与修法（worker 读码确认）

| # | 缺陷 | 定位（HEAD c685a66） | 修法 |
|---|---|---|---|
| ① P1 跨仓相对链接 | 干净 clone 断链：`docs/DECISIONS/0051-dns-root-boundary.md:2` 的 `../../../kore-plugin-dns/README.md` 无豁免；docs-check 对相对链接一律判本地可达 | `scripts/docs-check.sh` 原 161–168（白名单只放行 http(s)/mailto/tel/data/file/绝对路径，`:165` 无豁免） | 新增 `cross_repo_link()`：链接解析后相对 ROOT 为 `../kore-plugin-*` / `../kore-plugins(/…)` 且**目标不存在** → SKIP（与 market-check 缺兄弟仓 SKIP 口径一致）；目标存在照常判可达；本仓内相对链接硬判据不变 |
| ② P1 pubkey-sync | `scripts/pubkey-sync-check.sh:16` `[ -f "$VALIDATE" ] \|\| fail` 在缺 `../kore-plugins/scripts/validate-index.sh` 时硬 FAIL，阻断独立 clone | 同上 | 缺 `$VALIDATE` → `[SKIP] … exit 0`；文件存在但两端公钥不一致仍 FAIL；`--self-test` 三场景正反例 |
| ③ P2 secret-check 误报 | `.agents/verify/backup-download-verification.md:125` 是一条 `grep -nE` 交替正则模式（含口令键名占位），被 `ENV_RE` 命中键名判明文 | `scripts/secret-check.sh` 原 `:35` 命中 / `:41-51` is_allowed 不豁免 captured value / `:75` FAIL | `is_pattern_context()`：同一行含 `grep` 且 `-E`(含 `-nE`) 且值本身是正则片段（`\| \ [ ] ( ) <…> + ? …`）→ WARN 不 FAIL；真实赋值仍 FAIL。`backup-download-verification.md:125` 不在写域，靠豁免解决 |

## 2. 修前基线（干净 clone3-original，HEAD 原脚本）

```text
git clone --no-local file:///…/kore /tmp/…/clean-clone3-original
bash scripts/docs-check.sh      → exit 1（[FAIL] 相对链接断链 2 条，含 0051 dns README）
bash scripts/secret-check.sh    → exit 1（[FAIL] …/backup-download-verification.md:125 ADMIN_PASSWORD；1 FAIL / 24 匹配）
bash scripts/pubkey-sync-check.sh → exit 1（[FAIL] 缺少 …/../kore-plugins/scripts/validate-index.sh）
```

## 3. self-test（三场景正反例）

```text
bash scripts/docs-check.sh --self-test        → exit 0，docs-check self-test: 5 pass, 0 fail
  （兄弟仓 kore-plugin-* / kore-plugins 被识别；本仓内链接不被误判；文件名含 kore-plugin 不误判）
bash scripts/pubkey-sync-check.sh --self-test → exit 0，pubkey-sync-check self-test: 3 pass, 0 fail
  （正常一致 OK exit0；缺 validate-index.sh SKIP exit0；文件存在但公钥不一致 FAIL exit1）
bash scripts/secret-check.sh --self-test      → exit 0，secret-check self-test: 6 pass, 0 fail
  （真实 ADMIN_PASSWORD / admin_password 赋值 FAIL；grep -nE 交替/字符类模式不 FAIL；无命令上下文的元字符赋值 FAIL；<pattern> 占位不 FAIL）
bash -n scripts/{docs-check,pubkey-sync-check,secret-check}.sh → 全部 exit 0
```

另有**端到端正反例**（干净 clone 中实测）：注入本仓断链 `docs/VISION.md → ./DOES-NOT-EXIST.md` → docs-check exit 1（硬判据保留，`git checkout -- docs/VISION.md` 还原）；兄弟仓目标存在时不再 SKIP，目标缺失才 SKIP。

## 4. 修后单脚本（本机脏树 + 隔离缺仓场景）

```text
bash scripts/docs-check.sh                              → exit 0（5 pass, 1 warn, 0 fail）
bash scripts/secret-check.sh                            → exit 0（0 FAIL / 28 匹配，1 WARN = backup-download-verification.md:125 正则模式豁免）
KORE_PLUGINS_DIR=/tmp/no-such-… bash scripts/pubkey-sync-check.sh → exit 0（[SKIP] 缺 validate-index.sh）
bash scripts/pubkey-sync-check.sh（本机兄弟仓存在）      → exit 0（[OK] 两端公钥一致 3e461a07…）
```

## 5. 干净 clone 全量复验（关键）

本地 `file://` clone 到**短路径** `/tmp/kgc`（无兄弟仓），overlay 三个修复后的脚本 + 复制 `web/dist`（embed 依赖，等价于 `make build` 的 web-dist 前置），缓存用仓外可写目录：

```text
git clone --no-local file:///…/kore /tmp/kgc
cp <fixed 3 scripts> /tmp/kgc/scripts/ ; cp -a <src>/web/dist /tmp/kgc/web/
cd /tmp/kgc && GOCACHE=/tmp/kgc-gocache GOMODCACHE=<src>/.tmp/gomodcache \
  GOWORK=off GOPROXY=off make check   → exit 0
  [OK] 门禁全部通过（21 段）
    1/21 docs-check: 5 pass, 1 warn, 0 fail（兄弟仓链接 SKIP）
    12/21 secret-check: 0 FAIL / 24 匹配（1 WARN 正则模式豁免）
    16/21 pubkey-sync: [SKIP] 缺 validate-index.sh → 不阻断；16-附 market SKIP
    17/21 全仓交叉编译五目标 exit 0；19/21 全仓 -race 17 包零 DATA RACE；21/21 pluginapi -race 2 包零 DATA RACE
    20/21 usability 的「未找到 ../kore-plugin-*/info.json」为 WARN 级不阻断（缺兄弟仓，预期）
临时 clone /tmp/kgc + /tmp/kgc-gocache 已删（rm -rf，exit 0）
```

**验证路径教训**：第一次用深路径 `.verify-gate-fix/clean-clone2/…` 时，11/21 零侵入段的隔离 kored UDS 路径 118 字节 > Linux `sun_path` 107 上限 → `bind: invalid argument`，属验证路径伪影；换短路径后 11/21 PASS。GOCACHE/GOMODCACHE 必须指向仓外可写目录（默认 `/home/pt/.cache/go-build` 与 `/home/pt/go/pkg/mod` 在本沙箱只读）。

## 6. 脏树复验

```text
cd <src 工作区>（他人 dirty：scripts/usability-pending.txt、.agents/verify/*、data/、dist/ 原样）
GOCACHE=<可写> GOMODCACHE=<可写> GOWORK=off GOPROXY=off make check → exit 0
  [OK] 门禁全部通过（21 段，含 11/21 零侵入 PASS、18/21 race PASS、19/21 全仓 -race 17 包零 DATA RACE）
  第 20 段 usability 存量 WARN 不阻断（waf ZeroParam 真跑 FAIL 为存量清单豁免项，非本次引入）
```

## 7. 边界与诚实声明

- 不改生产业务代码、插件仓、8787、`.kore-local-*`、宿主；`backup-download-verification.md:125` 不在写域，靠脚本豁免解决，未直接改该文件。
- 未 push / tag / Release；发版由 lead 统一。
- 干净 clone 为本地 `file://` clone，非远端；兄弟仓缺失 SKIP/WARN 属设计预期。
- 三个脚本的 `--self-test` 均为纯用例（docs-check 无临时资产；pubkey-sync / secret-check 用 `mktemp -d` + `trap rm -rf`），跑完无残留。
- 验证日志落 `.verify-gate-fix/`（已在 `.git/info/exclude` 排除，非交付物）；短路径 `/tmp/kgc*` 已删。

## 8. 总评

**PASS**：三缺陷修复且有正反例 self-test；干净 clone make check exit 0 全绿；脏树 make check exit 0 无回归。
