use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;

use crate::db::{
    log as log_db, settings as settings_db, token as token_db, upstream as upstream_db,
};
use crate::error::AppError;
use crate::middleware::auth::AdminAuth;
use crate::models::request_log::{
    ModelFetchIn, ModelListOut, RequestLogPage, TestRequest, TokenUsageStatsOut,
};
use crate::models::settings::{
    AdminTokenRotateIn, AdminTokenRotateOut, RuntimeLogSettingsSummary, RuntimeSettingsIn,
    RuntimeSettingsOut, SystemInfoOut,
};
use crate::models::token::{ApiTokenDetailOut, ApiTokenIn};
use crate::models::upstream::{
    UpstreamDetailOut, UpstreamEnabledIn, UpstreamIn, UpstreamPriorityIn, UpstreamUpdate,
};
use crate::state::{hash_admin_token, AppState};

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
    let target_url = build_url(base_url, "models", "");
    let mut req = client
        .get(&target_url)
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds.max(1.0)));

    for (k, v) in extra_headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
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

fn parse_extra_headers(s: &str) -> HashMap<String, String> {
    serde_json::from_str(s).unwrap_or_default()
}

// ── Health ───────────────────────────────────────────────────────────────────

pub async fn health_check(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "service": "WildToken"
    })))
}

// ── Runtime settings ─────────────────────────────────────────────────────────

pub async fn admin_get_runtime_settings(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<RuntimeSettingsOut>, AppError> {
    let snapshot = state.runtime_settings.read().await.clone();
    Ok(Json(RuntimeSettingsOut::from(&snapshot)))
}

pub async fn admin_update_runtime_settings(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<RuntimeSettingsIn>,
) -> Result<Json<RuntimeSettingsOut>, AppError> {
    input
        .validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    let updated = settings_db::update_runtime_settings(&state.db, &input).await?;
    {
        let mut snapshot = state.runtime_settings.write().await;
        if updated.revision > snapshot.revision {
            *snapshot = updated.clone();
        }
    }
    Ok(Json(RuntimeSettingsOut::from(&updated)))
}

// ── Admin credential and system information ──────────────────────────────────

pub async fn admin_rotate_admin_token(
    State(state): State<AppState>,
    auth: AdminAuth,
    Json(input): Json<AdminTokenRotateIn>,
) -> Result<Response, AppError> {
    if !input.confirm {
        return Err(AppError::BadRequest(
            "explicit confirmation is required".into(),
        ));
    }

    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = hash_admin_token(token.clone()).await?;
    let credential =
        settings_db::rotate_admin_credential(&state.db, &hash, auth.credential_version)
            .await?
            .ok_or_else(|| AppError::Conflict("admin credential version conflict".into()))?;

    // The snapshot is published only after the credential transaction commits.
    // Publication is monotonic even if concurrent rotations finish out of order.
    state.publish_admin_credential(credential).await;
    let mut response = Json(AdminTokenRotateOut { token }).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub async fn admin_system_info(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Json<SystemInfoOut> {
    let database_ok = sqlx::query("SELECT 1").execute(&state.db).await.is_ok();
    let database_allocated_bytes = if database_ok {
        sqlx::query_scalar::<_, i64>(
            "SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size())",
        )
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let total_log_count = sqlx::query_scalar("SELECT COUNT(*) FROM request_logs")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    let log_count_24h = sqlx::query_scalar(
        "SELECT COUNT(*) FROM request_logs WHERE created_at >= datetime('now', '-24 hours')",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let recent_one_minute_log_count = sqlx::query_scalar(
        "SELECT COUNT(*) FROM request_logs WHERE created_at >= datetime('now', '-60 seconds')",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let (enabled_upstream_count, total_upstream_count) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0), COUNT(*) FROM upstreams",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or((0, 0));
    let settings = state.runtime_settings.read().await.clone();

    Json(SystemInfoOut {
        service: "WildToken",
        version: env!("CARGO_PKG_VERSION"),
        default_upstream_timeout_seconds: state.settings.upstream.default_timeout_seconds,
        uptime_seconds: state.started_at.elapsed().as_secs(),
        current_server_time: chrono::Local::now().to_rfc3339(),
        database_ok,
        database_allocated_bytes,
        total_log_count,
        log_count_24h,
        enabled_upstream_count,
        total_upstream_count,
        recent_one_minute_log_count,
        runtime_log_settings: RuntimeLogSettingsSummary {
            log_body_keep_count: settings.log_body_keep_count,
            log_retention_days: settings.log_retention_days,
            log_body_max_bytes: settings.log_body_max_bytes,
            revision: settings.revision,
        },
    })
}

// ── Upstreams ────────────────────────────────────────────────────────────────

pub async fn admin_list_upstreams(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<Vec<crate::models::upstream::UpstreamOut>>, AppError> {
    let mut items = upstream_db::list_upstreams(&state.db).await?;
    for item in &mut items {
        item.backoff_remaining_seconds = state.backoff.backoff_remaining_seconds(item.id);
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

    let backoff = state.backoff.backoff_remaining_seconds(row.id);
    let model_names: Vec<String> = serde_json::from_str(&row.model_names).unwrap_or_default();
    let model_prefixes: Vec<String> = serde_json::from_str(&row.model_prefixes).unwrap_or_default();
    let model_mappings: HashMap<String, String> =
        serde_json::from_str(&row.model_mappings).unwrap_or_default();
    let extra_headers: HashMap<String, String> =
        serde_json::from_str(&row.extra_headers).unwrap_or_default();

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
        enabled: row.enabled == 1,
        extra_headers,
        timeout_seconds: row.timeout_seconds,
        created_at: row.created_at,
        updated_at: row.updated_at,
        backoff_remaining_seconds: backoff,
    }))
}

pub async fn admin_create_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<UpstreamIn>,
) -> Result<Response, AppError> {
    match upstream_db::create_upstream(
        &state.db,
        &input,
        state.settings.upstream.default_timeout_seconds,
    )
    .await
    {
        Ok(out) => Ok((StatusCode::CREATED, Json(out)).into_response()),
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
    if upstream_db::get_upstream(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("upstream not found".into()));
    }
    let out = upstream_db::update_upstream(
        &state.db,
        id,
        &input,
        state.settings.upstream.default_timeout_seconds,
    )
    .await?;
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
    let out = upstream_db::set_upstream_enabled(&state.db, id, body.enabled).await?;
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
    let out = upstream_db::set_upstream_priority(&state.db, id, body.priority).await?;
    Ok(Json(out))
}

pub async fn admin_delete_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = upstream_db::delete_upstream(&state.db, id).await?;
    if deleted {
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

    let extra = parse_extra_headers(&row.extra_headers);
    for (k, v) in &extra {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(ref key) = row.api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
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

pub async fn admin_fetch_upstream_models(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<ModelListOut>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;
    let extra = parse_extra_headers(&row.extra_headers);
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

    let extra = parse_extra_headers(&row.extra_headers);
    let timeout = std::time::Duration::from_secs_f64(row.timeout_seconds.max(1.0));
    let subscription_url = build_url(&row.base_url, "dashboard/billing/subscription", "");
    let usage_url = build_url(
        &row.base_url,
        "dashboard/billing/usage",
        "start_date=2020-01-01&end_date=2099-12-31",
    );

    let mut sub_req = state.http_client.get(&subscription_url).timeout(timeout);
    for (k, v) in &extra {
        sub_req = sub_req.header(k.as_str(), v.as_str());
    }
    if let Some(ref key) = row.api_key {
        if !key.is_empty() {
            sub_req = sub_req.header("Authorization", format!("Bearer {key}"));
        }
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
    for (k, v) in &extra {
        usage_req = usage_req.header(k.as_str(), v.as_str());
    }
    if let Some(ref key) = row.api_key {
        if !key.is_empty() {
            usage_req = usage_req.header("Authorization", format!("Bearer {key}"));
        }
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

// ── Tokens ───────────────────────────────────────────────────────────────────

pub async fn admin_list_tokens(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<Vec<crate::models::token::ApiTokenOut>>, AppError> {
    let items = token_db::list_tokens(&state.db).await?;
    Ok(Json(items))
}

pub async fn admin_get_token(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<ApiTokenDetailOut>, AppError> {
    let row = token_db::get_token(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("token not found".into()))?;
    Ok(Json(ApiTokenDetailOut {
        id: row.id,
        name: row.name,
        description: row.description,
        token: row.token,
        enabled: row.enabled == 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }))
}

pub async fn admin_create_token(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<ApiTokenIn>,
) -> Result<Response, AppError> {
    match token_db::create_token(&state.db, &input).await {
        Ok(out) => Ok((StatusCode::CREATED, Json(out)).into_response()),
        Err(AppError::Database(e)) if e.to_string().contains("UNIQUE") => Err(
            AppError::BadRequest("token name or value already exists".into()),
        ),
        Err(e) => Err(e),
    }
}

pub async fn admin_update_token(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(input): Json<ApiTokenIn>,
) -> Result<Json<crate::models::token::ApiTokenOut>, AppError> {
    if token_db::get_token(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("token not found".into()));
    }
    let out = token_db::update_token(&state.db, id, &input.name, &input.description).await?;
    Ok(Json(out))
}

pub async fn admin_set_token_enabled(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(body): Json<UpstreamEnabledIn>,
) -> Result<Json<crate::models::token::ApiTokenOut>, AppError> {
    if token_db::get_token(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("token not found".into()));
    }
    let out = token_db::set_token_enabled(&state.db, id, body.enabled).await?;
    Ok(Json(out))
}

pub async fn admin_delete_token(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = token_db::delete_token(&state.db, id).await?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("token not found".into()))
    }
}

// ── Logs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LogQuery {
    #[serde(default = "default_limit")]
    limit: i32,
    #[serde(default)]
    offset: i32,
    upstream_id: Option<i64>,
    search: Option<String>,
    status: Option<String>,
}

fn default_limit() -> i32 {
    50
}

pub async fn admin_list_logs(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Query(query): Query<LogQuery>,
) -> Result<Json<RequestLogPage>, AppError> {
    let limit = query.limit.clamp(1, 200);
    let offset = query.offset.max(0);
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let status = query
        .status
        .as_deref()
        .filter(|status| matches!(*status, "2xx" | "4xx" | "5xx" | "none"));
    let (mut items, recent_rpm) = log_db::list_logs(
        &state.db,
        limit + 1,
        offset,
        query.upstream_id,
        search,
        status,
    )
    .await?;
    let has_more = items.len() as i32 > limit;
    if has_more {
        items.truncate(limit as usize);
    }
    Ok(Json(RequestLogPage {
        items,
        has_more,
        recent_rpm,
    }))
}

pub async fn admin_token_usage_stats(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<TokenUsageStatsOut>, AppError> {
    Ok(Json(log_db::token_usage_stats(&state.db).await?))
}

pub async fn admin_get_log_detail(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<crate::models::request_log::RequestLogDetailOut>, AppError> {
    let detail = log_db::get_log_detail(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("request log not found".into()))?;
    Ok(Json(detail))
}
