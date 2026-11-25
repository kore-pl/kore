> 状态: draft · 归属: architect · 更新: 2026-11-24 · 里程碑: M1

# RUNBOOK-INSTALL — 安装 / 卸载 / 升级 / 口令与配置

本文件原为 `RUNBOOK.md` 的 §6（安装 / 卸载，零侵入 profile）与 §7（重置管理员口令 / 配置路径排查），因单文件超过文档门禁 400 行上限按主题拆出。**内容逐字保留、未删改**，节号沿用 §6 / §7，既有「RUNBOOK §6.x」引用仍可定位到本节号。

- 发布与回滚（索引重签 / 插件升级 / 入索引 / 回滚 / root 提权）：[RUNBOOK.md](RUNBOOK.md)
- 零侵入安装契约：[ADR-0023](DECISIONS/0023-zero-intrusion.md)

**部署链一条线**：装（§6.1）→ 起（§6.1 / §5）→ 升级（§6.5）→ 卸载（§6.2）→ 口令与配置（§7）。

## 6. 安装 / 卸载（零侵入 profile，ADR-0023）

判据：**删掉安装目录即等于卸载**。`portable`（默认）下 Kore 的全部状态都在 `<install>` 内；安装目录外只允许 ADR-0023 §3.5 的 4 项豁免。

### 6.1 portable 安装（默认，推荐）

```bash
# 1) 解压即用：<install> 自包含，二进制在 <install>/bin/kored
tar -xzf kored-linux-amd64.tar.gz -C /opt/kore
install -d /opt/kore/bin && install -m 0755 kored /opt/kore/bin/kored

# 2) 前台试跑：不写任何系统路径（/etc/kore、/var/lib/kore、/run/kore、/var/log/kore 都不会出现）
/opt/kore/bin/kored serve
#    ├─ 配置：/opt/kore/config/config.yaml（可选；缺失走内置默认 + WARN）
#    ├─ 状态：/opt/kore/data（state.db / plugins / index）
#    ├─ socket：/opt/kore/run/kore.sock
#    └─ 日志：/opt/kore/logs

# 3) 需要开机自启时才装 unit（唯一常规豁免，ADR-0023 §3.5 #1）
sudo tee /etc/systemd/system/kore.service >/dev/null <<'UNIT'
[Unit]
Description=kore thin kernel
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/opt/kore/bin/kored serve
Restart=on-failure
RestartSec=2
TimeoutStopSec=15
KillMode=mixed
Delegate=yes
LimitNOFILE=65536
RuntimeDirectory=kore
RuntimeDirectoryMode=0700
TimeoutStartSec=30
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now kore
```

安装目录换位置时用 `KORE_HOME` 显式指定（服务脚本里写 `Environment=KORE_HOME=/opt/kore` 最稳）；若二进制被装进 `/usr/local/bin` 等系统目录，内核会**自动退回 `fhs` profile 并打 WARN**——那是发行版打包形态，不是默认形态。

### 6.1.1 离线安装插件（需先停服务）

`kored install --package` 与 `kored serve` **独占同一个 `state.db`**：服务在跑时执行 CLI 安装会撞文件锁，报
`store: 状态库已被占用: <state>/state.db（持有者 pid=<pid>）`，退出码 3。新版本会在这条错误后直接给出下一步（原 pid 保留）：

```text
提示: Kore 服务正在运行并独占 state.db，安装插件前请先停止服务：
  systemctl --user stop kored-local       # 用户级实例（portable，bin/kored serve）
  sudo systemctl stop kore                # 系统级实例（fhs，/etc/systemd/system/kore.service）
安装完成后再启动：systemctl --user start kored-local / sudo systemctl start kore
若你用的是商店页面安装（POST /api/v1/store/install），服务无需停止，可直接安装。
```

照做即可（以 portable 用户级实例为例）：

```bash
systemctl --user stop kored-local            # 先停：释放 state.db 锁
/opt/kore/bin/kored install --package site-0.1.0.tar.gz   # 判据：输出 installed site 0.1.0、退出码 0
systemctl --user start kored-local           # 装完再启动
curl -s localhost:8787/api/v1/system/info | grep -o '"version":"[^"]*"'   # 复核服务已起
```

**不要**为了绕锁去改 `--state-dir` 指向主实例的另一个路径——那只会在别处新建一个空状态库，装出来的插件主实例看不见。装插件只有两条路：停服务走 CLI（离线包），或服务在跑时走商店页面 / API（在线安装）。

判据：停服务后 CLI 安装退出码 0；`systemctl --user status kored-local` 显示 active (running) 且商店能看到新插件。

### 6.1.2 root 安装器与受控写白名单（`KORE_FILE_WRITE_ALLOW_DIRS`）

装完 root 服务后，`site` 插件写 vhost 走**受控文件写**（[ADR-0052](DECISIONS/0052-nginx-vhost-controlled-write.md)），其中 `ssl_certificate` / `ssl_certificate_key` / `auth_basic_user_file` 的路径必须落在**证书/口令目录白名单**内。该白名单**缺省为空 = 一律拒绝**（fail-closed，内核不猜安装布局），因此安装脚本必须把它写进 unit：

```bash
# 默认安装（unit 自动注入 Environment=KORE_FILE_WRITE_ALLOW_DIRS=<install>/data/ssl/）
sudo scripts/install-root-once.sh --bin ./bin/kored

# 先看计划（零变更；必须能在这行看到注入值）
scripts/install-root-once.sh --dry-run --bin ./bin/kored
#    Environment=KORE_HOME=/opt/kore
#    Environment=KORE_FILE_WRITE_ALLOW_DIRS=/opt/kore/data/ssl/

# 证书实际落在别处时显式覆盖（值原样写入，不再追加默认值）
sudo scripts/install-root-once.sh --bin ./bin/kored   --file-write-allow-dirs=/srv/kore/certs/:/srv/kore/auth/
# 等价：安装前导出现场变量（sudo 需 -E 或写进 root 环境）
KORE_FILE_WRITE_ALLOW_DIRS=/srv/kore/certs/ sudo -E scripts/install-root-once.sh --bin ./bin/kored
```

| 项 | 规则 |
| --- | --- |
| 格式 | 路径列表，分隔符是**内核同款** `os.PathListSeparator`（Linux 为 `:`，Windows 为 `;`）；每条必须绝对、不得含 `..` 段与空白/引号/反斜杠，非法值安装器直接拒绝（不写"看着有、实际全被丢弃"的 unit） |
| 默认值 | `<install>/data/ssl/`（ADR-0023 §3 的证书默认位置） |
| 覆盖 | `--file-write-allow-dirs=LIST` 或环境变量 `KORE_FILE_WRITE_ALLOW_DIRS`；显式值优先，**不追加默认值**（避免把不该放行的目录带进去） |
| 幂等 | unit 由 `render_unit()` 确定性渲染后与现文件逐字节比较，相同即跳过——重复安装不会重复加 `Environment=` 行 |
| 手工改 unit | 会被识别为漂移、备份后覆盖（脚本头部已声明）。要长期改白名单请用上面的 flag/env，不要手改 unit |
| 不需要注入 | `/etc/nginx/conf.d/` 由**协议类别**派生（`pluginapi.FileWritePrefixClasses` 是唯一真源），重复注入只是冗余 |
| 缺注入的后果 | **不是少一个可选配置**：任何带证书/口令的 vhost 都会被受控写校验拒绝，装完启用 SSL 的站点全部失败。`sudo scripts/install-root-once.sh --verify` 的 S12 项专门守这条 |

**其它插件配置变量要不要进 unit（逐个核实，结论：不需要）**：

| 变量 | 结论 | 依据 |
| --- | --- | --- |
| `KORE_SSL_CERT_DIR` | **不进 unit**（但需与白名单保持一致） | `ssl` 插件自行解析：`KORE_SSL_CERT_DIR` > `<KORE_STATE_DIR>/ssl` > 可执行文件旁 `data/ssl`；不设也能工作，设了反而要同步改白名单 |
| `KORE_LOGS_SOURCES` | 不进 unit | 插件配置优先级 `config.json` > 环境变量 > 默认值，且界面保存后立即生效（[PLUGIN-CONFIG](PLUGIN-CONFIG.md)）；写进 unit 会与界面保存的文件配置打架 |
| `KORE_BACKUP_DIR` / `KORE_BACKUP_ALLOW_ROOTS` | 不进 unit | 同上，`backup` 插件走 `config.json` + 界面配置，改完 `restart_required=false` |
| `KORE_STATE_DIR` / `KORE_HOME` | `KORE_HOME` **要进**（unit 已注入） | 安装根决定 portable 布局；`KORE_STATE_DIR` 未设时由 profile 派生为 `<install>/data`，不需要额外钉死 |

> **跨仓缺口：已修（`kore-plugin-ssl` v0.7.1）**。历史缺陷：`ssl` 插件默认证书目录曾是 `<KORE_STATE_DIR>/ssl`，而内核注入的 `KORE_STATE_DIR` 是 `<install>/data/plugins/<id>`，实际落点 `<install>/data/plugins/ssl/ssl`——与安装器默认注入的 `<install>/data/ssl/` 不一致，SSL 站点写配置时被受控写全部拒绝。现在解析顺序为 `KORE_SSL_CERT_DIR` > **`<KORE_INSTALL_DIR>/data/ssl`**（ADR-0023 §3.4 方案 C / ADR-0052 §104，与本脚本 `resolve_allow_dirs` 的默认值逐字一致）> `<KORE_STATE_DIR>/ssl`（仅内核未注入安装根时兜底）> 可执行文件旁 `data/ssl`。判据（可执行，见 `kore-plugin-ssl/internal/certs/certdir_whitelist_test.go`）：`ssl` status 的 `cert_dir` == unit 注入的白名单前缀去掉尾斜杠，且 `ssl` 返回的 `cert_path`/`key_path` 落在该前缀内。**运维无需改 unit**；显式设过 `KORE_SSL_CERT_DIR` 的部署行为不变。

### 6.2 卸载（卸载链，ADR-0023 阶段 B）

```bash
# 先看计划（安全阀：零变更；非 root 也能跑）
kored uninstall --dry-run

# 执行：stop → disable → rm unit → daemon-reload → 按 kore- 前缀 userdel
#      → 打印 <state>/changes.jsonl 清单（默认不回滚）→ 提示手工步骤
sudo kored uninstall --yes

# 连状态目录一起删，并执行账本里 reversible=true 的结构化 purge_op
sudo kored uninstall --yes --purge
```

| 参数 | 作用 |
| --- | --- |
| `--dry-run` | 只打印计划：命中的 unit / 账户 / 账本条目 / 将删的状态目录 |
| `--yes` | 非交互确认；**无 TTY 且无它 → 零变更、退出码 2** |
| `--purge` | 删状态目录 + 执行账本里可回滚的 `purge_op`（结构化操作，不执行 shell 字符串） |
| `--config` | 配置文件路径（缺省按 profile 解析） |
| `--state-dir` | 状态目录（覆盖配置） |
| `--keep-service` / `--keep-users` | 保留 unit / 保留 `kore-*` 用户（只清另一项） |
| `--unit-dir` / `--unit-name` / `--user-prefix` | 覆盖探测位置（默认 `/etc/systemd/system` / `kore.service` / `kore-`） |

**行为约定**：
- `userdel` 按 `/etc/passwd` 前缀扫描，**不依赖 state**（用户可能先删了 state）；删除前用与建用户相同的正则再校验，`-r` 只删 home（插件 home 是 `/nonexistent`）；"does not exist" 视为成功；
- 非 root 且要清理 unit/用户 → **部分完成 + 退出码 6**（详见 6.2.1，绝不返回 0）；
- 幂等：unit / 用户 / 账本 / state 缺失都按"已清理"处理；
- `--purge` 只执行白名单 `purge_op`（`file.remove` / `file.restore`），**绝不 `sh -c`**；
- `make uninstall` 等价 `kored uninstall`（`make uninstall ARGS="--dry-run"` 先看计划）。

手工兜底（卸载命令不可用时）：

```bash
sudo systemctl disable --now kore 2>/dev/null || true
sudo rm -f /etc/systemd/system/kore.service && sudo systemctl daemon-reload
sudo getent passwd | awk -F: '$1 ~ /^kore-/ {print $1}' | xargs -r -n1 sudo userdel
rm -rf /opt/kore
# 断言（应全部无输出）
! test -e /etc/kore && ! test -e /var/lib/kore && ! pgrep -x kored && ! ss -lx | grep -q kore
```

**本地更新状态文件的回滚（ADR-0023 §3.5 豁免 #5 / §11）**：

静默更新链会在 `<state>/update-state.json`（portable 即 `<install>/data/update-state.json`）留下跨重启的状态元数据；每次创建或覆写前都先向 `<state>/changes.jsonl` 追加一条 `purge_op=file.remove` 的结构化账本记录（`summary` = 「更新状态记录」）。该文件只含版本 / 阶段 / 校验值等状态元数据，**不含任何口令 / token / 凭据**。

- `kored uninstall --yes --purge`：与其余宿主变更一起，从账本读取 `file.remove` 白名单操作逐条删除该文件（不执行 shell 字符串，重复执行幂等）；
- 手工回滚（卸载命令不可用、或只想清这一项）：

```bash
STATE_FILE="<install>/data/update-state.json"   # 按实际安装根替换
rm -f "$STATE_FILE"
grep -v '"action":"selfupdate.state.write"' <install>/data/changes.jsonl > /tmp/kore-ledger.new \
  && mv /tmp/kore-ledger.new <install>/data/changes.jsonl && chmod 600 <install>/data/changes.jsonl
# 断言状态文件已消失、账本无幽灵条目
! test -e "$STATE_FILE" && ! grep -q 'update-state.json' <install>/data/changes.jsonl
```

> 手工清理只删该文件及其账本行，**不动**其他 `changes.jsonl` 条目（nginx / 防火墙等用户批准的宿主变更需单独裁决是否回滚）。全系统仅此一个状态文件，禁止在 `/etc`、`/var/lib`、`/var/log`、`/run` 下创建同类文件。门禁：`make zero-intrusion-check`（隔离实例验证 0600 / 账本登记 / 回滚删除）。

### 6.2.1 卸载的部分完成与退出码

卸载链把动作分成两段：**安装目录内（本地）**与**宿主侧（systemd unit / `kore-*` 用户）**。两段的权限要求不同，退出码必须能区分"真完成"和"只做了一半"。

| 场景 | 行为 | 退出码 |
| --- | --- | --- |
| `sudo kored uninstall --yes [--purge]` | 全链执行 | `0` |
| `--yes --keep-service --keep-users`（任意身份） | 只清安装目录/状态，宿主侧声明自己处理 | `0` |
| 非 root、未给两个 `--keep-*` | **部分完成**：本地该清的照清（`--purge` 也会真的执行），宿主侧跳过，打印摘要 | `6`（环境/权限不足） |
| 非 root、无 `--yes`（非 TTY） | 零变更，提示加 `--yes` | `2` |
| 有步骤失败 | 打印 `[FAIL]` 并汇总 | `1` |
| `--dry-run` | 只打印计划，零变更；输出随 profile 变化 | `0` |

部分完成时 stdout 末尾固定有这段摘要（脚本可据此判断）：

```text
[摘要] 卸载部分完成：宿主侧（systemd unit / kore-* 用户）因权限跳过，本次未全部完成
  已做：systemd unit 已清理、状态目录已删除：/opt/kore/data
  因权限跳过：systemd unit 清理（/etc/systemd/system/kore.service）、kore-* 用户清理（前缀 kore-）
  怎么补做（拿到 root 后重跑，幂等）：sudo kored uninstall --yes --purge
  只想清安装目录、宿主侧自己处理：kored uninstall --yes --keep-service --keep-users（该写法返回 0）
退出码 6 = 环境不满足（权限不足），脚本/CI 不得当作成功
```

两条使用纪律：

1. **脚本 / CI 只看退出码**：`kore uninstall && rm -rf ...` 这种写法在非 root 下会因退出码 6 短路——这是有意的（旧版本在这里返回 0，导致 `data/` 原样保留却报成功）。
2. **portable 默认不创建宿主侧对象**（ADR-0023），但 `uninstall` 的默认语义仍是"完整卸载"：想让它以"只清安装目录"的口径返回 0，必须**显式**加 `--keep-service --keep-users`——把"我知道宿主侧有残留、我自己处理"写进命令，而不是让工具猜。

`--dry-run` 会先读当前 profile 再决定展示什么：`portable` 打印「（portable 模式：不会创建 systemd unit，也不创建 kore-* 用户）」，不列 `/etc/systemd/system/...`；`fhs` 才列真实 unit 路径与账户前缀（`KORE_PROFILE=fhs kored uninstall --dry-run` 可先看 fhs 计划）。

### 6.3 从旧（fhs）布局迁移

```bash
# 只提示、不自动迁移（ADR-0023 §3.1）：旧配置/旧状态存在而新路径为空时，启动日志会打 WARN
# 方式 A：继续用旧路径（非零侵入，兼容）
KORE_PROFILE=fhs /opt/kore/bin/kored serve
# 方式 B：迁到 portable（先停服务）
sudo systemctl stop kore
install -d /opt/kore/data /opt/kore/config
sudo cp -a /var/lib/kore/. /opt/kore/data/
sudo cp -a /etc/kore/config.yaml /opt/kore/config/config.yaml 2>/dev/null || true
/opt/kore/bin/kored serve     # 校验 /api/v1/system/info 的 paths 指向 /opt/kore/*
```

### 6.4 门禁

`make zero-intrusion-check`：在 `/tmp` 建隔离安装根、编译 `<install>/bin/kored`、**不设** `KORE_HOME`/`--config` 起实例，断言 `portable` 目录与 socket 全在安装目录内、系统路径零新增、未新建 `kore-*` 用户/unit（既有用户与 unit 单列为豁免项）。该段同时是 `make check` 的第 11/12 段。

### 6.5 升级与卸载为什么不需要 sudo（一次性安装边界）

**一句话**：sudo 只用在**安装那一次**——写 unit + 建 root 身份。之后内核自己就是 root，替换自己的二进制、重启/删除自己的 unit 都是它自己的文件，用户不需要第二次提权。

| 动作 | 需要用户 sudo？ | 由谁做 | 判据 |
| --- | --- | --- | --- |
| 首次安装（写 unit / enable） | **是，仅此一次** | 用户（人工） | `/etc/systemd/system/kore.service` 存在 + `systemctl is-enabled kore` = enabled |
| 升级内核二进制 | 否 | root 服务自己 `kored upgrade` | `kored upgrade --verify` 输出 success |
| 回滚内核二进制 | 否 | root 服务自己 `kored upgrade --rollback` | 目标 sha256 回到 `.prev` |
| 卸载（停 unit / 删 unit / 删二进制 / 删状态 / 删 `kore-*`） | 否 | root 服务自己 `kored uninstall --yes [--purge]` | 退出码 0 + `! test -e /usr/local/bin/kored` |

#### 6.5.1 升级：先校验再替换，替换完才提交重启

```bash
# 新二进制先落到任意可读位置（**本地文件，不是 URL**）
sha256sum kored-linux-amd64                       # 得到 <hex>
kored upgrade --bin /path/kored-linux-amd64 --sha256 <hex>   # root 服务内执行

# 只校验不落地（任何身份都能跑）
kored upgrade --bin /path/kored-linux-amd64 --sha256 <hex> --dry-run

# 回滚到上一次（用 <bin>.prev）
kored upgrade --rollback

# 重启后复核"新版本是否真的生效"
kored upgrade --verify
```

四条实现约束（不是建议，是代码里写死的）：

1. **拒绝 URL**：`--bin` 只接受本地文件；`http(s)://` / `ftp://` / `file://` 等一律报错退出 2。内核升级不做下载，下载与校验留给发行渠道。
2. **校验先于替换**：必须给 `--sha256`（64 位十六进制，接受 `sha256:` 前缀与大小写）。不一致时**目标文件一个字节都不动**、不产生 `.prev`、不提交重启，退出码 2。
3. **原子替换**：写同目录临时文件 → `fsync` → `rename` 覆盖（同文件系统才原子）→ `fsync` 目录。旧文件保留为 `<bin>.prev`（硬链优先：同一 inode，不产生"目标短暂消失"的窗口；硬链不可用退回复制）。
4. **最后一步才提交重启**：`systemctl --no-block restart <unit>`。

#### 6.5.2 重启时序：为什么 `systemctl restart` 会把自己杀掉，以及如何不假失败

`systemctl restart kore` 的 job 第一步就是给**当前进程**（也就是内核自己）发 SIGTERM。若升级命令**同步**等这个 job：

- 进程还没打印结果就被替换 → stdout 可能只有半截；
- 退出码取决于被杀与 job 返回的竞争 → **"升级报错但实际成功"的假失败**。

所以升级链固定为三段，且第三段刻意"不等结果"：

```text
旧进程：校验 sha256 → 原子替换 → 落 <state>/upgrade-result.json(state=pending)
       → systemctl --no-block restart kore   ← 提交 job 后立即返回
       → 打印"已替换 + 已提交重启"，退出码 0（**不等于**新版本已加载）
systemd：执行 restart job（SIGTERM 旧进程，拉起新进程）
新进程：serve 启动时读标记 → 自己的 sha256 == expected → 改写成 state=success
```

判据分工（**别把"提交成功"当"生效"**）：

| 判据 | 说明 |
| --- | --- |
| 退出码 0 | 二进制已替换 + 重启已提交；旧进程无法证明新版本已生效（正常） |
| 退出码 6 | 二进制可能已替换，但**重启没提交成功**（无 systemd / 无权限 / unit 不存在）；消息里会写清"已完成的/待完成的"，别当替换失败 |
| 退出码 2 | 校验失败（sha256 不符 / URL / 非法参数），目标零改动 |
| `upgrade-result.json` = success | **唯一**的"新版本已生效"证据；`kored upgrade --verify` 可随时补做 |
| `kored version` | 新进程报出的版本号（人工复核用） |

新进程的 finalize 在 `kored serve` 入口执行，**非阻塞、绝不阻断启动**：没有标记 / 读不了 / 写不了都安静跳过（最多一行 WARN）；若运行中的二进制 sha256 与标记期望不符，**保留 pending 不谎报 success**。

若 `--no-restart`：只替换不重启，输出会打印手动重启命令；此时标记停在 pending，直到你重启并跑 `--verify`。

#### 6.5.3 卸载：root 服务自卸载的顺序为什么是"先删文件、最后停自己"

`kored uninstall` 在 **root 服务内**运行时，检测到自己就是 `kore.service` 的 MainPID（`systemctl show -p MainPID --value`），会走自卸载分支：

```text
disable kore → rm /etc/systemd/system/kore.service → daemon-reload
→ userdel kore-*（按 /etc/passwd 前缀）
→ 列 changes.jsonl（默认不回滚）
→ [--purge] 执行 purge_op + 删状态目录
→ rm <自身二进制>（Linux 下运行中的 inode 仍可执行）
→ systemctl --no-block stop kore   ← 最后一步
```

**顺序不可颠倒**：若沿用普通卸载的 `systemctl stop` 优先，会把正在执行卸载的自己杀掉，后面删 unit / 删二进制 / `--purge` 全部做不成，用户看到"半卸载"。自卸载因此把 stop 换成 `--no-block` 并挪到最后；此时输出已全部写完，进程被 SIGTERM 属正常收尾。

两种形态的区别（**别把裸跑的行为套到服务上**）：

| 形态 | 身份 | 卸载行为 | 退出码 |
| --- | --- | --- | --- |
| **系统服务（推荐）** | 内核自己是 root | 全部动作自己做，**用户不需要 sudo**，含删 `/usr/local/bin/kored` 与状态目录 | 0 |
| **非 root 裸跑**（安装前 / 前台试跑 / 手工 `bin/kored serve`） | 普通用户 | 宿主侧（unit / `kore-*` 用户 / 二进制）跳过，打印**部分完成**摘要 | 6 |

非 root 部分完成的文案里现在明确写了这一层区别：**"以系统服务运行时不需要本步骤——内核自己就是 root，直接自卸载（无需 sudo）；当前为非 root 裸跑，请改用服务自卸载"**。也就是说 `sudo kored uninstall` 只是"裸跑/安装前"的兜底路径，不是常态路径。

#### 6.5.4 门禁与验证

- 单测：`go test ./cmd/kored -run 'Upgrade|Finalize'`（sha256 拒绝、原子替换 + `.prev`、非 root 拒绝、URL 拒绝、dry-run 零变更、回滚、`--verify`、新进程 finalize 幂等）。
- 实测：`/tmp` 假安装根（`unshare -r` 取临时 root，不碰真实 `/usr/local/bin/kored` 与真实 unit）：
  `kored upgrade --bin <new> --sha256 <hex> --target /tmp/.../bin/kored --state-dir /tmp/.../data --no-restart` → 断言新文件 sha 正确、`kored.prev` = 旧 sha、权限 755、标记 pending；随后 `--verify` → success；`--rollback` → sha 回到旧值。
- **真机 systemd 重启路径**：`systemctl restart` 的 job 提交需要有活的 `kore.service`。在没有活跃实例的机器上只能验证失败分支（返回 6 + "重启未提交"文案）。要真验，按 §6.5.2 的三段式在装了 unit 的机器上跑一次，判据是 `upgrade-result.json` 由 pending 变 success 且 `kored version` 变为新版本。

## 7. 重置管理员口令（忘记口令 / 首启没设置）

kore 是单管理员模型，没有"找回"流程：口令哈希在配置文件的 `auth.admin_password_hash`，重置 = 生成新哈希并重启。

> **2026-11-25 更新（[ADR-0055](DECISIONS/0055-initial-admin-credential.md)，commit `99754fd`；[ADR-0056](DECISIONS/0056-self-restart.md)，commit `93fd441`）**：重置**不再必须重启**——`admin-password --generate/--set` 写回哈希与 `auth.must_change_password=true` 后，向运行中的 kored 发 `SIGHUP` 即可让新哈希在内存 `auth.Manager` 生效并吊销旧会话（仅在真变化时踢会话），**SIGHUP 同步免重启**。重启仍是兜底，并可用 ADR-0056 的自服务入口 `kored restart --reason "..."` 或 `POST /api/v1/system/restart`（需 system:admin + reason-bound confirm）提交。下方 §7.1 的 `sudo systemctl restart kore` 是**保守路径（可停服务时）**，与新口径不冲突；**不可停服务时走 SIGHUP 路径**。初始安装期凭据见 [QUICKSTART](../QUICKSTART.md) §2.1：`kored install --package` 生成 0600 一次性凭据文件 `<install>/data/initial-admin-credential`，非 TTY 只打印路径不打明文，首登改密后文件删除。 **凭据生命周期（[ADR-0055 §8](DECISIONS/0055-initial-admin-credential.md)）**：首次安装生成一次性凭据；**更新 / 升级安装绝不重新生成、绝不覆盖凭据文件或哈希**（否则文件口令与哈希失配会锁死用户、吊销会话）。首登改密为**建议可跳过**；登录方向为账号 + 密码（细节待新 ADR）。

### 7.1 正常路径（服务可停、有 shell）

```bash
# 1) 生成新口令并写回配置（原子写 + 权限 0600；口令只打印这一次）
/opt/kore/bin/kored admin-password --generate
#    想自己指定口令（读两次、不回显）：
# /opt/kore/bin/kored admin-password --set
#    非交互（Ansible / 容器 entrypoint），从管道读：
# printf '%s' "$KORE_ADMIN_PW" | /opt/kore/bin/kored admin-password --set --stdin

# 2) 让新哈希生效（ADR-0055：SIGHUP 同步，免重启；仅真变化时吊销旧会话）
kill -HUP $(pidof kored)          # 或 systemctl reload kore（若 unit 已配 ExecReload）
#    兜底（可停服务时）：sudo systemctl restart kore
#    自服务兜底（ADR-0056）：kored restart --reason "reset admin password" --yes

# 3) 验证：新口令能换到会话（200 + 两个 cookie），旧口令 401
curl -s -o /dev/null -w 'new=%{http_code}\n' -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"<新口令>"}'
```

判据：`new=200`；用旧口令复跑同一请求应为 `401`。**ADR-0055 后**：`SIGHUP` 会把新哈希与 `must_change_password` 同步到内存 `auth.Manager`，字段真变化时自动 `RevokeAll`——旧口令 401、旧会话失效**无需重启**；普通热更不误踢全员。若只改了配置未发信号，旧哈希仍在进程内存中生效。

### 7.2 配置文件路径怎么找

- portable（默认）：`<install>/config/config.yaml`；设了 `KORE_HOME` 就是 `$KORE_HOME/config/config.yaml`。
- fhs（发行版打包）：`/etc/kore/config.yaml`。
- 显式指定：`kored admin-password --generate --config /path/to/config.yaml`。
- 不确定时看 `kored serve` 启动日志里的配置告警行，或 `curl -s 127.0.0.1:8787/api/v1/system/info`。

### 7.2.1 CLI 与服务的配置一致性（为什么必须带同一个 `--config`）

`kored serve` 与所有 CLI 子命令**各自**解析 `KORE_CONFIG` > `--config` > profile 默认路径。只要有一边回落到默认值，两边就算出**两个不同的 state.db**。

- 2026-11-23 实测事故：serve 用 `--config .kore-local.yaml`（`paths.state_dir: kore-state`），`kored install` 没带 `--config` → 装进 `data/state.db`；实例 `GET /plugins` 仍为空，而且**不报错**。
- 现在的行为（宁可吵，不许静默）：
  - 读写状态的 CLI 先打印 `配置: <绝对路径>（存在/不存在）｜状态目录: <绝对路径>`，不一致一眼可见；
  - 配置文件不存在、且没有显式给 `--config` → **退出码 2 fail-closed**，绝不按默认值新建库；`--config` 给了但文件不存在同样退出 2；
  - `kored status [--config ...]` 打印配置路径 / 状态目录 / profile / healthz 与 state.db 持有者 pid；实例未运行给「未运行」，不是异常栈。
  - `paths.state_dir` 等相对路径**按配置文件所在目录**归一化为绝对路径（不再是进程 cwd），同一份配置在任何目录启动都指向同一个库；见 §7.2.2。
- 正确姿势：先 `kored status --config <与 serve 相同>` 核对路径，再 `kored install --config <同一个> --package ...`。

### 7.2.2 `paths.*` 与 `server.socket`：相对路径会随执行目录变化

**结论：配置文件里的路径一律写绝对路径。**

- 归一化基准是**配置文件所在目录**，不是进程 cwd。相对值加载时转成绝对路径并留 WARN 供核对：`paths.state_dir 已归一化为绝对路径 /opt/kore/data（相对值 "./data" 按配置文件目录 /opt/kore/config 解析，与启动目录无关）`。
- 覆盖来源基准不同（不误伤 shell 习惯）：`--state-dir` / `KORE_STATE_DIR` / `KORE_PLUGIN_DIR` 的相对值按**当前 cwd** 立成绝对路径；配置文件里的相对值按**配置文件目录**解析。两者最终都是绝对路径，下游（supervisor 切 `cmd.Dir`）不再受 cwd 影响。
- 受影响字段：`paths.state_dir` / `log_dir` / `run_dir` / `index_dir` / `plugin_dir` / `server.socket`。不要写 `~`：不做家目录展开，直接报错。
- 历史形态（已修）：归一化曾用 `filepath.Abs`（基准进程 cwd）——同一份配置在 `/opt/kore` 与 `/tmp` 启动会算出两个状态库，**不报错、结果错**。

### 7.3 配置文件被改坏 / 完全没配置

`kored serve` 启动时会自检：配置不存在或哈希为空时，终端里直接引导输入新口令（非终端只提示、不阻塞）。救急也可以让命令自己建配置——`admin-password --generate --config <path>` 会创建父目录（0700）并写出只含 `auth` 段的新文件，再按需补 `server.addr` 等键。

### 7.4 防呆

- 配置文件权限应恒为 `0600`：`stat -c '%a %n' /opt/kore/config/config.yaml`；不是 0600 就 `chmod 600`。
- 不要用 `git`、备份工具或工单系统搬运含哈希的配置；哈希虽不是明文，但等同于口令。
- 写盘失败（磁盘满 / 只读挂载）时命令返回非 0 且原文件不变——不要忽略退出码。
