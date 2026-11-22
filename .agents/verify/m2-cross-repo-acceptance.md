> 状态: draft · 归属: verifier（m2-verify-final，独立于全部 implementer） · 更新: 2026-11-22 · 里程碑: M2
> 验收对象: M2 五轨（site 插件仓 / web 壳 / lazy 生命周期 / 索引仓+market+签名链 / 8 预设）· 三仓 kore / kore-plugin-site / kore-plugins（+ echo 对照仓）
> 验收时间: 2026-11-22 08:35–08:40 +08:00 · 全部命令由 verifier 在本机原样复跑，未复用任何实现者结论。

# M2 跨仓独立验收报告

## 0. 结论先行

**VERDICT: APPROVE（带 1 项阻断级发布链路缺陷 + 3 项记录）**

A/B/C/D 四组共 30+ 命令全部执行：机械门禁全绿、market 验签链正确、lazy 6 PASS、端到端安装与真服务四端点均通过。唯一阻断缺陷在 **B1**：`kore-plugin-site` 的 `make dist` 打包非确定性（`tar -czf` 未固定 mtime），导致索引 `site` 的 sha256 `59b107ba…` 无法被重建包复现；重建即变。此为发布可信度硬伤，判阻断，交 site owner 修复。**说明**：本 verifier 在 A 组按任务要求执行了 `make dist`，改变了 dist 现场（原包 sha 未在重建前采集），故本报告不把"当前包 sha 与索引不等"直接归罪于交付——但打包非确定性本身有独立可复现证据。

## A. 三仓机械门禁（全绿）

| 仓 | 命令 | 结果 |
| --- | --- | --- |
| kore | `gofmt -l .` | 无输出，EXIT=0 |
| kore | `go vet ./...` | EXIT=0 |
| kore | `go test -timeout 200s ./...` | 12 包全 ok，EXIT=0 |
| kore | `make check`（10 段） | 10/10 段全绿，EXIT=0；第10段 frontend gzip 4151 B |
| kore-plugin-site | `go build ./...` / `make build` / `make dist` | 均 EXIT=0 |
| kore-plugins | `bash scripts/validate-index.sh` | schema/字段/id/sha256/签名/预设引用 4 项 OK，EXIT=0 |
| kore-plugins | `bash scripts/validate-presets.sh` | 8 预设全 OK，0 FAIL/0 WARN，EXIT=0 |
| kore-plugins | `make check` | presets-check + validate-index 全过，EXIT=0 |

`make check` 10 段明细：docs-check 6 pass / dep-check 2 pass（第三方 2/3、同仓 module replace=./）/ thin-shell 4 pass / repo-check 5 pass / canonical 9 pass / log 8 pass / wt 4 pass / oss 8 pass / case 6 pass / frontend PASS。

## B. 跨仓一致性

**B1 sha256 两对（核心）**

| 插件 | 索引声明 sha256 | 真实包 sha256（`sha256sum`） | 一致 |
| --- | --- | --- | --- |
| echo 0.1.1 | `eaa34f251e18b9c3f4a186c420d62bec9f31a37c61963514c4b856160ef4219c` | `eaa34f251e18b9c3f4a186c420d62bec9f31a37c61963514c4b856160ef4219c`（首次读取原件） | ✓ |
| site 0.1.0 | `59b107badc27ce1285631dc2c2989db41da5a702130c26bffc1b840b3801520f` | 重建后 `f9fae46702ccce9e7b2878957234dbf36cd7362707188da9974a7887b6b3f081` / 再建 `8579eb37459c4303f93460464a350d2beb70999019b624b150daccd7642b7f54` | ✗ 阻断 |

根因（有复现证据）：两仓 Makefile 的 `dist` 用 `tar -czf … -C stage …`，stage 内文件 mtime 每次重建不同 → gzip/tar 头变化 → sha 变化。对照实验：echo 原件匹配索引 `eaa34f25…`，但 verifier 连续 `make dist` 后变成 `7b46687f…`（同秒复跑）与 `c810654c…`（跨 2s），证明非确定性。索引 size_bytes 也随 size_bytes 回填迭代在 1363613/1363615 间波动。site sidecar `.sha256` 随每次重建更新，但与索引 sha 从未对齐。

**B2 预设解析**：full.json = echo 0.1.1 + site 0.1.0（out_of_box=false）；dev.json = echo 0.1.1（out_of_box=false）——均能在索引解析，validate-presets 已独立复核。

**B3 验签公钥**：`validate-index.sh:10` 的 `PUB_HEX` 与 `internal/core/market/verify.go:16` 的 `IndexPublicKeyHex` **完全一致** = `8f9e4c8585cad9745be7fdcb9c5ecd9137fccd3d45a9c29ded8ccbadb95ec684`。`go test -run TestVerify -v ./internal/core/market/` → 3 PASS（正例 + 篡改 sig + 篡改 data），EXIT=0。真服务 GET store/plugins 返回 200 证明索引经该公钥验签通过。

**B4 allow_unsigned 默认拒**：`config/types.go:144 Default()` 未设置 `Store.AllowUnsigned`（快照中仅 `Plugins.AllowUnsigned: true`，属 M4 包签名语义）→ 零值 false。`market/market.go:59-63` 验签失败且 `!allowUnsigned` 直接返回错误。`TestLoadUnsignedRejected` PASS、`TestLoadUnsignedAllowed` PASS（显式 true 才放行，带审计 WARN）。

## C. 关键行为（自造证据）

**C1 端到端安装**：`bin/kored install --package kore-plugin-site/dist/site-0.1.0.tar.gz --state-dir /tmp/kore-verify-state-*` → stdout `installed site 0.1.0`，**EXIT=0**；state.db + state.lock 落盘。

**C2 market 四端点（真服务 + UDS，非 httptest 替代）**：临时重建 `kored`（现场 bin/kored 为 02:26 旧构建，store 端点返 501，非代码缺陷），YAML 配 index_dir 指向真实索引仓、PBKDF2 admin hash，起服务后 login 取 cookie：
- `GET /api/v1/store/plugins` → **HTTP 200**，plugins 按 id 升序 `[echo, site]`（每条含 id/version/depth_level/sha256），零出站。
- `GET /api/v1/store/plugins/echo` → 200；`…/nonexist` → 404 E_NOTFOUND。
- `GET /api/v1/store/jobs/echo` → 501 E_UNSUPPORTED（M3 异步队列，符合源码）。
- 未签名/坏 sig 场景：复制索引 + 破坏 .sig，第二服务 `GET store/plugins` → **401 E_UNAUTHORIZED「索引签名缺失或格式错误」**（默认拒生效）。

**C3 web 首屏**：`make frontend` gzip -9：index.html 287 B + style.css 1550 B + app.js 2314 B = **4151 B ≤ 307200 B（300 KiB）**，EXIT=0。

**C4 lazy（go test -run TestLazy -v ./internal/core/supervisor/）**：**6 个 `--- PASS`、0 SKIP**，EXIT=0：
`TestLazyEvictsLeastRecentlyUsed` / `TestLazyResidentNotEvicted` / `TestLazyEnableNoProcess` / `TestLazyFirstInvokeStarts` / `TestLazySecondInvokeReuses` / `TestLazyIdleExitsAndRespawns`。

## D. 发布与卫生

| 项 | 结果 |
| --- | --- |
| kore git status | clean HEAD a4b3e10 |
| kore-plugin-site git status | clean HEAD e3b832d（已清 verifier 的 `go build ./...` 副作用可执行文件 `kore-plugin-site`） |
| kore-plugins git status | HEAD 6ee7acf；未提交：` M Makefile`、` M README.md`、`?? presets/`、`?? scripts/validate-presets.sh`（如实报，未提交） |
| kore-plugin-echo git status | clean HEAD 10cc6eb |
| git worktree list ×4 | 各仓仅主工作树 1 行，无 wt-* 分支 |
| pgrep -x kored | 0（verifier 起的 2 个服务已停） |
| /tmp 残留 | `kore-verify-*` 临时目录/配置/二进制/日志全部已删，无残留 |

## VERDICT 与分级

**APPROVE**（功能与门禁全绿，M2 五轨可收口），但挂 1 项阻断：

- **阻断 B1 · site 打包非确定性** — `kore-plugin-site/Makefile:18-35`（`dist` 目标的 `tar -czf` 未固定 mtime/顺序）· owner: kore-plugin-site 维护者。修复建议：`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf …` 或在 stage 内 `touch -t` 固定时间戳，并重建索引 sha256 与签名字链后重跑 B1。
- **记录 R1**：verifier 在 A 组执行 `make dist` 改变了 dist 现场，原 site 包 sha 未在重建前采集；"当前包≠索引"不作交付归罪，但非确定性有独立复现证据。
- **记录 R2**：`kore-plugins` 有未提交改动（Makefile/README/presets/validate-presets.sh），M2 变更集 committed 前不得视为已发布。
- **记录 R3**：现场 `kore/bin/kored` 为旧构建（store 端点 501）；验收以源码重建二进制为准，交付前须重 build 更新 bin/。
