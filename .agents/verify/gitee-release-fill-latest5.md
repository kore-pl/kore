# Gitee release 补建验收：每仓最新 5 个 tag（2026-11-24）

> 策略（用户裁定）：**每个仓取最新的 5 个 tag，缺 release 的补建；更老的 release 保持不动**。
> Gitee 是镜像、只保留最新 5 个，所以这 5 个必须是最近版本可下载。**本轮不执行任何 prune/删除。**

## 0. 结论

| 项 | 结果 |
| --- | --- |
| dry-run 范围 | 24 个插件仓（`kore` / `kore-plugins` 不处理） |
| 计划补建 | **83 个 tag**（最新 5 窗口内），全部有本地 `dist/` 产物 |
| 实际补建 | **83/83 成功**，0 失败；逐仓 `现有 + 新建 = 补建后` 全部对账一致 |
| 补建后 release 总数 | 157（补建前 74） |
| 超 5 的仓 | **19 个**（只列 prune 清单，未删除） |
| 无法补建 | **0**（每仓所需 tag 的 `dist/<id>-<ver>.tar.gz` 均存在，未重新构建） |
| 资产校验 | 117 条 sha256 一致；1 条**既有**漂移（firewall v0.2.3，非本轮创建，见 §6） |
| 公开视角 | 118/118 未鉴权 release 页面 200；匿名 API 被 IP 限流 403（见 §5） |

## 1. 执行口径

```bash
# 凭据：仅从 ~/.git-credentials 经 git credential fill 取用进 GITEE_TOKEN，未打印、未落盘
# 每仓独立跑，--latest 5 只取最新 5 个 tag，--require-dist 无产物则跳过而非建空 release
bash scripts/gitee-release-fill.sh --dry-run --latest 5 --require-dist --dir ../kore-plugin-<id> ...
bash scripts/gitee-release-fill.sh          --latest 5 --require-dist --dir ../kore-plugin-<id> ...
```

脚本本轮新增（本次一并提交）：

- `--latest N`：只处理最新 N 个 tag（`--sort=-v:refname` 后取头 N），策略可复现；
- `--require-dist`：本地无 `dist/<id>-<ver>.tar.gz` 时跳过、不建空 release，计入「无法补建」；
- dry-run 每仓一行计划汇总（新建数 + 补建后 release 数）；
- 非 dry-run 追加**未鉴权公开视角** `GET /releases/tags/<tag>` 校验（403/429 退避重试）。

## 2. dry-run 计划（24 仓 / 83 tag）

| 仓库 | v* tag | 补建前 release | 计划补建 | 补建后 | 超 5 |
| --- | ---: | ---: | ---: | ---: | :--: |
| kore-plugin-app-deploy | 7 | 4 | 3 | 7 | **是** |
| kore-plugin-backup | 7 | 3 | 4 | 7 | **是** |
| kore-plugin-container | 9 | 3 | 4 | 7 | **是** |
| kore-plugin-cron | 6 | 2 | 4 | 6 | **是** |
| kore-plugin-db-mysql | 7 | 4 | 3 | 7 | **是** |
| kore-plugin-db-postgres | 8 | 4 | 4 | 8 | **是** |
| kore-plugin-discover | 4 | 2 | 2 | 4 | 否 |
| kore-plugin-dns | 7 | 2 | 5 | 7 | **是** |
| kore-plugin-echo | 5 | 3 | 2 | 5 | 否 |
| kore-plugin-file | 6 | 3 | 3 | 6 | **是** |
| kore-plugin-firewall | 7 | 5 | 2 | 7 | **是** |
| kore-plugin-integrity | 8 | 3 | 5 | 8 | **是** |
| kore-plugin-logs | 9 | 4 | 4 | 8 | **是** |
| kore-plugin-monitor | 5 | 4 | 1 | 5 | 否 |
| kore-plugin-process | 6 | 2 | 4 | 6 | **是** |
| kore-plugin-redis | 6 | 3 | 3 | 6 | **是** |
| kore-plugin-runtime-node | 7 | 3 | 4 | 7 | **是** |
| kore-plugin-runtime-php | 5 | 3 | 2 | 5 | 否 |
| kore-plugin-runtime-python | 8 | 3 | 5 | 8 | **是** |
| kore-plugin-site | 8 | 2 | 5 | 7 | **是** |
| kore-plugin-ssh-guard | 8 | 3 | 4 | 7 | **是** |
| kore-plugin-ssl | 8 | 3 | 5 | 8 | **是** |
| kore-plugin-terminal | 4 | 3 | 1 | 4 | 否 |
| kore-plugin-waf | 9 | 3 | 4 | 7 | **是** |
| **合计** | — | **74** | **83** | **157** | 19 仓 |

逐 tag 明细（补建清单）：

| 仓库 | 补建的 tag |
| --- | --- |
| kore-plugin-app-deploy | v0.3.0, v0.2.2, v0.2.1 |
| kore-plugin-backup | v0.4.2, v0.4.1, v0.4.0, v0.3.0 |
| kore-plugin-container | v0.5.2, v0.5.1, v0.5.0, v0.4.1 |
| kore-plugin-cron | v0.5.0, v0.4.1, v0.4.0, v0.3.0 |
| kore-plugin-db-mysql | v0.4.1, v0.4.0, v0.3.2 |
| kore-plugin-db-postgres | v0.3.3, v0.3.2, v0.3.1, v0.3.0 |
| kore-plugin-discover | v0.3.1, v0.3.0 |
| kore-plugin-dns | v0.4.0, v0.3.2, v0.3.1, v0.3.0, v0.2.0 |
| kore-plugin-echo | v0.1.4, v0.1.0 |
| kore-plugin-file | v0.3.2, v0.3.1, v0.3.0 |
| kore-plugin-firewall | v0.2.6, v0.2.4 |
| kore-plugin-integrity | v0.4.0, v0.3.3, v0.3.2, v0.3.1, v0.3.0 |
| kore-plugin-logs | v0.5.0, v0.4.2, v0.4.1, v0.4.0 |
| kore-plugin-monitor | v0.3.0 |
| kore-plugin-process | v0.3.0, v0.2.2, v0.2.1, v0.2.0 |
| kore-plugin-redis | v0.6.0, v0.5.0, v0.4.0 |
| kore-plugin-runtime-node | v0.2.4, v0.2.3, v0.2.2, v0.2.1 |
| kore-plugin-runtime-php | v0.2.2, v0.2.1 |
| kore-plugin-runtime-python | v0.3.1, v0.3.0, v0.2.4, v0.2.3, v0.2.2 |
| kore-plugin-site | v0.4.3, v0.4.2, v0.4.1, v0.4.0, v0.3.1 |
| kore-plugin-ssh-guard | v0.3.0, v0.2.3, v0.2.2, v0.2.1 |
| kore-plugin-ssl | v0.6.0, v0.5.1, v0.5.0, v0.4.0, v0.3.0 |
| kore-plugin-terminal | v0.2.0 |
| kore-plugin-waf | v0.4.3, v0.4.2, v0.4.1, v0.3.1 |

> 缺口总数 90（`docs/GITEE-MIRROR.md` §8.6 快照）中，有 7 个落在「最新 5」窗口之外（更老版本），按策略**本轮不补**。

## 3. 实际执行结果

6 组并发（每仓独立进程、同一脚本），组日志退出码：g0/g1/g2/g3/g5 `[DONE]`，g4 `[FAIL]` 仅因 §6 的既有漂移，非补建失败。

| 仓库 | 本次新建 | 上传资产 | 补建后 release |
| --- | ---: | ---: | ---: |
| kore-plugin-app-deploy | 3 | 3 | 7 |
| kore-plugin-backup | 4 | 4 | 7 |
| kore-plugin-container | 4 | 4 | 7 |
| kore-plugin-cron | 4 | 4 | 6 |
| kore-plugin-db-mysql | 3 | 3 | 7 |
| kore-plugin-db-postgres | 4 | 4 | 8 |
| kore-plugin-discover | 2 | 2 | 4 |
| kore-plugin-dns | 5 | 5 | 7 |
| kore-plugin-echo | 2 | 2 | 5 |
| kore-plugin-file | 3 | 3 | 6 |
| kore-plugin-firewall | 2 | 2 | 7 |
| kore-plugin-integrity | 5 | 5 | 8 |
| kore-plugin-logs | 4 | 4 | 8 |
| kore-plugin-monitor | 1 | 1 | 5 |
| kore-plugin-process | 4 | 4 | 6 |
| kore-plugin-redis | 3 | 3 | 6 |
| kore-plugin-runtime-node | 4 | 4 | 7 |
| kore-plugin-runtime-php | 2 | 2 | 5 |
| kore-plugin-runtime-python | 5 | 5 | 8 |
| kore-plugin-site | 5 | 5 | 7 |
| kore-plugin-ssh-guard | 4 | 4 | 7 |
| kore-plugin-ssl | 5 | 5 | 8 |
| kore-plugin-terminal | 1 | 1 | 4 |
| kore-plugin-waf | 4 | 4 | 7 |
| **合计** | **83** | **83** | **157** |

## 4. 验收证据

| 验收项 | 证据 |
| --- | --- |
| `POST /releases` → 201 | 83 次建 release 全部 `HTTP 201`，返回 id 逐条记录在组日志 |
| 资产上传 → 201 | 83 次 `HTTP 201` |
| 资产下载 → 200 + sha256 逐字一致 | 117 条 `[OK] <tag> 资产校验 http=200 sha256=<sha>`；1 条既有漂移见 §6 |
| 公开可见 | 118/118 条 `GET /releases/tag/<tag>` 未鉴权页面 200（见 §5） |
| 幂等 | 重复运行只补缺；本轮已完整条目计入「已完整 N」 |

## 5. 两个 Gitee API 坑（本轮复现，已在脚本内固化）

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 建 release 必须传 `target_commitish` | 即便 tag 已存在，Gitee 仍要求该字段 | 传 `git rev-parse <tag>^{commit}`（脚本已固化） |
| 端点不收 JSON body | JSON body 报 400 且 message/errors 为空 | 改 `curl --data-urlencode` 表单编码（脚本已固化） |

**匿名 API 限流（环境事实，非 release 问题）**：未鉴权 `GET /api/v5/releases/tags/<tag>` 在累计约 30 次后返回
`403 Forbidden (Rate Limit Exceeded)`，持续数十分钟；同一端点带 token 恒为 200，未鉴权**网页**与**资产下载**均正常。
因此公开视角用两条独立证据代替匿名 JSON API：

1. 未鉴权 `GET https://gitee.com/pengtang1024/<repo>/releases/tag/<tag>` → **200**（页面含该 tag）；
2. 脚本内资产下载 `curl -sSL <browser_download_url>` **不带任何鉴权头** → 200 且 sha256 一致。

## 6. 已知问题（既有，非本轮引入）

**`kore-plugin-firewall` v0.2.3 资产 sha256 漂移**：

```text
本地 ../kore-plugin-firewall/dist/firewall-0.2.3.tar.gz : 9c637faa1013b6d9eefdc1f2a20f1db47420a597d6f52a7ec65696b2133df753 (2808488 B, mtime 11-23 13:28)
Gitee v0.2.3 已上传资产回读                            : 353d5626453276b2adeae4db935c2eb6837e84e2e59f052d96828d568b8c651b
Gitee v0.2.3 release 创建时间                          : 2026-11-23 11:02:46 +0800
tag v0.2.3 commit                                     : 9b41607 2026-11-23 06:52:51 +0800
```

判读：release 早于本地 `dist/` 重建时间（11:02 → 13:28），`dist/` 不入库（tag 内无该文件），
属「同一 `id@version` 重新打包」类风险（G-17）。**本轮不动 tag、不重建、不覆盖已发布资产**，交 owner 裁决。
v0.2.6（当前索引版本）sha256 = `f03422…f44e`，与索引一致。

## 7. 超 5 清单（19 仓，补建后）

| 仓库 | 补建后 release 数 | 超出 | 处置 |
| --- | ---: | ---: | --- |
| kore-plugin-app-deploy | 7 | 2 | 仅立项，未删除 |
| kore-plugin-backup | 7 | 2 | 仅立项，未删除 |
| kore-plugin-container | 7 | 2 | 仅立项，未删除 |
| kore-plugin-cron | 6 | 1 | 仅立项，未删除 |
| kore-plugin-db-mysql | 7 | 2 | 仅立项，未删除 |
| kore-plugin-db-postgres | 8 | 3 | 仅立项，未删除 |
| kore-plugin-dns | 7 | 2 | 仅立项，未删除 |
| kore-plugin-file | 6 | 1 | 仅立项，未删除 |
| kore-plugin-firewall | 7 | 2 | 仅立项，未删除 |
| kore-plugin-integrity | 8 | 3 | 仅立项，未删除 |
| kore-plugin-logs | 8 | 3 | 仅立项，未删除 |
| kore-plugin-process | 6 | 1 | 仅立项，未删除 |
| kore-plugin-redis | 6 | 1 | 仅立项，未删除 |
| kore-plugin-runtime-node | 7 | 2 | 仅立项，未删除 |
| kore-plugin-runtime-python | 8 | 3 | 仅立项，未删除 |
| kore-plugin-site | 7 | 2 | 仅立项，未删除 |
| kore-plugin-ssh-guard | 7 | 2 | 仅立项，未删除 |
| kore-plugin-ssl | 8 | 3 | 仅立项，未删除 |
| kore-plugin-waf | 7 | 2 | 仅立项，未删除 |

## 8. 需 prune 清单（**只列不删**，等授权）

格式：`仓 | 要删的 release | 理由`。合计 **19 仓 / 39 条**。

| 仓 | 要删的 release | 理由 |
| --- | --- | --- |
| kore-plugin-app-deploy | v0.1.1,v0.1.0 | 超出最新 5（保留 v0.3.1,v0.3.0,v0.2.2,v0.2.1,v0.2.0） |
| kore-plugin-backup | v0.2.0,v0.1.0 | 超出最新 5（保留 v0.4.2,v0.4.1,v0.4.0,v0.3.0,v0.2.1） |
| kore-plugin-container | v0.2.0,v0.1.0 | 超出最新 5（保留 v0.5.4,v0.5.2,v0.5.1,v0.5.0,v0.4.1） |
| kore-plugin-cron | v0.2.0 | 超出最新 5（保留 v0.5.0,v0.4.1,v0.4.0,v0.3.0,v0.2.1） |
| kore-plugin-db-mysql | v0.2.0,v0.1.0 | 超出最新 5（保留 v0.4.1,v0.4.0,v0.3.2,v0.3.1,v0.3.0） |
| kore-plugin-db-postgres | v0.2.0,v0.1.1,v0.1.0 | 超出最新 5（保留 v0.3.3,v0.3.2,v0.3.1,v0.3.0,v0.2.1） |
| kore-plugin-dns | v0.1.1,v0.1.0 | 超出最新 5（保留 v0.4.0,v0.3.2,v0.3.1,v0.3.0,v0.2.0） |
| kore-plugin-file | v0.1.0 | 超出最新 5（保留 v0.3.2,v0.3.1,v0.3.0,v0.2.1,v0.2.0） |
| kore-plugin-firewall | v0.2.0,v0.1.0 | 超出最新 5（保留 v0.2.6,v0.2.4,v0.2.3,v0.2.2,v0.2.1） |
| kore-plugin-integrity | v0.2.0,v0.1.1,v0.1.0 | 超出最新 5（保留 v0.4.0,v0.3.3,v0.3.2,v0.3.1,v0.3.0） |
| kore-plugin-logs | v0.2.1,v0.2.0,v0.1.0 | 超出最新 5（保留 v0.5.1,v0.5.0,v0.4.2,v0.4.1,v0.4.0） |
| kore-plugin-process | v0.1.0 | 超出最新 5（保留 v0.3.0,v0.2.2,v0.2.1,v0.2.0,v0.1.1） |
| kore-plugin-redis | v0.1.0 | 超出最新 5（保留 v0.6.0,v0.5.0,v0.4.0,v0.3.0,v0.2.0） |
| kore-plugin-runtime-node | v0.1.1,v0.1.0 | 超出最新 5（保留 v0.2.4,v0.2.3,v0.2.2,v0.2.1,v0.2.0） |
| kore-plugin-runtime-python | v0.2.0,v0.1.1,v0.1.0 | 超出最新 5（保留 v0.3.1,v0.3.0,v0.2.4,v0.2.3,v0.2.2） |
| kore-plugin-site | v0.2.0,v0.1.0 | 超出最新 5（保留 v0.4.3,v0.4.2,v0.4.1,v0.4.0,v0.3.1） |
| kore-plugin-ssh-guard | v0.1.1,v0.1.0 | 超出最新 5（保留 v0.3.1,v0.3.0,v0.2.3,v0.2.2,v0.2.1） |
| kore-plugin-ssl | v0.2.1,v0.2.0,v0.1.0 | 超出最新 5（保留 v0.6.0,v0.5.1,v0.5.0,v0.4.0,v0.3.0） |
| kore-plugin-waf | v0.1.1,v0.1.0 | 超出最新 5（保留 v0.4.4,v0.4.3,v0.4.2,v0.4.1,v0.3.1） |

授权后的执行方式（破坏性，本轮不跑）：`bash scripts/gitee-release-prune.sh --dry-run --keep 5` → 复核 → 去 `--dry-run`。

## 9. 无法补建清单

**空**。24 仓 × 最新 5 窗口内全部 tag 都存在 `dist/<id>-<ver>.tar.gz`；未触发任何重新构建。

## 10. 命令与退出码

```text
$ bash scripts/gitee-release-fill.sh --dry-run --latest 5 --require-dist <24 × --dir>   # exit=0，24 仓，83 计划
$ bash scripts/gitee-release-fill.sh --latest 5 --require-dist <24 × --dir>（6 组并发） # 5 组 [DONE] / 1 组 [FAIL]=§6 既有漂移
$ 公开页面巡检 118 条                                                                  # ok=118 bad=0
$ 匿名 API 复探                                                                        # 403 Forbidden (Rate Limit Exceeded)
```

凭据：`git credential fill` 取用，仅存进程环境；报告与日志不含 token。
