[agent:resign-47]

# 第 47 把重签证据（ssh-guard 0.3.1 / container 0.5.4 / waf 0.4.4 / logs 0.5.1）

- 日期：2026-11-23 22:24+08:00 · 执行：resign-47 · 范围：索引仓 `kore-plugins`（重签）+ 本证据文件
- 判据：[resign-restart-free.md](./resign-restart-free.md) —— 「公钥常量不变 + 运行镜像 sha 不变」，**不使用 pid 判据**。

> **本把未执行 `make build`、未重启 `kored`。** 长期签名密钥（ADR-0025 方案 A）已就位，
> `IndexPublicKeyHex` 未变，因此二进制语义未变、运行进程内存未变。

## 1. release 资产复核（4 条，逐字比对）

`curl -sSL -o <file> -w '%{http_code}' <download_url>` + `sha256sum` + `stat -c %s`：

| 插件 | 版本 | HTTP | size（实测） | sha256 |
| --- | --- | --- | --- | --- |
| ssh-guard | 0.3.1 | 200 | 2840537 | `260af4b5b0cc305ae296b605dbb6e5920449fdcf8951375cb00892c0947d9b3f` |
| container | 0.5.4 | 200 | 1530283 | `940d220b6ebbc5b9e516d615eaa2b2ab91ddaa6cf8f76c3007e5a8f3ae539ddc` |
| waf | 0.4.4 | 200 | 2938643 | `9db925059bd1fac3982c4e3a115ce646c4097c4f779d8f0e573a58e1fe3cc405` |
| logs | 0.5.1 | 200 | 1590704 | `17743259b146f87cc68d7fd43f10e78771b01de4bba494148fc03242a9f2cd07` |

四条均与派发单声明值（sha256 + size）**逐字一致，无偏差**。`size_bytes` 一律记实测值。

### 索引旧版本号（以 `index/plugins.json` 实际值为准）

| 插件 | 索引旧值 | 新值 | 备注 |
| --- | --- | --- | --- |
| ssh-guard | 0.3.0 | 0.3.1 | 连续递增 |
| container | 0.5.2 | 0.5.4 | **跳版**：0.5.3 从未入索引（lock 历史尾部 0.5.1 / 0.5.2），属允许的版本跳号，非冲突 |
| waf | 0.4.3 | 0.4.4 | 连续递增 |
| logs | 0.5.0 | 0.5.1 | 连续递增 |

派发单未给出旧版本号，故无「卡上值与实际值不符」的差异；仅 container 跳版需说明（上表）。
`versions.lock.json` 追加 4 条（0.3.1 / 0.5.4 / 0.4.4 / 0.5.1）。

### preset pin 同步（精确版本比对，必须同步）

| 文件 | 同步项 |
| --- | --- |
| `presets/full.json` | ssh-guard 0.3.1 / logs 0.5.1 / waf 0.4.4 / container 0.5.4 |
| `presets/security.json` | ssh-guard 0.3.1 / waf 0.4.4 |
| `presets/web-pro.json` | logs 0.5.1 |

其余预设（minimal / web-lite / db-only / gateway / dev）未引用这四个插件，未改。

## 2. 公钥常量（签名前后逐字相同）

```text
$ grep -oE '[0-9a-f]{64}' internal/core/market/verify.go | head -1
3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0   # 签名前
3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0   # 签名后

$ grep -oE '^PUB_HEX="[0-9a-f]{64}"' ../kore-plugins/scripts/validate-index.sh
PUB_HEX="3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"   # 前后相同
```

两处公钥同源一致（`scripts/pubkey-sync-check.sh` exit 0）。

## 3. 运行镜像 sha（签名前后逐字相同，未重启）

`/proc/<pid>/exe` sha256 对 8787 主实例取样：

| pid | 用途 | 签名前 | 签名后 |
| --- | --- | --- | --- |
| 2798902 | 主实例（监听 127.0.0.1:8787，`.kore-local.yaml`） | 984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23 | 984510ab1f4e1cbada062bb2596404c8b23e232377f3a7b23079b958ea4e3e23 |

- `/proc/2798902/exe` → `.../bin/kored (deleted)`（进程启动后磁盘二进制曾被他人替换，不影响判据：判的是运行中 inode 的 sha）。
- 签名前另见一个非 8787 的 `kored` 进程 pid=836102（exe sha `d6ffe2bc…f891`），签名后已不存在；
  **本把未启动、未重启任何 `kored`**，该进程变化非本把操作导致，且不参与判据（判据只取 8787 主实例）。

`/proc/2798902/exe` sha 前后相同 → 签名未改变运行镜像。

## 4. 重签与验签

```text
$ cd kore-plugins && bash scripts/sign-index.sh      # 长期密钥，未带 --generate
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）：index/plugins.json → index/plugins.json.sig
sign_exit=0

index/plugins.json      sha256 = 013ec012395b0a5457de4bbade5a1c214ee053781d292316894a92776333c738
index/plugins.json.sig  sha256 = c8fc66858d5951f2f31ed5b760157e6bfc4ef2df0344c6ee6e2092fb579e5f1b
（sig 旧值 1e6bf6e722ee562754631e577de26288507a812bd1b053c33854d35ae155441f → 新值）
```

`validate-index.sh` 正反例（篡改副本在 `/tmp`，验证后已删除）：

| 用例 | 命令 | 结果 |
| --- | --- | --- |
| 原仓正向 | `bash scripts/validate-index.sh` | **exit 0**，`[OK] ed25519 签名验证通过（内置公钥）` |
| `/tmp` 篡改副本 | 复制 index/presets/scripts 到 `/tmp/resign47.*`，`ssh-guard.size_bytes += 1` 后验签 | **exit 1**，`[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）` |
| 原仓复验 | `bash scripts/validate-index.sh`（篡改副本删除后） | **exit 0** |
| 对照：未篡改 `/tmp` 副本 | 同上但不动内容 | exit 0（证明反例失败只因篡改，非副本结构） |

## 5. 全量资产复核（24 条）

按 `index/plugins.json` 逐条 `curl -L` 下载并比对 sha256 + size_bytes：

```text
ENTRIES_CHECKED=24
BAD_COUNT=0
```

## 6. 门禁

```text
$ bash ../kore-plugins/scripts/validate-presets.sh
[OK] 校验通过：8 个预设 / 24 个索引插件 / 0 FAIL / 0 WARN
presets_exit=0

$ make check            # kore 仓库，全 16 段
[RUN ] 16/16 公钥单一真源（ADR-0025：verify.go IndexPublicKeyHex ↔ 索引仓 validate-index.sh PUB_HEX）
[OK] 两端公钥一致：internal/core/market/verify.go:16:3e461a07…f1c0
[OK] 索引仓验签脚本：../kore-plugins/scripts/validate-index.sh:31:3e461a07…f1c0
[OK] 门禁全部通过
make_check_exit=0（16/16 段全绿）
```

注：派发单写「第 14 段」，现 `Makefile` 已扩到 16 段，公钥单一真源实际为 **16/16 段**（历史证据
`resign-46.md` 里的 14/14 是扩容前编号）。以实际编号为准，该项 exit 0。

## 7. 变更清单

- `kore-plugins`（精确 add，未 push）：`index/plugins.json`、`index/plugins.json.sig`、
  `index/versions.lock.json`、`presets/full.json`、`presets/security.json`、`presets/web-pro.json`。
- `kore`（精确 add，仅本文件，未 push）：`.agents/verify/resign-47.md`。
- 未触碰：源码 / `cmd/**` / `internal/**` / `Makefile` / `web/**` / 其他 agent 的在途改动
  （`internal/core/httpapi/handlers_auth.go`、`server.go`、`csrf_local*` 等保持原样）；
  未改动主实例运行态配置（`.kore-local.yaml` 的 `index_dir` 仍为 `kore-plugins/index`）。

## 8. 未验证项

- 商店 API 版本回读（`GET /api/v1/store/plugins`、`GET /api/v1/system/info`）需管理登录，本轮 **401 未授权**，
  未能取证「商店显示新版本」；已从配置侧确认 `index_dir` 指向本索引，无第三方阻塞。
- G-15 跨仓变更集未登记到 `.agents/BOARD.md`：任务卡限定「只改索引仓与 kore 仓的一处证据文件」，
  故未动 BOARD；如需登记，由 lead 决定补录。
