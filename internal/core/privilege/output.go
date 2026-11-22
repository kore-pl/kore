package privilege

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// createOutputs 创建两个 0600 临时文件供 systemd unit 写 stdout / stderr。
func (s *Service) createOutputs() (string, string, func(), error) {
	dir := s.opts.TempDir
	stdout, err := os.CreateTemp(dir, "kore-root-stdout-*")
	if err != nil {
		return "", "", func() {}, err
	}
	stderr, err := os.CreateTemp(dir, "kore-root-stderr-*")
	if err != nil {
		_ = stdout.Close()
		_ = os.Remove(stdout.Name())
		return "", "", func() {}, err
	}
	_ = stdout.Chmod(0o600)
	_ = stderr.Chmod(0o600)
	_ = stdout.Close()
	_ = stderr.Close()
	cleanup := func() {
		_ = os.Remove(stdout.Name())
		_ = os.Remove(stderr.Name())
	}
	return stdout.Name(), stderr.Name(), cleanup, nil
}

// readOutputs 读取两个输出文件，各自截断到 limit（多读 1 字节判断是否截断）。
func readOutputs(stdoutPath, stderrPath string, limit int64) (string, string, bool) {
	stdout, truncOut := readCapped(stdoutPath, limit)
	stderr, truncErr := readCapped(stderrPath, limit)
	return stdout, stderr, truncOut || truncErr
}

func readCapped(path string, limit int64) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return string(raw), false
	}
	if int64(len(raw)) > limit {
		return string(raw[:limit]), true
	}
	return string(raw), false
}

// unitName 生成 transient unit 名：kore-root-<plugin>-<action>-<rand8>。
func unitName(pluginID, actionID string) string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("kore-root-%s-%s", pluginID, actionID)
	}
	return fmt.Sprintf("kore-root-%s-%s-%s", pluginID, actionID, hex.EncodeToString(buf[:]))
}

// sensitivePattern 命中即视为敏感参数（审计脱敏，ADR-0018 / SECURITY §11）。
var sensitivePattern = regexp.MustCompile(`(?i)(pass(word)?|token|secret|api[-_]?key|private[-_]?key)`)

// RedactArgv 把命令拼成审计字符串，敏感参数以 *** 代替。
//
// 规则：命中敏感词的 `--flag=value` 只脱敏 value；`--flag value` 脱敏下一个 arg；
// 其余整体脱敏。argv[0] 不参与脱敏失败（避免把程序名误伤得无法审计）。
func RedactArgv(argv []string) string {
	out := make([]string, len(argv))
	redactNext := false
	for index, arg := range argv {
		if redactNext {
			out[index] = "***"
			redactNext = false
			continue
		}
		if index > 0 && sensitivePattern.MatchString(arg) {
			if equal := strings.IndexByte(arg, '='); equal >= 0 {
				out[index] = arg[:equal+1] + "***"
				continue
			}
			if strings.HasPrefix(arg, "-") {
				out[index] = arg
				redactNext = true
				continue
			}
			out[index] = "***"
			continue
		}
		out[index] = arg
	}
	return strings.Join(out, " ")
}

// asProtocolError 把任意错误转成协议错误（保留已有 code）。
func asProtocolError(err error) *pluginapi.Error {
	var protocolErr *pluginapi.Error
	if errors.As(err, &protocolErr) {
		return protocolErr
	}
	return errCode(pluginapi.E_INTERNAL, err.Error(), "")
}
