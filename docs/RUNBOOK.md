> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M1

# RUNBOOK — 发布与回滚操作手册

## 0. 适用与四条铁律

只覆盖发布侧动作：索引重签、插件升级、新增插件、回滚。日常构建/启动见 [QUICKSTART.md](../QUICKSTART.md)，内核规格见 [CORE.md](./CORE.md)。

1. **公钥有两份副本，必须逐字相同**：`kore-plugins/scripts/validate-index.sh` 的 `PUB_HEX` 与 `internal/core/market/verify.go` 的 `IndexPublicKeyHex`。只改一处 = 校验器与内核各说各话。
2. **公钥是编译期常量**：换公钥必须 `make build` + 重启 kored。索引正文每请求重读磁盘（`readTrusted`），公钥只在进程启动时进内存——旧进程永远用旧公钥。
3. **验签失败一律 401，不降级**：`readTrusted` 是列表/详情/预设/安装的唯一信任门，失败返回 `E_UNAUTHORIZED`（401），无旁路。
4. **`paths.index_dir` 必须直接指向 `kore-plugins/index`**：不要把它复制到 `.kore-local-state/` 等 state 目录做"快照"——索引每请求重读（`market.Load` → `readTrusted`），副本只会让商店版本停在复制那一刻（2026-11-23 曾因指向 `signed-index` 快照，把 discover 0.2.0 显示成 0.1.0）。

## 1. 索引重签后的发布流程（换密钥 / 重签后必须全走）

### 步骤 1 — 生成新密钥对 → 更新两处公钥（逐字相同）

```bash
openssl genpkey -algorithm ed25519 -out /tmp/kore-index-priv.pem
openssl pkey -in /tmp/kore-index-priv.pem -outform DER -out /tmp/kore-index.der
KORE_INDEX_KEY=$(tail -c 32 /tmp/kore-index.der | xxd -p -c 64)   # 私钥 seed，64 位 hex
NEW_KEY=$(openssl pkey -in /tmp/kore-index-priv.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64)
sed -i "s/^PUB_HEX=.*/PUB_HEX=\"$NEW_KEY\"/" ../kore-plugins/scripts/validate-index.sh
sed -i "s/^const IndexPublicKeyHex = \".*\"/const IndexPublicKeyHex = \"$NEW_KEY\"/" internal/core/market/verify.go
```

判据：两条 grep 输出**逐字相同**，均为 64 位小写 hex（禁止手抄、禁止只改一处）。

```bash
grep -oE 'PUB_HEX="[0-9a-f]{64}"' ../kore-plugins/scripts/validate-index.sh
grep -oE 'IndexPublicKeyHex = "[0-9a-f]{64}"' internal/core/market/verify.go
```

### 步骤 2 — 重签 plugins.json.sig

```bash
cd ../kore-plugins
KORE_INDEX_KEY=<步骤 1 的 64 位 hex> bash scripts/sign-index.sh
sha256sum index/plugins.json index/plugins.json.sig | tee /tmp/index-sha.txt
```

判据：输出 `[OK] 已签名`、退出码 0；两个 sha 落到 `/tmp/index-sha.txt`（步骤 3 与回滚比对用）。

### 步骤 3 — 正向 exit 0 + 反例 FAILed

```bash
bash scripts/validate-index.sh; echo "正向 exit=$?"        # 判据：exit=0
cp index/plugins.json /tmp/plugins.json.bak
printf '\n' >> index/plugins.json                          # 正文变一字节，签名失配
bash scripts/validate-index.sh; echo "反例 exit=$?"        # 判据：非 0 且含 [FAIL]
cp /tmp/plugins.json.bak index/plugins.json
sha256sum -c /tmp/index-sha.txt                            # 判据：两行 OK
```

### 步骤 4 — make build（新公钥编入二进制）

`cd ../kore && make build`：判据退出码 0、`bin/kored` 的 mtime 更新。

### 步骤 5 — 关键闸门：新公钥确实进了二进制

```bash
NEW_KEY=$(grep -oE 'IndexPublicKeyHex = "[0-9a-f]{64}"' internal/core/market/verify.go | grep -oE '[0-9a-f]{64}')
strings bin/kored | grep -c "${NEW_KEY:0:8}"    # 判据：≥ 1
```

`0` 就停在这里：说明 build 用的还是旧源码或旧产物，别往下走。

### 步骤 6 — 重启 kored（**仅公钥变更时需要**；ADR-0025 后常规重签不再重启）

> **先判：这一把改没改公钥？**
> - **重签不改公钥**（ADR-0025 方案 A：长期密钥固定，只改 `index/plugins.json` 正文 + `.sig`）→ **不需要 `make build`、不需要重启**。索引每请求重读磁盘（`readTrusted`），重启只会无谓打断插件与在跑任务。
> - **公钥变更**（轮换密钥，`verify.go:IndexPublicKeyHex` 变了）→ **必须** `make build` + 重启：旧进程内存里是旧公钥，不重启则商店全部 401。
>
> 自第 41 把起默认走「不改公钥」，因此**常规发布不再有重启步骤**；长期密钥的备份与轮换见 [SIGNING-KEY-SOP.md](./SIGNING-KEY-SOP.md)。

```bash
systemctl restart kore && systemctl is-active kore            # 生产：判据 active

# 本地（开发机）：必须用独立 systemd user unit，禁止 setsid/nohup 后台启动
# 首次创建 unit（4 个 KORE_* 在 kill 旧进程前从 /proc/<pid>/environ 取；缺失会导致
# SSL / 日志 / 备份页读不到数据，且启动后无法补）
P=$(ss -ltnp '( sport = :8787 )' | grep -o 'pid=[0-9]*' | cut -d= -f2)
eval "$(python3 - "$P" <<'PY'
import sys,shlex
want=['KORE_SSL_CERT_DIR','KORE_LOGS_SOURCES','KORE_BACKUP_DIR','KORE_BACKUP_ALLOW_ROOTS']
env=dict(it.decode().split('=',1) for it in open(f'/proc/{sys.argv[1]}/environ','rb').read().split(b'\0') if b'=' in it)
for k in want: print(f'export {k}={shlex.quote(env[k])}')
PY
)"
kill -TERM "$P"
systemd-run --user --unit=kored-local --collect \
  --working-directory="$PWD" \
  --setenv=KORE_SSL_CERT_DIR="$KORE_SSL_CERT_DIR" \
  --setenv=KORE_LOGS_SOURCES="$KORE_LOGS_SOURCES" \
  --setenv=KORE_BACKUP_DIR="$KORE_BACKUP_DIR" \
  --setenv=KORE_BACKUP_ALLOW_ROOTS="$KORE_BACKUP_ALLOW_ROOTS" \
  "$PWD/bin/kored" serve --config "$PWD/.kore-local.yaml"

# 之后重启直接复用 unit（env 已固化在 unit 里）
systemctl --user restart kored-local && systemctl --user is-active kored-local
```

判据：PID 变化 + 启动日志出现 `kore ready`；`cat /proc/$(systemctl --user show kored-local -p MainPID --value)/cgroup` **不得含 `dsh-subprocess`**（见下）。**仅当公钥变更时**这步才省不掉。

> **禁止 `setsid nohup ./bin/kored serve … &`（2026-11-23 18:13 事故）**：`setsid`/`nohup` 只改会话与控制终端，**不脱离 cgroup v2**。在 agent 工具调用里这样启的 kored 仍留在该调用的 transient scope（`dsh-subprocess-*.scope`）里，调用收尾/超时被清理时整 scope 收到 SIGTERM，kored 与全部插件一起被杀——日志只有「插件进程意外退出 signal: terminated」，没有正常关闭记录。`systemd-run --user --unit=kored-local` 让 kored 落在自己的 unit cgroup，才算真正脱离。

### 步骤 7 — 验证 GET /api/v1/store/plugins == 200 且条数正确

```bash
J=/tmp/kore.jar
curl -sS -c $J -H 'Content-Type: application/json' -d '{"password":"<管理员口令>"}' \
  http://127.0.0.1:8787/api/v1/auth/login
curl -sS -b $J -o /tmp/store.json -w 'code=%{http_code}\n' http://127.0.0.1:8787/api/v1/store/plugins
python3 -c 'import json;print("count=",len(json.load(open("/tmp/store.json"))["plugins"]))'
```

判据：`code=200`，且 count 等于 `../kore-plugins/index/plugins.json` 的 `plugins` 长度。

### 跳过第 5 / 6 步的后果（仅公钥变更时）

改了公钥却没 rebuild/重启：旧二进制或旧进程仍是旧公钥 → 新签名验不过 → `E_UNAUTHORIZED` → 商店**全部请求 401**（列表、详情、预设、安装/更新/下载共用同一道门）。表象是"登录正常、商店整页空且 401"，且**不会自愈**：索引每请求重读，公钥只在进程启动时载入。

## 2. 插件升级发布流程（bump → dist → release → 索引 → 重签 → 重启 → 端到端安装）

规则细节见 [RELEASE.md](./RELEASE.md)，本节只列不可跳的动作。

1. **先 bump 再打包**：`info.json` + `manifest.json` 版本同步 +1，`CHANGELOG.md` 顶部加条目；任何改变 dist sha 的改动都必须 bump，同 `id@version` 不允许两个 sha。
2. 插件仓 `make dist` 出 `dist/<id>-<version>.tar.gz`，记 `sha256sum`；同树重打 + `git archive HEAD` 干净树重打，两次 sha 必须一致。
3. 建 release（tag `v<version>`）挂包，`download_url` 指向它；禁止覆盖同版本 release 资产。
4. 改 `kore-plugins/index/plugins.json` 的 `version` / `size_bytes` / `sha256` / `download_url`；把新版本追加到 `index/versions.lock.json`；同步 `presets/*.json` 固定版本。
5. 重签 + 校验（§1 步骤 2–3，判据 exit 0 且反例 FAILed）→ 重启 kored（§1 步骤 6）；只改正文不换密钥时进程本会重读，但仍按重启执行。
6. 端到端：`POST /api/v1/store/install`（`download=true` + `id`/`version`）→ 判据 200、插件 `installed`、`GET /api/v1/plugins` 版本号等于新版本。

## 3. 新增插件入索引流程（建 release → 加索引条目 → 重签 → 重启）

1. 新插件仓先过三件套：`info.json` / `Makefile` 的 `dist` 目标 / `CHANGELOG.md`（G-17），`make dist` 出包记 sha256。
2. 建 release 挂包，得到 `download_url`。
3. `index/plugins.json` 的 `plugins[]` 追加条目，12 个必填字段一个不能少：`id` / `name` / `version` / `depth_level` / `lifecycle` / `size_bytes` / `sha256` / `download_url` / `requires_kore` / `depends_on` / `conflicts` / `scenario_tags`。
4. 重签 + 校验（§1 步骤 2–3）→ 重启（§1 步骤 6）→ 跑 §1 步骤 7（判据 200 且 count +1）；再按 §2 第 5 步实装一次，确认新条目能装。

## 4. 回滚流程（旧索引 + 旧二进制，公钥必须一起回滚）

索引与二进制是**配对发布物**：索引由某把私钥签，二进制内置对应公钥，必须成对回滚。

1. 取回已知good的成对文件（同一提交，别混版本）：
   ```bash
   git -C ../kore-plugins show <good-commit>:index/plugins.json     > ../kore-plugins/index/plugins.json
   git -C ../kore-plugins show <good-commit>:index/plugins.json.sig > ../kore-plugins/index/plugins.json.sig
   ```
2. 验签 `cd ../kore-plugins && bash scripts/validate-index.sh`（判据 exit 0）；取回同期 `verify.go` 后重建：`git show <good-commit>:internal/core/market/verify.go > internal/core/market/verify.go && make build`。
3. 跑 §1 步骤 5 闸门，判据 `strings bin/kored | grep -c '<该版本公钥前 8 位>'` ≥ 1。
4. 重启 kored → 跑 §1 步骤 7，判据 200 且条数正确。

只回滚索引不回滚二进制：旧二进制用**新**公钥验**旧**签名 → 401；只回滚二进制不回滚索引：旧公钥验**新**签名 → 401。两种错法表象相同，"一起回滚"是流程不是建议。

## 5. 以 root 启动 kored 与提权通道（ADR-0018）

需要宿主 root 的插件（firewall / site / waf / dns / runtime-* / 跨用户目录的 backup）**不以 root 运行**：`kored` 以 root 启动、插件由内核拉起；需要 root 的动作只能经内核 `root_actions` 代理执行。**kored 非 root 时通道整体返回 `E_NEED_ROOT`**（不会静默降级），无 systemd 的环境返回 `E_NO_SYSTEMD`。

### 5.1 systemd unit 示例（`/etc/systemd/system/kore.service`）

```ini
# /etc/systemd/system/kore.service — 与 scripts/install-system-service.sh 的 render_unit() 一致
# 等价于 `bash scripts/install-system-service.sh --dry-run --install-root /opt/kore` 打印的内容
# 手工改动会在下次安装时被覆盖；卸载：sudo bash scripts/install-system-service.sh --remove
[Unit]
Description=kore 内核（kored，root 服务；特权动作零交互）
Documentation=file:///opt/kore/docs/ARCHITECTURE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
NoNewPrivileges=false
Environment=KORE_HOME=/opt/kore
ExecStart=/opt/kore/bin/kored serve
Restart=on-failure
RestartSec=2
TimeoutStopSec=15
TimeoutStartSec=30
KillMode=mixed
Delegate=yes
LimitNOFILE=65536
UMask=0022

[Install]
WantedBy=multi-user.target
```

**为什么没有 `RuntimeDirectory=` / `StateDirectory=` / `LogsDirectory=`**：v1.0 之前的示例曾列这三项，它们会写 `/run/kore`、`/var/lib/kore`、`/var/log/kore`——这三个路径被 ADR-0023 §3.5 逐字列为「清单外一切写入 = 违规」，G-31 之下本安装形态的安装目录外写入只有 `kore.service` + enable 软链（豁免 #1）。状态 / socket / 日志因此全部留在 `KORE_HOME`（默认 `/opt/kore`）内，stdout/stderr 由 journald 收集。**如需这三个目录，必须按 ADR-0023 §3.5 #3 登记为「用户批准的宿主变更」**（写 `<install>/data/changes.jsonl`、可回滚）后才允许加，不得直接塞回 unit。

```bash
make build
# 默认安装形态：脚本一次性写 unit + enable（幂等；--dry-run 只预览、零变更）
sudo bash scripts/install-system-service.sh --install-root /opt/kore
systemctl is-active kore                 # 判据：active
systemctl show -p User --value kore      # 判据：root
ps -o user= -C kored                     # 判据：root
```

一次性真机验证包：`sudo bash scripts/verify-root-service.sh --yes`（六步：装 root unit → 身份 → polkit 零判定 → 假安装根上升级/回滚 → 自卸载只预演）。期望输出、回滚与风险清单见 [VERIFY-ROOT.md](./VERIFY-ROOT.md)。

**为什么必须 root**：`systemd-run --uid=0` 由非 root 调用会走 polkit 交互认证；本机实测 `--no-ask-password` 被拒。以 root 启动 kored 后，transient unit 由已授权的 systemd 直接拉起，**uid=0 不进入 polkit 判定、`systemd-run --uid=0` 没有 authorization check**，所以运行期不需要任何交互（ADR-0042 方案 B；对照降级路径 A，每次操作仍过一次判定、只是规则返回 YES 不弹框）。

### 5.2 通道验证（root 环境）

```bash
J=/tmp/kore.jar; S=/opt/kore/run/kore.sock   # portable：socket 在 KORE_HOME 内（unit 不含 RuntimeDirectory=）
curl -sS --unix-socket $S -c $J -H 'Content-Type: application/json' \
  -d '{"password":"<管理员口令>"}' http://kore/api/v1/auth/login
# 1) 看插件声明了哪些动作（requires_root / root_actions 随插件视图返回）
curl -sS --unix-socket $S -b $J http://kore/api/v1/plugins/firewall | python3 -m json.tool
# 2) 只读动作：直接执行
curl -sS --unix-socket $S -b $J -H 'Content-Type: application/json' \
  -d '{"action_id":"ufw-status"}' http://kore/api/v1/plugins/firewall/root-action
# 3) 不可回滚动作：先签发一次性令牌（5 分钟、绑定 plugin+action），再带 confirm 执行
TOKEN=$(curl -sS --unix-socket $S -b $J \
  http://kore/api/v1/plugins/firewall/root-action/ufw-allow/confirm-token | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -sS --unix-socket $S -b $J -H 'Content-Type: application/json' \
  -d "{\"action_id\":\"ufw-allow\",\"args\":[\"22/tcp\"],\"confirm\":\"$TOKEN\"}" \
  http://kore/api/v1/plugins/firewall/root-action
# 4) 审计：每次提权（含拒绝）都有 root.action
curl -sS --unix-socket $S -b $J 'http://kore/api/v1/audit?action=root.action&limit=10' | python3 -m json.tool
```

响应字段：`{executed, exit_code, stdout, stderr, dur_ms, unit}`；`exit_code` 取 `systemd-run --wait` 的退出码。

### 5.3 非 root / 无 systemd 的表现与处置

| 场景 | 返回 | 处置 |
| --- | --- | --- |
| kored 非 root | `403 E_NEED_ROOT` + `hint` | 按 §5.1 以 root 启动；不要用 sudo 包装单次请求 |
| 无 systemd（Alpine / 精简容器） | `501 E_NO_SYSTEMD` + `hint` | 换支持 systemd 的环境；或由运维手写 sudoers 片段（kore 不自动改 sudoers，必须 `visudo -c` 校验） |
| polkit / systemd 拒绝 | `502 E_UPSTREAM` + systemd-run 错误原文 | 查 `journalctl -u kore` 与 `systemctl status kore-root-*` |

**不要**把 `E_NEED_ROOT` 当成参数错误重试；也不要绕过内核直接给插件 `sudo` / setuid / root —— 那会破坏 ADR-0018 的威胁模型。


## 6–7. 安装 / 卸载 / 升级 / 口令与配置（已拆出）

安装、卸载、升级、门禁验证、口令重置与配置路径排查共 319 行，按主题拆到独立文件，避免单文件超长：

- **[RUNBOOK-INSTALL.md](RUNBOOK-INSTALL.md)** — §6 安装 / 卸载（零侵入 profile，ADR-0023）· §7 重置管理员口令与配置路径
- 零侵入判据一句话：**删掉安装目录即等于卸载**；安装目录外只允许 ADR-0023 §3.5 的 4 项豁免
- 需要执行升级 / 卸载 / 改口令时，直接跳 [RUNBOOK-INSTALL.md](RUNBOOK-INSTALL.md)，本节不保留副本（单一真源，避免两处漂移）
