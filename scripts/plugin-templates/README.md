# 插件仓开源资产模板（唯一真源）

本目录是 24 个 `kore-plugin-<id>` 仓与 1 个 `kore-plugins` 索引仓的开源资产**唯一真源**。`scripts/plugin-oss-sync.sh` 按仓库事实渲染这里的内容并写入兄弟仓；`scripts/plugin-oss-check.sh` 跨仓校验。**不要直接编辑兄弟仓里的这九份文件**——下一次同步会覆盖。

> **CI 策略（2026-11-25 用户裁决「gitea 可以按版本 ci，github 必须是主动触发」）**：26 仓的 GitHub `.github/workflows/ci.yml` **只保留 `workflow_dispatch`**，删掉 `push`（main + tag）与 `pull_request`——GitHub 侧绝不自动触发；Gitea `.gitea/workflows/ci.yml` = `push` tag `v*`（kore 另含 `pkg/pluginapi/v*`）+ `workflow_dispatch`，版本触发在 Gitea 侧。Gitea 服务端是否启用 Actions / 是否注册 act_runner 属服务端前置，本仓只提供配置、未验证。日常反馈仍用本地 `make check`，CI 只做"能否拉取/构建"的兜底。

```
scripts/plugin-templates/
├── README.md
├── plugin-repo/                        # kore-plugin-<id>
│   ├── CONTRIBUTING.md
│   ├── SECURITY.md
│   ├── CODE_OF_CONDUCT.md
│   ├── AGENTS.md                       # ≤ 20 行（R5 硬约束）
│   ├── README-oss-block.md             # <!-- oss:begin --> / <!-- oss:end --> 包住的整段
│   ├── .github/
│   │   ├── PULL_REQUEST_TEMPLATE.md
│   │   ├── ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml
│   │   └── workflows/ci.yml
│   └── .gitea/
│       └── workflows/ci.yml
└── index-repo/                         # kore-plugins
    ├── CONTRIBUTING.md
    ├── SECURITY.md
    ├── CODE_OF_CONDUCT.md
    ├── AGENTS.md                       # ≤ 20 行（R5 硬约束）
    ├── README-oss-block.md
    ├── .github/
    │   ├── PULL_REQUEST_TEMPLATE.md
    │   ├── ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml
    │   └── workflows/ci.yml
    └── .gitea/
        └── workflows/ci.yml
```

## 文件映射

九件套（`files=9`）指前九行；README 段单独按标记块原地替换或追加。

| 模板 | 目标路径（两种仓一致） |
| --- | --- |
| `*/CONTRIBUTING.md` | `CONTRIBUTING.md` |
| `*/SECURITY.md` | `SECURITY.md` |
| `*/CODE_OF_CONDUCT.md` | `CODE_OF_CONDUCT.md` |
| `*/AGENTS.md` | `AGENTS.md` |
| `*/.github/PULL_REQUEST_TEMPLATE.md` | `.github/PULL_REQUEST_TEMPLATE.md` |
| `*/.github/ISSUE_TEMPLATE/bug_report.yml` | `.github/ISSUE_TEMPLATE/bug_report.yml` |
| `*/.github/ISSUE_TEMPLATE/feature_request.yml` | `.github/ISSUE_TEMPLATE/feature_request.yml` |
| `*/.github/ISSUE_TEMPLATE/config.yml` | `.github/ISSUE_TEMPLATE/config.yml` |
| `*/.github/workflows/ci.yml` | `.github/workflows/ci.yml` |
| `*/.gitea/workflows/ci.yml` | `.gitea/workflows/ci.yml` |
| `*/README-oss-block.md` | `README.md` 的 `<!-- oss:begin -->`…`<!-- oss:end -->` 之间 |

**不归模板管**：`LICENSE`（MIT，与 `kore` 仓逐字相同）、`CHANGELOG.md`、`info.json`、`manifest.json`、`Makefile`。同步脚本不读不写这些文件。

## 占位符

值全部来自仓库事实，缺字段即该仓 FAIL 并跳过，不猜。

| 占位符 | 来源 | 示例 |
| --- | --- | --- |
| `{{ID}}` | `info.json.id` | `echo` |
| `{{NAME}}` | `info.json.name` | `Echo 验证插件` |
| `{{MODULE}}` | `go.mod` 的 `module` | `github.com/pengtang1024/kore-plugin-echo` |
| `{{VERSION}}` | `info.json.version` | `0.1.3` |
| `{{REQUIRES_KORE}}` | `info.json.requires_kore` | `>=0.1.0 <0.2.0` |
| `{{PROTOCOL}}` | `info.json.protocol` | `kore.plugin.v1` |
| `{{LIFECYCLE}}` | `info.json.lifecycle` | `lazy` |
| `{{DEPTH}}` | `info.json.depth_level` | `basic` |
| `{{BIN}}` | `basename(info.json.entry)` | `echo` |
| `{{ENTRY}}` | `info.json.entry` | `bin/echo` |
| `{{REPO}}` | 仓库目录名 | `kore-plugin-echo` |
| `{{REPO_URL}}` | `https://github.com/kore-pl/<repo>` | `https://github.com/kore-pl/kore-plugin-echo` |
| `{{YEAR}}` | 固定 `2026`（版权起始年，不逐年改） | `2026` |

索引仓模板只用 `{{REPO}}` / `{{REPO_URL}}` / `{{YEAR}}`。

## 用法

```bash
# 应用到全部兄弟仓（../kore-plugin-* 与 ../kore-plugins），幂等
bash scripts/plugin-oss-sync.sh

# 只报告差异：逐项打印并 exit 1；全绿 exit 0
bash scripts/plugin-oss-sync.sh --check

# 只打印将写哪些文件，不落盘
bash scripts/plugin-oss-sync.sh --dry-run

# 指定仓库
bash scripts/plugin-oss-sync.sh ../kore-plugin-echo ../kore-plugins
bash scripts/plugin-oss-sync.sh --check ../kore-plugin-site

# 跨仓校验：九件套 + Gitea CI / LICENSE / YAML / README 标记块 / 占位残留 / id 一致性 / CI 触发口径
bash scripts/plugin-oss-check.sh
```

## 维护规则

1. **改这里，不改兄弟仓**。兄弟仓的九件套是生成物；要改文案只在模板改，再跑同步。
2. 新增或删除生成文件必须同步改三处：`scripts/plugin-oss-sync.sh` 的映射、`scripts/plugin-oss-check.sh` 的九件套清单、本文件的映射表。
3. 占位符只能来自上表；模板里不出现 `TODO` / `待补充` / `待定`，不写未实现的能力承诺。
4. `YEAR` 固定且不取当前时间——同步结果必须与运行日期无关，否则第二次运行就不再是 0 变更。
5. `AGENTS.md` 每个仓不超过 20 行（R5 硬约束），改完用 `wc -l` 核对。
6. README 只动标记块内部；标记块外一个字节都不改。
7. **CI 触发口径**：GitHub `ci.yml` **只含 `workflow_dispatch`**（不得出现 `push:` / `pull_request:`）；Gitea `ci.yml` 含 `push: tags: ['v*']` + `workflow_dispatch`。`plugin-oss-check.sh` 逐仓校验：GitHub 含 dispatch 且无 push/PR，Gitea 含 tags 与 dispatch；渲染漂移即 FAIL。Gitea 服务端 Actions 启用 / act_runner 注册属服务端前置，不在本模板验证范围。
