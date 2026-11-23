[agent:kore-verify-privilege]

# pluginapi v0.1.5 代理可解析性诊断（task-161）

- 日期：2026-11-23 21:05+08:00 · 执行：kore-verify-privilege · 只读诊断，未改仓库、未打 tag。
- tag：`pkg/pluginapi/v0.1.5` → annotated 对象 `c5cf008`，peeled `91709a2`（三端一致）。

## 1. 代理探测（HTTP 状态码 / 耗时 / 响应体）

| 代理 | v0.1.5 `.info` | `.mod` | `.zip` |
|---|---|---|---|
| `proxy.golang.org`（默认） | **200** / 0.78s / 232B（含 `Origin.URL=https://github.com/pengtang1024/kore`，`Hash=91709a2…`） | **200** / 0.81s / 358B | **200** / 0.77s / 52,159B |
| `goproxy.cn` | **200** / 0.12s / 50B | **200** / 0.13s / 358B | **200** / 5.77s / 52,159B |
| 对照 v0.1.4（默认代理） | 200 / 0.61s | — | — |

**没有 404、没有 5xx、没有超时**；两个代理都已收录 v0.1.5（zip 字节数一致 52,159B）。

## 2. 真实 go 命令（干净目录、未设 GOPROXY）

```text
$ go mod init probe && go get github.com/pengtang1024/kore/pkg/pluginapi@v0.1.5
go: added github.com/pengtang1024/kore/pkg/pluginapi v0.1.5     # exit 0，1 秒
require github.com/pengtang1024/kore/pkg/pluginapi v0.1.5 // indirect
```

## 3. 仓库地址与重定向（迁移后遗症假设的检验）

```text
git ls-remote https://github.com/pengtang1024/kore  refs/tags/pkg/pluginapi/v0.1.5 → c5cf008055a804db103d4c48f1dd98bdd3c2aa66  exit 0
git ls-remote https://github.com/kore-pl/kore       refs/tags/pkg/pluginapi/v0.1.5 → c5cf008055a804db103d4c48f1dd98bdd3c2aa66  exit 0
curl -I https://github.com/pengtang1024/kore → 301 → https://github.com/kore-pl/kore
curl -I https://github.com/kore-pl/kore      → 200
```

**机制成立但无影响**：module 路径仍是 `github.com/pengtang1024/kore`，GitHub 对该地址 301 到新组织；Go 代理会跟随重定向拉取并用 module 路径校验，v0.1.5 已被成功索引（`Origin.URL` 就是 301 前地址）。

## 4. 结论：**索引延迟**，不是抓取失败

- tag 于 12:48:44Z 推送；当时默认代理 180s 超时是「新 tag 尚未被抓取」的窗口期。
- 现在（约 15 分钟后）两个代理均 **200**，默认代理 `go get` 1 秒成功；仓库重定向正常。
- **不存在「迁移后首个 tag 永远拉不到」的缺陷**；也不需要保留只读镜像仓或改 module 路径。

## 5. 补救方案与推荐

| 方案 | 评估 |
|---|---|
| **A. 等索引（推荐）** | 现状已验证恢复；下游默认代理可用。发布流程加一条「tag 后等 `proxy.golang.org/.../@v/<ver>.info` 返回 200 再发下游」即可 |
| B. 保留只读镜像仓 | 不需要：301 重定向与代理索引均正常，徒增双源 |
| C. 文档化 `GOPROXY=direct` | 仅作为 tag 后 5–15 分钟窗口期的应急说明，不作默认要求 |
| D. 改 module 路径升主版本 | 成本高且无必要；若未来彻底告别旧组织名可另立 ADR |

## 6. 明确回答：waf 0.4.1 现在能不能发？

**能发。** `require github.com/pengtang1024/kore/pkg/pluginapi v0.1.5` 在默认代理下已可干净拉取（`go get` 1s、zip 52,159B 一致），下游 CI 不会因此变红。
建议：发版前跑一次 `curl -fsS https://proxy.golang.org/.../@v/v0.1.5.info >/dev/null && echo ready` 作为发布前门禁；无并发影响。
