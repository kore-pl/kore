module github.com/pengtang1024/kore/pkg/pluginapi

go 1.26

// v0.1.0 发布于 module 路径改名之前，其 go.mod 声明的是旧的
// github.com/kore-project/kore/pkg/pluginapi，无法被 https://github.com/pengtang1024/kore
// 的消费者解析；发布物不可修改（proxy/sumdb 已缓存），故标记废弃并发布 v0.1.1。
retract v0.1.0
