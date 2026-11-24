> 元信息: 2026-11-24T21:57+08:00 · 执行者 feat-plugin-redis · Redis 插件「后端已实现、前端无入口」能力补口 · 隔离实例真浏览器双端截图（G-28）· 报告 ≤90 行

# Redis 键管理 UI 收口验收（rename / move / copy 三方法接线）

## 0. 结论

Redis 插件 0.6.0 的 `redis.rename` / `redis.move` / `redis.copy` 三个写方法后端早已真实实现（RESP RENAMENX / MOVE / COPY + 覆盖/大键/跨实例门控），但 `web/redis.js` 从未调用——用户在面板上根本点不到。本次把三方法接进键详情侧栏的「键管理」面板：三选一操作、目标键/目标库表单、覆盖需显式勾选确认、执行后回读刷新。真浏览器点「执行」完成一次 rename 并回读验证（旧键 404 / 新键 200），双端截图 `file` 实测 1440×900 / 390×844。**声明完成。** 未做：集群模式（方法面无对应入口，非本次范围）。

## 1. 缺口清单（path:line 证据）

| 后端方法声明 | 位置 | 前端缺口 |
| --- | --- | --- |
| `redis.rename` | `kore-plugin-redis/internal/redisop/call.go:38`（`methodTable["rename"]=callRename`）；`info.json:31` 声明 `system:admin`；`keymove.go:54` 实现 | 改动前 `grep 'redis.rename' web/redis.js` **零命中** |
| `redis.move` | `call.go:39`；`info.json:32`；`keymove.go:93` 实现 | 改动前 `grep 'redis.move' web/redis.js` **零命中** |
| `redis.copy` | `call.go:40`；`info.json:33`；`keymove.go:123` 实现 | 改动前 `grep 'redis.copy' web/redis.js` **零命中** |

改动前 `web/redis.js` 实际调用的完整集合（grep `invoke('redis.'`）：instances / info / keys / get / delete / persistence / memory / slowlog / keyInfo / set / expire / persist / bgsave / serverConfig.get / serverConfig.set —— 共 15 个，上述 3 个写方法 + `redis.ttl`（只读，keyInfo 已覆盖 TTL 展示，无独立补口价值）为缺口。本卡挑最有用户价值的 3 个键管理写方法补齐，不为凑数补 ttl。

## 2. 补齐后的用户可见行为

- **入口**：Redis 视图 → 键浏览点任一键 → 键详情侧栏新增「键管理 · 重命名 / 迁移 / 复制」卡片。
- **交互**：三个操作按钮（重命名 / 迁移到其它库 / 复制）三选一；重命名/复制填目标键名（复制可选目标库），迁移填目标库号（0–1024）；覆盖默认禁止，需勾选「目标键已存在时允许覆盖（不可恢复，需再次确认）」才发送 `nx:false` / `replace:true` + `confirm:true`（与后端 gate 一致）；点「执行」调用对应方法，成功/未执行/失败三种结果都有中文反馈并刷新键列表与详情。
- **功能闭环实证**（隔离实例 + 真浏览器，见 §3）：点「执行」触发 `redis.rename {key:kore:demo:keymgr, new_key:kore:demo:renamed}`，回读 `redis.keyInfo` 旧键 **HTTP 404** / 新键 **HTTP 200**（`{key:"kore:demo:renamed",type:"string",...}`）；页面绿色提示「操作完成：rename kore:demo:keymgr → kore:demo:renamed」，键列表同步变成 `kore:demo:renamed`。

## 3. 隔离实例真机验证（G-29）

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / 主 `bin/kored`；未重启 8787。全部证据来自隔离实例：临时二进制源码编译（`go build`，CGO_ENABLED=0 + trimpath + -s -w，落临时目录）、独立 config/state/run/log（随机端口 18871）、随机口令仅存内存与 0600 临时文件（退出即删，G-30）、索引指向 `kore-plugins/index` 验签索引（本地包 sha 一致）。装插件 `POST /api/v1/store/install` → `state:succeeded, reload:reloaded`；enable → `enabled:true`。配置写指向独立起的密码空 Redis（docker `redis:7-alpine`，端口 16379）。浏览器：chromium headless + playwright-core（缓存已有，零新依赖），登录后走 `#/db/redis` 真路由、点真实键行、点真实「执行」按钮；两视口 `page_errors=0`。收尾：临时二进制/临时脚本/临时 config-state-run-log/口令文件全删，docker 验证容器 `docker rm -f`。

## 4. G-28 双端截图（`file` 实测宽高）

| 文件 | `file` 实测 | 证据点 |
| --- | --- | --- |
| `screenshots/redis-feature-keymgr-desktop-01.png` | **1440 × 900** | 键详情侧栏「键管理」面板：三操作按钮 / 新键名输入 / 覆盖确认勾选 / 执行按钮；绿色成功提示「rename kore:demo:keymgr → kore:demo:renamed」；键列表显示 `kore:demo:renamed`（rename 真实生效） |
| `screenshots/redis-feature-keymgr-mobile-01.png` | **390 × 844** | 同面板响应式：操作按钮换行不挤压、输入框 ≥44px、覆盖确认文案完整、底部 tab 导航可见；面板已 `scrollIntoViewIfNeeded` 进入视口 |

两张均来自同一次隔离实例真浏览器会话的不同 viewport（非同图缩放）；sha256 不同（desktop `3a856500…` / mobile `9db238a1…`）。

### 产品定位自评（G-28 三问）

**① 解决什么问题**：Redis 键的重命名 / 跨库迁移 / 复制以前只能在面板外敲 `redis-cli`，或用 `RENAME`/`MOVE`/`COPY` 裸命令，容易误覆盖。现在在键详情里点选操作、填目标、显式勾选覆盖即可完成，默认不覆盖、大键需确认、拒绝跨实例，小白也能安全操作。

**② 与宝塔/1Panel 的差距**：它们有 Redis 键的增删改查 + 批量导入导出 + 可视化编辑器；本视图此前只有浏览/读取/删除/TTL/持久化，本次补上键重命名/迁移/复制后，键生命周期管理基本对齐日常操作；差距在批量键操作与导入导出（后端无对应方法，属后续能力域扩展，非本次范围）。

**③ 可用还是占位**：**可用（非占位）**。真浏览器点击触发真实 `redis.rename`，回读证明旧键消失/新键出现，成功提示刷新到 UI；三方法共用一套安全门控（覆盖需 confirm / 大键确认 / 跨实例拒绝）与后端一致。

## 5. 门禁命令与退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/redis.js` | **0** | 无输出（语法通过） |
| `cd kore-plugin-redis && GOWORK=off go test -timeout 200s ./...`（GOCACHE 落仓内临时目录，退出即删） | **0** | 6 包全绿：`ok .../redis` / `.../plugincfg` / `.../redisop` / `.../tests/{boundary,e2e,fault}`；首次用默认 GOCACHE 因沙箱只读失败（非代码问题），改可写缓存后通过 |
| `cd kore && make secret-check` | **0** | `secret-check: 0 FAIL / 22 处匹配（占位写法均合规）`（G-30） |
| `file screenshots/redis-feature-keymgr-*.png` | **0** | 1440×900 / 390×844，与 G-28 一致 |

## 6. 写域与提交

- 源码仅改 `kore/web/redis.js`（+ 本验收报告 + 2 张截图）；**未改** `web/shell.js` / `web/onboarding.js`（feat-onboarding-once 写域）、任何其它 `web/<id>.js`、kore 后端 internal/、其它插件仓、运行态资产。
- `kore-plugin-redis` 仓零改动（后端方法本就齐备），该仓 `?? internal/redisop/zeroparam_test.go` 为开工前既存的他人未跟踪文件，本卡未碰。
- 提交：精确 pathspec + `[agent:feat-plugin-redis]` 前缀，commit 不 push。
