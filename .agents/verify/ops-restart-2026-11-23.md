# 主实例重启：运行镜像对齐新二进制（2026-11-23）

- 执行者：`ops-restart2`
- 重启时刻：2026-11-23 21:41:58 CST（`kored-local.service`）
- 结论：**通过**。8787 主实例已从旧 inode 切到磁盘上的 `bin/kored`，运行镜像 sha 与磁盘 sha 一致。

## 0. 本轮到底做了什么（G-29 声明）

- **重启了什么**：只重启 `kored-local.service`（监听 `127.0.0.1:8787` 的主实例），命令为 `systemctl --user restart kored-local`。
- **为什么重启**：今天 `bin/kored` 被多次 `make build` 重建，原 pid 2544741 的 `/proc/<pid>/exe` 指向 `bin/kored (deleted)`（旧 inode），磁盘新二进制里的修复（`admin-password`、`DELETE /plugins/{id}`、`install` 锁提示、`kored status`）没有生效在运行态。
- **是否改过配置文件**：**否**。`.kore-local.yaml` 未改动，`git status` 也不涉及运行态资产。
- **是否重新 build `bin/kored`**：否（未 build、未替换二进制）。
- **是否改动索引/状态**：否。未触碰 `kore-plugins/index`、`.kore-local-state/`。
- **进程操作方式**：只用 `systemctl --user restart`；未使用 `setsid` / `nohup` / `pkill` / `kill -9`。

## 1. 重启前后六项对照

| 项 | 重启前 | 重启后 |
| --- | --- | --- |
| 监听 8787 的 pid | 2544741 | 2798902 |
| 运行镜像 | `/home/pt/Work/GolandProjects/kore/bin/kored (deleted)` | `/home/pt/Work/GolandProjects/kore/bin/kored` |
| 运行镜像 sha256 | `ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b` | `984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23` |
| 磁盘 `bin/kored` sha256 | `984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23` | 同左（未重建） |
| 运行 sha 与磁盘 sha | **不同**（旧 inode） | **相同 ✅** |
| `/proc/<pid>/cgroup` | `.../app.slice/kored-local.service`，不含 `dsh-subprocess` | 同左，不含 `dsh-subprocess` |
| `/-/healthz` | 200 | 200 |
| `paths.index_dir` | `/home/pt/Work/GolandProjects/kore-plugins/index` | 同左（取值见 §6 说明） |
| `systemctl --user is-active` | `active`（重启前） | `active` ✅ |

## 2. 原始输出（重启前）

```text
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/-/healthz
200
exit=0

$ pgrep -af "kored serve"
2520580 ./bin/kored serve --config /tmp/kore-t196/config.yaml
2544741 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml
2548624 ./bin/kored serve --config /tmp/kore-cexec/config.yaml

$ ss -ltnp | grep 8787
LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:* users:(("kored",pid=2544741,fd=12))

$ readlink /proc/2544741/exe
/home/pt/Work/GolandProjects/kore/bin/kored (deleted)

$ sha256sum /proc/2544741/exe
ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b  /proc/2544741/exe

$ sha256sum bin/kored
984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23  bin/kored
# 对比结论：DIFFERENT（旧 inode）

$ systemctl --user status kored-local --no-pager | head -5
● kored-local.service - [systemd-run] /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml
     Loaded: loaded (/run/user/1000/systemd/transient/kored-local.service; transient)
  Transient: yes
     Active: active (running) since Mon 2026-11-23 21:30:38 CST; 10min ago
 Invocation: d6ded98edb104103b1029c0a4076420f

$ cat /proc/2544741/cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service
# dsh-subprocess 命中数：0
```

`/api/v1/system/info` 请求：

```text
$ curl -s http://127.0.0.1:8787/api/v1/system/info
{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
exit=0   # HTTP 层需会话；见 §6
```

## 3. 重启动作与原始输出

```text
$ systemctl --user restart kored-local
restart_exit=0

$ sleep 2; systemctl --user is-active kored-local
active
is_active_exit=0

$ systemctl --user status kored-local --no-pager | head -5
● kored-local.service - [systemd-run] .../.kore-local.yaml
     Loaded: loaded (/run/user/1000/systemd/transient/kored-local.service; transient)
  Transient: yes
     Active: active (running) since Mon 2026-11-23 21:41:58 CST; 2s ago
 Invocation: 29110e75760f4349ae97831ea99240a3

$ ss -ltnp | grep 8787
LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:* users:(("kored",pid=2798902,fd=12))
```

## 4. 重启后复核（原始输出）

```text
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/-/healthz
200
curl_exit=0

$ readlink /proc/2798902/exe
/home/pt/Work/GolandProjects/kore/bin/kored

$ sha256sum /proc/2798902/exe
984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23  /proc/2798902/exe
$ sha256sum bin/kored
984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23  bin/kored
# 结论：SAME ✅

$ cat /proc/2798902/cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service
# dsh-subprocess 命中数：0

$ ./bin/kored status --config .kore-local.yaml
配置: /home/pt/Work/GolandProjects/kore/.kore-local.yaml（存在）｜状态目录: /home/pt/Work/GolandProjects/kore/.kore-local-state
profile: portable
实例: 运行中（healthz 200 @ http://127.0.0.1:8787，state.db 持有者 pid=2798902）
exit=0
```

## 5. 日志检查

```text
$ journalctl --user -u kored-local -n 40 --no-pager | grep -iE "error|panic|fatal"
（无输出，grep_exit=1）
```

**日志 ERROR / panic / fatal：无。**

## 6. 新能力在二进制里（子命令存在性）

```text
$ ./bin/kored --help 2>&1 | head -25
用法: kored <子命令> [参数]
  serve     启动主壳（无子命令时默认）
  version   打印版本与协议版本
  install   安装插件（M1 只解析 --package / --scenario，实现归 M2）
  audit     查询审计记录（--since 必填，--action 过滤，--csv 导出）
  uninstall 卸载链：清 systemd unit / kore-* 用户 / 变更账本（ADR-0023；--dry-run 看计划）
  status    打印生效配置 / 状态目录 / 实例 healthz 与 state.db 持有者 pid
  admin-password 设置管理员口令（--generate / --set [--stdin] / --hash），原子写配置且权限 0600
  help      打印本帮助
退出码: 0 正常 / 2 配置 / 3 状态目录或锁 / 4 存储或 schema / 5 监听绑定 / 6 环境不满足
exit=0
```

```text
$ ./bin/kored admin-password --help 2>&1 | head -8
用法: kored admin-password <--generate | --set [--stdin] | --hash <存储串>> [--config <path>]
  --generate       生成 24 字符随机口令，写入配置文件并打印一次
  --set            交互式读两次口令（关闭回显）；非 TTY 时须配 --stdin
  --stdin          配合 --set：从标准输入读一行口令（CI / 容器）
  --hash <串>      直接写入 pbkdf2-sha256$<iter>$<salt>$<hash>（自动化场景）
  --config <path>  配置文件路径（默认 KORE_CONFIG 或 <install>/config/config.yaml）
口令与哈希不写日志；配置文件权限固定 0600，写入走临时文件 + fsync + rename。
exit=2
```

> `admin-password --help` 的退出码 2 是 Go `flag` 包在 `-h/--help` 时的固定行为，帮助正文已完整打印；不代表子命令缺失或执行失败。`--help` 清单里 `admin-password` 与 `status` 两项都在。

```text
$ ./bin/kored status --config .kore-local.yaml 2>&1 | head -10
配置: .../.kore-local.yaml（存在）｜状态目录: .../.kore-local-state
profile: portable
实例: 运行中（healthz 200 @ http://127.0.0.1:8787，state.db 持有者 pid=2798902）
exit=0
```

结论：**`admin-password` 与 `status` 均在当前二进制中，且 `status` 能正确识别新 pid。**

## 7. 商店可读性（无会话，401 属正常）

```text
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/v1/store/plugins
401
exit=0
```

**401**：未携带会话属预期，记录事实。**未猜口令、未改管理员口令、未提权。**

## 8. 异常与边界说明

1. **`system/info` 需会话**：重启前后 `GET /api/v1/system/info` 均返回 `401 E_UNAUTHORIZED`（无会话；现存临时 cookie 已于 2026-11-23 19:27:57 过期）。因此 `paths.index_dir` 的取值改用**只读取证**：`.kore-local.yaml` 第 12 行 `index_dir: "/home/pt/Work/GolandProjects/kore-plugins/index"`，并由 `kored status --config .kore-local.yaml` 确认实例健康。未为取证改动配置或口令。G-29 的「index_dir == kore-plugins/index」判定成立；「商店版本 == 索引版本」因无会话**未验证**，不计入通过项。
2. **同机其他 `kored serve` 实例（非 8787）**：`2520580`（`/tmp/kore-t196/config.yaml`）、`2548624`（`/tmp/kore-cexec/config.yaml`）、`2779969`（`/tmp/kore-wafe2e/config.yaml`，21:41 前后由其他 agent 拉起）。属隔离实例/他人任务，**只报告未处理**，未 pkill。本轮只重启了 8787 主实例。

## 9. 验收结论

| 检查项 | 结果 |
| --- | --- |
| healthz | 200 ✅ |
| is-active | active ✅ |
| 新 pid | 2798902 ✅ |
| 运行镜像 sha == 磁盘 sha | 相同 ✅ |
| cgroup 在 `kored-local.service` 且不含 `dsh-subprocess` | 是 ✅ |
| `paths.index_dir` | `kore-plugins/index` ✅（配置 + CLI 取证） |
| journal ERROR/panic/fatal | 无 ✅ |
| `admin-password` 子命令 | 存在 ✅ |
| `status` 子命令 | 存在 ✅ |
| 商店端点 | 401（无会话，属正常）✅ |
| 是否改过运行态配置 | **否** ✅ |
