# ui-db 验收报告 · 数据库管理页（真机 · 双端）

- 隔离实例：`127.0.0.1:18888`（state `/tmp/kore-db-ui`），**8787 全程未触碰**（采样首尾 `/-/healthz` 均 200）。
- 数据库：`docker run --name kore-mysql-ui ... mysql:8` → `127.0.0.1:13307`，实测 `8.4.13`；库 `kore_ui`、表 `demo`（3 行）。
- 插件：`db-mysql 0.1.0` 本地包安装并启用；实例经 `KORE_MYSQL_INSTANCES` 注入，密码只走 `password_env=KORE_MYSQL_PASSWORD`。
- 页面：`#/db` 为 shell 内置第 10 项；`db.js` 懒加载，`node --check` 通过，源码 300 行（≤300）。

## 真机四步（页面 + API）

| 步骤 | 页面证据 | 接口证据（同实例） |
| --- | --- | --- |
| ① 实例卡 | 可达徽章 + `127.0.0.1:13307` + `8.4.13`（`db-desktop-01`） | `{"instances":[{"name":"ui","reachable":true,"version":"8.4.13"}],"count":1}` |
| ② 库列表 | `kore_ui` 出现；点击后自动填 `SHOW TABLES FROM \`kore_ui\`` 并执行，结果 `demo`（`db-desktop-02`） | `{"instance":"ui","databases":["kore_ui"],"count":1}` |
| ③ SQL 查询 | `SELECT * FROM kore_ui.demo` → 列 `id/name/note`、3 行、`3 行` 提示（`db-desktop-03`） | `{"columns":["id","name","note"],"row_count":3,"truncated":false}` |
| ④ 写操作拒绝 | `DROP TABLE kore_ui.demo` → 黄色提示条全文 `E_INVALID：只读白名单拒绝: 语句必须以 SELECT/SHOW/DESCRIBE/EXPLAIN 开头`（`db-desktop-04`） | `{"code":"E_INVALID","message":"只读白名单拒绝: ..."}` |

- 状态条实测：`threads_connected=1`、`uptime_s=444`、`queries=94`、`slow_queries=0`、`max_connections=151`、`version=8.4.13`。
- 空态实测（重启且不注入实例）：页面显示「未配置 MySQL 实例」+ `KORE_MYSQL_INSTANCES` 配置说明，无登录表单。
- 不可达实测（同批注入 `dead:13308`）：卡片红色「不可达」+ `连接失败：mysql 客户端失败: ERROR 2002 ... Can't connect to server`，不是空白/转圈。

## 集成发现（必须回传）

- 统一入口 `POST /api/v1/invoke/{plugin}/{method}` 的 `validateMethod` 要求**点分方法的域 == 插件 id**；因此本任务契约里的 `mysql.instances` 经该入口会 400：`E_INVALID 方法 "mysql.instances" 的域与插件 "db-mysql" 不一致`。
- 插件 `businessVerb` 同时接受裸动词，故页面实际调用 `/api/v1/invoke/db-mysql/{instances,databases,query,status}`，四个方法均实测 200（DROP 走插件只读拒绝的 400，属预期）。
- 建议后续统一插件方法命名（裸动词或 `db-mysql.*`）并同步 README；本轮未改插件/内核代码。

## 双端截图（G-28）

每张截图**前、后**各做一次 DOM 断言：`body.innerText` 含「数据库」且 `#kore-password` 数为 0；另加表内文案断言。8 张 sha256 两两不同，尺寸实测如下。

| 文件 | 尺寸 | 字节 | sha256 前 12 | 页内断言 |
| --- | --- | --- | --- | --- |
| [db-desktop-01-instance.png](screenshots/db-desktop-01-instance.png) | 1440×900 | 69711 | 8d3917031478 | 可达 / 8.4.13 |
| [db-desktop-02-databases.png](screenshots/db-desktop-02-databases.png) | 1440×900 | 69305 | c4c3444966d5 | kore_ui / Tables_in_kore_ui / demo |
| [db-desktop-03-query.png](screenshots/db-desktop-03-query.png) | 1440×900 | 71714 | a90f6ba3efe9 | alpha / 3 行 |
| [db-desktop-04-rejected.png](screenshots/db-desktop-04-rejected.png) | 1440×900 | 75644 | 1fff3cabb878 | E_INVALID / 只读白名单拒绝 |
| [db-mobile-01-instance.png](screenshots/db-mobile-01-instance.png) | 390×844 | 50270 | 5165a35a1c08 | 可达 / 8.4.13 |
| [db-mobile-02-databases.png](screenshots/db-mobile-02-databases.png) | 390×844 | 39858 | 0c1d0ad9d681 | kore_ui / Tables_in_kore_ui / demo |
| [db-mobile-03-query.png](screenshots/db-mobile-03-query.png) | 390×844 | 39718 | 7f6c3d271d5a | alpha / 3 行 |
| [db-mobile-04-rejected.png](screenshots/db-mobile-04-rejected.png) | 390×844 | 44648 | 9db17ab2c668 | E_INVALID / 只读白名单拒绝 |

- 移动端：`scrollWidth == innerWidth == 390`（无整页横向滚动）；`.db-result-scroll` 计算样式 `overflow-x:auto`；SQL 面板宽 366（内容区满宽）。
- 桌面端：SQL 面板宽 812，结果表在面板内滚动；无横向溢出。
- 预期内 4xx：未登录首屏 `system/info` 401（登录后消失）、DROP 的 `query` 400（即被测行为）。

## 产品定位自评（G-28 三问）

1. **解决什么用户问题**：不登 SSH、不记 mysql 命令，在控制台确认实例是否可达、看连接/慢查询/版本，列库并跑只读 SQL；写到库的语句在触达数据库前被拒且给出完整原因。
2. **与宝塔 / 1Panel 差距**：对方有库表结构编辑、账号权限、备份恢复、导入导出、慢日志可视化与多实例聚合；本页只有只读查询 + 单实例切换，结果表无分页/导出/历史。
3. **可用还是占位**：**可用**（真实实例、真实查询、真实拒绝、空态与不可达态齐全）；但明确是"查看与只读调试"最小闭环，不是完整 DBA 面板，写入/备份不在本页。

## 门禁与清理

- `node --check web/db.js` → 0；`node --check web/shell.js` → 0。
- `make frontend` → 0：首屏 gzip **33062 B** / 预算 307200 B，余量 274138 B（index 683 + style 12306 + app 14553 + shell 5520）；dist 12 文件。
- `make docs-check` → 0（6 pass / 0 warn / 0 fail）；`make check` → 0（10/10 段，0 FAIL）。
- 测试后 `docker rm -f kore-mysql-ui`；18888 独立 kored 停止；8787 仍在服务。
