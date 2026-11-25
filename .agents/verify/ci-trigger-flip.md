# ci-trigger-flip 验收报告

> 日期：2026-11-25 · 执行者：ci-trigger-flip（implementer）· 裁决来源：用户原话「gitea 可以按版本 ci，github 必须是主动触发」

## 0. 结论

26 仓 GitHub CI 的 `on:` 段**只含 `workflow_dispatch`**（push main / tag 与 pull_request 全删，绝不自动触发）；26 仓新增 Gitea CI（`push: tags: ['v*']` + `workflow_dispatch`，kore 另含 `pkg/pluginapi/v*`）。模板单一真源已改（`scripts/plugin-templates/{plugin-repo,index-repo}/` 双 ci.yml + README oss 段），`plugin-oss-sync.sh` FILES 清单纳入 Gitea ci.yml；`plugin-oss-check.sh` 判据改为「GitHub 含 dispatch 且无 push/PR；Gitea 含 tags + dispatch」。所有验收命令 exit 0。**未 push、未执行任何 workflow、未改 kore 运行态资产**。

## 1. 验收命令与退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `bash .tmp/verify-ci-triggers.sh`（一次性脚本，跑完即删） | 0 | `TOTAL=26 GH_OK=26 GITEA_OK=26` |
| `bash scripts/plugin-oss-sync.sh`（apply） | 0 | 25 仓 `[DIFF] ... changed=N（已写入）`，无 `[FAIL]` |
| `bash scripts/plugin-oss-sync.sh`（第二次 apply，幂等性） | 0 | 25 仓全部 `[OK] ... changed=0` |
| `bash scripts/plugin-oss-sync.sh --check` | 0 | 25 仓全部 `[OK] ... files=9 changed=0`，零漂移 |
| `bash scripts/plugin-oss-check.sh` | 0 | `汇总: 25 pass / 0 warn / 0 fail` |
| `make oss-check` | 0 | `oss-check: 8 pass, 0 warn, 0 fail` |
| `make docs-check` | 0 | `docs-check: 5 pass, 1 warn, 0 fail`（WARN = `docs/SECURITY.md` 469 行越界，存量不阻断） |
| `make secret-check` | 0 | `secret-check: 0 FAIL / 23 处匹配（占位写法均合规）` |

一次性验证脚本已删除（`ls .tmp/verify-ci-triggers.sh` → none）。

## 2. 逐仓触发形态核对口径

- GitHub：取 `on:` 段（从 `^on:` 到下一个顶层键），必须出现 `workflow_dispatch`，且不得出现 `^[[:space:]]*(push|pull_request):`。
- Gitea：`.gitea/workflows/ci.yml` 同时出现 `workflow_dispatch` 与 `^[[:space:]]*tags:`。
- 结果：26/26 双端合规，0 BAD。kore 本仓 Gitea tags = `['v*', 'pkg/pluginapi/v*']`；其余 25 仓 = `["v*"]`。

## 3. 改动边界

- **kore 本仓（单改，不在模板覆盖范围）**：`.github/workflows/ci.yml`、`.gitea/workflows/ci.yml`；模板源 `scripts/plugin-templates/{plugin-repo,index-repo}/.github/workflows/ci.yml` + 新增两个 `.gitea/workflows/ci.yml` + 两个 README oss 段；`scripts/plugin-oss-{sync,check}.sh`；`scripts/plugin-templates/README.md`；`AGENTS.md`（G-26 + §5 触发段）；`.agents/QUALITY-GATES.md` §6；`CONTRIBUTING.md`；`docs/{OPEN-SOURCE,REPOS,PLUGIN-SDK,PLUGIN-CATALOG}.md`；`.agents/LOG/DECISIONS.md`（新裁决含 4 个被否决选项及依据）；`docs/DECISIONS/0024-repo-topology-and-gitea.md`（append-only §7，§0–§6 原文不动）；本报告。
- **25 个兄弟仓**：由 sync 渲染 `.github/workflows/ci.yml`、`.gitea/workflows/ci.yml`、`README.md` oss 段；同步还修正了存量版本漂移（`CONTRIBUTING.md` / `SECURITY.md` / `.github/ISSUE_TEMPLATE/bug_report.yml` 中 expiring 版本号回填为各仓 `info.json.version`）——这是保持 `--check` 零漂移所必需的生成物，非顺带重构。
- **未碰**：`scripts/oss-check.sh`（与触发器无关）、`kore/.agents/LOG/DECISIONS.md` 历史条目原文、CHANGELOG 历史原文、各仓 `LICENSE` / `info.json` / `manifest.json` / `Makefile`、运行态资产、任何 remote 与 tag。

## 4. 诚实标注：未验证项与服务端前置

- **Gitea Actions 服务端启用 / act_runner 注册 / 仓库 workflow 权限：未验证。** 本批只在 26 仓落 `.gitea/workflows/ci.yml` 配置文件；配置存在 ≠ 服务端会执行。需 Gitea 管理员确认实例已开启 Actions 且至少有一名可用 runner，并在打 tag 后观察实际 run。未经此确认，Gitea「按版本自动 CI」只是配置就绪，不代表端到端可用。
- **未执行任何 workflow**：所有验证均为本地 shell / Makefile；未 push、未打 tag、未调用任何远端 API。
- **GitHub 侧安全性验证方式**：静态核对 26 份 `on:` 段，而非向 GitHub 推一次触发观察——后者违反硬约束，故不执行；静态形态（只留 workflow_dispatch）是当前唯一可证明"不会被自动触发"的配置。

## 5. 复查命令（供 verifier 独立复跑）

```bash
cd /home/pt/Work/GolandProjects/kore-pl/kore
bash scripts/plugin-oss-sync.sh --check
bash scripts/plugin-oss-check.sh
make oss-check && make docs-check && make secret-check
# 逐仓 on: 段核对：awk 提取 on: 块，断言 GH 无 push:/pull_request: 且有 workflow_dispatch；Gitea 有 tags: + workflow_dispatch
```
