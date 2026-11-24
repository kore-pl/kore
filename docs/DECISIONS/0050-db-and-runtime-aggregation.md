> 状态: accepted · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [0040-plugin-ui-distribution](./0040-plugin-ui-distribution.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[0049-privilege-direct-execution](./0049-privilege-direct-execution.md)、[FRONTEND](../FRONTEND.md) §4/§5、[PLUGIN-MATURITY](../PLUGIN-MATURITY.md) §2/§3.5

# ADR-0050: 多数据库与环境管理的组织方式——能力域内聚合，不新增聚合层

## 0. 背景：用户三个问题（2026-11-24）

> 「多数据管理呢，环境管理呢？」
> 「redis 也是数据库模块的啊」

问题指向两件事：**（1）三个数据库插件、三个运行时插件，是每插件一页还是按能力域聚成一页；（2）聚合该发生在哪一层。**
补充的第三问把 `redis` 的归属摆上台面：它现在是独立导航项，形态上是「缓存服务」，语义上属「数据库」。

本 ADR 只做裁决，**不含实现**；实施拆卡见 §4。

## 1. 现状核实（全部带 `file:line`，命令与原始输出见 `.agents/verify/db-runtime-architecture-audit.md`）

### 1.1 三个数据库插件的方法面

| 插件 | 版本 | 方法数 | 方法清单（`info.json` `method_capabilities`） |
| --- | --- | --- | --- |
| `db-mysql` | 0.4.1 | 15 | config.get / instances / databases / query / status / config.set / createDatabase / dropDatabase / createUser / changePassword / dropUser / grant / export / import / slowlog |
| `db-postgres` | 0.3.4 | 13 | config.get / instances / databases / query / status / slowlog / config.set / createDatabase / dropDatabase / createUser / dropUser / grant / changePassword |
| `redis` | 0.6.0 | 21 | config.get / instances / info / keys / get / keyInfo / ttl / memory / persistence / slowlog / serverConfig.get / config.set / delete / set / expire / persist / bgsave / serverConfig.set / rename / move / copy |

**数据管理深度差距（关键）**：

| 能力 | `db-mysql` | `db-postgres` | `redis` |
| --- | --- | --- | --- |
| 实例列表 | ✅ `instances` | ✅ `instances` | ✅ `instances` |
| 库/命名空间列表 | ✅ `databases`（`SHOW DATABASES`） | ✅ `databases` | ⚠️ 无独立方法，靠 `keys` 的 db 维度 |
| 数据浏览 | ⚠️ **只有任意 SQL 控制台**（`query` 返回 `columns/rows/row_count/truncated`，`README.md:70`），**无 `tables` 方法 → 无表浏览器** | ⚠️ 同 MySQL，仅 `query` | ✅ **键浏览**：`keys` 走 SCAN 游标（`README.md:20`、`:36`），`pattern` + `limit`（默认 200/上限 10000）+ `truncated` |
| 按类型看结构 | ❌ 无（只能手写 SQL） | ❌ 无 | ✅ `keyInfo`：`TYPE`/`TTL`/`MEMORY USAGE`/`OBJECT ENCODING` 一条 pipeline（`README.md:41`） |
| 值编辑 | ⚠️ 靠 `query` 拼 SQL | ⚠️ 同（且只读 SQL 白名单，`PLUGIN-MATURITY.md:84`） | ✅ `set`：string/hash/list/set/zset 五类型分型写入（`README.md:42`） |
| TTL 管理 | ❌ 无（SQL 手工） | ❌ 无 | ✅ `ttl` / `expire` / `persist` 三件套（`README.md:43-45`） |
| 备份/导出 | ✅ `export` / `import`（`README.md:90`） | ❌ **无**（`PLUGIN-MATURITY.md:84`「仍缺备份恢复」） | ⚠️ 仅 `bgsave`（落盘 RDB），**无导出文件、无导入** |
| 危险操作 | 删库需 `confirm=true`，系统库任何 confirm 都拒（`README.md:96`） | 同左 | **FLUSHALL/FLUSHDB/EVAL/SHUTDOWN 传输层本地拒绝**（`internal/redisop/whitelist.go:44-48`、`call.go:100-103`） |

**结论（反直觉，必须写下来）：三者里「数据管理」最完整的是 `redis`，最弱的是 `db-postgres`。** `redis` 有键浏览 + 分型值编辑 + TTL；MySQL 有导出但只能写 SQL 看数据；PostgreSQL 既无表浏览也无导出。
所以「统一数据库页面」如果按方法面做，现在的差距不是「redis 缺数据管理」，而是 **两个关系型插件缺表浏览器**。

### 1.2 三个运行时插件的方法面 —— 「只读」要分插件说

| 插件 | 版本 | 方法 | 写盘证据 |
| --- | --- | --- | --- |
| `runtime-php` | 0.2.2 | versions / info / projects / doctor / paths（全 `system:read`） | **零命中**：`grep -rn 'os.WriteFile\|os.Create\|OpenFile\|os.Mkdir'` = 0 |
| `runtime-node` | 0.2.5 | versions / info / projects / doctor / paths（全 `system:read`） | **零命中** |
| `runtime-python` | 0.3.2 | 上述 5 个 + `venv.create` / `venv.list` / `pip.install` / `pip.list`（后两者 `system:admin`） | **有写**：`internal/pyop/venv.go:390 os.MkdirAll`、`venv.go:484 exec.CommandContext` |

**「runtime-* 一律只读」不成立**——`runtime-python` 能建 venv、能 pip install。
准确的表述是：**runtime-php / runtime-node 只读探测；runtime-python 能写「自己管的 venv」，但同样不能装解释器、不能切版本。**

`runtime-php` 的只读边界有原始声明，可直接引用：

- `internal/phpop/types.go:30`：「SAPI 是本插件探测的接口类型：只管理 CLI，不管理 FPM 进程。」
- `README.md:36`：「`sapi` 固定 `cli`（本插件只管理 CLI，不管理 FPM 进程）」
- `README.md:176`（`## 不做（明确边界）`）：「不真起 / 不管理 PHP-FPM 进程池、**不切 `/etc/alternatives/php`**、不改站点配置（`use` 方法在 0.2.0 移除）」
- `tests/boundary/boundary_test.go:11` 把这条写成了边界测试的事实前提。

即：**三个 runtime 插件都只能「看到装了哪些版本」，都不能装、不能切。**

### 1.3 主壳现在怎么组织这些视图 —— 已经聚合了，不是「三插件三页面」

任务卡的「三个插件三个页面」与代码事实不符。实际结构是**主壳按能力域建页，页内再按插件扇出**：

- `web/shell.js:596`：`{ id: 'db', label: '数据库', render: lazyView('KoreDb', '/assets/db.js', …) }`
- `web/shell.js:601`：`{ id: 'redis', label: 'Redis', render: lazyView('KoreRedis', '/assets/redis.js', …) }`
- `web/shell.js:607`：`{ id: 'runtimes', label: '运行环境', render: lazyView('KoreRuntimes', '/assets/runtimes.js', …) }`
- 三者都在同一导航分组 `NAV_GROUPS` 的「业务」组：`web/shell.js:69` → `ids: ['sites', 'db', 'redis', 'tasks', 'runtimes']`
- 视图内扇出：`web/db.js:77-78` `methodFor()` 按 `dbType` 拼 `db-mysql.` / `db-postgres.`；`web/db.js:1028` 页头 `[['mysql','MySQL'],['postgres','PostgreSQL']]` 引擎切换；`web/runtimes.js:4` 文件头写明「Node.js / PHP / Python 三 tab 一页管理」
- 首屏与视图解耦：`web/app.js:2056-2062` 的 `SHELL_ROUTES` 只有 8 项，其余由 `shell.js` 内置并 `lazyView` 按需注入；`docs/FRONTEND.md:290` 的 `//go:embed` 清单证明这些都是主壳产物

**即：模型 B（按能力域聚合）已经是既成事实，`web/<id>.js` 清单里的 `db.js` / `runtimes.js` 就是聚合视图——它们不叫 `db-mysql.js` 是因为它们不属于任何单个插件。** `ADR-0040:23`「插件 UI = 主壳视图 `web/<id>.js`」里的 `<id>` 是**导航视图 id**，不是插件 id；本 ADR 把这条口径写死，避免下次有人按插件名去找文件。

### 1.4 `site` 能不能绑定 PHP 版本 —— 不能，链路上三个环节全缺

- `site` 0.4.4 共 22 个方法（`site.list/create/delete/status/get/bindSSL/unbindSSL/setRewrite/getRewrite/setProxy/unsetProxy/setRedirect/unsetRedirect/disable/enable/setIndex/config.get/set/clone/setPassword/clearPassword/traffic`），**没有任何 runtime / php / fpm / version 相关方法**。
- `grep -rn 'fastcgi\|php-fpm' kore-plugin-site --include=*.go` = **0 命中**：vhost 模板根本不生成 `fastcgi_pass`，只有 `try_files … /index.php` 这类 rewrite 规则（`rewrite.go:18-42`）与默认 index 列表 `index.html index.htm index.php`（`parse.go:154`）。
- `site` 的站点结构里没有运行时字段（`grep 'type Site struct'` 无该字段声明命中），站点只描述 nginx 配置，不描述「谁跑这个站」。
- `runtime-php` 侧明确不碰 `/etc/alternatives/php`、不碰站点配置（`README.md:176`）。

**结论：`site` 绑定 PHP 版本今天不存在，不是「绑的是版本号还是路径」的问题——一条链路都没有。** 归属见 §3.4。

### 1.5 两个影响裁决的额外事实

1. **`conflicts` 只声明、不执行**：`db-mysql/info.json` 与 `db-postgres/info.json` 互相声明 `conflicts`，但内核只在 `internal/core/registry/validate.go:322-324` 校验 id 字符串合法性，**没有任何运行期互斥判定**。即今天两个插件可以同时装。这与「统一数据库页列出所有类型的库」自相矛盾——要么承认可以并存并删掉互斥声明，要么实现强制互斥（见 §4 C7）。
2. **多实例已经支持**，不是缺口：`db-mysql/config.go:291` 构造 `[]mysqlop.InstanceConfig`（env + 配置合并），`redis` 同样按 `[]InstanceConfig` 分发（`internal/redisop/call.go:16,128`）。前端已有实例选择（`web/db.js` `selected`）。「多 MySQL 实例」在 §5 里标**已具备**，不列 P0。

## 2. 裁决：模型 B —— 按能力域聚合，聚合只在主壳前端，内核不新增聚合 API

**选 B（能力域聚合），并且是「显式化已有的 B」，不是新建一套。**

否决 A（每插件一页）的理由不是口味，是三条硬约束同时咬住：
- A 会让导航项数随插件数线性增长（DB 3 + runtime 3 = 6 项，占满手机底部「运维」5 tab 的额度，违反裁决41 的「≤2 次点击可达」）；
- A 与 `ADR-0040` 冲突：插件不带自己的 UI，所谓「插件页」仍是主壳视图，只是把 `db.js` 拆成两个文件多一次懒加载；
- A 把「MySQL / PostgreSQL / Redis」的差异暴露给用户——而用户心智里这就是「数据库」一件事。

### 2.1 问题一：聚合在哪一层？

**裁决：主壳前端视图层（`web/*.js` + `web/shell.js` 的 `lazyView` 注册表）。内核不提供聚合 API。**

- 不新增 `POST /api/v1/invoke/{domain}` 这类「域级扇出」端点。理由：G-01 明文「capability 字符串不属于业务逻辑——内核只认识 6 个特权能力与通用语法 `<plugin-id>:<action>`，**不得维护业务域名词表**」。一旦内核认识「数据库」这个词、知道要把 `db-mysql` 和 `redis` 的 `instances` 合并成一个响应，内核就变成了业务编排器，薄壳红线破。
- 现状已是正确形态：`internal/core/httpapi/handlers.go:73` 只有 `POST /api/v1/invoke/{plugin}/{method}`，**严格按插件路由，不做跨插件组合**。聚合完全在前端：`web/db.js:77-78` 一个页面按 tab 切换两个插件，`web/runtimes.js` 一个页面按 tab 切换三个插件。
- 跨插件并发扇出用前端 `Promise.all` + 各自降级（`web/runtimes.js` 已有 `invoke(domain, action, params)` 单插件调用函数，复用它并发三次即可）；任一插件未装/未启用按「未启用」呈现，**不编 0**（与 `docs/FRONTEND.md:271` 概览页服务卡的口径一致）。
- 懒加载粒度不变：聚合页仍是**一个视图一个文件**，只在该导航项首次进入时注入，首屏预算（G-03 ≤300 KiB gzip）不受视图数影响（`docs/FRONTEND.md:282`）。

### 2.2 问题二：插件视图和聚合视图的关系？

**裁决：没有「插件视图」这个东西（ADR-0040 已定），聚合页内直接操作；跨域跳转走主壳路由，不走 iframe / 新页面。**

- 用户看到的每一个 tab（MySQL / PostgreSQL / Node / PHP / Python）都是**同一视图内的状态**，不是独立页面：`web/db.js:1001-1031` 的引擎切换只重绘本页，`web/runtimes.js:4` 写明「tab 切换只重绘本页，不换 hash、不重载」。
- 需要跳到另一个域的实体（例如从「数据库总览」点一台 Redis）用主壳导航：`window.KoreShell.navigate(id)`（`web/app.js:2079` 已用同一入口），不是 `frame.src`。`ADR-0040` §1 记录过 `web/app.js` 曾指向不存在的 `/plugin-assets/` 路径——**不得复活那条链**。
- 反向约束：聚合页**不得**因为「页面聚合」就去重做插件侧的规则。`web/db.js:8` 的现有口径保持——写操作被插件白名单拒绝时，前端原样展示 `E_INVALID` 全文，**不在浏览器重做 SQL 解析**。

### 2.3 问题三：`runtime-*` 的只读要不要改？

**裁决：v1 不改「装 / 切版本」；`runtime-python` 现有的 venv / pip 保留（不是宿主写）。给判断如下。**

拆成三个不同的能力，别混谈：

| 能力 | 是否写宿主 | v1 做不做 | 判断依据 |
| --- | --- | --- | --- |
| 探测已装版本 / 健康检查 | 否（`exec -v` 读） | ✅ 已做 | `internal/phpop/types.go:30`，5 方法全 `system:read` |
| 在**插件自己管的目录**建 venv / pip install | 否（不碰系统解释器与 alternatives） | ✅ 保留（`runtime-python` `venv.go:390`/`:484`） | 写入目标是自己创建的目录，不属 G-31「宿主编更」 |
| **装解释器、切版本**（apt 装 PHP 8.3、切 `/etc/alternatives/php`） | **是，最高风险类** | ❌ **v1 不做** | 见下 |

**为什么 v1 不做「装 / 切版本」——四条理由，缺一条都还能争，四条同时成立就不能做：**

1. **这是 ADR-0023 / G-31 的「宿主变更」类别，不是普通写操作。** 装包会写 `/usr/bin`、`/etc/apt`、`/etc/alternatives`，全部在安装目录之外；G-31 只豁免 4 项（systemd unit、插件系统用户、**用户批准的宿主变更且须有 `<install>/data/changes.jsonl` 可回滚**、显式 `make install` 的二进制）。`/etc/alternatives/php` 不在豁免清单里，**先改 ADR-0023 才能做**。
2. **回滚做不到「一键」。** `changes.jsonl` 能记录「我改了什么文件」，但 `apt install php8.3` 的回滚是 `apt remove`，会连带删依赖、可能删掉别的站点在用的扩展。写不出可信回滚的操作，按 ADR-0023 的定义就不能进 v1。
3. **`runtime-php` 连 FPM 都不管，装了版本也接不上站点。** 装 PHP 8.3 的产品价值 100% 来自「能给站点绑上去」；而 `site` 侧没有 `fastcgi_pass` 生成、`runtime-php` 侧不碰 FPM（§1.4）。只做「装」，用户得到的是一个装了但用不上的版本——**这不是能力，是半成品**。
4. **能力声明与审计成本先于功能。** 真做需要：`capability` 声明（新增宿主写类，超出当前 6 个特权能力，等于改 PLUGIN-PROTOCOL）、`confirm` 二次确认、审计（`invoke` 落库）、回滚清单四件套。为「装 PHP」引入一条协议级新能力，收益/风险比在 v1 不成立。

**v1 的正确形态（现状已基本满足，只需补口径）**：`versions` 列出已装版本 + `doctor` 给出缺什么、装什么、**可复制的命令原文**（`web/runtimes.js:9` 的 `FIX` 正则已在从 detail 里提取 `apt install …` 等命令）。把「为什么不能一键装」写成一句人话放在页面上——**明确说「本页只探测，不改系统」，而不是让用户点了才报错。**

**v1.1 若要做，前置顺序不可跳**：改 ADR-0023 增豁免 → 协议增宿主写 capability → `runtime-php` 补 FPM 池管理（这是独立插件或独立大版本）→ `site` 补 `setRuntime` → 最后才是 UI 的「安装 / 切换」按钮。**只做 UI 不做前三步 = 假按钮**，按 G-28 判 BLOCKED。

### 2.4 问题四：`site` 绑定 PHP 版本的链路，谁负责？

**裁决：现在不能绑；归属 `site` 插件（vhost 归属原则），前置依赖 `runtime-php` 的 FPM 池能力；v1 不做，记为 v1.1 提案。**

目标链路（**本 ADR 不实现，只锁定形状，防止将来各写各的**）：

```
site.setRuntime { site, runtime: "php", version: "8.3", fpm_socket: "/run/php/php8.3-fpm.sock" }
  → site 生成 vhost: location ~ \.php$ { fastcgi_pass unix:/run/php/php8.3-fpm.sock; }
  → nginx -t && reload（复用 site 现有原子写/test/reload）
```

- **为什么归 `site`**：`fastcgi_pass` 是 vhost 的一部分，vhost 的唯一写者是 `site`（`siteverbs.go` 的原子写/test/reload）。让 `runtime-php` 去改站点配置，等于两个插件抢同一份文件——`runtime-php/README.md:176` 已经明确「不改站点配置」，这个边界要守。
- **为什么必须先有 FPM 池**：`fastcgi_pass` 指向的 socket 必须真实存在且归某个池管。没有池管理就是写一个指向空气的路径，`nginx -t` 可能过，访问 502。
- **绑「版本号」还是「路径」**：**版本号是用户输入，socket 路径是插件解析结果**，两者都要在响应里回显（用户要能看懂切成了哪个版本；运维要能核对 socket）。**禁止让用户手填 socket**——违反易用性四问②「自动发现，不让人填环境细节」。

### 2.5 `redis` 的归属：平级还是分组？

**裁决：`redis` 与 `db-mysql` / `db-postgres` 同属「数据」能力域、**平级**；导航保留两个入口（「数据库」+「Redis」），但在口径上明确「Redis = 数据库 · 键值型」，不叫「缓存服务」。**

理由三条：

1. **按用户心智归**：用户这轮原话就是「redis 也是数据库模块的啊」。宝塔把 Redis 放「软件商店」（装），键管理交给 phpRedisAdmin 这个独立工具；1Panel 给 Redis 独立管理页含键浏览。**两家都不把 Redis 当纯缓存**，独立页 + 数据管理是行业默认。
2. **按方法面归（见 §1.1）**：`redis` 有键浏览 / 分型值编辑 / TTL，深度**超过**两个关系型插件。把它降格成「缓存服务」在事实上站不住。
3. **但不合并成一页**：`web/redis.js` 1209 行、`web/db.js` 1041 行，合并后单文件 >2000 行，破坏「一个视图一个文件」的懒加载粒度与可维护性；且 Redis 的实例语义（16 个 logical db、无 schema）与关系型不同构，硬塞进 tab 会让「库列表」这个词在两种含义间漂移。

**落地动作只有两条，都很轻**：导航分组不动（`web/shell.js:69` 已把 `db` / `redis` 放同一「业务」组）；把 label / 页头文案从「Redis」补成「Redis（数据库 · 键值）」，并在「数据库」页顶部提供跨类型实例总览（点实例跳 `navigate('redis')`）。**不做**把 `redis.js` 并进 `db.js`。

## 3. 为什么不在内核做「统一列表」API（把 G-01 的边界说透）

| 方案 | 是否违反 G-01 | 判定 |
| --- | --- | --- |
| 内核新增 `GET /api/v1/databases` 聚合三插件 `instances` | **违反**：内核要知道「数据库」是业务域，还要知道哪几个插件属它 → 维护业务域名词表 | ❌ 否决 |
| 内核新增通用「按 capability 扇出」`invoke?filter=data:read` | **违反**：capability 语义被内核用于业务路由，等于让内核理解业务标签 | ❌ 否决 |
| 插件之间互相调用（`redis` 调 `db-mysql`） | **违反**：插件无相互发现通道，且引入插件间耦合 | ❌ 否决 |
| 前端并发 `invoke` 三个插件后合并渲染 | 不违反：内核只做 `{plugin}/{method}` 单跳转发，不含任何业务词 | ✅ **本 ADR 采纳** |

**一句话**：聚合是**产品概念**，产品概念归主壳；内核只认插件和方法两个坐标。这条线一旦松，下一个需求就会让内核去认识「站点」「证书」「容器」，薄壳死掉。

## 4. 实施计划（拆卡；**本 ADR 不实现**）

优先级：P0 = 让现状「说得清、降级正确」；P1 = 补齐数据管理硬缺口；P2 = v1.1 提案。

| 卡 | 优先级 | 目标 | 写域 | 验收标准 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| **C1** | P0 | 「数据库」页顶部加**跨类型实例总览**：并发 `db-mysql.instances` / `db-postgres.instances` / `redis.instances`，一卡一行（类型 / 地址 / 可达性 / 版本），点行 `KoreShell.navigate()` 到对应页 | `web/db.js`、`web/i18n/zh-CN.js`、`web/i18n/en-US.js` | ① 三插件全装：三行都出；② 只装一个：另两个显示「未启用」**不编 0**；③ 单插件超时 5s 不影响整卡渲染；④ G-28 双端截图（1440×900 + 390×844） | 无（纯前端，复用 `web/db.js:83` `invokeAt`） |
| **C2** | P0 | 「运行环境」页把边界说清：页头一句「本页只探测已装版本，不改系统、不切版本」，`doctor` 的 fail 项给可复制命令（现状已提取，补 UI 呈现与「为什么不能一键装」的一句人话） | `web/runtimes.js` | ① 三 tab 各有一句边界说明；② fail 项命令可选中复制；③ 无 fail 项时不显示空块；④ 双端截图 | 无 |
| **C3** | P0 | Redis 归属口径统一：导航 label / 页头改为「Redis（数据库 · 键值）」，`docs/FRONTEND.md:271` 同步一句归属说明 | `web/shell.js`、`web/i18n/*.js`、`docs/FRONTEND.md` | ① 桌面侧栏与手机抽屉文案一致；② i18n 双语都改；③ `make docs-check` 通过；④ 双端截图 | 无 |
| **C4** | P1 | `db-mysql` 补 `tables` / `tableSchema` 方法（`SHOW TABLES` / `SHOW CREATE TABLE`，库名白名单 + 系统库拒绝），前端在 `db-l2.js` 加「表」tab | `../kore-plugin-db-mysql/`（`mysqlop/`、`methods.go`、`info.json`）、`web/db-l2.js` | ① 方法面 `info.json` 与 `tests` 双向断言绿；② 系统库返回 `E_UNAUTHORIZED`；③ 表名/列名严格白名单；④ 插件版本 bump + `dist` sha 与索引一致；⑤ `go test ./...` 退出码 0 | C1（总览先立） |
| **C5** | P1 | `db-postgres` 补 `export` / `import`（对齐 `db-mysql` 的导出目录约束 `KORE_DB_EXPORT_DIR`，路径必须落在导出根内） | `../kore-plugin-db-postgres/`、`web/db-l2.js` | ① `pg_dump` / `psql -f` 真实跑通并回 sha256；② 导出路径越界返回 `E_INVALID`；③ 前端与 MySQL 同一套按钮与「手输库名」确认；④ 版本 bump + dist 一致 | C4 完成后同批（同属 db 写域，勿并行） |
| **C6** | P1 | `redis` 补「导出 / 备份」：`dump`（导出键集合为 JSON 行）或 `rdb.copy`（复制 RDB 到导出目录），二者择一，**不做导入**（导入 = 重建键空间，风险高于收益） | `../kore-plugin-redis/`、`web/redis.js` | ① 导出文件落导出目录并回 `size_bytes` + `sha256`；② 超过 1000 键分批 + 进度可见；③ 明确不提供导入并给原因；④ 版本 bump + dist 一致 | 无 |
| **C7** | P2 | 解决 `db-mysql` / `db-postgres` 互斥声明与「统一列表」的矛盾：**删除这对 `conflicts`**，改由预设（`presets/*.json`）表达「一台机推荐一种」 | `../kore-plugin-db-mysql/info.json`、`../kore-plugin-db-postgres/info.json`、`../kore-plugins/` | ① `make store-check` 24 pass；② `make presets-check` 8 pass；③ 两插件可同时安装并都被 C1 总览列出 | C1 |
| **C8** | P2 | 若要实现运行期互斥（与 C7 二选一，**默认不做**）：在 `registry` 装/启插件时校验 `Conflicts` | `internal/core/registry/` | ① 冲突安装返回 `E_CONFLICT` + 人话；② 有单测覆盖「已装 A 再装 B」；③ 不引入业务域名词表（G-01 自检） | C7 否决后才启动 |
| **C9** | P2 | v1.1 提案：`runtime-*` 装 / 切版本（前置：改 ADR-0023 增宿主写豁免 + 协议增宿主写 capability + FPM 池管理） | 跨仓，另立 ADR | 本 ADR 不定义验收；启动前必须先出 ADR | §2.3 四条件全满足 |
| **C10** | P2 | v1.1 提案：`site.setRuntime` 绑定 PHP 版本（前置 C9 的 FPM 池） | `../kore-plugin-site/`、`web/site-edit.js` | 本 ADR 不定义验收；链路形状见 §2.4 | C9 |

**写域冲突提醒**：C4 与 C5 都动 `web/db-l2.js`，属同一写域，**禁止并行派发**（同文件 + 同 UI 文案）；C1/C2/C3 分别独占 `db.js` / `runtimes.js` / `shell.js`，可并行。

## 5. 缺口清单（「现在没有、但成熟产品必须有」）

### 5.1 多数据库

| # | 能力 | 现状 | 级别 |
| --- | --- | --- | --- |
| D1 | 统一列表（所有类型的库/实例） | ❌ 无跨类型总览；`db.js` 只在两个关系型间切 tab，`redis` 另起一页 | **P0**（C1） |
| D2 | 表浏览器（关系型） | ❌ `db-mysql` / `db-postgres` 都无 `tables` 方法，只能手写 SQL（`README.md:70`） | **P1**（C4） |
| D3 | 跨类型统一备份/导出 | ⚠️ MySQL 有、PG 无、Redis 只有 `bgsave` | **P1**（C5/C6） |
| D4 | 实例管理（多 MySQL 实例） | ✅ 已具备（`config.go:291 []InstanceConfig`，前端可选实例） | 已具备，不列缺口 |
| D5 | 连接测试 / 状态 | ✅ 已具备（三插件都有 `instances` + `status`/`info`；`web/db.js` 打开即自动验证） | 已具备 |
| D6 | 命名空间/多 logical db 浏览 | ⚠️ Redis 16 个 db 无独立选择入口（键浏览只覆盖默认 db） | **P2** |
| D7 | 数据编辑（关系型行级） | ❌ 无（只有 SQL 控制台）；对标宝塔/1Panel 有表数据编辑 | **P2**（先做 D2 再谈） |
| D8 | Redis 导入 | ❌ 无，且**建议不做**（重建键空间风险 > 收益） | 明确不做 |
| D9 | 慢查询可视化 | ⚠️ 三插件后端都有 `slowlog`；MySQL/PG 前端有、Redis 有面板 | 已具备 |
| D10 | 互斥声明与聚合目标一致 | ❌ 声明互斥但内核不执行（`validate.go:322`） | **P2**（C7） |

### 5.2 环境管理

| # | 能力 | 现状 | 级别 |
| --- | --- | --- | --- |
| E1 | 查看已装版本 | ✅ 已具备（`versions` + `paths`，三 tab 一页） | 已具备 |
| E2 | **安装新版本** | ❌ 无（`README.md:176` 明确不做；写宿主，需改 ADR-0023） | **P2 / v1.1**（C9） |
| E3 | **切换版本** | ❌ 无（不切 `/etc/alternatives/php`，`use` 方法 0.2.0 已移除） | **P2 / v1.1**（C9） |
| E4 | **给站点绑定版本** | ❌ 无（`site` 22 方法零 runtime；`fastcgi` 零命中） | **P2 / v1.1**（C10） |
| E5 | 多版本共存 | ⚠️ 只能「看到」多个版本；共存本身由宿主包管理器决定 | 已具备（观测层） |
| E6 | 依赖检查（装 PHP 8.3 缺哪些包） | ⚠️ `doctor` 有 `extensions` / `version_supported` 等检查项（`web/runtimes.js:9`），但**不是「装之前需要哪些 apt 包」的预检** | **P1**（可只读实现：探测已装包 + 对照缺失清单，不装） |
| E7 | 边界口径（「只探测不改系统」） | ⚠️ 文件头写了，UI 未明示 | **P0**（C2） |

### 5.3 明确不做（v1，给理由，不是「以后再说」）

| 不做 | 理由 |
| --- | --- |
| 内核聚合 API | 违反 G-01 薄壳红线（§3 四方案对比） |
| `runtime-*` 装/切版本 | 写宿主 → 需改 ADR-0023；GB 级依赖回滚不可信；无 FPM 池则装了也用不上（§2.3） |
| `site` 绑 PHP 版本 | 前置是 FPM 池，链路三环节全缺（§1.4 / §2.4） |
| 把 `redis.js` 并入 `db.js` | 单文件 >2000 行，破坏懒加载粒度；实例语义不同构（§2.5） |
| Redis 导入 / FLUSHALL 入口 | 不可恢复；插件已在传输层拒绝（`whitelist.go:44-48`），**不得为 UI 方便而放开** |
| 多租户 / 容器编排 | G-11 非目标，与本卡无关但一并声明 |

## 6. 后果

**正面**：不新增内核代码即可满足「多数据库管理 / 环境管理」的可见性诉求；三张 P0 卡都是纯前端、可并行、各 ≤10 分钟粒度的 R1 改动；缺口清单把「做不到」的原因写成了可复核的事实，避免下一轮再争。

**负面 / 代价**：用户短期内**拿不到「一键装 PHP」**。这是明确的取舍而非遗漏：`kore` 的 v1 定位是「管理已装的软件」，不是「软件商店 + 包管理器」。若产品要转向后者，须先改 ADR-0023，本 ADR 已把触发条件与顺序写清。

**风险**：`conflicts` 声明与聚合目标矛盾（D10）若一直不处理，C1 的跨类型总览会在「两插件互斥却同时出现」时自相矛盾——C7 应在 C1 之后立即做。

## 7. 复审条件

出现以下任一情况时重开本 ADR：

1. 用户明确要求「kore 一键装 PHP / 切版本」——此时 §2.3 的四条件变成必须逐条满足的准入清单，并先出 ADR 修 ADR-0023；
2. `site` 或 `runtime-*` 任一仓新增了 runtime / FPM 相关方法（可能由他人并行实现，届时链路形状以 §2.4 为准或重新裁决）；
3. 主壳视图数超过 24 项导航容量，或首个聚合页单文件超 1200 行——需要重新评估「一域一文件」是否还成立；
4. 内核出现任何业务域名词表（`grep` 到 `internal/core` 认识「database」「runtime」等业务词）——立即按 G-01 事故处理，本 ADR 的 §3 即为判据。

## 8. 未确认项（不猜，留给下一张卡）

- `redis` 的 16 个 logical db 是否有意不支持选择（`config` 里 `db` 字段的默认值与可配范围未逐一核对）；
- `runtime-python` 的 `pip.install` 是否会写系统 site-packages（只核到 `venv.go:390` 写 venv 目录，**系统级写入路径未确认**）；
- `db-postgres` 的只读 SQL 白名单具体规则（`PLUGIN-MATURITY.md:84` 只说「只读 SQL 白名单」，未逐条核 `internal/` 实现）。
