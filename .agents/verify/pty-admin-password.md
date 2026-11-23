> 状态: final · 归属: verifier · 更新: 2026-11-23 · 里程碑: M5

# 真 PTY 验证：`kored admin-password` 关回显 + 首启 TTY 引导

**对象**：`e06a2fa` 的 `kored admin-password`（`tty_linux.go` 的 TCGETS/TCSETS 关回显、`serve` 首启 TTY 引导）。作者自报「只经单测注入 prompt 覆盖，未在真 PTY 手工跑」；本报告补真 PTY 证据。

**方法**：`python3` + `pty.fork()` / `select` 起真伪终端，父进程读 master 原始字节、按提示写入口令；**不经过任何单测注入点**。隔离环境：`/tmp/kore-pty-191`（config/state/run/log 全在 /tmp），**未读写主实例 8787、未重启**。口令以 `***` 占位，原始输出中已断言不含明文。

## 1. `admin-password --set`（真 PTY，两次一致）

命令：`./bin/kored admin-password --set --config /tmp/kore-pty-191/kore.yaml`（PTY 内）

原始输出（节选，口令以 *** 代）：

```
请输入新的管理员口令（输入时不回显）: 
请再输入一次确认: 
已将口令哈希写入 /tmp/kore-pty-191/kore.yaml（权限 0600）
提示：重启 kored 后生效；忘记口令可再执行 `kored admin-password --set` 重置。
```

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| a) 口令未回显 | **PASS** | 原始输出中 `***` 出现 0 次；两次输入位置只有 `\r\n`（提示后直接换行），无字符回显 |
| b) 不一致时报错 | 见 §2 | — |
| c) 成功写 0600 且口令可用 | **PASS** | `stat -c %a` = **600**；配置含 `admin_password_hash`；随后首启实例 `POST /api/v1/auth/login` 用该口令 **200 + Set-Cookie**（§3） |
| 进程退出码 | **0**（`waitpid` raw 0） | — |

## 2. `--set` 两次不一致（真 PTY）

```
请输入新的管理员口令（输入时不回显）: 
请再输入一次确认: 
两次输入不一致，未写入配置；请重试。
```

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 报错文案 | **PASS** | 含「两次输入不一致，未写入配置」 |
| 不写哈希 | **PASS** | 配置内 `admin_password_hash` 不存在 |
| 口令未回显 | **PASS** | 原始输出不含 `***` |
| 退出码 | **非 0**（raw 512 → exit 2，配置错误码） | — |

## 3. 首启 TTY 分支（`serve`，无哈希，端口 18885）

前置：`ss -ltn | grep 18885` → 空（端口空闲）。配置：`server.addr: 127.0.0.1:18885` + `/tmp` 下 state/run/log，**无** `auth.admin_password_hash`。

原始输出（节选）：

```
{"time":"...","level":"INFO","msg":"资源锚点",...}
还没有管理员口令，面板无法登录。现在设置一个（直接回车跳过，稍后用 `kored admin-password --generate`）。
请输入新的管理员口令（输入时不回显）: 
请再输入一次确认: 
```

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 真进交互引导 | **PASS** | 出现「还没有管理员口令…现在设置一个」+ 两次口令提示 |
| 口令未回显 | **PASS** | 原始输出不含 `***` |
| 写入配置 | **PASS** | 配置出现 `admin_password_hash`；首启进程未重启即接受新口令 |
| 热重载后直接登录 | **PASS** | `POST http://127.0.0.1:18885/api/v1/auth/login` `{"password":"***"}` → **200**，响应带 `Set-Cookie` |
| 清理 | **PASS** | SIGTERM 退出；`ss -ltn` 18885 已释放；`/tmp/kore-pty-191` 已删 |

> 说明：首启输出中「已写入 …」一行在本次抓取窗口内未读到（父进程在确认输入后 1s 即去登录），但**哈希落盘 + 同一进程 200 登录**已证明写入与热重载生效；文案行本身未作为断言。

## 4. 非 TTY 对照（管道 stdin）

命令：`printf '%s\n%s\n' "***" "***" | ./bin/kored admin-password --set --config /tmp/kore-pty-191/kore.yaml`

```
当前标准输入不是终端，无法交互设置口令。
请改用管道：`printf '%s' "$PW" | kored admin-password --set --stdin`，
或执行 `kored admin-password --generate` 让 kored 自己生成一个。
```

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 只提示、不阻塞 | **PASS** | 5s 超时内立即返回，exit **2**；无 TTY 等待 |
| 不写哈希 | **PASS** | 配置未变 |

## 5. 结论

- 真 PTY 下三条断言全部成立：**口令未回显**、**不一致报错且不写**、**成功 0600 且可登录**；首启 TTY 分支确实进入交互引导，设置后**同进程热重载即可登录**（无需重启）；非 TTY 管道只提示不阻塞。
- **未发现需要报告的缺陷**（无回显泄漏、无卡死、无权限问题）。
- 主实例 8787：本轮**零写入、未重启**；测试端口 18885 用后释放，`/tmp` 已清理。
