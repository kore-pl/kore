[agent:kore-impl-demotion]

# kore 二进制升级/降级演练（2026-11-23）

- **old 二进制**：`git archive a960749` + `make build BIN=/tmp/kored-old` → 9,789,602 B（`kored 0.1.0`）。
- **new 二进制**：`git archive HEAD`（fbfa2f3）+ `make build BIN=/tmp/kored-new` → 10,117,282 B。
- 实例：`/tmp/kore-upgrade`，port 18888，portable；**未覆盖仓库 `bin/kored`**，主实例 8787 零写入（仅只读探活）。
- 初始状态：file 0.3.1 / cron 0.4.1 均 enabled；scheduler 任务 `upgrade-drill` 启用。

## 1. 升级（old → new）

```text
stop unit → tar -C /tmp/kore-upgrade -czf /tmp/kore-upgrade-pre.tgz config data
→ cp /tmp/kored-new bin/kored → start
UPGRADED healthz=200 login=200
plugins=[('cron','0.4.1',True),('file','0.3.1',True)]
tasks=[('upgrade-drill',True)]
POST /invoke/cron/cron.list（带 X-Kore-CSRF）=200 {"entries":[],"count":0}
```

**文档判断 a 成立**：旧库（schema=1）配新二进制直接起，无迁移、无警告阻塞。

## 2. 降级（new → old，**只换二进制、保持新库**）

```text
stop unit → cp /tmp/kored-old bin/kored → start
DOWNGRADED_SAME_DB healthz=200 login=200
plugins=[('cron','0.4.1',True),('file','0.3.1',True)]
tasks=[('upgrade-drill',True)]
```

**文档判断 b 需修正**：同 SchemaVersion（=1）下「只换二进制不换库」的降级**实测可用**，原文「回滚必须整库回滚」过强。已在 `docs/OPERATIONS.md` §1.2 改为：跨 schema / 有数据语义变更才必须整库回滚；同 schema 小版本可只换二进制，但仍建议保留整库备份（因为 meta.schema_version 不代表写入版本）。

## 3. 文档偏差

- `POST /api/v1/invoke/...` 需要 `X-Kore-CSRF`，原文档只写了 healthz；已在实测记录中补注（未改正文步骤）。
- 升级步骤未写「保留旧二进制备份」的命令细节，实测用 `cp bin/kored /tmp/kored-old-backup` 完成；§1.1 已有 `kored.bak-<date>` 思路，够用。
- 两步都照文档一次跑通（除 CSRF 头为验收动作所需）。

## 4. 清理

`/tmp/kore-upgrade`、`/tmp/kored-{old,new}`、`/tmp/kore-upgrade-pre.tgz`、cookies/log 已删除；port 18888 已释放；主实例未重启。
