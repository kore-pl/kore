# 第四十二次重签（长期密钥免重启首次实战验收）

- 日期：2026-11-23 20:16–20:24+08:00 · 执行：kore-verify-privilege
- 性质：**长期密钥机制（ADR-0025 方案 A）第一次真实重签**——目标不是"再签一次"，而是验证承诺：
  签名不改公钥 ⇒ **不需要 `make build`、不需要重启 kored**，商店照样认新索引。
- **本把未执行 `make build`、未重启 kored、未改 `verify.go`。**

## 1. 两条版本（资产先 curl 复核）

```text
db-mysql     0.4.0 → 0.4.1  721462dba3d23271fb892a4b063f141b0dc436fa83e9367cc23311bfd3c9c268  1576479
db-postgres  0.3.2 → 0.3.3  c881cec23e1c6ad0151289a24ca063c0260d11669d8ac605dace9f35b4f79cc5  1569480
两条 HTTP=200，sha/size 与任务卡逐字一致；索引 2 条 + versions.lock 2 条 + presets pin 5 处（db-only 2 / full 2 / web-pro 1）。
```

## 2. 公钥未变（机制成立的核心 A）

```text
pubkey_before = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
pubkey_after  = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
validate-index.sh PUB_HEX = 同上（逐字相同）；verify.go 本把零改动
make check 14 段（含「公钥单一真源」）→ exit 0
```

## 3. 校验

```text
sign-index.sh（读 ~/.config/kore/signing/index-signing.seed）→ [OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）
validate 正例 → exit 0；篡改副本 → exit 1（[FAIL] ed25519 签名验证失败）；原仓复验 → exit 0
24 条 release 资产 curl：TOTAL=24 OK=24 BAD=0
```

## 4. 免重启的运行时证明（核心 B）

```text
pid_before    = 608004
pid_after     = 608004          # 同一进程 ⇒ 未重启
store_before  = db-mysql 0.4.0 / db-postgres 0.3.2
store_after   = db-mysql 0.4.1 / db-postgres 0.3.3   # 签名后立即生效
GET /api/v1/store/plugins → 200；mismatch={}
```

**结论：索引热更新成立。** 签名（含公钥不变的正文更新）无需 rebuild/restart，主实例在同一 pid 下读到新版本。

## 5. 提交与推送

```text
kore-plugins 8f146c1ca89afc57fb5779a053ea4d1cef8fee7f
  chore(release): 第四十二次重签（长期密钥免重启实战）+ db-mysql 0.4.1 / db-postgres 0.3.3 入索引
  Gitea(origin) 2d005f9..8f146c1 → GitHub → gitee：三端回读 == 8f146c1

kore 本把仅新增本文件（.agents/verify/resign-42.md），未改 verify.go / RUNBOOK。
```

## 6. 沿革

第 41 把 `3e461a07…` 长期密钥首签；**第 42 把首次证明「重签不重启」成立（pid 不变、商店版本已更新）**。
