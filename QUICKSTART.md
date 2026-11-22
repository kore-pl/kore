# kore 快速开始：用浏览器访问面板

> 面向：第一次运行 kored、想直接在浏览器打开主壳面板的用户。
> 平台：Linux（Tier A）。默认只监听本机回环，不暴露到网络。

## 1. 构建

```bash
cd /path/to/kore
make build          # 产出 bin/kored（CGO_ENABLED=0 单二进制，已内嵌 web/dist 三件套）
```

`make build` 使用仓库内已就绪的 `web/dist`（`index.html` / `app.js` / `style.css`）。若要重新生成前端产物，先跑 `make frontend`（会卡首屏 gzip ≤ 300 KiB）再 `make build`。缺 `web/dist` 时 `go build` 直接失败——这是门禁，不是 bug。

> **换了索引验签公钥就必须重启 kored**：公钥编在二进制里，旧进程仍用旧公钥验新签名 → 商店全部 401。完整七步发布流程见 [docs/RUNBOOK.md](docs/RUNBOOK.md) §1。

## 2. 准备配置（设置管理员口令 + 打开 TCP 监听）

kored 默认**只开 UDS**（`server.addr` 为空），浏览器无法直连。要让浏览器访问，必须在配置文件里显式写回环地址；MVP 只允许 `127.0.0.1:<port>`，写 `0.0.0.0` 会被配置校验拒绝。

先生成管理员口令哈希（`mypassword` 换成你自己的口令，命令不落盘任何临时文件）：

```bash
python3 -c 'import hashlib,base64,os;s=os.urandom(16);h=hashlib.pbkdf2_hmac("sha256",b"mypassword",s,600000,32);print("pbkdf2-sha256$600000$"+base64.b64encode(s).decode()+"$"+base64.b64encode(h).decode())'
```

把输出填进配置文件。下面示例用隔离目录，不碰系统目录（`/etc/kore`、`/var/lib/kore`）：

```yaml
# ./kore-quickstart.yaml
server:
  addr: "127.0.0.1:8787"        # ← 浏览器访问入口；空字符串则只开 UDS
auth:
  admin_password_hash: "pbkdf2-sha256$600000$<上一步的输出>"   # 填完整串，含三段 $ 分隔
  session_ttl: "12h"
  cookie_secure: "auto"
paths:
  state_dir: "./kore-state"     # 隔离状态目录，首次启动自动创建
  run_dir:   "./kore-run"
  log_dir:   "./kore-log"
```

> 若 `admin_password_hash` 留空，任何口令都无法登录（`Verify` 对空哈希一律返回失败），面板能打开但进不去。请务必填好。

## 3. 启动

```bash
./bin/kored serve --config ./kore-quickstart.yaml
```

启动日志出现 `kore ready ... addr=127.0.0.1:8787` 即监听就绪。

## 4. 浏览器访问

打开确切地址：

```
http://127.0.0.1:8787/
```

这是 `kored` 自己托管的面板主壳（`web/dist` 二十三个产物经 `web/embed.go` 编进二进制）。路由只有两条：`GET /` 提供 `index.html`，`GET /assets/{file}` 提供其余静态资源（按后缀决定 Content-Type，只认单段文件名与 `.js/.css/.html` 后缀）。首屏加载四件套（`index.html` + `style.css` + `app.js` + `shell.js`），`store.js` / `files.js` / `sites.js` / `tasks.js` / `monitor.js` / `settings.js` / `terminal.js` / `db.js` / `logs.js` / `process.js` / `ssl.js` / `backups.js` / `redis.js` / `firewall.js` 十四个视图模块在切到对应视图时才按需注入（终端 / 数据库 / 日志 / 进程 / SSL / 备份 / Redis / 防火墙由 `shell.js` 内置路由懒加载）；`files-l2.js` / `site-edit.js` / `db-l2.js` 只在文件/站点/数据库页首次执行 L2 操作时注入，`config-panel.js` 只在日志/备份页点「设置」时注入，`monitor-cards.js` 只在进入监控页时注入——首屏体积不随视图数与能力数增长。其它路径（如 `/nonexistent`）返回 404，没有 SPA 兜底。`/-/healthz` 仍可供探针使用（返回 200 `{"status":"ok"}`）。

## 5. 首次登录与 CSRF

1. 面板壳加载后，未登录时所有 `/api/v1/*` 请求返回 401；页面会引导到登录。
2. 登录走 `POST /api/v1/auth/login`，请求体 `{"password":"你的明文口令"}`。成功会下发两个 cookie：`kore_session`（HttpOnly 会话）和 `kore_csrf`（双提交 token）。
3. 之后的写请求（POST/PUT/DELETE 等）必须带请求头 `X-Kore-CSRF: <kore_csrf 的值>`，且浏览器同时携带 `kore_csrf` cookie；两者不一致或缺任一，返回 401 `CSRF 校验失败`。GET 请求无需 CSRF 头。
4. 口令错误 5 次（60 秒窗口内）会锁 300 秒，别硬试。

> 安全边界：`/` 与 `/assets/` 前缀在鉴权白名单内（面板静态壳无敏感数据，未登录也能加载登录界面）；白名单只认前缀一条、不枚举文件名。所有管理 API 仍强制会话校验，不因静态托管削弱。不要把 `server.addr` 改成 `0.0.0.0` 或把 `cookie_secure` 关掉暴露到不安全网络。

## 停止

在运行 kored 的终端按 Ctrl-C，进程会优雅关闭并释放端口与状态库锁。
