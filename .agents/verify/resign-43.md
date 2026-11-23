# 第 43 次重签证据（7 条入索引，长期密钥免 build / 免重启）

- 日期：2026-11-23（task-135，owner kore-rel-logs）
- 密钥：ADR-0025 长期密钥；**未执行 `make build`、未重启 kored**
- 索引仓提交：`28fcc70`（`chore(index): 第 43 次重签——7 条版本入索引`），三端已推（origin=gitea / github / gitee 回读均 `28fcc706`）

## 1. 七条资产复核（逐条 curl -L，HTTP 200 + sha256 + 实测 size 逐字一致，BAD_COUNT=0）

| 插件 | 旧 → 新版本 | sha256 | 实测 size |
| --- | --- | --- | --- |
| app-deploy | 0.2.2 → 0.3.0 | `f3fdb914f01a7dfb074af8c460e39b86d485cf25b1ce212c9c825fedf627ea6a` | 1687728 |
| ssl | 0.5.1 → 0.6.0 | `832a06ebcb56b95aa35e93a1a5a91a19677e7d1698c053938ed838b7931f5f1f` | 3168154 |
| cron | 0.4.0 → 0.5.0 | `25a7f55886cf2b68de2680d7cc3fcc4500c7e16e0ebecad681f26529c90b2bc0` | 1559454 |
| integrity | 0.3.3 → 0.4.0 | `4358320e002acc742d4fa71b9660b438c3810b64b1c3dbf376bf4343794c2e19` | 1468268 |
| logs | 0.4.2 → 0.5.0 | `d34bf34dba289eed2afc9c719e53396bf702066d28a3aec213bab49fbf7eb2ac` | 1588633 |
| dns | 0.3.2 → 0.4.0 | `4010651b6e92190e7b7daf35a3792210ea764a62ee490922d3902b27fb31c478` | **1652080（实测）** |
| redis | 0.5.1 → 0.6.0 | `3088ef0ee71808c4efbabf569006e814ecce9a22175bd13d1819ea5abb3b01fc` | 1520442 |

**dns 1 字节偏差说明**：插件仓 `info.json` 声明 `size_bytes=1652081`，release 资产实测 **1652080**（`make dist` 的 `size_bytes` 收敛允许 ±2 字节）；索引是下载校验的权威，按实测 **1652080** 登记。未改插件仓、未改索引里其它字段。

## 2. 索引 / 账本 / 预设

- `index/plugins.json`：7 条 version / sha256 / size_bytes / download_url 更新
- `index/versions.lock.json`：7 个 id 追加 `{version, sha256}`
- `presets/*.json`：6 个预设文件的 pin 版本同步（db-only / full / gateway / security / web-lite / web-pro）
- `bash scripts/sign-index.sh`（长期密钥，不带 `--generate`）：exit 0，签名写回 `index/plugins.json.sig`

## 3. 公钥单一真源（未变）

```text
verify.go IndexPublicKeyHex        = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
validate-index.sh PUB_HEX          = 3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0
kore `make check` 第 14 段         = [OK] 两端公钥一致，make check exit 0（25 pass / 0 warn / 0 fail）
```

`internal/core/market/verify.go` **未改动**（`git status --short` 无输出）。

## 4. 校验正反例与资产

```text
validate-index.sh（原仓）        exit 0
validate-index.sh（篡改副本 +空格）exit 1
validate-index.sh（原仓复验）     exit 0
24 条 release 资产 curl         TOTAL 24 / BAD_COUNT 0
```

## 5. 运行时验收（pid / 商店）

```text
pid_before = 608004
pid_after  = 608004        # 相同 → 未重启 kored
store_before = 未验证（GET /api/v1/store/plugins 返回 401，本会话无登录会话，不编造版本）
store_after  = 未验证（同样 401）
```

## 6. 结论

- 第 43 把重签完成：7 条版本入索引 + 账本 + 预设，签名与验签通过，公钥未变
- **本把未执行 `make build`、未重启 kored**（pid 前后同为 608004），符合长期密钥 SOP
- 未动 `kore/internal/core/market/verify.go`；商店版本变新因无会话未取得，如实标「未验证」
