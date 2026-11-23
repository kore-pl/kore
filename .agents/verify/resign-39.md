# 第三十九次重签（site 0.4.1 + file 0.3.1 两条入索引）

- 日期：2026-11-23 19:19–19:28+08:00 · 执行：kore-verify-privilege
- 第 39 把公钥：`54c0e4be1ac3aa0d71b686f3b8c3d0cab7a36d4ea01d1563c3b29bb983492f0d`
- 起因：site 0.4.1 与 file 0.3.1 已发版并上传 release 资产，索引仍停在 0.4.0 / 0.3.0。

## 1. 两条资产（实测）

```text
site 0.4.1  sha256=17ba57e5385cbd968bc38acf79c8cc8f2586b500820213dc7a45204150dfbe13  size=1590582
file 0.3.1  sha256=1e9b6a2e5c373907ab22686a2fdd60b31c38edc814d27bfd5c8c3d866218725b  size=1689617
两条 curl 均 HTTP 200，sha256/size 与给定值逐字一致。
```

## 2. 第 39 把（只改两条）

- `index/plugins.json`：site 0.4.0 → **0.4.1**、file 0.3.0 → **0.3.1**（sha/size/url 同步）。
- `index/versions.lock.json`：两条各追加新版本（旧版本保留）。
- `presets/*.json`：pin 更新 6 处（db-only 1 / full 2 / gateway 1 / web-lite 1 / web-pro 1）。
- 生成第 39 把 ed25519；`sign-index.sh` → `[OK] 已签名`；两端公钥逐字相同。
- `validate-index.sh` 正例 **exit 0**；副本篡改 **exit 1**；原仓复验 **exit 0**。
- 24 条资产 curl（--retry 2）：**TOTAL=24 OK=24 BAD=0**。
- 私钥用后 `shred -u`：priv/der/seed 均 `No such file`。

## 3. 产物哈希与提交

```text
index/plugins.json     232110062a67d08c3736fcc828920a75cd48bae8f412cbbea1513fc1da4cab00
index/plugins.json.sig c26c0f18fde6869f6949f3ab5dc8b280a4606e864b83b894bec273802ad56f16
kore-plugins commit    f9fd93827ee24bf8689f20e199b55d4c222115fa
  标题：chore(release): 第三十九次重签 + site 0.4.1 / file 0.3.1 入索引（两条）
  范围：index/plugins.json · .sig · versions.lock.json · scripts/validate-index.sh · presets/{db-only,full,gateway,web-lite,web-pro}.json
三端推送（Gitea 先推 → GitHub → gitee）：bfa6339..f9fd938，三端回读 == f9fd938
```

## 4. 内核与主实例

- `kore/internal/core/market/verify.go`：`IndexPublicKeyHex` 换第 39 把；`make build` exit 0。
- 闸门：`grep -c 54c0e4be` = **1**；`grep -c 13766b91` = **0**（第 38 把清零）。
- 重启：`systemctl --user restart kored-local`（RUNBOOK §1，**未用 setsid**）；复核 `cgroup` 不含 `dsh-subprocess`、`healthz=200`。
- 商店：**200**、24 条、`mismatch={}`、site 0.4.1 / file 0.3.1；`paths.index_dir` 正确。
- `make check` 13 段全过（exit 0）。

## 5. 沿革（32 → 39）

- 第 32 把 `37c65e8a…`：12:44 提前 shred（签名前确认清单完整的教训）。
- 第 33 把 `3a87e3a5…`：同钥补 terminal 签满 12 条。
- 第 34 把 `3e5333bf…`：16 条版本。
- 第 35 把 `e03ea622…`：URL 全量切 kore-pl + 8 条版本。
- 第 36 把 `e3a00492…`：补 ssl 0.5.0。
- 第 37 把 `60f66980…`：补 echo 0.1.4。
- 第 38 把 `13766b91…`：补 site 0.4.0 / db-mysql 0.3.2。
- 第 39 把 `54c0e4be…`：补 site 0.4.1 / file 0.3.1。
