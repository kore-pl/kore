# Gitea 批量推送报告（gitea-batch-push）

- 执行时间：2026-11-25 20:15–20:17 CST (Asia/Shanghai)
- 授权：用户 2026-11-25 新授权「kore 相关项目都可以频繁推送到 Gitea（origin，权威源）」
- 范围：26 个独立 git 仓库（kore + kore-plugins + 24 插件）
- 硬约束：仅推 Gitea origin；每仓恰好一次 push、一次带全部待推 ref；不 force / 不 --all / 不改代码或索引 / 不 stage / 不 commit 他人改动 / 不新建 tag / 不触发 CI（GitHub workflow_dispatch 未触发）。

## 一、盘点表（推送前只读快照）

| 仓库 | 领先数(origin/main..HEAD) | 落后数 | 待推新 tag（本地有、origin 无） | 是否有未提交改动 | origin 指向 Gitea |
|---|---|---|---|---|---|
| kore | 158 | 0 | 无 | 是 | 是 |
| kore-plugins | 0 | 0 | 无 | 是(.tmp-validate-out.txt) | 是 |
| kore-plugin-app-deploy | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-backup | 1 | 0 | 无 | 否 | 是 |
| kore-plugin-container | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-cron | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-db-mysql | 2 | 0 | 无 | 是 | 是 |
| kore-plugin-db-postgres | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-discover | 2 | 0 | 无 | 是 | 是 |
| kore-plugin-dns | 2 | 0 | 无 | 是（7 个 .go 已修改） | 是 |
| kore-plugin-echo | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-file | 2 | 0 | 无 | 是 | 是 |
| kore-plugin-firewall | 1 | 0 | 无 | 否 | 是 |
| kore-plugin-integrity | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-logs | 2 | 0 | 无 | 是 | 是 |
| kore-plugin-monitor | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-process | 2 | 0 | 无 | 是 | 是 |
| kore-plugin-redis | 2 | 0 | 无 | 是 | 是 |
| kore-plugin-runtime-node | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-runtime-php | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-runtime-python | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-site | 0 | 0 | v0.7.0, v0.8.0 | 是 | 是 |
| kore-plugin-ssh-guard | 1 | 0 | 无 | 是 | 是 |
| kore-plugin-ssl | 1 | 0 | 无 | 否 | 是 |
| kore-plugin-terminal | 2 | 0 | 无 | 是 | 是 |
| kore-plugin-waf | 1 | 0 | 无 | 是 | 是 |

把关结论：26 仓 BEHIND 全为 0，merge-base(HEAD, origin/main) == origin/main（严格快进），无分叉、无落后 → 全部允许推送。26 仓 origin 全部为 https://gitea.iouf.cn/kore-pl/*.git（Gitea）。

## 二、批推命令与退出码（每仓恰好一次 git push）

每仓命令形式：`git push origin main`（有领先提交时）；kore-plugin-site 无领先提交，仅推两个新 tag：`git push origin refs/tags/v0.7.0:refs/tags/v0.7.0 refs/tags/v0.8.0:refs/tags/v0.8.0`；kore-plugins 无领先提交、无新 tag，跳过（未调用 push）。

| 仓库 | push 命令 | 退出码 | 结果摘要 |
|---|---|---|---|
| kore | git push origin main | 0 | 80f6c48..c8d0af7 main |
| kore-plugins | （跳过：无可推 ref） | — | 本地与 origin 已一致 |
| kore-plugin-app-deploy | git push origin main | 0 | a7fcf91..5fdc3ac |
| kore-plugin-backup | git push origin main | 0 | cf0dcd8..9664b5d |
| kore-plugin-container | git push origin main | 0 | f5dd1a6..cc39aa1 |
| kore-plugin-cron | git push origin main | 0 | 3dcda55..e16e1b1 |
| kore-plugin-db-mysql | git push origin main | 0 | 5a488e9..0eaa3f3 |
| kore-plugin-db-postgres | git push origin main | 0 | 4d43ed1..4588fa7 |
| kore-plugin-discover | git push origin main | 0 | 07e4ad7..a4c83ce |
| kore-plugin-dns | git push origin main | 0 | e2324e9..0ebc20c |
| kore-plugin-echo | git push origin main | 0 | 319ac6e..972927e |
| kore-plugin-file | git push origin main | 0 | 326e803..b1956ae |
| kore-plugin-firewall | git push origin main | 0 | 553d247..4120e96 |
| kore-plugin-integrity | git push origin main | 0 | 527058f..fd452c2 |
| kore-plugin-logs | git push origin main | 0 | 221e064..caef68b |
| kore-plugin-monitor | git push origin main | 0 | 4395d1f..952b0a2 |
| kore-plugin-process | git push origin main | 0 | 1dcfa9b..0b86028 |
| kore-plugin-redis | git push origin main | 0 | f436775..5dc57ae |
| kore-plugin-runtime-node | git push origin main | 0 | c334882..45a0cc8 |
| kore-plugin-runtime-php | git push origin main | 0 | 8aa665e..c18f768 |
| kore-plugin-runtime-python | git push origin main | 0 | 856e8e3..72f0d26 |
| kore-plugin-site | git push origin refs/tags/v0.7.0:refs/tags/v0.7.0 refs/tags/v0.8.0:refs/tags/v0.8.0 | 0 | 2 个 new tag |
| kore-plugin-ssh-guard | git push origin main | 0 | bcd6e53..64befa2 |
| kore-plugin-ssl | git push origin main | 0 | e46010b..aa54871 |
| kore-plugin-terminal | git push origin main | 0 | 844a7ef..6b23b97 |
| kore-plugin-waf | git push origin main | 0 | 7e40fc8..bc7f8fc |

说明：每次 push 输出中的「fatal: 无法在 1000 ms 获得凭证存储锁: 只读文件系统」是只读沙箱下 credential helper 的无害告警；所有 push 均报告了成功的 ref 更新并以退出码 0 结束。

注：kore 盘点时本地 HEAD 为 bd222f6，推送期间有并发提交落入，实际推送时本地 HEAD 已前进到 c8d0af7；push 采用当时本地 HEAD，回读确认远端 = c8d0af7（见下）。未 amend / reset / rebase。

## 三、回读对齐（git ls-remote 逐仓比对）

对全部 26 仓读回 `git ls-remote origin refs/heads/main`，与本地 HEAD SHA 比对；并逐 tag 比对本地 tag SHA 与远端 tag SHA。

- ALIGNED：26 / 26
- MISALIGNED：0
- 对齐清单（local=remote，前 8 位）：kore c8d0af76、kore-plugins e2f8bbf6、app-deploy 5fdc3ac7、backup 9664b5d6、container cc39aa1d、cron e16e1b1f、db-mysql 0eaa3f3d、db-postgres 4588fa7b、discover a4c83cef、dns 0ebc20c3、echo 972927ee、file b1956ae3、firewall 4120e96a、integrity fd452c28、logs caef68b6、monitor 952b0a27、process 0b860284、redis 5dc57aeb、runtime-node 45a0cc84、runtime-php c18f7683、runtime-python 72f0d26a、site 67133a71（含新 tag v0.7.0 / v0.8.0 已对齐）、ssh-guard 64befa23、ssl aa54871f、terminal 6b23b97e、waf bc7f8fcc。

## 四、未提交项清单（未 stage / 未 commit / 未 stash，如实记录）

- kore：M scripts/usability-pending.txt；未跟踪 .agents/verify/{e2e-content-write,e2e-deploy-write,e2e-system-write,local-update-plan,release-batch-plan,release-batch-prep,release-inject-verify,run-user-model}.md、.agents/verify/screenshots/adp-debug-desktop-01.png、data/
- kore-plugins：?? .tmp-validate-out.txt
- kore-plugin-app-deploy：?? zero_param_test.go
- kore-plugin-container：?? zeroparam_test.go
- kore-plugin-cron：?? zeroparam_test.go
- kore-plugin-db-mysql：?? internal/mysqlop/zeroparam_test.go
- kore-plugin-db-postgres：?? zeroparam_test.go
- kore-plugin-discover：?? zeroparam_test.go
- kore-plugin-dns：M config.go、internal/dnsop/{call,nsupdate,recordwrite,validate,write_engine,zone}.go（7 个已修改）
- kore-plugin-echo：?? zeroparam_test.go
- kore-plugin-file：?? internal/fileop/zeroparam_test.go
- kore-plugin-integrity：?? zeroparam_test.go
- kore-plugin-logs：?? zeroparam_test.go
- kore-plugin-monitor：?? zeroparam_test.go
- kore-plugin-process：?? internal/procfs/zeroparam_test.go
- kore-plugin-redis：?? internal/redisop/zeroparam_test.go
- kore-plugin-runtime-node：?? internal/nodeop/zeroparam_test.go
- kore-plugin-runtime-php：?? internal/phpop/zeroparam_test.go
- kore-plugin-runtime-python：?? internal/pyop/zeroparam_test.go
- kore-plugin-site：MM apply.go、D (staged) rollback.go、D (staged) tests/boundary/rollback_window_test.go；未跟踪 rollback.go、tests/boundary/rollback_window_test.go、zeroparam_test.go（site 的在途 6 行/回滚改动保持原样，未处理）
- kore-plugin-ssh-guard：?? zeroparam_test.go
- kore-plugin-terminal：?? zeroparam_test.go
- kore-plugin-waf：?? internal/wafop/zeroparam_test.go

## 五、诚实声明

- 本次只推 Gitea origin（gitea.iouf.cn），未推 github、未推 gitee。
- 未触发 GitHub CI（ci.yml 仍仅 workflow_dispatch，未主动触发）；未新建 tag、未触发 tag CI。
- 本报告 commit 后不 push（避免自己推自己造成无限递归）；留待下一批推送。
- 未使用 force-push、未使用 --all、未 amend/reset/rebase、未改任何代码/配置/索引/安装脚本、未碰运行态。
- 临时脚本：本次所有检查/推送逻辑以单次 bash 内联执行，未在工作区留下任何临时文件。

## 结论

推送 25 仓（24 推 main + site 推 2 tag；kore-plugins 无可推 ref 跳过），回读对齐 26/26，无失败；各仓存在未提交改动（详见第四节），按要求未 stage/未提交。
