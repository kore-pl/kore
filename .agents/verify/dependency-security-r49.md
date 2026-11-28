# Round49 · 依赖安全基线结论固化（只读审计 task-318 → 落盘 task-319）

> 落盘: dep-security-doc（task-319，唯一写域 = 本报告）｜审计来源: dep-security（task-318，只读，报告贴回 lead 未落盘）
> 日期: 2026-11-28｜口径: **本文只固化既有只读审计结论，不重新查询、不改代码、不升级依赖、不碰运行实例 / 8787 / `.kore-local-*`**
> 留痕依据: G-06（文档同步）、G-23（判断留痕）；HANDOFF 纪律「会话里说过但没落文件的判断不算数」——故把结论由会话迁入本文件
> 前置核实: 已只读回读 task-318 完整报告（父会话 seq 13198）并对照仓库真实 `go.mod` / `go.sum` / 插件 `go.mod`，三源证据与 4 仓 dependabot=0 逐项属实后再落盘（round37 教训：不臆断）

---

## ① 结论：当前 pin 版本依赖安全基线干净

**判定（task-318 结论 b）：无 CVE 命中、无 dependabot 未处理告警 → 依赖安全基线无已知漏洞。**

| 依赖 | 精确版本 | 角色 | 安全结论 |
| --- | --- | --- | --- |
| `go.etcd.io/bbolt` | v1.5.0 | 直接（生产：本地 state.db） | 干净：唯一相关 advisory 已 WITHDRAWN，且 1.5.0 本就在影响区间外 |
| `gopkg.in/yaml.v3` | v3.0.1 | 直接（生产：本地配置解析） | 干净：3.0.1 正是历史 CVE 的修复点 |
| `golang.org/x/sys` | v0.45.0 | indirect（bbolt 传递依赖，无直接 import） | 干净：影响区间终点远早于 0.45.0 |
| `github.com/pengtang1024/kore/pkg/pluginapi` | v0.1.3 | 同仓嵌套 module（`replace => ./pkg/pluginapi`） | 不计入 G-02 第三方配额；`go.mod` 无外部 require |

**插件边界**：24 个插件仓仅依赖同仓 `pluginapi` + 标准库，零其它第三方；与既有 `store-check` G-17 门禁 **24/24 pass / 0 fail** 一致（本轮未重跑门禁，引用既有结论）。本轮只读抽查 echo / container / ssl 三仓 `go.mod`，三仓均只有一条 `require github.com/pengtang1024/kore/pkg/pluginapi v0.1.3`。

**无处置动作**：不 bump、不触发 G-02 白名单评估、不需 ADR、无发版涟漪。G-02 三项白名单（yaml.v3 / bbolt / protobuf）基因型未变。

---

## ② 证据

### 2.1 依赖清单（代码实证，file:line）

- `go.mod:1` `module github.com/pengtang1024/kore`；`go.mod:3` `go 1.26`。
- `go.mod:5-9` require 块：`go.mod:6` pluginapi v0.1.3、`go.mod:7` bbolt v1.5.0、`go.mod:8` yaml.v3 v3.0.1；`go.mod:11` `golang.org/x/sys v0.45.0 // indirect`。
- `go.mod:13-14` `replace github.com/pengtang1024/kore/pkg/pluginapi => ./pkg/pluginapi`（同仓相对路径，符合 G-02 / G-17）。
- `go.sum` 共 16 行：`go.sum:7-8` bbolt v1.5.0、`go.sum:11-12` x/sys v0.45.0、`go.sum:15-16` yaml.v3 v3.0.1；其余 `go.sum:1-6`（davecgh/go-spew v1.1.1、pmezard/go-difflib v1.0.0、stretchr/testify v1.11.1）、`go.sum:9-10`（golang.org/x/sync v0.20.0）、`go.sum:13-14`（gopkg.in/check.v1 伪版本）均为 module 图里的测试 / 工具链传递项，非生产直接依赖。
- `pkg/pluginapi/go.mod:1` module 声明；`pkg/pluginapi/go.mod:5-8` 仅 `retract v0.1.0`，**无 require**。
- 插件抽查：`../kore-plugin-echo/go.mod:5`、`../kore-plugin-container/go.mod:5`、`../kore-plugin-ssl/go.mod:5` 均为同一条 pluginapi require，go 1.26，零其它第三方。
- 生产源码 import 面：全树 grep（排除 `.kore-local-state/` / `.tmp`）确认 `cmd/` + `internal/` 的外部 import 只有 `go.etcd.io/bbolt` 与 `gopkg.in/yaml.v3`（+ 自有 `internal/pkg/web`）；x/sys 为 bbolt 的 go.mod 要求（模块缓存 v1.5.0.mod 第 13 行），无直接 import。

### 2.2 三源 CVE 交叉验证（漏洞库数据）

三个**精确版本**分别用 deps.dev + GitHub Advisory DB + go.dev vuln（经 OSV 编号）交叉，结论一致：

| 包 @ pin | ① deps.dev v3alpha | ② GitHub Advisory DB（影响区间 / 修复点） | ③ go.dev vuln / OSV | 交叉判定 |
| --- | --- | --- | --- | --- |
| bbolt v1.5.0 | `advisoryKeys:[]` | CVE-2026-33817 / GHSA-6jwv-w5xf-7j27：CVSS3.1 6.2（AV:L/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H），区间 **≤1.4.3**；**已 WITHDRAWN（2026-04-13，CNA 判 false positive）**，原描述 "index out-of-range on zero-element branch page" | OSV `POST /v1/query` bbolt@1.5.0 → `{}` HTTP200 exit0（无 vuln） | 1.5.0 在区间外且 advisory 已撤销 → 干净 |
| yaml.v3 v3.0.1 | `advisoryKeys:[]` | CVE-2022-28948 / GHSA-hp87-p4gw-j4gq：severity high，区间 **<3.0.1**，first_patched = **3.0.1** | [GO-2022-0603](https://pkg.go.dev/vuln/GO-2022-0603)（web_fetch HTTP200）："Affects gopkg.in/yaml.v3 before v3.0.0-20220521103104-8f96da9f5d5e"，Unmarshal 非法输入 panic（DoS） | kore pin 的正是修复版本 → 干净 |
| x/sys v0.45.0 | `advisoryKeys:[]` | CVE-2022-29526 / GHSA-p782-xgp4-8hr8：CVSS medium，区间 **<0.0.0-20220412211240**，first_patched = 2022-04-12 | 同上三源口径一致（OSV 直连超时，见 §3） | 0.45.0（2026-05 发布）远超修复点 → 干净 |

- deps.dev 精确版本 API 示例（HTTP200 exit0，三包均 `advisoryKeys:[]`）：[gopkg.in/yaml.v3 v3.0.1](https://api.deps.dev/v3alpha/systems/go/packages/gopkg.in%2Fyaml.v3/versions/v3.0.1)
- GitHub Advisory 原始条目：[GHSA-6jwv-w5xf-7j27](https://github.com/advisories/GHSA-6jwv-w5xf-7j27) · [GHSA-hp87-p4gw-j4gq](https://github.com/advisories/GHSA-hp87-p4gw-j4gq) · [GHSA-p782-xgp4-8hr8](https://github.com/advisories/GHSA-p782-xgp4-8hr8)
- OSV 条目：[GO-2022-0603](https://osv.dev/vulnerability/GO-2022-0603)
- 查询方式说明：`domain_search` 的 osv 引擎需生态前缀，nvd / cisakev 对该粒度查无结果；task-318 已改用上述权威 API 直查（同属安全数据库只读查询），不是靠搜索摘要下结论。

### 2.3 GitHub 告警（4 仓，gh api GET 全部 exit0）

- `gh auth status` exit0（账号 pengtang1024，token 含 repo scope）。
- 四仓 `kore-pl/kore`、`kore-plugin-echo`、`kore-plugin-container`、`kore-plugin-ssl`：`/dependabot/alerts?state=open` = **0**；全状态 = **0**；`security-advisories` = **0**。
- **空集可信度校验**（关键，避免「未启用造成的 0」误判）：`repos/<repo>` 的 `security_and_analysis` 四仓均 `dependabot_security_updates.status=enabled` + `secret_scanning enabled`；四仓 `.github/dependabot.yml` 均存在。即「0 告警」是在配置确实开启下的 0。

---

## ③ 诚实边界（不夸大）

1. **OSV 直连不完整**：OSV `POST /v1/query` 对 bbolt@1.5.0 返回 `{}`（HTTP200 exit0）；对 yaml.v3@3.0.1 与 x/sys@0.45.0 多次 POST 网络超时（HTTP000 exit28，含 60s 超时 / querybatch）。这两项**未直连 OSV**，但经 deps.dev + GitHub Advisory DB + go.dev vuln 三源交叉一致，故不把「网络超时」写成「OSV 已确认无漏洞」。
2. **「干净」只对当前 pin 版本成立**：这是 2026-11-28 时点对三个精确版本 + 4 仓告警的判断；未来新披露 CVE 时不再保证，须按 §4 复跑。
3. **代码实证范围有限**：依赖清单实证仅限 §2.1 所列文件；插件侧只抽样 echo / container / ssl 三仓的 `go.mod`，未逐仓读全部 24 仓（全量一致性引用既有 `store-check` G-17 门禁 24/24 结论，本轮未重跑）。
4. **影响评估为推断且本轮无需触发**：bbolt 仅用于本地单文件 state.db（独占锁）、yaml 仅解析本地 `.kore-local.yaml`；因无 CVE 命中，未逐条做可达性判定。若后续有人提议把 yaml 升到 3.0.1 之外的版本，才需另卡评估 G-02。
5. **本文件不重新查询**：所有漏洞库 / 告警数字来自 task-318 只读审计原文（父会话 seq 13198），本轮只做落盘与代码侧 file:line 对照，不联网复核。

---

## ④ 复跑判据与命令模板（供重大发版前 / 收到告警时复用）

**触发条件**：① 重大发版前；② 收到 dependabot 告警或新 CVE 披露；③ 依赖 pin 版本发生任何变化（那时本报告结论作废，须重跑并另卡评估 G-02）。

### 4.1 安全数据库只读查询（domain_search 引擎 + 权威 API 直查）

```
# A. domain_search 三引擎（搜索候选，需生态前缀；nvd/cisakev 该粒度可能无结果）
domain_search osv   "GO-2022-0603 gopkg.in/yaml.v3 3.0.1"
domain_search nvd    "CVE-2022-28948 gopkg.in/yaml.v3"
domain_search cisakev "CVE-2022-29526 golang.org/x/sys"

# B. deps.dev 精确版本 advisory（HTTP200，看 advisoryKeys 是否为空）
curl -sS "https://api.deps.dev/v3alpha/systems/go/packages/go.etcd.io%2Fbbolt/versions/v1.5.0"
curl -sS "https://api.deps.dev/v3alpha/systems/go/packages/gopkg.in%2Fyaml.v3/versions/v3.0.1"
curl -sS "https://api.deps.dev/v3alpha/systems/go/packages/golang.org%2Fx%2Fsys/versions/v0.45.0"

# C. OSV 直连（超时如实记录，不冒充「无漏洞」）
curl -sS -m 60 -X POST https://api.osv.dev/v1/query -d '{"package":{"name":"go.etcd.io/bbolt","ecosystem":"Go"},"version":"v1.5.0"}'

# D. GitHub Advisory DB（逐包查影响区间 / WITHDRAWN / first_patched）
gh api "advisories?ecosystem=go&affects=go.etcd.io/bbolt"   --jq '.[] | {ghsa, cve_id, withdrawn_at, vulnerable_version_range}'
gh api "advisories?ecosystem=go&affects=gopkg.in/yaml.v3"   --jq '.[] | {ghsa, cve_id, withdrawn_at, vulnerable_version_range, first_patched_version}'
gh api "advisories?ecosystem=go&affects=golang.org/x/sys"   --jq '.[] | {ghsa, cve_id, withdrawn_at, vulnerable_version_range, first_patched_version}'
```

### 4.2 GitHub dependabot 告警 + 配置开启校验（4 仓）

```
for r in kore-pl/kore kore-pl/kore-plugin-echo kore-pl/kore-plugin-container kore-pl/kore-plugin-ssl; do
  echo "=== $r ==="
  gh api "repos/$r/dependabot/alerts?state=open" --jq 'length'                    # 期望 0
  gh api "repos/$r/dependabot/alerts" --jq 'length'                               # 全状态期望 0
  gh api "repos/$r/security-advisories" --jq 'length'                             # 期望 0
  gh api "repos/$r" --jq '.security_and_analysis.dependabot_security_updates.status, .security_and_analysis.secret_scanning.status'  # 期望 enabled / enabled
done
```

> 判据：alerts=0 **且** `security_and_analysis` 开启才算「配置开启下的干净」；只看 alerts=0 不看配置会误判。若任一仓告警 > 0，须逐条评估影响与最小处置路径（bump / G-02 评估 / ADR）后另卡，不在本卡范围。

---

## ⑤ G-06 / G-23 留痕（round49）

| 项 | 内容 |
| --- | --- |
| 判断（G-23） | 采用 task-318 结论 **b）依赖安全基线干净**；被否决选项：a）发现需处理 CVE → 无命中不适用；c）证据不足 → OSV 两项超时但三源交叉一致，证据充分 |
| 证据强度分级（G-23） | 代码实证（go.mod / go.sum / 3 插件 go.mod） > 漏洞库数据（deps.dev + GitHub Advisory + go.dev vuln 三源交叉） > 推断（影响可达性，本轮无需） |
| 派发链（G-23 DISPATCH 口径） | task-318：owner `dep-security`，写域 = 无（只读），交付 = 报告贴回 lead 未落盘；task-318 → task-319：owner `dep-security-doc`，写域 = 本报告单文件，依赖 = task-318 结论，交付 = 本文件 + 精确 pathspec commit（commit hash 见下） |
| 文档同步（G-06） | 本文是 round49 依赖安全结论的**唯一真源**；未改 `docs/`、未改 `.agents/LOG/`，因此无跨文件口径漂移需同步。若未来依赖 pin 变化，须同步本文 §1/§2 并重跑 §4 |
| 落盘纪律 | 「会话里说过但没落文件的判断不算数」（HANDOFF）——本文件即 task-318 会话结论的持久化载体，避免下轮重复查询 |
| 写域边界 | 严格单文件：不改代码 / 其它文档 / `.agents/LOG/DECISIONS.md` / `.agents/LOG/DISPATCH.md` / 运行实例。台账文件属本卡写域外，其是否补录由 lead 决定；本表已在报告内自足留痕，不因台账未更新而声称 G-23 全局闭环 |

---

## 附：任务与门禁记录（落地后填）

| 项 | 值 |
| --- | --- |
| 任务 | task-319（claim rev2 → completed）→ 依赖 task-318（rev3，completed） |
| 写域 | `kore/.agents/verify/dependency-security-r49.md`（唯一提交文件） |
| docs-check | `bash scripts/docs-check.sh` → exit **0**（5 pass / 1 warn / 0 fail；1 WARN 为既有 11 份 `docs/` 行数越界，非本报告引入——本报告在 `.agents/verify/` 冻结证据区，不参与行数门禁） |
| git diff --check | 无输出（exit 0）；新增文件用 `git diff --no-index --check /dev/null <file>` 复核亦无空白告警 |
| commit | `git add .agents/verify/dependency-security-r49.md` + `git commit -s -- .agents/verify/dependency-security-r49.md`，message 前缀 `[agent:dep-security-doc] docs(verify): ...`；未 push / 未联网 / 未升级依赖 |
