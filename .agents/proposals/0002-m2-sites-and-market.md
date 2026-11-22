> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M2

# 提案：0002 · M2 Sites & Market（站点插件 / 商店 / 8 预设 / Web 壳 / Lazy 生命周期）

## 1. 目标与非目标

**目标**（对齐 [V1-GOALS](../../docs/V1-GOALS.md) §1 与 [ROADMAP](../../docs/ROADMAP.md) M2 行）：M2 把内核从"能装一个插件"升级为"有商店、有预设、有站点能力、可自管安装/更新/卸载"——落 `site` 插件、软件商店端点、8 类场景预设、前端管理中心与 lazy 运行期；量化判据沿用现役数字，不引入第二套口径：常驻合计目标 ≤24 MiB（红线 48）、同时常驻 ≤3（推荐 ≤2，含唤醒中的 lazy）、首屏 ≤300 KiB gzip、lazy 冷启动 p95 ≤300 ms（SLO）、API p95 ≤50 ms、启动到就绪 ≤1 s。

**非目标**（G-11 六项不做，原文见 [AGENTS.md](../../AGENTS.md) §2）：①多用户 RBAC ②集群/多机 ③模板市场 ④厂商云存储深度集成 ⑤拖拽建站 ⑥多语言（i18n）；另不做容器编排、多租户 SaaS、移动 App、重型主题。

**边界澄清**：本提案的 "market" 指 [CORE.md](../../docs/CORE.md) §2.13 的软件商店模块（包名 `market`，HTTP 前缀 `/store`），**不是** G-11 禁止的"模板市场"——索引仓 `kore-plugins` 保持纯静态（无审核、无账号、不代管包），商店只做索引缓存 + 显式刷新 + 安装调度。

**M2 不做（分期，非 G-11）**：插件包 ed25519 签名（M4；索引级签名 M2 已前移）、cgroup 强制 / `kore-<id>` 系统用户（M3）、运行时下载（插件调宿主包管理器，kore 不下载）、`--allow-partial`（失败整预设回滚）、Windows 运行时实现（仅交叉编译）。

## 2. 五条轨道（M2-A ~ M2-E）

| 轨道 | 一句话目标 | 一句话验收判据 |
| --- | --- | --- |
| **M2-A site 插件** | 独立仓 `kore-plugin-site` 提供站点 / 域名 / 反代能力，`info.json` 声明 `lifecycle=resident`、`requires_kore`、`depth_level=production`，只依赖 `pkg/pluginapi` 公开 SDK。 | `make dist` 产出 tar.gz + `.sha256` 且 G-17 三件套齐，经 `kored install` 后 install → hello → invoke → uninstall 全通；**宿主 nginx 共存**：site 只写独立 `conf.d` vhost 片段 + include，不改宿主 nginx 主配置、不抢占 `default_server`，在"已有站点宿主"fixture 上 `nginx -t` 退出 0 且原 vhost `sha256sum` 前后一致；`grep -rn "plugins/" internal/core` 零命中。 |
| **M2-B kore-plugins 索引仓 + market 端点** | 索引仓发布静态 `index/plugins.json` + 校验脚本，内核新增 `market` 模块暴露 [CORE.md](../../docs/CORE.md) §2.13 七个 `/api/v1/store/*` 端点，读本地缓存零出站、仅 `refresh` 为显式联网入口。 | 索引级 ed25519 签名校验通过、包 sha256 与发布物一致且不符不落盘，`make store-check` 绿，七端点返回统一响应包络（沿用现役 `/api/v1` 口径，不另造字段）；**签名链端到端可用**：私钥轮换后旧签名仍可验（公钥版本兼容窗口）、CI 签名步骤产出有效签名的索引、未签名索引被内核默认拒绝，`allow_unsigned=true` 不得进默认配置（否则信任空窗 FAIL）。 |
| **M2-C 8 类场景预设** | 在 `kore-plugins/presets/` 落 8 个 preset（`schema_version=1`，仅插件 id + `version_range` + 白名单配置模板），kore 构建期 `//go:embed` 快照，安装器按 id 列表装配并整预设回滚。 | `make presets-check` 绿——所有 id / 区间可解析、每预设同时常驻 ≤3、合计按 resident **实测中位数**（60 点）求和；**≤48 MiB 红线才 FAIL，≤19.2/24 MiB 为目标 WARN、余量不足只记趋势不入 FAIL**（对齐 G-03 / G-18）；同一预设两次干净安装结果一致。 |
| **M2-D web 壳** | 前端管理中心新增商店页（分类 / 搜索 / 依赖提示 / `depth_level` 展示）与首装向导，UnoCSS 原子类裁剪、无完整 UI 框架样式包，随单二进制 `go:embed`。 | `make frontend` 绿且首屏 ≤300 KiB gzip，dist 无 `*.map` / `.vite` / 全量字体，`GET /`、`/assets/*` 返回 200，插件资产走 `/plugin-assets/<id>/*`（G-03 / FRONTEND 口径）。 |
| **M2-E lazy 生命周期** | supervisor 在 M1 仅 `resident` 的基础上支持 `lazy` / `oneshot` 运行期：事件或调用触发 exec，空闲 300 s 真退出，冷启动 p95 ≤300 ms 记为 SLO 不判失败。 | lazy 空闲后进程确实消失（无 ticker 续命，G-19 零命中），再次调用重新 exec + hello，同时常驻 ≤3（**含唤醒中的 lazy，超限即驱逐/拒绝再唤醒、不当场硬起第 4 进程**）、空闲 CPU ≤0.1%（60 s ≤60 ms）。 |

## 3. 风险六条

| # | 风险 | 触发信号 | 缓解与验收抓手 |
| --- | --- | --- | --- |
| R1 | **站点配置冲突**：`site` 与 `ssl` / `db` / `cron` 的 `config_template` 或 `depends_on` / `conflicts` 打架，装出半套 web 栈。 | 预设安装报 `E_CONFLICT`；`grep` 出白名单外键（如 `auth.*` / `security.*`）。 | 预设只携带白名单键并过 schema 校验，命中即整条 `E_INVALID`（[SECURITY.md](../../docs/SECURITY.md) §8.1）；`depends_on` / `conflicts` 由 registry 解析，失败整预设逆序回滚。 |
| R2 | **市场供应链 sha256 + 签名链断供**：索引被篡改 / 未签名 / 包摘要不符；或私钥轮换、CI 签名 job 脱节导致 `refresh` 全拒、商店装不了任何包。 | `store-check` 摘要不一致；未签名索引被默认接受；`refresh` 返回签名错误码；公钥仅单版本无轮换窗口；**`allow_unsigned` 被写进默认配置即为信任空窗信号，判 FAIL**。 | 索引级 ed25519 签名前移到 M2（信任空窗 = 0），公钥内置二进制且留版本兼容窗口；未签名默认拒绝，`store.allow_unsigned=true` 只能显式配置并写审计、禁入默认配置；安装前校验 sha256，不符 400 `E_INVALID` 不落盘；`openssl pkeyutl -verify` 对当前索引正向验签过、改 1 字节必失败，`grep -rn 'allow_unsigned.*true'` 在默认配置零命中（仅审计测试例外）。 |
| R3 | **预设超预算**：8 预设常驻合计冲过红线，或目标余量为 0 / 负但被当 FAIL 与 G-03 打架。 | `make presets-check` 报 WARN / FAIL 与 `make budget-check` 互相打回；某预设余量 ≤0；实测 site 与 `info.json` 声明值差 >2 MiB。 | 合计按 resident 实测中位数（非声明值）求和；**≤48 MiB 为红线 FAIL，≤19.2/24 MiB 为目标 WARN 记趋势，余量不足只告警不 FAIL**（[SCENARIOS.md](../../docs/SCENARIOS.md) §3 / G-18，按 G-03 两层口径裁决）；单 resident 实测 ≤ 声明值 +512 KiB；`db` / `security` 类一律 lazy 计 0 常驻。 |
| R4 | **web 首屏**：商店页与首装向导引入完整 UI 框架，首屏 gzip 破 300 KiB。 | `make frontend` 报超限；dist 出现 `*.map` / `.vite` / 全量 `.woff2`。 | UnoCSS 原子类 + 构建期裁剪、禁完整 UI 框架样式包，模板禁止运行时拼类名，静态资源随单二进制 embed；`make frontend && test $(find web/dist -type f \( -name '*.map' -o -path '*/.vite/*' \) \| wc -l) -eq 0`，按 G-03 红线卡 300 KiB gzip。 |
| R5 | **lazy 冷启动 / 槽位**：空闲退出后被 ticker 续命，或唤醒时已是第 4 进程破"常驻 ≤3"、重拉 `EADDRINUSE`。 | `make idle` 见定时器来源命中 / 进程数不降；resident 2 槽时唤醒 lazy 峰值 >3；`ss -xl` 有残留 socket；连打 20 次 p95 >300 ms。 | G-19 禁 `NewTicker` / `AfterFunc`，请求级计时只用 `context.WithTimeout` + `defer Stop()`；常驻槽 = resident + 活跃 lazy，超 3 即驱逐而非硬起；退出清 socket；冷启动 p95 超 SLO 不判 FAIL 但必须产出记录报告并入 G-19 证据。 |
| R6 | **宿主 nginx 共存**：site 改宿主 nginx 主配置或抢占 `default_server`，把既有站点搞挂（安全事故级，干净容器测不出）。 | install 日志出现 `nginx: [emerg]` 或 80 端口冲突；`grep -rn '/etc/nginx/nginx.conf' kore-plugin-site` 非空；干净环境过、真实宿主挂。 | site 只写独立 `conf.d` vhost 片段 + include，不碰主配置、不占 `default_server`；install 前快照现有配置，`nginx -t` 失败即逆序回滚；必须在"已有 nginx + 一条 default_server 的宿主"fixture 上集成测试，断言 `nginx -t` 退出 0 且原 vhost `sha256sum` 前后一致，否则 FAIL。 |

## 4. 资源预算影响

依据 [ADR-0016](../../docs/DECISIONS/0016-resource-budget-final.md) 的**硬红线 / 目标分离**：只有硬红线判 gate，目标值只进趋势、不阻断里程碑（G-03）。M2 新增 `market` 模块 + web 商店页，预算影响按两层核对：

| 指标 | 硬红线（FAIL，判未完成） | 目标（WARN，争取不判） | M2 增量口径 |
| --- | --- | --- | --- |
| 主壳空载 VmRSS | ≤16 MiB | 8 MiB | M1 基线中位 7688 KiB（[V1-GOALS](../../docs/V1-GOALS.md) §1.3）；新增模块后相对基线增量 ≤512 KiB（RssFile 映射增量判据），仍按红线 16 MiB 判。 |
| 单常驻插件 / 常驻合计 | ≤24 / ≤48 MiB | 12 / 24 MiB | `site` + `monitor` 常驻合计 16 MiB（推荐 ≤2 槽，[RESOURCE-MODEL](../../docs/RESOURCE-MODEL.md) §2.2）；合计按 resident 实测中位数求和。 |
| 同时常驻数 | ≤3（推荐 ≤2） | 1–2 | **同时常驻 = resident + 活跃 lazy 之和**；lazy 唤醒占槽（resident site + monitor 占 2 时唤醒 lazy 占第 3 槽），超 3 即驱逐 / 拒绝再唤醒、不当场硬起第 4 进程；oneshot / 空闲 lazy 计 0。 |
| 单二进制 / 首屏 | ≤25 MiB / ≤300 KiB gzip | 15 MiB / — | 预设与索引 embed 快照进单二进制，`go:embed` 不新增进程；首屏按红线卡 300 KiB gzip。 |
| 空闲 CPU / goroutine / fd / 出站 | ≤0.1% / ≤20 / ≤64 / 0 | 0 / — / — / — | 零后台出站，仅 `refresh` 为显式联网入口（ADR-0012）；禁轮询，状态走事件推送。 |

**`site` + `monitor` 常驻余量估算**：对常驻合计目标 24 MiB，余量 = 24 − 16 = **8 MiB**（占目标 33%）；对预设 19.2 MiB 目标，余量 = 19.2 − 16 = **3.2 MiB**；对硬红线 48 MiB，余量 = **32 MiB**。8 预设最大常驻 16 MiB、最小余量 8 MiB，全部在目标内，无余量为 0 的预设。遵循 G-22：先走设计层（embed 快照、lazy 化、零出站），不为几百 KiB 调 GC 返工；`make budget-check` + `make mem MEM_POINTS=60` 收口，红线与目标两项都报。**判定口径统一**：19.2 / 24 MiB 为目标 / WARN，只有 48 MiB 红线 FAIL；预设合计用 resident 实测中位数（非 `info.json` 声明值）求和，单 resident 实测 ≤ 声明值 +512 KiB——避免 `presets-check` 与 `budget-check` 各引一套口径互相打回。

## 5. 里程碑出口（M2 完成定义）

三条 E2E 全部跑通且贴出「命令 + 退出码 + 关键输出」才算 M2 完成（G-07），口径对齐 ROADMAP M2 退出条件：

1. **E2E-1 · 离线可复现首装**：干净环境拔网 → `kored install --scenario web-lite --offline-dir <dir> --yes` 按 embed 预设快照装齐 → 常驻 ≤3（含唤醒 lazy）、合计不越 48 MiB 红线（19.2 / 24 MiB 为目标，超记 WARN）；同一预设二次干净安装结果一致（可复现）。
2. **E2E-2 · 商店装 / 升 / 卸闭环 + 签名链可用**：索引签名与 sha256 校验通过 → `GET /api/v1/store/plugins`、`GET /store/presets` 可读 → `POST /store/install` 返回 job_id、`GET /store/jobs/{id}` 轮询到完成 → `POST /store/update` 升级、`DELETE /store/plugins/{id}` 卸载成功；索引摘要与发布物一致；CI 签名步骤产出有效签名索引、私钥轮换后旧签名仍可验（兼容窗口）、未签名索引被拒、`allow_unsigned=true` 不在默认配置，否则信任空窗 FAIL。
3. **E2E-3 · site + lazy 生命周期守住预算与宿主共存**：`site` 走 install → hello → invoke → uninstall 全通，并在"已有 nginx + 一条 default_server 的宿主"fixture 上断言 `nginx -t` 退出 0、原 vhost `sha256sum` 前后一致；一个 lazy 插件空闲 300 s 后进程真退出、再次调用重新 exec + hello，resident 占 2 槽时连打 20 次峰值进程 ≤3（含唤醒 lazy）、退出后 `ss -xl` 无残留 socket；p95 >300 ms 虽不判 FAIL 但产出记录报告并入 G-19 证据；全程空闲进程数 ≤1、空闲 CPU ≤0.1%、`ss -tnp` 空（出站 0）。

任一命中即回滚并冻结发布（ROADMAP 回滚条件）：预设装不起来、索引 sha256 与发布物不符、签名链断供或默认放行未签名索引、site 弄挂宿主 nginx、常驻超红线、鉴权回归或出站心跳复现。
