package handlers

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

func responseReference(path string, body *proxy.RequestBody) (string, error) {
	if rest, ok := strings.CutPrefix(path, "responses/"); ok && rest != "compact" {
		id, _, _ := strings.Cut(rest, "/")
		if !models.ValidResponseID(id) {
			return "", apperr.BadRequest("invalid response ID")
		}
		return id, nil
	}
	if path != "responses" {
		return "", nil
	}
	id := body.PreviousResponseID()
	if id == "" {
		return "", nil
	}
	if !models.ValidResponseID(id) {
		return "", apperr.BadRequest("invalid previous_response_id")
	}
	return id, nil
}

func loadResponseRoute(r *http.Request, state *appstate.State, tokenID int64,
	path string, body *proxy.RequestBody) (*models.ResponseRoute, error) {
	id, err := responseReference(path, body)
	if err != nil || id == "" {
		return nil, err
	}
	route, found, err := db.GetResponseRoute(r.Context(), state.DB, tokenID, id)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, apperr.NotFound("response not found")
	}
	return &route, nil
}

func responseRouteSelector(route *models.ResponseRoute, selected *proxy.Selection,
	selector *string) (*string, error) {
	if route == nil {
		return selector, nil
	}
	if selector != nil && (selected == nil || selected.Upstream.ID != route.UpstreamID) {
		return nil, apperr.NotFound("response not found on the selected channel")
	}
	id := strconv.FormatInt(route.UpstreamID, 10)
	return &id, nil
}

func responseRouteKey(route *models.ResponseRoute, selected *proxy.Selection) (models.UpstreamKey, bool) {
	if route.KeyID == 0 {
		return models.UpstreamKey{}, len(selected.Keys) == 0
	}
	for _, key := range selected.Keys {
		if key.ID == route.KeyID {
			return key, true
		}
	}
	return models.UpstreamKey{}, false
}

func rememberResponseRoute(r *http.Request, state *appstate.State, config proxyAttemptConfig,
	upstream models.UpstreamRow, key models.UpstreamKey, prepared *proxy.PreparedRequest) func(string) error {
	if config.auth.TokenID <= 0 || r.Method != http.MethodPost || config.path != "responses" {
		return nil
	}
	if config.requestBody.StoreDisabled() {
		return nil
	}
	route := models.ResponseRoute{
		TokenID: config.auth.TokenID, UpstreamID: upstream.ID, KeyID: key.ID,
		CredentialDigest: proxy.ResponseCredentialDigest(&upstream, prepared.ForwardHeaders),
	}
	if config.model != nil {
		route.RequestModel = *config.model
	}
	return func(id string) error {
		if !models.ValidResponseID(id) {
			return apperr.Upstream("upstream returned an invalid response ID")
		}
		route.ResponseID = id
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		return db.StoreResponseRoute(ctx, state.DB, route)
	}
}
