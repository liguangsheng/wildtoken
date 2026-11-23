package proxy

import (
	"bytes"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
)

const maxModelFieldBytes = 4096

func requestBoundary(headers http.Header) (string, bool, error) {
	value := strings.TrimSpace(headers.Get("content-type"))
	if !strings.HasPrefix(strings.ToLower(value), "multipart/") {
		return "", false, nil
	}
	kind, params, err := mime.ParseMediaType(value)
	if err != nil || kind != "multipart/form-data" || params["boundary"] == "" {
		return "", true, fmt.Errorf("invalid multipart/form-data content type")
	}
	return params["boundary"], true, nil
}

// RequestModel reads JSON and multipart through the same routing boundary.
func RequestModel(headers http.Header, body []byte) (*string, error) {
	parsed, err := ParseRequestBody(headers, body)
	if err != nil {
		return nil, err
	}
	return parsed.Model(), nil
}

func multipartRequestModel(boundary string, body []byte) (*string, error) {
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	var model *string
	for parts := 0; ; parts++ {
		part, err := reader.NextRawPart()
		if err == io.EOF {
			return model, nil
		}
		if err != nil || parts >= 1000 {
			return nil, fmt.Errorf("invalid multipart request body")
		}
		if part.FormName() != "model" {
			if _, err := io.Copy(io.Discard, part); err != nil {
				return nil, fmt.Errorf("invalid multipart request body: %w", err)
			}
			continue
		}
		encoding := strings.ToLower(part.Header.Get("Content-Transfer-Encoding"))
		if encoding != "" && encoding != "binary" && encoding != "8bit" && encoding != "7bit" {
			return nil, fmt.Errorf("encoded multipart model fields are not supported")
		}
		value, err := io.ReadAll(io.LimitReader(part, maxModelFieldBytes+1))
		if err != nil || len(value) > maxModelFieldBytes || part.FileName() != "" {
			return nil, fmt.Errorf("invalid multipart model field")
		}
		text := string(value)
		if model != nil && *model != text {
			return nil, fmt.Errorf("conflicting multipart model fields")
		}
		model = &text
	}
}

func prepareRequestBody(headers http.Header, body []byte, forwardModel *string,
	path string, mappings map[string]string) ([]byte, error) {
	parsed, err := ParseRequestBody(headers, body)
	if err != nil {
		return nil, err
	}
	return parsed.Prepare(forwardModel, path, mappings)
}

func rewriteMultipartRequestBody(boundary string, body []byte,
	forwardModel *string) ([]byte, error) {
	if forwardModel == nil {
		return body, nil
	}

	var rewritten bytes.Buffer
	writer := multipart.NewWriter(&rewritten)
	if err := writer.SetBoundary(boundary); err != nil {
		return nil, err
	}
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	for {
		part, err := reader.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		out, err := writer.CreatePart(part.Header)
		if err != nil {
			return nil, err
		}
		if part.FormName() == "model" {
			_, err = io.WriteString(out, *forwardModel)
		} else {
			_, err = io.Copy(out, part)
		}
		if err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return rewritten.Bytes(), nil
}
