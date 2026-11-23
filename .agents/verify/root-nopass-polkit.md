# 验收报告：polkit 规则实现 root 提权零口令（ADR-0018 通道）

> 日期：2026-11-23 22:0x +0800 · 角色：implementer（`root-nopass-polkit`）· 写域：`scripts/install-polkit-rule.sh`、`docs/SECURITY.md` §15.5、本文件
> 结论：规则与安装器已落地并通过功能自检（13/13）；**本机无法真装**（`sudo` 被 `NoNewPrivs=1` 阻断），安装后 `systemd-run` 对比**未实测**，状态记 **PARTIAL**，不得当成已通过。

## 1. 现状事实（命令 + 退出码 + 原始输出）

```console
$ id
uid=1000(pt) gid=1000(pt) groups=1000(pt),4(adm),24(cdrom),27(sudo),30(dip),46(plugdev),100(users),111(lpadmin),114(lxd),970(libvirt),973(docker),991(kvm),994(input)

$ systemctl --user status kored-local | head -4
● kored-local.service - [systemd-run] .../bin/kored serve --config .../.kore-local.yaml
     Loaded: loaded (/run/user/1000/systemd/transient/kored-local.service; transient)
     Active: active (running) since Mon 2026-11-23 21:41:58 CST
     Main PID: 2798902 (kored)        # 运行用户 pt，非 root

$ pkaction --action-id org.freedesktop.systemd1.manage-units
org.freedesktop.systemd1.manage-units

$ pkaction --action-id org.freedesktop.systemd1.manage-units --verbose
  implicit any:      auth_admin
  implicit inactive: auth_admin
  implicit active:   auth_admin_keep        # 默认每次都要授权；keep 只是短时缓存

$ systemd-run --uid=0 --pipe true ; echo EXIT=$?
Failed to start transient service unit: Access denied
EXIT=1

$ journalctl -b --since -15min | grep polkit
polkitd[1532]: Operator of unix-session:2 FAILED to authenticate to gain authorization for action
org.freedesktop.systemd1.manage-units for system-bus-name::1.437722 [systemd-run --uid=0 --pipe true]
(owned by unix-user:pt)

$ ls -ld /etc/polkit-1/rules.d /usr/share/polkit-1/rules.d
drwxr-x--- 2 root polkitd ... /etc/polkit-1/rules.d
drwxr-xr-x 2 root root    ... /usr/share/polkit-1/rules.d

$ sudo -n true ; echo EXIT=$?
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
EXIT=1        # 本会话被 NoNewPrivs=1 限制，无法真装规则（非规则本身问题）
```

提权通道实现（只读核对，未改代码）：

- `internal/core/privilege/systemd.go:36` `BuildSystemdRunArgv`：`systemd-run --uid=0 --collect --wait -p StandardOutput=file:... -p StandardError=file:... --unit=<unit> -- <argv...>`，固定 argv，无 shell。
- `internal/core/privilege/output.go:64` `unitName`：`kore-root-<plugin>-<action>-<rand8>`（`rand8` = 8 位十六进制；随机失败时退化为 `kore-root-<plugin>-<action>`）。
- `internal/core/privilege/service.go:102` 每次执行独立 unit；超时走 `systemctl kill/stop <unit>`（`systemd.go:70-78`）→ 规则必须同时放行 `kill` / `stop`。
- 依赖的动作：`org.freedesktop.systemd1.manage-units`（`Verb=start|kill|stop|reset-failed`，`Unit=<name>`）。

## 2. 规则文件路径与完整内容（收紧条件已标注）

目标路径：`/etc/polkit-1/rules.d/49-kore.rules`（脚本按存在性选择：`/etc/polkit-1/rules.d` 优先，缺失退 `/usr/share/polkit-1/rules.d`；本机两者都存在，选 `/etc`）。`--dry-run` 输出原文：

```js
// /etc/polkit-1/rules.d/49-kore.rules — kore root-action 免口令通道（ADR-0018 / G-31）
// 安装: scripts/install-polkit-rule.sh --user pt
// 卸载: scripts/install-polkit-rule.sh --remove
//
// 安全边界：本规则等价于「pt 可免口令、以任意 uid（含 uid=0）
// 启动/终止名为 kore-root-* 的 systemd transient unit」——这是产品级提权。
// 与 ADR-0018 的关系：把"谁来授权"从每次弹口令改成本次安装的一次性授权，
// 授权范围由 unit 名白名单收敛，发起者与动作可在 journal 里对上。
// 仅在 pt 就是 kore 服务运行身份时安装；不要把 kore-<id> 插件用户
// 或 root 之外的通用账号写进 subject.user。
//
// 最小权限（5 条，缺一条即 NOT_HANDLED；本规则不写无条件 YES，也不写 NO）：
//   1) 只对 org.freedesktop.systemd1.manage-units
//   2) 只对 subject.user === "pt"
//   3) 只对本机活动会话（subject.local && subject.active）
//   4) 只对 verb ∈ {start, kill, stop, reset-failed}
//   5) 只对 unit ∈ /^kore-root-[a-z][a-z0-9-]*-[a-z][a-z0-9-]*(-[0-9a-f]{8})?\.service$/
polkit.addRule(function(action, subject) {
    var ACTION = "org.freedesktop.systemd1.manage-units";
    var USER = "pt";
    var UNIT_RE = /^kore-root-[a-z][a-z0-9-]*-[a-z][a-z0-9-]*(-[0-9a-f]{8})?\.service$/;
    var VERBS = ["start", "kill", "stop", "reset-failed"];

    if (action.id !== ACTION) { return polkit.Result.NOT_HANDLED; }
    if (!subject || subject.user !== USER) { return polkit.Result.NOT_HANDLED; }
    if (!subject.local || !subject.active) { return polkit.Result.NOT_HANDLED; }
    var verb = action.lookup("verb");
    if (!verb || VERBS.indexOf(verb) === -1) { return polkit.Result.NOT_HANDLED; }
    var unit = action.lookup("unit");
    if (!unit || !UNIT_RE.test(unit)) { return polkit.Result.NOT_HANDLED; }
    return polkit.Result.YES;
});
```

`<user>` 是安装参数（默认 `SUDO_USER`，否则 `id -un`）；拒绝 `root`（root 本绕过 polkit）。

## 3. 最小权限逐条说明

| # | 条件 | 挡住什么 |
| --- | --- | --- |
| 1 | `action.id === "org.freedesktop.systemd1.manage-units"` | 其他 action（`manage-unit-files`、`login1.*`、`packagekit`）一律不放行 |
| 2 | `subject.user === "<服务用户>"` | 按**用户名**而非组；同机其他用户、`kore-<id>` 插件用户、`sudo` 组成员都不自动获得 |
| 3 | `subject.local && subject.active` | 远程/非活动会话不放行（避免会话借用与 detached 进程） |
| 4 | `verb ∈ {start,kill,stop,reset-failed}` | `disable`/`mask`/`edit`/`set-property`/`clean` 等能改持久配置或改 unit 定义的 verb 全拒 |
| 5 | `unit` 匹配 `^kore-root-<plugin>-<action>(-<8hex>)?\.service$` | 只放行内核代理自己生成的 unit 名形态；`nginx.service`、`kore.service`、`.timer`、带 `;`/空格等注入字符的 unit 名全拒 |
| — | 其余 `NOT_HANDLED` | 交回系统默认 `auth_admin`，不写 `NO`（不阻断管理员规则），也不写无条件 `YES` |

## 4. `--dry-run` / `--check` / 真装

```console
$ bash scripts/install-polkit-rule.sh --check
polkit 规则安装（kore root-action 免口令）
  规则目录: /etc/polkit-1/rules.d（存在性判断：yes）
  目标文件: /etc/polkit-1/rules.d/49-kore.rules
  服务用户: pt (uid=1000)
  polkitd : active
...（规则全文）...
语法/功能自检（node + 假 polkit 沙箱；不触达真实 polkitd）：
  PASS  白名单 unit + start: got=YES want=YES
  PASS  白名单 unit 无随机后缀 + stop: got=YES want=YES
  PASS  白名单 unit + kill: got=YES want=YES
  PASS  非 kore-root 前缀（nginx）: got=NOT_HANDLED want=NOT_HANDLED
  PASS  同前缀但危险 verb（disable）: got=NOT_HANDLED want=NOT_HANDLED
  PASS  同前缀但危险 verb（mask）: got=NOT_HANDLED want=NOT_HANDLED
  PASS  同前缀但非 .service（.timer）: got=NOT_HANDLED want=NOT_HANDLED
  PASS  unit 名带注入字符: got=NOT_HANDLED want=NOT_HANDLED
  PASS  其他用户: got=NOT_HANDLED want=NOT_HANDLED
  PASS  非本机会话: got=NOT_HANDLED want=NOT_HANDLED
  PASS  会话不活动: got=NOT_HANDLED want=NOT_HANDLED
  PASS  action 不符（manage-unit-files）: got=NOT_HANDLED want=NOT_HANDLED
  PASS  unit 缺失: got=NOT_HANDLED want=NOT_HANDLED
  ---- 功能自检 13/13 通过 ----
[INFO] 尚未安装（/etc/polkit-1/rules.d/49-kore.rules 不存在）
EXIT=0

$ bash scripts/install-polkit-rule.sh --user pt ; echo EXIT=$?
...[NEED-ROOT] 真装需要 root。请以运维身份执行（本脚本不自行提权、不碰 sudo）：
  sudo bash scripts/install-polkit-rule.sh --user pt
EXIT=3

$ bash scripts/install-polkit-rule.sh --remove ; echo EXIT=$?
[NEED-ROOT] 卸载需要 root：sudo bash scripts/install-polkit-rule.sh --remove
EXIT=3

$ bash -n scripts/install-polkit-rule.sh ; echo EXIT=0
```

**安装前后 `systemd-run --uid=0 --pipe true` 对比**：

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| 安装前（未装规则） | `systemd-run --uid=0 --pipe true` | `Failed to start transient service unit: Access denied`，exit 1；journal `FAILED to authenticate` |
| 安装后 | 同上 | **未实测**（本会话 `NoNewPrivs=1`，`sudo` 无法提权装规则）。预期由规则返回 `YES` → 不弹框、unit 以 uid=0 执行 |
| 卸载后 | 同上 | **未实测**；预期回到第一行（`auth_admin` → 拒绝/弹框） |

> 本机真装命令（运维执行一次即可）：
> `sudo bash scripts/install-polkit-rule.sh --user pt && systemd-run --uid=0 --pipe true; echo EXIT=$?`
> 真装后应看到 `Running as unit: run-...` 且 EXIT=0；卸载用 `sudo bash scripts/install-polkit-rule.sh --remove`。

## 5. 安全边界原文（脚本注释与 `docs/SECURITY.md` §15.5 同文）

「这条规则等价于：**`<kore 服务用户>` 可以无视口令、以任意 uid（含 uid=0）启动/终止名字匹配 `kore-root-*` 的 systemd 单元**。它本身是一种产品级提权，不是"配置小改"。与 ADR-0018 的关系：ADR-0018 选了「内核代理 + systemd transient unit」，但没规定"谁来授权"；本规则把授权从「每次操作弹 polkit 口令框」改成「安装时一次性授权 + 可审计的 unit 名白名单」。不装这条规则 → 普通用户跑 kored 时每次 root 动作都要求输入管理员口令，产品无法满足「零口令」裁决；装了 → 本机该用户获得上述白名单提权。」

## 6. ADR-0023 §3.5 判断（只报告，未改 ADR）

**要进。** 新增安装目录外写入 `/etc/polkit-1/rules.d/49-kore.rules`（1 文件 0 逻辑），按 G-31 必须先改 ADR-0023。建议新增豁免 #5（文案见 `docs/SECURITY.md` §15.5 末尾）：清理=`kore uninstall` / `--remove`；边界=仅"零口令"安装可选写入，规则按用户名 + unit 前缀收敛，卸载即恢复口令授权。**本轨未修改 ADR-0023**，由 ADR 维护方落笔。

## 7. 未完成项

1. **真装与前后对比未实测**：会话 `NoNewPrivs=1` → `sudo` 被内核阻断（原始错误见 §1），`/etc/polkit-1/rules.d` 不可写。已改为：规则功能自检 13/13（假 polkit 沙箱）+ `bash -n` 语法检查；真机对比需运维执行 §4 的一行命令。
2. **polkitd 真实加载未验证**：`--check` 只在 node 沙箱验证规则逻辑，未让 polkitd 实际加载（需 root 写文件）。
3. **未验证 `StartTransientUnit` 的 `verb` 实际取值**：按 systemd 源码为 `start`，本机无法在授权前观测 detail；真装后若仍被拒，用 `journalctl -u polkit` 的 `action details` 核对 verb/unit 后调整白名单。
4. **未改 ADR-0023**（按任务要求只报告）。

---

# 追加：方案 B（系统级 root 服务，ADR-0042）核实现状与落地

> 2026-11-23 22:2x · 用户裁决升级为「任何时候都不应该有本机账号密码的输入，这是绝对的」→ 选 **B**（结构性消除运行期授权），A（polkit）降为降级路径。

## B-1 现状事实

```console
$ systemctl --user status kored-local | head -4
● kored-local.service - [systemd-run] .../bin/kored serve --config .../.kore-local.yaml
     Loaded: loaded (/run/user/1000/systemd/transient/kored-local.service; transient)
     Active: active (running) since 2026-11-23 21:41:58 CST
     Main PID: 2798902 (kored)              # 运行用户 pt：用户级 transient unit，非系统级

$ ls -l /etc/systemd/system/kore.service ; systemctl status kore
ls: cannot access '/etc/systemd/system/kore.service': No such file or directory
Unit kore.service could not be found.        # 系统级 unit 从未安装

$ grep -n "User=" scripts/install-service.sh   # 既有安装脚本
（无输出：写 /etc/systemd/system/kore.service 但未声明 User=，systemd 默认 root）

$ sed -n '160,193p' docs/RUNBOOK.md
User=root
...
**为什么必须 root**：`systemd-run --uid=0` 由非 root 调用会走 polkit 交互认证；本机实测
`--no-ask-password` 被拒。以 root 启动 kored 后，transient unit 由已授权的 systemd
直接拉起，不需要交互。
```

结论：B 不是新架构——ADR-0018 §15.1 的前提就是「kored 以 root 启动、插件降到 `kore-<id>`」，RUNBOOK §5.1 早已给出 `User=root` unit；当前 pt 实例是**降级形态**。B = 把既有设计作为默认安装形态落地。

## B-2 方案对比与决策

见 `docs/DECISIONS/0042-privilege-without-prompt.md`（proposed）：A 每次操作仍过一次 authorization check，规则丢失/被覆盖即退回弹框，且需新增 ADR-0023 豁免；B 无授权判定、无规则文件、不新增豁免（只写豁免 #1 的 unit）。**选 B。**

## B-3 落地件与实测

```console
$ bash -n scripts/install-system-service.sh ; echo EXIT=$?
EXIT=0

$ bash scripts/install-system-service.sh --dry-run --install-root /home/pt/Work/GolandProjects/kore
kore 系统级 root 服务安装计划（ADR-0042 方案 B）
  unit 文件 : /etc/systemd/system/kore.service（ADR-0023 §3.5 豁免 #1）
  ExecStart : /home/pt/Work/GolandProjects/kore/bin/kored serve
  KORE_HOME : /home/pt/Work/GolandProjects/kore
  运行身份  : root（uid=0；特权动作不经 polkit 授权）
  状态/日志 : 全部在 /home/pt/Work/GolandProjects/kore 内（不新增零侵入豁免）
  [WARN] 检测到 systemctl --user 的 kored-local 正在运行（同一 state/socket 会冲突）
----- unit 内容 -----
[Service]
Type=simple
User=root
NoNewPrivileges=false
Environment=KORE_HOME=/home/pt/Work/GolandProjects/kore
ExecStart=/home/pt/Work/GolandProjects/kore/bin/kored serve
Restart=on-failure
KillMode=mixed
Delegate=yes
LimitNOFILE=65536
UMask=0022
----- unit 内容结束 -----
[DRY-RUN] 未写入任何文件
EXIT=0

$ bash scripts/install-system-service.sh --install-root /home/pt/Work/GolandProjects/kore ; echo EXIT=$?
[NEED-ROOT] 安装系统服务需要 root。以运维身份执行（脚本不自行提权）：
  sudo bash scripts/install-system-service.sh --install-root /home/pt/Work/GolandProjects/kore
EXIT=3
```

**真机验证未完成（诚实记录）**：本会话 `sudo -n true` → `no new privileges flag is set`，`/etc/systemd/system` 不可写 → 系统服务真装、`systemctl show -p User kore`、root 下 `firewall.root-action` 零交互、`journalctl -u polkit | grep -c manage-units` 均**未实测**。运维执行一次即可闭环：

```bash
sudo bash scripts/install-system-service.sh --install-root /opt/kore
systemctl show -p User --value kore                       # 期望 root
ps -o user= -C kored                                      # 期望 root
curl -sS --unix-socket /opt/kore/run/kore.sock -b <cookie> \
  -X POST http://kore/api/v1/plugins/firewall/root-action -d '{"action_id":"ufw-status"}'
journalctl -u polkit --since -5min | grep -c manage-units # 期望 0
```

## B-4 回答 lead 的问题

**选 B 之后，「需要 root 密码放行」在运行时还会不会出现？——不会。**
原因：口令框是 polkit 对**非 root** 调用 `manage-units` 的 `auth_admin` 交互；B 下调用方是已以 root 运行的 kored（`User=root`），uid=0 不进入 polkit 判定，systemd 直接执行 kernel 代理的 `systemd-run --uid=0`，链路上没有任何 authorization check、没有认证代理、没有 tromboning。唯一能让口令回归的路径是有人把实例改回普通用户运行（此时才需要降级路径 A，且 ADR-0042 要求显式提示）。

## B-5 未完成项（B）

1. 系统服务真装 + root 实例特权动作零交互实测：**被沙箱阻断**（NoNewPrivs=1 / 非 root），命令见 B-3。
2. `docs/RUNBOOK.md` §5.1 示例与脚本生成的 unit 尚未逐行对齐（RUNBOOK 里有 `RuntimeDirectory=kore` / `StateDirectory=kore` / `LogsDirectory=kore`，属 ADR-0023 清单外写入；脚本按零侵入生成，不含这三项）。建议 RUNBOOK 维护方同轮对齐为安装根内路径，或明确它们属"用户批准的宿主变更"。
3. ADR-0042 状态 `proposed`，待 lead 裁决后转 `accepted`。
