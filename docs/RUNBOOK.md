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

### 步骤 6 — 重启 kored（换信任根必须重启）

```bash
systemctl restart kore && systemctl is-active kore            # 生产：判据 active
pkill -f 'bin/kored serve'; ./bin/kored serve --config ./.kore-local.yaml &   # 本地
```

判据：PID 变化 + 启动日志出现 `kore ready`。旧进程内存里还是旧公钥，这步省不掉。

### 步骤 7 — 验证 GET /api/v1/store/plugins == 200 且条数正确

```bash
J=/tmp/kore.jar
curl -sS -c $J -H 'Content-Type: application/json' -d '{"password":"<管理员口令>"}' \
  http://127.0.0.1:8787/api/v1/auth/login
curl -sS -b $J -o /tmp/store.json -w 'code=%{http_code}\n' http://127.0.0.1:8787/api/v1/store/plugins
python3 -c 'import json;print("count=",len(json.load(open("/tmp/store.json"))["plugins"]))'
```

判据：`code=200`，且 count 等于 `../kore-plugins/index/plugins.json` 的 `plugins` 长度。

### 跳过第 5 / 6 步的后果

旧二进制或旧进程仍是旧公钥 → 新签名验不过 → `E_UNAUTHORIZED` → 商店**全部请求 401**（列表、详情、预设、安装/更新/下载共用同一道门）。表象是"登录正常、商店整页空且 401"，且**不会自愈**：索引每请求重读，公钥只在进程启动时载入。

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
[Unit]
Description=kore 内核（kored）
Documentation=https://github.com/pengtang1024/kore
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/kored serve
Restart=on-failure
RestartSec=2s
# 状态 / 运行 / 日志目录（与 config 的 paths.* 对齐）
RuntimeDirectory=kore
StateDirectory=kore
LogsDirectory=kore
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
```

```bash
sudo install -m 0755 bin/kored /usr/local/bin/kored
sudo systemctl daemon-reload
sudo systemctl enable --now kore
systemctl is-active kore                 # 判据：active
ps -o user= -C kored                     # 判据：root
```

**为什么必须 root**：`systemd-run --uid=0` 由非 root 调用会走 polkit 交互认证；本机实测 `--no-ask-password` 被拒。以 root 启动 kored 后，transient unit 由已授权的 systemd 直接拉起，不需要交互。

### 5.2 通道验证（root 环境）

```bash
J=/tmp/kore.jar; S=/run/kore/kore.sock
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

### 6.2 卸载（两条路径）

```bash
# portable：先停服务（若装了 unit）、清豁免项，再删目录
sudo systemctl disable --now kore 2>/dev/null || true
sudo rm -f /etc/systemd/system/kore.service && sudo systemctl daemon-reload   # 豁免 #1
sudo getent passwd | awk -F: '$1 ~ /^kore-/ {print $1}' | xargs -r -n1 sudo userdel   # 豁免 #2（root 内核降权时才有）
rm -rf /opt/kore                                                                       # 主体：状态/配置/socket/日志一起没
# 断言（应全部无输出）
! test -e /etc/kore && ! test -e /var/lib/kore && ! test -e /var/log/kore && ! test -e /run/kore
! pgrep -x kored && ! ss -lx | grep -q kore

# fhs（发行版打包 / 显式 KORE_PROFILE=fhs）：路径在系统目录，按包管理器或手工清
sudo systemctl disable --now kore && sudo rm -f /etc/systemd/system/kore.service
sudo rm -rf /etc/kore /var/lib/kore /var/log/kore /run/kore
```

**用户主动施加的宿主变更默认不回滚**（ADR-0023 §3.4）：`<install>/data/changes.jsonl` 里逐条记录了 nginx vhost / ufw·nft 规则 / crontab 行等，`kore uninstall --purge` 才会按 `purge` 字段执行；不带 `--purge` 只打印清单。

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
