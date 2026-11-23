# 第三十八次重签（site 0.4.0 + db-mysql 0.3.2 两条入索引）

- 日期：2026-11-23 18:06–18:14+08:00 · 执行：kore-verify-privilege
- 第 38 把公钥：`13766b91e2c8fab4e70049cb2d03b670a7f8098f9a475062363ef367ce20db73`
- 起因：site 0.4.0 与 db-mysql 0.3.2 已发版并上传 release 资产，索引仍停在两条的 0.3.1。

## 1. 两条资产（实测）

```text
site     0.4.0  sha256=4f478ff661942fe8f9b4d9698f6cbaa238a98ba5be0e54407bcb1fd425da8770  size=1575333
db-mysql 0.3.2  sha256=3ad89d6bcf42e9a512c1afeeb2f1085bb186c5c52f99e735b7a47b22c5efe2ef  size=1569080
两条 curl 均 HTTP 200，sha256/size 与给定值逐字一致。
```

## 2. 第 38 把（只改两条）

- `index/plugins.json`：site 0.3.1 → **0.4.0**、db-mysql 0.3.1 → **0.3.2**（sha/size/url 同步）。
- `index/versions.lock.json`：两条各追加新版本（旧版本保留）。
- `presets/*.json`：pin 更新 7 处（db-only 1 / full 2 / gateway 1 / web-lite 1 / web-pro 2）。
- 生成第 38 把 ed25519；`sign-index.sh` → `[OK] 已签名`；两端公钥逐字相同。
- `validate-index.sh` 正例 **exit 0**；副本篡改 **exit 1**；原仓复验 **exit 0**。
- 24 条资产 curl（--retry 2）：**TOTAL=24 OK=24 BAD=0**。
- 私钥用后 `shred -u`：priv/der/seed 均 `No such file`。

## 3. 产物哈希与提交

```text
index/plugins.json     6394d21f76a39bc6bd975063d63b63a617d0064cb842e2b92a71b23a17f06f04
index/plugins.json.sig 2ce6da4a02e7ebd7b59c4e00ef8c6395152526586a896902821967d7f3fcea9f
kore-plugins commit    bfa63390aebe6f78ff33dd011b49b8071264744f
  标题：chore(release): 第三十八次重签 + site 0.4.0 / db-mysql 0.3.2 入索引（两条）
  范围：index/plugins.json · .sig · versions.lock.json · scripts/validate-index.sh · presets/{db-only,full,gateway,web-lite,web-pro}.json
三端推送（Gitea 先推 → GitHub → gitee）：30a4a80..bfa6339，三端回读 == bfa6339
```

## 4. 内核与主实例

- `kore/internal/core/market/verify.go`：`IndexPublicKeyHex` 换第 38 把；`make build` exit 0。
- 闸门：`grep -c 13766b91` = **1**；`grep -c 60f66980` = **0**（第 37 把清零）。
- 重启主实例（带齐 4 个 `KORE_*`）；`healthz=200`；商店 **200**、24 条、`mismatch={}`、site 0.4.0 / db-mysql 0.3.2；`paths.index_dir` 正确。
- `make check` 13 段全过（exit 0）。

## 5. 沿革（32 → 38）

- 第 32 把 `37c65e8a…`：12:44 提前 shred（签名前确认清单完整的教训）。
- 第 33 把 `3a87e3a5…`：同钥补 terminal 签满 12 条。
- 第 34 把 `3e5333bf…`：16 条版本。
- 第 35 把 `e03ea622…`：URL 全量切 kore-pl + 8 条版本。
- 第 36 把 `e3a00492…`：补 ssl 0.5.0。
- 第 37 把 `60f66980…`：补 echo 0.1.4。
- 第 38 把 `13766b91…`：补 site 0.4.0 / db-mysql 0.3.2。
