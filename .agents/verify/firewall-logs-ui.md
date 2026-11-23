# firewall + logs 双端截图（G-28）

> 元信息: 2026-11-23T20:20+08:00 · 执行者 kore-impl-monitor 子 agent · 隔离实例 `127.0.0.1:18885`（config/state/run/log 全在 `/tmp`）· 真 chromium 156 headless（CDP）· 报告 ≤60 行

## 1. 结论

两页各 2 张、共 **4 张**双端截图，`file` 复核宽高全部符合 G-28（桌面 1440 宽 full-page / 手机 390×844）。firewall 页在非 root 下为 **`available=false` / `E_NEED_ROOT` 降级态**（「只读降级」+「不可读」+ root 指引），本报告不把该降级态表述为真实开关可用。主实例 8787 未触碰。

## 2. 隔离实例与数据来源

- 端口 `127.0.0.1:18885`（18882/18883/18884 未使用）；`kore-fwlogs-18885` 独立 `--config`，`paths.{state_dir,run_dir,log_dir}` 全落 `/tmp/kore-fwlogs-18885`。
- 插件经 `kored install --package` 装入隔离 state：**firewall 0.2.4**（dist 包）+ **logs 0.4.2**（dist 包），登录后 `POST /plugins/{id}/enable` 均 200。
- 实际调用：firewall `status` → `{"backend":"ufw","available":false,"error_code":"E_NEED_ROOT",...}`；页面据此渲染降级态。logs 页 200，来源/尾部/搜索入口可见。
- 登录：隔离实例自建 `auth.admin_password_hash`（PBKDF2），浏览器在登录页输入临时口令；**不记录口令、不落盘到仓库**。

## 3. 截图证据（逐张 `file` 复核）

| 文件 | 实际宽高（`file`） | 字节 | sha256 前 16 | 页面内容 |
| --- | --- | --- | --- | --- |
| [firewall-logs-firewall-desktop.png](screenshots/firewall-logs-firewall-desktop.png) | **1440 x 932** | 120700 | `fc76248898cef9bf` | 防火墙页 full-page：ufw + 只读降级 + 启用/默认入站/规则数=不可读 + root 权限指引 |
| [firewall-logs-firewall-mobile.png](screenshots/firewall-logs-firewall-mobile.png) | **390 x 844** | 72569 | `07c7ff0a5ea1419c` | 同上手机视口，导航收起、无横向溢出（scrollWidth=innerWidth=390） |
| [firewall-logs-logs-desktop.png](screenshots/firewall-logs-logs-desktop.png) | **1440 x 901** | 83354 | `f78291d7d3a62bd9` | 日志页：按来源查看尾部日志、关键字搜索、级别筛选、跟随/导出入口 |
| [firewall-logs-logs-mobile.png](screenshots/firewall-logs-logs-mobile.png) | **390 x 844** | 58159 | `cd5ef6a1fbd9c589` | 同上手机视口，scrollWidth=innerWidth=390、无登录页 |

- 桌面两张宽度均 **1440**；手机两张均 **390×844**；4 张 sha256 互不相同（无同图缩放）。
- 截图前后均断言：登录页 `#kore-password` 不存在、`.kore-shell` 存在；firewall 文案命中「只读降级 / 不可读 / 防火墙管理需要 root 权限」；logs 文案命中「日志 / 按来源查看尾部日志」。

## 4. 自评三问

### 4.1 firewall（当前为降级态）

1. **解决什么用户问题**：一键看清本机防火墙后端、是否启用、默认入站策略与规则数；非 root 时明确告知「这是权限限制不是故障」，并给出提权后刷新即可恢复的路径，避免用户以为规则丢失。
2. **与宝塔 / 1Panel 同类功能差距**：宝塔/1Panel 在 root 面板内直接开关 ufw/firewalld 并管理规则；本页当前只读降级（非 root 环境），root 下可读写规则（预览真实 argv 后执行），但**尚无 enable/disable 开关与防爆破配置**（后端 0.2.4 未提供，已另派 task-79）。差距是「缺开关/防爆破」而非「规则管理」。
3. **当前是「可用」还是「占位」**：**受限可用**——状态/规则/放行/拒绝/删除在 root 下可用；本次截图是非 root 的降级态，只证明降级指引与只读展示可用，**不证明开关可用**。新增的「防火墙未启用」黄底指引仅在 `available=true && backend=ufw && !enabled` 时出现，故本环境不显示，属正确边界。

### 4.2 logs（新方法：follow / config.get / config.set / 轮转）

1. **解决什么用户问题**：不登服务器即可按来源看尾部日志、搜关键字、按级别过滤，并支持跟随与导出，排障时少一次 SSH。
2. **与宝塔 / 1Panel 同类功能差距**：宝塔日志页偏「站点访问/错误日志 + 实时 tail」；本页已覆盖多来源、搜索、级别与跟随，差距在「按站点聚合视图、日志清理/轮转的可视化配置入口」仍偏后端/表单化。
3. **当前是「可用」还是「占位」**：**可用**（真实 logs 0.4.2 插件数据；本机非 root 仅影响需要提权的轮转写操作，读取/搜索/跟随正常）。

## 5. 清理与边界声明

- 已停止隔离 `kored` 与 chromium、删除 `/tmp/kore-fwlogs-18885`；复核 `ss -ltnp` 无 18885 监听、无残留 `kore-fwlogs` 进程、`chrome-fwlogs.service` inactive。
- **G-29**：本轮未改动主实例 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`；主实例 8787 未重启、未改配置。
- 本任务只提交 4 张截图与本报告；未触碰 `site-file-*` / `backup-redis-*` / `dns-*` 等其他截图任务产物。
