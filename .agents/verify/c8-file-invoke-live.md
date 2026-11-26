> 元信息: 2026-11-26T19:47+08:00 · 执行者 c8-close（worker）· task-129 · C8 证伪收口：隔离实例真跑 file 插件五项 invoke · 报告 ≤120 行

# C8 五项 invoke 隔离真跑验证报告（rename / copy / search / trash / uploadChunk）

## 0. 结论

五项**全部 PASS**（18 断言 / 0 FAIL）。在**隔离实例**上以 `file@0.3.6`（sha256 与索引逐字节一致）真实经
`POST /api/v1/invoke/file/<method>` 调用后端生产实现，逐条断言文件系统结果 —— 坐实 C8「前端未接后端能力」的
缺口**前提已被推翻**：后端能力不仅在源码存在，且在真实 kored + 真实插件 + 真实文件上可用。
**是否碰主实例 8787 / .kore-local-\*：否**（见 §5）。

## 1. 隔离环境与前置（命令 + 退出码）

工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）。HEAD=`576fcd15d9a69eb61df38ff0345ca22daaa6709d`。
隔离树落在**工作区短路径** `/home/pt/Work/GolandProjects/kore-pl/.c8iso`（非 `/tmp`——本机 `/tmp` 不跨 bash 调用持久，
且 UDS 需短路径规避 sun_path 107 字节上限）。因本沙箱每次 bash 调用是独立 PID  namespace、进程不跨调用存活，
故「起服 → 登录 → 装插件 → 五项 invoke → 断言 → 停服」全部写在**同一份 harness 脚本**内、单次 bash 调用内完成。

| 步骤 | 命令 | exit | 关键输出 |
| --- | --- | --- | --- |
| 建隔离树 | `git archive HEAD \| tar -x -C $ISO/src` | **0** | 纯净 HEAD 快照，未带工作区他人 dirty |
| 静态产物 | `cd $ISO/src && make web-dist` | **0** | 生成 `web/dist/`（embed 前置） |
| 缺依赖下载 | `GOPROXY=https://goproxy.cn,direct go mod download all`（隔离 GOMODCACHE） | **0** | 仅此一步联网、仅 goproxy；随后全程 `GOPROXY=off` |
| 构建 kored | `CGO_ENABLED=0 GOAMD64=v1 GOWORK=off GOPROXY=off go build -trimpath -buildvcs=false -ldflags '-s -w' -o $ISO/kored ./cmd/kored` | **0** | 13,316,258 B，sha256 `3606f3f46dd8ca884d550a80a5b73e08f9a85fefa4ae049325c105a34f8c3e2d`（独立产物，非主二进制） |
| 插件包核对 | `sha256sum file-0.3.6.tar.gz` | **0** | `990611c062aa6e335c8691110321c5c2cfb2b52a5a29acdb53d99dcc3f73bcc3` == `kore-plugins/index/plugins.json` 记录（size 1,697,595 B） |
| 管理员口令 | `kored admin-password --set --stdin --config $ISO/config.yaml` | **0** | 哈希写隔离 config（0600）；口令仅存在于 harness 内、未落报告/未进 argv |

隔离实例配置：`server.addr=127.0.0.1:18887`（**非 8787**）；`paths.state_dir/run_dir/log_dir/index_dir` 全指 `$ISO`
下子目录；`KORE_FILE_ROOT=$ISO/fileroot`（测试文件根）；index 用 `kore-plugins/index` 的已签名快照副本。
`curl /-/healthz` → **HTTP 200**（`kore ready` 日志确认 socket/addr 均在隔离目录与 18887）。
登录 `POST /api/v1/auth/login {"username":"admin",...}` → **200 authenticated:true**；所有写请求带 `X-Kore-CSRF`
双提交头（cookie 中 `kore_csrf`，长度 43）。装插件 `POST /api/v1/store/install` → **200 `state:succeeded`**；
`POST /api/v1/plugins/file/enable` → **200 `enabled:true`**，method_capabilities 含 `file.uploadChunk` 等。

## 2. 五项逐条断言（命令 = harness 内 curl；退出码；结果原文）

> invoke 统一形态：`curl -s -b cookie.jar -H 'Content-Type: application/json' -H "X-Kore-CSRF: $CSRF" -d '<params>' -w '\n__HTTP__=%{http_code}\n' http://127.0.0.1:18887/api/v1/invoke/file/<method>`

### ① rename — PASS
- 前置：`printf 'to-be-renamed\n' > $ROOT/a.txt`
- 命令：`inv file.rename '{"path":"a.txt","name":"b.txt"}'` → HTTP **200**
- 响应：`{"from":"a.txt","to":"b.txt","renamed":true,"method":"rename"}`
- 断言：`[ -f $ROOT/b.txt ] && [ ! -e $ROOT/a.txt ]` → **真**（新名存在、旧名消失）；`renamed:true` → **真**。2/2 PASS。

### ② copy — PASS
- 前置：`printf 'HELLO-C8-BYTES' > $ROOT/src.bin`
- 命令：`inv file.copy '{"src":"src.bin","dst":"copy.bin"}'` → HTTP **200**
- 响应：`{"from":"src.bin","to":"copy.bin","copied":true,"kind":"file","entries":1,"bytes":14}`
- 断言：`cmp -s $ROOT/src.bin $ROOT/copy.bin` → exit **0**（字节相等）；`copied:true` → **真**。2/2 PASS。

### ③ search — PASS
- 前置：`printf 'alpha\nsecond timeout line\nthird\n' > $ROOT/seed.txt`
- 命令：`inv file.search '{"path":".","pattern":"*.txt","content":"timeout"}'` → HTTP **200**
- 响应：`{"path":".","pattern":"*.txt","content":"timeout","scanned":5,"matched":1,...,"entries":[{"path":"seed.txt","name":"seed.txt",...,"line":2,"preview":"second timeout line"}]}`
- 断言：`matched=1`（≥1）、`seed.txt` 命中 `line=2`（`timeout` 确在第 2 行）→ **均真**。2/2 PASS。

### ④ trash（delete → list → restore → purge）— PASS
- 命令/响应（均 HTTP **200**）：
  - `inv file.delete '{"path":"trashme.txt"}'` → `{"deleted":true,"permanent":false,"trash_id":"1795693595305529892-1e512a32"}`
  - `inv file.trash.list '{"limit":10}'` → `{"count":1,"total":1,...,"entries":[{"id":"1795693595305529892-1e512a32","path":"trashme.txt",...}]}`
  - `inv file.trash.restore '{"id":"1795693595305529892-1e512a32"}'` → `{"path":"trashme.txt","restored":true}`
  - 再 delete 一次（拿新 trash_id）→ `inv file.trash.purge '{"all":true}'` → `{"purged":1,"all":true}`
  - `inv file.trash.list '{"limit":10}'` → `{"count":0,"total":0,"entries":[]}`
- 断言：delete 返回 trash_id、**原路径文件消失**；list count=1；restore 后**原文件复原**（`[ -f $ROOT/trashme.txt ]`）；purge 后 list count=0。5/5 PASS。

### ⑤ uploadChunk（分块 → uploadStatus → 落盘一致）— PASS
- 载荷：`b'CHUNK-C8-' + bytes(range(64)) + b'-END'`，共 **77** 字节，拆 3 块（offset 0/30/70）。
- 命令/响应（均 HTTP **200**）：
  - `inv file.uploadChunk '{"path":"chunk.bin","offset":0,"data_base64":"...","total_size":77}'` → `received:30,complete:false`
  - offset=30 → `received:70,complete:false`；offset=70 → `received:77,complete:true`
  - `inv file.uploadStatus '{"path":"chunk.bin"}'` → `{"path":"chunk.bin","received":77,"exists":true}`
- 断言：`received(77) == size(77)` → **真**；Python 回读 `$ROOT/chunk.bin` 与原始 payload `==` → `identical: True`（77/77 字节）。2/2 PASS。

**汇总行（harness 原样）**：`PASS=18 FAIL=0`。完整原始日志在隔离树 `testrun.log`（收尾随隔离树删除）。

## 3. 失败处理说明

无 FAIL。首轮曾因登录缺 `username` 字段（ADR-0057 账号标识符）返回 `E_INVALID 请输入账号` 导致 CSRF=0、全部 401——
这是**测试 harness 参数错误**（非后端缺陷），补 `{"username":"admin",...}` 后重跑全绿；如实记录于此，不掩饰首轮失败。

## 4. 与文档漂移的对应

- `docs/PLUGIN-MATURITY.md:71` 原「前端未接 search/trash/rename/copy/uploadChunk（`web/files.js` 仅见 `readRange`）」
  为陈旧断言：前端接线事实见 `.agents/verify/files-l2.md`（`web/files.js:295/300/748/470/626/644/711`、
  `web/files-l2.js:318` 等，G-28 双端截图齐），本轮又补后端 invoke 真跑 PASS 证据。已改为「五项已接线并经隔离实例
  invoke 真跑 PASS」并引用本报告与 files-l2.md。
- `docs/FEATURE-GAP-BACKLOG.md:70-73` C8 条已由【硬证据·缺口】改为【已证伪 / 已接线 PASS】，引用本报告。
- `docs/FEATURE-GAP-BACKLOG.md:163` 第 2 期前置条件中「C8 需前端接线」同步更正。

## 5. 隔离声明（未碰主实例）

- 监听 `127.0.0.1:18887`（非 8787）；`config.yaml` / state.db / run socket / log / index / KORE_FILE_ROOT 全在
  `$ISO=/home/pt/Work/GolandProjects/kore-pl/.c8iso` 下，与主实例 `.kore-local.yaml` / `.kore-local-state/` /
  `.kore-local-run/` / `.kore-local-log/` / `.kore-local-index/` **零交集**。
- 未读写、未重启、未 kill 8787 主实例；未执行任何主流程 install/upgrade CLI（隔离实例的 store/install、invoke 除外）。
- 未碰 `web/`、未改插件生产代码、未 bump 插件版本、未 git push、未联网业务（仅 goproxy.cn 下载构建依赖）。
- 隔离树、隔离缓存（gocache/gomodcache/gopath）、cookie.jar、口令、harness 脚本**用完即删**（见 §6 收尾）。

## 6. 收尾

- harness 内 `kill $KP` 停隔离 kored；`rm -rf $ISO` 删除整个隔离树（含二进制、缓存、state/run/log/index、测试文件、
  cookie、口令、日志）。工作区仅保留本报告与两份文档改动。
