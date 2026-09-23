package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestARestrictedTokenIsRefusedModelsOutsideItsAllowlist(t *testing.T) {
	state := proxyRateLimitState(t)
	upstream, hits := countingUpstream(t)
	createChannel(t, state, "only", upstream.URL, 100, nil)

	created, err := db.CreateToken(context.Background(), state.DB, &models.APITokenIn{
		Name: "restricted", Enabled: true, AllowedModels: []string{"other-model"},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}
	router := proxyRateLimitRouter(state)

	// test-model is routable but not on the list: refused before any channel.
	response := sendProxyRequest(router, created.Token)
	if response.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403: %s", response.Code, response.Body.String())
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream hit %d times, want 0", hits.Load())
	}

	// Widening the list by prefix admits it.
	if _, err := db.UpdateToken(context.Background(), state.DB, created.ID, &models.APITokenUpdateIn{
		Name: "restricted", AllowedModels: []string{"test-*"},
	}); err != nil {
		t.Fatalf("update token: %v", err)
	}
	if response := sendProxyRequest(router, created.Token); response.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", response.Code, response.Body.String())
	}
}

func TestModelsListIsFilteredByTheTokenAllowlist(t *testing.T) {
	state := proxyRateLimitState(t)
	input := models.DefaultUpstreamIn()
	input.Name = "multi"
	input.BaseURL = "http://127.0.0.1:1"
	input.ModelNames = []string{"gpt-4o", "gpt-4o-mini", "o3"}
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input, 30); err != nil {
		t.Fatalf("create channel: %v", err)
	}

	created, err := db.CreateToken(context.Background(), state.DB, &models.APITokenIn{
		Name: "restricted", Enabled: true, AllowedModels: []string{"gpt-4o*"},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	router := proxyRateLimitRouter(state)
	router.(interface {
		Get(string, http.HandlerFunc)
	}).Get("/v1/models", ListModelsHandler(state))

	request := httptest.NewRequest(http.MethodGet, "/v1/models", strings.NewReader(""))
	request.Header.Set("authorization", "Bearer "+created.Token)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("got %d: %s", recorder.Code, recorder.Body.String())
	}

	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ids := []string{}
	for _, entry := range body.Data {
		ids = append(ids, entry.ID)
	}
	if strings.Join(ids, ",") != "gpt-4o,gpt-4o-mini" {
		t.Fatalf("ids = %v", ids)
	}
}
