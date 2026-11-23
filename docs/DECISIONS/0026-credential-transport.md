> 状态: proposed · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: proposed（待裁决）· 关联: ../PLUGIN-CONFIG.md §6.1、0018-privilege-model.md、../PLUGIN-MATURITY.md §3.5 #8、0023-zero-intrusion.md

# ADR-0026: 跨插件凭据通道（内核托管凭据库 + 按授权读取）

## 0. 判据

PLUGIN-MATURITY §3.5 #8 是 v1.0 前**仅剩的 1 条**硬缺口：`grep -rn password_env internal cmd` 零命中——插件之间无法传递凭据。`discover` 探测 MySQL/Redis 服务端版本需要 `MYSQL_PWD` / `REDISCLI_AUTH`，而密码存在 `db-mysql` / `redis` 自己的 `config.json`（0600）里；当前唯一办法是运维在启动 kored 前 `export`，重启即失效、不可审计、不可复制。

## 1. 约束（先于方案）

| 约束 | 含义 |
| --- | --- |
| ADR-0018 降权已落地 | 插件以 `kore-<id>` 运行，**读不到彼此的状态目录**；靠文件权限共享凭据不可行 |
| G-01 薄壳 | 内核不认识"MySQL / Redis"等业务名词，只做通用凭据通道 |
| G-24 显式 schema | 接口字段必须显式，禁 `object` / `any`；方法名 camelCase，正则不允许 `_` |
| ADR-0023 零侵入 | 凭据只能落 `<install>/data/` 内（G-31 合规） |
| G-29 运行态边界 | 凭据是运行态资产：不入 git、不进日志、不随包分发 |
| 审计 fail-closed | 授权与读取都要留审计；审计写失败 → 拒绝，不静默放行 |

## 2. 候选方案

### A（主线）：内核托管凭据库 + 按授权读取

**存储形态**：`<install>/data/credentials/`（0600，portable 默认在安装根内）。

- `index.json`：元数据（显式字段，无 `any`）：
  ```json
  {"credentials":[{"id":"cred-7f3a","owner":"db-mysql","name":"mysqlRoot","envVar":"MYSQL_PWD","createdAt":"2026-11-23T19:00:00+08:00","updatedAt":"..."}]}
  ```
- `<id>.secret`：原始字节（0600，0600 目录）；**不加密**。
  - **为什么不加密**：加密密钥要么放同一台机器的另一个文件（等价于 0600 的边界，只是多一步）、要么依赖 TPM/keyring（Tier A 的 RHEL8/Alpine 不保证有）。加密只制造"已加密"的错觉，不加攻击成本。若未来要 keyring，单独立 ADR。

**谁可写**：
1. **所有者插件**（`owner` = 该插件 id）：通过既有 `config.set` 写入 `sensitive:true` 字段时，内核把值镜像进凭据库（插件自身仍可读自己的 `config.json`，双写不引入新语义）；
2. `system:admin` 会话：`POST /api/v1/credentials`（显式 schema，见 §3）——用于"帮 discover 配一次、所有 db 插件复用"。

**谁可读**：
- **所有者**永远可读；
- 其他插件必须持有**显式授予**（grant）：`{credId, grantee, grantedBy, grantedAt}`，由用户在 UI 授权产生；
- 无授予 → `E_NEED_GRANT`（见 §3），**不降级、不猜测、不回退到客户端版本探测**。

**授予流程**（fail-closed）：
1. 用户在 UI 点"允许 discover 使用此凭据" → `POST /api/v1/credentials/{id}/grants`（`system:admin` + CSRF）；
2. 内核写 grant 记录 + 审计 `credential.grant`（action 名 camelCase，无下划线）；
3. **审计写失败 → 整个请求失败**（500 `E_AUDIT`），grant 不生效；
4. 撤销：`DELETE /api/v1/credentials/{id}/grants/{grantee}`，同样审计。

**接口形状**（显式字段，禁 `object`/`any`）：
```json
POST /api/v1/credentials
{"owner":"db-mysql","name":"mysqlRoot","envVar":"MYSQL_PWD","secret":"***"}
→ 201 {"id":"cred-7f3a"}

POST /api/v1/credentials/cred-7f3a/grants
{"grantee":"discover"}
→ 200 {"granted":true,"grantee":"discover","grantedAt":"..."}

GET /api/v1/credentials?owner=db-mysql
→ 200 {"credentials":[{"id":"cred-7f3a","owner":"db-mysql","name":"mysqlRoot","envVar":"MYSQL_PWD","grantedTo":["discover"]}]}
（**永不返回 secret**；`config.get` 对 sensitive 字段仍回 `"***"`）
```

**插件侧获取**（不新增插件方法，走内核特权能力）：kored 拉起插件时，**只对"该凭据已授予该插件"的条目**注入环境变量 `env[cred.envVar]`（`password_env` 语义复用）；未授予则不注入，插件读环境变量为空时返回 `E_NEED_GRANT` + hint（"请在 设置 → 凭据 中授权本插件使用 db-mysql 的 mysqlRoot"）。这样 `discover` / `db-mysql` 插件代码**零改动**（继续读 `MYSQL_PWD`）。

- **安全影响**：凭据集中后，内核成为单点——但内核本来就是 root 单点；降权后插件只能通过 socket 请求，且 grant 校验在 `SO_PEERCRED` 校验之后（插件身份不可伪造）。风险是"内核进程被攻破"，与现状同级（现状内核也能读所有插件 config.json）。
- **成本**：中（~3–5 人日）：凭据库 + 2 个端点 + grant/审计 + supervisor 注入 + UI 授权面板 + 迁移（把现有 `config.json` 的 sensitive 字段导入）。
- **G-29**：凭据在 `<install>/data/credentials/`（安装根内、0600、不入 git），属运行态资产。
- **G-31**：合规——不新增系统路径；`<install>/data` 已是 ADR-0023 的状态根。

### B：插件直接互读 `config.json`

`discover` 读 `<state_dir>/plugins/*/config.json`。

- **安全影响**：插件降权后（`kore-<id>`）**读不到别人的 0600 文件**；放宽权限（同组可读）等于取消插件间隔离，ADR-0018 的威胁模型作废。
- **成本**：低（0.5 人日）。
- **结论**：**否决**——靠文件权限共享与降权目标冲突，且任何插件都能读所有密码。

### C：每个插件各自录一份（`discover` 加"探测凭据"字段）

- **安全影响**：同一密码存 3 份（db-mysql / redis / discover），改密必然漂移；- **成本**：最低（0.5 人日）。
- **结论**：**否决**——违反"自动发现、不让人填环境细节"（USABILITY 原则 2），且密码副本扩散。

### D（可选增强）：A + 短期租约

在 A 之上给"读取"加 TTL 租约（如 5 分钟），插件按需拉取而非启动注入，减少环境变量长期驻留。

- **成本**：+2 人日；**结论**：v1.0 不做，记入 A 的后续演进（环境变量注入在 v1.0 已够，租约属加固项）。

## 3. 失败语义

| 场景 | 返回 | hint |
| --- | --- | --- |
| 插件未获授权 | `E_NEED_GRANT`（403） | "请在 设置 → 凭据 中授权 `<grantee>` 使用 `<owner>` 的 `<name>`" |
| 凭据不存在 | `E_NOTFOUND`（404） | "凭据 `<id>` 不存在；请先在所有者插件配置中保存，或由管理员创建" |
| 审计写失败 | `E_AUDIT`（500） | "审计不可用，授权未生效（fail-closed）" |
| 非 root 内核（降级形态） | `E_NEED_GRANT` 的降级变体 | "当前内核非 root，插件与内核同 uid，凭据通道不保证隔离；请以 root 运行" |
| `secret` 出现在任何响应/日志 | 视为**缺陷** | `config.get` 只回 `"***"`；审计只记 `credential.id` 与动作，不记值 |

## 4. 五个凭据插件的复用评估

| 插件 | 凭据类型 | 能否统一到 A |
| --- | --- | --- |
| `db-mysql` | root/业务用户口令（`MYSQL_PWD`） | ✅ 所有者写、discover 读 |
| `db-postgres` | 口令（`PGPASSWORD`） | ✅ 同一通道，换 `envVar` |
| `redis` | `REDISCLI_AUTH` | ✅ 同上 |
| `ssh-guard` | 读日志/防护源凭据（root-action 通道，当前不存口令） | ✅ 若将来要存，同一通道；当前无口令需求，标 N/A |
| `ssl` | ACME 账户密钥 / DNS API token（若接 ACME） | ✅ 未来接入时同一通道；当前 ACME 仅骨架 |

结论：**5 个插件可统一**；`ssh-guard` / `ssl` 当前无实际口令，先留接口位，不阻塞 v1.0。

## 5. 与 G-29 / G-31 逐条确认

- **G-29**：凭据库是运行态资产，位于 `<install>/data/credentials/`；不写入 `.kore-local*` 之外、不改主实例配置；测试用隔离 `KORE_HOME`。✅
- **G-31**：不新增系统路径、不新增系统用户；`<install>/data` 已在 ADR-0023 状态根内；豁免清单不变。✅
- **G-06**：落地时同步 PLUGIN-CONFIG §6.1（把候选表标记为"已由 ADR-0026 裁决"）与本 ADR。✅

## 6. 推荐与分期

**推荐 A**（内核托管凭据库 + 按授权读取 + 环境变量注入），v1.0 只做"存储 + grant + 注入 + 审计 + UI 授权"五件事：

1. 一期：凭据库 + `POST/GET /credentials` + grant 端点 + 审计（fail-closed）；
2. 二期：supervisor 按 grant 注入 `envVar` + 插件 `E_NEED_GRANT` 提示；
3. 三期（v1.1）：租约（D）、ACME/DNS token 接入。

**被否决**：B（与降权冲突）、C（密码副本漂移）、D 立即做（过度设计）。

## 7. 复审条件

1. 需要跨主机 / 多租户凭据 → 重新评估（可能引入外部 secret store，属新 ADR）；
2. Tier B（macOS/Windows preview）没有 `kore-<id>` 降权 → 凭据通道在该平台降级为 `E_NEED_GRANT` + 说明，不静默共享；
3. v1.0 后若插件数量增长导致 UI 授权面板过载 → 引入"凭据策略"（按插件类别批量授权），单独立 ADR。

## 8. 实现记录（2026-11-23，内核一期）

- 已落地：`internal/core/credential/`（`Set` / `Get` / `Grant` / `Revoke` / `List` / `Delete` / `EnvFor`；目录 0700、`index.json` 与 `<id>.secret` 均 0600、原子写；越权 `E_NEED_GRANT`；Grant/Revoke **先审计后生效**，审计未装配或写失败一律 `E_AUDIT` 且不改索引）；supervisor `Credentials` 选项按 owner/grantee 注入 env（未授权不注入；读取失败 fail-closed 拒绝启动）；httpapi 4 端点（全部 `system:admin`，响应无 secret）。
- 测试：`credential_test.go` 覆盖 Set/Get 往返、越权、Grant 后可见、Revoke 后失效、审计 fail-closed（错误 sink + nil sink）、0600/0700 断言、EnvFor 只对 owner/grantee 注入、List/Delete。
- **未落地（需装配层补齐）**：`cmd/kored` 尚未构造 `credential.Service` 并注入 httpapi/supervisor——本任务写域不含 `cmd/`，端点与注入能力已就绪但生产路径未接线；补线后还需把 `Auditor` 适配到 store 审计出口。
