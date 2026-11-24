# DNS 写路径前端接线 · G-28 双端证据

Owner: `feat-plugin-dns`｜日期：2026-11-24｜写域：`web/dns.js` + 本证据文件

## 1. 缺口清单（path:line）

| 后端方法声明 | 前端缺口（改动前） |
| --- | --- |
| `kore-plugin-dns/internal/dnsop/call.go:15-17` + `info.json` method_capabilities 11 条（含 `dns.record.add/update/delete`、`dns.addRecord/updateRecord/deleteRecord`、`dns.reload`） | `kore/web/dns.js:263-274,357-392,500-528`（改动前）只调 `dns.status / dns.zones / dns.records / dns.query` 四个只读方法，7 个写方法 + reload 零调用；记录面板写「只读视图……本页不提供编辑入口」。 |

## 2. 补齐功能

- `web/dns.js` 新增「增删记录」面板：区域（点击区域表自动填）/记录名/类型（A/AAAA/CNAME/MX/TXT/SRV）/值/旧值前置条件/TTL，操作下拉选增/改/删；提交前客户端校验 + 二次确认；写后自动刷新记录表，展示 `changed/verified/rolled_back/reload_required` 真实结果；错误优先显示后端 `hint/detail.hint`。
- 记录表每条可写类型提供「改值/删除」按钮，一键把表单填好。
- 新增「重新加载 DNS 服务」面板接 `dns.reload`（可选 zone），明示「记录写入不需要 reload，只有手工改 zone 文件才需要」。
- 手机端：表单单列、触摸目标 ≥44px，无框架。

## 3. G-28 双端截图

| 视口 | 文件 | `file` 实测 |
| --- | --- | --- |
| PC 1440×900 | `.agents/verify/screenshots/dns-feature-write-desktop-05.png` | 1440×900 PNG |
| 手机 390×844 | `.agents/verify/screenshots/dns-feature-write-mobile-05.png` | 390×844 PNG |

md5：desktop `f5b4abe22984a8c5fda11e134f100607` / mobile `c0923b824d90571996e5e62c13edf632`（全异）。
截图来自 `git archive HEAD` + 本改动 `web/dns.js` 的隔离实例（端口 18897，state/run/log/config 全落 `/tmp/dsh-dns-shots`），真实登录表单 + 真实点击导航到「安全 → DNS 解析」，已安装并启用 dns 0.5.2（isolated state.db），非设计稿、非同图缩放。**本轮未改主实例 8787 的运行态配置 / state / bin**（G-29）。

## 4. 产品定位自评（三问）

1. 解决什么问题：之前 DNS 页只能看，后端 7 个写方法与 reload 没有入口；现在用户在面板里就能增/改/删区域记录、按需重载服务，写操作零参数前置（表单已自动填区域与示例），错误给「怎么办」。
2. 与宝塔/1Panel 差距：它们内置 DNS 服务与 zone 生命周期管理；Kore 按 ADR-0051 刻意不提供「新建 zone」按钮（需一次性 CLI 配置 TSIG + allow-update），能力边界是「管理已有 bind9 区域的记录」，不内建 DNS 服务。
3. 当前状态：**可用**（有真实后端写路径 + 二次确认 + 回读结果；本机无 bind9/TSIG，写操作真机端到端未验证，界面与交互已验证）。

## 5. 验证

- `node --check web/dns.js` exit 0。
- `GOWORK=off go test -timeout 200s ./...`（kore 仓，GOCACHE 落 /tmp）exit 0，17 包 ok。
- `GOWORK=off go test -timeout 200s ./...`（kore-plugin-dns 仓）exit 0，含 fault/live 用例。
- `make secret-check` exit 0（0 FAIL）。
- 写操作端到端真机（bind9 + TSIG）本机无服务，未验证，如实标注。
