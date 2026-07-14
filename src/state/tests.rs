use std::{
    sync::atomic::{AtomicI64, Ordering},
    sync::Arc,
    time::Instant,
};

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use tokio::sync::RwLock;

use crate::{
    config::Settings,
    models::settings::{AdminCredential, RuntimeSettings},
    proxy::matcher::AutoWeightManager,
};

use super::{hash_admin_token, init_db, AdminAuthCache, AppState, RuntimeMetrics};

async fn test_pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap()
}

fn state_with_credential(credential: AdminCredential) -> AppState {
    let db = SqlitePool::connect_lazy("sqlite::memory:").unwrap();
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
        runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
        admin_credential_version: Arc::new(AtomicI64::new(credential.credential_version)),
        admin_credential: Arc::new(RwLock::new(credential)),
        admin_auth_cache: Arc::new(AdminAuthCache::new()),
        runtime_metrics,
        log_writer,
        log_stats,
        started_at: Instant::now(),
    }
}

#[tokio::test]
async fn initialization_does_not_overwrite_existing_runtime_settings() {
    let pool = test_pool().await;
    init_db(&pool).await.unwrap();
    sqlx::query("UPDATE runtime_settings SET log_body_keep_count = 42, revision = 7 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();

    init_db(&pool).await.unwrap();

    let row: (i64, i64) =
        sqlx::query_as("SELECT log_body_keep_count, revision FROM runtime_settings WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row, (42, 7));
}

#[tokio::test]
async fn initialization_migrates_legacy_routing_columns_with_current_defaults() {
    let pool = test_pool().await;
    sqlx::query(
        r#"CREATE TABLE upstreams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            base_url TEXT NOT NULL,
            api_key TEXT,
            model_names TEXT NOT NULL DEFAULT '[]',
            model_prefixes TEXT NOT NULL DEFAULT '[]',
            model_mappings TEXT NOT NULL DEFAULT '{}',
            priority INTEGER NOT NULL DEFAULT 100,
            enabled INTEGER NOT NULL DEFAULT 1,
            extra_headers TEXT NOT NULL DEFAULT '{}',
            timeout_seconds REAL NOT NULL DEFAULT 300.0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO upstreams (name, base_url) VALUES ('legacy', 'https://example.test')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"CREATE TABLE runtime_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            log_body_keep_count INTEGER NOT NULL,
            log_retention_days INTEGER NOT NULL,
            log_body_max_bytes INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runtime_settings (id, log_body_keep_count, log_retention_days, log_body_max_bytes) VALUES (1, 42, 30, 200000)",
    )
    .execute(&pool)
    .await
    .unwrap();

    init_db(&pool).await.unwrap();

    let upstream: (i64, i64) =
        sqlx::query_as("SELECT weight, auto_weight_enabled FROM upstreams WHERE name = 'legacy'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(upstream, (100, 1));
    let routing: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT max_retries, same_upstream_retry_interval_ms, auto_weight_failure_penalty, auto_weight_success_increment, auto_weight_recovery_increment, auto_weight_recovery_interval_seconds FROM runtime_settings WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(routing, (1, 1_000, 20, 5, 10, 60));
}

#[tokio::test]
async fn initialization_creates_current_log_schema_without_legacy_payload_columns() {
    let pool = test_pool().await;
    init_db(&pool).await.unwrap();

    let log_columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('request_logs') ORDER BY cid")
            .fetch_all(&pool)
            .await
            .unwrap();
    for column in [
        "client_type",
        "response_reasoning_effort",
        "downstream_token_id",
        "downstream_token_name",
    ] {
        assert!(log_columns.iter().any(|name| name == column));
    }
    for legacy_column in [
        "downstream_request",
        "upstream_request",
        "upstream_response",
        "downstream_response",
    ] {
        assert!(!log_columns.iter().any(|name| name == legacy_column));
    }

    let payload_columns: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM pragma_table_info('request_log_payloads') ORDER BY cid",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        payload_columns,
        vec![
            "request_log_id",
            "request_snapshot",
            "upstream_request_override",
            "upstream_request_is_override",
            "response_snapshot",
            "downstream_response_override",
            "downstream_response_is_override",
            "bodies_cleared",
        ]
    );

    let migration_table_exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_migrations')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(migration_table_exists, 0);
}

#[tokio::test]
async fn generated_argon2_hash_verifies_only_its_token() {
    let hash = hash_admin_token("test-token-not-a-deployment-secret".into())
        .await
        .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    let parsed = PasswordHash::new(&hash).unwrap();
    assert!(Argon2::default()
        .verify_password(b"test-token-not-a-deployment-secret", &parsed)
        .is_ok());
    assert!(Argon2::default()
        .verify_password(b"wrong-token", &parsed)
        .is_err());
}

#[tokio::test]
async fn successful_admin_auth_reuses_the_cached_fingerprint() {
    let token = "cached-admin-token".to_string();
    let state = state_with_credential(AdminCredential {
        credential_hash: hash_admin_token(token.clone()).await.unwrap(),
        credential_version: 1,
    });

    assert_eq!(state.authenticate_admin_token(token.clone()).await, Some(1));
    assert_eq!(state.authenticate_admin_token(token.clone()).await, Some(1));
    assert_eq!(
        state
            .admin_auth_cache
            .argon2_verifications
            .load(Ordering::Relaxed),
        1
    );

    assert_eq!(
        state
            .authenticate_admin_token("wrong-admin-token".into())
            .await,
        None
    );
    assert_eq!(state.authenticate_admin_token(token).await, Some(1));
    assert_eq!(
        state
            .admin_auth_cache
            .argon2_verifications
            .load(Ordering::Relaxed),
        2
    );
}

#[tokio::test]
async fn concurrent_admin_auth_performs_one_argon2_verification() {
    let token = "concurrent-admin-token".to_string();
    let state = state_with_credential(AdminCredential {
        credential_hash: hash_admin_token(token.clone()).await.unwrap(),
        credential_version: 1,
    });

    let (first, second, third) = tokio::join!(
        state.authenticate_admin_token(token.clone()),
        state.authenticate_admin_token(token.clone()),
        state.authenticate_admin_token(token),
    );

    assert_eq!((first, second, third), (Some(1), Some(1), Some(1)));
    assert_eq!(
        state
            .admin_auth_cache
            .argon2_verifications
            .load(Ordering::Relaxed),
        1
    );
}

#[tokio::test]
async fn credential_publication_never_reverts_to_an_older_version() {
    let state = state_with_credential(AdminCredential {
        credential_hash: "version-one".into(),
        credential_version: 1,
    });
    let version_three = AdminCredential {
        credential_hash: "version-three".into(),
        credential_version: 3,
    };
    let version_two = AdminCredential {
        credential_hash: "version-two".into(),
        credential_version: 2,
    };

    state.publish_admin_credential(version_three).await;
    state.publish_admin_credential(version_two).await;

    let published = state.admin_credential.read().await;
    assert_eq!(published.credential_version, 3);
    assert_eq!(published.credential_hash, "version-three");
    assert_eq!(
        state
            .admin_credential_version
            .load(std::sync::atomic::Ordering::Acquire),
        3
    );
}

#[tokio::test]
async fn published_rotation_invalidates_the_admin_auth_cache() {
    let old_token = "old-admin-token".to_string();
    let new_token = "new-admin-token".to_string();
    let state = state_with_credential(AdminCredential {
        credential_hash: hash_admin_token(old_token.clone()).await.unwrap(),
        credential_version: 1,
    });

    assert_eq!(
        state.authenticate_admin_token(old_token.clone()).await,
        Some(1)
    );

    state
        .publish_admin_credential(AdminCredential {
            credential_hash: hash_admin_token(new_token.clone()).await.unwrap(),
            credential_version: 2,
        })
        .await;

    assert_eq!(state.authenticate_admin_token(old_token).await, None);
    assert_eq!(
        state.authenticate_admin_token(new_token.clone()).await,
        Some(2)
    );
    assert_eq!(state.authenticate_admin_token(new_token).await, Some(2));
    assert_eq!(
        state
            .admin_auth_cache
            .argon2_verifications
            .load(Ordering::Relaxed),
        3
    );
}
