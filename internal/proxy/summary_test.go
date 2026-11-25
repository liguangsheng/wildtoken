package proxy

import (
	"encoding/json"
	"math/rand"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// The whole-body decodes decodeMembers replaced, kept as references.
func wholeBodyUsage(body []byte) TokenUsage {
	var payload jsonValue
	if err := json.Unmarshal(body, &payload); err == nil {
		if usage, ok := usageFromValue(payload); ok {
			return usage
		}
	}
	return TokenUsage{}
}

func wholeBodyEffort(body []byte) *string {
	var payload jsonValue
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil
	}
	if effort, ok := responseReasoningEffortFromValue(payload); ok {
		return &effort
	}
	return nil
}

func checkSummaryAgrees(t *testing.T, body []byte) {
	t.Helper()
	if got, want := ExtractUsage(body, "application/json"), wholeBodyUsage(body); !reflect.DeepEqual(got, want) {
		t.Fatalf("ExtractUsage(%q) = %+v, whole-body decode %+v", body, got, want)
	}
	if got, want := ExtractResponseReasoningEffort(body, "application/json"), wholeBodyEffort(body); !reflect.DeepEqual(got, want) {
		t.Fatalf("ExtractResponseReasoningEffort(%q) = %v, whole-body decode %v", body, got, want)
	}
}

func TestSummaryAgreesWithWholeBodyDecoding(t *testing.T) {
	usage := `{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":4}}`
	for _, body := range []string{
		`{"usage":` + usage + `}`,
		`{"usage":` + usage + `,"usage":null}`,
		`{"usage":null,"usage":` + usage + `}`,
		`{"response":{"usage":` + usage + `,"reasoning":{"effort":" high "}}}`,
		`{"message":{"usage":{"input_tokens":3,"output_tokens":2}},"type":"message_start"}`,
		`{"reasoning":{"effort":"low"},"response":"not an object"}`,
		`{"reasoning":{"effort":"low"},"response":{"reasoning":{"effort":""}}}`,
		`{"reasoning":{"effort":7}}`,
		`{"usage":` + usage + `,"content":[{"type":"text","text":"` + strings.Repeat("é", 1000) + `"}]}`,
		`{"usage":` + usage + `,"big":1e400}`,
		`{"usage":` + usage + `,"big":-1e400}`,
		`{"usage":` + usage + `,"small":1e-400}`,
		`{"usage":` + usage + `,"n":12345678901234567890}`,
		`{"usage":` + usage, `[{"usage":` + usage + `}]`, `null`, `"usage"`, ``, `{}`,
		`{"usage":{"total_tokens":"17"}}`, `{"usage":[]}`, `{"usage":{"input_tokens":2147483648}}`,
	} {
		checkSummaryAgrees(t, []byte(body))
	}
}

func TestSummaryAgreesOnRandomBodies(t *testing.T) {
	r := rand.New(rand.NewSource(11))
	values := []string{
		`{"prompt_tokens":1,"completion_tokens":2}`, `{"input_tokens":5,"cache_read_input_tokens":3}`,
		`{"effort":"medium"}`, `{"reasoning":{"effort":"xhigh"},"usage":{"total_tokens":9}}`,
		`null`, `"x"`, `[1,2]`, `1e400`, `{"usage":{"output_tokens":4}}`,
	}
	names := []string{"usage", "response", "message", "reasoning", "content", "id"}
	for round := 0; round < 20000; round++ {
		members := make([]string, r.Intn(5))
		for i := range members {
			members[i] = `"` + names[r.Intn(len(names))] + `":` + values[r.Intn(len(values))]
		}
		checkSummaryAgrees(t, []byte("{"+strings.Join(members, ",")+"}"))
	}
}

func FuzzSummary(f *testing.F) {
	f.Add([]byte(`{"usage":{"prompt_tokens":1},"response":{"reasoning":{"effort":"high"}}}`))
	f.Fuzz(func(t *testing.T, body []byte) { checkSummaryAgrees(t, body) })
}

// Only usage is decoded from a long completion, not its content.
func TestSummaryLeavesContentUndecoded(t *testing.T) {
	body := []byte(`{"content":[{"type":"text","text":"` + strings.Repeat("x", 1<<20) +
		`"}],"usage":{"input_tokens":3,"output_tokens":2}}`)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	var usage TokenUsage
	for range 10 {
		usage = ExtractUsage(body, "application/json")
	}
	runtime.ReadMemStats(&after)
	if usage.TotalTokens == nil || *usage.TotalTokens != 5 {
		t.Fatalf("usage = %+v", usage)
	}
	// The whole-body decode allocated the 1 MiB text at least once per call.
	if perCall := (after.TotalAlloc - before.TotalAlloc) / 10; perCall > 64<<10 {
		t.Fatalf("ExtractUsage allocated %d bytes per call", perCall)
	}
}
