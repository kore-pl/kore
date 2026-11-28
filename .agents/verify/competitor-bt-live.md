# 宝塔面板真机实测（隔离 Docker 同口径一手数据）

> 日期：2026-11-28（Asia/Shanghai）｜写域：本文件（`.agents/verify/competitor-bt-live.md`）｜任务卡：task-350（承接 task-349 预检）
> **性质**：本机单机、单容器、非生产的一手实测；只给数据，**不作"全面超越竞品"断言**。
> **口径提醒**：官方装机量／1Panel 94MB 等数字属声明级，**不与本文真机数据混排**。

---

## 0. 隔离边界与未触碰项（开工/收尾双回读）

| 项 | 实测值 |
| --- | --- |
| 宿主 | 24C / 61.26 GiB（容器 `docker stats` 分母一致）；uid=1000 |
| 容器名 / 镜像 | `bt-bench-r54` / `btpanel/baota:latest`（仅 `docker pull` 此官方镜像） |
| 网络 | `docker network create --driver bridge --subnet 172.31.254.0/24 bt-bench-r54-net`（**未用 `--net=host`**） |
| 端口映射 | `-p 127.0.0.1:18888:8888`（宿主高位端口，未碰 80/443/8888/22） |
| 卷 | `-v /home/pt/Work/GolandProjects/kore-pl/.bench-r54/bt-data:/www/wwwroot/bench-data`（工作区临时目录，**非 /tmp**；`kore/.git/info/exclude` 加 `/.bench-r54/` 标记行，收尾删除） |
| kore 侧 | 两隔离实例：`127.0.0.1:18890`（主壳）/ `127.0.0.1:18891`（主壳+插件），config/state/run/log/index 全落 `.bench-r54/kore/{shell,plugin}/`，**非 8787** |
| 未触碰 | 8787 主实例、`.kore-local-*`、宿主 `data/initial-admin-credential`、`/etc/ssh`、宿主 80/443/8888/22、宿主 `bin/kored`（只读复制）、任何业务联网 |
| 凭据 | 仅从容器内 `default.pl` / kore 隔离 `initial-admin-credential` 在进程内读取；**不进 argv、不进日志、不进本报告**；报告内均为 `[REDACTED]` |
| harness | 一次性脚本 `sample-bt.sh` / `bt-ops.py` / `bt-login2.py` / `kore_enable.py` 用完即删（已回读确认不存在） |

开工端口回读（命令 + 退出码）：

```
$ for p in 18888 18890; do ss -ltn | grep -q ":$p " && echo "$p BUSY" || echo "$p FREE"; done
  PORT 18888 FREE
  PORT 18890 FREE
$ docker ps -a --filter name=bt-bench-r54 --format '{{.Names}} {{.Status}}'
  (空)  EXIT=0
```

---

## 1. 安装耗时

### 1.1 `docker pull` 单独计时

```
$ docker pull btpanel/baota:latest        # 首试相对日志路径写错，pull 未发起（EXIT=1, 无镜像动作）
$ T0=$(date +%s.%N); docker pull btpanel/baota >>$BASE/logs/pull.log 2>&1; RC=$?; T1=$(date +%s.%N)
  EXIT=0
  WALL_SECONDS=61.339
原文摘录：
  Using default tag: latest
  latest: Pulling from btpanel/baota
  ...
  Digest: sha256:12d72112dd604953f0f3fffcd5ce3f96a5e49662ff299cb1e71712aed1883def
  Status: Downloaded newer image for btpanel/baota:latest
```

### 1.2 `docker run` → 面板 HTTP 200 墙钟

```
$ docker image inspect btpanel/baota:latest --format '{{json .Config}}'
  Entrypoint=['/bin/sh','-c','/bt.sh'] Cmd=None ExposedPorts={22,80,443,888,8888,3306}
$ docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep btpanel
  btpanel/baota:latest 2.56GB

$ docker rm -f bt-bench-r54      # 清掉首个容器，取真实冷启动
  EXIT=0  bt-bench-r54
$ T0=$(date +%s.%N); docker run -d --name bt-bench-r54 --network bt-bench-r54-net \
    -p 127.0.0.1:18888:8888 -v $BASE/bt-data:/www/wwwroot/bench-data btpanel/baota:latest
  EXIT=0  DOCKER_RUN_WALL_SECONDS=0.134（首轮）
  轮询 UA=browser GET /btpanel 至 HTTP200：
  HTTP200 at poll 8 → RUN_TO_HTTP200_WALL_SECONDS=3.941（冷启动，含 0.5s 轮询粒度）
```

---

## 2. 首屏可达（随机安全入口，非猜测）

安全入口从**容器内** `/www/server/panel/data/admin_path.pl` 读取（退出码 0）：`/btpanel`（文件 mode 0600，9 bytes）。默认端口从 `data/port.pl` 读：`8888`。

**重要实测细节**：宝塔有客户端指纹门（`class/public.py:check_client_info`），非浏览器 UA／未登记 IP 返回 nginx 404（`Server: nginx`，146 bytes）；用浏览器 UA 后才拿到首屏。这是真机行为，如实记录。

```
$ curl -sS -o /dev/null -w 'http=%{http_code} bytes=%{size_download}\n' http://127.0.0.1:18888/
  http=404 bytes=146        （无浏览器 UA，安全入口/指纹门）
$ curl -sS -A '<browser UA>' -o /dev/null -w ... http://127.0.0.1:18888/
  http=404 bytes=146
$ curl -sS -A '<browser UA>' -D ... -o ... -w \
   'http=%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
   http://127.0.0.1:18888/btpanel
  run1 http=200 bytes=30569 ttfb=0.058982s total=0.059056s
  run2 http=200 bytes=30569 ttfb=0.057579s total=0.057653s
  run3 http=200 bytes=30569 ttfb=0.024618s total=0.024729s
  curl EXIT=0
首屏标题原文：<title>宝塔Linux面板</title>
服务器侧 `logs/request/2026-11-28.json` 原文条目（摘录）：
  ["2026-11-28 15:13:24", "172.31.254.1:58292", "GET", "/btpanel?", "<browser UA>", "{}", 58, 200, 30569, "text/html; charset=utf-8", "127.0.0.1:18888", "None"]
```

kore 侧同口径（另起隔离实例，`GET /` 无需登录门，返回静态壳）：

```
$ curl ... http://127.0.0.1:18890/        # 主壳
  run1 http=200 bytes=1551 ttfb=0.001526s
  run2 http=200 bytes=1551 ttfb=0.000968s
  run3 http=200 bytes=1551 ttfb=0.000780s
$ curl ... http://127.0.0.1:18891/        # 主壳+插件
  run1 http=200 bytes=1551 ttfb=0.001079s
  run2 http=200 bytes=1551 ttfb=0.000803s
  run3 http=200 bytes=1551 ttfb=0.002264s
首屏标题原文：<title>Kore · 控制台</title>
```

---

## 3–5. 空载 RSS / CPU / fd / 线程（60s 稳定后）

### BT（容器，稳定后 20×3s `docker stats --no-stream`）

```
$ echo started; P0=$(docker exec ... awk '{print $14+$15}' /proc/400/stat); sleep 60; P1=...
  PANEL_TICKS_T0=29  PANEL_TICKS_T1=31  PANEL_CPU_DELTA_TICKS=2 OVER_60s  (100 ticks/s → 0.033% 主进程)
$ for i in $(seq 1 20); do docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}|{{.PIDs}}' bt-bench-r54; sleep 3; done
  20 个样本原文见 .bench-r54/logs/bt-idle-clean.txt（本次临时资产，收尾删）
  解析：n=20 min=149.1MiB max=150.7MiB median=149.65MiB（docker stats 口径，含整个容器所有进程/缓存）
$ docker exec bt-bench-r54 sh -c 'grep -E "VmRSS|Threads" /proc/400/status'  # 20×1s
  VmRSS: 81292 kB（20/20 完全一致，中位数=81292 KiB）｜Threads: 1（主面板进程）
$ docker exec bt-bench-r54 sh -c 'echo FD_COUNT=$(ls /proc/400/fd|wc -l); ...'
  FD_COUNT=7  THREAD_DIRS=1  Uid: 0 0 0 0
```

**RSS 口径必须分清（不可只报一个数）**：`docker stats` 容器口径中位数 **149.65 MiB**（含 BT-Panel / BT-Task / tools.py / exim4 / cron / sshd / dbus 等 23–24 个 PID）；`BT-Panel` 主进程 `VmRSS` 中位数 **81,292 KiB ≈ 79.39 MiB**；主进程+面板相关子进程的 `ps` RSS 快照合计约 **293,484 KiB**（一次性快照，非中位数；一次 `check502Task` 任务期曾冲到 242.5MiB / 100% CPU，任务结束后回落到 149MiB / 0.03–0.1%——这是单体自带后台任务调度导致的波动，如实记录，不 cherry-pick）。

### kore 隔离实例（同 60s 稳定窗口，两行口径）

| 口径 | 首屏 HTTP/字节/TTFB | 空载 VmRSS 中位数（20×1s） | CPU（120s utime+stime 差） | fd | 线程 |
| --- | --- | --- | --- | --- | --- |
| 主壳（shell，18890） | 200 / 1551 B / 0.000780–0.001526s | 14,460 KiB（20/20 一致） | 0 ticks / 120s | 79 | 14 |
| 主壳+插件（plugin，18891，terminal 0.2.2 resident 已 enable） | 200 / 1551 B / 0.000803–0.002264s | 主壳 14,840 KiB + 插件进程 6,456 KiB（各 3/3 一致） | 主壳 1 tick / 120s（enable 场景并行测得；另一次 disabled 场景 1 tick / 120s） | 主壳 82 + 插件 76 | 主壳 15 + 插件 5 |

```
$ # 主壳（单次 bash 调用内起服→首屏→sleep60→20×/proc 采样→CPU→kill，进程不跨调用存活）
  READY_POLL=2 healthz_http=200
  CPU_TICKS_T0=9 T1=9 DELTA_120s=0 TICKS_PER_SEC=100
  VmRSS: 14460 kB (×20)   Threads: 14 (×20)   FD_COUNT=79 THREAD_DIRS=14
  TERM_EXIT=0
$ # 主壳+插件（先 install terminal 0.2.2，再 serve + 脚本登录 enable）
  install: installed terminal 0.2.2 / EXIT=0
  POST /api/v1/auth/login → http=200 {"authenticated":true,...} EXIT=0
  POST /api/v1/plugins/terminal/enable → http=200 {... "state":"ready","desired":"enabled","pid":27,"enabled":true} EXIT=0
  日志：{"msg":"插件就绪","plugin_id":"terminal",...}
  ps：PID 4 kored RSS 14840 KB；PID 27 terminal RSS 6456 KB（PPID=4）
  VmRSS main=14840 child=6456（×3）  MAIN_FD=82 THREADS=15  child27 FD=76 THREADS=5
  TERM_EXIT=0
```

**诚实注记**：kore 主壳 fd=79/82，**高于仓库 G-03 文案的 64**（本轮暴露的偏差，如实记录、不自行改代码）。原因需专项分析（沙箱内 bwrap/PID namespace 与本机 TCP+UDS 双监听下的 fd 组成），本卡只报告观测值。VmRSS 中位数 14.4–14.8 MiB 在仓库 **≤16 MiB 硬红线内**，但未达 8 MiB 目标值。

---

## 6. 典型操作（建站点 / 建数据库 / 建计划任务）

**BT：NOT VERIFIED（未成功执行，不伪造）**。已尝试脚本化登录（RSA 加密走 `vite_public_login_token` + `vite_public_encryption`，见 `class/public.py`、`BTPanel/__init__.py:login`），但：

```
GET /btpanel (browser UA + cookie jar) → http=200 bytes=30569，cookie 1 个
POST /login（用 default.pl 中口令的 MD5+_bt.cn 加密）→ http=200
  {"status": false, "msg": "用户名或密码错误,您还可以尝试[4]次!"}
POST /login（用 admin 候选，DB 中 users.password 前缀 21232f297a57 = md5(admin)）→ http=200
  {"status": false, "msg": "用户名或密码错误,您还可以尝试[3]次!"}
```

因此**未进行任何写操作**；随后只读回读确认无副作用：`vhost/nginx/` 无新增站点配置、`data/` 无数据库文件、`crontab.db` 无 cron 表。失败原因未完全定位（可能为镜像预置凭据与 `default.pl` 不一致、或用户名哈希算法差异），不猜测、不继续爆破（避免锁定账户）。三项计时：**NOT VERIFIED**。

kore 侧同口径的等价写操作（登录 → 安装/启用插件）已实测：登录 0.084s、enable resident 插件 0.022s（`terminal` 进程 3s 内 `插件就绪`）；这与 BT 的"建站点/数据库/计划任务"**不是同一业务动作，不横向比较耗时**。

---

## 7. 安全默认（一手观察）

| 项 | BT 真机观察 | kore 真机观察 |
| --- | --- | --- |
| 运行身份 | `ps -eo user,...` 面板主进程 `BT-Panel` = **root**（Uid 0/0/0/0）；`bt.sh`、BT-Task 均 root | `ps -p <pid> -o user` = **pt (uid 1000)**；日志原文 `kored 非 root：插件降权未生效（插件与内核同 uid）` |
| 默认端口 | `data/port.pl` = **8888**；容器内 `ss -lntp` 见 `0.0.0.0:8888` + `0.0.0.0:22`（sshd） | 隔离实例按指定 `127.0.0.1:18890/18891`；生产默认 UDS/回环（裁决37/ADR-0043，本卡非生产配置） |
| 随机安全入口 | `data/admin_path.pl` = `/btpanel`（mode 0600）；**镜像内预置**（mtime 2026-10-24，早于本次启动 2026-11-28），未见首启重新随机化；且需浏览器 UA 过客户端指纹门 | 无安全入口；登录页固定，防线是会话校验 + CSRF 双提交 + 本机 UDS/回环（架构口径，非路径隐蔽） |
| 口令落盘 | `/www/server/panel/default.pl`：mode **0600**、size 9、单行纯 alnum、mtime 2026-10-24（**镜像预置，非本次首启生成**）；值为明文（未读取/未打印）；`users` 表 password 字段 len=32，前缀 `21232f297a57`（=md5("admin")，未打印全文） | `state/initial-admin-credential`：mode **0600**、size 51、两行 `username:` / `password:`，首启自动生成，日志只打印路径不打印值；消费后删 |
| 首启强制改密 | 本镜像用户表预置 md5(admin)，**未见强制改密**；登录 API 返回可尝试次数（有限次锁定） | 首启生成本机凭据，日志原文「建议登录后设置一个新口令（可选，不强制）」——**非强制**，与任务卡早期口径一致（见 `admin_password.go` / ADR-0055 §8 后续修订） |

---

## 8. 不可比项（单列，严禁横向排名）

1. **架构不同**：kore = 薄壳 + 独立插件进程（≤16 MiB 主壳红线、单插件 ≤24 MiB）；BT = 单体自带 Python 面板 + BT-Task + Nginx/MySQL/PHP 生态（容器镜像 2.56 GB）。资源数字只作各自口径的事实记录，**不构成谁"全面超越"谁**。
2. **kore 不内置 web server**（裁决37）；BT 容器自带 nginx 反代/静态服务，故"首屏"背后的软件栈不同。
3. **官方声明数字不混排**：BT "2000 万装机"、1Panel "94MB" 等为官方网页声明，非本次真机；本次未安装 1Panel。
4. **无同版本同硬件严格对齐**：BT 用 `btpanel/baota:latest`（镜像 digest `sha256:12d72112…`），kore 用本机 `bin/kored 0.1.6`（sha256 `62eb4dc5…`）；两者非同语言/同发布节奏；宿主 24C/61GiB 但均为单机单容器/单实例，非生产负载。
5. **RSS 口径**：`docker stats`（容器 cgroup 口径，含缓存与所有 PID）≠ `/proc/<pid>/status VmRSS`（单进程常驻集）；本文两口径并列，取中位数，不以单一数字代表整体。
6. **BT 首屏依赖客户端指纹门**：不同 UA / 是否登记 IP 会改变 HTTP 状态（404↔200）；kore 首屏无此门，不能直接对比"可达性"数值。

---

## 9. 结论（只给数据，不给"超越"判定）

- 宝塔官方镜像在本机隔离容器**可拉起、可访问**（冷启动 pull 61.339s、run→HTTP200 3.941s、首屏 30,569 B / TTFB 25–59ms），安全入口从容器配置读取为 `/btpanel`，默认 root + 8888 + 预置明文凭据文件（0600）。
- 空载稳定后：BT 容器 `docker stats` 中位数 **149.65 MiB**（主进程 VmRSS **81,292 KiB**），kore 主壳 **14,460 KiB**、主壳+resident 插件 **14,840 + 6,456 KiB**；CPU 均近零（BT 主进程 2 ticks/60s，kore 主壳 0–1 tick/120s）。
- BT 的三项典型写操作**未验证**（登录未成功），kore 的登录 + 插件启用已验证；此差异是"可脚本化路径"差异，不是功能有无的结论。
- 本轮暴露偏差一条：kore 隔离实例 fd 79/82 高于仓库文案的 64，已如实记录，不在本卡内修改生产代码。

---

## 10. 收尾清理（回读）

```
$ docker rm -f bt-bench-r54
  EXIT=0  输出：bt-bench-r54
$ docker network rm bt-bench-r54-net
  EXIT=0  输出：bt-bench-r54-net
$ python3 - <<'PY'   # 删除 .git/info/exclude 中本轮添加的两行标记（精确字符串）
  p=".git/info/exclude"; s=open(p).read()
  s=s.replace("# competitor-bt-r54 temporary bench assets (removed at cleanup)\n/.bench-r54/\n","")
  open(p,"w").write(s)
PY
  EXIT=0
$ rm -rf /home/pt/Work/GolandProjects/kore-pl/.bench-r54
  EXIT=0
```

回读：

```
$ docker ps -a --filter name=bt-bench-r54 --format '{{.Names}} {{.Status}}'
  (空)  EXIT=0                         → 容器已删
$ docker network ls --filter name=bt-bench-r54-net --format '{{.Name}}'
  (空)                                  → 网络已删
$ ls -ld /home/pt/Work/GolandProjects/kore-pl/.bench-r54
  No such file or directory            → 临时卷目录已删
$ tail -5 kore/.git/info/exclude
  （末行 /.deploy-tmp/，本轮两行标记已消失）
$ find ... -name 'sample-bt.sh' -o -name 'bt-ops.py' -o -name 'bt-login2.py' -o -name 'kore_enable.py'
  (空)                                  → 一次性 harness 全删
$ for p in 18888 18890 18891; do ss -ltn | grep ...; done
  18888 FREE / 18890 FREE / 18891 FREE
```

镜像 `btpanel/baota:latest` 保留在宿主 Docker 镜像缓存（未 `docker rmi`，因为镜像非本轮创建的临时资产、删除会影响其他使用者）；容器/网络/数据卷/脚本/exclude 标记均已清除。
