package pluginapi

import (
	"path"
	"strings"
	"unicode/utf8"
)

// 本文件是 file_write 运行时选项的**目录注入辅助**（ADR-0052 K3 接线）。
//
// 为什么必须在本包：`cmd/kored` 只拿得到安装路径，但 `nginx` / `ssl` 是薄壳门禁
// （G-01）的业务域词——往 `policy.Nginx.CertPrefixes` 赋值这件事写进 `cmd/` 或
// `internal/` 会让 thin-shell-check 直接 FAIL。策略字段本来就定义在本包，
// 注入逻辑与它同层（与 RootCommandPolicies 同口径）。

// FileWriteOptionsWithDirs 返回注入了证书/口令文件目录白名单的选项。
//
// 用法（K3 接线）：
//
//	Policy: pluginapi.FileWriteOptionsWithDirs(certDirs, authDirs)
//
// 语义（fail-closed：调用本函数**不会**放宽 `DefaultFileWriteOptions()` 的拒绝口径）：
//
//  1. certDirs / authDirs 为空（或全部条目非法）→ 对应白名单仍为空 →
//     `ssl_certificate*` / `auth_basic_user_file` 继续被拒（校验器报「白名单为空」）。
//  2. 每个目录先做**词法规范化**，再注入：
//     - 必须是绝对路径；不得含 `$`（nginx 变量展开）、反斜杠、NUL/控制字符；
//     - 不得含 `..` 段——`path.Clean` 虽然能消掉，但「消掉后再注入」等于替调用方
//     猜目标目录，这种输入只能说明给的不是确定的受控目录；
//     - 规范形式 = `path.Clean` 去掉重复分隔符/尾斜杠后再补一个 `/`
//     （`/opt/kore/data/ssl` 与 `/opt/kore//data/ssl/` 都变成 `/opt/kore/data/ssl/`）。
//     补尾斜杠是安全要求：`checkPathInPrefixes` 用 `strings.HasPrefix(value, prefix)`，
//     前缀缺尾斜杠会让 `/opt/kore/data/ssl-evil/` 命中 `/opt/kore/data/ssl`。
//     根目录 `/` 会被丢弃——它的前缀等于放行一切绝对路径，即取消白名单。
//  3. 非法条目**逐条丢弃**（函数没有 error 返回）：丢弃 = 该目录不被放行，是
//     fail-closed 的最小影响面；一条拼错不影响其它合法目录，全部丢弃则等同于空 = 拒绝。
//     被丢弃的目录在写入时会得到「不在允许前缀内」的明确报错，不会静默放行。
//  4. 本函数是**纯词法**的：不读文件系统、不 stat、**不跟随/解析符号链接**
//     （不调用 `Readlink` / `EvalSymlinks`）。理由：
//     - 注入发生在进程启动期，目录可能尚未创建；按存在性拒绝会把启动顺序变成
//     安全条件，制造难排查的静默拒绝；
//     - 注入期解析软链只是 TOCTOU 假安全——软链在注入后仍可被替换，一次检查
//     挡不住，真正的边界是「安装目录不可被非 root 改写」；
//     - 目录若本身是软链，本函数按**字面路径**注入；由此产生的读取目标由写入路径的
//     属主/模式复核（K3 `internal/platform.VerifyOwner`）与 reload 前的 `nginx -t` 兜住。
//     这两处失败都会拒绝上线配置，不会带着未知目标生效。
func FileWriteOptionsWithDirs(certDirs, authDirs []string) FileWriteOptions {
	opts := DefaultFileWriteOptions()
	opts.Nginx.CertPrefixes = normalizeFileWritePrefixDirs(certDirs)
	opts.Nginx.AuthFilePrefixes = normalizeFileWritePrefixDirs(authDirs)
	return opts
}

// normalizeFileWritePrefixDirs 把目录列表规范成「以 / 结尾的绝对前缀」，非法条目丢弃。
//
// 空输入与「全部条目非法」都返回 nil：nil 与空切片在白名单校验里等价（len == 0 → 拒绝），
// 用 nil 让调用方一眼看出「没有注入任何目录」。
func normalizeFileWritePrefixDirs(dirs []string) []string {
	if len(dirs) == 0 {
		return nil
	}
	prefixes := make([]string, 0, len(dirs))
	seen := make(map[string]struct{}, len(dirs))
	for _, dir := range dirs {
		prefix, ok := normalizeFileWritePrefixDir(dir)
		if !ok {
			continue
		}
		if _, duplicate := seen[prefix]; duplicate {
			continue
		}
		seen[prefix] = struct{}{}
		prefixes = append(prefixes, prefix)
	}
	if len(prefixes) == 0 {
		return nil
	}
	return prefixes
}

// normalizeFileWritePrefixDir 规范化单个目录；ok=false 表示该条目必须丢弃。
//
// 校验顺序与 checkPathInPrefixes 保持同口径（变量 / 绝对路径 / 规范形式 / 根目录），
// 差别只在处理方式：校验器拒绝请求，这里丢弃目录条目。
func normalizeFileWritePrefixDir(dir string) (string, bool) {
	if dir == "" || !utf8.ValidString(dir) {
		return "", false
	}
	// `$` 会被 nginx 当变量展开；反斜杠与 NUL/控制字符会让「校验看到的路径」与
	// 「nginx 解析的路径」不一致——两者都不允许进入白名单。
	if strings.ContainsAny(dir, "$\\\x00\n\r\t") {
		return "", false
	}
	if !strings.HasPrefix(dir, "/") {
		return "", false
	}
	for _, r := range dir {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	for _, segment := range strings.Split(dir, "/") {
		if segment == ".." {
			return "", false
		}
	}
	cleaned := path.Clean(dir)
	if cleaned == "." || cleaned == "/" {
		return "", false
	}
	return cleaned + "/", true
}
