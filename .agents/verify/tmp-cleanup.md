# 今日残留隔离 kored 实例与 /tmp 目录清理（2026-11-23 21:49）

- 执行者：`tmp-instance-cleanup`（agent）
- 触发背景：`.agents/verify/ops-restart-2026-11-23.md` 记录 2520580 / 2548624 / 2779969 三个隔离实例未收尾
- 依据门禁：**G-29 运行态写边界**（隔离实例必须独立 `--config` + state/run/log 落 `/tmp`）
- 写域：本文件 + `/tmp/kore-*` 清理动作；**未改仓库任何代码/文档**
- 结论：**未触碰主实例 8787**；清理 2 个确认死亡的隔离实例 + 1 个同卡 headless chrome 残留，释放 **约 49.1 MiB**；释放端口 **18882 / 18879**；4 个仍在被并发 agent 使用的实例**按规矩只报告不杀**

---

## 1. 清理前枚举（`pgrep -af "kored serve"`，21:46:34）

```
2520580 ./bin/kored serve --config /tmp/kore-t196/config.yaml
2548624 ./bin/kored serve --config /tmp/kore-cexec/config.yaml
2798902 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml
2845352 bash -c cd /home/pt/Work/GolandProjects/kore && nohup ./bin/kored serve --config /tmp/kore-cexec2/...
2845353 ./bin/kored serve --config /tmp/kore-cexec2/config.yaml --state-dir /tmp/kore-cexec2/state
2894411 ./kored serve --config /tmp/kore-adp3/config.yaml
2896509 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /tmp/kore-wafe2e/config.yaml
3041987 ./bin/kored serve --config /tmp/kore-uninui/config.yaml
```

逐进程事实（`ss -ltnp` / `readlink /proc/<pid>/exe` / `cat /proc/<pid>/cgroup` / `ls -l /proc/<pid>/cwd` / `ps -o lstart= -p <pid>`）：

| PID | 端口 | exe | cwd | 启动时间 | cgroup |
| --- | --- | --- | --- | --- | --- |
| 2520580 | 18882 | `bin/kored` (deleted) | 仓库根 | 21:29:07 | `dsh-subprocess-3814516-8e94f3c82f58.scope` |
| 2548624 | 18879 | `bin/kored` (deleted) | 仓库根 | 21:31:26 | `dsh-subprocess-3814516-403adbdf5778.scope` |
| **2798902（主实例）** | **8787** | `bin/kored` | 仓库根 | 21:41:57 | **`kored-local.service`** |
| 2845353 | 18872 | `bin/kored` (deleted) | 仓库根 | 21:43:01 | `dsh-subprocess-3814516-7728c1cd0808.scope` |
| 2894411 | 18874 | `/tmp/kore-adp3/kored` | `/tmp/kore-adp3` | 21:44:05 | `dsh-subprocess-3814516-73d9354411e8.scope` |
| 2896509 | 无（未 listen） | 不可读（root） | 不可读（root） | 21:44:35 | `system.slice/kore-wafe2e-root.service`（transient） |
| 3041987 | 18875 | `bin/kored` | 仓库根 | 21:46:20 | `dsh-subprocess-3814516-4a5333dcf10f.scope` |

补充事实（判定用）：

- 所有实例的 `--config` 均在 `/tmp/kore-*`，无一监听 8787；
- 2520580 / 2548624 / 2845353 / 2894411 / 3041987 的 **ppid = 1882（`systemd --user`）**，即发起它们的工具调用已结束、进程已成孤儿；
- 报告中的 `2779969 /tmp/kore-wafe2e` **已不存在**（本轮 wafe2e 是 21:44:35 起的 root transient unit 2896509）。

## 2. 判定（逐进程，全部条件满足才动手）

| PID | 不占 8787 | config/cwd 在 /tmp | 今日启动 | 无 kored-local.service | 3 分钟内启动保护 | 并发 agent 正在使用 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2520580 | ✅ | ✅ `/tmp/kore-t196` | ✅ | ✅（孤儿，ppid=systemd） | ❌ 已 17 分钟 | ❌ 无 ESTAB 连接、无新写入（state.db 最后写 21:30） | **清理** |
| 2548624 | ✅ | ✅ `/tmp/kore-cexec` | ✅ | ✅（孤儿） | ❌ 已 15 分钟 | ❌ 无任何其他进程引用该目录 | **清理** |
| 2798902 | ⛔ **监听 8787** | ❌ `.kore-local.yaml` | — | ⛔ **在 kored-local.service 内** | — | — | **主实例，绝对不动** |
| 2845353 | ✅ | ✅ `/tmp/kore-cexec2` | ✅ | ✅ | ❌ | ⚠️ **是**：21:47:52 仍有兄弟 agent 的 shell（pid 3044223）在 `cd /tmp/kore-cexec2` 改 `shot.mjs`、起 headless chrome | **跳过（活跃）** |
| 2894411 | ✅ | ✅ `/tmp/kore-adp3` | ✅ | ✅ | ❌ | ⚠️ **是**：`state.db`/`out.json` 21:47:50 仍在写 | **跳过（活跃）** |
| 2896509 | ✅ | ✅ `/tmp/kore-wafe2e` | ✅ | ⚠️ 在 `system.slice/kore-wafe2e-root.service`（root transient unit） | ❌ | ⚠️ **是**：`state.db` 21:47:24、`shot.js` 21:47:12 仍在写；且 root 进程，非本轮权限可停 | **跳过（活跃 + 权限不足）** |
| 3041987 | ✅ | ✅ `/tmp/kore-uninui` | ✅ | ✅ | ⚠️ 21:46:20 启动，判定时仅 65s（<3 分钟） | ⚠️ `log/serve.log` 21:47:11 仍在写 | **跳过（活跃）** |

**"同一假设不重复实验"落点**：`dsh-subprocess-*` cgroup 存在本身不等于"被工具调用挂住"——判定改用**ppid 是否已归 systemd + 端口是否有 ESTAB 客户端 + 目录近 3 分钟是否仍有外部写入**三项证据交叉确认，避免按 cgroup 名字一刀切（否则 5 个实例全被误判为"活跃"）。

## 3. 清理动作与结果（先 TERM，2 秒后确认）

```
=== TERM kored 2520580 (t196) ===          kill exit=0
=== TERM orphan chrome 2540181 (t196 同卡) === kill exit=0
=== TERM kored 2548624 (cexec) ===         kill exit=0
=== AFTER 2s ===
pid 2520580 exited / pid 2540181 exited / pid 2548624 exited
```

> 2540181 是 21:29:23 起、ppid=1882 的 headless chrome（`--user-data-dir=/tmp/kore-t196/chrome`），与 2520580 **同一张已死亡的卡**；不先停它就无法安全删除 `/tmp/kore-t196`（否则 chrome 会往已删除目录继续写）。它不是 kored 实例，单独标注。

目录删除（每个都先 `readlink -f` 打印绝对路径 + 前缀守卫，绝无通配符删除）：

```
--- target: /tmp/kore-t196    path guard OK (prefix /tmp/kore-)   49M    rm exit=0  exists_now=no
--- target: /tmp/kore-cexec   path guard OK (prefix /tmp/kore-)   100K   rm exit=0  exists_now=no
```

`rm -rf` 只作用于上面两条**显式绝对路径**；`/tmp` 下其余 150+ 个 `kore-*` 目录与任何非 `kore-*` 路径**一律未动**。

## 4. 清理后复核

```
=== pgrep -af "kored serve"（after） ===
2798902 /home/pt/Work/GolandProjects/kore/bin/kored serve --config .../.kore-local.yaml
2894411 ./kored serve --config /tmp/kore-adp3/config.yaml       ← 活跃，未动
2896509 .../bin/kored serve --config /tmp/kore-wafe2e/config.yaml ← 活跃，未动

=== 188xx 监听（after） ===
127.0.0.1:18874  kored pid=2894411   ← adp3，活跃
127.0.0.1:18873  （无进程信息，非本轮可判定残留）

=== 主实例 ===
127.0.0.1:8787  users:(("kored",pid=2798902,fd=12))
healthz=200
main pid still: 2798902
```

- 已释放：**18882**（t196）、**18879**（cexec）——`ss -ltn` 中已消失；
- 仍占用：18874（adp3，活跃）、18873（未知持有者，只报告）；18872 / 18875 对应的 2845353 / 3041987 在本次清理过程中**自行退出**（非本 agent 所杀，未留证据链，如实记录）；
- 主实例 pid **2798902 未变**，`/-/healthz` 仍 **200**。

**未触碰主实例 8787**：本轮全程未向 8787 发写请求、未改 `.kore-local.yaml`、未动 `.kore-local-state/`、未 kill/restart 2798902；G-29 要求的"本轮是否改动过主实例运行态配置"= **否**。

## 5. 释放空间

| 对象 | 大小 |
| --- | --- |
| `/tmp/kore-t196`（49M） | 49 MiB |
| `/tmp/kore-cexec`（100K） | 0.1 MiB |
| **合计** | **约 49.1 MiB** |

## 6. 未清理项（只报告，留待 owner 收尾）

| 对象 | 原因 | 建议动作 |
| --- | --- | --- |
| 2894411 `/tmp/kore-adp3` | 21:47:50 仍在写 state.db/out.json，疑似在跑的卡 | 该卡 owner 收尾时 `kill -TERM` + 删目录 |
| 2896509 `/tmp/kore-wafe2e` | root transient unit `kore-wafe2e-root.service`，非本轮权限 | `sudo systemctl stop kore-wafe2e-root.service` 后删目录 |
| `/tmp/kore-cexec2`、`/tmp/kore-uninui` | 其 kored（2845353 / 3041987）在清理窗口内自行退出，但 3 分钟内仍有外部写入（同卡可能重试），目录留存 | 对应卡 owner 确认结束后删目录 |
| 18873 端口 | 无进程信息，归属不明 | 只报告，不处理 |

## 7. 建议

1. **统一隔离端口段并登记**：本轮 6 个隔离实例散落在 18872–18882，其中 18873 至今无人认领。建议约定 `18870–18889` 为隔离实例专用段，每张卡在任务卡里写明自己占用的端口，收尾时按号回收。
2. **卡片必须自带收尾三件套**：任务卡模板加一行——"收尾：`pgrep -af 'kored serve'` 只应剩主实例 → `kill -TERM <pid>` → `rm -rf /tmp/kore-<tag>`"。本轮 6 个实例中 5 个是"跑完不管"，说明缺的不是意识而是卡片里的硬字段。
3. **`--config` 目录名带 owner**：建议 `/tmp/kore-<卡名>-<owner>`，本次 `kore-cexec` 与 `kore-cexec2`、`kore-wafe2e` 与 `kore-wafv` 仅凭名字无法判断归属，是判定成本的主要来源。
4. **孤儿识别自动化**：`ppid=1882(systemd --user)` + 无 ESTAB 客户端 + 目录 3 分钟无写入，三项同时成立即可判死；建议做进 `make` 一个只读目标（如 `make orphan-report`），避免每次人工逐个 `/proc` 取证。
