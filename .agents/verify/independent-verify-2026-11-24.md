# 独立验收 · 2026-11-24 门禁复跑与关键声明抽查（G-09 独立 verifier）

> 状态: done · 归属: verifier · 更新: 2026-11-24 · 里程碑: M5
> 立场：**证伪优先**。不复用实现者结论，全部命令由本人重跑或由本人独立构造探针。
> 环境：`/home/pt/Work/GolandProjects/kore` @ `e172fde`（工作区另有 `M .agents/HANDOFF.md` 属他人，未触碰）；主实例 `kored` pid 1387457（已运行 2h16m）**全程零写入、未重启**。

---

## 0. 结论速览

| 项目 | 判定 |
| --- | --- |
| 1 `make check` 17 段 | **成立**：exit 0，17/17 全跑，0 FAIL / 10 WARN |
| 2 三平台构建 | **成立**：windows/amd64 exit 0，darwin/arm64 exit 0 |
| 3 索引 ↔ 发布物 | **成立**：24/24 全部 HTTP 200 且 sha256 + size 逐字一致，`BAD_COUNT=0` |
| 4 三条「已修」抽查 | **3/3 成立**（csrf 非 HttpOnly / upgrade 非 501 / dns.reload 拒绝 engine） |
| 5 文档 ↔ 代码抽查 | **4 成立 + 1 无法验证**（Gitee API 未取到数据） |
| 不成立清单 | 本轮 5 项**无**；**附带发现 1 条**（Makefile 头部注释旧口径，见 §3） |

---

## 1. `make check` 17 段（命令 + 退出码 + 逐段结果）

```bash
make check 2>&1 | tee /tmp/mc.log
# EXIT=0
```

| 段 | 名称 | 结果 |
| --- | --- | --- |
| 1 | docs-check | 5 pass / 1 warn（行数越界 3 份：PLUGIN-PROTOCOL 476 / RUNBOOK 557 / SIGNING-KEY-SOP 88） |
| 2 | dep-check + 兼容基线（仅文本层） | 2 pass；第三方 2/3（bbolt、yaml.v3） |
| 3 | thin-shell-check | 4 pass / 0 fail（业务域词 0 命中、业务动作词 0 命中，扫 150 个 .go） |
| 4 | repo-check | 5 pass / 0 fail |
| 5 | canonical-check | 9 pass / 0 warn / 0 fail |
| 6 | log-check | 8 pass / 0 warn |
| 7 | wt-check | 4 pass / 0 warn |
| 8 | oss-check | 8 pass / 0 warn |
| 9 | case-check | 27 pass / 1 warn（3 条 github.com/Microsoft/* URL owner 大写） |
| 10 | frontend 首屏 | 首屏 65213 B ≤ 307200 B；i18n 增量 2909 B ≤ 3072 B（余量 163 B） |
| 11 | zero-intrusion-check | 11 pass / 0 fail（隔离根 /tmp/kore-zero-intrusion.ySRGhl，测后自清） |
| 12 | secret-check | 0 FAIL / 13 处匹配（占位写法合规） |
| 13 | plugin-oss-check（25 仓） | 25 pass / 0 warn / 0 fail |
| 14 | store-check | **24 pass / 0 fail / 0 warn** |
| 15 | presets-check | **8 pass / 8 warn / 0 fail** |
| 16 | 公钥单一真源 | 2 处一致（3e461a07…d2df1c0） |
| 17 | 交叉编译（阻断级） | [OK] 五目标全通过（exit 0，238ms） |

汇总：`[OK] 门禁全部通过`，`EXIT=0`，`grep -c '^\[FAIL'` = **0**，`grep -c '^\[WARN'` = **10**（docs 1 + case 1 + presets 8）。

### 1.1 第 3 段 thin-shell 是否真的 0 命中 —— **成立**

```
[OK] 业务域词（词首匹配，注释已剥离）：0 命中（backup/site/monitor/cron/ssl/database/mysql/nginx/docker）
[OK] 业务动作词（整词匹配，注释已剥离）：0 命中（create/restart/deploy）
thin-shell-check: 4 pass, 0 fail（扫描 150 个可执行 .go 文件）
```
对照依据：`96d41dd fix(core/installer): 日志串去业务域词 cron` 声称修掉的就是该段；复跑 0 命中，**成立**。

### 1.2 第 14 段 store-check 是否真的 0 warn —— **成立**

```
awk '/^\[RUN \] 14\/17/,/^\[RUN \] 15\/17/' /tmp/mc.log | grep -c '^\[WARN\]'
=> 0
store-check: 24 pass, 0 fail, 0 warn
```
附带说明：该段新增了「本地 dist sha ↔ 索引 sha」比对（`c569e12`），若 24 仓本地 dist 与索引有漂移会打 `DIST_SHA_DIFF` WARN；本次 **0 条**，说明 24 仓本地 dist 与索引账本 sha 全部一致（另见 §1.6 的 firewall 单点复核）。

### 1.3 第 15 段 8 条 warn 是否都登记在 `scripts/depth-level-pending.txt` —— **成立**

```
awk '/^\[RUN \] 15\/17/,/^\[RUN \] 16\/17/' /tmp/mc.log | grep -c '^\[WARN\]' => 8
[INFO] depth_level 核对: 24 个已收录插件 · 不一致 8 条（已知待裁决 8 / 新增 0）
```
逐 id 比对 `scripts/depth-level-pending.txt`（该文件去注释后恰为 8 行）：

| warn 插件 | 索引 | 仓库 info.json | 清单登记 |
| --- | --- | --- | --- |
| echo | basic | production | 已登记 |
| integrity | basic | production | 已登记 |
| dns | basic | production | 已登记 |
| runtime-node | basic | production | 已登记 |
| runtime-python | basic | production | 已登记 |
| db-postgres | basic | production | 已登记 |
| waf | basic | production | 已登记 |
| container | basic | production | 已登记 |

8/8 命中，无「不在清单却只 WARN」的漏网，也无「在清单但门禁未提示移除」的残留。

### 1.4 第 17 段是否真的 `go build`（而不是又退化成 grep）—— **成立，实测为真编译**

**正向证据**（产物真实、平台正确）：
```bash
make --no-print-directory cross   # real 0m0.226s（热缓存：全命中 GOCACHE，go 直接复用缓存对象）
file bin/kored-windows-amd64.exe bin/kored-darwin-arm64 bin/kored-linux-arm64
# PE32+ executable for MS Windows 6.01 (console), x86-64
# Mach-O 64-bit arm64 executable
# ELF 64-bit LSB executable, ARM aarch64, statically linked
ls -l bin/  # 五个产物时间戳均为本轮 01:35:58，非历史残留
```

**反证实验**（关键，证伪优先）：在 `git archive HEAD` 的 `/tmp` 副本里注入一个**只影响非 linux 目标**的编译错误，看第 17 段会不会 FAIL：

```bash
git archive HEAD | tar -x -C /tmp/v17
cat > /tmp/v17/internal/core/bus/zz_verify_probe.go <<'EOF'
//go:build !linux
package bus
func verifyProbeBroken() { var n int = "string-not-int"; _ = n }
EOF
cd /tmp/v17 && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/kored   # exit 1
cd /tmp/v17 && make --no-print-directory cross-build
```
实测输出（**SEG17_EXIT=2**）：
```
       # github.com/pengtang1024/kore/internal/core/bus
       internal/core/bus/zz_verify_probe.go:7:14: cannot use "string-not-int" (untyped string constant) as int value in variable declaration
[FAIL] 交叉编译失败（exit 2，耗时 150ms）：平台专有符号必须收进 internal/platform 或按 build tag 收口
       首个编译错误: internal/core/bus/zz_verify_probe.go:7:14: ...
```
→ 第 17 段**确实真编译、确实阻断**，`6bd09ee` 的「判据只验证文本=漏检」修复有效。

**覆盖边界（如实披露，不是缺陷但影响判据强度）**：该段只编译 `./cmd/kored` 的依赖闭包。我第一次把探针放在 `internal/core/zz.go`（`internal/core` 本身不是包，是子包目录），生成的是一个**无人 import 的新包**，windows 构建仍 exit 0、第 17 段仍全绿。即：**未被 `cmd/kored` 引用的包即使编译不过也不会被第 17 段发现**。若要求「全仓所有包都能交叉编译」，需把该段改成 `go build ./...`（本轮未改，仅登记）。

### 1.5 三平台构建（G-16 两条明文判据）

```bash
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./...   # WIN_EXIT=0
GOOS=darwin  GOARCH=arm64 CGO_ENABLED=0 go build ./...   # DARWIN_EXIT=0
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/vw.exe ./cmd/kored  # exit 0，14703616 B
```

### 1.6 索引与发布物一致性（24 条，`curl -L` 逐条下载实测）

```bash
# 从 kore-plugins/index/plugins.json 取 24 条 (id, version, size_bytes, sha256, download_url)
# 逐条: curl -sS -L --max-time 90 -o /tmp/vdls/<id>.tgz -w '%{http_code}' <url>
#       再 sha256sum + stat -c%s 与索引值比对
```
结果：**24/24 `http=200`，sha256 与 size_bytes 逐字一致**，`BAD_COUNT=0`。

| id | ver | http | size（实测/索引） | sha256 前 12 |
| --- | --- | --- | --- | --- |
| echo | 0.1.4 | 200 | 1353310 / 1353310 | eaf2d1287478 |
| site | 0.4.3 | 200 | 1611579 / 1611579 | 26b0f4a347eb |
| file | 0.3.2 | 200 | 1695042 / 1695042 | e4079c3c9382 |
| ssl | 0.6.0 | 200 | 3168154 / 3168154 | 832a06ebcb56 |
| integrity | 0.4.0 | 200 | 1468268 / 1468268 | 4358320e002a |
| cron | 0.5.0 | 200 | 1559454 / 1559454 | 25a7f55886cf |
| ssh-guard | 0.3.1 | 200 | 2840537 / 2840537 | 260af4b5b0cc |
| monitor | 0.3.0 | 200 | 1344418 / 1344418 | db747aad1dc5 |
| logs | 0.5.1 | 200 | 1590704 / 1590704 | 17743259b146 |
| dns | 0.4.0 | 200 | 1652080 / 1652080 | 4010651b6e92 |
| runtime-php | 0.2.2 | 200 | 1506125 / 1506125 | 11fc63366f0e |
| runtime-node | 0.2.4 | 200 | 1502833 / 1502833 | 2033f3ed8519 |
| runtime-python | 0.3.1 | 200 | 1550361 / 1550361 | f16abf6e6644 |
| db-mysql | 0.4.1 | 200 | 1576479 / 1576479 | 721462dba3d2 |
| db-postgres | 0.3.3 | 200 | 1569480 / 1569480 | c881cec23e1c |
| redis | 0.6.0 | 200 | 1520442 / 1520442 | 3088ef0ee718 |
| backup | 0.4.2 | 200 | 1709550 / 1709550 | 069edac82787 |
| firewall | 0.2.6 | 200 | 2833896 / 2833896 | **f034229f4fdf** |
| waf | 0.4.4 | 200 | 2938643 / 2938643 | 9db925059bd1 |
| container | 0.5.4 | 200 | 1530283 / 1530283 | 940d220b6ebb |
| app-deploy | 0.3.1 | 200 | 1687721 / 1687721 | 2fa0e99e667c |
| terminal | 0.2.1 | 200 | 1522791 / 1522791 | 146a62bb92a1 |
| process | 0.3.0 | 200 | 1468449 / 1468449 | 36d435246960 |
| discover | 0.3.1 | 200 | 1533965 / 1533965 | 972d932b0879 |

**口径诚实说明**：我的循环把自造的汇总行 `COUNT 24` 也当成了记录处理，因此脚本最后打印 `BAD_COUNT=1`；那 1 条是我的脚本瑕疵，不是索引缺陷。**24 条真实记录的 BAD_COUNT = 0**。

---

## 2. 三条「今天声称已修」的抽查（全部起隔离实例，主实例零写入）

隔离实例：`go build -o /tmp/v19/bin/kored ./cmd/kored`（HEAD 源码，非仓库内 bin/kored）→ 独立 config/state/run/log 全落 `/tmp/v19`，端口 `127.0.0.1:18879`（先 `ss -ltn` 确认空闲）→ `healthz=200` → 测毕 kill + `rm -rf /tmp/v19`，端口已释放，主实例 8787 pid 1387457 未变。

### 2.1 `kore_csrf` 是否真的非 HttpOnly —— **成立**

```bash
curl -s -D - -o /dev/null http://127.0.0.1:18879/ | grep -i '^set-cookie'
```
实测响应头：
```
Set-Cookie: kore_csrf=mty3Xl_Aei6i1wStXJrjJl8oiup-Kyf3H_Fy0bdQz0M; Path=/; SameSite=Strict
```
无 `HttpOnly`。同次登录的 cookie jar 形成**对照**：
```
127.0.0.1        FALSE  /  FALSE  ...  kore_csrf     POHMnD5n...
#HttpOnly_127.0.0.1 FALSE / FALSE ...  kore_session  9GjlKW3i...
```
→ `kore_session` 带 `HttpOnly`，`kore_csrf` 不带。**双提交前提成立**。
进一步验证「可读但不可绕过」：带会话、不带 `X-Kore-CSRF` 的 POST 被拒：
```bash
curl -s -b cj.txt -X POST .../api/v1/system/upgrade -d '{"target":"/tmp/x"}'
=> {"code":"E_UNAUTHORIZED","message":"CSRF 校验失败","detail":""}  HTTP=401
```
带上与 cookie 同值的 `X-Kore-CSRF` 后**通过 CSRF 层**（后续因请求体字段非法回 `E_INVALID: unknown field "target"`，HTTP=400）——说明放行是「校验通过后进入业务解析」，不是放水。

### 2.2 `GET /api/v1/system/upgrade` 是否真的不再是 501 —— **成立**

```bash
curl -b cj.txt -w 'HTTP=%{http_code}' .../api/v1/system/upgrade
# UPGRADE_HTTP=200
# {"current":{"path":"/tmp/v19/bin/kored","sha256":"bc7e85c0..."},"can_upgrade":false,"can_rollback":false,
#  "reason":"当前进程不是 root：替换自身二进制与重启 systemd unit 都需要系统服务身份（ADR-0042）"}
curl -w 'HTTP=%{http_code}' .../api/v1/system/upgrade   # 未登录
# NOAUTH_UPGRADE_HTTP=401
```
200 + 显式字段契约成立；`can_upgrade=false` 是**非 root 的诚实降级**（附 reason），不是 501 占位。

### 2.3 `dns.reload` 传 `{"engine":"bind9"}` 是否真的返回 `E_INVALID` —— **成立**

单测/实现者测试不算数，我独立构造探针（`git archive HEAD` 的 `/tmp/vdns` 副本里写自己的测试）：
```go
p, perr := decodeReloadParams([]byte(`{"engine":"bind9"}`))
// 断言：perr != nil 且 perr.Code == E_INVALID；对照组 {"zone":"example.com"} 必须通过
```
实测：
```
=== RUN   TestVerifyProbeReloadRejectsEngine
    成立：code=E_INVALID msg=params 含未声明的字段 engine：dns.reload 只接受可选 zone（引擎由插件配置/探测决定）
--- PASS
```
代码路径佐证：`internal/dnsop/call.go` 的 `reload` 分支**先** `decodeReloadParams`（`json.Decoder.DisallowUnknownFields`）再 `d.Reload`，返回错误即 return，`Reload`/`rndc` 不会被触达 —— `{"engine":"bind9"}` 不会再被执行成 `rndc reload bind9`。

---

## 3. 声称 vs 实测 对照表

| # | 声称（来源） | 我的实测 | 判定 |
| --- | --- | --- | --- |
| 1 | `make check` 17 段全过（本日多张卡） | exit 0，17/17 全跑，0 FAIL / 10 WARN | **成立** |
| 2 | 第 3 段 thin-shell 0 命中（`96d41dd`） | 业务域词 0 / 业务动作词 0，4 pass | **成立** |
| 3 | 第 14 段 store-check 0 warn（`c569e12`/`e172fde`） | `24 pass, 0 fail, 0 warn`，该切片 `^\[WARN\]` = 0 | **成立** |
| 4 | 第 15 段 8 条 warn 均已登记待裁决 | 8 条 warn 与 `depth-level-pending.txt` 8 个 id 一一对应 | **成立** |
| 5 | 第 17 段是「真编译」阻断级（`6bd09ee`） | 注入 `//go:build !linux` 类型错误 → `[FAIL] exit 2` + 首个编译错误 | **成立** |
| 6 | 三平台构建可过（G-16） | windows/amd64 exit 0、darwin/arm64 exit 0 | **成立** |
| 7 | 索引 24 条 sha/size 与发布物一致 | 24/24 HTTP 200，sha256+size 逐字一致，BAD_COUNT=0 | **成立** |
| 8 | `kore_csrf` 非 HttpOnly（双提交前提） | `Set-Cookie: ... SameSite=Strict`，无 HttpOnly；session cookie 反而是 HttpOnly | **成立** |
| 9 | `GET /api/v1/system/upgrade` 不再是 501 | 200 + 显式契约；未登录 401；非 root 给 reason | **成立** |
| 10 | `dns.reload {"engine":"bind9"}` 回 E_INVALID | 独立探针：`E_INVALID`，合法 zone 对照组通过 | **成立** |
| 11 | `docs/QUALITY-GATES.md`：第 17 段交叉编译阻断级 | 见 #5，实测阻断 | **成立** |
| 12 | ADR-0047 / PLUGIN-PROTOCOL：方法名接受下划线 | `methodActionPattern = ^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$`（registry/validate.go:66）；scheduler 同名正则 | **成立** |
| 13 | `QUALITY-GATES`/store-check：DIST_SHA_DIFF 只 WARN 不 FAIL | 脚本 §6 实现（store-check.sh:267/310/315），本次 0 条；firewall 0.2.6 本地 dist sha `f034229f…` == 索引 sha、size 2833896 == 索引 | **成立** |
| 14 | `.agents/verify/gitee-release-prune.md`：24 仓 release 收敛到最新 5 条 | Gitee API 三次请求均返回空（无 token/口径受限），未能取到计数 | **无法验证** |
| 15 | `Makefile:3` 头部契约：主壳 ≤8 MiB 为红线、默认 GOGC=100 + GOMEMLIMIT=6MiB | 与 `AGENTS.md` G-03（红线 16 MiB / 目标 8 MiB）冲突；隔离实例实测 `gogc_percent=50, gomemlimit_bytes=6291456` | **不成立（附带发现，非本轮声称）** |

---

## 4. 不成立清单

### 4.1 本轮被验收的 5 项声称：**无一条不成立**

`make check` 17 段 / 三平台构建 / 24 条索引一致 / 三条「已修」/ 5 处文档声明 —— 除 1 处无法验证外全部成立，未发现「文档说通过、实跑不通过」或「只 grep 不编译」的糊弄。

### 4.2 附带发现（非本轮声称，但复核时撞到，如实登记）

**F-1（低危 · 文档口径漂移）`Makefile` 头部契约仍是旧预算/旧 GC 口径**

- 证据：`Makefile:3`
  `# 契约：主壳空载 RSS ≤ 8 MiB（目标 5–6；默认 GOGC=100 + GOMEMLIMIT=6MiB，另跑 GOGC 双档对照）· 常驻插件单 ≤ 12 MiB / 合计 ≤ 24 MiB`
- 对照真源：`AGENTS.md` G-03 / ADR-0016 —— **硬红线 16 MiB、目标 8 MiB**；`Makefile` 自身 `MAIN_RSS_KIB_RED ?= 16384` / `MAIN_RSS_KIB_GOAL ?= 8192` 也是 16/8。
- 实测：隔离实例启动日志 `{"msg":"资源锚点","gogc_percent":50,"gomemlimit_bytes":6291456,"gomaxprocs":8}` —— 实际默认 GOGC=50，不是注释里的 100。
- 影响：注释不影响判定（判据在变量与 budget-check），但「读 Makefile 头的人会拿到错误红线」，属 G-06 文档同步范畴。`canonical-check` 规则 2 只拦「默认 GOGC=200」，拦不到 100，故一直没被门禁抓到。
- 建议：单独一张卡把 `Makefile:3` 对齐 16/8 MiB 与 GOGC=50，并把「默认 GOGC 口径」纳入 canonical-check（另立裁决）。

**F-2（信息 · 门禁覆盖边界，非缺陷）第 17 段只编译 `./cmd/kored` 依赖闭包**

- 证据：探针放在 `internal/core/zz_probe.go`（无人 import 的新包）时，windows 构建 exit 0、第 17 段全绿；放进 `internal/core/bus`（被 cmd/kored import）才 FAIL。
- 含义：第 17 段证明的是「主程序在五目标可编译」，不是「全仓每个包都可在五目标编译」。若有平台专有符号藏在未引用包里，该段不会发现。按 G-16 文本（构建必须可移植）这够用；若想更强，可改 `go build ./...`。

---

## 5. 无法验证项及原因

| 项 | 原因 | 可复验方式 |
| --- | --- | --- |
| Gitee 24 仓 release 是否都为最新 5 条（`.agents/verify/gitee-release-prune.md` 声称「19 仓净删 41 条，删后全部 5 条」） | `https://gitee.com/api/v5/repos/kore-pl/kore-plugin-{echo,firewall,discover}/releases?per_page=100` 均返回空响应，未取到 JSON（无 token / 访问口径受限） | 配 `GITEA/GITEE_TOKEN` 或人工开 Gitee release 页逐仓点数；也可用 `scripts/gitee-release-prune.sh --dry-run` 的只读输出核对保留集 |
| `production` 插件的 `tests/fault/` 故障注入是否真跑过（G-20） | 本轮不属验收范围（未跑 24 仓 fault 测试），且时间预算外 | 在对应插件仓 `make test` / `go test ./tests/fault/` |

---

## 6. 运行态与清理声明（G-29）

- **主实例 8787 零写入、零重启**：pid 1387457 全程未变（复核时 `etime` 2h16m、`/-/healthz`=200）。所有需要登录/写语义的验证都在 `/tmp` 隔离实例（18879）完成。
- 隔离实例已 kill（`pgrep -f '^/tmp/v19/bin/kored'` 定向杀，未用会误伤自身的宽匹配），端口 18879 已释放，`/tmp/v19`、`/tmp/v17`、`/tmp/vdns`、`/tmp/vdls` 及探针测试文件全部删除。
- 未改动任何代码 / 文档 / 索引；仓库工作区仅新增本报告。工作区里他人的 `M .agents/HANDOFF.md` 未触碰、未提交。
- 唯一提交：本文件（`git commit -- .agents/verify/independent-verify-2026-11-24.md`）。
