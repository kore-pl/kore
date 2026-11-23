# 凭据管理 UI 双端截图 + 真实点按 E2E（G-28 / ADR-0026）

> 元信息: 2026-11-23T20:36+08:00 · 执行者 kore-impl-monitor 子 agent · 隔离实例 `127.0.0.1:18888`（`profile: portable`，config/state/run/log 全在 `/tmp/kore-cred-18888`）· 真 chromium 156 headless（CDP 真实点击）· 报告 ≤60 行

## 1. 结论

设置页「凭据」tab 完成**真实点按 E2E**：新建 `koreE2eCred`（owner=firewall，envVar=`KORE_TEST_CRED`，口令用 `***` 占位）→ 授权给 logs → 撤销确认弹层 → 删除确认弹层，全部命中成功文案。4 张截图 `file` 复核宽高符合 G-28；无 401 循环、无按钮无响应。发现并修复 1 个前端缺口：撤销原先无二次确认（见 §5），已在 `web/credentials.js` 补确认弹层。

## 2. 隔离实例与数据

- 端口 `127.0.0.1:18888`；独立 `--config`，`profile: portable`，`paths.{state_dir,run_dir,log_dir}` 全落 `/tmp/kore-cred-18888`。
- 经 `kored install --package` 装入：firewall **0.2.4**、logs **0.4.2**（供 owner/授权下拉；无需启用即可列出）。
- 浏览器走真实登录表单（隔离实例自建 PBKDF2 口令，不落仓库），未使用预置 cookie。

## 3. 真实点按步骤与结果

| 步骤 | 操作 | 结果证据 |
| --- | --- | --- |
| 1 | 设置 → 点「凭据」tab | `tab clicked`，模块懒加载出 `.cred-form` |
| 2 | 填 owner=firewall、名称 `koreE2eCred`、环境变量=自定义 `KORE_TEST_CRED`、口令 `***` → 点「创建凭据」 | `created True`，页面出现「凭据已创建…」 |
| 3 | 列表行内容 | `cred-… koreE2eCred firewall KORE_TEST_CRED logs —`（ID/名称/owner/envVar/grantedTo/创建时间） |
| 4 | 行内选 `logs` → 点「授权」 | `granted True`，出现「已允许「logs」读取 koreE2eCred」 |
| 5 | 点授权 chip「撤销」 | 弹层「撤销「logs」的授权？」+ 影响说明 + 取消/确认撤销 |
| 6 | 取消后点「删除凭据」 | 弹层「删除凭据 koreE2eCred？」+「删除后不可恢复…」+ 取消/确认删除 |
| 7 | 页面横向溢出 | 桌面 scrollWidth=innerWidth=1440；手机 390=390；无登录页回跳 |

## 4. 截图证据（逐张 `file` 复核）

| 文件 | 实际宽高（`file`） | 字节 | sha256 前 16 |
| --- | --- | --- | --- |
| [credentials-desktop.png](screenshots/credentials-desktop.png) | **1440 x 901**（full-page） | 112004 | `0106e10d1b0092b8` |
| [credentials-mobile.png](screenshots/credentials-mobile.png) | **390 x 844** | 63049 | `a204fd8849ba8bbc` |
| [credentials-revoke-confirm.png](screenshots/credentials-revoke-confirm.png) | **1440 x 900**（撤销确认弹层） | 116713 | `9c663c50d7623082` |
| [credentials-delete-confirm.png](screenshots/credentials-delete-confirm.png) | **1440 x 900**（删除确认弹层） | 117516 | `14a5900fe0586709` |

- 桌面页宽 1440（内容高 901，full-page）；手机 390×844；4 张 sha256 互不相同，非同一张缩放。
- 手机端表格按 CSS 转卡片堆叠（`@media max-width:639px`，`web/credentials.js` 内联样式），操作按钮 44px 高。

## 5. 发现与修复 / 已知缺口

1. **已修（前端，写域内）**：撤销授权原先点一下立刻执行，没有二次确认；与删除不一致。已在 `web/credentials.js` 的 `revoke()` 改为先弹 `cred-dialog`（kind=`revoke`），确认后才 `DELETE grants/{grantee}`；截图第 3 张即该弹层。修改随本任务提交 `web/credentials.js`。
2. **已知后端缺口（不改，task-102 在补）**：`GET /api/v1/credentials` 响应项没有 `createdAt`（`internal/core/httpapi/handlers_credentials.go` 的 item 只有 ID/Owner/Name/EnvVar/GrantedTo），页面「创建时间」列显示「—」；不影响列表/新建/授权/撤销/删除。
3. 授权成功后只剩 2 个已装插件（owner=firewall 已排除、logs 已授权），下拉显示「没有可授权的插件」且「授权」按钮禁用——空态正确，不是按钮无响应。
4. 未发现字段串位、401 循环、页面报错；`cred-error` 为空。

## 6. 自评三问

1. **解决什么用户问题**：把「只能 curl」的凭据管理变成设置页里的可视化操作——集中存放数据库/缓存口令、按插件显式授权、随时撤销与删除，且列表永不回显口令，降低把口令写进插件 config/命令行的风险。
2. **与宝塔 / 1Panel 同类功能差距**：宝塔/1Panel 把口令绑在具体数据库/站点实例里，创建即用、可一键测试连接；本页是**跨插件凭据传输层**（ADR-0026，owner + grantee 模型），优势是 discover/db 等可复用同一凭据，差距是缺「导入既有 config 口令」「连接测试」「轮换历史/到期提醒」，且创建时间列待后端补齐。
3. **当前「可用」还是「占位」**：**可用**——真实实例上完成新建→授权→撤销确认→删除确认全链路；唯一边界是创建时间列显示「—」（后端字段缺失，task-102），不属于占位或伪造数据。

## 7. 清理与边界

- 已停止隔离 kored 与 chromium，删除 `/tmp/kore-cred-18888`；复核 18888 端口无监听、无残留进程。
- **主实例 8787 零写入**：未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`（本轮仅 `make frontend/build` 重建产物，未重启主实例）。
- 截图文件名统一 `credentials-*`，未触碰 `site-file-*` / `backup-redis-*` / `dns-*` / `firewall-logs-*`。
