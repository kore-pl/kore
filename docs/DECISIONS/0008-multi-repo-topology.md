> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: lead · 关联: ../REPOS.md

# ADR-0008: 多仓库拓扑（N+2）——内核 / 索引 / 每插件一仓库

## 背景

插件生态需要独立演进。若插件放在 kore 仓库的 `plugins/` 子目录，代价是四重的：插件版本与内核版本耦合（内核打一次 tag 就暗示插件也变了）、第三方无法只更新一个插件而不碰内核、仓库体积与依赖树被插件污染、插件 CI 与内核 CI 抢同一条流水线。同时内核必须向插件暴露协议类型，否则第三方插件只能复制粘贴帧结构，协议一致性无从保证。

## 决策

采用 **N+2 多仓库**：

| 仓库 | 模块路径 | 职责 |
| --- | --- | --- |
| kore | `github.com/pengtang1024/kore` | 内核 + `pkg/pluginapi` 公开协议 SDK |
| kore-plugins | `github.com/pengtang1024/kore-plugins` | 纯静态索引 + 可选市场页；不做人工审核、不代管包、无账号 |
| `kore-plugin-<id>` | `github.com/pengtang1024/kore-plugin-<id>` | 每个插件一仓库；产物 `<id>-<version>.tar.gz` + sha256 |

八条规则：R1 依赖单向（插件 → `pkg/pluginapi`，kore 不 import 任何插件）｜R2 协议包必须公开，破坏性改动 = 主版本 + ADR｜R3 `info.json` 必填 `requires_kore`｜R4 各仓库独立 tag｜R5 `.agents/` 只在 kore｜R6 变更集登记｜R7 各仓库自带 Makefile｜R8 docs-check 只在 kore。

分期：M0 只交付 kore；`kore-plugins` 与 `kore-plugin-echo` 归 M1；site / backup 归 M2。

`pkg/pluginapi` 只放协议类型与帧编解码，不含 supervisor / store / httpapi 等内核实现；它是 kore 唯一的对外 Go API 面，也是唯一允许被插件 import 的包。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| monorepo（`plugins/` 子目录） | 一次提交跨内核与插件改动，联调最省事 | 插件与内核版本耦合；第三方无法只发插件；仓库体积与依赖树被污染 | 与"插件可独立安装、独立发版"直接矛盾 |
| monorepo + Go workspace 多 module | 模块边界清楚，本地联调仍方便 | 仍是单仓库单 CI；review 与发布权限无法按插件隔离；tag 仍绑同一仓库 | 解决了 module 边界，没解决发布与权限边界 |
| git submodule | 目录上看似分离，父仓库可锁定插件版本 | 父仓库锁子仓库 commit：子仓库发版后父仓库必须提交指针，**第三方无法独立发版**；CI 需 recursive clone | 锁 commit 这个特性与"插件独立演进"正好相反 |
| 多仓库 + 公开 SDK 包（选） | 独立 tag / CI / 权限；第三方零门槛；内核只依赖 `pkg/pluginapi` | 版本兼容矩阵、跨仓库联调需要 `go.work` | 选它：把全部耦合点收敛到唯一一个公开包 |

## 后果

**正面**：每个插件独立发版，内核 tag 不再暗示插件变化；CI 按仓库隔离，插件失败不阻塞内核；第三方只需 `go get github.com/pengtang1024/kore/pkg/pluginapi`；索引仓库只是发现渠道，删掉它不影响已安装插件；插件前端在各自仓库构建，不进内核二进制。

**负面**：出现 N×M 兼容矩阵（内核版本 × 插件版本），需要 `requires_kore` 声明与测试覆盖；跨仓库联调要 `go.work` 或 replace，否则只能等 tag；`pkg/pluginapi` 从内部类型升级为公共契约，任何字段改动都要按语义化版本对待，且要考虑已发布插件的兼容窗口。

**技术债**：`requires_kore` 的区间解析器要实现并单测（含 prerelease 与开闭区间语义）；索引仓库需要条目去重、sha256 校验与过期清理；`pkg/pluginapi` 的兼容性测试必须进 CI，否则 R2 只是一句口号；`go.work` 只用于本地联调，禁止提交到任何仓库。

## 验证方式

```bash
# 插件仓库可独立构建、独立打包
cd ../kore-plugin-echo && go build ./... && make dist && ls dist/*.tar.gz
tar -xzOf dist/echo-0.1.0.tar.gz echo-0.1.0/info.json | grep requires_kore
# 内核安装后握手成功
curl -s -X POST 127.0.0.1:8787/api/v1/plugins -F package=@dist/echo-0.1.0.tar.gz
curl -s 127.0.0.1:8787/api/v1/plugins | grep '"id":"echo"'
# 边界证明：改内核 internal 不影响插件仓库编译
touch kore/internal/core/supervisor/supervisor.go && cd ../kore-plugin-echo && go build ./...   # 仍通过
# 依赖单向：内核不含任何插件仓库引用
cd ../kore && grep -rn 'kore-plugin-' internal/ pkg/ && echo "违规：内核引用了插件" || echo "内核未 import 任何插件"
```

## 复审条件

插件仓库数 < 3 且跨仓库变更频繁（一次改动要动 3+ 仓库）时，重新评估把索引与插件合并、或引入 workspace 统一调度；`pkg/pluginapi` 破坏性改动每季度超过 1 次，说明协议设计粒度有问题，应先收敛协议再扩生态。
