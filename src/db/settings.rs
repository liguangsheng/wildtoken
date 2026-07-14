use sqlx::SqlitePool;

use crate::{
    error::AppError,
    models::settings::{
        AdminCredential, ModelTestPromptTemplate, ModelTestPromptTemplateIn, ModelTestTemplate,
        ModelTestTemplateIn, RuntimeSettings, RuntimeSettingsIn,
    },
};

pub async fn list_model_test_templates(
    pool: &SqlitePool,
) -> Result<Vec<ModelTestTemplate>, AppError> {
    Ok(sqlx::query_as::<_, ModelTestTemplate>(
        "SELECT id, name, request_kind, prompt, created_at, updated_at FROM model_test_templates ORDER BY id ASC",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn create_model_test_template(
    pool: &SqlitePool,
    input: &ModelTestTemplateIn,
) -> Result<ModelTestTemplate, AppError> {
    let result = sqlx::query(
        "INSERT INTO model_test_templates (name, request_kind, prompt, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
    )
    .bind(input.name.trim())
    .bind(&input.request_kind)
    .bind(&input.prompt)
    .execute(pool)
    .await?;
    Ok(sqlx::query_as::<_, ModelTestTemplate>(
        "SELECT id, name, request_kind, prompt, created_at, updated_at FROM model_test_templates WHERE id = ?",
    )
    .bind(result.last_insert_rowid())
    .fetch_one(pool)
    .await?)
}

pub async fn update_model_test_template(
    pool: &SqlitePool,
    id: i64,
    input: &ModelTestTemplateIn,
) -> Result<Option<ModelTestTemplate>, AppError> {
    let result = sqlx::query(
        "UPDATE model_test_templates SET name = ?, request_kind = ?, prompt = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(input.name.trim())
    .bind(&input.request_kind)
    .bind(&input.prompt)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }
    Ok(Some(
        sqlx::query_as::<_, ModelTestTemplate>(
            "SELECT id, name, request_kind, prompt, created_at, updated_at FROM model_test_templates WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await?,
    ))
}

pub async fn delete_model_test_template(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    Ok(sqlx::query("DELETE FROM model_test_templates WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}

pub async fn list_model_test_prompt_templates(
    pool: &SqlitePool,
) -> Result<Vec<ModelTestPromptTemplate>, AppError> {
    Ok(sqlx::query_as("SELECT id, name, prompt, created_at, updated_at FROM model_test_prompt_templates ORDER BY id ASC").fetch_all(pool).await?)
}

pub async fn create_model_test_prompt_template(
    pool: &SqlitePool,
    input: &ModelTestPromptTemplateIn,
) -> Result<ModelTestPromptTemplate, AppError> {
    let result = sqlx::query("INSERT INTO model_test_prompt_templates (name, prompt, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))").bind(input.name.trim()).bind(&input.prompt).execute(pool).await?;
    Ok(sqlx::query_as("SELECT id, name, prompt, created_at, updated_at FROM model_test_prompt_templates WHERE id = ?").bind(result.last_insert_rowid()).fetch_one(pool).await?)
}

pub async fn update_model_test_prompt_template(
    pool: &SqlitePool,
    id: i64,
    input: &ModelTestPromptTemplateIn,
) -> Result<Option<ModelTestPromptTemplate>, AppError> {
    if sqlx::query("UPDATE model_test_prompt_templates SET name = ?, prompt = ?, updated_at = datetime('now') WHERE id = ?").bind(input.name.trim()).bind(&input.prompt).bind(id).execute(pool).await?.rows_affected() == 0 { return Ok(None); }
    Ok(Some(sqlx::query_as("SELECT id, name, prompt, created_at, updated_at FROM model_test_prompt_templates WHERE id = ?").bind(id).fetch_one(pool).await?))
}

pub async fn delete_model_test_prompt_template(
    pool: &SqlitePool,
    id: i64,
) -> Result<bool, AppError> {
    Ok(
        sqlx::query("DELETE FROM model_test_prompt_templates WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected()
            == 1,
    )
}

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
        r#"SELECT log_body_keep_count, log_retention_days, log_body_max_bytes,
                  max_retries, same_upstream_retry_interval_ms,
                  auto_weight_failure_penalty, auto_weight_success_increment,
                  auto_weight_recovery_increment, auto_weight_recovery_interval_seconds,
                  revision, updated_at
           FROM runtime_settings WHERE id = 1"#,
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
        r#"UPDATE runtime_settings
           SET log_body_keep_count = ?, log_retention_days = ?, log_body_max_bytes = ?,
               max_retries = ?, same_upstream_retry_interval_ms = ?,
               auto_weight_failure_penalty = ?, auto_weight_success_increment = ?,
               auto_weight_recovery_increment = ?, auto_weight_recovery_interval_seconds = ?,
               revision = revision + 1, updated_at = datetime('now')
           WHERE id = 1 AND revision = ?"#,
    )
    .bind(input.log_body_keep_count)
    .bind(input.log_retention_days)
    .bind(input.log_body_max_bytes)
    .bind(input.max_retries)
    .bind(input.same_upstream_retry_interval_ms)
    .bind(input.auto_weight_failure_penalty)
    .bind(input.auto_weight_success_increment)
    .bind(input.auto_weight_recovery_increment)
    .bind(input.auto_weight_recovery_interval_seconds)
    .bind(input.revision)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "runtime settings revision conflict".into(),
        ));
    }
    let mut updated = sqlx::query_as::<_, RuntimeSettings>(
        r#"SELECT log_body_keep_count, log_retention_days, log_body_max_bytes,
                  max_retries, same_upstream_retry_interval_ms,
                  auto_weight_failure_penalty, auto_weight_success_increment,
                  auto_weight_recovery_increment, auto_weight_recovery_interval_seconds,
                  revision, updated_at
           FROM runtime_settings WHERE id = 1"#,
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
            max_retries: 2,
            same_upstream_retry_interval_ms: 2_500,
            auto_weight_failure_penalty: 25,
            auto_weight_success_increment: 8,
            auto_weight_recovery_increment: 12,
            auto_weight_recovery_interval_seconds: 90,
            revision: 1,
        };

        let updated = update_runtime_settings(&pool, &input).await.unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.max_retries, 2);
        assert_eq!(updated.same_upstream_retry_interval_ms, 2_500);
        assert_eq!(updated.auto_weight_failure_penalty, 25);
        assert_eq!(updated.auto_weight_success_increment, 8);
        assert_eq!(updated.auto_weight_recovery_increment, 12);
        assert_eq!(updated.auto_weight_recovery_interval_seconds, 90);
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
