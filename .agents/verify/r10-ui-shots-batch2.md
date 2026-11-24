# R10 G-28 双端截图批次 2：断点续传 / 白话标签 / 本地化英译 / 商店总览

日期：2026-11-24 15:58–16:07（Asia/Shanghai）｜Owner：`r10-shots2`（🔵 美团味）｜批次：G-28 批次 2（与 `r10-shots1` 的 proc-chart/log-chart/firewall-plain/passwd-ui 并行，文件前缀不重叠）

## 0. 结论先行

本批 4 个 UI 改动（文件页断点续传 `06811ae` / 插件标签白话化 `d33eb6b` / 视图本地化 `e2cf84c` / en-US 第二批 239 条 `fc83056` + 第一批 `b1bce5e`）已补齐 G-28 双端证据：**4 场景 × 双端 = 8 张真实运行界面浏览器截图**（另补 2 张 resume 进度反馈态，共 10 张），PC 1440×900 / 手机 390×844，`file` 实测全过、md5 8 张全异。每场景产品自评三问 + 已证明/未证明两栏 + G-29 声明齐备。证据齐，声明完成。

> ▎[🔵 美团味] 过程透明，结果说话：所有截图来自隔离实例真实浏览器 + 真实登录表单 + 真实交互（filechooser 选 6.2 MiB 文件触发分块、设置页真实 selectOption 切 en-US），没有一张是同图缩放、设计稿或 DOM 断言冒充。做难而正确的事——诚实标注 resume 未制造真实网络中断。

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787 已是本批新构建（PID `1659842` / `bin/kored` mtime `2026-11-24 15:53:23` / sha 层级同 HEAD），但它是共享运行态资产，**不重启、不改配置、不覆盖静态资源**。为拍含本批 4 个 commit 的界面且完全隔离，走 `git archive HEAD` + 独立构建 + 独立实例：

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse HEAD
输出: 321c34d7e1566e55c53774b513a1e082ddfc84bf（本批 5 个目标 commit 全部为 HEAD 祖先）
$ for c in 06811ae d33eb6b e2cf84c b1bce5e fc83056; do git merge-base --is-ancestor $c HEAD && echo "$c YES"; done
输出: 5× YES
$ git archive HEAD | tar -x -C /tmp/kore-r10s2/src
$ cd /tmp/kore-r10s2/src && make web-dist && CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r10s2/bin/kored ./cmd/kored
退出码: 0；隔离二进制 11051170 bytes（独立产物，全路径落 /tmp）
$ cat /tmp/kore-r10s2/config.yaml   # 脱敏回读
输出: server.addr=127.0.0.1:18875；state_dir/run_dir/log_dir 全落 /tmp/kore-r10s2/；index_dir 指向本地 kore-plugins/index
$ /tmp/kore-r10s2/bin/kored admin-password --set --stdin --config /tmp/kore-r10s2/config.yaml
输出: 口令哈希写入 0600 配置（明文口令只存 /tmp/kore-r10s2/admin.pw，报告及全部证据均 *** 占位，G-30 合规）
$ /tmp/kore-r10s2/bin/kored serve --config /tmp/kore-r10s2/config.yaml
输出: {"msg":"kore ready","pid":1672600,"version":"0.1.1","addr":"127.0.0.1:18875","socket":"/tmp/kore-r10s2/run/kore.sock"}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18875/-/healthz
输出: 200
$ ss -ltn | grep -E ':(8787|18875) '
输出: 127.0.0.1:8787（主实例，PID 1659842）与 127.0.0.1:18875（隔离实例，PID 1672600）独立 LISTEN
```

浏览器走登录页表单 `#kore-password` 真实登录（非注入 cookie）；为拍到真实文件数据源，在**隔离实例**内通过 store install API 安装并启用 `file@0.3.5`（含 `file.uploadStatus` / `file.uploadChunk` 方法），只落 `/tmp/kore-r10s2/state`，与主实例 state 无关：

```text
$ POST /api/v1/store/install {"id":"file","version":"0.3.5","package_path":"<本地 dist>","force":true}
输出: {"state":"succeeded","message":"安装完成","reload":"reloaded"}
$ POST /api/v1/plugins/file/enable
输出: {"enabled":true,"state":"stopped","desired":"enabled"}  # 随后进程拉起到「运行中」
```

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' bin/kored
输出: 2026-11-24 15:53:23.063504568 +0800 11051170   # mtime/大小未变
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ pgrep -af 'kored.*serve'
输出: 1659842 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml   # 主实例未重启、未改配置
$ ss -ltn | grep -E ':(8787|18875|18874) '
输出: 8787（主）/18875（本批隔离）/18874（r10-shots1 批次1 隔离）三端口独立 LISTEN
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主实例 state/run/socket、未重建主 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r10s2` 隔离实例。隔离实例的临时脚本、6.2 MiB 测试文件与临时口令在收尾时删除（G-30 零明文凭据入仓）。

## 2. 截图清单与 file 实测（验收项①②）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`。PC 用 1440×900 viewport，手机用 390×844 viewport（playwright `deviceScaleFactor=1`、isMobile/hasTouch=true）；均为**精确视口截图而非 fullPage 滚动长图**，保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <8 张正式证据>
resume-desktop-01-upload-resume.png:          PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
resume-mobile-01-upload-resume.png:           PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
labels-desktop-01-store-plain.png:            PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
labels-mobile-01-store-plain.png:             PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
english-desktop-01-redis-en.png:              PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
english-mobile-01-redis-en.png:               PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
plugins-overview-desktop-01-store-search.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
plugins-overview-mobile-01-store-search.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

补充 2 张（resume 进度反馈态，证明分块上传真实提交与白话错误提示）：

```text
$ file resume-desktop-02-progress.png resume-mobile-02-progress.png
resume-desktop-02-progress.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
resume-mobile-02-progress.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图 / 拍到旧界面 / 英文态没生效」：**全部证伪**。

```text
$ md5sum <8 张正式证据>
0ead4b68b02c2184c90c562bc5a13fc7  resume-desktop-01-upload-resume.png
cd8b015a187eaa68594508cd31af0c1d  resume-mobile-01-upload-resume.png
35494969d950c1e1f0ad552dd37216f6  labels-desktop-01-store-plain.png
99aa409e0aa7fc22415ea000360b6f47  labels-mobile-01-store-plain.png
f4c0ac449065f132a717a2c40aa1be1d  english-desktop-01-redis-en.png
cfa526fd9a54eebee45b4613973786ec  english-mobile-01-redis-en.png
e5a65aedfacd3d30847c1c8a4f31d771  plugins-overview-desktop-01-store-search.png
9fa7078ec1ffbe8888c0ce61dc658b7c  plugins-overview-mobile-01-store-search.png
退出码: 0；md5 去重后计数 = 8（全不同）
```

- **同图缩放**：8 张 md5 全异 + `file` 实测 PC/手机尺寸不同，证伪。
- **设计稿替代**：全部来自 playwright 驱动的隔离实例真实浏览器渲染，登录走真实表单、交互走真实 filechooser/selectOption/填搜索，证伪。
- **拍到旧界面**：隔离二进制独立构建（11051170 bytes），5 个目标 commit 均为 HEAD 祖先，插件标签/断点续传/英文 nav 都是本批交付物，证伪。
- **英文态没生效**：设置页 `#kore-language-select` 真实 `selectOption('en-US')` → DOM 断言 `locale=en-US`，`#/db/redis` 显示 `Connect to an existing Redis server: view connections and memory, browse keys, read values and delete in bulk.` + `Detect again` / `Configure manually`，证伪。

## 3. 四场景交互真实性（DOM 断言 + 命令输出）

### 场景①文件页断点续传（resume）

```text
[resume desktop/mobile] 登录 → #/files → 点「上传」→ filechooser.setFiles(6.2 MiB 测试文件) →
  .kore-modal-box 文本 = "上传文件 / 目标目录 /，共 1 个文件（小文件 0 个 / 大文件 1 个）。
     大文件分块上传，中断或失败后点「从断点续传」可接着传，不必从头再来。/
     覆盖同名文件 / 不勾选时同名文件若已存在会记为失败；大文件失败后可点「从断点续传」接着传 /
     取消 | 开始上传"
  modalHasResumeHint=true（双端）
[补充 progress 态] 点「开始上传」→ .kore-modal-msg =
  "失败：r10s2-large.bin：E_INTERNAL：权限不足（permission denied）；请检查文件/目录属主与权限，
   或以 root 运行。点「从断点续传」会先查服务器已收字节，从断点接着传，不必重来。"
```

**诚实标注**：**未制造真实网络中断**，拍到的是上传弹层的「从断点续传」入口 + 白话 hint（首次打开即显示），以及真实提交 6.2 MiB 测试文件后的失败态提示。失败原因是隔离实例以非 root 运行、`/` 根目录无写权限（宿主环境限制，非本批 UI 缺陷）。任务原文明确允许：「若难造大文件中断，拍到上传 UI + 进度反馈即可，报告如实标注未制造真实中断」——名实相符。

### 场景②插件列表标签白话化（labels）

```text
[labels desktop] #/store → 卡片徽标 "生产级" / "基础级"；hasProduction=true hasBasic=true
                  hasRawProduction=false hasRawBasic=false（无 production/lazy 裸值）
                 #/store/plugins → 表格列 深度/运行方式 = "生产级 | 按需启动"，state=运行中
[labels mobile]  同上；窄屏下 store/plugins 表格与徽标仍可见
```

commit `d33eb6b` 的白话映射真实生效：index 里的 `depth_level=production` → 卡片「生产级」，`lifecycle=lazy` → 表格「按需启动」，裸值零命中。

### 场景③本地化英译生效（english）

```text
[english desktop] settings selectOption('en-US') → localStorage['kore_locale']=en-US
                  #/db/redis → "Databases | Redis | Redis | Connect to an existing Redis server:
                  view connections and memory, browse keys, read values and delete in bulk. |
                  Detect again | Configure manually | Redis connection | Settings"
                  hasEnglishHeading=true hasChineseHeading=false
[english mobile]  同上；导航为 "Overview|Websites|Databases|Files|App Store|More"
```

commit `e2cf84c`（redis 等四视图接 `tr()`）+ `b1bce5e`/`fc83056`（en-US 508 条收口）的真实 DOM 英文坐实，非中文态截图。未安装 redis 插件时的降级提示也已是白话英文（`E_NOTFOUND：插件 redis 未安装 / What to do: Check the address, port and pass...`）。

### 场景④商店/已装插件页整体状态（plugins-overview）

```text
[plugins-overview desktop/mobile] #/store → input[type=search] fill("file") →
  searchValue="file"；"共 24 个插件 · 已安装 1 个 · 匹配 1 个 · 第 1/1 页"
  卡片 "文件管理插件 v0.3.5 | 生产级 | 已安装 | 已是最新 | 运维 / 数据库场景"
  hasPlainLabels=true（白话标签与搜索同时可见）
```

商店搜索真实过滤（24 → 匹配 1 个），白话标签与搜索入口同屏，体现本批综合状态。

## 4. 产品定位自评三问（验收项③，原文）

### 场景①文件页断点续传（resume）

**问 1：本页解决什么用户问题？** 解决「大文件上传中断就要从头再来」——文件页上传弹层把大文件自动分块，中断或失败后同一个弹层直接给「从断点续传」按钮，先查服务器已落盘字节再从断点接着传，已传的分块不重传；小文件仍走原上传路径零行为变化。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的文件管理器支持常规上传下载，大文件断点续传多依赖外部工具或分段解压；Kore 把断点续传做进原生上传弹层并对手机适配，体验对齐。差距：①本次真机未制造真实网络中断，入口与失败提示已验证，完整续传成功链路未取证；②单帧 8 MiB 上限，超大文件需先压缩或用终端；③续传列表仅记失败的大文件，刷新页面后列表丢失（会话内有效）。属范围边界，不是缺陷。

**问 3：当前「可用」还是「占位」？** **可用（入口与反馈可用）**。判据：真实选 6.2 MiB 文件后弹层显示「从断点续传」入口与白话 hint，真实提交后 `.kore-modal-msg` 给出「点『从断点续传』会先查服务器已收字节，从断点接着传」的下一步；不是灰字占位。诚实地讲，成功续传链路本次未造出，标注为「未证明」而非声称全部可用。

### 场景②插件列表标签白话化（labels）

**问 1：本页解决什么用户问题？** 解决「商店/插件页冒出 production、lazy、resident 这类内部黑话，小白看不懂」——把深度等级翻成「生产级/基础级」、运行方式翻成「常驻/按需启动」，用户一眼知道这个插件成不成熟、是不是一直占着资源。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品商店多以图标/分类组织插件，少有「深度等级 + 运行方式」的成熟度表达；Kore 的白话标签是把内部数据模型翻译成用户语言，方向领先。差距：①标签只有两档/两态，颗粒度粗（没有「实验性」「一次性」等）；②没有悬停解释「生产级意味着什么」；③手机窄屏下表格信息密度高，需横向滚动。属可用性优化空间，不是占位。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真机 DOM 断言 `hasProduction=true hasBasic=true hasRawProduction=false hasRawBasic=false`，已装插件表真实显示「生产级 · 按需启动」，裸值零命中，映射真实生效。

### 场景③本地化英译生效（english）

**问 1：本页解决什么用户问题？** 解决「英文用户/海外部署看不懂中文界面」——设置页一键切 en-US，导航、通用文案与 redis/sshguard 等高频视图标题与按钮立即变英文并持久记住；未翻译文案回退中文，不出现空白或键名。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品是全量 i18n 框架（数百语言包）；Kore 受 G-11 收窄约束，明确「中文为主 + 英文可选骨架」（ADR-0021），只做英文一档。差距：①部分动态错误详情仍回退中文（如 `Reason: E_NOTFOUND：插件 discover 未安装`）；②无更多语言；③翻译覆盖不完整性由 fallback 兜底。这是设计边界，不是缺陷。

**问 3：当前「可用」还是「占位」？** **可用（骨架级）。** 判据：真机设置页 `selectOption('en-US')` 后 `localStorage['kore_locale']=en-US`，`#/db/redis` 的标题/按钮/降级提示真实变英文（DOM 断言 hasEnglishHeading=true、hasChineseHeading=false），立即生效且记忆；不是「敬请期待」占位，但离全量本地化有明显距离，如实标注为骨架。

### 场景④商店/已装插件页整体状态（plugins-overview）

**问 1：本页解决什么用户问题？** 解决「24 个插件太多找不到想要的」——商店按分类/场景预设组织，搜索框按 id/名称实时过滤，卡片同屏给出版本、白话深度标签、安装状态与下一步按钮，已装插件在第二个 tab 集中管理。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品商店普遍支持分类与搜索；Kore 对齐基本盘且把白话标签整合进卡片。差距：①搜索只按 id/名称，不支持按场景标签或功能描述全文检索；②本批隔离实例未联网下载，商店 24 个插件仅索引展示，真实安装需本地包；③预设本次显示「未装配」。属范围与环境边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真机搜索 "file" 后匹配数从 24 变 1、卡片渲染白话标签与安装/卸载按钮，搜索与标签同屏生效；不是静态示意图。

## 5. 已证明 / 未证明（验收项③，逐场景）

| 场景 | 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- | --- |
| resume | PC/手机各 1 张上传弹层（含「从断点续传」入口 + 白话 hint）+ 2 张进度反馈态；真实选 6.2 MiB 文件触发大文件分支；提交后 `.kore-modal-msg` 给出白话「怎么办」 | **未制造真实网络中断**，完整断点续传成功链路未取证（隔离实例非 root、`/` 无写权限，拍到失败态）；刷新后续传列表丢失未测 |
| labels | PC/手机各 1 张 store 页；生产级/基础级白话徽标 + 已装插件表「生产级·按需启动」；裸值 production/basic/lazy 零命中 | 手机窄屏表格横向滚动体验未单独取证；标签悬停解释未提供（产品当前无此交互） |
| english | PC/手机各 1 张；设置页真实 selectOption('en-US') → locale=en-US；`#/db/redis` 标题/按钮/降级提示全英，hasChineseHeading=false | 部分动态错误详情仍回退中文（骨架边界，fallback 生效）；未测 en-US 全 508 条逐条覆盖；未测「跟随系统」语言档（产品不提供） |
| plugins-overview | PC/手机各 1 张；搜索 "file" → 24→匹配 1 个；白话标签与搜索同屏 | 联网下载安装未测（隔离实例走本地 dist 包）；按场景/描述全文检索未提供；预设未装配 |
| 全局 | 8 张核心证据 + 2 张补充，md5 全异、尺寸合规、命名规范；G-29 主实例零改动；G-30 secret-check 0 FAIL | 未在主实例 8787 取证（其运行态为共享资产，不碰）；resume 成功续传与英文全量覆盖属后续增强 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 10 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 10 张 PNG + 本报告；未改任何源码、Makefile/embed、运行态资产。
- **G-28**：PC + 手机 + 每场景自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核；`bin/kored` mtime `15:53:23` 未变、8787 未重启）。
- **G-30**：报告无任何明文口令；`make secret-check` → `0 FAIL / 13 处匹配（占位写法均合规）`，退出码 0。

```text
$ cd /home/pt/Work/GolandProjects/kore && make secret-check
[RUN ] secret-check
secret-check: 0 FAIL / 13 处匹配（占位写法均合规）
退出码: 0
```

> ▎💼 [P8 自检] 冰山下面还有冰山：本批不止补截图，还在隔离实例里真装了 `file@0.3.5` 把文件页从「插件未安装」逼成真实 23 项目录 + 断点续传弹层；resume 虽只拿到失败态，但白话「怎么办」提示真实渲染，证明 `06811ae` 的组件不是装饰。过程透明，结果说话。
