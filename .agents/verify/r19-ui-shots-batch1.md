# R19 G-28 双端截图 · 批次1：PG 写入口 / 防火墙一键开关 / Python 虚拟环境 / 日志清理与保留策略

日期：2026-11-24 17:43–17:56（Asia/Shanghai）｜Owner：`r19-shots1`（🔵 美团味）｜批次：R19 双端证据批次1（4 场景 × 双端 = 8 张）

> ▎[🔵 美团味] 做难而正确的事，过程透明、结果说话。8 张截图全部来自隔离实例真实浏览器 + 真实登录表单 + 真实交互，没有一张是同图缩放、设计稿或 DOM 断言冒充。防火墙非 root 拿到只读降级态、日志无日志源拿到空态——如实标注，不伪造。

## 0. 结论先行

批次1 的 4 张能力卡（PG 写操作入口 `0758d0e`+`84c24f1`+`43c3d88` / 防火墙一键开关 `e19acbe` / Python 虚拟环境 `8a7fc1c` / 日志清理与保留策略 `c10edfb`）已补齐 G-28 双端证据：**PC 1440×900 ×4 + 手机 390×844 ×4 = 8 张真实运行界面浏览器截图**，`file` 实测全过、`md5sum` 8 张全异（distinct=8）。每场景产品自评三问 + 已证明/未证明两栏 + G-29 声明齐备，`make secret-check` 0 FAIL。**证据齐，声明完成。**

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787（PID `2128919` / sha `2700d865`，lead 已回读确认 8 项特征全命中）是本批新构建且为共享运行态资产——**不重启、不改配置、不覆盖静态资源**。为拍含本批 6 个 commit 的界面且完全隔离，走 `git archive HEAD` + 独立构建 + 独立实例（配置/state/run/log 全落 `/tmp`，端口 18879）：

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse HEAD
输出: 43c3d889f11638f908c48a4dc730d07ed9a97201
$ for c in 0758d0e 84c24f1 43c3d88 e19acbe 8a7fc1c c10edfb; do git merge-base --is-ancestor $c HEAD && echo "$c YES"; done
输出: 0758d0e YES / 84c24f1 YES / 43c3d88 YES / e19acbe YES / 8a7fc1c YES / c10edfb YES
$ git archive HEAD | tar -x -C /tmp/kore-r19-batch1/src
$ cd /tmp/kore-r19-batch1/src && make web-dist && CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r19-batch1/bin/kored ./cmd/kored
退出码: 0；隔离二进制 11190434 bytes（ELF 静态链接，独立产物全路径落 /tmp）
$ /tmp/kore-r19-batch1/bin/kored admin-password --set --stdin --config /tmp/kore-r19-batch1/config/config.yaml
输出: 已将口令哈希写入 0600 配置（明文口令仅存 /tmp/kore-r19-batch1/admin.pw，报告与证据均 *** 占位，G-30 合规）
$ /tmp/kore-r19-batch1/bin/kored serve --config /tmp/kore-r19-batch1/config/config.yaml
输出: {"msg":"kore ready","pid":2142418,"version":"0.1.1","addr":"127.0.0.1:18879","socket":"/tmp/kore-r19-batch1/run/kore.sock"}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18879/-/healthz
输出: 200
```

**蓝军自检「拍到旧界面」证伪**：归档的 `web/dist` 逐文件核对本批新特征命中——`db.js` 命中「新建数据库/用户与授权」6 处、`firewall.js` 命中「一键启用防火墙/SSH 端口」7 处、`runtimes.js` 命中「虚拟环境/venv.create」12 处、`logs.js` 命中「来源磁盘占用/保留策略」16 处。非 HEAD 旧界面不可能含这些新增文案。

为拍到真实界面（而非"插件未安装"空降级），在**隔离实例**内通过 store install API 安装并启用 4 个插件（只落 `/tmp/kore-r19-batch1/state`，与主实例 state 无关），dist sha 与索引逐项核对一致；PG 场景另起临时 PostgreSQL 16 容器（端口 15432，仅 /tmp 存临时口令，收尾删除），通过插件 `db-postgres.config.set` 配置真实连接：

```text
$ python3 核对 index/plugins.json dist_sha256 vs 本地 dist 包 sha256
输出: db-postgres@0.3.4 match=True / firewall@0.2.6 match=True / runtime-python@0.3.2 match=True / logs@0.5.4 match=True
$ POST /api/v1/store/install {"id":"db-postgres|firewall|runtime-python|logs","version":"...","package_path":"<本地 dist>","force":true}
输出: 4× {"state":"succeeded","message":"安装完成","reload":"reloaded"}
$ POST /api/v1/plugins/<id>/enable
输出: 4× {"enabled":true,"desired":"enabled"}，lifecycle=lazy，首次调用自动拉起
$ POST /api/v1/invoke/db-postgres/db-postgres.config.set {"values":{"host":"127.0.0.1","port":15432,"user":"postgres","password":"***",...}}
输出: {"saved":true,"applied":true,"restart_required":false,"warnings":[]}
$ POST /api/v1/invoke/db-postgres/db-postgres.instances {}
输出: {"instances":[{"name":"default","host":"127.0.0.1","port":15432,"reachable":true,"version":"PostgreSQL 16.16 ..."}],"count":1}
```

浏览器走登录页表单 `#kore-password` 真实登录（非注入 cookie）；首次登录的新手引导遮罩通过真实点击「以后再看」关掉。

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' bin/kored
输出: 2026-11-24 17:41:45.358780824 +0800 11190434   # mtime/大小未变（lead 的 17:41 构建）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ pgrep -af 'kored.*serve'
输出: 2128919 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml（主实例未重启、未改配置）
      2142418 /tmp/kore-r19-batch1/bin/kored serve --config /tmp/kore-r19-batch1/config/config.yaml（隔离实例）
$ ss -ltn | grep -E ':(8787|18879|15432) '
输出: 127.0.0.1:8787（主）/ 127.0.0.1:18879（隔离）/ 0.0.0.0:15432（临时 PG）独立 LISTEN
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主实例 state/run/socket、未重建主 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r19-batch1` 隔离实例。隔离实例的临时脚本、临时口令、config/state/run/log、临时 PG 容器在收尾时删除（G-30 零明文凭据入仓）。

## 2. 截图清单与 file 实测（验收项①②）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`（场景名严格用任务卡指定前缀 `pg-write` / `firewall-switch` / `python-venv` / `log-clean`）。PC 用 1440×900 viewport、手机用 390×844 viewport（playwright `deviceScaleFactor=1`，手机 `isMobile/hasTouch=true`，`fullPage=false` 精确视口截图），保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <8 张正式证据>
pg-write-desktop-01-entries.png:          PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
pg-write-mobile-01-entries.png:           PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
firewall-switch-desktop-01-degraded.png:  PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
firewall-switch-mobile-01-degraded.png:   PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
python-venv-desktop-01-section.png:       PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
python-venv-mobile-01-section.png:        PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
log-clean-desktop-01-overview.png:        PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
log-clean-mobile-01-form.png:             PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图 / 拍到旧界面」：**全部证伪**。

```text
$ md5sum <8 张正式证据>
20a92941fc644caf15a7fce149e1d1fb  pg-write-desktop-01-entries.png
68ef5f27c19b95618ed927b9268dbf4c  pg-write-mobile-01-entries.png
63fa98c1324e4518252c8a3d8e848280  firewall-switch-desktop-01-degraded.png
5d5cdfd1b569702aca809b8cade824e7  firewall-switch-mobile-01-degraded.png
d371ec38fedd9aa148789a1cb20b37fe  python-venv-desktop-01-section.png
b24b71afcfc08c8daf110d3c4574254b  python-venv-mobile-01-section.png
1807ccdf78cdec5f805f1f483ff2b124  log-clean-desktop-01-overview.png
a83c5d4255c84ae0226590b1962273e1  log-clean-mobile-01-form.png
退出码: 0；md5 去重后计数 = 8（全不同）
```

- **同图缩放**：8 张 md5 全异 + `file` 实测 PC/手机尺寸不同，证伪。
- **设计稿替代**：全部来自 playwright 驱动的隔离实例真实浏览器渲染，登录走真实表单、交互走真实 click（切 PG tab、展开用户区、切 Python tab、点保留策略按钮），证伪。
- **拍到旧界面**：隔离二进制独立构建（11190434 bytes），6 个目标 commit 全是 HEAD 祖先、归档 dist 新文案逐项命中，证伪。

## 3. 四场景交互真实性（DOM 断言 + 命令输出）

### 场景①PG 写操作入口（pg-write，commit 0758d0e+84c24f1+43c3d88）

```text
[pg-write desktop/mobile] 登录 → 切「PostgreSQL」tab → 真实连上临时 PG（16.16，127.0.0.1:15432）
  → createDb 按钮=1；用户与授权区=1；已连接横幅=1
  → 真实点开「用户与授权」折叠区 → 角色列表来自只读查询 pg_roles，
    显示「新建用户 / 刷新 / 没有账号」空态（无账号如实标注）
  → 页面写明「写操作已开放（建库 / 用户与授权）；SQL 控制台仍只读，导入导出为 MySQL 专属」
```

6 个写方法（createDatabase/dropDatabase/createUser/dropUser/grant/changePassword）的前端接线真实生效；角色列表 SQL 已按 `84c24f1` 改成 `AS role_name` 别名，避开 PG 保留字。**无真实 PG 时的入口+空态降级在 recon 阶段也实测过**（未配置连接时显示「还没有 PostgreSQL 连接 + 配置连接 / 重新读取」引导），本批用真容器拿到更强证据。

### 场景②防火墙一键开关（firewall-switch，commit e19acbe）

```text
[firewall-switch desktop/mobile] 登录 → #/security/firewall
  → 状态区：UFW（系统防火墙工具）+ 「只读降级」chip=2 + 「启用状态 不可读 / 默认入站 不可读 / 规则数 不可读」
  → 白话降级：「只读降级：无法读取防火墙状态 / 需 root 权限：请用 sudo/systemd 启动 kored，
     或让内核经 POST /api/v1/plugins/firewall/root-action 执行 ufw-status ...，点刷新即可读取状态并使用一键开关」
  → SSH 放行告警文案=2（含「启用前必须确认 SSH 端口（默认 22/tcp）已放行，否则可能把你锁在外面」）
  → 一键开关按钮 count=0（console 实测）：非 root 且 backend 不可读 → paintStatus 只渲染只读降级分支
```

`e19acbe` 的一键启用/停用按钮渲染条件是 `st.available && backend==='ufw'`。本机隔离实例以非 root 启动（`kored 非 root：插件降权未生效`（uid 1000）），`ufw status` 直接报「只有 root 用户才能运行此脚本」，且沙箱 `no_new_privs` 使 sudo 提权也不可用——所以按钮不渲染，**如实拍只读降级态 + SSH 放行告警**，不伪造按钮。这是 ADR-0018 非 root 边界的真实表现，不是缺陷。

### 场景③Python 虚拟环境（python-venv，commit 8a7fc1c）

```text
[python-venv desktop/mobile] 登录 → #/sites/runtimes → 真实点「Python」tab
  → 检测到 1 个 Python（3.14.4 /usr/bin/python3），pip 25.1.1，venv 模块可用
  → 虚拟环境区=1：「建独立环境、装依赖；只写插件允许目录，不影响系统 Python」+「刷新列表」
  → 建环境表单：环境路径（留空用默认 <允许目录>/venvs/venv）、Python 版本（可留空）、初始依赖（空格分隔）
  → 「建虚拟环境」按钮=1；空态「还没有虚拟环境。填好上方路径后点『建虚拟环境』，即可拥有独立依赖空间」
  → 健康检查 4 项：Python 安装/pip/venv 通过，site-packages 可写警告（如实标注）
```

`8a7fc1c` 接的 venv.create/list + pip.install/list 四方法前端入口真实可见；本批只拍入口与空态，不真建环境（避免 120s 联网装包与写状态污染）。

### 场景④日志清理与保留策略（log-clean，commit c10edfb）

```text
[log-clean desktop] 登录 → #/monitor/logs
  → 磁盘占用区=1：「来源磁盘占用 / 合计 0 B / 刷新占用 / 暂无占用数据（配置日志来源后显示）」
  → 维护区：「⚙ 保留策略 / 🧹 清理旧日志 / ↩ 撤销上次清理」三入口 + 说明「清理只处理旧的轮转日志，
     正在写入的日志文件不会被清；清理后文件进回收区，可随时撤销」
[log-clean mobile] 同上 → 真实点「⚙ 保留策略」→ 表单标题「保留策略 · 超过即由清理回收」出现（formTitle=1）
  → 保留策略表单（最大保留天数/大小/文件数/单文件切割大小，中文标签 + 一行帮助）同屏可见
```

`c10edfb` 接的 usage/retention.get/set/clean/restore 五组方法前端入口真实可见；隔离实例无日志源插件配置 → 占用 0 B 空态如实标注，保留策略表单点开后真实渲染。未真执行清理/撤销（避免破坏隔离实例状态）。

## 4. 产品定位自评三问（验收项③，原文）

### 场景①PG 写操作入口（pg-write）

**问 1：本页解决什么用户问题？** 解决「PostgreSQL 建库/建用户/授权要 SSH 敲 psql，小白不敢动线上库」——数据库页切到 PostgreSQL 域后，库面板顶部直接给「新建数据库」按钮，「用户与授权」折叠区给「新建用户 / 授权 / 刷新」，两步表单就把 createDatabase / createUser / grant 的参数填好；危险操作（删库/删用户）仍要手输名称解锁，SQL 控制台保持只读，把「能写什么、不能写什么」讲清楚。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的数据库模块以 MySQL 为主，PostgreSQL 多为装扩展或跳 phpPgAdmin。Kore 把 PG 写操作做进同一套域切换 UI、保持与 MySQL 一致的操作节奏，方向领先。差距：①PG 走插件配置连库，没有 MySQL 那种本机自动发现，首次要填 host/port/user/password（本次用环境变量/配置契约解决）；②写操作依赖 `system:admin` 能力，非 root 环境要插件侧授权；③没有可视化 ER/表结构管理，止步于库/角色级。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（真连库证据）。** 判据：隔离实例真连 PostgreSQL 16.16，横幅显示「已连接」+ 版本 + 地址，「新建数据库」按钮与「用户与授权」区真实渲染，展开后角色列表走 pg_roles 只读查询并返回空态——不是灰字占位。诚实标注：当前连接无普通账号，角色列表为空，未真点建库/建用户（避免污染临时库）。

### 场景②防火墙一键开关（firewall-switch）

**问 1：本页解决什么用户问题？** 解决「放行端口要记 ufw 命令、怕把自己锁在外面」——防火墙页状态区把「启用状态/默认入站/规则数」摊开，一键启用/停用走「点按钮→dry-run 预览真实命令→勾确认→才执行」两步，且默认入站为拒绝、未放行 SSH 端口时启用前强警告并要求勾选，防止运维改防火墙把 SSH 连接锁死。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品面板的防火墙开关多直接执行、命令不透明，SSH 锁死事故常见。Kore 把「预览→确认」和「SSH 放行强校验」做进前端 + 服务端双层拦截，安全感领先。差距：①读 ufw 状态与执行启停都需要 root，非 root 只能拿只读降级（本次隔离实例即此态，符合 ADR-0018）；②只支持 ufw 后端，iptables 无全局开关返回 E_UNSUPPORTED；③一键按钮在状态不可读时不渲染，用户只能看到降级提示而非"禁用按钮"——需先理解提权才能用。属权限边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（能力已实现，本机受 root 权限约束显示降级）。** 判据：commit 的一键开关代码、SSH 放行告警文案、只读降级白话提示都是真实渲染结果；本机非 root 且无 sudo 提权通道，状态区如实显示「只读降级 + 不可读」，按钮按条件不渲染——这是诚实降级，不是假界面。未在 root 环境实拍按钮点击态（本次无 root，如实标注为未证明）。

### 场景③Python 虚拟环境（python-venv）

**问 1：本页解决什么用户问题？** 解决「Python 项目依赖装在系统里互相打架、建 venv 要记命令」——运行环境页切 Python tab，虚拟环境区一屏给「刷新列表 / 环境路径 / Python 版本 / 初始依赖 / 建虚拟环境」，每行 venv 再给装包入口，写域锁在插件允许目录内（路径白名单 + 软链逃逸防护 + 120s 超时），小白不碰系统 Python 也能隔离依赖。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品运行环境页多只显示版本，虚拟环境要进终端手动建。Kore 把 venv 生命周期（建/列/装包）做成表单 + 行操作，并把"路径不能含 ..、包名只字母数字和 . _ -、120s 超时"这些边界翻译成人话错误提示，易用性领先。差距：①依赖宿主已装 python3 + venv + pip（本机 3.14.4 全通过，其他机器可能缺）；②装包联网慢可能触发 120s 超时，只能分批；③没有环境删除/复制入口。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（入口与检测真实，建环境未真执行）。** 判据：真机切 Python tab 拿到真实检测结果（3.14.4 / pip 25.1.1 / venv 可用），虚拟环境区、建环境表单、空态提示都是真实渲染；「建虚拟环境」按钮存在。未真建环境/装包（避免 120s 联网与写状态），.env 列表为空态如实标注。

### 场景④日志清理与保留策略（log-clean）

**问 1：本页解决什么用户问题？** 解决「日志把磁盘写满、又怕清理误删正在写的日志」——日志页顶部「来源磁盘占用」一眼看清谁在吃盘、超策略红标 + 原因；「⚙ 保留策略」表单设最大天数/大小/文件数/单文件切割大小；「🧹 清理旧日志」走 dry-run 预览→确认→真清（只清轮转文件、活跃文件永不碰），清完进回收区，「↩ 撤销上次清理」可恢复。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品日志页多为 tail + 搜索，磁盘占用与保留策略常散落在设置里。Kore 把「占用→策略→清理→撤销」做进同一页维护区，并明确"活跃文件不清、清理可撤销"，安全边界清楚。差距：①占用/清理依赖 logs 插件配置日志来源，没配就 0 B 空态（本次即此态）；②撤销只恢复上次清理批次，更早的不可撤；③保留策略按来源覆盖，无全局默认一键套用。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（入口与表单真实，无数据时空态）。** 判据：真机日志页显示「来源磁盘占用 / 合计 0 B」空态、保留策略/清理/撤销三入口齐全，手机端点「保留策略」真实弹出中文表单；不是灰字占位。未真执行清理/撤销（无日志数据可清，避免污染状态）。

## 5. 已证明 / 未证明（验收项③，逐场景）

| 场景 | 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- | --- |
| pg-write | PC/手机各 1 张；真连 PG 16.16，横幅「已连接」+ 版本/地址；「新建数据库」按钮 + 「用户与授权」区真实渲染，展开后 pg_roles 只读查询空态 | 未真点建库/建用户/授权（避免污染临时库）；当前连接无普通账号，角色列表为空；无 PG 时的入口+空态降级在 recon 阶段实测过但非本批正式截图 |
| firewall-switch | PC/手机各 1 张；UFW 状态区「只读降级」+ 不可读统计 + 白话提权提示；SSH 放行告警文案 2 处 | 一键启用/停用按钮 count=0：非 root 且 ufw 状态不可读，按钮按条件不渲染；未在 root 环境实拍按钮点击态与 dry-run 预览（本机无 root、sudo 被 no_new_privs 拦）；iptables 后端 E_UNSUPPORTED 未复现 |
| python-venv | PC/手机各 1 张；真机检测 Python 3.14.4 / pip 25.1.1 / venv 可用；虚拟环境区 + 建环境表单 + 空态 + 「建虚拟环境」按钮 | 未真建 venv / 装包（避免 120s 联网与写状态）；site-packages 可写警告如实显示；无 python3 的机器降级态未复现 |
| log-clean | PC/手机各 1 张；磁盘占用空态「合计 0 B」+ 保留策略/清理/撤销三入口；手机点保留策略真实弹出中文表单 | 未真执行清理/撤销（无日志源数据可清）；超策略红标与超量原因未复现（无数据）；保留策略保存写操作未执行 |
| 全局 | 8 张核心证据 md5 全异、尺寸合规、命名规范；G-29 主实例零改动；G-30 secret-check 0 FAIL | 未在主实例 8787 取证（共享运行态资产，不碰）；四个场景的写操作均未真执行（只拍入口/表单/降级态，保护隔离实例状态） |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 8 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 8 张 PNG + 本报告；未改任何源码、Makefile/embed、运行态资产。与并行任务 `r19-shots2`（端口 18880、前缀 `ssl-acme`/`app-template`/`site-php`/`pg-readonly`）写域仅目录层重叠、文件名前缀互不重叠、各提各的。
- **G-28**：PC + 手机 + 每场景自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核；`bin/kored` mtime `17:41:45` 未变、8787 PID 2128919 未重启、healthz 200）。
- **G-30**：报告无任何明文口令（临时口令只在 /tmp，收尾删除）；`make secret-check` → `0 FAIL / 13 处匹配（占位写法均合规）`，退出码 0。

```text
$ cd /home/pt/Work/GolandProjects/kore && make secret-check
[RUN ] secret-check
secret-check: 0 FAIL / 13 处匹配（占位写法均合规）
退出码: 0
```

> ▎💼 [P8 自检] 冰山下面还有冰山：本批不止补 8 张截图，还在隔离实例里真装了 4 个新插件 + 起了真 PostgreSQL 容器，把 PG 写入口从"插件未安装"逼成真实已连接态；防火墙非 root 拿不到按钮就如实拍降级态，不伪造一个假按钮。做难而正确的事，不遮不掩。
