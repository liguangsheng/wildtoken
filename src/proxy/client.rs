use crate::error::AppError;
use crate::models::upstream::UpstreamRow;
use crate::state::AppState;
use futures::StreamExt;
use std::collections::HashMap;

use super::logging;
use super::matcher::{self, BackoffManager};

// ── Constants ────────────────────────────────────────────────────────────────

/// Headers that must **not** be forwarded to the upstream.
pub const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "host",
    "content-length",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "x-wildtoken-upstream",
];

/// Credentials accepted from downstream clients but never forwarded as-is.
///
/// Keep these separate from `HOP_BY_HOP_HEADERS`: the selected channel may
/// legitimately inject or override `x-api-key` for an Anthropic upstream.
const DOWNSTREAM_CREDENTIAL_HEADERS: &[&str] = &["authorization", "x-api-key"];

/// Headers whose transport semantics cannot safely be controlled by a channel
/// override. `x-wildtoken-upstream` is internal routing metadata.
const NON_OVERRIDABLE_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "host",
    "content-length",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "x-wildtoken-upstream",
];

const CLIENT_HEADER_PLACEHOLDER_PREFIX: &str = "{client_header:";

/// Headers whose values should be redacted in logging context.
pub const LOG_REDACTED_HEADERS: &[&str] = &[
    "authorization",
    "api-key",
    "x-api-key",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "proxy-authenticate",
    "x-admin-token",
    "x-auth-token",
    "x-access-token",
    "x-goog-api-key",
    "x-amz-security-token",
];

pub(crate) fn is_sensitive_header_name(name: &str) -> bool {
    if LOG_REDACTED_HEADERS
        .iter()
        .any(|header| name.eq_ignore_ascii_case(header))
    {
        return true;
    }

    name.to_ascii_lowercase().split(['-', '_']).any(|part| {
        matches!(
            part,
            "auth"
                | "authorization"
                | "apikey"
                | "credential"
                | "credentials"
                | "key"
                | "secret"
                | "signature"
                | "token"
                | "cookie"
        )
    })
}

// ── URL building ─────────────────────────────────────────────────────────────

/// Build the full upstream URL.
pub fn build_upstream_url(
    upstream: &UpstreamRow,
    path: &str,
    query_params: Option<&str>,
) -> String {
    let base = upstream.base_url.trim_end_matches('/');
    let suffix = path.trim_start_matches('/');
    let mut target = if base.ends_with("/v1") {
        format!("{base}/{suffix}")
    } else {
        format!("{base}/v1/{suffix}")
    };
    if let Some(q) = query_params {
        if !q.is_empty() {
            target.push('?');
            target.push_str(q);
        }
    }
    target
}

// ── Header forwarding ───────────────────────────────────────────────────────

fn parse_client_header_placeholder(value: &str) -> Result<Option<&str>, ()> {
    if let Some(rest) = value.strip_prefix(CLIENT_HEADER_PLACEHOLDER_PREFIX) {
        let source = rest.strip_suffix('}').filter(|source| !source.is_empty());
        return source.map(Some).ok_or(());
    }
    if value.contains(CLIENT_HEADER_PLACEHOLDER_PREFIX) {
        return Err(());
    }
    Ok(None)
}

fn connection_nominated_headers(
    headers: &axum::http::HeaderMap,
) -> std::collections::HashSet<String> {
    headers
        .get_all(axum::http::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

/// Validate a channel Header override map before it is persisted or used by an
/// admin preview request.
pub(crate) fn validate_header_overrides(overrides: &HashMap<String, String>) -> Result<(), String> {
    let mut normalized_names = std::collections::HashSet::new();

    for (name, value) in overrides {
        let normalized = name.to_ascii_lowercase();
        if axum::http::HeaderName::from_bytes(name.as_bytes()).is_err() {
            return Err(format!("invalid Header name: {name}"));
        }
        match parse_client_header_placeholder(value) {
            Ok(Some(source)) => {
                let source_normalized = source.to_ascii_lowercase();
                if axum::http::HeaderName::from_bytes(source.as_bytes()).is_err() {
                    return Err(format!(
                        "invalid client Header placeholder for {name}: {source}"
                    ));
                }
                if DOWNSTREAM_CREDENTIAL_HEADERS.contains(&source_normalized.as_str()) {
                    return Err(format!(
                        "client credential Header {source} cannot be used in an override"
                    ));
                }
                if NON_OVERRIDABLE_HEADERS.contains(&source_normalized.as_str()) {
                    return Err(format!(
                        "client Header {source} cannot be used in an override"
                    ));
                }
            }
            Ok(None) => {
                if axum::http::HeaderValue::from_bytes(value.as_bytes()).is_err() {
                    return Err(format!("invalid value for Header {name}"));
                }
            }
            Err(()) => {
                return Err(format!(
                    "invalid client Header placeholder for {name}; it must occupy the whole value"
                ));
            }
        }
        if NON_OVERRIDABLE_HEADERS.contains(&normalized.as_str()) {
            return Err(format!("Header {name} cannot be overridden"));
        }
        if !normalized_names.insert(normalized) {
            return Err(format!(
                "duplicate Header name with different casing: {name}"
            ));
        }
    }

    Ok(())
}

/// Apply configured Header overrides last, using HTTP's case-insensitive name
/// semantics. Callers must validate user input before persisting it.
pub(crate) fn apply_header_overrides(
    headers: &mut HashMap<String, String>,
    overrides: &HashMap<String, String>,
    downstream_headers: Option<&axum::http::HeaderMap>,
) {
    let connection_nominated = downstream_headers
        .map(connection_nominated_headers)
        .unwrap_or_default();
    for (name, value) in overrides {
        let resolved = match parse_client_header_placeholder(value) {
            Ok(Some(source)) if !connection_nominated.contains(&source.to_ascii_lowercase()) => {
                downstream_headers
                    .and_then(|downstream| downstream.get(source))
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
            }
            Ok(Some(_)) => None,
            Ok(None) => Some(value.clone()),
            Err(()) => None,
        };
        if let Some(resolved) = resolved {
            headers.insert(name.to_ascii_lowercase(), resolved);
        }
    }
}

/// Build forward headers: filter hop-by-hop, inject api_key, merge extra_headers.
///
/// Header names are normalized to lowercase so we never emit case-duplicate keys
/// (e.g. both `Authorization` and `authorization`), which many reverse proxies
/// reject with a raw HTTP 400 HTML page.
///
/// The downstream client's `Authorization` is intentionally dropped; we inject
/// the upstream key under a single lowercase `authorization` name.
pub fn build_forward_headers(
    downstream_headers: &axum::http::HeaderMap,
    upstream: &UpstreamRow,
    path: &str,
) -> Result<HashMap<String, String>, AppError> {
    let mut out = HashMap::new();
    let connection_nominated = connection_nominated_headers(downstream_headers);

    for (name, value) in downstream_headers.iter() {
        let name_lower = name.as_str().to_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&name_lower.as_str())
            || connection_nominated.contains(&name_lower)
        {
            continue;
        }
        // Never forward the client's credentials; replace them below from the
        // selected channel configuration.
        if DOWNSTREAM_CREDENTIAL_HEADERS.contains(&name_lower.as_str()) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out.insert(name_lower, v.to_string());
        }
    }

    // Prefer uncompressed responses so we can log usage from body text.
    out.insert("accept-encoding".into(), "identity".into());

    let is_anthropic_messages = path.trim_matches('/') == "messages";

    // Always replace downstream credentials with the selected upstream key.
    if let Some(ref key) = upstream.api_key {
        if !key.is_empty() {
            if is_anthropic_messages {
                out.insert("x-api-key".into(), key.to_string());
                // All supported Anthropic Messages API versions use this value.
                // A configured extra header below can explicitly override it.
                out.entry("anthropic-version".into())
                    .or_insert_with(|| "2023-06-01".into());
            } else {
                out.insert("authorization".into(), format!("Bearer {key}"));
            }
        }
    }

    // Merge extra_headers last so they can override (normalize keys too).
    let extra = serde_json::from_str::<HashMap<String, String>>(&upstream.extra_headers).map_err(
        |error| {
            AppError::UpstreamError(format!(
                "channel {} has invalid Header override JSON: {error}",
                upstream.name
            ))
        },
    )?;
    validate_header_overrides(&extra).map_err(|message| {
        AppError::UpstreamError(format!(
            "channel {} has an invalid Header override: {message}",
            upstream.name
        ))
    })?;
    apply_header_overrides(&mut out, &extra, Some(downstream_headers));

    // A channel override must not reintroduce a field explicitly nominated by
    // the downstream Connection header as hop-by-hop.
    for name in connection_nominated {
        out.remove(&name);
    }

    Ok(out)
}

// ── SSE / token helpers ─────────────────────────────────────────────────────

fn non_empty_str(value: &serde_json::Value) -> bool {
    value.as_str().map(|s| !s.is_empty()).unwrap_or(false)
}

/// Whether a parsed SSE JSON payload contains the first visible generation token.
///
/// Counts text deltas and the first non-empty tool-call delta (common when the
/// model streams only function calls without content/reasoning text).
fn json_has_visible_token(obj: &serde_json::Value) -> bool {
    // Anthropic Messages API streaming events.
    if obj
        .get("type")
        .and_then(|v| v.as_str())
        .is_some_and(|t| t == "content_block_delta" || t == "content_block_start")
    {
        let delta = obj.get("delta").or_else(|| obj.get("content_block"));
        if let Some(delta) = delta {
            if non_empty_str(&delta["text"])
                || non_empty_str(&delta["thinking"])
                || non_empty_str(&delta["partial_json"])
            {
                return true;
            }
        }
    }

    if let Some(choices) = obj.get("choices").and_then(|v| v.as_array()) {
        for choice in choices {
            let delta = &choice["delta"];
            if non_empty_str(&delta["content"])
                || non_empty_str(&delta["reasoning_content"])
                || non_empty_str(&delta["reasoning"])
                || non_empty_str(&delta["text"])
            {
                return true;
            }
            // Pure tool-call streams have no text content; treat first tool_calls
            // chunk as TTFT so agent/tool turns are not left blank in the UI.
            if delta["tool_calls"]
                .as_array()
                .is_some_and(|arr| !arr.is_empty())
            {
                return true;
            }
            if non_empty_str(&choice["text"]) || non_empty_str(&choice["message"]["content"]) {
                return true;
            }
            if choice["message"]["tool_calls"]
                .as_array()
                .is_some_and(|arr| !arr.is_empty())
            {
                return true;
            }
        }
    }

    // OpenAI Responses API streaming events.
    if obj.get("type").and_then(|v| v.as_str()).is_some_and(|t| {
        t == "response.output_text.delta"
            || t == "response.reasoning_text.delta"
            || t == "response.reasoning_summary_text.delta"
            || t == "response.function_call_arguments.delta"
            || t == "response.custom_tool_call_input.delta"
    }) && (non_empty_str(&obj["delta"])
        || obj["delta"].as_object().is_some_and(|m| !m.is_empty()))
    {
        return true;
    }

    false
}

/// Detect whether an SSE line/chunk contains a visible content token.
pub fn extract_first_token_ms(chunk: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(chunk).ok()?;
    for line in text.lines() {
        if sse_line_has_visible_token(line) {
            return Some(0);
        }
    }
    None
}

fn sse_line_has_visible_token(line: &str) -> bool {
    let line = line.trim();
    let Some(data) = line.strip_prefix("data:") else {
        return false;
    };
    let data = data.trim_start();
    if data.is_empty() || data == "[DONE]" {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .is_some_and(|obj| json_has_visible_token(&obj))
}

/// Extract token usage from either SSE stream body or JSON body.
///
/// Returns `(prompt_tokens, completion_tokens, total_tokens)`.
fn extract_usage_values(usage: &serde_json::Value) -> (Option<i32>, Option<i32>, Option<i32>) {
    let prompt = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(|value| value.as_i64())
        .map(|value| value as i32);
    let completion = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(|value| value.as_i64())
        .map(|value| value as i32);
    let total = usage
        .get("total_tokens")
        .and_then(|value| value.as_i64())
        .map(|value| value as i32);

    (prompt, completion, total)
}

pub fn extract_usage(
    raw_body: &[u8],
    content_type: &str,
) -> (Option<i32>, Option<i32>, Option<i32>) {
    let text = match std::str::from_utf8(raw_body) {
        Ok(s) => s,
        Err(_) => return (None, None, None),
    };

    if content_type.contains("text/event-stream") || content_type.contains("sse") {
        let mut prompt = None;
        let mut completion = None;
        let mut total = None;
        for line in text.lines() {
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    continue;
                }
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(usage) = obj.get("usage").or_else(|| {
                        obj.get("response")
                            .and_then(|response| response.get("usage"))
                    }) {
                        (prompt, completion, total) = extract_usage_values(usage);
                    }
                }
            }
        }
        return (prompt, completion, total);
    }

    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(usage) = obj.get("usage").or_else(|| {
            obj.get("response")
                .and_then(|response| response.get("usage"))
        }) {
            return extract_usage_values(usage);
        }
    }

    (None, None, None)
}

/// Extract reasoning effort from an OpenAI-compatible request body.
///
/// Supports:
/// - top-level `reasoning_effort` (chat completions / o-series)
/// - nested `reasoning.effort` (Responses API style)
fn extract_reasoning_effort(body: &[u8]) -> Option<String> {
    let json = serde_json::from_slice::<serde_json::Value>(body).ok()?;

    if let Some(v) = json.get("reasoning_effort") {
        if let Some(s) = v.as_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        } else if let Some(n) = v.as_i64() {
            return Some(n.to_string());
        } else if let Some(n) = v.as_f64() {
            return Some(n.to_string());
        } else if let Some(b) = v.as_bool() {
            return Some(b.to_string());
        }
    }

    if let Some(s) = json
        .get("reasoning")
        .and_then(|r| r.get("effort"))
        .and_then(|v| v.as_str())
    {
        let s = s.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }

    None
}

fn extract_response_reasoning_effort(raw_body: &[u8], content_type: &str) -> Option<String> {
    fn from_value(value: &serde_json::Value) -> Option<String> {
        value
            .get("response")
            .unwrap_or(value)
            .get("reasoning")
            .and_then(|reasoning| reasoning.get("effort"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|effort| !effort.is_empty())
            .map(str::to_string)
    }

    if content_type.contains("event-stream") || raw_body.starts_with(b"data:") {
        for line in std::str::from_utf8(raw_body).ok()?.lines() {
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                if let Some(effort) = from_value(&value) {
                    return Some(effort);
                }
            }
        }
        None
    } else {
        serde_json::from_slice::<serde_json::Value>(raw_body)
            .ok()
            .and_then(|value| from_value(&value))
    }
}

/// Prepare a JSON request body for its selected upstream.
///
/// Streaming Chat Completions responses omit usage by default on many
/// OpenAI-compatible upstreams. Request it explicitly so the gateway can
/// consistently record prompt, completion, and total token counts.
pub(crate) fn prepare_upstream_body(
    body: &[u8],
    forward_model: Option<&str>,
    path: &str,
) -> Vec<u8> {
    let Ok(mut request) = serde_json::from_slice::<serde_json::Value>(body) else {
        return body.to_vec();
    };
    let Some(request_obj) = request.as_object_mut() else {
        return body.to_vec();
    };

    let mut changed = false;

    if let Some(model) = forward_model {
        if request_obj
            .get("model")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|current| current != model)
        {
            request_obj.insert("model".into(), serde_json::Value::String(model.to_string()));
            changed = true;
        }
    }

    if path.trim_matches('/') == "chat/completions"
        && request_obj
            .get("stream")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    {
        let stream_options = request_obj
            .entry("stream_options")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

        if !stream_options.is_object() {
            *stream_options = serde_json::Value::Object(serde_json::Map::new());
            changed = true;
        }

        let stream_options = stream_options
            .as_object_mut()
            .expect("stream_options was normalized to an object");
        if stream_options.get("include_usage") != Some(&serde_json::Value::Bool(true)) {
            stream_options.insert("include_usage".into(), serde_json::Value::Bool(true));
            changed = true;
        }
    }

    if changed {
        serde_json::to_vec(&request).unwrap_or_else(|_| body.to_vec())
    } else {
        body.to_vec()
    }
}

/// Read the full upstream body while recording true TTFT for SSE streams.
async fn read_response_body(
    response: reqwest::Response,
    start: std::time::Instant,
) -> Result<(Vec<u8>, Option<i32>), reqwest::Error> {
    let mut body_bytes = Vec::new();
    let mut first_token_ms = None;
    let mut line_buf = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        body_bytes.extend_from_slice(&chunk);

        if first_token_ms.is_none() {
            line_buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                let rest = line_buf[pos + 1..].to_string();
                line_buf = rest;
                if sse_line_has_visible_token(&line) {
                    first_token_ms = Some(start.elapsed().as_millis() as i32);
                    break;
                }
            }
        }
    }

    // Final partial line (rare, but keep parity with buffered detection).
    if first_token_ms.is_none() && sse_line_has_visible_token(line_buf.trim_end_matches('\r')) {
        first_token_ms = Some(start.elapsed().as_millis() as i32);
    }

    Ok((body_bytes, first_token_ms))
}

// ── Main proxy function ─────────────────────────────────────────────────────

/// Proxy a request to the upstream, returning (status_code, response_headers, body_bytes).
pub async fn proxy_request(
    state: &AppState,
    backoff: &BackoffManager,
    upstream: &UpstreamRow,
    downstream_token_id: i64,
    downstream_token_name: &str,
    client_type: &str,
    forward_model: Option<&str>,
    method: &str,
    path: &str,
    query_params: Option<&str>,
    downstream_headers: &axum::http::HeaderMap,
    body: &[u8],
) -> Result<(axum::http::StatusCode, HashMap<String, String>, Vec<u8>), AppError> {
    let start = std::time::Instant::now();
    let reasoning_effort = extract_reasoning_effort(body);

    let url = build_upstream_url(upstream, path, query_params);
    let fwd_headers = build_forward_headers(downstream_headers, upstream, path)?;
    let log_body_max_bytes = state.runtime_settings.read().await.log_body_max_bytes as usize;

    let downstream_snap =
        logging::snapshot_request(method, &url, &fwd_headers, Some(body), log_body_max_bytes);

    let upstream_body = prepare_upstream_body(body, forward_model, path);

    let upstream_snap = logging::snapshot_request(
        method,
        &url,
        &fwd_headers,
        Some(&upstream_body),
        log_body_max_bytes,
    );

    let mut req_builder = state.http_client.request(
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST),
        &url,
    );

    for (k, v) in &fwd_headers {
        let kl = k.to_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&kl.as_str()) {
            continue;
        }
        req_builder = req_builder.header(k.as_str(), v.as_str());
    }

    if !upstream_body.is_empty() {
        req_builder = req_builder.body(upstream_body.clone());
    }

    req_builder = req_builder.timeout(std::time::Duration::from_secs_f64(
        if upstream.timeout_seconds > 0.0 {
            upstream.timeout_seconds
        } else {
            state.settings.upstream.default_timeout_seconds
        },
    ));

    let response = match req_builder.send().await {
        Ok(resp) => resp,
        Err(e) => {
            backoff.record_failure(upstream.id);

            let elapsed = start.elapsed();
            let code: i32 = if e.is_timeout() { 504 } else { 502 };
            let err_msg = e.to_string();

            let log_entry = logging::LogEntry {
                method: method.to_string(),
                path: path.to_string(),
                downstream_token_id: Some(downstream_token_id),
                downstream_token_name: Some(downstream_token_name.to_string()),
                client_type: Some(client_type.to_string()),
                upstream_id: Some(upstream.id),
                upstream_name: Some(upstream.name.clone()),
                model: forward_model.map(|s| s.to_string()),
                reasoning_effort: reasoning_effort.clone(),
                stream: false,
                status_code: Some(code),
                duration_ms: Some(elapsed.as_millis() as i32),
                error: Some(err_msg.clone()),
                downstream_request: Some(downstream_snap),
                upstream_request: Some(upstream_snap),
                ..Default::default()
            };
            logging::schedule_log(&state.db, log_entry);

            return Err(AppError::UpstreamError(err_msg));
        }
    };

    let status = response.status();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(v) = value.to_str() {
            resp_headers.insert(name.as_str().to_string(), v.to_string());
        }
    }

    let content_type = resp_headers
        .get("content-type")
        .cloned()
        .unwrap_or_default();

    let (body_bytes, streamed_first_token_ms) = match read_response_body(response, start).await {
        Ok(v) => v,
        Err(e) => {
            backoff.record_failure(upstream.id);
            let elapsed = start.elapsed();
            let log_entry = logging::LogEntry {
                method: method.to_string(),
                path: path.to_string(),
                downstream_token_id: Some(downstream_token_id),
                downstream_token_name: Some(downstream_token_name.to_string()),
                client_type: Some(client_type.to_string()),
                upstream_id: Some(upstream.id),
                upstream_name: Some(upstream.name.clone()),
                model: forward_model.map(|s| s.to_string()),
                reasoning_effort: reasoning_effort.clone(),
                stream: false,
                status_code: Some(502),
                duration_ms: Some(elapsed.as_millis() as i32),
                error: Some(e.to_string()),
                downstream_request: Some(downstream_snap),
                upstream_request: Some(upstream_snap),
                ..Default::default()
            };
            logging::schedule_log(&state.db, log_entry);
            return Err(AppError::UpstreamError(e.to_string()));
        }
    };

    let status_u16 = status.as_u16();
    let auto_disabled = matcher::AUTO_DISABLE_STATUS_CODES.contains(&status_u16);
    if auto_disabled {
        let _ = crate::db::upstream::set_upstream_enabled(&state.db, upstream.id, false).await;
    }

    // Backoff bookkeeping: success on 2xx or after auto-disable; else failure.
    if auto_disabled || (200..300).contains(&status_u16) {
        backoff.record_success(upstream.id);
    } else {
        backoff.record_failure(upstream.id);
    }

    let upstream_resp_snap = logging::snapshot_response(
        status_u16,
        &resp_headers,
        Some(&body_bytes),
        log_body_max_bytes,
    );

    let (prompt_tokens, completion_tokens, total_tokens) =
        extract_usage(&body_bytes, &content_type);
    let response_reasoning_effort = extract_response_reasoning_effort(&body_bytes, &content_type);

    let elapsed = start.elapsed();
    let is_stream = body_bytes.starts_with(b"data:") || content_type.contains("event-stream");

    // Prefer true stream TTFT; fall back to buffered detection only for stream bodies.
    let first_token_ms = if is_stream {
        streamed_first_token_ms
            .or_else(|| extract_first_token_ms(&body_bytes).map(|_| elapsed.as_millis() as i32))
    } else {
        None
    };

    let log_entry = logging::LogEntry {
        method: method.to_string(),
        path: path.to_string(),
        downstream_token_id: Some(downstream_token_id),
        downstream_token_name: Some(downstream_token_name.to_string()),
        client_type: Some(client_type.to_string()),
        upstream_id: Some(upstream.id),
        upstream_name: Some(upstream.name.clone()),
        model: forward_model.map(|s| s.to_string()),
        reasoning_effort,
        response_reasoning_effort,
        stream: is_stream,
        status_code: Some(status_u16 as i32),
        prompt_tokens,
        completion_tokens,
        total_tokens,
        first_token_ms,
        duration_ms: Some(elapsed.as_millis() as i32),
        downstream_request: Some(downstream_snap),
        upstream_request: Some(upstream_snap),
        upstream_response: Some(upstream_resp_snap.clone()),
        downstream_response: Some(upstream_resp_snap),
        ..Default::default()
    };
    logging::schedule_log(&state.db, log_entry);

    Ok((status, resp_headers, body_bytes))
}

#[cfg(test)]
mod tests {
    use super::{
        build_forward_headers, extract_first_token_ms, extract_usage, prepare_upstream_body,
        proxy_request, validate_header_overrides,
    };
    use crate::{
        config::Settings,
        models::{
            settings::{AdminCredential, RuntimeSettings},
            upstream::UpstreamRow,
        },
        proxy::matcher::BackoffManager,
        state::{init_db, AppState},
    };
    use axum::{
        http::{HeaderMap, HeaderValue},
        routing::post,
        Json, Router,
    };
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{
        collections::HashMap,
        sync::{atomic::AtomicI64, Arc},
        time::Instant,
    };
    use tokio::sync::RwLock;

    fn upstream_with_headers(path_base: String, extra_headers: serde_json::Value) -> UpstreamRow {
        UpstreamRow {
            id: 1,
            name: "test-channel".into(),
            base_url: path_base,
            api_key: Some("upstream-secret".into()),
            model_names: "[]".into(),
            model_prefixes: "[]".into(),
            model_mappings: "{}".into(),
            priority: 100,
            enabled: 1,
            extra_headers: extra_headers.to_string(),
            timeout_seconds: 30.0,
            created_at: "".into(),
            updated_at: "".into(),
        }
    }

    #[test]
    fn streaming_chat_request_includes_usage_and_preserves_options() {
        let body = json!({
            "model": "requested-model",
            "stream": true,
            "stream_options": {"include_obfuscation": true}
        });

        let prepared = prepare_upstream_body(
            &serde_json::to_vec(&body).unwrap(),
            Some("upstream-model"),
            "chat/completions",
        );
        let prepared: serde_json::Value = serde_json::from_slice(&prepared).unwrap();

        assert_eq!(prepared["model"], "upstream-model");
        assert_eq!(prepared["stream_options"]["include_usage"], true);
        assert_eq!(prepared["stream_options"]["include_obfuscation"], true);
    }

    #[test]
    fn usage_option_is_not_added_to_other_or_non_streaming_requests() {
        for (path, body) in [
            ("chat/completions", json!({"model": "m", "stream": false})),
            ("responses", json!({"model": "m", "stream": true})),
        ] {
            let prepared = prepare_upstream_body(&serde_json::to_vec(&body).unwrap(), None, path);
            let prepared: serde_json::Value = serde_json::from_slice(&prepared).unwrap();
            assert!(prepared.get("stream_options").is_none());
        }
    }

    #[test]
    fn extracts_usage_from_codex_responses_completion_event() {
        let response = br#"data: {"type":"response.completed","response":{"usage":{"input_tokens":99424,"output_tokens":440,"total_tokens":99864}}}

"#;

        assert_eq!(
            extract_usage(response, "text/event-stream"),
            (Some(99424), Some(440), Some(99864))
        );
    }

    #[test]
    fn anthropic_messages_uses_upstream_x_api_key_and_hides_downstream_key() {
        let mut downstream = HeaderMap::new();
        downstream.insert("x-api-key", HeaderValue::from_static("downstream-secret"));
        let upstream = upstream_with_headers("https://api.anthropic.com".into(), json!({}));

        let headers = build_forward_headers(&downstream, &upstream, "messages").unwrap();
        assert_eq!(
            headers.get("x-api-key"),
            Some(&"upstream-secret".to_string())
        );
        assert_eq!(
            headers.get("anthropic-version"),
            Some(&"2023-06-01".to_string())
        );
        assert!(!headers.contains_key("authorization"));
    }

    #[test]
    fn channel_headers_override_downstream_and_generated_credentials_case_insensitively() {
        let mut downstream = HeaderMap::new();
        downstream.insert("user-agent", HeaderValue::from_static("downstream-agent"));
        downstream.insert("x-request-id", HeaderValue::from_static("request-123"));
        downstream.insert(
            "authorization",
            HeaderValue::from_static("downstream-secret"),
        );
        let upstream = upstream_with_headers(
            "https://example.test".into(),
            json!({
                "UsEr-AgEnT": "channel-agent",
                "AUTHORIZATION": "Token channel-credential",
                "X-Trace-Id": "channel-trace",
                "X-Upstream-Request": "{client_header:X-Request-Id}",
                "X-Missing": "{client_header:X-Not-Present}"
            }),
        );

        let headers = build_forward_headers(&downstream, &upstream, "responses").unwrap();

        assert_eq!(headers.get("user-agent"), Some(&"channel-agent".into()));
        assert_eq!(
            headers.get("authorization"),
            Some(&"Token channel-credential".into())
        );
        assert_eq!(headers.get("x-trace-id"), Some(&"channel-trace".into()));
        assert_eq!(
            headers.get("x-upstream-request"),
            Some(&"request-123".into())
        );
        assert!(!headers.contains_key("x-missing"));
        assert_eq!(
            headers
                .keys()
                .filter(|name| name.eq_ignore_ascii_case("authorization"))
                .count(),
            1
        );
    }

    #[test]
    fn header_override_validation_rejects_ambiguous_or_transport_headers() {
        let duplicate = HashMap::from([
            ("Authorization".into(), "one".into()),
            ("authorization".into(), "two".into()),
        ]);
        assert!(validate_header_overrides(&duplicate)
            .unwrap_err()
            .contains("duplicate Header"));

        for overrides in [
            HashMap::from([("Host".into(), "example.test".into())]),
            HashMap::from([("Connection".into(), "keep-alive".into())]),
            HashMap::from([("X-Test".into(), "one\r\ntwo".into())]),
            HashMap::from([(
                "X-Test".into(),
                "prefix-{client_header:X-Request-Id}".into(),
            )]),
            HashMap::from([("X-Test".into(), "{client_header:Authorization}".into())]),
        ] {
            assert!(validate_header_overrides(&overrides).is_err());
        }
    }

    #[test]
    fn connection_nominated_headers_are_not_forwarded_or_reintroduced() {
        let mut downstream = HeaderMap::new();
        downstream.insert("connection", HeaderValue::from_static("x-hop, keep-alive"));
        downstream.insert("x-hop", HeaderValue::from_static("downstream-value"));
        let upstream = upstream_with_headers(
            "https://example.test".into(),
            json!({
                "X-Hop": "channel-value",
                "X-Remapped-Hop": "{client_header:X-Hop}",
                "X-End-To-End": "kept"
            }),
        );

        let headers = build_forward_headers(&downstream, &upstream, "responses").unwrap();

        assert!(!headers.contains_key("connection"));
        assert!(!headers.contains_key("x-hop"));
        assert!(!headers.contains_key("x-remapped-hop"));
        assert_eq!(headers["x-end-to-end"], "kept");
    }

    #[tokio::test]
    async fn anthropic_channel_overrides_reach_the_upstream_on_the_wire() {
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/messages",
            post(move |headers: HeaderMap| {
                let sent = sent.clone();
                async move {
                    sent.send(headers).unwrap();
                    Json(json!({"ok": true}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&db).await.unwrap();
        let state = AppState {
            db,
            http_client: reqwest::Client::new(),
            settings: Settings::default(),
            backoff: Arc::new(BackoffManager::new()),
            runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
            admin_credential: Arc::new(RwLock::new(AdminCredential {
                credential_hash: "test".into(),
                credential_version: 1,
            })),
            admin_credential_version: Arc::new(AtomicI64::new(1)),
            started_at: Instant::now(),
        };
        let upstream = upstream_with_headers(
            format!("http://{address}"),
            json!({
                "X-API-Key": "overridden-upstream-key",
                "Anthropic-Version": "2025-01-01",
                "User-Agent": "channel-agent",
                "X-Client-Request": "{client_header:X-Request-Id}"
            }),
        );
        let mut downstream = HeaderMap::new();
        downstream.insert("x-api-key", HeaderValue::from_static("downstream-secret"));
        downstream.insert("user-agent", HeaderValue::from_static("downstream-agent"));
        downstream.insert("x-request-id", HeaderValue::from_static("request-456"));

        let result = proxy_request(
            &state,
            &state.backoff,
            &upstream,
            1,
            "test-token",
            "test-client",
            None,
            "POST",
            "messages",
            None,
            &downstream,
            br#"{"model":"test"}"#,
        )
        .await
        .unwrap();
        assert_eq!(result.0, axum::http::StatusCode::OK);

        let headers = received.recv().await.unwrap();
        assert_eq!(headers["x-api-key"], "overridden-upstream-key");
        assert_eq!(headers["anthropic-version"], "2025-01-01");
        assert_eq!(headers["user-agent"], "channel-agent");
        assert_eq!(headers["x-client-request"], "request-456");
        assert_eq!(headers["accept-encoding"], "identity");
        assert!(headers.get("authorization").is_none());

        server.abort();
    }

    #[test]
    fn anthropic_content_delta_counts_as_first_token() {
        let event = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n";
        assert_eq!(extract_first_token_ms(event), Some(0));
    }

    #[test]
    fn responses_custom_tool_call_delta_counts_as_first_token() {
        let event =
            b"data: {\"type\":\"response.custom_tool_call_input.delta\",\"delta\":\"const\"}\n\n";
        assert_eq!(extract_first_token_ms(event), Some(0));
    }
}
