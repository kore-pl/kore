# .agents · 质量门禁

> 状态: draft · 归属: scribe · 更新: 2026-11-24 · 里程碑: M0

门禁不是建议清单，是"能不能交付"的判定条件。命令必须原样执行——改参数、加跳过、换更宽松的选项，都视为伪造通过。

## 1. 门禁表（G1–G19 + G-28/G-29/G-30/G-31/G-32）

| ID | 名称 | 命令 | 期望 | 失败处理 | 执行者 | 层级 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | build | `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" ./...`（等价 `make build`，后者另注入版本号并输出 `bin/kored`） | 退出码 0，无输出 | 修到绿；不得用参数压制告警或跳过包 | implementer | 检查点 |
| G2 | vet | `go vet ./...` | 退出码 0，无诊断 | 修到绿；vet 报错不得用 `//nolint` 掩盖 | implementer | 检查点 |
| G3 | test | `go test -timeout 200s ./...` | 退出码 0，无 FAIL / panic | 修实现或修测试（不得删断言、不得 `-short` 跳过失败用例） | verifier | 合并前 |
| G4 | docs-check | `make docs-check` | 退出码 0，输出 PASS | 补元信息 / 修链接 / 去占位词后重跑 | implementer + verifier | 检查点 |
| G5 | 依赖白名单 | `go list -m all` 与 3 项白名单（`yaml.v3` / `bbolt` / `protobuf`）逐项比对 | 白名单外直接依赖数 = 0 | 移除或提 ADR 申请扩白名单，未批准不得合入 | verifier | 合并前 |
| G6 | 资源预算实测 | `make mem`（等价 `ps -o rss= -p $(pgrep -x kored)` 取 60s 中位数）。内存证据：三档 `GOGC=50`（默认档）/ `100` / `200`（对照臂）**各 60 点中位数**；`VmRSS` 为主值，`RssAnon` / `RssFile` **只作诊断拆分、不设绝对上限**；来源须标注（`smaps_rollup` / `status`）；**原始数据落 `.agents/verify/`**（如 `m1-memory-baseline.md`） | 空载 RSS ≤ 8192 KiB（目标 5–6 MiB，**运行时默认 `GOGC=50` + `GOMEMLIMIT=6MiB`**，对照臂 100 / 200）；**常驻插件单 ≤ 12288 KiB、合计 ≤ 24576 KiB**；oneshot 空闲 0；**空闲 CPU ≤ 0.1%、空载 goroutine ≤ 20**；缺档 / 未标注来源 / 单次采样 → 证据不成立 | 定位泄漏/膨胀点，回阶段四优化；调参顺序：先确认 `GOMEMLIMIT=6MiB` 生效，仍超再把 `GOGC` 降到 50 以下并复测三档；**GOGC 调高只放大堆峰值，守上限的是 GOMEMLIMIT**；不得靠调大预算通过 | verifier | 里程碑 |
| G7 | 薄壳边界 | `grep -rn "plugins/" internal/core` + 业务词扫描（`create/list/restart/deploy/backup/site/nginx/mysql/docker`） | 两份 grep 命中数均为 0 | 把业务逻辑移进插件；core 只留规则 | verifier | 合并前 |
| G8 | 二进制体积 | `ls -l bin/kored` | `bin/kored` ≤ 26214400 字节（25 MiB） | 检查依赖与 embed 内容；不得用 UPX 之类混淆手段凑数 | verifier | 里程碑 |
| G9 | 前端体积 | `du -sb web/dist` + 首屏资源 gzip 后合计 | 首屏 ≤ 307200 字节（300 KiB gzip） | 拆分路由懒加载、按需引入组件；不得删功能充当优化 | verifier | 里程碑 |
| G10 | 无联网 / 无遥测 | 对 `internal/core` 执行出网客户端与上报关键词扫描：`http.Client`、`net.Dial`（UDS 除外）、`telemetry`、`analytics`、`report`、`phone-home` | 命中数 = 0（UDS 与本机 127.0.0.1 监听不计） | 删除出网代码；确需联网的功能必须进插件并走能力白名单 | verifier | 里程碑 |
| G11 | 仓库边界（含 `replace` 边界） | `grep -rn "plugins/" internal/ cmd/`；另查仓库内是否存在 `plugins/*/main.go` 形态的插件代码；插件仓查 `go.mod` 的 `replace`：`grep -rn "=> \.\./" ` 与绝对路径形式 | 前两项命中数均为 0；跨仓 `replace`（`=> ../` 或绝对路径）命中数 = 0；**同仓嵌套 module 的 `replace => ./pkg/pluginapi` 不拦** | 插件代码迁出到 `kore-plugin-<id>`；跨仓联调改走 `go.work`（不提交）；同仓 `replace => ./` 保留 | verifier | 合并前 |
| G12 | 协议兼容 | 读插件仓库 `info.json` 的 `requires_kore`，与 `kore` 的 `VERSION` 做区间比对；**lifecycle 解析（M1 起）**：`lifecycle` 接受 `resident` / `lazy` / `oneshot` 三值并落盘，M1 运行期只支持 `resident`，遇 `lazy` / `oneshot` 返回 `E_UNSUPPORTED`（message 写明"M2 支持"） | 语义化区间包含当前 `kore` 版本；破坏性改动必须主版本 + ADR；`lazy` / `oneshot` 在 M1 返回 `E_UNSUPPORTED` 属**预期**，不算缺陷 | 插件侧改 `requires_kore`；或按 ADR 升主版本并同步索引；M1 期把 `lazy` / `oneshot` 的断言改成"接受字段 + 返回 E_UNSUPPORTED" | verifier | 里程碑（跨仓库变更前移到合并前） |
| G13 | 兼容性（三平台） | ① `make cross-build`（`make check` **第 17 段，阻断级**；复用 `make cross` 五目标**全仓** `go build ./...` + `kored` 五产物真编译——含 ③④ 两条 G-16 明文命令的 GOOS/GOARCH；失败贴**首个编译错误原文**并 exit 1）；② `make compat-info`（**信息入口，不阻断**：build flags 与 link flags + `file` + `go version -m`）；③ `GOOS=windows GOARCH=amd64 go build ./...`；④ `GOOS=darwin GOARCH=arm64 go build ./...`；⑤ `grep -rn --exclude-dir=platform "syscall\." internal/core`；⑥ `grep -rn "可能不支持" docs/`；⑦ `make cross-vet`（**信息入口，不阻断**：`GOOS=windows/darwin go vet ./...`，唯一覆盖**测试包**跨平台类型检查的手段——`go build` 不编译 `_test.go`；实测热 +1.7s / 冷 +4.0s，故不入第 17 段）。flags 口径：**build flags** = `CGO_ENABLED=0 GOAMD64=v1 GOARM64=v8.0 -trimpath -buildvcs=false`（`-buildvcs` 是 build flag，塞进 `-ldflags` 会报 `flag provided but not defined`）；**link flags** = `-s -w` | ① 退出码 0（五目标**真编译**，不只验参数）；② build flags 与上述一致、`file` 为静态无 interpreter、`go version -m` 无 `-buildvcs` 污染；③④ 退出码 0（M1 起）；⑤ 零命中；⑥ 零命中 | ①③④ 挂 → 把平台分支收进 `internal/platform` 或修构建标签；⑤ 有命中 → 迁进 `internal/platform`；⑥ 有命中 → 把“可能不支持”改成明确降级行为。**2026-11-23 教训**：旧 `make check` 第 2 段只 grep Makefile 里「是否列了五个 target 名字」，真正编译的 `cross` 只挂在 `compat-info` 上而 `check` 从不调用——`cmd/kored/uninstall.go` 引用仅 linux-tagged 的 `platform.UnitFileName`，windows/darwin 全红数小时无人发现。**门禁必须真跑构建，不能只验参数文本** | verifier | 里程碑 |
| G14 | 空闲行为 | `make idle`（可用，约 65s）；等价手工取证：`/proc/<pid>/stat` 取 utime+stime 前后差、`/proc/<pid>/task` 计数、`/proc/<pid>/fd` 计数、`ss -tnp` | 空载 60s CPU 时间 ≤ 60ms、goroutine ≤ 20、fd ≤ 64、出站连接 0、定时器仅 `scheduler`（单实例单 ticker，ADR-0019；`cert_renew` 已迁移为内置任务）；`make idle` 扫描白名单 = `internal/core/scheduler/` 目录 + `cert_renew`，其余 `NewTicker/AfterFunc` 仍判 FAIL；不得有轮询循环，lazy 插件不得用内部 ticker 续命 | 去掉轮询改事件推送；lazy 插件必须在空闲后真正退出；超预算先砍定时器再谈优化 | verifier | 里程碑 |
| G15 | 深度等级（M3 起） | `grep -r "depth_level" <插件仓>/info.json`；查对标矩阵标注；查 `production` 插件的 `tests/fault/` 目录 | `depth_level` 存在且 ∈ {`production`,`basic`}；`basic` 在对标矩阵中不得标"生产级"；`production` 必须有 `tests/fault/` 且故障注入用例可跑 | 缺 `depth_level` → 不进商店；标错等级 → 改矩阵并复核；没有 `tests/fault/` → 降级为 `basic` 或补测试 | verifier | 里程碑（M3 起） |
| G16 | 无副作用的诊断代码（M1 起） | `grep -rn "SetGCPercent(-1)" --include='*.go' .` 与 `grep -rn "SetMemoryLimit(-1)" --include='*.go' .` **双零命中**；另查同形态"设置即读取"API（`debug.SetMemoryLimit` / `debug.SetGCPercent` / `debug.SetMaxThreads` 等传负数的写法） | 两条 grep 命中数均为 0；读取运行时配置只允许 `runtime/metrics`，或记录"自己设置过的值" | 视为 **P0**（会静默改变运行时行为）：日志里的 `SetGCPercent(-1)` 实测会**关闭 GC**；改为记录自己设置的值或走 `runtime/metrics`，并补回归测试（`setRuntimeLimits()` 后分配内存必须观察到 GC 次数增长） | verifier | 合并前 |
| G17 | 无 any / object 逃逸 | `grep -rn "map[string]any" --include='*.go' internal/ cmd/`（排除 `_test.go` 与 `testdata/`）；`grep -rn "类型：object" docs/`；`grep -rn "json.RawMessage" --include='*.go' internal/ cmd/` | 对外 schema / 对外结构体零 `object` / `any` / `map[string]any`；docs 无「类型：object」；`json.RawMessage` 仅出现在插件方法参数与结果载荷处且写明原因 | 评审退回：字段改成显式结构体，或改用带类型前缀的标量；解析期临时 `any` 必须在一处收口转具体类型 | verifier | 合并前（判定型部分由评审回答） |
| G18 | worktree 卫生 | `make wt-check`（F 落地）；等价手工：`git worktree list` + `git branch --list 'wt-*' 'tmp-*'` | `git worktree list` 仅 1 行（主工作树）；临时分支清单为空；残留的 `/tmp/*` 检出目录已删除 | 先 `git worktree remove`，再 `git branch -d`，最后 `git worktree prune`；有改动未合并则先合并或写明放弃原因 | verifier | 里程碑收口 |
| G19 | 开源资产完整 | `make oss-check`（第 8 段，阻断级）+ `make check` 第 13 段 `plugin-oss-check`（25 仓九件套/CI）；等价手工：逐个检查根 `LICENSE` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `CHANGELOG.md` / `.github/workflows/ci.yml`，并 `grep -n "MIT License" LICENSE` 与 `grep -n "Permission is hereby granted" LICENSE` | 六件资产齐备；`LICENSE` 含上述两个特征串；无 GPL / Apache / AGPL 等非 MIT 协议头混入 | 缺件即补；协议头冲突则统一为 MIT 并在 PR 中说明；不得以「以后再补」放行 | verifier | 里程碑收口 / 发布前 |
| G-28 | UI 交付双端证据 | 触发：任何涉及用户界面（页面 / 视图 / 组件 / 样式 / 交互 / 文案）的交付，在声明"完成"前；取证：`.agents/verify/screenshots/` 下同时存在 `<场景>-desktop-*.png`（1440×900 或 1280×800，full-page）与 `<场景>-mobile-*.png`（390×844），并用 `file <png>` / `identify -format '%wx%h'` 读实际宽高；另附一段产品定位自评（本页解决什么用户问题 / 与宝塔、1Panel 同类功能的差距 / 当前是"可用"还是"占位"） | 三件套齐备，分辨率与命名匹配；自评三段齐全、不出现"应该是 / 大概"式措辞 | 缺任一项即不得声明完成：补截图（不得缩放糊弄分辨率、不得拿桌面图裁成手机图）或补自评；证据缺失时任务记 BLOCKED，不记 PASS | implementer 取证 + verifier 核对 | 检查点（UI 交付） |
| G-29 | 运行态写边界 | 触发：任务涉及 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 或任何被运行中 `kored` 持有的文件（`git status` 看不出，untracked）。取证：① `curl -s localhost:8787/api/v1/system/info \| jq .paths.index_dir` 必须**逐字等于**配置里的 `kore-plugins/index`（不得指向 `.kore-local-state/` 下任何索引快照）② 商店 `/api/v1/store/plugins` 返回的插件版本必须等于 `kore-plugins/index/plugins.json` 里的版本 ③ 验收报告必须显式声明"本轮是否改动过主实例的运行态配置"，改过则附回切 + 重启 + 复核三行证据 ④ 测试要"不同索引 / 配置 / 状态"时附隔离实例命令（独立 `--config` + state/run/log 落 `/tmp`）⑤ 运行态资产必须进 `.gitignore`——`.kore-local*` 覆盖 yaml/state/run/log/index 全系列，`git check-ignore` 对 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` 必须全部命中（否则一次 `git add .` 就把 123 MiB 的 state.db 带进提交） | ①② 必须相等（`paths.index_dir` == `kore-plugins/index`、商店版本 == 索引版本）；③ 声明齐全且与事实一致；④ 有隔离实例证据或写明"未触碰主实例"。防的事故：2026-11-23 为测试把 `index_dir` 指向 `signed-index` 快照（04:53:06），恰逢另一轮重签完成（04:53:40），04:59:59 回切前 8787 商店把 discover 0.2.0 显示成 0.1.0——配置回写了、主实例读到的仍是旧数据 | 任一不符即判未完成：回切 + 重启 + 复核后再验一次；未回切或只改配置文件不验 `/api/v1/system/info` 的，任务记 BLOCKED，不记 PASS；workaround 无过期条件（"当 X 发生时失效"）的，记 WARN 并要求补写 | implementer 取证 + verifier 独立复跑 | 检查点（运行态变更） |
| G-30 | 明文凭据入库 | 触发：任何写 `docs/` 或 `.agents/verify/` 的提交 / 验收报告；取证：`make secret-check`，扫描 `MYSQL_ROOT_PASSWORD=` / `MYSQL_PWD=` / `REDIS_PASSWORD=` / `REDISCLI_AUTH=` / `KORE_MYSQL_PASSWORD=` / `KORE_REDIS_PASSWORD=` / `ADMIN_PASSWORD=` 以及 JSON 的 `"password"` / `"secret"` / `"token"` 键 | 非占位值零命中；占位只允许 `***` / `[REDACTED]` / `$VAR` / `<placeholder>` / `********` / `...` / `…`。防的事故：2026-11-23 `.agents/verify/round3-live.md` 把 `common-mysql` 的 root 明文口令写进验收报告并推送公开仓库（`3fa40f2`） | 命中即阻断：把凭据字面量替换为 `***` 后重跑；**禁止**为了让门禁变绿删证据或改判定结论——本门禁扫 `.agents/verify/` 是 §5.6 豁免规则的唯一例外，只许替换凭据字面量 | implementer 自跑 + verifier 复跑 | 检查点 |

> **F-2 边界（第 17 段 / G13 兼容性，即 G-16 交叉编译门禁的覆盖范围，勿误读）**：`make check` 第 17 段（`make cross-build` 复用 `make cross`）的编译口径自 2026-11-24 起是**全仓**——五个目标下每个**非测试**包都要编译过（`go build ./...`），同时仍产出 `./cmd/kored` 五目标二进制。旧口径只编译 `./cmd/kored` 依赖闭包，只被测试 / 工具 / 未来入口引用、不在该闭包内的包会被漏掉（反例实测见下）。因此「17 段绿」=「全仓非测试包可跨平台 + 主程序可构建」。
>
> **仍未覆盖的一层（真边界，别假装覆盖）**：`go build` **不编译 `_test.go`**，所以「全仓可跨平台」≠「测试包可跨平台」。只在测试文件里出现的平台专有用法（如 linux-only 助手被无 tag 的 `_test.go` 引用）第 17 段抓不到；补位手段是 `make cross-vet`（**信息入口，不进第 17 段**）：`GOOS=windows/darwin GOARCH=… go vet ./...`，`go vet` 会类型检查测试包。不进 check 的原因已实测：热 +1.7s（windows 1.06s + darwin 0.69s）、冷 +4.0s——与第 17 段本体（热 1.65s）同量级，会让该段热态翻倍；改测试包时显式跑一次即可。
>
> **实现口径（别用 `-o 目录/` 抄近路）**：必须是无 `-o` 的 `go build ./...`。go1.26.8 实测：`go build -o <目录>/ ./...` 在多包模式下只产出 main 包二进制、**静默跳过非 main 包的编译错误**（同一 undefined 探针：`go build ./...` rc=1，`-o dir/` rc=0）——那是假绿门禁。代价是 main 产物会落到 cwd，`cross` 每次构建后按 `go list` 算出的 main 包名清理（不硬编码 `kored`，未来新增 `cmd` 子命令也自动覆盖）。
>
> **代价与反例（2026-11-24 实测，go1.26.8 / 本机）**：fresh `GOCACHE` 冷编译五目标 `./cmd/kored` 18.82s → `./...` 19.43s（+0.61s，+3.2%）；全段（全仓 + 五产物）19.67s（+0.85s）。热缓存稳态 `make cross` 0.24s → 1.65s（+1.4s，主因是每目标一次 `kored` 链接 ~260ms——旧口径因 `bin/kored-*` 已是最新被跳过；删掉产物后旧口径最坏态 0.83s，同态增量 +0.9s）。反例：`internal/probe`（linux-only 常量 + `!linux` 引用，不在 `cmd/kored` 依赖闭包内）→ 旧口径五目标 exit 0（漏检）、新口径 exit 2 且 `首个编译错误: internal/probe/probe_other.go:5:34: undefined: crossProbeLinuxOnly`；测试包探针 → `go build ./...` exit 0、`go vet` exit 1（边界如实成立，由 `cross-vet` 补位）。

### 1.1 G-17（插件仓规范）/ G-18（预设一致性）判据与严重级别

> **编号说明**：本节用**带横杠**的 `G-17` / `G-18`，指 [AGENTS.md](../AGENTS.md) §2 硬门禁表里的「插件仓规范」与「预设一致性」；**不要**和上表里的 `G17`（无 any/object 逃逸）/ `G18`（worktree 卫生）混淆——两套编号并存是历史遗留，本次不改号以避免大范围漂移。

| ID | 名称 | 命令 | 期望 | 失败处理 | 执行者 | 层级 |
| --- | --- | --- | --- | --- | --- | --- |
| G-17 | 插件仓规范（`make store-check`） | `bash scripts/store-check.sh`（无参数扫 `../kore-plugin-*`；可传目录） | 逐仓 7 项：① 三件套 `info.json` / `Makefile` 的 `dist` 目标 / `CHANGELOG.md`；② `info.json` 必填 14 字段（**清单以 [docs/PLUGIN-PROTOCOL.md](../docs/PLUGIN-PROTOCOL.md) §3.1 为唯一真源**，= 协议 9 项 ∪ G-17 4 项 ∪ G-20 `depth_level`；`description` **不在其中**，改按描述类字段四选一 `description`/`title`/`summary`/`name` 判，全缺只 WARN）；③ `id` 匹配 `^[a-z][a-z0-9-]*$` 且 == 目录名后缀 `kore-plugin-<id>`；④ `info.json.version` == `manifest.json.version`（manifest 存在时）；⑤ `go.mod` 无 `=> ../` / 绝对路径 `replace`（`=> ./` 放行）；⑥ 本地 `dist/<id>-<ver>.tar.gz` 的 sha256 与索引账本一致（版本命中 `versions.lock.json` 或 `plugins.json` 当前版本时必须相等，不等只 WARN 并输出 `DIST_SHA_DIFF <id> <version> index=<sha> dist=<sha>`，不阻断；索引未记录该版本或本地无该文件则静默跳过）；⑦ README **全文**所有 `dist/<id>-<ver>.tar.gz` 引用（代码块示例 / `make dist` 说明行 / 「发布产物」行同源）的版本与 `info.json.version` 一致（每条不一致单独 WARN 并输出 `README_VERSION_DRIFT <id> info=<ver> readme=<ver> (line N)`，**带行号、多处全部列出**，不阻断；只比 `<id>` == `info.json.id` 的引用，他插件示例不计；README 内解析不出任何本仓 `dist/<id>-<ver>.tar.gz` 时 SKIP，不硬猜）。输出 `[OK]`/`[FAIL]`/`[WARN]` 行 + `store-check: N pass, M fail`，缺失指名到「仓 + 文件 + 字段」 | 单跑时任一 FAIL → exit 1；`make check` 内为 **WARN 级**（见下「严重级别裁决」） | implementer 自跑 + verifier 复跑 | 检查点（M1 起） |
| G-18 | 预设一致性（`make presets-check`） | `bash scripts/presets-check.sh`（无参数扫 `../kore-plugins/presets/*.json` 并对 `index/plugins.json` 解析）；`--self-test` 验解析器正反用例 | 逐 preset 4 项：① 插件 `id` 可在索引解析；② `version` 区间被索引实际版本满足——**只认** 精确 `x.y.z` / `^x.y.z` / `~x.y.z` / 比较器集合（`>=x.y.z <a.b.c`、`>`、`<=`、`=`），其余写法（`*`、`1.x`、`latest`、`>=1.0`、`||`）**必须报 FAIL，不静默跳过**；③ 常驻（索引 `lifecycle=resident` 且 `desired=enabled`）RSS 合计 ≤48 MiB 红线（超即 FAIL）、≤24 MiB 目标（超即 WARN），同时常驻 ≤3（G-03 红线），单插件包体积 ≤25 MiB（G-03 单二进制红线）；④ 失败指名到「preset + id + 区间 + 原因」；⑤ 深度等级一致性（G-20）：索引 `depth_level` 必须等于 `../kore-plugin-<id>/info.json` 的 `depth_level`——不一致且登记在 `scripts/depth-level-pending.txt`（已知待裁决清单）= WARN 不阻断，**未登记 = FAIL 阻断**，清单条目已一致 = WARN 提示移除；⑥ `out_of_box` × `depth_level`（G-20 明文「basic 插件不得被预设标为开箱可用」）：`out_of_box=true` 的预设不得引用索引 `depth_level≠production` 的插件（判据看索引、不看 `desired`） | 任一 FAIL → exit 1；`make check` 内为**阻断级** | implementer 自跑 + verifier 复跑 | 合并前（M2 起） |

**判据来源**：三件套取自 AGENTS.md G-17 原文；**`info.json` 必填字段的唯一真源是 [docs/PLUGIN-PROTOCOL.md](../docs/PLUGIN-PROTOCOL.md) §3.1**（14 项 = 协议 9 项 ∪ G-17 4 项 ∪ G-20 `depth_level`；本文与 AGENTS.md 只引用、不复制清单）；`scripts/store-check.sh` 的 `REQ_FIELDS` 必须与 §3.1 逐字一致，不一致即第四份口径。24 仓对 14 项的实际出现率均为 24/24，故本轮补齐未打红任何仓；**裁决理由（2026-11-23，必须留痕）**：更早的严格版按 10 字段判（含 `description`），24 仓里 **23 仓缺的都是同一个 `description`**——而协议 §3.1 的必填 9 项里根本没有它，属**判据超出协议**而非仓库腐烂。若按必填处理只剩两条路：让 23 仓各补字段（各改 `info.json` → 各改 dist sha → **23 次版本抖动**，全为满足一个协议里并不存在的字段），或让所有人每次提交全红。两者都不值，故 `description` **非必填**，只按描述类四选一（`description`/`title`/`summary`/`name`）兜底。**已知限制**：14 字段下 `name` 本身就是必填且落在四选一集合内，因此「四者全缺」在结构上不可能出现，WARN 分支实际不可达——它只作前向兼容兜底保留，不构成放宽（缺 `depends_on` 等任一必填仍 FAIL，实测 `0 pass, 1 fail`、exit 1）。

**本地 `dist` sha 比对（⑥）与 README 发布产物版本比对（⑦，均 2026-11-24 接入）的判据与理由不在此重述**，源见 `scripts/store-check.sh` 头部注释第 6、7 条：只读、不联网、不改文件；比对**全部历史版本**而非只比当前版本（旧版本野产物在 bump 后仍留在 `dist/` 才是漏洞本体，实例 firewall 0.2.3 / process 0.2.1 / redis 0.5.0 / ssl 0.4.0 / waf 0.3.0）；不一致只 WARN 不阻断——硬判据仍是「已发布物与索引自洽」，归 `validate-index.sh`。⑦ 2026-11-24 由「只读发布产物行」扩为「README 全文所有 `dist/<id>-<ver>.tar.gz` 引用」：代码块里的 `tar -tzf dist/<id>-<ver>.tar.gz` 与发布产物行同源、同样会 bump 后漂移，只查后者会漏（实例 `app-deploy` README:98；`runtime-php` README:156 在本次扩围后立刻被报出并修正）。解析不出任何本仓引用一律 `[SKIP]` 并给出原因，**不拿行内任意版本号硬猜**；只比对 `<id>` == `info.json.id` 的引用，避免拿本仓版本误判他插件示例。

放宽或收紧判据须先改协议 §3.1，门禁不自行降级。

**G-20 深度等级一致性（2026-11-23 接入，G-18 命令内）**：`depth_level` 是商店契约的一部分（决定是否标"生产级"、能否开箱推荐），但此前五个检查点（`validate-index.sh` 只查枚举 / `store-check.sh` 只查字段存在 / 各仓 `Makefile dist` 只比 manifest 5 键 / `presets-check.sh` 全文无 `depth_level` / `sign-index.sh` 只签名不回读仓库）没有一个比对「索引 ↔ 仓库」，导致第 47 把重签把 8 个仓的陈旧值原样签成官方值。选 `presets-check.sh` 而非新脚本或另外四个点：它**同进程同时读索引、插件仓 `info.json`、预设**（`memory_mib()` 已在读仓库），是唯一「零新增取数管道 + 已在 `make check` 阻断级」的位置。呈现分三档：不一致且登记在 `scripts/depth-level-pending.txt` = `[WARN]` 已知待裁决（不阻断，产品裁决方向未定）；不一致且未登记 = `[FAIL]` 新增不一致（阻断）；清单条目已一致 = `[WARN]` 陈旧条目（提示移除）。**收口一句话**：8 条索引值按裁决改完后，删掉清单里对应 id，跑 `make presets-check`，warn 归零即为裁决闭环。

**严重级别裁决（当前接入态，2026-11-23）**：

| 门禁 | `make check` 段位 | 级别 | 理由 | 转阻断条件 |
| --- | --- | --- | --- | --- |
| `store-check` | 14/17 | **WARN**（判据本身未放宽，单跑仍 exit 1） | 现状 **24 pass / 0 fail / 0 warn**。判据已与 G-17 / 协议 §3.1 对账：`description` 不在必填 9 字段内，改按描述类字段四选一（`description`/`title`/`summary`/`name`）判、全缺只 WARN——原先「23 仓缺同一个 `description`」的阻断理由已消失，但**是否转阻断级需单独裁决**（本段不擅自升级） | 转阻断级条件：单独裁决确认后续插件仓变更不会大面积打红后切换 |
| `presets-check` | 15/17 | **阻断** | 现状 7 pass / 8 warn / 1 fail：8 条 `depth_level` 索引↔仓库不一致按「已知待裁决」计 WARN（清单即 `scripts/depth-level-pending.txt`，等产品裁决方向），1 条 FAIL 是 `db-only.json` 的 G-20 违规（`out_of_box=true` 引用索引 `basic` 的 `db-postgres`）——**这是存量数据缺陷，不是判据放宽**；判据先把「新增不一致」钉死为 FAIL；且 preset 是用户可见的装配入口，版本区间解析失败 / 深度等级错标都会直接误导安装 | 存量 8 条裁决落定（更新索引值）后，从清单删除对应 id，`presets-check` 回到 0 warn；`db-only` 修掉后 FAIL 归零，才可维持阻断 |

> 前提：G1 / G8 的 `bin/kored` 由 `Makefile` 的 `BIN ?= ./bin/kored` 产出（2026-11-21 已对齐：`APP ?= kored`、`BIN ?= ./bin/kored`）。若后续 `BIN` 再被改动导致路径不符，G1 / G8 记「阻塞」而不是 PASS，由 implementer 按 G-06 先对齐 Makefile。

## 2. 三层组合

| 层级 | 时机 | 必跑 | 说明 |
| --- | --- | --- | --- |
| 检查点 | 每个自洽改动完成时 | G1、G2、G4、G-30（不跑 G13：构建产物未就绪）；改动过主实例运行态的加 G-29 | 快速反馈，防止把坏代码攒成"大提交" |
| 合并前 | 任务进入验证阶段 / 合入主干前 | G1–G5、G7、G11、G16、G17（跨仓库变更另加 G12） | 加上测试、依赖、边界、仓库边界；缺一不得合并 |
| 里程碑 | 里程碑收尾 | 上述全部 + G6、G8、G9、G10、G12、G13、G14、G18、G19；G15 自 M3 起加入 | 加实测预算、体积、协议兼容与发行版可移植性，决定里程碑是否成立 |

聚合入口：`make check`。M0 阶段只有 G4 真实可跑，其余按第 4 节记 N/A。

## 3. 证据格式

任何 PASS 结论都必须能复现，格式固定三行（不足三行时贴完整输出）：

```text
命令: CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" ./...
退出码: 0
输出: （无）
```

```text
命令: ps -o rss= -p 12345   # 60s 采样 12 次取中位数
退出码: 0
输出: 5892 5768 5904 ... → 中位数 5880 KiB（预算 8192 KiB，余量 28%）
```

要求：

1. 命令必须是**原文**，包括环境变量与参数；不许写"跑了构建"。
2. 退出码必须是真实值，不许省略。
3. 证据贴在任务 evidence 或验收报告；文档类任务贴文件清单 + `wc -l`。

### 3.1 G-28 UI 交付证据格式

```text
命令: file .agents/verify/screenshots/store-home-desktop-1220.png .agents/verify/screenshots/store-home-mobile-1220.png
退出码: 0
输出: store-home-desktop-1220.png: PNG image data, 1440 x 900 ... / store-home-mobile-1220.png: PNG image data, 390 x 844 ...
产品定位自评: 本页解决"不装插件也能看懂商店有什么"；相对宝塔软件商店缺分类筛选与评分；当前"可用"，筛选列入占位清单。
```

1. **场景名**：kebab-case，PC 与手机同名同序号（如 `store-home` / `monitor-overview` / `settings-general`）。
2. **PC**：1440×900 或 1280×800，**full-page**（整页含滚动区，不只首屏视口）。**手机**：390×844（iPhone 14 逻辑分辨率）。
3. **不得替代**：接口 200 / DOM 断言 / 静态代码检查都不能代替截图；不得同一张图缩放冒充双端，不得用设计稿或拼接图。
4. **自评三问必答**：① 这页替用户解决什么问题；② 与宝塔 / 1Panel 同类功能的**具体**差距（缺哪个能力，不写"待完善"）；③ 当前是"可用"还是"占位"（占位必须写清缺什么、下一步补什么）。
5. **判定**：`make docs-check` 不校验 PNG（图像不属文档门禁），由 verifier 按本节逐项核对并写进验收报告；缺证据 = 未完成。

### 3.2 G-29 运行态写边界证据格式

```text
命令: curl -s localhost:8787/api/v1/system/info | jq -r .paths.index_dir
退出码: 0
输出: /home/pt/Work/GolandProjects/kore-plugins/index   # 判据：逐字等于配置的 kore-plugins/index
命令: curl -s localhost:8787/api/v1/store/plugins | jq -r '.data[].version' | sort -u
退出码: 0
输出: 0.2.0                                            # 判据：等于 index/plugins.json 里该插件的 version
运行态改动声明: 本轮未改动主实例运行态（测试走 /tmp 隔离实例）；或：本轮 04:53:06 临时改过 .kore-local.yaml，04:59:59 已回切 + 重启，上述输出为回切后实测；workaround 过期条件：索引重签完成后该快照失效。
```

1. **不许只看配置文件**：运行态资产是 untracked，`git status` 看不出；把 `.kore-local.yaml` 改回来不等于主实例读到新数据——必须验 `/api/v1/system/info` 的 `paths.index_dir`。
2. **索引版本对账**：商店返回版本 == `kore-plugins/index/plugins.json` 里该插件的 `version`；不等说明主实例还在读旧索引（副本 / 快照 / 缓存）。
3. **隔离优先**：测试要"不同索引 / 配置 / 状态"必须独立 `--config` + 独立 state/run/log 落 `/tmp`；改主实例是最贵的手段，不是最省的。
4. **workaround 带过期条件**：写清"当 X 发生时这个 workaround 失效"；没有过期条件的临时手段等同永久技术债。
5. **声明义务**：验收报告必须写"本轮是否改动过主实例的运行态配置"；改过则贴回切 + 重启 + 复核三行证据。缺声明视为未验证，任务记 BLOCKED。

## 4. M0 阶段的合法跳过规则

M0 只有文档与骨架，没有业务源码，以下门禁记 **N/A + 原因**，不许写成 PASS：

| 门禁 | M0 状态 | 原因 |
| --- | --- | --- |
| G1 build | N/A | 无 `cmd/kored` 与 `internal/**` 源码，`go build ./...` 无包可构建 |
| G2 vet | N/A | 同上，无 Go 包 |
| G3 test | N/A | 无测试文件 |
| G5 依赖白名单 | N/A | M0 未引入 `go.mod` 依赖；M1 首次 `go mod tidy` 后转为必跑 |
| G6 资源预算 | N/A | 无可运行的 `kored` 进程 |
| G7 薄壳边界 | N/A | `internal/core` 尚无源码；M1 起转为合并前必跑 |
| G8 二进制体积 | N/A | 无构建产物 |
| G9 前端体积 | N/A | `web/dist` 尚未产出 |
| G10 无联网/无遥测 | N/A | 无 `internal/core` 源码可扫描 |
| G11 仓库边界 | N/A | `cmd/`、`internal/`、`pkg/` 目录尚未创建（M0 无 Go 源码），无可扫对象；M1 骨架落地后转为合并前必跑 |
| G12 协议兼容 | N/A | M0 无插件仓库、无 `info.json`；M1 随 `kore-plugin-echo` 生效 |
| G13 兼容性 | N/A | M0 无 Go 源码、无 `go.mod`，三平台交叉编译与 `syscall` 隔离检查无从跑起；`make compat-info` 尚未提供（F 落地）。M1 骨架落地后在里程碑层必跑 |
| **G4 docs-check** | **必跑** | 文档是 M0 的主要交付物，G4 是本阶段唯一真门禁 |

规则：N/A 必须在 evidence 里写"门禁 + N/A + 原因"三件套；缺原因视为未验证，任务不得 complete。

## 5. 门禁维护

1. **新增门禁必须写明防的是哪类事故**：写清"哪类故障因为这个门禁被提前拦住"，否则不进表。
2. **门禁只收紧不放宽**：放宽阈值必须给实测数据 + ADR 修订记录，否则视为降低标准。
3. **减法比加法需要更多证据**：删除或合并一条门禁，必须证明其覆盖已被其他门禁完全替代，并保留一个里程碑周期的回滚窗口。
4. 命令变更必须同步三处：本文件、`Makefile`、[AGENTS.md](../AGENTS.md) 的命令速查表（G6 文档同步）——三处不一致即门禁失效。
6. **grep 类门禁的豁免规则**（防止为了变绿而毁证）：
   > grep 类门禁必须区分「现役口径」与「对照 / 证据」。以下三类命中**不算违规**，禁止为了变绿删除：
   > ① 对照实验臂（如内存双跑的 `GOGC=200`）；② 验收 / 评审报告中的判定对象（`.agents/verify/`、`.agents/reviews/` 是冻结证据）；③ 反模式记录与 ADR 中的"曾用 / 被拒"叙述。
   > 判据：命中行是否在**描述现状 / 给出指令**。是则违规；否则豁免。门禁命令应显式排除 `.agents/verify/` 与 `.agents/reviews/`，而不是要求改写证据。
   > **唯一例外（G-30 明文凭据）**：凭据值不是「判定对象」，是必须脱敏的泄露面；只允许把凭据字面量替换为 `***`，不得删改证据结论。

5. 每条门禁的负责人：G1/G2/G4 由 implementer 自跑，G3/G5/G6/G7/G8/G9/G10 由 verifier 复跑；verifier 不复用实现者输出。

## 6. CI 执行策略（2026-11-23 用户要求：CI 要少执行）

### 为什么少跑

本地 `make check` 已覆盖 **17 段门禁**（docs-check / 依赖白名单 + 兼容基线（参数钉死）/ 交叉编译（G-16 五目标真编译，第 17 段，阻断级）/ 薄壳边界 / 跨仓库边界 / 口径唯一性 / 台账 / worktree / oss / 大小写 / 前端首屏 / 零侵入 / 明文凭据 / 插件仓九件套 / 插件仓规范 / 预设一致性 / 公钥单一真源），CI 重复执行既慢又浪费 runner 分钟。CI 的定位是**保护分支不被坏代码合入的兜底**，不是日常反馈手段——日常反馈用本地 `make check`。

### 触发规则（`kore`）

| 事件 | 是否跑 | 说明 |
| --- | --- | --- |
| `push` 到 `main` | ✅ | 主干必须始终可构建 |
| 打 tag（`v*` / `pkg/pluginapi/v*`） | ✅ | 发布物必须过门禁 |
| `pull_request` | ✅ | 合入兜底 |
| `workflow_dispatch` | ✅ | 手动触发（排查 CI 自身） |
| 日常 feature 分支 push | ❌ | 本地 `make check` 即可，不占 runner |

**被否决的触发方案**：①保留全触发（每次 push 都跑，重复劳动）；②用 `[skip ci]` 提交标记逐次控制（依赖人工纪律，会漏）；③只配 Gitea CI（见下）。

### Gitea 不配 CI

自建 Gitea（`gitea.iouf.cn/kore-pl`）**不配置任何 CI**（无 `.gitea/workflows/`、无 woodpecker / drone）。理由：

1. 本地门禁已是权威（`make check` 17 段——第 13 段 `plugin-oss-check` 扫 25 个兄弟仓九件套，+ 各插件仓自己的 `make check`）；
2. Gitea 是内网自建，跑 CI 会占用本机资源；
3. 减少维护面：26 个仓 × CI 配置 = 26 份需要同步的 YAML。

### 插件仓配 CI，但少触发（2026-11-23 修正）

24 个插件仓 + `kore-plugins` 索引仓**都配 CI**，触发条件与 kore 一致（`push main` + tag `v*` + PR + `workflow_dispatch`）。理由：没有 CI，贡献者无法在 PR 上得到"能否拉取/能否构建"的反馈。发布前门禁仍由发版流程保证：`gofmt -l` + `go vet` + `go test` + `make dist` 两次 sha 一致 + 干净树复现（见 [docs/RELEASE.md](../docs/RELEASE.md)）。

九件套（含 `.github/workflows/ci.yml`）由 `scripts/plugin-oss-sync.sh` 按 `scripts/plugin-templates/` 渲染；`make check` 第 **13 段**（`scripts/plugin-oss-check.sh`）逐仓校验九件套存在、README oss 标记块、ci.yml 为少触发。
