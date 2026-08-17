package handlers

import (
	"encoding/json"
	"testing"
)

func modelTestPayloadModel(t *testing.T, requestKind, model string) string {
	t.Helper()
	_, payload, err := modelTestRequest(requestKind, model, "hello")
	if err != nil {
		t.Fatalf("modelTestRequest(%q, %q): %v", requestKind, model, err)
	}
	var decoded struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return decoded.Model
}

// TestMessagesModelTestStripsContext1MSuffix pins the Claude Code CLI's [1m]
// semantics: the suffix is a client-side alias resolved into the context-1m
// beta header, so the model field itself must go upstream without it. Relays
// list only the plain id — anyrouter answered the literal suffixed id with a
// masked 503 while demanding the beta for the plain one.
func TestMessagesModelTestStripsContext1MSuffix(t *testing.T) {
	for _, model := range []string{"claude-fable-5[1m]", "claude-fable-5[1M]"} {
		if got := modelTestPayloadModel(t, "messages", model); got != "claude-fable-5" {
			t.Errorf("messages model for %q = %q, want %q", model, got, "claude-fable-5")
		}
	}
	if got := modelTestPayloadModel(t, "messages", "claude-fable-5"); got != "claude-fable-5" {
		t.Errorf("plain model rewritten to %q", got)
	}
}

// TestNonMessagesModelTestKeepsModelVerbatim keeps the alias handling scoped to
// the protocol that defines it: other request kinds pass the typed id through.
func TestNonMessagesModelTestKeepsModelVerbatim(t *testing.T) {
	for _, kind := range []string{"responses", "chat_completions"} {
		if got := modelTestPayloadModel(t, kind, "some-model[1m]"); got != "some-model[1m]" {
			t.Errorf("%s model = %q, want verbatim %q", kind, got, "some-model[1m]")
		}
	}
}

// TestClaudeCLIModelTestHeadersKeyBetaOnSuffixedInput guards the pairing: the
// beta decision reads the model as typed, so stripping the payload model must
// not lose the context-1m header.
func TestClaudeCLIModelTestHeadersKeyBetaOnSuffixedInput(t *testing.T) {
	headers := claudeCLIModelTestHeaders("claude-fable-5[1M]")
	if betas := headers["anthropic-beta"]; !containsBeta(betas, "context-1m-2025-08-07") {
		t.Errorf("anthropic-beta %q missing context-1m-2025-08-07", betas)
	}
}

func containsBeta(list, beta string) bool {
	for start := 0; start < len(list); {
		end := start
		for end < len(list) && list[end] != ',' {
			end++
		}
		if list[start:end] == beta {
			return true
		}
		start = end + 1
	}
	return false
}
