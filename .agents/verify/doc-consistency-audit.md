[agent:doc-audit] docs(verify): 三份运维文档口径一致性审计

# 三份运维文档口径一致性审计（QUICKSTART / RUNBOOK / OPERATIONS）

> 审计对象：`QUICKSTART.md`（129 行）、`docs/RUNBOOK.md`（437 行）、`docs/OPERATIONS.md`（155 行）
> 审计基线：`ad2d73a`（`fix(cli): CLI 与 serve 配置/状态路径统一 + fail-closed + kored status`），2026-11-23 21:42
> 背景：两处「路径解析不一致」P0 —— ① `admin-password` 写 A 文件、`serve` 读 B 文件（`a5cd2c1` 已修，QUICKSTART 全文统一 `--config ./kore-quickstart.yaml`）；② CLI 静默写第二个 `state.db`（`ad2d73a` 已修，加 fail-closed）。
> 纪律：**只报告有原文证据的**；无证据处写「未确认」并列出缺什么。**本审计未修改任何文档。**

## 0. 结论先行

- **口径已经统一的**：默认配置路径（portable）、`state.db` 默认值、`KORE_CONFIG > --config > profile` 解析优先级、`install` 撞锁文案与退出码、`uninstall` 全部 6 种退出码（0/0/6/2/1/0）与代码逐条对得上。
- **必须修的矛盾 7 条**，其中 3 条属「读者照做会出错」级别：README 的配置文件名（`kore.yaml`，仓库里不存在）、OPERATIONS 的 fhs 配置路径（漏 `/etc/kore/config.yaml`）、OPERATIONS §3.1 的「服务在跑时直接 `kored install`」（现已被 fail-closed/锁拒绝）。
- **失效链接 0**：README「开始使用」4 个目标 + `docs/README.md`「我想做什么」15 个目标，逐个 `test -e` 全部命中。

## 1. 六项对照总表

| 口径 | QUICKSTART | RUNBOOK | OPERATIONS | 代码 / help 实际 | 一致? |
| --- | --- | --- | --- | --- | --- |
| 配置文件名 | `./kore-quickstart.yaml`（全文 7 处） | `/opt/kore/config/config.yaml`、`.kore-local.yaml`（§1 本地 unit） | `<install>/config/config.yaml` 单一写法 | 默认 `<install>/config/config.yaml`（portable）/ `/etc/kore/config.yaml`（fhs） | **部分**：portable 一致；fhs 缺失；README 另有第四种名字 |
| `--config` 用法 | 每条命令都带，且强调与 §3 一致 | §7.2 / §7.2.1 有；§7.1 示例**不带**（依赖默认值） | 全文**未出现** `--config` | `KORE_CONFIG > --config > profile`（config.go:63-81） | **部分**：OPERATIONS 完全缺该入口 |
| state 目录 | `./kore-state`（示例显式覆盖） | `/opt/kore/data`、`/var/lib/kore` | portable `<install>/data`、fhs `/var/lib/kore` | portable `<InstallRoot>/data`、fhs `/var/lib/kore`（profile.go:110-126） | **一致**（QUICKSTART 属显式覆盖，见 §3-⑦） |
| 管理员口令 | `--generate --config …`；「重启后生效」 | `--generate`（无 `--config`）；「热更字段，重启只为清会话」 | 备份清单含 `config.yaml`（口令哈希）；**无**生效条件说明 | `admin_password_hash` 在 `mergeAuth` 白名单（reload.go:71） | **不一致**：生效条件三份说法不同（§3-⑤） |
| 离线装插件 | 未涉及 | §6.1.1「**需先停服务**」，撞锁 exit 3 + 提示原文 | §3.1 起实例后直接 `kored install --package` | `install --help`：「在线运行会撞锁 exit 3」；`install.go:133-139` 提示原文与 RUNBOOK 逐字一致 | **不一致**：OPERATIONS 与另两处相反（§3-③） |
| 卸载退出码 | 未涉及 | §6.2.1 表：0 / 0 / 6 / 2 / 1 / 0 | 未涉及 | `main.go:19-24` + `uninstall.go:150/155/313/315/321/323` | **一致**（§2.5） |

## 2. 逐项证据

### 2.1 配置文件路径

| 出处 | 原文（节选） |
| --- | --- |
| `QUICKSTART.md:22` | `./bin/kored admin-password --generate --config ./kore-quickstart.yaml` |
| `QUICKSTART.md:34` | 「或都不用，走默认 `<install>/config/config.yaml`，设了 `KORE_HOME` 就是 `$KORE_HOME/config/config.yaml`…`KORE_CONFIG` 环境变量 > `--config` > profile 默认路径」 |
| `QUICKSTART.md:81` | `./bin/kored serve --config ./kore-quickstart.yaml` |
| `RUNBOOK.md:241` | 「配置：/opt/kore/config/config.yaml（可选；缺失走内置默认 + WARN）」 |
| `RUNBOOK.md:413-414` | 「portable（默认）：`<install>/config/config.yaml`…fhs（发行版打包）：`/etc/kore/config.yaml`」 |
| `RUNBOOK.md:420` | 「`kored serve` 与所有 CLI 子命令**各自**解析 `KORE_CONFIG` > `--config` > profile 默认路径」 |
| `RUNBOOK.md:427` | 「`paths.state_dir` 等相对路径按**进程 cwd** 归一化为绝对路径；写配置时用绝对路径」 |
| `OPERATIONS.md:61` | 「`<install>/config/config.yaml` ｜ 监听地址、口令哈希、路径」 |
| `README.md:22` | 「最小 `kore.yaml`（管理员口令 + `server.addr: 127.0.0.1:8787`）」 |
| 代码 | `internal/core/config/config.go:18` `DefaultPath = "/etc/kore/config.yaml"`；`:79-81` portable 返回 `<InstallRoot>/config/config.yaml` |

结论：QUICKSTART ↔ RUNBOOK ↔ 代码在 **portable 默认路径**上完全一致；`OPERATIONS` 漏 fhs 分支；`README:22` 的 `kore.yaml` 是第四种、且仓库中不存在的名字（`ls kore.yaml` 无此文件）。

### 2.2 state 目录

| 出处 | 原文（节选） |
| --- | --- |
| `QUICKSTART.md:63` | `state_dir: "./kore-state"     # 隔离状态目录，首次启动自动创建` |
| `RUNBOOK.md:242` | 「状态：/opt/kore/data（state.db / plugins / index）」 |
| `RUNBOOK.md:378` | `sudo cp -a /var/lib/kore/. /opt/kore/data/`（fhs → portable 迁移） |
| `RUNBOOK.md:422` | 「serve 用 `--config .kore-local.yaml`（`paths.state_dir: kore-state`），`kored install` 没带 `--config` → 装进 `data/state.db`」 |
| `OPERATIONS.md:9` | 「`<data>` 表示状态目录（portable `<install>/data`、fhs `/var/lib/kore`）」 |
| 代码 | `internal/core/config/profile.go:110-128` `defaultLayout()`：fhs → `StateDir: "/var/lib/kore"`；portable → `filepath.Join(root, "data")` |

结论：**三份与代码默认值均无事实冲突**。`QUICKSTART:63` 是在示例 yaml 里**显式覆盖**默认值（注释已自称「隔离状态目录」），并非描述默认值；但它正是 P0② 的现场（默认 `data/` vs 覆盖后 `kore-state`），文档未提示这层差别，见 §3-⑦。

### 2.3 管理员口令

| 出处 | 原文（节选） |
| --- | --- |
| `QUICKSTART.md:22` | `admin-password --generate --config ./kore-quickstart.yaml` |
| `QUICKSTART.md:31` | 「提示：重启 kored 后生效；忘记口令可再执行 `kored admin-password --set` 重置。」（二进制原样输出） |
| `QUICKSTART.md:72-75` | 首启引导：TTY → 提示输入两次并写配置；非 TTY → 只提示不阻塞 |
| `RUNBOOK.md:395` | `/opt/kore/bin/kored admin-password --generate`（**无** `--config`，走 profile 默认） |
| `RUNBOOK.md:389` | 「口令哈希在配置文件的 `auth.admin_password_hash`，重置 = 生成新哈希并重启」 |
| `RUNBOOK.md:401` | 「重启内核（admin_password_hash 虽是热更字段，但重启最省事、也清掉旧会话）」 |
| `RUNBOOK.md:409` | 「`admin_password_hash` 变化**不会吊销已签发的会话**（配置热更日志会写明）」 |
| `OPERATIONS.md:61` | 「`<install>/config/config.yaml` ｜ …口令哈希…｜ **必须备份**；丢了要重设管理员口令（当前首启 bootstrap 另有已知问题，见 task-170）」 |
| `OPERATIONS.md:149` | 「**首启口令 bootstrap 仍不可用**（`task-170` 在修）：恢复后能登录的前提是 `config.yaml` 里有 `auth.admin_password_hash`」 |
| 代码 | `cmd/kored/admin_password.go:110` 打印「提示：重启 kored 后生效」；`:231` `firstRunAuthGuide`（TTY 交互 / 非 TTY 只提示）；调用点 `cmd/kored/serve.go:26`；`internal/core/config/reload.go:71` `mergeAuth`「会话 TTL 与新密码只影响后续登录/续期」 |

三处「改配置后需重启才生效」的说法：QUICKSTART **写了（需重启）**；RUNBOOK **写了但限定（热更即生效，重启为清会话）**；OPERATIONS **没写**（只在 §1.2 写了换二进制需重启）。另 OPERATIONS:149 与 QUICKSTART:72-75 对「首启 bootstrap 是否可用」直接相反。

### 2.4 离线装插件

| 出处 | 原文（节选） |
| --- | --- |
| `RUNBOOK.md:272` | 「### 6.1.1 离线安装插件（需先停服务）」 |
| `RUNBOOK.md:274-275` | 「`kored install --package` 与 `kored serve` **独占同一个 `state.db`**：服务在跑时执行 CLI 安装会撞文件锁…退出码 3」 |
| `RUNBOOK.md:288-290` | `systemctl --user stop kored-local` → `kored install --package site-0.1.0.tar.gz` → `start` |
| `OPERATIONS.md:133-134` | 「起实例 `KORE_HOME=/tmp/kore-ops bin/kored serve`」→「装 2 插件 `kored install --package file-0.3.1.tar.gz`、`cron-0.4.1.tar.gz`」——**中间无停服务步骤** |
| `install --help`（实跑） | 「注意: install 与 serve 独占同一 state.db，serve 运行时请用 `POST /api/v1/store/install` 安装；CLI install 仅离线使用（在线运行会撞锁 exit 3）／退出码: 0 正常 / 2 校验失败 / 3 状态目录或锁 / 4 存储」 |
| 代码 | `cmd/kored/install.go:133-139` 停服务提示与 RUNBOOK:278-282 逐字同源；`:168-169` 与 `--help` 输出同源 |

结论：`RUNBOOK` 与 `--help`/代码**一致**；`OPERATIONS §3.1` 的记录与二者**相反**，且该行还漏了 `--config`/`KORE_HOME`（新 fail-closed 下会 exit 2）。

### 2.5 卸载退出码

`RUNBOOK.md:342-349` 表 vs `uninstall --help` vs 代码：

| 场景 | RUNBOOK:344-349 | 代码证据 | 一致 |
| --- | --- | --- | --- |
| `sudo kored uninstall --yes [--purge]` 全链 | `0` | `uninstall.go:323 return exitOK`（无失败时） | ✅ |
| `--yes --keep-service --keep-users` | `0` | `:323`；非 root 不触发 needRoot 分支（提示原文 `:314`「该写法返回 0」） | ✅ |
| 非 root、未给两个 `--keep-*` → 部分完成 | `6` | `:300-315` 打印摘要后 `return exitEnv`；`main.go:24 exitEnv = 6` | ✅ |
| 非 root、无 `--yes`（非 TTY）零变更 | `2` | `:146-155` 非 TTY 且无 `--yes` → `return exitConfig`；`main.go:20 exitConfig = 2` | ✅ |
| 有步骤失败 | `1` | `:320-322 return 1` | ✅ |
| `--dry-run` | `0` | `:150 return exitOK`（dry-run 分支） | ✅ |

`uninstall --help` 实际列出的 10 个 flag 与 RUNBOOK:312-318 参数表比对：`--dry-run` / `--yes` / `--purge` / `--keep-service` / `--keep-users` / `--unit-dir` / `--unit-name` / `--user-prefix` 全部对得上；**`-config` 与 `-state-dir` 表里没有**（help 里有），见 §3-⑥。`--purge` 的「需 --yes」在实现上成立（`--yes` 守卫在 `:146`，`opts.purge` 只在 `:236` 之后生效）。

### 2.6 链接可达（`test -e` 实跑）

`README.md:15-20`「开始使用」表 4 个目标：`QUICKSTART.md` / `docs/RUNBOOK.md` / `docs/OPERATIONS.md` / `docs/README.md` —— **4/4 OK**。

`docs/README.md:12-24`「我想做什么」表 15 个目标：`../QUICKSTART.md`、`SCENARIOS.md`、`PLUGIN-CATALOG.md`、`OPERATIONS.md`、`RUNBOOK.md`、`USABILITY.md`、`PLUGIN-SDK.md`、`PLUGIN-PROTOCOL.md`、`DECISIONS/`、`CORE.md`、`RESOURCE-MODEL.md`、`DATA-MODEL.md`、`../CONTRIBUTING.md`、`../SECURITY.md`、`site/index.html` —— **15/15 OK**。

**失效链接：无。**

## 3. 必须修的矛盾（每条含 file:line + 怎么改）

1. **`README.md:22`** — 写「最小 `kore.yaml`」，而 `QUICKSTART.md` 全文用的是 `kore-quickstart.yaml`，仓库根也没有 `kore.yaml`。→ 改成 `kore-quickstart.yaml`（与 `QUICKSTART.md:22/56/81` 对齐）。
2. **`docs/OPERATIONS.md:61`** — fhs 形态下配置路径仍写成 `<install>/config/config.yaml`，与 `RUNBOOK.md:414`「fhs：`/etc/kore/config.yaml`」和 `config.go:18/76` 冲突。→ 该行拆成两行：portable `<install>/config/config.yaml`、fhs `/etc/kore/config.yaml`。
3. **`docs/OPERATIONS.md:133-134`** — 「起实例」后直接 `kored install --package`，与 `RUNBOOK.md:272-296`（需先停服务）及 `install --help`（在线运行撞锁 exit 3）、fail-closed（`install_targets.go:61-70`，无配置且未显式给 `--config` → 退出 2）冲突，且该行未带 `KORE_HOME`/`--config`。→ 该表行改为「先停服务 → `kored install --config <与 serve 相同>`」并标注「此为 2026-11-23 旧行为记录，fail-closed 引入后原命令会退出 2」。
4. **`docs/OPERATIONS.md:149`** — 「首启口令 bootstrap 仍不可用（task-170 在修）」，与 `QUICKSTART.md:72-75`（已描述 TTY/非 TTY 两分支）及代码 `admin_password.go:231` + `serve.go:26` 冲突。→ 核实 task-170 结论后改为「TTY 交互可用；非 TTY 只提示不阻塞（需离线 `admin-password --generate`）」，或删除该句。
5. **`QUICKSTART.md:31`**（同 `:75`）↔ **`RUNBOOK.md:401-409`** — 「重启后生效」vs「哈希是热更字段，重启只为清会话」。→ 统一为「**热更即对后续登录生效；重启最稳妥且能立刻踢掉旧会话**」。注意 `QUICKSTART:31` 是二进制逐字输出，改文案需同时动 `cmd/kored/admin_password.go:110`（属代码改动，超出本审计写域，需另派）。
6. **`docs/RUNBOOK.md:312-318`** — 卸载参数表缺 `--config` / `--state-dir`（`uninstall --help` 实有）。→ 补两行：`--config` 配置文件路径（缺省按 profile 解析）、`--state-dir` 覆盖状态目录。
7. **`QUICKSTART.md:63`** — 示例把 `state_dir` 覆盖成 `./kore-state`，另两份文档默认值写 `data/`（`RUNBOOK.md:242`、`OPERATIONS.md:9`），这正是「两个 state.db」的现场（`RUNBOOK.md:422` 事故原文）。→ 在该行后加一句：「本示例故意覆盖默认值；`RUNBOOK`/`OPERATIONS` 里的 `data/` 指默认值。混用两种路径会出现两个 `state.db`，见 `RUNBOOK.md` §7.2.1。」

## 4. 已一致的（后续不必重复核对）

- 默认配置路径（portable）：`QUICKSTART.md:34` = `RUNBOOK.md:413` = `config.go:78-83`（`<install>/config/config.yaml`，`KORE_HOME` 时 `$KORE_HOME/config/config.yaml`）。
- 默认 state 目录：`OPERATIONS.md:9` = `profile.go:110-128`（portable `<install>/data`、fhs `/var/lib/kore`）；`RUNBOOK.md:242/378` 的 `/opt/kore/data`、`/var/lib/kore` 与之一致。
- 配置解析优先级：`QUICKSTART.md:34` = `RUNBOOK.md:420` = `config.go:63-81`（`KORE_CONFIG` > `--config` > profile 默认）。
- `install` 撞锁文案与退出码：`RUNBOOK.md:278-282/275` ≈ `install --help` ≈ `install.go:133-139/168-169`（exit 3）。
- `uninstall` 六种退出码：`RUNBOOK.md:344-349` 与 `main.go:19-24` + `uninstall.go:150/155/313/315/321/323` 逐条相符（§2.5）。
- `uninstall --purge` 的「需 --yes」语义：`RUNBOOK.md:316` ≈ `uninstall --help` ≈ 守卫位置 `uninstall.go:146`。
- 卸载后「删掉安装目录即等于卸载」的零侵入判据：`RUNBOOK.md:230` = `RUNBOOK.md:335` 断言行（`/etc/kore` / `/var/lib/kore` 均需不存在）。
- 导航链接：`README.md:15-20` 4/4、`docs/README.md:12-24` 15/15 全部可达。

## 5. 未确认项（缺什么证据）

1. **「热更即生效」是否真的成立**：目前只有代码注释证据（`reload.go:71`「新密码只影响后续登录/续期」），未做「起实例 → 改 `admin_password_hash` → **不重启**登录」实测。缺证据：一次隔离实例的 SIGHUP/热更前后登录对照（200/401）。
2. **`OPERATIONS.md:133-134` 当时服务是否真在跑**：记录未附终端输出，「装 2 插件」是否真的没有撞锁无从判断。缺证据：当时的 `kored install` stdout（是否出现「配置: … ｜ 状态目录: …」与 exit code）。
3. **task-170 的当前状态**：工单正文未读；代码侧 `firstRunAuthGuide` 已接线（`serve.go:26`），但 TTY 交互分支未实跑。缺证据：TTY 下首次 `serve` 的实际交互截图/输出，或 task-170 的关闭结论。
4. **`kored status` / `--state-dir` 等新入口是否应在三份文档都出现**：`RUNBOOK.md:426` 已引入 `kored status`，`QUICKSTART` 与 `OPERATIONS` 均未提及；是否需要同步属文档策略问题，本次不下结论（缺：文档分层规范原文）。

## 6. 复核命令（可直接重跑）

```bash
cd /home/pt/Work/GolandProjects/kore
# 1) 配置文件名分布
grep -n "kore-quickstart.yaml\|kore\.yaml\|config/config\.yaml\|/etc/kore/config.yaml" \
  QUICKSTART.md docs/RUNBOOK.md docs/OPERATIONS.md README.md
# 2) state 目录口径
grep -n "kore-state\|<install>/data\|/var/lib/kore\|state_dir" QUICKSTART.md docs/RUNBOOK.md docs/OPERATIONS.md
# 3) 真实 help 输出
./bin/kored install --help; ./bin/kored uninstall --help
# 4) 链接可达
for f in QUICKSTART.md docs/RUNBOOK.md docs/OPERATIONS.md docs/README.md; do test -e "$f" && echo "OK $f"; done
# 5) 退出码码表
sed -n '19,24p' cmd/kored/main.go
```
