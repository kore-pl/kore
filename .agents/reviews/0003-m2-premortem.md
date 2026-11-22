> 状态: draft · 归属: red-team · 更新: 2026-11-22 · 里程碑: M2
> 方法: 假设 M2 在收口评审被判失败，从死因倒推；只收能被一条命令或判据戳穿的死法。

# 0003 · M2 Sites & Market 事前验尸（pre-mortem）

判定基线：[提案 0002](../proposals/0002-m2-sites-and-market.md) §2 五轨道 / §3 风险表 / §5 E2E-1~3，[V1-GOALS](../../docs/V1-GOALS.md) §1.3/§1.4，[AGENTS.md](../../AGENTS.md) G-03/G-18/G-19。提案已覆盖 R1–R5 五条风险，本文专挑它**没覆盖或口径自相矛盾**的死因；命中任一即 M2 不成立。

## 1. 五条失败场景

### S-01 R2 索引签名链断供：验签逻辑对了，但链本身断了
- 场景：提案把 ed25519 索引签名前移 M2、公钥内置二进制，却没定义签名私钥的轮换/失效/备份。CI 签名步骤与索引发布脱节或私钥轮换后，新 `plugins.json` 全部验签失败 → `refresh` 全拒，商店装不了任何包；运维为"先能装"把 `store.allow_unsigned=true` 写进默认配置，信任空窗反而从 M4 提前到 M2。
- 触发条件：私钥轮换/丢失、CI 签名 job 未随索引发布、公钥版本无兼容窗口；`allow_unsigned` 从显式审计开关退化为默认。
- 影响：E2E-2 商店装/升/卸全断；G-10 零信任承诺变成默认放行，比 M2 不做签名更糟。
- 早期信号：`refresh` 返回签名错误码；生产配置出现 `allow_unsigned`；公钥只有一个版本且无轮换 ADR。
- 提前发现（一条命令）：`openssl pkeyutl -verify` 对当前索引验签必须过、改 1 字节必须失败，且 `grep -rn 'allow_unsigned.*true' internal/ docs/ --include='*.go' --include='*.md'` 命中为 0（仅审计测试例外）。

### S-02 site 插件与宿主其它软件抢 nginx 配置（提案 R1 的盲区）
- 场景：R1 只管 kore 自家插件间的 `depends_on`/`conflicts`，没管宿主机器上**已存在**的 nginx/宝塔/1Panel 配置。site install 改主配置或占 `default_server`，把用户原有站点搞挂或 `nginx -t` 失败；E2E 全在干净容器跑，永远复现不出来。
- 触发条件：预装 nginx 且有 default_server 的真实 VPS；site 直接改 `nginx.conf` 而非独立 conf.d 片段；install 后无 nginx -t + 回滚。
- 影响：装出半套 web 栈且打断既有业务（安全事故级）；"资源零侵占"对外承诺被打脸。
- 早期信号：install 日志出现 `nginx: [emerg]` 或 80 端口冲突；`grep -rn '/etc/nginx/nginx.conf' kore-plugin-site` 非空；干净环境过、真实环境挂。
- 提前发现（一条判据）：在预装 nginx + 一条 default_server 的 fixture 上 `kored install` site，断言 `nginx -t` 退出码 0 且原 vhost 文件 `sha256sum` 前后一致，否则 FAIL。

### S-03 web 首屏破 300 KiB gzip
- 场景：M2-D 加商店页 + 首装向导 + 等级徽章/依赖提示；UnoCSS 只裁剪扫描到的静态类名，动态拼类名或图标包会把全量样式/字体带进 dist，`make frontend` 报超限。R4 有抓手但没落到"哪些文件禁止出现"。
- 触发条件：模板里运行时拼类名、引入图标字体或组件库默认样式、开启 sourcemap。
- 影响：G-03 红线破；首屏性能目标失守，M4 集中瘦身返工。
- 早期信号：`make frontend` 报 >300 KiB；dist 出现 `*.map`/`.vite`/全量 `*.woff2`。
- 提前发现（一条命令）：`make frontend && test $(find web/dist -type f \( -name '*.map' -o -path '*/.vite/*' \) | wc -l) -eq 0`，任一项非 0 即 FAIL。

### S-04 lazy 冷启动超时 / 唤醒占用未定义槽
- 场景：提案把冷启动 p95 ≤300 ms 记为 SLO 不判失败，但 §4 只说"第 3 槽留用户临时启用"，没定义 lazy 唤醒算不算常驻；唤醒时若已是第 4 进程就破"同时常驻 ≤3"。另一死法：空闲 300 s 退出后 socket/pid 残留或 ticker 续命，重拉 `EADDRINUSE`，再次 invoke 超时。
- 触发条件：resident site+monitor 已占 2 槽时唤醒 lazy；退出路径不清理 socket；请求级 Timer 没 `defer Stop()`。
- 影响：E2E-3"再次调用重新 exec + hello"失败；G-19 定时器/空闲门禁红；API p95 ≤50 ms 被冷启动拖垮。
- 早期信号：`make idle` 见定时器来源命中/进程数不降；`ss -xl` 有残留 sock；连打 20 次 p95 >300 ms。
- 提前发现（一条判据）：resident 2 槽时连打 20 次 lazy invoke，`pgrep -fc '/plugins/'` 峰值 ≤3、p95 ≤300 ms、退出后 `ss -xl | grep -c <id>.sock` = 0，否则 FAIL。

### S-05 预设资源超预算：把"目标"当"红线"的口径混用
- 场景：§4 把 site+monitor=16 MiB 当固定常量、对 19.2 MiB 目标余量 3.2 MiB；但 site 是 M2 新写的 production 插件（域名/反代/配置模板），实测常超声明的 10 MiB，一次升级 +512 KiB 即破防。且 G-18 红线是合计 ≤48 MiB，提案把 19.2/24 MiB 目标写成 `presets-check` FAIL 条件——口径与 G-03 冲突，验收时各引一份。
- 触发条件：8 预设按声明值而非实测中位数求和；site 实测 >12 MiB；余量为 0 或负仍被判"趋势告警"而非 FAIL。
- 影响：M2 收口 `make budget-check` 与 `presets-check` 互相打回；预设装不起来触发 ROADMAP 回滚条件；双口径让 verifier 无法裁决。
- 早期信号：`make presets-check` FAIL 但 `make budget-check` 绿；`make mem` 实测 site 与 `info.json` 声明值差 >2 MiB。
- 提前发现（一条判据）：`make presets-check && make budget-check` 同时绿，且每个 resident 的 `make mem` 60 点中位数 ≤ 声明值 +512 KiB，否则 FAIL。

## 2. 对提案的三条可执行修改建议

1. **给 R2 加"签名链可用性"验收**（现在只验"签名校验正确"）：补私钥轮换/失效演练与公钥版本兼容窗口，明文规定 `allow_unsigned=true` 只能带审计日志且不得进默认配置；把 S-01 的正向验签 + 改 1 字节必失败 + allow_unsigned 零命中固化为 G-18 的一条 gate。
2. **给 M2-A 增补"宿主 nginx 共存"契约**：site 只写独立 `conf.d` 片段、不碰主配置/`default_server`、install 前对现有配置做快照、`nginx -t` 失败自动逆序回滚；E2E-3 增加"宿主已装 nginx + 一条 vhost"的 fixture，原 vhost 字节不变才算过（提案 R1 完全没覆盖这一类外部冲突）。
3. **统一常驻槽与预算口径**（对应 S-04/S-05）：§4 明文定义"同时常驻 ≤3 = resident + 活跃 lazy 之和"，写明 lazy 唤醒占第 3 槽、超 3 即驱逐而非硬起；19.2/24 MiB 标为"目标/趋势"、48 MiB 标为"红线/FAIL"，`presets-check` 用实测中位数而非声明值求和；冷启动 p95 超 300 ms 虽不判 FAIL，但必须产出记录报告并进 G-19 证据。

## 3. VERDICT

**REVISE.** 提案 R1–R5 覆盖了自家五类风险，但 S-01（签名链断供）、S-02（宿主 nginx 共存）两类高破坏场景不在其风险表与 gate 内；S-04/S-05 的槽位与预算口径自相矛盾，按现文验收会出现 `presets-check` 与 `budget-check` 互相打回。三条建议落地后可由 verifier 复跑上文五条判据复审。

## 4. 复验（2026-11-22，提案 0002 修订后 58 行）

只核本文 §2 三条建议是否落实，不新增判据。证据文件 `.agents/proposals/0002-m2-sites-and-market.md`（下称 `0002`）。

- **建议1 签名链可用性：PASS** — `0002:20`（M2-B）含私钥轮换后旧签名可验/公钥兼容窗口、CI 出有效签名索引、未签名默认拒、allow_unsigned 禁入默认配置；`0002:30`（R2）含断供早期信号（refresh 签名错误码/单版本公钥/allow_unsigned 入默认配置判 FAIL）；`0002:55`（E2E-2）四项齐。
- **建议2 宿主 nginx 共存：PASS** — `0002:19`（M2-A）含独立 conf.d 片段 + include、不改主配置、不抢 default_server、nginx -t 退出 0 且原 vhost sha256 前后一致；`0002:34` 新增 R6；`0002:56`（E2E-3）fixture 断言齐。
- **建议3 槽位与预算口径：PASS** — `0002:44`/`0002:48` 明确"常驻 = resident + 活跃 lazy，≤3、超 3 驱逐"与"19.2/24 MiB 为目标 WARN、仅 48 MiB 红线 FAIL、实测中位数求和"；`0002:21`（M2-C）/`0002:23`（M2-E）/`0002:31`（R3）/`0002:33`（R5）/`0002:54`（E2E-1）逐处同步。

**VERDICT: APPROVE** — 三条建议全部落实，无新增判据，原 REVISE 阻塞项闭环。
