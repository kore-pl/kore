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

### 2.1 首次凭据：安装期统一交付，读凭据文件 + 首登改密

> **凭据生命周期口径（2026-11-25 事故修订，[ADR-0055 §8](docs/DECISIONS/0055-initial-admin-credential.md)）**：**首次安装**（无哈希 / 未初始化）才生成一次性凭据；**更新 / 升级安装绝不重新生成、绝不覆盖凭据文件或哈希**（既不改哈希、不写凭据文件、不置标志、不打印）——覆盖会让文件口令与配置哈希不匹配、把用户锁在门外并吊销现有会话。首登改密是**建议（可跳过）**，不是必选项。方向：登录将改为**账号 + 密码**，凭据文件将含账号与密码（细节以新 ADR 为准，此处不预设字段）。

> **2026-11-25 更新（[ADR-0055](docs/DECISIONS/0055-initial-admin-credential.md)，commit `99754fd`）**：凭据交付已从「serve 首启 TTY 打印一次」升级为**安装期统一入口 `ensureInitialAdminCredential`**：`kored install --package` 与 serve bootstrap 共用同一函数，安装完成时即生成一次性凭据文件 `<install>/data/initial-admin-credential`（0600，已 gitignore）。TTY 下在终端打印明文口令 **+ 文件路径**；**非 TTY（systemd / journald / 重定向 / CI）只打印文件路径，绝不打印明文**——请在自己的终端读该文件。首次登录必须改密，改密成功后凭据文件被删除、旧会话吊销。下方 2026-11-23 的「首启 TTY 打印 / 非 TTY 只给 CLI 指引」为 serve bootstrap 兜底形态的历史描述，**与新口径冲突时以本段为准**。


全新实例（`auth.admin_password_hash` 为空）**第一次启动**时，kored 自动生成 24 字符随机口令，把 PBKDF2 哈希原子写进**它自己解析的那个配置文件**（权限 0600），并把初始口令**只在当前终端打印一次**——本次启动就能登录，不需要预先生成口令，也**不要求输入任何系统账号密码**：

```bash
./bin/kored serve --config ./kore-quickstart.yaml
```

```
面板地址: http://127.0.0.1:8787/
================ Kore 首启凭据（只显示这一次）================
管理员口令: xxxxxxxxxxxxxxxxxxxxxxxx
登录方式: 打开面板 → 输入上面的口令（单管理员，无用户名）；登录后所有操作免密。
已写入 /绝对路径/kore-quickstart.yaml：只存 PBKDF2 哈希，权限 0600；重启或再次启动都不会再显示这个口令。
再次查看: 口令只存哈希、无法再取；需要轮换请执行 kored admin-password --set --config /绝对路径/kore-quickstart.yaml（CLI 重置，不走 Web 找回、不发邮件；改凭据会吊销所有会话）
==============================================================
```

- 与宝塔 / 1Panel 的安装期凭据模型一致：**安装/首启生成随机凭据 + 终端只输出一次**。区别是 kore **单管理员、无用户名**（登录体只有口令），且明文**不落盘**——配置 / state / 日志里只有哈希。
- **只出现一次**：哈希写回后，重启或再次启动都不会再打印；没有任何"再查一次"的入口，忘记只能走 §2.2 / `admin-password --set` 的 CLI 重置。
- **非 TTY 安装 / 启动（systemd / journald / 重定向 / CI）**：kored **不会**把明文打进 journald 或 CI 日志，只打印「初始凭据已生成，请在自己的终端读取：`<install>/data/initial-admin-credential`（0600）」。在自己的终端执行 `cat` 读取后登录面板并**立即改密**；改密成功后该文件被删除。忘记口令不可找回，只能走 §2.2 / `admin-password --set` 重置。
- **首登改密闸门（ADR-0055）**：初始凭据登录只拿到受限会话——只能调用改密端点与登出，其余 `/api/v1/*` 返回 403 + 白话「首次登录请先设置新口令」。改密成功后标志清除、旧会话全部失效、凭据文件删除；这是**单管理员的一次性状态机，不是多用户 RBAC**（G-11）。
- **路径铁律**：`admin-password` 与 `serve` 必须用同一个 `--config`（或都不用，走默认 `<install>/config/config.yaml`，设了 `KORE_HOME` 就是 `$KORE_HOME/config/config.yaml`）。两边不一致 = 口令写进 A 文件、serve 读 B 文件，**登录永远 401**；两个命令的解析优先级一致：`KORE_CONFIG` 环境变量 > `--config` > profile 默认路径；相对路径按**配置文件所在目录**解析（与启动目录无关），仍建议写绝对路径。
- **生效时机（2026-11-25 更新）**：安装 / 首启自动生成的哈希**本次启动即生效**；用 `admin-password` 手工写入的哈希**无需重启**——向运行中的 kored 发 `SIGHUP`，快照里的新哈希与 `must_change_password` 会同步进内存 `auth.Manager`，且**只在字段真变化时**吊销旧会话（ADR-0055；重启仍是兜底）。
- 写入走「临时文件 + fsync + rename」，权限固定 **0600**；口令与哈希**不进日志**。命令就地改写 `auth.admin_password_hash`，保留文件里其它键、注释与顺序。

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

### 2.4 首启引导行为速查

| 启动时的状态 | kored 的行为 |
| --- | --- |
| 无 `admin_password_hash` + stderr 是终端（SSH / 串口 / 本机 TTY） | 生成 24 字符随机口令 → 哈希 + `auth.initialized: true` 原子写回配置文件 → **口令在终端只打印一次** → 本次启动即可登录 |
| 无 `admin_password_hash` + 非终端（systemd / journald / 重定向） | **不生成、不打印明文**（避免一次性口令被日志长期留存），只打印一行 `kored admin-password --generate --config <同一路径>` 的指引 |
| 无 `admin_password_hash` + 登录 | 登录端点回 `401 {"code":"E_UNAUTHORIZED","message":"口令错误"}`，**空口令绝不放行** |
| 已有 `admin_password_hash` | 一行提示都不打、配置文件一个字节都不改，登录行为与升级前完全一致 |
| 写入配置文件失败（只读 / 权限） | 不打印无法使用的明文，提示执行 `admin-password --generate` 兜底 |

以前那套「TTY 强制输入两次口令」的交互式引导不会回来：首启凭据由 kored 生成，用户**从不需要输入系统账号密码**。

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
>
> 对外暴露（反代 / 隧道）：`cookie_secure: "auto"` 只有在反代**终结 TLS 并覆盖写 `X-Forwarded-Proto: https`** 时才给会话 cookie 加 `Secure`；反代只是明文 HTTP 转发时内核会打一次 WARN（同网段可嗅探 7 天会话令牌）。细节见 [docs/SECURITY.md](docs/SECURITY.md) §3.4。

## 停止

在运行 kored 的终端按 Ctrl-C，进程会优雅关闭并释放端口与状态库锁。

## 附录 A：高级 / 自动化场景（手工 PBKDF2 哈希）

正常安装不需要读这一节——首启会自动生成一次性口令（§2.1）。只有「不跑 kored 的首启流程」或「已有哈希生成脚本」时才手算；格式固定 `pbkdf2-sha256$600000$<base64(salt)>$<base64(hash)>`，迭代次数必须是 **600000**，否则生成的串无法通过校验：

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
## 附录 B：账号 + 密码登录与密码输错后的验证码（2026-11-25，ADR-0057）

> [ADR-0057](docs/DECISIONS/0057-login-account-model.md)（accepted）已把「无用户名、只填口令」升级为「账号 + 密码」。§2 与 §2.1 的历史段落保留原文；**登录填什么以本附录为准**，不与此前「无用户名」旧句冲突处按本附录。

### B.1 登录页怎么填

1. 打开面板 `http://127.0.0.1:8787/`，会看到三个字段：**账号 / 密码 / 验证码**。
2. **账号**预填 `admin`，旁边写着「已自动检测：默认账号 admin，一般不用改」——这是单管理员的固定标识符，**不是秘密**，一般不用动。
3. **密码**填 §2.1 凭据文件里的那一行。凭据文件现在是**两行纯文本**：

   ```text
   username: admin
   password: <placeholder>
   ```

   文件仍在 `<install>/data/initial-admin-credential`（0600，只能自己读），**更新 / 升级安装绝不覆盖**。老的单行凭据文件在升级时会自动包装成上面两行；若文件内容与当前密码对不上，会先备份为 `...credential.legacy` 再包装，并提示用 `kored admin-password --set` 重置（初始密码不可找回）。**不要把真实密码写进任何文档或提交**（G-30）。
4. **验证码**默认隐藏，只有密码输错一次后才出现——见 B.2。

### B.2 密码输错后会发生什么

| 情况 | 面板提示 | 怎么做 |
| --- | --- | --- |
| 第一次密码错 | 「密码错误，请输入右侧验证码」，验证码框展开并自动换图 | 按图片输入 5 个字符；看不清点图片或「换一张」 |
| 无法看图（curl / 终端） | 同一张挑战还有一道「a + b = ?」加法题 | 按题面填数字，答案与图片等效 |
| 验证码填错 / 过期 | 「验证码不对或已过期，请点『换一张』后再输入一次。」 | 换一张再填 |
| 继续输错密码 | 「请 N 秒后再试」并有逐秒倒计时（1 秒起逐步变长，最长 30 秒） | 等倒计时结束再提交；**密码正确时不需要等**，登录成功后验证码要求也清除 |
| 账号填错 | 「账号或口令不正确，请检查后再试。」 | 检查账号是否仍为 `admin` 再重试 |

验证码由本机临时生成（不联网、不发短信 / 邮件），只在内存里存 2 分钟、用一次即失效；重启面板后会自动换一张。登录成功后顶部可能出现一条可关闭提示「建议尽快修改初始口令」——**它不影响任何操作**，方便时到「账户与安全」改密即可（改密弹层同样要填账号，默认 `admin`）。

验证命令与实现证据见 [ADR-0057 §6](docs/DECISIONS/0057-login-account-model.md) 与 [T1–T3 报告](.agents/verify/account-t123.md) / [T4 报告](.agents/verify/account-t4-bruteforce.md)。