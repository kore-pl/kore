# 主壳 RSS 构成本机实测（隔离实例 /proc status + smaps）

> 测定者：rss-quant｜持续目标 round 9 性能维度｜采样窗口 2026-11-26T14:50:34Z–14:51:55Z（local 22:50:34–22:51:55 CST）
> 任务：task-148｜依赖结论：task-147（代码零 pprof 端点，路 A 无需改代码）；旧基线：`.agents/verify/v1-budget-measure.md:81`（11-23，VmRSS median 13,496 / RssAnon 4,932 / RssFile 8,564 KiB）
> **口径声明**：`VmRSS`/`RssAnon`/`RssFile` 来源 = `/proc/<pid>/status`（本机内核 7.0.0-44 的 `smaps_rollup` 无 `RssAnon`/`RssFile` 字段，实测 0 行，与 M1 基线同口径）；`smaps` 逐 VMA 的 `Rss`/`Pss`/`Private_Clean`/`Private_Dirty` 来源 = `/proc/<pid>/smaps`；`smaps_rollup` 仅用于 PSS 交叉核对。逐 VMA `Private_Clean+Shared_Clean` 合计 = 9,324 KiB、`Private_Dirty+Shared_Dirty` = 4,880 KiB，与 status 的 RssFile/RssAnon **逐 KiB 相等**（口径自洽，见 §4）。
> 全程未改生产代码、未调参（G-21/G-22）、未联网、未碰主实例运行态（G-29）。

## 1. 环境与隔离实例

| 项 | 值 |
| --- | --- |
| HEAD | `c86442db110cf39bc5ff693b595c509cfe73b397` |
| 二进制 | `bin/kored` 冻结只读副本 `.tmp-rss-quant-20261126/kored`，13,328,546 B，sha256 `da84af3238fc9e79b86134ea8ff20fbb2053350ca5bc7ef84369539dfac850bb` |
| 主机 | i7-13700K · nproc 24 · kernel 7.0.0-44-generic · go1.26.8 · CLK_TCK 100 |
| 启动参数 | `env KORE_HOME=<base> ./kored serve --config <base>/config.yaml`；配置 `profile: portable`，`server.socket=<base>/run/kore.sock`（**UDS-only，`server.addr` 留空 → 无 TCP 端口，非 8787**） |
| 隔离落点 | 全部落工作区一次性目录 `.tmp-rss-quant-20261126/`（config / state/state.db / run/kore.sock / log / kored 副本 / 采集脚本与原始数据），已加入 `.git/info/exclude`；采样后脚本与原始数据全部删除 |
| 沙箱说明 | 本 shell 的 `unshare -r -m` 被工具层拒绝（exit 1「不允许的操作」），但 portable profile 允许把四类路径全部配置为一次性目录，**不需要 unshare 也不碰系统路径**（比 M1 基线的 overlay 沙箱更干净：state fs 真 ext4，非 overlayfs） |
| 资源锚点 | 启动日志 `{"gogc_percent":50,"gomemlimit_bytes":6291456,"gomaxprocs":8}`（kored 默认档，未设任何 GOGC/GOMEMLIMIT/GOMAXPROCS 环境变量；GOGC 真正生效见 m1-memory-baseline.md §9.2 的 `/gc/gogc:percent` 判据，本次未读该指标，仅按默认档口径记录） |
| 稳定性 | 启动后先 `sleep 20` 再采（M1 基线 §3 教训：5s 不足，文本页尚未全部驻留）；60 点间隔 1s |

采集中实测 kored PID=4（本机 bash 每次调用是独立 PID namespace，之前误采到 bash 的 smaps，已用 `/proc/$pid/comm=kored` 校验修正后重采；本报告全部数字来自校验后的 kored PID）。

## 2. 命令 + 退出码

```bash
# 1) 一次性目录 + exclude（kore 仓内）
printf '\n/.tmp-rss-quant-*/\n' >> .git/info/exclude          # exit 0
mkdir -p .tmp-rss-quant-20261126/{state,log,run}              # exit 0
cp bin/kored .tmp-rss-quant-20261126/kored                    # exit 0
sha256sum bin/kored .tmp-rss-quant-20261126/kored             # exit 0，两者一致

# 2) 一次性采集脚本（<base>/sample.sh，单次 bash 调用内起实例+采样+停实例）
bash .tmp-rss-quant-20261126/sample.sh                        # exit 0
#   输出：KPID=4 / COMM_CHECK=kored ok=1 / HEALTHZ={"status":"ok"}
#         START_TS=2026-11-26T14:50:34Z / STABLE_TS=14:50:54Z / SAMPLE_END_TS=14:51:55Z
#         SMAPS_BYTES=38166 / METRICS_HTTP=401 / KILLED=4

# 3) 60 点统计（python3 statistics）
python3 - <status.tsv>                                       # exit 0，count=60

# 4) smaps 分类（<base>/parse_smaps.py，按映射名+权限）
python3 .tmp-rss-quant-20261126/parse_smaps.py <smaps.txt> <base>/kored <result.json>   # exit 0
python3 .tmp-rss-quant-20261126/reconcile.py <smaps.txt> <base>/kored <reconcile.json>  # exit 0

# 5) 主实例未受影响（G-29）
curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz  # 200，采样前后各一次
pgrep -a -x kored                                            # exit 1（采样结束后本 ns 无残留 kored）
```

采集脚本思路：`env KORE_HOME=<base> ./kored serve --config <base>/config.yaml >launch.log 2>&1 & KPID=$!`（简单命令保证 `$!` 为 kored 本体）→ 轮询 `/proc/$KPID/comm=="kored"` → 轮询 UDS healthz → sleep 20 稳定 → 60 次读 `/proc/$KPID/status` 的 `VmRSS/RssAnon/RssFile/Threads`（1s 间隔）→ 末尾快照 `smaps`/`smaps_rollup`/`status` → `kill -TERM`。
**注意**：本机 bash 每次调用是独立 PID namespace，后台进程不跨调用存活，所以起实例+全部采样必须在**同一次 bash 调用**内完成（这也是脚本一次性化的原因）。

## 3. 60 点时间序列摘要（KiB）

| 字段 | 来源 | n | median | min | max | 首点 | 末点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VmRSS | status | 60 | **14,228** | 14,204 | 14,252 | 14,252 | 14,204 |
| RssAnon | status | 60 | **4,904** | 4,880 | 4,928 | 4,928 | 4,880 |
| RssFile | status | 60 | **9,324** | 9,324 | 9,324 | 9,324 | 9,324 |
| Threads | status | 60 | 13 | 13 | 13 | 13 | 13 |

分布：VmRSS 14,204 KiB ×21 点 / 14,228 ×29 点 / 14,252 ×10 点；RssAnon 4,880/4,904/4,928 与 VmRSS 三档严格同步（差 = RssFile 恒定 9,324）；RssFile 全程零波动。采样跨度 14:50:54Z–14:51:54Z（60s）。median 按 n=60 的第 30/31 位均值（与 M1 基线同口径）。

## 4. smaps 逐 VMA 构成表（采样末点，VmRSS=14,204 KiB）

分类器：先按 header 第 6 字段起的**完整路径串**（`[anon: Go: heap]` 含空格，不能只取 $6）+ 权限归类；主二进制 = 本实例 `kored` 绝对路径。逐 VMA `Rss=Private_Clean+Private_Dirty+Shared_Clean+Shared_Dirty` 全部对账。

| 构成类（映射名 + 权限） | Rss KiB | 占比(vs 14,204) | Pss KiB | VMA 数 | 口径归属 |
| --- | ---: | ---: | ---: | ---: | --- |
| 主二进制 `r-xp` 文本页（`.text` 4,890 KiB） | **4,576** | **32.22%** | 4,576 | 1 | RssFile（Private_Clean 4,576） |
| 主二进制 `r--p` 只读数据页（embed dist + `.rodata`/`.gopclntab` 等） | **4,468** | **31.46%** | 4,468 | 1 | RssFile（Private_Clean 4,468） |
| 主二进制 `rw-p`（`.noptrdata`/`.data`/`.bss` 文件映射部分） | 324 | 2.28% | 324 | 1 | 244 clean→RssFile / 80 dirty→RssAnon |
| `.so` 映射（text/rodata/rw） | 0 | 0% | 0 | 0 | 静态二进制（CGO=0），无动态库映射 |
| 其它文件映射（state.db 的 `r--s` 28 KiB） | 28 | 0.20% | 28 | 1 | RssFile |
| `[anon: Go: heap]` + 裸 anon 尾部 | 2,932 | 20.64% | 2,932 | 4 | RssAnon |
| 其它 `[anon: Go: *]`（GC span queue / immortal metadata / gc bits / getrandom states 等） | 1,744 | 12.28% | 1,744 | 34 | RssAnon |
| 无路径裸 anon（`010b6000-030f9000`，Go arena 预留的实际驻留段） | 100 | 0.70% | 100 | 1 | RssAnon |
| `[stack]`（主线程栈） | 24 | 0.17% | 24 | 1 | RssAnon |
| `[vdso]`/`[vvar]`/`[vsyscall]` | 8 | 0.06% | 0 | 4 | RssFile（Shared_Clean 8，PSS=0，进程间共享不占实内存） |
| **合计** | **14,204** | **100%** | **14,196** | 48 | — |

**口径对账（关键）**：按 clean/dirty 汇总，`Private_Clean 9,316 + Shared_Clean 8 = 9,324` = status `RssFile`；`Private_Dirty 4,880 + Shared_Dirty 0 = 4,880` = status `RssAnon`；两者之和 14,204 = status `VmRSS` = smaps_rollup `Rss`（14,204）。PSS 14,196（`smaps_rollup` 同为 14,196），与 RSS 差 8 KiB 全来自共享的 `[vdso]`（PSS 摊薄为 0）。

### status vs smaps 口径差的处理

早期按"文件映射=VmFile"粗分得到 file 9,396 / anon 4,808，与 status 的 9,324/4,880 差 72/72 KiB；根因是主二进制 `rw-p` VMA 含 80 KiB dirty（Go 运行时写过的 `.data`/`.bss` 页）被算进文件映射，但内核在 status 里把它记入 RssAnon。**本报告一律采用 status 口径**（clean→RssFile、dirty→RssAnon），保证与历史基线可直接对比。

## 5. 与 11-23 旧基线对比（v1-budget-measure.md:81）

| 指标 | 11-23 基线（主实例） | 本次实测（隔离实例，median / 末点） | 差（本次 median − 基线） |
| --- | ---: | ---: | ---: |
| VmRSS | 13,496 | 14,228 / 14,204 | **+732 / +708 KiB**（+5.4%） |
| RssAnon | 4,932（范围 4,932–4,988） | 4,904 / 4,880 | −28 / −52 KiB（基本持平） |
| RssFile | 8,564 | 9,324 / 9,324 | **+760 KiB**（+8.9%） |
| Threads | 16 | 13 | −3 |

结论先行：**两次都是同一量级（13.5→14.2 MiB），增量全部落在 RssFile（+760 KiB），RssAnon 持平**。RssFile 增长与"当前二进制更大 + 前端 embed 2.9 MiB（11-23 后多轮 R21–R23 视图增量）"一致：当前 `.text` 4,890 KiB + `.rodata` 4,156 KiB + `.gopclntab` 3,556 KiB，二进制 13.3 MB（11-23 记录 10.48 MB，**+2.8 MB**，恰与 embed dist 规模同量级）。这是设计层"embed 单二进制"的代价，不是参数问题。

### RssFile 大头是谁：文本页 vs 只读数据页

- 文本页（`r-xp` 主二进制）4,576 KiB = RssFile 的 **49.1%**
- 只读数据页（`r--p` 主二进制，含 `embed.FS` 的 `web/dist/*` + `.rodata` + `.gopclntab`/`.typelink` 等）4,468 KiB = RssFile 的 **47.9%**
- 其余 280 KiB（`rw-p` clean 244 + state.db 28 + vdso 8）= 3.0%

**答案：两者几乎各占一半，文本页略多（49.1% vs 47.9%），只读数据页不是大头但体量相当**。注意 `r--p` VMA 的 4,468 KiB 是"当前真正驻留"的页，不等于 `.rodata` 全量 4,156 KiB + `.gopclntab` 3,556 KiB（合计 7,712 KiB）——后者部分页未触发驻留；embed dist 全量 2.88 MB 也在这一 VMA 内，按需分页驻留。

### RssAnon 构成

Go heap 2,932 KiB（60.1%）+ Go 元数据/GC 结构 1,744 KiB（35.7%）+ 主二进制 `rw-p` dirty 80 KiB（§4 注，status 口径记入 RssAnon）+ 裸 anon 100 KiB + 主线程栈 24 KiB = 4,880 KiB。对照旧基线 4,932–4,988 KiB 无拆分数据，本次首次给出实测拆分：**约 96% 的 RssAnon 是 Go 运行时管理区（heap + metadata），程序自身可控的栈仅 24 KiB**。

## 6. 结论：8 MiB 目标是否可达、压缩面在哪

1. **差距定量**：当前 VmRSS median 14,228 KiB，距目标 8,192 KiB 差 **6,036 KiB（超 73.7%）**；距硬红线 16,384 KiB 尚有 2,156 KiB 余量（G-03 判 WARN 不判未完成）。
2. **8 MiB 目标当前不可达，且不是调参能解决的**：
   - 光是两个主二进制文件映射 VMA（文本 4,576 + 只读 4,468 = **9,044 KiB**）就已超 8 MiB 目标 852 KiB。即使把全部 embed 数据页和 Go 元数据全部赶出内存、堆压到零，剩文本页 4,576 KiB 也只占目标 56%，但**文本页+只读页合计 9,044 KiB 已无法塞进 8 MiB**——这是静态单二进制下 `.text + .rodata` 的驻留下限（当前代码规模）。
   - 设计层可压缩面（按贡献排序，均为**设计/架构层**，G-22：调参禁止）：
     - a) `.gopclntab` 符号/行号表 3,556 KiB（在 `r--p` VMA 内，可用构建 flags 削减，但需 ADR + 权衡可调试性；不属于"单纯调 GOGC"）；当前 `-ldflags "-s -w"` 去掉 DWARF 但未去 `.gopclntab`（Go 运行栈回溯依赖它）。
     - b) embed 前端 2.88 MB（66 个 JS/CSS 文件全进二进制，懒加载只影响执行不影响 embed 驻留）：若改为外置静态目录（FD/包管理携带）可降 `r--p` 驻留，但**破坏"单二进制跑遍各平台"的 Tier A 承诺**（设计层取舍，需用户裁决）。
     - c) Go 运行时常驻区（heap 2,932 + meta 1,744 = 4,676 KiB，占 32.9%）：`GOMEMLIMIT=6MiB`/`GOGC=50` 已在默认档，进一步压缩只能减小 Go 运行时自身开销或换运行时，属于架构层改动，不是 GOGC 微调。
     - d) 文本页 4,576 KiB：只有"少编译代码进主壳"（把更多能力移出内核到插件进程，符合薄壳设计 G-01）才能降，是设计层而非参数层。
3. **诚实边界**：本次是**空载**隔离实例（UDS-only、无插件、无请求），已稳定 20s；RssFile 全程恒定说明文本/只读页已全驻留。历史 11-23 是主实例（可能承载 8787 的真实请求），两者状态不完全等价，但量级与拆分足以判定趋势；未做 pprof（代码零端点，task-147 结论），未读 `/gc/gogc:percent`（GC 是否真正生效未独立复核，按启动日志默认档记录）；`METRICS_HTTP=401` 是 `/api/v1/system/metrics` 未鉴权访问，未做 RSSKiB 交叉核对（需登录 token，超出本卡"不碰主实例/不联网"范围）。

## 7. 副产物清理与 G-29 声明

- 一次性目录 `.tmp-rss-quant-20261126/`（含脚本 `sample.sh`/`parse_smaps.py`/`reconcile.py`、原始数据 `status.tsv`/`smaps.txt`/`rollup.txt`/`status_snapshot.txt`/`launch.log`/`kored` 副本、配置/state/run/log）已按用户硬偏好在报告落盘后**全部删除**；`.git/info/exclude` 中的 `/.tmp-rss-quant-*/` 行保留（不影响工作区文件，仅为以后可能的同名目录防止误提交；如要求恢复 exclude 原状可再移除该行）。
- **本轮未改动主实例运行态**：`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 原样；8787 healthz 采样前后均 HTTP 200；隔离实例走独立 UDS，无 TCP 端口，未占用 8787。
