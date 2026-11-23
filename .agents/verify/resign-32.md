# 第三十二次重签 + 6 插件发版入索引（redis 0.4.0、ssh-guard 0.2.0、logs 0.3.0、container 0.3.0、process 0.2.0、cron 0.4.0）

> 日期: 2026-11-23 · 执行: kore-impl-release-r5（子 agent）· 任务板: task-3

## 1. 结论

6 个插件新版本全部入索引并完成第三十二次重签（第 32 把公钥 `37c65e8a…4a5b9`，两端逐字相同），索引 24 条签名有效，24 条 release 资产 curl 全 200 且 sha+size 逐条一致（`BAD_COUNT=0`），`validate-index` 正例 exit 0 / 篡改反例 exit 1，kore `make check` 11 段 exit 0、`make build` exit 0，**主实例 8787 已恢复**（新公钥二进制）：`paths.index_dir` 直指 `kore-plugins/index`、商店 200 / 24 条且 6 个新版全部在列。

**G-29 声明：本轮未改动主实例运行态配置** —— `.kore-local.yaml` 全程未改（md5 `59315dd00358abd5ef9183dc5a67de4d` 前后一致），state/run/ssl/backups 未手改；启动仅按配置注释导出 4 个插件环境变量（`KORE_SSL_CERT_DIR` / `KORE_LOGS_SOURCES` / `KORE_BACKUP_DIR` / `KORE_BACKUP_ALLOW_ROOTS`，均为 `.kore-local-state/` 内路径）。测试全走既有隔离实例或只读 curl。

## 2. 六仓 tag / release 状态

| 插件 | 版本 | tag（远端 ls-remote） | release 资产（gh） | 与 dist 实测 |
| --- | --- | --- | --- | --- |
| redis | 0.4.0 | `593f34615e0e` ✓ | redis-0.4.0.tar.gz 1446756 | sha+size 一致 |
| ssh-guard | 0.2.0 | `ce39aab97b8a` ✓ | ssh-guard-0.2.0.tar.gz 1474806 | sha+size 一致 |
| logs | 0.3.0 | `c875b8b7d7a7` ✓ | logs-0.3.0.tar.gz 1505758 | sha+size 一致 |
| container | 0.3.0 | `864916d22cf7` ✓ | container-0.3.0.tar.gz 1490488（+ .sha256 89 B） | sha+size 一致 |
| process | 0.2.0 | `1f4a4098d13c`→`67e99fd` ✓ | process-0.2.0.tar.gz 1328693 | sha+size 一致 |
| cron | 0.4.0 | `934410f7e3e9`→`81e84d8` ✓ | cron-0.4.0.tar.gz 1514481 | sha+size 一致 |

- redis / ssh-guard 的 tag + push + `gh release create` 由本 agent 完成（任务卡授权范围内；lead 后续把四仓改派只读复核，避免重复打 tag）；logs / container / process / cron 的 tag+release 已在远端，本轮只做核对。
- 每条 `curl -L` 下载回读 sha256 与本地 `make dist` 产物一致（redis `07a20bba…d985` / ssh-guard `c3032685…dfba3` / logs `f00859b3…45cf` / container `00c37c45…baab47` / process `b46b7b87…f88f` / cron `d4a79355…84e5`）。
- dist 可复现（4 仓，本 agent 实测）：同树两打 + `git archive HEAD` 干净树重建，三处 sha 全部 `REPRO_OK`。
- 注：ssh-guard 工作树 HEAD 已被并行 agent 推进到 0.2.1（`ba9d1d5`），`v0.2.0` tag 仍指 `ce39aab`；0.2.1 与 backup 0.4.0 不在本次范围，将另起第 33 次重签（lead 裁决）。

## 3. 索引 / 账本 / 预设 / 市场页（kore-plugins）

- `index/plugins.json`：6 条原地更新（version/sha256/size_bytes/download_url），条数仍 **24**
- `index/versions.lock.json`：6 个 id 各追加新版本（redis 0.4.0 / ssh-guard 0.2.0 / logs 0.3.0 / container 0.3.0 / process 0.2.0 / cron 0.4.0），历史保留
- 预设精确 pin 同步 8 处：`db-only.json`（redis）、`full.json`（ssh-guard / logs / redis / container / cron）、`security.json`（ssh-guard）、`web-pro.json`（logs）；process 无预设引用
- `make presets-check` exit 0：8 预设 / 24 索引插件 / 0 FAIL / 0 WARN
- `market/plugins.js` 重建：24 插件 / 3765 B / 六字段齐全 / 无外链
- kore-plugins `make check` exit 0

## 4. 第三十二次重签

- 新 ed25519 密钥对（`openssl genpkey`，RUNBOOK §1 流程，私钥仅落 `/tmp` 且 `umask 077`，用完 shred）
- **第 32 把公钥**：`37c65e8afcec13c5f4b286cd256147c92793459602608b725395fd7f7a54a5b9`
- 两处 `grep` 逐字相同：
  - `kore-plugins/scripts/validate-index.sh` → `PUB_HEX="37c65e8a…4a5b9"`
  - `kore/internal/core/market/verify.go` → `IndexPublicKeyHex = "37c65e8a…4a5b9"`
- 过程说明：范围从 4 条两次扩到 6 条（process 0.2.0、cron 0.4.0），**全程只用同一把第 32 把公钥重签**，未产生第二把公钥的中间态（前两次签名被最后一次覆盖）
- `sign-index.sh` `[OK]`；最终索引正文 sha `4e04a414…b244`、sig sha `87a585b2…5943`（`/tmp/index-sha-32.txt`）

## 5. 验签正反例

- 正例：`bash scripts/validate-index.sh` → `[OK] …（24 条）/（基线 24 条）/（47 条引用）/ ed25519 签名验证通过`，**exit=0**；恢复后复跑仍 exit=0
- 反例：正文追加 1 字节 → `[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）`，**exit=1**；恢复后 `sha256sum -c /tmp/index-sha-32.txt` 两行 OK

## 6. 24 条 release 资产 curl

逐条 `curl -sSL` 下载 24 个 download_url，同时校验 http_code + sha256 + size_bytes：**TOTAL=24 BAD_COUNT=0**（含 6 个新版；process 0.1.1→0.2.0、cron 0.3.0→0.4.0 升级后仍 24 条）。

## 7. kore 门禁与新公钥闸门

- `make check` **11/11 exit 0**（含第 10 段 frontend 首屏 59416 B ≤ 307200 B、第 11 段 secret-check 0 FAIL）
- `make build` exit 0，`bin/kored` 9,416,866 B
- 闸门：`strings bin/kored | grep -c 37c65e8a` = **1**；旧公钥 `1605021f` = **0**

## 8. 主实例 8787 恢复（G-29）

- 起停：`kill 4170523`（旧进程已随任务卡描述不存在，实际为本轮先前启动的进程）→ `setsid nohup ./bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml` → **新 PID 175666**，`kore ready`（12:43:22），`/-/healthz` **200**
- 启动方式备注：`--config ./.kore-local.yaml`（相对路径）会让 `Snapshot.ConfigDir()` 回退 `/etc/kore` → `mkdir /etc/kore: permission denied`（退出码 3）；改用**绝对** config 路径即正常。**配置文件内容未改**，仅启动参数用绝对路径。
- 复核原文：
  ```
  index_dir = /home/pt/Work/GolandProjects/kore-plugins/index
  supervisor = {'resident': 2, 'restarts': 0, 'resident_max': 2, 'lazy_slots': 1}
  store_code=200
  count = 24
  redis 0.4.0 OK
  ssh-guard 0.2.0 OK
  logs 0.3.0 OK
  container 0.3.0 OK
  process 0.2.0 OK
  cron 0.4.0 OK
  ```
- store 与索引逐 id 比对 version：`mismatch = []`
- 说明：`make build` 后二次重启主实例（公钥编译期常量，RUNBOOK 铁律 2）；登录复用既有 `kore_session` cookie（`/tmp/kore.jar`，11:31 签发、TTL 12h），未使用/未记录任何明文口令（G-30）

## 9. 提交与推送

- kore-plugins：`d3aba7c`（4 条 + 重签 + 新公钥 + 市场页）+ `198169b`（补 process 0.2.0 / cron 0.4.0，同把公钥重签），精确 add 9 + 5 个文件，**已推 origin + gitee**（均 exit 0）
- kore：`internal/core/market/verify.go`（第 32 把公钥）+ 本报告，精确 add，**只 commit 不 push**（由台账任务统一推 origin+gitee）
- BOARD 变更集登记由台账任务负责（G-15），本轮未改 `.agents/BOARD.md`
