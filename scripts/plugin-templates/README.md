# 插件仓开源资产模板（唯一真源）

本目录是 24 个 `kore-plugin-<id>` 仓与 1 个 `kore-plugins` 索引仓的开源资产**唯一真源**。`scripts/plugin-oss-sync.sh` 按仓库事实渲染这里的内容并写入兄弟仓；`scripts/plugin-oss-check.sh` 跨仓校验。**不要直接编辑兄弟仓里的这八份文件**——下一次同步会覆盖。

> **CI 策略（2026-11-23）**：GitHub CI 只在 **kore 根仓** 的 push main / tag / PR / workflow_dispatch 跑。24 个插件仓与索引仓**一律不配 CI**，日常验证用本地 `make check`。因此本目录不提供 `.github/workflows/` 模板；同步脚本不创建、不删除目标仓的 workflow 文件，存在只在 check 里 WARN 提示人工确认。

```
scripts/plugin-templates/
├── README.md
├── plugin-repo/                        # kore-plugin-<id>
│   ├── CONTRIBUTING.md
│   ├── SECURITY.md
│   ├── CODE_OF_CONDUCT.md
│   ├── AGENTS.md                       # ≤ 20 行（R5 硬约束）
│   ├── README-oss-block.md             # <!-- oss:begin --> / <!-- oss:end --> 包住的整段
│   └── .github/
│       ├── PULL_REQUEST_TEMPLATE.md
│       └── ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml
└── index-repo/                         # kore-plugins
    ├── CONTRIBUTING.md
    ├── SECURITY.md
    ├── CODE_OF_CONDUCT.md
    ├── AGENTS.md                       # ≤ 20 行（R5 硬约束）
    ├── README-oss-block.md
    └── .github/
        ├── PULL_REQUEST_TEMPLATE.md
        └── ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml
```

## 文件映射

八件套（`files=8`）指前八行；README 段单独按标记块原地替换或追加。

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
| `*/README-oss-block.md` | `README.md` 的 `<!-- oss:begin -->`…`<!-- oss:end -->` 之间 |

**不归模板管**：`LICENSE`（MIT，与 `kore` 仓逐字相同）、`CHANGELOG.md`、`info.json`、`manifest.json`、`Makefile`、`.github/workflows/`。同步脚本不读不写这些文件；目标仓若已有 workflow，脚本只 WARN、不删除。

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

# 跨仓校验：八件套 / LICENSE / YAML / README 标记块 / 占位残留 / id 一致性
bash scripts/plugin-oss-check.sh
```

## 维护规则

1. **改这里，不改兄弟仓**。兄弟仓的八件套是生成物；要改文案只在模板改，再跑同步。
2. 新增或删除生成文件必须同步改三处：`scripts/plugin-oss-sync.sh` 的映射、`scripts/plugin-oss-check.sh` 的八件套清单、本文件的映射表。
3. 占位符只能来自上表；模板里不出现 `TODO` / `待补充` / `待定`，不写未实现的能力承诺。
4. `YEAR` 固定且不取当前时间——同步结果必须与运行日期无关，否则第二次运行就不再是 0 变更。
5. `AGENTS.md` 每个仓不超过 20 行（R5 硬约束），改完用 `wc -l` 核对。
6. README 只动标记块内部；标记块外一个字节都不改。
7. **不加 CI 模板**：插件仓与索引仓按 2026-11-23 策略不配 CI；需要门禁就在本地跑 `make check` / `make dist`。
