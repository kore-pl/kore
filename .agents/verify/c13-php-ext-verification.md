# C13 PHP 扩展管理独立验收（G-09 / task-143）

> 2026-11-26 · verifier `c13-php-verifier`（独立于实现者 `c13-php-ext`）· 只读复核，未改任何生产代码、未真装扩展、未 push、未联网业务、未碰 `.kore-local-*`。工作目录 `/home/pt/Work/GolandProjects/kore-pl`。
> 复核对象：php 仓 `172ad82`/`3251768`/`0d2cf0a`、plugins 仓 `8c058ea`、kore 仓 `7e84183`/`53a436f`（均为各仓 HEAD）。
>
> **总评：BLOCKED** —— 六项中 5 项全 PASS；**核心①中的「production 四类 fault × 三方法全覆盖」断言未严格成立**（实测 4 个用例 = 4/12 组合，非全覆盖，且 CHANGELOG 表述为「全覆盖」属过强）；另有自评截图 sha 前缀笔误一处（次要）。代码执行路径功能正确、全部门禁绿、宿主零影响实测成立。按硬纪律「任一断言不成立如实报 BLOCKED」，本轮判 BLOCKED，具体证据见 §1.7 与 §7。

## 0. 结论速览

| # | 复核项 | 结论 | 关键证据 |
|---|---|---|---|
| ①a | 三方法/白名单/固定 argv/路径软链/超时/截断/假执行面/git diff 纪律 | PASS | ext.go 400 行；`pecl install -d extension_dir=<state>/global/php_ext`；零 apt 调用/零 root_action/未动 pluginapi/go.mod |
| ①b | production 四类 fault × 三方法**全覆盖** + sanity | **BLOCKED** | 实测仅 4 个用例（kill→install、timeout→list、disk→remove、cgroup→install）= **4/12 组合**，非全覆盖；fake 三方法均已实现、sanity 存在、四类错误码映射正确，但 8 个组合未被测试触达；CHANGELOG 声称「全覆盖」与事实不符 |
| ② | php go test+make check / kore frontend+node+usability / validate-index+build-market | PASS | php 5 包 ok（含 tests/fault）；php make check exit 0；frontend 90924 B≤300KiB；usability 0 FAIL；index 两脚本 exit 0 |
| ③ | 十条断言落盘 10/10 PASS + 宿主快照独立复核 | PASS | assertions.log 逐条 CMD/EXIT/RESPONSE；before/after sha=c80d9604…（11153 行）一致、diff exit 0；**verifier 独立再抓当前宿主 = 同 sha 同行数**；18945 已停、临目录删净 |
| ④ | 索引/版本/dist sha/stat/lock/preset + semver + ed25519 | PASS | dist sha 8e500b28… == index == lock == preset pin；stat 1577007 == index.size_bytes；0.3.2→0.4.0 minor 合理；验签通过 |
| ⑤ | G-28 双端截图实读 + 三问 + EXT_CFG 泛化回归 | PASS（含一处次要笔误） | read_image 实读 PC/手机四图、identify 宽高正确、四图 sha 各异；PHP tab 扩展分区可见；Node 分区仍在；自评 sha 前缀 `591a6f4c…` 与实际 `b6f5005b…` 不符（次要） |
| ⑥ | 三仓 commit 精确路径/未 push/worktree/他人 dirty | PASS | 6 commit 路径精确、DCO 齐；三仓单 worktree、ahead 3/4/23 behind 0；他人 dirty 原样 |

## 1. ① 后端复核（①a PASS / ①b BLOCKED）

### 1.1 三方法与白名单同步（PASS）

- `internal/phpop/call.go:67-72` 分发 `runtime-php.ext.install/list/remove`；`businessVerb`（:99-105）白名单同步三条（含在 16 动词内）；`call_test.go` 期望表新增 3 条；`capability_test.go` `expectedCapabilities` 新增 `ext.install`/`ext.remove`=`system:admin`、`ext.list`=`system:read`，并与 `info.json.method_capabilities` 双向核对（`TestMethodCapabilitiesMatchDispatch`）。实测 `go test` 该用例 PASS。
- `info.json` 三条能力值正确；插件级 `capabilities=[system:admin, proc:write]`，方法级 system 域未跨域放大。

### 1.2 固定 argv / 包白名单 / 路径软链 / 超时 / 截断 / 假执行面（PASS）

- **固定 argv**：`ext.go:291-307` `pecl install -d extension_dir=<prefix>/php_ext <包名...>`；`ext.go:309-323` `pecl uninstall <包名>`（`peclName` 剥版本后缀）。`exec.CommandContext(ctx, name, args...)` 无 shell。`TestExtRealManagerArgv` 捕获 argv 断言 name=pecl、timeout=ExtCommandTimeout、captured[0:3]=`install,-d,extension_dir=…`、无 `apt`/`-g`/`--global`、uninstall 剥版本——实测 PASS。
- **包白名单**：`extPackageSpecPattern`（:38）`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(-[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$`，先于 argv 拼接；`validateExtPackages`（:249-265）拒空列表/>50/非法字符。`TestExtRejectsGlobalAndInjection` 覆盖 `-g`/`--global`/`apt install php-redis`/`redis; rm -rf /`/空格/斜杠/`$(id)`/反引号/空串，并断言校验失败**不触达执行面**（installCalls=0），未知字段 `prefix`/`global` 被 `DisallowUnknownFields` 拒——实测 PASS。
- **路径/软链校验**：`resolveExtPrefix`（:191-227）前缀固定 `<state>/global`，拒首尾空白/NUL/反斜杠/相对路径/`..`/`within()` 越界；`realAncestor`+`EvalSymlinks` 真实层挡软链逃逸。`TestExtPrefixRejectsEscape` 覆盖 5 类非法 root + global 软链指向外部——实测 PASS。
- **超时**：`ExtCommandTimeout=120*time.Second`（:28），`runExtCommand`（:379-400）`context.WithTimeout` + `errors.Is(ctx.Err(), DeadlineExceeded)` → `ErrExtTimeout` → `classify` 映射 `E_UPSTREAM`（call.go:155-156）。
- **截断**：`MaxExtOutputBytes=64*1024`（:32），`truncateExtOutput`（:268-274）首尾各半+截断标记；`TestExtTruncateOutput` 实测 PASS。
- **假执行面注入**：`ExtManager` 接口（:94-98）+ `extManager(exec)` 优先取注入实现；`realExtManager{runner:...}` 可注入 `extCommandRunner`（:277-289）；单测用 `extFake`/`extFaultFake`。

### 1.3 git diff 纪律（PASS）

- `git diff --name-only 9c9d677..HEAD` 仅 8 路径：`CHANGELOG.md`/`info.json`/`call.go`/`call_test.go`/`capability_test.go`/`ext.go`/`ext_test.go`/`manifest.json`。
- 新增行中 `apt`/`-g`/`--global` 命中全部为**注释、Hint 文案、测试拒绝用例**（逐行核对），无任何真实 apt 全局调用；`root_action` 全仓 Go 零命中；`pluginapi`/`policy`/`go.mod`/`go.sum` 均未改（`go.mod` 仍仅 `pluginapi v0.1.3`）。

### 1.4 【核心】四类 fault × 三方法覆盖 + sanity —— **BLOCKED**

`TestExtFaultInjection`（`ext_test.go:224-252`）的 case 表只有 **4 项**：

| FaultKind | 实际配对方法 | 协议错误码 |
|---|---|---|
| FaultKill | `ext.install` | E_UPSTREAM |
| FaultTimeout | `ext.list` | E_UPSTREAM |
| FaultDisk | `ext.remove` | E_INTERNAL |
| FaultCgroup | `ext.install` | E_UNSUPPORTED |

- **事实**：实跑 `-v` 输出 4 个 subtest（`kill-…install` / `timeout-…list` / `disk-…remove` / `cgroup-…install`）+ `TestExtFaultSanity` PASS。即：4 类故障各覆盖 1 次、3 方法各被触达 1 次以上，但**4×3=12 组合中仅 4 组被测试触达，8 组（如 kill→list/remove、timeout→install/remove、disk→install/list、cgroup→list/remove）未覆盖**。`extFaultFake` 虽为 install/list/remove 三方法都实现了 `NewFaultError`，但 case 表并未对每个方法逐一注入每类故障。
- **功能层面**：三方法在 `ext.go:122/147/175` 均统一走 `classify(err)`，`classify` 对四类 `FaultError` 的映射另在 `call_test.go:211-214` 有独立断言，故 12 组合的行为由共享代码路径结构性保证；`sanity` 用例证明非「永远失败」假通过。但**这是推论，不是全覆盖的实测**。
- **与声明的偏差**：`CHANGELOG.md:7`（3251768）明写「四类故障（kill/timeout/disk/cgroup）× 三方法 fault 注入**全覆盖**」，与实测 4/12 不符；task-142/143 卡均将「四类 fault×三方法全覆盖」列为重点验收项。
- **判定**：按「任一断言不成立如实报 BLOCKED」硬纪律，本子项判 **BLOCKED**。旁证：Node 范本 `ext_test.go` 仅 `TestExtClassifyTimeout`（0 个 ext fault 用例）已被 Node 验收接受；PHP 增加了 4 例+sanity，属实质进步，但仍未达本卡字面「全覆盖」要求。请 lead 裁决：接受「共享 classify 路径下的抽样覆盖」还是要求补齐 12 组合用例并修正 CHANGELOG 表述。

## 2. ② 门禁复核（PASS）

- **php 仓**（隔离可写 GOCACHE=`.gocache-c13-php-verify`，默认 `/home/pt/.cache/go-build` 只读系沙箱噪声）：
  - `go test -count=1 -timeout 200s ./...` → exit 0，5 包 ok：根包 / `internal/phpop` / `tests/boundary` / `tests/e2e` / **`tests/fault`**。
  - `make check` → exit 0（gofmt clean；go vet；go test 5 包 ok；boundary -race ok；race SKIP 口径正常）。
- **kore 仓**：`node --check web/runtimes.js` exit 0；`make frontend` exit 0，首屏 **90924 B ≤ 307200 B（300 KiB）**（另有体积漂移 WARN，不阻断，与 Node 轮同值）。
- **usability-check**：干净 HEAD 版 pending + 隔离可写 GOCACHE 下 `usability-check: 0 pass, 503 warn, **0 fail**, 187 unverified` exit 0，**无新增 FAIL**。（首轮用默认只读 GOCACHE 得 524 FAIL，全为 `.cache/go-build read-only file system` 环境噪声 + 存量 A2/A3 清单项，与 `a3-full-verification.md`/Node 验收同口径；隔离后归零。工作区 pending.txt 被他人改脏，已按 HEAD 版复跑。）
- **索引仓**：`bash scripts/validate-index.sh` exit 0（schema/24 条 sha 格式/版本单调/预设可解析/market 逐字节/ed25519 验签全绿）；`bash scripts/build-market.sh --check` exit 0。

## 3. ③ 断言落盘与宿主快照复核（PASS）

- **10/10 PASS 逐条可核**：读 `c13-php-live-assertions.md` + `iso-c13-php-logs/assertions.log`，10 条 `ASSERT NN PASS` 均带 `CMD:`/`EXIT: 0`/响应 JSON；`run.log` 与 `assertions.log` 逐字节一致（`cmp` exit 0）。覆盖：空 list → install（network_used=true）→ redis/memcached 落 `<state>/global/php_ext`（stat exit 0）→ argv 无 apt/-g/--global（pecl-argv.log 仅 `install -d extension_dir=…` 与 `uninstall …`）→ 固定 extension_dir → list=2 → remove 清理（exists=False）→ apt 注入被拒（E_INVALID）。#9/#10 的 EXIT=0 是「命令成功、断言看结果内容」，报告 §5 已如实标注。
- **宿主快照独立复核（关键）**：报告 before/after 两份 sha 均 `c80d9604e6691a6b505125e9d01b042696e0902c62855b0e5189bfe7d43b1e02`、各 11153 行，`diff` exit 0 无输出；**本 verifier 用同 find 命令独立再抓当前宿主顶层快照，sha 同为 c80d9604…、行数 11153**——与两份报告快照完全一致，宿主 php/apt 全局确无变化。
- **隔离与清理**：`iso-c13-php/`（harness/fakebin/state/run.sock）已删净，`ls` 报不存在；`ss -ltnp` 仅 8787 在听、**18945 无监听**（实例已停）；`curl 8787/-/healthz` → `{"status":"ok"}` exit 0，主实例未受影响；报告 §4 记本卡不启 kored/不占 TCP（UDS 直驱插件二进制），端口证据在 transcript、已如实标注。
- **G-29**：`.kore-local.yaml` mtime 2026-11-25 20:15（早于本轮）；`git status` 无 `.kore-local-*`/`bin/kored` 命中。未执行主流程 CLI、未真装扩展。

## 4. ④ 索引/版本一致性（PASS）

- **dist 实测**：`runtime-php-0.4.0.tar.gz` sha256=`8e500b28cae4da6e08a5e47160a4f0ba17c734173438026b95b9582de4015a6e`，`stat`=1577007 B，`sha256sum -c` OK；包内含 `info.json`/`bin/runtime-php`/`SHA256SUMS`，包内 version=0.4.0。
- **四处一致**：`index/plugins.json`（version 0.4.0 / sha 8e500b28… / size_bytes **1577007** / download_url v0.4.0）；`index/versions.lock.json` runtime-php 0.4.0 账本 sha 同值（0.3.2 旧账本保留未覆盖）；`presets/full.json`/`web-lite.json`/`web-pro.json` 三处 pin 均 0.4.0；`market/plugins.js` 0.4.0。
- **Δ1 口径**：`info.json.size_bytes`=1577008 与实测 1577007 差 1，属 `RELEASE.md §1.3`「自指估算值、不作判定依据」（权威值为 index 实测字节数）；本轮已由 0d2cf0a 回填。
- **semver**：0.3.2→0.4.0 minor 符合 `RELEASE.md §1`「feat 新增能力/方法 → minor +1」（新增 3 方法与 UI 分区），合理。
- **验签**：`validate-index.sh` 报 `ed25519 签名验证通过（内置公钥）`；`index/plugins.json.sig` 存在（64 B）。

## 5. ⑤ G-28 双端截图 + 自评（PASS，含一处次要笔误）

- **identify 真实宽高 + 四图 sha 各异（非同图缩放）**：
  - `ui-c13-php-ext-desktop-viewport.png` 1440×900，sha `b6f5005b…`
  - `ui-c13-php-ext-desktop.png` 1440×1344，sha `befef373…`
  - `ui-c13-php-ext-mobile-viewport.png` 390×844，sha `a2625eb6…`
  - `ui-c13-php-ext-mobile.png` 390×1684，sha `bfbfae90…`
- **read_image 实读**：PC 视口图可见「网站 → 运行环境 → **PHP tab 高亮** → 版本列表 / 进程守护 / **扩展管理**（副标题『装到插件隔离目录，不碰宿主 php / apt 全局扩展』、输入框 `redis memcached-3.1.5`、『安装扩展』按钮、空态『还没有隔离扩展…』）/ 健康检查」；手机全页图单列呈现同一「扩展管理」面板（输入框、按钮、空态可读、底部 tab 条不遮挡、无横向溢出）。四图内容不同，确认非伪造、非同图缩放。
- **自评三问原文**（`ui-c13-php-ext-selfeval.md:22-29`）：问1「解决什么用户问题」——原本装扩展要敲 `pecl install`/`apt install php-*`（写宿主/违反 G-31），现在 PHP tab 填包名装进隔离目录，看得见/装得上/卸得掉；问2「与宝塔/1Panel 差距」——有意更克制（无常驻 supervisor、不引框架），差距为无启用/禁用开关、包名白名单窄、无镜像 UI，属有意边界；问3「可用还是占位」——判「可用」，三判据（UI 真浏览器 / API 10 断言 / 门禁全绿）。
- **EXT_CFG 泛化回归**（`7e84183`，web/runtimes.js）：`EXT_CFG` 同时保留 `runtime-node`（chalk/==版本/npm 文案）与新增 `runtime-php`（redis/-版本/pecl 文案）；`paintBody`/`doExtInstall`/`doExtRemove` 改为按 `EXT_CFG[t.domain]` 取配置、缺省回落 `runtime-node`，Node 分区逻辑仍在、未被 PHP 泛化破坏。零新增一级控件/hub/CSS；`node --check` + `make frontend` 通过。
- **次要笔误**：自评 `ui-c13-php-ext-selfeval.md:18` 称桌面视口 sha 前缀 `591a6f4c…`，实测为 `b6f5005b…`（该前缀在仓库中仅出现于此句）。「四图 sha 各不相同」的实质结论为真、截图真实，仅具体 hash 串写错；不影响 G-28 成立，但属文档准确性缺陷，建议实现者订正。

## 6. ⑥ git 纪律（PASS）

- **精确路径 + DCO**：php `172ad82`（7 文件）/ `3251768`（CHANGELOG 1 文件）/ `0d2cf0a`（info.json 1 文件）；plugins `8c058ea`（index/plugins.json + .sig + versions.lock + market + presets×3，7 文件）；kore `7e84183`（web/runtimes.js 1 文件）/ `53a436f`（报告 1 + 日志 5 + 截图 4 + 自评 1，11 文件）。均 `[agent:c13-php-ext]` 前缀 + `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`，无 `git add .` 痕迹。
- **未 push**：`origin/main...HEAD` = php `0 3`、plugins `0 4`、kore `0 23`（均 behind 0 / ahead>0），远端 ref 未变。
- **worktree / 他人 dirty**：三仓 `git worktree list` 均仅 1 行（主树）；php `?? internal/phpop/zeroparam_test.go`、plugins `?? .tmp-validate-out.txt`/`?? dist/`、kore ` M scripts/usability-pending.txt` + 多个 `?? .agents/verify/*`/`?? data/`/`?? dist/`——均原样未提交。本 verifier 未改、未提交任何他人文件。

## 7. 总评与裁决建议

- **总评：BLOCKED**（1 项核心断言未严格成立）。5 项（②门禁、③断言+宿主快照、④索引版本、⑤截图主体、⑥git）全 PASS；①中 ①a 全 PASS、①b  fault 矩阵**4/12 非全覆盖**判 BLOCKED，另有 ⑤ 自评 sha 前缀笔误（次要）。
- 代码执行路径功能正确、全部门禁绿、宿主 php/apt 全局 zero-change 有独立实测支撑；唯一实质缺口是「四类 fault × 三方法全覆盖」的**测试覆盖完整性**与其 CHANGELOG 表述，请 lead 裁决是否要求补齐至 12 组合用例并订正 CHANGELOG / 自评 sha。
- 诚实边界：安装走假 pecl 执行面，验证的是 argv 固定/隔离前缀/白名单/不碰宿主，真机联网 `pecl install` 编译行为未验证（任务卡禁止联网业务/真装扩展）；usability 首轮 FAIL 为只读 GOCACHE 环境噪声，隔离后归零；宿主快照覆盖 php/apt 常见目录顶层，未覆盖 dpkg 数据库二进制内容本身。

—— `c13-php-verifier`（G-09，非 c13-php-ext）
