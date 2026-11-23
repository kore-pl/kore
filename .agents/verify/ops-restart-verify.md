# 主实例重启对齐新二进制 — 运行镜像 sha 前后对照

- 执行者：`agent:ops-restart-verify`（ops 执行者，非 lead）
- 时间：2026-11-23 21:29–21:32 CST
- 依据：`AGENTS.md` **G-29（运行态写边界）**、`docs/RUNBOOK.md` §0 铁律 4 + §1 步骤 6（本地开发机重启：复用 `kored-local` unit，**禁止 `setsid`/`nohup`**）
- 结论：**重启成功**，运行镜像 sha == 磁盘二进制 sha（`ee34692b…`），主实例已从旧 inode 切到新 inode；healthz 200；cgroup 仍在 `kored-local.service` 且不含 `dsh-subprocess`；子命令 `admin-password` 存在。

## 1. 本轮重启了什么、为什么

**重启了什么**：`systemctl --user restart kored-local`（本地开发机主实例，监听 `127.0.0.1:8787`，`--config .kore-local.yaml`）。**只重启了主实例**，未触碰其它 agent 的隔离实例（`/tmp/kore-t196`、`/tmp/kore-cexec`，均在各自的 `dsh-subprocess-*.scope` 内），未改任何配置文件，未 `pkill`/`kill -9`，未碰 `kore-plugins` 索引。

**为什么**：主实例 `kored` 进程是 21:07 构建的**旧 inode**（`/proc/<pid>/exe` 指向 `(deleted)`），而 `bin/kored` 之后被多次 `make build` 重建（多位 agent 的验证需要）。因此磁盘上的新二进制已包含今天全部修复（`admin-password` 子命令、uninstall 退出码、install 锁提示、waf 解析修复等），但**运行中的进程仍是旧代码**。本次重启把运行态与代码对齐（G-29：运行态资产必须在受控流程内切换并复核）。

## 2. 重启前后六项对照

| # | 项 | 重启前（21:29） | 重启后（21:31） | 判据 |
| --- | --- | --- | --- | --- |
| 1 | pid | `1610096` | `2544741` | ✅ 已换 pid |
| 2 | 运行镜像 sha（`sha256sum /proc/<pid>/exe`） | `0650c9382983cf96ff74968a70de5389741ac957c2dcf05ee76ace5ad5515175` | `ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b` | ✅ 换新 inode |
| 3 | 磁盘二进制 sha（`sha256sum bin/kored`） | `ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b` | `ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b` | ✅ 前后相同（未重建） |
| 4 | cgroup | `…/app.slice/kored-local.service`（不含 `dsh-subprocess`） | `…/app.slice/kored-local.service`（不含 `dsh-subprocess`） | ✅ 在自有 unit |
| 5 | healthz（`GET /-/healthz`） | `200` | `200` | ✅ |
| 6 | `paths.index_dir`（`GET /api/v1/system/info`） | `401 E_UNAUTHORIZED 未授权` | `401 E_UNAUTHORIZED 未授权` | ⚠️ 见 §3 说明 |

**「跑旧 inode」的直接证据（重启前）**：

```
$ readlink /proc/1610096/exe
/home/pt/Work/GolandProjects/kore/bin/kored (deleted)
$ sha256sum /proc/1610096/exe
0650c9382983cf96ff74968a70de5389741ac957c2dcf05ee76ace5ad5515175  /proc/1610096/exe
$ sha256sum bin/kored
ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b  bin/kored
```

两者不同 + `(deleted)` 后缀 = 进程持有的是已被替换掉的旧文件名 inode。

**重启后换新 inode 的直接证据**：

```
$ systemctl --user is-active kored-local
active
$ systemctl --user show kored-local -p MainPID --value
2544741
$ readlink /proc/2544741/exe
/home/pt/Work/GolandProjects/kore/bin/kored
$ sha256sum /proc/2544741/exe
ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b  /proc/2544741/exe
$ sha256sum bin/kored
ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b  bin/kored
$ cat /proc/2544741/cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service
$ grep -c dsh-subprocess /proc/2544741/cgroup
0
```

## 3. 六项之外的关键事实

### 3.1 `paths.index_dir`：API 401，改用配置只读核验（如实标注来源）

主实例启用了管理员会话鉴权，**重启前后 `GET /api/v1/system/info` 均返回 `401`**（`{"code":"E_UNAUTHORIZED","message":"未授权"}`）。本任务明确**不猜口令、不改用户口令**，因此**无法通过 API 读取 `paths.index_dir`**——此处如实记「未授权」，不编造 API 返回值。

补充只读佐证（**来源是配置文件，不是 API**）：

```
$ grep -n "index_dir" .kore-local.yaml
12:  index_dir: "/home/pt/Work/GolandProjects/kore-plugins/index"
$ ls -d /home/pt/Work/GolandProjects/kore-plugins/index
/home/pt/Work/GolandProjects/kore-plugins/index
```

即：配置值直接指向 `kore-plugins/index`（符合 RUNBOOK §0 铁律 4，不是 `signed-index` 等 state 快照），目录存在；`.kore-local.yaml` 本轮**未做任何修改**。G-29 要求的「API 数据级复核」在无会话前提下未能完成，标记为**待有会话时补验**，不作为“已通过”声明。

### 3.2 商店可读性（不登录）

```
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/v1/store/plugins
401
```

**401 属预期**（无会话），如实记录，未尝试猜口令或改用户口令。

### 3.3 unit 状态

重启前（21:29）：

```
● kored-local.service - [systemd-run] …/bin/kored serve --config …/.kore-local.yaml
     Loaded: loaded (/run/user/1000/systemd/transient/kored-local.service; transient)
     Active: active (running) since Mon 2026-11-23 20:54:20 CST; 35min ago
 Invocation: ba87b1c0d0614e72b7b3e27e00fc1e9e
```

重启后（21:31）：

```
● kored-local.service - [systemd-run] …/bin/kored serve --config …/.kore-local.yaml
     Loaded: loaded (/run/user/1000/systemd/transient/kored-local.service; transient)
     Active: active (running) since Mon 2026-11-23 21:30:38 CST; 8s ago
 Invocation: d6ded98edb104103b1029c0a4076420f
```

### 3.4 启动日志 / ERROR 检查

```
$ journalctl --user -u kored-local -n 30 --no-pager | grep -iE "error|panic|fatal"
（无输出，grep exit=1）
```

**ERROR / PANIC / FATAL：无。**

启动日志尾部的 WARN（均为既有环境类告警，非本次重启引入的异常）：

- 5 条 `配置告警`：`paths.{state_dir,log_dir,run_dir,plugin_dir}` 已归一化为绝对路径（配置写法为相对路径，内核按规则归一化）；
- `环境降级`：cgroup 委派不可写 → 限额不生效；SELinux disabled → 策略拦截不可依赖；
- `kored 非 root`：插件降权未生效（与内核同 uid），需 root 的动作只能走 root-action 通道。

末尾关键行：`{"level":"INFO","msg":"kore ready","pid":2544741,"version":"0.1.0",…,"addr":"127.0.0.1:8787"}`；插件 `site` / `terminal` 均 `插件就绪`。

### 3.5 新二进制的子命令存在性（今日新增 `admin-password`）

```
$ ./bin/kored --help 2>&1 | head -20        # 退出码 0
用法: kored <子命令> [参数]
  serve     启动主壳（无子命令时默认）
  version   打印版本与协议版本
  install   安装插件（M1 只解析 --package / --scenario，实现归 M2）
  audit     查询审计记录（--since 必填，--action 过滤，--csv 导出）
  uninstall 卸载链：清 systemd unit / kore-* 用户 / 变更账本（ADR-0023；--dry-run 看计划）
  admin-password 设置管理员口令（--generate / --set [--stdin] / --hash），原子写配置且权限 0600
  help      打印本帮助
退出码: 0 正常 / 2 配置 / 3 状态目录或锁 / 4 存储或 schema / 5 监听绑定 / 6 环境不满足

$ ./bin/kored admin-password --help 2>&1 | head -10   # 退出码 0
用法: kored admin-password <--generate | --set [--stdin] | --hash <存储串>> [--config <path>]
  --generate       生成 24 字符随机口令，写入配置文件并打印一次
  --set            交互式读两次口令（关闭回显）；非 TTY 时须配 --stdin
  --stdin          配合 --set：从标准输入读一行口令（CI / 容器）
  --hash <串>      直接写入 pbkdf2-sha256$<iter>$<salt>$<hash>（自动化场景）
  --config <配置文件路径>（默认 KORE_CONFIG 或 <install>/config/config.yaml）
口令与哈希不写日志；配置文件权限固定 0600，写入走临时文件 + fsync + rename。
```

判据：`admin-password` **同时出现在子命令列表**中，且其 `--help` 可正常展开 → 运行中的新二进制确实带有今日新增的子命令。

## 4. 边界遵守声明

| 项 | 结果 |
| --- | --- |
| 只重启主实例 | ✅ 仅 `kored-local`；其它 agent 的 `/tmp/kore-t196`、`/tmp/kore-cexec` 隔离实例未触碰 |
| 未改任何配置文件 | ✅ `.kore-local.yaml` 未修改（仅 `grep` 只读） |
| 未用 `setsid`/`nohup` | ✅ 只走 `systemctl --user restart` |
| 未 `pkill`/`kill -9` | ✅ 只走 systemctl |
| 未碰 `kore-plugins` 索引 | ✅ 仅 `ls -d` 确认目录存在 |
| 未猜/改管理员口令 | ✅ 遇到 401 只记录「未授权」 |
| 未 push | ✅ 仅本地 commit |

## 5. 未完成 / 待补

- `GET /api/v1/system/info` 的 `paths.index_dir` **未能在 API 层复核**（401，无会话）。建议由持有管理会话的 agent 补一条：`curl -s -b <jar> http://127.0.0.1:8787/api/v1/system/info`，核对 `paths.index_dir == /home/pt/Work/GolandProjects/kore-plugins/index`。
