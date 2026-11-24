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
| **任何改变 dist 包 sha 的改动** | **必须 bump** | 打包脚本、`manifest.json`、`info.json.size_bytes`、Go 源码、`go.mod` / `go.sum`（依赖升级） |

唯一判据：

```bash
sha256sum dist/<id>-<version>.tar.gz          # 与索引同版本 sha 比对
# 不相等 → 必须 bump；禁止改索引 sha 了事
```

### 1.1 `go.mod` / `go.sum` 依赖升级也算「改变 dist sha 的改动」，必须 bump

**判据不看「改没改业务代码」，只看 `make dist` 出来的 sha 变没变。** 升级 `pkg/pluginapi` 等依赖会改变编进包的模块版本与构建元数据（`go version -m` 可见 dep 版本与 `h1:` 校验），即使 `main.go` 一行没动，dist 字节也会变——必须 bump 版本。

2026-11-23 `firewall@0.2.3` 就是栽在这里：12:38 在 `3325ce7` 上把 `go.mod` / `go.sum` 从 pluginapi v0.1.1 升到 v0.1.2，**`info.json` 版本仍是 0.2.3**；13:28 在该树上跑 `make dist` → 本地 `dist/firewall-0.2.3.tar.gz` 变成 `9c637faa…`，而已发布资产与索引记录的仍是 `353d5626…`。同 `id@version` 双 sha 由此产生，并按 §0 只能「新版本 + 新 release」修正（§3）；本地那份野产物**没有任何发布物对应**，却让 round5 验收报了 `SHA_DIFF firewall 0.2.3`——索引没错，核对口径被污染。

**自检（打包前必看）**：`git diff --stat` 里只要出现 `go.mod` / `go.sum`，就当作会改 dist，先按 §1 表 bump、再打包；禁止用"只升了个依赖"当不 bump 的理由。本地 dist 与索引不一致现由 `make store-check` 的 `DIST_SHA_DIFF` WARN 检出（`make check` 14/17 段）——**检出不等于允许**，它只是把野产物暴露出来，不允许据此改索引或覆盖同版本资产。

### 1.2 `make dist` 会改写工作区 `info.json` 的 `size_bytes`

`make dist` 不只是"打个包"：它按新包体回填**工作区** `info.json` 的 `size_bytes`（文件被改写，`git status` 会多出一条 `M info.json`）。两个容易踩的后果：

- 以为"只跑了个打包命令、没改任何文件"→ 实际工作区已变，干净度判断与后续提交范围必须重新核对；工作树里的野值会像 firewall 那次一样（`2808490`）残留到下次打包才被覆盖，且**从未进过 git**，`git log -S` 查不到。
- 该字段**只随要发版的那个检查点提交**（和 `info.json` 的 bump 同一提交）。顺手提交一个没 bump 版本时的 `size_bytes`，等于给同 `id@version` 制造第二个内容标识。

打包后固定核对：`git diff --stat` 只应包含本次发版该有的 `info.json`（版本 + `size_bytes`）；纯验证性打包留下、且不在发版检查点内的改动，用 `git checkout -- info.json` 还原后再继续。

### 1.3 `size_bytes` 两套口径（自指悖论，不是 bug，别互相怀疑）

同一个插件在两个位置各有一个 `size_bytes`，**它们本来就不该相等**：

| 位置 | 含义 | 权威性 |
| --- | --- | --- |
| `kore-plugins/index/plugins.json` 的 `size_bytes` | release 资产**实测**字节数 | **权威**：下载校验、安装体积预检、商店展示一律以它为准 |
| 插件仓 `info.json` 的 `size_bytes` | `make dist` 回填的**自指估算值** | 仅预检参考，**不作判定依据** |

**为什么不可能恒等**：`info.json` 本身被打进 `dist/<id>-<ver>.tar.gz`，改这个数字就改了包体——数字位变化会移动 deflate 块边界，并改变包内 `SHA256SUMS` 里 `info.json` 的摘要行，于是"声明值"追不上"含声明值的包体长度"，只能逼近不动点。实测 `包体 − 声明` 在 **−29..+32** 区间呈稀疏混沌映射，**不是 ±1/±2 的微抖**。

**核实过的校验口径**（`kore-plugins/scripts/validate-index.sh`）：脚本**只校验它是非负整数**，不与包体比对，**也不存在任何 ±32 容差判定**——`−29..+32` 是脚本头注释记录的实测观测区间，**不是门禁阈值**，别拿它当"允许偏差"用。

**对不上时怎么判**（按序执行，不要先怀疑对方）：

```bash
stat -c%s dist/<id>-<ver>.tar.gz                 # 或 curl -sSL <download_url> | wc -c
```

1. 上面这条量出的是**权威值**。索引 == 权威值 → 正常，结束。
2. 索引 ≠ 权威值 → **真错**：把索引改成实测值，同轮重签（§2 第 7 步）。
3. 索引 == 权威值、`info.json` 落在 −29..+32 内 → **自指偏差，不是缺陷**。禁止改 `info.json` 去"对齐"——那会让包体变一次、索引再漂一次。
4. `info.json` 偏差超出 −29..+32 → 大概率是 `make dist` 之后又改了源码却没收新包（回填值过期），按 §1 重新打包/bump，不要只改数字。

**已有实证**：`file@0.3.4` 索引 `1697251`（= 资产实测，sha `d72346a6…` 与索引逐字一致）、`info.json` `1697250`，差 −1，属第 3 条；`ssh-guard@0.3.0` 实测 2840608 vs 声明 2840609 同理；`container@0.5.1` 用「±64 窗口精确优先搜索」拿到过不动点 1527626（声明 == 实测）——**精确点存在但不保证**。

## 2. 发版清单（插件，顺序不可跳）

1. **bump**：`info.json` 与 `manifest.json` 的 `version` 同步 +1；`CHANGELOG.md` 顶部加新版本条目（摘要从 `git log <上版本tag>..HEAD` 提取）。
2. **打包**：`make build && make dist`；导出 `sha256` 与 `size_bytes`。
3. **可复现**：同树 `make dist` 两次 sha 一致；`git archive HEAD | tar -x -C /tmp/x && cd /tmp/x && make dist` 的 sha 与第 2 步一致。
4. **提交**：`chore(release): bump vX.Y.Z`（只含 `info.json` / `manifest.json` / `CHANGELOG.md`，用 `kore/scripts/safe-commit.sh`）。
5. **发布**：`git tag -a vX.Y.Z <sha>`（**必须 annotated 且显式钉住提交 sha，不钉 HEAD**，见 §2.1/§5）→ `git push origin vX.Y.Z` → `gh release create vX.Y.Z dist/<id>-<version>.tar.gz`。
6. **索引**：更新 `kore-plugins/index/plugins.json` 的 `version` / `sha256` / `size_bytes` / `download_url`；把新版本追加到 `index/versions.lock.json`；同步 `presets/*.json` 的固定版本。
7. **重签**（长期密钥，ADR-0025）：`KORE_SIGNING_KEY=~/.config/kore/signing/index-signing.seed bash scripts/sign-index.sh` → `bash scripts/validate-index.sh` 正向 exit 0、篡改正文反例非 0 → `make check`。首次播种用 `--generate`，流程见 [SIGNING-KEY-SOP](./SIGNING-KEY-SOP.md)。
8. **市场页（免重启）**：`bash scripts/build-market.sh`。公钥是编译期常量且**永不随重签变化**，日常重签**不需要** `make build`、不需要重启 kored；只有轮换/泄漏应急换公钥时才 `cd ../kore && make build` + 重启一次，见 [RUNBOOK](./RUNBOOK.md) §1。

## 2.1 发版窗口冻结与 tag 钉 sha（2026-11-23 kore-plugin-waf v0.4.1 事故）

**事故**：`v0.4.1` 的 tag 一度指向 `244ddad`（该提交的 `info.json` 已经是 **0.4.2**），而 release 挂的资产是从 `23f8b7a` 打出的 `201635ab…` / 2934045 B。根因不是手滑，而是**发版窗口内该仓仍有源码提交**：另一轨道在 `23f8b7a` 之后提交了 0.4.2 的测试与 bump，发版方按默认 HEAD 打了 tag。tag 与资产不是同一棵树，同版本出现两个内容标识。

**规则 1：发版窗口冻结。** 某仓一旦开始「打 tag → 推三端 → 建 release」，该仓**立即冻结源码提交**，直到 tag 与 release 资产双向核对完成；同一时刻**一个仓只允许一个发版动作在跑**。窗口内需要改代码时，取消本次发版、按新版本号重来——不允许"边发边改"。

**规则 2：tag 必须钉住提交 sha，不钉 HEAD。**

```bash
git tag -a v<ver> <sha> -m "..."      # 显式给 sha，禁止省略参数走默认 HEAD
git cat-file -t v<ver>                # 必须输出 tag（annotated）
git ls-remote --tags origin 'v<ver>*' # 回读 v<ver>^{} 必须 == <sha>
git rev-parse v<ver>^{}               # 与"该版本 dist 是从哪棵树打出来的"逐字对上
```

反例（本次）：`v0.4.1` → `244ddad`，而资产 `201635ab…` 来自 `23f8b7a`——**tag 的 peeled sha ≠ 打 dist 的树**，事故成立。事后对齐 tag 与资产只是事故处置；已推送的 tag 不允许 force push 移动，按 §0 只能「新版本 + 新 release」。

**发布后自查清单（3 条，缺一不得宣布发版完成）：**

1. tag 的 peeled sha == 打 dist 用的那棵树：`git rev-parse v<ver>^{}` == 打 dist 时所在 HEAD；
2. release 资产 sha256 == 该树 dist sha256：`curl -sSL <资产 url> | sha256sum` 与 `sha256sum dist/<id>-<version>.tar.gz` 一致；
3. `info.json` 的版本 == tag 版本：`git show v<ver>:info.json | grep '"version"'`。

## 2.2 代理可见性门禁（SDK / module 发布）

发布 SDK tag 后，**默认 GOPROXY 可能尚未索引新版本**，此时不能宣布"可消费"。实测 `pluginapi v0.1.5`：默认 `go get` 180s 超时，`GOPROXY=direct` 立即成功。

- 判据：干净目录（`GOWORK=off`、无 `replace`）`go get <module>@vX.Y.Z` 走**默认 GOPROXY** 成功，且 `go list -m -versions` 列出该版本；
- proxy 首次抓取是分钟级延迟：失败先重试/等待，**不要**改版本号或 retract 掩盖；同时记录 `GOPROXY=direct` 结果作对照；
- 两条路径都通过后，才把"干净目录消费验证"写进证据。

## 2.3 索引延迟反例（商店显示旧版本）

2026-11-23 事故：索引重签与主实例 `index_dir` 回切不同步，8787 把 `discover 0.2.0` 显示成 `0.1.0`。发版后必须核对**三方版本一致**：

- release tag 版本 == `kore-plugins/index/plugins.json` 的 `version` == `GET /api/v1/store/plugins` 返回版本；
- 索引更新/重签/主实例回切未完成前，不得宣布发版完成；索引侧延迟不是"已发布"。

### 2.4 改索引必须同轮重建 `market/plugins.js`（否则商店页与索引各说各话）

`market/index.html` 的数据源是 `market/plugins.js`（`window.KORE_PLUGINS`），由 `scripts/build-market.sh` 从 `index/plugins.json` **生成后落盘为静态文件**；页面运行期**不再读索引**。所以索引改了，商店页**不会自己跟着变**。

- **规则**：凡改动 `index/plugins.json`（哪怕只改一个 `version`），**同一提交**必须跑 `bash scripts/build-market.sh`，把 `market/plugins.js` 一起提交。
- **不重建的后果**：`market/index.html` 显示旧版本、索引是新版本——商店页与索引各说各话。2026-11-24 `backup-release-050` 标出的正是这个坑：当时 `market/plugins.js` 是「顺带对齐了 `file` 的版本」才没暴露，而它本该由 `file` 轨道自己重建。
- **门禁**：`kore-plugins/scripts/validate-index.sh` 第 1c 步已内置一致性校验（调用 `build-market.sh --check` 做 byte 级比对，失败时直接列出 market 与 index 的版本差异）；`cd kore-plugins && make check` 即覆盖。**不要再靠人记**。

## 3. 门禁

- `kore-plugins/scripts/validate-index.sh`：schema、`id@version` 唯一、版本单调递增、同版本 sha 锁定、**`market/plugins.js` 与索引 byte 级一致（§2.4）**、签名。
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
