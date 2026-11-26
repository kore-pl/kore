# A3 整体验收报告 — 55 文案 / 7 仓 bump+dist / 索引一致性 / make check 21 段全量复跑

- 验收员：a3-full-verifier（G-09，独立 verifier，非任何 a3-wave1/2/3 或 a3-index worker）
- 时间：2026-11-26（Asia/Shanghai）
- 任务：task-103（先 claim，revision 1→2，owner=a3-full-verifier）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根在此）
- 写范围：仅本报告 `.agents/verify/a3-full-verification.md`；精确 `git add` + `commit -s [agent:a3-full-verifier]`；未 push、未改代码、无 force/reset/rebase、未碰 `.kore-local-*`、未执行主流程 CLI；联网仅限 go proxy 下载依赖（精确披露见 §4）；隔离临时目录用完已删除。

## 结论（先行）— 总评 PASS

A3 发版前关键验收关口**五项全部 PASS**：

1. **55 条文案**：逐字比对 55/55 与 `docs/USABILITY-A3-PLAN.md` §2 改后文案一致；干净 archive 上 `usability-check.sh` 静态面与 A1 真跑面均 **exit 0 / A3 FAIL=0 / A4 FAIL=0 / 总 FAIL=0**。
2. **7 仓 bump/dist**：版本/CHANGELOG/dist sha256sum -c/stat 字节/包内 version+size 全部与权威表一致（7/7 PASS）。
3. **索引一致性**：index 7 条 vs 实测 dist、versions.lock 7 条账本、presets 15 处 pin、market 逐字节、`validate-index.sh`/`build-market --check`/`validate-presets.sh` 与独立 openssl ed25519 验签全部 PASS（exit 0）。
4. **kore 干净树 make check**：短路径隔离树 **exit 0 / `[OK] 门禁全部通过` / 21 段无阻断 FAIL**。长路径首轮的段 11 FAIL 已定性为 UDS socket 路径 108 字节超 107 限制的沙箱环境噪声（非代码问题），短路径复跑消失。
5. **git**：所有关键 commit 均为各仓 HEAD 祖先；未 push（remote-tracking ref 未变）；worktree 仅主树；他人 dirty 原样保留。

**建议：可进入 tag / 推送 / Release 阶段**（授权动作仍须用户逐项拍板，本验收不执行）。

---

## 一、55 条文案全落地（验收范围 1）

### 1.1 逐字比对（全量脚本，非抽样）

从 `docs/USABILITY-A3-PLAN.md` §2 表格解析 55 行 + 独立脚本逐仓读取源码，用 A3 门禁同款正则 `invalid\(\s*"((?:[^"\\]|\\.)*)"` 提取首个字面量，按「改后文案 == 字面量 或 字面量以改后文案 + 空格/冒号开头（动态尾段）」严格匹配。

- 分布与方案一致：`db-postgres` 28 / `runtime-node` 8 / `runtime-php` 8 / `runtime-python` 8 / `waf` 1 / `firewall` 1 / `app-deploy` 1，合计 55。
- **严格匹配结果：PASS 55 / FAIL 0**。
- 首轮宽松子串比对曾报 3 条疑似（#8 `权限`、#32/#40 `root 含反斜杠`），逐一回读确认为**子串误报**：实际字面量分别为 `请检查填写的权限 <raw> 不在白名单内…` / `目录 root 含反斜杠，请改用正斜杠 / 的路径`，与方案逐字一致，宽松比对把旧词条当作新文案子串命中。严格比对消除后 55/55。

### 1.2 抽样人工回读（每仓 3–5 条）

| 仓 | 抽样 file:line | 回读改后文案（节选） |
|---|---|---|
| app-deploy | `internal/apop/validate.go:163` | `请填写必填的环境变量 env: ` + Join |
| db-postgres | `internal/pgop/call.go:84/191/194/197`、`internal/pgop/sqlguard.go:73/98/105/119` | `请填写必填参数 instance（要操作的数据库连接名称）`、`params 需要是 JSON 对象，请传 {...} 格式`、`只读查询请求：语句请以 SELECT/SHOW/EXPLAIN/WITH 开头` 等 |
| runtime-node | `internal/nodeop/path.go:45/48/51` | `目录 root 含 NUL 空字符，请去掉后重试`、`目录 root 含反斜杠，请改用正斜杠 / 的路径`、`目录 root 请填绝对路径（以 / 开头）` |
| runtime-php | `internal/phpop/path.go:45/48/51` | 同 node 口径（白话 + 请 + 动作） |
| waf/firewall | `internal/wafop/validate.go:110`、`internal/fwop/validate.go:32` | `请传入参数对象 params（不能为空或 null）`、`协议 proto 请填 tcp 或 udp，不填默认 tcp` |
| runtime-python/db-postgres | `internal/pyop/venv.go:276`、`methods.go:102/109` | `请填写必填字段 venv_path（虚拟环境目录）`、`values 需要是 JSON 对象，请传 {...} 格式` |

全部抽样逐字一致，且保留 `+ err.Error()` / `+ name` / `+ pkg` 动态尾段与控制流未动。

### 1.3 干净 archive 跑 usability-check.sh

隔离构造：`git -C kore archive HEAD`（HEAD=`cce15f9b03cb4f4e1a5bcced57e6550cbafff647`）+ 24 插件仓 `git archive HEAD` 到 `.tmp/a3-verify-iso/plugins`；`PLUGIN_REPOS_DIR`/`USABILITY_PENDING_FILE` 指向隔离快照；隔离 `GOCACHE`，复用已缓存 GOMODCACHE，`GOPROXY=off GOWORK=off`。HEAD 版 `usability-pending.txt` 未被工作区他人 dirty 版掩盖（A3 15 行登记，与 `git show HEAD:` 一致）。

| 运行面 | 命令 | exit | 汇总末行 |
|---|---|---|---|
| 静态面（跳过 A1 真跑） | `bash scripts/usability-check.sh --no-run-tests` | **0** | `usability-check: 0 pass, 519 warn, 0 fail, 183 unverified（24 插件 / 10 一级菜单 / 5 视图）` |
| 全量（A1 真跑） | `bash scripts/usability-check.sh` | **0** | `usability-check: 0 pass, 520 warn, 0 fail, 183 unverified（24 插件 / 10 一级菜单 / 5 视图）` |

- **A3 FAIL = 0**（方案实现前 55 → 现全部转 WARN 存量豁免）；**A4 FAIL = 0**；**总 FAIL = 0**。
- A1 真跑 24 插件 ZeroParam 用例全过（隔离 GOCACHE 可写，无 go-cache 只读噪声）；A1/A2 靠存量 WARN 豁免，无 FAIL。
- **沙箱噪声识别**：本轮隔离环境 A1 可写、unshare 相关环境未触发，实测无 A1 go-cache 只读 / unshare 噪声；以干净 archive 实测为准（非工作区 dirty 版）。
- WARN 519/520 与 unverified 183 属存量待裁决面，不在本次范围（方案 §4.1）。

---

## 二、7 仓 bump / dist（验收范围 2）

权威表取自 task-102（b007a16 索引同步所用三波实测值）。逐仓核对：

| 仓 | 期望版本 | info.json / manifest.json version | CHANGELOG 顶部条目 | dist sha256sum -c | stat 字节（实测 / 权威） | 包内 version / size_bytes（vs tar） |
|---|---|---|---|---|---|---|
| waf | 0.5.3 | 0.5.3 / 0.5.3 | `## 0.5.3 — 2026-11-26` | OK / rc=0 | 2947731 / 2947731 (Δ0) | 0.5.3 / 2947732 (Δ+1) |
| firewall | 0.3.2 | 0.3.2 / 0.3.2 | `## 0.3.2 (2026-11-26)` | OK / rc=0 | 2883884 / 2883884 (Δ0) | 0.3.2 / 2883884 (Δ0) |
| app-deploy | 0.4.2 | 0.4.2 / 0.4.2 | `## 0.4.2 (2026-11-26)` | OK / rc=0 | 1708905 / 1708905 (Δ0) | 0.4.2 / 1708905 (Δ0) |
| runtime-node | 0.3.2 | 0.3.2 / 0.3.2 | `## [0.3.2] - 2026-11-26` | OK / rc=0 | 1563494 / 1563494 (Δ0) | 0.3.2 / 1563493 (Δ−1) |
| runtime-php | 0.3.2 | 0.3.2 / 0.3.2 | `## [0.3.2] - 2026-11-26` | OK / rc=0 | 1566386 / 1566386 (Δ0) | 0.3.2 / 1566387 (Δ+1) |
| runtime-python | 0.4.2 | 0.4.2 / 0.4.2 | `## [0.4.2] - 2026-11-26` | OK / rc=0 | 1586608 / 1586608 (Δ0) | 0.4.2 / 1586607 (Δ−1) |
| db-postgres | 0.4.2 | 0.4.2 / 0.4.2 | `## 0.4.2 (2026-11-26)` | OK / rc=0 | 1671263 / 1671263 (Δ0) | 0.4.2 / 1671262 (Δ−1) |

- 每仓 dist 归档 `dist/<id>-<ver>.tar.gz` 均存在，`.sha256` 文件随包，`sha256sum -c` 全 `OK`、computed sha 与权威表逐字符一致。
- 包内 `info.json` version == 期望版本（7/7）；`size_bytes` 与实测 tar 字节差在 −1..+1，**全部在 ±2 容差内**（RELEASE §1.2 自指估算口径，属正常）。
- 包内含 `bin/` 与 `SHA256SUMS`（tar 成员核对 PASS）。
- **本区结论：7/7 PASS**。

---

## 三、索引一致性（验收范围 3）

工作区：`/home/pt/Work/GolandProjects/kore-pl/kore-plugins`，HEAD=`b007a1684977a3e6ad70fd4f2e3658aedd3ed9ec`。

### 3.1 index/plugins.json 7 条 vs 实测 dist

独立脚本解析 `index/plugins.json`（24 条），逐条核对 7 个目标插件的 `version` / `sha256` / `size_bytes` / `download_url`：

- version、sha256、size_bytes **全部等于 §二实测 dist 值**（7/7）。
- download_url 均为 `https://github.com/kore-pl/kore-plugin-<id>/releases/download/v<ver>/<id>-<ver>.tar.gz`，版本与新版本一致（7/7）。

### 3.2 账本 / 预设 / market

| 项 | 结果 |
|---|---|
| `index/versions.lock.json` 7 条账本 | 7/7 目标版本+sha 均命中（每个 id 的 `version == 新版本` 且 `sha256 == 实测 sha`） |
| `presets/*.json` 15 处精确 pin | 15/15 全部指向新版本，0 处漂移（db-only 1 / dev 2 / full 7 / gateway 1 / security 2 / web-lite 1 / web-pro 1） |
| `market/plugins.js` 逐字节 | `validate-index.sh` 1c 步 + `build-market.sh --check` 双确认逐字节一致（24 插件） |

### 3.3 门禁命令

| 命令 | exit | 关键输出 |
|---|---|---|
| `bash scripts/validate-index.sh`（默认全量验签） | **0** | `[OK] schema/必填/id 唯一/sha 格式通过（24 条）`、`[OK] 版本单调/同 id@version 唯一 sha`、`[OK] 预设引用可解析（47 条）`、`[OK] market 逐字节一致（24）`、`[OK] ed25519 签名验证通过（内置公钥）`、`[OK] 索引校验全部通过` |
| `bash scripts/build-market.sh --check` | **0** | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` |
| `bash scripts/validate-presets.sh` | **0** | `[OK] 8 个预设 / 24 个索引插件 / 0 FAIL / 0 WARN` |

### 3.4 ed25519 独立验签（不依赖脚本自述）

按 `validate-index.sh` 同款 SPKI 包装（`302a300506032b6570032100` + 32B 内置公钥）构造 DER，独立跑：

```
openssl pkeyutl -verify -pubin -inkey pub2.der -keyform DER -rawin \
  -in index/plugins.json -sigfile index/plugins.json.sig
→ Signature Verified Successfully，exit 0
```

签名 64 字节，`sha256(index/plugins.json)=24bb6853cbf6d09043a3491da74bd0066af66decfbbabef15a38037d6df19394`。

**本区结论：PASS**（索引 7 条/账本 7 条/presets 15 处/market/validate/build-market/ed25519 全绿）。

---

## 四、kore 干净树 make check（验收范围 4）

参照 task-88 隔离方法：`git archive HEAD` 到工作区内**短路径**（`.v`，规避 UDS sun_path >107 字节，task-66 首轮教训）；25 兄弟仓（kore-plugins + 24 插件）各 `git archive HEAD` 提交态快照；隔离 `GOMODCACHE`/`GOCACHE`/`GOPATH`；`KORE_PLUGINS_DIR` / `USABILITY_PENDING_FILE` 指隔离快照；隔离树 `scripts/usability-pending.txt` 与 `git show HEAD:` 逐字节一致（`cmp` 通过，未被工作区他人 dirty 版掩盖）。

**联网精确披露**：默认 modcache 缺 bbolt v1.5.0 / x/sys v0.45.0 zip，按用户已授权的 `https://goproxy.cn,direct` 下载进隔离 GOMODCACHE（root + pkg/pluginapi + 24 插件仓 `go mod download`）；随后 `GOPROXY=off GOSUMDB=off GOWORK=off` 跑门禁。除 go proxy 下载外无其它联网、无 push、无 CLI 主流程执行。

### 4.1 首轮长路径 FAIL 定性（环境噪声，非本次引入）

首次用 `.tmp/a3-mcheck`（socket 路径 108 字节）复跑 `make check` 得 rc=2，唯一 `[FAIL]` 为段 11 零侵入：

```
[FAIL] 隔离实例未在 10s 内就绪（socket=.../.tmp/a3-mcheck/kore/.zero-intrusion-tmp.vSrhio/run/kore.sock）
serve.log: {"level":"ERROR","msg":"HTTP 监听失败","err":"监听专用更新 socket .../run/kore-selfupdate.sock: bind: invalid argument"}
```

判据：该 socket 绝对路径长 **108 字节 > UDS sun_path 107 字节上限**（`python len()` 实测），`bind: invalid argument` 即路径过长典型症状；与 task-66 首轮教训、task-88 `.v` 短路径口径一致；属沙箱路径长度环境噪声，**非 HEAD 代码问题、非本次 A3 改动引入**（A3 只改插件文案与索引，不触及 kore 内核/零侵入逻辑）。改用短路径 `.v` 后该段 PASS、整条 exit 0。

### 4.2 短路径干净树 make check（最终口径）

- 命令（隔离树 `.v/kore`，GOPROXY=off）：`make check` → **exit 0**，末行 **`[OK] 门禁全部通过`**。
- START 2026-11-26 16:32:45 +0800 / END 16:36:39 +0800（约 234s）。
- 21 段 `[RUN]` 全到齐，无阻断 FAIL。

### 4.3 21 段逐段结果

| 段 | 项 | 结果（汇总末行/关键输出） | 判定 |
|---|---|---|---|
| 1/21 | docs-check | `docs-check: 5 pass, 1 warn, 0 fail` | PASS（WARN 不阻断） |
| 2/21 | 依赖白名单 + 兼容基线 | `dep-check: 2 pass, 0 fail`；`[OK] 兼容基线通过`；第三方 2/3 | PASS |
| 3/21 | 薄壳边界 | `[OK] 薄壳边界通过`（task-89 修复 62eedfa 已在 HEAD 祖先，backup 配置词精确豁免生效） | PASS |
| 4/21 | repo-check | `repo-check: 5 pass, 0 fail` | PASS |
| 5/21 | canonical-check | `canonical-check: 14 pass, 0 warn, 0 fail` | PASS |
| 6/21 | log-check | `[OK] sessions/ 有 3/3 个文件符合 YYYY-MM-DD-*.md`（WARN 级） | PASS |
| 7/21 | wt-check | `[OK] 工作区状态无 /tmp/wt- 残留路径`（WARN 级） | PASS |
| 8/21 | oss-check | `oss-check: 8 pass, 0 warn, 0 fail` | PASS |
| 9/21 | case-check | `case-check: 27 pass, 1 warn, 0 fail` | PASS（WARN 不阻断） |
| 10/21 | frontend 首屏体积 | `[OK] i18n 增量达标：2941 字节 ≤ 3072 字节`（首屏 gzip ≤300 KiB 达标） | PASS |
| 11/21 | 零侵入门禁 | `zero-intrusion-check: 17 pass, 2 info, 0 fail`（短路径 `.v`，isolated instance 正常就绪） | PASS |
| 12/21 | secret-check | `secret-check: 0 FAIL / 19 处匹配（占位写法均合规）` | PASS |
| 13/21 | 插件仓开源资产 | `汇总: 25 pass / 0 warn / 0 fail` | PASS |
| 14/21 | store-check | `store-check: 24 pass, 0 fail, 37 warn` | PASS（WARN 级，含 dist sha 对照） |
| 15/21 | presets-check | `presets-check: 8 pass, 0 warn, 0 fail` | PASS |
| 16/21 | 公钥单一真源 | `[OK] 两端公钥一致：…3e461a07…`（verify.go ↔ validate-index.sh） | PASS |
| 16 段·market | 索引→市场页派生一致 | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` | PASS |
| 17/21 | 交叉编译（五目标真编译） | `[OK] 全仓交叉编译五目标全通过（exit 0，21037ms）` | PASS |
| 18/21 | race 门禁（跨仓边界） | `[OK] race 门禁通过（接线完整 + -race 真跑全绿）` | PASS |
| 19/21 | 全仓 -race | `[OK] 全仓 -race 通过（17 个包，59s，零 DATA RACE）` | PASS |
| 20/21 | usability-check（WARN 级） | `usability-check: 0 pass, 519 warn, 0 fail, 183 unverified` | PASS（0 FAIL；WARN 存量不阻断） |
| 21/21 | 嵌套 module pkg/pluginapi -race | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，2s，零 DATA RACE）` | PASS |
| **末行** | — | **`[OK] 门禁全部通过`** | **PASS** |

- 段 20 的 `[WARN] A3 …（usability-pending.txt 存量豁免）` 与 `[WARN] 清单条目已不再违规，请移除` 均为存量清单卫生提示，**0 FAIL**，不阻断。
- 段 3 薄壳此前 task-88 的阻断 FAIL（backup 配置词）已由 task-89/62eedfa 精确豁免修复并在本轮 HEAD 复跑确认通过。

**本区结论：PASS**（短路径干净树 `make check` exit 0，21 段全绿；长路径首轮 FAIL 为 UDS 路径长度噪声，已定性排除）。

---

## 五、git 纪律（验收范围 5）

### 5.1 关键 commit 祖先（全部 `merge-base --is-ancestor <c> HEAD` EXIT 0）

| 仓 | 分支 | 关键 commit | 祖先 |
|---|---|---|---|
| kore | main | `b9ad7d7`（A4 术语修复）、`51026d3`（A4 verifier 报告）、`cce15f9`（A3 方案，HEAD）、`62eedfa`（薄壳修复）、`d3b1b28`（审计 capability） | ✅ 全 OK |
| kore-plugins | main | `b007a16`（索引同步，HEAD） | ✅ |
| kore-plugin-waf | main | `9646db9`（wave1，HEAD） | ✅ |
| kore-plugin-firewall | main | `2b4dcd9`（wave1，HEAD） | ✅ |
| kore-plugin-app-deploy | main | `fb2fed7`（wave1，HEAD） | ✅ |
| kore-plugin-runtime-node | develop | `ee26cb1`（源文案）+ `7825fd4`（bump，HEAD） | ✅ 全 OK |
| kore-plugin-runtime-php | develop | `f5cd230`（源文案）+ `5fde352`（bump，HEAD） | ✅ 全 OK |
| kore-plugin-runtime-python | develop | `5572158`（源文案）+ `3107ba5`（bump，HEAD） | ✅ 全 OK |
| kore-plugin-db-postgres | main | `c104665`（wave3，HEAD） | ✅ |

> 任务卡中「a3-wave1 三仓 / 波2 六 commit / 波3 c104665」按实测各仓 HEAD 对应 commit 核对（wave1=9646db9/2b4dcd9/fb2fed7，波2=每仓源码+bump 两 commit，波3=c104665），全部为 HEAD 祖先。

### 5.2 未 push（本地 remote-tracking ref，未 fetch）

| 仓 | 本地 HEAD | origin/gitee/github main | HEAD 领先 |
|---|---|---|---|
| kore | cce15f9 | 62eedfa（三端一致；gitea 812f9fc） | +5（gitea +66） |
| kore-plugins | b007a16 | 92aa146 | +1 |
| waf | 9646db9 | 7601a21 | +1 |
| firewall | 2b4dcd9 | 2550249 | +1 |
| app-deploy | fb2fed7 | 7a22da6 | +1 |
| runtime-node | 7825fd4(develop) | 147607a | +3 |
| runtime-php | 5fde352(develop) | a9d7dd6 | +2 |
| runtime-python | 3107ba5(develop) | 6c4eae5 | +3 |
| db-postgres | c104665 | 291acfe | +1 |

全部本地 HEAD 领先远端 tracking ref，未 push（基于本地缓存 ref，未联网 fetch）。

### 5.3 worktree / 他人 dirty

- 9 个相关仓 `git worktree list` 均**仅主工作树**；`git branch --list 'wt-*' 'tmp-*'` 为空（G-25）。
- 他人 dirty 全部原样保留、未提交、未改：
  - kore：` M scripts/usability-pending.txt` + 多个 `?? .agents/verify/*`、`?? data/`、`?? dist/`、`?? screenshots/…`。
  - kore-plugins：`?? .tmp-validate-out.txt`、`?? dist/`。
  - waf/app-deploy/runtime-node/runtime-php/runtime-python/db-postgres：各 1 条 `?? zeroparam_test.go` / `?? internal/*/zeroparam_test.go`（firewall 干净）。
- 本验收唯一写操作 = 本报告文件（精确 add + commit）。

**本区结论：PASS**。

---

## 六、交付判定与证据留存

| 验收范围 | 判据 | 结果 |
|---|---|---|
| 1. 55 条文案 + usability-check | 55/55 逐字一致；A3 FAIL=0 / A4 FAIL=0 / 总 FAIL=0 | **PASS** |
| 2. 7 仓 bump/dist | 版本+CHANGELOG+sha256sum -c+stat+包内 version/size ±2 全一致 | **PASS** |
| 3. 索引一致性 | index 7 条 / 账本 7 / presets 15 / market / validate / ed25519 全绿 | **PASS** |
| 4. kore make check 21 段 | 短路径干净树 exit 0，末行 `[OK] 门禁全部通过`，无阻断 FAIL | **PASS** |
| 5. git 纪律 | 关键 commit 全祖先、未 push、worktree 仅主树、他人 dirty 原样 | **PASS** |
| **总评** | — | **PASS** |

沙箱噪声与诚实边界：①长路径首轮段 11 FAIL 为 UDS 路径 108>107 字节环境噪声，短路径复跑消失，非代码问题；②usability-check 519/520 WARN + 183 unverified 为存量待裁决面（不在本次范围）；③dist `size_bytes` 与实测 ±1 属自指估算正常抖动（RELEASE §1.2），索引以实测字节为准；④远端领先基于本地缓存 remote-tracking ref，未 fetch（遵循不联网纪律）。

隔离目录：`.tmp/a3-verify-iso`、`.tmp/a3-mcheck`、`.v` 均随验收完成删除；未在主工作区留下任何隔离残留。
