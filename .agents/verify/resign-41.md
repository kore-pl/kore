# 第四十一次重签（ADR-0025 方案 A 首签 + 10 条版本入索引）

- 日期：2026-11-23 20:11–20:28+08:00 · 执行：kore-verify-privilege
- 首签公钥（**长期密钥**，此后不再随重签变化）：`3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0`
- 长期私钥：`~/.config/kore/signing/index-signing.seed`（目录 `0700` / 文件 `0600`，仓库外，**未入库**、未 shred）
- 本条起签名体系从「每把换钥」切到「长期密钥」；**这一把是最后一次因重签而重启**。

## 1. 10 条资产复核（全部 HTTP 200，sha256/size 与任务卡逐字一致）

```text
integrity     0.3.3  e55ca4bd44a06ea810ab0fc6953d77962227c1bb102e4dcbbbb407815ed4f8f0  1465959
process       0.2.2  6558b2f0c1427e005c62d02fc91393ccd9493e2720590d4c5b48fe3827065939  1442771
logs          0.4.2  6a210407e3b6ebb6443637298caf2eda9c76ea5357951cbbb0b051707fcf7caf  1559767
db-postgres   0.3.2  aa045dfa2735994ce70dcd302dd359eab35c35de5d419ec3d458c84c9502648f  1569354
backup        0.4.1  44134a9439b24a00c2792c5ffb41c5ad095c3a1a63114befdb31a57e803d0874  1706102
app-deploy    0.2.2  d64dca310fef47514cb92c0f2886b1359cb4a99771cccad350432de4cbd06bda  1541029
db-mysql      0.4.0  2f3887e1d1895c29338549c205f7b451bf6eeaa022b6d85574087b5809afca60  1575080
site          0.4.3  26b0f4a347eb46556c77b04694e74422db1651052de4bb97d45079bd81238541  1611579
ssl           0.5.1  fb26d2decf596d5689b058d9ea036f1ff8bb27ca62209855b1e3c211ed297dd5  3160948
firewall      0.2.6  f034229f4fdf6db2a06a679aff583c848191b9918ef7f29166a24397f0b9f44e  2833896
TOTAL=10 OK=10 BAD=0
```

## 2. 索引与长钥

- `index/plugins.json` 10 条 version/sha256/size_bytes/download_url 同步；`versions.lock.json` 追加 10 条；presets pin 更新 24 处（db-only 3 / full 9 / gateway 3 / security 3 / web-lite 2 / web-pro 4）。
- `scripts/sign-index.sh --generate` → `[OK] 已生成长期签名私钥：…（0600）`，`stat` 复核目录 `700` / 文件 `600`；`git status` 与 `git ls-files | grep seed` 均无该文件。
- `sign-index.sh`（不带 --generate）自动读取长钥签名 → `[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）`。
- 公钥两端同步逐字相同：`kore-plugins/scripts/validate-index.sh: PUB_HEX` == `kore/internal/core/market/verify.go: IndexPublicKeyHex`。

## 3. 校验

```text
validate 正例 → exit 0（schema 24 / 基线 24 / 预设 47 / ed25519 通过）
篡改副本     → exit 1（[FAIL] ed25519 签名验证失败）
原仓复验     → exit 0
24 条 release 资产 curl（--retry 2）：TOTAL=24 OK=24 BAD_COUNT=0
```

## 4. 免重启证明（本把核心证据）

在 `/tmp` 复制整份 `kore-plugins`（含新索引与新脚本），用**同一长期密钥**再签一次：

```bash
$ cp -a kore-plugins /tmp/kore-plugins-41 && cd /tmp/kore-plugins-41
$ sha256sum index/plugins.json.sig
7b6911903ccd863c27c9f4be582bc9ef7407fc9b6b91719b411620bb2cfe8ab0
$ bash scripts/sign-index.sh
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）：…/index/plugins.json → …/index/plugins.json.sig
$ sha256sum index/plugins.json.sig
7b6911903ccd863c27c9f4be582bc9ef7407fc9b6b91719b411620bb2cfe8ab0     # 与签名前一致（Ed25519 确定性签名）
$ bash scripts/validate-index.sh; echo "exit=$?"
[OK] ed25519 签名验证通过（内置公钥）
[OK] 索引校验全部通过
exit=0
$ grep -oE '[0-9a-f]{64}' kore/internal/core/market/verify.go | head -1
3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0     # 公钥未变
```

**结论：重签只改 `plugins.json` 正文与 `.sig`，不改变 `IndexPublicKeyHex` ⇒ 从第 42 把起无需 `make build`、无需重启 kored。**（第 41 把本身因把公钥从未知第 40 把切到长期公钥，才需要最后一次 rebuild+restart。）

## 5. 提交与推送

```text
kore-plugins 2d005f9b4e9945ae8d497ff455fda0b25992fbd1
  chore(release): 第四十一次重签（长期密钥首签）+ 10 条版本入索引（ADR-0025 方案 A）
  Gitea(origin) 1435981..2d005f9 → GitHub → gitee：三端回读 == 2d005f9
```

## 6. 主实例（最后一次因重签重启）

- `make check` 14 段 exit 0；`make build` exit 0；闸门 `grep -c 3e461a07` = 1、旧公钥 `8b4fe19f` = 0。
- `systemctl --user restart kored-local`（未用 setsid/nohup）；`cgroup` 不含 `dsh-subprocess`；`healthz=200`；`paths.index_dir == kore-plugins/index`。
- 商店：见交付回报（若有有效会话则给 24 条与 10 条版本，否则标注未验证）。

## 7. 沿革（32 → 41）

- 32 `37c65e8a…` 提前 shred 教训；33 `3a87e3a5…` 补 terminal；34 `3e5333bf…` 16 条；35 `e03ea622…` URL 全切 + 8 条；36 `e3a00492…` ssl 0.5.0；37 `60f66980…` echo 0.1.4；38 `13766b91…` site 0.4.0/db-mysql 0.3.2；39 `54c0e4be…` site 0.4.1/file 0.3.1；40 `8b4fe19f…` 5 条；**41 `3e461a07…` 长钥首签 + 10 条（此后公钥固定）**。
