// Package pluginapi 是 kore 插件协议的公开 SDK（protocol kore.plugin.v1）。
//
// 线格式：4 字节大端无符号长度 + 该长度的 UTF-8 JSON 载荷，没有任何额外帧头字节；
// length 只计载荷本身（不含长度字段的 4 字节），单帧上限 8 MiB（MaxFrameSize）。
// 帧类型写在 JSON 载荷的 type 字段里（request / response / event / ping / pong），
// 因此新增帧类型不需要改线格式；编码由 kore.hello 做会话级协商（M0 只有 json）。
//
// 标识语义：id 是连接内请求标识（32 位小写 hex），同一连接内按 id 匹配响应且不得复用；
// req_id 是跨进程追踪标识（HTTP 侧生成并透传），响应帧必须原样回显同一个 req_id。
// 两者用途不同，不得互相替代。
//
// 本包只依赖 Go 标准库，不 import 内核 internal 包，供每个插件仓库独立依赖
// （module github.com/kore-project/kore/pkg/pluginapi，按子目录 tag pkg/pluginapi/vX.Y.Z 发版）。
package pluginapi
