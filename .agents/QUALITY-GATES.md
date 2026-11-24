# .agents · 质量门禁

> 状态: draft · 归属: scribe · 更新: 2026-11-24 · 里程碑: M0

门禁不是建议清单，是"能不能交付"的判定条件。命令必须原样执行——改参数、加跳过、换更宽松的选项，都视为伪造通过。

## 1. 门禁表（G1–G19 + G-28/G-29/G-30/G-31/G-32/G-33；`make check` 段内门禁另见 §1.1（G-17/G-18）与 §1.2（第 18 段 race）、§1.3（第 19 段全仓 race）、§1.4（第 16 段·market 子检查）、§1.5（第 21 段嵌套 module race）、§7（第 20 段 G-33））

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
| G15 | 深度等级（M3 起） | `grep -r "depth_level" <插件仓>/info.json`；查对标矩阵标注；查 `production` 插件的 `tests/fault/` 与 `tests/boundary/` | `depth_level` 存在且 ∈ {`production`,`basic`}；`basic` 在对标矩阵中不得标"生产级"；`production` 必须有 `tests/fault/` 且故障注入用例可跑；`tests/boundary/` 须有含 `func Test` 的用例 + 并发证据 ≥1（`t.Parallel`/`go func`/`sync.`）+ 四类覆盖（异常输入/并发/权限/资源耗尽） | 缺 `depth_level` → 不进商店；标错等级 → 改矩阵并复核；没有 `tests/fault/` → 降级为 `basic` 或补测试（判据②硬判据）；没有 `tests/boundary/` → 降级为 `basic` 或补测试（存量按 `scripts/boundary-pending.txt` 记 WARN） | verifier | 里程碑（M3 起） |
| G16 | 无副作用的诊断代码（M1 起） | `grep -rn "SetGCPercent(-1)" --include='*.go' .` 与 `grep -rn "SetMemoryLimit(-1)" --include='*.go' .` **双零命中**；另查同形态"设置即读取"API（`debug.SetMemoryLimit` / `debug.SetGCPercent` / `debug.SetMaxThreads` 等传负数的写法） | 两条 grep 命中数均为 0；读取运行时配置只允许 `runtime/metrics`，或记录"自己设置过的值" | 视为 **P0**（会静默改变运行时行为）：日志里的 `SetGCPercent(-1)` 实测会**关闭 GC**；改为记录自己设置的值或走 `runtime/metrics`，并补回归测试（`setRuntimeLimits()` 后分配内存必须观察到 GC 次数增长） | verifier | 合并前 |
| G17 | 无 any / object 逃逸 | `grep -rn "map[string]any" --include='*.go' internal/ cmd/`（排除 `_test.go` 与 `testdata/`）；`grep -rn "类型：object" docs/`；`grep -rn "json.RawMessage" --include='*.go' internal/ cmd/` | 对外 schema / 对外结构体零 `object` / `any` / `map[string]any`；docs 无「类型：object」；`json.RawMessage` 仅出现在插件方法参数与结果载荷处且写明原因 | 评审退回：字段改成显式结构体，或改用带类型前缀的标量；解析期临时 `any` 必须在一处收口转具体类型 | verifier | 合并前（判定型部分由评审回答） |
| G18 | worktree 卫生 | `make wt-check`（F 落地）；等价手工：`git worktree list` + `git branch --list 'wt-*' 'tmp-*'` | `git worktree list` 仅 1 行（主工作树）；临时分支清单为空；残留的 `/tmp/*` 检出目录已删除 | 先 `git worktree remove`，再 `git branch -d`，最后 `git worktree prune`；有改动未合并则先合并或写明放弃原因 | verifier | 里程碑收口 |
| G19 | 开源资产完整 | `make oss-check`（第 8 段，阻断级）+ `make check` 第 13 段 `plugin-oss-check`（25 仓九件套/CI）；等价手工：逐个检查根 `LICENSE` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `CHANGELOG.md` / `.github/workflows/ci.yml`，并 `grep -n "MIT License" LICENSE` 与 `grep -n "Permission is hereby granted" LICENSE` | 六件资产齐备；`LICENSE` 含上述两个特征串；无 GPL / Apache / AGPL 等非 MIT 协议头混入 | 缺件即补；协议头冲突则统一为 MIT 并在 PR 中说明；不得以「以后再补」放行 | verifier | 里程碑收口 / 发布前 |
| G-28 | UI 交付双端证据 | 触发：任何涉及用户界面（页面 / 视图 / 组件 / 样式 / 交互 / 文案）的交付，在声明"完成"前；取证：`.agents/verify/screenshots/` 下同时存在 `<场景>-desktop-*.png`（1440×900 或 1280×800，full-page）与 `<场景>-mobile-*.png`（390×844），并用 `file <png>` / `identify -format '%wx%h'` 读实际宽高；另附一段产品定位自评（本页解决什么用户问题 / 与宝塔、1Panel 同类功能的差距 / 当前是"可用"还是"占位"） | 三件套齐备，分辨率与命名匹配；自评三段齐全、不出现"应该是 / 大概"式措辞 | 缺任一项即不得声明完成：补截图（不得缩放糊弄分辨率、不得拿桌面图裁成手机图）或补自评；证据缺失时任务记 BLOCKED，不记 PASS | implementer 取证 + verifier 核对 | 检查点（UI 交付） |
| G-29 | 运行态写边界 | 触发：任务涉及 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 或任何被运行中 `kored` 持有的文件（`git status` 看不出，untracked）。取证：① `curl -s localhost:8787/api/v1/system/info \| jq .paths.index_dir` 必须**逐字等于**配置里的 `kore-plugins/index`（不得指向 `.kore-local-state/` 下任何索引快照）② 商店 `/api/v1/store/plugins` 返回的插件版本必须等于 `kore-plugins/index/plugins.json` 里的版本 ③ 验收报告必须显式声明"本轮是否改动过主实例的运行态配置"，改过则附回切 + 重启 + 复核三行证据 ④ 测试要"不同索引 / 配置 / 状态"时附隔离实例命令（独立 `--config` + state/run/log 落 `/tmp`）⑤ 运行态资产必须进 `.gitignore`——`.kore-local*` 覆盖 yaml/state/run/log/index 全系列，`git check-ignore` 对 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` 必须全部命中（否则一次 `git add .` 就把 123 MiB 的 state.db 带进提交） | ①② 必须相等（`paths.index_dir` == `kore-plugins/index`、商店版本 == 索引版本）；③ 声明齐全且与事实一致；④ 有隔离实例证据或写明"未触碰主实例"。防的事故：2026-11-23 为测试把 `index_dir` 指向 `signed-index` 快照（04:53:06），恰逢另一轮重签完成（04:53:40），04:59:59 回切前 8787 商店把 discover 0.2.0 显示成 0.1.0——配置回写了、主实例读到的仍是旧数据 | 任一不符即判未完成：回切 + 重启 + 复核后再验一次；未回切或只改配置文件不验 `/api/v1/system/info` 的，任务记 BLOCKED，不记 PASS；workaround 无过期条件（"当 X 发生时失效"）的，记 WARN 并要求补写 | implementer 取证 + verifier 独立复跑 | 检查点（运行态变更） |
| G-30 | 明文凭据入库 | 触发：任何写 `docs/` 或 `.agents/verify/` 的提交 / 验收报告；取证：`make secret-check`，扫描 `MYSQL_ROOT_PASSWORD=` / `MYSQL_PWD=` / `REDIS_PASSWORD=` / `REDISCLI_AUTH=` / `KORE_MYSQL_PASSWORD=` / `KORE_REDIS_PASSWORD=` / `ADMIN_PASSWORD=` 以及 JSON 的 `"password"` / `"secret"` / `"token"` 键 | 非占位值零命中；占位只允许 `***` / `[REDACTED]` / `$VAR` / `<placeholder>` / `********` / `...` / `…`。防的事故：2026-11-23 `.agents/verify/round3-live.md` 把 `common-mysql` 的 root 明文口令写进验收报告并推送公开仓库（`3fa40f2`） | 命中即阻断：把凭据字面量替换为 `***` 后重跑；**禁止**为了让门禁变绿删证据或改判定结论——本门禁扫 `.agents/verify/` 是 §5.6 豁免规则的唯一例外，只许替换凭据字面量 | implementer 自跑 + verifier 复跑 | 检查点 |
| G-32 | 图表规范（十一条判据） | 评审对照 [docs/FRONTEND.md](../docs/FRONTEND.md) §13 十一条判据；机械可回读项：有数据点的时序 / 柱状图 `grep -rn "tooltip: *{ *show: *false" web/` **零命中**；`make frontend` 首屏 gzip 与改前逐字节一致；`find web/dist -name '*.map'` 为空；**真浏览器复核**（桌面 hover + 手机 390×844 tap 各必须出读数面板，<20 点可见逐点标注） | ① 首屏 `FILES` 不含图表产物、首屏 gzip 不因图表增长；② 图表实例 ≤12 且第 13 个**硬拒绝**（非静默降级）；③ 切走视图 dispose 后实例计数 `=== 0`；④ 单图 ≤1000 点（超出采样）；⑤ 时序用 Canvas / 等效位图 + 采样、静态占比优先 SVG；⑥ 全局 resize 单点 100ms 防抖；⑦ 懒加载、不进首屏；⑧ 不需要的坐标轴 / 装饰性 tooltip / 高亮 / 标记点显式关闭；⑨ 精简配置与可读性不冲突——**读数面板不在精简范围内**；⑩ 短窗口多轮验收（3 轮 × 60s，实例数与 heap 不单调增长）；⑪ **每个数据点可读**：hover 与 tap 都出面板、显示准确数值 + 单位（`12.3 MiB` 不是 `12.3`），面板 `pointer-events:none`，数据点 <20 可直接标注，图注 / `aria-label` 保留区间与最近值 | 缺读数面板、只给取整值、或把 `tooltip` 一刀切关掉 → 返工；拿「库默认支持 tooltip」替代实测 → 同判不通过；首屏 gzip 增长 → 按 G-03 阻断级失败 | implementer 自测 + verifier 按 §13-11 真浏览器复跑 | 检查点（UI 交付） |
| G-33 | 产品可用性（7 自动 + 4 人工） | `bash scripts/usability-check.sh`（`make check` **第 20 段，WARN 级**；`--self-test` 为正反例自证）：A1 插件仓 `Test.*ZeroParam` in-process 用例并 `go test -run ZeroParam` 真跑；A2 `info.json.presets`；A3 `invalid("...")` 文案；A4 `web/*.js` 用户字符串术语；A5 视图空状态+跳转；A6 `web/app.js` 一级菜单；A7 `web/usability.yaml` 主流程 | 正例 `backup` PASS；四反例（去 presets / message 改纯码 / UI 加「实例」/ 导航 11 项）必须 FAIL；无新增 FAIL | 新增违规修插件/视图，或登记 `scripts/usability-pending.txt` 并写裁决期限；存量条目修好即删（移出清单 = 转硬判据）；`make check` 段内 FAIL 只 WARN 不阻断，脚本单跑 exit 1 | implementer 自跑 + verifier 复跑 | 检查点（UI/插件交付） |

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
| G-17 | 插件仓规范（`make store-check`） | `bash scripts/store-check.sh`（无参数扫 `../kore-plugin-*`；可传目录） | 逐仓 7 项：① 三件套 `info.json` / `Makefile` 的 `dist` 目标 / `CHANGELOG.md`；② `info.json` 必填 14 字段（**清单以 [docs/PLUGIN-PROTOCOL.md](../docs/PLUGIN-PROTOCOL.md) §3.1 为唯一真源**，= 协议 9 项 ∪ G-17 4 项 ∪ G-20 `depth_level`；`description` **不在其中**，改按描述类字段四选一 `description`/`title`/`summary`/`name` 判，全缺只 WARN）；③ `id` 匹配 `^[a-z][a-z0-9-]*$` 且 == 目录名后缀 `kore-plugin-<id>`；④ `info.json.version` == `manifest.json.version`（manifest 存在时）；⑤ `go.mod` 无 `=> ../` / 绝对路径 `replace`（`=> ./` 放行）；⑥ 本地 `dist/<id>-<ver>.tar.gz` 的 sha256 与索引账本一致（版本命中 `versions.lock.json` 或 `plugins.json` 当前版本时必须相等，不等只 WARN 并输出 `DIST_SHA_DIFF <id> <version> index=<sha> dist=<sha>`，不阻断；**本地缺件必须可见**——索引记录的当前版本本地无 `dist/` 时逐个 `[SKIP] <id> <ver>: 本地无 dist，未比对`，并在末尾汇总分账 `DIST 检查(按 dist 文件计): <N> 一致 [/ <D> 漂移(WARN)] / <M> 缺件跳过 [/ <K> 索引未收录跳过]`，缺件只 SKIP、不 WARN 不 FAIL（`dist/` 不入库，缺件是常态，本条只负责让「没检查」可见）；索引未记录该版本计入「索引未收录跳过」计数、不逐条打印）；⑦ README **全文**所有 `dist/<id>-<ver>.tar.gz` 引用（代码块示例 / `make dist` 说明行 / 「发布产物」行同源）的版本与 `info.json.version` 一致（每条不一致单独 WARN 并输出 `README_VERSION_DRIFT <id> info=<ver> readme=<ver> (line N)`，**带行号、多处全部列出**，不阻断；只比 `<id>` == `info.json.id` 的引用，他插件示例不计；README 内解析不出任何本仓 `dist/<id>-<ver>.tar.gz` 时 SKIP，不硬猜）。输出 `[OK]`/`[FAIL]`/`[WARN]` 行 + `store-check: N pass, M fail`，缺失指名到「仓 + 文件 + 字段」 | 单跑时任一 FAIL → exit 1；`make check` 内为 **WARN 级**（见下「严重级别裁决」） | implementer 自跑 + verifier 复跑 | 检查点（M1 起） |
| G-18 | 预设一致性（`make presets-check`） | `bash scripts/presets-check.sh`（无参数扫 `../kore-plugins/presets/*.json` 并对 `index/plugins.json` 解析）；`--self-test` 验解析器正反用例 | 逐 preset 4 项：① 插件 `id` 可在索引解析；② `version` 区间被索引实际版本满足——**只认** 精确 `x.y.z` / `^x.y.z` / `~x.y.z` / 比较器集合（`>=x.y.z <a.b.c`、`>`、`<=`、`=`），其余写法（`*`、`1.x`、`latest`、`>=1.0`、`||`）**必须报 FAIL，不静默跳过**；③ 常驻（索引 `lifecycle=resident` 且 `desired=enabled`）RSS 合计 ≤48 MiB 红线（超即 FAIL）、≤24 MiB 目标（超即 WARN），同时常驻 ≤3（G-03 红线），单插件包体积 ≤25 MiB（G-03 单二进制红线）；④ 失败指名到「preset + id + 区间 + 原因」；⑤ 深度等级一致性（G-20）：索引 `depth_level` 必须等于 `../kore-plugin-<id>/info.json` 的 `depth_level`——不一致且登记在 `scripts/depth-level-pending.txt`（已知待裁决清单）= WARN 不阻断，**未登记 = FAIL 阻断**，清单条目已一致 = WARN 提示移除；⑥ `out_of_box` × `depth_level`（G-20 明文「basic 插件不得被预设标为开箱可用」）：`out_of_box=true` 的预设不得引用索引 `depth_level≠production` 的插件（判据看索引、不看 `desired`）；⑦ `production` 声明内容（G-20 判据①②）：`tests/fault/` 硬判据 + `tests/boundary/` 分层（`scripts/boundary-pending.txt` 内 WARN / 外 FAIL），详见下段 | 任一 FAIL → exit 1；`make check` 内为**阻断级** | implementer 自跑 + verifier 复跑 | 合并前（M2 起） |

**判据来源**：三件套取自 AGENTS.md G-17 原文；**`info.json` 必填字段的唯一真源是 [docs/PLUGIN-PROTOCOL.md](../docs/PLUGIN-PROTOCOL.md) §3.1**（14 项 = 协议 9 项 ∪ G-17 4 项 ∪ G-20 `depth_level`；本文与 AGENTS.md 只引用、不复制清单）；`scripts/store-check.sh` 的 `REQ_FIELDS` 必须与 §3.1 逐字一致，不一致即第四份口径。24 仓对 14 项的实际出现率均为 24/24，故本轮补齐未打红任何仓；**裁决理由（2026-11-23，必须留痕）**：更早的严格版按 10 字段判（含 `description`），24 仓里 **23 仓缺的都是同一个 `description`**——而协议 §3.1 的必填 9 项里根本没有它，属**判据超出协议**而非仓库腐烂。若按必填处理只剩两条路：让 23 仓各补字段（各改 `info.json` → 各改 dist sha → **23 次版本抖动**，全为满足一个协议里并不存在的字段），或让所有人每次提交全红。两者都不值，故 `description` **非必填**，只按描述类四选一（`description`/`title`/`summary`/`name`）兜底。**已知限制**：14 字段下 `name` 本身就是必填且落在四选一集合内，因此「四者全缺」在结构上不可能出现，WARN 分支实际不可达——它只作前向兼容兜底保留，不构成放宽（缺 `depends_on` 等任一必填仍 FAIL，实测 `0 pass, 1 fail`、exit 1）。

**本地 `dist` sha 比对（⑥）与 README 发布产物版本比对（⑦，均 2026-11-24 接入）的判据与理由不在此重述**，源见 `scripts/store-check.sh` 头部注释第 6、7 条：只读、不联网、不改文件；比对**全部历史版本**而非只比当前版本（旧版本野产物在 bump 后仍留在 `dist/` 才是漏洞本体，实例 firewall 0.2.3 / process 0.2.1 / redis 0.5.0 / ssl 0.4.0 / waf 0.3.0）；不一致只 WARN 不阻断——硬判据仍是「已发布物与索引自洽」，归 `validate-index.sh`。**⑥ 的缺件可见性（2026-11-24 修）**：此前守卫「只遍历已存在的 dist 文件」，索引记录的当前版本本地无 dist 时静默跳过，`0 warn` 因此有两种不可区分的含义——「全部一致」与「全部没检查」（新检出的 `dist/` 必然全缺）；现改为逐条 `[SKIP]` + 汇总行分账「一致 / 漂移 / 缺件跳过 / 索引未收录跳过」，缺件仍不阻断。⑦ 2026-11-24 由「只读发布产物行」扩为「README 全文所有 `dist/<id>-<ver>.tar.gz` 引用」：代码块里的 `tar -tzf dist/<id>-<ver>.tar.gz` 与发布产物行同源、同样会 bump 后漂移，只查后者会漏（实例 `app-deploy` README:98；`runtime-php` README:156 在本次扩围后立刻被报出并修正）。解析不出任何本仓引用一律 `[SKIP]` 并给出原因，**不拿行内任意版本号硬猜**；只比对 `<id>` == `info.json.id` 的引用，避免拿本仓版本误判他插件示例。

放宽或收紧判据须先改协议 §3.1，门禁不自行降级。

**G-20 深度等级一致性（2026-11-23 接入，G-18 命令内）**：`depth_level` 是商店契约的一部分（决定是否标"生产级"、能否开箱推荐），但此前五个检查点（`validate-index.sh` 只查枚举 / `store-check.sh` 只查字段存在 / 各仓 `Makefile dist` 只比 manifest 5 键 / `presets-check.sh` 全文无 `depth_level` / `sign-index.sh` 只签名不回读仓库）没有一个比对「索引 ↔ 仓库」，导致第 47 把重签把 8 个仓的陈旧值原样签成官方值。选 `presets-check.sh` 而非新脚本或另外四个点：它**同进程同时读索引、插件仓 `info.json`、预设**（`memory_mib()` 已在读仓库），是唯一「零新增取数管道 + 已在 `make check` 阻断级」的位置。呈现分三档：不一致且登记在 `scripts/depth-level-pending.txt` = `[WARN]` 已知待裁决（不阻断，产品裁决方向未定）；不一致且未登记 = `[FAIL]` 新增不一致（阻断）；清单条目已一致 = `[WARN]` 陈旧条目（提示移除）。**收口一句话**：8 条索引值按裁决改完后，删掉清单里对应 id，跑 `make presets-check`，warn 归零即为裁决闭环。

**G-20 判据①②内容校验（2026-11-24 接入，G-18 命令内）**：`depth_level=production` 此前只核对「索引 ↔ 仓库一致」，两条升级判据在脚本里**都没有执行面**——`tests/fault/` 只写在文档与模板里，判据①（边界用例）从未被任何门禁打开，于是「索引写 production + 建个 `tests/fault/`」就能一路绿灯（[production-claim-audit.md](verify/production-claim-audit.md) 实证：15/15 无 `tests/boundary/`、`t.Parallel` 0/15）。现补两层，判据只收紧不放宽：

- **判据②（硬判据，待裁决清单不豁免）**：`../kore-plugin-<id>/tests/fault/` 存在且含 `func Test` 的 `*_test.go`；缺失/空目录 → `[FAIL]`。仅静态核对存在性，**不重复跑 `go test`**（各仓 CI / `make check` 负责实跑），门禁不联网、不改文件。
- **判据①（分层上线，避免 15 条存量一次打红）**：`tests/boundary/` 存在 + 含 `func Test` 的 `*_test.go` + 并发证据 ≥1（`t.Parallel` / `go func` / `sync.` 命中）+ 四类代表性覆盖（异常输入 / 并发 / 权限 / 资源耗尽；取证面 = 文件名 + 注释行，不拿可执行代码凑关键词；「并发」由真实并发证据判定，比关键词可靠）。登记在 `scripts/boundary-pending.txt` → `[WARN]` 不阻断；**未登记（新增 production 声明）→ `[FAIL]` 阻断**；条目已满足判据①② / 已非 production / 已不在索引 → `[WARN]` 陈旧条目提示移除。**2026-11-24 清单已清空**：10 条陈旧条目逐条经 `go test ./tests/boundary/ -count=1` 与 `go test -race` 复核 PASS 后移除，15 个 production 全部转为硬判据；强化验证 `BOUNDARY_PENDING_FILE=/dev/null` 实跑同样 15/15 PASS、0 FAIL。
- **收口**：每补齐一仓的 `tests/boundary/` 就从清单删对应 id，**移出清单 = 转硬判据**；清单清空即判据①全硬。清单是存量补测试的登记处，不是放行名单。

**严重级别裁决（当前接入态，2026-11-23）**：

| 门禁 | `make check` 段位 | 级别 | 理由 | 转阻断条件 |
| --- | --- | --- | --- | --- |
| `store-check` | 14/18 | **WARN**（判据本身未放宽，单跑仍 exit 1） | 现状**以实跑为准**（warn 数随插件仓收敛/回退而变动、不恒为 0：2026-11-24 快照见过 `24 pass / 0 fail / 1 warn` = `README_VERSION_DRIFT logs`，收敛后为 `24 pass / 0 fail / 0 warn`）。`DIST 检查(按 dist 文件计)` 汇总行分账「N 一致 / D 漂移 / M 缺件跳过 / K 索引未收录跳过」，缺件只 `[SKIP]` 不加 warn。判据已与 G-17 / 协议 §3.1 对账：`description` 不在必填 9 字段内，改按描述类字段四选一（`description`/`title`/`summary`/`name`）判、全缺只 WARN——原先「23 仓缺同一个 `description`」的阻断理由已消失，但**是否转阻断级需单独裁决**（本段不擅自升级） | 转阻断级条件：单独裁决确认后续插件仓变更不会大面积打红后切换 |
| `presets-check` | 15/18 | **阻断** | 现状 **8 pass / 0 warn / 0 fail**：2026-11-24 清空 `scripts/boundary-pending.txt`（10 条陈旧条目逐条经 `go test ./tests/boundary/ -count=1` + `go test -race` 复核 PASS 后移除），判据①已全硬——15 个 production 全部真跑 PASS；强化验证 `BOUNDARY_PENDING_FILE=/dev/null`（模拟清单外）同样 15/15 PASS、0 FAIL；判据②（`tests/fault/`）本就为硬判据、清单不豁免；新增 production 声明判据①不满足 → FAIL。判据先把「新增空口声明」钉死为 FAIL；且 preset 是用户可见的装配入口，版本区间解析失败 / 深度等级错标 / 空口 production 都会直接误导安装 | 已达成：清单清空即判据①全硬，`presets-check` 回到 0 warn；维持阻断级 |

> 前提：G1 / G8 的 `bin/kored` 由 `Makefile` 的 `BIN ?= ./bin/kored` 产出（2026-11-21 已对齐：`APP ?= kored`、`BIN ?= ./bin/kored`）。若后续 `BIN` 再被改动导致路径不符，G1 / G8 记「阻塞」而不是 PASS，由 implementer 按 G-06 先对齐 Makefile。

### 1.2 第 18 段 · race 门禁（跨仓，阻断级，2026-11-24 接入）

**防的事故**：在此之前 kore 与 24 个插件仓的 `Makefile` / CI 都只跑 `go test ./...`，**全链没有 `-race`**。并发边界用例（`tests/boundary/`）写着「必须过 `-race`」，但没有任何门禁真的以 `-race` 跑过——等于**写了并发断言却从没验过数据竞争**，下一次改动引入竞争不会被任何一层发现。这是「只写不跑」的第二种形态：不是判据文本写错，而是**判据根本没有执行面**（对照 G13 的 2026-11-23 教训：只 grep 目标名、从不编译）。

**执行方式**（`bash scripts/race-gate-check.sh`，`make check` 第 18/19 段，阻断级；不联网、不调用 git、不写状态）：

1. **本仓**：`make race` → `CGO_ENABLED=1 go test -race -count=1 -timeout 300s ./tests/boundary/...`；无 `tests/boundary/` 目录时 `[SKIP]` 退出 0（kore 当前即此态：`tests/` 尚未建立）。缺 `race` 目标 → `[FAIL]`。
2. **兄弟仓静态接线核对**（只对**有** `tests/boundary/*_test.go` 的仓，三条全须通过，缺任一条 `[FAIL]`）：
   - `Makefile` 有行首 `^race:` 目标；
   - `Makefile` 的 `check` 目标体内把 `race` 作为**独立段**调用（`^\t@\$(MAKE) --no-print-directory race$`）——挂在别处或和别的命令串在一行不算；
   - `.github/workflows/ci.yml` 显式 `- name: ...race` 或 `run: make race`（**CI 里看不到 `-race` 就等于没跑**）。
3. **兄弟仓真跑**：对每个有边界用例的仓执行 `make -C <repo> race`，**真编译真执行** `-race`；任一 FAIL / 超时 / 编译不过即本段阻断。

**降级与边界**：

- 无兄弟仓（GitHub CI 只 checkout kore）→ `[N/A]`，**不阻断**；跨仓接线与真跑由各插件仓自己的 CI 兜底。
- 无 `tests/boundary/*_test.go` 的仓 → `[SKIP] <仓>：无 tests/boundary/*_test.go`，**不假装通过**；`race` 目标已存在，**新增边界用例后自动生效，不需要再改 Makefile**。
- `-race` 需要 cgo（linux/amd64 用 gcc）；缺编译器时 `go test` 会原文报 `-race requires cgo`，门禁不静默降级、不吞错。

**为什么插件仓的 `-race` 只跑 `tests/boundary/` 而不是全仓**：并发断言集中在边界面；`-race` 通常让测试慢 2–10 倍，24 个插件仓若各自全仓 `-race`，每个仓的 `make check` 都会被拖长，日常反馈不可接受。判据不放宽——race 段与 `check` 同属阻断级，只是**范围**限定在「数据竞争必须被抓」的那一面。实测取舍见 [LOG/DECISIONS.md](LOG/DECISIONS.md) 2026-11-24 裁决。

> **本仓（kore）口径已升级**：上述「全仓不划算」只适用于插件仓。kore 本仓没有 `tests/boundary/`（`make race` 恒 `[SKIP]`），所以本仓的竞争检查单列为**第 19 段全仓 `-race`**——见 §1.3。

**跨仓为什么必须一次铺满 25 仓**：race 门禁的价值来自**每仓都有**——25 仓里漏一仓，那一仓的并发断言就退回「只写不跑」；而各插件仓 CI 只看到自己的仓，无法替别人兜底。因此本段的**接线核对**是本段的主体之一，不是附带的自检：`scripts/plugin-templates/plugin-repo/Makefile.race.mk` 是唯一真源，`scripts/race-gate-sync.sh` 幂等渲染进 24 份（**禁手改 24 份**，手改必然漂移），`scripts/race-gate-check.sh` 反向核对是否漂移。

**2026-11-24 首跑实测**（`bash scripts/race-gate-check.sh`）：`EXIT=0` / 44s / `有边界用例 15 仓 · -race 真跑通过 15 仓` / `[OK] race 门禁通过（接线完整 + -race 真跑全绿）`；24/24 仓三条接线（`^race:` / `check` 独立调 `race` / `ci.yml` 显式 `make race`）全中。本仓 `make race` → `[SKIP] 本仓无 tests/boundary`。

### 1.3 第 19 段 · 全仓 `-race` 门禁（本仓，阻断级，2026-11-24 接入）

**防的事故**：第 18 段的 `-race` 固定面是 `./tests/boundary/`，而 kore 本仓**没有该目录** → 本仓 `make race` 恒 `[SKIP]`。也就是说第 18 段保护的是 15 个插件仓，**kore 自己的代码在 race detector 面前是零覆盖**。`bd3ac83` 证明这不是理论风险：`cmd/kored` 升级链路有两处真实数据竞争（结果审计晚于终态发布 / `launch` 把 map 内 `*SelfUpdateJob` 交出、调用方在锁外解引用），当时 `go test ./...` **全绿、断言全过**，**只有 `-race` 能抓**。

**执行方式**（`bash scripts/race-full-check.sh`，`make check` 第 19/21 段，`make race-full` 可单跑；阻断级；不联网、不调用 git、不写状态）：

- `GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout 600s ./...`——固定面 `./...`，**不按 diff 推断「改动包」**（算错即静默放行，见 2026-11-24 裁决选项 C 被否的理由）。
- `exit != 0` → `[FAIL]`（数据竞争 / 测试失败 / 编译失败一律阻断）；输出含 `WARNING: DATA RACE` 时先单独打红再阻断（长输出里便于定位）。
- `-race` 需要 cgo：**缺 C 编译器 → `[FAIL]` 并给原文，不静默降级成跳过**（跳过等于不检查数据竞争）。
- 无 `go.mod`（M0 骨架态）→ `[SKIP]` 退出 0，不假装通过。

**实测（2026-11-24，`8011a53` + 本段）**：`EXIT=0` / `WALL=52.16s` / `MAXRSS=185780KB` / **零 DATA RACE**；16 个包 `ok`，`cmd/kored` 单包 51.687s。

**为什么否掉「只跑 `./internal/...` + `./cmd/kored`」（`bd3ac83` 提的折中）**：实测 `./internal/... ./cmd/kored` = **51.84s**，`./...` = **52.16s**，只差 **0.32s**。`go test` 包级并行，`cmd/kored` 51.3s 独占墙钟，其余 internal 包并进去几乎不占时间——「10s + 51s = 61s」的算法不成立。省不下时间，却把固定面从 `./...` 缩成手写包清单（新增包 / 新目录要人记得加，漏了就是静默放行）。

**代价与取舍（实测）**：本地 `make check` 18 段 **110.31s** → 19 段 **162s 量级**（+52s，+47%）。选择「进 `make check`」而不是「只进 CI」的理由：本仓日常反馈的权威入口是本地 `make check`（§6：CI 只在 `push main` / tag / PR 跑），把唯一能抓数据竞争的检查只放 CI，等于让它退回「合入时才第一次执行」；而同一判据在 Makefile 与 ci.yml 各写一份必然漂移，**写一份、两处跑**才是闭环。CI 的 `make check` 因此自动带上第 19 段（`ubuntu-latest` 自带 gcc，cgo 可用），不重复执行同一条命令。

**接线防漂移**：第 18 段 `scripts/race-gate-check.sh` 增加本仓 1b 接线核对——`Makefile` 必须有 `^race-full:` 目标、`check` 目标必须独立调用 `scripts/race-full-check.sh`、`ci.yml` 必须 `run: make check`；缺任一条 `[FAIL]`（有目标但 check 不调 = 本地不跑；check 调了但 CI 看不到 = 合入前不跑）。

**正反例自证**：`/tmp` 的 `git archive HEAD` 副本里回退 `bd3ac83` 的「锁内快照」修复（`launch` 重新返回 map 内指针），`race-full-check.sh` 必须 `[FAIL]` + `WARNING: DATA RACE`；不注入时同一条命令必须 `[OK]`。见下表。

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 正例（`8011a53` 工作树） | `bash scripts/race-full-check.sh` | `[OK] 全仓 -race 通过（16 个包，52s，零 DATA RACE）` / exit 0 |
| 反例（副本回退锁内快照） | 同上（`/tmp` 副本） | `[FAIL]` + `WARNING: DATA RACE` / exit 1 |

**跳过规则**：只有「无 `go.mod`」才 `[SKIP]`；缺 cgo、缺编译器一律 `[FAIL]`，不提供「本机跳过」开关——第 19 段存在的唯一意义就是不让数据竞争没人看。

### 1.4 第 16 段 · market 子检查（索引 → 市场页派生一致，阻断级，2026-11-24 接入 kore 侧）

**防的事故**：`kore-plugins` 侧本来就有两道判据——`validate-index.sh` 第 1c 步与 `build-market.sh --check`——但 `kore` 自己的 `make check` **从不调用它们**，第 16 段只比公钥（`scripts/pubkey-sync-check.sh`）。日常反馈的权威入口是本地 `kore` 的 `make check`（§6：CI 只在 `push main` / tag / PR 跑），于是「改了 `index/plugins.json` 没同轮重建 `market/plugins.js`」在 kore 仓跑门禁时**抓不到**：商店页把旧版本当现行版本展示，只能靠 `cd kore-plugins && make check` 或索引仓 CI 才拦得住。判据存在、执行面缺失——与 G13 的 2026-11-23 教训同型（只验参数不真跑 = 假绿）。

**执行方式**（`make market-check`，`make check` 第 16 段·market 子步骤，阻断级；不联网、不调用 git、不写状态）：

- 命令：`bash "$(KORE_PLUGINS_DIR)/scripts/build-market.sh" --check`；`KORE_PLUGINS_DIR ?= ../kore-plugins`（与 `scripts/presets-check.sh` / `scripts/pubkey-sync-check.sh` 的目录约定一致，CI / worktree / 测试可覆盖）。
- 判据本体在索引仓，kore 侧不改判据、不重复实现生成器：只读、逐字节比对现有 `market/plugins.js` 与当前 `index/plugins.json` 的期望内容；不一致 `exit 1` 并列出 `market=x index=y` 版本差 + 修复命令（`bash scripts/build-market.sh`，与索引同一提交）。
- `kore-plugins` 不存在 → `[SKIP]` exit 0（kore 仓可独立 clone，不阻断）。
- `kore-plugins` 存在但缺 `scripts/build-market.sh` → `[FAIL]`（兄弟仓过旧 / 不是索引仓，不静默跳过）。
- 存在且不一致 → `[FAIL]`，`make check` 阻断。

**为什么是「第 16 段·market 子步骤」而不是新开第 21 段**：① 语义同源——第 16 段本就是「kore ↔ 索引仓派生一致性」（公钥单一真源），market 页是索引的派生物，同一条链；② 接入时工作树的 `Makefile` 正被并发改动做 18→20 段重编号（`1/18…18/18` 批量改号与他人的 race-full 新增段混在一起、未提交），在其上再加第 21 段要么把他人未提交改动一起提交（违反 G-12），要么提交一个段数与已落库文档（20 段）矛盾的 Makefile；③ 子步骤零重编号，段数仍为 20，输出另有独立 `[RUN ] 16 段·market` 行，可读性不降。

**已知边界（写明，不粉饰）**：第 16 段的另一半（`pubkey-sync-check.sh` 公钥单一真源）在 `kore-plugins` 缺失时**仍然 FAIL**（脚本原文 `[ -f "$VALIDATE" ] || fail`，早于本次接入）。因此「整段在独立 clone 下 SKIP」当前做不到——那是既有判据，本次不放宽；`market` 子步骤自身的 SKIP 语义按约束实现并实测（下表）。若将来要让独立 clone 全绿，需要单独裁决公钥检查的缺失目录语义，不在本门禁范围内。

**正反例自证（2026-11-24 实测；反例在 `/tmp` 的 mock 副本上做，未触碰共享索引仓与主实例运行态）**：

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 正例（当前一致） | `make market-check` | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` / exit 0 |
| 反例（mock 里把 `echo` 版本 0.1.5 改成 9.9.9） | `make market-check KORE_PLUGINS_DIR=/tmp/kp-mock-market` | `[FAIL] market/plugins.js 与 index/plugins.json 不一致` + `echo: market=9.9.9 index=0.1.5` / exit 2 |
| 还原后 | 同上 | `[OK]` / exit 0 |
| `kore-plugins` 缺失 | `make market-check KORE_PLUGINS_DIR=/tmp/nonexistent` | `[SKIP] 未检出 kore-plugins…` / exit 0 |
| 目录在但不是索引仓 | `make market-check KORE_PLUGINS_DIR=/tmp/kp-empty-dir` | `[FAIL] … 缺少 scripts/build-market.sh` / exit 2 |

**跳过规则**：只有「`kore-plugins` 目录不存在」才 `[SKIP]`；「目录在但脚本缺失」「market 与索引不一致」一律 `[FAIL]`，不提供「本机跳过」开关。

### 1.5 第 21 段 · 嵌套 module `pkg/pluginapi` 全量 `-race` 门禁（阻断级，2026-11-24 接入）

**防的事故**：`pkg/pluginapi` 是**嵌套 module**（自带 `pkg/pluginapi/go.mod`，根 `go.mod` 用 `replace github.com/pengtang1024/kore/pkg/pluginapi => ./pkg/pluginapi` 指向它）。Go 的 `./...` 只匹配**当前 module 内**的包，**不跨 module 遍历**——实测（go1.26.8，`0c47c2a`）：根 `go list ./...` = **18 个包 / 0 个 pluginapi**；根 `go test ./... | grep pluginapi` = **0 行**；`cd pkg/pluginapi && go test ./...` = **2 个包**。因此第 17 段（`go build ./...`）与第 19 段（全仓 `-race ./...`）**都不覆盖它**：nginxconf 解析器（32 条禁用指令 + 4 个族 + 23 条叶子规则）、`file_write` 协议校验、`ValidateRootAction` / `ValidateRootAppendedArgv`（ADR-0022 三级形状）、`RootCommandPolicies`（13 条受控命令）的 **12 个测试文件**在 `make check` 里零执行。这是**既有覆盖缺口**（非某次改动引入）：一个改动把 `nginxconf` 的 allowlist 改坏，`make check` 照样全绿。

**执行方式**（`bash scripts/pluginapi-race-check.sh`，`make check` 第 21/21 段，`make pluginapi-race` 可单跑；阻断级；不联网、不调用 git、不写状态）：

- `cd pkg/pluginapi && GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout 600s ./...`——固定面 `./...`，口径与第 19 段一致（不按 diff 推断改动包）。
- `exit != 0` → `[FAIL]`（数据竞争 / 测试失败 / 编译失败，一律阻断）；输出含 `WARNING: DATA RACE` 时先单独打红再阻断。
- **一个包都没跑到**（`ok`/`?` 行数为 0）→ `[FAIL]`：固定面为空也是假绿，不允许拿退出码 0 当通过。
- `-race` 需要 cgo：缺 C 编译器 / `CGO_ENABLED` 置不上 1 → `[FAIL]`，**不静默降级成跳过**。
- `pkg/pluginapi/go.mod` 不存在 → `[SKIP]` 退出 0（嵌套 module 被移除的骨架态）。
- `make test`（非门禁的开发目标）同轮包含该 module 的普通测试，避免「本地 `make test` 绿、门禁第 21 段红」的假绿。

**为什么新开第 21 段（选项 B），而不是塞进第 19 段（A）/ 改 `make test`·`race-full`（C）**：① **A 让失败原因二义**——第 19 段的判据是「根 module 的 `./...` 全绿」，把它扩成「再 `cd` 进一个嵌套 module」，同一段同时代表两个 module 面，排障时要先猜是哪个面红；② **C 不成立**——`make test` 不在 `make check` 内（无阻断力），`race-full` 就是第 19 段判据本体，把嵌套 module 并进去等于静默改判据语义；③ **B 有独立执行面**——独立 `[RUN ] 21/21` 行、独立 `make pluginapi-race`，可单跑、可独立读输出，段号重编号是机械改动（21 处 `N/20` → `N/21`），一次性成本换长期可读性。

**耗时**：`cd pkg/pluginapi && go test -race ./...` 实测 **1.28–1.64s**（2 个包；cold 1.64s / warm 1.27s）。整段 `make check` **同树对照**：**163.24s**（20 段）→ **163.01s**（21 段）——墙钟差在抖动内（−0.23s），第 21 段自身 **+1.28s**（约 **+0.8%**）。隔离干净树（HEAD 含本段改动 + 兄弟仓按各自 HEAD 只读展开）上整段实测 **157.34s / 143.10s**（冷 / 热缓存），均 `21/21` 全绿 exit 0；共享工作树在他人并发负载下的一次运行 176.92s（含跨仓 15 仓 `-race` 重跑），属环境抖动，非本段开销。嵌套 module 无第三方依赖、无 go.sum、包级并行，故增量与包体量无关地固定在 2s 内。

**接线防漂移**：第 18 段 `scripts/race-gate-check.sh` 增加 **1c** 接线核对——`pkg/pluginapi/go.mod` 存在时，`Makefile` 必须有 `^pluginapi-race:` 目标、`check` 目标必须调用 `scripts/pluginapi-race-check.sh`，缺任一条 `[FAIL]`（有目标但 check 不调 = 本地不跑；CI 侧由既有 `run: make check` 自动带上，不重复写一份判据）。

**正反例自证（2026-11-24 实测；反例在 `/tmp` 的副本上做，未触碰共享工作树与主实例）**：

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 正例（当前工作树） | `bash scripts/pluginapi-race-check.sh` | `[OK] pkg/pluginapi 全量 -race 通过（2 个包，1s，零 DATA RACE）` / exit 0 |
| 反例（副本删 allowlist 的 `root` 条目） | 同上（`/tmp` 副本） | `[FAIL]` / exit 1；6 个顶层用例失败（`TestNginxStructuralRejects`、`TestNginxRealSiteVHostsAccepted`、`TestValidateFileWriteRequest`、`TestNginxParameterShapes`、`TestFileWriteOptionsWithDirs*` ×2），原文 `nginx 片段第 4 行：指令 "root" 不在 allowlist 内` |
| 还原后 | 同上 | `[OK]` / exit 0 |

**已知局限（实测，必须披露）**：卡里建议的另一种反例——「把 `access_log` 从 `DeniedNginxDirectives` 删掉」——**实测不会 FAIL**（exit 0）。原因：`TestDeniedNginxDirectivesEachRejected` 遍历的是 `DeniedNginxDirectives` **表本体**，删条目等于同时删掉断言；且 `access_log` 不在 allowlist，行为上仍被拒（错误理由从「无条件拒绝」降级为「不在 allowlist 内」，无硬编码用例）。也就是说「每条禁用指令都有逐条断言」在**删除条目**这个动作上不成立——这是 `pkg/pluginapi` 测试设计面的缺口（禁用清单加条目自动被覆盖，减条目则静默失去覆盖）。本次按约束**未改其测试/代码**，仅登记待裁决。

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

**兄弟仓缺失的 SKIP 规则（2026-11-24，第 16 段·market 子检查）**：`make market-check` 在 `../kore-plugins` **不存在**时记 `[SKIP]` 并 exit 0——kore 仓可独立 clone，判据只在索引仓可用时才成立；目录在但缺 `scripts/build-market.sh`、或 `market/plugins.js` 与索引不一致，一律 `[FAIL]`。**注意**：同段内的公钥检查（`scripts/pubkey-sync-check.sh`）在索引仓缺失时仍 FAIL（既有判据，未放宽），见 §1.4「已知边界」。

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

本地 `make check` 已覆盖 **21 段门禁**（第 20 段 G-33 产品可用性为 WARN 级）（docs-check / 依赖白名单 + 兼容基线（参数钉死）/ 交叉编译（G-16 五目标真编译，第 17 段，阻断级）/ 薄壳边界 / 跨仓库边界 / 口径唯一性 / 台账 / worktree / oss / 大小写 / 前端首屏 / 零侵入 / 明文凭据 / 插件仓九件套 / 插件仓规范 / 预设一致性 / 公钥单一真源 / 索引↔市场页派生一致（第 16 段·market 子检查，`make market-check`：kore-plugins 缺失 SKIP、存在但不一致 FAIL，阻断级，见 §1.4）/ race 门禁（第 18 段 boundary 面，见 §1.2）+ 全仓 `-race`（第 19 段，见 §1.3）+ 嵌套 module `pkg/pluginapi` 全量 `-race`（第 21 段，阻断级，见 §1.5），均阻断级），CI 重复执行既慢又浪费 runner 分钟。CI 的定位是**保护分支不被坏代码合入的兜底**，不是日常反馈手段——日常反馈用本地 `make check`。

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

1. 本地门禁已是权威（`make check` 21 段——第 13 段 `plugin-oss-check` 扫 25 个兄弟仓九件套，第 18 段 race 门禁跨仓核对 24 份模板接线，第 19 段全仓 `-race`（实测 +52s），第 21 段嵌套 module `pkg/pluginapi` 全量 `-race`（实测 +1.3s），+ 各插件仓自己的 `make check`）；
2. Gitea 是内网自建，跑 CI 会占用本机资源；
3. 减少维护面：26 个仓 × CI 配置 = 26 份需要同步的 YAML。

### 插件仓配 CI，但少触发（2026-11-23 修正）

24 个插件仓 + `kore-plugins` 索引仓**都配 CI**，触发条件与 kore 一致（`push main` + tag `v*` + PR + `workflow_dispatch`）。理由：没有 CI，贡献者无法在 PR 上得到"能否拉取/能否构建"的反馈。发布前门禁仍由发版流程保证：`gofmt -l` + `go vet` + `go test` + `make dist` 两次 sha 一致 + 干净树复现（见 [docs/RELEASE.md](../docs/RELEASE.md)）。

九件套（含 `.github/workflows/ci.yml`）由 `scripts/plugin-oss-sync.sh` 按 `scripts/plugin-templates/` 渲染；`make check` 第 **13 段**（`scripts/plugin-oss-check.sh`）逐仓校验九件套存在、README oss 标记块、ci.yml 为少触发。

## 7. G-33 产品可用性门禁（第 20 段，WARN 级）

> 判据来源：`4400601` 的 24 插件 × 全站页面可用性审计。动机不是「再加一条门禁」，而是
> **24 个插件全部 `depth_level=production`，用户却连续 13 次反馈产品简陋**——原判据只查边界用例
> 与故障注入，从不查「零参数能不能用」。G-33 补的是这条断链：**产品可用性也必须是被判据挡住的东西**。

### 7.1 七条自动判据（`scripts/usability-check.sh`）

| 编号 | 判据 | 实现（判据不放宽） |
| --- | --- | --- |
| A1 | 写操作零参数不得返回 `E_INVALID`（允许 `E_NEED_ROOT` / `E_UNAVAILABLE` / `E_CONFIRM_REQUIRED`） | 插件仓必须存在 `func Test*ZeroParam` 的 **in-process** 用例（`package main` 的 `dispatch()` 或 `internal/*` 的 `Call()`，fakeExec 级替身，不碰真系统）；门禁 `GOWORK=off go test -run ZeroParam -count=1 ./...` **真跑**，PASS 才算过。只登记不跑 = 不满足 |
| A2 | `info.json` 必填 `presets`；create 类（`methods` 含 `*.create` / `*.add`）≥1 个预设 | `json` 解析 + `presets` 必须为数组；create 类空数组即违规 |
| A3 | `invalid("...")` 的 message ≥8 字且含「请/应/需/例/如」 | 源码正则取字面量，逐条校验；变量入参无法静态核对，计入 `unverified`（人工 WARN 面） |
| A4 | 用户可见字符串零内部术语（实例 / 生命周期 / capability / revision） | 扫 `web/*.js` 与插件 `web/*.js|*.html` 的字符串字面量；HTML 按可见文本行（整行注释不计） |
| A5 | 每个视图必须有空状态 + 跳转 | 视图集合 = `SHELL_ROUTES` / `HUB_DEFS` 引用到的懒加载模块 + 内联视图；文件须含 `empty-state` 且含 `button(` / `navigate(` / `scrollIntoView` |
| A6 | 一级菜单 ≤10 且 `store` / `plugins` 不得并存 | 解析 `web/*.js` 的一级路由注册表（`SHELL_ROUTES` / `HUB_DEFS` / `HUB_ROUTES` / `FIRST_LEVEL_ROUTES`，不绑死文件名）；找不到注册表 → 显式 FAIL（不许静默跳过） |
| A7 | 主流程 ≤3 点击 | `web/usability.yaml` 的 `views.<id>.main_flow` 标注，步数 1–3；缺标注即违规 |

### 7.2 四条人工判据（WARN，不自动判）

1. 抽 3 个错误码看「怎么办」——文案是否给出下一步，而不只是错误码/堆栈。
2. 小白 60 秒完成——按 `usability.yaml` 标注的路径实测。
3. 空状态按钮可达——按钮不仅要存在，还要点得动、落到正确视图。
4. 对标宝塔差距记入 [docs/PLUGIN-MATURITY.md](../docs/PLUGIN-MATURITY.md) §3.5（每条差距带证据与优先级）。

### 7.3 分层上线（不一次打红）

- 存量违规登记在 [scripts/usability-pending.txt](../scripts/usability-pending.txt) → `[WARN]`；
- **未登记的新违规 → `[FAIL]`**（脚本 exit 1）；`<规则> <目标> <N>` 只豁免前 N 条，第 N+1 条起仍 FAIL；
- 条目修好即删、条数下降即下调 N；残留条目会被 `[WARN]` 提示——**移出清单 = 转硬判据**；
- `make check` 第 20 段取 WARN 级（与 store-check 同口径）：打印 FAIL 计数但不阻断，判据本身未放宽；
  转阻断只需把 Makefile 的 `bash scripts/usability-check.sh` 改成 `if ! bash ...; then fail=1; fi`。

### 7.4 A1 可行性结论（为什么是「每仓 20 行 in-process 测试」而不是内核侧统一跑）

- `pkg/pluginapi/pluginapitest` **只做静态清单自检**（`CheckInfoJSON` / `ValidateInfoFile`：root_actions / method_capabilities / capabilities 的声明一致性），**不启动插件、不执行方法**，不能用来测 A1。
- 可行路径已实测：插件在 `package main` 内以 `dispatch(request, cfg, logger)` 分发，`*_test.go` 可直接构造 `pluginapi.Request` 调它；`kore-plugin-backup` 的 `internal/backupop/preset_test.go:TestCreateZeroParamsUsesDefaultPreset` 就是范例（门禁 `go test -run ZeroParam` 实测 PASS）。
- 因此 A1 的判据落在**插件仓**：每仓 20 行 `TestZeroParam`（`NewRuntime(..., fakeExec)` 级替身），门禁只负责发现 + 真跑 + 分层。修插件仓是独立卡，本门禁先把「没有这条测试」变成可见违约。

### 7.5 自证

`bash scripts/usability-check.sh --self-test` 内置 5 个 fixture：正例 PASS；反例① 去 `presets` → A2 FAIL；
反例② message 改纯错误码 → A3 FAIL；反例③ UI 加「实例」→ A4 FAIL；反例④ 导航 11 项 → A6 FAIL。
新加判据必须同时补 fixture，否则视为判据不可信。
