package registry

import (
	"sort"
	"strings"
	"sync"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// State 是插件登记状态（M1 只有 installed / enabled 两态）。
type State string

// 登记状态取值；运行期状态由 supervisor 维护，两者不可混用。
const (
	// StateInstalled 已安装未启用。
	StateInstalled State = "installed"
	// StateEnabled 已启用（resident 进入 starting，lazy 仅标记期望态）。
	StateEnabled State = "enabled"
)

// View 是插件登记视图，供 HTTP 层组装响应。
type View struct {
	// ID 插件 id。
	ID string
	// Name 展示名。
	Name string
	// Version 插件版本。
	Version string
	// Lifecycle 生命周期。
	Lifecycle Lifecycle
	// State 登记状态。
	State State
}

// entry 是一条登记记录。
type entry struct {
	manifest *Manifest
	state    State
}

// Catalog 是内存版插件登记表。
//
// M1 不接 bbolt：持久化归 store（另一写域），本包只维护进程内登记状态；
// 装配层负责把 store 中的记录读进来、把变更写回去。
type Catalog struct {
	mu    sync.RWMutex
	items map[string]*entry
}

// NewCatalog 创建空登记表。
func NewCatalog() *Catalog {
	return &Catalog{items: make(map[string]*entry)}
}

// Add 登记一个已解析的清单：重复 id 返回 E_CONFLICT，
// depends_on 成环返回 E_INVALID（message 含环路径），清单非法返回对应字段错误。
func (c *Catalog) Add(m *Manifest) error {
	if m == nil {
		return errf(pluginapi.E_INVALID, "清单为空")
	}
	if err := m.validate(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.items[m.ID]; ok {
		return errf(pluginapi.E_CONFLICT, "插件 %s 已登记", m.ID)
	}
	if cycle := DetectCycle(c.graphLocked(m)); len(cycle) > 0 {
		return errf(pluginapi.E_INVALID, "depends_on 存在循环依赖：%s", strings.Join(cycle, " → "))
	}
	c.items[m.ID] = &entry{manifest: m, state: StateInstalled}
	return nil
}

// Replace 替换同 id 的已登记清单（热升级/重装用）：校验规则与 Add 一致，
// 保留原登记的 enabled 状态；未登记时等价于 Add（增量安装）。
//
// 必须替换而不是「已存在就跳过」：运行期装了新版本后，catalog 里若还挂着旧
// manifest，/plugins 会继续报旧版本，supervisor 也会按旧目录拉起旧二进制。
func (c *Catalog) Replace(m *Manifest) error {
	if m == nil {
		return errf(pluginapi.E_INVALID, "清单为空")
	}
	if err := m.validate(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	state := StateInstalled
	if old, ok := c.items[m.ID]; ok {
		state = old.state
	}
	if cycle := DetectCycle(c.graphLocked(m)); len(cycle) > 0 {
		return errf(pluginapi.E_INVALID, "depends_on 存在循环依赖：%s", strings.Join(cycle, " → "))
	}
	c.items[m.ID] = &entry{manifest: m, state: state}
	return nil
}

// graphLocked 构建「全部已登记 + 候选清单」的依赖图；调用方须持有读锁。
func (c *Catalog) graphLocked(extra *Manifest) map[string][]string {
	graph := make(map[string][]string, len(c.items)+1)
	for id, e := range c.items {
		graph[id] = e.manifest.DependsOn
	}
	if extra != nil {
		graph[extra.ID] = extra.DependsOn
	}
	var missing []string
	for _, deps := range graph {
		for _, dep := range deps {
			if _, ok := graph[dep]; !ok {
				missing = append(missing, dep)
			}
		}
	}
	for _, dep := range missing {
		graph[dep] = nil
	}
	return graph
}

// Manifest 返回已登记的清单（实现 supervisor.Manifests）。
func (c *Catalog) Manifest(id string) (*Manifest, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.items[id]
	if !ok {
		return nil, false
	}
	return e.manifest, true
}

// Enabled 报告插件是否已 enable（实现 supervisor.Manifests）。
func (c *Catalog) Enabled(id string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.items[id]
	return ok && e.state == StateEnabled
}

// State 返回登记状态；未安装时第二返回值为 false。
func (c *Catalog) State(id string) (State, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.items[id]
	if !ok {
		return "", false
	}
	return e.state, true
}

// Enable 把插件置为 enabled（desired=enabled），不负责拉起进程。
//
// 运行期支持全部三种 lifecycle；lazy/oneshot 在 enable 阶段只标记期望态，
// 进程由首次 invoke 按需拉起。非法 lifecycle 仍返回 E_INVALID，不静默降级；
// 未安装返回 E_NOTFOUND。
func (c *Catalog) Enable(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[id]
	if !ok {
		return errf(pluginapi.E_NOTFOUND, "插件 %s 未安装", id)
	}
	if err := e.manifest.RuntimeSupported(); err != nil {
		return err
	}
	e.state = StateEnabled
	return nil
}

// Disable 把插件退回 installed；未安装返回 E_NOTFOUND。
func (c *Catalog) Disable(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[id]
	if !ok {
		return errf(pluginapi.E_NOTFOUND, "插件 %s 未安装", id)
	}
	e.state = StateInstalled
	return nil
}

// List 按 id 字典序返回全部插件视图（稳定顺序，便于前端与测试比对）。
func (c *Catalog) List() []View {
	c.mu.RLock()
	views := make([]View, 0, len(c.items))
	for _, e := range c.items {
		views = append(views, View{
			ID:        e.manifest.ID,
			Name:      e.manifest.Name,
			Version:   e.manifest.Version,
			Lifecycle: e.manifest.Lifecycle,
			State:     e.state,
		})
	}
	c.mu.RUnlock()
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	return views
}
