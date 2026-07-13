use std::{collections::HashMap, pin::Pin, sync::Arc};

use axum::body::Bytes;
use futures::{Stream, StreamExt};

use super::super::{logging, matcher::BackoffManager};
use crate::state::RuntimeMetrics;

type UpstreamByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;
type TokenUsage = (Option<i32>, Option<i32>, Option<i32>);

const MAX_SSE_EVENT_BYTES: usize = 4 * 1024 * 1024;

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

fn usage_from_value(value: &serde_json::Value) -> Option<TokenUsage> {
    value
        .get("usage")
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("usage"))
        })
        .map(extract_usage_values)
}

fn response_reasoning_effort_from_value(value: &serde_json::Value) -> Option<String> {
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
                    if let Some(usage) = usage_from_value(&obj) {
                        (prompt, completion, total) = usage;
                    }
                }
            }
        }
        return (prompt, completion, total);
    }

    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(usage) = usage_from_value(&obj) {
            return usage;
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

#[derive(Default)]
struct SseObservation {
    line_buf: Vec<u8>,
    line_overflow: bool,
    first_token_ms: Option<i32>,
    terminal_event_pending: bool,
    terminal_event_seen: bool,
    usage: TokenUsage,
    response_reasoning_effort: Option<String>,
}

impl SseObservation {
    fn observe_line(&mut self, line: &[u8], start: std::time::Instant) {
        if self.first_token_ms.is_none() && sse_bytes_line_has_visible_token(line) {
            self.first_token_ms = Some(start.elapsed().as_millis() as i32);
        }

        let line_without_cr = line.strip_suffix(b"\r").unwrap_or(line);
        if line_without_cr.is_empty() {
            if self.terminal_event_pending {
                self.terminal_event_seen = true;
            }
            self.terminal_event_pending = false;
            return;
        }

        if !self.terminal_event_seen && sse_bytes_line_is_terminal(line) {
            self.terminal_event_pending = true;
        }

        let Ok(line) = std::str::from_utf8(line_without_cr) else {
            return;
        };
        let Some(data) = line.trim().strip_prefix("data:").map(str::trim_start) else {
            return;
        };
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        if let Some(usage) = usage_from_value(&value) {
            self.usage = usage;
        }
        if self.response_reasoning_effort.is_none() {
            self.response_reasoning_effort = response_reasoning_effort_from_value(&value);
        }
    }

    fn observe_chunk(&mut self, chunk: &[u8], start: std::time::Instant) {
        for segment in chunk.split_inclusive(|byte| *byte == b'\n') {
            let complete_line = segment.last() == Some(&b'\n');
            let content = if complete_line {
                &segment[..segment.len() - 1]
            } else {
                segment
            };

            if !self.line_overflow {
                if self.line_buf.len().saturating_add(content.len()) <= MAX_SSE_EVENT_BYTES {
                    self.line_buf.extend_from_slice(content);
                } else {
                    self.line_buf.clear();
                    self.line_overflow = true;
                }
            }

            if complete_line {
                if !self.line_overflow {
                    let line = std::mem::take(&mut self.line_buf);
                    self.observe_line(&line, start);
                } else {
                    self.line_buf.clear();
                }
                self.line_overflow = false;
            }
        }
    }

    fn finish(&mut self, start: std::time::Instant) {
        if !self.line_overflow {
            let line = std::mem::take(&mut self.line_buf);
            self.observe_line(&line, start);
        } else {
            self.line_buf.clear();
            self.line_overflow = false;
        }
        if self.terminal_event_pending {
            self.terminal_event_seen = true;
            self.terminal_event_pending = false;
        }
    }
}

pub(super) fn extract_response_reasoning_effort(
    raw_body: &[u8],
    content_type: &str,
) -> Option<String> {
    if content_type.contains("event-stream") || raw_body.starts_with(b"data:") {
        for line in std::str::from_utf8(raw_body).ok()?.lines() {
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                if let Some(effort) = response_reasoning_effort_from_value(&value) {
                    return Some(effort);
                }
            }
        }
        None
    } else {
        serde_json::from_slice::<serde_json::Value>(raw_body)
            .ok()
            .and_then(|value| response_reasoning_effort_from_value(&value))
    }
}

/// Read the full upstream body while recording true TTFT for SSE streams.
pub(super) async fn read_response_body(
    response: reqwest::Response,
    start: std::time::Instant,
) -> Result<(Vec<u8>, Option<i32>), reqwest::Error> {
    let mut body_bytes = Vec::new();
    let mut observation = SseObservation::default();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        body_bytes.extend_from_slice(&chunk);

        observation.observe_chunk(&chunk, start);
    }

    // Final partial line (rare, but keep parity with buffered detection).
    observation.finish(start);

    Ok((body_bytes, observation.first_token_ms))
}

struct ResponseCapture {
    bytes: Vec<u8>,
    byte_length: usize,
    limit: usize,
}

impl ResponseCapture {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            byte_length: 0,
            limit,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.byte_length = self.byte_length.saturating_add(chunk.len());
        let remaining = self.limit.saturating_sub(self.bytes.len());
        self.bytes
            .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
}

pub(super) struct SseStreamState {
    pub(super) stream: UpstreamByteStream,
    capture: ResponseCapture,
    observation: SseObservation,
    pub(super) start: std::time::Instant,
    pub(super) upstream_status: u16,
    pub(super) response_headers: HashMap<String, String>,
    pub(super) log_body_max_bytes: usize,
    pub(super) log_entry: Option<logging::LogEntry>,
    pub(super) pool: sqlx::SqlitePool,
    pub(super) backoff: Arc<BackoffManager>,
    pub(super) metrics: Arc<RuntimeMetrics>,
    pub(super) upstream_id: i64,
    pub(super) auto_disabled: bool,
}

impl SseStreamState {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        stream: UpstreamByteStream,
        start: std::time::Instant,
        upstream_status: u16,
        response_headers: HashMap<String, String>,
        log_body_max_bytes: usize,
        log_entry: logging::LogEntry,
        pool: sqlx::SqlitePool,
        backoff: Arc<BackoffManager>,
        metrics: Arc<RuntimeMetrics>,
        upstream_id: i64,
        auto_disabled: bool,
    ) -> Self {
        metrics.start_sse_stream();
        Self {
            stream,
            capture: ResponseCapture::new(log_body_max_bytes),
            observation: SseObservation::default(),
            start,
            upstream_status,
            response_headers,
            log_body_max_bytes,
            log_entry: Some(log_entry),
            pool,
            backoff,
            metrics,
            upstream_id,
            auto_disabled,
        }
    }

    pub(super) fn observe_chunk(&mut self, chunk: &[u8]) {
        self.capture.push(chunk);
        self.observation.observe_chunk(chunk, self.start);
    }

    pub(super) fn terminal_event_seen(&self) -> bool {
        self.observation.terminal_event_seen
    }

    fn record_response_health(&self) {
        if self.auto_disabled || (200..300).contains(&self.upstream_status) {
            self.backoff.record_success(self.upstream_id);
        } else {
            self.backoff.record_failure(self.upstream_id);
        }
    }

    fn finish_log(&mut self, status_code: i32, error: Option<String>) -> bool {
        let Some(mut entry) = self.log_entry.take() else {
            return false;
        };

        self.observation.finish(self.start);
        let (prompt_tokens, completion_tokens, total_tokens) = self.observation.usage;
        let response_snapshot = logging::snapshot_response_with_body_length(
            self.upstream_status,
            &self.response_headers,
            Some(&self.capture.bytes),
            Some(self.capture.byte_length),
            self.log_body_max_bytes,
        );

        entry.status_code = Some(status_code);
        entry.response_reasoning_effort = self.observation.response_reasoning_effort.clone();
        entry.prompt_tokens = prompt_tokens;
        entry.completion_tokens = completion_tokens;
        entry.total_tokens = total_tokens;
        entry.first_token_ms = self.observation.first_token_ms;
        entry.duration_ms = Some(self.start.elapsed().as_millis() as i32);
        entry.error = error;
        entry.upstream_response = Some(response_snapshot.clone());
        entry.downstream_response = Some(response_snapshot);
        logging::schedule_log(&self.pool, self.metrics.clone(), entry);
        true
    }

    pub(super) fn finish_complete(&mut self) {
        self.record_response_health();
        if self.finish_log(self.upstream_status as i32, None) {
            self.metrics.record_sse_complete();
        }
    }

    pub(super) fn finish_upstream_error(&mut self, error: String) {
        self.backoff.record_failure(self.upstream_id);
        if self.finish_log(502, Some(error)) {
            self.metrics.record_sse_upstream_error();
        }
    }
}

impl Drop for SseStreamState {
    fn drop(&mut self) {
        if self.log_entry.is_some() {
            self.observation.finish(self.start);
            if self.observation.terminal_event_seen {
                self.finish_complete();
            } else {
                self.record_response_health();
                if self.finish_log(
                    499,
                    Some("client disconnected before the SSE response completed".to_string()),
                ) {
                    self.metrics.record_sse_client_disconnect();
                }
            }
        }
        self.metrics.finish_sse_stream();
    }
}

#[cfg(test)]
mod tests {
    use super::{ResponseCapture, SseObservation, MAX_SSE_EVENT_BYTES};

    #[test]
    fn response_capture_retains_only_the_configured_prefix() {
        let mut capture = ResponseCapture::new(5);
        capture.push(b"abc");
        capture.push(b"defgh");

        assert_eq!(capture.bytes, b"abcde");
        assert_eq!(capture.byte_length, 8);
    }

    #[test]
    fn observation_extracts_terminal_metadata_after_the_snapshot_limit() {
        let mut capture = ResponseCapture::new(8);
        let mut observation = SseObservation::default();
        let start = std::time::Instant::now();
        let first = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n";
        let terminal = b"data: {\"type\":\"response.completed\",\"response\":{\"reasoning\":{\"effort\":\"high\"},\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"total_tokens\":18}}}\n\n";

        let response = [first.as_slice(), terminal.as_slice()].concat();
        for chunk in response.chunks(3) {
            capture.push(chunk);
            observation.observe_chunk(chunk, start);
        }

        assert_eq!(capture.bytes.len(), 8);
        assert_eq!(capture.byte_length, first.len() + terminal.len());
        assert_eq!(observation.usage, (Some(11), Some(7), Some(18)));
        assert_eq!(
            observation.response_reasoning_effort.as_deref(),
            Some("high")
        );
        assert!(observation.first_token_ms.is_some());
        assert!(observation.terminal_event_seen);
    }

    #[test]
    fn observation_discards_and_recovers_from_an_oversized_event_line() {
        let mut observation = SseObservation::default();
        let start = std::time::Instant::now();

        observation.observe_chunk(&vec![b'x'; MAX_SSE_EVENT_BYTES + 1], start);
        assert!(observation.line_overflow);
        assert!(observation.line_buf.is_empty());

        observation.observe_chunk(b"\ndata: [DONE]\n\n", start);
        assert!(!observation.line_overflow);
        assert!(observation.line_buf.is_empty());
        assert!(observation.terminal_event_seen);
    }
}
