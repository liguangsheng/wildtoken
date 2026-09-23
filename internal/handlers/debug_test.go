package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// debugRouter mounts the debug endpoint the way the admin router does.
func debugRouter(t *testing.T) (http.Handler, *httptest.Server, *string) {
	t.Helper()
	state := proxyRateLimitState(t)

	// The upstream splits "你好" across two writes, mid-character, the way a
	// network read can.
	var received string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received = r.URL.Path + " " + string(body)
		w.Header().Set("content-type", "text/event-stream")
		reply := []byte("data: 你好\n\n")
		w.Write(reply[:8])
		w.(http.Flusher).Flush()
		w.Write(reply[8:])
	}))
	t.Cleanup(upstream.Close)
	createChannel(t, state, "debug", upstream.URL, 100, nil)

	router := chi.NewRouter()
	router.Post("/upstreams/{id}/debug", AdminDebugUpstream(state))
	return router, upstream, &received
}

func postDebug(router http.Handler, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/upstreams/1/debug", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestDebugSendsTheEditedBodyAndStreamsTheAnswer(t *testing.T) {
	router, _, received := debugRouter(t)

	response := postDebug(router, `{"protocol":"chat_completions","body":{"model":"m","stream":true,"temperature":0}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}

	// The body goes upstream untouched, to the protocol's endpoint.
	if want := `/v1/chat/completions {"model":"m","stream":true,"temperature":0}`; *received != want {
		t.Errorf("upstream got %q, want %q", *received, want)
	}

	stream := response.Body.String()
	for _, event := range []string{"event: request\n", "event: response\n", "event: done\n"} {
		if !strings.Contains(stream, event) {
			t.Errorf("missing %q in:\n%s", event, stream)
		}
	}
	if strings.Contains(stream, "\\ufffd") || strings.Contains(stream, "�") {
		t.Errorf("a character split across reads came out mangled:\n%s", stream)
	}
	if !strings.Contains(stream, "你") || !strings.Contains(stream, "好") {
		t.Errorf("reply text lost:\n%s", stream)
	}
}

func TestDebugSendsAnImageRequestToTheGenerationsEndpoint(t *testing.T) {
	router, _, received := debugRouter(t)

	response := postDebug(router, `{"protocol":"images","body":{"model":"gpt-image","prompt":"cat"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if want := `/v1/images/generations {"model":"gpt-image","prompt":"cat"}`; *received != want {
		t.Errorf("upstream got %q, want %q", *received, want)
	}
}

func TestDebugRejectsANonObjectBody(t *testing.T) {
	router, _, received := debugRouter(t)

	for _, body := range []string{
		`{"protocol":"chat_completions","body":[1]}`,
		`{"protocol":"chat_completions"}`,
		`{"protocol":"completions","body":{}}`,
	} {
		if response := postDebug(router, body); response.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", body, response.Code)
		}
	}
	if *received != "" {
		t.Errorf("a rejected request still reached the upstream: %q", *received)
	}
}

func TestRuneSplitterHoldsBackAnUnfinishedCharacter(t *testing.T) {
	var splitter runeSplitter
	text := []byte("a你b")

	// "你" is 3 bytes at index 1..3; cut after its first byte.
	if got := splitter.push(text[:2]); got != "a" {
		t.Errorf("first push = %q, want %q", got, "a")
	}
	if got := splitter.push(text[2:]); got != "你b" {
		t.Errorf("second push = %q, want %q", got, "你b")
	}
	if got := splitter.flush(); got != "" {
		t.Errorf("flush = %q, want empty", got)
	}
}
