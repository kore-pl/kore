# C13 Node 扩展管理 · 隔离实跑断言证据（补落盘）

> 2026-11-26 21:19 · 执行者 `c13-node-ext`（task-139）· 应 `c13-verifier`（task-140）G-09 复核要求补落盘。本文只记录已跑过的命令与原始输出，不改任何生产代码。工作目录 `kore/.agents/verify/`。

## 0. 为什么要补这份报告

首次交付时 10 条断言只存在于会话 transcript，仓库内只有 `ui-c13-node-ext-selfeval.md` 的一句话结论，verifier 判定证据链不可核对。本文件把断言逐条的命令、退出码、关键输出与宿主全局 npm 前后快照完整落盘；一次性 harness（`verify.go` / `fakebin/npm` / `go.mod` / `go.sum` / `state/` / `gocache/`）跑完即删，只保留本报告 + 3 份证据日志（`run.log` / `assertions.log` / `npm-global-before.txt` + `npm-global-after.txt`）。

## 1. 环境与方法

- 真实插件二进制：`../../kore-plugin-runtime-node/bin/runtime-node`（v0.4.1，与索引/发布一致）。
- 驱动方式：Go harness 经 UDS JSON-RPC 与插件握手（`kore.hello`）后发 5 次业务请求；插件进程 `KORE_NODE_ROOT=<iso>/state/node`、`PATH=<iso>/fakebin:$PATH`，`C13_ARGV_LOG=<iso>/npm-argv.log`。
- 假执行面：`<iso>/fakebin/npm` 把 argv 逐行写进 argv log，并仅在 `--prefix <iso>/state/node/global` 下模拟 `install` / `uninstall` 创建/删除 `<prefix>/node_modules/<name>/package.json`。**它从不接受 `-g/--global`，也不写宿主全局目录。**
- 运行命令与退出码：
  ```
  cd .agents/verify/iso-c13-reverify
  GOPATH=$HOME/go GOCACHE=$PWD/gocache GOMODCACHE=$HOME/go/pkg/mod \
    GOPROXY=off GOSUMDB=off GOWORK=off go run verify.go 2>&1 | tee run.log
  # exit=0；TOTAL: 10/10 PASS；RESULT: ALL PASS
  ```
- 10 条断言的逐条命令+响应原文见 `assertions.log`（与 `run.log` 同源，harness 内 `logf` 同步写两份）。下面引用关键行。

## 2. 十条断言（逐条命令 / 退出码 / 关键输出）

| # | 断言 | 命令原文（摘自 assertions.log） | 退出 | 关键输出 |
|---|---|---|---|---|
| 1 | ext.list 空列表 | `POST-UDS request=runtime-node.ext.list params={}` | 0 | `result.count=0`，prefix=`…/state/node/global`，hint「还没有隔离扩展…」 |
| 2 | ext.install 成功 | `POST-UDS request=runtime-node.ext.install params={"packages":["chalk","commander==12.0.0"]}` | 0 | `result.network_used=true`、`packages=["chalk","commander==12.0.0"]`、`output="added 2 package(s) in isolated prefix"` |
| 3 | chalk 落隔离前缀 | `stat …/state/node/global/node_modules/chalk/package.json` | 0 | `err=<nil>` |
| 4 | commander 落隔离前缀 | `stat …/state/node/global/node_modules/commander/package.json` | 0 | `err=<nil>` |
| 5 | argv 无全局选项 | `cat …/npm-argv.log` | 0 | `"install --prefix …/state/node/global --no-audit --no-fund --ignore-scripts chalk commander==12.0.0\n"`；无 ` -g` / `--global` |
| 6 | 固定 --prefix | `grep -F '--prefix …/state/node/global' …/npm-argv.log` | 0 | 命中 |
| 7 | ext.list 显示 2 项 | `POST-UDS request=runtime-node.ext.list params={}` | 0 | `result.count=2`，packages chalk/commander 1.0.0 |
| 8 | ext.remove 成功 | `POST-UDS request=runtime-node.ext.remove params={"packages":["chalk","commander"]}` | 0 | `result.removed=["chalk","commander"]`、`output="removed 2 package(s)"` |
| 9 | 移除后清理 | `stat …/state/node/global/node_modules/chalk` | 0（stat 本身非 0，断言按 `IsNotExist=true` 判 PASS） | `no such file or directory (IsNotExist=true)` |
| 10 | -g 注入被拒 | `POST-UDS request=runtime-node.ext.install params={"packages":["npm -g"]}` | 0（响应 exit；断言看 error） | `error.code=E_INVALID`，message「请检查包名 "npm -g"…不要写空格、分号、@scope 或 -g 选项」 |

汇总：`TOTAL: 10/10 PASS` / `RESULT: ALL PASS`。原始 10 段 `CMD`/`EXIT` 文本见 `assertions.log`，未在表中省略任何一条。

## 3. 宿主全局 npm「无变化」——before/after 快照对比（这次真做了）

首次交付时只做了事后检查 + argv 反证（见上一封给 verifier 的说明），**没有前后快照 diff，这点我如实承认**。本次补做：

```
REALGLOBAL=$(npm root -g)   # → /home/pt/.nvm/versions/node/v24.21.0/lib/node_modules
find "$REALGLOBAL" -maxdepth 1 -mindepth 1 -printf '%f|%T@|%s\n' | sort > npm-global-before.txt
sha256sum npm-global-before.txt   # → a4088821e43ac5bf0625eadbdeb904879d6b7c175e46b4fbc466c0962102e9db
# 跑 harness（10 条断言：list/install/list/remove/-g 拒绝）
find "$REALGLOBAL" -maxdepth 1 -mindepth 1 -printf '%f|%T@|%s\n' | sort > npm-global-after.txt
sha256sum npm-global-after.txt    # → a4088821e43ac5bf0625eadbdeb904879d6b7c175e46b4fbc466c0962102e9db
diff npm-global-before.txt npm-global-after.txt
# diff exit=0（无输出）；两份 sha256 完全相同
```

比较对象：`~/.nvm/versions/node/v24.21.0/lib/node_modules` 顶层每个条目名 + mtime + size（9 行：corepack / @larksuite / @mnemon-dev / @mohammad154 / node_modules / npm / @opencode / pake-cli / typescript / typescript-language-server 中的 9 项）。结论：harness 跑完前后宿主全局 npm 顶层字节级一致；白名单 + 固定 `--prefix` + argv log 无 `-g` 是机制层解释，快照 diff 是实测层证据。

## 4. 隔离与清理

- 端口：首次交付时 `curl -sS http://127.0.0.1:18963/-/healthz` → `{"status":"ok"}`；`ss -ltn | grep 18963` → `LISTEN … 127.0.0.1:18963`；收工 `18963 stopped` 且 `curl 8787/-/healthz` → `{"status":"ok"}`（主实例未动）。本轮补跑 harness 不再起 kored（直接驱动插件二进制），端口证据仍以首次 transcript 为准，未另落盘截图/日志。
- 临时目录：首次 `rm -rf .agents/verify/iso-c13` 后 `iso-c13 fully removed`；本轮 harness 的 scaffold 跑完即删，只保留本报告 + `run.log` / `assertions.log` / `npm-global-before.txt` / `npm-global-after.txt` 四份证据文件（本报告与四份日志一并提交）。

## 5. 诚实边界

- 安装动作由假 npm 执行面完成，验证的是「argv 固定 + 隔离前缀 + 白名单 + 不碰全局」，不是真机联网 `npm install` 行为。
- 端口证据（18963 启停 / 8787 未动）只在 transcript，未像断言那样落盘；verifier 若判此项证据不足可接受。
- 断言 #9/#10 的 `EXIT` 列是「命令 exit 0，断言依据为结果内容（IsNotExist / error.code）」，不是命令失败，特此写清避免误读。
