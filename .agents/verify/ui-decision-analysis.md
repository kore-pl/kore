> 状态: 讨论收敛（非决策） · 归属: lead · 更新: 2026-11-22 · 里程碑: M4

# 插件 UI 集成四视角 · 交叉质询与收敛

来源：[JOURNAL 讨论节](../JOURNAL.md) · [FRONTEND §4](../../docs/FRONTEND.md) · [SECURITY §4/§5](../../docs/SECURITY.md) · [AGENTS](../../AGENTS.md) 读前必知 1（裁决 37）/ 6（G-24）。简称：A 架构 / B 安全 / C 资源 / D 插件作者。本文只做收敛，不改 FRONTEND、不落 ADR、不触发实现。

## 1. 真分歧 vs 伪分歧

六对逐对比较：A/B/C 三者互兼容，D 与三方各冲突一次——收敛瓶颈在 D。

| 对 | 判定 | 依据 |
| --- | --- | --- |
| A–B | 伪 | 独立 origin 正是"子帧不碰凭证"的前提；A 给边界、B 定义边界内行为，是叠加。B 否的同源 `allow-scripts allow-same-origin` 与 A 否的同域 `import()` 属同一类反面。 |
| A–C | 伪 | 用户点名的例子：iframe 按插件路由懒创建即可首屏零注入；加载容器（A）与加载时点（C）是两个维度。 |
| B–C | 伪 | 懒加载不削弱裁决边界；唯一新增纪律是 iframe 实例必须晚于授权裁决，避免"未授权先渲染"空窗，属时序约束非分歧。 |
| A–D | 真 | asset 托管 origin：A 要独立 origin，D 要包内 `web/` 直挂 `/plugins/{id}/web/`（主域路径）。文档落在主域即回到共享 realm。 |
| B–D | 真 | 凭证边界强制性：B 要子帧永不接触 cookie/csrf、写操作强制经桥；D 沿用现有组件式调用且"承认同源 XSS 代价"，是约定式容忍而非强制隔离。 |
| C–D | 真 | asset 路径形态：C 要 `plugin-assets@ver` 版本化，D 要固定直挂；前者利缓存与灰度，后者零心智但升级易命中旧缓存。 |

隐藏变量（四方案摘要未提，却决定 A/D 取舍）：`kore_csrf` 是否改 HttpOnly。[SECURITY §4](../../docs/SECURITY.md) 明写"非 HttpOnly（前端需读取）"；它只决定能否断掉"读 token"这一步，断不掉"cookie 自动带 + 管理端点缺 capability 校验"另半条链（[middleware.go:24-25](../../internal/core/httpapi/middleware.go) 只验会话；能力校验仅落在 invoke 帧，见 SECURITY §5.1）。

## 2. 交叉质询

每视角向其余三者各提一句最尖锐反问，随即自答，不和稀泥。

▎**A（架构）问 B/C/D**：桥要代发、UI 要懒加载、资产要零协议直挂——子帧在独立 origin 时静态文件从哪来？若从主域文档加载，cookie 是否又可达？
答：静态字节仍可由主壳从主域 `/plugin-assets/*` 托管，跨 origin 加载 js/css 不赋予文档任何 cookie 权限；关键是**文档 origin 必须跨站**——不同端口仍属同一 site，`SameSite=Strict` 按 site 判定而非按 origin，挡不住自动携带。D 的"直挂"若指文档 URL 在主域，越权链复活；若只指包内目录形态不变、由主壳转托管，则可保留。

▎**B（安全）问 A/C/D**：桥由主壳代发写请求，主壳凭什么相信消息来自哪个插件、授了什么权？谁能防伪造 pluginId？
答：主壳建帧时注入一次性 `sessionId`，映射 `(pluginId, version, granted_capabilities)`；每条消息必带 sessionId，invoke 前查能力表，缺失或未授予即拒并审计 `capability.denied`——与 SECURITY §5.1 的 invoke 帧校验同构，不新造授权模型。但桥不是唯一入口：管理端点自身仍须补目标操作的能力校验，否则盗 token 的 curl 照样越权，UI 隔离兜不住。

▎**C（资源）问 A/B/D**：每插件一个 iframe，20 个插件是不是 20 份浏览器上下文？首屏零注入怎么不被"预建 iframe 池"偷渡？
答：判据落地为"进 `/p/<id>/*` 才建帧、离开即销毁"，禁预建、禁后台保活，d(首屏)/d(插件数)=0。iframe 内存属浏览器侧，不计入内核 VmRSS 红线，不得混口径；但插件并发上限是产品取舍，见第 5 节。

▎**D（插件作者）问 A/B/C**：写个按钮要跨 origin 配 RPC、资产还得按版本路径放，贡献者凭什么留下？
答：门槛压回零协议——`info.json.web` 的 entry/styles/menus/routes 四字段不变（G-24：显式类型、禁 `object`/`any`），组件仍只调现有 `ctx.invoke`/`onEvent`（FRONTEND §4.3 已有）；桥只是把 invoke 的传输从同 realm 调用换成 postMessage，**签名不变**。作者唯一新增心智是"不许自己 fetch 管理端点"，而那正是越权源头。版本号由安装器与托管层承担，作者不手写。

## 3. 决策矩阵

| 方案 | 安全 | 插件作者成本 | 首屏负担 | FRONTEND §4 改动量 |
| --- | --- | --- | --- | --- |
| A 独立 origin + 桥 | 断读 token / 自动带 cookie（前提：跨站，非仅跨端口） | 中：适配帧生命周期 | 零注入 | 大：§4.1/4.3/4.4/4.7 全改 |
| B 主壳唯一裁决 | 强；管理端点缺能力校验是残留硬伤，须独立补 | 中：写请求走桥 | 零 | 中：§4.3 契约 + §4.4 时序 |
| C 懒加载 + 版本路径 | 中立，不增强不削弱 | 低：作者不感知版本号 | 最优，d=0 | 小：§4.5/4.7 路径约定 |
| D 裸直挂零协议 | **硬伤**：同源 XSS 代价被明确接受，越权链原样保留 | 最优 | 若同批挂载则破预算（20 插件 404–1004 KiB） | 零 |
| 现行同域 `import()` | **硬伤**：PoC 的直接目标 | 最优 | 懒加载可做到 d=0 | 零 |
| 收敛候选 A+B+C（D 让步形态） | 跨站边界 + 桥 + 端点补校验 | 低：接口签名不变 | d=0 | 大，但一次到位 |

不可接受的硬伤：现行同域 `import()` 原样推进；D 的裸直挂 + 组件直接 fetch 管理端点；同源 `allow-scripts allow-same-origin` sandbox iframe（插件可自行摘 sandbox）。三者都不是"代价"，是漏洞入口。

## 4. 最小共识方案（各让一步）

- **asset 路径**：包内 `web/` 目录形态不变（D 让步仅在"文档 origin"，不在目录）；安装器仍落 `/var/lib/kore/plugins/<id>/<version>/web/`（FRONTEND §4.2 既有）；主壳经 `/plugin-assets/<id>/<version>/<file>?v=<version>&h=<hash>` 只读托管静态字节，Content-Type 白名单沿用 §4.7。文档 URL 走跨站子域或 opaque `srcdoc`，与资产托管 origin 分离（A/C 让步：版本化只做在托管层，作者不可见）。
- **加载方式**：路由驱动的懒创建 iframe；进 `/p/<id>/*` 建帧、离开销毁；禁预建池、禁全塞首屏；失败只置该插件 degraded（§4.6 语义不变）。
- **凭证边界**：子帧跨站（不同可注册域或 opaque origin，不是同站换端口）；子帧无主域 cookie、读不到 `kore_csrf`；跨站 fetch 默认不带主域凭证。**本方案不依赖 HttpOnly 化**——主壳在原 realm 贴 token 与 cookie 代发，双提交机制不动；HttpOnly 化会连带替换双提交，属独立议题（第 5 节）。
- **桥契约**：消息 `{v:1, sessionId, reqId, type:'ready'|'invoke'|'event', method?, params?, topic?}`；sessionId 建帧时注入、不进可缓存资产；主壳按 sessionId 查 (pluginId, version, granted_capabilities)，invoke 前过能力表；响应 `{reqId, ok, data|error}`；type 白名单，伪造/缺字段即拒并审计；ready/teardown 与 §4.4 时序对齐。
- **info.json 字段**：`web.entry/styles/menus/routes` 原样、类型不变，**零新增字段**；兼容区间由现有 `requires_kore` 表达。无 `object`/`any`/`map[string]any`（G-24）。

## 5. 必须用户拍板的点

技术证据只给代价，不给取向；以下三条需拍板。

| 待拍板 | 选项与代价 |
| --- | --- |
| 插件生态定位 | ① 零门槛同域：作者最省事，但接受 confused deputy 风险，且只在端点补校验后才勉强可控；② 强制隔离桥：越权面收口，作者多一层帧生命周期认知（接口签名不变）。 |
| asset 路径策略 | ① 版本化托管：缓存/灰度干净，托管层多一套路径约定；② 固定直挂：作者零心智，升级命中旧缓存的风险由用户自查。 |
| 是否 HttpOnly 化 csrf | ① 保持非 HttpOnly：现行双提交零改动，token 只在主壳 realm 可见，靠跨站边界护住；② 改 HttpOnly：token 对 JS 全隐，但必须同步替换双提交机制，牵动登录/写请求全链路。 |

"隔离强度"若 PoC 已坐实为 RED，则不再是可选项——见第 6 节；此处只保留"残余风险接受到什么程度"的取向部分。

## 6. 与 ui-poc 的关系

口径：RED = 越权链打通（`site:read` 插件读到 token、带 cookie 成功 enable 高权插件）；GREEN = 打不通（须有负对照排除 PoC 构造失败）。

- **RED**：现行同域 `import()`、D 的裸直挂形态、同源 sandbox iframe 直接出局，不再是"偏好不同"。A+B+C 收敛候选仍成立；D 仅以第 4 节的收敛形态幸存。管理端点缺能力校验（[SECURITY §5.1](../../docs/SECURITY.md) / middleware.go）必须独立修补，不能靠 UI 隔离替代——越权根因在服务端，UI 只是放大器。第 5 节"生态定位"第 ① 项失去可行性，只剩取向层面的残余风险确认。
- **GREEN**：隔离强度从安全红线降为生态偏好，A/D 之争回到贡献者体验取舍；asset 版本化本就是工程偏好，维持第 4 节形态；HttpOnly 化降为可选纵深防御，不阻塞方案选择。但 GREEN 若源于 PoC 未拿到有效 session/CSRF（负对照不成立），不得据此宣布安全，按 RED 处理。

PoC 只裁"越权链是否成立"，不裁"asset 路径""作者体验"——后两者无论红绿都走第 5 节拍板。
