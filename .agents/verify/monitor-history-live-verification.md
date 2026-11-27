# 监控历史 P3 真机复验报告 · 独立验收（G-09）

> 2026-11-27 19:04–19:12 +08:00 · verifier `monitor-history-live-verifier`（独立于 `monitor-history-live`，G-09 不兼任）· task-210。
> 复核对象：`027349c254d48c4d4df5910252460b1c802421a4` 单文件提交 `.agents/verify/monitor-history-live.md`（134 行）。
> 纪律：只读复核；唯一写入 = 本报告；不 push、不联网、不启停服务、不碰主实例、不写 `.kore-local-*`（仅 `sha256sum` / `stat` 只读回读）。真机断言在「不启停服务 / 不碰实例」约束下不可重跑，故本验收＝**证据数字自洽复算 + 源码/DESIGN 静态对读 + git 形态核查**，不冒充独立真机复跑。

## 总评：**PASS**

五项断言的报告数字全部自洽，源码/DESIGN 对读支持其证据链；三项口径偏差、降权未验、secret-check 均如实标注；git 提交形态合规。另有 4 条**非阻断**表述/行号精度提示（§5），不构成证据不成立或数字不自洽，不报 BLOCKED。

---

## 1. 核心数字自洽复算（逐项）

复算命令：`python3`（标准库 `json` / `datetime`）+ 只读 `git`/`grep`/`sha256sum`/`stat`/`make secret-check`。每项均给出报告值 → 复算值 → 判定。

| 项 | 报告原文值 | 独立复算 | 判定 |
| --- | --- | --- | --- |
| 采样 ts 间隔 | `30021` / `30004 ms`（§4 行 79） | `1795777203773-1795777173752=30021`；`1795777233777-1795777203773=30004` | PASS |
| 三点落盘时刻 | §4 表 18:59:35 / 19:00:05 / 19:00:35（poll 观察点） | ts 换算 +08：18:59:33.752 / 19:00:03.773 / 19:00:33.777；5s 轮询首次可见即 18:59:35 / 19:00:05 / 19:00:35 | PASS |
| 文件字节 161/266/369 B | §4 表 + `stat ... 600 pt 369`（行 60/62/64/71） | JSON 无换行 len=160/265/368；`history.go:186` 明写 `tmp.Write(append(data,'\n'))`，+1 尾换行 ⇒ **161/266/369** | PASS |
| 3 次运行↔3 落点一一对应 | runs `status=ok` ×3、`dur_ms=201/202/210`（§4 行 83-85） | run started_at→ms：1795777173747 / 1795777203773 / 1795777233777，对照 sample ts 偏移 **+5/0/0 ms** ⇒ 同三次到点一一对应；ok×3、201/202/210 为运行记录原文（无法离线重跑，按证据原文核） | PASS |
| `next_run_at` 自洽 | 创建 18:58:34.978622189、next 18:59:04.978622189（§3 行 44、§4 行 55） | `(next-created).total_seconds()=30.0` = `interval_s=30`；调度下限 `task.go:43 minIntervalS=30` 对读成立 | PASS |
| 今天档分桶 | `today buckets=2 rawCount=3 bucketMs=300000 cpu=[7.98,7.29] ts=10:55/11:00Z`（§5 行 98-100） | `now=1795777265708`=19:01:05.708+08；today 起点 1795708800000=本地日界 11-27 00:00+08；5min 桶 keys=10:55/11:00Z，**每桶末值** cpu=[7.98,7.29]（均值会是 [7.98,8.875]，报告取末值正确） | PASS |
| 7 天档分桶 | `week buckets=2 rawCount=3 bucketMs=3600000 cpu=[7.98,7.29] ts=10:00/11:00Z`（§5 行 99-100） | week 起点 = now−7×86400000=1795172465708；1h 桶 keys=10:00/11:00Z，末值 cpu=[7.98,7.29] | PASS |
| 分桶末值语义 | 报告称「每桶取末值，不造伪均值」 | `web/monitor.js:434-438` `lastByBucket[key]=idx`（后写覆盖）＋ `:445` 按 idx 取列值；报告复算与真实纯函数实现一致 | PASS |
| 默认态仅 2 内置任务 | `builtin-audit-clean` + `builtin-logs-maintain`，无 monitor.sample（§2 行 30） | `scheduler.go:Start` 同步 4 类内置任务；`updatecheck.go:97` 默认不落任务、`certrenew.go` 仅在 `certEnabled` 时落 ⇒ 默认恰 2 条，静态对读成立 | PASS |
| 未登录 401 / 建任务 200 | §2「未登录 401」、§3 `HTTP_CODE=200`（行 30/44） | `middleware.go:24/62` 无会话 401；`handlers_scheduler.go:104 writeJSON(w,http.StatusOK,task)` 确实 200（非 201） | PASS |
| secret-check 无明文 | 任务卡要求 exit 0 | `make secret-check` → `[RUN ] secret-check` / `secret-check: 0 FAIL / 23 处匹配（占位写法均合规）`，`SECRET_EXIT=0` | PASS |
| 主配置/state 未污染 | sha `9d5de744…43bd56e`、state.db mtime `1795766210`（行 20-21/112-113） | 只读复算当前 `sha256sum .kore-local.yaml` = `9d5de744…43bd56e`；`stat -c %Y` = `1795766210`，与报告基线逐字一致 | PASS |
| 临时资产删净 | §6 行 116 称随 `.tmp-mlive/` 全删 | 当前 `.agents/verify/.tmp-mlive` **GONE**；`.gitignore:81` 有 `.agents/verify/.tmp-*/`。注：任务卡「171M」数字未写入报告正文，报告只声明「配置/state/run/log、cookie jar、响应临时文件、编译缓存与一次性脚本全删」，本轮只能核「残留不存在」，删前体积不可追溯复核 | PASS（口径见注） |

补充：running 时 `pid=74`、`ss` 出站 0、`kill 74` 后 pid gone / 55119 无监听 / 8787 healthz 200 等条目为**本机隔离实例的运行时原文**，在「不启停服务、不碰实例」约束下不可复跑，本报告仅核其命令+退出码+输出原文与报告内部一致性；verifier 未对 8787 发任何请求。报告 §5 对「无 headless 浏览器、造不出跨天数据、不伪造」的诚实边界成立。

## 2. 三项口径偏差的诚实性

| # | 报告标注 | 独立对读 | 判定 |
| --- | --- | --- | --- |
| 1 POST 200 vs 任务卡 201 | §3 行 47 标「口径偏差 1（非缺陷）」，指任务卡笔误、报 lead 另派文档卡，**未自行改** | `handlers_scheduler.go:104` 确为 `StatusOK`；全仓 scheduler 写端点同口径 | PASS |
| 2 history.json 路径 | §4 行 53 / §7 行 123 标「口径偏差 2（非缺陷）」，真实落点 `<iso>/state/plugins/monitor/history.json`，建议修 DESIGN §3.2 / 帮助文案，**未自行改** | `start.go:83 stateDir=filepath.Dir(inst.manifest.Dir)` + `:169 KORE_STATE_DIR=stateDir`；`registry/manifest.go:224 PluginDir=root/id/version` ⇒ `<iso>/state/plugins/monitor/0.6.0` 的父目录即 `<iso>/state/plugins/monitor`；`history.go:63-68 filepath.Join(stateDir,"history.json")` ⇒ 路径链闭合。DESIGN §3.2 行 81 确实写「state 根目录」 | PASS（行号精度见 §5-2） |
| 3 离线 install 需 enable | §3 行 39 / §7 行 124 标「操作口径（非缺陷）」，原文 `E_CONFLICT: 插件 monitor 未启用，请先 POST …/enable`，如实记录供正式使用时照做，**未改内核** | `registry/catalog.go:16 StateInstalled`=已安装未启用；`cmd/kored/serve_daemon_actions.go:99-103` 生成逐字一致的错误文案 | PASS（代码位置见 §5-3） |
| 降权写权限五步 | §4 行 73 / §7 后段明确「本轮未做（kored 非 root，降权未生效），0600/属主 pt 是非降权路径，不冒充降权已验」，留后续卡 | DESIGN §3.2 行 81-85 / §5 行 146 确要求五步且判 FAIL 回退；报告未把未验项写成 PASS | PASS |
| secret-check | 报告未单列，但任务卡要求 exit 0、无明文 | 独立运行 exit 0 / 0 FAIL，报告文件本身无明文凭据 | PASS |

## 3. git 形态（027349c）

```
git rev-parse HEAD                    → 027349c254d48c4d4df5910252460b1c802421a4        (exit 0)
git show --stat --format=fuller 027349c → 1 file changed, 134 insertions(+)；仅 .agents/verify/monitor-history-live.md
git show -s --format='%(trailers:key=Signed-off-by,valueonly)' → pengtang1024 <pengtang1024@qq.com>
git log -1 --format='%s'              → [agent:monitor-history-live] docs(verify): …（agent 前缀合规）
git branch -a --contains 027349c      → 仅 * main
git merge-base --is-ancestor 027349c refs/remotes/{origin,gitea,github,gitee}/main → 全部 NOT-CONTAINS（未 push）
git worktree list                     → 仅 1 行主树 /home/pt/Work/GolandProjects/kore-pl/kore
git branch --list 'wt-*' 'tmp-*'      → 空
git status --porcelain                → M scripts/usability-pending.txt + 若干未跟踪文件（他人 dirty），均未进入本提交
```

判定：精确单文件 + DCO（Signed-off-by）+ agent 前缀 + 未 push + worktree 仅主树 + 无临时分支 + 他人 dirty 原样，**PASS**。本 verifier 提交亦只写自身报告路径，不触碰上述他人文件。

## 4. 复核边界（不可复跑项如实声明）

真机断言 ①–⑤ 的「命令 + 退出码 + 原文」在报告中齐备，但 verifier 受「不启停服务 / 不碰主实例 / 不联网」约束**未独立重跑**该真机过程：本验收是对报告证据的**数字复算与静态对读**，不是第二遍真机复验。报告对「浏览器 DOM 未做、跨天数据不伪造、降权五步未做、POST 200 vs 201 是卡面笔误」均主动标注而非掩盖，诚实性成立。

## 5. 非阻断精度提示（不影响 PASS）

1. §4 行 67「首点到点比 `next_run_at` 晚约 60s」：按 ts 复算，首点 18:59:33.752 − `next_run_at` 18:59:04.978 ≈ **29s**（poll 首见 18:59:35 ≈ 30s）；60s 是从**任务创建** 18:58:34.978 起算的解释性口径，表述与锚点不一致，建议后续文档卡改为「比 next_run_at 晚约 30s / 比创建晚约 60s」。非核心断言，证据数字本身自洽。
2. §4 行 53 与 §7 行 123 引 `supervisor/start.go:76,169`：复对当前源码，`KORE_STATE_DIR=stateDir` 确在 `:169`，但 `stateDir := filepath.Dir(inst.manifest.Dir)` 在 **`:83`**（`:76` 是 `}`）。路径机制属实，行号 76 应更正为 83。另 DESIGN §3.2 行 81 的 `<state>` 指注入的 `KORE_STATE_DIR` 本身（=插件状态目录），其「落 state 根」描述在变量语义上自洽，报告标「DESIGN 写错」略偏严；真正缺口是用户文案把「state 根」误解为 `<iso>/state`，仍属文档口径问题、非产品缺陷。
3. §7 行 124 把 E_CONFLICT 出处写为 `cmd/kored/install.go`（安装只注册）+「scheduler 到点执行鉴权」：逐字报错实际由 `cmd/kored/serve_daemon_actions.go:99-103` 的 `daemon.Invoke` 未启用守卫生成，安装侧对应 `registry/catalog.go:16 StateInstalled`。机制属实，代码位置可更精确。
4. 任务卡「临时资产删净 171M」的体积数字未出现在报告正文；本轮只能核「`.tmp-mlive/` 已不存在」，删前 171M 不可追溯复算，勿把该数字当作 verifier 已复核值。

## 6. 结论与交付

**总评 PASS（G-09 独立验收通过）**：027349c 的五项真机断言证据数字自洽、三项口径偏差与降权未验如实标注、secret-check exit 0、git 形态合规；4 条精度提示属表述/行号层面，不触发 BLOCKED。建议 lead 另派文档卡处理 §5（卡面 201、DESIGN 路径文案、安装引导、行数/行号与 60s 表述），本 verifier 未改任何产品代码或文档，未 push。

**提交**：`git add -- .agents/verify/monitor-history-live-verification.md` + `git commit -s -m "[agent:monitor-history-live-verifier] docs(verify): P3 真机复验独立验收（数字自洽/口径诚实/git 合规，PASS）" -- .agents/verify/monitor-history-live-verification.md`；不 push。
