# 第三十三次重签 + 12 条版本入索引（ssh-guard 0.2.1、backup 0.4.0、site 0.3.1、file 0.3.0、monitor 0.3.0、terminal 0.2.0）

> 日期: 2026-11-23 · 执行: kore-impl-release-r5（子 agent）· 任务板: task-3 · 裁决: lead A（补 terminal 同钥签满 12 条）

## 1. 结论

第 33 把公钥 `3a87e3a5…3f23e80` 两端同步后，对索引 24 条一次性重签：**12 条版本值正确**（6 条沿用第 32 批成果 + 6 条本批更新），`validate-index` 正例 exit 0 / 篡改反例 exit 1，24 条 release 资产 curl **BAD_COUNT=0**，kore `make check` 11 段 exit 0、`make build` exit 0、闸门新公钥=1/旧=0，**主实例 8787 已用新公钥二进制重启**：healthz 200、`paths.index_dir` 直指 `kore-plugins/index`、商店 200/24 条 12 版本全对、`store vs index mismatch=[]`、商店/预设/详情端点全部 200 无 401。第 33 把私钥已 shred 销毁。

## 2. 沿革：第 32 把销毁 → 第 33 把收口

- **第 32 把**（`37c65e8a…4a5b9`）：12:19 生成并两端同步，完成 4 条（redis/ssh-guard/logs/container）→ 6 条（+process/cron）两批签名，提交 `d3aba7c` + `198169b` 并双推。**12:44 按 resign-30/31 既定纪律 shred**（当时 6 条版已签完、kore 已 commit、证据已落盘，视为任务收尾）。
- 随后 scope 两次扩张（8 条 → 12 条），需同钥补签时私钥已不可恢复——穷举确认无副本（/tmp、两仓、会话日志均无 seed；签名命令 `KORE_INDEX_KEY=$(cat …)` 不回显；公钥不可反推私钥）。**流程教训（lead 已记台账）：签名前必须先确认待签清单完整。**
- **第 33 把**（`3a87e3a5…3f23e80`）：13:05 生成，两端一次性同步（`validate-index.sh` PUB_HEX == `verify.go` IndexPublicKeyHex，`grep` IDENTICAL），先签 11 条版（terminal 排除），lead 裁决 A 后同钥补 terminal 0.2.0 重签 12 条版——**全程同一把第 33 把，无两把公钥并存窗口**；第 32 把公钥在二进制中计数已归 0。
- 第 33 把私钥于收尾 shred（见 §8）。

## 3. 12 条版本实测表（dist 三处复现 + release 资产 curl）

| 插件 | 版本 | sha256（实测=索引=release） | size（实测） | tag | 三件套 |
| --- | --- | --- | --- | --- | --- |
| redis | 0.4.0 | `07a20bba…d985` | 1446756 | `593f346` | ✓（第 32 批实测，本批复跑 curl） |
| logs | 0.3.0 | `f00859b3…45cf` | 1505758 | `c875b8b` | ✓ 同上 |
| container | 0.3.0 | `00c37c45…baab47` | 1490488 | `864916d` | ✓ 同上 |
| process | 0.2.0 | `b46b7b87…f88f` | 1328693 | `1f4a409`→`67e99fd` | ✓ 同上 |
| cron | 0.4.0 | `d4a79355…84e5` | 1514481 | `934410f`→`81e84d8` | ✓ 同上 |
| ssh-guard | 0.2.0→**0.2.1** | `ac0a08fa…25732` | **2803978**（包内 2803976，Δ2） | `ba9d1d5` | ✓ 本批实测 |
| backup | 0.3.0→**0.4.0** | `5b30ba8a…93559` | **1607939**（包内 1607937，Δ2） | `a021a636`→`8c06085` | ✓ 本批实测 |
| site | 0.2.0→**0.3.1** | `8fa58e36…82910` | **1537532** | `c9f2321`→`49d0f5a` | ✓ 本批实测 |
| file | 0.2.1→**0.3.0** | `4e9b4a41…2ddc5` | **1662070** | `42810d9`→`0c349bb`（tag 指向的包；HEAD `4782007` 两条非 dist 提交） | ✓ 本批实测 |
| monitor | 0.2.1→**0.3.0** | `db747aad…ba667` | **1344418** | `8a3600d7`→`b95e72b` | ✓ 本批实测 |
| terminal | 0.1.1→**0.2.0** | `d72e4567…46093` | **1499783**（包内 1499784，Δ1） | `bedd97e`（=HEAD） | ✓ 本批实测（裁决 A 补入） |
| waf | 0.2.0 | `0df14e70…9cd85e` | 2871268 | `ea2013d` | 保持现值（0.3.0 另起第 34 把） |

- **5 条新入索引（ssh-guard/backup/site/file/monitor）+ terminal 均过三件套**：tag 存在 + `curl -L` 200 + 本仓 `make dist` sha 与 release 资产逐字一致；另做 `git archive <tag>` 干净树重建，5 条 `TAG_TREE_REPRO_OK`。
- **全 24 仓对齐扫描**（index vs info.json vs tag）：仅 6 处 DIFF（即上表 6 条更新项），其余 18 条 index==info==tag；terminal 半成品期曾为第 7 处 DIFF，发版后补入归零。**无漏网**。
- 排除项：`terminal` 曾因半成品（26 文件未提交、无 tag、无 0.2.0 包）被 lead 紧急排除，发版后裁决 A 补入；`waf` 0.3.0 未发版，保持 0.2.0。

## 4. 索引 / 账本 / 预设 / 市场页（kore-plugins）

- `index/plugins.json`：6 条原地更新（version/sha256/size_bytes/download_url），条数仍 **24**
- `index/versions.lock.json`：追加 ssh-guard 0.2.1 / backup 0.4.0 / site 0.3.1 / file 0.3.0 / monitor 0.3.0 / terminal 0.2.0；**历史全集保留**（ssh-guard 0.2.0 条目留账）；**补录 site 已发版的 0.3.0**（sha `ab47cb79…8bff3`，tag 干净树 + release 资产三方一致）→ site 账本 0.1.0/0.2.0/0.3.0/0.3.1 无跳版
- 预设精确 pin 同步 **12 处**：`db-only`（file、backup）、`full`（site/file/ssh-guard/monitor/backup）、`gateway`（site）、`security`（ssh-guard）、`web-lite`（site）、`web-pro`（site/monitor）；`grep -rn '"terminal"' presets/` 零命中（无 pin 需改）
- `market/plugins.js` 重建：24 插件 / 3765 B / 六字段齐全 / 无外链
- `make presets-check` exit 0：8 预设 / 24 索引插件 / **0 FAIL / 0 WARN**；kore-plugins `make check` exit 0

## 5. 第三十三次重签与验签正反例

- 新 ed25519 密钥对（`openssl genpkey`，RUNBOOK §1；私钥仅落 `/tmp`、`umask 077`、收尾 shred）
- **第 33 把公钥**：`3a87e3a53c37ff467e3317fd48f9b7a92e13018ec60f8c250aaecda6d3f23e80`
- 两端 `grep` 逐字相同（IDENTICAL）：`kore-plugins/scripts/validate-index.sh` `PUB_HEX` == `kore/internal/core/market/verify.go` `IndexPublicKeyHex`
- `sign-index.sh [OK]`（11 条版签一次，补 terminal 后同钥再签一次，覆盖为最终 12 条版）；最终正文 sha `4bd958cd…cd4c5`、sig sha `1e6505a5…01491`（`/tmp/index-sha-33.txt`）
- **正例**：`bash scripts/validate-index.sh` → `[OK] …（24 条）/（基线 24 条）/（47 条引用）/ ed25519 签名验证通过`，**exit=0**；恢复后复跑 exit=0
- **反例**：正文追加 1 字节 → `[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）`，**exit=1**；恢复后 `sha256sum -c` 两行 OK

## 6. 24 条 release 资产 curl

逐条 `curl -sSL`（`--retry 2`，新发版资产 CDN 延迟防护，最多 3 次尝试）下载 24 个 download_url，同时校验 http_code + sha256 + size_bytes：**TOTAL=24 BAD_COUNT=0**（terminal 用 0.2.0 新资产）。

## 7. kore 门禁、闸门与 8787 复核

- `make check` **11 段 exit 0**（`[OK] 门禁全部通过`；注：首次运行曾报 thin-shell-check / repo-check 两处 FAIL，系并行 agent 正在写入 `internal/` 与 `web/` 的瞬时态，重跑即绿——两处命中均不在本任务写域）
- `make build` exit 0；闸门：`strings bin/kored | grep -c 3a87e3a5` = **1**，`grep -c 37c65e8a`（第 32 把）= **0**，`grep -c 1605021f`（第 31 把）= **0**
- **重启 8787**：kill 旧 PID 175666（第 32 把二进制）→ `setsid nohup ./bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml` → **新 PID 843194**，`kore ready`（13:15:43），`/-/healthz` **200**
- 复核原文：
  ```
  index_dir = /home/pt/Work/GolandProjects/kore-plugins/index
  supervisor = {'resident': 2, 'restarts': 0, 'resident_max': 2, 'lazy_slots': 1}
  store_code=200
  count = 24
  redis 0.4.0 OK / logs 0.3.0 OK / container 0.3.0 OK / process 0.2.0 OK
  cron 0.4.0 OK / ssh-guard 0.2.1 OK / backup 0.4.0 OK / site 0.3.1 OK
  file 0.3.0 OK / monitor 0.3.0 OK / terminal 0.2.0 OK / waf 0.2.0 OK
  store vs index mismatch = []
  ```
- **无 401 确认**（新公钥下验签全过）：`/api/v1/store/plugins` 200、`/api/v1/store/presets` 200、`/api/v1/store/plugins/terminal` 200、`/api/v1/store/plugins/site` 200、静态壳 `/` 200
- 登录复用既有 `kore_session` cookie（`/tmp/kore.jar`，TTL 12h），**未使用/未记录任何明文口令**（G-30）

## 8. 私钥销毁（收尾纪律）

```bash
shred -u /tmp/kore-seed-33.txt /tmp/kore-index-priv-33.pem /tmp/kore-index-33.der
ls /tmp/kore-seed-33.txt /tmp/kore-index-priv-33.pem /tmp/kore-index-33.der  # 全部 No such file
```
第 33 把私钥材料已销毁，不在任何仓库或工作区留存（resign-30/31 同口径）。

## 9. 提交与推送

- **kore-plugins**：`b4f688b`（11 文件：索引 + 签名 + 账本 + 市场页 + 6 预设 + `validate-index.sh` 新公钥），精确 add，**已推 origin + gitee**（均 exit 0，两远端同 commit）
- **kore**：`internal/core/market/verify.go`（第 33 把公钥）+ 本报告，精确 add 两文件，**只 commit 不 push**（推送归台账任务统一 origin+gitee）
- 未触碰：kore 仓其他 agent 的 `web/`、`internal/core/supervisor/`、`internal/core/privilege/`、`Makefile`、截图与 BOARD（G-08/G-12）

## 10. 遗留（第 34 把）

- `waf` 0.3.0（allowlist 扩展 + 真实后端 + sed 裁决）发版后另起**第 34 把**重签，lead 将唤醒本 agent。
