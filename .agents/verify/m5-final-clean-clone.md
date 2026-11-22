> 状态: 冻结证据 · 里程碑: M0–M5 · 类型: 独立 verifier 干净 clone 终验 · 时间: 2026-11-22T14:0x+08:00 · 基准: kore=e132eee kore-plugins=55bdd88 · verifier=m5-final-verify（不复用 implementer 报告）

# M5 独立 verifier 干净 clone 终验

## 基准与隔离
- 两主仓均 `git clone` 到 `/tmp/m5-verify-411386/`（退出码 0，工作树干净）；clone HEAD 与 ls-remote/本地 HEAD 三方一致：kore=`e132eeeaf53f27fe358ca0cb3959add4afbebf6b`、kore-plugins=`55bdd886476fb0ca8323b6cb3842aa6dd2dc466e`。
- 期间观测到 kore-plugins 两笔推送（65f1d85 市场页、55bdd88 预设扩引用）由 lead 补推，最终基准已对齐；kore 曾短暂前进 081d0c1→e132eee，最终稳定。

## 组1 · 两个主仓门禁（全绿）
- `make check`（kore clone）：exit=0，10 段全过（docs-check 6/6、dep 2/2、thin-shell 4/4、repo 5/5、canonical 9/9、log 8/8、wt 4/4、oss 8/8、case 5/5、frontend 4151 B ≤300 KiB）。
- `go test -timeout 200s ./...`（kore clone）：exit=0，12 个包全 ok。
- `git archive HEAD | tar -x` + `GOWORK=off go build ./...`（解包目录）：archive exit=0、build exit=0。
- `validate-index.sh`（kp clone）：exit=0，21 条 schema/签名/引用全过。
- `validate-presets.sh`（kp clone）：exit=0，8 预设 / 21 插件 / 0 FAIL / 0 WARN。
- `make check`（kp clone）：exit=0（顺序跑 validate-presets + validate-index，均绿）。

## 组2 · 索引与公钥
- 索引 21 插件 sha256 与 size_bytes 逐条比对本地 `dist/<id>-<ver>.tar.gz`：21/21 sha MATCH、size MATCH，0 FAIL。
- 公钥：`kore/internal/core/market/verify.go:16` 与 `kore-plugins/scripts/validate-index.sh:10` 均为 `2917cf3c5b8d6bea10ed9460702c23cb411d15947072cd5a2869667e22028bab`（clone 内回读确认）。

## 组3 · 已推 12 插件仓回读与抽查
- `git ls-remote` 逐仓回读：echo/site/file/ssl/integrity/cron/ssh-guard/monitor/logs/dns/runtime-php/runtime-node 共 12 仓 remote HEAD == 本地 HEAD（12/12 MATCH）。
- 抽查 3 仓（file/ssl/cron，均已推；firewall 未推故替换）：`GOWORK=off make dist` exit=0；tar 首条目均为 `info.json`；产物 sha256 与索引逐条 MATCH。
- 9 仓待推（app-deploy/backup/container/db-mysql/db-postgres/firewall/redis/runtime-python/waf）：`git ls-remote` 返回 `Repository not found`，本地 HEAD 均存在、dist sha 与索引一致，按 lead 指示挂账 15:00 推送，不计入本次失败。

## 组4 · 静态资产
- `kore-plugins/market/plugins.js`（clone）：索引 21 个 id 全部命中（21/21，missing=[]）。
- `kore/docs/site/docs.js`（clone）：39 条 path 条目；与 `plugins.js` 均零 `http(s)://` 外链（count=0）。
- `kore/docs/PLUGIN-SDK.md`（clone）：180 行。

## 组5 · 代码核对（按 G-17/G-20/V1-GOALS 真实口径）
- 21 仓 `info.json` 必填 5 字段（depends_on/conflicts/scenario_tags/size_bytes/requires_kore）：21/21 齐全；id/depth_level 与索引一致；dist tar 全部无 `./` 根条目（0 FAIL）。
- 生产级 12 仓 `tests/fault/`：11 仓齐备且含 cgroup/disk/kill/timeout 四类；**site 缺失 tests/fault/（只有 tests/fixtures/webserver-coexist.sh，dist 内亦无）→ 阻断**。
- 基础级口径：V1-GOALS §23 定义 8 产品基础级（runtime-node/runtime-python/db-postgres/waf/ssh-guard/integrity/dns/container）+ echo 验证件不评级；索引将 echo 标 basic、其余 8 均 basic，属展示口径差异（记录级，非阻断）。

## VERDICT: REVISE

### 阻断（必须修，重验）
- B1 `kore-plugin-site`（199942b5，已推）标 `depth_level=production`，但缺 `tests/fault/` 四类用例，违反 G-20 与 V1-GOALS §29「12 生产级全部过故障注入」。需补 cgroup/disk/kill/timeout 四类用例并 CI 绿，或按 G-20 降级 basic（同步索引/文档/预设）。

### 记录（不阻断，留痕）
- R1 索引把验证件 echo 标 `depth_level=basic`，与 V1-GOALS「echo 不评级」口径不一致，建议索引/商店显示为「验证件」。
- R2 本次五组其余全部通过：两主仓 6 个门禁、索引 21 sha/size、12 仓回读、3 仓 dist、静态资产、G-17 字段与 ./ 根条目均 0 FAIL。
- R3 初版自查曾把索引字段误套插件仓 info.json、硬编码 fault 分类为 oom/crash/restart/corrupt，经读 G-17/G-20/V1-GOALS 原文纠正后按项目真实口径重核（未放宽验收标准）。

### 9 仓挂账
- app-deploy/backup/container/db-mysql/db-postgres/firewall/redis/runtime-python/waf：远端未建仓（15:00 补推），本地 HEAD + dist sha 已就绪；本次不判失败，补推后需补一轮 `ls-remote==HEAD` 回读。

### 清理证明
- `/tmp/m5-verify-411386/`（6.5M，两主仓 clone + kore-archive）已删除；`pgrep -a kored` 无输出、`pgrep -c kored` = 0；临时 dist 日志 `/tmp/m5-dist-*.log` 与 `/tmp/m5-vroot-path` 已删除。仅留本报告，未改任何代码。
