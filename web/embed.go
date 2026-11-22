// Package web 把主壳前端编进 kore 单二进制，供 httpapi 静态托管。
//
// 只 embed dist/ 下当次构建的主壳产物：插件前端资产永不进二进制（FRONTEND §4.2）。
// 路径不带 .. 且相对本文件目录，符合 //go:embed 的约束。
//
// 分层：index.html + app.js + style.css 是首屏三件套（同步加载，计入首屏 gzip 预算）；
// shell.js 是布局壳（侧栏导航 + 视图路由，与 app.js 同批同步加载）；
// store.js / files.js / sites.js / tasks.js / monitor.js / settings.js / terminal.js / db.js 是视图模块，
// 由 shell 路由在切视图时渲染（terminal.js / db.js 由 shell.js 内置路由懒加载），不计首屏预算。
// 十二个文件全部编进二进制，运行期按精确路径只读托管，不暴露子目录遍历面。
package web

import "embed"

// Dist 是主壳静态资源文件系统，包含以下十二个精确路径：
//
//	dist/index.html
//	dist/app.js
//	dist/style.css
//	dist/shell.js
//	dist/store.js
//	dist/files.js
//	dist/sites.js
//	dist/tasks.js
//	dist/monitor.js
//	dist/settings.js
//	dist/terminal.js
//	dist/db.js
//
// httpapi 用 embed.FS.ReadFile 按精确路径读取，不暴露子目录遍历面。
//
//go:embed dist/index.html dist/app.js dist/style.css dist/shell.js dist/store.js dist/files.js dist/sites.js dist/tasks.js dist/monitor.js dist/settings.js dist/terminal.js dist/db.js
var Dist embed.FS
