# M3 收口 · 最终干净 clone 独立复验｜2026-11-22T10:46+08:00｜verifier=m3-final-clone-verify｜独立复跑，不复用任何 implementer 报告

## 范围与方法
四仓最终 HEAD 先 `git ls-remote` 核对，再各自 `git clone --depth 1` 到 `/tmp/final-*` 做隔离复验；所有命令在干净 clone 内执行，测完删除。Go 1.26.8 / GNU Make 4.4.1 / git 2.53.0。初始 `pgrep kored`=0、/tmp 目标均不存在。

## 四仓证据表

| 仓库 | HEAD(ls-remote=clone) | clone exit | 验证命令 | exit | 关键证据 |
| --- | --- | --- | --- | --- | --- |
| kore | `814edfea43bd04a2c6eca6dd3d3091bda093a27e` | 0 | `make check` | 0 | 10/10 段全绿：docs-check 6/6、依赖 2/3 白名单、薄壳 4/4、repo 5/5、canonical 9/9、log 8/8、wt 4/4、oss 8/8、case 5/5、frontend 首屏 4151 B ≤ 307200 B |
| kore | 同上 | — | `go test -timeout 200s ./...` | 0 | 12 包 ok（cmd/kored、auth、bus、config、envprobe、httpapi、installer、market、registry、store、supervisor、platform） |
| kore | 同上 | — | `go vet ./...` | 0 | 无输出 |
| kore | 同上 | — | `git archive HEAD \| tar -x -C /tmp/kore-arch && cd /tmp/kore-arch && go build ./...` | 0 | 每个提交可构建，无输出 |
| kore-plugins | `0e7c2b902e0d47c434faa2c5cd7d071282842311` | 0 | `bash scripts/validate-index.sh` | 0 | 2 条 schema/sha256 格式通过、7 条预设引用可解析、ed25519 签名验证通过 |
| kore-plugins | 同上 | — | `bash scripts/validate-presets.sh` | 0 | 8 预设 / 2 插件 / 0 FAIL / 0 WARN，最大 full.json 2.50 MiB ≤ 红线 48 |
| kore-plugins | 同上 | — | `make check` | 0 | 两个校验脚本均通过 |
| kore-plugin-echo | `2011ea8b1aff7208fabd9e4a8e646c71928778bf` | 0 | `GOWORK=off go build ./...` | 0 | 无输出 |
| kore-plugin-echo | 同上 | — | `GOWORK=off make dist` | 0 | `CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false -ldflags="-s -w"` → dist/echo-0.1.1.tar.gz |
| kore-plugin-echo | 同上 | — | `tar tzf dist/echo-0.1.1.tar.gz` 首条目 | 0 | `info.json`（非 `./`） |
| kore-plugin-site | `2a7fa5193a2b5693111c6eea70519af17dc78e25` | 0 | `GOWORK=off go build ./...` | 0 | 无输出 |
| kore-plugin-site | 同上 | — | `GOWORK=off make dist` | 0 | `CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags="-s -w"` → dist/site-0.1.0.tar.gz |
| kore-plugin-site | 同上 | — | `tar tzf dist/site-0.1.0.tar.gz` 首条目 | 0 | `info.json`（非 `./`） |

## 跨仓一致性

| 项 | 值 | 结论 |
| --- | --- | --- |
| 四仓 HEAD vs ls-remote | 四仓 clone HEAD 与远端逐字一致（见上表） | PASS |
| 公钥 kore `internal/core/market/verify.go` | `1a97a0003840bd25b03bf7cde7e2ecf8f53245388d868e3c8caae22acd68fe9e` | — |
| 公钥 kore-plugins `scripts/validate-index.sh` | `1a97a0003840bd25b03bf7cde7e2ecf8f53245388d868e3c8caae22acd68fe9e` | 逐字相同 PASS（64 位） |
| echo 包 sha256：索引声明 | `98707f4cd929cf0b67f2b6dea8b978300793e899bb15fd8aca148b2f27fd6d04` | — |
| echo 包 sha256：clone 后重建 dist | `98707f4cd929cf0b67f2b6dea8b978300793e899bb15fd8aca148b2f27fd6d04` | 逐字相同 PASS |
| site 包 sha256：索引声明 | `6347b2e6f117c0eb8dbdbee965345a63bc3ce85c2400abcaeaeda70f9dccb67f` | — |
| site 包 sha256：clone 后重建 dist | `6347b2e6f117c0eb8dbdbee965345a63bc3ce85c2400abcaeaeda70f9dccb67f` | 逐字相同 PASS |

sha 口径说明：kore clone 内无 echo/site dist 包（跨仓边界 G-13 保证插件产物不进内核仓），按任务跳过条款注明「索引 sha 与本地实测在重签时已核对」；本轮另以更强证据补验——从 echo/site **各自干净 clone** 重建 dist 并算 sha256，与索引声明逐字一致。

## 阻断 / 记录分级

| 级别 | 项 | 说明 |
| --- | --- | --- |
| 阻断 | 无 | 所有约定验收项 exit=0、证据匹配，无 P0/P1 |
| 记录 | tar `head -1` 报 `TAR_HEAD_EXIT=2` / `tar: 标准输出: 写错误` | `head` 提前关管触发 SIGPIPE，非打包失败；已用 Python `tarfile.getnames()[0]` 无管道重取，两仓首条目均为 `info.json` |
| 记录 | kore-plugins `make check` 输出顺序 | 先 validate-presets 后 validate-index（脚本内顺序），两项均通过 |
| 记录 | kore `make check` 第 6/7 段 | log-check / wt-check 为 WARN 级不阻断，本轮实测 0 WARN |

## 清理证明
`rm -rf -- /tmp/final-kore /tmp/final-kore-plugins /tmp/final-kore-plugin-echo /tmp/final-kore-plugin-site /tmp/kore-arch`（RM_EXIT=0）；删除前五个绝对路径经 `realpath` 核对，删除后五个均 GONE。`pgrep -c kored`=0，`pgrep -a kored` 无进程。

## VERDICT
**APPROVE** — M3 收口四仓干净 clone 复验全部通过；无阻断项。
