package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// debugProtocolPaths maps a protocol to the endpoint it is sent to.
var debugProtocolPaths = map[string]string{
	"responses":        "responses",
	"chat_completions": "chat/completions",
	"messages":         "messages",
	// Image generation has no reference client; it goes out with plain JSON
	// headers, which is what protocolHeaders gives an unknown protocol.
	"images": "images/generations",
}

// AdminDebugUpstream sends a hand-edited request through one channel and
// streams the answer back as it arrives.
//
// The reply is always an event stream, whether or not the upstream streams:
// the page then has one code path, and a non-streaming answer is simply one
// that arrives in a single chunk. Events, in order:
//
//	request   {url, headers, body}        what was sent, credentials redacted
//	response  {status_code, headers, ttfb_ms}
//	chunk     {text, elapsed_ms}          zero or more
//	done      {elapsed_ms}
//	error     {message, elapsed_ms}       instead of done, on transport failure
//
// Every timing is measured here, from the moment the upstream request starts,
// so the page's three numbers share one clock. Like the model test it is
// billed and logged.
func AdminDebugUpstream(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.DebugRequest
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

		overrides, err := parseExtraHeaders(row.ExtraHeaders)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := validateOverrides(overrides); err != nil {
			apperr.WriteError(w, err)
			return
		}

		flusher, canFlush := w.(http.Flusher)
		if !canFlush {
			apperr.WriteError(w, apperr.Internal("streaming is not supported"))
			return
		}

		model := strings.TrimSpace(input.Model)
		if model == "" {
			model = bodyModel(input.Body)
		}

		// Same query as the model test: the Claude Code CLI appends it on
		// every /v1/messages call.
		targetQuery := ""
		if input.Protocol == "messages" {
			targetQuery = "beta=true"
		}
		targetURL := buildProbeURL(row.BaseURL, debugProtocolPaths[input.Protocol], targetQuery)
		headers := buildChannelRequestHeaders(protocolHeaders(input.Protocol, model), row.APIKey, overrides)

		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("cache-control", "no-store")
		w.WriteHeader(http.StatusOK)

		send := func(event string, payload any) {
			encoded, err := json.Marshal(payload)
			if err != nil {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded)
			flusher.Flush()
		}

		send("request", map[string]any{
			"url": targetURL, "headers": redactHeaderPreview(headers), "body": input.Body,
		})

		var splitter runeSplitter
		startedAt := time.Now()
		var logModel *string
		if model != "" {
			logModel = &model
		}
		_, err = sendAndLogProbe(r.Context(), state, consoleProbe{
			clientType:   probeModelTest,
			method:       http.MethodPost,
			url:          targetURL,
			headers:      headers,
			body:         input.Body,
			upstreamID:   &row.ID,
			upstreamName: &row.Name,
			model:        logModel,
			onResponse: func(status int, headers map[string]string) {
				send("response", map[string]any{
					"status_code": status,
					"headers":     redactModelTestResponseHeaders(headers),
					"ttfb_ms":     time.Since(startedAt).Milliseconds(),
				})
			},
			onChunk: func(chunk []byte) {
				if text := splitter.push(chunk); text != "" {
					send("chunk", map[string]any{"text": text, "elapsed_ms": time.Since(startedAt).Milliseconds()})
				}
			},
		}, probeTimeout(row.TimeoutSeconds))
		if rest := splitter.flush(); rest != "" {
			send("chunk", map[string]any{"text": rest, "elapsed_ms": time.Since(startedAt).Milliseconds()})
		}
		if err != nil {
			send("error", map[string]any{"message": err.Error(), "elapsed_ms": time.Since(startedAt).Milliseconds()})
			return
		}
		send("done", map[string]any{"elapsed_ms": time.Since(startedAt).Milliseconds()})
	}
}

// bodyModel reads the model field of a request body, or "" when it has none.
func bodyModel(body json.RawMessage) string {
	var fields struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &fields); err != nil {
		return ""
	}
	return strings.TrimSpace(fields.Model)
}

// runeSplitter cuts a byte stream into strings without splitting a character.
//
// Reads end wherever the network does, often mid-way through a multi-byte
// character; encoding that half as JSON turns it into U+FFFD on both sides of
// the cut. The incomplete tail is held back for the next chunk.
type runeSplitter struct {
	pending []byte
}

func (s *runeSplitter) push(chunk []byte) string {
	data := append(s.pending, chunk...)

	// A UTF-8 character is at most 4 bytes, so only the last 3 can be an
	// unfinished one. Find the start of the last character and check it.
	cut := len(data)
	for back := 1; back <= 3 && back <= len(data); back++ {
		index := len(data) - back
		if utf8.RuneStart(data[index]) {
			if !utf8.FullRune(data[index:]) {
				cut = index
			}
			break
		}
	}

	s.pending = append([]byte(nil), data[cut:]...)
	return string(data[:cut])
}

// flush returns whatever is held back. Bytes that never completed a character
// go out as they are; there is nothing further to wait for.
func (s *runeSplitter) flush() string {
	rest := string(s.pending)
	s.pending = nil
	return rest
}
