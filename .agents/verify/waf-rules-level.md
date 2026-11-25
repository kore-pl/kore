# waf 防护等级 + 命中分析 + 模式切换确认（0.5.0 / web/waf.js）

> 口径：本文件只记本轮**实测**证据；未跑的一律写「未验证」。

## 1. 要做什么 / 做了什么

卡片目标（对标宝塔 / 1Panel 的 WAF 面板，只补缺口）：

| 目标 | 本轮交付 | 落点 |
| --- | --- | --- |
| 规则可见可管（列规则 / 启停单条 / 调整等级 / 自定义规则） | 已有 chain 列表与 `rule.toggle`/`rule.add`/`rule.remove`；**新增「防护等级」宽松 / 标准 / 严格**（后端 + UI） | `kore-plugin-waf/internal/wafop/level.go`、`nft.go` ApplyLevel、`kore/web/waf.js` |
| 自定义规则「预设优先」 | 新增 4 个规则模板（IP 黑名单 / 端口限制 / 丢弃畸形连接 / 放行办公 IP），匹配器仍走白名单 | `web/waf.js` RULE_PRESETS |
| 命中分析（记录 / Top IP / Top 规则 / 一键封禁） | 新增「命中分析」面板：时间范围 1h/24h/7d、记录数 / 已拦截 / 仅记录 / 独立 IP、Top 来源 IP 与 Top 命中规则条形图（CSS，无图表库）、每行「一键封禁 1 天」（写 nft 封禁集合） | `web/waf.js` loadHits/paintHits/banFromHit |
| 模式切换有明确提示与确认 | 观察 ↔ 拦截现在都要点确认（关闭防护原本就有确认） | `web/waf.js` chooseMode/confirmMode |
| 等级是事实不是配置 | `waf.status.level` / `waf.toggle.level` 从 `kore_waf` 链回读（名 → 特征 → 条数三级兜底） | `level.go` LevelFromChain/LevelFromSummary/currentLevel |

**等级语义**（不新增 root 动作，协议单插件 16 条上限已用满，复用 `nft-add-rule` / `nft-delete-rule`）：

| 等级 | 条数 | 内容 |
| --- | --- | --- |
| loose | 2 | 封禁名单 v4/v6 |
| standard | 4 | + SYN 限速 60/s + 单 IP 并发 200 |
| strict | 6 | + `ct state invalid counter drop` + SSH 暴破限速（22 端口，10/min 突发 20） |

顺带修掉两个已存在缺陷（等级功能踩到）：
1. `rebuildChain` 固定用观察模式 token 重装 → 在拦截模式停用/启用任一规则会把整链降级成只记录；
2. 内置 `syn-rate` / `conn-rate` 模板缺 `meter ... limit rate` 与 `ct count over N` 参数，重建后限速规则变成全量日志规则。

## 2. 证据（命令 + 退出码）

### 2.1 后端（kore-plugin-waf）

```
$ export GOCACHE=<workspace>/.tmp-gocache
$ make check
gofmt: clean
GOWORK=off go vet ./...            # 无输出
GOWORK=off go test -timeout 200s ./...
ok  github.com/pengtang1024/kore-plugin-waf            0.012s
ok  github.com/pengtang1024/kore-plugin-waf/internal/plugincfg
ok  github.com/pengtang1024/kore-plugin-waf/internal/wafop
FAIL github.com/pengtang1024/kore-plugin-waf/tests/e2e  0.503s
  unshare: unshare 失败: 不允许的操作
ok  github.com/pengtang1024/kore-plugin-waf/tests/fault
```

**exit 1，原因 = 沙箱禁止 `unshare -rn`**（e2e 用私有 netns 跑真 nft）。补位证据：`go test -c -o /dev/null ./tests/e2e` → exit 0（测试包可编译）；e2e 的真实 nft 断言本轮**未验证**，不能用「编译通过」代替。

新增 / 修改的单元证据：
- `internal/wafop/level_test.go`：等级归一、非法值 E_INVALID、`LevelFromChain` 表驱动（自定义规则不干扰）、
  strict（6 条 + `nft-add-rule`）/ loose（2 条 + `nft-delete-rule`）真实下发 + 回读校验、切模式沿用等级、status 报告等级。
- `nft_test.go` 的 `fakeNft` 升级：按 token 渲染 `nft -j` 规则结构并模拟 add/delete，幂等断言从「回读次数」改为「不得再下发写动作」（等级取证需要多一次只读回读）。

发版产物：

```
$ make dist
打包完成: dist/waf-0.5.0.tar.gz sha256=a94c905d...54a74e89 size_bytes=2947541 实际=2947541
```

### 2.2 前端（kore/web/waf.js）

```
$ node --check web/waf.js && echo ok
ok
$ bash scripts/frontend-check.sh
[OK] 首屏体积达标：81528 字节 ≤ 307200 字节，余量 225672 字节
[OK] i18n 增量达标：2922 字节 ≤ 3072 字节
$ make secret-check
secret-check: 0 FAIL / 22 处匹配（占位写法均合规）
```

### 2.3 隔离实例真机截图（G-28 / G-29）

```
$ UI_SHOT_BUILD_SOURCE=head bash scripts/ui-shot.sh --scene waf-rules-level \
    --route security/waf --desktop --mobile --port 18902 --mock <mock.json> --expect-text '防护等级'
[OK] desktop 1440x3240 / waf-rules-level-desktop-01.png
[OK] mobile  390x844  / waf-rules-level-mobile-01.png
```

补充交互态（同一脚本副本，在 Playwright 段注入「点掉新手引导 + 真点按钮 + 滚到区块」，跑完即删）：

| 文件 | 实测宽高 | 说明 |
| --- | --- | --- |
| `waf-rules-level-desktop-01.png` | 1440×3240 | 主视图：防护等级三档 + 命中分析（Top IP/规则、一键封禁、已在名单徽标） |
| `waf-rules-level-mobile-01.png` | 390×844 | 手机首屏（状态卡单列、触摸目标 ≥44px） |
| `waf-rules-level-confirm-desktop-01.png` | 1440×3310 | **真点击**「只记录不拦截」→ 确认条出现（文案 + 确认/取消） |
| `waf-rules-level-confirm-mobile-01.png` | 390×844 | 手机确认条 + 等级卡片（单列全宽） |
| `waf-rules-level-hit-mobile-01.png` | 390×844 | 手机命中分析：统计格 2 列、条形图 + 数值 + 「一键封禁 1 天」 |
| `waf-rules-level-panel-mobile-01.png` | 390×844 | 手机等级面板 |

数据来源声明：截图用 `--mock` 注入 waf 方法返回值（隔离实例真实 kored + 真实浏览器点击，后端响应为桩）。
**为什么 mock**：waf 插件的 root 通道与真实 nft 需要 root，隔离实例内不起；但没有 mock 就只能截到「去商店安装」空态，看不到本轮功能。
**未验证**：真 root + 真 nft 下的 strict/loose 端到端（e2e 被 unshare 阻断）、以及浏览器里点击后由真实后端回读的结果。

### 2.4 G-29 声明

本轮**未改动**主实例运行态：`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 均未触碰；
截图走 `ui-shot.sh`（config/state/run/log 全落 `/tmp`、独立端口 18902–18906、trap 停实例删目录）。临时 mock / patch 脚本用完即删。

## 3. 产品定位自评（G-28 ③）

1. **本页解决什么问题**：让「WAF 开着但没人知道它在干什么」变成可见可调——能看到当前几档防护、每条内置/自定义规则的启停、按来源 IP 与规则聚合的命中量，并且能在一个面板里把可疑 IP 封掉、把防护从只记录切到拦截（有确认，不会误点）。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔/1Panel 是「HTTP 层 WAF 面板」（规则库、CC 防护、URL 白名单、日志图表、一键封禁），本页的强项是**网络层自有数据面**（不用装引擎就有 IP 封禁/扫描限速/SSH 暴破限速，且等级可直接调）；差距是 **URL / User-Agent 级规则仍依赖宿主装 ModSecurity/Naxsi**（kore 不写宿主配置），且没有 CC 挑战页与人机校验。命中分析的 Top IP 只来自引擎审计日志（网络层丢包只有计数器），这点在页面上写明了，没有拿计数器冒充来源 IP。
3. **当前状态**：**可用**（三档等级、Top IP/规则、一键封禁、模式确认都在真机截图里点得通），非占位；短板是网络层命中没有来源 IP 明细（需解析 kernel log，属 v1.1）。

## 4. 已知边界 / 未验证

- `tests/e2e`（真 nft，私有 netns）本轮未跑通，环境禁止 `unshare`；`tests/fault` 与全部单元测试绿。
- 插件索引仓 `kore-plugins`（`versions.lock.json` / 索引 sha）不在本卡写域，`waf@0.5.0` 的 dist sha 尚未入索引——需由 lead 统一发版。
- `internal/wafop/zeroparam_test.go` 是本轮开始前就存在的**未跟踪**文件（非本卡产出），未提交、未修改，仅确认它在当前实现下通过。
- 观察模式日志前缀 `kore-waf-*` 落内核日志，本插件不解析；「防护规则」表的「命中包数」是网络层唯一命中来源。
