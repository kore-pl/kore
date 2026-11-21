package registry

// 三色标记的取值；只在 DetectCycle 内部使用。
const (
	colorWhite = iota
	colorGray
	colorBlack
)

// DetectCycle 用三色 DFS 检测依赖图中的环。
//
// 图语义：key 是插件 id，value 是它 depends_on 的 id 列表（依赖 → 被依赖）。
// 有环时返回环路径（首尾同一节点，形如 a → b → a），无环返回 nil；缺失的依赖节点
// 当作无边节点处理（M1 只校验环，不校验依赖是否已安装）。
func DetectCycle(graph map[string][]string) []string {
	color := make(map[string]int, len(graph))
	var stack, cycle []string
	var visit func(node string) bool
	visit = func(node string) bool {
		color[node] = colorGray
		stack = append(stack, node)
		for _, next := range graph[node] {
			switch color[next] {
			case colorGray:
				cycle = cyclePath(stack, next)
				return true
			case colorWhite:
				if visit(next) {
					return true
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[node] = colorBlack
		return false
	}
	for node := range graph {
		if color[node] == colorWhite && visit(node) {
			return cycle
		}
	}
	return nil
}

// cyclePath 从 DFS 栈中截出环路径，并闭合回起点节点。
func cyclePath(stack []string, node string) []string {
	for i, item := range stack {
		if item == node {
			path := make([]string, 0, len(stack)-i+1)
			return append(append(path, stack[i:]...), node)
		}
	}
	return append(append([]string{}, stack...), node)
}
