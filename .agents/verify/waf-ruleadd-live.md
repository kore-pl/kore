# C1 真机验证：WAF 0.5.3 `rule.add` 闭环（dsh-root + 私有 netns + 真 nft）

- 验证日期：2026-11-26
- 执行者：c1-waf-live（task-126）
- 被测对象：`kore-plugin-waf` HEAD `861b8de`（`info.json` / `manifest.json` version = **0.5.3**）
- 环境：本机 nftables v1.1.6 (Commodore Bullmoose)；Go 1.26.8
- 结论：**PASS**（核心闭环可用；附带 1 条与闭环无关的观察，见 §6）

---

## 1. 硬隔离声明

1. 所有 nft 操作均在 `dsh-root /usr/bin/unshare -rn /bin/sh <工作区临时脚本>` 创建的**私有 user+net namespace** 内执行；netns 内 `id` 实测 `uid=0(root)`，`nft list tables` 起始为空（不继承宿主表）。
2. 只创建/删除被测插件自身声明的 `table inet kore_waf`；该表仅存在于私有 netns 内，随 netns 销毁消失。**没有**对宿主 `filter/nat/mangle/raw` 或任何既有表执行 list/modify/delete。
3. 未启动 kored、未连 8787 主实例、未碰 `.kore-local-*`；未改 `/etc`；未真实 install/upgrade；未联网业务（`GOPROXY=off`，依赖来自本机已缓存的 module cache）。
4. 源码在**工作区临时快照** `.tmp-waf-live-c1/src` 中以 `git ls-files` 复制并对 root-in-userns 放开读权限后编译；生产仓 `kore-plugin-waf` 未改一字节（未跟踪的 `internal/wafop/zeroparam_test.go` 原样保留）。临时目录（含 root 拥有的 GOCACHE）已用 `dsh-root /bin/rm -rf <该目录>` 删除并回读确认不存在。

---

## 2. 步骤①：HEAD 0.5.3 是否含 0.4.3 / 0.4.4 修复

命令与退出码（在 `kore-plugin-waf` 仓）：

```
$ python3 -c "import json; print(json.load(open('info.json'))['version'], json.load(open('manifest.json'))['version'])"
0.5.3 0.5.3                                    # exit=0

$ git log --oneline -- internal/wafop/ruleadmin.go | grep -E '259d8ad|34bceef|b82ebec'
34bceef [agent:waf-chain-fix] fix(waf): waf.rules.chain 恒 null + 回读 expr 为空（0.4.4）
259d8ad [agent:kore-impl-waf] fix(waf): nft 1.1.x comment 解析（已发版缺陷：rule.add 恒失败）+ bump 0.4.3
b82ebec [agent:waf-045-e2e] test(e2e): 补 waf 0.4.5 端到端（真实二进制+协议帧+私有 netns 真 nft）
                                               # exit=0

$ git merge-base --is-ancestor 259d8ad HEAD; echo $?   # 0
$ git merge-base --is-ancestor 34bceef HEAD; echo $?   # 0
$ git merge-base --is-ancestor b82ebec HEAD; echo $?   # 0
```

源码回读（`internal/wafop/ruleadmin.go:250-371`）确认修复在 HEAD 中：

- `:252-254` 注释明确「nft 1.1.x 把 `comment "kore-rule-x"` 放在 rule 对象顶层；0.4.1 只扫 expr 导致 chain 恒空、rule.add 写后回读必失败」；`:296-321` 三层兜底读 `rule.Comment` → `expr[].comment` → 特征识别，`:307-310` 用「键存在即动作」识别 nft 1.1.x 的 `{"drop": null}`。
- `:330-342` 0.4.4 P3：自定义规则回读时用 `renderRuleExpr` 还原可读 expr，空则回退含 token 数的说明串（不是空串）。
- `:361-369` 兜底：JSON 里有规则对象却解析不到任何 kore 规则时返回 `E_UPSTREAM`（不再静默当空链）。

e2e harness（`tests/e2e/harness_test.go`）确认：

- `:37-48` `WAF_E2E_PRIVATE_NETNS=1` 为 netns 内标记；`:99-150` `TestMain` 在宿主无 nft 权限时自动 `unshare -rn` 重跑自己，在已有 nft 权限时直接跑（本次我们在 netns 内，nftUsable() 为真）。
- `:388-455` 假内核 root-action 通道按 `info.json` 的 `root_actions` 声明执行真实 `nft`，不 mock。
- `:479-523` `nftRuleHandles` 用**独立进程** `nft -j list table inet kore_waf` 核对数据面，不经插件回读自证。
- `tests/e2e/rule_e2e_test.go:132-256` `TestRuleAddToggleRemoveAgainstRealNft` 覆盖 chain 非空/内置徽标/expr 非空/handle 一致/toggle/remove/幂等。

判定：**HEAD 0.5.3 完整包含 0.4.3 + 0.4.4 修复及 0.4.5 e2e harness**。

---

## 3. 步骤②：真机执行（命令 + 退出码 + nft 回读原文）

### 3.1 能力前置（宿主侧只读探测）

```
$ dsh-root --shell 'id; grep CapEff /proc/self/status; unshare -rn sh -c "id; nft list tables; nft add table inet kore_waf_verify_probe; nft delete table inet kore_waf_verify_probe"'
uid=0(root) gid=0(root) groups=0(root)
CapEff:	000001ffffffffff
uid=0(root) gid=0(root) groups=0(root)
add-exit=0 / del-exit=0
exit=0
```
（探测表 `kore_waf_verify_probe` 在私有 netns 内已删净；宿主表未被 list/改动。）

### 3.2 上游针对性 e2e（在 dsh-root 私有 netns 内）

```
$ dsh-root /usr/bin/unshare -rn /bin/sh <tmp>/inner.sh
==== NETNS IDENTITY ====
uid=0(root) gid=0(root) groups=0(root)
==== TABLES AT START (private netns only) ====
START_TABLES_EXIT=0            # 空表集，不继承宿主
==== GO TEST ====
$ go test -count=1 -timeout 200s -run TestRuleAddToggleRemoveAgainstRealNft -v ./tests/e2e/
=== RUN   TestRuleAddToggleRemoveAgainstRealNft
--- PASS: TestRuleAddToggleRemoveAgainstRealNft (0.19s)
PASS
ok  	github.com/pengtang1024/kore-plugin-waf/tests/e2e	5.125s
TEST_EXIT=0
==== CLEANUP ====
$ nft delete table inet kore_waf     # DELETE_EXIT=0
==== TABLES AFTER CLEANUP ====
（空）                                # POST_TABLES_EXIT=0
DSH_ROOT_EXIT=0
```

完整 e2e 亦在私有 netns 内通过：

```
$ go test -count=1 -timeout 200s ./tests/e2e/
ok  	github.com/pengtang1024/kore-plugin-waf/tests/e2e	0.728s
FULL_E2E_EXIT=0
```

### 3.3 聚焦闭环（每步独立 nft 回读）

在工作区临时快照的 `tests/e2e/` 下写了**一次性**聚焦测试 `TestC1FocusedAddHandleRemove`（不入库、随临时目录删除），只走 `toggle observe → waf.rule.add → waf.rule.remove`，每步用独立 `nft -j` 打原文快照。在 `dsh-root /usr/bin/unshare -rn` 内执行：

```
$ WAF_E2E_PLUGIN_BIN=<tmp>/wafprobe go test -count=1 -timeout 200s -run TestC1FocusedAddHandleRemove -v ./tests/e2e/
=== RUN   TestC1FocusedAddHandleRemove
[STEP0 toggle] mode=observe applied=true
[NFT after-toggle] 4 条 rule（handle 4/5/8/10），无 comment；表 inet kore_waf、chain input、set banned4/banned6/kore_syn4 均已建
[STEP0 rules] engine=none chain_len=4
[STEP0 chain[0]] name=ban-ipv4  builtin=true action=observe handle=4  expr="ip saddr @banned4"
[STEP0 chain[1]] name=ban-ipv6  builtin=true action=observe handle=5  expr="ip6 saddr @banned6"
[STEP0 chain[2]] name=syn-rate  builtin=true action=observe handle=8  expr="tcp flags syn tcp dport { 80, 443 } meter kore_syn4 { ip saddr limit rate over 60/second burst 120 packets }"
[STEP0 chain[3]] name=conn-rate builtin=true action=observe handle=10 expr="tcp dport { 80, 443 } ct count over 200"

[STEP1 add] {"applied":true,"dry_run":false,"op":"add",
  "rule":{"name":"c1-live","expr":"tcp dport 8443","action":"drop","enabled":true,
          "builtin":false,"handle":11,"expr_tokens":2},
  "chain":[ ...4 条内置..., {"name":"c1-live","expr":"tcp dport 8443","action":"drop",
           "enabled":true,"builtin":false,"handle":11,"expr_tokens":2}]}
[NFT after-add] 原文（关键片段，完整 JSON 见测试日志）：
  {"rule":{"family":"inet","table":"kore_waf","chain":"input","handle":11,
    "comment":"kore-rule-c1-live",
    "expr":[{"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":8443}},{"drop":null}]}}
[STEP1 independent nft handles]=[11] plugin_handle=11

[STEP2 remove] {"applied":true,"dry_run":false,"op":"remove",
  "rule":{"name":"c1-live","expr":"tcp dport 8443","action":"drop","enabled":false,"builtin":false,"handle":0,"expr_tokens":0},
  "chain":[ ...仅剩 4 条内置... ]}
[NFT after-remove] 原文：只剩 handle 4/5/8/10 四条内置规则，无 `kore-rule-c1-live`。
[C1] add->handle->remove 闭环断言全部通过
--- PASS: TestC1FocusedAddHandleRemove (0.08s)
PASS
ok  	github.com/pengtang1024/kore-plugin-waf/tests/e2e	0.364s
TEST_EXIT=0

==== FINAL NFT READBACK ====
{"nftables":[ ...表/链/3 个 set..., 4 条内置 rule handle 4/5/8/10 ... ]}   # 无 c1-live
EXIT=0
==== CLEANUP ====
$ nft delete table inet kore_waf       # DELETE_EXIT=0
==== TABLES AFTER CLEANUP ====
（空）                                  # EXIT=0
DSH_ROOT_EXIT=0
```

文本形态的独立回读（来自 3.2 上游 e2e 结束时的 netns，同样在删表前采集）：

```
table inet kore_waf {
	set banned4 { type ipv4_addr; flags interval,timeout }
	set banned6 { type ipv6_addr; flags interval,timeout }
	set kore_syn4 { type ipv4_addr; size 65535; flags dynamic }
	chain input {
		type filter hook input priority filter - 10; policy accept;
		ip saddr @banned4 counter packets 0 bytes 0 log prefix "kore-waf-ban4"
		ip6 saddr @banned6 counter packets 0 bytes 0 log prefix "kore-waf-ban6"
		tcp flags syn tcp dport { 80, 443 } add @kore_syn4 { ip saddr limit rate over 60/second burst 120 packets } counter packets 0 bytes 0 log prefix "kore-waf-scan"
		tcp dport { 80, 443 } ct count over 200 counter packets 0 bytes 0 log prefix "kore-waf-conn"
		ip saddr 203.0.113.0/24 drop comment "kore-rule-block-e2e"
	}
}
```
（该片段是上游 `TestRuleAddToggleRemoveAgainstRealNft` 末尾做了「内置规则 toggle off/on」之后的状态；`block-e2e` 在步骤 9 的 `waf.rule.remove` 已按要求消失，但随后步骤 11 对内置规则 toggle 触发 `rebuildChain()` 从 registry 重放自定义规则，把它重新装回——见 §6。聚焦测试 §3.3 不做内置 toggle，remove 后链里确实只剩 4 条内置。）

---

## 4. 步骤③：判定（PASS / PARTIAL / FAIL + 证据）

| 判定项 | 结果 | 证据 |
|---|---|---|
| `waf.rule.add` 真写数据面 | **PASS** | `applied=true`；独立 `nft -j` 回见 handle 11 + `comment:"kore-rule-c1-live"` + `{"drop":null}`（§3.3） |
| chain 非空 | **PASS** | `waf.rules` 返回 `chain_len=4`（观察模式内置）；add 返回 `chain` 5 条；上游 e2e 断言链长 == nft 规则数 |
| 徽标（builtin=true / 自定义 false） | **PASS** | 4 条内置 `builtin=true` 且 expr 非空；`c1-live` `builtin=false`；上游 e2e 同步断言 |
| chain handle 回读一致 | **PASS** | 插件返回 `handle=11`，独立 `nft -j list` 得到 `[11]`，完全相等（0.4.3 修复点） |
| `waf.rule.remove` 真删数据面 | **PASS** | `applied=true`；独立 nft 回读无 `kore-rule-c1-live`；返回链只剩 4 条内置；重复 remove 幂等 `applied=false`（上游 e2e 步骤 10） |
| 0.4.1 式 502 回滚是否复现 | **未复现** | 0.4.1 的失败形态是「写后回读不到 → `E_UPSTREAM`（HTTP 502）回滚」。本次 add 全程 `applied=true`、`dry_run=false`、`op=add`，无任何 `E_UPSTREAM`/`E_INVALID`；0.4.3 的三层解析与 0.4.4 的 expr 反解在真机 handle/comment 上均生效 |
| 注入防护（附带） | **PASS** | 上游 `TestRuleAddRejectsInjectionOnRealNft` 在私有 netns 真表上通过（语句注入/文件包含/表达式夹带动作 → `E_UNSUPPORTED`，非法 IP → `E_INVALID`，表未被 flush） |
| 隔离与清理 | **PASS** | 每轮起始/结束 `nft list tables` 为空；`nft delete table inet kore_waf` exit=0；私有 netns 随进程销毁；宿主表零接触 |

**总评：PASS**。`waf` 0.5.3 的 `rule.add → 回读 chain handle → rule.delete` 闭环在本机真 nftables 1.1.6 + 私有 netns 下可用；旧报告（`waf-rules-ui.md:65`）停在 0.4.1 的 502 回滚**不再复现**。

---

## 5. 与其他卡写域的关系

- 本卡**唯一写文件**为本报告 `kore/.agents/verify/waf-ruleadd-live.md`。
- **未改** `kore/docs/FEATURE-GAP-BACKLOG.md`（与 c15-gate 卡写域冲突，C1/C2/C15 收口由 lead 另派）；未改 waf 生产代码；未改任何他人 dirty 文件（kore 仓 `scripts/usability-pending.txt` 的 M 状态、多个 `?? .agents/verify/*` 与 `data/`、`dist/` 均原样保留）。

---

## 6. 诚实边界与附带观察（不影响上述 PASS 结论）

1. **验证形态**：e2e 用「真插件二进制 + 真协议帧 + 假内核 root-action 通道（按 `info.json` 声明执行真 nft）」，不是 kored 主进程 + 8787 实例。这覆盖 `rule.*` 的协议/数据面闭环，但**未覆盖** kored 前端徽标渲染与浏览器交互（那是 UI 层，需另卡）。
2. **`engine=none`**：因私有 netns 无 ModSecurity/CrowdSec 引擎，`waf.rules` 的 `engine` 为 `none`、`available=false`；但 `chain[]` 由 0.4.4 修复后与引擎解耦，仍正常返回 4 条内置 —— 正好验证该修复的设计意图。
3. **附带观察（非本卡验收项）**：上游 `TestRuleAddToggleRemoveAgainstRealNft` 的最后一步「内置规则 toggle off/on」会调用 `rebuildChain()`（`internal/wafop/rulecalls.go:194-245`），从 registry 重放已登记自定义规则。因此在该测试里已 `waf.rule.remove` 掉的 `block-e2e` 会在随后的内置 toggle 后重新出现在 nft 中（§3.2 文本回读可见）。这说明「删除自定义规则 + 后续启停内置规则」组合下存在**自定义规则复活**的行为；与 `rule.add → handle → delete` 单次闭环无关，本次不修改生产代码，如实记录供后续评估。
4. **环境噪声**：`dsh-root` 每次调用会打印「无法写入审计日志 `~/.local/state/dsh/root-exec.log`: 只读文件系统」警告（用户级只读挂载所致），不影响 sudo 提权与命令退出码；所有 `dsh-root` 调用最终 `exit=0`。
5. `GOPROXY=off`：依赖 `pluginapi v0.1.5` 来自本机已缓存 module cache，未发生联网下载。
