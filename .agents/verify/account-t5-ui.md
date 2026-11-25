> 状态：DONE · 归属：account-ui（implementer，ADR-0057 T5 登录页 UI 打磨）· 日期：2026-11-25 · 工作区：/home/pt/Work/GolandProjects/kore-pl/kore
> 纪律：commit 不 push、不触发 CI、不碰主实例运行态；一次性脚本/二进制全在工作区 `.tmp-t5/`，验证后即删；报告与日志无明文口令。
> 写域：`web/app.js`（登录视图段 + showLoginError）、`web/style.css`（登录字段/验证码样式段）、本报告与 `.agents/verify/screenshots/login-t5-*.png`。未碰 `web/settings.js` / `web/dist/**`（dist 仅由 `make frontend` 重建为 gitignored 产物）/ docs 与 `.agents/LOG/**`（account-docs 写域）。

# ADR-0057 T5 · 登录页 UI 打磨验收报告

## 一句话结论

**三字段的分组、标签、一行帮助与「已自动检测」标注齐备；验证码触发时的白话引导 + 图片/按钮双通道刷新齐备；429 延时提示带逐秒倒计时；390px 下三字段单列不挤压、触摸目标实测 44–48px、验证码可点可读。PC/手机双端截图 + G-28 三问齐全，全部门禁 exit 0，隔离实例真浏览器 4 类状态（默认/验证码/刷新/倒计时/登录成功）实测通过。**

## 1. 实现要点（path:line 锚点）

| 项 | 落点 | 口径 |
| --- | --- | --- |
| 三字段分组与标签 | `web/app.js:585` `loginField()`、`:601–646` renderLogin | 账号 → 密码 →（按需）验证码（认证器）/验证码（图片）；每个字段中文标签 + 一行白话帮助（USABILITY 原则④），不靠 placeholder 当标签 |
| 自动检测标注 | `web/app.js:606` `loginField(..., true)`、`:239` `.login-auto-tag` | 账号标签右侧可见徽标「已自动检测」，非仅颜色编码（FRONTEND 状态双通道） |
| 验证码触发引导 | `web/app.js:682–686` `#kore-captcha-notice`、`:705–713` showCaptcha | 触发后展开「为确认是您本人操作，请先填写下方图片验证码，再点『登录』。」→ 登录按钮之前；错误文案「密码错误，请输入右侧验证码」由服务端返回并原样呈现 |
| 点击刷新验证码 | `web/app.js:647–671`、`style.css:197–207` | 图片与「换一张」按钮都可刷新；图片 role=button/tabIndex=0 + Enter/空格同效；图片实测 150×48px、按钮 65×44px，均 ≥44px 触摸目标 |
| 延时白话倒计时 | `web/app.js:551–577` `showLoginError(..., retryAfter)`、`:762–768` 429 分支 | 「请 N 秒后再试」按 Retry-After 逐秒递减，到 0 改「等待结束，请再试一次」；单一 interval，重复报错先清旧计时器，不泄露 E_RATELIMIT 等内部码 |
| 隐藏态修复（真机发现） | `web/style.css:235` `.login-field[hidden],.login-captcha-notice[hidden]{display:none}` | 首轮真机发现 `.login-field{display:flex}` 覆盖 UA `[hidden]` 规则导致 2 个验证码框在默认态就显示；补显式 hidden 规则后复测隐藏态正确（此为本卡自测发现并自修的真实 bug） |
| 文案口径 | `web/app.js:619–646, 686, 738` | 产品展示一律「Kore / 密码」，代码标识保持 `kore` 小写、字段名 `password` 不变；底层 API 契约零改动 |

## 2. 门禁证据（命令 + 退出码）

| 命令 | 结果 |
| --- | --- |
| `node --check web/app.js` | exit **0** |
| `make frontend` | exit **0**：首屏 87258 B ≤ 307200 B（300 KiB），余量 219942 B；无漂移告警（≤ 87341）；i18n 增量 2941 B ≤ 3072 B；dist 无 map/字体 |
| `bash scripts/secret-check.sh` | exit **0**（0 FAIL，占位合规） |
| `bash scripts/docs-check.sh` | exit **0**：门禁通过（1 WARN 不阻断）。首跑时 exit 1，唯一 FAIL 是 account-docs 在写 `docs/DECISIONS/0057-*.md` during-flight 的相对链接 `../../.agents/verify/account-t7-docs.md` 尚不存在；已 send_message 通知对方，待其报告落盘后复跑转绿，**我未改对方写域** |
| `GOWORK=off GOCACHE=<workspace>/.tmp-t5/gocache go build -trimpath -buildvcs=false -ldflags='-s -w' -o .tmp-t5/kored ./cmd/kored` | exit **0**（隔离实例二进制，不覆盖 `bin/kored`） |

## 3. 隔离实例真浏览器验证（G-29）

- 端口 **127.0.0.1:18891**（主实例 8787 未碰）；独立二进制 `.tmp-t5/kored` + 独立 `--config .tmp-t5/inst/config.yaml` + state/run/log 全落工作区 `.tmp-t5/inst/`（每次 bash 调用是独立 sandbox，/tmp 不跨调用持久，故用工作区临时目录，验证后删除）。
- 本轮**未改动主实例运行态配置**（`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 均未触碰）。隔离实例由托管后台 job 运行，完结已 job_kill；`.tmp-t5/` 已整体删除。
- 真浏览器 = Playwright（chromium headless，缓存 `~/.cache/pw-runner`），两种 viewport 各开独立 context，输出 `browser.log` / `results.json`（临时，已删）。

| 检查项 | 实测 |
| --- | --- |
| 默认态 labels | `["账号","密码","验证码（认证器）","验证码（图片）"]`；帮助文本逐字段存在；账号值 `admin`；`已自动检测` 可见；`#kore-captcha-field` `hidden=true`（修复后） |
| 首屏尺寸/溢出 | PC docW=winW=1440；手机 docW=winW=390（无横向溢出）；卡片手机 358px 宽、x=16..374 全在视口内 |
| 触摸目标 | 账号/密码/登录按钮实测 44px 高；验证码图 150×48、换一张 65×44；验证码答案框 44px（手机 308px 宽） |
| 验证码触发 | 错密码提交后错误文案「密码错误，请输入右侧验证码」；验证码区展开；引导「为确认是您本人操作…再点『登录』。」可见；图片 `data:image/png` 加载成功，title 含加法题 |
| 点击刷新 | 点击图片后 src 变化（changed=true）；刷新后重读 title 算答案 + 正确密码提交 → `authed=true`（PC + 手机均登录成功，端到端闭环） |
| 延时倒计时 | 连续错密码触发第 3 次返回「请 2 秒后再试」；1.2s 后文本变为「等待结束，请再试一次」（changed=true），逐秒递减生效 |
| JS 错误 | 两 context `pageerror` 均为 `[]` |

## 4. G-28 双端截图与产品定位自评

| 项 | 证据 |
| --- | --- |
| PC 默认态 | [login-t5-desktop-01.png](screenshots/login-t5-desktop-01.png) — `file`: PNG 1440×900 |
| 手机默认态 | [login-t5-mobile-01.png](screenshots/login-t5-mobile-01.png) — `file`: PNG 390×844 |
| PC 验证码态 | [login-t5-captcha-desktop-01.png](screenshots/login-t5-captcha-desktop-01.png) — PNG 1440×900 |
| 手机验证码态 | [login-t5-captcha-mobile-01.png](screenshots/login-t5-captcha-mobile-01.png) — PNG 390×844 |
| 延时提示 | [login-t5-countdown-desktop-01.png](screenshots/login-t5-countdown-desktop-01.png) — PNG 1440×900 |
| 截图方式 | Playwright headless 隔离实例 127.0.0.1:18891 真实渲染；PC/手机来自独立 context 的独立 viewport，非同图缩放；已用 `read_image` 逐张目视确认布局（首轮发现隐藏态 bug 并修复后重拍） |

**G-28 三问（产品定位自评）**：

1. **本页解决什么用户问题**：T3/T4 把「账号/口令/验证码」三个要素都放进来了，但挤成一列、没有引导，用户看不清三者关系。本卡把三个要素做成统一的字段卡（中文标签 + 一行帮助 + 预填账号的「已自动检测」徽标），验证码触发时给出「为什么多了一步、下一步点哪里」的显式引导，429 延时给白话倒计时——小白打开页面按顺序填就能登录，不用猜。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔 / 1Panel 有多账号、第三方 CAPTCHA、找回与审计后台；Kore 按 G-11/ADR-0057 只做单账号 `admin` + 本地点阵 PNG 验证码，差距在能力面（无多用户/短信/第三方 CAPTCHA），这是明确非目标而非本卡缺陷。当前登录页在「清晰分组 + 白话引导 + 双端适配」上已达到同类面板的基本水准，且零外部依赖、无联网。
3. **当前「可用」还是「占位」**：**可用**。默认态/验证码态/刷新/倒计时/完整登录闭环全部在隔离实例真浏览器实测通过；两个隐藏字段被 CSS 覆盖误显示的缺陷已在真机自测中发现并修复，最终截图与断言均基于修复后的产物。

## 5. 写域协商与收尾

| 项 | 结论 |
| --- | --- |
| account-docs | 开工即确认：我不碰 `docs/**` / `.agents/LOG/**`；首轮 docs-check FAIL 由其 during-flight 断链引起，已消息通知，对方报告落盘后复跑 exit 0 |
| account-password | 开工即确认：我不碰 `web/settings.js`（含 `openPasswordDialog` body），提示位现成在 `app.js:passwordHintBar`，本卡无需改；其改 settings.js 不受影响 |
| 临时资产 | `.tmp-t5/`（隔离二进制、config、独立 state/run/log、gen.out、drive.mjs、results.json、browser.log、gocache）验证后整体删除；隔离实例 job 已 kill；工作区无一次性脚本残留 |
| G-30 | 报告与日志无任何明文口令；隔离实例口令只用一次、未写入任何提交文件；secret-check exit 0 |

**一句话：三字段分组与验证码/延时引导的 UI 打磨已落地，门禁全绿、隔离实例双端真机与端到端登录闭环全部通过，G-28 截图与三问齐全。**
