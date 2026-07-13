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
    pool: sqlx::SqlitePool,
    started_at: Instant,
    entry: Option<logging::LogEntry>,
}

impl ClientAbortLogGuard {
    fn new(pool: &sqlx::SqlitePool, method: &str, path: &str) -> Self {
        Self {
            pool: pool.clone(),
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
            logging::schedule_log(&self.pool, entry);
        }
    }
}

impl Drop for ClientAbortLogGuard {
    fn drop(&mut self) {
        if let Some(mut entry) = self.entry.take() {
            entry.duration_ms = Some(self.started_at.elapsed().as_millis() as i32);
            logging::schedule_log(&self.pool, entry);
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

    let mut abort_log = ClientAbortLogGuard::new(&state.db, &method, path);
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
    let (status, resp_headers, body) = proxied?;

    let mut response = Response::new(Body::from(body));
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
