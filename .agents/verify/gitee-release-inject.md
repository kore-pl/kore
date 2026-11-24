# Gitee release 补建 + prune 干跑证据（release-gitee-inject）

> 时间：2026-11-24（Asia/Shanghai）｜执行者：`release-gitee-inject`（子 agent）
> 事实口径：下方命令 / 退出码 / 关键输出均来自本次实跑；token 仅以 `$GITEE_TOKEN` 占位，未落明文（G-30）。
> 背景：§0.0.3 第 5 条 / §0.0.5 第 4 条挂账——Gitea(origin) / Gitee release 因缺 token 未建；
> 本次用户显式授权「注入」，仅补 Gitee 5 个 release；GitHub 5/5 已存在，未触碰；无 push。

## 0. 范围与边界

- 目标 5 tag：`kore-plugin-app-deploy v0.3.3`、`kore-plugin-file v0.3.5`、`kore-plugin-logs v0.5.4`、`kore-plugin-backup v0.5.1`、`kore-plugin-dns v0.5.2`。
- owner 恒为 `pengtang1024`（由各仓 `gitee` remote `git@gitee.com:pengtang1024/...` 解析，fill.sh `parse_repo()` 处理）；**未使用 `--repo kore-pl/...`**（会 404）。
- 写域仅两处：本证据文件 + `scripts/gitee-release-prune.sh`（lead 批准的 header-auth 修正）。无 push。
- token 注入方式（仅在执行 bash 进程内）：`set -a; . "$HOME/.config/environment.d/10-api-tokens.conf"; set +a`；引用一律 `$GITEE_TOKEN`，未 echo / 未写文件 / 未入日志 / 未入提交。
- 预检：`GITEE_TOKEN: SET`；鉴权 GET `http=200`（release 列表可解析）。

## 1. prune.sh header-auth 修正（G-23 判断留痕）

### 1.1 决策：URL 拼 token 被否决，改用 Authorization 请求头

- **原实现（被否决）**：`api()` 把 `access_token=${GITEE_TOKEN}` 拼到 URL 查询串，`list_releases()` 另起 curl 也把 token 拼进 `/releases?access_token=...&page=...`。
- **否决依据**：`docs/GITEE-MIRROR.md:117` 硬约束——脚本一律用 `Authorization: token` 请求头，**不要**把 `access_token=` 拼进 URL（会留在 shell history、进程表与访问日志里）。URL-token 属凭据泄露面，与 fill.sh:74-75 既有口径不一致。
- **采用方案**：`api()` 改为 `-H "Authorization: token ${GITEE_TOKEN}"`（与 fill.sh:74-75 完全一致）；`list_releases()` 改为复用 `api GET ...`，不再自己拼 URL。其余逻辑（判序、护栏①②、`PRUNE_EXCEPTIONS`、dry-run 语义、退出码）一字未动。
- **被否决选项**：①保留 URL-token（泄密面，违反 GITEE-MIRROR:117）；②两个函数各写一份 header curl（重复逻辑，易再次漂移）——均未采用。
- 这是本轮 `scripts/` 下**唯一**改动；仅改鉴权载体，不改任何保留 / 删除策略。

### 1.2 实际 diff（`git diff -- scripts/gitee-release-prune.sh`）

```diff
@@ -100,8 +100,8 @@ infer_repo() {
 api() {
   local method="$1" path="$2" out="$3"
   local url="$API_BASE$path"
-  if [[ "$url" == *"?"* ]]; then url="$url&access_token=${GITEE_TOKEN}"; else url="$url?access_token=${GITEE_TOKEN}"; fi
-  curl -sS --max-time 120 -X "$method" "$url" -o "$out" -w '%{http_code}'
+  curl -sS --max-time 120 -X "$method" \
+    -H "Authorization: token ${GITEE_TOKEN}" "$url" -o "$out" -w '%{http_code}'
 }

@@ -113,9 +113,7 @@ list_releases() {  # $1=owner/repo $2=outfile ; prints count
   : > "$out"
   while :; do
     local tmp; tmp="$(mktemp)"
-    local code; code="$(curl -sS --max-time 120 \
-      "$API_BASE/repos/$repo/releases?access_token=${GITEE_TOKEN}&page=$page&per_page=100" \
-      -o "$tmp" -w '%{http_code}')"
+    local code; code="$(api GET "/repos/$repo/releases?page=$page&per_page=100" "$tmp")"
     if [ "$code" != "200" ]; then rm -f "$tmp"; return 1; fi
     local n; n="$(jq 'length' "$tmp" 2>/dev/null || echo 0)"
     if [ "$n" = "0" ]; then rm -f "$tmp"; break; fi
```

### 1.3 校验命令 + 退出码 + 关键输出

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `grep -n 'access_token=' scripts/gitee-release-prune.sh` | 1（零命中） | 无输出——脚本内已无 URL-token |
| `bash -n scripts/gitee-release-prune.sh` | 0 | 无输出——语法通过 |
| `grep -n 'Authorization: token' scripts/gitee-release-prune.sh` | 0 | `104: -H "Authorization: token ${GITEE_TOKEN}" ...` |

## 2. fill.sh 补建（5/5 达成）

命令形态（逐仓串行，`cd kore`）：

```bash
set -a; . "$HOME/.config/environment.d/10-api-tokens.conf"; set +a
bash scripts/gitee-release-fill.sh --latest 1 --require-dist --dir "../kore-plugin-<repo>"
```

逐仓结果（每仓 exit 0；`OVERALL_FILL_RC=0`）：

| 仓 / tag | 创建 | 上传 | 资产回读 sha256（本地 == 远端） | 公开视角 |
| --- | --- | --- | --- | --- |
| app-deploy `v0.3.3` | HTTP 201 id=1363469 | app-deploy-0.3.3.tar.gz HTTP 201 | `3253c1a72a9ec098f985e97f8b8a3d128508f5dc328e4b6fcd9f212c55bbcb39` | GET → 200 |
| file `v0.3.5` | HTTP 201 id=1363471 | file-0.3.5.tar.gz HTTP 201 | `db8388f0d3bdfd08ea4222f11c3195314a0e86f0deb886232f6b1804b723f133` | GET → 200 |
| logs `v0.5.4` | HTTP 201 id=1363472 | logs-0.5.4.tar.gz HTTP 201 | `34301a77919a864f8371488b00d490c452bd9bf8e031a0179059c30fdd96b3ad` | GET → 200 |
| backup `v0.5.1` | HTTP 201 id=1363473 | backup-0.5.1.tar.gz HTTP 201 | `bc202ac6dd59dca798ad3895baa8a7f6fc1794c5e31336b992e5e5e91a30e29c` | GET → 200 |
| dns `v0.5.2` | HTTP 201 id=1363474 | dns-0.5.2.tar.gz HTTP 201 | `fce690854fb4bc7b1f26e74620bdc5bc9ce556afe9e4c9a230b7133fd64a4baa` | GET → 200 |

- 每仓关键行：`[OK] <tag> 资产校验 http=200 sha256=<64hex>` + `[OK] <tag> 公开视角 GET /releases/tags/<tag> → 200` + `[DONE] 全部达成`。
- 上述 sha256 与 §0.0.5 表中 GitHub release 断链修复时校验的 sha256 前缀逐字一致（`3253c1a7…` / `db8388f0…` / `34301a77…` / `bc202ac6…` / `fce69085…`），证明两端挂的是同一 dist 产物。
- 5 仓均出现 WARN「超过保留策略 5 个，先跑 prune --dry-run」——预期行为，触发下一步干跑（仅 dry-run，不真删）。

## 3. prune.sh --dry-run（只干跑，零删除）

命令形态（逐仓串行，全程带 `--dry-run`）：

```bash
bash scripts/gitee-release-prune.sh --dry-run --keep 5 --repo pengtang1024/kore-plugin-<repo>
```

逐仓结果（每仓 exit 0；`OVERALL_PRUNE_RC=0`）：

| 仓 | 现有 release | 保留集（新→旧 5 个） | 计划删除 | 护栏① | 护栏② | 结尾 |
| --- | --- | --- | --- | --- | --- | --- |
| app-deploy | 6 | v0.3.3 v0.3.2 v0.3.1 v0.3.0 v0.2.2 | v0.2.1（1） | ✓ 剩余 5 == --keep 5 | ✓ 全 < 0.2.2 | `[DRY-RUN] 未执行删除` |
| file | 8 | v0.3.5 v0.3.4 v0.3.3 v0.3.2 v0.3.1 | v0.2.0 v0.2.1 v0.3.0（3） | ✓ 剩余 5 == --keep 5 | ✓ 全 < 0.3.1 | `[DRY-RUN] 未执行删除` |
| logs | 7 | v0.5.4 v0.5.3 v0.5.2 v0.5.1 v0.5.0 | v0.4.1 v0.4.2（2） | ✓ 剩余 5 == --keep 5 | ✓ 全 < 0.5.0 | `[DRY-RUN] 未执行删除` |
| backup | 7 | v0.5.1 v0.5.0 v0.4.2 v0.4.1 v0.4.0 | v0.2.1 v0.3.0（2） | ✓ 剩余 5 == --keep 5 | ✓ 全 < 0.4.0 | `[DRY-RUN] 未执行删除` |
| dns | 7 | v0.5.2 v0.5.1 v0.4.2 v0.4.0 v0.3.2 | v0.3.0 v0.3.1（2） | ✓ 剩余 5 == --keep 5 | ✓ 全 < 0.3.2 | `[DRY-RUN] 未执行删除` |

- 每仓均打印 `✓ 护栏①` / `✓ 护栏②` 与 `[DRY-RUN] 以上仅为计划，未执行删除`，结尾 `[DONE] 全部完成（dry-run，未删除）`。
- **未运行任何不带 `--dry-run` 的 prune 命令；未删除任何 release / 附件。**
- `PRUNE_EXCEPTIONS` 仍只有 `pengtang1024/kore-plugin-echo:v0.1.0`（GitHub 无对应 release、Gitee 唯一副本），本批 5 仓无例外命中，未新增 / 移除例外。

## 4. 结论

- **Gitee release 补建 5/5 达成**：5 个 tag 全部建 release + 挂 dist 资产 + sha256 回读一致 + 公开视角 200；owner 均为 `pengtang1024`。
- **prune 干跑 5/5 通过**：护栏①②全绿，`[DRY-RUN] 未执行删除`，零真实删除。
- **GitHub 未触碰**（5/5 早已存在）；**未 push**；token 未落明文 / 未入任何文件与提交。
- 待 lead 裁决：是否另开授权跑真实 prune（本轮禁止，仅 dry-run）。
