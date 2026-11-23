> 状态: proposed · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [0016-resource-budget-final](./0016-resource-budget-final.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[0046-cron-wake-path](./0046-cron-wake-path.md)、[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md)

# ADR-0048: 升级后置动作（`post_upgrade`）——声明式、内核不认识业务

## 0. 问题与裁什么

`cron` 把宿主 crontab 条目写成自包含命令：「稳定路径 + `__task-run`」（`kore-plugin-cron/internal/croncore/stablepath.go`）。稳定路径解决了「新写的条目升级后自动跟随 `current`」，但**存量条目**里写的是绝对版本路径。存量迁移 `MigrateStaleBinaries` 只在**插件进程启动**时执行（`kore-plugin-cron/main.go:52`），而 `cron` 是 `lifecycle=lazy`：内核 `Manager.Start` 对 lazy 是 no-op（`internal/core/supervisor/manager.go:119-127`），升级后的重载只做登记 + `Enable`（`cmd/kored/serve_runtime.go` 的 `reloadOne` 第 5 步）。

于是出现**静默失效**：用户升级了 cron 插件、但没打开计划任务页 → crontab 继续执行旧版本目录里的二进制 → 旧代码继续跑，没有任何提示。这与本方案的资源锚点（lazy、常驻 ≤3）无关，是**升级路径缺少「升级后动作」这一环**。

本 ADR 裁：这一环用什么机制补，以及该机制为何不越 G-01 薄壳红线。

## 1. 事实核查

| 事实 | 证据 |
| --- | --- |
| 迁移只在插件启动路径触发 | `kore-plugin-cron/main.go:52-69`；`internal/croncore/stablepath.go:207-216` |
| lazy 插件的 enable 不拉起进程 | `internal/core/supervisor/manager.go:119-127`（`isLazy() → return nil`） |
| 升级的唯一重载入口是 `reloadOne` | `cmd/kored/serve_runtime.go:240-320`；`InstallRefresh: svc.reloadOne`（`serve_boot.go:84`） |
| 内核没有任何「安装后调用插件」的通用机制 | `grep post_upgrade|post_install` 零命中；协议 §7.1 只有 hello/ping/shutdown/reload |
| trigger 事件通道尚未实现 | `internal/core/registry` 只校验 `triggers` 形态，无分发实现 |
| `current` 符号链接由 installer 原子维护 | `internal/core/installer/layout.go:126-165` |

## 2. 备选方案

| 编号 | 方案 | 关键点 | 结论 |
| --- | --- | --- | --- |
| **A** | 协议层新增保留方法 `kore.post_upgrade`，内核升级后对所有插件调用 | 需先知道插件是否实现：要么唤醒所有 lazy 插件问一遍（全量冷启 + 槽位驱逐风险），要么仍要清单声明 | 否决：多一个协议保留方法，却没减少任何清单声明；唤醒全量插件违反 lazy 的省资源初衷 |
| **B** | `cron` 由 `lazy` 改 `resident` | 升级后 `Enable` 直接拉起，启动期迁移生效 | 否决：常驻槽位是全局稀缺资源（`resident_max` 默认 2，总槽位 ≤3），为一次迁移永久占用一个常驻位；与「资源零侵占」锚点冲突 |
| **C** | 清单可选字段 `post_upgrade: "<id>.<method>"`；内核升级重载后按声明调用一次 | 内核只读声明 → bus 调用；插件自己实现迁移 | **采纳** |
| **D** | 不修，只写「升级后请检查外部引用」告警 | 零内核改动，但把修复责任推给用户；对 23 个无外部引用的插件是噪声 | 作为 C 的**失败兜底**保留：动作执行失败必须写告警（不能静默），但单独用 D 不闭环 |

### 2.1 为什么是 C 而不是 A

A 与 C 的差别只在「动作以什么名字暴露」：A 用协议保留名（`kore.post_upgrade`），C 用插件自己的业务方法名。C 的优势：

1. **不扩张协议保留面**：§7.1「4 个必选方法」不变，`kore.*` 仍不可从 HTTP 业务入口调用；
2. **清单即事实**：是否支持、调用哪个动作，一条可选字段说清；老内核忽略该字段时行为与今天一致（插件启动期迁移兜底，不是新缺口）；
3. **可人工重放**：`cron.migrate` 同时是可显式调用的方法（`system:admin`），迁移失败后运维能手动重试，而保留方法没有 HTTP 入口。

## 3. 决策与 G-01 边界

**决策 C。** 内核侧新增的全部能力是：

1. 解析并校验清单的可选字段 `post_upgrade`（形态 `<id>.<action>`，域必须等于自身 id）；
2. 重载成功后把该字符串原样交给 `bus.Call`，15s 上限，失败写 WARN + 告警。

**G-01 边界说明（明确回答）**：

- 内核**不知道** cron、不知道「迁移」、不知道 crontab、不认识任何业务动词；它只认识「清单里有一个方法名，调用它」这一条不具备业务含义的规则。这与 `method_capabilities`（内核只校验形态与归属，不认识动作语义）、`root_actions`（固定 argv 由插件声明）同构。
- 反过来，如果内核写成「升级后调用 `cron.migrate`」，那就是硬编码业务 → 违反薄壳红线，本 ADR 明确**不做**。
- 「声明了却没实现」不由内审核：内核不持有插件方法清单（`methods` 数组内核不解析）。该风险由插件自带测试守护（`kore-plugin-cron/methods_test.go` 的 `TestPostUpgradeHookDeclaredAndImplemented`），失败时内核得到 `E_NOTFOUND` → 告警可见，不会静默。

## 4. 协议与版本（G-14 判断）

`post_upgrade` 是 info.json 的**新增可选字段**，有默认值（缺省不调用）：

- 按 PLUGIN-PROTOCOL §16.1「加字段必须可选且有默认值」，**不构成破坏性变更**：不升 `kore.plugin.v2`、`kore` 主版本不递增，`requires_kore` 无需收窄；
- 老内核解析 info.json 时忽略未知键（`registry.Parse` 用 `json.Unmarshal` 到结构体），装着新插件不会报错，行为退化为「首次调用时启动迁移」——比今天不差；
- `pkg/pluginapi` 无改动（不是线协议字段），插件 SDK 无破坏。

因此本 ADR 是**设计留痕**（G-23），不是 G-14 要求的破坏性协议 ADR。

## 5. 实现与验收

- 内核：`internal/core/registry/{manifest.go,validate.go}`（字段 + 形态校验）、`cmd/kored/serve_runtime.go`（`runPostUpgrade` / 告警）；
- 插件：`info.json` 声明 `post_upgrade: "cron.migrate"`；`methods.go` 新增 `cron.migrate`（与启动期迁移同一实现，幂等）；
- 断言：`cmd/kored` 的 `TestReloadOneRunsDeclaredPostUpgrade`——lazy 插件声明 `post_upgrade` 且**从未被手动调用**，`reloadOne` 后插件探针文件存在；改前该测试 FAIL（插件未被拉起）；
- 守护：`kore-plugin-cron` 的 `TestPostUpgradeHookDeclaredAndImplemented` 断言清单声明的方法真实存在且返回可解释结果；
- 副作用边界：lazy 插件被冷启一次，动作完成后按 `idle_timeout_s` 回收，不改变常驻计数与状态机（§12 第 6 步已写明）。

## 6. 风险与复审条件

1. **老内核 + 新插件**：字段被忽略，缺口退化为今天的行为（首次调用迁移），不是回归；跨大版本升级时需同时升级内核。
2. **冷启代价**：声明了 `post_upgrade` 的 lazy 插件每次升级会冷启一次；只在升级时发生，且可由插件自行控制动作轻重（cron 的迁移是读改写一次 crontab）。
3. **槽位压力**：若升级时槽位已满，`Ensure` 可能驱逐 LRU lazy 或返回 `E_RATELIMIT`；此时动作失败**可见**（WARN + 告警），安装本身仍成功。
4. 复审条件：出现第二个需要「升级后动作」的插件时，评估是否改为批量/合并调用；若将来 `triggers` 事件分发落地，可评估用 `event:` 替代本字段（届时需新 ADR）。
