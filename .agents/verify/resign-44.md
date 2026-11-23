# 第 44 次重签证据（4 条入索引，长期密钥免 build / 免重启）

- 日期：2026-11-23（task-153，owner kore-rel-logs）
- 密钥：ADR-0025 长期密钥；**本把未执行 `make build`、未重启 kored**
- 索引仓提交：`6997c65`（4 条版本 + 账本 + 预设）+ `0452190`（补 dev 预设 pin，重签时漏列）；两笔均已推三端，回读均 `04521905`

## 1. 四条资产复核（逐条 curl -L，HTTP 200 + sha256 + 实测 size 逐字一致）

| 插件 | 旧 → 新版本 | sha256 | 实测 size |
| --- | --- | --- | --- |
| process | 0.2.2 → 0.3.0 | `36d435246960b92ae4900fe07818d32e62d285d1b296e11a40b4976f85132328` | 1468449 |
| container | 0.4.1 → 0.5.0 | `af1e67138b81b7687274e89de422a08cdb92f0d781223015e3b1ba827ab6fc11` | 1527624 |
| ssh-guard | 0.2.3 → 0.3.0 | `a392b063ca788212d48566e72c76d52713753a0a0f86f87bcd8d8d31b4a66e66` | 2840608 |
| runtime-python | 0.2.4 → 0.3.0 | `066d01c9ff2e2a94f6d8ed3e859038131db9b2c60884625441a7f86ea4ababf2` | 1550367 |

索引 size 一律记**实测值**（与任务卡逐字一致，无声明值偏差）。

## 2. 索引 / 账本 / 预设

- `index/plugins.json`：4 条 version / sha256 / size_bytes / download_url 更新
- `index/versions.lock.json`：4 个 id 追加 `{version, sha256}`
- `presets/*.json`：3 个预设（dev / full / security）pin 同步；dev 的 runtime-python 0.3.0 在第二笔补提交
- `bash scripts/sign-index.sh`（长期密钥，无 `--generate`）：exit 0

## 3. 公钥（未变）与门禁

```text
verify.go IndexPublicKeyHex = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
validate-index.sh PUB_HEX   = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
kore make check             exit 0（第 14 段 [OK] 两端公钥一致）
```

## 4. 校验正反例与资产

```text
validate-index.sh（原仓）          exit 0
validate-index.sh（篡改副本 +空格） exit 1
validate-index.sh（原仓复验）       exit 0
24 条 release 资产 curl           TOTAL 24 / BAD_COUNT 0
```

## 5. 运行时验收

```text
pid_before = 608004（签名前）
pid_after  = 1589715（签名后复查时）  # **不一致 → 本窗口内 kored 被重启，但非本把导致**
```

**更正（提交后复核发现）**：本文件初版写的是 `pid_after = 608004`（凭签名前取值预写，属错误陈述）。
实际签名后复查 `pgrep -x kored` = **1589715**，且 `bin/kored` mtime = 20:53、HEAD 已被并发的
`[agent:kore-impl-waf]` 图表/ssh-guard 会话推进（其改 `web/` 后必然 `make build` + 重启）——
即 **pid 变化来自另一会话的重建/重启，不是第 44 把重签**。本把自身只改索引仓 + 本证据文件，
未执行 `make build`、未 `systemctl restart`。

```text
store_before = 未验证（GET /api/v1/store/plugins 带既有 /tmp/c2.txt jar 仍 401）
store_after  = 未验证（同样 401，未编造版本）
```

## 6. 结论

- 第 44 把重签完成：4 条版本入索引 + 账本 + 预设，验签通过，公钥未变
- **本把未执行 `make build`、未重启 kored**（pid 观测被并发会话污染：608004 → 1589715，非本把导致；见上文更正段）
- 未触碰 `AGENTS.md` / `docs/DECISIONS/` / `docs/FRONTEND.md` / `Makefile` / `web/embed.go` / `web/i18n/*`
- 商店 4 条版本变新：无有效会话，如实标「未验证」
