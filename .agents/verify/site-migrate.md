# 站点迁移（宝塔 / 1Panel → Kore）· 交付与验收

日期：2026-11-25 11:25–12:00（Asia/Shanghai）｜Owner：`feat-site-migrate`｜写域：`kore` 主壳（web 视图 + httpapi 只读扫描端点）
竞品清单条目 7（P2，用户价值高）：**从宝塔面板 / 1Panel 导入站点与 SSL 配置，让用户敢换面板。**

## 0. 结论先行

| 项 | 结果 |
| --- | --- |
| 用户得到什么 | 网站 → **站点迁移** 页：自动检测本机宝塔/1Panel → 一次扫描出所有站点（域名/类型/根目录/PHP/HTTPS）→ 逐条写清「能搬 / 不能搬 + 为什么 + 怎么办」→ 勾选 → **确认导入** → 逐条建站并回读校验 |
| 真机结果 | 隔离实例（/tmp 配置、独立端口）真机点击：宝塔样例 **5/5 建站成功**，1Panel 样例 **2/2 建站成功**，生成的 vhost 片段落在隔离 conf.d（见 §3） |
| 双端截图 | [desktop-01](screenshots/site-migrate-desktop-01.png) · [desktop-02](screenshots/site-migrate-desktop-02.png) · [mobile-01](screenshots/site-migrate-mobile-01.png) · [mobile-02](screenshots/site-migrate-mobile-02.png)（1440×1585/2158、390×1840/2288，`identify` 实测） |
| 门禁 | `go vet` / `go test ./...`（17 包全绿）+ `pkg/pluginapi` 全绿 / `node --check` / `make secret-check` 0 FAIL / `make frontend` 首屏 81 528 B ≤ 307 200 B |
| 未改主实例 | 全程未碰 `.kore-local.yaml`、主 state/run、主 `bin/kored`、未重启 8787；全部证据来自 `/tmp` 隔离实例 |

## 1. 关键决策：做成插件仓（a）还是主壳向导 + 只读解析后端（b）→ 选 **b**

| 维度 | a) 新插件仓 `kore-plugin-migrate` | b) 主壳迁移向导 + 只读解析后端（**选它**） |
| --- | --- | --- |
| 交付成本 | 要建九件套 + `info.json` 14 必填字段 + `manifest.json` + dist 两打 + 进索引 + 重签；本轮纪律明令「不重建 dist / 不入索引 / 不重签」，且新仓要过 G-17/G-26 全链 | 2 个 Go 文件 + 1 个视图 + 4 处小改动，一处检查点即可交付 |
| 架构契合 | 迁移是**一次性适配**，做成常驻插件等于为一次性动作养一个进程（G-03 常驻 ≤3 槽，代价最高的那类） | 主壳已有 `handlers_migrate.go`（跨机配置迁移）、`handlers_disk.go`（只读盘点）两个同类先例；本后端**只读解析、零写、不 import 任何插件包** |
| 能力归属 | 建站要重复实现 site 插件的 vhost 渲染/校验/回滚 | **建站仍走 `site` 插件自己的 `site.create` / `bindSSL` / `status`**——权限、审计、`nginx -t`、定向回滚都在插件侧，迁移只是"调用方" |
| 退出成本 | 迁完还得让用户卸载一个插件 | 页面留着不占资源（懒加载视图，不进首屏）；后端仅一个 GET |

**因此**：本次交付 = 只读解析后端（`GET /api/v1/site-import/scan`）+ 懒加载视图 `web/site-migrate.js`；写动作一律复用 site 插件的既有方法，**未改 kore-plugin-site 一行**。

## 2. 依据（path:line）

**后端（只读）**
- `internal/core/httpapi/siteimport_parse.go:1-40` —— 只读适配层红线：只 `os.ReadDir/WalkDir/ReadFile`、不执行命令、不碰 nginx、不读源面板 SQLite（G-02 禁 sqlite 依赖）、无定时器（G-19）、DTO 显式（G-24）
- `internal/core/httpapi/siteimport_parse.go:63-175` —— nginx 极简语法树：`#` 注释、引号内空白/分号不分隔、花括号不配对报错（不静默产出错站点）
- `internal/core/httpapi/siteimport_parse.go:246-345` —— server 块抽取：`server_name`（含引号串多域名）、`listen`（`443 ssl http2`/`1.2.3.4:8080`/`[::]:80`）、server 级 `root` 优先、`ssl_certificate(-_key)`、`proxy_pass`、`enable-php-74.conf`/`php-cgi-74.sock` → PHP 7.4、`php8.2-fpm.sock` → 8.2
- `internal/core/httpapi/siteimport_parse.go:400-470` —— 面板定位：宝塔 `/www/server/panel/vhost/nginx`、1Panel `/opt/1panel/apps/openresty/openresty/conf/conf.d`（含 `www/sites`、`apps` 兜底），递归深度 ≤5、文件 ≤240、单文件 ≤1 MiB
- `internal/core/httpapi/handlers_site_import.go:53-96` —— 对外 DTO（`siteImportSite` 等，全部显式字段）
- `internal/core/httpapi/handlers_site_import.go:126-230` —— 扫描主流程：定位 → 解析 → 合并 80/443 双块 → 标注不可导入
- `internal/core/httpapi/handlers_site_import.go:414-470` —— `koreDomainOK` 与 site 插件同口径域名判定；blockers 的 `reason` + `hint`（"为什么不支持 + 怎么办"）
- `internal/core/httpapi/handlers_site_import.go:470-520` —— 同域名重复（两个文件各写一次）自动标为不可导入
- `internal/core/httpapi/server.go:365-366` —— 路由独立注册（沿用 `handlers_logalerts.go` 的并行写域约定，不写 `handlers.go` 的 `routes()`）

**前端**
- `web/site-migrate.js:1-16` —— 页面定位与边界（只读、显式确认、不猜）
- `web/site-migrate.js:200-330` —— 三步向导骨架（识别来源 / 预览勾选 / 导入与校验），打开即自动检测
- `web/site-migrate.js:430-520` —— 预览表：可导入/需先处理 + 原因 + 怎么办 + 原站备注（别名、PHP 版本、上游、证书是否可用、监听端口）
- `web/site-migrate.js:560-660` —— 导入链路：`site.create` → PHP 不可用时降级为静态站并**明确写"PHP 没开"**（不把"建了站"当成"PHP 也搬过来了"）→ 证书可读时 `site.bindSSL` 尽力绑定
- `web/site-migrate.js:660-720` —— 导入后逐条 `site.status` 回读：配置是否写入 / 语法校验 / 网站目录三态
- `web/site-migrate.js:120-190` —— 私有 CSS（`smg-` 前缀，手机 390 宽无横向溢出、触摸目标 44px）
- `web/app.js:2308`（SHELL_VIEWS 登记）、`web/app.js:2331`（网站 hub 子视图）、`Makefile:85`（WEB_SRC_FILES）、`web/embed.go:86,98`（embed 清单）

**测试**
- `internal/core/httpapi/handlers_site_import_test.go` —— 10 个用例：宝塔静态/PHP/反代、80+443 合并、1Panel OpenResty、占位域名与变量根目录两条 blocker、花括号不配对拒绝、引号内多域名、目录扫描（含坏文件与无 server 块文件进 skipped、同域名重复标出）、端点 200/400 与未指定目录时的自动检测

## 3. 真机验收（隔离实例 + /tmp 样例 + 浏览器真点击）

**环境**（一条命令内完成构建/起实例/点击/收尾，临时目录用完即删）
```text
$ make -s web-dist && CGO_ENABLED=0 GOWORK=off go build -trimpath -ldflags '-s -w' -o /tmp/sm-e2e/bin/kored ./cmd/kored
exit 0（kored sha256 前缀 76d121753229805b）

实例：--config /tmp/sm-e2e/config.yaml（state/run/log 全 /tmp），addr 127.0.0.1:18991
env: KORE_NGINX_MODE=off KORE_SITE_CONF_DIR=/tmp/sm-e2e/site-conf
  （off = 本机没有 nginx，显式关校验/重载，让 UI 走「未校验」标注分支；
   不用 host 模式：host 模式下 site 插件会真跑 nginx -t 而失败回滚，反而测不到写链路）
healthz → 200；admin-password --set --stdin → 0；POST /auth/login → {"authenticated":true}
主实例复核：本轮未改 .kore-local.yaml / 主 state / 主 bin/kored，未重启 8787
```

**只读扫描（宝塔布局 /tmp/sm-e2e/fixture/bt，6 个样例 conf）**
```text
GET /api/v1/site-import/scan?root=/tmp/sm-e2e/fixture/bt
panel= bt 宝塔面板 scanned= 4 sites= 5 skipped= 2
  - demo-bt.kore.test  static  importable=True   (另有 1 个别名)
  - php-bt.kore.test   php     php=7.4
  - proxy-bt.kore.test proxy   upstream=http://127.0.0.1:3000
  - dup-bt.kore.test / dup2-bt.kore.test（同文件两个不同域名 → 拆成两个站点）
  ! broken.conf → 解析失败：配置块的花括号不配对，可能不是 nginx 站点配置 → 怎么办：先在原面板确认该文件能被 nginx 正常加载，或对照文件在「网站」页手工创建
  ! upstream-only.conf → 该文件不含 server 块 → 怎么办：无需导入，直接忽略
GET /api/v1/site-import/scan?root=/tmp/sm-e2e/fixture/1panel
panel= 1panel 1Panel sites= 2（blog-1p 静态 / panel-1p PHP 8.2）
```

**浏览器真点击（playwright，真实 UI + 真实后端 + 真实 site 插件）**
```text
桌面 1440×900：路由 sites/site-migrate 激活 → 关掉新手引导遮罩（点「以后再看」）→
  「自定义目录」→ 填 /tmp/sm-e2e/fixture/bt → 「扫描该目录」→ 5 行表 →
  「导入选中（5 个）」→「确认导入」→ 等「导入完成」→ 5 条结果卡
  results=5 okResults=5 pageErrors=[] badResponses=[]
手机 390×844：同流程，目录 /tmp/sm-e2e/fixture/1panel → results=2 okResults=2 pageErrors=[]
```

**导入产物（隔离 conf.d 实测）**
```text
$ ls /tmp/sm-e2e/site-conf
kore-site-demo-bt.kore.test.conf  kore-site-php-bt.kore.test.conf  kore-site-proxy-bt.kore.test.conf
kore-site-dup-bt.kore.test.conf   kore-site-dup2-bt.kore.test.conf kore-site-blog-1p.kore.test.conf
kore-site-panel-1p.kore.test.conf kore-site-probe-sm.kore.test.conf kore-site-manifest.json

$ head -12 kore-site-demo-bt.kore.test.conf
# kore-plugin-site managed vhost for demo-bt.kore.test
server { listen 80; server_name demo-bt.kore.test; root /www/wwwroot/demo-bt.kore.test;
         index index.html; location / { try_files $uri $uri/ =404; } }
```

**诚实标注（本轮真实上限）**
- 本机**没有 nginx**：`nginx -t` 与 reload 未执行，UI 逐条显示「语法校验 未执行（本机没有 nginx）」+ 回读「nginx 情况：nginx_mode=off」，**没有假装通过**；
- 隔离实例装的是索引里的 `site` **0.4.4**（本地 dist，不走网络）：其 `create` 不认 `php_version`，php-bt 落成静态站——UI 立刻回读并写明「启用 PHP 7.4：建站回读没有 PHP 配置……到站点详情「PHP」里选一次版本（先到「运行环境」装 PHP 7.4）」，即"PHP 没搬过来"这件事用户看得到，不会误以为搬全了。

## 4. G-28 产品定位自评（三问）

1. **这页解决什么用户问题**：换面板最贵的一步不是装 Kore，而是"把现有站点搬过来"。本页把"能不能搬"从猜测变成清单：一次看清域名/类型/根目录/PHP/HTTPS，不能搬的当场给出原因和下一步，用户才敢下手。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔的迁移工具偏"整机搬"（打包整站 + 数据库），1Panel 主要靠备份恢复；Kore 这一版只做**站点配置**这一块（不含数据库数据搬迁、不迁移 SSL 私钥本体，只给可用性判断与绑定建议）。差距：站点数量大时缺"分批进度/断点续传"；优势：**逐条给"为什么不支持 + 怎么办"**，而不是失败即黑盒。
3. **当前「可用」还是「占位」**：**可用**（真机跑通建站 + 回读校验）。有两条必须写明的边界：① 本机无 nginx 时只写配置不校验；② 依赖 `site` 插件已安装（未装时预览/勾选仍可用，导入会逐条报"插件 site 未安装"并给去商店的下一步）。

## 5. 不支持项与"怎么办"（同时是 UI 文案真源）

| 情况 | 为什么不支持 | 怎么办（UI 原话） |
| --- | --- | --- |
| 源面板把站点元数据放 SQLite（宝塔 / 1Panel 都有） | 读它要 sqlite 依赖（G-02 禁新依赖），且要处理版本迁移与锁 | 不读库，只读对方面板**为每个站点写出的 nginx conf**（宝塔/1Panel 都会写），元数据够用 |
| `server_name _` / 通配 `*.x.com` / 下划线域名 | site 插件域名规则不接受（防路径穿越与非法 Server 头） | 「这些域名 Kore 不能直接建站：…（例：下划线、通配符或占位名）；导入后请在站点详情里手工添加」 |
| 根目录是变量（`$host` 等） | 无法确定真实目录，猜一个等于给错站点 | 标为不可导入：「请到「网站」页手工创建站点并把根目录填成实际路径」 |
| 同一域名在多个 conf 里各写一次 | 直接导入会互相覆盖 | 自动标出：「域名 x 与 <另一文件> 重复……先确认哪个文件生效，把废弃的移走后再扫一次」 |
| 多域名站点（别名） | site 插件建站按主域名写 vhost | 「导入只写主域名 x，别名需在站点详情手工添加」 |
| 反向代理上游 | 迁移只建站，上游要按 Kore 的写法重新保存 | 「上游地址需在站点详情「反向代理」里重新保存」 |
| SSL 私钥 | 私钥本体不搬（不读别人私钥是硬边界） | 证书在本机可读 → 导入后一键绑定；不可读 → 「导入后需重新签发或上传证书」 |
| 源面板数据库、定时任务、伪静态规则、FTP/数据库账号 | 本轮范围只含站点与 SSL 判断（最小可用） | 页面不承诺；迁移后按「网站/计划任务/数据库」页各自重建，报告与卡片都写明范围 |

## 6. 已知限制与后续（不阻塞本轮）

1. **1Panel 部分老版本**把站点写在自己 SQLite（`1Panel.db`）而非 conf.d：本页扫不到时会给"该目录下没有找到 .conf"的空态与自定义目录入口，不假装支持。
2. 站点很多（>240 个 conf）时分页/进度未做，超限只给 WARN 与"缩小目录再扫"。
3. PHP 版本搬过来依赖本机已装同名版本（`运行环境`），脚本级差异（`fastcgi_param` 自定义）不搬。
4. ROADMAP 旧口径冲突：`docs/ROADMAP.md:262` 仍写「v1 明确不做一键迁移导入」——本轮按任务卡实现，建议 docs 侧同步该行（docs 属 docs-maturity-sync 写域，已同步该 peer）。

## 7. 门禁证据

```text
$ GOCACHE=… GOWORK=off go vet ./...                        → exit 0（无输出）
$ GOCACHE=… GOWORK=off go test -timeout 200s ./...         → exit 0（17 包 ok，httpapi 3.760s）
$ cd pkg/pluginapi && go test -timeout 200s ./...          → exit 0（2 包 ok）
$ node --check web/site-migrate.js && node --check web/app.js → exit 0
$ make -s secret-check                                     → 0 FAIL / 22 处匹配（占位写法均合规）
$ make -s frontend                                         → 首屏 81528 B / 307200 B（300 KiB）达标；i18n 增量 2922 / 3072 B
$ bash scripts/usability-check.sh                          → 无 site-migrate 相关条目（A1/A3 的 FAIL 均来自插件仓存量，pending 清单另有 agent 在改）
$ make -s web-dist                                         → web/dist/site-migrate.js 35785 B（懒加载，不进首屏）
```

## 8. 一句话

**换面板最贵的那一步现在有界面了：自动认出宝塔 / 1Panel，把每个站点能不能搬、为什么不能、下一步怎么办逐条摊开，勾选后真建站并回读校验——本轮真机 7 个样例站点 7/7 建成，没有 nginx 就明说"未校验"，PHP 没开就明说"没开"。**
