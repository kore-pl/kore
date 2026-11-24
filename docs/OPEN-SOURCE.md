> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5

# OPEN-SOURCE — 开源治理

## 1. 许可与版权

**许可**：MIT。**版权人**：`pengtang1024`（自然人，GitHub 个人账户）。**仓库归属**：GitHub 组织 **`kore-pl`**（仓库地址 `github.com/kore-pl/...`，26 仓）。**权威源**：自建 Gitea **`gitea.iouf.cn/kore-pl`**（日常提交 / PR / issue / tag），GitHub 与 gitee 是镜像。

**版权人与仓库归属必须分开写**（这是两份不同的东西，混写即事实错误）：

| 概念 | 值 | 出现位置 |
| --- | --- | --- |
| **版权人** | `pengtang1024`（未迁移） | `LICENSE` 的 `Copyright (c) 2026`、本文 §1 |
| **仓库归属** | GitHub 组织 `kore-pl` | 仓库地址、链接、clone、issue、release |
| **Go module 路径** | `github.com/pengtang1024/kore`（不变） | `go.mod`、import、`require`、`replace`、SDK tag |

26 个仓库**已迁入** `kore-pl` 组织（tag / release 随仓迁移，旧地址 302），迁移事实记录见 [ADR-0017](./DECISIONS/0017-repo-ownership-and-module-path.md) 与 [ADR-0024](./DECISIONS/0024-repo-topology-and-gitea.md) 决策 A。**module 路径有意不改**（ADR-0024 决策 C：已发布 SDK tag 的 import 不能失效）——"仓库地址在 `kore-pl`、module 在 `pengtang1024`"是当前正确状态，不是笔误。

若未来版权人或归属**再变**，必须同步更新**所有仓库**的 `LICENSE` 与本文；这属于**破坏性元数据变更**，必须走 ADR 记录（原因、迁移步骤、下游影响），不允许直接改文件了事。

为什么是 MIT，而不是 Apache-2.0 / AGPL：

| 备选 | 被否理由 |
| --- | --- |
| Apache-2.0 | 多出专利授权与 NOTICE 传递义务；对"薄壳 + 独立插件"这种小体量项目是纯负担，且专利条款在多数贡献者所在法域并不构成实际保护 |
| AGPL-3.0 | 网络使用即触发源码开放，会直接挡住"企业内嵌/内网部署"这一主要使用场景，与锚点"完全归属使用者、无厂商锁"冲突 |
| BSL / 自定义 | 不是 OSI 认可的开源许可，破坏"代码可见可改"的承诺，且让下游法务无法评估 |

**贡献者许可**：**入站 = 出站（inbound=outbound）**。提交 PR 即表示同意该贡献按 MIT 授权，**不要求 CLA**（降低贡献门槛；CLA 会让"顺手修个 typo"变成要走法务的流程）。

**风险兜底**：不签 CLA 的代价是权属追溯弱，用两条机制补——① 保留完整提交历史与作者信息（`Signed-off-by`）；② 要求贡献者用 **DCO**（`git commit -s`）声明有权提交该代码。二者都不改变许可本身。

DCO 的声明文本固定为：`Signed-off-by: 名字 <邮箱>`，含义是"我确认有权按项目许可提交这份代码"。它**不是**版权转让，也**不是** CLA——贡献者保留自己代码的版权，只是同意按 MIT 分发。

贡献者被明确允许的事：商用、闭源再分发、私有 fork、把代码放进自己的产品而不公开改动（MIT 只要求保留版权声明与许可文本）。

## 2. 多仓库的许可一致性

| 仓库 | LICENSE | 说明 |
| --- | --- | --- |
| `kore` | 根 `LICENSE`（MIT） | 内核 + `pkg/pluginapi` + 主壳前端 + 文档 |
| `kore-plugins` | 根 `LICENSE`（MIT） | 纯静态索引与校验脚本 |
| `kore-plugin-<id>` | 根 `LICENSE`（MIT） | 每个插件仓库各放一份，内容逐字相同 |

**除了 `LICENSE`，每个仓库还必须自带一整套开源资产**（贡献指南、披露政策、行为准则、agent 入口、`.github` 模板与 CI）——逐格的现状与规范见 §3、§4。

**仓库地址与权威源**（ADR-0024）：三仓的**仓库地址**一律 `github.com/kore-pl/<repo>`（公开镜像）与 `gitee.com/pengtang1024/<repo>`（国内镜像，与 [GITEE-MIRROR.md](./GITEE-MIRROR.md) §1 及真实 `gitee` remote 一致），**唯一权威源是自建 Gitea `gitea.iouf.cn/kore-pl/<repo>`**——日常提交、PR、issue、tag 都在 Gitea，GitHub 只做公开镜像。**module 路径仍是 `github.com/pengtang1024/...`**（ADR-0024 决策 C），与仓库地址分开写。

**SDK 单独发布**：`pkg/pluginapi` 是独立 module（`github.com/pengtang1024/kore/pkg/pluginapi`），用子目录 tag（`pkg/pluginapi/v0.x.y`）发版；协议版本号与内核 `kore.plugin.v1` 对齐，插件只依赖 SDK tag，不依赖内核 tag。

**第三方依赖许可**（当前仅 2 个，均兼容 MIT）：

| 依赖 | 许可 | 用途 |
| --- | --- | --- |
| `gopkg.in/yaml.v3` | MIT / Apache-2.0 双许可 | 配置解析 |
| `go.etcd.io/bbolt` | MIT | 状态库 |

**LICENSE 文件的硬要求**（G-26）：每个仓库根目录放同一份 MIT 全文，首行 `MIT License`，含 `Copyright (c) 2026 pengtang1024` 与 `Permission is hereby granted, free of charge, ...` 段落；**不得混入** Apache/GPL 头或"部分代码来自 XX"的附加限制。年份写起始年，不逐年改。

**新增依赖的门槛（与 G-02 配套）**：必须**同时**满足①许可兼容 MIT（MIT / BSD / Apache-2.0 等宽松许可；GPL / AGPL 一律拒绝）②进依赖白名单（当前上限 3，第三个是 M3 才引入的 `protobuf`）。两条缺一不可——"许可没问题"不等于"可以加"，"白名单有空位"也不等于"许可没问题"。

## 3. 多仓开源资产矩阵

**25 个兄弟仓**（24 个 `kore-plugin-<id>` + `kore-plugins` 索引仓）**各自自包含**同一套开源资产，加上 `kore` 本仓共 **26 个仓库**。`kore` 是唯一手工维护方；25 个兄弟仓由 `scripts/plugin-templates/` 渲染生成（唯一真源），**禁止各仓手改漂移**。

`有` = 文件在该仓根且内容合规；`有（模板渲染）` = 由 `bash scripts/plugin-oss-sync.sh` 从模板生成，`bash scripts/plugin-oss-check.sh` 逐仓校验。

| 资产 | `kore` | `kore-plugins` | `kore-plugin-<id>`（24 个） |
| --- | --- | --- | --- |
| `LICENSE`（MIT 全文） | 有 | 有 | 有（与 `kore` 逐字一致，不进模板） |
| `CONTRIBUTING.md` | 有 | 有（模板渲染） | 有（模板渲染） |
| `SECURITY.md`（披露政策，72h / 90 天） | 有 | 有（模板渲染） | 有（模板渲染） |
| `CODE_OF_CONDUCT.md` | 有 | 有（模板渲染） | 有（模板渲染） |
| `CHANGELOG.md` | 有 | 有 | 有（各仓独立维护，不进模板） |
| `AGENTS.md`（≤20 行，R5） | 有（完整协作中枢） | 有（模板渲染） | 有（模板渲染） |
| `.github/PULL_REQUEST_TEMPLATE.md` | 有 | 有（模板渲染） | 有（模板渲染） |
| `.github/ISSUE_TEMPLATE/` 三件（`bug_report.yml` / `feature_request.yml` / `config.yml`） | 有 | 有（模板渲染） | 有（模板渲染） |
| `README` 开源段（`<!-- oss:begin -->`…`<!-- oss:end -->`） | 有（原生「## 开源」段） | 有（模板渲染） | 有（模板渲染） |
| `.github/workflows/ci.yml` | 有，少触发：`push main` / tag / PR / `workflow_dispatch` | 有，少触发：同左；**Gitea 不配** | 有，少触发：同左；**Gitea 不配** |

**CI 口径**（2026-11-23 用户要求，正文见 [.agents/QUALITY-GATES.md](../.agents/QUALITY-GATES.md) §6）：`kore` 与 25 个兄弟仓（共 26 个仓）**都配 CI，但只在 `push main` / tag（`v*`）/ `pull_request` / `workflow_dispatch` 时跑**，日常 feature 分支 push 不跑；Gitea 侧不配 CI（无 `.gitea/workflows/`、无 woodpecker / drone）。日常反馈用本地 `make check`，CI 只做合入兜底。

**不归模板管的三类文件**：`LICENSE`（逐字同一份）、`CHANGELOG.md`（各仓版本条目独立）、`info.json` / `manifest.json` / `Makefile`（各仓事实）。同步脚本不读不写这些文件。

## 4. 插件仓开源资产规范（九件套）

**九件套** = 下列九份文件（脚本里 `files=9`）；`README` 开源段单独按标记块原地替换，不算在这九份里。

| 文件 | 职责 | 硬要求 |
| --- | --- | --- |
| `CONTRIBUTING.md` | 本仓贡献入口 | 写清本仓 `make check` / `make dist` 命令、九件套不得手改、DCO（`git commit -s`）、安全披露指向根政策；不得把 `kore` 的 `.agents/` 协作流程整套复制过来（R5） |
| `SECURITY.md` | 本仓披露政策 | 与根 `SECURITY.md` **同口径**：72 小时内确认 / 修复后协调披露默认 90 天；**不得**回填旧版的短时限口径（两日内确认 / 一周内评估 / 一月内出补丁，均已废止） |
| `CODE_OF_CONDUCT.md` | 行为准则 | 与 `kore` 同一份文本；举报渠道指向维护者邮箱，不指向公开 issue |
| `AGENTS.md` | agent 入口 | **≤20 行（R5 硬约束）**；只写本仓事实（id / module / 构建与 `dist` / 只依赖 `pkg/pluginapi`）+ 指向 `kore` 的治理真源；超一行即违规 |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 模板 | 必须留 `make check` 与两次 `make dist` sha 一致性的输出位，并有「是否改协议 / `info.json`」勾选项 |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 缺陷模板 | 必填：插件版本 / `requires_kore` / 平台 / 复现步骤 / 日志片段；字段预填本仓 `id` |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 需求模板 | 必填：使用场景 / 期望行为 / 能否用现有能力替代 |
| `.github/ISSUE_TEMPLATE/config.yml` | issue 入口配置 | `blank_issues_enabled: false`，外链到安全披露与 discussions；避免漏洞走公开 issue |
| `.github/workflows/ci.yml` | 仓内 CI | **少触发**：`push main` / `tag v*` / `pull_request` / `workflow_dispatch`；只跑 `gofmt` / `go vet` / `go test` / `make dist`；Gitea 不配 |

**唯一真源**：[scripts/plugin-templates/](../scripts/plugin-templates/README.md) —— `plugin-repo/`（24 个插件仓）与 `index-repo/`（`kore-plugins`）。改文案只在模板改，**不直接编辑兄弟仓**，否则下一次同步覆盖。

**幂等命令**（两条，都在 `kore` 仓根执行）：

```bash
# 1) 同步：按仓库事实渲染并写入全部兄弟仓，幂等（第二次运行 0 变更）
bash scripts/plugin-oss-sync.sh
bash scripts/plugin-oss-sync.sh --dry-run        # 只打印将写哪些文件
bash scripts/plugin-oss-sync.sh --check          # 只报差异，全绿 exit 0
bash scripts/plugin-oss-sync.sh ../kore-plugin-echo ../kore-plugins   # 指定仓库

# 2) 校验：跨仓检查九件套 / LICENSE / YAML / README 标记块 / 占位残留 / id 一致性 / CI 少触发
bash scripts/plugin-oss-check.sh
```

**门禁接线**：`make check` **第 13 段**（`scripts/plugin-oss-check.sh`）逐仓校验 25 个兄弟仓，任一仓缺件或 CI 触发漂移即整段红。`make oss-check`（第 8 段）只覆盖 `kore` 本仓的根资产（G-26），两者分工不同，不能互相替代。

**新插件仓建仓**：新建 `kore-plugin-<id>` 仓 → 填 `info.json` / `Makefile`（含 `dist`）/ `CHANGELOG.md` → 在 `kore` 仓执行 `bash scripts/plugin-oss-sync.sh ../kore-plugin-<id>` → `bash scripts/plugin-oss-check.sh ../kore-plugin-<id>` 两条均 exit 0，即完成九件套。

**被否决的方案**：①各仓手写一份（必然漂移，26 份 YAML 各自过期）；②用 git submodule 共享（G-13 明确禁止 submodule）；③只在 `kore` 放模板、兄弟仓不落文件（GitHub 上缺 `LICENSE` / `SECURITY` 等于没声明，第三方无法判断授权与披露渠道）。

## 5. 名称与标识

- **项目名 `Kore` / `kore` 可自由用于 fork 与衍生作品**：允许在 README、包描述、商店页写「基于 kore」「兼容 kore 插件协议」。
- **不得暗示官方背书**：不得使用「官方」「认证」「Kore 团队」等表述，不得把衍生版本说成 `kore-pl` 组织的发行物，不得使用与官方仓库相同或近似的仓库名 / 图标 / 域名以混淆来源。
- **插件商店 / 索引名称**：官方索引名固定 `kore-plugins`；第三方索引必须带自有标识（如 `mycorp-kore-plugins`），不得占用 `kore-plugins` 或 `kore-plugin-<id>` 命名空间。
- **插件 id**：官方插件 id 由项目分配（见 [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md)）；第三方插件用自有 id，不得冒用官方 id，也不得在 `info.json` 里填官方仓库 URL。
- **商标未注册**：本项目**不主张任何商标独占权**。本节只约束**来源混淆**（谁做的、是否官方），不限制描述性使用——「基于 kore」「兼容 kore 插件协议」这类表述正常使用即可，无需申请。

## 6. 贡献者路径

| 路径 | 入口 | 第一个 PR 建议 | 评审期望 |
| --- | --- | --- | --- |
| **good first issue** | Gitea `kore` 与各插件仓 Issues（标签 `good first issue` / `docs`） | 文档错字、失效链接、术语不一致、`docs-check` 报出的行数或口径问题 | 1 位维护者 review，`make docs-check` 绿即合；不强制先开 issue |
| **插件作者** | 自建 `kore-plugin-<id>` 仓库 → 向 Gitea 的 `kore-plugins` 提索引 PR | 一个只做 `hello` / `ping` 的最小插件 + 九件套齐备 + 两次 `make dist` sha 一致 | 索引 PR 由 `kore-plugins/scripts/validate.sh` 自动校验（无人审）；插件本体只评审协议用法与资源预算 |
| **维护者** | 在 Gitea Issue / PR 持续贡献后由现有维护者邀请 | 无固定门槛；建议先独立承担一个子域（如 `docs/` 或某插件的 `tests/fault/`） | 需能复跑 `make check` 并给出证据、能为合入结果背书；架构级变更按 §7 的 ADR + 2 票机制 |

**Issues / PR 入口在 Gitea**（ADR-0024 决策 D，同构换仓名即可）：`https://gitea.iouf.cn/kore-pl/kore/issues`、`https://gitea.iouf.cn/kore-pl/kore-plugins/issues`、`https://gitea.iouf.cn/kore-pl/kore-plugin-<id>/issues`（24 个插件仓）。**GitHub 上是只读公告面**：已有 8 个 issue 保留不关闭并加了迁移标注，但**不再在那里接受新 issue / PR**，更新一律回 Gitea。安全漏洞既不走 Gitea Issues 也不走 GitHub Issues，走根 `SECURITY.md` 的邮件披露。

## 7. 社区与治理

| 角色 | 权利 | 义务 |
| --- | --- | --- |
| 用户 | 使用、提 issue、提需求 | 遵守许可；安全问题上走披露流程而非公开 issue |
| 贡献者 | 提 PR、参与讨论 | 跑通对应门禁；DCO 签署；不夹带无关改动 |
| 维护者 | 合并 PR、跑门禁、发版、关闭不符合方向的 PR | 对合并结果负责：合进去的代码与文档由维护者背书 |

**决策机制**：技术争议以 **ADR** 为准（`docs/DECISIONS/`），不以"谁嗓门大"或"谁先实现"为准。**架构级变更**（模块边界、协议、预算、目录拓扑）必须 ADR + **维护者 2 票**；普通修复由任一维护者合并即可。

**争议升级流程**（三步，逐级上升，不跳级）：

1. 在 PR / issue 内用文字对齐事实与影响，维护者在 5 个工作日内给出明确答复（同意 / 反对 + 理由）。
2. 无法达成一致 → 提 ADR 草案，列全部备选与代价；维护者 **2 票**通过即定案。
3. 仍无共识 → 以"不做"为默认结果（保持现状），并把分歧记入 ADR 的"被否选项"。**默认不做**是刻意的：开源项目最大的成本不是做错，是在争议里空转。

**非目标保护**：任何 PR 触及 `AGENTS.md` G-11 的**六项明确不做**（多用户 RBAC、集群/多机、模板市场、厂商云存储深度集成、拖拽建站、i18n 全量框架），**直接关闭并附理由**，不进入讨论。想推翻必须先有 ADR，而不是先有代码。i18n 已按 [ADR-0021](./DECISIONS/0021-i18n.md) 收窄为「中文为主 + 英文可选的导航骨架」，继续扩语言或引框架仍需新 ADR。

## 8. 发版与版本策略

**SemVer**：`MAJOR.MINOR.PATCH`。`0.x` 阶段（当前 `0.1.0`）**允许破坏性变更**，但必须同时满足：① 有 ADR 记录原因与迁移路径；② `CHANGELOG.md` 标 `BREAKING`；③ 插件 `requires_kore` 区间同步。`1.0.0` 之后破坏性变更只能走 MAJOR。

**版本对应关系**：插件 `info.json.requires_kore` 声明可接受的内核区间（如 `>=0.2.0 <0.3.0`）。发版顺序固定为 **SDK tag 先发 → 内核发版 → 插件按新区间发版**，避免出现"内核已发、SDK 还没 tag"的空窗。

**版本对应示例**：

| kore | SDK tag | 协议 | 插件 `requires_kore` 示例 |
| --- | --- | --- | --- |
| `0.1.x` | `pkg/pluginapi/v0.1.0` | `kore.plugin.v1` | `>=0.1.0 <0.2.0` |
| `0.2.x` | `pkg/pluginapi/v0.2.0` | `kore.plugin.v1` | `>=0.2.0 <0.3.0` |
| `1.0.x` | `pkg/pluginapi/v1.0.0` | `kore.plugin.v1` | `>=1.0.0 <2.0.0` |

**CHANGELOG 要求**：每仓根 `CHANGELOG.md`（Keep a Changelog 结构），发版必须写"新增 / 变更 / 修复 / 破坏性"四段；没有 CHANGELOG 的版本不发（G-17 三件套之一）。

**产物**：

| 产物 | 形态 | 平台 |
| --- | --- | --- |
| `kored` | 静态二进制（`CGO_ENABLED=0`，`-trimpath -s -w`） | linux/amd64、linux/arm64（v1.0 GA）；darwin/windows 为 preview |
| 插件包 | `<id>-<version>.tar.gz` + sha256 | 每插件仓库 `make dist` 产出 |
| 索引 | `index/plugins.json` | `kore-plugins` 仓库，静态 JSON |

**每个仓库的 release 资产**：插件仓 release 挂 `tar.gz` + 同名 `.sha256`；`kore` 仓 release 挂 `kored` + checksums。release 是索引的唯一数据源，CI 的 tag 触发只负责构建与打包，不再重跑全量门禁（口径见 [.agents/QUALITY-GATES.md](../.agents/QUALITY-GATES.md) §6 与 [REPOS.md](./REPOS.md) §7）。

## 9. 安全与披露

- **披露政策**：根 [`SECURITY.md`](../SECURITY.md) 是**唯一真源**（报告渠道、支持版本、响应时限、致谢方式）；本节只做摘要，任何冲突以根 `SECURITY.md` 为准。
- **设计说明**：[SECURITY.md](./SECURITY.md)（信任边界、鉴权、CSRF、插件隔离、审计）。

**响应时限**（尽力而为，不构成 SLA，与根 `SECURITY.md` 逐条对齐）：**72 小时内确认收到并给出初判**；复杂问题同步排查计划；修复完成后协调披露，**默认 90 天**窗口，如需提前披露（例如已被实际利用）先与维护者沟通。超时不等于"不管"，报告者可在一周后 ping 一次。

- **修复优先**：安全修复**可以跳过常规流程**（不等完整评审队列），**不发预公告**，优先出 patch 版本；公开披露时间由报告者与维护者共同商定，默认在补丁可用后。

**CI 少触发与无遥测互不影响**：CI 只在主干、tag 与 PR 上跑，省的是 runner 分钟，不是为了收集数据——项目仍按 G-10 保持**无账号、无使用统计、无崩溃上报、无联网校验**；空载出站连接为 0，这一点与 CI 触发频率无关，也不因 CI 跑得多而改变。

## 10. 不做什么（开源侧）

1. **不做 SaaS、不做托管版**：本项目只发布可自部署的软件，不做"官方云"。
2. **不收集遥测**：无使用统计、无崩溃上报、无心跳；空载出站连接为 0（G-10 / G-19 可验证）。
3. **不加账号体系**：不要求注册、不要求邮箱验证、不做登录墙。
4. **不设"贡献者协议墙"**：无 CLA、无贡献者等级、无"先签协议才能提 PR"。
5. **不做模板市场/插件审核**：索引是静态 JSON，不代管包、不做审核队列（与 VISION 非目标一致）。

## 11. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| `LICENSE`（根） | 许可正文；本文件只解释治理口径，不复写条款 |
| [SECURITY.md](../SECURITY.md)（根） | 安全披露流程**唯一真源**（72h / 90 天）；本文件第 9 节只作摘要 |
| [SECURITY.md](./SECURITY.md)（docs） | 安全设计（信任边界、鉴权、隔离），与根披露政策**两者不要混** |
| [REPOS.md](./REPOS.md) | 多仓库拓扑、R9「开源资产自包含」规则与每仓发布流程；本文件第 2/3/8 节与其一致 |
| [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md) | 20 个产品插件的逐插件开源信息（仓库 / Issues / Releases / 维护状态 / 验证方式）见其 §15 |
| [PLUGIN-SDK.md](./PLUGIN-SDK.md) | 第三方插件接入契约；其「插件仓开源资产九件套」清单与本文件 §4 同源 |
| [ADR-0024](./DECISIONS/0024-repo-topology-and-gitea.md) | 仓库归属 `kore-pl`、Gitea 为权威源、module 路径不变、issue/PR 在 Gitea 的四条裁决；本文件 §1/§2/§6 与其一致 |
| [ADR-0017](./DECISIONS/0017-repo-ownership-and-module-path.md) | 仓库迁移记录与 module 路径沿革 |
| [scripts/plugin-templates/](../scripts/plugin-templates/README.md) | 25 个兄弟仓开源资产的**唯一真源**，含模板映射、占位符表与同步/校验命令 |
| [VISION.md](./VISION.md) | "完全归属使用者、无厂商锁、无遥测"的锚点来源 |
| [DECISIONS/](./DECISIONS/) | 架构级决策的 ADR；治理争议以 ADR 为准 |

> 许可选型的检验标准只有一条：**用户能不能拿走、改掉、闭源或商用，而不需要问我们**。MIT 的答案是"能"；AGPL 的答案是"要看情况"——后者与"完全归属使用者"的锚点直接冲突。
