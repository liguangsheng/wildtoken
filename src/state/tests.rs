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
    proxy::matcher::BackoffManager,
};

use super::{
    hash_admin_token, init_db, AdminAuthCache, AppState, RuntimeMetrics, CLIENT_TYPE_BACKFILL,
    REQUEST_LOG_PAYLOADS_MIGRATION, RESPONSE_REASONING_EFFORT_BACKFILL,
};

async fn test_pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap()
}

fn state_with_credential(credential: AdminCredential) -> AppState {
    AppState {
        db: SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
        http_client: reqwest::Client::new(),
        settings: Settings::default(),
        backoff: Arc::new(BackoffManager::new()),
        runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
        admin_credential_version: Arc::new(AtomicI64::new(credential.credential_version)),
        admin_credential: Arc::new(RwLock::new(credential)),
        admin_auth_cache: Arc::new(AdminAuthCache::new()),
        runtime_metrics: Arc::new(RuntimeMetrics::new()),
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
async fn payload_migration_deduplicates_snapshots_null_safely() {
    let pool = test_pool().await;
    init_db(&pool).await.unwrap();
    sqlx::query("DELETE FROM app_migrations WHERE name IN (?, ?, ?)")
        .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
        .bind(CLIENT_TYPE_BACKFILL)
        .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
        .execute(&pool)
        .await
        .unwrap();

    let shared_request = r#"{"headers":{"user-agent":"codex-cli"}}"#;
    let shared_response = r#"{"body":{"effort":"high"}}"#;
    sqlx::query(
        r#"INSERT INTO request_logs (
               id, method, path, client_type, downstream_request,
               upstream_request, upstream_response, downstream_response
           ) VALUES (1, 'POST', 'responses', 'unknown', ?, ?, ?, ?)"#,
    )
    .bind(shared_request)
    .bind(shared_request)
    .bind(shared_response)
    .bind(shared_response)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO request_logs (
               id, method, path, downstream_request, upstream_request,
               upstream_response, downstream_response
           ) VALUES (2, 'POST', 'responses', NULL, 'upstream-only-request',
               'upstream-only-response', NULL)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO request_logs (
               id, method, path, downstream_request, upstream_request,
               upstream_response, downstream_response
           ) VALUES (3, 'POST', 'responses', 'downstream-only-request', NULL,
               NULL, 'downstream-only-response')"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    init_db(&pool).await.unwrap();

    type PayloadRow = (
        i64,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        i64,
    );
    let payloads: Vec<PayloadRow> = sqlx::query_as(
        r#"SELECT request_log_id, request_snapshot,
               upstream_request_override, upstream_request_is_override,
               response_snapshot, downstream_response_override,
               downstream_response_is_override
           FROM request_log_payloads ORDER BY request_log_id"#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        payloads,
        vec![
            (
                1,
                Some(shared_request.into()),
                None,
                0,
                Some(shared_response.into()),
                None,
                0,
            ),
            (
                2,
                None,
                Some("upstream-only-request".into()),
                1,
                Some("upstream-only-response".into()),
                None,
                1,
            ),
            (
                3,
                Some("downstream-only-request".into()),
                None,
                1,
                None,
                Some("downstream-only-response".into()),
                1,
            ),
        ]
    );

    let legacy_rows_with_payloads: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM request_logs
           WHERE downstream_request IS NOT NULL
              OR upstream_request IS NOT NULL
              OR upstream_response IS NOT NULL
              OR downstream_response IS NOT NULL"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(legacy_rows_with_payloads, 0);
    let derived: (String, Option<String>) = sqlx::query_as(
        "SELECT client_type, response_reasoning_effort FROM request_logs WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(derived, ("codex".into(), Some("high".into())));

    init_db(&pool).await.unwrap();
    let payload_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_log_payloads")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(payload_count, 3);
}

#[tokio::test]
async fn legacy_backfills_update_only_changed_matched_rows_and_run_once() {
    let pool = test_pool().await;
    init_db(&pool).await.unwrap();
    sqlx::query("DELETE FROM app_migrations WHERE name IN (?, ?, ?)")
        .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
        .bind(CLIENT_TYPE_BACKFILL)
        .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"CREATE TABLE request_log_migration_audit (
               kind TEXT NOT NULL, request_log_id INTEGER NOT NULL
           );
           CREATE TRIGGER audit_client_type_update
           AFTER UPDATE OF client_type ON request_logs
           BEGIN
               INSERT INTO request_log_migration_audit VALUES ('client_type', NEW.id);
           END;
           CREATE TRIGGER audit_reasoning_effort_update
           AFTER UPDATE OF response_reasoning_effort ON request_logs
           BEGIN
               INSERT INTO request_log_migration_audit VALUES ('response_reasoning_effort', NEW.id);
           END;"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO request_logs (
               id, method, path, client_type, response_reasoning_effort,
               downstream_request, upstream_response
           ) VALUES
               (1, 'POST', 'responses', 'unknown', NULL,
                   '{"headers":{"user-agent":"codex-cli"}}', '{"effort":"high"}'),
               (2, 'POST', 'responses', 'codex', 'high',
                   '{"headers":{"user-agent":"codex-cli"}}', '{"effort":"high"}'),
               (3, 'POST', 'responses', 'unknown', NULL,
                   '{"headers":{"user-agent":"generic-client"}}', '{"result":"ok"}')"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    init_db(&pool).await.unwrap();

    let updates: Vec<(String, i64)> = sqlx::query_as(
        "SELECT kind, request_log_id FROM request_log_migration_audit ORDER BY kind",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        updates,
        vec![
            ("client_type".into(), 1),
            ("response_reasoning_effort".into(), 1),
        ]
    );

    sqlx::query("DELETE FROM request_log_migration_audit")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"UPDATE request_logs
           SET client_type = 'unknown', response_reasoning_effort = NULL,
               downstream_request = '{"headers":{"user-agent":"codex-cli"}}',
               upstream_response = '{"effort":"high"}'
           WHERE id = 3"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM request_log_migration_audit")
        .execute(&pool)
        .await
        .unwrap();

    init_db(&pool).await.unwrap();

    let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_log_migration_audit")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(audit_count, 0);
    let unchanged: (String, Option<String>) = sqlx::query_as(
        "SELECT client_type, response_reasoning_effort FROM request_logs WHERE id = 3",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unchanged, ("unknown".into(), None));
}

#[tokio::test]
async fn payload_migration_keeps_legacy_columns_when_row_counts_do_not_match() {
    let pool = test_pool().await;
    init_db(&pool).await.unwrap();
    sqlx::query("DELETE FROM app_migrations WHERE name = ?")
        .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO request_logs (
               id, method, path, downstream_request, upstream_request
           ) VALUES (1, 'POST', 'responses', 'downstream', 'upstream')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"CREATE TRIGGER skip_payload_backfill
           BEFORE INSERT ON request_log_payloads
           BEGIN
               SELECT RAISE(IGNORE);
           END;"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let error = init_db(&pool).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("request log payload migration row-count mismatch"));
    let legacy: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT downstream_request, upstream_request FROM request_logs WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(legacy, (Some("downstream".into()), Some("upstream".into())));
    let migration_marked: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
            .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(migration_marked, 0);
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
