> 元信息: 2026-11-23T10:45+08:00 · 执行者 r7-echo-lazy 子 agent · echo 0.1.3（lifecycle lazy）发版入索引 + 第三十次重签 · 报告 ≤60 行

## 1. 结论
`echo` 已由 `resident` 改 `lazy` 并发版 **0.1.3**，第三十次重签完成（新公钥 `e9d42c82…6b7e`），隔离实例端到端与**槽位恢复**验证通过：`site` + `terminal` 占满 2 个 resident 槽后，`echo.ping` 仍 **200**（修复前 429）。**主实例 8787 仍是旧公钥进程，商店全部 401，须重启（见 §8）。**

## 2. 版本决策（与任务卡「0.1.1 → 0.1.2」的偏差，硬门禁驱动）
- 开工时仓库已是 `0.1.2`：上一轮「dist 位级可复现」改动已 bump 并发布（tag `v0.1.2`，release 资产 sha `57dfbe…a931f6` 1250457 B = 索引 = 账本）。
- 改 `info.json.lifecycle` 必然改包内字节 → 改 dist sha；RELEASE.md §0/§3 与 `validate-index.sh` §1b 均硬性要求「同 `id@version` 只允许一个 sha，漏 bump 只能新版本 + 新 release，禁止覆盖同版本资产」。
- 故本轮按 patch bump 到 **0.1.3**，`v0.1.2` 保持原样未动。

## 3. 包核对与 release
- `dist/echo-0.1.3.tar.gz` = **1250461 B** / sha `ed27b786fc10a0435a8495e79071f2b37689c60e4d1925afc1881760da0bb412`（包内 `size_bytes=1250462`，偏差 1 ≤ 2 的收敛口径）。
- 三处 sha 逐字一致：本地连续两次 `make dist`、`git archive HEAD` 干净树、**clone tag `v0.1.3`** 后 `make dist`。
- `git push origin main` `89173ff..9074a7e`；`tag v0.1.3` + push；`gh release create v0.1.3 dist/echo-0.1.3.tar.gz` → https://github.com/pengtang1024/kore-plugin-echo/releases/tag/v0.1.3
- 资产复核：`gh release view` → `size=1250461`、`sha256:ed27b7…bb412`，与索引逐字一致。

## 4. 索引 / 账本 / 预设 / 市场页
- `index/plugins.json` echo：`0.1.2 → 0.1.3`、`lifecycle: resident → lazy`、`size_bytes 1250457 → 1250461`（取 `stat -c%s` 实际包体，不取包内自声明）、`sha256 → ed27b7…`、`download_url → …/v0.1.3/echo-0.1.3.tar.gz`。
- `index/versions.lock.json`：echo 追加 `0.1.3 / ed27b7…`（历史 0.1.1 / 0.1.2 保留）。
- `presets/full.json` + `presets/dev.json`：echo 引用版本 → `0.1.3`。
- `market/plugins.js` 重建：24 插件 / 3765 B / 六字段齐全 / 无外链。

## 5. 第三十次重签（新密钥对，用完 shred）
- `openssl genpkey -algorithm ed25519` 现生成，私钥只落 `/tmp`（`umask 077`），签名后 `shred -u`，已确认 `/tmp` 无残留。
- **新公钥（第三十把）**：`e9d42c8293a90854f7433a42259eb3b583d5ea83d6fd2c03448a5c0cb83b6b7e`
- 两处逐字相同：`kore-plugins/scripts/validate-index.sh` 的 `PUB_HEX` 与 `kore/internal/core/market/verify.go` 的 `IndexPublicKeyHex`（脚本比对 `IDENTICAL`）。
- `make build` exit 0；`strings bin/kored | grep -c e9d42c82…` = **1**，旧公钥 `179270c4…` = **0**。

## 6. 验签正反例
- 正例：`bash scripts/validate-index.sh` → `POSITIVE_EXIT=0`；`[OK] 24 条 / 基线 24 条 / 47 条预设引用 / ed25519 签名验证通过 / 索引校验全部通过`。
- 反例：向 `plugins.json` 追加 1 字节 → `NEGATIVE_EXIT=1`，`[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）`；恢复后 `sha256sum -c` 两行 OK，复跑正例仍 `EXIT=0`。

## 7. 24 条 release 资产 curl
- 对索引全部 24 个插件逐一 `curl -sSL <download_url>`，同时校验 `http_code=200` + `sha256` + `size_bytes`：**TOTAL=24 OK=24 BAD_COUNT=0**。

## 8. 端到端 + 槽位恢复（隔离实例 127.0.0.1:18848，config/state/run/log 全在 `/tmp/kore-18848`）
- `/-/healthz` 200；`GET /system/info` → `index_dir` 指向 `kore-plugins/index`；商店 200 本身即**新公钥验签通过**（旧公钥时代为 401）。
- `GET /store/plugins` → **200 / 24 条**；echo = `{version:0.1.3, lifecycle:lazy, size_bytes:1250461, sha256:ed27b7…}`；store 与索引逐 id 比对（version/sha/size）`VERSION_MISMATCH=[]`。
- `POST /store/install {"id":"echo","version":"0.1.3","download":true}` → **200** `{"state":"succeeded","reload":"reloaded"}`；`/plugins` → `version=0.1.3`、`lifecycle=lazy`。
- **lazy 行为**：`POST /plugins/echo/enable` → 200 且 `supervisor.resident` 仍 **0**（不起进程，只登记 desired）；首次 `POST /invoke/echo/echo.ping` → **200** `{"pong":true}`（按需冷启）。
- **槽位恢复验证（本任务核心）**：装并启用 `site@0.2.0` + `terminal@0.1.1` → `supervisor={resident:2, resident_max:2, lazy_slots:1}`；此时 `echo.ping` → **200 `{"pong":true}`**（修复前同一场景 `enable` 即 429 `E_RATELIMIT`，见 [round6-final.md](round6-final.md) 第 13 行）。三插件同刻 `ready`，总槽 3 = `MaxSlots`。
- **空闲归还**：70 s 后 echo 自动 `state=stopped pid=0`（`resident` 保持 2），再次 `ping` → 200 且重新 `ready`（可复用，G-19 lazy 真退出）。

## 9. 门禁与提交
- echo：`make check` exit 0（gofmt clean / vet / test ok）；配 `chore(release): bump v0.1.3` = `9074a7e`（`info.json`/`manifest.json`/`CHANGELOG.md`/`README.md`）。
- kore-plugins @ `1ea27b6`（7 文件：索引 + 签名 + 账本 + 2 预设 + 市场页 + `validate-index.sh` 新公钥），已 push。
- kore @ `96d5852`（`internal/core/market/verify.go` 新公钥）；`make check` **11/11 exit 0**、`go test ./internal/core/market/...` ok。
- G-29：**本轮未改动主实例 `.kore-local.yaml`**（测试全走 18848 隔离实例）；但重建了 `bin/kored`（新公钥），主实例 8787 旧进程仍用旧公钥 → 商店 401，**须 lead 重启 8787 后复验**。
- 隔离实例已 kill（18848 无监听）、`/tmp/kore-18848` 与 `/tmp/echo-clean-013`、`/tmp/echo-v013-clone`、`/tmp/kore30-*` 已删除。
