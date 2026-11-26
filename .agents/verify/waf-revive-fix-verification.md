# WAF 规则复活修复独立验收（G-09 / task-153）

- 复核人：`waf-revive-verifier`（独立 verifier，非 `waf-revive-fix`）
- 时间：2026-11-26
- 对象：kore-plugin-waf `63b7b89518328dbb856f8cc51bde7f9d9d6c7954`（父 `861b8de`，即 PRE 快照基线）、kore-plugins `7bf84d782f6c5598fe6f0cfe91c8c9ff222888d2`
- 性质：只读复核；全程未改代码、未 push、未联网、未执行 install/upgrade、未碰 `.kore-local-*` / 8787 / 宿主 nft 表
- 总评：**PASS**

## 总评

五项复核范围（修复代码、真机前后对比、门禁、发版链、git 纪律）全部成立；未发现 BLOCKED 项。verifier 独立复跑了 go test / make check / 三个只读发版校验脚本，均 exit 0；真机前后对比与私有 netns 隔离证据来自修复 worker 原始会话中的命令回读（事件 seq 392/395、400/403、408/411/416/419），本次不重复执行真机探针，避免再次触碰 nft 能力域。

---

## ① 修复代码（PASS）

- `kore-plugin-waf/internal/wafop/rulecalls.go` `applyRuleRemove(name, fromToggle)`：成功删除并回读确认规则消失、内置标记更新**之后**执行：
  ```go
  if !fromToggle {
      r.forgetCustom(name)
  }
  ```
  （第 191–193 行）。调用链核对：`callRuleRemove` → `applyRuleRemove(p.Name, false)`；`callRuleToggle` 非内置 enabled=true → `registryCustom` 查找 → `applyRuleAdd(param, true)`，enabled=false → `applyRuleRemove(p.Name, true)`。因此显式 remove 真删 registry，内置 toggle off 保留 registry 以便 on 恢复。`forgetCustom` 同时删 map 与 order（第 353 行起）。
- `tests/e2e/rule_e2e_test.go` 步骤 12（第 256–269 行）：在步骤 9 remove→步骤 11 内置 `ban-ipv4` toggle off/on 之后，独立 `nftRuleHandles(t, "block-e2e")` 回读断言链里 handle 数为 0、插件 chain 回读也无该规则，并断言再次 `waf.rule.toggle enabled=true` 返回 `E_INVALID`（registry 已清）。符合「独立 nft -j 回读、避免自证循环」的要求。
- `kore/.agents/verify/waf-ruleadd-live.md` 未改：`git log` 最近一次提交仍是 `89a5666 [agent:c1-waf-live]`；工作树文件 sha256 `8dc3d28d…b17` 与 HEAD 保存内容逐字节一致，无 dirty。C1 历史证据保持原样。

## ② 真机前后对比（PASS）

证据取自修复 worker 会话 `fb6069b1-…`（task-152）原始 tool/result：

- **PRE_FIX_PROBE（seq 392 命令 / 395 回读）**：在 `dsh-root /usr/bin/unshare -rn` 私有 netns 内，以 `git archive HEAD`（861b8de）快照运行 `TestReviveProbe`，nftables 1.1.6。结果：`[STEP2 remove] applied=true`，`[NFT after-remove] rules=4: handle=4|5|8|10`（无 `kore-rule-revive-probe`）；`[NFT after-builtin-off RAW]` 出现 `"comment":"kore-rule-revive-probe"`、`dport 9443 + drop`（handle 17）；`[NFT after-builtin-on RAW]` 同规则 handle 24；测试报 `[FAIL 复活] ... nft handles=[24]`，`PRE_FIX_PROBE_EXIT=1`。复活缺陷得到真机复现。
- **POST_FIX_PROBE（seq 400 命令 / 403 回读）**：同样私有 netns、同一聚焦测试，working tree 修复快照。结果：remove 后无该规则；`[NFT after-builtin-off] rules=3: handle=12|14|16`（无该规则）；`[NFT after-builtin-on]` 4 条内置规则 handle=17|18|20|22，**链里彻底没有 `kore-rule-revive-probe`**；`[PASS] ... 未复活`，`POST_FIX_PROBE_EXIT=0`。
- **隔离与零接触**：两轮均 `dsh-root /usr/bin/unshare -rn`，独立 netns、独立 state（harness `t.TempDir()` 下 `state/` 与 unix socket `k.sock`，见 `tests/e2e/harness_test.go:216-248`，不经 TCP 8787）；每轮尾部 `nft delete table inet kore_waf` + `CLEANUP_EXIT=0`，`nft list tables` 为空表集不继承宿主。

  - 宿主侧：worker 以普通用户执行 `nft list tables` 得到 `Operation not permitted`（seq 427，`HOST_NFT_EXIT=1`），verifier 本次复测同样为 `Operation not permitted`，宿主 nft 表未被操作的证据成立。
  - 临时脚本/快照：`.tmp-waf-pre` / `.tmp-waf-post` / `.tmp-waf-e2e-snap` / `.tmp-gocache` 经普通删除失败（部分 root 属主文件）后由 `dsh-root --shell rm -rf` 强制清理（seq 441/443：`RM_EXIT=0`、verify `(all removed)`）；verifier 本次 `find` 复核这些路径均已不存在，工作区无 revive 相关残留。

## ③ 门禁（PASS）

- worker 原始证据（seq 267）：`GOCACHE=<工作区临时缓存> GOWORK=off WAF_E2E_PRIVATE_NETNS=1 go test -count=1 -timeout 200s ./...` → 5 包 ok，`GO_TEST_EXIT=0`。
- worker 原始证据（seq 283/625）：同环境 `make check` → `gofmt: clean` / `go vet` / `go test` 全绿，race 段 SKIP（无 tests/boundary），`MAKE_CHECK_EXIT=0`。
- worker 私有 netns 全量 e2e（seq 411/419）：4 用例 `TestReviveProbe`、`TestPluginLoadsAndDeclaredMethodsDispatch`、`TestRuleAddToggleRemoveAgainstRealNft`、`TestRuleAddRejectsInjectionOnRealNft` 全部 PASS，`FULL_E2E_EXIT=0`。
- **verifier 独立复跑**（本轮，离线 `GOPROXY=off`、临时 GOCACHE 用后即删）：
  ```
  go test -count=1 -timeout 200s ./...   → 5 包 ok，GO_TEST_EXIT=0
  make check                             → gofmt clean / vet / test 全绿，MAKE_CHECK_EXIT=0
  ```
  与实际 HEAD `63b7b89` 一致。

## ④ 发版链（PASS）

- 版本：`info.json` 4 行 `version=0.5.4`、`manifest.json` 3 行 `version=0.5.4`（父提交为 0.5.3）；`CHANGELOG.md` 首条为 `## 0.5.4 — 2026-11-26` fix 条目，包含显式 remove 清 registry 与回归断言说明。
- sha 四处一致（本轮 Python/命令实测）：
  - dist 实际 `sha256sum kore-plugin-waf/dist/waf-0.5.4.tar.gz` = `6873f0d317b736664979782514bace6514cc9de851ca5c6df81550afd31d9a7c`
  - `dist/waf-0.5.4.tar.gz.sha256` 内容同值，`sha256sum -c` = OK
  - `kore-plugins/index/plugins.json` waf：`version=0.5.4`、`sha256` 同值、`size_bytes=2947681`、`download_url=…/v0.5.4/waf-0.5.4.tar.gz`
  - `kore-plugins/index/versions.lock.json` waf 数组末项：`version=0.5.4`、`sha256` 同值
- size：`stat` 实测 tarball = 2947681 B，与 `plugins.json` 一致。`info.json` 内 `size_bytes=2947683`（包内 info.json 同值）与实际差 2，属 `kore-plugin-waf/Makefile:54-85` 设计的自引用 ±2 收敛窗口（要求偏差 ≤2），非证据不成立。
- 二次打包 sha 不变（可重现）：worker 报告 `REPRODUCIBLE=YES`（seq 652/653），本轮只读验证 tar 包 `sha256sum -c` OK；未由 verifier 再执行写操作 `make dist`。
- 索引同步：`index/plugins.json.sig` 在 7bf84d7 中更新；`market/plugins.js` waf→0.5.4；`presets/full.json` 与 `presets/security.json` waf→0.5.4。
- **verifier 独立复跑三个只读门禁**（本轮，全部 exit 0）：
  ```
  bash scripts/validate-index.sh       → 24 条全量 ed25519 验签通过，VALIDATE_INDEX_EXIT=0
  bash scripts/build-market.sh --check → market/plugins.js 与索引逐字节一致（24 插件），BUILD_MARKET_CHECK_EXIT=0
  bash scripts/validate-presets.sh     → 8 预设 / 24 插件 / 0 FAIL / 0 WARN，VALIDATE_PRESETS_EXIT=0
  ```

## ⑤ git 纪律（PASS）

- 精确提交 + DCO：
  - waf `63b7b89`：`[agent:waf-revive-fix] fix(rule): 显式 remove 清 registry 防 rebuildChain 复活 + v0.5.4`，`Signed-off-by: pengtang1024 <pengtang1024@qq.com>`；5 文件（CHANGELOG.md、info.json、internal/wafop/rulecalls.go、manifest.json、tests/e2e/rule_e2e_test.go）。
  - plugins `7bf84d7`：`[agent:waf-revive-fix] chore(index): 同步 waf 0.5.4 并重置索引签名`，`Signed-off-by` 同上；6 文件（index/plugins.json、index/plugins.json.sig、index/versions.lock.json、market/plugins.js、presets/full.json、presets/security.json）。
- 未 push：waf `main` 领先 `origin/main`（远程 ref `861b8de`）1 commit；plugins `main` 领先 `origin/main`（远程 ref `92aa146`）5 commit；github/gitee 跟踪 ref 亦未含两个修复 commit。
- worktree：两仓 `git worktree list` 均仅主树一行。
- 他人 dirty 原样：waf `?? internal/wafop/zeroparam_test.go`；plugins `?? .tmp-validate-out.txt`、`?? dist/`；本轮未做任何 add/commit/push/清理这些文件。
- 未打 tag / 未建 Release（worker 报告确认；本轮未执行任何此类操作）。

## 纪律与局限

- 本 verifier 的写入仅限本报告文件；随后按精确路径 `git add .agents/verify/waf-revive-fix-verification.md` + `git commit -s`（DCO），不改其他仓文件、不 push。
- 真机 PRE/POST 探针本轮未重复执行（会触及 nft 能力域），结论基于修复 worker 原始会话的命令+退出码+`nft -j` 回读原文，并经隔离路径/清理证据交叉核对；其余可离线复跑的门禁均已独立复跑且 exit 0。
