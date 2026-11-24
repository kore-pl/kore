package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// 安装一次性标记（"只有第一次安装显示新手引导"的权威状态）。
//
// 与浏览器 localStorage 无关：前端清缓存 / 换浏览器 / 重新登录都改不到这里。
// 两枚键都放在既有 meta bucket，不新增 bucket、不改 schema 版本（additive）。
const (
	// installMarkerKey 是 Kore 级安装代次标记；值形如 {"installed_at":"..."}。
	// 只在首次建库时写一次，之后永不覆盖（重装 / 升级 / 重启都不重置）。
	installMarkerKey = "installed_at"
	// onboardingDoneKey 一旦存在，代表该安装代次的新手引导已完成 / 已跳过。
	onboardingDoneKey = "onboarding_done"
)

// installMarker 是 meta.installed_at 的值形状（显式字段，不用 object/any）。
type installMarker struct {
	InstalledAt string `json:"installed_at"`
}

// onboardingDoneMarker 是 meta.onboarding_done 的值形状。
type onboardingDoneMarker struct {
	DoneAt string `json:"done_at"`
}

// isNotFound 判断读键的"不存在"错误（tx.Get 用 ErrNotFound）。
func isNotFound(err error) bool {
	return err != nil && errors.Is(err, ErrNotFound)
}

// EnsureInstallMarker 保证安装代次标记存在（幂等）。
//
// 语义：
//   - 全新库（fresh=true）：只写 installed_at，不写 onboarding_done —— 本次安装需要自动弹一次引导。
//   - 已有库升级（fresh=false，老库没有 installed_at）：同时写 installed_at 与 onboarding_done ——
//     视为"安装那一次已经过去"，向后兼容：老用户不会因为升级被突然弹一次引导。
//   - 已有 installed_at：完全不动，保证安装代次稳定。
//
// 仅由 store.Open 在建库后调用；没有其它写入方，前端无法清除或重置。
func (s *Store) EnsureInstallMarker(fresh bool) error {
	return s.Update(func(tx *Tx) error {
		raw, err := tx.Get(bucketMeta, installMarkerKey)
		if err != nil && !isNotFound(err) {
			return err
		}
		if raw != nil {
			return nil // 已有安装代次，稳定不变
		}
		now := time.Now().UTC().Format(time.RFC3339)
		marker, err := json.Marshal(installMarker{InstalledAt: now})
		if err != nil {
			return fmt.Errorf("序列化安装标记失败: %w", err)
		}
		if err := tx.Put(bucketMeta, installMarkerKey, marker); err != nil {
			return err
		}
		if !fresh {
			done, err := json.Marshal(onboardingDoneMarker{DoneAt: now})
			if err != nil {
				return fmt.Errorf("序列化引导完成标记失败: %w", err)
			}
			if err := tx.Put(bucketMeta, onboardingDoneKey, done); err != nil {
				return err
			}
		}
		return nil
	})
}

// InstallState 是供 HTTP 只读端点返回的稳定视图，全部是不可伪造的标量。
type InstallState struct {
	// InstallGeneration 是 installMarker.InstalledAt（RFC3339）；空串表示尚未打标记。
	InstallGeneration string
	// OnboardingDone 表示服务端已记录"该安装代次的引导已完成 / 已跳过"。
	OnboardingDone bool
	// ShouldAutoOpen 为 true 仅当：已有安装代次且未标记完成 —— 即"安装那一次"。
	ShouldAutoOpen bool
}

// GetInstallState 读取当前安装代次与引导完成状态。
func (s *Store) GetInstallState() (InstallState, error) {
	var out InstallState
	err := s.View(func(tx *Tx) error {
		raw, err := tx.Get(bucketMeta, installMarkerKey)
		if err != nil && !isNotFound(err) {
			return err
		}
		if raw != nil {
			var m installMarker
			if err := json.Unmarshal(raw, &m); err != nil {
				return fmt.Errorf("%w: meta.%s 无法解析: %v", ErrCorrupt, installMarkerKey, err)
			}
			out.InstallGeneration = m.InstalledAt
		}
		done, err := tx.Get(bucketMeta, onboardingDoneKey)
		if err != nil && !isNotFound(err) {
			return err
		}
		out.OnboardingDone = done != nil
		out.ShouldAutoOpen = out.InstallGeneration != "" && !out.OnboardingDone
		return nil
	})
	return out, err
}

// MarkOnboardingDone 幂等记录"该安装代次的引导已完成 / 已跳过"。
// 只需存在性，已有标记不覆盖（首次完成的时间才是权威）。
func (s *Store) MarkOnboardingDone() error {
	return s.Update(func(tx *Tx) error {
		raw, err := tx.Get(bucketMeta, onboardingDoneKey)
		if err != nil && !isNotFound(err) {
			return err
		}
		if raw != nil {
			return nil
		}
		done, err := json.Marshal(onboardingDoneMarker{DoneAt: time.Now().UTC().Format(time.RFC3339)})
		if err != nil {
			return fmt.Errorf("序列化引导完成标记失败: %w", err)
		}
		return tx.Put(bucketMeta, onboardingDoneKey, done)
	})
}
