# logs v0.5.3 发版入索引（发版最后一公里）

> 执行者：`logs-release-053`｜时间：2026-11-24 10:54–11:09（Asia/Shanghai）
> 写域：`kore-plugin-logs` tag/release + `kore-plugins` 索引/账本/预设/签名/market + 本证据文件
> 约束遵守：未 `make build`、未重启 kored、未打印任何 token 明文（token 仅经 shell 变量与 `Authorization` 头，用完即弃）

## 0. 结论

- 核实：`info.json` / `manifest.json` 均 `0.5.3`；本地 dist sha `3684f87f…` / size 1601705；`kore-plugin-logs` HEAD == `ebd435a`
- 本地无 `v0.5.3` tag → 新建 **annotated** tag 并显式钉 `ebd435a`；三端 peel 一致
- 三端 `main` + `v0.5.3` 已推送；三端 release 均已建（Gitea id=56341 / Gitee id=1360895 / GitHub release），各挂 `logs-0.5.3.tar.gz` + `.sha256`
- 索引：`plugins.json` 的 logs 条目升 0.5.3，`versions.lock.json` 追加，两处 preset pin 同步 0.5.3，已重签，`market/plugins.js` 已重建
- `validate-index.sh` / `validate-presets.sh` 正例 exit 0；三个反例均按预期非 0 并已还原
- **全量 24 条索引资产：`TOTAL=24 OK=24 BAD_COUNT=0`**
- 公钥未变（`3e461a07…`），**不需重启 kored**；kored 启动于 10:28:16（早于本卡开工），本轮未重启

## 1. 核实（改前）

```text
$ cd kore-plugins && git log --oneline -5 && git status --short
900039e [agent:backup-release-050] index(backup): 收录 0.5.0（sha f76a165a，预设一键）+ 预设 pin 同步 + 重签 + 重建 market
c60ccab [agent:file-manager-rebuild] presets: file 固定版本同步 0.3.4（G-18 预设可解析）
87e255a [agent:file-manager-rebuild] index(file): 收录 0.3.4（sha d72346a6，修复缺省根不可用）
32a4bc5 [agent:resign-52] chore(index): 第 52 把重签 — site 0.4.4 / file 0.3.3 / app-deploy 0.3.2（P1 数据丢失修复入索引）
339efa7 [agent:monitor-clean-bump] chore(index): monitor 0.3.1 入索引并重签（pluginapi v0.1.1→v0.1.3，dist 86fed8f2）
（git status --short 为空 —— 开工基线干净）
```

```text
$ jq -r .version ../kore-plugin-logs/info.json      # 0.5.3
$ jq -r .version ../kore-plugin-logs/manifest.json  # 0.5.3

$ sha256sum ../kore-plugin-logs/dist/logs-0.5.3.tar.gz
3684f87f06cc8965fda950ec308aab2b07671439b4259ed68c8790d303285b6d
$ stat -c%s ../kore-plugin-logs/dist/logs-0.5.3.tar.gz
1601705
$ cat ../kore-plugin-logs/dist/logs-0.5.3.tar.gz.sha256
3684f87f06cc8965fda950ec308aab2b07671439b4259ed68c8790d303285b6d  logs-0.5.3.tar.gz

$ git -C ../kore-plugin-logs rev-parse HEAD
ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b
$ git -C ../kore-plugin-logs rev-parse HEAD^{tree}
cd60436bddb2a13567a50baad5fea751ff5fce15
$ git -C ../kore-plugin-logs tag -l 'v0.5.3'     # 空输出 —— 本地无该 tag
```

改前远端状态（三端一致）：

```text
origin 62fca470e73662014d140d14ca6f27078f2218f7  refs/heads/main
github 62fca470e73662014d140d14ca6f27078f2218f7  refs/heads/main
gitee  62fca470e73662014d140d14ca6f27078f2218f7  refs/heads/main
（三端 git ls-remote --tags 'v0.5.3*' 均无输出）
```

## 2. tag（annotated，显式钉 sha）

```text
$ git tag -a v0.5.3 ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b \
    -m "logs v0.5.3: 日志切割与清理改为默认行为（装完不配即生效）"
$ git cat-file -t v0.5.3          # tag   （annotated，非轻量）
$ git rev-parse 'v0.5.3^{}'       # ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b
$ git rev-parse HEAD              # ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b  → HEAD == 打 dist 的树
```

推送（origin → github → gitee）：

```text
$ git push origin main v0.5.3
   62fca47..ebd435a  main -> main ; * [new tag] v0.5.3 -> v0.5.3   exit=0
$ git push github main v0.5.3
   62fca47..ebd435a  main -> main ; * [new tag] v0.5.3 -> v0.5.3   exit=0
$ git push gitee main v0.5.3
   62fca47..ebd435a  main -> main ; * [new tag] v0.5.3 -> v0.5.3   exit=0
```

三端回读（`git ls-remote --tags`）：

```text
origin da3b4f8340820881757c8f9a0c53a70aae46b94d refs/tags/v0.5.3
origin ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b refs/tags/v0.5.3^{}
github da3b4f8340820881757c8f9a0c53a70aae46b94d refs/tags/v0.5.3
github ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b refs/tags/v0.5.3^{}
gitee  da3b4f8340820881757c8f9a0c53a70aae46b94d refs/tags/v0.5.3
gitee  ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b refs/tags/v0.5.3^{}
```

三端 peeled sha 一致，且 == 打 dist 的树（`ebd435a`）。

## 3. 三端 release + 资产

| 端 | 创建方式 | 结果 |
| --- | --- | --- |
| Gitea（权威源） | `POST /api/v1/repos/kore-pl/kore-plugin-logs/releases` + `POST .../assets` | release id=**56341**，http=201；两资产 http=201 |
| GitHub（镜像） | `gh release create v0.5.3 … --repo kore-pl/kore-plugin-logs` | https://github.com/kore-pl/kore-plugin-logs/releases/tag/v0.5.3 |
| Gitee（镜像） | `POST /api/v5/repos/pengtang1024/kore-plugin-logs/releases`，**`target_commitish=ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b`（完整 40 位）** | release id=**1360895**，http=201；两资产 http=201 |

三端 `curl -L` 回读（本地基准 sha `3684f87f…`、size 1601705）：

```text
--- https://gitea.iouf.cn/kore-pl/kore-plugin-logs ---
[logs-0.5.3.tar.gz]        HTTP=200 SIZE=1601705 sha=3684f87f06cc
[logs-0.5.3.tar.gz.sha256] HTTP=200 SIZE=84      sha=ab17fb7945d4
--- https://github.com/kore-pl/kore-plugin-logs ---
[logs-0.5.3.tar.gz]        http=200 size=1601705 sha=3684f87f06cc
[logs-0.5.3.tar.gz.sha256] HTTP=200 SIZE=84      sha=ab17fb7945d4
--- https://gitee.com/pengtang1024/kore-plugin-logs ---
[logs-0.5.3.tar.gz]        HTTP=200 SIZE=1601705 sha=3684f87f06cc
[logs-0.5.3.tar.gz.sha256] HTTP=200 SIZE=84      sha=ab17fb7945d4
```

`.sha256` 旁挂资产内容（网络下载回读）：

```text
3684f87f06cc8965fda950ec308aab2b07671439b4259ed68c8790d303285b6d  logs-0.5.3.tar.gz
```

元数据回读：

```text
Gitea : tag=v0.5.3 id=56341 assets=[(logs-0.5.3.tar.gz,1601705), (logs-0.5.3.tar.gz.sha256,84)]
GitHub: tag=v0.5.3 assets=[{logs-0.5.3.tar.gz,1601705}, {logs-0.5.3.tar.gz.sha256,84}]
Gitee : tag=v0.5.3 id=1360895 target_commitish=ebd435aba7bb0efdcf6f1cbcfcb3b6f60765338b (len=40)
        assets=[logs-0.5.3.tar.gz, logs-0.5.3.tar.gz.sha256, v0.5.3.zip, v0.5.3.tar.gz(自动源码包)]
```

## 4. 索引改前 → 改后

`index/plugins.json` 的 logs 条目：

```text
改前: version 0.5.2 / size_bytes 1592747 / sha cb0ce582ff63… /
      download_url .../download/v0.5.2/logs-0.5.2.tar.gz
改后: version 0.5.3 / size_bytes 1601705 /
      sha 3684f87f06cc8965fda950ec308aab2b07671439b4259ed68c8790d303285b6d /
      download_url https://github.com/kore-pl/kore-plugin-logs/releases/download/v0.5.3/logs-0.5.3.tar.gz
```

`index/versions.lock.json`：logs 数组由 9 条（0.2.0…0.5.2）追加为 10 条，新增：

```json
{ "version": "0.5.3", "sha256": "3684f87f06cc8965fda950ec308aab2b07671439b4259ed68c8790d303285b6d" }
```

`git diff --stat`（提交前）：

```text
 index/plugins.json       | 8 ++++----
 index/plugins.json.sig   | 4 +---
 index/versions.lock.json | 4 ++++
 market/plugins.js        | 2 +-
 presets/full.json        | 2 +-
 presets/web-pro.json     | 2 +-
 6 files changed, 12 insertions(+), 10 deletions(-)
```

无格式化噪音（只动 logs 相关的行）。

## 5. preset pin 判断：需要改，已改

`scripts/validate-presets.sh` 对每条引用做**精确版本**比对（与 `desired` 是 enabled / disabled 无关）：

```python
want_ver = str(ref.get("version", ""))
if want_ver != str(p["version"]):
    err(f"{name}.plugins[{i}] 版本 {want_ver} 与索引 {rid}={p['version']} 不一致")
```

`grep -rn 'logs' presets/*.json` 命中两处，均须同步：

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| `presets/full.json` | logs 0.5.2（desired=disabled） | logs **0.5.3** |
| `presets/web-pro.json` | logs 0.5.2（desired=enabled） | logs **0.5.3** |

## 6. 重签 + validate 正反例

```text
$ bash scripts/sign-index.sh
[OK] 已用长期密钥签名（公钥常量不变，无需 make build / 重启 kored）  exit=0
$ bash scripts/build-market.sh
[OK] 生成 market/plugins.js：24 个插件（3765 字节），六字段齐全、无外链  exit=0
```

正例：

```text
$ bash scripts/validate-index.sh
[INFO] 签名校验：开启（ed25519 全量验签）
[OK] schema / 必填字段 / id 唯一 / sha256 格式通过（24 条）
[OK] 版本单调递增 / 同 id@version 唯一 sha 校验通过（基线 24 条）
[OK] 预设引用可解析（占位/已校验 47 条引用）
[OK] market/plugins.js 与索引逐字节一致（24 个插件）
[OK] ed25519 签名验证通过（内置公钥）
[OK] 索引校验全部通过
POS_INDEX_EXIT=0

$ bash scripts/validate-presets.sh
[OK] db-only.json: 常驻 0/3, 合计 6.21 MiB …
（8 个预设逐条 OK）
[OK] 校验通过：8 个预设 / 24 个索引插件 / 0 FAIL / 0 WARN
POS_PRESETS_EXIT=0
```

反例 1（篡改 `plugins.json` 的 `logs.size_bytes` 1601705→1601706，不重签）：

```text
[OK] market/plugins.js 与索引逐字节一致（24 个插件）
[FAIL] ed25519 签名验证失败（索引被篡改或签名不匹配）
NEG1_EXIT=1
```

反例 2（把 `presets/full.json` 的 logs pin 回退 0.5.2）：

```text
[FAIL] full.json.plugins[8] 版本 0.5.2 与索引 logs=0.5.3 不一致
NEG2_EXIT=1
```

反例 3（篡改 `market/plugins.js` 的 logs 版本，索引不变）：

```text
[FAIL] market/plugins.js 与 index/plugins.json 不一致：改索引必须同轮重建（bash scripts/build-market.sh）并一起提交
NEG3_EXIT=1
```

三处均在**同一次调用内**用备份还原（不留 `/tmp` 跨调用残留），还原后复核：

```text
recheck_index_exit=0
recheck_presets_exit=0
git status --short 仅剩本卡 6 个预期文件
```

## 7. 全量资产核对（24 条）

按 `index/plugins.json` 逐条 `curl -sSL`（`--retry 3`）下载，比对实测 size 与 sha256：

```text
OK   echo@0.1.5 / site@0.4.4 / file@0.3.4 / ssl@0.6.0 / integrity@0.5.1 / cron@0.7.0
OK   ssh-guard@0.3.1 / monitor@0.3.1 / logs@0.5.3 / dns@0.4.2 / runtime-php@0.2.2
OK   runtime-node@0.2.5 / runtime-python@0.3.2 / db-mysql@0.4.1 / db-postgres@0.3.4
OK   redis@0.6.0 / backup@0.5.0 / firewall@0.2.6 / waf@0.4.5 / container@0.5.5
OK   app-deploy@0.3.2 / terminal@0.2.1 / process@0.3.0 / discover@0.3.1
FINAL: TOTAL=24 OK=24 BAD_COUNT=0 BAD=[]
```

过程如实记录：首轮 `cron@0.7.0` 出现一次 `http=000`（curl 连接未建立，非 404）。单独重试立即 200、size 1572337 / sha `23a58e0b82a4…` 与索引逐字一致，随后带 `--retry` 全量复跑得 `TOTAL=24 OK=24 BAD_COUNT=0`。未为此改动任何索引条目。

## 8. `market/plugins.js` 已重建（证据）

生成物由 `scripts/build-market.sh` 从 `index/plugins.json` 生成，`validate-index.sh` 现含**逐字节一致性**检查（反例 3 即它的反证）。重建后 logs 行：

```text
{"id":"logs","name":"日志查看分析插件","version":"0.5.3","depth_level":"production",
 "description":"日志查看分析插件（场景：ops）。详情见对应插件仓库。","scenario_tags":["ops"]}
```

`market/plugins.js` 在本次提交内（`git diff --stat` 第 4 行），与索引同轮落地。

派生一致门禁（只读，`make check` 第 16 段）：

```text
$ bash ../kore-plugins/scripts/build-market.sh --check
[OK] market/plugins.js 与索引逐字节一致（24 个插件）   exit=0
$ cd ../kore && make market-check
[OK] market/plugins.js 与索引逐字节一致（24 个插件）   exit=0
```

## 9. 公钥未变（不需重启 kored）

```text
$ grep -n IndexPublicKeyHex internal/core/market/verify.go
16:const IndexPublicKeyHex = "3e461a079fde0e534f223c39d571b9823922f8e4705f046f8409bf9acd2df1c0"
$ bash scripts/pubkey-sync-check.sh
[OK] 两端公钥一致：kore/internal/core/market/verify.go:16:3e461a07…
[OK] 索引仓验签脚本：kore-plugins/scripts/validate-index.sh:37:3e461a07…   exit=0
```

`validate-index.sh` 用**同一内置公钥**验签通过（§6），说明重签未换钥 → 编进 `bin/kored` 的公钥常量仍有效 → 无需 `make build` / 重启。

未重启证据：

```text
$ ps -o pid,lstart,etime,cmd -C kored
636777  二 11月 24 10:28:16 2026   39:37   …/kore/bin/kored serve --config …/.kore-local.yaml
$ stat -c '%y' bin/kored
2026-11-24 10:26:28
now=2026-11-24 11:07:55
```

kored 启动时间 10:28:16、二进制 mtime 10:26:28，均早于本卡开工（10:54），本轮未 `make build`、未重启。

## 10. 提交（未 push）

| 仓 | 文件 |
| --- | --- |
| `kore-plugins` | `index/plugins.json`、`index/plugins.json.sig`、`index/versions.lock.json`、`market/plugins.js`、`presets/full.json`、`presets/web-pro.json` |
| `kore` | `.agents/verify/logs-053-release.md`（本证据文件） |
| `kore-plugin-logs` | **无新提交**（发版窗口冻结，HEAD 必须 == tag `ebd435a`；`RELEASE-EVIDENCE.md` 为既有 untracked 惯例文件，不入库） |

commit sha 见交付回执。
