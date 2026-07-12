use base64::Engine as _;

// ── Constants ────────────────────────────────────────────────────────────────

// ── Log entry ────────────────────────────────────────────────────────────────

/// Structured log entry.
#[derive(Debug, Default, Clone)]
pub struct LogEntry {
    pub method: String,
    pub path: String,
    pub upstream_id: Option<i64>,
    pub upstream_name: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub stream: bool,
    pub status_code: Option<i32>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub total_tokens: Option<i32>,
    pub first_token_ms: Option<i32>,
    pub duration_ms: Option<i32>,
    pub error: Option<String>,
    pub downstream_request: Option<serde_json::Value>,
    pub upstream_request: Option<serde_json::Value>,
    pub upstream_response: Option<serde_json::Value>,
    pub downstream_response: Option<serde_json::Value>,
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/// Build a request snapshot (with redacted headers, truncated body).
pub fn snapshot_request(
    method: &str,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    body: Option<&[u8]>,
    body_max_bytes: usize,
) -> serde_json::Value {
    let redacted = redact_headers(headers);

    let mut obj = serde_json::json!({
        "method": method,
        "url": url,
        "headers": redacted,
    });

    if let Some(b) = body {
        obj["body"] = truncate_body(b, body_max_bytes);
    }

    obj
}

/// Build a response snapshot (with redacted headers, truncated body).
pub fn snapshot_response(
    status: u16,
    headers: &std::collections::HashMap<String, String>,
    body: Option<&[u8]>,
    body_max_bytes: usize,
) -> serde_json::Value {
    let redacted = redact_headers(headers);
    let mut obj = serde_json::json!({
        "status_code": status,
        "status": status,
        "headers": redacted,
    });

    if let Some(b) = body {
        obj["body"] = truncate_body(b, body_max_bytes);
    }

    obj
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Redact a single header value.
#[allow(dead_code)]
fn redact_header_value(_value: &str) -> String {
    "***REDACTED***".to_string()
}

/// Truncate body into a frontend-friendly object:
/// - text UTF-8: `{ text, byte_length }`
/// - binary / oversized: `{ base64|base64_truncated, encoding, byte_length, truncated? }`
fn redact_headers(
    headers: &std::collections::HashMap<String, String>,
) -> std::collections::HashMap<&str, &str> {
    headers
        .iter()
        .map(|(k, v)| {
            let sensitive = super::client::LOG_REDACTED_HEADERS
                .iter()
                .any(|header| k.eq_ignore_ascii_case(header));
            (k.as_str(), if sensitive { "***REDACTED***" } else { v })
        })
        .collect()
}

fn truncate_body(body: &[u8], budget: usize) -> serde_json::Value {
    if budget == 0 {
        return serde_json::json!({ "cleared": true, "byte_length": body.len() });
    }
    if body.is_empty() {
        return serde_json::json!({
            "text": "",
            "byte_length": 0,
        });
    }

    // Text is cut on a UTF-8 boundary. Binary bytes are sliced before encoding.
    if let Ok(text) = std::str::from_utf8(body) {
        let mut cutoff = body.len().min(budget);
        while cutoff > 0 && !text.is_char_boundary(cutoff) {
            cutoff -= 1;
        }
        let mut snapshot =
            serde_json::json!({ "text": &text[..cutoff], "byte_length": body.len() });
        if cutoff < body.len() {
            snapshot["truncated"] = serde_json::Value::Bool(true);
        }
        return snapshot;
    }

    let slice = &body[..body.len().min(budget)];
    let mut snapshot = serde_json::json!({
        "base64": base64::engine::general_purpose::STANDARD.encode(slice),
        "encoding": "base64",
        "byte_length": body.len(),
    });
    if slice.len() < body.len() {
        snapshot["truncated"] = serde_json::Value::Bool(true);
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{snapshot_request, snapshot_response, truncate_body};

    #[test]
    fn request_and_response_snapshots_redact_mixed_case_sensitive_headers() {
        let headers = HashMap::from([
            ("aUtHoRiZaTiOn".to_string(), "Bearer secret".to_string()),
            ("sEt-CoOkIe".to_string(), "session=secret".to_string()),
            ("X-aCcEsS-tOkEn".to_string(), "access-secret".to_string()),
            (
                "PrOxY-aUtHoRiZaTiOn".to_string(),
                "proxy-secret".to_string(),
            ),
            ("X-Request-Id".to_string(), "request-123".to_string()),
        ]);

        for snapshot in [
            snapshot_request("GET", "https://example.test", &headers, None, 1024),
            snapshot_response(200, &headers, None, 1024),
        ] {
            let snapshot_headers = &snapshot["headers"];
            assert_eq!(snapshot_headers["aUtHoRiZaTiOn"], "***REDACTED***");
            assert_eq!(snapshot_headers["sEt-CoOkIe"], "***REDACTED***");
            assert_eq!(snapshot_headers["X-aCcEsS-tOkEn"], "***REDACTED***");
            assert_eq!(snapshot_headers["PrOxY-aUtHoRiZaTiOn"], "***REDACTED***");
            assert_eq!(snapshot_headers["X-Request-Id"], "request-123");
        }
    }

    #[test]
    fn text_is_truncated_at_utf8_boundary() {
        let body = "aéz".as_bytes();
        let value = truncate_body(body, 2);
        assert_eq!(value["text"], "a");
        assert_eq!(value["byte_length"], 4);
        assert_eq!(value["truncated"], true);
    }

    #[test]
    fn binary_is_sliced_before_base64_encoding() {
        let value = truncate_body(&[0xff, 1, 2, 3], 2);
        assert_eq!(value["base64"], "/wE=");
        assert_eq!(value["byte_length"], 4);
        assert_eq!(value["truncated"], true);
    }

    #[test]
    fn zero_budget_clears_body_only() {
        let value = truncate_body(b"body", 0);
        assert_eq!(
            value,
            serde_json::json!({"cleared": true, "byte_length": 4})
        );
    }
}

// ── Async log writer ────────────────────────────────────────────────────────

/// Spawn a background task to write the log entry so the caller is not blocked
/// and the write cannot be cancelled by the caller's drop.
pub fn schedule_log(pool: &sqlx::SqlitePool, entry: LogEntry) {
    let pool = pool.clone();
    tokio::spawn(async move {
        let _ = insert_log_entry(&pool, entry).await;
    });
}

async fn insert_log_entry(
    pool: &sqlx::SqlitePool,
    entry: LogEntry,
) -> Result<(), crate::error::AppError> {
    let stream_int: i64 = if entry.stream { 1 } else { 0 };

    let downstream_request = entry
        .downstream_request
        .map(|v| v.to_string())
        .unwrap_or_default();
    let upstream_request = entry
        .upstream_request
        .map(|v| v.to_string())
        .unwrap_or_default();
    let upstream_response = entry
        .upstream_response
        .map(|v| v.to_string())
        .unwrap_or_default();
    let downstream_response = entry
        .downstream_response
        .map(|v| v.to_string())
        .unwrap_or_default();

    sqlx::query(
        r#"INSERT INTO request_logs
            (method, path, upstream_id, upstream_name, model,
             reasoning_effort, stream, status_code,
             prompt_tokens, completion_tokens, total_tokens,
             duration_ms, first_token_ms, error,
             downstream_request, upstream_request,
             upstream_response, downstream_response,
             created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, datetime('now'))"#,
    )
    .bind(&entry.method)
    .bind(&entry.path)
    .bind(entry.upstream_id)
    .bind(&entry.upstream_name)
    .bind(&entry.model)
    .bind(&entry.reasoning_effort)
    .bind(stream_int)
    .bind(entry.status_code)
    .bind(entry.prompt_tokens)
    .bind(entry.completion_tokens)
    .bind(entry.total_tokens)
    .bind(entry.duration_ms)
    .bind(entry.first_token_ms)
    .bind(&entry.error)
    .bind(&downstream_request)
    .bind(&upstream_request)
    .bind(&upstream_response)
    .bind(&downstream_response)
    .execute(pool)
    .await?;

    Ok(())
}

// ── Background cleanup ──────────────────────────────────────────────────────

/// Background task that periodically cleans old log bodies and deletes stale logs.
pub async fn cleanup_loop(
    pool: sqlx::SqlitePool,
    runtime_settings: std::sync::Arc<tokio::sync::RwLock<crate::models::settings::RuntimeSettings>>,
) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;

        let settings = runtime_settings.read().await.clone();
        if let Err(e) =
            crate::db::log::clear_old_log_bodies(&pool, settings.log_body_keep_count).await
        {
            tracing::error!("clear_old_log_bodies failed: {:?}", e);
        }

        if let Err(e) = crate::db::log::delete_old_logs(&pool, settings.log_retention_days).await {
            tracing::error!("delete_old_logs failed: {:?}", e);
        }
    }
}
