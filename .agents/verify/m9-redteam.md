# M9 红队对抗验证报告：`--scenario` 离线批量 CLI + 双形态 G-10（G-09）

- 角色：red-team = `m9-redteam`，独立于 implementer `m9-impl` 与 verifier `m9-verifier`（G-09 满足）。
- 任务：task-84。工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）。
- 被测对象：HEAD `cae416b`（`[agent:m9-impl] feat(cmd/kored): --scenario 补齐离线批量预设安装`），父 `2d92626`。
- 时间：2026-11-26（Asia/Shanghai）。
- 定性：**只读对抗验证**。不执行真实 install / serve / upgrade，不联网，不 push，不改生产代码，不碰 `.kore-local-*`。

## 0. 结论总表

| # | 对抗场景 | 结果 | 与设计一致 |
| --- | --- | --- | --- |
| 1 | `--scenario` 路径穿越（`../` / 绝对 / symlink） | PASS（见边界注记） | 一致（id 正则拦截；目录参数 symlink 跟随属用户显式配置边界，非越权） |
| 2 | 畸形 version 约束不 panic | PASS | 一致（全部 fail-closed，零安装，零 panic） |
| 3 | 依赖环 / 自依赖规划期拒绝 | PASS | 一致（规划期 E_INVALID / exit 2，零安装） |
| 4 | 部分失败继续 + 最高失败码 + 无整批回滚 | PASS | 一致（继续全跑、返回最高码、明确不回滚） |
| 5 | G-10 隐藏出站静态扫（install_scenario.go + upgrade_supply.go） | PASS | 一致（无遥测/beacon/硬编码地址；唯一出站点来自已验签索引且 https 校验） |
| 6 | M7 残余观察：`CleanupAfterInstall` 调用点 | PASS（观察项，**发现 1 处设计缺口待 lead 裁决**） | 见 §6：内核 finalize 成功路径未触发清理 |

**总计：6 场景全部完成验证；0 个阻断级缺陷；1 个设计缺口（场景 6，仅报告不改代码，交 lead 裁决）。**

---

## 0.1 隔离环境与可复现命令

对抗测试全部在**隔离工作区副本**执行，生产仓源码零改动（G-29）：

```
# 建隔离副本（只读 git archive，不留 git 状态）
ISO=/home/pt/Work/GolandProjects/kore-pl/.redteam-m9-iso
rm -rf "$ISO" && mkdir -p "$ISO/src"
cd /home/pt/Work/GolandProjects/kore-pl/kore && git archive HEAD | tar -x -C "$ISO/src"
# web/dist 为 gitignore 构建产物，从生产只读复制进副本（embed 依赖）
cp -r web/dist/. "$ISO/src/web/dist/"
# 复用 m9-verifier 已就绪的离线依赖缓存（GOPROXY=off 前提）
cp -r .verify-m9-tmp/gomodcache/. "$ISO/gomodcache/"
# 对抗测试文件只写副本：
#   $ISO/src/cmd/kored/m9_redteam_adv_test.go
#   $ISO/src/cmd/kored/m9_redteam_overflow_test.go
cd "$ISO/src"
export GOWORK=off GOPROXY=off GOCACHE="$ISO/gocache" GOMODCACHE="$ISO/gomodcache"
go test -count=1 -timeout 200s ./cmd/kored/...        # exit 0（ok github.com/pengtang1024/kore/cmd/kored 9.189s）
go vet ./cmd/kored/...                                # exit 0
```

**基线先行**：未加对抗测试前 `go test ./cmd/kored/...` 已 exit 0（`ok ... 9.266s`），确认副本可编译、依赖离线可用；后文所有 PASS 均在此副本上取得。

注入的测试替身 `rtStub` 只替换 `scenarioSingleInstall`，记录调用 id@version 与返回码，**不落盘、不打开 state.db、不联网**，从而在不执行真实 install 的前提下把规划期/汇总期行为完整跑通。

**收尾**：测试完成后 `rm -rf "$ISO"`（一次性隔离目录，用完即删；工作区不留临时脚本）。

---

## 1. 场景 1：`--scenario` 路径穿越（`../` / 绝对 / symlink）

**攻击面**：`loadScenarioPreset` 拼 `filepath.Join(presetsDir, id+".json")`（install_scenario.go:434-457）；三个目录参数 `--presets-dir/--packages-dir/--index-dir` 为任意字符串（:485-513）。

**命令与退出码**（隔离副本）：
```
go test -count=1 -run 'TestRT1_' -v ./cmd/kored/     # exit 0（3/3 PASS）
```

**实际行为**：

1. **预设 id 穿越（`TestRT1_PresetIDTraversalRejected`）**：对 `../secret`、`..\secret`、`/etc/passwd`、`foo/bar`、`foo.json`、`..`、`.`、`a/b`、`a\0b`、`a b`、`A`、`0bad` 共 12 个恶意/非法 id 逐一调用 `runScenarioBatch`：全部返回 `exitConfig=2`，stderr 含 `E_INVALID: 场景预设 id="..." 非法`；安装替身调用数恒为 0（未读到 presets 目录外的 `secret.json`）。根因：`scenarioIDPattern = ^[a-z][a-z0-9-]*$`（:40）在 `loadScenarioPreset:436` 与 `orderScenarioPlugins:376` 双重把关。**与设计一致。**

2. **目录参数绝对路径 / 含 `..` 路径（`TestRT1_DirFlagsAbsoluteAndDotDot`）**：给 `--presets-dir` 传绝对路径与 `.../sibling/../presets` 形式，均 exit 0、`calls=[echo@0.1.0]`——能读到预期内的预设并正常安装。这是**用户显式配置**的目录参数，不是 id 穿越面；无越权读取。**与设计一致**（CLI 目录参数按用户提供值直接读取）。

3. **symlink（`TestRT1_SymlinkPresetFollowed`）**：在 presets 目录内放指向目录外 `outside.json` 的 `link.json` 软链，`runScenarioBatch` exit 0、`calls=[echo@0.1.0]`——`os.ReadFile` 跟随软链读到目录外文件。

**边界注记（非缺陷，如实报告供 lead 备案）**：`loadScenarioPreset` 的 id 白名单只约束**文件名部分**，未对 `presetsDir` 本身做 `EvalSymlinks`/realpath 边界校验，因此"用户自己把软链放进 presets 目录指向别处"会跟随读取。鉴于：① 目录参数本身由用户显式指定（用户对本机文件有完全读权限）；② `--scenario` 只作离线/演练补充，不进静默主链；③ 读到的 JSON 仍须过 `id == 请求 id` 与 `schema_version == 1` 校验（:450-455）；该行为判定为**设计边界**而非越权漏洞。**不自行改代码**，如需防线加固（真实来源校验）请 lead 裁决是否另派任务。

---

## 2. 场景 2：畸形 version 约束不 panic（不越权选包）

**命令与退出码**：
```
go test -count=1 -run 'TestRT2_' -v ./cmd/kored/     # exit 0（2/2 PASS）
```

**实际行为**（`TestRT2_MalformedVersionNoPanic` 注入 19 种畸形约束）：空串、纯空白、1 万字符超长、`../../etc/passwd`、`/etc/passwd`、`; rm -rf /`、`$(touch /tmp/rt-pwned)`、反引号 `` `id` ``、换行注入 `0.1.0\n>=9.9.9`、`999999999999999999999999.0.0`、`^9223372036854775807.0.0`、`>=0.1.0 <0.2.0 >0.3.0`（三段比较器）、前导零 `0.01.0`、负数 `0.1.-1`、中文 `版本`、NUL 字节 `0.1.0\0`、`0.1.0 || 9.9.9`、`latest`、`*`——**全部 exitConfig=2、零安装调用、零 panic**（每例外层 `defer recover()` 守门，无 panic 触发）。注入的命令注入串没有产生任何副作用（未创建 `/tmp/rt-pwned`——版本串从不进入 shell）。

**整数溢出专项**（`TestRT2_UpperBoundOverflowFailClosed`）：`^9223372036854775807.0.0` 的上界会算成 `maxInt64+1`（Go 64 位溢出为负），测试放一个 `9223372036854775807.0.0` 的包验证是否被错误选中：结果 exit 2、零安装、stderr 明确 `可用版本 [...] 均不满足`。即溢出使区间**不可满足**（fail-closed），未越权选到高版本，也未 panic。**与设计一致**（`parseScenarioVersionSpec:261-317` 一律拒绝不支持写法，不静默降级为精确版本）。

---

## 3. 场景 3：依赖环 / 自依赖规划期拒绝

**命令与退出码**：
```
go test -count=1 -run 'TestRT3_' -v ./cmd/kored/     # exit 0（2/2 PASS）
```

**实际行为**（`TestRT3_CycleAndSelfDependency`）：

| 用例 | 退出码 | 安装调用 | stderr 关键串 |
| --- | --- | --- | --- |
| 2 节点环 `echo↔site` | 2 | 0 | `E_INVALID: 预设插件存在循环依赖，无法确定依赖序` |
| 3 节点环 `echo→site→ssl→echo` | 2 | 0 | 同上 |
| 自依赖 `echo→echo` | 2 | 0 | `插件 echo 依赖自身，无法确定依赖序` |
| 预设重复引用同一插件 | 2 | 0 | `预设重复引用插件 echo` |

全部在规划期（安装循环之前）返回，零部分执行、无死循环（`orderScenarioPlugins:372-431` 的 Kahn 拓扑排序，入度归零队列 + `len(ordered) != len(plugins)` 环检测）。**与设计一致。**

**误报抑制**（`TestRT3_ExternalCycleNotFalsePositive`）：依赖图里存在环但环上节点都不在本批 preset 内时，exit 0、正常安装本批 `echo@0.1.0`——只对本批集合计边（:392-401 的 `present[dep]` 门），不把外部环误判为本批失败。**符合"外部依赖不在本批安装集合，无需变更，不阻塞"的注释语义。**

---

## 4. 场景 4：部分失败继续 + 最高失败码 + 无整批回滚

**命令与退出码**：
```
go test -count=1 -run 'TestRT4_' -v ./cmd/kored/     # exit 0（2/2 PASS）
```

**实际行为**（`TestRT4_WorstFailureCodeAndContinue`）：注入 4 项 `echo=2 / site=0 / ssl=3 / discover=4`（退出码 2=config、0=OK、3=state、4=store），预期按预设顺序全跑：
- 退出码 = **4**（最高失败码，非首失败码、非固定值）；
- 调用序列 = `[echo@0.1.0, site@0.2.0, ssl@0.3.0, discover@0.4.0]`——失败项后续仍继续，4 项全部安装一次；
- stdout 汇总 `共 4 项，成功 1 项，失败 3 项`；
- stderr 逐条分诊含各失败项与 `退出码 2/3/4`，并打印 `提示: 失败项可单独重跑（修好包或停服后），成功项不会被回滚。`
- 无任何回滚调用路径（`scenarioSingleInstall` 替身只记录调用，无回滚函数；实现中 `runScenarioBatch:136-182` 也无回滚逻辑）。

**混合解析失败**（`TestRT4_ResolveErrorPlusFailureWorstCode`）：一条缺包（规划期解析失败 exitConfig=2）+ 一条单装失败 exitStore=4：结果 exit 4、仅缺包项不调用安装、另一项照常安装；解析失败按 exitConfig 计入 `worst` 初值（:138/142/145），最高码语义完整。**与设计一致。**

---

## 5. 场景 5：G-10 隐藏出站静态扫（install_scenario.go + upgrade_supply.go）

**命令与退出码**（生产仓只读 grep）：
```
grep -niE 'http\.Client|net\.Dial|telemetry|analytics|phone-home|beacon|https?://|os/exec|exec\.Command|curl|wget|report' \
  cmd/kored/install_scenario.go cmd/kored/upgrade_supply.go
# exit 0（命中 3 行，均为 upgrade_supply.go 的 http.Client 出站点；install_scenario.go 零命中）
grep -niE 'telemetry|analytics|phone.?home|beacon|report|metrics|sentry|statsd|segment|mixpanel|amplitude|exec\.Command|os/exec|net\.Dial|http\.Get|http\.Post|websocket|grpc' \
  cmd/kored/install_scenario.go cmd/kored/upgrade_supply.go
# exit 1（ZERO banned terms）
```

**实际行为与判定**：

- **`install_scenario.go`（M9）**：import 仅 `bytes/encoding/json/errors/fmt/io/os/path/filepath/regexp/sort/strconv/strings` + 同仓 `pkg/pluginapi`，**零网络/exec 依赖**；所有文件读取走本地 `os.ReadFile`/`os.ReadDir`（:201/439/465），无隐藏出站。
- **`upgrade_supply.go`（M6）**：命中 `http.Client`（:46 字段、:84 构造、:86 `http.NewRequestWithContext`、:90 `client.Do`）——这是供应链下载出站点。逐条核对 ADR-0054 第 2 节六条判据（本文件属"用户配置源短连接"类）：
  1. **目标只来自已验签索引**：`asset.DownloadURL` 由 `deps.source.VerifiedCoreAsset()`（:72）提供，生产实现 `market.Service.VerifiedCoreAsset`（coreasset.go:92-107）先验签再返回，验签失败零数据；**源码无硬编码 URL**（`grep '"https?://'` 两文件零命中）。
  2. **https 强制**：`market.ValidateCoreAssetURL`（coreasset.go:55-64）强制 `parsed.Scheme == "https" && parsed.Host != ""`，`file:`/`http:`/相对路径均 E_INVALID 拒绝，下载侧在 :77 复核，**无旁路**。
  3. **一次性短连接**：单次 `GET` + `client.Do`，超时 60s（:27），无 ticker / AfterFunc / 周期循环（G-19），无常驻 goroutine。
  4. **无遥测语义**：payload 为空（`http.NewRequestWithContext(..., nil)`），不上传 session/评分/心跳；无 `telemetry`/`analytics`/`beacon`/`report` 关键词。
  5. **凭据/URL 不落明文日志**：本文件无日志打印完整 URL；错误信息只带 HTTP 状态码/摘要差异。
  6. **校验先于替换**：sha256 不符则删临时文件、upgrade 零调用（:139-142），下载大小上限 64 MiB + `LimitReader` 多读 1 字节防谎报（:98/121-128）。

**结论**：两文件均无隐藏出站、无遥测、无硬编码地址，唯一出站点符合"用户配置源（`kore-plugins` 已验签索引）短连接"口径。**G-10 PASS。**

---

## 6. 场景 6：M7 残余观察 —— `CleanupAfterInstall` 调用点（只报告，不改代码）

**命令与退出码**：
```
grep -rn 'CleanupAfterInstall' --include='*.go' cmd/ internal/
# exit 0（见下方调用点清单）
grep -rn 'installRefreshWithCleanup\|InstallRefresh\|installRefresh' --include='*.go' cmd/ internal/ | grep -v _test.go
# exit 0
```

**实际调用点清单（生产源码）**：

| 位置 | 性质 |
| --- | --- |
| `internal/core/market/cleanup.go:244` | `func (s *Service) CleanupAfterInstall(...)` —— 清理原语定义 |
| `internal/core/market/cleanup.go:239` | 注释明确覆盖"插件 reload **/ 内核 finalize 成功**"（ADR-0059 §3.5 第 3 条） |
| `cmd/kored/serve_boot.go:66` | 装配层接口声明 `cleanupService` |
| `cmd/kored/serve_boot.go:104` | 唯一**生产调用点**：`cleanupAfterInstall(...)` 内 |
| `cmd/kored/serve_boot.go:132` | `installRefreshWithCleanup` 包装 reload 成功后调 `cleanupAfterInstall` |
| `cmd/kored/serve_boot.go:197` | 装配：`InstallRefresh: installRefreshWithCleanup(cfg, svc, svc.reloadOne)` |
| `cmd/kored/serve_boot_cleanup_test.go` / `internal/core/market/cleanup_test.go` | 测试替身/用例（非生产调用） |

**接线链核对**：
- `serve_boot.go:126-134` 的 `installRefreshWithCleanup` 仅在 `reload(id)` 返回成功后调 `cleanupAfterInstall`（reload 失败零清理零审计）；
- 该包装经 `:197` 注入到 `httpapi.ServerOptions.InstallRefresh`，只在 `POST /api/v1/store/install` / upgrade 成功后触发（`handlers_store.go:180-181/231-233`），`Confirmed=true` 表示插件 reload 成功 = 生效确认；
- **内核二进制升级**路径：`cmd/kored/main.go:74` → `finalizePendingUpgrade`（`upgrade.go:344-379`）只把 upgrade-result 标记改为 success 并校验二进制 sha256，**全文未调用 `CleanupAfterInstall`**，也未引用 `market` 包；`upgrade.go` 仅保留 `<bin>.prev` 一份可回滚二进制（:35/:511）。

**发现（设计缺口，仅报告不改代码）**：
> 注释 `cleanup.go:239`（"插件 reload 成功 / 内核 finalize 成功"）宣称的**内核 finalize 成功路径并未接入 `CleanupAfterInstall`**。当前自动清理只覆盖**插件**安装/升级后的 reload 路径；**内核二进制自更新**（M6 供应链 `upgrade --bin` → 新进程 `finalizePendingUpgrade`）成功生效后**不触发** `backup.keep_count/max_disk_bytes` 的旧版本清理。内核 `.prev` 走独立的 `upgrade.go` 保留/回滚语义，不受 M7 备份份数/磁盘上限约束。

**判定**：与 ADR-0059 §3.5 注释语义**不完全一致**；因任务卡明确"只报告不改代码"，本轮**不修补**，登记为 **"设计缺口待 lead 裁决"**。若裁决需补齐，建议另派集成卡（写域 `cmd/kored/upgrade.go` 的 finalize 成功分支 + 对应隔离测试），本红队不擅自跨写域。

**纪律声明**：`grep` 首次全仓扫描因 `.kore-local-state/` 下插件运行态目录权限不足产生 stderr 噪声（exit 2），随即改用 `cmd/ internal/` 作用域重跑取得干净证据（exit 0）；**全程未读取/修改/重启任何 `.kore-local-*` 运行态资产**。

---

## 7. 纪律与证据链自证

| 项 | 证据 |
| --- | --- |
| 角色独立 | red-team `m9-redteam` ≠ implementer `m9-impl` ≠ verifier `m9-verifier`（G-09） |
| 不改生产代码 | 所有对抗测试写在 `.redteam-m9-iso/src` 副本；生产 `cmd/ internal/ docs/` 零改动（git status 仅有他人 UI P0 dirty，见 §8） |
| 唯一可写报告 | 本文件 `.agents/verify/m9-redteam.md`，精确 `git add` + `git commit -s [agent:m9-redteam]`，不 push |
| 不执行真实主流程 | 全程 `runScenarioBatch` + 注入替身，未运行 `kored install/serve/upgrade`，未打开 state.db |
| 不联网 | `GOPROXY=off` + 离线缓存；无 `curl`/`git fetch`/`go` 网络请求 |
| 不碰运行态 | 隔离目录独立 config/state/run；未触碰 `.kore-local-*`；场景 6 只读 grep（未进入 `.kore-local-state` 内容） |
| 临时物清理 | 隔离副本 `$ISO` 用完 `rm -rf`；工作区不留一次性脚本 |

## 8. 提交与工作区核对

- 提交：`docs(verify): M9 红队对抗验证 6 场景（1 设计缺口待裁决）`，`-s` 签名，message 含 `[agent:m9-redteam]`。
- 提交前 `git status --short`：他人 UI P0 在途改动（`docs/PLUGIN-MATURITY.md`、`scripts/usability-check.sh`、`scripts/usability-pending.txt`、`web/files.js`、`web/shell.js` 与若干 `.agents/verify/*`、`data/`、`dist/`）**原样保留，未暂存/未提交**；本任务只精确 add 本报告一个文件（G-12）。
- 不 push、不 force、不 amend/reset（AGENTS §3 提交纪律）。

## 9. 最终结论

**6/6 对抗场景完成，0 个阻断级缺陷；发现 1 处设计缺口（§6：内核 finalize 成功路径未触发 `CleanupAfterInstall` 清理），已如实报告 lead 裁决，红队不自改代码。**

**整体判定：PASS（附 1 条待裁决观察）。**
