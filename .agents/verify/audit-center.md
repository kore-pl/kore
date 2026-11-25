> 状态: done · 归属: feat-audit-center · 更新: 2026-11-25 · 里程碑: M0–M5
> 功能卡：audit-center（对标宝塔 / 1Panel 的「操作日志」）· 依据 [docs/PLUGIN-MATURITY.md](../../docs/PLUGIN-MATURITY.md) §3.3.1「操作审计入口」+ [AGENTS.md](../../AGENTS.md) G-28 / G-29 / G-33

# 操作审计中心：全量检索 + 异常识别 + 导出与留痕

## 1. 要解决什么（改造前事实，path:line 只认代码）

| 依据 | 改造前事实 |
| --- | --- |
| 本轮卡「按时间范围、操作人、动作、目标资源、结果筛选；关键字搜索；分页与总数」 | 后端只有 `since/action/order/limit` 四个入参（`git show HEAD:internal/core/httpapi/handlers_audit.go` 的 `AuditQuery`），**offset=0 处、total=0 处命中**；响应只有 `records/count/limit`，前端只能一次拉最多 1000 条后在本地筛 |
| 本轮卡「显著标出失败操作、高频操作、非工作时间、异常 IP；给值得关注聚合」 | `git show HEAD:web/audit.js | grep -c "insight"` = **0**、`grep -c "非工作时间"` = **0**；只有「时间 / 操作者 / 动作 / 目标 / 结果 / 详情」6 列平铺，失败行不额外标记 |
| 本轮卡「单条可展开详情（完整参数摘要、来源 IP、耗时、requestId）」 | 旧详情只把 `[{key,value}]` 摊成「键：值」文本（旧 `detailCell`）；没把 IP / 耗时 / 请求编号抽成可读字段 |
| 本轮卡「按当前筛选导出 CSV；手机适配」 | 旧 CSV 只导出**已加载到页面的快照**（旧 `doExport` 用 `filtered()`），超 1000 条或翻页外的记录导不出；旧表格手机端靠 `data-label` 堆叠（1 处），没有筛选条与分页的 44px 触摸目标 |
| 约束「只读查询增强，不改审计写入路径、不删除历史」 | 本轮 `internal/core/store/audit.go`、`audit_http.go`、`store.PutAudit` **零改动**；筛选全部在装配层读取侧完成（`cmd/kored/audit.go:29`），bbolt 结构与历史记录不变 |

## 2. 怎么做的（用户可见的四处补齐）

1. **全量检索（服务端筛选 + 真分页）**：`handlers_audit.go:56` 的 `AuditQuery` 新增 `Subject/Plugin/Result/Target/Keyword/OffHours/Offset`，`parseAuditQuery`（`:108`）校验 `result ∈ ok/denied/error/failed`、`offset ≤1000000`、文本筛选 ≤128 字符；响应新增 `total`（筛选后、分页前）与 `offset` 回显（`:43-53`）。`cmd/kored/audit.go:29` 在读取侧过滤：`failed` = 非成功（denied+error）、`target` 子串、`q` 覆盖动作/目标/操作者/插件/detail 键值（`auditKeywordMatch:98`）、`offhours=1` 按主机本地时间 18:00–次日 09:00 或周末（`auditOffHoursAt:124`）。**既有 since/action/order/limit 语义原样保留**，CLI `kored audit` 走同一适配器。
2. **异常识别「值得关注」**：`web/audit.js:351` 四张卡——失败/被拒（按动作 Top3）、高频操作（同一动作 60 秒内 ≥5 次，`analyze:152` 滑动窗口）、非工作时间（同一口径，前端只做展示，筛选仍走后端）、异常来源 IP（同一 detail.ip 失败 ≥3 次）。卡片可点击直接应用对应筛选（结果=failed / 动作 / offhours / 关键字+failed），不是只读装饰。窗口口径如实写在卡头上（「基于最近 N 条」）。
3. **单条详情关键字段**：`detailCell:383` 在原有完整参数摘要之上，把 **来源 IP / 耗时 / 请求编号** 抽成 chips，缺失时显示「未记录」（不臆造）。失败行左侧 3px 红条（`.audit-row-fail`）、非工作时间行带黄标。
4. **导出与分页**：`doExport:438` 按当前筛选**分页拉全量**（1000/请求，硬上限 10000 条，超出如实提示「只导出了前 N 条」），CSV 带 UTF-8 BOM + 10 列（含来源 IP/耗时/请求编号）并复用 RFC4180 转义；`pager:423` 服务端翻页「上一页/下一页 + 第 X–Y 条 / 共 N 条」，仅当 `total > 50` 时出现。手机端筛选控件 44px 触摸目标、表格卡片化（`web/audit.js:583` 起的媒体查询），无整页横向滚动。

**写域内改动（2 个 Go 文件 + 1 个前端 + 测试 + 文档）**：
`internal/core/httpapi/handlers_audit.go`、`internal/core/httpapi/{handlers_audit_test,audit_helpers_test,audit_e2e_test}.go`、`cmd/kored/audit.go`、`cmd/kored/audit_test.go`、`web/audit.js`、`docs/DATA-MODEL.md` §9（查询参数与 total/offset）。**未改** `web/settings.js`（与 feat-settings-polish 对齐：`mountAudit()` 契约、tab id `audit`、标签「操作审计」一字不动）、`web/app.js`、`audit_http.go`、`store/audit.go`；未新增 web 文件（`Makefile:85` / `web/embed.go:98` 原有登记即够）。

## 3. 门禁命令 + 退出码（本机实跑）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cd kore && node --check web/audit.js` | 0 | 无输出 |
| `GOWORK=off go test ./internal/core/httpapi/ ./cmd/kored/ ./internal/core/store/`（GOCACHE 指工作区） | 0 | 三包 `ok`（4.207s / 8.361s / 1.158s） |
| `GOWORK=off go vet ./internal/core/httpapi/... ./cmd/kored/...` | 0 | 无输出 |
| `make -s web-dist` + `bash scripts/frontend-check.sh` | 0 | 首屏 81528 B / 307200 B；dist 无 map/字体 |
| `bash scripts/secret-check.sh` | 0 | `0 FAIL / 22 处匹配（占位写法均合规）` |
| `make -s docs-check` | 0 | 5 pass / 1 warn / 0 fail（WARN 为既有，不阻断） |
| `bash scripts/usability-check.sh` | 1（存量） | `grep audit.js` **零命中**；FAIL 均来自其它轨道既有清单，本卡未新增 G-33 违规 |

## 4. 隔离实例真机取证（G-29：主实例 8787 全程未动）

| 项 | 值 |
| --- | --- |
| 实例 | 单次 bash 内 `mktemp` 式隔离实例：独立 `--config`，state/run/log 全在 `/tmp/kore-audit-iso2`，空闲端口自动选（457xx），跑完 `rm -rf`；主实例未改配置/未重启 |
| 数据 | 真实发起：1 次登录成功、3 次错误口令（denied）、安装并启用 echo 0.1.5、`POST /api/v1/invoke/echo/{ping,echo,slow,timeout}` 各 1 次（200，真实 duration 0/1001/3002ms）；另按 131 条种子补夜间 23:10–23:30 与周六 03:00 记录（含同 IP 3 连失败、6 条 60 秒内同动作）用于异常识别 |
| API | `page1_http=200`；`total=142 count=50 offset=0`、`offset=50 total=142 count=50`；`q=invoke.demo.paging → total=120 count=50`；`result=failed → total=7`；`offhours=1 → total=96`；第 1 页首条 13:06:30 / 第 2 页首条 00:26:30（分页真实位移） |
| UI（1440×900，真机点击） | 打开「设置 → 操作审计」：`共 143 条`；四张关注卡 `7 失败 / 1 高频 / 96 非工作时间 / 2 异常 IP`（早一轮 22 条数据时点击「非工作时间」卡 → 共 11 条（已筛选），卡片筛选链路真通）；分页 `第 1–50 条 / 共 143 条` → 下一页 `第 51–100 条 / 共 143 条`（HTTP 200）→ 上一页回第 1 页；关键字 `invoke.demo.paging` → `共 120 条（已筛选）`（跨页命中，不是当前 50 条本地过滤） |
| 导出 | 当前筛选（120 条）点「导出 CSV」→ 真实下载 `audit-20261125-130638.csv`，**12086 B / 121 行（120 条 + 表头）/ BOM efbbbf**；提示「已导出 120 条记录」——证明按筛选分页拉全量，而非只导当前页 |
| 详情 | 展开行：`来源 IP：127.0.0.x / 耗时：未记录 / 请求编号：未记录`（登录事件真实只有 IP；耗时与请求编号在现有写入面未落，前端如实显示「未记录」） |
| 手机（390×844） | 共 144 条；`documentElement.scrollWidth > innerWidth` = **false**；筛选控件实测高度 **44px**；选「失败（含被拒）」→ 共 7 条（已筛选）；展开详情后仍无横向溢出 |
| 控制台 | `pageerror` = 0。仅 5 条资源级 4xx，均与本卡无关且已定位：`401 /api/v1/system/info`（登录前探测，预期）+ 4 个 `404 /api/v1/invoke/{monitor,site,ssl,discover}`（隔离实例没装这些插件，概览页自身降级请求） |

## 5. G-28 双端截图（`file` 实测宽高 + md5）

| 场景 | 文件 | 实测 | md5 |
| --- | --- | --- | --- |
| 全量列表 + 值得关注 + 分页（143 条） | screenshots/audit-center-desktop-01.png | PNG 1440×2413（full-page） | efb734a8602b45c3dd2ad28817ddaaef |
| 下一页：第 51–100 条（真分页） | screenshots/audit-center-desktop-02.png | PNG 1440×2413（full-page） | ee31b0395438dd490f7aa3e6f1b58c01 |
| 关键字筛选 120 条 + 筛选态分页 | screenshots/audit-center-desktop-03.png | PNG 1440×2413（full-page） | d6464b3a78a70272a4553357ff766d54 |
| 筛选清除后展开详情（IP/耗时/请求编号 chips） | screenshots/audit-center-desktop-04.png | PNG 1440×3369（full-page） | 3552184565b3947d7fcb8b873d10c665 |
| 手机首屏（四卡 + 筛选条，390×844） | screenshots/audit-center-mobile-01.png | PNG 390×844 | e724d4c5eea6cf04a6ddcc393c8d49a7 |
| 手机「失败（含被拒）」筛选 + 详情展开 | screenshots/audit-center-mobile-02.png | PNG 390×844 | 96b7febafde9e5c031cdee24d8029a18 |

**产品定位自评三问**
1. **本页解决什么用户问题**：出问题时不用登机器翻日志——按人/动作/目标/结果/关键字在浏览器里定位「谁在什么时候对什么做了什么、成没成、耗时多少、从哪来」，并把失败、高频、非工作时间、异常 IP 主动挑出来，一眼看到该不该管。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔操作日志偏「列表 + 清空」，1Panel 日志中心偏运行日志、操作日志筛选维度少。本页已有：五维筛选 + 关键字跨字段（含 detail/IP）+ 服务端真分页与总数 + 四类异常聚合 + 当前筛选全量导出 CSV + 单条详情关键字段 + 手机卡片化。**仍差的**：无「按操作人/动作维度的趋势图」、无导出任务化（>10000 条需缩范围分批）、无审计检索结果的收藏/订阅；这些不在本卡范围。
3. **当前「可用」还是「占位」**：**可用**。隔离实例真机点通「筛选→翻页→导出（120 条真实文件）→详情→手机筛选」，API total/offset 数字与 UI 一致，0 页面错误。

## 6. 边界与未做（如实）

- **requestId 没有写入面**：DATA-MODEL §9 明确 `req_id` 尚未接入，HTTP 侧审计未落该字段；本轮按约束**不改写入路径**，前端只在 detail 里读到就展示、读不到显示「未记录」，不编造。
- **来源 IP 只有登录事件有**：invoke 审计写入面没有 ip（`audit_http.go:168-175` 只有 duration_ms / error_code），异常 IP 聚合因此只对 login.failed 生效——这是现有数据形状的边界，不是前端遗漏。
- **非工作时间按主机本地时区**（服务端过滤与前端展示同一口径）；跨时区部署时口径随主机时区，文档已写明。
- **「值得关注」窗口**：基于当前时间范围最近 1000 条（接口上限），卡头如实标注「基于最近 N 条」，不冒充全量统计。
- **未改审计写入 / 未删历史 / 未改 bbolt 结构**；`kored audit` CLI 参数与输出保持不变（`--since/--action/--limit/--csv`）。

## 7. 本轮未改动主实例运行态

未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`，未重启 8787；全部验证在 `/tmp` 隔离实例内完成，实例、临时二进制、种子脚本与 CSV 已删除；工作区新增仅本报告与 6 张截图。
