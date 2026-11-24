package pluginapi

import (
	"fmt"
	"path"
)

// 本文件是 ADR-0053 受控删除的**协议层**（ADR-0052 受控写的对称补充）。
//
// 为什么必须有独立原语而不是复用别人：
//   - 复用 `purge_op` 当正常删除 = 权限放大。purge_op 只有 kind+args，没有类别约束，
//     路径完全由插件给（validatePurgePath 只挡 `/` 与 `..`），一旦可当请求用，插件就从
//     「只能写 /etc/nginx/conf.d/kore-site-*.conf」变成「能删宿主上任意绝对路径」。
//     purge_op 的语义方向也相反：它描述「如何撤销这个动作」，不是「这个动作是什么」。
//   - 用 `file_write` 写空正文代替删除 = 语义错。协议层拒空正文（ValidateFileWriteContent
//     「正文不能为空」），且 nginx 仍会 include 该文件（`*.conf` 通配），站点的 server 块
//     消失但「文件还在」，用户看到的是「站删了又没删」。
//
// 形状与 FileWrite 对称：只声明**类别**，不声明目录、不声明文件名——目录只在
// FileWritePrefixClasses 定义一次，文件名在请求期按同一套归属规则校验
// （`kore-<plugin>-*.conf`），所以「删别人的文件」在同一层被拒。

// FileDelete 是 root_actions[] 的可选声明：受控删除（ADR-0053）。
//
// 字段刻意只有 prefix_class：删除没有「内容策略」也没有「权限位」可谈，
// 任何可调项都会变成被校验方的自由度。备份不是可选项——见 ValidateFileDelete。
type FileDelete struct {
	// PrefixClass 是白名单类别名（复用 FileWritePrefixClasses 的单一真源）。
	PrefixClass string `json:"prefix_class"`
}

// ValidateFileDelete 校验 file_delete 声明本身。
func ValidateFileDelete(decl *FileDelete) error {
	if decl == nil {
		return fmt.Errorf("file_delete 为空")
	}
	if _, ok := FileWritePrefixClasses[decl.PrefixClass]; !ok {
		return fmt.Errorf("file_delete.prefix_class=%q 不在白名单类别内（允许：%s）",
			decl.PrefixClass, fileWriteClassNames())
	}
	return nil
}

// ValidateFileDeleteTarget 校验 target：必须是类别目录本身（与写同口径）。
//
// 理由同 ValidateFileWriteTarget：target 是变更账本里的人话影响对象，插件若可自填，
// 账本就会写一个与真实删除无关的路径，用户按账本回滚会回滚错对象。
func ValidateFileDeleteTarget(decl *FileDelete, target string) error {
	if decl == nil {
		return fmt.Errorf("file_delete 为空")
	}
	class, ok := FileWritePrefixClasses[decl.PrefixClass]
	if !ok {
		return fmt.Errorf("file_delete.prefix_class=%q 不在白名单类别内", decl.PrefixClass)
	}
	if target != class.Dir {
		return fmt.Errorf("file_delete 动作的 target 必须是类别目录 %q（当前 %q）", class.Dir, target)
	}
	return nil
}

// FileDeletePath 返回被删文件的绝对路径（类别目录 + 文件名）。
//
// 文件名校验**复用** ValidateFileWriteName：同一个类别里「谁能写这个文件」与
// 「谁能删这个文件」必须是同一套规则，否则 A 插件可以删 B 插件写的片段
// （`kore-<plugin>-` 前缀校验是横向隔离的唯一抓手）。
func FileDeletePath(pluginID string, decl *FileDelete, name string) (string, error) {
	if decl == nil {
		return "", fmt.Errorf("file_delete 为空")
	}
	// 把声明投影成同类别 FileWrite，让归属/后缀/字符集规则只有一份实现。
	asWrite := &FileWrite{PrefixClass: decl.PrefixClass}
	if err := ValidateFileWriteName(pluginID, asWrite, name); err != nil {
		return "", err
	}
	class := FileWritePrefixClasses[decl.PrefixClass]
	full := class.Dir + name
	if path.Clean(full) != full {
		return "", fmt.Errorf("拼出的路径不是规范形式：%q", full)
	}
	return full, nil
}

// ValidateFileDeleteRequest 是删除请求的协议校验入口（文件名 → 路径）。
func ValidateFileDeleteRequest(pluginID string, action RootAction, name string) error {
	if action.FileDelete == nil {
		return fmt.Errorf("动作 %q 没有 file_delete 声明，不能删除文件", action.ID)
	}
	_, err := FileDeletePath(pluginID, action.FileDelete, name)
	return err
}

// validateFileDeleteAction 校验 file_delete 动作的跨字段一致性（供 ValidateRootAction 调用）。
func validateFileDeleteAction(action RootAction) error {
	if err := ValidateFileDelete(action.FileDelete); err != nil {
		return err
	}
	// 删除不执行外部命令：声明 argv 一律拒绝（同一动作两条执行语义，审计无法收敛）。
	if len(action.Argv) != 0 {
		return fmt.Errorf("file_delete 动作不得声明 argv（删除不执行外部命令，当前 %d 项）", len(action.Argv))
	}
	// 删宿主文件是零侵入豁免 #3 的宿主变更：必须显式 writes_host=true，
	// 让 confirm 判据与 changes.jsonl 账本链路生效（与 file_write 同口径）。
	if !action.WritesHost {
		return fmt.Errorf("file_delete 动作必须 writes_host=true（删宿主文件要进变更账本）")
	}
	// 声明里不得带静态 purge_op：删除的回滚信息（备份路径）只能在运行时得到，
	// 静态 purge_op 会让账本写一个与本次删除无关的回滚目标。
	if action.PurgeOp != nil {
		return fmt.Errorf("file_delete 动作不得声明静态 purge_op（回滚信息由内核按备份路径运行时生成）")
	}
	return ValidateFileDeleteTarget(action.FileDelete, action.Target)
}
