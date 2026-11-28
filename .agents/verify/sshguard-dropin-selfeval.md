# ssh-guard 加固「一键应用 / 回滚」面板 · UI 自评与双端证据（G-28）

> 2026-11-28 · 执行者 `c12-p2`（task-342）· 隔离实例 `127.0.0.1:55201`（独立 config/state/run/log + 独立新编译二进制 `kored-isolated`，非 8787；未碰 `.kore-local-*`，未改宿主 `/etc/ssh`）· Playwright（`/home/pt/.cache/pw-runner` 真实 headless Chromium）· 收工已停实例并删临时目录/脚本。
> 实现：`web/sshguard.js` 加固面板在只读「生成建议」之外新增「一键应用 / 回滚」入口；二次确认框列出目标文件、权限、指令 diff、逐条风险与回滚方式，并把「应用≠reload、下次 sshd 重载生效」「保留密钥会话别关终端」两条警示置顶。写/删经插件 0.5.0 的 `apply-hardening` / `rollback-hardening` 方法内转内核受控写/删通道（`file_write` / `file_delete`），沿用 `KoreUI.failureOf` 错误映射与管理员 confirm-token 流程。

## 0. 交付概览

- **一键应用**：先点「生成建议」拿只读预览（dry-run），再点「一键应用」→ 确认框 → 勾选确认 → 管理员 `confirm-token` → `invoke('apply-hardening', {…, confirm})`。后端复用 `suggest.go` 的 `config_text` 渲染，只换写入通道，写 `kore-ssh-guard-hardening.conf` 到 `/etc/ssh/sshd_config.d/`（0644 root:root，allowlist 校验）。**不 reload sshd**。
- **一键回滚**：确认框说明按变更账本撤销 → `invoke('rollback-hardening')`：插件读 `<state>/changes.jsonl` 核对本插件 `purge_op` 形状（kind 白名单/绝对路径/目录归属），再经内核受控删除原语撤销文件（删前强制备份 + 账本记 `file.restore`）。**不逆转 sshd 进程状态**。
- **错误与降级**：所有失败走 `KoreUI.failureOf`（`E_NEED_ROOT` / `E_UNAUTHORIZED` / `E_INVALID` 等有统一「怎么办」），无令牌/无通道/无账本均显式提示且不写文件。

## 1. 双端截图证据（G-28）

| 文件 | identify -format | read_image 实读观察 |
| --- | --- | --- |
| `sshguard-dropin-desktop-01.png` | PNG 1440x2874（PC full-page，宽 1440、高 ≥900） | 「安全 → 网络边界 → SSH 防护」页：加固建议表单有「生成建议 / 一键应用 / 一键回滚」三按钮；截图时弹出「确认一键应用加固？」对话框（居中 680×413，带遮罩），正文逐条：`将写入文件：/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf`、`权限：0644 root:root`、三条指令 diff（`PasswordAuthentication: yes → no` / `PermitRootLogin: prohibit-password → no` / `MaxAuthTries: 6 → 3`）、两条风险及回滚方式；两条黄底警示「应用只写入配置片段，不会重载 sshd…」「请先确认已有一条可用的密钥登录会话，保留当前终端不要关闭…」；底部勾选框「我已确认有可用密钥会话，明白下次 sshd 重载才生效，保留当前终端不关闭」+「取消/确认」。 |
| `sshguard-dropin-mobile-01.png` | PNG 390x4033（手机 390×844 视口 full-page，高 >844） | 窄屏单列：顶栏移动版、SSH 防护页各卡片换行；同一确认框（359×546，居中，内容完整可读），三条 diff、两条警示、勾选确认框与「取消/确认」按钮均可见；按钮下方「一键应用 / 一键回滚」与 dry-run 预览说明紧跟其后，底部 tab 条不遮挡关键内容。 |

两张图不同尺寸、不同 sha256（桌面 `9ffbd3c6…` / 手机 `aee7a9cc…`），非同图缩放冒充。浏览器 DOM 断言：`hasApply=true / hasRollback=true / dialog=true`、`diff=3 条`、`warnings=2 条`、`PAGE_ERRORS=[]`。

## 2. 自评三问

**问 1：本页解决什么用户问题？**
此前 SSH 加固页只能生成建议文本、复制一堆命令手工下发—step 多且容易漏掉「先确认密钥会话再 reload」的关键提醒。现在用户在同一页勾选加固项 → 生成只读预览 → 一键应用（受控写只写 drop-in，不 reload）→ 出问题时一键回滚（按账本结构化撤销）。确认框把「文件名 + 指令 diff + 风险 + 回滚方式 + 下次重载才生效 + 保留密钥会话别关终端」一次讲清，符合易用性四原则（步骤少、小白能看懂、错误给怎么办）。应用与 reload 解耦，当前 SSH 会话零中断，这是与「应用即生效」相比更保守也更适合远程运维的选择。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 的 SSH 安全面板通常提供「一键禁用密码登录 / 一键改端口 + 自动 reload + 防火墙联动」的打包操作。本实现有意克制：①**不自动 reload**（需用户在确认密钥会话后自行 reload，避免 SIGHUP 风险）；②只写 sshd drop-in 片段，不改主配置、不改防火墙/端口；③指令是固定 allowlist（10 条），不支持任意 sshd 配置编辑；④没有「应用历史 / diff 对比视图 / 多主机批量下发」。这是轻量面板定位 + ADR-0060 安全裁决的边界，不作「超越竞品」的证据。

**问 3：当前是"可用"还是"占位"？**
**可用（受控范围）。** 判据：
1. UI 路径：隔离实例真实浏览器登录后，安全 → 网络边界 → SSH 防护 → 生成建议（mock 返回真实 suggest 形状）→ 点一键应用 → 确认框展示文件名/三条 diff/两条风险/两条警示/勾选确认，双端截图肉眼可见，`PAGE_ERRORS=[]`。
2. 调用路径：`apply-hardening` / `rollback-hardening` 在 Go 单测里经 `dispatch()` 真跑（写入通道替身断言 action_id/文件名/正文与 `suggest.config_text` 逐字节同源；回滚经账本替身断言 `purge_op` 越界 fail-closed），非空建议/端口越界/通道未注入/非零退出码/无账本/无条目/越界 purge 全部拒绝；`make check` 全绿、`node --check` exit 0、`make frontend` 首屏 91092 B ≤ 300 KiB。
3. 边界：本机没有真实 sshd drop-in 落盘（隔离实例 kored 非 root，且 mock 了 invoke 返回结构），**「写入真实 /etc/ssh/sshd_config.d 并 sshd -t 复核」属 P3 隔离 VM 复验范围**；本轮 UI 证据不含真机写宿主，不把 mock 说成真机成功。

## 3. 命令与退出码（证据）

```
$ node --check web/sshguard.js                       → rc=0
$ make frontend                                       → rc=0（首屏 91092 B ≤ 307200 B）
$ identify -format '%f %wx%h %b\n' sshguard-dropin-*.png → rc=0（1440x2874 / 390x4033）
$ # Playwright 隔离实例截图脚本（含 DOM 断言）           → rc=0（PAGE_ERRORS=[]）
```

## 4. 诚实边界

- 截图与断言用新编译的隔离 kored（含新 embed 的 `sshguard.js`），**未替换运行中的 `bin/kored`**、未重启 8787 主实例。`status / suggest` 等 RPC 由 Playwright 路由 mock 返回真实形状（取自插件 suggestResult / statusAuditResult），真实 Go 方法行为由本仓单测覆盖。
- 本轮未改动 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`；未执行真机 root-action 写 / install / upgrade；未联网业务。临时隔离目录、脚本、二进制收工已删；只保留两张交付截图与本自评。
