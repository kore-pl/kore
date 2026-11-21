package pluginapi

// Protocol 是当前插件协议标识（只承载主版本），随帧格式主版本演进。
// kore.hello 握手、info.json 校验与 kored 的版本输出统一从这里取值，禁止各处硬编码；
// 主版本变更必须走 ADR 并同时升 SDK 主版本与 kore 主版本（G-14）。
const Protocol = "kore.plugin.v1"
