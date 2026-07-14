use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};

use crate::db::{settings as settings_db, upstream as upstream_db};
use crate::error::AppError;
use crate::middleware::auth::AdminAuth;
use crate::models::request_log::{ModelFetchIn, ModelListOut, TestRequest};
use crate::models::settings::ModelTestRequest;
use crate::models::upstream::{
    UpstreamDetailOut, UpstreamEnabledIn, UpstreamIn, UpstreamOut, UpstreamPriorityIn,
    UpstreamUpdate,
};
use crate::proxy::client::{
    apply_header_overrides, is_sensitive_header_name, validate_header_overrides,
};
use crate::proxy::matcher::AutoWeightPolicy;
use crate::state::AppState;

// ── URL helper (aligned with Python build_upstream_url) ───────────────────────

fn build_url(base_url: &str, path: &str, query: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let suffix = path.trim_start_matches('/');
    let target = if base.ends_with("/v1") {
        format!("{base}/{suffix}")
    } else {
        format!("{base}/v1/{suffix}")
    };
    if query.is_empty() {
        target
    } else {
        format!("{target}?{query}")
    }
}

fn apply_runtime_health(state: &AppState, policy: AutoWeightPolicy, item: &mut UpstreamOut) {
    let health = state
        .auto_weight
        .snapshot(item.id, item.weight, item.auto_weight_enabled, policy);
    item.runtime_health_score = health.score;
    item.effective_weight = health.effective_weight;
    item.health_recovery_remaining_seconds = health.recovery_remaining_seconds;
}

fn extract_model_test_reply(payload: &serde_json::Value) -> Option<String> {
    if let Some(content) = payload
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
    {
        return Some(content.to_owned());
    }
    let output = payload.get("output")?.as_array()?;
    let text = output
        .iter()
        .filter_map(|item| item.get("content")?.as_array())
        .flat_map(|content| content.iter())
        .filter_map(|item| item.get("text")?.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn codex_model_test_headers() -> HashMap<String, String> {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let request_id = URL_SAFE_NO_PAD.encode(bytes);
    let headers = HashMap::from([
        ("accept".into(), "text/event-stream".into()),
        ("accept-encoding".into(), "identity".into()),
        ("content-type".into(), "application/json".into()),
        ("originator".into(), "codex-tui".into()),
        ("session-id".into(), request_id.clone()),
        ("thread-id".into(), request_id.clone()),
        ("user-agent".into(), "codex-tui/0.144.1 (Fedora 44.0.0; x86_64) xterm-256color (codex-tui; 0.144.1)".into()),
        ("x-client-request-id".into(), request_id.clone()),
        ("x-codex-beta-features".into(), "memories,remote_compaction_v2".into()),
        ("x-codex-turn-metadata".into(), serde_json::json!({"installation_id": request_id, "session_id": request_id, "thread_id": request_id, "turn_id": request_id, "window_id": request_id}).to_string()),
        ("x-codex-window-id".into(), format!("{request_id}:0")),
    ]);
    headers
}

fn extract_model_ids(payload: &serde_json::Value) -> Vec<String> {
    let source = if let Some(data) = payload.get("data").and_then(|v| v.as_array()) {
        data.clone()
    } else if let Some(models) = payload.get("models").and_then(|v| v.as_array()) {
        models.clone()
    } else if let Some(arr) = payload.as_array() {
        arr.clone()
    } else {
        return Vec::new();
    };

    let mut seen = std::collections::HashSet::new();
    let mut model_ids = Vec::new();
    for item in source {
        let model_id = if let Some(s) = item.as_str() {
            s.trim().to_string()
        } else if let Some(s) = item.get("id").and_then(|v| v.as_str()) {
            s.trim().to_string()
        } else {
            continue;
        };
        if !model_id.is_empty() && seen.insert(model_id.clone()) {
            model_ids.push(model_id);
        }
    }
    model_ids
}

async fn fetch_models_for_target(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    extra_headers: &HashMap<String, String>,
    timeout_seconds: f64,
) -> Result<ModelListOut, AppError> {
    validate_overrides(extra_headers)?;
    let target_url = build_url(base_url, "models", "");
    let mut req = client
        .get(&target_url)
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds.max(1.0)));

    let request_headers = build_channel_request_headers(HashMap::new(), api_key, extra_headers);
    for (k, v) in &request_headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let response = req
        .send()
        .await
        .map_err(|e| AppError::UpstreamError(format!("upstream request failed: {e}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::UpstreamError(format!("upstream body read failed: {e}")))?;

    if !status.is_success() {
        let preview: String = text.chars().take(300).collect();
        return Err(AppError::UpstreamError(format!(
            "upstream returned HTTP {status}: {preview}"
        )));
    }

    let payload: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| AppError::UpstreamError("upstream did not return JSON".into()))?;

    let models = extract_model_ids(&payload);
    if models.is_empty() {
        return Err(AppError::UpstreamError(
            "upstream response did not contain model ids".into(),
        ));
    }
    Ok(ModelListOut { models })
}

fn parse_extra_headers(s: &str) -> Result<HashMap<String, String>, AppError> {
    serde_json::from_str(s).map_err(|error| {
        AppError::BadRequest(format!("channel Header override JSON is invalid: {error}"))
    })
}

/// Build headers for channel-related admin requests using the same precedence
/// as normal proxy traffic: generated channel credentials first, configured
/// Header overrides last.
fn build_channel_request_headers(
    mut headers: HashMap<String, String>,
    api_key: Option<&str>,
    overrides: &HashMap<String, String>,
) -> HashMap<String, String> {
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        headers.insert("authorization".into(), format!("Bearer {key}"));
    }
    // Admin-side probes have no downstream request context. Client Header
    // placeholders are therefore skipped while static overrides still apply.
    apply_header_overrides(&mut headers, overrides, None);
    headers
}

fn build_json_channel_request(
    client: &reqwest::Client,
    url: &str,
    payload: &serde_json::Value,
    timeout: std::time::Duration,
    headers: &HashMap<String, String>,
) -> Result<reqwest::RequestBuilder, AppError> {
    let mut request = client
        .post(url)
        .body(serde_json::to_vec(payload)?)
        .timeout(timeout);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    Ok(request)
}

fn validate_overrides(overrides: &HashMap<String, String>) -> Result<(), AppError> {
    validate_header_overrides(overrides).map_err(AppError::BadRequest)
}

fn redact_header_preview(headers: &HashMap<String, String>) -> HashMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let sensitive = is_sensitive_header_name(name);
            (
                name.clone(),
                if sensitive {
                    "[redacted]".into()
                } else {
                    value.clone()
                },
            )
        })
        .collect()
}

// ── Upstreams ────────────────────────────────────────────────────────────────

pub async fn admin_list_upstreams(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<Vec<crate::models::upstream::UpstreamOut>>, AppError> {
    let mut items = upstream_db::list_upstreams(&state.db).await?;
    let runtime_settings = state.runtime_settings.read().await.clone();
    let policy = AutoWeightPolicy::from(&runtime_settings);
    for item in &mut items {
        apply_runtime_health(&state, policy, item);
    }
    Ok(Json(items))
}

pub async fn admin_get_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<UpstreamDetailOut>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;

    let runtime_settings = state.runtime_settings.read().await.clone();
    let health = state.auto_weight.snapshot(
        row.id,
        row.weight,
        row.auto_weight_enabled == 1,
        AutoWeightPolicy::from(&runtime_settings),
    );
    let model_names: Vec<String> = serde_json::from_str(&row.model_names).unwrap_or_default();
    let model_prefixes: Vec<String> = serde_json::from_str(&row.model_prefixes).unwrap_or_default();
    let model_mappings: HashMap<String, String> =
        serde_json::from_str(&row.model_mappings).unwrap_or_default();
    let extra_headers = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&extra_headers)?;

    Ok(Json(UpstreamDetailOut {
        id: row.id,
        name: row.name,
        base_url: row.base_url,
        api_key: row.api_key.clone(),
        api_key_set: row.api_key.is_some(),
        model_names,
        model_prefixes,
        model_mappings,
        priority: row.priority,
        weight: row.weight,
        auto_weight_enabled: row.auto_weight_enabled == 1,
        enabled: row.enabled == 1,
        extra_headers,
        timeout_seconds: row.timeout_seconds,
        created_at: row.created_at,
        updated_at: row.updated_at,
        runtime_health_score: health.score,
        effective_weight: health.effective_weight,
        health_recovery_remaining_seconds: health.recovery_remaining_seconds,
    }))
}

pub async fn admin_create_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<UpstreamIn>,
) -> Result<Response, AppError> {
    input
        .validate()
        .map_err(|error| AppError::BadRequest(error.into()))?;
    validate_overrides(&input.extra_headers)?;
    match upstream_db::create_upstream(
        &state.db,
        &input,
        state.settings.upstream.default_timeout_seconds,
    )
    .await
    {
        Ok(mut out) => {
            let runtime_settings = state.runtime_settings.read().await.clone();
            apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
            Ok((StatusCode::CREATED, Json(out)).into_response())
        }
        Err(AppError::Database(e)) if e.to_string().contains("UNIQUE") => {
            Err(AppError::BadRequest("upstream name already exists".into()))
        }
        Err(e) => Err(e),
    }
}

pub async fn admin_update_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(input): Json<UpstreamUpdate>,
) -> Result<Json<crate::models::upstream::UpstreamOut>, AppError> {
    input
        .base
        .validate()
        .map_err(|error| AppError::BadRequest(error.into()))?;
    validate_overrides(&input.base.extra_headers)?;
    let Some(existing) = upstream_db::get_upstream(&state.db, id).await? else {
        return Err(AppError::NotFound("upstream not found".into()));
    };
    let mut out = upstream_db::update_upstream(
        &state.db,
        id,
        &input,
        state.settings.upstream.default_timeout_seconds,
    )
    .await?;
    if existing.auto_weight_enabled != i64::from(input.base.auto_weight_enabled)
        || (existing.enabled == 0 && input.base.enabled)
    {
        state.auto_weight.reset(id);
    }
    let runtime_settings = state.runtime_settings.read().await.clone();
    apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
    Ok(Json(out))
}

pub async fn admin_set_upstream_enabled(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(body): Json<UpstreamEnabledIn>,
) -> Result<Json<crate::models::upstream::UpstreamOut>, AppError> {
    if upstream_db::get_upstream(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("upstream not found".into()));
    }
    let mut out = upstream_db::set_upstream_enabled(&state.db, id, body.enabled).await?;
    if body.enabled {
        state.auto_weight.reset(id);
    }
    let runtime_settings = state.runtime_settings.read().await.clone();
    apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
    Ok(Json(out))
}

pub async fn admin_set_upstream_priority(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(body): Json<UpstreamPriorityIn>,
) -> Result<Json<crate::models::upstream::UpstreamOut>, AppError> {
    if upstream_db::get_upstream(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("upstream not found".into()));
    }
    let mut out = upstream_db::set_upstream_priority(&state.db, id, body.priority).await?;
    let runtime_settings = state.runtime_settings.read().await.clone();
    apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
    Ok(Json(out))
}

pub async fn admin_delete_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = upstream_db::delete_upstream(&state.db, id).await?;
    if deleted {
        state.auto_weight.reset(id);
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("upstream not found".into()))
    }
}

pub async fn admin_test_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(data): Json<TestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;

    let target_path = if data.path.starts_with("/v1/") {
        data.path.trim_start_matches("/v1/").to_string()
    } else {
        data.path.trim_start_matches('/').to_string()
    };
    let target_url = build_url(&row.base_url, &target_path, "");

    let mut req = state
        .http_client
        .get(&target_url)
        .timeout(std::time::Duration::from_secs_f64(
            row.timeout_seconds.max(1.0),
        ));

    let overrides = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&overrides)?;
    let request_headers =
        build_channel_request_headers(HashMap::new(), row.api_key.as_deref(), &overrides);
    for (k, v) in &request_headers {
        req = req.header(k.as_str(), v.as_str());
    }

    match req.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let text = response.text().await.unwrap_or_default();
            let preview: String = text.chars().take(1000).collect();
            Ok(Json(serde_json::json!({
                "ok": status < 400,
                "status_code": status,
                "content_type": content_type,
                "preview": preview,
            })))
        }
        Err(e) => Ok(Json(serde_json::json!({
            "ok": false,
            "status_code": null,
            "message": e.to_string(),
        }))),
    }
}

pub async fn admin_test_upstream_model(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(data): Json<ModelTestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    data.validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;
    let template = settings_db::list_model_test_templates(&state.db)
        .await?
        .into_iter()
        .find(|item| item.id == data.wrapper_id)
        .ok_or_else(|| AppError::NotFound("model test wrapper not found".into()))?;
    let prompt_template = settings_db::list_model_test_prompt_templates(&state.db)
        .await?
        .into_iter()
        .find(|item| item.id == data.prompt_template_id)
        .ok_or_else(|| AppError::NotFound("model test prompt template not found".into()))?;
    let prompt = if data.prompt.trim().is_empty() {
        prompt_template.prompt
    } else {
        data.prompt.trim().to_owned()
    };
    let target_path = match template.request_kind.as_str() {
        "responses" => "responses",
        "chat_completions" => "chat/completions",
        _ => {
            return Err(AppError::BadRequest(
                "unsupported template request kind".into(),
            ))
        }
    };
    let target_url = build_url(&row.base_url, target_path, "");
    let payload = match template.request_kind.as_str() {
        "responses" => serde_json::json!({
            "model": data.model.trim(),
            "input": prompt,
            "max_output_tokens": 1000,
        }),
        "chat_completions" => serde_json::json!({
            "model": data.model.trim(),
            "messages": [{ "role": "user", "content": prompt }],
            "max_tokens": 1000,
        }),
        _ => unreachable!(),
    };
    let default_headers = if template.name == "Codex" {
        codex_model_test_headers()
    } else {
        HashMap::from([("content-type".into(), "application/json".into())])
    };
    let overrides = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&overrides)?;
    let request_headers =
        build_channel_request_headers(default_headers, row.api_key.as_deref(), &overrides);
    // Use an explicit body instead of RequestBuilder::json(). The latter adds
    // Content-Type before our loop, and RequestBuilder::header() would append a
    // configured override instead of replacing that implicit value.
    let req = build_json_channel_request(
        &state.http_client,
        &target_url,
        &payload,
        std::time::Duration::from_secs_f64(row.timeout_seconds.max(1.0)),
        &request_headers,
    )?;
    let request_headers_preview = redact_header_preview(&request_headers);
    match req.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let response_headers: HashMap<String, String> = response
                .headers()
                .iter()
                .map(|(name, value)| {
                    let sensitive =
                        matches!(name.as_str(), "set-cookie" | "authorization" | "x-api-key");
                    (
                        name.to_string(),
                        if sensitive {
                            "[redacted]".into()
                        } else {
                            value.to_str().unwrap_or("[binary]").to_string()
                        },
                    )
                })
                .collect();
            let response_body = response.text().await.unwrap_or_default();
            let reply = serde_json::from_str::<serde_json::Value>(&response_body)
                .ok()
                .and_then(|payload| extract_model_test_reply(&payload));
            let preview: String = response_body.chars().take(10_000).collect();
            Ok(Json(serde_json::json!({
                "ok": status < 400,
                "status_code": status,
                "content_type": content_type,
                "response_headers": response_headers,
                "prompt": prompt,
                "request": { "url": target_url, "headers": request_headers_preview, "body": payload },
                "reply": reply,
                "preview": preview,
            })))
        }
        Err(error) => Ok(Json(serde_json::json!({
            "ok": false,
            "status_code": null,
            "message": error.to_string(),
        }))),
    }
}

pub async fn admin_fetch_upstream_models(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<ModelListOut>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;
    let extra = parse_extra_headers(&row.extra_headers)?;
    let out = fetch_models_for_target(
        &state.http_client,
        &row.base_url,
        row.api_key.as_deref(),
        &extra,
        row.timeout_seconds,
    )
    .await?;
    Ok(Json(out))
}

pub async fn admin_fetch_models_preview(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(data): Json<ModelFetchIn>,
) -> Result<Json<ModelListOut>, AppError> {
    let empty = HashMap::new();
    let extra = data.extra_headers.as_ref().unwrap_or(&empty);
    validate_overrides(extra)?;
    let timeout = data
        .timeout_seconds
        .unwrap_or(state.settings.upstream.default_timeout_seconds);
    let out = fetch_models_for_target(
        &state.http_client,
        &data.base_url,
        data.api_key.as_deref(),
        extra,
        timeout,
    )
    .await?;
    Ok(Json(out))
}

pub async fn admin_fetch_upstream_balance(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;

    let extra = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&extra)?;
    let timeout = std::time::Duration::from_secs_f64(row.timeout_seconds.max(1.0));
    let subscription_url = build_url(&row.base_url, "dashboard/billing/subscription", "");
    let usage_url = build_url(
        &row.base_url,
        "dashboard/billing/usage",
        "start_date=2020-01-01&end_date=2099-12-31",
    );

    let request_headers =
        build_channel_request_headers(HashMap::new(), row.api_key.as_deref(), &extra);
    let mut sub_req = state.http_client.get(&subscription_url).timeout(timeout);
    for (k, v) in &request_headers {
        sub_req = sub_req.header(k.as_str(), v.as_str());
    }

    let sub_response = match sub_req.send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "message": format!("请求失败: {e}")
            })));
        }
    };

    if sub_response.status().as_u16() != 200 {
        return Ok(Json(serde_json::json!({
            "ok": false,
            "message": format!("渠道返回 HTTP {}", sub_response.status().as_u16())
        })));
    }

    let sub_payload: serde_json::Value = match sub_response.json().await {
        Ok(v) => v,
        Err(_) => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "message": "渠道未返回 JSON"
            })));
        }
    };

    let mut used_usd: Option<f64> = None;
    let mut usage_req = state.http_client.get(&usage_url).timeout(timeout);
    for (k, v) in &request_headers {
        usage_req = usage_req.header(k.as_str(), v.as_str());
    }
    if let Ok(usage_response) = usage_req.send().await {
        if usage_response.status().as_u16() == 200 {
            if let Ok(usage_payload) = usage_response.json::<serde_json::Value>().await {
                if let Some(total_usage) = usage_payload.get("total_usage").and_then(|v| v.as_f64())
                {
                    used_usd = Some(total_usage / 100.0);
                }
            }
        }
    }

    let mut total_usd: Option<f64> = None;
    if let Some(obj) = sub_payload.as_object() {
        for key in ["hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"] {
            if let Some(v) = obj.get(key).and_then(|v| v.as_f64()) {
                total_usd = Some(v);
                break;
            }
        }
    }

    let mut remaining_usd: Option<f64> = None;
    if let (Some(total), Some(used)) = (total_usd, used_usd) {
        remaining_usd = Some(total - used);
    } else if let Some(obj) = sub_payload.as_object() {
        for key in ["total_available", "remain_quota", "remaining", "balance"] {
            if let Some(v) = obj.get(key).and_then(|v| v.as_f64()) {
                remaining_usd = Some(v);
                break;
            }
        }
    }

    if total_usd.is_none() && remaining_usd.is_none() {
        return Ok(Json(serde_json::json!({
            "ok": false,
            "message": "无法从响应中识别余额字段"
        })));
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "total_usd": total_usd,
        "used_usd": used_usd,
        "remaining_usd": remaining_usd,
    })))
}

#[cfg(test)]
mod tests {
    use super::{build_channel_request_headers, build_json_channel_request, redact_header_preview};
    use std::collections::HashMap;

    #[test]
    fn admin_channel_requests_apply_overrides_after_api_key_and_defaults() {
        let defaults = HashMap::from([
            ("content-type".into(), "application/json".into()),
            ("user-agent".into(), "default-agent".into()),
        ]);
        let overrides = HashMap::from([
            ("AUTHORIZATION".into(), "Token overridden".into()),
            ("User-Agent".into(), "channel-agent".into()),
            ("X-Client-Agent".into(), "{client_header:User-Agent}".into()),
        ]);

        let headers = build_channel_request_headers(defaults, Some("channel-api-key"), &overrides);

        assert_eq!(headers["authorization"], "Token overridden");
        assert_eq!(headers["user-agent"], "channel-agent");
        assert_eq!(headers["content-type"], "application/json");
        assert!(!headers.contains_key("x-client-agent"));
        assert_eq!(
            headers
                .keys()
                .filter(|name| name.eq_ignore_ascii_case("authorization"))
                .count(),
            1
        );
    }

    #[test]
    fn admin_header_preview_redacts_case_insensitive_credentials() {
        let headers = HashMap::from([
            ("AUTHORIZATION".into(), "secret-auth".into()),
            ("api-key".into(), "secret-api-key".into()),
            ("X-API-Key".into(), "secret-key".into()),
            ("X-Custom-Token".into(), "secret-token".into()),
            ("x-trace-id".into(), "trace-123".into()),
        ]);

        let preview = redact_header_preview(&headers);

        assert_eq!(preview["AUTHORIZATION"], "[redacted]");
        assert_eq!(preview["api-key"], "[redacted]");
        assert_eq!(preview["X-API-Key"], "[redacted]");
        assert_eq!(preview["X-Custom-Token"], "[redacted]");
        assert_eq!(preview["x-trace-id"], "trace-123");
    }

    #[test]
    fn model_test_request_has_one_overridden_content_type() {
        let headers = HashMap::from([("content-type".into(), "application/custom+json".into())]);
        let request = build_json_channel_request(
            &reqwest::Client::new(),
            "https://example.test/v1/responses",
            &serde_json::json!({"model": "test"}),
            std::time::Duration::from_secs(1),
            &headers,
        )
        .unwrap()
        .build()
        .unwrap();

        let values: Vec<_> = request
            .headers()
            .get_all(reqwest::header::CONTENT_TYPE)
            .iter()
            .collect();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0], "application/custom+json");
    }
}
