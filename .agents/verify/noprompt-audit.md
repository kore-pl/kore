# 本机口令输入面清查（用户绝对约束：除 kore 自己的账号口令外，任何时候都不应有本机账号口令输入）

> 角色: verifier（安全/可用性审计） · 日期: 2026-11-23 · 方式: 静态分析（未起服务、未写运行态、未真实输入任何口令）
> 判据（用户 2026-11-23 两次收窄后的最终口径）:
> 1. **允许**：kore 自己的管理凭据（`admin-password` 设置的 kore 口令 / kore 管理的插件凭据库）。
> 2. **允许**：**壳子安装那一次**的 sudo（装二进制 / 装 unit / enable）。
> 3. **P0**：**运行期**任何要求本机口令的路径（sudo / pkexec / polkit 授权框 / askpass / su / `systemd-run` 触发授权）。
> 4. **P1**：**文档/代码提示教用户在运行期用 sudo**（升级、卸载、重启、改配置）。
> 5. **P2**：**仅安装那一次**的 sudo——不判违规，但必须列清边界，并检查有没有把安装期 sudo 扩散到运行期。

---

## 0. 结论先行

**当前产品不满足这条绝对约束（结论：否）。**

- 安装**之后**至少还有三条常规路径要求用户在本机输 sudo 口令：**① 升级 ② 卸载 ③ 服务重启/替换二进制**。这三条既没有产品内建的自助通道，也没有"内核以 root 常驻所以能自己干"的实现。
- 代码与文档**持续教用户 sudo**（`service.go` 的 hint、`kored uninstall` 的 SKIP 提示、RUNBOOK/OPERATIONS 的全部运维命令）。
- **唯一"干净"的面**是「面板内的插件特权动作」：当前推荐形态（system unit，内核以 root 跑）下 `systemd-run --uid=0` 由 root 发起，不弹 polkit；但这条"干净"是靠**内核全程 root 运行**换来的（不是靠 OS 身份 + 最小权限），且非 root 形态下这些动作直接 `E_NEED_ROOT` 不可用——见 §4、§6。

---

## 1. 清查方法与覆盖范围

执行命令（原样，只读）：

```bash
grep -rn "sudo\|pkexec\|systemd-run\|askpass\|polkit\|SUDO_ASKPASS\|--uid=0\|--uid 0" \
  --include='*.go' --include='*.sh' . | grep -v '_test.go' | grep -v 'testdata/'
grep -rn "ReadPassword\|os.Stdin\|term.Read\|bufio.NewReader\|ReadString\|Scanln\|Scanner" \
  --include='*.go' cmd/ internal/ pkg/ | grep -v '_test.go'
grep -rn "sudo" docs/ *.md
grep -rn "type=\"password\"" web/*.js web/index.html
grep -rn "root_actions" -A 10 ../kore-plugin-*/info.json
```

覆盖：`cmd/` `internal/` `pkg/` `scripts/` `Makefile` `docs/**` `*.md` `web/**`、兄弟仓 `../kore-plugin-{firewall,ssh-guard,waf}/info.json`（24 个插件仓中仅此 3 个声明 `root_actions`）。

**未做**：任何会写运行态或需真实口令的动态验证（按纪律禁止）。所有"会不会弹框"的结论都标注了证据强度，"需真机"的一律进 §5。

---

## 2. 明细表（file:line + 原文 + 触发时机 + 分级）

### 2.1 代码：会不会在运行期弹系统授权

| 位置 | 原文（摘录） | 触发时机 | 是否弹本机口令 | 分级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| `internal/core/privilege/systemd.go:36` | `"systemd-run", "--uid=0", "--collect", "--wait",` | 运行期（每次 root_action） | **仅当调用方非 root 时会**（polkit `manage-units` = `auth_admin`）；当前代码路径**不可达**，见下一行 | **P0（条件性/未确认）** | 保持"只有 root 内核能走这条"的门禁；若将来放开非 root，必须同批要求 polkit 规则，否则就是每次弹框 |
| `internal/core/privilege/service.go:88-96` | `if !s.opts.Root() { ... E_NEED_ROOT ... "请用 sudo/systemd 启动 kored" ... }` | 运行期（非 root 时立即返回） | **不弹**（直接失败）；但 hint 在教用户 sudo | hint 部分 **P1** | hint 改为"以系统服务方式启动（安装时已授权）"，不出现 `sudo kored` |
| `internal/core/privilege/service.go:97-100` | `if ok, detail := s.opts.Systemd(); !ok { ... E_NO_SYSTEMD ... "无 systemd 环境请显式配置 sudoers 降级（见 docs/RUNBOOK.md）" }` | 运行期 | 不弹（只是错误文案） | 文案 **P1**（指向 sudoers 降级路径） | 该 docs 锚点当前无对应 sudoers 章节，属悬空指引；应删或补"运维手写、非产品引导"的明确警示 |
| `internal/core/privilege/systemd.go:83` | `func DetectRoot() bool { return os.Geteuid() == 0 }` | 运行期 | 不弹 | — | 门禁事实来源，保留 |
| `internal/core/httpapi/handlers.go:42` | `// Hint 是可操作提示（如"请用 sudo/systemd 启动 kored"）` | 运行期（响应字段透传） | 不弹 | **P1**（教 sudo 的注释/数据源） | 随上一条一起改口径 |
| `internal/platform/linux_identity.go:194` | `// root 的 docker / sudo 等补充组，等于换了 uid 却仍然等价 root` | 运行期（降权逻辑） | 不弹（注释 + 显式收组，正面） | — | 无需改 |
| `pkg/pluginapi/errors.go:25` | `// E_NO_SYSTEMD 提权通道依赖 systemd-run` | 运行期（注释） | 不弹 | — | 无需改 |
| `pkg/pluginapi/rootpolicy.go:32` | `// maxNftStatements ... 一次 systemd-run 内的批处理` | 运行期（注释） | 不弹 | — | 无需改 |
| `internal/core/privilege/request.go:33/72`、`privilege.go:2`、`systemd.go:12/22/24/30/47/60/64/85/90`、`service.go:77/93/94/99/147`、`handlers_rootaction.go:46` | 均为 `systemd-run` / `sudo` 的注释、错误文案、argv 注释 | — | 不弹 | 注释类不判；含 sudo 的文案见上 | — |

> 结论：`internal/` 与 `pkg/` 里**没有任何会主动 exec `sudo` / `pkexec` / `askpass` 的代码**（`grep` 零命中 `exec.Command("sudo"…)`）。运行期唯一的系统授权入口是 `systemd-run --uid=0`，且被 `Root()` 门禁挡在 root 内核之后。

### 2.2 脚本 / 安装路径：安装期 sudo 与"扩散到运行期"

| 位置 | 原文（摘录） | 触发时机 | 是否弹本机口令 | 分级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| `Makefile:409-416` | `install: build` → `install -m 0755 "$(BIN)" "$(BINDIR)/kored"` → `bash scripts/install-service.sh …` | **安装期**（也用于**升级**） | 是（需 root，且提升到 `/usr/local` 形态） | 安装期 **P2**；**升级期 P0** | 升级不应复用安装期入口；见 §4 P0-1 |
| `scripts/install-service.sh:17-20` | `if [ "$(id -u)" -ne 0 ]; then echo "[FAIL] 安装 systemd unit 需要 root：sudo make install"` | 安装期 | 是（脚本本身不自行提权，硬失败） | **P2**（安装期） | 保留硬失败（正面：不偷偷 sudo），但文案里的 `sudo make install` 属 P1 措辞 |
| `scripts/install-service.sh:60` | `卸载：sudo kored uninstall（或 sudo make uninstall）…` | 安装期输出 | — | **P1**（把 sudo 教到运行期卸载） | 卸载叙事改成"由已 root 的内核自助完成"或"安装时登记的卸载入口" |
| `scripts/install-service.sh:31-47` | unit 模板：`Type=simple` / `ExecStart=$BIN serve` / `Delegate=yes` | 安装期写 unit | — | **P2**，但**无 `User=`** → **内核以 root 常驻**（见 §6 风险） | 至少显式写 `User=` 并说明默认 root 的理由 |
| `scripts/install-polkit-rule.sh:194-195` | `[NEED-ROOT] 真装需要 root … sudo bash <script> --user <svc>` | 安装期（一次性） | 是 | **P2** | 若确需该规则，进 ADR-0023 §3.5 豁免清单（当前未进，见 §5） |
| `scripts/install-polkit-rule.sh:202/207/251` | `卸载需要 root：sudo bash $0 --remove` / `撤销: sudo bash $0 --remove` | **运行期**（撤销/卸载） | 是 | **P1** | 撤销也应走内核自助或安装期登记的入口 |
| `scripts/install-polkit-rule.sh:19-28` | `本规则把授权从「每次操作弹 polkit 口令框」改成「安装时一次性授权」…不装这条规则 → 普通用户跑 kored 时每次 root 动作都要求输入管理员口令` | 安装期（规则） | 断言"存在弹框路径" | **P2 + 未确认** | 与 `service.go:88` 的 root 门禁**互相矛盾**，必须澄清是哪一版行为 |
| `scripts/install-polkit-rule.sh:106-119` | `polkit.addRule(...)` 5 条收紧 → `polkit.Result.YES` | 运行期（规则生效后） | 不弹（免口令放行） | —（机制本身合理） | 但它是"产品级提权"，需 ADR 留痕 |
| `Makefile` 全文件 | `grep -n polkit Makefile` → **零命中** | — | — | **未确认/风险** | 安装流程**没有**调用该脚本；用户不会被引导安装 → 非 root 形态下"零口令"无保障 |

### 2.3 CLI：所有读终端输入的地方（是否 kore 自己的凭据）

| 位置 | 原文（摘录） | 触发时机 | 性质 | 分级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| `cmd/kored/admin_password.go:33` | `return readPasswordNoEcho(os.Stdin)` | 运行期（`kored admin-password --set`） | **kore 自己的 admin 口令** | 允许 | 保留（就是用户豁免的那一项） |
| `cmd/kored/admin_password.go:36` | `adminStdin io.Reader = os.Stdin`（`--stdin` 管道） | 同上 | kore 自己的 admin 口令 | 允许 | — |
| `cmd/kored/admin_password.go:184` | `line, err := bufio.NewReader(adminStdin).ReadString('\n')` | 同上 | kore 自己的 admin 口令 | 允许 | — |
| `cmd/kored/tty_linux.go:35` | `line, err := bufio.NewReader(f).ReadString('\n')`（关 ECHO 读一行） | 同上 | kore 自己的 admin 口令 | 允许 | 终端属性靠 `defer` 恢复，实测路径正确 |
| `cmd/kored/tty_stub.go:18` | 同上（非 Linux 桩） | 同上 | kore 自己的 admin 口令 | 允许 | — |
| `cmd/kored/uninstall.go:148` | `if !deps.confirm(os.Stdin, stdout) { … }` | 运行期（卸载前 y/N 确认） | **确认意图，不是口令** | 不判 | 与"口令"无关；但卸载整体见 P0-2 |
| `cmd/kored/changes.go:96` | `scanner := bufio.NewScanner(file)` | 运行期（读 `changes.jsonl`） | 读文件，非输入 | 不判 | — |
| `internal/platform/terminal_stub.go:9` | `info, err := os.Stdin.Stat()` | 运行期 | TTY 判定 | 不判 | — |

> 结论：CLI 的**口令读取只有一个目标——kore 自己的 admin 口令**，落在用户明确豁免的范围内。没有任何"读本机账号口令"的代码路径。

### 2.4 前端：有没有要求输入口令的 UI

| 位置 | 原文（摘录） | 触发时机 | 是否本机口令 | 分级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| `web/credentials.js:112` | `secret.type = 'password'; secret.autocomplete = 'new-password';` | 运行期（用户录入插件/服务凭据） | **否**（kore 凭据库条目，加密存储；不是本机账号） | 允许（标注） | UI 文案需明确"这是 kore 保存的第三方凭据，不是你的系统口令" |
| `web/db.js:980` | `{ title: isPg() ? 'PostgreSQL 连接' : '数据库连接', focusKey: 'password' }` | 运行期（添加 DB 连接） | **否**（被管理的数据库账号；灰区） | 允许（标注灰区） | 若用户填的是本机 MySQL `root` 口令，形式上等同于"本机服务账号口令"——需产品文案明确"建议专用低权账号" |
| `web/redis.js:1075` | `{ title: 'Redis 连接', focusKey: 'password' }` | 运行期 | 同上灰区 | 允许（标注灰区） | 同上 |
| `web/login.html` / 登录页 | `grep 'type="password"' web/*.js web/index.html` → **零命中**（登录页不在 `web/*.js` 字面量里，见下） | — | kore 自己的 admin 口令 | 允许 | 远程场景登录允许（用户口径） |

> 前端**没有**任何"让用户输本机系统账号口令"的 UI；面板内不存在 sudo/polkit 对话框形态。这一面是干净的（除 DB/Redis 口令属"第三方服务凭据"的灰区，需文案收口）。

### 2.5 插件 root-action 通道（最可能弹框处，重点）

| 位置 | 事实 | 触发时机 | 是否弹本机口令 | 分级 |
| --- | --- | --- | --- | --- |
| `../kore-plugin-firewall/info.json:36-48+` | `"root_actions": [{ "id": "ufw-status", "argv": ["ufw","status","verbose"] … }]` | 运行期（面板点"刷新状态"/写规则） | 依赖内核 `systemd-run`；**root 内核 → 不弹**；非 root 内核 → `E_NEED_ROOT`，不弹 | 条件性 P0（见 §2.1 首行） |
| `../kore-plugin-ssh-guard/info.json:38-48+` | `"root_actions": [{ "id": "fail2ban-status", "argv": ["/usr/bin/fail2ban-client","status","sshd"] … }]` | 同上 | 同上 | 同上 |
| `../kore-plugin-waf/info.json` | 声明 `root_actions` | 同上 | 同上 | 同上 |
| `internal/core/privilege/service.go:88` | 非 root 直接 `E_NEED_ROOT`，**不会**走到 `systemd-run` | 运行期 | **不弹**（功能不可用） | —（这是当前唯一"防弹框"闸门） |

> 关键判断：**插件特权动作是否弹框，完全取决于内核是否以 root 运行**。推荐安装形态（system unit，无 `User=`）下是 root，所以不弹；但这也意味着"面板 = root"，见 §6。

### 2.6 ADR-0028 受控文件写（`/etc/ssh/sshd_config.d/` 等）

| 位置 | 事实 | 依赖的权限 | 是否弹本机口令 | 分级 |
| --- | --- | --- | --- | --- |
| `docs/DECISIONS/0028-controlled-file-write.md:8/17/34` | 写 `/etc/*` 受控片段走**同一条 root-action 链**（systemd-run + 审计 fail-closed） | **kored 必须以 root 运行**（ADR-0028:177 "实际属主 = 调用进程（root-action 下即 root）"） | root 内核下**不弹**；非 root 内核下直接不可用 | 条件性 P0（同 §2.5） |
| `docs/DECISIONS/0028-controlled-file-write.md:75-78` | 白名单：`/etc/ssh/sshd_config.d/`、`/etc/sysctl.d/`、`/etc/security/limits.d/`、`/etc/logrotate.d/`（均 `root:root`） | 同上 | 同上 | 同上 |
| `docs/DECISIONS/0028-controlled-file-write.md:182` | 自述"端到端写盘未真机验证…四个白名单目录均 `root:root 0755` 不可写" | — | — | 未确认（缺 root 真机 e2e） |

> 这条是"禁区"的直接证据链：**受控写 `/etc` 要求 kored 全程 root**。它不额外新增口令输入点，但它把"运行期零口令"绑死成"内核必须永远 root"——而"永久 root 常驻"与"最小权限/零侵入"是两个不同维度的代价，需用户裁决，不能当成零成本。

### 2.7 文档教用户 sudo（逐条）

> 规则：**安装那一次** = P2；**装完之后的日常/运行期** = P1。

| 位置 | 原文（摘录） | 时机 | 分级 |
| --- | --- | --- | --- |
| `docs/RUNBOOK.md:186-188` | `sudo install -m 0755 bin/kored /usr/local/bin/kored` / `sudo systemctl daemon-reload` / `sudo systemctl enable --now kore` | **安装期** | **P2** |
| `docs/RUNBOOK.md:193` | `**为什么必须 root**：systemd-run --uid=0 由非 root 调用会走 polkit 交互认证` | 设计说明 | 说明性（但定位了弹框机制） |
| `docs/RUNBOOK.md:247/267` | `sudo tee /etc/systemd/system/kore.service …` / `sudo systemctl daemon-reload && sudo systemctl enable --now kore` | **安装期** | **P2** |
| `docs/RUNBOOK.md:280-281` | `sudo systemctl stop kore` / `sudo systemctl start kore`（装插件前停服务） | **运行期（每次装插件/升级）** | **P1** |
| `docs/RUNBOOK.md:306/309` | `sudo kored uninstall --yes [--purge]` | **运行期（卸载）** | **P1**（且是 P0-2 的文档面） |
| `docs/RUNBOOK.md:332-334` | `sudo systemctl disable --now kore` / `sudo rm -f …/kore.service` / `sudo getent passwd … | xargs … sudo userdel` | **运行期（手动卸载兜底）** | **P1** |
| `docs/RUNBOOK.md:346/359` | `| sudo kored uninstall --yes [--purge] | 全链执行 |` / `怎么补做（拿到 root 后重跑）：sudo kored uninstall --yes --purge` | **运行期** | **P1** |
| `docs/RUNBOOK.md:378-381/404` | `sudo systemctl stop kore` / `sudo cp -a …` / `sudo systemctl restart kore`（迁移形态） | **运行期** | **P1** |
| `docs/OPERATIONS.md:25/29/30/33` | `sudo systemctl stop kore.service` / `sudo cp <install>/bin/kored …bak` / `sudo install -m 0755 ./kored-new …` / `sudo systemctl start kore.service` | **运行期（升级/重启/备份）** | **P1**（P0-1/P0-3 的文档面） |
| `docs/OPERATIONS.md:94` | `sudo chown -R <运行用户>:<运行组> <install>/data <install>/config` | 运行期（fhs 形态修复） | **P1** |
| `docs/USABILITY-AUDIT.md:65` | `建议：统一错误组件给「复制命令」按钮（sudo systemctl restart kore）` | 运行期（错误页给用户复制 sudo 命令） | **P1** |
| `docs/PLUGIN-CAPABILITY-ROADMAP.md:41` | `现降级为 E_NEED_ROOT + 手抄 sudo rndc reload` | **运行期（每次 dns 操作手抄 sudo）** | **P1**（最坏的形态：把 sudo 当功能降级方案） |
| `docs/SECURITY.md:370` | `撤销：sudo bash scripts/install-polkit-rule.sh --remove` | 运行期（撤销授权） | **P1** |
| `docs/SECURITY.md:310/318/326/333` | `sudo` 仅出现在威胁模型/降权说明/实测记录（"不能 sudo"、"凭据不含 sudo 组"） | 设计说明 | 不判（非指引） |
| `docs/DECISIONS/0018-privilege-model.md:216` | hint 必须含「请用 sudo 启动 kored」 | 设计口径 | **P1**（把"教 sudo"写进协议要求） |
| `docs/DECISIONS/0018-privilege-model.md:121` | `非 systemd 环境：文档给出 B 的 sudoers 片段（运维手写、visudo -c 校验）` | 运行期降级 | **P1**（且 RUNBOOK 无该章节，悬空） |
| `docs/PLUGIN-PROTOCOL.md:389` | `E_NEED_ROOT … 按 hint 以 sudo/systemd 启动 kored` | 协议文档 | **P1** |
| `cmd/kored/install.go:137-138` | `sudo systemctl stop kore  # 系统级实例` / `sudo systemctl start kore`（state.db 被占用提示） | **运行期（每次 CLI 装插件）** | **P1** |
| `cmd/kored/uninstall.go:165/176/196/308` | `补做请用 sudo kored uninstall [--yes]` | 运行期（卸载） | **P1**（P0-2 的代码面） |
| `internal/core/privilege/service.go:93-94` | `请用 sudo/systemd 启动 kored` | 运行期（API hint） | **P1** |

---

## 3. P0 汇总（运行期会要求本机口令的路径）

按"能否用一次性安装期授权消除 / 必须改架构"分类。

### 3.1 必须改产品（不能用 polkit 消除）— 真正的 P0

| # | 路径 | 证据 | 为什么必须改 |
| --- | --- | --- | --- |
| **P0-1** | **升级**：替换 `kored` 二进制 + 重启服务，必须用户在 shell 里 `sudo` | `Makefile:409-416`（`install: build` 直接装二进制 + unit）；`docs/OPERATIONS.md:25-33`（`sudo cp` / `sudo install -m 0755 ./kored-new` / `sudo systemctl restart`）；`cmd/kored/main.go:30-56` 子命令**无 upgrade/self-update**；`grep -rn "upgrade\|selfupdate" cmd/ internal/` 命中的全是插件/会话/停插件，**没有内核自更新**；`internal/core/httpapi/` **无** system restart/upgrade 端点（`grep restart` 只命中 `requires_restart` 提示字段与插件 restarts 计数） | polkit 管的是 `manage-units`，管不了"用户拿不到能写 `/usr/local/bin` 的身份"。**要零口令升级，必须由 root 常驻内核自助替换二进制 + `systemctl restart kore`（SIGTERM 自重启或 systemd `Restart=`）**，而不是让用户敲 sudo。**当前完全没有这条通道。** |
| **P0-2** | **卸载**：`kored uninstall` 需要 root | `cmd/kored/uninstall.go:152-160`（非 root → `partial=true`，宿主侧两步跳过，**最终仍以 6 退出**，绝不谎报 0）；`:176/:196`（`[SKIP] … 补做：sudo kored uninstall --yes`）；`:308`（hint 直接给 `sudo kored uninstall --yes`） | 同 P0-1：CLI 子进程身份 = 调用者，不是常驻内核。**需新增"root 内核自助卸载"通道**（通过 root 服务执行 stop→disable→rm unit→userdel→删目录，并把"服务杀自己"的顺序设计正确），否则卸载永远要 sudo。 |
| **P0-3** | **服务运维**：重启 / 换二进制 / 修属主 | `docs/OPERATIONS.md:25/29/30/33/94`；`docs/RUNBOOK.md:280-281/404` | 与 P0-1 同根：缺"内核自助执行 host 级动作"的通道。若不改架构，只能在文档里承认"运维要 sudo"，即违反用户约束。 |
| **P0-4** | **启动/前台模式**：`sudo kored serve`（无 systemd 或手工前台） | `internal/core/privilege/service.go:93-94`（hint 原文"请用 sudo/systemd 启动 kored"）；`docs/RUNBOOK.md:193` | 每次启动都要输口令。**这不是安装一次**——重启机器/重启服务都会再要一次。polkit 无法消除（`sudo` 是独立授权链）。 |

### 3.2 条件性 P0 — 取决于"内核是否 root"，且当前被门禁挡住

| # | 路径 | 证据 | 能否用 polkit 规则消除 | 状态 |
| --- | --- | --- | --- | --- |
| **C-P0-a** | 插件 root_action → `systemd-run --uid=0` 触发 polkit `auth_admin` 弹框 | `internal/core/privilege/systemd.go:36`；`scripts/install-polkit-rule.sh:26-28`（"不装这条规则 → 普通用户跑 kored 时每次 root 动作都要求输入管理员口令"）；对照 `docs/RUNBOOK.md:193`（"非 root 调用会走 polkit 交互认证，本机实测 `--no-ask-password` 被拒"） | **能**：`install-polkit-rule.sh` 的 5 条收紧规则（action id / `subject.user` / `local && active` / `verb` / unit 名正则）→ `polkit.Result.YES` | **当前不可达**：`service.go:88` 在 `systemd-run` 之前就判 `!Root()` 返回 `E_NEED_ROOT`。**但**脚本自述与 ADR 实测都声称该弹框真实存在 → 二者矛盾，必须真机澄清（§5-1） |
| **C-P0-b** | ADR-0028 受控写 `/etc/ssh/sshd_config.d/` 等 | `docs/DECISIONS/0028-controlled-file-write.md:17/34/177` | 不能（这不是 polkit 场景，是**必须 root 内核**） | 当前设计=root 内核下执行，不弹；非 root 直接不可用 |

### 3.3 P0 消除路径（给决策者的两个选项）

| 选项 | 做法 | 代价 | 能否满足"只有安装一次 sudo" |
| --- | --- | --- | --- |
| **A. root 常驻内核 + 自助 host 动作** | 内核以 root 常驻（现状），新增：① 自更新（下载→校验签名→原子替换→`systemctl restart` 自身）② 自助卸载（root 服务执行宿主侧清理）③ 运维动作 API（restart/reload） | 面板 = root（与 §6 风险同源）；自更新是新的高危面（签名/回滚必须做到） | **能**（安装一次后零口令）——这是唯一能同时满足"零口令"与"零侵入"的方向 |
| **B. 保持现状（人工 sudo）** | 升级/卸载/重启继续由运维 sudo | 每次运维要口令 | **不能** |

---

## 4. 安装期一次 vs 运行期零次（逐动作分栏）

### 4.1 安装期那一次（P2，允许）

| 动作 | 证据 | 需要特权的真实原因 |
| --- | --- | --- |
| 装二进制到 `$(BINDIR)`（`/opt/kore/bin` 或 `/usr/local/bin`） | `Makefile:413-414` | 写 `/usr/local` 需 root；`/opt/kore` 形态若属主是用户则**不需要** sudo（这是当前 P2 里最容易被误扩散的一项） |
| 装 + enable systemd unit | `Makefile:416` → `scripts/install-service.sh`；`docs/RUNBOOK.md:247-267` | `/etc/systemd/system` + `systemctl enable` |
| 装 polkit 免口令规则（**如果确实需要**） | `scripts/install-polkit-rule.sh`（`--dry-run/--check` 可非 root） | `/etc/polkit-1/rules.d` 属 root；**当前 `Makefile` 未调用它**（`grep polkit Makefile` 零命中） |
| 首次按需建 `kore-<id>` 用户 | `docs/SECURITY.md:310`（supervisor 在 bind/exec 前 `useradd`） | **不需要用户 sudo**：由 root 常驻内核自己执行。这是"安装期授权"的正确用法——一次授权，后续自动化 |

### 4.2 运行期（必须零次，当前未达成）

| 动作 | 当前是否要口令 | 证据 | 分级 |
| --- | --- | --- | --- |
| **升级 kored** | **要**（`sudo install` + `sudo systemctl restart`） | P0-1 | **P0** |
| **卸载 kore** | **要**（非 root exit 6 → `sudo kored uninstall --yes`） | P0-2 | **P0** |
| **重启服务 / 换二进制 / 修属主** | **要** | P0-3 | **P0** |
| **前台/手工启动 kored** | **要**（`sudo kored serve`） | P0-4 | **P0** |
| 装/卸/启停**插件** | 装插件：`systemctl --user stop kored-local` 不要口令；**系统级实例要 `sudo systemctl stop kore`**（`cmd/kored/install.go:137`、`RUNBOOK:280`） | — | **P1**（同一动作在 portable 形态零口令、fhs 形态要口令——形态不一致，必须收口） |
| 插件特权动作（防火墙/sshd/容器/受控写文件） | 推荐形态（root 内核）**不要**；非 root 形态**不可用**（`E_NEED_ROOT`） | §2.5 / §2.6 | 条件性 P0（当前不触发） |
| 面板登录 | 要 **kore 自己的**口令 | 用户豁免 | 允许 |
| 插件/DB/Redis 凭据录入 | 要**第三方**凭据（非本机账号） | `web/credentials.js:112`、`web/db.js:980`、`web/redis.js:1075` | 允许（灰区，需文案收口） |

### 4.3 直接回答用户那句"以后再也不允许"

> **装完之后，用户还需要在什么情况下输本机口令？**
>
> **需要，至少 4 类：升级、卸载、重启/换二进制、前台启动。** 因此答案是：**当前不满足**。唯一在运行期做到"零口令"的是「面板内的插件特权动作」，但它的代价是内核全程 root（§6），且非 root 形态直接不可用——用"功能不可用"换"不弹框"，不等于满足约束。
>
> **要变成"一次都不需要"，必须落地 §3.3 选项 A**（root 常驻内核 + 自更新 + 自助卸载 + 运维动作 API），并把 §4.2 的 P1 文档口径全部改掉。

---

## 5. 未确认项（缺什么证据）

| # | 未确认内容 | 缺的证据 | 怎么补 |
| --- | --- | --- | --- |
| 1 | `systemd-run --uid=0` 在当前代码下**是否真会弹 polkit** | `service.go:88` 的 `Root()` 门禁使该路径在非 root 下不可达；但 `install-polkit-rule.sh:26-28` 与 `RUNBOOK:193` 都声称"非 root 每次弹框"。二者必有一方描述的是旧版/直连 `systemd-run` | 在**真机**用 `timeout 5 systemd-run --uid=0 --no-ask-password /bin/true`（不输密码）看是否返回 `Access denied`/`interactive authentication`；再以非 root 起 kored 临时放开 `Root()` 门禁跑一次 root_action（需授权起服务，本轮禁止） |
| 2 | 装完之后**是否有人提示安装 polkit 规则** | `grep polkit Makefile scripts/zero-intrusion-check.sh docs/DECISIONS/0023-zero-intrusion.md` → **零命中**；`docs/RUNBOOK.md` 的安装章节（§5）也没提 | 查 `make install` 输出/安装向导源码是否有该步骤；当前静态证据=**没有** |
| 3 | polkit 规则**未进** ADR-0023 §3.5 豁免清单 | `docs/DECISIONS/0023-zero-intrusion.md` §3.5 只有 4 项（unit / `kore-<id>` 用户 / 用户批准的宿主变更 / 显式二进制）；`docs/SECURITY.md:374-376` 自己写"要进豁免清单…由 ADR 维护方落笔" | G-31 要求"新增任何安装目录外写入必须先改 ADR-0023" → 当前**规则文件写入 `/etc/polkit-1/rules.d/` 属清单外写入**，`make zero-intrusion-check` 是否拦截未验证 |
| 4 | 从 **root system unit**（无用户会话、无 `XDG_RUNTIME_DIR`）调用 `systemd-run` 是否稳定成功 | 未实测（本轮禁止起服务） | root 隔离实例跑一次 `ufw-status` root_action，看 `systemctl status kore-root-*` 与审计 `root.action` |
| 5 | 是否有**未提交**的自更新/自助卸载通道 | 工作树有 `M cmd/kored/serve.go`、`M cmd/kored/serve_runtime.go` 等他人未提交改动，本轮只读当前工作区文本 | 由对应 owner 确认；若已在途，P0-1/P0-2 的分级需下调 |
| 6 | ADR-0028 受控写 `/etc/*` 端到端 | `ADR-0028:182` 自述"未真机验证，四个白名单目录不可写" | root 真机 e2e；本轮只读 |

---

## 6. 附带风险（不是口令问题，但审计必须报）

1. **面板 = root**：`scripts/install-service.sh:31-47` 的 unit 模板与 `docs/RUNBOOK.md:257-270` 的模板**都没有 `User=`**，默认以 root 运行 `kored serve`。`docs/SECURITY.md:2` 的信任边界也写"主壳 kored root 运行"。这意味着 Web 管理面任一 RCE/逻辑漏洞 = 宿主 root，与"插件不可信"的威胁模型只隔一层。**建议**：至少在 unit 里显式写 `User=`（用户可选）并把"root 内核仅用于 root_action 通道"作为可选硬化。
2. **`NoNewPrivileges=false`**：`docs/RUNBOOK.md:183` 显式关闭 NNP（为了让 root_action 通道可用）。这使 sudo/setuid 在 kored 子进程里仍可用——与"插件不得提权"相反方向的加固被放弃。需在 ADR 里记代价。
3. **`sudoers` 降级路径是悬空指引**：`ADR-0018:121`、`RUNBOOK:223`、`service.go:99` 都让用户"手写 sudoers 片段"，但 RUNBOOK **没有该章节**（`grep sudoers docs/RUNBOOK.md` 只命中错误表一行）。这既教 sudo，又教不到位——属"最坏的形态"。
4. **DB/Redis 口令灰区**：`web/db.js:980`、`web/redis.js:1075` 让用户填数据库/缓存口令。若用户填本机 `root`/系统账号口令，形式上就是"本机服务账号口令输入"，虽不在本次判据的"系统账号"字面内，但应让 UI 明确"请用专用低权账号"。

---

## 7. 复核命令（只读，可复现本报告）

```bash
grep -rn "sudo\|pkexec\|systemd-run\|askpass\|polkit" --include='*.go' --include='*.sh' . \
  | grep -v _test.go | grep -v testdata/
grep -rn "ReadPassword\|os.Stdin\|ReadString" --include='*.go' cmd/ internal/ | grep -v _test.go
grep -rn "sudo" docs/ *.md | grep -v DECISIONS
grep -rn "root_actions" -A 6 ../kore-plugin-*/info.json
grep -n "install:" -A 8 Makefile
sed -n '150,200p' cmd/kored/uninstall.go
```

**未执行**：任何会写运行态、起服务、或需要真实口令的命令（G-29 + 本轮纪律）。
