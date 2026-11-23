[agent:kore-verify-privilege]

# 重签免重启：验收判据解耦（静态公钥常量 + 运行镜像 sha）

- 日期：2026-11-23 20:55+08:00 · 执行：kore-verify-privilege · 任务：task-160
- 本文件不改代码、不重启 kored、不做重签；只把判据从「pid 前后相同」换成不受并发影响的证据。
- **结论（本文件核心）**：第 42 把已验证过一次（当时无并发）；此后**重签是否重启不再作为验收指标**，改用「公钥常量不变 + 运行镜像 sha 不变」作为判据。

## 1. 静态证明（最硬）

```text
$ grep -n 'IndexPublicKeyHex' internal/core/market/verify.go
16:const IndexPublicKeyHex = "3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"
42:	pub, err := hex.DecodeString(IndexPublicKeyHex)

$ git log --oneline -S "3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0" -- internal/core/market/verify.go
3a424c0 chore(market): 第四十一次重签（长期密钥首签）+ 10 条入索引证据；RUNBOOK 改为「重签不重启、仅公钥变更才重启」

$ git log --oneline 3a424c0..HEAD -- internal/core/market/verify.go
（空）
```

**公钥常量自 `3a424c0`（第 41 把播种长期密钥）以来零变更**；该文件的近期提交全部是历次重签同步动作（9d031a7 / 3a98a8f / 7a249eb / 9700adb …），之后没有新的改动。

## 2. 动态证明（可重复，不依赖窗口内无并发）

```bash
# 基线
pid_before        = 1610096
running_exe_sha_a = 0650c9382983cf96ff74968a70de5389741ac957c2dcf05ee76ace5ad5515175   # /proc/1610096/exe

# /tmp 副本用同一长期密钥再签（不动真索引）
$ cp -a kore-plugins /tmp/kp-rf && cd /tmp/kp-rf
sig_before = 2c35747f74157f5334b1523920df6ecab3ff64f75acdd15994f1b1a2054ef5af
$ bash scripts/sign-index.sh
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）
sig_after  = 2c35747f74157f5334b1523920df6ecab3ff64f75acdd15994f1b1a2054ef5af   # Ed25519 确定性签名，逐字相同
$ bash scripts/validate-index.sh; echo $?
[OK] ed25519 签名验证通过（内置公钥）… exit=0

# 事后
pid_after         = 1610096   （相同）
running_exe_sha_b = 0650c9382983cf96ff74968a70de5389741ac957c2dcf05ee76ace5ad5515175   （相同）
bin/kored 文件 sha = 63dbb3e8…（**观测到窗口内被另一会话重建**，见下）
```

### 关键论证
验证方读取的是**编进二进制的不变常量** `IndexPublicKeyHex`；重签只改 `index/plugins.json` 正文与 `.sig`。因此：

```text
公钥常量未变 ⇒ 二进制语义未变 ⇒ 无需 make build；进程内存未变 ⇒ 无需重启。
```

### 本条观测到的「判据脆弱」实证（同时修正判据）
在本次 2 分钟窗口内，`bin/kored` 文件 sha 从 `0650c938…` 变成 `63dbb3e8…`（另一会话 `make build`），而 pid 与 `/proc/<pid>/exe` 均未变。**说明「磁盘上的 bin sha」也不能当判据**——共享工作区里任何人 build 一次就变。最终判据应为：

```text
① 静态：git log -S "<公钥>" -- internal/core/market/verify.go 为空（自 3a424c0 起）
② 运行态：pid 不变 + /proc/<pid>/exe 的 sha256 不变（运行镜像，不随磁盘重建变化）
③ 索引：validate-index.sh exit 0
```

## 3. 反例：什么情况才真的需要重建 + 重启

只有 `verify.go` 的 `IndexPublicKeyHex` **值发生变化**（换钥，ADR-0025 二期 B）时：旧进程内存里是旧常量，新签名必然验不过 → 必须 `make build` + 重启 kored。

运维执行重签前自查（两条都通过才可跳重启）：

```bash
PUB=$(grep -oE '[0-9a-f]{64}' internal/core/market/verify.go | head -1)
test -z "$(git log --oneline -S "$PUB" -- internal/core/market/verify.go | tail -n +2 | head -1)" && echo "公钥自播种未变：可免 build/重启"
make check 2>&1 | grep -q '公钥单一真源' && echo "第 14 段通过（verify.go 与 validate-index.sh PUB_HEX 一致）"
```

## 4. 判据替换（正式口径）

> **第 42 把已验证过一次（当时无并发）；此后重签是否重启不再作为验收指标，改用「公钥常量不变 + 运行镜像 sha 不变」作为判据。**

## 5. 附带核对：resign-42/43/44 的 pid 表述（只报告，未改文件）

| 文件 | pid 表述 | 一致性判断 |
|---|---|---|
| `resign-42.md` | `pid_before=608004` / `pid_after=608004`（第 4 节） | 一致 ✅；当时确无并发 |
| `resign-43.md` | `pid_before=608004` / `pid_after=608004`（第 5 节 + 结论行） | 一致 ✅ |
| `resign-44.md` | 第 45–46 行 `pid_before=608004` / `pid_after=1589715`；第 49–52 行**已有更正段**承认初版 `pid_after=608004` 是「凭签名前取值预写，属错误陈述」，并归因另一会话 build+重启 | **存在预写失真，但已在同文件内自我更正** ⚠️；结论行仍写「pid 前后同为 608004」，与第 46 行矛盾，建议后续统一措辞（本任务不改） |

补充：第 44 把的 pid 断言被污染（608004 → 1589715 → 1610096）正是本任务存在的理由；本文件把该指标退役，不再要求后续重签证书里出现 pid 前后比较。
