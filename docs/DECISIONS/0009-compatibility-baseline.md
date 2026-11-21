> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: lead · 关联: ../COMPATIBILITY.md

# ADR-0009: 三平台兼容基线——Tier 分层 + 静态二进制 + 能力探测

## 背景

kore 的用户环境横跨内网主力 RHEL8（默认 cgroup v1）、Alpine（无 glibc、无 systemd）、Ubuntu LTS 到滚动版 Fedora，同时也存在 Windows 单机运维与 macOS 开发机场景。任何"只支持某发行版/某 OS"的设计都会把一半用户挡在门外；而 cgroup v2、systemd、UDS 对端凭据等能力在各环境差异极大——同一份代码在 RHEL8 上拿不到 unified 层级，在 Alpine 上连 systemd 都没有，在 Windows 上既无 cgroup 也无 peercred。兼容性因此不是"打包时多编几个产物"，而是**分层承诺 + 启动期探测 + 明确降级 + 拒绝不可用**。

## 决策

**范围分三层级**：

| 层级 | 平台 | 承诺 |
| --- | --- | --- |
| Tier A | Linux（内核 ≥ 4.18） | 全功能：UID 隔离 + cgroup v2 限额 + peercred + systemd/OpenRC 集成 |
| Tier B | Windows 10 1809+ / Server 2019+、macOS 12+ | 可用但降级：无 UID 隔离或无强制限额，身份校验改用 HMAC，资源走 Job Objects 或仅观测 |
| 不支持 | 其余（含 Windows < 1809、macOS < 12） | 启动即退出 **6**，不进入半可用状态 |

- **二进制**：`CGO_ENABLED=0` 纯静态，`GOAMD64=v1`、`GOARM64=v8.0`、`-buildvcs=false`；Linux 上不依赖 glibc/musl。
- **架构**：仅 **amd64 / arm64**；armv7 / 386 / riscv64 为非目标（G-11 保护）。
- **Linux 内核下限 4.18**；cgroup v2 **硬限制**需 ≥ 5.2 且 unified 层级可用，否则降级为**只监控不限额**并在 `system/info` 标记。
- **init 三态**：systemd / OpenRC / 无 init，三种都必须能跑；systemd 只用于 unit 集成与 slice，不作为运行前提。
- **启动能力探测**：结果写入 `GET /api/v1/system/info`（`os` / `os_version` / `capabilities`）；**硬要求缺失以退出码 6 终止**。
- **文件系统**：bbolt 状态库拒绝 NFS / SMB / CIFS（启动即拒并给明确错误），不静默降级——文件锁语义不可靠时状态库必坏。
- 发行版矩阵、各平台已知差异与降级表见 [COMPATIBILITY](../COMPATIBILITY.md)，本 ADR 只定基线，**不复制表格**。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| 只支持 Linux | 开发与测试最省事，系统能力可控 | 排除 Windows 单机与 macOS 开发机场景，放弃一半潜在用户 | 与"服务器运维基础底座"的定位矛盾 |
| 动态链接 + 依赖系统库 | 体积小，可用系统库 | glibc 版本地狱；Alpine 不可用；三个 OS 打包矩阵爆炸 | 交付复杂度随平台数指数增长 |
| TCP loopback + token 替代 UDS | 三平台统一，无 AF_UNIX 依赖 | 占端口、可被本机嗅探、多一层鉴权开销 | 攻击面从文件权限变成网络端口，见 [ADR-0010](./0010-cross-platform-abstraction.md) |
| 静态二进制 + Tier 分层 + 能力探测（选） | 一个二进制三平台可跑；缺能力时行为可预期；Linux 全功能、Tier B 明确降级 | 需实现探测与降级矩阵并逐条测试 | 选它：把"平台差异"收敛为"能力位 + 层级承诺" |
| WASM / 自带容器运行时 | 环境完全可控 | 违背"不引容器底座"红线；体积与启动成本不可接受 | 架构级拒绝 |

## 后果

**正面**：一个 `kored` 覆盖 RHEL8/9、Alpine、Ubuntu、Fedora、Windows 10 1809+、macOS 12+；Alpine 无 glibc 可直接运行；Tier B 用户拿到的不是"跑不起来"而是"能力位明确、功能降级"；不支持环境启动即 exit 6，避免半可用状态导致的诡异故障。

**负面**：`GOAMD64=v1` 放弃 AVX2 等 SIMD 优化；静态二进制体积略大；Tier B 降级路径（无 cgroup、无 UID 隔离）需各自实测，测试矩阵从 1 套变成 3 套；Windows 隔离强度弱于 Linux，必须在文档中持续披露。

**技术债**：能力探测与降级矩阵随 OS/发行版演进维护；SELinux 策略（`kore.te` / `kore.fc`）需 M3 落地；Tier B 的限额语义（Job Objects / 观测）与 cgroup 不完全等价，需单独定义；`GOARM64=v8.0` 需真实硬件或模拟器冒烟，否则等于没验证。

## 验证方式

```bash
file bin/kored                                        # 期望 "statically linked"，无 interpreter
go version -m bin/kored | grep -E 'GOAMD64|GOARM64'    # 期望 GOAMD64=v1
GOOS=windows GOARCH=amd64 go build ./...               # 交叉编译通过（无 cgo 依赖）
GOOS=darwin  GOARCH=arm64 go build ./...               # 同上
./bin/kored --check-config && echo "config ok"         # 无 systemd 环境（Alpine/OpenRC）亦可
curl -s 127.0.0.1:8787/api/v1/system/info | grep -E 'os|os_version|capabilities'
# 不支持环境（Linux < 4.18、Windows < 1809、macOS < 12）→ 退出码 6
./bin/kored; echo "exit=$?"
# cgroup v2 缺失：cgroup_enforced:false 且服务正常，不退出
# NFS/SMB/CIFS 上启动应被拒绝
./bin/kored --check-config; echo "exit=$?"
```

## 复审条件

主流发行版普遍 ≥ 6.1 内核且 cgroup v2 唯一 → 移除 v1 降级路径并提高下限；armv7 / 386 / riscv64 占比上升 → 重评估架构范围；Windows 10 1809 以下或 macOS 12 以下仍有显著存量 → 评估放宽 Tier B 下限（需新 ADR）；Tier B 因隔离弱导致实际事故 → 提升该平台隔离实现或收紧支持范围。
