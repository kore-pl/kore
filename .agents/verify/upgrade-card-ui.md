# 升级内核卡片 · G-28 双端验收（`3ce2af1`）

> 结论：**①②③ 三项里 ②③ 达成，① 未达成**。① 的「当前版本 / sha256 / 可回滚目标」在本提交上读不到——`/api/v1/system/upgrade` 返回 501 `E_UNSUPPORTED`（装配层没把 `selfUpdater` 暴露给 HTTP，根因见 §5）。按 G-28「缺任一项不得声明完成」，本卡记 **BLOCKED（部分达成）**，不以别的图凑数。

## 1. 环境（隔离实例；主实例零写入）

| 项 | 值 |
| --- | --- |
| 监听 | `127.0.0.1:18787`（`ss -ltn` 选空闲端口；主实例 8787 未被占用/未重启） |
| 配置 | `/tmp/upgrade-ui/config.yaml`（独立 `--config`） |
| 状态 / 运行 / 日志 | `/tmp/upgrade-ui/{state,run,log}`（全落 `/tmp`，不碰 `.kore-local-state`） |
| 索引 | **只读**指向 `kore-plugins/index`（与主实例同源、无写入） |
| 二进制 | 由 HEAD（`3ce2af1` 之后工作树）现构建：`sha256 499a411454643eb2708a435fa5b21b1d40470fb8ed33c8c78b86bfe63855ac07` |
| 可回滚目标 | 同二进制预先复制为 `/tmp/upgrade-ui/kored.prev`（用于触发 `.prev` 探测） |
| 口令 | `kored admin-password --generate`（明文只在 `/tmp` 生命周期内存在，未入库：`***`） |
| 进程身份 | **uid 1000 非 root**（沙箱非 root，见 §7） |
| 截图工具链 | 裸 CDP + `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（**显式 executablePath**，Chrome for Testing 156.0.8078.4，`--headless=new`） |

主实例声明：本轮**未改动**主实例运行态配置（`.kore-local.yaml` / state / `bin/kored` 均未写），只 `curl /-/healthz` 做过只读探活；8787 的 pid 变化来自并行轨道的重启（22:36:51），非本卡操作。

## 2. 复现命令

```bash
mkdir -p /tmp/upgrade-ui/{state,run,log,prof}
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/upgrade-ui/kored ./cmd/kored
cp /tmp/upgrade-ui/kored /tmp/upgrade-ui/kored.prev      # 造「可回滚目标」
/tmp/upgrade-ui/kored admin-password --generate --config /tmp/upgrade-ui/config.yaml
/tmp/upgrade-ui/kored serve --config /tmp/upgrade-ui/config.yaml &   # 18787
~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome --headless=new \
  --no-sandbox --remote-debugging-port=9411 --user-data-dir=/tmp/upgrade-ui/prof about:blank &
node /tmp/upgrade-ui/cdp-shot.mjs 9411 18787 /tmp/upgrade-ui/shots /tmp/upgrade-ui/password
```

截图脚本走真实链路：登录页口令登录 → `#/settings` → 等卡片 `GET /system/upgrade` 落定 → `Emulation.setDeviceMetricsOverride` → `Page.getLayoutMetrics` 取 `cssContentSize` → `Page.captureScreenshot`（full-page，dsf=1）。

## 3. 截图清单（`file` 实测宽高）

| 文件 | 实测 | 内容 |
| --- | --- | --- |
| `screenshots/upgrade-card-initial-desktop.png` | **1440 × 1676** | 设置 →「升级内核」初始态（PC full-page） |
| `screenshots/upgrade-card-initial-mobile.png` | **390 × 2403** | 同场景 390 宽（full-page，纵向堆叠） |
| `screenshots/upgrade-card-confirm-desktop.png` | **1440 × 1676** | ② 确认态：来源路径 + 64 位期望 sha + 已勾选「我了解升级会重启内核」 |
| `screenshots/upgrade-card-confirm-mobile.png` | **390 × 2403** | 同场景 390 宽 |
| `screenshots/upgrade-card-error-desktop.png` | **1440 × 1721** | ③ 真实错误反馈：`E_UNSUPPORTED：当前装配不支持内核自升级`（红框） |
| `screenshots/upgrade-card-error-mobile.png` | **390 × 2449** | 同场景 390 宽 |

PC 视图 1440 宽、手机视图 390 宽；高度为 full-page 实际内容高度（`file` 已逐张复核，非同图缩放）。

## 4. 三场景结论

| # | 要求 | 结论 | 证据 |
| --- | --- | --- | --- |
| ① | 初始态：当前版本 / sha / 可回滚目标 | **未达成** | 卡片真实文案「升级状态读取失败，请刷新重试」；`curl -i /api/v1/system/upgrade` → `501 {"code":"E_UNSUPPORTED","message":"当前装配不支持内核自升级"}`；`.prev` 已就位也读不出来 |
| ② | 确认态（确认前/后或填写后） | **达成** | 填 `/tmp/upgrade-ui/kored-head` + `aaaa…`(64) + 勾选；DOM 状态 `checked=true`，两按钮仍按状态禁用（`goDisabled=true`、`rollbackDisabled=true`） |
| ③ | 真实结果/错误反馈 | **达成（但码不是示例里的那两种）** | 勾选后强制启用按钮点击（页面 JS 层操作，不改代码），POST 真实返回 → 卡片渲染 `E_UNSUPPORTED：当前装配不支持内核自升级`，`class="settings-hint settings-hint-error"` |

③ 说明：请求在**类型断言处**就被拦下，根本进不到 `selfUpdater`，因此拿不到 `E_CONFLICT`（sha 不符）或 `E_NEED_ROOT`（非 root）。这两个码要等 §5 的装配断点修好才能验；**不拿别的图凑**。

## 5. 根因：装配层未把 `selfUpdater` 暴露给 HTTP（本卡不改代码，只记录）

- `cmd/kored/serve_runtime.go:151` 把实现写进 daemon 字段：`svc.backend.selfUpdate = newSelfUpdater(db, app, cfg)`；
- 但 `*daemon` **没有**向 `httpapi.SelfUpdater` 暴露四个方法（`UpgradeStatus` / `StartUpgrade` / `StartRollback` / `UpgradeJob`），`selfUpdate` 字段只写不读：
  `grep -rn "selfUpdate" cmd/kored/*.go | grep -v _test` → 仅 `serve_daemon.go:44`（声明）+ `serve_runtime.go:151`（赋值）；
- `cmd/kored/serve_boot.go:75` 把 `svc.backend` 传给 `httpapi.Options.Backend`，`internal/core/httpapi/selfupdate.go:150` 的 `Backend.(SelfUpdater)` 断言失败 → 四个 upgrade 端点**全部 501**；
- 单测为什么没抓到：`go test ./cmd/kored -run TestSelfUpdater -count=1` → `ok`（只测 `selfUpdater` 本体），`internal/core/httpapi/selfupdate_test.go` 用**假 backend**，没有覆盖真实装配断言。
- 修复方向（供派发参考，本卡未动手）：给 `*daemon` 补四个转发方法（nil 时返回明确错误），或让 `serve_boot` 直接把 `selfUpdater` 当 Backend；配套一条「装配后 GET 不是 501」的测试。

## 6. 产品定位自评三问（G-28 ③）

**① 本页解决什么用户问题？**
把「升级内核二进制」从终端搬到面板：运维不用 SSH 进城、不用记 `kored upgrade --bin … --sha256 …`；重点是**可控**——来源只认本机绝对路径（不下载 URL）、sha256 先校验后替换（不符零改动）、失败可 `.prev` 回滚、动作进审计且审计写不进去就不开始。当前实现下这是**设计目标**，不是现状（§5 断点 + 非 root 不可用）。

**② 与宝塔、1Panel 的同类功能差距？**
- 宝塔：面板内「一键更新」拉官方源，用户只管点；不给你期望 sha、不给回滚。
- 1Panel：随应用商店升级面板自身，同样是「信官方源」模式。
- Kore 的路子更像「受控运维动作」：本地文件 + 期望 sha + 原子替换 + `.prev` 回滚 + fail-closed 审计，适合「离线/内网/自签」场景。
- 差距：① 无内置下载与签名源（用户得先把二进制传上去）；② 无升级前快照/自动回滚（只有 `.prev` 一档）；③ 进度只有 job 文案，没有阶段进度条；④ 版本/sha/回滚目标这些「读」信息在当前提交上直接 501。

**③ 当前「可用」还是「占位」？**
**占位（接线未通）**。UI 168 行是完整的（表单、二次确认、job 轮询、错误码渲染、回滚二次确认都在），但后端拿不到实现，任何操作都 501；因此「读当前版本/sha/回滚目标」这条最基本的链路也不通。**UI 完成度 ≠ 可用**。

## 7. 边界（硬约束，不得跳过）

- 沙箱 **非 root**（uid 1000）：即使端点接通，`can_upgrade=false`，真实替换、重启、回滚在本机都跑不了。
- **systemd 重启链路未验证**：替换后重启（`E_UPGRADE_RESTART`）、新版本生效标记（`pending → success`）、`.prev` 回滚、重启后 `upgrade-result.json` 复核，**全部未跑**。
- 本组截图只证明：**UI 渲染 + 表单交互 + 「POST → 错误码 → 卡片渲染」这条接线**；**不证明**重启链路已通。
- ① 的版本/sha/回滚目标**没有**截到（501），已在 §4 写明原因，未用其他图替代。

## 8. 清理与门禁

- 隔离实例已 `kill`（pid 1169510）；Chromium 已退出；`ss -ltn` 复核：`18787/9411 released`（清理后实测输出）。
- `/tmp/upgrade-ui` 整目录已删除（配置、state、口令、profile、截图源均不残留）。
- 主实例 `curl /-/healthz` → `200`；本轮未写主实例运行态配置。
- 未改任何代码（`git status` 中本卡只新增本文件 + 6 张截图 + DISPATCH 一行）。
