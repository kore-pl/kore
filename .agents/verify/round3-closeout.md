# meta: kind=verification task=round3-closeout date=2026-11-23 owner=r3-closeout verdict=PASS repo=kore

# Round 3 收口：firewall 0.2.3 语义 / 双仓推送 / 36 张双端证据

- 2026-11-23 07:05–07:16+08:00 · r3-closeout · 工作目录 `/home/pt/Work/GolandProjects/kore`
- 纪律：未重启 kored（PID 1376988 全程不变）、未改源码；临时脚本 / 浏览器 profile / cookie 罐已清理。
- G-29 复核：未改 `.kore-local.yaml`；`paths.index_dir` = `kore-plugins/index`，索引 24 条、firewall 0.2.3 sha `353d5626453276b2` == API 返回。

## 1. firewall 0.2.2 → 0.2.3 与语义修正

- 登录 `POST /api/v1/auth/login` → **200**（下发 kore_session + kore_csrf），写操作带 `X-Kore-CSRF`。
- 安装 `POST /api/v1/store/install {"id":"firewall","version":"0.2.3","download":true,"force":true}` → **200**
  ```json
  {"id":"firewall-0.2.3","plugin_id":"firewall","version":"0.2.3","state":"succeeded","message":"已从 v0.2.2 升级到 v0.2.3","previous_version":"0.2.2","stale_versions":["0.2.0","0.2.2"],"reload":"restarted"}
  ```
- `POST /api/v1/plugins/firewall/enable` → **200**（幂等；lazy 空闲 stopped 属正常），版本复核 **0.2.3**。
- **firewall.status** → **HTTP 200**
  ```json
  {"backend":"ufw","available":false,"enabled":false,"default_in":"","rules_count":0,"error":"E_NEED_ROOT: 非 root，且 root-action 通道不可用：E_NEED_ROOT: 需要 root 权限：请用 sudo/systemd 启动 kored（用 `sudo kored` 或 systemd unit（User=root）启动；插件进程自身永不提权）","error_code":"E_NEED_ROOT","hint":"需 root 权限：请用 sudo/systemd 启动 kored，或让内核经 POST /api/v1/plugins/firewall/root-action 执行 ufw-status / iptables-s"}
  ```
  → 可用性缺失走成功包 + error_code，**不是 401**。
- **firewall.rules** → **HTTP 403**
  ```json
  {"code":"E_NEED_ROOT","message":"执行 `/usr/sbin/ufw status numbered` 失败: ERROR: You need to be root to run this script（插件需要 root 权限才能读取/修改防火墙）","detail":"{\"hint\":\"需 root 权限：请用 sudo/systemd 启动 kored，或让内核经 POST /api/v1/plugins/firewall/root-action 执行 ufw-status / iptables-s\"}","hint":"需 root 权限：请用 sudo/systemd 启动 kored，或让内核经 POST /api/v1/plugins/firewall/root-action 执行 ufw-status / iptables-s"}
  ```
  → 能力不足与登录失效分离，**不是 401 E_UNAUTHORIZED**。

## 2. 双仓推送（origin/main == 本地 HEAD）

| 仓库 | 推送前 `origin/main..main` | push | ls-remote 回读 | 本地 HEAD |
| --- | --- | --- | --- | --- |
| kore-plugins | `154a90a` | exit 0 `3473bbb..154a90a` | `154a90a9d6b9…` | `154a90a9d6b9…` |
| kore | `88f9058` `a4af9ee` | exit 0 `3f710e4..a4af9ee` | `a4af9ee7daf1…` | `a4af9ee7daf1…` |

- 任务书点名的 `3473bbb`/`0506b01`/`5eee401`/`f39e1fd`/`a459ec3`/`3f710e4` 已在远端，本地均为其后代；本轮回读逐位相等。
- `make secret-check` → **0 FAIL / 7 处占位匹配合规**（推送后 GitHub 无明文）。

## 3. 36 张截图与每页高度（桌面 1440 full-page / 手机 390×844）

- 目录 `.agents/verify/screenshots/`；36 = 16 页×2 + nav 2 + `r3c-desktop-store-page2` + `r3c-desktop-firewall-hint`。
- 每张截图前断言 `.kore-shell` 存在 + 无 `#kore-password` + `kore_csrf` cookie；截图后断言页特征文本。
- 尺寸实测：19 张 1440 宽、17 张 390×844；`sha256sum r3c-*.png | awk '{print $1}' | sort | uniq -d | wc -l` = **0**（36/36 unique）。

| # | 页 | 桌面高 | 手机高 | 上轮桌面 | 判定 | 依据 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | overview | 900 | 845 | 900 | 可用 | 15 已装 / 14 启用 / 2 运行 / 1 已停用 |
| 02 | monitor | 1992 | 2392 | 1579 | 可用 | CPU 7.6% · 内存 47.1% · 磁盘/负载真实 |
| 03 | logs | 932 | 1474 | 932 | 可用 | syslog 33.1 MB 可读 · journal 可读 |
| 04 | process | 1085 | 1205 | 3973 | 可用 | 802 进程 · 已显示 20 |
| 05 | terminal | 901 | 857 | 901 | 可用 | bash 会话已连接 · 真实 pid |
| 06 | sites | 900 | 1385 | 900 | 可用 | 3 个站点 · 向导可用 |
| 07 | db | 1003 | 1637 | 912 | 可用 | MySQL 9.7.1 已连接 · 1 实例 |
| 08 | redis | 3062 | 3898 | 9386 | 可用 | Redis 7.4.12 · 6,662 键 · 已显示 50 |
| 09 | tasks | 900 | 971 | 900 | 部分可用 | 非 root：crontab 只读 |
| 10 | files | 900 | 1995 | 900 | 可用 | 6 项真实文件/目录 |
| 11 | backup | 900 | 1022 | 900 | 可用 | 1 个备份 · sha 可校验 |
| 12 | ssl | 1039 | 1719 | 1039 | 可用 | 2 张证书 · 真实握手 |
| 13 | store | 1210 | 3370 | 2116 | 可用 | 24 插件 · 分页 第 1/2 页 |
| 14 | plugins | 1563 | 4723 | 1480 | 可用 | 15 已装 · 已停用 1 |
| 15 | firewall | 931 | 1439 | 908 | 部分可用 | 非 root：只读降级 + 折叠指引 |
| 16 | settings | 1043 | 1680 | 1043 | 可用 | 会话有效 · CSRF 状态真实 |

- 高度修复：**Redis 3062**（上轮 9405 任务口径 / r3f 记 9386，降 ~67%）≤3200 ✓；**进程 1085**（上轮 3973，降 ~73%）≤1200 ✓。
- 统计：**可用 14 · 部分可用 2（计划任务、防火墙）· 占位 0**（与上轮持平）。

## 4. 本轮三个修复的验证证据

- **分页生效**：24 插件 / 每页 12 → 页头「第 1/2 页（每页 12 个）」+ 页码条「第 1 / 2 页 · 共 24 个插件」；点「下一页」→「第 2 / 2 页」，点「上一页」回第 1 页（`r3c-desktop-store-page2.png`）。
- **语义修正**：status 200 + available=false + `error_code=E_NEED_ROOT`；rules 403 + `code=E_NEED_ROOT` + hint。两者均在会话有效下发生，非 401。
- **已停用文案**：已装插件页汇总「已启用 14 · 运行中 3 · 空闲 11 · 已停用 1 · 共 15 个」，页内 **无「未启用」** 旧文案。
- **防火墙折叠**：默认只显示「需要 root 权限 + 查看如何配置」，`body.innerText` 无 "You need to be root"；点开为「后端提示：需 root 权限：请用 sudo/systemd 启动 kored…」+ `sudo systemctl restart kore`（`r3c-desktop-firewall-hint.png`，4 个折叠节点）。

## 5. 产品定位自评（G-28 三问）

- 解决什么：单机 Linux 运维面板，16 页覆盖站点/数据库/Redis/文件/备份/证书/防火墙/插件，核心任务点击 ≤3。
- 与宝塔/1Panel 差距：无 RBAC、无多机、无一键环境；非 root 下防火墙/计划任务降级只读（ADR-0018 预期内）。
- 可用还是占位：可用 14 / 部分可用 2 / 占位 0。

## 6. 最直观的 3 个问题

1. **非 root 降级只修了一半**：防火墙已折叠加提示，计划任务仍保留新增表单，点击才知被拒；应进页即禁用表单并复用同款折叠指引。
2. **lazy 空闲与故障视觉未分离**：15 个插件中 11 个空闲（stopped），状态列仍用黄点，与「运行中 3」并列易读成故障。
3. **手机长页无位置记忆**：已装插件手机高 4723、Redis 3898，抽屉切换后从头开始；需记住滚动位置或加吸顶筛选/分页。
