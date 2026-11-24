# R23 · 证书生命周期看板（r23-certlife）交付证据

## 目标与写域
- 目标：新增「证书看板」视图——按到期时间排序的全量证书表 + 4 个概览卡 + 行展开详情 + 续期/解绑二次确认 + 空态跳转 + 手机适配，纯增量。
- 写域：`web/cert-lifecycle.js`（新文件，唯一代码交付）。不改 app.js / embed.go / Makefile / ssl.js / style.css；dist 由 integration 统一接线。
- 契约：`window.KoreCertLifecycle.render(container) → { destroy }`，懒加载，CSS 内联注入（`kore-certlife-css`）。

## 硬验收（5 项）
| 项 | 判据 | 命令 / 来源 | 结果 |
| --- | --- | --- | --- |
| ① grep | 确认新增看板存在、无等价重复 | `grep -rniE '证书看板\|cert.*dashboard\|过期倒计时\|expiring' web/` | PASS：`web/cert-lifecycle.js:241,260,434` 命中；`ssl.js` 仅 ssl 页内到期告警条（非看板），无等价能力 |
| ② 语法 | node --check exit 0 | `node --check web/cert-lifecycle.js` | PASS exit 0 |
| ③ 首屏 | frontend-check ≤307200 | `make frontend` | PASS：首屏 77175 字节 / 307200，余量 230025；dist 43 文件、无 source map |
| ④ ssl 契约 | 方法契约从源码核对 | 见下「契约核对」 | PASS：5 方法 + scheduler 全部字段对齐源码 |
| ⑤ commit | commit 不 push、首行带 agent 前缀 | `git commit -m "[agent:r23-certlife] ..." -- web/cert-lifecycle.js .agents/verify/r23-certlife.md` | 见提交记录 |

## 契约核对（从源码读，非猜测）
| 方法 | 权限(info.json v0.7.1) | 入参 | 返回字段（源码位置） | 看板用途 |
| --- | --- | --- | --- | --- |
| `ssl.list` | system:read | `{}` | `ListResult{certs:[CertInfo{domain,domains[],file,not_before,not_after,days_left,issuer,serial,key_type,key_bits,chain_length,fingerprint_sha256,self_signed,source,expired,expiring_soon,error}],count,storage}`（types.go:49-90） | 证书表 + SAN（domains）+ 排序 + 高亮 + 概览统计 |
| `ssl.bind.list` | system:read | `{}` | `BindingsResult{bindings:[SiteBinding{cert,site,note,created_at,updated_at,cert_path,key_path,cert_exists}],count,hint}`（binding.go:56-72） | 绑定站点列 + 解绑按钮启用判定 |
| `ssl.verify` | system:read | `{domain}` | `VerifyResult{reachable,host,address,matched,not_before,not_after,days_left,issuer,subject,serial,self_signed,chain_length,fingerprint_sha256,error}`（types.go:135-150） | 详情：指纹 / 链级数 / 序列号 / 握手校验 |
| `ssl.renew` | system:admin | `{domain,days?,days_before?}` | `RenewResult{CertInfo + renewed,skipped,backup_path}`（types.go:113-126） | 续期快捷操作（confirm 门） |
| `ssl.bind.remove` | system:admin | `{cert,site}` | 解析见 params.go:285；执行见 methods.go:204-214 | 解绑快捷操作（confirm 门） |
| `GET /api/v1/scheduler/tasks` | 内核 API | — | `data.tasks[]`（ssl.js:256 loadTasks 范式） | 自动续期开启状态 + 下次执行时间 |

**关键事实驱动**：`ssl.verify` 返回**没有 SAN 字段**；SAN 只存在于 `ssl.list.domains`（types.go:53）。看板详情里 SAN 取 `list.domains`，指纹/链/序列取 `verify`，不凭空造字段。

## G-28 产品定位自评（三问）
1. **本页解决什么用户问题**：证书过期会让网站 HTTPS 突然告警甚至中断，但此前只能进 ssl 页逐张看、到期告警条只显示聚合数字，看不到"哪张、什么时候、绑在哪个站点、有没有自动续期"。看板把全量证书按到期时间集中排序、≤30 天红色高亮、一眼定位风险，点开即看指纹/SAN/链，续期和解绑就地完成，不用在多个页之间来回跳。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔/1Panel 的 SSL 管理以"单站点证书"为中心，缺跨站点的全局到期资产视图；本看板补的是"全局资产 + 过期风险"这一层。差距/局限：本看板只做登记与状态展示，不替站点插件写 web 服务器配置（G-13 边界，解绑只删归属登记）；证书签发仍需到 ssl 页完成（空态已给跳转按钮）；未引入证书自动续期的可视化编排，自动续期状态只读展示内核任务。
3. **当前是"可用"还是"占位"**：**可用**（非占位）。数据来自真实插件方法（ssl.list / bind.list / verify），续期/解绑走真实 ssl 方法并有二次确认，高亮与排序基于真实 days_left；无 mock 数据、无"敬请期待"。局限是尚未接入双端运行截图（G-28 后置，见下）。

## G-28 截图（后置）
- 模块由 integration 在 SHELL_VIEWS 挂载路由 `cert-lifecycle` 后才能真机渲染；本任务交付时路由未接线，故截图后置，不伪造 mock 页面截图。
- 已同步 r23-integration：接线完成后提供截图窗口，落盘 `.agents/verify/screenshots/cert-lifecycle-desktop-*.png`（1440×900）/ `cert-lifecycle-mobile-*.png`（390×844），并在这里补回截图证据。
- 自评三问已在上方先行落盘，不依赖浏览器。

## 安全与纪律核对
- 无新增后端方法、无新依赖、无外链、无遥测；危险操作（续期/解绑）均 `window.confirm` 二次确认后才发请求。
- destroy() 移除事件监听 + 根节点 + 作废在途请求（gen 计数），切走再回来不污染。
- 手机适配：≤639px 表格转卡片（data-label 伪元素）、触摸目标 ≥44px。
- 首屏零侵入：模块懒加载，CSS 注入用唯一 id 幂等。
