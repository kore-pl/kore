# waf 0.5.4 发版就绪只读预检 + 防 echo 式 404 清单

> 任务：task-154（持续目标 round 11）｜角色：release-readiness（只读预检 worker）
> 时间：2026-11-27（Asia/Shanghai）｜工作目录：`/home/pt/Work/GolandProjects/kore-pl`
> 性质：**只读预检**。未 push、未打 tag、未建 Release、未改代码；仅执行只读 GET download_url 与 git fetch 探针。
> 背景：waf 规则复活修复（安全缺陷，task-152/153）已验收 PASS，waf `63b7b89` / plugins `7bf84d7` / 验收报告 `992eeea` 均已 commit 未 push；索引已指向 waf 0.5.4，但远端资产未发布（用户发版授权问询被中断）。本卡预检就绪度并产出可复用清单，防止 echo 0.1.7 式"索引超前发布→404"复发。

---

## 结论速览

| 预检项 | 结论 |
| --- | --- |
| 1. 提交态 | 三仓均 main、HEAD 与预期一致、均**未 push**（领先三端 1/5/30）、他人 dirty 原样 |
| 2. tag 就绪 | 本地+v0.5.4 三端远端**均无**（符合预期）；v0.5.3 签名 tag 三端齐全、`tag -v` Good signature（范本可用） |
| 3. FF 预检 | **纯 FF（无分叉）**：waf/plugins 对 github/origin/gitee 三端 `merge-base --is-ancestor <remote>/main HEAD` 全 exit=0，无 dependabot 分叉，**无需方案 A 预处理** |
| 4. 资产就绪 | tar 内容/info/sha 四处一致全部通过；`download_url` GET **404（符合预期，尚未发布）**；对照已发布 v0.5.3 返回 200 |
| 5. 防 404 清单 | 已产出（见 §5），含 GET 200 判据 + sha 比对 + tag 存在性 + 三端 Release 回读 + echo 教训 |

**总评：发版前置条件就绪（纯 FF、资产自洽、tag 三端干净）。唯一缺口是远端资产尚未发布——这正是发版动作本身要填的，不是阻塞。** 一旦用户批准发版，按 §5 清单执行即可，且必须最后校验 download_url 由 404→200。

---

## 1. 提交态：HEAD / 领先 origin / 他人 dirty 基线

### 1.1 三仓 HEAD + 分支 + 领先数

命令与退出码：

```
git -C <repo> branch --show-current          → EXIT=0（均 main）
git -C <repo> rev-parse HEAD                 → EXIT=0
git -C <repo> rev-list --count origin/main..main → EXIT=0
```

| 仓 | 分支 | HEAD | 领先 origin/main | 领先 github/main | 领先 gitee/main |
| --- | --- | --- | --- | --- | --- |
| kore-plugin-waf | main | `63b7b89518328dbb856f8cc51bde7f9d9d6c7954` | 1 | 1 | 1 |
| kore-plugins | main | `7bf84d782f6c5598fe6f0cfe91c8c9ff222888d2` | 5 | 5 | 5 |
| kore | main | `992eeeaf830446359d098ac05045b50b0c4b704e` | 30 | (未逐端计，逻辑同源) | (未逐端计) |

HEAD 与任务描述预期一致：waf `63b7b89`（规则复活修复+0.5.4）、plugins `7bf84d7`（同步 waf 0.5.4 并重签）、kore `992eeea`（G-09 验收报告）。三仓均领先远端 → **未 push**。

### 1.2 他人 dirty 基线（`git status --porcelain`，EXIT=0，原样保留未触碰）

- **kore-plugin-waf**：`?? internal/wafop/zeroparam_test.go`（他人未跟踪测试文件，保持原样）
- **kore-plugins**：`?? .tmp-validate-out.txt`、`?? dist/`（他人产物/临时文件，保持原样）
- **kore**：` M scripts/usability-pending.txt` + 多条 `?? .agents/verify/*.md`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`、`?? data/`、`?? dist/`（他人 dirty，保持原样）

> 本报告仅新增 `kore/.agents/verify/waf-0.5.4-release-readiness.md` 一个文件，不触碰上述任何 dirty 项。

---

## 2. tag 就绪：本地 + 三端 v0.5.4 存在性、v0.5.3 签名范本

### 2.1 v0.5.4 存在性（预期均无）

```
git -C kore-plugin-waf tag -l 'v0.5.4' 'v0.5.3'                    → EXIT=0，仅输出 v0.5.3（无 v0.5.4）
GIT_SSH_COMMAND="ssh -F ~/.ssh/config ..." \
  git -C kore-plugin-waf ls-remote --tags <remote> refs/tags/v0.5.4 → EXIT=0，输出仅 v0.5.3（三端均无 v0.5.4）
git -C kore-plugin-waf ls-remote --tags origin refs/tags/v0.5.4    → EXIT=0，输出仅 v0.5.3
```

| 位置 | v0.5.4 | v0.5.3 |
| --- | --- | --- |
| 本地 waf | **不存在**（`tag -l v0.5.4` 无输出） | 存在 |
| github 远端 | **不存在** | `e98b892…`（annotated tag 对象） |
| gitee 远端 | **不存在** | `e98b892…` |
| origin（gitea）远端 | **不存在** | `e98b892…` |

→ 三端 + 本地均无 v0.5.4，**打 tag 不会撞远端**；v0.5.3 三端一致，可作发版范本。

### 2.2 v0.5.3 签名 tag 范本（`tag -v` Good signature）

```
git -C kore-plugin-waf tag -v v0.5.3   → EXIT=0
```

输出：
```
Good "git" signature for pengtang1024@qq.com with ED25519 key SHA256:rmD48/4QMXSKhsVWi85ks7TMYDXTwSVInMW2ioP3r/I
object 861b8de603db8fb3b66f7844c6325b5de8749fb3
type commit
tag v0.5.3
tagger pengtang1024 <pengtang1024@qq.com> 1795683570 +0800
A3 文案清理 + dependabot 合并（v0.5.3）
```

```
git -C kore-plugin-waf cat-file -t v0.5.3 → EXIT=0，输出 `tag`（annotated tag，非 lightweight）
```

→ 签名链（gpg.format=ssh + ED25519 + Good "git" signature）就绪，v0.5.4 应按同一方式 `git tag -s`。

---

## 3. FF 预检（关键）：fetch 三端后逐仓 merge-base is-ancestor

> 背景：A3 发版（task-104/105）曾遇 github/main 上 dependabot[bot] 的 ci.yml actions v7 bump 提交与本地分叉，当时走方案 A（merge→重打 dist→重签 tag）。本轮重点排查是否重现。

### 3.1 fetch 三端（只读探针）

```
GIT_SSH_COMMAND="ssh -F ~/.ssh/config -o ControlMaster=no -o ControlPath=none -o BatchMode=yes -o ConnectTimeout=20" \
  git -C <repo> fetch github main   → EXIT=0（waf、plugins 均 0）
同上 fetch gitee main              → EXIT=0
git -C <repo> fetch origin main    → EXIT=0
```

fetch 后用 `ls-remote refs/heads/main` 交叉核对，远端实际 main tip 与本地 remote-tracking ref 完全一致（避免了"基于过时缓存误判"）：

| 仓 | 三端 ls-remote main tip | 本地 refs/remotes/{github,origin,gitee}/main |
| --- | --- | --- |
| kore-plugin-waf | `861b8de603db8fb3b66f7844c6325b5de8749fb3`（三端同） | 同为 `861b8de…` |
| kore-plugins | `92aa146e45f12207c6e96fba122d6dee5431944c`（三端同） | 同为 `92aa146…` |

### 3.2 is-ancestor 结论

```
git -C <repo> merge-base --is-ancestor refs/remotes/<remote>/main HEAD  → EXIT=0 表示 FF 可推
```

| 仓 | github/main → HEAD | origin/main → HEAD | gitee/main → HEAD | 反向 HEAD→remote/main | merge-base |
| --- | --- | --- | --- | --- | --- |
| kore-plugin-waf | **EXIT=0** | **EXIT=0** | **EXIT=0** | EXIT=1（本地领先，正常） | `861b8de…` |
| kore-plugins | **EXIT=0** | **EXIT=0** | **EXIT=0** | EXIT=1（本地领先，正常） | `92aa146…` |

**FF 预检结论：纯 FF（无分叉）。** waf 与 plugins 两仓对 github/origin/gitee 三端的 `merge-base --is-ancestor` 全部 exit=0，远端 main 是本地 HEAD 的祖先，反向为 1（本地领先），merge-base 恰等于远端 tip。

- **未发现 dependabot ci.yml 分叉提交**（不像 A3 轮 github/main 曾出现的 actions v7 bump）。
- **无需方案 A 预处理**（不合并、不重打 dist、不重签 tag）。三个远端当前 main 均停留在上一版提交（waf 861b8de / plugins 92aa146），本地这 1/5 个领先提交可直接快进推送。
- 推 tag 前仍按 §2 复核三端 v0.5.4 不存在即可。

---

## 4. 资产就绪：dist/waf-0.5.4.tar.gz

### 4.1 tar 内容 + info version

```
tar -tzf kore-plugin-waf/dist/waf-0.5.4.tar.gz          → EXIT=0
```
输出：`info.json`、`bin/`、`bin/waf`、`SHA256SUMS`（四项齐全，符合 RELEASE 要求）。

```
tar -xzOf dist/waf-0.5.4.tar.gz info.json                → EXIT=0
```
`"version": "0.5.4"`、`"id": "waf"`、`"size_bytes": 2947683`（自指估算值，见 §4.3 口径说明）。
```
tar -xzOf dist/waf-0.5.4.tar.gz SHA256SUMS              → EXIT=0
```
```
703870e9… info.json
b64835f3… bin/waf
```

### 4.2 sha256sum -c（两处）

```
cd kore-plugin-waf/dist && sha256sum -c waf-0.5.4.tar.gz.sha256  → EXIT=0，输出 `waf-0.5.4.tar.gz: OK`
```
> 注：`.sha256` 文件内是裸文件名，必须在 `dist/` 目录内执行；在仓根直接执行会因找不到裸名文件而 exit=1（预检时已按正确口径复核）。

解包后对内部清单：
```
( cd <tmpd> && sha256sum -c SHA256SUMS )  → EXIT=0，`info.json: OK`、`bin/waf: OK`
```
（临时解包目录用完已删除，`ls .verify-tmp-*` EXIT=2 确认无残留。）

### 4.3 四处 sha 一致 + 字节数

| 位置 | 值 |
| --- | --- |
| ① 实测 `sha256sum dist/waf-0.5.4.tar.gz` | `6873f0d317b736664979782514bace6514cc9de851ca5c6df81550afd31d9a7c` |
| ② `.sha256` 文件 | `6873f0d3…9a7c`（与①同） |
| ③ `index/plugins.json` waf.sha256 | `6873f0d3…9a7c`（与①同） |
| ④ `index/versions.lock.json` waf[0.5.4].sha256 | `6873f0d3…9a7c`（与①同） |

**四处逐字节一致。** 索引版本 `0.5.4`、size_bytes=2947681、`stat -c%s dist/waf-0.5.4.tar.gz`=2947681（EXIT=0，实测字节 == 索引权威值）。presets 两处 pin（security.json:30、full.json:100）均为 `0.5.4`。

> 口径说明（RELEASE.md §1.3）：`info.json.size_bytes`=2947683 是 `make dist` 回填的**自指估算值**，`index/plugins.json.size_bytes`=2947681 是**实测权威值**，二者本就不相等（差 +2，在 −29..+32 的实测观测区间内），非缺陷、不作门禁阈值。

索引健康度对照（额外只读核验）：
```
cd kore-plugins && bash scripts/validate-index.sh   → EXIT=0
```
输出含 `[OK] ed25519 签名验证通过（内置公钥）`、`[OK] 索引校验全部通过`（24 条 schema/账本/预设/market/签名全绿）。

### 4.4 download_url 现状 GET（预期 404）

```
curl -sS -L -o /dev/null -w '%{http_code}' \
  https://github.com/kore-pl/kore-plugin-waf/releases/download/v0.5.4/waf-0.5.4.tar.gz
  → EXIT=0，http_code=404
curl -sSI -L <同上> | grep -iE '^HTTP/'  → EXIT=0，输出 `HTTP/2 404`
```

- 索引记录的 `download_url`：`https://github.com/kore-pl/kore-plugin-waf/releases/download/v0.5.4/waf-0.5.4.tar.gz`
- **现状 404（符合预期：远端资产未发布）**。发版后此处应变为 **200**，是 §5 清单的硬性收口判据。

正对照（证明探测方法本身有效）：

| URL | GET 结果 | 说明 |
| --- | --- | --- |
| waf v0.5.4 资产 | **404** | 本轮待发布 |
| waf v0.5.3 资产（已发布） | 200 | 正向对照，方法可信 |
| echo v0.1.7 资产（task-113 已修复发布） | 200 | echo 404 已消除的实证 |

---

## 5. 防 404 清单（可复用）：索引版本必须对应已发布资产

> 为什么需要：**echo v0.1.7 教训**——此前索引/升级提示已指向 echo 0.1.7（`download_url` 写好了），但资产从未真正发布到 Release，用户点击升级得到「包下载或摘要校验失败：HTTP 404」。根因是**索引先行、资产未落地**，而发版流程当时没有"download_url 必须 GET 200"的收口判据。task-113 已真正发布 echo v0.1.7 把 404 修成 200，但流程缺口需要靠本清单固化，防止 waf 0.5.4 或其他插件重演。
> 当前 waf 0.5.4 正处于"索引已指向、资产未发布"的状态（GET 404）——与 echo 事故前的危险状态相同。这正是**发版动作本身要消除**的状态，清单的第 6 步就是硬收口。

发版批准后的执行顺序（每步记录命令+退出码）：

1. **FF 复检（推送前）**：fetch github/origin/gitee main，对每仓 `git merge-base --is-ancestor <remote>/main HEAD`（exit=0 才可推）；同时 `ls-remote --tags <remote>` 确认 v0.5.4 三端仍不存在。若出现 dependabot 分叉 → 走方案 A（merge→重打 dist→重签 tag）后再推。
   - *本轮 waf/plugins 已预检：纯 FF，无分叉（见 §3）。*
2. **打签名 tag**：在打包 HEAD（waf `63b7b89`）上 `git tag -s v0.5.4 -m "…"`；`git tag -v v0.5.4` 须含 `Good "git" signature`；确认 tag peeled commit == 打包 HEAD。范本见 §2.2（v0.5.3）。
3. **推三端**：一批推 `git push <remote> main v0.5.4`（origin→github→gitee，SSH 绕法 + gitea insteadOf），逐端贴退出码；推完 `ls-remote` 回读 main + tag == 本地。不 force、不删历史 tag。
4. **建 Release 并挂资产（仅 GitHub）**：先 `gh release view v0.5.4 --repo kore-pl/kore-plugin-waf` 探测，已存在跳过不覆盖；否则 `gh release create v0.5.4 dist/waf-0.5.4.tar.gz dist/waf-0.5.4.tar.gz.sha256 --repo kore-pl/kore-plugin-waf --title "v0.5.4 WAF 规则复活修复" --generate-notes`。
5. **三端 Release 资产回读**：`gh release view v0.5.4 --json tagName,assets` 确认 tagName=v0.5.4、两个资产 state=uploaded；Gitee/Gitea 若建了 Release 同样回读资产存在。
6. **download_url GET 200 判据（硬收口，echo 教训的直接防线）**：对索引里每个新版本执行
   ```
   curl -sS -L -o /dev/null -w '%{http_code}' <index.plugins[].download_url>
   ```
   **必须 == 200**（waf 0.5.4 现状 404 → 发布后必须翻转为 200，未翻转则发版未完成，禁止进入下一步）。echo 当时缺的就是这一步。
7. **远端资产 sha 比对（端到端，不只比本地）**：把下载下来的资产算 sha256，与索引 `sha256`、`.sha256`、本地 dist 实测三者比对一致：
   ```
   curl -sSL <download_url> -o /tmp/<asset> && sha256sum /tmp/<asset>
   ```
   须等于 `6873f0d3…9a7c`（waf 0.5.4）。防止"URL 200 但资产错版/被替换"。
8. **索引一致性收尾**：确认 `index/plugins.json`（version/sha/size/download_url）、`index/versions.lock.json`、`presets/*.json` pin、`market/plugins.js` 四处仍与实测一致（见 §4.3）；`validate-index.sh` + `build-market --check` exit=0；若合并 dependabot 改了树（改 dist sha）则按 RELEASE.md §0 bump + 重打 dist + 重签索引后再走 6/7。
9. **本地实例可见性（可选，用户常设要求）**：部署后确认商店里 waf 显示 0.5.4、`download_url` GET 200，登录需口令的子项无口令则标 NOT VERIFIED，不喂口令。

**一条红线**：索引里出现的任何版本，其 `download_url` 在**发版收口时必须 GET 200**；不允许"索引已写、资产待发"的悬空状态停留到发版结束——这正是 echo v0.1.7 404 与 waf 0.5.4 当前 404 的共同根因形态。

---

## 附：本次预检执行的命令清单（均为只读）

| 项 | 命令 | 退出码 |
| --- | --- | --- |
| 1 | `git -C <3仓> branch --show-current` / `rev-parse HEAD` / `status --porcelain` / `rev-list --count origin/main..main` | 全 0 |
| 2 | `git -C waf tag -l` / `tag -v v0.5.3` / `cat-file -t v0.5.3` | 0 / 0(Good) / 0(tag) |
| 2 | `git -C waf ls-remote --tags {github,gitee,origin} refs/tags/v0.5.4` | 0（均无输出 v0.5.4） |
| 3 | `git -C {waf,plugins} fetch {github,gitee,origin} main` | 全 0 |
| 3 | `git -C {waf,plugins} ls-remote {github,gitee,origin} refs/heads/main` | 全 0（tip == tracking ref） |
| 3 | `git -C {waf,plugins} merge-base --is-ancestor <remote>/main HEAD` ×3 | 全 0（纯 FF） |
| 4 | `tar -tzf dist/waf-0.5.4.tar.gz` / `tar -xzOf ... info.json` / `SHA256SUMS` | 全 0 |
| 4 | `sha256sum dist/waf-0.5.4.tar.gz` / `stat -c%s` | 0（`6873f0d3…` / `2947681`） |
| 4 | `cd dist && sha256sum -c waf-0.5.4.tar.gz.sha256` | 0（OK） |
| 4 | `python3` 读 `index/plugins.json` + `index/versions.lock.json` + presets | 0（四处 sha 一致、pin 0.5.4） |
| 4 | `bash kore-plugins/scripts/validate-index.sh` | 0（全绿含 ed25519） |
| 4 | `curl -sSL -w '%{http_code}' <waf-0.5.4 download_url>` | 0（**404**） |
| 4 | `curl` 对照 waf v0.5.3 / echo v0.1.7 资产 | 0（均 200） |
| 5 | 清单见上（含 GET 200 判据与 echo 教训） | — |

本次预检全程只读；唯一写入为报告文件本身（`kore/.agents/verify/waf-0.5.4-release-readiness.md`）。
