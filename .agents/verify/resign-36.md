# 第三十六次重签（补 ssl 0.5.0：release + 索引 + 主实例安装）

- 日期：2026-11-23 15:49–15:56+08:00 · 执行：kore-verify-privilege
- 第 36 把公钥：`e3a00492b030fe00ccef267390d384c58fa9f651c073c448b8d0a729d58a0e9a`
- 起因：ssl 0.5.0（`09ff75d` + tag `v0.5.0`）在第 35 把重签（15:25）之后才发版，未进索引；GitHub 也无 v0.5.0 release。主实例装了 0.4.0，ACME 新方法不可用。

## 1. ssl 0.5.0 release（GitHub kore-pl）

```text
dist:  kore-plugin-ssl/dist/ssl-0.5.0.tar.gz
sha256 565009c6d86937dc63cda7cb1564d85c7d0c77fb7798ebc41588ed27a7320496
size   3159663
release URL https://github.com/kore-pl/kore-plugin-ssl/releases/tag/v0.5.0
gh release create v0.5.0 … → exit 0；gh release view：tag v0.5.0 / draft false / asset ssl-0.5.0.tar.gz 3159663 B
下载复核：HTTP 200，sha256 与本地 dist 逐字相同
```

## 2. 第 36 把（只补 ssl 1 条，签名必须重做）

- `index/plugins.json`：ssl 0.4.0 → **0.5.0**（sha/size/url 同步）；其余 23 条不变。
- `index/versions.lock.json`：ssl 追加 `0.5.0 + 565009c6…`（0.4.0 保留在历史）。
- `presets/*.json`：ssl pin 更新 5 处（full/gateway/security/web-lite/web-pro）。
- 生成第 36 把 ed25519；`scripts/sign-index.sh` 重签 → `[OK] 已签名`。
- 两端公钥同步逐字相同（validate-index.sh `PUB_HEX` == verify.go `IndexPublicKeyHex`）。
- `validate-index.sh` 正例 **exit 0**；/tmp 副本篡改 1 字符 **exit 1**（ed25519 失败）；原仓复验 **exit 0**。
- 24 条 release 资产逐条 curl：**TOTAL=24 OK=24 BAD=0**（sha256 + size 全部吻合）。
- 私钥用后立即 `shred -u`：priv/der/seed 三文件均 `No such file`。

## 3. 推送（三端）

```text
kore-plugins commit 377339ed32939d10e214503e1cae9ad603ebb964
  chore(release): 第三十六次重签 + ssl 0.5.0 入索引（内置 ACME 客户端 / LiteSSL / 自动续期）
Gitea(origin)  f586c0e..377339e   exit 0
GitHub(github) f586c0e..377339e   exit 0
gitee          f586c0e..377339e   exit 0
回读三端 == 本地 377339e
```

## 4. 内核与主实例

- `kore/internal/core/market/verify.go`：`IndexPublicKeyHex` 换为第 36 把；`make build` exit 0。
- 闸门：`strings bin/kored | grep -c e3a00492` = **1**；`grep -c e03ea622` = **0**（第 35 把清零）。
- 重启主实例（带齐 4 个 `KORE_*`）：PID `2099399 → 2453023`，`15:54:26 kore ready`，`healthz=200`。
- 商店：`GET /api/v1/store/plugins` **200**、24 条、`mismatch={}`，`ssl` 索引 = 0.5.0。
- 安装：`POST /api/v1/store/install {"id":"ssl","version":"0.5.0","download":true}` → **HTTP 200**、`succeeded`、`已从 v0.4.0 升级到 v0.5.0`、`reload=restarted`；`GET /plugins` ssl = **0.5.0**、enabled=true。
- ACME 抽查：`POST /invoke/ssl/ssl.acme.builtin.status` → **HTTP 200**，返回真实配置（cert_dir 来自 KORE_SSL_CERT_DIR、acme_dir、CA 预设含 letsencrypt-staging/letsencrypt/litessl、`auto_renew=false`、`eab_configured=false`）；对照调用不存在的方法返回 404 `E_NOTFOUND`，确认新方法真实存在。
- `make check` 13 段全过（exit 0）。

## 5. 沿革（32 → 36）

- 第 32 把 `37c65e8a…`：12:44 提前 shred（scope 扩张后无法补签 → 教训：签名前确认清单完整）。
- 第 33 把 `3a87e3a5…`：同钥补 terminal 签满 12 条。
- 第 34 把 `3e5333bf…`：16 条版本。
- 第 35 把 `e03ea622…`：URL 全量切 kore-pl + 8 条版本。
- 第 36 把 `e3a00492…`：补 ssl 0.5.0 一条（release 新建 + 索引 + 主实例安装）。
