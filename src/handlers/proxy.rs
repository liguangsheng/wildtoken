use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode},
    response::Response,
};
use serde_json::json;
use std::time::Instant;

use crate::error::AppError;
use crate::middleware::auth::DownstreamAuth;
use crate::proxy::{client, logging, matcher};
use crate::state::AppState;

const HOP_BY_HOP_RESPONSE_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "content-encoding",
    "content-length",
];

fn parse_model_from_body(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        })
}

fn get_upstream_selector(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(val) = headers
        .get("x-wildtoken-upstream")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(val.to_string());
    }

    query.and_then(|q| {
        q.split('&').find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let val = parts.next().unwrap_or("");
            if key == "upstream" && !val.is_empty() {
                Some(val.to_string())
            } else {
                None
            }
        })
    })
}

fn protocol_error_response(
    status: StatusCode,
    path: &str,
    message: &str,
    error_type: &str,
) -> Response {
    let body = if path.trim_matches('/') == "messages" {
        json!({
            "type": "error",
            "error": {"type": error_type, "message": message}
        })
    } else {
        json!({
            "error": {
                "message": message,
                "type": error_type,
                "code": null
            }
        })
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("internal error"))
                .unwrap()
        })
}

struct ClientAbortLogGuard {
    log_writer: logging::LogWriter,
    started_at: Instant,
    entry: Option<logging::LogEntry>,
}

impl ClientAbortLogGuard {
    fn new(log_writer: logging::LogWriter, method: &str, path: &str) -> Self {
        Self {
            log_writer,
            started_at: Instant::now(),
            entry: Some(logging::LogEntry {
                method: method.to_string(),
                path: path.to_string(),
                status_code: Some(499),
                error: Some("client disconnected before proxy completed".to_string()),
                ..Default::default()
            }),
        }
    }

    fn set_model(&mut self, model: Option<&str>) {
        if let Some(entry) = &mut self.entry {
            entry.model = model.map(str::to_string);
        }
    }

    fn set_downstream_token(&mut self, token_id: i64, token_name: &str) {
        if let Some(entry) = &mut self.entry {
            entry.downstream_token_id = Some(token_id);
            entry.downstream_token_name = Some(token_name.to_string());
        }
    }

    fn set_client_type(&mut self, client_type: &str) {
        if let Some(entry) = &mut self.entry {
            entry.client_type = Some(client_type.to_string());
        }
    }

    fn set_upstream(&mut self, upstream_id: i64, upstream_name: &str, forward_model: Option<&str>) {
        if let Some(entry) = &mut self.entry {
            entry.upstream_id = Some(upstream_id);
            entry.upstream_name = Some(upstream_name.to_string());
            entry.model = forward_model
                .map(str::to_string)
                .or_else(|| entry.model.clone());
        }
    }

    fn set_request_snapshots(
        &mut self,
        downstream_request: serde_json::Value,
        upstream_request: serde_json::Value,
    ) {
        if let Some(entry) = &mut self.entry {
            entry.downstream_request = Some(downstream_request);
            entry.upstream_request = Some(upstream_request);
        }
    }

    fn disarm(&mut self) {
        self.entry = None;
    }

    fn log_and_disarm(&mut self, status_code: i32, error: String) {
        if let Some(mut entry) = self.entry.take() {
            entry.status_code = Some(status_code);
            entry.error = Some(error);
            entry.duration_ms = Some(self.started_at.elapsed().as_millis() as i32);
            logging::schedule_log(&self.log_writer, entry);
        }
    }
}

impl Drop for ClientAbortLogGuard {
    fn drop(&mut self) {
        if let Some(mut entry) = self.entry.take() {
            entry.duration_ms = Some(self.started_at.elapsed().as_millis() as i32);
            logging::schedule_log(&self.log_writer, entry);
        }
    }
}

/// Main proxy handler – forwards OpenAI-compatible requests to upstream providers.
pub async fn proxy_handler(
    State(state): State<AppState>,
    auth: DownstreamAuth,
    req: Request<Body>,
) -> Result<Response, AppError> {
    let method = req.method().to_string();
    let headers = req.headers().clone();
    let uri = req.uri().clone();

    // Path after /v1/ — e.g. "chat/completions"
    let full_path = uri.path();
    let path = full_path
        .strip_prefix("/v1/")
        .or_else(|| full_path.strip_prefix("/v1"))
        .unwrap_or(full_path)
        .trim_start_matches('/');
    let query = uri.query();

    let mut abort_log = ClientAbortLogGuard::new(state.log_writer.clone(), &method, path);
    abort_log.set_downstream_token(auth.token_id, &auth.token_name);
    abort_log.set_client_type(&auth.client_type);

    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(body) => body,
        Err(e) => {
            let err_msg = e.to_string();
            let is_limit_error = err_msg.to_lowercase().contains("length limit");
            abort_log.log_and_disarm(
                if is_limit_error { 400 } else { 499 },
                if is_limit_error {
                    format!("failed to read downstream request body: {err_msg}")
                } else {
                    format!("client disconnected while reading downstream request body: {err_msg}")
                },
            );
            return Err(AppError::BadRequest(format!("failed to read body: {e}")));
        }
    };

    let model = parse_model_from_body(&body_bytes);
    abort_log.set_model(model.as_deref());
    let selector = get_upstream_selector(&headers, query);

    let selected = match matcher::select_upstream(
        &state.db,
        &state.backoff,
        selector.as_deref(),
        model.as_deref(),
    )
    .await
    {
        Ok(selected) => selected,
        Err(error) => {
            abort_log.disarm();
            return Err(error);
        }
    };

    let Some((upstream, forward_model)) = selected else {
        abort_log.disarm();
        return Ok(protocol_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            path,
            "No enabled upstream is configured",
            "upstream_not_configured",
        ));
    };

    abort_log.set_upstream(upstream.id, &upstream.name, forward_model.as_deref());
    let log_body_max_bytes = state.runtime_settings.read().await.log_body_max_bytes as usize;
    let upstream_url = client::build_upstream_url(&upstream, path, query);
    let fwd_headers = match client::build_forward_headers(&headers, &upstream, path) {
        Ok(headers) => headers,
        Err(error) => {
            abort_log.log_and_disarm(502, error.to_string());
            return Err(error);
        }
    };
    let downstream_snap = logging::snapshot_request(
        &method,
        &upstream_url,
        &fwd_headers,
        Some(&body_bytes),
        log_body_max_bytes,
    );
    let upstream_body = client::prepare_upstream_body(&body_bytes, forward_model.as_deref(), path);
    let upstream_snap = logging::snapshot_request(
        &method,
        &upstream_url,
        &fwd_headers,
        Some(&upstream_body),
        log_body_max_bytes,
    );
    abort_log.set_request_snapshots(downstream_snap, upstream_snap);

    let proxied = client::proxy_request(
        &state,
        &state.backoff,
        &upstream,
        auth.token_id,
        &auth.token_name,
        &auth.client_type,
        forward_model.as_deref(),
        &method,
        path,
        query,
        &headers,
        &body_bytes,
    )
    .await;
    abort_log.disarm();
    let client::ProxyResponse {
        status,
        headers: resp_headers,
        body,
    } = proxied?;

    let mut response = Response::new(body);
    *response.status_mut() = status;

    for (name, value) in &resp_headers {
        let name_lower = name.to_lowercase();
        if HOP_BY_HOP_RESPONSE_HEADERS.contains(&name_lower.as_str()) {
            continue;
        }
        if let (Ok(hname), Ok(hval)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            response.headers_mut().insert(hname, hval);
        }
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::proxy_handler;
    use crate::{
        config::Settings,
        models::settings::{AdminCredential, RuntimeSettings},
        proxy::matcher::BackoffManager,
        state::{init_db, AdminAuthCache, AppState, RuntimeMetrics},
    };
    use axum::{
        body::{Body, Bytes},
        http::{header, StatusCode},
        response::Response,
        routing::{any, post},
        Router,
    };
    use futures::{FutureExt, StreamExt};
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{
        convert::Infallible,
        sync::{atomic::AtomicI64, Arc},
        time::{Duration, Instant},
    };
    use tokio::sync::{Notify, RwLock};

    const FIRST_EVENT: &[u8] = b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n";
    const FINAL_EVENT_HEADER: &[u8] = b"event: response.completed\n";
    const FINAL_EVENT_DATA: &[u8] = b"data: {\"type\":\"response.completed\",\"response\":{\"reasoning\":{\"effort\":\"high\"},\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"total_tokens\":18}}}\n\n";

    #[tokio::test]
    async fn sse_is_streamed_end_to_end_and_logged_after_completion() {
        let release_final_event = Arc::new(Notify::new());
        let keep_upstream_open = Arc::new(Notify::new());
        let upstream_release = Arc::clone(&release_final_event);
        let upstream_keep_open = Arc::clone(&keep_upstream_open);
        let upstream_app = Router::new().route(
            "/v1/responses",
            post(move || {
                let release = Arc::clone(&upstream_release);
                let keep_open = Arc::clone(&upstream_keep_open);
                async move {
                    let stream = futures::stream::unfold(
                        (0_u8, release, keep_open),
                        |(step, release, keep_open)| async move {
                            match step {
                                0 => Some((
                                    Ok::<Bytes, Infallible>(Bytes::from_static(FIRST_EVENT)),
                                    (1, release, keep_open),
                                )),
                                1 => {
                                    release.notified().await;
                                    Some((
                                        Ok(Bytes::from_static(FINAL_EVENT_HEADER)),
                                        (2, release, keep_open),
                                    ))
                                }
                                2 => Some((
                                    Ok(Bytes::from_static(FINAL_EVENT_DATA)),
                                    (3, release, keep_open),
                                )),
                                _ => {
                                    keep_open.notified().await;
                                    None
                                }
                            }
                        },
                    );
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
                        .header(header::CACHE_CONTROL, "no-cache")
                        .body(Body::from_stream(stream))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let upstream_server =
            tokio::spawn(async move { axum::serve(listener, upstream_app).await.unwrap() });

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO api_tokens (name, token) VALUES ('stream-test', 'downstream-secret')",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO upstreams
                (name, base_url, model_names, enabled, timeout_seconds)
               VALUES ('sse-upstream', ?, '["stream-model"]', 1, 10)"#,
        )
        .bind(format!("http://{upstream_address}"))
        .execute(&db)
        .await
        .unwrap();

        let mut runtime_settings = RuntimeSettings::default();
        runtime_settings.log_body_max_bytes = FIRST_EVENT.len() as i64;
        let runtime_metrics = Arc::new(RuntimeMetrics::new());
        let log_stats = Arc::new(crate::db::log_stats::LogStatsCache::empty());
        let log_writer = crate::proxy::logging::spawn_log_writer(
            db.clone(),
            runtime_metrics.clone(),
            log_stats.clone(),
            Settings::default().logging.log_queue_capacity,
        );
        let state = AppState {
            db: db.clone(),
            http_client: reqwest::Client::new(),
            settings: Settings::default(),
            backoff: Arc::new(BackoffManager::new()),
            runtime_settings: Arc::new(RwLock::new(runtime_settings)),
            admin_credential: Arc::new(RwLock::new(AdminCredential {
                credential_hash: "test".into(),
                credential_version: 1,
            })),
            admin_credential_version: Arc::new(AtomicI64::new(1)),
            admin_auth_cache: Arc::new(AdminAuthCache::new()),
            runtime_metrics: runtime_metrics.clone(),
            log_writer,
            log_stats,
            started_at: Instant::now(),
        };
        let proxy_app = Router::new()
            .route("/v1/{*path}", any(proxy_handler))
            .with_state(state);
        let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let proxy_server =
            tokio::spawn(async move { axum::serve(proxy_listener, proxy_app).await.unwrap() });

        let response = tokio::time::timeout(
            Duration::from_secs(1),
            reqwest::Client::new()
                .post(format!("http://{proxy_address}/v1/responses"))
                .bearer_auth("downstream-secret")
                .header(header::CONTENT_TYPE, "application/json")
                .body(r#"{"model":"stream-model","stream":true,"input":[]}"#)
                .send(),
        )
        .await
        .expect("proxy waited for the complete upstream SSE body")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream; charset=utf-8"
        );

        let mut body = response.bytes_stream();
        let mut first_received = Vec::new();
        while first_received.len() < FIRST_EVENT.len() {
            let chunk = tokio::time::timeout(Duration::from_secs(1), body.next())
                .await
                .expect("first SSE event was not forwarded")
                .expect("SSE body ended before the first event")
                .unwrap();
            first_received.extend_from_slice(&chunk);
        }
        assert_eq!(first_received, FIRST_EVENT);
        assert!(body.next().now_or_never().is_none());

        release_final_event.notify_one();
        let mut received = first_received;
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(1), body.next())
            .await
            .expect("SSE body did not finish after the final event")
        {
            received.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(
            &received[FIRST_EVENT.len()..],
            [FINAL_EVENT_HEADER, FINAL_EVENT_DATA].concat()
        );

        let log = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let row = sqlx::query_as::<
                    _,
                    (
                        i64,
                        i64,
                        Option<i32>,
                        Option<i32>,
                        Option<i32>,
                        Option<i32>,
                        Option<i32>,
                        Option<String>,
                        Option<String>,
                    ),
                >(
                    r#"SELECT id, stream, status_code, prompt_tokens, completion_tokens,
                              total_tokens, first_token_ms, response_reasoning_effort, error
                       FROM request_logs"#,
                )
                .fetch_optional(&db)
                .await
                .unwrap();
                if let Some(row) = row {
                    break row;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("completed SSE request was not logged");

        assert_eq!(log.1, 1);
        assert_eq!(log.2, Some(200));
        assert_eq!((log.3, log.4, log.5), (Some(11), Some(7), Some(18)));
        assert!(log.6.is_some());
        assert_eq!(log.7.as_deref(), Some("high"));
        assert_eq!(log.8, None);

        let response_snapshot: String = sqlx::query_scalar(
            "SELECT response_snapshot FROM request_log_payloads WHERE request_log_id = ?",
        )
        .bind(log.0)
        .fetch_one(&db)
        .await
        .unwrap();
        let response_snapshot: serde_json::Value =
            serde_json::from_str(&response_snapshot).unwrap();
        let logged_body = response_snapshot["body"]["text"].as_str().unwrap();
        assert_eq!(logged_body.as_bytes(), FIRST_EVENT);
        assert_eq!(response_snapshot["body"]["byte_length"], received.len());
        assert_eq!(response_snapshot["body"]["truncated"], true);
        assert!(!logged_body.contains("\"total_tokens\":18"));
        let metrics = runtime_metrics.snapshot();
        assert_eq!(metrics.active_sse_streams, 0);
        assert_eq!(metrics.sse_completed_total, 1);
        assert_eq!(metrics.sse_client_disconnects_total, 0);

        proxy_server.abort();
        upstream_server.abort();
    }
}
