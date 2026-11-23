# Gitee 镜像仓库（Gitea 权威源 · 三端镜像推送）

> 状态: active · 归属: scribe · 更新: 2026-11-24 · 里程碑: M1

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
| Gitee | 最新 5 个 release | **按 tag 语义版本（`sort -V`）排序**，第 6 个起删除（含附件）；不使用 `created_at` / release `id` |

- **建 release**：镜像 GitHub release 的 `tag_name` / `name` / `body`，附件用本地 `dist/<id>-<version>.tar.gz`（与 GitHub 同 sha256，可离线复用）；GitHub 无 release 的仓库只镜像分支与 tag。
- **清理 release**：`scripts/gitee-release-prune.sh`，默认保留 5 个，先删附件再删 release。
- 清理脚本支持 `--dry-run`（只打印判序依据与计划）、`--keep N`、`--repo owner/name`（可重复、可跨仓库批量）。

**判序规则（为什么不用 `created_at`）**：补建批次按版本**倒序**创建，时间序 ≠ 版本序。2026-11-24 事故（`33088d9`）：脚本按 `created_at` 判序，把 `kore-plugin-integrity` 版本第 2 新的 `v0.4.0` 当第 6 新删掉、却漏删 `v0.3.0`，靠本地 `dist` 残留 tar.gz 才恢复（sha256 一致），**属运气**。现行规则：

1. 只认 `^v[0-9]` 形态的 tag，`pkg/pluginapi/*` 等子模块 tag 不参与判序；
2. 版本号用 GNU version sort（`sort -V`），`0.10.0` 排在 `0.9.0` 之后；
3. 同版本多前缀（`v1.0.0` 与 `1.0.0` 并存）视为判序歧义 → **整仓跳过并 WARN**，绝不猜。

**删除护栏**（任一不成立即中止该仓、不删）：① 删除后剩余数量 == `--keep`；② 被删版本**全部严格小于**保留集最小版本。`--dry-run` 对每仓打印「保留集（按版本序）+ 待删集 + 判序依据」与两条护栏的校验结果，可逐条人工核对。

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

## 8. 补建缺失 release（`scripts/gitee-release-fill.sh`）

### 8.1 典型故障形态与根因

发版报告写「环境无 `GITEE_TOKEN`，gitee release 未创建」，但 tag 与 `main` 都推送成功。这不是 Gitee 故障，是**凭据注入范围**问题：

- tag / 分支用 SSH 推（`git@gitee.com`，`~/.ssh/id_ed25519_gitee_*`），**不依赖 token**——所以代码先到了；
- `GITEE_TOKEN` 只在本机 `~/.config/environment.d/10-api-tokens.conf` 定义，由**用户会话登录时**注入；
- 发版脚本若跑在没继承该变量的进程里（非登录 shell、桌面会话之外启动的进程、旧会话），`env | grep GITEE` 为空 → 脚本按设计跳过 release。

结论：**「环境无 token」要先查进程环境，不要先怀疑 Gitee API/权限**；补建用第 8.4 节的脚本即可，历史 tag 不需要重推。

### 8.2 生成 token（最小权限）

1. Gitee → 设置 → 私人令牌 → 生成新令牌；
2. **只勾 `projects`**（仓库读写：建 release、传附件、删 release 都在此权限内）。不要勾 `keys` / `hook` / `groups` / `enterprises` / `admin` 类；
3. 有效期取团队策略允许的最短值；令牌只在生成页显示一次，立即注入，不落仓库。

### 8.3 注入方式与边界

| 方式 | 生效范围 | 说明 |
| --- | --- | --- |
| `export GITEE_TOKEN=***` | 当前 shell | 临时补建首选；命令结束即失效 |
| `~/.config/environment.d/10-api-tokens.conf` | 用户会话登录时 | 本机默认；`chmod 600`；**新登录后才生效**，已在运行的进程不继承 |
| CI secret | 流水线 | 走仓库 secrets，不落文件 |

硬约束（G-30）：token 不得写入仓库、脚本默认值、文档或日志；脚本一律用 `Authorization: token` 请求头，**不要**把 `access_token=` 拼进 URL（会留在 shell history、进程表与访问日志里）。

### 8.4 使用

```bash
# 1) 只读盘点缺口（不需要 token，走公开只读 API）
bash scripts/gitee-release-fill.sh --dry-run --all

# 2) 单仓补建（需要 token）
export GITEE_TOKEN=***
bash scripts/gitee-release-fill.sh --dir ../kore-plugin-app-deploy

# 3) 全量补建；补完先看保留策略再决定是否清理
bash scripts/gitee-release-fill.sh --all
bash scripts/gitee-release-prune.sh --dry-run --repo pengtang1024/kore-plugin-app-deploy

# 4) 按「每仓最新 5 个 tag」策略补建（2026-11-24 起的主口径）
bash scripts/gitee-release-fill.sh --dry-run --latest 5 --require-dist --dir ../kore-plugin-site
bash scripts/gitee-release-fill.sh          --latest 5 --require-dist --dir ../kore-plugin-site
```

行为约定：

- **幂等**：tag 已有 release 则跳过；release 存在但缺 `dist` 资产则只补传；资产已在则整条跳过；
- **资产命名**：`dist/<id>-<version>.tar.gz`（`<id>` = 仓库名去掉 `kore-plugin-` 前缀），与 GitHub 侧同 sha256，可离线复用；
- **回读校验**：上传后下载资产、比对本地 sha256，不一致非零退出；
- **tag 过滤**：只处理 `^v[0-9]`，`pkg/pluginapi/v*` 这类子模块 tag 不建 release；
- **窗口过滤**：`--latest N` 只处理最新 N 个 tag（按版本倒序取头 N）——Gitee 只留最新 5 个，补的必须是最新窗口；
- **产物前置**：`--require-dist` 下本地无 `dist/<id>-<ver>.tar.gz` 则**跳过该 tag**，不建空 release（计入「无法补建」）；
- **保留策略**：补建后超过 `--keep`（默认 5）只 WARN，不自动删除——清理是破坏性动作，必须先 `--dry-run`；
- **公开视角校验**：非 dry-run 追加未鉴权 `GET /releases/tags/<tag>`（403/429 退避重试）；并发跑多仓时可置 `SKIP_PUBLIC_CHECK=1`，事后串行复核。

### 8.5 两个 Gitee API 坑（2026-11-24 实测）

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| `HTTP 400 {"messages":["target_commitish is missing"]}` | 即便 tag 已存在，Gitee 建 release 仍强制要求 `target_commitish` | 传 tag 指向的 commit：`git rev-parse <tag>^{commit}` |
| `HTTP 400` 且 `message` / `errors` 均为空 | 该端点不接受 JSON body，报错信息还丢字段 | 改用表单编码（`curl --data-urlencode`） |
| release assets 的 `size` 恒为 `null` | Gitee API 不回填附件大小 | 验收看**下载字节数 + sha256**，不看 `size` 字段 |

### 8.6 2026-11-24 盘点快照（补建 `app-deploy v0.3.1` / `terminal v0.2.1` 之后）

| 仓库 | tag 数 | release 数 | 尚无 release 的 tag | 超 5 |
| --- | --- | --- | --- | --- |
| kore | 6 | 0 | `pkg/pluginapi/v0.1.0`–`v0.1.5`（子模块 tag，不建 release） | no |
| kore-plugins | 0 | 0 | — | no |
| kore-plugin-app-deploy | 7 | 4 | v0.2.1, v0.2.2, v0.3.0 | no |
| kore-plugin-backup | 7 | 3 | v0.3.0, v0.4.0, v0.4.1, v0.4.2 | no |
| kore-plugin-container | 9 | 3 | v0.3.0, v0.4.0, v0.4.1, v0.5.0, v0.5.1, v0.5.2 | no |
| kore-plugin-cron | 6 | 2 | v0.3.0, v0.4.0, v0.4.1, v0.5.0 | no |
| kore-plugin-db-mysql | 7 | 4 | v0.3.2, v0.4.0, v0.4.1 | no |
| kore-plugin-db-postgres | 8 | 4 | v0.3.0, v0.3.1, v0.3.2, v0.3.3 | no |
| kore-plugin-discover | 4 | 2 | v0.3.0, v0.3.1 | no |
| kore-plugin-dns | 7 | 2 | v0.2.0, v0.3.0, v0.3.1, v0.3.2, v0.4.0 | no |
| kore-plugin-echo | 5 | 3 | v0.1.0, v0.1.4 | no |
| kore-plugin-file | 6 | 3 | v0.3.0, v0.3.1, v0.3.2 | no |
| kore-plugin-firewall | 7 | 5 | v0.2.4, v0.2.6 | no |
| kore-plugin-integrity | 8 | 3 | v0.3.0, v0.3.1, v0.3.2, v0.3.3, v0.4.0 | no |
| kore-plugin-logs | 9 | 4 | v0.3.0, v0.4.0, v0.4.1, v0.4.2, v0.5.0 | no |
| kore-plugin-monitor | 5 | 4 | v0.3.0 | no |
| kore-plugin-process | 6 | 2 | v0.2.0, v0.2.1, v0.2.2, v0.3.0 | no |
| kore-plugin-redis | 6 | 3 | v0.4.0, v0.5.0, v0.6.0 | no |
| kore-plugin-runtime-node | 7 | 3 | v0.2.1, v0.2.2, v0.2.3, v0.2.4 | no |
| kore-plugin-runtime-php | 5 | 3 | v0.2.1, v0.2.2 | no |
| kore-plugin-runtime-python | 8 | 3 | v0.2.2, v0.2.3, v0.2.4, v0.3.0, v0.3.1 | no |
| kore-plugin-site | 8 | 2 | v0.3.0, v0.3.1, v0.4.0, v0.4.1, v0.4.2, v0.4.3 | no |
| kore-plugin-ssh-guard | 8 | 3 | v0.2.0, v0.2.1, v0.2.2, v0.2.3, v0.3.0 | no |
| kore-plugin-ssl | 8 | 3 | v0.3.0, v0.4.0, v0.5.0, v0.5.1, v0.6.0 | no |
| kore-plugin-terminal | 4 | 3 | v0.2.0 | no |
| kore-plugin-waf | 9 | 3 | v0.2.0, v0.3.0, v0.3.1, v0.4.1, v0.4.2, v0.4.3 | no |

**这张表的读法**：release 从来只在「首次发版」时集中建过（各仓前 1–5 个），后续 tag 推上去了但没补 release——是**批量流程缺口**，不是个别仓漏操作。缺口合计 **90** 个 tag（不含 `kore` 的 6 个子模块 tag）；补建顺序建议：先补「最新 5 个窗口内」的 tag（做完仍在保留策略内，不需要立刻清理），再决定是否用 `--keep` 更小值做历史清退。


### 8.7 2026-11-24 最新 5 补齐后快照

按「每仓最新 5 个 tag 必须有 release」补建 **83 个 tag / 24 个仓**（0 失败，0 无法补建），补建后合计 **157 个 release**。
验收报告：[.agents/verify/gitee-release-fill-latest5.md](../.agents/verify/gitee-release-fill-latest5.md)。

| 仓库 | 补建前 | 新建 | 补建后 | 超 5 |
| --- | ---: | ---: | ---: | :--: |
| kore-plugin-app-deploy | 4 | 3 | 7 | 是 |
| kore-plugin-backup | 3 | 4 | 7 | 是 |
| kore-plugin-container | 3 | 4 | 7 | 是 |
| kore-plugin-cron | 2 | 4 | 6 | 是 |
| kore-plugin-db-mysql | 4 | 3 | 7 | 是 |
| kore-plugin-db-postgres | 4 | 4 | 8 | 是 |
| kore-plugin-discover | 2 | 2 | 4 | 否 |
| kore-plugin-dns | 2 | 5 | 7 | 是 |
| kore-plugin-echo | 3 | 2 | 5 | 否 |
| kore-plugin-file | 3 | 3 | 6 | 是 |
| kore-plugin-firewall | 5 | 2 | 7 | 是 |
| kore-plugin-integrity | 3 | 5 | 8 | 是 |
| kore-plugin-logs | 4 | 4 | 8 | 是 |
| kore-plugin-monitor | 4 | 1 | 5 | 否 |
| kore-plugin-process | 2 | 4 | 6 | 是 |
| kore-plugin-redis | 3 | 3 | 6 | 是 |
| kore-plugin-runtime-node | 3 | 4 | 7 | 是 |
| kore-plugin-runtime-php | 3 | 2 | 5 | 否 |
| kore-plugin-runtime-python | 3 | 5 | 8 | 是 |
| kore-plugin-site | 2 | 5 | 7 | 是 |
| kore-plugin-ssh-guard | 3 | 4 | 7 | 是 |
| kore-plugin-ssl | 3 | 5 | 8 | 是 |
| kore-plugin-terminal | 3 | 1 | 4 | 否 |
| kore-plugin-waf | 3 | 4 | 7 | 是 |

**19 仓超 5，共 39 个老 release 待清退**——本轮**只列清单、未删除**，清单与保留集见验收报告 §8；
授权后走 `scripts/gitee-release-prune.sh --dry-run --keep 5` 复核再执行。缺口总数 90 中另有 7 个落在最新 5 窗口之外（更老版本），按策略不动。
