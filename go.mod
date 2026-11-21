module github.com/pengtang1024/kore

go 1.26

require (
	github.com/pengtang1024/kore/pkg/pluginapi v0.1.1
	go.etcd.io/bbolt v1.3.11
	gopkg.in/yaml.v3 v3.0.1
)

require golang.org/x/sys v0.4.0 // indirect

// 同仓嵌套 module：按 Go 标准做法提交 replace（只对主模块生效，下游忽略）。
replace github.com/pengtang1024/kore/pkg/pluginapi => ./pkg/pluginapi
