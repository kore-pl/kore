# R6-8 竞态模式横向审计报告（red-team 只读）

- 执行者：`r6-raceaudit`（美团味 red-team，red-team ≠ implementer，G-09）
- 时间：2026-11-24 12:12–12:2x CST
- 写域：仅本文件。24 个插件仓全部只读，未改任何插件代码（G-08/G-12）。
- 目标：一个问题进来、一类问题出去——批量审计 24 仓「RMW 无锁 / 固定临时名 / check-then-act / 快照目录按秒命名」四类竞态，找出与今日 6 处修复同类的剩余隐患。
- 基准：`.agents/HANDOFF.md` B.6-6/-7/-10、`docs/PLUGIN-MATURITY.md` §5。

## 1. 证据：命令原文 + 退出码 + 命中数

命令 1（工作目录 `/home/pt/Work/GolandProjects`，全 24 仓关键词扫描）：

```bash
grep -rnE 'os\.CreateTemp|CreateTemp\(|MkdirAll\(|Lstat\(|os\.Rename\(|\.tmp"|Unix\(\)|flock|LOCK_EX|Flock\(|snapshot|快照' kore-plugin-* --include='*.go'
```
- 退出码 `0`
- 总命中 `665` 行（含大量 `_test.go` / `tests/` 噪音与 "快照" 注释，非全部为竞态）

命令 2（收窄到生产代码，排除测试）：

```bash
grep -rnE 'CreateTemp|MkdirAll|Lstat|os\.Rename|\.tmp"|Unix\(\)|Flock|LOCK_EX|WriteFile' kore-plugin-* --include='*.go' --exclude='*_test.go' | grep -vE '/tests/'
```
- 退出码 `0`
- 生产代码命中 `222` 行
- 固定 `.tmp` 命中 `20` 处（绝大多数为 `os.CreateTemp("....*.tmp")` 模板里的星号前缀，**唯一真正固定名**见下栏 dns）
- `Unix()` 秒级命名命中 `1` 处（redis TTL 计算，非文件命名，误报）
- `Lstat`/`CreateTemp` 命中 `58` 行（多数为安全唯一临时名 + 符号链接防护）
- `Flock`/`LOCK_EX` 命中 `9` 行（分布：app-deploy / cron / logs / site，为已保护面的证据）

命令 3（锁边界定性）：

```bash
grep -rE 'Flock|LOCK_EX|sync\.Mutex|\.Lock\(\)' kore-plugin-dns --include='*.go' --exclude='*_test.go' | wc -l
```
- 输出 `0` → dns 仓无任何锁原语（坐实"裸 RMW"）

## 2. 我 read 的 file:line 原文样本（≥5 处）

1. `kore-plugin-dns/internal/dnsop/write_engine.go:359` — `tmp := path + ".tmp"`；`:364 os.WriteFile(tmp, ..., 0o600)`；`:367 os.Rename(tmp, path)`。固定临时名，全仓零锁。
2. `kore-plugin-app-deploy/internal/apop/artifact.go:682-696` — `:687 snapshot := filepath.Join(snapshotRoot, time.Now().UTC().Format("20060102T150405Z"))`；`:688 os.MkdirAll(snapshot, 0o700)`；`:691 copyTree(target, snapshot)`。秒级快照目录，旁路锁不护目录。
3. `kore-plugin-logs/internal/logic/download.go:357-370` — `:359 stamp := time.Now().UTC().Format("20060102T150405Z")`；`:364 if _, err := os.Lstat(path); errors.Is(err, iofs.ErrNotExist) { return path, filename }`。check-then-act 生成导出路径。（对比：`:400-401 writeFilePrivate` 已用 `os.CreateTemp(..., Base+".tmp-*")`，唯一临时名，安全。）
4. `kore-plugin-logs/internal/logic/rotate.go:130-146` — `:135 candidate := filepath.Join(dir, base+"."+stamp)`；`:137 os.Lstat(candidate)` 判空；`:138 os.Rename(target, candidate)`。check-then-act + 秒级命名，无锁。
5. `kore-plugin-site/apply.go:55-62` — 在 `s.store.create`（`vhost.go:173 withManifestLock`）**之前** `snapshotFile(vhostPath)` / `snapshotFile(manifestPath)` 拍快照；`:71 restoreSnapshots(confBefore, manifestBefore)` 用锁外快照回滚。跨锁。
6. `kore-plugin-backup/internal/backupop/restore.go:131-156` — `checkRestoreTarget` 先 `Lstat` 判不存在/空目录，`:113 targetExists` 再 `Lstat` 判存在，两步之间无锁。check-then-act。
7. `kore-plugin-file/internal/fileop/rename_noreplace.go:18-24` — 降级路径 `Lstat(dst)` 判空 → `os.Rename(src,dst)`；源码注释已显式披露跨进程覆盖窗口，Linux 用 `renameat2(RENAME_NOREPLACE)` 收口。

## 3. 已确认安全（有锁 / 唯一名 / 已显式披露）

| 仓 | file:line | 模式 | 保护手段 | 风险 | 结论 |
| --- | --- | --- | --- | --- | --- |
| app-deploy | `internal/apop/statelock_unix.go:44,60` | RMW | 旁路 `syscall.Flock(LOCK_EX\|LOCK_NB)` 护 deployments/jobs JSON | — | 已保护（但**不护快照目录**，见未保护栏） |
| site | `vhost.go:59,173`、`manifestlock_unix.go:18,32` | RMW | `withManifestLock` 跨进程 flock 护清单读-改-写 | — | 已保护（但快照拍摄在锁外，见未保护栏） |
| logs | `internal/logic/lock_unix.go:25,40` + `download.go:401` | RMW/临时名 | state 目录 flock + `os.CreateTemp(Base+".tmp-*")` 唯一名 + fsync + rename（今日 0.5.2 修复） | — | 已保护（导出目标名与 rotate 例外，见未保护栏） |
| cron | `internal/croncore/lock_unix.go:13,18` + `crontabfile.go:39` / `runlog.go:147` | RMW/临时名 | `Flock(LOCK_EX)` + `CreateTemp(".cron-*.tmp")` / `(".runlog-*.tmp")` | — | 已保护 |
| file | `internal/fileop/fs_move.go:136,169`、`fs_mutate.go:62`、`extract_write.go:97`、`archive.go:122` | 临时名 | 全部 `os.CreateTemp(".xxx-*.tmp")` 唯一名 + rename | — | 已保护（`rename_noreplace.go` 降级路径单独披露，见未保护栏 P3） |
| 9 仓 plugincfg | `*/internal/plugincfg/plugincfg.go:143` | 临时名 | `os.CreateTemp(dir, ".config-*.tmp")` 唯一名（backup/db-mysql/db-postgres/dns/logs/redis/waf 等） | — | 已保护 |
| ssl / monitor / terminal / integrity / process | `certs/store.go:108`、`monitor/history.go:172`、`terminal/history_store.go:101`、`integrity/store.go:486`、`process/procfs/history.go:540` | 临时名 | `CreateTemp` 唯一名 + rename | — | 已保护 |

## 4. 疑似未保护（需 owner 复核 / 部分需真机并发复现）

| 仓 | file:line | 模式类别 | 锁保护 | 风险 | 一句话修法 | 已通知 |
| --- | --- | --- | --- | --- | --- | --- |
| dns | `internal/dnsop/write_engine.go:354-371`（核心 `:359`） | 固定临时名 + RMW | **无**（全仓零锁原语） | **P2** | `path+".tmp"` 改 `os.CreateTemp` 唯一名 + fsync + rename；或对 dnsmasq 片段目录加旁路 flock | lead（无 owner，待裁决） |
| app-deploy | `internal/apop/artifact.go:682-696` | 快照目录按秒命名 | 旁路锁只护 JSON，不护目录 | **P2** | 快照目录名加唯一后缀（job id/随机），`MkdirAll` 改原子建目录+撞名重试 | r6-appdeploy |
| logs | `internal/logic/download.go:357-370` | check-then-act（导出目标名） | writeFilePrivate 临时名唯一，但**目标路径非 O_EXCL** | **P3** | 唯一后缀直接进最终文件名，或对目标用 `O_CREATE\|O_EXCL` 占位 | r6-logs |
| logs | `internal/logic/rotate.go:130-146` | check-then-act + 秒级命名 | **无** | **P2** | `Lstat+rename` 包进 state 锁，或唯一名 + `renameat2(RENAME_NOREPLACE)` | r6-logs |
| site | `apply.go:55-62,71` | 快照跨锁 | 快照在 `withManifestLock` 外拍，回滚用旧快照 | **P2** | 快照拍摄移进锁内，或回滚前锁内重读当前态做差异回滚 | r6-site |
| backup | `internal/backupop/restore.go:130-156` | check-then-act（恢复目标） | **无** | **P3** | 目标目录用 O_EXCL 占位或 state 锁包住检查+落盘 | r6-filebackup |
| file | `internal/fileop/rename_noreplace.go:18-24` | check-then-act（降级路径） | Linux `renameat2(RENAME_NOREPLACE)` 收口；非 Linux/非 amd64/arm64 有窗口 | **P3（已显式披露）** | 保持披露；若需跨平台收口，降级路径补进程内互斥（非跨进程） | r6-filebackup（仅确认，非新坑） |

风险口径：P2 = 并发可致数据覆盖/丢失、需修；P3 = 偶发/边界或已显式披露，留挂账。以上均**未真实机并发复现**，属静态代码事实 + 调用链锁边界判读。

## 5. 未证明项（诚实披露）

- **扫描覆盖**：24 仓中 24 仓均纳入 grep 全量扫描（命令 1），生产代码 222 命中逐类分桶；但 `read` 深读上下文仅覆盖上列 7 处 + 已保护面抽样（约 15 处）。其余约 200 处命中为唯一临时名/符号链接防护/注释/`CreateTemp` 模板，按模式判定为安全，**未逐行深读**，不能宣称 100% 穷尽。
- **未扫完的仓**：无（24 仓均扫描）。但 `waf`/`ssh-guard`/`runtime-*`/`db-*`/`discover`/`firewall`/`monitor`/`process`/`terminal`/`echo`/`dns` 等仓的生产写路径只做了命中分桶，未逐函数追调用链锁边界——若这些仓存在绕开锁原语的 RMW，本报告可能漏报。
- **需真机并发复现**：
  1. dns 固定 `.tmp` 是否真被两个并发实例同时写（需起两个 dns 插件实例 + 并发 `record.add`）。
  2. app-deploy 同秒两次 upgrade 是否真撞快照目录（需 8 并发 upgrade + 同秒 barrier）。
  3. logs rotate / download 同秒并发是否真覆盖（需并发用例先 FAIL 后 PASS，各仓 `tests/boundary/` 补用例）。
  4. site 回滚快照跨锁：需构造「create 写盘后、回滚前插入并发写者」的时序，验证旧快照是否覆盖新态。
  5. backup restore check-then-act：需两个并发 restore 抢同一 target_dir 复现 E_CONFLICT 绕过。
- **本次未执行**：`-race` 复跑、任何插件代码改动、tests/evals/E2E 资产触碰（评分相邻，全部只读）。
