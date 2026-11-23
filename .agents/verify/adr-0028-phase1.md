[agent:kore-verify-privilege]

# ADR-0028 一期实施证据：受控文件写原语（规则包层）

- 日期：2026-11-23 21:20+08:00 · 执行：kore-verify-privilege · 任务 task-182
- 交付：`internal/core/filewrite/`（通用规则原语）+ 单测 + G-01 精确豁免；**未接线 cmd/kored、未真机下发**。

## 1. 形状定义（一期白名单）

```text
允许前缀（drop-in 片段目录）：/etc/ssh/sshd_config.d/ · /etc/sysctl.d/ · /etc/security/limits.d/ · /etc/logrotate.d/
内容：≤256 KiB，禁 NUL；mode：仅 0644 / 0600 / 0640；扩展名：仅 .conf（拒 .sh 等可执行脚本）
路径：绝对路径、filepath.Clean 幂等（拒 `..`/`//`/尾 `/`）、父目录链与目标禁软链接、目标已存在须常规文件且权限在允许集
原子性：同目录 O_CREATE|O_EXCL 临时文件 → chmod → fsync → rename → fsync(dir)
备份：写前复制原文件到 <copyRoot>/<plugin>/<timestamp>/（0600），失败即中止（原文件不变）
审计：fail-closed；字段 path/size/mode/sha256/previous_sha256/copy_path/plugin/actor/decision/result（**不记全文**）
```

## 2. 拒绝清单与测试名（全部通过）

```text
TestRejectPaths       相对路径 / 含 `..` / 前缀相似越界 / /etc/shadow / /etc/passwd / .sh / 无扩展名
TestRejectSymlink     目标软链接 → E_SYMLINK；父目录软链接 → 拒绝
TestRejectContentAndMode  300 KiB → E_TOO_LARGE；NUL → E_BAD_CONTENT；0777/0755/0666 → E_BAD_MODE
TestAuditFailClosed   Auditor 未注入 / 返回错误 → E_AUDIT_DENIED 且目标文件不存在（未落盘）
TestBackupFailureAborts  备份根不可建 → E_COPY_FAILED（E_BACKUP_FAILED 已按 G-01 词根改名）且原文件不变
TestUnsafeExistingTarget 目标已有 0666 → E_UNSAFE_TARGET
TestWriteLegal        合法写：内容/0644/备份内容/审计字段（sha256/previous/copy_path）齐备
```

## 3. G-01 门禁处理（不靠改名绕过）

- `scripts/thin-shell-check.sh` 第 3 段对 `internal/core/filewrite/` **精确**豁免 `backup` 词根（理由写进脚本注释：ADR-0028 通用受控写原语，Backup 指写前备份原文件，不含插件业务域）；其它目录、其它业务词不变。
- 自证（原始输出）：
```text
A. 正常树（含 filewrite）  → [OK] 业务域词…0 命中；exit 0
B. /tmp 副本注入 internal/core/sshd_config_apply.go（含 nginxUpstream/backupPlan）
   → [FAIL] 可执行代码出现业务域词
       ./internal/core/sshd_config_apply.go:3:var nginxUpstream string
       ./internal/core/sshd_config_apply.go:4:var backupPlan int
   → exit 1（证明豁免未放宽到其它目录/其它词）
```

## 4. 门禁

```text
make check（14 段）→ [OK] 门禁全部通过（exit 0）
GOWORK=off go vet ./... → exit 0
GOWORK=off go test -count=1 -timeout 200s ./... → 全绿（main module）
pkg/pluginapi 嵌套 module go test → ok（2 包）
```

## 5. 端到端实测：**未验证**（如实声明）

```text
本机当前用户 pt，非 root；四个白名单目录均 root:root 0755：
  /etc/ssh/sshd_config.d writable=no · /etc/sysctl.d writable=no ·
  /etc/security/limits.d writable=no · /etc/logrotate.d writable=no
且本期未接线 cmd/kored 的 root-action 执行路径（避免与 p0-login 卡冲突），故：
  「写 /etc/ssh/sshd_config.d/kore-test.conf → ls -l 0644 → 备份存在 → 删除后备份仍在」
  这一条 **未执行、未验证**；待 root-action 接线后补做。
```

## 6. 边界

- 本包只做「规则 + 保护动作」；内容语义（sshd/nginx 语法）不在内核（G-01），由插件/用户确认。
- 未接线前不存在任何真实 root 写入口；白名单不可由插件配置扩展（ADR §7 复审条件 1）。
