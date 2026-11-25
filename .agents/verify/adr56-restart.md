# ADR-0056 落地报告：自服务重启 / 自更新闭环（T3+T4）

> 角色：implementer（restart-fix） · 日期：2026-11-25 · 结论：代码落地完成，本地验证全绿；未 push / 未触发 CI / 未改运行态文件与系统配置。

## 一句话结论

统一自重启原语 SelfRestart（薄壳、只收 reason+unit）已落地，HTTP/CLI 双入口共用 reason-bound confirm + fail-closed 审计 + flush + --no-block 提交链，冷字段（含 paths.index_dir）写入返回 restart_required，新进程补跑 post_upgrade_pending；验证全绿。

## 实现清单（按 ADR-0056 §裁决/设计要点）

1. 统一原语 internal/core/privilege/restart.go：SelfRestart(reason, actor, unit)；root+kore.service → BuildRestartArgv/RestartUnitNoBlock（--no-block）；非 root+显式 user unit → systemctl --user --no-block restart；无 systemd/无 unit/非法 unit → E_NO_SELF_RESTART + 白话 hint（fail-closed）。unit 名保守字符集校验，杜绝注入。
2. confirm 绑定 internal/core/privilege/confirm.go：新增 IssueWithReason/ConsumeWithReason，令牌绑 action=system.restart + reason（5 分钟一次性），理由以摘要存内存，不落盘。
3. HTTP 入口 POST /api/v1/system/restart + GET .../confirm-token（handlers_restart.go）：会话 + system:admin + reason-bound confirm；缺 confirm → 401；202 = 已提交 ≠ 已生效；并发排队不合并。
4. CLI 入口 kored restart --reason "..." [--yes|--confirm]（cmd/kored/restart.go）：同原语、同 confirm、同审计；main.go 加分发。
5. 冷字段联动 POST /api/v1/system/config + internal/core/config/writer.go：复用 reload.go 的 coldChanged（含 paths.index_dir）判据，命中返回 restart_required:true；配置行级原子写，保留注释。
6. 离线升级收尾：flushRestartPending 提交前校验 upgrade-result.json/plugin_state/配置落盘；新进程在 buildService 里 resumePendingPostUpgrade() 补跑已启用插件的 pending marker。
7. fail-closed + 审计：system.restart 审计事件记 actor/reason/unit/decision/flush_state/commit_result/结果，不记 token；审计写不进不提交；deny 也写审计。
8. CI/版本控制硬边界：代码只做本地 unit 重启，无 git push/tag/PR、无远端访问；未触碰 CI 配置与运行态资产。

## 验证证据（命令 + 退出码 + 关键输出）

- go test -timeout 200s ./...（GOWORK=off CGO_ENABLED=0）：exit 0，17 包全 ok。
- go vet ./...：exit 0。
- make secret-check：exit 0（0 FAIL / 23 处合规占位）。
- mock unit 验证（无真实 systemd、无 8787、不真重启宿主）：
  - TestSelfRestartRootUsesSystemUnitAndNoBlock PASS：argv = systemctl --no-block restart kore.service。
  - TestSelfRestartUserUnit PASS：user 分支 argv 含 --user --no-block restart kored-local.service。
  - TestSelfRestartNoSystemdFailsClosed PASS：无 systemd → E_NO_SELF_RESTART + hint。
  - TestSystemRestartNoConfirm PASS：无 confirm → 401，原语零调用。
  - TestSystemRestartNoUnit PASS：E_NO_SELF_RESTART + "本实例不是服务运行" hint。
  - TestConfirmReasonBinding PASS：错 reason/重用令牌均被拒。
  - TestColdFieldsChangedIndexDir / TestWriteConfigUpdatesAtomicAndRestartRequired PASS：改 index_dir 命中冷字段、原子写保留注释。

## 隔离与副作用声明

- 本轮未改动主实例运行态配置（.kore-local.yaml / .kore-local-state / .kore-local-run / bin/kored），未访问 8787，未操作真实 systemd/用户 bus，未真重启宿主。
- 临时 Go 缓存目录（.gocache-restart/.gopath-restart）已删除，git status 无残留。
- 未 push、未触发 CI；commit 精确 pathspec + [agent:restart-fix]。

## 写域

cmd/kored/{main.go,restart.go(新),serve_boot.go,serve_runtime.go}；internal/core/privilege/{confirm.go,restart.go(新),restart_test.go(新)}；internal/core/httpapi/{server.go,handlers_restart.go(新),handlers_restart_test.go(新)}；internal/core/config/{writer.go(新),writer_test.go(新)}；本报告 .agents/verify/adr56-restart.md。
