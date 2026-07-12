use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::models::token::{ApiTokenDetailOut, ApiTokenIn, ApiTokenOut, ApiTokenRow};

// ── Helpers ─────────────────────────────────────────────────────────────────

pub fn generate_api_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    format!("wildtoken_{encoded}")
}

pub fn token_preview(token: &str, len: usize) -> String {
    let end = len.min(token.len());
    format!("{}…", &token[..end])
}

// ── Public functions ────────────────────────────────────────────────────────

pub async fn list_tokens(pool: &SqlitePool) -> Result<Vec<ApiTokenOut>, AppError> {
    let rows: Vec<ApiTokenRow> = sqlx::query_as("SELECT * FROM api_tokens ORDER BY id ASC")
        .fetch_all(pool)
        .await?;

    rows.iter()
        .map(|r| {
            Ok(ApiTokenOut {
                id: r.id,
                name: r.name.clone(),
                description: r.description.clone(),
                token_preview: token_preview(&r.token, 12),
                enabled: r.enabled == 1,
                created_at: r.created_at.clone(),
                updated_at: r.updated_at.clone(),
            })
        })
        .collect()
}

pub async fn get_token(pool: &SqlitePool, id: i64) -> Result<Option<ApiTokenRow>, AppError> {
    let row = sqlx::query_as("SELECT * FROM api_tokens WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;

    Ok(row)
}

pub async fn get_token_by_value(
    pool: &SqlitePool,
    token: &str,
) -> Result<Option<ApiTokenRow>, AppError> {
    let row = sqlx::query_as("SELECT * FROM api_tokens WHERE token = ? AND enabled = 1")
        .bind(token)
        .fetch_optional(pool)
        .await?;

    Ok(row)
}

pub async fn create_token(
    pool: &SqlitePool,
    input: &ApiTokenIn,
) -> Result<ApiTokenDetailOut, AppError> {
    let token_value = input.token.clone().unwrap_or_else(generate_api_token);

    let result = sqlx::query(
        r#"INSERT INTO api_tokens (name, description, token, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))"#,
    )
    .bind(&input.name)
    .bind(&input.description)
    .bind(&token_value)
    .execute(pool)
    .await?;

    let last_id = result.last_insert_rowid();

    let row: ApiTokenRow = sqlx::query_as("SELECT * FROM api_tokens WHERE id = ?")
        .bind(last_id)
        .fetch_one(pool)
        .await?;

    Ok(ApiTokenDetailOut {
        id: row.id,
        name: row.name,
        description: row.description,
        token: row.token,
        enabled: row.enabled == 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn update_token(
    pool: &SqlitePool,
    id: i64,
    name: &str,
    description: &str,
) -> Result<ApiTokenOut, AppError> {
    sqlx::query(
        "UPDATE api_tokens SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(name)
    .bind(description)
    .bind(id)
    .execute(pool)
    .await?;

    let row: ApiTokenRow = sqlx::query_as("SELECT * FROM api_tokens WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;

    Ok(ApiTokenOut {
        id: row.id,
        name: row.name,
        description: row.description,
        token_preview: token_preview(&row.token, 12),
        enabled: row.enabled == 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn set_token_enabled(
    pool: &SqlitePool,
    id: i64,
    enabled: bool,
) -> Result<ApiTokenOut, AppError> {
    let val: i64 = if enabled { 1 } else { 0 };

    sqlx::query("UPDATE api_tokens SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(val)
        .bind(id)
        .execute(pool)
        .await?;

    let row: ApiTokenRow = sqlx::query_as("SELECT * FROM api_tokens WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;

    Ok(ApiTokenOut {
        id: row.id,
        name: row.name,
        description: row.description,
        token_preview: token_preview(&row.token, 12),
        enabled: row.enabled == 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn delete_token(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM api_tokens WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(result.rows_affected() > 0)
}
