# Round 5 · 全局验收（只读）

> 状态: verified · 归属: verifier · 更新: 2026-11-23 · 里程碑: M3
> 结论: **「本轮有真实产出，但没有一个可冻结的"这一轮"」**——代码在审计窗口内持续被并行 agent 提交，验收结论必须绑定快照时刻。
> 本轮未改任何文件（唯一写入本文件）；未 push / commit / 改运行态；未碰 8787。

## 0. 快照与"移动靶"（最关键的元事实）

审计窗口 `13:24 → 13:34` 内，工作树**一直在变**，实测四次：

| 时刻 | 事件 | capability（HEAD） | 说明 |
| --- | --- | --- | --- |
| 13:26 | 起始快照 | 15/24 | kore `8566d43`、waf `2db5f92`、db-postgres `1efdeac` |
| 13:30:08 | **24 仓批量提交 `chore(deps): pluginapi v0.1.3`**（23 仓同一秒） | 16/24 | 一次 sweep 把全部插件仓 HEAD 推走，`origin` 立刻全部落后 |
| 13:31:59 | 本报告主表快照 | 16/24 | container / runtime-node / runtime-php 在窗口内被 push |
| 13:34:03 | 复核 | **19/24**（工作树 20/24） | 8 分钟内又落了 3 个仓的 `method_capabilities` 提交 |
| 13:35:0x | 收尾复核 | **20/24** | kore `a3d3f53`（ahead 25）、索引落后仓数 12→**16** |

13:31:59 之后 2 分钟内 HEAD 又移动的仓：`kore f7bd150→468517d`、`cron 160c079→f28908c`、`db-postgres f1a8115→67829e9`、`integrity 782d24c→aac7150`、`logs acd750b→84a7521`、`runtime-python 86b5c0e→dc5b236`、`ssh-guard 8fa9950→4ea2459`。

**验收口径**：下表钉在 `2026-11-23T13:31:59+08:00`；一致性核对钉在 `13:34`（并同时给 HEAD 与工作树两个数）。任何"这一轮做完了"的结论都应先冻结（stop-the-world）再谈，否则复跑必然不一致。

## 1. 逐仓状态表（T = 2026-11-23T13:31:59+08:00）

列：`HEAD` · `推送状态`（`git ls-remote origin <branch>` 对比）· `未提交 M/??`（`git status --porcelain`）· `info.json` 版本 · 最新 tag · 索引版本 · 版本一致性。

| 仓库 | HEAD | 推送 | 脏 M/?? | info | tag | index | 一致 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `kore` | f7bd150 | **LOCAL_AHEAD**（origin 1c40847，ahead 21） | 7/133 | – | `pkg/pluginapi/v0.1.3` | – | – |
| `kore-plugins` | b4f688b | PUSHED | 0/0 | – | – | – | – |
| `app-deploy` | d67ceda | LOCAL_AHEAD | 0/0 | 0.2.0 | v0.2.0 | 0.2.0 | OK |
| `backup` | da0114e | LOCAL_AHEAD | 0/1 | 0.4.0 | v0.4.0 | 0.4.0 | OK |
| `container` | 61ea94f | **PUSHED** | 0/1 | 0.4.0 | v0.4.0 | 0.3.0 | **MISMATCH** |
| `cron` | 160c079 | LOCAL_AHEAD | 0/1 | 0.4.1 | v0.4.0 | 0.4.0 | **MISMATCH** |
| `db-mysql` | f8f96a0 | LOCAL_AHEAD | 0/0 | 0.3.1 | v0.3.1 | 0.3.1 | OK |
| `db-postgres` | f1a8115 | LOCAL_AHEAD | 0/0 | 0.3.0 | v0.2.1 | 0.2.1 | **MISMATCH** |
| `discover` | 35750e2 | LOCAL_AHEAD | 0/0 | 0.3.0 | v0.3.0 | 0.2.0 | **MISMATCH** |
| `dns` | 2480b4a | LOCAL_AHEAD | 10/5 | 0.2.0 | v0.2.0 | 0.2.0 | OK |
| `echo` | b8ec7e3 | LOCAL_AHEAD | 0/1 | 0.1.3 | v0.1.3 | 0.1.3 | OK |
| `file` | a0bfb19 | LOCAL_AHEAD | 0/1 | 0.3.0 | v0.3.0 | 0.3.0 | OK |
| `firewall` | b47196b | LOCAL_AHEAD | **1/0** | 0.2.3 | v0.2.3 | 0.2.3 | OK（但 dist sha 冲突，见 §2.6） |
| `integrity` | 782d24c | LOCAL_AHEAD | 0/1 | 0.3.0 | v0.2.0 | 0.2.0 | **MISMATCH** |
| `logs` | acd750b | LOCAL_AHEAD | 0/1 | 0.4.0 | v0.3.0 | 0.3.0 | **MISMATCH** |
| `monitor` | 71fd994 | LOCAL_AHEAD | 0/1 | 0.3.0 | v0.3.0 | 0.3.0 | OK |
| `process` | 26a58e7 | LOCAL_AHEAD | 0/1 | 0.2.1 | v0.2.1 | 0.2.0 | **MISMATCH** |
| `redis` | 4d72ec1 | LOCAL_AHEAD | 0/1 | 0.5.0 | v0.5.0 | 0.4.0 | **MISMATCH** |
| `runtime-node` | 1ac5bb8 | **PUSHED** | 0/0 | 0.2.2 | v0.2.2 | 0.2.0 | **MISMATCH** |
| `runtime-php` | f10bed8 | **PUSHED** | 0/0 | 0.2.2 | v0.2.2 | 0.2.0 | **MISMATCH** |
| `runtime-python` | 86b5c0e | LOCAL_AHEAD | **14/2** | 0.2.0 | v0.2.0 | 0.2.0 | OK |
| `site` | 9b78c8d | LOCAL_AHEAD | 0/1 | 0.3.1 | v0.3.1 | 0.3.1 | OK |
| `ssh-guard` | 8fa9950 | LOCAL_AHEAD | **10/2** | 0.2.1 | v0.2.1 | 0.2.1 | OK |
| `ssl` | 08d6cf3 | LOCAL_AHEAD | 0/1 | 0.4.0 | v0.4.0 | 0.3.0 | **MISMATCH** |
| `terminal` | b0a1d40 | LOCAL_AHEAD | 0/1 | 0.2.0 | v0.2.0 | 0.2.0 | OK |
| `waf` | 7fd9694 | LOCAL_AHEAD（origin cc6ed3e） | 0/1 | 0.3.0 | v0.3.0 | 0.2.0 | **MISMATCH** |

**汇总**：PUSHED **4/26**（`kore-plugins` + container + runtime-node + runtime-php），**已提交未推送 22/26**（kore 遥遥领先 21 commits）；**版本落后索引 12/24**；**有真实代码未提交 5 个仓**（kore 7M、runtime-python 14M、dns 10M、ssh-guard 10M、firewall 1M），其余 `0/1` 是未跟踪的 `RELEASE-EVIDENCE.md`，不构成代码半成品。

## 2. 一致性核对（5 项 + 2 项附加）

### 2.1 capability 覆盖率

```text
HEAD            = 19/24   （13:31:59 时 16/24；13:26 时 15/24）
工作树          = 20/24   （仅 dns 尚未提交）
HEAD 未覆盖 5 仓 = app-deploy / backup / dns / echo / firewall
```

命令：`for d in ../kore-plugin-*; do git -C $d show HEAD:info.json | grep -q method_capabilities && echo $d; done`

### 2.2 方法总数（`PLUGIN-MATURITY` §6 命令原文）

```text
app-deploy=4 backup=11 container=12 cron=8 db-mysql=11 db-postgres=10 discover=3 dns=4
echo=5 file=19 firewall=5 integrity=5 logs=7 monitor=4 process=5 redis=0 runtime-node=5
runtime-php=5 runtime-python=4 site=0 ssh-guard=6 ssl=14 terminal=9 waf=8
site_verbs=16   →  164 + 16 = 180（与 §6 声明的 180 一致）
```

**但 180 是"命令口径"的巧合**：`redis=0` 是因为 redis 已把分发从 `switch case` 改成 `methodTable` map（`internal/redisop/call.go:28-49`，14 个动词 + 2 个点分 = **16 个方法**），§6 的 grep 抓不到。真实业务方法面 ≈ **196**；§6 表格里 `db-postgres 4`（现 10）、`logs 5`（现 7）、`redis 9`（现 16）、`runtime-php 4`（现 5）均已过期。

### 2.3 主壳视图数

```text
HEAD:   web/app.js SHELL_ROUTES = 8；web/shell.js render: lazyView( = 10   → 18 视图
工作树: 8 + 11 = 19（container 视图已加 nav id + lazyView，但 web/container.js 仍 untracked、shell.js 为 M）
```

⇒ **已提交视图 = 18**，与 `PLUGIN-MATURITY` §3.3.1 的 18 一致；19 只存在于未提交工作树。

### 2.4 `go vet` / `go build` / 测试（kore，含 140 个脏文件的工作树）

```text
go vet ./...   → exit 0，0 行输出
go build ./... → exit 0，0 行输出
go test -timeout 200s ./... → exit 0；15 个包 ok，0 FAIL
go test ./internal/core/supervisor -run 'Demote' → ok
```

⇒ **降权支已不再"红"**：`internal/core/supervisor/demote.go` 已在 HEAD 跟踪（`git ls-files` 有），`start.go:70` 走 `SysProcAttr.Credential`，测试绿。这与文档 §5 #13 的"仍在 / 仅工作树"矛盾，见 §4.2。

### 2.5 第 33 把公钥两端一致

```text
kore  HEAD:internal/core/market/verify.go  IndexPublicKeyHex = "3a87e3a53c37ff467e3317fd48f9b7a92e13018ec60f8c250aaecda6d3f23e80"
kore  工作树同一文件                        同值（未脏）
kore-plugins/scripts/validate-index.sh      PUB_HEX="3a87e3a53c37ff467e3317fd48f9b7a92e13018ec60f8c250aaecda6d3f23e80"
bash kore-plugins/scripts/validate-index.sh → schema/24 条 + 版本单调 + 预设 47 引用 + ed25519 验签 全 OK，exit 0
```

⇒ **两端一致且签名可验**。唯一残留：`kore-plugins/README.md:72` 仍写旧的"内置演示公钥 `8f9e4c85…`"，与第 33 把 `3a87e3a5…` 不符（§4.6）。

### 2.6 附加：索引版本对齐 + dist 可复现性

```text
HEAD 版本 == 索引版本: 12/24（12 个 MISMATCH，见 §1 表）
索引声明包在本地 dist 可复现且 sha 一致: 23/24
  SHA_DIFF firewall 0.2.3  local=9c637faa1013…  index=353d56264532…（size 2808488 vs 2808093）
```

`firewall` 的 `dist/firewall-0.2.3.tar.gz` 在 **13:28 被重建**（deps 升到 pluginapi v0.1.3），sha 与索引/已发布资产不同；同时 `info.json` 有未提交改动（只改 `size_bytes` 2808092→2808490，**没有 bump 版本**）——这正是 G-17「同 `id@version` 只允许一个 sha」的红线场景。

## 3. 三态判定清单

### A. 真落地可交付（已提交 + 测试绿 + 有证据 + 已推送）

| 交付 | 证据 |
| --- | --- |
| `kore-plugins` 第 33 把重签（b4f688b，已双推） | `validate-index.sh` 全绿；kore `verify.go` 公钥一致（§2.5） |
| `waf` 0.3.0（cc6ed3e 已推 tag v0.3.0） | `go test ./...` ok=4/fail=0；方法级 9 条声明 |
| `container` 0.4.0（61ea94f 已推 tag v0.4.0） | `go test` ok=4/fail=0 |
| `runtime-node` / `runtime-php` 0.2.2（已推 tag） | `go test` 未单跑，编译/索引正常；**索引仍 0.2.0**，见 B |

> 注："真落地"只给到"已推送 + 本次复跑测试绿"的仓。其余 20 个仓虽本地测试绿，但**未推送**，按 G-07 不构成可交付。

### B. 半成品（未提交 / 未推送 / 版本落后索引 / 双 sha）

| 类别 | 对象 |
| --- | --- |
| 已提交**未推送** | `kore`（21 commits，含第 33 把重签、rootpolicy 形状表、降权 demote.go）、`app-deploy`、`backup`、`cron`、`db-mysql`、`db-postgres`、`discover`、`dns`、`echo`、`file`、`firewall`、`integrity`、`logs`、`monitor`、`process`、`redis`、`runtime-python`、`site`、`ssh-guard`、`ssl`、`terminal`、`waf` |
| 版本**落后索引**（新版本已提交但索引仍是旧版） | container 0.4.0 / cron 0.4.1 / db-postgres 0.3.0 / discover 0.3.0 / integrity 0.3.0 / logs 0.4.0 / process 0.2.1 / redis 0.5.0 / runtime-node 0.2.2 / runtime-php 0.2.2 / ssl 0.4.0 / waf 0.3.0 |
| **未提交真实代码** | `runtime-python` 14 改、`dns` 10 改、`ssh-guard` 10 改、`kore` 7 改（含 `web/shell.js` 容器视图）+ `web/container.js` untracked、`firewall` 1 改（size_bytes） |
| **同版本双 sha 风险（G-17）** | `firewall` 0.2.3：本地重建 `9c637faa…` ≠ 索引 `353d5626…`，且未 bump 版本 |
| 版本已 bump 但**未打 tag** | T=13:31:59 时缺 tag：container（0.4.0，窗口内已补 v0.4.0）、db-postgres 0.3.0、integrity 0.3.0、logs 0.4.0、cron 0.4.1；13:35 复核已收敛到 **dns 0.3.0 / logs 0.4.1**（发版在并行补齐，此列随时变化） |

### C. 文档与代码不一致（按 HEAD 复核）

| # | 文档 | 实际 | 判定 |
| --- | --- | --- | --- |
| 1 | `AGENTS.md:131` "**19 视图**主壳（…容器视图待验收）" | HEAD = **18**；19 需 `web/container.js`(untracked) + `shell.js`(M) 提交后才成立 | 措辞提前一格；同一句里"待验收"与"19"自相矛盾 |
| 2 | `PLUGIN-MATURITY` §5 #13「**仍在**：demote.go 仅存在于工作树，`git ls-files` 无 demote.go」 | HEAD **已跟踪** `supervisor/demote.go`，`start.go:70` 已接 `SysProcAttr.Credential`，`go test -run Demote` 绿 | **状态过期**，应改「部分补（代码已提交，缺真 root 实机验证）」 |
| 3 | §0.1 行 5 / §5 #12「已声明 **12/24** 仓」 | HEAD **19/24**（13:26 时 15，13:31 时 16——8 分钟内涨了 4） | 过期 |
| 4 | 同两处「`db-mysql 只读方法审计增量已归零（CHANGELOG）`」 | 已有端到端 A/B 证据（`.agents/verify/r5-12-method-capability.md`） | 证据栏该换 |
| 5 | §6 方法清单表 + 「180 业务方法」 | 命令口径 180（巧合），**redis 计 0**（真实 16）、db-postgres 4→10、logs 5→7、runtime-php 4→5 | 表格过期；命令对 map 分发的仓失效 |
| 6 | §5 #10「盘点时刻 **18/24** OK」 | 现 **12/24** OK | 过期（滚动量，可接受但须标注时刻） |
| 7 | `kore-plugins/README.md:72` 演示公钥 `8f9e4c85…` | 第 33 把 = `3a87e3a5…`，脚本与内核都用新的 | 文档残留旧密钥 |
| 8 | `AGENTS.md` "§3.5 **14 条**缺口" | 实测 §5 表 **14 行** | ✅ 一致 |
| 9 | §3.3.1 "18 视图 / 容器未接入" | HEAD 18、container 未提交 | ✅ 一致（与 §C1 的 AGENTS.md 冲突，二者须统一） |

## 4. 最该先补的 3 件事

1. **开一个冻结窗口，把 22 个仓推完 + 重签索引。** 现在 `kore` 领先 21 commits、21 个插件仓 committed-unpushed、12/24 版本落后索引——任何按索引安装的新实例都会拿到旧版本（runtime-node/php 安装到 0.2.0，而仓里已是 0.2.2）。这是当前唯一"用户可感知"的偏差。
2. **处理 `firewall` 0.2.3 双 sha（G-17）**：本地重建包 `9c637faa…` 与索引 `353d5626…` 不同，且 `info.json` 只改 `size_bytes` 不 bump 版本。要么回退 dist 到索引版本，要么 bump 0.2.4 + 重签索引；不能带着"同 id@version 两个 sha"进索引。
3. **按 HEAD 刷新三处文档**：§5 #13 降权状态（已提交、测试绿、缺真 root 验证）、capability 覆盖 19/24、§6 方法清单/总数的口径（`redis` 16 方法没被命令统计）；同时统一 AGENTS.md 的「19 视图」与 §3.3.1 的「18 视图」。

## 5. 复跑命令（全部只读）

```bash
cd /home/pt/Work/GolandProjects
# 逐仓：HEAD / 脏 / tag / 推送
for d in kore kore-plugins kore-plugin-*; do printf '%-28s %s %s\n' "$d" \
  "$(git -C $d rev-parse --short HEAD)" "$(git -C $d status --porcelain | wc -l)"; done
git -C kore rev-list --count origin/main..HEAD
# capability 覆盖（HEAD / 工作树）
for d in kore-plugin-*; do git -C $d show HEAD:info.json | grep -q method_capabilities && echo $d; done | wc -l
grep -l method_capabilities kore-plugin-*/info.json | wc -l
# 方法数 / 视图 / 索引校验
cd kore && git show HEAD:web/app.js | grep -cE "id: '[a-z-]+'"; git show HEAD:web/shell.js | grep -c 'render: lazyView('
bash ../kore-plugins/scripts/validate-index.sh
go vet ./... && go build ./... && go test -timeout 200s ./...
```
