# C13 Node 扩展管理独立验收（G-09 / task-140）

> 2026-11-26 · verifier `c13-verifier`（独立于实现者 `c13-node-ext`）· 只读复核，未改任何生产代码、未真装扩展、未 push、未联网（GOPROXY=off）· 工作目录 `/home/pt/Work/GolandProjects/kore-pl`。
> 复核对象：node 仓 `99ece6c`/`67772b6`、kore-plugins 仓 `efae113`/`18ecd63`、kore 仓 `3aef3f6`/`7f74f56`/`e5df700` + 补证 commit `a83adb9`（以最新 HEAD 为准）。
> **总评：PASS**（六项复核全部成立；无新增 FAIL；证据链经补证后完整可核）。

## 0. 结论速览

| # | 复核项 | 结论 | 关键证据 |
|---|---|---|---|
| ① | 后端方法/白名单/Python 范本/零宿主写/root_action/rootpolicy | PASS | `ext.go` 388 行 + `call.go` 三分支 + info.json 三能力；git diff 零命中 npm -g/root_action/pkg/pluginapi |
| ② | node 门禁 + kore make check 21 段 + usability WARN 归因 | PASS | node go test/make check exit 0；kore 21/21 exit 0 `[OK] 门禁全部通过`；段20 `0 fail`；WAF WARN 属存量豁免+环境噪声 |
| ③ | 隔离十条断言 / 宿主全局 npm 零变化 / 18963 / 临时目录 | PASS | a83adb9 落盘 `assertions.log` 10/10 PASS + npm before/after sha 相同 diff=0（verifier 独立复核当前 npm 仍一致）；18963 已停、iso-c13 scaffold 删净 |
| ④ | validate-index + 0.4.0→0.4.1 bump 理由 + sha/索引一致 | PASS | validate-index exit 0；bump 符合 RELEASE §0「改 dist sha 必 bump」；dist/索引/versions.lock sha 六处逐字节一致 |
| ⑤ | G-28 双端截图实读 + 三问原文 | PASS | read_image 实读双端，PC 1440×900 / 手机 390×1891 均可辨「扩展管理」分区；四图 sha 各异；三问原文齐备 |
| ⑥ | 三仓 commit 精确路径 / 未 push / worktree / 他人 dirty | PASS | 7 提交路径精确、Signed-off-by 齐；三仓均 single worktree、ahead 2/3/20、dirty 仅他人文件 |

## 1. ① 后端复核（PASS）

- **三方法 + 白名单同步**：`internal/nodeop/call.go:67-72` 分发 `runtime-node.ext.install/list/remove`；`businessVerb` 白名单（call.go:99-105）同步三条；`info.json.method_capabilities` 三条：`ext.install`/`ext.remove` = `system:admin`、`ext.list` = `system:read`；`capability_test.go` 期望表同步（双向一致性由既有用例守护）。
- **照 Python venv.go 范本**：逐项对齐 `kore-plugin-runtime-python/internal/pyop/venv.go` —— 固定 argv（无 shell）、包正则白名单 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(==…)?$`、路径/软链逃逸校验（`resolveExtPrefix`/`realAncestor` + `filepath.EvalSymlinks`）、120s 超时（`ExtCommandTimeout = 120*time.Second`，`context.WithTimeout`）、输出 64 KiB 首尾截断（`truncateExtOutput`）、假执行面注入（`realExtManager{runner:…}` + `extFake`）。
- **零宿主写**：安装前缀固定 `<state>/global`（`DefaultGlobalSubdir = "global"`），argv 为 `npm install/uninstall --prefix <state>/global --no-audit --no-fund --ignore-scripts <包名>`，**无 `npm -g`/`--global`**；`ListPackages` 只读 `<prefix>/node_modules`；`validateExtPackages` 显式挡 `-g`/`--global`/`@scope`/空格/分号/引号/斜杠/前导 `-`；`resolveExtPrefix` 拒 NUL/反斜杠/`..`/相对路径/首尾空白/软链逃逸。
- **git diff 核对（df5966d..99ece6c）**：仅 7 个路径（CHANGELOG.md / info.json / call.go / capability_test.go / ext.go / ext_test.go / manifest.json）；`grep -nE 'npm -g|-g\\b|root_action|rootpolicy|/usr/|/opt/'` 命中均在注释/文案/测试拒绝用例中，**无任何真实 -g 调用声明**；`git diff --name-only | grep -iE 'pluginapi|rootpolicy|policy'` → NONE（未动 pkg/pluginapi rootpolicy 形状表）；全仓 `grep -rn root_action --include='*.go'` 零命中（无 root_action 声明）。99ece6c 仅把 2 处 invalid 文案补「请」引导词（A3），无行为/契约改动。

## 2. ② 门禁复核（PASS）

### 2.1 node 仓（isolated GOCACHE，默认 `/home/pt/.cache/go-build` 只读系沙箱噪声）

```
cd kore-plugin-runtime-node
GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.gocache-c13-verify \
  go test -count=1 -timeout 200s ./...     → exit 0
ok  github.com/pengtang1024/kore-plugin-runtime-node           0.537s
ok  github.com/pengtang1024/kore-plugin-runtime-node/internal/nodeop  0.637s
ok  github.com/pengtang1024/kore-plugin-runtime-node/tests/e2e        2.877s
ok  github.com/pengtang1024/kore-plugin-runtime-node/tests/fault      1.569s
GOCACHE=… make check                       → exit 0（gofmt clean / go vet / go test 四包 ok / race SKIP 无 boundary）
```

> 首轮用默认 GOCACHE 得 `[setup failed] read-only file system`，与 a3-full-verification.md:16/56 的 go-cache 只读噪声同类，非代码问题；隔离可写 GOCACHE 后全绿。

### 2.2 kore 仓 make check 21 段 exit 0

```
cd kore
GOCACHE=.gocache-c13-verify GOMODCACHE=.tmp-acct-gomodcache \
GOPROXY=off GOSUMDB=off GOWORK=off \
USABILITY_PENDING_FILE=<HEAD 版 pending（工作区 dirty 版被他人删 17 条 A1 豁免）> \
  make check   → exit 0，21/21 [RUN] 齐全，末行 [OK] 门禁全部通过
```

关键段：11/21 零侵入 `17 pass, 2 info, 0 fail`；14/21 store-check `24 pass, 0 fail, 37 warn`；15/21 presets-check `8 pass, 0 warn, 0 fail`；17/21 交叉编译五目标全通过 exit 0；18/21 race 门禁通过；19/21 全仓 -race 17 包零 DATA RACE；20/21 `usability-check: 0 pass, 503 warn, 0 fail, 185 unverified`（**0 FAIL**）；21/21 pkg/pluginapi 全量 -race 2 包 exit 0。
> 为排除沙箱噪声：默认 GOCACHE/GOMODCACHE 只读导致 11/17/19/21 段 `read-only file system`（另 firewall/site 缺缓存 pluginapi 版本导致 `GOPROXY=off` 查模块），均属环境层；补齐隔离可写缓存后 21/21 全绿。

### 2.3 段20「WAF 环境噪声 WARN」归因核对（成立）

- 干净 HEAD pending 口径下，段20 waf 的 WARN 均为存量豁免：`[WARN] A1 waf: ZeroParam 真跑失败: … module lookup disabled by GOPROXY=off …（usability-pending.txt 存量豁免）`、`A2 waf: info.json 缺必填 presets（存量豁免）`、`A3 waf: internal/wafop/*.go …（存量豁免）`。A1 的 `module lookup disabled by GOPROXY=off` 是 verifier 复跑时隔离 GOPROXY=off 的环境噪声，非 C13 引入；A3/A2 是 C15/A3 已登记的存量清单卫生项。
- 与 `a3-full-verification.md:13,55,177` 对照：该次全量验收 usability ** exit 0 / A3 FAIL=0 / A4 FAIL=0 / 总 FAIL=0**；段20 的 WARN 亦为「存量清单卫生提示，0 FAIL 不阻断」。本次 `usability-check: … 0 fail`，**无新增 FAIL**——C13 只新增 Node 扩展三方法与 UI 分区，两处 99ece6c 文案修补正是为防新增 A3 违规把存量条目转 FAIL（见 CHANGELOG 0.4.1 条）。归因成立。

## 3. ③ 隔离断言复核（PASS，补证后）

- **十条断言有落盘可核证据**：首次交付仅 transcript 结论，implementer 应本 verifier 要求补做并落盘 commit `a83adb9`，新增 `.agents/verify/c13-live-assertions.md` + `iso-c13-reverify/{assertions.log, run.log, npm-global-before.txt, npm-global-after.txt}`。逐条读取 `assertions.log`：`HANDSHAKE: kore.hello -> ok` + 10 条 `ASSERT NN PASS`（均带 `CMD:` 原文 + `EXIT: 0` + 响应 JSON），末行 `TOTAL: 10/10 PASS` / `RESULT: ALL PASS`；`run.log` 与之一致。断言覆盖：空 list → install（network_used=true）→ chalk/commander 落 `<state>/global/node_modules`（stat err=nil）→ argv 无 -g/--global 且固定 `--prefix` → list=2 → remove 清理（IsNotExist=true）→ `-g` 注入被拒（E_INVALID）。
- **宿主全局 npm 零引用/无变化（补证后可信）**：报告承认首轮只有事后检查+argv 反证（推论非实测 diff），补证做了真正 before/after 快照：`find $(npm root -g) -maxdepth 1 -mindepth 1 -printf '%f|%T@|%s\n' | sort` 前后两份 sha256 均 `a4088821e43ac5bf0625eadbdeb904879d6b7c175e46b4fbc466c0962102e9db`，`diff` exit 0 无输出。**verifier 独立复核**：当前再抓一次宿主全局 npm 顶层快照 sha256 与两份报告快照完全一致、diff exit 0；机制层另有 argv log 无 `-g` + 白名单双证。
- **隔离实例与临时目录**：自评与补证报告一致记 18963 独立 config/state/run/log（非 8787）；本次复核 `ss -ltn | grep 18963` 无监听（实例已停）、`curl 8787/-/healthz` → `{"status":"ok"}`（主实例未受影响）；`.agents/verify/iso-c13` 与 `iso-c13-reverify/{verify.go,fakebin,state,gocache}` scaffold 均已删净，仅保留 5 份落盘证据文件（4 份日志 + 报告；日志经 `git add -f` 精确入库）。端口证据仍只在 transcript、未落盘——补证报告 §5 已如实写明，本 verifier 按「如实边界」接受，不据此否定整体结论（端口非断言本体，且 8787 未受影响已实测）。
- **G-29 运行态写边界**：`.kore-local.yaml` mtime 2026-11-25 20:15（早于本轮）、`git status` 无 `.kore-local-*`/`bin/kored` 命中；`bin/kored` 20:55 的 make build 属本地二进制、与 8787 运行中进程解耦（自评已注明，8787 未重启）。未执行任何主流程 CLI、未真装扩展。

## 4. ④ 索引/版本一致性（PASS）

- **validate-index**：`cd kore-plugins && bash scripts/validate-index.sh` → exit 0（`schema/id 唯一/sha256 格式 24 条`、`版本单调/同 id@version 唯一 sha`、`预设引用可解析`、`market 逐字节一致`、`ed25519 验签` 全绿）；`bash scripts/build-market.sh --check` → exit 0。
- **0.4.0 → 0.4.1 bump 理由符合 RELEASE.md §0**：`kore/docs/RELEASE.md:9`「同一 id@version 只允许一个 sha256」、`:18`「任何改变 dist 包 sha 的改动必须 bump」。截图时为 0.4.0（feat 新增能力，minor）；随后 99ece6c 把两处 `invalid()` 文案补「请」引导词以过 G-33 A3（CHANGELOG 0.4.1 条），Go 源码改动必然改变 dist sha → 按 §0 bump patch 到 0.4.1，**理由成立、顺序正确**；e5df700 自评补注「截图时 0.4.0 / 最终 0.4.1，UI 与截图逐字一致」——diff 仅服务端 invalid() 文案，前端 `runtimes.js` 与截图可见文字未变，UI 逐字一致有据。
- **sha/索引逐字节一致（三处权威核对）**：dist 实测 `sha256sum dist/runtime-node-0.4.1.tar.gz` = `d9e7d17029ffacbc0160ccb8161569785f92c612bdfb4f94b9c12e78c6ae140a`；`.sha256` 文件内容同；`index/plugins.json` runtime-node 0.4.1 条 sha 同值、`size_bytes=1574118` == `stat` 实测 1574118；`index/versions.lock.json` runtime-node 0.4.1 账本 sha 同值；`presets/dev.json`/`full.json` pin 均 0.4.1；`market/plugins.js` runtime-node 版本 0.4.1。`info.json.size_bytes=1574117`（与实测差 1）属 RELEASE §1.3 自指估算正常抖动，不作判定依据。`0.4.0` 账本 sha `1b531e1a…` 保留、未覆盖旧版本。

## 5. ⑤ G-28 双端截图硬核验（PASS）

- **identify 真实宽高 + sha（四图各异，非同图缩放）**：
  - `ui-c13-node-ext-desktop-viewport.png` 1440×900，sha `fb8e1d37…`
  - `ui-c13-node-ext-desktop.png` 1440×1326，sha `b9637c8c…`
  - `ui-c13-node-ext-mobile-viewport.png` 390×844，sha `af0e4585…`
  - `ui-c13-node-ext-mobile.png` 390×1891，sha `6fbd80c1…`
- **read_image 实读**：PC 视口图可见「运行环境 → Node.js tab → 版本列表 / 进程守护 / **扩展管理**（副标题『装到插件隔离目录，不影响系统全局 npm』、输入框 placeholder `chalk commander==12.0.0`、按钮『安装扩展』、空态『还没有隔离扩展…』）/ 项目扫描」依次布局；手机全页图单列呈现同一「扩展管理」面板（输入框、安装按钮、空态文案可读、无横向溢出），进程守护副标题显示隔离 state 路径 `…/iso-c13/state/node/guard`。两图内容不同（视口 vs 全页、端不同），确认非伪造、非同图缩放。
- **自评三问原文**（`ui-c13-node-ext-selfeval.md:20-29`）：问1「解决什么用户问题」——原本装扩展要用户敲 `npm install -g`（改宿主/不可回滚），现在 Node tab 填包名即可装进隔离目录，看得见/装得上/卸得掉；问2「与宝塔/1Panel 差距」——有意更克制（无常驻 supervisor、不引入框架），差距为无依赖树可视化/包名白名单刻意窄/无 registry 镜像 UI，属有意边界；问3「可用还是占位」——判「可用」，三条判据（UI 路径真实浏览器、API 路径 10 断言、门禁 make frontend 首屏 90924 B/`node --check`/usability 0 FAIL/页面错误 0）。

## 6. ⑥ git 复核（PASS）

- **精确路径**：node `67772b6`（7 文件）/ `99ece6c`（4 文件 CHANGELOG/info/ext.go/manifest）；plugins `18ecd63`（6 文件）/ `efae113`（6 文件 index/versions.lock/presets/market/sig）；kore `3aef3f6`（web/runtimes.js）/ `7f74f56`（4 图 + selfeval）/ `e5df700`（selfeval 1 行）/ `a83adb9`（报告 + 4 证据文件）。全部 `[agent:c13-node-ext]` 前缀 + `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`，无 `git add .` 痕迹。
- **未 push**：node `origin/main...HEAD = 0 2`（ahead 2）、plugins `0 3`（ahead 3）、kore `0 20`（ahead 20 behind 0）；远端 ref 未变。
- **worktree/他人 dirty**：三仓 `git worktree list` 均仅 1 行（主树）；kore 他人 dirty（` M scripts/usability-pending.txt` + 多个 `?? .agents/verify/*`、`?? data/`、`?? dist/`）原样未提交；node `?? internal/nodeop/zeroparam_test.go`、plugins `?? .tmp-validate-out.txt` / `?? dist/` 原样未提交——本 verifier 未改、未提交任何他人文件。

## 7. 诚实边界与总评

- 安装动作走假 npm 执行面，验证的是「argv 固定 + 隔离前缀 + 白名单 + 不碰全局」，真机联网 `npm install` 未验证（任务卡禁止联网业务/真装扩展）。
- 18963 端口启停与 8787 未受影响的早期证据仅在实现者 transcript；补证报告已如实标注；8787 健康与 `.kore-local-*` 未变由本 verifier 独立实测。
- 首轮 make check 的段 11/15/17/18/19/21 失败均为沙箱只读缓存/GOPROXY=off 缺缓存模块的环境噪声（与 a3-full-verification.md 的口径一致），补齐隔离可写缓存后 21/21 exit 0；无 C13 引入的 FAIL。

**总评：PASS。** 六项复核全部成立，隔离断言经补证后证据链完整可核，宿主零影响有 before/after 快照实测支撑，版本/索引/sha/截图一致性齐备，三仓 git 纪律合规。本 verifier 未改代码、未真装扩展、未 push、未联网业务、未碰 `.kore-local-*`；唯一写域为本报告文件。

—— `c13-verifier`（G-09，非 c13-node-ext）
