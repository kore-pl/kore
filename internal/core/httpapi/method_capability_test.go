package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// capMethodLookupBackend 在插件级查询之外实现 PluginMethodCapabilityLookup（首选读法）。
type capMethodLookupBackend struct {
	*capLookupBackend
	methodCaps    map[string]map[string]string
	methodLookups []string
}

func (b *capMethodLookupBackend) PluginMethodCapabilities(_ context.Context, id string) (map[string]string, bool, error) {
	b.methodLookups = append(b.methodLookups, id)
	if _, ok := b.caps[id]; !ok {
		return nil, false, nil
	}
	return b.methodCaps[id], true, nil
}

// capAuditRecorder 记录 HTTP 侧审计事件（invoke.* 断言用）。
type capAuditRecorder struct {
	events []AuditEvent
}

func (r *capAuditRecorder) Record(ev AuditEvent) { r.events = append(r.events, ev) }

// methodCapFixture 是方法级能力测试的公共声明：插件级 admin，只读方法覆盖为 read。
func methodCapFixture() (map[string][]string, map[string]map[string]string) {
	caps := map[string][]string{"db-mysql": {"system:admin"}}
	methodCaps := map[string]map[string]string{"db-mysql": {
		"db-mysql.instances":      "system:read",
		"db-mysql.config.get":     "system:read",
		"db-mysql.createDatabase": "system:admin",
	}}
	return caps, methodCaps
}

// TestInvokeMethodCapabilityOverridesPluginLevel：方法级 read 覆盖插件级 admin，
// 低权会话也能调用只读方法（授权侧方法级生效）。
func TestInvokeMethodCapabilityOverridesPluginLevel(t *testing.T) {
	caps, methodCaps := methodCapFixture()
	backend := &capDeclBackend{caps: caps, methodCaps: methodCaps}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.instances")
	if status != http.StatusOK {
		t.Fatalf("方法级 system:read 应覆盖插件级 system:admin，实际 %d body=%s", status, body)
	}
	if len(backend.invoked) != 1 {
		t.Fatalf("应真实执行一次 invoke，实际 %v", backend.invoked)
	}
}

// TestInvokeMethodCapabilityNormalizesBareMethod：路径方法段为裸动作时也命中完整方法名键。
func TestInvokeMethodCapabilityNormalizesBareMethod(t *testing.T) {
	caps, methodCaps := methodCapFixture()
	backend := &capDeclBackend{caps: caps, methodCaps: methodCaps}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "instances")
	if status != http.StatusOK {
		t.Fatalf("裸动作 instances 应归一为 db-mysql.instances，实际 %d body=%s", status, body)
	}
}

// TestInvokeMethodCapabilityDottedMethod：点分方法名（config.get）按完整键命中。
func TestInvokeMethodCapabilityDottedMethod(t *testing.T) {
	caps, methodCaps := methodCapFixture()
	backend := &capDeclBackend{caps: caps, methodCaps: methodCaps}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.config.get")
	if status != http.StatusOK {
		t.Fatalf("点分方法名应命中方法级 read，实际 %d body=%s", status, body)
	}
}

// TestInvokeMethodCapabilityFallbackToPluginLevel：未声明的方法回退插件级 capabilities。
func TestInvokeMethodCapabilityFallbackToPluginLevel(t *testing.T) {
	type denied struct{ subject, plugin, target, reason string }
	var records []denied
	auditor := func(subject, plugin, target, reason string) {
		records = append(records, denied{subject, plugin, target, reason})
	}
	caps, methodCaps := methodCapFixture()
	backend := &capDeclBackend{caps: caps, methodCaps: methodCaps}
	ts, cookie := capSetup(t, capLowPrivResolver, auditor, backend)

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.dropDatabase")
	if status != http.StatusForbidden {
		t.Fatalf("未声明方法应回退插件级 admin 并拒绝低权会话，实际 %d body=%s", status, body)
	}
	if len(backend.invoked) != 0 {
		t.Fatalf("越权请求不得触达 Invoke，实际 %v", backend.invoked)
	}
	if len(records) != 1 || records[0].reason != "调用该插件需要 system:admin 能力" {
		t.Fatalf("应写一条回退到插件级的 capability.denied 审计，实际 %+v", records)
	}
}

// TestInvokeMethodCapabilityLookupPreferred：装配层实现方法级查询时走清单直读。
func TestInvokeMethodCapabilityLookupPreferred(t *testing.T) {
	caps, methodCaps := methodCapFixture()
	backend := &capMethodLookupBackend{
		capLookupBackend: &capLookupBackend{capDeclBackend: &capDeclBackend{caps: caps}},
		methodCaps:       methodCaps,
	}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.instances")
	if status != http.StatusOK {
		t.Fatalf("方法级查询应生效，实际 %d body=%s", status, body)
	}
	if len(backend.methodLookups) != 1 || backend.methodLookups[0] != "db-mysql" {
		t.Fatalf("应经 PluginMethodCapabilityLookup 读取一次，实际 %v", backend.methodLookups)
	}
}

// TestInvokeMethodCapabilityAuditScope 是本次核心行为：审计按最终生效能力判定。
// 只读方法（方法级 read）10 次 → 0 条；写方法 1 次 → 1 条。
// 同时覆盖两条装配路径：可选查询接口优先、PluginStatus 字段回退。
func TestInvokeMethodCapabilityAuditScope(t *testing.T) {
	for _, tc := range []struct {
		name    string
		backend func(caps map[string][]string, methodCaps map[string]map[string]string) Backend
	}{
		{
			name: "可选查询接口",
			backend: func(caps map[string][]string, methodCaps map[string]map[string]string) Backend {
				return &capMethodLookupBackend{
					capLookupBackend: &capLookupBackend{capDeclBackend: &capDeclBackend{caps: caps}},
					methodCaps:       methodCaps,
				}
			},
		},
		{
			name: "PluginStatus 回退",
			backend: func(caps map[string][]string, methodCaps map[string]map[string]string) Backend {
				return &capDeclBackend{caps: caps, methodCaps: methodCaps}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			caps, methodCaps := methodCapFixture()
			recorder := &capAuditRecorder{}
			ts, cookie := capSetupWithRecorder(t, capFullAdminResolver, nil, tc.backend(caps, methodCaps), recorder)

			// 登录也会走同一审计出口；本断言只看 invoke.* 增量。
			invokeEvents := func() []AuditEvent {
				var out []AuditEvent
				for _, ev := range recorder.events {
					if strings.HasPrefix(ev.Action, auditActionInvokePrefix) {
						out = append(out, ev)
					}
				}
				return out
			}

			for i := 0; i < 10; i++ {
				if status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.instances"); status != http.StatusOK {
					t.Fatalf("第 %d 次只读调用应 200，实际 %d body=%s", i+1, status, body)
				}
			}
			if events := invokeEvents(); len(events) != 0 {
				t.Fatalf("只读方法不应写 invoke.* 审计，实际 %d 条：%+v", len(events), events)
			}

			if status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.createDatabase"); status != http.StatusOK {
				t.Fatalf("写方法调用应 200，实际 %d body=%s", status, body)
			}
			events := invokeEvents()
			if len(events) != 1 {
				t.Fatalf("写方法应写 1 条 invoke.* 审计，实际 %d 条：%+v", len(events), events)
			}
			ev := events[0]
			if !strings.HasPrefix(ev.Action, auditActionInvokePrefix+"db-mysql.") {
				t.Errorf("审计动作应为 invoke.db-mysql.*，实际 %q", ev.Action)
			}
			if ev.Target != "db-mysql/db-mysql.createDatabase" {
				t.Errorf("审计 target 应为 db-mysql/db-mysql.createDatabase，实际 %q", ev.Target)
			}
			if ev.Result != auditResultOK {
				t.Errorf("审计 result 应为 ok，实际 %q", ev.Result)
			}
		})
	}
}

// TestInvokeMethodCapabilityUnknownPlugin：插件未安装时鉴权层不伪造 404，
// 放行给 Invoke 统一返回 E_NOTFOUND（测试后端 Invoke 恒成功，故这里为 200）。
func TestInvokeMethodCapabilityUnknownPlugin(t *testing.T) {
	backend := &capMethodLookupBackend{
		capLookupBackend: &capLookupBackend{capDeclBackend: &capDeclBackend{caps: map[string][]string{}}},
		methodCaps:       map[string]map[string]string{},
	}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	if status, body := capInvokeRequest(t, ts, cookie, "ghost", "ghost.run"); status != http.StatusOK {
		t.Fatalf("未安装插件不应在鉴权层拒绝，实际 %d body=%s", status, body)
	}
}

// TestFullMethodName 覆盖完整方法名归一规则（裸动作补域、完整名原样保留）。
func TestFullMethodName(t *testing.T) {
	cases := []struct{ plugin, method, want string }{
		{"db-mysql", "instances", "db-mysql.instances"},
		{"db-mysql", "db-mysql.instances", "db-mysql.instances"},
		{"db-mysql", "db-mysql.config.get", "db-mysql.config.get"},
		{"db-mysql", "config.get", "db-mysql.config.get"},
	}
	for _, c := range cases {
		if got := fullMethodName(c.plugin, c.method); got != c.want {
			t.Errorf("fullMethodName(%q, %q) = %q，期望 %q", c.plugin, c.method, got, c.want)
		}
	}
}
