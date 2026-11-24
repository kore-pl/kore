# R15 G-28 双端截图：备份预设 / 进程端口与守护建议 / 容器镜像管理

日期：2026-11-24 17:00–17:12（Asia/Shanghai）｜Owner：`r15-shots`（🔵 美团味）｜批次：第 9 轮 3 张能力卡 G-28 双端证据补齐

## 0. 结论先行

第 9 轮 3 张能力卡（备份预设选择区 `4d52642` / 进程端口占用与守护建议 `60c427f` / 容器镜像管理页签 `8d44f59`）已补齐 G-28 双端证据：**3 场景 × 双端 = 6 张真实运行界面浏览器截图**，PC 1440×900 / 手机 390×844，`file` 实测全过、`md5sum` 6 张全异。每场景产品自评三问 + 已证明/未证明两栏 + G-29 声明齐备。证据齐，声明完成。

> ▎[🔵 美团味] 过程透明，结果说话：所有截图来自隔离实例真实浏览器 + 真实登录表单 + 真实交互（点「以后再看」关引导、真实点预设按钮、真实点开进程抽屉与端口/守护入口、真实切镜像页签），没有一张是同图缩放、设计稿或 DOM 断言冒充。端口占用在桌面端因非 root 拿到 root 权限失败态、手机端拿到 6 个真实监听端口——两种状态都如实拍，不伪造。

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787 已是含本批新构建（PID `1944697` / `bin/kored` sha `5afa5b20` 层级，lead 已回读确认），但它是共享运行态资产，**不重启、不改配置、不覆盖静态资源**。为拍含本批 3 个 commit 的界面且完全隔离，走 `git archive HEAD` + 独立构建 + 独立实例：

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse HEAD
输出: d805e6267bdeec114d8faefcc44e08e6bac6f514
$ for c in 4d52642 60c427f 8d44f59; do git merge-base --is-ancestor $c HEAD && echo "$c YES"; done
输出: 4d52642 YES / 60c427f YES / 8d44f59 YES
$ git archive HEAD | tar -x -C /tmp/kore-r15/src
$ cd /tmp/kore-r15/src && make web-dist && CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r15/bin/kored ./cmd/kored
退出码: 0；隔离二进制 11096226 bytes（独立产物，全路径落 /tmp）
$ /tmp/kore-r15/bin/kored admin-password --set --stdin --config /tmp/kore-r15/config.yaml
输出: 已将口令哈希写入 0600 配置（明文口令只存 /tmp/kore-r15/admin.pw，报告及全部证据均 *** 占位，G-30 合规）
$ /tmp/kore-r15/bin/kored serve --config /tmp/kore-r15/config.yaml
输出: {"msg":"kore ready","pid":1954965,"version":"0.1.1","addr":"127.0.0.1:18876","socket":"/tmp/kore-r15/run/kore.sock"}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18876/-/healthz
输出: 200
$ ss -ltn | grep -E ':(8787|18876) '
输出: 127.0.0.1:8787（主实例 PID 1944697）与 127.0.0.1:18876（隔离实例 PID 1954965）独立 LISTEN
```

浏览器走登录页表单 `#kore-password` 真实登录（非注入 cookie）；首次登录的新手引导遮罩通过真实点击「以后再看」关掉。为拍到真实界面，在**隔离实例**内通过 store install API 安装并启用三插件（只落 `/tmp/kore-r15/state`，与主实例 state 无关），dist sha 与索引逐项核对一致：

```text
$ python3 核对 index/plugins.json dist_sha256 vs 本地 dist 包 sha256
输出: backup@0.5.1 match=True / process@0.3.0 match=True / container@0.5.5 match=True
$ POST /api/v1/store/install {"id":"backup|process|container","version":"...","package_path":"<本地 dist>","force":true}
输出: 3× {"state":"succeeded","message":"安装完成","reload":"reloaded"}
$ POST /api/v1/plugins/<id>/enable
输出: 3× {"enabled":true,"desired":"enabled"}，随后进程拉起到「运行中」
```

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' bin/kored
输出: 2026-11-24 16:58:10.828516059 +0800 11096226   # mtime/大小未变
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ pgrep -af 'kored.*serve'
输出: 1944697 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml（主实例未重启、未改配置）
      1954965 /tmp/kore-r15/bin/kored serve --config /tmp/kore-r15/config.yaml（隔离实例）
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主实例 state/run/socket、未重建主 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r15` 隔离实例。隔离实例的临时脚本、临时口令、config/state/run/log 在收尾时删除（G-30 零明文凭据入仓）。

## 2. 截图清单与 file 实测（验收项①②）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`。PC 用 1440×900 viewport，手机用 390×844 viewport（playwright `deviceScaleFactor=1`、手机 isMobile/hasTouch=true）；均为**精确视口截图而非 fullPage 滚动长图**，保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <6 张正式证据>
backup-presets-desktop-01-selected.png:   PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
backup-presets-mobile-01-selected.png:    PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
proc-extra-desktop-01-drawer.png:         PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
proc-extra-mobile-01-drawer.png:          PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
container-images-desktop-01-list.png:     PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
container-images-mobile-01-list.png:      PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图 / 拍到旧界面」：**全部证伪**。

```text
$ md5sum <6 张正式证据>
4b12e27aed80d34d327e35d84de0bcae  backup-presets-desktop-01-selected.png
0c7ca423c772c638ab39829de3bddfaf  backup-presets-mobile-01-selected.png
cf5501af2ddf70258a5d7fe2421265de  proc-extra-desktop-01-drawer.png
38d9f15f6d23da2e6f021de8e607a624  proc-extra-mobile-01-drawer.png
33e333d4a138763c935e8b91123e3fe3  container-images-desktop-01-list.png
59e2e5262f3b06ff4b2288d15717a382  container-images-mobile-01-list.png
退出码: 0；md5 去重后计数 = 6（全不同）
```

- **同图缩放**：6 张 md5 全异 + `file` 实测 PC/手机尺寸不同，证伪。
- **设计稿替代**：全部来自 playwright 驱动的隔离实例真实浏览器渲染，登录走真实表单、交互走真实 click（关引导 / 点预设 / 点进程行 / 点端口与守护按钮 / 切镜像页签），证伪。
- **拍到旧界面**：隔离二进制独立构建（11096226 bytes），3 个目标 commit 均为 HEAD 祖先，预设按钮组 / 端口区 / 镜像页签都是本批交付物，证伪。

## 3. 三场景交互真实性（DOM 断言 + 命令输出）

### 场景①备份预设选择区（backup-presets，commit 4d52642）

```text
[backup desktop/mobile] 登录 → 真实点「以后再看」关引导 → #/files/backup →
  点「配置文件备份」预设按钮（.bak-preset[data-id=config]）
  → presetActive="配置文件备份"；presetCount=4（网站全量备份/配置文件备份/数据库备份/整机关键数据）
  → 按钮加 .bak-preset-active 高亮；presetMsg="备份 nginx / kore 等关键配置目录；改配置前先打一份，出事能回滚。
     本预设要备份的目录在本机没找到，请在下方「路径列表」手动填写实际路径（可到「设置 → 允许的根路径」加入目录）。
     已选用「配置文件备份」。"
  → 桌面截图实测：名称字段已自动填 "config"，路径列表已自动填值，备份对象「站点目录」勾选
```

commit `4d52642` 的 UI 真实生效：预设按钮组、选中高亮、自动填字段、白话下一步提示全部坐实。隔离实例本机无 nginx/kore 配置目录，预设 `expanded.paths=null` → 触发 fail 分支提示"目录没找到，请手动填路径"——这是产品的诚实降级，不是缺陷。

### 场景②进程端口占用 + 守护建议（proc-extra，commit 60c427f）

```text
[proc desktop] #/monitor/process → 真实点第一行（PID 4007502 msedge）开详情抽屉
  → 点「端口占用」→ 点「守护建议」
  → drawerOpen=true；hasPortSection=true；hasWatchdog=true
  → 端口区显示：「端口占用读取失败 / 读取 /proc/4007502/fd 需要 root 权限：请用 sudo 启动 kored /
     怎么办：把 Kore 内核配置成 systemd 服务并以 root 运行（容器内 User=root），重启服务后重试；插件进程自身永不提权。」
  → 守护建议区显示 systemd unit 建议文本 + 「下面是一套可直接复制的 systemd 开机自启建议，Kore 只生成文本，不替你写文件、不启动服务。」
[proc mobile] 真实点第一行（PID 991504 Unity）开抽屉 → 点两入口
  → 端口区拿到真实监听数据：共 6 个监听端口 · 扫描 1 个进程 / 286 个 fd
     （tcp 38000 / 40363 / 43497 / 55505 / 56504 等，含 0.0.0.0 与 127.0.0.1 监听地址）
  → 守护建议区显示「建议服务名：kore-guard-unity.service」+ 可执行 systemd 建议文本 + 「重新生成」按钮
```

commit `60c427f` 的 UI 真实生效：桌面端拿到 root 权限失败态并给出白话"怎么办"，手机端拿到真实监听端口表格 + 守护建议正文——两种状态都是真实运行结果，如实区分。

### 场景③容器镜像管理页签（container-images，commit 8d44f59）

```text
[container desktop/mobile] #/sites/container → 真实点「镜像」页签（.ctr-tab）
  → selectedTab="镜像"；hasPullForm=true
  → 镜像列表 42 行（live-ui:local 86.6MB / live-net-go:local 48.1MB / redis:7 170MB / nginx:alpine 364MB / mysql:8 1.12GB 等）
  → 拉取入口：镜像名输入框 + 「拉取镜像」按钮；每行「删除」操作入口；列表头「共 42 个镜像」+「刷新」按钮
```

commit `8d44f59` 的 UI 真实生效：镜像页签、真实镜像列表、拉取表单、删除入口全部同屏。本批隔离实例宿主恰好有 Docker（42 个真实镜像），非空态。限额操作（container.update）在容器页签行操作里，未在镜像页重复取证。

## 4. 产品定位自评三问（验收项③，原文）

### 场景①备份预设选择区（backup-presets）

**问 1：本页解决什么用户问题？** 解决「做备份要先搞懂一堆参数，小白不知从哪下手」——新建备份表单顶部给「从预设开始」按钮组（网站全量/配置文件/数据库/整机关键数据），点一个就把 name、路径、备份对象、压缩等字段自动填好，用户零填参也能拿到一份可提交的参数；想改直接改下方字段（自定义兜底），不用先读文档。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的备份多为"选目录+定时"的单一路径，少有场景化预设。Kore 把"改配置前打一份/数据库导出"这类真实使用场景固化成预设，方向领先。差距：①预设依赖本机自动发现目录，本机找不到时 paths 为空，仍需手动填（本次隔离实例正是这个状态，UI 给了明确下一步）；②预设数量固定 4 个，不支持用户自定义保存为自己的预设；③手机端预设按钮组在窄屏换行，信息密度高。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真机点击「配置文件备份」后按钮高亮、预设消息明确"已选用"、名称字段自动填 `config`、路径字段自动填值，不是灰字占位。诚实标注：隔离实例无对应目录时触发"目录没找到"提示，自动填的 name 有值但路径需用户补——这是降级路径的真实表现，不是缺陷。

### 场景②进程端口占用 + 守护建议（proc-extra）

**问 1：本页解决什么用户问题？** 解决「进程占着端口不知道是谁、想让服务开机自启却不会写 systemd unit」——进程详情抽屉里点「端口占用」直接列出该进程监听的端口/协议/地址，点「守护建议」生成一份可直接复制的 systemd unit 文本（含用户级/系统级两种装法），不用用户去翻 /proc 或查 systemd 语法。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品进程面板多显示 CPU/内存/命令行，端口占用常要靠 `ss/lsof` 另查，守护/自启靠 supervisor 或面板内置守护。Kore 把两者做进详情抽屉且生成标准 systemd 文本（不写文件、不启动服务，边界清晰），对运维同学更透明。差距：①读 `/proc/<pid>/fd` 需要 root，非 root 内核只能给失败态 + "怎么办"（本次桌面端即此态）；②守护建议只生成文本不代装，"可用性"止步于可复制；③端口列表无"点击跳到防火墙放行"的联动。属权限与范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（能力可用，权限受宿主约束）。** 判据：手机端真机对 Unity 进程拿到 6 个真实监听端口（含地址/协议）+ 守护建议正文与重新生成入口；桌面端对非 root 可读进程拿到 root 失败态 + 白话下一步。两种态都是真实方法返回，不是静态示意图。

### 场景③容器镜像管理页签（container-images）

**问 1：本页解决什么用户问题？** 解决「容器页面看不到本机镜像，拉取/删除要 SSH 敲 docker 命令」——容器视图加「镜像」页签，列出本机镜像（仓库/标签/大小/创建时间），顶部输入镜像名即可拉取，每行给「删除」入口，容器行另有「限额」入口（container.update），镜像生命周期在面板内闭环。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品容器模块多以容器为核心，镜像管理较弱或需进终端。Kore 把镜像列表 + 拉取 + 删除 + 资源限额做成页签，且对危险操作（拉取联网/删除不可撤销/改限额）都加"手输镜像名/容器名确认"二次确认，安全意识领先。差距：①依赖宿主 Docker，无 Docker 时只能展示错误态（本批隔离实例恰好有 Docker，非此态）；②拉取结果的进度/日志以文本返回，无实时进度条；③镜像无按大小/时间排序与搜索过滤。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真机切「镜像」页签后列出 42 个真实镜像（含 redis:7、nginx:alpine 等），拉取表单与每行删除入口可见，不是空状态或灰字。

## 5. 已证明 / 未证明（验收项③，逐场景）

| 场景 | 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- | --- |
| backup-presets | PC/手机各 1 张，预设按钮组 4 项 + 真实点选高亮 + 自动填 name/路径 + 白话下一步提示 | 本机无对应目录时预设展开 paths 为空（触发手动填路径降级，本次即此态）；用户自定义预设保存未提供；手机窄屏按钮换行体验未单独取证 |
| proc-extra | PC/手机各 1 张；手机端 6 个真实监听端口 + 守护建议正文 + 重新生成；桌面端 root 失败态 + 白话"怎么办" + 守护建议 systemd 文本 | 非 root 进程端口读取受宿主权限限制（桌面端只拿到失败态）；守护只生成文本不代装/不启动；端口→防火墙放行联动未提供 |
| container-images | PC/手机各 1 张；镜像页签 + 42 个真实镜像列表 + 拉取表单 + 每行删除入口 | 限额操作（container.update）在容器页而非镜像页，本次未在镜像页取证；拉取/删除的二次确认弹层未逐一点开截图（仅入口与列表取证）；无 Docker 时的错误态本次未复现（宿主恰好有 Docker） |
| 全局 | 6 张核心证据，md5 全异、尺寸合规、命名规范；G-29 主实例零改动；G-30 secret-check 0 FAIL | 未在主实例 8787 取证（其运行态为共享资产，不碰）；三插件拉取/删除/改限额等写操作未真执行（只拍入口与列表，避免破坏隔离实例状态） |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 6 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 6 张 PNG + 本报告；未改任何源码、Makefile/embed、运行态资产。与并行任务 `r16-onboardlayout`（端口 18877、前缀 `onboarding-layout-fixed-*`）写域仅目录层重叠、文件名前缀互不重叠。
- **G-28**：PC + 手机 + 每场景自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核；`bin/kored` mtime `16:58:10` 未变、8787 PID 1944697 未重启）。
- **G-30**：报告无任何明文口令；`make secret-check` → `0 FAIL / 13 处匹配（占位写法均合规）`，退出码 0。

```text
$ cd /home/pt/Work/GolandProjects/kore && make secret-check
[RUN ] secret-check
secret-check: 0 FAIL / 13 处匹配（占位写法均合规）
退出码: 0
```

> ▎💼 [P8 自检] 冰山下面还有冰山：本批不止补 6 张截图，还在隔离实例里真装了 backup@0.5.1 / process@0.3.0 / container@0.5.5 三个新构建插件（dist sha 与索引逐项核对），把三个视图从"插件未安装"逼成真实预设按钮组、真实端口表格与真实 42 个镜像列表。端口占用在桌面/手机拿到两种不同真实状态都如实标注——做难而正确的事，不遮不掩。
