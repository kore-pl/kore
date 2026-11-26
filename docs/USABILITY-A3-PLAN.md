> 状态: draft · 归属: a3-planner · 更新: 2026-11-26 · 里程碑: R12（G-33 A3 文案清理方案；doc-first，仅方案，未落地）

# USABILITY-A3-PLAN — A3（invalid 文案）55 条清理方案

## 0. 本文档的性质与硬边界

- **doc-first**：本文只产出方案供用户审阅，**不改任何生产代码 / 不 bump / 不 make dist / 不 push / 不联网 / 不执行主流程 CLI**。
- 判据真源：`scripts/usability-check.sh` A3 段 + `.agents/QUALITY-GATES.md` G-33；白话原则真源：`docs/USABILITY.md` §4「小白能看懂」；发版真源：`docs/RELEASE.md` §0–§2。
- 工作目录：`kore` 为 git 根，插件仓为兄弟目录 `../kore-plugin-*/`（24 仓）。
- 本文不碰 `.kore-local-*`、不碰他人 dirty 文件；只提交本文件一个路径。

## 1. 基线与证据（全量，不靠抽样）

只读命令（未改任何文件，`--no-run-tests` 仅跳过 A1 真跑）：

```text
cd /home/pt/Work/GolandProjects/kore-pl/kore
bash scripts/usability-check.sh --no-run-tests
退出码: 1
末行: usability-check: 0 pass, 502 warn, 55 fail, 183 unverified（24 插件 / 10 一级菜单 / 5 视图）
FAIL 规则分布: 55 条全部为 A3，其余规则 0 FAIL。
```

- A3 全量命中 529 条：474 条在 `scripts/usability-pending.txt` 登记内（WARN），**55 条超出登记上限（FAIL）**——即本次清理目标。
- 55 条的 `repo / file:line` 由同一判据脚本逻辑（`INVALID_LIT = invalid\(\s*"..."`、字数 `len(re.sub(r"\\.", "", msg)) < 8` 或缺 `请/应/需/例/如`）逐文件重跑得到，并与脚本 FAIL 输出做集合比对：**脚本 55 条 == 映射 55 条，差集为空**。原始输出存 `.tmp/a3-usability-raw.txt`（gitignored），逐行明细存 `.tmp/a3-detailed.txt`（gitignored）。
- 分布：`db-postgres` 28 / `runtime-python` 8 / `runtime-node` 8 / `runtime-php` 8 / `app-deploy` 1 / `firewall` 1 / `waf` 1，合计 55。
- 违反原因统计：53 条「缺引导词」；2 条「字数不足 8 且缺引导词」（第 8、25 行）。

## 2. 55 条逐条清单与改前→改后文案

改写判据自检：每条改后首段字符串均 **≥8 字且含「请 / 应 / 需 / 例 / 如」**；已用与门禁同款正则逐条验算，55/55 通过；无「实例 / 生命周期 / capability / revision」四词。所有文案只换 `invalid("...")` 的**字面量**，保留 `"..." + err.Error()` / `+ name` 等动态尾段与全部控制流。

| # | repo / file:line（证据） | 改前 invalid() 文案（当前违规） | 违反原因 | 改后文案（建议） |
|---|---|---|---|---|
| 1 | `app-deploy` · `internal/apop/validate.go:163` | `缺少必填 env:` | 缺引导词 | `请填写必填的环境变量 env:` |
| 2 | `db-postgres` · `internal/pgop/call.go:84` | `缺少必填参数 instance` | 缺引导词 | `请填写必填参数 instance（要操作的数据库连接名称）` |
| 3 | `db-postgres` · `internal/pgop/call.go:191` | `缺少必填参数对象` | 缺引导词 | `请传入参数对象 params（不能为空或 null）` |
| 4 | `db-postgres` · `internal/pgop/call.go:194` | `params 必须是 JSON 对象` | 缺引导词 | `params 需要是 JSON 对象，请传 {...} 格式` |
| 5 | `db-postgres` · `internal/pgop/call.go:197` | `params 解析失败:` | 缺引导词 | `params 解析失败，请检查 JSON 格式:` |
| 6 | `db-postgres` · `internal/pgop/identifiers.go:123` | `缺少必填参数 privileges（可选值:` | 缺引导词 | `请填写必填参数 privileges（权限，可选值:` |
| 7 | `db-postgres` · `internal/pgop/identifiers.go:126` | `privileges 条数超过上限 8` | 缺引导词 | `权限 privileges 最多填 8 项，请减少后再试` |
| 8 | `db-postgres` · `internal/pgop/identifiers.go:134` | `权限` | <8字(=3)+缺引导词 | `请检查填写的权限` |
| 9 | `db-postgres` · `internal/pgop/query.go:25` | `缺少必填参数 sql` | 缺引导词 | `请填写必填参数 sql（要查询的 SQL 语句）` |
| 10 | `db-postgres` · `internal/pgop/query.go:35` | `limit 超出 [0, 1000] 范围` | 缺引导词 | `limit 超出 0 到 1000 的范围，请改成范围内的值` |
| 11 | `db-postgres` · `internal/pgop/sqlguard.go:73` | `sql 不得为空` | 缺引导词 | `请填写要查询的 SQL 语句，不能为空` |
| 12 | `db-postgres` · `internal/pgop/sqlguard.go:76` | `sql 超过 64 KiB 上限` | 缺引导词 | `SQL 语句超过 64 KiB，请缩短后再试` |
| 13 | `db-postgres` · `internal/pgop/sqlguard.go:79` | `sql 含 NUL 字节` | 缺引导词 | `SQL 语句含 NUL 空字符，请去掉后重试` |
| 14 | `db-postgres` · `internal/pgop/sqlguard.go:83` | `sql 非法:` | 缺引导词 | `SQL 语句格式有误，请检查:` |
| 15 | `db-postgres` · `internal/pgop/sqlguard.go:87` | `sql 不得为空` | 缺引导词 | `请填写要查询的 SQL 语句，不能为空` |
| 16 | `db-postgres` · `internal/pgop/sqlguard.go:94` | `只允许单条只读语句，禁止多条语句（分号只能出现在末尾）` | 缺引导词 | `请一次只提交一条只读语句，分号只能放在末尾` |
| 17 | `db-postgres` · `internal/pgop/sqlguard.go:98` | `只读白名单拒绝: 语句必须以 SELECT/SHOW/EXPLAIN/WITH 开头` | 缺引导词 | `只读查询请求：语句请以 SELECT/SHOW/EXPLAIN/WITH 开头` |
| 18 | `db-postgres` · `internal/pgop/sqlguard.go:105` | `只读白名单拒绝: EXPLAIN 只允许分析 SELECT/WITH/VALUES/TABLE（EXPLAIN ANALYZE 会真的执行内层语句）` | 缺引导词 | `只读查询请求：EXPLAIN 请只用于分析 SELECT/WITH/VALUES/TABLE（用 ANALYZE 会真的执行里面的语句）` |
| 19 | `db-postgres` · `internal/pgop/sqlguard.go:114` | `只读白名单拒绝: WITH 子句含数据修改语句` | 缺引导词 | `只读查询请求：WITH 子句里请勿写修改数据的语句` |
| 20 | `db-postgres` · `internal/pgop/sqlguard.go:119` | `只读白名单拒绝: 禁止 SELECT ... INTO（会建表）` | 缺引导词 | `只读查询请求：不允许 SELECT ... INTO（会建表），请去掉 INTO` |
| 21 | `db-postgres` · `internal/pgop/sqlguard.go:123` | `只读白名单拒绝: 禁止加锁读 FOR UPDATE / FOR SHARE` | 缺引导词 | `只读查询请求：不允许 FOR UPDATE / FOR SHARE 加锁读，请去掉加锁子句` |
| 22 | `db-postgres` · `internal/pgop/sqlguard.go:128` | `只读白名单拒绝: 禁止副作用/阻塞函数` | 缺引导词 | `只读查询请求：请去掉有副作用或会阻塞的函数` |
| 23 | `db-postgres` · `methods.go:102` | `values 必须是 JSON 对象` | 缺引导词 | `values 需要是 JSON 对象，请传 {...} 格式` |
| 24 | `db-postgres` · `methods.go:109` | `端口必须在 1-65535 之间，不能填 0` | 缺引导词 | `端口请填 1 到 65535 之间的数字，不能填 0` |
| 25 | `db-postgres` · `methods.go:113` | `配置值非法:` | <8字(=7)+缺引导词 | `配置值无效，请检查后重试:` |
| 26 | `db-postgres` · `methods.go:120` | `PostgreSQL 设置非法:` | 缺引导词 | `PostgreSQL 设置无效，请按提示修改:` |
| 27 | `db-postgres` · `methods.go:164` | `缺少必填参数对象` | 缺引导词 | `请传入参数对象 params（不能为空或 null）` |
| 28 | `db-postgres` · `methods.go:167` | `params 必须是 JSON 对象` | 缺引导词 | `params 需要是 JSON 对象，请传 {...} 格式` |
| 29 | `db-postgres` · `methods.go:170` | `params 解析失败:` | 缺引导词 | `params 解析失败，请检查 JSON 格式:` |
| 30 | `firewall` · `internal/fwop/validate.go:32` | `proto 必须是 tcp/udp（缺省 tcp）` | 缺引导词 | `协议 proto 请填 tcp 或 udp，不填默认 tcp` |
| 31 | `runtime-node` · `internal/nodeop/path.go:45` | `root 含 NUL 字节` | 缺引导词 | `目录 root 含 NUL 空字符，请去掉后重试` |
| 32 | `runtime-node` · `internal/nodeop/path.go:48` | `root 含反斜杠` | 缺引导词 | `目录 root 含反斜杠，请改用正斜杠 / 的路径` |
| 33 | `runtime-node` · `internal/nodeop/path.go:51` | `root 必须是绝对路径` | 缺引导词 | `目录 root 请填绝对路径（以 / 开头）` |
| 34 | `runtime-node` · `internal/nodeop/path.go:55` | `root 含 .. 段，禁止穿越` | 缺引导词 | `目录 root 含 .. 段，请改用允许目录内的路径` |
| 35 | `runtime-node` · `internal/nodeop/path.go:76` | `root 经符号链接解析后越出允许目录` | 缺引导词 | `目录 root 指向了允许范围之外的位置，请换一个目录` |
| 36 | `runtime-node` · `internal/nodeop/paths.go:14` | `runtime-node.paths 参数非法:` | 缺引导词 | `runtime-node.paths 参数有误，请检查后重试:` |
| 37 | `runtime-node` · `internal/nodeop/projects.go:23` | `runtime-node.projects 参数非法:` | 缺引导词 | `runtime-node.projects 参数有误，请检查后重试:` |
| 38 | `runtime-node` · `internal/nodeop/versions.go:15` | `runtime-node.versions 参数非法:` | 缺引导词 | `runtime-node.versions 参数有误，请检查后重试:` |
| 39 | `runtime-php` · `internal/phpop/path.go:45` | `root 含 NUL 字节` | 缺引导词 | `目录 root 含 NUL 空字符，请去掉后重试` |
| 40 | `runtime-php` · `internal/phpop/path.go:48` | `root 含反斜杠` | 缺引导词 | `目录 root 含反斜杠，请改用正斜杠 / 的路径` |
| 41 | `runtime-php` · `internal/phpop/path.go:51` | `root 必须是绝对路径` | 缺引导词 | `目录 root 请填绝对路径（以 / 开头）` |
| 42 | `runtime-php` · `internal/phpop/path.go:55` | `root 含 .. 段，禁止穿越` | 缺引导词 | `目录 root 含 .. 段，请改用允许目录内的路径` |
| 43 | `runtime-php` · `internal/phpop/path.go:76` | `root 经符号链接解析后越出允许目录` | 缺引导词 | `目录 root 指向了允许范围之外的位置，请换一个目录` |
| 44 | `runtime-php` · `internal/phpop/paths.go:14` | `runtime-php.paths 参数非法:` | 缺引导词 | `runtime-php.paths 参数有误，请检查后重试:` |
| 45 | `runtime-php` · `internal/phpop/projects.go:36` | `runtime-php.projects 参数非法:` | 缺引导词 | `runtime-php.projects 参数有误，请检查后重试:` |
| 46 | `runtime-php` · `internal/phpop/versions.go:15` | `runtime-php.versions 参数非法:` | 缺引导词 | `runtime-php.versions 参数有误，请检查后重试:` |
| 47 | `runtime-python` · `internal/pyop/venv.go:276` | `缺少必填字段 venv_path` | 缺引导词 | `请填写必填字段 venv_path（虚拟环境目录）` |
| 48 | `runtime-python` · `internal/pyop/venv.go:280` | `venv_path 必须是绝对路径` | 缺引导词 | `venv_path 请填绝对路径（以 / 开头）` |
| 49 | `runtime-python` · `internal/pyop/venv.go:290` | `venv_path 不存在或不可访问:` | 缺引导词 | `虚拟环境目录 venv_path 不存在或无法访问，请先创建:` |
| 50 | `runtime-python` · `internal/pyop/venv.go:294` | `venv_path 必须是已存在的目录` | 缺引导词 | `venv_path 需要是已存在的目录，请先创建再试` |
| 51 | `runtime-python` · `internal/pyop/venv.go:297` | `venv_path 不是可用的 venv（缺少 bin/pip）` | 缺引导词 | `venv_path 不是可用的虚拟环境（缺少 bin/pip），请重建环境` |
| 52 | `runtime-python` · `internal/pyop/venv.go:359` | `缺少必填字段 packages` | 缺引导词 | `请填写必填字段 packages（要安装的包列表）` |
| 53 | `runtime-python` · `internal/pyop/venv.go:367` | `包名非法（只允许 [A-Za-z0-9._-] 与可选 ==version；禁止空格/分号/选项）:` | 缺引导词 | `包名格式有误，请只用字母数字 . _ - 和可选的 ==版本号:` |
| 54 | `runtime-python` · `internal/pyop/versions.go:15` | `runtime-python.versions 参数非法:` | 缺引导词 | `runtime-python.versions 参数有误，请检查后重试:` |
| 55 | `waf` · `internal/wafop/validate.go:110` | `缺少必填参数对象` | 缺引导词 | `请传入参数对象 params（不能为空或 null）` |

### 2.1 参照的已合规文案风格

从现存通过 A3 的 `invalid()` 取风格（只学句式，不改这些行）：

- `kore-plugin-app-deploy/internal/apop/artifact.go:301` — `无法识别包格式：请显式传 format=zip|tar.gz`（现象 + 请 + 怎么办）
- `kore-plugin-db-mysql/internal/mysqlop/admin.go:64` — `存在多个实例，请用 instance 指定目标实例`（此处「实例」是存量词，本次**不照抄**，改说「数据库连接」）
- `kore-plugin-file/internal/fileop/attrs.go:71` — `mode 不能为空，请传八进制字符串，例如 "0755"`（给例子）
- `kore-plugin-container/internal/containerop/call.go:257` — `pull 会联网拉取镜像，需要二次确认：请传 confirm=true 后重试`（说明原因 + 动作）
- `kore-plugin-firewall/internal/fwop/call.go:331` — `id 必填：请传入要删除规则的编号`

本次统一句式：**「现象（白话）＋请/需要/应＋具体动作」**；字段名（`params` / `root` / `instance` / `sql`）保留以便用户对照表单，但补齐中文解释；`SQL` / `JSON` / `KiB` 属通用技术词，不在 USABILITY §4.1 的内部术语表内。

## 3. 分仓 bump 策略（本方案不执行）

依据 `docs/RELEASE.md` §0「同一 `id@version` 只允许一个 sha」+ §1「任何改变 dist sha 的改动必须 bump」：文案在 `.go` 里 → 进二进制 → 改 dist sha → **7 仓全部必须 patch bump**。当前版本取各仓 `info.json` / `manifest.json` / `index/plugins.json` / `versions.lock.json` 一致值。

### 3.1 每仓版本与联动清单

| 仓 | 当前 → 建议新版本 | 改动文件（文案） | 仓内联动（同一检查点顺序） | 索引仓联动 | 预设文件（精确 pin，必须逐条改） |
|---|---|---|---|---|---|
| `db-postgres` | `0.4.1` → **`0.4.2`** | `internal/pgop/call.go`、`identifiers.go`、`query.go`、`sqlguard.go`、`methods.go`（28 条） | `info.json`+`manifest.json` version / `size_bytes`（由 `make dist` 回填）/ `CHANGELOG.md` 顶部新条目；`make build && make dist`（两次 sha 一致 + 干净树复现）；**commit 1 只含源码文案、commit 2 只含 version 三件套** | `index/plugins.json` 的 version / sha256 / size_bytes / download_url → `v0.4.2`；`versions.lock.json` 追加 `0.4.2`；`presets/*.json`；重签 + 重建 market | `db-only.json`、`full.json`（共 2 处） |
| `runtime-python` | `0.4.1` → **`0.4.2`** | `internal/pyop/venv.go`、`versions.go`（8 条） | 同上 | 同上（`v0.4.2`） | `dev.json`、`full.json`（2 处） |
| `runtime-node` | `0.3.1` → **`0.3.2`** | `internal/nodeop/path.go`、`paths.go`、`projects.go`、`versions.go`（8 条） | 同上 | 同上（`v0.3.2`） | `dev.json`、`full.json`（2 处） |
| `runtime-php` | `0.3.1` → **`0.3.2`** | `internal/phpop/path.go`、`paths.go`、`projects.go`、`versions.go`（8 条） | 同上 | 同上（`v0.3.2`） | `web-lite.json`、`web-pro.json`、`full.json`（3 处） |
| `waf` | `0.5.2` → **`0.5.3`** | `internal/wafop/validate.go`（1 条） | 同上 | 同上（`v0.5.3`） | `full.json`、`security.json`（2 处） |
| `firewall` | `0.3.1` → **`0.3.2`** | `internal/fwop/validate.go`（1 条） | 同上 | 同上（`v0.3.2`） | `full.json`、`gateway.json`、`security.json`（3 处） |
| `app-deploy` | `0.4.1` → **`0.4.2`** | `internal/apop/validate.go`（1 条） | 同上 | 同上（`v0.4.2`） | `full.json`（1 处） |

共 15 处预设精确版本 pin；`presets-check` 会拒绝「索引里没有该版本」，因此预设改动必须与索引更新**同批**。

### 3.2 检查点合并建议（减少抖动）

- **仓内合并**：`db-postgres` 的 28 条 / `runtime-*` 各 8 条同属一个自洽改动（都是文案、同一门禁面），**一仓一个源码提交**即可，不要 55 个提交。按 RELEASE §2 第 4 步，bump 三件套另起一个提交（`chore(release): bump vX.Y.Z`），避免 `size_bytes` 回填被夹带。
- **跨仓不能合并提交**：每仓是独立 git 仓 / 独立 tag / 独立 release，提交单元按仓切。
- **批次合并**：`waf / firewall / app-deploy` 三个单条仓可同波次做；`runtime-node / runtime-php / runtime-python` 五个同构文案可同波次做；`db-postgres` 体量最大单独一波。三波共享**一次**索引仓提交 + **一次**重签（索引是多仓版本的汇总点，逐仓重签会制造多次签名抖动）。
- **发版窗口冻结**（RELEASE §2.1）：同一仓在「tag → 推三端 → 建 release」期间禁止其他源码提交；tag 必须 annotated 且钉住打 dist 的提交 sha（`git tag -a vX.Y.Z <sha>`），不得用默认 HEAD。

### 3.3 执行期需注意的他人 dirty 状态（只读观察，不碰）

- `db-postgres`（`zeroparam_test.go`）、`runtime-python/node/php/waf`（`internal/*/zeroparam_test.go`）、`app-deploy`（`zero_param_test.go`）均有**未跟踪**的 A1 测试文件；`firewall` 干净。这些不是本次写域，改动/提交一律不得包含它们。
- `kore` 根有在途 `M scripts/usability-pending.txt` 与多个未跟踪 `.agents/verify/*`、`data/`、`dist/`；本方案提交只含 `docs/USABILITY-A3-PLAN.md`。

## 4. 门禁涟漪清单（改写落地后按顺序重跑；本方案未跑）

1. **A3 主判据**：`cd kore && bash scripts/usability-check.sh`（不带 `--no-run-tests`，A1 真跑）→ 期望 **A3 FAIL = 0**、整体 exit 0。55 条修完后 A3 命中从 529 降到 474，恰好等于 `usability-pending.txt` 各仓登记上限之和 → 全部转 WARN，脚本不再报「超出登记条数」。此时应把各仓 A3 登记条数下调到实际值（或保持相等，避免「清单条目已不再违规」提示），是否同步下调由用户裁决。
   - 注意：474 条存量 WARN 与 183 条变量入参 `unverified` **不在本次范围**；A3 FAIL→0 不等于「A3 清零」。
2. **插件仓门禁**：逐仓 `make check`（gofmt → vet → test）与 `make build`；`make dist` 两次 sha 一致 + `git archive HEAD` 干净树复现一致。
3. **索引仓**：`cd kore-plugins && bash scripts/validate-index.sh`（schema / 同 id@version 唯一 / 版本单调 / sha 锁定 / market byte 级一致 / 签名）→ `bash scripts/validate-presets.sh` → `make check`（= 前两者）。
4. **索引→市场派生**：`bash scripts/build-market.sh` 重建 `market/plugins.js` 并同提交；`cd kore && make market-check` 期望 exit 0（逐字节一致）。
5. **主仓联动门禁**：`cd kore && make store-check`（G-17：info/manifest 版本一致 + dist sha 对照）、`make presets-check`（G-18：id/区间/sha/预算）、`make check` 全量 21 段（含第 16 段 market、第 20 段 usability WARN 级）。
6. **签名**：`KORE_SIGNING_KEY=~/.config/kore/signing/index-signing.seed bash kore-plugins/scripts/sign-index.sh` → `validate-index.sh` 正向 exit 0 + 篡改正文反例非 0。公钥是编译期常量，常规重签**不需要** `make build` / 重启 kored（RELEASE §2.4）。

### 4.1 需用户裁决 / 授权的动作（本方案一律不执行）

| 授权点 | 具体内容 | 为什么必须用户拍板 |
|---|---|---|
| 方案审阅 | 本文 55 条改后文案是否照此落地（尤其「只读查询请求：…」等白话措辞） | doc-first 硬约束：未确认不得写代码 |
| bump 与提交 | 7 仓 patch bump + 源码提交 + release 提交（commit -s，写 `[agent:<name>]` 归属） | 版本号是公开承诺；一丝不改协议，但版本对外可见 |
| tag | 每仓 `git tag -a v<new> <sha>`（annotated、钉 sha）；是否用 `-s` 签名 tag | tag 一经推送不可在同版本修正（RELEASE §5 / §2.1 事故） |
| 推送 | origin（Gitea，权威源）先推，再 github / gitee 镜像；分支与 tag 分账 | 用户明令 push 必须明确授权、攒批一次推，不逐 commit 推 |
| Release | 每仓 `gh release create v<new> dist/<id>-<new>.tar.gz`（含 Gitee 只保留最近 5 个的裁剪） | 对外发布资产不可回退 |
| 索引重签 | 使用长期签名密钥重签 `index/plugins.json` + 推索引仓 + 复核三方版本一致（release tag == 索引 == 8787 商店） | 动签名密钥/权限属不可回滚类，用户明令先问 |
| 存量清单 | 474 条 WARN 是否本轮一并下调 `usability-pending.txt`；183 条 `unverified` 是否排期人工核对 | 影响 G-33 从「分层 WARN」转「硬判据」的节奏 |

## 5. 风险与不做

- **只动字符串**：不改方法行为、不改返回值语义、不改协议 / schema / `info.json` 字段结构、不借机重构；`+ err.Error()` 等动态尾段原样保留（A3 只静态查第一个字面量）。
- **不碰 A1 / A2 存量**：474 条登记 WARN、183 条变量入参 `unverified` 不在本次范围；`usability-pending.txt` 的下调只是门禁卫生，不是文案修复。
- **术语边界**：改后文案不引入「实例 / 生命周期 / capability / revision」；`instance` 作为字段名保留并跟「数据库连接」白话解释，与 `docs/USABILITY.md` §4.1 口径一致。
- **`size_bytes` 自指**：只由 `make dist` 在新版本检查点回填，禁止手改；索引以 release 资产实测为准（RELEASE §1.2）。
- **预设 pin 是精确值**：7 仓 15 处 pin 必须与索引同批更新，漏一处即 `presets-check` FAIL。
- **dist 冻结**：打包窗口内不得并行改该仓源码（RELEASE §2.1 waf v0.4.1 事故）。
- **不联网 / 不 push / 不执行主流程 CLI**：本方案阶段全部只读；`usability-check.sh --no-run-tests` 是只读脚本（不调 git、不改仓库文件）。
- **并发工作区**：不提交他人未跟踪的 `zeroparam_test.go` 等文件；提交用精确路径 + `git commit -s -- <path>`，不用 `git add .`。

## 6. 附：方案自检记录（writer 侧）

```text
① bash scripts/usability-check.sh --no-run-tests → exit 1，55 FAIL 全为 A3（脚本原文证据）
② 同判据逐行重映射 → 55 条 script-FAIL == 55 条 file:line 映射，差集为空
③ 55 条改后首段字符串逐条跑 A3 判据（len ≥8 且含 请/应/需/例/如）→ 55/55 通过
④ 55 条改后文案逐条查四内部术语 → 0 命中
⑤ 本文只新增 docs/USABILITY-A3-PLAN.md；未改代码 / 未 bump / 未 push / 未联网
```
