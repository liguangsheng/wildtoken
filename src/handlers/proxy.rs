use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode},
    response::{Json, Response},
};
use serde_json::json;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use crate::error::AppError;
use crate::middleware::auth::DownstreamAuth;
use crate::models::upstream::UpstreamRow;
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

    let runtime_settings = state.runtime_settings.read().await.clone();
    let auto_weight_policy = matcher::AutoWeightPolicy::from(&runtime_settings);
    let direct_selection = if selector.is_some() {
        match matcher::select_upstream(
            &state.db,
            &state.auto_weight,
            auto_weight_policy,
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
        }
    } else {
        None
    };

    let max_retries = runtime_settings.max_retries as usize;
    let mut previous_upstream_id = None;
    let mut last_failure: Option<Result<client::ProxyResponse, AppError>> = None;
    let mut attempt_index = 0_usize;

    let proxied = loop {
        let selected = if selector.is_some() {
            direct_selection.clone()
        } else {
            match matcher::select_upstream(
                &state.db,
                &state.auto_weight,
                auto_weight_policy,
                None,
                model.as_deref(),
            )
            .await
            {
                Ok(selected) => selected,
                Err(error) => {
                    abort_log.disarm();
                    return Err(error);
                }
            }
        };

        let Some((upstream, forward_model)) = selected else {
            if let Some(failure) = last_failure.take() {
                break failure;
            }
            abort_log.disarm();
            return Ok(protocol_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                path,
                "No enabled upstream is configured",
                "upstream_not_configured",
            ));
        };

        if attempt_index > 0
            && previous_upstream_id == Some(upstream.id)
            && runtime_settings.same_upstream_retry_interval_ms > 0
        {
            tokio::time::sleep(Duration::from_millis(
                runtime_settings.same_upstream_retry_interval_ms as u64,
            ))
            .await;
        }

        // Once a new attempt has a route, the previous buffered failure is no
        // longer needed. Its log was already scheduled by `proxy_request`.
        drop(last_failure.take());
        abort_log.set_upstream(upstream.id, &upstream.name, forward_model.as_deref());
        let log_body_max_bytes = runtime_settings.log_body_max_bytes as usize;
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
        let upstream_body =
            client::prepare_upstream_body(&body_bytes, forward_model.as_deref(), path);
        let upstream_snap = logging::snapshot_request(
            &method,
            &upstream_url,
            &fwd_headers,
            Some(&upstream_body),
            log_body_max_bytes,
        );
        abort_log.set_request_snapshots(downstream_snap, upstream_snap);

        let result = client::proxy_request(
            &state,
            auto_weight_policy,
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
        let failed = match &result {
            Ok(response) => !response.status.is_success(),
            Err(_) => true,
        };
        if !failed || attempt_index >= max_retries {
            break result;
        }

        previous_upstream_id = Some(upstream.id);
        last_failure = Some(result);
        attempt_index += 1;
    };
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

/// Collect unique model ids from enabled upstream configs (names + mapping keys).
fn aggregate_model_ids(upstreams: &[UpstreamRow]) -> Vec<String> {
    let mut ids = BTreeSet::new();

    for upstream in upstreams {
        if let Ok(names) = serde_json::from_str::<Vec<String>>(&upstream.model_names) {
            for name in names {
                let name = name.trim();
                if !name.is_empty() {
                    ids.insert(name.to_string());
                }
            }
        }

        if let Ok(mappings) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
            &upstream.model_mappings,
        ) {
            for key in mappings.keys() {
                let key = key.trim();
                if !key.is_empty() {
                    ids.insert(key.to_string());
                }
            }
        }
        // model_prefixes intentionally ignored — prefixes cannot expand to concrete ids.
    }

    ids.into_iter().collect()
}

fn openai_models_list_response(ids: Vec<String>) -> serde_json::Value {
    let data: Vec<serde_json::Value> = ids
        .into_iter()
        .map(|id| {
            json!({
                "id": id,
                "object": "model",
                "created": 0,
                "owned_by": "wildtoken"
            })
        })
        .collect();

    json!({
        "object": "list",
        "data": data
    })
}

async fn resolve_enabled_upstream_for_models(
    pool: &sqlx::SqlitePool,
    selector: &str,
) -> Result<UpstreamRow, AppError> {
    if let Ok(id) = selector.parse::<i64>() {
        if let Some(upstream) = crate::db::upstream::get_upstream(pool, id).await? {
            if upstream.enabled == 1 {
                return Ok(upstream);
            }
        }
    }

    if let Some(upstream) = crate::db::upstream::get_upstream_by_name(pool, selector).await? {
        if upstream.enabled == 1 {
            return Ok(upstream);
        }
    }

    Err(AppError::NotFound(format!(
        "upstream not found or disabled: {selector}"
    )))
}

/// GET /v1/models — aggregate model list from enabled upstream configs.
///
/// Optional channel filter via `X-WildToken-Upstream` or `?upstream=` (name or id).
/// Filtered responses skip the global models-list cache.
/// `model_prefixes` never expand into concrete ids.
pub async fn list_models_handler(
    State(state): State<AppState>,
    _auth: DownstreamAuth,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Result<Json<serde_json::Value>, AppError> {
    let selector = get_upstream_selector(&headers, uri.query());

    if let Some(selector) = selector {
        let upstream = resolve_enabled_upstream_for_models(&state.db, &selector).await?;
        let ids = aggregate_model_ids(std::slice::from_ref(&upstream));
        return Ok(Json(openai_models_list_response(ids)));
    }

    if let Some(cached) = state.models_list_cache.get().await {
        return Ok(Json(cached));
    }

    let upstreams = crate::db::upstream::list_enabled_upstreams(&state.db).await?;
    let ids = aggregate_model_ids(&upstreams);
    let response = openai_models_list_response(ids);

    // Double-check: another concurrent miss may have already filled the cache.
    if let Some(cached) = state.models_list_cache.get().await {
        return Ok(Json(cached));
    }
    state.models_list_cache.set(response.clone()).await;
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_model_ids, list_models_handler, openai_models_list_response, proxy_handler,
    };
    use crate::models::upstream::UpstreamRow;
    use crate::{
        config::Settings,
        models::settings::{AdminCredential, RuntimeSettings},
        proxy::matcher::AutoWeightManager,
        state::{init_db, AdminAuthCache, AppState, RuntimeMetrics},
    };
    use axum::{
        body::{to_bytes, Body, Bytes},
        http::{header, Request, StatusCode},
        response::Response,
        routing::{any, post},
        Router,
    };
    use futures::{FutureExt, StreamExt};
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{
        convert::Infallible,
        sync::{
            atomic::{AtomicI64, AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    use tokio::sync::{Notify, RwLock};
    use tower::ServiceExt;

    const FIRST_EVENT: &[u8] = b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n";
    const FINAL_EVENT_HEADER: &[u8] = b"event: response.completed\n";
    const FINAL_EVENT_DATA: &[u8] = b"data: {\"type\":\"response.completed\",\"response\":{\"reasoning\":{\"effort\":\"high\"},\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"total_tokens\":18,\"input_tokens_details\":{\"cached_tokens\":3},\"cache_creation_input_tokens\":5,\"output_tokens_details\":{\"reasoning_tokens\":2}}}}\n\n";

    async fn test_proxy_state(db: sqlx::SqlitePool, runtime_settings: RuntimeSettings) -> AppState {
        let runtime_metrics = Arc::new(RuntimeMetrics::new());
        let log_stats = Arc::new(crate::db::log_stats::LogStatsCache::empty());
        let log_writer = crate::proxy::logging::spawn_log_writer(
            db.clone(),
            runtime_metrics.clone(),
            log_stats.clone(),
            Settings::default().logging.log_queue_capacity,
        );
        AppState {
            db,
            http_client: reqwest::Client::new(),
            settings: Settings::default(),
            auto_weight: Arc::new(AutoWeightManager::new()),
            runtime_settings: Arc::new(RwLock::new(runtime_settings)),
            admin_credential: Arc::new(RwLock::new(AdminCredential {
                credential_hash: "test".into(),
                credential_version: 1,
            })),
            admin_credential_version: Arc::new(AtomicI64::new(1)),
            admin_auth_cache: Arc::new(AdminAuthCache::new()),
            runtime_metrics,
            log_writer,
            log_stats,
            models_list_cache: Arc::new(crate::state::ModelsListCache::new()),
            started_at: Instant::now(),
        }
    }

    async fn proxy_test_database() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO api_tokens (name, token) VALUES ('retry-test', 'downstream-secret')",
        )
        .execute(&db)
        .await
        .unwrap();
        db
    }

    fn proxy_request_for(model: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .header(header::AUTHORIZATION, "Bearer downstream-secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(format!(r#"{{"model":"{model}","input":[]}}"#)))
            .unwrap()
    }

    #[tokio::test]
    async fn explicit_channel_retry_waits_even_after_health_reaches_zero() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let upstream_attempts = Arc::clone(&attempts);
        let upstream_app = Router::new().route(
            "/v1/responses",
            post(move || {
                let attempts = Arc::clone(&upstream_attempts);
                async move {
                    if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        (StatusCode::BAD_GATEWAY, "first failure")
                    } else {
                        (StatusCode::OK, "second success")
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let upstream_server =
            tokio::spawn(async move { axum::serve(listener, upstream_app).await.unwrap() });

        let db = proxy_test_database().await;
        sqlx::query(
            r#"INSERT INTO upstreams
               (name, base_url, model_names, priority, weight, auto_weight_enabled)
               VALUES ('single', ?, '["retry-model"]', 999, 100, 1)"#,
        )
        .bind(format!("http://{upstream_address}"))
        .execute(&db)
        .await
        .unwrap();
        let mut runtime_settings = RuntimeSettings::default();
        runtime_settings.max_retries = 1;
        runtime_settings.same_upstream_retry_interval_ms = 120;
        runtime_settings.auto_weight_failure_penalty = 100;
        let state = test_proxy_state(db, runtime_settings.clone()).await;
        let app = Router::new()
            .route("/v1/{*path}", any(proxy_handler))
            .with_state(state.clone());
        let mut request = proxy_request_for("retry-model");
        request
            .headers_mut()
            .insert("x-wildtoken-upstream", "single".parse().unwrap());

        let started_at = Instant::now();
        let response = app.oneshot(request).await.unwrap();
        let elapsed = started_at.elapsed();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(elapsed >= Duration::from_millis(100));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(
            state
                .auto_weight
                .snapshot(
                    1,
                    100,
                    true,
                    crate::proxy::matcher::AutoWeightPolicy::from(&runtime_settings),
                )
                .score,
            5
        );
        upstream_server.abort();
    }

    #[tokio::test]
    async fn retrying_on_a_different_channel_does_not_wait() {
        let primary_attempts = Arc::new(AtomicUsize::new(0));
        let fallback_attempts = Arc::new(AtomicUsize::new(0));
        let primary_counter = Arc::clone(&primary_attempts);
        let fallback_counter = Arc::clone(&fallback_attempts);
        let upstream_app = Router::new().route(
            "/v1/responses",
            post(move |headers: axum::http::HeaderMap| {
                let primary = Arc::clone(&primary_counter);
                let fallback = Arc::clone(&fallback_counter);
                async move {
                    if headers
                        .get("x-channel")
                        .and_then(|value| value.to_str().ok())
                        == Some("primary")
                    {
                        primary.fetch_add(1, Ordering::SeqCst);
                        Response::builder()
                            .status(StatusCode::SERVICE_UNAVAILABLE)
                            .header(header::CONTENT_TYPE, "text/event-stream")
                            .body(Body::from("data: upstream failed\n\n"))
                            .unwrap()
                    } else {
                        fallback.fetch_add(1, Ordering::SeqCst);
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(r#"{"source":"fallback"}"#))
                            .unwrap()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let upstream_server =
            tokio::spawn(async move { axum::serve(listener, upstream_app).await.unwrap() });

        let db = proxy_test_database().await;
        let base_url = format!("http://{upstream_address}");
        sqlx::query(
            r#"INSERT INTO upstreams
               (name, base_url, model_names, priority, weight, extra_headers)
               VALUES
               ('primary', ?, '["retry-model"]', 999, 100, '{"X-Channel":"primary"}'),
               ('fallback', ?, '["retry-model"]', 998, 100, '{"X-Channel":"fallback"}')"#,
        )
        .bind(&base_url)
        .bind(&base_url)
        .execute(&db)
        .await
        .unwrap();
        let mut runtime_settings = RuntimeSettings::default();
        runtime_settings.max_retries = 1;
        runtime_settings.same_upstream_retry_interval_ms = 1_000;
        runtime_settings.auto_weight_failure_penalty = 100;
        let state = test_proxy_state(db, runtime_settings).await;
        let app = Router::new()
            .route("/v1/{*path}", any(proxy_handler))
            .with_state(state);

        let response = tokio::time::timeout(
            Duration::from_millis(700),
            app.oneshot(proxy_request_for("retry-model")),
        )
        .await
        .expect("a retry on a different channel waited unnecessarily")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body, r#"{"source":"fallback"}"#);
        assert_eq!(primary_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(fallback_attempts.load(Ordering::SeqCst), 1);
        upstream_server.abort();
    }

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
            auto_weight: Arc::new(AutoWeightManager::new()),
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
            models_list_cache: Arc::new(crate::state::ModelsListCache::new()),
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
                        Option<i32>,
                        Option<i32>,
                        Option<i32>,
                        Option<String>,
                        Option<String>,
                    ),
                >(
                    r#"SELECT id, stream, status_code, prompt_tokens, completion_tokens,
                              total_tokens, prompt_cached_tokens, cache_creation_tokens,
                              completion_reasoning_tokens, first_token_ms,
                              response_reasoning_effort, error
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
        assert_eq!((log.6, log.7, log.8), (Some(3), Some(5), Some(2)));
        assert!(log.9.is_some());
        assert_eq!(log.10.as_deref(), Some("high"));
        assert_eq!(log.11, None);

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

    fn sample_upstream(
        model_names: &str,
        model_prefixes: &str,
        model_mappings: &str,
    ) -> UpstreamRow {
        UpstreamRow {
            id: 1,
            name: "test".into(),
            base_url: "http://example.com".into(),
            api_key: None,
            model_names: model_names.into(),
            model_prefixes: model_prefixes.into(),
            model_mappings: model_mappings.into(),
            priority: 0,
            weight: 1,
            auto_weight_enabled: 0,
            enabled: 1,
            extra_headers: "{}".into(),
            timeout_seconds: 30.0,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn list_models_empty_upstreams() {
        let ids = aggregate_model_ids(&[]);
        assert!(ids.is_empty());
        let resp = openai_models_list_response(ids);
        assert_eq!(resp["object"], "list");
        assert_eq!(resp["data"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn list_models_from_model_names() {
        let ups = vec![sample_upstream(r#"["gpt-4","gpt-3.5-turbo"]"#, "[]", "{}")];
        let ids = aggregate_model_ids(&ups);
        assert_eq!(ids, vec!["gpt-3.5-turbo".to_string(), "gpt-4".to_string()]);
    }

    #[test]
    fn list_models_mappings_keys_only() {
        let ups = vec![sample_upstream(
            "[]",
            "[]",
            r#"{"gpt-4":"provider-gpt-4","claude":"anthropic-claude"}"#,
        )];
        let ids = aggregate_model_ids(&ups);
        assert_eq!(ids, vec!["claude".to_string(), "gpt-4".to_string()]);
        assert!(!ids.iter().any(|id| id == "provider-gpt-4"));
        assert!(!ids.iter().any(|id| id == "anthropic-claude"));
    }

    #[test]
    fn list_models_dedupes_overlapping() {
        let ups = vec![
            sample_upstream(r#"["gpt-4","gpt-3.5"]"#, "[]", r#"{"gpt-4":"mapped"}"#),
            sample_upstream(r#"["gpt-4","o1"]"#, "[]", "{}"),
        ];
        let ids = aggregate_model_ids(&ups);
        assert_eq!(
            ids,
            vec!["gpt-3.5".to_string(), "gpt-4".to_string(), "o1".to_string()]
        );
    }

    #[test]
    fn list_models_ignores_prefixes() {
        let ups = vec![sample_upstream("[]", r#"["gpt-","claude-"]"#, "{}")];
        let ids = aggregate_model_ids(&ups);
        assert!(ids.is_empty());
    }

    #[test]
    fn list_models_skips_invalid_json_fields() {
        let ups = vec![sample_upstream(
            "not-json",
            "[]",
            r#"{"valid-key":"value"}"#,
        )];
        let ids = aggregate_model_ids(&ups);
        assert_eq!(ids, vec!["valid-key".to_string()]);
    }

    #[test]
    fn list_models_response_shape() {
        let resp = openai_models_list_response(vec!["gpt-4".into()]);
        assert_eq!(resp["object"], "list");
        let data = resp["data"].as_array().unwrap();
        assert_eq!(data.len(), 1);
        assert_eq!(data[0]["id"], "gpt-4");
        assert_eq!(data[0]["object"], "model");
        assert_eq!(data[0]["created"], 0);
        assert_eq!(data[0]["owned_by"], "wildtoken");
    }

    #[tokio::test]
    async fn list_models_handler_uses_cache_until_invalidated() {
        let db = proxy_test_database().await;
        sqlx::query(
            r#"INSERT INTO upstreams
               (name, base_url, model_names, model_prefixes, model_mappings, priority, weight, enabled)
               VALUES ('a', 'http://example.com', '["gpt-4"]', '[]', '{}', 100, 100, 1)"#,
        )
        .execute(&db)
        .await
        .unwrap();

        let state = test_proxy_state(db.clone(), RuntimeSettings::default()).await;
        let app = Router::new()
            .route("/v1/models", axum::routing::get(list_models_handler))
            .with_state(state.clone());

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first_body = to_bytes(first.into_body(), 1024 * 1024).await.unwrap();
        let first_json: serde_json::Value = serde_json::from_slice(&first_body).unwrap();
        assert_eq!(first_json["data"][0]["id"], "gpt-4");

        // Bypass admin handlers so only the cache can keep the old list.
        sqlx::query(r#"UPDATE upstreams SET model_names = '["gpt-4","gpt-5"]' WHERE name = 'a'"#)
            .execute(&db)
            .await
            .unwrap();

        let cached = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let cached_body = to_bytes(cached.into_body(), 1024 * 1024).await.unwrap();
        let cached_json: serde_json::Value = serde_json::from_slice(&cached_body).unwrap();
        assert_eq!(cached_json["data"].as_array().unwrap().len(), 1);

        state.models_list_cache.invalidate().await;

        let refreshed = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let refreshed_body = to_bytes(refreshed.into_body(), 1024 * 1024).await.unwrap();
        let refreshed_json: serde_json::Value = serde_json::from_slice(&refreshed_body).unwrap();
        let ids: Vec<&str> = refreshed_json["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["gpt-4", "gpt-5"]);
    }

    #[tokio::test]
    async fn list_models_handler_filters_by_upstream_query_and_header() {
        let db = proxy_test_database().await;
        sqlx::query(
            r#"INSERT INTO upstreams
               (name, base_url, model_names, model_prefixes, model_mappings, priority, weight, enabled)
               VALUES
               ('alpha', 'http://example.com', '["alpha-1"]', '[]', '{}', 100, 100, 1),
               ('beta', 'http://example.com', '["beta-1"]', '[]', '{}', 100, 100, 1),
               ('off', 'http://example.com', '["off-1"]', '[]', '{}', 100, 100, 0)"#,
        )
        .execute(&db)
        .await
        .unwrap();

        let state = test_proxy_state(db, RuntimeSettings::default()).await;
        let app = Router::new()
            .route("/v1/models", axum::routing::get(list_models_handler))
            .with_state(state);

        let by_name = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/models?upstream=beta")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(by_name.status(), StatusCode::OK);
        let by_name_body = to_bytes(by_name.into_body(), 1024 * 1024).await.unwrap();
        let by_name_json: serde_json::Value = serde_json::from_slice(&by_name_body).unwrap();
        assert_eq!(by_name_json["data"].as_array().unwrap().len(), 1);
        assert_eq!(by_name_json["data"][0]["id"], "beta-1");

        let by_header = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .header("x-wildtoken-upstream", "alpha")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let by_header_body = to_bytes(by_header.into_body(), 1024 * 1024).await.unwrap();
        let by_header_json: serde_json::Value = serde_json::from_slice(&by_header_body).unwrap();
        assert_eq!(by_header_json["data"][0]["id"], "alpha-1");

        let missing = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/models?upstream=missing")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let disabled = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models?upstream=off")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(disabled.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_models_filtered_request_does_not_use_or_fill_global_cache() {
        let db = proxy_test_database().await;
        sqlx::query(
            r#"INSERT INTO upstreams
               (name, base_url, model_names, model_prefixes, model_mappings, priority, weight, enabled)
               VALUES
               ('alpha', 'http://example.com', '["alpha-1"]', '[]', '{}', 100, 100, 1),
               ('beta', 'http://example.com', '["beta-1"]', '[]', '{}', 100, 100, 1)"#,
        )
        .execute(&db)
        .await
        .unwrap();

        let state = test_proxy_state(db, RuntimeSettings::default()).await;
        let app = Router::new()
            .route("/v1/models", axum::routing::get(list_models_handler))
            .with_state(state.clone());

        let filtered = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/models?upstream=alpha")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(filtered.status(), StatusCode::OK);
        assert!(state.models_list_cache.get().await.is_none());

        let full = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .header(header::AUTHORIZATION, "Bearer downstream-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let full_body = to_bytes(full.into_body(), 1024 * 1024).await.unwrap();
        let full_json: serde_json::Value = serde_json::from_slice(&full_body).unwrap();
        assert_eq!(full_json["data"].as_array().unwrap().len(), 2);
        assert!(state.models_list_cache.get().await.is_some());
    }
}
