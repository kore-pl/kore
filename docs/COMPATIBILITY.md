> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

# COMPATIBILITY — 三平台兼容基线（Linux / Windows / macOS）

## 0. 文档定位

| 项 | 内容 |
| --- | --- |
| 读者 | implementer（照此写 `internal/platform` 与 envprobe）、verifier（照此跑矩阵）、运维（判断能不能装） |
| 作用 | 三层支持等级、构建目标、运行下限、发行版矩阵、能力探测、平台差异、降级、exit 6 边界 |
| 不作用 | 不写启动状态机（见 [ARCHITECTURE.md](./ARCHITECTURE.md) §6）、不写字段级规格（见 [CORE.md](./CORE.md) §2.11–§2.12）、不写资源预算（见 RESOURCE-MODEL.md） |
| 硬约束 | 一份源码交叉编译出三平台产物；**升级系统不是用户义务**；不要求关闭 SELinux/AppArmor |

## 1. 三层支持等级

> **优先级（裁决 35）**：任何兼容性工作先保证当前机器（本机 Linux amd64）正常运行——`make check` 全绿、行为可复现、发布链可重建；Windows/macOS/其余发行版为"能构建/能降级运行"的次级目标。平台差异一律收在 `internal/platform`，不得因适配其它平台扰动本机路径。本矩阵的 Tier A/B 分级不变，改变的是投入顺序与冲突仲裁规则。

| 等级 | 平台 | 判据 | 承诺 |
| --- | --- | --- | --- |
| **Tier A** | Linux amd64 / arm64（内核 ≥ 4.18） | 全功能：cgroup v2 硬限额、systemd 集成、peercred 身份校验 | 矩阵内发行版必须通过；上生产 |
| **Tier B** | Windows 10 1809+ / Server 2019+（amd64）；macOS 12+（arm64/amd64） | 可用但**明确降级**：无 peercred → hello HMAC；macOS 无内存硬限；Windows 插件不换用户 | 能装能跑，降级项写进日志与 `system/info`；不上"零差异"承诺 |
| **不支持** | Windows 7/8、macOS 11 及更早、armv7、386、riscv64 | 启动即拒 | exit 6 或交叉编译不提供目标 |

"降级"不是含糊词：每个降级项必须在 §7 有对应行，给出降级到哪、损失什么、用户怎么知道。

## 2. 构建基线

三个平台共用一套参数，差异只在 `GOOS`/`GOARCH` 与产物后缀：

| 参数 | 值 | 理由 |
| --- | --- | --- |
| `CGO_ENABLED` | `0` | 静态链接，摆脱 glibc/musl/msvcrt 版本绑定；交叉编译无需 C 工具链 |
| `GOAMD64` | `v1` | 2003 年后的 x86-64 CPU 全支持；薄壳无 SIMD 热点（JSON 走标量路径） |
| `GOARM64` | `v8.0` | arm64 服务器基线（Graviton/Ampere 均满足），不追 v8.2 原子指令 |
| `-buildvcs` | `false` | 不依赖 `.git`，发行打包与干净检出均可构建 |
| `-trimpath` | 开 | 产物可复现、不泄露构建路径 |
| `-ldflags` | `-s -w` | 去符号与调试信息，配合 25 MiB 单二进制预算 |

构建目标矩阵（`make release` 逐行产出）：

| 目标 | `GOOS/GOARCH` | 附加环境 | 产物 | 最低系统 |
| --- | --- | --- | --- | --- |
| Linux x86-64 | `linux/amd64` | `GOAMD64=v1` | `kored` | 内核 4.18+ |
| Linux arm64 | `linux/arm64` | `GOARM64=v8.0` | `kored` | 内核 4.18+ |
| Windows x86-64 | `windows/amd64` | `GOAMD64=v1` | `kored.exe` | Win10 1809+ / Server 2019+ |
| macOS arm64 | `darwin/arm64` | — | `kored` | macOS 12.0+ |
| macOS x86-64 | `darwin/amd64` | `GOAMD64=v1` | `kored` | macOS 12.0+ |

标准构建命令（与 `make build` 等价）：

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 go build -buildvcs=false -trimpath \
  -ldflags="-s -w" -o bin/kored ./cmd/kored
```

macOS 产物需 `codesign`（M2 落地，ad-hoc 签名起步）；Windows 不签名时首次运行会有 SmartScreen 提示，文档必须写明这一点而不是让用户猜。

## 3. 运行环境下限

| 项 | Linux | Windows | macOS |
| --- | --- | --- | --- |
| OS / 内核 | 内核 **≥ 4.18**（RHEL 8 基线） | **10 1809**（build 17763）/ Server 2019+ | **12.0**（Monterey） |
| 硬限额能力 | cgroup v2 统一层级需 **≥ 5.2** + unified | Job Objects（Win8+ 即可） | **无强制**（仅观测） |
| 服务管理 | systemd ≥ **239**（`Delegate=yes` 语义稳定） | SCM（服务控制管理器） | launchd（`/Library/LaunchDaemons`） |
| 传输 | AF_UNIX | AF_UNIX（**1809+** 才支持，路径 ≤ 108 字符） | AF_UNIX |
| 身份校验 | `SO_PEERCRED` | **无 peercred** → hello HMAC | `LOCAL_PEERCRED` |
| 默认目录 | `/etc/kore`、`/var/lib/kore`、`/run/kore`、`/var/log/kore` | `%ProgramData%\kore\{config.yaml,state,run,log}` | `/usr/local/etc/kore`、`/usr/local/var/lib/kore`、`/usr/local/var/run/kore` |
| 端口 | 默认仅 UDS；可选 `127.0.0.1:8787` | 同左（命名管道**不使用**，仍 AF_UNIX） | 同左 |

## 4. 发行版支持矩阵（Tier A 明细）

| 发行版 | 最低版本 | 典型内核 | cgroup 默认 | init | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| Ubuntu | 20.04 LTS | 5.4 | v1（v2 需参数） | systemd 245 | M1 待验 |
| Ubuntu | 22.04 LTS | 5.15 | hybrid | systemd 249 | M1 待验 |
| Ubuntu | 24.04 LTS | 6.8 | v2 唯一 | systemd 255 | M1 待验 |
| Debian | 11 / 12 | 5.10 / 6.1 | hybrid / v2 | systemd 247 / 252 | M1 待验 |
| RHEL / Rocky / Alma | 8.x | 4.18 | v1 默认 | systemd 239 | M1 待验 |
| RHEL / Rocky / Alma | 9.x | 5.14 | v2 默认 | systemd 252 | M1 待验 |
| Fedora | 38+ | ≥ 6.2 | v2 唯一 | systemd 253+ | M1 待验 |
| openSUSE Leap | 15.5+ | 5.14 | hybrid | systemd 249 | M1 待验 |
| Alpine | 3.19+ | 6.6 | 视配置 | OpenRC | M1 待验 |

Tier B 平台矩阵（Windows/macOS 不按发行版分，按 OS 版本分）：

| 平台 | 最低版本 | 验证状态 | 说明 |
| --- | --- | --- | --- |
| Windows | 10 1809（17763）/ Server 2019+ | M1 交叉编译；M3 runner 实测 | 仅 amd64 |
| macOS | 12.0（Monterey） | M1 交叉编译；M2 实机/runner | arm64 + amd64 |

状态口径只有三种：**待验 / 已验证 / 不支持**。表里不允许出现"可能支持"。

## 5. 能力探测清单

启动第 2 步执行 envprobe，产物是 capability report（字段见 [CORE.md](./CORE.md) §2.11）。探测项共 **10** 项，平台相关项在不适用的平台记 `N/A`：

| # | 能力 | 探测方法 | 硬要求 | 缺失/不满足时行为 | 用户可见信号 |
| --- | --- | --- | --- | --- | --- |
| 1 | 平台与架构 | `runtime.GOOS`+`GOARCH`；GOOS∈{linux,windows,darwin}，GOARCH∈{amd64,arm64} | **是** | **exit 6** | stderr `unsupported platform=<os>/<arch>` |
| 2 | OS 版本 | Linux 读 `/proc/sys/kernel/osrelease`；Windows 读 `GetVersionEx`（经 platform 层）；macOS 读 `sysctl kern.osproductversion` | **是** | **exit 6**（低于 §3 下限） | stderr `os=<x> below min=<y>` |
| 3 | 传输 AF_UNIX | 试 bind 一个临时 `unix` socket 并立即关闭 | **是**（Windows <1809 无此能力） | **exit 6** | stderr `af_unix unavailable` |
| 4 | 对端身份方式 | Linux `SO_PEERCRED` / macOS `LOCAL_PEERCRED` / Windows 无 → `hmac` | 否（Windows 必降级） | 降级：hello HMAC（密钥由主壳 env 下发） | `system/info.peer_identity="peercred\|hmac"` |
| 5 | 资源限制后端 | Linux：`/proc/self/cgroup` 首行 `0::/` + `/sys/fs/cgroup/cgroup.controllers`；Windows：Job Objects 能力；macOS：无 | 否 | 降级为观测模式 | `system/info.cgroup_mode` / `resource_backend` |
| 6 | 委派可写性 | Linux：试写 `/sys/fs/cgroup/kore/.probe` 的 `memory.high` 并回滚 | 否 | 降级：限额不生效 | `system/info.delegation=false` |
| 7 | 服务管理器 | Linux `/run/systemd/system`；Windows SCM 可查询；macOS `/Library/LaunchDaemons` 可写 | 否 | 降级：无开机自启 | `system/info.service_manager="systemd\|scm\|launchd\|none"` |
| 8 | SELinux | `/sys/fs/selinux/enforce`（仅 Linux） | 否 | 不降级功能；启动自检写目录 | `system/info.selinux` |
| 9 | AppArmor | `/sys/kernel/security/apparmor`（仅 Linux） | 否 | 不降级；无 profile 不阻断 | `system/info.apparmor` |
| 10 | 状态目录文件系统 | Linux/macOS 解析 `/proc/mounts` 或 `statfs`；Windows 取卷类型（拒绝网络盘） | **是** | **exit 6** | stderr `state dir on unsupported fs=<type>` |

探测必须只读且可回滚：试写失败要恢复原值，不得在宿主上留残留。

## 6. 平台差异表

| 维度 | Linux（Tier A） | Windows（Tier B） | macOS（Tier B） |
| --- | --- | --- | --- |
| 传输 | AF_UNIX + 4B 长度前缀帧 | 同样 AF_UNIX（1809+）；**不用命名管道**，socket 放 `%ProgramData%\kore\run\` | AF_UNIX + 同样帧格式 |
| 身份校验 | `SO_PEERCRED` 取对端 uid/gid，校验 `kore-<id>` | **无 peercred** → hello 带 HMAC（主壳经 env 下发每插件密钥）；残余风险：同机高权进程可伪造连接，靠 HMAC 密钥泄露面收敛 | `LOCAL_PEERCRED` 取对端 pid/uid |
| 资源限制 | cgroup v2：`memory.max`/`cpu.max`/`pids.max` | **Job Objects**：内存上限 + CPU 速率 + 进程数（`JOB_OBJECT_LIMIT_*`） | **无强制**：只观测 RSS，预算降级为告警阈值 |
| 服务集成 | systemd unit（`Delegate=yes`、`Restart=on-failure`） | SCM 服务注册/查询（`internal/platform/service`） | launchd plist（`/Library/LaunchDaemons/cn.kore.kored.plist`） |
| 停止信号 | `SIGTERM`，5 s 后 `SIGKILL` | console control event（`CTRL_C_EVENT`/`CTRL_BREAK`），无响应则 `TerminateProcess` | `SIGTERM`（launchd 发），5 s 后 `SIGKILL` |
| 默认路径 | `/etc/kore`、`/var/lib/kore`、`/run/kore`、`/var/log/kore` | `%ProgramData%\kore\config.yaml`、`…\state`、`…\run`、`…\log` | `/usr/local/etc/kore`、`/usr/local/var/lib/kore`、`/usr/local/var/run/kore` |
| 权限模型 | POSIX uid/gid + 目录 0700 + socket 0600 | **ACL**（等价 `icacls`：仅 SYSTEM/Administrators 与 `kore` 服务账户可读写），无 `kore-<id>` 用户 | POSIX uid/gid；守护进程以 root 运行，插件用户 `kore-<id>` |
| 开机自启 | systemd enable | SCM `Start=auto` | launchd `RunAtLoad` |
| 插件用户切换 | `kore-<id>` 系统用户 | **不换用户**（无对等机制）→ 隔离靠 Job Objects + HMAC + 目录 ACL | `kore-<id>` 用户（macOS 支持） |

## 7. 降级矩阵

| 缺失能力 | 平台 | 降级到 | 功能损失 | 用户如何知道 |
| --- | --- | --- | --- | --- |
| cgroup v2 统一层级 | Linux | 观测模式（`resources.enforce=false`） | 无硬限，只有声明值与告警 | `system/info.cgroup_mode` + WARN `envprobe.cgroup=unavailable` + 插件中心提示条 |
| cgroup 委派不可写 | Linux | 同上 | 无法建 `<id>.slice` | `system/info.delegation=false` |
| 无 peercred | Windows | hello HMAC | 同机高权进程可尝试伪造连接；密钥泄露面=残余风险 | `system/info.peer_identity="hmac"` + 启动 WARN |
| 无强制资源限制 | macOS | 观测 + 告警阈值 | 单插件超 12 MiB 只能告警，不能被内核杀 | `system/info.resource_backend="observe"` |
| 服务管理器缺失 | 三平台 | 前台/手动运行 | 无开机自启、无崩溃拉起 | `system/info.service_manager="none"` + 首次启动 stderr 提示 |
| SELinux enforcing | Linux | 不降级功能；启动自检写目录 | 策略禁止写目录则 exit 3（权限问题，非兼容问题） | `system/info.selinux` + AVC 排查指引 |
| 插件不换用户 | Windows | ACL + Job Objects + HMAC | 插件与主壳同账户，横向隔离弱于 Linux | `system/info.tier="B"` + 文档明示 |
| 状态目录在网络盘 | 三平台 | **不降级，exit 6** | 无（拒绝启动） | stderr 给挂载点与文件系统类型 |
| 宿主机内存 <1 GiB | 三平台 | `resources.profile: compact`：常驻配额降为 1、合计 ≤12 MiB、监控采样放宽到 30 s | 少 2 个常驻能力；lazy 冷启动更频繁 | `system/info.profile="compact"` + 安装器首屏提示 |

## 8. 退出码 6 的边界

**只有以下 4 类硬要求在启动前不可满足时才 exit 6**：

1. **平台/架构不支持**：`GOOS` 不是 linux/windows/darwin，或 `GOARCH` 不是 amd64/arm64。
2. **OS 低于下限**：Linux 内核 < 4.18；Windows < 10 1809（build 17763）；macOS < 12.0。
3. **状态目录文件系统不支持**：NFS / SMB / CIFS（Windows 为网络驱动器）——bbolt 会静默损坏。
4. **其他启动前不可判定的硬要求**：OS 版本或 `/proc` 不可读（判定不了就按不满足，不猜）。

**绝不触发 exit 6**：cgroup v2 缺失/hybrid/委派不可写、Job Objects 不可用、launchd 缺失、systemd 缺失、SELinux、AppArmor、端口被占（→5）、目录无权限（→3）、配置错误（→2）。

## 9. 验证方式

```bash
file bin/kored                                   # 期望：ELF 64-bit LSB executable, statically linked
GOOS=windows GOARCH=amd64 go build ./...         # M1：交叉编译通过（windows）
GOOS=darwin  GOARCH=arm64 go build ./...         # M1：交叉编译通过（darwin）
go version -m bin/kored                          # 期望：CGO_ENABLED=0、-trimpath、无 vcs
make compat-info                                 # 打印 GOOS/GOARCH/GOAMD64/GOARM64 + file + go version -m
```

运行期验证（按里程碑推进）：

| 里程碑 | 场景 | 期望 |
| --- | --- | --- |
| M1 | 三平台交叉编译 + Linux 冒烟（`curl --unix-socket … /-/healthz`） | 200，`system/info` 与实际环境一致 |
| M2 | macOS 实机/runner 启动 + 安装一个插件 | `tier="B"`、`resource_backend="observe"`、插件可跑 |
| M3 | Windows runner：Win10 1809 与 Server 2019 各一次 | `peer_identity="hmac"`、Job Objects 限额生效、SCM 自启可查 |
| 每发布 | 无 systemd 的容器/最小 rootfs | 正常启动、降级 WARN、`healthz` 200 |
| 每发布 | SELinux enforcing（Rocky） | 启动成功；被拒时给 AVC 与目录清单 |
| 每发布 | 状态目录挂 NFS/网络盘 | exit 6，stderr 说明挂载点与 fs |

## 10. 已知不兼容清单（诚实写）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Windows < 1809、Windows 7/8 | 不支持 | 无 AF_UNIX，exit 6 |
| macOS < 12 | 不支持 | 系统调用与 launchd 语义不保证，exit 6 |
| armv7 / 386 / riscv64 | 不支持 | 不提供构建目标 |
| NFS / SMB / CIFS 上的状态目录 | 不支持 | bbolt 静默损坏，exit 6 |
| Windows 插件用户隔离 | 弱于 Linux | 无 `kore-<id>` 对等机制，靠 ACL + Job Objects + HMAC |
| 无 peercred 时的连接身份 | 降级 | HMAC 只能证明"持有密钥"，不能证明"是哪个 uid" |
| macOS 内存硬限 | 不支持 | 无 cgroup/Job Objects 对等物，只能观测告警 |
| 无 systemd/SCM/launchd 的自启 | 不支持 | 需用户自写 OpenRC/rc.local/任务计划 |
| 内核 < 4.18 | 不支持 | exit 6，不提供降级路径 |

## 11. 演进与复审

1. **跟随上游 EOL**：矩阵每年复审；EOL 版本移出，不保留"理论支持"。
2. **下限只升不降且要有证据**：若主流普遍 ≥6.1 且 cgroup v2 唯一，可提下限；需重跑矩阵 + ADR。
3. **架构/平台扩展要有真实用户与 CI 资源**：riscv64、Windows arm64 只在有用户与 runner 时评估。
4. **新增探测项必须同时给降级行为**：只探测不降级的项不允许进表。

## 12. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 启动时序中 envprobe / 平台适配的位置；`internal/platform` 五接口的调用边界 |
| [CORE.md](./CORE.md) | envprobe 的 4 小节规格与 `system/info` 字段；本文只给矩阵与判定 |
| [REPOS.md](./REPOS.md) | 构建与发布流程（交叉编译矩阵 → release）；兼容检查是发布门禁 |
| [VISION.md](./VISION.md) | "不要求用户升级系统"的产品承诺来源 |

> 三平台不是"多编译两次"，是**把每个平台的缺失说清楚**：Windows 没 peercred 就用 HMAC 并写明残余风险，macOS 没硬限就降级为告警。含糊的"都支持"比明确的不支持更贵。
