# M9 独立验收报告：`--scenario` 离线批量 CLI（G-09）

- 验收对象：commit `cae416b06a6728904319f8d2e09de64f25903222`（`[agent:m9-impl] feat(cmd/kored): --scenario 补齐离线批量预设安装`），父提交 `2d92626f`，HEAD == 被测提交。
- 角色：verifier = `m9-verifier`，独立于 implementer `m9-impl`（G-09）；只读复跑，不改生产代码。
- 任务：task-83。工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`。
- 时间：2026-11-26（Asia/Shanghai）。

## 0. 结论总表

| 验收项 | 结果 |
| --- | --- |
| 隔离环境 `go test -count=1 -timeout 200s ./cmd/kored/...`（GOPROXY=off） | PASS（exit 0，`ok .../cmd/kored 9.805s`） |
| `go vet ./cmd/kored/...` 与 `go vet ./...`（GOPROXY=off） | PASS（exit 0 / exit 0） |
| `gofmt -l` 四个写域文件 | PASS（输出空，exit 0） |
| 9 用例断言覆盖面读码核对（逐项 file:line） | PASS（9/9，见 §3） |
| 两条旧桩断言改为新行为断言、无 E_UNSUPPORTED 运行期残留 | PASS（见 §4） |
| G-24（无 any / RawMessage 逃逸）/ 未改对外 schema | PASS（见 §5） |
| git：cae416b 恰好 4 写域文件、未碰 M1-M7 / UI P0 写域、他人 dirty 原样、worktree 仅主树（G-25） | PASS（见 §6） |
| 纪律：只读复跑、无 push / 真实 CLI / `.kore-local-*` 写入、临时目录清理 | PASS（见 §7） |

**总判定：PASS**。所有强制复跑命令 exit 0，断言覆盖面经逐条读码核对成立，未发现需要回派 implementer 的缺陷。

## 1. 环境与联网口径（精确披露）

默认环境（只读探测，未改动默认缓存）：

```
go version go1.26.8 linux/amd64
go env GOPROXY    = https://goproxy.cn,direct
go env GOCACHE    = /home/pt/.cache/go-build
go env GOMODCACHE = /home/pt/go/pkg/mod
默认 modcache 缺 bbolt v1.5.0.zip、x/sys v0.45.0.zip（yaml.v3 v3.0.1.zip 已存在）
```

按任务卡已授权口径（沿用 task-77 / task-81 / task-66 先例）：仅从 `https://goproxy.cn` 拉缺失**构建依赖**到工作区内临时 GOMODCACHE，GOCACHE 指向工作区内可写目录；所有测试 / vet 阶段一律 `GOPROXY=off` 离线复跑。临时目录 `.verify-m9-tmp/` 已加入 `.git/info/exclude`（不入 git 状态）。

| 命令（原文） | exit | 说明 |
| --- | --- | --- |
| `mkdir -p .verify-m9-tmp/gocache .verify-m9-tmp/gomodcache` + 写 `.git/info/exclude` | 0 | 隔离目录落工作区 |
| `env GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOWORK=off GOPROXY=https://goproxy.cn GOSUMDB=off GOFLAGS=-mod=mod go mod download go.etcd.io/bbolt golang.org/x/sys gopkg.in/yaml.v3` | 0 | 仅下载 3 个依赖到隔离缓存；未碰 git 远端、未 push |
| 校验 zip：`bbolt v1.5.0.zip` 255081 B / `x/sys v0.45.0.zip` 2021312 B / `yaml.v3 v3.0.1.zip` 104623 B | 0 | 三个 zip 全部就位 |

**联网范围**：仅上表一条 `go mod download`（走 goproxy.cn）。未访问 git 远端、未 push、未执行 `kored` CLI、未碰 `.kore-local-*`。

统一离线环境（后续 Go 命令均带）：

```
BASE=/home/pt/Work/GolandProjects/kore-pl/kore/.verify-m9-tmp
GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOWORK=off GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod
```

## 2. 门禁命令与退出码（离线）

证据格式：命令 + 退出码 + 关键输出。

```
命令: env GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOWORK=off GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod go test -count=1 -timeout 200s ./cmd/kored/...
退出码: 0
输出: ok github.com/pengtang1024/kore/cmd/kored 9.805s
```

```
命令: env GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOWORK=off GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod go vet ./cmd/kored/...
退出码: 0
输出: （无）
```

```
命令: env GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOWORK=off GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod go vet ./...
退出码: 0
输出: （无）
```

```
命令: gofmt -l cmd/kored/install.go cmd/kored/install_scenario.go cmd/kored/install_scenario_test.go cmd/kored/install_test.go
退出码: 0
输出: （空，四个文件均符合 gofmt）
```

`-v` 复核：M9 的 9 个用例 + 2 条改名后的旧桩用例逐条 `--- PASS`（见 §3/§4）；`cmd/kored` 全包 PASS，无 FAIL。

## 3. 断言覆盖面读码核对（9 用例 + 关键语义）

证据来自 `cmd/kored/install_scenario.go`（实现）与 `cmd/kored/install_scenario_test.go`（断言），逐条 file:line。所有 9 用例均真跑 `--- PASS`。

| # | 验收点 | 断言证据（file:line） | 判定 |
| --- | --- | --- | --- |
| 1 | 读 `presets/<id>.json` | `install_scenario.go:434-457` `loadScenarioPreset` 按 `id+".json"` 读、校验 `preset.ID==id`、`schema_version==1`；测试 fixture 在 `install_scenario_test.go:37-42` 真写 preset 文件并经 `runScenarioBatch` 读取 | PASS |
| 2 | 版本区间解析（精确 / `^` / `~` / 比较器） | `install_scenario_test.go:213-248` 表驱动 11 组：`0.1.0` 精确、`^0.1.0`、`~0.1.2`、`>=0.1.0 <0.2.0`、`>0.1.0 <=0.2.0`、`=0.1.0` 共 6 类写法；非法写法 `""`/`latest`/`1.x`/`*`/`||`/`>=0.1` 全部断言被拒。解析实现 `install_scenario.go:261-317`（`^` 对 0.x 取下一 minor，:276-279） | PASS |
| 3 | `depends_on` 拓扑排序 | `install_scenario_test.go:106-148`：preset 中 `site` 在 `ssl` 之前，索引声明 `site→ssl`；断言 `sslIndex < siteIndex`、三项各装一次。`install_scenario.go:372-431` Kahn 排序 + 同层按文件顺序稳定输出（:410/:418/:423）；外部依赖不在批次内不计边（:395） | PASS |
| 4 | 离线包选最高满足版本 | `install_scenario_test.go:250-268`：包目录含 `0.1.0/0.1.7/0.1.2`，约束 `^0.1.0`，断言实际安装 `echo@0.1.7`。实现 `install_scenario.go:194-241`，:224 按 `scenarioCompare` 取最大 | PASS |
| 5 | 逐条调 `runPackageInstall`（经注入点，不真实落盘） | 生产注入点 `install_scenario.go:89` `scenarioSingleInstall = runPackageInstall`，调用点 :152-156 每条一次、传 `packagePath`；测试 `install_scenario_test.go:76-94` 替换为记录型替身，断言调用序列（:131/:137/:140） | PASS |
| 6 | 部分失败汇总、不整批回滚 | `install_scenario_test.go:150-185`：`echo=0, site=exitStore(4), ssl=0` → 断言返回最高失败码 4（:167）、仍装 3 项（:170）、汇总含 `共 3 项/成功 2 项/失败 1 项`（:174）、stderr 有 `site 0.2.0`/`退出码 4`（:179）、显式 `成功项不会被回滚`（:182）。实现 `install_scenario.go:139-181` 用 `continue` 不回滚、:178-180 返回 worst | PASS |
| 7 | 失败码透传 | `install_scenario.go:138` `worst := exitConfig`；:145-147 解析失败码比较、:169-171 单条码比较并取最大；测试用 `exitStore=4` 验证透传最高码（第 6 项）。退出码常量 `cmd/kored/main.go:20-24`（`exitOK=0`/`exitConfig=2`/`exitStore=4`） | PASS |
| 8 | 缺包报错 | `install_scenario_test.go:270-292`：只提供 `site` 包、`echo` 缺包 → 断言 `exitConfig(2)`（:283）、缺包项零安装调用（:286）、stderr 含 `没有 echo 的包`、stdout 汇总 `失败 1 项`（:289）。实现 `install_scenario.go:229-236` 区分「无包」与「有包但不满足区间」两种报错 | PASS |
| 9 | 成环规划期拒绝（零安装） | `install_scenario_test.go:294-318`：`echo↔site` 成环 → 断言 `exitConfig(2)`、安装调用数 0（:312）、stderr 含 `循环依赖`（:315）。实现 `install_scenario.go:427-429` 在 `orderScenarioPlugins` 返回错误、`runScenarioBatch:125-127` 走 `scenarioPlanError` 在解析/解析包之前短路；自依赖在 :392-394 单独拒绝 | PASS |
| 补 | 路径穿越拒绝 | `install_scenario_test.go:320-329`：scenario id=`../etc/passwd` → 断言 `exitConfig` 且 stderr 含 `非法`；实现 `install_scenario.go:39-40` 正则 `^[a-z][a-z0-9-]*$` 用于 `loadScenarioPreset:436` 与 `orderScenarioPlugins:376`、索引 id 亦校验（:477） | PASS |
| 补 | 停服提示 ≥8 字含「请/应/需」 | `install_scenario_test.go:187-211` 断言 rune 数 ≥8（:189）、含「请应需」任一（:193）、含 `bbolt/独占/state.db/systemctl --user stop`（:197）、入口先给提示（:208）。独立复算 `scenarioStopHint` 共 144 rune，含「请」「需」及上述四串 | PASS |

**断言覆盖面结论**：不是只看绿。9 个用例的断言分别钉住区间解析各类写法、依赖序、最高版本选取、逐条调用、失败码、部分失败、缺包、成环、路径穿越、停服文案——与任务卡要求的覆盖面逐条对应，断言在源码中确实存在且对错误行为会 FAIL（非恒真断言）。

## 4. 两条旧桩断言已改为新行为（无 E_UNSUPPORTED 残留）

`git show cae416b -- cmd/kored/install_test.go` 的 diff 显示仅改动两个测试函数，未动其他测试（hunk `@@ -173,41 +173,62 @@` 唯一）：

1. `TestRunScenarioInstallUnimplemented` → 更名 `TestRunScenarioInstallOfflineBatch`：新断言要求 `需先停止 Kore 服务`/`bbolt`/`独占`/`state.db`/`未提供预设目录`/`--presets-dir` 全部出现，并把 `E_UNSUPPORTED`/`未实现（M2 支持批量预设安装）`/`替代路径（当前可用）` 列为**反向断言**（出现即 FAIL）。测试 `--- PASS`（见 §2）。
2. `TestInstallUsageMarksScenarioUnimplemented` → 更名 `TestInstallUsageMarksScenarioOfflineBatch`：新断言要求 `--scenario <预设id>`/`离线批量`/`需先停服`，同样反向断言旧桩文案不存在。测试 `--- PASS`。

两条路径均非 E_UNSUPPORTED 残留：

- `cmd/kored/install.go:70-71` `runScenarioInstall(opts, stdout, stderr)` 直接 `return runScenarioBatch(opts, stdout, stderr)`，旧 E_UNSUPPORTED 分支已删除；`import pluginapi` 已移除。
- 帮助文案 `install.go:187-190` 已改为「离线批量，需先停服 / CLI 独占 state.db」；flag 描述 `:41-44` 同步更新。
- grep：`E_UNSUPPORTED` 在 `install_scenario.go` 仅出现于第 3 行**注释**（说明从 E_UNSUPPORTED 补齐），在 `install_test.go` 仅出现于反向断言字符串/注释；生产代码零运行期 E_UNSUPPORTED 分支。

## 5. G-24（无 any / RawMessage 逃逸）与对外 schema

| 检查 | 命令 / 证据 | 判定 |
| --- | --- | --- |
| 四写域文件无 `map[string]any` / `any` / `json.RawMessage` 类型 | `grep -nE 'map\[string\]any|\bany\b|json\.RawMessage' <4 files>` 仅命中 `install_scenario.go:6/:70` 两条**注释**（"禁 any"/"不用 any"），零类型命中 | PASS |
| 未改对外 schema | `scenarioPreset`/`scenarioPresetItem`/`scenarioIndex`/`scenarioIndexItem`/`scenarioVersionConstraint`/`scenarioFailure` 均为包内私有类型（`install_scenario.go:44-85`），字段全为显式 `int/string/[]T/bool/error`。真实 `kore-plugins/presets/*.json` 8 个文件 `schema_version=1`、id 均匹配 `^[a-z][a-z0-9-]*$`（python 逐文件校验 ALL_OK=True）；`install.go` 只增 flag 与私有字段，未改 market/store 对外结构 | PASS |
| 停服文案与 bbolt 锁一致 | `install_scenario.go:33-37` 注释 + 文案引用 `store.go:95-100` 独占锁；测试 :196-200 钉住 | PASS |

## 6. git 核对

| 项 | 命令 / 证据 | 判定 |
| --- | --- | --- |
| cae416b 恰好 4 写域文件 | `git diff-tree --no-commit-id --name-status -r cae416b` → `M install.go` / `A install_scenario.go` / `A install_scenario_test.go` / `M install_test.go`；numstat 23+20 / 553+0 / 348+0 / 35+14 | PASS |
| 未碰 M1-M7 / UI P0 写域 | `git show --stat cae416b` 仅 4 文件，全部在 M9 写域内；M1-M7（`serve_boot.go`/`serve_runtime.go`/`batch.go`/`cleanup.go`/`coreasset.go`/`upgrade_supply.go`）与 UI P0（`web/shell.js`/`web/files.js`/`scripts/usability-check.sh`/`docs/PLUGIN-MATURITY.md`/`docs/DESIGN-REDUCTION.md`）均不在提交内；UI P0 的改动仍以他人 dirty 状态存在（见下） | PASS |
| 他人 dirty 原样 | 验收前 `git status --porcelain`：M `docs/PLUGIN-MATURITY.md`/`scripts/usability-check.sh`/`scripts/usability-pending.txt`/`web/files.js`/`web/shell.js`，加多份 `.agents/verify/*` 与 `data/`/`dist/` untracked；验收后状态一致（另多出 UI P0 worker 在本轮期间产出的截图/自评文件，属他人在途，未由本验收触碰）。本验收唯一新增文件为报告 `.agents/verify/m9-verification.md`，精确 add + commit，不夹带他人文件 | PASS |
| worktree 仅主树（G-25） | `git worktree list` → 仅 `/home/.../kore cae416b [main]` 一行；`git branch --list 'wt-*' 'tmp-*'` → 空 | PASS |
| 提交签名 | cae416b 带 `Signed-off-by: pengtang1024@qq.com`；报告提交按任务卡 `-s [agent:m9-verifier]` | PASS |

## 7. 纪律声明

- **只读复跑**：未改任何生产代码；唯一落盘为报告 `.agents/verify/m9-verification.md`（精确 `git add .agents/verify/m9-verification.md` + `git commit -s`，提交信息带 `[agent:m9-verifier]`）。
- **不 push**：未执行任何 `git push` / 远端写操作；goproxy 下载仅限构建依赖。
- **不执行真实 CLI**：未运行 `kored install/serve/upgrade` 主流程；全部验证通过 `go test` + 记录型替身（stub）完成，未落盘安装包 / 未写状态库。
- **不碰 `.kore-local-*`**：验收前后 `.kore-local.yaml`（mtime 2026-11-25 20:15）、`.kore-local-state/`（2026-11-23 20:08）、`.kore-local-run/`（2026-11-25 21:30）均未被本验收改动。
- **临时目录清理**：`.verify-m9-tmp/`（隔离 GOCACHE/GOMODCACHE）用完在报告提交前删除；`.git/info/exclude` 中对应行一并移除（恢复原状）。过程留痕：Go 解包的 modcache 源文件为 0444，首次 `rm -rf` 报「权限不够」未删净（`exit 1`），随后 `chmod -R u+w .verify-m9-tmp` + `rm -rf` 成功（exit 0）；复核 `[ -d .verify-m9-tmp ]` 为假、exclude 无残留。

## 8. 边界与未覆盖（诚实声明）

- 本验收只跑 `./cmd/kored/...` 的 go test / vet（任务卡指定面），**未**跑全量 `make check` 21 段、未跑 `-race`、未跑交叉编译——这些由各自门禁负责，不在 task-83 复跑范围。
- 路径穿越只验了 scenario id 一层（`../etc/passwd` 被正则拒绝）；`--presets-dir` / `--packages-dir` / `--index-dir` 传绝对路径或 symlink 的对抗由 red-team（task-84）覆盖，本验收不重复。
- 停服提示文案按 G-33 A3 口径复算 rune/引导词，未做真浏览器/UI 取证（CLI 文案非 UI 交付）。
