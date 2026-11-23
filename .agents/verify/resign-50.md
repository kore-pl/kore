[agent:release-cron-070]

# 第 50 把重签证据（cron 0.7.0 发版入索引）

- 日期：2026-11-24 03:03–03:15 +08:00 · 执行：release-cron-070 · 范围：`kore-plugin-cron`（dist/tag/release）+ `kore-plugins`（索引/账本/预设/重签）+ 本证据文件
- 判据：[resign-restart-free.md](./resign-restart-free.md) —— 「公钥常量不变 + 运行镜像 sha 不变」，**不使用 pid 判据**。

> **本把未执行 `make build`（`kore` 主壳）、未重启 `kored`。** 长期签名密钥（ADR-0025 方案 A）已就位
> （`~/.config/kore/signing/index-signing.seed`，0600），`IndexPublicKeyHex` 未变，因此二进制语义未变、
> 运行进程内存未变；`bin/kored` 的 sha 与 mtime 前后亦未变。

## 1. dist 位级复现（三个 sha 并列，全部相同）

`kore-plugin-cron` 的 `make dist`（G-16：`CGO_ENABLED=0` + `GOWORK=off` + `GOAMD64=v1` + `-trimpath` + `-s -w`；打包归一：`--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=...` + `gzip -9n`）：

| 次序 | 执行方式 | sha256 | size（实测） |
| --- | --- | --- | --- |
| A | 工作树 `make dist` 第 1 次 | `23a58e0b82a4d002b20d0af33ef81f0937549c361254d0080e7af5de7c3af1e5` | 1572337 |
| B | 工作树 `make dist` 第 2 次（幂等） | `23a58e0b82a4d002b20d0af33ef81f0937549c361254d0080e7af5de7c3af1e5` | 1572337 |
| C | `git archive HEAD` 干净树 `make dist` | `23a58e0b82a4d002b20d0af33ef81f0937549c361254d0080e7af5de7c3af1e5` | 1572337 |

- 干净树来源：`git archive HEAD | tar -x -C /tmp/cron-clean-070`（HEAD = 下面 §3 的 tag peeled commit，含 `size_bytes` 收口值）。
- **`size_bytes` 声明 vs 实测**：包内 `info.json.size_bytes` = **1572339**，包体实测 = **1572337**（偏差 −2，落在 Makefile 约定的 ±2 自指窗口内；**未为凑数改声明**）。
- 干净树验证目录用完即删，未留任何 git 状态。

## 2. 包内容核对

```text
$ tar -tzf dist/cron-0.7.0.tar.gz
info.json
bin/
bin/cron
SHA256SUMS
```

- 4 条成员 = 3 个文件 + `bin/` 目录条目；**无测试文件**（`grep -Ei 'test|_test'` 零命中，`tests/`、`*_test.go` 不进包）。
- 包内 `SHA256SUMS`：
  `14dcacd4908fbea0eabe8d629caab021061c8ad520f982d95885e699ec1c675a  info.json`
  `60c87dd58b736a2a0a2a2cda9128fbf375899a66a3752afe2e8494d517b46270  bin/cron`
- 包内 `info.json`：`"id":"cron"` / `"version":"0.7.0"` / `"size_bytes":1572339` / `"post_upgrade":"cron.migrate"`。

## 3. tag 与三端推送

- 发版 commit：`e2ead543552a11c8b3f9d1f224da3b49c7d4e94e`（`[agent:release-cron-070] chore(cron): dist size_bytes 收口（0.7.0 包体校准 1572339）`，父提交 `d67e5f775806bde039e6e2bc7560438b8c01039f`）。
- tag：annotated `v0.7.0`，tag 对象 `c45e03f57155e365d266720414dc70eeb5a53ec3`，**显式钉** `e2ead543552a11c8b3f9d1f224da3b49c7d4e94e`。
- `git rev-list v0.7.0..HEAD --count` = **0**（tag 之后无新提交）。

三端 `git ls-remote`（顺序：`origin` → `github` → `gitee`，三端均 exit 0）：

| 远端 | `refs/heads/main` | `refs/tags/v0.7.0`（tag 对象） | `refs/tags/v0.7.0^{}`（peeled） |
| --- | --- | --- | --- |
| origin（Gitea 权威源） | `e2ead54…d4e94e` | `c45e03f…a53ec3` | `e2ead54…d4e94e` |
| github | `e2ead54…d4e94e` | `c45e03f…a53ec3` | `e2ead54…d4e94e` |
| gitee | `e2ead54…d4e94e` | `c45e03f…a53ec3` | `e2ead54…d4e94e` |

## 4. 两端 release 与资产复核（`curl -L` 实测，未采信创建响应）

| 平台 | release | 资产 | HTTP | size（实测） | sha256 |
| --- | --- | --- | --- | --- | --- |
| GitHub | https://github.com/kore-pl/kore-plugin-cron/releases/tag/v0.7.0 | `cron-0.7.0.tar.gz` | **200** | 1572337 | `23a58e0b82a4d002b20d0af33ef81f0937549c361254d0080e7af5de7c3af1e5` |
| Gitee | https://gitee.com/pengtang1024/kore-plugin-cron/releases/tag/v0.7.0（release id `1360151`） | `cron-0.7.0.tar.gz` | **200** | 1572337 | `23a58e0b82a4d002b20d0af33ef81f0937549c361254d0080e7af5de7c3af1e5` |

- Gitee 建 release **显式带 `target_commitish`**（已知 400 坑）：创建 HTTP 201，回读 `target_commitish` = `e2ead543552a11c8b3f9d1f224da3b49c7d4e94e`（完整 sha，非分支名）。
- 两端下载字节 + sha256 与本地 `dist/cron-0.7.0.tar.gz` **逐字一致**。
- Gitee API 的 asset `size` 恒为 `null`（已知 API 缺陷），验收以**下载字节数 + sha256** 为准。

## 5. 索引变更（改前 → 改后）

`index/plugins.json` 的 cron 条目：

| 字段 | 改前 | 改后 |
| --- | --- | --- |
| `version` | `0.6.0` | **`0.7.0`** |
| `size_bytes` | `1572239` | **`1572337`**（release 资产实测值） |
| `sha256` | `3bf24afc…c2d7eae` | **`23a58e0b…7c3af1e5`** |
| `download_url` | `…/download/v0.6.0/cron-0.6.0.tar.gz` | **`…/download/v0.7.0/cron-0.7.0.tar.gz`** |

（`depth_level` / `lifecycle` / `requires_kore` / `depends_on` / `conflicts` / `scenario_tags` 未变。）

- `index/versions.lock.json`：cron 历史**仅追加** `0.7.0` → `23a58e0b…af1e5`，0.2.0–0.6.0 未删未改。
- **preset pin**：`presets/full.json` 的 `cron` `0.6.0` → `0.7.0`（其余 7 个预设未引用 cron，未改）。
- 重签（长期密钥，未带 `--generate`）：`bash scripts/sign-index.sh` exit 0。

| 文件 | 改前 sha256 | 改后 sha256 |
| --- | --- | --- |
| `index/plugins.json` | `9ed5dddcd11f869b62f9715ab0289f25e59fef2e7d451b47b9d32e72afd70415` | `09285aaec7a5e92757b848a1f815bc0d194ed0e8cb878d6d6617969aa77d20e6` |
| `index/plugins.json.sig` | `c547f064ddcca94c541318db9391daa2315a7e0f52e30cf92f9b06a1d8114502` | `8bcec9b6785b37f6ea241a854de62d4c5151bf46cff1af90ad5a60a02d9b722a` |

## 6. validate 正反例

| 用例 | 命令 | 结果 |
| --- | --- | --- |
| 原仓正向 | `bash scripts/validate-index.sh` | **exit 0** —— `[OK] schema …（24 条）` / `[OK] 版本单调递增 …（基线 24 条）` / `[OK] 预设引用可解析（47 条引用）` / `[OK] ed25519 签名验证通过（内置公钥）` / `[OK] 索引校验全部通过` |
| `/tmp` 篡改副本 | `cp -a` 后将 cron `size_bytes` 改为 `1572338` | **exit 1** —— `[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）` |
| 原仓复验（副本已删） | 重跑 | **exit 0** —— `[OK] 索引校验全部通过` |

## 7. 全量资产复核（24 条）

按 `index/plugins.json` 逐条 `curl -sSL --max-time 180` 下载并比对 `sha256` + `size_bytes`（实测）：

```text
[OK ] cron@0.7.0 http=200 size=1572337/1572337 sha=23a58e0b82a4/23a58e0b82a4
...
ENTRIES_CHECKED=24
BAD_COUNT=0
```

24 条全 `[OK ]`、无 `[BAD]`；下载暂存目录用完即删。

## 8. 公钥与运行镜像（签名前后逐字相同，未重启）

```text
$ grep -oE '^PUB_HEX="[0-9a-f]{64}"' kore-plugins/scripts/validate-index.sh
PUB_HEX="3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 签名前 / 签名后相同

$ grep -oE 'IndexPublicKeyHex = "[0-9a-f]{64}"' kore/internal/core/market/verify.go
IndexPublicKeyHex = "3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 签名前 / 签名后相同
```

`bin/kored`（未重建、未重启）：

| 项 | 签名前 | 签名后 |
| --- | --- | --- |
| mtime | `2026-11-24 01:45:22.444934926 +0800` | `2026-11-24 01:45:22.444934926 +0800` |
| size | 10494114 | 10494114 |
| sha256 | `ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6` | 同左 |
| 主实例 `/proc/3409175/exe` sha256 | `ab5627af…f41b6` | 同左 |

**索引热加载，主实例无需重启**：`internal/core/market/market.go` 的 `readTrusted` / `readVerified` 是「**现场重读 + 验签**」（`readIndexFiles` 每次 `os.ReadFile` `index_dir/plugins.json` 与 `.sig`，无进程级缓存）；`IndexPublicKeyHex` 为编译期常量且本次未变，`.kore-local.yaml` 的 `index_dir` 仍为 `kore-plugins/index`（未改运行态配置）。因此新签名落在磁盘即对下一次请求生效，**无需 `make build`、无需重启 `kored`**。

## 9. 变更清单

- `kore-plugin-cron`（精确路径，已提交未 push）：
  `info.json`（仅 `size_bytes` 1572238 → 1572339，dist 收口）→ commit `e2ead543552a11c8b3f9d1f224da3b49c7d4e94e`；
  tag `v0.7.0`（对象 `c45e03f5`）已推三端；两端 release 已建。未提交 untracked 的历史遗留 `RELEASE-EVIDENCE.md`（0.4.0 时代文件，非本把产物）。
- `kore-plugins`（精确路径，已提交未 push）：`index/plugins.json`、`index/plugins.json.sig`、
  `index/versions.lock.json`、`presets/full.json` → commit `c53ec8ded47707f276e537eefe69471ed6fd13af`。
- `kore`（精确路径，仅本文件，已提交未 push）：`.agents/verify/resign-50.md` → 即本文件所在提交（自指，不写死 sha）。
- 未触碰：`kore` 的 `cmd/**` / `internal/**` / `web/**` / `Makefile`；未改动主实例运行态配置；未打印任何 token 明文。

## 10. 未验证项 / 已知偏差

- 商店 API 版本回读（`GET /api/v1/store/plugins`）需管理登录，本轮未取证「商店显示 cron 0.7.0」；
  按任务口径**不重启 `kored`**，热加载依据为 §8 的代码路径（现场重读），非 API 实测。
- G-15 跨仓变更集未登记到 `.agents/BOARD.md`：任务卡限定「只改索引仓 + kore 仓一处证据文件」，
  由 lead 决定是否补录。
- 本轮未跑 `make check`（未改 `kore` 代码，仅证据文件；验收口径未要求）。
