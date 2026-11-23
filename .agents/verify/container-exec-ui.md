> 元信息: 2026-11-23T21:53+08:00 · 执行者 shot-cexec2 子 agent · 容器执行区块 G-28 双端截图（commit 34bacb2）· 报告 ≤70 行

# 容器执行区块 · G-28 双端证据

## 0. 口径与前置事实
- 主实例 8787（PID 2798902）**零写入、未重启**；本轮所有操作只在隔离实例 `/tmp/kore-cexec2`（端口 **18872**）内。
- 隔离配置独立 `--config`，state/run/log 全落 `/tmp/kore-cexec2`；`paths.index_dir` **只读指向** `/home/pt/Work/GolandProjects/kore-plugins/index`。
- 管理口令 `kored admin-password --generate --config <隔离配置>` 生成（报告不落明文，值 `***`）；`POST /api/v1/auth/login` → HTTP 200，`kore_session`(HttpOnly) + `kore_csrf`，写请求带 `X-Kore-CSRF` 双提交。
- 插件：索引 `plugins.json` 的 `container` = **0.5.2**，`download_url` 为 GitHub release v0.5.2 包，sha256 `975820eb…a578b6`；`POST /api/v1/store/install`（真实下载 + 验签）→ HTTP 200 `reload:"reloaded"`；`enable` → HTTP 200 `enabled:true` / `desired:"enabled"`。

## 1. 本机 Docker 可用性（决定能截什么）
- `docker version`：Client **29.7.2**、Server **29.7.2**（Engine 29.7.2 / containerd v2.3.3 / runc 1.4.3），daemon 正常。
- `docker ps`：9 个运行中容器（mysql / nginx / 若干 live-* 服务）。→ **执行成功路径可真实验证**，非静态占位。
- 测试容器：`docker run -d --name kore-cexec2-alpine alpine sleep 300`（截完 `docker rm -f` 清理）。

## 2. 截图清单（`file` 实测宽高）
截图工具链：Playwright 未装本机 CLI，改用**裸 CDP**（Node 24 内置 WebSocket）驱动 chromium；二进制显式 `executablePath = ~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（`chrome-linux/chrome` 不存在，仅 `chrome-linux64` 可用；Chrome/156.0.8078.4），`--headless=new --hide-scrollbars`。

| 场景 | 文件 | file 实测 | 关键断言 |
| --- | --- | --- | --- |
| ① 执行区块初始态 | `screenshots/container-exec-initial-desktop.png` | **1440 × 1142** | 危险提示「以容器内身份运行，可能修改容器内容」+「每个参数一行，不经过 shell」+ 多行参数框 + user/workdir 均可见 |
| ① 初始态（手机） | `screenshots/container-exec-initial-mobile.png` | **390 × 844** | 同上；抽屉全宽 100vw，选项竖排 |
| ② root 门控 | `screenshots/container-exec-root-gate-desktop.png` | **1440 × 1153** | user 选 `root` 后复选框出现（hidden=false）、**未勾选时提交按钮 disabled=true**、`checked=false` |
| ② root 门控（手机） | `screenshots/container-exec-root-gate-mobile.png` | **390 × 844** | 同上；勾选框与按钮触摸目标 ≥44px |
| ③ 执行结果 | `screenshots/container-exec-result-desktop.png` | **1440 × 1175** | `["echo","hello"]` → 「退出码 0」+ stdout `hello` + stderr「（空）」+ 复制按钮 |
| ③ 执行结果（手机） | `screenshots/container-exec-result-mobile.png` | **390 × 844** | 同上，输出分区纵向排列 |
| ④ 策略拒绝 | `screenshots/container-exec-deny-desktop.png` | **1440 × 1197** | `["nsenter"]` → 「该命令被安全策略拒绝：nsenter 被拒绝：…直接逃逸出容器…不需要重试」；结果区 **button 数 = 0**（无重试按钮） |
| ④ 策略拒绝（手机） | `screenshots/container-exec-deny-mobile.png` | **390 × 844** | 同上 |

说明：PC 图为 full-page（宽度严格 1440，高度随内容 1142–1197）；手机图为 390×844 视口截取（G-28 手机口径为 390×844）。

## 3. 四类画面：截到 / 没截到
- ① 初始态：**已截到**（双端）。
- ② root 门控：**已截到**（双端），门控行为由 DOM 断言交叉验证：`checked=false` + `runDisabled=true`。
- ③ 执行成功：**已真实验证并截到**（双端）：临时 alpine 容器内执行 `echo hello`，返回退出码 0、stdout `hello`、耗时 0.0 秒；未起假数据。
- ④ 策略拒绝：**已截到**（双端）：`nsenter` 命中逃逸策略，错误翻人话生效且无重试按钮。
- **未触发（故未截图）**：`timed_out` 徽标（后端 30 秒上限）、`truncated` 徽标（2 MiB 预算）、root 实际执行、自定义 user（`nginx` / `1000:1000`）、自定义 `workdir`。这些是同一区块的其它分支，本次未构造。

## 4. 边界与未验证项（不许当已验证）
- 本轮**未改动主实例运行态配置**；未改代码；未 push。
- 未验证：root 勾选后真实提权执行链路（只验证 UI 门控）；超时 / 截断徽标的真实渲染；`detail.reason` 错误码字段（UI 已正确拒绝，但截图只证明文案层）；手机端横屏。
- 其它 `kored serve` 隔离实例为**其他 agent 残留，仅报告未处理**：`/tmp/kore-t196`、`/tmp/kore-cexec`、`/tmp/kore-adp3`、`/tmp/kore-wafe2e`、`/tmp/kore-uninui`（各自独立 config，未触碰）。
- 控制台噪声：登录前的 401、若干 404/501（未实现端点）与密码表单无障碍提示，均为既有行为，不影响本区块断言。

## 5. 产品定位自评（G-28 第三项）
1. **本页解决什么用户问题**：让运维在不记 docker 参数、不碰宿主机 shell 的前提下，对单个容器做一次可审计的临时命令（看日志 / 查进程 / 试配置），并明确展示结果与失败原因。
2. **与宝塔 / 1Panel 同类功能差距**：宝塔/1Panel 多为「进入容器终端」（交互式 shell、经 bash、长期会话）；本页是 **argv 数组、不经 shell、一次一命令**，安全面更小、可审计性更好，但缺少交互式终端、文件上传、命令历史与批量多容器执行——属于「单点执行」而非「容器终端」。
3. **当前「可用」还是「占位」**：**可用（受能力边界约束）**。执行成功与策略拒绝路径已真机验证，root 门控为硬门禁；但超时/截断徽标、自定义 user/workdir、root 实际执行尚未实测，按「可用 + 边界待补」记录，不记「完全验证」。

## 6. 清理
- 杀隔离 kored（PID 2845353，config `/tmp/kore-cexec2/config.yaml`）→ `docker rm -f kore-cexec2-alpine` → 删 `/tmp/kore-cexec2` → `ss -ltn` 确认 **18872 已释放**；主实例 8787 未重启、`git status` 无运行态改动。
