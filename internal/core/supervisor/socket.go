package supervisor

import (
	"errors"
	"net"
	"os"
	"path/filepath"

	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// socketPath 返回插件 UDS 路径（<RunDir>/<id>.sock）。
func (m *Manager) socketPath(id string) string {
	return filepath.Join(m.opts.RunDir, id+".sock")
}

// listen 回收孤儿 socket 后由主壳以 server 身份 bind，并把属主收紧到插件身份。
//
// 「socket 由主壳 listen」是隔离前提：插件只拿到 connect 的权限，无法抢注或被他人冒充。
func (m *Manager) listen(inst *instance, acct platform.Account) (net.Listener, error) {
	if err := m.recoverSocket(inst.socket); err != nil {
		return nil, err
	}
	listener, err := m.opts.Transport.Listen(inst.socket)
	if err != nil {
		return nil, errf(pluginapi.E_INTERNAL, "监听插件 socket %s 失败：%v", inst.socket, err)
	}
	if err := m.ownSocket(inst.manifest.ID, inst.socket, acct); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

// recoverSocket 是孤儿 socket 回收三步：Lstat → 无进程持有则 unlink → 交给 bind。
//
// 「是否被持有」用一次 Dial 判定：连得上说明有进程在听，拒绝抢占（E_CONFLICT）；
// 连不上即视为孤儿。符号链接一律拒绝（不 unlink、不跟随），避免被诱导删除任意路径；
// 普通文件（如上次异常退出留下的垃圾）按孤儿清理——该路径由内核独占。
func (m *Manager) recoverSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errf(pluginapi.E_INTERNAL, "检查 socket %s 失败：%v", path, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errf(pluginapi.E_CONFLICT, "socket 路径 %s 是符号链接，拒绝回收", path)
	}
	if info.Mode()&os.ModeSocket != 0 {
		if conn, dialErr := m.opts.Transport.Dial(path); dialErr == nil {
			_ = conn.Close()
			return errf(pluginapi.E_CONFLICT, "socket %s 已被进程持有，拒绝抢占", path)
		}
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errf(pluginapi.E_INTERNAL, "清理孤儿 socket %s 失败：%v", path, err)
	}
	m.logger.Warn("回收孤儿 socket", "socket", path)
	return nil
}

// ownSocket 把 socket 权限收紧到 0600，降权时把属主改为 kore-<id>。
//
// socket 由主壳（root）listen、插件只 connect：0600 + 属主是「只有该插件能连」
// 的第一道边界；hello 阶段再用 SO_PEERCRED 校验 uid/pid（见 hello.go checkPeer）。
// 降权生效时 chown / chmod 失败必须失败启动——否则插件连不上 socket，只会表现成
// 一个难以归因的 hello 超时。
func (m *Manager) ownSocket(id, path string, acct platform.Account) error {
	if acct.UID > 0 {
		if err := m.access.Own(path, acct, 0o600); err != nil {
			return errf(pluginapi.E_INTERNAL, "把插件 %s 的 socket 交给 %s 失败：%v", id, describeAccount(acct), err)
		}
		return nil
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return errf(pluginapi.E_INTERNAL, "设置插件 %s 的 socket 权限失败：%v", id, err)
	}
	return nil
}

// removeSocket 删除插件 socket 文件；不存在视为成功。
func (m *Manager) removeSocket(path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		m.logger.Warn("清理插件 socket 失败", "socket", path, "err", err)
	}
}
