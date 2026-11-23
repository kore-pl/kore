[agent:resign-49]

# 第 49 把重签证据（integrity 0.5.0 / cron 0.6.0）

- 日期：2026-11-24 02:39–02:44 +08:00 · 执行：resign-49 · 范围：索引仓 `kore-plugins`（重签）+ 本证据文件
- 判据：[resign-restart-free.md](./resign-restart-free.md) —— 「公钥常量不变 + 运行镜像 sha 不变」，**不使用 pid 判据**。

> **本把未执行 `make build`、未重启 `kored`。** 长期签名密钥（ADR-0025 方案 A）已就位
> （`~/.config/kore/signing/index-signing.seed`，0600），`IndexPublicKeyHex` 未变，
> 因此二进制语义未变、运行进程内存未变；`bin/kored` 的 sha 与 mtime 前后亦未变。

## 1. release 资产复核（逐字比对，全部 200）

`release-batch9` 由上游发布，本把独立复核（未采信发布单声明值）：

| 插件 | 版本 | HTTP | size（实测） | sha256 |
| --- | --- | --- | --- | --- |
| integrity | 0.5.0 | 200 | 1468279 | `474f414cc5e1b2fb4f52d098960d9321800557371591c9f913418dea8bb4baa3` |
| cron | 0.6.0 | 200 | 1572239 | `3bf24afcb4c2abc44a7341952cf1fa8a0ab87ef8bb4d2822316f938e6c2d7eae` |

- 与派发单声明值（sha256 + size）**逐字一致，无偏差**。
- 本地 `kore-plugin-{integrity,cron}/dist/` 同版本产物 sha/size 与远端资产**逐字一致**
  （`474f414c…` / 1468279、`3bf24afc…` / 1572239）→ 发布物与索引两端同源。
- Gitee 镜像独立落盘复核：两条 URL 均 **HTTP 200**，sha/size 与上表逐字一致。
- tag peeled（`git ls-remote`）：integrity `v0.5.0^{}` = `bee9324c7fdad1023d5461efd436da5df4926501`；
  cron `v0.6.0^{}` = `6efaaa38377b53080b6148183018107811cd9e2e`，与派发单一致。
- 包内 `info.json.size_bytes`：integrity 声明 1468278 / 实测 1468279（+1）；cron 声明 1572238 / 实测 1572239（+1），
  均在已知 ±2 自指窗口内；**索引 `size_bytes` 一律记实测值**。

## 2. 索引旧版本号（以 `index/plugins.json` 实际值为准）

| 插件 | 索引旧值 | 新值 | 备注 |
| --- | --- | --- | --- |
| integrity | **0.4.0** | 0.5.0 | 连续递增；0.4.0 及更早版本仍保留在 lock 历史 |
| cron | **0.5.0** | 0.6.0 | 连续递增；0.5.0 仍在 lock 历史 |

`versions.lock.json` 仅追加 2 条（integrity 0.5.0、cron 0.6.0），历史未删、未改。

### preset pin 同步

| 文件 | 同步项 |
| --- | --- |
| `presets/full.json` | `integrity` 0.4.0 → 0.5.0、`cron` 0.5.0 → 0.6.0 |
| `presets/security.json` | `integrity` 0.4.0 → 0.5.0 |

其余 6 个预设未引用这两插件（`grep -rn 'integrity\|cron' presets/` 仅此两文件命中），未改。

## 3. 公钥常量（签名前后逐字相同）

```text
$ grep -oE '^PUB_HEX="[0-9a-f]{64}"' kore-plugins/scripts/validate-index.sh
PUB_HEX="3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 签名前
PUB_HEX="3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 签名后

$ grep -oE 'IndexPublicKeyHex = "[0-9a-f]{64}"' kore/internal/core/market/verify.go
IndexPublicKeyHex = "3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 前后相同
```

两处同源一致（`make check` 第 16/17 段公钥单一真源 `[OK]`）。

## 4. 运行镜像 sha（签名前后逐字相同，未重启）

`/proc/<pid>/exe` sha256 对 8787 主实例取样（判据是镜像，不是 pid）：

| pid | 用途 | 签名前 | 签名后 |
| --- | --- | --- | --- |
| 3409175 | 主实例（`bin/kored serve --config .kore-local.yaml`） | `ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6` | `ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6` |

`bin/kored` 磁盘文件 sha 前后同为 `ab5627af…f41b6`、size 10494114、mtime 仍为
`2026-11-24 01:45:22`（未重建；`make check` 的 17/17 交叉编译走临时产物，未覆盖 `bin/kored`）。

## 5. 重签与验签

```text
$ cd kore-plugins && bash scripts/sign-index.sh        # 长期密钥，未带 --generate
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）：index/plugins.json → index/plugins.json.sig
sign_exit=0
```

| 文件 | 签名前 sha256 | 签名后 sha256 |
| --- | --- | --- |
| `index/plugins.json` | `9ed5dddcd11f869b62f9715ab0289f25e59fef2e7d451b47b9d32e72afd70415` | `9ed5dddcd11f869b62f9715ab0289f25e59fef2e7d451b47b9d32e72afd70415` |
| `index/plugins.json.sig` | `ccf2ad284ad4d3ad5a6720fb1238f04103a6ca32f9a9ea9e1f60836756779d0a` | `c547f064ddcca94c541318db9391daa2315a7e0f52e30cf92f9b06a1d8114502` |

`validate-index.sh` 正反例（副本在 `/tmp/resign49-tamper`，验证后已删除）：

| 用例 | 命令 | 结果 |
| --- | --- | --- |
| 原仓正向 | `bash scripts/validate-index.sh` | **exit 0**，`[OK] ed25519 签名验证通过（内置公钥）` / `[OK] 索引校验全部通过` |
| `/tmp` 篡改副本 | `integrity.size_bytes += 1`（1468280）后验签 | **exit 1**，`[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）` |
| 原仓复验 | 删除副本后重跑 | **exit 0**，`[OK] 索引校验全部通过` |

## 6. 全量资产复核（24 条）

按 `index/plugins.json` 逐条 `curl -sSL --max-time 180` 下载并比对 `sha256` + `size_bytes`（实测值）：

```text
ENTRIES_CHECKED=24
BAD_COUNT=0
```

（逐条打印 `[OK ] <id>@<ver> http=200 size=… sha=…`，无 `[BAD]` 行；下载暂存 /tmp 单文件用完即删。）

## 7. 门禁

```text
$ cd kore && make check
[RUN ] 1/17 docs-check
...
[RUN ] 15/17 presets-check（G-18 … G-20 …）
presets-check: 8 pass, 8 warn, 0 fail
[RUN ] 16/17 公钥单一真源
[OK] 两端公钥一致：…3e461a07…2df1c0
[RUN ] 17/17 交叉编译（G-16 阻断级…）
[OK] 全仓交叉编译五目标全通过（exit 0，耗时 1736ms）
[OK] 门禁全部通过
make_check_exit=0
```

- 17/17 全绿、`[FAIL]` 计数 0；无因他人在途改动致红的段落。
- 第 15 段 8 条 WARN = `scripts/depth-level-pending.txt` 登记的存量待裁决（含 integrity，见 §9），与上一把同集合、无用例新增。
- 索引侧 `validate-index.sh`：schema 24 条 / 版本账本 24 条 / 预设引用 47 条 / 验签全过（exit 0）。

## 8. 变更清单

- `kore-plugins`（精确路径，已提交未 push）：`index/plugins.json`、`index/plugins.json.sig`、
  `index/versions.lock.json`、`presets/full.json`、`presets/security.json`
  → commit `d7a4156f0cd3dd46c1931204bf2efe2a2e43904e`。
- `kore`（精确路径，仅本文件，已提交未 push）：`.agents/verify/resign-49.md`
  → commit 即本文件所在提交（自指，不写死 sha）。
- 未触碰：插件源码 / `cmd/**` / `internal/**` / `Makefile` / `web/**`；未触碰他人在这两个仓库的
  在途改动；**未改动主实例运行态配置**（`.kore-local.yaml` 的 `index_dir` 仍指向 `kore-plugins/index`）。

## 9. 未验证项 / 已知偏差

- **integrity 的 `depth_level` 仍为 `basic`（未改）**：其仓库 `info.json` 自 0.3.3 起声明 `production`，
  属 `kore/scripts/depth-level-pending.txt` 登记的产品待裁决项（WARN，不阻断）。本把只做版本入索引，
  **不越权替产品裁决等级**，故保持不变；`make check` 第 15 段如实报该条 WARN。
- 商店 API 版本回读（`GET /api/v1/store/plugins`）需管理登录，本轮未取证「商店显示新版本」；
  且按任务口径**不重启 `kored`**，运行中进程对磁盘索引的生效时机未验证（索引文件已签好，
  下次正常 reload / 重启即读新值）。
- G-15 跨仓变更集未登记到 `.agents/BOARD.md`：任务卡限定「只改索引仓 + kore 仓一处证据文件」，
  由 lead 决定是否补录。
