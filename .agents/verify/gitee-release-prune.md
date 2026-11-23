# Gitee release prune · 只保留最新 5 个（19 仓 / 39 条计划，实际净删 41 条）

- 执行时间：2026-11-24 00:5x–01:1x（Asia/Shanghai）
- 工具：`scripts/gitee-release-prune.sh --dry-run --keep 5` → 核对 → `--keep 5` 真删
- 权威源：Gitea（`gitea.iouf.cn`）／GitHub 全量保留；Gitee 仅镜像，删旧不丢历史
- 范围：24 个 `kore-plugin-*` 仓；`kore` / `kore-plugins` 未触碰；tag / main / 源码零改动

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 24 仓总 release 数 | 157 → **118** |
| 触发清理的仓 | **19 个**（另有 discover/echo/monitor/runtime-php/terminal 5 仓原本 ≤5，未动） |
| dry-run 计划删除 | **39 条**，逐条核对全部命中「非最新 5」 |
| 实际净删除 | **41 条**（39 计划 + cron v0.2.1 + integrity v0.3.0，见 §5 偏差） |
| 删除后每仓数量 | 19 仓全部 == **5**（discover / terminal 原本 4 条，保持 4，未删到 5 以下） |
| 最新 5 误删 | **0 条**（integrity v0.4.0 曾因并发窗口移动被误删，已按原 sha 恢复，见 §5） |
| 删除后 119 个资产复核 | **119/119 HTTP 200 + sha256 与基线一致** |
| 跳过仓 | **0**（无版本歧义仓） |
| token 明文 | 未打印、未落盘（G-30） |

## 2. dry-run 完整清单（19 仓 / 39 条）

命令：`scripts/gitee-release-prune.sh --dry-run --keep 5 --repo pengtang1024/<repo> ...`（19 个 `--repo`）

| # | 仓库 | 删除条数 | 计划删除 tag（release id） |
| --- | --- | --- | --- |
| 1 | `kore-plugin-app-deploy` | 2 | `v0.1.1`（1356026）, `v0.1.0`（1356025） |
| 2 | `kore-plugin-backup` | 2 | `v0.2.0`（1356029）, `v0.1.0`（1356028） |
| 3 | `kore-plugin-container` | 2 | `v0.2.0`（1356034）, `v0.1.0`（1356033） |
| 4 | `kore-plugin-cron` | 1 | `v0.2.0`（1356036） |
| 5 | `kore-plugin-db-mysql` | 2 | `v0.2.0`（1356040）, `v0.1.0`（1356039） |
| 6 | `kore-plugin-db-postgres` | 3 | `v0.2.0`（1356046）, `v0.1.1`（1356045）, `v0.1.0`（1356044） |
| 7 | `kore-plugin-dns` | 2 | `v0.1.1`（1356052）, `v0.1.0`（1356051） |
| 8 | `kore-plugin-file` | 1 | `v0.1.0`（1356055） |
| 9 | `kore-plugin-firewall` | 2 | `v0.2.0`（1356060）, `v0.1.0`（1356059） |
| 10 | `kore-plugin-integrity` | 3 | `v0.2.0`（1356067）, `v0.1.1`（1356066）, `v0.1.0`（1356065） |
| 11 | `kore-plugin-logs` | 3 | `v0.2.1`（1356070）, `v0.2.0`（1356069）, `v0.1.0`（1356068） |
| 12 | `kore-plugin-process` | 1 | `v0.1.0`（1356084） |
| 13 | `kore-plugin-redis` | 1 | `v0.1.0`（1356086） |
| 14 | `kore-plugin-runtime-node` | 2 | `v0.1.1`（1356092）, `v0.1.0`（1356091） |
| 15 | `kore-plugin-runtime-python` | 3 | `v0.2.0`（1356099）, `v0.1.1`（1356098）, `v0.1.0`（1356097） |
| 16 | `kore-plugin-site` | 2 | `v0.2.0`（1356104）, `v0.1.0`（1356101） |
| 17 | `kore-plugin-ssh-guard` | 2 | `v0.1.1`（1356107）, `v0.1.0`（1356106） |
| 18 | `kore-plugin-ssl` | 3 | `v0.2.1`（1356112）, `v0.2.0`（1356111）, `v0.1.0`（1356110） |
| 19 | `kore-plugin-waf` | 2 | `v0.1.1`（1356118）, `v0.1.0`（1356117） |
| — | **合计** | **39** | — |

## 3. 逐仓核对（硬判据：绝不删版本最新 5 个）

核对方法：不采信 `created_at`（补建批次实际按版本倒序创建，时间序 ≠ 版本序），改用 **tag 版本号排序**（`sort -V`）求出「历史全量 tag 并集」的最新 5 个，与最终集合逐仓比对。dry-run 时点 19 仓的保留集与版本 top5 完全一致；删除后按并集复核，24 仓最终集合仍等于版本 top5，无歧义（无同版本多 tag 前缀）。

| 仓库 | 删前 | 删除 | 删后 | 保留（版本最新 5） | 核对 |
| --- | --- | --- | --- | --- | --- |
| `kore-plugin-app-deploy` | 7 | 2 | 5 | `v0.2.0,v0.2.1,v0.2.2,v0.3.0,v0.3.1` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-backup` | 7 | 2 | 5 | `v0.2.1,v0.3.0,v0.4.0,v0.4.1,v0.4.2` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-container` | 7 | 2 | 5 | `v0.4.1,v0.5.0,v0.5.1,v0.5.2,v0.5.4` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-cron` | 6 | 2 | 5 | `v0.3.0,v0.4.0,v0.4.1,v0.5.0,v0.6.0` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-db-mysql` | 7 | 2 | 5 | `v0.3.0,v0.3.1,v0.3.2,v0.4.0,v0.4.1` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-db-postgres` | 8 | 3 | 5 | `v0.2.1,v0.3.0,v0.3.1,v0.3.2,v0.3.3` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-discover` | 4 | 0 | 4 | `v0.1.0,v0.2.0,v0.3.0,v0.3.1` | 无需清理（≤5） |
| `kore-plugin-dns` | 7 | 2 | 5 | `v0.2.0,v0.3.0,v0.3.1,v0.3.2,v0.4.0` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-echo` | 5 | 0 | 5 | `v0.1.0,v0.1.1,v0.1.2,v0.1.3,v0.1.4` | 无需清理（≤5） |
| `kore-plugin-file` | 6 | 1 | 5 | `v0.2.0,v0.2.1,v0.3.0,v0.3.1,v0.3.2` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-firewall` | 7 | 2 | 5 | `v0.2.1,v0.2.2,v0.2.3,v0.2.4,v0.2.6` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-integrity` | 8 | 5 | 5 | `v0.3.1,v0.3.2,v0.3.3,v0.4.0,v0.5.0` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-logs` | 8 | 3 | 5 | `v0.4.0,v0.4.1,v0.4.2,v0.5.0,v0.5.1` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-monitor` | 5 | 0 | 5 | `v0.1.0,v0.1.1,v0.2.0,v0.2.1,v0.3.0` | 无需清理（≤5） |
| `kore-plugin-process` | 6 | 1 | 5 | `v0.1.1,v0.2.0,v0.2.1,v0.2.2,v0.3.0` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-redis` | 6 | 1 | 5 | `v0.2.0,v0.3.0,v0.4.0,v0.5.0,v0.6.0` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-runtime-node` | 7 | 2 | 5 | `v0.2.0,v0.2.1,v0.2.2,v0.2.3,v0.2.4` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-runtime-php` | 5 | 0 | 5 | `v0.1.0,v0.1.1,v0.2.0,v0.2.1,v0.2.2` | 无需清理（≤5） |
| `kore-plugin-runtime-python` | 8 | 3 | 5 | `v0.2.2,v0.2.3,v0.2.4,v0.3.0,v0.3.1` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-site` | 7 | 2 | 5 | `v0.3.1,v0.4.0,v0.4.1,v0.4.2,v0.4.3` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-ssh-guard` | 7 | 2 | 5 | `v0.2.1,v0.2.2,v0.2.3,v0.3.0,v0.3.1` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-ssl` | 8 | 3 | 5 | `v0.3.0,v0.4.0,v0.5.0,v0.5.1,v0.6.0` | ✅ 保留集 == 版本 top5 |
| `kore-plugin-terminal` | 4 | 0 | 4 | `v0.1.0,v0.1.1,v0.2.0,v0.2.1` | 无需清理（≤5） |
| `kore-plugin-waf` | 7 | 2 | 5 | `v0.3.1,v0.4.1,v0.4.2,v0.4.3,v0.4.4` | ✅ 保留集 == 版本 top5 |
| **合计** | **157** | **42**（含恢复前误删 1） | **118** | — | — |

## 4. 被删 release 元数据（删前快照，恢复用）

资产 sha256 为删除前从 Gitee 实际下载计算（HTTP 200 + 完整字节）；`created_at` 为 Gitee 原始创建时间。

| 仓库 | tag | release id | 资产文件 | sha256 | 创建时间 |
| --- | --- | --- | --- | --- | --- |
| `kore-plugin-app-deploy` | `v0.1.0` | 1356025 | `app-deploy-0.1.0.tar.gz` | `c7a6f57dd8a3dcd6e61f6094a703ac3afeceecf770f9b84b5a5c7c0b4a26ecf9` | 2026-11-23 11:00:40+08:00 |
| `kore-plugin-app-deploy` | `v0.1.1` | 1356026 | `app-deploy-0.1.1.tar.gz` | `8d2d9c863064dcc1ade0371c66d68187c2c699b7623b9dfb83f617dc97b7368d` | 2026-11-23 11:00:42+08:00 |
| `kore-plugin-backup` | `v0.1.0` | 1356028 | `backup-0.1.0.tar.gz` | `9042bf54d18a0f8e26babdef008d492bc2e0f2d09e27c3a8e7f3c8825d333177` | 2026-11-23 11:00:47+08:00 |
| `kore-plugin-backup` | `v0.2.0` | 1356029 | `backup-0.2.0.tar.gz` | `53885cbbd901419703ccab101546164f4a75cbe42071b1c0bcb53c0aa19fc023` | 2026-11-23 11:00:49+08:00 |
| `kore-plugin-container` | `v0.1.0` | 1356033 | `container-0.1.0.tar.gz` | `4ae731fb056b0dd1d8d7afaf479b6be029953468e54f52d75593c5b9a1f8b9c5` | 2026-11-23 11:01:23+08:00 |
| `kore-plugin-container` | `v0.2.0` | 1356034 | `container-0.2.0.tar.gz` | `da2c5f6f482f95e105a76d7db2ff3a2108ebd2b0db771698fa19ec9ff966f2dd` | 2026-11-23 11:01:24+08:00 |
| `kore-plugin-cron` | `v0.2.0` | 1356036 | `cron-0.2.0.tar.gz` | `4d957c1cc2b16c64fa0d268b7f623352f142ca5d8f784c94baf8865ba6f9a3fe` | 2026-11-23 11:01:34+08:00 |
| `kore-plugin-cron` | `v0.2.1` | 1356037 | `cron-0.2.1.tar.gz` | `3be9ce4ae6c3203783fe0ce05dd487a41bd204a8cec4e3d69a207e3c919dbfdd` | 2026-11-23 11:01:36+08:00 |
| `kore-plugin-db-mysql` | `v0.1.0` | 1356039 | `db-mysql-0.1.0.tar.gz` | `7e02be455a74cde191d9c9295d1925b315f9ef30b490ea3dbc032c35fac92595` | 2026-11-23 11:01:43+08:00 |
| `kore-plugin-db-mysql` | `v0.2.0` | 1356040 | `db-mysql-0.2.0.tar.gz` | `c1ba9c79c81aa531850fee3d73c5fe32d9948540cf9ef559d956cbc20031a3d0` | 2026-11-23 11:01:44+08:00 |
| `kore-plugin-db-postgres` | `v0.1.0` | 1356044 | `db-postgres-0.1.0.tar.gz` | `fbbe9329e83164df8b1cbe852f0d5a6a47d6306805042793b93b99cb718b3742` | 2026-11-23 11:01:54+08:00 |
| `kore-plugin-db-postgres` | `v0.1.1` | 1356045 | `db-postgres-0.1.1.tar.gz` | `49415fff5d2e4f83ce5ddbb0ade0e3f946a33094226c4dd71908a5825ced1ef6` | 2026-11-23 11:01:56+08:00 |
| `kore-plugin-db-postgres` | `v0.2.0` | 1356046 | `db-postgres-0.2.0.tar.gz` | `d315f699a946d8515621a0e2f2e3f8c1f8d20d97ab9e0d52dfcb2d69f7caf74b` | 2026-11-23 11:01:57+08:00 |
| `kore-plugin-dns` | `v0.1.0` | 1356051 | `dns-0.1.0.tar.gz` | `2ed7da0452a21035535affe6691e005350dc5eeb72634ff1f5b34b491f3cae46` | 2026-11-23 11:02:18+08:00 |
| `kore-plugin-dns` | `v0.1.1` | 1356052 | `dns-0.1.1.tar.gz` | `f9843ee8a11ef5c217f61699b15ab969b08d5b4d743f2d4e282a30aeb9332d09` | 2026-11-23 11:02:22+08:00 |
| `kore-plugin-file` | `v0.1.0` | 1356055 | `file-0.1.0.tar.gz` | `567179d079995d43e869be69b667f039e61b8b88bc1489576e005bf0aa197c30` | 2026-11-23 11:02:29+08:00 |
| `kore-plugin-firewall` | `v0.1.0` | 1356059 | `firewall-0.1.0.tar.gz` | `46ad00fff294a5b9b63471cfe4b77c9044b36bc1ca7130856f2debbd45f57699` | 2026-11-23 11:02:39+08:00 |
| `kore-plugin-firewall` | `v0.2.0` | 1356060 | `firewall-0.2.0.tar.gz` | `959f357a4aef382077fd3482772a0066bf860fcfe38ff7deab1349b55968058f` | 2026-11-23 11:02:41+08:00 |
| `kore-plugin-integrity` | `v0.1.0` | 1356065 | `integrity-0.1.0.tar.gz` | `1b51206c0dafe8a4150fcd4b1e2e868cdf0215fff289fbb805ff8db9e9680cf5` | 2026-11-23 11:02:54+08:00 |
| `kore-plugin-integrity` | `v0.1.1` | 1356066 | `integrity-0.1.1.tar.gz` | `748ff72ac7853c3521e9366fa84def5b3ff4ee3a6063501d98c6f533ff71db4b` | 2026-11-23 11:02:55+08:00 |
| `kore-plugin-integrity` | `v0.2.0` | 1356067 | `integrity-0.2.0.tar.gz` | `07c9a83a26393e52f8e0aa996ffbcac1820a4dc0d39a856ae8b06e5f37057f3d` | 2026-11-23 11:02:57+08:00 |
| `kore-plugin-integrity` | `v0.3.0` | 1359707 | `integrity-0.3.0.tar.gz` | `0f17c31e4edede59248a14adfb1606532eefca3199ca75527473e4285385ba4e` | 2026-11-24 00:31:36+08:00 |
| `kore-plugin-logs` | `v0.1.0` | 1356068 | `logs-0.1.0.tar.gz` | `8ff57a55e7028f2e6bd565af48b4c427f492a800b53afa69e75838530bf3cd47` | 2026-11-23 11:03:05+08:00 |
| `kore-plugin-logs` | `v0.2.0` | 1356069 | `logs-0.2.0.tar.gz` | `b503ad9e29d3b52cec2bff07594827855a1b8b50b08cc94ac84908fd9bc4bc30` | 2026-11-23 11:03:07+08:00 |
| `kore-plugin-logs` | `v0.2.1` | 1356070 | `logs-0.2.1.tar.gz` | `b5127b397424cf433656a9d526aae8619adb27f022eea6ec81c202b16e649932` | 2026-11-23 11:03:08+08:00 |
| `kore-plugin-process` | `v0.1.0` | 1356084 | `process-0.1.0.tar.gz` | `d5e0865b4e17b6ab6cf78fe8b9e6cac0ebc3f22635dca40f1dfb16074b2ca42e` | 2026-11-23 11:03:36+08:00 |
| `kore-plugin-redis` | `v0.1.0` | 1356086 | `redis-0.1.0.tar.gz` | `81b304e824e9c133feb2857c407d1dfab3c7c2ae8d3cf581b985178af544a9fe` | 2026-11-23 11:03:44+08:00 |
| `kore-plugin-runtime-node` | `v0.1.0` | 1356091 | `runtime-node-0.1.0.tar.gz` | `0d74850e43e8566c278e0e6f7e0d7aea05de949203f5a58850dcdc36de842d5f` | 2026-11-23 11:03:59+08:00 |
| `kore-plugin-runtime-node` | `v0.1.1` | 1356092 | `runtime-node-0.1.1.tar.gz` | `2d92f0474167c51deb592583e627bfe943596931c5eee717b7341bb5a84db674` | 2026-11-23 11:04:01+08:00 |
| `kore-plugin-runtime-python` | `v0.1.0` | 1356097 | `runtime-python-0.1.0.tar.gz` | `410b67451edda9254eec54c7167ebac3a158f4a4cdcd75c223a3c1f49b38c85b` | 2026-11-23 11:04:30+08:00 |
| `kore-plugin-runtime-python` | `v0.1.1` | 1356098 | `runtime-python-0.1.1.tar.gz` | `3bace78010e1cd422c19e742050eb25f937014517e2550d594107c9817531f27` | 2026-11-23 11:04:31+08:00 |
| `kore-plugin-runtime-python` | `v0.2.0` | 1356099 | `runtime-python-0.2.0.tar.gz` | `8b85d69a5fd8fdabb713ba4c7e15468a57ac520f6e6fe524bc4dca300db8b6ef` | 2026-11-23 11:04:34+08:00 |
| `kore-plugin-site` | `v0.1.0` | 1356101 | `site-0.1.0.tar.gz` | `1273b55b3f6cebad3debceb817cb192639be9500f74bfa01d210285c6e3ad88f` | 2026-11-23 11:04:40+08:00 |
| `kore-plugin-site` | `v0.2.0` | 1356104 | `site-0.2.0.tar.gz` | `5cb01e7bd9f391dd00d171750d48b1b46185cec89cde23b27b85ea72a49058e9` | 2026-11-23 11:05:09+08:00 |
| `kore-plugin-ssh-guard` | `v0.1.0` | 1356106 | `ssh-guard-0.1.0.tar.gz` | `220be885dac2822804f835d6a9156b4eb865ca3d07a34ec67ae66da0097b7519` | 2026-11-23 11:05:17+08:00 |
| `kore-plugin-ssh-guard` | `v0.1.1` | 1356107 | `ssh-guard-0.1.1.tar.gz` | `b840858c49745bd4dcc7701b28bba3c9a8d2385de669fa7c0be321a319771d5e` | 2026-11-23 11:05:20+08:00 |
| `kore-plugin-ssl` | `v0.1.0` | 1356110 | `ssl-0.1.0.tar.gz` | `891adc5affcad5efda41b68f5ee8f21d59867e32c10b4de10a74e80e53ea8453` | 2026-11-23 11:05:30+08:00 |
| `kore-plugin-ssl` | `v0.2.0` | 1356111 | `ssl-0.2.0.tar.gz` | `af6bb5398a940fdc9d03fa17ef1f2c98c510d4a2c83fbe4ae8633cb5bcb620df` | 2026-11-23 11:05:32+08:00 |
| `kore-plugin-ssl` | `v0.2.1` | 1356112 | `ssl-0.2.1.tar.gz` | `8a75cd70c1deeacf87868f28254a5830f7be67c8ceaf2c946a428a3d43d36eb9` | 2026-11-23 11:05:33+08:00 |
| `kore-plugin-waf` | `v0.1.0` | 1356117 | `waf-0.1.0.tar.gz` | `ba7a7e59b48339d4ab081c02b97c160baf286b4f11c181e1ce8e6ba6f9e1f640` | 2026-11-23 11:05:52+08:00 |
| `kore-plugin-waf` | `v0.1.1` | 1356118 | `waf-0.1.1.tar.gz` | `6d7c384d919429233146b043ae38d6b90dc2afdad7a2f8bff6077c0c09007f5a` | 2026-11-23 11:05:54+08:00 |

共 **41 条 release / 41 个资产**（db-mysql 等被删条均为单资产）。

### 4.1 与本地 `dist/` sha256 对照（记录不阻断）

| 项 | 数量 | 说明 |
| --- | --- | --- |
| 与本地 `dist/<id>-<ver>.tar.gz.sha256` 一致 | 37 | 删的就是本地构建的那一份 |
| 不一致（漂移） | **0** | 无「firewall v0.2.3 式」漂移落在被删集合内 |
| 本地无对应 sha 文件 | 4 | `file v0.1.0`、`logs v0.1.0/0.2.0/0.2.1`——本地 `dist/` 已只保留近期版本，无对照，不阻断 |

> 观察（非本轮引入）：**保留项** `firewall v0.2.3` 的 Gitee 实测 sha256 = `353d5626…`，本地 `dist/firewall-0.2.3.tar.gz.sha256` = `9c637faa…`，两者漂移；该条属最新 5，本轮不删，仅记录供商家/索引侧核对。

## 5. 偏差与纠正（并发新建 release 导致窗口移动）

执行窗口内（00:59:57–00:59:59）出现**并发写入**，在 2 个仓新增了 release（`cron v0.6.0`、`integrity v0.5.0`，均落在我 dry-run 之后、真删之前）：

| 仓 | 现象 | 处置 |
| --- | --- | --- |
| `kore-plugin-cron` | 真删时总数 6→7，脚本按「最新 5」窗口把 `v0.2.1` 挤出并删除 | 符合版本排序策略（v0.2.1 已是第 6 新），**保留现状**；元数据已记录（§4） |
| `kore-plugin-integrity` | 真删时总数 8→9，`created_at` 窗口把 `v0.4.0`（版本第 2 新）挤出并删除，同时漏删 `v0.3.0` | **按版本排序纠正**：用本地 `dist/integrity-0.4.0.tar.gz` 重建 `v0.4.0`（资产 sha256 = `4358320e…` 与删前一致），再删除 `v0.3.0`；现保留 `v0.3.1/0.3.2/0.3.3/0.4.0/0.5.0`，纠正完成 |

**根因**：`gitee-release-prune.sh` 以 `created_at` 排序判定「最新」，而补建批次实际按版本倒序创建（`v0.4.0` 早于 `v0.3.0` 落库），时间序与版本序不一致。**建议**（未在本轮改脚本，避免超范围）：prune 改为按 tag 语义版本排序。

## 6. 删除后可下载复核（24 仓最新 5 个）

复核方式：对当前 118 条 release 的 **119 个发行资产**逐个 `GET releases/download/...`，断言 HTTP 200 + 下载字节 sha256 与删前基线一致。

| 复核项 | 结果 |
| --- | --- |
| 当前资产总数 | 119（118 release；`db-mysql v0.3.0` 含 tar.gz + .sha256 两资产） |
| HTTP 200 | 119/119 |
| sha256 与删前基线一致 | 117/117（有基线者全部一致） |
| 并发新建 release（无删前基线） | 2/2 与本仓 `dist/*.sha256` 一致（`cron v0.6.0`、`integrity v0.5.0`） |
| 不一致 | **0** |

逐仓（当前 release 数 / 资产复核）：

| 仓库 | release | 资产复核 |
| --- | --- | --- |
| `kore-plugin-app-deploy` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-backup` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-container` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-cron` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-db-mysql` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-db-postgres` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-discover` | 4 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-dns` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-echo` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-file` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-firewall` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-integrity` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-logs` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-monitor` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-process` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-redis` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-runtime-node` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-runtime-php` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-runtime-python` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-site` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-ssh-guard` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-ssl` | 5 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-terminal` | 4 | ✅ 全部 200 + sha 一致 |
| `kore-plugin-waf` | 5 | ✅ 全部 200 + sha 一致 |

## 7. 跳过项

- **无**。19 仓版本排序唯一确定，不存在「同版本不同 tag 前缀」歧义，未跳过任何仓。
- 5 个原本 ≤5 条的仓（discover 4 / terminal 4 / echo 5 / monitor 5 / runtime-php 5）不在清理范围，零改动。

## 8. 约束遵守

- G-30：`GITEE_TOKEN` 仅从环境变量注入，未 echo、未写入任何文件；curl URL 含 token 的部分未落盘到证据文件。
- 不动 tag / main / 源码：本轮仅调用 Gitee release / attach_files 删除接口与 1 次 release 重建（integrity v0.4.0，tag 未动）；24 个插件仓工作树零改动。
- 只处理 24 个插件仓；`kore` / `kore-plugins` 未处理。
- 未删到 5 个以下：最小仓 4 条（本就没有第 5 条）。
- 资产 sha256 与本地 `dist/` 不一致：被删集合内 **0 例**（§4.1）；保留项 `firewall v0.2.3` 的既有漂移已记录，不属本轮范围。

## 9. 证据文件

- `scripts/gitee-release-prune.sh`（工具，未改）
- 原始快照/日志：`.agents/verify/tmp/gitee-prune/`（gitignored，任务后清理）
- `delete.log` 全部 19 仓 `[OK]`：无 `[FAIL]` / `[WARN]` 行；每仓「清理后 release 数: 5」由脚本回读 API 打印
- 命令回放：`GITEE_TOKEN=*** scripts/gitee-release-prune.sh --dry-run --keep 5 --repo pengtang1024/<repo>` → 核对 → 去掉 `--dry-run`
