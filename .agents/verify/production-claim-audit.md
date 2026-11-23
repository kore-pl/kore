# 15 条 `production` 声明全量审计（判据①②逐条核实）

- 执行：`production-claim-audit`（只读审计）
- 时间：2026-11-24 04:39–04:58（+0800）
- 范围：`../kore-plugins/index/plugins.json` 中 `depth_level=production` 的 **15 条**（全量、非抽样）+ 对应 15 个插件仓的 `tests/`
- 判据真源：`docs/PLUGIN-CATALOG.md:90`
  > **升级判据**：① 边界用例覆盖（异常输入、并发、权限不足、资源耗尽各 ≥1 例并进 CI）；② 故障注入通过（`kill -9`、超时、磁盘满、cgroup 超限四类各 1 次）
- 纪律：**未改索引、未改 `info.json`、未改任何测试、未发版、未起服务**；本文件是唯一写入，只提交这一个文件（未 push）。

---

## 0. 结论（先给判断）

1. **15 条 `production` 里 0 条两条判据全满足；15 条全部「过度声明」。**
2. 共同缺口是**判据①的「并发」一类：15/15 仓库为 0**——`t.Parallel` 命中 0、`sync.*` 命中 0、并发类测试 0；`tests/boundary/` 目录 15/15 不存在。
3. **判据② 15/15 实跑 PASS**（`go test ./tests/fault/ -count=1`，合计 161 个用例 PASS、0 FAIL），且 `make check` 内含 `go test ./...`、CI 调 `make check`，故 fault 测试**确实进 CI**。问题不在②，在①。
4. 但②的成色分层：仅 `site` / `logs` 有真实资源限制路径（`ulimit -v`、`/dev/full`），其余 13 条是**进程内故障旗标**（`FaultDisk` / `FaultCgroup` / `FaultTimeout`），单仓 fault 套件 0.003–0.015s 跑完，物理上不可能是真实 `kill -9`/磁盘满/cgroup 超限。
5. **口径本身与现实不符（产品级发现）**：文档 `PLUGIN-CATALOG.md:85` 与 `:90` 写 **12 生产级 / 8 基础级**，索引实际 **15 production / 9 basic**；多出的 3 条是 `terminal` / `process` / `discover`——它们不在 §6.1 的 12 条生产级清单里，却以 `production` 出现在索引与 `info.json`。且 `G-20` 门禁只校验「`production` 必须有 `tests/fault/`」，**从不校验判据①**，所以这类漂移能一路绿灯进商店。

---

## 1. 清单：索引里的 15 条 `production`（来自索引，不是仓库）

| # | 插件 | 索引版本 | 索引 `depth_level` 行 | 仓库 `info.json` |
|---|------|---------|----------------------|------------------|
| 1 | `site` | 0.4.3 | `../kore-plugins/index/plugins.json:24` | `kore-plugin-site/info.json:7` |
| 2 | `file` | 0.3.2 | `:41` | `kore-plugin-file/info.json:7` |
| 3 | `ssl` | 0.6.0 | `:58` | `kore-plugin-ssl/info.json:7` |
| 4 | `cron` | 0.7.0 | `:91` | `kore-plugin-cron/info.json:7` |
| 5 | `monitor` | 0.3.0 | `:123` | `kore-plugin-monitor/info.json:7` |
| 6 | `logs` | 0.5.1 | `:140` | `kore-plugin-logs/info.json:7` |
| 7 | `runtime-php` | 0.2.2 | `:173` | `kore-plugin-runtime-php/info.json:7` |
| 8 | `db-mysql` | 0.4.1 | `:222` | `kore-plugin-db-mysql/info.json:7` |
| 9 | `redis` | 0.6.0 | `:258` | `kore-plugin-redis/info.json:7` |
| 10 | `backup` | 0.4.2 | `:275` | `kore-plugin-backup/info.json:7` |
| 11 | `firewall` | 0.2.6 | `:292` | `kore-plugin-firewall/info.json:7` |
| 12 | `app-deploy` | 0.3.1 | `:341` | `kore-plugin-app-deploy/info.json:7` |
| 13 | `terminal` | 0.2.1 | `:358` | `kore-plugin-terminal/info.json:7` |
| 14 | `process` | 0.3.0 | `:378` | `kore-plugin-process/info.json:7` |
| 15 | `discover` | 0.3.1 | `:398` | `kore-plugin-discover/info.json:7` |

> 分布复现：`24 = production 15 + basic 9`（命令见附录 A1）。
> 与文档对照：`PLUGIN-CATALOG.md:85` 的「生产级 12」只列 `site ssl runtime-php db-mysql file backup cron logs monitor firewall redis app-deploy`，**不含 `terminal` / `process` / `discover`**——索引比文档多 3 条。

---

## 2. 取证方法与判定口径

| 判据 | 取证方式 | 判定规则 |
|------|---------|---------|
| ①-目录 | `[ -d <repo>/tests/boundary ]` | 存在=✓ |
| ①-并发 | `grep -rn "t.Parallel" <repo>/tests` 命中数 + `sync.` 命中 + 并发测试函数 | ≥1 个真实并发用例=✓，否则✗ |
| ①-异常输入 | 测试中 `E_INVALID` 断言、`ENOTDIR`/`corrupt`/`malformed`/`Degraded` 用例（读代码，非只 grep 关键词） | 有可核对用例=✓ |
| ①-权限不足 | 测试中 `E_NEED_ROOT`/`E_UNAUTHORIZED` 断言或对不可写目录/只读根的真实用例 | 有=✓，仅方法级 401/403 断言记 △ |
| ①-资源耗尽 | 真实 OS 限制（`ulimit -v`、`/dev/full`、真实只读/满盘路径）=✓；仅进程内 `FaultDisk`/`FaultCgroup` 旗标=△ | ✓ / △ / ✗ |
| ② | 每仓 `go test ./tests/fault/ -count=1 -v` 实跑（不吃缓存） | 退出码 0 且无 FAIL=PASS |
| ②-进 CI | `Makefile` 的 `check` 目标 + `.github/workflows/ci.yml` | `go test ./...` 被 CI 调用=✓ |

---

## 3. 逐条判定表（15/15）

图例：✓ 有真实用例　△ 仅模拟/间接　✗ 无。

| # | 插件 | `tests/boundary/` | `t.Parallel` | 异常输入 | 并发 | 权限不足 | 资源耗尽 | fault 实跑 | 判定 |
|---|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 1 | `site` | ✗ 无 | 0 | ✓ `E_INVALID×17`、ENOTDIR、corrupt manifest | ✗ | ✗ | ✓ `ulimit -v` 32MiB + `/sys/fs/cgroup` | PASS 16/0 | **过度声明**（①-2/4） |
| 2 | `file` | ✗ 无 | 0 | ✓ `E_INVALID×6`、`E_NOTFOUND×8` | ✗ | ✗ | △ `FaultDisk/FaultCgroup` 旗标 | PASS 8/0 | **过度声明**（①-1/4） |
| 3 | `ssl` | ✗ 无 | 0 | ✓ `E_INVALID×5` | ✗ | ✗ | △ 旗标 | PASS 14/0 | **过度声明**（①-1/4） |
| 4 | `cron` | ✗ 无 | 0 | ✓ `E_INVALID×4` | ✗ | ✗ | △ 旗标 | PASS 26/0 | **过度声明**（①-1/4） |
| 5 | `monitor` | ✗ 无 | 0 | ✗ 0 条 `E_INVALID` | ✗ | ✗ | △ 旗标 | PASS 8/0 | **过度声明**（①-0/4） |
| 6 | `logs` | ✗ 无 | 0 | ✓ `E_INVALID×2`、corrupt state | ✗ | ✓ 不可写 state/source 目录 `chmod 000`×3 | ✓ `/dev/full` 真实 ENOSPC | PASS 15/0 | **过度声明**（①-3/4，仅缺并发） |
| 7 | `runtime-php` | ✗ 无 | 0 | ✓ `E_INVALID×3`、NotInstalled/Degraded | ✗ | ✗ | △ 旗标 | PASS 6/0 | **过度声明**（①-1/4） |
| 8 | `db-mysql` | ✗ 无 | 0 | ✓ `E_INVALID×11` | ✗ | △ `E_UNAUTHORIZED×3`（方法级） | △ 旗标 | PASS 6/0 | **过度声明**（①-1/4） |
| 9 | `redis` | ✗ 无 | 0 | ✗ 0 条 `E_INVALID`（仅 NOTFOUND/UPSTREAM） | ✗ | ✗ | △ 旗标 | PASS 8/0 | **过度声明**（①-0/4） |
| 10 | `backup` | ✗ 无 | 0 | ✓ `E_INVALID×2` | ✗ | ✗ | △ 旗标 | PASS 6/0 | **过度声明**（①-1/4） |
| 11 | `firewall` | ✗ 无 | 0 | ✓ `E_INVALID×2` | ✗ | ✓ 非 root 走 `E_NEED_ROOT`（`firewall_e2e_test.go:44,58`） | △ 旗标 | PASS 7/0 | **过度声明**（①-2/4） |
| 12 | `app-deploy` | ✗ 无 | 0 | ✓ `E_INVALID×2`、corrupt store×3 | ✗ | ✓ 只读 data root×2（`TestUploadDataRootReadOnly` 等） | △ 只读目录≠耗尽 | PASS 12/0 | **过度声明**（①-2/4） |
| 13 | `terminal` | ✗ 无 | 0 | △ `E_INVALID×1`、corrupt store | ✗ | ✓ 只读 history 目录（`TestHistoryClearReadOnlyDir`） | △ 旗标 | PASS 17/0 | **过度声明**（①-2/4） |
| 14 | `process` | ✗ 无 | 0 | ✓ `E_INVALID×10` | ✗ | ✓ `E_NEED_ROOT×3`+`E_UNAUTHORIZED×4` | △ 旗标 | PASS 6/0 | **过度声明**（①-2/4） |
| 15 | `discover` | ✗ 无 | 0 | ✗ 0 条 `E_INVALID` | ✗ | ✗ | △ 旗标 | PASS 6/0 | **过度声明**（①-0/4） |

**逐条一句话**：15 条里没有一条能同时亮起「异常输入 / 并发 / 权限不足 / 资源耗尽」四盏灯；`logs` 最接近（3/4，仅缺并发），`monitor` / `redis` / `discover` 最差（0/4，只有故障注入 + 正常路径 E2E）。

---

## 4. 分项原始证据

### 4.1 `tests/boundary/` 与 `t.Parallel`（全量统计，附录 A2）

```
site        boundary=-   fault=YES tParallel=0  testfiles=10 testLOC=2463
file        boundary=-   fault=YES tParallel=0  testfiles=11 testLOC=866
ssl         boundary=-   fault=YES tParallel=0  testfiles=9  testLOC=1402
cron        boundary=-   fault=YES tParallel=0  testfiles=12 testLOC=1083
monitor     boundary=-   fault=YES tParallel=0  testfiles=7  testLOC=573
logs        boundary=-   fault=YES tParallel=0  testfiles=7  testLOC=891
runtime-php boundary=-   fault=YES tParallel=0  testfiles=7  testLOC=852
db-mysql    boundary=-   fault=YES tParallel=0  testfiles=7  testLOC=903
redis       boundary=-   fault=YES tParallel=0  testfiles=6  testLOC=757
backup      boundary=-   fault=YES tParallel=0  testfiles=7  testLOC=651
firewall    boundary=-   fault=YES tParallel=0  testfiles=7  testLOC=554
app-deploy  boundary=-   fault=YES tParallel=0  testfiles=8  testLOC=1240
terminal    boundary=-   fault=YES tParallel=0  testfiles=9  testLOC=1324
process     boundary=-   fault=YES tParallel=0  testfiles=9  testLOC=1019
discover    boundary=-   fault=YES tParallel=0  testfiles=9  testLOC=766
```
- `tests/boundary/`：**0/15 存在**。
- `t.Parallel`：**0/15**；补充探测 `sync.*` 命中 **0/15**、`go func` 仅用于 `cmd.Wait()`（如 `site/tests/fault/kill_test.go:34`、`terminal/tests/e2e/helpers_test.go:149`），**无一处是并发用例**。

### 4.2 判据② 实跑（`-count=1`，不吃缓存）

| 插件 | 命令 | rc | PASS | FAIL | 耗时 |
|------|------|:--:|:----:|:----:|------|
| site | `go test ./tests/fault/ -count=1 -v` | 0 | 16 | 0 | 2.624s |
| file | 同上 | 0 | 8 | 0 | 0.027s |
| ssl | 同上 | 0 | 14 | 0 | 1.270s |
| cron | 同上 | 0 | 26 | 0 | 0.076s |
| monitor | 同上 | 0 | 8 | 0 | 1.749s |
| logs | 同上 | 0 | 15 | 0 | 0.010s |
| runtime-php | 同上 | 0 | 6 | 0 | 0.003s |
| db-mysql | 同上 | 0 | 6 | 0 | 0.006s |
| redis | 同上 | 0 | 8 | 0 | 0.005s |
| backup | 同上 | 0 | 6 | 0 | 0.014s |
| firewall | 同上 | 0 | 7 | 0 | 0.004s |
| app-deploy | 同上 | 0 | 12 | 0 | 0.015s |
| terminal | 同上 | 0 | 17 | 0 | 0.314s |
| process | 同上 | 0 | 6 | 0 | 0.005s |
| discover | 同上 | 0 | 6 | 0 | 0.004s |
| **合计** | | **0** | **161** | **0** | — |

**②进 CI 成立**：以 `cron` 为例，`Makefile:93-96`：
```
check:
	gofmt -l . ...; go vet ./...; go test -timeout 200s ./...
```
`.github/workflows/ci.yml` 的 `check` job 执行 `make check` → 故 `tests/` 下所有测试（含 fault）进 CI。

**②成色警告**：`runtime-php` 0.003s、`db-mysql` 0.006s、`process` 0.005s、`discover` 0.004s —— 这些仓库的「kill -9 / 磁盘满 / cgroup 超限」实为进程内旗标（`FaultKill`/`FaultDisk`/`FaultCgroup`，如 `db-mysql/tests/fault/disk_test.go:10-11` 仅调用 `assertFault(t, mysqlop.FaultDisk, ...)`），不是真实环境注入。真实资源路径仅：
- `site/tests/fault/cgroup_test.go:13-14`：`ulimit -v` 32 MiB 真实地址空间限制；
- `logs/tests/fault/disk_test.go:14,31`：真实写 `/dev/full` 验证 ENOSPC（无 `/dev/full` 时 skip）。

### 4.3 判据① 分项明细（关键 file 级证据）

- **异常输入存在**（`E_INVALID` 断言数）：site 17、db-mysql 11、process 10、file 6、ssl 5、cron 4、runtime-php 3、logs/backup/firewall/app-deploy 各 2、terminal 1；**monitor/redis/discover 为 0**。
- **权限不足存在**：`logs`（`TestFaultCleanUnwritableStateDir`、`TestFaultRestoreUnwritableSourceDir`、`TestFaultRetentionSetUnwritableState`，实测 `chmod` 6 处）、`app-deploy`（`TestUploadDataRootReadOnly`、`TestUpgradeDataRootReadOnly`）、`terminal`（`TestHistoryClearReadOnlyDir`）、`firewall`（非 root `E_NEED_ROOT`，`firewall_e2e_test.go:58`）、`process`（`E_NEED_ROOT×3`、`E_UNAUTHORIZED×4`）；其余 10 条**无权限不足用例**。
- **并发缺失**：全 15 仓无 `t.Parallel`、无 `sync.*`、无「多 goroutine 同方法」用例。

---

## 5. 统计：真 / 假

| 口径 | 结果 |
|------|------|
| 两条判据都满足（严格按 `PLUGIN-CATALOG.md:90`） | **真 0 条 / 假 15 条** |
| 仅判据② 满足 | 15 / 15（161 用例 PASS） |
| 判据① 至少 3 类（仅缺并发） | 1 条（`logs`） |
| 判据① 2 类 | 5 条（`site`、`firewall`、`app-deploy`、`terminal`、`process`） |
| 判据① 1 类 | 6 条（`file`、`ssl`、`cron`、`runtime-php`、`db-mysql`、`backup`） |
| 判据① 0 类 | 3 条（`monitor`、`redis`、`discover`） |

---

## 6. 口径结论：「12 production / 8 basic」与现实不符

**三套数据源已经分叉，且没有任何门禁把它们对齐：**

| 来源 | 现状 | 证据 |
|------|------|------|
| 文档 | 12 生产级 / 8 基础级，清单不含 `terminal`/`process`/`discover` | `docs/PLUGIN-CATALOG.md:81,85,90` |
| 索引 | **15** production / **9** basic | `../kore-plugins/index/plugins.json`（A1） |
| 仓库 `info.json` | 15 条全部 `production` | 各仓 `info.json:7` |

**影响（产品级，必须明说）：**

1. **用户被过度承诺**：商店按索引给 15 条打「生产级」，但按文档判据 0 条够格。用户以为买到的是「边界用例 + 故障注入双达标」，实际拿到的是「故障注入达标 + 边界用例大面积缺失」。
2. **门禁结构性放过**：`G-20`（AGENTS.md §2）只要求 `production` 有 `tests/fault/`，**从不校验 `tests/boundary/` 与四类用例**；`presets-check.sh` 只校验索引↔仓库一致。所以「索引写 production + 建个 tests/fault/」就能过门禁——这使得 `production` 标签在工程上等价于「有 fault 测试」，而不是文档承诺的两条判据。
3. **文档与索引差 3 条**（`terminal`/`process`/`discover`）：§6.1 的 12 条清单本身已经落后于索引，说明「12/8」这个口径既没被索引执行、也没被门禁守。
4. 换句话说：**今晚那 8 条「索引与仓库不一致」只是表象；真正的病是 15 条一致地过度声明——一致不等于正确。**

---

## 7. 收敛建议与代价对比

### 方案 A：降级（把不达标的 `production` 改回 `basic`）

- 做法：`terminal`/`process`/`discover` + ①≤1 类的 6 条 → `basic`；仅 `logs`/`site`/`app-deploy`/`terminal`/`process`/`firewall` 这 6 条接近（2–3/4）可留 `production` 但限期补并发。
- 代价：索引 + 15 仓 `info.json` + `docs/PLUGIN-CATALOG.md:81,85` 同步 ≈ **0.5 人日**，无代码改动。
- **硬约束（必须先算清）**：`G-20` 规定 `out_of_box` 预设不得引用 `basic`。当前 3 个 `out_of_box` 预设引用了 6 条 production：
  - `web-lite`：`site` `ssl` `runtime-php`
  - `web-pro`：`site` `ssl` `monitor` `logs` `runtime-php` `db-mysql`
  - `minimal`：0 条
  若把其中 `monitor`/`db-mysql`/`runtime-php`/`ssl` 降级，`presets-check.sh` 会直接 FAIL → 必须同步改预设（把降级插件移出 `out_of_box`，等于收缩「开箱可用」承诺）或改为锁定 production 后补齐。**这是降级方案真正的成本，不是改字段，是改产品承诺。**
- 收益：标签立刻诚实；`12/8` 可收敛为可核对的数字。

### 方案 B：补齐（让 15 条真的够格）

- 做法（每仓）：建 `tests/boundary/`，补 4 类用例——异常输入（已有 11 仓，补 4 仓：`monitor`/`redis`/`discover` + `terminal` 加强）、并发（15 仓全缺，至少 1 个多 goroutine 同方法/同 socket 用例，CI 加 `-race`）、权限不足（10 仓缺，需构造不可写目录或非 root 路径）、资源耗尽（13 仓把旗标换成真实 `ulimit -v`/`/dev/full`/tmpfs 满盘）。
- 代价：**15 仓 × 1–2 人日 ≈ 15–30 人日**；其中 `monitor`/`redis`/`discover` 属只读插件，权限用例需设计可触发的 EACCES 场景（可能要加只读挂载点或伪造目录），成本最高；并发用例对 `terminal`/`ssl` 这类有状态插件需额外做竞态设计。
- 收益：标签名副其实，且把 `-race` 纳入 CI 能顺带抓真实的并发缺陷。

### 推荐：分层收敛（先修口径，再补能力）

1. **本轮（0.5 人日，只改数据不改代码）**：按证据重定级——保留 6 条 2–3/4 的 `production`（`logs`/`site`/`app-deploy`/`terminal`/`process`/`firewall`），其余 9 条降 `basic` 并在 `docs/PLUGIN-CATALOG.md` 注明「v1.1 补边界用例后回升」；同步 3 个 `out_of_box` 预设，移除降级插件。
2. **下轮（6 仓 × 1 人日 ≈ 6 人日）**：给保留的 6 条补 `tests/boundary/` + 并发用例 + 真实资源注入，CI 加 `-race`。
3. **根因治理（必做，否则必复发）**：把 `G-20` 从「`tests/fault/` 存在」升级为「`tests/boundary/` 存在且四类标记齐全 + `go test ./...` 跑绿 + 索引==`info.json`==文档清单三方一致」，否则下一次还会出现「索引一致但声明过度」。

**不推荐**：只在文档里把判据改宽（比如删掉「并发」）——那是改尺子，不是改事实。

---

## 8. 未确认项

- `runtime-php`/`db-mysql`/`redis`/`backup`/`firewall`/`discover` 的 `Fault*` 旗标是否在**其他**测试文件里另有真实注入路径：本轮以 `tests/fault/` 与 `tests/e2e/` 全量文件名为准，未见真实 `kill -9`/满盘/`syscall` 资源限制代码；若有遗漏，属**未确认**，不改变「并发 0 命中」这一硬缺口。
- `terminal` 的 `E_INVALID×1` 与 corrupt store 是否构成严格意义上「异常输入」：按宽松口径记 △；即使记 ✓，其①仍为 2/4（缺并发 + 资源为旗标），判定不变。

---

## 附录：复现命令

```bash
# A1 索引分布与 production 清单
python3 - <<'EOF'
import json
d=json.load(open('../kore-plugins/index/plugins.json'))
from collections import Counter
print(Counter(p['depth_level'] for p in d['plugins']))
print([p['id'] for p in d['plugins'] if p['depth_level']=='production'])
EOF

# A2 boundary / t.Parallel 全量统计
cd .. && for id in site file ssl cron monitor logs runtime-php db-mysql redis backup firewall app-deploy terminal process discover; do
  r="kore-plugin-$id"
  b="-"; [ -d "$r/tests/boundary" ] && b="YES"
  printf "%-11s boundary=%-3s tParallel=%s\n" "$id" "$b" "$(grep -rn 't.Parallel' $r/tests 2>/dev/null | wc -l)"
done

# A3 fault 实跑（逐仓，-count=1 不吃缓存）
for id in site file ssl cron monitor logs runtime-php db-mysql redis backup firewall app-deploy terminal process discover; do
  ( cd kore-plugin-$id && go test ./tests/fault/ -count=1 -v >/dev/null 2>&1; echo "$id rc=$?" )
done
```
