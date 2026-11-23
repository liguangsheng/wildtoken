package proxy

import (
	"net/http"
	"strings"
	"testing"
)

var (
	requestBodyBenchmarkSink    []byte
	requestModelBenchmarkSink   *string
	requestEffortBenchmarkSink  *string
	sseObservationBenchmarkSink sseObservation
)

func BenchmarkRequestBodyPipeline(b *testing.B) {
	content := strings.Repeat("x", 1<<20)
	body := []byte(`{"model":"downstream","reasoning":{"effort":"high"},"stream":true,"messages":[{"role":"user","content":"` + content + `"}]}`)
	headers := make(http.Header)
	mappings := map[string]string{"high": "xhigh"}
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		parsed, err := ParseRequestBody(headers, body)
		if err != nil {
			b.Fatal(err)
		}
		prepared, err := parsed.Prepare(parsed.Model(), "chat/completions", mappings)
		if err != nil {
			b.Fatal(err)
		}
		requestModelBenchmarkSink = parsed.Model()
		requestEffortBenchmarkSink = mappedReasoningEffort(parsed.ReasoningEffort(), mappings, prepared)
		requestBodyBenchmarkSink = prepared
	}
}

func BenchmarkSSEObserveLine(b *testing.B) {
	line := []byte(`data: {"type":"response.output_text.delta","delta":"hello","response":{"id":"resp-1"},"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}`)
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		var observation sseObservation
		observation.observeLine(line, func() int32 { return 1 })
		sseObservationBenchmarkSink = observation
	}
}
