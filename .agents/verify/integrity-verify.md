> 状态: done · 归属: feat-integrity-verify · 更新: 2026-11-25 · 里程碑: M0–M5
> 功能卡：integrity-verify（竞品清单：文件防篡改 / 完整性监控）· 依据 [docs/PLUGIN-MATURITY.md](../../docs/PLUGIN-MATURITY.md) 完整性行 + [AGENTS.md](../../AGENTS.md) G-28/G-33

# 完整性校验：基线可视化 · 变更追踪（高危高亮 + 筛选）· 一键操作

## 1. 要解决什么（依据 + 改造前的事实）

| 依据 | 改造前事实（path:line） |
| --- | --- |
| PLUGIN-MATURITY.md:90「完整性」行：8 个方法 + 「前端 `web/integrity.js`」 | 后端 8 个方法里 **`restore` 从未在界面上接线**：`git show HEAD:web/integrity.js \| grep -c "invoke('restore'"` = **0**；所以「恢复」在后端早就可用（`kore-plugin-integrity/internal/integrity/methods.go:218`），用户点不到 |
| 本轮卡「变更追踪：新增/修改/删除列表，可按时间范围筛选；高危目录单独高亮」 | 改造前 `web/integrity.js:360-376` 的 `paintCheck()` 只画 3 张平铺表（新增/删除/修改），**没有筛选**（`grep -c int-filter` = 0）、**没有高危高亮**、**没有单条操作**；`git show HEAD:web/integrity.js \| grep -c createObjectURL` = **0**（无导出） |
| 本轮卡「对单个变更恢复/接受」 | 改造前只有「立即校验」和「重建基线」两个动作（`:132`），单条变更没有任何入口；插件明确只做检测、不保存文件内容（`internal/integrity/alerts.go:96-106` 的 `RecoveryGuide`），所以「恢复」必须是**指引 + 当场校验**，不能假装能回滚 |
| 本轮卡「基线可视化：id / 创建时间 / 扫描路径数 / 最近扫描结果摘要」 | `status` 只回布尔 `last_check_ok`（`methods.go:147-160`）；改造前概览没有逐项计数，也没有「扫描范围」；`baseline.list` 的条目类型 `BaselineListItem`（`methods.go:66`）**不含 Roots**，所以扫描路径只能由前端记录 + 从定时扫描任务的 params 反读 |
| USABILITY.md:37 原则②「页面首次打开时能自动填的字段已填好」 | 定时扫描的「要扫描的路径」原来是写死的 `/etc, /usr/bin`（改造前 `:242`），现在优先填已经建过基线的真实路径 / 已配置的定时任务路径 |
| G-28（AGENTS.md:64）+ 裁决41（手机 44px 触摸目标） | 改造前手机端表格用 `data-label` 堆叠（保留），但没有筛选条、没有行内操作；本轮新增的筛选与行内按钮在 639px 以下全部单列 + `min-height:var(--kore-touch)` |

**后端一行未改**：本轮只改 `web/integrity.js` 一个已登记文件（`Makefile:85` WEB_SRC_FILES 与 `web/embed.go` 已含 integrity.js，**无需新增登记**），不碰插件仓库、不碰内核、不引依赖、不加方法。

## 2. 怎么做的（用户可见的五处补齐）

1. **概览面板**（`web/integrity.js:316` `paintOverview`）：基线状态 chip（有/无、当前版本、版本数）+ 四项元信息（建立时间 / 记录文件数 / 合计体积 / 上次扫描）+ **最近一次扫描结果摘要**（新增 / 修改 / 删除 / 高危 / 未变化的计数条）+ **扫描范围**（路径数 + 前 6 个路径 chip）；三条一键动作：立即扫描、新建基线、导出变更清单。
2. **变更追踪面板**（`:407` `paintChanges` + `:457` `paintRow`）：单一清单表（类型 / 风险 / 路径 / 变化 / 时间 / 操作），筛选条 = **时间范围**（最近一次 / 1 小时 / 24 小时 / 7 天 / 全部）+ **类型** + **只看高危目录** + **隐藏已接受** + 路径搜索（160ms 防抖）；**高危目录高亮**：`/etc /bin /sbin /lib* /boot /usr/{bin,sbin,lib}* /root` 判「系统关键」（红），`/var/www /srv/www /srv/http /usr/share/nginx /opt /public_html` 判「站点与部署」（黄），整行黄底 + 左侧 3px 竖条（`riskOf`，`:210`）。
3. **单条变更「接受」/「恢复…」**（`:550` `openRecover`）：「接受」是**本页标记**（localStorage，不动基线，文案明确写「基线没有变化」）；「恢复…」弹层给出文件路径、旧/当前 sha256、三步指引，并带 **「校验是否已恢复」**（真实调 `verify_file(path, 旧sha256)`，一致才显示「已恢复」）、「复制路径」、「去备份页」（`KoreShell.navigate('backup')` 带 hash 兜底）。
4. **基线版本「恢复到此版本」**（`:650` `openRestore`）：页面内二次确认（不用 window.confirm），展示目标版本 id / 时间 / 条目 / 体积，确认后调 `restore`，把 `message / backup_path / 复核差异数 / hint` 如实展示（恢复的是**基线记录**不是文件内容，这点在弹层与通知里都写明）。
5. **导出变更清单**（`:684` `exportChanges`）：纯前端生成 utf-8 CSV（类型,风险,路径,变化,旧sha256,新sha256,权限变化,扫描时间,是否已接受），导出**当前筛选下**的可见行（与 `web/audit.js:147-175` 同口径），文件名 `integrity-changes-<YYYYMMDD-HHMM>.csv`。

前端态边界：扫描历史（≤20 次 / 每次 ≤300 行）、已接受标记（≤400 条）、各基线扫描路径只落 localStorage，`readLS/writeLS` 失败时降级为「仅本页」并在通知条说明（`config-drift.js:23` 同口径）；不写任何运行态文件（G-29/G-31），零轮询（G-19，唯一定时器是搜索框 160ms 防抖）。

## 3. 门禁命令 + 退出码（本机实跑）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cd kore && node --check web/integrity.js` | 0 | 无输出（语法通过） |
| `make -s web-dist` | 0 | web/integrity.js → web/dist/integrity.js |
| `bash scripts/frontend-check.sh` | 0 | 首屏合计 gzip **81528 B / 307200 B**（余量 225672）；i18n 增量 2922 / 3072 |
| `bash scripts/secret-check.sh` | 0 | 0 FAIL / 22 处匹配（占位写法均合规） |
| `GOWORK=off make test` | 0 | `[OK] go test 通过（根 module + 嵌套 module pkg/pluginapi）` |
| `GOWORK=off go vet ./...` | 0 | 无输出 |
| `bash scripts/usability-check.sh` | 1（存量） | `grep integrity.js` **零命中**——本卡没有新增 G-33 违规；FAIL 全部来自其它轨道（`A3 db-postgres` 28 条、runtime-* 24 条、waf/firewall/app-deploy 文案）与 A1 的只读 GOCACHE 环境（`open /home/pt/.cache/go-build/...: read-only file system`） |

## 4. 隔离实例真机取证（G-29：主实例 8787 全程未动）

| 项 | 值 |
| --- | --- |
| 实例 | `mktemp -d` 隔离实例，`server.addr` 自动选空闲端口，state/run/log 全落 /tmp，跑完 `rm -rf`；主实例 `curl -s localhost:8787/-/healthz` 全程 200，未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored` |
| 安装 | `POST /api/v1/store/install {"id":"integrity","version":"0.5.1","package_path":"…/kore-plugin-integrity/dist/integrity-0.5.1.tar.gz"}` → `{"state":"succeeded","message":"安装完成","reload":"reloaded"}`；`POST /api/v1/plugins/integrity/enable` → `desired=enabled, granted_capabilities=[system:read, system:admin]` |
| 数据和白名单 | 隔离实例以 `KORE_INTEGRITY_ALLOW_ROOTS=<TMP>/data` 启动，data 下预置 app.conf / old.conf / keep.conf / access.log（排除规则 `*.log` 应生效） |
| 基线 | UI 上「新建基线」填 data 路径 → `{"saved":true,…}`，通知：`路径 /tmp/int-real.XXXX/data · 记录 3 个文件 · 35 B · 耗时 0 ms`（access.log 被 `*.log` 正确排除） |
| 扫描 | 真实改动 data（改 app.conf / 删 old.conf / 加 shell.php）后点「立即扫描」→ `检测到 3 处改动`，3 行：`删除 old.conf` / `修改 app.conf 指纹 3f046006 → b79e0e77 · sha256` / `新增 shell.php` |
| 恢复校验 | `恢复…` → 点「校验是否已恢复」：改前 `还没恢复：当前文件与基线指纹不一致 | 当前 b79e0e77… ≠ 基线 3f046006…`；把文件内容写回原样再点：`已恢复：当前文件与基线指纹一致 | 3f046006… = 3f046006…`（真实 sha256 往返） |
| 接受 / 导出 | 「接受」→ 行变 `已接受` + 统计 `1 已接受`；「导出 CSV」→ 通知 `变更清单已导出 | 3 条记录 · integrity-changes-20261125-1235.csv` |
| 恢复版本 | 再建一个基线（2 个版本）→ 对旧版本点「恢复到此版本」→ 真实 `restore`：`恢复成功但复核发现仍有 2 处不一致 | 恢复前的当前基线已备份：…/baseline.bak.20261125T043532….json | 基线已切换，但文件内容没有被改动`（id 与 backup_path 都是插件真实返回） |
| 手机端 | 390×844 同一路真实数据：清单 2 行（恢复后差异），`scrollWidth > clientWidth` = **false**（无横向溢出） |
| 页面错误 | `pageerror` = **0 条**（两组跑法都是 0） |

点击脚本为一次性 Playwright（`NODE_PATH=<npx playwright>`，未装新依赖），跑完删除，未留脚本。

## 5. G-28 双端截图（`file` / `identify` 实测宽高）

**A 组：真实插件数据（隔离实例真装 integrity 0.5.1，真基线 / 真扫描 / 真校验 / 真 restore）**

| 场景 | 文件 | 实测 |
| --- | --- | --- |
| 真实扫描后整页（3 处改动 + 概览摘要 + 扫描范围） | screenshots/integrity-real-desktop-01.png | PNG 1440 x 2012（full-page） |
| 「恢复…」弹层 + 真校验「还没恢复 / 已恢复」 | screenshots/integrity-real-desktop-02.png | PNG 1440 x 900 |
| 「恢复到此版本」之后（2 个版本 + 复核差异） | screenshots/integrity-real-desktop-03.png | PNG 1440 x 2112（full-page） |
| 手机端同一路数据 | screenshots/integrity-real-mobile-01.png | PNG 390 x 844 |

**B 组：高危目录高亮与筛选（API 响应由 Playwright stub，用于展示 /etc、/usr/bin、/var/www 命中高危）**

| 场景 | 文件 | 实测 |
| --- | --- | --- |
| 6 条变更（5 条高危高亮）+ 概览计数 5 高危 | screenshots/integrity-verify-desktop-01.png | PNG 1440 x 2136（full-page） |
| 「恢复…」弹层（旧/当前指纹 + 三步指引） | screenshots/integrity-verify-desktop-02.png | PNG 1440 x 900 |
| 「只看高危目录」筛选后 + 已接受态 | screenshots/integrity-verify-desktop-03.png | PNG 1440 x 2226（full-page） |
| 手机端同场景 | screenshots/integrity-verify-mobile-01.png | PNG 390 x 844 |

**如实披露**：B 组的高危路径（/etc、/usr/bin、/var/www）不是本机能改动的文件（非 root），所以那一组用 Playwright `page.route` 桩了 4 个接口响应来呈现高危高亮与筛选；A 组是**真实插件、真实文件、真实 sha256**。桩响应的字段形状全部取自插件 Go 结构体（`methods.go:66-160`、`changes.go:6-12`），A 组已证明同一套代码在真实响应下逐项成立。

## 6. 产品定位自评（G-28 第三问）

- **本页解决什么用户问题**：不用记路径、不用读 JSON，打开就知道「有没有基线、什么时候扫的、这次改了什么」；改动能按时间范围和类型回看，/etc 与站点根这类高危目录一眼看得见；每条变更都能「接受」或拿到「怎么恢复 + 恢复成功没有」的当场校验；一条命令就能把清单导给审计。
- **与宝塔、1Panel 同类功能的差距**：宝塔的文件防篡改是「插件市场里的付费/半付费组件，给固定目录做指纹，报警在面板通知里」，1Panel 侧完整性主要靠「计划任务 + 自定义脚本」，两边都**没有把变更做成可筛选、可逐条接受/恢复的可视清单**。本轮做到：变更清单带时间范围/类型/高危/路径四维筛选、高危整行高亮、逐条接受与恢复指引 + 真实指纹校验、基线版本一键回退、CSV 导出——这一块**超过**两端现有形态。差距仍在：① 不做实时文件系统监听（inotify），只做定时/手动扫描（后端无该能力，且 G-19 禁止轮询常驻）；② 不能在本页直接回滚文件内容（插件不存内容，恢复要经 backup 或用户自己的备份）；③ 逐文件「大小变化」后端没回（见 §7）。
- **当前「可用」还是「占位」**：**可用**。隔离实例真装 0.5.1 → 建基线 → 改三个文件 → 扫描出 3 条 → 接受 → 导出 → 恢复版本，全链路真机点通，0 页面错误、手机无横向溢出。

## 7. 已知边界与挂账（不虚报）

1. **逐文件「大小变化」拿不到**（后端缺口，不在本卡写域）：`check` 的 `added[] / removed[]` 是纯 `[]string`（`methods.go:132-136`），`ModifiedEntry` 只有 `old_sha256/new_sha256/old_mode/new_mode/changes`（`:109-116`）——**没有 size 字段**，而基线条目其实存了 `Entry.Size`（`kore-plugin-integrity/internal/integrity/scan.go:32`）。要补得改插件契约（`ModifiedEntry` 加 `old_size/new_size`；added/removed 需改成结构体，属破坏性变更）并 bump 版本 + 重建 dist + 索引重签，本轮按卡约束（不改后端）不做。**建议下一张卡**：插件 0.6.0 只给 `ModifiedEntry` 加 `old_size/new_size`（可加性），前端表格加一列「体积」。
2. **「扫描路径数」不是后端字段**：`BaselineListItem`（`methods.go:66`）不含 `Roots`，虽然 `store.Baseline` 里存了（`store.go:56`）。当前实现 = 前端记录本页建过的基线路径 + 从 `schedule.get` 的任务 `params.paths` 反读；换浏览器/清存储后会退化为「本页还没有记录扫描路径」并给下一步，**不猜**。同样建议在下一张卡里给 `baseline.list` 加 `roots`。
3. **变更清单是「本页扫描记录」**：插件没有 check 历史（每个基线只存 `last_check_at / last_check_ok`，`store.go:61-63`），所以时间范围筛选基于 localStorage 的最近 20 次扫描（每次 ≤300 行）。换浏览器/清存储后历史消失，页面明说「本页没有逐条变更记录」并给「立即扫描」按钮，不假装有历史。
4. **「恢复」是基线版本回滚，不是文件回滚**：插件不保存文件内容（`alerts.go:96-106`），单条变更的「恢复…」只给指引 + 用 `verify_file` 校验是否真的恢复；基线级「恢复到此版本」也只切基线记录并如实回报复核差异数。
5. **B 组截图是桩数据**（见 §5 披露）；A 组是真实插件。
6. **文档未同步**（docs 写域不在本卡）：`docs/PLUGIN-MATURITY.md:90` 记 integrity 为 0.4.0，实际 `info.json` 已是 0.5.1；该行「前端 `web/integrity.js`」可补一句「变更清单四维筛选 + 高危高亮 + 逐条接受/恢复 + 基线版本回退 + CSV 导出」。请 docs owner 收口时一并改。
7. **本轮未改动主实例运行态配置**：未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`，未重启 8787；所有验证在 /tmp 隔离实例内完成，实例与一次性脚本已删除。
