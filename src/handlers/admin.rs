use std::{convert::Infallible, sync::atomic::Ordering, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde::Deserialize;

use crate::db::{
    log as log_db, log_stats as log_stats_db, settings as settings_db, token as token_db,
};
use crate::error::AppError;
use crate::middleware::auth::AdminAuth;
use crate::models::request_log::{RequestLogCursorOut, RequestLogPage, TokenUsageStatsOut};
use crate::models::settings::{
    AdminTokenRotateIn, ModelTestPromptTemplate, ModelTestPromptTemplateIn, ModelTestTemplate,
    ModelTestTemplateIn, RuntimeCleanupMetricsOut, RuntimeLogSettingsSummary, RuntimeMetricsOut,
    RuntimeSettingsIn, RuntimeSettingsOut, SystemInfoOut,
};
use crate::models::token::{ApiTokenIn, ApiTokenOut, ApiTokenUpdateIn};
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
) -> Result<StatusCode, AppError> {
    if !input.confirm {
        return Err(AppError::BadRequest(
            "explicit confirmation is required".into(),
        ));
    }

    let token = input
        .validated_token()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    let hash = hash_admin_token(token.to_owned()).await?;
    let credential =
        settings_db::rotate_admin_credential(&state.db, &hash, auth.credential_version)
            .await?
            .ok_or_else(|| AppError::Conflict("admin credential version conflict".into()))?;

    // The snapshot is published only after the credential transaction commits.
    // Publication is monotonic even if concurrent rotations finish out of order.
    state.publish_admin_credential(credential).await;
    Ok(StatusCode::NO_CONTENT)
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
    let log_stats = state.log_stats.snapshot();
    let recent_one_minute_log_count = log_stats_db::recent_one_minute_log_count(&state.db)
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
        total_log_count: log_stats.total_log_count,
        log_count_24h: log_stats.log_count_24h,
        enabled_upstream_count,
        total_upstream_count,
        recent_one_minute_log_count,
        runtime_log_settings: RuntimeLogSettingsSummary {
            log_body_keep_count: settings.log_body_keep_count,
            log_retention_days: settings.log_retention_days,
            log_body_max_bytes: settings.log_body_max_bytes,
            revision: settings.revision,
        },
        runtime_metrics: runtime_metrics_out(&state),
    })
}

pub async fn admin_runtime_metrics(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Json<RuntimeMetricsOut> {
    Json(runtime_metrics_out(&state))
}

fn runtime_metrics_out(state: &AppState) -> RuntimeMetricsOut {
    let metrics = state.runtime_metrics.snapshot();
    RuntimeMetricsOut {
        active_sse_streams: metrics.active_sse_streams,
        sse_completed_total: metrics.sse_completed_total,
        sse_client_disconnects_total: metrics.sse_client_disconnects_total,
        sse_recent_disconnects_10m: metrics.sse_recent_disconnects_10m,
        sse_upstream_errors_total: metrics.sse_upstream_errors_total,
        log_queue_depth: metrics.log_queue_depth,
        log_written_total: metrics.log_written_total,
        log_write_batches_total: metrics.log_write_batches_total,
        log_dropped_total: metrics.log_dropped_total,
        log_write_failures_total: metrics.log_write_failures_total,
        slow_db_operations_total: metrics.slow_db_operations_total,
        cleanup: RuntimeCleanupMetricsOut {
            active: metrics.cleanup_active,
            runs_total: metrics.cleanup_runs_total,
            errors_total: metrics.cleanup_errors_total,
            rows_cleared_total: metrics.cleanup_rows_cleared_total,
            batches_total: metrics.cleanup_batches_total,
            current_rows_cleared: metrics.cleanup_current_rows_cleared,
            current_batches: metrics.cleanup_current_batches,
            last_started_unix_seconds: metrics.cleanup_last_started_unix_seconds,
            last_finished_unix_seconds: metrics.cleanup_last_finished_unix_seconds,
            last_duration_ms: metrics.cleanup_last_duration_ms,
            last_rows_cleared: metrics.cleanup_last_rows_cleared,
        },
    }
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
) -> Result<Json<ApiTokenOut>, AppError> {
    let token = token_db::get_token(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("token not found".into()))?;
    Ok(Json(token))
}

pub async fn admin_create_token(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<ApiTokenIn>,
) -> Result<Response, AppError> {
    input
        .validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
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
    Json(input): Json<ApiTokenUpdateIn>,
) -> Result<Json<crate::models::token::ApiTokenOut>, AppError> {
    input
        .validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    if token_db::get_token(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("token not found".into()));
    }
    let out = token_db::update_token(&state.db, id, &input).await?;
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
    before_created_at: Option<String>,
    before_id: Option<i64>,
    upstream_id: Option<i64>,
    search: Option<String>,
    status: Option<String>,
    client_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LogTopQuery {
    window: Option<String>,
    limit: Option<i64>,
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
    let before_created_at = query
        .before_created_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let status = query
        .status
        .as_deref()
        .filter(|status| matches!(*status, "2xx" | "4xx" | "5xx" | "none"));
    let client_type = query
        .client_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut items = log_db::list_logs(
        &state.db,
        limit + 1,
        offset,
        before_created_at,
        query.before_id,
        query.upstream_id,
        search,
        status,
        client_type,
    )
    .await?;
    let has_more = items.len() as i32 > limit;
    if has_more {
        items.truncate(limit as usize);
    }
    let next_cursor = if has_more {
        items.last().map(|item| RequestLogCursorOut {
            created_at: item.created_at.clone(),
            id: item.id,
        })
    } else {
        None
    };
    let recent_rate = log_stats_db::recent_one_minute_log_rate(&state.db).await?;
    Ok(Json(RequestLogPage {
        items,
        has_more,
        recent_rpm: recent_rate.request_count,
        recent_tpm: recent_rate.total_tokens,
        next_cursor,
    }))
}

/// Stream lightweight list-row events for request logs that have committed to SQLite.
///
/// This endpoint intentionally does not replay historical rows. A disconnected
/// or lagged client reloads the normal paginated endpoint, which remains the
/// source of truth and keeps cursor pagination stable.
pub async fn admin_stream_logs(
    State(state): State<AppState>,
    auth: AdminAuth,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.log_writer.subscribe_log_events();
    let credential_version = state.admin_credential_version.clone();
    let authenticated_version = auth.credential_version;
    let auth_check_interval = tokio::time::interval(Duration::from_secs(15));

    let stream = futures::stream::unfold(
        (receiver, auth_check_interval),
        move |(mut receiver, mut auth_check_interval)| {
            let credential_version = credential_version.clone();
            async move {
                loop {
                    tokio::select! {
                        result = receiver.recv() => match result {
                            Ok(log) => {
                                if credential_version.load(Ordering::Acquire) != authenticated_version {
                                    return None;
                                }
                                let log_id = log.log.id;
                                let data = serde_json::to_string(&log)
                                    .unwrap_or_else(|_| format!(r#"{{"log":{{"id":{log_id}}}}}"#));
                                let event = Event::default()
                                    .event("log")
                                    .id(log_id.to_string())
                                    .data(data);
                                return Some((Ok(event), (receiver, auth_check_interval)));
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                let event = Event::default().event("resync").data("{}");
                                return Some((Ok(event), (receiver, auth_check_interval)));
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                        },
                        _ = auth_check_interval.tick() => {
                            if credential_version.load(Ordering::Acquire) != authenticated_version {
                                return None;
                            }
                        }
                    }
                }
            }
        },
    );

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

pub async fn admin_token_usage_stats(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<TokenUsageStatsOut>, AppError> {
    Ok(Json(state.log_stats.snapshot().token_usage))
}

pub async fn admin_top_log_stats(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Query(query): Query<LogTopQuery>,
) -> Result<Json<crate::models::request_log::RequestLogTopStatsOut>, AppError> {
    let window_value = query
        .window
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("today");
    let window = log_db::LogTopWindow::from_query_value(window_value).ok_or_else(|| {
        AppError::BadRequest("window must be one of: today, 1d, 3d, 7d, 30d".into())
    })?;
    let limit = query.limit.unwrap_or(10).clamp(1, 20);

    Ok(Json(log_db::top_log_stats(&state.db, window, limit).await?))
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
