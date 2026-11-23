# 主实例重启到最终形态 · 最终验收（2026-11-23）

- 执行时间：2026-11-23T23:24:37+08:00 起（基线取样）→ 23:24:58 重启 → 23:26 验收完成
- 目标：把 8787 上的主实例从 22:36 启动的旧二进制切换到含 `a68c4b1`（登录门）/ `3aa7b5c`（首启凭据）/ `db7cf31`（升级端点装配修复）的最终形态
- 重启动作：**仅** `systemctl --user restart kored-local`（未使用 setsid/nohup/pkill/kill -9）
- 工作区 HEAD：`885fce6`

## 一、重启前后六项对照

| # | 项目 | 重启前 | 重启后 |
| --- | --- | --- | --- |
| 1 | `GET /-/healthz` | `200` | `200` |
| 2 | 监听 8787 的 pid | `1184494` | `1387457` |
| 3 | `/proc/<pid>/exe` → sha256 | `/home/pt/Work/GolandProjects/kore/bin/kored (deleted)` → `cd8d1e15265aa35618c44cd61546690a50962680c04686727b85b5e89d141ca0` | `/home/pt/Work/GolandProjects/kore/bin/kored` → `979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997` |
| 4 | `sha256sum bin/kored` | `979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997` | `979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997` |
| 5 | 两者是否不同 | **不同**（运行中为旧 inode `57831883` mtime `22:29:15`；磁盘为 `57831931` mtime `23:21:52`） | **一致**（`SHA_MATCH=YES`） |
| 6 | `/proc/<pid>/cgroup` | `0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service` | `0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service` |

补充：重启后 `ls -l /proc/1387457/exe` 不再带 `(deleted)`；`systemd` 记录 `Stopped` → `Started` 各一次，旧进程 `Consumed 7.046s CPU time over 48min 5.835s wall clock time`。

### 重启命令与活性

```text
$ systemctl --user restart kored-local
restart_exit=0
$ sleep 2; systemctl --user is-active kored-local
active
is_active_exit=0
```

### journal 错误扫描

```text
$ journalctl --user -u kored-local -n 60 --no-pager | grep -iE "error|panic|fatal"
grep_exit=1 (无匹配)
```

结论：**无** error / panic / fatal。日志中的 `WARN` 均为既有环境事实（非 root 运行 → 插件降权不生效；cgroup 委派不可写；SELinux disabled；相对路径归一化告警），非本次重启引入。

## 二、八条最终验收（逐条贴原文）

### [4] 登录门生效 —— PASS

```text
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/v1/store/plugins
401
$ curl -s http://127.0.0.1:8787/api/v1/store/plugins
{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
```

旧二进制时该端点为 `200`，现为 `401` → 登录门已进二进制。

### [5] 登录页存在 —— PASS

真实 Chromium（Chrome for Testing 156.0.8078.4，headless=new）打开 `http://127.0.0.1:8787/`：

- `document.querySelectorAll('input[type=password]').length` = **1**（桌面视口）
- 精确 JS 断言 `document.querySelectorAll('input[type=password]').length === 1` → `true`
- 页面标题：`Kore · 控制台`；`location.href`：`http://127.0.0.1:8787/`
- 页面可见文本原文：`Kore / 控制台 · 单管理员登录 / 管理员口令 / 登录 / 登录失败 5 次/60 秒后锁定 5 分钟；口令仅在本机校验。`
- DOM 中命中的输入元素原文：`<input type="password" id="kore-password" name="password" class="field-input" autocomplete="current-password" required="" placeholder="请输入口令">`

截图与 `file` 复核宽高：

```text
$ file .agents/verify/screenshots/login-desktop-1440x900.png .agents/verify/screenshots/login-mobile-390x844.png
login-desktop-1440x900.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
login-mobile-390x844.png:   PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
```

- 桌面：`.agents/verify/screenshots/login-desktop-1440x900.png`（1440×900）
- 手机：`.agents/verify/screenshots/login-mobile-390x844.png`（390×844）

两端视口下 `innerWidth/innerHeight` 分别实测 `1440/900` 与 `390/844`，`pw` 均为 `1`。

### [6] 升级端点不再是 501 —— PASS

```text
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/v1/system/upgrade
401
$ curl -s http://127.0.0.1:8787/api/v1/system/upgrade
{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
```

返回 `401`（认证拦截），**不是 501** → `db7cf31` 的四端点装配修复已进二进制。

### [7] `index_dir` 正确 —— 需登录，未验证

```text
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/v1/system/info
401
$ curl -s http://127.0.0.1:8787/api/v1/system/info
{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
```

`/api/v1/system/info` 已被登录门拦截，无法在未登录侧读取 `paths.index_dir`，故本项记 **需登录，未验证**（不伪造）。

非 API 的旁证（**不能替代本项验收**）：`.kore-local.yaml:12` 为 `index_dir: "/home/pt/Work/GolandProjects/kore-plugins/index"`，该文件本轮零改动（见第 8 条）。

### [8] 主实例配置零改动 —— PASS

```text
重启前：
mtime=2026-11-23 04:59:58.799907899 +0800 size=1677
59957ee18e95f6c1086f4602c4a45e943c79bf3dfb233af4792159c771570d3c  .kore-local.yaml

重启后：
mtime=2026-11-23 04:59:58.799907899 +0800 size=1677
59957ee18e95f6c1086f4602c4a45e943c79bf3dfb233af4792159c771570d3c  .kore-local.yaml
```

mtime 与 sha256 完全一致（mtime 停在 04:59:58，早于本次操作近 18.5 小时）。

## 三、登录后行为的验证口径

**登录后行为未在 8787 上验证，因为需要用户自己的管理员口令；该部分已在隔离实例验证**（`a68c4b1` 的 monitor CPU 13.3% / discover 10 服务 105 端口；`db7cf31` 的四端点 200/403/404）。

本轮**没有**在 8787 上改口令、没有改 `.kore-local.yaml`、没有走"备份 → 临时口令 → 还原"的回路，因此不存在需要回切的配置变更。

## 四、声明：本轮是否改动过主实例运行态配置

**没有。** 逐项声明：

| 运行态资产 | 本轮动作 | 证据 |
| --- | --- | --- |
| `.kore-local.yaml` | 未写入 | mtime `2026-11-23 04:59:58.799907899` 与 sha `59957ee1…` 前后一致 |
| `.kore-local-state/`（state.db / plugins / ssl / backups） | 未写入 | 仅由重启后的 `kored` 自身正常打开 `state.db`（日志：`状态库已打开 … schema_version:1`） |
| `.kore-local-run/`（socket） | 未写入 | 仅由 `kored` 自身重建 socket（日志：`kore ready … socket=…/kore.sock`） |
| `bin/kored` | 未重建、未改动 | mtime `2026-11-23 23:21:52.693624731`，早于本次重启（23:24:58）；sha 前后一致 |

唯一对运行态的操作是 `systemctl --user restart kored-local`，无 `setsid` / `nohup` / `pkill` / `kill -9`。

## 五、结论

- 主实例已运行在最终形态：运行中 exe 与磁盘 `bin/kored` 同 sha `97926026…`，`/proc/<pid>/exe` 无反链 `(deleted)`。
- 登录门（[4] 401）、登录页（[5] 200 + 1 个 password input + 双端截图）、升级端点装配（[6] 401 而非 501）三项关键行为均在 8787 上取证通过。
- [7] `index_dir` 因登录门拦截未验证，已如实标注。
- 主实例运行态配置零改动。
- **用户现在打开面板会看到登录页，用之前设置的管理员口令登录。**
