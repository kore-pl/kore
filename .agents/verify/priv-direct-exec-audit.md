> 状态: 证据 · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [0049](../../docs/DECISIONS/0049-privilege-direct-execution.md)、[0018](../../docs/DECISIONS/0018-privilege-model.md)、[0042](../../docs/DECISIONS/0042-privilege-without-prompt.md)

# 核实证据：特权动作执行路径 / 插件 uid / `kore-*` 创建 / ADR-0018 与 0042 关系

**任务卡**：核实并裁决「kore 以 root 运行，特权操作由 kore 直接执行，去掉 systemd-run / polkit 中间层」。
**范围**：只做核实、裁决与 ADR 撰写，**未改任何代码**。

## 1. 环境与命令（本轮全部只读）

```text
$ cd /home/pt/Work/GolandProjects/kore
$ grep -rn "systemd-run\|polkit\|TransientUnit\|--uid=0" --include='*.go' .
$ ps -o pid,user,uid,comm -C kored
    PID USER       UID COMMAND
 809422 pt        1000 kored
$ id
uid=1000(pt) gid=1000(pt) groups=1000(pt),4(adm),24(cdrom),27(sudo),30(dip),46(plugdev),100(users),111(lpadmin),114(lxd),970(libvirt),973(docker),991(kvm),994(input)
```

**结论：本机 `kored` 以 `uid=1000(pt)` 运行，属 ADR-0018 / 0042 定义的「降级形态」；补充组含 `docker` 与 `sudo`（ADR-0018 `:244` 已把 `docker` 组记为「既成等价 root 授权」）。**

## 2. 特权动作执行路径（`file:line`）

| 事实 | 位置 | 原文/关键内容 |
| --- | --- | --- |
| 通道 = `systemd-run` transient unit，`--uid=0` | `internal/core/privilege/systemd.go:37` | `"systemd-run", "--uid=0", "--collect", "--wait",` |
| 完整 argv 构造（含输出重定向到临时文件） | `internal/core/privilege/systemd.go:36-45` | `-p StandardOutput=file:<out> -p StandardError=file:<err> --unit=<unit> -- <argv...>` |
| argv 被测试锁定（防漂移） | `internal/core/privilege/privilege_test.go:356-362` | `want = "systemd-run --uid=0 --collect --wait ..."` |
| 执行顺序：schema → confirm → Root → Systemd → 审计 begin → Run → end | `internal/core/privilege/service.go:77-150` | 见函数注释与正文 |
| 非 root → `E_NEED_ROOT`（在 systemd 判定之前） | `internal/core/privilege/service.go:84-87` | `if !s.opts.Root() { ... E_NEED_ROOT ... }` |
| 非 systemd → `E_NO_SYSTEMD` | `internal/core/privilege/service.go:88-93` | `if ok, detail := s.opts.Systemd(); !ok { ... }` |
| 错误提示把 polkit 写进排障口径 | `internal/core/privilege/service.go:147` | `"检查 systemd / polkit 权限与命令是否存在"` |
| systemd 硬前置 | `internal/core/privilege/systemd.go:181-195` | `DetectSystemd` 检查 `/run/systemd/system` + `systemd-run` + `systemctl` |
| 超时回收 = `systemctl kill --signal=SIGKILL <unit>` + `stop` | `internal/core/privilege/systemd.go:70-82` | `KillUnit` |
| 真实命令退出码**不透传**（只透传 systemd-run 退出码） | `internal/core/privilege/systemd.go:58-64` | 注释自认：「具体命令退出码由 systemd 决定，这里只透传 systemd-run 的退出码」 |
| HTTP 入口 | `internal/core/httpapi/handlers_rootaction.go:44-70` | `handleRootAction` → `s.privilege.Execute` |
| 包级说明仍写「经 systemd-run」 | `internal/core/privilege/privilege.go:1-3` | — |

**限额核账**：`BuildSystemdRunArgv` 只设置 `StandardOutput` / `StandardError`，**没有** `MemoryMax` / `CPUQuota` / `TasksMax` / `PrivateTmp` 等任何资源或命名空间属性（`systemd.go:36-45` 全量 argv 可核对）。→ 「cgroup 限额」这项能力当前**未被使用**。

## 3. 插件进程 uid 的判定与降权路径

| 事实 | 位置 |
| --- | --- |
| 降权仅在内核 `uid==0` 时启用 | `internal/core/supervisor/manager.go:81-86`（`case current.UID == 0:` → `Demotion{Enabled: true, ...}`） |
| 非 root → 显式降级（不静默） | `internal/core/supervisor/manager.go:88-95`（Reason 明写「插件与内核同 uid」） |
| `Demotion` 结构带 `Enabled` / `KernelUID` / `Reason`，拒绝「零值即成功」的表达 | `internal/core/supervisor/demote.go:17-33`、`:60-70` |
| 降权六步（查找/创建 → chown 数据根 → 二进制补 o+rx → 目录补 o+x → `SysProcAttr.Credential` → 清空补充组） | `internal/core/supervisor/demote.go:56-70` |
| 启动路径调用降权并在失败时拒绝启动 | `internal/core/supervisor/start.go:81-135` |

## 4. `kore-<id>` 系统用户创建逻辑：**存在**

| 事实 | 位置 |
| --- | --- |
| 前缀常量 `kore-` | `internal/core/supervisor/demote.go:13` |
| 用户名长度上限 32 字节 + 语法校验 | `demote.go:100-110` |
| `Lookup` 不存在 → `Ensure` 创建；失败即拒绝启动 | `demote.go:112-125` |
| 解析为 `uid<=0` 拒绝（防降权到 root） | `demote.go:127-131` |
| 创建实现：`useradd` / `adduser`，**固定绝对路径候选**（防 PATH 劫持） | `internal/platform/linux_identity.go:25-30` |
| 创建流程（含补组、同名组已存在时复用 gid） | `internal/platform/linux_identity.go:104-188` |
| 创建时加入内核通道共享组 | `demote.go:114`（`m.identity.Ensure(name, []string{m.opts.ChannelGroup})`） |

**结论：`kore-*` 系统用户数 = 0 的根因是「内核没有以 root 运行」（`manager.go:88`），不是「创建逻辑不存在」。** 任务卡中的「挂账」应改写为「形态未到位」，而非「实现缺失」。

## 5. ADR-0018 与 ADR-0042 是否矛盾：**不矛盾，但 0018 把机制与授权写在同一句**

| 文档 | 关键原文 | 位置 |
| --- | --- | --- |
| ADR-0018 | 「`kored` 以 root 启动，插件一律降到 `kore-<id>`」 | `docs/DECISIONS/0018-privilege-model.md:94` |
| ADR-0018 | 「root 动作**只能**由内核经 `systemd-run --uid=0 --collect`（transient unit）拉起」 | `0018:95` |
| ADR-0018 | 尾注：「落地形态已确定为 kored 以系统级 root 服务运行……运行期**不经过任何 polkit 授权判定**」 | `0018:281` |
| ADR-0042 | 「uid=0 不进入 polkit 判定，动作由已授权的 systemd 直接执行」 | `docs/DECISIONS/0042-privilege-without-prompt.md` 候选对比表与「正面」节 |
| ADR-0042 | 判定：本 ADR 不是新架构，是把 0018 §15.1 的既有设计作为默认安装形态落地 | 同上「关键认知」段 |

**层次拆解**：`polkit` = **授权层**（root 内核下不参与）；`systemd-run` = **执行机制**（仍在用）。0018 把两者写在同一句，才产生「保留 systemd-run 就等于保留授权」的误读。ADR-0049 正式把两者拆开。

## 6. 审计与变更账本的现状

| 事实 | 位置 |
| --- | --- |
| root 动作审计事件名 `root.action`，含 actor/plugin/action/argv(脱敏)/unit/decision/exit_code/dur_ms | `internal/core/privilege/audit.go:13-25`、`:100-115` |
| 审计落 bbolt，字段 `subject/action/plugin/target/result/detail` | `internal/core/store/audit.go:36-44` |
| `changes.jsonl` 只记「用户批准的宿主变更」，字段 `ts/plugin/action/target/before/after/reversible/purge_op` | `cmd/kored/changes.go:30-43` |
| 回滚用结构化 `purgeOp`（白名单 kind + 参数，**禁止 shell 字符串**） | `cmd/kored/changes.go:15-28` |
| root 动作与 `changes.jsonl` **无写入关联**（grep 无 root-action 侧 appendChange 调用） | 全仓 grep `changes.jsonl` 仅命中 `cmd/kored/`、文档与 G-31 |

**缺口（产品视角）**：root 动作只留命令原文，无「人话摘要 / 影响对象 / 回滚指引 / 因果链 / 用户视图 / 能力归类」。详见 ADR-0049 §5.1。

## 7. 未确认项

1. **root 形态端到端未实测**：本会话 `NoNewPrivs=1`、`sudo` 被内核阻断、`/etc/systemd/system` 不可写（与 ADR-0042「实测边界」同因）。「root 内核 + 插件 `kore-<id>` + 直接执行」链路未经真机验证。
2. **`waf` 0.4.4 BLOCKED 原始报告**未在本仓 `.agents/verify/` 找到（只有 waf 版本/深度等级记录）；本卡引用任务卡转述，机制性死路由 `service.go:84-87` + `systemd.go:181` 独立证实。
3. **`systemd-run --wait` 退出码语义**依据 `systemd.go:58-64` 代码注释，未做真机对照实验。

## 8. 本轮写域与未改动声明

- 新增：`docs/DECISIONS/0049-privilege-direct-execution.md`、`.agents/verify/priv-direct-exec-audit.md`。
- **未改动任何代码 / 配置 / 运行态资产**；未启动或重启 `kored`；未触碰 `.kore-local*`。
