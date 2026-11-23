# Kore 快速开始：用浏览器访问面板

> 面向：第一次运行 kored、想直接在浏览器打开主壳面板的用户。
> 平台：Linux（Tier A）。默认只监听本机回环，不暴露到网络。

## 1. 构建

```bash
cd /path/to/kore
make build          # 产出 bin/kored（CGO_ENABLED=0 单二进制，已内嵌 web/dist 三件套）
```

`make build` 使用仓库内已就绪的 `web/dist`（`index.html` / `app.js` / `style.css`）。若要重新生成前端产物，先跑 `make frontend`（会卡首屏 gzip ≤ 300 KiB）再 `make build`。缺 `web/dist` 时 `go build` 直接失败——这是门禁，不是 bug。

> **换了索引验签公钥就必须重启 kored**：公钥编在二进制里，旧进程仍用旧公钥验新签名 → 商店全部 401。完整七步发布流程见 [docs/RUNBOOK.md](docs/RUNBOOK.md) §1。

## 2. 账号与凭据：面板必须登录，登录后操作免密（含 root）

kore 是**单管理员、Web 面板管理**的产品（[AGENTS.md](AGENTS.md) G-11：不做多用户 RBAC）。**登录是 kore 自己的 Web 登录体系**，凭据只有 `auth.admin_password_hash` 一个（无用户名）。**「操作免密」不是「免登录」**：

| 场景 | 未登录 | 登录一次之后 |
| --- | --- | --- |
| 本机浏览器（`127.0.0.1:8787`） | **401 + 登录页** | 所有操作免密（含 root 特权动作），7 天滑动会话 |
| 本机 CLI（UDS `/run/kore/kore.sock`） | **401** | 复用同一会话 cookie，免密 |
| **其他机器访问面板** | **401** | 同一套 Web 登录（口令只校验一次） |

> 登录一次后，日常使用与 root 特权操作都**不再要求任何密码**（root 动作由以 root 运行的内核完成，见 ADR-0042）；但「不登录就能操作管理 API」已被移除（ADR-0043）——本机 UDS / loopback 与远程同口径，没有会话一律 401。

### 2.1 只有要从其他机器访问时才设置口令（可选）

**没设口令时远程登录直接不可用**（`auth.Manager.Verify` 在哈希为空时一律拒绝，不会拿空串比对通过）；本机访问不受影响。需要远程访问面板时，一条命令生成远程凭据——**这里的 `--config` 必须和 §3 启动时完全一致**：

```bash
./bin/kored admin-password --generate --config ./kore-quickstart.yaml
```

kored 自己生成 24 字符随机口令（crypto/rand），**只显示这一次**，同时把 PBKDF2 哈希原子写进 `--config` 指向的那个文件（打印的是它的绝对路径）：

```
管理员口令（只显示这一次，请立即保存）：Xy7k...（24 字符）

已将口令哈希写入 /绝对路径/kore-quickstart.yaml（权限 0600）
提示：哈希写入后需重启 kored 才生效（运行中的进程只在启动时读取口令哈希）；重启会踢掉旧会话；忘记口令可再执行 `kored admin-password --set` 重置。
```

- **路径铁律**：`admin-password` 与 `serve` 必须用同一个 `--config`（或都不用，走默认 `<install>/config/config.yaml`，设了 `KORE_HOME` 就是 `$KORE_HOME/config/config.yaml`）。两边不一致 = 口令写进 A 文件、serve 读 B 文件，**远程登录永远 401**；两个命令的解析优先级一致：`KORE_CONFIG` 环境变量 > `--config` > profile 默认路径；相对路径按**配置文件所在目录**解析（与启动目录无关），仍建议写绝对路径。
- 忘记自己用了哪个路径时，看命令打印的绝对路径（`admin-password` 与 `serve` 启动日志里的配置路径是同一个）。
- 写入走「临时文件 + fsync + rename」，权限固定 **0600**；口令与哈希**不进日志**。
- **生效时机**：`admin-password` 只改配置文件；运行中的 kored 只在启动时读取口令哈希（SIGHUP 热更只更新配置快照，不替换已装载的口令），所以设完口令要**重启 kored**，重启会同时踢掉旧会话。
- 命令就地改写 `auth.admin_password_hash`，保留文件里其它键、注释与顺序。已有哈希的实例升级后行为不变。

### 2.2 自己指定口令

```bash
./bin/kored admin-password --set --config ./kore-quickstart.yaml   # 读两次、输入不回显；不一致直接报错且不写文件
```

非交互环境（CI / 容器）没有终端可交互，必须走管道：

```bash
printf '%s' "$KORE_ADMIN_PW" | ./bin/kored admin-password --set --stdin --config ./kore-quickstart.yaml
```

### 2.3 打开 TCP 监听

kored 默认**只开 UDS**（`server.addr` 为空）。本机 CLI 走 UDS 即可；要让**本机浏览器**访问，必须在配置文件里显式写回环地址；MVP 只允许 `127.0.0.1:<port>`，写 `0.0.0.0` 会被配置校验拒绝：

```yaml
# ./kore-quickstart.yaml
server:
  addr: "127.0.0.1:8787"        # ← 浏览器访问入口；空字符串则只开 UDS
auth:
  session_ttl: "12h"
  cookie_secure: "auto"
paths:
  state_dir: "./kore-state"     # 隔离状态目录，首次启动自动创建
  run_dir:   "./kore-run"
  log_dir:   "./kore-log"
```

> **`state_dir` 是显式覆盖，不是默认值**：本示例故意把状态目录改到 `./kore-state`；`RUNBOOK`/`OPERATIONS` 里写的 `data/`（portable `<install>/data`、fhs `/var/lib/kore`）才是**默认值**。CLI 与 serve 必须用同一个 `--config`——混用两种路径就会出现两个 `state.db`（事故原文见 [docs/RUNBOOK.md](docs/RUNBOOK.md) §7.2.1）。

> 想先写 yaml 再生成口令也可以：`admin-password --config ./kore-quickstart.yaml` 会往这个文件里补 `auth.admin_password_hash`，两者顺序无关——只要和 §3 的 `--config` 是同一个文件。

### 2.4 首启引导（不拦启动，但没口令就登不进面板）

`kored serve` 启动时如果发现 `auth.admin_password_hash` 为空，**只打印一行提示**，不读终端、不阻塞、不写配置文件：

```
提示：尚未设置管理员口令——面板会显示登录页但无法登录；请执行 `kored admin-password --generate` 生成一次口令（写入配置后重启 kored 生效）。
```

**已知缺口（ADR-0043）**：「没设置口令」的实例会显示登录页，但登录端点一律回 401「口令错误」——没有任何凭据能进入面板。首启引导属另一张卡，本轮未实现；当前必须先用 `admin-password` 生成口令并重启。

## 3. 启动

```bash
# --config 必须与 §2 生成口令时用的是同一个文件
./bin/kored serve --config ./kore-quickstart.yaml
```

启动日志出现 `kore ready ... addr=127.0.0.1:8787` 即监听就绪。

## 4. 浏览器访问

打开确切地址：

```
http://127.0.0.1:8787/
```

这是 `kored` 自己托管的面板主壳（`web/dist` 二十三个产物经 `web/embed.go` 编进二进制）。路由只有两条：`GET /` 提供 `index.html`，`GET /assets/{file}` 提供其余静态资源（按后缀决定 Content-Type，只认单段文件名与 `.js/.css/.html` 后缀）。首屏加载四件套（`index.html` + `style.css` + `app.js` + `shell.js`），`store.js` / `files.js` / `sites.js` / `tasks.js` / `monitor.js` / `settings.js` / `terminal.js` / `db.js` / `logs.js` / `process.js` / `ssl.js` / `backups.js` / `redis.js` / `firewall.js` 十四个视图模块在切到对应视图时才按需注入（终端 / 数据库 / 日志 / 进程 / SSL / 备份 / Redis / 防火墙由 `shell.js` 内置路由懒加载）；`files-l2.js` / `site-edit.js` / `db-l2.js` 只在文件/站点/数据库页首次执行 L2 操作时注入，`config-panel.js` 只在日志/备份页点「设置」时注入，`monitor-cards.js` 只在进入监控页时注入——首屏体积不随视图数与能力数增长。其它路径（如 `/nonexistent`）返回 404，没有 SPA 兜底。`/-/healthz` 仍可供探针使用（返回 200 `{"status":"ok"}`）。

## 5. 访问与 CSRF（先登录，之后免密）

1. **任何来源**（本机 UDS、`127.0.0.1` loopback、其他机器）访问 `/api/v1/*` 都必须先登录：未登录一律 401，面板显示登录页。本机通道**不是**认证替代品（ADR-0043）。
2. 登录：`POST /api/v1/auth/login`，请求体 `{"password":"你在 §2.2 设置的口令"}`。成功会下发两个 cookie：`kore_session`（HttpOnly 会话，默认 7 天滑动）和 `kore_csrf`（双提交 token）。**没设置口令时该端点一律 401「口令错误」**。
3. 之后的写请求（POST/PUT/DELETE 等）必须带请求头 `X-Kore-CSRF: <kore_csrf 的值>`，且浏览器同时携带 `kore_csrf` cookie；两者不一致或缺任一，返回 401 `CSRF 校验失败`。GET 请求无需 CSRF 头。
4. 口令错误 5 次（60 秒窗口内）会锁 300 秒，别硬试。

> 安全边界：`/` 与 `/assets/` 前缀在鉴权白名单内（面板静态壳无敏感数据，未登录也能加载登录界面）；白名单只认前缀一条、不枚举文件名。所有管理 API 仍强制会话校验，不因静态托管削弱。不要把 `server.addr` 改成 `0.0.0.0` 或把 `cookie_secure` 关掉暴露到不安全网络。

## 停止

在运行 kored 的终端按 Ctrl-C，进程会优雅关闭并释放端口与状态库锁。

## 附录 A：高级 / 自动化场景（手工 PBKDF2 哈希）

正常安装（本机使用）完全不需要读这一节——本机免密，只有远程访问才用 `admin-password --generate`。只有「不跑 kored 的部署流水线」或「已有哈希生成脚本」时才手算；格式固定 `pbkdf2-sha256$600000$<base64(salt)>$<base64(hash)>`，迭代次数必须是 **600000**，否则生成的串无法通过校验：

```bash
python3 -c 'import hashlib,base64,os;s=os.urandom(16);h=hashlib.pbkdf2_hmac("sha256",b"mypassword",s,600000,32);print("pbkdf2-sha256$600000$"+base64.b64encode(s).decode()+"$"+base64.b64encode(h).decode())'
```

拿到串之后两条路等价，都支持自动化（不交互、不读终端）：

```bash
./bin/kored admin-password --hash '<上面输出的完整串>' --config ./kore-quickstart.yaml
#    ↑ --config 与 §3 启动时相同；仍然走原子写 + 0600
# 或直接把串填进配置文件的 auth.admin_password_hash（记得 chmod 600）
```

## 接下来

- 升级 kore 自身、备份与恢复状态：[docs/OPERATIONS.md](docs/OPERATIONS.md)
- 发布侧动作（索引重签 / 插件升级 / 回滚）：[docs/RUNBOOK.md](docs/RUNBOOK.md)
- 全部文档索引（按「我想做什么」组织）：[docs/README.md](docs/README.md)
