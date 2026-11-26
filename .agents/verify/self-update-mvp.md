---
title: M8 形态 A 全闭环演练独立验收报告
date: 2026-11-26
owner: m8-verifier
verdict: PARTIAL（核心链路 PASS；make check 有 4 段 FAIL + 2 处口径偏差需回派/裁决）
task: task-59
head: 5a8439c
---

# M8 形态 A 全闭环演练独立验收报告（task-59）

## 0. 身份、前提与纪律（G-09）

- 我是 **m8-verifier**，独立于 M1–M5 全部 implementer / verifier；不复用其结论，全部演练独立执行命令并留痕。
- 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore`；HEAD=`5a8439c`（M5 修复复跑闭环提交）。
- 参考文档：[RUNBOOK.md](../../docs/RUNBOOK.md) §5、[RUNBOOK-INSTALL.md](../../docs/RUNBOOK-INSTALL.md) §6.5、[ADR-0042](../../docs/DECISIONS/0042-privilege-without-prompt.md)、[ADR-0056](../../docs/DECISIONS/0056-self-restart.md)。
- **用户当次授权**：安装系统级 root 服务 `kore.service`（写 `/etc/systemd/system` + enable 软链，不可逆）。所有 root 动作只走 `dsh-root`，命令原文 + 退出码 + 关键输出在下文逐条如实记录。
- 硬纪律遵守：只写本报告一个文件；不改业务代码；演练配置 / 二进制 / 临时 unit 全在**工作区内**临时目录 `kore-pl/.tmp-m8-verify/`，用完已删除（含临时 systemd unit `kore-m8-drill.service` 已停+删+daemon-reload，**不碰真实 `kore.service`**）；不 push、不联网。
- **本轮是否改动过主实例运行态配置：否。** 未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`（`stat .kore-local.yaml` mtime `2026-11-25 20:15:44`，早于本轮开始；全程只读探活）。唯一真实系统变更是用户已授权的 `kore.service` 安装（幂等重写，仅注释头从旧脚本名对齐为 `install.sh`）。

## 1. ① 安装 root 服务（root/system）— **PASS**

服务在本轮开始前已由前序里程碑安装且 active（unit 头注释为旧脚本名）；本轮按授权用**现行脚本**真装一次，使其与 HEAD 对齐（仅两行注释差异，功能字段逐字相同）。

先只读 dry-run（diff 确认仅有注释头差异）：

```
$ bash scripts/install.sh --dry-run --install-root /home/pt/Work/GolandProjects/kore-pl/kore \
    --bin /home/pt/Work/GolandProjects/kore-pl/kore/bin/kored \
    --config /home/pt/Work/GolandProjects/kore-pl/kore/.kore-local.yaml
  [OK] 未检测到用户级 kored-local 实例
  [BLOCKED] 既有 unit 内容不同：/etc/systemd/system/kore.service（未给 --overwrite，dry-run 不会改）
  [DRY-RUN] 未写入任何文件
exit=0
$ diff -u /etc/systemd/system/kore.service <rendered.unit>
@@ -1,5 +1,5 @@
-# ... — 由 scripts/install-system-service.sh 生成（ADR-0042 方案 B）
-# 手工改动会在下次安装时被覆盖；卸载: sudo scripts/install-system-service.sh --remove
+# ... — 由 scripts/install.sh 生成（ADR-0042 方案 B）
+# 手工改动会在下次安装时被覆盖；卸载: sudo bash scripts/install.sh --remove
exit=1（仅注释差异，功能字段一致）
```

**授权安装（唯一一次真实系统写）**：

```
$ dsh-root --shell 'cd /home/pt/Work/GolandProjects/kore-pl/kore && \
    bash scripts/install.sh --overwrite --install-root /home/pt/Work/GolandProjects/kore-pl/kore \
    --bin /home/pt/Work/GolandProjects/kore-pl/kore/bin/kored \
    --config /home/pt/Work/GolandProjects/kore-pl/kore/.kore-local.yaml'
  [OK] 已写入 /etc/systemd/system/kore.service
  [OK] kore: active（root 运行：root）
  Created symlink '/etc/systemd/system/multi-user.target.wants/kore.service' → '/etc/systemd/system/kore.service'.
exit=0
stderr（如实）：/home/pt/.local/bin/dsh-root: 行 62: /home/pt/.local/state/dsh/root-exec.log: 只读文件系统 → dsh-root 审计日志无法写入（审计缺口，非被测代码缺陷）
```

> 注：`--overwrite` 下 dry-run 预览块仍打印 `[BLOCKED] 既有 unit 内容不同`，因为脚本预览逻辑不读该 flag；真实写入分支读 `--overwrite` 并成功写入（见 `[OK] 已写入`）。这是展示层小瑕疵，不影响安装结果。

**安装后复核**：

```
$ systemctl is-active kore.service            → active          exit=0
$ systemctl is-enabled kore.service           → enabled         exit=0
$ systemctl show -p User -p MainPID kore.service → User=root / MainPID=2533240   exit=0
$ dsh-root ps -o user=,pid=,args= -C kored    → root 2533240 /home/pt/.../bin/kored serve --config /home/pt/.../.kore-local.yaml   exit=0
$ curl -sS -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:8787/-/healthz → http=200   exit=0
```

## 2. ② 内核 upgrade happy path + 错 sha — **PASS**

隔离准备（工作区内临时目录 `kore-pl/.tmp-m8-verify/upgrade-drill/`，独立 `bin/state/run/log`，**未碰主实例 `bin/kored` / `.kore-local-*`**）：

```
$ go build -trimpath -buildvcs=false -ldflags='-s -w' -o .../bin/kored ./cmd/kored   → exit=0
  v1 sha256 = 0d49d7a91d68a921f5bbb2471af1cb8e2009d05999cf5de79a609acbe6cdb0a1
$ go build ... -ldflags='-s -w -X main.version=0.1.1-m8-new' -o .../newbin/kored.v2 → exit=0
  v2 sha256 = fe4e33d631ef6966f615f51e86b25bc6ee216db383cccc6fec4474bbeedf2173
$ .../bin/kored version → kored 0.1.1；v2 → kored 0.1.1-m8-new
```

为避免重启真实 `kore.service`，用 `dsh-root` 装了一个临时假 unit `kore-m8-drill.service`（`ExecStart=/bin/sleep 3600`）作为重启目标，`--unit-name kore-m8-drill.service`；全程真实服务 `kore.service` 保持 active。

### 2a 错 sha 拒绝（目标字节不变）

```
$ dsh-root <isolated>/bin/kored upgrade --bin .../newbin/kored.v2 \
    --sha256 0000...0000 --target <isolated>/bin/kored --state-dir <isolated>/state \
    --unit-name kore-m8-drill.service --no-restart
  upgrade: sha256 校验失败，拒绝替换（目标文件未改动）
    期望: 0000...0000  实际: fe4e33d6...  来源: .../newbin/kored.v2
exit=2
$ sha256sum <isolated>/bin/kored → 0d49d7a9...（与替换前逐字相同）  BYTE_UNCHANGED=PASS
$ ls <isolated>/bin/kored.prev → No such file（未产生 .prev）  PREV_ABSENT=PASS
$ ls <isolated>/state/upgrade-result.json → No such file（未落标记） MARKER_ABSENT=PASS
```

### 2b happy path（replace → .prev → pending → success；两条生效判据都验了）

```
$ dsh-root <isolated>/bin/kored upgrade --bin .../newbin/kored.v2 \
    --sha256 fe4e33d6... --target <isolated>/bin/kored --state-dir <isolated>/state \
    --unit-name kore-m8-drill.service
  [OK] 已原子替换：.../bin/kored（rename 覆盖，旧文件保留为 .../bin/kored.prev）
  [INFO] 已落 pending 标记：.../state/upgrade-result.json（重启后由新进程改写成 success）
  [OK] 已提交重启：systemctl --no-block restart kore-m8-drill.service
exit=0
$ sha256sum .../bin/kored → fe4e33d6...（新）；kored.prev → 0d49d7a9...（旧）  → .prev PASS
$ dsh-root cat .../state/upgrade-result.json
  "state": "pending", "expected_sha256": "fe4e33d6...", "previous_sha256": "0d49d7a9...", "updated_at": "...10:03:34..."
```

生效判据 1（人工复核）：

```
$ dsh-root <isolated>/bin/kored upgrade --verify --target .../bin/kored --state-dir .../state
  [INFO] 标记：state=pending expected=fe4e33d6...
  [INFO] 磁盘：sha256=fe4e33d6...
  [OK] 新版本已生效（标记改为 success）
exit=0
$ dsh-root cat .../state/upgrade-result.json → "state": "success", "verified_at": "...10:03:40...", "version": "0.1.1-m8-new"
$ .../bin/kored version → kored 0.1.1-m8-new
```

生效判据 2（**新进程 serve 启动自动 finalize**，ADR-0056 机制，独立复验）：

```
# 把标记重置回 pending，再用新二进制起一个隔离 kored serve（端口 18899，独立 config/state/run）
$ dsh-root systemd-run --unit=kore-m8-finalize --collect ... <newbin>/kored serve --config <isolated>/finalize-config.yaml
  Running as unit: kore-m8-finalize.service   exit=0
$ sleep 3; dsh-root cat .../state/upgrade-result.json
  "state": "success", "version": "0.1.1-m8-new", "verified_at": "...10:03:49..."
$ curl http://127.0.0.1:18899/-/healthz → http=200
$ dsh-root systemctl stop kore-m8-finalize.service → exit=0；healthz 18899 → http=000（已停）
```

回滚（G-29 数据面，顺带验证）：

```
$ dsh-root <isolated>/bin/kored upgrade --rollback --target .../bin/kored --state-dir .../state --no-restart
  [OK] 已回滚：.../bin/kored ← .../bin/kored.prev（替换前的二进制已存回 .prev，可再次 --rollback 切回）
exit=0
$ sha256sum .../bin/kored → 0d49d7a9...（回到旧版）；kored.prev → fe4e33d6...（新版成为可切回备份）
$ .../bin/kored version → kored 0.1.1
```

清理：临时 unit `kore-m8-drill.service` 已 `disable --now` + 删 unit + `daemon-reload`（复核 `exists: no` / `active: inactive`，exit 0）；隔离目录已随 `.tmp-m8-verify/` 整体删除。

## 3. ③ 插件热更新隔离实例（reloadOne）— **PASS（复用 M1–M3 验收 + 定向复跑）**

按任务卡授权「复用 M1–M3 reloadOne 引用其验收即可，不必重跑全套」：

- 实现事实：安装 / 更新 / 强制重装共用 `reloadOne`（`cmd/kored/serve_runtime.go:267`；`internal/core/httpapi/handlers_store.go:178` 明示 update 与 install 共用），无第二条热重载路径；`catalog.Replace` + `manager.Forget(id)` 解决同 id 新版本 catalog 仍停旧版的问题。
- 真机证据（引用 [fix-hot-upgrade.md](fix-hot-upgrade.md) §2，18877 隔离实例、8787 未触碰）：装 file 0.1.0 → `/plugins` 0.1.0；同 id 换 0.2.0 索引后装 v0.2.0 → `reload=restarted`，`/plugins` 立即 0.2.0、`desired=enabled`，**kored PID 3889236→3889236（内核未重启）**，新方法 `file.compress` 由 404→200。
- 本轮定向独立复跑（不复用实现者测试替身，只跑生产回归用例确认 HEAD 未回退）：

```
$ go test -count=1 -timeout 200s ./cmd/kored/ -run 'TestReloadOneHotUpgradeSameID|TestReloadOne'
  ok  github.com/pengtang1024/kore/cmd/kored  1.900s
exit=0
```

## 4. ④ portable 非 root upgrade 的 fail-closed — **PARTIAL（行为 PASS；退出码与任务卡不符）**

```
$ id -u → 1000
$ <isolated>/bin/kored upgrade --bin .../newbin/kored.v2 --sha256 fe4e33d6... \
    --target .../bin/kored --state-dir .../state --no-restart
  upgrade: 需以系统服务身份运行（root）才能自升级；一次性安装后不应再需要 sudo。
    当前 euid=1000，目标 .../bin/kored 与 unit ... 都需要 root 才能替换/重启。
    怎么办：由系统服务内的内核执行（systemctl 管理的 kore.service 进程本身就是 root），
            或在服务端 POST 升级入口；不要用 sudo 手工 cp 覆盖二进制。
exit=6
$ sha256sum .../bin/kored → 0d49d7a9...（目标未改，fail-closed PASS）
```

**口径偏差（需 lead 裁决，非实现缺陷）**：任务卡写「exit=3（exitEnv）」，但 HEAD 代码 `cmd/kored/main.go:26` 明写 `exitEnv = 6`（`exitState = 3`），`upgrade.go:137-142` 非 root 闸门返回 `exitEnv` → 实测 exit=6。`RUNBOOK-INSTALL.md` §6.5.2 与 `upgrade.go:660` usage 也一致写「6 = 环境不满足」。因此**实现的白话 hint + 不假成功行为 PASS，退出码数字与任务卡描述不一致**——按事实记录为 exit=6，不伪装成 3。若验收硬性要求 exit=3，应由 lead 裁决是改文档口径还是回派实现者改码。

## 5. ⑤ 门禁 — **PARTIAL（zero-intrusion PASS；make check 4 段 FAIL；make idle SKIP）**

### 5.1 `make zero-intrusion-check` — **PASS**

```
$ GOCACHE=<tmp>/gocache GOWORK=off make zero-intrusion-check
  [PASS] 隔离实例就绪，socket 落在安装目录内
  [PASS] UDS /-/healthz = 200
  [PASS] 状态文件权限 0600；账本含 file.remove 条目；回滚后不存在
  [PASS] 系统路径零新增（/etc/kore、/var/lib/kore、/var/log/kore、/run/kore）
  [PASS] 未新建 kore-* 用户 / 组 / unit
  [INFO] 运行前已存在的 kore unit（ADR-0023 §3.5 豁免 #1）：kore.service
  zero-intrusion-check: 17 pass, 2 info, 0 fail
exit=0
```

**root 服务在 ADR-0023 §3.5 豁免 #1 清单内**（脚本打印既有 unit 并标为豁免项，未新增清单外写入）。

### 5.2 `make idle` — **SKIP（exit=0，未实测指标）**

```
$ GOCACHE=<tmp>/gocache GOWORK=off make idle
  [SKIP] 未发现运行中的 kored 进程（M0 阶段正常）；需启动 kored 后实测（M1 起生效）
exit=0
```

本沙箱 bwrap 的 PID namespace 看不到宿主 systemd 的 kored（真实服务 active、8787 healthz=200），脚本按 M0 SKIP 口径返回 0。**出站 0 / CPU / fd / goroutine 的实测指标未由本命令产出**，标 NOT EXECUTED；G-10 出站 0 用下述双基线 + 运行时 `ss` 独立取证。

### 5.3 `make check`（21 段）— **FAIL，exit=2**

完整日志留存于临时目录（已按纪律删除），关键退出码与原文：

```
$ GOCACHE=<tmp>/gocache GOWORK=off make check
  exit=2
```

各段结果：1 docs-check PASS / 2 dep PASS / **3 thin-shell FAIL** / 4 repo PASS / 5 canonical PASS / 6 log PASS / 7 wt PASS / **8 oss-check FAIL** / 9 case PASS / 10 frontend PASS / 11 zero-intrusion PASS / 12 secret PASS / 13 plugin-oss PASS / 14 store PASS / **15 presets FAIL** / 16 pubkey+market PASS / 17 cross-build PASS / **18 race FAIL** / 19 全仓 -race PASS（17 包、零 DATA RACE）/ 20 usability WARN（WARN 级不阻断）/ 21 pluginapi -race PASS。

四类 FAIL 定性（**不伪装为通过**，逐条给原文与定性）：

| 段 | 原文（节选） | 定性 | 是否本轮引入 |
| --- | --- | --- | --- |
| 3 thin-shell | `[FAIL] 可执行代码出现业务域词`：`credential_format.go:50 backup := path + ".legacy"`、`handlers_disk.go:81 case "backups"/"sites"`；`[FAIL] 业务动作词`：`main.go:55 case "restart"`、`restart.go:1 package main` | **HEAD 真实基线漂移**：文件均为已提交、本轮零修改（`git status` 为空）。来自 ADR-0057 凭据迁移 / r23 磁盘分析 / ADR-0056 自重启三个已合入特性，thin-shell 词表豁免未同步。 | 否（前序里程碑遗留） |
| 8 oss-check | `[FAIL] Go 文件头部含 Copyright 但非 MIT: ./.tmp/gomodcache/golang.org/x/sys@v0.4.0/...`（294 条，全在 gitignored `.tmp/gomodcache`） | **工作区污染**：`find . -name '*.go'` 扫到 gitignored 的预存模块缓存（mtime 11-25）。在 `git archive HEAD` 干净树上 `bash scripts/oss-check.sh` → **8 pass / 0 fail，exit=0**。 | 否（预存缓存，非 HEAD 缺陷） |
| 15 presets | `[FAIL] site: 判据①不满足：go test ./tests/boundary/ -count=1 未通过：--- FAIL: TestBoundaryNeedRootWhenConfDirRootOwned ... 打开站点清单锁失败: ... /etc ... read-only file system` | **沙箱环境假阴性**：bwrap 里 `/etc` 是只读挂载，测试用「写 /etc 触发 EACCES」造 E_NEED_ROOT 的前提不成立，得到 E_INTERNAL；且 `kore-plugin-site` 工作树有他人在途改动（`MM apply.go` / `?? tests/boundary/...`）。非产品代码缺陷，但本轮确实 FAIL。 | 否（环境 + 他人在途） |
| 18 race | `--- FAIL: TestBoundaryNeedRootWhenConfDirRootOwned` 同上；`kore-plugin-site: make race 未通过`；`[FAIL] race 门禁未通过` | 同 15，环境假阴性（`/etc` 只读）。其余 14 个有 boundary 用例的插件仓 `-race` 全 PASS。 | 否 |

> 对照前序基线：[m5-final-clean-clone.md](m5-final-clean-clone.md) 记 `make check`（干净 clone）exit=0、10 段全过——当时 `make check` 仅 10 段，21 段口径是后续扩张；本轮 21 段新增的 thin-shell / oss / presets / race 段在共享工作区暴露上述环境/基线问题。**按 verifier 纪律：这不是「通过」，如实记 FAIL 并回派。**

**回派建议（verifier 不改业务代码）**：
- 段 3 → 原 owner（credential / disk / restart 三特性 owner）或 architect：更新 thin-shell 词表精确豁免，或把 `backup`/`sites`/`restart` 用法改成中性命名；须在干净树复跑段 3 绿。
- 段 8 → 门禁 owner：`scripts/oss-check.sh` 的 `find` 加 `-not -path './.tmp/*'`（或改为只扫 git ls-files），避免 gitignored 缓存污染。
- 段 15/18 → site owner + 门禁 owner：`TestBoundaryNeedRootWhenConfDirRootOwned` 在 `/etc` 只读时应 `t.Skip` 而非 FAIL（探测写失败时区分 EACCES 与 EROFS），或 CI 提供一个属 root 且非只读的测试目录。

## 6. ⑥ G-10 双基线 + G-29 回切后验数据

### 6.1 G-10（更新源关闭出站 0）— **PASS**

```
基线 A（离线短路，checker 零调用 = 出站 0）：
$ go test -count=1 -timeout 200s ./internal/core/scheduler/ -run 'TestUpdateCheckOfflineShortCircuit|TestUpdateCheckOfflineNilFailClosed' -v
  --- PASS: TestUpdateCheckOfflineShortCircuit   checker.calls=0
  --- PASS: TestUpdateCheckOfflineNilFailClosed  checker.calls=0
exit=0
基线 B（默认禁用 / 空源 fail-closed，不隐式出站）：
$ go test -count=1 -timeout 200s ./internal/core/scheduler/ -run 'TestUpdateCheckDefaultDisabled|TestUpdateCheckMissingCheckerFailClosed' -v
  --- PASS: TestUpdateCheckDefaultDisabled
  --- PASS: TestUpdateCheckMissingCheckerFailClosed   （源空 "  " → sync 报错；冒用 method → ErrInvalid）
exit=0
静态基线：grep 出网客户端/telemetry → 仅 UDS、webhook、插件下载（用户显式触发），telemetry/analytics/beacon 零命中。
运行时基线：MAINPID=$(systemctl show -p MainPID --value kore.service)=2533240
  ss -tnp | grep pid=2533240 → 无 TCP 出站；ss -unp → 无 UDP 出站；ss -tanp | grep -c pid=... → 0
```

### 6.2 G-29 回切后验数据 — **PASS（本轮无回切，声明 + 数据核对）**

- 本轮**未改主实例运行态配置**（无回切动作）：`.kore-local.yaml` mtime `2026-11-25 20:15:44`（早于本轮 09:59），mode 600；`.kore-local-state/` / `.kore-local-run/` / `bin/kored` 全程只读。
- `index_dir` 配置值 `"/home/pt/Work/GolandProjects/kore-pl/kore-plugins/index"`（真实索引仓，`kore-plugins/index`），非任何 state 快照。
- 索引数据核对：`python3 json.load` → 24 个插件；`site 0.8.3` / `file 0.3.6` / `discover 0.3.2`（与索引文件逐字一致）。
- 8787 只做只读探活：healthz=200；`system/info` / `store/plugins` 未带有效会话返回 `E_UNAUTHORIZED`（不借助明文口令登录，符合 G-30）。沙箱 bwrap 的 UDS 不可达（`/run/kore.sock` connect failed），故 UDS 路径未测——标 NOT EXECUTED，非产品缺陷。
- 升级演练的所有数据面变化（`upgrade-result.json` pending→success、`.prev`、回滚）全在隔离目录内，**主实例数据零写入**。

## 7. 演练后系统状态与回退命令（不自行卸载）

**当前状态（如实）**：
- `kore.service`（`/etc/systemd/system/kore.service`，User=root）保持**已安装 / enabled / active**，MainPID 2533240，8787 healthz=200。用户授权了安装、**未授权卸载**，本 verifier **不自行卸载**。
- 临时演练 unit `kore-m8-drill.service`、transient `kore-m8-finalize.service` 均已停止并从 `/etc/systemd/system` 删除（复核 `exists: no` / `active: inactive`）；工作区临时目录 `kore-pl/.tmp-m8-verify/` 已整体删除。
- `dsh-root` 审计日志因 `~/.local/state/dsh/root-exec.log` 只读而无法写入（每次 root 调用均告警）——审计缺口，如实记录。

**回退命令清单（供用户决定，均未执行）**：

```bash
# 1) 停用并卸载 root 系统服务（不可回滚，需用户明确决定）
dsh-root systemctl disable --now kore.service
dsh-root --shell 'cd /home/pt/Work/GolandProjects/kore-pl/kore && bash scripts/install.sh --remove'
# 2) 如需恢复旧的用户级实例（若仍可用）
systemd-run --user --unit=kored-local-restore --wait --pipe --collect \
  --working-directory=/home/pt/Work/GolandProjects/kore-pl/kore \
  /home/pt/Work/GolandProjects/kore-pl/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore-pl/kore/.kore-local.yaml
# 3) 只有用户另行授权时才清理 root 服务自动创建的 kore-* 系统用户（破坏性）
#    dsh-root --shell 'getent passwd | awk -F: "$1 ~ /^kore-/" | cut -d: -f1 | xargs -r userdel'
```

## 8. 总评与结论

**总评：形态 A 核心链路（root 服务安装 / 内核升级 happy path + 错 sha + 回滚 / 插件热更新 / fail-closed / 零侵入 / G-10 双基线 / G-29 数据）全部独立复跑 PASS；但 `make check`（21 段）在本机未全绿（4 段 FAIL：thin-shell 基线漂移 + 工作区污染 + 2×环境假阴性），`make idle` 因沙箱 PID 不可见而 SKIP，非 root 升级退出码实测 6 与任务卡写的 3 不符。**

- 演练风险：服务安装为授权操作，已执行且成功；临时 unit 与临时目录均已清理；真实服务与主实例运行态零写入。
- 需 lead 处理：① 判定 `make check` 4 段 FAIL 是回派修基线/门禁/测试，还是按环境例外接受；② 裁决退出码口径（代码/文档写 6，任务卡写 3）；③ `dsh-root` 审计日志只读缺口。
- **task-59 状态**：演练与取证完成；是否将验收结论记为最终 PASS，取决于上述裁决——本报告不把未绿门禁粉饰为通过。

[agent:m8-verifier]
