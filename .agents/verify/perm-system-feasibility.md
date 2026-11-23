# kore 权限系统可行性评估：让插件先声明所需权限

> 状态: analysis（只读评估）· 归属: verifier/architect · 日期: 2026-11-23 · 基线: `d553cd1`（工作树另有他人未提交改动，本轮未触碰）
> 范围: 只读代码与文档；未起服务、未改代码/文档/运行态、未 sudo。所有结论给 `file:line` 或命令输出；不确定项单列 §6。
> 一句话结论: **方向合理，但按原话做成"权限系统"会名不副实**——今天的 `capabilities` 不是"插件需要什么权限"，而是"调用我的人需要什么权限"；薄壳约束下内核不可能据此阻止插件本身越权。真正能做的是「知情同意 + 特权代理收敛 + 审计」，不是 sandbox。

---

## 0. 评估口径与当前运行态（先钉事实）

| 事实 | 证据 |
| --- | --- |
| 当前内核以**非 root** 运行（uid 1000） | `ps -o user=,pid=,cmd= -C kored` → `pt 2798902 …/bin/kored serve --config .kore-local.yaml`；`id -u` → `1000` |
| 管理 socket 属主 = 运行用户、0600 | `ls -l .kore-local-run/` → `srw------- 1 pt pt kore.sock`；收口代码 `cmd/kored/serve_boot.go:308-326` |
| 机器上**没有任何** `kore-<id>` 系统用户 | `getent passwd | grep -c '^kore-'` → `0`（降权路径本机未生效过） |
| 因此：本机插件进程与内核**同 uid**，OS 层隔离为零 | 降权仅在 root 下发生：`internal/core/supervisor/demote.go:29-32`（`!m.demote` 直接返回零值）；拉起点 `start.go:45,104` |
| 「6 个特权能力 + `<id>:<action>`」硬约束确有其事 | `internal/core/registry/validate.go:44-50,124-155`；`docs/PLUGIN-PROTOCOL.md:115-132`；`AGENTS.md` G-01 |
| 无业务域名词表由脚本硬门禁 | `scripts/thin-shell-check.sh:1-8`（`backup|site|monitor|cron|ssl|database|mysql|nginx|docker` 词首命中即 FAIL） |

> 这不是"挑刺"，是评估前提：**安全边界现状取决于部署形态**。下面所有"能否阻止越权"的判断都以"本机非 root + 生产 root 降权"两套形态分别给。

---

## 1. 现状盘点：声明 / 消费 / 强制

### 1.1 声明处（存在，且有两层）

| 位置 | 内容 |
| --- | --- |
| `internal/core/registry/manifest.go:117-121` | `Capabilities []string` + `MethodCapabilities map[string]string` 两个 JSON 字段 |
| `internal/core/registry/validate.go:29-34` | `maxCapabilities = 16`、`maxMethodCapabilities = 64`（数量上下限） |
| `internal/core/registry/validate.go:41-50` | 6 项特权能力白名单：`system:read/system:admin/net:read/net:write/proc:read/proc:write` |
| `internal/core/registry/validate.go:124-155` | 非空(≥1)/≤16/去重/语法 `^[a-z][a-z0-9-]{0,30}:[a-z][a-z0-9-]{0,30}$`/域∈特权集或域==自身 id |
| `internal/core/registry/validate.go:157-198` | `method_capabilities`：键必须是 `<自身 id>.<action>`、值只能是 6 项特权能力之一、重复键 fail-closed |
| `scripts/store-check.sh:74,81` | 商店收录门禁把 `capabilities` 列为必填键（键必须存在，空数组过不了内核校验） |
| `docs/PLUGIN-PROTOCOL.md:60-61,115-154` | 协议真源：两层模型、校验顺序、调用时校验、方法级能力 |

**声明层的性质**：这是**契约 + 语法校验**，不是授权。`registry` 不认识"这个能力是否该给"，只认识"字符串合不合法、域是不是你自己的"。

### 1.2 消费处（存在，但消费的是"调用方分级"，不是"插件权限"）

| 消费点 | 代码 | 消费方式 |
| --- | --- | --- |
| `/api/v1/invoke` 入站鉴权 | `internal/core/httpapi/invoke_capability.go:47-71,107-163,165-178`；调用于 `handlers_invoke.go:35` | 读**目标插件**的能力声明，判定**调用方会话**是否够格；`method_capabilities` 命中优先，未命中回退插件级取最高 |
| 会话能力解析 | `internal/core/httpapi/server.go:163-174`（`defaultCapabilityResolver`） | 本机会话/UDS/loopback 一律 `admin` + 6 项全权 |
| root-action 通道门票 | `internal/core/httpapi/channel.go:52,70`；`server.go:232-259` | 插件自身必须**已声明并取得** `system:admin` 才能调自己的 root_actions |
| 管理端点（enable/disable/uninstall） | `internal/core/httpapi/middleware.go:197-212`；路径分类 `server.go:186-201` | 要求**会话**持 `system:admin`，与目标插件声明无关 |
| hello 握手 | `internal/core/supervisor/hello.go:128-133,191-198` | 只校验"插件自报能力 ⊆ info.json 声明"，不授予、不落库 |
| 插件 bearer → 能力集 | `cmd/kored/serve_runtime.go:167-188` | **`return manifest.Capabilities`**：声明即授予 |
| 插件视图字段 | `cmd/kored/serve_daemon.go:99-101` | `GrantedCapabilities = manifest.Capabilities`（同源，非独立授权记录） |
| 安装落库 | `internal/core/installer/record.go:39` | `plugins` bucket 存一份 `capabilities[]` 副本（信息性） |
| 前端桥限权 | `web/app.js:1094-1107`（`methodAllowed`） | 只放行 `<plugin-id>:<action>` 且必须命中已授予能力 |
| 审计分级 | `internal/core/httpapi/audit_http.go:130-139` | `needAdmin=false` 的调用**完全不落库**（`audit.invoke_all=true` 才全量） |

### 1.3 强制处（分三层：真强制 / 名义强制 / 不存在）

| 面 | 是否真强制 | 证据 |
| --- | --- | --- |
| **入站调用**（谁能调插件方法） | ✅ 代码路径存在 | `handlers_invoke.go:35` → `authorizeInvoke`；不足 403 + `capability.denied` 审计 |
| 同上，生产实际 | ⚠️ **恒通过** | 未注入 `CapabilityResolver` 时会话恒 6 项全权：`invoke_capability.go:99-106,223-232`（首次打 WARN 后静默）；单管理员模式即"人人 admin" |
| **插件 → 自己 root_actions** | ✅ 真强制（四关） | bearer 归属 + `SO_PEERCRED` uid/pid + `system:admin`：`channel.go:58-96`；禁管理端点只认一条路径 `channel.go:24-46` |
| **插件 → 管理面** | ⚠️ 非 root 形态下**可绕过** | UDS 免密 + 本机即管理员：`local_access.go:109-128`、`server.go:163-167`、`middleware.go:35-52`；同 uid 的插件进程直连 `kore.sock` 即拿全权 |
| **插件进程自身行为**（读文件/联网/exec/写 /etc） | ❌ **不存在** | `pkg/pluginapi/` 全目录无 `Capabilit` 字样（SDK 不知道能力为何物）；无 seccomp/namespace（`docs/SECURITY.md:153-156` 明示不做）；无 cgroup 接线（§2.4） |
| **资源限额** | ❌ 未接线 | `platform.Resource.Apply` 仅定义于 `internal/platform/linux_resource.go:25`，全仓**零调用**（`grep -rn "\.Apply(" internal/platform internal/core/supervisor` 仅命中 `identity.Apply` 改 uid） |
| **升级新增能力重确认** | ❌ 不存在 | `grep -rn "E_CONFLICT" internal/core/installer internal/core/httpapi/handlers_plugins.go` → 0 命中；enable 流程 `handlers_plugins.go:100-129` 只调 `Backend.Enable` |
| **授予记录 `granted_capabilities`** | ❌ 不存在（文档声称有） | `docs/SECURITY.md:129`、`docs/PLUGIN-PROTOCOL.md:119` 称"启用时用户确认并写入 `plugins` bucket"；实际 `grep -rn "granted_capabilities" --include='*.go' internal cmd | grep -v _test` 只有 JSON 字段声明与注释（`types.go:57`、`handlers_plugins.go:67`），**无写入路径** |

### 1.4 关键语义发现：`system:admin` 的方向被反用了

- 插件在 `info.json` 写 `"capabilities": ["system:admin"]`，内核读出来的含义是：**调用这个插件写方法的人必须是 admin**（`requiredInvokeCapability`，`invoke_capability.go:47-71`），而不是"这个插件被授予了 admin"。
- 唯一例外是 root-action 通道：那里 `system:admin` 才是"插件自己的门票"（`channel.go:70`）。
- 后果：24 个插件仓里 **20 个**在插件级声明 `system:admin`（`grep -l '"system:admin"' ../kore-plugin-*/info.json | wc -l` → 20），方法级 `method_capabilities` 也全是 6 项特权能力。也就是说：**"插件需要什么权限"这个问题，今天的字段并没有回答**；它回答的是"调用方需要什么权限"。

> 这正是用户原话里"插件要先暴露需要哪些权限"与现状的错位点。做新系统前必须先决定：是**改语义**（字段改名/拆字段），还是**加一层**（保留现有入站语义，新增"插件所需能力"）。两者代价差一倍以上。

---

## 2. 缺口分层：从"声明了 N 个能力"到"内核真的能阻止没声明的事"

| 层 | 今天有什么 | 缺什么 | 判定 |
| --- | --- | --- | --- |
| **① 声明** | 两层字段 + 语法/域/数量校验（§1.1） | 缺少"这一条是给谁看的"的区分：入站要求 vs 插件所需；缺 `requires_root` 与 `system:admin` 的一致性校验（声明 root_actions 但没声明 `system:admin` 依然能装，只是运行时通道必拒） | 半有 |
| **② 授予** | 无独立授予记录；`pluginTokenAuth` 直接用 `manifest.Capabilities`（`serve_runtime.go:187`） | 缺 grant 记录、缺"安装/升级时用户确认"、缺"新增能力必须重确认"、缺撤销。ADR-0026 的凭据 grant 是现成范式（owner/grantee/审计 fail-closed），可以照抄 | **不存在** |
| **③ 校验** | 入站 invoke 判定 + root-action 四关 + 管理端点 admin（§1.3） | 单管理员模式恒通过；方法级能力只影响审计；`<id>:<action>` 内核不解释所以无法校验；缺"插件调用别的插件"的路径（今天只能经 bus，无能力门槛） | 部分 |
| **④ 运行期隔离** | root 形态：独立 uid + 独立 socket + `SO_PEERCRED`（`demote.go`、`socket.go`、`hello.go:142-170`）；非 root 形态：**无** | 缺 cgroup 限额接线（声明了 `memory_mb/cpu_quota/pids_max` 却不写 `memory.max`）；无 seccomp/namespace（明示不做，`SECURITY.md:153-156`）；非 root 形态缺"拒绝宣称隔离"的硬门禁 | 半有（root）/ 无（非 root） |
| **⑤ 审计** | `capability.denied`、`invoke.*`、`root.action`、`credential.*`、`local.access` 都有 | 审计记录**没有 capability 字段**（`store/audit.go:36-44`，见 `.agents/verify/r5-12-method-capability.md` §1）；只审 API 调用与提权动作，**不审文件/网络/进程访问**（没有拦截点，无从审）；无"授予/撤销"事件 | 部分 |

**一句话**：缺的不是"再加一张表"，而是 ②授予 与 ④运行期隔离 两层；而 ④ 的缺口不在权限系统里，在 platform 接线里。

---

## 3. 合理性判断

### 3.1 与「内核是薄壳、不得维护业务域名词表」是否冲突？

**结论：把"权限系统"做成业务域 ACL 就冲突；做成"通用语法 + 集合运算 + 代理收敛"不冲突。**

| 做法 | 是否冲突 | 冲突点 |
| --- | --- | --- |
| 内核维护 `site:delete` / `db:drop` 之类词表并判断危险性 | ❌ 直接冲突 | 需要内核理解业务语义；`scripts/thin-shell-check.sh` 业务域词门禁会 FAIL；G-01 人工评审必退 |
| 内核为每个插件写 if/else 授权分支 | ❌ 冲突 | "新增插件永远不需要改内核"被破坏 |
| 内核只做：语法校验 + 域归属 + **字符串集合比较**（声明 ⊆ 授予）+ 原样透传给代理/审计 | ✅ 不冲突 | 与今天 `validate.go` / `invoke_capability.go` 完全同构；内核不认识 "delete" 的业务含义，只认识"这个字符串在不在集合里" |
| 插件自定义 `<id>:<action>` 由用户在 UI 授权，内核只存字符串 | ✅ 不冲突 | 前提是**明确它不可强制**（内核不解释就不拦），只作知情同意/展示/跨插件令牌 |

**冲突的真正红线**：一旦内核要回答"这个动作危不危险"，就必须懂业务。所以权限系统的能力**上限**是"能不能做这个 API 调用 / 能不能走这个特权代理"，**不是**"能不能删这个站点"。

### 3.2 真正的安全边界在哪？内核 ACL vs OS 层

| 威胁 | OS 层（root 形态：独立 uid + cgroup + 文件权限） | 内核 ACL | 结论 |
| --- | --- | --- | --- |
| 插件读别的插件状态目录 | ✅ 挡住（0700、不同 uid） | 无关 | 重复 |
| 插件连别的插件 socket | ✅ 挡住（0600 + chown） | 无关 | 重复 |
| 插件自己提权执行 root 命令 | ✅ 挡住（非 root、无 sudo） | **代理是唯一通道**（`channel.go` 四关） | 内核是边界本体，不是重复 |
| 插件写 `/etc/*` | ✅ 挡住（权限位） | 受控写原语（ADR-0028）是唯一合法通道，但**未接线**（`.agents/verify/adr-0028-phase1.md` 明示"未接线 cmd/kored、未真机下发"） | 内核补充，当前为空 |
| 面板多用户越权（未来） | ❌ 挡不住（同一 uid 的浏览器进程） | ✅ 唯一手段 | 不可替代 |
| 非 root 形态 / Windows（同 uid） | ❌ 全挡不住 | ⚠️ 名义上有，实际被"本机免密=管理员"绕过 | **两者都不成立** |

**回答"重复还是补充"**：
- root 形态下：对**进程互害**是重复（OS 已挡），对**API 面与多用户**是补充且不可替代。
- 非 root 形态下：既不是重复也不是补充，因为两边都没有真边界——今天任何插件进程都能以同 uid 连 `kore.sock` 拿到 `admin` + 6 项全权（`local_access.go:109-128` + `server.go:163-167`），CSRF 对 UDS 还豁免（`middleware.go:157-163`）。
- 因此：**先修边界，再加声明**。否则新权限系统只是给一个已经漏的边界加了一层 UI。

### 3.3 合理性结论

| 判断 | 结论 |
| --- | --- |
| 产品上合理吗 | **合理**：用户需要知道"装这个插件等于把什么交给它"，这是知情同意（consent），不是 ACL |
| 技术上能做成真 ACL 吗 | **不能**（薄壳 + 无 seccomp/namespace + 插件可任意 syscall）。能强制的是"API 调用面 + 特权代理面" |
| 值得做吗 | **值得，但范围要砍**：①授予记录与升级重确认 ②root_actions 与 `system:admin` 一致性 ③非 root 形态拒绝宣称隔离 ④审计补 capability 字段。**不要**做业务域 ACL，**不要**承诺"阻止插件越权" |
| 命名建议 | 叫「能力声明与授权」（capability consent），不要叫「权限系统 / ACL / RBAC」——后者会给用户虚假安全感，也与 G-11"不做多用户 RBAC"打架 |

---

## 4. 设计形态对比

> 代价为**估算**（人日，含实现+测试+文档同步），不是实测；依据是同类改动在本仓的历史粒度（method_capabilities 一轮约 2–3 人日，含 24 仓声明回填）。

| 形态 | 薄壳合规 | 能否真正阻止越权 | 插件侧改动 | 内核侧改动 | 估算 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| **① 维持现状，只补强制点**：保留 6+N 语法；补 grant 记录 + 升级重确认 + root_actions 必须声明 `system:admin` + 审计加 capability 字段 | ✅ 完全合规 | ❌ 只挡 API 面；进程行为仍不挡 | 极小（升级时多一次确认；`root_actions` 仓补 `system:admin`） | 中（installer/enable 写 grant、diff 比对、invoke 改成"声明 ∩ 授予"、审计 schema） | 3–5 | 必做基线 |
| **② OS 能力映射型**：6 项特权能力映射到具体 OS 机制（`system:admin` → 仅 root-action 代理；`net:write`/`proc:write` → 仅对应代理动作类别；read 类 → 仅入站只读），`enable` 时按映射 fail-closed | ✅ 合规（映射表是 OS 语义，不是业务语义） | ⚠️ 部分：能保证"特权动作只能走代理"，不能阻止插件自己 exec/写文件 | 小（声明不变，语义收紧；少数插件要拆能力） | 中高（映射表 + enable 门控 + root_action 形状分类 + 非 root 拒绝） | 5–8 | 推荐主体 |
| **③ 通用 `<id>:<action>` 型**：插件自定义能力全集，用户在 UI 逐项授权，内核只存字符串与集合比较 | ✅ 合规（内核不解释） | ❌ 不能强制（内核不懂语义，插件仍可绕过自己的声明） | 中（每个插件要补自有能力清单与"方法→能力"映射） | 小（已有语法/域校验，补 grant 存储与展示） | 3–4 | 只做知情同意层 |
| **④ 业务域 ACL 型**：内核维护 `site:delete`/`db:drop` 词表并判危险级 | ❌ **违反 G-01**（业务域词表进内核） | ✅ 理论上可精确控制 API 面 | 大 | 大（等于把业务搬进内核） | 10+ | **否决** |

**组合建议**：①（基线）+ ②（可强制子集）+ ③（仅 UI 知情同意，明确标注"不作为安全边界"）。④ 不碰。

---

## 5. 明确推荐与残余风险

### 5.1 推荐

**推荐形态 ② 为主体、① 为基线、③ 为展示层**，分三期：

1. **P0（安全基线，1–2 人日）**：非 root 形态显式拒绝宣称隔离——管理 socket 不对"与插件同 uid"的进程开放（或插件进程组排除在 `localOwnerUID` 之外），`GET /system/info` 与 UI 明示 `isolation: none`。**这一条不做，后面全是装饰。**
2. **P1（授予层，2–3 人日）**：新增独立 `granted_capabilities` 记录（照 ADR-0026 的 grant 范式：写前审计、fail-closed、可撤销）；enable/升级时比对声明与授予，新增能力必须重确认（`E_CONFLICT`）；invoke 判定改为"目标插件能力 ∩ 已授予"；审计记录补 capability 字段。
3. **P2（OS 映射，3–5 人日）**：6 项特权能力 → 代理动作类别映射；`root_actions` 非空必须声明 `system:admin`（registry 校验 + 24 仓回填）；cgroup 限额接线（`platform.Resource.Apply` 在 spawn 前调用，取声明与全局上限的较小值）——这属于资源而非权限，但同属"声明→强制"缺口，建议同批收口。

### 5.2 它做不到什么（残余风险，必须写进产品文案）

| 残余风险 | 说明 | 现有缓解 |
| --- | --- | --- |
| **插件进程任意行为** | 声明 `system:read` 的插件仍可 exec、联网、读 world-readable 文件；内核不拦截 | 独立 uid（仅 root 形态）+ 文件权限；无 seccomp/namespace（明示不做） |
| **非 root / Tier B 无隔离** | 插件与内核同 uid，管理面免密 → 插件即管理员 | 仅"显式降级 + WARN"（`docs/SECURITY.md:147,188-192`）；**当前本机就是此形态** |
| **恶意插件可撒谎** | 声明最小能力、实际做别的事；声明对恶意方无约束力 | 只能靠代码评审/签名/商店收录（M4 强校验） |
| **业务动作粒度不可强制** | "删站点" vs "看站点" 内核不区分；只有插件自己能区分，而插件不做 | 无（这正是薄壳的代价） |
| **审计不覆盖资源访问** | 只审 API 调用与提权动作；文件/网络/进程访问无审计 | 只能靠 root-action 代理处集中审计 |
| **升级新增能力静默生效** | 今天不存在重确认，升级后新增能力直接可用 | 无（P1 修） |
| **cgroup 限额未生效** | `resources.*` 声明不落地，OOM/限流不会按声明发生 | 无（P2 修） |

### 5.3 代价总结（回答"代价有多大"）

- **只补授予层 + 一致性校验**（①）：3–5 人日，风险低，能给出"用户确实同意过"的证据链，但**不改变安全强度**。
- **加上 OS 映射与 cgroup 接线**（②）：再 5–8 人日，能把"声明 → 特权代理 → 资源限额"这条线做成真强制；仍**不能**阻止插件进程的任意行为。
- **想做"真 sandbox"**（seccomp / namespace / 每插件 mount ns）：与本项目红线冲突（G-02 依赖上限、G-05 无容器运行时、`SECURITY.md:153-156`），**不是 10 人日量级，是换架构**。

---

## 6. 未确认 / 未验证

1. **cgroup 委派在本机是否可用**：未测试（只读评估，不起实例）；`platform/linux_resource.go:21` 的 `Delegated()` 需要真实写探测。
2. **非 root 形态下插件连管理 socket 的实测**：结论由代码路径推出（`local_access.go:109-128` + `server.go:163-174` + UDS 免 CSRF），**未做真实 PoC**；若要作为 P0 依据，建议补一次隔离实例验证（用同 uid 的独立进程 `curl --unix-socket`）。
3. **`web` 桥的能力限权是否为设计意图**：`web/app.js:1094-1107` 只放行 `<plugin-id>:<action>`，而 24 仓**无一声明自有域能力**（全是 `system:*`），且 `web` 入口实际为 0 个（`python3` 遍历 `../kore-plugin-*/info.json` → `web entry count = 0`）。桥当前是死代码，还是待接入，未确认。
4. **`store` 索引侧 `capabilities` 的消费**：`docs/DATA-MODEL.md:189` 称索引条目该字段"信息性、内核不消费"；未逐行核 `market` 包，暂按文档采信。
5. **`registry/manifest.go:117` 注释仍写"8 项白名单"**（实际 6 项）：属注释漂移，不影响行为，未修（本轮只读）。

---

## 7. 证据附录（命令 + 关键输出）

```text
$ ps -o user=,pid=,cmd= -C kored
pt       2798902 /home/pt/Work/GolandProjects/kore/bin/kored serve --config …/.kore-local.yaml
$ ls -l .kore-local-run/
srw------- 1 pt pt 0 Nov 23 21:41 kore.sock
$ getent passwd | grep -c '^kore-'
0

$ grep -rn "granted_capabilities" --include='*.go' internal cmd | grep -v _test
internal/core/httpapi/handlers_plugins.go:67:// 与列表端点共用同一个 Backend.Plugin：新字段 web / granted_capabilities
internal/core/httpapi/types.go:57:	GrantedCapabilities []string `json:"granted_capabilities,omitempty"`
# → 无任何写入 plugins bucket 的代码路径

$ grep -rn "E_CONFLICT" internal/core/installer internal/core/httpapi/handlers_plugins.go
# → 0 命中（不存在"升级新增能力重确认"）

$ grep -rn "\.Apply(" internal/platform internal/core/supervisor | grep -v _test
internal/core/supervisor/start.go:104:  if err := m.identity.Apply(cmd, acct); err != nil {
# → 只有 uid 降权；无 Resource.Apply（cgroup 限额未接线）

$ grep -rn "seccomp\|namespace\|NoNewPrivileges" --include='*.go' internal cmd | grep -v _test
# → 0 命中（仅文档声明"明确不做"）

$ python3 -c '…遍历 ../kore-plugin-*/info.json…'
system:admin 在插件级声明：20 / 24 仓
method_capabilities：23 / 24 仓
web 入口（web.entry）：0 仓

$ grep -n "hasCapability(grants, \"system:admin\")" internal/core/httpapi/channel.go
70:  if !hasCapability(grants, "system:admin") {
```

---

## 8. 给决策者的一句话

> **做**：把 `capabilities` 从"入站调用分级标签"升级成"**声明 → 用户授予 → 特权代理收敛 → 审计**"的知情同意链，同时把非 root 形态的假隔离和 cgroup 未接线这两个真缺口补上。
> **不做**：不要把它包装成能阻止插件越权的"权限系统"；不要引入业务域词表（G-01）；不要做 RBAC（G-11）。
> **判据**：如果新系统上线后，一个恶意插件在 root 形态下仍只能"做自己 uid 能做的事 + 走内核代理"，就算成了；如果它能靠声明绕过任何东西，那说明做的是 UI 不是边界。
