// Package handlers implements the HTTP endpoints WildToken serves.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// maxDownstreamBodyBytes bounds a downstream request body, so one caller cannot
// exhaust memory with an unbounded upload.
const maxDownstreamBodyBytes = 50 * 1024 * 1024

// hopByHopResponseHeaders must not be copied back to the downstream client.
var hopByHopResponseHeaders = []string{
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authenticate",
	"proxy-authorization",
	"content-encoding",
	"content-length",
}

func parseModelFromBody(body []byte) *string {
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		return nil
	}
	model, ok := request["model"].(string)
	if !ok || model == "" {
		return nil
	}
	return &model
}

// upstreamSelector reads an explicit channel hint from the header or query.
func upstreamSelector(r *http.Request) *string {
	if value := strings.TrimSpace(r.Header.Get("x-wildtoken-upstream")); value != "" {
		return &value
	}
	if value := r.URL.Query().Get("upstream"); value != "" {
		return &value
	}
	return nil
}

// writeProtocolError renders an error in the shape the caller's protocol expects.
func writeProtocolError(w http.ResponseWriter, status int, path, message, errorType string) {
	if models.IsAnthropicMessages(models.ProxyPath(path)) {
		apperr.WriteJSON(w, status, map[string]any{
			"type":  "error",
			"error": map[string]string{"type": errorType, "message": message},
		})
		return
	}
	apperr.WriteJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    errorType,
			"code":    nil,
		},
	})
}

// UpstreamRateLimitedCode identifies "every routable channel is rate-limited"
// at the top level of the refusal, mirroring the API-key rejections in
// middleware: a caller that does not speak either vendor's error shape can
// branch on it.
const UpstreamRateLimitedCode = "UPSTREAM_RATE_LIMITED"

// UpstreamRateLimitedMessage is the operator-facing summary carried alongside
// the code.
const UpstreamRateLimitedMessage = "渠道请求频率超限"

// writeUpstreamRateLimitRejection reports that routing found candidates, but
// every one of them is currently rate-limited.
//
// The refusal heals itself once a window slides, so both vendor dialects use
// their rate-limit shape, which is what SDK retry logic keys on. The body
// carries the refusal twice for the same reason the token-side rejections do: a
// vendor SDK only looks inside `error`, while a caller written against this
// proxy reads the top-level code.
func writeUpstreamRateLimitRejection(w http.ResponseWriter, path string) {
	detail := "所有可路由渠道均已达到限速，请稍后重试"
	body := map[string]any{
		"code":    UpstreamRateLimitedCode,
		"message": UpstreamRateLimitedMessage,
	}
	if models.IsAnthropicMessages(models.ProxyPath(path)) {
		body["type"] = "error"
		body["error"] = map[string]string{"type": "rate_limit_error", "message": detail}
	} else {
		body["error"] = map[string]string{
			"message": detail,
			"type":    "rate_limit_exceeded",
			"code":    "rate_limit_exceeded",
		}
	}
	apperr.WriteJSON(w, http.StatusTooManyRequests, body)
}

// modelNotAllowedMessage explains a refusal by the token's model allowlist.
func modelNotAllowedMessage(model *string) string {
	if model == nil {
		return "this API key is restricted to specific models; the request names none"
	}
	return "this API key is not allowed to use model " + strconv.Quote(*model)
}

// filterAllowedModelIDs keeps the ids a token's allowlist admits.
func filterAllowedModelIDs(ids, allowed []string) []string {
	if len(allowed) == 0 {
		return ids
	}
	kept := []string{}
	for _, id := range ids {
		if models.ModelAllowed(allowed, id) {
			kept = append(kept, id)
		}
	}
	return kept
}

// noRouteReason describes why routing found no upstream.
//
// The text goes to both the downstream error body and the request log, so a 503
// can be traced back to the requested model and channel hint without
// reproducing the request.
// noRouteReason names the group as well, because with group isolation the same
// model can be routable for one token and not for another; without it a 503
// would be indistinguishable from a misconfigured channel.
func noRouteReason(selector, model *string, groupName string) string {
	target := "a request without a model"
	if model != nil {
		target = "model " + strconv.Quote(*model)
	}
	scope := " in group " + strconv.Quote(groupName)
	if selector != nil {
		return "no enabled upstream matches " + target + scope +
			" on the requested channel " + strconv.Quote(*selector)
	}
	return "no enabled upstream matches " + target + scope
}

// abortLogGuard records a request that ended before the proxy could log it.
//
// Rust armed this through Drop. Go has no destructor, so every exit path calls
// either Disarm or one of the logging methods; the handler defers Finish as the
// backstop for a panic or an early return that forgets.
//
// It also carries the request's entry in the in-flight registry. The two track
// the same facts from the same call sites, so keeping them together is what
// stops the console's live view from disagreeing with the log it turns into.
type abortLogGuard struct {
	logWriter *proxy.LogWriter
	startedAt time.Time
	entry     *proxy.LogEntry
	active    *proxy.ActiveRequest
}

func newAbortLogGuard(logWriter *proxy.LogWriter, active *proxy.ActiveRequest,
	method, path string) *abortLogGuard {
	status := int32(499)
	message := "client disconnected before proxy completed"
	return &abortLogGuard{
		logWriter: logWriter,
		active:    active,
		startedAt: time.Now(),
		entry: &proxy.LogEntry{
			Method:     method,
			Path:       path,
			StatusCode: &status,
			Error:      &message,
		},
	}
}

func (g *abortLogGuard) setModel(model *string) {
	g.active.SetModel(model)
	if g.entry == nil {
		return
	}
	g.entry.Model = model
	g.entry.RequestModel = model
}

func (g *abortLogGuard) setDownstreamToken(tokenID int64, tokenName string) {
	g.active.SetDownstreamToken(tokenID, tokenName)
	if g.entry == nil {
		return
	}
	g.entry.DownstreamTokenID = &tokenID
	g.entry.DownstreamTokenName = &tokenName
}

// clientIP resolves the caller's address for the log row.
//
// The deployment runs behind a reverse proxy, so the socket peer is the proxy
// and the forwarded headers carry the caller. X-Forwarded-For is a list that
// grows left to right as it crosses hops, so the original client is leftmost.
//
// Only the first entry is read and it is length-capped: the header is
// attacker-influenced even behind a proxy, and an unbounded value would be
// written verbatim into every log row.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		first, _, _ := strings.Cut(forwarded, ",")
		if address := strings.TrimSpace(first); address != "" {
			return boundedClientIP(address)
		}
	}
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		return boundedClientIP(real)
	}
	// RemoteAddr carries a port; the port identifies the connection, not the
	// caller, and differs on every request from the same client.
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return boundedClientIP(host)
	}
	return boundedClientIP(r.RemoteAddr)
}

// maxClientIPChars bounds a header-sourced address. IPv6 with a zone runs to
// about 45 characters, so this leaves room without allowing a log row to carry
// an arbitrary payload.
const maxClientIPChars = 64

func boundedClientIP(address string) string {
	if len(address) > maxClientIPChars {
		return address[:maxClientIPChars]
	}
	return address
}

func (g *abortLogGuard) setClientIP(address string) {
	if address == "" {
		return
	}
	// The in-flight row shows the same column, so both sides get it.
	g.active.SetClientIP(address)
	if g.entry == nil {
		return
	}
	g.entry.ClientIP = &address
}

func (g *abortLogGuard) setClientType(clientType string) {
	g.active.SetClientType(clientType)
	if g.entry == nil {
		return
	}
	g.entry.ClientType = &clientType
}

func (g *abortLogGuard) setUpstream(upstreamID int64, upstreamName string, forwardModel *string) {
	g.active.SetUpstream(upstreamID, upstreamName, forwardModel)
	if g.entry == nil {
		return
	}
	g.entry.UpstreamID = &upstreamID
	g.entry.UpstreamName = &upstreamName
	g.entry.UpstreamModel = forwardModel
	if forwardModel != nil {
		g.entry.Model = forwardModel
	}
}

// setPreparedRequest takes everything the prepared attempt knows: the snapshots
// for the abort log, and the reasoning efforts for both the abort log and the
// console's in-flight view.
//
// The efforts used to be dropped here. ProxyRequest fills them in on the logs it
// writes itself, so only the rows this guard produces went without — a client
// disconnect or a channel whose headers will not build — and the effort those
// requests ran at was exactly what made them worth reading.
func (g *abortLogGuard) setPreparedRequest(prepared *proxy.PreparedRequest) {
	g.active.SetReasoningEffort(prepared.ReasoningEffort, prepared.UpstreamReasoningEffort)
	if g.entry == nil {
		return
	}
	g.entry.DownstreamRequest = prepared.DownstreamSnapshot
	g.entry.UpstreamRequest = prepared.UpstreamSnapshot
	g.entry.ReasoningEffort = prepared.ReasoningEffort
	g.entry.UpstreamReasoningEffort = prepared.UpstreamReasoningEffort
}

// disarm gives up ownership of the log, because the proxy already wrote one.
func (g *abortLogGuard) disarm() { g.entry = nil }

// logAndDisarm records a specific failure instead of the default abort.
func (g *abortLogGuard) logAndDisarm(statusCode int32, message string) {
	entry := g.entry
	g.entry = nil
	if entry == nil {
		return
	}
	entry.StatusCode = &statusCode
	entry.Error = &message
	entry.DurationMs = g.elapsed()
	g.logWriter.Schedule(*entry)
}

// finish releases the in-flight entry and writes the default abort log if no
// other path claimed it.
//
// The release belongs here rather than in disarm, because the handler defers
// this and disarms before streaming the answer downstream: a streamed response
// is still in flight until this runs.
func (g *abortLogGuard) finish() {
	g.active.Release()

	entry := g.entry
	g.entry = nil
	if entry == nil {
		return
	}
	entry.DurationMs = g.elapsed()
	g.logWriter.Schedule(*entry)
}

func (g *abortLogGuard) elapsed() *int32 {
	measured := int32(time.Since(g.startedAt).Milliseconds())
	return &measured
}

// ProxyHandler forwards OpenAI-compatible requests to upstream providers.
func ProxyHandler(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.DownstreamAuthFrom(r.Context())
		if !ok {
			writeProtocolError(w, http.StatusUnauthorized, r.URL.Path,
				"Incorrect API key provided", "invalid_api_key")
			return
		}

		// The path after /v1/, for example "chat/completions".
		path := models.ProxyPath(r.URL.Path)

		guard := newAbortLogGuard(state.LogWriter,
			state.ActiveRequests.Begin(r.Method, path), r.Method, path)
		defer guard.finish()
		guard.setDownstreamToken(auth.TokenID, auth.TokenName)
		guard.setClientType(auth.ClientType)
		guard.setClientIP(clientIP(r))

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDownstreamBodyBytes))
		if err != nil {
			// A body that exceeded the cap is the caller's error; anything else
			// means the caller went away mid-upload.
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				guard.logAndDisarm(400, "failed to read downstream request body: "+err.Error())
				apperr.BadRequest("failed to read body: " + err.Error()).Write(w)
				return
			}
			guard.logAndDisarm(499,
				"client disconnected while reading downstream request body: "+err.Error())
			apperr.BadRequest("failed to read body: " + err.Error()).Write(w)
			return
		}

		model := parseModelFromBody(body)
		guard.setModel(model)

		// Checked before routing so a refused model never reaches a channel. A
		// restricted token must name a model: without one nothing can be checked.
		if len(auth.AllowedModels) > 0 &&
			(model == nil || !models.ModelAllowed(auth.AllowedModels, *model)) {
			message := modelNotAllowedMessage(model)
			guard.logAndDisarm(http.StatusForbidden, message)
			writeProtocolError(w, http.StatusForbidden, r.URL.Path, message, "permission_error")
			return
		}

		selector := upstreamSelector(r)

		runtimeSettings := state.Runtime.Get()
		policy := proxy.NewAutoWeightPolicy(&runtimeSettings)

		// A direct selection is resolved once; the retry loop reuses it rather
		// than re-running a selector that can only ever pick the same channel.
		var directSelection *proxy.Selection
		if selector != nil {
			directSelection, err = proxy.SelectUpstream(r.Context(), state.DB, state.Routing,
				state.AutoWeight, policy, selector, model, auth.GroupID, nil)
			if err != nil {
				guard.logAndDisarm(500, "upstream selection failed: "+err.Error())
				apperr.WriteError(w, err)
				return
			}
		}

		response, err := runProxyAttempts(w, r, state, proxyAttemptConfig{
			guard:           guard,
			auth:            auth,
			groupName:       resolveGroupName(r.Context(), state, auth.GroupID),
			path:            path,
			body:            body,
			model:           model,
			selector:        selector,
			directSelection: directSelection,
			policy:          policy,
			runtimeSettings: runtimeSettings,
		})
		if err != nil {
			// Every failing path inside runProxyAttempts logs the attempt it
			// failed on, with the status that describes it. Leaving the guard
			// armed added a second row for the same request, blaming a client
			// disconnect for what was an upstream failure and leaving the
			// console unable to tell the two apart.
			guard.disarm()
			apperr.WriteError(w, err)
			return
		}
		if response == nil {
			// Routing found nothing; the reason was already written and logged.
			return
		}
		guard.disarm()

		writeProxiedResponse(w, response)
	}
}

type proxyAttemptConfig struct {
	guard *abortLogGuard
	auth  middleware.DownstreamAuth
	// groupName is resolved once for the error message, so the retry loop does
	// not query it per attempt.
	groupName       string
	path            string
	body            []byte
	model           *string
	selector        *string
	directSelection *proxy.Selection
	policy          proxy.AutoWeightPolicy
	runtimeSettings models.RuntimeSettings
}

// runProxyAttempts forwards the request, retrying a failure up to the
// configured limit. A nil response with a nil error means routing produced no
// attempt and the refusal has already been written and logged: a 429 when every
// candidate was rate limited, a 503 when there was no route at all.
func runProxyAttempts(w http.ResponseWriter, r *http.Request, state *appstate.State,
	config proxyAttemptConfig) (*proxy.Response, error) {
	maxRetries := int(config.runtimeSettings.MaxRetries)
	logBodyMaxBytes := int(config.runtimeSettings.LogBodyMaxBytes)

	var previousUpstreamID *int64
	var lastFailure *attemptResult

	// rateLimited collects the channels whose rate limit refused this request.
	// A refused channel stays out of routing for the rest of the request, so
	// re-selection falls over to the remaining candidates instead of drawing the
	// same channel again. Nil until the first refusal.
	var rateLimited map[int64]bool

	for attempt := 0; ; attempt++ {
		// Selection repeats until a channel's rate limit admits the request;
		// admission records the request, refusal excludes the channel. The loop
		// terminates because every refusal shrinks the candidate set.
		var selected *proxy.Selection
		for {
			selected = config.directSelection
			if config.selector == nil {
				var err error
				selected, err = proxy.SelectUpstream(r.Context(), state.DB, state.Routing,
					state.AutoWeight, config.policy, nil, config.model, config.auth.GroupID,
					rateLimited)
				if err != nil {
					config.guard.logAndDisarm(500, "upstream selection failed: "+err.Error())
					return nil, err
				}
			} else if selected != nil && rateLimited[selected.Upstream.ID] {
				// A direct selector has no other candidate behind it.
				selected = nil
			}
			if selected == nil ||
				proxy.UpstreamRateLimitAdmits(state.UpstreamRateLimiter, &selected.Upstream) {
				break
			}
			if rateLimited == nil {
				rateLimited = map[int64]bool{}
			}
			rateLimited[selected.Upstream.ID] = true
		}

		if selected == nil {
			// Nothing else to try. A buffered failure is the caller's answer.
			if lastFailure != nil {
				return lastFailure.response, lastFailure.err
			}
			if len(rateLimited) > 0 {
				// Routing had candidates, but every one of them refused: the
				// request is only deferred, not unroutable, so the answer is a
				// 429 rather than the no-route 503.
				config.guard.logAndDisarm(429, "all candidate channels are rate limited")
				writeUpstreamRateLimitRejection(w, config.path)
				return nil, nil
			}
			reason := noRouteReason(config.selector, config.model, config.groupName)
			config.guard.logAndDisarm(503, reason)
			writeProtocolError(w, http.StatusServiceUnavailable,
				config.path, reason, "upstream_not_configured")
			return nil, nil
		}

		// Retrying the same channel immediately would usually hit the same
		// condition, so the configured pause applies first.
		if attempt > 0 && previousUpstreamID != nil &&
			*previousUpstreamID == selected.Upstream.ID &&
			config.runtimeSettings.SameUpstreamRetryIntervalMs > 0 {
			select {
			case <-r.Context().Done():
				// Logged here because no attempt was made to log it: this is
				// the one error path out of this function that ProxyRequest
				// never saw.
				config.guard.logAndDisarm(499, "client disconnected during retry backoff")
				return nil, apperr.Upstream("client disconnected during retry backoff")
			case <-time.After(time.Duration(config.runtimeSettings.SameUpstreamRetryIntervalMs) *
				time.Millisecond):
			}
		}

		// Once a new attempt has a route, the previous buffered failure is no
		// longer needed. Its log was already scheduled by ProxyRequest.
		lastFailure = nil

		config.guard.setUpstream(selected.Upstream.ID, selected.Upstream.Name, selected.ForwardModel)

		prepared, err := proxy.PrepareRequest(r.Header, &selected.Upstream, r.Method,
			config.path, r.URL.RawQuery, selected.ForwardModel, config.body, logBodyMaxBytes)
		if err != nil {
			// The channel's stored header configuration is what fails here, so
			// the channel is charged for it. A channel that cannot build a
			// request fails every one it is given, and without a penalty it
			// keeps full weight and keeps being chosen to fail again.
			state.AutoWeight.RecordFailure(selected.Upstream.ID,
				selected.Upstream.AutoWeightEnabled == 1, config.policy)
			config.guard.logAndDisarm(502, err.Error())
			return nil, err
		}
		config.guard.setPreparedRequest(prepared)

		response, err := proxy.ProxyRequest(r.Context(), state.ProxyDeps(), config.policy,
			&selected.Upstream, proxy.RequestContext{
				DownstreamTokenID:   config.auth.TokenID,
				DownstreamTokenName: config.auth.TokenName,
				// The success path builds its own LogEntry from this context, so
				// the guard's copy never reaches it.
				ClientIP:        clientIP(r),
				ClientType:      config.auth.ClientType,
				RequestModel:    config.model,
				ForwardModel:    selected.ForwardModel,
				Method:          r.Method,
				Path:            config.path,
				LogBodyMaxBytes: logBodyMaxBytes,
			}, prepared)

		failed := err != nil || response.Status < 200 || response.Status >= 300
		if !failed || attempt >= maxRetries {
			return response, err
		}
		// A client that has gone is not owed another attempt. Retrying spent
		// another channel's rate-limit allowance and wrote another log row for
		// a request nobody was waiting for, so one disconnect could leave a
		// handful of 499s behind it.
		if r.Context().Err() != nil {
			return response, err
		}

		// A failed attempt's body is buffered rather than discarded. Its
		// connection is released either way, but if no channel is left to try
		// this response is what the caller receives: draining it delivered the
		// upstream's status and headers with an empty body, throwing away the
		// only explanation of what went wrong.
		if response != nil {
			response.Body = bufferFailedBody(response.Body)
		}

		upstreamID := selected.Upstream.ID
		previousUpstreamID = &upstreamID
		lastFailure = &attemptResult{response: response, err: err}
	}
}

type attemptResult struct {
	response *proxy.Response
	err      error
}

// maxBufferedFailureBytes caps what is kept from a failed attempt. A provider's
// error body is a small piece of JSON, so this only bounds a channel that is
// answering a rejection with something unreasonable.
const maxBufferedFailureBytes = 1 << 20

// bufferFailedBody reads a failed attempt's body into memory and closes the
// original, returning a reader over what it held.
//
// The body is normally already buffered by the time it gets here, but reading it
// again is what makes the release of the connection unconditional rather than a
// property of which path produced the response.
func bufferFailedBody(body io.ReadCloser) io.ReadCloser {
	defer body.Close()

	buffered, err := io.ReadAll(io.LimitReader(body, maxBufferedFailureBytes))
	if err != nil {
		// Whatever could not be read is not worth failing the retry over; the
		// status and headers still describe the attempt.
		buffered = nil
	}
	return io.NopCloser(bytes.NewReader(buffered))
}

// writeProxiedResponse copies an upstream response downstream, streaming it as
// it arrives so an SSE body is not buffered.
func writeProxiedResponse(w http.ResponseWriter, response *proxy.Response) {
	defer response.Body.Close()

	header := w.Header()
	for name, value := range response.Headers {
		if containsFold(hopByHopResponseHeaders, name) {
			continue
		}
		header.Set(name, value)
	}
	w.WriteHeader(response.Status)

	flusher, canFlush := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	for {
		read, err := response.Body.Read(buffer)
		if read > 0 {
			if _, writeErr := w.Write(buffer[:read]); writeErr != nil {
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// AggregateModelIDs collects unique model ids from enabled upstream configs,
// from their names and mapping keys.
func AggregateModelIDs(upstreams []models.UpstreamRow) []string {
	unique := map[string]bool{}

	for _, upstream := range upstreams {
		var names []string
		if err := json.Unmarshal([]byte(upstream.ModelNames), &names); err == nil {
			for _, name := range names {
				if trimmed := strings.TrimSpace(name); trimmed != "" {
					unique[trimmed] = true
				}
			}
		}

		var mappings map[string]json.RawMessage
		if err := json.Unmarshal([]byte(upstream.ModelMappings), &mappings); err == nil {
			for key := range mappings {
				if trimmed := strings.TrimSpace(key); trimmed != "" {
					unique[trimmed] = true
				}
			}
		}
		// model_prefixes are intentionally ignored: a prefix cannot expand into
		// concrete ids.
	}

	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// OpenAIModelsListResponse renders ids in the OpenAI list shape.
func OpenAIModelsListResponse(ids []string) json.RawMessage {
	data := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		data = append(data, map[string]any{
			"id":       id,
			"object":   "model",
			"created":  0,
			"owned_by": "wildtoken",
		})
	}
	encoded, err := json.Marshal(map[string]any{"object": "list", "data": data})
	if err != nil {
		return json.RawMessage(`{"object":"list","data":[]}`)
	}
	return encoded
}

// resolveEnabledUpstreamForModels resolves a channel hint, refusing one the
// caller's group cannot reach so the filter cannot enumerate other groups.
func resolveEnabledUpstreamForModels(ctx context.Context, state *appstate.State,
	selector string, groupID int64) (models.UpstreamRow, error) {
	reachable := func(upstream models.UpstreamRow) (bool, error) {
		if upstream.Enabled != 1 {
			return false, nil
		}
		groupIDs, err := db.ListUpstreamGroupIDs(ctx, state.DB, upstream.ID)
		if err != nil {
			return false, err
		}
		for _, candidate := range groupIDs {
			if candidate == groupID {
				return true, nil
			}
		}
		return false, nil
	}

	if id, err := strconv.ParseInt(selector, 10, 64); err == nil {
		upstream, ok, err := db.GetUpstream(ctx, state.DB, id)
		if err != nil {
			return models.UpstreamRow{}, err
		}
		if ok {
			allowed, err := reachable(upstream)
			if err != nil {
				return models.UpstreamRow{}, err
			}
			if allowed {
				return upstream, nil
			}
		}
	}

	upstream, ok, err := db.GetUpstreamByName(ctx, state.DB, selector)
	if err != nil {
		return models.UpstreamRow{}, err
	}
	if ok {
		allowed, err := reachable(upstream)
		if err != nil {
			return models.UpstreamRow{}, err
		}
		if allowed {
			return upstream, nil
		}
	}

	// The message does not distinguish "does not exist" from "not in your
	// group", so the filter cannot be used to probe other groups.
	return models.UpstreamRow{}, apperr.NotFound("upstream not found or disabled: " + selector)
}

// ListModelsHandler serves GET /v1/models, aggregating the model list from the
// channels the caller's group can reach.
//
// An optional channel filter comes from X-WildToken-Upstream or ?upstream= (a
// name or an id). A filtered response skips the cache, and model_prefixes never
// expand into concrete ids.
func ListModelsHandler(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.DownstreamAuthFrom(r.Context())
		if !ok {
			writeProtocolError(w, http.StatusUnauthorized, r.URL.Path,
				"Incorrect API key provided", "invalid_api_key")
			return
		}

		if selector := upstreamSelector(r); selector != nil {
			upstream, err := resolveEnabledUpstreamForModels(r.Context(), state,
				*selector, auth.GroupID)
			if err != nil {
				apperr.WriteError(w, err)
				return
			}
			writeRawJSON(w, OpenAIModelsListResponse(filterAllowedModelIDs(
				AggregateModelIDs([]models.UpstreamRow{upstream}), auth.AllowedModels)))
			return
		}

		// The cache is per group, and tokens in one group can carry different
		// allowlists, so a restricted token bypasses it.
		if len(auth.AllowedModels) > 0 {
			upstreams, err := db.ListEnabledUpstreamsInGroup(r.Context(), state.DB, auth.GroupID)
			if err != nil {
				apperr.WriteError(w, err)
				return
			}
			writeRawJSON(w, OpenAIModelsListResponse(
				filterAllowedModelIDs(AggregateModelIDs(upstreams), auth.AllowedModels)))
			return
		}

		if cached := state.ModelsCache.Get(auth.GroupID); cached != nil {
			writeRawJSON(w, cached)
			return
		}

		upstreams, err := db.ListEnabledUpstreamsInGroup(r.Context(), state.DB, auth.GroupID)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		response := OpenAIModelsListResponse(AggregateModelIDs(upstreams))

		// Another concurrent miss may have already filled the cache.
		if cached := state.ModelsCache.Get(auth.GroupID); cached != nil {
			writeRawJSON(w, cached)
			return
		}
		state.ModelsCache.Set(auth.GroupID, response)
		writeRawJSON(w, response)
	}
}

func writeRawJSON(w http.ResponseWriter, body json.RawMessage) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}

func containsFold(list []string, name string) bool {
	for _, entry := range list {
		if strings.EqualFold(entry, name) {
			return true
		}
	}
	return false
}

// resolveGroupName reads a group's name for an error message, falling back to
// its id when the row is gone. Routing already decided; this only labels it.
func resolveGroupName(ctx context.Context, state *appstate.State, groupID int64) string {
	group, ok, err := db.GetGroup(ctx, state.DB, groupID)
	if err != nil || !ok {
		return "#" + strconv.FormatInt(groupID, 10)
	}
	return group.Name
}
