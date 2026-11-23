> 元信息: 2026-11-23T09:00+08:00 · 执行者 resign-28 子 agent · db-postgres 0.2.1（空态 hint）入索引 + 第二十八次重签 · 报告 ≤60 行

## 1. 结论
`db-postgres` 0.2.1 已发版并入索引、第二十八次重签完成（新公钥 `29746ec6…507ad3`），隔离实例端到端含 `hint` 验证通过，干净树复现 sha 一致。**主实例 8787 仍是旧公钥进程，商店全部 401，须重启（见 §8）。**

## 2. 包核对与 release
- 本地 `dist/db-postgres-0.2.1.tar.gz` = **1523427 B** / sha `a92cc13140a74954d1b36d3d28e009b83a66a490ac2e25071bdaa308d84b9389`，与任务给定值逐字一致。
- **push 前**先做干净树预检：`git archive HEAD | tar -x -C /tmp/pre28 && make dist` → 同 sha / 同 size（避免给不可变 release 挂错包）。
- `git push origin main` `65c98be..1efdeac`；`git tag v0.2.1` + push → `ls-remote` 回读 `1efdeac…`；`gh release create v0.2.1 dist/db-postgres-0.2.1.tar.gz` → https://github.com/pengtang1024/kore-plugin-db-postgres/releases/tag/v0.2.1
- 资产复核：`curl -sSL` → `http_code=200`、`size=1523427`、`sha256` = `a92cc131…b9389`（三者全等）。

## 3. 索引 / 账本 / 预设 / 市场页
- `index/plugins.json`：db-postgres `0.2.0 → 0.2.1`，`size_bytes` 1523093 → 1523427，`sha256` → `a92cc131…`，`download_url` → `…/v0.2.1/db-postgres-0.2.1.tar.gz`。
- `index/versions.lock.json`：db-postgres 追加 `0.2.1 / a92cc131…`（历史 0.1.0 / 0.1.1 / 0.2.0 保留）。
- `presets/db-only.json` + `presets/full.json`：db-postgres 引用版本 → `0.2.1`（其余 6 个预设未引用，无需改）。
- `market/plugins.js` 重建：24 插件 / 3765 B / 六字段齐全 / 无外链。

## 4. 第二十八次重签（新密钥对，用完 shred）
- `openssl genpkey -algorithm ed25519` 现生成；私钥只落 `/tmp` 且 `umask 077`。
- **新公钥（第二十八把）**：`29746ec63c084b9c024e418c4e877d4750d9f7eeeac107265b69710588507ad3`
- 两处逐字相同：`kore-plugins/scripts/validate-index.sh` 的 `PUB_HEX` 与 `kore/internal/core/market/verify.go` 的 `IndexPublicKeyHex`（脚本比对 `IDENTICAL`）。
- 签名后两处私钥副本 `shred -u` 删除（`/tmp` 已无残留）。

## 5. 验签正反例
- 正例：`bash scripts/validate-index.sh` → `POSITIVE_EXIT=0`；`[OK] 24 条 / 基线 24 条 / 47 条预设引用 / ed25519 签名验证通过 / 索引校验全部通过`。
- 反例：向 `plugins.json` 追加 1 字节 → `NEGATIVE_EXIT=1`，`[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）`；恢复后 `sha256sum -c` 两行 OK（签名对象是终版索引）。

## 6. 24 条 release 资产 curl
- 对索引全部 24 个插件逐一 `curl -sSL <download_url>`，同时校验 `http_code=200` + `sha256` + `size_bytes`：**TOTAL=24 OK=24 BAD_COUNT=0**。

## 7. 端到端（隔离实例 127.0.0.1:18853，独立 config/state/run/log 全在 /tmp）
- `make build` exit 0；`strings bin/kored | grep -c 29746ec6…` = **1**（新公钥确实编入二进制）。
- `/-/healthz` 200；`GET /api/v1/system/info` → `index_dir=/home/pt/Work/GolandProjects/kore-plugins/index`（直接指向索引仓，非快照）。
- `GET /api/v1/store/plugins` → **200 / 24 条**；`db-postgres` = `{version: 0.2.1, size_bytes: 1523427, sha256: a92cc131…b9389}`；store 与索引逐 id 比对 `VERSION_MISMATCH=[]`。
- `POST /api/v1/store/install {"id":"db-postgres","version":"0.2.1","download":true}` → **200** `{"state":"succeeded","reload":"reloaded"}`；`GET /api/v1/plugins` → `version=0.2.1`、`lifecycle=lazy`、`enabled=false`。
- 首次 invoke 因未启用返回 `409 E_CONFLICT`（预期，非缺陷）→ `POST /plugins/db-postgres/enable` 200 → `POST /api/v1/invoke/db-postgres/db-postgres.instances` → **200**：
  `{"instances":[],"count":0,"hint":"尚未配置 PostgreSQL 连接。请在插件设置里填写 host/port/user/password，或用 KORE_PG_HOST 等环境变量"}` → `HINT_ASSERT=PASS`（`count=0` 且 `hint` 非空）。

## 8. 干净树复现 + 边界声明
- `git clone` → `checkout v0.2.1`（`HEAD=1efdeac`、`git status` 0 行脏）→ `make dist` exit 0 → sha `a92cc131…b9389` / size 1523427，**与索引逐字一致**。
- G-29：**本轮未改动主实例 `.kore-local.yaml`**（测试全走 18853 隔离实例）；但重建了 `bin/kored`（新公钥），主实例 8787（PID 1883713，旧二进制旧公钥）因此商店 `GET /store/plugins` = **401 E_UNAUTHORIZED**，`/-/healthz` 仍 200——符合 RUNBOOK「换信任根必须重启」，**须 lead 重启 8787 后复验**。
- 隔离实例已 kill（18853 端口无监听）、`/tmp/{kore-18853,repro28,pre28,dl28,dl28b}` 已删除、临时密钥已 shred。

## 9. 附带修正（同类问题，非本次任务引入）
- 24 条 sweep 发现 `discover@0.2.0` 索引 `size_bytes=1498640` 而实际包体 **1498639**（sha `5055b67d…` 一致）——根因是上一轮把**包内 `info.json` 自声明值**抄进索引，而非实际包字节；`market/types.go` 定义该字段为「包字节数」。已按实际值校正 `size_bytes=1498639`（sha 不变、无需 bump），修正后重签并重跑 sweep 得 `BAD_COUNT=0`。**同类建议**：入索引时 size 一律取 `stat -c%s` 实际包体，不取包内声明。

## 10. 门禁与提交
- 插件仓 `make check` exit 0（gofmt clean / vet / 4 包测试 + fault 2.0s 全绿）。
- kore：`make docs-check` exit 0（5 pass / 1 warn 非阻断）、`make check` **11/11 exit 0**（含 secret-check 0 FAIL）、`go test ./internal/core/market/...` ok。
- 提交走 `scripts/safe-commit.sh`：kore-plugins @ `feb6b26`（7 文件）；kore @ 本轮 verify.go + BOARD + 本报告。
