> 状态: accepted · 归属: architect · 更新: 2026-11-24 · 里程碑: M5
> ADR 状态: accepted（implementation 裁决卡，lead 派发 «filewrite-delete-primitive»）· 日期: 2026-11-24 · 关联: [0028-controlled-file-write](./0028-controlled-file-write.md)、[0052-nginx-vhost-controlled-write](./0052-nginx-vhost-controlled-write.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[0018-privilege-model](./0018-privilege-model.md)、[0049-privilege-direct-execution](./0049-privilege-direct-execution.md)、[PLUGIN-PROTOCOL](../PLUGIN-PROTOCOL.md) §3.1.3.3

# ADR-0053: 新增受控删除原语 `file_delete`（A），不复用 `purge_op`（B）、不写空片段（C）

## 0. 问题与裁决摘要

**裁决：A —— 在 `pkg/pluginapi` 增加 `file_delete` 声明、内核新增 `filewrite.Delete` 执行原语与 `privilege.executeFileDelete` 分派，删除前强制备份、审计 fail-closed、账本 `purge_op` 恒为 `file.restore`；否决 B（复用 `purge_op` 当正常删除）与 C（写空 vhost 代替删除）。**

一句话逻辑：

- **B 不是「少加一个字段」，而是把任意路径删除器发给插件。** `PurgeOp` 只有 `kind` + `args` 两个字段，**没有类别约束**，`validatePurgePath` 只挡 `/`、相对路径与 `..`。今天的写面被 `FileWritePrefixClasses` 钉死成「`/etc/nginx/conf.d/kore-<plugin>-*.conf`」；一旦 `purge_op` 可当请求用，同一插件就能删 `/etc/shadow`、`/etc/sudoers.d/*`、别人的 vhost——这是权限放大，不是语义瑕疵。
- **B 的语义方向也是反的。** `purge_op` 描述的是「**如何撤销**这个动作」，不是「这个动作是什么」。内核在 `fileWritePurgeOp` 里**运行时生成**它（有备份→`file.restore`、新文件→`file.remove`），声明层还被 `validateFileDeleteAction` 明确拒绝静态 `purge_op`。把回滚通道当执行通道，审计里会出现「动作是删除、回滚也是删除」的自指条目，用户按账本回滚时无法判断该条到底撤销了什么。
- **C 是三个候选里唯一「能编译但语义错」的。** 协议层本来就拒空正文（`ValidateFileWriteContent`「正文不能为空」），要做得先放宽一条安全判据；即便放开，nginx 的 `include /etc/nginx/conf.d/*.conf` 仍会加载该空文件——`server` 块消失但**文件还在**，站点目录里仍留着一份可被 `nginx -T` 读到的片段，用户界面显示「站已删除」而 `ls` 说没有。**「删除」的定义是文件不存在，不是内容为空**，用写冒充删除等于把语义债留给运维。
- **A 的代价可控且已付**：协议加一个 `file_delete` 声明（与 `file_write` 对称）、内核加一个 `Delete`（复用 `lockPath` / `checkNoSymlink` / `copyFile` / `fileSHA256` / `syncDir`）、`privilege` 加一个分派分支、账本**不需要新 kind**（`file.restore` 就是删除的备份恢复机制）。旧内核遇未知字段 `file_delete` 按 `DisallowUnknownFields` 直接 `E_INVALID`——**加法协议**，插件把 `requires_kore` 收窄即可。

## 1. 事实基线（先于设计，全部可复核）

| 事实 | 证据位置 | 影响 |
| --- | --- | --- |
| `FileWrite` 声明**没有**「允许删除」字段 | `pkg/pluginapi/filewrite.go:48-57`（`prefix_class` / `mode` / `content_policy` / `max_bytes`） | 选项「在 file_write 上加 allow_delete 开关」等于给写声明加删除语义，审计无法区分两种动作；故走独立声明 |
| 空正文被协议拒绝 | `pkg/pluginapi/filewrite.go:235-237`「正文不能为空」 | C 需先放宽判据 |
| `purge_op` 是回滚语义、声明期被要求绑定写宿主动作 | `pkg/pluginapi/rootaction.go:36-38, 50-55, 188-193` | B 的方向反了 |
| `purge_op: file.restore` 的执行体是「读备份内容 + `atomicWrite(目标, 内容, 备份 mode)`」（2026-11-28 修：原为 `rename(备份, 目标)`，会把旧备份固定 0600 带给目标，见 ADR-0028 §2.1） | `cmd/kored/changes.go` file.restore 分支 → `internal/core/filewrite.Restore` | 它**就是**删除的备份恢复机制，无需新增 kind；现在是逐属性还原（内容 + mode） |
| 写面已被类别钉死（目录 + 后缀 + 归属前缀） | `pkg/pluginapi/filewrite.go:85-96`（`PluginNamePrefix`） | 删除必须复用同一套名字校验，否则横向隔离失效 |
| site 删站走 `os.Remove`、停用/启用走 `os.Rename`，均在 `/etc/nginx/conf.d/` | `kore-plugin-site/vhost.go:401`、`toggle.go:93` | 装 root 后 `kore-site` 对 conf.d 无写权限 → 三条全失败（本卡动因） |

## 2. 三个候选的逐项评估

| 维度 | A：新增 `file_delete` | B：复用 `purge_op` | C：写空 vhost |
| --- | --- | --- | --- |
| 权限面 | 与写同宽（类别目录 + `kore-<plugin>-` 前缀） | **放大到任意绝对路径**（无类别约束） | 与写同宽，但没有删除能力 |
| 语义正确性 | 「删除」= 文件不存在 | 回滚通道被当执行通道，自指审计 | 文件仍存在，nginx 仍 include |
| 审计可读性 | 新动作 `file_delete`，begin/end 带 sha256 + 备份路径 | 与写动作的 purge 条目混杂，无法区分「删了」与「撤销了」 | 账本记的是「写」，用户以为删了 |
| 协议兼容 | 加法（旧内核 `E_INVALID`），`requires_kore` 收窄 | 无需改协议 | 无需改协议 |
| 内核改动 | 1 个 `Delete` + 1 个分派分支 | 0（但语义债永久） | 0（但需放宽空正文判据） |
| 结论 | **采纳** | 否决 | 否决 |

## 3. 三个必须回答的设计问题

### 3.1 删除应该 `irreversible: true` 吗？**不应该。**

`irreversible: true` 的作用是「无法回滚 → 必须人工签 confirm 令牌」。`file_delete` 的实现**强制先备份、备份失败即中止**，账本 `purge_op` 恒为 `file.restore(备份, 原路径)`——所以它**是**可回滚的，按既有判据不该要 confirm（与 `file_write` 同口径：`NeedsConfirmFileWrite` 只看显式 `irreversible`）。

反过来说：如果允许「无备份删除 + 靠 confirm 兜底」，等于给管理员一个「确认后销毁」的口子，而备份成本几乎为零（同一份 `copyFile`）。**用机制消解不可逆性，比用流程审批消化不可逆性更可靠**——审批会点「同意」，备份不会说谎。

显式 `irreversible: true` 仍然保留通道（插件可自我收紧），此时照常核销令牌，判据不放宽。

### 3.2 删除要备份吗？**要，且不可配置。**

备份落在**与写同一棵树**：`<install>/data/backups/<plugin>/<ts>/<name>`。理由：
- 运维只学一套恢复链路（`changes.jsonl` 的 `purge_op` + 备份目录）；
- 删除的备份与写的备份同源，回滚脚本不需要按动作类型分叉；
- 备份失败 = 删除失败（`E_BACKUP_FAILED` → `E_INTERNAL`），**不存在「删了但回滚不了」的账本条目**。

### 3.3 `purge_op: file.restore` 能不能当删除的备份机制？**能，而且这正是 B 唯一有价值的部分。**

`file.restore` 的执行体是 `cmd/kored/changes.go` 调 `internal/core/filewrite.Restore`：读备份内容 + 按备份携带的原 mode `atomicWrite` 回目标（2026-11-28 前是裸 `os.Rename(备份, 目标)`，旧备份固定 0600 导致 0644 片段回滚后权限退化，见 ADR-0028 §2.1；修后是内容 + mode 的逐属性还原）。所以**删除不需要新的 purge kind**：`file_delete` 成功后账本写 `{"kind":"file.restore","args":[备份路径, 原路径]}`，用户回滚就是按账本恢复备份。

区别在于：`file.restore` 由**内核在运行时**生成并写入账本（不可由插件请求），而不是被插件当作请求语义使用——这正是 A 与 B 的分界线。

## 4. 实施边界与判据

**协议层（`pkg/pluginapi/filedelete.go`）**：`FileDelete{PrefixClass}` 只有类别一个字段（无 mode、无 content_policy——删除没有内容可谈，可调项就是被校验方的自由度）；`ValidateFileDelete` / `ValidateFileDeleteTarget`（`target` 必须逐字等于类别目录，账本才能对上真实路径）/ `FileDeletePath`（**复用** `ValidateFileWriteName`：谁能写这个文件与谁能删它必须同一套规则）。

**声明期硬拒**（`validateFileDeleteAction`）：带 `argv`、`writes_host != true`、静态 `purge_op`、与 `file_write` 同时声明——任一命中即拒绝。**静态 `purge_op` 必须拒**，否则插件可以声明一个与本次删除无关的回滚目标，账本回滚会打错对象。

**执行层（`internal/core/filewrite/delete.go`）**：`校验 → 路径锁 → 属主复核（删前）→ 备份 → 审计 fail-closed → unlink → fsync(dir)`。顺序与 `Write` 同构但方向相反；属主复核放在**删除前**（防「同名文件被替换后被我们删掉」），写则是放在写入后。

**分派层（`internal/core/privilege/filedelete.go`）**：`file_delete` → `executeFileDelete`（不走 `os/exec`，绝不退化成 `rm`）；未装配 → `E_UNSUPPORTED`；非 root → `E_NEED_ROOT`；`content` 非空 → `E_INVALID`；目标不存在 → `E_NOTFOUND`。

## 5. 幂等性判断：内核**不**静默成功

删不存在的文件 → `E_NOTFOUND`，**不返回 200**。理由：静默成功让「我删了」与「本来就没有」不可区分，`changes.jsonl` 会记一条**没发生过的删除**（审计说谎）；回滚时 `file.restore` 会 restore 一个从未被删的文件，产生更离奇的第二手错误。

**幂等属于插件层**，且 site 插件已经做了：`deleteLocked` 在清单里没有该域名时直接返回 `deleted=false`（`vhost.go:376-380`）。两层分工是刻意的——内核严格（账本只记真实发生的变更），插件按自身状态幂等（用户重复点删除不报错）。

## 6. 后果与残余风险

**后果**：
- `/etc/nginx/conf.d/` 的三个动作（建 / 删 / 启停）终于都能走内核通道；`kore-site` 保持低权。
- **停用/启用仍缺原语**：`os.Rename` 不是写也不是删。推荐组合是「停用 = 备份内容到插件自有目录 + `file_delete`；启用 = `file_write` 写回」——用已有两个原语表达，**不新增 rename 原语**，同时消灭 `.conf.disabled` 这类留在 conf.d 里的孤儿文件。该迁移属插件侧卡，不在本卡范围（本卡只交付内核原语）。
- 旧内核（无 `file_delete`）遇新插件声明直接 `E_INVALID`：协议加法，插件须收窄 `requires_kore`。

**残余风险（披露，不隐藏）**：
1. **删除不可撤销地改变了依赖该文件的进程行为**：备份能恢复文件，但「站点已经 404 了几分钟」无法回滚。这是产品层需要用户确认的地方（插件 UI 的二次确认），不是内核 confirm 令牌的职责。
2. **属主复核失败的删除会被拒**（fail-closed）：若历史上 root:root 但权限位不是 0644 的片段存在，删除会被 `E_OWNER_MISMATCH` 挡住。这是有意的（宁可挡住也不删不确定归属的文件），运维需按错误信息核对后处理。
3. **备份目录增长**：每次删除留一份副本，与写同口径，靠既有备份清理策略收敛（未在本卡引入新策略）。

## 7. 复审条件

1. 出现**第二个**需要删除的类别（`FileWritePrefixClasses` 增项）→ 复查 `PluginNamePrefix` 是否仍足够；
2. 出现「删除目录」或「批量删除」需求 → 不得在本原语上加通配/递归，另立 ADR（当前 `Delete` 显式拒绝目录）；
3. 若插件侧证明「删除 + 备份」不足以支撑停用/启用，考虑 `file_move` 原语（需单独 ADR，不得复用 `file.restore`）。
