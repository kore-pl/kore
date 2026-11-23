> 状态: proposed · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [0018-privilege-model](./0018-privilege-model.md)、[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md) §3.1.2、[PLUGIN-MATURITY](../PLUGIN-MATURITY.md) §3.5、[CORE](../CORE.md) §3、[裁定报告](../../.agents/verify/method-underscore.md)

# ADR-0047: 方法名字符集——放宽 `methodActionPattern` 接受下划线（不重命名 `verify_file`）

## 0. 问题与本 ADR 裁什么

`integrity` 插件有方法 `verify_file`，它只需要 `system:read`（只读 sha256 校验），但**写不进** `info.json` 的 `method_capabilities`：内核 `methodActionPattern` 不允许下划线，声明即 `E_INVALID`，整份清单 fail-closed（插件装不上）。于是它按设计回退到插件级能力，而 integrity 插件级同时声明 `system:read` 与 `system:admin`，回退取最高要求 → `verify_file` 被当成 admin 类方法。

本 ADR 只裁一件事：**放宽内核正则（A）、还是把方法改名（B）、还是保持现状只写文档（C）**。本卡不实现。

事实与逐条证据见 [裁定报告](../../.agents/verify/method-underscore.md)（下称「报告」）。

## 1. 事实核查（摘要，完整证据见报告 §1）

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 正则为 `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`，`verify_file` 不匹配；SDK 有逐字副本 | `internal/core/registry/validate.go:55`、`:187`；`pkg/pluginapi/pluginapitest/infocheck.go:53`、`:246` |
| 2 | 回退点在 `invoke_capability.go:176`，回退取插件级**最高**要求 | `internal/core/httpapi/invoke_capability.go:165-177`、`:47-71` |
| 3 | `verify_file` 确认只读（`os.Stat` + 读哈希，无写入） | `../kore-plugin-integrity/internal/integrity/methods.go:550-571`、`scan.go:283-301`；dispatch 白名单 `methods.go:57` |
| 4 | 24 仓**只有 1 个**下划线方法（`verify_file`）；264 条已声明覆盖中 0 条含下划线 | 报告 §2（扫描命令与结果） |
| 5 | 授权面今天**零效果**：单管理员全权，且多用户 RBAC 属 G-11 不做项 | `invoke_capability.go:104-106`、`middleware.go:194` |
| 6 | 审计面**真实生效**：`needAdmin` 才写 `invoke.*`，且代码注释明写「只读时不审计」 | `audit_http.go:130-138`、`handlers_invoke.go:55` |
| 7 | 同文件相邻两条触发名正则**已接受**下划线，且有现役依赖 | `validate.go:57`（`eventNamePattern`）、`:60`（`invokeNamePattern`）；`../kore-plugin-ssl/info.json` 的 `event:cert.renew_due` |

**定性（本 ADR 的前提，防止后续被误当安全修复）**：这是**审计口径缺陷 + 协议表达能力缺陷**，不是授权缺陷。修它对安全性没有可观测增益。

## 2. 候选对比

| 维度 | **A. 放宽字符集** | B. 改名 `verify.file` | C. 保持现状 + 文档 |
| --- | --- | --- | --- |
| 改内核文法 | 是（加法） | 否 | 否 |
| 破坏既有可见面 | 否（0/264 条声明含 `_`） | **是**（协议可见方法名） | 否 |
| 修「一类」还是「一个」 | **一类** | 一个 | 不修 |
| 与相邻正则自洽 | **提升** | 不变（仍异类） | 不变 |
| 变更规模 | 2 处正则 + 2 仓测试 + 4 处文档 | 2 仓 15 文件 + dist/索引/预设施工 | 0（已基本完成） |
| 风险集中处 | 插件装载 fail-closed 路径 | 发布链（版本/dist/索引/预设） | 无 |
| 违反 G-01 | 否（只放宽字符集，不引入业务词） | 否 | 否 |
| 触发 G-14 主版本 | 否（放松文法不使旧值失效） | 否（协议文法未变；插件 0.x 次版本） | 否 |

**为什么不选 B**：B 修的是「这个名字起错了」，而根因是「内核让一类合法命名**无法**声明方法级权限」。B 之后任何作者写 `check_all` 仍会静默回退到更宽能力且无任何告警——内核看不到插件的 dispatch 白名单（那是业务逻辑，G-01 禁止内核持有）。同时 B 要用发布链（dist 重建 + `versions.lock.json` + `presets/*.json`，见 G-17 / `docs/RELEASE.md`）承担「同 `id@version` 两个 sha」级别的事故风险，去换正则里两个字符。

**为什么不选 C**：C 的文档工作**已基本完成**（`PLUGIN-MATURITY.md:164`、插件 `README.md:6`、`RELEASE-EVIDENCE.md:73-79`、`CHANGELOG.md:59`，外加两个把现状锁成护栏的测试）。但 `verify_file` 永远拿不到 `system:read`，审计口径持续失真；且这个「文档化豁免」会成为后续每个 snake_case 方法名的模板，缺口从 1 个变 N 个。

## 3. 裁决

**采纳 A。**

### 3.1 正则改前改后

```go
// 改前（内核 internal/core/registry/validate.go:55；SDK pkg/pluginapi/pluginapitest/infocheck.go:53 逐字相同）
methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`)

// 改后：仅在两处字符集加入下划线；首字符仍限小写字母
methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$`)
```

- 首字母仍是 `[a-z]` → `_leading` 仍非法。
- 连字符 `-` **仍非法**（`method_capabilities_test.go:64` 既有断言保留）。这是**显式接受的不对称**：「camelCase | snake_case，无 kebab」。不要顺手放开 `-`。
- 内核与 SDK **必须同一变更集同改**，否则「插件自检通过、内核装不上」或反之。

### 3.2 `a_b.c` 的切分规则：不切分，且禁止内核切分

1. **唯一分割点是 `<id>` 与 `<action>` 之间的那个 `.`**（`validate.go:183` 的 `strings.CutPrefix(method, m.ID+".")`）。`idPattern`（`validate.go:39`）= `^[a-z][a-z0-9-]{0,30}[a-z0-9]$` **不含下划线、不含点**，因此域/动作边界唯一、无歧义；`a_b` 永远不可能是合法域。
2. **动作段内部不再切分**：`:187` 只对 `action` 整段做一次正则匹配，内核从不按 `.` 分解动作的层级。
3. 因此 `a_b.c` 只有一种读法：**一个整体动作名**。若插件愿意，它可被自己的分派逻辑理解为「`a_b` 命名空间下的 `c`」——那是插件业务。**让内核按 `_`/`.` 切分层级来表达业务结构，反而违反 G-01。**所以「切分规则」的正解是「不切」。

### 3.3 与 `<plugin-id>:<action>` 无冲突

`capabilities` 用 `:` + `capabilityPattern`（`validate.go:52`）；`method_capabilities` 用 `.` + `methodActionPattern`（`:55`）。两者无共享解析代码、无共享正则，`verify_file`（无 `:`）不可能被误解析成能力项。放宽 A 对能力项语法**零影响**。

### 3.4 不违反 G-01

G-01 红线是「不得维护业务域名词表」。A 改的是**字符集**，未引入任何 `verify`/`file`/`baseline` 之类业务词；内核仍只看「是否合法标识符 + 域是否等于插件 id」。语法层改动与薄壳红线正交。

## 4. 后果

### 4.1 落地前置（A 生效后才能做）

1. 内核 `validate.go:55` 与 SDK `infocheck.go:53` 同步放宽；两处各补测试（内核 `method_capabilities_test.go:49-86` 补 `verify_file` 合法用例 + 至少一条仍非法用例）。
2. **必须在同一变更集内改 2 个「前提断言」测试**，否则 CI 红：
   - `../kore-plugin-integrity/tests/fault/declaration_test.go:55-58`（一旦正则接受 `_` 就 `t.Fatal` 的**熔断器**，改为「已接受下划线，故必须声明」）；
   - `../kore-plugin-integrity/capabilities_test.go:132-133`（反转「不应出现在表内」）。
3. `integrity` 加 `integrity.verify_file: system:read`。SDK 的「只收窄不放大」规则允许：插件级 `system` 最强为 `admin`，方法级 `read` 属收窄（`infocheck.go:194-203`）。
4. 跨仓变更集按 **G-15** 登记（`kore` + `kore-plugin-integrity`，含 commit 与合并顺序）。
5. `integrity` 版本 bump 0.4.0 → 0.5.0（声明面变化会改 dist sha，`docs/RELEASE.md` 要求 bump）。
6. 文档同步（**G-06**）：`docs/PLUGIN-MATURITY.md:164` 改写为「camelCase 与 snake_case 均合法，**新方法名优先 camelCase**」，`:86`、`:183` 方法清单说明同步；插件侧 `README.md:6`、`RELEASE-EVIDENCE.md:73-79`、`CHANGELOG.md` 追记。

### 4.2 正面

- `verify_file` 获得 `system:read`，只读方法不再被写进「写/管理类」审计（`audit_http.go:130-138` 的口径恢复自洽）。
- 「含下划线的方法无法声明方法级权限」这一**不可能性**被消除；同类问题不再复发。
- `methodActionPattern` 与同文件 `eventNamePattern`/`invokeNamePattern` 口径统一，协议自洽性提升。

### 4.3 负面与残余风险

1. **两套命名风格并存**（camelCase + snake_case），长期有风格漂移风险。缓解：`PLUGIN-MATURITY` 保留「新方法名优先 camelCase」为**推荐**并给出理由。
2. **连字符仍被拒**，字符集不对称（见 §3.1），显式接受。
3. **回退到更宽能力的机制本身不变**：任何「忘了声明」的方法仍回退插件级最高要求（`invoke_capability.go:176`）。A 只消除「声明不出来」，不消除「没声明」。内核**无法**检测这种漂移（它看不到插件的 dispatch 白名单，那属业务逻辑/G-01），只能靠插件侧护栏。
4. **收益定性为审计与协议自洽，不是安全**（§1 定性）。落地时不得写成安全修复。

### 4.4 后续建议（不在本 ADR 范围）

把 `kore-plugin-integrity/tests/fault/declaration_test.go` 的护栏模式抽成**插件侧通用 lint**，判据为「dispatch 白名单 ⊆ `method_capabilities` ∪ 显式豁免清单」。这是内核无法承担的那一半防线。

## 5. 复审条件

出现以下任一情况，本 ADR 必须重新裁决：

1. 内核改为按 `_` 或 `.` 对动作段切分语义（直接违反 G-01，本 ADR 的 §3.2 失效）。
2. 出现第三条命名风格诉求（如要求接受 `-`），需连同 `capabilityPattern`/`idPattern` 一起做一次字符集总裁决，不再逐条放宽。
3. 多用户 RBAC 从 G-11 的非目标清单移出：届时 `system:read` vs `system:admin` 的差别具备授权后果，`method_capabilities` 的完整性要从「审计口径」升级为「安全控制」，需重新评估「未声明即回退更宽能力」是否仍可接受。
4. 若评审裁定「插件方法名属于 G-14 的协议可见破坏性面」，则 B 的定级需重算（届时 A 仍是更优解，但 B 的成本会上一个量级）。

## 6. 未确认

| 项 | 缺什么 |
| --- | --- |
| 真实 `kored` 装载带 `integrity.verify_file` 的清单回 `E_INVALID` 的端到端复现 | 需改插件仓或造临时清单，超出本卡「只读」授权；结论基于代码路径 + Go 正则实测 + 既有单测绿 |
| G-14 对「插件方法改名」的无明文解释 | 本 ADR 按「协议文法未变」理解，见复审条件 4 |
