# .agents · 质量门禁

> 状态: draft · 归属: scribe · 更新: 2026-11-23 · 里程碑: M0

门禁不是建议清单，是"能不能交付"的判定条件。命令必须原样执行——改参数、加跳过、换更宽松的选项，都视为伪造通过。

## 1. 门禁表（G1–G19 + G-28/G-29）

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
| G13 | 兼容性（三平台） | ① `make compat-info`（打印 build flags 与 link flags + `file` + `go version -m`）；② `GOOS=windows GOARCH=amd64 go build ./...`；③ `GOOS=darwin GOARCH=arm64 go build ./...`；④ `grep -rn --exclude-dir=platform "syscall\." internal/core`；⑤ `grep -rn "可能不支持" docs/`。flags 口径：**build flags** = `CGO_ENABLED=0 GOAMD64=v1 GOARM64=v8.0 -trimpath -buildvcs=false`（`-buildvcs` 是 build flag，塞进 `-ldflags` 会报 `flag provided but not defined`）；**link flags** = `-s -w` | ① build flags 与上述一致、`file` 为静态无 interpreter、`go version -m` 无 `-buildvcs` 污染；②③ 退出码 0（M1 起）；④ 零命中；⑤ 零命中 | ②③ 挂 → 把平台分支收进 `internal/platform` 或修构建标签；④ 有命中 → 迁进 `internal/platform`；⑤ 有命中 → 把“可能不支持”改成明确降级行为 | verifier | 里程碑 |
| G14 | 空闲行为 | `make idle`（可用，约 65s）；等价手工取证：`/proc/<pid>/stat` 取 utime+stime 前后差、`/proc/<pid>/task` 计数、`/proc/<pid>/fd` 计数、`ss -tnp` | 空载 60s CPU 时间 ≤ 60ms、goroutine ≤ 20、fd ≤ 64、出站连接 0、定时器仅 `cert_renew`；不得有轮询循环，lazy 插件不得用内部 ticker 续命 | 去掉轮询改事件推送；lazy 插件必须在空闲后真正退出；超预算先砍定时器再谈优化 | verifier | 里程碑 |
| G15 | 深度等级（M3 起） | `grep -r "depth_level" <插件仓>/info.json`；查对标矩阵标注；查 `production` 插件的 `tests/fault/` 目录 | `depth_level` 存在且 ∈ {`production`,`basic`}；`basic` 在对标矩阵中不得标"生产级"；`production` 必须有 `tests/fault/` 且故障注入用例可跑 | 缺 `depth_level` → 不进商店；标错等级 → 改矩阵并复核；没有 `tests/fault/` → 降级为 `basic` 或补测试 | verifier | 里程碑（M3 起） |
| G16 | 无副作用的诊断代码（M1 起） | `grep -rn "SetGCPercent(-1)" --include='*.go' .` 与 `grep -rn "SetMemoryLimit(-1)" --include='*.go' .` **双零命中**；另查同形态"设置即读取"API（`debug.SetMemoryLimit` / `debug.SetGCPercent` / `debug.SetMaxThreads` 等传负数的写法） | 两条 grep 命中数均为 0；读取运行时配置只允许 `runtime/metrics`，或记录"自己设置过的值" | 视为 **P0**（会静默改变运行时行为）：日志里的 `SetGCPercent(-1)` 实测会**关闭 GC**；改为记录自己设置的值或走 `runtime/metrics`，并补回归测试（`setRuntimeLimits()` 后分配内存必须观察到 GC 次数增长） | verifier | 合并前 |
| G17 | 无 any / object 逃逸 | `grep -rn "map[string]any" --include='*.go' internal/ cmd/`（排除 `_test.go` 与 `testdata/`）；`grep -rn "类型：object" docs/`；`grep -rn "json.RawMessage" --include='*.go' internal/ cmd/` | 对外 schema / 对外结构体零 `object` / `any` / `map[string]any`；docs 无「类型：object」；`json.RawMessage` 仅出现在插件方法参数与结果载荷处且写明原因 | 评审退回：字段改成显式结构体，或改用带类型前缀的标量；解析期临时 `any` 必须在一处收口转具体类型 | verifier | 合并前（判定型部分由评审回答） |
| G18 | worktree 卫生 | `make wt-check`（F 落地）；等价手工：`git worktree list` + `git branch --list 'wt-*' 'tmp-*'` | `git worktree list` 仅 1 行（主工作树）；临时分支清单为空；残留的 `/tmp/*` 检出目录已删除 | 先 `git worktree remove`，再 `git branch -d`，最后 `git worktree prune`；有改动未合并则先合并或写明放弃原因 | verifier | 里程碑收口 |
| G19 | 开源资产完整 | `make oss-check`（第 8 段，阻断级）；等价手工：逐个检查根 `LICENSE` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `CHANGELOG.md` / `.github/workflows/ci.yml`，并 `grep -n "MIT License" LICENSE` 与 `grep -n "Permission is hereby granted" LICENSE` | 六件资产齐备；`LICENSE` 含上述两个特征串；无 GPL / Apache / AGPL 等非 MIT 协议头混入 | 缺件即补；协议头冲突则统一为 MIT 并在 PR 中说明；不得以「以后再补」放行 | verifier | 里程碑收口 / 发布前 |
| G-28 | UI 交付双端证据 | 触发：任何涉及用户界面（页面 / 视图 / 组件 / 样式 / 交互 / 文案）的交付，在声明"完成"前；取证：`.agents/verify/screenshots/` 下同时存在 `<场景>-desktop-*.png`（1440×900 或 1280×800，full-page）与 `<场景>-mobile-*.png`（390×844），并用 `file <png>` / `identify -format '%wx%h'` 读实际宽高；另附一段产品定位自评（本页解决什么用户问题 / 与宝塔、1Panel 同类功能的差距 / 当前是"可用"还是"占位"） | 三件套齐备，分辨率与命名匹配；自评三段齐全、不出现"应该是 / 大概"式措辞 | 缺任一项即不得声明完成：补截图（不得缩放糊弄分辨率、不得拿桌面图裁成手机图）或补自评；证据缺失时任务记 BLOCKED，不记 PASS | implementer 取证 + verifier 核对 | 检查点（UI 交付） |
| G-29 | 运行态写边界 | 触发：任务涉及 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 或任何被运行中 `kored` 持有的文件（`git status` 看不出，untracked）。取证：① `curl -s localhost:8787/api/v1/system/info \| jq .paths.index_dir` 必须**逐字等于**配置里的 `kore-plugins/index`（不得指向 `.kore-local-state/` 下任何索引快照）② 商店 `/api/v1/store/plugins` 返回的插件版本必须等于 `kore-plugins/index/plugins.json` 里的版本 ③ 验收报告必须显式声明"本轮是否改动过主实例的运行态配置"，改过则附回切 + 重启 + 复核三行证据 ④ 测试要"不同索引 / 配置 / 状态"时附隔离实例命令（独立 `--config` + state/run/log 落 `/tmp`） | ①② 必须相等（`paths.index_dir` == `kore-plugins/index`、商店版本 == 索引版本）；③ 声明齐全且与事实一致；④ 有隔离实例证据或写明"未触碰主实例"。防的事故：2026-11-23 为测试把 `index_dir` 指向 `signed-index` 快照（04:53:06），恰逢另一轮重签完成（04:53:40），04:59:59 回切前 8787 商店把 discover 0.2.0 显示成 0.1.0——配置回写了、主实例读到的仍是旧数据 | 任一不符即判未完成：回切 + 重启 + 复核后再验一次；未回切或只改配置文件不验 `/api/v1/system/info` 的，任务记 BLOCKED，不记 PASS；workaround 无过期条件（"当 X 发生时失效"）的，记 WARN 并要求补写 | implementer 取证 + verifier 独立复跑 | 检查点（运行态变更） |

> 前提：G1 / G8 的 `bin/kored` 由 `Makefile` 的 `BIN ?= ./bin/kored` 产出（2026-11-21 已对齐：`APP ?= kored`、`BIN ?= ./bin/kored`）。若后续 `BIN` 再被改动导致路径不符，G1 / G8 记「阻塞」而不是 PASS，由 implementer 按 G-06 先对齐 Makefile。

## 2. 三层组合

| 层级 | 时机 | 必跑 | 说明 |
| --- | --- | --- | --- |
| 检查点 | 每个自洽改动完成时 | G1、G2、G4（不跑 G13：构建产物未就绪）；改动过主实例运行态的加 G-29 | 快速反馈，防止把坏代码攒成"大提交" |
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

5. 每条门禁的负责人：G1/G2/G4 由 implementer 自跑，G3/G5/G6/G7/G8/G9/G10 由 verifier 复跑；verifier 不复用实现者输出。
