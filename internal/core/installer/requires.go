package installer

import (
	"fmt"
	"strconv"
	"strings"
)

// semver 是 M1 接受的三段数字版本；不识别预发布号。
type semver [3]int

// versionRange 是 requires_kore 解析结果：lower 含、upper 不含。
type versionRange struct {
	// lower 是下界（含）。
	lower semver
	// upper 是上界（不含）。
	upper semver
	// hasUpper 表示是否声明了上界。
	hasUpper bool
}

// parseSemver 解析 MAJOR.MINOR.PATCH；拒绝前导零、预发布与元数据。
func parseSemver(raw string) (semver, error) {
	var version semver
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return version, fmt.Errorf("版本 %q 不是三段", raw)
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return version, fmt.Errorf("版本 %q 的第 %d 段非法", raw, index+1)
		}
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return version, fmt.Errorf("版本 %q 的第 %d 段不是非负整数", raw, index+1)
		}
		version[index] = value
	}
	return version, nil
}

// compareSemver 返回 -1 / 0 / 1。
func compareSemver(left, right semver) int {
	for index := range left {
		switch {
		case left[index] < right[index]:
			return -1
		case left[index] > right[index]:
			return 1
		}
	}
	return 0
}

// parseBound 解析一个区间片段（如 ">=0.1.0"），要求以指定运算符开头。
func parseBound(token, operator string) (semver, error) {
	rest, ok := strings.CutPrefix(token, operator)
	if !ok {
		return semver{}, wrap(ErrInvalid, "requires_kore 片段 %q 必须以 %q 开头", token, operator)
	}
	version, err := parseSemver(rest)
	if err != nil {
		return semver{}, wrap(ErrInvalid, "requires_kore 片段 %q：%v", token, err)
	}
	return version, nil
}

// parseRequiresKore 只支持 ">=X.Y.Z" 与 ">=X.Y.Z <A.B.C"；不支持 ^ / ~ / ||。
func parseRequiresKore(expr string) (versionRange, error) {
	fields := strings.Fields(expr)
	if len(fields) < 1 || len(fields) > 2 {
		return versionRange{}, wrap(ErrInvalid,
			"requires_kore=%q 只支持 \">=X.Y.Z <A.B.C\" 或 \">=X.Y.Z\"", expr)
	}
	lower, err := parseBound(fields[0], ">=")
	if err != nil {
		return versionRange{}, err
	}
	out := versionRange{lower: lower}
	if len(fields) == 2 {
		upper, err := parseBound(fields[1], "<")
		if err != nil {
			return versionRange{}, err
		}
		out.upper, out.hasUpper = upper, true
	}
	return out, nil
}

// CheckRequiresKore 校验插件声明的内核区间是否覆盖当前版本（校验 step 6）。
//
// 语义按 PLUGIN-PROTOCOL §3：下界含、上界不含；kore 版本含预发布/元数据时
// 不参与区间匹配（MVP 不认 pre-release），一律按不满足处理。
func CheckRequiresKore(expr, koreVersion string) error {
	expected, err := parseRequiresKore(expr)
	if err != nil {
		return err
	}
	if strings.ContainsAny(koreVersion, "-+") {
		return wrap(ErrUnsupported, "kore 版本 %q 含预发布/元数据，MVP 不参与 requires_kore 匹配", koreVersion)
	}
	current, err := parseSemver(koreVersion)
	if err != nil {
		return wrap(ErrUnsupported, "kore 版本 %q 无法解析，不能匹配 requires_kore=%q", koreVersion, expr)
	}
	belowLower := compareSemver(current, expected.lower) < 0
	aboveUpper := expected.hasUpper && compareSemver(current, expected.upper) >= 0
	if belowLower || aboveUpper {
		return wrap(ErrUnsupported, "requires_kore=%q 不满足当前内核 %s", expr, koreVersion)
	}
	return nil
}
