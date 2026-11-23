# R5 · 第 33 次重签 + 12 条版本入索引 · 独立复验（最终态）

- 首次复验：2026-11-23 13:12–13:18（**窗口期快照**，当时判定“部分落地”）
- 最终复验：2026-11-23 13:20–13:22 · verifier：kore-verify-privilege
- 方式：纯只读（仅本文件被修改）；API 查询复用 `/tmp` 现有会话 cookie jar（只读 GET）；未 push、未改两仓代码/配置。
- **最终判定：发布链完整落地。** 唯一遗留是 `kore` 本地领先远端 **18 个 commit** 的待推送状态（按“只 commit 不 push”预期，非缺口）。

## 最终结论摘要（13:22 快照）

| # | 项 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| ① | 第 33 把公钥两端一致 | **PASS** | `validate-index.sh` PUB_HEX == `verify.go`（HEAD 内）== `3a87e3a53c37ff467e3317fd48f9b7a92e13018ec60f8c250aaecda6d3f23e80` |
| ② | 索引 24 条 / 12 条新版 | **PASS** | 索引 24 条；预期 12/12；商店 API 24 条、12 版本 `mismatches=[]`；逐仓 21/24（waf 允许，process/ssl 为他人未提交在途 bump，见 §②） |
| ③ | 签名正/反例 + 资产 | **PASS** | 正例 `exit=0`；篡改副本 `exit=1`；原仓 sha 未变且复验 `exit=0`；24 资产前一轮独立下载 `ok=24 bad=0`，本轮索引 sha 未变（`4bd958cd…`）故沿用该结论 |
| ④ | 两仓 commit/推送 | **PASS** | kore `8566d43`（仅 `verify.go` + `resign-33.md` 两个文件）、工作树干净、**未 push**（本地领先 18）；kore-plugins `b4f688b` 干净、origin+gitee 双端同 commit |
| ⑤ | 私钥销毁 | **PASS** | 四路径均 `No such file`；`/tmp/kore-*33*` 无任何残留 |
| ⑥ | 8787 主实例 | **PASS** | PID 843194（13:15:42 启动，晚于 13:15:05 的二进制）on-disk exe；`3a87e3a5=1 / 37c65e8a=0 / 1605021f=0`；healthz 200；`index_dir` 正确；商店 200/24 条/12 版本全对 |

---

## 一、2 项补验（上次的缺口）

### 1.1 kore 第 33 次重签 commit 存在且内容正确（PASS）

```text
$ git -C kore log --oneline -3
8566d43 chore(market): 第三十三次重签新公钥同步 verify.go + 12 条入索引证据（第 32 把销毁 → 第 33 把收口）
f086312 feat(pluginapi): root 动作受控命令形状（ADR-0022）——白名单从命令名升级为子命令+参数形状
ff92f6c chore(market): 第三十二次重签新公钥同步 verify.go + 6 插件入索引证据（redis/ssh-guard/logs/container/process/cron）

$ git show --stat --oneline HEAD
8566d43 …
 .agents/verify/resign-33.md    | 93 ++++++++++++++++++++++++++++++++++++++++++
 internal/core/market/verify.go |  2 +-
 2 files changed, 94 insertions(+), 1 deletion(-)

$ git show HEAD:internal/core/market/verify.go | grep IndexPublicKeyHex
const IndexPublicKeyHex = "3a87e3a53c37ff467e3317fd48f9b7a92e13018ec60f8c250aaecda6d3f23e80"

$ git cat-file -s HEAD:.agents/verify/resign-33.md
9049

$ git status --porcelain -- internal/core/market/verify.go .agents/verify/resign-33.md
（空 = 两文件均已提交，工作树干净）

$ git show -s --format='%H %cI' HEAD
8566d43e6579b5bb610e45cca2f3beb367af6d2f 2026-11-23T13:18:04+08:00
```

- commit 只含 `internal/core/market/verify.go`（换钥 diff `37c65e8a…a5b9` → `3a87e3a5…3e80`）与 `.agents/verify/resign-33.md`（9049 B / 93 行），**没有夹带无关文件**。
- 说明：lead 快照里的 `6e4d565` 是同一父提交（`f086312`）上的**中间版本**，多带了 1 行无关文件 `.agents/verify/r5-2-waf-nft.md`；最终 `8566d43` 已去掉该文件（`git diff --stat 6e4d565 8566d43` = 仅该 1 行删除）。`6e4d565` 已无任何 ref 指向（dangling），不构成发布链内容。

### 1.2 私钥四文件销毁（PASS）

```text
$ for f in /tmp/kore-seed-33.txt /tmp/kore-index-priv-33.pem /tmp/kore-index-pub-33.pem /tmp/kore-index-33.sig; do
    printf '%-38s ' "$f"; [ -e "$f" ] && echo EXISTS || echo "No such file"; done
/tmp/kore-seed-33.txt                  No such file
/tmp/kore-index-priv-33.pem            No such file
/tmp/kore-index-pub-33.pem             No such file
/tmp/kore-index-33.sig                 No such file

$ ls -la /tmp/kore-*33*
ls: cannot access '/tmp/kore-*33*': No such file or directory
```

对照窗口期快照（13:16）：`/tmp/kore-index-priv-33.pem`（119B）、`/tmp/kore-seed-33.txt`（64B）确实还在，且私钥可导出第 33 把公钥；最终态两文件均已消失，无同名/同前缀残留。

## 二、关键门禁复跑

### 2.1 `validate-index.sh` 正例

```text
$ bash kore-plugins/scripts/validate-index.sh
[OK] schema / 必填字段 / id 唯一 / sha256 格式通过（24 条）
[OK] 版本单调递增 / 同 id@version 唯一 sha 校验通过（基线 24 条）
[OK] 预设引用可解析（占位/已校验 47 条引用）
[OK] ed25519 签名验证通过（内置公钥）
[OK] 索引校验全部通过
exit=0
```

### 2.2 篡改反例（在 `/tmp/r5f/idx` 副本上造，不碰仓库）

```text
副本基线：copy_baseline_exit=0
改副本 plugins.json 一个字符后：
  [OK] schema … / [OK] 版本基线 … / [OK] 预设 …
  [FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）
  tamper_exit=1
原仓复核（未改）：
  4bd958cdc72335ed58ed3c2e41665e64d50caedeec355e31bb79ecb1b57cd4c5  index/plugins.json
  1e6505a551b68c900ebe4220a74d61d10675174054c4d4887e223f7954b01491  index/plugins.json.sig
  orig_recheck_exit=0（[OK] 索引校验全部通过）
```

### 2.3 二进制 key 闸门

```text
$ strings kore/bin/kored | grep -c 3a87e3a5   → 1   (grep_exit=0)
$ strings kore/bin/kored | grep -c 37c65e8a   → 0   (grep_exit=1，无匹配属正常)
$ strings kore/bin/kored | grep -c 1605021f   → 0   (grep_exit=1)
运行中进程 /proc/843194/exe：3a87e3a5=1 / 37c65e8a=0
```

### 2.4 商店 24 条与版本抽查

```text
$ curl -s -b <会话jar> http://127.0.0.1:8787/api/v1/store/plugins
HTTP=200 size=10200；count=24
12-version mismatches: []
samples: {'terminal': '0.2.0', 'site': '0.3.1', 'ssh-guard': '0.2.1'}

$ curl -s … /api/v1/system/info | jq .paths.index_dir
/home/pt/Work/GolandProjects/kore-plugins/index   # == .kore-local.yaml 配置值
```

### 2.5 主实例进程一致性

```text
bin/kored mtime = 13:15:05（on-disk，含第 33 把）
8787 owner PID=843194 start=13:15:42（晚于二进制）
/proc/843194/exe -> …/bin/kored（非 deleted）
healthz=200
```

## 三、窗口期 vs 最终态（为何上次是“部分落地”）

```text
13:05:50  第 33 把私钥/seed 落 /tmp
13:10:05  index/plugins.json + .sig 重签
13:11:04  kore-plugins commit b4f688b（第 33 次重签，双推完成）
13:12–13:14 【窗口期快照】kore HEAD=ff92f6c（第 32 次）；verify.go 仍 M；无 resign-33.md；
           8787 仍是 PID 175666（12:43 启动，exe deleted，32 把 key），商店 401「需重启」
           → 当时判定「部分落地（缺 ④kore commit、⑤私钥）」正确
13:15:05  on-disk bin/kored 重建（含第 33 把）
13:15:42  8787 重启为 PID 843194（33 把），商店/健康检查转绿
13:17     resign-33.md 落盘（9049 B）
13:18:04  kore commit 8566d43（只含 verify.go + resign-33.md；中间版 6e4d565 已被替换）
13:19:08  中间 commit 6e4d565（多 1 行无关文件）——lead 快照所见；随后被 8566d43 取代
13:20–13:22 【最终快照】私钥已销毁；commit 内容/干净度核对通过；门禁复跑全绿
```

差异只来自**复验窗口与收尾动作的时间差**，不是 release-r5 的虚假自报：其自报的 `8566d43` 与现场一致（lead 消息里的 `6e4d565` 是更早的中间版本）。

## 四、待推送状态（按预期，未 push）

```text
$ git -C kore ls-remote origin refs/heads/main
1c40847a2b0632673a2bf097eb4e2f81271ec08b	refs/heads/main
$ git -C kore ls-remote gitee refs/heads/main
1c40847a2b0632673a2bf097eb4e2f81271ec08b	refs/heads/main
$ git -C kore rev-parse HEAD
8566d43e6579b5bb610e45cca2f3beb367af6d2f
$ git -C kore rev-list --left-right --count HEAD...@{u}
18	0        # ← 本地领先 18 个 commit，待推送
```

- 含第 33 次重签 commit（`8566d43`）与中间的功能 commit（如 `f086312` ADR-0022）。
- **本轮复验未 push**；两远端仍停留 `1c40847`（第 31 次重签后状态）。kore-plugins 两端已是 `b4f688b`，无需再推。

## 五、② 的逐仓差异（不代表索引漏项）

```text
索引侧 12 条预期版本：12/12 OK；索引总数 24
逐仓比对 repo info.json vs index：21/24 一致
  waf     repo 0.3.0  vs index 0.2.0  ← 任务显式允许（0.3.0 还在跑）
  process repo 0.2.1  vs index 0.2.0  ← info.json 未提交，mtime 13:14:26（晚于重签 13:10）
  ssl     repo 0.4.0  vs index 0.3.0  ← info.json 未提交，mtime 13:12:21
```

process/ssl 是索引重签之后其他轨道推进的**在途未提交 bump**，不属于第 33 次重签漏项；若需“24 条逐字对齐”的最终结论，应在这些 bump 再次入索引后复跑本脚本。

## 六、未独立复跑/未证明

1. `make check`（11 段）/ `make build` / `presets-check`：本轮未复跑，采用 release-r5 自报（`make check` 11 段 exit 0、`make build` exit 0、presets 0 FAIL/0 WARN）；本报告已独立覆盖 validate-index、二进制 key、商店 24 条三项关键点。
2. 24 条 release 资产：本轮未重新下载（索引 `plugins.json` sha 未变，上一轮独立复验为 `ok=24 bad=0`），沿用该结论。
3. gitee 推送“先 origin 后 gitee”的时序不可从远端反推，只核对到两端最终一致。
4. process/ssl 在途 bump 的后续重签不在本次范围。

## 七、纪律与清理

- 只读 + 仅改本文件；未改 `kore` / `kore-plugins` 代码/索引/配置；未 push；未动主实例运行态配置（仅只读 GET）。
- 临时目录 `/tmp/r5f`（篡改副本与日志）与下载缓存已删除；两仓 `git status` 对相关文件均干净。
- 证据文件：`.agents/verify/r5-resign33-independent.md`（本文件）。
