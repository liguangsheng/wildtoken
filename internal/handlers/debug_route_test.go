package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func routeDebugRequest(handler http.Handler, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/admin/debug", strings.NewReader(body))
	r.Header.Set("x-admin-token", "private-admin-token")
	r.Header.Set("cookie", "private-cookie")
	r.Header.Set("x-wildtoken-upstream", "9999")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestDebugRouteUsesModelMappingsAndChannelRateLimit(t *testing.T) {
	state := proxyRateLimitState(t)
	var primaryHits, fallbackHits atomic.Int64
	upstream := func(hits *atomic.Int64) *httptest.Server {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			body, _ := io.ReadAll(r.Body)
			if bodyModel(body) != "provider-model" || r.URL.Path != "/v1/chat/completions" {
				t.Errorf("wrong forwarded request: %s %s", r.URL, body)
			}
			if r.Header.Get("x-admin-token") != "" || r.Header.Get("cookie") != "" || r.Header.Get("x-wildtoken-upstream") != "" {
				t.Error("admin/browser headers reached the upstream")
			}
			w.Header().Set("content-type", "application/json")
			w.Header().Set("set-cookie", "upstream-secret")
			io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"total_tokens":3}}`)
		}))
		t.Cleanup(server.Close)
		return server
	}
	primary, fallback := upstream(&primaryHits), upstream(&fallbackHits)
	for index, server := range []*httptest.Server{primary, fallback} {
		input := models.DefaultUpstreamIn()
		input.Name, input.BaseURL = []string{"primary", "fallback"}[index], server.URL
		input.Priority = []int32{999, 100}[index]
		input.ModelNames = []string{"alias"}
		input.ModelMappings = map[string]string{"alias": "provider-model"}
		if index == 0 {
			limit := "1/h"
			input.RateLimit = &limit
		}
		if _, err := db.CreateUpstream(context.Background(), state.DB, &input); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		response := routeDebugRequest(AdminDebugRoute(state), `{"protocol":"chat_completions","body":{"model":"alias","messages":[{"role":"user","content":"hi"}]}}`)
		if response.Code != http.StatusOK {
			t.Fatalf("status %d: %s", response.Code, response.Body)
		}
		for _, text := range []string{"event: request", "event: response", "event: chunk", "event: done", `\"content\":\"ok\"`} {
			if !strings.Contains(response.Body.String(), text) {
				t.Errorf("missing %q: %s", text, response.Body)
			}
		}
		if strings.Contains(response.Body.String(), "private-admin-token") || strings.Contains(response.Body.String(), "upstream-secret") {
			t.Error("debug response leaked a credential")
		}
	}
	if primaryHits.Load() != 1 || fallbackHits.Load() != 1 {
		t.Fatalf("routing did not fail over: primary=%d fallback=%d", primaryHits.Load(), fallbackHits.Load())
	}
	state.LogWriter.Close()
	var logs, charged int
	if err := state.DB.QueryRow(`SELECT COUNT(*), COUNT(downstream_token_id) FROM request_logs`).Scan(&logs, &charged); err != nil {
		t.Fatal(err)
	}
	if logs < 2 || charged != 0 {
		t.Fatalf("logs=%d, token charges=%d", logs, charged)
	}
}

func TestDebugRouteRespectsGroupAndModelFilters(t *testing.T) {
	state := proxyRateLimitState(t)
	server, hits := countingUpstream(t)
	createChannel(t, state, "default-only", server.URL, 100, nil)
	group, err := db.CreateGroup(context.Background(), state.DB, &models.GroupIn{Name: "empty"})
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []map[string]any{
		{"protocol": "responses", "body": map[string]any{"model": "missing"}},
		{"protocol": "responses", "group_id": group.ID, "body": map[string]any{"model": "test-model"}},
	} {
		encoded, _ := json.Marshal(payload)
		response := routeDebugRequest(AdminDebugRoute(state), string(encoded))
		if !strings.Contains(response.Body.String(), `"status_code":503`) {
			t.Fatalf("expected no route: %s", response.Body)
		}
	}
	if hits.Load() != 0 {
		t.Fatal("unmatched requests reached the upstream")
	}
}

func TestDebugRouteRejectsInvalidRequestsBeforeRouting(t *testing.T) {
	state := proxyRateLimitState(t)
	for _, payload := range []string{
		`{"protocol":"unknown","body":{"model":"m"}}`,
		`{"protocol":"responses","body":null}`,
		`{"protocol":"responses","body":{}}`,
		`{"protocol":"responses","group_id":0,"body":{"model":"m"}}`,
		`{"protocol":"responses","group_id":999,"body":{"model":"m"}}`,
		`{"protocol":"responses","token_id":1,"body":{"model":"m"}}`,
	} {
		response := routeDebugRequest(AdminDebugRoute(state), payload)
		if response.Code < 400 {
			t.Errorf("accepted %s: %s", payload, response.Body)
		}
	}
}

func TestDebugRoutePropagatesStreamReadFailure(t *testing.T) {
	state := proxyRateLimitState(t)
	state.HTTPClient.Transport = brokenDebugTransport{}
	createChannel(t, state, "broken", "https://fake.invalid", 100, nil)
	response := routeDebugRequest(AdminDebugRoute(state), `{"protocol":"chat_completions","body":{"model":"test-model","stream":true}}`)
	if !strings.Contains(response.Body.String(), "event: error") || strings.Contains(response.Body.String(), "event: done") {
		t.Fatalf("stream failure was hidden: %s", response.Body)
	}
}

type brokenDebugTransport struct{}

func (brokenDebugTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: &brokenDebugBody{}}, nil
}

type brokenDebugBody struct{ sent bool }

func (b *brokenDebugBody) Read(p []byte) (int, error) {
	if b.sent {
		return 0, io.ErrUnexpectedEOF
	}
	b.sent = true
	return copy(p, "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"), nil
}
func (*brokenDebugBody) Close() error { return nil }
