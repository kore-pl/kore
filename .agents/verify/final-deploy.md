> 状态: factual record · 归属: final-deploy · 更新: 2026-11-25 · 工作区: /home/pt/Work/GolandProjects/kore-pl
> 硬约束遵守: root 操作只走 dsh-root（完整命令+退出码+输出如实记录）；未建用户、未 chown -R、未改 .kore-local.yaml（index_dir 已修好）、未删数据；明文口令不进对话/报告/日志；临时脚本即用即删；只推 Gitea origin（一批一次、每仓恰好一次 push），未推 github/gitee、未打 tag、未触发 CI。

# 本轮功能最终落地报告（final-deploy）

## 一句话结论

**本地运行实例已切到含 ADR-0055/0056/0057 全部功能的新二进制（sha256 7f768e4e…、MainPID 1325614→2533240、/proc/<pid>/exe sha 逐字一致）；账号+密码登录真机全链路通过（200/401/428/429+Retry-After、system/info 正常、must_change 只出可关闭提示、改密端点带账号 400/403 正确而不改现网口令）；24/24 插件仍同步、healthz 3×200、docs-check/secret-check 绿；Gitea origin 推送 1 仓（kore，15 提交），origin/main == 本地 HEAD，github/gitee 零触碰。**

## 0. 只读盘点（执行前）

| 项 | 事实 |
| --- | --- |
| 待推仓 | 全 26 仓中仅 `kore` 本地领先 `origin/main..HEAD=15`，其余 25 仓 ahead=0（kore-plugins 与 24 插件仓均对齐） |
| kore HEAD | `812f9fc`（含 b6e091b / 5697b3c / b1f7e59 / ee724d5 / b5480a6 / 7af792f / 82c69bd / 35b3abd 全部关键 commit，`git merge-base --is-ancestor` 逐条 IN_HEAD） |
| 旧运行 bin | 磁盘 `bin/kored` sha `4a9da02e…`（11-25 19:12 构建，含 0055/0056 但缺 0057 的账号/验证码/改密）；`strings` 中 `admin_username/auth/captcha/checkadminusername` 零命中；旧备份 `bin/kored.bak-20261125T191200` sha `d53b6ed5…` |
| 服务 | `kore.service`（User=root）接管 8787，MainPID=1325614，`healthz=200`；旧二进制对 must_change 仍返回 403「首次登录请先设置新口令」——反证新逻辑未生效 |
| 索引 | `kore-plugins` HEAD `e2f8bbf`（site 0.8.2 收录、24 插件） |
| 凭据文件 | `data/initial-admin-credential` mode=600、2 行（username:/password:）、已按 ADR-0057 迁移；明文未读进报告/日志/对话 |

## 1. 构建（G-16 参数）+ 门禁

```text
命令: cd kore && GOWORK=off GOCACHE=<workspace>/kore/.tmp/gocache make build BIN=./bin/kored.deploy
退出码: 0   输出: [OK] 构建完成: ./bin/kored.deploy
sha256(bin/kored.deploy) = 7f768e4e0919e42662d1946a7e13467cf6a7cd55e011b88cd1288e72477203fc
bin/kored.deploy version → kored 0.1.1 / 协议 kore.plugin.v1
strings 新特性计数: admin_username×2 / auth/captcha×4 / CheckAdminUsername×1 / must_change_password×2 / system/restart×3（旧 bin 全 0）

GOWORK=off GOCACHE=<workspace>/.tmp/gocache go vet ./...                          → VET_EXIT=0（无输出）
GOWORK=off GOCACHE=<workspace>/.tmp/gocache go test -count=1 -timeout 200s ./...   → TEST_EXIT=0（17 包全 ok：cmd/kored 10.139s、httpapi 4.729s、auth 1.168s、supervisor 8.881s 等）
(cd pkg/pluginapi && GOWORK=off go test -count=1 -timeout 200s ./...)               → PLUGINAPI_TEST_EXIT=0（2 包 ok）
```

## 2. 替换 + 重启（所有 root 动作只走 dsh-root）

> 选用 dsh-root 一次完成 swap+restart，而非先起新进程再走 `POST /api/v1/system/restart`：旧 bin 的 must_change 闸门让带会话请求仍被 403、confirm-token 探测也是 403，且 swap 本身必须 root 写 `bin/kored`——一次完成少一次停机窗口。端点代码（`cmd/kored/restart.go` + `internal/core/httpapi/handlers_restart.go`）与公开性已只读核实，未实际提交重启。

```text
命令: cp -a bin/kored bin/kored.bak-finaldeploy-pre    → rc=0
      sha256(bin/kored.bak-finaldeploy-pre)=4a9da02e…（旧运行版，可回滚）

命令: dsh-root --shell 'set -e; install -m 0775 <workspace>/kore/bin/kored.deploy <workspace>/kore/bin/kored; systemctl restart kore.service'
退出码: 0
输出（如实）:
  /home/pt/.local/bin/dsh-root: 行 62: /home/pt/.local/state/dsh/root-exec.log: 只读文件系统
  dsh-root: 警告: 无法写入审计日志 /home/pt/.local/state/dsh/root-exec.log
  （审计日志路径只读为该通道已知告警；命令本体 rc=0、副作用已生效）

healthz 轮询: try=1 http=200
服务: systemctl show -p MainPID -p ActiveState -p User --value kore.service
      → active / 2533240 / root（旧 MainPID 1325614 → 新 2533240）
磁盘 sha256(bin/kored) == sha256(bin/kored.deploy) == 7f768e4e…
dsh-root readlink /proc/2533240/exe → <workspace>/kore/bin/kored
dsh-root sha256sum /proc/2533240/exe  → 7f768e4e0919e42662d1946a7e13467cf6a7cd55e011b88cd1288e72477203fc
      （host ns 可见，运行 exe 与磁盘新 bin 逐字一致）
未登录 GET /api/v1/auth/captcha → 200（新端点已生效）
```

## 3. 真机账号+密码登录与失败防护（主实例 127.0.0.1:8787 真链路）

> 口令从 `data/initial-admin-credential` 读入 shell 变量、只经 curl -d 传入，不 echo、不落报告/日志/对话；所有输出中口令均为占位。测试产生的一次性 jar 与临时 JSON 随调用内删除。

| 断言 | HTTP | 关键输出 |
| --- | --- | --- |
| 正确账号 `admin` + 正确口令 | 200 | `authenticated=true` |
| 带会话 `GET /api/v1/auth/session`（must_change=true） | 200 | `X-Kore-Password-Hint: 1`，无 403 闸门 |
| 带会话 `GET /api/v1/system/info` | 200 | 无「系统信息读取失败」；`paths.index_dir=/home/pt/Work/GolandProjects/kore-pl/kore-plugins/index` |
| 错误账号 `root` + 正确口令 | 401 | `E_UNAUTHORIZED` /「账号或口令错误」 |
| 正确账号 + 错误口令 | 401 | 「密码错误，请输入右侧验证码」 |
| 挑战态 `GET /api/v1/auth/captcha`（未登录） | 200 | `captcha_id`(32 hex) / `image`(data:image/png;base64,) / `text_question`(a + b = ?) / `expires_in=120` |
| 挑战态缺验证码提交 | 428 | `E_CAPTCHA_REQUIRED` / detail=`captcha_required` |
| 验证码答案错（`captcha_answer=999999`） | 401 | `E_CAPTCHA_INVALID`（证明 429 来自限速而非验证码错误） |
| 带正确验证码继续错误口令 | 429 | `E_RATELIMIT`「尝试太频繁，请 N 秒后再试」+ `Retry-After`（实测 2/4） |
| 改密端点缺 `username` | 400 | `E_INVALID`「请输入账号」（带会话 + CSRF，负例不改口令） |
| 改密端点 `username=root` | 403 | `E_UNAUTHORIZED`「账号不匹配，无法修改口令」（不查库/不枚举） |
| 负例后会话仍有效 | 200 | `/api/v1/auth/session`=200；现网口令未改，原凭据仍可 200 登录 |

> 改密成功路径（200 → 旧会话 401 / 凭据删除 / 清 must_change）在 ADR-0057 T6 隔离实例已真机验证（见 `account-t6-password.md`）；本轮对主实例只做不改数据的 400/403 负例，避免把一次性口令改掉影响其它并发卡。

## 4. 复核（部署后）

| 判据 | 结果 |
| --- | --- |
| store 24/24 | HTTP 200；index 24 / store 24，逐 id 版本 mismatch=0；store 无错误码 |
| healthz | 3/3 探测 200 |
| 服务 | active / MainPID 2533240 / root |
| docs-check | exit 0（5 pass / 1 WARN / 0 fail；WARN 为 docs 行数越界，不阻断） |
| secret-check | exit 0（0 FAIL / 23 处匹配，占位写法均合规） |
| go vet / test | 见 §1，全绿 |

## 5. Gitea 批推（一批一次、每仓恰好一次 push）

```text
盘点: 26 仓中只有 kore 本地领先 origin/main 15 提交，其余 ahead=0
命令: cd kore && git push origin main
退出码: 0
输出: To https://gitea.iouf.cn/kore-pl/kore.git
      c8d0af7..812f9fc  main -> main
      （stderr: 无法在 1000 ms 获得凭证存储锁: 只读文件系统 —— 非致命告警，push rc=0）
回读: local_HEAD=812f9fcb6673d5737962566ecc9ee02fb4f1ed4b
      git ls-remote origin refs/heads/main = 812f9fcb6673d5737962566ecc9ee02fb4f1ed4b
      behind_after=0 / ahead_after=0
范围: origin=Gitea（权威源）；未推 github/gitee；未推 tag；未 --force；未触发 CI
推送对齐仓数: 1/1（kore）
```

## 6. 未提交项清单（原样保留，未 stage / 未改）

| 仓 | 项 | 状态 |
| --- | --- | --- |
| kore | `scripts/usability-pending.txt` | ` M`（他人/既有在途，未 stage） |
| kore | `.agents/verify/e2e-content-write.md` / `e2e-deploy-write.md` / `e2e-system-write.md` / `local-update-plan.md` / `release-batch-plan.md` / `release-batch-prep.md` / `release-inject-verify.md` / `run-user-model.md` | `??` 未跟踪验证文档（原样保留） |
| kore | `.agents/verify/screenshots/adp-debug-desktop-01.png` | `??` 未跟踪截图 |
| kore | `data/` | `??` gitignore 运行态资产（含 0600 凭据，未提交） |
| kore-plugin-site | `MM apply.go`；`D rollback.go` / `D tests/boundary/rollback_window_test.go`；`?? rollback.go` / `?? tests/boundary/rollback_window_test.go` / `?? zeroparam_test.go` | 6 行在途改动原样保留，未 stage / 未 commit |
| 其余 22 插件仓 | `?? zeroparam_test.go` 或 `?? internal/<op>/zeroparam_test.go`（app-deploy/container/cron/db-mysql/db-postgres/discover/echo/file/integrity/logs/monitor/process/redis/runtime-node/runtime-php/runtime-python/ssh-guard/terminal/waf）；`kore-plugin-dns` 7 个 `M` 在途源码 | 原样保留，未 stage / 未 commit |
| kore-plugins | `?? .tmp-validate-out.txt` | 原样保留 |

> 本报告自身随后以精确 pathspec 提交，但不推自己（避免递归推送）。

## 7. 回退办法（未执行）

1. `dsh-root --shell 'install -m 0775 <workspace>/kore/bin/kored.bak-finaldeploy-pre <workspace>/kore/bin/kored; systemctl restart kore.service'`（sha `4a9da02e…`，最后已验证可用的旧 bin）
2. 如需退到 11-24 版：`dsh-root --shell 'install -m 0775 <workspace>/kore/bin/kored.bak-20261125T191200 <workspace>/kore/bin/kored; systemctl restart kore.service'`（sha `d53b6ed5…`，缺 ADR-0057 功能）
3. 回退后重跑 §3/§4 的 healthz、登录与 store 复核；不 rollback 索引/数据/配置。
4. 远端回退需要 force-push，按纪律禁止——本轮 Gitea 推送只前进不回退。

## 8. 收尾

- root 操作仅 §2 一条 `dsh-root --shell`（swap+restart）；dsh-root 审计日志只读告警如实记录。
- 临时 jar / JSON / captcha 响应均在调用内删除；一次性脚本未落工作区。
- 明文口令未进对话、报告、日志或 argv；secret-check exit 0。
- 未建用户、未 chown -R、未删数据、未改 `.kore-local.yaml`；site 6 行与其它在途改动原样保留。
- 编译期产物 `bin/kored.deploy`（新 bin 副本）与 `bin/kored.bak-finaldeploy-pre`（回滚副本）均为 gitignored 运行态资产，不进提交。
