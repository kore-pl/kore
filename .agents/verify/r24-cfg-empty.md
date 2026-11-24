# R24 · 统一配置面板空态友好降级（r24-cfgempty）交付与 G-28 证据

> 日期 2026-11-24 19:35–19:52（Asia/Shanghai）｜Owner `r24-cfgempty`（🔵 美团味）｜主提交 `7a65bfa`（HEAD archive 含本次改动）｜隔离实例 **18901**（`--config /tmp/kore-cfgempty.*/config.yaml`，state/run/log 全落 `/tmp`）｜写域 `web/config-panel.js`（唯一代码交付）+ 本报告 + 2 张截图｜**未 push**。

## 0. 结论

统一配置面板的「无契约 / 读取失败」两条坏路径已降级为人话空态/失败态：点「设置」不再空白页、不再裸 `E_NOTFOUND` 错误码。schema 渲染路径（`string/int/bool/select/list`、sensitive 密码、校验、已自动填入、恢复默认、保存热生效）**一行未动**，9 个有契约插件零回归面。硬验收 6 项全绿，G-28 双端截图齐（真 chromium headless + 真登录 + 真触发空态分支）。

**取样口径如实声明**：隔离实例未安装可稳定复用的无契约插件（peer 正在给 container/monitor/ssl/cron/firewall 补契约），故用 Playwright `page.route` 桩 `echo.config.get` 的两种返回形态（`E_NOTFOUND` 404 + `schema.fields=[]` 200）触发我写的空态分支——空态 DOM/CSS/按钮/44px 全部是真浏览器真渲染，非设计稿、非截图伪造；桩的只是上游 API 响应，与"没装插件时点设置"到达的分支完全一致。失败态（其它错误）由同一 `renderState` helper 渲染，代码回读 + `node --check` 覆盖，未单独截图（超时优先级下先保桌面截图）。

## 1. 硬验收（6 项）

| 项 | 判据 | 命令 / 来源 | 结果 |
| --- | --- | --- | --- |
| ① 语法 | node --check exit 0 | `node --check web/config-panel.js` | PASS exit 0 |
| ② 首屏预算 | ≤300 KiB gzip + 无 source map | `bash scripts/frontend-check.sh` | PASS：首屏 77763 / 307200 字节（余量 229437）；i18n 2922/3072；dist 无 map/.vite/字体；exit 0 |
| ③ 空态触发 | E_NOTFOUND 或 fields=[] → 人话 + 下一步按钮 | `web/config-panel.js:190-195,253-276,320-340` | PASS：两条路径均进入 `renderState`，标题「该插件暂无可配置项」，含「请/可」，按钮 [关闭, 去商店看看]，零错误码（`codeBlocks=0`） |
| ④ 失败态 | 其它错误 → 人话 + 怎么办 + 重试 | `web/config-panel.js:341-353` | PASS：标题「设置暂时读不出来」+ 人话 + [重试, 关闭]，错误码仅进折叠 `<details>`，不裸首屏 |
| ⑤ 兼容 | 不破坏已有 schema 渲染 | 逐行回读 `:252-319` | PASS：save/reset/collect/fieldControl/schema 分支未改；仅在 `fields.length===0` 时短路 return，非空 schema 走原路径 |
| ⑥ commit | pathspec 一步到位、首行 agent 前缀、不 push | `git commit -m "[agent:r24-cfgempty] …" -- web/config-panel.js` | PASS：`7a65bfa` 1 file changed, 98 insertions(+), 4 deletions(-)，`git show --stat` 核对无夹带 |

## 2. 文案与门禁对齐（USABILITY §4 / G-33 A3）

| 位置 | 用户可见文案 | 对齐点 |
| --- | --- | --- |
| 空态标题 | 该插件暂无可配置项 | 白话，无内部术语（不用 capability/revision/实例） |
| 空态说明 | 这是新版配置能力，插件作者尚未接入设置项；如需调整，可到软件商店查看该插件是否有新版本。 | ≥8 字、含「请/可/如」字样（含「可」「如」），给"怎么办" |
| 空态指引 | 您可以先关闭本窗口继续使用插件，或前往软件商店查看更新。 | 含「可」，下一步动作明确 |
| 空态按钮 | 关闭 / 去商店看看 | §4「空状态给下一步按钮」；`去商店` 走 `KoreShell.navigate('store')` |
| 失败态标题 | 设置暂时读不出来 | 白话，不甩错误码给用户 |
| 失败态说明 | 可能是插件还没启动好，或网络临时中断；请点「重试」再试一次，或回到列表刷新后重新打开。 | 含「请」，给可能原因 + 怎么办 |
| 失败态按钮 | 重试 / 关闭 | 一键恢复路径，`重试` 重新调 `open()` |

错误码处理：`invoke` 失败对象附带 `err.code` / `err.httpStatus`（`:53-59`），仅用于 `isNoContract` 判定与折叠 `<details>` 展示，首屏不裸露。`isNoContract` 只认 `E_NOTFOUND` / 「未知方法|unknown method|not implemented|方法不存在|暂无此能力」，**超时/5xx/网络错误一律进失败态**——已与 r24-cfg-ssl peer 对齐：那些插件补契约后正常返回 `schema.fields`，面板走原表单路径，不会被误判空态。

## 3. G-28 截图证据（隔离实例 18901，真登录 + 真浏览器触发）

| 文件 | `file` / `identify` 实测 | md5 | 触发路径 | 覆盖内容 |
| --- | --- | --- | --- | --- |
| `config-empty-desktop-01-notfound-20261124.png` | PNG 1440 × 1228（full-page，宽 1440 / 高 ≥900） | `ea353ffb…` | 桩 `echo.config.get` → 404 `{"code":"E_NOTFOUND"}` | 侧栏概览高亮 + 页面主体 + 底部配置面板空态：标题/两行白话/两个按钮可见 |
| `config-empty-mobile-02-emptyfields-20261124.png` | PNG 390 × 844（视口） | `de6acfe2…` | 桩 `echo.config.get` → 200 `{"schema":{"fields":[]}}` | 手机首屏：面板标题、空态文案完整换行、两个按钮上下堆叠各 44px、底部导航不遮挡 |

两端 md5 **全异**（`ea353ffb…` vs `de6acfe2…`），非同图缩放冒充：桌面是 full-page 1228 高含整页概览，手机是 844 视口、按钮上下堆叠（媒体查询 `@media(max-width:520px)` 生效），布局实质不同。

拍法：`git archive HEAD`（含 `7a65bfa`）→ `/tmp` 隔离源码 `make web-dist` + `CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build` → 独立 18901 端口 + 独立 state/run/log → `kored admin-password --set --stdin` 写哈希 → `POST /api/v1/auth/login` 真登录拿 cookie → Playwright chromium headless shell 1255 真开页 → 关首启引导 → `KoreShell.openConfig(host,'echo',{title})` 真调面板 → `page.route` 桩 API 返回 → 断言 `.cfg-state-title` 文案 + 按钮数 ≥2 + 文案含「请/可」+ 触摸目标 ≥44px + `codeBlocks=0` → `page.screenshot`。两次返工根因：首启引导弹窗遮挡（第一次 localStorage key 猜错 `skipped`，读源码 `web/onboarding.js:56-130` 改为 `dismissed` 并加主动 close 兜底），已修。

## 4. G-28 产品定位自评（三问）

1. **本页解决什么用户问题**：24 个插件里 15 个没有 config.get/set 契约，入口卡（商店卡片/已装列表）加了「设置」后，小白点进去是空白页或裸 `E_NOTFOUND` 错误码——这是"简陋的极致"。空态一次给出「为什么没东西 + 现在能干什么 + 两个明确按钮」，让无契约插件的设置入口不再是死路；失败态把「读不出来」翻译成「插件没启动好/网络中断」并给重试，不让人对着错误码发呆。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔/1Panel 的软件设置多为插件自带完整配置页，无"契约缺失"这一层；Kore 的薄壳 + 可选契约模型决定了会有大量无配置项插件。本面板用**一处统一降级**兜住所有无契约插件，避免每个插件各写一套空态：这是架构差异带来的工程化优势。差距：①当前空态无法区分"插件作者没做"与"插件做了但本版本未启用契约"（统一按未接入处理）；②「去商店看看」只导航到商店，不自动定位该插件详情页（依赖入口卡传入 opts，当前未定义 plugin detail 路由）；③失败态未做自动重试退避，靠用户点「重试」。
3. **当前是"可用"还是"占位"**：**可用**。空态/失败态是真实可交互 UI（按钮可点、导航真跳、重试真重新拉取），schema 表单渲染路径保留 9 个有契约插件的完整能力（含 sensitive 不回显、校验、热生效）。边界如实声明：截图用桩 API 触发两条空态路径（隔离实例无可稳定复用的无契约插件），失败态由代码回读 + 语法门禁覆盖、未单独截图。

## 5. G-29 / 横向 / 收尾

**本轮未改动主实例运行态配置**：对 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / 主 `bin/kored` 全程零写入，未重启 8787；只起停隔离实例 18901（已随脚本 trap 停止并删 `/tmp/kore-cfgempty.*`）。隔离端口与 peer（r23-slowlog 18891 等）不冲突。workaround 无（桩 API 仅用于截图触发，不进产品代码）；过期条件：当隔离实例装了真实无契约插件时，应改用真插件复拍替换桩截图。

**横向交流**：与 r24-storesetting / r24-appsetting 对齐「入口卡只调 openConfig、不做有无契约探测」，空态统一在面板闭环，避免两处文案漂移；与 r24-cfg-ssl 对齐「E_NOTFOUND 才算无契约、其它错误进失败态」，防止 peer 补契约后被误判。store peer 确认 host 用 `S.container` 视图根，本面板 `insertBefore(children[1])` 定位不受影响。

**临时资产**：截图编排脚本 `_cfgempty_run.sh` / `_cfgempty_shot.mjs` / `_cfgempty_results.json` 与两张截图一并留痕后，一次性脚本在分析结束时删除；截图与本报告按写域扩展提交，不进产品代码。
