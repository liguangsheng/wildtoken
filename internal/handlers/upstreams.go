package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// Client types for requests the console makes on an operator's behalf.
//
// These share the column with real downstream clients rather than getting a
// column of their own: the log page's client filter then picks them up for
// free. A null downstream_token_id would also mark them, but that column is
// cleared when a token is deleted (ON DELETE SET NULL), so it cannot be trusted
// as the marker.
//
// The log page's filter is a hardcoded list; tests/console-probe-logging.test.mjs
// holds it to this set.
const (
	probeModelTest   = "model-test"
	probeChannelTest = "channel-test"
	probeModelList   = "model-list"
	probeBalance     = "balance"
)

// buildProbeURL mirrors the upstream URL rules used by proxied traffic.
func buildProbeURL(baseURL, path, query string) string {
	base := strings.TrimRight(baseURL, "/")
	suffix := strings.TrimLeft(path, "/")
	target := base + "/v1/" + suffix
	if strings.HasSuffix(base, "/v1") {
		target = base + "/" + suffix
	}
	if query != "" {
		target += "?" + query
	}
	return target
}

// applyRuntimeHealth fills the live health fields of a listed upstream.
func applyRuntimeHealth(state *appstate.State, policy proxy.AutoWeightPolicy, item *models.UpstreamOut) {
	health := state.AutoWeight.Snapshot(item.ID, item.Weight, item.AutoWeightEnabled, policy)
	item.RuntimeHealthScore = health.Score
	item.EffectiveWeight = health.EffectiveWeight
	item.HealthRecoveryRemainingSeconds = health.RecoveryRemainingSeconds
}

// parseExtraHeaders decodes a channel's stored header override map.
func parseExtraHeaders(stored string) (map[string]string, error) {
	overrides := map[string]string{}
	if err := json.Unmarshal([]byte(stored), &overrides); err != nil {
		return nil, apperr.BadRequest("channel Header override JSON is invalid: " + err.Error())
	}
	return overrides, nil
}

// parseJSONArray decodes a stored list column, naming it in the failure so the
// operator learns which one is damaged rather than that "something" is.
func parseJSONArray(stored, column string) ([]string, error) {
	values := []string{}
	if err := json.Unmarshal([]byte(stored), &values); err != nil {
		return nil, apperr.BadRequest("channel " + column + " JSON is invalid: " + err.Error())
	}
	return values, nil
}

// parseJSONMap decodes a stored mapping column.
func parseJSONMap(stored, column string) (map[string]string, error) {
	values := map[string]string{}
	if err := json.Unmarshal([]byte(stored), &values); err != nil {
		return nil, apperr.BadRequest("channel " + column + " JSON is invalid: " + err.Error())
	}
	return values, nil
}

func validateOverrides(overrides map[string]string) error {
	if err := proxy.ValidateHeaderOverrides(overrides); err != nil {
		return apperr.BadRequest(err.Error())
	}
	// Refused when saved rather than in ValidateHeaderOverrides, which also runs
	// per request: a channel already storing one keeps working, the override
	// ignored.
	for name := range overrides {
		if strings.EqualFold(name, "accept-encoding") {
			return apperr.BadRequest("Header accept-encoding cannot be overridden: " +
				"the gateway reads responses uncompressed")
		}
	}
	return nil
}

// buildChannelRequestHeaders composes headers for channel-related admin
// requests using the same precedence as normal proxy traffic: the generated
// channel credential first, configured overrides last.
func buildChannelRequestHeaders(headers map[string]string, apiKey *string,
	overrides map[string]string) map[string]string {
	if headers == nil {
		headers = map[string]string{}
	}
	if apiKey != nil && *apiKey != "" {
		headers["authorization"] = "Bearer " + *apiKey
	}
	// Admin-side probes have no downstream request context, so client header
	// placeholders are skipped while static overrides still apply.
	proxy.ApplyHeaderOverrides(headers, overrides, nil)
	return headers
}

// buildProtocolRequestHeaders composes an inference probe's headers the way the
// proxy would send them for the same protocol.
//
// The Messages API takes the key as x-api-key. Sending it as a Bearer token made
// a native Anthropic channel fail its test while serving traffic fine.
func buildProtocolRequestHeaders(protocol, model string, apiKey *string,
	overrides map[string]string) map[string]string {
	headers := protocolHeaders(protocol, model)
	if protocol != "messages" {
		return buildChannelRequestHeaders(headers, apiKey, overrides)
	}
	if apiKey != nil && *apiKey != "" {
		headers["x-api-key"] = *apiKey
	}
	proxy.ApplyHeaderOverrides(headers, overrides, nil)
	return headers
}

func randomProbeID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "wildtoken-probe"
	}
	return base64.RawURLEncoding.EncodeToString(bytes)
}

// codexModelTestHeaders reproduces what the Codex TUI sends, so a channel that
// gates on client fingerprinting behaves the same under test as in use.
func codexModelTestHeaders() map[string]string {
	requestID := randomProbeID()
	turnMetadata, err := json.Marshal(map[string]string{
		"installation_id": requestID, "session_id": requestID, "thread_id": requestID,
		"turn_id": requestID, "window_id": requestID,
	})
	if err != nil {
		turnMetadata = []byte("{}")
	}
	return map[string]string{
		"accept":                "text/event-stream",
		"accept-encoding":       "identity",
		"content-type":          "application/json",
		"originator":            "codex-tui",
		"session-id":            requestID,
		"thread-id":             requestID,
		"user-agent":            "codex-tui/0.144.1 (Fedora 44.0.0; x86_64) xterm-256color (codex-tui; 0.144.1)",
		"x-client-request-id":   requestID,
		"x-codex-beta-features": "memories,remote_compaction_v2",
		"x-codex-turn-metadata": string(turnMetadata),
		"x-codex-window-id":     requestID + ":0",
	}
}

// claudeCLIModelTestHeaders reproduces what the Claude Code CLI sends.
//
// A model name carrying the [1m] suffix is a relay-side alias for the 1M context
// window, which providers only honor alongside the matching beta header — the
// CLI itself sends it via ANTHROPIC_BETAS, so the test does the same.
func claudeCLIModelTestHeaders(model string) map[string]string {
	betas := "claude-code-20250219,interleaved-thinking-2025-05-14," +
		"mid-conversation-system-2026-04-07,effort-2025-11-24"
	if strings.Contains(strings.ToLower(model), "[1m]") {
		betas += ",context-1m-2025-08-07"
	}
	return map[string]string{
		"accept":          "application/json",
		"accept-encoding": "identity",
		"anthropic-beta":  betas,
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-version":                         "2023-06-01",
		"content-type":                              "application/json",
		"user-agent":                                "claude-cli/2.1.216 (external, cli)",
		"x-app":                                     "cli",
		"x-claude-code-session-id":                  randomProbeID(),
		"x-stainless-arch":                          "x64",
		"x-stainless-lang":                          "js",
		"x-stainless-os":                            "Linux",
		"x-stainless-package-version":               "0.94.0",
		"x-stainless-retry-count":                   "0",
		"x-stainless-runtime":                       "node",
		"x-stainless-runtime-version":               "v26.3.0",
		"x-stainless-timeout":                       "600",
	}
}

// protocolHeaders are the headers a protocol's reference client sends, so a
// channel that keys off client headers behaves as it would in practice.
func protocolHeaders(protocol, model string) map[string]string {
	switch protocol {
	case "responses":
		return codexModelTestHeaders()
	case "messages":
		return claudeCLIModelTestHeaders(model)
	default:
		return map[string]string{"content-type": "application/json"}
	}
}

// stripContext1MSuffix removes a trailing [1m] alias from a model id. The
// beta-header decision in claudeCLIModelTestHeaders still reads the model as
// typed, so the alias keeps its effect while the id goes upstream clean.
func stripContext1MSuffix(model string) string {
	if suffix := strings.ToLower(model[max(0, len(model)-4):]); suffix == "[1m]" {
		return model[:len(model)-4]
	}
	return model
}

// extractModelIDs reads model ids from the several shapes providers return.
func extractModelIDs(payload json.RawMessage) []string {
	var source []json.RawMessage

	var object map[string]json.RawMessage
	if err := json.Unmarshal(payload, &object); err == nil {
		for _, key := range []string{"data", "models"} {
			if raw, present := object[key]; present {
				if json.Unmarshal(raw, &source) == nil {
					break
				}
			}
		}
	} else if err := json.Unmarshal(payload, &source); err != nil {
		return nil
	}

	seen := map[string]bool{}
	ids := []string{}
	for _, item := range source {
		var id string
		if err := json.Unmarshal(item, &id); err != nil {
			var entry struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(item, &entry); err != nil {
				continue
			}
			id = entry.ID
		}
		id = strings.TrimSpace(id)
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids
}

// consoleProbe is one outbound request the console makes for an operator.
type consoleProbe struct {
	clientType string
	method     string
	url        string
	headers    map[string]string
	body       json.RawMessage
	// upstreamID and upstreamName are absent for the channel form's preview,
	// which probes a typed-in base URL with no channel row behind it.
	upstreamID   *int64
	upstreamName *string
	// keyID and keyName name the channel key the probe signs in with, for the
	// log row: 0 and "" when there is none to name.
	keyID   int64
	keyName string
	// model is carried only by the model test.
	model *string
	// onResponse and onChunk, when set, see the response as it arrives: the
	// debug page forwards a streamed answer chunk by chunk instead of waiting
	// for the whole body. Neither changes what is logged.
	onResponse func(status int, headers map[string]string)
	onChunk    func(chunk []byte)
}

type probeOutcome struct {
	status int
	// headers are unredacted, for callers that build their own preview. The copy
	// written to the log is redacted by the response snapshot.
	headers map[string]string
	body    string
}

// probeLogPath is the path component of a probe URL, for the log's path column.
//
// It falls back to the whole URL when that does not parse: a log row with an
// odd path beats one with none.
func probeLogPath(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Path == "" {
		return rawURL
	}
	return parsed.Path
}

// sendAndLogProbe performs a console probe and records it in the request log.
//
// Transport failures are logged too, with no status code and the error
// attached. Leaving those out would drop exactly the case most worth having a
// record of: the channel that could not be reached at all.
func sendAndLogProbe(ctx context.Context, state *appstate.State, probe consoleProbe,
	timeout time.Duration) (probeOutcome, error) {
	logBodyMaxBytes := int(state.Runtime.Get().LogBodyMaxBytes)
	requestSnapshot := proxy.SnapshotRequest(probe.method, probe.url, probe.headers,
		probe.body, logBodyMaxBytes)

	newEntry := func() proxy.LogEntry {
		return proxy.LogEntry{
			Method:            probe.method,
			Path:              probeLogPath(probe.url),
			ClientType:        &probe.clientType,
			UpstreamID:        probe.upstreamID,
			UpstreamName:      probe.upstreamName,
			UpstreamKeyID:     probe.keyID,
			UpstreamKeyName:   probe.keyName,
			Model:             probe.model,
			RequestModel:      probe.model,
			UpstreamModel:     probe.model,
			DownstreamRequest: requestSnapshot,
			UpstreamRequest:   requestSnapshot,
		}
	}

	// The bound is on silence, as it is for proxied traffic: every chunk
	// restarts it. A deadline over the whole exchange cut the debug page's
	// streams off for running long, where the proxy would have let them finish.
	requestCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	idle := time.AfterFunc(timeout, func() {
		cancel(fmt.Errorf("upstream sent nothing for %s", timeout))
	})
	defer idle.Stop()

	var bodyReader io.Reader
	if probe.body != nil {
		bodyReader = bytes.NewReader(probe.body)
	}
	request, err := http.NewRequestWithContext(requestCtx, probe.method, probe.url, bodyReader)
	if err != nil {
		return probeOutcome{}, err
	}
	for name, value := range probe.headers {
		request.Header.Set(name, value)
	}

	startedAt := time.Now()
	response, err := state.HTTPClient.Do(request)
	if err != nil {
		err = probeError(ctx, requestCtx, err)
		entry := newEntry()
		entry.DurationMs = durationMs(startedAt)
		message := err.Error()
		entry.Error = &message
		state.LogWriter.Schedule(entry)
		return probeOutcome{}, err
	}
	defer response.Body.Close()

	status := response.StatusCode
	statusCode := int32(status)
	headers := map[string]string{}
	for name, values := range response.Header {
		if len(values) > 0 {
			headers[strings.ToLower(name)] = values[0]
		}
	}

	if probe.onResponse != nil {
		probe.onResponse(status, headers)
	}

	reader := progressReader{Reader: response.Body, onRead: func() { idle.Reset(timeout) }}
	var body []byte
	if probe.onChunk != nil {
		body, err = readProbeChunks(reader, probe.onChunk)
	} else {
		body, err = io.ReadAll(io.LimitReader(reader, maxProbeResponseBytes))
	}
	if err != nil {
		err = probeError(ctx, requestCtx, err)
		entry := newEntry()
		entry.StatusCode = &statusCode
		entry.DurationMs = durationMs(startedAt)
		message := err.Error()
		entry.Error = &message
		state.LogWriter.Schedule(entry)
		return probeOutcome{}, err
	}

	// Only an inference probe can have token usage. Running the extractor over a
	// model list or a billing payload could read unrelated numbers as usage, and
	// these rows count toward the dashboard's token totals.
	var usage proxy.TokenUsage
	if probe.model != nil {
		usage = proxy.ExtractUsage(body, headers["content-type"])
	}
	// Generated images go to files; the log keeps their paths. The model test
	// and the debug page are where images get tried out, so this path needs it
	// as much as the proxy does.
	responseSnapshot := proxy.SnapshotResponse(status, headers, state.Images.Rewrite(body), logBodyMaxBytes)

	entry := newEntry()
	entry.StatusCode = &statusCode
	entry.DurationMs = durationMs(startedAt)
	entry.PromptTokens = usage.PromptTokens
	entry.CompletionTokens = usage.CompletionTokens
	entry.TotalTokens = usage.TotalTokens
	entry.PromptCachedTokens = usage.PromptCachedTokens
	entry.CacheCreationTokens = usage.CacheCreationTokens
	entry.CompletionReasoningTokens = usage.CompletionReasoningTokens
	entry.UpstreamResponse = responseSnapshot
	entry.DownstreamResponse = responseSnapshot
	state.LogWriter.Schedule(entry)

	return probeOutcome{status: status, headers: headers, body: string(body)}, nil
}

// progressReader reports every read that returned data.
type progressReader struct {
	io.Reader
	onRead func()
}

func (r progressReader) Read(buffer []byte) (int, error) {
	count, err := r.Reader.Read(buffer)
	if count > 0 {
		r.onRead()
	}
	return count, err
}

// probeError names the idle timeout when it is what ended a probe. The client
// only reports the cancellation, which reads like the operator gave up.
func probeError(parent, request context.Context, err error) error {
	if parent.Err() != nil {
		return err
	}
	if cause := context.Cause(request); cause != nil && !errors.Is(cause, context.Canceled) {
		return cause
	}
	return err
}

// readProbeChunks hands every chunk to onChunk as it arrives and keeps the
// first maxProbeResponseBytes for the log. Past that the caller still gets the
// rest: cutting a debug stream short to protect a log snapshot would hide the
// very answer being debugged.
func readProbeChunks(body io.Reader, onChunk func([]byte)) ([]byte, error) {
	var kept []byte
	buffer := make([]byte, 32<<10)
	for {
		count, err := body.Read(buffer)
		if count > 0 {
			chunk := buffer[:count]
			onChunk(chunk)
			if room := maxProbeResponseBytes - len(kept); room > 0 {
				kept = append(kept, chunk[:min(room, count)]...)
			}
		}
		if err == io.EOF {
			return kept, nil
		}
		if err != nil {
			return kept, err
		}
	}
}

func durationMs(startedAt time.Time) *int32 {
	measured := int32(time.Since(startedAt).Milliseconds())
	return &measured
}

// probeTimeout bounds a probe by a channel's timeout, never dropping below one
// second.
//
// Zero means "the service default", as it does to the proxy. Reading it as the
// one-second floor gave an imported channel's tests a second to answer in while
// its traffic had five minutes.
func probeTimeout(state *appstate.State, seconds float64) time.Duration {
	if seconds <= 0 {
		seconds = state.EffectiveUpstreamTimeoutSeconds()
	}
	return time.Duration(max(seconds, 1.0) * float64(time.Second))
}

// billingUsageRange is the window the usage probe asks a provider for.
//
// The intent is "everything", which the endpoint expresses as a date range. It
// was written as a literal pair ending in 2099, which reads as a date someone
// chose rather than as the absence of one, and would quietly start excluding
// usage if this outlived the guess. Anchoring the end to today says what it
// means and cannot expire.
func billingUsageRange() string {
	const billingEpoch = "2020-01-01"
	return "start_date=" + billingEpoch +
		"&end_date=" + time.Now().AddDate(0, 0, 1).Format(time.DateOnly)
}

// redactHeaderPreview hides credential values in a preview shown to the console.
func redactHeaderPreview(headers map[string]string) map[string]string {
	preview := make(map[string]string, len(headers))
	for name, value := range headers {
		if proxy.IsSensitiveHeaderName(name) {
			preview[name] = "[redacted]"
			continue
		}
		preview[name] = value
	}
	return preview
}

// maxProbeResponseBytes bounds what a probe reads back from an upstream.
//
// A probe answers a click in the console, and everything done with the body
// afterwards is a preview measured in hundreds of characters. Reading it without
// a limit let one click pull an entire upstream response into memory. The
// preview endpoint takes a base URL straight from the form, so triggering it did
// not even require a stored channel.
const maxProbeResponseBytes = 8 << 20

// truncateRunes bounds a preview string without splitting a rune.
//
// It walks the string rather than converting it, because a rune slice of the
// whole value is a second copy of it — four times its size — paid for before
// discovering the value is too long to show.
func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	count := 0
	for index := range value {
		count++
		if count > limit {
			return value[:index]
		}
	}
	return value
}

// AdminListUpstreams returns every channel with its live health.
func AdminListUpstreams(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		items, err := db.ListUpstreams(r.Context(), state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		policy := state.AutoWeightPolicy()
		for i := range items {
			applyRuntimeHealth(state, policy, &items[i])
		}
		apperr.WriteJSON(w, http.StatusOK, items)
	}
}

// AdminGetUpstream returns one channel, including its API key.
func AdminGetUpstream(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		row, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		health := state.AutoWeight.Snapshot(row.ID, row.Weight,
			row.AutoWeightEnabled == 1, state.AutoWeightPolicy())

		// A parse failure is reported rather than swallowed. The console fills
		// the edit form from this response, so decoding a damaged column to an
		// empty list showed the channel as having no models — and saving that
		// form wrote the emptiness back, destroying the routing configuration
		// the operator came to look at.
		modelNames, err := parseJSONArray(row.ModelNames, "model_names")
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		modelPrefixes, err := parseJSONArray(row.ModelPrefixes, "model_prefixes")
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		modelMappings, err := parseJSONMap(row.ModelMappings, "model_mappings")
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		effortMappings, err := parseJSONMap(row.EffortMappings, "effort_mappings")
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		extraHeaders, err := parseExtraHeaders(row.ExtraHeaders)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := validateOverrides(extraHeaders); err != nil {
			apperr.WriteError(w, err)
			return
		}

		// The console fills the edit form from this response, so an absent
		// membership list reads as "no groups" and the form falls back to
		// default -- silently dropping the channel's real groups on save.
		groupIDs, err := db.ListUpstreamGroupIDs(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		keys, err := upstreamKeysOut(r.Context(), state, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		apperr.WriteJSON(w, http.StatusOK, models.UpstreamDetailOut{
			GroupIDs:                       groupIDs,
			ID:                             row.ID,
			Name:                           row.Name,
			BaseURL:                        row.BaseURL,
			Keys:                           keys,
			APIKeySet:                      row.KeyCount > 0,
			ModelNames:                     modelNames,
			ModelPrefixes:                  modelPrefixes,
			ModelMappings:                  modelMappings,
			EffortMappings:                 effortMappings,
			Priority:                       row.Priority,
			Weight:                         row.Weight,
			AutoWeightEnabled:              row.AutoWeightEnabled == 1,
			Enabled:                        row.Enabled == 1,
			ExtraHeaders:                   extraHeaders,
			TimeoutSeconds:                 row.TimeoutSeconds,
			RateLimit:                      row.RateLimit,
			CreatedAt:                      row.CreatedAt,
			UpdatedAt:                      row.UpdatedAt,
			RuntimeHealthScore:             health.Score,
			EffectiveWeight:                health.EffectiveWeight,
			HealthRecoveryRemainingSeconds: health.RecoveryRemainingSeconds,
			Archived:                       row.Archived == 1,
			EnabledBeforeArchive:           db.EnabledBeforeArchive(&row),
		})
	}
}

// AdminCreateUpstream adds a channel.
func AdminCreateUpstream(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		input := models.DefaultUpstreamIn()
		if err := decodeJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		input.Normalize()
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}
		if err := validateOverrides(input.ExtraHeaders); err != nil {
			apperr.WriteError(w, err)
			return
		}

		created, err := db.CreateUpstream(r.Context(), state.DB, &input)
		if err != nil {
			if isUniqueViolation(err) {
				apperr.WriteError(w, apperr.BadRequest("upstream name already exists"))
				return
			}
			apperr.WriteError(w, err)
			return
		}

		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()
		state.AutoWeight.Reset(created.ID)
		applyRuntimeHealth(state, state.AutoWeightPolicy(), &created)
		apperr.WriteJSON(w, http.StatusCreated, created)
	}
}

// AdminUpdateUpstream replaces a channel's configuration.
func AdminUpdateUpstream(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		// Read once, decoded twice: the keys it names, then their values.
		var body json.RawMessage
		if err := decodeJSON(w, r, &body); err != nil {
			apperr.WriteError(w, err)
			return
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body, &fields); err != nil {
			apperr.WriteError(w, apperr.BadRequest("invalid request body: "+err.Error()))
			return
		}
		// A PUT replaces the channel, so a field it leaves out has no value to
		// keep; it is refused rather than filled with a default.
		if missing := models.MissingUpstreamFields(fields); len(missing) > 0 {
			apperr.WriteError(w, apperr.BadRequest("missing fields: "+strings.Join(missing, ", ")))
			return
		}
		input := models.UpstreamUpdate{UpstreamIn: models.DefaultUpstreamIn()}
		if err := json.Unmarshal(body, &input); err != nil {
			apperr.WriteError(w, apperr.BadRequest("invalid request body: "+err.Error()))
			return
		}
		input.Normalize()
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}
		if err := validateOverrides(input.ExtraHeaders); err != nil {
			apperr.WriteError(w, err)
			return
		}

		existing, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		updated, err := db.UpdateUpstream(r.Context(), state.DB, id, &input)
		if err != nil {
			// A rename onto another channel's name, answered as creation does.
			if isUniqueViolation(err) {
				apperr.WriteError(w, apperr.BadRequest("upstream name already exists"))
				return
			}
			apperr.WriteError(w, err)
			return
		}

		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()
		// Toggling automatic weighting, or re-enabling a channel, clears the
		// health it accumulated while it was configured differently.
		enabledInput := int64(0)
		if input.AutoWeightEnabled {
			enabledInput = 1
		}
		if existing.AutoWeightEnabled != enabledInput || (existing.Enabled == 0 && input.Enabled) {
			state.AutoWeight.Reset(id)
		}
		applyRuntimeHealth(state, state.AutoWeightPolicy(), &updated)
		apperr.WriteJSON(w, http.StatusOK, updated)
	}
}

// AdminSetUpstreamEnabled turns a channel on or off.
func AdminSetUpstreamEnabled(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.UpstreamEnabledIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		enabled, err := input.Value()
		if err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		existing, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		} else if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}
		// Written through, the switch produced a channel both archived and
		// enabled, which unarchiving then overwrote with the state from before.
		if existing.Archived == 1 {
			apperr.WriteError(w, apperr.BadRequest("an archived channel cannot be switched; restore it first"))
			return
		}

		updated, err := db.SetUpstreamEnabled(r.Context(), state.DB, id, enabled)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()
		// Re-enabling gives a channel a clean slate rather than the health it
		// had when the operator turned it off.
		if enabled {
			state.AutoWeight.Reset(id)
		}
		applyRuntimeHealth(state, state.AutoWeightPolicy(), &updated)
		apperr.WriteJSON(w, http.StatusOK, updated)
	}
}

// AdminSetUpstreamArchived parks a channel out of routing, or restores it.
//
// It shares SetUpstreamEnabled's invalidation work because it changes who can
// route. The health reset is unconditional: a channel parked for a week should
// not come back carrying the failures it accumulated before it went away.
func AdminSetUpstreamArchived(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.UpstreamArchivedIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		archived, err := input.Value()
		if err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		if _, found, err := db.GetUpstream(r.Context(), state.DB, id); err != nil {
			apperr.WriteError(w, err)
			return
		} else if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		updated, err := db.SetUpstreamArchived(r.Context(), state.DB, id, archived)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()
		state.AutoWeight.Reset(id)
		applyRuntimeHealth(state, state.AutoWeightPolicy(), &updated)
		apperr.WriteJSON(w, http.StatusOK, updated)
	}
}

// AdminSetUpstreamPriority changes a channel's routing priority.
func AdminSetUpstreamPriority(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.UpstreamPriorityIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		priority, err := input.Value()
		if err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		if _, found, err := db.GetUpstream(r.Context(), state.DB, id); err != nil {
			apperr.WriteError(w, err)
			return
		} else if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		updated, err := db.SetUpstreamPriority(r.Context(), state.DB, id, priority)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()
		applyRuntimeHealth(state, state.AutoWeightPolicy(), &updated)
		apperr.WriteJSON(w, http.StatusOK, updated)
	}
}

// AdminDeleteUpstream removes a channel.
func AdminDeleteUpstream(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		deleted, err := db.DeleteUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !deleted {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()
		state.AutoWeight.Reset(id)
		w.WriteHeader(http.StatusNoContent)
	}
}

// AdminTestUpstream probes a channel with a plain GET.
func AdminTestUpstream(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		input := models.DefaultTestRequest()
		if err := decodeJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}
		if input.Path == "" {
			input.Path = "/v1/models"
		}

		row, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		targetPath := strings.TrimPrefix(input.Path, "/v1/")
		if targetPath == input.Path {
			targetPath = strings.TrimPrefix(input.Path, "/")
		}
		targetURL := buildProbeURL(row.BaseURL, targetPath, "")

		overrides, err := parseExtraHeaders(row.ExtraHeaders)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := validateOverrides(overrides); err != nil {
			apperr.WriteError(w, err)
			return
		}
		credential, err := probeKey(r.Context(), state.DB, &row, input.KeyID)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		headers := buildChannelRequestHeaders(nil, credential.apiKey, overrides)

		outcome, err := sendAndLogProbe(r.Context(), state, consoleProbe{
			clientType:   probeChannelTest,
			method:       http.MethodGet,
			url:          targetURL,
			headers:      headers,
			upstreamID:   &row.ID,
			upstreamName: &row.Name,
			keyID:        credential.keyID,
			keyName:      credential.keyName,
		}, probeTimeout(state, row.TimeoutSeconds))
		if err != nil {
			apperr.WriteJSON(w, http.StatusOK, map[string]any{
				"ok": false, "status_code": nil, "message": err.Error(),
			})
			return
		}

		apperr.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":           outcome.status < 400,
			"status_code":  outcome.status,
			"content_type": optionalHeader(outcome.headers, "content-type"),
			"preview":      truncateRunes(outcome.body, 1000),
		})
	}
}

func optionalHeader(headers map[string]string, name string) any {
	if value, present := headers[name]; present {
		return value
	}
	return nil
}

// AdminTestUpstreamModel sends one inference request through a channel.
func AdminTestUpstreamModel(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.ModelTestRequest
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		row, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		prompt, err := resolveModelTestPrompt(r.Context(), state, &input)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		targetPath, payload, err := modelTestRequest(input.Protocol,
			strings.TrimSpace(input.Model), prompt)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		// The Claude Code CLI appends this query parameter on every
		// /v1/messages call.
		targetQuery := ""
		if input.Protocol == "messages" {
			targetQuery = "beta=true"
		}
		targetURL := buildProbeURL(row.BaseURL, targetPath, targetQuery)

		overrides, err := parseExtraHeaders(row.ExtraHeaders)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := validateOverrides(overrides); err != nil {
			apperr.WriteError(w, err)
			return
		}
		credential, err := probeKey(r.Context(), state.DB, &row, input.KeyID)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		headers := buildProtocolRequestHeaders(input.Protocol, strings.TrimSpace(input.Model),
			credential.apiKey, overrides)
		headersPreview := redactHeaderPreview(headers)

		model := strings.TrimSpace(input.Model)
		outcome, err := sendAndLogProbe(r.Context(), state, consoleProbe{
			clientType:   probeModelTest,
			method:       http.MethodPost,
			url:          targetURL,
			headers:      headers,
			body:         payload,
			upstreamID:   &row.ID,
			upstreamName: &row.Name,
			keyID:        credential.keyID,
			keyName:      credential.keyName,
			model:        &model,
		}, probeTimeout(state, row.TimeoutSeconds))
		if err != nil {
			apperr.WriteJSON(w, http.StatusOK, map[string]any{
				"ok": false, "status_code": nil, "message": err.Error(),
			})
			return
		}

		apperr.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":               outcome.status < 400,
			"status_code":      outcome.status,
			"content_type":     optionalHeader(outcome.headers, "content-type"),
			"response_headers": redactModelTestResponseHeaders(outcome.headers),
			"prompt":           prompt,
			"request": map[string]any{
				"url": targetURL, "headers": headersPreview, "body": json.RawMessage(payload),
			},
			"reply":   extractModelTestReply([]byte(outcome.body)),
			"preview": truncateRunes(outcome.body, 10000),
		})
	}
}

func resolveModelTestPrompt(ctx context.Context, state *appstate.State,
	input *models.ModelTestRequest) (string, error) {
	if prompt := strings.TrimSpace(input.Prompt); prompt != "" {
		return prompt, nil
	}
	templates, err := db.ListModelTestPromptTemplates(ctx, state.DB)
	if err != nil {
		return "", err
	}
	for _, template := range templates {
		if template.ID == input.PromptTemplateID {
			return template.Prompt, nil
		}
	}
	return "", apperr.NotFound("model test prompt template not found")
}

// modelTestRequest builds the path and payload for one template kind.
func modelTestRequest(requestKind, model, prompt string) (string, json.RawMessage, error) {
	var path string
	var payload any
	switch requestKind {
	case "responses":
		path = "responses"
		payload = map[string]any{
			"model": model, "input": prompt, "max_output_tokens": 1000,
		}
	case "chat_completions":
		path = "chat/completions"
		payload = map[string]any{
			"model":      model,
			"messages":   []map[string]string{{"role": "user", "content": prompt}},
			"max_tokens": 1000,
		}
	case "messages":
		// The [1m] suffix is the CLI's alias for the 1M context window, resolved
		// client-side into the context-1m beta header; providers list only the
		// plain id, so the suffix must not reach the model field.
		path = "messages"
		payload = map[string]any{
			"model":      stripContext1MSuffix(model),
			"max_tokens": 1000,
			"messages":   []map[string]string{{"role": "user", "content": prompt}},
		}
	default:
		return "", nil, apperr.BadRequest("unsupported template request kind")
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", nil, apperr.JSON(err)
	}
	return path, encoded, nil
}

func redactModelTestResponseHeaders(headers map[string]string) map[string]string {
	redacted := make(map[string]string, len(headers))
	for name, value := range headers {
		switch name {
		case "set-cookie", "authorization", "x-api-key":
			redacted[name] = "[redacted]"
		default:
			redacted[name] = value
		}
	}
	return redacted
}

// extractModelTestReply pulls the assistant's text out of a provider response.
func extractModelTestReply(body []byte) any {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil
	}

	// OpenAI Chat Completions.
	if choices, ok := payload["choices"].([]any); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]any); ok {
			if message, ok := choice["message"].(map[string]any); ok {
				if content, ok := message["content"].(string); ok {
					return content
				}
			}
		}
	}

	// Anthropic Messages.
	if content, ok := payload["content"].([]any); ok {
		var parts []string
		for _, item := range content {
			block, ok := item.(map[string]any)
			if !ok || block["type"] != "text" {
				continue
			}
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}

	// OpenAI Responses.
	if output, ok := payload["output"].([]any); ok {
		var parts []string
		for _, item := range output {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			content, ok := entry["content"].([]any)
			if !ok {
				continue
			}
			for _, block := range content {
				fields, ok := block.(map[string]any)
				if !ok {
					continue
				}
				if text, ok := fields["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}

	return nil
}

// fetchModelsForTarget lists the models a base URL advertises.
func fetchModelsForTarget(ctx context.Context, state *appstate.State, upstreamID *int64,
	upstreamName *string, baseURL string, credential probeCredential, extraHeaders map[string]string,
	timeoutSeconds float64) (models.ModelListOut, error) {
	if err := validateOverrides(extraHeaders); err != nil {
		return models.ModelListOut{}, err
	}

	targetURL := buildProbeURL(baseURL, "models", "")
	headers := buildChannelRequestHeaders(nil, credential.apiKey, extraHeaders)

	outcome, err := sendAndLogProbe(ctx, state, consoleProbe{
		clientType:   probeModelList,
		method:       http.MethodGet,
		url:          targetURL,
		headers:      headers,
		upstreamID:   upstreamID,
		upstreamName: upstreamName,
		keyID:        credential.keyID,
		keyName:      credential.keyName,
	}, probeTimeout(state, timeoutSeconds))
	if err != nil {
		return models.ModelListOut{}, apperr.Upstream("upstream request failed: " + err.Error())
	}

	if outcome.status < 200 || outcome.status >= 300 {
		return models.ModelListOut{}, apperr.Upstream(fmt.Sprintf(
			"upstream returned HTTP %d: %s", outcome.status, truncateRunes(outcome.body, 300)))
	}

	if !json.Valid([]byte(outcome.body)) {
		return models.ModelListOut{}, apperr.Upstream("upstream did not return JSON")
	}
	ids := extractModelIDs(json.RawMessage(outcome.body))
	if len(ids) == 0 {
		return models.ModelListOut{}, apperr.Upstream(
			"upstream response did not contain model ids")
	}
	return models.ModelListOut{Models: ids}, nil
}

// AdminFetchUpstreamModels lists the models a saved channel advertises.
func AdminFetchUpstreamModels(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		row, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}
		extra, err := parseExtraHeaders(row.ExtraHeaders)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		credential, err := probeKey(r.Context(), state.DB, &row, 0)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		list, err := fetchModelsForTarget(r.Context(), state, &row.ID, &row.Name,
			row.BaseURL, credential, extra, row.TimeoutSeconds)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, list)
	}
}

// AdminFetchModelsPreview lists models for a base URL the operator typed in.
func AdminFetchModelsPreview(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input models.ModelFetchIn
		if err := decodeJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}

		// The preview dials whatever the form holds, so the URL is checked here
		// too rather than only on the path that saves a channel.
		baseURL, err := models.ValidateBaseURL(input.BaseURL)
		if err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		extra := input.ExtraHeaders
		if extra == nil {
			extra = map[string]string{}
		}
		if err := validateOverrides(extra); err != nil {
			apperr.WriteError(w, err)
			return
		}

		timeout := state.EffectiveUpstreamTimeoutSeconds()
		if input.TimeoutSeconds != nil {
			// Bounded as a saved channel's is: a huge value overflows the
			// Duration and times the probe out at once.
			if seconds := *input.TimeoutSeconds; seconds < 0 || seconds > models.UpstreamMaxTimeoutSeconds {
				apperr.WriteError(w, apperr.BadRequest("timeout_seconds must be between 0 and 3600"))
				return
			}
			timeout = *input.TimeoutSeconds
		}

		// A blank key on a saved channel's form means one of its stored keys,
		// which the form holds only by name.
		apiKey := input.APIKey
		if (apiKey == nil || strings.TrimSpace(*apiKey) == "") && input.UpstreamID != 0 {
			row, found, err := db.GetUpstream(r.Context(), state.DB, input.UpstreamID)
			if err != nil {
				apperr.WriteError(w, err)
				return
			}
			if !found {
				apperr.WriteError(w, apperr.NotFound("upstream not found"))
				return
			}
			credential, err := probeKey(r.Context(), state.DB, &row, input.KeyID)
			if err != nil {
				apperr.WriteError(w, err)
				return
			}
			apiKey = credential.apiKey
		}

		// The channel form's preview probes a typed-in base URL, so there is no
		// channel row to attribute the log row to, nor a key.
		list, err := fetchModelsForTarget(r.Context(), state, nil, nil,
			baseURL, probeCredential{apiKey: apiKey}, extra, timeout)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, list)
	}
}

// balanceProbeLimit bounds how many of a channel's keys a balance check reads
// at once.
const balanceProbeLimit = 4

// balanceReader reads one key's balance into the shape the console renders:
// "ok", then the amounts or a "message". probe arrives signed and attributed;
// the reader picks its URLs.
type balanceReader func(ctx context.Context, state *appstate.State, baseURL string,
	probe consoleProbe, timeout time.Duration) map[string]any

// serveBalances reads a channel's balance once per enabled key, in key order.
// A key that fails leaves the others' results standing, e.g.
//
//	{"keys": [{"key_id": 3, "key_name": "a", "ok": true, "remaining_usd": 4.2},
//	          {"key_id": 5, "key_name": "", "ok": false, "message": "渠道返回 HTTP 401"}]}
//
// A channel without keys gives one result, key_id 0.
func serveBalances(state *appstate.State, read balanceReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		row, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}

		extra, err := parseExtraHeaders(row.ExtraHeaders)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := validateOverrides(extra); err != nil {
			apperr.WriteError(w, err)
			return
		}
		credentials, err := balanceCredentials(r.Context(), state.DB, &row)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		// Side by side, a few at a time: one after another, a channel of slow
		// keys would hold the dialog for the sum of their timeouts.
		timeout := probeTimeout(state, row.TimeoutSeconds)
		results := make([]map[string]any, len(credentials))
		slots := make(chan struct{}, balanceProbeLimit)
		var group sync.WaitGroup
		for i, credential := range credentials {
			group.Go(func() {
				slots <- struct{}{}
				defer func() { <-slots }()

				result := read(r.Context(), state, row.BaseURL, consoleProbe{
					clientType:   probeBalance,
					method:       http.MethodGet,
					headers:      buildChannelRequestHeaders(nil, credential.apiKey, extra),
					upstreamID:   &row.ID,
					upstreamName: &row.Name,
					keyID:        credential.keyID,
					keyName:      credential.keyName,
				}, timeout)
				result["key_id"] = credential.keyID
				result["key_name"] = credential.keyName
				results[i] = result
			})
		}
		group.Wait()

		apperr.WriteJSON(w, http.StatusOK, map[string]any{"keys": results})
	}
}

// AdminFetchUpstreamBalance reads a new-api style billing endpoint.
func AdminFetchUpstreamBalance(state *appstate.State) http.HandlerFunc {
	return serveBalances(state, readNewAPIBalance)
}

// readNewAPIBalance reads one key's new-api billing: the subscription for the
// limit, the usage for what is spent.
func readNewAPIBalance(ctx context.Context, state *appstate.State, baseURL string,
	probe consoleProbe, timeout time.Duration) map[string]any {
	probe.url = buildProbeURL(baseURL, "dashboard/billing/subscription", "")
	subscription, err := sendAndLogProbe(ctx, state, probe, timeout)
	if err != nil {
		return map[string]any{"ok": false, "message": "请求失败: " + err.Error()}
	}
	if subscription.status != http.StatusOK {
		return map[string]any{
			"ok":      false,
			"message": fmt.Sprintf("渠道返回 HTTP %d", subscription.status),
		}
	}

	var subscriptionPayload map[string]any
	if err := json.Unmarshal([]byte(subscription.body), &subscriptionPayload); err != nil {
		return map[string]any{"ok": false, "message": "渠道未返回 JSON"}
	}

	// The usage endpoint is best-effort: a channel that only reports a
	// remaining balance is still useful.
	var usedUSD *float64
	probe.url = buildProbeURL(baseURL, "dashboard/billing/usage", billingUsageRange())
	usage, err := sendAndLogProbe(ctx, state, probe, timeout)
	if err == nil && usage.status == http.StatusOK {
		var usagePayload map[string]any
		if json.Unmarshal([]byte(usage.body), &usagePayload) == nil {
			if total, ok := usagePayload["total_usage"].(float64); ok {
				// new-api reports usage in cents.
				converted := total / 100.0
				usedUSD = &converted
			}
		}
	}

	var totalUSD *float64
	for _, key := range []string{"hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"} {
		if value, ok := subscriptionPayload[key].(float64); ok {
			totalUSD = &value
			break
		}
	}

	var remainingUSD *float64
	if totalUSD != nil && usedUSD != nil {
		remaining := *totalUSD - *usedUSD
		remainingUSD = &remaining
	} else {
		for _, key := range []string{"total_available", "remain_quota", "remaining", "balance"} {
			if value, ok := subscriptionPayload[key].(float64); ok {
				remainingUSD = &value
				break
			}
		}
	}

	if totalUSD == nil && remainingUSD == nil {
		return map[string]any{"ok": false, "message": "无法从响应中识别余额字段"}
	}
	return map[string]any{
		"ok":            true,
		"provider":      "new-api",
		"total_usd":     totalUSD,
		"used_usd":      usedUSD,
		"remaining_usd": remainingUSD,
	}
}

// AdminFetchUpstreamSub2APIBalance reads a sub2api style usage endpoint.
func AdminFetchUpstreamSub2APIBalance(state *appstate.State) http.HandlerFunc {
	return serveBalances(state, readSub2APIBalance)
}

// readSub2APIBalance reads one key's sub2api usage, which carries its balance.
func readSub2APIBalance(ctx context.Context, state *appstate.State, baseURL string,
	probe consoleProbe, timeout time.Duration) map[string]any {
	probe.url = buildProbeURL(baseURL, "usage", "")
	outcome, err := sendAndLogProbe(ctx, state, probe, timeout)
	if err != nil {
		return map[string]any{
			"ok": false, "provider": "sub2api", "message": "请求失败: " + err.Error(),
		}
	}

	if outcome.status < 200 || outcome.status >= 300 {
		message := fmt.Sprintf("渠道返回 HTTP %d", outcome.status)
		if preview := truncateRunes(outcome.body, 160); preview != "" {
			message += ": " + preview
		}
		return map[string]any{"ok": false, "provider": "sub2api", "message": message}
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(outcome.body), &payload); err != nil {
		return map[string]any{"ok": false, "provider": "sub2api", "message": "渠道未返回 JSON"}
	}

	parsed, ok := parseSub2APIBalancePayload(payload)
	if !ok {
		return map[string]any{
			"ok": false, "provider": "sub2api",
			"message": "无法从 sub2api 响应中识别余额字段",
		}
	}
	return parsed
}

// jsonNumberAt reads the first pointer that holds a number, accepting a numeric
// string too, because providers disagree on the encoding.
func jsonNumberAt(payload map[string]any, pointers [][]string) *float64 {
	for _, pointer := range pointers {
		value := valueAtPath(payload, pointer)
		switch typed := value.(type) {
		case float64:
			return &typed
		case string:
			if parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil {
				return &parsed
			}
		}
	}
	return nil
}

func jsonStringAt(payload map[string]any, pointers [][]string) *string {
	for _, pointer := range pointers {
		if text, ok := valueAtPath(payload, pointer).(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return &trimmed
			}
		}
	}
	return nil
}

func valueAtPath(payload map[string]any, path []string) any {
	var current any = payload
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

func parseSub2APIBalancePayload(payload map[string]any) (map[string]any, bool) {
	remainingUSD := jsonNumberAt(payload, [][]string{
		{"remaining"}, {"balance"}, {"quota", "remaining"}, {"quota", "balance"},
	})
	usedUSD := jsonNumberAt(payload, [][]string{
		{"usage", "total", "actual_cost"}, {"usage", "total", "cost"},
		{"total_actual_cost"}, {"total_cost"}, {"used"}, {"usage"},
	})
	totalUSD := jsonNumberAt(payload, [][]string{
		{"total"}, {"quota", "total"}, {"limit"},
	})

	if remainingUSD == nil && usedUSD == nil && totalUSD == nil {
		return nil, false
	}

	unit := "USD"
	if parsed := jsonStringAt(payload, [][]string{{"unit"}, {"quota", "unit"}}); parsed != nil {
		unit = *parsed
	}

	var isValid any
	for _, key := range []string{"isValid", "is_active"} {
		if value, ok := payload[key].(bool); ok {
			isValid = value
			break
		}
	}

	return map[string]any{
		"ok":            true,
		"provider":      "sub2api",
		"total_usd":     totalUSD,
		"used_usd":      usedUSD,
		"remaining_usd": remainingUSD,
		"unit":          unit,
		"plan_name": jsonStringAt(payload, [][]string{
			{"planName"}, {"plan_name"}, {"plan"},
		}),
		"is_valid": isValid,
		"mode":     jsonStringAt(payload, [][]string{{"mode"}}),
	}, true
}

// AdminExportUpstreams exports channels as a JSON document.
func AdminExportUpstreams(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req models.ExportUpstreamsRequest
		if err := decodeJSON(w, r, &req); err != nil {
			apperr.WriteError(w, err)
			return
		}

		ctx := r.Context()
		rows, err := db.ListUpstreams(ctx, state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		// Filter by IDs if provided
		filtered := rows
		if len(req.IDs) > 0 {
			idSet := make(map[int64]bool)
			for _, id := range req.IDs {
				idSet[id] = true
			}
			filtered = []models.UpstreamOut{}
			for _, row := range rows {
				if idSet[row.ID] {
					filtered = append(filtered, row)
				}
			}
		}

		groups, err := db.ListGroups(ctx, state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		groupNames := make(map[int64]string, len(groups))
		for _, group := range groups {
			groupNames[group.ID] = group.Name
		}

		// Build export items
		channels := make([]models.ChannelExportItem, 0, len(filtered))
		for _, out := range filtered {
			timeout := out.TimeoutSeconds
			archived := out.Archived
			names := make([]string, 0, len(out.GroupIDs))
			for _, id := range out.GroupIDs {
				if name, ok := groupNames[id]; ok {
					names = append(names, name)
				}
			}
			item := models.ChannelExportItem{
				Name:              out.Name,
				BaseURL:           out.BaseURL,
				ModelNames:        out.ModelNames,
				ModelPrefixes:     out.ModelPrefixes,
				ModelMappings:     out.ModelMappings,
				EffortMappings:    out.EffortMappings,
				Priority:          out.Priority,
				Weight:            out.Weight,
				AutoWeightEnabled: out.AutoWeightEnabled,
				Enabled:           out.Enabled,
				ExtraHeaders:      out.ExtraHeaders,
				TimeoutSeconds:    &timeout,
				RateLimit:         out.RateLimit,
				GroupIDs:          out.GroupIDs,
				GroupNames:        names,
				Archived:          &archived,

				EnabledBeforeArchive: out.EnabledBeforeArchive,
			}
			// Include API key if requested and present
			if req.IncludeAPIKeys {
				keys, err := db.ListUpstreamKeyValues(ctx, state.DB, out.ID)
				if err != nil {
					apperr.WriteError(w, err)
					return
				}
				for _, key := range keys {
					item.Keys = append(item.Keys, models.ChannelExportKey{
						Name: key.Name, APIKey: key.APIKey, Enabled: key.Enabled,
					})
				}
			} else {
				// A key moved into a header is still a key.
				item.ExtraHeaders = withoutSensitiveHeaders(out.ExtraHeaders)
			}
			channels = append(channels, item)
		}

		resp := models.ExportUpstreamsResponse{
			Kind:       "wildtoken.channels",
			Version:    1,
			ExportedAt: time.Now().UTC().Format(time.RFC3339),
			Channels:   channels,
		}
		apperr.WriteJSON(w, http.StatusOK, resp)
	}
}

// withoutSensitiveHeaders drops the overrides that carry credentials.
func withoutSensitiveHeaders(headers map[string]string) map[string]string {
	kept := make(map[string]string, len(headers))
	for name, value := range headers {
		if !proxy.IsSensitiveHeaderName(name) {
			kept[name] = value
		}
	}
	return kept
}

// validateGroupNames judges each name as creating the group would.
func validateGroupNames(names []string) error {
	for _, name := range names {
		group := models.GroupIn{Name: name}
		if err := group.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// keepSensitiveHeaders adds a channel's stored credential headers that an
// imported map does not name. A name the import does carry wins.
func keepSensitiveHeaders(stored string, imported map[string]string) map[string]string {
	existing := map[string]string{}
	if err := json.Unmarshal([]byte(stored), &existing); err != nil {
		return imported
	}

	merged := make(map[string]string, len(imported)+len(existing))
	named := make(map[string]bool, len(imported))
	for name, value := range imported {
		merged[name] = value
		named[strings.ToLower(name)] = true
	}
	for name, value := range existing {
		if proxy.IsSensitiveHeaderName(name) && !named[strings.ToLower(name)] {
			merged[name] = value
		}
	}
	return merged
}

// importedKeys turns a document's keys into a key list, nil when it carries
// none: then its older api_key, if any, is the one key, and an overwrite
// keeps the keys the channel has.
func importedKeys(keys []models.ChannelExportKey) *[]models.UpstreamKeyIn {
	if len(keys) == 0 {
		return nil
	}
	listed := make([]models.UpstreamKeyIn, 0, len(keys))
	for _, key := range keys {
		enabled := key.Enabled
		listed = append(listed, models.UpstreamKeyIn{Name: key.Name, APIKey: key.APIKey, Enabled: &enabled})
	}
	return &listed
}

// AdminImportUpstreams imports channels from a JSON document.
func AdminImportUpstreams(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req models.ImportUpstreamsRequest
		if err := decodeJSON(w, r, &req); err != nil {
			apperr.WriteError(w, err)
			return
		}

		if req.Mode != "skip" && req.Mode != "overwrite" {
			apperr.WriteError(w, apperr.BadRequest("mode must be 'skip' or 'overwrite'"))
			return
		}

		ctx := r.Context()
		result := models.ImportUpstreamsResponse{
			Items: make([]models.ImportResultItem, 0, len(req.Channels)),
		}

		for _, item := range req.Channels {
			// Convert to UpstreamIn
			input := models.UpstreamIn{
				Name:              item.Name,
				BaseURL:           item.BaseURL,
				Keys:              importedKeys(item.Keys),
				APIKey:            item.APIKey,
				ModelNames:        item.ModelNames,
				ModelPrefixes:     item.ModelPrefixes,
				ModelMappings:     item.ModelMappings,
				EffortMappings:    item.EffortMappings,
				Priority:          item.Priority,
				Weight:            item.Weight,
				AutoWeightEnabled: item.AutoWeightEnabled,
				Enabled:           item.Enabled,
				ExtraHeaders:      item.ExtraHeaders,
				TimeoutSeconds:    item.TimeoutSeconds,
				RateLimit:         item.RateLimit,
				GroupIDs:          item.GroupIDs,
				Archived:          item.Archived,
			}
			// Archived in the same transaction as the write, the channel
			// remembers this as what unarchiving restores.
			if item.Archived != nil && *item.Archived && item.EnabledBeforeArchive != nil {
				input.Enabled = *item.EnabledBeforeArchive
			}
			// A document may still spell a collection as null; stored as such,
			// the console cannot render the channel.
			input.Normalize()

			// Validate
			if err := input.Validate(); err != nil {
				msg := err.Error()
				result.Items = append(result.Items, models.ImportResultItem{
					Name:    item.Name,
					Action:  "failed",
					Message: &msg,
				})
				result.Failed++
				continue
			}

			if err := validateOverrides(input.ExtraHeaders); err != nil {
				msg := err.Error()
				result.Items = append(result.Items, models.ImportResultItem{
					Name:    item.Name,
					Action:  "failed",
					Message: &msg,
				})
				result.Failed++
				continue
			}

			// Checked with the channel, before a missing group is created for it.
			if err := validateGroupNames(item.GroupNames); err != nil {
				msg := err.Error()
				result.Items = append(result.Items, models.ImportResultItem{
					Name:    item.Name,
					Action:  "failed",
					Message: &msg,
				})
				result.Failed++
				continue
			}

			// Check if exists. By the trimmed name Validate left in input, which
			// is the one stored: " foo " missed an existing "foo" and then
			// collided with it on insert.
			existing, found, err := db.GetUpstreamByName(ctx, state.DB, input.Name)
			if err != nil {
				msg := "database error: " + err.Error()
				result.Items = append(result.Items, models.ImportResultItem{
					Name:    item.Name,
					Action:  "failed",
					Message: &msg,
				})
				result.Failed++
				continue
			}

			if found && req.Mode == "skip" {
				result.Items = append(result.Items, models.ImportResultItem{
					Name:   item.Name,
					Action: "skipped",
				})
				result.Skipped++
				continue
			}

			// Names over ids: the ids number the groups where the document was
			// made. A group missing here is created, rather than the channel
			// landing in another group that happens to hold the id.
			if len(item.GroupNames) > 0 {
				ids, err := db.EnsureGroups(ctx, state.DB, item.GroupNames)
				if err != nil {
					msg := "group lookup failed: " + err.Error()
					result.Items = append(result.Items, models.ImportResultItem{
						Name:    item.Name,
						Action:  "failed",
						Message: &msg,
					})
					result.Failed++
					continue
				}
				input.GroupIDs = ids
			}

			if found {
				// A document naming no group keeps the channel's, as one without
				// archived keeps its archive. Read as an empty selection, it moved
				// the channel to the default group alone.
				if item.GroupIDs == nil && len(item.GroupNames) == 0 {
					ids, err := db.ListUpstreamGroupIDs(ctx, state.DB, existing.ID)
					if err != nil {
						msg := "group lookup failed: " + err.Error()
						result.Items = append(result.Items, models.ImportResultItem{
							Name:    item.Name,
							Action:  "failed",
							Message: &msg,
						})
						result.Failed++
						continue
					}
					input.GroupIDs = ids
				}

				// Overwrite. Credential headers the document leaves out stay, as
				// the API key does: an export without keys omits both.
				input.ExtraHeaders = keepSensitiveHeaders(existing.ExtraHeaders, input.ExtraHeaders)
				update := models.UpstreamUpdate{
					UpstreamIn:  input,
					ClearAPIKey: false, // Keep existing key if import has none
				}
				_, err := db.UpdateUpstream(ctx, state.DB, existing.ID, &update)
				if err != nil {
					msg := "update failed: " + err.Error()
					result.Items = append(result.Items, models.ImportResultItem{
						Name:    item.Name,
						Action:  "failed",
						Message: &msg,
					})
					result.Failed++
					continue
				}

				state.AutoWeight.Reset(existing.ID)
				result.Items = append(result.Items, models.ImportResultItem{
					Name:   item.Name,
					Action: "updated",
				})
				result.Updated++
			} else {
				// Create new
				_, err := db.CreateUpstream(ctx, state.DB, &input)
				if err != nil {
					msg := "create failed: " + err.Error()
					result.Items = append(result.Items, models.ImportResultItem{
						Name:    item.Name,
						Action:  "failed",
						Message: &msg,
					})
					result.Failed++
					continue
				}

				result.Items = append(result.Items, models.ImportResultItem{
					Name:   item.Name,
					Action: "created",
				})
				result.Created++
			}
		}

		// Invalidate caches after all changes
		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()

		apperr.WriteJSON(w, http.StatusOK, result)
	}
}
