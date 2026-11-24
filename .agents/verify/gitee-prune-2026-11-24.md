# Gitee release prune 全量执行（26 仓 · 2026-11-24）

> 元信息: 2026-11-24 · 执行 gitee-prune-run · 依据 AGENTS.md §3「Gitee release 只保留最新 5 个」+ [GITEE-MIRROR.md](../../docs/GITEE-MIRROR.md) §3 · **只改 Gitee release，未动 GitHub / Gitea / 索引 / preset** · 未 push
> 命令原文见 §6，token 全程只从 `$GITEE_TOKEN` 读取、不落盘不打印（G-30）

## 0. 结论先行

| 项 | 结果 |
| --- | --- |
| 全量扫描 | **26/26 仓**跑 `--dry-run`，0 失败；**12 仓超 5 条**，14 仓 ≤5（其中 `kore` / `kore-plugins` 各 0 条） |
| 人工复核 | 12 个待删版本里 **11 个三条件全过 → 真删**；**1 个（`kore-plugin-echo` v0.1.0）第三条不成立 → 跳过并保留**（GitHub 无该 release，只有 tag） |
| 真删执行 | 11 仓各删 1 个版本，**全部 exit 0**，护栏①②每仓均 ✓ |
| 删除后数量 | 11 仓全部 **== 5**；其余 ≤5；**`echo` 仍为 6**（按规则跳过，见 §5） |
| 保留资产可用性 | 11 仓 **55/55** 保留版本 Gitee 资产 `curl -L` **200**，sha256 **与 GitHub 同名资产 digest 全等** |
| 被删版本 | Gitee release 列表已无、assets 链接 **404**；GitHub 对应 release **仍 200**（未动） |
| 未触碰 | GitHub release / tag、Gitea、`kore-plugins` 索引与 preset 均无改动 |

## 1. 判据与范围

- **保留策略**：Gitee 每仓按 tag 语义版本（`sort -V`）保留最新 5 个，第 6 个起删；GitHub 全量保留（[GITEE-MIRROR.md](../../docs/GITEE-MIRROR.md) §3）。
- **脚本护栏**（脚本自判，未绕过）：① 删除后剩余 == `--keep 5`；② 被删版本**全部严格小于**保留集最小版本。
- **范围**：`kore` + `kore-plugins` + 24 个 `kore-plugin-*`，共 26 仓（`pengtang1024/<repo>`）。
- **人工复核三条件**（逐待删版本）：① 不是当前索引版本 ② 不是任何 preset pin 版本 ③ GitHub 上确实还有（release 200）。

## 2. `--dry-run` 全量结果（26 仓）

命令：`scripts/gitee-release-prune.sh --dry-run --repo pengtang1024/<repo>`（逐仓，26/26 exit 0）

### 2.1 超 5 条的 12 仓（含护栏判定）

| 仓库 | 总数 | 保留（新→旧） | 待删 | 护栏① | 护栏② |
| --- | --- | --- | --- | --- | --- |
| kore-plugin-app-deploy | 6 | v0.3.2 v0.3.1 v0.3.0 v0.2.2 v0.2.1 | **v0.2.0** | ✓ 剩 5 == 5 | ✓ victim < 0.2.1 |
| kore-plugin-container | 6 | v0.5.5 v0.5.4 v0.5.2 v0.5.1 v0.5.0 | **v0.4.1** | ✓ 剩 5 == 5 | ✓ victim < 0.5.0 |
| kore-plugin-cron | 6 | v0.7.0 v0.6.0 v0.5.0 v0.4.1 v0.4.0 | **v0.3.0** | ✓ 剩 5 == 5 | ✓ victim < 0.4.0 |
| kore-plugin-db-postgres | 6 | v0.3.4 v0.3.3 v0.3.2 v0.3.1 v0.3.0 | **v0.2.1** | ✓ 剩 5 == 5 | ✓ victim < 0.3.0 |
| kore-plugin-dns | 6 | v0.4.2 v0.4.0 v0.3.2 v0.3.1 v0.3.0 | **v0.2.0** | ✓ 剩 5 == 5 | ✓ victim < 0.3.0 |
| kore-plugin-echo | 6 | v0.1.5 v0.1.4 v0.1.3 v0.1.2 v0.1.1 | ~~v0.1.0~~（跳过） | ✓ 剩 5 == 5 | ✓ victim < 0.1.1 |
| kore-plugin-integrity | 6 | v0.5.1 v0.5.0 v0.4.0 v0.3.3 v0.3.2 | **v0.3.1** | ✓ 剩 5 == 5 | ✓ victim < 0.3.2 |
| kore-plugin-logs | 6 | v0.5.2 v0.5.1 v0.5.0 v0.4.2 v0.4.1 | **v0.4.0** | ✓ 剩 5 == 5 | ✓ victim < 0.4.1 |
| kore-plugin-monitor | 6 | v0.3.1 v0.3.0 v0.2.1 v0.2.0 v0.1.1 | **v0.1.0** | ✓ 剩 5 == 5 | ✓ victim < 0.1.1 |
| kore-plugin-runtime-node | 6 | v0.2.5 v0.2.4 v0.2.3 v0.2.2 v0.2.1 | **v0.2.0** | ✓ 剩 5 == 5 | ✓ victim < 0.2.1 |
| kore-plugin-runtime-python | 6 | v0.3.2 v0.3.1 v0.3.0 v0.2.4 v0.2.3 | **v0.2.2** | ✓ 剩 5 == 5 | ✓ victim < 0.2.3 |
| kore-plugin-waf | 6 | v0.4.5 v0.4.4 v0.4.3 v0.4.2 v0.4.1 | **v0.3.1** | ✓ 剩 5 == 5 | ✓ victim < 0.4.1 |

### 2.2 未超限的 14 仓（不动作）

| 仓库 | 总数 | 保留集（新→旧） | 判定 |
| --- | --- | --- | --- |
| kore | 0 | — | 无可判序 release，跳过 |
| kore-plugins | 0 | — | 无可判序 release，跳过 |
| kore-plugin-discover | 4 | v0.3.1 v0.3.0 v0.2.0 v0.1.0 | ≤5，无需清理 |
| kore-plugin-terminal | 4 | v0.2.1 v0.2.0 v0.1.1 v0.1.0 | ≤5，无需清理 |
| kore-plugin-backup | 5 | v0.4.2 v0.4.1 v0.4.0 v0.3.0 v0.2.1 | ==5，无需清理 |
| kore-plugin-db-mysql | 5 | v0.4.1 v0.4.0 v0.3.2 v0.3.1 v0.3.0 | ==5，无需清理 |
| kore-plugin-file | 5 | v0.3.2 v0.3.1 v0.3.0 v0.2.1 v0.2.0 | ==5，无需清理 |
| kore-plugin-firewall | 5 | v0.2.6 v0.2.4 v0.2.3 v0.2.2 v0.2.1 | ==5，无需清理 |
| kore-plugin-process | 5 | v0.3.0 v0.2.2 v0.2.1 v0.2.0 v0.1.1 | ==5，无需清理 |
| kore-plugin-redis | 5 | v0.6.0 v0.5.0 v0.4.0 v0.3.0 v0.2.0 | ==5，无需清理 |
| kore-plugin-runtime-php | 5 | v0.2.2 v0.2.1 v0.2.0 v0.1.1 v0.1.0 | ==5，无需清理 |
| kore-plugin-site | 5 | v0.4.3 v0.4.2 v0.4.1 v0.4.0 v0.3.1 | ==5，无需清理 |
| kore-plugin-ssh-guard | 5 | v0.3.1 v0.3.0 v0.2.3 v0.2.2 v0.2.1 | ==5，无需清理 |
| kore-plugin-ssl | 5 | v0.6.0 v0.5.1 v0.5.0 v0.4.0 v0.3.0 | ==5，无需清理 |

## 3. 人工复核：12 个待删版本 × 三条件

索引版本取自 `../kore-plugins/index/plugins.json`（`plugins[].version`），preset pin 取自 `../kore-plugins/presets/*.json` 全部 8 个预设；GitHub 用 `gh api repos/kore-pl/<repo>/releases/tags/<tag>`。

| 仓库 | 待删版本 | ① 当前索引版本 | ② preset pin 版本 | ③ GitHub release | 结论 |
| --- | --- | --- | --- | --- | --- |
| kore-plugin-app-deploy | v0.2.0 | 0.3.1（≠） | 0.3.1（≠） | 200，1 asset | **删** |
| kore-plugin-container | v0.4.1 | 0.5.5（≠） | 0.5.5（≠） | 200，1 asset | **删** |
| kore-plugin-cron | v0.3.0 | 0.7.0（≠） | 0.7.0（≠） | 200，1 asset | **删** |
| kore-plugin-db-postgres | v0.2.1 | 0.3.4（≠） | 0.3.4（≠） | 200，1 asset | **删** |
| kore-plugin-dns | v0.2.0 | 0.4.2（≠） | 0.4.2（≠） | 200，1 asset | **删** |
| kore-plugin-echo | v0.1.0 | 0.1.5（≠） | 0.1.5（≠） | **404（release 不存在，仅 tag v0.1.0）** | **跳过** |
| kore-plugin-integrity | v0.3.1 | 0.5.1（≠） | 0.5.1（≠） | 200，1 asset | **删** |
| kore-plugin-logs | v0.4.0 | 0.5.2（≠） | 0.5.2（≠） | 200，1 asset | **删** |
| kore-plugin-monitor | v0.1.0 | 0.3.1（≠） | 0.3.1（≠） | 200，1 asset | **删** |
| kore-plugin-runtime-node | v0.2.0 | 0.2.5（≠） | 0.2.5（≠） | 200，1 asset | **删** |
| kore-plugin-runtime-python | v0.2.2 | 0.3.2（≠） | 0.3.2（≠） | 200，2 assets | **删** |
| kore-plugin-waf | v0.3.1 | 0.4.5（≠） | 0.4.5（≠） | 200，1 asset | **删** |

补充核对：

- 索引里 12 个插件的当前版本都**高于**对应待删版本（无「索引仍指向旧版」的仓库）；
- preset 8 个文件里，被复核插件只被 pin 到当前索引版本（上表第 4 列），**没有任何 preset 指向待删版本**；
- 11 个待删版本的 GitHub 资产 URL `curl -sIL` 全部 **200**（删除前实测，见 §6 命令 3）。

## 4. 真删执行记录（11 仓，逐仓）

命令：`scripts/gitee-release-prune.sh --repo pengtang1024/<repo>`（不带 `--dry-run` 即真删；脚本先删附件再删 release）

| 仓库 | 删除版本 | Gitee release id | 删除附件数 | 清理后数量 | exit |
| --- | --- | --- | --- | --- | --- |
| kore-plugin-app-deploy | v0.2.0 | 1356032 | 1 | 5 | 0 |
| kore-plugin-container | v0.4.1 | 1359684 | 1 | 5 | 0 |
| kore-plugin-cron | v0.3.0 | 1359682 | 1 | 5 | 0 |
| kore-plugin-db-postgres | v0.2.1 | 1356047 | 1 | 5 | 0 |
| kore-plugin-dns | v0.2.0 | 1359703 | 1 | 5 | 0 |
| kore-plugin-integrity | v0.3.1 | 1359704 | 1 | 5 | 0 |
| kore-plugin-logs | v0.4.0 | 1359716 | 1 | 5 | 0 |
| kore-plugin-monitor | v0.1.0 | 1356079 | 1 | 5 | 0 |
| kore-plugin-runtime-node | v0.2.0 | 1356093 | 1 | 5 | 0 |
| kore-plugin-runtime-python | v0.2.2 | 1359740 | 1 | 5 | 0 |
| kore-plugin-waf | v0.3.1 | 1359747 | 1 | 5 | 0 |

合计：**11 仓 / 11 个 release / 11 个附件**，11/11 exit 0，无 WARN。`echo` 未进入本轮执行。

## 5. 跳过项与遗留（必须跟）

**`kore-plugin-echo` v0.1.0 未删**，原因：人工复核第③条不成立——GitHub 上该仓库**只有 tag `v0.1.0`（`5f24028…`），没有对应 release**（GitHub release 从 v0.1.1 起才有）；按「任一条不满足 → 跳过并报告」执行跳过。因此 `echo` 在 Gitee 仍 **6 条**（v0.1.0–v0.1.5），是当前唯一超限仓。

后续（未在本轮做，因为要动 GitHub）二选一：

1. 在 GitHub 为 `echo` 补建 `v0.1.0` release（资产 `echo-0.1.0.tar.gz`）→ 再对 `echo` 跑一次 `--dry-run` 复核后真删；
2. 若判定 echo v0.1.0 无需保留，改 AGENTS.md / GITEE-MIRROR 的例外口径后再删（不建议：等于为凑数放宽策略）。

## 6. 删除后复核

### 6.1 Gitee release 数量（26 仓全量回读）

| 仓库 | 数量 | 备注 |
| --- | --- | --- |
| kore / kore-plugins | 0 / 0 | 无 release（符合预期） |
| kore-plugin-discover / terminal | 4 / 4 | ≤5 |
| 其余 10 个原本 ==5 的仓 | 5 | 未动作 |
| **11 个本轮修剪仓** | **5** | 全部 == `--keep 5` |
| kore-plugin-echo | **6** | 跳过项，见 §5 |

### 6.2 保留版本仍可下载 + sha 校验（55/55）

对 11 个修剪仓各 5 个保留版本：`curl -L` 下载 Gitee 资产 → `sha256sum` → 与 GitHub 同名资产 `digest` 比对。

```text
OK kore-plugin-app-deploy     v0.3.2 http=200 gitee=a3c7bfd540c4 github=a3c7bfd540c4
OK kore-plugin-app-deploy     v0.3.1 http=200 gitee=2fa0e99e667c github=2fa0e99e667c
OK kore-plugin-app-deploy     v0.3.0 http=200 gitee=f3fdb914f01a github=f3fdb914f01a
OK kore-plugin-app-deploy     v0.2.2 http=200 gitee=d64dca310fef github=d64dca310fef
OK kore-plugin-app-deploy     v0.2.1 http=200 gitee=473d0286a1d8 github=473d0286a1d8
OK kore-plugin-container      v0.5.5 http=200 gitee=5d467fc4583b github=5d467fc4583b
OK kore-plugin-container      v0.5.4 http=200 gitee=940d220b6ebb github=940d220b6ebb
OK kore-plugin-container      v0.5.2 http=200 gitee=975820ebfba9 github=975820ebfba9
OK kore-plugin-container      v0.5.1 http=200 gitee=8d1b586b05fe github=8d1b586b05fe
OK kore-plugin-container      v0.5.0 http=200 gitee=af1e67138b81 github=af1e67138b81
OK kore-plugin-cron           v0.7.0 http=200 gitee=23a58e0b82a4 github=23a58e0b82a4
OK kore-plugin-cron           v0.6.0 http=200 gitee=3bf24afcb4c2 github=3bf24afcb4c2
OK kore-plugin-cron           v0.5.0 http=200 gitee=25a7f55886cf github=25a7f55886cf
OK kore-plugin-cron           v0.4.1 http=200 gitee=1991002071ce github=1991002071ce
OK kore-plugin-cron           v0.4.0 http=200 gitee=d4a793551abb github=d4a793551abb
OK kore-plugin-db-postgres    v0.3.4 http=200 gitee=3f1e228b1028 github=3f1e228b1028
OK kore-plugin-db-postgres    v0.3.3 http=200 gitee=c881cec23e1c github=c881cec23e1c
OK kore-plugin-db-postgres    v0.3.2 http=200 gitee=aa045dfa2735 github=aa045dfa2735
OK kore-plugin-db-postgres    v0.3.1 http=200 gitee=6321caaa3ec5 github=6321caaa3ec5
OK kore-plugin-db-postgres    v0.3.0 http=200 gitee=0453c6080e5d github=0453c6080e5d
OK kore-plugin-dns            v0.4.2 http=200 gitee=5b6db686dd5c github=5b6db686dd5c
OK kore-plugin-dns            v0.4.0 http=200 gitee=4010651b6e92 github=4010651b6e92
OK kore-plugin-dns            v0.3.2 http=200 gitee=a2953453c0e7 github=a2953453c0e7
OK kore-plugin-dns            v0.3.1 http=200 gitee=ac95abff57bc github=ac95abff57bc
OK kore-plugin-dns            v0.3.0 http=200 gitee=78ecb27a5ef2 github=78ecb27a5ef2
OK kore-plugin-integrity      v0.5.1 http=200 gitee=22f9ec484904 github=22f9ec484904
OK kore-plugin-integrity      v0.5.0 http=200 gitee=474f414cc5e1 github=474f414cc5e1
OK kore-plugin-integrity      v0.4.0 http=200 gitee=4358320e002a github=4358320e002a
OK kore-plugin-integrity      v0.3.3 http=200 gitee=e55ca4bd44a0 github=e55ca4bd44a0
OK kore-plugin-integrity      v0.3.2 http=200 gitee=e6cf549b5d9b github=e6cf549b5d9b
OK kore-plugin-logs           v0.5.2 http=200 gitee=cb0ce582ff63 github=cb0ce582ff63
OK kore-plugin-logs           v0.5.1 http=200 gitee=17743259b146 github=17743259b146
OK kore-plugin-logs           v0.5.0 http=200 gitee=d34bf34dba28 github=d34bf34dba28
OK kore-plugin-logs           v0.4.2 http=200 gitee=6a210407e3b6 github=6a210407e3b6
OK kore-plugin-logs           v0.4.1 http=200 gitee=2e540c366679 github=2e540c366679
OK kore-plugin-monitor        v0.3.1 http=200 gitee=86fed8f21fdf github=86fed8f21fdf
OK kore-plugin-monitor        v0.3.0 http=200 gitee=db747aad1dc5 github=db747aad1dc5
OK kore-plugin-monitor        v0.2.1 http=200 gitee=fb153e56482c github=fb153e56482c
OK kore-plugin-monitor        v0.2.0 http=200 gitee=6cc7cac09428 github=6cc7cac09428
OK kore-plugin-monitor        v0.1.1 http=200 gitee=1adacbceff65 github=1adacbceff65
OK kore-plugin-runtime-node   v0.2.5 http=200 gitee=541fff7d1f15 github=541fff7d1f15
OK kore-plugin-runtime-node   v0.2.4 http=200 gitee=2033f3ed8519 github=2033f3ed8519
OK kore-plugin-runtime-node   v0.2.3 http=200 gitee=b62595f543cd github=b62595f543cd
OK kore-plugin-runtime-node   v0.2.2 http=200 gitee=9e99ef0e3c7c github=9e99ef0e3c7c
OK kore-plugin-runtime-node   v0.2.1 http=200 gitee=28ae6d6b997b github=28ae6d6b997b
OK kore-plugin-runtime-python v0.3.2 http=200 gitee=56348766fd39 github=56348766fd39
OK kore-plugin-runtime-python v0.3.1 http=200 gitee=f16abf6e6644 github=f16abf6e6644
OK kore-plugin-runtime-python v0.3.0 http=200 gitee=066d01c9ff2e github=066d01c9ff2e
OK kore-plugin-runtime-python v0.2.4 http=200 gitee=8565c6e0d210 github=8565c6e0d210
OK kore-plugin-runtime-python v0.2.3 http=200 gitee=f0341b3cfcf5 github=f0341b3cfcf5
OK kore-plugin-waf            v0.4.5 http=200 gitee=94680629192b github=94680629192b
OK kore-plugin-waf            v0.4.4 http=200 gitee=9db925059bd1 github=9db925059bd1
OK kore-plugin-waf            v0.4.3 http=200 gitee=b9ac6ff17ba1 github=b9ac6ff17ba1
OK kore-plugin-waf            v0.4.2 http=200 gitee=480dcc992916 github=480dcc992916
OK kore-plugin-waf            v0.4.1 http=200 gitee=201635abc29b github=201635abc29b
ALL_ASSET_CHECKS_OK=1
```

（sha 只展示前 12 位；脚本为**全 64 位字符串相等**判定，`ALL_ASSET_CHECKS_OK=1` 即 55/55 全等。本地 `dist/` 目录当前为空，故期望值取 GitHub 同名资产 `digest`——与 [GITEE-MIRROR.md](../../docs/GITEE-MIRROR.md) §3「Gitee 附件与 GitHub 同 sha256」同源。）

### 6.3 被删版本状态（Gitee 已消失 / GitHub 仍在）

| 仓库 | 版本 | Gitee release 列表 | Gitee 资产链接 | GitHub release |
| --- | --- | --- | --- | --- |
| kore-plugin-app-deploy | v0.2.0 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-container | v0.4.1 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-cron | v0.3.0 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-db-postgres | v0.2.1 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-dns | v0.2.0 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-integrity | v0.3.1 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-logs | v0.4.0 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-monitor | v0.1.0 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-runtime-node | v0.2.0 | 无该 tag | **404** | 200（1 asset） |
| kore-plugin-runtime-python | v0.2.2 | 无该 tag | **404** | 200（2 assets） |
| kore-plugin-waf | v0.3.1 | 无该 tag | **404** | 200（1 asset） |

> Gitee API 坑：`GET /repos/{owner}/{repo}/releases/tags/{tag}` 对**不存在**的 tag 也返回 **HTTP 200**，body 是 `null`。判断存在性必须看 body，不能只看状态码（本次据此改用「列表无该 tag + assets 404 + body null」三重判据）。

## 7. 复现命令（token 走环境变量，勿落盘）

```bash
export GITEE_TOKEN=***            # 来自 ~/.config/environment.d/10-api-tokens.conf，不写进仓库

# 1) 全量 dry-run（逐仓，26/26）
for d in kore kore-plugins kore-plugin-*; do
  bash scripts/gitee-release-prune.sh --dry-run --repo "pengtang1024/$d"
done

# 2) 真删（逐个待删仓，--keep 默认 5）
bash scripts/gitee-release-prune.sh --repo pengtang1024/kore-plugin-waf

# 3) 删除前 GitHub 存在性（人工复核第③条）
gh api repos/kore-pl/kore-plugin-waf/releases/tags/v0.3.1 --jq '.tag_name + " " + ((.assets|length)|tostring)'
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://github.com/kore-pl/kore-plugin-waf/releases/download/v0.3.1/waf-0.3.1.tar.gz

# 4) 删除后：数量 / 保留资产 200 + sha / 被删版本 404
curl -sS "https://gitee.com/api/v5/repos/pengtang1024/kore-plugin-waf/releases?access_token=$GITEE_TOKEN&per_page=100" | jq 'length'
curl -sSL -o /tmp/a.tgz -w '%{http_code}\n' \
  https://gitee.com/pengtang1024/kore-plugin-waf/releases/download/v0.4.5/waf-0.4.5.tar.gz && sha256sum /tmp/a.tgz
gh api repos/kore-pl/kore-plugin-waf/releases/tags/v0.4.5 --jq '.assets[] | .digest'
curl -sS "https://gitee.com/api/v5/repos/pengtang1024/kore-plugin-waf/releases/tags/v0.3.1?access_token=$GITEE_TOKEN"   # body 应为 null
```

## 8. 风险 / 边界声明

- **未动 GitHub / Gitea**：本轮所有写操作只走 Gitee API（删附件 + 删 release）；GitHub 侧只做读校验（`gh api` / `curl -sIL`）。
- **未动索引与预设**：`kore-plugins/index/plugins.json`、`versions.lock.json`、`presets/*.json` 未改；被删版本均不在其中（§3）。
- **不可逆性**：Gitee 侧 release 与附件已物理删除；恢复路径是 GitHub 全量 release（11/11 已确认 200）或按需重新上传。
- **`echo` 仍 6 条**：唯一未收敛项，原因与两条后续路径见 §5；不是脚本护栏失败，也不是漏跑。
