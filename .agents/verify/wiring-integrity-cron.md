# integrity 基线多版本 / 定时扫描 + cron 启停 —— 接线与验收证据（Gitea #3 后半）

- 写域：`web/integrity.js`、`web/tasks.js`（+ 本文件与截图）
- 本轮没改 `internal/`、其它视图文件、`web/shell.js`、`style.css`

## 一、5 个方法的落点（file:line）

| 方法 | 落点 | 形态 |
| --- | --- | --- |
| `integrity.baseline.list` | `web/integrity.js:141`（`paintBaselines`）/ `:176`（`invoke('baseline.list')`） | 新增「基线版本」面板：版本 id（前 8 位）、建立时间、文件数、体积、上次校验、当前/未校验/有改动徽章；空态给「建立基线」按钮 |
| `integrity.schedule.get` | `web/integrity.js:183`（`paintSchedule`）/ `:213`（`invoke('schedule.get')`） | 新增「定时扫描」面板：任务名、频率人话（每天 04:00）、下次执行、是否已提交调度；并明确写「这里只展示插件描述，不代表内核任务态」 |
| `integrity.schedule.set` | `web/integrity.js:229`（`buildScheduleForm`）/ `:268`（`invoke('schedule.set')`） | 预设频率下拉（每天 04:00 / 每周日 03:00 / 每 6 小时 / 自定义）+ 路径/排除/基线/超时；一次表单提交，不让人写 cron |
| `cron.enable` / `cron.disable` | `web/tasks.js:398`（`toggleTask`）/ `:402`（按状态选方法）/ `:467`（行内按钮） | 列表行内「启用/停用」按钮，不弹窗；成功回显 changed/备份路径，失败给 RUNBOOK 提权提示 |
| 频率人话翻译 | `web/tasks.js:384`（`humanCron`）/ `:456` | 常见表达式直出「每天 03:00 / 每 6 小时」，看不懂的原样显示，不猜 |

## 二、`schedule.set` → `POST /api/v1/scheduler/tasks` 怎么实现

1. `postScheduler(task)`（`web/integrity.js:48`）复用页面同款双提交：`credentials:'same-origin'`、`X-Kore-CSRF: <cookie kore_csrf>`、JSON body。
2. 提交顺序（`:268`）：
   `site? 否` → `invoke('schedule.set', {schedule, paths, exclude, baseline_id?, timeout_s?})`
   → 拿到 `r.recommended_task`（与 `scheduler.CreateInput` 对齐：name/plugin/method/params/schedule/timeout_s/enabled）
   → `postScheduler(r.recommended_task)` → 内核返回任务 id。
3. 只有第 2 步成功才写「已提交调度」提示；`schedule.set` 返回的 `created` 恒 false 被如实忽略（不冒充已创建）。
4. `E_NOTFOUND`（插件说「先建基线」）→ 表单内给「先去建立基线」按钮，直接打开基线弹层。
5. 提交内核失败（如调度器不可用）→ 明确分开提示「描述已生成，但提交内核调度失败」，不假装成功。

## 三、门禁（命令 + 退出码）

```
node --check web/integrity.js   → 0
node --check web/tasks.js       → 0
make frontend                   → 0（首屏 59416 B / 300 KiB 预算；i18n 2801 / 3072 B）
make build                      → 0（bin/kored）
```

## 四、截图（`file` 实际宽高）

| 文件 | 实测尺寸 |
| --- | --- |
| `.agents/verify/screenshots/wiring-integrity-desktop-01.png` | 1440 × 1498 |
| `.agents/verify/screenshots/wiring-integrity-mobile-01.png` | 390 × 2200 |
| `.agents/verify/screenshots/wiring-cron-desktop-01.png` | 1440 × 3750 |
| `.agents/verify/screenshots/wiring-cron-mobile-01.png` | 390 × 10743 |

横向溢出实测（Playwright `scrollWidth - innerWidth`）：desktop integrity 0 / cron 0；mobile integrity 0 / cron 0。
触摸目标：沿用主壳 `.btn`（min-height 44px 级）与行内按钮，未新增小于 44px 的交互元素。

**重要诚实披露（数据来源）**：本机已安装的插件版本 **integrity 0.2.0 / cron 0.4.0 早于这 5 个方法**（repo 里有 0.3.2 / 0.4.1，但未安装进本地实例），直接连真实后端会得到 `E_NOTFOUND` 与空列表。
因此截图用**隔离实例 + 这 5 个方法的契约 fixture** 渲染：登录、导航、会话、主题、其它接口（如 cron.logs）都是真实后端；只有这 5 个方法的响应是契约形状的固定数据。
→ 结论只到「UI 已接线、布局与降级文案可用」，**不代表已对真实插件版本完成端到端验证**。装上新版插件后需复跑一次真数据验收。

## 五、产品定位自评三问

1. **本页解决什么用户问题**：让「完整性基线」从单版本升级为可追溯的多版本，并把「定时扫描」从需要手写 cron 变成一次表单 + 内核调度；让计划任务不用删了重建就能临时停用/恢复。此前这些后端能力在界面上完全不可达（装了用不上）。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔的文件防篡改是收费插件且只给单基线 + 固定周期；1Panel 没有内置完整性基线。本页把「多版本历史 + 当前版本 + 内核调度」放在一个页面，且如实标注「插件描述 ≠ 内核任务态」；差距在于还缺「一键回滚到某历史基线」「扫描结果趋势图」，且本轮数据是契约 fixture，未连新版插件实测。
3. **当前是「可用」还是「占位」**：**接线完成、合成数据下可用（部分可用）** —— 交互、空态、错误提示、移动端布局均已实现并通过门禁与截图；但因为本地插件版本缺这 5 个方法，真实端到端未验证，所以不标「已验收」，标「可用（待真数据复验）」。

## 六、运行态与隔离

- 截图用隔离实例：`/tmp/kore-ui/kore.yaml`（独立 `--config`，state/run/log 全在 `/tmp`，端口 18888），只从主 state **复制** `state.db` 与 `integrity`/`cron` 两个插件目录；**未改动**主实例 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`。
- 主实例 8787 全程未重启、未改配置；本轮结束已停掉隔离实例并清理 `/tmp/kore-ui`。
