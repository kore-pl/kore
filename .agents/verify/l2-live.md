> 元信息: 2026-11-23T02:05+08:00 · 执行者 l2-live-verify · 真机 8787 · 未改源码 / 未提交 / 本 agent 未重启实例 · G-28
# L2 真机验收（真实 8787）：插件升级 + camelCase + 双端截图

## 0. 前提与口径
- 实例 `127.0.0.1:8787`，kored PID **3769523**（重启前 3747936），store 23 条；只走 API + 真实浏览器点击。
- 期间 **lead 于 ~01:44 重启一次**：第十四次重签轮换索引公钥（`230247f`），旧进程内嵌旧公钥 → `/store/*` 全 401；重启后 200 + 23 条。401 期未产出交付截图。
- 本机无 nginx：site 用 `bin/site` wrapper 显式 `KORE_NGINX_TEST_CMD/RELOAD_CMD=off`（原件 `bin/site.real` 保留），结果 `test_skipped/reload_skipped=true`，**未伪造 test_passed**。

## 1. 插件升级对比（包 sha 对索引，不只看版本号）
判定法：按索引 `download_url` 下载 tar.gz（sha 与索引一致）→ 解包逐文件 sha 比对已装目录。
| 插件 | 升级前 | 索引 | 旧包判定 | 动作 | 状态码 |
| --- | --- | --- | --- | --- | --- |
| file | 0.1.0 | 0.2.0 cdd2bfe9 | 版本不符，缺 compress/extract | disable→备份→install→enable | 200 / 200(succeeded) / 200 |
| site | 0.1.0 | 0.1.0 991652bd | 同版本不同构建：无 bindSSL 等 6 方法 | 备份→install→shim→enable | 200 / 200 / 200（ready pid 3773391） |
| logs | 0.2.0 旧构建 | 0.2.0 7f655b9b | 旧包无 config.get/set | disable→备份→install→enable | 200 / 200 / 200 |
| backup | 0.2.0 旧构建 | 0.2.0 779fbdb5 | 旧包无 config.get/set | disable→备份→install→enable | 200 / 200 / 200 |
| cron/db-mysql/process/runtime-php/ssl/terminal | 同版本 | 同 sha | payload 逐文件一致 | 不重装（无写入） | — |
- 旧包证据：file 旧包确无 `file.compress`；site 旧包 `bindSSL=0`；logs/backup 旧包 `config.get=0` —— 与"同版本不同构建"教训一致。
- 升级后 10 个插件 payload 与索引包全 **MATCH**（site 比对 `bin/site.real`=包内二进制；`bin/site` 为 nginx-off shim）；回滚点保留 `plugins/{file,site,logs,backup}/*.bak-*`。

## 2. 内核 camelCase 修复验证
| 方法 | HTTP | 关键回显 |
| --- | --- | --- |
| site.bindSSL | **200** | ssl_bound=true；test_skipped=true |
| site.setRewrite | **200** | template=wordpress |
| site.setProxy | **200** | proxy=true；**rewrite_cleared=true** |
| site.setRedirect | **200** | /old → /new（302）；redirects=1 |
| site.unsetProxy | **200** | proxy=false |
| site.setIndex | **200** | index=[index.html,index.php] |
- 升级前同请求为 `404 E_NOTFOUND 未知方法`（语法已放行、插件无方法）；本轮 **6/6 全 200，无一个 400**。

## 3. 真机操作结果
| 分组 | 步骤 | 结果 |
| --- | --- | --- |
| 文件 | 上传 | 上传对话框→`live-l2-upload.txt` 33 B，列表出现（共 6 项） |
| 文件 | 下载 | `已下载`；落盘 sha256 与上传源一致（eb9006587449，33 B） |
| 文件 | 压缩→解压 | `live-l2-pack.zip` 207 B → `live-l2-extract/`（1 项，33 B） |
| 文件 | 改权限 | `live-l2-upload.txt` → 0600（列表权限列回显 0600） |
| 文件 | 移动/重命名 | → `live-l2-moved.txt`（method=rename） |
| 网站 | 建站向导 | `live.kore.test`，root `/var/www/live.kore.test`，证书 `demo.kore.local`，伪静态 wordpress；create→bindSSL→setRewrite 三步全成功 |
| 网站 | 站点详情 | `site.get` 摘要：root / port 80 / index / SSL 已绑定 / 伪静态 / 反代 / 重定向 / 在清单内 |
| 网站 | 反代 | `http://127.0.0.1:3000` → 回显「已自动清除伪静态（互斥）」，`rewrite_cleared=true` |
| 网站 | 重定向 | `/old → /new` 302，共 1 条 |
| 网站 | 停用→启用 | `enabled=false` → `enabled=true`（vhost 改名回切） |
| 配置 | 日志 ⚙ | 来源 `syslog=/var/log/syslog` + 新增 `journal=journal` → 「已保存，立即生效」；来源 1→2 且可读（source=file） |
| 配置 | 备份 ⚙ | dir 改为 `.kore-local-state/plugins/backup/backups-l2` → 「已保存，立即生效」（source=file） |

## 4. 双端截图（15 张，sha256 两两去重：**0 重复**）
| 文件 | 尺寸 | sha12 |
| --- | --- | --- |
| live-l2-files-desktop-01 | 1440x900 | f31c74968900 |
| live-l2-files-desktop-02 | 1440x900 | a3b96fbaede0 |
| live-l2-files-desktop-03 | 1440x900 | 68fb45e4453d |
| live-l2-files-desktop-04 | 1440x900 | fc21f318e041 |
| live-l2-files-desktop-05 | 1440x900 | 4079dec253ae |
| live-l2-sites-desktop-01 | 1440x900 | eb74d3a610a5 |
| live-l2-sites-desktop-02 | 1440x2535 | 1a51ec06b928 |
| live-l2-sites-desktop-03 | 1440x2535 | 414890743f99 |
| live-l2-sites-desktop-04 | 1440x2535 | af942fd87a35 |
| live-l2-sites-desktop-05 | 1440x2684 | ebd52278d485 |
| live-cfg-desktop-01 | 1440x1274 | 0fbfcc8bfa33 |
| live-cfg-desktop-02 | 1440x1267 | 62cac13b44c8 |
| live-l2-files-mobile-01 | 390x844 | b9ed7df05674 |
| live-l2-sites-mobile-01 | 390x844 | 8581318dd4dd |
| live-cfg-mobile-01 | 390x844 | aaba1ba80ae4 |
- 每张截图**前、后各断言一次**：页内关键字命中 + `input[type=password]=0` + 无登录表单；15/15 通过。
- console error 仅 1 条（favicon.ico 404），无页面脚本异常；无外链请求。

## 5. G-28 三问自评
1. **解决什么**：文件页把上传/下载/压缩/解压/chmod/移动做成高频运维三步内闭环；网站页把建站→SSL→伪静态→反代→重定向→启停收进一个向导+详情；配置面板让 logs/backup 参数改完即刻生效。
2. **与宝塔/1Panel 差距**：不捆绑 nginx 二进制（真机只能 test_skipped）；上传下载受单帧 ≈5.95 MiB 限制、无分片/断点；无在线文件编辑、批量属性；站点无模板/一键部署/流量统计；配置面板仅 2 个试点插件。
3. **可用还是占位**：文件页 L2、网站页 L2、配置面板均为**可用**（真机 200 + 文件 sha 往返一致 + 三步建站成功 + 互斥回显 + 启停生效 + 热生效）；nginx 校验/重载为**环境受限的「未检测」**，既非占位，也未伪装通过。

## 6. 最直观的 3 个问题
1. **热升级静默失效**：`POST /store/install` 200 后 `/plugins` 仍报 0.1.0、invoke 404；`reloadOne` 对已登记 id 直接 `return nil`（`cmd/kored/serve_runtime.go:115`），必须重启内核；enable 响应仍显示旧版本。
2. **索引换公钥与运行实例脱节**：重签后旧进程所有 `/store/*` 401，页面只显示"索引签名验证失败"，没有"需重启 kored"提示（RUNBOOK 有流程，产品无提示）。
3. **同版本重装被 `E_CONFLICT` 拒绝**（installer 见目标目录即拒），且 site 无 nginx 时必须靠 wrapper 才有 test_skipped —— 缺"重装/修复"入口与"无 nginx 降级模式"开关。

## 7. 限制与未做
- 无 nginx：`test_passed=false` 但 `test_skipped=true`，reload 未执行，443/HTTPS 握手未验证；site 旧目录临时移走时恰逢重启，重启后未登记，已用 install 200 重新登记；未提交、未改源码，产物留给 lead。
