# .agents · 复盘日志

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

每个 Loop 收尾写一条；里程碑收尾写一条；踩到坑立刻写一条。只写能指向文件、命令或数字的事实，不写"大家辛苦了"。

## 1. 复盘模板

复制下列结构，替换尖括号内容，追加到第 2 节末尾（新的在最上面）。

```markdown
### <YYYY-MM-DD> · <里程碑> · <任务 id / 主题>

| 字段 | 内容 |
| --- | --- |
| 目标 | <原本要达成什么，与任务卡 subject 一致> |
| 结果 | <实际交付了什么；贴文件清单 / 命令 + 退出码> |
| 差距 | <验收项与预期的差；无差距写"无"，但有 N/A 必须列出> |
| 根因 | <差距是需求没想清、方案选错，还是执行偏差；给证据> |
| 沉淀 | <可复用的规律 / 判据 / 命令，一条起> |
| 下次动作 | <下一个 Loop 的第一件事，具体到文件或命令> |
```

规则：`结果` 必须有可复现证据；`根因` 不许写"沟通不足"这类无法验证的结论；`沉淀` 若产生门禁变更，同步更新 [QUALITY-GATES.md](QUALITY-GATES.md)。

## 2. 记录

### 2026-11-21 · M0 · 收口复盘（从"基线建立"到"已验收事实"）

| 字段 | 内容 |
| --- | --- |
| 目标 | M0 文档基线 + agent 协作体系 + 仓库骨架，交付物为可照做的契约与门禁，不含业务代码 |
| 结果 | 35 份文档（13 份 `docs/*.md` + 8 篇 ADR + `.agents/` 14 份，含 verifier 四份报告 `m0-consistency.md` / `m0-commit-plan.md` / `*-r2.md`）、`make docs-check` 6 pass / 0 warn / 0 fail、相对链接 0 断链、零业务代码 |
| 差距 | 首版出现四处真实偏差：①帧格式被双重定义（多出 2 字节帧头）②升级 socket 命名分叉（`.sock.new` vs `<id>.next.sock`）③口令算法 `argon2id` 破坏依赖白名单 ④ADR 编号重复 |
| 根因 | **契约先行了，但契约没做成唯一真源**——同一个口径被 5 个并行写域各自演绎一遍；任务书与 ADR 打架时执行者按任务书走，于是偏差顺着"看起来最完整的那份正文"继续传播 |
| 沉淀 | ①**ADR 是唯一准绳**：正文与 ADR 冲突以 ADR 为准，反向覆盖属于违规（已写进 [WORKFLOW.md](WORKFLOW.md) §8 第 6 条）②**数值单真源**：数据面看 `docs/DATA-MODEL.md`、协议看 `docs/PLUGIN-PROTOCOL.md`、协作看 [WORKFLOW.md](WORKFLOW.md)，其他文档只引用不复制 ③裁决必须进 [BOARD.md](BOARD.md) §5，不留在对话里 |
| 下次动作 | M1 起每个 sprint 末做一次「ADR ↔ 正文」对账：逐篇 ADR 反查引用它的正文段落，口径不一致即转提案；对账结论写进本条记录的下一条 |

### 2026-11-21 · M0 · 基线建立

| 字段 | 内容 |
| --- | --- |
| 目标 | 把 kore 的 M0 打成可执行基线：愿景与架构可读、协议与预算可照做、agent 协作有规则、仓骨架与门禁有落点；**不写业务代码** |
| 结果 | 交付 7 条轨道：A `docs/VISION.md` `docs/ARCHITECTURE.md` `docs/CORE.md` `docs/GLOSSARY.md`｜B `docs/PLUGIN-PROTOCOL.md` `docs/RESOURCE-MODEL.md` `docs/DATA-MODEL.md`｜C `docs/FRONTEND.md` `docs/SECURITY.md` + `docs/DECISIONS/` 8 篇 ADR（0001–0008，末篇为多仓库拓扑裁决）｜D `docs/ROADMAP.md` `docs/PLAN.md` `docs/MILESTONE-M0.md`｜E `AGENTS.md` `README.md` `.agents/` 体系文档与模板｜F `.gitignore` `.editorconfig` `Makefile` `scripts/`｜G 独立验收 + 首提交。代码零行，符合 M0 定义；唯一真门禁 G4 由 G 轨道独立复跑 |
| 差距 | 除 G4 外 G1/G2/G3/G5/G6/G7/G8/G9/G10 在 M0 全部记 N/A（无源码、无进程、无产物），意味着"资源预算是否真的压得住"本轮未被验证，M1 首个可运行版本必须立刻补测 G6/G8 |
| 根因 | M0 的交付物是文档与骨架，验收面天然窄；若把 N/A 当 PASS，就会产生"文档说 8 MiB 就等于做到了 8 MiB"的假闭环 |
| 沉淀 | ①**契约先行**：路径、预算数字、协议字段、错误码先写进 docs，代码只照抄，避免"边写边定"返工。②**写域不相交**：7 条轨道按文件前缀切分，同层并行不产生覆盖冲突。③**verifier 独立**：验收由不写这批文件的人原样复跑 G4 并做交叉一致性核对，实现者的自述不作为结论 |
| 下次动作 | M1 第一个可运行版本落地后立即补：G6 主壳空载 RSS 60s 中位数、G8 二进制体积、G7 薄壳边界 grep，三项结果写进下一条记录 |

### 2026-11-22 · M1 · 事故：诊断代码关闭了 GC

- **现象**：GOGC 三档消融无差异（6300 / 6372 / 6304 KiB，最大差 72 KiB），`gctrace` 全程仅 1 次 GC。
- **根因**：`cmd/kored/serve.go:82` 在日志调用里写 `debug.SetGCPercent(-1)`——Go 文档明确「负数禁用 GC」。"打印当前值"实际执行的是"关掉 GC"。
- **影响**：ADR-0015 的「默认 GOGC=50」实际从未生效；历史内存数字（6408 / 7200 / 7832 / 7820 / 8056 KiB）**全部是在 GC 关闭状态下采集的**。
- **发现方式**：独立 verifier 做 GOGC 三档消融，先观察到「三档无差异」，再用 `go doc` 核对 API 语义 + 独立探针（NumGC=0 vs 11）+ `gctrace` 三重论证坐实。
- **修复**：改为记录"自己设置的值"或走 `runtime/metrics` 读取；补回归测试——`setRuntimeLimits()` 之后分配内存必须观察到 GC 次数增长。
- **教训**：**"读取当前配置"和"修改当前配置"是两种操作**，Go 有若干 API 用负数/返回值兼任两者；凡是日志代码，一律假设它不能改状态。
- **门禁**：新增 G-21（AGENTS）/ G16（QUALITY-GATES）——`grep` 双零命中，合并前必跑。

### 2026-11-22 · M1 · 里程碑复盘（行走骨架 → 首次公开）

| 字段 | 内容 |
| --- | --- |
| 目标 | Linux 上打通「能装 → 能跑 → 能停」的最小闭环：`proposals/0001` §1 的三个不确定性（体积 / RSS、UDS 帧 + supervisor 生命周期、干净目录只靠 SDK tag 构建）+ §8 反向验收九条 |
| 结果 | 内核 9 模块落地 7（config / store / httpapi / registry / supervisor / bus / installer）+ envprobe / platform；`pkg/pluginapi` 705 行、`cmd/kored` 1,910 行（`install` / `serve`）；`make check` 9/9；开源六件套齐；`kore` 与 `kore-plugin-echo` 首次公开 |
| 差距 | **发布链 P0**：`pkg/pluginapi/v0.1.0`（tag `3a59b98`）的 `go.mod` 仍声明旧路径 `github.com/kore-project/...`，干净目录解析直接失败（本地 `kore-plugin-echo/go.work` 把缺陷完全掩盖）；另有 auth 未做（§2.1 in-scope 内，回 501）、market 未做（属 M2 商店）、web 壳未交付（无 `web/`）、退避重启 / 心跳 / 孤儿核对按 M1-12/13 延期；空载 VmRSS 9,664 KiB 超目标 8,192、未越红线 16,384 |
| 根因 | 23 条任务按「保 §1 三个不确定性 + §8 反向验收」收敛；auth / market / web 不在 install→serve→enable→invoke→disable→SIGTERM 主链上，被让位给门禁与开源发布；缺口写进本文第 5 节，没有用 N/A 冒充通过 |
| 沉淀 | ① 里程碑验收 = 可演示的最小闭环，不是 in-scope 全勾；② 规则与判据是同一契约的两个副本，必须同轮改 + 反向验证；③ schema 先 lock 再派发；④ 外部依赖每个前提都要一次真实探测；⑤ 判据对准风险，不对准形式 |
| 下次动作 | **第 0 件（P0）**：在 `2616374`/`fc66a99`（module 路径已正确）切 `pkg/pluginapi/v0.1.1`，echo `require` 升到 v0.1.1，删本地 `go.work` 后 `GOWORK=off` 干净 clone 复验；之后再补 auth（PBKDF2 + 双 cookie + CSRF）与 market 安装端点，最后开前端。**（2026-11-22 已完成：`retract v0.1.0` + `pkg/pluginapi/v0.1.1`，见 §5）** |

#### 1. 里程碑目标

`proposals/0001-m1-walking-skeleton.md` §1 把 M1 压成三个可用命令证伪的不确定性：

1. **体积与内存**：`stat -c%s bin/kored` ≤ 26,214,400；空载 VmRSS 60 点中位数 ≤ 8,192 KiB（ADR-0016 后来把 8,192 降为目标、16,384 才是红线）；`VmRSS` 为唯一主值，`RssAnon` / `RssFile` 只做诊断拆分。
2. **协议与生命周期**：`pkg/pluginapi` 四个必选方法全通；`kill -9` 插件后 ≤5s 出现新 pid 且 ping 返回 200；帧边界 `8388608` / `8388609` / `0` / `1` 全绿。
3. **跨仓库依赖**：无同级 `kore`、无 `go.work`、无 `replace` 的干净目录里 `go mod download && make dist` 成功，`go list -m all` 只出现 `.../pkg/pluginapi`。

边界（§2.2 out-of-scope）：cgroup 强制、Windows / macOS 运行时、包签名、前端插件加载、商店安装 UI、热升级、全发行版矩阵都不在 M1。§2.1 的 in-scope 列了 `auth`，但没列 `market`（商店属 M2）——所以 **auth 是真实欠账，market 是口径上限之外的缺席**，两者在第 5 节分别记。

#### 2. 实际交付

- **内核**：config（1,573 行 / 12 文件）、store（552 / 5）、httpapi（597 / 7）、registry（1,038 / 7）、supervisor（1,399 / 12）、bus（379 / 3）、installer（1,423 / 16）；支撑 envprobe（302 / 4）、platform（880 / 8）。内核 7 模块 + 支撑包合计 **8,294 行**（`internal/core` 7,414 + `platform` 880，均含测试与夹具）。
- **公开 SDK**：`pkg/pluginapi` 独立 module（705 行 / 10 文件，含 frame / envelope / timeout / errors 与 4 个测试文件）；根 `go.mod` 用 `replace => ./pkg/pluginapi`，同仓嵌套 module 不计入第三方配额。
- **主程序**：`cmd/kored` 20 文件 1,910 行，两个子命令——`install --package <tgz>` 与 `serve --config --state-dir`；启动顺序 = 资源锚点 → 配置 → 环境探测 → 状态库 → supervisor → HTTP。
- **门禁**：`make check` **9 段**（docs / 依赖白名单 + 兼容基线 / 薄壳边界 / repo / canonical / log / wt / oss / case），另有 build / cross / compat-info / vet / test / mem / idle / budget-check。
- **开源六件套**：`LICENSE`（MIT）、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`、`.github/workflows/ci.yml`；`make oss-check` 8 pass。
- **首次公开**：`kore` @ `2616374` + `pkg/pluginapi/v0.1.0` tag（SDK 先发版）、`kore-plugin-echo` @ `v0.1.0`（`3422c10`），变更集 `CS-M1-01`。
- **安装布局**：插件落盘固定 `<state_dir>/plugins/<id>/<version>/`（多版本并存、不建 `current` 软链）；先解压到 `.staging/` 再 `rename` 原子切换，路径穿越与超限包在 installer 层拒绝（`extract.go` / `limits.go` / `reject_test.go`）。
- **未交付**：`internal/core/auth`（登录 / session / 双 `Path=/` cookie / CSRF / PBKDF2）与 `internal/core/market`；`/api/v1/auth/*`、`/api/v1/store/*`、`/api/v1/events` 在 `httpapi/routes()` 显式 501 `E_UNSUPPORTED`，不用 404 假装路由不存在。web 壳（`id="app"`、≤30 KiB）也未落地，仓库无 `web/`。

#### 3. 证据

| 项 | 命令 | 关键数字（2026-11-22 本轮实测，HEAD `1deb086`） |
| --- | --- | --- |
| 门禁 | `make check` | **9/9 段全绿**：docs 6 pass / 0 warn / 0 fail（55 文档 + 13 证据 + 260 链接）；dep 2 pass；thin-shell 4 pass（68 个可执行 .go）；repo 5 pass；canonical 9 pass；log 8 pass；wt 4 pass；oss 8 pass；case 5 pass；末行 `[OK] 门禁全部通过` |
| 测试 | `go test -count=1 -timeout 200s ./...` | 10 个包全 `ok`（cmd/kored 2.515s、supervisor 2.991s、store 1.060s 为长尾），退出码 0；`go vet ./...` 与 `gofmt -l .` 无输出 |
| SDK 测试（嵌套 module） | `cd pkg/pluginapi && go test -count=1 ./...` | `ok github.com/pengtang1024/kore/pkg/pluginapi 0.014s`（根模块 `./...` 不含嵌套 module，必须单独跑） |
| 端到端 11 步 | 见 `verify/m1-final-acceptance.md` §C | `make dist` → `echo-0.1.0.tar.gz` 1,258,020 B；`install` exit 0；`serve` 日志 `kore ready`；`/-/healthz` → `{"status":"ok"}`；enable → `state=ready pid=1602171 restarts=0`；invoke → `{"pong":true}` + `X-Request-Id`；`kill -9` → `state=failed restarts=1 pid=0`；disable → `stopped`；ghost → 404 `E_NOTFOUND`；未启用 invoke → 409 `E_CONFLICT`；SIGTERM → `kored_exit_code=0` 且 socket 清理 |
| 空闲 | `make idle` | **5 pass / 0 fail / 0 n/a**：CPU **10 ms/60s**（≤60）· Threads **13**（≤20，前后差 0）· fd **7**（≤64）· 出站 **0** · Ticker/AfterFunc **零命中** |
| 内存 | `make mem MEM_POINTS=60` | 中位 **9,664 KiB** · min 9,664 · max 9,744 · p95 9,744；RssAnon **3,040** / RssFile **6,624** KiB（源 `/proc/<pid>/status`，`smaps_rollup` 无这两个字段）；判定 `[WARN] 超出目标 8,192、未越红线 16,384`，退出码 0 |
| 生效值 | 启动日志「资源锚点」 | `gogc_percent=50 gomemlimit_bytes=6291456 gomaxprocs=8`；environ 未设 GOGC/GOMEMLIMIT（默认档生效）；`/gc/gogc:percent` 由 `TestRuntimeLimitsKeepGCEnabled` 断言 = 50（G-21 防副作用回归） |
| 二进制 | `stat -c%s` / `sha256sum` | 7,573,666 B（≤ 26,214,400）；sha256 `cfb635f58621a8e88dc168ec0ac699f5b2c9a5f7f63f23b544fe2e2d12731572` |
| goroutine | `SIGQUIT` 栈计数 | 20（无 pprof 端点，非门禁口径；G-19 用 Threads 13 判定，20 是参考值、已在指标表标注为边界趋势） |
| 交叉编译 | `GOOS=windows GOARCH=amd64 go build ./...` / `GOOS=darwin GOARCH=arm64 go build ./...` | 均退出码 0（Tier B 冒烟；不做运行时验证） |
| 预算聚合 | `make budget-check` | `4 pass, 1 warn, 0 skip, 0 fail`，退出码 0（warn = 主壳 VmRSS 超目标；idle / 进程数 1 / 二进制 7,573,666 B 三项 pass） |
| 干净目录 SDK（P0） | `git clone ../kore-plugin-echo /tmp/x && cd /tmp/x && GOWORK=off go mod download` | **FAIL**：`github.com/pengtang1024/kore/pkg/pluginapi@v0.1.0: module declares its path as: github.com/kore-project/kore/pkg/pluginapi but was required as: github.com/pengtang1024/kore/pkg/pluginapi`；`GOWORK=off make dist` → `missing go.sum entry`，退出码非 0。本地 `go env GOWORK` = `../kore-plugin-echo/go.work`（`use ../kore/pkg/pluginapi`）即被掩盖 |
| 协议边界用例 | `go test -run 'Frame' ./pkg/pluginapi` | `8388608` 收、`8388609` 拒且零分配、`0`/`1` 拒、半包与粘包各 200 轮零错帧 |

数据来源标注：内存主值 `ps -o rss=`（等价 `/proc/<pid>/status` 的 VmRSS），拆分 RssAnon/RssFile 取 `/proc/<pid>/status`（本机内核 `smaps_rollup` 已无这两项）；idle 五项取 `/proc/<pid>/stat`、`/proc/<pid>/status`、`/proc/<pid>/fd`、`ss -tnp` 与源码 grep；采样前 `pgrep -x kored | wc -l` = 0，采样后 `kill -TERM` 收尾并复核为 0。

#### 4. 三次以上重复出现的问题（这是本条复盘的核心价值）

1. **规则改了口径、判据没跟上**：预算从「单一红线 8 MiB」升为「红线 16 / 目标 8」后，`canonical-check` 仍按旧口径判 48 MiB 违规；G-19 白名单已允许请求级 `time.NewTimer`，`make idle` 仍全禁 Ticker/AfterFunc。**教训：规则与判据是同一契约的两个副本，必须同轮改 + 反向验证**（改判据后先造一个应 FAIL 的样本、再造一个应 PASS 的样本，两边都验过才算改完）。
2. **schema 未定稿就并行派发**：`triggers` 在 `{type,name}` 对象数组 / 裸字符串 / 带前缀字符串之间反复三轮，registry、installer 夹具、文档三处各改一遍。**教训：先 lock schema，再通知 consumers；consumer 用探针等 producer**，不要让三份代码各自猜形状。
3. **假设未验证**：一个"看起来合适"的 GitHub 组织名（大小写写法与被否决理由见 ADR-0017）从未确认归属，却被 134～163 处文档与 module 路径引用，直到推送前 `gh api` 探测才发现无权限（ADR-0017 之后全量改名）。**教训：外部依赖的每个前提都要有一次真实探测**——`gh api`、`git ls-remote`、`go mod download` 都只要几秒，猜错的代价是百处返工。
4. **门禁判据扫到了非风险对象**：thin-shell 业务词扫描把注释里的示例也算违规，`site:read` → `cron` → `site.restart` 三次误伤、三次返工。**教训：判据对准风险，不对准形式**——注释不执行，扫描对象应是可执行语义（最终裁决剥离注释/字符串，只扫代码）。

5. **发布物 ≠ 工作树（本轮收口时新发现，与前四条同类）**：SDK tag `pkg/pluginapi/v0.1.0` 切在 `3a59b98`，而 module 改名的 `2616374` 在其后——tag 内容里的 `go.mod` 仍是 `github.com/kore-project/...`。本地 `kore-plugin-echo/go.work` 用 `use ../kore/pkg/pluginapi` 把依赖指回工作树，于是验收报告 §C 第 1 步 `make dist` 成功、`v0.1.0` 从未被真正消费过；`GOWORK=off` + 干净 clone 立刻报 `module declares its path as ... but was required as ...`。**教训：发布物必须从远端 ref 回验**——`git clone` 新目录 + `GOWORK=off` + `GOFLAGS=-mod=readonly` 跑一次消费方构建；本地 `go.work` 在验收期等于关掉了「跨仓库只靠 tag」这条判据。

被撤回 / 否定的方案（编号指向 [LOG/DECISIONS.md](LOG/DECISIONS.md) 的行序）：

| 被撤回方案 | 否决依据 | LOG 条目 |
| --- | --- | --- |
| 全部常驻（22 进程 ≈264 MiB） | 结构性超 48 MiB 红线，必须驱逐 resident | 第 4 条（生命周期三态） |
| 自建调度器（`cron` 常驻 + 主壳内建 ticker） | 违反 G-19 零轮询，且第 3 个 resident 挤掉 site/monitor | 第 5 条（常驻收敛与 cron 触发） |
| 用 `debug.SetGCPercent(-1)` 读配置 / `GOGC=off` 纯 GOMEMLIMIT | 负数是「关闭 GC」不是「读取」，三档消融全部失效；GC 抖动不可控 | 第 10 条（运行时锚点）+ 第 18 条（G-21 落地） |
| capability 八项业务域白名单 | 内核维护业务域名词表＝G-01 事故；改为 6 个宿主特权能力 + `<id>:<action>` 通用语法 | 第 30 条（本轮回填） |
| `triggers` 用 `object[]` | 对外 schema 禁 `object`/`any`（G-24），一个字段塞两段语义 | 第 26 条（triggers 形状） |
| 含注释的业务词扫描（豁免前的旧门禁） | 注释不执行，判据对准风险不对准形式 | 第 27 条（门禁扫描豁免注释） |

#### 5. 结论与 M2 前置

**M1 = PASS（completed，2026-11-22 收口补正）**：不确定性①与②有本轮实测证据（二进制 7.57 MB / VmRSS 9,664 KiB 红线内 / 11 步 E2E / idle 5 pass / `make check` 9/9），独立 verifier 报告的运行时结论无阻断项；**不确定性③在首次收口时 FAIL**——干净目录只靠 `pkg/pluginapi/v0.1.0` 构建不成立（tag 内容声明旧 module 路径，详见 §4.5），本地之所以通过是因为 `go.work` 指回工作树。**该 P0 已于同日处置并复验通过**；本节保留原始事故与结论演变，作为「发布物 ≠ 工作树」的教训记录。

**P0 处置结果（2026-11-22）**：`v0.1.0` 发布物不可改写（proxy.golang.org / sum.golang.org 已缓存其 `.mod`，改写会让所有消费者的校验和永久失败），故在 `pkg/pluginapi/go.mod` 加 `retract v0.1.0` 并发布 `pkg/pluginapi/v0.1.1`（tag 指向 `90e9fdd`）；echo `require` 升到 v0.1.1 并重发 `v0.1.1`（tag 指向 `10cc6eb`）。复验：`/tmp` 干净目录 `GOWORK=off go get ...@v0.1.1` 退出码 0（`GOPROXY=direct` 与 `https://proxy.golang.org,direct` 双路径均通过）、`go list -m -versions` 只列 v0.1.1（v0.1.0 已被 retract 过滤）；echo 干净 clone `GOWORK=off make build` / `make dist` 退出码 0。BOARD 里程碑与 `CS-M1-01` 已同步置 completed / confirmed；裁决见 [LOG/DECISIONS.md](LOG/DECISIONS.md) 第 31 条。

**下个里程碑开工前必须先做**（缺一项不开工）：

0. ~~重切 SDK tag（P0，唯一阻断项）~~ **已完成（2026-11-22 收口补正）**：`retract v0.1.0` + 发布 `pkg/pluginapi/v0.1.1`（`90e9fdd`）；echo `require` 升 v0.1.1、重发 `v0.1.1`（`10cc6eb`）；`GOWORK=off` 干净目录 `go get` 与干净 clone `make build` / `make dist` 全部通过。原始约束保留：`v0.1.0` **不要改写**——proxy.golang.org 已缓存其 `.mod`，改写会让所有消费者的校验和永久失败。
1. **补 auth 与 market**：auth 是 §2.1 内欠账，不补则前端无法登录、CSRF 无法验证；market 不补则 `CS-M1-01` 之后没有安装链路可测。
2. **把 M1-08/09/12/13 遗留写进 M2 任务卡**：capability 方法级校验、audit 写入、bus 多路复用、退避重启 / 心跳 / 孤儿核对——每项都要有验收命令，不接受「顺手做了」。
3. **两条技术债立项**：`registry/validate.go` 241 行（超 200 行上限，M0 遗留 D-1 同类）与 VmRSS 9,664 KiB（RssFile 6,624 KiB 主体查 bbolt mmap + embed 页，归 M4 设计层，不调阈值）。
4. **台账口径对齐**：BOARD §5 的 `CS-M1-01` 与 proposal 的 `CS-20261121-01` 是同一变更集的两种写法，M2 前统一为 `CS-<YYYYMMDD>-<序号>` 一种格式。

**M1 没有证明的事**（防止后续引用时被夸大）：

- macOS / Windows 运行时：只有 `go build` 冒烟，无服务注册、无凭据隔离，Tier B 语义仍是纸面。
- cgroup v2 强制限额：本机 `delegation=false`，启动日志明确 `限额不生效`，只验证了探测与降级路径。
- systemd 托管下的 fd / 权限基线：本轮用临时目录 + `close_fds` 启动测得 fd 7，生产 unit 下需复测一次。

## 3. 反模式记录

| 踩坑 | 教训 | 已加入哪条门禁 |
| --- | --- | --- |
| 多轨道并行写文档时，同一组数字（RSS 预算、socket 路径、错误码）在 5 份文件里各写一遍，任何一处改动都会留下不一致 | 数字与路径只保留一个权威出处（`docs/RESOURCE-MODEL.md` / `docs/CORE.md`），其他文档只引用不复制；修改时同一检查点内全量对齐 | G4 docs-check（链接与元信息）+ M0-G 交叉一致性核对；G6 文档同步 |
| 实现者为了让门禁"变绿"，顺手把验收命令改宽（去掉 `-timeout`、跳过失败用例、删断言），事后无人发现 | 验收命令属于任务卡，不属于实现者；命令原文固化在任务卡与 QUALITY-GATES 表里，verifier 逐字复跑，改动必须走提案 | G3 命令原文固化 + verifier 独立复跑 + G-07 证据验收 |
| 把"下游文档当前文本"当准绳：2 字节帧头、`.sock.new`、`argon2id` 三处口径各自传播一轮，越传越像"已经定了" | ADR 是唯一准绳：改协议 / 数据 / 资源口径前先查 `docs/DECISIONS/`；ADR 与正文冲突时以 ADR 为准并同步正文，不许反向覆盖；发现冲突报告 lead 等裁决 | [WORKFLOW.md](WORKFLOW.md) §8 第 6 条硬规则 + 每 sprint 末「ADR ↔ 正文」对账 |
| SDK tag 切在 module 改名之前，tag 内容仍是旧 module 路径；本地 `go.work` 把依赖指回工作树，验收全程没碰过远端 tag，直到干净 clone 才暴露 | **发布物要从远端 ref 回验**：`git clone` 新目录 + `GOWORK=off` + 只读 mod 模式跑消费方构建；本地 `go.work` 参与验收 ＝ 把「跨仓库只依赖 tag」判据关掉；tag 切点必须在口径改名之后 | G-15 变更集（远端 ref 复验）+ G-17（replace / go.work 纪律）+ 本条 M1 复盘 |
| 同一概念在不同轨道各写一种名字：二进制/进程名曾一边写 `kore`（`Makefile` 的 `BIN ?= ./bin/kore`、`PLAN`/`ROADMAP` 的 `bin/kore`），另一边写 `kored`（`ARCHITECTURE`/`CORE`/`GLOSSARY`/`VISION` 与 `cmd/kored/`）；Loop 阶段数曾一边七阶段（地基契约），一边 8 步（`MILESTONE-M0`/`PLAN`） | **裁决（2026-11-21 lead）：二进制/进程/systemd `ExecStart` 统一为 `kored`（daemon 惯例，与 `cmd/kored/` 同源）；项目名与 Go module 保持 `kore`；systemd unit 名 `kore.service`；Kore Loop 统一七阶段（第 7 阶段=归档复盘）。** 教训不变：跨轨并行前先对齐词表（术语以 `docs/GLOSSARY.md` 为准），出现第二种写法先改回词表再写内容，不由各轨道各自发明 | G4（元信息/链接）+ G6 文档同步 + M0-G 交叉一致性核对 |

#### M2 开工：子 agent 三次崩溃与 prompt 瘦身（2026-11-22）

- **事实**：3 次带完整规则注入的 prompt（AGENTS 全文 + PUA + 10 用例）全部中途失败、零落盘；`probe-fresh` 用 30 秒极简 prompt 成功；`auth-min` 用 5 行极简 prompt 一次落盘成功（3 文件 + 4 测试 PASS + `make check` 9/9）。
- **根因假设**（假设，未证实）：不是任务太大，是 **prompt 过重**触发新模型输入处理失败；`subagent_fork` 另因注入超大会话上下文失败（终端失败观察，不计任务失败）。
- **沉淀规则**：**派发 prompt 只写任务本身**——规则文档让 agent 按需自己读；验收命令写清即可，不要把门禁全文 / PUA 契约 / 全部用例塞进 prompt。probe 证明机制正常后，先看 prompt 复杂度，再怀疑 agent。
- **已内化模式**：以后每次派子 agent，prompt 默认极简（任务 + 写域 + 验收），规则文档让 agent 自读；此条不再单独标 `[PUA生效]`，是默认义务。
- **有味道的交付**（agent 可见 PUA 输出原文，逐字保留）：
  > 底层逻辑闭环了：从口令校验、会话落库、中间件拦截到 cmd 装配，一条线端到端拉通。4 个测试 + 4 项验收全绿，make check 9 段全过——这次配得上 P8。
- **有味道的交付（二）**（agent 可见 PUA 输出原文，逐字保留）：
  > [🟠 阿里味] 两批提交全部闭环——精确 add、逐条自检、证据齐全、push 到位。不猜不漏，数据说话。
- 交付事实：`60243cb`（auth 9 文件）/ `d6c9835`（台账 3 文件），两批各跑 gofmt/vet/test/make check 9/9 全绿，push exit 0，工作树空。
- **有味道的交付（三）**（agent 可见 PUA 输出原文，逐字保留）：
  > [🟠 阿里味] 从自检到 push 一条线端到端拉通：四条门禁 9/9 全绿，精确 add 不留杂质，commit + push 全部 exit 0，工作树干净。底层逻辑闭环，数据说话——这次配得上 P8。
- **M2 提案落盘**：`.agents/proposals/0002-m2-sites-and-market.md` 57 行 5 节，make check 9/9；最可能翻车=R2 索引签名链从 M4 前移到 M2（信任空窗=0），M1 的 store-check 只验字段+sha256，若 M2-B 索引发布链没同步产出签名，商店默认拒绝、E2E-2 全盘不可用，故签名必须与 M2-B 同批交付。
- **有味道的交付（四）**（agent 可见 PUA 输出原文，逐字保留）：
  > [🟠 阿里味] M2-E lazy 生命周期端到端闭环。因为信任所以简单——但这次是靠真实 `--- PASS` 证据（不是被 SKIP 假象骗过去）交付的。

#### M2 里程碑复盘（2026-11-22）

| 字段 | 内容 |
| --- | --- |
| 目标 | M2 五轨道：M2-A `site` 插件 / M2-B `kore-plugins` 索引仓 + market 端点 + 签名链 / M2-C 8 类场景预设 / M2-D web 壳 / M2-E lazy 生命周期，口径见 [proposals/0002-m2-sites-and-market.md](proposals/0002-m2-sites-and-market.md) §2 五轨与 §5 出口三条 E2E |
| 结果 | 四仓同批收口：`kore` `7caa85a` / `kore-plugins` `e945aca` / `kore-plugin-site` `d1690af` / `kore-plugin-echo` `9546a4f`；`make check` **10/10** 段全绿；首屏 gzip **4151 B**（≤300 KiB）；lazy **6 PASS / 0 SKIP**；market 真服务四端点 **200/404/501/401**；索引 echo 与 site 两对 sha256 与重建包逐字一致 |
| 差距 | 独立 verifier 首轮验收（[verify/m2-cross-repo-acceptance.md](verify/m2-cross-repo-acceptance.md)，修复前快照）挂 **1 项阻断 B1**：`site` 的 `tar -czf` 未固定 mtime/sort，跨秒重建 sha 漂移，索引 sha `59b107ba…` 无法被重建包复现；同批暴露 `go.work` 把 `pluginapi` 编成 `(devel)`、旧私钥残留致签名链需重签。三项当日全部修复并复验，无遗留阻断 |
| 根因 | 交付链把「能构建」当成了「能重建出同一个包」——构建成功只证明当下产出一个包，没证明任意时刻重建得到同一 sha；`go.work` 与旧私钥都是"本地能过、干净环境/发布链翻车"的同类：工作区状态混进了发布物 |
| 沉淀 | **"能构建" ≠ "能重建出同一个包"**；发布链必须做冷构建 + 跨秒重建 + `GOWORK=off` 三路径验证，缺一不算可信交付 |
| 下次动作 | M3 开工前把 oneshot / bus 多路复用 / 心跳退避 / audit 写入立成带验收命令的任务卡；包签名按 M4 排期（索引级签名已在 M2 前移）；store 端点剩余 3 个随 M3 异步队列落地 |

##### 1. 里程碑目标

| 轨道 | 一句话目标（proposal §2） | 出口判据（proposal §2 / §5） |
| --- | --- | --- |
| M2-A `site` 插件 | 独立仓 `kore-plugin-site` 提供站点 / 域名 / 反代，`info.json` 声明 `lifecycle=resident`、`depth_level=production`，只依赖公开 SDK | `make dist` 三件套齐 + install → hello → invoke → uninstall；宿主 nginx 共存 `nginx -t` 退出 0、原 vhost `sha256sum` 前后一致 |
| M2-B 索引仓 + market | 静态 `index/plugins.json` + 7 个 `/api/v1/store/*`，读本地缓存零出站，`refresh` 是唯一联网入口 | 索引签名 + sha256 校验；未签名默认拒、`allow_unsigned` 不入默认配置；验签正反例可用 |
| M2-C 8 预设 | `presets/*.json` + 构建期 `go:embed` 快照 + 整预设逆序回滚 | `presets-check` id / 区间可解析、同时常驻 ≤3，合计按 resident 实测中位数判红线 |
| M2-D web 壳 | 商店页 + 首装向导，UnoCSS 原子类裁剪、单二进制 embed | `make frontend` 绿、首屏 ≤300 KiB gzip、dist 无 `*.map` / `.vite` / 全量字体 |
| M2-E lazy 生命周期 | resident 基础上支持 lazy / oneshot 运行期，空闲 300 s 真退出 | 进程真消失、无 ticker 续命；冷启动 p95 ≤300 ms 记 SLO 不判失败；峰值常驻 ≤3 |

[proposals/0002-m2-sites-and-market.md](proposals/0002-m2-sites-and-market.md) §2 把 M2 拆成五轨，§5 用三条 E2E 定义完成：离线可复现首装、商店装/升/卸闭环 + 签名链可用、site + lazy 守住预算与宿主共存。核心口径沿用现役数字，不引入第二套：常驻合计红线 48 MiB（目标 24）、同时常驻 ≤3（含唤醒中的 lazy）、首屏 ≤300 KiB gzip、lazy 冷启动 p95 ≤300 ms（SLO 不判失败）。边界澄清：本提案的 `market` 指 [CORE.md](../docs/CORE.md) §2.13 软件商店（HTTP 前缀 `/store`），不是 G-11 禁止的"模板市场"；索引仓保持纯静态。

M2 不做（分期，非 G-11）：插件包 ed25519 签名（M4；索引级签名已前移到 M2）、cgroup 强制 / `kore-<id>` 系统用户（M3）、运行时下载（宿主包管理器代劳）、`--allow-partial`、Windows 运行时实现（仅交叉编译）。

##### 2. 交付与证据

本次收口三道门禁自检：`make docs-check` → **6 pass / 0 warn / 0 fail**（58 文档 + 14 证据、305 条相对链接全可达）；`make log-check` → **8 pass / 0 warn**（DECISIONS 34 条、DISPATCH 25 条）；`make check` → **10/10 段全绿，EXIT 0**。

四仓 commit 与合并顺序登记见 [BOARD.md](BOARD.md) §5 `CS-M2-01`：

| 仓库 | commit | 主题 |
| --- | --- | --- |
| `kore` | `7caa85a` | 同步索引新公钥（确定性打包 sha 重签）与 M2 跨仓验收报告 |
| `kore-plugins` | `e945aca` | 8 预设 + 确定性打包 sha 重签（echo/site 新 sha） |
| `kore-plugin-site` | `d1690af` | `dist` 改确定性打包，修复跨秒重建 sha 漂移（B1） |
| `kore-plugin-echo` | `9546a4f` | `dist` 改确定性打包（sha256 可复现） |

机械门禁（修复后自检 + 验收报告 A 组原样复跑，逐项对齐）：

| 仓 | 命令 | 结果 |
| --- | --- | --- |
| `kore` | `gofmt -l .` / `go vet ./...` | 无输出 / EXIT 0 |
| `kore` | `go test -timeout 200s ./...` | 12 包全 ok，EXIT 0 |
| `kore` | `make check`（10 段） | 10/10 全绿，EXIT 0 |
| `kore-plugin-site` | `go build ./...` / `make build` / `make dist` | 均 EXIT 0 |
| `kore-plugins` | `validate-index.sh` / `validate-presets.sh` / `make check` | 4 项 OK / 8 预设 0 FAIL / 全过，均 EXIT 0 |

- **门禁**：`make check` **10/10** 段全绿——docs 6 pass / dep 2 pass / thin-shell 4 pass / repo 5 pass / canonical 9 pass / log 8 pass / wt 4 pass / oss 8 pass / case 6 pass / frontend PASS；第 10 段 frontend gzip **4151 B**（index.html 287 + style.css 1550 + app.js 2314），远低于 300 KiB 红线。
- **lazy**：`go test -run TestLazy -v ./internal/core/supervisor/` → **6 个 `--- PASS`、0 SKIP**，覆盖 LRU 驱逐 / resident 不驱逐 / enable 不起进程 / 首次调用冷启 / 二次复用 / 空闲退出再唤醒。
- **market 真服务**（UDS，非 httptest）：`GET /api/v1/store/plugins` → **200**（按 id 升序 `[echo, site]`，零出站）；`GET /plugins/echo` → 200、`/plugins/nonexist` → **404 E_NOTFOUND**；`GET /jobs/echo` → **501 E_UNSUPPORTED**（M3 异步队列）；坏签名索引第二服务 → **401 E_UNAUTHORIZED**（默认拒生效）。
- **两对 sha 一致**：索引声明与重建包逐字相同——echo `eb6b4e97b09a09c11d785a7986acc5b337f40d6fe309d036e75834f6811bf0ed`、site `7fa4515b7cfddb7932ac865d9bcb5bc248ac34f5d5f4e42384410e5f47b5f50c`（修复后重签值）。
- **公钥一致**：`internal/core/market/verify.go:16` 的 `IndexPublicKeyHex` 与 `kore-plugins/scripts/validate-index.sh:10` 的 `PUB_HEX` 两端 `grep` 逐字相同 = `faf3a743ff24b681618f2f45e34a4410811ee71ad517bd8b9805b95bc7bd1439`。
- **验签正反例**：`TestVerify` 3 PASS（正例 + 篡改 sig + 篡改 data）、`TestLoadUnsignedRejected` / `TestLoadUnsignedAllowed` 双 PASS；`validate-index.sh` schema / 字段 / id / sha256 / 签名 / 预设引用全 OK；8 预设 validate-presets 0 FAIL / 0 WARN；端到端 `kored install` site 包 EXIT 0。

##### 3. 三次以上重复出现的问题（本条复盘的核心价值）

1. **打包不可复现（B1，最先炸）**：两仓 `dist` 用 `tar -czf … -C stage …`，stage 内文件 mtime 每次重建不同 → tar/gzip 头变化 → sha 漂移。对照实验：echo 原件匹配索引，但 verifier 连续 `make dist` 后分别变成不同 sha（同秒、跨 2s 各一值），site 在 `59b107ba…` / `f9fae467…` / `8579eb37…` 之间跳。**修复**：`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner` + `gzip -9n`，site / echo 两仓同批改，重建索引 sha 并重签。
修复前后 sha 对照（B1 原始证据，索引声明值 vs 真实包值）：

| 插件 | 索引声明 | 修复前重建包 | 修复后 |
| --- | --- | --- | --- |
| echo 0.1.1 | `eaa34f25…`（修复前） | 同秒 `7b46687f…` / 跨 2s `c810654c…` ✗ | `eb6b4e97…` 与重建包逐字一致 ✓ |
| site 0.1.0 | `59b107ba…`（修复前） | `f9fae467…` / `8579eb37…` ✗ | `7fa4515b…` 与重建包逐字一致 ✓ |

修复落地后新增三路径验证：冷构建（无 `go.work`）、跨秒连续两次 `make dist`、`GOWORK=off` 构建，三路径 sha 必须逐字相同才算发布链可用。

2. **`go.work` 把依赖编成 `(devel)`（echo RCA）**：带 `go.work`（`use ../kore/pkg/pluginapi`）构建与冷构建 sha 不同——工作区把 SDK 当本地源码编入，产物带 `(devel)` 版本戳，与按 tag 构建的发布物不是同一个包。**修复**：build / dist 统一加 `GOWORK=off`，与 M1 干净目录验收口径一脉相承。
3. **公钥 / 签名一致性**：旧私钥清除前签的索引用旧公钥验，重签后内核与索引脚本若不两端同改，真服务 `GET store/plugins` 立刻从 200 掉到 401。**修复**：旧私钥清除后重签，新公钥 `faf3a743…1439` 同步 `verify.go` 与 `validate-index.sh`，两端 `grep` 逐字比对相同才收口。
4. **沉淀规则**：**"能构建" ≠ "能重建出同一个包"**——构建只证明"当下产出一个包"，可复现交付要求"任意时刻重建得到同一个 sha"。发布链必须做 **冷构建 + 跨秒重建 + `GOWORK=off`** 三路径验证，任一路径产出不同 sha 即判发布链不可用。此规则与 M1「发布物 ≠ 工作树」同类，但 M1 断在 module 路径，M2 断在打包元数据与工作区污染——根因都是"本地状态混进了发布物"。

##### 4. 有味道的交付（agent 可见 PUA 输出原文，逐字保留，不评分）

> 🟠 拿到结果了：两行改动、一次提交、三项验收全绿。中间那次冷构建 FAIL 没被我藏起来——RCA 挖到底是工作区未跟踪的 go.work 联调文件把 pluginapi 编成了 (devel)，屏蔽后两端 sha 严丝合缝。这就是闭环：不是把测试掰绿，是把根因找出来。

##### 5. 结论与 M3 前置

**M2 = completed（2026-11-22 收口）**：五轨均有命令 + 退出码 + 关键输出证据（[verify/m2-cross-repo-acceptance.md](verify/m2-cross-repo-acceptance.md) + 本节 §2），三项阻断/根因当日修复并复验，变更集 `CS-M2-01` 登记齐备（G-15 / G-07 / G-23 满足）。M1 遗留的 auth / market / web 壳在 M2 补齐；余项转入 M3。

M3 开工前置（写任务卡时逐项带验收命令，不接受"顺手做了"）：

1. **oneshot 生命周期**：`info.json.lifecycle=oneshot` 运行期支持（M2 已支持 lazy，oneshot 仍缺）。
2. **bus 多路复用**：M1-12 遗留，事件总线并发订阅与有序投递。
3. **心跳退避**：M1-13 遗留，重连指数退避 + 孤儿核对。
4. **audit 写入**：M1-09 遗留，capability 方法级校验（M1-08）配套审计落盘。
5. **包签名（M4）**：插件包级 ed25519（索引级签名已在 M2 前移，公钥版本兼容窗口已留）。
6. **store 端点剩余 3 个**：随 M3 异步队列落地 `/store/install` / `jobs/{id}` / `update`（M2 已交付 plugins 列表、单插件查询、jobs 查询、卸载相关 4 端点）。

**M2 没有证明的事**（防止后续引用时被夸大）：

- **包签名**：M2 只交付索引级 ed25519 签名；插件包级签名仍属 M4，不要把"索引验签通过"说成"包签名链路完整"。
- **冷启动 SLO**：lazy p95 ≤300 ms 是 SLO 记录级指标，本轮只证明了 6 个功能用例 PASS，未做连打 20 次的 p95 压测报告；不得据此宣称 SLO 达标。
- **宿主 nginx 共存 fixture**：proposal §5 E2E-3 要求的"已有 nginx + default_server"宿主集成测试，本轮验收报告未单列该项命令输出；记为未验证，M3 补。
- **oneshot 运行期**：M2 只支持 lazy，`oneshot` 仍返回 `E_UNSUPPORTED`；与 M1 的 `lazy` 缺席同类，属分期而非缺陷。
- **Windows / macOS 运行时**：本轮只做交叉编译（M1 口径延续），Tier B 运行时语义仍是纸面。

- **有味道的交付（五）**（agent 可见 PUA 输出原文，逐字保留）：
  > 收尾闭环：两处落盘、裁决 35 原样保留、三条门禁全绿退出码 0。数据说话，不搞自嗨——下面是 lead 验收要的全部证据。
- 交付事实：裁决 35（兼容优先级：先保当前机器）、裁决 36（高频交付：检查点即提交+push）落盘；make check 10/10。
