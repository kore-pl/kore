// Package privilege 是 ADR-0018 的提权通道 v0.x：内核代理执行插件声明的
// root_actions（固定 argv，经 systemd-run 的 transient unit 以 uid=0 运行）。
//
// 薄壳边界：本包只做 schema 校验、执行、确认令牌与审计事件构造；不认识
// ufw/nginx 等业务语义（G-01），也不直接 import store——审计经单方法接口由
// 装配层写入 bbolt（与 supervisor.Auditor 同形）。
package privilege

import (
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// ValidateAction 校验一条 root_actions 的 schema（协议规则唯一实现在
// pkg/pluginapi，本包作为内核侧入口，registry 只调用这里，不重复实现）。
//
// 非法 id / argv（空、含控制字符、argv[0] 非绝对路径且不在命令白名单）/
// timeout_s 越界都会被拒绝。
func ValidateAction(action pluginapi.RootAction) error {
	return pluginapi.ValidateRootAction(action)
}
