package market

// 批量更新的只读计算层：从已验签索引算出「待更新项」并按依赖序排列。
//
// 边界（U2=A / G-24）：只读、不安装、不写缓存、不改任何对外 schema；
// 信任门与 Install/InstallDownload 共用 readVerified（验签失败零数据，R4）。
// 安装与 reloadOne 由 cmd/kored 的批量编排器逐条触发，本文件不重复实现。

import (
	"fmt"
	"sort"
)

// PendingUpdate 是一条待更新项（显式字段，禁 any/object，G-24）。
//
// PreviousVersion 来自调用方传入的已装版本快照，供编排器结果回显与失败分诊；
// DependsOn 用于拓扑排序（依赖先于被依赖者安装）。
type PendingUpdate struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Version 索引声明的目标版本。
	Version string `json:"version"`
	// SHA256 目标包摘要（来自已验签索引，安装器会再校验）。
	SHA256 string `json:"sha256"`
	// DownloadURL 目标包地址（只来自已验签索引，防 SSRF）。
	DownloadURL string `json:"download_url"`
	// DependsOn 依赖的插件 id（按依赖序展开）。
	DependsOn []string `json:"depends_on"`
	// PreviousVersion 当前已装版本（未安装不会进入待更新列表）。
	PreviousVersion string `json:"previous_version"`
}

// PendingUpdates 从已验签索引算出待更新项，按依赖序（依赖在前）返回。
//
// installed 是「插件 id → 当前已装版本」的只读快照，由装配层从状态库投影；
// 本函数只算列表，不读状态库、不下载、不安装。
//
// 判定口径：
//   - 索引中有、installed 中没有的条目是「首次安装」，不属于批量更新，跳过
//     （首次安装仍走单条 store/install 显式触发）；
//   - 已装版本与索引版本一致 → 幂等跳过（重复调用得到同样的列表）；
//   - 版本不同 → 列入待更新（不做大小比较：索引是精确版本，升级/降级同口径）。
func (s *Service) PendingUpdates(installed map[string]string) ([]PendingUpdate, error) {
	index, err := s.readVerified()
	if err != nil {
		return nil, err
	}
	return pendingFromIndex(index, installed)
}

// pendingFromIndex 是纯函数（无 IO），供单测直接构造索引验证筛选 / 排序 / 幂等 / 环检测。
func pendingFromIndex(index Index, installed map[string]string) ([]PendingUpdate, error) {
	pending := make([]PendingUpdate, 0, len(index.Plugins))
	for _, p := range index.Plugins {
		previous, ok := installed[p.ID]
		if !ok || previous == "" || previous == p.Version {
			continue
		}
		pending = append(pending, PendingUpdate{
			ID: p.ID, Version: p.Version, SHA256: p.SHA256,
			DownloadURL: p.DownloadURL, DependsOn: append([]string(nil), p.DependsOn...),
			PreviousVersion: previous,
		})
	}
	return orderPending(pending)
}

// orderPending 对挟更新项做拓扑排序：依赖在前，同层按 id 升序保证确定性（幂等）。
//
// 只考虑待更新集合内部的依赖——依赖未列入待更新时说明它不需要变更，不阻塞排序。
// 自依赖 / 循环依赖返回 E_INVALID（失败分诊由编排器继续处理其它项，这里只拒绝整批规划）。
func orderPending(pending []PendingUpdate) ([]PendingUpdate, error) {
	byID := make(map[string]PendingUpdate, len(pending))
	indegree := make(map[string]int, len(pending))
	dependents := make(map[string][]string, len(pending))
	for _, p := range pending {
		byID[p.ID] = p
		indegree[p.ID] = 0
	}
	for _, p := range pending {
		seen := make(map[string]bool, len(p.DependsOn))
		for _, dep := range p.DependsOn {
			if dep == p.ID {
				return nil, protocolError("E_INVALID", fmt.Sprintf("插件 %s 依赖自身", p.ID))
			}
			if seen[dep] {
				continue // 重复声明同一依赖不重复计边
			}
			seen[dep] = true
			if _, ok := byID[dep]; !ok {
				continue // 依赖不在待更新集合：无需变更，不阻塞
			}
			indegree[p.ID]++
			dependents[dep] = append(dependents[dep], p.ID)
		}
	}

	queue := make([]string, 0, len(pending))
	for id, degree := range indegree {
		if degree == 0 {
			queue = append(queue, id)
		}
	}
	sort.Strings(queue)

	ordered := make([]PendingUpdate, 0, len(pending))
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		ordered = append(ordered, byID[id])
		next := append([]string(nil), dependents[id]...)
		sort.Strings(next)
		for _, child := range next {
			indegree[child]--
			if indegree[child] == 0 {
				queue = append(queue, child)
				sort.Strings(queue)
			}
		}
	}
	if len(ordered) != len(pending) {
		return nil, protocolError("E_INVALID", "待更新项存在循环依赖，无法按依赖序安装")
	}
	return ordered, nil
}
