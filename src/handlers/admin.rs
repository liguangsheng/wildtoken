use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;

use crate::db::{log as log_db, settings as settings_db, token as token_db};
use crate::error::AppError;
use crate::middleware::auth::AdminAuth;
use crate::models::request_log::{RequestLogPage, TokenUsageStatsOut};
use crate::models::settings::{
    AdminTokenRotateIn, AdminTokenRotateOut, ModelTestPromptTemplate, ModelTestPromptTemplateIn,
    ModelTestTemplate, ModelTestTemplateIn, RuntimeLogSettingsSummary, RuntimeSettingsIn,
    RuntimeSettingsOut, SystemInfoOut,
};
use crate::models::token::{ApiTokenDetailOut, ApiTokenIn};
use crate::models::upstream::UpstreamEnabledIn;
use crate::state::{hash_admin_token, AppState};

mod upstreams;

pub use upstreams::*;

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

pub async fn admin_list_model_test_templates(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<Vec<ModelTestTemplate>>, AppError> {
    Ok(Json(
        settings_db::list_model_test_templates(&state.db).await?,
    ))
}

pub async fn admin_create_model_test_template(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<ModelTestTemplateIn>,
) -> Result<Response, AppError> {
    input
        .validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    match settings_db::create_model_test_template(&state.db, &input).await {
        Ok(template) => Ok((StatusCode::CREATED, Json(template)).into_response()),
        Err(AppError::Database(error)) if error.to_string().contains("UNIQUE") => {
            Err(AppError::BadRequest("template name already exists".into()))
        }
        Err(error) => Err(error),
    }
}

pub async fn admin_update_model_test_template(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(input): Json<ModelTestTemplateIn>,
) -> Result<Json<ModelTestTemplate>, AppError> {
    input
        .validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    let template = settings_db::update_model_test_template(&state.db, id, &input)
        .await?
        .ok_or_else(|| AppError::NotFound("model test template not found".into()))?;
    Ok(Json(template))
}

pub async fn admin_delete_model_test_template(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if settings_db::delete_model_test_template(&state.db, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("model test template not found".into()))
    }
}

pub async fn admin_list_model_test_prompt_templates(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<Vec<ModelTestPromptTemplate>>, AppError> {
    Ok(Json(
        settings_db::list_model_test_prompt_templates(&state.db).await?,
    ))
}
pub async fn admin_create_model_test_prompt_template(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<ModelTestPromptTemplateIn>,
) -> Result<Response, AppError> {
    input
        .validate()
        .map_err(|m| AppError::BadRequest(m.into()))?;
    Ok((
        StatusCode::CREATED,
        Json(settings_db::create_model_test_prompt_template(&state.db, &input).await?),
    )
        .into_response())
}
pub async fn admin_update_model_test_prompt_template(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(input): Json<ModelTestPromptTemplateIn>,
) -> Result<Json<ModelTestPromptTemplate>, AppError> {
    input
        .validate()
        .map_err(|m| AppError::BadRequest(m.into()))?;
    Ok(Json(
        settings_db::update_model_test_prompt_template(&state.db, id, &input)
            .await?
            .ok_or_else(|| AppError::NotFound("model test prompt template not found".into()))?,
    ))
}
pub async fn admin_delete_model_test_prompt_template(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if settings_db::delete_model_test_prompt_template(&state.db, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound(
            "model test prompt template not found".into(),
        ))
    }
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
