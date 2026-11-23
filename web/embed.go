// Package web 把主壳前端编进 kore 单二进制，供 httpapi 静态托管。
//
// 只 embed dist/ 下当次构建的主壳产物：插件前端资产永不进二进制（FRONTEND §4.2）。
// 路径不带 .. 且相对本文件目录，符合 //go:embed 的约束。
//
// 分层：index.html + style.css + app.js + shell.js + i18n.js + i18n-zh-CN.js 是首屏六件套
// （同步加载，计入首屏 gzip 预算）；i18n-en-US.js 只在用户切到英文时懒加载，不进首屏；
// store.js / files.js / sites.js / tasks.js / monitor.js / settings.js / terminal.js / db.js /
// logs.js / process.js / ssl.js / backups.js / redis.js / firewall.js / waf.js / runtimes.js / integrity.js / container.js 是视图模块，由 shell 路由在切视图时渲染
// （terminal.js / db.js / logs.js / process.js / ssl.js / backups.js / redis.js / firewall.js / waf.js / dns.js / runtimes.js / integrity.js / container.js 由 shell.js 内置路由懒加载），
// files-l2.js / site-edit.js / db-l2.js 是 files.js / sites.js / db.js 首次执行 L2 操作时
// 才注入的子模块；
// config-panel.js 是日志 / 备份页「设置」按需加载的通用配置面板；
// monitor-cards.js 是 monitor.js 进入监控视图时才注入的卡片/表格渲染构件；
// search.js 是全局搜索命令面板（首次 Ctrl/Cmd+K 或点顶栏入口才注入）；
// audit.js 是设置页「操作审计」tab（首次切到该 tab 才注入）；
// alerts.js 是顶栏铃铛的告警中心（首屏后懒探测 / 点铃铛才注入）；
// credentials.js 是凭据管理视图（切到该视图才注入）；
// charts.js 是图表运行时封装（ESM，经动态 import 进入），charts-echarts.js 是 ECharts 5
// 按需树摇后的 vendor chunk：两者都只在图表页真正建图时才由浏览器请求，不进首屏、
// 不计入首屏 gzip 预算（FRONTEND §13 / ADR-0027），但必须显式列入 embed 清单——
// go:embed 不会自己发现新文件。
// 三十七个文件全部编进二进制，运行期按精确路径只读托管，不暴露子目录遍历面。
package web

import "embed"

// Dist 是主壳静态资源文件系统，包含以下三十七个精确路径：
//
//	dist/index.html
//	dist/app.js
//	dist/style.css
//	dist/shell.js
//	dist/i18n.js
//	dist/i18n-zh-CN.js
//	dist/i18n-en-US.js
//	dist/store.js
//	dist/files.js
//	dist/files-l2.js
//	dist/sites.js
//	dist/site-edit.js
//	dist/config-panel.js
//	dist/tasks.js
//	dist/monitor.js
//	dist/monitor-cards.js
//	dist/settings.js
//	dist/terminal.js
//	dist/db.js
//	dist/db-l2.js
//	dist/logs.js
//	dist/process.js
//	dist/ssl.js
//	dist/backups.js
//	dist/redis.js
//	dist/firewall.js
//	dist/waf.js
//	dist/dns.js
//	dist/runtimes.js
//	dist/integrity.js
//	dist/container.js
//	dist/search.js
//	dist/audit.js
//	dist/alerts.js
//	dist/credentials.js
//	dist/charts.js
//	dist/charts-echarts.js
//
// httpapi 用 embed.FS.ReadFile 按精确路径读取，不暴露子目录遍历面。
//
//go:embed dist/index.html dist/app.js dist/style.css dist/shell.js dist/i18n.js dist/i18n-zh-CN.js dist/i18n-en-US.js dist/store.js dist/files.js dist/files-l2.js dist/sites.js dist/site-edit.js dist/config-panel.js dist/tasks.js dist/monitor.js dist/monitor-cards.js dist/settings.js dist/terminal.js dist/db.js dist/db-l2.js dist/logs.js dist/process.js dist/ssl.js dist/backups.js dist/redis.js dist/firewall.js dist/waf.js dist/dns.js dist/runtimes.js dist/integrity.js dist/container.js dist/search.js dist/audit.js dist/alerts.js dist/credentials.js dist/charts.js dist/charts-echarts.js
var Dist embed.FS
