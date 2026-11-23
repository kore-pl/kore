# .agents · 交接规范（Handoff）

> 状态: active · 归属: scribe · 更新: 2026-11-23 · 里程碑: M0–M5

任何人或 AI 在本仓库中断后接手（换模型、换会话、换人、隔天回来），只读仓库文件就必须回答四问：
**要做什么、怎么干、干到哪了、为什么这么定**。这份规范定义这四问分别由哪些文件回答，以及
"什么才算落过文件"。

## 0. 当前交接快照（2026-11-23 晚 21:45）

> 本节是「今天真实状态」的增量快照，§1–§7 的规范与卡片模板不变。
> 每条附命令 / `file:line` / commit；查不到的写「未确认」，不写推测。

### A. 四问当前答案

1. **要做什么**：M5 收口前的 v1.0 Linux GA 准备——22 能力域由 24 个插件仓提供，内核保持薄壳调度。
   今天（2026-11-23）共 282 个提交（`git log --since="2026-11-23 00:00" --oneline | wc -l` → `282`），集中在
   插件能力补齐、主壳视图补齐、发版入索引、内核卸载 / CLI 三个方向。
2. **怎么干 / 事实约束**：**本机有两个 DSH 会话并行在同一 `kore` 工作树**——另一会话 agent 名 `docs-scribe`，
   拥有 `AGENTS.md` / `docs/DECISIONS/0027-*` / `docs/FRONTEND.md` 的**图表规范条款**；本侧不得再回滚那三处
   （依据 `.agents/JOURNAL.md` §「本轮复盘：2026-11-23」第 1、2 条）。图表口径已由用户裁定为
   **工程判据为准、ECharts5 首选但非硬指标**，G-32 判「是否满足 `docs/FRONTEND.md` §13 十条判据」而非「是否用 ECharts」。
3. **干到哪了**：见 B 节（发版 / 能力 / 主壳 / 内核 / 运行态 / 挂账）。
4. **为什么这么定**：
   - 插件 UI 不补分发链 —— `docs/DECISIONS/0040-plugin-ui-distribution.md`（accepted，2026-11-23 增补裁决）：
     24 仓 dist 里 `web/` 命中为 0、内核无 `/plugin-assets/` 路由、无任何加载成功证据，补链约 3–5 人日，v1.0 前不补；
     插件 UI = 主壳视图。证据 `.agents/verify/plugin-ui-delivery.md`。
   - 升级 / 备份口径 —— `docs/OPERATIONS.md`（含实测修正，21:17 写入）。
   - 发版窗口冻结 + tag 钉 sha —— `docs/RELEASE.md` §2.1（`kore-plugin-waf v0.4.1` tag 与资产不同树事故的机制化修正）。

### B. 今天的实际状态

#### B.1 发版与索引

唯一事实源：`../kore-plugins/index/plugins.json`（实测 24 条，`schema_version` + `plugins[]`，文件 mtime 21:36）；
索引仓 HEAD `80e2611`「第46把重签（waf 0.4.3 / container 0.5.2 / discover 0.3.1 / backup 0.4.2）」。

| 插件 @ 索引版本 | 插件 @ 索引版本 |
| --- | --- |
| echo 0.1.4 | site 0.4.3 |
| file 0.3.2 | ssl 0.6.0 |
| integrity 0.4.0 | cron 0.5.0 |
| ssh-guard 0.3.0 | monitor 0.3.0 |
| logs 0.5.0 | dns 0.4.0 |
| runtime-php 0.2.2 | runtime-node 0.2.4 |
| runtime-python 0.3.1 | db-mysql 0.4.1 |
| db-postgres 0.3.3 | redis 0.6.0 |
| backup 0.4.2 | firewall 0.2.6 |
| waf 0.4.3 | container 0.5.2 |
| app-deploy 0.3.0 | terminal 0.2.0 |
| process 0.3.0 | discover 0.3.1 |

#### B.2 插件能力（以各仓 `CHANGELOG.md` 为准）

| 能力 | 版本 | 证据（仓 / 行） |
| --- | --- | --- |
| `container.exec`（固定 argv、非 root 默认、超时夹取 30s、输出截断 256 KiB） | 0.5.2 | `kore-plugin-container/CHANGELOG.md:14` |
| `process.history/trend/watchdog.suggest`（60 点环形缓冲、插件内零 ticker） | 0.3.0 | `kore-plugin-process/CHANGELOG.md:12` |
| `ssh-guard.suggest`（只读 `system:read`，`dry_run` 恒 true） | 0.3.0 | `kore-plugin-ssh-guard/CHANGELOG.md:9` |
| `runtime-python` venv / pip（4 方法 + kill 后重试） | 0.3.1 | `kore-plugin-runtime-python/CHANGELOG.md:7` |
| `redis.rename` / `move` / `copy`（默认 nx 防覆盖，>8 MiB 需 confirm） | 0.6.0 | `kore-plugin-redis/CHANGELOG.md:5` |
| `ssl.https.enforce`（期望状态下发 + 审计） | 0.6.0 | `kore-plugin-ssl/CHANGELOG.md:12` |
| `waf` 规则 CRUD（nft 1.1.x 写后回读失败的三层兜底） | 0.4.3 | `kore-plugin-waf/CHANGELOG.md:7-10` |
| `logs.retention.get/set`（落 `retention.json` 0600 原子写） | 0.5.0 | `kore-plugin-logs/CHANGELOG.md:12` |
| `cron.templates`（4 模板，只读不写 crontab） | 0.5.0 | `kore-plugin-cron/CHANGELOG.md:5` |
| `integrity` 结构化变更 + `severity` | 0.4.0 | `kore-plugin-integrity/CHANGELOG.md:13` |
| `app-deploy.upload/upgrade/jobs`（逐条目穿越护栏 + 暂存后 rename） | 0.3.0 | `kore-plugin-app-deploy/CHANGELOG.md:5` |
| `firewall.enable/disable`（走 ADR-0018 root-action，argv 固定） | 0.2.6 | `kore-plugin-firewall/CHANGELOG.md:7` |
| `backup.verify`（6 项 checks，只读 `system:read`） | 0.4.2 | `kore-plugin-backup/CHANGELOG.md:5` |
| `dns` 写路径（快照 → 原子 UPDATE → 直连校验 → journal，失败回滚） | 0.4.0 | `kore-plugin-dns/CHANGELOG.md:55`（测试证据行） |

#### B.3 主壳（两个口径分开写，勿混）

| 指标 | 值 | 命令 / 出处 |
| --- | --- | --- |
| `lazyView(` 调用点数 | **15** | `grep -c "lazyView('" web/shell.js` → `15`（`/assets/` 引用去重 18 条） |
| 视图模块数（构建口径） | **21** | `make frontend` → 「首屏 6 件套 + 21 视图模块 + 9 按需子模块」 |
| `web/*.js` 文件数 | **33** | `ls web/*.js \| wc -l` → `33` |
| 首屏 gzip | **62,710 B**（预算 307,200，余量 244,490） | `make frontend` exit 0 →「首屏合计（gzip -9）: 62710 字节」 |
| i18n 增量 gzip | **2,988 B**（预算 3,072，余量 84） | 同一次 `make frontend` |
| 导航项 | **23** | `web/shell.js:66-69` 四组 id 合计（ops 5 + biz 5 + res 4 + platform 9） |

最新两个视图：应用部署 `2450e0c`（第 21 个懒加载视图）、计划任务模板驱动 `bd7e23a`。
`web/appdeploy.js` / `web/store.js` 当前**有未提交改动**（`git diff --stat`：+164 / −16），归属未确认。

#### B.4 新增内核能力

| 能力 | commit | 关键点 |
| --- | --- | --- |
| `DELETE /api/v1/plugins/{id}` 卸载 | `6142694` | 停进程 + 删 dist + 移除记录 + 审计；审计 fail-closed；幂等 200 + `already_absent`；路径穿越双层防护 |
| `kored admin-password` | `e06a2fa` | 首启登录引导，替代手跑 PBKDF2 哈希（`d26f6a3` 补 `--hash` 示例 `--config`） |
| `kored status` + 配置/状态路径统一 | `ad2d73a` | `cmd/kored/status.go:23`；CLI 与 serve 同一路径解析 + fail-closed |
| 受控文件写原语 | `a029fae` | 白名单 / 大小 / 权限 / 软链接 / 备份 / fail-closed 审计 + G-01 精确豁免（ADR-0028 一期） |

注意：`docs/DECISIONS/0028-controlled-file-write.md` 头部状态仍是 **`proposed（待裁决）`**，而实现已落 `a029fae`——
**ADR 状态与代码事实不一致**，下一轮须裁决后改状态或回退（G-06）。

#### B.5 运行态（只报告，不杀进程、不改主配置）

| 对象 | 事实（21:44 读取） |
| --- | --- |
| 主实例 pid | `2798902`（`./bin/kored serve --config .kore-local.yaml`，启动 21:41:57） |
| 主实例 `/proc/<pid>/exe` | 指向 `bin/kored (deleted)`，sha256 `984510ab1f4e…`（inode 已不被路径指向） |
| 当前 `bin/kored` | sha256 `f26bbf35dcbf…`，10,240,162 B，mtime **21:42**（晚于主实例启动） |
| `/api/v1/system/info` | 返回 `E_UNAUTHORIZED`（管理 API 需鉴权），**故主实例实际加载版本未确认** |
| 并发隔离实例 | pid `2520580`（`/tmp/kore-t196`）、`2548624`（`/tmp/kore-cexec`）、`2779969`（`/tmp/kore-wafe2e`），均为已删除 inode；**只报告不清理** |

结论：**主实例跑的是旧 inode，`bin/kored` 已被重建**；换人接手第一件事不是改代码，是确认要不要重启主实例（G-29）。

#### B.6 已知挂账（今天仍未闭环）

1. **插件 UI 分发链未实现**，ADR-0040 裁决 v1.0 前不补；`web/app.js` 的 `frame.src` 指向不存在路径。
2. `kored install --scenario` **只解析不落库**：`cmd/kored/install.go:63-66` 直接返回 `E_UNSUPPORTED`；
   **但 `--package` 会落库**（`install.go:90` 打开 state 后原子安装）
3. **手工解包到 `state/plugins/` 不等于安装**：serve 跳过未登记目录（registry 只认 state 记录）。
4. `size_bytes` 自指：索引记**实测值**；diff 在 −29…+32 呈稀疏混沌，不批量改 23 仓（JOURNAL §4）。
5. `waf 0.4.3` 真机 e2e 待验（0.4.2 的 nft 1.1.x 写后回读 100% 失败已修，但 0.4.3 尚无整链真机证据）。
6. Gitee release 只保留最新 5 个（GitHub 全量）；超出用 `scripts/gitee-release-prune.sh` 先 `--dry-run`。
7. `web/.cache/` **未被 `.gitignore` 覆盖**：`grep -n "cache" .gitignore` 零命中，而目录存在（`ls -d web/.cache` 命中）。
8. **ADR-0028 状态 `proposed` 与实现 `a029fae` 不一致**（见 B.4）。
9. **工作区脏**：`web/appdeploy.js`、`web/store.js` 未提交；另有一批未跟踪证据文件与截图（`.agents/verify/`），
   归属须先确认（并发会话 `docs-scribe` 可能持有），**不得清空或覆盖**。

### C. 下一轮建议（≤5 条，按优先级）

| # | 动作 | 为什么 | 验收 |
| --- | --- | --- | --- |
| 1 | 重启主实例，使 `bin/kored`（`f26bbf35…`）生效并复核 `/api/v1/system/info` 的 `paths.index_dir` 与商店版本 | 主实例跑已删除 inode，今天重建过多次；不重启则验收结论对不上代码 | `system/info` 可读 + `paths.index_dir == kore-plugins/index` + 商店版本 == 索引 24 条 |
| 2 | 先确认 `web/appdeploy.js` / `web/store.js` 未提交改动的归属，再决定提交或保留 | 并发会话共享工作树，误提交会覆盖他人未完成改动（G-12 / JOURNAL §1） | `git status --short` 只剩本轮该留文件；提交首行带 `[agent:<name>]` |
| 3 | 裁决 ADR-0028（accepted 或回退 `a029fae`），并同步 `docs/DECISIONS/0028-*` 状态 | 实现已落而裁决仍 `proposed`，是 G-06 文档/代码不一致 | ADR 头部状态与代码事实一致，`make docs-check` exit 0 |
| 4 | `waf 0.4.3` 真机 e2e（规则 CRUD → nft 回读 → 回滚）留证据 | 0.4.2 的写后回读失败是已发版功能 100% 失败，0.4.3 只有代码级修复证据 | `.agents/verify/` 新报告含命令 + 退出码 + nft 规则回读 |
| 5 | 补 `web/.cache/` 到 `.gitignore`（一行），并清理 3 个 `/tmp` 隔离实例 | 构建缓存目录裸露会污染 `git status`；隔离实例是今天测试残留 | `git status` 无 `.cache`；`ps` 只剩主实例 |

### D. 本轮「未确认」清单

- 主实例实际加载的 `kored` 版本 / API 行为：`/api/v1/system/info` 返回 `E_UNAUTHORIZED`，未取到。
- `web/appdeploy.js` / `web/store.js` 改动的作者与会话归属：`git diff` 可见内容，但无法归因到 agent（身份统一）。
- 各插件 `CHANGELOG.md` 条目的发布日期与 tag 对应关系：本轮只核了版本与条目，未逐仓 `git rev-parse` 对齐 tag。
- `docs/FRONTEND.md` §13 十条判据的最新表述：属 `docs-scribe` 写域，本侧未改、未复核原文。

## 1. 总原则：文件之外无事实

一句话：**会话里说过、但没落进仓库文件的结论，视为不存在。**

- 聊天记录不可检索、不可复现、不会随仓库分发，不能作为任务依据。
- 任何判断、进度、验收结论只要影响后续动作，都必须在同一检查点内写进对应文件（G-23 判断留痕）。
- 文件之间出现矛盾时，以本规范 §2 指定的"唯一事实源"为准，其余文件必须当轮改正，不许两套并行。
- 交接不是"写一段总结给下一个人"，而是"让下一个只读文件的人不需要你再解释"。

## 2. 四问与回答它们的文件

| 问题 | 唯一事实源 | 辅助文件 |
| --- | --- | --- |
| 要做什么、凭什么叫完成 | [BOARD.md](BOARD.md)（任务行的 `subject` / `scope` / `status` / `blocked_by` / `evidence` / `revision`；跨仓库登记在「变更集登记区」） | `docs/` 对应领域文档与 ADR |
| 怎么干（流程、门禁、角色） | [WORKFLOW.md](WORKFLOW.md)（Kore Loop 七阶段与阶段收口）· [QUALITY-GATES.md](QUALITY-GATES.md)（G1–G19 / G-28–G-30 的命令与执行者）· [ROLES.md](ROLES.md)（6 个角色、写域、不可兼任） | 根 [AGENTS.md](../AGENTS.md) 的硬门禁表 |
| 干到哪了（进展与证据） | [BOARD.md](BOARD.md) 的任务状态 + [LOG/DISPATCH.md](LOG/DISPATCH.md)（派发与回填）+ [verify/](verify/)（验收报告与截图） | [JOURNAL.md](JOURNAL.md) 的里程碑记录；`LOG/sessions/` 的会话摘要 |
| 为什么这么定 | [LOG/DECISIONS.md](LOG/DECISIONS.md)（多选一决策，**含被否决的选项与依据**） | [JOURNAL.md](JOURNAL.md) 复盘；`docs/DECISIONS/` 的 ADR 原文 |

补充映射：

- **流程如何落地**：[LOG/README.md](LOG/README.md) 解释 DECISIONS / DISPATCH / sessions 三者分工。
  "状态看 BOARD、判断看 DECISIONS、派发看 DISPATCH、教训看 JOURNAL"——四者不互相替代。
- **产物长什么样**：[templates/](templates/) 提供任务卡、验收报告、评审单骨架；新写文件先套模板。
- **不可逆选择**：架构 / 协议 / 预算 / 范围类决定必须进 `docs/DECISIONS/` 的 ADR，
  并在 [LOG/DECISIONS.md](LOG/DECISIONS.md) 记一行索引与被否方案。

## 3. 硬约束

以下每条都以"第三方只读文件能否复现"为判据，违反即交接失败。

1. **判断必须落文件**：多选一决定（架构 / 协议 / 预算 / 范围 / 门禁）写进
   [LOG/DECISIONS.md](LOG/DECISIONS.md)，写清被否决选项及否决依据；只写在会话里不算数。
2. **完成判定必须可复现**：声称"完成"必须给出 `命令原文 + 退出码 + 关键输出`（G-07）。
   没有输出的"应该没问题"不成立；接口 200、DOM 断言、设计稿都不能替代规定证据（G-28 对 UI 要求双端截图）。
3. **证据冻结**：[verify/](verify/) 下的报告与截图是历史证据，不改写、不删减；
   发现错误只能新增报告并注明"取代某份"，旧文件保持原样。明文凭据一律 `***`（G-30）。
4. **未证明必须单列**：证据报告必须有"已证明 / 未证明"两栏，未验证项不得写成已通过。
   单测覆盖不等于真机验证，前者只能写在"已证明"的对应粒度里。
5. **写域不重叠**：同一层并行任务的 `scope` 不得相交（G-08）；不改别人写域内的文件，
   确需扩大写域先回到拆解阶段重画，不在执行中偷偷扩。
6. **运行态资产不手改**：`.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、运行中的 `bin/kored`
   属运行态（G-29）。测试要不同配置 / 索引 / 状态，必须起隔离实例（独立 `--config`，state / run / log 落 `/tmp`）。
7. **跨仓库要登记变更集**：一次改动跨多个仓库，必须在 [BOARD.md](BOARD.md) 登记 `CS-<YYYYMMDD>-<序号>`，
   写清各仓库 commit / tag 与合并顺序（G-15），否则不算完成。
8. **交接必须自包含**：交接卡片（§4）里的"下一步"是可直接执行的动作（命令或明确的文件改动），
   不是"继续优化"这类无法验收的描述。

## 4. 交接卡片（模板）

每笔任务在 [BOARD.md](BOARD.md) 行内或任务卡里附一张卡片，六格缺一不可：

| 字段 | 填写要求 |
| --- | --- |
| 目标 | 一句话、动词开头，与 BOARD `subject` 逐字一致 |
| 写域 | 允许改动的文件 / 目录前缀，逗号分隔；跨仓库写仓库名 |
| 验收命令 | 可复制执行，注明期望退出码与关键输出特征 |
| 当前状态 | BOARD `id` + `status` + `revision`；最后一笔 commit 短 sha |
| 下一步 | 单条动作（一条命令或一处文件改动），做完即可进入下一状态 |
| 已知坑 | 失败过的尝试、不得重试的路径、外部依赖（如 root / systemd / 索引重签） |

卡片示例（只写事实，不写鼓励语）：

```text
目标: 修复 CORE §2.13 提权 argv 与代码不一致
写域: docs/CORE.md, internal/core/privilege/, .agents/verify/
验收: make check（期望 exit 0）; go test -timeout 200s ./internal/core/privilege/（期望 ok）
状态: M5-PRIV status=completed revision=3 · commit=eb08d41
下一步: 无；若发现 PLUGIN-PROTOCOL 漂移，同笔补文档并重跑 make docs-check
已知坑: sandbox 内 sudo 被 NoNewPrivs 拒绝，真 root 验证须在 systemd user unit 内执行
```

## 5. 接手后的动作清单

按顺序做，不要跳步：

1. 读 [../AGENTS.md](../AGENTS.md) 的"读前必知"与硬门禁表，建立红线概念。
2. 读 `docs/VISION.md` 与 `docs/ARCHITECTURE.md`，确认做什么、不做什么。
3. 读 [WORKFLOW.md](WORKFLOW.md)、[QUALITY-GATES.md](QUALITY-GATES.md)、[ROLES.md](ROLES.md)。
4. 打开 [BOARD.md](BOARD.md)，只看当前里程碑的 `in_progress` / `blocked` 行；`completed` 行只在需要追溯时看。
5. 读 [LOG/DISPATCH.md](LOG/DISPATCH.md) 最近若干行，确认最后派发与回填；读 `LOG/sessions/` 最近一份会话摘要。
6. 跑 `git log --oneline -10` 与 `git status --short`，核对 BOARD 最后一笔 commit 是否在历史里、
   工作区是否有他人未提交改动（有则先弄清归属，不覆盖）。
7. 跑 `make check` 建立基线；源码就绪后加跑 `make vet` 与 `make test`。
8. 确认没有"改到一半"的痕迹：临时 worktree / 分支（`make wt-check`）、被改动的运行态配置、
   半成品证据文件。发现即先记录再处理，不静默清理。

## 6. 交付前自检

交接或声明完成之前逐项核对：

- [ ] 任务行 `status` / `revision` / `evidence` 已回填，`evidence` 含命令、退出码、关键输出。
- [ ] 影响后续动作的判断已进 [LOG/DECISIONS.md](LOG/DECISIONS.md)（含被否决选项）。
- [ ] 派发与回填已进 [LOG/DISPATCH.md](LOG/DISPATCH.md) 同一行，未另开重复行。
- [ ] 证据文件在 [verify/](verify/) 且链接可达（`make docs-check` 会校验相对链接）。
- [ ] 未证明项已单列，未被写成已通过。
- [ ] 运行态资产未被顺手改动；临时实例与临时文件已清理。
- [ ] 文档与代码一致（路径 / 协议 / 预算数字 / 角色名，G-06），无"文档说 A、代码做 B"。
- [ ] 工作区只剩本轮该留的改动；他人未提交改动、旧轮证据与截图原样保留并说明原因。

## 7. 反模式

| 反模式 | 后果 | 正确做法 |
| --- | --- | --- |
| 结论只留在会话里 | 换会话即失忆，同一问题反复讨论 | 当轮写进 DECISIONS / BOARD / 证据文件 |
| 用"应该没问题"代替命令输出 | 完成判定不可复现，回归无人知晓 | 贴命令 + 退出码 + 关键输出 |
| 证据报告只写成功路径 | 未验证项被误当已通过 | "已证明 / 未证明"两栏并列 |
| 直接改主实例配置做测试 | 主实例读到旧数据，线上行为漂移 | 起隔离实例，主配置不动 |
| 跨写域顺手改别人文件 | 与并行任务冲突，回滚代价高 | 回到拆解阶段重画 `scope` |
| 改动攒到最后一起提交 | 中途失败无法回退到自洽点 | 一处自洽即提交 |
| 交接只写"已完成 80%" | 下一个人不知道剩下 20% 是什么 | 写清下一步的单条可执行动作 |

本规范不新增 G 编号门禁：它约束的是"记录与交接"的写法，执行判据仍以上表引用的
[QUALITY-GATES.md](QUALITY-GATES.md) 与根 [AGENTS.md](../AGENTS.md) 为准。
