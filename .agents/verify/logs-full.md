> 元信息: 2026-11-23T11:55+08:00 · 执行者 r8-logs-full（implementer）· kore-plugin-logs 0.3.0 · 前端 kore/web/logs.js · 隔离实例 `127.0.0.1:18911`（state/run/log/index 全在 `/tmp/kore-logs-verify`，`store.allow_unsigned: true` 审计放行）· 主实例 8787 未动 · 报告 ≤80 行

# logs 0.3.0 验收：搜索 / 尾部 / 导出 + 前端检索与配色

## 0. 结论

插件补齐 3 方法 + 前端修「文字墙」，全部真实数据验证：`logs.search` 全文命中 5,120 行（syslog 208,128 行 / 41.4 MB 真扫描）、`logs.tail` position 增量只回新行（801 B 新增 → 恰好 3 条、零重复）、`logs.download` 真落盘（2000 行 / 437,792 B / base64 与磁盘逐字节一致）。插件 `make check` 0 / `make dist`×2 + `git archive` 干净树 sha 逐字一致 `f00859b3…945cf`；前端 `make frontend` / `make check` 全 0。G-28 四截图已亲验。**未做**：索引重签（0.3.0 未进签名索引，主实例商店装不到，见 §8）。

## 1. 三方法（隔离实例真实 API）

| 方法 | 实测要点 |
| --- | --- |
| `logs.search {source,query,limit?}` | syslog 搜 "error"：`total:5118 count:5 truncated:true scanned:41476487`；matches 带 `line_no/time(RFC3339)/level`；字面子串（等价 grep -iF，无 subprocess、无 shell）；`query` 新字段，0.2.x `keyword` 兼容（e2e 双字段实测） |
| `logs.tail {source,lines?,position?}` | 默认 100 上限 500；`position` 增量只回完整新行；`entries` 带 `time/level`；1 MiB 前向窗口、轮转回退全量；journal 忽略 position |
| `logs.download {source,lines?}` | 落 `<插件态>/plugins/logs/exports/syslog-<UTC>.log`（0600，rename 原子写，与 db-mysql 插件态口径一致）；默认 1000 行上限 10000、5 MiB 封顶置 truncated；响应 `{path,filename,size_bytes,lines,data_base64}` |

**下载通道口径**：kore 内核无 HTTP 静态导出路由（grep ServeFile/exports 零命中）；db-mysql export 只落 exports 目录回 `file_path` 不发浏览器。本仓唯一的浏览器下载通道是 `file.download` 的 base64→Blob（files-l2.js:148），`logs.download` 沿用同通道，响应附 `data_base64`（5 MiB→6.7 MiB base64 < 8 MiB 单帧上限），前端免二次请求。

## 2. 增量 tail 证明（真机 syslog，实时增长）

```
T1: tail {lines:100}        → count=100 position=41481811（=当前文件尾）
等待自然增长：size 41481811 → 41482612（+801 B，1s）
T2: tail {position:41481811} → count=3 scanned=801 position=41482612
新行：systemd scope / wpa_supplicant SCAN-FAILED / geoclue WiFi scan failed
断言：position==新文件尾 ✓ scanned==增量区间 ✓ 无重复旧行 ✓
```

## 3. level/time 解析与字面转义（单测）

- 字面匹配：`a.b*` 只命中字面行，不命中 `axb`/`aaabbb`；`(ERROR|WARN)` 零命中该数据（TestSearchLiteralMetacharacters）。
- level：行首 64 B 窗口词边界解析，`INFORMATION`/`ERRNO`/`perror` 不误判；syslog 无级别词行为空（TestParseLineLevel 12 例）。
- time：RFC3339 / 空格分隔 / journalctl short-iso `+0800` 无冒号偏移全解析，无年份返回空串。
- position：增量 / 轮转回退 / 不完整行不下发 / keyword 过滤时偏移仍推进 / 1 MiB 跳窗置 truncated（5 测试）。
- 下载：落盘内容 / 0600 权限 / 5 MiB 封顶（1024 B 行 ×10000 → 5120 行截断）/ `safeExportName` 清洗（`../etc/passwd`→`.._etc_passwd`、空与 `.` `..` 回退 export、限长 64）。

## 4. 故障注入四类（tests/fault/，真实进程断言）

`kill`（E_UPSTREAM 进程失联）/ `timeout`（E_UPSTREAM）/ `disk-full`（E_INTERNAL）/ `cgroup-oom`（E_INTERNAL）四测试全绿；新方法同走方法入口 `checkFault`，单测另断言 `download fault=timeout → E_UPSTREAM`。

## 5. 前端（web/logs.js，274 行重写）

- 行配色：ERROR 红 / WARN 黄 / INFO 默认 / DEBUG 弱灰 + 左 2px 色条；样式随视图 `<style id="kore-logs-style">` 注入，**未动 style.css/shell.js/app.js**。
- 搜索：输入即搜防抖 300ms → `<mark>` 高亮（createTextNode 拼装，零 innerHTML）+ 页脚「命中 5,120 行 / 共 208,128 行 · 扫描 39.6 MB」。
- 级别筛选：ALL/ERROR/WARN/INFO 四 chip（客户端过滤，aria-pressed）；触屏 44px。
- 跟随：用户主动 switch（默认关）→ 每 3s 带 position 增量，保留 ≤500 行，关闭即停，`document.hidden` 暂停，报错自动停——非 G-19 轮询默认态。
- 下载：logs.download → Blob → `<a download>`（同 file.download 通道），状态回显文件名/大小/行数。

## 6. G-28 双端截图（.agents/verify/screenshots/，chromium headless + CDP 真实操作，Runtime 异常 0）

| 文件 | 尺寸 | sha256(前16) | 证据点 |
| --- | --- | --- | --- |
| `logs-search-desktop.png` | 1440×977 full | `558b1c0153451e4d` | 搜索框 "error" + `<mark>` 高亮 + 「命中 5,120 行 / 共 208,128 行 · 扫描 39.6 MB」 |
| `logs-levels-desktop.png` | 1440×900 | `df438c4b48b53dc5` | ERROR 红 / WARN 黄 / DEBUG 弱灰 / INFO 默认 + 2px 色条 + 四 chip |
| `logs-follow-desktop.png` | 1440×900 | `8eb6e36dcc3a707e` | 跟随态亮起 + 页脚「跟随中（每 3s，position 682）」+ 追加 ERROR 行实时上屏（红色） |
| `logs-mobile.png` | 390×1421 full | `258aa38892e195c` | 手机端单列堆叠、chip 44px、配色保持、无横向溢出 |

**产品定位自评**：① 解决"日志是文字墙"——错误行一眼可辨、检索即输即得、跟随看实时、导出拿得走；② 对比宝塔/1Panel：有级别配色 + 字面搜索 + 增量跟随 + 片段导出，但无正则/时间范围检索、无多文件聚合视图、无下载打包（1Panel 有日志下载）；③ 当前状态：**可用**（真实文件与 journal、真实导出），非占位。

## 7. 门禁与版本

- 插件：`make check`（gofmt/vet/test 全绿）退出码 0；`make dist`×2 sha 逐字一致 `f00859b3bc81a7b4…b07945cf`（size_bytes 1505758 收敛 ±0）；`git archive HEAD` 干净树复现同 sha；`git status` 干净。版本 0.2.1 → **0.3.0**（info.json + manifest.json + CHANGELOG）。
- 前端：`make frontend` 0（首屏 59,308 B ≤ 300 KiB）；`make check` 11/11 全过退出码 0。
- 单测计数：logic 包新增 22 个测试函数（search 4 / tail 6 / lines 3 / download 5 + 既有回归），e2e 真实进程覆盖 search(query)/tail(position)/download + 未登记来源拒绝。

## 8. 待重签清单（lead 动作）

1. `kore-plugins` 索引重签：logs 0.3.0（sha256 `f00859b3bc81a7b4d712727f46e4806e65aca29d532688e6d7400608b07945cf`，size_bytes 1505758）入 `index/plugins.json` + `versions.lock.json`。
2. 重签后主实例（8787）商店更新 logs → 0.3.0，重启 kored 使新前端生效（web/dist 已重打，主 `bin/kored` 本次未重建）。
3. 本轮未动主实例任何运行态资产（config/state/bin/kored 均未改）；隔离实例验证完即清理。

## 9. 提交

- 插件 `feat(logs): 搜索/尾部/导出`（17 文件，+1032/−66）；前端 `feat(web): 日志检索与级别配色`（+274/−60）；发版 push + tag v0.3.0 + GitHub/Gitee release 见 §10 回执。
