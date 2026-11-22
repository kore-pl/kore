// Package web 把主壳前端编进 kore 单二进制，供 httpapi 静态托管。
//
// 只 embed dist/ 下当次构建的主壳产物：插件前端资产永不进二进制（FRONTEND §4.2）。
// 路径不带 .. 且相对本文件目录，符合 //go:embed 的约束。
//
// 分层：index.html + app.js + style.css 是首屏三件套（同步加载，计入首屏 gzip 预算）；
// shell.js 是布局壳（侧栏导航 + 视图路由，与 app.js 同批同步加载）；
// store.js / files.js / sites.js / tasks.js / monitor.js / settings.js / terminal.js / db.js /
// logs.js / process.js / ssl.js / backups.js / redis.js / firewall.js 是视图模块，由 shell 路由在切视图时渲染
// （terminal.js / db.js / logs.js / process.js / ssl.js / backups.js / redis.js / firewall.js 由 shell.js 内置路由懒加载），
// files-l2.js / site-edit.js / db-l2.js 是 files.js / sites.js / db.js 首次执行 L2 操作时
// 才注入的子模块；
// config-panel.js 是日志 / 备份页「设置」按需加载的通用配置面板；
// monitor-cards.js 是 monitor.js 进入监控视图时才注入的卡片/表格渲染构件；
// search.js 是全局搜索命令面板（首次 Ctrl/Cmd+K 或点顶栏入口才注入）；
// audit.js 是设置页「操作审计」tab（首次切到该 tab 才注入）。
// 二十五个文件全部编进二进制，运行期按精确路径只读托管，不暴露子目录遍历面。
package web

import "embed"

// Dist 是主壳静态资源文件系统，包含以下二十五个精确路径：
//
//	dist/index.html
//	dist/app.js
//	dist/style.css
//	dist/shell.js
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
//	dist/search.js
//	dist/audit.js
//
// httpapi 用 embed.FS.ReadFile 按精确路径读取，不暴露子目录遍历面。
//
//go:embed dist/index.html dist/app.js dist/style.css dist/shell.js dist/store.js dist/files.js dist/files-l2.js dist/sites.js dist/site-edit.js dist/config-panel.js dist/tasks.js dist/monitor.js dist/monitor-cards.js dist/settings.js dist/terminal.js dist/db.js dist/db-l2.js dist/logs.js dist/process.js dist/ssl.js dist/backups.js dist/redis.js dist/firewall.js dist/search.js dist/audit.js
var Dist embed.FS
