> 元信息: 2026-11-22T19:40+08:00 · 执行者 web-login-ui 子 agent · 主壳登录界面 + 插件管理 · 隔离实例五步 + 8787 真服务三步全绿 · ≤80 行 · 里程碑: M2

# 主壳登录界面与插件管理（真浏览器）

## 0. 根因与改动面

| 项 | 事实 |
| --- | --- |
| 根因 A | 旧 `web/app.js` 480 行零 login/password —— 主壳没有任何登录入口 |
| 根因 B | `start()` 只用 fetch reject 判降级；401 经 `fetchJson` 抛 `HTTP 401` → 误渲染「后端未连接」 |
| 新增文件不可行（实测） | `web/embed.go` 只 `//go:embed dist/{index.html,app.js,style.css}`，`server.go` 只注册 3 条精确路由，`curl GET /login.js -> 404` → 独立 login.js 方案走不通，必须改现有三件套 |
| 改动 | `web/app.js` 480→978 行；`web/style.css` 255→442 行；`web/index.html` 未改 |
| 未改 | Go 代码、`web/dist`（`make frontend` 生成）、`tests/`、`evals/` |

## 1. 登录流程实现原文（web/app.js）

三态分流：`probeInfo()` 只在**网络层 reject** 返回 `reached:false`，HTTP 状态码不 reject。

```js
if (!info.reached) { state.authed = false; renderOffline(info.error); return; }        // 网络错误/超时 → 后端未连接
if (info.res.status === 401) { state.authed = false; state.info = null; renderLogin(''); return; } // 未登录 → 登录表单
if (!info.res.ok) { /* 其它非 2xx：顶部提示条，不谎称未连接 */ }
state.authed = true; state.info = info.res.data || {}; loadDashboard();
```

登录提交：`POST /api/v1/auth/login`，body `{"password":"..."}`，`credentials:'same-origin'`；成功 → `start()` 重渲染；错误不吞：

```js
if (res.status === 401) showLoginError(errBox, '口令错误，请重试');
else if (res.status === 429) showLoginError(errBox, '尝试过于频繁，已被临时锁定，请稍后再试');
else showLoginError(errBox, '登录失败：' + describeError(res));
```

CSRF：写请求带 `X-Kore-CSRF: <kore_csrf>`，GET 不带；cookie 缺失先 GET `/api/v1/system/info` 触发下发，仍缺则报「缺少 CSRF 令牌…请刷新页面」。
退出：`POST /api/v1/auth/logout`（服务端 CSRF 豁免名单内），成功/失败都回登录页。
局部刷新：`lifecycle()` 用服务端回读的单插件视图 `replaceRow()` 只换该行 `<tr>`，再 `refreshInfo()` 刷常驻数。

## 2. 真浏览器五步（chromium-1248 + 手写 CDP）

### 2.1 隔离实例 18787（新构建 + echo 0.1.1，插件的完整操作链）

| # | 动作 | 断言（实测值） | 截图 |
| --- | --- | --- | --- |
| ① | 打开 `/` | `#kore-password` + 提交按钮存在；`"后端未连接" in body === false` | `login-01-form.png` |
| ② | 错误口令 | 错误区 `口令错误，请重试`；仍在登录页；输入框已清空 | `login-02-wrong-password.png` |
| ③ | 口令 `***` | 系统信息 7 行（0.1.0 / 常驻 0 / 重启 0 / 总数 1 / linux·amd64 / cgroup v2 / 告警 2 条）；echo 行 `stopped`；`kore_csrf` 可读 | `login-03-dashboard.png` |
| ④ | 点「启用」 | 该行 `stopped → ready`；ping 按钮解禁；常驻 `0 → 1` | `login-04-enabled.png` |
| ⑤ | 点「调用 ping」 | 行内 `ping → {"pong":true}`，class `row-note-ok` | `login-05-ping.png` |
| 附 | 点「退出」 | 回登录页；`kore_session` 已清除 | `login-06-logout.png` |
| 手机 | 390×844 | 口令框/登录按钮/插件操作按钮均 **44px**；表单与表格无横向溢出 | `login-07-mobile-form.png`、`login-08-mobile-dashboard.png` |

### 2.2 lead 的 8787 真服务（重启后复验，只读，未装插件、未改其状态库）

| # | 动作 | 断言（实测值） | 截图 |
| --- | --- | --- | --- |
| ① | 打开 `http://127.0.0.1:8787/` | `app.js` 38,494 B 与 `web/dist/app.js` 逐字节同长（新二进制已生效）；登录表单渲染，**未**显示「后端未连接」 | `login-09-8787-login.png` |
| ② | 输入错误口令 | 显示 `口令错误，请重试`，停留登录页 | `login-10-8787-wrong-password.png` |
| ③ | 输入 `***` | 进面板：系统信息 7 行、`kore_csrf` 可读、有「退出」；插件表 0 行并显示「当前没有已安装插件」空态 | `login-11-8787-dashboard.png` |

截图 11 张 PNG 魔数校验通过（1280×700 / 780×1688 DPR2）。驱动脚本为一次性脚本，验证后已删（未落工作区）。

## 3. 门禁退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/app.js` | 0 | 无输出 |
| `make frontend` | 0 | 首屏 gzip **14,628 B** / 307,200 B（余量 292,572）：index 287 + css 2,967 + js 11,374 |
| `make docs-check` | 0 | 6 pass / 0 warn / 0 fail，426 条相对链接可达 |
| `make check` | 0 | 10/10 段全绿，末行 `[OK] 门禁全部通过` |
| CDP 五步（18787） | 0 | `RESULT: PASS` |
| CDP 三步（8787） | 0 | `RESULT: PASS` |

## 4. 未完成项与风险

1. **8787 上无已装插件**：③ 走的是空态分支；④⑤ 的 enable/ping 实证在隔离实例 18787（截图 04/05）。要 8787 也覆盖，需在其 state 里装 echo 后重启——按约束未动 lead 的状态库。
2. **`E_NOTFOUND` 分支未被真实插件覆盖**：无 ping 的插件应显示「该插件不支持 ping 方法」并禁用按钮；本轮环境只装了 echo，该分支仅经代码路径保证。
3. **插件 UI 沙箱桥未回归**：`PluginBridge` 逻辑原样保留（仅周边渲染入口重构），本轮未重跑桥专项（既有证据见 `browser-e2e.md`）。
