# 主实例重启 + 运行态验收（2026-11-23）

- 执行时间：2026-11-23 22:36–22:40 (+08:00)
- 执行者：agent `main-restart-live`
- 目标提交：`377e4d99dd13936619a884de49256bc0740f3688`
- 结论：**通过**。重启后 8787 由新 inode 承载，healthz 200，免密本地访问 / 商店新版本 / index_dir / 面板真实数据 / CSRF 六类运行态验收全部实测通过。
- **本轮是否改动过主实例运行态配置：否。** 未改 `.kore-local.yaml`、未改 `.kore-local-state/`、未改索引；唯一动作是 `systemctl --user restart kored-local`。

---

## 一、重启前后六项对照

| 项目 | 重启前 | 重启后 |
| --- | --- | --- |
| `/-/healthz` 状态码 | `200` | `200` |
| 监听 8787 的 pid | `2798902` | `1184494` |
| `/proc/<pid>/exe` 指向 | `/home/pt/Work/GolandProjects/kore/bin/kored (deleted)` | `/home/pt/Work/GolandProjects/kore/bin/kored`（非 deleted） |
| 运行二进制 sha256 | `984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23`（size 10231970 / mtime 21:39:03） | `cd8d1e15265aa35618c44cd61546690a50962680c04686727b85b5e89d141ca0`（size 10420386 / mtime 22:29:15） |
| `sha256sum bin/kored` | `cd8d1e15265aa35618c44cd61546690a50962680c04686727b85b5e89d141ca0`（size 10420386, inode 57831883） | 同上，两侧 **MATCH=YES** |
| 两者是否不同 | **不同**（旧 inode 57820897 已被替换，`exe` 标记 `(deleted)` → 证明跑的是旧 inode） | 相同 |
| `/proc/<pid>/cgroup` | `0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service`（含 kored-local=1，含 dsh-subprocess=0） | `0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service`（含 kored-local=1，含 dsh-subprocess=0） |

### 重启前基线原文

```text
[1] healthz                          -> 200
[2] ss -ltnp | grep 8787             -> LISTEN 127.0.0.1:8787 users:(("kored",pid=2798902,fd=12))
[3] systemctl --user is-active       -> active
[4] MainPID                          -> 2798902
[5] sha256sum bin/kored              -> cd8d1e15265aa35618c44cd61546690a50962680c04686727b85b5e89d141ca0  bin/kored
[7] /proc/2798902/exe                -> /home/pt/Work/GolandProjects/kore/bin/kored (deleted)
[8] sha256sum /proc/2798902/exe      -> 984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23
[9] stat -L /proc/2798902/exe        -> size=10231970 mtime=2026-11-23 21:39:03 inode=57820897
[10] stat bin/kored                  -> size=10420386 mtime=2026-11-23 22:29:15 inode=57831883
[11] /proc/2798902/cgroup            -> 0::/user.slice/.../app.slice/kored-local.service
[13] ps                              -> 2798902 一 11月 23 21:41:57 2026  54:31  .../bin/kored serve --config .../.kore-local.yaml
```

重启前 API 状态（旧二进制）——正是本卡要修的症状：

```text
GET /api/v1/store/plugins   -> 401  {"code":"E_UNAUTHORIZED","message":"未授权"}
GET /api/v1/system/info     -> 401  {"code":"E_UNAUTHORIZED","message":"未授权"}
```

## 二、重启动作与结果

```text
systemctl --user restart kored-local   -> restart_exit=0
sleep 2; systemctl --user is-active    -> active   (exit=0)
show ActiveState/SubState/MainPID      -> active / running / 1184494
ss -ltnp | grep 8787                   -> LISTEN 127.0.0.1:8787 users:(("kored",pid=1184494,fd=12))
```

未使用 `setsid` / `nohup` / `pkill` / `kill -9`；unit 为 `systemd-run` 生成的 transient unit（`/run/user/1000/systemd/transient/kored-local.service`），`ExecStart="/home/pt/Work/GolandProjects/kore/bin/kored" serve --config .../.kore-local.yaml`，重启后直接读取磁盘上的新二进制。

### 重启后原文

```text
[POST-1] healthz                       -> 200
[POST-2] /proc/1184494/exe             -> /home/pt/Work/GolandProjects/kore/bin/kored   (无 deleted)
[POST-3] sha256 /proc/1184494/exe      -> cd8d1e15265aa35618c44cd61546690a50962680c04686727b85b5e89d141ca0
[POST-4] sha256sum bin/kored           -> cd8d1e15265aa35618c44cd61546690a50962680c04686727b85b5e89d141ca0
[POST-5] 比对                           -> running==ondisk, MATCH=YES
[POST-6] /proc/1184494/cgroup          -> 0::/user.slice/.../app.slice/kored-local.service
                                          contains_kored-local: 1
                                          contains_dsh-subprocess: 0
[POST-7] ps                            -> 1184494 一 11月 23 22:36:51 2026 .../bin/kored serve --config .../.kore-local.yaml
[POST-8] journalctl --user -u kored-local -n 40 | grep -iE "error|panic|fatal" -> 无
```

---

## 三、八条运行态验收

### 4. 本机免密真的生效

```text
GET http://127.0.0.1:8787/api/v1/store/plugins  -> 200  (body 10080 bytes)
GET http://127.0.0.1:8787/api/v1/system/info    -> 200  (body 744 bytes)
```

重启前同为 401（见上），重启后 200 → 本地免密登录改动已生效。

### 5. 商店能看到新版本（4 条实际字段）

`GET /api/v1/store/plugins` 返回 `plugins` 数组共 **24** 条。以下为四条目标的原始记录（字段逐字摘录）：

```json
{"id": "ssh-guard", "name": "SSH 加固插件", "version": "0.3.1", "depth_level": "basic", "lifecycle": "lazy", "size_bytes": 2840537, "sha256": "260af4b5b0cc305ae296b605dbb6e5920449fdcf8951375cb00892c0947d9b3f", "download_url": "https://github.com/kore-pl/kore-plugin-ssh-guard/releases/download/v0.3.1/ssh-guard-0.3.1.tar.gz", "requires_kore": ">=0.1.0 <0.2.0", "depends_on": [], "conflicts": [], "scenario_tags": ["sec"]}
{"id": "container", "name": "容器管理插件", "version": "0.5.4", "depth_level": "basic", "lifecycle": "lazy", "size_bytes": 1530283, "sha256": "940d220b6ebbc5b9e516d615eaa2b2ab91ddaa6cf8f76c3007e5a8f3ae539ddc", "download_url": "https://github.com/kore-pl/kore-plugin-container/releases/download/v0.5.4/container-0.5.4.tar.gz", "requires_kore": ">=0.1.0 <0.2.0", "depends_on": [], "conflicts": [], "scenario_tags": ["ops"]}
{"id": "waf", "name": "WAF 插件", "version": "0.4.4", "depth_level": "basic", "lifecycle": "lazy", "size_bytes": 2938643, "sha256": "9db925059bd1fac3982c4e3a115ce646c4097c4f779d8f0e573a58e1fe3cc405", "download_url": "https://github.com/kore-pl/kore-plugin-waf/releases/download/v0.4.4/waf-0.4.4.tar.gz", "requires_kore": ">=0.1.0 <0.2.0", "depends_on": [], "conflicts": [], "scenario_tags": ["sec"]}
{"id": "logs", "name": "日志查看分析插件", "version": "0.5.1", "depth_level": "production", "lifecycle": "lazy", "size_bytes": 1590704, "sha256": "17743259b146f87cc68d7fd43f10e78771b01de4bba494148fc03242a9f2cd07", "download_url": "https://github.com/kore-pl/kore-plugin-logs/releases/download/v0.5.1/logs-0.5.1.tar.gz", "requires_kore": ">=0.1.0 <0.2.0", "depends_on": [], "conflicts": [], "scenario_tags": ["ops"]}
```

| 插件 | 期望版本 | 实际 version | 匹配 |
| --- | --- | --- | --- |
| ssh-guard | 0.3.1 | 0.3.1 | ✅ |
| container | 0.5.4 | 0.5.4 | ✅ |
| waf | 0.4.4 | 0.4.4 | ✅ |
| logs | 0.5.1 | 0.5.1 | ✅ |

### 6. index_dir 正确

```json
"paths": {
  "state_dir": "/home/pt/Work/GolandProjects/kore/.kore-local-state",
  "run_dir": "/home/pt/Work/GolandProjects/kore/.kore-local-run",
  "log_dir": "/home/pt/Work/GolandProjects/kore/.kore-local-log",
  "index_dir": "/home/pt/Work/GolandProjects/kore-plugins/index",
  "plugin_dir": "/home/pt/Work/GolandProjects/kore/.kore-local-state/plugins"
}
```

`index_dir` 以 `kore-plugins/index` 结尾 ✅；商店返回版本与索引一致（24 条，见第 5 条）。

### 7. 面板出真实数据（真实 Chromium 1.65.1 / chrome-1248 无头）

| 检查项 | 结果 |
| --- | --- |
| ① 不需要登录页 | 首页 `http://127.0.0.1:8787/`，`input[type=password]` 数 = **0**，正文不含「登录/口令/密码」，标题 `Kore · 控制台`，无跳转 |
| ② `document.cookie` 含 `kore_csrf` | `kore_csrf=SYgDmLbJVqvodYLGhwMushXSqoLqwfZrfLPDE9s5hCQ`（三个视图重复读到同一值） |
| ③ 两个数据视图有真实数值 | 监控 `#/monitor`、服务发现 `#/discover`，见下方实测值 |

监控视图（`#/monitor`）真实数值摘录：

```text
数据来源：monitor 插件 · /proc   最后更新 22:39:01
CPU 使用率 7.3%  (24 核 · 采样 200 ms)
内存 29.2 GiB / 61.3 GiB  47.7%   Swap 1022.2 MiB / 16.0 GiB
负载 2.82 (5 分钟 2.43 · 15 分钟 2.81)
磁盘 / 521.2 GiB / 1.8 TiB 29.2%；/boot/efi 9.0 MiB/1022.0 MiB 0.9%；/mnt/data 134.4 GiB/228.2 GiB 62.1%
网卡 enp5s0 收 26.9 GiB / 发 59.9 GiB；温度 thermal_zone0 27.8°C / thermal_zone2 33.0°C (x86_pkg_temp)
进程 Top10 首行 PID 3813346  dsh-desktop-nex  36.1%  347.1 MiB  38 线程
```

服务发现视图（`#/discover`）真实数值摘录：

```text
插件 discover.summary + services + ports   本机已就绪
已检测服务 11 个（共探测 22 项）  在听端口 105 个
Web 服务器 nginx  数据库 mysql  容器运行时 已检测到 Docker（运行中）
建议 8 条：site / db-mysql / redis / container / runtime-node / runtime-python / cron / firewall
```

截图（`file` 复核宽高原文）：

```text
main-restart-live-viewport-desktop-1440x900.png:          PNG image data, 1440 x 900
main-restart-live-viewport-mobile-390x844.png:            PNG image data, 390 x 844
main-restart-live-monitor-viewport-desktop-1440x900.png:  PNG image data, 1440 x 900
main-restart-live-monitor-viewport-mobile-390x844.png:    PNG image data, 390 x 844
main-restart-live-desktop-1440x900.png:                   PNG image data, 1440 x 900（full-page）
main-restart-live-mobile-390x844.png:                     PNG image data, 390 x 1189（full-page）
main-restart-live-monitor-desktop-1440x900.png:           PNG image data, 1440 x 2763（full-page）
main-restart-live-monitor-mobile-390x844.png:             PNG image data, 390 x 3171（full-page）
main-restart-live-discover-desktop-1440x900.png:          PNG image data, 1440 x 6442（full-page）
```

### 8. CSRF 未削弱

```text
POST /api/v1/plugins      Origin: http://evil.example -> 401 {"code":"E_UNAUTHORIZED","message":"CSRF 校验失败"}
POST /api/v1/store/plugins Origin: http://evil.example -> 401 {"code":"E_UNAUTHORIZED","message":"CSRF 校验失败"}
POST /api/v1/system/info   Origin: http://evil.example -> 401 {"code":"E_UNAUTHORIZED","message":"CSRF 校验失败"}
POST /api/v1/plugins      Origin: http://127.0.0.1:8787（同源但无 token） -> 401 {"message":"CSRF 校验失败"}
POST /api/v1/plugins      X-CSRF-Token: bogus-token-123 + Cookie kore_csrf=other-token -> 401 {"message":"CSRF 校验失败"}
```

GET 首次访问下发：`Set-Cookie: kore_csrf=...; Path=/; SameSite=Strict`（无 HttpOnly —— 正是「CSRF 补发」让前端可读并回填 header 的设计）。跨站伪造与错误 token 均 401，读接口免密不削弱写接口 CSRF ✅。

---

## 四、异常与观察

1. `.agents/verify/screenshots` 下另有 `upgrade-card-*.png`（6 张）为其余任务未提交产物，本轮未触碰。
2. 18787 端口存在**另一隔离实例**：`pid 1169510`，`./kored serve --config /tmp/upgrade-ui/config.yaml`，cgroup 在 `dsh-subprocess-3814516-a56c67ec6763.scope`。按约束**只报告不杀**；它不占用 8787，与本卡验收无冲突。
3. 浏览器控制台 1 条 `404`，定位为 `GET /favicon.ico -> 404`（面板自身未提供 favicon，与本次重启无关，属既有小瑕疵）。
4. `journalctl --user -u kored-local -n 40` 无 error/panic/fatal。

## 五、判定

- 重启前后六项对照：**全部符合预期**，旧 inode（`984510ab…`，deleted）→ 新 inode（`cd8d1e15…`，与磁盘一致）。
- 八条验收：4 / 5 / 6 / 7 / 8 **全部通过**；4 与 5 由 401 变 200 且四条版本逐字段命中。
- 运行态配置：**未改动**（仅 restart）。
