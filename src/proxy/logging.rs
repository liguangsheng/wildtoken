use std::sync::Arc;

use base64::Engine as _;
use tokio::sync::mpsc;

use crate::state::RuntimeMetrics;

const SLOW_DB_OPERATION_THRESHOLD: std::time::Duration = std::time::Duration::from_secs(1);
const LOG_WRITE_MAX_ATTEMPTS: usize = 5;
const LOG_WRITE_RETRY_BASE_DELAY_MS: u64 = 50;
const LOG_QUEUE_CAPACITY: usize = 4096;
const LOG_WRITE_BATCH_SIZE: usize = 20;
const LOG_WRITE_BATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
const CLEANUP_STARTUP_DELAY: std::time::Duration = std::time::Duration::from_secs(120);

// ── Constants ────────────────────────────────────────────────────────────────

// ── Log entry ────────────────────────────────────────────────────────────────

/// Structured log entry.
#[derive(Debug, Default, Clone)]
pub struct LogEntry {
    pub method: String,
    pub path: String,
    pub downstream_token_id: Option<i64>,
    pub downstream_token_name: Option<String>,
    pub client_type: Option<String>,
    pub upstream_id: Option<i64>,
    pub upstream_name: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub response_reasoning_effort: Option<String>,
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

#[derive(Clone)]
pub struct LogWriter {
    sender: mpsc::Sender<LogEntry>,
    metrics: Arc<RuntimeMetrics>,
}

impl LogWriter {
    fn schedule(&self, entry: LogEntry) {
        self.metrics.record_log_enqueue();
        match self.sender.try_send(entry) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.metrics.record_log_dequeue(1);
                self.metrics.record_log_drop();
                tracing::warn!("request log queue full; dropping request log");
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.metrics.record_log_dequeue(1);
                self.metrics.record_log_drop();
                tracing::error!("request log writer stopped; dropping request log");
            }
        }
    }
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
    snapshot_response_with_body_length(status, headers, body, body.map(<[u8]>::len), body_max_bytes)
}

/// Build a response snapshot from a bounded body prefix while retaining the
/// original response length.
pub fn snapshot_response_with_body_length(
    status: u16,
    headers: &std::collections::HashMap<String, String>,
    body: Option<&[u8]>,
    body_byte_length: Option<usize>,
    body_max_bytes: usize,
) -> serde_json::Value {
    let redacted = redact_headers(headers);
    let mut obj = serde_json::json!({
        "status_code": status,
        "status": status,
        "headers": redacted,
    });

    if let Some(b) = body {
        obj["body"] =
            truncate_body_with_length(b, body_max_bytes, body_byte_length.unwrap_or(b.len()));
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
            let sensitive = super::client::is_sensitive_header_name(k);
            (k.as_str(), if sensitive { "***REDACTED***" } else { v })
        })
        .collect()
}

fn truncate_body(body: &[u8], budget: usize) -> serde_json::Value {
    truncate_body_with_length(body, budget, body.len())
}

fn truncate_body_with_length(
    body: &[u8],
    budget: usize,
    original_byte_length: usize,
) -> serde_json::Value {
    if budget == 0 {
        return serde_json::json!({
            "cleared": true,
            "byte_length": original_byte_length,
        });
    }
    if body.is_empty() {
        return serde_json::json!({
            "text": "",
            "byte_length": original_byte_length,
        });
    }

    // Text is cut on a UTF-8 boundary. Binary bytes are sliced before encoding.
    let slice = &body[..body.len().min(budget)];
    let text_prefix = if body.len() == original_byte_length {
        std::str::from_utf8(body).ok().and_then(|text| {
            let mut cutoff = slice.len();
            while cutoff > 0 && !text.is_char_boundary(cutoff) {
                cutoff -= 1;
            }
            text.get(..cutoff)
        })
    } else {
        match std::str::from_utf8(slice) {
            Ok(text) => Some(text),
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&slice[..error.valid_up_to()]).ok()
            }
            Err(_) => None,
        }
    };
    if let Some(text) = text_prefix {
        let mut snapshot = serde_json::json!({
            "text": text,
            "byte_length": original_byte_length,
        });
        if text.len() < original_byte_length {
            snapshot["truncated"] = serde_json::Value::Bool(true);
        }
        return snapshot;
    }

    let mut snapshot = serde_json::json!({
        "base64": base64::engine::general_purpose::STANDARD.encode(slice),
        "encoding": "base64",
        "byte_length": original_byte_length,
    });
    if slice.len() < original_byte_length {
        snapshot["truncated"] = serde_json::Value::Bool(true);
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc, time::Duration};

    use sqlx::sqlite::SqlitePoolOptions;

    use crate::state::RuntimeMetrics;

    use super::{
        encode_snapshot_pair, insert_log_entry, schedule_log, snapshot_request, snapshot_response,
        snapshot_response_with_body_length, spawn_log_writer, truncate_body, LogEntry,
    };

    #[test]
    fn request_and_response_snapshots_redact_mixed_case_sensitive_headers() {
        let headers = HashMap::from([
            ("aUtHoRiZaTiOn".to_string(), "Bearer secret".to_string()),
            ("sEt-CoOkIe".to_string(), "session=secret".to_string()),
            ("Api-Key".to_string(), "api-secret".to_string()),
            ("X-aCcEsS-tOkEn".to_string(), "access-secret".to_string()),
            ("X-Custom-Secret".to_string(), "custom-secret".to_string()),
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
            assert_eq!(snapshot_headers["Api-Key"], "***REDACTED***");
            assert_eq!(snapshot_headers["X-aCcEsS-tOkEn"], "***REDACTED***");
            assert_eq!(snapshot_headers["X-Custom-Secret"], "***REDACTED***");
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

        let invalid_after_budget = truncate_body(&[b'a', 0xff], 1);
        assert_eq!(invalid_after_budget["base64"], "YQ==");
        assert_eq!(invalid_after_budget["byte_length"], 2);
    }

    #[test]
    fn zero_budget_clears_body_only() {
        let value = truncate_body(b"body", 0);
        assert_eq!(
            value,
            serde_json::json!({"cleared": true, "byte_length": 4})
        );
    }

    #[test]
    fn bounded_response_snapshot_retains_the_original_byte_length() {
        let snapshot = snapshot_response_with_body_length(
            200,
            &HashMap::new(),
            Some("aé".as_bytes()),
            Some(100),
            2,
        );

        assert_eq!(snapshot["body"]["text"], "a");
        assert_eq!(snapshot["body"]["byte_length"], 100);
        assert_eq!(snapshot["body"]["truncated"], true);
    }

    #[test]
    fn snapshot_pair_distinguishes_same_from_explicitly_missing_override() {
        let snapshot = serde_json::json!({"body": {"text": "hello"}});

        let same = encode_snapshot_pair(Some(snapshot.clone()), Some(snapshot.clone()));
        assert_eq!(same.canonical, Some(snapshot.to_string()));
        assert!(!same.is_override);
        assert_eq!(same.override_value, None);

        let missing = encode_snapshot_pair(Some(snapshot), None);
        assert!(missing.is_override);
        assert_eq!(missing.override_value, None);

        let both_missing = encode_snapshot_pair(None, None);
        assert!(!both_missing.is_override);
        assert_eq!(both_missing.canonical, None);
        assert_eq!(both_missing.override_value, None);
    }

    async fn create_request_logs_table(pool: &sqlx::SqlitePool) {
        sqlx::query(
            r#"CREATE TABLE request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                downstream_token_id INTEGER,
                downstream_token_name TEXT,
                client_type TEXT NOT NULL DEFAULT 'unknown',
                upstream_id INTEGER,
                upstream_name TEXT,
                model TEXT,
                reasoning_effort TEXT,
                response_reasoning_effort TEXT,
                stream INTEGER NOT NULL,
                status_code INTEGER,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                duration_ms INTEGER,
                first_token_ms INTEGER,
                error TEXT,
                downstream_request TEXT,
                upstream_request TEXT,
                upstream_response TEXT,
                downstream_response TEXT
            )"#,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn create_request_log_payloads_table(pool: &sqlx::SqlitePool) {
        sqlx::query(
            r#"CREATE TABLE request_log_payloads (
                request_log_id INTEGER PRIMARY KEY REFERENCES request_logs(id) ON DELETE CASCADE,
                request_snapshot TEXT,
                upstream_request_override TEXT,
                upstream_request_is_override INTEGER NOT NULL DEFAULT 0 CHECK (upstream_request_is_override IN (0, 1)),
                response_snapshot TEXT,
                downstream_response_override TEXT,
                downstream_response_is_override INTEGER NOT NULL DEFAULT 0 CHECK (downstream_response_is_override IN (0, 1))
            )"#,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn log_insert_writes_metadata_and_deduplicated_payload_atomically() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        create_request_logs_table(&pool).await;
        create_request_log_payloads_table(&pool).await;

        let request = serde_json::json!({"body": {"text": "request"}});
        let response = serde_json::json!({"body": {"text": "response"}});
        insert_log_entry(
            &pool,
            LogEntry {
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                downstream_request: Some(request.clone()),
                upstream_request: Some(request.clone()),
                upstream_response: Some(response.clone()),
                downstream_response: None,
                ..LogEntry::default()
            },
        )
        .await
        .unwrap();

        let legacy_payloads: (Option<String>, Option<String>, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT downstream_request, upstream_request, upstream_response, downstream_response FROM request_logs WHERE id = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(legacy_payloads, (None, None, None, None));

        let payload: (
            Option<String>,
            Option<String>,
            i64,
            Option<String>,
            Option<String>,
            i64,
        ) = sqlx::query_as(
            r#"SELECT request_snapshot, upstream_request_override,
                      upstream_request_is_override, response_snapshot,
                      downstream_response_override, downstream_response_is_override
               FROM request_log_payloads WHERE request_log_id = 1"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(payload.0, Some(request.to_string()));
        assert_eq!(payload.1, None);
        assert_eq!(payload.2, 0);
        assert_eq!(payload.3, Some(response.to_string()));
        assert_eq!(payload.4, None);
        assert_eq!(payload.5, 1);
    }

    #[tokio::test]
    async fn log_writer_batches_queued_entries_and_updates_metrics() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        create_request_logs_table(&pool).await;
        create_request_log_payloads_table(&pool).await;

        let metrics = Arc::new(RuntimeMetrics::new());
        let writer = spawn_log_writer(pool.clone(), metrics.clone());
        for path in ["/v1/responses", "/v1/chat/completions"] {
            schedule_log(
                &writer,
                LogEntry {
                    method: "POST".to_string(),
                    path: path.to_string(),
                    status_code: Some(200),
                    ..LogEntry::default()
                },
            );
        }

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_logs")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                if count == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let payload_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_log_payloads")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(payload_count, 2);

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.log_queue_depth, 0);
        assert_eq!(snapshot.log_written_total, 2);
        assert_eq!(snapshot.log_write_batches_total, 1);
        assert_eq!(snapshot.log_dropped_total, 0);
        assert_eq!(snapshot.log_write_failures_total, 0);
    }

    #[tokio::test]
    async fn payload_insert_failure_rolls_back_metadata() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        create_request_logs_table(&pool).await;

        let result = insert_log_entry(
            &pool,
            LogEntry {
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                ..LogEntry::default()
            },
        )
        .await;
        assert!(result.is_err());

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_logs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}

// ── Async log writer ────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
struct EncodedSnapshotPair {
    canonical: Option<String>,
    override_value: Option<String>,
    is_override: bool,
}

/// Store one canonical snapshot and only retain the peer when it differs.
///
/// The explicit flag is intentionally independent of `override_value`: a null
/// override with the flag set means that the peer snapshot was absent, while a
/// clear flag means it was identical to the canonical snapshot.
fn encode_snapshot_pair(
    canonical: Option<serde_json::Value>,
    peer: Option<serde_json::Value>,
) -> EncodedSnapshotPair {
    let is_override = canonical != peer;
    let override_value = if is_override {
        peer.map(|value| value.to_string())
    } else {
        None
    };

    EncodedSnapshotPair {
        canonical: canonical.map(|value| value.to_string()),
        override_value,
        is_override,
    }
}

pub fn spawn_log_writer(pool: sqlx::SqlitePool, metrics: Arc<RuntimeMetrics>) -> LogWriter {
    let (sender, receiver) = mpsc::channel(LOG_QUEUE_CAPACITY);
    tokio::spawn(log_writer_loop(pool, metrics.clone(), receiver));
    LogWriter { sender, metrics }
}

/// Queue a log entry for the shared background writer.
pub fn schedule_log(writer: &LogWriter, entry: LogEntry) {
    writer.schedule(entry);
}

async fn log_writer_loop(
    pool: sqlx::SqlitePool,
    metrics: Arc<RuntimeMetrics>,
    mut receiver: mpsc::Receiver<LogEntry>,
) {
    let mut batch = Vec::with_capacity(LOG_WRITE_BATCH_SIZE);

    while let Some(entry) = receiver.recv().await {
        batch.push(entry);

        let flush_delay = tokio::time::sleep(LOG_WRITE_BATCH_INTERVAL);
        tokio::pin!(flush_delay);
        let mut channel_closed = false;

        loop {
            if batch.len() >= LOG_WRITE_BATCH_SIZE {
                break;
            }

            tokio::select! {
                _ = &mut flush_delay => break,
                maybe_entry = receiver.recv() => match maybe_entry {
                    Some(entry) => batch.push(entry),
                    None => {
                        channel_closed = true;
                        break;
                    }
                },
            }
        }

        let entries = std::mem::replace(&mut batch, Vec::with_capacity(LOG_WRITE_BATCH_SIZE));
        let entry_count = entries.len() as u64;
        metrics.record_log_dequeue(entry_count);

        let started_at = std::time::Instant::now();
        match insert_log_batch_with_retry(&pool, &entries).await {
            Ok(()) => metrics.record_log_written(entry_count),
            Err(error) => {
                metrics.record_log_write_failure_count(entry_count);
                tracing::error!(?error, entry_count, "failed to persist request logs");
            }
        }
        if started_at.elapsed() >= SLOW_DB_OPERATION_THRESHOLD {
            metrics.record_slow_db_operation();
        }

        if channel_closed {
            break;
        }
    }
}

async fn insert_log_batch_with_retry(
    pool: &sqlx::SqlitePool,
    entries: &[LogEntry],
) -> Result<(), crate::error::AppError> {
    if entries.is_empty() {
        return Ok(());
    }

    let mut attempt = 0;
    loop {
        match insert_log_batch(pool, entries).await {
            Ok(()) => return Ok(()),
            Err(error) if is_database_locked(&error) && attempt + 1 < LOG_WRITE_MAX_ATTEMPTS => {
                let delay_ms = LOG_WRITE_RETRY_BASE_DELAY_MS * (1_u64 << attempt.min(4));
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

fn is_database_locked(error: &crate::error::AppError) -> bool {
    matches!(
        error,
        crate::error::AppError::Database(sqlx::Error::Database(database_error))
            if database_error.code().as_deref() == Some("5")
                || database_error.message().contains("database is locked")
    )
}

async fn insert_log_entry(
    pool: &sqlx::SqlitePool,
    entry: LogEntry,
) -> Result<(), crate::error::AppError> {
    let entries = [entry];
    insert_log_batch(pool, &entries).await
}

async fn insert_log_batch(
    pool: &sqlx::SqlitePool,
    entries: &[LogEntry],
) -> Result<(), crate::error::AppError> {
    let mut transaction = pool.begin().await?;

    for entry in entries {
        let stream_int: i64 = if entry.stream { 1 } else { 0 };
        let request_payload = encode_snapshot_pair(
            entry.downstream_request.clone(),
            entry.upstream_request.clone(),
        );
        let response_payload = encode_snapshot_pair(
            entry.upstream_response.clone(),
            entry.downstream_response.clone(),
        );

        let result = sqlx::query(
            r#"INSERT INTO request_logs
            (method, path, downstream_token_id, downstream_token_name, client_type,
             upstream_id, upstream_name, model,
             reasoning_effort, response_reasoning_effort, stream, status_code,
             prompt_tokens, completion_tokens, total_tokens,
             duration_ms, first_token_ms, error,
             downstream_request, upstream_request,
             upstream_response, downstream_response,
             created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                NULL, NULL, NULL, NULL, datetime('now'))"#,
        )
        .bind(&entry.method)
        .bind(&entry.path)
        .bind(entry.downstream_token_id)
        .bind(&entry.downstream_token_name)
        .bind(entry.client_type.as_deref().unwrap_or("unknown"))
        .bind(entry.upstream_id)
        .bind(&entry.upstream_name)
        .bind(&entry.model)
        .bind(&entry.reasoning_effort)
        .bind(&entry.response_reasoning_effort)
        .bind(stream_int)
        .bind(entry.status_code)
        .bind(entry.prompt_tokens)
        .bind(entry.completion_tokens)
        .bind(entry.total_tokens)
        .bind(entry.duration_ms)
        .bind(entry.first_token_ms)
        .bind(&entry.error)
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            r#"INSERT INTO request_log_payloads
            (request_log_id, request_snapshot,
             upstream_request_override, upstream_request_is_override,
             response_snapshot,
             downstream_response_override, downstream_response_is_override)
        VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(result.last_insert_rowid())
        .bind(&request_payload.canonical)
        .bind(&request_payload.override_value)
        .bind(if request_payload.is_override {
            1_i64
        } else {
            0
        })
        .bind(&response_payload.canonical)
        .bind(&response_payload.override_value)
        .bind(if response_payload.is_override {
            1_i64
        } else {
            0
        })
        .execute(&mut *transaction)
        .await?;
    }

    transaction.commit().await?;

    Ok(())
}

// ── Background cleanup ──────────────────────────────────────────────────────

/// Background task that periodically cleans old log bodies and deletes stale logs.
pub async fn cleanup_loop(
    pool: sqlx::SqlitePool,
    runtime_settings: std::sync::Arc<tokio::sync::RwLock<crate::models::settings::RuntimeSettings>>,
    metrics: Arc<RuntimeMetrics>,
) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
    tokio::time::sleep(CLEANUP_STARTUP_DELAY).await;

    loop {
        interval.tick().await;

        let settings = runtime_settings.read().await.clone();
        let cleanup_started_at = std::time::Instant::now();
        let mut cleanup_succeeded = true;
        metrics.begin_cleanup();
        if let Err(e) = crate::db::log::clear_old_log_bodies_with_metrics(
            &pool,
            settings.log_body_keep_count,
            &metrics,
        )
        .await
        {
            cleanup_succeeded = false;
            tracing::error!("clear_old_log_bodies failed: {:?}", e);
        }

        let delete_started_at = std::time::Instant::now();
        if let Err(e) = crate::db::log::delete_old_logs(&pool, settings.log_retention_days).await {
            cleanup_succeeded = false;
            tracing::error!("delete_old_logs failed: {:?}", e);
        }
        if delete_started_at.elapsed() >= SLOW_DB_OPERATION_THRESHOLD {
            metrics.record_slow_db_operation();
        }
        metrics.finish_cleanup(cleanup_succeeded, cleanup_started_at.elapsed());
    }
}
