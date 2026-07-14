mod config;
mod db;
mod error;
mod handlers;
mod middleware;
mod models;
mod proxy;
mod state;

use axum::{
    routing::{any, get, patch, post},
    Router,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::sync::atomic::AtomicI64;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::proxy::matcher::AutoWeightManager;
use crate::state::{
    bootstrap_admin_credential, init_db, load_runtime_settings, AdminAuthCache, AppState,
    RuntimeMetrics,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 2. Load config
    let mut settings = config::Settings::load().expect("Failed to load configuration");
    let bind_addr = format!("{}:{}", settings.server.host, settings.server.port);
    let database_url = settings.database.url.clone();

    // 3. Setup database
    let max_connections = settings.database.max_connections.max(1);
    let sqlite_cache_size_kib = settings.database.sqlite_cache_size_kib.max(256);
    let sqlite_statement_cache_capacity = settings.database.sqlite_statement_cache_capacity;
    let sqlite_mmap_size_bytes = settings.database.sqlite_mmap_size_bytes.max(0);
    let db_connect_options = database_url
        .parse::<SqliteConnectOptions>()?
        .statement_cache_capacity(sqlite_statement_cache_capacity)
        .pragma("foreign_keys", "ON")
        .pragma("auto_vacuum", "INCREMENTAL")
        .pragma("cache_size", format!("-{sqlite_cache_size_kib}"))
        .pragma("mmap_size", sqlite_mmap_size_bytes.to_string());
    let db = SqlitePoolOptions::new()
        .max_connections(max_connections)
        .idle_timeout(Duration::from_secs(settings.database.idle_timeout_seconds))
        .connect_with(db_connect_options)
        .await?;
    init_db(&db).await?;
    let sqlite_auto_vacuum: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
        .fetch_one(&db)
        .await?;
    if sqlite_auto_vacuum != 2 {
        tracing::warn!(
            sqlite_auto_vacuum,
            "SQLite incremental auto-vacuum is not active; run a maintenance VACUUM once"
        );
    }
    let runtime_settings = load_runtime_settings(&db).await;
    let admin_credential = bootstrap_admin_credential(&db, settings.admin.token.clone()).await?;
    // The startup token is bootstrap material only; never retain it as a fallback.
    settings.admin.token.clear();

    // 4. Setup HTTP client
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            settings.upstream.default_timeout_seconds as u64,
        ))
        .pool_max_idle_per_host(20)
        .build()?;

    // 5. Create shared state
    let runtime_metrics = Arc::new(RuntimeMetrics::new());
    let log_stats = Arc::new(db::log_stats::LogStatsCache::load(&db).await?);
    let log_writer = proxy::logging::spawn_log_writer(
        db.clone(),
        runtime_metrics.clone(),
        log_stats.clone(),
        settings.logging.log_queue_capacity,
    );
    let state = AppState {
        db: db.clone(),
        http_client,
        settings: settings.clone(),
        auto_weight: Arc::new(AutoWeightManager::new()),
        runtime_settings: Arc::new(tokio::sync::RwLock::new(runtime_settings)),
        admin_credential_version: Arc::new(AtomicI64::new(admin_credential.credential_version)),
        admin_credential: Arc::new(tokio::sync::RwLock::new(admin_credential)),
        admin_auth_cache: Arc::new(AdminAuthCache::new()),
        runtime_metrics,
        log_writer,
        log_stats,
        started_at: std::time::Instant::now(),
    };

    // 6. Spawn background maintenance
    tokio::spawn(db::log_stats::refresh_loop(
        db.clone(),
        state.log_stats.clone(),
        state.runtime_metrics.clone(),
    ));
    tokio::spawn(proxy::logging::cleanup_loop(
        db.clone(),
        state.runtime_settings.clone(),
        state.runtime_metrics.clone(),
        state.log_stats.clone(),
    ));

    // 7. Build router

    // ── Admin API ───────────────────────────────────────────────────────
    let admin_routes = Router::new()
        .route(
            "/api/admin/settings",
            get(handlers::admin::admin_get_runtime_settings)
                .put(handlers::admin::admin_update_runtime_settings),
        )
        .route(
            "/api/admin/settings/admin-token/rotate",
            post(handlers::admin::admin_rotate_admin_token),
        )
        .route(
            "/api/admin/settings/model-test-templates",
            get(handlers::admin::admin_list_model_test_templates)
                .post(handlers::admin::admin_create_model_test_template),
        )
        .route(
            "/api/admin/settings/model-test-templates/{id}",
            patch(handlers::admin::admin_update_model_test_template)
                .delete(handlers::admin::admin_delete_model_test_template),
        )
        .route(
            "/api/admin/settings/model-test-prompts",
            get(handlers::admin::admin_list_model_test_prompt_templates)
                .post(handlers::admin::admin_create_model_test_prompt_template),
        )
        .route(
            "/api/admin/settings/model-test-prompts/{id}",
            patch(handlers::admin::admin_update_model_test_prompt_template)
                .delete(handlers::admin::admin_delete_model_test_prompt_template),
        )
        .route("/api/admin/system", get(handlers::admin::admin_system_info))
        .route(
            "/api/admin/system/metrics",
            get(handlers::admin::admin_runtime_metrics),
        )
        // Upstreams
        .route(
            "/api/admin/upstreams/fetch-models",
            post(handlers::admin::admin_fetch_models_preview),
        )
        .route(
            "/api/admin/upstreams",
            get(handlers::admin::admin_list_upstreams).post(handlers::admin::admin_create_upstream),
        )
        .route(
            "/api/admin/upstreams/{id}",
            get(handlers::admin::admin_get_upstream)
                .put(handlers::admin::admin_update_upstream)
                .delete(handlers::admin::admin_delete_upstream),
        )
        .route(
            "/api/admin/upstreams/{id}/enabled",
            patch(handlers::admin::admin_set_upstream_enabled),
        )
        .route(
            "/api/admin/upstreams/{id}/priority",
            patch(handlers::admin::admin_set_upstream_priority),
        )
        .route(
            "/api/admin/upstreams/{id}/test",
            post(handlers::admin::admin_test_upstream),
        )
        .route(
            "/api/admin/upstreams/{id}/test-model",
            post(handlers::admin::admin_test_upstream_model),
        )
        .route(
            "/api/admin/upstreams/{id}/models",
            post(handlers::admin::admin_fetch_upstream_models),
        )
        .route(
            "/api/admin/upstreams/{id}/balance",
            post(handlers::admin::admin_fetch_upstream_balance),
        )
        // Tokens
        .route(
            "/api/admin/tokens",
            get(handlers::admin::admin_list_tokens).post(handlers::admin::admin_create_token),
        )
        .route(
            "/api/admin/tokens/{id}",
            get(handlers::admin::admin_get_token)
                .put(handlers::admin::admin_update_token)
                .delete(handlers::admin::admin_delete_token),
        )
        .route(
            "/api/admin/tokens/{id}/enabled",
            patch(handlers::admin::admin_set_token_enabled),
        )
        // Logs
        .route("/api/admin/logs", get(handlers::admin::admin_list_logs))
        .route(
            "/api/admin/logs/token-usage",
            get(handlers::admin::admin_token_usage_stats),
        )
        .route(
            "/api/admin/logs/top",
            get(handlers::admin::admin_top_log_stats),
        )
        .route(
            "/api/admin/logs/{id}",
            get(handlers::admin::admin_get_log_detail),
        );

    let app = Router::new()
        .route("/health", get(handlers::admin::health_check))
        .route(
            "/",
            get(|| async { axum::response::Redirect::to("/admin") }),
        )
        .route("/admin", get(serve_admin_html))
        .route("/v1/models", get(handlers::proxy::list_models_handler))
        .route("/v1/{*path}", any(handlers::proxy::proxy_handler))
        .nest_service("/static", tower_http::services::ServeDir::new("static"))
        .merge(admin_routes)
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::any())
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    // 8. Start server
    tracing::info!("WildToken starting on http://{}", bind_addr);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Serve the admin console from static/.
async fn serve_admin_html() -> axum::response::Response {
    serve_html_file("static/admin.html").await
}

async fn serve_html_file(path: &str) -> axum::response::Response {
    match tokio::fs::read_to_string(path).await {
        Ok(html) => axum::response::Response::builder()
            .header("content-type", "text/html; charset=utf-8")
            .body(axum::body::Body::from(html))
            .unwrap(),
        Err(_) => axum::response::Response::builder()
            .status(axum::http::StatusCode::NOT_FOUND)
            .body(axum::body::Body::from("Admin page not found"))
            .unwrap(),
    }
}
