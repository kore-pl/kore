package pluginapi_test

import (
	"testing"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// TestProtocol 锁定协议标识，防止误改；协议主版本变更必须走 ADR 与 SDK/kore 主版本递增。
func TestProtocol(t *testing.T) {
	const want = "kore.plugin.v1"
	if got := pluginapi.Protocol; got != want {
		t.Fatalf("Protocol = %q，want %q", got, want)
	}
}
