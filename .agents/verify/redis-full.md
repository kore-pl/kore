# Redis 运维深化验收（persistence / memory / slowlog / keyInfo · 真机 · 双端 · G-28）

> 元信息: 2026-11-23T11:55+08:00 · 执行者 r8-redis-full 子 agent · 隔离实例 18843（8787 未触碰，首尾 healthz 200）· chromium headless 手写 CDP · 报告 ≤70 行

## 1. 版本口径修正
- 任务卡写「bump → 0.3.0」，但 0.3.0 已被主实例直连密码特性占用（插件仓 a4913c2：dist/redis-0.3.0.tar.gz + 已签名索引 GitHub release）。按 G-17「同 id@version 单 sha」，本次 feat bump 为 **0.4.0**。

## 2. 四方法实现（插件仓，全部只读）
- `redis.persistence {instance?}`：INFO persistence → `{instance,aof_enabled,aof_last_write_status,aof_size(=aof_current_size),rdb_last_save_time,rdb_changes_since_save,rdb_bgsave_in_progress}`；AOF 关闭时 aof_size=0 不报错。
- `redis.memory {instance?}`：INFO memory + INFO stats + CONFIG GET maxmemory-policy → `{instance,used,peak,maxmemory,maxmemory_policy,fragmentation_ratio,eviction_keys(=evicted_keys)}`；八种淘汰策略原样透传；实例禁用 CONFIG 时策略降级空串不失败（云托管口径）。
- `redis.slowlog {instance?,limit?}`：SLOWLOG GET <limit>（默认 50 / 上限 1000）→ `{entries:[{id,ts,duration_us,command,args_summary}],count}`；单参按字符截断 128 加 `…`、最多 16 参（超出 `…(+N)`），形状异常条目跳过。
- `redis.keyInfo {instance?,key}`：单条 pipeline TYPE/TTL/MEMORY USAGE/OBJECT ENCODING → `{key,type,encoding,ttl_s,memory_bytes}`；缺键 E_NOTFOUND；Redis<4.0 降级 memory_bytes=0/encoding=""；全程无 DEBUG 命令。
- 危险面不变：CONFIG SET / FLUSHALL / SHUTDOWN / 任意命令口均不在方法面（既有断言继续成立）。

## 3. 测试与门禁（插件仓）
- 单测：INFO persistence/memory 真实格式解析（AOF 开/关两态）、CONFIG GET 扁平数组取值（大小写/缺键/奇数组）、八策略枚举透传、SLOWLOG 条目解析 + 128 字符截断（含多字节）、keyInfo pipeline 顺序 / 缺键 / 老版本降级；故障注入矩阵 5 → 9 方法（4 类 × 9 = 36 断言，纯扩容未放宽）。
- `make check`：gofmt clean / go vet / go test 全绿（5 包 ok）。
- `make dist` ×2 sha 一致 = `07a20bba780b…`；干净树（git archive）复现同一 sha；size_bytes=1446755 收敛（偏差 1B ≤ 2）。

## 4. 前端（kore 仓 web/redis.js，629 → 889 行；分页/加载更多零改动）
- 顶部 4 指标卡：内存用量（进度条 + used/maxmemory，≥80% 变红）、碎片率（≥1.5 橙警）、AOF/RDB 状态点（含未落盘变更数）、慢查询（24h 口径）。
- 键行点开 → 「键详情」侧栏（keyInfo：类型/编码/TTL/内存占用）+ 显式「读取值」——redis.get 不再盲触发；桌面双栏（键表 + sticky 侧栏），<960px 单列。
- 「慢查询」面板：128 条表（#/时间/耗时/命令）+ slowlog-log-slower-than / slowlog-max-len 阈值说明，只读。
- 新样式随视图注入（`<style data-kore-view=redis>`），web/style.css 与 shell.js 导航零改动。

## 5. 真机证据（kore 门禁：node --check ✅ / make frontend 首屏 59,308B ≤300KiB ✅ / make check 11 段 ✅）
- 隔离实例 18843：state/run/log/临时索引全在 /tmp/kore-redis-full-18843，`store.allow_unsigned=true` + 临时索引（sha256=包 sha，三端点仍强制校验）；本地包装 redis 0.4.0 + discover 0.2.0 并 enable；redis.config.set 直连密码热生效（saved=true applied=true）。
- **common-redis 7.4.12 真数据（只读，未写未删）**：
  - persistence → `{aof_enabled:true,aof_last_write_status:"ok",aof_size:27596139,rdb_last_save_time:1795405246,rdb_changes_since_save:0,rdb_bgsave_in_progress:false}`
  - memory → `{used:64759760,peak:65366424,maxmemory:0,maxmemory_policy:"noeviction",fragmentation_ratio:1.12,eviction_keys:0}`
  - keyInfo `auction:round:clock:101769` → `{type:"hash",encoding:"listpack",ttl_s:433874,memory_bytes:168}`，与容器内 redis-cli（hash/listpack/168/TTL 433880）逐项一致（TTL 为实时递减）。
  - slowlog → 缓冲为空 `{entries:[],count:0}`（真实空态）。
- **慢查询满数据**：一次性 redis:7.4.12 容器（--slowlog-log-slower-than 0，测后已删）→ count=128，样例 `{id:4042,ts:1795405361,duration_us:5,command:"AUTH",args_summary:"(redacted)"}`（Redis 7 服务端自带敏感命令脱敏，插件原样透传）。
- **keyInfo 大键速度**：2000 字段 hash（memory_bytes=352504）三次 invoke 4.6/5.8/5.1ms（HTTP 端到端），encoding=hashtable 正确。
- 空键 keyInfo 回 `E_INVALID key 不能为空`、不存在键 `E_NOTFOUND`（错误路径实测）。

## 6. 双端截图（G-28，.agents/verify/screenshots/，identify 实测，sha 互异）
| 文件 | 尺寸 | sha256(12) |
| --- | --- | --- |
| redis-ops-desktop.png | 1440x6167 | 79ee136b5cf7 |
| redis-keyinfo-desktop.png | 1440x6167 | e8e7ba3e771d |
| redis-slowlog-desktop.png | 1440x6167 | d7bbdcd5dde0 |
| redis-ops-mobile.png | 390x844 | 36b88b59cff3 |
| redis-slowlog-mobile.png | 390x844 | 338f95d5ac6c |

- 每张截图前后各有 DOM 断言（4 卡 / keyInfo=hash+hashtable+KB / 慢查询 128 行+阈值说明 / 手机 scrollWidth=390 无横向溢出）。

## 7. G-28 产品定位自评
- 解决什么：Redis 运维从「能看键」到「能判健康」——内存水位/淘汰策略/碎片率、AOF/RDB 持久化健康、慢查询定位、单键体检（编码/内存），全部只读零风险。
- 与宝塔/1Panel 差距：无 CONFIG SET 改参（有意后置到下一轮）、无命中率趋势图/键前缀分析、慢查询无导出；当前覆盖运维面板第一梯队。
- 状态：**可用**（真机 7.4.12 四方法真数据 + 大键 O(1) 实测，非占位）。

## 8. commit 与待重签清单
- 插件仓：`593f346 feat(redis): 持久化/内存/慢查询/键详情`（本地，未 push）
- kore 仓：`203ec7f feat(web): redis 运维面板`（本地，未 push）
- 待重签/发版（发版轮执行）：push 插件仓 main → tag v0.4.0 → GitHub Release 挂 dist/redis-0.4.0.tar.gz → 重签 kore-plugins 索引（redis 0.4.0：sha256=07a20bba780b1583c241322ac287379a55a1b5e0be9c397c3aaab7b05427d985，size_bytes=1446755）→ versions.lock.json 同步 → gitee 镜像双推 + release（保留最新 5）→ 8787 主实例 redis 插件 0.3.0 → 0.4.0 升级。
