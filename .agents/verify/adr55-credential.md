# ADR-0055 实现报告：安装期一次性管理员凭据交付 + 首登强制改密（T1+T2）

> 角色：implementer（credential-fix） · 日期：2026-11-25 · 工作区：/home/pt/Work/GolandProjects/kore-pl
> 依据：kore/.agents/verify/permission-design-fix.md 的 ADR-0055 草案 §裁决/设计要点。
> 硬约束遵守：**未 push、未触发 CI、未打印任何真实口令值**；测试全在 t.TempDir()/临时实例，未碰 8787 主实例与运行态资产（.kore-local.yaml/.kore-local-state/）。口令在报告中一律不出现，仅记路径与事件元数据（G-30）。

## 一句话结论

ADR-0055 T1+T2 已实现：统一入口 ensureInitialAdminCredential 被 install --package 与 serve bootstrap 共用，生成/落盘复用既有函数并原子写 must_change_password=true；双通道交付（0600 凭据文件 + TTY 打印一次 / 非 TTY 只给路径）；must_change 中间闸门 + 改密成功闭环；SIGHUP 同步新哈希与标志并吊销会话；受影响包 go vet/go test、make secret-check、make docs-check 全绿。

## 改动清单（精确写域）

| 文件 | 改动 |
| --- | --- |
| cmd/kored/admin_password.go | 新增统一入口 ensureInitialAdminCredential（原 firstRunBootstrap 保留薄封装委托给 serve）；生成链路 generateAdminPassword(24) → auth.HashPassword → writeAdminBootstrapHash（原子 0600，同一次写落 auth.must_change_password=true）；一次性凭据文件 <install>/data/initial-admin-credential（0600，消费后删）；TTY 打印一次明文+路径，非 TTY 只打印路径；CLI 重置置 must_change=true；writeAdminCredentialHash 供在线改密清标志；passwordWriterFor 注入凭据消费钩子 |
| cmd/kored/install.go | runPackageInstall 在 resolveCLITargets 之后、store.Open 之前调用 ensureInitialAdminCredential（只写 config+data，规避 state.db 锁冲突） |
| cmd/kored/serve_signals.go | SIGHUP 处理增加 applyAuthCredential：从新快照同步 hash+must_change 到 auth.Manager，仅变化时 RevokeAll（无变化不踢会话） |
| internal/core/auth/session.go | Manager 增 mustChange 状态字段（与 hash 同锁）；MustChange/SetMustChange/ApplyCredentialSnapshot（原子应用并返回是否变化） |
| internal/core/config/{types.go,parse.go,reload.go} | 新增 auth.must_change_password 布尔字段 + YAML 解析 + SIGHUP 热更白名单；hash 变更 WARN 文案改为「SIGHUP 同步并吊销旧会话，无需重启」 |
| internal/core/httpapi/middleware.go | withAuth 会话分支挂 mustChangeBlocked 闸门；statusFor 加 E_NO_SELF_RESTART→501（应 restart owner 请求） |
| internal/core/httpapi/handlers_password.go | mustChangeBlocked（白名单：改密端点/登出；其余 /api/v1/* → 403 白话「首次登录请先设置新口令」）；改密成功 ApplyCredentialSnapshot(hash,false) + 删凭据文件 + 写 auth.password_initial_changed 审计（只记元数据） |
| cmd/kored/admin_password_test.go / internal/core/config/reload_test.go / internal/core/httpapi/handlers_password_test.go / internal/core/auth/auth_test.go | 新口径测试：非 TTY 也生成凭据文件且不打印明文、文件 0600、消费后删除；TTY 打印一次；已有哈希静默；must_change 闸门 403 / 改密可用 / 标志清 / 旧会话失效；ApplyCredentialSnapshot 变化检测；SIGHUP 后新口令可登录旧口令失效 |
| .gitignore | /data/initial-admin-credential（运行态明文凭据禁止入库，G-30） |

## 关键设计取舍

- **不碰 serve.go**：保留 firstRunBootstrap 名字作薄封装，内部委托 ensureInitialAdminCredential，满足「两处共用同一函数」且不越界改 serve.go（lead 批准）。
- **已有哈希静默**：按原始 YAML 文本粗判 admin_password_hash 非空即返回，不动文件、不打印（ADR-0043 升级行为保持）。
- **must_change 非 RBAC**：单管理员一次性状态机，无用户列表/角色/权限组（G-11）。API token / 插件 bearer 在 withAuth 前序分支已处理，不走本闸门。
- **fail-secure 顺序**：改密仍先吊销会话 → 持久化 → 切内存；标志与哈希在同一次原子写与同锁切换，不存在「新口令生效但标志未清」窗口。
- **SIGHUP 幂等**：ApplyCredentialSnapshot 仅在字段真变化时返回 true 才吊销会话；普通热更不误踢全员。

## 验收证据（命令 + 退出码 + 关键输出）

说明：本机 $HOME/.cache/go-build 与 $HOME/go/pkg/mod 只读，验证使用工作区内临时缓存 GOCACHE/GOMODCACHE=<工作区>/.tmp-cred-{gocache,gomodcache}，验证后即删；未改主实例运行态。

### 1) 编译 / 静态检查
\`\`\`
$ GOWORK=off GOCACHE=... GOMODCACHE=... go build ./cmd/kored/... ./internal/core/auth/... ./internal/core/config/... ./internal/core/httpapi/...
BUILD_EXIT=0
$ 同上 go vet ...
VET_EXIT=0
\`\`\`

### 2) 受影响包测试（覆盖凭据文件/403/改密/SIGHUP 全部新用例）
\`\`\`
$ GOWORK=off ... go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/auth/... ./internal/core/config/... ./internal/core/httpapi/...
ok  github.com/pengtang1024/kore/cmd/kored        9.062s
ok  github.com/pengtang1024/kore/internal/core/auth    1.151s
ok  github.com/pengtang1024/kore/internal/core/config  0.005s
ok  github.com/pengtang1024/kore/internal/core/httpapi 4.294s
TEST_EXIT=0
\`\`\`
关键用例：TestFirstRunBootstrapNonTTYPrintsNoSecret（非 TTY 无明文、文件 0600、消费后删除）、TestFirstRunBootstrapGeneratesOneTimeCredential（TTY 明文一次+路径+必须改密标志）、TestMustChangeGateBlocksNonPasswordEndpoints（403 白话/改密可用/标志清/旧会话失效）、TestApplyCredentialSnapshot（SIGHUP 同步内核：新口令生效旧口令失效、无变化不报变化）、TestMustChangeGateViaAuthManager、TestFirstRunBootstrapWriteFailureKeepsSecretOut。

### 3) 门禁
\`\`\`
$ bash scripts/secret-check.sh
SECRET_EXIT=0
$ bash scripts/docs-check.sh
DOCS_EXIT=0；docs-check: 5 pass, 1 warn, 0 fail（唯一 WARN 是存量 docs/SECURITY.md 行数越界，不阻断）
\`\`\`

### 4) G-30 卫生
\`\`\`
$ git check-ignore -v data/initial-admin-credential
.gitignore:68:/data/initial-admin-credential data/initial-admin-credential
$ ls data/initial-admin-credential
NO_RUNTIME_CREDENTIAL_IN_WORKSPACE（工作区无凭据文件残留；测试均用 t.TempDir 注入路径）
\`\`\`

## 已知边界 / 后续

- 未改 docs/ 与 web/：ADR-0055 草案 §对既有 ADR 修订列的下游文档同步（QUICKSTART/RUNBOOK-INSTALL/USABILITY 与 ADR-0043 修订）属 scribe/文档任务，不在本卡写域；代码行为已按新口径实现。
- 隔离实例全链路 SIGHUP（真实进程信号）以 ApplyCredentialSnapshot 单测 + serve_signals.go 调用点覆盖；真实 systemd 实例信号注入属运行态，按 G-29 未碰主实例。
