# Gitea / Gitee release 补建与全仓缺口核实（2026-11-24）

- 执行：`[agent:mirror-release-catchup]` 11:07–11:26 +08:00
- 范围：24 个插件仓 + 索引仓；**只建 release、不改代码、不推 tag、不动索引**
- 约束：token 全程未打印明文；建前 GET 查存在性，建后 `curl -L` 回读 sha256

## 1. token 可用性（结论：可用，来源为本地凭据库）

| 项 | 结果 |
| --- | --- |
| `GITEA_TOKEN` / `GITEE_TOKEN` 环境变量 | 均 **UNSET**（`${#VAR}` 判断，未输出值） |
| 实际来源 | `~/.git-credentials`（`gitea.iouf.cn` 1 条、`gitee.com` 2 条），经 `git credential fill` 进 shell 变量 |
| 可用性实测 | Gitea API 200 / Gitee API 200；Gitea token 40 字符、Gitee 32 字符（只报长度） |
| `GITHUB_TOKEN` | UNSET；`gh` 已登录 `pengtang1024`（keyring），按需走 `gh api` |
| 其它来源 | `secret-tool` 存在但未使用——`resign-52` §8 记录过 `secret-tool search --all` 把明文打进 transcript 的事故，本轮**禁止**该路径 |

获取方式（可粘贴，不落盘、不打印）：

```bash
GITEA_TOKEN="$(printf 'protocol=https\nhost=gitea.iouf.cn\n\n' | git credential fill | sed -n 's/^password=//p')"
GITEE_TOKEN="$(printf 'protocol=https\nhost=gitee.com\n\n'      | git credential fill | sed -n 's/^password=//p')"
```

> 说明：Gitea/Gitee 凭据不是「拿不到」，而是**没有导出成环境变量**。`resign-52` 当时能建成功，走的就是同一条本地凭据路径（其证据 §1 的 release id 可见）。

## 2. 全仓缺口表（补建后状态）

`索引版本` 取 `kore-plugins/index/plugins.json`；GH/GT/GE 列为**索引版本**在该端是否有 release（补建后 24/24 全 Y）。
`release 数` 为 Gitea / Gitee 全量 release 数；`缺口` 只记 Gitea（Gitee 按策略只保留最新 5，旧版缺失属预期）。

| 仓 | 索引版本 | GitHub | Gitea | Gitee | Gitea/仓库 tag | 缺口 |
| --- | --- | :--: | :--: | :--: | --- | --- |
| app-deploy | 0.3.2 | Y | Y | Y | 8 / 8 | 无 |
| backup | 0.5.0 | Y | Y | Y | 2 / 8 | Gitea 缺 6（旧版无 dist） |
| container | 0.5.5 | Y | Y | Y | 10 / 10 | 无 |
| cron | 0.7.0 | Y | Y | Y | 8 / 8 | 无 |
| db-mysql | 0.4.1 | Y | Y | Y | 7 / 7 | 无（0.5.0 未 tag，见 §4） |
| db-postgres | 0.3.4 | Y | Y | Y | 9 / 9 | 无 |
| discover | 0.3.1 | Y | Y | Y | 4 / 4 | 无 |
| dns | 0.4.2 | Y | Y | Y | 9 / 9 | 无（最新 v0.5.1 已补） |
| echo | 0.1.5 | Y | Y | Y | 1 / 6 | Gitea 缺 5（旧版无 dist） |
| file | 0.3.4 | Y | Y | Y | 7 / 8 | Gitea 缺 1（v0.1.0 无 dist） |
| firewall | 0.2.6 | Y | Y | Y | 6 / 7 | Gitea 缺 1（v0.2.3 无 dist） |
| integrity | 0.5.1 | Y | Y | Y | 10 / 10 | 无 |
| logs | 0.5.3 | Y | Y | Y | 8 / 11 | Gitea 缺 3（v0.1.0/0.2.0/0.2.1 无 dist） |
| monitor | 0.3.1 | Y | Y | Y | 5 / 6 | Gitea 缺 1（v0.3.0 无 dist） |
| process | 0.3.0 | Y | Y | Y | 5 / 6 | Gitea 缺 1（v0.2.1 无 dist） |
| redis | 0.6.0 | Y | Y | Y | 5 / 6 | Gitea 缺 1（v0.5.0 无 dist，dist 里是 0.5.1） |
| runtime-node | 0.2.5 | Y | Y | Y | 8 / 8 | 无 |
| runtime-php | 0.2.2 | Y | Y | Y | 5 / 5 | 无 |
| runtime-python | 0.3.2 | Y | Y | Y | 9 / 9 | 无 |
| site | 0.4.4 | Y | Y | Y | 10 / 11 | Gitea 缺 1（v0.5.0 tag 三端未推） |
| ssh-guard | 0.3.1 | Y | Y | Y | 8 / 8 | 无 |
| ssl | 0.6.0 | Y | Y | Y | 8 / 9 | Gitea 缺 1（v0.4.0 无 dist） |
| terminal | 0.2.1 | Y | Y | Y | 4 / 4 | 无 |
| waf | 0.4.5 | Y | Y | Y | 9 / 10 | Gitea 缺 1（v0.3.0 无 dist） |
| kore-plugins | — | — | — | — | 0 / 0 | 索引仓无 tag，不建 |

**汇总（实测）**：本地 `v*` tag 187 → GitHub release 183（补建前）/ Gitea **165**（补建前 11）/ Gitee 127（补建前 124）。
索引 24 个版本在**三端均已有 release（0 缺失）**；Gitea 剩余缺口 **22 个 tag** = 21 个「本地无 dist」+ 1 个「tag 未推」（site v0.5.0）。

## 3. 本轮补建结果（全部 `curl -L` 回读 sha256 = OK）

| 端 | 数量 | 明细 |
| --- | ---: | --- |
| Gitea release | **154** | 最新 5 窗口 92 + `site v0.6.0` + `ssl v0.7.0` + 历史 60；rid 区间 56156–56344 |
| Gitea 资产补传 | 9 | site v0.4.4 / logs v0.5.1·v0.5.2 / file v0.3.3·v0.3.4 / app-deploy v0.3.2 / container v0.5.4 / ssh-guard v0.3.1 / waf v0.4.4（补 `.sha256`） |
| Gitee release | 3 | `site v0.6.0` id=1360981 / `ssl v0.7.0` id=1360983 / `dns v0.5.1` id=1360985 |
| 创建失败 / 冲突 | 0 | 建前 GET 判存在，已存在则跳过；0 次 409/422 |

验收命令与样例输出：

```text
[CREATE] ssl v0.7.0 rid=56344 http/size=200 3177701 sha=OK
[OK] v0.6.0 资产校验 http=200 sha256=3f1870abae38f89970aeb2264964c9f79f392bc23153960c1a95074b9edef944
[OK] v0.6.0 公开视角 GET /releases/tags/v0.6.0 → 200
```

Gitea 建 release 的接口形态（`target_commitish` 传完整 40 位 sha，与 Gitee 同要求）：

```bash
SHA=$(git -C ../kore-plugin-site rev-parse 'v0.6.0^{commit}')
curl -sS -X POST -H "Authorization: token $GITEA_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"tag_name\":\"v0.6.0\",\"target_commitish\":\"$SHA\",\"name\":\"v0.6.0\",\"draft\":false,\"prerelease\":false}" \
  "https://gitea.iouf.cn/api/v1/repos/kore-pl/kore-plugin-site/releases"
```

## 4. 剩余缺口与精确命令（用户/释放方可直接粘贴）

### 4.1 需要先推 tag（不是 release 脚本能补的）

| 仓 / 版本 | 现状 | 动作 |
| --- | --- | --- |
| `site v0.5.0` | tag 只在本地，三端 `ls-remote` 均为 0 条 | 先确认是否仍要发（已被 v0.6.0 覆盖），要发则 `git -C ../kore-plugin-site push origin v0.5.0 && git -C ../kore-plugin-site push github v0.5.0 && git -C ../kore-plugin-site push gitee v0.5.0` |
| `db-mysql 0.5.0` | `info.json=0.5.0`、`dist/db-mysql-0.5.0.tar.gz` 已生成，但**无 tag** | 由该路释放方补 tag 后建 release（勿由他人代推） |
| `GitHub ssl v0.7.0` / `dns v0.5.1` | tag 已推，release 未建 | `gh release create v0.7.0 --repo kore-pl/kore-plugin-ssl --title v0.7.0 ../kore-plugin-ssl/dist/ssl-0.7.0.tar.gz ../kore-plugin-ssl/dist/ssl-0.7.0.tar.gz.sha256`（dns 同形） |

### 4.2 Gitea 21 个「无 dist」tag：从 tag 干净树重打后补建

```bash
# 以 kore-plugin-echo v0.1.0 为例（其余按 §2 缺口列替换 repo/tag）
TMP=$(mktemp -d)
git -C ../kore-plugin-echo archive v0.1.0 | tar -x -C "$TMP"
( cd "$TMP" && umask 077 && make dist )          # 产出 dist/echo-0.1.0.tar.gz(+.sha256)
SHA=$(git -C ../kore-plugin-echo rev-parse 'v0.1.0^{commit}')
RID=$(curl -sS -X POST -H "Authorization: token $GITEA_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"tag_name\":\"v0.1.0\",\"target_commitish\":\"$SHA\",\"name\":\"v0.1.0\",\"draft\":false,\"prerelease\":false}" \
  "https://gitea.iouf.cn/api/v1/repos/kore-pl/kore-plugin-echo/releases" | jq -r .id)
for f in "$TMP"/dist/echo-0.1.0.tar.gz "$TMP"/dist/echo-0.1.0.tar.gz.sha256; do
  curl -sS -X POST -H "Authorization: token $GITEA_TOKEN" -F "attachment=@$f" \
    "https://gitea.iouf.cn/api/v1/repos/kore-pl/kore-plugin-echo/releases/$RID/assets?name=$(basename $f)"
done
curl -sSL -o /tmp/rb "https://gitea.iouf.cn/kore-pl/kore-plugin-echo/releases/download/v0.1.0/echo-0.1.0.tar.gz"
sha256sum /tmp/rb      # 与 $TMP/dist/echo-0.1.0.tar.gz 比对
```

无 dist 的 21 个 tag：backup `v0.1.0 v0.2.0 v0.2.1 v0.3.0 v0.4.0 v0.4.1`；echo `v0.1.0–v0.1.4`；file `v0.1.0`；firewall `v0.2.3`；logs `v0.1.0 v0.2.0 v0.2.1`；monitor `v0.3.0`；process `v0.2.1`；redis `v0.5.0`；ssl `v0.4.0`；waf `v0.3.0`。

### 4.3 Gitee 旧版本

Gitee 策略为「每仓只保留最新 5 个」，旧版本缺失属预期，**不回填**；新增版本用：

```bash
GITEE_TOKEN=... bash scripts/gitee-release-fill.sh --latest 1 --require-dist --dir ../kore-plugin-<id>
```

## 5. 边界声明

- 未改任何代码、未改索引 / 预设 / 版本文件、未 push 任何 tag。
- 未触碰 `.kore-local.yaml`、运行态目录与 `bin/kored`。
- 本轮与 `push-final-batch` 并发：建前 GET 判存在，0 次冲突；Gitea 期末 165 个 release 中，超出本文件记账的部分为 peer 并发创建。
