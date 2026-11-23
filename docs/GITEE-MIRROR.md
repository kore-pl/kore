# Gitee 镜像仓库（GitHub 为主）

> 状态: active · 归属: scribe · 更新: 2026-11-23 · 里程碑: M1

kore 多仓库同时发布到 GitHub（主）与 Gitee（镜像）。**GitHub 是唯一事实来源**：issue / PR / CI / release 全量以 GitHub 为准；Gitee 只做代码与发行物的可用性镜像，接收推送，不接收贡献流程（不在 Gitee 上开分支、提 PR、改代码）。

## 1. remote 命名

| 远端 | 地址 | 角色 |
| --- | --- | --- |
| `origin` | `git@github.com:pengtang1024/<repo>.git` | 主仓，唯一事实来源 |
| `gitee` | `git@gitee.com:pengtang1024/<repo>.git` | 镜像，只读语义 |

首次配置（26 个仓库通用）：`git remote add gitee git@gitee.com:pengtang1024/<repo>.git`。Gitee 侧走 SSH，不使用 HTTPS 明文口令。

## 2. 推送策略：显式双推，不用 pushurl

```bash
git push origin main --tags    # 先 GitHub；失败即终止，Gitee 不推
git push gitee  main --tags || echo "WARN: gitee push failed (GitHub 已成功)" >&2
```

**为什么不用 `remote.origin.pushurl` 双推**：

- pushurl 把两个远端塞进一次 `git push`，任一失败整条命令非零，分不清 GitHub 是否已成功；
- 两个远端的 SSH / 凭据配置耦合在 origin 上，换 key 会同时影响主仓；
- 双推无法表达「GitHub 优先」，也不便于 Gitee 侧单独重试。
- 结论：两条命令顺序执行，**先 origin 后 gitee**；Gitee 失败只 WARN，不阻塞主仓。

## 3. release 策略

| 平台 | 保留 | 说明 |
| --- | --- | --- |
| GitHub | 全量 | 事实来源，发布基线 |
| Gitee | 最新 5 个 release | 按 `created_at` 倒序，第 6 个起删除（含附件） |

- **建 release**：镜像 GitHub release 的 `tag_name` / `name` / `body`，附件用本地 `dist/<id>-<version>.tar.gz`（与 GitHub 同 sha256，可离线复用）；GitHub 无 release 的仓库只镜像分支与 tag。
- **清理 release**：`scripts/gitee-release-prune.sh`，默认保留 5 个，先删附件再删 release。
- 清理脚本支持 `--dry-run`（只打印计划）、`--keep N`、`--repo owner/name`（可重复、可跨仓库批量）。

```bash
export GITEE_TOKEN=***            # 只从环境变量读取，禁止写进仓库（G-30）
bash scripts/gitee-release-prune.sh --dry-run
bash scripts/gitee-release-prune.sh                  # 当前仓库，真删
bash scripts/gitee-release-prune.sh --repo pengtang1024/kore --repo pengtang1024/kore-plugins
```

## 4. 失败处理

- 顺序固定：**origin 成功后才推 gitee**；origin 失败直接中止，避免镜像超前于主仓。
- Gitee 推送失败：只打 WARN，脚本退出码保持 0，下一次推送自动补齐；不阻塞 GitHub。
- Gitee API 创建 / 清理失败：逐仓库记录并继续，最后汇总非零退出，便于人工重跑。
- 冲突处理：Gitee 侧**不 force push**；镜像落后时普通 `git push` 快进，被拒先查 Gitee 是否被直接提交过（禁止在 Gitee 开发）。

## 5. 首次全量（26 仓库）

1. 建仓：`POST /user/repos`，`auto_init=false`（避免与首次 push 冲突）。
2. 推代码：`git push gitee main --tags`。
3. 转公开：空仓库不允许设为公开，push 完成后 `PATCH /repos/{owner}/{repo}` 传 `private=false`。
4. 建 release：GitHub 有 release 的仓库，镜像最新 5 个；`kore` / `kore-plugins` 当前无 GitHub release，只镜像分支与 tag。
5. 校验：Gitee release 数量 ≤5，且 tag 与 GitHub 最新一致。

## 6. 凭据

- `GITEE_TOKEN` 只从环境变量注入（本机在仓库外的 `~/.config/environment.d/10-api-tokens.conf`）。
- 推送用 SSH（`git@gitee.com`），不使用 store 中的 HTTPS 口令。
- 任何 token / 口令不得写入仓库、文档、脚本默认值或日志（G-30）。

## 7. 验证清单

```bash
# 远端存在且 main 与本地一致
git ls-remote gitee main

# Gitee release 数量与最新 tag
curl -s "https://gitee.com/api/v5/repos/pengtang1024/<repo>/releases?per_page=100" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d),[r["tag_name"] for r in d])'
```
