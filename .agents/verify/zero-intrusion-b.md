# 验收报告：零侵入阶段 B —— `kored uninstall` 卸载链（ADR-0023）

> 状态: pass · 归属: verifier · 更新: 2026-11-23 · 里程碑: M5
> 对象: commit `593d224`（代码 + 平台 + 文档）；本报告随后单独提交。

## 0. 结论

`kored uninstall` 已实现 ADR-0023 §3.5 豁免 #1（systemd unit）与 #2（`kore-<id>` 用户）的清理，并把豁免 #3（用户批准宿主变更）的账本做成**结构化 op**。实测退出码：`--dry-run` 0、非 TTY 无 `--yes` 2、非 root 要清 unit/用户 6、正常 `--yes` 0（隔离实例）；`make check` 13 段 exit 0、`make zero-intrusion-check` 11 pass。

## 1. 执行序（不可变）

`cmd/kored/uninstall.go` 的 `runUninstallWith` 按序调用：

| 步 | 动作 | 代码位置 |
| --- | --- | --- |
| 1 | `systemctl stop kore.service`（仅 Active） | `internal/platform/linux_cleanup.go` `RemoveServiceUnit` |
| 2 | `systemctl disable kore.service` | 同上 |
| 3 | `rm /etc/systemd/system/kore.service` | 同上（`os.Remove`） |
| 4 | `systemctl daemon-reload` | 同上 |
| 5 | 按 `/etc/passwd` 前缀 `userdel -r` | `linux_cleanup.go` `RemoveAccountsByPrefix` |
| 6 | 打印 `<state>/changes.jsonl` 清单（默认不回滚） | `cmd/kored/uninstall.go` |
| 7 | `--purge`：执行白名单 `purge_op` + 删 state | `cmd/kored/changes.go` `executePurgeOp` |
| 8 | 打印手工步骤 | `cmd/kored/uninstall.go` |

顺序理由：先停再 disable（否则 systemd 仍持有运行单元）；rm 后必须 daemon-reload（否则 systemctl 仍认旧 unit）；`userdel` 放在 unit 清理之后（避免清理期间被重新拉起复用账户）。

## 2. `userdel` 前缀扫描不依赖 state

- `linuxCleanup.RemoveAccountsByPrefix` 只读 `/etc/passwd`（`passwdPath` 可注入，仅测试用），按 `prefix` 匹配、排序；
- 不读 state 目录、不读插件清单、不读 `.kore-local*`——用户先删 state 后仍能清干净；
- 删除前复用建用户时的 `validateAccountName` 正则再校验，非法名进 `Failed`、**不拼 argv**；
- `userdel -r`：插件 home 建为 `/nonexistent`，`-r` 不会误删真实数据；
- `does not exist` 视为成功（幂等）。

## 3. 安全阀实测（隔离安装根 `/tmp/zi-demo`）

```
$ KORE_HOME=/tmp/zi-demo kored uninstall --dry-run
[INFO] 安装根：/tmp/zi-demo
[INFO] 状态目录：/tmp/zi-demo/data
[INFO] unit：/etc/systemd/system/kore.service（清理）
[INFO] 系统用户前缀：kore-（清理）
[DRY-RUN] 以下仅为计划，不做任何变更
[UNIT] unit 不存在且未运行，跳过
[USER] 命中 0 个账户：[]
[CHANGES] /tmp/zi-demo/data/changes.jsonl：0 条记录（坏行 0）
[PURGE] 未指定 --purge：状态目录保留（/tmp/zi-demo/data）
...
EXIT=0

$ KORE_HOME=/tmp/zi-demo kored uninstall </dev/null
uninstall: 非交互环境拒绝执行破坏性清理；确认后加 --yes（或先 --dry-run 看计划）
EXIT=2

$ KORE_HOME=/tmp/zi-demo kored uninstall --yes        # 非 root
uninstall: 清理 systemd unit 与 kore-* 用户需要 root：请用 `sudo kored uninstall`，或加 --keep-service --keep-users 只清状态目录
EXIT=6
```

**踩到的坑**：最初用 `os.Stdin.Stat().Mode()&os.ModeCharDevice` 判 TTY，`/dev/null` 也是字符设备 → 被误判为交互，破坏性操作走了确认路径。已改为 `platform.IsTerminal`（Linux `TCGETS` ioctl），并补 `TestIsTerminalRejectsPipeAndDevNull`。

## 4. 测试怎么避免真删用户

三层注入，全部在临时目录：

1. `internal/platform/linux_cleanup_test.go`：`passwdPath` 指向临时文件；`cleanupExec` 换成记录器；`userdel`/`systemctl` 用临时目录里的假可执行文件（`firstExecutable` 走注入候选路径）。
2. `cmd/kored/uninstall_test.go`：`uninstallDeps.cleanup` 注入 `fakeCleanup`（只记录调用，不碰系统）；`execPurge` 记录 `purgeOp`；`loadPaths` 返回临时 state；`euid` 注入 0/1000。
3. `cmd/kored/changes_test.go`：账本只写临时目录；`executePurgeOp` 只对临时文件操作。

断言覆盖：调用序（unit → users → state）、dry-run 零副作用、非 TTY 退出 2、非 root 退出 6、`--keep-*` 跳过、幂等、不可回滚条目跳过。

## 5. 账本结构化 op

```json
{"ts":"...","plugin":"site","action":"vhost.write","target":"/etc/nginx/conf.d/kore-a.conf",
 "reversible":true,"purge_op":{"kind":"file.remove","args":["/etc/nginx/conf.d/kore-a.conf"]}}
```

- 白名单 kind：`file.remove`（1 参数）、`file.restore`（2 参数：原文件 → 目标）；
- 路径必须绝对、拒绝 `/`、含 `..` 会被 `filepath.Clean` 后仍按绝对路径校验；
- 未知 kind 直接报错，**绝不 `sh -c`**；
- `appendChange` 强制 `reversible=true` 必须带 `purge_op`（拒绝 shell 字符串）；
- 读取时坏行跳过并计数，不拖垮卸载清单。

## 6. 门禁证据

```
go vet ./...                                   → exit 0
go test -count=1 -timeout 200s ./...           → exit 0（15 个包 ok）
make docs-check                                → exit 0（5 pass / 1 warn / 0 fail）
make check                                     → exit 0（13 段；第 13 段 25 pass）
make zero-intrusion-check                      → exit 0（11 pass / 0 info / 0 fail）
```

## 7. 未实现 / 后续

1. 账本**写入点**仍在阶段 C：`privilege` 的 root.action 收口后自动 `appendChange`，当前只有基础设施 + uninstall 读取；
2. `file.restore` 需要插件先写备份文件（约定见 ADR-0023 §3.4）；
3. `kore` 安装脚本形态（非 `make install`）未提供；
4. 真机 root 端到端（真实 unit + 真实 `kore-*` 用户）未在降权后复验，只做了隔离实例；属挂账项，不得复述为已证。
