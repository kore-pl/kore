# R25 · 终端页三项能力补齐（文件传输 / 快捷命令 / 会话体验）

日期：2026-11-25 11:58–12:30（Asia/Shanghai）｜Owner：`feat-terminal-ux`｜类型：功能实现（非验证类）
写域：`kore/web/terminal.js`（+ 本报告与 9 张 G-28 截图）。**未改 kore 后端、未改 kore-plugin-terminal 插件、未新增 web/*.js**（故 Makefile `WEB_SRC_FILES` 与 `web/embed.go` 无需登记项）。

## 0. 结论先行

用户可见的三块缺口已补齐，全部在前端落地、真机（隔离实例 + 真实 Chromium + 真实点击/键入）走通：

| 能力 | 状态 | 用户可见行为 |
| --- | --- | --- |
| 文件传输（终端页内） | **可用** | 点「传文件」选文件、或把文件直接拖到终端上即上传；大文件分块 + **进度条百分比 + 已传/总字节**；失败可「从断点续传」；按路径从服务器下载（≤4 MiB） |
| 快捷命令 | **可用** | 内置 4 条（看磁盘 / 看内存 / 看服务状态 / 看端口），自定义片段命名保存（本机浏览器），一键「执行」发到当前会话或「填入」输入框；删除两段式确认 |
| 会话体验 | **可用** | 回看缓冲搜索（`Ctrl+Shift+F`，命中行列表可点击跳转并高亮）；右键粘贴、选中即复制（可开关，存本机）；断线重连保留原状态机，登录态失效改为明确「可重连」提示，空闲回收倒计时文案改为「再空闲 N 分钟」 |

顺带修掉两个**既有渲染缺陷**（本次能力会放大它们，属同文件必要修复）：

1. `Term.resize` 变矮时把顶部行直接 `grid.shift()` 丢弃 → 开一次面板/缩一次窗口就把上面的输出吃掉（搜索也搜不到）。改为推进滚动历史 `kore/web/terminal.js:521`。
2. 全量重建分支只 append 不清旧节点 → resize / 新 Term 之后屏幕出现重复行、`term.text()`（复制/搜索的真源）与看到的屏幕不一致。改为重建前清空 `kore/web/terminal.js:293`。

## 1. 代码事实（依据 + 行号）

- 能力总述注释：`kore/web/terminal.js:17-22`。
- 第二排工具条 + 四个面板宿主：`web/terminal.js:670-690`；面板互斥开关 `openOnly/closePanels` 见 `web/terminal.js:1176-1190`。
- **文件传输**：`renderXfer` `:1488`、`doUpload` `:1377`、`chunkLoop` `:1314`、`uploadFile` `:1355`、`resumeUpload` `:1420`、`downloadPath` `:1466`、`saveBlob` `:1452`、`onDrop` `:1558`、失败白话 `xferHint` `:1339`。
- **快捷命令**：`renderSnips` `:1203`、`saveSnippet` `:1230`、`snipRow` `:1245`、`runSnippet` `:1180`；内置 4 条常量见 `web/terminal.js:651-657`。
- **搜索回看**：`collectHits` `:1575`、`jumpHit` `:1591`、`renderSearch` `:1614`、`toggleSearch`（`Ctrl+Shift+F` 在 `onKey` 顶部拦截 `:1790`）。
- **复制粘贴偏好**：`readClipboard` `:1712`、`onContextMenu` `:1723`、`onSelectCopy` `:1728`、`copyText` `:1697`、设置面板 `renderOpt` `:1736`。
- **会话提示**：登录态失效 `:829`、会话被回收 `:791`、空闲倒计时 `:735`。
- **路径口径**：file 插件只接受「配置根目录内的相对路径」（`kore-plugin-file/internal/fileop/path.go:111-137`，默认根 `/` 见 `internal/fileop/root.go:15`），因此前端把用户习惯的 `/tmp` 归一成 `tmp`（`toPluginPath` `web/terminal.js:1258`），默认根下二者等价；面板里有中文说明。
- **调用契约**：上传走 file 插件既有方法 `file.upload`（≤4 MiB 一次传完）/ `file.uploadChunk` + `file.uploadStatus`（分块与断点，契约见 `kore-plugin-file/internal/fileop/upload_chunk.go:44-120`）/ `file.download` + `file.stat`；终端的 PTY 通道只走文本，**不新增任何后端方法**。终端侧仍只用原 9 个方法（`kore-plugin-terminal/methods.go:24-25`）。

## 2. 真机验证（隔离实例，G-29 主实例零改动）

隔离实例：`git archive/工作树拷贝 → /tmp 之外的独立目录` + 独立 `--config`（state/run/log 全在隔离目录）+ 端口 **18895**，安装本仓 dist 的 `terminal 0.2.1` 与 `file 0.3.5`（`kored install --package`，exit 0）。浏览器：`~/.cache/ms-playwright/chromium_headless_shell-1255`，CDP 真实鼠标/键盘事件，登录走真实 `POST /api/v1/auth/login`（口令 `***`，仅隔离实例，报告不留明文）。

```text
$ node --check web/terminal.js                                   # exit 0
$ go test -timeout 200s ./...                                    # exit 0（根 module 全绿）
$ bash scripts/frontend-check.sh                                 # exit 0
  [OK] 首屏体积达标：81528 字节 ≤ 307200 字节，余量 225672 字节
  [OK] i18n 增量达标：2922 字节 ≤ 3072 字节
$ curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:18895/-/healthz   # 200
```

浏览器侧断言（`evidence.json`，均为页面内真实状态读取）：

```text
tools row           = 快捷命令|传文件|搜索回看|体验设置
snippet saved       = [{"name":"磁盘前十","cmd":"df -h | head -n 5"}]（真实键入 → 点「保存片段」）
snippet rows        = 5（4 内置 + 1 自定义）
snippet exec        = 已发送到终端：df -h | head -n 5（执行后 screen 出现「文件系统/大小/已用」真实 df 输出）
upload small        = 完成，已上传到 /…/upl/upload-demo.txt
upload big (96 MiB) = 中途抓到 12% 进度截图 → 完成；与源文件 sha256 逐字相同
  a5f622cf… upload-demo.txt（源=目标）   c0e4c80c… upload-big.bin（源=目标）
download            = 已下载 upload-demo.txt（37 B）；落盘 sha256 = a5f622cf…（与源一致）
search (Ctrl+Shift+F) = 找到 1 行；点命中行 → 「第 19 行：… df -h | head -n 5」，.term-hit 高亮 1 个
select-copy ON      = 已复制选中内容 7 字符；剪贴板实测 = "pt@U-PT"
right-paste ON      = 已粘贴 19 字符到终端；屏幕出现 echo KORE-R25-PASTE（appeared=true）
mobile 390×844      = scrollWidth 390（无横向溢出）、4 个工具按钮高度均 44px、输入框宽 390
```

**G-29**：全程只在隔离实例（18895）操作；未改 `/home/pt/Work/GolandProjects/kore-pl/kore` 的主配置 `.kore-local.yaml`、未动 `.kore-local-state/`、未覆盖 `bin/kored`、未重启主实例 8787。隔离目录用完已删除。

## 3. G-28 双端截图（9 张，`.agents/verify/screenshots/`）

| 场景 | PC 1440×900 | 手机 390×844 | 说明 |
| --- | --- | --- | --- |
| 快捷命令 | `terminal-snippets-desktop-1125.png` | `terminal-snippets-mobile-1125.png` | 自定义片段已保存 + 内置 4 条 + 执行后的真实 df 输出 |
| 文件传输 | `terminal-transfer-desktop-1125.png` | `terminal-transfer-mobile-1125.png` | 两个文件均为「完成」，含 96 MiB 大文件 |
| 上传进度 | `terminal-transfer-progress-desktop-1125.png` | —（同一状态手机端见上） | 96 MiB 传到 12% 时的进度条与「已上传 X / Y」 |
| 搜索回看 | `terminal-search-desktop-1125.png` | `terminal-search-mobile-1125.png` | 命中 1 行 + 命中行点击跳转、终端行高亮 |
| 体验设置 | `terminal-ux-desktop-1125.png` | `terminal-ux-mobile-1125.png` | 右键粘贴 / 选中即复制两个开关（均已开启） |

`file` 实测：PC 9 张中 5 张 1440×900、手机 4 张 390×844，全部精确匹配；`md5sum` 9 张全异（distinct=9），无同图缩放。

## 4. 产品定位自评（G-28 第三项）

1. **本页解决什么问题**：在终端里排障时最常被打断的三件事——传个日志/配置上去、把一长串命令再敲一遍、翻屏找刚才那行报错——现在都不用离开终端页，也不用记路径参数。
2. **与宝塔 / 1Panel 同类功能差距**：宝塔 / 1Panel 的 Web 终端通常是"纯终端 + 上传按钮"，命令片段与回看搜索多数没有；本页把「片段（含内置运维三条）+ 上传进度/断点续传 + 回看搜索定位」放在同一排工具栏，且小文件一次传完、大文件分块可续传，**功能面已对齐或略多**。差距仍在：不支持目录级批量传输、下载单次 ≤4 MiB（受内核单帧上限约束）、无 SFTP 双栏。
3. **当前是"可用"还是"占位"**：**可用**——上传/下载/续传/搜索/开关都经真机点击与真实字节校验（sha256 一致）；截图中的「完成」「找到 1 行」「已复制 7 字符」都是真实运行态，不是占位文案。

## 5. 已知边界（如实标注，未验证项不写成通过）

- **真机软键盘**：无头浏览器无法弹软键盘；本轮只验证到 390px 布局无横向溢出、工具按钮 44px、输入层宽度铺满。原有 `visualViewport` 逻辑未改动。
- **剪贴板权限**：右键粘贴依赖 `navigator.clipboard.readText()`；浏览器拒绝时页面给的是明确指引（「改用 Ctrl+Shift+V」），此降级路径只做了代码审查，未在真实拒绝场景下点过。
- **下载上限**：单次 4 MiB 是受内核单帧 8 MiB（base64 膨胀）约束的既有能力边界，超出时页面给「先压缩/去文件页」的下一步，不是静默失败。
- **file 插件根目录收窄**（`KORE_FILE_ROOT=/var/www` 之类）：面板按「根目录内相对路径」口径工作，提示文案已说明；本轮隔离实例用默认根 `/` 验证，收窄场景未实测。
- 未做：目录级批量上传、拖拽排序、片段导入导出。
