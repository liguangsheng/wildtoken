// Package handlers implements the HTTP endpoints WildToken serves.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
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

// writeProxyError answers a failed proxied request in the caller's protocol, as
// every other refusal on this path is. A bare {"error": "..."} left an
// Anthropic SDK unable to read the failure at all.
func writeProxyError(w http.ResponseWriter, path string, err error) {
	var appErr *apperr.AppError
	if !errors.As(err, &appErr) {
		appErr = apperr.Internal(err.Error())
	}
	status, message := appErr.StatusAndMessage()
	writeProtocolError(w, status, path, message, "api_error")
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
	// requestID goes on every row this request writes, attempts included.
	requestID int64
}

func newAbortLogGuard(logWriter *proxy.LogWriter, active *proxy.ActiveRequest,
	method, path string) *abortLogGuard {
	status := int32(499)
	message := "client disconnected before proxy completed"
	// Random rather than counted, so ids stay distinct across restarts. Only
	// uniqueness matters: one collision in 2^63 would merge two attempt lists.
	requestID := rand.Int64N(1<<63-1) + 1
	return &abortLogGuard{
		logWriter: logWriter,
		active:    active,
		startedAt: time.Now(),
		requestID: requestID,
		entry: &proxy.LogEntry{
			Method:     method,
			Path:       path,
			StatusCode: &status,
			Error:      &message,
			RequestID:  requestID,
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
	if tokenID <= 0 {
		return
	}
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

// setKey names the key an attempt uses; zero for a channel without keys.
func (g *abortLogGuard) setKey(key models.UpstreamKey) {
	g.active.SetKey(key.ID, key.Name)
	if g.entry == nil {
		return
	}
	g.entry.UpstreamKeyID = key.ID
	g.entry.UpstreamKeyName = key.Name
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

// logAttempt records one failed attempt on a row of its own and stays armed:
// the request goes on to another channel, which logs how it ended. The row is
// marked retried because some later row always records the outcome.
func (g *abortLogGuard) logAttempt(upstream *models.UpstreamRow, key models.UpstreamKey,
	statusCode int32, message string) {
	if g.entry == nil {
		return
	}
	entry := *g.entry
	entry.Retried = true
	upstreamID, upstreamName := upstream.ID, upstream.Name
	entry.UpstreamID = &upstreamID
	entry.UpstreamName = &upstreamName
	entry.UpstreamKeyID, entry.UpstreamKeyName = key.ID, key.Name
	entry.StatusCode = &statusCode
	entry.Error = &message
	entry.DurationMs = g.elapsed()
	g.logWriter.Schedule(entry)
}

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
	return proxyHandler(state, nil)
}

// admin 只由已鉴权的调试入口提供，不接受请求头或请求体中的身份。
func proxyHandler(state *appstate.State, admin *middleware.DownstreamAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.DownstreamAuthFrom(r.Context())
		if admin != nil {
			auth, ok = *admin, true
		}
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

		if !models.ProxyEndpointAllowed(r.Method, path) {
			guard.logAndDisarm(http.StatusNotFound, "endpoint is not relayed")
			writeProtocolError(w, http.StatusNotFound, r.URL.Path,
				"this endpoint is not available through the gateway", "not_found_error")
			return
		}

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDownstreamBodyBytes))
		if err != nil {
			// A body that exceeded the cap is the caller's error; anything else
			// means the caller went away mid-upload.
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				guard.logAndDisarm(http.StatusRequestEntityTooLarge,
					"failed to read downstream request body: "+err.Error())
				writeProtocolError(w, http.StatusRequestEntityTooLarge, r.URL.Path,
					"request body exceeds 50 MiB", "request_too_large")
				return
			}
			guard.logAndDisarm(499,
				"client disconnected while reading downstream request body: "+err.Error())
			apperr.BadRequest("failed to read body: " + err.Error()).Write(w)
			return
		}

		model, err := proxy.RequestModel(r.Header, body)
		if err != nil {
			guard.logAndDisarm(http.StatusBadRequest, err.Error())
			writeProtocolError(w, http.StatusBadRequest, path, err.Error(), "invalid_request_error")
			return
		}
		route, err := loadResponseRoute(r, state, auth.TokenID, path, body)
		if err != nil {
			status := int32(http.StatusInternalServerError)
			var appErr *apperr.AppError
			if errors.As(err, &appErr) {
				code, _ := appErr.StatusAndMessage()
				status = int32(code)
			}
			guard.logAndDisarm(status, err.Error())
			writeProxyError(w, path, err)
			return
		}
		if route != nil && model == nil && route.RequestModel != "" {
			model = &route.RequestModel
		}
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

		if route != nil && len(auth.AllowedModels) > 0 &&
			!models.ModelAllowed(auth.AllowedModels, route.RequestModel) {
			message := modelNotAllowedMessage(&route.RequestModel)
			guard.logAndDisarm(http.StatusForbidden, message)
			writeProtocolError(w, http.StatusForbidden, path, message, "permission_error")
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
				writeProxyError(w, r.URL.Path, err)
				return
			}
		}

		if route != nil {
			selector, err = responseRouteSelector(route, directSelection, selector)
			if err != nil {
				guard.logAndDisarm(http.StatusNotFound, err.Error())
				writeProxyError(w, path, err)
				return
			}
			directSelection, err = proxy.SelectUpstream(r.Context(), state.DB, state.Routing,
				state.AutoWeight, policy, selector, model, auth.GroupID, nil)
			if err != nil || directSelection == nil || directSelection.Upstream.ID != route.UpstreamID {
				if err == nil {
					err = apperr.NotFound("response channel is no longer available")
				}
				guard.logAndDisarm(http.StatusNotFound, err.Error())
				writeProxyError(w, path, err)
				return
			}
		}

		client := &downstream{w: w}
		response, err := runProxyAttempts(r, state, proxyAttemptConfig{
			guard:           guard,
			downstream:      client,
			auth:            auth,
			groupName:       resolveGroupName(r.Context(), state, auth.GroupID),
			path:            path,
			query:           withoutQueryParam(r.URL.RawQuery, "upstream"),
			body:            body,
			model:           model,
			selector:        selector,
			directSelection: directSelection,
			responseRoute:   route,
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
			writeProxyError(w, r.URL.Path, err)
			return
		}
		if response == nil {
			// Routing found nothing; the reason was already written and logged.
			return
		}
		guard.disarm()

		if err := client.deliver(response); err != nil {
			if observer, ok := w.(interface{ recordStreamError(error) }); ok {
				observer.recordStreamError(err)
			}
		}
	}
}

type proxyAttemptConfig struct {
	guard *abortLogGuard
	// downstream is the client's side; a stream's headers go out through it
	// before the attempt is known to succeed.
	downstream *downstream
	auth       middleware.DownstreamAuth
	// groupName is resolved once for the error message, so the retry loop does
	// not query it per attempt.
	groupName       string
	path            string
	query           string // the caller's, minus this gateway's ?upstream= hint
	body            []byte
	model           *string
	selector        *string
	directSelection *proxy.Selection
	responseRoute   *models.ResponseRoute
	policy          proxy.AutoWeightPolicy
	runtimeSettings models.RuntimeSettings
}

// runProxyAttempts forwards the request, retrying a failure up to the
// configured limit. A nil response with a nil error means routing produced no
// attempt and the refusal has already been written and logged: a 429 when every
// candidate was rate limited, a 503 when there was no route at all.
func runProxyAttempts(r *http.Request, state *appstate.State,
	config proxyAttemptConfig) (*proxy.Response, error) {
	w := config.downstream.w
	maxRetries := int(config.runtimeSettings.MaxRetries)
	logBodyMaxBytes := int(config.runtimeSettings.LogBodyMaxBytes)

	var previousUpstreamID *int64
	// lastFailure is held until it is known whether another attempt replaces
	// it. A way out that does not return it ends on a row the guard writes,
	// so the held one was only an attempt.
	var lastFailure *attemptResult
	// streamFailure is the last stream that failed before content. Its headers
	// are out, so when nothing else answers it is what the client receives:
	// the stream as the channel sent it, error event and all.
	var streamFailure *attemptResult
	defer func() {
		for _, held := range []*attemptResult{lastFailure, streamFailure} {
			if held != nil {
				held.retried(state.LogWriter)
			}
		}
	}()
	// replay ends the request on streamFailure.
	replay := func() (*proxy.Response, error) {
		failure := streamFailure
		streamFailure = nil
		failure.concluded(state.LogWriter)
		config.guard.disarm()
		return failure.response, nil
	}

	// excluded collects the channels that stay out of routing for the rest of
	// this request, so re-selection falls over to the remaining candidates
	// instead of drawing one of them again: a channel whose rate limit refused
	// the request, one that rejected it with a 4xx, and one that would forward a
	// model the token may not use. anyRateLimited remembers the first kind,
	// which turns "nothing left" into a 429 rather than a 503.
	excluded := map[int64]bool{}
	anyRateLimited := false
	anyMisconfigured := false

	// rejected are the channels that answered this request with a 4xx that
	// may be its own fault. They are charged only if another channel then
	// serves it: then the refusal was theirs, not the request's.
	var rejected []models.UpstreamRow

	// refused are the keys that turned this request away as unauthorized; none
	// is tried for it again. cooling are the channels whose remaining keys all
	// sit out after refusals: they wait until the other channels are spent.
	// stay keeps the next attempt on the channel just tried, for another key.
	refused := map[int64]bool{}
	cooling := map[int64]bool{}
	lastResort := false
	var stay *proxy.Selection

	for attempt := 0; ; attempt++ {
		// Selection repeats until a channel's rate limit admits the request;
		// admission records the request, refusal excludes the channel. The loop
		// terminates because every refusal shrinks the candidate set.
		var selected *proxy.Selection
		var prepared *proxy.PreparedRequest
		// upstream is the selected channel signed in with key, the one this
		// attempt picked of its keys.
		var upstream models.UpstreamRow
		var key models.UpstreamKey
		stayed := false
		for {
			stayed = stay != nil
			if stayed {
				selected, stay = stay, nil
			} else {
				selected = config.directSelection
				if config.selector == nil {
					var err error
					selected, err = proxy.SelectUpstream(r.Context(), state.DB, state.Routing,
						state.AutoWeight, config.policy, nil, config.model, config.auth.GroupID,
						routingExclusions(excluded, cooling, lastResort))
					if err != nil {
						if streamFailure != nil {
							return replay()
						}
						config.guard.logAndDisarm(500, "upstream selection failed: "+err.Error())
						return nil, err
					}
				} else if selected != nil && excluded[selected.Upstream.ID] {
					// A direct selector has no other candidate behind it.
					selected = nil
				}
				if selected == nil && !lastResort && len(cooling) > 0 {
					// Only channels whose keys all sit out are left: use them after all.
					lastResort = true
					continue
				}
			}
			if selected == nil {
				break
			}

			upstream, key = selected.Upstream, models.UpstreamKey{}
			if config.responseRoute != nil {
				var available bool
				key, available = responseRouteKey(config.responseRoute, selected)
				if !available {
					config.guard.logAndDisarm(http.StatusNotFound, "response key is no longer available")
					writeProtocolError(w, http.StatusNotFound, config.path,
						"response key is no longer available", "not_found_error")
					return nil, nil
				}
				if key.ID != 0 {
					upstream.APIKey = &key.APIKey
				}
			} else if len(selected.Keys) > 0 {
				picked, benched, ok := state.Keys.Pick(selected.Upstream.ID, selected.Keys, refused)
				if !ok {
					// Every one of its keys has turned this request away.
					excluded[selected.Upstream.ID] = true
					continue
				}
				// A direct selector has nothing else to wait for.
				if benched && !stayed && !lastResort && config.selector == nil {
					cooling[selected.Upstream.ID] = true
					continue
				}
				key = picked
				upstream.APIKey = &key.APIKey
			}

			// A channel whose stored headers no longer build a request fails
			// every request it is given, so it is charged, logged and passed
			// over. Ending the request here refused it with healthy channels
			// left, and told the caller the channel's name.
			var err error
			downstreamHeaders := r.Header.Clone()
			// net/http stores Host separately from Header. Include the actual
			// downstream authority in the original-request snapshot.
			if r.Host != "" {
				downstreamHeaders.Set("host", r.Host)
			}
			prepared, err = proxy.PrepareRequestWithDownstreamTarget(downstreamHeaders,
				&upstream, r.Method, r.URL.RequestURI(), config.path, config.query,
				selected.ForwardModel, config.body, logBodyMaxBytes)
			if err != nil {
				state.AutoWeight.RecordFailure(selected.Upstream.ID,
					selected.Upstream.AutoWeightEnabled == 1, config.policy)
				config.guard.logAttempt(&selected.Upstream, key, 502, err.Error())
				excluded[selected.Upstream.ID] = true
				anyMisconfigured = true
				continue
			}
			if config.responseRoute != nil && config.responseRoute.CredentialDigest !=
				proxy.ResponseCredentialDigest(&upstream, prepared.ForwardHeaders) {
				config.guard.logAndDisarm(http.StatusConflict, "response account credentials have changed")
				writeProtocolError(w, http.StatusConflict, config.path,
					"response account credentials have changed", "invalid_request_error")
				return nil, nil
			}
			// Another key of the channel spends the admission it already gave.
			if stayed || proxy.UpstreamRateLimitAdmits(state.UpstreamRateLimiter, &selected.Upstream) {
				break
			}
			excluded[selected.Upstream.ID] = true
			anyRateLimited = true
		}

		if selected == nil {
			// Nothing else to try. A stream whose headers are out is the answer;
			// otherwise the last buffered failure is.
			if streamFailure != nil {
				return replay()
			}
			if failure := lastFailure; failure != nil {
				lastFailure = nil
				failure.concluded(state.LogWriter)
				return failure.response, failure.err
			}
			if anyRateLimited {
				// Routing had candidates, but every one of them refused: the
				// request is only deferred, not unroutable, so the answer is a
				// 429 rather than the no-route 503.
				config.guard.logAndDisarm(429, "all candidate channels are rate limited")
				writeUpstreamRateLimitRejection(w, config.path)
				return nil, nil
			}
			if anyMisconfigured {
				// Each channel's failure is on a row of its own, marked retried;
				// this row records how the request ended.
				config.guard.logAndDisarm(http.StatusBadGateway, "no usable upstream channel")
				writeProtocolError(w, http.StatusBadGateway, config.path,
					"no usable upstream channel", "api_error")
				return nil, nil
			}
			reason := noRouteReason(config.selector, config.model, config.groupName)
			config.guard.logAndDisarm(503, reason)
			writeProtocolError(w, http.StatusServiceUnavailable,
				config.path, reason, "upstream_not_configured")
			return nil, nil
		}

		// Retrying the same channel immediately would usually hit the same
		// condition, so the configured pause applies first. Another of its keys
		// is not the same condition, and goes at once.
		if attempt > 0 && !stayed && previousUpstreamID != nil &&
			*previousUpstreamID == selected.Upstream.ID &&
			config.runtimeSettings.SameUpstreamRetryIntervalMs > 0 {
			select {
			case <-r.Context().Done():
				if streamFailure != nil {
					return replay()
				}
				// Logged here because no attempt was made to log it: this is
				// the one error path out of this function that ProxyRequest
				// never saw.
				config.guard.logAndDisarm(499, "client disconnected during retry backoff")
				return nil, apperr.Upstream("client disconnected during retry backoff")
			case <-time.After(time.Duration(config.runtimeSettings.SameUpstreamRetryIntervalMs) *
				time.Millisecond):
			}
		}

		// Once a new attempt has a route, the previous failure was only an
		// attempt, and its row is written as one.
		if lastFailure != nil && lastFailure != streamFailure {
			lastFailure.retried(state.LogWriter)
		}
		lastFailure = nil

		config.guard.setUpstream(selected.Upstream.ID, selected.Upstream.Name, selected.ForwardModel)
		config.guard.setKey(key)
		config.guard.setPreparedRequest(prepared)

		// An attempt that gets no answer hands its row back rather than
		// writing it: whether it ends the request is not known yet.
		var held *proxy.LogEntry
		response, err := proxy.ProxyRequest(r.Context(), state.ProxyDeps(), config.policy,
			&upstream, proxy.RequestContext{
				DownstreamTokenID:   config.auth.TokenID,
				DownstreamTokenName: config.auth.TokenName,
				// The success path builds its own LogEntry from this context, so
				// the guard's copy never reaches it.
				ClientIP:         clientIP(r),
				ClientType:       config.auth.ClientType,
				RequestModel:     config.model,
				ForwardModel:     selected.ForwardModel,
				Method:           r.Method,
				Path:             config.path,
				LogBodyMaxBytes:  logBodyMaxBytes,
				UpstreamKeyID:    key.ID,
				UpstreamKeyName:  key.Name,
				RequestID:        config.guard.requestID,
				RememberResponse: rememberResponseRoute(r, state, config, upstream, key, prepared),
				HoldFailure:      func(entry proxy.LogEntry) { held = &entry },
			}, prepared)

		failed := err != nil || response.Status < 200 || response.Status >= 300

		// A stream is held back until it shows content, so an error before
		// that is only a failed attempt and another channel can still answer.
		// Its headers go out now, as they always did. The last attempt has
		// nothing to fall back on and is not held.
		streamFailed := false
		if !failed && response.Streaming() && holdsStream(config.path) &&
			attempt < maxRetries {
			config.downstream.sendHeader(response)
			if !response.Prime(config.downstream.ping) {
				failed, streamFailed = true, true
			}
		}
		if !failed {
			state.Keys.Clear(key.ID)
			for _, upstream := range rejected {
				state.AutoWeight.RecordFailure(upstream.ID, upstream.AutoWeightEnabled == 1,
					config.policy)
			}
			return response, err
		}
		current := &attemptResult{response: response, err: err, held: held}

		// A key the upstream turned away sits out, and the request tries the
		// channel's next key before another channel, which may be fine. A 429
		// bars the key while it sits out; a 401 or 403 for the rest of this
		// request too.
		if key.ID != 0 && err == nil && proxy.KeyRefused(response.Status) {
			state.Keys.Bench(key.ID, proxy.RetryAfter(response.Headers))
			if response.Status != http.StatusTooManyRequests {
				refused[key.ID] = true
			}
			if config.responseRoute == nil && state.Keys.HasFresh(selected.Keys, refused) {
				stay = selected
			}
		}

		// A client that has gone is not owed another attempt. Retrying spent
		// another channel's rate-limit allowance and wrote another log row for
		// a request nobody was waiting for, so one disconnect could leave a
		// handful of 499s behind it.
		if attempt >= maxRetries || r.Context().Err() != nil {
			if streamFailure != nil && !streamFailed {
				// The client holds a stream's headers; this answer cannot follow.
				current.retried(state.LogWriter)
				return replay()
			}
			current.concluded(state.LogWriter)
			return response, err
		}

		switch {
		case streamFailed:
			// Out for the rest of this request. The stream's failure was
			// charged where it showed, if it was the channel's.
			excluded[selected.Upstream.ID] = true
			if streamFailure != nil {
				streamFailure.retried(state.LogWriter)
			}
			streamFailure = current
		case stay == nil && err == nil && !proxy.IsChannelFault(response.Status):
			// Asked again, the channel would refuse the request the same way —
			// unless another of its keys is to be asked.
			excluded[selected.Upstream.ID] = true
			rejected = append(rejected, selected.Upstream)
		}

		upstreamID := selected.Upstream.ID
		previousUpstreamID = &upstreamID
		// A failed response is already in memory, its connection released by
		// ProxyRequest. It is kept whole: if no channel is left to try, it is
		// what the caller receives, explanation included.
		lastFailure = current
	}
}

// routingExclusions are the channels selection passes over: those out for this
// request and, while others remain, those whose keys all sit out.
func routingExclusions(excluded, cooling map[int64]bool, lastResort bool) map[int64]bool {
	if lastResort || len(cooling) == 0 {
		return excluded
	}
	merged := make(map[int64]bool, len(excluded)+len(cooling))
	for id := range excluded {
		merged[id] = true
	}
	for id := range cooling {
		merged[id] = true
	}
	return merged
}

// withoutQueryParam drops one parameter from a raw query and leaves the rest
// exactly as the caller wrote them.
func withoutQueryParam(rawQuery, name string) string {
	if rawQuery == "" {
		return ""
	}
	parts := strings.Split(rawQuery, "&")
	kept := parts[:0]
	for _, part := range parts {
		key, _, _ := strings.Cut(part, "=")
		if unescaped, err := url.QueryUnescape(key); err == nil && unescaped == name {
			continue
		}
		kept = append(kept, part)
	}
	return strings.Join(kept, "&")
}

// attemptResult is a failed attempt, held until it is known whether another
// attempt replaces it.
type attemptResult struct {
	response *proxy.Response
	err      error
	// held is the row of an attempt that got no answer. One that did answer
	// carries its row in response, written when the body closes.
	held *proxy.LogEntry
	// settled makes the first verdict the only one.
	settled bool
}

// retried writes the attempt as one another attempt replaced.
func (a *attemptResult) retried(writer *proxy.LogWriter) {
	if a.settled {
		return
	}
	a.settled = true
	if a.held != nil {
		a.held.Retried = true
		writer.Schedule(*a.held)
	}
	if a.response != nil {
		a.response.Retry()
	}
}

// concluded writes the attempt as how the request ended. A response's row is
// written by whoever delivers and closes it.
func (a *attemptResult) concluded(writer *proxy.LogWriter) {
	if a.settled {
		return
	}
	a.settled = true
	if a.held != nil {
		writer.Schedule(*a.held)
	}
}

// downstream is the client's side of a proxied answer.
//
// A stream's headers go out when it arrives, as before, though its body is held
// back until it shows content: an attempt that fails before then is retried on
// another channel. The headers can be sent only once, so a later attempt
// continues the stream they opened.
type downstream struct {
	w          http.ResponseWriter
	headerSent bool
	lastPing   time.Time
}

// sendHeader writes a response's status and headers, the first time only.
func (d *downstream) sendHeader(response *proxy.Response) {
	if d.headerSent {
		return
	}
	d.headerSent = true

	header := d.w.Header()
	for name, value := range response.Headers {
		if containsFold(hopByHopResponseHeaders, name) {
			continue
		}
		header.Set(name, value)
	}
	d.w.WriteHeader(response.Status)
	d.flush()
}

// ping keeps a held-back stream's connection busy, at most once a second. An
// SSE comment line is skipped by every client's parser: ": waiting\n\n".
func (d *downstream) ping() {
	if time.Since(d.lastPing) < time.Second {
		return
	}
	d.lastPing = time.Now()
	if _, err := io.WriteString(d.w, ": waiting for the upstream\n\n"); err == nil {
		d.flush()
	}
}

func (d *downstream) flush() {
	if flusher, ok := d.w.(http.Flusher); ok {
		flusher.Flush()
	}
}

// deliver copies an upstream response downstream, streaming it as it arrives
// so an SSE body is not buffered.
func (d *downstream) deliver(response *proxy.Response) error {
	defer response.Body.Close()
	d.sendHeader(response)

	buffer := make([]byte, 32*1024)
	for {
		read, err := response.Body.Read(buffer)
		if read > 0 {
			if _, writeErr := d.w.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
			d.flush()
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// holdsStream reports whether a stream on this path waits for content before
// reaching the client. Text generation does; an image stream is mostly image
// data, which holding back would only delay.
func holdsStream(path string) bool {
	switch path {
	case "chat/completions", "completions", "responses", "messages":
		return true
	}
	return false
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
		// An archived channel does not route, so it lists no models either.
		if upstream.Enabled != 1 || upstream.Archived != 0 {
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

		revision := state.ModelsCache.Revision()
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
		state.ModelsCache.Set(auth.GroupID, response, revision)
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
