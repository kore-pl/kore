> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

# kore 安全模型（SECURITY）

本文定义 kore 的威胁模型、信任边界、鉴权与授权、插件隔离、输入校验、密钥与升级链、审计与安全默认值。前端契约见 [FRONTEND.md](./FRONTEND.md)，进程隔离的选型理由见 [ADR-0003](./DECISIONS/0003-process-isolation-plugins.md)。

## 1. 威胁模型

### 1.1 资产清单

| 资产 | 位置 | 敏感度 |
| --- | --- | --- |
| admin 口令哈希 | `/etc/kore/config.yaml` 的 `auth.admin_password_hash` | 高（可离线爆破） |
| 会话凭据 | bbolt `sessions` bucket + 浏览器 cookie | 高 |
| 插件密钥 | `/var/lib/kore/secrets/<id>.json`（`0600 root:root`，目录 `0700`） | 中高 |
| 插件可执行文件 | `/var/lib/kore/plugins/<id>/<version>/bin/<id>` | 中（可替换即等于代码执行） |
| 插件能力授予记录 | bbolt `plugins` bucket 的 `granted_capabilities` 字段 | 高（越权即扩大攻击面） |
| 审计日志 | bbolt `audit` bucket + `/var/log/kore/` | 中 |
| 宿主文件系统 | 插件以 `kore-<id>` 可读的路径 | 视权限而定 |

### 1.2 攻击面

网络面：UDS `/run/kore/kore.sock`（默认唯一）；可选 HTTP `127.0.0.1:8787`。本地面：插件进程、`/etc/kore`、`/var/lib/kore`、`/var/log/kore`。供应链面：插件包（未签名期）、npm 依赖（仅构建期）。人因面：安装来路不明插件、把 HTTP 监听到 `0.0.0.0`。

### 1.3 威胁表

| 威胁 | 场景 | 影响 | 缓解 | 残余风险 |
| --- | --- | --- | --- | --- |
| 未授权访问控制台 | 同机其他用户或暴露到 0.0.0.0 的 8787 被扫 | 全量插件操作 | 默认仅 UDS；目录 0700；PBKDF2 口令 + 会话校验 | 用户显式绑 `0.0.0.0` 且无 TLS 时口令走明文 |
| 口令爆破 | 反复 `POST /api/v1/auth/login` | 账号接管 | 60s 窗口内 5 次失败即锁定 300s（每 IP + 全局桶）、恒定时间比较 | 慢速低频爆破（单机场景收益低） |
| CSRF | 恶意页面诱导已登录浏览器发写请求 | 停机、卸载插件 | `SameSite=Strict` + 双提交 token + `X-Kore-CSRF` + Origin 校验 | 同站 XSS 可绕过全部三层 |
| 会话劫持 | XSS 读 cookie，或同机读取浏览器数据 | 会话盗用 | `HttpOnly`、12h 滑动 TTL、登出即删、绑 UA 指纹哈希 | 同机 root 可读浏览器进程内存 |
| 插件越权调用 | 低权插件请求 `system:admin` 方法 | 宿主被改写 | capabilities 三处校验（安装/授予/调用）+ 审计 | 用户安装时授予过宽能力 |
| 恶意插件包 | 安装来路不明的包 | 以 `kore-<id>` 执行任意代码 | M4 起 ed25519 强制签名；独立 uid + cgroup | M0–M3 未签名期无法证明来源 |
| 索引仓库被篡改 | 索引指向恶意包，或把 sha256 换成攻击者的值 | 用户安装到恶意插件 | 索引只是**发现渠道，不是信任源**：kore 只信安装时计算并记录的 `plugins.package_sha256`，M4 起以 ed25519 验包 | 首次安装前索引与包同时被篡改且用户未核对来源时，sha256 自洽但包仍恶意（M4 签名后消失） |
| 路径穿越 | 插件 id 或资产路径含 `../` | 读宿主任意文件 | id 正则白名单 + `filepath.Clean` 前缀校验 + `Lstat` 拒 symlink | 需逐处校验，遗漏一处即失效 |
| 解压攻击 | zip-slip、symlink 条目、解压炸弹 | 覆盖宿主文件、撑爆磁盘 | 逐条目目标前缀校验、拒非 regular/dir、包与解压总量上限 | 高压缩率正常包可能被误拒 |
| 资源耗尽 | 插件吃满内存/CPU/PID | 主壳与宿主不可用 | cgroup v2 `memory.max`/`cpu.max`/`pids.max` | 同机其他服务仍受低强度 thrash 影响 |
| lazy 冷启动风暴 | 大量并发请求同时唤醒同一插件 | CPU 被打满、插件反复启停 | 单插件启动互斥 + 队列上限（默认 32）+ 超限 `E_RATELIMIT` | 已排队请求延迟上升 |
| UDS 被同机用户连接 | `/run/kore` 权限过宽 | 无口令直连 API | 目录 `0700 root:root`、主壳 socket `0600`、插件 socket `0600`、`SO_PEERCRED` 校验 | 仅 root 可直连管理入口 |
| 日志泄密 | 口令/token/secret 进日志 | 凭据二次泄露 | 字段白名单 fail-closed + 丢弃非白名单字段 | 插件自写日志不受主壳控制 |
| SSE 连接耗尽 | 大量 `/events` 长连接 | FD 与内存耗尽 | 单会话 1 条、全局上限 64、空闲 90s 断开 | 已认证用户可占满配额 |

## 2. 信任边界

```text
[浏览器 / 第三方页面]   不受信：任何输入都可能是攻击载荷
          │  HTTP/HTTPS；Cookie + X-Kore-CSRF；Origin/Referer 校验
          ▼
[主壳 kored]  root 运行，唯一可信裁决点：鉴权、授权、路由、资源限额
          │  UDS + 4 字节大端长度前缀 + JSON；帧 ≤ 8 MiB；每帧按 capabilities 校验
          ▼
[插件进程 kore-<id>]  独立系统用户 + cgroup v2；不可信执行体
          │  exec.Command（不经过 shell）；文件系统按目录权限收口
          ▼
[宿主 Linux]  systemd / cgroup v2 / 文件系统 —— 最终信任根
```

规则：跨边界只走协议帧，不共享内存、不共享文件句柄、不共享环境变量；主壳对插件不信任，插件对浏览器不信任。

## 3. 鉴权与会话

### 3.1 口令存储

- 算法 **PBKDF2-HMAC-SHA256，600,000 次迭代**，salt 16 字节（`crypto/rand`），输出 key 32 字节。
- 实现走 Go 1.24+ 标准库 `crypto/pbkdf2`：零新增依赖、无 CGO，不破主壳依赖白名单（G-02 上限 3）与单二进制 ≤ 25 MiB 预算。
- 存储格式：`pbkdf2-sha256$600000$<base64(salt)>$<base64(hash)>`，写在 `/etc/kore/config.yaml` 的 `auth.admin_password_hash`，文件权限 `0600 root:root`。
- 校验用 `subtle.ConstantTimeCompare`；迭代次数从存储串读取（属校验参数），上调不破坏旧哈希，登录成功时可透明重算升级。
- 系统只有一个账号，不做用户枚举。

**取舍与复审条件**：PBKDF2 无内存硬化，对 GPU/ASIC 离线爆破的抵抗弱于内存硬 KDF。当前可接受的前提是三条同时成立：单管理员账号、默认只绑 UDS 或 `127.0.0.1`、无公网暴露面；再叠加 60s 内 5 次失败锁 300s 的限速，在线爆破不可行，离线爆破的前置是攻击者已能读 `0600 root:root` 的配置（等价 root）。**复审条件**：默认暴露公网、出现多用户/多租户、或 `auth.admin_password_hash` 进入非 root 可读的备份路径时，必须改用内存硬 KDF（**Argon2id**）并开新 ADR 显式放宽依赖白名单（新增 `golang.org/x/crypto`），同时给出哈希迁移与双格式兼容方案。

### 3.2 首启口令

`auth.admin_password_hash` 为空时生成 24 字符口令（`crypto/rand`，base32 字母表去掉 `0/O/1/I`），**只打印到 stderr/tty 一次**，随后写入哈希并置 `auth.initialized: true`。口令本身永不进日志文件，日志只记 `auth.admin_initialized`。二次启动不再打印；口令遗失只能由 root 删除 `auth.admin_password_hash` 后重启重置。

### 3.3 会话

- 服务端存 bbolt `sessions`：key 为 32 字节随机 hex，value 含 `created`、`last_seen`、`ua_hash`、`ip_hash`。
- TTL **12h 滑动**：每次鉴权通过刷新 `last_seen`；绝对上限 7 天，到期强制重新登录。
- cookie：`kore_session=<hex>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`，`Secure` 见 3.4。
- 登出：删除服务端记录 + `Set-Cookie: kore_session=; Max-Age=0; Path=/`；服务端删除是唯一失效依据，不依赖浏览器。

### 3.4 `Secure` 在纯 HTTP 下的取舍

`localhost` / `127.0.0.1` / `[::1]` 属浏览器安全上下文，`Secure` cookie 在这些 origin 上仍会被接受；但把监听绑到内网 IP 又不加 TLS 时，`Secure=true` 会让浏览器直接丢弃 cookie，表现为"登录提交成功却立刻掉线"。

决策：`auth.cookie_secure` 默认 `auto`——请求为 TLS 或 Host 属于以上三种回环名时设 `Secure`，否则不设，同时打一次 `WARN` 并在 `/system` 页顶部显示红条"当前非 TLS 且非回环，cookie 无 Secure 保护"。可显式改 `true`/`false`。不设 `Secure` 的残余风险是同网段被动嗅探可截获会话；`HttpOnly` 仍在，XSS 读不到。

### 3.5 登录限速

两个令牌桶同时生效：per-IP（取 `RemoteAddr`；UDS 下地址恒为 local，实际退化为全局桶）与全局桶，**60s 窗口内 5 次失败即锁定 300s**（与 [CORE](./CORE.md) / [DATA-MODEL](./DATA-MODEL.md) 的 `security.login_rate_limit` 同口径）。命中返回 `E_RATELIMIT` 并带 `Retry-After`；失败与限速都写审计，不区分"账号不存在/口令错误"。

## 4. CSRF

三层同时启用，任一层失败即拒绝：

1. **`SameSite=Strict`**：跨站请求不携带会话 cookie。
2. **双提交 token**：登录成功下发 `kore_csrf=<32 字节 hex>`（**非 HttpOnly**，前端需读取）并与 session 绑定；前端每个写请求带 `X-Kore-CSRF: <值>`；服务端比对 `header == cookie == sessions.csrf`。
3. **同源校验**：`Origin`（缺失时倒退 `Referer`）必须与请求 `Host` 同源；**非 GET 请求缺 Origin/Referer 直接 `E_UNAUTHORIZED`**。

所有非 GET 必须带 `X-Kore-CSRF`；`GET /-/healthz`（探针例外，不带业务前缀）与 `GET /api/v1/events` 例外（只读），但 SSE 仍要求有效 session cookie，`SameSite=Strict` 阻止跨站 `EventSource`。

## 5. 授权（capabilities）

### 5.1 校验点

| 阶段 | 触发 | 校验内容 | 失败码 |
| --- | --- | --- | --- |
| 安装声明 | `POST /api/v1/plugins` 解析 `info.json` | 按 §5.2 顺序校验：非空（≥1 项）、语法合法、域为 6 特权之一或等于自身 id、无重复、≤16 项 | `E_INVALID` |
| 启用授予 | `POST /api/v1/plugins/{id}/enable` | 展示声明清单并由用户确认，写入 `plugins` bucket 的 `granted_capabilities` 字段 | `E_CONFLICT`（升级新增能力未重新确认时） |
| 调用校验 | 每个 `POST /api/v1/invoke/{plugin}/{method}` 帧 | 方法→能力映射表命中，且目标能力已在 `plugins.granted_capabilities` 中 | `E_UNAUTHORIZED` + 审计 `capability.denied` |

### 5.2 能力模型（两段）

| 段 | 内容 | 归属与语义 |
| --- | --- | --- |
| 特权能力（6 个，固定不可扩展） | `system:read` `system:admin` `net:read` `net:write` `proc:read` `proc:write` | 对宿主有实际影响，由内核集中校验与授权；`system:admin` 最高危，启用时强制二次确认 |
| 插件自有能力 | `<plugin-id>:<action>`，**域必须等于声明它的插件 id**（`site` 可声明 `site:read`；`db-mysql` 不得声明 `site:write`） | 插件自治，内核只校验语法与域归属 |

校验规则（按序，安装时执行）：① 语法 `^[a-z][a-z0-9-]{0,30}:[a-z][a-z0-9-]{0,30}$`，非法 → `E_INVALID`；② 域 ∈ 特权集 → 允许；③ 否则域必须 == `info.json.id`，不等 → `E_INVALID`（message 说明原因）；④ **必须非空（≥1 项）且 ≤16 项**，空数组、重复项或超限 → `E_INVALID`。

设计理由：**内核不得维护业务域名词表**——只认识 6 个宿主级特权能力 + 通用语法，其余归插件自治，新增插件永远不需要改内核（G-01）。

越权一律 `E_UNAUTHORIZED`，`detail` 只含缺失的能力名，不泄露方法内部实现。插件之间不允许互相直接调用；跨插件协作只经主壳 `kore.event` 广播。

## 6. 插件隔离

- **系统用户**：每个插件一个 `kore-<id>`（`useradd --system --no-create-home --shell /usr/sbin/nologin`），不与其它插件共享 uid。
- **目录权限**：`/var/lib/kore/plugins/<id>` 属 `kore-<id>:kore-<id>`，**0750**；`/run/kore` 为 `0700 root:root`；插件 socket `/run/kore/plugins/<id>.sock` 由主壳创建后属 `kore-<id>`、**0600**。
- **cgroup v2**：`/sys/fs/cgroup/kore/<id>.slice`；控制文件 `memory.max` / `memory.high` / `memory.swap.max` / `cpu.max` / `pids.max` 的取值与默认值以 [RESOURCE-MODEL](./RESOURCE-MODEL.md) 为唯一真源，本文件不复制数值。安全含义：supervisor 在拉起前按 `resources` 声明与全局上限**取小值**后写入，插件无法自报放大；超限分别表现为 OOM kill、限流、fork 失败。oneshot 进程退出后 RSS 计 0。
- **进程属性**：`cmd.Env` 只传 `KORE_PLUGIN_ID` / `KORE_PLUGIN_SOCK` / `KORE_PLUGIN_TOKEN` / `KORE_STATE_DIR` / `KORE_LOG_DIR`；stdin 关闭；stdout/stderr 重定向到 `/var/log/kore/plugins/<id>.log`。

### 6.1 明确不做 seccomp / namespace

- **不做 seccomp**：Go runtime 需要 clone3、futex、epoll、io_uring 等宽 syscall 面，手写白名单跨内核版本极易误杀，且 EPERM 归因困难；引入 libseccomp 或容器运行时 SDK 直接违反主壳依赖上限 3 个与单二进制 ≤ 25 MiB。残余风险：插件可调用任意 syscall，但独立 uid 使其无法 ptrace 其它插件或主壳。
- **不做 namespace**：user/net/mount namespace 编排等于半个容器运行时，违反红线④（不搞容器化底座）；跨 namespace 的 UDS 还需 bind mount 或抽象 socket。残余风险：插件共享宿主网络栈与文件系统视图，靠权限位与 cgroup 收口。

### 6.2 SELinux / AppArmor 兼容

宿主开启 SELinux（RHEL / CentOS / Fedora）或 AppArmor（Ubuntu / Debian / SUSE）时，kore 必须能在 **enforcing** 模式下正常运行，且**不得要求用户关闭安全模块**。

受影响路径（策略需允许，权限不变）：

| 路径 | 权限 | 用途 |
| --- | --- | --- |
| `/run/kore` | `0700 root:root` | socket 与运行目录 |
| `/var/lib/kore` | `0700 root:root` | 状态库、插件版本目录、secrets |
| `/etc/kore/config.yaml` | `0600 root:root` | 配置与口令哈希 |
| `/var/log/kore` | `0640 root:kore` | 日志与审计导出 |

- **SELinux**：M3 提供 `kore.te` 与 `kore.fc`（源码树 `deploy/selinux/`）与安装说明（`semodule -i kore.pp`、`restorecon -Rv`）。enforcing 下若被拒绝，启动必须**明确失败并打印 AVC 指路**（`ausearch -m avc -c kored`），**禁止静默降级**——自动 `setenforce 0` 或吞掉 `EACCES` 都不允许。
- **AppArmor**：M3 提供 `deploy/apparmor/kored` profile 与 `apparmor_parser -r` 说明；被拒绝同样打印 `dmesg | grep -i apparmor` 指路，不得静默继续。
- **明确不做**：不要求用户关闭 SELinux / AppArmor（不把 `setenforce 0`、`aa-disable` 写进任何步骤）；**不自动修改系统安全策略**——改策略属宿主级高危操作，kore 只输出所需路径与指引，由运维决策并留痕。
- **与退出码衔接**：安全模块拦截导致状态目录不可写 → **退出码 3**（状态目录不可用）；策略缺失但路径仍可写 → `WARN` 不阻断启动，除非配置显式开启严格模式（`security.strict_mac: true`）。环境级硬要求缺失（内核、架构）仍走 [ADR-0009](./DECISIONS/0009-compatibility-baseline.md) 的退出码 6。

### 6.3 三平台隔离强度

Tier A 与 Tier B 的隔离能力**不是同一量级**，必须在文档与 UI 中都披露，不允许用"支持三平台"掩盖差异：

| 平台 | 用户隔离 | 身份校验 | 资源硬限 |
| --- | --- | --- | --- |
| Linux（Tier A） | 独立 uid `kore-<id>` | `SO_PEERCRED`（uid + pid） | cgroup v2（`memory.max` / `cpu.max` / `pids.max`） |
| macOS（Tier B） | 独立 uid | `LOCAL_PEERCRED` | 无强制限额，仅观测 + 告警 |
| Windows（Tier B） | **同用户运行**，无 UID 隔离 | hello 携带 HMAC（每插件独立密钥） | Job Objects（只限资源，不构成安全边界） |

- **Linux**：最强。uid + cgroup + peercred 三重，插件越界即被内核拒绝。
- **macOS**：uid + peercred 仍在，但无内存/CPU 硬限；超限只能观测告警，不能强制回收。
- **Windows 残余风险三条（写死）**：
  1. 恶意插件与主壳同用户，可读主壳可读的任意文件（含配置与状态库）→ 缓解：插件目录 ACL 收窄（`icacls` 等价），状态库与配置目录单独 ACL 拒绝插件账号；插件只经 UDS 通信。
  2. HMAC 密钥若落盘即被同用户插件读取 → 缓解：密钥仅经环境变量传入，进程启动后不再落盘，插件退出即失效。
  3. 同用户下无法阻止插件直接读写主壳 socket 之外的文件 → 缓解：业务能力仍受 capabilities 校验，越权返回 `E_UNAUTHORIZED`，并写审计。
- **明确不做**：不为 Windows 实现 AppContainer / 低完整性级别（IL），M4 再评估；**不声称 Tier B 具备 Tier A 的隔离强度**。

## 7. UDS 本地攻击面

- 主壳管理入口 `/run/kore/kore.sock` 属 `root:root`，**0600**；父目录 `/run/kore` 为 `0700 root:root`。只有 root 可直连——**文件权限即边界**，CLI 与运维脚本以 root 运行是刻意前提。
- 插件 socket `/run/kore/plugins/<id>.sock` 由主壳 listen 后 `chown kore-<id>`、**0600**；accept 后取 `SO_PEERCRED`，对端 uid 必须等于 `kore-<id>`、pid 必须等于 hello 自报 pid，否则立即 close 并记审计。其它插件用户既读不到也连不上。
- 启动时先 `Lstat` 校验 `/run/kore` 属主为 root 且非 symlink，再删除残留 socket 并 `bind`；父目录不可写使插件无法替换 socket。
- 残余风险：root 可直连管理入口（等价宿主完全控制，不额外防御）；能读 `/etc/kore/config.yaml` 的账号已等同 root 级别。

## 8. 输入校验与危险操作

- **标识符**：插件 id `^[a-z][a-z0-9-]{1,30}$`；方法名 `^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,31}$`。
- **路径**：一律 `filepath.Clean`，结果必须前缀匹配 `filepath.Join(root, id)`；用 `os.Lstat` 拒绝符号链接；`/plugin-assets` 只放行 `js`/`css`/`svg`/`png`/`woff2`/`json`。
- **子进程**：只用 `exec.Command(binPath, args...)`，**永不经过 shell**；args 由主壳构造，不拼接插件或浏览器输入；不使用 `sh -c`、`bash -c`、`system()`。
- **包名与清单一致**：包文件名必须匹配 `<id>-<version>.tar.gz`，且与 `info.json` 的 `id`/`version` 完全一致，不一致返回 `E_INVALID`（防替换包身份）。
- **解压**：逐条目 `Clean(header.Name)` 后必须仍在目标目录内；`Typeflag` 非 regular/dir 一律拒绝（含 symlink、hardlink、device）；单包大小以 [CORE](./CORE.md) 的 `body_limit` 为真源，解压后 ≤ 128 MiB、条目 ≤ 2000、单文件 ≤ 64 MiB；先解到临时目录，校验通过后 `rename` 原子落位，失败清理。
- **请求体**：JSON body ≤ 1 MiB；上传包走流式读取并卡 [CORE](./CORE.md) 的 `body_limit` 上限，超限立即断流。
- **帧**：解码前先读 4 字节长度，> 8 MiB 直接断链并记 `E_INVALID`，不分配对应缓冲。

### 8.1 预设注入防护

场景预设来自索引仓库（可被第三方镜像、可被篡改），因此 preset 是**不可信输入**，不是配置模板快捷方式：

- **`config_template` 只允许白名单键**：仅接受 `site.*` / `db.*` / `log.*` / `store.mirror` 等显式列举的键；出现白名单外的键（如 `security.login_rate_limit`、`auth.*`、`supervisor.*`）整条预设拒绝，不允许"部分应用"。
- **应用前必须过 schema 校验**：预设里的每个键都按配置 schema 校验类型与取值范围，校验失败即 `E_INVALID` 并整条丢弃；写入成功后记审计 `preset.apply`（含 preset id、`preset_snapshot_version`、插件清单摘要）。
- **预设不得携带可执行内容**：只允许"插件 id + 版本区间 + 配置模板"三样；出现 `web` 资产、脚本、`entry`、二进制路径、`capabilities` 覆盖声明等字段一律拒绝——能力只能来自插件自身 `info.json`，不能被预设"授予"。

### 8.2 冷启动风暴防护

**资源耗尽也是一类攻击**：`lazy` 插件的冷启动是"一次请求 → 拉起一个进程"的放大操作。攻击者（或一个写错的脚本）在插件空闲退出的瞬间并发打同一方法，会让主壳同时拉起 N 个进程、把 CPU 打满，而每个进程又因为争抢而在 hello 阶段超时——最终既没有服务，也耗尽资源。

三条缓解同时生效：

- **单插件启动互斥**：同一插件同一时刻只允许一个冷启动在跑，其余请求进入等待队列，不并发 spawn（否则 `spawn → 超时 → 杀 → 重 spawn` 会形成抖动循环）。
- **队列上限**：每插件等待队列默认 32（可配），达到上限直接拒绝，不允许无界堆积把内存吃穿。
- **超限 `E_RATELIMIT`**：被拒绝的请求返回 `E_RATELIMIT` 并带 `Retry-After`，写审计 `plugin.start_suppressed`；调用方应退避重试，而不是立即重打。

配套约束：冷启动 `hello` ≤ 300ms 超时（见 [ADR-0013](./DECISIONS/0013-extreme-resource-frugality.md)），超时即杀进程并释放互斥，避免"一个卡死的冷启动锁死整个插件"。配额与上层限速（登录限速、SSE 上限）相互独立，不互相抵扣。

## 9. 密钥与配置

- `/etc/kore/config.yaml` 权限 `0600 root:root`；`auth.admin_password_hash` 可读但不可逆，PBKDF2-HMAC-SHA256 600,000 次迭代使单次校验约 0.2s 量级，配合 60s 内 5 次失败锁 300s 的限速后在线爆破不可行。
- **插件 secret 存储决策**：不把秘密混进状态库，单独存 `/var/lib/kore/secrets/<plugin-id>.json`（`0600 root:root`，目录 `0700`）。理由：状态库备份与导出不连带泄露、单插件可独立轮换与删除、迁移成本与 `state.db` 解耦。M0–M2 明文（无主密钥时的加密是自欺）；M4 引入主密钥 `/var/lib/kore/master.key`（`0600`），用 XChaCha20-Poly1305 信封加密，文件内保留 `v` 字段支持逐文件迁移。
- 配置热重载**不重读** `auth.admin_password_hash`，防止替换配置文件后提权；改口令需重启并写审计 `config.change`。
- 环境变量白名单：`KORE_CONFIG`、`KORE_STATE_DIR`、`KORE_HTTP_ADDR`、`KORE_WEB_DEV`、`KORE_LOG_LEVEL`，其余忽略。

## 10. 升级链安全

- **来源与校验链**：包由 `kore-plugin-<id>` 仓库的 release 提供（`<id>-<version>.tar.gz` + 同名 `.sha256`）→ 安装时 kore 自行计算并记录 `plugins.package_sha256`（**不采信包内或索引声明的哈希**）→ M4 起叠加 ed25519 签名校验 → `info.json.requires_kore` 与当前内核版本不兼容直接拒绝（`E_UNSUPPORTED`）。`kore-plugins` 索引只做格式校验与发现，不代管包、不审核、不是信任源（见 [ADR-0008](./DECISIONS/0008-multi-repo-topology.md)）。
- **插件前端资产不 embed**：插件前端在 `kore-plugin-<id>` 仓库内用任意栈构建，产物以 `web/` 进包，安装时落到 `/var/lib/kore/plugins/<id>/<version>/web/`；`/plugin-assets/<id>/*` 由 kore 从该目录读取并托管。**kore 的 `go:embed` 只含主壳前端，不含任何插件资产**；kore 对该目录只读（安装/卸载与升级清理除外）。
- **签名对象**：包内除 `signature` 外所有文件的规范化清单（路径 + sha256，按路径字节序排序）拼接后做 **ed25519** 签名，结果存包内 `signature`。公钥内置二进制，可选追加 `/etc/kore/trusted_keys/*.pub`（root 所有，0644）。
- **校验顺序**：先按 8 节上限解压到临时目录 → 计算清单摘要 → 验证签名 → 通过才 `rename` 落位。即使签名未过，恶意内容也只存在于受限临时目录且从未执行。
- **M0–M3**：`plugins.allow_unsigned` 默认 `true`，安装未签名包必须在 UI 二次确认，并写审计 `signature.absent`。
- **M4**：默认改 `false`，未签名包返回 `E_UNSUPPORTED`；临时开启需显式改配置并在 UI 红条提示，开关变更写审计。公钥轮换保留上一版一个周期。

## 11. 审计与日志脱敏

- 审计写 bbolt `audit` bucket，保留 30 天或 10 万条（先到为准）：`auth.login`（ok/fail）、`auth.logout`、`session.expired`、`plugin.install/enable/disable/upgrade/uninstall`、`plugin.ui_load_failed`、`capability.denied`、`config.change`、`signature.absent`、`signature.reject`、`ratelimit.hit`。
- **日志字段白名单**：`ts`、`level`、`event`、`req_id`、`plugin_id`、`method`、`code`、`dur_ms`、`ip_hash`、`ua_hash`、`bytes`。实现上先 marshal 成 map 再按白名单重建，**白名单外字段丢弃而非透传**（fail-closed）。
- 禁止记录：口令、token、cookie、secret、`Authorization`、完整请求体、签名原文；`ip`/`ua` 只存 sha256 前 16 字节。
- 日志文件 `/var/log/kore/kore.log`（插件为 `/var/log/kore/plugins/<id>.log`）权限 `0640 root:kore`；轮转容量以 [DATA-MODEL](./DATA-MODEL.md) 为唯一真源（内核 10 MiB × 5、插件 10 MiB × 2），本文件不另立数字。

## 12. 无联网声明

运行期**零出站连接**：主壳不主动外联，插件默认无出站许可（声明 `net:read`/`net:write` 才允许，M3 起叠加 egress 策略）。唯一例外是用户显式触发：证书续期检查（也是唯一允许的常驻定时器，可关）与插件包下载（用户手填 URL）。没有远程账号、没有联网校验、没有隐藏上报、没有功能封锁。

验证手段：`ss -tnp | grep kored` 应为空；CI 静态检查 `net.Dial` / `http.Get` 只允许出现在白名单包内，越界即失败。

### 12.1 软件商店与联网边界

商店不改变"零后台出站"的底线，只是把出站收敛到**用户显式触发**的少数入口：

- **运行期零后台出站**：空载 `ss -tnp` 必须为空，不存在定时轮询商店、心跳上报或版本检查。
- **例外仅三类**：用户显式 `POST /api/v1/store/refresh`、安装/更新时的包下载、ACME 证书续期（由插件发起，需 `net:write` 能力且受 egress 策略约束）。
- **索引是发现渠道不是信任源**：M2 起索引条目必须带 sha256，安装时 kore 自算并与索引声明比对，冲突即拒。
- **索引签名前移到 M2（信任空窗 = 0）**：M2 即引入**索引级 ed25519 签名**，不等 M4——公钥内置在 kore 二进制，签名对象 = **索引文件本体**；未签名索引默认拒绝，`store.allow_unsigned=true` 需显式配置并写审计。插件包签名仍按 M4 时间线（见 [ADR-0012](./DECISIONS/0012-scenario-presets-and-store.md)）。
- **离线导入包**：`--offline-dir` 下的包走**同一条**安装链路——sha256 + `info.json` schema + 路径穿越/符号链接/zip-bomb 防护全部沿用第 8 节，不另写一套宽松逻辑。
- **镜像源**：`store.mirror` 支持 `https://` 与 `file://`；镜像内容仍按本地计算的 sha256 校验，镜像不可信不能成为跳过校验的理由。

## 13. 安全默认值清单

| 项 | 默认 | 可改 | 影响 |
| --- | --- | --- | --- |
| HTTP 监听 | 关闭（仅 UDS） | `KORE_HTTP_ADDR` | 开启即把攻击面从本机扩到网络 |
| 监听地址 | `127.0.0.1:8787`（开启时） | 配置 | 改 `0.0.0.0` 暴露到内网 |
| `auth.cookie_secure` | `auto` | 配置 | 纯 HTTP 非回环时不设 `Secure` |
| 会话 TTL | 12h 滑动 / 7d 绝对 | 配置 | 调大增加劫持窗口 |
| 登录限速 | 60s 内 5 次失败锁 300s | 配置 | 调严易自锁，调松增爆破面 |
| 插件签名 | `allow_unsigned=true`（M4 改 `false`） | 配置 | 未签名期无法证明来源 |
| 插件包大小 | 以 [CORE](./CORE.md) `body_limit` 为真源 | 配置 | 调大增加解压炸弹面 |
| 单插件内存 | 12 MiB | `resources.memory_mb`（取声明与上限较小值） | 超限被 cgroup OOM kill |
| 常驻插件内存合计 | 24 MiB（单插件 ≤12 MiB） | 不支持 | 合计触顶或常驻数达 3 时拒绝再启用新常驻插件（配额上限 3、推荐 ≤2） |
| 单插件 CPU | 0.5 核 | `resources.cpu_quota` | 超限被限流 |
| 单插件 PID | 以 [RESOURCE-MODEL](./RESOURCE-MODEL.md) 为准（默认 128，范围 16–512） | `resources.pids_max` | 超限 fork 失败 |
| swap | 0 | 不支持 | 防止内存挤压旁路 |
| 主壳 socket 权限 | 0600 root:root | 不支持 | 仅 root 可直连管理入口 |
| 运行目录权限 | 0700 root:root | 不支持 | 非 root 无法枚举或替换 socket |
| 插件 socket 权限 | 0600 | 不支持 | 降权才能收紧，不能放宽 |
| 插件目录权限 | 见 §6 权限口径 | 不支持 | 同上 |
| 日志级别 | `info` | 配置 / 运行时 | `debug` 可能带敏感上下文 |
| 审计保留 | 30 天或 10 万条 | 配置 | 影响取证窗口与磁盘占用 |
| SSE 连接上限 | 64（单会话 1 条） | 配置 | 影响长连接占用的 FD |

## 14. 加固路线

**M3**：插件 egress 策略（nftables 按 cgroup 匹配）、`SO_PEERCRED` 全链路校验、限速状态持久化、审计导出为 JSONL、签名校验预研与试运行（不强制）、内存压力下的降级路径。

**M4**：ed25519 强制签名 + 公钥轮换流程、主密钥信封加密 `/var/lib/kore/secrets/*.json`、可选 seccomp 配置文件（opt-in，加载失败降级为不启用并告警）、SBOM 生成、依赖 CVE 扫描进 CI。

两条不变式贯穿所有阶段：主壳是唯一裁决点；任何"方便"的改动不得让插件获得跨信任边界的能力。
