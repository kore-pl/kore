> 状态: factual record · 归属: system-service-install · 更新: 2026-11-25 · 里程碑: M1
> 任务: 安装系统级 root 服务 kore.service 并从 uid1000 的 kored-local.service 切换过来。

# 系统级 root 服务安装 / 切换证据（2026-11-25）

## 一句话结论

`kore.service`（User=root）已安装、enable 并接管 8787；healthz=200；属主为 root。
**重要偏差**：root 内核启动 resident 插件时自动执行了 `useradd`/`usermod`（创建了 `kore-site`、`kore-terminal` 系统用户），与任务卡「不 useradd/usermod」禁项冲突——已即时上报 lead/用户，未做 `chown -R`。

## 只读盘点（安装前）

| 项 | 事实 |
| --- | --- |
| 8787 healthz | `curl http=200` |
| system/info（无凭据） | `{"code":"E_UNAUTHORIZED","message":"未授权"}`（预期 401） |
| 旧服务 | transient user unit `kored-local.service`，User=pt，MainPID=2745627，ExecStart 指向 `/home/pt/Work/GolandProjects/kore/bin/kored serve --config .../.kore-local.yaml`（argv 路径已失效；`/proc/<pid>/exe` 实际指向本工作区 `bin/kored`，state.db 在本工作区 `.kore-local-state`） |
| user bus | 本 shell `systemctl --user` 报 `Failed to connect to user scope bus`；在 `systemd-run --user --unit=... --wait --pipe --collect` 派生的上下文里可达 |
| bin/kored | sha256 `d53b6ed58e77b2d1e61fe7074cbc5e1c8e3ec0ce9acccabbd79d6a128e2a0fa5`，mtime `2026-11-24 20:07:58 +0800`，mode 775，pt:pt |
| /etc/systemd/system/kore.service | 不存在（无覆盖冲突）；系统 `kore*` unit 数 0 |
| kore-* 用户 | 无（group `kore` 已存在，gid=971） |
| 端口 | `127.0.0.1:8787` 监听中 |

## 脚本评审与修补（先于安装）

仓库脚本实为 `scripts/install-system-service.sh`（RUNBOOK.md §5.1 + ADR-0042/0049 指定）；不存在 `scripts/install.sh`。Makefile 的 `install` 目标调用的是另一支 `scripts/install-service.sh`（非 root 服务口径）。

脚本原有行为完备（User=root、ExecStart 指向真实二进制、cmp 幂等、只写 ADR-0023 §3.5 豁免 #1 的 unit、无 chown -R / useradd / sudoers），但有两处缺口，已最小修补：

1. `enable --now` 会在旧实例仍占 8787/state.db 时抢启 → 新增 `--no-start`（只写 unit + enable，不 start），供有序切换使用。
2. 既有 unit 内容不同会被静默覆盖 → 默认拒绝并 exit 5，显式 `--overwrite` 才允许。

验证：`bash -n scripts/install-system-service.sh` → rc=0；临时 harness（`/tmp`，调用内即删）功能测试 T1–T5 通过：dry-run 显示新启动方式、`--no-start` 不调 start、冲突拒绝 exit 5、`--overwrite` 放行、二次幂等。

提交：`659aec8 [agent:system-service-install] fix(privilege): 安装器支持 --no-start/拒绝覆盖既有 unit（有序切换）`（1 file / +26 -3，精确 pathspec，**未 push**）。

## root 通道命令与退出码（所有 root 动作只走 dsh-root）

1. `dsh-root --dry-run bash scripts/install-system-service.sh --no-start --install-root <repo> --bin <repo>/bin/kored --config <repo>/.kore-local.yaml --force`
   - 退出码：0
   - 关键输出：`将执行: systemd-run --user --unit=dsh-root-... --wait --pipe --collect -q sudo -n -- bash .../install-system-service.sh ...`；`未执行任何命令`
   - 告警（如实）：`dsh-root: 警告: 无法写入审计日志 /home/pt/.local/state/dsh/root-exec.log`（只读文件系统）——审计缺口。
2. `dsh-root bash scripts/install-system-service.sh --no-start --install-root <repo> --bin <repo>/bin/kored --config <repo>/.kore-local.yaml --force`
   - 退出码：0
   - 关键输出：`[OK] 已写入 /etc/systemd/system/kore.service`；`[OK] 已 enable（未 start，--no-start）: kore；当前 active=inactive`；stderr `Created symlink '/etc/systemd/system/multi-user.target.wants/kore.service' → '/etc/systemd/system/kore.service'.`
   - 同一审计日志告警。
3. 切换（旧服务经 `systemd-run --user ... systemctl --user stop kored-local.service`，非 root）：rc=0；stop 后 healthz `http=000`、rc=7，端口空闲 → **中断约 1 秒**。
4. `dsh-root systemctl start kore.service`
   - 退出码：0
   - 紧接 `systemctl is-active kore.service` → `active`（rc=0）；`systemctl show -p MainPID -p User --value kore.service` → `1026600`、`root`（rc=0）。

## 复核（安装后）

| 判据 | 命令 | 结果 |
| --- | --- | --- |
| is-active | `systemctl is-active kore.service` | `active`，rc=0 |
| status 摘要 | `systemctl status kore.service --no-pager --lines=8` | `Active: active (running) since Wed 2026-11-25 18:33:37 CST`；`Main PID: 1026600 (kored)`；CGroup `/system.slice/kore.service` |
| healthz | `curl -sS -o /dev/null -w 'http=%{http_code}' http://127.0.0.1:8787/-/healthz` | `200`（stop→start 后第一次探测即 200） |
| system/info | `curl http://127.0.0.1:8787/api/v1/system/info` | `E_UNAUTHORIZED`（未带凭据，如实标注） |
| 属主 | `ps -o user,pid,args -C kored`（host namespace via `systemd-run --user`） | `root 1026600 /home/.../bin/kored serve --config .../.kore-local.yaml` |
| exe | `readlink /proc/1026600/exe`（host namespace） | 本沙箱无输出（bwrap PID 视图限制）；`/proc/<pid>/cwd` 与 systemd ExecStart 均指向本工作区 |
| unit User | `systemctl show -p User --value kore.service` | `root` |
| 配置未改 | `stat .kore-local.yaml` | mtime `2026-11-23 04:59:58`，mode 600，pt:pt（未改） |

## 影响面与偏差（必须点明）

- **8787 中断**：约 1 秒（旧服务 stop 后、新服务 start 后第一次探测恢复）。
- **root 服务固有副作用（范围冲突）**：journal 显示 18:33:37 `useradd[1026644]: new user: name=kore-terminal, UID=993, GID=968` + `usermod: add 'kore-terminal' to group 'kore'`；当前 `getent passwd | grep '^kore-'` → `kore-site:x:994:969:...`、`kore-terminal:x:993:968:...`。代码事实：`internal/core/supervisor/demote.go:98` + `internal/platform/linux_identity.go:109-189`，无开关可关；我本人未手敲 useradd/usermod。
- **运行态路径位变化（内核 demote 副作用）**：`.kore-local-state` mode 700→701、`.kore-local-run` mode 700→701（仅补 o+x，属主仍 pt:pt），mtime 仅 run 目录与 state.db 因重启更新；`.kore-local-state/plugins` 与 `.kore-local-log` mtime 未变。
- **插件二进制属主**：切换后 pt 用户 `stat` 报 Permission denied（内核把 site/terminal 的插件文件交给低权 `kore-*` 用户，属 ADR-0018 降权设计，非我手工 chown）。
- 未做：`chown -R`、手改 `.kore-local.yaml`（含 index_dir）、插件升级、git push/tag、CI 触发、删数据。临时测试目录均在同一调用内删除。
- 审计缺口：dsh-root 日志路径只读，无法写入审计日志（两次调用均告警）。

## 回退办法（未执行，待用户/lead 明确指示）

1. `dsh-root systemctl disable --now kore.service`
2. `dsh-root bash scripts/install-system-service.sh --remove`（删 unit + daemon-reload）
3. 经 `systemd-run --user --wait --pipe --collect systemctl --user start kored-local` 恢复旧实例
4. 视用户裁决用 `userdel kore-site kore-terminal` 清理（属破坏性，须明确授权）
