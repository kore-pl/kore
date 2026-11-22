> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M1

# RUNBOOK — 发布与回滚操作手册

## 0. 适用与三条铁律

只覆盖发布侧动作：索引重签、插件升级、新增插件、回滚。日常构建/启动见 [QUICKSTART.md](../QUICKSTART.md)，内核规格见 [CORE.md](./CORE.md)。

1. **公钥有两份副本，必须逐字相同**：`kore-plugins/scripts/validate-index.sh` 的 `PUB_HEX` 与 `internal/core/market/verify.go` 的 `IndexPublicKeyHex`。只改一处 = 校验器与内核各说各话。
2. **公钥是编译期常量**：换公钥必须 `make build` + 重启 kored。索引正文每请求重读磁盘（`readTrusted`），公钥只在进程启动时进内存——旧进程永远用旧公钥。
3. **验签失败一律 401，不降级**：`readTrusted` 是列表/详情/预设/安装的唯一信任门，失败返回 `E_UNAUTHORIZED`（401），无旁路。

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

## 2. 插件升级发布流程（dist → release → 索引 sha → 重签 → 重启 → 端到端安装）

1. 插件仓 `make dist` 出 `dist/<id>-<version>.tar.gz`，记 `sha256sum`。
2. 建 release（tag `v<version>`）挂包，`download_url` 指向它。
3. 改 `kore-plugins/index/plugins.json` 对应条目的 `version` / `size_bytes` / `sha256` / `download_url`。
4. 重签 + 校验（§1 步骤 2–3，判据 exit 0 且反例 FAILed）→ 重启 kored（§1 步骤 6）；只改正文不换密钥时进程本会重读，但仍按重启执行。
5. 端到端：`POST /api/v1/store/install`（`download=true` + `id`/`version`）→ 判据 200、插件 `installed`、`GET /api/v1/store/plugins/{id}` 版本号等于新版本。

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
