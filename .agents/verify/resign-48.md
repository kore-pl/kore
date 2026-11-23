[agent:resign-48]

# 第 48 把重签证据（app-deploy 0.3.1 / terminal 0.2.1）

- 日期：2026-11-24 00:2x+08:00 · 执行：resign-48 · 范围：索引仓 `kore-plugins`（重签）+ 本证据文件
- 判据：[resign-restart-free.md](./resign-restart-free.md) —— 「公钥常量不变 + 运行镜像 sha 不变」，**不使用 pid 判据**。

> **本把未执行 `make build`、未重启 `kored`。** 长期签名密钥（ADR-0025 方案 A）已就位
> （`~/.config/kore/signing/index-signing.seed`，0600），`IndexPublicKeyHex` 未变，
> 因此二进制语义未变、运行进程内存未变；`bin/kored` 的 sha 与 mtime 前后亦未变。

## 1. release 资产复核（逐字比对，全部 200）

`release-batch8` 由上游发布，本把独立复核（未采信发布单声明值）：

| 插件 | 版本 | HTTP | size（实测） | sha256 |
| --- | --- | --- | --- | --- |
| app-deploy | 0.3.1 | 200 | 1687721 | `2fa0e99e667c04d8e396c30140e93bb1d95792f87febff27909174315cfd3cbf` |
| terminal | 0.2.1 | 200 | 1522791 | `146a62bb92a13d4d14c0dd3b04a67e2f088a151cbb448d8db9b868f30115de88` |

- 与派发单声明值（sha256 + size）**逐字一致，无偏差**。
- 本地 `kore-plugin-{app-deploy,terminal}/dist/` 同版本产物 sha/size 与远端资产**逐字一致**
  （`2fa0e99e…` / 1687721、`146a62bb…` / 1522791）→ 「三端回读」在 GitHub 资产与本地产物两端成立。
- Gitee 镜像独立落盘复核：两条 URL 均 **HTTP 200**，sha/size 与上表逐字一致。
- Gitea（`gitea.iouf.cn`）为源码镜像：两插件 `GET /api/v1/repos/kore-pl/<repo>/releases`
  返回 `[]`（该端不发布 release 资产，与「Gitea 侧不配 CI」口径一致），故无资产可复核；不构成本把阻塞。
- 包内 `info.json.size_bytes`：app-deploy 声明 1687722 / 实测 1687721（差 +1），
  terminal 声明 1522790 / 实测 1522791（差 −1），均在已知 ±2 自指窗口内；
  **索引 `size_bytes` 一律记实测值**。

## 2. 索引旧版本号（以 `index/plugins.json` 实际值为准）

| 插件 | 索引旧值 | 新值 | 备注 |
| --- | --- | --- | --- |
| app-deploy | 0.3.0 | 0.3.1 | 连续递增（0.3.0 仍在 lock 历史） |
| terminal | 0.2.0 | 0.2.1 | 连续递增（0.2.0 仍在 lock 历史） |

派发单未给旧版本号，无「卡上值与实际值不符」；`versions.lock.json` 仅追加 2 条
（app-deploy 0.3.1、terminal 0.2.1），历史未删、未改。

### preset pin 同步

| 文件 | 同步项 |
| --- | --- |
| `presets/full.json` | `app-deploy` 0.3.0 → 0.3.1（唯一引用点） |

其余 7 个预设未引用 app-deploy / terminal（`grep -rn 'terminal' presets/` 零命中），未改。

## 3. 公钥常量（签名前后逐字相同）

```text
$ grep -oE '^PUB_HEX="[0-9a-f]{64}"' ../kore-plugins/scripts/validate-index.sh
PUB_HEX="3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 签名前
PUB_HEX="3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 签名后

$ grep -oE 'IndexPublicKeyHex = "[0-9a-f]{64}"' internal/core/market/verify.go
IndexPublicKeyHex = "3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 前后相同
```

两处同源一致（`make check` 第 16/17 段公钥单一真源 exit 0）。

## 4. 运行镜像 sha（签名前后逐字相同，未重启）

`/proc/<pid>/exe` sha256 对 8787 主实例取样（判据是镜像，不是 pid）：

| pid | 用途 | 签名前 | 签名后 |
| --- | --- | --- | --- |
| 1387457 | 主实例（`bin/kored serve --config .kore-local.yaml`） | 979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997 | 979260261c0aac5ef4e14e08f1968f89079609a4aa383a69bbded70ad2aa6997 |

`bin/kored` 磁盘文件 sha 前后同为 `97926026…6997`、mtime 仍为 `2026-11-23 23:21:52`（未重建）。

## 5. 重签与验签

```text
$ cd kore-plugins && bash scripts/sign-index.sh        # 长期密钥，未带 --generate
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）：index/plugins.json → index/plugins.json.sig
sign_exit=0
```

| 文件 | 签名前 sha256 | 签名后 sha256 |
| --- | --- | --- |
| `index/plugins.json` | `013ec012395b0a5457de4bbade5a1c214ee053781d292316894a92776333c738` | `81a2120c9f7a8a0f31cbc8ec9bcec81a453af89a1392f3a1e53c57c6d95f4438` |
| `index/plugins.json.sig` | `c8fc66858d5951f2f31ed5b760157e6bfc4ef2df0344c6ee6e2092fb579e5f1b` | `ccf2ad284ad4d3ad5a6720fb1238f04103a6ca32f9a9ea9e1f60836756779d0a` |

`validate-index.sh` 正反例（副本在 `/tmp`，验证后已删除）：

| 用例 | 命令 | 结果 |
| --- | --- | --- |
| 原仓正向 | `bash scripts/validate-index.sh` | **exit 0**，`[OK] ed25519 签名验证通过（内置公钥）` |
| `/tmp` 未篡改副本（对照） | 复制 index/presets/scripts 后直接验签 | exit 0（证明副本结构本身可过） |
| `/tmp` 篡改副本 | `app-deploy.size_bytes += 1` 后验签 | **exit 1**，`[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）` |
| 原仓复验 | 删除副本后重跑 | **exit 0**，`[OK] 索引校验全部通过` |

## 6. 全量资产复核（24 条）

按 `index/plugins.json` 逐条 `curl -sSL` 下载并比对 `sha256` + `size_bytes`（实测值）：

```text
ENTRIES_CHECKED=24
BAD_COUNT=0
```

（逐条打印 `[OK ] <id>@<ver> http=200 size=… sha=…`，无 `[BAD]` 行；下载暂存 ~41 MiB 已清理。）

## 7. 门禁

```text
$ cd kore-plugins && bash scripts/validate-index.sh
[OK] schema / 必填字段 / id 唯一 / sha256 格式通过（24 条）
[OK] 版本单调递增 / 同 id@version 唯一 sha 校验通过（基线 24 条）
[OK] 预设引用可解析（占位/已校验 47 条引用）
[OK] ed25519 签名验证通过（内置公钥）
validate_exit=0

$ cd kore && make check
...
[RUN ] 17/17 交叉编译（G-16 阻断级：五目标真编译…）
[OK] 交叉编译五目标全通过（exit 0，耗时 2077ms）
[OK] 门禁全部通过
make_check_exit=0
```

- 段数说明：派发单写「全 16 段」，当前 `Makefile` 实际为 **17 段**（本轮由并行任务新增第 17 段
  「交叉编译 / G-16 阻断级」）；**17/17 全绿、0 FAIL**，编号差异不影响结论。
- 第 15 段 `presets-check`：`8 pass, 8 warn, 0 fail`（8 warn = `scripts/depth-level-pending.txt`
  登记的存量待裁决）；历史 `db-only` G-20 FAIL 已由 `69b98ea` 修复，本把无该 FAIL。
- 第 1 段 docs-check 报 3 份文档行数越界、第 9 段 case-check 报 3 个 URL owner 大写，
  均为 WARN 级存量、与本把无关；无阻断级失败。

## 8. 变更清单

- `kore-plugins`（精确路径，未 push）：`index/plugins.json`、`index/plugins.json.sig`、
  `index/versions.lock.json`、`presets/full.json`。
- `kore`（精确路径，仅本文件，未 push）：`.agents/verify/resign-48.md`。
- 未触碰：插件源码 / `cmd/**` / `internal/**` / `Makefile` / `web/**`；未触碰他人在这两个仓库的
  在途改动；**未改动主实例运行态配置**（`.kore-local.yaml` 的 `index_dir` 仍指向 `kore-plugins/index`）。

## 9. 未验证项 / 已知偏差

- 商店 API 版本回读（`GET /api/v1/store/plugins`）需管理登录，本轮未取证「商店显示新版本」；
  且按任务口径**不重启 `kored`**，运行中进程对磁盘索引的生效时机未验证（索引文件已签好，
  下次正常 reload / 重启即读新值）。
- 索引快照里 3 条历史条目带**非 schema 字段** `capabilities`（`terminal`、`process`、`discover`）：
  `terminal` 条目写 `["system:admin","proc:write"]`，而 0.2.1 包内 `info.json` 声明
  `["system:read","system:admin","proc:write"]`（0.2.0 起即如此）。该字段不属 kore `market.Plugin`
  12 字段 schema，解析端 lenient 忽略（kore-plugins README §「非 schema 字段 capabilities」明确
  「不得为此改 `index/plugins.json`」），故本把**未改**，留待专门清理卡统一处理；不影响安装/权限判定。
- G-15 跨仓变更集未登记到 `.agents/BOARD.md`：任务卡限定「只改索引仓 + kore 仓一处证据文件」，
  由 lead 决定是否补录。
