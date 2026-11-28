> 任务: task-351 ｜ 角色: G-09 独立 verifier（非 implementer `competitor-bt`）｜ 日期: 2026-11-28（Asia/Shanghai）
> 被验收对象: `competitor-bt` 一手实测报告 `e3f5337`（`e3f53370c19018d4a3e0a3f849818e01c8b91bdf`，单文件 239 行）
> 性质: 只读复核。不 pull / 不装 / 不跑容器 / 不联网业务 / 不碰 8787、`.kore-local-*`、宿主。
> 唯一写域: 本文件。所有结论均来自 `read` / `grep` / git 只读查询 / `make secret-check`（只读扫描）。

# 宝塔真机实测独立验收报告

## 总评：FAIL（BLOCKED）

六个核心维度中五个成立、证据充分；但复核发现 **一处确定性数字不自洽（§2.4）**，且 **fd 超 64 的定性偏轻（§5）**。按 task-351 硬纪律「任一不自洽或夸大报 BLOCKED / 真红线突破如实标需另派修复」，判 BLOCKED。两项均为可定点修复项，不推翻报告的一手采集事实本身。

- 结论 A（一手数据真实性）：**成立** — 采集口径、命令、退出码、原文数字齐备且互相印证。
- 结论 B（口径诚实 / 不作超越断言 / 双口径 / 官方数字不混排）：**成立**。
- 结论 C（fd≤64 判定）：**kore 主壳 fd 79/82 真实突破 G-03 硬红线**；报告如实记录数值但定性为「偏差 / 需专项分析原因」，应升级为「硬红线突破（判未完成级）+ 另派修复专项」。

---

## 0. 验收前置与只读纪律自检

```
$ git rev-parse HEAD
  e3f53370c19018d4a3e0a3f849818e01c8b91bdf
$ git show --numstat --format='%h %s' e3f5337
  239  0  .agents/verify/competitor-bt-live.md
$ git show -s --format='%B' e3f5337
  [agent:competitor-bt] docs(verify): 宝塔官方镜像隔离容器真机同口径实测（一手数据/不作超越断言）
  Signed-off-by: pengtang1024 <pengtang1024@qq.com>
```

本轮未执行任何写操作（除本报告），未 pull / 未装包 / 未起容器 / 未访问官方网页 / 未触碰主实例与宿主。

---

## 1. 前置 + 清理（PASS）

| 项 | 报告原文位置 | 本轮只读回读 | 判定 |
| --- | --- | --- | --- |
| 镜像 digest `sha256:12d72112…` | :48 pull.log 摘录 | 报告内自洽（digest 与 task-350 指定一致） | PASS |
| pull 61.339s / 镜像 2.56GB | :43 / :58 | 数值与结论 :198 一致 | PASS |
| 容器 `bt-bench-r54` + 独立 bridge + `127.0.0.1:18888:8888`（未 `--net=host`） | :14-16 | 报告明示「**未用 --net=host**」、独立 subnet `172.31.254.0/24` | PASS |
| 卷 `.bench-r54/`（工作区临时、非 /tmp）+ exclude 标记 | :17 | exclude 标记已删（见下） | PASS |
| 未碰 8787 / `.kore-local-*` / 宿主 80·443·8888·22 | :18-19 | 报告开工/收尾双回读；本轮无反向证据 | PASS |
| 清理：容器/网络删、目录 gone、exclude 标记删、harness 全删、端口 FREE | :205-237 | 见下方实测回读 | PASS |

本轮实测回读（收尾状态确实落地，非仅报告自述）：

```
$ grep -n "competitor-bt-r54\|\.bench-r54" .git/info/exclude
  NO MARKER (clean)
$ ls -ld /home/pt/Work/GolandProjects/kore-pl/.bench-r54
  No such file or directory
$ find /home/pt/Work/GolandProjects/kore-pl -maxdepth 4 \( -name 'sample-bt.sh' -o -name 'bt-ops.py' \
    -o -name 'bt-login2.py' -o -name 'kore_enable.py' \) -print
  ALL ABSENT
$ for p in 18888 18890 18891; do ss -ltn | grep -q ":$p " && echo "$p BUSY" || echo "$p FREE"; done
  18888 FREE / 18890 FREE / 18891 FREE
```

注：报告 :239 明确「镜像保留在 docker 缓存、未 rmi」，理由（镜像非本轮临时资产、避免影响其他使用者）成立，不构成清理缺口。

---

## 2. 一手数据自洽

### 2.1 BT 首屏（PASS）
- 安全入口从容器内 `admin_path.pl` 读得 `/btpanel`（:73，mode 0600，9 bytes），**非猜测**；默认端口从 `port.pl` 读得 8888（:73）。PASS。
- 三次 HTTP200 / 30569 B / TTFB `0.058982 / 0.057579 / 0.024618 s`（:85-87）→ 结论 :198「TTFB 25–59ms」自洽。PASS。
- 非浏览器 UA / 未登记 IP 被 nginx 404（146 B，:78-81）如实记录为客户端指纹门行为（:75），未隐去。PASS。

### 2.2 BT 空载资源（PASS）
- `docker stats` 20 样本 min 149.1 / max 150.7 / **median 149.65 MiB**（:119）；主进程 VmRSS **81292 KiB（20/20 一致）**（:121）；CPU **2 ticks/60s**（:116）；fd **7**、线程 **1**、Uid 0/0/0/0（:123）。
- `check502Task` 任务期冲高 ~242.5 MiB / 100% CPU、任务后回落（:126）如实记录、未 cherry-pick。PASS。
- 81292 KiB = 79.39 MiB（binary）/ 81.29 MB（decimal），报告 :126「≈79.39 MiB」换算正确。PASS。

### 2.3 kore 隔离资源（PASS）
- 首屏 HTTP200 / 1551 B / TTFB 全 <2ms（:98-104）；主壳 VmRSS **14460 KiB（20/20）**、CPU 0 ticks/120s、fd **79**、线程 14（:139）；主壳+插件 **14840 + 6456 KiB**、主壳 fd **82**/线程 15、插件 fd **76**/线程 5（:146-147）；登录 0.084s / enable 0.022s（:169）。与结论 :199-200 一致。PASS。
- 14460 KiB = 14.12 MiB、14840 = 14.49 MiB、6456 = 6.30 MiB，均落在 G-03 红线（主壳 ≤16 MiB / 单插件 ≤24 MiB）内、未达 8/12 MiB 目标 —— 报告 :151 表述与结论一致。PASS。

### 2.4 数字不自洽（BLOCKED 项 A）
主壳行 TTFB 区间一致（:132「0.000780–0.001526s」= 原始样本 :99-100 的 0.000968/0.000780/0.001526 的 min/max ✓）。

但**主壳+插件行不一致**：

```
$ grep -n "0.000492\|0.000803\|0.001079" .agents/verify/competitor-bt-live.md
  102:  run1 http=200 bytes=1551 ttfb=0.001079s
  103:  run2 http=200 bytes=1551 ttfb=0.000803s
  133: | ... | 200 / 1551 B / 0.000492–0.002264s | ...   ← 汇总表
  104:  run3 http=200 bytes=1551 ttfb=0.002264s
```

汇总表 :133 写 TTFB 下限 **0.000492s**，但该实例原始三样本（:102-104）下限为 **0.000803s**；全文 `0.000492` 仅此一处、无第二组样本支撑，判为誊写错误。此项在同一报告内「汇总表 vs 原始样本」直接冲突，属 task-351 明令 BLOCKED 的「数字不自洽」。

影响面有限（0.3ms 量级，两端均 <2ms，不改变「首屏 TTFB<2ms」与任何结论），但按硬纪律必须定点修复：把 :133 的 `0.000492` 改为 `0.000803`，或补出 `0.000492` 的原始样本来源。

---

## 3. 典型操作 NOT VERIFIED 判定（PASS）

- BT 建站/建库/计划任务标 **NOT VERIFIED**（:157），如实给出两次登录被拒原文（`用户名或密码错误`，:162/:164），明确「未进行任何写操作」+ 只读回读 `vhost/nginx/` / `data/` / `crontab.db` 无副作用（:167），不猜测失败原因、不继续爆破。诚实、非伪造。PASS。
- kore 等价写操作（登录 + enable）已实测，且明确「不是同一业务动作，不横向比较耗时」（:169），口径诚实。PASS。

---

## 4. 安全默认（PASS）

- BT：root（Uid 0/0/0/0，:123/:177）、默认端口 8888（:178）、安全入口 `/btpanel` 镜像预置 mtime 2026-10-24 非首启随机（:179）、`default.pl` mode 0600 / size 9 / 明文但未读未打印、值均 `[REDACTED]`（:20/:180）、`users` 表 password len=32 前缀仅展示哈希前缀未打印全文（:180）、**未见首启强制改密如实记录**（:181）。PASS。
- kore：uid 1000（:177）、凭据 `state/initial-admin-credential` mode 0600 首启生成、日志只给路径不打印值（:180）、「建议改密非强制」（:181）。PASS。
- 全报告凭据仅 `[REDACTED]`，`make secret-check` 实跑 **0 FAIL / 35 处匹配（占位与 grep 正则片段）/ 1 WARN**（WARN 为他人文件 `backup-download-verification.md:125` 的既有匹配，与本轮无关）：
  ```
  $ make secret-check
    secret-check: 0 FAIL / 35 处匹配（占位写法 / grep 正则模式均合规，1 WARN）
    SECRET_RC=0
  ```
  PASS。

---

## 5. fd≤64 判定（重点，BLOCKED 项 B）

### 5.1 原文口径确认
- G-03（`AGENTS.md:39`）：资源预算**硬红线**含「fd ≤ 64」；违反后果「超硬红线判未完成」。
- ADR-0016（`docs/DECISIONS/0016-resource-budget-final.md:16-27`）预算表：`goroutine / fd / 出站 | ≤ 20 / ≤ 64 / 0 | —` —— **fd 目标列为「—」，即 fd 无目标档、纯硬红线**，不是「某形态预算/争取值」。
- 适用对象：`RESOURCE-MODEL.md:36`「空载 fd | 常驻 | ≤ 64 | 12–32 | 6 | `ls /proc/<pid>/fd | wc -l`」+ `scripts` idle 口径（G-19：空载 60s fd ≤ 64，按 `/proc/<pid>/fd`）—— **按主壳 kored 单 PID 计数**，不含常驻插件进程的 fd（插件 RSS 另有 ≤24 MiB 单独红线，fd 未给插件单列口径）。

### 5.2 判定
- kore **主壳** fd = **79**（shell-only，:139）/ **82**（主壳+插件场景，:147），两者均 **> 64**，且差距 15–18（远超「<10% 视为噪声」的容差）。这是**对主壳单 PID 硬红线的真实突破**，非噪声、非「含插件才超」——即使只算主壳（不含任何插件）也已越线。
- 插件进程 fd 76（:147）单看也 >64，但 G-03 fd 口径是主壳 PID；报告把「主壳+插件」混列不改变「主壳单独即越线」的结论。

### 5.3 对报告定性的裁决
报告 :151「kore 主壳 fd=79/82，高于仓库 G-03 文案的 64（本轮暴露的偏差，如实记录、不自行改代码）……原因需专项分析……本卡只报告观测值」，:201「偏差一条……已如实记录，不在本卡内修改生产代码」。

- **诚实性：成立** —— 数值如实、未夸大、未掩盖、未自行改代码（符合 verifier 与「不在本卡改生产」的边界）。
- **定性准确性：偏轻** —— G-03/ADR-0016 明确 fd≤64 是「超即判未完成」的硬红线，正确定性应为「**硬红线突破（判未完成级）+ 另派修复专项卡**」，而非仅「偏差 / 需专项分析原因」。报告把「已确认的硬红线突破（结果）」写成了「待查原因的偏差（过程）」，弱化了严重级别。
- 结论：**fd 确属真红线突破**。按 task-351「真红线突破如实标需另派修复」，本验收将其升级定性并建议 lead 另派 fd 专项卡（定位 bwrap/PID namespace 下 TCP+UDS 双监听的 fd 组成、给出收敛到 ≤64 的方案与复测）。报告数值本身可作为该专项的一手基线。

---

## 6. git 纪律（PASS）

```
$ git status --short
   M scripts/usability-pending.txt        ← 他人 dirty，原样未提交
  ?? .agents/.agents/  ?? .agents/verify/e2e-*.md  ?? .gocache-kore-0{14,15,16}/  ?? data/  ?? dist/ ...
$ git worktree list
  /home/pt/Work/GolandProjects/kore-pl/kore e3f5337 [main]   ← 仅主树
$ git branch -a --contains e3f5337   →  * main（仅本地 main）
$ for r in origin github gitee; do git rev-parse $r/main; done
  origin/main=212f979  github/main=212f979  gitee/main=212f979
$ git merge-base --is-ancestor e3f5337 origin/main → NOT ancestor (unpushed)
```

- 精确单文件 239 行（:239 与 numstat 239 一致）、`Signed-off-by` DCO 齐全、commit message 带 `[agent:competitor-bt]` 前缀。PASS。
- 未 push（三端 main 仍 212f979，不含 e3f5337）；worktree 仅主树；他人 dirty 原样。PASS。
- 被验收报告在 HEAD 处干净（`git status --short <file>` 无输出），无实现者事后改动。PASS。

---

## 7. 诚实口径总核（PASS）

- **不作超越断言**：报告标题/性质/结论反复声明「只给数据、不作全面超越断言」（:4/:196/:200），PASS。
- **架构不可比单列**（§8）：薄壳+插件 vs 单体自带 Nginx/MySQL/PHP、kore 不内置 web server（裁决37）、无同版本同硬件严格对齐、BT 指纹门影响可达性——均单列并禁排名。PASS。
- **RSS 双口径**：docker stats（cgroup 含缓存/全 PID）与 `/proc/<pid>/status VmRSS`（单进程）并列、取中位数、不以单一数字代表整体（:126/:191），PASS。
- **官方数字声明级不混排**（:5/:189）：BT「2000 万装机」、1Panel「94MB」明确标为官方网页声明、本次未装 1Panel、不与真机数据混排。PASS。

---

## 8. 发现项汇总与放行条件

| 编号 | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| A | BLOCKED | `:133` 主壳+插件 TTFB 下限写 `0.000492s`，与原始样本 `:102-104` 下限 `0.000803s` 不自洽 | 回派 `competitor-bt`：改为 `0.000803` 或补出 `0.000492` 样本来源，重新提交后复验 |
| B | 需升级定性 | kore 主壳 fd 79/82 突破 G-03 **硬红线**（非预算/目标），报告仅记「偏差/需专项」 | lead 另派 fd 修复专项；报告数值可作一手基线。此项为判定结论，不要求改报告数字，但严重级别须如实标注 |

其余前置、清理、一手数据主体、NOT VERIFIED、安全默认、git 纪律、诚实口径均 PASS。

**总评：FAIL（BLOCKED）** — 仅因发现项 A 的确定性数字不自洽；发现项 B 为需 lead 跟进的硬红线突破判定。
