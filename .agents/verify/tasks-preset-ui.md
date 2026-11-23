# 计划任务预设卡 + root 错误组件 双端截图（G-28）

> 2026-11-23T21:0x+08:00 · 执行者 kore-impl-cron · 隔离实例 `127.0.0.1:18893`（portable，config/state/run/log 全在 `/tmp/kore-t167`）· chromium-1248 headless + 手写 CDP · 装入本地 `cron-0.5.0.tar.gz` · 主实例 8787 零写入

## 1. 结论

预设卡空态、4 张卡、**真实点击 2 次完成创建**、表单自动填充、折叠「高级说明」、root 错误组件五类证据全部真机截到；root 组件**真实触发**（当前用户 `crontab -l` 权限不足），非伪造。

## 2. 点击序列（实测 2 次 ≤3）

1. 点第 1 张卡「每天备份站点」→ 表单立刻填入：`type=shell`、`schedule=0 3 * * *`、`command=tar czf /var/backups/site-$(date +%F).tar.gz /var/www`、`comment=每日备份站点`，状态条「已填入…共 2 步」。
2. 点「新增任务」→ 状态「计划任务已刷新」，列表出现 1 行。
（截图步骤只做观测，不产生操作。）

DOM 回读的非空字段：`[["select-one","shell"],["text","tar czf /var/backups/site-$(date +%F).tar.gz /var/www"],["text","0 3 * * *"],["text","每日备份站点"]]`；HTTP 卡同理填 URL/method（代码 `applyQuickPreset`）。

## 3. 截图（`file` 实测宽高）

| 文件 | 实际宽高 | 内容 |
| --- | --- | --- |
| `.agents/verify/screenshots/tasks-preset-desktop-01-empty.png` | **1440 × 3791** | 空态「还没有任务，先从上面挑一个常用任务」+ 4 张卡（每天备份站点 / 每周清理日志 / 每小时健康检查 / 每月检查证书到期） |
| `.agents/verify/screenshots/tasks-preset-mobile-01-empty.png` | **390 × 10406** | 手机空态 + 卡片单列堆叠 |
| `.agents/verify/screenshots/tasks-preset-desktop-02-filled.png` | **1440 × 3791** | 点卡后表单已自动填好（类型/时间/命令/备注可见） |
| `.agents/verify/screenshots/tasks-preset-desktop-03-advanced.png` | **1440 × 3821** | 「高级说明」展开：crontab / 内核调度器 / API 只在折叠内，主流程无 |
| `.agents/verify/screenshots/tasks-preset-root-desktop.png` | **1440 × 4021** | root 组件：白话标题「这项操作需要系统管理员权限」+ 原因 + `sudo systemctl restart kore` + 复制按钮 + 折叠「为什么需要 root」+「重试」 |
| `.agents/verify/screenshots/tasks-preset-root-mobile.png` | **390 × 10696** | 同上，手机 |

## 4. root 组件是否真触发

**真触发**（未伪造）：去掉 `KORE_CRON_FILE` 文件后端、以普通用户 + 本机真实 crontab 不可读运行，DOM 回读 `document.querySelectorAll('.root-error').length = 1`，文案：

```
这项操作需要系统管理员权限
当前用户无 crontab 权限（crontab -l 报权限错误）
sudo systemctl restart kore
复制修法命令
为什么需要 root
重试
```

组件来自 `window.KoreUI.rootErrorHint`（`a053207` 接线）；`retry` 按钮存在，`code` 命令逐字为 `sudo systemctl restart kore`。遗留：状态条仍有一句「当前为只读：需要 root 权限…」（本轮写域只有截图与报告，未改 `tasks.js`；建议后续把该句也换成「系统管理员权限」）。

## 5. 自评三问

1. **解决什么用户问题**：新用户不必理解 cron 表达式——挑一张卡就能建出可用的备份/清理/健康检查/证书任务；权限不足时看到白话原因、可复制命令与重试，而不是内部名词。
2. **与宝塔 / 1Panel 差距**：宝塔有任务模板 + 一键添加；本页 4 卡已覆盖常用场景且默认参数可见，但模板只有 4 个、不能自定义模板，也没有执行历史时间线（cron.logs 只到系统启动行）。
3. **当前状态**：**可用（真实链路截图）**——预设填充、创建、空态、折叠说明、root 组件均为真实后端/真实浏览器；根组件依赖本机权限不足这一真实条件。

## 6. 隔离与清理

- 独立 `--config /tmp/kore-t167/config.yaml`，端口 18893；阶段 A 用插件自带 `KORE_CRON_FILE` 文件后端建任务，阶段 B 去掉该变量触发真实权限错误。
- 主实例 8787 全程零请求、零写入；未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`。
- 收尾：停 18893 与 chromium、`rm -rf /tmp/kore-t167`，18893 无监听、无残留进程。
