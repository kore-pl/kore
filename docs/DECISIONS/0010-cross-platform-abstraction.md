> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: lead · 关联: ../COMPATIBILITY.md

# ADR-0010: 跨平台抽象——五接口 + AF_UNIX + 三态能力

## 背景

内核要同时跑 Linux / Windows / macOS，而 UDS、信号、服务管理、用户隔离、cgroup 全是 Unix 专属假设。若这些假设直接写进 `internal/core`，M3 加 Windows 等于重写 supervisor 与 transport；若为每个平台复制一套 core，又违背"一个代码库、一个二进制"的交付口径。平台差异必须收敛到唯一一层，且这层要能被门禁检查——否则"支持三平台"只是文档承诺。

## 决策

1. **`internal/platform` 五接口**：`paths` / `service` / `signals` / `resource` / `transport`。`internal/core` 只依赖接口，不 import 任何 `_windows.go` / `_darwin.go` 实现；平台实现按构建标签分文件，`syscall` 与 `os/signal` 平台分支只允许出现在 `internal/platform`（G-16）。
2. **传输统一 AF_UNIX**：Windows 10 1809+ 由 Go 标准库原生支持 Unix domain socket，**不引 `go-winio`**；低于 1809 启动即 exit 6。
3. **插件身份校验三态**：Linux `SO_PEERCRED`、macOS `LOCAL_PEERCRED`、Windows 无 peercred → hello 必须携带 HMAC（主壳经环境变量下发每插件独立密钥，进程启动后不再落盘）。
4. **资源限制三态**：Linux cgroup v2 / Windows Job Objects / macOS 无强制限额（仅观测 + 告警）。
5. **服务集成三态**：systemd（Linux）/ SCM（Windows）/ launchd（macOS）；均不改变"主壳可前台运行"的前提。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| 只支持 Linux | 零抽象成本，最快 | 排除 Windows/macOS 单机场景 | 与 ADR-0009 的 Tier A/B 承诺矛盾 |
| TCP loopback + token 替代 UDS | 跨平台统一，无需 AF_UNIX | 占端口、本机可嗅探、多一层鉴权与延迟 | 攻击面从文件权限变成网络端口，Tier B 本来就弱 |
| 命名管道（Windows 原生） | Windows 上最自然、语义完整 | 必须引 `go-winio`，破依赖白名单（上限 3）与单二进制预算 | 不能为单一平台加第三方依赖 |
| AF_UNIX 统一 + 五接口抽象（选） | 一个代码库三平台；Windows 零额外依赖；协议帧完全一致 | 需维护五接口的三套实现 | 选它：把平台差异锁在唯一一层 |

## 后果

**正面**：同一份 `internal/core` 三平台编译通过；Windows 不需要任何第三方依赖；协议帧、状态机、错误码在三个平台完全一致；平台差异集中在一处，review 与测试范围可控。

**负面**：Windows 隔离强度弱于 Linux（无 UID 隔离、无 peercred，只有 HMAC）；macOS 无强制内存限额，只能观测告警；三套服务集成（systemd/SCM/launchd）要分别测试，CI 成本上升。

**技术债**：平台差异表随 OS 版本演进维护；HMAC 密钥分发与轮换需在 supervisor 落地（env 传递 + 启动后清空）；Job Objects 的限额语义与 cgroup 不完全等价，`resources` 声明在 Windows 只能"尽力而为"；`GOOS=windows/darwin` 交叉编译必须进 CI，否则"支持"只是口号。

## 验证方式

```bash
GOOS=windows GOARCH=amd64 go build ./...                       # 交叉编译通过
GOOS=darwin  GOARCH=arm64 go build ./...                       # 同上
go list -deps ./internal/core | grep -c 'internal/platform'     # core 只依赖接口层
grep -rn 'syscall\.' internal/core || echo "core 无平台专有调用" # 只允许出现在 internal/platform
# Linux：SO_PEERCRED 校验生效（错误 uid 连接被拒）
# Windows：HMAC 握手成功；错误密钥被拒（E_UNAUTHORIZED）
# 三平台 system/info 均返回 os / os_version / capabilities
curl -s 127.0.0.1:8787/api/v1/system/info | grep -E '"os"|"os_version"|"capabilities"'
```

## 复审条件

Windows 10 1809 以下占比显著，或 AF_UNIX 在 Windows 出现稳定性问题 → 考虑命名管道并开新 ADR 放宽依赖白名单；macOS 无强制限额导致实际事故 → 评估 `setrlimit` + 观测告警补强；`internal/platform` 接口数增长到 8 个以上 → 说明抽象层在膨胀，需重新划边界。
