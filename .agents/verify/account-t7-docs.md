> 状态: scribe 验收报告 · 归属: account-docs（ADR-0057 T7 文档收口）· 日期: 2026-11-25 · 工作区: /home/pt/Work/GolandProjects/kore-pl/kore
> 纪律: 只写文档 / 台账；commit 不 push、不触发 CI、不碰运行态（G-29）；报告中所有口令 / 凭据为占位（G-30）；临时脚本即建即删；append-only 不改历史正文。
> 一句话结论: **ADR-0057 已正式落盘 accepted，0043/0055/SECURITY/CORE/USABILITY/QUICKSTART 六份下游文档只追加新节（git diff numstat 全部 N 插入 / 0 删除），G-23 台账 + HANDOFF 快照已补齐；docs-check / secret-check / log-check 三门禁 exit 0。**

# ADR-0057 T7 · 文档收口与验收报告

## 1. 写域与纪律自检

| 项 | 内容 |
| --- | --- |
| 本卡写域 | `docs/DECISIONS/0057-login-account-model.md`（新）、`docs/DECISIONS/0043-*.md` §7 / `0055-*.md` §8.7 append、`docs/{SECURITY,CORE,USABILITY}.md` append、根 `QUICKSTART.md` append、`.agents/LOG/{DECISIONS,DISPATCH}.md` 追加行、`.agents/HANDOFF.md` 追加快照、本报告；**lead 扩域批准追加** `AGENTS.md` §6 / `README.md` 文档表（仅端点计数 70→71） |
| 明确不碰 | 任何 `internal/**` / `cmd/**` / `web/**` 代码；`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 运行态（G-29）；他人未提交的 `web/app.js` / `scripts/usability-pending.txt` 与 `data/` 等 |
| 横向协商 | 开工 `send_message` account-ui / account-password 确认写域不相交：两人只写 `web/app.js` / `web/style.css` / `web/settings.js` / `web/dist/settings.js` 与各自报告 / 截图，不碰本文档卡任何文件；T5 / T6 的 commit 以各自报告为准 |
| append-only 证据 | `git diff --numstat` 对六份既有文档：`QUICKSTART.md 31/0`、`docs/CORE.md 24/0`、`docs/DECISIONS/0043 9/0`、`0055 10/0`、`docs/SECURITY.md 27/0`、`docs/USABILITY.md 18/0`；台账 `DECISIONS 2/0`、`DISPATCH 9/0`、`HANDOFF 26/0`——**全部零删除** |
| 临时资产 | 追加台账 / 快照用的 `.t7-*.tmp`、门禁用 `/tmp/t7-docs*.txt` 均为一次性，用完即删；工作区无本卡临时脚本残留 |

> **插曲（如实记录）**：首次用 `read` 工具读 `docs/CORE.md` / `docs/SECURITY.md` 准备 append 时，工具按字节上限截断了长文件正文，导致两文件历史正文丢失（行数从 390/469 掉到 186/390）。`git diff --numstat` 立即发现 (-318)，已用 `git show HEAD:<file> > <file>` 从 HEAD 逐字节恢复，再以 `cat <append> >> <file>` 重追加；恢复后两文件 `numstat` 为 `24/0` / `27/0`，历史正文零损失。**未改写任何已提交历史，未用 reset / amend / rebase**。

## 2. 交付清单（逐项可回读）

### 2.1 正式 ADR

- 新文件 [docs/DECISIONS/0057-login-account-model.md](../../docs/DECISIONS/0057-login-account-model.md)（178 行，accepted）：正文来自 [architect 草案](login-account-model.md)（commit `0b80dae`）的候选，状态 draft→accepted。
  - §2 十二项多选一对比、§3 裁决、§4 复审条件、§5 被否决选项（多账号 / 无用户名 / 短信验证码 / 外部服务逐条在列）。
  - §6 **实现复核注记**：逐卡引用 commit `0b80dae`（草案）/ `b1f7e59`（T1）/ `ee724d5`（T2）/ `b5480a6`+`445e2e0`+`4805511`（T3）/ `7af792f`（T4）/ `b6e091b`+`5697b3c`（must_change）/ T5 / T6 / T7；§6.2 列草案→实现差异（改密三字段、`X-Kore-Password-Hint` 响应头、captcha 双通道、`attempts=1`、审计 reason 细分、修订范围收敛）；§6.3 各卡命令 + 退出码原文口径；§6.4 未验证项。
  - §7 append-only 修订映射表，逐文件写明追加位置与要点。

### 2.2 append-only 下游修订

| 文件 | 新节 | 核心口径 |
| --- | --- | --- |
| [ADR-0043](../../docs/DECISIONS/0043-login-gate-vs-passwordless-ops.md) | §7 | 「单管理员、无用户名」覆盖为「单账号 `admin` + 口令」；登录门 / UDS 不跳过 / 7 天会话 / root 免密不变；凭据两行 + must_change 降级；复审追加「多账号 → G-11 退回」 |
| [ADR-0055](../../docs/DECISIONS/0055-initial-admin-credential.md) | §8.7 | §8.5 的 draft 待落地更正为已落地；首登强制改密→可选提示；凭据两行（占位）；老文件包装 + `.legacy` + 不重置口令；更新安装绝不覆盖不变 |
| [docs/SECURITY.md](../../docs/SECURITY.md) | §16 | 账号纳入凭据边界（标识符非秘密、0600 config、不进 state.db / 日志 / 审计）；§3.2「无用户名」覆盖、§3.5 宽容 5→1；captcha 生成 / challenge / 校验顺序 / 延时 / 审计；PBKDF2 复审条件不变 |
| [docs/CORE.md](../../docs/CORE.md) | §12 | `auth.admin_username` 显式 string + 冷字段 + `attempts=1`；登录 / 改密 body 增 `username`；新增 `GET /api/v1/auth/captcha` 与 428/401/429；**端点 70→71**（新增 captcha 1 条，login/password 为 body 扩展不增路由） |
| [docs/USABILITY.md](../../docs/USABILITY.md) | §9 | 账号预填「已自动检测」、三标签白话、验证码 / 延时 / 账号错文案、改密提示可关闭；四问自检更新；G-28 双端证据指向已提交截图 |
| [QUICKSTART.md](../../QUICKSTART.md) | 附录 B | 登录页怎么填（账号默认 admin + 密码）；两行凭据文件示例（`password: <placeholder>`）；密码错后验证码 / 换一张 / 文本题 / 延时 / 账号错的白话对照 |

### 2.3 G-23 台账与交接

- [.agents/LOG/DECISIONS.md](../LOG/DECISIONS.md) 追加 1 行：五维多选一 + 12 个选项逐条依据 + 被否决项（多账号 / 无用户名 / state.db 账号 / 短信验证码 / 外部服务 / TOTP / 强制闸门 / JSON 凭据）。
- [.agents/LOG/DISPATCH.md](../LOG/DISPATCH.md) 追加 8 行：T1 / T2 / T3 / T4 / must_change / T5 / T6 / T7，字段为时间 / task / owner / 写域 / 依赖 / 交付 / commit / 状态。
- [.agents/HANDOFF.md](../HANDOFF.md) 追加「T7 收口快照」：交付清单、三门禁、残留边界（must_change 非闸门、系统级 root 服务与远端同步需授权、未验证项、G-11 边界）。

## 3. 门禁证据（命令 + 退出码）

> 命令均在 `/home/pt/Work/GolandProjects/kore-pl/kore` 下执行；本卡未跑 Go 编译 / 测试（写域只有文档），实现侧证据由各实现卡报告提供，不冒充复跑。

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `make docs-check` | **0** | `docs-check: 5 pass, 1 warn, 0 fail` / `结果: 门禁通过（1 WARN 不阻断）`；唯一 WARN 是 `docs/CORE.md:413` / `docs/SECURITY.md:495` 超出 100–400 行（append 型真源，AGENTS.md §7 允许，不阻断）；1059 条相对链接全可达；元信息 / 占位词 / 关键口径全绿 |
| 2 | `make secret-check` | **0** | `secret-check: 0 FAIL / 23 处匹配（占位写法均合规）` |
| 3 | `bash scripts/log-check.sh` | **0** | `log-check: 8 pass, 0 warn`；DECISIONS 条目 108 ≥10、DISPATCH 96 ≥10、sessions 3/3 合规 |

> **过程记录**：初次跑 docs-check 时因本报告尚未创建，ADR-0057 §6 指向本报告的 2 条相对链接断链 → exit 1（4 pass / 0 warn / 1 fail）。本报告落盘后重跑即 exit 0；未通过删链接或放宽门禁规避。account-ui 也独立观察到同一断链并确认属本卡写域、未代改。

## 4. 实现侧证据（引自各卡报告，非本卡复跑）

| 卡 / commit | 报告原文命令 + 退出码 |
| --- | --- |
| T1 `b1f7e59` / T2 `ee724d5` / T3 `b5480a6` | [account-t123.md](account-t123.md) §5：`go test -count=1 -timeout 200s ./internal/core/config/... ./internal/core/auth/...` exit 0；`go test ./cmd/kored/...` exit 0；`go vet ./...` exit 0；`go test ./...` 17 包全 ok；`node --check web/app.js` exit 0；`secret-check` / `docs-check` exit 0。隔离实例 18887：新装 admin+正确口令 200 / 错账号 401 / 错口令 401；18888：老单行凭据升级后两行 0600 且原口令 200。§10 接手复核独立复跑门禁与隔离实例 18899/18898 均通过 |
| T4 `7af792f` | [account-t4-bruteforce.md](account-t4-bruteforce.md) §2：`go vet` auth/httpapi/cmd 三包 exit 0；`go test` auth/httpapi exit 0（auth ok 1.175s / httpapi ok 4.725s）；`config` exit 0；`node --check web/app.js` exit 0；`secret-check` / `docs-check` exit 0。§3 隔离实例 8899：首次错口令 401 → captcha 200（字段 `captcha_id/image/text_question/expires_in`）→ 缺 428 → 正确 200 → 再错 429 + `Retry-After: 2` |
| T5 `9aa08cb` / T6 `82c69bd` | [account-t5-ui.md](account-t5-ui.md)：`node --check web/app.js` exit 0；`make frontend` exit 0（首屏 87258 B ≤ 300 KiB）；`secret-check` / `docs-check` exit 0；隔离实例真浏览器 5 状态实测，5 张双端截图。[account-t6-password.md](account-t6-password.md)：`go vet ./...` exit 0；`go test ./...` 16 包 ok；`node --check` web/settings.js 与 dist 双 exit 0；`diff -q` 逐字一致；`secret-check` exit 0；隔离实例 400/403/200/旧会话 401/新口令 200/凭据删除 cred_after=no。**两笔 commit 已在 T7 后落盘，DISPATCH / ADR §6.1 / HANDOFF 的 commit 列已由 scribe 回填** |
| G-28 双端 | [account-t123.md](account-t123.md) §6：`login-account-desktop-01.png`（PNG 1440×900）/ `login-account-mobile-01.png`（390×844），不同 viewport 非同图缩放；三问自评「可用」 |

## 5. G-11 六项不做 + 附加门禁自检

| 判据 | 本 ADR / 本卡结论 |
| --- | --- |
| G-11 多用户 RBAC | **不命中**：固定单账号 `admin`，无用户表 / 角色 / 权限组 / 授权表 / 用户枚举 / 账号管理 API；账号错与口令错同文案防枚举 |
| G-11 集群 / 多机、模板市场、云存储深度集成、拖拽建站、多语言全量框架 | 均不命中；challenge 只在进程内存，文案仅中文白话 |
| G-02 依赖白名单 | 零新依赖：验证码走 stdlib `image/png` + 内嵌点阵字形，无字体文件、无第三方包 |
| G-10 无联网 / 遥测 | 本地生成验证码，无短信 / 邮件 / 外部服务，challenge 不回传 |
| G-19 空闲行为 | 无新增 ticker / AfterFunc / 后台 goroutine，challenge 只按调用路径惰性清理 |
| G-24 无 any / object 逃逸 | 登录 / 改密 / captcha 请求与响应全部显式字段（G-24） |
| G-28 双端证据 | T3 PC + 手机双端截图已提交；T4 报告如实标注「验证码展开态截图被并发清理误删，以 T3 截图 + HTTP 真链路断言为准」，不伪造、不 revert |
| G-29 运行态 | 本卡未碰任何运行态资产；实现卡均用隔离实例，非 TTY 不打印明文 |
| G-30 明文凭据 | 本卡文档 / 报告口令位置一律 `<placeholder>` / `<REDACTED>`；`secret-check` 0 FAIL |
| G-06 / G-23 文档同步 | 六份下游文档 + 两本台账 + HANDOFF 同轮同步；第 4 节残留一条写域外计数漂移，已上报 lead |

## 6. 未验证项与残留

1. **未复跑 Go 编译 / 测试 / gate**：本卡写域只有文档，未执行任何 Go 命令；第 4 节实现侧命令原文来自各实现报告，不冒充独立复跑（G-09 implementer ≠ verifier）。
2. **端点计数跨文件漂移（已按 lead 扩域批准同轮收口）**：`docs/CORE.md` §12 按实现把业务 / store 端点数改为 **71**（新增 `GET /api/v1/auth/captcha`）；发现根 `AGENTS.md` §6 与 `README.md` 文档表仍写 **70** 后上报 lead，获**扩域批准**（G-06 硬门禁，属 T7 分内事），已同步两文件为 **71（64 业务 + 7 store）**并纳入本卡精确 pathspec commit；只改端点计数口径与必要引用文字，未动其它段落与门禁判据。`make docs-check` 不检查该数字，门禁 exit 0，但 G-06 口径要求同检查点同步——已满足。
3. **T5 / T6 commit 回填（已收口）**：本报告首版落盘时 T5/T6 仍在验证，DISPATCH 以「见各自报告」占位；随后 T5 `9aa08cb`、T6 `82c69bd` 落盘，scribe 以追加小提交回填 DISPATCH / ADR §6.1 / HANDOFF / 本报告的 commit 列，未改任何实现代码或他人报告。
4. 真实 systemd 下验证码 challenge 跨进程重启行为（按内存态设计、G-29 未碰主实例）；Gitea Actions 服务端启用 / act_runner 注册——同为 ADR-0056 残留 human gate，本卡不验证、不执行。

## 7. 纪律声明与一句话结论

本卡全程只写文档 / 台账与本报告；commit 用精确 pathspec + `[agent:account-docs]` 前缀，**未 push、未触发 CI、未改代码或运行态、未读取或打印任何真实凭据**；一次性临时文件已删；既有文档 append-only，历史正文零删除。

**ADR-0057 已 accepted 正式落盘，六份下游文档 + AGENTS.md / README.md 端点计数 70→71 同步 + G-23 台账 + HANDOFF 快照同轮收口，docs-check / secret-check / log-check 三条门禁均 exit 0；T5/T6 commit 已回填，残留仅为两项服务端前置未验证项。**
