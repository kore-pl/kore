# hands-r51-p1-fix · 真实上手演练 3 个 P1 卡点修复验证报告

> 元信息：2026-11-28 16:05–16:20 +08:00 · owner 实现者 `hands-p1-fix`（verifier 另派，G-09）· 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore` · 基线 HEAD `58d8dfac5394bb7b39bf930434fc571ba785c830`（round51 真实上手报告 `.agents/verify/hands-on-r51.md`）· 只 commit 不 push/tag/Release。

## 0. 摘要：3 个 P1 全部有修复 + 有证据，无 P0

| 卡点 | 根因复核 | 修法 | 验证结论 |
| --- | --- | --- | --- |
| P1-1 备份页作业表头 TypeError | `web/backups.js` 的 `add(parent,child)` 直接 `parent.appendChild(child)`；`paintJobs` 把**字符串** `'thead'` 传进去 → 浏览器抛 `TypeError: Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'`（堆栈 `add:57 → paintJobs:745`）。同文件另两处 `:244/:898` 已是正确写法，只有 `:745` 漏改。 | 改为 `add(table, el('thead'))`（创建真实 DOM 节点），并加两行根因注释。 | 真实 Chromium 浏览器探针：修复后零 pageerror、thead 七列 + 1 行作业正确渲染；注入旧代码的阴性对照复现原 TypeError。 |
| P1-2 API 装完不启用 + 语义不一 | `installer/record.go:134-136` 首次安装 `desired=disabled` 是设计（"装而不用"场景），UI 路径 `web/store.js:1111 autoEnableAfterInstall` 才额外调 enable；API 直连无此步，装完 invoke 全 409，响应无任何"还需启用"线索。读码未发现"API 必须自动启用"的明确契约——`docs/CORE.md:127/142` 只说 reloadOne 按 desired 拉起，不改默认行为。 | **最小改动**：保留"只装不启"默认行为，成功响应新增 `enabled`（读 `Backend.Plugin` 真实态）+ `hint`（未启用时白话指「软件商店 → 插件管理」，不暴露内部 API 动词）。`docs/CORE.md` 同步明确语义。 | httptest 隔离实例 `TestStoreInstallReportsNotEnabled` / `...Enabled` 全绿：响应含 `enabled`/白话 hint、无内部 API 路径、不自动调 Enable。 |
| P1-3 错误文案甩内部 API | `cmd/kored/serve_daemon_actions.go:101` 直接把 `POST /api/v1/plugins/<id>/enable` 拼进 `message`，而 `web/app.js:217` 把 `hint/detail` 原文展示给用户 → 小白看到开发用命令。 | message 改白话「插件「<id>」尚未启用，请在「软件商店 → 插件管理」里启用后重试」；内部 API 路径只写服务端 `slog.Info`，不进 message / detail。 | `TestInvokeNotEnabledConflict` 真 daemon 端到端断言 message 含白话锚点且 `POST` / `/api/v1/` / `/enable` 零泄漏；源码 grep 确认路径只在日志行。 |

## 1. 改动清单（精确写域，无越界）

| 文件 | 改动 |
| --- | --- |
| `web/backups.js` | `:745` `add(table, 'thead')` → `add(table, el('thead'))` + 根因注释（纯逻辑修复，未改任何 CSS / DOM 布局 / 文案尺寸） |
| `cmd/kored/serve_daemon_actions.go` | `Invoke` 未启用分支：白话 message + 服务端日志记录内部 API 路径 |
| `cmd/kored/serve_daemon_test.go` | `TestInvokeNotEnabledConflict` 增强：白话锚点 + 内部 API 零泄漏断言 |
| `internal/core/httpapi/handlers_store.go` | `storeInstallResponse` 加 `enabled` + `hint`；`installEnabledState` 读真实启用态（查失败按 false，只 WARN 不破坏 200）；`handleStoreInstall` 填字段 |
| `internal/core/httpapi/store_install_state_test.go`（新增） | `TestStoreInstallReportsNotEnabled` / `TestStoreInstallReportsEnabled` |
| `docs/CORE.md` | store/install 段补"安装≠启用"语义 + `enabled`/`hint` 字段口径；版本基线 0.1.4 → 0.1.5 |
| `CHANGELOG.md` | 新增 `[0.1.5] - 2026-11-28` fix 条目（三个 P1 逐条记，明确不夸大） |
| `Makefile` / `cmd/kored/main.go` | VERSION 0.1.4 → 0.1.5（fix→patch；0.1.5 < 0.2.0 仍在 24 仓 `requires_kore` 上界内） |

**写域声明**：以上均在任务卡写域（kore/web/backups.js、kore/cmd/kored/serve_daemon_actions.go、相关 _test.go、必要文档口径、本报告）内。未碰其它仓 / 8787 / `.kore-local-*` / 宿主 `bin/kored` / `scripts/usability-pending.txt`（该文件在工作树开工前已有他人 dirty，本次原样保留，未纳入我的提交）。临时 harness 写在 `/home/pt/Work/GolandProjects/kore-pl/.tmp/h51-p1-fix/`（工作区内，提交前删除）。

## 2. P1-1 浏览器证据（真实 Chromium，非空 backup.jobs）

工具：本机缓存 `chromium_headless_shell-1248` + `pw-runner` 的 playwright-core（`/home/pt/.cache/pw-runner/node_modules/playwright-core`），真实浏览器加载**当前工作区的 `web/backups.js`**，本地 HTTP 页 + stub `fetch`（`backup.jobs` 返回 1 条 succeeded 作业，其余返回空/成功），`page.on('pageerror')` + `window.addEventListener('error')` 双捕获，`window.KoreBackup.render(host)` 真执行 `paintJobs`。

```
$ cd /home/pt/Work/GolandProjects/kore-pl/.tmp/h51-p1-fix && node probe.mjs
{
  "ok": true,
  "result": {
    "hasTable": true, "hasThead": true,
    "headers": ["状态","名称","维度","开始时间","条目","大小","错误"],
    "rowCount": 1, "pageErrors": []
  },
  "pageErrors": []
}
PROBE_EXIT=0
```

**阴性对照**（同 harness，注入旧问题行 `add(table, 'thead') || ...`）：

```
$ OLD_BUG=1 node probe.mjs
{
  "ok": false,
  "result": { "hasTable": true, "hasThead": false, "headers": [], "rowCount": 0, "pageErrors": [] },
  "pageErrors": ["TypeError: Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.\n    at add (<anonymous>:57:40)\n    at paintJobs (<anonymous>:747:19)"]
}
NEG_CONTROL_ok=false   （按 harness 约定退出 0 = 阴性对照按预期复现）
```

对照证明 harness 能抓到原缺陷：旧代码复现与 hands-on-r51 报告**逐字一致**的 TypeError 与堆栈，修复后同一 harness 零错误、表头与行正确渲染。G-28：本次是**纯逻辑 bug 修复**，未改视觉布局 / CSS / 组件尺寸 / 新文案尺寸（仅代码注释 + `el('thead')` 节点创建），因此**不触发双端截图 + 三问门槛**；浏览器 DOM 断言仅作逻辑验证，不冒充截图证据。

## 3. P1-2 / P1-3 Go 测试证据（隔离 in-process HTTP，真实 daemon）

统一缓存口径（本机默认 GOCACHE 为只读 FS，所有 Go 命令显式使用工作区可写缓存，不影响源码/宿主）：

```
GOCACHE=<repo>/.tmp/gocache-h51 GOMODCACHE=<repo>/.tmp/gomodcache GOWORK=off GOPROXY=off GOSUMDB=off
```

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `go test -count=1 -timeout 200s ./internal/core/httpapi/ -run TestStoreInstall` | **0** | `ok github.com/pengtang1024/kore/internal/core/httpapi 0.007s`（含新增 2 条 + 原有 validation/refresh/force/download 全部绿） |
| `go test -count=1 -timeout 200s ./cmd/kored/ -run TestInvokeNotEnabledConflict` | **0** | `ok github.com/pengtang1024/kore/cmd/kored 0.286s`（真 daemon + UDS HTTP：409 E_CONFLICT、message 白话锚点、内部 API 零泄漏） |
| `go test -count=1 -timeout 200s ./internal/core/httpapi/ ./cmd/kored/` | **0** | 两包全量绿（6.758s / 9.093s），无回归 |
| `go vet ./internal/core/httpapi/ ./cmd/kored/` | **0** | 无输出 |
| `gofmt -l`（5 个改动 Go 文件） | **0** | 无输出（格式合规） |

`TestStoreInstallReportsNotEnabled` 断言：默认禁用插件响应 `enabled=false`、hint 含「软件商店」+「启用」、hint 不含 `POST` / `/api/v1/` / `/enable`、后端 `Enable` 调用日志为空（默认行为未变）；`...Enabled` 断言已启用插件 `enabled=true` 且无多余 hint。`TestInvokeNotEnabledConflict` 断言 message 含白话锚点、message/detail 均不含内部 API 动词。

## 4. 门禁结果（无新增 FAIL）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --check web/backups.js` | **0** | 无输出（语法通过） |
| `make version-check` | **0** | `[OK] 内核 VERSION=0.1.5 覆盖 24 个插件，全部落在 requires_kore 区间内` |
| `make docs-check` | **0** | `5 pass, 1 warn, 0 fail`（warn 为仓库存量 docs 行数越界，非本次引入） |
| `make secret-check` | **0** | `0 FAIL / 35 处匹配（占位写法 / grep 正则模式均合规，1 WARN）`；本报告无明文凭据 |
| `make frontend` | **0** | `[OK] 首屏体积达标：91092 字节 ≤ 307200 字节`；i18n 增量达标（首屏 WARN 为存量漂移，非本次引入） |
| `bash scripts/usability-check.sh`（带可写 Go 缓存） | **1** | **唯一 FAIL 为兄弟仓 `kore-plugin-waf` 的 `tests/e2e` 真跑失败（`A1 waf: ZeroParam 真跑失败`），在本任务写域之外、与本次改动无关；kore 仓本身无新增 G-33 违规**。未修改 `scripts/usability-pending.txt` 去掩盖它（该文件开工前已有他人 dirty，原样保留）。 |

诚实声明：未跑 `make check` 全量（21 段含跨仓 24 仓门禁 + 交叉编译 + race，耗时且会混入他人在途 dirty 的兄弟仓状态）；按任务卡要求只跑关键段（frontend/docs-check/secret-check/usability）+ 受影响 Go 包全量测试 + version-check，全部在本写域内可判定。全量门禁由 lead / verifier 在干净树上统一执行。

## 5. 版本判定

fix→patch，0.1.4 → 0.1.5：`Makefile:29 VERSION`、`cmd/kored/main.go:17 version`、`docs/CORE.md` 版本基线三处同步；`make version-check` 实测 24 仓全绿（0.1.5 < 0.2.0 上界）。`CHANGELOG.md` 新增 0.1.5 条目，逐条记三个 P1 的动机、修法与诚实边界（不宣称超越竞品）。

## 6. 收尾

- 临时 harness：`.tmp/h51-p1-fix/`（probe.mjs / usability.out / gocache）在提交前随工作区临时资产清理；不进 git。
- 未联网业务、未覆盖宿主 `bin/kored`、未请求 8787、未改 `.kore-local-*`、未 push / tag / 建 Release。
- 提交：精确 `git add`（本表 10 个文件，不含 `scripts/usability-pending.txt` 与他人 dirty），`git commit -s -m "[agent:hands-p1-fix] fix: ..."`，只 commit。
