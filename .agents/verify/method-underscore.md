# 方法名下划线 → 方法级权限不可声明（协议颗粒度损失裁定）

- 审计人：`method-underscore-decision`（architect，裁定卡 · 只裁定不实现）
- 时间：2026-11-24
- 范围：`kore`（内核 + 主壳前端）与 `../kore-plugin-*` 全部 24 仓。**只读**：未改内核、未改任何插件仓、未构建、未发版。
- 事实来源：`kore` HEAD `3765708`、`../kore-plugin-integrity` HEAD `35fa33a`（即任务卡所称「35fa33a 实测」的那个提交，修的是**插件仓**不是内核仓）的源码与 `info.json`。
- 并发纪律：`../kore-plugin-dns` 工作树有他人未提交改动（`internal/dnsop/call.go`、`write_engine.go`），与本卡无关，未采信其工作树；24 仓另有一批未跟踪的 `RELEASE-EVIDENCE.md`，同样与本卡无关。
- 纪律：每条结论带 `file:line`；无法证实写「未确认」。

---

## 0. 结论摘要

| 问题 | 裁定 |
| --- | --- |
| 正则是否真的不支持下划线 | **是**。`internal/core/registry/validate.go:55` = `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`，`verify_file` 不匹配（§1.1 有 Go 引擎实测） |
| `verify_file` 是否只读 | **是**。`os.Stat` + 读哈希，无写入路径（§1.2） |
| 「回退插件级」在哪 | `internal/core/httpapi/invoke_capability.go:173-176`，回退点在 **:176**（§1.3） |
| 24 仓里有几个下划线方法 | **1 个**，就是 `verify_file`。264 条已声明方法级覆盖中，动作段含下划线的是 **0 条**（§2） |
| 后果的真实形态 | **审计面真实、授权面今天为零**——单管理员全权使 admin/read 无差别；`system:admin` 的实际效果是让只读方法被写进 `invoke.*` 审计，且**违反 `audit_http.go` 自己写下的口径**（§3） |
| 推荐 | **A：放宽 `methodActionPattern` 允许 `_`**（§5）。B 作为原则性否决内核改动时的退路，C 为现状且残余风险已由文档承担 |

---

## 1. 复核（4 项，逐条带证据）

### 1.1 `methodActionPattern` 的实际正则

```go
// internal/core/registry/validate.go:55
methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`)
```

- 使用点只有一处：`internal/core/registry/validate.go:187`（`validateMethodCapabilities` 内），失败即 `errf(pluginapi.E_INVALID, ...)`（`:188-190`），fail-closed 到整份清单加载失败。
- 键的拆分点：`internal/core/registry/validate.go:183` `strings.CutPrefix(method, m.ID+".")`；域必须等于插件 id。
- **SDK 有一份逐字副本**：`pkg/pluginapi/pluginapitest/infocheck.go:53`（同样是 `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`），使用点 `:246`。任何改正则的方案都必须同时改这两处，否则「插件自检通过、内核装不上」或反之。

**Go 引擎实测**（隔离 `/tmp` 程序，跑完即删，未写入任何仓库）：

```
verify_file      false
verifyFile       true
config.get       true
baseline.list    true
schedule.set     true
verify_file.v2   false
a_b.c            false
set-rewrite      false
```

即：下划线、连字符、下划线开头、点后紧跟下划线 —— 全部拒绝。与 `docs/PLUGIN-MATURITY.md:164` 的记载一致。

既有护栏：`internal/core/registry/method_capabilities_test.go:49-86` 覆盖 9 个非法用例（含 `site.set-rewrite` 被判「动作段」非法，见 `:64`）。**该用例集没有下划线用例** —— 放宽后必须补一条，否则「放宽」这件事本身没有回归护栏。

### 1.2 `verify_file` 的实际权限需求 = 只读

| 证据 | 内容 |
| --- | --- |
| `../kore-plugin-integrity/methods.go:57` | dispatch 白名单 `case "baseline", "baseline.list", "restore", "check", "status", "verify_file",` —— 确认在名单内 |
| `../kore-plugin-integrity/internal/integrity/methods.go:206` | 服务层 `case "verify_file":` → `s.verifyFile(raw)` |
| `../kore-plugin-integrity/internal/integrity/methods.go:550-571` | `verifyFile`：`decodeParams` → `requireState()`（只判 `store.Dir() != ""`，`:574-580`）→ 校验 `path` 非空 → `normalizeSHA256` → `s.scanner.HashFile(p.Path)` → 返回 `{match, actual, expected}` |
| `../kore-plugin-integrity/internal/integrity/scan.go:283-301` | `HashFile`：`ResolveExisting` → `os.Stat` → 大小上限 → `hashFile(real)` |

**全程无写入**：没有 `os.WriteFile` / `WriteFileAtomic` / 目录创建 / 状态落盘。唯一的「状态」要求是 `requireState()` 的前置检查，它只读 `store.Dir()` 字符串、不落盘。

结论：`verify_file` 只需要 **`system:read`**。任务卡的前提成立。

### 1.3 「回退插件级」的代码位置

```go
// internal/core/httpapi/invoke_capability.go:165-177
if capability, ok := declaration.methodLevel[fullMethodName(plugin, method)]; ok {
    return requiredInvokeCapability([]string{capability}), true, nil   // :174 方法级命中
}
return requiredInvokeCapability(declaration.pluginLevel), true, nil    // :176 ← 回退点
```

- 方法名归一：`fullMethodName`（`:180-185`），裸 `verify_file` 补成 `integrity.verify_file` 后再查表。所以路径 `/invoke/integrity/verify_file` 与 `/invoke/integrity/integrity.verify_file` 都能命中同一条键（若声明得出来）。
- 回退取的是**插件级的最高要求**：`requiredInvokeCapability`（`:47-71`）里 `system:admin` 命中 `capabilityActionAdmin` → `needAdmin = true`（`:57-61`）。
- integrity 插件级 = `["system:read", "system:admin"]`（`../kore-plugin-integrity/info.json`），故回退后 `verify_file` **要求 admin**。
- 插件侧自认这一点：`../kore-plugin-integrity/capabilities_test.go:126-129`「所以 `verify_file` 不再"仅 read"」；`../kore-plugin-integrity/tests/fault/declaration_test.go:42-50` 把「差集 = `integrity.verify_file`，这不是漏声明而是**声明不出来**」写成注释。

### 1.4 现象复核方式（我没法在不改仓的前提下跑出那条 E_INVALID，已用等价证据替代）

- 静态路径确切：`CutPrefix` 得 `action = "verify_file"`（`:183-185`）→ `:187` 正则不匹配 → `:188-190` 返回 `E_INVALID`，文案 `method_capabilities 的键 %q 动作段 %q 非法：应为小写字母开头的点分标识符（如 config.get）` —— 与任务卡观测到的报错前缀逐字一致。
- 运行时读数：`go test ./internal/core/registry/ -run 'TestParseRejectsInvalidMethodCapabilities|TestParseMethodCapabilities'` → `PASS` / `ok ... 0.004s`（exit 0）。说明校验链路按上述路径生效。
- **未确认**：没有在真实 `kored` 上装一次带 `integrity.verify_file` 的 `info.json` 看它回 `E_INVALID`（那需要改插件仓或造临时清单，超出本卡「只读」授权）。此处结论基于「代码路径 + 正则实测 + 既有单测绿」，不是端到端复现。

---

## 2. 影响面：24 仓全量扫描

### 2.1 口径与命令

两个面分别扫：

1. **声明面**：读 24 仓 `info.json` 的 `method_capabilities` 键。
2. **实现面**：扫 24 仓 Go 源码（排除 `_test.go`）里 `case "..."` 字面量，按仓去重，排除协议内建 `kore.*`。

```bash
cd /home/pt/Work/GolandProjects
python3 - <<'PY'
import re, glob, os, json
tot=0; under=[]
for r in sorted(glob.glob('kore-plugin-*')):
    s=set()
    for f in glob.glob(os.path.join(r,'**','*.go'), recursive=True):
        if f.endswith('_test.go'): continue
        src=open(f,encoding='utf-8').read()
        for m in re.finditer(r'case((?:\s*"[^"]*"\s*,?)+):', src):
            for x in re.findall(r'"([^"]*)"', m.group(1)):
                if re.fullmatch(r'[a-z][a-zA-Z0-9_.]*', x) and x not in ('ok','true','false'):
                    s.add(x)
    s={x for x in s if not x.startswith('kore.')}
    s-={'max_connections','slow_queries','threads_connected','maxmemory_policy'}
    tot+=len(s)
    u=[x for x in s if '_' in x]
    if u: under.append((r,u))
print("方法名类字面量（去重，上界）:", tot)
print("含下划线的仓/方法:", under)
PY
```

### 2.2 结果

| 指标 | 数值 |
| --- | --- |
| 插件仓 | **24** |
| `case` 字面量去重后（上界，含少量非方法枚举如模式/状态词） | **313** |
| 已声明 `method_capabilities` 条数 | **264** |
| 已声明条目中动作段含下划线 | **0** |
| **动作段含下划线的方法名** | **1 —— `verify_file`（`kore-plugin-integrity`）** |

### 2.3 五个候选的甄别（避免把字段名当方法）

初次正则捞到 5 个含下划线的标识符，逐一核对后 **4 个是假阳性**：

| 候选 | 真实身份 | 证据 |
| --- | --- | --- |
| `max_connections` | MySQL 状态字段 JSON 名 + `SHOW VARIABLES` 取值分支 | `kore-plugin-db-mysql/internal/mysqlop/types.go:131`、`client.go:126,143` |
| `threads_connected` | 同上 | `types.go:132`、`client.go:147` |
| `slow_queries` | 同上 | `types.go:135`、`client.go:159` |
| `maxmemory_policy` | Redis 配置键（白名单 + 解码分支） | `kore-plugin-redis/internal/redisop/serverconfig.go:26,124`、`types.go:225` |
| **`verify_file`** | **真方法名** | `kore-plugin-integrity/methods.go:57`（dispatch 白名单）+ `internal/integrity/methods.go:206`（服务层分派） |

**这决定了方案取向**：受影响面不是「一类命名习惯已经渗透 24 仓」，而是**孤例**。改名（B）的爆炸半径因此只有一个方法；放宽正则（A）的「未来防复发」价值也必须按「只有一个实例想证明它」来打折评估——两者的真实收益都比直觉小，见 §4。

---

## 3. 后果的真实形态（这条最容易被说错）

任务卡的表述是「继承插件级 `system:admin`，比实际需要的 `system:read` 更宽」。**代码复核后要拆成两面，否则会高估收益：**

### 3.1 授权面：今天没有任何实际效果

- `internal/core/httpapi/invoke_capability.go:104-106` 明写：「当前单管理员模式的诚实披露：`auth.Session` 未携带 capability 字段，默认 `CapabilityResolver` 对任意有效会话返回 6 项全权，因此检查在生产路径恒通过」。
- `internal/core/httpapi/middleware.go:194` 同口径：「默认按单管理员全权语义」。
- `internal/core/httpapi/invoke_capability.go:116-118`：未注入 resolver 只打一次 WARN，不放行失败。
- 且**多用户 RBAC 是 G-11 明确不做项**。

→ 所以 `needAdmin=true` 在今天的生产路径上**不会拦住任何调用**，也不会放宽任何调用。把本卡描述成「越权风险」是不成立的。

### 3.2 审计面：真实存在，且违反代码自己写下的口径

```go
// internal/core/httpapi/audit_http.go:130-138
// 审计口径与授权口径一致：auth.needAdmin 为真（该方法按**最终生效能力**需要 admin，
// 即写/管理类）才审计；最终生效能力是只读（方法级 method_capabilities 覆盖或插件级
// 只声明 *:read）时不审计。
if !s.auditInvokeAll.Load() && !auth.needAdmin {
    return
}
```

- 注释写的判据是「该方法按最终生效能力是否只读」；`verify_file` 按最终生效能力（回退后）被判成 admin，**于是每次 `verify_file` 都写一条 `invoke.*` 审计**（`handlers_invoke.go:55` 同口径）。
- 一个只读的 sha256 校验被记成「写/管理类操作」，审计里读写比例失真；这也正是 `docs/PLUGIN-MATURITY.md` 反复提「方法级 capability 收益」的落点。
- 该效应**只在 `audit.invoke_all=false`（默认）时成立**；开全量审计后被淹没。

### 3.3 结论定性（必须写进 ADR，防止后续被当安全修复邀功）

> 本缺陷当前是**审计口径缺陷 + 协议表达能力缺陷**，不是**授权缺陷**。修它对安全性没有可观测增益；收益是「审计分类正确」「协议自洽」「未来多用户落地时不带病」。

---

## 4. 三方案对比

### 方案 A：放宽 `methodActionPattern` 允许 `_`

**改前**

```go
// internal/core/registry/validate.go:55（内核）
methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`)
// pkg/pluginapi/pluginapitest/infocheck.go:53（SDK，逐字副本，必须同改）
methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`)
```

**改后（最小放宽，只加下划线，首字符仍限小写字母）**

```go
methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$`)
```

差异仅在两处 `[a-zA-Z0-9]` → `[a-zA-Z0-9_]`。首字母仍是 `[a-z]`，所以 `_foo` 依然非法；连字符 `-` 依然非法。

**`a_b.c` 的切分规则（结论：不切分，且禁止内核切分）**

1. **唯一的分割点是 `<id>` 与 `<action>` 之间的那个 `.`**：`validate.go:183` 的 `strings.CutPrefix(method, m.ID+".")`。因为 `idPattern`（`validate.go:39`）= `^[a-z][a-z0-9-]{0,30}[a-z0-9]$` **不含下划线、不含点**，所以域/动作边界永远唯一、无歧义；`a_b` 永远不可能是合法域。
2. **动作段内部不再切分**：`:187` 只对 `action` 整段做一次正则匹配，内核从不按 `.` 分解动作的层级。`baseline.list` 的「命名空间」语义完全由插件自己的 `businessVerb`（`../kore-plugin-integrity/methods.go:53-63`）解释。
3. 因此 `a_b.c` 只有一种读法：**一个整体动作名**。若插件愿意，它可以被自己的分派逻辑理解成「`a_b` 命名空间下的 `c`」——但那是插件业务，内核不参与。**若让内核去切分 `_`/`.` 来表达层级，就是往内核塞业务语义，反而违反 G-01。**所以「切分规则」的正解是「不切」。

**与既有 `<plugin-id>:<action>` 语法冲突吗？不冲突**

| 维度 | `capabilities` | `method_capabilities` |
| --- | --- | --- |
| 分隔符 | `:`（`capabilityPattern`，`validate.go:52`） | `.`（`methodActionPattern`，`validate.go:55`） |
| 字段 | `info.json.capabilities` | `info.json.method_capabilities` |
| 校验函数 | `validateCapabilities`（`:129`） | `validateMethodCapabilities`（`:166`） |

两者无共享解析代码、无共享正则，`verify_file`（无 `:`）也不可能被误解析成能力项。放宽 A 对能力项语法**零影响**。

**是否违反 G-01？不违反**

G-01 的红线原文是「不得维护业务域名词表」。A 改的是**字符集**，没有引入任何 `verify`/`file`/`baseline` 之类的业务词，内核仍然只看「是不是合法标识符 + 域等不等于插件 id」。放宽字符集属于语法层，与薄壳红线正交。

**一个有利的反证：当前正则是同文件里的异类**

| 正则 | 行 | 是否允许 `_` | 现役依赖 |
| --- | --- | --- | --- |
| `eventNamePattern` | `validate.go:57` | **允许**（`[a-z0-9_-]`） | `kore-plugin-ssl` 的 `event:cert.renew_due` 已在用 |
| `invokeNamePattern` | `validate.go:60` | **允许**（`[a-z0-9_-]`） | 允许单段/多段动词 |
| `capabilityPattern` | `validate.go:52` | 不允许，但允许 `-` | — |
| `methodActionPattern` | `validate.go:55` | **不允许** | — |

同一文件里相邻两条触发名正则都接受下划线，且已有插件真实依赖（`../kore-plugin-ssl/info.json` 的 `triggers: ["event:cert.renew_due"]`）。所以 A 不是「发明新规则」，而是**把方法级并回既有的宽松口径**，修掉一个不一致。

**代价**

1. 改 2 处正则（内核 + SDK），各自补测试用例（内核 `method_capabilities_test.go:49-86` 加下划线合法/非法各一条；SDK 同步）。
2. **必须在同一变更集内改 2 个「前提断言」测试**，否则 CI 红：
   - `../kore-plugin-integrity/tests/fault/declaration_test.go:55-58`：一旦正则接受 `_` 就 `t.Fatal("前提已变…需重新裁决")` —— 这是**有意设计的熔断器**，会强制下一个人重新裁决而不是沿用旧结论。
   - `../kore-plugin-integrity/capabilities_test.go:132-133`：断言 `integrity.verify_file` 不在表内。
3. 跨仓变更集：`kore`（内核 + SDK + 文档）+ `kore-plugin-integrity`（声明 + 测试）→ 按 **G-15** 登记变更集。
4. 文档：`docs/PLUGIN-MATURITY.md:164`「不支持下划线」必须改写；`:86`、`:183` 的方法清单说明同步。
5. 之后才能落地 `integrity.verify_file: system:read`。注意 SDK 的「只收窄不放大」规则（`infocheck.go:194-203`）允许它：插件级 `system` 最强是 `admin`，方法级 `read` 属收窄 → 合法。
6. integrity 版本要 bump（声明面变化会改 `dist` sha，按 `RELEASE.md`「同 `id@version` 只允许一个 sha」必须 bump，0.4.0 → 0.5.0）。

### 方案 B：把 `verify_file` 改名（→ `verify.file`）

**为什么首选 `verify.file` 而不是 `verifyFile`**：integrity 本仓的命名风格是**全小写点分**（`baseline.list`、`schedule.set`、`schedule.get`），**没有任何 camelCase 方法**。`verifyFile` 会把外部文档建议（`PLUGIN-MATURITY.md:164`）强加到一个本仓不用的风格上；`verify.file` 与本仓风格一致，且无需改正则即可通过。两个名字都合法，`verify.file` 更合本仓。

**迁移影响清单（精确到 file:line）**

kore 仓（前端 2 个文件 + 文档 1 个文件）：

| 文件 | 位置 | 改什么 |
| --- | --- | --- |
| `web/integrity.js` | `:392` `invoke('verify_file', ...)` | 调用名改 `verify.file` |
| `web/integrity.js` | `:4` 头注释 | 契约说明同步 |
| `web/integrity.js` | `:388` `function verifyFile()` | **不用改**（JS 本地函数名） |
| `web/dist/integrity.js` | `:392`、`:4` | 由 `make frontend`（`Makefile:152-158`，零依赖静态拷贝 `rm -rf web/dist` 后重拷）重新生成，不手改 |
| `docs/PLUGIN-MATURITY.md` | `:86`、`:164`、`:183` | 三处方法清单与命名约束说明 |

插件仓 `kore-plugin-integrity`（源码 6 处 + 测试 5 个文件 + 文档 4 个文件）：

| 文件 | 位置 |
| --- | --- |
| `methods.go` | `:57` dispatch 白名单 |
| `internal/integrity/methods.go` | `:206` 服务层分派；注释 `:39`、`:159` |
| `internal/integrity/scan.go` | `:293` 错误文案「verify_file 只接受文件」 |
| `internal/integrity/paths.go` | `:145` 注释 |
| `main.go` | `:4` 包注释 |
| `capabilities_test.go` | `:126-140` `TestVerifyFileUndeclared` 整段语义反转 |
| `methods_test.go` | `:104`、`:117` |
| `tests/fault/declaration_test.go` | `:42-94` 整段裁决文字 + 差集断言 |
| `tests/fault/verify_test.go` | `:13`、`:22`、`:40`、`:48`、`:60`、`:69`、`:77`、`:85` |
| `tests/fault/boundary_test.go` | `:66-74` |
| `tests/fault/kill_test.go` | `:7`、`:13` |
| `tests/e2e/integrity_e2e_test.go` | `:3`、`:273`、`:285`（真实二进制 + UDS 端到端） |
| `README.md` | `:6`、`:25`、`:135` |
| `CHANGELOG.md` | `:50`、`:59`、`:110`、`:126`、`:134` |
| `RELEASE-EVIDENCE.md` | `:73-79` |
| `info.json` / `manifest.json` | `version` 0.4.0 → 0.5.0 |
| 发布链 | `dist` 重建 + sha 同步 `kore-plugins/versions.lock.json` 与 `presets/*.json`（G-17 / `RELEASE.md`） |

**G-14 判断**：`verify.file` 改的是**插件自己的方法名**，不是协议文法（`methodActionPattern` 不变、`protocol` 版本不变、`requires_kore` 不变）。所以**不触发 kore 主版本递增**；它是插件面的破坏性变更，integrity 处 0.x，按其既有惯例「0.x 阶段按次版本升级处理」（`../kore-plugin-integrity/CHANGELOG.md:126`）→ 升 0.5.0 即可。**未确认**：G-14 原文对「插件方法改名」是否要求 kore 主版本的无更细解释，本裁定按「协议文法未变」理解；若评审认为插件方法名属于协议可见面的破坏性变更，则需回到 G-14 重新定级。

**代价小结**：B 不动内核，风险集中在**发布机器**（版本/dist/索引/预设/G-15 四件套）与 1 个跨仓破坏性改名；调用方只有随包发布的 `web/integrity.js` 一处，无外部消费者（插件方法不对外暴露为稳定 API，`verify_file` 也无 SDK 导出）。

### 方案 C：保持现状，文档明确「含下划线的方法不支持方法级权限」

- 成本：**零**。而且**大部分已经做了**：`docs/PLUGIN-MATURITY.md:164`、`../kore-plugin-integrity/README.md:6`、`RELEASE-EVIDENCE.md:73-79`、`CHANGELOG.md:59` 都已写明该约束与后果，插件侧还有两个测试把它锁成护栏。
- 代价：`verify_file` 永远拿不到 `system:read`，审计口径持续失真（§3.2）；且这个「文档化的豁免」会成为后续每个 snake_case 方法名的模板，缺口从 1 个变成 N 个。

### 对比表

| 维度 | A 放宽字符集 | B 改名 `verify.file` | C 保持现状 |
| --- | --- | --- | --- |
| 改内核/协议文法 | 是（加法，向后兼容） | 否 | 否 |
| 是否破坏既有可见面 | 否（264 条声明中 0 条含 `_`，语义不变） | **是**（插件方法名，1 处前端调用） | 否 |
| 是否触发 G-14 主版本 | 否（放松文法不使旧值失效） | 否（协议文法未变；插件 0.x 次版本） | 否 |
| 变更规模 | 2 处正则 + 2 仓测试 + 4 处文档 | 2 仓 15 个文件 + 发布链四件套 | 0（已基本完成） |
| 是否修掉「一类」问题 | **是**（任何 snake_case 都能声明） | 否（只修 1 个实例，墙还在） | 否 |
| 协议自洽性 | **提升**（与 `eventNamePattern`/`invokeNamePattern` 对齐） | 不变（仍与其他两条正则不一致） | 不变 |
| 复核正当性 | 把异类修回主流 | 迁就异类 | 记录异类 |
| 风险集中处 | 插件装载的 fail-closed 路径 | 发布链（版本/dist/索引/预设） | 无 |

---

## 5. 推荐：方案 A

**理由（按权重）**

1. **A 修的是「一类」，B 只修「一个」。** 根因不是「`verify_file` 这个名字起错了」，而是「内核让一类合法命名**无法**声明方法级权限」。B 之后，任何作者写下 `check_all` / `verify_file` 都会再次静默回退到更宽能力，且没有任何告警——因为内核看不到插件的 dispatch 白名单（那是业务逻辑，G-01 禁止内核持有）。A 直接消除「声明不出来」这个不可能性。
2. **A 是纯加法，风险显著低于 B。** 264 条已声明条目中 0 条含下划线 → 放宽后没有任何既有清单改变语义；反过来 B 改的是协议可见方法名，要连带重建 dist、同步索引 `versions.lock.json` 与 `presets/*.json`（G-17 / `RELEASE.md`），任一环节漏掉就是「同 `id@version` 两个 sha」级别的发布事故。用发布机器的风险去换正则里两个字符，不划算。
3. **A 让协议自洽。** 同文件 `eventNamePattern`（`:57`）与 `invokeNamePattern`（`:60`）都已接受 `_`，且 `ssl` 插件的 `event:cert.renew_due` 是现役依赖。方法级是唯一不接受的那一个 —— 这不是有意的严格，是口径漂移。
4. **A 不碰 G-01。** 只放宽字符集，不引入业务名词表。
5. 反方最强的理由是「内核应当保持最小文法」。本裁定认为该理由在这里不足以翻盘：B 保住的「最小」只值两个字符，却让「声明不出方法级权限」这个结构缺陷保留下来。

**顺带明确：不要做 A+B。** 一旦 A 生效，`verify_file` 就能直接声明 `system:read`，此时再改名等于为了风格纯洁付一次破坏性变更——收益为负。

### 代价（A 的真实成本）

| 项 | 内容 |
| --- | --- |
| 内核 | `internal/core/registry/validate.go:55` 两处字符集加 `_` |
| SDK | `pkg/pluginapi/pluginapitest/infocheck.go:53` 同步（否则自检与内核判据分叉） |
| 内核测试 | `internal/core/registry/method_capabilities_test.go:49-86` 补 `verify_file` 合法用例 + 至少一条仍非法的用例（如 `_leading`、`set-rewrite` 保持非法） |
| 插件测试 | `../kore-plugin-integrity/tests/fault/declaration_test.go:55-58` 熔断器触发 → 改写为「正则已接受下划线，故必须声明」；`capabilities_test.go:132-133` 反转 |
| 跨仓登记 | G-15 变更集（kore + kore-plugin-integrity），含 commit 与合并顺序 |
| 文档 | `docs/PLUGIN-MATURITY.md:164`（约束改写为「camelCase 与 snake_case 均合法，**新方法名优先 camelCase**」）、`:86`、`:183`；`../kore-plugin-integrity/README.md:6`、`RELEASE-EVIDENCE.md:73-79`、`CHANGELOG.md` 追记 |
| 声明落地 | `../kore-plugin-integrity/info.json` 加 `integrity.verify_file: system:read`（SDK 的「只收窄」规则允许：`infocheck.go:194-203`） |
| 版本 | integrity 0.4.0 → 0.5.0（声明面变化改 dist sha，`RELEASE.md` 要求 bump） |

### 残余风险（A 落地后仍然存在，必须写进 ADR）

1. **两套命名风格并存**：camelCase 与 snake_case 都合法，长期有风格漂移风险。缓解：`PLUGIN-MATURITY` 保留「新方法名优先 camelCase」为**推荐**（非强制），并在协议文档给出理由。
2. **连字符仍被拒**，字符集变成「camelCase | snake_case，无 kebab」，这是一种**显式接受的不对称**（`method_capabilities_test.go:64` 有既有断言）。**不要顺手放开 `-`**：无现实需求，且会扩大协议面。
3. **回退到更宽能力的机制本身不变**：任何「忘了声明」的方法仍回退插件级最高要求（`invoke_capability.go:176`）。A 只消除「声明不出来」，不消除「没声明」。内核无法检测这种漂移（看不到 dispatch 白名单），只能靠插件侧护栏 → **建议后续卡**：把 integrity 的 `tests/fault/declaration_test.go` 模式抽成插件侧通用 lint，覆盖「dispatch 白名单 ⊆ method_capabilities ∪ 已知豁免」。
4. **收益定性为审计与协议自洽，不是安全**（§3.3）。落地时不要写成安全修复。
5. **未确认**：真实 `kored` 装载带 `integrity.verify_file` 的清单后回 `E_INVALID` 的端到端复现未做（§1.4）。

---

## 6. 未确认清单

| 项 | 缺什么证据 |
| --- | --- |
| 端到端 E_INVALID 复现 | 需在真实 `kored` 上装一次越界 `info.json`，超本卡「只读」授权 |
| 313 这个数字的精确定义 | 它是 `case` 字面量去重后的**上界**，含少量非方法枚举（模式/状态词）；「真方法数」需要各插件维护显式方法表，当前不存在该真源。对本裁定无影响（下划线方法恒为 1 个） |
| G-14 是否覆盖「插件方法改名」 | ADR 与 G-14 原文只写「破坏性**协议**改动」；「插件方法名是否属于协议可见面」无明文解释 |
| 是否有仓库外的 `verify_file` 消费者 | 只扫了本机 24 仓 + kore 仓；本机之外（如已发布的第三方集成）无法确认，从 `pkg/pluginapi` 导出面看无 SDK 级导出 |

---

## 附录：本次使用的只读命令

```bash
# 正则（Go 引擎，隔离 /tmp 程序，跑完即删）
go run main.go   # 输出见 §1.1

# 既有单测读数
cd /home/pt/Work/GolandProjects/kore
go test ./internal/core/registry/ -run 'TestParseRejectsInvalidMethodCapabilities|TestParseMethodCapabilities' -v
# → PASS，ok github.com/pengtang1024/kore/internal/core/registry 0.004s

# 24 仓扫描
python3 <<'PY'  # 见 §2.1
PY

# 声明面
for d in ../kore-plugin-*; do python3 -c "..."; done
```
