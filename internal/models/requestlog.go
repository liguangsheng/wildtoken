package models

import (
	"encoding/json"
	"strings"
)

// RequestLogOut is the list representation of a proxied request.
type RequestLogOut struct {
	ID                        int64   `json:"id"`
	CreatedAt                 string  `json:"created_at"`
	Method                    string  `json:"method"`
	Path                      string  `json:"path"`
	DownstreamTokenID         *int64  `json:"downstream_token_id"`
	DownstreamTokenName       *string `json:"downstream_token_name"`
	ClientType                string  `json:"client_type"`
	UpstreamID                *int64  `json:"upstream_id"`
	UpstreamName              *string `json:"upstream_name"`
	Model                     *string `json:"model"`
	RequestModel              *string `json:"request_model"`
	UpstreamModel             *string `json:"upstream_model"`
	ReasoningEffort           *string `json:"reasoning_effort"`
	ResponseReasoningEffort   *string `json:"response_reasoning_effort"`
	Stream                    int32   `json:"stream"`
	StatusCode                *int32  `json:"status_code"`
	PromptTokens              *int32  `json:"prompt_tokens"`
	CompletionTokens          *int32  `json:"completion_tokens"`
	TotalTokens               *int32  `json:"total_tokens"`
	PromptCachedTokens        *int32  `json:"prompt_cached_tokens"`
	CacheCreationTokens       *int32  `json:"cache_creation_tokens"`
	CompletionReasoningTokens *int32  `json:"completion_reasoning_tokens"`
	DurationMs                *int32  `json:"duration_ms"`
	FirstTokenMs              *int32  `json:"first_token_ms"`
	Error                     *string `json:"error"`
}

// RequestLogDetailOut flattens RequestLogOut and adds the captured payloads.
type RequestLogDetailOut struct {
	RequestLogOut
	DownstreamRequest  json.RawMessage `json:"downstream_request"`
	UpstreamRequest    json.RawMessage `json:"upstream_request"`
	UpstreamResponse   json.RawMessage `json:"upstream_response"`
	DownstreamResponse json.RawMessage `json:"downstream_response"`
}

// MarshalJSON flattens the embedded log fields alongside the payloads, matching
// serde's `#[serde(flatten)]` output.
func (d RequestLogDetailOut) MarshalJSON() ([]byte, error) {
	base, err := json.Marshal(d.RequestLogOut)
	if err != nil {
		return nil, err
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(base, &merged); err != nil {
		return nil, err
	}
	for key, value := range map[string]json.RawMessage{
		"downstream_request":  d.DownstreamRequest,
		"upstream_request":    d.UpstreamRequest,
		"upstream_response":   d.UpstreamResponse,
		"downstream_response": d.DownstreamResponse,
	} {
		if value == nil {
			value = json.RawMessage("null")
		}
		merged[key] = value
	}
	return json.Marshal(merged)
}

type RequestLogCursorOut struct {
	CreatedAt string `json:"created_at"`
	ID        int64  `json:"id"`
}

type RequestLogPage struct {
	Items      []RequestLogOut      `json:"items"`
	HasMore    bool                 `json:"has_more"`
	RecentRPM  int64                `json:"recent_rpm"`
	RecentTPM  int64                `json:"recent_tpm"`
	NextCursor *RequestLogCursorOut `json:"next_cursor,omitempty"`
}

type TokenUsageWindowOut struct {
	TotalTokens int64 `json:"total_tokens"`
	// PromptTokens is the total input/prompt tokens in the window.
	PromptTokens int64 `json:"prompt_tokens"`
	// PromptCachedTokens counts cache-hit/read input tokens. Cache creation and
	// write tokens are not hits.
	PromptCachedTokens int64 `json:"prompt_cached_tokens"`
	// RequestCount counts requests with a recorded token total, retained for the
	// token usage card hint.
	RequestCount int64 `json:"request_count"`
	// AllRequestCount counts every request log in the window, including errors
	// and responses without usage.
	AllRequestCount int64 `json:"all_request_count"`
}

type TokenUsageStatsOut struct {
	Today      TokenUsageWindowOut `json:"today"`
	OneDay     TokenUsageWindowOut `json:"one_day"`
	SevenDays  TokenUsageWindowOut `json:"seven_days"`
	ThirtyDays TokenUsageWindowOut `json:"thirty_days"`
	AllTime    TokenUsageWindowOut `json:"all_time"`
	Range      string              `json:"range,omitempty"`
	RangeLabel string              `json:"range_label,omitempty"`
}

type RequestLogTopItemOut struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
	// ID is present for channel rankings grouped by `upstream_id`.
	ID *int64 `json:"id,omitempty"`
	// AvgDurationMs and ErrorRate attach latency and failure context to
	// request-count rankings: which models feel slow or fail, beyond how
	// often they are called. Absent on token rankings.
	AvgDurationMs *float64 `json:"avg_duration_ms,omitempty"`
	ErrorRate     *float64 `json:"error_rate,omitempty"`
}

type RequestLogTopStatsOut struct {
	Window string `json:"window"`
	// Models ranks by request count. Kept as `models` for API compatibility.
	Models []RequestLogTopItemOut `json:"models"`
	// Channels ranks by request count. Kept as `channels` for API compatibility.
	Channels      []RequestLogTopItemOut `json:"channels"`
	ModelTokens   []RequestLogTopItemOut `json:"model_tokens"`
	ChannelTokens []RequestLogTopItemOut `json:"channel_tokens"`
}

type TestRequest struct {
	Path string `json:"path"`
}

// Validate keeps the probe path to something that can be appended to a base URL.
//
// The path is concatenated onto the channel's base URL, so a query string or
// fragment here lands in the middle of the request rather than where it was
// written — the same reason ValidateBaseURL refuses them on the other side of
// the join. Dot segments are refused because the upstream, not this service,
// resolves them, which makes the request reach a path the operator did not name.
func (t *TestRequest) Validate() error {
	path := strings.TrimSpace(t.Path)
	if path == "" {
		return nil
	}
	if len(path) > 512 {
		return ErrString("path must be at most 512 bytes")
	}
	if strings.ContainsAny(path, "?#") {
		return ErrString("path must not carry a query string or fragment")
	}
	if strings.ContainsFunc(path, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return ErrString("path must not contain control characters")
	}
	for segment := range strings.SplitSeq(path, "/") {
		if segment == "." || segment == ".." {
			return ErrString("path must not contain . or .. segments")
		}
	}
	t.Path = path
	return nil
}

// DefaultTestRequest supplies the `/v1/models` default for an absent path.
func DefaultTestRequest() TestRequest {
	return TestRequest{Path: "/v1/models"}
}

type ModelListOut struct {
	Models []string `json:"models"`
}

type ModelFetchIn struct {
	BaseURL        string            `json:"base_url"`
	APIKey         *string           `json:"api_key"`
	ExtraHeaders   map[string]string `json:"extra_headers"`
	TimeoutSeconds *float64          `json:"timeout_seconds"`
}
