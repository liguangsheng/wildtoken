package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// RequestBody caches request fields and raw JSON offsets shared by routing,
// request rewriting and response routing.
type RequestBody struct {
	raw                []byte
	model              *string
	reasoningEffort    *string
	previousResponseID string
	storeDisabled      bool
	multipart          bool
	boundary           string
	jsonObject         bool
	members            []member
	closing            int
}

// ParseRequestBody extracts metadata and member offsets reused by routing and
// upstream preparation.
func ParseRequestBody(headers http.Header, raw []byte) (*RequestBody, error) {
	boundary, multipartBody, err := requestBoundary(headers)
	if err != nil {
		return nil, err
	}
	parsed := &RequestBody{raw: raw, multipart: multipartBody, boundary: boundary}
	if multipartBody {
		parsed.model, err = multipartRequestModel(boundary, raw)
		return parsed, err
	}

	members, closing, numbersFit, ok := scanObject(raw)
	if !ok {
		return parsed, nil
	}
	parsed.jsonObject = true
	parsed.members = members
	parsed.closing = closing
	parsed.previousResponseID = previousResponseID(raw, members)
	parsed.storeDisabled = storeDisabled(raw, members)
	// map[string]any decoding failed on such a body, and routing read
	// neither field from it.
	if !numbersFit {
		return parsed, nil
	}
	parsed.model = requestModel(raw, members)
	parsed.reasoningEffort = reasoningEffort(raw, members)
	return parsed, nil
}

// Model returns the model used for upstream selection.
func (b *RequestBody) Model() *string { return b.model }

// ReasoningEffort returns the effort named in the request.
func (b *RequestBody) ReasoningEffort() *string { return b.reasoningEffort }

// PreviousResponseID returns the valid response continuation identifier.
func (b *RequestBody) PreviousResponseID() string { return b.previousResponseID }

// StoreDisabled reports whether the request explicitly disabled response storage.
func (b *RequestBody) StoreDisabled() bool { return b.storeDisabled }

// Prepare rewrites the body for the selected upstream.
func (b *RequestBody) Prepare(forwardModel *string, path string,
	mappings map[string]string) ([]byte, error) {
	if b == nil {
		return nil, fmt.Errorf("request body is nil")
	}
	if b.multipart {
		return rewriteMultipartRequestBody(b.boundary, b.raw, forwardModel)
	}
	if !b.jsonObject {
		return b.raw, nil
	}
	return prepareJSONUpstreamBody(b.raw, b.members, b.closing, forwardModel, path, mappings), nil
}

func requestModel(body []byte, members []member) *string {
	var model *string
	for _, field := range members {
		if field.name != "model" {
			continue
		}
		raw := bytes.TrimSpace(body[field.start:field.end])
		if len(raw) == 0 || raw[0] != '"' {
			model = nil
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || value == "" {
			model = nil
			continue
		}
		model = &value
	}
	return model
}

func previousResponseID(body []byte, members []member) string {
	var id string
	valid := true
	for _, field := range members {
		if field.name != "previous_response_id" {
			continue
		}
		if err := json.Unmarshal(body[field.start:field.end], &id); err != nil {
			valid = false
		}
	}
	if !valid {
		return ""
	}
	return id
}

func storeDisabled(body []byte, members []member) bool {
	found, valid := false, true
	var value *bool
	for _, field := range members {
		if field.name != "store" {
			continue
		}
		found = true
		var current *bool
		if err := json.Unmarshal(body[field.start:field.end], &current); err != nil {
			valid = false
			continue
		}
		value = current
	}
	return found && valid && value != nil && !*value
}

func reasoningEffort(body []byte, members []member) *string {
	var direct, reasoning, outputConfig []byte
	hasDirect, hasReasoning, hasOutputConfig := false, false, false
	for _, field := range members {
		switch field.name {
		case "reasoning_effort":
			direct, hasDirect = body[field.start:field.end], true
		case "reasoning":
			reasoning, hasReasoning = body[field.start:field.end], true
		case "output_config":
			outputConfig, hasOutputConfig = body[field.start:field.end], true
		}
	}
	if hasDirect {
		if value, ok := formatEffortJSON(direct); ok {
			return &value
		}
	}
	if hasReasoning {
		if value := nestedEffort(reasoning); value != nil {
			return value
		}
	}
	if hasOutputConfig {
		return nestedEffort(outputConfig)
	}
	return nil
}

func nestedEffort(raw []byte) *string {
	members, _, ok := objectMembers(raw)
	if !ok {
		return nil
	}
	var effort []byte
	found := false
	for _, field := range members {
		if field.name == "effort" {
			effort, found = raw[field.start:field.end], true
		}
	}
	if !found {
		return nil
	}
	var value string
	if err := json.Unmarshal(effort, &value); err != nil {
		return nil
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func formatEffortJSON(raw []byte) (string, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "", false
	}
	switch raw[0] {
	case '"':
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return "", false
		}
		return formatEffort(value)
	case 't', 'f':
		var value bool
		if json.Unmarshal(raw, &value) != nil {
			return "", false
		}
		return formatEffort(value)
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		var value float64
		if json.Unmarshal(raw, &value) != nil {
			return "", false
		}
		return formatEffort(value)
	default:
		return "", false
	}
}
