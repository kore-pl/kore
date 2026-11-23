# cron templates / batch 的 UI 入口（G-28 双端截图）

> 2026-11-23T21:3x+08:00 · 执行者 kore-impl-cron · 隔离实例 `127.0.0.1:18882`（portable，config/state/run/log 全在 `/tmp/kore-t196`）· chromium-1248 headless + 手写 CDP · 装入本地 `cron-0.5.0.tar.gz` · 主实例 8787 零写入

## 1. 后端契约核对（`../kore-plugin-cron`）

| 方法 | 入参 | 返回 | 证据 |
| --- | --- | --- | --- |
| `cron.templates` | 无（只读） | `{templates:[{id,name,description,schedule,type,command?,url?,comment?}],count,note}` | `internal/croncore/templates.go:12-25`、`:49`；`methods.go:144` |
| `cron.batch` | `{action: enable\|disable\|remove\|run, ids:[0起下标]}`（去重、≤50） | `{action,total,succeeded[],failed[],note}`；部分失败不回滚 | `internal/croncore/batch.go:12-37`、`:41`；`methods.go:151` |

改前 UI：`grep -n "templates\|batch" web/tasks.js` 零命中（后端能力用户看不见）。

## 2. 预设卡：改前 / 改后

- **改前**：`web/tasks.js:22-35` 4 张硬编码 `QUICK_PRESETS`，与后端 `cron.templates` 无关联。
- **改后**：先渲染内置 4 张（首屏不空），`loadQuickTemplates()` 再调 `cron.templates`，成功则用后端模板整体替换卡片；卡上显示模板名 + `description` 一句说明 + 「使用 →」，面板 meta 标「来自插件模板 · N 个」。
- **回退**：`invoke('cron.templates')` 失败（插件未装 / 版本旧 / 已停用 / 网络错误）时保留内置 4 张，meta 改「内置预设（插件模板不可用） · 4 个」；不白屏、不抛错。

## 3. batch UI

已接：任务列表上方「全选 + 批量启用 / 批量停用 + 已选 N 条」，每行首列复选框；点击调 `cron.batch {action, ids}`，结果分成功/失败并在刷新后保留提示；旧版插件（无 `cron.batch`）失败时提示「当前版本不支持批量，可逐条启用/停用」，不假装成功。隔离实例 DOM 实测：`!!document.querySelector('.task-bulk') = true`，按钮文本 `['批量启用','批量停用']`。

## 4. 截图（`file` 实测宽高）

| 文件 | 实际宽高 | 数据来源 |
| --- | --- | --- |
| `.agents/verify/screenshots/cron-templates-desktop-01-backend.png` | **1440 × 3812** | 后端模板：meta「来自插件模板 · 4 个」，4 卡含后端 description |
| `.agents/verify/screenshots/cron-templates-mobile-01-backend.png` | **390 × 10456** | 同上，手机单列 |
| `.agents/verify/screenshots/cron-templates-desktop-02-fallback.png` | **1440 × 1154** | 停用 cron 插件后：meta「内置预设（插件模板不可用） · 4 个」，仍显示 4 张卡 |
| `.agents/verify/screenshots/cron-templates-mobile-02-fallback.png` | **390 × 1634** | 同上，手机 |

后端数据实测（浏览器 DOM）：`每日备份站点 / 每小时健康检查 / 每周清理日志 / 每月证书检查`，description 与 `templates.go` 逐字一致；回退态为硬编码 `每天备份站点 / 每周清理日志 / 每小时健康检查 / 每月检查证书到期`。

## 5. 门禁

`node --check web/tasks.js`=0；`make frontend`=0（首屏 gzip：任务前 60926 B → 任务后 61344 B / 307200 B；`tasks.js` 为懒加载视图，增量来自并行会话对 shell/其他视图的改动，未能只归因本文件）；`make build`=0。

## 6. 隔离与清理

独立 `--config /tmp/kore-t196/config.yaml`，端口 18882；阶段 A 用插件自带 `KORE_CRON_FILE` 文件后端；阶段 B 停用 cron 插件触发回退。主实例 8787 零请求零写入，未改 `.kore-local*` / `bin/kored`。收尾：停 18882 与 chromium、删 `/tmp/kore-t196`，端口无监听、无残留进程。
