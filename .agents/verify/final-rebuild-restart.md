> 元信息: 2026-11-24T01:44–01:48+08:00 · 执行者 final-rebuild-restart 子 agent · 主实例重建+重启+运行态验收 · 报告 ≤120 行

# 主实例重建到 HEAD 二进制 + 重启验收

## 0. 结论（一句话）

`make build` 后 `systemctl --user restart kored-local` 一次成功：新 pid **3409175** 的 `/proc/exe` sha **等于** `bin/kored` sha（`ab5627af…`），healthz 200，cgroup 在 `kored-local.service` 且不含 `dsh-subprocess`，journal 无 error/panic/fatal；五条运行态验收中 4 条取到原文，`kore_session` 的 HttpOnly 因**需登录**未取运行态证据（源码+httptest 响应头断言为证）。`.kore-local.yaml` 前后完全一致。

## 1. 重建（make build）

| 项 | 重建前 | 重建后 |
| --- | --- | --- |
| `bin/kored` sha256 | `979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997` | `ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6` |
| size | 10420386 | 10494114 |
| mtime | 2026-11-23 23:21:52.693624731 +0800 | 2026-11-24 01:45:22.444934926 +0800 |

```
$ make build
[OK] 构建完成: ./bin/kored        # exit=0
$ go version -m bin/kored | head -3
bin/kored: go1.26.8
	path	github.com/pengtang1024/kore/cmd/kored
	mod	github.com/pengtang1024/kore	(devel)
```

- 旧二进制 mtime 之后的提交数（实测）：`git rev-list --count --since='2026-11-23 23:21:52' HEAD` = **57**（任务卡写 52，以实测为准）。
- 构建 HEAD：`71cf55b`（`[agent:independent-verify] docs(verify): …17 段门禁…`）。

## 2. 重启前后六项对照

| # | 项 | 重启前 | 重启后 |
| --- | --- | --- | --- |
| 1 | healthz | `200 {"status":"ok"}` | `200 {"status":"ok"}` |
| 2 | 8787 pid | 1387457（23:24:57 启动） | **3409175**（01:45:41 启动） |
| 3 | `/proc/<pid>/exe` sha | `979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997` | `ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6` |
| 4 | `bin/kored` sha | `979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997` | `ab5627afb77618932a5683f0030ed12327a6ffae53e6e5395bc6e090476f41b6`（**与 #3 相等**） |
| 5 | `/proc/<pid>/cgroup` | `0::/user.slice/user-1000.slice/user@1000.service/app.slice/kored-local.service` | 同左（**无 `dsh-subprocess`**） |
| 6 | `.kore-local.yaml` | size=1677 mtime=2026-11-23 04:59:58.799907899 sha=`59957ee1…570d3c` | **完全一致** |

重启命令与结果（唯一使用的方式，未用 setsid/nohup/pkill/kill）：

```
$ systemctl --user restart kored-local      # exit=0 @ 2026-11-24T01:45:41+08:00
$ sleep 2; systemctl --user is-active kored-local
active                                      # exit=0
$ systemctl --user show -p ActiveState -p SubState -p MainPID -p ExecMainStatus kored-local
ActiveState=active
SubState=running
MainPID=3409175
ExecMainStatus=0
```

## 3. 运行态验收原文

```
GET /api/v1/system/info    -> HTTP 401  {"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
GET /api/v1/system/upgrade -> HTTP 401  {"code":"E_UNAUTHORIZED","message":"未授权","detail":""}   # 不是 501
GET /                       -> HTTP 200  <!doctype html> … <title>Kore · 控制台</title>
```

**真实浏览器**（Chrome for Testing 156.0.8078.4 = `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`，`--headless=new` + 手写 CDP，未装新依赖）：

```json
{"ready":"complete","title":"Kore · 控制台","url":"http://127.0.0.1:8787/","pw":1,"forms":1,
 "cookie":"kore_csrf=oOFJLqiZCTbJayW8UpyArPUvC1PiPzztLcqaosnyfik","hasLoginText":true}
```

- `input[type=password]` 数 = **1**（静态 HTML 中为 0，登录表单由 SPA 渲染，故必须真浏览器）。
- `document.cookie` 含 **`kore_csrf`**。

**Set-Cookie 属性**（`curl -D -`，GET `/`）：

```
HTTP/1.1 200 OK
Set-Cookie: kore_csrf=oOFJLqiZCTbJayW8UpyArPUvC1PiPzztLcqaosnyfik; Path=/; SameSite=Strict
```

- `kore_csrf`：**无 `HttpOnly`**（浏览器侧 `Network.getCookies` 同证：`{"name":"kore_csrf","httpOnly":false,"sameSite":"Strict","secure":false}`；127.0.0.1 非 TLS 故无 Secure）。
- `kore_session`：**运行态未取证（需登录）**。`kore_session` 只在口令校验通过后由 `s.auth.SetCookie(w, token)` 下发（`internal/core/httpapi/handlers_auth.go:69→82`），本机引导只补发 `kore_csrf`（`csrf_local.go:59`）；任务禁止改口令/配置，故不发起登录（登录失败也会写审计与限速，且会破坏 §5 的零写入口径）。
  - 替代证据（同一属性契约，真实 httptest 响应头断言）：`go test ./internal/core/httpapi -run TestLoginSetsCSRFCookie -v` → **PASS（0.01s）**，断言 `kore_session.HttpOnly=true`、`kore_csrf.HttpOnly=false`；源码 `internal/core/auth/session.go:296` `HttpOnly: true, Secure: m.secure, SameSite: Strict`。

**journal**（`journalctl --user -u kored-local -n 60 | grep -iE "error|panic|fatal"`）：**无**。重启后日志末行 `{"level":"INFO","msg":"kore ready","pid":3409175,"version":"0.1.0","addr":"127.0.0.1:8787"}`。

## 4. 配置零改动证据

| 项 | 前 | 后 |
| --- | --- | --- |
| `.kore-local.yaml` size | 1677 | 1677 |
| `.kore-local.yaml` mtime | 2026-11-23 04:59:58.799907899 | **同左（未变）** |
| `.kore-local.yaml` sha256 | `59957ee18e95f6c1086f4602c4a45e943c79bf3dfb233af4792159c771570d3c` | **同左** |

`.kore-local-state/` 在 01:44 之后只有两个文件变动，**均发生在 01:45:41 的 kored 启动瞬间**（本执行者没有任何写状态目录的命令）：

```
2026-11-24 01:45:41.571332665  .kore-local-state/state.lock
2026-11-24 01:45:41.787337157  .kore-local-state/state.db   # size 仍 2097152；sha 85274a29…→d1fc65b8…
```

即：`state.db` 因重启自身初始化（会话/授予回填）而写，**不是本轮验收操作写入**；除此之外无新增/修改文件。`.kore-local-run/`（socket）由服务重连重建，属预期运行态。

## 5. 本轮是否改动过运行态配置（声明）

**否。** 本轮仅执行：`make build`（写 `bin/kored`）+ `systemctl --user restart kored-local` + 只读取证。未改 `.kore-local.yaml`、未改 `.kore-local-state/`、未改索引、未改口令、未用 setsid/nohup/pkill/kill、未杀任何进程。

## 6. 缺口与偏差（不粉饰）

1. `index_dir`：**需登录，未验证**。`GET /api/v1/system/info` 未登录 401；未改主配置/口令故无法取 `paths.index_dir` 运行态值。配置文件只读值为 `index_dir: "/home/pt/Work/GolandProjects/kore-plugins/index"`（`kore-local.yaml:12`）。
2. `kore_session` HttpOnly：运行态需登录未取证（见 §3），以源码+单测响应头断言为证，**未伪造**。
3. 8787 上未发现其他隔离实例残留（`ss -lntp` 仅 pid 3409175 监听），无需报告处置。
4. 提交数实测 57 ≠ 任务卡 52；共享工作树当时另有他人未提交的 `Makefile`、`scripts/canonical-check.sh` 改动，本提交只含本文件。
