// Package web 把主壳前端三件套编进 kore 单二进制，供 httpapi 静态托管。
//
// 只 embed dist/ 下当次构建的三个产物：插件前端资产永不进二进制（FRONTEND §4.2）。
// 路径不带 .. 且相对本文件目录，符合 //go:embed 的约束。
package web

import "embed"

// Dist 是主壳静态资源文件系统，包含以下三个精确路径：
//
//	dist/index.html
//	dist/app.js
//	dist/style.css
//
// httpapi 用 embed.FS.ReadFile 按精确路径读取，不暴露子目录遍历面。
//
//go:embed dist/index.html dist/app.js dist/style.css
var Dist embed.FS
