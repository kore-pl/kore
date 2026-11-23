[agent:kore-impl-demotion]

# v1 用户旅程垂直切片（全新 portable 安装，2026-11-23）

**结论：一个新手按现有文档从零到「登录后能用」会卡在第二步——共 9 条：P0 4 / P1 3 / P2 2。**
最致命的两条：①文档承诺首启自动生成管理员口令并打印一次（`docs/CORE.md:57`），实际全新 portable 实例**既不生成 config.yaml、也不打印口令**，登录只能得到 401；②`kored uninstall` 非 root 执行时打印「需要 root」却**退出码 0**，且 `--purge` 未生效——按脚本判成功会留下整个安装目录。

实例：`KORE_HOME=/tmp/kore-journey`，`kored serve`（非 root，portable 默认路径），监听 UDS `/tmp/kore-journey/run/kore.sock`；**主实例 8787 零写入**，验证后 `/tmp/kore-journey` 已删除。

## 0. 环境与前置

| 项 | 实际 |
| --- | --- |
| OS / 用户 | Linux，非 root（uid 1000）；portable profile 由 `KORE_HOME` 推导 |
| 构建 | `go build -trimpath -buildvcs=false -o /tmp/kore-journey/bin/kored ./cmd/kored` → exit 0 |
| 启动 | `systemd-run --user --unit=kore-journey env KORE_HOME=/tmp/kore-journey .../kored serve` → ready，socket 生成 |
| 文档依据 | `docs/RUNBOOK.md`（无安装章节，§1 是索引重签流程）；`docs/QUICKSTART.md` **不存在** |

## 1. 六步旅程

| 步骤 | 文档怎么说 | 实际怎样 | 是否卡住 | 严重度 |
| --- | --- | --- | --- | --- |
| ① 安装 | 任务卡/文档引用 `RUNBOOK.md` + `QUICKSTART.md`；`docs/QUICKSTART.md` 不存在；`RUNBOOK.md` 通篇没有「首次安装」小节（`grep -n "安装" docs/RUNBOOK.md` 只命中服务 unit 与 relocation） | 需要自己推断：把 `kored` 放进 `<install>/bin/`、`KORE_HOME` 指过去、`kored serve`。这 3 步文档未写 | 是 | **P0-1** |
| ② 首次登录 | `docs/CORE.md:57`：「`auth.admin_password_hash` 为空 → 首启 bootstrap：生成 24 字符口令…明文口令只打印到 stderr/tty 一次，写回哈希并置 `auth.initialized=true`」 | 全新实例启动日志只有 `WARN 配置文件不存在，使用内置默认值`；`/tmp/kore-journey/config/` 为空（**未生成 config.yaml**）、`serve.out` 无任何口令行；`POST /auth/login` 任意口令 → `401 口令错误`。**没有任何入口可登录** | 是 | **P0-2** |
| ③ 装 3 个插件 | `kored install --package`（`kored --help` 唯一安装入口；RUNBOOK 未写何时执行） | 服务运行中执行：`store: 状态库已被占用（持有者 pid=…）` ×3；**必须先停服务**，但文档没写。停服务后 `installed file 0.3.0 / monitor 0.2.0 / cron 0.4.1` 成功 | 是（文档缺失） | **P0-3** |
| ④ 用起来（file 列目录 / monitor 指标 / cron 建任务） | 面板 + 各视图 | **被 ② 阻断**：无会话，`/api/v1/*` 全 401；CLI 无 `enable` 子命令，无法在无 UI 情况下把插件拉到 ready。三个核心功能一个都没测到 | 是（阻断） | **P0-2 的后果** |
| ⑤ 升级 | 无升级文档；任务卡假设「索引里新版」 | 停机后 `kored install --package file-0.3.1` → `installed file 0.3.1`；`data/plugins/file/` 同时保留 `0.3.0` 与 `0.3.1`（未清理旧版）。配置与启用状态**无法验证**（登录被阻断，且无 CLI 查询） | 部分 | P1-1 |
| ⑥ 卸载 | `kored uninstall --dry-run` / `--purge --yes` | dry-run 输出清晰（unit 不存在、0 个 `kore-*` 用户、`changes.jsonl` 0 条、提示手动 `rm -rf` 安装目录）→ 达标。真卸载（非 root）：打印 `uninstall: 清理 systemd unit 与 kore-* 用户需要 root…`，**exit 0**；`data/`（state.db/plugins）**原样保留**；`--purge` 实际未执行 | 是（假成功） | **P0-4** |

## 2. 问题清单

### P0（4 条）

1. **P0-1 没有首次安装文档**：`docs/QUICKSTART.md` 缺失；`docs/RUNBOOK.md` 无「安装」章节（目录只有索引重签、服务 unit、portable 说明）。新手必须自己猜「二进制放哪、`KORE_HOME` 怎么设、怎么启动」。证据：`ls docs/QUICKSTART.md` → No such file；`grep -n '^## ' docs/RUNBOOK.md` 无安装项。
2. **P0-2 首启 bootstrap 未发生（文档与实际不符）**：按 `docs/CORE.md:57` 应打印 24 字符临时口令并写回配置；实际 `config/` 为空、`serve.out` 无口令、登录 401。日志仅 `WARN … config 配置文件不存在，使用内置默认值`（`/tmp/kore-journey/serve.out` 第 2 行）。后果是整条旅程在第 2 步断掉。
3. **P0-3 CLI 安装与运行中服务互斥且未文档化**：`KORE_HOME=… kored install --package …` 在 `kored serve` 运行时失败：`状态存储打开失败: store: 状态库已被占用`（3 次）。离线/无 UI 场景只有 CLI 安装，但没有任何文档说要先 `systemctl stop`。
4. **P0-4 非 root 卸载假成功**：`kored uninstall --purge --yes` 打印需要 root 的提示后 **exit 0**，`data/state.db`、`data/plugins/` 全在；若脚本按退出码判断会认为卸载完成。证据：命令输出末行无 `[OK]`，但 `echo $?` = 0；随后 `ls data/` 仍列出 `state.db`。

### P1（3 条）

1. **升级残留旧版本目录**：`data/plugins/file/{0.3.0,0.3.1}` 并存；无「旧版是否可回滚/何时清理」说明。证据：`find /tmp/kore-journey/data/plugins/file -maxdepth 1 -mindepth 1` 两行。
2. **无 `kored enable` 等价 CLI**：无 UI 会话时无法启用插件（`kored --help` 只有 serve/version/install/audit/uninstall/help），headless 首次配置必须经过浏览器登录——与 P0-2 叠加后完全不可用。
3. **portable 下 dry-run 仍打印系统 unit 路径**：`[INFO] unit：/etc/systemd/system/kore.service（清理）`，portable 用户会误以为装过系统服务；应标注「本 profile 未使用 systemd unit」。

### P2（2 条）

1. **首启 WARN 没有下一步**：`config 配置文件不存在，使用内置默认值` 只陈述事实，未提示「如何设置管理员口令」或文档链接。
2. **`install --package` 不写任何「下一步」**：成功只输出 `installed file 0.3.0`，不提示如何启用/打开面板。

## 3. 新手步数统计

**从零到「登录后能用」需要 11 步，其中 6 步文档没写**：

| # | 步骤 | 文档 |
| --- | --- | --- |
| 1 | 构建/获取 `kored` 二进制 | 部分（RUNBOOK 有 `make build`，但面向开发） |
| 2 | 创建 `<install>/bin` 并放入二进制 | 未写 |
| 3 | 设置 `KORE_HOME` | 未写（RUNBOOK 只在「换位置」提一句） |
| 4 | 启动 `kored serve` | 部分（unit 章节面向 systemd） |
| 5 | 找到管理员初始口令 | **文档写了机制（CORE:57），实际未发生** |
| 6 | 打开面板并登录 | 未写 |
| 7 | 停止服务 | 未写 |
| 8 | `kored install` 装插件 | 未写（只在 help 里） |
| 9 | 重启服务 | 未写 |
| 10 | 登录后启用插件 | 未写（UI 操作无指引） |
| 11 | 卸载（含 `--purge` 与 root 要求） | 部分（`--help` 有 flag，无场景说明） |

## 4. 建议修复顺序（前 5）

1. **P0-2 修首启 bootstrap**：无 config 时也生成 config.yaml + 打印临时口令（或提供 `kored admin-password --reset`），并在日志给出明确路径；这是唯一硬阻断。
2. **P0-1 新增 `docs/QUICKSTART.md`**：5 条命令内跑起来（二进制放置 → KORE_HOME → serve → 口令 → 打开面板），并与 RUNBOOK 互链。
3. **P0-4 卸载退出码**：非 root 且需要清 unit/用户时返回非 0（或要求显式 `--keep-service --keep-users` 才 0），并让 `--purge` 在提示后仍执行状态清理。
4. **P0-3 文档 + 命令自检**：`kored install` 检测到状态库被占用时提示「先停止 kore 服务」，RUNBOOK 增加「离线安装插件」小节。
5. **P1-2 增加 `kored enable/disable`**（或 `kored plugin enable`），让 headless 首次配置不依赖浏览器。

## 5. 做对的地方

- `uninstall --dry-run` 输出结构清晰：安装根、状态目录、unit、用户前缀、`changes.jsonl` 条数、手动步骤一次列全，且明确「仅为计划」。
- portable 实例确实做到了目录自包含：`bin/config/data/logs/run` 全在 `/tmp/kore-journey`；非 root 运行未新建 `kore-*` 用户、未写 `/etc/systemd/system`（`getent passwd | grep -c '^kore-' = 0`，unit 不存在）。
- 删除安装目录后系统侧无残留（`install_dir_removed=yes`），零侵入的「删目录即清空」在 portable 下成立——**前提是不依赖非 root 的 uninstall 命令**。

## 6. 边界

- 未以 root 验证 systemd unit / `kore-*` 用户路径；本轮只看 portable 非 root。
- 步骤 ④ 五类核心功能因登录阻断未实测（不是通过，是未测）。
- 未接商店（本地无签名索引/网络），插件用本地 `dist/*.tar.gz` 安装；商店路径未覆盖。
