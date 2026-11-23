> 状态: draft · 归属: verifier · 更新: 2026-11-23 · 里程碑: M0

[agent:verify-journey2]

# v1 用户旅程复验（round 2）——P0 修复后从零重跑

**结论（先行）**：上一轮 4 个 P0 中 **2 条已修（P0-4 卸载退出码、P0-2 首启引导文案）、1 条部分修（P0-3 互斥说明写进了 `install --help` 但 QUICKSTART 未写、且实际互斥不再成立反而变成静默双库）、1 条仍未修（P0-1 首次安装文档入口缺失：`docs/QUICKSTART.md` 仍不存在，根 `QUICKSTART.md` 存在但文档内部仍有陈旧引用 `docs/USABILITY.md:131`）**。

**本轮最关键的新发现（P0-A）**：按 QUICKSTART 字面顺序执行，**登录必然 401**——§2 的 `admin-password --generate`（不带 `--config`）把哈希写进 `$KORE_HOME/config/config.yaml`，§3 的 `serve --config ./kore-quickstart.yaml` 读的是**另一个文件**（无哈希）；§2.2 却写着「口令哈希由上面命令写入，这里不必手填」「两者顺序无关」。实测 `POST /auth/login` → **401 口令错误**，必须自己补 `--config <serve 用的那个文件>` 才能登录（**文档之外的第 1 次动作**）。

实例：`KORE_HOME=/tmp/kore-j2`，port **18886**（用前 `ss -ltn` 确认空闲，仅 8787 在听）。**主实例 8787 全程零写入**：未改 `.kore-local.yaml` / state / `bin/kored`（构建一律 `make build BIN=<tmp>`）。验证后 `/tmp/kore-j2` 与临时二进制已删除。

## 0. 环境

| 项 | 实际 |
| --- | --- |
| 起点 commit | `672617b`（开工时 `git log -1`），工作树含**他人未提交**改动（见 §5 P0-B） |
| 构建 | `make build BIN=/tmp/kore-j2/kored` → exit 0，10,141,858 B（21:18） |
| 文档依据 | 根 `README.md` → 根 `QUICKSTART.md` → `docs/OPERATIONS.md`（严格按字面，不抄实现知识） |
| 用户名 | 非 root（uid 1000），portable profile |

## 1. 六步旅程逐步骤对照

| 步骤 | 文档怎么说 | 实际怎样 | 是否卡住 | P0/P1/P2 |
| --- | --- | --- | --- | --- |
| ① 全新安装 | `README.md:17` 「把它跑起来」→ 根 `QUICKSTART.md`；§1 `make build`；§2 口令；§2.2 写 `kore-quickstart.yaml`（`server.addr`+paths）；§3 `./bin/kored serve --config ./kore-quickstart.yaml`；§4 打开 `http://127.0.0.1:8787/` | 入口这次**能走通**（README 四条链接均可点，`QUICKSTART.md` 在根，不在 `docs/`）。但 §2/§3 **配置路径不自洽**：`--generate` 默认写 `<install>/config/config.yaml`，§3 却 `serve --config ./kore-quickstart.yaml` | 部分（能装起来，但口令写错文件 → 下一步卡死） | **P0-A** |
| ② 首次登录 | §2 `./bin/kored admin-password --generate` →「kored 自己生成 24 字符口令，**只显示这一次**，同时把 PBKDF2 哈希原子写进配置文件」「已将口令哈希写入 /opt/kore/config/config.yaml（权限 0600）」；§5 `POST /api/v1/auth/login` | **口令侧全部达标**：输出与文档逐字一致、口令 24 字符只打印一次、`stat -c%a` = **600**、原子写（二次执行会换成新口令、旧口令立即失效）。**登录侧失败**：用该口令 `POST /auth/login` → **401 `{"code":"E_UNAUTHORIZED","message":"口令错误"}`**，因为 serve 读的 `kore-quickstart.yaml` 里 `admin_password_hash` 计数 **0**，而 `config/config.yaml` 里是 1。补 `--config /tmp/kore-j2/kore-quickstart.yaml` 重生成 → **200** | **是（字面流程 401）** | **P0-A** |
| ②b 不设口令直接启动 | §2.3：stdin 非终端 → 打印可操作提示、不阻塞启动 | **达标**（比上一轮只 WARN 一句改善明显）。实测 3 行：`提示：还没有管理员口令，面板将无法登录（非交互环境不阻塞启动）。` + `执行 kored admin-password --generate …` + `systemd / 容器部署请先离线设置口令，再重启 kored。`；进程照常 ready、`/-/healthz` 200 | 否 | 已修（P0-2） |
| ③ 装插件 a（商店/接口） | QUICKSTART **未覆盖装插件**；`docs/OPERATIONS.md:134` 只有一行 `kored install --package` | `POST /api/v1/store/install`（`package_path`）三个包**全 502**：`market: 索引文件读取失败: 读取 plugins.json: open /tmp/kore-j2/data/index/plugins.json: no such file or directory`。**没有任何文档说要先有本地索引**（`GET /plugins` 仍 `{"plugins":[]}`） | 是（文档未写前置：索引） | **P1** |
| ③ 装插件 b（离线 CLI，**故意在服务运行时**） | `install --help`：`注意: install 与 serve 独占同一 state.db，serve 运行时请用 POST /api/v1/store/install 安装；CLI install 仅离线使用（在线运行会撞锁 exit 3）`；QUICKSTART 未写此约束 | **互斥没有发生**：CLI `KORE_HOME=/tmp/kore-j2 kored install --package file-0.2.1.tar.gz` 在 serve 运行时 **exit 0 / `installed file 0.2.1`**。原因是 serve 用 `paths.state_dir=/tmp/kore-j2/kore-state`，CLI 不读该配置、直接开默认 `$KORE_HOME/data/state.db` → **两个库**：`data/state.db` 与 `kore-state/state.db` 各 32768 B 并存，运行中实例 `GET /plugins` 仍 `{"plugins":[]}`。**help 承诺的 exit 3 不成立，且是静默分叉（比上一轮报错更难发现）** | 是（静默假成功） | **P0-C** |
| ③ 装完是否自动启用 | 无文档承诺 | 停服务后 CLI 装 `cron 0.2.1` / `monitor 0.1.1` → `installed`；重启后 `GET /plugins` **仍为空列表**（与 P0-C 同因：库不对齐）。**自动启用判定：未测到有效证据** | 是（阻断） | 归因 P0-C |
| ④ 用起来（file / monitor / cron） | QUICKSTART 无「装完怎么用」 | **未测通**：`POST /invoke/file/file.list` → 404 `插件 file 未安装`；`POST /invoke/monitor/monitor.system` → 404；`POST /scheduler/tasks` → 400 `plugin "" 不合法`（我用错了 action 结构：需 `{plugin, method}` 而非 `action`）。**方法名/参数是我猜的，不是文档给的——按 G-07 记为「未测」，不记通过** | 是（无文档 + P0-C） | 未测 |
| ⑤ 升级 kore 自身 | `docs/OPERATIONS.md` §1.1：停服务 → 备份 → `cp` 旧二进制为 `.bak-$(date)` → `install -m 0755 ./kored-new <install>/bin/kored` → 起 → `curl /-/healthz` + `kored version` | **未能执行**：`make build BIN=/tmp/kored-x` → **exit 2**，`cmd/kored/uninstall.go:285:42: undefined: strings`（**工作树被他人改坏，HEAD 本身 import 齐全**，见 P0-B）。因此「造新二进制」这一步照做失败；后续替换步骤未做，**state/插件/配置保留性：未测**（仅记录升级前快照：`kore-quickstart.yaml` md5 与 `data/state.db` md5，后者因服务在跑本就变化，不构成结论） | **是** | **P0-B** |
| ⑥ 卸载 | 上一轮：非 root 真卸载 **exit 0 假成功** | **已修**：`uninstall --dry-run` exit **0**（只读，合理）；真卸载（非 root，`--yes`）exit **6** + `uninstall: 清理 systemd unit 与 kore-* 用户需要 root：请用 sudo kored uninstall，或加 --keep-service --keep-users 只清状态目录`，`data/` 保留（state.db/plugins/credentials）——**退出码与提示都对**。遗留：**portable 下 dry-run 仍打印 `[INFO] unit：/etc/systemd/system/kore.service（清理）`**（上一轮 P1-3 未修） | 否（功能已修） | P1（unit 行） / P2（exit 6 与 G-16「OS 低于下限」的退出码语义撞车，未文档化） |

## 2. 上一轮 4 个 P0 的当前状态

| 编号 | 上一轮问题 | 当前状态 | 证据 |
| --- | --- | --- | --- |
| P0-1 | 「首次安装文档」缺失：`docs/QUICKSTART.md` 不存在 | **部分修**：根 `QUICKSTART.md` 存在且 `README.md:17` 加了「开始使用」入口（4 条链接实测可达），新手可找到；但 **`docs/QUICKSTART.md` 依然不存在**（`ls docs/QUICKSTART.md` → No such file），且 `docs/USABILITY.md:131` 仍写「`docs/QUICKSTART.md` 不存在」的旧结论未同步（G-06 文档漂移） | `ls docs/QUICKSTART.md` → No such file；`grep -rn QUICKSTART docs/` 命中 `docs/FRONTEND.md:296`、`docs/USABILITY.md:131` |
| P0-2 | 首启不生成口令、只有一条 WARN，无入口可登录 | **部分修**：首启引导已可操作（非 TTY 打印 3 行含下一步命令，不阻塞；见上表 ②b）。但**引导给出的命令与 §3 的 `--config` 不自洽** → 照做仍 401，用户必须自己发现 `--config`。所以「首启有引导」= 修好，「按引导能登录」= **仍需文档之外的补救** | `logs/serve1.log` 3 行提示原文；`logs/login1.json` `{"code":"E_UNAUTHORIZED","message":"口令错误"}`；`--config` 后 `login HTTP 200` |
| P0-3 | `install --package` 与运行中服务互斥未文档化 | **部分修 / 现象变形**：`install --help` 已写明互斥与 exit 3（文档层修了）；但 QUICKSTART / OPERATIONS **仍未写**，且 `OPERATIONS.md:134` 的实测表把「起实例」与「`kored install --package`」并列，读者会以为可以边跑边装（自相矛盾）。**更严重的是互斥本身不再生效**：serve 用自定义 `paths.state_dir` 时 CLI 装进另一个库、exit 0、运行中实例看不到（P0-C） | CLI 输出 `installed file 0.2.1` exit 0；`ls -l data/state.db kore-state/state.db` 两个 32768 B；`GET /api/v1/plugins` → `{"plugins":[]}` |
| P0-4 | 非 root `uninstall` exit 0 假成功 | **已修**：真卸载 exit **6** + 明确 `sudo` / `--keep-service --keep-users` 指引；`data/` 按设计保留。`--dry-run` exit 0 合理 | `uninstall_exit=6` + 原文提示 |

## 3. 新手从零到能用需要几步 / 其中几步文档没写

上一轮：**11 步，6 步文档没写**。本轮（严格按 README → QUICKSTART 字面）：

| # | 步骤 | 文档 | 备注 |
| --- | --- | --- | --- |
| 1 | 找到入口（README → QUICKSTART） | ✅ 已写 | 本轮改善点 |
| 2 | `make build` | ✅ 已写 | 但仓库根 `bin/kored` 被主实例持有（G-29），实际要用 `BIN=` 重定向——文档未提（P2） |
| 3 | `admin-password --generate` | ✅ 已写 | 达标（0600、只打印一次） |
| 4 | 写 `kore-quickstart.yaml`（含 `paths`） | ✅ 已写 | 达标 |
| 5 | **让口令写进 serve 真正读的那个文件** | ❌ 未写 | **新增卡点**：`--generate` 要加 `--config`（文档说「不必手填」「顺序无关」→ 错的） |
| 6 | `serve --config …` | ✅ 已写 | 达标（`kore ready … addr=127.0.0.1:18886`） |
| 7 | `POST /auth/login` 登进去 | ✅ 已写 | 第 5 步没做就 401 |
| 8 | **准备本地索引**（`data/index/plugins.json`）才能走商店装插件 | ❌ 未写 | 502 `读取本地索引失败` |
| 9 | 认识「CLI 装 ≈ 另一个库」的坑 | ❌ 未写 | P0-C |
| 10 | 装完启用/在哪个库看插件 | ❌ 未写 | `install` 成功只输出 `installed <id> <ver>`，无「下一步/去哪看」 |
| 11 | 各能力的调用方法（file/monitor/cron 参数） | ❌ 未写 | 本轮未测通 |

**步数对比**：11 步（与上一轮同量级），**文档没写 5 步**（上一轮 6 步）。「装起来 + 登进去」这段确实变短了（上一轮第 2 步硬阻断，本轮只需补 1 个 `--config`）；但**装插件到能用**这段仍然是文档空白区。

## 4. 新发现的问题

### P0-A 文档字面流程登录必然 401（配置路径不自洽）
`QUICKSTART.md:22`（`admin-password --generate`）、`:52-67`（「口令哈希由上面命令写入，这里不必手填」「两者顺序无关」）、`:79`（`serve --config ./kore-quickstart.yaml`）三处互相矛盾：`--generate` 默认写 `<install>/config/config.yaml`，`serve` 读 `kore-quickstart.yaml`。
- 证据：`grep -c admin_password_hash /tmp/kore-j2/config/config.yaml` = **1**；同一时刻 `grep -c admin_password_hash /tmp/kore-j2/kore-quickstart.yaml` = **0**；`POST /auth/login` → **401**；补 `--config` 后 → **200**。
- 修法：§2 的命令改成 `./bin/kored admin-password --generate --config ./kore-quickstart.yaml`，或 §2.2 直接删掉「不必手填 / 顺序无关」并显式写「两条命令必须指向同一 `--config`」。

### P0-B 工作树被并发改坏，`make build` 直接失败
`make build BIN=/tmp/kored-x` → exit 2：`cmd/kored/uninstall.go:285:42: undefined: strings`（另一 agent 正在改 `uninstall.go` / `install.go` / `installer/*`，未提交；HEAD 的该文件 `import "strings"` 齐全，`git log -1 -- cmd/kored/uninstall.go` = `593d224`）。
- 这是**共享工作区**问题不是 HEAD 缺陷，但它让任何「照文档 `make build`」的验证当场失败；且我 21:18 的构建是成功的（同一命令），说明改动是 21:18~21:28 之间落进工作树的。
- 证据：`/tmp/kore-j2/logs/build_x.out` 尾 3 行。

### P0-C CLI 安装不再撞锁，改成静默装进另一个 state.db
`install --help` 承诺「serve 运行时撞锁 exit 3」，实测 **exit 0 / `installed`**，因为 CLI 不读 `--config` 的 `paths.state_dir`：serve 用 `kore-state/state.db`，CLI 写 `data/state.db`（两个 32768 B 文件并存），运行中实例 `GET /plugins` → `{"plugins":[]}`，插件「装了但不存在」。
- 影响：离线补装插件的人会得到成功回显却在面板里找不到；比上一轮的报错版本更难排查。
- 修法（任选）：CLI 支持 `--config` 并复用同一路径解析；或检测到「`$KORE_HOME` 下存在 serve 正在持有的另一个 state.db」时 exit 3；或在 `installed` 后打印「写入 `<路径>`；若服务已启动且路径不同，需重启/指向同一 `paths.state_dir`」。

### P1
1. **商店安装缺索引前置**：`POST /store/install`（`package_path`）→ 502 `market: 索引文件读取失败 … data/index/plugins.json`；QUICKSTART/OPERATIONS 都没写「离线装插件要先有本地索引」。
2. **`OPERATIONS.md:134` 与 `install --help` 自相矛盾**：前者把「起实例」和「`kored install --package`」写在同一流程表里，后者说「CLI 仅离线使用」。
3. **`docs/USABILITY.md:131` 仍是旧结论**（「`docs/QUICKSTART.md` 不存在」），与本轮事实漂移（G-06）。
4. **portable 下 `uninstall --dry-run` 仍打印 `/etc/systemd/system/kore.service`**（上一轮 P1-3 未修）。

### P2
1. `make build` 字面会覆盖运行中的 `bin/kored`（G-29 运行态资产），文档未提示用 `BIN=` 或先停主实例。
2. `install --package` 成功只输出 `installed <id> <ver>`，无「去哪启用 / 怎么验证」。
3. `uninstall` 非 root 用 **exit 6**，与 G-16「OS 版本/架构低于下限 = 6」撞车，未在文档标注该退出码含义。

## 5. 未测 / 受限项（明确声明，不计通过）

| 项 | 原因 |
| --- | --- |
| ④ 用起来（file 列目录 / monitor 指标 / cron 建任务） | 插件装进另一库（P0-C），`POST /invoke/*` 404；且调用方法名无文档，我不拿猜测当结论 |
| 商店页面的浏览器 UI 安装（G-28 双端截图） | 未做浏览器操作；仅测了同名 HTTP 接口，502 阻断 |
| ⑤ 升级后 state / 插件 / 配置保留性 | `make build` 因 P0-B 失败，造不出新二进制；替换与重启验证未执行 |
| 首启 TTY 交互路径（stdin 是终端时提示输入两次口令） | 未构造 PTY，只测了非 TTY（systemd 场景） |
| 装完自动启用 | 无有效插件可见，无法判定 |

## 6. 清理与边界

- 隔离实例 pid 已杀；端口 18886 已释放（`ss -ltn` 不再命中）；`/tmp/kore-j2`、`/tmp/kored-x` 已删除。
- **主实例 8787 零写入**：未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`；所有构建均用 `BIN=<tmp>`。`curl /api/v1/system/info` 未触碰主实例配置。
