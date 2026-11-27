# UI P2 双端自证（G-28）· 2026-11-27

Owner：`ui-p2`（task-163）｜方案真源：`docs/DESIGN-REDUCTION.md` §2.5 / §2.4 / §10，C7 见 `docs/DESIGN-SYSTEM.md:120`｜
隔离实例：`127.0.0.1:18952`（独立 config / state / run / log / 密码哈希，非 8787；收工已关闭）。

**G-29 声明**：本轮**未改动**主实例 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` /
`bin/kored` 的运行态行为，未重启 8787。隔离配置由主配置的副本改端口/目录而来；
`bin/kored` 因源码变更重建（代码产物）并用新二进制起隔离实例，主实例进程未受影响。
隔离数据、GOCACHE / GOMODCACHE、截图脚本与浏览器 profile 全部落工作区临时目录 `.iso-p2-tmp/`，收工删除。
离线安装用的插件 tar.gz 来自兄弟仓 `kore-plugin-*/dist/` 的本地文件，未联网下载。

## 截图清单（真实 headless 浏览器，非设计稿、非同图缩放）

工具：本地缓存 `playwright` 1.49.1 + `chrome-headless-shell-1255`，`--headless`；
PC 1440×900 / 手机 390×844 视口，`deviceScaleFactor=1`，手机 `isMobile/hasTouch=true`。
登录走真实表单（本地隔离实例口令），首屏后关掉新手引导弹层；插件/文件视图是隔离实例真实数据
（插件 echo/discover/file 由本地 tar.gz 离线安装，文件视图为实例可见的真实目录）。

| 文件 | `identify -format '%wx%h'` 实测 | 场景 |
| --- | --- | --- |
| `screenshots/ui-p2-desktop-01-plugins-default.png` | 1440×900 | PC 插件管理默认态（每行 2 按钮 + 表头勾选框） |
| `screenshots/ui-p2-desktop-01-plugins-viewport.png` | 1440×900 | PC 插件管理精确视口 |
| `screenshots/ui-p2-desktop-02-plugins-detail-batch.png` | 1440×900 | PC 详情展开 + 批量态（已选全部插件） |
| `screenshots/ui-p2-desktop-03-files-default.png` | 1440×2120 | PC 文件列表 full-page（目录行只有 ⋯） |
| `screenshots/ui-p2-desktop-03-files-viewport.png` | 1440×900 | PC 文件列表精确视口 |
| `screenshots/ui-p2-desktop-04-files-menu.png` | 1440×900 | PC ⋯ 菜单展开（6 项全量可达） |
| `screenshots/ui-p2-mobile-01-plugins-default.png` | 390×1339 | 手机插件管理 full-page |
| `screenshots/ui-p2-mobile-01-plugins-viewport.png` | 390×844 | 手机插件管理精确视口 |
| `screenshots/ui-p2-mobile-02-plugins-detail-batch.png` | 390×1612 | 手机详情 + 批量态 |
| `screenshots/ui-p2-mobile-03-files-default.png` | 390×5664 | 手机文件列表 full-page |
| `screenshots/ui-p2-mobile-03-files-viewport.png` | 390×844 | 手机文件列表精确视口 |
| `screenshots/ui-p2-mobile-04-files-menu.png` | 390×844 | 手机 ⋯ 菜单展开 |

`identify` 批读命令：`identify -format '%wx%h' .agents/verify/screenshots/ui-p2-*.png`；
12 张截图桌面视口一律 1440×900、手机视口一律 390×844，full-page  taller 属正常滚动高度，
非同图缩放冒充双端。

## DOM 实测（before → after，桌面与手机同值）

用 headless Chrome + stub `KoreCtx`（真实 `web/dist` 模块，注入可控插件/文件数据）精确计数可见按钮：

| 项 | 改前 | 改后 | 判据 |
| --- | --- | --- | --- |
| 插件行按钮（3 行） | `[4,5,4]`（设置 / 启停 / [升级] / 卸载 / ping） | **`[2,2,2]` = 启停 + 详情** | ≤2 ✅ |
| 文件目录行按钮 | 6（桌面）/ 7（手机含 ⋯） | **1（⋯）** | ≤2 ✅ |
| 文件普通行按钮 | 7 / 8（手机） | **2（下载 + ⋯）** | ≤2 ✅ |
| 文件归档行按钮 | 8 / 9（手机） | **2（下载 + ⋯，解压进 ⋯）** | ≤2 ✅ |

真机（隔离实例）DOM 复核：插件 3 行操作依次 `[启用,详情]` / `[启用,详情]` / `[停用,详情]`；
点「详情」后展开独立详情行，按钮 = 设置 / 卸载 / 调用 ping（可升级插件另有「升级」）；
表头勾选框全选后批量条 `hidden=false`，按钮 = 批量升级 / 批量启用 / 批量停用；
文件目录行可见按钮只有 `['⋯']`，点开 ⋯ 菜单 6 项 =
`改名 / 复制到… / 属性 / 权限 / 移动 / 删除（进回收站）`，桌面与手机一致。

context 栏（勾选后出现）按钮：`压缩 / 批量删除（进回收站） / 批量移动 / 改名 / 复制到 / 属性`，
与 ⋯ 菜单、详情抽屉双通道覆盖全部原行内操作，功能零删减。

## danger 配色回归（C7）

用 `getComputedStyle` 实测（浅色主题）：

| 操作 | 类名/颜色 | 判定 |
| --- | --- | --- |
| 删除条目（进回收站，可恢复） | `rgb(157,167,179)` 中性灰 | ✅ 可逆无红 |
| 批量删除（进回收站，可恢复） | disabled 态 `rgb(125,133,144)`，启用后中性灰 | ✅ 可逆无红 |
| 插件批量停用（随时再启用） | `plugin-batch-muted`，`rgb(157,167,179)` | ✅ 可逆无红 |
| 解封 IP（sshguard / waf，可再封禁） | `sg-unban` / `waf-unban` 中性灰令牌 | ✅ 可逆无红 |
| 退出登录（仅结束当前会话） | `settings-neutral` 中性灰，仍保留确认弹层 | ✅ 可逆无红 |
| 插件卸载（删程序文件，不可撤销） | 保留 `var(--kore-danger)` 红 + 二次确认 | ✅ 不可逆保留红 |
| 回收站彻底删除 / 清空（不可恢复） | 保留 `files-del` 红 + 勾选「不可恢复」确认 | ✅ 不可逆保留红 |

边界项裁决见 `docs/DESIGN-REDUCTION.md` §10.2：批量重启 / 停用防火墙 / WAF 关防护 / 结束进程
均属高风险语境，保留红 + 二次确认；批量停用站点 / 插件、解封、退出登录属纯可逆，改中性灰但仍保留确认。

## 门禁证据

- `node --check`：`web/plugins-view.js` / `web/files.js` / `web/batch.js` / `web/sshguard.js` /
  `web/waf.js` / `web/settings.js` 六文件全 exit 0。
- `make frontend` exit 0：首屏 gzip 91,092 B ≤ 307,200 B（300 KiB）；>90,000 绝对线的
  WARN 是 P1 存量基线漂移（+168 B），非本轮新增 FAIL。
- `bash scripts/usability-check.sh --self-test` exit 0；`bash scripts/usability-check.sh` exit 1，
  18 条 FAIL 全为 A1「ZeroParam 真跑失败」（沙箱 go-build 缓存只读，与 P0/P1 同一组存量违规），
  **本期改动文件零新增 FAIL**（`grep '^\[FAIL\]' | grep <changed files>` 无命中）。
- `make build` exit 0（GOMODCACHE/GOCACHE 落隔离目录，依赖走已授权 goproxy），用于生成隔离实例二进制。

## 自评三问（原文）

**问 1：本页解决什么用户问题？**
直击用户最早的反馈「界面完全是在为了堆砌而堆砌」。插件管理原先每行 4–5 个按钮平铺，
N 行插件就是一屏密密麻麻的操作；文件管理每行 6–8 个按钮，目录和文件同权重堆在一起。
改后插件行只剩「启停 + 详情」两个主操作，设置 / 升级 / 卸载 / ping 收进详情抽屉，
表头勾选后才出现批量操作条；文件行只留「下载 + ⋯」（目录只有 ⋯），其余操作进 ⋯ 菜单
与勾选后的 context 栏，桌面手机同一套。同时治理 danger 通胀：凡是可逆的删除/停用/解封/退出登录
一律改中性灰，危险红只留给不可逆/高风险且带二次确认的操作。每一处被移走的控件都有明确归宿
（详情 / ⋯ / 批量态 / context 栏），功能一个没删，常驻一级控件一个没加。

**问 2：与宝塔、1Panel 同类功能的差距？**
宝塔 / 1Panel 的管理页普遍把行操作做成一排图标按钮常显，胜在「一眼看到全部」，
代价是每行按钮多、窄屏拥挤、红绿危险色混用。Kore 用「高频行内 + 次级下沉」的层次换掉平铺：
启停（插件）/ 下载（文件）保持一次点击，其余操作多 1 次点击（详情 / ⋯）。
与同类相比的客观差距：新用户第一次找「卸载 / 权限 / 移动」会多一次点击、需要学习「⋯ 里还有操作」；
我们没有采用图标按钮（保持零框架纯文本按钮），层级靠文案与分区而非图标语义。
优势：手机端不再横向挤按钮，危险红不再被常规操作稀释，首屏 gzip 91 KiB 远低于 300 KiB，
没有为界面增加常驻进程或依赖。本轮未撤销手机隐藏帮助 / 快捷键补丁（`web/app.js` 不在写域），
这是与「顶栏 4 控件」设计目标残留的一处差距，已登记 §10.4 后续卡。

**问 3：当前「可用」还是「占位」？**
**可用。** 判据：双端截图来自隔离实例真实浏览器与真实登录，插件由本地 tar.gz 离线安装、
文件视图展示实例真实目录；DOM 实测插件行 5/4→2、目录行 6→1、文件行 7→2，
详情抽屉与 ⋯ 菜单的按钮清单逐项核对全量可达；批量条在勾选后出现且「批量停用」实测中性灰；
删除/卸载/彻底删除的配色按可逆性分流并经 `getComputedStyle` 复核。所有操作仍走既有 API
（启停 POST /enable|disable、卸载 DELETE、批量启停逐条 POST、file.* invoke），
CSRF 双提交、二次确认（卸载 / 彻底删除）均未改动，不是演示壳。
`node --check` 六文件全绿、`make frontend` exit 0 且首屏 ≤300 KiB、usability-check 无新增 FAIL；
A1 存量 18 FAIL 与首屏 WARN 均在写域之外，按用户裁决的渐进口径不判 BLOCKED。
