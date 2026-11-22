> 状态: draft · 归属: red-team · 更新: 2026-11-22 · 里程碑: M5
> 方法: 假设 M5 收口评审被判失败，从死因倒推；只收能被一条命令戳穿的死法。

# 0006 · M5 Ecosystem 事前验尸（pre-mortem）

判定基线：[提案 0006](../proposals/0005-m5-ecosystem.md) §2 两阶段 / §3 风险表 R1–R5 / §4 验收出口 / §5 tag 判定，[M4 验尸](0005-m4-premortem.md) §4 复验口径，[ROADMAP](../../docs/ROADMAP.md):14/15（v1.0 gate 五项定义 + 里程碑发布点），[V1-GOALS](../../docs/V1-GOALS.md):77-89（九类取证），[PARITY-GAP](../../docs/PARITY-GAP.md):107-111（达标计数）。提案 R1–R5 风险文本已写全，本文只挑「风险写了、能挡假绿的命令没落到 §4 出口」与「测法和口径相矛盾」的死因；命中任一条即 M5 不成立。

## 1. 五条失败场景

### S-01 R2 重签串行：公钥漏同步致合法包全拒（提案 R2 已点名）
- 场景：§2.2 判据 `idx=$(grep -oE '[0-9a-fA-F]{40,}' scripts/validate-index.sh | head -1); grep -qF "$idx" internal/core/market/verify.go` 只核「内核含索引公钥子串」。若轮换时双端都残留旧公钥、`head -1` 恰取到旧值，或公钥写在多行常量里，判据为真但新公钥根本没生效——交叉验签测试用同套密钥自签自验照样过，合法包全链拒签装不上（供应链假绿）。
- 触发：轮换只改 verify.go 不改 validate-index.sh；新公钥追加在旧串后；`TestIndexVerifyCrossCheck` 只测篡改拒 + 合法过，不测跨端公钥一致性；撤旧公钥无双验窗口记录。
- 影响：M5-B 静态市场页签发的包全被 kore 拒装，G-10 零信任承诺反向破防——用户装不上合法包比篡改包装上更难排查。
- 早期信号：三签提交有 sha 但公钥串未变；索引 `.sig` 验签失败；合法包拒装率上升而 `grep -qF` 仍为真。
- 提前发现（一条判据）：
```bash
a=$(grep -oE '[0-9a-fA-F]{40,}' scripts/validate-index.sh | sort -u | wc -l); b=$(grep -oE '[0-9a-fA-F]{40,}' internal/core/market/verify.go | sort -u | wc -l); c=$(comm -12 <(grep -oE '[0-9a-fA-F]{40,}' scripts/validate-index.sh | sort -u) <(grep -oE '[0-9a-fA-F]{40,}' internal/core/market/verify.go | sort -u) | wc -l); test "$a" -eq 1 && test "$b" -eq 1 && test "$c" -eq 1 && grep -qr 'TestIndexVerifyCrossCheck' internal/core/market/ && echo OK || echo KEY-MISMATCH
```
输出 `KEY-MISMATCH` 即命中（双端公钥非唯一/交集不唯一/无交叉验签测试）——比提案的单边 `grep -qF` 多挡「双端都残留旧串」这一类假绿。

### S-02 R1 19 仓并行写域 / 磁盘 IO 打爆（提案 R1 已点名）
- 场景：§4.1 只数「21 仓可装可卸」，没有写域不相交与确定性 sha 复建的命令级 gate。19 仓同批 4 并行若 `write_scopes` 重叠会互相覆盖；集中 `make dist` 的 IO 争抢致 tar.gz 内 mtime/序号漂移、sha 不复现——索引收录旧 sha，干净 clone 时装出与发布物不一致的包。提案 R1 缓解写了 `--sort=name --mtime=@0`，但 §4 出口没有复建一致性检查。
- 触发：两仓共写 `presets/*.json` 或索引；`GOWORK=off` 未生效致 go.sum 被并行改写；dist 两次构建 sha 不同仍收录；`git status` 出现他人未提交改动。
- 影响：G-08 写域红线与 G-15 变更集登记同时破防，裁决 43 的 sha 可追溯链断——21 仓「可装可卸」在干净环境复现不出来。
- 早期信号：`git status --short` 出现非本 agent 的未提交改动；同一 dist 两次 sha256 不等；BOARD scope 列有重叠行。
- 提前发现（一条判据）：
```bash
d=$(mktemp -d); cp -a . "$d/src" 2>/dev/null; f=$(find . -name '*.tar.gz' -path '*dist*' | head -1); [ -z "$f" ] && { echo NO-DIST; exit 0; }; s1=$(sha256sum "$f" | cut -d' ' -f1); (cd "$d/src" && GOWORK=off make dist >/dev/null 2>&1); s2=$(sha256sum "$d/src/${f#./}" 2>/dev/null | cut -d' ' -f1); rm -rf "$d"; test "$s1" = "$s2" && echo OK || echo SHA-DRIFT
```
输出 `SHA-DRIFT` 即命中（同源码两次出包 sha 不一致，确定性打包未落地）——在「有 dist 产物」的批上才校验，无产物记 `NO-DIST` 不算绿。

### S-03 R3 size_bytes 代理偏差误导商店磁盘预检（提案 R3 已点名）
- 场景：R3 只写「偏差 >10% 记 WARN 并按实测值参与 G-18」，§4 出口无回写命令 gate。若 `info.json.size_bytes` 沿用代理值不回写，商店磁盘预检与 G-18 预设合计仍按代理算——包实际 40 MiB 而字段写 12 MiB，用户磁盘不足时预检放行、安装中途失败；或预设合计看似 ≤24 MiB 实则超限。
- 触发：出包脚本不回写 size_bytes；代理值偏差 >10% 只 WARN 不阻断；G-18 读代理值而非实测值。
- 影响：商店磁盘预检失真 + 预设资源合计假达标，把 R3 的 WARN 升级成用户可见的安装事故；与 ROADMAP:14 v1.0 gate 的「资源达标」取证直接冲突。
- 早期信号：`stat -c%s dist/*.tar.gz` 与 `info.json.size_bytes` 偏差 >10%；预设合计 RSS 在代理口径下达标、实测口径下越线。
- 提前发现（一条判据）：
```bash
bad=0; while IFS= read -r j; do d=$(dirname "$j"); p=$(grep -oE '"size_bytes"[[:space:]]*:[[:space:]]*[0-9]+' "$j" | grep -oE '[0-9]+'); a=$(find "$d" -name '*.tar.gz' -path '*dist*' -printf '%s\n' 2>/dev/null | sort -n | tail -1); [ -z "$p" ] || [ -z "$a" ] && continue; [ $(( (a>p ? a-p : p-a) * 100 / p )) -gt 10 ] && { echo "DRIFT $j declared=$p actual=$a"; bad=1; }; done < <(find . -name info.json -not -path '*/node_modules/*'); test "$bad" -eq 0 && echo OK || echo SIZE-PROXY-DRIFT
```
输出 `SIZE-PROXY-DRIFT` 即命中（任一仓 size_bytes 与实测包体积偏差 >10% 未回写）——把 R3 的口头 WARN 变成可复跑的出口 gate。

### S-04 R4 生产级 12 仓四类故障注入敷衍（fake PASS）
- 场景：§4.3 只写「每仓四类故障注入用例 + CI 12/12 绿」，没有逐仓逐类计数与实跑 gate。12 仓若只跑 `kill -9` 一类、另三类写成空测试或 TODO，`grep -c` 用例数可凑、CI 仍绿——G-20 形式通过实质漏测，正是用户点名的 fake PASS。
- 触发：某仓 `tests/fault/` 少于 4 例；CI 只跑 1 类；基础级被标生产级；空测试函数占位（无断言无故障动作）。
- 影响：v1.0 gate 第二项「12 生产级全部通过故障注入」与 V1-GOALS 质量类 12/12 绿同时假绿，磁盘满/cgroup 超限两类真实故障下插件行为未经验证。
- 早期信号：`tests/fault/` 文件数 <4；CI 日志只出现 kill 类；用例函数体为空或仅 `t.Skip`。
- 提前发现（一条判据）：
```bash
bad=0; for d in $(find . -name info.json -exec grep -l '"depth_level"[[:space:]]*:[[:space:]]*"production"' {} \; | xargs -r -n1 dirname); do n=$(find "$d/tests/fault" -type f -name '*_test.go' 2>/dev/null | wc -l); k=$(grep -rlE 'kill|Kill' "$d/tests/fault" 2>/dev/null | wc -l); t=$(grep -rlE 'timeout|Timeout' "$d/tests/fault" 2>/dev/null | wc -l); f=$(grep -rlE 'disk|Disk|ENOSPC' "$d/tests/fault" 2>/dev/null | wc -l); c=$(grep -rlE 'cgroup|Cgroup|memory\.max' "$d/tests/fault" 2>/dev/null | wc -l); { [ "$n" -ge 4 ] && [ "$k" -ge 1 ] && [ "$t" -ge 1 ] && [ "$f" -ge 1 ] && [ "$c" -ge 1 ]; } || { echo "FAULT-GAP $d kill=$k timeout=$t disk=$f cgroup=$c"; bad=1; }; done; test "$bad" -eq 0 && echo OK || echo FAKE-PASS
```
输出 `FAKE-PASS` 即命中（任一生产级仓四类用例缺类）——命令核的是四类关键词各自落文件，不是「CI 绿」这种可被空测试骗过的信号。

### S-05 预设填满后资源合计超 ≤3 常驻 / ≤24 MiB（G-18 目标口径）
- 场景：§4.2 把 8 预设挂 G-18「合计资源不超预算」，但 G-18 红线是 ≤48 MiB、目标 ≤24 MiB（AGENTS G-03），ROADMAP:14 v1.0 gate 却把「合计 ≤24 MiB」写成硬条件，三处口径不一。若按红线 48 MiB 放行填满预设，G-18 绿而 v1.0 gate 的 24 MiB 取证失败；且无「常驻数 ≤3」命令 gate，8 预设叠加可拉起 >3 常驻插件。
- 触发：预设把多个 `resident` 插件组合安装；G-18 按 48 MiB 红线判绿；size_bytes 代理偏差（S-03）进一步低估合计；常驻/懒加载分配表未随预设更新。
- 影响：v1.0 gate 第五项资源达标不成立，主壳被自己装的预设拖成负担——违背「它是管理者，不能变成负担」的架构底线。
- 早期信号：`make presets-check` 用红线口径放行；预设合计 RSS 在 24–48 MiB 灰区；`ps` 见 `kore-plugin-*` 进程 >3。
- 提前发现（一条判据）：
```bash
bad=0; for p in $(find . -name '*.json' -path '*presets*'); do r=$(grep -oE '"(rss|rss_kib|size_bytes)"[[:space:]]*:[[:space:]]*[0-9]+' "$p" | grep -oE '[0-9]+' | awk '{s+=$1} END{print s+0}'); res=$(grep -o '"resident"' "$p" | wc -l); { [ "$r" -le 24576 ] && [ "$res" -le 3 ]; } || { echo "OVER-BUDGET $p rss_kib=$r resident=$res"; bad=1; }; done; test "$bad" -eq 0 && echo OK || echo PRESET-OVER-BUDGET
```
输出 `PRESET-OVER-BUDGET` 即命中（任一预设按 ≤24 MiB / ≤3 常驻目标口径越线）——直接钉死 v1.0 gate 的目标值，不用 G-18 红线的宽松口径糊过去。

## 2. 对提案的三条可执行修改建议

1. **把 R2/R3 的口头 WARN 升为出口命令 gate**（对应 S-01/S-03）：§4 新增「双端公钥唯一且交集唯一 + `TestIndexVerifyCrossCheck`」与「逐仓 size_bytes 与实测包体积偏差 ≤10%」两条判据（用上文 S-01/S-03 命令），不以「grep -qF 为真」「记 WARN」当充分证据。
2. **给 §4.1/§4.3 补确定性出包与四类故障计数 gate**（对应 S-02/S-04）：21 仓「可装可卸」之前先过 `SHA-DRIFT` 复建一致性检查；12 生产级不得只以「CI 12/12 绿」计，须逐仓逐类核 kill/timeout/disk/cgroup 四文件齐全并实跑输出，缺类即降级（G-20）。
3. **统一资源口径并以目标值钉死预设**（对应 S-05）：§4.2 明确「G-18 红线 48 MiB 不用于 v1.0 gate 取证，预设合计按 ≤24 MiB 目标 + 常驻 ≤3 判」，把 `PRESET-OVER-BUDGET` 列为 M5-A 出口 gate；同时在 ADR 中记录红线/目标/gate 三口径差异，避免 G-03 与 ROADMAP:14 继续漂移。

## 3. 特别核查：v1.0.0 tag 建议与 ROADMAP gate 定义冲突判定

**冲突事实**：ROADMAP:12 写「M4 完成即打 v1.0.0」，:14 定义 v1.0 gate 为**五项具体条件**（21 仓库可装可卸 / 12 生产级过故障注入 / Linux 全矩阵 smoke / 三处文案一致 / 资源达标）并写「全部满足才打 v1.0.0」，:15 钉死「M4 → v1.0.0、M5 → v1.1.0、每个发布物只从对应 tag 构建」。提案 §5 的「不补打 v1.0.0、M5 打 v1.1.0」**与 :12/:15 直接冲突**。但提案的论证用了 V1-GOALS:77-89 的**九类取证**口径，而 ROADMAP:14 的 gate 是**五项**——两份文档对同一 gate 给了不同定义，提案没有先消这个歧义就拿九类当理由。

**明确判断**：方向上「不补打 v1.0.0」是对的，但按提案现在的论证执行会造成版本叙事断裂，属 REVISE 级缺口：
1. 若照字面执行「不补打」，则 ROADMAP:14 的五项 gate 条件在 M5 才实质达成（21 仓齐、12 生产级过 fault、资源达标），历史上却没有任何 `v1.0.0` tag 对应这些取证——出现「功能覆盖达标却无 v1.0 tag」的断点，且 :15「发布物只从对应 tag 构建」被破坏。
2. 更关键：本次 `git tag -l` 实测仓库现有 tag 仅 `pkg/pluginapi/v0.1.0`、`pkg/pluginapi/v0.1.1`（嵌套 module），**根本不存在 `v1.0.0`**——提案说「冻结已发 v1.0.0 tag 语义」是无的放矢，所谓「回打制造两个 v1.0.0」的担忧在当前仓库状态不成立。
3. 自洽路径只有两条，必须选一落 ADR：①维持 ROADMAP 版本策略，宣布 v1.0 gate 的五项条件**判定点从 M4 移到 M5-A**（走 ROADMAP §11 变更规则 + ADR），届时按 :15 在 M5-A 收口打 `v1.1.0` 仍矛盾——故更干净的是 ②把里程碑发布点改为「M5-A → v1.0.0、M5-B → v1.1.0」，并同步 ROADMAP:15 与每仓库 tag 台账。无论选哪条，**不能**既保留「v1.0 gate 在 M4」的文字、又不补打且不改 ROADMAP——那是叙事断裂本身。

**结论**：tag 建议「不补打 v1.0.0」与 ROADMAP:12/:15 字面冲突、与 :14 五项 gate 的达成时点矛盾；提案用九类取证重定义 gate 未先消歧。需按上面路径 ② 或 ① 出 ADR 并同步 ROADMAP §1/§15 后才能自洽，否则不予采纳。

## 4. VERDICT

**REVISE.** 提案 R1–R5 风险文本写全，但 §4 验收出口存在五类「风险写了、能挡假绿的命令没落」或「口径相矛盾」的错配：S-01 单边 `grep -qF` 挡不住双端残留旧公钥；S-02 无确定性 sha 复建 gate；S-03 size_bytes 偏差只 WARN 不阻断；S-04 「CI 12/12 绿」可被只跑一类故障的 fake PASS 骗过；S-05 G-18 红线 48 MiB 与 v1.0 gate 24 MiB 口径冲突且无常驻数 gate。§5 tag 建议另需 ADR 消歧才能自洽。三条建议落地后可由 verifier 复跑上文五条判据复审。

## 5. 复验（2026-11-22，提案 0005 修订后 138 行）

只核本文 §1 五条判据 + tag 判断（本文 §3 / 提案 §5）是否落实，不新增判据、不改提案。证据文件 `.agents/proposals/0005-m5-ecosystem.md`（下称 `0005`）。

- **S-01 双端公钥唯一+交集唯一+KEY-MISMATCH：PASS** — `0005:104` 命令与本文 `:17` 逐字相同；`0005:102` 明示替代单边 `grep -qF`。
- **S-02 SHA-DRIFT（NO-DIST 不算绿）：PASS** — `0005:109` 与本文 `:28` 逐字相同；`0005:107` 明示"无产物记 NO-DIST 不算绿"。
- **S-03 SIZE-PROXY-DRIFT >10% 阻断：PASS** — `0005:114` 与本文 `:39` 逐字相同；`0005:112` 明示"偏差 >10% 即阻断，不降级为 WARN"。
- **S-04 FAKE-PASS 四类逐仓核：PASS** — `0005:119` 与本文 `:50` 逐字相同；`0005:117` 明示"空测试/ t.Skip 不算数"。
- **S-05 PRESET-OVER-BUDGET 口径消歧：PASS** — `0005:124` 与本文 `:61` 逐字相同；`0005:122` 明示"48 红线 vs 24 目标，gate 按 ≤24 MiB/≤3 常驻判"。
- **tag 判断：PASS** — `0005:129` 纠正"已发 v1.0.0"错误前提（实测仅 `pkg/pluginapi/v0.1.0`/`v0.1.1`）；`0005:131,136` 改 M5-A→`v1.0.0`、M5-B→`v1.1.0`；`0005:127,138` 标"需 lead/用户裁决"且"未裁决前不打 tag"。

**VERDICT: APPROVE** — 六项全 PASS：五条命令级 gate 逐字落入 `0005` §4.8、风险段与出口双落地；tag 判断纠正错误前提并按路径②落 ADR 待裁决。原 REVISE 阻塞项闭环。
