# 第四十次重签（dns 0.3.2 / runtime-node 0.2.4 / runtime-python 0.2.4 / site 0.4.2 / file 0.3.2 五条入索引）

- 日期：2026-11-23 19:48–19:58+08:00 · 执行：kore-verify-privilege
- 第 40 把公钥：`8b4fe19ffcf7a717a038db657ccf40625aa52f42f7298427d1e5b72a6bac7a44`
- 起因：5 个插件已发版并上传 release 资产，索引仍停在上一版。

## 1. 五条资产（实测）

```text
dns            0.3.2  sha256=a2953453c0e700bcbe1c01fb34589048ebaeb847f6fa290cae27f7ad49b12a47  size=1638782
runtime-node   0.2.4  sha256=2033f3ed8519bb567ef306e7e3cfa4d6aefe808401454c569b14bb4f8e44f7bb  size=1502833
runtime-python 0.2.4  sha256=8565c6e0d2100b30c5b223d1c0165f2b41b56ec3c7c7ecc1ea4ae5c4867e3604  size=1534448
site           0.4.2  sha256=a467c9dec113fa71fb1efa91ffaf72cc918209efe8934d61447b25615766dde5  size=1610176
file           0.3.2  sha256=e4079c3c9382b4561045b0f8e246bf45448a024bc81f6c37e19232913efa5ea5  size=1695042
五条 curl 均 HTTP 200，sha256/size 与给定值逐字一致。
```

## 2. 第 40 把（只改五条）

- `index/plugins.json`：五条 version/sha256/size_bytes/download_url 同步（site 0.4.1→0.4.2、file 0.3.1→0.3.2、dns 0.3.1→0.3.2、runtime-node 0.2.3→0.2.4、runtime-python 0.2.3→0.2.4）。
- `index/versions.lock.json`：五条各追加新版本（旧版本保留）。
- `presets/*.json`：pin 更新 12 处（db-only 1 / dev 2 / full 5 / gateway 2 / web-lite 1 / web-pro 1）。
- 生成第 40 把 ed25519；`sign-index.sh` → `[OK] 已签名`；两端公钥逐字相同。
- `validate-index.sh` 正例 **exit 0**；副本篡改 **exit 1**；原仓复验 **exit 0**。
- 24 条资产 curl（--retry 2）：**TOTAL=24 OK=24 BAD=0**。
- 私钥用后 `shred -u`：priv/der/seed 均 `No such file`。

## 3. 产物哈希与提交

```text
index/plugins.json     19ef1daabba67f28dd933014e8ca5d6b620c0e887e03f93168723553290cd631
index/plugins.json.sig d64f7f06ae83401547f6de6dc9ebd1eb0eb125c744cd4a094ee8117182c536aa
kore-plugins commit    1435981acd9e00e9133b69614ba13d076c51bec2
  标题：chore(release): 第四十次重签 + dns 0.3.2 / runtime-node 0.2.4 / runtime-python 0.2.4 / site 0.4.2 / file 0.3.2 入索引（五条）
  范围：index/plugins.json · .sig · versions.lock.json · scripts/validate-index.sh · presets/{db-only,dev,full,gateway,web-lite,web-pro}.json
三端推送（Gitea 先推 → GitHub → gitee）：f9fd938..1435981，三端回读 == 1435981
```

## 4. 内核与主实例

- `kore/internal/core/market/verify.go`：`IndexPublicKeyHex` 换第 40 把；`make build` exit 0。
- 闸门：`grep -c 8b4fe19f` = **1**；`grep -c 54c0e4be` = **0**（第 39 把清零）。
- 重启：`systemctl --user restart kored-local`（RUNBOOK §1，未用 setsid）；`cgroup` 不含 `dsh-subprocess`、`healthz=200`。
- 商店：**200**、24 条、`mismatch={}`；五条版本 dns 0.3.2 / runtime-node 0.2.4 / runtime-python 0.2.4 / site 0.4.2 / file 0.3.2；`paths.index_dir` 正确。
- `make check` 13 段全过（exit 0）。

## 5. 沿革（32 → 40）

- 第 32 把 `37c65e8a…`：提前 shred 教训。
- 第 33 把 `3a87e3a5…`：补 terminal 签满 12 条。
- 第 34 把 `3e5333bf…`：16 条版本。
- 第 35 把 `e03ea622…`：URL 全量切 kore-pl + 8 条。
- 第 36 把 `e3a00492…`：补 ssl 0.5.0。
- 第 37 把 `60f66980…`：补 echo 0.1.4。
- 第 38 把 `13766b91…`：补 site 0.4.0 / db-mysql 0.3.2。
- 第 39 把 `54c0e4be…`：补 site 0.4.1 / file 0.3.1。
- 第 40 把 `8b4fe19f…`：补 dns 0.3.2 / runtime-node 0.2.4 / runtime-python 0.2.4 / site 0.4.2 / file 0.3.2。
