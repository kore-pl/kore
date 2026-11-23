package supervisor_test

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
)

// callLog 记录跨替身的调用顺序（fakeIdentity 与 fakeAccess 共享一个实例）。
//
// 为什么要跨替身记序：降权正确性不只看「调了没调」，还看顺序——必须
// 建用户(ensure) → 移交属主(own) → 切换 uid(apply)。顺序错了就会出现
// 「先切 uid 再建用户」或「属主没移交就开始写」这类只在真 root 上炸的问题。
type callLog struct {
	mu     sync.Mutex
	events []string
}

// add 追加一条调用事件。
func (c *callLog) add(event string) {
	c.mu.Lock()
	c.events = append(c.events, event)
	c.mu.Unlock()
}

// snapshot 返回事件序列副本。
func (c *callLog) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.events)
}

// indexOfPrefix 返回首个以 prefix 开头的事件下标；不存在返回 -1。
func indexOfPrefix(events []string, prefix string) int {
	for i, event := range events {
		if strings.HasPrefix(event, prefix) {
			return i
		}
	}
	return -1
}

// TestDemotionStatusNotRootIsExplicit 验证非 root 内核下「未降权」是显式结论：
// Demotion().Enabled=false + 非空原因，且**不调用建用户/改属主**。
//
// 这是本次修复的核心断言：过去的 prepareDemotion 在非 root 下直接返回零值
// Account，调用方看到的是「没有身份」而不是「没有降权」，产品上的插件降权
// 因此静默失效、用户完全不可见。
func TestDemotionStatusNotRootIsExplicit(t *testing.T) {
	identity := &fakeIdentity{
		current: platform.Account{Name: "dev", UID: 1000, GID: 1000},
		account: platform.Account{UID: os.Getuid(), GID: os.Getgid()},
	}
	access := &fakeAccess{}
	env := newTestEnv(t, "noderoot", nil, func(o *supervisor.Options) {
		o.Identity = identity
		o.Access = access
	})

	dem := env.manager.Demotion()
	if dem.Enabled {
		t.Fatalf("非 root 内核不应报告已降权：%+v", dem)
	}
	if dem.Reason == "" {
		t.Fatal("非 root 内核必须给出未降权原因（禁止静默零值）")
	}
	if !strings.Contains(dem.Reason, "未生效") || !strings.Contains(dem.Reason, "uid=1000") {
		t.Fatalf("未降权原因应说明「未生效」与内核 uid，实际 %q", dem.Reason)
	}
	if dem.KernelUID != 1000 {
		t.Fatalf("KernelUID=%d，期望 1000（判据来源）", dem.KernelUID)
	}

	if err := env.manager.Start(context.Background(), "noderoot"); err != nil {
		t.Fatalf("非 root 形态是合法降级形态，启动不应失败: %v", err)
	}
	if len(identity.ensured) != 0 {
		t.Fatalf("非 root 内核不应尝试创建系统用户，实际 %v", identity.ensured)
	}
	if len(access.owned) != 0 {
		t.Fatalf("非 root 内核不应移交属主，实际 %v", access.owned)
	}
}

// TestRootDemotionCallSequence 用替身记录 root 形态的完整调用序列：
// ensure(kore-<id>) → own(<state>/plugins/<id>) → apply(kore-<id>)。
//
// 「确实调用了降权」不能靠进程真的换了 uid 来间接证明（CI 不是 root），
// 必须由替身逐项记录：建用户一次、属主一次、切换 uid 一次，且顺序如上。
func TestRootDemotionCallSequence(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("需要非 root 运行：Apply 复用真实平台实现做自降权，root 下用例见 TestEnsureAndApplySystemAccount")
	}
	log := &callLog{}
	identity := newDemotionIdentity()
	identity.log = log
	access := &fakeAccess{log: log}
	env := newTestEnv(t, "demote", nil, func(o *supervisor.Options) {
		o.Identity = identity
		o.Access = access
	})

	dem := env.manager.Demotion()
	if !dem.Enabled {
		t.Fatalf("内核 uid=0 时必须报告已降权：%+v", dem)
	}
	if !strings.Contains(dem.Reason, "已生效") || !strings.Contains(dem.Reason, "kore-") {
		t.Fatalf("已降权原因应说明生效与目标身份，实际 %q", dem.Reason)
	}

	if err := env.manager.Start(context.Background(), "demote"); err != nil {
		t.Fatalf("启动失败: %v", err)
	}

	events := log.snapshot()
	ensureAt := indexOfPrefix(events, "ensure:kore-demote")
	ownAt := indexOfPrefix(events, "own:")
	applyAt := indexOfPrefix(events, "apply:kore-demote")
	if ensureAt < 0 {
		t.Fatalf("root 形态必须调用建用户 ensure，实际序列 %v", events)
	}
	if ownAt < 0 {
		t.Fatalf("root 形态必须把状态目录交给插件用户 own，实际序列 %v", events)
	}
	if applyAt < 0 {
		t.Fatalf("root 形态必须调用降权 apply 切换 uid，实际序列 %v", events)
	}
	if !(ensureAt < ownAt && ownAt < applyAt) {
		t.Fatalf("调用序必须是 ensure → own → apply，实际 %v", events)
	}
	if got := len(identity.ensured); got != 1 {
		t.Fatalf("建用户应恰好调用一次（幂等），实际 %d 次: %v", got, identity.ensured)
	}
}

// TestRootDemotionRollsBackUserWhenOwnershipFails 验证「刚建的用户、属主还没移交」
// 时启动失败会回滚删账户：否则状态目录不可写这类错误会让每次重试在 /etc/passwd
// 里多留一个 kore-<id>。
func TestRootDemotionRollsBackUserWhenOwnershipFails(t *testing.T) {
	identity := newDemotionIdentity()
	access := &fakeAccess{ownErr: errors.New("chown: operation not permitted")}
	env := newTestEnv(t, "demote", nil, func(o *supervisor.Options) {
		o.Identity = identity
		o.Access = access
	})

	err := env.manager.Start(context.Background(), "demote")
	if err == nil {
		t.Fatal("属主移交失败时必须拒绝启动，不能退回同 uid")
	}
	if !strings.Contains(err.Error(), "把插件状态目录") {
		t.Fatalf("错误信息应指出属主移交失败: %v", err)
	}
	if len(identity.ensured) != 1 {
		t.Fatalf("应先创建用户再移交属主，实际 ensured=%v", identity.ensured)
	}
	if !slices.Equal(identity.removed, []string{"kore-demote"}) {
		t.Fatalf("属主未移交前失败应回滚删除刚建的用户，实际 removed=%v", identity.removed)
	}
}

// TestRootDemotionKeepsUserAfterOwnershipTransferred 验证明确决策的另一半：
// 属主已经交给 kore-<id> 之后失败**不删用户**。
//
// 理由：删了会把状态目录挂到未分配的数字 uid 上；重试时新账户拿到另一个 uid，
// 就读不到自己的状态目录（等价于丢数据）。账户幂等，保留即可复用。
func TestRootDemotionKeepsUserAfterOwnershipTransferred(t *testing.T) {
	identity := newDemotionIdentity()
	access := &fakeAccess{traverseErr: errors.New("stat: no such directory")}
	env := newTestEnv(t, "demote", nil, func(o *supervisor.Options) {
		o.Identity = identity
		o.Access = access
	})

	err := env.manager.Start(context.Background(), "demote")
	if err == nil {
		t.Fatal("父链可穿越失败时必须拒绝启动")
	}
	if !strings.Contains(err.Error(), "可穿越失败") {
		t.Fatalf("错误信息应指出可穿越位设置失败: %v", err)
	}
	if len(access.owned) == 0 {
		t.Fatal("应已移交状态目录属主（本用例前提）")
	}
	if len(identity.removed) != 0 {
		t.Fatalf("属主已移交后失败不得删用户（会让目录挂到未分配 uid），实际 removed=%v", identity.removed)
	}
}
