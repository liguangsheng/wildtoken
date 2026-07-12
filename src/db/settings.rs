use sqlx::SqlitePool;

use crate::{
    error::AppError,
    models::settings::{AdminCredential, RuntimeSettings, RuntimeSettingsIn},
};

pub async fn load_admin_credential(pool: &SqlitePool) -> Result<Option<AdminCredential>, AppError> {
    Ok(sqlx::query_as::<_, AdminCredential>(
        "SELECT credential_hash, credential_version FROM admin_credential WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?)
}

/// Insert the bootstrap credential only when this database has never had one.
/// The caller must publish the returned snapshot only after this function succeeds.
pub async fn bootstrap_admin_credential(
    pool: &SqlitePool,
    bootstrap_hash: String,
) -> Result<AdminCredential, AppError> {
    if let Some(credential) = load_admin_credential(pool).await? {
        return Ok(credential);
    }

    sqlx::query(
        "INSERT INTO admin_credential (id, credential_hash, credential_version) VALUES (1, ?, 1) ON CONFLICT(id) DO NOTHING",
    )
    .bind(bootstrap_hash)
    .execute(pool)
    .await?;

    load_admin_credential(pool)
        .await?
        .ok_or_else(|| AppError::Internal("admin credential was not persisted".into()))
}

/// Atomically replace the sole credential if it is still at `expected_version`.
///
/// `None` is an expected compare-and-swap miss, not a database error. The
/// single UPDATE statement commits atomically and does not require holding an
/// application lock across an await.
pub async fn rotate_admin_credential(
    pool: &SqlitePool,
    replacement_hash: &str,
    expected_version: i64,
) -> Result<Option<AdminCredential>, AppError> {
    let credential = sqlx::query_as::<_, AdminCredential>(
        "UPDATE admin_credential SET credential_hash = ?, credential_version = credential_version + 1, rotated_at = datetime('now') WHERE id = 1 AND credential_version = ? RETURNING credential_hash, credential_version",
    )
    .bind(replacement_hash)
    .bind(expected_version)
    .fetch_optional(pool)
    .await?;
    Ok(credential)
}

pub async fn load_runtime_settings(pool: &SqlitePool) -> Result<Option<RuntimeSettings>, AppError> {
    Ok(sqlx::query_as::<_, RuntimeSettings>(
        "SELECT log_body_keep_count, log_retention_days, log_body_max_bytes, revision, updated_at FROM runtime_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?)
}

pub async fn update_runtime_settings(
    pool: &SqlitePool,
    input: &RuntimeSettingsIn,
) -> Result<RuntimeSettings, AppError> {
    let mut tx = pool.begin().await?;
    let result = sqlx::query(
        "UPDATE runtime_settings SET log_body_keep_count = ?, log_retention_days = ?, log_body_max_bytes = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = 1 AND revision = ?",
    )
    .bind(input.log_body_keep_count)
    .bind(input.log_retention_days)
    .bind(input.log_body_max_bytes)
    .bind(input.revision)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "runtime settings revision conflict".into(),
        ));
    }
    let mut updated = sqlx::query_as::<_, RuntimeSettings>(
        "SELECT log_body_keep_count, log_retention_days, log_body_max_bytes, revision, updated_at FROM runtime_settings WHERE id = 1",
    )
    .fetch_one(&mut *tx)
    .await?;
    updated.database_override = true;
    tx.commit().await?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;

    use crate::{
        models::settings::RuntimeSettingsIn,
        state::{hash_admin_token, init_db, verify_admin_token},
    };

    use super::{
        bootstrap_admin_credential, load_admin_credential, rotate_admin_credential,
        update_runtime_settings,
    };

    #[tokio::test]
    async fn update_uses_revision_compare_and_swap() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        init_db(&pool).await.unwrap();
        let input = RuntimeSettingsIn {
            log_body_keep_count: 99,
            log_retention_days: 30,
            log_body_max_bytes: 200_000,
            revision: 1,
        };

        let updated = update_runtime_settings(&pool, &input).await.unwrap();
        assert_eq!(updated.revision, 2);
        assert!(update_runtime_settings(&pool, &input).await.is_err());
    }

    #[tokio::test]
    async fn credential_bootstrap_preserves_existing_and_rotation_increments_version() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        init_db(&pool).await.unwrap();
        let first = bootstrap_admin_credential(&pool, "existing-hash".into())
            .await
            .unwrap();
        assert_eq!(first.credential_version, 1);
        let again = bootstrap_admin_credential(&pool, "replacement-bootstrap-hash".into())
            .await
            .unwrap();
        assert_eq!(again.credential_hash, "existing-hash");

        let rotated = rotate_admin_credential(&pool, "rotated-hash", 1)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rotated.credential_hash, "rotated-hash");
        assert_eq!(rotated.credential_version, 2);
        assert_eq!(
            load_admin_credential(&pool)
                .await
                .unwrap()
                .unwrap()
                .credential_version,
            2
        );
    }

    #[tokio::test]
    async fn concurrent_credential_rotations_with_the_same_version_only_allow_one_winner() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        init_db(&pool).await.unwrap();

        let old_token = "old-admin-token".to_owned();
        let first_new_token = "first-new-admin-token".to_owned();
        let second_new_token = "second-new-admin-token".to_owned();
        let old_hash = hash_admin_token(old_token.clone()).await.unwrap();
        bootstrap_admin_credential(&pool, old_hash).await.unwrap();
        let first_hash = hash_admin_token(first_new_token.clone()).await.unwrap();
        let second_hash = hash_admin_token(second_new_token.clone()).await.unwrap();

        let (first, second) = tokio::join!(
            rotate_admin_credential(&pool, &first_hash, 1),
            rotate_admin_credential(&pool, &second_hash, 1),
        );
        let first = first.unwrap();
        let second = second.unwrap();

        // A CAS miss returns no credential (and therefore cannot yield a token
        // to a handler); exactly one caller owns the committed replacement.
        assert!(first.is_some() ^ second.is_some());
        let winner_token = if first.is_some() {
            first_new_token
        } else {
            second_new_token
        };

        let persisted = load_admin_credential(&pool).await.unwrap().unwrap();
        assert_eq!(persisted.credential_version, 2);
        assert!(!verify_admin_token(persisted.clone(), old_token).await);
        assert!(verify_admin_token(persisted, winner_token).await);
    }
}
