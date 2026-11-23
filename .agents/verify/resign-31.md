# 第三十一次重签 + 5 插件发版入索引（backup/cron 0.3.0、dns/waf 0.2.0、ssl 0.3.0）

> 日期: 2026-11-23 · 执行: resign-31（子 agent）· 变更集: CS-20261123-03

## 1. 结论

5 个插件新版本全部入索引并重签（第三十一把公钥 `1605021f…0751`），索引 24 条签名有效，24 条 release 资产 curl 全 200，隔离实例（127.0.0.1:18847）端到端安装 5/5 成功，干净树（clone 新 tag → `make dist`）5/5 sha 与索引一致。**主实例 8787 尚未重启，重启前商店 401**（公钥编译期常量，见 RUNBOOK 铁律 2）——由 lead 重启并升级 5 个插件。

## 2. 包核对（dist 实测 sha256 / `stat -c%s`）

| 插件 | 版本 | dist sha256（实测=报告） | size（实测） | 仓 commit | release |
| --- | --- | --- | --- | --- | --- |
| backup | 0.2.1→0.3.0 | `201c424e…0a90c` | 1524287 | `9c7d58c` | 200+sha OK |
| cron | 0.2.1→0.3.0 | `9104823a…288ee` | 1512234 | `a27fa27` | 200+sha OK |
| dns | 0.1.1→0.2.0 | `49d25840…3061b9` | 1571091 | `b40776c` | 200+sha OK |
| waf | 0.1.1→0.2.0 | `0df14e70…9cd85e` | 2871268 | `ea2013d` | 200+sha OK |
| ssl | 0.2.1→0.3.0 | `6e40c995…7309ac` | 2465706（包内声明 2465705，Δ1，按实测入索引） | `3b0084f` | 200+sha OK |

全部 `curl -L` 下载回读 sha 与 dist 一致。

## 3. 索引 / 账本 / 预设 / 市场页

- `index/plugins.json`：5 条原地更新（version/sha256/size_bytes/download_url，lifecycle 均为 `lazy` 维持），count 不变 24
- `index/versions.lock.json`：5 个 id 各追加 `{version, sha256}`
- 预设同步 12 处精确 pin：`full.json`（4+ssl=5）、`security.json`（waf+ssl）、`gateway.json`（dns+ssl）、`db-only.json`（backup）、`web-lite.json`（ssl）、`web-pro.json`（ssl）
- `make presets-check` exit 0：8 预设 / 24 索引插件 / 0 FAIL / 0 WARN
- `market/plugins.js` 重建：24 插件 / 3765 B / 无外链

## 4. 第三十一次重签

- 新 ed25519 密钥对（`openssl genpkey`，流程见 RUNBOOK §1），新公钥 `1605021fc2b53b82351babfe3b4cc96d919aec37b2756d2f0b3721aaa6dc0751`
- 两处公钥 `grep` 逐字相同：`kore-plugins/scripts/validate-index.sh` `PUB_HEX` + `kore/internal/core/market/verify.go` `IndexPublicKeyHex`
- `sign-index.sh` `[OK]`；索引正文 sha `c859fd2e…8c8ce9`、sig sha `a5447de7…8b852`（`/tmp/index-sha-31.txt`）
- 私钥材料用完 shred（resign-30 同口径），不在任何仓库或工作区留存

## 5. 验签正反例

- 正例：`bash scripts/validate-index.sh` → `[OK] … （24 条）/（基线 24 条）/（47 条引用）/ ed25519 签名验证通过`，**exit=0**
- 反例：正文追加 1 字节 → `[FAIL] ed25519 签名验证失败`，**exit=1**；恢复后 `sha256sum -c` 两行 OK

## 6. 24 条 release 资产 curl

逐条 HEAD 请求 24 个 download_url：**BAD_COUNT=0（24/24 全 200）**。

## 7. `make build` + 新公钥进二进制闸门

- `make build` exit 0，`strings bin/kored | grep -c "1605021f"` = **1（判据≥1）**

## 8. 端到端（隔离实例 127.0.0.1:18847，config/state/run/log 全在 `/tmp/kore-e2e-31`）

- `/-/healthz` 200；`auth/login` 200（首版 config 用 hex salt 被 401 拒——根因：存储串要求 `base64(salt)$base64(hash)`，见 `internal/core/auth/password.go:28`，改 base64 后过）
- `GET /store/plugins` **200 / 24 条**，与索引逐条 version 比对 mismatch=0；backup=0.3.0 / cron=0.3.0 / dns=0.2.0 / waf=0.2.0 / ssl=0.3.0 全 OK
- `POST /store/install`（CSRF 双提交 `X-Kore-CSRF`）：5/5 **code=200 `state=succeeded` reload=reloaded**

## 9. 干净树复现

`git clone --depth 1 --branch v<版本>` 5 仓 → `make dist` → sha 与索引全部一致（5/5 SHA_MATCH，见 §2 表）。

## 10. 提交与遗留

- `kore-plugins`：index 3 文件 + 6 预设 + `validate-index.sh`（新公钥）+ `market/plugins.js`，经 `scripts/safe-commit.sh` 提交
- `kore`：`internal/core/market/verify.go`（新公钥）+ 本报告 + BOARD `CS-20261123-03`，经 `scripts/safe-commit.sh` 提交
- **遗留（lead 动作）**：主实例 8787 重启（新公钥二进制）+ 5 插件升级；重启前主实例商店 401 属预期
