# 8787 运行态激活验收：重建 + 重启 kored-local（2026-11-24 03:33–03:34）

> 目标：把今晚进代码但未生效的 4 个内核修复真正落到 8787 运行态。
> 执行者：`restart-activate`（verifier 视角，全程只做「基线 → 构建 → 重启 → 验收」）。
> 结论：**运行态已切换到新二进制**，`/proc/<newpid>/exe` sha == 新 `bin/kored` sha；healthz 200；运行态验收 3/3 通过；配置零改动。

## 0. 结论速览

| 判据 | 结果 | 证据位置 |
| --- | --- | --- |
| 重启后 `is-active` | `active`（2s 内） | §3 |
| 运行中可执行文件 == 新构建产物 | sha 双端一致 `6c4b50…` | §3、§5 |
| 新代码在运行镜像内 | `strings /proc/809422/exe` 的 `post_upgrade` = 4 | §5 |
| healthz | 200 `{"status":"ok"}`（前后一致） | §2、§3 |
| 未登录 `GET /api/v1/system/info` | 401 `E_UNAUTHORIZED` | §4 |
| `GET /` | 200 登录页（`<title>Kore · 控制台</title>` + `登录`） | §4 |
| `kore_csrf` 无 HttpOnly | 通过（`Path=/; SameSite=Strict`） | §4 |
| 配置零改动 | `.kore-local.yaml` sha + mtime 前后完全一致 | §6 |
| 异常 | 无 error/panic/fatal；无其他 kored 实例残留 | §3、§6 |

## 1. 背景（任务输入，已核实）

`push-round7` 标注：`b71a900` / `1a326af` / `67d80c1` / `a3dbdbb` 属 `kored` 代码改动，`df5b4e1` 明确「未 build 未重启」——重启前 8787 跑的是旧二进制。

| commit | 时间 | 内容 |
| --- | --- | --- |
| `b71a900` | 02:56:45 | 清单新增可选 `post_upgrade`，升级重载后按声明调用一次插件动作 |
| `1a326af` | 02:57:24 | oneshot 超时后回收进程并归还串行令牌 |
| `67d80c1` | 03:22:51 | 禁用态升级的 `post_upgrade` 在启用时补跑 |
| `a3dbdbb` | 03:28:46 | installer `plugin_state` 改读改写，保留 `post_upgrade_pending` 等未知字段 |
| `df5b4e1` | 03:10:54 | 第 50 把重签证据（cron 0.7.0 发版入索引，未 build 未重启） |

关键时间线对照：**旧 `bin/kored` mtime = 01:45:22，早于全部 4 个修复 commit（02:56–03:28）**——这就是「代码进了、二进制没进」的物证。

## 2. 重建前基线（2026-11-24 03:33:23）

```text
$ curl -s -o /dev/null -w 'HTTP:%{http_code}' http://127.0.0.1:8787/-/healthz
HTTP:200
$ curl -s http://127.0.0.1:8787/-/healthz
{"status":"ok"}

$ ss -ltnp | grep 8787
LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:* users:(("kored",pid=3409175,fd=12))

$ systemctl --user show -p MainPID -p ActiveState -p SubState kored-local
ActiveState=active
SubState=running
MainPID=3409175

$ sha256sum /proc/3409175/exe
ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6  /proc/3409175/exe

$ stat -c '%s %y %n' bin/kored
10494114 2026-11-24 01:45:22.444934926 +0800 bin/kored
$ sha256sum bin/kored
ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6  bin/kored

$ stat -c '%s %y %n' .kore-local.yaml
1677 2026-11-23 04:59:58.799907899 +0800 .kore-local.yaml
$ sha256sum .kore-local.yaml
59957ee18e95f6c1086f4602c4a45e943c79bf3dfb233af4792159c771570d3c  .kore-local.yaml

$ cat /proc/3409175/cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service

# 旧二进制符号计数（证明运行态不含今晚代码）
$ strings bin/kored | grep -c post_upgrade
0
$ strings bin/kored | grep -c post_upgrade_pending
0
```

> 基线注意：此刻 `/proc/3409175/exe` 与磁盘 `bin/kored` sha 相同（同一 inode，未被重建覆盖过），所以「sha 相同」在基线阶段**不能**证明二进制是新的——必须用 mtime 与符号计数交叉验证，两者都指向旧代码。

## 3. 构建 + 重启（唯一允许的重启路径）

### 3.1 `make build`

```text
$ make build
[OK] 构建完成: ./bin/kored
elapsed=0.18s
EXIT=0

$ stat -c '%s %y %n' bin/kored
10510498 2026-11-24 03:33:50.969491780 +0800 bin/kored
$ sha256sum bin/kored
6c4b503ea6aa72a1af2e95617c85fd90e869fe57dd5fcc845633f760605e69ba  bin/kored
```

新二进制：size `10510498`（+16384 B）、mtime `03:33:50.97`、sha `6c4b503e…`（旧 `ab5627af…`）。

重建后旧进程仍持旧 inode，符合预期：

```text
$ ls -l /proc/3409175/exe
... /proc/3409175/exe -> /home/pt/Work/GolandProjects/kore/bin/kored (deleted)
$ sha256sum /proc/3409175/exe
ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6  /proc/3409175/exe
```

### 3.2 重启命令（未使用 setsid / nohup / pkill / kill -9）

```text
$ systemctl --user restart kored-local
RESTART_EXIT=0

$ sleep 2
$ systemctl --user is-active kored-local
active            # IS_ACTIVE_EXIT=0

$ systemctl --user show -p MainPID -p ActiveState -p SubState -p ExecMainStartTimestamp kored-local
ActiveState=active
SubState=running
MainPID=809422
ExecMainStartTimestamp=Tue 2026-11-24 03:34:04 CST
```

### 3.3 重启后 healthz / 进程 / cgroup / 日志

```text
$ curl -s -o /dev/null -w 'HTTP:%{http_code}' http://127.0.0.1:8787/-/healthz
HTTP:200
$ curl -s http://127.0.0.1:8787/-/healthz
{"status":"ok"}

$ ss -ltnp | grep 8787
LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:* users:(("kored",pid=809422,fd=12))

$ ls -l /proc/809422/exe
... /proc/809422/exe -> /home/pt/Work/GolandProjects/kore/bin/kored
$ sha256sum /proc/809422/exe
6c4b503ea6aa72a1af2e95617c85fd90e869fe57dd5fcc845633f760605e69ba  /proc/809422/exe

$ cat /proc/809422/cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service

$ journalctl --user -u kored-local -n 60 --no-pager | grep -iE "error|panic|fatal"
（无输出，grep exit=1 = 无匹配）
```

启动日志末条：`{"msg":"kore ready","pid":809422,"version":"0.1.0","addr":"127.0.0.1:8787"}`。

## 4. 运行态验收原文（全部为重启后新进程 809422）

```text
$ curl -s -D - -o body -w 'HTTP:%{http_code}' http://127.0.0.1:8787/api/v1/system/info
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Set-Cookie: kore_csrf=***; Path=/; SameSite=Strict
X-Request-Id: r-d2890499f0b401bd
Date: Mon, 23 Nov 2026 19:34:21 GMT
Content-Length: 60
HTTP:401

body: {"code":"E_UNAUTHORIZED","message":"未授权","detail":""}

$ curl -s -D - -o /tmp/b_root.txt -w 'HTTP:%{http_code}' http://127.0.0.1:8787/
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Set-Cookie: kore_csrf=***; Path=/; SameSite=Strict
Content-Length: 1288
HTTP:200

body 关键标记：
<title>Kore · 控制台</title>
登录
```

（`kore_csrf` 的值按 G-30 脱敏为 `***`；cookie 属性原样保留，足以判定 HttpOnly 缺失。）

`kore_csrf` HttpOnly 专项判定：

```text
$ grep -i '^set-cookie: *kore_csrf' headers | grep -qi 'httponly' && echo FAIL || echo PASS
PASS: kore_csrf has no HttpOnly
```

## 5. 修复真的在运行态（双重证据）

1. **镜像即身份**：`/proc/809422/exe` sha `6c4b503e…` == `bin/kored` sha `6c4b503e…`（§3.3）。
2. **运行镜像内含新代码符号**（直接读运行进程的可执行文件，不是读磁盘副本）：

```text
$ strings /proc/809422/exe | grep -c post_upgrade
4
$ strings /proc/809422/exe | grep -c post_upgrade_pending
1

# 对照：重建前旧二进制
$ strings bin/kored(旧) | grep -c post_upgrade
0
```

附带证据（新二进制中的相关字符串）：

```text
json:"post_upgrade,omitempty"
PostUpgradePending%json:"post_upgrade_pending,omitempty"
```

`oneshot` 符号：旧 21 → 新 22（`1a326af` 的 oneshot 回收路径已进二进制）。

## 6. 重启前后六项对照

| # | 项目 | 重启前（03:33） | 重启后（03:34） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | healthz | 200 `{"status":"ok"}` | 200 `{"status":"ok"}` | 一致 |
| 2 | 8787 pid | 3409175 | 809422 | 已更换 |
| 3 | `/proc/<pid>/exe` sha | `ab5627af…` | `6c4b503e…` | 已切换 |
| 4 | `bin/kored` sha / size / mtime | `ab5627af…` / 10494114 / 01:45:22 | `6c4b503e…` / 10510498 / 03:33:50 | 已重建 |
| 5 | `post_upgrade` 符号计数 | 0（旧） | 4（新，运行镜像内） | 新代码生效 |
| 6 | `.kore-local.yaml` sha / mtime | `59957ee1…` / 2026-11-23 04:59:58.799907899 | `59957ee1…` / 2026-11-23 04:59:58.799907899 | 零改动 |

## 7. 声明

**本轮是否改动过运行态配置：否。**

- `.kore-local.yaml`：sha `59957ee18e95f6c1086f4602c4a45e943c79bf3dfb233af4792159c771570d3c`、size `1677`、mtime `2026-11-23 04:59:58.799907899`，重启前后逐字节一致（§2 vs §6）。
- 未改状态目录（`.kore-local-state/`，mtime 仍为 2026-11-23 20:08:29）、未改索引、未改 unit 定义（`kored-local` 为 systemd-run 生成的 transient unit，本流程只执行 `restart`）。
- 重启手段仅 `systemctl --user restart kored-local`；**未使用** `setsid` / `nohup` / `pkill` / `kill -9`。
- `.kore-local-run/` mtime 变为 03:34:04：这是重启后新进程重建 socket 的正常运行态产物，非人工修改。
- 未发现其他隔离实例残留：`pgrep -a -x kored` 与 `ss -ltnp | grep kored` 均只有 8787 上单实例（重启前后一致），本轮未杀任何进程。
- 工作区在提交前 `git status --short` 为空。

## 8. 剩余风险 / 未覆盖

1. 本机 `cgroup 委派不可写`、`SELinux disabled`、非 root 运行导致「插件降权未生效」——均为重启前既有的已知降级告警（journal WARN 原文见 §3.3），非本次重启引入。
2. `GET /api/v1/system/info` 在未登录下为 401，无法通过该端点核对 `paths.index_dir`（G-29 的登录态复核项）。本轮以「配置零改动 + 索引未触碰」为替代证据；如需登录态复核需提供会话凭据，属授权外动作，未执行。
3. `a3dbdbb` / `67d80c1` 的行为级验证（installer 保留未知字段、禁用态补跑 `post_upgrade`）需要真实升级插件才会触发，本轮只证明新代码在运行镜像内（§5），未做行为级复现。
