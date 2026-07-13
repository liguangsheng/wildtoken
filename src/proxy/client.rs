use crate::error::AppError;
use crate::models::upstream::UpstreamRow;
use crate::state::AppState;
use axum::body::{Body, Bytes};
use futures::StreamExt;
use std::{collections::HashMap, sync::Arc};

use super::logging;
use super::matcher::{self, BackoffManager};

mod headers;
mod sse;

pub(crate) use headers::{
    apply_header_overrides, is_sensitive_header_name, validate_header_overrides,
};
pub use headers::{build_forward_headers, HOP_BY_HOP_HEADERS};
#[cfg(test)]
use sse::sse_bytes_line_is_terminal;
pub use sse::{extract_first_token_ms, extract_usage};
use sse::{
    extract_response_reasoning_effort, is_sse_content_type, read_response_body, SseStreamState,
};

pub struct ProxyResponse {
    pub status: axum::http::StatusCode,
    pub headers: HashMap<String, String>,
    pub body: Body,
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

// ── Main proxy function ─────────────────────────────────────────────────────

/// Proxy a request to the upstream, streaming SSE bodies as they arrive.
pub async fn proxy_request(
    state: &AppState,
    backoff: &Arc<BackoffManager>,
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
) -> Result<ProxyResponse, AppError> {
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
            logging::schedule_log(&state.db, state.runtime_metrics.clone(), log_entry);

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

    let status_u16 = status.as_u16();
    if is_sse_content_type(&content_type) {
        let auto_disabled = matcher::AUTO_DISABLE_STATUS_CODES.contains(&status_u16);
        if auto_disabled {
            let _ = crate::db::upstream::set_upstream_enabled(&state.db, upstream.id, false).await;
        }

        let log_entry = logging::LogEntry {
            method: method.to_string(),
            path: path.to_string(),
            downstream_token_id: Some(downstream_token_id),
            downstream_token_name: Some(downstream_token_name.to_string()),
            client_type: Some(client_type.to_string()),
            upstream_id: Some(upstream.id),
            upstream_name: Some(upstream.name.clone()),
            model: forward_model.map(str::to_string),
            reasoning_effort,
            stream: true,
            status_code: Some(status_u16 as i32),
            downstream_request: Some(downstream_snap),
            upstream_request: Some(upstream_snap),
            ..Default::default()
        };
        let stream_state = SseStreamState::new(
            Box::pin(response.bytes_stream()),
            start,
            status_u16,
            resp_headers.clone(),
            log_body_max_bytes,
            log_entry,
            state.db.clone(),
            Arc::clone(backoff),
            state.runtime_metrics.clone(),
            upstream.id,
            auto_disabled,
        );
        let body_stream = futures::stream::unfold(stream_state, |mut stream_state| async move {
            if stream_state.log_entry.is_none() {
                return None;
            }

            match stream_state.stream.next().await {
                Some(Ok(chunk)) => {
                    stream_state.observe_chunk(&chunk);
                    if stream_state.terminal_event_seen() {
                        stream_state.finish_complete();
                    }
                    Some((Ok::<Bytes, std::io::Error>(chunk), stream_state))
                }
                Some(Err(error)) => {
                    let message = error.to_string();
                    stream_state.finish_upstream_error(message.clone());
                    Some((Err(std::io::Error::other(message)), stream_state))
                }
                None => {
                    stream_state.finish_complete();
                    None
                }
            }
        });

        return Ok(ProxyResponse {
            status,
            headers: resp_headers,
            body: Body::from_stream(body_stream),
        });
    }

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
            logging::schedule_log(&state.db, state.runtime_metrics.clone(), log_entry);
            return Err(AppError::UpstreamError(e.to_string()));
        }
    };

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
    logging::schedule_log(&state.db, state.runtime_metrics.clone(), log_entry);

    Ok(ProxyResponse {
        status,
        headers: resp_headers,
        body: Body::from(body_bytes),
    })
}

#[cfg(test)]
mod tests;
