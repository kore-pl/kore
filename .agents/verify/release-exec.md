# 发版执行报告（release-exec）

> 执行：2026-11-25 · 作者：release-exec · 依据：release-batch-plan.md / release-batch-prep.md + 实测 git status/tag
> **实际待发版 15 仓**（prep 原报告 10 仓 + 后增 app-deploy / backup / cron / integrity / ssh-guard / waf）
> 报告本身随下一批或单独推，本报告**不 push**。

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 推送仓数 | **15 插件仓 + kore(SDK tag) + kore-plugins(索引)**；每仓每远端恰好 1 次 push |
| 三端 main/tag 对齐 | **15/15 ALIGNED**（origin=Gitea / github / gitee，git ls-remote 同 sha） |
| GitHub release | **15/15** 新建（含 dist 资产；--verify-tag） |
| Gitee release | **15/15** 新建（gitee-release-fill.sh --require-dist，脚本内已回读 sha） |
| GitHub 资产回读 | **15/15 MATCH**（curl/urllib 下载 sha256 与本地逐字比对） |
| 索引重签 | **成功**：build-market → sign-index → validate 正例 0 / 篡改反例 1 / validate-presets 0 / market --check 0 |
| SDK | pkg/pluginapi v0.2.0 / v0.3.0 tag 推三端 + 2 个 GitHub release，解决 site go.mod require v0.3.0 的 404 |
| 公钥 | 两处仍为 `3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0`，未变 |
| 失败/卡点 | presets-check 1 项失败：site 的 TestBoundaryNeedRootWhenConfDirRootOwned 在本沙箱 /etc 只读下必然 FAIL（prep §7 阻塞 2 已定性，环境产物，非本批改动）；其余门禁全绿 |

## 1. 关键命令 + 退出码 + 关键输出

### 1.1 补 dist（3 仓，缺包）
- `make dist` ×3：backup@0.5.2 / cron@0.9.0 / integrity@0.6.0 → rc=0/0/0
- 回填 info.json 的 size_bytes 已提交（精确路径）：
  - `[agent:release-exec] chore(release): backup 收口 size_bytes` cf0dcd8
  - `[agent:release-exec] chore(release): cron 收口 size_bytes` 3dcda55
  - `[agent:release-exec] chore(release): integrity 收口 size_bytes` 527058f
- 15 仓 dist 一致性：`shaok=True` 15/15 + `emb==HEAD` 15/15

### 1.2 SDK 先行
- `git push origin pkg/pluginapi/v0.2.0 pkg/pluginapi/v0.3.0` → rc=0
- `git push https://github.com/kore-pl/kore.git <tag1> <tag2>` → rc=0
- `git push https://gitee.com/pengtang1024/kore.git <tag1> <tag2>` → rc=0
- `gh release create pkg/pluginapi/v{0.2.0,0.3.0} -R kore-pl/kore --verify-tag` → rc=0/0
- 三端 ls-remote 均见两个 tag（annotated，peeled f8eb0cb / 29f4fc3）

### 1.3 annotated tag（14 仓；site 已存在未重打）
- 显式钉 peeled sha：`git tag -a v<ver> $(git rev-parse HEAD) -m ...`
- `cat-file -t` = tag、`rev-parse v<ver>^{}` == HEAD，14/14 verified=True
- site：`v0.8.1` type=tag peeled=2a72eadf…（HEAD 8ac2b5bc 的祖先，tag 树与包一致），跳过重打

### 1.4 分阶段批推（硬纪律：每远端×每仓恰好一次 push，带 main+tag）
- 阶段 origin：15/15 rc=0（一次工具调用内循环，每仓一条 `git push origin main v<ver>`）
- 阶段 github：首轮工具超时，读到前 5 仓已落地（main+tag 齐全），**只对剩余 10 仓补推**，无重复推送；10/10 rc=0
- 阶段 gitee：8+7 两批（工具超时保护），15/15 rc=0
- `git ls-remote` 三端逐仓比对 main + tag（annotated 对象 sha）：**15/15 ALIGNED**
- 凭据：全 HTTPS + git credential helper；GITEE_TOKEN 仅在 bash 进程内 `. 10-api-tokens.conf` 加载，未 echo / 未入 argv/文件/提交（secret-check 0 FAIL）
- stderr 中的 `无法在 1000 ms 获得凭证存储锁: 只读文件系统` 为非致命告警，所有 push rc=0

### 1.5 release
- GitHub：`gh release create v<ver> dist/<id>-<ver>.tar.gz -R kore-pl/kore-plugin-<id> --verify-tag --title ... --notes-file <CHANGELOG 段>`，15/15 rc=0
- Gitee：`gitee-release-fill.sh --latest 1 --require-dist --dir <15 仓>`，两批 rc=0，15/15 建 release HTTP 201 + 资产上传 HTTP 201 + 下载回读 sha256 一致 + 公开 GET 200
- 资产回读（独立 curl/urllib）：15/15 http=200 + sha256 MATCH

### 1.6 索引仓
- plugins.json 15 条 version/sha256/size_bytes/download_url 更新；versions.lock.json 只追加 15 条；presets 34 处 pin（8 文件；含新增 5 仓带来的额外 pin）
- `build-market.sh` rc=0（24 插件 3765 字节）
- `sign-index.sh` rc=0（默认私钥；未改公钥、未重启 kored）
- `validate-index.sh` 正例 **rc=0**（6×[OK]）；/tmp 副本篡改 plugins[0].version=9.9.9 → **rc=1**（[FAIL] 基线 sha 不一致），真仓 sha 前后相同，tmp 已清理
- `validate-presets.sh` rc=0（8 预设 / 24 插件 / 0 FAIL / 0 WARN）
- `build-market.sh --check` rc=0（逐字节一致）
- commit `7075840 [agent:release-exec] chore(index): 收录 15 插件新版本 + 账本 + 预设 pin，重签索引，重建 market`（精确 11 路径）
- push origin/github/gitee 各一次 rc=0

### 1.7 门禁
- `make market-check` → rc=0，`[OK] market/plugins.js 与索引逐字节一致（24 个插件）`
- `make store-check` → rc=0，24 pass / 0 fail / 20 warn（README_VERSION_DRIFT，非阻断）
- `make secret-check` → rc=0，0 FAIL / 22 处合规占位
- `make presets-check`：
  - 默认 GOCACHE 只读 → 15 仓 `[setup failed]`（工具链噪声）
  - 设 `GOCACHE=/tmp/gocache-release` 重跑 → 14/15 判据① PASS，唯 site 1 项 FAIL：`TestBoundaryNeedRootWhenConfDirRootOwned` 错误码 `E_INTERNAL` 期望 `E_NEED_ROOT`（msg=打开站点清单锁失败: open /etc/kore-site-manifest.json.lock: read-only file system），与 prep §7 阻塞 2 完全一致，属沙箱 /etc 只读产物；未改 site 在途改动，未触碰运行态

### 1.8 运行态与在途改动保护
- site 6 条在途改动原样保留：`MM apply.go` / `D rollback.go` / `D tests/boundary/rollback_window_test.go` / `?? rollback.go` / `?? tests/boundary/rollback_window_test.go` / `?? zeroparam_test.go`；HEAD 仍 8ac2b5bc
- 未 stash / 未 commit / 未动 site 工作树；推 tag 不需要干净树
- 未 force-push / 未 amend / 未 reset/rebase / 未改公钥 / 未 --generate 新密钥
- /tmp 临时副本（idx-negcase / gocache-release 外的日志文件）用完即删；报告外无临时脚本残留

## 2. 不可回滚清单执行状态

| # | 动作 | 状态 |
| --- | --- | --- |
| R1 | 15 仓 main × 3 端 | 完成（45 次 push，每 (远端×仓) 恰好 1 次） |
| R2 | 15 个 annotated tag × 3 端 | 完成（45 次 push；site tag 免打直接推） |
| R3 | GitHub release + 资产 ×15 | 完成 |
| R4 | Gitee release ×15 | 完成 |
| R5 | kore-plugins main × 3 端 | 完成（3 次） |
| R6 | Gitee release prune 真删 | **未做**（范围外，需单独授权；fill 输出有 WARN） |
| R7 | kore 主仓 105 提交推送 | **未做**（范围外，需单独授权；只推了两个 SDK tag） |
| R8 | 本地索引/签名/commit | 完成 |

## 3. 卡点与后续建议
1. presets-check 的 site 单项失败是环境产物：在有可写 /etc 的会话里复跑预期 8 pass / 0 fail（prep 已用干净 HEAD archive 验证同样的失败形态）。
2. Gitee release 数普遍超保留上限 5（site 8 / ssl 7 / backup 8 等）：按范围未执行 prune；如需清理请单独授权，先 `gitee-release-prune.sh --dry-run`。
3. kore 主仓 origin/main 落后 105 提交：本批未推，需单独立项。
4. store-check 20 条 README_VERSION_DRIFT（WARN）：发版完整性缺口，可在各仓检查点随文档更新收敛，不阻断本批。
