# Gitee 镜像仓库（Gitea 权威源 · 三端镜像推送）

> 状态: active · 归属: scribe · 更新: 2026-11-23 · 里程碑: M1

kore 多仓库三端推送：自建 Gitea `gitea.iouf.cn/kore-pl` 是**唯一权威源**（[ADR-0024](DECISIONS/0024-repo-topology-and-gitea.md) 决策 B），GitHub 与 Gitee 均为镜像。issue / PR / tag 以 Gitea 为准；CI 与 release 按现行策略只在 GitHub 侧（见 [AGENTS.md](../AGENTS.md) §5 CI 触发策略）。Gitee 只做代码与发行物的可用性镜像，接收推送，不接收贡献流程（不在 GitHub / Gitee 上开分支、提 PR、改代码）。

## 1. remote 命名

| 远端 | 地址 | 角色 |
| --- | --- | --- |
| `origin` | `https://gitea.iouf.cn/kore-pl/<repo>.git` | **权威源**（Gitea，日常提交 / PR / issue / tag） |
| `github` | `git@github.com:kore-pl/<repo>.git` | 公开镜像（承载 CI 与 release） |
| `gitee` | `git@gitee.com:pengtang1024/<repo>.git` | 国内镜像，只读语义 |

首次配置（26 个仓库通用）：`git remote add github git@github.com:kore-pl/<repo>.git`、`git remote add gitee git@gitee.com:pengtang1024/<repo>.git`（`origin` 即 Gitea 权威源）。GitHub / Gitee 侧走 SSH，不使用 HTTPS 明文口令。

## 2. 推送策略：显式顺序推送，不用 pushurl

```bash
git push origin main --tags    # 先 Gitea 权威源；失败即终止，镜像不推
git push github main --tags || echo "WARN: github push failed (Gitea 已成功)" >&2
git push gitee  main --tags || echo "WARN: gitee push failed (Gitea 已成功)" >&2
```

**为什么不用 `remote.origin.pushurl` 多推**：

- pushurl 把多个远端塞进一次 `git push`，任一失败整条命令非零，分不清权威源是否已成功；
- 镜像远端的 SSH / 凭据配置耦合在 origin 上，换 key 会同时影响权威源；
- 多推无法表达「权威源优先」，也不便于单个镜像单独重试。
- 结论：三条命令顺序执行，**`origin`（Gitea 权威源）先推，`github` 与 `gitee` 镜像后推**；镜像失败只 WARN，不阻塞权威源（依据 [ADR-0024](DECISIONS/0024-repo-topology-and-gitea.md) 决策 B）。

## 3. release 策略

| 平台 | 保留 | 说明 |
| --- | --- | --- |
| GitHub | 全量 | 公开镜像，release 基线（Gitea 为权威源） |
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

- 顺序固定：**origin（Gitea 权威源）成功后才推 `github` 与 `gitee`**；origin 失败直接中止，避免镜像超前于权威源。
- 镜像（`github` / `gitee`）推送失败：只打 WARN，脚本退出码保持 0，下一次推送自动补齐；不阻塞权威源。
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
