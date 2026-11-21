> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: architect · 关联: [SECURITY](../SECURITY.md) · [ADR-0002](./0002-uds-length-prefix-json.md)

# ADR-0003: 进程级插件隔离，不做同进程动态库

## 背景

kore 的能力全部来自插件，插件必须可装、可卸、可替换，且任何一个插件崩溃或吃满资源都不能拖垮主壳。主壳空载 RSS ≤ 8 MiB，常驻插件单 ≤ 24 MiB，oneshot 空闲 RSS = 0；不允许容器运行时 SDK。红线①明令：不做同进程动态库插件。

## 决策

每个插件是**独立进程**，由 `internal/core/supervisor` 拉起：独立系统用户 `kore-<id>`、独立 cgroup v2 slice（`/sys/fs/cgroup/kore/<id>.slice`）、独立 socket `/run/kore/plugins/<id>.sock`，通信走 [ADR-0002](./0002-uds-length-prefix-json.md) 的帧协议。热升级顺序：新进程拉起 → `kore.hello` 成功 → 旧进程 `kore.shutdown`（优雅 5s）→ 未退出则 SIGKILL 兜底。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| 独立进程 + UDS（选） | 崩溃/内存/OOM 互不传染；可独立 uid 与 cgroup 限额；语言无关；可独立升级 | IPC 开销；supervisor 状态机复杂；常驻时双层内存 | 选它：故障域与资源隔离是硬需求 |
| Go `plugin` 包（`.so`） | 调用零序列化、开发简单 | 必须同 Go 版本同构建参数；无法卸载（Go 不支持 unload）；崩溃即主壳崩溃；无法给独立 uid/cgroup | 红线①直接禁止；且"不可卸载"与插件可卸可替换矛盾 |
| WASM 沙箱（wazero 等） | 强沙箱、可限定内存与系统调用 | 引入新运行时依赖；需 syscall 兼容层；Go 编译 WASM 体积大；生态工具链不成熟 | 依赖白名单之外，且 25 MiB 预算与"直接操作宿主文件系统"的目标冲突 |
| 同进程库 + 接口调用 | 最快、最简单 | 无故障隔离、无资源上限、一个 panic 全崩 | 与"插件可替换、崩溃不影响主壳"直接矛盾 |
| 插件跑在容器里 | 隔离最彻底 | 需要容器运行时 = 常驻中间件；违反红线④ | 明确非目标：不搞容器化底座 |

## 后果

**正面**：插件 OOM 只会杀自己（cgroup 限额生效）；`oneshot` 用完即退，空闲 RSS 严格为 0；插件可用任意语言实现；插件升级不影响主壳；主壳只承担 ~8 MiB，符合薄壳定位。

**负面**：每次调用有 UDS + 序列化开销（毫秒级）；supervisor 要维护 **8 状态**机（`installed → enabled → starting → ready → degraded / stopping → stopped / failed`），边界多；进程数随常驻插件增长，需要上限与回收策略。

**技术债**：`hello` 握手超时、socket 残留、僵尸进程回收、日志文件句柄继承都需要逐项处理；热升级期间双进程并存会短暂超出单插件内存预算，需在预算核算里预留一份。

## 验证方式

```bash
# 进程与身份隔离
pgrep -a 'kore-' && cat /proc/$(pgrep -f 'bin/site')/status | grep -E '^(Uid|Gid)'
# 崩溃隔离：kill -9 插件后主壳仍健康
kill -9 $(pgrep -f 'bin/site'); curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz   # 200
# 资源上限生效
cat /sys/fs/cgroup/kore/site.slice/memory.max /sys/fs/cgroup/kore/site.slice/pids.max
# 无同进程插件痕迹
go list -f '{{.Imports}}' ./internal/core/supervisor | grep -c 'plugin' || true   # 应为 0
```

## 复审条件

出现以下任一信号即重开：跨进程调用 p99 > 5 ms 且成为用户可感知瓶颈；常驻插件数 > 20 导致 supervisor 管理与内存核算不可控；需要插件间直接高频通信（届时讨论主壳内事件总线的批量化，而不是换成同进程）；宿主内核不支持 cgroup v2 且无法要求升级。
