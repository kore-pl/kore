// Package web 把主壳前端编进 kore 单二进制，供 httpapi 静态托管。
//
// 只 embed dist/ 下当次构建的主壳产物：插件前端资产永不进二进制（FRONTEND §4.2）。
// 路径不带 .. 且相对本文件目录，符合 //go:embed 的约束。
//
// 分层：index.html + style.css + app.js + shell.js + i18n.js + i18n-zh-CN.js 是首屏六件套
// （同步加载，计入首屏 gzip 预算）；i18n-en-US.js 只在用户切到英文时懒加载，不进首屏；
// store.js / files.js / sites.js / tasks.js / monitor.js / settings.js / terminal.js / db.js /
// logs.js / process.js / ssl.js / backups.js / redis.js / firewall.js / waf.js / runtimes.js / integrity.js / container.js / appdeploy.js / discover.js 是视图模块，由 shell 路由在切视图时渲染
// （terminal.js / db.js / logs.js / process.js / ssl.js / backups.js / redis.js / firewall.js / waf.js / dns.js / sshguard.js / runtimes.js / integrity.js / container.js / appdeploy.js / discover.js 由 shell.js 内置路由懒加载），
// files-l2.js / site-edit.js / db-l2.js 是 files.js / sites.js / db.js 首次执行 L2 操作时
// 才注入的子模块；
// config-panel.js 是日志 / 备份页「设置」按需加载的通用配置面板；
// monitor-cards.js 是 monitor.js 进入监控视图时才注入的卡片/表格渲染构件；
// search.js 是全局搜索命令面板（首次 Ctrl/Cmd+K 或点顶栏入口才注入）；
// audit.js 是设置页「操作审计」tab（首次切到该 tab 才注入）；
// alerts.js 是顶栏铃铛的告警中心（首屏后懒探测 / 点铃铛才注入）。
// onboarding.js / onboarding.css / theme.js / theme.css / shortcuts.js 是个性化组件
// （首次使用引导 / 深浅色主题 / 快捷键帮助；shell.js 首屏渲染后按 theme→shortcuts→onboarding
// 顺序懒加载并 mount，不进首屏六件套、不计首屏 gzip 预算）。
// R22 新增视图（health / calendar / batch / report / topology 等）都是 sub 懒加载模块，
// 由 app.js 的 SHELL_VIEWS 登记、切到对应 tab 才注入，不进首屏六件套、不计首屏预算。
// R23 第二批 8 个新视图（alert-rules / disk-analysis / fault-drill / macros / cert-lifecycle /
// config-drift / slow-query / log-alerts）同样走 SHELL_VIEWS sub 懒加载，均不进首屏预算。
// 全部文件编进二进制，运行期按精确路径只读托管，不暴露子目录遍历面。
package web

import "embed"

// Dist 是主壳静态资源文件系统，包含以下44个精确路径：
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
//	dist/security.js
//	dist/terminal.js
//	dist/db.js
//	dist/db-l2.js
//	dist/db-mysql.js
//	dist/logs.js
//	dist/process.js
//	dist/ssl.js
//	dist/backups.js
//	dist/redis.js
//	dist/firewall.js
//	dist/waf.js
//	dist/dns.js
//	dist/discover.js
//	dist/sshguard.js
//	dist/runtimes.js
//	dist/integrity.js
//	dist/container.js
//	dist/appdeploy.js
//	dist/search.js
//	dist/audit.js
//	dist/alerts.js
//	dist/credentials.js
//	dist/onboarding.js
//	dist/onboarding.css
//	dist/theme.js
//	dist/theme.css
//	dist/shortcuts.js
//	dist/health.js
//	dist/calendar.js
//	dist/batch.js
//	dist/report.js
//	dist/topology.js
//	dist/snapshot.js
//	dist/webhook.js
//	dist/webhook.css
//	dist/migrate.js
//	dist/site-migrate.js
//	dist/alert-rules.js
//	dist/disk-analysis.js
//	dist/fault-drill.js
//	dist/macros.js
//	dist/cert-lifecycle.js
//	dist/config-drift.js
//	dist/slow-query.js
//	dist/log-alerts.js
//
// httpapi 用 embed.FS.ReadFile 按精确路径读取，不暴露子目录遍历面。
//
//go:embed dist/index.html dist/app.js dist/style.css dist/shell.js dist/i18n.js dist/i18n-zh-CN.js dist/i18n-en-US.js dist/store.js dist/files.js dist/files-l2.js dist/sites.js dist/site-edit.js dist/config-panel.js dist/tasks.js dist/monitor.js dist/monitor-cards.js dist/settings.js dist/security.js dist/terminal.js dist/db.js dist/db-l2.js dist/db-mysql.js dist/logs.js dist/process.js dist/ssl.js dist/backups.js dist/redis.js dist/firewall.js dist/waf.js dist/dns.js dist/sshguard.js dist/runtimes.js dist/integrity.js dist/container.js dist/appdeploy.js dist/discover.js dist/search.js dist/audit.js dist/alerts.js dist/credentials.js dist/onboarding.js dist/onboarding.css dist/theme.js dist/theme.css dist/shortcuts.js dist/health.js dist/calendar.js dist/batch.js dist/report.js dist/topology.js dist/snapshot.js dist/webhook.js dist/webhook.css dist/migrate.js dist/site-migrate.js dist/alert-rules.js dist/disk-analysis.js dist/fault-drill.js dist/macros.js dist/cert-lifecycle.js dist/config-drift.js dist/slow-query.js dist/log-alerts.js
var Dist embed.FS
