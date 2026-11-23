> 元信息: 2026-11-23T08:41+08:00 · 执行者 install-six-plugins 子 agent · 6 个 L1.5 插件安装/升级 + 方法实测 + G-28 双端截图 · 报告 ≤60 行

# 6 个 L1.5 插件安装验收（热重载）

## 0. 口径与前置事实
- 主实例 8787 PID **1726888**（08:19:24 启动，验收时 elapsed 19m27s）；6 次安装响应均带 `reload:"reloaded"` → 走热重载，**未重启 kored**。
- 登录 `POST /api/v1/auth/login`（管理口令 `***`），从 `kore_csrf` cookie 回填 `X-Kore-CSRF` 双提交。
- G-29：未改 `.kore-local.yaml` / 状态库 / `bin/kored`；`index_dir=/home/pt/Work/GolandProjects/kore-plugins/index` 与配置一致。运行态唯一变化 = 经 API 安装的插件本身。
- 槽位：安装前 `supervisor.resident=2`，装完仍 **2**（6 个新插件全 `lazy`，不占常驻槽；常驻仍是 site + terminal）。

## 1. 安装/升级结果（`POST /api/v1/store/install`）

| 插件 | 安装前 | HTTP | 装后版本 | reload |
| --- | --- | --- | --- | --- |
| db-postgres | 未装 | 200 | 0.2.0 | reloaded |
| app-deploy | 未装 | 200 | 0.2.0 | reloaded |
| integrity | 未装 | 200 | 0.2.0 | reloaded |
| runtime-node | 未装 | 200 | 0.2.0 | reloaded |
| runtime-python | 未装 | 200 | 0.2.0 | reloaded |
| runtime-php | 0.1.1 | 200 | 0.2.0（`force:true`；`previous_version:"0.1.1"`；`stale_versions:["0.1.0","0.1.1"]`） | reloaded |

- enable 6 个全部 HTTP 200：`enabled:true` / `desired:"enabled"` / `state:"stopped"`（lazy 空闲态，符合设计）。

## 2. 方法真实返回（enable 后，body `{}`）

| 方法 | HTTP | 关键 JSON |
| --- | --- | --- |
| `db-postgres.instances` | 200 | `{"instances":[],"count":0}` |
| `app-deploy.templates` | 200 | `{"count":4,"ids":["nginx-static","wordpress","redis","postgres"]}` |
| `integrity.status` | 200 | `{"has_baseline":false,"entries":0,"last_check_ok":null}` |
| `runtime-node.versions` | 200 | `{"versions":[{"version":"24.21.0","path":"/home/pt/.nvm/versions/node/v24.21.0/bin/node","is_default":true}],"count":1}` |
| `runtime-php.versions` | 200 | `{"versions":[],"count":0,"hint":"未检测到 PHP，可执行 apt install php-cli…"}` |
| `runtime-python.versions` | 200 | `{"versions":[{"version":"3.14.4","path":"/usr/bin/python3","implementation":"CPython","is_default":true}],"count":1}` |

- 方法名口径：5 个插件只认带域前缀的 `<plugin-id>.<action>`（裸 `instances`/`templates`/`versions` → 404 `E_NOTFOUND`「未知方法」）；`integrity` 裸 `status` 与 `integrity.status` 都收。
- db-postgres 空态 `instances` 只有空数组 + `count:0`，**无 hint 字段**；「未配置实例」提示只在按实例名调用时出现：`db-postgres.databases {"instance":"default"}` → 404 `E_NOTFOUND`「未配置实例 "default"（已配置: 无（请先在设置里填写数据库地址并按需保存））」。

## 3. 已装总数与版本
- `GET /api/v1/plugins`：**20 个已安装**（安装前 15 个 = 14 个既有 + runtime-php 0.1.1；+5 新装 +1 升级 = 20），`update_available` 全 0；新 6 个均 0.2.0，其余维持原版本（backup 0.2.1 / db-mysql 0.3.0 / site 0.2.0 …）。
- 概览页实测：插件总数 20 / 已启用 20 / 运行中 2 / 空闲 18 / 异常 0；商店页：共 24 个 · 已安装 20 · **0 个可升级**（全部已是最新）。

## 4. 截图（G-28，双端）
- `screenshots/install-six-plugins-desktop.png` 1440×1996、`install-six-plugins-mobile.png` 390×844
- `screenshots/install-six-store-desktop.png` 1440×1210、`install-six-store-mobile.png` 390×844（第 2/2 页：`install-six-store-p2-desktop.png` 1440×1210 / `-mobile.png` 390×844，可见 Node/PHP/Python 三张 0.2.0 卡）
- `screenshots/install-six-overview-desktop.png` 1440×900、`install-six-overview-mobile.png` 390×844
- 自评三问：① 本页解决"装了什么、是否为最新、槽位是否安全"——已装插件页用一行汇总（20 安装 / 0 可升级 / 常驻 2）直接回答；② 与宝塔"软件商店"相比，差距在**无插件分类详解与依赖预检**，优势是版本/深度/生命周期/槽位同屏且零装包体积；③ 当前状态：**可用**（新 6 个均无插件 UI，"插件 UI"区显示占位，属正常）。
- 控制台仅 3 条 error：登录前 401（store 预取）、`/favicon.ico` 404，无业务报错。

## 5. 差异与风险
1. 派发单写"原 14 + 新 6 = 20"，实测安装前是 **15**（含 runtime-php 0.1.1），结果总数 20 成立但算式应为 15 + 5 新装 + 1 升级。
2. 裸方法名调不通（5/6 插件），前端/文档若按裸名调用会 404——建议在 PLUGIN-PROTOCOL 里把"入口方法名必须带 `<plugin-id>.` 前缀"写成调用方契约。
3. runtime-php 升级后 `stale_versions` 残留 0.1.0 / 0.1.1 目录（设计为不自动删，需前端提示清理），磁盘上仍在。
