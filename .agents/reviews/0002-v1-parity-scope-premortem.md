> 状态: draft · 归属: red-team · 更新: 2026-11-21 · 里程碑: M2

# 0002 · v1 对标 scope 事前验尸

## 0. 判定基线与方法

假设 v1.0（M4）已经失败：20 个插件仓库都发了 tag，商店能装，但对标没成立——要么用户第一小时就退回宝塔，要么资源/兼容/信任在真实环境里崩掉。本文从死因倒推，只写能被命令、数据或评审问题证伪的条目。

判定基线（2026-11-21 22:10 快照）：[ROADMAP.md](../../docs/ROADMAP.md) §1 v1.0 gate、[FEATURE-PARITY.md](../../docs/FEATURE-PARITY.md) 24 行对标矩阵、[PLUGIN-CATALOG.md](../../docs/PLUGIN-CATALOG.md) 20 个插件与三态生命周期、[RESOURCE-MODEL.md](../../docs/RESOURCE-MODEL.md) §2.1 预设预算、[ADR-0012](../../docs/DECISIONS/0012-scenario-presets-and-store.md) 商店与预设。

口径说明：任务书的 48 MiB 合计预算在评审期间已被文档改为 **24 MiB / 同时常驻 ≤3 / 单插件 ≤12 MiB**（[AGENTS.md](../../AGENTS.md) G-03），但 [FEATURE-PARITY.md](../../docs/FEATURE-PARITY.md) §6 仍写 ≤48 MiB。本文以 24 MiB 为主口径、48 MiB 作对照；两者都算一遍，结论方向不变。

## 1. Scope 死因清单

### S-01 4–7 人日/插件是按"仓库脚手架"计价，不是按"可被商店安装的产品"计价
- 触发条件：按 ROADMAP §6 把 site / runtime-php / db-mysql / waf 这类要改宿主配置、处理并发与回滚的插件当 CRUD 排期。
- 早期信号：M2 第 15 个工作日 site 仍只完成 install + hello，invoke / rollback / 前端未闭环；单插件实际人日 ≥12；Sprint 燃尽连续两轮为 0。
- 影响：M2–M4 全部顺延；锚点⑤（最短路径）先崩，因为错误处理与 UI 最先被砍；v1.0 gate 无法按期取证。
- 预案：按复杂度分三档重估——简单 ops 8–12、中等 12–20、复杂 20–35 人日；20 个插件合计 288–488，加内核/商店/平台 144–162，v1 总盘 432–650 人日（含迁移/面板升级等隐性项 472–730）。对照 ROADMAP 224–302，是 1.4–2.9 倍（中位 2.1 倍）；单插件 4–7 对 8–35，差 2–6 倍。排期只承诺上界。
- 检查方式：统计 PLUGIN-CATALOG 的插件表行数（应为 20）；评审问题："site / runtime-php / db-mysql 从开工到通过安装→调用→回滚→卸载四步，实际各用了多少人日？与 4–7 的差额记在哪个 Sprint？"

### S-02 "对标"只对了可见功能，用户拿来判断专业版的十项隐性能力不在矩阵里
- 触发条件：以 FEATURE-PARITY 的 24 行为完成定义，未纳入多用户、面板自升级、迁移导入、审计报表、模板市场、数据库 Web 管理、2FA/IP 白名单、API token、监控历史报表、厂商云存储。
- 早期信号：第 2 个月首个外部试用者问"怎么加第二个管理员""怎么从宝塔迁站点""面板怎么升级"，三个问题都只能回答"暂不支持"。
- 影响：锚点④（开放）被解释成"功能少"，v1.0 "对标专业版"的对外承诺失信；商店转化率低于 10%。
- 预案：把这十项写进 FEATURE-PARITY 新增章节，每项给"不做 + 理由 + 用户可见替代"；README 与商店首屏同步"明确不做"清单，禁止只写"对标"不写差异。
- 检查方式：`for t in 多用户 面板升级 迁移导入 审计报表 模板市场; do grep -q "$t" docs/FEATURE-PARITY.md || echo MISSING:$t; done` 必须无 MISSING；用户测试问上述三问，记录"不能回答"的比例，目标 0。

### S-03 预设承诺"一次装齐"，但目录明确不内置 MySQL/PHP 二进制，web-pro 装完仍建不了站
- 触发条件：按 ROADMAP M2"8 个预设一键安装"验收，在干净 VPS（无 php/mysql/nginx）上执行 `kored install --scenario web-pro --yes`，再建站。
- 早期信号：安装全部成功，创建站点时报 `php-fpm not found` / `mysqld not found`；验收记录把"插件齐备"当成"可建站"。
- 影响：锚点⑤首小时路径断裂；用户判定"装了个空壳"；这是对标印象的首要原因。
- 预案：二选一并写 ADR——① 预设安装前跑 `kored doctor --scenario` 做宿主依赖预检，缺运行时明确列出安装命令并阻止"安装成功"；② 把 runtime/db 插件扩展为"安装宿主运行时"（会显著增加权限与失败面，不建议 v1）。同时把"预设 = 插件组合"改成"预设 = 插件组合 + 宿主前置条件"。
- 检查方式：干净容器（无 php/mysql）跑 `kored install --scenario web-pro --yes && kored doctor --scenario`；未通过预检却返回 0 即判失败。

### S-04 资源算术按"安装数"分摊必然崩：48/22=2.18 MiB 低于空 Go 进程，24 MiB 又只够 3 个
- 触发条件：把"常驻合计 48 MiB ÷ 22 个插件"当成每插件预算；或按当前 24 MiB 让 site(10)+monitor(6)+cron(4) 三个 resident 常驻。
- 早期信号：空载 `ps` 显示一个只做 UDS + JSON 的 Go 进程已 2.5–3.5 MiB；plugin 加业务后 6–10 MiB；3 个 resident 合计 20 MiB 时，任何一个 lazy 插件被唤醒就变成第 4 个活跃进程，破"同时活跃 ≤3"。
- 影响：G-03/G-18 从 M2 起红；预设"full"顶格 24 MiB 没有任何余量；用户开一个数据库页面就要踢掉 site 或 monitor。
- 预案：预算按"同时活跃"而非"已安装"计；resident ≤2 + 1 个瞬时槽给 lazy/oneshot（合计 ≤24 MiB），而不是 3 个 resident 吃光配额；若恢复 48 MiB，最多 5 个活跃（site 10 + cron 4 + monitor 6 + logs 6 + firewall 6 = 32，再留 16 余量）。
- 检查方式：`grep -n '同时常驻插件数' docs/RESOURCE-MODEL.md` 看是否写"resident + 活跃 lazy"；空载跑 `pgrep -fc '/plugins/'` 应 ≤3；再触发一个 lazy 插件，计数必须仍 ≤3，否则配额定义自相矛盾。

### S-05 8 预设 × 20 插件 × 版本区间 = 组合爆炸；两份预算/场景文档已经对不上
- 触发条件：预设按具体插件 id + 版本区间写死，embed 快照随内核发版冻结；索引后续下架/改版本区间；实现者同时读 RESOURCE-MODEL 的预算表与 SCENARIOS 的插件清单。
- 早期信号：[RESOURCE-MODEL.md](../../docs/RESOURCE-MODEL.md) §2.1 预算表用 `edge` / `db` / `gateway` / `sec`，这四个 id 在 PLUGIN-CATALOG 与 SCENARIOS 里都不存在（SCENARIOS 用 `site`/`waf`/`firewall`/`db-mysql`）；同一 `web-pro`，预算表是 site(10)+edge(8)=18，SCENARIOS 是 site(10)+cron(2)+monitor(6)=18，而目录里 `cron` 标 4 MiB——三处数字不一致。
- 影响：预设 JSON 一旦照错表写，G-18 在 M2 第一天就红；更坏的是"装完就互相不兼容"会成为默认，因为没人知道哪份是唯一真源。
- 预案：预设只引用"能力包"（如 `web-stack`、`db-stack`），由索引在发布时解析成 `presets.lock.json` 并锁精确版本；kore 安装只认 lock，不认浮动区间；`presets-check` 做 dry-run 解析并要求唯一解。
- 检查方式：`bash scripts/presets-check.sh`（M2 落地）对 8 个预设逐个解析；出现未知 id、无解、或多解即 FAIL；再人为下架一个被引用插件，安装必须给出"预设不可用 + 替代版本"而不是 500。

### S-06 商店在 M2–M4 是无签名、无审核、官方/第三方混排的信任空窗
- 触发条件：索引仓库或镜像源被篡改；第三方插件用近似 id（`kore-plugin-nginx` vs `nginx-plus`）；包被替换但 sha256 与索引一起被改。
- 早期信号：`index/plugins.json` 无签名字段；`store.mirror` 只校验 sha256，而 sha256 来自同一份可被改的索引；商店 UI 无"官方/第三方"标识。
- 影响：锚点④"开放"变成"无信任根"；一次镜像投毒即可在用户机器上以插件权限执行任意代码；M4 才做签名意味着前两个发布周期无签名保护。
- 预案：M2 起先做"索引级签名"（ed25519/minisign 公钥 embed 进 kore，签 `plugins.json`），包级签名仍留 M4；`info.json` 增加 `publisher` / `official` / `source_repo`，商店与 API 显示三色徽章；官方插件走 allowlist，第三方默认折叠并二次确认能力清单。
- 检查方式：`for t in publisher official source_repo signature; do grep -q "$t" docs/PLUGIN-CATALOG.md docs/DECISIONS/0012-scenario-presets-and-store.md || echo MISSING:$t; done` 必须无 MISSING；`openssl pkeyutl -verify`（或 minisign）校验索引签名，改一个字节必须失败；`curl /api/v1/store/plugins` 每条必须带 `official` 字段。

### S-07 20 仓库 × 5 构建目标 × N/N-1 kore，CI 与"最后一个兼容版本"维护成本被低估
- 触发条件：每个插件仓库独立 CI，每次 kore minor 发布都要验证 N/N-1；20 个仓库各自维护兼容分支。
- 早期信号：单次发布 CI 任务数 = 20 仓库 × 5 目标 × 2 版本 = 200 个构建；再加 3 平台 smoke 至少 60 个运行任务；发布前排队 >2 小时。
- 影响：M3 起发版节奏被 CI 拖慢；"最后一个兼容版本"没人维护，旧插件在新 kore 上静默失败。
- 预案：发布改为"月度 release train"——kore 与 20 插件按同一 lock 发一次，兼容矩阵只验证 N/N-1 的"安装/hello/invoke"三链路，不做全量单测；插件仓库 PR 只跑 linux/amd64 构建 + 单测，5 目标交叉编译只在 tag 跑。
- 检查方式：统计一次 tag 的 CI job 数与总时长（`gh run list` / Gitea API）；目标 ≤80 job、≤45 分钟；`make compat-info` 必须打印本次覆盖的 kore N/N-1 与插件版本表。

### S-08 单管理员是产品级差异，但对外仍写"对标专业版"，用户会直接判定不对标
- 触发条件：README / 官网 / 商店文案继续用"对标宝塔/1Panel 专业版"，而 FEATURE-PARITY 已把多用户写成"不做"。
- 早期信号：首个团队用户问"能否给运维只读账号"；销售/文档无法指出"哪里写了不做多用户"；README 中"多用户"命中 0。
- 影响：锚点④（开放）被读成"缺功能"；对标承诺与产品能力不一致，属于对外表述风险。
- 预案：README 增加"明确不做"一节（多用户/RBAC、云查杀、集群、短信告警、拖拽建站），FEATURE-PARITY 每行"不做"必须在 README 有对应句；对外统一用"覆盖 22 项能力域，其中 6 项明确不做"。
- 检查方式：`for t in 多用户 明确不做 RBAC; do grep -q "$t" README.md || echo MISSING:$t; done` 必须无 MISSING；`make parity-check` 校验 FEATURE-PARITY 的"不做"行在 README 均有映射，缺一即 FAIL。

### S-09 零常驻中间件的代价：没有队列，30 分钟硬上限 + 并发 2 + 队列 32 撑不住备份与批量升级
- 触发条件：100 GB 站点备份、20 插件批量升级、证书集中续期同时发生；按 RESOURCE-MODEL §5 单任务 30 分钟 SIGTERM、并发 2、队列 32。
- 早期信号：备份任务在 30:00 被 SIGKILL，返回 `E_UPSTREAM` 且无断点；批量升级排到第 11 个插件时用户关浏览器，任务状态丢失；cron 触发的备份因 kore 未运行而静默不执行。
- 影响：备份/升级这两个"专业版必备"能力在真实数据量下不可用；用户被迫回到命令行，锚点⑤失效。
- 预案：任务状态落 bbolt 的 `jobs` bucket，支持断点续跑与重启恢复；备份改为流式分片（每片独立可重试），不受 30 分钟总上限约束；批量升级用变更集 + 每插件独立 job，失败不回滚已成功的插件；cron 触发写宿主 systemd timer，不依赖 kore 常驻。
- 检查方式：`kill -9` 备份进程后重启，`kored jobs` 必须显示可续跑且校验和一致；20 插件批量升级中途杀主壳，重启后每个插件状态必须是 `old` 或 `new`，不允许 `half`。

### S-10 插件依赖只有 depends_on/conflicts 字段，没有 resolver 语义，环与多 provider 无定义
- 触发条件：site 依赖 runtime-php、backup 依赖 db-*、ssl 依赖 site；两个插件分别要求 runtime-php 的不同 major；同一能力有两个 provider。
- 早期信号：安装顺序靠人工；`depends_on` 只写 id 不写版本；`conflicts` 只覆盖端口；环（A→B→A）没有检测；卸载 site 时 backup 仍指向已删目录。
- 影响：预设安装随机失败；用户无法解释"为什么装不上"；G-18 只能校验 id 存在，校验不了可安装性。
- 预案：把依赖升级为"能力 + 版本区间"（`requires: ["site>=1.0 <2.0"]`），resolver 做拓扑排序 + 环检测 + 单 provider 约束；安装前输出 dry-run 计划（装什么、顺序、占用、冲突），用户确认后执行。
- 检查方式：`make preset-simulate` 对每个预设输出拓扑序；构造 A→B→A 的 fixture 必须报 `E_CONFLICT` 而不是栈溢出；两个 provider 同时存在时必须要求显式选择，不允许静默取第一个。

### S-11 20 插件同时升级没有事务边界，内核升级也没有插件兼容 preflight
- 触发条件：一次 release train 同时更新 20 个插件；第 10 个插件 hello 失败；或 kore 升 minor 后旧插件 `requires_kore` 不满足。
- 早期信号：升级脚本按列表顺序执行，失败即停，前 9 个已切换、后 11 个仍旧版；`kored upgrade` 没有 `--dry-run`；内核升级前不检查已装插件区间。
- 影响：用户处于"半升级"状态，回滚要人工逐个处理；内核升级后插件集体 `E_UNSUPPORTED`，面板不可用。
- 预案：每插件升级为原子操作（下载→校验→解包到 `<version>`→新进程 hello→切换指针→停旧→保留 N-1）；批量升级按变更集记录，失败只回滚当前插件；kore 升级前 `kored upgrade --dry-run` 必须列出所有不兼容插件并阻止升级。
- 检查方式：注入"第 10 个插件 hello 失败"，断言前 9 个为新版、第 10 个为旧版、第 11–20 个未动，且 `kored plugins` 无 `half` 状态；`kored upgrade --dry-run` 在存在不兼容插件时退出码非 0。

### S-12 20 插件 × 3 平台 × 4 发行版的 smoke 是 240 个组合，当前只定义了内核级矩阵
- 触发条件：把 M1/M2 的 `compat-smoke.sh` 直接套到每个插件仓库；每次发布全跑。
- 早期信号：CI 账单随插件数线性上涨；插件作者本地只测 Ubuntu；Alpine（musl/无 systemd）与 RHEL8（cgroup v1）的失败在发布前才暴露。
- 影响：M3/M4 发布周期从周变月；插件质量取决于"谁碰巧测了哪个发行版"。
- 预案：分层——L0 每 PR：linux/amd64 构建 + 单测；L1 每 tag：2 发行版（Ubuntu 22.04 / Debian 12）install→hello→invoke→uninstall；L2 每 release：核心 6 插件跑 4 发行版 + Alpine；L3 每季度：全矩阵 + Windows/macOS。非核心插件不进入 L2/L3。
- 检查方式：CI 配置中每个插件仓库必须有 `test-level` 字段；`make scope-matrix` 统计 L2 插件数，超过 6 即 FAIL；单次 release 的 smoke 任务数目标 ≤24。

### S-13 首小时迁移路径比宝塔长：没有导入器，20 个站点要手工重建
- 触发条件：宝塔用户带着 20 站点、5 数据库、证书、cron 迁移；kore 没有 `kored import`，只能新建站点、手工拷文件、重新签发证书。
- 早期信号：试用用户在"建第一个站"卡住 >45 分钟；迁移清单靠文档手抄；证书续期要重新走 ACME；cron 要逐条重写。
- 影响：锚点⑤（最短路径）与对标印象同时失守；用户在第 1 小时放弃，后续功能再多也不会看到。
- 预案：v1 至少提供 `kored import --from bt --dry-run`（站点/数据库/证书/cron 四类，输出差异清单），先做"导入计划"不做自动执行；同时把首小时 E2E 作为发布门禁（建站→HTTPS→备份→恢复 ≤20 分钟、≤15 步）。
- 检查方式：干净 VM 上跑 `time kored import --from bt --dry-run` 并比对 20 站点清单；首小时 E2E 脚本记录墙钟时间与点击数，超阈值即 FAIL。

### S-14 组织产能：6 个固定角色、一仓一 owner、同里程碑最多 4 仓库并行，20 个仓库至少 5 批
- 触发条件：按 BOARD"一仓一人"与"同里程碑 ≤4 插件仓库并行"排期；实际只有 lead + 5 个角色，且 lead 不写代码。
- 早期信号：插件轨道 owner 表出现同一人挂 4 个仓库；M3 的 10 个插件被压成 2 批，每批 5 个仍超 4；review 队列 >3 天。
- 影响：M3/M4 的 20 仓库在 3 个 Sprint 内不可能完成；"并行"只存在于文档，实际串行。
- 预案：要么把插件 owner 增至 4 人（与内核轨道分离），要么把 20 砍到 10（见 §3）；BOARD 增加"插件 owner 容量"字段，超过 4 个仓库/人即拒绝派发。
- 检查方式：`grep -c 'kore-plugin-' .agents/BOARD.md` 与 owner 列去重计数；`make scope-matrix` 输出每 Sprint 的并行仓库数，>4 即 FAIL；review 平均等待时间 >2 天即触发容量告警。

## 2. 对标诚实性审计

竞品列按公开功能页与用户输入整理，未逐项截图核验；对外文案前必须由 scribe 补证据，标 `*` 的格子需复核。

| 能力域 | 宝塔专业版有 | 1Panel 专业版有 | kore 计划 | 差异是否在文档明示 | 若不做的替代方案 |
| --- | --- | --- | --- | --- | --- |
| 多用户/RBAC/子账号 | 有* | 有* | 不做（单管理员 + audit） | FEATURE-PARITY 明示；README 未明示 | 共享管理员 + 审计；v1.1 评估只读 API token |
| 面板自身升级/回滚 | 有* | 有* | 无（手工换二进制） | 未明示 | `kored self-update` + N-1 回滚脚本（v1.1） |
| 迁移导入（宝塔/1Panel） | 有* | 有* | 无 | 未明示 | `kored import --from bt --dry-run`（v1 至少做计划） |
| 数据库 Web 管理 | 有（phpMyAdmin） | 有 | 无（仅实例管理） | 部分（FEATURE-PARITY 未列） | 商店第三方 adminer 插件或宿主工具链接 |
| 模板/应用市场 | 有* | 有* | app-deploy 3 模板，无市场 | 部分 | 模板仓库 + 社区模板（v1.1） |
| 监控历史报表 | 有* | 有* | monitor 实时阈值 + webhook/邮件 | 未明示 | bbolt 本地 rollup + CSV 导出（不引时序库） |
| 面板安全（2FA/IP 白名单/面板 SSL） | 有* | 有* | 仅口令 + CSRF + 限速 | 未明示 | TOTP + IP allowlist（v1.1） |
| API/自动化（token/webhook） | 有* | 有* | 无（session cookie / UDS CLI） | 未明示 | scoped API token（v1.1） |
| 厂商云存储（OSS/COS/七牛） | 有* | 有* | 仅 S3 兼容 | 部分（ADR-0012 写 S3） | 文档给 S3 兼容端点映射 |
| 站点统计/访问报表 | 有* | 有* | 无（logs tail） | 未明示 | 接宿主 GoAccess 或第三方 |
| 多语言 | 有* | 有* | 不做（i18n 非目标） | VISION 明示 | 中文 only，README 写明 |
| 容器管理 | 有* | 有（核心） | container 可选、默认不装 | 是（FEATURE-PARITY） | 可选插件，默认不装 |

审计结论：内部矩阵已经比旧版诚实，但"不做"只落在 draft 文档里，用户入口（README / 商店首屏 / 安装器）没有承接。**对标不是矩阵存在，是用户在决定是否安装的那一屏能看到差异。**

## 3. 如果只能砍一半功能

排序原则：先保五锚点（尤其③资源与⑤最短路径），再保"建站主动脉"，最后才保能力域数量。

1. **先砍广度：20 → 10 个插件，保建站与日常运维主动脉。** 保留 `site` `ssl` `runtime-php` `db-mysql` `file` `backup` `cron` `logs` `monitor` `firewall`；把 `runtime-node` `runtime-python` `db-postgres` `redis` `waf` `ssh-guard` `integrity` `app-deploy` `dns` `container` 推到 v1.1。底线：site+ssl+runtime-php+db-mysql+file+backup 六件必须同一条 E2E 通过；少一个就不是"能建站"。
2. **再砍平台承诺：v1.0 只承诺 Linux Tier A GA，macOS/Windows 标 preview。** 保留 5 目标交叉编译（成本低），但运行时验收只做 Linux + macOS 一条链路；Windows 的 AF_UNIX/SCM/Job Objects/HMAC 整体移到 v1.1。底线：preview 必须在 `system/info` 与安装器明示 `isolation=weak` / `cgroup=unlimited`，不得让用户以为等价。
3. **最后砍"专业版商业件"并换回迁移入口：** 砍 WAF/容器/DNS/app-deploy 的 v1 承诺，把省下的 20–30 人日投入 `kored import --from bt` 与首小时 E2E。底线：宁可少 6 个能力域，也要让"从宝塔迁 1 个站并签上 HTTPS"在 20 分钟内完成；否则功能再多也留不住迁移用户。

## 4. 预算算术重算

任务书口径：48 MiB ÷ 22 = 2.18 MiB/插件。这个数低于一个只做 UDS + JSON 的空 Go 进程（实测 2.5–3.5 MiB），更低于带业务/配置/ACME/S3 客户端的插件（6–10 MiB）。**"22 个插件平均 2.2 MiB"不是紧，是数学上不存在。**

| 口径 | 同时活跃上限 | 每插件可用均值 | 现实判定 |
| --- | --- | --- | --- |
| 48 MiB，22 个都常驻 | 22 | 2.18 MiB | 不可能：空 Go 进程就超 |
| 48 MiB，按声明值混搭 | 5–6 | 8–9.6 MiB | 可行，但需 site≤10 且其余≤8 |
| 24 MiB，3 个 resident | 3 | 8 MiB | 当前文档口径；site(10)+monitor(6)+cron(4)=20 可行 |
| 24 MiB，3 resident + 1 lazy | 4 | 6 MiB | **不可行**：配额定义已把活跃 lazy 计入 ≤3 |

当前真正的矛盾不是 48 还是 24，而是 [RESOURCE-MODEL.md](../../docs/RESOURCE-MODEL.md) §2 把"同时常驻插件数 ≤3（resident + 活跃 lazy）"和 [PLUGIN-CATALOG.md](../../docs/PLUGIN-CATALOG.md) §6 的 3 个 resident 放在一起：3 个 resident 已吃满配额，任何 lazy 插件一被唤醒就是第 4 个，只能驱逐 site/monitor/cron 之一；而 site 被驱逐后下次请求要冷启动 300 ms，正好违背它当 resident 的理由。

**可行上限：同时活跃 3 个，其中 resident ≤2，另 1 个槽留给 lazy/oneshot。** 理由：24 MiB / 3 = 8 MiB 均值；site(10) + monitor(6) = 16，瞬时槽 8；或 site(10) + cron(4) = 14，瞬时槽 10。若恢复 48 MiB，上限 5 个活跃（按声明值 32–40 MiB，留 8 MiB 峰值余量）。

48 MiB 要成立，必须同时满足：① 预算按"同时活跃"计，不按"已安装"计；② 每个 resident 实测 ≤8 MiB 且连续 60 s 中位数；③ 其余插件 lazy/oneshot 且空闲真退出；④ 预设只对"启用且 resident"求和；⑤ plugin 前端从磁盘按需加载，不进主壳；⑥ 三平台不共享硬预算（macOS/Windows 只观测）。另外必须披露：24 MiB 只是 kore 自身插件进程开销，**不含** nginx/php-fpm/mysqld 这些被管理进程——否则用户会拿 `free -m` 对账，认定虚假宣传。

## 5. 门禁增强提议

- **G-20 `make scope-matrix`**：解析 FEATURE-PARITY + PLUGIN-CATALOG + ROADMAP，输出"能力域 × 插件 id × 里程碑 × 平台 × 测试层级"覆盖表；任一能力域无插件/无里程碑、任一插件无 owner/无 lifecycle/无 RSS 预估即 FAIL。防 S-02/S-12/S-14。
- **G-21 `make preset-simulate`（扩 G-18）**：对 8 个预设做依赖解析、环检测、版本区间求解、resident 求和与瞬时槽检查；未知 id（例如照 RESOURCE-MODEL 预算表写成 `edge`/`db`/`gateway`/`sec`）、无解、多解、>24 MiB、>3 活跃均 FAIL。防 S-05/S-10。
- **G-22 `make store-trust`（扩 G-17）**：`info.json` 必填 `publisher` / `official` / `source_repo`；索引必须带 ed25519 签名且能被内嵌公钥验证；官方插件必须在 allowlist；第三方标 official 直接 FAIL。防 S-06。
- **G-23 `make upgrade-rehearse`**：20 插件批量升级注入第 10 个 hello 失败，断言前 9 新、第 10 旧、其余未动、无 `half` 状态；`kored upgrade --dry-run` 在 `requires_kore` 不满足时非 0。防 S-11。
- **G-24 `make first-hour`**：干净 VM 跑 minimal→web-lite→建站→HTTPS→备份→恢复，记录墙钟与点击数；>20 分钟或 >15 步 FAIL。只在 release 前跑 Ubuntu 22.04 + Debian 12 两台，不进每 PR。防 S-03/S-13。
- **G-25 `make budget-sot`**（与现有 `make budget-check` 分工：后者测运行时，前者测文档口径）：预算单一真源校验——`grep -rn '常驻合计.*≤.*MiB' docs/*.md AGENTS.md` 只允许命中 RESOURCE-MODEL §2 与 README 摘要两处，第三处即 FAIL；其余文档必须链接引用。当前 FEATURE-PARITY §6 的 48 MiB 就是现成反例。防 S-04。

## 6. 对 lead 的三个问题

### Q-1 v1 是"20 个插件全覆盖"还是"10 个插件做穿"？
- 选项 A：维持 20 个，按 432–650 人日重排，M4 延后 2–3 个月，资源/测试/文档同步扩容。
- 选项 B：v1 只做 §3 的 10 个，其余进 v1.1；对标矩阵按剩余插件重算覆盖，主动脉 6 项必须全覆盖，其余标"延后"并给替代。
- 建议：B。理由：10 个已能证明"建站 + 备份 + 日常运维"这条主动脉，20 个只会让每个都停留在表面；不裁决的后果是 M2 继续按 4–7 人日排期，三个月后第一次真实验收才发现差 2 倍。

### Q-2 v1.0 是三平台 GA，还是 Linux GA + macOS/Windows preview？
- 选项 A：三平台 GA，M4 同时收 Windows 隔离、三平台 runner 与 20 插件，排期 +30–40%。
- 选项 B：Linux Tier A GA；macOS/Windows 只保证交叉编译 + preview 链路，GA 放 v1.1；`system/info` 明示降级。
- 建议：B。理由：Windows 的 AF_UNIX/SCM/Job Objects/HMAC 是独立的一条产品线，与 20 插件同时收口必然两边质量都下降；preview 不违背"一个二进制跑三平台"，只推迟"等价隔离"的承诺。

### Q-3 对外还能不能继续写"对标宝塔/1Panel 专业版"？
- 选项 A：继续写，靠 FEATURE-PARITY 脚注说明差异（用户入口看不到）。
- 选项 B：改成"覆盖 22 项能力域，其中 6 项明确不做（多用户/集群/云查杀/短信告警/拖拽建站/多语言）"，README、商店首屏、安装器三处一致；同时 M2 加索引签名填信任空窗。
- 建议：B。理由：单管理员 + 无迁移器 + 无面板自升级，这三项任何一项都足以让专业版用户判定"不对标"；把差异写在用户决定安装的那一屏，比在 draft 文档里写 24 行矩阵更有用。不裁决的后果是销售/文档/产品三套口径继续漂，M4 验收时无法定义"对标成功"。
