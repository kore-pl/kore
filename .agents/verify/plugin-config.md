# 插件统一配置契约 · 试点验收（真机 · 双端 · G-28）

> 元信息: 2026-11-23T01:20+08:00 · 执行者 config-contract 子 agent · 隔离实例 18879 · 报告 ≤90 行

## 1. 环境与隔离
- 实例 `127.0.0.1:18879`，state/run/log/config 全在 `/tmp/kore-cfg-18879`；**8787 / 18880 未触碰**。
- `make build` → `bin/kored`；`kored install --package` 装 logs 0.2.0 + backup 0.2.0（均 exit 0），`enable` 均 HTTP 200（lazy）。
- 启动前**未导出** `KORE_LOGS_SOURCES` / `KORE_BACKUP_*`，`config.get` 首读 `source=default`，证明后续生效来自界面而不是环境变量。

## 2. 契约与实现（docs/PLUGIN-CONFIG.md）
- 方法：`<id>.config.get` → `{schema,values,source}`；`<id>.config.set {values}` → `{saved,applied,restart_required,warnings}`。
- 字段枚举：`string|int|bool|select|list`，`list.item` 仅标量；每字段 `key/label/type/default/required/help`，可选 `options/min/max/placeholder/sensitive/item`。
- 存储：`<KORE_STATE_DIR>/config.json`（即 `<state_dir>/plugins/<id>/config.json`），0600；`config.set` 顺序固定「校验 → 原子写（临时文件+fsync+rename）→ 更新内存 → applied」。
- 优先级：`config.json` > 环境变量 > 代码默认值；两插件均保留旧环境变量兼容。
- 试点字段：logs `sources: list(string)`（`名称=绝对路径` / `名称=journal`）；backup `dir: string`、`allow_roots: list(string)`（默认 `/var/www`、`/etc/kore`）。
- 敏感字段：`plugincfg.MaskValues` 把 `sensitive:true` 值替换为 `"***"`，`IsSensitivePlaceholder` 识别 `"***"` 表示不修改；两个试点当前无密码字段，分支由单测覆盖（§4）。
- 前端：`web/config-panel.js`（250 行）`window.KoreConfig.open(container, pluginId, opts)`；`shell.js` 按需注入；logs/backups 页右上角「⚙ 设置」入口；每字段 label + 一行 help，list 可增删，保存成功提示「已保存，立即生效」，`restart_required` 分支提示「需重启 kored 生效」。

## 3. 真机证据：不重启、保存即生效
| 步骤 | 证据 |
| --- | --- |
| logs 初始 | `config.get`：`values.sources=[]`、`source=default` |
| logs 界面添加 | UI 输入 `syslog=/var/log/syslog` → 保存 → 面板 `已保存，立即生效`；随后 `config.get` 返回 `source=file`、`values.sources=["syslog=/var/log/syslog"]` |
| logs 热生效 | 同一进程 `logs.sources` → `count=1`、`name=syslog`、`readable=true`、`size_bytes=27566323`；`logs.stats` 行数 142221 |
| logs 进程 | 保存前后插件 PID **3611776 不变**；`/api/v1/plugins` `restarts=0` |
| logs 落盘 | `state/plugins/logs/config.json` 权限 **600**、38 B、内容 `{"sources":["syslog=/var/log/syslog"]}` |
| backup 界面改配 | UI 把 `dir` 改 `/tmp/kore-cfg-18879/backups-ui`、`allow_roots` 改 `/tmp/kore-cfg-18879/data` → 保存 → `已保存，立即生效` |
| backup 热生效 | 同进程 `backup.create` → `id=cfg-ui-20261122T171827Z`、264 B、2 条目；落盘 `backups-ui/` 三个 0600 文件 |
| backup 二次热换 | 同进程 `dir→backups-ui2` → create 成功 → `dir→backups-ui`；PID **3619437 三次不变**（`PID_UNCHANGED`） |
| backup 落盘 | `state/plugins/backup/config.json` 权限 **600**、83 B、内容含 `dir` 与 `allow_roots` |
| kored | 全程 PID **3611417** 未重启；两插件 `restarts=0` |
| 非法值 | 单测覆盖：`sources:["missing-equals"]`、`allow_roots:["relative/path"]` → `E_INVALID`，不写盘、旧配置保留 |

## 4. 敏感字段不回落证据
- `go test -run TestMaskValuesNeverReturnsSecret -v ./internal/plugincfg/`（logs 与 backup 两仓）→ `PASS`；断言 `s3cr3t` 不出现在掩码结果、值变为 `"***"`、`IsSensitivePlaceholder("***")=true`。
- `config.get` 每次输出都经 `plugincfg.MaskValues(schema, values)`；当前 schema 无 `sensitive:true` 字段，因此真机响应不含可掩码字段（如实披露，未伪造密码字段）。

## 5. 双端截图（每张前后断言：无 `#kore-password`、含「概览」、页面关键字命中；sha 两两不同）
| 文件 | 尺寸 | bytes | sha256(12) | 页内断言 |
| --- | --- | --- | --- | --- |
| cfg-logs-desktop-panel.png | 1440x900 | 153606 | 3d57a25504a0 | 日志设置 / 已保存，立即生效 / syslog=/var/log/syslog |
| cfg-logs-desktop.png | 1440x900 | 198256 | bcfacc6433df | 已保存，立即生效 / syslog / 可读 |
| cfg-logs-mobile-panel.png | 390x844 | 60355 | 862ce09ec221 | 日志设置 / 日志来源 / 每项一条 |
| cfg-logs-mobile.png | 390x844 | 53082 | 522ba127dfa0 | syslog / 可读 |
| cfg-backup-desktop-panel.png | 1440x900 | 98374 | ee923ef85adf | 备份设置 / 备份目录 / 允许的根路径 / 已保存，立即生效 |
| cfg-backup-desktop.png | 1440x900 | 104421 | 822e43b41e1e | 备份已创建 / cfg-ui / 正常 |
| cfg-backup-mobile-panel.png | 390x844 | 73258 | bd810a40f705 | 备份设置 / 备份目录 / 允许的根路径 |
| cfg-backup-mobile.png | 390x844 | 59493 | 888898b79a64 | 备份已创建 / cfg-ui |
- `file` 实测 8/8 PNG 宽高正确；8 个 sha **8 unique / 0 重复**；移动端 390 宽无页面级横向溢出（表格/结果区自身滚动）。

## 6. G-28 产品定位自评
- **日志页**：① 不登 SSH、不重启内核即可登记来源并立即查看 tail/搜索/统计；② 与宝塔/1Panel 差距：无实时 follow、日志级别可视化筛选；③ **可用**（真实 syslog 26.3 MB / 142221 行读取，空态与错误态完整）。
- **备份页**：① 小白可在页面改备份目录与允许根路径，保存后直接创建备份；② 差距：备份源路径仍需手填（非目录选择器）、无定时备份；③ **可用**（真实 tar.gz 264 B / 2 条目 / sha256 校验）。

## 7. 门禁（命令 + 退出码）
- logs 仓：`make check` → **0**（gofmt clean / vet / 5 包 test 全 ok）；`make build && make dist` 两次 → **0/0**，sha `7f655b9b47c8…` 两次一致。
- backup 仓：`make check` → **0**；`make build && make dist` 两次 → **0/0**，sha `779fbdb5d69e…` 两次一致。
- kore 仓：`go vet ./...` → **0**；`make frontend` → **0**（首屏 gzip 36758 B / 307200 B）；`make docs-check` → **0**（6 pass / 0 warn / 0 fail）；`make check` → **0**（10/10 段）。
- 代码行数：`web/config-panel.js` 250 行；`docs/PLUGIN-CONFIG.md` 114 行。

## 8. 清理与已知边界
- 截图用的 chromium 与 `/tmp/kore-cfg-18879` 保留到交接后清理；18879 实例仍在运行，未触碰 8787/18880。
- 已知边界：`restart_required=true` 分支无真机对象（两试点均可热更），仅由前端代码分支覆盖；`config.set` 不支持删除配置文件恢复 env（清空列表=不用来源，语义明确）。
- 跨轨改动披露：`Makefile` / `web/embed.go` / `docs/FRONTEND.md` / `QUICKSTART.md` 提交时同时包含 `ui-file-site-l2` 轨已有的 18→19 文件接线（files-l2/site-edit），本轨只追加 config-panel；未提交他轨的 `web/files.js` / `web/sites.js` / `web/style.css` / `handlers_invoke.go` / 根 `CHANGELOG.md`。

## 9. 提交
- `kore-plugin-logs`：`f1ca141`（feat(config): 统一插件配置契约）
- `kore-plugin-backup`：`bc72ea7`（feat(config): 统一插件配置契约）
- `kore`：`846f5e97`（feat(config): 契约 + 双插件试点 + 通用配置面板；本报告随该提交入库，hash 回填见 `git log -- .agents/verify/plugin-config.md`）

