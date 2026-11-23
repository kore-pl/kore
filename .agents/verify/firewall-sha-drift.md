# firewall v0.2.3 同 `id@version` 双 sha 诊断（G-17 P0 规则违反）

> 2026-11-24 · agent:`firewall-sha-drift` · 只读诊断：未改索引、未重打包、未动 tag / release、未删本地 dist。

## 0. 结论

| 问题 | 结论 |
| --- | --- |
| 是否漂移 | 是。同 `firewall@0.2.3` 存在 **两个 dist sha**：已发布 `353d5626…c651b`（2808093 B）与本地 `9c637faa…3df753`（2808488 B） |
| 哪个是对的 | **已发布物是对的**：与 tag `v0.2.3` 完全一致（字节级复现一致），索引记录的也是它 |
| 索引是否被污染 | **没有**。索引历史上 `0.2.3` 记录的始终是 `353d5626`；`9c637faa` 在索引历史中零命中 |
| 本地那份是什么 | **未发布的野产物**：在 `3325ce7`（pluginapi v0.1.2，版本号仍 0.2.3）的树上跑了一次 `make dist`，被后者按字节复现命中 |
| 商店影响 | 无。当前索引指向 `0.2.6` = `f034229f` = 已发布资产 = 本地 dist（24/24 仓 sha 全一致） |
| 处置路径 | **路径 A**：清理本地野产物 + 补一条「本地 dist sha == 索引 sha，否则 WARN」的检查。**不走**修索引、**不走**发 0.2.7 |

## 1. 三端资产 sha256 对照

| 端 | v0.2.3 dist 资产 | 大小 | sha256 | 认定方式 |
| --- | --- | --- | --- | --- |
| Gitea（权威源） | **不存在 dist 资产** | — | — | release 页只在 Downloads 里给 auto 生成的 Source Code ZIP/TAR.GZ；`releases/download/v0.2.3/firewall-0.2.3.tar.gz` → **404**；匿名 API `releases/tags/v0.2.3` → 404、`releases` → `[]` |
| GitHub（镜像） | `firewall-0.2.3.tar.gz` | 2808093 | `353d5626453276b2adeae4db935c2eb6837e84e2e59f052d96828d568b8c651b` | API `digest` 字段 **+** 实际下载后 `sha256sum` 双确认 |
| Gitee（镜像） | `firewall-0.2.3.tar.gz` | 2808093 | `353d5626453276b2adeae4db935c2eb6837e84e2e59f052d96828d568b8c651b` | 实际下载后 `sha256sum`；与 GitHub 包 `cmp` 字节相同 |
| 本地 `dist/` | `firewall-0.2.3.tar.gz` | 2808488 | `9c637faa1013b6d9eefdc1f2a20f1db47420a597d6f52a7ec65696b2133df753` | `sha256sum`，mtime 2026-11-23 13:28 |

**注意**：`dist/` 不入库，GitHub 与 Gitee 两份资产**完全同一字节**，所以真实对照只有「已发布 vs 本地」两方；Gitea 侧没有 dist 资产可对（符合 `kore/scripts/gitee-release-fill.sh` 头注释的口径：release 只在 GitHub 侧生成，Gitee 补建，Gitea 只做代码权威源）。

## 2. 原因定位（做到字节级）

### 2.1 时间线

| 时间（+0800） | 事件 | 证据 |
| --- | --- | --- |
| 11-23 06:52:51 | `9b41607` fix + bump v0.2.3（`info.json` / `manifest.json` version 同步） | `git log` |
| 11-23 06:52:56 / 06:53:09 | GitHub release v0.2.3 创建 / 发布，挂 `353d5626` | GitHub API `created_at` / `published_at` |
| 11-23 11:02:46 | Gitee v0.2.3 release 创建（补建镜像，资产 `353d5626`） | `.agents/verify/tmp/gitee-prune/rel/kore-plugin-firewall.json` + 资产下载回读 |
| **11-23 12:38:30** | **`3325ce7` chore(deps): pluginapi v0.1.2（root_actions schema 自检）——`go.mod` v0.1.1→v0.1.2、`go.sum`、新增 `rootactions_schema_test.go`；`info.json` 版本仍是 0.2.3** | `git show --stat 3325ce7` |
| **11-23 13:28** | 在该树上执行 `make dist` → **覆盖写出 `dist/firewall-0.2.3.tar.gz` = `9c637faa`**，并把工作区 `info.json` 的 `size_bytes` 从 2808092 改写成 2808490（未提交） | dist mtime + 包内 `info.json` 差异 + 复现 |
| 11-23 13:30:08 | `b47196b` pluginapi v0.1.3 | `git log` |
| 11-23 13:35:27 | `20bbf49` bump v0.2.4 并重打包（此时才合规：版本已换，`dist/firewall-0.2.4.tar.gz` = `983468d4`）；工作区 `info.json` 被重写为 2831225，野值 2808490 被覆盖，**从未进过 git** | `git log -S'2808490' -- info.json` 零命中 |

### 2.2 字节级复现（决定性证据）

在 `/tmp` 用 `git archive` 干净导出两棵树，各自 `make dist`（该仓 dist 声明位级可复现）：

```text
tag v0.2.3   → build 后打包 → 353d5626453276…c651b  size_bytes=2808092 实际=2808093
3325ce7      → build 后打包 → 9c637faa1013b6…3df753  size_bytes=2808490 实际=2808488
```

两个 sha **分别与已发布资产、本地 dist 完全相同**。结论：13:28 那次重建的输入就是 `3325ce7` 的树（不是 13:30 的 v0.1.3）。

> **修正一条既有结论**：`round5-global-acceptance.md` §2 写「13:28 被重建（deps 升到 pluginapi v0.1.3）」。13:28 < 13:30（v0.1.3 提交时间），且按 v0.1.3 树打包不会得到 `9c637faa`——实际是 **v0.1.2**。

### 2.3 谁做的

- 该仓全部提交作者/提交者均为 `pengtang1024`，且**无 `[agent:*]` 前缀**（与 `kore` 仓不同），`.agents/LOG/DISPATCH.md` 在 13:2x 无 firewall 派发记录。
- 13:28 的动作**没有留下任何提交**（唯一痕迹是 dist 文件与工作区 `info.json` 的野值 `size_bytes`）。
- 因此：能从 git 归因到「在 `3325ce7` 树上跑了一次 `make dist`」这个动作，**无法归因到具体 agent/人**；可确定的只有它没走发版清单（§2.1 第 4 步要求只提交 `info.json`/`manifest.json`/`CHANGELOG.md`，而这里连提交都没有）。

### 2.4 改了什么

| 层 | 变化 |
| --- | --- |
| firewall 源码 | **未变**（`git diff --stat v0.2.3 3325ce7` 只有 `go.mod` / `go.sum` / 新增测试文件） |
| 依赖 | `pkg/pluginapi` v0.1.1 → v0.1.2：新增 `rootaction.go`（本插件未引用，插件用的是自己的 `internal/fwop.RootActionFunc`）、`errors.go` 增 `E_NEED_ROOT` / `E_NO_SYSTEMD` 两个常量、SDK 测试 |
| 包内容 | `bin/firewall` 同尺寸 6729890 B 但字节不同（`go version -m` 显示 dep 由 v0.1.1 @ `h1:+JsGwNc…` 改为 v0.1.2 @ `h1:AaRO58…`，构建元数据/动作 ID 随之变化）；包内 `info.json` 仅 `size_bytes` 差 398 |

## 3. 影响判断

1. **已发布的 v0.2.3 内容**：`tag v0.2.3` 的源码（pluginapi v0.1.1），即 06:52 那次 bump 的树本身——**发布物与 tag 自洽，不是"发错版本"，也不是"发布后又改了源码却挂着旧版本号"**。12:38 的依赖升级没有进入 0.2.3，而是在 0.2.4 起承载（v0.1.3 + 后续 0.2.5/0.2.6），没有功能漏发。
2. **按本地 dist 核对索引会不会发现不一致**：会，且**已经发生过**——`round5-global-acceptance.md` §2 的 `SHA_DIFF firewall 0.2.3 local=9c637faa… index=353d5626…` 就是这么来的。这是"本地野产物污染核对口径"的实证。
3. **索引里 v0.2.3 的 sha**：`353d5626…c651b`（`size_bytes` 2808093，见 `154a90a` 的 `index/plugins.json`；其后 `f586c0e` 把 URL 统一到 `kore-pl`，`0981fbc` 升到 0.2.4）。`git log -S'9c637faa'` 在索引仓**零命中** → 索引从未记录野产物。
4. **商店会不会装不上**：不会。当时 `round3-closeout.md` 记录 `POST /store/install {"id":"firewall","version":"0.2.3"}` → 200；今天索引指向 0.2.6，`sha256 == GitHub digest == Gitee 资产 == 本地 dist`。
5. **同类问题扫描**（本次补做）：24 个插件仓逐一比对「本地 `dist/<id>-<索引版本>.tar.gz` sha vs 索引 sha」→ **24/24 一致，0 mismatch**。野产物只剩 `dist/firewall-0.2.3.tar.gz` 这一个孤儿。

## 4. 处置建议（选路径 A）

### 采纳：A. 发布物正确、本地是野产物

1. **清理**（下一张卡执行，本卡不动）：删除 `kore-plugin-firewall/dist/firewall-0.2.3.tar.gz` 与 `.sha256`。判据不是"旧版本就删"——`0.2.0/0.2.1/0.2.2/0.2.4` 的 sha 都与 GitHub 已发布资产一致，只有 0.2.3 这一份没有任何发布物对应。
2. **加检查**（真正的缺口）：`kore-plugins/scripts/validate-index.sh` 只校验索引内部（schema / sha 格式 / `versions.lock` 账本），**看不到本地 dist**，所以野产物能活 11 小时并污染一轮验收。建议在 `make store-check` 增加一段只读检查：`dist/<id>-<index.version>.tar.gz` 存在时其 sha 必须等于索引 sha，不等则 **WARN**（dist 是本地产物、不是发布物，不阻断），输出形如 `DIST_SHA_DIFF firewall 0.2.3 local=… index=…`。
3. **补口径**（低成本防复发）：`docs/RELEASE.md` §1 表格已写"任何改变 dist 包 sha 的改动必须 bump"，但没点明 **`go.mod`/`go.sum` 依赖升级也算**，也没警告"`make dist` 会改写工作区 `info.json.size_bytes`，别把它当'没改代码'"。建议在 §2 清单第 2 步后补一行硬提示，并在 §2.1 冻结窗口条目里加"发版窗口前先 `make dist` 自检，有未提交的 `info.json` 变更先回退"。

### 不采纳（写明理由）

- **B. 修索引或重新发布 0.2.3**：索引本来就是 `353d5626`，发布物也是它。改索引等于把正确的记录改成错的，并人为制造"同版本两个 sha"的第二现场。若真要重发，同一版本也不能挂第二个 sha，只能发新版本号——那就变成 C。
- **C. 发 v0.2.7 承载"漏发改动"**：`3325ce7` 的改动（SDK v0.1.2 + schema 自检）已被 0.2.4 的 v0.1.3 覆盖，且 0.2.5/0.2.6 已发布并索引在案；firewall 源码在 0.2.3 与 `3325ce7` 之间无差异，**没有功能需要新版本承载**。

## 5. 复跑命令（全部只读）

```bash
cd /home/pt/Work/GolandProjects
# 三端资产 sha（Gitea 无 dist 资产，预期 404）
curl -sSL -o /tmp/gh-023.tgz https://github.com/kore-pl/kore-plugin-firewall/releases/download/v0.2.3/firewall-0.2.3.tar.gz && sha256sum /tmp/gh-023.tgz
curl -sSL -o /tmp/gitee-023.tgz https://gitee.com/pengtang1024/kore-plugin-firewall/releases/download/v0.2.3/firewall-0.2.3.tar.gz && sha256sum /tmp/gitee-023.tgz
curl -s -o /dev/null -w '%{http_code}\n' https://gitea.iouf.cn/kore-pl/kore-plugin-firewall/releases/download/v0.2.3/firewall-0.2.3.tar.gz
# 本地
sha256sum kore-plugin-firewall/dist/firewall-0.2.3.tar.gz
# 字节级复现（两棵树各打包一次，不改仓库）
cd kore-plugin-firewall
for r in v0.2.3 3325ce7; do d=/tmp/repro-$(echo $r|tr -d .); rm -rf $d; mkdir -p $d; git archive $r | tar -x -C $d; (cd $d && make dist >/dev/null && sha256sum dist/firewall-0.2.3.tar.gz); done
# 索引历史里 0.2.3 的 sha 与野产物是否出现过
cd ../kore-plugins && git show 154a90a:index/plugins.json | grep -A4 '"id": "firewall"' | grep -E 'version|sha256'
git log --oneline -S'9c637faa' -- index/plugins.json
# 24 仓 dist vs 索引（本卡实测 24/24 一致）
```

## 6. 未做 / 未验证

- 未删除、未移动任何 `dist/` 产物；未改索引、未重签、未重打包、未动 tag 与 release（遵守本卡约束）。
- Gitee API 匿名调用返回 **403 Rate Limit**，Gitee 侧 sha 取"实际下载回读"这条更强路径；其 release 创建时间取本地缓存元数据（`.agents/verify/tmp/gitee-prune/rel/kore-plugin-firewall.json`，与 `gitee-release-fill-latest5.md` 记录一致）。
- Gitea release 的**资产列表**无法通过匿名 API 读取（`releases` → `[]`、`releases/tags/v0.2.3` → 404），结论"无 dist 资产"由 release 页面 Only Source Code + 下载 URL 404 两路互证；未用任何 token 提升权限。
- 未对 `make store-check` / `validate-index.sh` 做改动建议之外的实现（属另一张卡）。
