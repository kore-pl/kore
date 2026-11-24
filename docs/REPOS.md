> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5

# REPOS — 多仓库拓扑与跨仓库规则

## 0. 文档定位

| 项 | 内容 |
| --- | --- |
| 读者 | 所有参与 kore 的 agent；新增插件仓库的人；发版与索引维护者 |
| 作用 | 定义仓库清单、单向依赖、跨仓库规则 R1–R9、本地联调、版本兼容与发布流程 |
| 不作用 | 不写内核模块规格（见 [CORE.md](./CORE.md)）、不写组件与数据流（见 [ARCHITECTURE.md](./ARCHITECTURE.md)）、不写协议字段（见 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md)） |
| 硬约束 | 项目是**多 git 仓库**：`kore` 只含内核与主壳，插件各有独立仓库；"插件放在 kore 的 `plugins/` 子目录"这一旧假设**已作废** |
| 仓库归属 | 全部 module 用 `github.com/pengtang1024/...`；发布仓库在 `kore-pl` 组织下（2026-11-23 迁移，见 ADR-0017），不留第二套写法 |

一句话：**内核一个仓库，插件一个仓库，索引一个仓库；三者的唯一连接是 tag 依赖与静态发布物，不是子目录。**

## 1. 仓库清单

| 仓库 | 定位 | module 路径 | 内容 | 发布物 | 开源资产 | CI 触发 |
| --- | --- | --- | --- | --- | --- | --- |
| `kore` | 内核 + 主壳（唯一内核仓库） | `github.com/pengtang1024/kore` | `cmd/kored/`、`internal/core/*`、`pkg/pluginapi/`、`web/`、`docs/`、`.agents/`、`scripts/`、`Makefile` | `kored` 单二进制 + checksums | 九件套齐备（手工维护，唯一非模板仓） | 少触发：`push main` / tag / PR / 手动 |
| `kore-plugins` | 插件中心/索引（纯静态聚合） | `github.com/pengtang1024/kore-plugins` | `index/plugins.json`、`cmd/indexer/`、`scripts/validate.sh`、`site/`（M4） | 索引 JSON + 静态市场页（M4） | 九件套齐备（模板渲染） | 少触发：同左；**Gitea 不配** |
| `kore-plugin-<id>` | 每个插件一个仓库（模板行） | `github.com/pengtang1024/kore-plugin-<id>` | `main.go`、`info.json`、`web/`（可选）、`Makefile`、`CHANGELOG.md` | `<id>-<version>.tar.gz` + `.sha256` | 九件套齐备（模板渲染） | 少触发：`push main` / tag `v*` / PR / 手动；**Gitea 不配** |
| `kore-plugin-echo` | M1 验证件（Walking Skeleton） | `github.com/pengtang1024/kore-plugin-echo` | 同上，仅实现 hello/ping/echo 与 `kore.event` | 同上 | 同模板行（模板渲染） | 同上 |
| `kore-plugin-site` | 常驻插件（M2） | `github.com/pengtang1024/kore-plugin-site` | 同上 + 站点管理能力 + `web/` | 同上 | 同模板行（模板渲染） | 同上 |
| `kore-plugin-backup` | 一次性插件（M2） | `github.com/pengtang1024/kore-plugin-backup` | 同上 + 触发式备份 | 同上 | 同模板行（模板渲染） | 同上 |
| `kore-plugin-sdk-rust` / `-starlark` | 非 Go SDK（M4 可选） | 同名 | 帧编解码 + hello 示例 | crate/包 | 建仓即套用九件套 | tag |

**仓库地址 vs module 路径**（[ADR-0024](./DECISIONS/0024-repo-topology-and-gitea.md) 决策 C）：**仓库地址**一律 `github.com/kore-pl/<repo>`（公开镜像）与 `gitee.com/kore-pl/<repo>`（国内镜像），**权威源是自建 Gitea `gitea.iouf.cn/kore-pl/<repo>`**；**module 路径保持 `github.com/pengtang1024/...`**。两件事分开写，不混用。

「开源资产」列的口径是**自包含**：该仓根目录自己带 `LICENSE` / `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `CHANGELOG.md` / `AGENTS.md` / `.github`（PR 模板 + issue 模板三件 + `ci.yml`）/ README 开源段，规则见 §3 的 R9，逐文件硬要求见 [OPEN-SOURCE.md](./OPEN-SOURCE.md) §4。

索引仓库的边界（防止它长成平台）：**纯静态聚合，不做人工审核、不代管包、无账号、无上传接口**。它只读插件仓库的 release 产物，把 `{id,version,requires_kore,protocol,sha256,url,size}` 聚合成一个 JSON。

## 2. 仓库拓扑

```
              ┌──────────────────────────────────────────┐
              │ github.com/pengtang1024/kore             │
              │ cmd/kored · internal/core                │
              │ pkg/pluginapi（公开协议 SDK，必须公开）   │
              │ web/ · docs/ · .agents/                   │
              └───────────────┬──────────────────────────┘
                              │ require(tag vX.Y.Z)
                              │ 只允许 import pkg/pluginapi
        ┌─────────────────────┴───────────────────────┐
        ▼                                             ▼
┌─────────────────────────────┐         ┌────────────────────────────────┐
│ kore-plugin-<id>（每插件一仓）│         │ kore-plugins（索引/市场）        │
│ main.go · info.json · web/   │         │ index/plugins.json · indexer    │
│ Makefile → tar.gz + sha256   │         │ 只读聚合：不代管包、无审核、无账号 │
└──────────────┬──────────────┘         └───────────────▲────────────────┘
               │ release 挂 tar.gz + sha256                │ PR 更新索引
               └───────────────────────────────────────────┘
   运行期：kore 只读 /var/lib/kore/plugins/ 下的本地包，不访问索引、不联网
```

箭头含义（三条，不可增删）：

1. **插件 → kore**：编译期单向依赖，只允许 `pkg/pluginapi`；插件仓库不 import `internal/*`。
2. **插件 → 索引**：发布物单向流动（release 资产 → 索引条目），索引不回写插件仓库。
3. **kore ⇸ 插件/索引**：运行期零依赖。kore 不 import 任何插件仓库、不请求索引；索引挂了不影响已装插件运行。

## 3. 跨仓库规则 R1–R9

| 规则 | 内容 | 违反的后果 |
| --- | --- | --- |
| **R1 依赖单向** | 插件 → `kore/pkg/pluginapi`；kore 不 import 插件；索引只读插件发布物 | 出现循环依赖后两边都无法独立发版；kore import 插件直接违红线①②，内核体积与构建时间被插件拖住 |
| **R2 协议包公开** | 协议包不得放 `internal/`；破坏性改动 = kore 主版本递增 + ADR + 索引标记不兼容 | 放 `internal/` 时外部仓库**编译期就被 Go 拒绝**，插件根本无法接入；破坏性改动不做版本递增会让已装插件静默跑坏 |
| **R3 版本声明** | `info.json` 必填 `requires_kore`（如 `">=0.1.0 <0.2.0"`）；kore 加载校验不通过回 `E_UNSUPPORTED` | 缺这个字段时 kore 无法判断兼容性，只能"先跑起来再说"——出问题在生产而不是安装时 |
| **R4 独立版本** | 各仓库独立 tag `vX.Y.Z`，插件不因 kore 发版强制跟随 | 版本联动疲劳：kore 每发一次版所有插件被迫重发，插件作者流失 |
| **R5 协作文件归属** | `.agents/` 只在 `kore`；其它仓库只放 `AGENTS.md` 且 ≤ 20 行 | 每个仓库复制一套 agent 体系 = 规则漂移，五份 WORKFLOW 互相打架 |
| **R6 变更集** | 跨仓库改动在 `kore` 的 `.agents/BOARD.md` 登记为**一个变更集**（change set） | 跨仓库改动没有单一负责人与验收证据，容易出现"kore 改了、插件没发、索引没更新"的半上线 |
| **R7 各自构建** | 各仓库自带 `Makefile`；kore 的 `make` 不构建插件 | kore 的构建依赖兄弟仓库路径，CI 不可复现，clone 下来就红 |
| **R8 门禁归属** | `docs-check` 只在 `kore` 跑 | 插件仓库没有 `docs/` 与 `.agents/` 结构，跑 kore 的门禁永远红，最后被"跳过" |
| **R9 开源资产自包含** | 每个仓库自带 `LICENSE` / `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `CHANGELOG.md` / `AGENTS.md` / `.github`（PR 模板 + issue 模板三件 + `ci.yml`）/ README 开源段；九件套由 `scripts/plugin-templates/` 渲染，**禁止各仓手改漂移**；跨仓校验 `bash scripts/plugin-oss-check.sh`（`make check` 第 13 段），单仓预览 `--dry-run` / `--check` 走 `bash scripts/plugin-oss-sync.sh` | 缺件即第 13 段红：GitHub 上缺 `LICENSE` 等于默认保留所有权利，缺 `SECURITY.md` 等于没有披露渠道；各仓手改会与模板漂移，下次同步被覆盖且校验报差异 |

## 4. 本地多仓库开发布局

```
~/Work/GolandProjects/
├── go.work                 # 联调期工作区，不提交到任何仓库
├── kore/                   # 本仓库
├── kore-plugins/
├── kore-plugin-echo/
├── kore-plugin-site/
└── kore-plugin-backup/
```

`go.work`（仅联调期，**不进任何仓库**）：

```
go 1.24

use (
    ./kore
    ./kore-plugins
    ./kore-plugin-echo
)
```

依赖替换的三档，按用途选，禁止混用：

| 场景 | 方式 | 可否提交 |
| --- | --- | --- |
| 插件正常开发/发版 | `require github.com/pengtang1024/kore v0.1.0`（**tag 依赖**） | 是 |
| **同仓库嵌套 module**（kore 根 `go.mod` → `pkg/pluginapi`） | `require` + `replace github.com/pengtang1024/kore/pkg/pluginapi => ./pkg/pluginapi` | **是，必须提交**（Go 标准做法；干净克隆与 CI 都依赖它） |
| 联调未发版的内核改动 | 在 `~/Work/GolandProjects/go.work` 里 `use ./kore` | 否（工作区文件不入库） |
| 跨仓库联调（插件仓库 → 本地 kore） | `replace github.com/pengtang1024/kore => ../kore`（或 `../kore/pkg/pluginapi`） | **否，禁止提交**（只放本地 `go.work`） |

两类 `replace` 必须分开看，否则会把正常做法误判成违规：

| 类型 | 写法 | 是否提交 | 原因 |
| --- | --- | --- | --- |
| 同仓库嵌套 module | `replace github.com/pengtang1024/kore/pkg/pluginapi => ./pkg/pluginapi` | **必须提交** | 同一仓库内多 module 时，`./` 相对路径在干净克隆与 CI 上都成立；不提交反而构建不了 |
| 跨仓库联调 | `replace github.com/pengtang1024/kore => ../kore` 或绝对路径 | **禁止提交** | `../kore` 只存在于你的机器；CI 与用户 `go install` 上都解析失败 |

G-17 的 grep **只拦后者**：`git grep -nE "replace .*=> (\.\./|/)" -- '*/go.mod'` 为空；`=> ./` 不拦。

## 5. 版本兼容矩阵

| kore 版本 | 协议 | `requires_kore` 建议区间 | 语义 |
| --- | --- | --- | --- |
| `0.1.x`（M0–M2） | `kore.plugin.v1` | `">=0.1.0 <0.2.0"` | 首个可安装版本；包结构与能力白名单仍可能微调，插件需跟随 |
| `0.2.x`（M3） | `kore.plugin.v1` | `">=0.1.0 <0.3.0"` | 协议不变即向后兼容；新能力经 `protocol_minor`（hello 字段）暴露 |
| `1.0.x`（M4 起） | `kore.plugin.v1` | `">=0.1.0 <2.0.0"` | 稳定承诺：v1 协议内不做破坏性改动 |
| `2.0.x`（未排期） | `kore.plugin.v2` | `">=2.0.0 <3.0.0"` | 破坏性：新协议名 + kore 主版本递增 + ADR + 索引标记不兼容 |

判定顺序（kore 加载插件时）：`requires_kore` 可解析 → kore 版本落在区间内 → `protocol` 主版本匹配 → 才继续 hello；任一不满足回 `E_UNSUPPORTED`，不降级、不猜。

**当前内核版本 = `0.1.1`**（`Makefile` 的 `VERSION` 是唯一真源，`make build` 注入 `main.version`，`cmd/kored/main.go` 的默认值必须与它相同）。0.1.1 是首个含 [`file_write`](./PLUGIN-PROTOCOL.md) 受控写（ADR-0052 K3）的内核版本，因此：

- 声明了 `file_write` 的插件**必须**把下界抬到 `">=0.1.1 <0.2.0"`（当前仅 `kore-plugin-site`）；留在 `>=0.1.0` 等于允许装到没有受控写的内核上，装得上、跑到写文件时才 `E_INVALID`。
- 不声明 `file_write` 的插件保持 `">=0.1.0 <0.2.0"` 即可：协议仍是 `kore.plugin.v1`，exec 动作的声明与请求形状未变（SDK 侧是加法：`RootAction.FileWrite` 为 `omitempty`）。
- 自洽断言：`make version-check`（G-14）——校验 `Makefile VERSION` ↔ `cmd/kored/main.go` 默认值 ↔ 24 个插件 `requires_kore` 区间，并对 `file_write` 插件额外断言下界 ≥0.1.1；跨仓判据，独立 clone 时 SKIP。

## 6. 仓库创建清单（里程碑分区）

| 里程碑 | 仓库 | 交付物 | 明确不做 |
| --- | --- | --- | --- |
| **M0（本次）** | 仅 `kore` | 文档 + 空骨架；**不物理创建任何插件/索引仓库** | 不建 `kore-plugins`、不建 `kore-plugin-echo` |
| **M1 第一件事** | `kore-plugin-echo` + `kore-plugins` 骨架 | echo 插件可打包安装并 hello 成功；索引仓库有 `index/plugins.json` 与 `validate.sh` | 不做市场页、不做审核流程 |
| **M2** | `kore-plugin-site`、`kore-plugin-backup` | 两个真实插件独立发版；索引收录两条真实条目 | 不做插件签名强校验（M4） |
| **M4** | 市场页、`kore-plugin-sdk-rust` / `-starlark`（可选） | 静态市场页 + 非 Go SDK | 不做账号体系、不做在线安装后端 |

## 7. 发布流程

### 7.1 插件仓库（`kore-plugin-<id>`）

1. 改版本号（`info.json.version` 与 `CHANGELOG.md` 同一次提交）。
2. `make check` 绿 → `make test` → `make package`，产出 `dist/kore-plugin-<id>-<version>.tar.gz` 与同名 `.sha256`。
3. 校验包内容：`tar -tzf` 必须只含 `info.json`、`bin/<id>`、`web/**`（可选）、`signature`（M4 可选）。
4. `git tag -a v<version> -m "<id> v<version>"` 并 push tag（三端：Gitea 权威源 + GitHub / gitee 镜像，见 [ADR-0024](./DECISIONS/0024-repo-topology-and-gitea.md)）。
5. **release 必须挂两个资产**：`kore-plugin-<id>-<version>.tar.gz` 与 `kore-plugin-<id>-<version>.tar.gz.sha256`，外加 CHANGELOG 摘要；release 是索引的唯一数据源，缺 `.sha256` 的 release 不可被索引收录。
6. **CI 的 tag 触发只做构建与打包**（交叉编译 + `make dist` + 挂 release），不重跑全量门禁；门禁由发版前的本地 `make check` 保证（触发口径见 [.agents/QUALITY-GATES.md](../.agents/QUALITY-GATES.md) §6：`push main` / tag / PR / `workflow_dispatch`，Gitea 不配）。
7. 九件套随仓提交（R9）：发版 PR 不得顺手改 `CONTRIBUTING.md` / `SECURITY.md` / `.github/` —— 要改文案就改 `scripts/plugin-templates/` 再 `bash scripts/plugin-oss-sync.sh`。

### 7.2 索引仓库（`kore-plugins`）

1. `cmd/indexer` 或 PR 手工更新 `index/plugins.json`：追加/替换 `{id,version,requires_kore,protocol,sha256,url,size}`。
2. `scripts/validate.sh` 自动校验：JSON schema、字段齐全、`requires_kore` 可解析、`sha256` 与下载物一致、URL 可访问（HEAD 200）。
3. 合并即生效——**没有人审**，校验脚本就是审核；不合格直接红。
4. 撤包（yank）：条目标 `"yanked": true` 并保留历史，kore 安装时拒绝 yanked 版本；不删 release。

### 7.3 kore 仓库

1. `make docs-check` → `make build` → `make test` 全绿（M1 起生效），发版前再跑一次 `make check`（13 段，含第 13 段 25 仓九件套）。
2. `git tag -a vX.Y.Z` → release 挂 `kored` + checksums（`kored` 与 `checksums.txt` 两个资产）。
3. CI 的 tag 触发负责构建与挂载 release，`make idle` / `make budget-check` 仍需本地或里程碑门禁跑（CI 不跑，见 QUALITY-GATES §6）。
4. kore 发版**不触发**任何插件发版；插件是否兼容由 R3 的 `requires_kore` 表达。

## 8. 故障域

| 故障 | 影响 | 恢复 | 用户可见性 |
| --- | --- | --- | --- |
| 插件仓库 CI 失败 | 该插件不发版；**kore 发版完全不受影响** | 修 CI 后重打 tag | 该插件无新版本，已装版本继续运行 |
| 索引仓库不可用 | 已装插件**照常运行**；仅"发现/获取新插件"不可用 | 索引恢复或直接按 release URL 手工安装 | 插件中心列表加载失败，插件功能不受影响 |
| 索引条目错误（sha256 不匹配/区间不满足） | 安装该条插件失败 | 索引 PR 修正；已装版本不动 | 安装报 `E_INVALID` / `E_UNSUPPORTED`，kore 不崩 |
| 插件仓库被删/私有化 | 已装插件仍可运行；无法再取新版本 | 从本地包重建仓库或迁移 | 仅更新路径不可用 |
| kore 仓库 CI 失败 | kore 不发版；插件用既有 tag 继续兼容 | 修门禁后重跑 | 无新内核版本，现有部署不变 |

一句话：**仓库之间是发布物耦合，不是构建期耦合**；任何单个仓库挂掉，都不会让别人的运行实例停摆。

## 9. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 仓库边界的进程与依赖落点；本文是其"跨仓库"维度的展开 |
| [CORE.md](./CORE.md) | 内核模块规格；`pkg/pluginapi` 的协议职责见其模块表 |
| [VISION.md](./VISION.md) | 本文是"插件可装可卸可替换、第三方接入不改主壳"这一锚点的物理实现 |
| [GLOSSARY.md](./GLOSSARY.md) | 仓库/索引/协议 SDK/变更集等术语的唯一解释 |
| [DATA-MODEL.md](./DATA-MODEL.md) | `info.json` 字段、`requires_kore` 校验与索引条目 schema 的数据侧真源 |
| [OPEN-SOURCE.md](./OPEN-SOURCE.md) | 逐仓开源资产矩阵、九件套硬要求、名称与贡献者路径；本文 R9 是其跨仓库规则侧 |
| [ADR-0024](./DECISIONS/0024-repo-topology-and-gitea.md) | 仓库归属 `kore-pl`、Gitea 为唯一权威源、module 路径不变；本文 §1 / §7 的地址与推送口径据其写定 |
| [scripts/plugin-templates/](../scripts/plugin-templates/README.md) | 九件套唯一真源；同步 `bash scripts/plugin-oss-sync.sh`、跨仓校验 `bash scripts/plugin-oss-check.sh` |

> 多仓库不是"把代码拆散"，是**把耦合从目录搬到版本号**：目录耦合靠 clone 才能对齐，版本耦合靠 `requires_kore` 与 tag 就能对齐。谁把插件塞回 kore 的 `plugins/`，谁就是在恢复已被否决的旧拓扑。
