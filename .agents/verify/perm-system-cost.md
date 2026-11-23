# 插件权限声明系统 · 代价评估

> 只算代价，不论证合理性。范围：24 个插件仓 + `kore` 内核 + `kore-plugins` 索引仓。
> 数据来源：脚本遍历 24 仓 `info.json` / `manifest.json` / `go.mod`（2026-11-23，工作树无未提交改动）。
> 口径标注：**【确定】**= 脚本/代码/文档可直接核对；**【估算】**= 有依据的数量级推断；**【需实测】**= 没有实验数据，禁止当结论用。

---

## 0. 结论速览

| 项 | 数值 | 口径 |
| --- | --- | --- |
| 已声明 capabilities 的仓 | 24 / 24（无缺字段、无语法非法） | 确定 |
| 插件级声明条数 | 36 条 | 确定 |
| 方法级声明条数 | 264 条（23 仓有，`echo` 为 0） | 确定 |
| 实际有效授权档位 | ≈2–3 档（本质只有 read / admin 两档，个别仓多一档 proc） | 确定 |
| 使用自有域 `<id>:<action>` 的仓 | 0 | 确定 |
| 全量改造发版次数 | 24 次插件发版（+ 内核 1 + SDK 1 = 26 次制品发布） | 确定（按仓计） |
| 索引重签次数 | 批量合入 1 次；逐仓合入 24 次 | 确定 |
| 人工叶子动作 | ≈600（500–700）个 | 估算 |
| 插件侧人时 | 36–48 人时（发版机械动作）+ 16–24 人时（语义重映射）≈ 7–9 人日 | 估算 |
| 内核侧新增代码 | 1,000–1,700 行 Go + 300–600 行前端 + 2 个 ADR | 估算 |
| 单次 invoke 额外开销 | 内存查表 + 2 次切片拷贝；量级 <10 µs，**未实测** | 需实测 |

**最关键的一条前提**：这套系统**不是从零建设**。`info.json.capabilities` / `method_capabilities`、三处校验（安装/授予/调用）、握手 subset 校验、`capability.denied` 审计与告警**都已落地**，相关内核代码约 700–1,000 行（估算）。因此本报告的"代价"是**增量**：把 6 项粗粒度能力换成更细的资源级声明，并把"授予"从纸面条款做成真流程。

---

## 1. 账一：插件侧改造量（24 仓）

### 1.1 现状统计表【确定，脚本遍历，非抽查】

统计命令口径：逐仓 `json.load(info.json)`，取 `capabilities`（插件级）与 `method_capabilities`（方法级）；合规判据 = 协议 §3.1：1–16 项、去重、语法 `^[a-z][a-z0-9-]{0,30}:[a-z][a-z0-9-]{0,30}$`、特权 6 项之一或域 == 插件 id。

| 仓名 | capabilities 条数 | 方法级条数 | 是否合规 | 备注 |
| --- | ---: | ---: | --- | --- |
| app-deploy | 1 | 8 | 是 | 全 `system:admin` |
| backup | 1 | 13 | 是 | 全 `system:admin` |
| container | 2 | 13 | 是 | read + admin 两档 |
| cron | 2 | 10 | 是 | read + admin 两档 |
| db-mysql | 1 | 15 | 是 | 全 `system:admin` |
| db-postgres | 1 | 13 | 是 | 全 `system:admin` |
| discover | 2 | 4 | 是 | 含 `proc:read` |
| dns | 2 | 11 | 是 | read + admin |
| echo | 1 | 0 | 是 | **唯一无方法级声明的仓**（字段可选） |
| file | 2 | 23 | 是 | read + admin |
| firewall | 1 | 7 | 是 | 全 admin |
| integrity | 2 | 7 | 是 | read + admin |
| logs | 2 | 15 | 是 | read + admin |
| monitor | 1 | 4 | 是 | 全 read |
| process | 3 | 9 | 是 | 含 `proc:read` / `proc:write` |
| redis | 1 | 21 | 是 | 全 admin |
| runtime-node | 1 | 5 | 是 | 全 admin |
| runtime-php | 1 | 5 | 是 | 全 admin |
| runtime-python | 1 | 9 | 是 | 全 admin |
| site | 1 | 22 | 是 | 全 admin |
| ssh-guard | 1 | 9 | 是 | 全 admin |
| ssl | 1 | 20 | 是 | 全 admin |
| terminal | 3 | 9 | 是 | 含 `proc:write` |
| waf | 2 | 12 | 是 | read + admin |
| **合计** | **36** | **264** | **24/24** | — |

**格式一致性结论【确定】**：

- 24 仓 36 条插件级声明**全部是 6 项特权能力**，无一使用插件自有域 `<id>:<action>`。
- 生效能力分布：`system:admin` 152、`system:read` 138、`proc:read` 6、`proc:write` 4；`net:read` / `net:write` / `system:write` **使用次数 0**。
- 插件级声明恒为方法级的并集（admin 仓的插件级就是 `system:admin`），因此**插件级不携带任何方法级信息**，实际粒度由 264 条方法级行承担。
- 结论：现状不是"24 仓格式各异"，而是"**24 仓统一到 2–3 档**"。这既降低了改造的语义难度，也意味着现有声明**无法表达资源范围**（改哪个目录、绑哪个端口、动哪个 unit）。

### 1.2 单仓改造清单（引入更细的资源级声明）

| 文件 | 改什么 | 是否必须 | 估算量 |
| --- | --- | --- | --- |
| `info.json` | `capabilities` / `method_capabilities` 换成资源级声明；`size_bytes` 自指字段随之重算 | 必须 | 1 条/方法，本仓 4–23 条 |
| `manifest.json` | 必须与 `info.json` 的 `id/version/protocol/requires_kore/capabilities` **逐字一致**（`Makefile` 的 dist 目标会校验，不一致直接 `sys.exit`） | 必须 | 同 info.json |
| `CHANGELOG.md` | 顶部新增版本条目 | 必须（G-17） | 1 条 |
| `config.go` / `handshake.go` | 仅当新增字段（如 `capability_scope`）需要透传时改；纯字符串替换**可不动** | 条件必须 | 0–20 行 |
| 测试（`method_capabilities_test.go` / `info_caps_test.go` / `declaration_test.go` / `capability_consistency_test.go` / `main_test.go`） | 期望表随声明重写；若引入新词汇，`pluginapitest.CheckInfoJSON` 会先红 | 必须 | 20–80 行/仓（依表大小） |
| `Makefile` | **不需要改**，除非新增字段参与一致性校验 | 否 | 0 |
| `go.mod` | 仅当 SDK 发布新版本且需新校验器时 bump（见 §1.3 单点） | 条件必须 | 1 行 + `go.sum` |

**×24 估算**：

- 机械替换：24 仓 ×（2 个 JSON + 1 个 CHANGELOG + 1–3 个测试）= **96–168 个文件**。
- 语义决策：264 条方法级声明要判断"这个方法动的是哪个资源域"，按每条 1–2 分钟 + 每仓边界确认 20 分钟 → **16–24 人时**（估算）。这是**不能脚本化**的部分。
- 代码调用点：能力声明是**声明式**的，插件服务端逻辑不读 capability 做分支，只有握手把 `m.Capabilities` 原样上报（`config.go:66`）。因此"代码里的调用点"实际是**测试期望表**，不是业务代码——这一项常被高估。

### 1.3 版本抖动成本【确定步骤，估算时长】

因果链（每一环都在既有流程/代码里可核对）：

1. 改 `capabilities` → `info.json` / `manifest.json` 内容变 → `size_bytes` 自指值变（dist 目标最多迭代 10 轮找固定点）→ **dist sha 必变**。
2. 改 dist sha → 按 RELEASE §1/§3 **必须 bump**、必须重发 release、必须重签索引（同 `id@version` 只允许一个 sha）。
3. bump 版本 → tag / 三端 push / 三端 release / 索引 4 字段 / 账本 1 条 / 预设 pin 同步。

| 成本项 | 数量 | 口径 |
| --- | ---: | --- |
| 插件发版次数 | **24** | 确定（一仓一版，禁止同版本换 sha） |
| 内核发版 | 1（新解析/强制点） | 确定 |
| SDK `pkg/pluginapi` 发版 | 1（若校验器词汇变） | 确定 |
| 索引重签 | **1 次**（批量合入）/ **24 次**（逐仓合入） | 确定 |
| `plugins.json` 字段编辑 | 24 仓 × 4 字段（version/sha256/size_bytes/download_url）= **96 处** | 确定 |
| `versions.lock.json` 追加 | 24 条 | 确定 |
| `presets/*.json` 版本 pin 同步 | 7 个文件共 **47 条** pin（full 21 / db-only 5 / security 5 / web-pro 6 / gateway 4 / dev 3 / web-lite 3） | 确定 |
| 三端 push + 三端 release | 24 仓 × 6 = **144 次远程动作** | 确定（每仓 origin/github/gitee 三 remote） |
| 人工叶子动作合计 | **≈600（500–700）** | 估算 |
| 机械发版人时 | 24 × 1.5–2 h = **36–48 人时**（dist 双跑 + 三端 + 索引核对） | 估算 |
| 总计（含语义重映射） | **7–9 人日** | 估算 |

**最容易被低估的单点**：24 仓的 `go.mod` 锁定 `github.com/pengtang1024/kore/pkg/pluginapi v0.1.3`，构建时 `GOWORK=off`（不吃本地 workspace）。若新词汇需要新校验器，顺序是 **SDK tag → 24 仓 bump 依赖 → 重新 `make dist`（二进制 build info 里的 module 版本变了，sha 再变）→ 发版**。SDK 发布还有 GOPROXY 索引延迟门禁（RELEASE §2.2 实测 180s 超时），且一次发错只能新版本修正。这条链把"改一个 JSON 字段"变成"等一个 SDK 发布"。

### 1.4 能否不改协议、逐仓渐进？【确定：现有代码已具备两条路径】

关键事实（代码可核对）：

- 方法级 `method_capabilities` 是**可选**字段，未声明回退插件级（`registry/validate.go:165` 注释与 `invoke_capability.go` 的 `effectiveInvokeRequirement`）。
- 旧内核在**解析期**只接受 6 项特权能力 + 插件自有域，其它一律 `E_INVALID`（`validate.go:145-153`）。所以新词汇**必须先发内核**；旧内核会直接拒装。
- 新内核上，未声明新词汇的旧仓**行为完全不变**（6 项语义不动）。

| 路径 | 做法 | 24 仓是否必须同时改 | 代价 |
| --- | --- | --- | --- |
| **A. 默认放行 + 显式声明才收紧**（推荐） | 新内核接受"资源级声明"这一新动作名，但**未声明 = 沿用现有 6 项语义**；只有显式声明 scope 的仓才进入细粒度强制 | **否**，可逐仓、可长期并存 | 需内核先发 + 抬 `requires_kore`；旧仓零改动 |
| B. 默认拒绝（fail-closed） | 未声明的方法一律拒 | **是**，24 仓必须同一窗口内改造完，否则大面积误拒 | 24 次发版 + 一次性断崖式升级，风险集中 |
| C. 不改协议，只把现有 6 项真正强制 | 不引入新词汇，仅让授权侧生效 | **否**，0 仓改造 | 安全性提升有限（仍然只有 read/admin 两档） |

结论：**"逐仓渐进"成立的条件是选 A**，且必须接受"默认语义不变"。选 B 则"24 仓同时改"不是流程选择，而是**正确性要求**——这是本账里最贵的一条分叉。

---

## 2. 账二：内核侧改造量

现状已落地（估算 700–1,000 行）：`registry/validate.go`(318) / `registry/manifest.go`(231) / `httpapi/invoke_capability.go`(232) / `installer/record.go`(194) / `supervisor/hello.go`(198) / `store/audit.go` / `httpapi/middleware.go`。

| # | 项 | 现状 | 更细粒度的增量 | 估算行数 | 新端点 | ADR | 原子块 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 1 | 声明解析与校验 | 6 项白名单 + 自有域；`method_capabilities` ≤64；三处校验 | 资源级词汇的语法/归一化/范围解析；白名单扩容 | 80–150 | 否 | **是**（协议面） | **A1** |
| 2 | SDK 校验器镜像 | `pluginapitest.CheckInfoJSON` 硬编码 6 项 | 同步新词汇，否则 24 仓测试先红 | 60–120 | 否 | 否 | **A1** |
| 3 | 授予（落库 + 升级 diff） | `pluginRecord.Capabilities` 落盘（安装时复制声明）；**无独立"用户确认"记录**，`granted_capabilities` 只是清单副本 | 版本化授权记录（声明 sha + 确认时间）、enable 时"新增能力需重新确认"、`E_CONFLICT` 路径 | 120–200 | **是**（`GET/PUT /plugins/{id}/capabilities`） | **是**（授予语义） | **A2** |
| 4 | 运行期强制（HTTP invoke） | 只看路径 + 内存清单，无需读 body | 资源级需读请求参数才能判断"动哪个路径/端口"，**鉴权必须移到参数解析之后** | 120–220 | 否 | 否 | **A1** |
| 5 | 强制（bus / 通道） | `channel.go` 四关（bearer + peercred uid/pid + `system:admin`） | 与 4 同口径，避免两条路径语义漂移 | 20–40 | 否 | 否 | A1 |
| 6 | 强制（supervisor 握手） | hello `capabilities` 必须是清单子集 | 资源级同样做子集/收窄校验 | 10–20 | 否 | 否 | A1 |
| 7 | 强制（系统调用级） | 未做；低权用户 + cgroup + socket 权限（ADR-0018） | Landlock/seccomp 仅 Linux，与 Tier B 冲突；**建议不做**，写入降级矩阵 | 0（本版） | 否 | 否（矩阵更新） | — |
| 8 | 审计（写入 + 保留） | `capability.denied` 已写；`invoke` 写/admin 类审计；1s/10 次 burst 合并 | 新增资源级拒绝 action；**deny 路径无合并**，需补窗口合并 | 40–80 | 否 | 否 | **A3** |
| 9 | 审计保留期 | 文档写 90 天，**代码无删除路径**（DATA-MODEL 自认"当前未实现"） | 按龄清理 + 容量上限 | 60–100 | 否 | 否 | A3 |
| 10 | 管理 API | 无能力相关端点 | 见 #3 | 含在 3 | 是 | 是 | A2 |
| 11 | 面板（授予 / 查看） | `web/app.js` 已显示 `granted_capabilities`；`web/alerts.js` 已提示"让管理员在设置里为该插件授权"，**但该设置不存在** | 能力面板 + 授予/收窄交互 + 审计筛选；19 个懒加载视图模块之一 | 300–600（前端） | 否（复用 #3） | 否 | A2 |
| 12 | 错误码与降级矩阵 | 401/403 **共用 `E_UNAUTHORIZED`**；错误对象 `{code,message,detail}`，**无 `hint`** | 403 独立错误码 + `hint`（USABILITY 硬约束"错误要告诉用户怎么办"） | 20–40 | 否 | 否 | **A4** |
| 13 | 测试（e2e） | 已有 cap/method-cap 单测与 PoC | 安装→启用→调用→拒绝→审计全链路 + 三处校验一致性 | 300–500 | 否 | 否 | A1/A2 |

**原子块（拆开就是半成品）**：

- **A1 = 解析 + SDK + 四处强制点**。只改解析不改强制 = 声明了但没人查；只改强制不改解析 = 新词汇装不进去；SDK 不同步 = 24 仓测试先红，发布链断裂。
- **A2 = 授予记录 + enable 升级 diff + 拒绝提示/面板**。缺任何一个，"授予"就仍是纸面条款（现状正是如此）。
- **A3 = 审计 action + deny 合并 + 保留期**。缺合并 → 误拒会把审计库打爆（见账三）。
- **A4 = 403 独立码 + `hint` + UI 展示**。缺了直接违反项目"错误给怎么办"的硬约束。

---

## 3. 账三：运行期与运维成本

| 维度 | 事实 | 代价 | 口径 |
| --- | --- | --- | --- |
| 每次 invoke 校验 | 能力查内存清单（`catalog.Manifest`），两次拷贝（`append` / `maps.Clone`）；**仓库内 `func Benchmark` 数量为 0** | 量级应 <10 µs、2 次小分配；**未实测，不得写进承诺** | 需实测 |
| 误拒排障 | 401（未登录）与 403（能力不足）**同为 `E_UNAUTHORIZED`**；message 只有"该方法需要 X 权限"，无 `hint`；UI 提示"在设置里授权"但**设置不存在** | 用户无法自解释；工单会指向不存在的入口 → 违反 USABILITY "错误给怎么办" | 确定 |
| 审计写放大 | 每次拒绝 = 1 条 audit（bbolt `Update`，`NoSync:false` 即 fsync）+ 1 条 alert（`PutAlert` 再读改写）；**deny 路径无 burst 合并**（合并只覆盖 `recordInvokeAudit`）；audit 保留 90 天**未实现** | 默认拒绝后，一个配置错的插件每次调用 = 2 次同步落盘且库无上限增长。本会话刚遇到"每次鉴权写一次盘"，这是同一模式 | 确定（代码） / 需实测（QPS 与日增字节） |
| 热路径分配 | `PluginCapabilityDeclaration` 每次请求返回切片/map 副本 | 高 QPS 下 GC 压力需实测；可改只读视图零拷贝 | 需实测 |

**基准测试思路（不编数字，先给方法）**：

1. 基线：`go test -run=^$ -bench=BenchmarkInvoke -benchmem ./internal/core/httpapi/`，构造 fake backend + 已装配 auth，分别测 `capability=nil`（关闭校验）与 `capability=6 项`。
2. 方法级命中路径单独测（map 查找 + `fullMethodName` 字符串拼接）。
3. 观察 `allocs/op` 与 `B/op`，目标：校验层增量 ≤2 allocs/op；超出就把声明缓存成不可变视图。
4. 审计路径单独测：`PutAudit` 的 p99 延迟（fsync 主导），在 tmpfs 与 ext4 各测一次——差异会说明"写放大"到底是不是磁盘问题。

---

## 4. 最小可行切法（20% 工作换 80% 收益）

**先做（4 项，估 2–3 人日）**：

1. **让授权侧真的生效**：当前单管理员模式下 `CapabilityResolver` 对任意有效会话返回 6 项全权，检查**在生产路径恒通过**（代码注释自认）。接通会话 capability（登录时按角色给 read/admin）→ 现有 264 条方法级声明立刻产生真实约束力。**0 仓改造。**
2. **403 独立错误码 + `hint`**：把"未登录"与"能力不足"分开，hint 写清"联系管理员授予 `<capability>`"。同时删掉/实现 UI 里"在设置里授权"的假承诺。**~60 行 + 文案。**
3. **拒绝路径合并 + 审计容量上限**：把 deny 审计并入 1s/10 次窗口，alert 只留计数；给 audit bucket 加按龄/按量清理。**~120 行，堵住写放大。**
4. **3 个高危仓试点资源级 scope**（建议 `file` / `site` / `container`，覆盖路径写、端口绑、容器管理）：只做解析 + invoke 参数级校验 + 拒绝提示，不做 UI、不改其余 21 仓、不发 SDK。**~400–600 行，试点验证语义。**

**明确不做（省下的就是那 80% 成本）**：

- ❌ 不做 24 仓全量重映射与重发版 → 省 24 次发版、1 次索引重签、~600 个叶子动作、7–9 人日。
- ❌ 不发 SDK 新版本（试点词汇只在内核侧接受）→ 避免 24 仓 `go.mod` 连锁 bump 与 proxy 延迟卡点。
- ❌ 不做授予 UI / 新端点（先用 CLI + 审计可见）→ 省 300–600 行前端与 1 个 ADR。
- ❌ 不做系统调用级强制（Landlock/seccomp）→ 与 Tier B 降级矩阵冲突，收益/成本比最差。
- ❌ 不做多用户 RBAC（G-11 明确不做）→ 会话能力只做 admin/read 两档。

**放弃的收益**：资源级 scope 只覆盖 3 个仓；未试点仓仍是 read/admin 两档。**换来的是**：存量声明立即生效、误拒可解释、写放大可控、且不触发 24 仓版本地震。

---

## 5. 我认为最容易被低估的一项成本

**不是发版次数，而是"SDK 版本连锁 + dist sha 三重耦合"把单仓改造变成不可并行的关键路径。**

三重耦合都写在既有流程里：① `info.json` 与 `manifest.json` 的 `capabilities` 必须逐字一致（dist 目标硬校验）；② `size_bytes` 是自指字段，dist 要迭代到固定点（最多 10 轮）；③ 二进制 build info 记录 SDK module 版本，bump 依赖会让二进制字节变 → sha 再变 → 必须再 bump。

于是"给插件加一条权限声明"的真实路径是：**SDK 发布（等 proxy 索引）→ 24 仓 bump 依赖 → 重新 dist（sha 变）→ 24 次 bump/发版 → 索引导入 96 处字段 + 47 条预设 pin → 重签**。任何一环想省，都会撞上"同 `id@version` 只允许一个 sha"的 P0 规则。这也解释了为什么 §4 的第一条建议是**不发 SDK、不改 24 仓**——它把整条关键路径直接删掉了。

排第二的是**审计写放大**：拒绝从"异常"变成"常态"后，每次拒绝 2 次同步落盘且审计库无上限，这与本会话刚踩过的"每次鉴权写一次盘"是同一个模式；它不会在功能验收时暴露，只会在长期运行后以磁盘/延迟的形式出现。

---

## 附：核对方式

- 仓统计：遍历 `../kore-plugin-*/info.json` 与 `manifest.json`（脚本一次性执行，未留文件）。
- 内核：`internal/core/registry/validate.go`、`httpapi/invoke_capability.go`、`installer/record.go`、`supervisor/hello.go`、`store/audit.go`、`httpapi/audit_http.go`。
- 流程：`docs/RELEASE.md` §1/§2/§2.2/§3、`kore-plugins/scripts/sign-index.sh`、`index/plugins.json`、`index/versions.lock.json`、`presets/*.json`。
- 约束：`docs/USABILITY.md`（错误三件套）、`docs/DATA-MODEL.md`（审计保留与写放大口径）、`docs/SECURITY.md` §5、`docs/DECISIONS/0018/0042`。
