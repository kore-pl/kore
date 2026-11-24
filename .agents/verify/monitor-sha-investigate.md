# monitor 0.3.0 dist sha 不一致调查（P1 · 只读）

> 元信息: 2026-11-24 · 执行 monitor-sha-investigate · **只诊断，未改索引 / 未重打包 / 未动 tag 与 release / 未删本地 dist** · 未 push
> 判据: [RELEASE.md](../../docs/RELEASE.md) §0（同 `id@version` 只允许一个 sha）、AGENTS.md G-17（`file:76`）

## 0. 结论先行

**判定 = A（索引 == 已发布资产，本地重建物不同 → 本地野产物）**，不是 B，也不是 C。

- 索引 / 账本 / 已发布资产 / `v0.3.0` 干净树重打包 **四者 sha 与大小完全相等**（`db747aad…` / `1344418`）；
- 本地 `dist/monitor-0.3.0.tar.gz` 与 **HEAD 干净树**重打包位级相等（`469c150b…` / `1445790`）；
- 101372 字节差异**不是**「monitor 业务源码变了」，而是 `go.mod` 里 `pkg/pluginapi v0.1.1 → v0.1.3` 在 `71fd994` 被提交（**依赖升级同样改变 dist sha，按 RELEASE.md:18 必须 bump**）。

## 1. 五处 sha / size 对照表

| # | 来源 | version | sha256 | size | 依据（file:line / 命令） |
| --- | --- | --- | --- | --- | --- |
| 1 | 索引 `plugins.json` | 0.3.0 | `db747aad…4f5ba667` | 1344418 | `kore-plugins/index/plugins.json:122,125,126` |
| 2 | 账本 `versions.lock.json` | 0.3.0 | `db747aad…4f5ba667` | —（账本无 size） | `kore-plugins/index/versions.lock.json:241-242` |
| 3 | `kore-plugin-monitor/info.json` | 0.3.0 | —（info 无 sha） | 1344418 | `kore-plugin-monitor/info.json:4,31` |
| 4 | 已发布资产 GitHub `v0.3.0` | 0.3.0 | `db747aad…4f5ba667` | 1344418 | `curl -L …/releases/download/v0.3.0/monitor-0.3.0.tar.gz` → http=200 size=1344418；`sha256sum` |
| 5 | 本地 `dist/monitor-0.3.0.tar.gz` | 0.3.0 | `469c150b…202b37a9` | 1445790 | `sha256sum dist/monitor-0.3.0.tar.gz`；mtime `2026-11-24 08:57:23` |

一致性结论：**1 == 2 == 4（另 3 的 size 与它们一致），只有 5 偏离**。索引没错，release 资产没错，错的是本地那份重建物。

补充：本地 dist 目录内历史版本与账本仍自洽（`monitor-0.2.0` = `6cc7cac0…`、`monitor-0.2.1` = `fb153e56…`，均命中 `versions.lock.json:223-245` 的 monitor 段），偏离只有 0.3.0 一个文件。

## 2. 判定依据：干净树重打包双向复现（位级相等）

两条命令均在 `/tmp` 用 `git archive` 出的干净树执行，**未触碰工作树、未动 dist、未动 tag**：

```text
# tag v0.3.0（= 索引版本对应的提交 b95e72b）
cd /tmp/mon-tag && GOFLAGS=-mod=mod GOPROXY=off make dist
打包完成: dist/monitor-0.3.0.tar.gz sha256=db747aad1dc533c9275f1e53abba27c90f5a4e0c32bfd6de2f6213ad4f5ba667 size_bytes=1344418 实际=1344418

# HEAD（59aa5fc，go.mod 已含 pluginapi v0.1.3）
cd /tmp/mon-head && GOFLAGS=-mod=mod GOPROXY=off make dist
打包完成: dist/monitor-0.3.0.tar.gz sha256=469c150bbcec478a4c34d717e41ae262cfe722dd565196656f7a32df202b37a9 size_bytes=1445791 实际=1445790
```

即：**索引 == 已发布资产 == tag 干净树产物**；**本地 dist == HEAD 干净树产物**。这不是「工具链差异」这种模糊归因，是可复现的「同一版本号在两个提交上各打了一次包」。

```
tag  SHA = 索引 SHA = 已发布资产 SHA = db747aad…  ✅
HEAD SHA = 本地 dist SHA            = 469c150b…  ⚠️ 野产物
```

## 3. 101372 字节差异的解释（可量化归因）

包内成员只有 3 个（`info.json` / `bin/monitor` / `SHA256SUMS`），差异全在二进制：

| 项 | 已发布（tag v0.3.0） | 本地（HEAD） | 差值 |
| --- | --- | --- | --- |
| `bin/monitor` 字节数 | 3170466 | 3461282 | **+290816（+9.17%）** |
| `.text` | 3075823 | 3311248 | +235425 |
| `.data` | 82731 | 137451 | +54720 |
| 包体 tar.gz | 1344418 | 1445790 | **+101372（压缩率约 34.9%）** |

`go version -m` 直接坐实唯一变量（工具链相同 = go1.26.8、`-trimpath`、`CGO_ENABLED=0`、`GOAMD64=v1`）：

```text
published: dep github.com/pengtang1024/kore/pkg/pluginapi v0.1.1 h1:+JsGwNcTpd8/…
local    : dep github.com/pengtang1024/kore/pkg/pluginapi v0.1.3 h1:PwOZ0RaGs3iu…
```

`git diff v0.3.0..HEAD` 共 17 个文件，**业务源码 0 改动**：全是 `tests/boundary/*`（5 个新测试）、OSS 九件套文档、`.github/`、以及 `go.mod`/`go.sum`。`71fd994 chore(deps): pluginapi v0.1.3` 把依赖从 v0.1.1 升到 v0.1.3，v0.1.3 相对 v0.1.1 新增 **2300 行**：

- `pkg/pluginapi/rootpolicy.go`（737 行 / 32242 字节，静态命令形状表）→ 主要是 `.data` +54720 的来源；
- `pkg/pluginapi/rootaction.go`（146 行）、`errors.go`（+4 行）→ `.text` 增量的主因之一；
- `pkg/pluginapi/pluginapitest/`（330 行）只被测试引用，不进插件二进制。

所以差异机制是：**依赖升级 → 编进二进制的代码/静态表变多 → 二进制 +290816 → gzip 后包体 +101372**。业务行为未变，但 dist 字节变了——这正是 [RELEASE.md:18,27-31](../../docs/RELEASE.md) 明写「`go.mod`/`go.sum` 依赖升级也算改变 dist sha 的改动，必须 bump」的场景（`firewall@0.2.3` 同款）。

另一处可证「本地包是 `make dist` 产物但回填被还原」：包内 `info.json` 声明 `size_bytes: 1445791`（`tar -xOzf … info.json`，符合 Makefile:30-34 的 ±2 收口），而仓库 `info.json:31` 仍是 `1344418`；`git status --short` 显示 `info.json` 干净。即打包写入的回填值在打包后被还原/未落工作树（**具体手法未确认**，见 §6），所以仓库 `info.json` 与本地包不是同一代产物。

## 4. `store-check` 为什么没报（`file:line` + 触发条件）

先给当前事实：**现在跑会报**，而且是 WARN 级不阻断：

```text
$ bash scripts/store-check.sh
[OK] kore-plugin-monitor (desc-source: name)
[WARN] kore-plugin-monitor: DIST_SHA_DIFF monitor 0.3.0 index=db747aad… dist=469c150b…
store-check: 24 pass, 0 fail, 1 warn   (exit=0)
```

所以「门禁不检测 sha 不一致」这个猜想不成立。0 warn 的真实原因是**时间差 + 缺件静默跳过**：

| 时点 | 事件 | 证据 |
| --- | --- | --- |
| 2026-11-24 01:43 | 独立验收记录 `store-check: 24 pass, 0 fail, 0 warn` | `.agents/verify/independent-verify-2026-11-24.md:65`（文件 mtime 01:43:01），`:234` 用 `grep -c '^\[WARN\]'` 复核 |
| 2026-11-24 08:57:23 | 才生成 `dist/monitor-0.3.0.tar.gz`（HEAD 重建） | `stat -c '%y' dist/monitor-0.3.0.tar.gz` → `2026-11-24 08:57:23.848` |

机制（`scripts/store-check.sh`）：

- `:294` 守卫 `HAS_INDEX and pid_for_dist and os.path.isdir(dist_dir)`；
- `:296` **只遍历 `os.listdir(dist_dir)` 里已存在的文件**，没有「该版本应有 dist 却没有」的分支；
- `:309-317` 版本命中账本 → 取 expected；`:318-320` **`expected` 找不到才 `continue`**；
- `:327-330` 只有「文件存在且 sha 不等」才 append `DIST_SHA_DIFF`；
- `:30` 文件头把「dist 该版本不存在 → 静默跳过」写成**设计行为**。

即：01:43 那次运行时 `dist/` 里只有 0.1.0/0.1.1/0.2.0/0.2.1（且四者与账本一致），0.3.0 包**根本不存在** → 循环不进入 → 0 warn。这是「**缺件不可见**」，不是「存在却不一致没报」。

因此本卡对门禁的判定是：**DIST_SHA_DIFF 判据本身没有漏检**（存在即报，已实测），但有两个真实缺口需要单独开卡：

1. **缺件静默**：索引当前版本的 dist 不在本地时，门禁既不 WARN 也不 `[SKIP]`，输出与「一致」不可区分——这正是本次被误读成「门禁没检测到」的根因。
2. **文档口径过期**：`QUALITY-GATES.md:69` 与 `.agents/verify/independent-verify-2026-11-24.md:65` 仍写「当前 24 pass / 0 fail / 0 warn」，08:57 重建后已变成 1 warn，需在下次刷新口径时更新（本卡不改）。

## 5. 处置建议（选 A）

| 动作 | 内容 | 本卡是否执行 |
| --- | --- | --- |
| **A. 清本地野产物** | 删除/移走 `kore-plugin-monitor/dist/monitor-0.3.0.tar.gz` 及其 `.sha256`（0.1.x/0.2.x 保留），使 store-check 回到 0 warn | ❌ 本卡只诊断 |
| **A. 不碰索引与 release** | 索引 `db747aad…` 与 GitHub `v0.3.0` 资产均正确，**不得改索引 sha、不得用 HEAD 重打 0.3.0 覆盖发布** | — |
| **下一发版 bump 0.3.1** | HEAD 已领先 tag 4 个提交且含依赖升级（`pluginapi v0.1.3`），按 RELEASE.md:18/27-31、AGENTS.md G-17 必须新版本承载；`make dist` 后同步 `versions.lock.json` + `plugins.json` + 重签 | 后续卡 |
| **门禁补缺件可见性**（另开卡） | `store-check.sh` 在「索引当前版本的 `<id>-<ver>.tar.gz` 不在 dist/」时输出 `[SKIP] … 本地 dist 缺失`（或 WARN `DIST_ABSENT`），让缺件 ≠ 一致 | 后续卡 |

补充说明（为什么不是 C）：已发布资产就是 `b95e72b`（`v0.3.0` tag，`git log -1 v0.3.0` = `2026-11-23 12:57:52 feat(monitor): …（v0.3.0）`）的产物，**不是旧代码错版**；HEAD 之后只有测试/文档/依赖升级，没有业务源码改动，所以不需要「用新版本承载源码修复」，但**必须**用新版本承载依赖升级带来的 dist 变化。

## 6. 未确认

- **本地 0.3.0 包的生成手法**：是「工作树 `make dist` 后 `git checkout -- info.json`」，还是「干净树/副本打包后把 tar 拷回 `dist/`」——两者留下的状态相同（仓库 `info.json` 干净 + 包内 `size_bytes=1445791`），**未确认**具体是哪一种。
- **08:57 这次重建的执行者/任务号**：仓库无操作日志，`git status` 只有未跟踪的 `RELEASE-EVIDENCE.md`，**未确认**。
- 账本无 `size_bytes` 字段，故第 2 行只能比 sha，不能比 size（不是缺证据，是 schema 如此）。

## 7. 复现命令（全部只读）

```bash
# 索引 / 账本 / info.json
sed -n '120,127p' ../kore-plugins/index/plugins.json
sed -n '223,245p' ../kore-plugins/index/versions.lock.json
grep -n size_bytes ../kore-plugin-monitor/info.json

# 已发布资产（下载到 /tmp，哈希后即弃）
curl -sSL -o /tmp/mon-published.tar.gz \
  https://github.com/kore-pl/kore-plugin-monitor/releases/download/v0.3.0/monitor-0.3.0.tar.gz
sha256sum /tmp/mon-published.tar.gz            # db747aad… / 1344418

# 本地 dist
sha256sum ../kore-plugin-monitor/dist/monitor-0.3.0.tar.gz   # 469c150b… / 1445790

# 双向复现（干净树，不碰工作树）
git archive v0.3.0 | tar -x -C /tmp/mon-tag && (cd /tmp/mon-tag && make dist)   # db747aad…
git archive HEAD   | tar -x -C /tmp/mon-head && (cd /tmp/mon-head && make dist) # 469c150b…

# 门禁现状
cd .. && bash scripts/store-check.sh | grep -E 'monitor|store-check:'
```
