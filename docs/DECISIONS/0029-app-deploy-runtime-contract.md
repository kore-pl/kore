> 状态: proposed · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: proposed（待裁决）· 关联: 0022-root-command-shapes.md、0028-controlled-file-write.md、0018-privilege-model.md、0023-zero-intrusion.md、0026-credential-transport.md

# ADR-0029: app-deploy「包 → 运行时」契约

## 0. 问题

`app-deploy` 0.3.0 已能 `upload` → 解压到 `$KORE_PLUGIN_DATA/apps/<name>` → `deployFromArtifact` 登记作业 → `upgrade` → 快照回滚；但**包落盘后不会运行**：`callDeployFromArtifact`（`internal/apop/artifact.go:531`）只登记部署记录与站点/建库提示，不启动任何进程。实现方挂账「运行用户包需要镜像/运行时选择与健康检查契约，属设计层（G-22），未擅自选型」。

不解决这条，「一键部署」就只是「一键解压」。

## 1. 事实与边界

| 事实 | 含义 |
| --- | --- |
| 模板路径（4 个内置模板）走 `docker run`，镜像只在源码常量、只接受模板 id | 模板部署已有运行时；**用户包**没有 |
| 用户包解压到 `$KORE_PLUGIN_DATA/apps/<name>`（0700，属主 `kore-app-deploy`） | 数据天然在安装根内（ADR-0023 合规） |
| 插件进程以 `kore-<id>` 降权运行（ADR-0018） | 插件不能写 `/etc`、不能起系统服务、不能 `docker`（无权限） |
| 内核受控通道 = `rootpolicy` 命令形状 + systemd-run 临时单元（ADR-0022） | 目前**没有 `systemd-run` 形状**，只有 `systemctl` |
| 插件不得常驻业务进程（薄壳 + ADR-0019 单 ticker） | 插件不能自己 fork 监督用户应用 |

## 2. 候选方案

### A：docker 化（包 → Dockerfile/基础镜像 → 起容器）

- **做法**：识别 `Dockerfile` 自动 `docker build`；否则按语言猜基础镜像起容器。
- **安全面**：容器不是安全边界（rootless 需额外配置）；构建需 `docker build` 访问宿主 daemon（等价 root）；镜像拉取引入外网与供应链。
- **零侵入**：容器数据卷可落 `<install>/data`，但 docker daemon、镜像缓存、网络规则都在安装根外，且 daemon 是常驻服务 → 与「空载 1 进程」冲突。
- **依赖白名单**：G-02 禁容器 SDK；只能用 CLI。G-05 明确不引入容器运行时作为常驻组件。
- **预算**：docker daemon 常驻（~100 MiB RSS）＋ 每应用容器开销，与主壳预算无关但占宿主。
- **体验**：对「有 Dockerfile 的用户」最好；对没有 docker 的 Tier A 最小主机直接失败。
- **成本**：2–3 人日（构建上下文、日志、健康检查仍要另做）。
- **结论**：**否决作为 v1 默认**；仅作为后续「显式启用 docker 的部署后端」单独立 ADR（用户已装 docker 且明确选择时）。

### B：systemd 服务化（临时单元 `systemd-run`，推荐目标态）

- **做法**：按包类型判定启动命令 → 通过内核 `systemd-run` 形状起**临时单元** `kore-app-<name>.service`：
  `--unit=kore-app-<name>`、`--property=DynamicUser=yes`（临时用户，退出即回收，不新增系统账户）、`--working-directory=<appdir>/current`、`--property=ProtectSystem=strict`、`--property=PrivateTmp=yes`、`--property=ReadWritePaths=<appdir>`、`--property=MemoryMax=<N>M`、`--property=CPUQuota=<N>%`。
- **安全面**：以 DynamicUser 运行、非 root、只读系统 + 可写应用目录；启动命令来自包内入口（Procfile / package.json start / 裸二进制），**不是任意 shell**——命令必须是单条 argv（无 shell、无 `;`、无管道），由内核形状校验。
- **零侵入**：**临时单元不落 `/etc/systemd/system`**（`systemd-run` 只进 runtime cgroup），无 enable 软链；DynamicUser 不持久化 `/etc/passwd`；应用数据在 `<install>/data/apps`。因此**不需要新增 ADR-0023 豁免**（无宿主持久写入）。
- **依赖白名单**：不引入任何 Go 依赖（systemd 已存在）。
- **预算**：应用进程不计入主壳预算；cgroup 限额由 `MemoryMax` / `CPUQuota` 保证。
- **失败模式**：单元启动失败 / 健康检查超时 → 停单元 + 回滚到上一快照 + 作业失败（不自动重试、不轮询）。
- **成本**：3–4 人日（新 `systemd-run` 形状 + 包类型判定 + 健康检查 + 回滚编排 + 测试）。
- **依赖**：**ADR-0022 需增补 `systemd-run` 形状**（参数白名单、unit 前缀 `kore-app-`、workdir 必在应用根内、可执行文件必在 workdir 内、属性白名单）；不依赖 ADR-0028（不写 `/etc`）。

### C：插件自托管（fork + 监督）

- **做法**：app-deploy 自己 fork 应用进程、守护、重启。
- **安全面**：应用与插件同 uid（`kore-app-deploy`），应用可读插件自己的凭据/状态；隔离边界消失。
- **架构**：违反「插件不得常驻业务」与 ADR-0019 单 ticker；插件生命周期（lazy 300s 退出）会把应用一起带走。
- **结论**：**否决**。

### D：只生成产物与启动命令（v1.0 立即落地）

- **做法**：部署完成返回 `artifactDir`、`startCommand`、建议的 `systemd-run` 命令、日志与端口提示；用户复制执行。
- **安全面**：零新增（用户自己承担）。
- **零侵入**：完全合规。
- **体验**：比手抄好（命令已生成、路径已填），但仍不是「一键运行」。
- **成本**：0.5 人日（在现有 job 结果里加字段）。
- **结论**：**作为 v1.0 的第一期**（B 的前置形态），不是终态。

## 3. 推荐

**分两期：v1.0 先 D（立即可交付），v1.1 做 B（目标态）。A 作为「用户显式启用 docker」的后续 ADR，C 否决。**

理由：B 是唯一同时满足「真的跑起来」「不新增宿主持久物」「有资源限制与日志」「不违反薄壳/单 ticker」的方案；但它依赖 ADR-0022 新增形状，不能在 v1.0 前塞进内核。D 先把「解压 → 会跑」的体验补上一半，且是 B 的输出契约（B 落地后 D 的命令自动变成内核代跑）。

## 4. 包类型判定表（B/D 共用）

| 类型 | 判定条件（按序匹配） | 运行方式 |
| --- | --- | --- |
| 静态站点 | 根有 `index.html`，且无 Procfile / package.json.start / 可执行入口 | **不起进程**，交给 `site` 插件（nginx）；不写入 `/etc/nginx`（见 §5） |
| 带 Dockerfile | 根有 `Dockerfile` | v1 **不自动运行**：返回 D 的命令提示；要跑需先立「docker 后端」ADR |
| Procfile | 根有 `Procfile` 且含 `web: <cmd>` | B：解析 `web` 行的单条 argv（禁 shell 元字符），systemd-run 执行 |
| Node 应用 | `package.json` 有 `scripts.start` | B：用 `runtime-node` 探测到的 node 绝对路径执行 `start`（不硬编码） |
| 裸二进制 | 根有可执行文件且 `file` 为 ELF、架构与宿主一致 | B：直接执行 |
| 其它 | 都不匹配 | D：只给产物路径 + 说明「未识别到启动入口」 |

## 5. 健康检查 / 回滚 / 日志 / 资源

| 项 | 契约 |
| --- | --- |
| 健康检查 | 单元 active 后，若包声明端口（Procfile `PORT` / package.json `port`），HTTP GET `/`（或 `/healthz`）30s 内 2xx/3xx 视为健康；未声明端口则只判 active + 进程存活 10s。**不轮询**：只在启动窗口内探测，失败即失败 |
| 失败回滚 | 起单元前把 `current` 指向新版本目录；健康检查失败 → `systemctl stop kore-app-<name>` → `current` 指回上一快照 → 重新起旧单元（一次，不循环） |
| 日志 | 全部进 journald（`journalctl -u kore-app-<name>`）；插件只读取最近 N 行（只读形状），不落自有日志文件，不复制到 state |
| 资源限制 | `MemoryMax`（默认 256 MiB，可配 64–2048）、`CPUQuota`（默认 50%，可配 10–400）、`TasksMax=256`、`NoNewPrivileges=yes`、`ProtectSystem=strict`、`PrivateTmp=yes`、`ReadWritePaths=<appdir>` |
| 网络 | 应用默认只监听 `127.0.0.1:<port>`；对外暴露由 site/nginx 反代（不自动开防火墙） |

## 6. 与其它 ADR 的依赖关系

- **ADR-0022（必须）**：新增 `systemd-run` 命令形状。参数白名单：`--unit=kore-app-<name>`（名字 `^[a-z][a-z0-9-]{0,31}$`）、`--property=` 仅允许上表属性、`--working-directory` 必须在 `<install>/data/apps/<name>/current`、可执行文件必须在 workdir 内、argv 禁止 `;` `|` `&` `$` 反引号换行；不允许 `--scope`、`--shell`、`--setenv` 任意值（env 走受控列表）。
- **ADR-0028（不必须）**：B 不写 `/etc`，不需要受控文件写；静态站点走 site 插件，若未来要写 nginx 片段才依赖 0028。
- **ADR-0023（不变）**：临时单元 + DynamicUser 不留宿主持久物；应用数据全在 `<install>/data`。
- **ADR-0026（可选）**：应用需要的凭据由用户在凭据库授权给 `app-deploy`，再由内核注入临时单元环境（不落盘）。

## 7. 复审条件

1. 用户明确装好 docker 并要求容器化 → 单独立「docker 后端」ADR（A 的受控形态）；
2. 需要开机自启用户应用 → 那会落持久 unit（豁免 #1 扩展），必须先改 ADR-0023；
3. 需要多进程（web + worker）→ 扩展为每应用多个临时单元，重新评估 `TasksMax` 与预算；
4. 包类型判定出现误判（如静态站点被当 Node 应用）→ 判定表加"显式 `kore.json` 声明"优先于自动判定。
