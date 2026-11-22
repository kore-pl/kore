> 元信息: 2026-11-22T22:36+08:00 · 执行者 ui-terminal 子 agent · 18890 隔离实例 · 真实 chromium CDP 输入 + 双端截图 · G-28 · 报告 ≤80 行

# Web 终端页面验收（web/terminal.js + shell.js 第 9 项）

## 1. 环境与隔离
- 实例：`127.0.0.1:18890`，配置 `/tmp/kore-term-verify/config.yaml`（独立 state/run/log，自生成口令）。
- 插件：terminal 0.1.0（`package_path` 本地包安装，ready/pid 2816541）+ site 0.1.0（ready）+ file 0.1.0 / cron 0.2.0（enabled，lazy stopped）。
- 临时索引 `store.allow_unsigned: true` 仅用于本地包验签绕行（隔离环境显式配置，未改产品默认）。
- **8787 未触碰**：PID 2557675 全程未重启，RSS 12.7 MiB。

## 2. 最小 ANSI 渲染（零依赖，不引 xterm.js）
- 单字符状态机：普通 / ESC / CSI / OSC / OSC 内 ESC；CSI 收参数至终止字节 `0x40–0x7e`，OSC 吃到 BEL 或 `ESC \`。
- 必须项：过滤 `\x1b[...` / `\x1b]...`；保留可打印字符、`\r`、`\n`、`\b`；`\r` 归零光标实现覆盖，`\b` 左移并删除前一 cell（bash 行编辑正确）。
- SGR：`1m` 粗体、`0m` 复位、`30–37` / `90–97` 映射 CSS class（span 包裹，亮色与常规同色）；`39m` / `22m` 复位。
- 简单清屏：`2J/3J` 清屏、`0J` 清到屏幕末、`K` 清行；`H/f` 绝对定位、滚动区域、鼠标报告**明确不做**（忽略）。
- 安全：屏幕内容全部 `textContent`，span 只由本文件生成的 class 包裹；`Byte→base64` 分块编码，读取用 `TextDecoder({stream:true})` 容忍截断的多字节 UTF-8。

## 3. 输入映射（textarea keydown → 字节 → base64 → terminal.write）
| 按键 | 字节 | 按键 | 字节 |
| --- | --- | --- | --- |
| Enter | `\r` | Backspace | `\x7f` |
| Tab | `\t` | Escape | `\x1b` |
| ↑ / ↓ / ← / → | `\x1b[A/B/C/D` | Home / End | `\x1b[H` / `\x1b[F` |
| Insert / Delete | `\x1b[2~` / `\x1b[3~` | PgUp / PgDn | `\x1b[5~` / `\x1b[6~` |
| Ctrl+字母（无 Shift） | `0x01–0x1a`（Ctrl+C=`\x03`） | Ctrl+[ | `\x1b` |
- 普通字符与 IME 合成走 `input` 事件，读值后清空 textarea；粘贴的 `\r\n`/`\n` 归一为 `\r`；`isComposing` 期间不发送。

## 4. 轮询、尺寸与清理
- `setInterval` 80ms 轮询 `terminal.read`（`max_bytes=262144`），`inFlight` 防重入；空串跳过渲染，仅在有新数据时重绘。
- `ResizeObserver` → 300ms 防抖 → `terminal.resize`（`cols=floor(w/8)`、`rows=floor(h/18)`，20–300 × 6–120）。
- `destroy()`（shell 切视图/卸载时调用）：清 interval、清防抖、断开观察器、移除监听，并 `terminal.close` 关会话（防 4 会话上限被泄漏占满）。
- 清理实测：切走 1.5s 后读计数窗口 A=53、再 1s 窗口 B=53（`readsStopped=true`）；活动定时器 1→0（`intervalsDropped=true`）；全流程 created=4 / cleared=4，无残留定时器。切回终端自动新建会话并恢复轮询（`termReads` 从 61 继续增长）。

## 5. 真机四步 + 双端截图（每张截图前后断言：含「终端」字样、无登录表单；7 张 sha 两两不重复）
| # | 文件 | 尺寸 | sha256 前12 | 断言 / 证据 |
| --- | --- | --- | --- | --- |
| 1 | `screenshots/terminal-desktop-01-echo.png` | 1440×900 | d729acaabd6d | `echo hello-terminal` → 屏幕含输出；无登录表单 |
| 2 | `screenshots/terminal-desktop-02-pwd.png` | 1440×900 | 8cf616b0cdea | `pwd` → `/tmp/kore-term-verify/state/plugins/terminal` |
| 3 | `screenshots/terminal-desktop-03-ls.png` | 1440×900 | 98e9deefea4a | `ls --color=auto` → 9 个着色 span，无 `[0m`/`\x1b[` 残留 |
| 4 | `screenshots/terminal-desktop-04-new-session.png` | 1440×900 | 7c417af6d9c1 | 新建会话：id `t-c828…` → `t-dd4f…`，`echo new-session-ok` 有输出 |
| 5 | `screenshots/terminal-desktop-05-closed.png` | 1440×900 | b3e909c17e50 | 关闭后状态「已关闭」、重连按钮可见；点击重连回「已连接」 |
| 6 | `screenshots/terminal-mobile-01-ls.png` | 390×844 | d667b27a3387 | 移动端满宽、底部 tab「更多」内第 9 项终端；`ls -a` 正常 |
| 7 | `screenshots/terminal-mobile-02-closed.png` | 390×844 | 20c4012cabf8 | 移动端关闭态 + 重连按钮 |
- console error 0、uncaught 0；`visualViewport` 处理键盘弹出（输出滚到输入行附近），不做复杂适配。
- 已知外观问题（非功能）：`create` 返回早于登录 shell 首屏 prompt，首条输入可能先于 prompt 渲染；不做假 prompt 修补。

## 6. 首屏与门禁（退出码均为 0）
- `node --check web/terminal.js` → 0（≤320 行：320 行）。
- `make frontend`：首屏 4 件套 gzip **32,041 / 307,200 字节**（index 659 + style 11,608 + app 14,553 + shell 5,221）；terminal.js 不计首屏。
- `make docs-check`：6 pass / 0 warn / 0 fail。
- `make check`：10/10 段全绿（`[OK] 门禁全部通过`）。

## 7. G-28 产品定位自评
1. 解决什么用户问题：不离开浏览器完成服务器排障——真实 PTY + 登录 shell，而不是命令包装器；告别「复制命令到 SSH 再贴结果」。
2. 与宝塔 / 1Panel 差距：同类面板多以 xterm.js 全功能终端交付；本页是**最小 ANSI 子集**（无绝对定位、滚动区域、鼠标报告），复杂 TUI（vim/htop）显示会降级；优势是零依赖（不新增首屏与 CDN 负担）与内核同源会话管理。
3. 当前状态：**可用**（生产级插件契约 + 真机四步 + 输入/尺寸/清理闭环）；不定位为占位页。

## 8. 改动文件
`web/terminal.js`（新增）、`web/shell.js`（第 9 项 + 懒加载）、`web/style.css`（终端样式 + 2 个色变量）、`web/embed.go`、`Makefile`、`docs/FRONTEND.md`、`QUICKSTART.md`、本报告、7 张截图。
