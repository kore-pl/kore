# A3 方案A合并后核验报告（G-09 / task-108）

- 核验人：`a3-merge-verifier`（独立 verifier，非 a3-push-a/b 实现者）
- 时间：2026-11-26（Asia/Shanghai）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl`（各仓 git 根在自身目录）
- 性质：**只读核验**；唯一写入=本报告（精确 `git add` + `git commit -s [agent:a3-merge-verifier]`）
- 结论：**5 项核验全绿；索引无需改动；可放行推送**（见文末总评）

---

## 核验① dist 位级一致性（7 仓实测 sha256 + stat 字节 vs `kore-plugins/index/plugins.json`）

方法（每仓）：`python3 hashlib.sha256(open(dist/<id>-<ver>.tar.gz,'rb').read()).hexdigest()` + `os.stat().st_size`，与 index `plugins` 数组对应 id 条目的 `version / sha256 / size_bytes / download_url` 逐字段比对。索引条目取自 `kore-plugins/index/plugins.json`（HEAD `b007a16`，24 条插件）。

| 仓库 | 版本（dist / idx） | sha256 实测 == 索引 | size_bytes 实测 == 索引 | download_url 含 v<ver>+<id>-<ver>.tar.gz | 判定 |
|---|---|---|---|---|---|
| kore-plugin-waf | 0.5.3 / 0.5.3 | ✅ `313757ed25291d64a92f343e004e053bee6a47dcf4753bfbe9113d8a3c749908` | ✅ 2947731 == 2947731 | ✅ | PASS |
| kore-plugin-firewall | 0.3.2 / 0.3.2 | ✅ `0459006143c8d7d50d09bf22ba5907ba23d2ea61545b2d22db66529fa0d816cc` | ✅ 2883884 == 2883884 | ✅ | PASS |
| kore-plugin-app-deploy | 0.4.2 / 0.4.2 | ✅ `9cb53ea2a7fc0d0cbc3ae4b93ba304078bc13d65442e33a1aced26f94899e9f9` | ✅ 1708905 == 1708905 | ✅ | PASS |
| kore-plugin-runtime-node | 0.3.2 / 0.3.2 | ✅ `135980a94940ea8eb2d60aa3f64609602c6d5bd48194bb1f896d180c21fa3e44` | ✅ 1563494 == 1563494 | ✅ | PASS |
| kore-plugin-runtime-php | 0.3.2 / 0.3.2 | ✅ `cd9ae451bb4d535f66fef68462e77118d6acfc75ac18e957810c11ab47da6893` | ✅ 1566386 == 1566386 | ✅ | PASS |
| kore-plugin-runtime-python | 0.4.2 / 0.4.2 | ✅ `d8d2d16fc6feaa194c8354ce6abc2ada435f420fff0bafcc7a8ae28bfe458ce6` | ✅ 1586608 == 1586608 | ✅ | PASS |
| kore-plugin-db-postgres | 0.4.2 / 0.4.2 | ✅ `b2d86eda6397b30c14ef18235350363dcb6aa8f500c211677649b66b678f97f0` | ✅ 1671263 == 1671263 | ✅ | PASS |

比对脚本总判定 `ALL_OK=True`。**这印证了两批 worker 的判断：dependabot 只改 `.github/workflows/ci.yml`，不进 dist 包，故重打 dist 后 sha/字节与合并前索引记录逐字节一致 → 索引无需任何改动。**

---

## 核验② tag 签名 + peeled == main HEAD == merge commit + A3 打包提交为第一父

方法（每仓）：`git tag -v <tag>`（Good signature + object sha）+ `git rev-parse main` / `git rev-parse <tag>^{}` 比对 + `git cat-file -p HEAD` 读两父 + `git log -1 --format=%s <parent>` / `git diff-tree --name-only -r <parent>` 判父身份。

| 仓库 | tag | tag -v | peeled == main HEAD | == 预期 merge | 第一父（A3 打包提交） | 第二父（dependabot） |
|---|---|---|---|---|---|---|
| kore-plugin-waf | v0.5.3 | Good "git" signature (ED25519 SHA256:rmD48/...), exit=0 | ✅ `861b8de603db8fb3b66f7844c6325b5de8749fb3` | ✅ 861b8de | `9646db9` [agent:a3-wave1] 改写文案 bump v0.5.3（含 validate.go/info/manifest/CHANGELOG） | `4614b6c` bump actions/setup-go 5→7 (#3) [dependabot[bot]]（仅 ci.yml） |
| kore-plugin-firewall | v0.3.2 | Good, exit=0 | ✅ `3c2ccd1fbdb5d7237a138382e9c329a3549061b7` | ✅ 3c2ccd1 | `2b4dcd9` [agent:a3-wave1] 改写文案 bump v0.3.2（含 validate.go） | `b79ad8c` bump setup-go 5→7 (#3)（仅 ci.yml） |
| kore-plugin-app-deploy | v0.4.2 | Good, exit=0 | ✅ `3ed5d9e615eab3e267d4786e86e7bedf777dcd9a` | ✅ 3ed5d9e | `fb2fed7` [agent:a3-wave1] 改写文案 bump v0.4.2（含 validate.go） | `45896a1` bump checkout 4→7 (#3)（仅 ci.yml） |
| kore-plugin-runtime-node | v0.3.2 | Good, exit=0 | ✅ `df5966d0e7c1a421cca924e0da551e534ab29066` | ✅ df5966d | `7825fd4` bump v0.3.2；其父 `ee26cb1` fix(nodeop) 改写 8 条 invalid 文案（A3 §2） | `298d9fb` bump checkout 4→7 (#3)（仅 ci.yml） |
| kore-plugin-runtime-php | v0.3.2 | Good, exit=0 | ✅ `9c9d677764f48e2985d4981cdc6970f627a4256d` | ✅ 9c9d677 | `5fde352` bump v0.3.2；其父 `f5cd230` fix(phpop) 改写 8 条文案（A3 §2） | `5de6601` bump checkout 4→7 (#3)（仅 ci.yml） |
| kore-plugin-runtime-python | v0.4.2 | Good, exit=0 | ✅ `fc5ce6596373ee4f05a770bd5e8bc0e9b2c0199c` | ✅ fc5ce65 | `3107ba5` bump v0.4.2；其父 `5572158` fix(pyop) 改写 8 条文案（A3 §2） | `ad28fa8` bump upload-artifact 4→7 (#3)（仅 ci.yml） |
| kore-plugin-db-postgres | v0.4.2 | Good, exit=0 | ✅ `d4baf3109a171daa905cbb444166fb1636f4f2ae` | ✅ d4baf31 | `c104665` [agent:a3-wave3] 清理 28 条 invalid 文案 bump v0.4.2（含 pgop 多个 .go） | `22caea8` bump upload-artifact 4→7 (#3)（仅 ci.yml） |

7 仓 merge message 均为 `[agent:a3-push-a/b] merge: github dependabot actions v7`；均为双父 merge commit；A3 打包提交（含文案改写 / bump）为**第一父**，dependabot ci.yml bump 为第二父。历史 tag 未动（未列全，删/重建仅本轮新 tag，由实现者报告；此处只读复核当前新 tag 状态）。

---

## 核验③ 推送前置：fetch 三端 main → is-ancestor 全 exit=0 + 三端无本轮新 tag

`GIT_SSH_COMMAND='ssh -F ~/.ssh/config -o ControlMaster=no -o ControlPath=none'`；每仓 `git fetch <remote> main`（github/origin/gitee，7 仓 ×3 = 21 次全部 exit=0）。fetch 后 `git merge-base --is-ancestor <remote>/main HEAD`：

| 仓库 | github/main → HEAD | origin/main → HEAD | gitee/main → HEAD | 远端领先计数（应 0） | 本轮 tag 三端存在性 |
|---|---|---|---|---|---|
| kore-plugin-waf | exit=0 (4614b6c) | exit=0 (7601a21) | exit=0 (7601a21) | 0/0/0 | github/origin/gitee 全 ABSENT |
| kore-plugin-firewall | exit=0 (b79ad8c) | exit=0 (2550249) | exit=0 (2550249) | 0/0/0 | 全 ABSENT |
| kore-plugin-app-deploy | exit=0 (45896a1) | exit=0 (7a22da6) | exit=0 (7a22da6) | 0/0/0 | 全 ABSENT |
| kore-plugin-runtime-node | exit=0 (298d9fb) | exit=0 (147607a) | exit=0 (147607a) | 0/0/0 | 全 ABSENT |
| kore-plugin-runtime-php | exit=0 (5de6601) | exit=0 (a9d7dd6) | exit=0 (a9d7dd6) | 0/0/0 | 全 ABSENT |
| kore-plugin-runtime-python | exit=0 (ad28fa8) | exit=0 (6c4eae5) | exit=0 (6c4eae5) | 0/0/0 | 全 ABSENT |
| kore-plugin-db-postgres | exit=0 (22caea8) | exit=0 (291acfe) | exit=0 (291acfe) | 0/0/0 | 全 ABSENT |

说明：github/main 指向 dependabot 提交（merge 第二父），origin/gitee/main 指向更早的公共基线——二者均为本地 HEAD 的祖先，分叉已消除，`git push` 为纯 FF。`git ls-remote --tags <remote> refs/tags/<tag>` 三端 × 7 仓全部返回空 → 本轮新 tag 远端不存在（不会撞 tag）。

---

## 核验④ 索引仓 kore-plugins 状态 + 门禁

- `git -C kore-plugins rev-parse HEAD` = `b007a1684977a3e6ad70fd4f2e3658aedd3ed9ec`，`git log -1 --format=%s` = `[agent:a3-index] chore(index): 同步 A3 七仓新版本（sha/size 实测）+ 账本/预设/market 重签` → 仍为 `b007a16`，未被合并阶段改动。✅
- `bash scripts/validate-index.sh` → exit=0：`[OK] schema / 24 条` / `[OK] 版本单调递增 / 同 id@version 唯一 sha` / `[OK] 预设引用 47 条` / `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` / `[OK] ed25519 签名验证通过` / `[OK] 索引校验全部通过`。✅
- `bash scripts/build-market.sh --check` → exit=0：`[OK] market/plugins.js 与索引逐字节一致（24 个插件）`。✅（已确认 `--check` 为只读比对，不写文件；validate-index 仅用 trap 清理的临时 `.validate-pub.der`）
- 索引仓 worktree 仅主树；branch=main；status 仅 `?? .tmp-validate-out.txt`、`?? dist/`（task-102 既有 dirty，原样保留未动）。

---

## 核验⑤ git 纪律

- **worktree 仅主树**：7 仓 `git worktree list` 均仅 1 条主树路径 `[main]`；无附加 worktree。索引仓同。✅
- **当前分支**：7 仓均 `main`；索引仓 `main`。✅
- **他人 dirty 原样**：7 仓 `git status --porcelain` 仅有既有未跟踪测试文件（waf `?? internal/wafop/zeroparam_test.go`、app-deploy `?? zero_param_test.go`、node/php/python 各 `internal/*/zeroparam_test.go`、db-postgres `?? zeroparam_test.go`；firewall 干净）——与 recon/波次基线一致，本轮核验及合并阶段未碰。索引仓 `.tmp-validate-out.txt` / `dist/` 原样。✅
- **未 push（远端 main ref 未变）**：fetch 后每仓 `<remote>/main != 本地 main HEAD`（本地领先 2 个 merge+dependabot 提交）；三端本轮 tag ABSENT → 推送尚未发生。✅
- **develop ff**：7 仓 `develop == main`（均快进到新 merge HEAD）。✅

---

## 总评

| 核验项 | 结果 |
|---|---|
| ① dist 位级一致性（7 仓 sha/字节/URL vs 索引） | PASS（7/7，ALL_OK=True） |
| ② tag Good 签名 + peeled==HEAD==merge + A3 第一父 | PASS（7/7） |
| ③ 三端 fetch + is-ancestor exit=0 + 新 tag 三端 ABSENT | PASS（7/7 × 3 端） |
| ④ 索引仓 HEAD b007a16 + 两门禁 exit=0 | PASS |
| ⑤ worktree 仅主树 + 他人 dirty 原样 + 未 push | PASS |

**索引是否需要改动：不需要。** dependabot 仅触 `.github/workflows/ci.yml`（不进 dist 归档），重打 dist 后 7 仓 tar.gz 的 sha256/字节与 `b007a16` 索引记录逐字节一致，`validate-index.sh` / `build-market.sh --check` 全绿，索引无需重新同步或重签。

**是否可放行推送：可以。** 7 仓均为双父 merge commit（A3 打包第一父 + dependabot 第二父），新 tag 签名有效且 peeled 指向 merge HEAD，三端 main 均为本地祖先（纯 FF，分叉已消除），三端无本轮 tag（不撞）。放行后按 task-104/105 执行一批推送（origin→github→gitee）+ task-107 建 Release；本 verifier 不执行任何推送。

（报告结束）
