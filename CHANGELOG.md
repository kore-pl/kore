# Changelog

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-11-28

> 本次是 **perf**（性能修复），按 semver 为 patch。修复动机如实记录：真 `capability.denied` 路径存在
> 1:1 审计写放大（1 条审计 + 1 次告警读改写事务/拒绝），并发 16 拒绝实测 p95=158ms，**击穿 API
> p95 ≤ 50ms 硬红线**（`docs/V1-GOALS.md` / `docs/PLAN.md` / `docs/ROADMAP.md`），是认证后低权 DoS 向量。
> 不是新功能，也不宣称超越竞品——目标只是回到自身红线内。

### Performance

- **审计写放大优化**：`capability.denied` 出口接入突发合并器——同一 `subject+plugin+target+capability+reason`
  的 1s 窗口内前 10 条逐条审计，第 11 条起合并为 detail 带 `count`/`window_ms`/`first_at`/`last_at`
  的记录；单窗口聚合上限 `MAX_MERGE=1000` 后转逐条（合并不掩盖持续攻击）。纯内存 `sync.Mutex` +
  惰性 sweep，零 goroutine / ticker（G-19）。审计记录**不新增顶层字段、不升 schema**，旧记录兼容；
  web/audit.js 的通用 `detailText` 摊平即可显示，前端零改动。
- **告警同源聚合**：`noteDeniedAlert` 与审计共用同一突发窗口判断，窗口触发点一次 `PutAlertCounted(n)`
  累加 n 次拒绝计数，替代每拒绝一次一次 `PutAlert` 读改写事务 + fsync；通知通道同点派发一次，消除通知风暴。
- **审计按量上限**：新增 `audit.max_records`（默认 100000，0 关闭），内置 `audit.clean` 任务在按龄清理后
  从最旧端删除超额记录，单次受 `audit.clean_batch` 限制；删除原因（`trim_deleted`）写审计可追溯，
  封住高频拒绝的磁盘 DoS 维度。
- **内核版本 0.1.2 → 0.1.3**：`Makefile` 的 `VERSION`、`cmd/kored/main.go` 内置默认值与 `docs/CORE.md`
  版本基线同步；0.1.3 < 0.2.0 仍落在 24 仓 `requires_kore` 上界内，`make version-check` 不阻断。

## [0.1.2] - 2026-11-27

> **版本口径（如实记录，不隐瞒张力）**：本次是 **feat**，按 semver 应为 **minor 0.2.0**；但 24 个插件仓的
> `info.json.requires_kore` 上界一律 `<0.2.0`（48/48 行零例外），内核升 0.2.0 会让全部插件在
> `make version-check` / 安装期 `E_UNSUPPORTED` 判定中被阻断。经生态兼容折中，**以 patch 0.1.2 发布**。
> 这是兼容性约束压过 semver 的例外，不是"本次没有新功能"。

### Added

- **API token 可选 IP / CIDR 绑定**：token 可声明 `allowed_cidrs`，仅放行来源 IP 命中这些 CIDR 的请求；
  `allowed_cidrs` 缺省 / 为空时行为与旧 token 完全一致——**向后兼容，旧 token 不限制来源**。
- **`PUT /api/v1/security/tokens/{id}`**：新增按 id 更新已有 token（用于调整 CIDR 绑定等属性）。内核
  HTTP API 端点计数由 72 增至 **73**（口径见 `docs/CORE.md` §2.4 / §12.2）。
- **静默自更新能力（ADR-0058 / ADR-0059，M1–M5）**：本机专用更新链落地——① **UDS-only 专用端点**
  `POST /api/v1/system/self-update`（独立于公开门与主 mux，`SO_PEERCRED` uid∈{0, kored 运行 uid} + 单一
  专用能力 `system:self_update`，不含 6 项 admin、不进会话能力集，审计 fail-closed；公开会话门零变化）；
  ② **进程内更新编排**（kored 自身直接调 installer / upgrade 原语，不经 HTTP、不自连接、不另起常驻进程）；
  ③ **M3 批量更新编排器**：读已验签索引算待更新项 → 按 `depends_on` 依赖序逐条调现有单条 store/install
  （download 分支）→ 复用 `reloadOne` 热重载 → 汇总 + 失败分诊，单条失败不整批回滚、失败项可单条重试且
  不 reload 失败项，**不新增对外 schema**（批量 `items[]` API 留完整期评估）；④ **scheduler 内置
  `update.check` 任务**（挂在唯一 ticker，不新增周期源）；⑤ **本地更新状态文件**
  `<state>/update-state.json`（0600、原子写、`changes.jsonl` 账本可回滚，全系统唯一安装目录外写入豁免）；
  ⑥ **用户显式启用的更新源**（默认关闭 / 源地址默认空）。**边界如实记录，不夸大**：更新源默认关闭，
  未显式启用时零出站（符合 G-10）；内置 `update.check` 默认禁用且 `IsOffline` 短路（离线零出站、零报错）；
  验签失败带 `requires_restart:true`、本次不更新；内核升级所需的 **root systemd 服务安装须在执行时单独确认**
  （设计口径授权 ≠ 执行授权，本能力不代授权）。口径逐条见 `docs/CORE.md` / `docs/DATA-MODEL.md` 对应段。

### Changed

- **内核版本 0.1.1 → 0.1.2**：`Makefile` 的 `VERSION`、`cmd/kored/main.go` 内置默认值与 `docs/CORE.md`
  版本基线同步；`make version-check` 实测确认 0.1.2 仍落在 24 仓 `requires_kore` 区间内，不触发上界阻断。
  版本基线沿革不变：`0.1.1` 仍是首个含 `file_write` 受控写的内核版本。

## [0.1.1] - 2026-11-26

开源工程标准化补齐：七语言（zh/en/es/fr/de/ru/pt）`DETAIL` 文档与 `locale/*.json`、README 语言切换行与 star 提示、Git Flow 分支模型与 SSH 签名约定、六语言 `SECURITY` 译文、`.github/dependabot.yml` 与 `CODEOWNERS`；无日语文件、无死链，JSON 与 `docs-check` 门禁通过。

> **发布资产口径（瘦包，2026-11-26）**：`kore` 仓 release 只挂 `kored` 静态二进制 + `checksums.txt`（见 `docs/OPEN-SOURCE.md` §8、`docs/REPOS.md` §7.3），**不是全跟踪树源码归档**。`dist/kore-0.1.1.tar.gz` 只打包这两个发布资产，不含 `.agents/verify/screenshots/` 等证据截图或运行态数据；tag 的 peeled sha 必须等于该包的构建 HEAD。

首个 MVP 版本，覆盖 M0（文档与骨架）与 M1（内核骨架 + 首个插件）。
**0.1.0 从未发布**（仓库与远端都没有内核 tag），首个发布版本直接定为 `0.1.1`：
它是首个含 `file_write` 受控写的内核版本，与插件 `requires_kore` 的下界自洽（见下）。

### Added

- **公开 SDK `pkg/pluginapi/v0.2.0`**（annotated tag，2026-11-24）：`file_write` 受控写协议（ADR-0052 K2/K3）——`FileWrite` 声明、`ValidateFileWrite`、`FileWritePrefixClasses`（当前唯一类别 `nginx.conf.d`）、`MaxFileWriteContentBytes`（256 KiB 硬顶）、nginx 片段指令 allowlist（`ValidateNginxVHost`）、`FileWriteOptionsWithDirs`（证书/口令目录注入）；root_action 变更账本字段 `writes_host` / `target` / `purge_op` 与结构化回滚白名单（ADR-0023 §3.4）。**纯加法**：新字段一律 `omitempty`，exec 动作的声明与请求形状不变，旧插件在新内核上行为不变；用 `file_write` 的插件依赖新内核 → 由 `requires_kore >=0.1.1` 表达，不是破坏性协议改动（协议仍是 `kore.plugin.v1`，不需要主版本递增）。
- **公开 SDK `pkg/pluginapi/v0.3.0`**（annotated tag，2026-11-24）：受控删除协议层（ADR-0053）——`FileDelete{prefix_class}` 声明、`ValidateFileDelete` / `ValidateFileDeleteTarget` / `FileDeletePath` / `ValidateFileDeleteRequest`，以及 `RootAction.FileDelete`（`json:"file_delete,omitempty"`，与 `file_write` 互斥、不得与 `argv` 并存）。**纯加法**：既有 `file_write` / exec 动作的声明与请求形状不变，`file_delete` 缺省时行为与 v0.2.0 完全一致，协议仍是 `kore.plugin.v1`——按 RELEASE.md §1「feat → minor +1」从 0.2.0 升 0.3.0，不是 breaking、不动主版本。用 `file_delete` 的插件依赖含该原语的内核，`requires_kore` 下界须覆盖首个含受控删除的内核版本（0.1.1）；`make version-check` 对 `file_write` / `file_delete` **分别**断言下界 ≥0.1.1（G-14）。
- **通知通道多路外发（ADR-0054 §5）**：告警除站内铃铛外，可按「来源 + 级别」推送到 Webhook（自定义请求头 / JSON 模板）、邮件（SMTP，STARTTLS/SSL/明文）、企业微信 / 钉钉 / 飞书群机器人（钉钉、飞书支持加签）。全部走标准库 `net/http` + `net/smtp`，未新增第三方依赖；新建通道默认未启用（先测试、再启用），密钥与口令只存进程内存、日志与投递记录只记脱敏主机名与失败原因。端点：`GET/POST /api/v1/webhook`、`PATCH/DELETE /api/v1/webhook/{id}`、`POST /api/v1/webhook/{id}/test`。
- **文档基线（M0）**：VISION / ARCHITECTURE / CORE / PLUGIN-PROTOCOL / RESOURCE-MODEL / DATA-MODEL / FRONTEND / SECURITY / ROADMAP / PLAN / GLOSSARY，以及 ADR 决策记录体系。
- **公开 SDK**：`pkg/pluginapi` 作为独立嵌套 module（根 `go.mod` 用 `replace => ./` 指向），插件只依赖该包。
- **内核六模块（M1）**：`config` / `store` / `auth` / `httpapi` / `registry` / `supervisor` 落地；`bus` / `installer` / `market` 由后续里程碑补齐。
- **内核定时任务（ADR-0019）**：新增 `internal/core/scheduler`（单一 ticker，30s 检查）——5 段表达式自写解析（零依赖）、`state.db` 的 `scheduler_tasks` / `scheduler_runs` 任务与执行记录、停机错过不补跑、同任务不并发、单任务超时；`cert_renew` 迁移为内置任务（`cert.renew_due`），G-19 白名单由"仅 `cert_renew`"泛化为"仅 `scheduler`"；新增 4 个 `system:admin` 端点（`GET/POST /api/v1/scheduler/tasks`、`POST .../{id}/run`、`DELETE .../{id}`）。
- **门禁体系**：`make check` 七段聚合门禁（docs-check / 依赖白名单 / 薄壳边界 / 跨仓库边界 / 口径唯一性 / 台账 / worktree 卫生）；本次新增第 8 段 `oss-check`。
- **i18n 骨架（中文为主，英文为辅；ADR-0021）**：新增 `web/i18n.js`（`t()` / `setLocale()` / `onChange()`，零依赖）与 `web/i18n/zh-CN.js`（52 键：18 项导航 + 分组/抽屉 + 通用组件 + 设置页）、`web/i18n/en-US.js`（对应英文，缺项回退中文）；导航标签、分组标题、「更多」抽屉、搜索入口与设置页语言选择器走 `t()`；默认 `zh-CN`、不猜浏览器语言，选择写 `localStorage`，`en-US` 切语言时才懒加载；`make frontend` 新增 i18n 两文件 gzip ≤ 3 KiB 硬校验。G-11 的 i18n 非目标同步收窄为「不做全量框架」，FRONTEND / VISION / USABILITY / PLUGIN-MATURITY 等同轮对齐。
- **门禁扩至 9 段**：新增第 9 段 `case-check`（大小写一致性：module 路径全小写、无同目录大小写冲突、插件 id 小写、文档 URL owner 小写）。
- **首个插件**：`kore-plugin-echo` 独立仓库，验证 `info.json` + `Makefile dist` + `CHANGELOG` 三件套与 pluginapi 调用链。
- **开源资产**：MIT `LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、披露政策 `SECURITY.md`、本 `CHANGELOG.md`、`.github/` CI 与 Issue/PR 模板、`make oss-check`。
- **仓库级开源资产补到 25 个兄弟仓**（24 个插件仓 + `kore-plugins`）：每仓九件套（`CONTRIBUTING` / `SECURITY` / `CODE_OF_CONDUCT` / `AGENTS` / PR 模板 / issue 模板三件 / `ci.yml` / README 开源段）；唯一真源 `scripts/plugin-templates/`（`plugin-repo/` + `index-repo/`），配套 `scripts/plugin-oss-sync.sh`（幂等渲染）与 `scripts/plugin-oss-check.sh`（跨仓校验），并接入 `make check` **第 13 段**作为阻断级门禁。
- **门禁扩至 13 段**：新增第 13 段 `plugin-oss-check`（逐仓校验 25 个兄弟仓九件套存在、README 标记块、`LICENSE` 与 `kore` 逐字一致、`ci.yml` 少触发）；`make check` 现在是 docs / 依赖与兼容基线 / 薄壳 / 跨仓 / 口径 / 台账 / worktree / oss / 大小写 / 首屏 / 零侵入 / 明文凭据 / 插件仓九件套 13 段。

### Changed
- **受控删除原语 `file_delete`（ADR-0053，新增）**：补上「内核只有受控写、没有受控删除」的缺口——`site` 迁移到 `file_write` 后建站走通道，但删站/停用/启用仍靠目录内 `os.Remove` / `os.Rename`，装 root 后 `kore-site` 对 `/etc/nginx/conf.d/` 无写权限，三条全 DAC 失败。新增协议声明 `file_delete{prefix_class}`（与 `file_write` 对称、二者互斥、不得带静态 `purge_op`）、`internal/core/filewrite.Delete`（校验 → 路径锁 → **删前**属主复核 → **强制备份**（失败即中止）→ 审计 fail-closed → unlink → fsync(dir)）、`privilege.executeFileDelete` 分派（不走 `os/exec`，未装配 `E_UNSUPPORTED` / 非 root `E_NEED_ROOT` / 带正文 `E_INVALID` / 目标不存在 `E_NOTFOUND`）与 `cmd/kored` 装配（与写共用 `<state>/backups`）。**删除不设 `irreversible`**：不可逆性由强制备份消解，账本 `purge_op` 恒为 `file.restore(备份, 原路径)`，不新增 purge kind。**否决**复用 `purge_op`（无类别约束，等于把任意路径删除器发给插件）与写空片段（协议拒空正文，且 nginx 仍 include，文件还在）。测试覆盖通道成功 + 审计 begin/end + 备份内容完整 + `purge_op` 形状、非 root、删他人片段、删不存在、带正文、未装配，并以「备份失败必须中止」做反例自证。


- **内核 `VERSION` 0.1.0 → 0.1.1（G-14 自洽）**：`Makefile` 的 `VERSION` 与 `cmd/kored/main.go` 的内置默认值都提到 0.1.1，与 `kore-plugin-site` 的 `requires_kore`（`>=0.1.1 <0.2.0`）对齐——此前内核自称 0.1.0、却让自己的插件声明只接受 ≥0.1.1，安装期必然 `E_UNSUPPORTED`。新增 `make version-check`（G-14 断言：`VERSION` ↔ `main.go` 默认值 ↔ 24 个插件 `requires_kore` 区间，`file_write` 插件下界必须 ≥0.1.1），并用反例自证（把 `VERSION` 回填 0.1.0 → site 一行 `[FAIL]`、exit 2）。文档同步：`VISION` / `ARCHITECTURE` / `CORE` 的版本基线、`REPOS §5` 的兼容矩阵注记。
- **特权动作改为内核直接执行（ADR-0049）**：移除 `systemd-run` / polkit 中间层，`internal/core/privilege` 用 `os/exec` 直接执行固定 argv（不经 shell、`LC_ALL=C`、1 MiB 输出截断不变），新增 `internal/platform/procgroup{,_unix,_other}.go` 收口 `Setpgid` + `kill(-pgid, SIGKILL)`（超时 / 取消回收整棵进程树，非 Unix 显式 `E_UPSTREAM` 拒绝，禁止静默降级）。**两个缺陷同时修复**：`exit_code` 改为透传被调命令真实退出码（`exit 42` → 42，不再是中间层退出码）；无 systemd 宿主（容器 / Alpine / Tier B）不再返回 `E_NO_SYSTEMD`（常量保留做协议兼容、不再触发）。保留项不变：ADR-0022 三级形状校验、`ValidateAction` + `info.json` 声明 + 安装确认、`Root()` 判定、不可逆动作一次性 confirm 令牌、审计 fail-closed、插件降权 + `Credential` 清空补充组。测试覆盖真实退出码、父子进程组回收（`pgrep -g`）、无 systemd 执行，并用「去掉 `Setpgid` → 用例 FAIL」做反例自证。
- **根文档补到逐插件粒度**：`docs/OPEN-SOURCE.md` 新增「多仓开源资产矩阵」（26 仓 × 10 类资产）、「插件仓开源资产规范（九件套）」、「名称与标识」、「贡献者路径（good first issue / 插件作者 / 维护者）」，并把安全时限统一到根 `SECURITY.md` 的 **72 小时确认 / 90 天协调披露**（删除旧的 48h / 7d / 30d 表述）；`docs/PLUGIN-CATALOG.md` 新增 §15 逐插件开源信息（20 个产品插件 × 仓库 / Issues / Releases / 维护状态 / 验证方式，`echo` 单列为验证件不参与评级）；`docs/REPOS.md` 仓库清单加「开源资产」列并新增规则 **R9 开源资产自包含**，发布流程补每仓 release 资产（`tar.gz` + `.sha256`）与 CI tag 触发说明；`docs/PLUGIN-SDK.md` 新增九件套清单；`docs/README.md`、根 `README.md`、`CONTRIBUTING.md`（10 段 → 13 段）、`AGENTS.md` G-26、`.agents/QUALITY-GATES.md` G19、`.github/PULL_REQUEST_TEMPLATE.md`、`.github/workflows/ci.yml`（job 名 8 → 13 segments）同轮对齐。
- **CI 少触发口径统一**：26 个仓（`kore` + 24 插件仓 + `kore-plugins`）都配 CI，但只在 `push main` / tag / `pull_request` / `workflow_dispatch` 时跑；日常 feature 分支 push 不跑，Gitea 不配 CI。日常反馈以本地 `make check`（13 段）为主，CI 只做合入兜底；`make idle` / `make budget-check` 需要真实进程，仍归本地与里程碑门禁。
- **仓库归属与权威源（ADR-0024）**：文档区分「版权人 `pengtang1024`」与「仓库归属 `kore-pl` 组织」，明确自建 Gitea `gitea.iouf.cn/kore-pl` 为唯一权威源、GitHub / gitee 为镜像，issue / PR 只在 Gitea 更新；module 路径保持 `github.com/pengtang1024/...` 不变。

### Fixed

- **`make version-check` 只断言 `file_write`、漏掉第二个受控原语 `file_delete`（2026-11-24）**：`site` 的 `vhost-delete` 已声明 `file_delete`，但 G-14 门禁只扫描 `"file_write":`，一个下界仍是 `>=0.1.0` 的插件声明受控删除也能过门禁，装到不含该原语的内核上才 `E_INVALID`——与 2026-11-24 `file_write` 事故同型（判据只覆盖第一个原语）。补 `/"file_delete"[ \t]*:/ { fd[FILENAME]=1 }` 检测与「下界 ≥0.1.1」断言（文案：受控删除自首个含该原语的内核版本起支持），OK 行标注 `← file_delete`；同时逐个核实 `writes_host` / `purge_op` / `irreversible` 属 0.1.1 边界之前的 root_action 基线协议，**不另加断言**（给它们造 ≥0.1.1 会误判 4 个声明 `irreversible` 的插件）。用隔离副本四例自证：`file_delete`+`>=0.1.0` → `[FAIL]` exit 2 / `file_write`+`>=0.1.0` → exit 2（既有断言未放宽）/ 删掉 `vhost-delete`+`>=0.1.0` → exit 0 / `file_delete`+`>=0.1.1` → exit 0。
- **HTTP 业务方法名校验（2026-11-23）**：`validateMethod` 的方法段此前只允许小写，插件按自身命名声明的方法（如 `site.bindSSL` / `site.setRewrite`）经 `POST /api/v1/invoke` 会被 400 拒绝；现放宽为「段首小写、段内允许 camelCase」，与插件方法注册表一致，既有纯小写方法不受影响。
- **SDK 发布链（2026-11-22）**：`pkg/pluginapi/v0.1.0` 打 tag 时 `go.mod` 仍是旧 module 路径（`github.com/kore-project/...`），干净目录无法消费；发布物不可改写（proxy / sumdb 已缓存），改为 `retract v0.1.0` 并发布 `pkg/pluginapi/v0.1.1`，`kore-plugin-echo` 同步升到 `v0.1.1`。

### Security

- 安全漏洞披露流程见根 [SECURITY.md](SECURITY.md)；设计文档见 [docs/SECURITY.md](docs/SECURITY.md)。

[0.1.1]: https://github.com/kore-pl/kore/releases/tag/v0.1.1
