use std::{collections::HashMap, pin::Pin, sync::Arc};

use axum::body::Bytes;
use futures::{Stream, StreamExt};

use super::super::{logging, matcher::BackoffManager};

type UpstreamByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

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

/// Extract token usage from either SSE stream body or JSON body.
///
/// Returns `(prompt_tokens, completion_tokens, total_tokens)`.
pub fn extract_usage(
    raw_body: &[u8],
    content_type: &str,
) -> (Option<i32>, Option<i32>, Option<i32>) {
    let text = match std::str::from_utf8(raw_body) {
        Ok(s) => s,
        Err(_) => return (None, None, None),
    };

    if is_sse_content_type(content_type) || content_type.to_ascii_lowercase().contains("sse") {
        let mut prompt = None;
        let mut completion = None;
        let mut total = None;
        for line in text.lines() {
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data:").map(str::trim_start) {
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

pub(super) fn is_sse_content_type(content_type: &str) -> bool {
    content_type.to_ascii_lowercase().contains("event-stream")
}

fn sse_bytes_line_has_visible_token(line: &[u8]) -> bool {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    std::str::from_utf8(line)
        .ok()
        .is_some_and(sse_line_has_visible_token)
}

fn is_terminal_sse_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "response.completed"
            | "response.failed"
            | "response.incomplete"
            | "response.cancelled"
            | "message_stop"
            | "error"
    )
}

pub(super) fn sse_bytes_line_is_terminal(line: &[u8]) -> bool {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let Ok(line) = std::str::from_utf8(line) else {
        return false;
    };
    let line = line.trim();

    if line
        .strip_prefix("event:")
        .map(str::trim)
        .is_some_and(is_terminal_sse_event_type)
    {
        return true;
    }

    let Some(data) = line.strip_prefix("data:").map(str::trim_start) else {
        return false;
    };
    if data == "[DONE]" {
        return true;
    }

    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .is_some_and(|value| {
            value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .is_some_and(is_terminal_sse_event_type)
        })
}

fn observe_sse_line(
    line: &[u8],
    first_token_ms: &mut Option<i32>,
    terminal_event_pending: &mut bool,
    terminal_event_seen: &mut bool,
    start: std::time::Instant,
) {
    if first_token_ms.is_none() && sse_bytes_line_has_visible_token(line) {
        *first_token_ms = Some(start.elapsed().as_millis() as i32);
    }

    let line_without_cr = line.strip_suffix(b"\r").unwrap_or(line);
    if line_without_cr.is_empty() {
        if *terminal_event_pending {
            *terminal_event_seen = true;
        }
        *terminal_event_pending = false;
    } else if !*terminal_event_seen && sse_bytes_line_is_terminal(line) {
        *terminal_event_pending = true;
    }
}

pub(super) fn observe_sse_chunk(
    chunk: &[u8],
    line_buf: &mut Vec<u8>,
    first_token_ms: &mut Option<i32>,
    terminal_event_pending: &mut bool,
    terminal_event_seen: &mut bool,
    start: std::time::Instant,
) {
    line_buf.extend_from_slice(chunk);
    while let Some(pos) = line_buf.iter().position(|byte| *byte == b'\n') {
        let rest = line_buf.split_off(pos + 1);
        line_buf.truncate(pos);
        observe_sse_line(
            line_buf,
            first_token_ms,
            terminal_event_pending,
            terminal_event_seen,
            start,
        );
        *line_buf = rest;
    }
}

fn observe_sse_end(
    line_buf: &[u8],
    first_token_ms: &mut Option<i32>,
    terminal_event_pending: &mut bool,
    terminal_event_seen: &mut bool,
    start: std::time::Instant,
) {
    observe_sse_line(
        line_buf,
        first_token_ms,
        terminal_event_pending,
        terminal_event_seen,
        start,
    );
    if *terminal_event_pending {
        *terminal_event_seen = true;
        *terminal_event_pending = false;
    }
}

pub(super) fn extract_response_reasoning_effort(
    raw_body: &[u8],
    content_type: &str,
) -> Option<String> {
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

/// Read the full upstream body while recording true TTFT for SSE streams.
pub(super) async fn read_response_body(
    response: reqwest::Response,
    start: std::time::Instant,
) -> Result<(Vec<u8>, Option<i32>), reqwest::Error> {
    let mut body_bytes = Vec::new();
    let mut first_token_ms = None;
    let mut terminal_event_pending = false;
    let mut terminal_event_seen = false;
    let mut line_buf = Vec::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        body_bytes.extend_from_slice(&chunk);

        observe_sse_chunk(
            &chunk,
            &mut line_buf,
            &mut first_token_ms,
            &mut terminal_event_pending,
            &mut terminal_event_seen,
            start,
        );
    }

    // Final partial line (rare, but keep parity with buffered detection).
    observe_sse_end(
        &line_buf,
        &mut first_token_ms,
        &mut terminal_event_pending,
        &mut terminal_event_seen,
        start,
    );

    Ok((body_bytes, first_token_ms))
}

pub(super) struct SseStreamState {
    pub(super) stream: UpstreamByteStream,
    pub(super) body_bytes: Vec<u8>,
    pub(super) line_buf: Vec<u8>,
    pub(super) first_token_ms: Option<i32>,
    pub(super) terminal_event_pending: bool,
    pub(super) terminal_event_seen: bool,
    pub(super) start: std::time::Instant,
    pub(super) upstream_status: u16,
    pub(super) response_headers: HashMap<String, String>,
    pub(super) content_type: String,
    pub(super) log_body_max_bytes: usize,
    pub(super) log_entry: Option<logging::LogEntry>,
    pub(super) pool: sqlx::SqlitePool,
    pub(super) backoff: Arc<BackoffManager>,
    pub(super) upstream_id: i64,
    pub(super) auto_disabled: bool,
}

impl SseStreamState {
    fn record_response_health(&self) {
        if self.auto_disabled || (200..300).contains(&self.upstream_status) {
            self.backoff.record_success(self.upstream_id);
        } else {
            self.backoff.record_failure(self.upstream_id);
        }
    }

    fn finish_log(&mut self, status_code: i32, error: Option<String>) {
        let Some(mut entry) = self.log_entry.take() else {
            return;
        };

        observe_sse_end(
            &self.line_buf,
            &mut self.first_token_ms,
            &mut self.terminal_event_pending,
            &mut self.terminal_event_seen,
            self.start,
        );
        let (prompt_tokens, completion_tokens, total_tokens) =
            extract_usage(&self.body_bytes, &self.content_type);
        let response_reasoning_effort =
            extract_response_reasoning_effort(&self.body_bytes, &self.content_type);
        let response_snapshot = logging::snapshot_response(
            self.upstream_status,
            &self.response_headers,
            Some(&self.body_bytes),
            self.log_body_max_bytes,
        );

        entry.status_code = Some(status_code);
        entry.response_reasoning_effort = response_reasoning_effort;
        entry.prompt_tokens = prompt_tokens;
        entry.completion_tokens = completion_tokens;
        entry.total_tokens = total_tokens;
        entry.first_token_ms = self.first_token_ms;
        entry.duration_ms = Some(self.start.elapsed().as_millis() as i32);
        entry.error = error;
        entry.upstream_response = Some(response_snapshot.clone());
        entry.downstream_response = Some(response_snapshot);
        logging::schedule_log(&self.pool, entry);
    }

    pub(super) fn finish_complete(&mut self) {
        self.record_response_health();
        self.finish_log(self.upstream_status as i32, None);
    }

    pub(super) fn finish_upstream_error(&mut self, error: String) {
        self.backoff.record_failure(self.upstream_id);
        self.finish_log(502, Some(error));
    }
}

impl Drop for SseStreamState {
    fn drop(&mut self) {
        if self.log_entry.is_some() {
            observe_sse_end(
                &self.line_buf,
                &mut self.first_token_ms,
                &mut self.terminal_event_pending,
                &mut self.terminal_event_seen,
                self.start,
            );
            if self.terminal_event_seen {
                self.finish_complete();
            } else {
                self.record_response_health();
                self.finish_log(
                    499,
                    Some("client disconnected before the SSE response completed".to_string()),
                );
            }
        }
    }
}
