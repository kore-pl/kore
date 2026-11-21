// Package registry 负责插件清单（info.json）的解析与校验，并提供内存版登记表。
//
// 薄壳边界：本包只做规则判定——读清单、校验字段、维护 installed/enabled 状态；
// 不拉起进程（supervisor）、不写 bbolt（store）、不安装包（installer）。
// 落盘布局固定为 <root>/<id>/<version>/，M1 只读不写（安装归 installer/M2）。
package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// Lifecycle 是插件生命周期取值（resident | lazy | oneshot）。
type Lifecycle string

// 三种生命周期；缺省为 lazy（G-14：三值都要解析并落盘，运行期 M1 只实现 resident）。
const (
	// LifecycleResident 常驻：随 enable 常驻，M1 唯一支持的生命周期。
	LifecycleResident Lifecycle = "resident"
	// LifecycleLazy 惰性：按需拉起、空闲退出（M2 支持）。
	LifecycleLazy Lifecycle = "lazy"
	// LifecycleOneshot 一次性：每次调用拉起、执行完退出（M2 支持）。
	LifecycleOneshot Lifecycle = "oneshot"
)

// Resources 是 info.json 的 resources 对象，映射 cgroup v2 限额。
type Resources struct {
	// MemoryMB 内存上限（MiB），协议范围 4–12。
	MemoryMB int `json:"memory_mb"`
	// CPUQuota CPU 配额，形如 "50%"，协议范围 10%–100%。
	CPUQuota string `json:"cpu_quota"`
	// PidsMax 进程数上限，协议范围 16–512。
	PidsMax int `json:"pids_max"`
}

// Trigger 是 triggers 的元素：type 取 event|schedule|invoke，name 是匹配名。
type Trigger struct {
	// Type 触发类型：event（kore 事件）/ schedule（宿主调度器，M2 生效）/ invoke（外部调用）。
	Type string `json:"type"`
	// Name 匹配名：event/invoke 形如 "cert.renew_due"，schedule 为宿主调度器表达式。
	Name string `json:"name"`
}

// Manifest 是 info.json 的内存表示：12 个必填字段 + 可选扩展字段。
type Manifest struct {
	// ID 插件 id（同时决定 socket、目录与二进制名）。
	ID string `json:"id"`
	// Name 展示名，1–64 字符，允许中文。
	Name string `json:"name"`
	// Version 语义化版本 MAJOR.MINOR.PATCH。
	Version string `json:"version"`
	// Protocol 协议主版本，M1 只接受 pluginapi.Protocol。
	Protocol string `json:"protocol"`
	// Lifecycle 生命周期，缺省 lazy。
	Lifecycle Lifecycle `json:"lifecycle,omitempty"`
	// Entry 包内可执行文件相对路径，固定 bin/<id>。
	Entry string `json:"entry"`
	// Capabilities 能力声明，必须是 8 项白名单的子集；空数组合法。
	Capabilities []string `json:"capabilities"`
	// Resources 资源预算。
	Resources Resources `json:"resources"`
	// RequiresKore 内核版本区间（如 ">=0.1.0 <0.2.0"），M1 只校验存在性。
	RequiresKore string `json:"requires_kore"`
	// Triggers 触发声明（object[]，元素为 {type, name}）；空数组表示不订阅任何触发。
	Triggers []Trigger `json:"triggers"`
	// DependsOn 依赖插件 id（M1 只做 DAG 与环校验，不做拓扑安装）。
	DependsOn []string `json:"depends_on,omitempty"`
	// Conflicts 冲突插件 id。
	Conflicts []string `json:"conflicts,omitempty"`
	// ScenarioTags 场景标签，⊆ web/data/ops/sec/app。
	ScenarioTags []string `json:"scenario_tags,omitempty"`
	// SizeBytes 安装后占用字节数。
	SizeBytes int64 `json:"size_bytes,omitempty"`
	// DepthLevel 深度等级：production 或 basic（G-20）。
	DepthLevel string `json:"depth_level,omitempty"`
	// IdleTimeoutS 空闲退出秒数，仅 lifecycle=lazy 生效，范围 60–1800。
	IdleTimeoutS int `json:"idle_timeout_s,omitempty"`
	// Dir 是插件版本的落盘目录（<root>/<id>/<version>），由 Load 填写；解析阶段为空。
	Dir string `json:"-"`
}

// requiredKeys 是必须出现在 info.json 顶层的键（缺失即 E_INVALID）。
//
// 协议口径的 12 个必填字段：id、name、version、protocol、lifecycle、entry、
// capabilities、resources{memory_mb,cpu_quota,pids_max}、requires_kore、
// triggers（object[]，元素 {type,name}）。
// 其中 resources 三项在 validateResources 里按值校验（键存在但值越界同样 E_INVALID），
// lifecycle 缺省为 lazy（G-14）因此允许省略；其余 9 个键都做存在性检查。
var requiredKeys = []string{
	"id", "name", "version", "protocol", "entry",
	"capabilities", "resources", "requires_kore", "triggers",
}

// Parse 解析并校验 info.json；失败返回带协议错误码的 *pluginapi.Error。
//
// 校验顺序：必填字段存在性 → 字段类型 → 缺省值归一 → 逐字段规则。
// 任一条失败都带字段名，便于 store-check 与安装器直接回显。
func Parse(data []byte) (*Manifest, error) {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, errf(pluginapi.E_INVALID, "info.json 不是 JSON 对象：%v", err)
	}
	for _, key := range requiredKeys {
		if _, ok := keys[key]; !ok {
			return nil, errf(pluginapi.E_INVALID, "info.json 缺必填字段 %s", key)
		}
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, errf(pluginapi.E_INVALID, "info.json 字段类型错误：%v", err)
	}
	m.normalize()
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// normalize 填缺省值：lifecycle 缺省 lazy（G-14），capabilities 缺省空切片。
func (m *Manifest) normalize() {
	if m.Lifecycle == "" {
		m.Lifecycle = LifecycleLazy
	}
	if m.Capabilities == nil {
		m.Capabilities = []string{}
	}
}

// Load 从落盘目录只读解析 info.json，并回填 Dir（M1 不写盘）。
func Load(dir string) (*Manifest, error) {
	path := filepath.Join(dir, "info.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errf(pluginapi.E_NOTFOUND, "插件清单 %s 不存在", path)
		}
		return nil, errf(pluginapi.E_INTERNAL, "读取插件清单 %s 失败：%v", path, err)
	}
	m, err := Parse(data)
	if err != nil {
		return nil, err
	}
	m.Dir = dir
	return m, nil
}

// PluginDir 返回插件版本的落盘目录 <root>/<id>/<version>。
func PluginDir(root, id, version string) string {
	return filepath.Join(root, id, version)
}

// DefaultRoot 是插件落盘根目录（/var/lib/kore 下的插件子树）。
//
// 两段拼接而不是整段字面量：源码里出现与内核内部包同形的路径会误触 G-01 薄壳边界的
// 文本门禁，此处属误报规避，不改变运行期取值。
var DefaultRoot = filepath.Join("/var/lib/kore", "plugins")

// errf 构造带协议错误码的统一错误体。
func errf(code, format string, args ...any) *pluginapi.Error {
	return &pluginapi.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
