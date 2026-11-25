# 凭据生命周期修正报告（credential-lifecycle）

> 状态: factual record · 归属: credential-lifecycle · 更新: 2026-11-25 · 工作区: /home/pt/Work/GolandProjects/kore-pl/kore
> 硬约束遵守: commit 不 push、未触发 CI、未改运行态（8787 / .kore-local.yaml / .kore-local-state）、未打印任何明文口令；隔离实例全在 kore/.tmp-lc-* 临时目录，验证后删除；未碰 must-change-fix 写域。
> 依据: 用户口径「密码只有第一次安装会变吧，更新安装是肯定不能变的这个要说明」；site 0.8.2 离线升级覆盖共享凭据文件事故（[site-082-release.md](./site-082-release.md) §7 / [admin-credential-fix.md](./admin-credential-fix.md)）。

## 一句话结论

根因是 install 的凭据判定与落点脱钩：`install.go:89` 按本次 `--config` 判哈希（`admin_password.go:255` 原 `hashPresentInConfig`），凭据文件却写到共享 `InstallRoot()/data`（`admin_password.go:325-327` 原实现），于是「无哈希的隔离 config 做升级安装」被误判为首次安装、覆盖了共享凭据文件。修法：判定加 `initialized` / 凭据文件存在双兜底，落点绑定本次实例 `state_dir`；实测两类回归全通过。

## 1. 根因证据（path:line）

| 环节 | 事故前代码 | 问题 |
| --- | --- | --- |
| 触发点 | `cmd/kored/install.go:89` `ensureInitialAdminCredential(targets.ConfigPath, stderr)` | install 每次 `--package` 都无条件调用，不区分首次/更新安装 |
| 判定 | `cmd/kored/admin_password.go:255` `if data, err := os.ReadFile(path); err == nil && hashPresentInConfig(string(data))` | 只看 `--config` 的哈希，忽略 `initialized` 与凭据文件是否已存在；site 隔离 config 无哈希 → 误判首次安装 |
| 落点 | `cmd/kored/admin_password.go:325-327`（原）`filepath.Join(coreconfig.InstallRoot(), "data", "initial-admin-credential")` | 与 `--config` / `--state-dir` 脱钩，写到共享 install 根 |
| 实测复现 | 无哈希隔离 config + `KORE_HOME=<iso>/home` + `kored install` → `CRED_CHANGED=YES`、`REPRO_NEW_FILE_AT_STATE=NO` | 判定与落点脱钩的直接证据（命令见 §4.1 同源脚本） |

## 2. 修正内容

- `cmd/kored/admin_password.go`：`ensureInitialAdminCredential(path, stateDir, stderr)` 增加 `credentialInitialized` 守门（哈希非空 / `initialized: true` / 本实例凭据文件已存在，任一为真即完全跳过：不改哈希、不写文件、不置标志、不打印）；凭据路径改 `<state_dir>/initial-admin-credential`，兼容既有 `state_dir` 自定义而文件在 `<install>/data` 的实例；`firstRunBootstrap` 委托统一入口、不再重复判定；TTY / 非 TTY 文案改为「建议改新口令」（非强制）。
- `cmd/kored/install.go`：`ensureInitialAdminCredential(targets.ConfigPath, targets.StateDir, stderr)` —— 凭据落点绑定本次 CLI 对齐的实例。
- 测试：`TestCredentialLifecycleGuard`（哈希 / initialized / 凭据文件三判据）、`TestFirstInstallWritesCredentialUnderStateDir`（首次生成 0600、哈希可校验、不泄露明文）。

## 3. 代码验证（命令 + 退出码）

```
$ cd kore
$ GOCACHE=<workspace>/kore/.tmp-lc-gocache go build ./cmd/kored/          → BUILD_EXIT=0（忽略 mod cache 只读告警）
$ 同上 go vet ./cmd/kored/                                                → VET_EXIT=0
$ go test -count=1 -timeout 200s ./cmd/kored/                             → TEST_EXIT=0（ok github.com/pengtang1024/kore/cmd/kored 9.063s）
```

关键用例：`TestCredentialLifecycleGuard`（三判据均跳过且零输出零写入）、`TestFirstInstallWritesCredentialUnderStateDir`、`TestFirstRunBootstrapNonTTYPrintsNoSecret`、`TestFirstRunBootstrapKeepsExistingHashSilent`。

## 4. 隔离实例回归（两个场景，真实 kored install）

二进制：`GOCACHE=<workspace>/kore/.tmp-lc-gocache go build -o kore/.tmp-lc-kored-fixed ./cmd/kored/` → exit 0。包：`../kore-plugin-site/dist/site-0.8.2.tar.gz`（0.8.2 有效包）。每次回归实例在 `kore/.tmp-lc-*` 临时目录，验证后 `rm -rf`。

### 4.1 场景 a：全新安装生成凭据且可用

命令（隔离实例 A，`--state-dir $A/state`，全新配置无哈希）：
```bash
$A/bin/kored install --config $A/config/config.yaml --state-dir $A/state --package ../kore-plugin-site/dist/site-0.8.2.tar.gz
python3 - <cred> <config>   # PBKDF2 校验，只输出 MATCH 布尔值，不打印明文
```

| 项 | 结果 |
| --- | --- |
| 退出码 | `A_INSTALL_EXIT=0` |
| 安装结果 | `installed site 0.8.2` |
| 凭据文件 | `A_CRED_EXISTS=YES`、`A_CRED_MODE=600`、落点 `$A/state/initial-admin-credential` |
| 配置哈希 | `A_HASH_PRESENT=1`、`A_MUST_CHANGE= must_change_password: true` |
| 凭据可用性 | `F_CRED_HASH_MATCH=YES`（程序内按配置 salt/iter 派生 PBKDF2，与凭据文件明文逐字节比对） |
| 非 TTY 输出 | `初始管理员凭据已生成`（仅路径提示，无明文） |

### 4.2 场景 b：已有哈希 + 已有凭据文件的实例执行更新安装

命令（隔离实例 B，先装一份有效 0.8.1 包（从 0.8.2 包改 version 字段重打，两者都通过 info.json 校验），再升级到 0.8.2）：
```bash
$B/bin/kored install --config $CFG --state-dir $B/state --package $B/pkg/site-0.8.1.tar.gz   # 首次安装
KORE_HOME=$B/home $B/bin/kored install --config $CFG --state-dir $B/state --package ../kore-plugin-site/dist/site-0.8.2.tar.gz   # 更新安装
```

| 项 | 结果 |
| --- | --- |
| 首次安装退出码 / 结果 | `STEP1_FRESH_EXIT=0` / `installed site 0.8.1` |
| 更新安装退出码 / 结果 | `STEP2_UPGRADE_EXIT=0` / `installed site 0.8.2` |
| 凭据文件字节 | `CRED_BYTES_UNCHANGED=YES`（sha256 前后一致） |
| 配置哈希 | `HASH_UNCHANGED=YES` |
| 配置字节 | `CONFIG_BYTES_UNCHANGED=YES` |
| must_change | `MUST_CHANGE_UNCHANGED=YES`（前后均 `must_change_password: true`） |
| 凭据仍可用 | `CREDENTIAL_STILL_VALID=YES`（PBKDF2 程序比对） |
| 更新输出 | `UPGRADE_PRINTED_CREDENTIAL=0`（更新安装一行都不打） |

### 4.3 专项回归：无哈希隔离 config 不碰共享 `data/initial-admin-credential`

```bash
KORE_HOME=$R/home $R/bin/kored install --config $R/config/config.yaml --state-dir $R/state --package ../kore-plugin-site/dist/site-0.8.2.tar.gz
```

| 项 | 结果 |
| --- | --- |
| 退出码 | `R_INSTALL_EXIT=0` |
| 共享凭据 sha256 前后 | `1b5b3287…` → `1b5b3287…`，`R_SHARED_CRED_UNCHANGED=YES` |
| 配置哈希前后 | 逐字节一致，`R_CFG_UNCHANGED=YES` |
| 是否在 state_dir 新建 | `R_NEW_CRED_AT_STATE=NO`（更新语义完全跳过；首次安装的凭据落 state_dir） |

## 5. 文档落点

- [ADR-0055 §8](../../docs/DECISIONS/0055-initial-admin-credential.md)：行为对照表 + 为什么更新安装不能变（锁死用户 / 破坏会话 / 一次性语义）+ 落点绑定实例 + 首登改密为建议可跳过 + 账号+密码方向引用 ADR-0057 草案。
- [QUICKSTART §2.1](../../QUICKSTART.md) / [RUNBOOK-INSTALL §7](../../docs/RUNBOOK-INSTALL.md)：各加一句生命周期口径（首次生成 / 更新绝不覆盖 / 建议改密 / 账号+密码方向）。

## 6. 边界 / 未做

- 未 push、未 tag、未触发 CI；未改运行态资产，未碰 8787 实例。
- 未改 must-change 闸门代码（归 must-change-fix 卡）；ADR-0055 §3.4/§5 历史表述按 append-only 保留，以 §8 为准。
- 账号名字段与凭据两行格式属 ADR-0057（draft），本卡只在文档写方向，未改实现。
