module github.com/kore-project/kore

go 1.26

require github.com/kore-project/kore/pkg/pluginapi v0.1.0

// 同仓嵌套 module：按 Go 标准做法提交 replace（只对主模块生效，下游忽略）。
replace github.com/kore-project/kore/pkg/pluginapi => ./pkg/pluginapi
