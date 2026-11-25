> 元信息: 2026-11-25T12:25+08:00 · 执行者 feat-appdeploy-templates（implementer）· 写域 kore-plugin-app-deploy + kore/web/appdeploy.js · 隔离实例 127.0.0.1:50593（config/state/run/log 全在 /tmp，跑完即删）· 主实例 8787 零写入

# 应用部署：模板 4→9 + 一键部署体验 + 部署后可见（v0.4.0）

## 0. 结论

三张卡的目标全部落地，且**新增后端方法在真实 docker 上跑通**（E2E exit 0）：
1. **模板 4 → 9**：新增 `node-app` / `python-app` / `php-site` / `mysql-phpmyadmin`（双容器）/ `uptime-kuma`，每条带端口默认值、env（含必填/口令语义）、数据卷与中文说明；既有 4 条保持原位（顺序与默认端口不变）。
2. **一键部署体验**：模板读取时现算「此刻可用」端口（`suggested_host_port`）、应用名按现有部署去重自动填、bind 挂载自动落可访问示例入口（`server.js` / `app.py` / `index.php`，已有文件不覆盖）；部署成功后直接给「打开访问地址 / 查看日志 / 停止 / 删除」+ 下一步说明。
3. **部署后可见**：列表改为卡片（状态 · 端口映射 · 访问地址 · CPU/内存占用概览 · 行内操作），新增「运行日志」面板（可选应用/行数/刷新，stdout+stderr 合并、64 KiB 截断标记）；状态词从内部值 `exited` 改为「已停止」。

## 1. 依据（path:line）

| 事实 | 位置 |
| --- | --- |
| 9 个内置模板（4 旧 + 5 新），顺序稳定 | `kore-plugin-app-deploy/internal/apop/templates.go:13`、`:190`（node-app）、`:220`（python-app）、`:250`（php-site）、`:274`（mysql-phpmyadmin）、`:329`（uptime-kuma） |
| 端口建议：深拷贝 + 从默认端口向上找「docker ps 未占且本机可绑」的第一个 | `templates.go:390`（cloneTemplate）、`:402-434`（templatesWithPortSuggestions）、`:438`（callTemplates） |
| 示例入口表（按模板 id+卷名登记，绝不覆盖用户文件） | `internal/apop/deploy.go:323`（bindSeeds）、`:406`（seedBindVolume） |
| phpMyAdmin 内部连接变量（PMA_HOST/PMA_PORT/PMA_DB_NAME + 随机会话密钥） | `deploy.go:486`（deriveEnv） |
| 新方法 stop/start/logs（只按记录里的容器名，不改写记录） | `internal/apop/control.go:72`、`:82`、`:121` |
| 控制面为执行面**可选**接口，缺失回 E_UNSUPPORTED | `internal/apop/types.go:374`（Controller） |
| docker stop/start/logs/stats 实现（stdout+stderr 合并、tail 夹取） | `internal/apop/docker_control.go:40`、`:64` |
| list 资源占用聚合 + 失败可见（usage_error） | `internal/apop/list.go:39`（attachUsage） |
| 前端：端口/名称预填、日志面板、卡片列表、部署后下一步 | `kore/web/appdeploy.js:279`（MIN_CONTROL_VERSION）、`:291`（suggestName）、`:352`（paintList）、`:421`（paintLogs）、`:465`（loadLogs）、`:328`（doControl）、`:711`（paintDeployResult）、`:541`（statusText） |
| 能力声明 11 条（stop/start=admin，logs=read） | `kore-plugin-app-deploy/info.json` method_capabilities |

## 2. 用户可见行为（命令 + 退出码）

**真实 docker E2E**（`KORE_APP_E2E=1 KORE_APP_E2E_ROOT=<repo>/.e2e-root go test -count=1 -run TestAppDeployDockerE2E -v ./tests/e2e/` → **exit 0**，15.56s）：

- templates：`count:9` + 每条端口带 `suggested_host_port`（18090/18091/16379/15432/18092/18093/18094/18095+13306/18096）
- deploy nginx-static → `curl http://127.0.0.1:18090/` **200**，正文含「Kore 应用部署示例 / 静态站点已就绪：kore-app-test」（证明示例入口真落盘）
- list：`status:"running"` + `usage:{cpu_percent:0, mem_used_bytes:19251855, mem_limit_bytes:134217728}`
- **stop** → `{action:"stop",status:"exited"}`，list 变 `exited`；**start** → `{action:"start",status:"running"}`，list 回 `running`
- **logs** → 200 行真实 nginx stdout（`/docker-entrypoint.sh...` + `GET /`）
- wordpress 双容器 200、remove 清理卷/网络、末尾零残留

**单元/门禁**：`make check`（gofmt+vet+test+boundary -race）**exit 0**；kore `go build ./...` + `go test ./...` **exit 0（0 FAIL）**；`node --check web/appdeploy.js` **exit 0**；`make secret-check` **exit 0**（0 FAIL / 22 处占位合规）；`scripts/frontend-check.sh` 首屏 **81528 B / 307200 B**（视图模块懒加载，d(首屏)/d(视图)=0 不变）。

## 3. G-28 双端截图（file 实测宽高）

| 场景 | 文件 | 宽高 |
| --- | --- | --- |
| 列表 + 模板预填 | `appdeploy-list-desktop-01.png` | 1440×1892（full-page） |
| 列表 + 模板预填 | `appdeploy-list-mobile-01.png` | 390×844 |
| 点「日志」后日志面板 | `appdeploy-logs-desktop-01.png` | 1440×1982（full-page） |
| 点「日志」后日志面板 | `appdeploy-logs-mobile-01.png` | 390×844（日志正文在视口内，长行自动换行） |

生成方式：`scripts/ui-shot.sh --route sites/appdeploy` + playwright 真点击「日志」按钮（`meta=kore-app-wp · web 容器 · 最近 200 行` 断言通过），隔离实例，跑完即删。
**如实说明**：隔离实例未装插件，故视图数据来自 **同形状 mock API**（templates 9 条 / list 3 条含 usage / logs 6 行）；**后端真实行为由 §2 的真 docker E2E 覆盖**，两者互补，不把 mock 当后端证据。

## 4. 产品定位自评（G-28 三问）

**① 解决什么问题**：把「选应用 → 起服务 → 看到东西 → 出问题看日志 → 不用了就停/删」压到一页：选模板（端口已探测、名称已填好、点一次就部署）→ 成功后直接给访问地址/日志/停止/删除。
**② 与宝塔 / 1Panel 差距**：它们有几十个应用的商店与依赖编排；本插件现在 9 个模板、单/双容器、无跨插件编排（建站归 site、建库归 db-mysql，G-13 不互调），差距在「应用数量」与「组合编排」，已补齐「模板→部署→可见→可管」的闭环与资源占用概览。
**③ 可用还是占位**：**可用**——真实 docker 全链路 exit 0，UI 双端可点。

## 5. G-29 / 提交

本轮**未改动主实例运行态**（`.kore-local*` 零写入，8787 只读探测）；E2E 容器名 `kore-app-*` 由测试兜底清理（末断言零残留），数据根落仓库内 `.e2e-root` 且跑完删除（docker daemon 看不到宿主 /tmp，故 E2E 支持 `KORE_APP_E2E_ROOT`）。
提交：plugin `[agent:feat-appdeploy-templates] feat(apop): ...（v0.4.0）` + 本轮 seed/E2E 修订；kore `[agent:feat-appdeploy-templates] feat(appdeploy): ...` + 本报告与 4 张截图。不 push。

## 6. 需要 lead 处理的事项

1. **索引待重签**：仓库 `info.json` 已 0.4.0、dist 已出（sha256 `c3412dbe1b004221468e802683b7d31ba6211eda50f4652edebdc8dc8c4175d1`），`kore-plugins` 索引仍是 0.3.3 → 商店拿不到 0.4.0（不属本卡写域）。
2. **PLUGIN-MATURITY 需更新**（他人写域）：app-deploy 行「4 模板 / L1.5 因无 G-28 截图压住不升」已失效——现有 2 组双端截图 + 真实 docker E2E，可评 L2。
3. 仓库内 `zero_param_test.go` 是**他人未提交**遗留（未跟踪，非本卡改动），未提交、未删除。
