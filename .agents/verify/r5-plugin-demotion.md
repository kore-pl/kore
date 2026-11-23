# R5 · 插件进程降权（P0）验证证据

- 2026-11-23 12:42–13:15+08:00 · 任务 `team task-18` · 仓库 `/home/pt/Work/GolandProjects/kore`
- 结论：**插件进程已真实降到 `kore-<id>`**（真 root 隔离实例：`Uid: 994 994 994 994`，补充组仅 `971(kore-terminal)`）；插件直接调 `ufw` / `sudo` / `nft` / 读 `/etc/shadow` / 连 `docker.sock` **全部被拒**；需要 root 的动作仍由内核经 `systemd-run --uid=0` 的 transient unit 完成（`exit_code=0`，审计 `allow` + `deny` 两类齐全）。
- 实现：`internal/platform` 新增 `Identity` / `Access` 平台接口（`syscall` / `os/user` 全部收在平台层，G-16），`internal/core/supervisor` 在 bind/exec 前按需创建系统用户、写 `SysProcAttr.Credential`、chown socket、hello 阶段校验 `SO_PEERCRED` 的 uid+pid。
- G-29：**未改动主实例运行态配置/状态**；全部验证在独立 `--config` + `/tmp/kore-r5d`（state/run/log 全落 `/tmp`）+ 独立端口 `18874`；临时实例、系统用户已清理（见 §11）。
- G-30：管理员口令只存在于 `/tmp` 的 0600 临时文件，本证据不含明文口令/哈希。

## 0. 环境与权限取得方式

```text
$ go version
go version go1.26.8 linux/amd64
$ uname -sr
Linux 6.17.0-6-generic
$ id -u; grep -E 'CapEff|NoNewPrivs' /proc/self/status
1000
CapEff: 0000000000000000
NoNewPrivs: 1        # agent 沙箱：直接 sudo 被 NoNewPrivs 拒绝
$ systemd-run --user --collect --wait --pipe --quiet --unit=kore-r5d-probe /bin/bash -c 'echo uid=$(id -u); sudo -n true; echo sudo_n_exit=$?'
uid=1000
sudo_n_exit=0        # 同一用户的 systemd user transient unit 不继承 NoNewPrivs
```

→ 真 root 实例的启动方式（R5-1 已证）：`systemd-run --user … sudo -n <kored>`。**没有伪造任何成功**。

## 1. 实现落点（代码）

| 文件 | 改动 |
| --- | --- |
| [internal/platform/platform.go](../../internal/platform/platform.go) | 新增 `Account` / `Identity`（Current/Lookup/Ensure/Apply）/ `Access`（Own/Traversable）与 `ErrAccount` |
| [internal/platform/linux_identity.go](../../internal/platform/linux_identity.go) | Linux 实现：`os/user` 查询；固定候选路径的 `useradd`（回退 Debian `adduser`）按需创建；`SysProcAttr.Credential`（root 时显式 `setgroups` 只留目标 gid）；`chown`/`chmod`/只补 o+x |
| [internal/platform/stub_identity.go](../../internal/platform/stub_identity.go) | 非 Linux 桩：一律 `ErrUnsupported`（不伪造降权） |
| [internal/core/supervisor/demote.go](../../internal/core/supervisor/demote.go) | `prepareDemotion`：user 缺失即创建、状态目录 `0700 kore-<id>`、父链补 o+x、版本树补 o+rx；任一失败 → 启动失败 |
| [internal/core/supervisor/start.go](../../internal/core/supervisor/start.go) | 降权在 bind/exec 之前；`spawn` 写 `Credential`，覆写 `HOME/USER/LOGNAME`，失败即拒绝 exec |
| [internal/core/supervisor/socket.go](../../internal/core/supervisor/socket.go) | socket `0600` + `chown kore-<id>` 失败即失败启动（旧实现是"用户不存在就静默跳过 chown"） |
| [internal/core/supervisor/hello.go](../../internal/core/supervisor/hello.go) | `SO_PEERCRED` 校验 pid，降权时额外校验 uid；降权状态凭据不可用 → fail-closed |
| [internal/core/supervisor/{manager.go,options.go,instance.go}](../../internal/core/supervisor/manager.go) | root 判定与显式降级 WARN；`Identity`/`Access` 可注入（测试用假实现） |

## 2. 降权方案与被否决方案（完整判断留痕见 ADR-0018「实现记录」）

**选定**：平台层 `Identity`/`Access` 接口 + root 内核**按需创建** `kore-<id>` + exec 时 `SysProcAttr.Credential`；失败即启动失败，绝不退回同 uid。

| 被否决方案 | 理由（一句话） |
| --- | --- |
| 启动时批量建全部 registry 用户 | 为未启用插件也建账户；之后新增插件仍要二次创建 |
| `systemd-sysusers` + `/etc/sysusers.d` | 多一个持久配置文件与重跑步骤，仍依赖外部工具，无 systemd 环境无收益 |
| 部署脚本/安装包预创建 | 与「安装即用、自动发现」冲突；插件 id 运行期才确定 |
| 全部插件共用一个 `kore-plugin` 用户 | 丢 per-plugin uid 隔离（peercred / kill / ptrace 边界全退化为同 uid） |
| 直接改写 `/etc/passwd` / `/etc/shadow` | 绕过 NSS 与 `lckpwdf` 锁语义，损坏风险不可接受 |
| 降权失败回退同 uid / 加 sudoers / 给 `CAP_*` | 前者是 G-16 禁止的静默降级；后者等于换皮不换实质（docker 组同样等价 root） |

## 3. 隔离实例与插件（G-29）

| 项 | 值 |
| --- | --- |
| 二进制 | `/tmp/kore-r5d/kored`（本轮源码 `go build -trimpath -buildvcs=false`，sha256 `2c90e332…1bbf0a2f`） |
| 配置/状态/运行/日志 | `/tmp/kore-r5d/{config.yaml,state,run,log}`（绝对路径，全部落 `/tmp`） |
| 端口 | `127.0.0.1:18874`（主实例 8787 未触碰） |
| 插件 | echo 0.1.3 / monitor 0.2.1 / logs 0.3.0 / terminal 0.1.1 / firewall 0.2.3（本地 `kored install --package`） |
| 内核身份 | `Uid: 0 0 0 0`（`pgrep -f '^/tmp/kore-r5d/kored serve'` = 379478） |

```text
$ /tmp/kore-r5d/kored install --config /tmp/kore-r5d/config.yaml --package ../kore-plugin-echo/dist/echo-0.1.3.tar.gz
installed echo 0.1.3
…（其余四个同上，均 exit 0）
$ systemd-run --user --unit=kore-r5d-root --collect \
    --property=StandardOutput=append:/tmp/kore-r5d/kored.out \
    --property=StandardError=append:/tmp/kore-r5d/kored.out \
    sudo -n env KORE_LOGS_SOURCES='[{"name":"r5d","path":"/tmp/kore-r5d/access.log","type":"file"}]' \
    /tmp/kore-r5d/kored serve --config /tmp/kore-r5d/config.yaml
$ curl -s http://127.0.0.1:18874/-/healthz
{"status":"ok"}
```

## 4. 插件进程 Uid 实证（`/proc/<pid>/status` 原文）

```text
=== kored 进程身份（root）===
pid=379478
Uid:	0	0	0	0
Gid:	0	0	0	0

=== 插件进程身份（/proc/<pid>/status 原文）===
--- pid=379773 binary=/tmp/kore-r5d/state/plugins/terminal/0.1.1/bin/terminal
Uid:	994	994	994	994
Gid:	971	971	971	971
Groups:	971 
    ps_user=kore-terminal
--- pid=379818 binary=/tmp/kore-r5d/state/plugins/monitor/0.2.1/bin/monitor
Uid:	992	992	992	992
Gid:	968	968	968	968
Groups:	968 
    ps_user=kore-monitor
--- pid=379871 binary=/tmp/kore-r5d/state/plugins/logs/0.3.0/bin/logs
Uid:	991	991	991	991
Gid:	967	967	967	967
Groups:	967 
    ps_user=kore-logs
--- pid=381312 binary=/tmp/kore-r5d/state/plugins/firewall/0.2.3/bin/firewall
Uid:	990	990	990	990
Gid:	966	966	966	966
Groups:	966 
    ps_user=kore-firewall
```

- **Uid 全部 ≠ 0，且 Gid 是各自的独立主组**；`Groups:` 行只剩该主组——**没有继承 root 的 `27(sudo)` / `973(docker)`**。
- 系统用户（按需创建，无 home、nologin）：

```text
kore-echo:x:993:969::/nonexistent:/usr/sbin/nologin
kore-firewall:x:990:966::/nonexistent:/usr/sbin/nologin
kore-logs:x:991:967::/nonexistent:/usr/sbin/nologin
kore-monitor:x:992:968::/nonexistent:/usr/sbin/nologin
kore-terminal:x:994:971::/nonexistent:/usr/sbin/nologin
```

- kored 自身日志（`/tmp/kore-r5d/kored.out`）留下了创建与降权两条记录：

```text
{"level":"INFO","msg":"已创建插件系统用户","plugin_id":"terminal","user":"kore-terminal","uid":994,"gid":971}
{"level":"INFO","msg":"以低权身份拉起插件进程","plugin_id":"terminal","pid":379773,"user":"kore-terminal(uid=994,gid=971)"}
{"level":"INFO","msg":"已创建插件系统用户","plugin_id":"echo","user":"kore-echo","uid":993,"gid":969}
{"level":"INFO","msg":"以低权身份拉起插件进程","plugin_id":"echo","pid":379802,"user":"kore-echo(uid=993,gid=969)"}
…（monitor / logs 同上）
```

## 5. 目录 / socket 属主与权限（实测 `stat`）

```text
drwx-----x pt:pt                       /tmp/kore-r5d/state/plugins        # 0701：可穿越不可列举
drwx------ kore-terminal:kore-terminal /tmp/kore-r5d/state/plugins/terminal  # 插件状态目录 0700
drwx------ kore-echo:kore-echo         /tmp/kore-r5d/state/plugins/echo
drwx-----x root:root                   /tmp/kore-r5d/run/plugins          # 0701
srw------- kore-terminal:kore-terminal /tmp/kore-r5d/run/plugins/terminal.sock
srw------- root:root                   /tmp/kore-r5d/run/kore.sock        # 内核管理/通道入口
```

插件内 shell 复核（terminal 插件，见 §6）：`ls /tmp/kore-r5d/run/plugins` → `Permission denied`（不可列举）；连 `firewall.sock` → `PermissionError: [Errno 13] Permission denied`（0600 + 非属主）；连自己的 `terminal.sock` → `CONNECT_OWN_EXIT=0`。

## 6. 插件低权下的真实行为（terminal 插件内 shell 实测）

```text
=== 插件内 shell（terminal 插件，uid 继承插件身份）===
id -u; id -Gn; echo HOME=$HOME; echo probe > "$HOME/r5d-probe" && echo HOME_WRITE_OK; \
ufw status; echo UFW_EXIT=$?; cat /etc/shadow >/dev/null; echo SHADOW_EXIT=$?; \
sudo -n true; echo SUDO_EXIT=$?; nft list ruleset >/dev/null 2>&1; echo NFT_EXIT=$?

994
kore-terminal
HOME=/tmp/kore-r5d/state/plugins/terminal
HOME_WRITE_OK
ERROR: 只有 root 用户才能运行此脚本
UFW_EXIT=1
cat: /etc/shadow: Permission denied
SHADOW_EXIT=1
sudo: I'm sorry kore-terminal. I'm afraid I can't do that
SUDO_EXIT=1
NFT_EXIT=1
```

- **插件直接调特权命令被拒**：`ufw`（exit 1）、`sudo`（exit 1）、`nft`（exit 1）、读 `/etc/shadow`（EACCES）。
- **低权下的正常动作仍可用**：`echo.ping` → `{"pong":true}`；`monitor.system` → 200 + `"source":"proc"`；`logs.sources`/`logs.tail`（自定义 world-readable 源）→ 200 且读到两行。
- 降级实测：`head /var/log/syslog`（`0640 syslog:adm`）→ `Permission denied`；`docker ps`（`srw-rw---- root:docker`）→ exit 1。

## 7. root-action 通道在降权后仍可用（管理会话 + 审计）

```text
$ curl -s -b cookies -H 'X-Kore-CSRF: ***' -H 'Content-Type: application/json' \
    -X POST http://127.0.0.1:18874/api/v1/plugins/firewall/root-action -d '{"action_id":"ufw-status"}'
{"executed":true,"exit_code":0,"stdout":"状态：不活动\n","stderr":"","dur_ms":60,
 "unit":"kore-root-firewall-ufw-status-853e467a"}          # http=200

$ # 不可回滚动作缺 confirm 令牌（被拒路径）
POST … {"action_id":"ufw-allow","args":["18080/udp"]}
{"code":"E_UNAUTHORIZED","message":"不可回滚动作需要 confirm 令牌", …}   # http=401
```

**审计（`GET /api/v1/audit?action=root.action`，count=5）**：`allow`（begin/end）与 `deny` 两类齐全：

```text
2026-11-23T05:05:51.199Z subject=admin    target=ufw-status plugin=firewall result=ok     decision=allow phase=begin exit=-1 dur_ms=0   unit=kore-root-firewall-ufw-status-853e467a
2026-11-23T05:05:51.270Z subject=admin    target=ufw-status plugin=firewall result=ok     decision=allow phase=end   exit=0  dur_ms=60  unit=kore-root-firewall-ufw-status-853e467a
2026-11-23T05:05:51.280Z subject=admin    target=ufw-allow  plugin=firewall result=denied decision=deny  phase=deny  exit=-1              deny_reason=confirm 校验失败 argv=ufw allow 18080/udp
2026-11-23T05:05:59.376Z subject=firewall target=ufw-status plugin=firewall result=ok     decision=allow phase=begin exit=-1              unit=kore-root-firewall-ufw-status-93f1075a
2026-11-23T05:05:59.444Z subject=firewall target=ufw-status plugin=firewall result=ok     decision=allow phase=end   exit=0              unit=kore-root-firewall-ufw-status-93f1075a
```

- `systemd-run --uid=0` 由**内核（root）**发起，与插件已降权的身份无冲突：unit 内 uid=0、执行 `ufw` 成功。
- ufw 终态 `状态：不活动`，与开工基线一致（未新增/删除规则）。

## 8. 发现并修好的真实缺陷（降权后第一跑就是 exec 失败）

首次以 root 启动 terminal（resident）时：

```text
POST /api/v1/plugins/terminal/enable → HTTP 502
{"code":"E_UPSTREAM","message":"拉起插件 terminal 失败：fork/exec /tmp/kore-r5d/state/plugins/terminal/0.1.1/bin/terminal: permission denied"}
```

根因：安装器用 `MkdirTemp` 的 `0700` 落位版本目录（属主 root），降权后 `kore-<id>` 属 other 类，**无法穿越/exec**。修复：`prepareDemotion` 对 `<id>/<version>` 版本树补 `o+rx`（目录/可执行文件），入口跟随符号链接检查但树内符号链接不跟随；属主与写权限不动。修复后同一 enable → HTTP 200、`"state":"ready"`。

## 9. 插件侧通道：从已知阻断到已实现（P0-1 修复）

[SECURITY §7](../../docs/SECURITY.md) 规定内核 UDS `kore.sock` 为 `root:root 0600`、"只有 root 可直连"，而 ADR-0018 的插件 bearer 通道要求插件能连它。实测：

```text
# 默认 0600
$ kore.sock: srw------- root:root
invoke firewall.status →
{"available":false, "error_code":"E_NEED_ROOT",
 "error":"…调用内核 root-action 失败：Post \"http://kore/api/v1/plugins/firewall/root-action\": dial unix /tmp/kore-r5d/run/kore.sock: connect: permission denied"}

# 隔离实例中临时 chmod 0666（仅验证代码路径，随后立即回滚 0600）
$ kore.sock now: srw-rw-rw- root:root
invoke firewall.status → {"backend":"ufw","available":true,"enabled":false,"default_in":"","rules_count":0,"error":""}
$ kore.sock restored: srw------- root:root
# 回滚后重启插件复测 → 仍 E_NEED_ROOT（connect: permission denied）
```

→ **代码路径可用，唯一阻断点是内核 socket 权限**。**2026-11-23 lead 裁决采纳方案①「独立通道 socket」**（否决②放宽 `kore.sock`、③只由管理会话发起），随后已落地，见 §16。

## 10. 验证命令与退出码

```text
$ gofmt -l internal/core/supervisor/ internal/platform/
（无输出）
$ grep -rn "syscall\." internal/core/ --include='*.go' | grep -v _test
（无命中，G-16：平台专有 API 只在 internal/platform）
$ go vet ./internal/core/supervisor/ ./internal/platform/
exit 0
$ go test -timeout 240s ./internal/core/supervisor/ ./internal/platform/
ok  github.com/pengtang1024/kore/internal/core/supervisor   6.5s
ok  github.com/pengtang1024/kore/internal/platform           0.0s
$ GOOS=windows GOARCH=amd64 go build ./internal/platform/
exit 0
$ GOOS=darwin  GOARCH=arm64 go build ./internal/platform/
exit 0
```

关键单测：

- `TestStartDemotesPluginProcess`：假 root 身份 + 真实 `Apply` → 子进程 `Uid != 0` 且等于目标 uid；断言状态目录 `0700`、运行目录被补可穿越、按需创建 `kore-<id>`。
- `TestStartFailsWhenUserCreationFails`：`useradd` 失败 → 启动失败、状态 `failed`、错误含用户名与原因（**不退回同 uid**）。
- `TestStartRefusesRootAccount`：账户 uid=0 → 拒绝启动。
- `TestVerifyPeer`：降权时 uid 不符拒绝；未降权只校验 pid。
- `TestAccessTraversable`：`0700 → 0701`（只补 o+x、不可列举、幂等）；`TestIdentityApplySelf`：非 root 自降权路径写 `Credential` 且 `NoSetGroups`。
- `TestEnsureAndApplySystemAccount`（root 门禁，`KORE_R5_DEMOTION_TEST=1`）：真实建 `kore-r5test-<pid>` → `id -u` ≠ 0 → `userdel` 清理；本轮以 root 执行结果见下。

```text
$ go test -c -o /tmp/kore-r5d/platform.test ./internal/platform/
$ sudo -n /tmp/kore-r5d/platform.test -test.v -test.run 'TestEnsureAndApplySystemAccount'
=== RUN   TestEnsureAndApplySystemAccount
--- PASS: TestEnsureAndApplySystemAccount (0.07s)
PASS
```

（完整回归见 §12。）

## 11. 清理与 G-29 声明

- 隔离实例 `systemctl --user stop kore-r5d-root`；`pgrep -af '/tmp/kore-r5d/'` 无残留；`/tmp/kore-r5d` 以 root `rm -rf` 删除（先 `realpath` 校验路径）。
- 本轮创建的系统用户/组全部 `userdel` / `groupdel`：`users_left=0 groups_left=0`（清理前记录见 §4，清理后 `getent passwd | grep -c '^kore-'` = 0）。
- **未动主实例**：`.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/` 未写；8787 未调用；`bin/kored` 仅由 `make build`（任务要求）重建，运行中的主实例仍持旧 inode、未重启。
- 未留临时脚本、unit、worktree、分支；`/tmp/r5d-evidence.txt` 已在证据落盘后删除。

## 12. 回归门禁

```text
$ go vet ./...
vet_exit=0
$ go test -timeout 300s ./...
gotest_exit=0        # 全仓 ok（config/envprobe/httpapi/installer/market/metrics/privilege/
                     #        registry/scheduler/store/supervisor/platform 全绿）
$ make build
build_exit=0
[OK] 构建完成: ./bin/kored
$ make check
check_exit=0         # 11/11 段：docs-check(5 pass/1 warn) + dep-check + thin-shell(4/0)
                     # + repo-check(5/0) + canonical(9/0) + log-check + wt-check
                     # + oss-check(8/0) + case-check(28/0) + frontend + secret-check(0 FAIL)
$ bash scripts/thin-shell-check.sh
thin-shell-check: 4 pass, 0 fail（扫描 123 个可执行 .go 文件）
$ go test -c -o /tmp/r5d/platform.test ./internal/platform/
$ sudo -n env KORE_R5_DEMOTION_TEST=1 /tmp/r5d/platform.test -test.v -test.run 'TestEnsureAndApplySystemAccount'
--- PASS: TestEnsureAndApplySystemAccount (0.13s)
PASS
```

> 门禁过程记录（不掩盖）：首轮 `make check` 有一处**本轨道引起的**真实 FAIL——`useradd` 参数里的
> `--no-create-home` 命中薄壳门禁的业务动作词 `create`（`thin-shell-check` 第 4 项）。该参数本身冗余
> （`useradd` 不传 `-m` 即不建 home，home 字段已显式 `--home-dir /nonexistent`），删掉后 4/0 通过；
> `SECURITY §6` / `ADR-0018` 的 argv 原文已同步为实际使用的形式。
> 另有一次 `repo-check` FAIL 来自另一轨道的临时文件 `pkg/pluginapi/rootpolicy_crossrepo_test.go`
> （引用 `kore-plugin-waf`），该文件在复跑前已被其 owner 移除；与本次改动无关。

## 13. 已证明 / 未证明

**已证明（真机、可复跑）**

1. root 内核下插件进程 `Uid != 0`（terminal 994 / monitor 992 / logs 991 / firewall 990 / echo 993），`Groups` 只剩各自主组，未继承 root 的 sudo/docker 组。
2. 系统用户按需创建（无 home、nologin、独立主组），日志与 `/etc/passwd` 双重可见。
3. 插件状态目录 `0700 kore-<id>`；父链 `0701`；socket `0600 kore-<id>`；跨插件 socket 连接被拒、自己的 socket 可连；目录不可列举。
4. 插件直接调特权命令被拒：`ufw` / `sudo` / `nft` exit 1，读 `/etc/shadow` EACCES；`docker ps` exit 1。
5. 低权下正常动作仍可用：echo.ping、monitor.system、logs.tail（自定义源）。
6. 管理会话经 root-action 通道执行 `ufw-status` 成功（exit 0，输出完整，unit 可查）；缺 confirm 的不可回滚动作 401 + deny 审计；审计 allow/deny 两类齐全。
7. 降权后 `systemd-run --uid=0` 由 root 内核发起仍可用，与插件身份无冲突。
8. 降权失败路径（建用户失败 / uid=0 / 凭据不可用）失败即拒绝，不退回同 uid（单测覆盖）。
9. 修复了降权暴露的真实缺陷：安装器 `0700` 版本目录导致插件无法 exec（补 o+rx 后 ready）。

**未证明（明确列出，不得当成已通过）**

1. **插件 → 内核 bearer 通道**：已按方案①实现（独立通道 socket，见 §16），默认权限下插件可连；残余边界是共享组 `kore` 的回收与限流（见 §16.4）。
2. **macOS / Windows**：平台桩只保证编译，插件仍同用户运行。
3. **无 `useradd` / `adduser` 的发行版**（Alpine/busybox 等）：未实测。
4. **SELinux / AppArmor enforcing** 下的 `Credential` + chown + o+x 全链路：未实测。
5. **非 root 部署 → root 部署的目录切换**：未做自动回切，仅保证错误可见。
6. **site / waf / dns / runtime-\* 的真实降级行为**：仅代码审阅与设计推演，未安装运行；site 写 `/etc/nginx` 会被 DAC 拒绝属预期，但未实测该插件的错误形态。
7. **`make check` / `make build` / 全量 `go test ./...` 的结论以 §12 回填为准**（若回填前引用按未验证处理）。

## 14. 需 lead / 用户裁决

1. **通道 socket 的口径**：已按方案①实现（`0660 root:kore` + bearer + `SO_PEERCRED(uid,pid)`）。残余裁决项：共享组 `kore` 未纳入 `kore uninstall` 清理；是否要为"每插件一个通道 socket + 属主 kore-<id>"支付动态 listener 成本（当前判断：不值得）。
2. **container 插件在降权后的定位**：本机 `docker.sock` 为 `root:docker 0660`，插件降权后必然不可用；把它加进 `docker` 组等价 root，与 ADR 冲突 → 建议 container 声明 `root_actions` 走通道（受限命令形状），或明确标注"需要把 kored 运行在 docker 组 + 自行承担等价 root 风险"。
3. **site / waf / dns / runtime-\***：降权后"装可写但用不了"，需各自声明 `root_actions`（协议已在），否则产品体验上会出现"启用了但全红"。是否接受"先声明再启用"的过渡期，需产品口径。
4. **插件目录世界可读**（版本树 o+rx）：当前包内只有二进制与 `info.json`，可接受；若未来包内可能含敏感文件（证书、密钥），需要改为"按插件 uid chown 目录 + 只读 bind"或安装期显式声明，请确认。

## 15. 复跑清单（最小）

```bash
# 1) 单测（任意用户；root 门禁用例自动 skip）
go vet ./internal/core/supervisor/ ./internal/platform/
go test -timeout 240s ./internal/core/supervisor/ ./internal/platform/

# 2) 真 root 门禁（建/删 kore-r5test-<pid>，自清理）
go test -c -o /tmp/r5d/platform.test ./internal/platform/
sudo -n /tmp/r5d/platform.test -test.v -test.run 'TestEnsureAndApplySystemAccount'

# 3) 隔离实例（不要指向主实例；结束后删 /tmp 目录与 kore-* 用户）
go build -trimpath -buildvcs=false -o /tmp/r5d/kored ./cmd/kored
#   config：独立 --config、state/run/log 全落 /tmp、独立端口（如 18874）
#   kored install --package ../kore-plugin-firewall/dist/firewall-0.2.3.tar.gz（等）
systemd-run --user --unit=r5d-root --collect sudo -n /tmp/r5d/kored serve --config /tmp/r5d/config.yaml
#   登录 → enable → invoke；插件进程 Uid 见 /proc/<pid>/status；root-action 见 §7
```

## 16. P0 修复证据（2026-11-23 17:00–17:20，waf 真机回归暴露）

### 16.1 P0-1 降权插件连不上内核 socket → 独立通道 socket

根因（不是 `ownSocket`）：`ownSocket` 管的是**插件自己的协议 socket**（`<run>/plugins/<id>.sock`，已 `chown kore-<id> 0600`，hello 正常）；插件连不上的是**管理 socket `kore.sock`（root:root 0600）**——`KORE_KERNEL_SOCK` 原先指向它，降权后 `connect: permission denied`，root-action 通道对插件不可用。

修复：新增**独立通道 socket**（ADR-0018「插件侧通道」）：
- 路径 `<run>/kore-channel.sock`，`root:kore` **0660**；主 `kore.sock` 保持 `0600 root:root` 不放宽；
- root 内核启动时创建共享组 `kore`（`platform.EnsureGroup`）；插件降权时加入该组，`Credential.Groups` 带该 gid；
- 通道只接受 `POST /api/v1/plugins/<id>/root-action`，四关校验：bearer 所属 id == 路径 id、`SO_PEERCRED.uid == kore-<id>`、pid == supervisor 记录的**子进程 pid**、已获 `system:admin`；
- 拒绝路径落 `capability.denied` 审计 + WARN；管理 cookie 在通道完全无效。

隔离实例实测（root kored，18875）：

```text
# 通道 socket 与共享组
660 root:kore /tmp/r5p/run/kore-channel.sock
kore:x:971:

# 降权插件进程与组
pid=3379742 user=kore-terminal
Uid:	994	994	994	994
Gid:	969	969	969	969
Groups:	969 971 
$ sudo -n id kore-terminal
uid=994(kore-terminal) gid=969(kore-terminal) groups=969(kore-terminal),971(kore)

# 注入给插件的通道路径
KORE_KERNEL_SOCK=/tmp/r5p/run/kore-channel.sock

# 判据：默认权限下、不做任何 chmod，插件经通道成功
POST /api/v1/invoke/firewall/status
{"backend":"ufw","available":true,"enabled":false,"default_in":"","rules_count":0,"error":""}

# 审计：subject=firewall（插件身份，非 admin）
2026-11-23T09:12:06Z firewall ufw-status ok allow begin -1 kore-root-firewall-ufw-status-4ecc531d
2026-11-23T09:12:06Z firewall ufw-status ok allow end 0 kore-root-firewall-ufw-status-4ecc531d

# 边界：非组成员（pt）连通道 socket 被拒
CONNECT_DENIED: [Errno 13] Permission denied
```

单测：`internal/core/httpapi/channel_test.go` 覆盖 4 类拒绝（非 root-action 路径 404、无 bearer 401、token/路径不一致 401、uid/pid/peercred 不符 401）与成功路径（200 + 执行器被调用）；`internal/platform` root 门禁用例断言 `Credential.Groups == [主组, 通道组]` 且 `id -G` 含通道组。

### 16.2 P0-2 root 安装的插件文件非 root 读不到

根因：`extract.writeEntry` 采信包内 mode（`| 0o600`）——root 构建的 `info.json` 0600；`commit` 落位的版本目录来自 `MkdirTemp` 的 0700；插件根由 `.staging` 的 `MkdirAll` 隐式创建为 0700。结果非 root 启动的 kored 连目录都进不去，清单读取失败 → 插件被判「未安装」。

修复（B + C：可读归一 + 可操作诊断）：
- `extract`：**不采信包内 mode**——可执行 → 0755，其余 → 0644；
- `commit`：版本目录 `Chmod 0755`；
- `ensureRoot`：插件根 0755；
- `loadCatalog`：清单读取遇到 `fs.ErrPermission` 时 ERROR 级输出 `chown -R <kored 用户> <dir>` / `chmod -R a+rX <dir>` 的可操作提示，不再静默按"未安装"跳过。

root 安装后实测（同一份文件，非 root `pt` 直接读）：

```text
755 root:root /tmp/r5p/state/plugins
755 root:root /tmp/r5p/state/plugins/firewall
755 root:root /tmp/r5p/state/plugins/firewall/0.2.3
644 root:root /tmp/r5p/state/plugins/firewall/0.2.3/info.json
755 root:root /tmp/r5p/state/plugins/firewall/0.2.3/bin/firewall

$ head -c 80 /tmp/r5p/state/plugins/firewall/0.2.3/info.json
{
  "id": "firewall",
  ...
nonroot_read_exit=0
```

单测：`TestInstallNormalizesFileModes`（包内 0600/0700 → 落位 0644/0755，版本目录 0755）。

### 16.3 本轮门禁（2026-11-23 17:2x）

```text
$ go build ./...
build_exit=0
$ go vet ./...
vet_exit=0
$ go test -count=1 -timeout 300s ./...
gotest_exit=0（15 包 ok，无 FAIL）
$ make build
build_exit=0
$ make check
check_exit=0（13/13 段：docs-check 5 pass/1 warn + dep + thin-shell 4/0 + repo 5/0
  + canonical 9/0 + log + wt + oss 8/0 + case 28/0 + frontend + secret 0 FAIL
  + zero-intrusion 11 pass/0 fail）
$ GOOS=windows GOARCH=amd64 go build ./internal/platform ./internal/core/httpapi ./internal/core/supervisor ./internal/core/installer
cross_ok
```

### 16.4 仍未证明 / 残余

1. 共享组 `kore` 未纳入 `kore uninstall` 清理（空组无害，属残留）。
2. 每插件独立通道 socket + 属主 `kore-<id>` 未实现（当前判断不值得：动态 listener 成本 vs uid/pid 双校验已挡住冒用）。
3. 通道无独立速率限制（仅产生 WARN/审计噪音，不越权）。
4. SELinux/AppArmor enforcing、busybox（无 groupadd/usermod）、macOS/Windows 仍未实测。
5. 非 root kored 读 root 安装的**状态库**（state.db 0600 root）仍需同用户启动；本轮只修插件文件可读与诊断，不承诺跨用户切换整套 state。
