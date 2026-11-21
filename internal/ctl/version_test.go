package ctl

import (
	"runtime/debug"
	"testing"
)

func TestClientVersionCoversReleaseGoInstallAndDevelopment(t *testing.T) {
	for _, tc := range []struct {
		override, module, want string
	}{
		{"0.2.6", "(devel)", "0.2.6"},
		{"dev", "v0.2.6", "0.2.6"},
		{"dev", "v0.2.5-0.20261106120000-abcdefabcdef", "0.2.5-0.20261106120000-abcdefabcdef"},
		{"dev", "(devel)", "dev"},
		{"dev", "", "dev"},
	} {
		info := &debug.BuildInfo{Main: debug.Module{Version: tc.module}}
		if got := buildVersion(tc.override, info); got != tc.want {
			t.Errorf("override=%q module=%q got=%q want=%q", tc.override, tc.module, got, tc.want)
		}
	}
	if got := buildVersion("dev", nil); got != "dev" {
		t.Fatalf("missing build metadata returned %q", got)
	}
}
