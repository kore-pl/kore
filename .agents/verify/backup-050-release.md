# backup v0.5.0 发版入索引（发版最后一公里）

> 执行者：`backup-release-050`｜时间：2026-11-24 10:41–10:52（Asia/Shanghai）
> 写域：backup 仓 tag/release + `kore-plugins` 索引/账本/预设/签名/market
> 约束遵守：未 `make build`、未重启 kored、未打印任何 token 明文（token 只经 shell 变量与 `Authorization` 头）

## 0. 结论

- 三端 `main` 与 `v0.5.0` 已推送，**三端 peeled sha 一致 = `efb0989a56b70809768cdc96d0f91d30ee98fa0b`**
- 三端 release 均已建，`backup-0.5.0.tar.gz` + `.sha256` 三端 `curl -L` 全 200，size=1717615、sha=`f76a165a…` 与本地一致
- 索引已收录 `backup@0.5.0`，`versions.lock.json` 已追加，两处 preset pin 已同步 0.5.0，索引已重签，`market/plugins.js` 已重建
- `validate-index.sh` / `validate-presets.sh` 正例 exit 0；两个反例均按预期非 0 并已还原
- **索引 24 条资产全量核对：`TOTAL=24 OK=24 BAD_COUNT=0`**（中途曾出现 `file@0.3.4` 404 —— 属他人轨道、非本卡写域，横向通报 `file-manager-rebuild` 补建后复测转绿；见 §7）
- 公钥未变（`3e461a07…`），**不需重启 kored**；kored 进程启动于 10:28:16（早于本卡开工），本轮未重启

## 1. 核实（改前）

```text
$ jq -r .version ../kore-plugin-backup/info.json   # info.json
0.5.0
$ jq -r .version ../kore-plugin-backup/manifest.json
0.5.0
$ jq -r .size_bytes ../kore-plugin-backup/info.json
1717615

$ git -C ../kore-plugin-backup rev-parse v0.5.0
df80def557e7b8dfbe4c1d5ef550b18dd6ced732        # annotated tag 对象
$ git -C ../kore-plugin-backup cat-file -t v0.5.0
tag
$ git -C ../kore-plugin-backup rev-parse 'v0.5.0^{}'
efb0989a56b70809768cdc96d0f91d30ee98fa0b        # peeled == HEAD
$ git -C ../kore-plugin-backup rev-parse HEAD
efb0989a56b70809768cdc96d0f91d30ee98fa0b

$ sha256sum ../kore-plugin-backup/dist/backup-0.5.0.tar.gz
f76a165a0b5b3684202a1b46e27fbb6a4a4c4669f3b3cbe8d8525b807645c1a9
$ stat -c%s ../kore-plugin-backup/dist/backup-0.5.0.tar.gz
1717615
```

改前远端状态：三端 `main` 均停在 `859c792`，三端 `git ls-remote --tags 'v0.5.0*'` 无输出（未发版）。

## 2. 推 tag + main 到三端（origin → github → gitee）

```text
$ git push origin main v0.5.0
   859c792..efb0989  main -> main
 * [new tag]         v0.5.0 -> v0.5.0          exit=0
$ git push github main v0.5.0
   859c792..efb0989  main -> main
 * [new tag]         v0.5.0 -> v0.5.0          exit=0
$ git push gitee main v0.5.0
   859c792..efb0989  main -> main
 * [new tag]         v0.5.0 -> v0.5.0          exit=0
```

三端回读（`git ls-remote --tags`）：

```text
origin  df80def557e7b8dfbe4c1d5ef550b18dd6ced732  refs/tags/v0.5.0
origin  efb0989a56b70809768cdc96d0f91d30ee98fa0b  refs/tags/v0.5.0^{}
github  df80def557e7b8dfbe4c1d5ef550b18dd6ced732  refs/tags/v0.5.0
github  efb0989a56b70809768cdc96d0f91d30ee98fa0b  refs/tags/v0.5.0^{}
gitee   df80def557e7b8dfbe4c1d5ef550b18dd6ced732  refs/tags/v0.5.0
gitee   efb0989a56b70809768cdc96d0f91d30ee98fa0b  refs/tags/v0.5.0^{}
```

三端 peeled sha 一致，且 == 打 dist 的树（`efb0989`）。

## 3. 三端 release + 资产

| 端 | 创建方式 | 结果 |
| --- | --- | --- |
| Gitea（权威源） | `POST /api/v1/repos/kore-pl/kore-plugin-backup/releases` + `POST .../assets` | release id=56339；两资产 http=201 |
| GitHub（镜像） | `gh release create v0.5.0 … --repo kore-pl/kore-plugin-backup` | https://github.com/kore-pl/kore-plugin-backup/releases/tag/v0.5.0 |
| Gitee（镜像） | `POST /api/v5/repos/pengtang1024/kore-plugin-backup/releases`，**`target_commitish=efb0989a56b70809768cdc96d0f91d30ee98fa0b`（完整 40 位）** | release id=1360835，HTTP 201；两资产 http=201 |

资产回读（三端逐一 `curl -sSL` 下载后比对；本地基准 sha `f76a165a0b5b…`、size 1717615）：

```text
--- https://gitea.iouf.cn/kore-pl/kore-plugin-backup ---
[backup-0.5.0.tar.gz]        http=200 size=1717615 sha=f76a165a0b5b
[backup-0.5.0.tar.gz.sha256] http=200 size=86      sha=740415ac0c3a
--- https://github.com/kore-pl/kore-plugin-backup ---
[backup-0.5.0.tar.gz]        http=200 size=1717615 sha=f76a165a0b5b
[backup-0.5.0.tar.gz.sha256] http=200 size=86      sha=740415ac0c3a
--- https://gitee.com/pengtang1024/kore-plugin-backup ---
[backup-0.5.0.tar.gz]        http=200 size=1717615 sha=f76a165a0b5b
[backup-0.5.0.tar.gz.sha256] http=200 size=86      sha=740415ac0c3a
```

建后 API 回读（三端 release 元数据）：

```text
Gitee : tag=v0.5.0  target_commitish=efb0989a56b70809768cdc96d0f91d30ee98fa0b (len=40)
        assets=[backup-0.5.0.tar.gz, backup-0.5.0.tar.gz.sha256, v0.5.0.zip, v0.5.0.tar.gz(自动源码包)]
Gitea : tag=v0.5.0  assets=[('backup-0.5.0.tar.gz',1717615), ('backup-0.5.0.tar.gz.sha256',86)]
GitHub: tag=v0.5.0  assets=[{backup-0.5.0.tar.gz,1717615}, {backup-0.5.0.tar.gz.sha256,86}]
```

`.sha256` 旁挂资产内容与本地逐字一致（网络下载回读）：

```text
f76a165a0b5b3684202a1b46e27fbb6a4a4c4669f3b3cbe8d8525b807645c1a9  backup-0.5.0.tar.gz
```

## 4. 索引改前 → 改后

`index/plugins.json` 的 backup 条目：

```text
改前: version 0.4.2 / size_bytes 1709550 / sha 069edac82787… /
      download_url .../download/v0.4.2/backup-0.4.2.tar.gz
改后: version 0.5.0 / size_bytes 1717615 / sha f76a165a0b5b3684202a1b46e27fbb6a4a4c4669f3b3cbe8d8525b807645c1a9 /
      download_url https://github.com/kore-pl/kore-plugin-backup/releases/download/v0.5.0/backup-0.5.0.tar.gz
```

`index/versions.lock.json`：backup 数组由 6 条（0.2.0…0.4.2）追加为 7 条，新增：

```json
{ "version": "0.5.0", "sha256": "f76a165a0b5b3684202a1b46e27fbb6a4a4c4669f3b3cbe8d8525b807645c1a9" }
```

`git diff --stat`（提交前）：`index/plugins.json 8 ++++---- / index/plugins.json.sig / index/versions.lock.json 4 ++++ / market/plugins.js / presets/db-only.json / presets/full.json`，共 14 insertions / 9 deletions，**无格式化噪音**。

## 5. preset pin 判断：需要改，已改

`scripts/validate-presets.sh` 对每条引用做**精确版本**比对（`want_ver != str(p["version"])` 即 `err`），与 `desired` 是 enabled 还是 disabled **无关**：

```python
want_ver = str(ref.get("version", ""))
if want_ver != str(p["version"]):
    err(f"{name}.plugins[{i}] 版本 {want_ver} 与索引 {rid}={p['version']} 不一致")
```

所以两处 pin 必须同步：

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| `presets/db-only.json` | backup 0.4.2（desired=enabled） | backup 0.5.0 |
| `presets/full.json` | backup 0.4.2（desired=disabled） | backup 0.5.0 |

## 6. 重签 + 正反例

重签（长期密钥，未生成新钥）：

```text
$ bash scripts/sign-index.sh
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）
     …/kore-plugins/index/plugins.json → …/kore-plugins/index/plugins.json.sig
exit=0
```

正例：

```text
$ bash scripts/validate-index.sh
[INFO] 签名校验：开启（ed25519 全量验签）
[OK] schema / 必填字段 / id 唯一 / sha256 格式通过（24 条）
[OK] 版本单调递增 / 同 id@version 唯一 sha 校验通过（基线 24 条）
[OK] 预设引用可解析（占位/已校验 47 条引用）
[OK] ed25519 签名验证通过（内置公钥）
[OK] 索引校验全部通过
exit=0

$ bash scripts/validate-presets.sh
[OK] db-only.json: 常驻 0/3, 合计 6.21 MiB …  （8 个预设逐条 OK）
[OK] 校验通过：8 个预设 / 24 个索引插件 / 0 FAIL / 0 WARN
exit=0
```

反例 1（篡改 `plugins.json` 正文 `backup.name`、不重签）：

```text
$ bash scripts/validate-index.sh
[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）
NEG1_EXIT=1
```

反例 2（把 `presets/db-only.json` 的 backup pin 回退到 0.4.2）：

```text
$ bash scripts/validate-presets.sh
[FAIL] db-only.json.plugins[3] 版本 0.4.2 与索引 backup=0.5.0 不一致
NEG2_EXIT=1
```

两处均在**同一次调用内**用备份还原（不留 /tmp 跨调用残留），还原后复核：

```text
validate-index recheck exit=0
validate-presets recheck exit=0
```

## 7. 全量资产核对（24 条）

按 `index/plugins.json` 逐条 `curl -sSL` 下载，比对实测 size 与 sha256：

```text
TOTAL=24 OK=23 BAD_COUNT=1
BAD file@0.3.4 http=404 size=9/1697251 sha=0019dfc4b32d/d72346a659c0
OK  backup@0.5.0 http=200 size=1717615 sha=f76a165a0b5b
（其余 22 条全部 OK，200 + size/sha 双对）
```

**唯一 BAD 属他人轨道，不在本卡写域**：`file@0.3.4` 由 `file-manager-rebuild` 于 10:39（`87e255a`）收录，但 GitHub 无 `v0.3.4` release（`gh release list` 最新为 `file v0.3.3`），故 404。已 `send_message` 横向通报该 agent 补建三端 release，并声明我不改它的索引条目。本卡交付物 `backup@0.5.0` 为 OK。

通报后持续观察 2 分钟（6 次轮询，均在 10:49–10:51），该资产仍 404：

```text
poll 1..6: file@0.3.4 http=404   (10:49:56 / 10:50:19 / 10:50:40 / 10:51:01 / 10:51:23 / 10:51:45)
```

结论：首次核对时 24 条中 23 条 OK、`backup@0.5.0` 实测 200+sha+size 三项全对；缺口在另一轨道。我**没有**为凑数改它的条目或放宽校验（不放宽判据是本卡的底线）。

**最终复核（通报后约 3 分钟，peer 已补建 file@0.3.4 release）：**

```text
OK  backup@0.5.0 http=200 size=1717615 sha=f76a165a0b5b
FINAL: TOTAL=24 OK=24 BAD_COUNT=0
```

全量 24 个索引条目均 `http=200` 且实测 size/sha256 与索引记录逐字一致。

## 8. 公钥未变（不需重启 kored）

```text
$ grep -n IndexPublicKeyHex internal/core/market/verify.go
16:const IndexPublicKeyHex = "3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"
$ bash scripts/pubkey-sync-check.sh
[OK] 两端公钥一致：kore/internal/core/market/verify.go:16:3e461a07…
[OK] 索引仓验签脚本：kore-plugins/scripts/validate-index.sh:31:3e461a07…
exit=0
```

且 `validate-index.sh` 用**同一内置公钥**验签通过（§6），说明重签未更换公钥 → 编进 `bin/kored` 的公钥常量仍有效 → 无需 `make build` / 重启。

kored 未重启的证据：

```text
$ ps -o pid,lstart,etime,cmd -C kored
PID     STARTED                    ELAPSED  CMD
636777  二 11月 24 10:28:16 2026   19:41    …/kore/bin/kored serve --config …/.kore-local.yaml
now=2026-11-24 10:47:59
```

进程启动时间 10:28:16 早于本卡开工（10:41），本轮未 `make build`、未重启。

## 9. 提交（未 push）

| 仓 | commit | 文件 |
| --- | --- | --- |
| `kore-plugins` | `900039e` | `index/plugins.json`、`index/plugins.json.sig`、`index/versions.lock.json`、`market/plugins.js`、`presets/db-only.json`、`presets/full.json` |
| `kore` | 见本文件所在提交 | `.agents/verify/backup-050-release.md`（本证据文件） |
| `kore-plugin-backup` | **无新提交** | HEAD 必须 == tag（`efb0989`），发版窗口冻结；`RELEASE-EVIDENCE.md` 按既有惯例不入库 |

`market/plugins.js` 为生成物，重建时同时带出索引**已收录**的 `file@0.3.4`（`87e255a` 只改了 index 未重建 market），属「生成物与索引对齐」，已在提交信息中声明。
