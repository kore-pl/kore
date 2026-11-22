> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M5

# 提案：0005 · M5 Ecosystem（功能覆盖补账 / 生态开放 / 索引签名链串行）

承接 [0004 §5 M5 预告](0004-m4-core-hardening.md)、[PARITY-GAP §2/§4](../../docs/PARITY-GAP.md) 与 [裁决台账](../LOG/DECISIONS.md) 第 43 条：M4 已按裁决 43 收口为 completed，未证明项挂账 M5。本提案把 M1–M4「内核机制优先」欠下的功能覆盖账在 M5 一次性补齐，并开生态。

**背景事实（不回避，作为两阶段出发点）**：[ROADMAP](../../docs/ROADMAP.md) 原定 20 个产品插件在 M2–M4 完成、`v1.0 gate` 位于 M4（ROADMAP:7,12,14）；实际 M1–M4 走内核机制优先路线，磁盘上仅 `echo` / `site` 2 仓落地，索引 `plugins.json` 仅 2 条，8 个场景预设多为占位（PARITY-GAP:17,107-110）。M4 收口（裁决 43）已把 **19 个产品插件仓**整体挂账 M5。因此 M5 分两阶段：**M5-A 补功能覆盖，M5-B 做生态开放**。

## 1. 目标与非目标

**目标**：

- **功能覆盖**：补齐 v1.0 功能覆盖面——建齐余下 **19 个产品插件仓**（20 产品插件中 `site` 已在、余 19；`echo` 验证件不计），每仓最小可装可卸；把 8 个场景预设从占位填成真实 id + 版本区间引用（G-18 可解析）。
- **生态开放**：静态市场页（由索引生成、断网可开、无后端无账号）；第三方 SDK 文档（30 分钟 hello）；文档站；示例插件。

**非目标**：

- **macOS / Windows 全链路**：preview 不变（交叉编译 + 基础链路，不计入交付判据），依裁决 35 本机优先，不为多平台牺牲本机稳定性。
- **多租户 / SaaS**：G-11 明确不做；6 项不做清单（多用户 RBAC、集群/多机、模板市场、厂商云存储深度集成、拖拽建站、i18n）全程 G-11 拦截，命中即退回提案。
- **在线市场后端 / 审核流程 / 账号体系**：市场页为纯静态，不引入服务端与用户系统。

## 2. 两阶段与批次（核心）

### 2.1 M5-A 插件铺开（达成功能覆盖）

按依赖分批，同批并行、批间串行；三批合计 **19 仓**。每行格式 `id | 深度 | 依赖 | 一句话能力`，id / 深度 / 依赖 / 能力逐字取自 [V1-GOALS §23](../../docs/V1-GOALS.md)、[PLUGIN-CATALOG §1–5/§6.1](../../docs/PLUGIN-CATALOG.md)，不新增 id。

**批 1 · 无依赖基础件（8 仓）**（"无依赖"指无硬依赖；`site` / `firewall` 为可选依赖，不阻塞独立安装）：

| id | 深度 | 依赖 | 一句话能力 |
| --- | --- | --- | --- |
| `ssl` | 生产级 | `site`（可选） | SSL 证书签发 / 自动续期 / 部署 |
| `file` | 生产级 | — | 文件在线编辑 / 上传 / 解压 / 权限 |
| `cron` | 生产级 | — | 计划任务 + 执行日志（宿主调度器触发） |
| `logs` | 生产级 | — | 日志分类 / 过滤 / 下载 |
| `monitor` | 生产级 | — | CPU / 内存 / 磁盘采样 + 阈值告警 |
| `dns` | 基础级 | — | DNS 区域 / 记录管理（管理宿主实例） |
| `ssh-guard` | 基础级 | `firewall`（可选） | SSH 失败封禁 / 配置审计 |
| `integrity` | 基础级 | — | 关键文件哈希基线 + 变更告警 |

**批 2 · 运行时与数据（7 仓）**：

| id | 深度 | 依赖 | 一句话能力 |
| --- | --- | --- | --- |
| `runtime-php` | 生产级 | — | PHP 运行时 / 版本切换（管理宿主 FPM） |
| `runtime-node` | 基础级 | — | Node 进程守护 / 端口分配 |
| `runtime-python` | 基础级 | — | Python 运行时 / 模板 |
| `db-mysql` | 生产级 | — | MySQL/MariaDB 实例管理 / 慢查询 |
| `db-postgres` | 基础级 | — | PostgreSQL 实例 / 连接管理 |
| `redis` | 生产级 | — | Redis 实例 / 内存策略 / 键扫描 |
| `backup` | 生产级 | `db-*`（可选） | 本地 + S3 兼容对象存储备份 / 恢复 |

**批 3 · 运维与应用（4 仓）**：

| id | 深度 | 依赖 | 一句话能力 |
| --- | --- | --- | --- |
| `firewall` | 生产级 | — | 防火墙规则 / 端口放行（只改 `kore:` 段） |
| `waf` | 基础级 | `site`（可选前置） | WAF 规则集 / 拦截日志（前置串联） |
| `container` | 基础级 | — | Docker/Podman 面板（管理宿主已有服务，不内置运行时） |
| `app-deploy` | 生产级 | `site`；`runtime-*` / `db-*`（可选） | WordPress/Laravel/Next.js 一键部署模板 |

**每仓最小交付集**（G-17 / G-20）：可安装 + 可卸载 + 可回滚五步记录；`info.json`（含 `depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore` / `depth_level`）；`Makefile` 的 `dist` 目标；`CHANGELOG.md`；`LICENSE`（MIT）；`tests/fault/`。**生产级 12 个**（上表 8 个 + `site` + `runtime-php` 已在批 1/2 列出，合计 12）必须过四类故障注入：`kill -9`、超时、磁盘满、cgroup 超限各 1 次并进 CI（G-20）。基础级 8 个边界用例延 v1.1，但核心路径可用，不得标"生产级 / 开箱可用"。

### 2.2 索引签名链串行规则（硬约束）

每批插件出包后**必须重签索引**，一批一签，不跨批混签：

- 批内全部 `make dist` 完成 → 收集新 sha256 → 重签 `index/plugins.json` + `.sig` → **轮换新公钥**（新公钥同步内核 `verify.go` 与索引 `validate-index.sh`，两端逐字相同）→ 交叉验签测试（`TestIndexVerifyCrossCheck`）通过 → 才进入下一批。
- 规则依据：裁决 33（索引签名时机）、34（打包确定性与公钥同步）、43（第五次重签后四仓一致）、51（新公钥轮换）。
- 判据：`git` 中出现 3 次独立重签提交（批 1/2/3 各一次），每次含「新 sha + 新公钥 + 交叉验签通过」三件。公钥一致性**不用单边 `grep -qF`**（挡不住双端都残留旧串、`head -1` 恰取旧值）：须双端公钥各唯一、交集唯一且 `TestIndexVerifyCrossCheck` 存在（命令见 §4.8，输出 `OK`，`KEY-MISMATCH` 即失败）。跨批混签、旧公钥残留、未验签即进下一批 → 该批判未完成。

### 2.3 M5-B 生态开放

- **静态市场页**：由 `kore-plugins` 索引生成，断网可开、零外部请求、无后端无账号；展示插件等级（G-20）与 8 预设。
- **第三方 SDK 文档**：`pkg/pluginapi` 独立 module 使用说明，干净目录 `go get` + hello 调用，30 分钟可跑通。
- **文档站**：离线可构建的静态站点，聚合 VISION / 协议 / 插件开发 / 商店与预设。
- **示例插件**：以 `echo` 为模板的最小第三方插件示例，随 SDK 文档发布。

## 3. 风险 5 条

| # | 风险 | 触发信号 | 缓解与验收抓手 |
| --- | --- | --- | --- |
| R1 | **19 仓并行写域 / 磁盘 IO**：同层并行若 `write_scopes` 重叠会互相覆盖；集中出包磁盘 IO 争抢致 sha 漂移。 | 两仓改同一文件；`make dist` 跨秒 sha 不一致；`git status` 出现他人未提交改动。 | 每仓独立写域与独立 agent 轨道（G-08），同批最多 4 仓并行（ROADMAP:124）；确定性打包（`--sort=name --mtime=@0 --owner=0 --numeric-owner` + `gzip -9n`、`GOWORK=off`）；**复建一致性由 §4.8 的 `SHA-DRIFT` gate 挡住，不以"写了 --sort=name"当达标**。 |
| R2 | **索引重签串行瓶颈**：一批一签是硬串行点，批 2/3 出包后若排队等签名，拖垮整体节奏；轮换只改一端致合法包全链拒签。 | 跨批混签；内核 `verify.go` 与 `validate-index.sh` 公钥不一致；篡改包被接受。 | 每批固定一次重签窗口（§2.2），签名队列不积压；双验窗口结束再撤旧公钥；**公钥一致性由 §4.8 的 `KEY-MISMATCH` gate 挡住（双端唯一 + 交集唯一 + 交叉验签），不用单边 `grep -qF`**。 |
| R3 | **`size_bytes` 代理偏差**：M4 已记为记录级 WARN，代理值与实际包体积不符会误导 G-18 预算合计。 | `size_bytes` 与 `stat -c%s dist/*.tar.gz` 偏差 > 10%；预设合计 RSS 误判达标。 | 出包后以实测包体积回写 `size_bytes`，不静默沿用代理值；**偏差 >10% 由 §4.8 的 `SIZE-PROXY-DRIFT` 出口 gate 阻断，不再只记 WARN 放行**。 |
| R4 | **生产级故障注入四类覆盖**：12 生产级若只测 `kill -9`、缺超时/磁盘满/cgroup 三类，G-20 形式通过实质漏测。 | 某仓 `tests/fault/` 少于 4 例；CI 只跑 1 类；空测试函数无断言；基础级被标生产级。 | 每生产级仓四类用例齐全且 CI 绿，缺任一类即降级（G-20）；**由 §4.8 的 `FAKE-PASS` gate 逐仓逐类核 kill/timeout/disk/cgroup 四文件，不以"CI 12/12 绿"当充分证据**。 |
| R5 | **SDK 与协议漂移**：第三方按文档 30 分钟 hello 跑不通，或 SDK 版本与 `kore.plugin.v1` 不同步致合法插件握手失败。 | 干净目录 `go get` 构建失败；hello 返回非 `pong`；`requires_kore` 与 SDK 版本错配。 | SDK 版本与 `kore.plugin.v1` 联动校验；以干净目录 `go get` + 断网 hello 实测为准，30 分钟不可跑通即文档不达标。 |

## 4. 验收出口（M5 完成定义）

全部满足才判 M5 完成，任一项不满足即继续或证据化交接，不降尺子（G-07）：

1. **21 仓可装可卸**：20 产品插件（12 生产级 + 8 基础级）+ `echo` 均可经商店安装 / 卸载 / 回滚，索引 sha256 与发布物一致；**之前先过 §4.8 `SHA-DRIFT` gate**（v1.0 功能覆盖达成）。
2. **8 预设真实引用**：`presets/*.json` 8 个预设的 id + 版本区间可在索引解析、无占位；**合计资源按 ≤24 MiB 目标 + 常驻 ≤3 判（非 G-18 的 48 MiB 红线），过 §4.8 `PRESET-OVER-BUDGET` gate**（见 §4.8 口径说明）。
3. **12 生产级过 fault**：每仓四类故障注入用例 + CI 12/12 绿；**以 §4.8 `FAKE-PASS` gate 逐仓逐类核实为准，"CI 12/12 绿"不构成充分证据**（G-20）。
4. **市场页断网可开**：静态页离线打开、零外部请求。
5. **SDK 30 分钟 hello**：干净目录 `go get` + hello 实测通过。
6. **门禁**：`make docs-check` 通过；`make check` 10/10 全绿。
7. **干净 clone**：`git archive HEAD | tar -x -C /tmp/kore-m5-clean` 后复跑 `make docs-check && make check` 同为 10/10、`make wt-check` 无残留 worktree，证明产物自洽（裁决 35）。
8. **挡假绿的命令级 gate（五条，输出必须为 `OK`）**——红队验尸 0006 的 S-01~S-05，任一命中即该出口不达标：

   **S-01 公钥一致（KEY-MISMATCH）**：双端公钥各唯一、交集唯一、交叉验签测试存在，替代单边 `grep -qF`：
   ```bash
   a=$(grep -oE '[0-9a-fA-F]{40,}' scripts/validate-index.sh | sort -u | wc -l); b=$(grep -oE '[0-9a-fA-F]{40,}' internal/core/market/verify.go | sort -u | wc -l); c=$(comm -12 <(grep -oE '[0-9a-fA-F]{40,}' scripts/validate-index.sh | sort -u) <(grep -oE '[0-9a-fA-F]{40,}' internal/core/market/verify.go | sort -u) | wc -l); test "$a" -eq 1 && test "$b" -eq 1 && test "$c" -eq 1 && grep -qr 'TestIndexVerifyCrossCheck' internal/core/market/ && echo OK || echo KEY-MISMATCH
   ```

   **S-02 复建一致性（SHA-DRIFT）**：有 dist 产物的批上同源码两次出包 sha 一致，无产物记 `NO-DIST` 不算绿：
   ```bash
   d=$(mktemp -d); cp -a . "$d/src" 2>/dev/null; f=$(find . -name '*.tar.gz' -path '*dist*' | head -1); [ -z "$f" ] && { echo NO-DIST; exit 0; }; s1=$(sha256sum "$f" | cut -d' ' -f1); (cd "$d/src" && GOWORK=off make dist >/dev/null 2>&1); s2=$(sha256sum "$d/src/${f#./}" 2>/dev/null | cut -d' ' -f1); rm -rf "$d"; test "$s1" = "$s2" && echo OK || echo SHA-DRIFT
   ```

   **S-03 size_bytes 偏差（SIZE-PROXY-DRIFT）**：任一仓 `size_bytes` 与实测包体积偏差 >10% 即阻断，不降级为 WARN：
   ```bash
   bad=0; while IFS= read -r j; do d=$(dirname "$j"); p=$(grep -oE '"size_bytes"[[:space:]]*:[[:space:]]*[0-9]+' "$j" | grep -oE '[0-9]+'); a=$(find "$d" -name '*.tar.gz' -path '*dist*' -printf '%s\n' 2>/dev/null | sort -n | tail -1); [ -z "$p" ] || [ -z "$a" ] && continue; [ $(( (a>p ? a-p : p-a) * 100 / p )) -gt 10 ] && { echo "DRIFT $j declared=$p actual=$a"; bad=1; }; done < <(find . -name info.json -not -path '*/node_modules/*'); test "$bad" -eq 0 && echo OK || echo SIZE-PROXY-DRIFT
   ```

   **S-04 四类故障注入（FAKE-PASS）**：逐生产级仓核 kill/timeout/disk/cgroup 四类各落文件，空测试/`t.Skip` 不算数：
   ```bash
   bad=0; for d in $(find . -name info.json -exec grep -l '"depth_level"[[:space:]]*:[[:space:]]*"production"' {} \; | xargs -r -n1 dirname); do n=$(find "$d/tests/fault" -type f -name '*_test.go' 2>/dev/null | wc -l); k=$(grep -rlE 'kill|Kill' "$d/tests/fault" 2>/dev/null | wc -l); t=$(grep -rlE 'timeout|Timeout' "$d/tests/fault" 2>/dev/null | wc -l); f=$(grep -rlE 'disk|Disk|ENOSPC' "$d/tests/fault" 2>/dev/null | wc -l); c=$(grep -rlE 'cgroup|Cgroup|memory\.max' "$d/tests/fault" 2>/dev/null | wc -l); { [ "$n" -ge 4 ] && [ "$k" -ge 1 ] && [ "$t" -ge 1 ] && [ "$f" -ge 1 ] && [ "$c" -ge 1 ]; } || { echo "FAULT-GAP $d kill=$k timeout=$t disk=$f cgroup=$c"; bad=1; }; done; test "$bad" -eq 0 && echo OK || echo FAKE-PASS
   ```

   **S-05 预设资源口径（PRESET-OVER-BUDGET）**：口径消歧——`G-18` 的 `≤48 MiB` 是红线、`ROADMAP:14` 的 `≤24 MiB` 是 v1.0 gate 取证目标；**v1.0 gate 一律按目标值 ≤24 MiB（24576 KiB）+ 常驻 ≤3 判，不用红线口径放行**；红线/目标/gate 三口径差异须在 ADR 记录（G-06 / ROADMAP §11），避免 G-03 与 ROADMAP:14 继续漂移：
   ```bash
   bad=0; for p in $(find . -name '*.json' -path '*presets*'); do r=$(grep -oE '"(rss|rss_kib|size_bytes)"[[:space:]]*:[[:space:]]*[0-9]+' "$p" | grep -oE '[0-9]+' | awk '{s+=$1} END{print s+0}'); res=$(grep -o '"resident"' "$p" | wc -l); { [ "$r" -le 24576 ] && [ "$res" -le 3 ]; } || { echo "OVER-BUDGET $p rss_kib=$r resident=$res"; bad=1; }; done; test "$bad" -eq 0 && echo OK || echo PRESET-OVER-BUDGET
   ```

## 5. v1.0.0 tag 判定（需 lead/用户裁决）

**问题**：ROADMAP:12/15 写「M4 完成即打 `v1.0.0`」「M4 → v1.0.0、M5 → v1.1.0」，但 M4 实际只落内核机制 + echo/site 2 仓，v1.0 gate 的五项条件在 M4 未实质达成，到 M5-A 才齐（裁决 43 / PARITY-GAP:107-111）。红队实测 `git tag -l` 仓库仅有 `pkg/pluginapi/v0.1.0`、`pkg/pluginapi/v0.1.1`，**根本不存在 `v1.0.0`**——此前"回打制造两个 v1.0.0 / 冻结已发 v1.0.0 语义"的前提不成立，须纠正。

**明确建议：M5-A 完成（§4 八条出口全绿）即补打 `v1.0.0` 兑现 ROADMAP gate；M5-B 生态开放收口打 `v1.1.0`。** 依据：

- **兑现字面 gate**：ROADMAP:14 的 v1.0 gate 五项条件（21 仓可装可卸 / 12 生产级过故障注入 / Linux 全矩阵 smoke / 三处文案一致 / 资源达标）在 M5-A 才实质达成，按 :15「全部满足才打 `v1.0.0`」应在达成点补打，而非让"功能覆盖达标却无 v1.0 tag"出现版本断点。
- **现状无 tag 可冲突**：既然 `v1.0.0` 从未存在，补打不产生双 tag 语义、不破坏 :15「发布物只从对应 tag 构建」——恰是修复断点，不是制造断点。
- **消歧九类 vs 五项**：V1-GOALS:77-89 的"九类取证"与 ROADMAP:14 的"五项 gate"是同一 gate 的两种粒度（九类为细化取证项，五项为里程碑出口摘要）。本提案以五项为 tag 触发判据、以九类为五项的证据明细（§4 八条出口已覆盖五项 + 九类的可复跑命令），不再拿九类当"不打 tag"的理由。
- **版本叙事自洽**：M5-A → `v1.0.0`、M5-B → `v1.1.0`，与 ROADMAP 的 1.x 语义一致；M5-A 之前的 0.x 版本线（M0–M3）不受影响。

**裁决要求（需 lead/用户裁决）**：此路径需走 ROADMAP §11 变更规则 + ADR，把发布点由「M4 → v1.0.0、M5 → v1.1.0」改为「M5-A → v1.0.0、M5-B → v1.1.0」，并同步 ROADMAP §1/§15、每仓库 tag 台账与三处文案口径（G-06）。此判定交 lead / 用户拍板后落 [裁决台账](../LOG/DECISIONS.md)，本提案不预设裁决已生效；未裁决前不打任何 `v1.0.0` tag。
