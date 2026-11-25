> 状态: done · 归属: feat-integrity-data · 更新: 2026-11-25 · 里程碑: M0–M5
> 功能卡：integrity-data（完整性数据补全：体积变化 / 真实扫描根 / 扫描历史）· 依据 [PLUGIN-MATURITY.md](../../docs/PLUGIN-MATURITY.md) 完整性行 + [AGENTS.md](../../AGENTS.md) G-06/G-28/G-33
> 前序卡：feat-integrity-verify（`240ae7e`，前端工作台）在 §7 挂的三笔账，本卡逐条收掉。

# 完整性：体积变化 · 真实扫描根 · 扫描历史（插件 0.6.0 + 前端消费）

## 1. 依据 + 改造前事实（可用 grep 复现）

| 依据 | 改造前事实（path:line 或命令） |
| --- | --- |
| 前序卡挂账①「逐文件大小变化拿不到」 | `git show HEAD:internal/integrity/methods.go\|grep -c 'old_size\|ScanHistory'` = **0**；`ModifiedEntry`（0.5.1 `methods.go:109-116`）只有 `old_sha256/new_sha256/old_mode/new_mode/changes`，而基线条目其实早存了 `Entry.Size`（`scan.go:32` `newEntry`）——数据在，只是没往响应里送 |
| 前序卡挂账②「baseline.list 不回 Roots」 | `store.go:56` 的 `Baseline.Roots` 有落盘，`BaselineListItem`（0.5.1 `methods.go:66-75`）没有该字段，`BaselineListResult` 也没有；前端只能靠本页 localStorage 记忆 + 定时任务 params 反读 |
| 前序卡挂账③「check 无历史」 | 每个基线只存 `last_check_at / last_check_ok`（`store.go:61-63`）；时间筛选基于本页 ≤20 次内存记录，换浏览器即失忆 |
| 用户可感目标（本卡） | 变更表能看出「文件变大了多少」；概览「扫描范围」是插件真值；「上次扫描」以外还能回看最近若干次扫描 |

## 2. 插件侧（kore-plugin-integrity 0.5.1 → 0.6.0，8 个方法数不变）

1. **`check.modified[]` 加体积三件套**（`internal/integrity/methods.go:128-130`，填充在 `:715-717`）：
   `old_size` / `new_size` / `size_delta`。**纯可加性**：`changes[]` 仍只报 `sha256` / `mode`
   （体积变化不新增第三种判定原因，既有 `changes` 长度断言不受影响）；旧基线也能算——
   `Entry.Size` 自 0.1.0 起就在基线文件里。
2. **`baseline.list` 回 `roots`**：结果级 `roots` = 当前基线扫描根（`methods.go:111,434`）；
   每个版本条目带自己的 `roots`（`store.go:79` `SnapshotMeta.Roots`，随
   `baselines/index.json` 落盘，`metaFromBaseline` 在 `store.go:469` 回填）。
   上界：keep ≤100 × paths ≤256；默认 keep=10 时约 100 KiB 量级。
3. **扫描历史**（新文件 `internal/integrity/history.go`，`<state>/scans.json`）：
   每次 `check` 追加一条汇总（时刻 / 基线 id / 结论 / 新增·修改·删除·未变化·跳过 /
   截断 / 耗时），只保留最近 `MaxScanHistory=20` 次（`history.go:23`），落盘上界约 4 KiB
   ——**只记计数、不记逐文件路径**：明细会让落盘与内存随扫描次数线性膨胀（G-03）。
   该文件是**辅助轨道**：损坏时按空处理、下一次 `check` 覆盖重写（自愈），
   不让一条历史日志把 check/status 拖死；基线与快照索引仍严格 fail-closed。
   `status.scan_history[]` 恒为数组（`methods.go:173-175,585-587`）。
4. 落盘布局、JSON 键名、向后兼容口径同步进 `README.md`（方法表 + `modified[]` +
   状态目录三段）与 `CHANGELOG.md`；`info.json` / `manifest.json` 版本 0.6.0。

## 3. 前端侧（`web/integrity.js`，零新增文件 / 零新依赖 / 零轮询）

| 用户可见变化 | 位置 | 旧版本插件缺字段时的行为 |
| --- | --- | --- |
| 变更表「变化」列显示 `体积 49 B → 1.0 KiB (+1.0 KiB)`（大小没变就不占版面，只改权限的行只显示权限） | `sizeText` `:320` / `changeText` | `old_size` 缺失 → 不显示体积（不是 `0 B`） |
| 概览「扫描范围」用 `baseline.list.roots` 真值，换浏览器也在 | `scanScope` `:344`、`loadBaselines` `:786` | 回退到本页记忆 → 定时任务 params 反读（原口径） |
| 新面板「扫描历史」：最近 20 次扫描的时刻 / 结论 / 四类计数 / 基线，时间同分钟自动补秒 | `paintHistory` `:572` | 回退到本页 localStorage 记录，并在面板顶部写明「插件没有返回扫描历史」 |
| 「看明细」把变更表锁定到某一次扫描（本页没存过那次明细 → 按钮禁用并给出原因，不弹空表） | `runsInRange` `:298`、`paintFilterBar` `:466` | — |
| 基线版本行显示「N 路径」标签（title 列全路径）、恢复弹层多一行「该版本扫描范围」 | `paintBaselines` / `openRestore` | 无 `roots` → 不显示该标签（不猜） |
| CSV 导出加 `原大小 / 现大小 / 大小变化` 三列 | `exportChanges` | 三列为空字符串 |
| 定时扫描的「要扫描的路径」按真实 roots 自动填（用户改过就不覆盖） | `buildScheduleForm` / `loadBaselines` | 回退到本页记忆 / 预设 |

## 4. 门禁命令 + 退出码（本机实跑）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cd kore-plugin-integrity && gofmt -l .` | 0 | 无输出（clean） |
| 同上 `GOCACHE=/tmp/... go vet ./...`（workspace 模式） | 0 | 无输出 |
| 同上 `go test -count=1 -timeout 200s ./...`（workspace 模式） | 0 | `ok` × 4 包（根 + internal/integrity + tests/e2e + tests/fault） |
| 同上 `GOWORK=off go test ./internal/... ./tests/...`（发布版 SDK） | 0 | `ok` × 3 包 |
| 同上 `make check`（GOWORK=off 全量） | **2** | **预存在失败、与本卡无关**：`TestInfoJSONPluginSDKCheck` → `method_capabilities 的键 "integrity.verify_file" 动作段非法`。同一命令在 `git archive HEAD` 干净树上同样 FAIL（`HEAD_GOWORK_OFF_EXIT=1`）：`go.mod` 钉的发布版 `pluginapi v0.1.3` 还是 ADR-0047 之前的字符集，`go.work` 指向的本地 `kore/pkg/pluginapi` 已放宽——属发版滞后，不在本卡写域（见 §7.1） |
| `cd kore && node --check web/integrity.js` | 0 | 无输出 |
| `bash scripts/frontend-check.sh` | 0 | 首屏合计 gzip **81689 B / 307200 B**（余量 225511）；i18n 增量 2940 / 3072。`integrity.js` 是懒加载视图、**不进首屏**；其自身 gzip 19315 → 23036 B（+3721 B，+19%，懒加载路径） |
| `bash scripts/secret-check.sh` | 0 | `0 FAIL / 22 处匹配（占位写法均合规）` |

## 5. 隔离实例真机取证（G-29：主实例 8787 全程未动）

| 项 | 值 |
| --- | --- |
| 实例 | `mktemp -d /tmp/int-iso.XXXXXX`：独立 `--config` + state/run/log 全落 /tmp，端口 18787；跑完 `rm -rf`，脚本已删。全程 `curl localhost:8787/-/healthz` = 200，未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored` |
| 登录 | `kored admin-password --set --stdin --config <tmp>` → `POST /api/v1/auth/login` 成功，`kore_csrf` 进会话 |
| 安装 | `POST /api/v1/store/install {"id":"integrity","version":"0.5.1","package_path":".../dist/integrity-0.5.1.tar.gz"}` → `{"state":"succeeded","message":"安装完成","reload":"reloaded"}`（索引 sha 与本地包逐字一致：`22f9ec48…`）；`POST /api/v1/plugins/integrity/enable` → `desired=enabled, granted_capabilities=[system:read,system:admin]` |
| **0.6.0 落位（如实披露）** | 0.6.0 **未入签名索引**（卡约束：不入索引 / 不重签 / 不发 dist），所以索引链路里没有可安装的 0.6.0。做法：先用上面**真实**安装链路装 0.5.1，再把同一「当前版本目录」`state/plugins/integrity/0.5.1/` 的内容整体替换为本轮 0.6.0 包（info.json / bin / SHA256SUMS），重启实例——与安装器的落位形态一致（目录名 + `current` 符号链接不变）。重启后 `GET /api/v1/plugins` 回报 `"version":"0.6.0"`，即内核按磁盘 manifest 拉起了 0.6.0 二进制 |
| 数据 | `KORE_INTEGRITY_ALLOW_ROOTS=<TMP>/data` 起实例；data 下预置 app.conf（49 B）/ old.conf / keep.conf / access.log（排除规则 `*.log` 生效：基线 3 条） |
| 基线 + 变更 | 建基线 → 改 app.conf 到 1073 B、chmod keep.conf 0600、删 old.conf、加 shell.php → `check` 真实返回 `modified[]`：`old_size 49 / new_size 1073 / size_delta 1024`（app.conf，`changes:["sha256"]`）与 `old_size 8 / new_size 8 / size_delta 0`（keep.conf，`changes:["mode"]`）；`baseline.list.roots = ["<TMP>/data"]`、`baselines[].roots` 同值；`status.scan_history` 一条 `{ok:false, added:1, removed:1, modified:2}` |
| 浏览器 | 真登录态 + 真插件 + 真文件，`pageerror/console.error` = **0 条**；变更表实测文案 `指纹 22fb8f8f → 41268ee1 · 体积 49 B → 1.0 KiB (+1.0 KiB)`；只改权限行 `指纹 2b8425c4 → 2b8425c4 · 权限 0664 → 0600`（无体积噪声）；扫描范围 chip 1 个 = 真实路径；扫描历史 2 行（curl 一次 + 页面「立即扫描」一次）；「看明细」锁定后变更表 4 行、锁定行高亮；桌面/手机 `scrollWidth > clientWidth` 均为 **false**（无横向溢出） |

一次性 Playwright 脚本（`NODE_PATH=<npx playwright 1.65.1 缓存>`，未装新依赖）与隔离实例目录已删除，工作区无残留。

## 6. G-28 双端截图（`identify` 实测宽高）

| 场景 | 文件 | 实测 |
| --- | --- | --- |
| 桌面整页：概览（真 roots chip）+ 变更表体积列 + 扫描历史面板 + 基线版本「1 路径」 | screenshots/integrity-data-desktop-01.png | PNG 1440×2194（full-page） |
| 桌面视口：「看明细」锁定一次扫描后（锁定行高亮 + 取消锁定） | screenshots/integrity-data-desktop-02.png | PNG 1440×900 |
| 手机：概览 + 扫描范围 chip（390×844 视口） | screenshots/integrity-data-mobile-01.png | PNG 390×844 |
| 手机：变更列表堆叠显示体积变化（`体积 49 B → 1.0 KiB (+1.0 KiB)`） | screenshots/integrity-data-mobile-02.png | PNG 390×844 |

## 7. 产品定位自评（G-28 第三问）

- **本页解决什么用户问题**：以前只知道「这个文件被改过」，现在一眼看出「被改大了 1 KiB」——被塞后门的脚本、被追加内容的配置、被截断的二进制，三种情况从体积方向就能分流；扫描范围不再是「本页猜的」，换浏览器、换机器都是插件真值；「上次扫描 12:58，改动 1 增 2 改 1 删」的历史能回看最近 20 次，不必等下一次扫描。
- **与宝塔、1Panel 的差距**：宝塔的文件防篡改只在通知里说「文件被修改」，1Panel 侧靠计划任务脚本自己 diff；两边的变更都**没有体积维度、也不保留扫描历史**（只有一个「上次执行时间」）。本卡把这三样做成面板可见、可筛选、可导出的常规数据，这一块继续**超过**两端现有形态。差距仍在：不做 inotify 实时监听（G-19 禁常驻轮询）、不保存文件内容所以仍不能在本页回滚、`added/removed` 只是路径数组（要带体积属破坏性变更，见 §7.2）。
- **当前「可用」还是「占位」**：**可用**。隔离实例真装 → 真基线 → 真改文件 → 真扫描 → 桌面与手机双端真截图，0 页面错误、0 横向溢出。

## 8. 已知边界与挂账（不虚报）

1. **`make check` 在 `GOWORK=off` 下预存在失败**（§4 已列证据）：发布版 `pluginapi v0.1.3` 未包含 ADR-0047 的下划线放宽，本仓 `info.json` 的 `integrity.verify_file` 声明因此被旧校验拒绝。修法属发版侧（`kore/pkg/pluginapi` 发一个新版本 + 本仓 `go.mod` bump），不在本卡写域；本卡代码在两种 SDK 下都编译并通过全部业务/测试包。
2. **`added` / `removed` 没有体积**：它们是纯 `[]string`，改成结构体会是破坏性契约变更，本轮按卡约束不做；需要时另开一卡（新方法或 v1 协议内的可选字段）。
3. **扫描历史只有汇总计数**：逐文件明细仍由前端按次留存（localStorage，≤20 次）；插件侧刻意不存路径——按 G-03，落盘/内存不该随扫描次数线性膨胀。
4. **文档未同步（不在本卡写域）**：`docs/PLUGIN-MATURITY.md:90` 仍记 integrity 0.4.0（实际 0.5.1→本卡 0.6.0）、方法数口径不变但行内未提体积/roots/scan_history；`docs/FRONTEND.md` 第 271 行「完整性」段仍描述旧的三张表 UI。请 docs owner 收口时一并改。
5. **发行产物未重建**：按卡约束未跑 `make dist`、未入 `kore-plugins` 索引、未重签；因此 `info.json.size_bytes` 仍是 0.5.1 量级，下次 `make dist` 会按固定点算法回收口值。
6. **本轮未改动主实例运行态配置**：未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`，未重启 8787；未提交 `web/dist`（gitignore，仅本地 `make web-dist` 供真机验证）。
