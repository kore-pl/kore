# C12 P3 生产代码 VM 复验报告 · 独立验收（task-345 / G-09 verifier）

> 2026-11-28 · 复核者：`c12-prod-vm-verifier`（G-09 独立 verifier，**非** `c12-prod-vm` 实现/worker 本人；implementer ≠ verifier，G-09 成立）。
> 复核对象：commit `2b526bf8232824f826d8c003edb3861a39143b61`（259 行单文件报告 `.agents/verify/c12-prod-vm.md`），任务 `task-344`（原 worker 报告）。
> 复核方式：**只读复核 + 独立复算关键数字**，不改生产代码、不启服务、不联网、不写宿主 `/etc/ssh`、不动运行态。
> 唯一写域 = 本报告 `.agents/verify/c12-prod-vm-verification.md`；精确 `git add` + `commit -s`，不 push。

## 总评：**PASS**　｜　宿主零写入判定：**成立（零写入）**

六项范本逐条核对成立，五场景数字自洽（关键 sha / size / mode 全部独立复算一致），清理与 git 纪律坐实。**未发现不自洽、未发现宿主被写**。容器与 harness 已删，宿主 `sshd_config` sha `f5f0b404…` 前后一致、无 sshd 进程，8787 healthz 200。

---

## 0. 待验报告本体（commit 2b526bf）核验

| 项 | 期望 | 实测（命令 + 退出码 / 输出） | 结论 |
|---|---|---|---|
| HEAD = 2b526bf | 精确短 sha | `git rev-parse HEAD` → `2b526bf8232824f826d8c003edb3861a39143b61`；`git rev-parse --short HEAD` → `2b526bf` | ✓ |
| 单文件 259 行 | 1 file / +259 | `git diff-tree --no-commit-id --name-only -r 2b526bf` → `.agents/verify/c12-prod-vm.md`（1 文件）；`git show --numstat` → `259  0`；`wc -l < 报告` → `259` | ✓ |
| DCO | Signed-off-by | `git log -1 --format=%b 2b526bf` → `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`；首行 `[agent:c12-prod-vm]` 前缀 | ✓ |
| 未 push | 远端无此 commit | `git branch -r --contains HEAD` → 空；`git for-each-ref --contains 2b526bf refs/remotes` → 空；`git status -sb` → `## main...origin/main [领先 11]`；`git tag --points-at HEAD` → 空 | ✓ |
| 父提交 | 3aea81e | `git rev-list --parents -n 1 2b526bf` → `2b526bf… 3aea81e57618dd3a448a4d1785a6e15b92d33b71`；`git merge-base --is-ancestor 3aea81e HEAD` → exit 0 | ✓ |
| 单 worktree / 无临时分支 | 1 行 | `git worktree list` → 仅 `/kore 2b526bf [main]` 一行；`git branch --list 'wt-*' 'tmp-*'` → 空 | ✓ |
| 他人 dirty 原样 | 未触碰 | `git status --short` → `M scripts/usability-pending.txt` + 多个 `??`（e2e-*.md / screenshots / .gocache-* / data/ / dist/ 等），与报告 §6 记载一致，本复核未改 | ✓ |

---

## 1. ① 六项范本逐条核对（file:line + 命令 + 退出码）

### ① 后端读码 / 单测（PASS）
- `methods.go:69-72` 派 `apply-hardening → handleApplyHardening`、`rollback-hardening → handleRollbackHardening`（`sed -n '65,92p'` 实读确认），`businessVerb` 白名单含两 verb。
- `info.json:20-21` 两方法 `system:admin`（实读 `sed -n '18,24p'` 确认）。`info.json:77-96` 两 `root_action`：`sshd-dropin-write` prefix_class=`sshd.config.d`/mode=`0644`/policy=`sshd.dropin.v1`/max_bytes=65536/writes_host=true/target=`/etc/ssh/sshd_config.d/`，无静态 purge_op；`sshd-dropin-delete` 对应 file_delete（实读确认）。
- `hardening.go:93` `handleApplyHardening` 复用 `renderSuggestConfig`；`rootActionClient.WriteFile`（`:152-158`）请求体只含文件名+正文。
- `banwrite_test.go:73 TestMethodCapabilitiesMatchMethods`、`hardening_test.go:51 TestApplyReusesSuggestRenderAndWritesDropIn`、`declaration_test.go:28 TestRootActionsDeclared` 等断言存在（报告 §1 逐条列出）。

### ② 门禁三仓（PASS，见 §4 详述）
pluginapi `go test -race` exit 0 / ssh-guard `make check` exit 0 / kore `make check` exit 0（21/21 `[OK] 门禁全部通过`）。

### ③ 隔离五场景真生产代码（PASS，重点核对）
- **真生产代码口径**：报告称 `git archive HEAD(3aea81e)` 导出、直接 import 生产包、逐字节复制生产 `changes.go`、零内联补丁。本复核独立复算报告 §3.1 列出的四个关键文件 sha（工作区与 `git show HEAD:` 两路取，均一致）：
  | 文件 | 工作区 sha(8) | HEAD sha(8) | 报告声称 | 一致 |
  |---|---|---|---|---|
  | `cmd/kored/changes.go` | `2914090b` | `2914090b` | `2914090b…` | ✓ |
  | `cmd/kored/filewrite.go` | `e265a670` | `e265a670` | `e265a670…` | ✓ |
  | `internal/core/privilege/filewrite.go` | `ec4c9fd9` | `ec4c9fd9` | `ec4c9fd9…` | ✓ |
  | `pkg/pluginapi/sshdconf.go` | `8179706a` | `8179706a` | `8179706a…` | ✓ |
  命令：`for f in …; do sha256sum "$f" | cut -c1-8; done` 与 `git show HEAD:"$f" | sha256sum | cut -c1-8`。工作区文件与 HEAD 逐字节一致 → 报告"零内联补丁 / 直接 import 生产包 / 逐字节复制生产 changes.go"口径与当前 HEAD 生产代码事实相符。（harness 与隔离源码已在清理阶段删除，无法重跑二进制，但其引用的生产源文件 sha 已复算一致、报告编译/运行命令+退出码原文齐备。）
- **依赖口径**：`go.mod` 仅 `require github.com/pengtang1024/kore/pkg/pluginapi v0.4.0`（实读确认）；`go.sum` 两行 `h1:1M02oDq4jwKO/...=` 与 `h1:yg6DLNEISL1kqt4tlppm2xICAaTb42zcsX1MKk8SAvU=` 与报告 §2 离线 proxy 实测逐字一致。
- **task-337 祖先 claim**：`git merge-base --is-ancestor 1ff4230 HEAD` → exit 0（YES），`git log --oneline 1ff4230 -1` → `[agent:ledger-mode-fix] fix(filewrite): 账本回滚逐属性还原 mode`。修复确在 HEAD 祖先中。
- **mode 修复代码**：`cmd/kored/changes.go:180-185` 改用 `filewrite.Restore(dst, src)`（不再裸 os.Rename，注释说明 0600 退化根因）；`internal/core/filewrite/filewrite.go:412-418 copyFile` 备份保留源 mode、`:517+ Restore` 读备份 mode 经 atomicWrite 还原（实读确认）。

### ④ 六处 sha（PASS）
目标 `c380cb6c3a9c86b13c50438c7fd62b80391df3da531e703805002f54f38f2ccb`。逐处复算：
| # | 位置 | 命令 | 实测 |
|---|---|---|---|
| ① | dist 实测 | `sha256sum kore-plugin-ssh-guard/dist/ssh-guard-0.5.0.tar.gz` | `c380cb6c…ccb` ✓ |
| ② | dist sidecar | `cat dist/ssh-guard-0.5.0.tar.gz.sha256` | `c380cb6c…ccb` ✓ |
| ③ | index/plugins.json:110 | `sed -n '105,115p'` | sha `c380cb6c…ccb`，size_bytes=2880509 ✓ |
| ④ | versions.lock.json:300 | `sed -n '295,305p'` | 0.5.0 sha `c380cb6c…ccb`（0.4.1 保留 `8d1c5c77…`）✓ |
| ⑤ | presets/full.json:40 + security.json:10 | `sed` 两处 | pin `ssh-guard 0.5.0` ✓ |
| ⑥ | market/plugins.js | `grep -n ssh-guard` | `version:"0.5.0"`，由索引派生 ✓ |
- `bash scripts/validate-index.sh`（kore-plugins）独立复跑 → **exit 0**，末 `[OK] 索引校验全部通过` + `[OK] market/plugins.js 与索引逐字节一致（24 个插件）`。
- 实测 dist size `stat -c %s` = `2880509`（与索引一致）；`info.json:41 size_bytes=2880507` 与实测差 2，报告已诚实标注为自指估算容差、不作判定依据——与事实相符。

### ⑤ G-28 双端截图实读（PASS）
- `identify`（本机 `/usr/bin/identify`）实读：
  - desktop → `PNG 1440x2874 8-bit sRGB 405784B`，sha `9ffbd3c6…`（`sha256sum` = `9ffbd3c621a03010ad6448a1e998498e97a8f30be53b17e40a0e94c3bc44f3e2`）。
  - mobile → `PNG 390x4033 8-bit sRGB 363969B`，sha `aee7a9cc…`（`aee7a9cc23b162e861917dd51d6978e84cbbe7a5b59f9c18c3211f72b08d0eed`）。两图宽高/字节/sha 各异，非同图缩放。
- `read_image` **实读两图**（本 verifier 亲看）：桌面图见「安全 → 网络边界 → SSH 防护」页 + 「确认一键应用加固？」模态框：文件路径 `/etc/ssh/sshd_config.d/kore-ssh-guard-hardening.conf`、`权限 0644 root:root`、三条 diff（`PasswordAuthentication yes→no` / `PermitRootLogin prohibit-password→no` / `MaxAuthTries 6→3`）、两条风险+回滚、两条黄底警示（应用不 reload / 保留密钥会话）、勾选框 + 取消/确认，页下 dry-run 预览与落地/验证命令同屏；手机图窄屏单列呈现同一确认框，diff/风险/警示/勾选/按钮完整可读、底部 tab 不遮挡关键内容。与报告 §5 描述逐项吻合，确认非伪造。
- 三问原文：`.agents/verify/sshguard-dropin-selfeval.md` 存在，`sed` 实读确认「问 1：本页解决什么用户问题？/ 问 2：与宝塔 / 1Panel 同类功能的差距？/ 问 3：当前是"可用"还是"占位"？」（答「可用（受控范围）」）——报告复用原文属实。

### ⑥ git 纪律（PASS）
三仓 HEAD DCO / 未 push / 无 tag / 单 worktree / 他人 dirty 原样，逐项见 §0 表与下方三仓表（kore `2b526bf`、ssh-guard `604321d`、plugins `6f64259` 均 `Signed-off-by: pengtang1024`、`branch -r --contains` 空、`worktree list` 各 1 行）。

---

## 2. 五场景真实性 / 数字自洽（关键数值独立复算）

用 `printf … | sha256sum` 独立复算报告 §3.2/§3.4 的写入载荷：
| 载荷（报告原文） | 报告声称 | 复算 size | 复算 sha256 | 一致 |
|---|---|---|---|---|
| `PasswordAuthentication no\nMaxAuthTries 3\nPermitRootLogin prohibit-password\n` | size 75 / sha `9c4d99031776772393fb803498a157862d88ed6367e1d0582fb94c41303a518d` | `wc -c`=75 | `9c4d9903…a518d` | ✓ |
| `PasswordAuthentication no\nMaxAuthTries 6\nPermitRootLogin yes\n` | size 61 / sha `c6a0dbb3…` | `wc -c`=61 | `c6a0dbb3675ad3c995a22745f9d96faab1c732695604dc30fee9da12b64aad3a` | ✓ |

- **场景① 一键应用**：报告 RESULT `executed:true` / `host_change_recorded:true` / file_write sha `9c4d9903…`（复算一致）、mode `420` = `0644`（`printf '%o\n' 420` → `644` ✓）；账本 `changes.jsonl` 一条 `sshd-dropin-write` + 运行时 `purge_op=file.remove`；审计 begin(ExitCode:-1)/end(ExitCode:0) 同 sha、无正文。数字自洽。
- **场景② sshd -t/-T**：报告 `sshd-t-rc=0`，`-T` 输出 `passwordauthentication no` / `maxauthtries 3`（基线 `yes`/`6`），与载荷一致。
- **场景③ 按账本逐字节+逐属性回滚**：二次覆盖写 sha `c6a0dbb3…`（复算一致）触发备份 `file.restore(备份,目标)`；purge 后目标 sha 回到 `9c4d9903…`、`mode=644 root:root size=75`（逐字节 + mode 守恒）；`sshd -t/-T` 仍绿。mode 守恒由 `changes.go:180-185` + `filewrite.go` copyFile/Restore 代码坐实，`1ff4230` 祖先已验。数字自洽。
- **场景④ 四类拒绝 + fail-closed**：报告逐条列 7 条 REJECT（路径穿越/前缀/后缀/Include/AuthorizedKeysCommand/MaxAuthTries abc/MaxAuthTries 999）均 rc=0 预期被拒；`auditfail` → `executed=false err=E_INTERNAL` exec-rc=1，目标文件与 `.kore-write-*` 临时文件均无 → 零半写入。逻辑自洽（容器已删，无法重跑二进制；断言原文+退出码齐备）。
- **场景⑤ 容器密钥 SSH**：加固后 `ssh -i` `SSH_OK` + `tuser` rc=0；密码认证 `Permission denied (publickey,keyboard-interactive)` 被拒。额外 `sshd-dropin-delete` 真实 file_delete 回滚链路（备份 0644 root:root sha `9c4d9903…` + `file.restore` 账本 + sshd -t exit 0）。原文自洽。
- 诚实边界（容器非真机 / 无 systemd-PAM / OCK 靠 -t/-T + 短时连通 / 无竞品同口径）报告 §3.7 逐条写明，未越界宣称。

> 说明：容器/harness 已按纪律清理，本 verifier 不重启服务、不重建容器，故五场景**运行时不可重放**；核对口径为「原文命令+退出码齐备 + 所有可独立复算的数字（sha/size/mode/祖先/代码行）全部自洽」。未发现任何数字矛盾或引用错误 → 不构成 BLOCKED。

---

## 3. 门禁三仓 + 1 FAIL 归因（PASS）

- 报告 §2 三仓命令与退出码齐备：pluginapi `go test -race` exit 0（2 包）；ssh-guard `make check` exit 0；kore `make check` exit 0（21/21 `[OK] 门禁全部通过`）。本复核未重跑全量 make check（只读纪律 + 不启服务），但独立复跑了 `validate-index.sh` → exit 0（见 §1 ④）。
- **usability 1 FAIL 归因核对（属实）**：
  - 工作区 `scripts/usability-pending.txt` 当前为他人 dirty：`git diff --stat` → `20 +++---`（3 insertions / 17 deletions），`git diff | grep -c '^-'`=18。工作树中 `A1 waf` 已不在清单（仅存注释行），而 `git show HEAD:scripts/usability-pending.txt | grep` → 第 42 行 `A1 waf` **仍在 HEAD 版清单**。→ 报告「dirty 删了含 A1 waf 的存量豁免」属实。
  - 报告称用 HEAD 版 pending + 隔离 cache 复跑 `usability-check.sh` → exit 0 / `0 pass, 504 warn, 0 fail, 194 unverified`，坐实 0 新增 FAIL；dirty 口径下唯一 FAIL = `A1 waf: ZeroParam 真跑失败`（WARN 级不阻断）。该 FAIL 归因于他人 dirty 清单删条目 + 环境层，P3 未改 waf 一行。归因逻辑自洽，与 HEAD/工作区清单差异一致。

---

## 4. 清理 / 宿主零写入（PASS）

| 项 | 期望 | 实测（命令 + 输出） | 结论 |
|---|---|---|---|
| 宿主 `sshd_config` | sha f5f0b404… 前后一致 | `sha256sum /etc/ssh/sshd_config` → `f5f0b40412fd9a84b787d967efbcb576728d398e8d40d0d32c825004a04a4999` | ✓ 零写入 |
| 宿主 sshd 进程 | 无 | `pgrep -a sshd` → 无输出（exit 1） | ✓ 未启/未重启 |
| 容器 kore-sshguard-prod | gone | `docker ps -a --filter name=kore-sshguard-prod --format '{{.Names}}'` → 空（rc=0） | ✓ |
| harness/proxy/.tmp | gone | `ls -ld .tmp/c12-prod-vm` → No such file；`find .tmp -name '*c12*'` → 无残留；`find … -name c12prodvm` → 空 | ✓ |
| 8787 healthz | 200 | `curl -s -w '%{http_code}' http://127.0.0.1:8787/-/healthz` → `http_code=200` / `{"status":"ok"}` | ✓ 主实例未受影响 |
| 凭据不进 argv/报告 | 无明文 | 报告 `grep -nE '…PASSWORD=|"password"|"secret"|"token"|BEGIN …PRIVATE KEY'` → 无命中（G-30） | ✓ |

**宿主零写入判定：成立。** 宿主 `/etc/ssh/sshd_config` sha 与报告基线 `f5f0b404…` 逐字一致、无 sshd 进程、8787 主实例健康；全部写盘在容器 `/iso/**`，容器与临时物已删。

---

## 5. 三仓 git 纪律汇总

| 仓库 | HEAD | DCO | 远端含 HEAD | tag@HEAD | worktree | 他人 dirty |
|---|---|---|---|---|---|---|
| kore | `2b526bf` | ✓ | 空（[领先 11]） | 空 | 1 | `M scripts/usability-pending.txt` + 多 `??` 原样 |
| kore-plugin-ssh-guard | `604321d` | ✓ | 空（develop 无 upstream） | 空 | 1 | `?? zeroparam_test.go` 原样 |
| kore-plugins | `6f64259` | ✓ | 空 | 空 | 1 | `?? .tmp-validate-out.txt` / `?? dist/` 原样 |

`git diff-tree` 精确路径核对：kore `2b526bf` 仅报告 1 文件；ssh-guard `604321d` 11 文件；plugins `6f64259` 6 文件；无 `git add .` 痕迹。

---

## 6. 结论与遗留

**PASS。** 六项范本逐条 file:line + 命令 + 退出码核对成立；④ 六处 sha `c380cb6c…` 一致（dist 实测/ sidecar / index / versions.lock / 2 presets / market，附 validate-index exit 0）；⑤ G-28 双端截图 identify + read_image 实读、三问原文属实；⑥ 三仓 DCO + 未 push + 单 worktree + 他人 dirty 原样。② 五场景关键数字（载荷 sha/size/mode、祖先、回滚 mode 守恒代码）全部独立复算自洽，数字不自洽的 BLOCKED 条件未触发。③ 门禁与 1 FAIL 归因属实。④ 清理彻底、**宿主零写入成立**。⑤ commit 2b526bf 精确单文件 259 行 + DCO + 未 push + 单 worktree。

无缺陷、无需回派卡。诚实边界同原报告（容器非真机、OCK 靠 -t/-T + 短时连通、无竞品同口径）。本 verifier 未 push / 未启服务 / 未联网 / 未写宿主 `/etc/ssh`；唯一写域为本报告。

—— `c12-prod-vm-verifier`（task-345，G-09 独立 verifier；写域仅本报告）
