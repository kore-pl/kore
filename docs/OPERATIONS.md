> 状态: active · 归属: implementer · 更新: 2026-11-23 · 里程碑: M0

[agent:kore-impl-demotion]

# OPERATIONS — 升级 kore 自身 与 备份/恢复状态

**本文解决什么**：`RUNBOOK.md` 覆盖的是索引重签、插件升级/回滚、提权与安装卸载，**没有**「内核二进制自身怎么升级」「`state.db` 和已装插件怎么备份/恢复」。本文给两套可直接照抄的流程，并按 2026-11-23 在 `/tmp/kore-ops`（port 18897，portable）**实跑验证**。

> 范围：portable 与 fhs 都适用；示例统一用 `<install>` 表示安装根（portable 下 `KORE_HOME` 指向它），`<data>` 表示状态目录（portable `<install>/data`、fhs `/var/lib/kore`）。

## 0. 结论先行（两条最容易踩的）

1. **升级二进制不会自动迁移 `state.db`，也不需要迁移**：`internal/core/store/store.go:27` 的 `SchemaVersion = 1` 只在**新建库**时写入；`prepare()`（`store.go:135-165`）对已存在的库只做「补齐缺失 bucket + 校验」——`schema > 内核` 拒绝启动（`ErrSchemaTooNew`，退出码 4），`schema <= 内核` 就地放行，**没有任何迁移代码**。
2. **服务运行时不要直接 `cp state.db`**：bbolt 以 `mmap` + 文件锁打开（`store.go:92`），普通 `cp` 不保证页一致性。本次在低写入的测试实例上热拷后恰好可读，但这是运气不是保证；**备份前必须停服务**（或未来提供 bbolt 事务快照接口，目前没有）。

## 1. 升级 kore 自身（二进制升级）

### 1.1 流程（portable / fhs 通用）

```bash
# 0) 记录当前版本（回滚需要）
<install>/bin/kored version            # 或 kored --version

# 1) 停服务（systemd 形态）
sudo systemctl stop kore.service       # portable 前台：停掉 kored serve 进程即可

# 2) 备份（见 §2；至少 state.db + config + 已装插件）
# 3) 用新二进制替换，保留旧二进制用于回滚
sudo cp <install>/bin/kored <install>/bin/kored.bak-$(date +%Y%m%d)
sudo install -m 0755 ./kored-new <install>/bin/kored   # fhs 为 /usr/local/bin/kored

# 4) 启动并验证
sudo systemctl start kore.service
curl -fsS http://127.0.0.1:8787/-/healthz && echo OK
<install>/bin/kored version
```

### 1.2 需要重启吗？配置/state 兼容吗？

- **需要重启**：二进制替换后旧进程仍是旧代码，必须停→换→起。
- **state 兼容**：见 §0.1。同一 `SchemaVersion` 内升级（补 bucket / 加索引）**无需迁移、直接读**；跨 `SchemaVersion` 的升级在**本仓库当前没有迁移器**——若未来版本 bump 了 `SchemaVersion`，旧库仍会被接受（`schema < 内核`），但新代码若依赖新字段需自行回填（届时必须有迁移 ADR/脚本，当前不存在）。
- **反向降级**：旧二进制读新库是否安全，取决于新版本是否 bump 了 `SchemaVersion`、以及是否写入了旧代码不认识的数据语义。**注意 `prepare()` 不会把旧库的 `meta.schema_version` 改写成新值**（`store.go:150-164` 只在缺失时写入），因此「库的 schema 数字」不等于「最后写入它的内核版本」。
- **实测修正（2026-11-23）**：同 `SchemaVersion`（当前 =1）的两个二进制之间，**只换二进制、不换库**的降级实测是**可用**的（`GET /-/healthz` 200、原口令登录 200、插件与 enabled 状态、scheduler 任务全部保留）。所以「回滚必须整库回滚」这句对**同 schema、无破坏性数据变更**的版本对**过强**；正确表述是：整库回滚是跨 `SchemaVersion` / 有数据语义变更时的**唯一安全做法**，同 schema 小版本可只换二进制，但**仍建议**保留并把「降级前整库备份」作为回滚手段——因为 schema 数字不能证明库是哪个版本写的。

### 1.3 升级前检查清单

- [ ] `kored version` 记录当前版本与协议版本。
- [ ] 备份 `<data>/state.db` + `<data>/plugins/` + 配置文件（§2）。
- [ ] 确认新版本仍接受现有插件 `requires_kore` 区间（插件清单里的约束）。
- [ ] 若索引公钥变了（重签/轮换），**必须先**按 `RUNBOOK.md` §1 同步 `verify.go` 与索引仓 `PUB_HEX`，再连同二进制一起升级；公钥未变则无需重建。
- [ ] 回滚预案：备份包 + 旧二进制 `kored.bak-<date>` 都可用。

## 2. 备份与恢复状态

### 2.1 备份什么

| 路径 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| `<data>/state.db` | 插件登记、启用状态、scheduler 任务、会话、审计 | **必须备份**；丢了要重装/重配全部插件与任务 |
| `<data>/plugins/<id>/<version>/` | 已装插件的二进制与 `info.json` | 可重装（需对应 dist + 索引），但离线环境等于丢失 |
| `<install>/config/config.yaml` | 监听地址、口令哈希、路径 | **必须备份**；丢了要重设管理员口令（当前首启 bootstrap 另有已知问题，见 task-170） |
| `<data>/credentials/` | 凭据库（如插件凭据） | 必须备份，否则插件连接信息要重填 |
| `<data>/ssl/`、`<data>/backups/` | 站点证书、备份产物 | 视业务；丢了证书要重签、备份要重做 |
| `<data>/changes.jsonl` | 宿主变更账本（ADR-0023） | 卸载时无法按账本回滚，建议一起备份 |
| `<install>/logs/`、`<run>/` | 日志、socket | 可丢（运行期生成） |

### 2.2 备份（已实测）

```bash
# 1) 停服务，确保 bbolt 没有在写、mmap 已关闭
systemctl stop kore.service            # portable：kill 掉 kored serve

# 2) 整目录打包（含二进制与配置，恢复时最省事）
tar -C <install> -czf /path/to/kore-backup-$(date +%Y%m%d).tgz bin config data
# 大目录可拆：tar -C <install> -czf ... data config；二进制另行保存/重装

# 3) 校验归档
gzip -t /path/to/kore-backup-*.tgz && echo archive_ok
```

> **不要**在服务运行时 `cp state.db`：`bolt.Open` 持有文件锁并 mmap（`store.go:92`），热拷可能得到撕裂页。实测在小负载下热拷能打开属偶然，不作为流程依据。
> 未来若提供「在线备份」端点，应走 bbolt `tx.WriteTo()` 一致性快照；当前内核没有该入口。

### 2.3 恢复（已实测）

```bash
# 1) 停掉可能还在跑的旧进程（灾难后通常已不存在）
systemctl stop kore.service 2>/dev/null || true

# 2) 重建安装根并解包（保持原路径，配置里的绝对路径才不会失配）
mkdir -p <install>
tar -xzf /path/to/kore-backup-YYYYMMDD.tgz -C <install>
sudo chown -R <运行用户>:<运行组> <install>/data <install>/config   # fhs 形态

# 3) 启动
systemctl start kore.service
curl -fsS http://127.0.0.1:8787/-/healthz && echo restored_ok
```

### 2.4 恢复后验证（按此顺序，全部通过才算恢复）

1. `GET /-/healthz` → 200。
2. `POST /api/v1/auth/login` 用备份前的口令 → 200（证明 config 与口令哈希恢复）。
3. `GET /api/v1/plugins` → 已装插件列表与版本、`enabled=true` 与备份前一致。
4. `GET /api/v1/scheduler/tasks` → 任务（名称/表达式/启用状态）与备份前一致。
5. 抽查一个插件核心方法（`POST /api/v1/invoke/file/...` 或 `monitor/system`）→ 200。
6. `kored audit --since <备份前时间>` → 历史审计仍在。

## 3. 实测记录

### 3.0 二进制升级 / 降级演练（2026-11-23，/tmp/kore-upgrade，port 18888）

两个二进制都由 `git archive` + `make build BIN=<tmp>` 构建（**未覆盖仓库 `bin/kored`**）：

| 角色 | commit | 体积 |
| --- | --- | --- |
| old | `a960749` | 9,789,602 B |
| new | `HEAD`（fbfa2f3） | 10,117,282 B |

初始状态（old 二进制起实例）：file 0.3.1 / cron 0.4.1 均 `enabled=true`，scheduler 任务 `upgrade-drill` 启用。

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 升级 | 停 unit → `tar -C <install> -czf pre.tgz config data` → `cp kored-new bin/kored` → 起 | `healthz=200 login=200 plugins=[('cron','0.4.1',True),('file','0.3.1',True)] tasks=[('upgrade-drill',True)]`；`POST /invoke/cron/cron.list` 带 `X-Kore-CSRF` → 200 `{"entries":[],"count":0}` |
| 降级（只换二进制、**保持新库**） | 停 unit → `cp kored-old bin/kored` → 起 | **同样全部通过**（healthz/login/plugins/tasks 一致）——见 §1.2 的修正结论 |

> 注意：`POST /api/v1/invoke/...` 是写请求，**必须带 `X-Kore-CSRF`**（值取登录后 `kore_csrf` cookie），否则 401；`OPERATIONS.md` 早期只写了 healthz，验收 invoke 时补上此头。

### 3.1 备份/恢复演练（2026-11-23，/tmp/kore-ops，port 18897）

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 起实例 | `KORE_HOME=/tmp/kore-ops bin/kored serve` | `/-/healthz` 200；登录 200 |
| 装 2 插件 | `kored install --package file-0.3.1.tar.gz`、`cron-0.4.1.tar.gz` | 均 `installed`；`GET /plugins` 显示 `enabled=true`（文件插件 lazy stopped 正常） |
| 建配置 | `POST /api/v1/scheduler/tasks`（`ops-journey`, `*/5 * * * *`） | 200，返回 `tsk-d9f41957ed1d2bb3` |
| 备份 | 停服务 → `tar -C /tmp/kore-ops -czf /tmp/kore-ops-backup.tgz bin config data` | 归档 11 MiB，`gzip -t` 通过 |
| 灾难 | `rm -rf /tmp/kore-ops` | 目录不存在（模拟全损） |
| 恢复 | `mkdir -p /tmp/kore-ops && tar -xzf ... -C /tmp/kore-ops` → 重新 `serve` | `healthz=200`、`login=200` |
| 验证 | `GET /scheduler/tasks`、`GET /plugins` | 任务 `tsk-d9f41957ed1d2bb3` 原样恢复；`[('cron','0.4.1',True), ('file','0.3.1',True)]` |
| 热备对照 | 服务运行中 `cp state.db` → 独立 `kored audit` | 本次可读（低写入），但**不作为推荐流程**（bbolt mmap 一致性无保证） |

一次通过，无需改流程；唯一注意点是备份包要**包含 `bin/`**，否则恢复后还要重新放二进制（本文流程已包含）。

## 4. 未验证 / 已知卡点

- **跨 `SchemaVersion` 迁移未验证**：当前仓库没有迁移器；若未来 bump 版本，本文 §1.2 的「直接读」结论需要重测。
- **在线一致性备份未实现**：没有 bbolt 快照入口，只能停服务备份；热备实验不构成保证。
- **fhs 形态的 root/属主恢复未实测**：本文命令给了 `chown`，但本次只在 portable（同 uid）验证。
- **首启口令 bootstrap 仍不可用**（`task-170` 在修）：恢复后能登录的前提是 `config.yaml` 里有 `auth.admin_password_hash`；只有 state.db 没有 config 时无法登录。

## 5. 下一步看哪里

- 索引重签 / 公钥同步 / 插件升级与回滚：[RUNBOOK.md](./RUNBOOK.md) §1。
- 安装、卸载、零侵入判据：[RUNBOOK.md](./RUNBOOK.md) 与 [ADR-0023](./DECISIONS/0023-zero-intrusion.md)。
- 配置项与路径语义：[CORE.md](./CORE.md) §2.1、[DATA-MODEL.md](./DATA-MODEL.md) §3。
