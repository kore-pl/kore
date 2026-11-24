# Gitea 五仓 release 补建证据（release-gitea-inject，2026-11-24 20:52–20:56 +08:00）

- 执行者：`[agent:release-gitea-inject]`；写域仅本文件（+ 远端 Gitea release / 资产）。
- 目标：补齐 Gitea(`gitea.iouf.cn/kore-pl/<repo>`) 缺失的 5 个 release，与 GitHub 5/5 对齐。GitHub 未触碰。
- 凭据：仅在本 agent 的 bash 进程内 `set -a; . "$HOME/.config/environment.d/10-api-tokens.conf"; set +a` 注入，
  全程只以 `$GITEA_TOKEN` 引用（长度 40 字符，仅报长度、未打印明文、未写任何文件 / 日志 / 提交 / 会话）。`$GITEE_TOKEN` 未使用。
- 边界：未改 scripts/、代码、index、config、运行态；未 push；未改任何既有 release；无 force / 无破坏。
- 依据：kore/AGENTS.md §2 G-07/G-30；kore/.agents/HANDOFF.md §0.0.3 item5 + §0.0.5 item4；
  kore/.agents/verify/mirror-release-catchup.md §3 API 形态（POST JSON + `?name=<basename>` 资产上传）。

## 1. 前置核对（本地 dist + tag peeled sha）

命令形状（token 不参与）：

```bash
sha256sum kore-plugin-<id>/dist/<id>-<ver>.tar.gz | awk '{print $1}'
awk '{print $1}' kore-plugin-<id>/dist/<id>-<ver>.tar.gz.sha256
git -C kore-plugin-<id> rev-parse '<tag>^{commit}'
```

| 仓 / tag | peeled sha（40 位，target_commitish） | 本地 tar.gz sha256 | .sha256 内容 | 比对 |
| --- | --- | --- | --- | --- |
| app-deploy v0.3.3 | `303fe3af6e804806955f7937f966d998b7ab539f` | `3253c1a72a9ec098f985e97f8b8a3d128508f5dc328e4b6fcd9f212c55bbcb39` | 同左 | MATCH |
| file v0.3.5 | `326e803b6ae7fd103c87e22d123d9d1392262736` | `db8388f0d3bdfd08ea4222f11c3195314a0e86f0deb886232f6b1804b723f133` | 同左 | MATCH |
| logs v0.5.4 | `221e064c5e23872f62a42aa8145edc9755ef7047` | `34301a77919a864f8371488b00d490c452bd9bf8e031a0179059c30fdd96b3ad` | 同左 | MATCH |
| backup v0.5.1 | `c31fd3248deef9c1db00f7691a9ab873748f35d4` | `bc202ac6dd59dca798ad3895baa8a7f6fc1794c5e31336b992e5e5e91a30e29c` | 同左 | MATCH |
| dns v0.5.2 | `e2324e9cdfcc6cc283f6b6296353c4d43b57e8c7`（**显式钉 e2324e9，非 HEAD**） | `fce690854fb4bc7b1f26e74620bdc5bc9ce556afe9e4c9a230b7133fd64a4baa` | 同左 | MATCH |

5/5 本地 tar.gz 实测 sha256 与 `.sha256` 逐字一致；所有 `git rev-parse` EXIT=0，均为 40 位 peeled sha。
以上 sha 与 HANDOFF §0.0.5 第 2/3 条、§0.0.2 D 节的 peeled sha / dist sha 前缀一致。

## 2. 幂等存在性检查（建前 GET）

命令形状：

```bash
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "https://gitea.iouf.cn/api/v1/repos/kore-pl/<repo>/releases/tags/<tag>"
```

5/5 返回 **HTTP 404**（`curl` EXIT=0）→ 五个 release 均不存在，可安全创建。
为排除「404 其实是鉴权失效 / 仓不存在」，补做只读 sanity：

```bash
curl -sS -H "Authorization: token $GITEA_TOKEN" https://gitea.iouf.cn/api/v1/repos/kore-pl/<repo>
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  https://gitea.iouf.cn/api/v1/repos/kore-pl/kore-plugin-app-deploy/releases/tags/v0.3.2
```

结果：5 仓 repo GET 全 **HTTP 200**（`full_name=kore-pl/kore-plugin-<id>`）；
已知存在的 `app-deploy v0.3.2` GET **HTTP 200 rid=56336** → 证明 token 有效、404 是真实的「未建」。

## 3. 一次失败与自愈（如实留痕）

首次 POST 用双引号内联 JSON，在 shell 展开时丢失 JSON 双引号，实际发出
`{tag_name:v0.3.3,...}`，Gitea 返回 **HTTP 422**，错误体：

```text
{"message":"[]: jsontext: invalid character 'a' in literal true (expecting 'r') after offset 2","url":"https://gitea.iouf.cn/api/swagger"}
```

该次 `curl` EXIT=0、POST HTTP=422、**未创建任何 release**（事后 GET v0.3.3 仍 404）。
根因是客户端 payload 引号被 shell 吃掉，不是远端状态问题；改用单引号 `printf` 构造 JSON 后重试成功。
未猜删除 / 未 destroy 既有 release；失败请求体无 token、无敏感值。

## 4. 创建 release（POST）

命令形状（payload 用单引号 `printf` 构造，jq 预校验为合法 JSON）：

```bash
payload=$(printf '{"tag_name":"%s","target_commitish":"%s","name":"%s","draft":false,"prerelease":false}' "$tag" "$sha" "$tag")
curl -sS -X POST -H "Authorization: token $GITEA_TOKEN" -H "Content-Type: application/json" \
  -d "$payload" -w '\n__HTTP__%{http_code}' \
  "https://gitea.iouf.cn/api/v1/repos/kore-pl/<repo>/releases"
```

每个仓建前仍重复 GET：5/5 PRE-GET HTTP 404 → 无跳过创建；随后 POST：

| 仓 / tag | target_commitish | POST curl_exit | POST HTTP | rid | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| app-deploy v0.3.3 | `303fe3af…539f` | 0 | 201 | **56346** | CREATED |
| file v0.3.5 | `326e803b…2736` | 0 | 201 | **56347** | CREATED |
| logs v0.5.4 | `221e064c…7047` | 0 | 201 | **56348** | CREATED |
| backup v0.5.1 | `c31fd324…35d4` | 0 | 201 | **56349** | CREATED |
| dns v0.5.2 | `e2324e9c…e8c7` | 0 | 201 | **56350** | CREATED |

rid 区间 **56346–56350**，与 mirror-release-catchup.md 期末 165 release / rid 56156–56344 连续不冲突。

## 5. 资产上传（POST assets，按 basename 幂等）

命令形状：

```bash
curl -sS -X POST -H "Authorization: token $GITEA_TOKEN" -F "attachment=@<file>" \
  -w '\n__HTTP__%{http_code}' \
  "https://gitea.iouf.cn/api/v1/repos/kore-pl/<repo>/releases/<rid>/assets?name=<basename>"
```

每个 rid 先 GET release（5/5 HTTP 200）取 `.assets[].name`，逐个 basename 判断：不存在才上传。
5 仓 × 2 资产（`tar.gz` + `tar.gz.sha256`）= **10 次上传，全部 HTTP 201 / curl EXIT=0**；0 次 SKIP-ASSET（均为新建 release）。
各 release 资产清单最终为：`[<id>-<ver>.tar.gz, <id>-<ver>.tar.gz.sha256]`。

## 6. 终验（GET 200 + curl -L 回读 sha256 逐字比对）

命令形状：

```bash
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "https://gitea.iouf.cn/api/v1/repos/kore-pl/<repo>/releases/tags/<tag>"     # 期望 200
curl -sSL -o /tmp/readback-<id>-<ver>.tar.gz \
  "https://gitea.iouf.cn/kore-pl/<repo>/releases/download/<tag>/<id>-<ver>.tar.gz"
sha256sum /tmp/readback-<id>-<ver>.tar.gz | awk '{print $1}'
# 与本地 <repo>/dist/<id>-<ver>.tar.gz.sha256 的内容逐字比对
```

| 仓 / tag | GET tags/&lt;tag&gt; HTTP | rid / target_commitish | 回读 HTTP | 回读 sha256（= 本地 .sha256） | 判定 |
| --- | ---: | --- | ---: | --- | --- |
| app-deploy v0.3.3 | 200 | 56346 / `303fe3af…` | 200 | `3253c1a72a9ec098f985e97f8b8a3d128508f5dc328e4b6fcd9f212c55bbcb39` | OK / MATCH |
| file v0.3.5 | 200 | 56347 / `326e803b…` | 200 | `db8388f0d3bdfd08ea4222f11c3195314a0e86f0deb886232f6b1804b723f133` | OK / MATCH |
| logs v0.5.4 | 200 | 56348 / `221e064c…` | 200 | `34301a77919a864f8371488b00d490c452bd9bf8e031a0179059c30fdd96b3ad` | OK / MATCH |
| backup v0.5.1 | 200 | 56349 / `c31fd324…` | 200 | `bc202ac6dd59dca798ad3895baa8a7f6fc1794c5e31336b992e5e5e91a30e29c` | OK / MATCH |
| dns v0.5.2 | 200 | 56350 / `e2324e9c…` | 200 | `fce690854fb4bc7b1f26e74620bdc5bc9ce556afe9e4c9a230b7133fd64a4baa` | OK / MATCH |

终验脚本汇总行原文：`PHASE_C_DONE pass=5 fail=0`；PHASE_A `fail=0`、PHASE_B `fail=0`。

## 7. 最终结论

- **releases：5/5 GET 200**（rid 56346–56350，DNS target 为 `e2324e9…`、非 HEAD）。
- **资产：5/5 `curl -L` 回读 HTTP 200 且 sha256 与本地 `.sha256` 逐字一致**；10/10 资产上传 HTTP 201。
- GitHub 5/5 既有 release 未触碰；未 push；未改代码 / 索引 / 配置 / 运行态；未使用 `$GITEE_TOKEN`。
- 本报告仅以 `$GITEA_TOKEN` 占位符引用凭据（G-30），无明文口令 / token / secret。
