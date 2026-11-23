[agent:resign-46b]

# 第 46 把重签证据（waf 0.4.3 / container 0.5.2 / discover 0.3.1 / backup 0.4.2）

- 日期：2026-11-23 21:35+08:00 · 执行：resign-46b · 范围：索引仓 `kore-plugins`（重签）+ 本证据文件
- 判据：[resign-restart-free.md](./resign-restart-free.md) —— 「公钥常量不变 + 运行镜像 sha 不变」，**不使用 pid 判据**（并发重启会污染）。

> **本把未执行 `make build`、未重启 kored。** 长期密钥（ADR-0025 方案 A）已就位，`IndexPublicKeyHex` 未变，因此二进制语义未变、运行进程内存未变。

## 1. release 资产复核（4 条，逐字比对）

`curl -sL -o <file> -w '%{http_code}' <download_url>` + `sha256sum` + `stat -c %s`：

| 插件 | 版本 | HTTP | size（实测） | sha256 |
| --- | --- | --- | --- | --- |
| waf | 0.4.3 | 200 | 2933388 | b9ac6ff17ba1498dbfdff8b2936e7f3dd31bf7d02e8e9368b18f62e79e552506 |
| container | 0.5.2 | 200 | 1529718 | 975820ebfba94ee937b8bee304a81ea0866e88f4b7e1d4792cbcefcc77a578b6 |
| discover | 0.3.1 | 200 | 1533965 | 972d932b08797e7f96bf8e54ad49631e9151e9818f47c6bf48a4fe46502df165 |
| backup | 0.4.2 | 200 | 1709550 | 069edac82787a57e9d58ff2bb4846a7c013f52e29074cbffa7aabd0831da8d36 |

四条均与派发单声明值（sha256 + size）逐字一致，无偏差。

### 索引旧版本号以实际值为准（1 处差异）

派发单写作 `waf 0.4.2 → 0.4.3`，索引仓 `index/plugins.json` 实际为 **0.4.1**（`index/versions.lock.json` 的 waf 历史为 0.1.0 / 0.1.1 / 0.2.0 / 0.3.0 / 0.3.1 / 0.4.1，**0.4.2 从未入索引**）。按「以实际值为准」，本把为 **waf 0.4.1 → 0.4.3**。其余三条（container 0.5.1 / discover 0.3.0 / backup 0.4.1）与派发单一致。

索引变更（旧 → 新）：

| 插件 | version | sha256 | size_bytes（实测，自指口径） |
| --- | --- | --- | --- |
| waf | 0.4.1 → 0.4.3 | 201635ab… → b9ac6ff1… | 2934045 → 2933388 |
| container | 0.5.1 → 0.5.2 | 8d1b586b… → 975820eb… | 1527626 → 1529718 |
| discover | 0.3.0 → 0.3.1 | 6dda2621… → 972d932b… | 1532092 → 1533965 |
| backup | 0.4.1 → 0.4.2 | 44134a94… → 069edac8… | 1706102 → 1709550 |

`versions.lock.json` 追加 4 条；presets pin 同步 5 处（`full.json` 的 waf/container/backup、`security.json` 的 waf、`db-only.json` 的 backup）；discover 无预设引用，未改。

## 2. 公钥常量（签名前后）

```text
$ grep -oE '[0-9a-f]{64}' internal/core/market/verify.go | head -1
3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0   # 签名前
3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0   # 签名后（逐字相同）

$ sed -n 31p ../kore-plugins/scripts/validate-index.sh
PUB_HEX="3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"
```

## 3. 运行镜像 sha（签名前后逐字相同，未重启）

`pgrep -f "kored serve"` 命中 4 个实例（主实例 2544741 + 3 个隔离实例），签名前后 `/proc/<pid>/exe` 全部未变：

| pid | 用途 | 签名前 | 签名后 |
| --- | --- | --- | --- |
| 2544741 | 主实例（仓库内 config） | ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b | 同左 |
| 2520580 | 隔离 /tmp/kore-t196 | ee34692be5a789a124fea6b5ddb5afadb485089b598a265c191d1f79335b1e2b | 同左 |
| 2548624 | 隔离 /tmp/kore-cexec | 7171dbad3af129a5c65b0db2c1955f63efd6372be9f8ca231f2433dcd1de575f | 同左 |
| 2567633 | 隔离 /tmp/kore-adep2 | f0e8d04412eb9f753f31a0fd13fde936362e071e0cb5740be37e36da37ed2504 | 同左 |

## 4. 重签与验签

```text
$ bash kore-plugins/scripts/sign-index.sh            # 长期密钥，不带 --generate
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）：index/plugins.json → index/plugins.json.sig
sign_exit=0

$ bash kore-plugins/scripts/validate-index.sh
[OK] schema / 必填字段 / id 唯一 / sha256 格式通过（24 条）
[OK] 版本单调递增 / 同 id@version 唯一 sha 校验通过（基线 24 条）
[OK] 预设引用可解析（占位/已校验 47 条引用）
[OK] ed25519 签名验证通过（内置公钥）
[OK] 索引校验全部通过
validate_exit=0
```

正反例（篡改副本在 `/tmp/t46`，验证后已删除）：

| 用例 | 命令 | 结果 |
| --- | --- | --- |
| 原仓正向 | `bash scripts/validate-index.sh` | exit 0 |
| 篡改反例 | `cp -a kore-plugins /tmp/t46 && printf ' ' >> /tmp/t46/index/plugins.json && bash scripts/validate-index.sh` | **exit 1**，`[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）` |
| 原仓复验 | `bash scripts/validate-index.sh`（篡改副本删除后） | exit 0 |

## 5. 全量资产复核（24 条）

按 `index/plugins.json` 逐条 `curl -L` 下载并比对 sha256 + size_bytes：

```text
BAD_COUNT=0 OK_COUNT=24 TOTAL=24
```

## 6. 门禁

```text
$ make check            # kore 仓库
[RUN ] 14/14 公钥单一真源（ADR-0025：verify.go IndexPublicKeyHex ↔ 索引仓 validate-index.sh PUB_HEX）
[OK] 两端公钥一致：internal/core/market/verify.go:16:3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
[OK] 索引仓验签脚本：../kore-plugins/scripts/validate-index.sh:31:3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
[OK] 门禁全部通过
make check exit=0（14/14 段全绿）
```

## 7. 变更清单

- `kore-plugins`：`index/plugins.json`、`index/plugins.json.sig`、`index/versions.lock.json`、`presets/full.json`、`presets/security.json`、`presets/db-only.json`（精确 add）。
- `kore`：仅本文件 `.agents/verify/resign-46.md`。
- 未触碰：`AGENTS.md` / `docs/DECISIONS/0027-*` / `docs/FRONTEND.md` / `Makefile` / `web/**` / `cmd/**`；未改动主实例运行态配置。

## 8. 未验证项

- 主实例商店页（`GET /api/v1/store/plugins`）返回版本核对：需用户登录管理 API，本轮未执行，属正常未验证项。
