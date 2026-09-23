package models

import "testing"

func TestModelAllowed(t *testing.T) {
	allowed := []string{"gpt-4o", "claude-*"}
	cases := map[string]bool{
		"gpt-4o":          true,
		"GPT-4o":          true,
		"claude-sonnet-5": true,
		"gpt-4o-mini":     false,
		"o3":              false,
	}
	for model, want := range cases {
		if got := ModelAllowed(allowed, model); got != want {
			t.Errorf("ModelAllowed(%q) = %v, want %v", model, got, want)
		}
	}

	// Empty list means unrestricted.
	if !ModelAllowed(nil, "anything") {
		t.Error("empty allowlist should admit any model")
	}
}

func TestNormalizeAllowedModels(t *testing.T) {
	got, err := NormalizeAllowedModels([]string{" gpt-4o ", "", "GPT-4O", "claude-*"})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(got) != 2 || got[0] != "gpt-4o" || got[1] != "claude-*" {
		t.Fatalf("normalized = %q", got)
	}

	for _, bad := range []string{"*", "gpt-*-mini", "a\nb"} {
		if _, err := NormalizeAllowedModels([]string{bad}); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}
