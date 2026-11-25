# SSH 防护（ssh-guard）：封禁可视化 · 白名单自保 · 攻击来源统计

> 元信息: 2026-11-25T12:26+08:00 · 执行者 feat-sshguard-security · 隔离实例 `127.0.0.1:18881`（`--config .tmp-sg/config.yaml`，state/run/log 全在 `.tmp-sg`）· 主实例 8787 **零请求零写入** · 插件 0.3.1 → 0.4.0

## 0. 结论

补的是**缺口**不是重做：审计发现三处真实缺口——① `ban.list` 是硬编码空桩（`handleBanList` 恒返回空数组），② 没有任何白名单能力（fail2ban 封的就是"来源 IP"，管理员出口 IP 同维度 → 一次误封把自己锁在门外），③ `attempts` 只按 IP/小时聚合、没有失败类型。本轮三者都已落地，并顺手修掉两个让页面**整块不可用**的既有前端 bug（见 §1.5）。

## 1. 交付（用户可见）

| # | 用户看到的能力 | 依据（path:line） |
| --- | --- | --- |
| 1.1 | **封禁清单真实化**：每条给出 IP / 来源（fail2ban 封禁 or 日志推断）/ 触发规则 / 封禁时间（观测或推断，推断显式标注）/ 剩余时长 / 是否在白名单；支持地址精确过滤与 `limit/offset` 分页 | `kore-plugin-ssh-guard/banview.go:39`（collectBanItems）、`:96`（buildBanItem）、`:139`（applyRemaining）、`:153`（handleBanList） |
| 1.2 | **白名单自保**：`whitelist` 读现状 + 「你最近一次 SSH 登录的 IP」候选；`whitelist.add`/`whitelist.remove` 落盘到插件数据目录（`KORE_PLUGIN_DATA`，0600 原子写）；**封禁入口前置拒绝白名单 IP**（E_CONFLICT，命令根本不下发到提权通道） | `kore-plugin-ssh-guard/banview.go:208/255/322`、`ledger.go:135`（持久化）、`methods.go`（handleBanWrite 白名单前置门） |
| 1.3 | **攻击来源统计**：失败类型分布（密码认证失败 / 用户名探测 / 重复认证超限）+ 次数 + 占比；「最近成功登录的 IP」候选（含最后登录时间与次数） | `kore-plugin-ssh-guard/logscan.go:165`（buildKindCounts）、`:272`（indexIPFacts）、`:303`（loginCandidates） |
| 1.4 | **页面**：白名单面板（当前 IP 判定 + 明确提示 + 二次确认 + 自锁告警一键解封 + 手动添加）；封禁名单新列（来源/触发规则/封禁时间/剩余时长）+ 全选/批量解封；批量封禁（一行一个）+ 封禁时长预设（10 分钟 / 1 小时 / 1 天）；失败类型横条 | `kore/web/sshguard.js:446`（paintWhitelist）、`:584`（paintBans）、`:715`（submitBan 批量）、`:791`（unbanMany）、`:818`（saveBantime）、`:141`（kindBars） |
| 1.5 | **修既有 P1 前端 bug**（本轮实测复现）：`API` 常量缺域前缀 → `ban.list`/`whitelist.add`/`config.get` 全部 400 E_INVALID（内核 `handlers_invoke.go:81` 要求点分方法的域 == 插件 id）；`sinceISO()` 用 `toISOString()` 带毫秒 → `attempts` 每次 400（Go `time.Parse(time.RFC3339)` 严格拒毫秒）→ 「最近 24 小时 / 7 天」统计块长期不可用 | `kore/web/sshguard.js:21`、`:sinceISO` |

## 2. 真机证据（隔离实例，非主实例）

| 项 | 命令 / 交互 | 结果 |
| --- | --- | --- |
| 装包 | `kored install --package ssh-guard-0.4.0.tar.gz --config .tmp-sg/config.yaml` | `installed ssh-guard 0.4.0`（rc=0） |
| 白名单拒绝封禁（防误封核心） | `POST /invoke/ssh-guard/ssh-guard.ban.add {"ip":"198.51.100.20"}` | **http=409** `{"code":"E_CONFLICT","message":"ban.add 被拒绝：198.51.100.20 在白名单里（防误封），未执行任何命令"…}` |
| 非白名单仍走提权通道 | 同上换 `203.0.113.7` | **http=403** `E_NEED_ROOT`（fail-closed，带可操作 hint） |
| 封禁时长写入 | `POST …config.set {"bantime_s":3600}` | 回读 `bantime_s:3600`（剩余时长据此推算，未填则留空不编造） |
| 白名单读 | `POST …ssh-guard.whitelist {}` | `current_ip:"198.51.100.20"`、`candidates:[{ip,last_seen,success:2}]`、`persisted:true` |
| 页面真机点击（chromium headless 156 + 裸 CDP） | 打开 `#/security/sshguard` → 点「把 198.51.100.20 加入白名单」→ 确认框原文「确定把 198.51.100.20 加入白名单？…加入后这个 IP 不会再被本页封禁」→ 点「确认加入」 | 状态由 `不在白名单` → `已在白名单`，提示「已加入白名单 198.51.100.20（这个地址不会再被封禁）」 |
| 页面结构断言 | CDP `Runtime.evaluate` | `ban_rows:2`、`ban_headers:["","IP 地址","来源","触发规则","封禁时间","剩余时长","操作"]`、`kind_rows:3`、`bulk_btn:"批量解封"`、`page_errors: 仅登录前 401（boot 探测）` |
| 手机端 | 390×844 视口 + 触摸仿真 | `document.scrollWidth=390=clientWidth`，无溢出元素；宽表在 ≤639px 拆成「标签 + 值」卡片 |

## 3. 门禁（命令 + 退出码）

- 插件仓 `make check`：`gofmt: clean` / `go vet ./...` / `go test -timeout 200s ./...` → `ok github.com/pengtang1024/kore-plugin-ssh-guard 0.042s` + `ok …/tests/fault 3.611s`，**exit 0**（含新增 `whitelist_test.go` 6 个用例：持久化/幂等/白名单拒绝/候选 IP/清单富化/fail2ban 剩余时长/失败类型）
- 主壳 `node --check web/sshguard.js` → exit 0；`make frontend` → `首屏合计 81528 字节 / 预算 307200`（exit 0，首屏未受影响：sshguard 是懒加载视图）
- `make secret-check` → exit 0；`bash scripts/usability-check.sh` → ssh-guard **无新增违规**（仅存量 `A2 ssh-guard` presets WARN）
- `git status --short`：两仓均只有本轮写域文件（`web/sshguard.js`、`.agents/verify/sshguard-security.md` 与 6 张截图；插件仓 8 个文件）

## 4. G-28 双端截图（`file`/`PIL` 实测宽高）

| 文件 | 实测 | 内容 |
| --- | --- | --- |
| `screenshots/sshguard-security-desktop.png` | 1440×2878 | 整页：状态 / 失败类型分布 / 白名单 / 封禁名单 / 批量封禁 / 加固建议 |
| `screenshots/sshguard-security-desktop-viewport.png` | 1440×900 | 视口尺寸（G-28 的 1440×900 口径） |
| `screenshots/sshguard-security-mobile.png` | 390×4852 | 手机整页：单列堆叠 + 宽表卡片化 |
| `screenshots/sshguard-security-mobile-viewport.png` | 390×844 | 手机视口 |
| `screenshots/sshguard-security-wl-confirm-desktop.png` | 1440×2991 | 白名单二次确认态（明确提示"加入后不会再被封禁"） |
| `screenshots/sshguard-security-wl-added-desktop.png` | 1440×2791 | 加入后：chip 变「已在白名单」+ 成功文案 |

**产品定位自评三问**

1. **解决什么用户问题**：装过 ssh-guard 的人只能看到"谁在试密码"，看不到"谁被封了、为什么封、还剩多久"，更没法一键把自己排除在外——本页把「看见封禁 → 判断误封 → 解封/加白」这条闭环补齐，白名单让"封禁操作"从"可能把自己锁死"变成"有护栏"。
2. **与宝塔 / 1Panel 的差距**：宝塔的 fail2ban 面板能配 jail 参数（bantime/maxretry 直接改配置并重启 fail2ban），本页**只读宿主的 bantime**（运维填秒数才能算剩余时长）——因为 `fail2ban-client get <jail> bantime` 不在内核提权形状表（ADR-0022）内，加形状要改 `pkg/pluginapi` + ADR + SDK 发版，超出本轮写域；也**没有"封禁时长下拉直接写 fail2ban 配置"**（零侵入口径下不写宿主机配置文件）。
3. **当前「可用」还是「占位」**：**可用（分级）**。统计、白名单、封禁清单、页面交互都已在隔离实例真机跑通；**真实封禁/解封执行**在本机无真机证据（宿主未装 fail2ban，页面因此进只读态并明确说缺什么），该路径由后端单测覆盖（E_NEED_ROOT / E_CONFLICT / 回读校验）。

## 5. 已知边界与未验证

- **真封禁/解封未真机验证**：本机无 `/usr/bin/fail2ban-client`，隔离实例进只读态；`ban.add`/`ban.remove` 的提权执行由 `banwrite_test.go` 的 fake 通道覆盖，真机需在装 fail2ban 且 root 启动 kored 的机器上复跑。
- **剩余时长依赖人工填 bantime**：插件读不到宿主 `bantime`（形状表限制），未填时 `remaining_s` 为 null、页面显示「未知（填「封禁时长」后可算）」，**不编造到期时间**。
- **版本已 bump 到 0.4.0**，`kore-plugins` 索引 / presets / release 需在发版批次同步（`make store-check` 会以 `DIST_SHA_DIFF` WARN 记录，不阻断）；`make dist` 已在本地重建 `dist/ssh-guard-0.4.0.tar.gz`（sha256 `6aa254488e62ce0416156659b62a87c1824a90a1be7d9a9a40740d88f6195a5e`，`dist/` 与 `bin/` 均 gitignore）。
- **`scripts/usability-pending.txt` 的 `A1 ssh-guard` 条目已过期**（插件 `zeroparam_test.go` 让 A1 通过），但该文件是他人未提交改动（`M`）+ 该测试文件本身 untracked，本轮**未纳入**、未修改 pending 清单。

## 6. 运行态与清理（G-29）

- **本轮未改动主实例运行态配置**：未碰 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`，未重启 8787；所有验证在 `.tmp-sg` 隔离实例（18881）内完成。
- 临时物：`.tmp-sg/`（隔离 config/state/run/log/截图/合成 auth.log）与 chromium 临时 profile 全部删除；隔离 `kored` 与 headless shell 进程已 kill，无残留监听。
- 一次性管理员口令只在隔离实例内、随目录删除失效，未写入任何文档或提交。
