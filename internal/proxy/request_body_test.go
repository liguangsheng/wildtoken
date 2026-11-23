package proxy

import (
	"net/http"
	"testing"
)

func TestParsedRequestBodyPreservesModelAndEffortSemantics(t *testing.T) {
	for _, testCase := range []struct {
		name, body string
		model      *string
		effort     *string
	}{
		{name: "simple model", body: `{"model":"m"}`, model: ptrTo("m")},
		{name: "last duplicate model", body: `{"model":"first","model":"second"}`, model: ptrTo("second")},
		{name: "decoded duplicate key", body: `{"model":"first","mod\u0065l":"second"}`, model: ptrTo("second")},
		{name: "non-string last model", body: `{"model":"first","model":null}`},
		{name: "overflow number invalidates map decode", body: `{"model":"m","unused":1e999}`},
		{name: "number text is not a number", body: `{"model":"m","unused":"1e999"}`, model: ptrTo("m")},
		{name: "reasoning precedence", body: `{"reasoning_effort":"low","reasoning":{"effort":"medium"},"output_config":{"effort":"high"}}`, effort: ptrTo("low")},
		{name: "reasoning fallback", body: `{"reasoning_effort":null,"reasoning":{"effort":"medium"},"output_config":{"effort":"high"}}`, effort: ptrTo("medium")},
		{name: "last direct effort", body: `{"reasoning_effort":"low","reasoning_effort":3}`, effort: ptrTo("3")},
		{name: "last nested effort", body: `{"reasoning":{"effort":"medium","effort":null},"output_config":{"effort":"high"}}`, effort: ptrTo("high")},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := ParseRequestBody(http.Header{}, []byte(testCase.body))
			if err != nil {
				t.Fatal(err)
			}
			assertStringPointer(t, "model", parsed.Model(), testCase.model)
			assertStringPointer(t, "effort", parsed.ReasoningEffort(), testCase.effort)
		})
	}
}

func TestParsedResponseMetadataPreservesStructDecodeSemantics(t *testing.T) {
	for _, testCase := range []struct {
		name, body, responseID string
		storeDisabled          bool
	}{
		{
			name:       "unknown overflow does not block response metadata",
			body:       `{"previous_response_id":"resp_1","store":false,"unused":1e999}`,
			responseID: "resp_1", storeDisabled: true,
		},
		{
			name:       "null string keeps prior value",
			body:       `{"previous_response_id":"resp_1","previous_response_id":null}`,
			responseID: "resp_1",
		},
		{
			name: "wrong response id type fails decoding",
			body: `{"previous_response_id":"resp_1","previous_response_id":42}`,
		},
		{
			name: "null store clears pointer",
			body: `{"store":false,"store":null}`,
		},
		{
			name: "wrong store type fails decoding",
			body: `{"store":false,"store":"no"}`,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := ParseRequestBody(http.Header{}, []byte(testCase.body))
			if err != nil {
				t.Fatal(err)
			}
			if got := parsed.PreviousResponseID(); got != testCase.responseID {
				t.Errorf("previous response id = %q, want %q", got, testCase.responseID)
			}
			if got := parsed.StoreDisabled(); got != testCase.storeDisabled {
				t.Errorf("store disabled = %v, want %v", got, testCase.storeDisabled)
			}
		})
	}
}

func TestMappedReasoningEffortFallsBackAfterEmptyRewrite(t *testing.T) {
	prepared := []byte(`{"reasoning_effort":" ","output_config":{"effort":"xhigh"}}`)
	got := mappedReasoningEffort(ptrTo("max"), map[string]string{"max": " "}, prepared)
	if got == nil || *got != "xhigh" {
		t.Fatalf("upstream effort = %v, want xhigh", got)
	}
}

func assertStringPointer(t *testing.T, name string, got, want *string) {
	t.Helper()
	if got == nil || want == nil {
		if got != nil || want != nil {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
		return
	}
	if *got != *want {
		t.Errorf("%s = %q, want %q", name, *got, *want)
	}
}
