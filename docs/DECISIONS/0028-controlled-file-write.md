> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: accepted（一期，2026-11-23；一期边界与二期条件见文末「实施记录」）· 关联: 0022-root-command-shapes.md、0018-privilege-model.md、0023-zero-intrusion.md、../PLUGIN-MATURITY.md §3.5

# ADR-0028: 内核是否新增「受控文件写」原语

## 0. 问题

`ssh-guard` 的 sshd 加固无法落地：内核受控命令表（`pkg/pluginapi/rootpolicy.go`，13 条命令形状）**没有任何文件写原语**，ADR-0022 还刻意删掉了 `sed` 并否决了「插件写脚本、root 执行」。于是凡是需要往 `/etc/*` 写受控片段的能力——sshd 加固、nginx 片段、`sysctl` 调优、`limits.conf`——都做不了，只能退回「插件生成文本、用户手抄」。

本 ADR 只回答一个问题：**要不要、以及怎样，给内核加一个受控文件写原语**。不写代码、不改 `rootpolicy.go`。

## 1. 事实核查（先于设计）

### 1.1 rootpolicy 现状

- `pkg/pluginapi/rootpolicy.go` 的形状表覆盖 `systemctl` / `nft` / `iptables` / `ufw` / `useradd` 等 13 条命令，全部是「命令 + 固定参数形状」，**没有 `file.write` / `tee` / `install` 一类写入口**；`sed` 已被删除，绝对路径直通亦被封堵（ADR-0022 §31–§45）。
- 执行链（`internal/core/privilege/`）：systemd-run 临时单元 + 审计 fail-closed；审计只记命令与参数，**看不到文件内容**。
- ADR-0022 明确否决的两项：①把 `sed` 收窄（等价于重写受限编辑器）②「插件写脚本 + root 跑」（脚本内容不受形状约束，审计只记"读了个文件"；且插件写文件本身要写权限，降权后更不可行）。

### 1.2 site 的 vhost 到底怎么写？（关键事实）

**结论：site 没有走 root 通道，它直接写文件系统。**

- `kore-plugin-site/vhost.go:67-73`：`os.CreateTemp(dir, ".kore-site-*.tmp")` → 写 → `Chmod(0600)` → `os.Rename` 落到 `<dir>/<domain>.conf`；`dir` 来自配置默认 `/etc/nginx/conf.d`（`configapi.go:67`）。
- 它能写成功，是因为本机 `/etc/nginx/conf.d` 属主是当前用户（`ls -ld` → `pt pt`），即**靠文件系统权限，不是靠内核受控通道**。
- 在 root 内核 + 插件降权（ADR-0018 已落地，插件以 `kore-site` 运行）且 `/etc/nginx/conf.d` 为 `root:root 0755` 的生产形态下，**这条路径会失败**——它不是「已有另一条受控路径」的证据，而是同一缺口的另一个受害者。

**因此本 ADR 的前提成立**：当前没有任何受控的 root 文件写通道，只有「插件直接写（依赖目录可写）」或「用户手抄」。

## 2. 候选方案

### A（推荐）：新增受控文件写原语 `file.write`

**形状**（进入 `rootpolicy` 的一张新表，仍走 systemd-run + 审计 + fail-closed）：

| 参数 | 约束 |
| --- | --- |
| `path` | 绝对路径，必须命中**前缀白名单**（见 §3）；拒绝 `..`、拒绝非规范路径；父目录必须已存在且属主 root |
| `content` | ≤ 256 KiB；拒绝含 NUL；按字节写入，不做 shell 展开 |
| `mode` | 仅 `0644` / `0600` / `0640`；属主固定 `root:root` |
| 原子性 | 同目录 `O_CREAT|O_EXCL` 临时文件 → `fsync` → `rename` → `fsync(dir)`；失败不留半文件 |
| 符号链接 | 目标与父目录均 `Lstat` 校验，符号链接一律拒绝；打开用 `O_NOFOLLOW` |
| 审计 | 记 `path` / `size` / `mode` / `sha256(content)` / `sha256(previous)` / actor / 结果（见 §4） |
| 回滚 | 写前把旧文件复制到 `<install>/data/changes/backup-<sha8>`（0600），并在 `changes.jsonl` 记结构化 `purge_op: file.restore`；无旧文件则记 `file.remove` |

**安全表面变化**：从「只能跑 13 条固定命令」变成「可写白名单目录下的文本文件」。风险集中在路径白名单的宽度与内容语义（例如往 `sshd_config.d` 写 `PermitRootLogin yes` 仍是合法内容）。**内容不做语义校验**——内核不认识 sshd/nginx 语法（G-01），语义正确性由插件与用户在 UI 上确认；内核只保证「路径可控、权限可控、原子、可审计、可回滚」。

**成本**：约 2–3 人日（形状表 + 写入器 + 备份/回滚 + 审计字段 + 测试）。

**兼容**：ADR-0022 的「不引入任意写」原则被**收窄地**突破——写只发生在白名单前缀、内容有上限、可回滚；ADR-0018 降权不变（插件仍不能直接写 `/etc`，必须请求内核）；ADR-0023 要求把这类写入登记为**豁免 #3「用户批准的宿主变更」**（`<install>/data/changes.jsonl`），因此落地时需在 ADR-0023 §3.5 增补一行「内核受控文件写 = 豁免 #3 的受控实现」。

**失败模式**：路径不在白名单 → `E_DENIED_PATH`；超限 → `E_TOO_LARGE`；符号链接 → `E_SYMLINK`；目标已存在但权限异常 → `E_UNSAFE_TARGET`；磁盘满/rename 失败 → 原子回退，旧文件不变；审计失败 → **拒绝写入**（fail-closed，与提权同口径）。

### B：维持现状（生成文本 + 用户手抄）

- **安全表面**：不变（最小）。
- **成本**：0。
- **失败模式**：用户抄错 / 漏抄 / 不知道抄哪里；能力不可用（sshd 加固等永远做不了），产品承诺「22 项能力域」中的系统加固类打折。
- **兼容**：完全兼容。
- **结论**：**否决**——把内核的复杂度省下来，转嫁给用户手工，且无法审计。

### C：扩展命令白名单（加 `tee` / `install`，锁死参数形状）

- **安全表面**：`tee` 的 `path` 参数仍需白名单，否则等于任意写；`install -m` 还需约束 mode/owner；参数形状可以锁，但**没有原子替换**（`tee` 截断即写，写一半中断会留半文件）、**没有备份/回滚**、**审计看不到内容**。要补齐这些就得在 `tee` 外面再包一层——那就是方案 A，只是名字叫 `tee`。
- **成本**：1 人日（表面）→ 补原子/回滚后 ≈ A。
- **兼容**：与 ADR-0022 的「命令形状」哲学一致，但与「可回滚」目标不一致。
- **结论**：**否决**——`tee` 是半个 A，却带着「截断写」的先天缺陷；`install` 还会引入 owner/mode 的额外攻击面。

## 3. 白名单（v1 建议，先窄后宽）

只允许**片段目录**（drop-in），不允许整文件覆盖主配置：

| 前缀 | 用途 | 备注 |
| --- | --- | --- |
| `/etc/ssh/sshd_config.d/` | sshd 加固片段 | 文件名 `kore-<plugin>-*.conf`，仅 `0644` |
| `/etc/sysctl.d/` | 内核参数调优 | `kore-<plugin>-*.conf` |
| `/etc/security/limits.d/` | 资源限制 | `kore-<plugin>-*.conf` |
| `/etc/logrotate.d/` | 日志轮转 | `kore-<plugin>-*.conf` |

`/etc/nginx/conf.d/` **暂不列入**：site 已有直接写路径，是否迁移到本原语另议（迁移会改变 site 的降权模型，属独立决策）。

## 4. 审计存什么：哈希，不存全文

**存**：`path`、`size`、`mode`、`sha256(content)`、`sha256(previous)`、`actor`、`decision`、`backupPath`。

**不存全文**，理由：

1. **密钥风险**：片段里可能含口令/私钥路径/ACL token（例如 nginx `auth_basic_user_file`、TLS 配置、`ssl_certificate_key` 引用）；审计库是长期保留、可导出、可能被备份到别处——存全文等于把敏感内容复制进另一个长期存储，直接违反 G-30 的立意。
2. **体积**：256 KiB × N 次写入会撑大 state.db，且与「薄壳」预算冲突。
3. **可回滚性**：回滚靠写前备份文件（`<install>/data/changes/backup-*`；2026-11-28 起**保留源文件 mode**，创建期 0600、落盘后 Chmod 成源 mode，见 §2.1），不靠审计库；审计只需要证明「写了什么哈希、能否对账」。

需要全文时（排障/取证），由用户显式从备份目录取，不自动进审计。

## 5. 拒绝的输入清单（实现时必须逐条有测试）

1. 路径含 `..` 或非规范形式（`//`、尾部 `/`、相对路径）；
2. 路径不在白名单前缀内（含前缀相似但越界，如 `/etc/ssh/sshd_config.d/../../passwd`）；
3. 目标或任一父目录是符号链接；
4. 目标已存在但属主不是 `root`，或 mode 不在允许集；
5. 内容 > 256 KiB，或含 NUL；
6. mode 不在 `{0644,0600,0640}`；
7. 并发写同一路径（按路径加进程内锁；跨进程用 `O_EXCL` 临时名冲突即重试一次后失败）；
8. 审计写失败（fail-closed，不写文件）；
9. 插件未声明该动作的 capability（沿用方法级 capability 模型）。

## 6. 推荐

**推荐 A**：受控文件写原语，先窄白名单（sshd/sysctl/limits/logrotate 四个 drop-in 目录），只写片段、不覆盖主配置、原子替换、写前备份、审计存哈希、fail-closed。

理由：它是唯一同时满足「能落地系统加固」「可回滚」「可审计」「与降权共存」的方案；B 让能力永远缺席，C 是半个 A 且带截断写缺陷。

## 7. 复审条件

1. 需要写白名单外的路径（如 `/etc/nginx/conf.d`）→ 先改本 ADR 的白名单并说明理由，不得由实现者自行加；
2. 需要写二进制/非文本内容 → 重新评估（当前只允许文本片段）；
3. 插件要求「整文件替换」→ 退回，本原语只做 drop-in；
4. 若审计库需要支持内容级取证 → 另立 ADR（默认仍然是哈希 + 备份文件）。

## 实施记录（2026-11-23，一期 accepted）

> 状态变更依据：实现已落地并提交（`a029fae`），测试全 PASS；§2–§7 决策正文与备选对比**一字未改**，本节只登记「实现是什么」与「原文要求中一期没做到的」。凡与代码不符的原文表述，一律在本节按代码校正并标为差异，不改决策正文。

### 1. 落地内容清单

| 落点 | 内容 | 证据 |
| --- | --- | --- |
| `internal/core/filewrite/filewrite.go`（370 行） | 受控写规则原语：校验 / 备份 / 审计 fail-closed / 原子替换 | commit `a029fae`；入口 `filewrite.go:230`（`Write`） |
| `internal/core/filewrite/filewrite_test.go`（222 行） | 7 个测试：`TestWriteLegal:30`、`TestRejectPaths:77`、`TestRejectSymlink:103`、`TestRejectContentAndMode:134`、`TestAuditFailClosed:156`、`TestBackupFailureAborts:183`、`TestUnsafeExistingTarget:208` | commit `a029fae` |
| `scripts/thin-shell-check.sh:95-104` | G-01 精确豁免：仅当路径匹配 `^\./internal/core/filewrite/` 时把 `backup` 词根替换为中性占位；其它目录、其它业务词（site/monitor/cron/ssl/database/mysql/nginx/docker）强度不变 | commit `a029fae`；正反例自证见 `.agents/verify/adr-0028-phase1.md` §3 |
| `.agents/verify/adr-0028-phase1.md`（67 行） | 一期实施证据：形状、拒绝清单与测试名、G-01 自证、门禁、端到端未验证声明 | commit `a029fae` |

### 2. 逐项实现实况（读代码核对，非照抄设计表）

| 约束 | 实际实现 | 位置 |
| --- | --- | --- |
| 白名单 4 个目录 | 恰为 `/etc/ssh/sshd_config.d/`、`/etc/sysctl.d/`、`/etc/security/limits.d/`、`/etc/logrotate.d/`（`AllowedPrefixesV1`）；**不含** `/etc/nginx/conf.d/`，与 §3 一致 | `filewrite.go:37-42` |
| ≤256 KiB | `MaxContentBytes = 256 * 1024`（262144）；判据是 `len > 上限` 才拒，故恰好 262144 字节允许 | `filewrite.go:29`、`:155` |
| 禁 NUL | 逐字节扫 `b == 0`，命中返回 `E_BAD_CONTENT` | `filewrite.go:158-162` |
| mode 仅 0644 / 0600 / 0640 | 常量 `Mode0644`/`Mode0600`/`Mode0640`，`ValidateMode` 用 switch 精确匹配，其它值（0777/0755/0666）返回 `E_BAD_MODE` | `filewrite.go:31-33`、`:167-173` |
| 仅 `.conf`（拒 `.sh`） | `strings.ToLower(filepath.Ext(base)) != ".conf"` → `E_DENIED_PATH`，错误文案显式点名「.sh 可执行脚本」 | `filewrite.go:125-128` |
| 绝对路径 + Clean 幂等 | `filepath.IsAbs` 拒绝相对路径；`filepath.Clean(path) != path` 拒绝 `..`/`//`/尾部 `/`；另拒路径含 `\x00\n\r` | `filewrite.go:111-120` |
| 父链与目标禁软链接 | `checkNoSymlink` 从 `/` 逐级 `Lstat`：任一级是符号链接 → `E_SYMLINK`，父目录不存在 → `E_UNSAFE_TARGET`；目标存在时须常规文件且权限在允许集，否则 `E_UNSAFE_TARGET` | `filewrite.go:190-227` |
| 写前备份 | 目标已存在时先算 `sha256(旧文件)`，复制到 `<CopyRoot>/<plugin>/<UTC 20060102T150405Z>/<basename>`；目录 `0700`，副本以 `O_CREATE\|O_EXCL` 打开（`0600`），内容落盘后 Chmod 成**源 mode**（2026-11-28 修，见 §2.1；此前固定 0600 导致回滚丢权限）；任一失败 → `E_BACKUP_FAILED` 且原文件不动 | `filewrite.go` 备份段、`copyFile`、`§2.1` |
| 审计 fail-closed | `Auditor == nil` → `E_AUDIT_DENIED`；`Auditor` 返回错误 → `E_AUDIT_DENIED`；两者都发生在写文件之前，目标不落盘 | `filewrite.go:282-288` |
| 原子写 | 同目录 `os.CreateTemp(".kore-write-*")`（内部即 `O_CREATE\|O_EXCL`）→ `Write` → `Sync` → `Chmod` → `Close` → `Rename` → 目录 `Sync`；任一步失败删临时文件 | `filewrite.go:297-334` |
| 插件名形状 | 备份目录与审计字段共用的 `ValidatePlugin`：非空、≤32、仅小写字母/数字/`-` | `filewrite.go:176-187` |

### 2.1 回滚逐属性还原修订（2026-11-28，账本回滚 mode 修复）

> append-only 修订记录：不改 §1–§8 原文，只登记本轮对回滚链的收窄。

round51 C12 隔离验证（`.agents/verify/c12-sshdropin-vm.md` §3③）实证：写前 0644 的 sshd drop-in 按账本
`file.restore` 回滚后内容逐字节一致但 mode 变 0600。根因两半：① `copyFile` 备份固定 0600，不保留源 mode；
② `changes.go` 的 `file.restore` 用裸 `os.Rename(备份, 目标)`，把备份自身 mode 带给目标。修法复用包内
`revertWrite`/`atomicWrite` 既有语义：`copyFile` 写备份时把源 mode 带到副本（副本目录 0700，全文不扩大可见性），
回滚改走导出原语 `filewrite.Restore(target, copyPath)`——读备份属性并校验 mode 在 `{0644,0600,0640}` 允许集后，
用 `atomicWrite` 按该 mode 覆盖目标。`purge_op` 协议形状（`{kind,args:[备份,目标]}`）与账本登记语义不变，
不新增依赖。回归覆盖：备份 mode 保留（0644/0600/0640）、sshd drop-in 与 nginx vhost 0644 回滚逐字节 +
mode 一致、0600 片段保持、重复回滚幂等、被篡改的 0777 备份拒绝还原（fail-closed）。

### 3. 审计字段（实际字段名，确认不记全文）

`AuditEvent`（`filewrite.go:71-82`）的 JSON 标签共 10 个：

| 字段 | JSON 标签 | 说明 |
| --- | --- | --- |
| `Plugin` | `plugin` | 请求方插件 id |
| `Actor` | `actor` | 操作者 |
| `Path` | `path` | 规范化后的目标绝对路径 |
| `Size` | `size` | 本次写入字节数 |
| `Mode` | `mode` | 新权限（数值） |
| `SHA256` | `sha256` | 本次内容的散列 |
| `PreviousSHA256` | `previous_sha256`（omitempty） | 旧文件散列；新建时为空 |
| `CopyPath` | **`backup_path`**（omitempty） | 写前备份的落点；先前记录写的 `copy_path` 有误，已按代码改正 |
| `Decision` | `decision` | `allow` |
| `Result` | `result` | `written` |

**不记全文**：结构体无 content 字段，`Write` 只把 64 位十六进制摘要（`filewrite.go:276-281`）交给审计；测试亦只断言 `Size`/`SHA256`/`PreviousSHA256`/`CopyPath`（`filewrite_test.go:66-71`）。另有两点如实登记：① `Decision`/`Result` 目前只会是 `allow`/`written`——被拒请求在各校验点即返回，**不产生 deny 审计**；② 备份文件全文只存在于备份目录（0700），需排障时由用户显式取；其 mode 自 2026-11-28 起保留源文件权限（创建期 0600，落盘后 Chmod 成源 mode，见 §2.1；此前固定 0600 导致回滚丢权限，与 §4「只存摘要不记全文」不冲突）。

### 4. 与原文（§2–§5）的差异（一期未做到的部分，逐条如实登记）

| 原文要求 | 一期实际 | 处置 |
| --- | --- | --- |
| §2「父目录必须已存在且属主 root」、§5.4「目标已存在但属主不是 root → 拒」 | **未做属主校验**：只查存在 / 非软链 / 是目录 / 权限在允许集；`grep Uid\|Stat_t` 零命中 | 二期补齐（属主判定须收在 `internal/platform`，`internal/core` 不得直接调平台专有 API，G-16）。一期不得据此宣称「属主可控」 |
| §3 备注「文件名 `kore-<plugin>-*.conf`」 | **未强制文件名前缀**，只强制 `.conf` 扩展名 | 一期口径以代码为准；收窄文件名规则需改代码，不能只改文档 |
| §3 备注「sshd 片段仅 `0644`」 | 四个前缀统一允许 `0644/0600/0640`，不做按目录差异化 | 同上：按目录差异化 mode 属二期收紧项 |
| §2 备份落点 `<install>/data/changes/backup-<sha8>` + `changes.jsonl` | 实际为 `<CopyRoot>/<plugin>/<timestamp>/<name>`，**未写 `changes.jsonl`**；`CopyRoot` 由调用方注入（缺省报错文案提示 `<install>/data/backups`） | 与 ADR-0023 §3.5 豁免 #3 的清单账尚未接通，二期随零侵入门禁一起做 |
| §5.7「按路径加进程内锁；跨进程临时名冲突重试一次」 | **无进程内锁**；`CreateTemp` 随机名，无冲突重试分支 | 一期无调用方（未接线）故未触发；接线前必须补，列为二期门槛 |
| §5.9「插件未声明该动作的 capability」 | 不在本包，属装配 / registry 层，一期未接 | 随 root-action 接线一起做 |
| §2「属主固定 `root:root`」 | 不改属主；实际属主 = 调用进程（root-action 下即 root） | 并入首行「属主校验」同批处理 |
| §2 原子性「`O_CREAT\|O_EXCL` 临时文件」 | `os.CreateTemp` 内部即 `O_CREATE\|O_EXCL`，语义等价 | 无差异，仅记录实现方式 |

### 5. 一期边界（三条，显式写死）

1. **端到端写盘未真机验证**：本机当前用户 `pt` 非 root，四个白名单目录均 `root:root 0755` 不可写（`.agents/verify/adr-0028-phase1.md` §5 有 `writable=no` 原始输出）。
2. **尚未接线 `cmd/kored` 的 root-action 执行路径**：仓库内无该原语的任何调用方，插件目前**不能**通过它真正写文件。
3. 因此「一期 accepted」= **原语能力（校验 / 备份 / 审计 / 形状）已就绪**，**不等于插件已能下发配置**；sshd 加固一类对外能力仍然不可用。

### 6. 二期条件

- 接线 `cmd/kored` root-action 执行路径（与管理员鉴权、审计同一事务），并同批补齐 §4 的属主校验、按路径锁、capability 声明；
- 真实写盘 e2e（需 root 或白名单目录可写的环境）：写 `/etc/ssh/sshd_config.d/kore-<plugin>-test.conf` → `ls -l` 核 `0644` → 备份存在 → 重写幂等 → 删除后备份仍在；
- 与 ADR-0023 §3.5 豁免 #3 的 `changes.jsonl` 清单接通（§4 第 4 行）。

## 8. 修订记录：nginx vhost 纳入受控写（2026-11-24，ADR-0052 裁决）

> 本节是 **append-only 修订记录**，不改 §1–§7 原文（与「实施记录」同一口径：原文保留，修订单列）。

§7 复审条件 #1 已被触发：site 需要写 `/etc/nginx/conf.d/*.conf`。裁决（含 B「目录授权」被否的证据）见 [ADR-0052](./0052-nginx-vhost-controlled-write.md)；本节只登记对原文的收窄/扩展，**不代表已实现**——`filewrite` 当前仍零调用方。

| 原文 | 修订后（仅对 `/etc/nginx/conf.d/` 前缀生效） | 依据 |
| --- | --- | --- |
| §3「`/etc/nginx/conf.d/` **暂不列入**」 | **列入**，但文件名必须 `kore-<plugin>-*.conf`、mode 仅 `0644`、属主 `root:root` | ADR-0052 §3.2 / §4.1 |
| §2「内容不做语义校验——内核不认识 sshd/nginx 语法（G-01）」 | 对该前缀**不适用**：写盘前必须过**指令级 allowlist**（语法级，拒绝未知指令；不判业务语义） | ADR-0052 §3.3 |
| §5 拒绝的输入清单 | 追加：含 allowlist 外指令（`include`/`load_module`/`log_format`/`access_log`/`error_log`/`dav_*`/`*_temp_path` 等）、参数越出允许路径或上游形状、文件名不带 `kore-<plugin>-` 前缀 | ADR-0052 §3.3 |
| §6 推荐「内容不做语义校验」 | 同上：nginx 前缀例外；校验器实现放 `pkg/pluginapi`（与 `RootCommandPolicies` 同层），`internal/core/filewrite` 只做通用调用 | ADR-0052 §3.3（G-01 论证） |

**不改变的**：一期四条边界（属主校验、文件名前缀、路径锁、root-action 接线）仍按「实施记录 §4」在二期同批补齐；本修订不放宽其他三个前缀；审计仍只存哈希不存全文；回滚仍走备份 + `purge_op: file.restore`。

**接线与协议**：`file_write` 动作声明、请求体 `content` 字段、SDK tag 与 `requires_kore` 收窄见 ADR-0052 §5 卡 2 / 卡 3。
