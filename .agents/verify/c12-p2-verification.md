# C12 P2 独立验收报告（G-09 / verifier c12-p2-verifier）

> 2026-11-28 · 独立 verifier（非 c12-p2 实现者）· 只读复核，未改代码、未启主流程 CLI、未联网、未碰宿主 `/etc/ssh`、未碰 `.kore-local-*`。
> 复核对象三仓精确 commit：
> - `kore` = `6142f059675fbdb7e102db28486a1178eb765912`
> - `kore-plugin-ssh-guard` = `604321ddbc81e2627817fb9adb84c88b384034af`
> - `kore-plugins` = `6f64259d75e4795e6a3d2f4a75a8e51add782ef0`
>
> 唯一写域 = 本报告；落盘后精确 `git add` + `git commit -s`（签名 `[agent:c12-p2-verifier]`），不 push / 不 tag / 不建 Release。

## 总评：**PASS**

**跨层一致性判定：PASS（一致，无 fail-closed 断链）。** worker 新增的 `sshd-dropin-delete file_delete` root_action 与 P1（4aafdfe / pluginapi v0.4.0）协议层**逐层坐实**：协议有 `sshd.config.d` 类目、执行面能真实受控删除并登记 `file.restore`、声明字段与类目逐字段匹配、`TestRootActionsDeclared` 双向一致。方案原文（DESIGN-SSH-DROPIN §5 step4）只提 `file_write`、实现多出 `file_delete`，经核查属**文档范围扩展而非跨层不一致**：新增动作已被 CORE.md / DATA-MODEL.md / SECURITY.md / CHANGELOG 0.5.0 同步登记，且协议/执行面完全支撑，故不判 BLOCKED（详见 §1.4）。

---

## 0. 三仓 commit / DCO / 未推送 / 工作区状态（§⑤）

| 仓库 | HEAD | DCO Signed-off-by | 分支/upstream | 远端含 HEAD | tag@HEAD | worktree |
| --- | --- | --- | --- | --- | --- | --- |
| kore | `6142f05` | `pengtang1024 <pengtang1024@qq.com>` ✓ | main…origin/main [领先 9] | 无 | 无 | 1（仅主） |
| kore-plugin-ssh-guard | `604321d` | 同上 ✓ | develop（无 upstream） | 无 | 无 | 1 |
| kore-plugins | `6f64259` | 同上 ✓ | main…origin/main [领先 1] | 无 | 无 | 1 |

- 三 commit author 均 `pengtang1024@qq.com`，`git log -1 --format='%b'` 均含 `Signed-off-by`，DCO 合规；首行均带 `[agent:c12-p2]`。
- `git branch -r --contains HEAD` 三仓均空 → **未 push**；`git tag --points-at HEAD` 三仓均空 → **未打 tag**、无 Release。
- 他人 dirty 原样保留，未触碰：kore 的 `M scripts/usability-pending.txt` + 多个 `??`（含 `.agents/.agents/`、`e2e-*.md`、`.gocache-kore-014/015/`、`data/`、`dist/`）；ssh-guard 的 `?? zeroparam_test.go`；kore-plugins 的 `?? .tmp-validate-out.txt`、`?? dist/`。本 verifier 只新增本报告一个文件。
- 本机 8787 主实例仍在监听，未重启、未改运行态配置；隔离实例端口 55201 无监听、无残留 kored/playwright 进程。

## 1. 跨层一致性（核心 §①）

### 1.1 file_delete 协议类目存在，不会 fail-closed 拒掉
- `kore/pkg/pluginapi/filewrite.go:89-112`：`FileWritePrefixClasses` 唯一真源含 **`sshd.config.d`**（`Dir=/etc/ssh/sshd_config.d/`、`Suffix=.conf`、`Mode=0644`、`ContentPolicy=sshd.dropin.v1`、`MaxBytes=256KiB`、`Owner=root:root`、`PluginNamePrefix=true`）。
- `kore/pkg/pluginapi/filedelete.go:37`：`ValidateFileDelete` 用 `FileWritePrefixClasses[decl.PrefixClass]` 判类目；`sshd.config.d` 在表内 → 声明校验通过。`FileDeletePath`（:67-82）复用 `ValidateFileWriteName`，保证"谁能写谁才能删"同源、`kore-ssh-guard-*.conf` 归属校验。
- `validateFileDeleteAction`（:94-113）：禁止 argv、必须 `writes_host=true`、禁止静态 `purge_op`、target 必须逐字等于类别目录——插件声明 `writes_host=true` + `target=/etc/ssh/sshd_config.d/` + 无 purge_op，**全部满足**。
- 版本坐实：`pluginapi v0.4.0` tag = `4aafdfe`（P1 本身），`git show pkg/pluginapi/v0.4.0:pkg/pluginapi/filewrite.go` 含 `sshd.config.d`、`filedelete.go` 存在；`git merge-base --is-ancestor 4aafdfe pkg/pluginapi/v0.4.0` → YES。插件 `go.mod` require 的正是 v0.4.0。离线重建该 tag 的 module zip 得到 `h1:1M02oDq4jwKO/XojtHhj5/3jKFJupAZdDO7ix7EFZkg=`，与 `go.sum` 逐字一致 → 依赖解析到的就是含 sshd 类目的真源码。

### 1.2 rollback 的"内核 file_delete 受控删除 + file.restore 账本"真能工作
- `kore/internal/core/privilege/filedelete.go:79-124`：`executeFileDelete` → `filewrite.DeleteDeclared` → 属主复核 → 强制备份 → 审计 fail-closed → unlink → fsync，成功后账本 `PurgeOp{Kind:file.restore, Args:[deleted.CopyPath, deleted.Path]}`（:110-117）。
- `kore/internal/core/filewrite/delete.go:152-193`：`DeleteDeclared` 再取 `FileWritePrefixClasses[prefix_class]`、复核文件名归属、拼 `dir+name` 做规范路径校验，最后进 `Delete`。备份失败即中止（:98-107），审计失败即拒（:109-120），删除不静默成功（:80-83）→ **不会因缺协议类目 fail-closed 拒掉，也不会产生"删了却回滚不了"的条目**。
- 插件侧 `hardening.go:154-210` `handleRollbackHardening`：先读 `<state>/changes.jsonl`（`KORE_STATE_DIR` 由内核 supervisor 注入，`internal/core/supervisor/start.go:169` 有实证），筛 `plugin=ssh-guard && action=sshd-dropin-write`，校验 `Reversible`+`PurgeOp` 存在，再经 `validateLedgerPurgeOp`（:243-277，kind 白名单 / 绝对路径 / 非根 / 目录归属 fail-closed）核对，**全部通过后才**调用 `file_delete` 受控删除。执行链闭合。

### 1.3 info.json file_write 声明与 P1 类目逐字段匹配 + TestRootActionsDeclared 双向一致
`info.json:78-87` `sshd-dropin-write.file_write` 对照 P1 `sshd.config.d` 类目：

| 字段 | info.json 声明 | P1 类目/协议 | 一致 |
| --- | --- | --- | --- |
| prefix_class | `sshd.config.d` | 类目键 `sshd.config.d` | ✓ |
| mode | `0644` | `FileWriteModeRoot0644="0644"` | ✓ |
| content_policy | `sshd.dropin.v1` | `ContentPolicySSHDropin` + `ValidateFileWriteContent` 有实现分支 | ✓ |
| max_bytes | `65536` | ≤ 类目上限 262144（自我收紧，合法） | ✓ |
| writes_host | `true` | 受控写必须 true | ✓ |
| target | `/etc/ssh/sshd_config.d/` | `class.Dir` 逐字 | ✓ |

`declaration_test.go:28-77 TestRootActionsDeclared`：info.json 5 条 root action id ↔ 代码常量 `rootActionFail2banStatus/BanIP/UnbanIP/SSHDWrite/SSHDDelete` **双向集合相等**（len 相等 + 双向查找），并对 write/delete 各自调 `pluginapi.ValidateRootAction` + 逐字段锁定（write 的 prefix_class/mode/content_policy/max_bytes/writes_host/target/无 purge_op；delete 的 prefix_class/writes_host/target/无 purge_op）。`pluginapi.ValidateRootAction` 真实跑过（见 §2 make check），双向一致成立。

### 1.4 "方案只 file_write 却多 delete" 的判定
- `docs/DESIGN-SSH-DROPIN.md:129`（P2 实施卡）只列"新增 1 条 file_write root_action"；实现多出 `sshd-dropin-delete`。
- 但 ADR-0060 / 方案 §113-114 本就把"一键回滚 = 按 changes.jsonl 的 purge_op 结构化回滚"列为交付，且 §1.1/1.2 证明 file_delete 是**唯一能让插件在不获 root 的前提下复用内核受控删除语义的原语**（直接消费 purge_op 需插件以 root 执行 = 权限放大，已被 `filedelete.go` 开头注释明确否决）。新增动作有完整的跨层支撑与留痕：`CORE.md`（受控文件动作段）、`DATA-MODEL.md`（sshd drop-in 账本实例）、`SECURITY.md` §15.3.3、插件 `CHANGELOG.md` 0.5.0、`TestRootActionsDeclared`/`TestIrreversibleSemantics` 断言、`info.json` description 与 UI 确认框文案。**结论：非跨层不一致，不触发 BLOCKED；属方案实施卡描述粒度不足的记录性问题（非阻断）。**

## 2. 方法（§②）

- **apply 复用 suggest 渲染**：`hardening.go:93-146 handleApplyHardening` 调 `renderSuggestConfig(p)`（suggest.go:98）得到正文，`guardFileWrite(rootActionSSHDWrite, dropInFileName, content)` 写入；`rootActionClient.WriteFile`（:152-158）请求体 `args[0]=文件名 + content`，目录不在请求里。单测 `TestApplyReusesSuggestRenderAndWritesDropIn` 断言 `call.content == suggest.config_text` 逐字节同源，且正文含 `PasswordAuthentication no`/`MaxAuthTries 3`。
- **rollback 逐条 fail-closed**：见 §1.2；`validateLedgerPurgeOp` 同时覆盖 `file.remove`（1 参）与 `file.restore`（2 参），目录归属用 `strings.HasPrefix+无子斜杠` 双重约束。
- **旧 suggest 保留 dry-run**：`methods.go:61-62` 仍派 `handleSuggest`，`suggest.go` 注释/结果 `DryRun:true`（:17/:59/:88），文案改为"只读预览"。
- **7 条 fail-closed 单测断言覆盖**（`hardening_test.go`）：①空建议 ②端口越界 ③通道未注入 ④非零退出码 E_UPSTREAM（以上 TestApplyFailClosed）⑤账本文件不存在 ⑥无本插件条目 ⑦purge 目标越界/缺 purge_op（TestRollbackFailClosed + TestLedgerPurgeOpValidation 的 nil/shell.exec/越界/参数数目错/目标不在目录 5 例）。拒绝时均断言"不得调用删除通道/无结果体"。

**门禁命令与退出码（verifier 独立复跑）：**

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/sshguard.js`（kore） | 0 | 无输出 |
| `make frontend`（kore） | 0 | 首屏 gzip 合计 **91092 B ≤ 307200 B**，无 `*.map`（WARN 基线漂移，非阻断） |
| ssh-guard `make check`（离线 file-proxy + 隔离 GOCACHE，`GOWORK=off`） | **0** | `gofmt: clean` / `go vet ./...` OK / `go test ./...` 两包 ok（`tests/fault` 3.6s）/ race 段 SKIP（无 boundary） |
| kore-plugins `bash scripts/validate-index.sh` | 0 | 24 条全量验签 OK、ed25519 签名验证通过、market 逐字节一致 |
| kore `make market-check` | 0 | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` |

> 备注：本机默认 Go 缓存/模块缓存为只读，且 v0.4.0 未预缓存、禁止联网。为使 `make check` 按原口径（`GOWORK=off`）真跑，verifier 从 `pkg/pluginapi/v0.4.0` tag 用 `git archive` 构造**本地离线 file proxy**（内容与 P1 提交逐字节同源，h1 与 go.sum 一致），并把 GOCACHE/GOMODCACHE 指向工作区临时目录；验证结束已全部删除（`.gocache-c12p2-verify` / `.tmp-c12p2-proxy` / `.tmp-c12p2-modcache` 均 gone）。**该临时代理只用于让门禁复跑，不改变任何仓内文件或声明。**

## 3. 前端 G-28（§③）

- **确认框代码**：`web/sshguard.js` `confirmDialog`（~:1005）为通用二次确认，`requestApply`（~:1040）正文含 `将写入文件：/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf`、`权限：0644 root:root`、三条指令 diff（`diffLines`）、逐条风险+回滚（`riskLines`）；`hardSessionWarning()` 两条黄底警示（"应用只写入配置片段，不会重载 sshd：新设置要等下次…才生效" / "请先确认已有一条可用的密钥登录会话，保留当前终端不要关闭…"）；底部勾选项 `我已确认有可用密钥会话…`，**未勾选时确认按钮 disabled**。`requestRollback` 确认框说明"内核受控删除（删前强制备份，账本记 file.restore），不执行 shell"。
- **KoreUI.failureOf + confirm-token**：`failureText`（:181）唯一错误来源 `window.KoreUI.failureOf`（app.js:211/2774 映射表）；`rootActionToken`（:101）经 `GET .../root-action/<id>/confirm-token` 取令牌，无令牌显式报错不写文件。
- **双端截图实读（verifier 用 identify + read_image 亲自看图，非采信自述）**：
  - `sshguard-dropin-desktop-01.png`：`identify` = **1440×2874**，8-bit sRGB，405784 B；实读可见「确认一键应用加固？」模态框：文件名全路径、`0644 root:root`、三条 diff（PasswordAuthentication yes→no / PermitRootLogin prohibit-password→no / MaxAuthTries 6→3）、两条风险+回滚、两条警示、勾选项+取消/确认，页面下方 dry-run 预览/落地命令亦可见。
  - `sshguard-dropin-mobile-01.png`：`identify` = **390×4033**，8-bit sRGB，363969 B；窄屏单列，同一模态框完整可读，diff/风险/警示/勾选/按钮双端均可见，内容与桌面同源非同图缩放（sha256 分别 `9ffbd3c6…` / `aee7a9cc…`）。
  - `.agents/verify/sshguard-dropin-selfeval.md`：DOM 断言 `hasApply/hasRollback/dialog=true, diff=3, warnings=2, PAGE_ERRORS=[]`，三问自评原文齐备（解决什么问题 / 与宝塔 1Panel 差距 / 可用 vs 占位，且诚实标注"真机写宿主属 P3 VM 复验"）。截图为隔离实例真浏览器产物，不涉及主实例运行态。

## 4. 索引 sha / 四处一致（§④）

- 实测 `sha256sum kore-plugin-ssh-guard/dist/ssh-guard-0.5.0.tar.gz` = `c380cb6c3a9c86b13c50438c7fd62b80391df3da531e703805002f54f38f2ccb`，size=**2880509**；sidecar `.sha256` 同值。
- `index/plugins.json:110-111` sha 同值、size_bytes=2880509；`index/versions.lock.json:300` sha 同值；`presets/full.json` / `security.json` 引用 `ssh-guard 0.5.0`；`market/plugins.js` 由索引派生（build-market --check 一致）。**四处 sha 完全一致；size：info.json=2880507 vs dist/index=2880509，差 2，在 ±2 容差内。**
- validate-index 全量验签 exit 0（24 条 + ed25519 内置公钥）；market-check exit 0。

## 5. 临时物 / 隔离实例清理（§⑤）

- 本 verifier 自建的 `.gocache-c12p2-verify`、`.tmp-c12p2-proxy`、`.tmp-c12p2-modcache` 已删除并回读确认 gone；无残留 kored/playwright 进程，55201 无监听；三仓各 1 主 worktree，无 `wt-*`/`tmp-*` 分支。
- 未触碰他人 dirty 文件、未联网、未 push/tag/Release、未改宿主 `/etc/ssh`、未改 `.kore-local-*`。

## 6. 结论

五项核心复核（跨层一致性 / 方法 / 前端 G-28 / 索引 sha / git 纪律）**全部通过**。唯一观察项（§1.4：实施卡只写 file_write、实现多出 file_delete）经读码证实有完整协议与执行面支撑、且已在内核三份文档 + 插件 CHANGELOG + 单测留痕，判为**记录性粒度问题，非跨层不一致，不触发 BLOCKED**。

**总评：PASS；跨层一致性判定：PASS（一致）。**

—— verifier `c12-p2-verifier`（G-09，独立于 c12-p2）
