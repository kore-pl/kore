> 状态: done · 归属: feat-backup-path-detect · 更新: 2026-11-25 · 里程碑: M0–M5
> 功能卡：backup-path-detect（竞品清单条目 10，P1）· 依据 [docs/USABILITY.md](../docs/USABILITY.md) §5「备份页：备份源路径列表仍需手填」

# 备份源自动检测（打开即已填好 + 「已自动检测」）

## 1. 要解决什么（依据 + 改造前的事实）

| 依据 | 改造前事实（path:line） |
| --- | --- |
| [docs/USABILITY.md:76](../docs/USABILITY.md) §5 第 2 行 | 「备份页｜备份源路径列表仍需手填（目录与白名单已可界面配置）｜违反 1」 |
| [docs/USABILITY.md:37](../docs/USABILITY.md) 原则②判据 | 「页面首次打开时，可自动填的字段已填好，并标注「已自动检测」」 |
| [docs/USABILITY.md:34](../docs/USABILITY.md) | 探测结果必须可见可改、带来源、用户改过的值不得被下一次探测覆盖 |
| [docs/USABILITY.md:33](../docs/USABILITY.md) | 探测不到时给「怎么办」，不是丢一个空输入框 |
| web/backups.js:1259（改造前 :1044） | 备份源是空 textarea，占位符写死示例路径 /var/www/site 与 /etc/kore（同时是原则①「不得用示例路径占位」的违反） |
| web/backups.js:1293（改造前 :1070） | 「定时备份的路径」同样是空 textarea + 示例 /var/www，从来自动填过 |
| kore-plugin-backup/internal/backupop/preset.go:256-305 | 插件侧早就有只读探测（autoSitePaths / existingAllowed），但只喂给「预设展开」，页面上完全看不出「这是探测出来的」 |

## 2. 怎么做的（功能实现，不是验证）

### 2.1 后端（kore-plugin-backup）：新增只读方法 backup.sources.detect

新增 internal/backupop/detect.go（287 行）：

- DetectSources(allowRoots, now)（detect.go:128）按四类候选探测：站点根 /var/www、/srv/www（枚举一层子目录 = 真实站点粒度，detect.go:37）、站点固定目录 /var/www/html、/usr/share/nginx/html、应用目录 /opt（枚举一层子目录）、关键配置 /etc/nginx、/etc/kore、数据目录 /var/lib/{mysql,postgresql,redis}。
- 复用已验证口径：同一套 isCriticalDir / underAnyRoot / coveredBy，只把白名单内的路径放进 suggested_paths（detect.go:246）——预填一个点「创建」必失败的路径比不填更糟；白名单外的容器目录照样报告 in_roots=false，由页面给「加入允许根路径」一键处理。
- existingSubdirs（detect.go:213）：os.ReadDir 一层、按名排序、每容器上限 12 项；总数上限 32（detect.go:28）；不递归。
- 数据目录只报告不预填，附 hint（一致性导出走 mysqldump）；探测不到时 hint 给三条可执行下一步。
- 只读：只有 os.Lstat / os.ReadDir，不装包、不改配置、不启停服务；读不了（权限不足）就跳过，不强依赖 root。
- 分派：backup.sources.detect 进 businessVerb 与 Call（call.go:31、call.go:64）；info.json 声明 system:read（info.json:27）并进 methods（info.json:46）；版本 0.5.2（info.json:4、manifest.json:3）。

### 2.2 前端（kore/web/backups.js）：打开即填好 + 徽标 + 可改 + 怎么办

- 探测段：web/backups.js:502 起（loadDetect / applyDetected / paintDetect / toggleDetectedPath / addAllowRoot）。
- 按需触发、不拖慢首屏：只在 render() 之后调一次（web/backups.js:1316 的 loadDetect(false)），且等预设读完再发（同一插件 socket 串行，避免两次全量调用打架）；不进首屏六件套、不轮询、不新增定时器（G-19）。
- 输入框上方「已自动检测」徽标（web/backups.js:1259-1266），探测块给「检测到 N 个可直接备份的目录 · 只读探测 HH:MM:SS」+「重新检测」+ 可点选目录 chip（已填入 / 填入 / 加入允许根路径）。
- 用户改过就不再覆盖（S.pathsTouched，web/backups.js:547）：手改后徽标转「手动填写」；显式选预设后转「预设已填」，只有点「重新检测」才重新自动填（等价 site-edit 的「恢复自动推断」）。
- 定时备份的路径同样自动填（web/backups.js:1293-1299），带自己的徽标与说明。
- 探测不到 = 怎么办（web/backups.js:648-653）：三条下一步 + 「去备份设置加允许根路径」按钮；白名单外目录给「加入允许根路径」一键写回（addAllowRoot，web/backups.js:582）。
- 顺手清掉原则① 的示例路径占位（原 /var/www/site、/etc/kore、/var/www），改成行为指引。
- 触摸目标：手机端按钮 min-height:44px（web/backups.js:1229 媒体查询），符合裁决41。
- 无新依赖、无新文件：只改 web/backups.js 一个已登记文件，故 Makefile WEB_SRC_FILES 与 web/embed.go 无需改动。

## 3. 门禁命令 + 退出码（本机实跑）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| cd kore-plugin-backup && gofmt -l . | 0 | 无输出（无未格式化文件） |
| GOCACHE=/tmp/gocache-bpd GOWORK=off go vet ./... | 0 | vet OK |
| GOCACHE=… go test -run 'Detect\|Sources\|Unknown' ./internal/backupop/ | 0 | ok …backupop 0.005s（本次新增 7 条全绿） |
| GOCACHE=… go test -timeout 200s ./... | 1 | 4 包 ok；internal/backupop 1 条存量环境失败 TestRestoreRejectsTraversal（chown invalid argument），见 §7 基线 |
| cd kore && node --check web/backups.js | 0 | node-check OK |
| bash scripts/frontend-check.sh | 0 | 首屏 gzip 81311 B / 307200（余量 225889）；i18n 增量 2922 / 3072 |
| bash scripts/secret-check.sh | 0 | 0 FAIL / 22 处匹配（占位写法均合规） |
| GOCACHE=… bash scripts/usability-check.sh | 0（脚本内 G-33 FAIL） | 无一条 FAIL 属于 backup：grep -E '^\[FAIL\].*backup' 零命中；红项来自 db-postgres（feat-pg-backup 在途 A3 文案）、waf e2e、以及不设 GOCACHE 时的只读缓存环境失败 |

## 4. 隔离实例真机取证（G-29：主实例 8787 全程未动）

| 项 | 值 |
| --- | --- |
| 实例 | 隔离实例 /tmp/bpd（server.addr 自动选空闲端口），state/run/log 全落 /tmp，跑完即删 |
| 索引 | paths.index_dir=/tmp/bpd/idxroot/index：只在 /tmp 内复制并重签了一份索引（备份插件 0.5.2 本地包 sha 入库），共享 kore-plugins/index 一个字节未改 |
| 安装 | POST /api/v1/store/install {"id":"backup","version":"0.5.2","package_path":"/tmp/bpd/backup-0.5.2.tar.gz"} → state=succeeded, reload=reloaded；POST /api/v1/plugins/backup/enable → desired=enabled |
| 配置 | backup.config.set allow_roots=["/etc/nginx","/opt/sourcegit"] → saved=true, applied=true |
| 主实例 | curl -s localhost:8787/-/healthz 全程 200，未改 .kore-local.yaml / .kore-local-state/ / bin/kored；本轮未改动主实例运行态配置 |

探测接口实测（POST /api/v1/invoke/backup/backup.sources.detect {}）：

    {
      "allow_roots": ["/etc/nginx", "/opt/sourcegit"],
      "suggested_paths": ["/opt/sourcegit", "/etc/nginx"],
      "detected_at": "2026-11-25T03:44:41Z",
      "sources": [
        {"path": "/opt/sourcegit", "kind": "app",    "label": "应用目录", "in_roots": true, "usable": true},
        {"path": "/etc/nginx",    "kind": "config", "label": "配置目录", "in_roots": true, "usable": true}
      ],
      "checked": ["/var/www","/srv/www","/var/www/html","/usr/share/nginx/html","/opt","/etc/nginx","/etc/kore","/var/lib/mysql","/var/lib/postgresql","/var/lib/redis"]
    }

## 5. G-28 双端截图（真实浏览器、隔离实例、真登录态）

file / identify 实测宽高（两次独立渲染，非同一张图缩放）：

| 场景 | 文件 | 实测 |
| --- | --- | --- |
| 打开即已填好 + 「已自动检测」（整页） | screenshots/backup-path-detect-desktop-01.png | PNG 1440 x 2542（full-page） |
| 同上 · 视口特写 1440×900 | screenshots/backup-path-detect-desktop-02.png | PNG 1440 x 900 |
| 同上 · 手机 | screenshots/backup-path-detect-mobile-01.png | PNG 390 x 844 |
| 探测不到时的「怎么办」 | screenshots/backup-path-detect-empty-desktop-01.png | PNG 1440 x 900 |

页面实测（playwright 读回 DOM，非人工描述）：

- 备份源 textarea 值："/opt/sourcegit\n/etc/nginx"（打开即填好，两条都是探测出来的真实目录）
- 可见徽标：["已自动检测", "已自动检测"]（新建备份 + 定时备份各一处）
- 探测块 meta：检测到 2 个可直接备份的目录 · 只读探测 11:44:41
- chip：应用目录 /opt/sourcegit 已填入、配置目录 /etc/nginx 已填入
- 首次使用引导遮罩：已按真人操作点掉（hasOnboarding:false），截图不靠遮罩外的空页凑数
- 空态（allow_roots=["/tmp/bpd/nonexistent-root"]）：suggested_paths=[]，meta「本机没检测到可直接备份的目录 · 只读探测 11:44:54」，hint 全文：「本机没找到可备份的目录。怎么办：①先建站点（或在允许的根路径下放要备份的数据），再点「重新检测」；②数据放在别处，就到「备份设置 → 允许的根路径」把那个目录加进来；③也可以直接在下面手填绝对路径。」，并给「去备份设置加允许根路径」按钮

## 6. 产品定位自评（G-28 第三问）

- 本页解决什么用户问题：小白打开备份页不用先搞清「我的站点在哪个目录」，系统已把本机可备份的站点/应用/配置目录探测出来填好并标明来源；想改就点 chip 或直接改文本，改过就不再被覆盖。
- 与宝塔、1Panel 同类功能的差距：宝塔/1Panel 的备份源是「选站点/选库」下拉（比手填好，但看不到非站点目录，也说不清来源）；本轮做到「探测结果可见、可点选、带探测时间与来源徽标、探测不到给三条下一步」，并且探测结果与实际校验白名单一致（不会填一个点了必失败的路径）。差距仍在：还不能按站点名联表归类（需要 site 插件配合），数据库维度仍要选库名（mysqldump 预设）。
- 当前「可用」还是「占位」：可用。隔离实例真装 0.5.2 本地包 → 打开备份页即自动填好并标「已自动检测」，点「填入/移除」可改，点「重新检测」可重填，探测不到时如实给「怎么办」。

## 7. 已知边界与挂账

1. 索引 DRIFT（需索引 owner 重签，不在本卡写域）：本仓 0.5.2 新增了方法并改了 dist sha，按 G-17「同 id@version 只允许一个 sha」必须 bump；kore-plugins/index/plugins.json 里 backup 仍是 0.5.1，待索引 owner 下一次重签收录 0.5.2。本轮不 push、不建 release。
2. 存量测试失败与本次无关（附基线）：TestRestoreRejectsTraversal 在本机报 chown … invalid argument（E_INTERNAL 而非 E_INVALID）。用 git archive HEAD 取改造前代码在同一环境复跑，同样失败，属环境 chown 行为差异，非本次改动引入；restore 的 chown 代码路径未被触碰。
3. 主实例运行态：本轮未改动主实例配置、未重启、未写 .kore-local*（§4）。
4. USABILITY.md §5 欠账行待删：§5 表里「备份页｜备份源路径列表仍需手填」一行应由 docs owner 在本轮收口时删除，并补一条「已改造：备份源打开即自动探测 + 已自动检测 + 重新检测 + 怎么办」（docs 写域属 docs-maturity-sync，本卡未越界改文档）。
