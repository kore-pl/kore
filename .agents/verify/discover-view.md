# discover 主壳视图 · G-28 双端证据（部分达成，数据层被阻塞）

> 执行者: [agent:discover-view] · 2026-11-23 · 隔离实例 `127.0.0.1:18866`（`/tmp/kore-dsc`，索引只读指向 `kore-plugins/index`，discover 0.3.1 由本地包安装）· 主实例 8787 零写入、未重启
> 结论: **导航入口与视图注册已真机验证**；**概览/端口表格的数据层未渲染出真实数据**，被 CSRF 令牌缺失阻塞（见 §3），故 G-28 判 **PARTIAL / BLOCKED**，不声明完成。

## 1. API 路径（带方法前缀）curl 原文

```
POST http://127.0.0.1:18866/api/v1/invoke/discover/discover.summary   [HTTP=200]
{"ready":true,"web_server":"nginx","db":"mariadb","conclusion":"本机已就绪：检测到 Nginx 与 MariaDB，可直接安装站点与数据库插件。","suggestions":[{"plugin":"site",...},{"plugin":"db-mysql",...},{"plugin":"redis",...},{"plugin":"container",...}]}

POST http://127.0.0.1:18866/api/v1/invoke/discover/discover.ports     [HTTP=200]
[{"port":22,"addr":"0.0.0.0","family":"ipv4","listening":true,"process":null},{"port":3306,...},{"port":6379,...},...]

GET  http://127.0.0.1:18866/assets/discover.js                        HTTP=200
```

方法前缀 `discover.` 与路径 `/api/v1/invoke/discover/` 均正确，`/assets/discover.js` 由新二进制 embed 提供（200）。

## 2. 截图（`file` 实测宽高）

| 画面 | 文件 | 实测 |
| --- | --- | --- |
| 导航入口 + 视图框架（PC 1440×900 full-page） | `screenshots/discover-view-desktop-01.png` | PNG **1440×1068**（full-page 高度 1068）｜107087 bytes |
| 同上，手机 390×844 | `screenshots/discover-view-mobile-01.png` | PNG **390×1257**（full-page 高度 1257）｜71897 bytes |

画面里可核对：左侧导航「平台」组出现**服务发现**（DOM 校验 `服务发现` 导航节点命中 2 处：侧栏 + 移动抽屉）、视图标题「服务发现」、以及三块 panel 骨架（概览 / 监听端口 / 服务清单）。

## 3. 未截到的与原因（不拿错图凑）

- **② 概览（真实 summary 数据）**：未截到。页面三块 panel 全部落到「读取失败」空态；根因不在 discover.js 的数据映射（curl 同路径 200 有数据），而在**浏览器侧 CSRF 令牌缺失**：
  - `document.cookie` 为**空**（实测），`invoke()` 取不到 `kore_csrf` → 前端直接拒绝发请求；
  - 手工带空 `X-Kore-CSRF` 打 `POST /api/v1/invoke/discover/discover.summary` → **401**；
  - 同一浏览器里概览页的 monitor 请求也报「插件请求失败」——**这是全局现象，不是 discover 独有**，指向最近 `auth-nopass` 改造后浏览器会话不再下发可读 `kore_csrf`（`web/app.js:60` 明确按「kore_csrf 非 HttpOnly」读取）。
- **③ 端口表格（有数据）**：未截到，原因同上（表格在数据回来后才有行）。
- **④ 降级态（插件未装 → 去商店）**：未截到。禁用插件后重截，画面与故障态**逐字节相同**（107087 bytes 一致），说明错误发生在发请求之前（缺令牌），因此**无法区分**「未装」与「CSRF 缺失」。已删除该重复图，不冒充降级证据。
- **移动端入口**：手机截图 `navAny=3`（含抽屉内节点），但抽屉默认收起，截图里未展开抽屉；入口证明以 PC 侧栏为准。

## 4. 自评三问（G-28 ③）

1. **解决什么用户问题**：装完 discover 插件后，用户第一次知道「这台机器上已经有什么、在听哪些端口」，并据此决定下一个该装哪个插件（`summary.suggestions` 直接给理由）。此前该能力零入口，属于死能力。
2. **与宝塔 / 1Panel 差距**：宝塔把「已装环境」折进软件商店卡片、1Panel 有独立的「主机 / 监控」页；本页是**只读探测 + 安装引导**，没有「一键装 nginx/MySQL」的落地下发（那是商店与各插件的职责）。差距在：无可视化拓扑、无历史趋势、无端口归属变更告警；优势是不依赖任何 agent 常驻、不装插件不占资源。
3. **当前状态**：**占位（不可用）**——导航已可达、视图框架已渲染，但数据层被 §3 的 CSRF 缺陷阻塞，用户此刻打开只会看到「读取失败」。修掉令牌来源后可立即转为「可用」，无需再改 discover.js 的数据映射（字段已按 `summary` / `ports` / `services` 真实返回对齐，curl 侧已证有数据）。

## 5. 给后续修复的最小线索

- 优先核对 `auth-nopass` 改造后浏览器是否仍下发**非 HttpOnly 的 `kore_csrf`**（`web/app.js:60,113` 依赖它）；若改为 HttpOnly，则所有视图（dns/firewall/waf…）的 `cookie('kore_csrf')` 取法都要统一改，属于跨视图一次修复。
- 未验证项：真实数据下的端口表格渲染、空态按钮、降级三态、639px 卡片化布局在真机上的观感。
