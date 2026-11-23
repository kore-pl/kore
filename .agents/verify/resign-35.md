# 第三十五次重签（8 条版本 + URL 全量切 kore-pl）

- 日期：2026-11-23 15:25+08:00 · 执行：kore-verify-privilege（接手 release-r5 半成品）
- 第 35 把公钥：`e03ea622a1a9ce3aee111945eb5c64a90798aef64533ac1aaccf4ef524f83ed5`
- 起因：release-r5 只把索引 24 条 URL 切到 `github.com/kore-pl/...` 就停止（版本仍旧、签名未做），`validate-index` 失败 → 8787 商店 401 持续约 4 分钟。

## 1. 8 条版本 / sha256 / size（按 GitHub kore-pl release 资产实测）

```text
container      0.4.1  7054307e476aa442bf8cdc4168c254d537a9a7482f5e10ea4a09dfb7ef57930b  1522077
db-postgres    0.3.1  6321caaa3ec59b99471caf72778444a48c516d652e50b1b6ce0aee7824c7813a  1563620
dns            0.3.1  ac95abff57bc3ff11b175f337dd2f1d6cb9b9fb33f517b03b5bd8c0e6812de7f  1638776
integrity      0.3.2  e6cf549b5d9b1c2f61f1df09d4abd5e8cc5a6225937cb7c69c350d08b91a6904  1463231
runtime-node   0.2.3  b62595f543cd60db3027d8aa42315fc5167c800afc774fd25fac5472a9ddbc57  1502833
runtime-python 0.2.3  f0341b3cfcf588cb5fb48c8e49a3fb8365f6a00c6cfa947cfbd10a1f00fe0f38  1534440
ssh-guard      0.2.3  50a4035ce1511da3443c738aab1b57c86a8295f3bf659b4c55b5e45b47be929a  2831640
waf            0.3.1  fbaba38049ff42052fc991f7a4affbd5cc22bf588b8690d13ce5f2bd0152f2b4  2915823
```

- 8/8 `curl -L` HTTP 200，sha256 与 size 均来自实际下载文件（非缩写）。
- 24 条 `download_url` 全部为 `https://github.com/kore-pl/kore-plugin-<id>/...`；`pengtang1024` 残留 0 条。

## 2. 签名与校验

- 生成 ed25519 密钥对（`openssl genpkey`，seed 仅落 `/tmp`、`umask 077`）。
- `KORE_INDEX_KEY=<seed> bash scripts/sign-index.sh` → `[OK] 已签名`，exit 0。
- 公钥两端同步（逐字相同）：`scripts/validate-index.sh` 的 `PUB_HEX` 与 `kore/internal/core/market/verify.go` 的 `IndexPublicKeyHex`。
- `bash scripts/validate-index.sh` → **exit 0**（schema 24 / 基线 24 / 预设 47 / ed25519 通过）。
- 篡改反例：在 `/tmp` 副本改 1 字符 → **exit 1**（`[FAIL] ed25519 签名验证失败`）；原仓复验 **exit 0**。
- 私钥用后立即 `shred -u`：`/tmp/kore-index-priv-35.pem`、`/tmp/kore-index-35.der`、`/tmp/kore-seed-35.txt` 均 `No such file`。

## 3. 账本与预设

- `index/versions.lock.json`：8 条追加（各插件最后一条即新版本 + 新 sha），基线仍 24 个插件。
- `presets/*.json`：pin 更新 15 处（db-only 1 / dev 2 / full 8 / gateway 1 / security 3），均指向新版本。
- `make presets-check` 目标在本仓 Makefile 中不存在（docs 标注"M2 落地"），等效校验由 `validate-index.sh` 的「预设引用可解析（47 条引用）」覆盖并通过。

## 4. 产物哈希与提交

```text
index/plugins.json     15e7b12ed9fc544f23ac6169c3bceafb756c2b108ca1398d20387c14ccd95a43
index/plugins.json.sig a755353d29d48fa2e3e252e58685aa18a1d097c9a7b096806e6cde9740c32fc9
kore-plugins commit    f586c0e569002a4211f32491c9bd4173dfcc56fd
  标题：chore(release): 第三十五次重签 + 8 条版本入索引（container 0.4.1/…/waf 0.3.1，URL 全量切 kore-pl）
  范围：index/plugins.json · index/plugins.json.sig · index/versions.lock.json · scripts/validate-index.sh · presets/{db-only,dev,full,gateway,security}.json
```

三端推送均成功且回读一致：GitHub `origin`（kore-pl）、gitee（pengtang1024，未迁移）、Gitea（`gitea.iouf.cn/kore-pl`）均为 `f586c0e`。

## 5. 内核与主实例

- `kore/internal/core/market/verify.go`：`IndexPublicKeyHex` = 第 35 把；`make build` exit 0。
- 闸门：`strings bin/kored | grep -c e03ea622` = **1**；`grep -c 3e5333bf` = **0**（第 34 把已清零）。
- 重启主实例（带齐 4 个 `KORE_*`）：PID `1780808 → 2099399`，`15:25:37 kore ready`，`healthz=200`。
- 商店复核：`GET /api/v1/store/plugins` **HTTP 200**、24 条、与索引 `mismatch={}`；抽查 container 0.4.1 / waf 0.3.1 / integrity 0.3.2 / ssh-guard 0.2.3 全对；`paths.index_dir` 仍为 `kore-plugins/index`。
- 401 窗口在重启后关闭。

## 6. 沿革（32 → 35）

- 第 32 把：`37c65e8a…`，12:44 提前 shred（scope 扩张后无法补签，成为流程教训：签名前先确认清单完整）。
- 第 33 把：`3a87e3a5…`，13:05 生成、同钥补 terminal 0.2.0 签满 12 条。
- 第 34 把：`3e5333bf…`，14:0x 收口 16 条版本。
- 第 35 把（本次）：`e03ea622…`，URL 全量切 kore-pl + 8 条版本 + 24 条一次性重签；私钥用后即毁。
- 教训沿用：密钥生命周期按"生成 → 签完 → 立即 shred"执行；本次签名前已先完成 8 条资产测量与索引更新，避免二次补签。
