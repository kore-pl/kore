> 状态: active · 归属: implementer · 更新: 2026-11-23 · 里程碑: M5

# 索引签名密钥 SOP（ADR-0025 方案 A：长期密钥）

索引签名私钥是**不可回滚资产**：一旦丢失/泄漏都要走应急流程。本 SOP 规定首次生成、备份、日常重签、轮换、泄漏应急与复核周期；执行脚本是 `kore-plugins/scripts/sign-index.sh`，验签脚本是 `kore-plugins/scripts/validate-index.sh` 与内核 `internal/core/market/verify.go`。

> 核心不变式：**公钥是编译期常量、永不随重签变化**；私钥只在发布机、仓库外、`0600`。重签索引不需要 `make build`，也不需要重启 kored。

## 1. 首次生成（只做一次）

在发布机上：

```bash
# 默认落 ~/.config/kore/signing/index-signing.seed（目录 0700 / 文件 0600）
bash scripts/sign-index.sh --generate

# 或显式指定仓库外路径（推荐放到磁盘加密的个人目录）
KORE_SIGNING_KEY="$HOME/.config/kore/signing/index-signing.seed" \
  bash scripts/sign-index.sh --generate
```

脚本会打印 64 位 hex 公钥。把它写入两处并保持一致（**仅首次/轮换时改**）：

1. 内核 `internal/core/market/verify.go` 的 `IndexPublicKeyHex`；
2. 索引仓 `scripts/validate-index.sh` 的 `PUB_HEX`。

然后 `cd ../kore && make build` 并重启一次 kored（这是最后一次因签名密钥而重启）。

> **拒绝覆盖**：私钥已存在时 `--generate` 退出码 3，不覆盖、不备份——轮换见 §4。
> **拒绝静默换钥**：日常签名找不到私钥时退出码 2 并指向本文件，**不会**再生成新钥（39 次重建/重启事故链的起点）。

## 2. 备份（生成后立即做）

- **离线介质**：把 seed 文件复制到两处离线介质（加密 U 盘 / 保险柜），标注「kore 索引签名私钥，泄露即需轮换」与生成日期。
- **口令管理**：如用密码库，存**整份 seed 文件**而非截图；恢复演练时只校验能否解出 64 位 hex。
- **禁止**：写入 git（含私有仓）、CI secret、Shell 历史、聊天记录、工单、日志；不要 `cat` 到终端（会进 scrollback）。
- **恢复演练**：每季度用备份 seed 在临时目录签一份**副本**索引并用公钥验签，确认备份可用；演练产物立即删除。

## 3. 日常重签（免 rebuild / 免重启）

改完 `index/plugins.json`（及 `versions.lock.json`、`presets/*.json`）后：

```bash
export KORE_SIGNING_KEY="$HOME/.config/kore/signing/index-signing.seed"   # 或依赖默认路径
bash scripts/sign-index.sh
bash scripts/validate-index.sh        # 必须 exit 0；篡改正文应非 0
```

- 公钥常量不变 → **不需要** `make build`、不需要重启 kored；kored 只重新读索引文件。
- 仍然要过 `make check`（或至少 docs/secret 段）与商店页回归。
- 私钥路径只经 `KORE_SIGNING_KEY` 传入；不要把它写进仓库配置或 `.env.example`。

## 4. 轮换（二期方案 B；当前需一次 rebuild + 重启）

1. **触发**：私钥疑似泄漏、人员/机器变更、或策略要求的固定周期。
2. 生成新钥（新路径，不覆盖旧钥）：`KORE_SIGNING_KEY=.../index-signing-<YYYYMMDD>.seed bash scripts/sign-index.sh --generate`。
3. 用**新钥**重签索引，更新 `verify.go` 与 `validate-index.sh` 两处公钥，`make build` + 重启一次 kored。
4. 保留旧钥至少一个发布周期用于回滚；确认无回滚需求后按 §5 销毁。
5. 二期方案 B 落地后，轮换改为「旧钥签 key manifest」，可免 rebuild/重启；在此之前按本节执行。

## 5. 泄漏应急

1. **立即停止使用**该私钥并视为已泄漏；在安全渠道记录时间、可能暴露面。
2. 生成新钥（§4 步骤 2–3），用新钥重签索引并发布；旧签名立即失效。
3. 两端公钥同步（`verify.go` + `validate-index.sh`），`make build` + 重启，验证商店验签通过。
4. 公告**强制升级窗口**：旧版本 kored 仍信旧公钥，必须在该窗口内升级；窗口内监控 401/验签失败告警。
5. 复盘：私钥为何离开受控环境、备份是否也被污染；若备份泄漏，同样作废。

## 6. 复核周期

- **每次重签**：确认 `validate-index.sh` exit 0、两端公钥一致、商店版本 == 索引版本。
- **每季度**：备份恢复演练（§2）、私钥文件权限 `stat -c '%a'` 必须 600、目录 700。
- **每年 / 人员变更**：评估是否轮换；评估是否启用二期 B（"轮换也免重启"）。

## 7. 自测（机制验收，不碰真索引）

```bash
TMP=$(mktemp -d); cp -a ../kore-plugins "$TMP/plugins"; rm -rf "$TMP/plugins/.git"
export KORE_SIGNING_KEY="$TMP/keys/index-signing.seed"
bash "$TMP/plugins/scripts/sign-index.sh" --generate          # exit 0，打印公钥
bash "$TMP/plugins/scripts/sign-index.sh"                     # exit 0（用长期钥签副本）
# 把副本 validate-index.sh 的 PUB_HEX 临时改成上式公钥后：
bash "$TMP/plugins/scripts/validate-index.sh"                 # exit 0
printf ' ' >> "$TMP/plugins/index/plugins.json"
bash "$TMP/plugins/scripts/validate-index.sh"                 # 非 0（篡改反例）
```

真索引 `kore-plugins/index/plugins.json` 的重签由发布任务单独执行，**不在机制自测里动它**。
