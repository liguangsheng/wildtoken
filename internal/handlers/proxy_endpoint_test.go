package handlers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// noRetries keeps a failing request to one attempt, so a test does not wait
// out the same-channel retry interval.
func noRetries(state *appstate.State) {
	settings := state.Runtime.Get()
	settings.MaxRetries = 0
	state.Runtime.Set(settings)
}

func proxyCall(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("authorization", "Bearer caller-token")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

// Files, batches and the like belong to the upstream account every token
// shares; the gateway does not relay them.
func TestAnAccountEndpointIsNotRelayed(t *testing.T) {
	state := proxyRateLimitState(t)
	server, hits := countingUpstream(t)
	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "only", server.URL, 100, nil)

	response := proxyCall(proxyRateLimitRouter(state), http.MethodGet, "/v1/files", "")
	if response.Code != http.StatusNotFound || hits.Load() != 0 {
		t.Errorf("status=%d hits=%d, want 404 without reaching the upstream",
			response.Code, hits.Load())
	}
}

// An oversized body is refused as 413, in the protocol the caller speaks.
func TestAnOversizedBodyIsRefusedInTheCallersProtocol(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")

	oversized := io.MultiReader(strings.NewReader(`{"model":"m","x":"`),
		io.LimitReader(zeros{}, maxDownstreamBodyBytes))
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", oversized)
	request.Header.Set("x-api-key", "caller-token")
	recorder := httptest.NewRecorder()
	proxyRateLimitRouter(state).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge ||
		!strings.Contains(recorder.Body.String(), `"type":"error"`) {
		t.Errorf("returned %d %s, want an Anthropic-shaped 413", recorder.Code, recorder.Body.String())
	}
}

// A body declared over the limit is refused before it is read; the one
// that only shows its size as it arrives is the case above.
func TestADeclaredOversizedBodyIsRefusedUnread(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")

	body := &countingReader{}
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", body)
	request.ContentLength = maxDownstreamBodyBytes + 1
	request.Header.Set("x-api-key", "caller-token")
	recorder := httptest.NewRecorder()
	proxyRateLimitRouter(state).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge || body.read != 0 {
		t.Errorf("returned %d after reading %d bytes, want 413 unread", recorder.Code, body.read)
	}
}

// A declared length arrives whole, in one allocation of that size.
func TestADeclaredBodyIsReadWhole(t *testing.T) {
	sent := `{"model":"m","messages":[{"role":"user","content":"` + strings.Repeat("é", 70000) + `"}]}`
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(sent))
	body, err := readDownstreamBody(httptest.NewRecorder(), request)
	if err != nil || string(body) != sent || cap(body) != len(sent) {
		t.Fatalf("read %d bytes (cap %d), err %v; want %d exactly", len(body), cap(body), err, len(sent))
	}

	short := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(sent[:10]))
	short.ContentLength = int64(len(sent))
	if _, err := readDownstreamBody(httptest.NewRecorder(), short); err == nil {
		t.Fatal("a body shorter than its declared length was accepted")
	}
}

type countingReader struct{ read int }

func (c *countingReader) Read(p []byte) (int, error) {
	c.read += len(p)
	for i := range p {
		p[i] = '0'
	}
	return len(p), nil
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = '0'
	}
	return len(p), nil
}

// The transport's error names the upstream URL, path and query. That is for
// the log; the caller is told only that the upstream failed.
func TestAFailedUpstreamIsNotDescribedToTheCaller(t *testing.T) {
	state := proxyRateLimitState(t)
	noRetries(state)
	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "unreachable", "http://127.0.0.1:1/tenant-secret", 100, nil)

	response := sendProxyRequest(proxyRateLimitRouter(state), "caller-token")
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "tenant-secret") ||
		strings.Contains(response.Body.String(), "127.0.0.1") {
		t.Errorf("returned %d %s, want a 502 that names no upstream", response.Code, response.Body.String())
	}
}

// A timeout answers 504, as the log records it, not 502.
func TestAnUpstreamTimeoutAnswers504(t *testing.T) {
	state := proxyRateLimitState(t)
	noRetries(state)
	insertCallerToken(t, state.DB, "caller-token")
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer server.Close()
	defer close(release)

	timeout := 0.1
	input := models.DefaultUpstreamIn()
	input.Name = "slow"
	input.BaseURL = server.URL
	input.ModelNames = []string{"test-model"}
	input.TimeoutSeconds = &timeout
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input); err != nil {
		t.Fatal(err)
	}

	response := sendProxyRequest(proxyRateLimitRouter(state), "caller-token")
	if response.Code != http.StatusGatewayTimeout {
		t.Errorf("returned %d %s, want 504", response.Code, response.Body.String())
	}
}

// A channel whose stored headers no longer build a request is logged and
// passed over, not the end of the request.
func TestAMisconfiguredChannelIsPassedOver(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	broken, brokenHits := countingUpstream(t)
	healthy, healthyHits := countingUpstream(t)
	createChannel(t, state, "broken", broken.URL, 999, nil)
	createChannel(t, state, "healthy", healthy.URL, 100, nil)
	if _, err := state.DB.Exec(`UPDATE upstreams SET extra_headers = '{"Bad Header":"x"}'
        WHERE name = 'broken'`); err != nil {
		t.Fatal(err)
	}
	state.Routing.Invalidate()

	response := sendProxyRequest(proxyRateLimitRouter(state), "caller-token")
	if response.Code != http.StatusOK || healthyHits.Load() != 1 || brokenHits.Load() != 0 {
		t.Fatalf("status=%d healthy=%d broken=%d, want the healthy channel to answer",
			response.Code, healthyHits.Load(), brokenHits.Load())
	}

	state.LogWriter.Close()
	var failed int
	if err := state.DB.QueryRow(`SELECT COUNT(*) FROM request_logs
        WHERE upstream_name = 'broken' AND status_code = 502`).Scan(&failed); err != nil {
		t.Fatal(err)
	}
	if failed != 1 {
		t.Errorf("%d rows record the broken channel's failure, want 1", failed)
	}
}

// An archived channel does not route, so a model list asked for it names
// nothing, whatever an old row's enabled column says.
func TestAnArchivedChannelListsNoModels(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "parked", "https://example.test", 100, nil)
	if _, err := state.DB.Exec(`UPDATE upstreams SET archived = 1, enabled = 1
        WHERE name = 'parked'`); err != nil {
		t.Fatal(err)
	}
	var id string
	if err := state.DB.QueryRow(`SELECT id FROM upstreams WHERE name = 'parked'`).Scan(&id); err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	router.Use(middleware.RequireDownstream(state.DB, state.TokenRateLimiter, state.Quotas))
	router.Get("/v1/models", ListModelsHandler(state))
	response := proxyCall(router, http.MethodGet, "/v1/models?upstream="+id, "")
	if strings.Contains(response.Body.String(), "test-model") {
		t.Errorf("an archived channel's models were listed: %s", response.Body.String())
	}
}
