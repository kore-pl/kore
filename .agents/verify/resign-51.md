[agent:resign-51]

# 第 51 把重签证据（echo / integrity / dns / runtime-node / runtime-python / db-postgres / waf / container）

- 日期：2026-11-24 03:43–03:56 +08:00 · 执行：resign-51 · 范围：索引仓 `kore-plugins`（索引 / `.sig` / `versions.lock.json` / 5 个 preset pin）+ 本证据文件 + `scripts/depth-level-pending.txt` 清零
- 判据：[resign-restart-free.md](./resign-restart-free.md) —— 「公钥常量不变 + 运行镜像 sha 不变」，**不使用 pid 判据**（pid 仅作定位线索记录）。
- 背景裁决：[ADR-0045](../../docs/DECISIONS/0045-depth-level-convergence.md)、[depth-level-decision.md](./depth-level-decision.md)（8/8 判 `basic`，索引值本就正确）。

> **本把未执行 `make build`、未重启 `kored`。** 长期签名密钥（ADR-0025 方案 A）已就位
> （`~/.config/kore/signing/index-signing.seed`，0600，65 字节），`IndexPublicKeyHex` 未变，
> 故二进制语义未变、运行进程内存未变；`bin/kored` 的 sha 与 mtime（03:33:50，早于本把开工）前后亦未变。

## 1. release 资产复核（8 条全做，逐字比对，全部 200）

本把独立 `curl -L` 复核，不采信发布单声明值：

| 插件 | 版本 | HTTP | size（实测） | 与派发单 | sha256（实测） |
| --- | --- | --- | --- | --- | --- |
| echo | 0.1.5 | 200 | 1353316 | 一致 | `0a2153ddb1f95c7b39f24f5876cf746aa46700ff40e5b70617b3dfd88d88a806` |
| integrity | 0.5.1 | 200 | 1468288 | 一致 | `22f9ec4849045c890db547c042a9c6d78d763071664fd94b89a4aac560b4f8e3` |
| dns | 0.4.2 | 200 | 1657730 | 一致 | `5b6db686dd5cd5ee42434a2365c5b4b14f3ee0892bc01ef4c64a5ee5f29f2bdd` |
| runtime-node | 0.2.5 | 200 | 1502824 | 一致 | `541fff7d1f1595c99c82bc4dc3008bc8b815bde369da068cd8403244d5243da7` |
| runtime-python | 0.3.2 | 200 | 1550366 | 一致 | `56348766fd3962d0ca8aacfc1caded7f54af446d1572ac360e7347d03350786e` |
| db-postgres | 0.3.4 | 200 | 1569471 | 一致 | `3f1e228b1028b4de2ee55638ed38288bda48e525258d23cac13dc5f4d0487855` |
| waf | 0.4.5 | 200 | 2938640 | 一致 | `94680629192b3f000496a9b6c713e8de66ca8691f9958e941262dff953b934bd` |
| container | 0.5.5 | 200 | 1530285 | 一致 | `5d467fc4583b2627e43cf6df0e0a04aac1f3c5fd0fb6157f3b6f252692665e9c` |

- **8/8 HTTP 200，sha256 与 size 与派发单逐字一致，无偏差。**
- 包内 `info.json.version` 8/8 等于 tag；`depth_level` 8/8 = `basic`（与索引现值一致，本把不改该字段）。
- 包内 `info.json.size_bytes` 与实测差异（自指估算窗口内，索引一律记实测）：echo 1353315/1353316、integrity 1468286/1468288、dns 1657730/1657730、runtime-node 1502824/1502824、runtime-python 1550368/1550366、db-postgres 1569469/1569471、waf 2938642/2938640、container 1530285/1530285。
- 本地 `kore-plugin-<id>/dist/<id>-<ver>.tar.gz` 与远端 release 资产 **8/8 sha+size 逐字一致**（发布物同源，无 `DIST_SHA_DIFF`）。
- tag peeled（`git ls-remote origin refs/tags/<tag>^{}`）：echo `c158b827` / integrity `2cf3eeac` / dns `d17ff1c2` / runtime-node `98d53826` / runtime-python `26565638` / db-postgres `77ae1d8f` / waf `c6ac3bb0` / container `fb6280bd`。

## 2. 索引旧值 → 新值（8 条：version / sha256 / size / download_url）

| 插件 | 旧版本（索引实测） | 新版本 | 旧 size → 新 size | download_url |
| --- | --- | --- | --- | --- |
| echo | 0.1.4 | **0.1.5** | 1353310 → 1353316 | `.../v0.1.5/echo-0.1.5.tar.gz` |
| integrity | 0.5.0 | **0.5.1** | 1468279 → 1468288 | `.../v0.5.1/integrity-0.5.1.tar.gz` |
| dns | **0.4.0** | **0.4.2** | 1652080 → 1657730 | `.../v0.4.2/dns-0.4.2.tar.gz` |
| runtime-node | 0.2.4 | **0.2.5** | 1502833 → 1502824 | `.../v0.2.5/runtime-node-0.2.5.tar.gz` |
| runtime-python | 0.3.1 | **0.3.2** | 1550361 → 1550366 | `.../v0.3.2/runtime-python-0.3.2.tar.gz` |
| db-postgres | 0.3.3 | **0.3.4** | 1569480 → 1569471 | `.../v0.3.4/db-postgres-0.3.4.tar.gz` |
| waf | 0.4.4 | **0.4.5** | 2938643 → 2938640 | `.../v0.4.5/waf-0.4.5.tar.gz` |
| container | 0.5.4 | **0.5.5** | 1530283 → 1530285 | `.../v0.5.5/container-0.5.5.tar.gz` |

- `download_url` 前缀统一 `https://github.com/kore-pl/kore-plugin-<id>/releases/download/`。
- `depth_level` 8 条均为 `basic`：索引现值已是 `basic`，**按约定不改**；本把改的只有 version / sha256 / size_bytes / download_url。
- `dns` 特例：索引停在 **0.4.0**，0.4.1 只 bump 未发版（无 release 资产），故账本从 0.4.0 **直接追加 0.4.2**；`validate-index.sh` 的「最新版本 == 索引版本」判据通过，未插入不存在的 0.4.1。
- `versions.lock.json`：8 个 id 各**追加 1 条**（共 8 条），历史条目未删未改。
- preset pin 同步（精确 pin，共 15 处引用）：`presets/db-only.json` 1（db-postgres）、`presets/dev.json` 3（echo / runtime-node / runtime-python）、`presets/full.json` 8、`presets/gateway.json` 1（dns）、`presets/security.json` 2（integrity / waf）。

## 3. `validate-index.sh` 正反例（原仓 / 篡改副本 / 复验）

```text
A) 原仓改后            -> EXIT 0
   [OK] schema / 必填字段 / id 唯一 / sha256 格式通过（24 条）
   [OK] 版本单调递增 / 同 id@version 唯一 sha 校验通过（基线 24 条）
   [OK] 预设引用可解析（占位/已校验 47 条引用）
   [OK] ed25519 签名验证通过（内置公钥）
   [OK] 索引校验全部通过

B) /tmp/idx51val 副本，dns version 篡改为 0.4.9 -> EXIT 1
   [FAIL] 索引 dns@0.4.9 sha=5b6db686dd5c 与基线最新 dns@0.4.2 sha=5b6db686dd5c 不一致：
          改包必须 bump 版本并追加基线，禁止同版本换 sha

C) 原仓复验            -> EXIT 0（同上全 OK）
```

补充反例（只改内容、账本仍一致，验证签名这道闸真的挡得住）：`/tmp/idx51sig` 副本把 waf 的 `name` 改为「WAF 被篡改」→ schema/账本/预设引用全 OK，**`[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）`，EXIT 1**。

## 4. 全量资产检查（索引 24 条，逐条 `curl -L` 复核）

- 结论：`BAD_COUNT=0`（24/24 HTTP 200，size 与 sha256 与索引记录逐字一致）。
- 检查项 = 索引 `size_bytes` / `sha256` 与实测包体比对，不只看 HTTP 码。
- 覆盖 24 个 id：app-deploy 0.3.1 / backup 0.4.2 / container 0.5.5 / cron 0.7.0 / db-mysql 0.4.1 / db-postgres 0.3.4 / discover 0.3.1 / dns 0.4.2 / echo 0.1.5 / file 0.3.2 / firewall 0.2.6 / integrity 0.5.1 / logs 0.5.1 / monitor 0.3.0 / process 0.3.0 / redis 0.6.0 / runtime-node 0.2.5 / runtime-php 0.2.2 / runtime-python 0.3.2 / site 0.4.3 / ssh-guard 0.3.1 / ssl 0.6.0 / terminal 0.2.1 / waf 0.4.5。

## 5. 公钥与运行镜像（未 build / 未重启）

| 项 | 签名前 | 签名后 |
| --- | --- | --- |
| `internal/core/market/verify.go:16` `IndexPublicKeyHex` | `3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0` | 同左（未变） |
| `validate-index.sh` 内置 `PUB_HEX` | 同左 | 同左（未变，16/17 段「公钥单一真源」OK） |
| 运行中 `/proc/809422/exe` sha256 | `6c4b503ea6aa72a1af2e95617c85fd90e869fe57dd5fcc845633f760605e69ba` | 同左（未变） |
| `bin/kored` 文件 sha256 / mtime | `6c4b503e…` / 03:33:50 | 同左（未重建） |

## 6. `presets-check` 前后（本次最关键的验收项）

**改前（8 warn，全部为「清单陈旧条目」）**：

```text
[WARN] 待裁决清单陈旧条目: container 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[WARN] 待裁决清单陈旧条目: db-postgres 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[WARN] 待裁决清单陈旧条目: dns 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[WARN] 待裁决清单陈旧条目: echo 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[WARN] 待裁决清单陈旧条目: integrity 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[WARN] 待裁决清单陈旧条目: runtime-node 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[WARN] 待裁决清单陈旧条目: runtime-python 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[WARN] 待裁决清单陈旧条目: waf 的索引与仓库已一致 —— 裁决已落定，请从 depth-level-pending.txt 移除
[INFO] depth_level 核对: 24 个已收录插件 · 不一致 0 条（已知待裁决 0 / 新增 0）
presets-check: 8 pass, 8 warn, 0 fail
```

**改后（0 warn）**：清空 `scripts/depth-level-pending.txt` 的 8 条存量 id（裁决已在 [depth-level-decision.md](./depth-level-decision.md) 落定，索引与仓库 8/8 一致），保留清单头注释并附清零说明。

```text
[INFO] depth_level 核对: 24 个已收录插件 · 不一致 0 条（已知待裁决 0 / 新增 0）
[OK] db-only.json: 5 个引用 · 常驻 0 个 = 0 MiB · 包体积 7.70 MiB
[OK] dev.json: 3 个引用 · 常驻 0 个 = 0 MiB · 包体积 4.20 MiB
[OK] full.json: 21 个引用 · 常驻 1 个 = 8 MiB · 包体积 36.46 MiB
[OK] gateway.json: 4 个引用 · 常驻 1 个 = 8 MiB · 包体积 8.84 MiB
[OK] minimal.json: 0 个引用 · 常驻 0 个 = 0 MiB · 包体积 0.00 MiB
[OK] security.json: 5 个引用 · 常驻 0 个 = 0 MiB · 包体积 12.64 MiB
[OK] web-lite.json: 3 个引用 · 常驻 1 个 = 8 MiB · 包体积 5.99 MiB
[OK] web-pro.json: 6 个引用 · 常驻 1 个 = 8 MiB · 包体积 10.30 MiB
presets-check: 8 pass, 0 warn, 0 fail
```

> 判据未被放宽：清的是「已核实一致」的存量豁免行（本清单自述「残留条目会被门禁 WARN 提示移除」），
> 不是给新不一致开绿灯——新增不一致仍 `FAIL`。

## 7. `make check`（17 段）

- **16/17 段通过，1 段失败且与本把无关**：`1/17 docs-check` 报 `相对链接断链 1 条`。
- 断链原文：`.agents/verify/depth-level-decision.md → ../DECISIONS/0045-depth-level-convergence.md`。
  该文件由 `957a26d`（[agent:depth-level-decide]，2026-11-24 03:32:01）新增，**早于本把开工 03:43**；
  同文件其它链接写作 `../../docs/...` 均可达，唯该条少了 `../../docs/` 前缀（目标
  `docs/DECISIONS/0045-depth-level-convergence.md` 确实存在）。
- 本把**未代改他人已提交文件**（写域纪律）。在 `git archive HEAD` 的 `/tmp` 副本上把该链接一字修正后，
  `docs-check` 实测 `5 pass, 1 warn, 0 fail` → 证明唯一 FAIL 就是这条路径笔误，修好即 17/17。
- 其余 16 段关键项：2/17 依赖白名单+兼容基线 OK、4/17 repo-check OK、9/17 case-check OK（4 条 URL 大写为既有 WARN）、
  10/17 前端首屏 65213 B ≤ 307200 B OK、12/17 secret-check 0 FAIL、13/17 25 仓九件套 OK、
  14/17 store-check 24 仓 OK、15/17 presets-check 8 pass / 0 warn / 0 fail、16/17 公钥单一真源 OK、
  17/17 交叉编译五目标全通过（1732ms）。

## 8. 提交

- `kore-plugins`：单提交，精确路径 `index/plugins.json`、`index/plugins.json.sig`、`index/versions.lock.json`、`presets/{db-only,dev,full,gateway,security}.json`。
- `kore`：单提交，精确路径 `scripts/depth-level-pending.txt`、`.agents/verify/resign-51.md`。
- **均未 push**；未执行 `make build`、未重启 `kored`；两仓工作树其它人的改动未纳入本把提交。
