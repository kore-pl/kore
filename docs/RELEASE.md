> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5

# RELEASE — 发版规则（版本号 = 包内容的唯一标识）

本文件覆盖两类发布物：**插件**（§1–§3）与**公开 SDK `pkg/pluginapi`**（§4）。§5 是两类共用的 tag 类型口径。

## 0. 一条硬规则

同一 `id@version` 在索引与 release 中**只允许对应一个 sha256**。包内容变了、版本没变，用户按版本号判断就会装到另一份构建上；这是 P0 级流程缺陷。

## 1. 何时 bump

| 改动性质 | 级别 | 例 |
| --- | --- | --- |
| feat（新增能力/方法/界面） | minor +1（0.x 主版本不动，0.2.0 → 0.3.0） | 新方法、真实执行面替换 noop |
| fix / refactor / perf / docs 影响产物 | patch +1 | 逻辑修复、方法改名、嵌入清单调整 |
| 纯文档 / 测试、且不改 dist | 不 bump | 只改 README 注释、测试用例 |
| **任何改变 dist 包 sha 的改动** | **必须 bump** | 打包脚本、`manifest.json`、`info.json.size_bytes`、Go 源码 |

唯一判据：

```bash
sha256sum dist/<id>-<version>.tar.gz          # 与索引同版本 sha 比对
# 不相等 → 必须 bump；禁止改索引 sha 了事
```

## 2. 发版清单（插件，顺序不可跳）

1. **bump**：`info.json` 与 `manifest.json` 的 `version` 同步 +1；`CHANGELOG.md` 顶部加新版本条目（摘要从 `git log <上版本tag>..HEAD` 提取）。
2. **打包**：`make build && make dist`；导出 `sha256` 与 `size_bytes`。
3. **可复现**：同树 `make dist` 两次 sha 一致；`git archive HEAD | tar -x -C /tmp/x && cd /tmp/x && make dist` 的 sha 与第 2 步一致。
4. **提交**：`chore(release): bump vX.Y.Z`（只含 `info.json` / `manifest.json` / `CHANGELOG.md`，用 `kore/scripts/safe-commit.sh`）。
5. **发布**：`git tag -a vX.Y.Z`（**必须 annotated**，见 §5）→ `git push origin vX.Y.Z` → `gh release create vX.Y.Z dist/<id>-<version>.tar.gz`。
6. **索引**：更新 `kore-plugins/index/plugins.json` 的 `version` / `sha256` / `size_bytes` / `download_url`；把新版本追加到 `index/versions.lock.json`；同步 `presets/*.json` 的固定版本。
7. **重签**（长期密钥，ADR-0025）：`KORE_SIGNING_KEY=~/.config/kore/signing/index-signing.seed bash scripts/sign-index.sh` → `bash scripts/validate-index.sh` 正向 exit 0、篡改正文反例非 0 → `make check`。首次播种用 `--generate`，流程见 [SIGNING-KEY-SOP](./SIGNING-KEY-SOP.md)。
8. **市场页（免重启）**：`bash scripts/build-market.sh`。公钥是编译期常量且**永不随重签变化**，日常重签**不需要** `make build`、不需要重启 kored；只有轮换/泄漏应急换公钥时才 `cd ../kore && make build` + 重启一次，见 [RUNBOOK](./RUNBOOK.md) §1。

## 3. 门禁

- `kore-plugins/scripts/validate-index.sh`：schema、`id@version` 唯一、版本单调递增、同版本 sha 锁定、签名。
- `index/versions.lock.json` 是发版账本（非信任源）：索引版本/sha 必须等于账本最新记录；改包不 bump 直接 FAIL。
- 漏 bump 的修复只能「新版本 + 新 release」，**禁止**覆盖同版本 release 资产。

## 4. SDK（pkg/pluginapi）发版流程

SDK 是与内核同仓的**独立 module**：`github.com/pengtang1024/kore/pkg/pluginapi`，版本由 tag `pkg/pluginapi/vX.Y.Z` 承载，没有单独的版本文件。插件只依赖这个公开包（G-07），**不会随 kore 主仓发版自动更新**：SDK 面变了却不打 tag，插件作者就只能手写一份 schema，或跨仓 `replace => ../kore/...`（G-17 明令禁止），协议随即各仓漂移。

### 4.1 触发条件

- `pkg/pluginapi/` 下任何导出 API、协议常量、错误码变化（例：ADR-0018 的 `RootAction` / `ValidateRootAction`）＝**必须发 SDK 版本**；
- 纯注释、纯内部修复也发 patch：插件作者需要能用版本号表达「我依赖这个行为」。

### 4.2 步骤

1. **确认 tag 点内容完整**（发布前唯一可信判据，不要看工作树）：

   ```bash
   git ls-tree -r --name-only HEAD -- pkg/pluginapi/
   git log --oneline -- pkg/pluginapi/
   ```

   新增文件必须已在 `git ls-files`（工作树文件不进 tag）。ADR-0018 的 `rootaction.go` 就是反例：已合入 main，但最新 SDK tag `v0.1.1` 里没有它。
2. **测试**：`cd pkg/pluginapi && GOWORK=off go test -timeout 200s ./...` 全绿（schema 用例在 `rootaction_test.go`）。
3. **打 annotated tag**：

   ```bash
   git tag -a pkg/pluginapi/vX.Y.Z -m "pluginapi vX.Y.Z: <一句话变更>"
   git cat-file -t pkg/pluginapi/vX.Y.Z   # 必须输出 tag；轻量 tag 会输出 commit
   git tag -n pkg/pluginapi/vX.Y.Z
   ```

4. **push tag**：`git push origin pkg/pluginapi/vX.Y.Z`。tag 引用的 commit 随 tag 一起到远端；分支推送由台账任务统一做，发版人只推 tag。
5. **干净目录消费验证（硬门禁，不可省）**：见 §4.3。首次发布要等 proxy 抓取，失败先重试。
6. **证据落盘**：`.agents/verify/sdk-vX.Y.Z.md`，含 4.2 / 4.3 的全部命令、退出码与关键输出。

### 4.3 干净目录消费验证（v0.1.0 retract 教训）

`v0.1.0` 发布时 module 路径还是 `github.com/kore-project/kore/pkg/pluginapi`，tag 打出去了、消费者 `go get` 却解析不到；发布物不可修改、proxy 与 sumdb 会永久缓存，只能 `retract v0.1.0` 再发 `v0.1.1`。**错误只能靠新版本修正，不能在原版本上打补丁**。因此每次发版都必须在工作区之外、`GOWORK=off`、无 `replace` 的干净目录跑一遍：

```bash
cd /tmp && rm -rf sdk-consume && mkdir sdk-consume && cd sdk-consume
go mod init tmpcheck
GOWORK=off go get github.com/pengtang1024/kore/pkg/pluginapi@vX.Y.Z
# 写 main.go 引用本版新增 API（如 pluginapi.RootAction + ValidateRootAction）后：
GOWORK=off go build ./...
GOWORK=off go list -m -versions github.com/pengtang1024/kore/pkg/pluginapi
# 两条取包路径都要验：默认 GOPROXY 与 GOPROXY=direct
cd /tmp && rm -rf sdk-consume
```

判据：`go get` 与 `go build` 均 exit 0，`go list -m -versions` 含新版本；默认 proxy 与 `GOPROXY=direct` 至少各成功一次。proxy 首次抓取有延迟（分钟级），失败先重试，不要立刻改版本号。**禁止**用 `replace` 指向本地目录来让验证通过——那验的是工作树，不是发布物。

### 4.4 插件侧消费口径

SDK `v0.1.3` 起提供统一自检入口 `pluginapitest.CheckInfoJSON(t, "info.json")`：一次校验 `capabilities` / `method_capabilities`（键域、值域、≤64、只收窄不放大）/ `root_actions`（≤16、id 唯一、每条 `ValidateRootAction`，含 ADR-0022 命令形状）。插件应在测试里调用它，不要手写 schema，也不要用跨仓 `replace`；只补形状时可用 `pluginapi.ValidateRootArgv` / `ValidateRootAppendedArgv`。

## 5. tag 类型口径（历史轻量 tag 保留 / 新 tag 一律 annotated）

- **新 tag 一律 annotated**：`git tag -a`（或 `-s` 签名），带作者、日期与说明。自查命令 `git cat-file -t <tag>` 必须输出 `tag`；轻量 tag 输出 `commit`，事后无法回答「谁在何时为什么发版」。
- **历史轻量 tag 保留不动**：仓库里既有的轻量 tag 是既成事实（例：`kore-plugin-firewall` 的 `v0.1.0` / `v0.2.0` / `v0.2.2`、`kore-plugin-ssh-guard` 的 `v0.2.0`、`kore-plugin-waf` 的 `v0.2.0`）。把它们改造成 annotated 需要删除重打 + force push，会破坏已发布版本与索引/账本的对应关系，**禁止**；自本口径起新增的 tag 不得再出现轻量形态。
- **发布后自查**：`git for-each-ref refs/tags --format='%(refname:short) %(objecttype)'`，新增行必须是 `tag`；`git ls-tree -r --name-only <tag> -- pkg/pluginapi/` 必须包含本次发布的全部源文件。
