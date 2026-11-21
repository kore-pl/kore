package config

// levenshtein 计算两个键路径的编辑距离（大小写不敏感）。
func levenshtein(a, b string) int {
	a = lowerASCII(a)
	b = lowerASCII(b)
	prev := make([]int, len(b)+1)
	curr := make([]int, len(b)+1)
	for j := 0; j <= len(b); j++ {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		curr[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curr[j] = minInt(prev[j]+1, curr[j-1]+1, prev[j-1]+cost)
		}
		prev, curr = curr, prev
	}
	return prev[len(b)]
}

// lowerASCII 只折叠 ASCII 大小写，避免为配置建议引入额外依赖。
func lowerASCII(s string) string {
	buf := []byte(s)
	for i, c := range buf {
		if c >= 'A' && c <= 'Z' {
			buf[i] = c + ('a' - 'A')
		}
	}
	return string(buf)
}

// minInt 返回三个整数中的最小值。
func minInt(values ...int) int {
	result := values[0]
	for _, v := range values[1:] {
		if v < result {
			result = v
		}
	}
	return result
}
