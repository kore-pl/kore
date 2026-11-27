# meta: kind=verification task=task-231 date=2026-11-27 owner=token-ip-verifier verdict=PASS repo=kore commit=3fb0754

# API token IP 绑定独立验收（G-09 / task-231）

被验对象：`3fb0754c55a5190a61da3aa209a4ad8a36d5b11f`（`[agent:token-ip-impl]`）。
复核方式：独立只读复核，不复用实现者结论；代码读码 + 门禁独立复跑 + 隔离副本缺陷复现 + git 边界核对。
工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`。**总评：PASS**（五项方案点、缺陷修复、门禁、边界证据全部成立；仅按项目既定口径如实记录既有 WARN/待收口项，不构成 BLOCKED）。

## 0. 环境与纪律声明

- 默认 `GOCACHE=/home/pt/.cache/go-build` 在本沙箱只读（实测 `open ...: read-only file system`），故所有 Go 命令显式指定隔离缓存：
  `GOWORK=off GOPROXY=off GOCACHE=<kore>/.tmp/token-ip-verifier-gocache GOMODCACHE=/home/pt/Work/GolandProjects/kore-pl/.tmp-acct-gomodcache`；该缓存目录在本报告落盘前已删除。**全程未联网**（`GOPROXY=off`）。
- 未改任何生产代码/测试/文档/配置；未 push / tag / Release；未执行主流程 CLI；未读写 `.kore-local-*`（仅 `ls` 确认存在，未触碰）；他人 dirty 原样。
- 缺陷 FAIL 复现使用 `git archive HEAD` 的 `/tmp` 一次性隔离副本，测完即删；主树零改动。

## 1. 读码核对方案 3ee02df 五点（全部成立）

| # | 方案要求 | 证据（file:line，HEAD=3fb0754） | 判定 |
| --- | --- | --- | --- |
| ①配置模型 | `APITokenRecord` / `TokenView` 加 `AllowedCIDRs []string json:"allowed_cidrs,omitempty"`；`normalizeTokenCIDRs` 用 netip；裸 IP 补 /32·/128；`Masked`；`Unmap`；去重排序；拒 zone//0；≤16 条 ≤64 字节；空=nil；`CreateTokenWithCIDRs` / `UpdateTokenCIDRs` 单事务无缓存避开 `LastUsedAt` 抹字段；`CreateToken` 包装器零破坏 | `internal/core/auth/security.go:90-114`（两结构均含 omitempty 字段，注释点明 LastUsedAt 整条写回陷阱）；`:482-545`（`normalizeTokenCIDRs`：`:483-485` 空→nil、`:486-488` >16 拒、`:493-499` 空元素/>64B 拒、`:506-525` ParsePrefix+Masked / ParseAddr+PrefixFrom(bits) + **构造前 zone 检查**、`:526-528` /0 拒、`:529-536` Is4In6→Unmap 且掩码 -96、`:538-544` 去重+sort）；`:549-552`（`CreateToken` 仅包装）；`:557-607`（创建含 CIDRs 的单次 `store.Update`）；`:654-699`（`UpdateTokenCIDRs` 一个 `store.Update` 内读-改-写，三态 nil/空/非空）；`:730-745`（`ValidateToken` 无缓存，LastUsedAt 写回用同一整条记录，字段不丢） | PASS |
| ②鉴权门 | 验签后、scope 前插门；只取 `r.RemoteAddr` 不读 XFF/X-Real-IP/Forwarded；回环不隐式放行；UDS 仅 SO_PEERCRED uid 合规豁免、取不到即 fail-closed；401 `E_UNAUTHORIZED` + `auditDenied(capability="", reason=token_ip_denied)` 不编造 | `internal/core/httpapi/middleware.go:120-137`：`:120` 先 `ValidateToken`，`:128-132` 绑定门，`:133` 才 scope 判定；拒绝体固定 `401 E_UNAUTHORIZED / "API 令牌不允许从此网络地址使用" / detail=""`；`:129` 审计五参 `("token:"+id, "", "", "", "token_ip_denied")`；`:274-282` `auditDenied` 复用既有出口。`token_ip_gate.go:23-46` 只解析 `r.RemoteAddr`（ParseAddrPort→ParseAddr、Unmap、zone/无效拒），全文无 XFF/X-Real-IP/Forwarded；`:57-77` 空绑定直接放行、UDS 需 `connInfoFrom`+`isUnixConn`+`!blocked`+`channel==unix`，否则逐条 ParsePrefix 匹配；`local_access.go:80-93` `unixLocal` 走 `transport.PeerCred` 校 uid∈{0, os.Getuid()}，取不到即 blocked | PASS |
| ③管理入口 | 创建/列表/回显字段；新增 `PUT /api/v1/security/tokens/{id}`（`*[]string` 三态、需口令、非法 400） | `handlers_security.go:53-59`（create req 含 `AllowedCIDRs`）、`:79-85`（created body 回显）、`:63-66`（`tokenUpdateRequest.AllowedCIDRs *[]string`）、`:261-301`（create/list/update handler；update `:291` `verifyPasswordOrDeny`、`:294` PathValue id、`:297` 非法 400 E_INVALID）；`handlers.go:118-120` 注册 `PUT tokenItemPath`；`security.go:624-626 / 693-695` 视图回显同一字段 | PASS |
| ④零改范围 | TTL/scope/能力/插件 bearer 零改；仅标准库 `net/netip`；无新依赖/新 bucket/ticker | `git diff 3fb0754^ 3fb0754 -- go.mod go.sum` 空；13 路径无 `web/`、`cmd/`、`internal/core/config/`、插件仓；grep `NewTicker\|AfterFunc\|NewTimer` 于改动 Go 文件零命中；仍复用 `meta` bucket 与既有 `security.*` 前缀；scope 分支 `:133-137`、插件 bearer 分支 `middleware.go:52-60` 未改；`make check` 2/21 dep-check 2/3 第三方 | PASS |
| ⑤文档与台账 | SECURITY.md:153、CORE.md（72→73）、DATA-MODEL.md 同步；G-23 DECISIONS 四项 + DISPATCH | `docs/SECURITY.md:153` 表格 API token 行完整写入绑定/门/UDS/审计口径与 UA 未绑定残余风险；`docs/CORE.md:59 / :64 / :411` 同步 73（66+7）；`docs/DATA-MODEL.md:168` meta bucket 行补 `security.token.<id>` 与 `allowed_cidrs?: string[]` 且不升 schema；`.agents/LOG/DECISIONS.md` 末尾新增 2026-11-27 行含 ①UDS ②XFF ③门顺序 ④版本 四项及各自被否决选项；`.agents/LOG/DISPATCH.md` 末尾新增 task-230 行含 task/owner/写域/依赖/交付/commit | PASS |

补充：设计文档 §1「代码锚点（实施时的唯一事实来源）」指向 `internal/core/auth/security.go` 与 `internal/core/httpapi/*`；task-230 卡片写域元数据另列 `internal/core/config/`、`cmd/kored/`。实现者按方案唯一事实来源把配置模型落在 `auth`（而非 `config`），提交未触碰 `config/`、`cmd/`，DISPATCH 记录的也是实际 auth 路径。**写域偏差处置正确**（偏差源于任务卡元数据，非实现错误；未产生多余文件）。

## 2. 真实缺陷修复复核：`netip.PrefixFrom` 丢 zone（成立）

- 根因复述：`PrefixFrom(addr, bits)` 会丢弃 `Addr` 的 zone；若 zone 检查在 Prefix 构造之后，`prefix.Addr().Zone()` 恒为空，裸 `fe80::1%eth0` 会被归一成 `fe80::1/128` 静默接受。
- 修复：`internal/core/auth/security.go:500-501` 注释、`:511-513`（带 `/` 分支在 `Masked()` 前查 `parsed.Addr().Zone()`）、`:520-522`（裸 IP 分支在 `PrefixFrom` 前查 `addr.Zone()`）；`zoneErr` 闭包复用人话错误。测试：`token_cidr_test.go:36-37`（zone/zone 前缀拒）、`handlers_token_cidr_test.go:115`（`fe80::1%eth0` 必须 400 E_INVALID）。
- **INITIAL FAIL（实现者终端证据，未落盘报告文件，已向 token-ip-impl 直接取证）**：`gofmt -w ... && go test -count=1 -timeout 200s ./internal/core/auth/ ./internal/core/httpapi/` → `TEST_EXIT=1`，`handlers_token_cidr_test.go:119: 非法 [fe80::1%eth0] 应 400 E_INVALID，实际 200 ... "allowed_cidrs":["fe80::1/128"]`（其中测试临时 token 值按 G-30 已脱敏，非真实凭据）。
- **本 verifier 独立复现 FAIL（隔离副本，非引用实现者结论）**：`git archive HEAD | tar -x -C /tmp/kore-zone-fail-verify2`，复制 gitignored `web/dist`，仅移除裸 IP 分支的 zone 守卫后跑：
  - `go test -count=1 -timeout 200s -run TestTokenCreateInvalidCIDR400 ./internal/core/httpapi/` → `PREFIX_FAIL_EXIT=1`，`handlers_token_cidr_test.go:119: 非法 [fe80::1%eth0] 应 400 E_INVALID，实际 200 ... "allowed_cidrs":["fe80::1/128"]`。
  - `go test -count=1 -timeout 200s -run 'TestNormalizeTokenCIDRs/zone' ./internal/core/auth/` → `NORM_FAIL_EXIT=1`，`token_cidr_test.go:47: expected error, got [fe80::1/128]`。
  - 隔离副本已 `rm -rf` 删除并回读确认不存在。
- **FIX→GREEN（本 verifier 在主树干净 HEAD 独立复跑）**：`go test -count=1 -timeout 200s ./...` → exit 0，auth 与 httpapi 两包均 `ok`；上述 FAIL 断言在 3fb0754 上全部通过。证据链 INITIAL FAIL → FIX → GREEN 完整成立。

## 3. 门禁复跑（命令 + 退出码，均本 verifier 独立执行）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `go build ./internal/core/auth/ ./internal/core/httpapi/ ./cmd/kored/` | 0 | 三包编译通过（首次不带隔离缓存时因默认 GOCACHE 只读失败，改用隔离缓存后 0；属沙箱环境问题非代码问题） |
| `go build ./...` | 0 | 根 module 全包编译通过 |
| `go vet ./...` | 0 | 无输出 |
| `go test -count=1 -timeout 200s ./...` | 0 | 17 包全 ok（auth 1.168s / httpapi 6.685s），另有 `web [no test files]` |
| `cd pkg/pluginapi && go build ./...` / `go test -count=1 -timeout 200s ./...` | 0 / 0 | 2 包全 ok（pluginapi、pluginapitest） |
| `make docs-check` | 0 | `5 pass, 1 warn, 0 fail`；唯一 WARN 为既有 11 份行数越界（CORE 414 / DATA-MODEL 406 / SECURITY 526 / 7 份 DETAIL 58 等）+ 2 份已登记豁免，与方案 §6.3 基线逐条一致，非本次引入 |
| `make secret-check` | 0 | `0 FAIL / 24 处匹配（占位写法均合规）` |
| `make log-check` | 0 | `8 pass, 0 warn` |
| `make cross-vet` | 0 | windows/amd64 + darwin/arm64 含 `_test.go` 类型检查通过 |
| `make check` | 0 | 21/21 段全过，末行 `[OK] 门禁全部通过`（21:49:11 → 21:54:35）；其中 17/21 交叉编译五目标 exit 0、19/21 全仓 `-race` 17 包 58s 零 DATA RACE、21/21 pluginapi `-race` 2 包零 DATA RACE |
| `git diff --check 3fb0754^ 3fb0754` | 0 | 零输出 |

`make check` 第 20/21 段 usability-check（`0 pass, 502 warn, 1 fail, 190 unverified`）与 G-33 归因核对：
- 唯一 `[FAIL]` 为 `A1 waf: ZeroParam 真跑失败`（`kore-plugin-waf/tests/e2e`）→ `[FAIL] G-33 有新违规` 汇总行，共 2 条 `[FAIL]` 被聚合脚本计入，均指向**其它插件仓**（waf）与 `scripts/usability-pending.txt` 陈旧豁免清单（A1 runtime-node/php/python/ssh-guard 4 条「清单条目已不再违规」WARN）；`make check` 中该段为 **WARN 级不阻断**，整体 exit 0。
- 本提交 13 路径不含 `web/`、任何 `kore-plugin-*` 或 `scripts/usability-pending.txt`；该文件在复核前后均为他人 dirty（`3 insertions(+), 17 deletions(-)`），如实原样保留。**归因成立：1 fail / 2 新违规与本改动无关**，判据未放宽。

## 4. git 与边界核对（全部成立）

- `git rev-parse HEAD` = `3fb0754c55a...`；subject 含 `[agent:token-ip-impl]`；`git log -1 --format=%B` 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`，author/committer 均为 pengtang1024 → **DCO 合规**。
- `git diff-tree --no-commit-id --name-only -r 3fb0754 | wc -l` = **13**，精确路径：`.agents/LOG/{DECISIONS,DISPATCH}.md`、`docs/{CORE,DATA-MODEL,SECURITY}.md`、`internal/core/auth/{security.go,token_cidr_test.go}`、`internal/core/httpapi/{handlers.go,handlers_security.go,handlers_token_cidr_test.go,middleware.go,token_ip_gate.go,token_ip_gate_test.go}`；无 `git add .` 痕迹。
- **未 push**：`git status -sb` = `## main...origin/main [领先 3]`（`3ee02df`/`c52ae28`/`3fb0754`）；对 gitea/gitee/github/origin 逐一 `git branch -r --contains 3fb0754` 均无命中（基于本地 remote-tracking ref，未 fetch）。
- **worktree 仅主树**：`git worktree list --porcelain` 仅一条 `worktree .../kore`；`make check` 7/21 wt-check `4 pass, 0 warn`；无 `wt-*/tmp-*` 残留分支、`/tmp/wt-*` 残留。
- **他人 dirty 原样**：复核前后 `git status --porcelain` 完全一致（` M scripts/usability-pending.txt`；未跟踪 `.agents/.agents/`、8 份 `.agents/verify/*.md`、`screenshots/adp-debug-desktop-01.png`、`data/`、`dist/`），均未提交/未改动。
- **临时目录**：仓库内 `.tmp/` 为 11-25 既存、已被 `.gitignore:19` 忽略的共享缓存目录（含 gocache），并非本任务产物；实现者 `token-ip-*` 临时 gocache 已删；本 verifier 的 `.tmp/token-ip-verifier-gocache` 与 `/tmp/kore-zone-fail-verify*` 均已删除并回读确认。`make check` 11 段自建 `.zero-intrusion-tmp.*` 由脚本自清，复核后无残留。
- **G-28 不触发如实**：提交未改 `web/`（无 UI 字段/截图变更），管理入口仅 API；DISPATCH 与实现说明均写明「G-28 不触发」，判定正确。
- **端点 72→73 台账留后续如实**：`docs/CORE.md:411` 已改 73 并逐字注明「根 AGENTS.md 与 README.md 文档表仍记 72（65+7）：本卡写域不含这两份文件，留待 lead / scribe 收口同轮同步为 73（66+7）」；回读 `AGENTS.md:152` / `README.md:105` 确实仍为 72 → **标注与事实一致**，非文档不一致缺陷。
- **G-28/G-29 运行态**：未改 `.kore-local-*`（未读其内容）；`make check` 全在隔离根/临时目录运行，未触碰 8787 主实例配置。

## 5. 诚实边界（未证明 / 不在本次写域）

- FAIL→FIX→GREEN 的**实现者最初终端输出**未落盘成文件（其本人在消息中明确说明；按要求不代写报告）；但本 verifier 已用隔离副本独立复现同一 FAIL 并在 HEAD 复跑 GREEN，故证据链不依赖该未落盘输出。
- `docs/DESIGN-TOKEN-IP-BIND.md` 按要求由实施卡追加「实现复核」小节，本次 3fb0754 未改该文档（13 路径不含它）；属方案文档维护项，不阻断实现验收。
- `AGENTS.md` / `README.md` 端点计数 72 尚未同步为 73，按 CORE.md 明示留 lead / scribe 收口；本 verifier 不越写域修改。
- 反向代理场景看到代理 IP、UDS 本机已失守、UA 未绑定等残余风险，方案 §5 已如实披露，代码与 SECURITY.md 口径一致。

## 6. 结论

方案 3ee02df 五点全部落地且读码证据成立；zone 真实缺陷 FAIL→FIX→GREEN 证据链完整（含 verifier 独立复现）；build/vet/test（根 17 包 + pluginapi 2 包）/docs-check/secret-check/log-check/cross-vet/make check（21 段 exit 0）全绿，WARN 均有既有基线或他仓归因；git 13 精确路径 + DCO + 未 push + 单 worktree + 他人 dirty 原样 + 临时目录删净成立；G-28/端点台账/写域偏差均如实处置。

**总评：PASS（task-231 验收通过）**。署名：`[agent:token-ip-verifier]`。
