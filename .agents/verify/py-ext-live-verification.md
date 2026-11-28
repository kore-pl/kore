> 元信息: 2026-11-28T08:15+08:00 · 复核者 pyext-live-verifier（G-09，独立 verifier，非 pyext-live implementer）· task-293 · 只读复核 Python ext P3 真机报告
> 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore` · 全程只读（唯一写域=本文件）· 未改代码 / 未启服务 / 未联网 / 未碰 `.kore-local-*` 与宿主 site-packages / 未 push

# Python ext P3 真机报告 — 独立核验结论

## 0. 总评：**PASS**

复核对象：commit `f9a4586`（`[agent:pyext-live] docs(verify): … 16/16 PASS`），报告体 `.agents/verify/py-ext-live.md`（112 行）。
**所有可事后独立核验的断言全部自洽，未发现数字不自洽或证据不成立；不触发 BLOCKED。** 三项诚实边界与一处口径澄清见 §3。

## 1. 前置条件核验

| 项 | 任务卡要求 | 实测命令 / 结果 | 结论 |
| --- | --- | --- | --- |
| 隔离实例端口 | 55201 非 8787 | 报告 §1 载 `127.0.0.1:55201`；清理后 `ss -ltn \| grep ':55201'` → **NO LISTEN**；8787 全程未动 | PASS |
| 临时二进制 ≠ 宿主，未覆盖 | `4ed291bb…` ≠ `5ffc2337…` | `sha256sum bin/kored` → `5ffc2337e958e222a8da686d1bed3d724e9dec97af4a3fc3f9b474f7e4f62322`（64 hex，与报告 §24 宿主值逐字一致）；报告临-tree sha `4ed291bbd500bbb14f4ba3d5b0472d8dd7cdafb86429ce28c3f93a655dd7007c`（64 hex）≠ 宿主值 | PASS |
| 插件 tar sha 与索引一致 | `cc9d8712…` | `sha256sum dist/runtime-python-0.5.0.tar.gz` → `cc9d8712575f6d04c4192c9ceb25aaf5732a516b1bdcd6c3f71b07b20182252a`；`kore-plugins/index/plugins.json:209` 与 `versions.lock.json:572` 同为 `cc9d8712…` | PASS |
| 受验 HEAD | `kore@e792bd4e` / 插件 `f3cc4fda` | `git cat-file -t e792bd4…` → commit 存在且为 f9a4586 祖先；插件仓 `git rev-parse HEAD` → `f3cc4fda165cf5c43f5288b89cc57dfd2702903f` | PASS |

## 2. 16 断言自洽核验

逐条把报告原文对照生产代码与实际哈希/算术，均可回溯：

| 断言 | 报告主张 | 核验依据（只读实测） | 结论 |
| --- | --- | --- | --- |
| 宿主 site-packages 基线 | sha `49a0b6d3…cca620`，27447 行 | 该 sha 为 64 位合法 hex；快照文件随隔离树按纪律删除（报告 §101 如实声明），属**内嵌原文型证据**，见 §3 边界 A | PASS（格式/口径自洽） |
| 本地 wheel | `koreprobe-9.8.7` 743 B，纯 stdlib | 报告 §23 构造法与 §45 pip output 逐字吻合；pip 输出 `Successfully installed koreprobe-9.8.7` 格式正确 | PASS |
| 离线机制 | `PIP_NO_INDEX=1` + `PIP_FIND_LINKS` 经 env 继承，argv 不改 | `kore-plugin-runtime-python/internal/pyop/ext.go:286-292` 固定 argv `python3 -m pip install --target <prefix> --no-input --disable-pip-version-check <pkgs>`，**无** `--no-index`/`--find-links`；`kore/internal/core/supervisor/start.go:108` `cmd.Env = append(os.Environ(), env...)` 证明确走 env 继承 | PASS |
| install 200 | Successfully installed koreprobe-9.8.7 | §44-46 原文自洽，`network_used:true`、`prefix` 指向 `<state>/global/py_ext` | PASS |
| list 空态→有值，来自 METADATA | count 0 → 1，name/version 读 METADATA | `ext.go:357-406` `ListPackages` 只读 `*.dist-info/METADATA`（egg-info 兜底），`readExtMetadata` 解析 `Name:`/`Version:`，目录名仅兜底；与 §51 主张一致 | PASS |
| 宿主三次快照 sha 全等 + cmp exit0 | before=after=final，`cmp -s` exit 0 | 报告 §54-56 三次口径一致；快照文件已删（同边界 A）；报告未声称重新生成 | PASS（口径自洽） |
| remove 200 | `removed:[koreprobe,koreprobe-9.8.7.dist-info]`、复列 count0、宿主零改动 | `ext.go:305-352` `RemovePackages` 收集匹配项名入 `Removed` 并输出 `已移除: …`，与 §60 原文吻合；复列 count0 由 list 逻辑支撑 | PASS |
| 边界①分号注入 | HTTP400 E_INVALID | `ext.go:252-266` `validateExtPackages` → `venv.go:33` `packageSpecPattern` 拒 `;`；§67 message 与 `ext.go:263` 模板逐字一致 | PASS |
| 边界② `../evil` | HTTP400 E_INVALID | 同一正则拒 `/`；§68 一致 | PASS |
| 边界③ `--index-url` | HTTP400 E_INVALID | 同一正则拒前导 `-`；§69 一致；`ext_test.go:100` 明确列入坏包名 | PASS |
| 边界④ 300 字符超长 | HTTP400 E_INVALID | `packageSpecPattern` 名称段 `{0,127}`（含首字符最多 128）→ 300 字符必拒；§70 一致 | PASS |
| 边界⑤未知字段 `prefix=/etc` | HTTP400 E_INVALID | `pyop/call.go:121` `dec.DisallowUnknownFields()`；`ext.go:105` message 模板 `runtime-python.ext.install 参数非法，请传 JSON 对象: …` 与 §71 一致 | PASS |
| 边界⑥软链逃逸 | HTTP400 E_INVALID（containment 真拒） | `ext.go:226` message `隔离扩展目录指向了状态目录之外的位置，请删除该软链后重试` 与 §72 逐字一致；`ext.go:189,245` EvalSymlinks 真实层校验 | PASS |
| 8×200 + 6×400 = 16 PASS | 8 成功 / 6 边界 | 报告 §76 明确 16 = 脚本 16 条显式 ASSERT；HTTP invoke 为 8+6=14 次。见 §3 口径澄清 B | PASS（见澄清） |

**代码路径核对小结**：production argv 未改、包名白名单、JSON 严格解码、METADATA 读值、软链 containment 五条关键链路均在源码逐行对上，报告未把单测替身冒充真机路径。

## 3. 诚实边界与口径澄清（不构成 BLOCKED）

- **A｜内嵌原文型证据的可复算性**：宿主 site-packages 基线 sha（`49a0b6d3…cca620`，27447 行）、三次快照 sha 全等、`cmp exit0`、233 行转录，因隔离树/转录按用户「临时资产删净」纪律已在提交前删除（报告 §90-92、§101），**事后无法重算这些已删文件本身**。我核到的是：sha 格式合法、报告逐条内嵌关键原文、口径前后一致、与代码路径吻合。这是删除纪律的必然结果而非证据伪造；报告 §101 已如实声明。列为可核验性边界，不判 BLOCKED。
- **B｜「16」口径**：任务卡字面 `8×200+6×400=16PASS` 中 8+6=14 为 HTTP 请求数；报告 §76 解释 16 = 脚本显式 ASSERT 条数，19 = 16 ASSERT + 2 METADATA + 1 HTTP200 前提。两者维度不同、报告内部自洽，非算术错误；本报告据实点明以免把 16 误读为请求数。
- **C｜报告自述的三条限制如实存在**：离线本地 wheel 非真实 PyPI 联网（§10/§107）；containment 真机只验「外部软链拒绝 + 包目录/dist-info 消失 + 宿主零改动」，完整组合由单测 `ext_test.go:278-322`（已核，测试内容吻合）覆盖（§108）；无竞品同口径（§106）；首轮 JSON 键大小写误报 2 FAIL 修正后全量重跑并披露（§97）。均符合诚实要求。

## 4. 隔离清理核验

| 项 | 实测命令 / 结果 | 结论 |
| --- | --- | --- |
| 55201 无监听 | `ss -ltn \| grep ':55201'` → NO LISTEN | PASS |
| 8787 healthz | `curl -w '%{http_code}' http://127.0.0.1:8787/-/healthz` → **200** | PASS |
| 无 kored 残留 | `ps -eo pid,args \| grep '[k]ored'` → 仅本次核验 shell 自身，无隔离实例进程 | PASS |
| `.kore-local.yaml` 未变 | `stat -c '%y'` → `2026-11-25 20:15:44 +0800`（早于本轮 11-28），与报告 §88 一致 | PASS |
| harness/隔离树/转录全删 | `ls .tmp/pyext-live-{harness.sh,iso,transcript.txt}` → 三者均 No such file（exit 2） | PASS |
| git 无临时资产 | `git status --porcelain` 无本轮新增临时文件 | PASS |

## 5. Git 纪律核验

| 项 | 实测命令 / 结果 | 结论 |
| --- | --- | --- |
| f9a4586 精确单文件 | `git diff-tree --no-commit-id --name-only -r f9a4586` → 仅 `.agents/verify/py-ext-live.md`；`git show --stat` → 1 file changed, 112 insertions(+) | PASS |
| DCO | `git log -1 --format=%B f9a4586` 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`；首行带 `[agent:pyext-live]` | PASS |
| 未 push | `git merge-base --is-ancestor f9a4586 origin/main` → false；`git rev-list --count origin/main..main` → 3（领先 3） | PASS |
| worktree 仅主树 | `git worktree list` → 1 行（主树）；`git branch --list 'wt-*' 'tmp-*'` → 空 | PASS |
| 他人 dirty 原样 | `git status`：存量 ` M scripts/usability-pending.txt` + 多个存量 `??`；未动 | PASS |
| 他人存量 secret FAIL 未动 | `make secret-check` → 1 FAIL：`backup-download-verification.md:125`（该文件在已提交 `ddb4bfb` 中、`git status` clean，属他人存量 FAIL）；按任务卡要求**未改** | PASS（符合未动要求） |
| 报告本体 secret 单扫 0 FAIL | 以 `scripts/secret-check.sh` 同一正则单扫 `.agents/verify/py-ext-live.md` → **0 匹配 / 0 FAIL** | PASS |

> 说明：仓库级 `make secret-check` 因他人存量文件仍报 1 FAIL，这是任务卡明确要求「原样不动」的既有状态，非本轮引入；本核验报告与受验报告本体均为 0 FAIL。

## 6. 结论

前置条件、16 断言自洽、诚实边界披露、隔离清理、git 纪律五个维度全部通过，无一项触发 BLOCKED。受验 commit `f9a4586` 成立。

**总评：PASS** — 独立 verifier 复核通过，同意验收。

—— `pyext-live-verifier`（task-293，G-09 独立复核；未复用 implementer 结论）
