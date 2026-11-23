# 第 45 次重签证据（3 条入索引 + kore 积压推送）

- 日期：2026-11-23（task-173，owner kore-rel-logs）
- 密钥：ADR-0025 长期密钥；判据 = 公钥常量不变 + 运行镜像 `/proc/<pid>/exe` sha 不变
- 索引仓提交：`c6831c1`（3 条 + 账本 + 3 个预设），三端回读均 `c6831c1b`

## 1. 三条资产复核（curl -L，HTTP 200 + sha256 + 实测 size 逐字一致）

| 插件 | 索引旧值 → 新版本 | sha256 | 实测 size |
| --- | --- | --- | --- |
| waf | 0.3.1 → 0.4.1 | `201635abc29baaaa932d16723ed9b7a6a2c3b87477341772abc06bbf8137621d` | 2934045 |
| runtime-python | 0.3.0 → 0.3.1 | `f16abf6e6644f3626a55b85a6c27bfd37d3da9d9c3e2a871236dff80ac1f99f0` | 1550361 |
| container | 0.5.0 → 0.5.1 | `8d1b586b05fe8a2e3e9ada77dc34cdd56975cdb6004436b85ea8c2efdceb7279` | 1527626 |

备注：waf 索引原值是 **0.3.1**（任务卡写 0.4.0），按实际旧值直接改到 0.4.1；资产 sha 与卡中一致（tag 已纠正为 `23f8b7a` 后）。索引 size 一律记**实测值**。

## 2. 公钥（未变）与校验

```text
verify.go IndexPublicKeyHex = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
validate-index.sh PUB_HEX   = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
kore make check             exit 0（第 14 段 [OK] 两端公钥一致）
validate 正例 0 / 篡改副本 1 / 原仓复验 0
24 条资产 curl              TOTAL 24 / BAD_COUNT 0
```

## 3. 推送 kore 积压

- 积压 11 条（`origin/main..HEAD`，含其他 agent 合法提交），逐条已列出
- 推送前 `make check` exit 0（25 pass / 0 warn / 0 fail）、`make build` exit 0（bin/kored 21:07）
- 一轮推送即收敛：origin / github / gitee 均 `a3b7ab51` == 本地 HEAD

## 4. 运行时验收（验收 B）

```text
pid_before = 1610096   exe_sha_before = 0650c9382983cf96ff74968a70de5389741ac957c2dcf05ee76ace5ad5515175
pid_after  = 1610096   exe_sha_after  = 0650c9382983cf96ff74968a70de5389741ac957c2dcf05ee76ace5ad5515175
```

- `/proc/<pid>/exe` sha **前后相同** → 签名与推送未改变运行镜像
- **本把未重启 kored**；重签本身未 build；为第⑦步积压门禁执行了一次 `make build`（21:07），进程未重启
- store_before / store_after = **未验证**（`GET /api/v1/store/plugins` 带既有 /tmp/c2.txt jar 仍 401）

## 5. 结论

- 第 45 把重签完成：3 条版本入索引 + 账本 + 预设，验签通过，公钥未变
- kore 积压 11 条已推三端并收敛；运行镜像 sha 不变
- 未触碰 `AGENTS.md` / `docs/DECISIONS/0027-*` / `docs/FRONTEND.md` / `Makefile` / `web/embed.go` / `web/i18n/*` / `docs/RELEASE.md`
