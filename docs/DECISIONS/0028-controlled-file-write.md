> 状态: proposed · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: proposed（待裁决）· 关联: 0022-root-command-shapes.md、0018-privilege-model.md、0023-zero-intrusion.md、../PLUGIN-MATURITY.md §3.5

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
3. **可回滚性**：回滚靠写前备份文件（`<install>/data/changes/backup-*`，0600），不靠审计库；审计只需要证明「写了什么哈希、能否对账」。

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

## 实施记录（2026-11-23，一期内核侧规则包）

- 落地 `internal/core/filewrite`（与 `privilege` 同层，只做规则与保护动作，不含 sshd/nginx 领域知识）：
  - `ValidatePath`：绝对路径 + `filepath.Clean` 幂等 + 白名单前缀（`AllowedPrefixesV1`：`/etc/ssh/sshd_config.d/`、`/etc/sysctl.d/`、`/etc/security/limits.d/`、`/etc/logrotate.d/`）+ 只允许 `.conf` 扩展名（`.sh` 等拒绝）。
  - `ValidateContent`：≤256 KiB、禁 NUL；`ValidateMode`：仅 `0644/0600/0640`。
  - `checkNoSymlink`：父目录链与目标均 `Lstat`，符号链接一律拒绝；目标已存在时要求常规文件且权限在允许集。
  - `Write`：写前备份原文件到 `<copyRoot>/<plugin>/<timestamp>/<name>`（0600，失败即中止）→ **审计 fail-closed**（Auditor 未注入或返回错误则不写文件）→ 同目录临时文件 `O_CREATE|O_EXCL` → chmod → fsync → rename → fsync(dir)。
  - 审计字段：`plugin/actor/path/size/mode/sha256/previous_sha256/copy_path/decision/result`，**不记全文**。
- G-01 豁免：`scripts/thin-shell-check.sh` 第 3 段对 `internal/core/filewrite/` 精确豁免 `backup` 词根（该包 Backup 指「写前备份原文件」通用动作，与 backup 插件业务域无关）；其它目录与其它业务词强度不变。
- 未接线：`cmd/kored` 的 root-action 执行路径（本期只交付规则包与测试；接线需与 root-action 管理员鉴权一起做，避免与 p0-login 卡冲突）。**本机非 root，`/etc/*` 实际下发未验证**（见 `.agents/verify/adr-0028-phase1.md`）。
