> 状态: draft（设计草案，供用户审阅，未裁决、未实现）· 归属: designer（task-40）· 更新: 2026-11-26 · 门禁关联: G-06 / G-19 / G-23 / G-29 / G-31 / G-10
> 关联: [ADR-0056](./0056-self-restart.md)（hard boundary）· [ADR-0043](./0043-login-gate-vs-passwordless-ops.md)（登录门）· [ADR-0023](./0023-zero-intrusion.md) §3.5（零侵入写边界）· [ADR-0042](./0042-privilege-without-prompt.md) · [ADR-0019](./0019-scheduler.md) · [ADR-0025](./0025-index-signing-redesign.md)
> 证据来源: task-37 现状调研（update-probe）· task-38 文档核查（doc-hunter）· task-39 竞品调研（competitor-probe）；三份完整报告已随本轮派发回传 lead，本文所有现状结论标注其报告内的 `文件:行号`，推断单独标注。

# 静默自更新设计草案（Kore 本地自更新闭环）

## 0. 本文的定位与诚实边界

- 这是一份 **doc-first 草案**：只描述方案与备选，不改任何代码 / 配置，不执行 install / serve / upgrade，不联网，不引入任何竞品代码。所有实现动作需用户先裁决 §6 的授权点，再另开实现任务。
- **竞品是"借鉴"不是"既有设计依据"**：task-38 核查结论明确——竞品＝宝塔面板 + 1Panel 在项目文档中有充分出处（`docs/PLUGIN-MATURITY.md:14`、`docs/FEATURE-PARITY.md:3`、`kore/AGENTS.md` G-28③、`.agents/LOG/DECISIONS.md:17,118,121`），但**没有任何文档把这两个竞品与"本地更新方案"绑定**；`local-update-plan.md` / `release-batch-plan.md` / ADR-0048/0056 grep「竞品|对标|宝塔|1Panel」零命中。最接近的记录是升级卡片 G-28 自评（`ui-upgrade.md:68`、`upgrade-card-ui.md:73-77`、`upgrade-card-reshoot.md:88-89`），属产品差距说明，不是设计依据。因此本文 §5 的竞品机制是**本轮新借鉴**，不得表述为"沿用既有竞品设计"。
- 品牌 / 标识：产品显示 **Kore**，代码内部标识（模块 / 路径 / 配置键 / cookie）一律 `kore` 小写。

## 1. 目标与用户承诺

**一句话承诺**：用户一次安装后，Kore 自己完成"发现新版本 → 校验 → 下载 → 安装 → 重启提交"，**零停服、零凭据输入、零逐条命令**；任何一步失败自动回滚到更新前状态并给出白话告警，绝不留下半更新状态。

| 承诺 | 含义 | 不可触碰的红线 |
|---|---|---|
| 零停服 | 插件热更新复用 `reloadOne`；内核二进制替换的重启窗口压到秒级并自动完成，不要求用户手动停服 | 不要求用户执行 `systemctl stop` 或退出面板 |
| 零凭据 | 由受限的本机调用身份触发，不再向用户要 admin 口令 / token（见 §2 缺口①） | **不放宽公开会话门**（ADR-0043 明确 UDS/loopback 不豁免会话，不得回退 ADR-0041 的错误） |
| 零命令 | 用户不逐条执行 install；批量编排一次触发全部待更新插件 + 内核（见 §2 缺口②） | 不留"手工核 sha"给人 |
| 失败回滚 + 告警 | 更新前记录上一版本 / `.prev`，失败自动切回并写审计 / 通知（对齐 ADR-0056 §5 fail-closed） | 不声称假成功；marker 停留 pending 时明确"未完成" |
| 远端边界 | 自更新只做**本地二进制替换 + 本地 unit 重启** | **绝不 git push / tag / PR、绝不访问任何远端**；GitHub 永远只 `workflow_dispatch`（ADR-0056 §6 写死） |

**用户价值四问（AGENTS.md §0 产品易用性）**：①预设优先——更新策略用预设（自动 / 仅提示），不让人填 cron/URL；②自动发现——后台拉已验签索引，离线自动跳过；③步骤少——一次开关配置，之后零操作；④小白能懂——失败提示给"怎么办"（如"索引验签失败，请等待下次检查"），禁用 `stale_versions` / `pending marker` 等内部术语。

## 2. 现状能力盘点与三个真缺口的备选方案

### 2.1 现状盘点（复用现有原语，不重造轮子）

| 能力 | 现状结论（含出处） | 来源 |
|---|---|---|
| 插件在线安装 = 热更新 | `POST /api/v1/store/install` 自带 `reloadOne`：停旧进程 → 读新清单 → Replace → 按 desired_state 拉起，`/plugins` 立即新版本、无需重启内核 | `serve_runtime.go:243-355`、`serve_boot.go:89`、`server.go:107-111`、`handlers_store.go:196-248`（task-37 §1/§4） |
| 插件离线 CLI 安装需停服 | serve 与 install 独占同一 `state.db` 的 bbolt flock，运行中执行 exit 3；CLI 不经 `reloadOne`，新版本等下次 serve | `store.go:95-100`、`install.go:102-108,161-171`、`RUNBOOK-INSTALL.md:56-80`（task-37 §1） |
| 内核升级原语已完整 | `kored upgrade` = `--bin`+`--sha256` 校验 → 同目录临时文件 fsync+rename 原子替换 → 留 `<bin>.prev` → `--no-block` 提交重启 → 新进程 `finalizePendingUpgrade` pending→success | `upgrade.go:3-14,150-208,265-295,340-379`、`privilege/systemd.go:40-54`（task-37 §3/§5；本轮已回读 `upgrade.go:1-14,135-140,150-158,265-270,340-345` 确证） |
| upgrade 的硬前置 | 非 root 明确失败（`upgrade.go:137` 权限闸门）；`--bin` 拒绝 URL（`upgrade.go:10-14`）；只接受本地文件 + sha | task-37 §2/§5，已回读确证 |
| 自动触发缺失 | scheduler 唯一 ticker 在 `internal/core/scheduler/loop.go:18`，market 零 ticker；G-19 禁止轮询（唯一周期源＝scheduler 单实例单 ticker，ADR-0019） | 本轮回读 `loop.go:8,18-24` 确证；task-37 §3/§5 |
| 验签公钥是编译期常量 | 换公钥必须 `make build` + 重启；验签失败带 `requires_restart:true` | `RUNBOOK.md:10-12,68-74`、`market/verify.go:27-31`（本轮回读确证） |
| stale_versions 累积 | 旧插件目录不自动删，仅前端提示清理 | `market/types.go:104-106`、`market.go:35-40`（本轮回读确证） |
| 本机事实（勿用 plan 旧快照） | 磁盘 `bin/kored` sha=`7f768e4e…`；`index_dir` 已修好指向 `kore-plugins/index`；`state.lock` pid=2533240 | task-37 §2/§3；`local-update-plan.md` 是早间快照，sha/索引已过期 |

**结论**：最小可用形态 = 本机可信调用通道 + 批量安装编排 + 复用已有 `reloadOne`（插件热更新已具备）+ 复用 `upgrade` 校验替换链（已具备但需 root 与自动触发）。真正缺的是下面三项。

### 2.2 缺口①：本机免交互鉴权身份

**问题**：`withAuth` 对全部 `/api/v1/*` 强制会话或 admin scope token；ADR-0043 明确 UDS/loopback **不豁免会话**（`middleware.go:26-30,35-72`；`local_access.go:11-23`）。UDS 的 `SO_PEERCRED` 校验（`local_access.go:77-97`）只决定 CSRF 引导是否被 blocked，**不构成身份**。所以现在的安装写操作必须有人登录拿会话——这是 ADR-0043 的结构性设计，不是遗漏，不能简单"给本机开绿灯"。

| 备选 | 做法 | 优点 | 代价 / 风险 | 与 ADR 的关系 |
|---|---|---|---|---|
| A. UDS 专用端点 + 进程身份 + 专用能力 | 新增仅绑定 UDS 的更新端点，校验 `SO_PEERCRED` uid 为 kored 自身 / root（本机特权执行层），授予**单一专用能力**（只可更新，不含 6 项 admin 特权），公开 HTTP 门完全不变 | 复用已有 UDS 与 peer-cred 机制；能力最小化；Web 触发也走同一端点，统一审计 | 需界定可信 uid 集合与能力边界；UDS 文件权限要收紧；**1Panel CVE-2025-54424 教训**：必须严格双向鉴权，不能只验"有连接" | 需新 ADR 定义"本机调用身份"，但**不修改 ADR-0043 会话门结论**——这是旁路 identity，不是放宽公开会话 |
| B. 进程内调用（in-process） | 自更新器作为 kored 内部模块，直接调用 installer / upgrade 原语，不走 HTTP | 无新网络面、无 UDS 鉴权难题；最贴合"薄壳只做规则" | 自更新逻辑进入 `internal/core`，须严控 G-01（不写插件业务）；内核升级需 self-exec/exec 新二进制，进程内无法替换自身；仍需解决"谁来触发" | 与 G-01 薄壳红线相容（规则/编排不是业务），但需论证触发源 |
| C. 一次性 token 文件（如 confirm-token 模式） | 安装期生成 0600 一次性 token，本机进程读取后调用更新端点 | 复用 ADR-0056 confirm-token 既有模式；不需要进程身份 | token 落盘即长期凭据，泄露面大；每次更新要换 token，仍非"零凭据"；离线安装期尚未有凭据时更难 | 偏向"凭据"而非"身份"，与零凭据承诺有张力 |

**推荐（不替用户拍板）**：**A 为主、B 为辅**——A 给"外部本机进程/面板"一个受约束的入口，B 给 kored 自身的编排逻辑一个无需 HTTP 的内部原语；理由：兼顾"统一入口 + 最小权限 + 可审计"，且不动 ADR-0043 的公开会话门。C 作为不推荐项，理由是违背零凭据承诺。**无论选哪个，都必须守住：不放宽公开会话门、不把系统身份当 Web 登录凭据（ADR-0043 §3 选项 C 已被否决）。**

### 2.3 缺口②：批量入口

**问题**：CLI `--scenario` 明确返回 `E_UNSUPPORTED`（M2，`install.go:62-73`，本轮回读确证）；store/install 请求体是单 id/version（`handlers_store.go:34-45`）；market.Service 无批量配置（`market.go:42-54`）；商店预设"一键安装"是禁用态（`docs/CORE.md:120`）。

| 备选 | 做法 | 优点 | 代价 / 风险 |
|---|---|---|---|
| A. 编排器循环（orchestrator） | 新增"批量更新编排器"：一次触发 → 读索引算待更新项 → 按依赖序逐条调用现有单条 install → 汇总结果 + 失败告警 | 复用现有单条热更新与验签；改动最小；失败可逐条分诊（对齐 `local-update-plan.md:98`：单条失败不整批回滚） | 依赖排序 / 幂等 / 部分失败语义要 design；`stale_versions` 累积需配套清理策略 |
| B. 实现 `--scenario` 真批量（M2 补齐） | 让 CLI `--scenario` 真正生效，一次命令装完预设 | 对齐既有预设模型；离线也可以批量 | CLI 路径仍需停服（bbolt 锁），与零停服承诺冲突；只能作离线/演练，不能当主路径 |
| C. store/install 扩展为批量请求体 | 给 API 加 `items[]`，服务端一次性处理 | 一次请求、服务端统一编排与事务边界 | 改动对外 schema（须守 G-24 显式类型、禁 any）；失败语义复杂；与 reloadOne 单 id 回调的交互要重设 |

**推荐（不替用户拍板）**：**A 为主**——理由：以最小改动复用已验证的单条 `reloadOne` 路径，天然满足零停服；B 作为离线补充纳入 MVP 但不作为静默主链；C 留到完整期再评估（对外 schema 改动需要独立 ADR）。

### 2.4 缺口③：自动发现 + 下载 + 触发链

**问题**：`upgrade --bin` 拒绝 URL（`upgrade.go:10-14`），内核二进制没有"已验签索引 → https 资产 → sha256"的供应链入口（market 的 `InstallFromURL` 只服务插件包）；scheduler 是唯一合法周期源（G-19 / ADR-0019），market 零 ticker；离线场景需 `IsOffline` 短路（竞品原则①）。

| 备选 | 做法 | 优点 | 代价 / 风险 |
|---|---|---|---|
| A. scheduler 内加单一"更新检查"任务 | 在唯一 ticker 上注册一个内置任务（`cert_renew` 已迁移为内置任务的先例），检查索引版本 → 下载 → 校验 → 触发更新 | 不新增 ticker，天然合规 G-19；离线可 `IsOffline` 短路（借鉴 1Panel `SearchUpgrade`） | 检查周期是 ADR-0019 内的新任务，需登记；下载在网络可达时发生但 G-10 要求"无联网/无遥测"——须明确这是**用户可关闭的更新源拉取**，非强制联网，需用户裁决 |
| B. 事件驱动（webhook / 用户手动触发） | 不做周期检查，由用户点"检查更新"或外部 webhook 触发一次完整链 | 完全不碰 G-19 定时器；与"无轮询"最贴合 | 不满足"自动发现、用户零操作"承诺；webhook 触发又引入对外入口与鉴权难题 |
| C. 定时器白名单外挂（独立常驻进程） | 另起一个自更新守护进程 | 与 kored 解耦 | 新增常驻进程违反 G-05/资源预算；安装目录外写入违反 G-31（ADR-0023 §3.5）；明确不推荐 |

**推荐（不替用户拍板）**：**A 为主、B 作为离线/手动兜底**——理由：G-19 已给出"唯一周期源=scheduler"的正当扩展位，不破坏禁轮询纪律；同时以 `IsOffline` 短路避免离线空转。**注意**：联网拉取更新源与 G-10"无联网/无遥测"存在张力，必须由用户明确裁决"是否允许可选的更新源拉取"（见 §6 授权点 U4），未裁决前实现不得默认开启。

## 3. 完整时序（区分插件 / 内核两条路径）

> 时序中"更新检查"由 §2.4 选定的触发源发起；鉴权由 §2.1 选定的本机身份提供；批量编排由 §2.2 的编排器负责。所有写操作写审计、失败写告警，不吞异常（AGENTS.md §5）。

### 3.1 插件路径（热更新，无需重启内核）

```
触发（scheduler 更新检查 / 用户点一次"检查更新"）
  → ① 版本发现：读已验签索引（index/plugins.json + versions.lock.json），比对已装版本
     · 离线（IsOffline）→ 直接短路，返回"离线跳过"，不报错（借鉴 1Panel SearchUpgrade）
     · 验签失败 → 带 requires_restart:true 提示，本次不更新（verify.go:27-31）
  → ② 下载 + 校验：逐项从索引 download_url 取 tar.gz （或本地 package_path），
     流式计算 sha256 与索引逐字比对（market 验签链，docs/SECURITY.md:318）
  → ③ 批量安装编排：按依赖序逐条 POST /api/v1/store/install（本机身份鉴权，不过公开会话门）
     · 每条共用 installer 写 state.db + 解包 <state>/plugins/<id>/<ver>/ + 刷 current
     · 每条自带 reloadOne：停旧 → 读新清单 → Replace → 按 desired 拉起 → /plugins 立即新版本
     · 单条失败：按 HTTP 码分诊（400/401/409/502/500），记录失败项，继续其余项（不整批回滚）
  → ④ 收尾：stale_versions 旧目录按配置的保留份数清理（借鉴 1Panel 备份份数可配）
  → ⑤ 汇总：成功/失败清单 + previous_version + reload 结果写审计；失败项白话告警
```

**回滚**：插件目录按版本留存、current 链接可切回上一版本（`local-update-plan.md:71` 备份思路）；失败项可单独重试，不需整机回滚。`post_upgrade_pending` 标记由下次启动补跑（`install.go:132-138`）。

### 3.2 内核路径（二进制替换 + 重启提交）

```
触发（同一更新检查链，发现 kored 新版本）
  → ① 版本发现 + ② 下载校验：同插件路径，但资产是 kored 二进制：
     "已验签索引 → https 资产 → sha256"（新供应链入口，缺口③）
  → ③ 预检：磁盘空间（借鉴 1Panel PR #12708）；确认 root 身份与 unit 名
     · 非 root（portable 形态）→ 走 §4.2 的降级路径，不假装成功
  → ④ 调用现有 upgrade 原语：kored upgrade --bin <本地新二进制> --sha256 <hex>
     · 拒绝 URL：下载已在 ② 完成，upgrade 只看本地文件（upgrade.go:10-14）
     · 先校验后替换：不一致时目标字节不动（upgrade.go:12）
     · 原子替换 + 保留 <bin>.prev（upgrade.go:13-14）
     · 落 pending 标记 → --no-block 提交本地 unit 重启（upgrade.go:265-295）
  → ⑤ 新进程 serve 启动：finalizePendingUpgrade 把 pending 改写 success（upgrade.go:340-379）
     · 验签公钥若变更：必须 rebuild 后的二进制才生效 → 重启后新公钥载入，闭环
  → ⑥ 失败：marker 停留 pending/rollback-pending，自动切回 .prev + 告警（fail-closed，ADR-0056 §5）
```

**硬边界**：⑤⑥ 全程只做本地文件替换 + 本地 unit 重启；**不 git push / tag / 访问远端**，远端同步默认关闭（ADR-0056 §6）。插件与内核两条路径都写 `system.restart` 类审计（actor / reason / unit / commit_result），不记口令与 token。

## 4. 两种部署形态的闭环路径

> 两种形态都要能闭环；当前沙箱限制（非 root、user bus 不可连、PID namespace 隔离，task-37 §3）**不是产品约束**——用户按设计装的 root systemd 服务里这些都不存在。方案需同时覆盖二者。

### 4.1 形态 A：用户本机 root systemd 服务（目标形态，ADR-0042）

- **前置**：一次性安装 system unit `/etc/systemd/system/kore.service`（ADR-0023 §3.5 豁免 #1，需用户一次性明确授权）；kored 进程 euid=0，此后替换自己的二进制 / 重启自己的 unit **不再需要 sudo**（`upgrade.go:3-8` 的设计前提）。
- **闭环**：§2.1 缺口①选 A → 本机特权执行层通过 UDS 专用端点触发；§2.2 编排器走在线 `store/install` 热更新插件；内核走 `upgrade` 原语 + `systemctl --no-block restart kore.service`；验签公钥变更随 rebuild 后二进制重启生效。全程零停服窗口外操作、零凭据输入。
- **与 ADR-0056 对齐**：这是 `SelfRestart(reason, actor, unit)` 的 euid==0 分支（复用 `BuildRestartArgv` / `RestartUnitNoBlock`，`0056-self-restart.md:34`）；系统级 root 服务真装属"需用户一次性授权的不可逆系统变更"，本方案**不执行、不代授权**（`0056-self-restart.md:49,96`）。

### 4.2 形态 B：当前 portable 实例（降级形态）

- **事实**：非 root（uid 1000）、`systemctl --user` user scope bus 不可连（socket 存在但未挂 user scope）、沙箱私有 PID namespace 看不到宿主进程（task-37 §3）；`state.lock` pid=2533240 属宿主侧。
- **闭环（产品设计上，不是沙箱现状）**：ADR-0056 已采纳"降级形态下 kored 重启自己的 user unit"作为当前可用补充路径（`0056-self-restart.md:23,29,35`）——kored 由 `systemd-run --user` 拉起时持有 user bus 凭据，可 `systemctl --user --no-block restart <unit>` 自重启自己的 unit。插件热更新（在线 `store/install` + `reloadOne`）本来就不依赖 root，portable 亦可完成。
- **内核二进制的降级边界**：`upgrade` 原语要求 euid==0（`upgrade.go:137`）——portable 非 root 时**明确失败**并给白话 hint（"本实例不是 root 服务，内核自升级请在系统级服务形态下使用"），不允许静默降级 / 假成功（G-16、ADR-0056 §5）。这是**形态限制，不是设计缺陷**；完整闭环以形态 A 为准。
- **沙箱与本产品的关系**：本轮调研拿不到 admin 凭据、user bus 不可连、PID namespace 隔离都是 DSH 沙箱特有，用户本机不存在；方案不得把这些写成产品需求，也不得为迁就沙箱而削弱安全门。

## 5. 竞品机制借鉴点与 kore 特有约束适配

> ⚠️ 以下 8 条均来自 **task-39 本轮联网调研**（竞品＝宝塔面板 + 1Panel，出处见 §0 诚实边界）。竞品正文因 SSRF 拦截多为搜索摘要级证据，已在报告内逐条标注；本节只借鉴机制、不照抄代码、不引入竞品源码。

| # | 可借鉴原则（来源） | kore 适配 |
|---|---|---|
| 1 | 版本探测后台化 + 离线可降级 —— 1Panel `SearchUpgrade` 的 `IsOffline` 短路；宝塔首页常驻更新提示 | §2.4 方案 A：scheduler 更新检查任务，离线短路不报错；注意与 G-10"无联网"的裁决（§6 U4） |
| 2 | 更新前预检 + 自动备份 + 可配备份份数 —— 1Panel PR #10483（份数可配）/ PR #12708（磁盘预检）；宝塔全量备份 | §3.2 预检磁盘；§3.1 收尾清理 `stale_versions` 时保留份数可配；覆盖 state.db + 插件目录 + 二进制 |
| 3 | 先下载/校验/准备，后切换，失败不破坏旧版本 —— 1Panel PR #5561（镜像拉取失败无需回滚，因旧容器未停） | §3 两条路径均"校验先于替换"：插件流式验 sha、内核 `upgrade` 比对后原子替换（`upgrade.go:12-13`） |
| 4 | 原子切换 + 一键回滚 —— 1Panel `1pctl restore`；宝塔 `bt 34` + "修复面板" | 内核 `.prev` 回滚 / 标记 pending（`upgrade.go:14,340-379`）；插件按版本目录 + current 切回；失败自动切回 + 告警 |
| 5 | 后台异步任务队列，关页面仍继续 —— 宝塔 `panelTask.bt_task()` / `/task` / `start_background_task()`；1Panel 面板 API 静默脚本 | §2.2 编排器作后台 worker，UI 可关；批量失败逐条分诊，不因关页面中断 |
| 6 | 单一高权限执行层 + 会话即凭据，零次输 sudo —— 宝塔面板 root 常驻；1Panel core/agent 分离（UDS+gRPC，agent 唯一持系统权限） | §2.1 方案 A：本机 UDS 专用端点 + 进程身份 + 专用能力；**不像宝塔那样把 Web 会话直接等同 root**（ADR-0043 否决"系统身份当登录凭据"），只在本机受控通道内打通 |
| 7 | 在线/离线双通道 + 本地 API 化 —— 1Panel 在线升级 + 离线包 `upgrade.sh`（社区："调面板自身更新 API 更安全"）；宝塔面板一键 + `bt 34` + 离线 zip | kore 已有离线 CLI install 与在线 `store/install` 两条路（`task-37 §1`）；统一由 §2.4 触发源 + §2.2 编排器调用本地更新原语，不再逐条手工 |
| 8 | **静默提权通道必须严格鉴权（反面教训）** —— 1Panel CVE-2025-54424：`tls.RequireAnyClientCert` 只验"有证书"不验 CA 导致 RCE（GHSA-8j63-96wh-wh3j） | §2.1 方案 A 必须"连接来源 + 进程身份 + 专用能力"多重校验；UDS 文件权限收紧；**绝不因静默而放松** |

**kore 特有约束（竞品无直接对应，单列）**：
- **Go 单二进制 vs 1Panel core/agent 双进程**：不能照搬"core 独立热升级"，采用 `upgrade` 原子替换 + `--no-block` 重启 + 新进程 finalize 的短窗口方案（§3.2）。
- **插件协议 / 签名体系**：`info.json`/`manifest.json` + dist tar.gz + sha256 + 已验签索引 + annotated tag（RELEASE.md:70-79）是既有资产，批量与发现链复用而非另起炉灶。
- **UDS 鉴权与 ADR-0043**：与 1Panel agent UDS 同构但必须吸取 CVE 教训；公开会话门不动。
- **零侵入 G-31 / ADR-0023 §3.5**：仅允许 4 项安装目录外写入；自更新如需常驻任务 / 新 unit / 新用户，必须先改 ADR（见 §6 U3）。

## 6. 需新增 / 修改的 ADR 清单与需用户裁决的授权点

### 6.1 ADR 清单

| 动作 | ADR | 原因 |
|---|---|---|
| **新增** | 本机调用身份与专用更新能力（建议编号 ADR-0058） | 定义 §2.1 方案 A 的 UDS 专用端点、可信 uid 集合、单一专用能力、与 ADR-0043 会话门的边界；吸收 CVE-2025-54424 教训 |
| **新增** | 自动更新触发与供应链入口（建议编号 ADR-0059） | 定义 §2.4 的 scheduler 更新检查任务、离线短路、验签索引→资产→sha256 链、备份份数与 stale 清理策略；登记 G-19 定时器白名单扩展 |
| **修改** | ADR-0019（scheduler） | 新增"更新检查"为 scheduler 内置任务（单实例单 ticker 不变）；条目须写清被否决选项（G-23） |
| **修改** | ADR-0025（index signing） | 明确内核二进制的验签索引字段与公钥轮换闭环（换公钥需 rebuild + 重启，复用 upgrade 标记机制） |
| **视方案修改** | ADR-0023 §3.5 / G-31 | 若 §2.4 需新增安装目录外写入（常驻任务落盘 / 新 unit / 新用户）则必须先放宽；§4.1 的系统 unit 仍走既有豁免 #1 |
| **不改（引用边界）** | ADR-0056 / ADR-0043 / ADR-0042 | 本方案继承其 hard boundary 与会话门结论，不重新打开已裁决问题；如需变更须单独提案 |

> 以上编号仅为建议，实际编号由 scribe 按 `.agents/DECISIONS/` 现状分配；每个 ADR 必须写备选对比 + 被否决项 + 复审条件（G-23）。

### 6.2 需用户裁决的授权点（不替用户拍板）

| 编号 | 裁决点 | 为什么要用户定 |
|---|---|---|
| U1 | §2.1 本机身份选 A / B / C（推荐 A+B） | 涉及安全门设计，直接关系"不放宽公开会话门"的承诺 |
| U2 | §2.2 批量入口选 A / B / C（推荐 A） | 涉及离线路径是否纳入主链、是否改对外 schema |
| U3 | 是否允许 G-31 / ADR-0023 §3.5 之外的安装目录外写入（常驻任务 / 新 unit / 新用户） | 零侵入是用户核心约束，放宽须一次性明确授权 |
| U4 | 是否允许**可关闭**的更新源联网拉取（与 G-10"无联网/无遥测"的张力） | 静默发现新版本需要拉索引，但 G-10 是硬门禁；默认关闭直到用户裁决 |
| U5 | 是否授权一次性安装系统级 root 服务（ADR-0056 §49 的不可逆系统变更） | 形态 A 全闭环的前提；本方案不执行、不代授权 |
| U6 | 备份份数 / 保留旧版本的磁盘上限（stale_versions 清理策略） | 涉及磁盘占用与回滚能力的权衡 |

## 7. 分期实施建议与验证标准

### 7.1 MVP（先闭环"可信 + 批量 + 复用"）

1. 实现 §2.1 推荐方案（本机 UDS 专用端点 + 进程身份 + 专用能力，公开门不动）；
2. 实现 §2.2 编排器 A：一次触发按依赖序逐条调用现有 `store/install`，带鉴权、幂等、失败分诊；
3. 复用 `reloadOne`（插件零停服）与 `upgrade` 原语（内核校验 + 原子替换 + `.prev` 回滚 + `--no-block` 重启 + finalize）；
4. 形态 A（root systemd）为主验收形态；形态 B（portable）插件热更新闭环、内核升级 fail-closed 给白话 hint；
5. 完成 ADR-0058（本机身份）与 ADR-0019/0025 的必要修订；U1-U5 裁决到位。

**MVP 验证标准**（每条都要命令 + 退出码 + 关键输出，G-07）：
- 插件：一次触发批量更新 N 个插件，全部 200，`GET /plugins` 立即新版本且无需重启内核，启用态与升级前一致（`local-update-plan.md:112`）；单条失败可单独重试、不影响其余项。
- 鉴权：未登录访问公开 `store/install` 仍 401（UDS/loopback 亦 401，ADR-0043 契约不回退）；本机专用端点以可信身份 200、以不可信 uid 被拒（模拟 CVE-2025-54424 的反例必须失败）。
- 内核：happy path 走完 `upgrade` → `.prev` 存在 → 重启后 finalize 把 marker pending→success；故意给错 sha 时目标文件字节不变（fail-closed）。
- 回滚：注入一次升级失败，自动切回 `.prev` / 上一版本目录，写审计与白话告警，marker 不假成功。
- 门禁：`make check`（含 G-19 空载、G-30 明文凭据、G-31 零侵入）、`make idle`（更新任务在 scheduler 白名单内、空闲 CPU/出站达标）、`make secret-check` 全绿。

### 7.2 完整期（自动发现 + 双形态 + 运维闭环）

1. §2.4 方案 A：scheduler 更新检查任务 + `IsOffline` 短路 + "验签索引 → https 资产 → sha256"内核供应链入口（U4 裁决后启用）；
2. 备份份数可配（U6）、`stale_versions` 自动清理；磁盘预检；更新失败告警通道；
3. 形态 A 与 B 都完成端到端演练（B 的内核升级明确形态限制而非缺陷）；验签公钥轮换的 rebuild+重启闭环演练；
4. 完成 ADR-0059 与 ADR-0023 §3.5（若 U3 放宽）的最终稿。

**完整期验证标准**：
- 自动发现：联网时后台拉到新版本并走完整链；断网时 `IsOffline` 短路、零报错、零出站（G-10 在关闭开关时成立）；
- 双形态：root systemd 全闭环；portable 插件闭环 + 内核 fail-closed 提示，均贴命令 + 退出码；
- 离线/在线双通道：本地包 vs `download=true` 两条都验 sha、结果一致；
- 安全：UDS 双向鉴权反例测试（伪造身份 / 弱证书）全被拒；公开门未登录全 401；审计无口令/token（G-30）；
- 完整性：全流程无 git push / tag / 远端访问（对照 ADR-0056 §6），GitHub 触发仍仅 `workflow_dispatch`。

## 8. 证据索引（现状结论出处汇总）

- task-37（update-probe）完整报告：parent session `session-ca38f06f…` seq 2066；关键文件行号已在 §2.1 / §3 / §4 逐条标注，本轮已回读 `upgrade.go` / `serve_runtime.go` / `middleware.go` / `loop.go` / `handlers_store.go` / `types.go` / `verify.go` / `install.go` 确证。
- task-38（doc-hunter）完整报告：parent session seq 1992；竞品出处与"本地更新无竞品设计依据"结论见 §0。
- task-39（competitor-probe）完整报告：parent session seq 2053；8 条可借鉴原则与证据等级（SSRF 摘要级 / 社区 / 推断）见 §5。
- 项目硬约束：[ADR-0056](./0056-self-restart.md) §5-6、[kore/AGENTS.md](../../AGENTS.md) G-10 / G-19 / G-23 / G-28 / G-29 / G-31 / G-33。

---

> 本文为草案（draft）。**未裁决的授权点见 §6.2；裁决前不得进入实现。** 任何实现 PR 必须逐条对照 §7 验证标准贴证据。
