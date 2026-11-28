> 元信息: 2026-11-28T08:08+08:00 · 执行者 pyext-live（worker）· task-292 · Python ext P3 真机验证（隔离实例 install/list/remove 闭环 + 宿主 site-packages 零改动）
> 工作目录 `/home/pt/Work/GolandProjects/kore-pl` · 不改生产代码 / 不 bump / 不发版 / 不 push / 不联网业务 / 不碰 8787 或 `.kore-local-*`。

# Python ext P3 真机验证报告

## 0. 结论

**16/16 断言 PASS，0 FAIL。** 在隔离 kored 实例（`127.0.0.1:55201`，独立 config/state/run/log/index）上，以**真实插件二进制 0.5.0**（本地 tarball `store/install`）经真实 `POST /api/v1/invoke/runtime-python/runtime-python.ext.{list,install,remove}` 完成空态→安装→列表→移除→复列闭环；安装使用**本地自制最小 wheel**（`PIP_NO_INDEX=1` + `PIP_FIND_LINKS`，plugin 固定 argv 不改），宿主 site-packages 文件树三次快照 sha256 全等（`49a0b6d3…`，27447 行，`cmp -s` exit 0）。边界真机旁证 6 项全 `E_INVALID`。

**诚实边界**：这是**单机单实例隔离真机**；install 是**离线本地 wheel**，不是真实 PyPI 联网下载（任务卡禁联网业务）；受控删除 containment 真机只验「外部 softlink 指向被拒 + 包目录/dist-info 消失」，全组合边界由单测覆盖；无竞品同口径对照。

受验对象：`kore@e792bd4e67ce479a58b06d7353e6d12bf324760e`（当前 HEAD）、`kore-plugin-runtime-python@f3cc4fda165cf5c43f5288b89cc57dfd2702903f`（当前 HEAD）、本地发布包 `runtime-python-0.5.0.tar.gz` sha256 `cc9d8712575f6d04c4192c9ceb25aaf5732a516b1bdcd6c3f71b07b20182252a`（与索引一致）。

## 1. 隔离环境与命令（原文见 §7 转录索引）

一次性 harness 写在 `/home/pt/Work/GolandProjects/kore-pl/.tmp/pyext-live-harness.sh`，**单次 bash 调用内跑完起服→登录→装插件→闭环 invoke→断言→停服**（本机每次 bash 调用是独立 PID namespace，进程不跨调用存活），跑完立即删除（§6）。隔离树 `.tmp/pyext-live-iso/`（工作区短路径，`run_dir` 下 UDS 路径 < 107 字节）。

| 步骤 | 命令（摘录） | 退出码 | 原文关键输出 |
| --- | --- | --- | --- |
| HEAD 核对 | `git rev-parse HEAD`（两仓） | 0 | `e792bd4…` / `f3cc4fd…` |
| 前置 site 路径 | `python3 -m site` | 0 | `USER_SITE: '/home/pt/.local/lib/python3.14/site-packages'`；`sys.path` 含 `/home/pt/.local/lib/python3.14/site-packages`、`/usr/local/lib/python3.14/dist-packages`、`/usr/lib/python3/dist-packages` |
| 宿主基线 | `snapshot_sp(host-sp-before.txt); sha256sum …` | 0 | `49a0b6d375da687ed64f17dc98267d708e1051383e3bbf1bbca53026bfcca620`，27447 行（每文件 sha256 + 路径 + 大小 + 模式 + 软链目标） |
| 造本地 wheel | `python3 - <<'PY' … zipfile … PY`（纯 stdlib，无 pip build） | 0 | `koreprobe-9.8.7-py3-none-any.whl` 743 B；`koreprobe/__init__.py`、`koreprobe-9.8.7.dist-info/{WHEEL,METADATA,RECORD}` |
| 构建隔离 kored | `GOCACHE=.gocache-pyext GOMODCACHE=.gomodcache-pyext GOWORK=off GOPROXY=off CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o .tmp/pyext-live-iso/kored ./cmd/kored` | 0 | sha256 `4ed291bbd500bbb14f4ba3d5b0472d8dd7cdafb86429ce28c3f93a655dd7007c`，**与宿主 `bin/kored` sha `5ffc2337…` 不同**（未覆盖宿主二进制） |
| 启隔离实例 | `KORE_PYTHON_ROOT=<iso>/state/python PIP_NO_INDEX=1 PIP_FIND_LINKS=<iso>/wheels … <iso>/kored serve --config <iso>/config/config.yaml` | 后台 | 端口 `127.0.0.1:55201`（**非 8787**）；`ss -ltn` 见 LISTEN 55201 |
| 健康 | `curl -fsS http://127.0.0.1:55201/-/healthz` | 0 | `{"status":"ok"}` |
| 宿主未动 | `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz` | 0 | `200`（前后各一次，主实例未重启/未改） |
| 登录 | `curl -fsS -c cookies … --data-binary @login.json …/api/v1/auth/login`（口令仅在隔离配置哈希 + harness 内存，**未进 argv / 未落报告**） | 0 | `{"authenticated":true,"expires_at":"2026-11-28T12:07:58Z"}`；CSRF cookie 长度 43 |
| 装插件 | `POST /api/v1/store/install` body `{"id":"runtime-python","version":"0.5.0","package_path":"<iso>/runtime-python-0.5.0.tar.gz"}` | HTTP 200 | `{"state":"succeeded","reload":"reloaded"}` |
| 启用 | `POST /api/v1/plugins/runtime-python/enable` | HTTP 200 | `{"enabled":true,"state":"stopped","desired":"enabled","method_capabilities":{"runtime-python.ext.install":"system:admin","runtime-python.ext.list":"system:read","runtime-python.ext.remove":"system:admin",…}}`（lazy 插件，首次 invoke 冷启） |

> 离线机制说明：插件 `InstallPackages` 固定 argv 是 `python3 -m pip install --target <prefix> --no-input --disable-pip-version-check <pkgs>`（`ext.go:286-292`），**argv 里没有 `--no-index/--find-links` 也没被篡改**；离线由插件进程继承的环境变量 `PIP_NO_INDEX=1` + `PIP_FIND_LINKS=<iso>/wheels` 提供（pip 官方支持 env 覆盖，`supervisor/start.go:108` `cmd.Env=append(os.Environ(), env...)`）。这样验证了**生产固定 argv 真机路径**，而不是把 argv 改成假执行面。

## 2. 闭环断言（命令 + 退出码 + 原文）

所有 invoke 形态：`curl -sS -b cookies -H 'Content-Type: application/json' -H "X-Kore-CSRF: $CSRF" -X POST -d '<body>' -w '\n__HTTP__=%{http_code}' http://127.0.0.1:55201/api/v1/invoke/runtime-python/runtime-python.ext.<verb>`。

### ① ext.list 空态（2/2 PASS）
- 命令 `POST … runtime-python.ext.list {}` → `EXIT=0` / `__HTTP__=200`
- 原文：`{"prefix":"/home/pt/Work/GolandProjects/kore-pl/.tmp/pyext-live-iso/state/python/global/py_ext","packages":[],"count":0,"hint":"还没有隔离扩展；请在版本详情里点「管理扩展」安装，包会写进插件状态目录。"}`
- 断言：`count=0` PASS；`prefix` 含 `state/python/global/py_ext`（即 `<state>/global/py_ext`）PASS。

### ② ext.install 本地 wheel（3/3 PASS）
- 命令 `POST … runtime-python.ext.install {"packages":["koreprobe"]}` → `EXIT=0` / `__HTTP__=200`
- 原文（output 字段逐字）：`Looking in links: <iso>/wheels\nProcessing <iso>/wheels/koreprobe-9.8.7-py3-none-any.whl\nInstalling collected packages: koreprobe\nSuccessfully installed koreprobe-9.8.7\n`；`network_used:true`、`duration_ms:249`、`hint` 含「不会写宿主 site-packages」。
- `ls -d <iso>/state/python/global/py_ext/koreprobe-9.8.7.dist-info` → `EXIT=0`；`cat …/METADATA` → `Name: koreprobe` / `Version: 9.8.7`（来自 wheel METADATA，非空态兜底）。

### ③ ext.list 见 METADATA 的 Name/Version（2/2 PASS）
- 命令 `POST … runtime-python.ext.list {}` → `EXIT=0` / `__HTTP__=200`
- 原文：`{"prefix":"…/state/python/global/py_ext","packages":[{"name":"koreprobe","version":"9.8.7"}],"count":1}`
- 断言：`name=koreprobe` PASS、`version=9.8.7` PASS（这两值来自 §② 的 METADATA，非目录名兜底；目录名同为 `koreprobe-9.8.7.dist-info`，METADATA 原文已在 §② 逐字列出）。

### ④ 宿主 site-packages 零改动（2/2 PASS）
- 快照方法：`find <每个 site 目录> -printf '%y|%P|%s|%m|%l\n' | sort` + 每文件 `sha256sum`，三次（安装前 / 安装后 / 移除后）。
- `sha256sum host-sp-before.txt` → `49a0b6d3…cca620`（27447 行）；after → **同一 sha 同行数**；final → **同一 sha 同行数**；`cmp -s before after` 与 `cmp -s before final` 均 **exit 0**。
- 断言：安装前后逐字节一致 PASS；移除后仍逐字节一致 PASS。

### ⑤ ext.remove → 受控删除（4/4 PASS）
- 命令 `POST … runtime-python.ext.remove {"packages":["koreprobe"]}` → `EXIT=0` / `__HTTP__=200`
- 原文：`{"removed":["koreprobe","koreprobe-9.8.7.dist-info"],"output":"已移除: koreprobe\n已移除: koreprobe-9.8.7.dist-info","hint":"只移除隔离目录内的扩展；宿主 site-packages 不受影响。"}`
- `[ -e <iso>/state/python/global/py_ext/koreprobe-9.8.7.dist-info ]` → 不存在 PASS；`[ -e …/koreprobe ]` → 不存在 PASS。
- 复列 `ext.list {}` → `{"packages":[],"count":0,"hint":…}` → count=0 PASS；宿主快照 sha 不变 PASS（见 §④）。

### ⑥ 边界真机旁证（6/6 PASS，均 HTTP 400 / `code=E_INVALID`）
| 载荷 | 原文 message（逐字节选） | 断言 |
| --- | --- | --- |
| `{"packages":["pkg; rm -rf /"]}` | `请检查包名 "pkg; rm -rf /"：只接受字母数字 . _ - 和可选的 ==版本，不要写空格、分号、斜杠或 --user 选项` | E_INVALID PASS |
| `{"packages":["../evil"]}` | 同上模板，包名 `"../evil"` | E_INVALID PASS |
| `{"packages":["--index-url=http://evil.example/simple"]}` | 同上模板，拒绝选项串 | E_INVALID PASS |
| `{"packages":["a"×300]}`（超长 300 字符） | 同上模板，拒绝超长名 | E_INVALID PASS |
| `{"packages":["koreprobe"],"prefix":"/etc"}` | `runtime-python.ext.install 参数非法，请传 JSON 对象: json: unknown field "prefix"` | E_INVALID PASS（调用方路径无法绕过固定前缀） |
| `{"packages":["koreprobe"]}` 且 `<state>/global/py_ext` 是指向 `<iso>/outside-ext` 的软链 | `隔离扩展目录指向了状态目录之外的位置，请删除该软链后重试` | E_INVALID PASS（真实层 containment 拒绝，未跟随写外部） |

> 说明：边界载荷经真实 invoke→真实插件白名单/路径校验链执行；**未**用假执行面替代。软链用例在全部正常闭环完成后构造，随即 `rm -f` 清掉，隔离目录最终为空。

**汇总**：2+3+2+2+4+6 = **19 条逐项断言**（脚本内 16 条显式 ASSERT + §② 的 METADATA 落盘 stat/cat 2 条 + §⑤ 的 HTTP 200 前提；HTTP 200 不另计），0 FAIL。所有 8 次成功 invoke 均 `__HTTP__=200`，6 次边界 invoke 均 `__HTTP__=400`。

## 3. 与既有 P1+P2 验收的衔接

`py-ext-verification.md`（task-291）判 5/5 PASS 并明确「真机 PyPI 未验证留 P3」。本卡把其唯一未验项推进为：**真机（隔离实例 + 真插件二进制 + 真 pip）+ 真闭环（install/list/remove）+ 宿主零改动**已验证；唯独「PyPI 联网下载」按任务卡禁令仍为**未验证**（以本地 wheel 替代，不伪造联网成功）。install 固定 argv 的生产代码路径在本次真机中被实际执行（pip output 原文为证），不是单测替身。

## 4. 清理与边界回读（命令 + 退出码）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 停服 | harness `trap cleanup EXIT`：kill `KORED_PID` 后 `wait` | `ss -ltn | grep :55201` → `NO LISTEN (stopped)` |
| 8787 未受影响 | `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz` | `200` |
| 主配置未改 | `stat -c '%y' .kore-local.yaml` | `2026-11-25 20:15:44 +0800`（早于本轮 11-28） |
| 宿主 git 工作树 | `git status --short` | 仅存量他人 dirty（`M scripts/usability-pending.txt` + 多个存量 `??`），**无本轮新增文件、无 `bin/kored` 改动** |
| 一次性脚本 | `rm -f .tmp/pyext-live-harness.sh` | 跑完立即删除（用户明令）；回读不存在 |
| 隔离临时资产 | `rm -rf .tmp/pyext-live-iso`（含 config/state/run/log/index/wheels/kored/cookies/快照/响应原文） | 回读不存在 |
| 凭据 | 明文口令仅在 harness 内存 + `login.json`（位于隔离树，随树删除）；报告只出现 PBKDF2 哈希的「格式」描述，无明文/哈希值 | 未进 argv / 未落报告 |
| 宿主 site-packages | 未执行任何 `pip install` 到宿主目录；所有 pip 均 `--target <iso>/state/python/global/py_ext` | 三次快照 sha 全等 |

## 5. 暴露缺陷

**未发现生产缺陷。** 唯一一次 FAIL 是首轮 harness 自身的 grep 用了大写 JSON 键（`"Name"`/`"Version"`），而 Go struct tag 为小写 (`"name"`/`"version"`）；核对原始响应确认返回值正确后修正 grep 并**全量重跑**（`rm -rf` 隔离树、清空转录），第二轮 16/16 PASS。此为验证脚本缺陷、非产品缺陷，按诚实原则在此披露。原首轮转录已被第二轮覆盖，未伪造任何结果。

## 6. 证据文件与转录索引

- 完整命令 / 退出码 / 原文转录：`/home/pt/Work/GolandProjects/kore-pl/.tmp/pyext-live-transcript.txt`（233 行，含 8×`__HTTP__=200` + 6×`__HTTP__=400`、16 条 `ASSERT … PASS`、0 `FAIL`）。**按用户「临时资产删净」纪律，本报告提交前该转录与隔离树一并删除，报告已逐条内嵌关键原文。**
- 报告本体：`.agents/verify/py-ext-live.md`（本文件，唯一写域）。

## 7. 诚实边界

1. 单机单隔离实例（55201），无竞品同口径对照；不构成跨机/并发结论。
2. install 是离线本地 wheel（自制 `koreprobe-9.8.7`，纯 stdlib zip 构造），**非真实 PyPI 联网**；任务卡禁联网业务，未声称 PyPI 真下载通过。
3. 受控删除 containment 真机只覆盖「外部软链拒绝 + 包目录/dist-info 消失 + 宿主零改动」；完整边界组合（如更深路径逃逸、并发删除、符号链接指向隔离树内层）由既有单测 `ext_test.go:278-322` 覆盖，本卡未逐项真机复跑。
4. 宿主 site-packages 快照覆盖 `python3 -m site` 列出的三个真实 site 目录（含用户态 `~/.local`）；未覆盖 pip 的 HTTP 缓存目录（本次 `PIP_CACHE_DIR` 指向隔离树）与 Python 解释器自身目录（`python3 -m pip install` 无 `--target` 才可能写，本次固定 argv 带 `--target`）。
5. 插件进程未降权（非 root 内核，`demotion.enabled=false`），env 继承是设计路径（`supervisor/start.go:108`），不是绕过隔离。

—— `pyext-live`（task-292 真机验证 worker，verifier 另派）
