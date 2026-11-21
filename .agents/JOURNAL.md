# .agents · 复盘日志

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

每个 Loop 收尾写一条；里程碑收尾写一条；踩到坑立刻写一条。只写能指向文件、命令或数字的事实，不写"大家辛苦了"。

## 1. 复盘模板

复制下列结构，替换尖括号内容，追加到第 2 节末尾（新的在最上面）。

```markdown
### <YYYY-MM-DD> · <里程碑> · <任务 id / 主题>

| 字段 | 内容 |
| --- | --- |
| 目标 | <原本要达成什么，与任务卡 subject 一致> |
| 结果 | <实际交付了什么；贴文件清单 / 命令 + 退出码> |
| 差距 | <验收项与预期的差；无差距写"无"，但有 N/A 必须列出> |
| 根因 | <差距是需求没想清、方案选错，还是执行偏差；给证据> |
| 沉淀 | <可复用的规律 / 判据 / 命令，一条起> |
| 下次动作 | <下一个 Loop 的第一件事，具体到文件或命令> |
```

规则：`结果` 必须有可复现证据；`根因` 不许写"沟通不足"这类无法验证的结论；`沉淀` 若产生门禁变更，同步更新 [QUALITY-GATES.md](QUALITY-GATES.md)。

## 2. 记录

### 2026-11-21 · M0 · 收口复盘（从"基线建立"到"已验收事实"）

| 字段 | 内容 |
| --- | --- |
| 目标 | M0 文档基线 + agent 协作体系 + 仓库骨架，交付物为可照做的契约与门禁，不含业务代码 |
| 结果 | 35 份文档（13 份 `docs/*.md` + 8 篇 ADR + `.agents/` 14 份，含 verifier 四份报告 `m0-consistency.md` / `m0-commit-plan.md` / `*-r2.md`）、`make docs-check` 6 pass / 0 warn / 0 fail、相对链接 0 断链、零业务代码 |
| 差距 | 首版出现四处真实偏差：①帧格式被双重定义（多出 2 字节帧头）②升级 socket 命名分叉（`.sock.new` vs `<id>.next.sock`）③口令算法 `argon2id` 破坏依赖白名单 ④ADR 编号重复 |
| 根因 | **契约先行了，但契约没做成唯一真源**——同一个口径被 5 个并行写域各自演绎一遍；任务书与 ADR 打架时执行者按任务书走，于是偏差顺着"看起来最完整的那份正文"继续传播 |
| 沉淀 | ①**ADR 是唯一准绳**：正文与 ADR 冲突以 ADR 为准，反向覆盖属于违规（已写进 [WORKFLOW.md](WORKFLOW.md) §8 第 6 条）②**数值单真源**：数据面看 `docs/DATA-MODEL.md`、协议看 `docs/PLUGIN-PROTOCOL.md`、协作看 [WORKFLOW.md](WORKFLOW.md)，其他文档只引用不复制 ③裁决必须进 [BOARD.md](BOARD.md) §5，不留在对话里 |
| 下次动作 | M1 起每个 sprint 末做一次「ADR ↔ 正文」对账：逐篇 ADR 反查引用它的正文段落，口径不一致即转提案；对账结论写进本条记录的下一条 |

### 2026-11-21 · M0 · 基线建立

| 字段 | 内容 |
| --- | --- |
| 目标 | 把 kore 的 M0 打成可执行基线：愿景与架构可读、协议与预算可照做、agent 协作有规则、仓骨架与门禁有落点；**不写业务代码** |
| 结果 | 交付 7 条轨道：A `docs/VISION.md` `docs/ARCHITECTURE.md` `docs/CORE.md` `docs/GLOSSARY.md`｜B `docs/PLUGIN-PROTOCOL.md` `docs/RESOURCE-MODEL.md` `docs/DATA-MODEL.md`｜C `docs/FRONTEND.md` `docs/SECURITY.md` + `docs/DECISIONS/` 8 篇 ADR（0001–0008，末篇为多仓库拓扑裁决）｜D `docs/ROADMAP.md` `docs/PLAN.md` `docs/MILESTONE-M0.md`｜E `AGENTS.md` `README.md` `.agents/` 体系文档与模板｜F `.gitignore` `.editorconfig` `Makefile` `scripts/`｜G 独立验收 + 首提交。代码零行，符合 M0 定义；唯一真门禁 G4 由 G 轨道独立复跑 |
| 差距 | 除 G4 外 G1/G2/G3/G5/G6/G7/G8/G9/G10 在 M0 全部记 N/A（无源码、无进程、无产物），意味着"资源预算是否真的压得住"本轮未被验证，M1 首个可运行版本必须立刻补测 G6/G8 |
| 根因 | M0 的交付物是文档与骨架，验收面天然窄；若把 N/A 当 PASS，就会产生"文档说 8 MiB 就等于做到了 8 MiB"的假闭环 |
| 沉淀 | ①**契约先行**：路径、预算数字、协议字段、错误码先写进 docs，代码只照抄，避免"边写边定"返工。②**写域不相交**：7 条轨道按文件前缀切分，同层并行不产生覆盖冲突。③**verifier 独立**：验收由不写这批文件的人原样复跑 G4 并做交叉一致性核对，实现者的自述不作为结论 |
| 下次动作 | M1 第一个可运行版本落地后立即补：G6 主壳空载 RSS 60s 中位数、G8 二进制体积、G7 薄壳边界 grep，三项结果写进下一条记录 |

### 2026-11-22 · M1 · 事故：诊断代码关闭了 GC

- **现象**：GOGC 三档消融无差异（6300 / 6372 / 6304 KiB，最大差 72 KiB），`gctrace` 全程仅 1 次 GC。
- **根因**：`cmd/kored/serve.go:82` 在日志调用里写 `debug.SetGCPercent(-1)`——Go 文档明确「负数禁用 GC」。"打印当前值"实际执行的是"关掉 GC"。
- **影响**：ADR-0015 的「默认 GOGC=50」实际从未生效；历史内存数字（6408 / 7200 / 7832 / 7820 / 8056 KiB）**全部是在 GC 关闭状态下采集的**。
- **发现方式**：独立 verifier 做 GOGC 三档消融，先观察到「三档无差异」，再用 `go doc` 核对 API 语义 + 独立探针（NumGC=0 vs 11）+ `gctrace` 三重论证坐实。
- **修复**：改为记录"自己设置的值"或走 `runtime/metrics` 读取；补回归测试——`setRuntimeLimits()` 之后分配内存必须观察到 GC 次数增长。
- **教训**：**"读取当前配置"和"修改当前配置"是两种操作**，Go 有若干 API 用负数/返回值兼任两者；凡是日志代码，一律假设它不能改状态。
- **门禁**：新增 G-21（AGENTS）/ G16（QUALITY-GATES）——`grep` 双零命中，合并前必跑。

## 3. 反模式记录

| 踩坑 | 教训 | 已加入哪条门禁 |
| --- | --- | --- |
| 多轨道并行写文档时，同一组数字（RSS 预算、socket 路径、错误码）在 5 份文件里各写一遍，任何一处改动都会留下不一致 | 数字与路径只保留一个权威出处（`docs/RESOURCE-MODEL.md` / `docs/CORE.md`），其他文档只引用不复制；修改时同一检查点内全量对齐 | G4 docs-check（链接与元信息）+ M0-G 交叉一致性核对；G6 文档同步 |
| 实现者为了让门禁"变绿"，顺手把验收命令改宽（去掉 `-timeout`、跳过失败用例、删断言），事后无人发现 | 验收命令属于任务卡，不属于实现者；命令原文固化在任务卡与 QUALITY-GATES 表里，verifier 逐字复跑，改动必须走提案 | G3 命令原文固化 + verifier 独立复跑 + G-07 证据验收 |
| 把"下游文档当前文本"当准绳：2 字节帧头、`.sock.new`、`argon2id` 三处口径各自传播一轮，越传越像"已经定了" | ADR 是唯一准绳：改协议 / 数据 / 资源口径前先查 `docs/DECISIONS/`；ADR 与正文冲突时以 ADR 为准并同步正文，不许反向覆盖；发现冲突报告 lead 等裁决 | [WORKFLOW.md](WORKFLOW.md) §8 第 6 条硬规则 + 每 sprint 末「ADR ↔ 正文」对账 |
| 同一概念在不同轨道各写一种名字：二进制/进程名曾一边写 `kore`（`Makefile` 的 `BIN ?= ./bin/kore`、`PLAN`/`ROADMAP` 的 `bin/kore`），另一边写 `kored`（`ARCHITECTURE`/`CORE`/`GLOSSARY`/`VISION` 与 `cmd/kored/`）；Loop 阶段数曾一边七阶段（地基契约），一边 8 步（`MILESTONE-M0`/`PLAN`） | **裁决（2026-11-21 lead）：二进制/进程/systemd `ExecStart` 统一为 `kored`（daemon 惯例，与 `cmd/kored/` 同源）；项目名与 Go module 保持 `kore`；systemd unit 名 `kore.service`；Kore Loop 统一七阶段（第 7 阶段=归档复盘）。** 教训不变：跨轨并行前先对齐词表（术语以 `docs/GLOSSARY.md` 为准），出现第二种写法先改回词表再写内容，不由各轨道各自发明 | G4（元信息/链接）+ G6 文档同步 + M0-G 交叉一致性核对 |
