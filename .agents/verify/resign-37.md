# 第三十七次重签（echo 0.1.4 单条入索引）

- 日期：2026-11-23 17:48–17:56+08:00 · 执行：kore-verify-privilege
- 第 37 把公钥：`60f669803fbdd7a531c10e7c4f36ad22008248447f34f839a2eb41c781fc006b`
- 起因：echo 0.1.4（tag `v0.1.4` → `2e813de`）已发版并上传 release 资产，索引仍停在 0.1.3（第 36 把签名有效）。

## 1. echo 0.1.4 资产

```text
url    https://github.com/kore-pl/kore-plugin-echo/releases/download/v0.1.4/echo-0.1.4.tar.gz
sha256 eaf2d12874782e9ba3f2fe6ef6461cc10fe05f8003e8b0cbe839e66b66566386
size   1353310
下载复核：HTTP 200，sha256/size 与给定值逐字一致
```

## 2. 第 37 把（只改 echo 1 条）

- `index/plugins.json`：echo 0.1.3 → **0.1.4**（sha/size/url 同步）；其余 23 条不变。
- `index/versions.lock.json`：echo 追加 `0.1.4 + eaf2d128…`（0.1.3 保留）。
- `presets/*.json`：echo pin 更新 2 处（dev、full）。
- 生成第 37 把 ed25519；`scripts/sign-index.sh` → `[OK] 已签名`。
- 两端公钥逐字相同（validate-index.sh `PUB_HEX` == verify.go `IndexPublicKeyHex`）。
- `validate-index.sh` 正例 **exit 0**；/tmp 副本篡改 1 字符 **exit 1**；原仓复验 **exit 0**。
- 24 条 release 资产 curl（--retry 2）：**TOTAL=24 OK=24 BAD=0**。
- 私钥用后 `shred -u`：priv/der/seed 均 `No such file`。

## 3. 产物哈希与提交

```text
index/plugins.json     cd49ee3f36e0791604f61808ae33a87c05d3f209f5e01c8516e230c65a051d9d
index/plugins.json.sig 77a1f6e616658ca86caa6f0b0e03ac8b332c0dd9157379316c0d2d02ab0752e9
kore-plugins commit    30a4a80aa639278a6e8c81cfaadd674b9347329a
  标题：chore(release): 第三十七次重签 + echo 0.1.4 入索引（单条）
  范围：index/plugins.json · index/plugins.json.sig · index/versions.lock.json · scripts/validate-index.sh · presets/{dev,full}.json
三端推送（Gitea 先推 → GitHub → gitee）：fd18c01..30a4a80，三端回读 == 本地 30a4a80
```

## 4. 内核与主实例

- `kore/internal/core/market/verify.go`：`IndexPublicKeyHex` 换为第 37 把；`make build` exit 0。
- 闸门：`strings bin/kored | grep -c 60f66980` = **1**；`grep -c e3a00492` = **0**（第 36 把清零）。
- 重启主实例（带齐 4 个 `KORE_*`）：PID 更新，`kore ready`，`healthz=200`。
- 商店：`GET /api/v1/store/plugins` **200**、24 条、`mismatch={}`；echo = **0.1.4**；`paths.index_dir` 仍为 `kore-plugins/index`。
- `make check` 13 段全过（exit 0）。

## 5. 沿革（32 → 37）

- 第 32 把 `37c65e8a…`：12:44 提前 shred（scope 扩张后无法补签 → 教训：签名前确认清单完整）。
- 第 33 把 `3a87e3a5…`：同钥补 terminal 签满 12 条。
- 第 34 把 `3e5333bf…`：16 条版本。
- 第 35 把 `e03ea622…`：URL 全量切 kore-pl + 8 条版本。
- 第 36 把 `e3a00492…`：补 ssl 0.5.0（release 新建 + 索引 + 主实例安装）。
- 第 37 把 `60f66980…`：补 echo 0.1.4 单条。
