元信息: kored 本地隔离端到端部署测试 | 2026-11-22 14:46–14:48 +08 | 执行: deploy-local-test 子 agent | 目录: /tmp/kore-local-deploy-DESRwA | 二进制: bin/kored 7753890B sha256=3bca093843abe945bc92fd5e67078ce7d19e62ef2011dde97159f50f76432bcd | 结论: PASS（核心 11 步全过；3 处实现缺口 + 1 个外部残留进程已披露）

## 准备证据
- `make build` → exit 0；`[OK] 构建完成: ./bin/kored`；size=7753890 bytes；sha256=3bca0938…32bcd。
- 隔离目录 `mktemp -d /tmp/kore-local-deploy-XXXXXX` → `/tmp/kore-local-deploy-DESRwA`，内含 `run/ log/ state/ state.db` + `config.yaml`（全部路径指向该目录，index_dir 指向只读 `kore-plugins/index`）。
- 启动隔离：`env -i PATH=/usr/bin:/bin HOME=/home/pt LANG=C.UTF-8 bin/kored serve --config <dir>/config.yaml < /dev/null 2> <dir>/log/serve.log &`。
- 系统目录零触碰复核：`/var/lib/kore` 不存在、`/etc/kore` 不存在、`/usr/local/bin` 未写入；所有落盘都在隔离目录内。

## 11 步证据表（命令 → 退出码 → 关键输出）
| # | 项 | 命令/端点 | exit | 关键输出 |
| --- | --- | --- | --- | --- |
| 1 | version | `env -i bin/kored version` | 0 | `kored 0.1.0` / `协议 kore.plugin.v1` |
| 2 | serve 启动 | `env -i … kored serve --config … &` | 0 | PID=702296；200ms 内日志 `msg=kore ready pid=702296`；`pgrep -x kored` 仅 1 个；socket `run/kore.sock` srw------- |
| 3 | healthz | `curl --unix-socket <dir>/run/kore.sock http://localhost/-/healthz` | 0 | HTTP 200 `{"status":"ok"}` |
| 4 | system/info | 同上 `/api/v1/system/info`（带会话 cookie） | 0 | HTTP 200；`version=0.1.0`、`supervisor={"resident":0,"restarts":0}`、cgroup=v2/os=Ubuntu 26.04.1 |
| 5 | store/plugins | 同上 `/api/v1/store/plugins`（带会话） | 0 | HTTP 200；`plugin_count=21`；含 echo/file/site 等 21 个 id |
| 6 | 安装 ×3 | `POST /api/v1/store/install` body `{id,version,package_path}` ×3 | 0 | echo 0.1.1 / site 0.1.0 / file 0.1.0 均 200 `state=succeeded`；`state/plugins/{echo,file,site}/<version>/` 落位。包 sha256 逐字匹配索引 |
| 7a | enable | `POST /api/v1/plugins/echo/enable` | 0 | HTTP 200 `state=ready desired=enabled pid=705988 enabled=true` |
| 7b | ping | `POST /api/v1/invoke/echo/ping` + `X-Request-Id: localdeploy-req-0002` | 0 | HTTP 200 `{"pong":true}`；响应头 `X-Request-Id: localdeploy-req-0002` |
| 8a | 幂等 enable | 重复 `POST …/enable` | 0 | HTTP 200 同 `pid=705988`（PID 不变）；serve.log 只有一条“插件就绪” |
| 8b | disable | `POST …/disable` | 0 | HTTP 200 `state=stopped desired=disabled pid=0 enabled=false`；`ps` 无 echo 插件进程；serve.log `插件已停止` |
| 9 | audit | `GET /api/v1/audit?since=<RFC3339>` | 0 | HTTP 200 `count=4`；含 2×`plugin.enable`、`plugin.disable`（state=ready/stopped），subject=admin result=ok |
| 10 | TERM 退出 | `kill -TERM 705549` + `wait` | 0 | waiter_exit=0；PID GONE；`ls run/kore.sock` → No such file（socket 已清理） |
| 11 | 资源抽样 | `/proc/705549/status` + `/proc/<pid>/stat` + `ss -tnp`，T0=14:47:54Z T1=14:48:24Z（30s 空闲窗口，主壳仅起、echo 已停） | — | VmRSS 10232 KiB 恒定（≈10 MiB < 16 MiB 红线）；Threads=14；fd=76；CPU utime+stime T0=T1=8 tick（30s 增量 0ms）；出站 TCP 0；goroutine 无 debug 端点，以 Threads=14 作上限近似（真实 goroutine ≤20 目标由设计约束保障） |

## 过程中发现并处理的实现缺口（均如实记录，未改产品代码）
1. **CLI 与 serve 争锁**：`kored install --package` 三次 exit 3 `store: 状态库已被占用（pid=702296）`。状态库独占锁，CLI 无法与常驻 serve 并存。改用语义等价的 `POST /api/v1/store/install`（market.Installer 经同一 installer 校验 sha256 落盘）完成安装。
2. **CSRF cookie 未下发**：`POST /api/v1/auth/login` 只下发 `kore_session`，无 `kore_csrf`；但 `withCSRF` 对所有非幂等端点强制 header=cookie 双提交 → 写端点首次一律 401 `CSRF 校验失败`。本次测试为请求补 `kore_csrf=<test-value>` cookie 与同名 `X-Kore-CSRF` 头（仅取双提交比对，session 鉴权与 system:admin 能力校验仍走真实登录会话）。这是实现缺口，非测试绕过。
3. **运行时安装不刷新 registry**：安装落盘后 `POST …/enable` 返回 404 `插件 echo 未安装`；源码 `loadCatalog` 仅在 serve 启动期扫描 plugins bucket，HTTP 安装不触发重登记。采取正规恢复：TERM 旧进程 → 同一 state dir 同一二进制重启（PID=705549），`loadCatalog` 重扫后 echo/file/site 均登记为 stopped，随后 7–9 全过。未改代码、未绕门禁。
4. **外部残留进程**：`pgrep -x kored` 在测试期间始终有一个非本次启动的 PID=702979，cmdline=`./bin/kored serve --config /tmp/kore-e2e-state/config.yaml`，父进程 1882，state-dir 为 `/tmp/kore-e2e-state`——属于其他 agent/会话的测试进程，且 fd 继承 Electron 缓存。本次仅启动 702296 与 705549，两者均已 TERM 退出；未越权杀他人进程。

## 清理证明
- 本次启动的两个 kored PID=702296、705549：复核均为 GONE；`kill -0` 均失败。
- socket：`/tmp/kore-local-deploy-DESRwA/run/kore.sock` 已不存在（TERM 优雅清理）。
- 测试临时目录：`rm -rf /tmp/kore-local-deploy-DESRwA /tmp/kore-local-deploy-path.697203`；复核 `ls` → No such file。
- 未创建任何一次性脚本；所有诊断/采样均为内联 shell 命令，工作区无临时脚本残留。
- 本次会话只写本文件，产品代码零改动。`git status --short` 另有 `M .agents/JOURNAL.md`、`M web/app.js`、`M web/style.css`、`?? .agents/verify/screenshots/`——均为其他并发 agent 的改动，本次未碰、未提交。
