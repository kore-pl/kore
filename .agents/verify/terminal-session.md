> 元信息: 2026-11-23T16:03+08:00 · 执行者 kore-impl-container-view（implementer）· `web/terminal.js` 322→564 行 · 隔离实例 `127.0.0.1:18872`（`--config /tmp/kore-term/config.yaml`，state/run/log 全在 `/tmp/kore-term`）· 插件 terminal **0.2.0**（本地包 sha `d72e4567533e` 与已验签索引一致，离线安装）· 主实例 8787 未动 · Gitea issue #3 前半 · 报告 ≤90 行

# terminal 视图补会话列表 / 恢复 / 历史（Gitea #3）

## 0. 结论

4 个方法全部接通并真机验证（12 项 API 断言全过），核心痛点「刷新页面终端就丢」已根治：**刷新/切走不再关会话**，重进自动 `list` 探活——仅 1 个静默 `attach` 恢复、多个给选择条。`node --check` / `make frontend` / `make build` 全绿；双端 4 张截图色标帧校验 attempt=1，浏览器 Runtime 异常 0。**只改 `web/terminal.js`**，未碰 integrity/tasks/process/shell/internal。

## 1. 4 个方法落点（file:line）

| 方法 | 落点 | 行为 |
| --- | --- | --- |
| `terminal.list` | `web/terminal.js:337`（`boot :336`） | 打开视图先探活：`{sessions[], count, max_sessions}` → **0 个**新建；**1 个存活**静默恢复；**≥2 个**渲染选择条 `showSess :310`；探活失败退回新建（不砖化视图） |
| `terminal.attach` | `web/terminal.js:363`（`restoreSession :360`） | 接管会话 → 用 `cursor - replay_bytes` 读回放窗口重建屏幕（`max_bytes` 放宽到 1 MiB 吃掉 attach 与 read 之间新到的输出）→ 起增量轮询；失败（已被空闲回收/归属不符）说明原因并自动新建 |
| `terminal.history` | `web/terminal.js:419`（`loadHistory :417`） | `limit:50` 拉输入历史 → `renderHist :440` 逐条展示；`histText :399` 把 base64 解码成可读文本（剥 ANSI/控制符、回车→`⏎`、160 字截断） |
| `terminal.history.clear` | `web/terminal.js:429`（`clearHistory :427`） | **两段式行内确认**（第一次点变「确认清空？」，不弹窗）→ 回显 `已清空 N 条输入（M 个会话）` 并重拉 |

**配套改动**：`onPageHide :520` 与 `destroy :553` **不再关闭会话**（服务端按最近活动默认 30 分钟自动回收）；`connect` 补 `E_RATELIMIT` 人话提示（`:296`「会话数已达上限（最多4个）：先在上方恢复或关闭一个已有会话」）；`ensureCss :66` 注入选择条/历史面板样式（不占首屏预算）。

## 2. 人话化（USABILITY ④，禁内部术语）

- 选择条标题「**检测到 2 个未关闭的会话，要恢复吗？**」+ 副行「恢复 = 接回原来的屏幕和输入，不用重开；不需要的可以直接关掉」；行内 `可恢复 · /bin/bash · 进程 2529178 · 最近活动 15:59:06`（`eof`→「会话已结束（可看最后输出）」，`last_active`→`fmtClock :247` HH:MM:SS，全程不出现 session_id/cursor/replay_bytes 字样）。
- 恢复后底栏：`会话 t-… · /bin/bash · 进程 2529178 · 135×40 · **空闲 30 分钟无操作会自动回收**`（由 `idle_expires_at` 换算，`setFoot :235`）；shell 退出则显示「会话已结束（点「新建会话」继续）」。
- 历史面板标题「输入历史（最近敲过的命令）」，空态「还没有输入历史：在下方终端里敲几条命令就有了」，存储异常/插件侧关闭各有直白说明。

## 3. 真机 API 断言（隔离实例，12/12 过）

```
1 list 初始        → {"sessions":[],"count":0,"max_sessions":4}
2 create A         → t-2e964956… client_id=default shell=/bin/bash
3 write 16B        → {"written":16}
4 history          → enabled=true count=1 seq1 base64 解码 = b'echo hello-kore\r' ✓
5 create B + list  → count=2 max_sessions=4（两条 eof=false）
6 attach A         → attached=true cursor=0 replay_bytes=0 idle_expires_at=+30min ✓
7 read 活读        → bytes=1058 cursor=1058（含 shell 提示与转义序列）
8 attach 二次      → cursor=1058 replay_bytes=1058
9 回放读 cursor=0  → replay=true bytes=1058 数据与活读逐字节同源（不重不漏）
10 history         → count=2（echo hello-kore / ls -la /tmp）
11 history.clear   → {"cleared_sessions":1,"cleared_entries":2}
12 clear 后        → count=0 entries=0
```

## 4. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/terminal.js` | **0** | 无输出 |
| `make frontend` | **0** | 首屏 59,416 B ≤ 307,200；i18n 2,801 ≤ 3,072 |
| `make build` | **0** | `[OK] 构建完成: ./bin/kored` |
| `make secret-check` | **0** | `0 FAIL`（口令为 `$KORE_TERM_PASSWORD`，值不落档） |

## 5. G-28 双端截图（`file` 实测宽高；左上 3×3 色标=帧校验，attempt 全 =1）

| 文件 | `file` 实际宽高 | sha256 前16 | 证据点 |
| --- | --- | --- | --- |
| `terminal-session-desktop-01.png` | **1440 x 901**（full-page） | `dbea155290564f8b` | 选择条：「检测到 2 个未关闭的会话，要恢复吗？」+ 两行会话（shell/进程/最近活动）+ 恢复/关闭按钮；状态「发现可恢复的会话」 |
| `terminal-session-desktop-02.png` | **1440 x 900** | `0c3f5c8768c82f3b` | 恢复后：状态「已恢复会话」+ 回放出的屏幕 40 行 + 底栏「空闲 30 分钟无操作会自动回收」+ 选择条已消失 |
| `terminal-session-desktop-03.png` | **1440 x 900** | `152169449ecf8bc0` | 输入历史面板：「2 条 · 最多保留 200 条」+ 两条解码后的命令（16:02:07 echo shot-test-1 / 16:02:08 ls -la /tmp）+ 刷新/清空历史/收起 |
| `terminal-session-mobile-01.png` | **390 x 844** | `62f3b04106e2c743` | 手机端历史面板：横向溢出 **0**；可见按钮 **6/6 = 44px**（测量里唯一 height=0 的是隐藏的「重连」按钮，非触摸目标） |

浏览器态：`page_errors_total=0`；console 6 条全为预期（favicon 404、首帧 401、隔离实例未装 monitor/ssl/discover/site 的概览探测 404）。
> 口径：截图内容以**色标像素 + 拍摄前 DOM 断言（shots.json）**为准（本会话 `read_image` 有同 sha 供旧图的显示侧缓存问题；选择条截图已用新路径裁剪复看确认）。

## 6. 产品定位自评（G-28 三问）

**① 本页解决什么用户问题**：以前刷新一下页面，正在跑的终端就没了——排查到一半的输出、没敲完的命令全要重来，用户只能重开 shell 从头追。现在打开终端页先自动发现存活会话：一个就静默接回原屏幕（连回放窗口一起重建），多个就问「检测到 N 个未关闭的会话，要恢复吗」一键恢复；配合输入历史回滚，「刚才那条命令敲的是什么」也不用翻脑子。

**② 与宝塔/1Panel 的差距**：它们的终端是浏览器里常驻的 xterm 会话（依赖 WebSocket 长连接，断线常要重连脚本），且多数把会话绑在标签页生命周期上；本页走的是「服务端 PTY + 游标回放窗口」模型——**关标签、刷新、断网都不丢会话**，30 分钟空闲才回收，重进自动接回。差距在周边：没有多标签/分屏、没有会话内搜索与字体缩放、没有 tab 补全增强（依赖服务端 shell 本身）。

**③ 当前是「可用」还是「占位」**：**可用（非占位）**——4 个方法 12 项真机断言全过（含回放窗口逐字节比对、clear 真清零），双端截图真实渲染、Runtime 异常 0。边界如实声明：**「关标签后重进」的保活链路是按代码路径推演 + `pagehide` 不关会话的实现验证**，截图里用「重进页面 → 选择条 → 恢复」等价复现；`eof=true` 的会话选择条路径（点「查看」回放最后输出）已实现但未在截图中覆盖（本轮两个会话都存活）。

## 7. G-29 / 提交

**本轮未改动主实例运行态配置**（`.kore-local.yaml`/`.kore-local-state`/`.kore-local-run` 零写入，8787 仅 `ss` 只读探测）；隔离实例 `/tmp/kore-term` 验证完即删。索引为已验签的 `kore-plugins/index`（第 35 把，验签 HTTP 200），本地包 sha 与索引一致走离线 `package_path` 安装，**未开 `allow_unsigned`**。提交：`feat(web): terminal 视图补会话列表/恢复/历史（Gitea #3）`（`web/terminal.js` + 本报告 + 4 张截图，不 push）。
