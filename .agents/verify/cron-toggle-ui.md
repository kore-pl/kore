# cron 启停 / 立即执行双端截图（G-28 批次 D）

> 2026-11-23T20:3x+08:00 · 执行者 kore-impl-cron · 隔离实例 `127.0.0.1:18890`（portable，config/state/run/log 全在 `/tmp/kore-cron131`）· chromium-1248 headless + 手写 CDP · 装入本地 cron **0.5.0** dist

## 1. 结论

启停开关、停用置灰 +「已停用」标签、立即执行结果面板（退出码 + 输出摘要）、停用态人话提示**四项全部真机截图通过**；桌面 1440 × full-page、手机 390 × full-page，`file` 宽高见 §3。templates / batch 本轮**未接 UI**（task-110 只要求后端契约），故无入口可截。

## 2. 隔离实例与数据（G-29）

- 独立 `--config /tmp/kore-cron131/config.yaml`，`profile: portable`，端口 18890；索引指向 `kore-plugins/index`。
- 经 `POST /store/install` 装本地包 `kore-plugin-cron/dist/cron-0.5.0.tar.gz` → `state=succeeded, reload=reloaded`，版本 0.5.0。
- **诚实披露**：本机当前用户真实 `crontab -l` 报权限不足，故隔离实例以 `KORE_CRON_FILE=/tmp/kore-cron131/crontab.txt` 文件后端运行（插件自带隔离钩子），不触碰任何真实 crontab；其余插件/内核/HTTP 全为真实链路。
- 两条任务：index 0 `每日巡检`（`0 3 * * *`，启用）；index 1 `已停用的任务`（`*/5 * * * *`，`cron.disable` 停用）。
- **主实例 8787 零写入**：本轮未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`，未对 8787 发请求。收尾已停 18890、chromium，`rm -rf /tmp/kore-cron131`，端口无监听。

## 3. 截图证据（`file` 实测）

| 文件 | 实际宽高 | 内容 |
| --- | --- | --- |
| `.agents/verify/screenshots/cron-toggle-desktop-01.png` | **1440 × 3693** | 列表：0 行「已启用」+ 停用按钮；1 行置灰 +「已停用」标签 + 启用按钮 |
| `.agents/verify/screenshots/cron-toggle-desktop-02-run.png` | **1440 × 3858** | 立即执行后结果面板：`退出码 0`、耗时、输出 `echo cron-toggle-ok` |
| `.agents/verify/screenshots/cron-toggle-desktop-03-disabled.png` | **1440 × 3858** | 停用行点执行后的状态条：`该任务已停用，先点「启用」再执行` |
| `.agents/verify/screenshots/cron-toggle-mobile-01.png` | **390 × 10448** | 手机全页：表格转卡片、启停按钮 ≥44px、停用行置灰 |

DOM 回读（拍摄同页，非 mock）：状态条文本逐字 `该任务已停用，先点「启用」再执行`；结果面板文本 `退出码 0耗时 0 msecho cron-toggle-ok`；两行启停按钮与 `.task-toggle-btn` 各 2 个。

## 4. 自评三问

1. **本页解决什么用户问题**：计划任务不必「删了重建」才能临时停用；停用状态在列表里一眼可见（置灰 + 标签），想手动验证时点「立即执行」即可看到退出码与输出，失败有据可查。
2. **与宝塔 / 1Panel 的差距**：宝塔的计划任务把启停、日志、立即执行放在同一行且带执行历史列表；本页已有一行式启停/执行/结果，但**没有执行历史时间线**（cron.logs 是系统启动行，不是每次退出码），模板/批量也还只有后端契约、无 UI 入口。
3. **当前状态**：**可用（真实链路截图）**——启停、置灰、结果面板、停用提示均为真实后端返回并真机拍摄；因运行在文件 crontab 后端，未验证真实系统 cron 的权限路径（本机权限不足，已在 §2 如实说明）。

## 5. 已知未做

- templates / batch 的 UI 入口未接（后端 0.5.0 已有）；G-28 只覆盖本卡四项。
