package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// AdminDebugRoute 复用正常路由，但不借用下游令牌或计入其额度。
func AdminDebugRoute(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			models.DebugRequest
			GroupID *int64 `json:"group_id"`
		}
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}
		groupID := models.DefaultGroupID
		if input.GroupID != nil {
			groupID = *input.GroupID
		}
		if groupID <= 0 || bodyModel(input.Body) == "" {
			apperr.WriteError(w, apperr.BadRequest("group_id and body.model are required"))
			return
		}
		if _, found, err := db.GetGroup(r.Context(), state.DB, groupID); err != nil {
			apperr.WriteError(w, err)
			return
		} else if !found {
			apperr.WriteError(w, apperr.NotFound("group not found"))
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			apperr.WriteError(w, apperr.Internal("streaming is not supported"))
			return
		}

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		path := "/v1/" + debugProtocolPaths[input.Protocol]
		query := ""
		if input.Protocol == "messages" {
			query = "beta=true"
		}
		model := strings.TrimSpace(input.Model)
		if model == "" {
			model = bodyModel(input.Body)
		}
		request := r.Clone(ctx)
		request.Method = http.MethodPost
		request.URL = &url.URL{Path: path, RawQuery: query}
		request.RequestURI = request.URL.RequestURI()
		request.Body = http.NoBody
		request.GetBody = nil
		request.ContentLength = int64(len(input.Body))
		request.Header = make(http.Header)
		headers := protocolHeaders(input.Protocol, model)
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		// 重新构造头部：管理员令牌、Cookie 和前端头部都不进入转发链路。
		request.Body = io.NopCloser(bytes.NewReader(input.Body))
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("cache-control", "no-store")
		w.WriteHeader(http.StatusOK)
		stream := &debugRouteStream{writer: w, flusher: flusher, header: make(http.Header), started: time.Now(), ctx: ctx, cancel: cancel}
		stream.event("request", map[string]any{
			"url": request.URL.RequestURI(), "headers": redactHeaderPreview(headers), "body": input.Body,
		})
		proxyHandler(state, &middleware.DownstreamAuth{GroupID: groupID, ClientType: probeModelTest}).ServeHTTP(stream, request)
		if text := stream.splitter.flush(); text != "" {
			stream.event("chunk", map[string]any{"text": text, "elapsed_ms": stream.elapsed()})
		}
		if stream.err != nil {
			stream.event("error", map[string]any{"message": stream.err.Error(), "elapsed_ms": stream.elapsed()})
		} else {
			stream.event("done", map[string]any{"elapsed_ms": stream.elapsed()})
		}
	}
}

// 路由产生的 HTTP 响应逐块封装为调试事件，不缓冲整段回复。
type debugRouteStream struct {
	writer   http.ResponseWriter
	flusher  http.Flusher
	header   http.Header
	started  time.Time
	ctx      context.Context
	cancel   context.CancelFunc
	splitter runeSplitter
	sent     bool
	err      error
}

func (s *debugRouteStream) Header() http.Header         { return s.header }
func (s *debugRouteStream) Flush()                      { s.flusher.Flush() }
func (s *debugRouteStream) elapsed() int64              { return time.Since(s.started).Milliseconds() }
func (s *debugRouteStream) recordStreamError(err error) { s.err = err }

func (s *debugRouteStream) event(kind string, payload any) {
	data, err := json.Marshal(payload)
	if err == nil {
		_, err = fmt.Fprintf(s.writer, "event: %s\ndata: %s\n\n", kind, data)
	}
	if err != nil {
		s.err = err
		s.cancel()
		return
	}
	s.flusher.Flush()
}

func (s *debugRouteStream) WriteHeader(status int) {
	if s.sent {
		return
	}
	s.sent = true
	headers := make(map[string]string, len(s.header))
	for key := range s.header {
		headers[strings.ToLower(key)] = s.header.Get(key)
	}
	s.event("response", map[string]any{"status_code": status, "headers": redactHeaderPreview(headers), "ttfb_ms": s.elapsed()})
}

func (s *debugRouteStream) Write(data []byte) (int, error) {
	if err := s.ctx.Err(); err != nil {
		return 0, err
	}
	if !s.sent {
		s.WriteHeader(http.StatusOK)
	}
	if text := s.splitter.push(data); text != "" {
		s.event("chunk", map[string]any{"text": text, "elapsed_ms": s.elapsed()})
	}
	if s.err != nil {
		return 0, s.err
	}
	return len(data), nil
}
