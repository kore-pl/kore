# 第三十四次重签 + 16 条版本入索引

> 日期: 2026-11-23 · 执行: kore-impl-release-r5（子 agent）· 任务板: task-3 · 裁决: lead「开签」（16 条清单冻结后一次签完）

## 1. 结论

第 34 把公钥 `3e5333bf…e9f55` 两端同步后，对索引 24 条一次性重签：**16 条版本值全部正确**（其余 8 条保持），`validate-index` 正例 exit 0 / 篡改反例 exit 1，24 条 release 资产 curl **BAD_COUNT=0**，kore `make check` 11 段 exit 0、`make build` exit 0、闸门新公钥=1 / 旧 33、32 把=0，**主实例 8787 已用新公钥二进制重启**：healthz 200、`paths.index_dir` 直指 `kore-plugins/index`、商店 200/24 条 16 新版全对、`store vs index mismatch=[]`、商店/预设/详情端点全 200 无 401。第 34 把私钥已 shred 销毁。

**沿革**：第 32 把（`37c65e8a…`）按 resign-30/31 纪律在 6 条版签完后销毁，scope 扩张后无法同钥补签 → 裁决 A 生成第 33 把（`3a87e3a5…`）原子收口 12 条并销毁 → 本轮第 34 把（`3e5333bf…`）签 16 条并销毁。三把私钥全部用后即 shred，`ls` 均确认 No such file；每轮「清单冻结 → 生成密钥 → 一次签完 → 销毁」，无两把公钥并存窗口。

## 2. 签名前清单冻结与三件套核对（lead 纪律：先核后签）

- **只读核对先行**：16 条逐条跑 tag（本地+远端）+ release 资产 curl + dist 实测；5 条当时未就绪（integrity/logs/firewall/discover/ssh-guard）→ 停下回报、**未生成任何密钥**，等 lead「开签」信号。
- **ssh-guard 0.2.2 开签前复核**：release curl **200**，size **2831651**。
  - ⚠️ **lead 给的 sha 有一位之差**：lead=`2311325120734b41cb8d4e383f24bd5e0c7dc4238df9016f40f11b5b0004706b`，**两路独立实测**（`curl` 下载资产 + `git archive <tag>` 干净树 `make dist`）均为 `2311325120734b41cb8d4e383f24bd5e0c7dc4238df9016f40f11b5f0004706b`（第 58 位 `b`→`f`），两路逐字一致，**按实测入索引**；已回报 lead。

## 3. 16 条实测表（sha 一律取 `git archive <tag>` 干净树 `make dist`，与 release 资产逐字一致）

| 插件 | 版本（索引旧→新） | sha256 | size |
| --- | --- | --- | --- |
| container | 0.3.0→**0.4.0** | `754492dbc87e137f07acd46add6b17afab4d0300081cf761059ecada0a27b71c` | 1522078 |
| cron | 0.4.0→**0.4.1** | `1991002071ceb59e8109e58fd659297dc5890e5dcc8b9ef8891f4b770a47d6d4` | 1554094 |
| db-postgres | 0.2.1→**0.3.0** | `0453c6080e5d58112463e46e6aa473ae1a60d0e605a0a5467973e5be040917f7` | 1563612 |
| discover | 0.2.0→**0.3.0** | `6dda26217a294b6a0a6f67f295f89eb8188c89e90af57c36fb0b80fc7b70fa93` | 1532092 |
| dns | 0.2.0→**0.3.0** | `78ecb27a5ef26db2a8713f9897f920f1e0e73c5a015133008175bccca720c38f` | 1638777 |
| firewall | 0.2.3→**0.2.4** | `983468d4c2abbca960137248dc507e9e98d71827b1be9757902af792a353f90c` | 2831227 |
| integrity | 0.2.0→**0.3.1** | `ed6580bb595ae92158f6808dc3e5518914d9bec63c78a8442b6bdce27a470799` | 1463234 |
| logs | 0.3.0→**0.4.1** | `2e540c366679adfac22fe1f0cc0de36b7d7cdaece1b12c98e9504666669d3b40` | 1556412 |
| process | 0.2.0→**0.2.1** | `27510bc5040f8443ebedccdbe29fec6592928397a69595fc22372f50a84548d0` | 1328724 |
| redis | 0.4.0→**0.5.0** | `d4749ff189cd59bed51383b09d931f12979f3e0e3ba810556efd6e90884b3331` | 1488720 |
| runtime-node | 0.2.0→**0.2.2** | `9e99ef0e3c7ce517a55fce5f5377234693cfeea91e351b0bb10ce789d449e5ef` | 1502821 |
| runtime-php | 0.2.0→**0.2.2** | `11fc63366f0e93bbf8b6693add0e8e86e7bcf634367a21d51e9adfac125233bc` | 1506125 |
| runtime-python | 0.2.0→**0.2.2** | `ad2c2995b4fa41d898929818a83d8d2fd6cdedcceb72174a93a02f57cec1b00c` | 1534431 |
| ssh-guard | 0.2.1→**0.2.2** | `2311325120734b41cb8d4e383f24bd5e0c7dc4238df9016f40f11b5f0004706b` | 2831651 |
| ssl | 0.3.0→**0.4.0** | `c6ccc0459a63cbe229ae74fa494a1b31b9a339b0f47d6fa698bd0e035aad1626` | 2495597 |
| waf | 0.2.0→**0.3.0** | `e526881e6de05b533781663c64982a61028a222ef32d0bf743f36d22d576270e` | 2891664 |

- **4 条 dist 漂移定根因（非 P0）**：process / redis / ssl / waf 工作树 `make dist` 与 release 不同，但 `git archive <tag>` 干净树 == release 逐字一致；根因是 post-tag 提交（4 仓共同 `chore(deps): pluginapi v0.1.3`，waf 另有 1 条 docs）。按 RELEASE.md「同 id@version 只允许一个 sha」取 tag/release 值。**风险已提示 lead**：这 4 仓 HEAD ≠ tag 且工作树有未提交改动，post-tag 改动若要发版必须 bump。
- 保持不动的 8 条：app-deploy 0.2.0 / backup 0.4.0 / db-mysql 0.3.1 / echo 0.1.3 / file 0.3.0 / monitor 0.3.0 / site 0.3.1 / terminal 0.2.0。

## 4. 索引 / 账本 / 预设 / 市场页（kore-plugins）

- `index/plugins.json`：**16 条**原地更新（version/sha256/size_bytes/download_url），条数仍 **24**
- `index/versions.lock.json`：16 条各追加新版本（历史全集保留）；**另补录 4 个已发版但被跳过的中间版本**（tag 干净树实测 sha）：integrity **0.3.0** `0f17c31e…`、logs **0.4.0** `a2f82349…`、runtime-node **0.2.1** `28ae6d6b…`、runtime-php **0.2.1** `33bd1665…`（runtime-python 0.2.1 远端无 tag 且 release 404，确未发版，不补）
- 账本全量断言通过：24 个 id 版本**严格递增**、sha **无重复**、**索引 == 账本最新**（`LEDGER_OK`）
- 预设精确 pin 同步 **31 处**：db-only(2) / dev(2) / full(17) / gateway(3) / security(5) / web-lite(2) / web-pro(3)
- `market/plugins.js` 重建：24 插件 / 3765 B / 无外链
- `make presets-check` exit 0：8 预设 / 24 插件 / **0 FAIL / 0 WARN**；kore-plugins `make check` exit 0

## 5. 第三十四次重签与验签正反例

- 新 ed25519 密钥对（`openssl genpkey`，RUNBOOK §1；`umask 077`，仅落 `/tmp`，用后 shred）
- **第 34 把公钥**：`3e5333bfdd43554f451fdad6b91fcaa05fd4acfa671b2d7a582e77b087ee9f55`
- 两端 `grep` **IDENTICAL**：`validate-index.sh` `PUB_HEX` == `verify.go` `IndexPublicKeyHex`
- `sign-index.sh [OK]`（一次签完 24 条，不分批）；正文 sha `e4410096…e9222`、sig sha `964db692…418b9`（`/tmp/index-sha-34.txt`）
- **正例**：`[OK] …（24 条）/（基线 24 条）/（47 条引用）/ ed25519 签名验证通过`，**exit=0**；恢复后复跑 exit=0
- **反例**：正文追加 1 字节 → `[FAIL] ed25519 签名验证失败`，**exit=1**；恢复后 `sha256sum -c` 两行 OK

## 6. 24 条 release 资产 curl

逐条 `curl -sSL --retry 2`（最多 3 次尝试）下载 24 个 download_url，校验 http_code + sha256 + size_bytes：**TOTAL=24 BAD_COUNT=0**。

## 7. kore 门禁、闸门与 8787 复核

- `make check` **11 段 exit 0**（`[OK] 门禁全部通过`）
- `make build` exit 0；闸门：`strings bin/kored | grep -c 3e5333bf` = **1**，`grep -c 3a87e3a5`（33 把）= **0**，`grep -c 37c65e8a`（32 把）= **0**
- **重启 8787**：kill 旧 PID 1350610 → `setsid nohup ./bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml`（带齐 4 个 `KORE_*` 环境变量：`KORE_SSL_CERT_DIR` / `KORE_LOGS_SOURCES` / `KORE_BACKUP_DIR` / `KORE_BACKUP_ALLOW_ROOTS`）→ **新 PID 1430536**，`kore ready`（13:47:50），`/-/healthz` **200**
- 复核原文：
  ```
  index_dir = /home/pt/Work/GolandProjects/kore-plugins/index
  supervisor = {'resident': 2, 'restarts': 0, 'resident_max': 2, 'lazy_slots': 1}
  store_code=200
  count = 24
  container 0.4.0 OK / cron 0.4.1 OK / db-postgres 0.3.0 OK / discover 0.3.0 OK
  dns 0.3.0 OK / firewall 0.2.4 OK / integrity 0.3.1 OK / logs 0.4.1 OK
  process 0.2.1 OK / redis 0.5.0 OK / runtime-node 0.2.2 OK / runtime-php 0.2.2 OK
  runtime-python 0.2.2 OK / ssh-guard 0.2.2 OK / ssl 0.4.0 OK / waf 0.3.0 OK
  store vs index mismatch = []
  其余 8 条: app-deploy 0.2.0 / backup 0.4.0 / db-mysql 0.3.1 / echo 0.1.3
            / file 0.3.0 / monitor 0.3.0 / site 0.3.1 / terminal 0.2.0
  ```
- **无 401**：`/store/plugins` 200、`/store/presets` 200、`/store/plugins/ssl` 200、`/store/plugins/waf` 200、静态壳 `/` 200
- 登录复用既有 `kore_session` cookie（`/tmp/kore.jar`，TTL 12h），**未使用/未记录任何明文口令**（G-30）
- **G-29 声明**：本轮未改 `.kore-local.yaml`、未动 state/run/ssl/backups；仅按配置注释 export 4 个 `KORE_*` 变量后重启进程

## 8. 私钥销毁（收尾纪律）

```bash
shred -u /tmp/kore-seed-34.txt /tmp/kore-index-priv-34.pem /tmp/kore-index-34.der /tmp/kore-pub-34.txt
ls …   # 四个文件全部 No such file or directory
```
第 34 把私钥材料已销毁；第 32、33 把残留同查为 No such file。`/tmp` 无 `kore-*34*` 私钥残留（`/tmp/kore-e2e-3427759508` 为他支 e2e 实例目录，非本任务产物，未触碰）。

## 9. 提交与推送

- **kore-plugins**：`0981fbc`（12 文件：索引 + 签名 + 账本 + 市场页 + 7 预设 + `validate-index.sh` 新公钥），精确 add，**已推 origin + gitee**（均 exit 0，两远端同 commit），工作树干净
- **kore**：`internal/core/market/verify.go`（第 34 把公钥）+ 本报告，精确 add 两文件，**只 commit 不 push**（推送归台账任务）
- 未触碰其他 agent 的 `web/`、`internal/core/*`、`Makefile`、截图与 BOARD（G-08/G-12）
