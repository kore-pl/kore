> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: lead · 关联: ../REPOS.md

# ADR-0011: `pkg/pluginapi` 作为仓库内嵌套 module，独立版本线

## 背景

红队 F-10 指出了一个真实死锁：插件仓库需要 `require` 内核模块才能编译，但内核的第一个 tag 要到 M1 收尾才打。在干净目录、无 `replace`、无 `go.work` 的情况下，插件**根本无法构建**——`go get github.com/pengtang1024/kore` 取不到任何版本。

于是"跨仓库依赖已验证"只有两种结局：靠本地 `replace` 假装成立（换一台干净的 CI 就崩），或永远推迟到内核 tag 之后（M1 的验收标准形同虚设）。两种都是自欺。根因不是"tag 打晚了"，而是**把整个内核当成了插件的依赖**。

## 决策

**`pkg/pluginapi` 在 kore 仓库内作为独立 Go module**：

- module 路径 `github.com/pengtang1024/kore/pkg/pluginapi`，独立 `go.mod`、独立版本线；
- tag 形如 `pkg/pluginapi/v0.1.0`（子目录 tag），因此 SDK 可以**先于内核发版**；
- 插件仓库只依赖该 module，不依赖整个 kore 仓库。**两类 `replace` 语义不同，必须分开处理**：
  - **同仓库嵌套 module（必须提交）**：kore 根 `go.mod` 写 `require github.com/pengtang1024/kore/pkg/pluginapi v0.1.0` + `replace github.com/pengtang1024/kore/pkg/pluginapi => ./pkg/pluginapi`。这是 Go 对同仓嵌套 module 的标准做法，不是作弊——CI 与干净克隆都依赖它，**这条 replace 随仓库提交**。
  - **跨仓库联调（禁止提交）**：插件仓库临时写 `replace github.com/pengtang1024/kore/pkg/pluginapi => ../kore/pkg/pluginapi`，**只能出现在 `go.work` 里，不得提交**；验收必须在无 `go.work`、无跨仓库 `replace` 的干净目录跑（G-17 的 grep 只拦这一类）。
- `go.work` 仅用于本地联调，**不提交**；CI 必须能在无 `go.work` 的干净环境完成构建；
- 破坏性改动同时升 SDK 主版本与 kore 主版本，并留 ADR（G-14）。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| 插件依赖整个 kore 仓库 | 无需额外模块，`go get` 一条命令 | 内核源码全进插件依赖树；内核 tag 未打时插件无法构建（F-10 死锁） | 依赖树污染 + 发布顺序死锁 |
| 协议类型复制到每个插件仓库 | 零依赖，插件可立即构建 | 协议漂移无人发现，帧结构各写一份 | 与 R2"公开协议、破坏性改动走 ADR"直接矛盾 |
| 协议单独建一个仓库 | 边界最干净，版本线最独立 | 多一个仓库要管（版本、CI、权限、变更集），与"kore 一仓"的用户约束冲突 | 增加运维面而收益与方案④重叠 |
| 仓库内嵌套 module + 子目录 tag（选） | SDK 可先于内核发版；插件依赖树最小；协议可独立演进 | 一个仓库两个 module，构建与 CI 要区分 | 选它：零新增仓库，同时解开 tag 死锁 |

## 后果

**正面**：SDK 可以先发 `pkg/pluginapi/v0.1.0`，插件仓库在 M1 就能真正 `go build`；插件的 `go list -m all` 只有 SDK 一行，看不到内核源码；协议版本线独立，内核升 minor 不必带动插件重发；红队 F-10 的死锁被结构性消除，而不是靠 `replace` 绕过。

**负面**：一个仓库两个 module，CI 必须区分"内核构建"与"SDK 发布"两条路径；`pkg/pluginapi` 的破坏性变更要同时升 SDK 主版本与 kore 主版本，版本矩阵多一维；子目录 tag 在部分工具链（旧版 Go、某些 CI 插件）上支持不完整。

**技术债**：两类 replace 语义不同——**同仓库 replace 提交、跨仓库 replace 禁止提交**，G-17 的 grep 只拦后者；子目录 tag 的发布脚本必须写对（`git tag pkg/pluginapi/vX.Y.Z`，不是 `vX.Y.Z`），否则 `go get` 路径静默取不到；`go.work` 不进仓库的约束要靠 CI 校验（否则本地能过、远端就红）；SDK 的兼容性测试要进 kore 的 CI，否则"独立版本线"会退化成"没人管的第二套代码"。

## 验证方式

```bash
# 干净环境：无 go.work、无 replace、无同级 kore 检出
cd $(mktemp -d) && git clone git@github.com:pengtang1024/kore-plugin-echo.git echo
cd echo && go mod download && make dist && ls dist/*.tar.gz
go list -m all | grep 'kore'          # 只应出现 github.com/pengtang1024/kore/pkg/pluginapi
go list -m all | grep -c 'pengtang1024/kore$'   # 期望 0（未依赖整个内核）
# 版本线可见
cd /path/to/kore && git tag -l 'pkg/pluginapi/*'
# SDK 自身可独立构建与测试
cd pkg/pluginapi && go build ./... && go test -timeout 200s ./...
```

## 复审条件

SDK 变更频率远高于内核（每季度 > 3 次破坏性改动）→ 考虑把 SDK 独立成仓库并开新 ADR；Go 工具链对嵌套 module 的发布支持变差（子目录 tag 无法被 `go get` 识别）→ 回退到"协议单独建仓库"；插件仓库普遍出现 `replace` 或 `go.work` 才能构建 → 说明 SDK 版本线未真正可用，需重审发布流程。
