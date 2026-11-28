# 干净 clone 独立复现构建验证（round 43 / task-297）

> 状态: verified · 归属: clean-clone · 更新: 2026-11-28 · 里程碑: M5 / R43
> 目标: 证明「过去 42 轮都在脏工作区跑」的构建/门禁，能否在**工作区外干净 clone**上独立自洽复现。
> 写域: 仅本文件。不改生产代码 / 不 bump / 不发版；真实不可复现缺陷只记录 + file:line 报 lead 另派卡。

## 0. 结论先行

| 验证项 | 结果 | 关键判据 |
|---|---|---|
| ①从零构建流程只读回读 | ✅ 确认顺序 | Makefile `web-dist` 前置自动补 `web/dist`；`make build` 一条命令即可，**无需手动先 `make frontend`**（但 QUICKSTART 口径与之并存，见 §1） |
| ②干净 clone + clean tree | ✅ | `git status --porcelain` 空、`web/dist`/`bin/kored`/`.kore-local-*` 均不存在（gitignore） |
| ③干净树构建 | ✅ **可复现** | `make build` exit 0，`go:embed` 不报错，`kored 0.1.3` / `协议 kore.plugin.v1`，二进制 13,451,426 字节 |
| ④`make check` 全 21 段 | ❌ **exit 2** | 3 段阻断 FAIL：1/21 docs-check（断链）、12/21 secret-check（既存误报）、16/21 pubkey-sync（缺兄弟仓硬失败）；其余 17 段 PASS / SKIP（详见 §4） |
| ④`make docs-check` / `make secret-check` | ❌ exit 2 / ❌ exit 2 | 同 §4 的 1/21、12/21 根因 |
| ⑤干净树 vs 脏工作区 | 见 §5 | build **完全可复现**；3 个门禁段存在不可复现 FAIL（其中 1 个既存、2 个 clean-only） |
| ⑥诚实边界 | 见 §6 | 本地 file:// clone ≠ GitHub 远端；兄弟仓缺失致 SKIP 属预期；沙箱只读缓存用仓外临时目录 |

**一句话**：干净 clone **能独立构建**（核心可信发布能力成立），但**不能独立通过 `make check`**——3 个门禁段阻断，其中 2 个是「干净树独有」的真实不可复现缺陷，已报 lead 另派卡（§5.3）。

---

## 1. ①从零构建流程（只读回读）

| 来源 | 关键原文 | 对干净 clone 的含义 |
|---|---|---|
| `Makefile:77-79` | 「web-dist 保证 embed 需要的 web/dist 主壳产物存在：web/dist 被 .gitignore 忽略，**干净检出直接 make build / vet / test 会因 //go:embed 找不到文件而失败（实测 exit 2）**」 | 项目已意识到 clean tree 的 embed 风险，并内置 `web-dist` 前置目标自愈 |
| `Makefile:90` `web-dist:` | 纯本地文件拷贝（无 npm / 无网络），逐文件 `cp web/* → web/dist/`，语言包拍平 | 干净树缺 `web/dist` 时由该目标自动生成 |
| `Makefile:99` `build: web-dist` | `build` 依赖 `web-dist` | **正确顺序：`make build` 一条命令即可**，先跑 `web-dist` 再 `go build`，无需手动 `make frontend` |
| `Makefile:218` `frontend: web-dist` | `frontend` 做 `rm -rf web/dist` 后全量重建 + 首屏 gzip 核对 | 想强制重建前端产物才需显式 `make frontend` |
| `QUICKSTART.md:10-13` | 「make build 产出 bin/kored（已内嵌 web/dist）… 若要重新生成前端产物，先跑 make frontend 再 make build。**缺 web/dist 时 go build 直接失败——这是门禁，不是 bug**」 | 文档口径略旧（假设 `web/dist` 已就绪）；实测 Makefile 的 `web-dist` 前置已让 `make build` 自愈，两者不冲突 |
| `docs/RELEASE.md:73` | 「打包：`make build && make dist`」 | 发版打包从 `make build` 起，未要求先 `make frontend` |
| `docs/RUNBOOK.md:55-57` | 「步骤 4 — make build（新公钥编入二进制）：`cd ../kore && make build`」 | 同上 |
| `AGENTS.md:121-137` | 命令速查表：`make build` 可用、`make check` 21 段聚合门禁 | 门禁口径以 `make check` 为准 |

**确认的干净 clone 正确顺序**：`make build`（其 `web-dist` 前置自动补前端产物）→ 需要时 `make frontend` 复核首屏 → `make check` / `make docs-check` / `make secret-check`。无需 npm、无需联网（依赖走 goproxy / 本地缓存）。

---

## 2. ②隔离 clone 与干净树断言

隔离边界：源仓 `/home/pt/Work/GolandProjects/kore-pl/kore`（HEAD `bb07f58cf92fd83b69f280febf0c197a5054a115`），clone 到工作区外 `/tmp/kore-clean-clone-43`，用 `file://` 本地路径得纯提交态工作树。

```text
CMD: git clone --no-local file:///home/pt/Work/GolandProjects/kore-pl/kore /tmp/kore-clean-clone-43
EXIT=0
正克隆到 '/tmp/kore-clean-clone-43'...

CMD: git status --porcelain=v1
EXIT=0
STDOUT:[]                                    # 干净树，无 dirty / 无未跟踪

CMD: git rev-parse HEAD
bb07f58cf92fd83b69f280febf0c197a5054a115
EXIT=0

CMD: git log -1 --format='%H%n%s'
bb07f58cf92fd83b69f280febf0c197a5054a115
[agent:pyext-close] docs: C13 Python ext 三件套对称交付收口（round 42）
EXIT=0

CHECK web/dist exists:      ABSENT (expected - gitignored)
CHECK bin/kored exists:     ABSENT (expected - gitignored)
CHECK .kore-local-* dirs:   ABSENT (expected)
CHECK ../kore-plugins:      ABSENT（/tmp 下无兄弟仓）
.gitignore:6:/bin/    .gitignore:13:web/dist/
```

断言全部符合预期：干净树**不含** `web/dist`、`bin/kored`、`.kore-local-*`，且 sibling 兄弟仓不存在。

---

## 3. ③干净树构建（真实可复现）

沙箱细节（见 §6）：宿主 GOMODCACHE/GOCACHE 只读，且未缓存 bbolt v1.5.0；按任务授权改用仓外可写临时目录 + 已授权 goproxy：

```text
ENV: GOMODCACHE=/tmp/kore43-cache3/gomod GOCACHE=/tmp/kore43-cache3/gocache
     TMPDIR=/tmp/kore43-cache3/tmp GOPROXY=https://goproxy.cn,direct

CMD: make build                       # 干净树，web/dist 缺失，依赖按需下载
go: downloading go.etcd.io/bbolt v1.5.0
go: downloading gopkg.in/yaml.v3 v3.0.1
go: downloading golang.org/x/sys v0.45.0
[OK] 构建完成: ./bin/kored
EXIT=0
web/dist after build: PRESENT (66 files)       # web-dist 前置自愈
bin/kored:            PRESENT (13451426 bytes)

CMD: ./bin/kored version
kored 0.1.3
协议 kore.plugin.v1
EXIT=0

CMD: make frontend
[OK] 前端静态产物已打包: web/dist（66 文件，零依赖）
[OK] 首屏体积达标：91092 字节 ≤ 307200 字节（300 KiB）
[WARN] 首屏体积漂移：91092 > 基线+5%(87341) 或绝对线(90000)   # WARN 不阻断
[OK] i18n 增量达标：2941 ≤ 3072 字节
EXIT=0

CMD: make build          # 第二次
[OK] 构建完成: ./bin/kored
EXIT=0
CMD: ./bin/kored version
kored 0.1.3 / 协议 kore.plugin.v1
EXIT=0
```

**断言**：`go:embed` 不报错（web/dist 由 `web-dist` 前置自动生成）；`kored version` = `0.1.3`（与 `Makefile:26 VERSION ?= 0.1.3` 一致）；二进制大小与脏工作区既有 `bin/kored` 完全相同（13,451,426 字节）→ 构建**可复现**。

---

## 4. ④门禁分段结果（干净树，run3）

```text
CMD: make docs-check   → EXIT=2（docs-check: 4 pass, 1 warn, 1 fail）
CMD: make secret-check → EXIT=2（secret-check: 1 FAIL / 22 处匹配）
CMD: make check        → EXIT=2（[FAIL] 门禁未通过 — 见上方明细）
make check start 2026-11-28T08:35:31+08:00 → finished 08:38:15+08:00
```

21 段逐段判定（`make check` 原文汇总）：

| 段 | 名称 | 结果 | 说明 |
|---|---|---|---|
| 1/21 | docs-check | **FAIL** | 断链 1 条：`docs/DECISIONS/0051-dns-root-boundary.md → ../../../kore-plugin-dns/README.md`（兄弟仓在 clone 中不存在）。**clean-only 缺陷** |
| 2/21 | 依赖白名单 + 兼容基线 | PASS | 2/3 第三方依赖；GOAMD64/GOARM64/buildvcs 基线钉死 |
| 3/21 | 薄壳边界 | PASS | 204 个 .go 扫描，0 违规 |
| 4/21 | repo-check | PASS | 无插件代码/旧 SDK 路径/索引 |
| 5/21 | canonical-check | PASS | 14 规则全过 |
| 6/21 | log-check | PASS（WARN 级） | 台账齐全 |
| 7/21 | wt-check | PASS（WARN 级） | 工作树 1，无残留 |
| 8/21 | oss-check | PASS | 根级开源资产 8/8 |
| 9/21 | case-check | PASS（1 WARN URL owner 大小写） | 不阻断 |
| 10/21 | frontend 首屏体积 | PASS（WARN 漂移） | 91092 ≤ 307200 字节 |
| 11/21 | 零侵入门禁 | PASS | 17 pass：隔离根下系统路径零新增、状态库/账本/回滚全过（缓存修好后） |
| 12/21 | secret-check | **FAIL** | `.agents/verify/backup-download-verification.md:125 ADMIN_PASSWORD` 误报。**既存缺陷（脏树同样 FAIL），非 clean-only** |
| 13/21 | 插件仓开源资产 | SKIP | 无兄弟仓 — **预期** |
| 14/21 | store-check | SKIP | 无 `../kore-plugin-*` — **预期** |
| 15/21 | presets-check | SKIP | 无 `../kore-plugins/index/plugins.json` — **预期** |
| 16/21 | 公钥单一真源 | **FAIL** | 缺 `../kore-plugins/scripts/validate-index.sh`，脚本硬 fail 而非 SKIP。**clean-only 缺陷**（`scripts/pubkey-sync-check.sh:16`）。对比：同段 market 子检查 SKIP 属预期 |
| 16-附 | market 索引→市场页 | SKIP | 未检出 kore-plugins — **预期**（设计上支持独立 clone） |
| 17/21 | 交叉编译 G-16 | PASS | 五目标全仓 `go build ./...` + 五产物，17.7s，exit 0 |
| 18/21 | race 门禁（boundary 面） | SKIP | 本仓无 `tests/boundary/` — **预期恒 SKIP**，由 19/21 补位 |
| 19/21 | 全仓 -race | PASS | 17 包 / 65s / 零 DATA RACE |
| 20/21 | usability-check | WARN（不阻断） | `FAIL 未找到任何 ../kore-plugin-*/info.json`（缺兄弟仓，WARN 级）— 预期 |
| 21/21 | pkg/pluginapi -race | PASS | 2 包 / 2s / 零 DATA RACE |

**汇总**：17 段 PASS（含 WARN 级）、4 段 SKIP/N-A（预期）、3 段 FAIL（1/21、12/21、16/21）→ `make check` exit 2。

`make docs-check` 与 `make secret-check` 单跑 exit 2，失败点即 1/21、12/21 原始输出，非新增问题。

---

## 5. ⑤干净树 vs 脏工作区对比 & 不可复现点

### 5.1 构建产物对比

| 项 | 脏工作区（42 轮所在） | 干净 clone | 是否可复现 |
|---|---|---|---|
| `web/dist/` | 存在（66 文件，gitignore，历史堆积） | 初始不存在 → `make build` 的 `web-dist` 前置自动生成 66 文件 | ✅ 可复现（自愈，非缺陷） |
| `bin/kored` | 13,451,426 字节，`kored 0.1.3` | 13,451,426 字节，`kored 0.1.3` | ✅ 字节级一致 |
| `go:embed` | 通过（dist 已就绪） | 通过（web-dist 前置补位） | ✅ |
| Go 依赖 | 宿主缓存部分命中、部分缓存只读 | 仓外可写缓存 + 授权 goproxy 下载 bbolt v1.5.0 / yaml v3.0.1 / x/sys v0.45.0 | ✅（需可写缓存，见 §6） |

### 5.2 门禁对比（干净树独有 FAIL）

| 段 | 脏工作区 | 干净 clone | 性质 |
|---|---|---|---|
| 1/21 docs-check | **PASS**（兄弟仓 `kore-plugin-dns/README.md` 存在，链接可达） | **FAIL**（断链） | **clean-only 真实不可复现缺陷** |
| 12/21 secret-check | **FAIL**（同一行误报） | **FAIL**（同一行误报） | 既存缺陷，非 clean-only，但同样阻断干净树 `make check` |
| 16/21 pubkey-sync | **PASS**（`../kore-plugins/scripts/validate-index.sh` 存在） | **FAIL**（硬失败而非 SKIP） | **clean-only 真实不可复现缺陷** |
| 13/14/15/20/18 段 | SKIP/WARN（兄弟仓或 tests/boundary 缺失） | SKIP/WARN（同样缺失） | 一致，预期 |

### 5.3 真实不可复现缺陷（报 lead 另派卡，本卡不自行改）

1. **[P1] 干净树 `make docs-check` / `make check` 1/21 FAIL — 跨仓相对链接**
   - 复现（干净 clone）：`[FAIL] 相对链接断链 1 条（共检查 1304 条）断链: docs/DECISIONS/0051-dns-root-boundary.md → ../../../kore-plugin-dns/README.md`
   - 定位：`docs/DECISIONS/0051-dns-root-boundary.md:2`（元信息行的 `[dns README](../../../kore-plugin-dns/README.md)`）；判定逻辑 `scripts/docs-check.sh:166`（`if [ ! -e "${dir}/${target}" ]; then ... LINK_BROKEN++`）。
   - 根因：文档用指向**兄弟仓**的相对链接，docs-check 对相对链接一律要求本地可达，无「跨仓链接豁免」；脏工作区因兄弟仓恰好存在而 PASS，独立 clone 必 FAIL。
   - 建议方向（供 lead 派卡，不在本卡实施）：把跨仓链接改为 GitHub 绝对 URL / 纯文本引用，或给 docs-check 增加跨仓链接白名单/豁免（对标 13/14/15 段的 SKIP 口径）。

2. **[P1] 干净树 `make check` 16/21 FAIL — pubkey-sync-check 缺兄弟仓硬失败**
   - 复现（干净 clone）：`[FAIL] 缺少 /tmp/kore-clean-clone-43/../kore-plugins/scripts/validate-index.sh（可用 KORE_PLUGINS_DIR 指向索引仓）`
   - 定位：`scripts/pubkey-sync-check.sh:16`（`[ -f "$VALIDATE" ] || fail "缺少 $VALIDATE..."`）。
   - 根因：同段 market 子检查（`Makefile:568` `market-check`）在 kore-plugins 缺失时明确 `[SKIP]` exit 0「不阻断独立 clone」，但 pubkey-sync-check 对同一缺失场景是硬 FAIL，口径不一致；脏工作区因兄弟仓存在而 PASS。
   - 建议方向：让 pubkey-sync-check 在索引仓脚本不存在时 SKIP exit 0（与 market-check / presets-check 对齐），仅在文件存在但公钥不一致时 FAIL。

3. **[P2] `make secret-check` 既存误报（脏树/干净树同 FAIL）**
   - 复现：`[FAIL] .agents/verify/backup-download-verification.md:125 ADMIN_PASSWORD 疑似明文凭据（值已隐藏）`，`secret-check: 1 FAIL / 22 处匹配`。
   - 定位：`.agents/verify/backup-download-verification.md:125`（证据表格里把一条含 `ADMIN_PASSWORD=<pattern>` 字样的 grep 搜索模式原文写进文档，被 `scripts/secret-check.sh:35` 的 `ENV_RE` 命中）；该行实际是「无明文口令」的核查证据，非真实凭据。
   - 性质：42 轮脏工作区也被它阻断，只是无人单跑 secret-check；不属于 clean-only 缺陷，但它使干净树 `make check` 12/21 必 FAIL，阻碍「可信发布终检全绿」。
   - 建议方向：把证据文档中的该键写法改成转义/占位写法（如 `ADMIN_PASSWORD=<pattern>`），或给 secret-check 增加「证据行内的 grep 模式」豁免；**文件不在本卡写域，未改**。

以上 3 项均**不在本卡写域**（`docs/`、`scripts/`、其他 `.agents/verify/` 文件），本卡只记录，不自行修复。

### 5.4 缓存依赖（环境类，非代码缺陷）

- 首次裸跑（run1/run2）：宿主 `/home/pt/go/pkg/mod` 与 `/home/pt/.cache/go-build` 在沙箱中**只读**，且宿主未缓存 bbolt v1.5.0 → `make build` / 17 段 / 19 段 / 21 段报 `read-only file system` / `module lookup disabled by GOPROXY=off`，exit 2。这是**沙箱缓存权限**问题，不是项目缺陷（真实用户机器缓存可写 + 可联网即不触发）。
- run3 用仓外可写临时目录 + 授权 goproxy 后，`make build` 与全部真编译段 PASS。

---

## 6. 诚实边界

1. **本地 clone ≠ GitHub 远端**：本验证用 `git clone --no-local file:///home/pt/.../kore` 从本地 HEAD 克隆，内容等于**已提交 HEAD**（`bb07f58`）的等价副本，不含任何未提交改动；它验证了「从提交态重建工作树」的自洽性，但**未验证** GitHub 远端 tag / Release 资产的可达性或 CDN 分发。
2. **兄弟仓缺失致 SKIP 属预期，不是缺陷**：13/14/15/18/market 子检查在无 `kore-plugins` / `kore-plugin-*` / `tests/boundary/` 时 SKIP/N-A/WARN，是设计上支持独立 clone 的预期行为，本卡不把它们计为缺陷；但 1/21 与 16/21 在同样缺失场景下是**硬 FAIL**而非 SKIP，这才是不可复现缺陷（§5.3）。
3. **沙箱只读缓存用仓外临时目录**：宿主 Go 缓存只读，故 run3 将 `GOMODCACHE` / `GOCACHE` / `TMPDIR` 指向 `/tmp/kore43-cache3/...`（工作区外），依赖仅经已授权 `https://goproxy.cn,direct` 下载；验证结束后临时目录已删净（§7）。
4. **未联网业务**：全程只访问 goproxy 拉依赖，未访问 kore 业务服务、未碰 8787 / `.kore-local-*` / 宿主安装；隔离 clone 在 `/tmp`，不写工作区。
5. **FLAG**: run1/run2 的失败输出保留在 `.agents/verify/.clean-clone-43-run*.log`（临时 harness 日志），报告定稿后删除，不作为交付物；本文件是唯一写域产物。

---

## 7. 清理回读

```text
CMD: chmod -R u+rwX /tmp/kore43-cache3 && rm -rf /tmp/kore-clean-clone-43 /tmp/kore43-cache3
EXIT=0
CLONE CLEANUP OK: absent
CACHE CLEANUP OK: absent

# run1 旧隔离目录 /tmp/kore-clean-clone-43 亦已在 run2/run3 开头 rm -rf 重建并末尾删除
# 临时 harness 日志 .agents/verify/.clean-clone-43-run*.log 在报告定稿后删除（不提交）
```

---

## 8. 证据归档

- 决定性运行（run3，goproxy + 仓外可写缓存）：`.agents/verify/.clean-clone-43-run3.log`（定稿后删除，本文已摘录原文）。
- run1（宿主只读缓存裸跑）：`.agents/verify/.clean-clone-43-run.log`（同上）。
- run2（GOPROXY=off 缺包探测）：`.agents/verify/.clean-clone-43-run2.log`（同上）。
- 所有命令、退出码、原文均逐条嵌于本文 §2–§4、§7，便于 verifier 独立复跑比对。
