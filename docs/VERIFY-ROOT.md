> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5 · 关联: [ADR-0042](DECISIONS/0042-privilege-without-prompt.md)、[ADR-0023](DECISIONS/0023-zero-intrusion.md)、[ADR-0018](DECISIONS/0018-privilege-model.md)、[RUNBOOK](RUNBOOK.md) §5.1

# VERIFY-ROOT — 系统级 root 服务 + 自升级 / 自回滚零口令（一次性验证包）

本文件是 `scripts/verify-root-service.sh` 的配套说明：**用户在有 root 的机器上跑一次**，即可闭环 ADR-0042 落地后唯一没有真机验证的正路径。本机（2026-11-23）`NoNewPrivs=1`、`/etc/systemd/system` 不可写，只能交付脚本 + `--dry-run`，真跑必须由用户执行。

## 0. 要闭环的缺口与对应步骤

| 缺口（真机观测） | 本包怎么验 | 判据 |
| --- | --- | --- |
| `Unit kore.service could not be found`；主实例是 `systemd --user` + uid 1000 | STEP 1 装 `User=root` 的 unit 并 `enable --now` | `systemctl is-active kore` = `active` |
| 内核是否真的以 root 运行 | STEP 2 读 `MainPID` 的实际属主 | `ps -o user= -p <pid>` = `root` |
| 特权动作是否还要过 polkit | STEP 3 触发一次 root 动作，比较触发前后 `manage-units` 计数 | 差值 `0`，且 `FAILED to authenticate` 计数 `0` |
| `kored upgrade` 只能返回 exit 6（需 root），真实重启链路没跑过 | STEP 4 在 `/tmp` 假安装根上真跑 `kored upgrade`（含 `systemctl --no-block restart`） | exit `0`、`MainPID` 变化、服务回到 `active` |
| `upgrade-result.json` 的 `pending → success` | STEP 4 末尾 `kored upgrade --verify` | `"state": "success"` |
| `--rollback` 能切回 | STEP 5 同一假安装根上跑 `--rollback` | 目标 sha 回到旧值、`.prev` 变新值 |
| 宿主侧自卸载（`kored uninstall`） | STEP 6 **只预演** + 打印真跑会执行什么 | 预演 exit `0`，unit 仍存在；**不真删** |

## 1. 前置条件（缺一不可）

1. **root**：`sudo -v` 能过。脚本不自行提权，非 root 真跑直接 `exit 3`。
2. **systemd**：`systemctl --version` 可用、`/etc/systemd/system` 存在（无 systemd 的容器/WSL1 不适用）。
3. **停掉用户级实例**：`systemctl --user disable --now kored-local`。两个实例会抢同一 state/socket，`install-system-service.sh` 检测到它会 `[BLOCKED] exit 4`（`--force` 只跳过检查、不代停）。
4. **kored 就位**：默认 `<install-root>/bin/kored`（`/opt/kore/bin/kored`）；否则 `--install-root` / `--bin` 指定。脚本不下载、不安装二进制。
5. **管理会话（可选，但 STEP 3 需要）**：`--cookie` 或 `--password-file`。都不给时 STEP 3 自动降级为 `systemd-run --uid=0` 的机制等价自检，并明确记 `SKIP`、整体 `exit 7`（不谎报 PASS）。
6. **记录基线**（建议，便于对比）：

```bash
systemctl list-unit-files | grep -i '^kore' ; systemctl --user is-active kored-local
getent passwd | grep '^kore-' ; ls -l /opt/kore/bin/kored* 2>/dev/null
```

## 2. 怎么跑（两条命令）

```bash
# ① 先看计划：零变更，不装 unit、不重启、不替换、不删除
bash scripts/verify-root-service.sh --dry-run --install-root /opt/kore

# ② 真跑（必须 --yes；会装系统级 unit 并让服务重启一次）
sudo bash scripts/verify-root-service.sh --yes --install-root /opt/kore \
  --cookie /root/kore.cookies
```

`--cookie` 的获取方式（**口令不进脚本、不进 argv/历史**）：先登录一次拿到 cookie jar，或改用 `--password-file`：

```bash
read -rsp '管理员口令: ' PW && \
curl -sS --unix-socket /opt/kore/run/kore.sock -c /root/kore.cookies \
  -H 'Content-Type: application/json' --data-binary "{\"password\":\"${PW}\"}" \
  http://kore/api/v1/auth/login ; unset PW
# 或者：
install -m 0600 /dev/null /root/.kore-admin
read -rsp '管理员口令: ' PW && printf '%s' "$PW" >/root/.kore-admin && unset PW
sudo bash scripts/verify-root-service.sh --yes --password-file /root/.kore-admin
```

STEP 3 默认只挑**非 `irreversible`** 的 root 动作（优先 id 含 `status` / `list` 的只读动作）；要指定就看 `GET /api/v1/plugins/<id>` 返回的 `root_actions`，用 `--root-action-plugin` + `--root-action-id` 固定。

## 3. 每一步「正常应该看到什么」

> 下面是**期望**不是保证：发行版差异、插件集合、polkit 版本都会让个别行不同。判据列才是 pass/fail 依据。

### STEP 1 — 安装系统级 root unit

| 项 | 内容 |
| --- | --- |
| 执行 | `bash scripts/install-system-service.sh --install-root /opt/kore --bin /opt/kore/bin/kored --name kore` |
| 期望 | `[OK] 已写入 /etc/systemd/system/kore.service`（已存在且内容一致时：`[OK] unit 已是最新（幂等）`） |
| 判据 | `systemctl is-active kore` → `active`；`systemctl show -p User --value kore` → `root`；`test -f /etc/systemd/system/kore.service` → 存在 |
| 不符 | `[BLOCKED]` + `exit 4`：先停 `kored-local`；`[NEED-ROOT]`：忘了 `sudo`；`[FAIL] kored 不可执行`：先 `make build` |

### STEP 2 — 运行身份

| 项 | 内容 |
| --- | --- |
| 期望 | `MainPID` > 0；`ps -o user= -p <pid>` → `root`；`ps -o comm= -p <pid>` → `kored`；`ps -eo user=,comm=` 里所有 `kored` 都是 `root` |
| 判据 | 上面四项全部一致；脚本额外断言「没有非 root 的 kored 实例」 |
| 不符 | 服务起来了但不是 root：检查 unit 是否被 `systemctl edit` 的 drop-in 覆盖（`systemctl cat kore`） |

### STEP 3 — 特权动作不经 polkit

| 项 | 内容 |
| --- | --- |
| 执行 | `POST /api/v1/plugins/<plugin>/root-action`（UDS；body `{"action_id":"<id>"}`） |
| 期望 | HTTP 200；`"executed": true`；`"unit": "kore-root-<plugin>-<action>-<rand8>"`；`stdout` 是该动作自己的输出（如 `ufw status` 文本）。`exit_code` 由动作本身决定，动作失败不影响「是否经过 polkit」的结论 |
| 判据 | 触发后 `journalctl -u polkit --since=-5min --no-pager \| grep -c manage-units` 与触发前**差值 0**；`journalctl -u polkit --since=-2min \| grep -c "FAILED to authenticate"` = `0` |
| 降级 | 没给 `--cookie/--password-file` 时打印 `[FALLBACK]`，只跑 `systemd-run --uid=0 --collect --wait --quiet true`，STEP 记 `SKIP`、整体 `exit 7` |
| 不符 | 计数非 0：先看 `journalctl -u polkit -n 50` 是否有别的进程在申请 systemd 管理动作；确认没有后按 ADR-0042 复审条件 #4 处理 |

### STEP 4 — 升级链（`/tmp` 假安装根，不碰真实二进制）

| 项 | 内容 |
| --- | --- |
| 执行 | `kored upgrade --bin <假>/new-kored --sha256 <新 sha> --target <假>/bin/kored --state-dir <假>/data --unit-name kore` |
| 期望（逐行） | `[INFO] 目标二进制：<假>/bin/kored`；`[INFO] 新二进制：<假>/new-kored（sha256 … 校验通过）`；`[INFO] 旧二进制将保留为：<假>/bin/kored.prev`；`[OK] 已原子替换：…`；`[INFO] 已落 pending 标记：<假>/data/upgrade-result.json（重启后由新进程改写成 success）`；`[OK] 已提交重启：systemctl --no-block restart kore`；`退出码 0 = 已替换且已提交重启（不等于新版本已加载，见上两条判据）` |
| 判据 | 命令 exit `0`；`<假>/bin/kored.prev` 存在且 sha = 升级前；`<假>/bin/kored` sha = 新值；`upgrade-result.json` 初始 `"state": "pending"`；重启后 `MainPID` 变化、`systemctl show -p User` 仍 `root`、服务回到 `active` |
| 收尾 | `kored upgrade --verify --target <假>/bin/kored --state-dir <假>/data` → `[INFO] 升级已生效：…（upgrade-result=success）`，标记 `"state": "success"` |
| 说明 | 真实二进制**没有被替换**；`--unit-name kore` 让 `systemctl --no-block restart` 真的作用在系统级 unit 上——这正是此前 `exit 6` 走不到的那一段。加 `--no-unit-restart` 可跳过重启，但该步会记 `SKIP` |

### STEP 5 — 回滚链

| 项 | 内容 |
| --- | --- |
| 执行 | `kored upgrade --rollback --target <假>/bin/kored --state-dir <假>/data --no-restart` |
| 期望 | `[INFO] 回滚来源：<假>/bin/kored.prev（sha256 …）`；`[INFO] 目标二进制：…`；`[OK] 已回滚：…（替换前的二进制已存回 .prev，可再次 --rollback 切回）` |
| 判据 | exit `0`；目标 sha 回到旧值；`.prev` sha = STEP 4 的新值（证明可再次切回）；标记 `"state": "rollback-pending"`，再 `--verify` 后 `success` |
| 说明 | `--no-restart` 只为少一次服务重启；回滚后脚本会打印「再次切回」的完整命令，但不执行 |

### STEP 6 — 自卸载只预演

| 项 | 内容 |
| --- | --- |
| 执行 | `env KORE_HOME=/opt/kore /opt/kore/bin/kored uninstall --dry-run` |
| 期望 | `[INFO] 安装根：…`；`[INFO] 状态目录：…`；`[INFO] profile：portable`；`[INFO] unit：不适用（portable 模式：…）`；`[DRY-RUN] 以下仅为计划，不做任何变更`；`[UNIT] systemctl stop kore` / `[UNIT] systemctl disable kore` / `[UNIT] rm -f /etc/systemd/system/kore.service` / `[UNIT] systemctl daemon-reload`（unit 不存在时只有 `[UNIT] unit 不存在且未运行，跳过`）；`[USER] 命中 N 个账户：[…]`；`[PURGE] 未指定 --purge：状态目录保留（…）`；`[OK] uninstall 完成（可重复执行：幂等）` |
| 判据 | 预演 exit `0`；`/etc/systemd/system/kore.service` **仍然存在**（证明没真删） |
| 说明 | 真卸载会删 unit/服务，本包**不执行**；脚本打印 `[WOULD-RUN]` 与 `[NOT-EXECUTED]`，把决定权留给用户 |

## 4. `--dry-run` 完整输出（本机 2026-11-23 实跑，uid=1000、零变更）

```text
kore 系统级 root 服务 · 一次性验证包（ADR-0042 方案 B）
  安装根   : /home/pt/Work/GolandProjects/kore
  kored    : /home/pt/Work/GolandProjects/kore/bin/kored（默认推导）
  unit     : /etc/systemd/system/kore.service（ADR-0023 §3.5 豁免 #1）
  模式     : verify
  环境     : uid=1000 · systemd=systemd 259 (259.9-0ubuntu0.1)

===== STEP 1/6 · 安装系统级 root unit 并启动（User=root） =====
[DO]     bash /home/pt/Work/GolandProjects/kore/scripts/install-system-service.sh --install-root /home/pt/Work/GolandProjects/kore --bin /home/pt/Work/GolandProjects/kore/bin/kored --name kore
[EXPECT] exit 0；"[OK] 已写入 /etc/systemd/system/kore.service"
[EXPECT] 重复运行时 "[OK] unit 已是最新（幂等）"（不重写、不重启）
[DRY-RUN] 未执行（零变更）
[RESULT] PASS — 计划正确（dry-run 不验证真实行为）

===== STEP 2/6 · 核验运行身份：主进程属主必须是 root =====
[DO]     systemctl show -p MainPID --value kore
[DO]     ps -o user= -p <MainPID>；ps -o comm= -p <MainPID>；ps -eo user=,comm= | awk '$2=="kored"' | sort -u
[EXPECT] MainPID > 0、属主 root、comm kored，且没有非 root 的 kored 实例
[DRY-RUN] 未执行（零变更）
[RESULT] PASS — 计划正确（dry-run 不验证真实行为）

===== STEP 3/6 · 触发一次 root 动作，确认不走 polkit（manage-units 差值 = 0） =====
[DO]     journalctl -u polkit --since=-5min --no-pager | grep -c manage-units
[EXPECT] 触发前计数（通常是 0）
[ACTUAL] 0
[DO]     POST http://kore/api/v1/plugins/<plugin>/root-action（经 /home/pt/Work/GolandProjects/kore/run/kore.sock）
[EXPECT] HTTP 200、executed=true、unit 非空（kore-root-<plugin>-<action>-<rand8>）；exit_code 由动作本身决定
[EXPECT] 触发后再数 manage-units：期望 0（与触发前相比差值 0）
[DRY-RUN] 未执行（零变更）
[CHECK]  触发前的绝对计数已打印；真跑会打印差值
[RESULT] PASS — 计划正确（dry-run 不验证真实行为）

===== STEP 4/6 · 假安装根上跑 kored upgrade：.prev + upgrade-result pending → success =====
[DO]     在 /tmp/kore-verify-root.XXXXXX 下建假安装根（bin/ + data/），不碰真实二进制
[EXPECT] .prev 存在且内容 = 升级前 sha；upgrade-result.json 先 pending、--verify 后 success
[DO]     /home/pt/Work/GolandProjects/kore/bin/kored upgrade --bin <假>/new-kored --sha256 <新 sha> --target <假>/bin/kored --state-dir <假>/data --unit-name kore
[EXPECT] exit 0；"[OK] 已原子替换"、"[INFO] 已落 pending 标记"、"[OK] 已提交重启：systemctl --no-block restart kore"
[EXPECT] <假>/bin/kored.prev 存在；upgrade-result.json 的 state 从 pending 变 success
[DRY-RUN] 未执行（零变更）
[RESULT] PASS — 计划正确（dry-run 不验证真实行为）

===== STEP 5/6 · 假安装根上跑 kored upgrade --rollback：切回旧 sha，.prev 变新 sha =====
[DO]     找到本次 STEP 4 的假安装根（/tmp/kore-verify-root.*）里的 .prev 与标记
[EXPECT] 目标 sha 回到旧值；.prev 变成 STEP 4 的新 sha（可再次 --rollback 切回）
[DO]     /home/pt/Work/GolandProjects/kore/bin/kored upgrade --rollback --target <假>/bin/kored --state-dir <假>/data --no-restart
[EXPECT] exit 0；"[OK] 已回滚：…（替换前的二进制已存回 .prev，可再次 --rollback 切回）"
[EXPECT] 目标 sha = 升级前 sha；.prev sha = 升级后 sha；state = rollback-pending → --verify 后 success
[DRY-RUN] 未执行（零变更）
[RESULT] PASS — 计划正确（dry-run 不验证真实行为）

===== STEP 6/6 · 自卸载只预演（不执行）：kored uninstall --dry-run =====
[DO]     env KORE_HOME=/home/pt/Work/GolandProjects/kore /home/pt/Work/GolandProjects/kore/bin/kored uninstall --dry-run
[EXPECT] exit 0；"[DRY-RUN] 以下仅为计划，不做任何变更"；unit 清理计划与"状态目录保留"提示
[EXPECT] 输出含 "[DRY-RUN] 以下仅为计划，不做任何变更" 与 "[PURGE] 未指定 --purge：状态目录保留"
[DRY-RUN] 未执行（零变更）
[RESULT] PASS — 计划正确（dry-run 不验证真实行为）

[DRY-RUN] 计划完成：未安装 unit、未重启服务、未替换任何二进制、未删除任何文件。
[DRY-RUN] 真跑：sudo bash /home/pt/Work/GolandProjects/kore/scripts/verify-root-service.sh --yes
```

> 真跑时把路径换成你的安装根即可；上部 `环境` 行的 `uid` 会变成 `0`。

## 5. 回滚（把宿主恢复成「只有用户级实例」的形态）

```bash
# ① 先看回滚计划
sudo bash scripts/verify-root-service.sh --rollback --dry-run

# ② 停服务 + 删 unit + daemon-reload（幂等；unit 不在时打印「无需卸载」）
sudo bash scripts/verify-root-service.sh --rollback
```

回滚脚本做的事：调 `scripts/install-system-service.sh --remove`（`systemctl stop kore` → `rm -f /etc/systemd/system/kore.service` → `systemctl daemon-reload`），然后打印恢复用户级实例的命令。**用户级实例不会被自动拉起**——它属于原用户的会话，脚本不替你跨会话操作。

```bash
# ③ 在原用户的图形会话里（非 root）恢复原来的形态
systemctl --user daemon-reload
systemctl --user enable --now kored-local

# 或由 root 代跑（XDG_RUNTIME_DIR 必须是该用户的）
runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user enable --now kored-local

# ④ root 服务在安装根内写过 data/run/logs，属主交还原用户（按需）
chown -R <user>:<user> /opt/kore/data /opt/kore/run /opt/kore/logs
```

回滚后自查（与 ADR-0023 §3.6 同口径）：

```bash
test -e /etc/systemd/system/kore.service && echo "unit 仍在" || echo "unit 已删"
systemctl is-active kore || true                 # 期望 inactive / not-found
systemctl --user is-active kored-local           # 期望 active（恢复后）
ls -l /opt/kore/bin/kored*                       # 期望没有 .prev（本包不碰真实二进制）
```

`/tmp/kore-verify-root.*` 由脚本退出时自动清理；用了 `--keep-artifacts` 时按屏幕打印的路径手动删除（不要用通配符）。

## 6. 风险清单（逐条对应 ADR-0023 §3.5 豁免项）

| # | 资产 | 本包会不会写 | 豁免归属 | 可逆性 / 清理 |
| --- | --- | --- | --- | --- |
| 1 | `/etc/systemd/system/kore.service` + `multi-user.target.wants/` 软链 | **会**（STEP 1） | **§3.5 #1**（唯一被豁免的常规侵入） | 可逆：`--rollback`（stop → rm → daemon-reload） |
| 2 | `/etc/passwd`、`/etc/group` 的 `kore-<id>` 用户 | **不会**：本包不启用任何插件，root 内核降权不会 `useradd`；若你机器上已有（历史插件），保持原样 | **§3.5 #2** | 已有用户由 `kored uninstall` 按前缀 `userdel`；本包不新增 |
| 3 | 用户批准的宿主变更（nginx/ufw/crontab/DB…） | **默认不会**：STEP 3 只挑非 `irreversible` 动作且优先 `status`/`list`；但**动作本身可能写宿主**（例如某插件的非 irreversible 动作）——用 `--root-action-id` 固定一个只读动作可彻底避免 | **§3.5 #3**（须有 `data/changes.jsonl` 条目） | 若动作确实改了宿主：按该插件的 `changes.jsonl` 回滚；本包不代回滚 |
| 4 | `/usr/local/bin/kored` 等显式安装的二进制 | **不会**：只用 `--bin` 指向的现有 kored，不复制进系统目录 | **§3.5 #4** | 不适用 |
| — | `/tmp/kore-verify-root.*`（假安装根、`.prev`、`upgrade-result.json`） | **会**（STEP 4/5） | 不在豁免清单：临时目录，不属宿主资产 | 退出自动清理；`--keep-artifacts` 时按打印路径手动删 |
| — | 安装根内 `data/` `run/` `logs/` 的文件属主 | **会**（root 服务启动后） | 安装目录内，不属零侵入范围 | `chown -R <user>:<user>` 交还原用户（§5 ④） |
| — | 正在运行的 kore 服务 | **会重启一次**（STEP 4 的 `--no-block restart`） | — | 短暂中断；`MainPID` 变化是判据。若没回来：`systemctl restart kore`，仍失败看 `journalctl -u kore -n 100` |

**不可逆项**：本包**没有**真正的不可逆操作——不删服务、不删状态目录、不 `userdel`、不 `--purge`、不覆盖真实二进制、不主动写 `changes.jsonl`（若 STEP 3 的动作自身登记变更，按该插件的账本回滚）。唯一边界是 STEP 3 选到的动作自身可能写宿主（见上表 #3），用只读动作或指定 `--root-action-id` 可消除。

## 7. 无 root 环境无法预演的步骤（诚实边界）

| 步骤 | 本机（uid=1000、`NoNewPrivs=1`）能做什么 | 为什么不能真跑 |
| --- | --- | --- |
| STEP 1 | `--dry-run` 打印完整 unit 与计划（已验） | 需要写 `/etc/systemd/system` + `systemctl enable` |
| STEP 2 | 只能打印检查命令 | 需要服务真的以 root 起来 |
| STEP 3 | 已实跑只读计数（当前 `0`）；HTTP 触发未跑 | 需要 root 服务 + 登录会话 + 声明 root_actions 的插件 |
| STEP 4 | 只能 `bash -n` + `--dry-run` 验证参数解析与输出模板 | `kored upgrade` 对非 root 直接 `exit 6`（设计如此） |
| STEP 5 | 同上；CLI 的 `--rollback --dry-run` 已在本机用假 `.prev` 验过输出模板 | 替换需要 euid=0 |
| STEP 6 | **已实跑**：`kored uninstall --dry-run`（假 `KORE_HOME`）零变更、输出与 §3.6 一致 | 真卸载需要 root 且会删服务，本包明确不做 |

因此本机的结论只能是「脚本语法 + 计划 + 输出模板正确」，**不等于**链路已验证。真跑结果请贴回 ADR-0042 实施记录，并把「未实测项」逐条划掉。

## 8. 跑完之后（闭环动作）

1. 把 STEP 1–6 的 `[RESULT]` 与关键输出贴进 ADR-0042「实施记录」；
2. 若 STEP 3 的 `manage-units` 差值非 0，按 ADR-0042 复审条件 #4 重开 ADR（uid=0 的隐式放行语义变了）；
3. 若 STEP 1 报 `[BLOCKED] exit 4`，先停用户级实例再跑（脚本不代停）；
4. 若只想保留验证现场，用 `--keep-artifacts`，之后按打印路径删除 `/tmp/kore-verify-root.*`。
